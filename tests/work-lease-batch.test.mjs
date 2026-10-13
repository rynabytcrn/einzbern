// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-528 (MIN-256; TCRN-CROSS-SUB-457), M4: a work-batch writes as its actor. Under
// another actor's lease a transition or an annotation member is refused as the single verb is, the
// refusal names the member and WORK_LEASED, and the batch writes nothing. A work-create member is
// not held by a lease (MIN-256 R1 Q7).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { applyWorkBatch, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { claimWork } from "../dist/build/packages/core/src/work-lease.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { A, B, at, leaseLibrary } from "./helpers/work-lease-fixture.mjs";

const batch = (root, members, occurredAt, actorId) => applyWorkBatch(root, { schemaVersion: "tcrn.work-batch.v1", members }, {
  occurredAt,
  ...(actorId === undefined ? {} : { actorId }),
});

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return { reasonCode: error.reasonCode, payload: JSON.parse(error.message) };
  }
  throw new Error("the batch was expected to be refused");
}

test("528 SUB-457 M4: under A's lease B's batch is refused at the leased member and writes nothing", async (context) => {
  const f = await leaseLibrary(context, "LEASE-BATCH");
  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(0) });
  const before = await materializeWorkspace(f.root);
  const members = [
    { verb: "work-annotate", id: f.ids.sibling, summary: "B was here" },
    { verb: "work-transition", id: f.ids.story, status: "ready" },
    { verb: "work-annotate", id: f.ids.story, summary: "never reached" },
  ];
  const refused = await refusal(() => batch(f.root, members, at(1), B));
  assert.equal(refused.reasonCode, "WORK_BATCH_REFUSED");
  assert.equal(refused.payload.failed.index, 1, "the transition of the leased Story is the member refused");
  assert.equal(refused.payload.failed.reasonCode, "WORK_LEASED");
  assert.match(refused.payload.failed.detail, new RegExp(`leased to ${A} until ${at(120)}`), "the detail names the holder and when the lease runs out");
  assert.deepEqual(refused.payload.notEvaluated, [2]);
  const after = await materializeWorkspace(f.root);
  assert.equal(after.version, before.version, "the whole batch writes nothing");
  assert.equal(after.headEventHash, before.headEventHash);

  const annotateBelow = await refusal(() => batch(f.root, [{ verb: "work-annotate", id: f.ids.subtask, summary: "B below the lease" }], at(2), B));
  assert.equal(annotateBelow.payload.failed.reasonCode, "WORK_LEASED", "an annotation member of an item below the lease is refused too");
  const anonymous = await refusal(() => batch(f.root, members, at(3)));
  assert.equal(anonymous.payload.failed.reasonCode, "WORK_LEASED", "a batch that names no actor is another actor's");
  assert.equal((await materializeWorkspace(f.root)).version, before.version);

  const applied = await batch(f.root, members, at(4), A);
  assert.equal(applied.version, before.version + 3, "the holder's batch writes every member");
  const story = applied.work.find((record) => record.id === f.ids.story);
  assert.deepEqual([story.status, story.summary], ["ready", "never reached"]);
});

test("528 SUB-457 M4: a work-create member under another actor's lease is not held by it", async (context) => {
  const f = await leaseLibrary(context, "LEASE-BATCH-CREATE");
  await claimWork(f.root, { id: f.ids.story, actorId: A, occurredAt: at(0) });
  const created = await batch(f.root, [
    { verb: "work-create", projectId: f.projectId, externalKey: "LEASE-BATCH-CREATE-SUB-2", kind: "Subtask", parentId: f.ids.story, status: "planned", title: "B adds a Subtask" },
  ], at(1), B);
  assert.ok(created.work.some((record) => record.id === deriveStableId("work", "LEASE-BATCH-CREATE-SUB-2")), "creating under a leased item is not held (Q7)");
  const refused = await refusal(() => batch(f.root, [{ verb: "work-annotate", externalKey: "LEASE-BATCH-CREATE-SUB-2", summary: "B again" }], at(2), B));
  assert.equal(refused.payload.failed.reasonCode, "WORK_LEASED", "but the new item sits below the lease like any other");
});
