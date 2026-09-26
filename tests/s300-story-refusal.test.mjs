// SPDX-License-Identifier: Apache-2.0
//
// STORY-300, Wave 1.4. A refusal names the remedy.
//
// The ten-block Story validator this file used to hold to that rule is gone
// (TCRN-CROSS-STORY-473 R1, MIN-227 D8), and with it the block roster, the four purpose anchors
// and the two token checks a refusal had to spell out. What the engine asks of a Story now is a
// goal and an acceptance, as fields or mapped from the blocks of a scope. The rule this file
// exists for is unchanged: a Story refused for what it lacks is told which field that is and how
// to supply it, structurally (details.field) as well as in the message.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProject, createWork, initializeLibrary, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-09-26T09:00:${String(second).padStart(2, "0")}Z`;

async function epic(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-story-refusal-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const project = (await createProject(workspace, { occurredAt: at(1), externalKey: "REFUSAL-PROJECT", name: "Refusal" })).projects[0].id;
  await createWork(workspace, { occurredAt: at(2), projectId: project, externalKey: "REFUSAL-INIT", kind: "Initiative", parentId: null, title: "init" });
  await createWork(workspace, { occurredAt: at(3), projectId: project, externalKey: "REFUSAL-EPIC", kind: "Epic", parentId: deriveStableId("work", "REFUSAL-INIT"), title: "epic" });
  const story = (key, fields) => createWork(workspace, {
    occurredAt: at(4), projectId: project, externalKey: key, kind: "Story", parentId: deriveStableId("work", "REFUSAL-EPIC"), title: key, ...fields,
  });
  return { workspace, story };
}

// Red leg: drop details.field and a caller can only learn the missing field by parsing prose.
test("STORY-300, STORY-473: a Story without an acceptance is told the field and both ways to supply it", async (context) => {
  const fixture = await epic(context);
  const before = (await materializeWorkspace(fixture.workspace)).version;
  await assert.rejects(
    () => fixture.story("REFUSAL-NO-ACCEPTANCE", { goal: "Make the refusal actionable." }),
    (error) => error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "acceptance" &&
      /--acceptance/u.test(error.message) && /Acceptance Criteria/u.test(error.message) && /--acceptance/u.test(error.details?.remedy ?? ""),
  );
  await assert.rejects(
    () => fixture.story("REFUSAL-SCOPE-NO-ACCEPTANCE", { scope: "## Goal\nMake the refusal actionable.\n\n## Requirements\n- anything" }),
    (error) => error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "acceptance",
    "a scope without an Acceptance Criteria block maps to no acceptance",
  );
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before, "a refusal writes nothing");
});

test("STORY-300, STORY-473: a Story without a goal is told the goal field", async (context) => {
  const fixture = await epic(context);
  await assert.rejects(
    () => fixture.story("REFUSAL-NO-GOAL", { acceptance: "GIVEN a Story WHEN it lacks a goal THEN it is refused" }),
    (error) => error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "goal" && /--goal/u.test(error.message),
  );
  await assert.rejects(
    () => fixture.story("REFUSAL-NOTHING", {}),
    (error) => error?.reasonCode === "WORK_STORY_FIELD_REQUIRED" && error.details?.field === "goal",
    "a Story with neither is told the first field it lacks",
  );
});

// The contract is smaller, not looser about what it keeps: the ten blocks are not required any
// more, and a Story with a goal and an acceptance and nothing else is accepted.
test("STORY-473: neither the ten blocks nor their anchors are asked for any more", async (context) => {
  const fixture = await epic(context);
  const state = await fixture.story("REFUSAL-MINIMAL", { scope: "## Goal\nOne line.\n\n## Acceptance Criteria\nit should work" });
  assert.equal(state.work.find((record) => record.externalKey === "REFUSAL-MINIMAL")?.kind, "Story");
});
