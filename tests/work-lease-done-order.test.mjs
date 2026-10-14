// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-536 (MIN-257 D6; TCRN-CROSS-SUB-471), GWT1 and GWT3 through the CLI: work-transition
// to done holds the item to the leases before it judges the gates. While A holds STORY, B's transition
// to done is refused with WORK_LEASED, naming the holder and when the lease runs out, where the gates
// would have answered WORK_DONE_GATES_NOT_RUN, and no gate run is written; A's own transition is judged
// by the gates as before, and goes through once a green run is bound to the Story.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { A, B } from "./helpers/work-lease-fixture.mjs";
import { gateRunEntries, gatesRun, leaseGatesLibrary, libraryVersion, refusal, run } from "./helpers/work-lease-gates-fixture.mjs";

const done = (f, id, actor) => ["work-transition", "--workspace", f.library, "--at", f.at(), "--id", id, "--status", "done", "--project", f.project, ...(actor === undefined ? [] : ["--actor", actor])];
const leasedBy = (error) => ({ reasonCode: error.reasonCode, holder: error.details?.holder, expiresAt: error.details?.expiresAt, leasedWorkId: error.details?.leasedWorkId });

test("536 SUB-471 GWT1: under A's lease B's transition to done is WORK_LEASED before the gates are judged, and writes no gate run", async (context) => {
  const f = await leaseGatesLibrary(context, "LEASE-DONE");
  assert.equal(f.lease.holder, A);
  const expected = { reasonCode: "WORK_LEASED", holder: A, expiresAt: f.lease.expiresAt, leasedWorkId: f.ids.story };
  const version = await libraryVersion(f.library);
  assert.equal(gateRunEntries(f.libraryId), 0, "no gate run is recorded yet");

  assert.deepEqual(leasedBy(await refusal(done(f, f.ids.story, B))), expected, "the lease answers, not WORK_DONE_GATES_NOT_RUN");
  assert.deepEqual(leasedBy(await refusal(done(f, f.ids.story))), expected, "a transition that names no actor is another actor's");
  assert.equal(gateRunEntries(f.libraryId), 0, "the refusal wrote nothing under gate-runs");
  assert.equal(await libraryVersion(f.library), version, "the refusal wrote nothing to the library");

  // The item no lease binds is judged by the gates for B as for anyone.
  const sibling = await refusal(done(f, f.ids.sibling, B));
  assert.deepEqual([sibling.reasonCode, sibling.details?.stories], ["WORK_DONE_GATES_NOT_RUN", [f.ids.sibling]]);

  // A green run bound to STORY does not let B through: the lease still answers first.
  const green = await gatesRun(f, [f.ids.story]);
  assert.deepEqual([green.ok, green.requiredReds], [true, []]);
  const entries = gateRunEntries(f.libraryId);
  assert.ok(entries > 0, "the run is recorded under gate-runs");
  assert.deepEqual(leasedBy(await refusal(done(f, f.ids.story, B))), expected);
  assert.equal(gateRunEntries(f.libraryId), entries, "B's refusal added nothing under gate-runs");
  assert.equal((await run(["work-show", "--workspace", f.library, "--id", f.ids.story])).record.status, "active");
});

test("536 SUB-471 GWT3: the holder's transition to done is judged by the gates as before, and goes through after a green run", async (context) => {
  const f = await leaseGatesLibrary(context, "LEASE-DONE-HOLDER");
  const notRun = await refusal(done(f, f.ids.story, A));
  assert.deepEqual([notRun.reasonCode, notRun.details?.stories], ["WORK_DONE_GATES_NOT_RUN", [f.ids.story]], "the holder hears the gates");

  const green = await gatesRun(f, [f.ids.story]);
  assert.deepEqual([green.ok, green.requiredReds], [true, []]);
  const passed = await run(done(f, f.ids.story, A));
  assert.equal(passed.record.status, "done");
  assert.deepEqual([passed.doneGates.checked, passed.doneGates.reason, passed.doneGates.runId], [true, "green", green.run.runId]);
});
