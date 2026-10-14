// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-535 (MIN-257 D6): a lease does not outlive its work item. SUB-475 GWT1: work-delete,
// by any actor and whether the lease still runs, removes the item's lease in the same append, just
// before the work.deleted event; an item without a lease is deleted in one event, as before.
// SUB-476 GWT2: project-delete is not held up by a lease that has run out or whose item is gone; the
// same append removes such leases before project.deleted. GWT3: a lease that runs on a live item
// refuses project-delete with WORK_LEASED naming the item, the holder and expiresAt, whoever asks,
// and the library is left as it was.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  createProject,
  createWork,
  deleteProject,
  deleteWork,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
} from "../dist/build/packages/core/src/index.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { claimWork, projectLeases, releaseWork, workLease } from "../dist/build/packages/core/src/work-lease.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { forgeOwnStream } from "./helpers/library-forge.mjs";
import { A, B, at, leaseLibrary as library, leaseRecords } from "./helpers/work-lease-fixture.mjs";

async function run(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(argv) {
  try {
    await run(argv);
  } catch (error) {
    return error;
  }
  throw new Error(`${argv.join(" ")} was expected to be refused`);
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

/** The leases of `projectId` as they stand at `instant`, by item. */
const standings = (state, projectId, instant) => Object.fromEntries(projectLeases(state, projectId, instant).map((lease) => [lease.workId, [lease.holder, lease.standing]]));

/** Assert that `operation` is refused with WORK_LEASED naming A's lease on the Subtask of `f`. */
async function refusedAsHeld(operation, f) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.reasonCode, "WORK_LEASED", error.message);
    assert.deepEqual(
      { workId: error.details.workId, holder: error.details.holder, expiresAt: error.details.expiresAt, leasedWorkId: error.details.leasedWorkId, projectId: error.details.projectId },
      { workId: f.ids.subtask, holder: A, expiresAt: at(120), leasedWorkId: f.ids.subtask, projectId: f.projectId },
    );
    return true;
  });
}

test("535 SUB-476 GWT2: leases that have run out or whose item is gone do not hold up project-delete; the same append removes them first", async (context) => {
  const f = await library(context, "LEASE-PROJECT-STALE");
  await claimWork(f.root, { id: f.ids.subtask, actorId: A, occurredAt: at(0) });
  await claimWork(f.root, { id: f.ids.sibling, actorId: B, ttl: "1m", occurredAt: at(0) });
  for (const [index, name] of ["subtask", "story", "sibling", "epic", "initiative"].entries()) {
    await deleteWork(f.root, { id: f.ids[name], occurredAt: at(2 + index) });
  }
  // The history an engine before SUB-475 wrote: the same deletes, the leases left behind.
  await forgeOwnStream(f.root, (events) => events
    .filter((event) => !(event.payload.operation === "config.record.removed" && event.payload.record.collection === "lease"))
    .map((event) => ({ occurredAt: event.occurredAt, payload: event.payload, clock: event.clock })));
  // A lease on an item the library never held, and another project's lease, which stays.
  const ghost = deriveStableId("work", "LEASE-PROJECT-GHOST");
  await setConfigRecord(f.root, { collection: "lease", key: ghost, projectId: f.projectId, value: { holder: B, claimedAt: at(7), expiresAt: at(127) }, occurredAt: at(7) });
  const other = await createProject(f.root, { occurredAt: at(8), externalKey: "LEASE-PROJECT-OTHER-P", name: "Other" });
  const otherProjectId = other.projects.find((record) => record.externalKey === "LEASE-PROJECT-OTHER-P").id;
  const otherWork = await createWork(f.root, { occurredAt: at(8), projectId: otherProjectId, externalKey: "LEASE-PROJECT-OTHER-INIT", kind: "Initiative", parentId: null });
  const otherId = otherWork.work.find((record) => record.externalKey === "LEASE-PROJECT-OTHER-INIT").id;
  await claimWork(f.root, { id: otherId, actorId: A, occurredAt: at(9) });

  const before = await materializeWorkspace(f.root);
  assert.deepEqual(standings(before, f.projectId, at(10)), {
    [f.ids.subtask]: [A, "orphaned"],
    [f.ids.sibling]: [B, "orphaned"],
    [ghost]: [B, "orphaned"],
  }, "a lease on a deleted or absent item is orphaned, run out or not");

  const deleted = await appended(f.root, () => deleteProject(f.root, { id: f.projectId, actorId: B, occurredAt: at(10) }));
  const removed = deleted.payloads.slice(0, -1);
  assert.deepEqual(removed.map((payload) => payload.operation), ["config.record.removed", "config.record.removed", "config.record.removed"]);
  assert.deepEqual(removed.map((payload) => payload.record.key).sort(), [f.ids.subtask, f.ids.sibling, ghost].sort());
  assert.ok(removed.every((payload) => payload.record.collection === "lease" && payload.record.projectId === f.projectId));
  assert.deepEqual(shape(deleted.payloads.slice(-1)), [["project.deleted", f.projectId]], "the project is deleted after its leases are removed");
  assert.equal(deleted.result.projects.find((record) => record.id === f.projectId).tombstone, true);

  const live = await materializeWorkspace(f.root);
  assert.deepEqual(leaseRecords(live).map((record) => [record.key, record.projectId]), [[otherId, otherProjectId]], "only the other project's lease is left");
  assert.deepEqual(await materializeWorkspaceFromGenesis(f.root), live, "the genesis replay matches the live materialization");
});

test("535 SUB-476 GWT3: a lease that runs on a live item refuses project-delete with WORK_LEASED, whoever asks, and the library is left as it was", async (context) => {
  const f = await library(context, "LEASE-PROJECT-HELD");
  await claimWork(f.root, { id: f.ids.subtask, actorId: A, occurredAt: at(0) });
  await claimWork(f.root, { id: f.ids.sibling, actorId: B, ttl: "1m", occurredAt: at(0) });
  const before = await materializeWorkspace(f.root);
  assert.deepEqual(standings(before, f.projectId, at(5)), {
    [f.ids.subtask]: [A, "held"],
    [f.ids.sibling]: [B, "expired"],
  });

  await refusedAsHeld(() => deleteProject(f.root, { id: f.projectId, actorId: B, occurredAt: at(5) }), f);
  await refusedAsHeld(() => deleteProject(f.root, { id: f.projectId, actorId: A, occurredAt: at(5) }), f);
  await refusedAsHeld(() => deleteProject(f.root, { id: f.projectId, occurredAt: at(5) }), f);
  const cli = await refusal(["project-delete", "--workspace", f.root, "--at", at(5), "--id", f.projectId, "--actor", B]);
  assert.equal(cli.reasonCode, "WORK_LEASED");
  assert.deepEqual([cli.details.holder, cli.details.expiresAt, cli.details.workId], [A, at(120), f.ids.subtask], "the CLI names the holder, expiresAt and the item");
  const after = await materializeWorkspace(f.root);
  assert.equal(after.version, before.version, "a refused project-delete writes nothing, not even the expired lease's removal");
  assert.equal(after.headEventHash, before.headEventHash);
  assert.deepEqual(leaseRecords(after), leaseRecords(before));

  // Once no lease runs, the live work is what refuses; the expired lease is not, and it stays.
  await releaseWork(f.root, { id: f.ids.subtask, actorId: A, occurredAt: at(6) });
  const released = await materializeWorkspace(f.root);
  await assert.rejects(() => deleteProject(f.root, { id: f.projectId, actorId: B, occurredAt: at(7) }), (error) => {
    assert.equal(error.reasonCode, "WORKSPACE_INPUT_INVALID");
    assert.match(error.message, /still owns live work/);
    return true;
  });
  const unchanged = await materializeWorkspace(f.root);
  assert.equal(unchanged.version, released.version);
  assert.deepEqual(leaseRecords(unchanged).map((record) => record.key), [f.ids.sibling]);
});
