// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 R1, AC2: writers are serialised by the engine write lock, not by a
// caller-supplied expected version. Two processes writing the same workspace at once both
// land, with consecutive sequences and nothing overwritten; a lock left by a dead holder is
// broken; a live holder makes a waiter time out rather than write beside it.

import assert from "node:assert/strict";
import { hostname } from "node:os";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FILE_LOCK_SCHEMA_VERSION,
  LEGACY_CONTROL_DIRECTORY,
  WORKSPACE_WRITE_LOCK_FILE,
  acquireFileLock,
  materializeWorkspace,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { cli, cliProcess, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const PER_WRITER = 5;

async function writer(workspace, projectId, name) {
  const receipts = [];
  for (let index = 0; index < PER_WRITER; index += 1) {
    const run = await cliProcess([
      "work-create", "--workspace", workspace, "--at", instant(10 + index),
      "--project-id", projectId, "--external-key", `CONCURRENT-${name}-${index}`, "--kind", "Initiative", "--title", `${name} ${index}`,
    ]);
    assert.equal(run.status, 0, run.stderr);
    receipts.push(JSON.parse(run.stdout));
  }
  return receipts;
}

test("467-AC2: two processes creating work at once both land, in order, with nothing overwritten", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "CONCURRENCY" });
  const before = await materializeWorkspace(workspace);
  const [left, right] = await Promise.all([writer(workspace, projectId, "LEFT"), writer(workspace, projectId, "RIGHT")]);
  const after = await validateWorkspace(workspace);
  assert.equal(after.version, before.version + 2 * PER_WRITER, "every write landed");
  assert.deepEqual(after.events.map((event) => event.sequence), Array.from({ length: after.version }, (_, index) => index + 1), "sequences are consecutive");
  for (const receipt of [...left, ...right]) {
    const record = after.work.find((entry) => entry.id === receipt.record.id);
    assert.ok(record, `${receipt.record.externalKey} is in the replayed state`);
    assert.deepEqual(receipt.ids, [receipt.record.id], "the receipt echoes the id it wrote");
  }
  const versions = [...left, ...right].map((receipt) => receipt.version).sort((a, b) => a - b);
  assert.deepEqual(versions, Array.from({ length: 2 * PER_WRITER }, (_, index) => before.version + index + 1), "each write got its own version");
  await assert.rejects(readFile(join(workspace, LEGACY_CONTROL_DIRECTORY, WORKSPACE_WRITE_LOCK_FILE)), { code: "ENOENT" }, "the lock is released");
});

test("467-R1: a write receipt carries the written ids, the new version and head, and the catalog has no CAS flag", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "RECEIPT" });
  const created = await cli(["work-create", "--workspace", workspace, "--at", instant(5), "--project-id", projectId, "--external-key", "RECEIPT-INITIATIVE", "--kind", "Initiative", "--title", "Receipt"]);
  const state = await materializeWorkspace(workspace);
  assert.deepEqual(created.ids, [created.record.id]);
  assert.equal(created.version, state.version);
  assert.equal(created.headEventHash, state.headEventHash);
  // The other workspace writers echo the same three fields: a transition names the record
  // it moved, a setting names its key, and a batch names every record it wrote.
  const transitioned = await cli(["work-transition", "--workspace", workspace, "--at", instant(6), "--id", created.record.id, "--status", "ready"]);
  assert.deepEqual(transitioned.ids, [created.record.id]);
  const setting = await cli(["settings-set", "--workspace", workspace, "--at", instant(7), "--key", "execution.dispatchMode", "--value", "eco"]);
  assert.deepEqual(setting.ids, ["execution.dispatchMode"]);
  const batchFile = join(workspace, "..", "transient", "receipt-batch.json");
  await writeFile(batchFile, JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: ["A", "B"].map((suffix) => ({
    verb: "work-create", projectId, externalKey: `RECEIPT-BATCH-${suffix}`, kind: "Initiative", parentId: null, status: "planned", title: `Batch ${suffix}`,
  })) }));
  const batch = await cli(["work-batch", "--workspace", workspace, "--at", instant(8), "--from-file", batchFile]);
  const afterBatch = await materializeWorkspace(workspace);
  assert.deepEqual([...batch.ids].sort(), afterBatch.work.filter((entry) => entry.externalKey.startsWith("RECEIPT-BATCH-")).map((entry) => entry.id).sort());
  assert.deepEqual([transitioned.version, setting.version, batch.version], [state.version + 1, state.version + 2, state.version + 4]);
  assert.equal(batch.headEventHash, afterBatch.headEventHash);
  const status = await cli(["status", "--workspace", workspace]);
  assert.equal(status.ids, undefined, "a read carries no ids");
  for (const entry of COMMAND_CATALOG) {
    for (const flag of entry.flags) {
      assert.notEqual(flag.name, "expected-version", `${entry.name} takes no expected version`);
      assert.equal(Object.hasOwn(flag, "headSentinel"), false, `${entry.name} carries no head sentinel`);
    }
    assert.equal(entry.name.startsWith("lease-"), false, `${entry.name} is not a lease verb`);
  }
});

test("a lock left by a dead holder on this host is broken and the write proceeds", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "STALE" });
  const lockPath = join(workspace, LEGACY_CONTROL_DIRECTORY, WORKSPACE_WRITE_LOCK_FILE);
  // A pid this far above any live process on the test host belongs to nobody.
  await writeFile(lockPath, `${JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: 2_147_483_000, token: "0".repeat(32), hostname: hostname(), createdAt: instant(0) })}\n`);
  const run = await cliProcess(["work-create", "--workspace", workspace, "--at", instant(6), "--project-id", projectId, "--external-key", "STALE-INITIATIVE", "--kind", "Initiative", "--title", "After a dead holder"]);
  assert.equal(run.status, 0, run.stderr);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("a live holder makes a waiter time out instead of writing beside it", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-lock-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const lockPath = join(base, "write.lock");
  const held = await acquireFileLock(lockPath);
  try {
    await assert.rejects(acquireFileLock(lockPath, { timeoutMs: 150 }), (error) => error.reasonCode === "FILE_LOCK_TIMEOUT");
    // A lock older than the stale bound is broken whatever its holder.
    const late = await acquireFileLock(lockPath, { timeoutMs: 2_000, staleMs: 0 });
    await late.release();
  } finally {
    await held.release().catch((error) => assert.equal(error.reasonCode, "FILE_LOCK_LOST", "the broken holder learns it lost the lock"));
  }
  const again = await acquireFileLock(lockPath, { timeoutMs: 150 });
  await again.release();
});
