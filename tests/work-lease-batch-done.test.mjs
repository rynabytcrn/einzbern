// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-536 (MIN-257 D6; TCRN-CROSS-SUB-472), GWT2 through the CLI: work-batch holds every
// transition and annotation member to the leases before it judges the gates. While A holds STORY, a
// batch of B's that takes STORY to done, or annotates STORY or a record created under it, is refused
// whole with the WORK_BATCH_REFUSED of the apply pass (failed.reasonCode WORK_LEASED, EPIC-149 R4 Q3)
// where the gates would have answered WORK_DONE_GATES_NOT_RUN; the library and the gate runs are left
// as they were. A's batch is judged by the gates as before.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { A, B } from "./helpers/work-lease-fixture.mjs";
import { gateRunEntries, gatesRun, leaseGatesLibrary, libraryVersion, refusal, run } from "./helpers/work-lease-gates-fixture.mjs";

let files = 0;

/** The work-batch command line for `members`, written to a file beside the library, as `actor`. */
async function batch(f, members, actor) {
  files += 1;
  const file = join(f.base, `batch-${files}.json`);
  await writeFile(file, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members })}\n`);
  return ["work-batch", "--workspace", f.library, "--at", f.at(), "--from-file", file, "--project", f.project, ...(actor === undefined ? [] : ["--actor", actor])];
}

async function batchRefusal(argv) {
  const error = await refusal(argv);
  assert.equal(error.reasonCode, "WORK_BATCH_REFUSED", `${error.reasonCode}: ${error.message}`);
  return JSON.parse(error.message);
}

const leased = (f, workId, index, verb, notEvaluated = []) => ({
  stage: "apply",
  failed: { index, verb, phase: "delta", reasonCode: "WORK_LEASED", detail: `work ${workId} is leased to ${A} until ${f.lease.expiresAt} (the lease is held on ${f.ids.story})` },
  notEvaluated,
});

test("536 SUB-472 GWT2: B's batch that takes the leased Story to done is refused before the gates are judged, and writes nothing", async (context) => {
  const f = await leaseGatesLibrary(context, "LEASE-BATCH-DONE");
  const version = await libraryVersion(f.library);
  const toDone = (id) => ({ verb: "work-transition", id, status: "done" });

  assert.deepEqual(await batchRefusal(await batch(f, [toDone(f.ids.story)], B)), leased(f, f.ids.story, 0, "work-transition"), "the lease answers, not WORK_DONE_GATES_NOT_RUN");
  assert.deepEqual(await batchRefusal(await batch(f, [toDone(f.ids.story)])), leased(f, f.ids.story, 0, "work-transition"), "a batch that names no actor is another actor's");
  assert.deepEqual(await batchRefusal(await batch(f, [toDone(f.ids.sibling), toDone(f.ids.story)], B)), leased(f, f.ids.story, 1, "work-transition"),
    "every member is held to the leases before the gates judge the first");
  assert.equal(await libraryVersion(f.library), version, "the library is as it was");
  assert.equal(gateRunEntries(f.libraryId), 0, "no gate run was written");

  // With a green run bound to STORY, B's batch is still refused by the lease, and writes no run.
  const green = await gatesRun(f, [f.ids.story]);
  assert.deepEqual([green.ok, green.requiredReds], [true, []]);
  const entries = gateRunEntries(f.libraryId);
  assert.deepEqual(await batchRefusal(await batch(f, [toDone(f.ids.story)], B)), leased(f, f.ids.story, 0, "work-transition"));
  assert.equal(gateRunEntries(f.libraryId), entries);
  assert.equal(await libraryVersion(f.library), version);
});

test("536 SUB-472 GWT2: an annotation member of a leased record refuses the batch before the gates are judged, a record created under the lease included", async (context) => {
  const f = await leaseGatesLibrary(context, "LEASE-BATCH-NOTE");
  const version = await libraryVersion(f.library);
  const siblingDone = { verb: "work-transition", id: f.ids.sibling, status: "done" };

  assert.deepEqual(await batchRefusal(await batch(f, [siblingDone, { verb: "work-annotate", id: f.ids.story, summary: "B was here" }], B)),
    leased(f, f.ids.story, 1, "work-annotate"), "the annotation of the leased Story refuses the batch; the sibling's gates are not judged");

  const subtaskKey = "LEASE-BATCH-NOTE-SUB-NEW";
  const subtaskId = deriveStableId("work", subtaskKey);
  const created = { verb: "work-create", projectId: f.projectId, externalKey: subtaskKey, kind: "Subtask", parentId: f.ids.story, status: "planned", title: "B adds a Subtask" };
  assert.deepEqual(await batchRefusal(await batch(f, [created, { verb: "work-annotate", externalKey: subtaskKey, summary: "B notes it" }, siblingDone], B)),
    leased(f, subtaskId, 1, "work-annotate", [2]), "a record an earlier member creates under the leased Story is bound by the lease");
  assert.equal(await libraryVersion(f.library), version, "the library is as it was");
  assert.equal(gateRunEntries(f.libraryId), 0, "no gate run was written");

  // A batch with no transition or annotation member is not held by the lease (MIN-256 R1 Q7).
  const applied = await run(await batch(f, [created], B));
  assert.equal(applied.record.reasonCode, "WORK_BATCH_APPLIED");
  assert.equal(applied.version, version + 1);
});

test("536 SUB-472: the holder's batch is judged by the gates as before, and goes through after a green run", async (context) => {
  const f = await leaseGatesLibrary(context, "LEASE-BATCH-HOLDER");
  const members = [{ verb: "work-annotate", id: f.ids.story, summary: "A closes it" }, { verb: "work-transition", id: f.ids.story, status: "done" }];
  const notRun = await refusal(await batch(f, members, A));
  assert.deepEqual([notRun.reasonCode, notRun.details?.stories], ["WORK_DONE_GATES_NOT_RUN", [f.ids.story]], "the holder hears the gates");

  const green = await gatesRun(f, [f.ids.story]);
  assert.deepEqual([green.ok, green.requiredReds], [true, []]);
  const applied = await run(await batch(f, members, A));
  assert.equal(applied.record.reasonCode, "WORK_BATCH_APPLIED");
  assert.deepEqual([applied.doneGates.checked, applied.doneGates.reason, applied.doneGates.runId], [true, "green", green.run.runId]);
  const story = (await run(["work-show", "--workspace", f.library, "--id", f.ids.story])).record;
  assert.deepEqual([story.status, story.summary], ["done", "A closes it"]);
});
