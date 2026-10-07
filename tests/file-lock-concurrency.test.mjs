// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 R1, AC2: writers are serialised by the engine write lock, not by a
// caller-supplied expected version. Two processes of one device writing the same library at
// once both land in the device's stream, with consecutive sequences and nothing overwritten;
// the lock is this machine's lock of the library in the device directory (TCRN-CROSS-STORY-469
// R3); a lock left by a dead holder is broken; a live holder makes a waiter time out rather
// than write beside it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FILE_LOCK_SCHEMA_VERSION,
  acquireFileLock,
  lockPath as libraryLockPath,
  materializeWorkspace,
  validateWorkspace,
  withFileLock,
} from "../dist/build/packages/core/src/index.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { cli, cliProcess, deviceHome, instant, standInForAtelier, workspaceFixture } from "./helpers/workspace-fixture.mjs";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

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
  assert.deepEqual(Object.keys(after.library.versionVector).length, 1, "both processes are one device writing one stream");
  await assert.rejects(readFile(libraryLockPath(after.metadata.workspaceId, deviceHome)), { code: "ENOENT" }, "the lock is released");
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
  const setting = await cli(["settings-set", "--workspace", workspace, "--at", instant(7), "--key", "retrieval.tau", "--value", "2"]);
  assert.deepEqual(setting.ids, ["retrieval.tau"]);
  const batchFile = join(workspace, "..", "receipt-batch.json");
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
  const lockPath = libraryLockPath((await materializeWorkspace(workspace)).metadata.workspaceId, deviceHome);
  await mkdir(dirname(lockPath), { recursive: true });
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
    // Even the deprecated zero-age option cannot evict a living holder.
    await assert.rejects(acquireFileLock(lockPath, { timeoutMs: 30, staleMs: 0 }), (error) => error.reasonCode === "FILE_LOCK_TIMEOUT");
  } finally {
    await held.release();
  }
  const again = await acquireFileLock(lockPath, { timeoutMs: 150 });
  await again.release();
});

// An omitted deadline is not a hidden sixty-second product budget. The injected
// clock advances beyond the old boundary while real ownership stays unchanged.
test("an ordinary lock waiter survives the former deadline and resumes after release", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-lock-no-deadline-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "write.lock");
  const held = await acquireFileLock(path);
  const before = await readFile(path, "utf8");
  let ticks = 0;
  const waiting = acquireFileLock(path, { now: () => 1_800_000_000_000 + 61_000 * ticks++ });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await readFile(path, "utf8"), before, "the waiting writer has not replaced the owner");
  await held.release();
  const acquired = await waiting;
  assert.notEqual(acquired.token, held.token);
  await acquired.release();
});

test("cancelling a no-deadline waiter leaves the live holder and lock bytes intact", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-lock-cancel-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "write.lock");
  const held = await acquireFileLock(path);
  const before = await readFile(path, "utf8");
  const module = new URL("../dist/build/packages/core/src/file-lock.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireFileLock} from ${JSON.stringify(module)};process.stdout.write("waiting");await acquireFileLock(${JSON.stringify(path)});process.stdout.write("acquired");`], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  try {
    await once(child.stdout, "data");
    child.kill("SIGTERM");
    const [, signal] = await exit;
    assert.equal(signal, "SIGTERM");
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit; }
    await held.release();
  }
});

// R4 ownership recovery: deterministic mtime aging exercises the old eviction
// branches without waiting ten minutes or changing the actual execution budget.
async function isolatedLock(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-lock-integrity-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  return join(base, "write.lock");
}
const deadPid = 2_147_483_000;
const ownerText = (changes = {}) => JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION,
  pid: deadPid, token: "a".repeat(32), hostname: hostname(), createdAt: instant(0), ...changes }) + "\n";
async function ageLock(path) { const old = new Date(Date.now() - 601_000); await utimes(path, old, old); }

test("an aged live owner survives an ordinary waiter and retains safe release", async (context) => {
  const path = await isolatedLock(context), held = await acquireFileLock(path);
  await ageLock(path); const before = await readFile(path, "utf8");
  let acquired = false;
  const waiting = acquireFileLock(path).then(lock => { acquired = true; return lock; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(acquired, false); assert.equal(await readFile(path, "utf8"), before);
  await held.release(); const next = await waiting;
  assert.notEqual(next.token, held.token); await next.release();
});

test("an aged live breaker is not evicted; the caller budget applies during recovery", async (context) => {
  const path = await isolatedLock(context); await writeFile(path, ownerText());
  const breaker = await acquireFileLock(path + ".breaker"); await ageLock(breaker.path);
  const before = await readFile(breaker.path, "utf8");
  try {
    await assert.rejects(acquireFileLock(path, { timeoutMs: 30 }), { reasonCode: "FILE_LOCK_TIMEOUT" });
    assert.equal(await readFile(breaker.path, "utf8"), before);
    assert.equal(await readFile(path, "utf8"), ownerText());
  } finally { await breaker.release(); }
  const next = await acquireFileLock(path); await next.release();
});

test("dead breaker recovery serialises concurrent waiters including an abandoned recovery breaker", async (context) => {
  const path = await isolatedLock(context);
  for (const suffix of ["", ".breaker", ".breaker.breaker"]) await writeFile(path + suffix, ownerText());
  let active = 0, completed = 0;
  await Promise.all(Array.from({ length: 8 }, () => withFileLock(path, async () => {
    assert.equal(++active, 1, "only one writer may enter after nested crash recovery");
    await new Promise(resolve => setTimeout(resolve, 2)); active--; completed++;
  })));
  assert.equal(completed, 8);
  for (const suffix of ["", ".breaker", ".breaker.breaker", ".breaker.breaker.breaker"]) await assert.rejects(readFile(path + suffix), { code: "ENOENT" });
});

test("foreign, malformed, legacy breaker and unknown liveness never become age-based eviction authority", async (context) => {
  const path = await isolatedLock(context);
  const cases = [ownerText({ hostname: "another-device.invalid" }), "not json\n", ownerText({ pid: -1 }), ownerText({ token: "" }), ownerText({ createdAt: "invalid" })];
  for (const text of cases) {
    await writeFile(path, text); await ageLock(path);
    await assert.rejects(acquireFileLock(path, { timeoutMs: 0 }), { reasonCode: "FILE_LOCK_TIMEOUT" });
    assert.equal(await readFile(path, "utf8"), text);
  }
  const text = ownerText(); await writeFile(path, text); await ageLock(path);
  await assert.rejects(acquireFileLock(path, { timeoutMs: 0, processAlive() { throw Error("probe unavailable"); } }), { reasonCode: "FILE_LOCK_TIMEOUT" });
  assert.equal(await readFile(path, "utf8"), text);
  for (const breakerText of [String(deadPid) + "\n", "", ownerText({ hostname: "foreign.invalid" })]) {
    await writeFile(path + ".breaker", breakerText); await ageLock(path + ".breaker");
    await assert.rejects(acquireFileLock(path, { timeoutMs: 0 }), { reasonCode: "FILE_LOCK_TIMEOUT" });
    assert.equal(await readFile(path + ".breaker", "utf8"), breakerText);
    assert.equal(await readFile(path, "utf8"), text);
  }
});

test("recovery rechecks liveness under the breaker and release refuses a replaced token", async (context) => {
  const path = await isolatedLock(context); await writeFile(path, ownerText()); let probes = 0;
  await assert.rejects(acquireFileLock(path, { timeoutMs: 0, processAlive: () => ++probes > 1 }), { reasonCode: "FILE_LOCK_TIMEOUT" });
  assert.equal(await readFile(path, "utf8"), ownerText());
  assert.ok(probes >= 2);
  const held = await acquireFileLock(path); const replacement = ownerText({ pid: process.pid, token: "b".repeat(32) });
  await writeFile(path, replacement);
  await assert.rejects(held.release(), { reasonCode: "FILE_LOCK_LOST" });
  assert.equal(await readFile(path, "utf8"), replacement);
});

test("an interrupted real owner is reclaimed and an operation failure still releases ownership", async (context) => {
  const path = await isolatedLock(context);
  const module = new URL("../dist/build/packages/core/src/file-lock.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireFileLock} from ${JSON.stringify(module)};await acquireFileLock(${JSON.stringify(path)});process.stdout.write("held");setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  try { await once(child.stdout, "data"); child.kill("SIGTERM"); await exit; }
  finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit; } }
  const failure = Error("operation failed");
  await assert.rejects(withFileLock(path, async () => { throw failure; }), error => error === failure);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  const next = await acquireFileLock(path); await next.release();
});
