// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-473 R1, R2 and AC1, AC2, AC3 at the core (TCRN-CROSS-SUB-299): a Story is a
// goal, an acceptance and a free body. Those two are all the engine checks, as fields or mapped
// from the blocks of an old scope, which is read and never migrated. The Owner-decider rule
// (story-rule-conservation CLOSEOUT-005) now reads the goal.

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
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  openLegacyWorkspace,
  replayLegacyWorkspace,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { deriveStoryFieldsFromScope, storyFields, storyOwnerDeciderNamed } from "../dist/build/packages/core/src/story-fields.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";
import { forgeOwnStream } from "./helpers/library-forge.mjs";

const at = (second) => `2026-09-26T10:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);
const MINUTES = "minutes:c8953141f2d862c26ff3db46";

async function epic(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-story-fields-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "FIELDS-PROJECT", name: "Fields" })).projects[0].id;
  await createWork(workspace, { occurredAt: at(2), projectId, externalKey: "FIELDS-INIT", kind: "Initiative", parentId: null, title: "init" });
  await createWork(workspace, { occurredAt: at(3), projectId, externalKey: "FIELDS-EPIC", kind: "Epic", parentId: idOf("FIELDS-INIT"), title: "epic" });
  const story = (key, fields, second = 4) => createWork(workspace, {
    occurredAt: at(second), projectId, externalKey: key, kind: "Story", parentId: idOf("FIELDS-EPIC"), title: key, ...fields,
  });
  return { workspace, projectId, story };
}

const record = (state, key) => state.work.find((entry) => entry.externalKey === key);

test("STORY-473 AC1 (core): a Story with no acceptance, as a field or from a scope, is refused naming the field", async (context) => {
  const fixture = await epic(context);
  const before = (await materializeWorkspace(fixture.workspace)).version;
  for (const fields of [
    { goal: "Record who decides." },
    { goal: "Record who decides.", scope: "## Goal\nRecord who decides.\n\n## Requirements\n- anything" },
    { goal: "Record who decides.", acceptance: "   " },
  ]) {
    await assert.rejects(
      () => fixture.story("FIELDS-REFUSED", fields),
      (error) => (error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "acceptance") ||
        (error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /acceptance/u.test(error.message)),
      JSON.stringify(fields),
    );
  }
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before, "nothing was appended");
});

test("STORY-473 AC2 (core): a goal, an acceptance and two paragraphs of free body are a Story", async (context) => {
  const fixture = await epic(context);
  const body = "First, what changed and why.\n\nSecond, what stays as it was.";
  const state = await fixture.story("FIELDS-FREE", {
    goal: "Let a model write a Story its own way. Nothing else is checked.",
    acceptance: "GIVEN a Story with a goal and an acceptance WHEN it is created THEN it is accepted",
    body,
  });
  const story = record(state, "FIELDS-FREE");
  assert.equal(story.extensions["advisory:goal"].value, "Let a model write a Story its own way. Nothing else is checked.");
  assert.equal(story.extensions["advisory:body"].value, body);
  assert.equal(story.extensions["advisory:scope"], undefined, "no scope is required");
  assert.equal(story.summary, "Let a model write a Story its own way", "the summary is the first sentence of the goal");
  assert.deepEqual(storyFields(story), {
    goal: "Let a model write a Story its own way. Nothing else is checked.",
    acceptance: "GIVEN a Story with a goal and an acceptance WHEN it is created THEN it is accepted",
    body,
    source: "fields",
  });
  // It moves like any other Story, and replay agrees with the write.
  await transitionWork(fixture.workspace, { occurredAt: at(5), id: story.id, status: "ready" });
  assert.deepEqual(await materializeWorkspaceFromGenesis(fixture.workspace), await materializeWorkspace(fixture.workspace));
});

test("STORY-473 AC3 (core): the ten-block Story in the old-layout fixture reads with its goal and acceptance", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-story-fields-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root } = await restoreLegacyFixture(base);
  const state = replayLegacyWorkspace(await openLegacyWorkspace(root));
  assert.equal(state.headEventHash, LEGACY_FIXTURE_EXPECTED.headEventHash, "the old chain is read, never rewritten");
  const story = state.work.find((entry) => entry.id === LEGACY_FIXTURE_EXPECTED.records.story.id);
  const fields = storyFields(story);
  assert.equal(fields.source, "scope");
  assert.equal(typeof fields.goal, "string");
  assert.ok(fields.goal.length > 0);
  assert.equal(typeof fields.acceptance, "string");
  assert.ok(fields.acceptance.length > 0);
  assert.ok(typeof fields.body === "string" && fields.body.includes("## Requirements"), "the other blocks become the body, under their headings");
});

test("STORY-473 R2: a scope maps its Goal and Acceptance Criteria blocks; the rest is the body, in order", () => {
  const scope = [
    "Preamble line.",
    "【Goal】为谁=reader；目的锚=STORY-473。",
    "【Requirements】- a",
    "【Acceptance Criteria】GIVEN x WHEN y THEN z",
    "【Business Background】",
    "【Implementation Notes】notes",
  ].join("\n");
  assert.deepEqual(deriveStoryFieldsFromScope(scope), {
    goal: "为谁=reader；目的锚=STORY-473。",
    acceptance: "GIVEN x WHEN y THEN z",
    body: "Preamble line.\n\n## Requirements\n- a\n\n## Implementation Notes\nnotes",
  });
  assert.deepEqual(deriveStoryFieldsFromScope(""), { goal: null, acceptance: null, body: null });
  assert.deepEqual(deriveStoryFieldsFromScope("## Goal\n\n## Acceptance Criteria\nok"), { goal: null, acceptance: "ok", body: null }, "an empty block maps to nothing");
  // A field the record carries wins over its scope; one it lacks is still read from the scope.
  const mixed = storyFields({ extensions: { "advisory:goal": { required: false, value: "field goal" }, "advisory:scope": { required: false, value: scope } } });
  assert.deepEqual(mixed, { goal: "field goal", acceptance: "GIVEN x WHEN y THEN z", body: "Preamble line.\n\n## Requirements\n- a\n\n## Implementation Notes\nnotes", source: "fields" });
  assert.deepEqual(storyFields({ extensions: {} }), { goal: null, acceptance: null, body: null, source: "none" });
});

test("STORY-473 (CLOSEOUT-005): an Owner-decided Story reaches done only with a decided-by backlink, read from the goal", async (context) => {
  assert.equal(storyOwnerDeciderNamed({ goal: "判定人=Owner。" }), true);
  assert.equal(storyOwnerDeciderNamed({ goal: "decider: Owner, after review" }), true);
  assert.equal(storyOwnerDeciderNamed({ goal: "decider: the machine lane" }), false);
  assert.equal(storyOwnerDeciderNamed({ goal: null }), false);
  const fixture = await epic(context);
  const acceptance = "GIVEN an Owner-decided Story WHEN it closes THEN minutes back it";
  await fixture.story("FIELDS-OWNER-FIELD", { goal: "Close the loop. 判定人=Owner。", acceptance });
  await fixture.story("FIELDS-OWNER-SCOPE", { scope: `## Goal\nClose the loop. decider: Owner\n\n## Acceptance Criteria\n${acceptance}` }, 5);
  await fixture.story("FIELDS-OWNER-BACKED", { goal: "Close the loop. 判定人=Owner。", acceptance, decidedBy: [MINUTES] }, 6);
  for (const key of ["FIELDS-OWNER-FIELD", "FIELDS-OWNER-SCOPE", "FIELDS-OWNER-BACKED"]) {
    for (const [index, status] of ["ready", "active"].entries()) {
      await transitionWork(fixture.workspace, { occurredAt: at(10 + index), id: idOf(key), status });
    }
  }
  for (const key of ["FIELDS-OWNER-FIELD", "FIELDS-OWNER-SCOPE"]) {
    await assert.rejects(
      () => transitionWork(fixture.workspace, { occurredAt: at(12), id: idOf(key), status: "done" }),
      (error) => error?.reasonCode === "WORKSPACE_OWNER_ACCEPTANCE_REQUIRED",
      key,
    );
  }
  const done = await transitionWork(fixture.workspace, { occurredAt: at(12), id: idOf("FIELDS-OWNER-BACKED"), status: "done" });
  assert.equal(record(done, "FIELDS-OWNER-BACKED").status, "done");
});

test("STORY-473 R2: an annotation may rewrite goal, acceptance and body, and must leave a Story both", async (context) => {
  const fixture = await epic(context);
  await fixture.story("FIELDS-ANNOTATED", { goal: "Before.", acceptance: "GIVEN before WHEN read THEN before" });
  const id = idOf("FIELDS-ANNOTATED");
  let state = await annotateWork(fixture.workspace, { occurredAt: at(5), id, goal: "After.", body: "Why it moved." });
  assert.deepEqual(storyFields(record(state, "FIELDS-ANNOTATED")), { goal: "After.", acceptance: "GIVEN before WHEN read THEN before", body: "Why it moved.", source: "fields" });
  await assert.rejects(
    () => annotateWork(fixture.workspace, { occurredAt: at(6), id, acceptance: "" }),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID",
    "an empty acceptance is not a value",
  );
  state = await annotateWork(fixture.workspace, { occurredAt: at(7), id, title: "renamed" });
  assert.equal(record(state, "FIELDS-ANNOTATED").title, "renamed");
});

test("STORY-473: a Story written before the fields with no acceptance still annotates, but must gain one before it moves", async (context) => {
  const fixture = await epic(context);
  // Written as a pre-473 engine wrote a Story whose scope had no Acceptance Criteria block: past
  // today's write path, so only replay judges it.
  await fixture.story("FIELDS-OLD", { goal: "Old goal.", acceptance: "placeholder" });
  await forgeOwnStream(fixture.workspace, (events) => events.map((event) => {
    if (event.payload.operation !== "work.created" || event.payload.record.externalKey !== "FIELDS-OLD") return event;
    const extensions = { "advisory:scope": { required: false, value: "## Goal\nOld goal.\n\n## Requirements\n- no acceptance block" } };
    return { ...event, payload: { ...event.payload, record: { ...event.payload.record, extensions, scopeDigest: canonicalSha256(extensions) } } };
  }));
  const id = idOf("FIELDS-OLD");
  assert.deepEqual((await materializeWorkspace(fixture.workspace)).library.rejectedEvents, [], "the old record replays");
  await annotateWork(fixture.workspace, { occurredAt: at(5), id, summary: "A one-line summary." });
  await assert.rejects(
    () => transitionWork(fixture.workspace, { occurredAt: at(6), id, status: "ready" }),
    (error) => error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "acceptance",
  );
  await assert.rejects(
    () => annotateWork(fixture.workspace, { occurredAt: at(6), id, goal: "A new goal." }),
    (error) => error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "acceptance",
    "an annotation that rewrites the goal must leave an acceptance too",
  );
  await annotateWork(fixture.workspace, { occurredAt: at(7), id, acceptance: "GIVEN the old Story WHEN it gains an acceptance THEN it moves" });
  const moved = await transitionWork(fixture.workspace, { occurredAt: at(8), id, status: "ready" });
  assert.equal(record(moved, "FIELDS-OLD").status, "ready");
});

test("STORY-473 R2: a batch member creates a Story from goal and acceptance, and one with neither is a shape problem", async (context) => {
  const fixture = await epic(context);
  const batch = (members) => applyWorkBatch(fixture.workspace, { schemaVersion: "tcrn.work-batch.v1", members }, { occurredAt: at(5) });
  const state = await batch([
    { verb: "work-create", projectId: fixture.projectId, externalKey: "FIELDS-BATCH", kind: "Story", parentExternalKey: "FIELDS-EPIC", title: "batch",
      goal: "Batched goal.", acceptance: "GIVEN a batch WHEN it lands THEN the Story has both fields" },
    { verb: "work-annotate", externalKey: "FIELDS-BATCH", body: "Batched body." },
  ]);
  assert.deepEqual(storyFields(record(state, "FIELDS-BATCH")).body, "Batched body.");
  await assert.rejects(
    () => batch([{ verb: "work-create", projectId: fixture.projectId, externalKey: "FIELDS-BATCH-2", kind: "Story", parentExternalKey: "FIELDS-EPIC", title: "b", goal: "only a goal" }]),
    (error) => error?.reasonCode === "WORK_BATCH_REFUSED" && JSON.parse(error.message).problems.some((problem) => problem.rule === "story-fields-required"),
  );
});
