// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-538 GWT1, the deletes' part, GWT2 and GWT7 (MIN-256 D6 C2, C3; TCRN-CROSS-SUB-498):
// work-delete and project-delete hold the library write lock for their append alone. While another
// process holds the lock for 3 seconds, their reads, checks and lease judgements refuse at once, and
// a delete that passes them waits for the lock and lands once it is free, with the receipt it always
// had. The leases are judged again against the state the append is built on: a lease another process
// claims on the item, or on an item of the project, after the delete read it and before it appends
// refuses the append with WORK_LEASED, and nothing is deleted; a lease released in between is simply
// not removed a second time. Every library and device directory here is a temporary one.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { workLease } from "../dist/build/packages/core/src/work-lease.js";
import { cli, cliProcess, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const workspaceModule = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
const coreModule = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;

const HOLDER = "agent:lease-holder";
const CLAIMER = "agent:lease-claimer";
const DELETER = "agent:deleter";

// Resolves once `stream` has printed `line`; rejects when `exited` settles first.
function lineWaiter(stream, exited) {
  let text = "";
  const waiting = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    for (const entry of [...waiting]) {
      if (!text.includes(entry.line)) continue;
      waiting.splice(waiting.indexOf(entry), 1);
      entry.resolve();
    }
  });
  return (line) => Promise.race([
    text.includes(line) ? Promise.resolve() : new Promise((resolve) => { waiting.push({ line, resolve }); }),
    exited.then(() => { throw new Error(`the lock holder exited before it printed ${line}`); }),
  ]);
}

/**
 * Another process that takes the library's write lock, as a write verb does, and gives it back
 * `milliseconds` after it took it. Given `during` -- statements run with the core module as `core` --
 * it waits under the lock until write() is called, runs them there, as another writer whose turn came
 * first would, and only then lets the rest of the time run out.
 */
async function holdLibraryLock(context, workspace, milliseconds, during = null) {
  const script = `import { withWorkspaceWriteLock } from ${JSON.stringify(workspaceModule)};
import * as core from ${JSON.stringify(coreModule)};
import { once } from "node:events";
await withWorkspaceWriteLock(${JSON.stringify(workspace)}, async () => {
  const heldAt = Date.now();
  process.stdout.write("held\\n");
  ${during === null ? "" : `await once(process.stdin, "data");
  ${during}
  process.stdout.write("written\\n");`}
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${milliseconds} - (Date.now() - heldAt))));
}, { command: "einzbern work-annotate" });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: [during === null ? "ignore" : "pipe", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
    return Date.now();
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => undefined);
  });
  const printed = lineWaiter(child.stdout, exited);
  await printed("held");
  return {
    heldAt: Date.now(),
    released: exited,
    async write() {
      child.stdin.end("write\n");
      await printed("written");
    },
  };
}

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

function settle(promise) {
  const state = { done: false };
  return { state, promise: promise.then((value) => { state.done = true; return value; }, (error) => { state.done = true; throw error; }) };
}

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

async function createItem(workspace, projectId, key, second, parentId = null) {
  const created = await cli(["work-create", "--workspace", workspace, "--at", instant(second), "--project-id", projectId,
    "--external-key", key, "--kind", parentId === null ? "Initiative" : "Epic", ...(parentId === null ? [] : ["--parent-id", parentId]), "--title", key]);
  return created.record.id;
}

const claim = (workspace, id, actor, second) => cli(["work-claim", "--workspace", workspace, "--at", instant(second), "--id", id, "--actor", actor, "--ttl", "2h"]);

test("538 GWT1: while another process holds the library write lock, work-delete and project-delete check, and judge leases, without waiting for it", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "DELETE-LOCK-CHECKS" });
  const parent = await createItem(workspace, projectId, "DELETE-LOCK-PARENT", 1);
  await createItem(workspace, projectId, "DELETE-LOCK-CHILD", 2, parent);
  const leased = await createItem(workspace, projectId, "DELETE-LOCK-LEASED", 3);
  await claim(workspace, leased, HOLDER, 4);
  const empty = (await cli(["project-create", "--workspace", workspace, "--at", instant(5), "--external-key", "DELETE-LOCK-EMPTY", "--name", "Empty"])).record.id;
  const busy = (await cli(["project-create", "--workspace", workspace, "--at", instant(5), "--external-key", "DELETE-LOCK-BUSY", "--name", "Busy"])).record.id;
  await createItem(workspace, busy, "DELETE-LOCK-BUSY-ITEM", 6);
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000);

  const del = (verb, id) => timed(() => refusal(() => cli([verb, "--workspace", workspace, "--at", instant(10), "--id", id, "--actor", DELETER])));
  const refusals = [
    ["work-delete of an item that is not there", "WORKSPACE_INPUT_INVALID", await del("work-delete", "work:000000000000000000000000")],
    ["work-delete of an item with a live child", "TOMBSTONE_REFERENCED", await del("work-delete", parent)],
    ["project-delete of a project whose item is leased", "WORK_LEASED", await del("project-delete", projectId)],
    ["project-delete of a project that owns live work", "WORKSPACE_INPUT_INVALID", await del("project-delete", busy)],
  ];
  assert.ok(Date.now() - holder.heldAt < 3000, "every refusal came while the lock was held");
  for (const [name, reasonCode, run] of refusals) {
    assert.equal(run.result.reasonCode, reasonCode, `${name}: ${run.result.message}`);
    assert.ok(run.elapsed < 1000, `${name} refused in ${run.elapsed} ms`);
  }
  assert.deepEqual([refusals[2][2].result.details.workId, refusals[2][2].result.details.holder], [leased, HOLDER], "the held lease is named");

  // Deletes that pass their checks wait for the lock, then land.
  const deleteWork = settle(cliProcess(["work-delete", "--workspace", workspace, "--at", instant(11), "--id", leased, "--actor", DELETER]));
  const deleteProject = settle(cliProcess(["project-delete", "--workspace", workspace, "--at", instant(12), "--id", empty, "--actor", DELETER]));
  await pause(700);
  assert.deepEqual([deleteWork.state.done, deleteProject.state.done], [false, false], "the deletes wait while the lock is held");
  await holder.released;
  const receipts = [];
  for (const run of [await deleteWork.promise, await deleteProject.promise]) {
    assert.equal(run.status, 0, run.stderr);
    receipts.push(JSON.parse(run.stdout));
  }
  const [workReceipt, projectReceipt] = receipts;
  assert.deepEqual([workReceipt.reasonCode, workReceipt.record.id, workReceipt.ids.length, workReceipt.ids.at(-1)], ["WORKSPACE_COMMAND_COMPLETED", leased, 2, leased],
    "work-delete names the lease it removed and the item, in that order");
  assert.deepEqual([projectReceipt.reasonCode, projectReceipt.record.id, projectReceipt.ids], ["WORKSPACE_COMMAND_COMPLETED", empty, [empty]]);
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 3, "the lease's removal, work.deleted and project.deleted");
  assert.equal(after.work.find((record) => record.id === leased).tombstone, true);
  assert.equal(after.projects.find((record) => record.id === empty).tombstone, true);
  assert.equal(workLease(after, leased), null, "the lease went with its item");
});

test("538 GWT2: a lease another process claims on the item after work-delete read it refuses the append with WORK_LEASED, and the item is not deleted", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "DELETE-LOCK-CLAIMED" });
  const item = await createItem(workspace, projectId, "DELETE-LOCK-CLAIMED-ITEM", 1);
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000,
    `await core.claimWork(${JSON.stringify(workspace)}, { id: ${JSON.stringify(item)}, actorId: ${JSON.stringify(CLAIMER)}, occurredAt: ${JSON.stringify(instant(9))} });`);
  const deleting = settle(cli(["work-delete", "--workspace", workspace, "--at", instant(10), "--id", item, "--actor", DELETER]).then(() => null, (error) => error));
  await pause(1000);
  assert.equal(deleting.state.done, false, "the delete read the item, with no lease, and waits for the lock to append");
  await holder.write();
  await pause(300);
  assert.equal(deleting.state.done, false, "it passed its checks before the claim landed, so it still waits");
  const releasedAt = await holder.released;
  const refused = await deleting.promise;
  assert.ok(Date.now() >= releasedAt, "the refusal came at the append, once the lock was free");
  assert.equal(refused?.reasonCode, "WORK_LEASED", refused?.message);
  const expiresAt = new Date(Date.parse(instant(9)) + 2 * 3600_000).toISOString().replace(".000Z", "Z");
  assert.deepEqual(refused.details, { workId: item, holder: CLAIMER, expiresAt, leasedWorkId: item }, "the details a claim's refusal has");
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 1, "only the claim was appended");
  assert.equal(after.work.find((record) => record.id === item).tombstone, false, "the item is not deleted");
  assert.equal(workLease(after, item).holder, CLAIMER, "the lease stays");
});

test("538 GWT2: a lease released after work-delete read it is not removed a second time; the item is deleted in one event", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "DELETE-LOCK-RELEASED" });
  const item = await createItem(workspace, projectId, "DELETE-LOCK-RELEASED-ITEM", 1);
  await claim(workspace, item, HOLDER, 2);
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000,
    `await core.releaseWork(${JSON.stringify(workspace)}, { id: ${JSON.stringify(item)}, actorId: ${JSON.stringify(HOLDER)}, occurredAt: ${JSON.stringify(instant(9))} });`);
  const deleting = settle(cli(["work-delete", "--workspace", workspace, "--at", instant(10), "--id", item, "--actor", DELETER]));
  await pause(1000);
  assert.equal(deleting.state.done, false, "the delete read the item and its lease, and waits for the lock to append");
  await holder.write();
  await holder.released;
  const receipt = await deleting.promise;
  assert.deepEqual([receipt.record.id, receipt.ids], [item, [item]], "the delete wrote work.deleted alone");
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 2, "the release, then work.deleted");
  assert.deepEqual(after.events.slice(-2).map((event) => [event.payload.operation, event.payload.record.collection ?? event.payload.record.id]), [
    ["config.record.removed", "lease"], ["work.deleted", item],
  ]);
  assert.equal(after.work.find((record) => record.id === item).tombstone, true);
});

test("538 GWT2: a lease another process claims on an item of the project after project-delete read it refuses the append with WORK_LEASED, and the project stays", async (context) => {
  const { workspace } = await workspaceFixture(context, { externalKey: "DELETE-LOCK-PROJECT" });
  const target = (await cli(["project-create", "--workspace", workspace, "--at", instant(1), "--external-key", "DELETE-LOCK-TARGET", "--name", "Target"])).record.id;
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000, `const created = await core.createWork(${JSON.stringify(workspace)}, { projectId: ${JSON.stringify(target)},
    externalKey: "DELETE-LOCK-LATE-ITEM", kind: "Initiative", parentId: null, title: "Created and claimed in between", occurredAt: ${JSON.stringify(instant(8))} });
  const item = created.work.find((record) => record.projectId === ${JSON.stringify(target)} && !record.tombstone);
  await core.claimWork(${JSON.stringify(workspace)}, { id: item.id, actorId: ${JSON.stringify(CLAIMER)}, occurredAt: ${JSON.stringify(instant(9))} });`);
  const deleting = settle(cli(["project-delete", "--workspace", workspace, "--at", instant(10), "--id", target, "--actor", DELETER]).then(() => null, (error) => error));
  await pause(1000);
  assert.equal(deleting.state.done, false, "the delete read the project, which owned nothing, and waits for the lock to append");
  await holder.write();
  await pause(300);
  assert.equal(deleting.state.done, false, "it passed its checks before the claim landed, so it still waits");
  await holder.released;
  const refused = await deleting.promise;
  assert.equal(refused?.reasonCode, "WORK_LEASED", refused?.message);
  assert.deepEqual([refused.details.projectId, refused.details.holder], [target, CLAIMER]);
  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version + 2, "only the other process's item and claim were appended");
  assert.equal(after.projects.find((record) => record.id === target).tombstone, false, "the project is not deleted");
});
