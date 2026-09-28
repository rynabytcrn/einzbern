// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-472 R1, R2, R3 (TCRN-CROSS-SUB-297): relations between work records are a
// closed vocabulary of fields. A record stores its forward relations; the reverse is projected
// when read and never written; a write checks its targets, replay checks only the shape; and a new
// Incident or Release is refused while the ones already on a chain stay readable and referable.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  annotateWork,
  applyWorkBatch,
  createProject,
  createWork,
  deleteWork,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  openLegacyWorkspace,
  recordMinutes,
  replayLegacyWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  RELATION_NAMES,
  REVERSE_RELATION_NAMES,
  relationFilter,
  relationsShapeProblem,
  workRelations,
} from "../dist/build/packages/core/src/work-relations.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { forgeOwnStream } from "./helpers/library-forge.mjs";
import { LEGACY_FIXTURE_EXPECTED, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";
import { appendHistoricalWorkCreate } from "./helpers/workspace-fixture.mjs";

const at = (second) => `2026-09-26T08:00:${String(second).padStart(2, "0")}Z`;
const idOf = (externalKey) => deriveStableId("work", externalKey);

const STORY_SCOPE = [
  "## Goal",
  "为谁:the reader of a defect. 目的锚:STORY-472. 符合性判据:the fix names what it fixes. 判定人:machine-checked lane.",
  "", "## Requirements", "- 实现 a fixes relation.",
  "", "## Acceptance Criteria", "GIVEN a historical Incident WHEN a Story fixes it THEN both directions read",
  "", "## Business Background", "实测 seventy Incidents in ten days.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- A defect found at acceptance becomes a Story that fixes the original.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "新增 the relation extension.",
].join("\n");

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-relations-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const state = await createProject(workspace, { occurredAt: at(1), externalKey: "REL-PROJECT", name: "Relations" });
  return { workspace, projectId: state.projects[0].id };
}

async function initiative(fixture, externalKey, second, extra = {}) {
  return createWork(fixture.workspace, {
    occurredAt: at(second), projectId: fixture.projectId, externalKey, kind: "Initiative", parentId: null, title: externalKey, ...extra,
  });
}

test("STORY-472 R2: six relation names and five reverse names, a closed vocabulary", () => {
  assert.deepEqual([...RELATION_NAMES], ["parent", "blocked-by", "implements", "supersedes", "fixes", "decided-in"]);
  assert.deepEqual([...REVERSE_RELATION_NAMES], ["blocks", "implemented-by", "superseded-by", "fixed-by", "decides"]);
});

test("STORY-472 AC2: A blocked-by B reads as B blocks A, and the event carries only the forward relation", async (context) => {
  const fixture = await library(context);
  await initiative(fixture, "REL-B", 2);
  const state = await initiative(fixture, "REL-A", 3, { relations: { blockedBy: [idOf("REL-B")] } });
  const a = idOf("REL-A");
  const b = idOf("REL-B");

  assert.deepEqual(workRelations(state, b).reverse.blocks, [a], "the reverse is projected on read");
  assert.deepEqual(workRelations(state, a).forward.blockedBy, [b]);
  assert.deepEqual(workRelations(state, a).reverse.blocks, [], "and never in the other direction");
  assert.deepEqual([...relationFilter(state, "blocked-by", b)], [a], "every record B blocks");
  assert.deepEqual([...relationFilter(state, "blocks", a)], [b], "every record A is blocked by");

  const event = state.events.at(-1);
  assert.equal(event.payload.operation, "work.created");
  assert.deepEqual(event.payload.record.extensions["advisory:relations"], { required: false, value: { blockedBy: [b] } });
  assert.doesNotMatch(canonicalJson(event.payload), /blocks/u, "the reverse relation is not an event field");
  const replayed = await materializeWorkspaceFromGenesis(fixture.workspace);
  assert.deepEqual(workRelations(replayed, b).reverse.blocks, [a], "and replay projects the same");
});

test("STORY-472 R1, AC1 (core): a new Incident or Release is refused with a remedy, before anything is written", async (context) => {
  const fixture = await library(context);
  const before = await materializeWorkspace(fixture.workspace);
  for (const kind of ["Incident", "Release"]) {
    await assert.rejects(
      () => createWork(fixture.workspace, { occurredAt: at(2), projectId: fixture.projectId, externalKey: `REL-NEW-${kind.toUpperCase()}`, kind, parentId: null, title: "new" }),
      (error) => error?.reasonCode === "WORK_KIND_RETIRED" && /Story/u.test(error.details?.remedy ?? "") && /fixes/u.test(error.details?.remedy ?? ""),
    );
  }
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before.version, "nothing was appended");
});

test("STORY-472 AC3 (core): a historical Incident still reads, and a new Story may fix it", async (context) => {
  const fixture = await library(context);
  await appendHistoricalWorkCreate(fixture.workspace, {
    externalKey: "REL-INC-389", projectId: fixture.projectId, kind: "Incident", status: "done", title: "a historical incident", occurredAt: at(2),
  });
  const incident = idOf("REL-INC-389");
  const read = await materializeWorkspace(fixture.workspace);
  assert.equal(read.work.find((record) => record.id === incident)?.kind, "Incident", "the old record replays");

  await initiative(fixture, "REL-INIT", 3);
  await createWork(fixture.workspace, { occurredAt: at(4), projectId: fixture.projectId, externalKey: "REL-EPIC", kind: "Epic", parentId: idOf("REL-INIT"), title: "epic" });
  const state = await createWork(fixture.workspace, {
    occurredAt: at(5), projectId: fixture.projectId, externalKey: "REL-FIX", kind: "Story", parentId: idOf("REL-EPIC"),
    title: "the fix", scope: STORY_SCOPE, relations: { fixes: [incident], decidedIn: ["minutes:c8953141f2d862c26ff3db46"] },
  });
  const story = idOf("REL-FIX");
  assert.deepEqual(workRelations(state, incident).reverse.fixedBy, [story]);
  assert.deepEqual(workRelations(state, story).forward.fixes, [incident]);
  assert.deepEqual(workRelations(state, story).forward.decidedIn, ["minutes:c8953141f2d862c26ff3db46"], "decided-in is the decided-by list");
  assert.deepEqual(state.work.find((record) => record.id === story).extensions["advisory:decided-by"].value, ["minutes:c8953141f2d862c26ff3db46"]);
  assert.deepEqual(workRelations(state, "minutes:c8953141f2d862c26ff3db46").reverse.decides, [story], "decides is read back from decided-in");
  assert.deepEqual([...relationFilter(state, "fixed-by", story)], [incident]);
  assert.deepEqual([...relationFilter(state, "fixes", incident)], [story]);
  assert.deepEqual([...relationFilter(state, "decided-in", "minutes:c8953141f2d862c26ff3db46")], [story]);
  assert.deepEqual(await materializeWorkspaceFromGenesis(fixture.workspace), await materializeWorkspace(fixture.workspace), "genesis and cached reads agree");
});

test("STORY-502 D4: decided-in missing is projected at read time and clears when its minutes record arrives", async (context) => {
  const fixture = await library(context);
  const presentMinutesId = deriveStableId("minutes", "REL-MIN-PRESENT");
  let state = await recordMinutes(fixture.workspace, {
    occurredAt: at(2), externalKey: "REL-MIN-PRESENT", projectId: fixture.projectId,
    title: "Present decision", summary: "Already in this library.", decisions: ["Keep the identity."],
    decidedBy: [], linkedWorkIds: [],
  });
  const presentLinked = await initiative(fixture, "REL-MIN-PRESENT-LINK", 3, { relations: { decidedIn: [presentMinutesId] } });
  assert.deepEqual(workRelations(presentLinked, idOf("REL-MIN-PRESENT-LINK")).missing, [], "a current minutes target is not missing");

  const workTarget = idOf("REL-MIN-LIVE-TARGET");
  state = await initiative(fixture, "REL-MIN-LIVE-TARGET", 4);
  const laterMinutesId = deriveStableId("minutes", "REL-MIN-LATER");
  state = await initiative(fixture, "REL-MIN-LATER-LINK", 5, {
    relations: { blockedBy: [workTarget], decidedIn: [laterMinutesId] },
  });
  const linkedId = idOf("REL-MIN-LATER-LINK");
  const workEventBefore = state.events.find((event) => event.payload?.record?.id === linkedId);
  assert.ok(workEventBefore, "the work record has one stored create event");
  const payloadBefore = canonicalJson(workEventBefore.payload);
  assert.deepEqual(workRelations(state, linkedId).forward.decidedIn, [laterMinutesId]);
  assert.deepEqual(workRelations(state, linkedId).forward.blockedBy, [workTarget], "the work relation remains available");
  assert.deepEqual(workRelations(state, linkedId).missing, [laterMinutesId], "an absent but well-shaped minutes id is reported missing");

  state = await recordMinutes(fixture.workspace, {
    occurredAt: at(6), externalKey: "REL-MIN-LATER", projectId: fixture.projectId,
    title: "Arrived decision", summary: "The target arrived later.", decisions: ["Keep the original reference."],
    decidedBy: [], linkedWorkIds: [],
  });
  const workEventAfter = state.events.find((event) => event.id === workEventBefore.id);
  assert.ok(workEventAfter, "the original work event remains in the history");
  assert.equal(canonicalJson(workEventAfter.payload), payloadBefore, "arrival does not rewrite the historical work event");
  assert.deepEqual(state.work.find((record) => record.id === linkedId).extensions["advisory:decided-by"].value, [laterMinutesId]);
  assert.deepEqual(workRelations(state, linkedId).forward.decidedIn, [laterMinutesId], "the stored identity is unchanged");
  assert.deepEqual(workRelations(state, linkedId).missing, [], "the projection clears once the minutes record is present");
  assert.deepEqual(workRelations(state, workTarget).reverse.blocks, [linkedId], "existing work-target projection is unchanged");
});

test("STORY-472 R2: a missing or deleted target, the record itself and an unknown relation are refused, nothing written", async (context) => {
  const fixture = await library(context);
  await initiative(fixture, "REL-X", 2);
  await initiative(fixture, "REL-GONE", 3);
  await deleteWork(fixture.workspace, { occurredAt: at(4), id: idOf("REL-GONE") });
  const before = await materializeWorkspace(fixture.workspace);
  const refusals = [
    () => initiative(fixture, "REL-Y", 5, { relations: { fixes: ["work:000000000000000000000000"] } }),
    () => initiative(fixture, "REL-Y", 5, { relations: { supersedes: [idOf("REL-GONE")] } }),
    () => initiative(fixture, "REL-Y", 5, { relations: { causes: [idOf("REL-X")] } }),
    () => initiative(fixture, "REL-Y", 5, { relations: { implements: ["minutes:c8953141f2d862c26ff3db46"] } }),
    () => initiative(fixture, "REL-Y", 5, { relations: { decidedIn: [idOf("REL-X")] } }),
    () => initiative(fixture, "REL-Y", 5, { relations: { decidedIn: ["not-a-minutes-id"] } }),
    () => annotateWork(fixture.workspace, { occurredAt: at(5), id: idOf("REL-X"), relations: { blockedBy: [idOf("REL-X")] } }),
  ];
  for (const refusal of refusals) {
    await assert.rejects(refusal, (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID");
  }
  const tooMany = Array.from({ length: 65 }, (_, index) => `work:${String(index + 1).padStart(24, "0")}`);
  await assert.rejects(
    () => initiative(fixture, "REL-Y", 5, { relations: { blockedBy: tooMany } }),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /at most 64/u.test(error.message),
    "the list limit is judged before any target is looked up",
  );
  assert.throws(() => relationFilter(before, "causes", idOf("REL-X")), (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID");
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before.version, "no refusal appended an event");
});

test("STORY-472 R2: repeats collapse, lists sort, and an annotation replaces each list it names whole", async (context) => {
  const fixture = await library(context);
  for (const [index, key] of ["REL-P", "REL-Q", "REL-R"].entries()) await initiative(fixture, key, 2 + index);
  const [p, q, r] = ["REL-P", "REL-Q", "REL-R"].map(idOf);
  const stored = (state) => state.work.find((record) => record.id === p).extensions["advisory:relations"]?.value;
  let state = await annotateWork(fixture.workspace, { occurredAt: at(6), id: p, relations: { fixes: [r, q, r], blockedBy: [q] } });
  assert.deepEqual(stored(state), { blockedBy: [q], fixes: [q, r].sort() });

  state = await annotateWork(fixture.workspace, { occurredAt: at(7), id: p, relations: { implements: [r] } });
  assert.deepEqual(stored(state), { blockedBy: [q], fixes: [q, r].sort(), implements: [r] }, "a list the annotation does not name is kept");

  state = await annotateWork(fixture.workspace, { occurredAt: at(8), id: p, relations: { fixes: [r], blockedBy: [] } });
  assert.deepEqual(stored(state), { fixes: [r], implements: [r] }, "a named list is replaced whole, and an empty one removed");
  assert.deepEqual(workRelations(state, q).reverse.blocks, []);
  assert.deepEqual(workRelations(state, q).reverse.fixedBy, []);
  assert.deepEqual(workRelations(state, r).reverse.implementedBy, [p]);

  state = await annotateWork(fixture.workspace, { occurredAt: at(9), id: p, relations: { fixes: [], implements: [] } });
  assert.equal(stored(state), undefined, "the extension goes when no list is left");
  assert.deepEqual(workRelations(state, r).reverse.implementedBy, []);
  await assert.rejects(
    () => annotateWork(fixture.workspace, { occurredAt: at(10), id: p, relations: {} }),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /changed no annotatable field/u.test(error.message),
    "relations naming no list move nothing",
  );
  assert.equal((await materializeWorkspaceFromGenesis(fixture.workspace)).version, state.version, "every annotation replays");
});

test("STORY-472: replay checks the shape of stored relations, never whether a target exists", async (context) => {
  assert.equal(relationsShapeProblem({ blockedBy: ["work:000000000000000000000001"] }, "work:000000000000000000000009"), null);
  for (const value of [
    null, [], {}, { blocks: ["work:000000000000000000000001"] }, { fixes: [] }, { fixes: ["minutes:000000000000000000000001"] },
    { fixes: ["work:000000000000000000000002", "work:000000000000000000000001"] }, { fixes: ["work:000000000000000000000001", "work:000000000000000000000001"] },
    { fixes: ["work:000000000000000000000009"] },
  ]) {
    assert.notEqual(relationsShapeProblem(value, "work:000000000000000000000009"), null, JSON.stringify(value));
  }

  // A forged create naming a target this device never saw replays: another device may hold it.
  const fixture = await library(context);
  await initiative(fixture, "REL-HONEST", 2);
  await forgeOwnStream(fixture.workspace, (events) => events.map((event) => event.payload.operation === "work.created"
    ? (() => {
      const extensions = { "advisory:relations": { required: false, value: { fixes: ["work:000000000000000000000001"] } } };
      return { ...event, payload: { ...event.payload, record: { ...event.payload.record, extensions, scopeDigest: canonicalSha256(extensions) } } };
    })()
    : event));
  const accepted = await materializeWorkspace(fixture.workspace);
  assert.deepEqual(accepted.library.rejectedEvents, [], "an unseen target is not a corrupt event");
  assert.deepEqual(workRelations(accepted, idOf("REL-HONEST")).forward.fixes, ["work:000000000000000000000001"]);

  // A stored reverse name is not a relation this engine writes, so replay refuses the event.
  await forgeOwnStream(fixture.workspace, (events) => events.map((event) => event.payload.operation === "work.created"
    ? (() => {
      const extensions = { "advisory:relations": { required: false, value: { blocks: ["work:000000000000000000000001"] } } };
      return { ...event, payload: { ...event.payload, record: { ...event.payload.record, extensions, scopeDigest: canonicalSha256(extensions) } } };
    })()
    : event));
  const refused = await materializeWorkspace(fixture.workspace);
  assert.equal(refused.library.rejectedEvents.length, 1);
  assert.equal(refused.library.rejectedEvents[0].reasonCode, "WORKSPACE_EVENT_CORRUPT");
  assert.match(refused.library.rejectedEvents[0].detail, /advisory relations/u);
});

test("STORY-472 R4 (core): a batch member names relations, even to a record an earlier member created, and a retired kind is refused in the shape pass", async (context) => {
  const fixture = await library(context);
  const batch = (members, second) => applyWorkBatch(fixture.workspace, { schemaVersion: "tcrn.work-batch.v1", members }, { occurredAt: at(second) });
  const state = await batch([
    { verb: "work-create", projectId: fixture.projectId, externalKey: "REL-BATCH-1", kind: "Initiative", parentId: null, title: "one" },
    { verb: "work-create", projectId: fixture.projectId, externalKey: "REL-BATCH-2", kind: "Initiative", parentId: null, title: "two", relations: { supersedes: [idOf("REL-BATCH-1")] } },
    { verb: "work-annotate", externalKey: "REL-BATCH-1", relations: { blockedBy: [idOf("REL-BATCH-2")] } },
  ], 2);
  assert.deepEqual(workRelations(state, idOf("REL-BATCH-1")).reverse.supersededBy, [idOf("REL-BATCH-2")]);
  assert.deepEqual(workRelations(state, idOf("REL-BATCH-2")).reverse.blocks, [idOf("REL-BATCH-1")]);

  const before = await materializeWorkspace(fixture.workspace);
  await assert.rejects(
    () => batch([
      { verb: "work-create", projectId: fixture.projectId, externalKey: "REL-BATCH-INC", kind: "Incident", parentId: null, title: "inc" },
      { verb: "work-create", projectId: fixture.projectId, externalKey: "REL-BATCH-REL", kind: "Release", parentId: null, title: "rel" },
      { verb: "work-annotate", externalKey: "REL-BATCH-1", relations: { causes: [idOf("REL-BATCH-2")] } },
    ], 3),
    (error) => {
      const payload = JSON.parse(error.message);
      return error.reasonCode === "WORK_BATCH_REFUSED" && payload.stage === "shape" &&
        payload.problems.filter((problem) => problem.rule === "kind-retired").length === 2 &&
        payload.problems.some((problem) => problem.rule === "relations-shape" && problem.index === 2);
    },
  );
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before.version);
});

test("STORY-472: the old-layout fixture replays to the head it was written with", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-relations-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root } = await restoreLegacyFixture(base);
  const state = replayLegacyWorkspace(await openLegacyWorkspace(root));
  assert.equal(state.version, LEGACY_FIXTURE_EXPECTED.version);
  assert.equal(state.headEventHash, LEGACY_FIXTURE_EXPECTED.headEventHash);
});
