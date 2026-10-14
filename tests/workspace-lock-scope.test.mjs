// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-529 GWT1 (TCRN-CROSS-SUB-481): the library write lock covers a write's append
// alone. While another process holds it, status, work-show and recall answer at once and correctly; a
// write waits for it, lands once it is free, and its receipt names exactly the records it wrote; and a
// write's checks before a Story's done judgement -- a work lease, first of all (Q21) -- run outside it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { cli, cliProcess, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const coreModule = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;

// Another process that takes the library's write lock, as a write verb does, and gives it back after
// `milliseconds`.
async function holdLibraryLock(context, workspace, milliseconds) {
  const script = `import { withWorkspaceWriteLock } from ${JSON.stringify(coreModule)};
await withWorkspaceWriteLock(${JSON.stringify(workspace)}, async () => {
  process.stdout.write("held\\n");
  await new Promise((resolve) => setTimeout(resolve, ${milliseconds}));
}, { command: "einzbern work-annotate" });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => undefined);
  });
  await once(child.stdout, "data");
  return { heldAt: Date.now(), released: exited };
}

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

function settle(promise) {
  const state = { done: false };
  return { state, promise: promise.then((value) => { state.done = true; return value; }) };
}

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

test("529 GWT1: while another process holds the library write lock for 3 seconds, status, work-show and recall answer within a second, correctly", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "LOCK-SCOPE-READS" });
  const created = await cli(["work-create", "--workspace", workspace, "--at", instant(1), "--project-id", projectId,
    "--external-key", "LOCK-SCOPE-ITEM", "--kind", "Initiative", "--title", "Readable while a writer holds the lock"]);
  await cli(["knowledge-init", "--workspace", workspace, "--acknowledge-disposable", "true"]);
  await cli(["knowledge-capture", "--workspace", workspace, "--at", instant(2), "--subject", "Wombat burrow lock scope",
    "--summary", "Reads never wait for the library write lock.", "--snippet", "Wombat burrows stay readable.",
    "--tags", "lock,wombat", "--accountable-owner-id", "owner:agent-session", "--body", "A wombat burrow is read while a writer holds the lock."]);
  const expected = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000);

  const status = await timed(() => cli(["status", "--workspace", workspace]));
  const shown = await timed(() => cli(["work-show", "--workspace", workspace, "--id", created.record.id]));
  const recalled = await timed(() => cli(["recall", "--workspace", workspace, "--at", instant(3), "--query", "wombat burrow"]));
  assert.ok(Date.now() - holder.heldAt < 3000, "the reads ran while the lock was held");
  for (const [name, read] of [["status", status], ["work-show", shown], ["recall", recalled]]) {
    assert.ok(read.elapsed < 1000, `${name} answered in ${read.elapsed} ms`);
  }
  assert.equal(status.result.version, expected.version, "status reads the latest version");
  assert.equal(shown.result.record.id, created.record.id);
  assert.equal(shown.result.record.title, "Readable while a writer holds the lock");
  assert.match(JSON.stringify(recalled.result), /Wombat burrow lock scope/u, "recall finds the card");
  await holder.released;
});

test("529 GWT1: a write waits while another process holds the lock, then lands, and its receipt names only what it wrote", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "LOCK-SCOPE-WRITE" });
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 1500);
  const write = (key, second) => cliProcess(["work-create", "--workspace", workspace, "--at", instant(second), "--project-id", projectId,
    "--external-key", key, "--kind", "Initiative", "--title", key]);
  const left = settle(write("WAITING-LEFT", 4));
  const right = settle(write("WAITING-RIGHT", 5));
  await pause(700);
  assert.equal(left.state.done || right.state.done, false, "the writes wait while the lock is held");
  await holder.released;
  const receipts = [];
  for (const run of [await left.promise, await right.promise]) {
    assert.equal(run.status, 0, run.stderr);
    receipts.push(JSON.parse(run.stdout));
  }
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 2, "both writes landed once the lock was free");
  for (const receipt of receipts) {
    assert.ok(after.work.some((record) => record.id === receipt.record.id), receipt.record.externalKey);
    assert.deepEqual(receipt.ids, [receipt.record.id], "the receipt names the record this write wrote, not the other's");
  }
  assert.deepEqual(receipts.map((receipt) => receipt.version).sort((a, b) => a - b), [before.version + 1, before.version + 2]);
});

test("529 GWT1, Q21: a done transition's lease check runs outside the lock and refuses without waiting for the holder", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "LOCK-SCOPE-DONE" });
  const created = await cli(["work-create", "--workspace", workspace, "--at", instant(1), "--project-id", projectId,
    "--external-key", "LOCK-SCOPE-LEASED", "--kind", "Initiative", "--title", "Leased while a writer holds the lock"]);
  await cli(["work-claim", "--workspace", workspace, "--at", instant(2), "--id", created.record.id, "--actor", "agent:lock-left", "--ttl", "2h"]);
  for (const status of ["ready", "active"]) {
    await cli(["work-transition", "--workspace", workspace, "--at", instant(2), "--id", created.record.id, "--status", status, "--actor", "agent:lock-left"]);
  }
  const holder = await holdLibraryLock(context, workspace, 3000);
  const refused = await timed(() => cli(["work-transition", "--workspace", workspace, "--at", instant(3), "--id", created.record.id,
    "--status", "done", "--actor", "agent:lock-right"]).then(() => null, (error) => error));
  assert.ok(Date.now() - holder.heldAt < 3000, "the refusal came while the lock was held");
  assert.ok(refused.elapsed < 1000, `refused in ${refused.elapsed} ms`);
  assert.equal(refused.result?.reasonCode, "WORK_LEASED", "the lease is judged before anything waits for the lock");
  await holder.released;
  // The holder of the lease takes the item to done once the lock is free; the append checks the lease again.
  const done = await cli(["work-transition", "--workspace", workspace, "--at", instant(4), "--id", created.record.id, "--status", "done", "--actor", "agent:lock-left"]);
  assert.equal(done.record.status, "done");
  assert.deepEqual(done.ids, [created.record.id]);
});
