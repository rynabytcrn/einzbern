// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-535 (MIN-257 D6): a lease does not outlive its work item. SUB-475 GWT1: work-delete,
// by any actor and whether the lease still runs, removes the item's lease in the same append, just
// before the work.deleted event; an item without a lease is deleted in one event, as before.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { deleteWork, materializeWorkspace, materializeWorkspaceFromGenesis } from "../dist/build/packages/core/src/index.js";
import { claimWork, workLease } from "../dist/build/packages/core/src/work-lease.js";
import { A, B, at, leaseLibrary as library, leaseRecords } from "./helpers/work-lease-fixture.mjs";

async function run(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** What `operation` appended to the library at `root`: the payloads of its events, in order. */
async function appended(root, operation) {
  const before = await materializeWorkspace(root);
  const result = await operation();
  const after = await materializeWorkspace(root);
  return { result, payloads: after.events.slice(before.events.length).map((event) => event.payload) };
}

/** The operation and the record id (or lease key) of each payload. */
const shape = (payloads) => payloads.map((payload) => [payload.operation, payload.record.collection === "lease" ? `lease ${payload.record.key}` : payload.record.id]);

test("535 SUB-475 GWT1: work-delete removes the item's lease just before work.deleted, whoever deletes and whether the lease runs", async (context) => {
  const f = await library(context, "LEASE-DELETE");
  await claimWork(f.root, { id: f.ids.subtask, actorId: A, occurredAt: at(0) });
  await claimWork(f.root, { id: f.ids.sibling, actorId: B, occurredAt: at(0) });

  // Another actor deletes while A's lease runs.
  const byOther = await appended(f.root, () => deleteWork(f.root, { id: f.ids.subtask, actorId: B, occurredAt: at(1) }));
  assert.deepEqual(shape(byOther.payloads), [["config.record.removed", `lease ${f.ids.subtask}`], ["work.deleted", f.ids.subtask]]);
  assert.deepEqual(byOther.payloads[0].record, { collection: "lease", key: f.ids.subtask, projectId: f.projectId }, "the lease is removed in the scope it was recorded in");
  assert.equal(byOther.payloads[1].record.tombstone, true);
  assert.equal(workLease(byOther.result, f.ids.subtask), null, "the receipt's state holds no lease on the deleted item");
  assert.deepEqual(leaseRecords(byOther.result).map((record) => record.key), [f.ids.sibling], "the other leases stay");

  // The holder deletes its own leased item.
  const byHolder = await appended(f.root, () => deleteWork(f.root, { id: f.ids.sibling, actorId: B, occurredAt: at(2) }));
  assert.deepEqual(shape(byHolder.payloads), [["config.record.removed", `lease ${f.ids.sibling}`], ["work.deleted", f.ids.sibling]]);

  // A delete that names no actor, through the CLI.
  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(3) });
  const byCli = await appended(f.root, () => run(["work-delete", "--workspace", f.root, "--at", at(4), "--id", f.ids.story]));
  assert.equal(byCli.result.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(byCli.result.record.id, f.ids.story);
  assert.deepEqual(byCli.result.ids, [`lease:${f.projectId}:${f.ids.story}`, f.ids.story], "the receipt names both records the delete wrote");
  assert.deepEqual(shape(byCli.payloads), [["config.record.removed", `lease ${f.ids.story}`], ["work.deleted", f.ids.story]]);

  // An item without a lease is deleted in one event.
  const unleased = await appended(f.root, () => deleteWork(f.root, { id: f.ids.epic, occurredAt: at(5) }));
  assert.deepEqual(shape(unleased.payloads), [["work.deleted", f.ids.epic]], "no lease, one event");

  // A lease that has run out goes with its item all the same.
  await claimWork(f.root, { id: f.ids.initiative, actorId: A, ttl: "1m", occurredAt: at(6) });
  const expired = await appended(f.root, () => deleteWork(f.root, { id: f.ids.initiative, actorId: B, occurredAt: at(10) }));
  assert.deepEqual(shape(expired.payloads), [["config.record.removed", `lease ${f.ids.initiative}`], ["work.deleted", f.ids.initiative]]);

  const live = await materializeWorkspace(f.root);
  assert.deepEqual(leaseRecords(live), [], "no lease outlives its item");
  assert.ok(live.work.every((record) => record.tombstone));
  assert.deepEqual(await materializeWorkspaceFromGenesis(f.root), live, "the genesis replay matches the live materialization");
});

test("535 SUB-475 GWT1: a refused delete removes no lease and writes nothing", async (context) => {
  const f = await library(context, "LEASE-DELETE-REFUSED");
  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(0) });
  const before = await materializeWorkspace(f.root);
  // The Story still has a live Subtask under it, so it cannot be deleted.
  await assert.rejects(() => deleteWork(f.root, { id: f.ids.story, actorId: B, occurredAt: at(1) }));
  await assert.rejects(() => deleteWork(f.root, { id: f.ids.story, actorId: A, occurredAt: "not an instant" }));
  const after = await materializeWorkspace(f.root);
  assert.equal(after.version, before.version, "a refused delete writes nothing");
  assert.equal(after.headEventHash, before.headEventHash);
  assert.deepEqual(workLease(after, f.ids.story), { workId: f.ids.story, holder: A, claimedAt: at(0), expiresAt: at(120) }, "the lease stays");
});
