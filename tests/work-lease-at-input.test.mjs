// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-536 (MIN-257 D6; TCRN-CROSS-SUB-496), through the CLI: the lease checks made before
// a write -- work-transition to done (SUB-471) and the transition and annotation members of a
// work-batch (SUB-472) -- judge leases only at an --at the write itself takes. An --at that is not a
// strict instant is the write's to refuse, so it is refused for the reason it gets when the library
// holds no lease, whatever leases the library holds: the item's own lease, another item's lease or
// one that has run out. That reason is the gates' WORK_DONE_GATES_NOT_RUN for a Story going to done
// with no green run, and the write's TIMESTAMP_INVALID otherwise. At a strict instant the checks
// answer as before: another actor's lease refuses the write with WORK_LEASED before the gates.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { A, B } from "./helpers/work-lease-fixture.mjs";
import { gatesRun, leaseGatesLibrary, libraryVersion, refusal, run } from "./helpers/work-lease-gates-fixture.mjs";

// None is an instant the write takes: no offset, a space for the T, a day February does not have.
const NOT_STRICT = ["2026-10-14T09:30:00", "2026-10-14 09:30:00Z", "2026-02-30T09:30:00Z"];
// An hour before the library's first event: a one-minute lease A claims then has run out at every
// instant the test writes at.
const BEFORE = "2026-10-14T08:00:00Z";

let files = 0;

/** The work-batch command line for `members` at `at`, written to a file beside the library, as B. */
async function batch(f, members, at) {
  files += 1;
  const file = join(f.base, `at-input-batch-${files}.json`);
  await writeFile(file, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members })}\n`);
  return ["work-batch", "--workspace", f.library, "--at", at, "--from-file", file, "--project", f.project, "--actor", B];
}

const done = (f, id, at) => ["work-transition", "--workspace", f.library, "--at", at, "--id", id, "--status", "done", "--project", f.project, "--actor", B];

/** The reason B's writes at each instant that is not strict are refused with, by write. */
async function answers(f) {
  const result = {};
  for (const at of NOT_STRICT) {
    const writes = {
      "done SIBLING": done(f, f.ids.sibling, at),
      "done STORY": done(f, f.ids.story, at),
      "batch: SIBLING to done": await batch(f, [{ verb: "work-transition", id: f.ids.sibling, status: "done" }], at),
      "batch: annotate SIBLING": await batch(f, [{ verb: "work-annotate", id: f.ids.sibling, summary: "B was here" }], at),
      "batch: annotate STORY": await batch(f, [{ verb: "work-annotate", id: f.ids.story, summary: "B was here" }], at),
    };
    for (const [name, argv] of Object.entries(writes)) result[`${name} at ${at}`] = (await refusal(argv)).reasonCode;
  }
  return result;
}

/** What answers(f) holds when the library holds no lease: SIBLING has a green run, STORY none. */
function withoutLeases() {
  const result = {};
  for (const at of NOT_STRICT) {
    Object.assign(result, {
      [`done SIBLING at ${at}`]: "TIMESTAMP_INVALID",
      [`done STORY at ${at}`]: "WORK_DONE_GATES_NOT_RUN",
      [`batch: SIBLING to done at ${at}`]: "TIMESTAMP_INVALID",
      [`batch: annotate SIBLING at ${at}`]: "TIMESTAMP_INVALID",
      [`batch: annotate STORY at ${at}`]: "TIMESTAMP_INVALID",
    });
  }
  return result;
}

async function leases(f) {
  return (await materializeWorkspace(f.library)).configRecords.filter((record) => record.collection === "lease").map((record) => record.key).sort();
}

test("536 SUB-496: an --at that is not a strict instant is refused as it is in a library with no lease, whatever leases the library holds", async (context) => {
  const f = await leaseGatesLibrary(context, "LEASE-AT-INPUT");
  const green = await gatesRun(f, [f.ids.sibling]);
  assert.deepEqual([green.ok, green.requiredReds], [true, []], "SIBLING has a green run, STORY none");

  // A's lease on STORY runs: STORY's own lease, and another item's lease for SIBLING.
  assert.deepEqual(await leases(f), [f.ids.story]);
  let version = await libraryVersion(f.library);
  assert.deepEqual(await answers(f), withoutLeases(), "under A's lease on STORY");
  assert.equal(await libraryVersion(f.library), version, "no refusal wrote anything");

  // At a strict instant the lease still answers first, before the gates.
  const leased = await refusal(done(f, f.ids.story, f.at()));
  assert.deepEqual([leased.reasonCode, leased.details?.holder, leased.details?.leasedWorkId], ["WORK_LEASED", A, f.ids.story]);
  const note = await refusal(await batch(f, [{ verb: "work-annotate", id: f.ids.story, summary: "B was here" }], f.at()));
  assert.deepEqual([note.reasonCode, JSON.parse(note.message).failed.reasonCode], ["WORK_BATCH_REFUSED", "WORK_LEASED"]);
  assert.equal(await libraryVersion(f.library), version);

  // Only a lease that has run out: A releases STORY and claims SIBLING for a minute an hour before.
  await run(["work-release", "--workspace", f.library, "--at", f.at(), "--id", f.ids.story, "--actor", A]);
  const claimed = await run(["work-claim", "--workspace", f.library, "--at", BEFORE, "--id", f.ids.sibling, "--actor", A, "--ttl", "1m"]);
  assert.equal(claimed.lease.expiresAt, "2026-10-14T08:01:00Z");
  assert.deepEqual(await leases(f), [f.ids.sibling]);
  version = await libraryVersion(f.library);
  assert.deepEqual(await answers(f), withoutLeases(), "with only a lease that has run out");
  assert.equal(await libraryVersion(f.library), version, "no refusal wrote anything");

  // No lease at all: the reasons above are the ones a library without a lease gives.
  await run(["work-release", "--workspace", f.library, "--at", f.at(), "--id", f.ids.sibling, "--actor", A]);
  assert.deepEqual(await leases(f), []);
  version = await libraryVersion(f.library);
  assert.deepEqual(await answers(f), withoutLeases(), "with no lease");
  assert.equal(await libraryVersion(f.library), version, "no refusal wrote anything");

  // And at a strict instant, with no lease, B's transition of SIBLING to done goes through on its green run.
  const passed = await run(done(f, f.ids.sibling, f.at()));
  assert.deepEqual([passed.record.status, passed.doneGates.reason, passed.doneGates.runId], ["done", "green", green.run.runId]);
});
