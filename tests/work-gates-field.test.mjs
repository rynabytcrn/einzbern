// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-525 (MIN-256; TCRN-CROSS-SUB-446): the work field gates. An Initiative, an Epic and
// a Story write, rewrite and clear the gate names they are held to; a name that is not a gate name is
// refused; a Story is bound by its own names and those of its Epic and Initiative (effectiveGates); a
// work-batch member carries them; and a record that never names a gate keeps its bytes.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { effectiveWorkGates, materializeWorkspace, WORK_GATES_KEY, workAncestorIds, workGates } from "../dist/build/packages/core/src/index.js";
import { workGatesShapeProblem } from "../dist/build/packages/core/src/work-gates.js";
import { cli, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const GOAL = "The gates a Story is held to are named on the Story or above it.";
const ACCEPTANCE = "GIVEN an Epic naming a gate WHEN work-show reads its Story THEN effectiveGates holds it";

async function tree(context, key, { initiativeGates, epicGates } = {}) {
  const fixture = await workspaceFixture(context, { externalKey: key });
  const common = ["--workspace", fixture.workspace, "--project-id", fixture.projectId];
  const initiative = await cli(["work-create", ...common, "--at", instant(2), "--external-key", `${key}-INIT`, "--kind", "Initiative", "--title", "initiative",
    ...(initiativeGates === undefined ? [] : ["--gates", initiativeGates])]);
  const epic = await cli(["work-create", ...common, "--at", instant(3), "--external-key", `${key}-EPIC`, "--kind", "Epic", "--parent-id", initiative.record.id, "--title", "epic",
    ...(epicGates === undefined ? [] : ["--gates", epicGates])]);
  const story = (storyKey, second, ...flags) => cli(["work-create", ...common, "--at", instant(second), "--external-key", storyKey, "--kind", "Story",
    "--parent-id", epic.record.id, "--title", storyKey, "--goal", GOAL, "--acceptance", ACCEPTANCE, ...flags]);
  const show = (id) => cli(["work-show", "--workspace", fixture.workspace, "--id", id]);
  const annotate = (id, second, ...flags) => cli(["work-annotate", "--workspace", fixture.workspace, "--at", instant(second), "--id", id, ...flags]);
  return { ...fixture, common, initiativeId: initiative.record.id, epicId: epic.record.id, story, show, annotate };
}

async function libraryText(directory) {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) text += await libraryText(path);
    else if (entry.isFile()) text += await readFile(path, "latin1");
  }
  return text;
}

test("SUB-446: an Initiative, an Epic and a Story write gate names, deduplicated and sorted; a Story's effectiveGates hold its Epic's and Initiative's", async (context) => {
  const fixture = await tree(context, "GATES-FIELD", { initiativeGates: "release-check,lint,lint", epicGates: "epic:suite" });
  const story = (await fixture.story("GATES-FIELD-STORY", 4, "--gates", "story.unit")).record.id;
  const state = await materializeWorkspace(fixture.workspace);
  const record = (id) => state.work.find((entry) => entry.id === id);
  assert.deepEqual(record(fixture.initiativeId).extensions[WORK_GATES_KEY], { required: false, value: ["lint", "release-check"] }, "stored once each, sorted");
  assert.deepEqual(workGates(record(fixture.epicId)), ["epic:suite"]);
  assert.deepEqual(workAncestorIds(state.work, story), [fixture.epicId, fixture.initiativeId], "nearest ancestor first");
  assert.deepEqual(effectiveWorkGates(state, story), ["epic:suite", "lint", "release-check", "story.unit"]);
  assert.deepEqual(effectiveWorkGates(state, fixture.epicId), ["epic:suite", "lint", "release-check"], "an Epic is bound by its Initiative's names too");
  assert.deepEqual(effectiveWorkGates(state, "work:000000000000000000000000"), [], "a record the state does not hold is bound by none");

  const shown = await fixture.show(story);
  assert.deepEqual(shown.fields.gates, ["story.unit"], "work-show reports the record's own names as fields.gates");
  assert.deepEqual(shown.effectiveGates, ["epic:suite", "lint", "release-check", "story.unit"]);
  assert.equal(shown.fields.goal, GOAL, "the Story fields are still there");
  const shownEpic = await fixture.show(fixture.epicId);
  assert.deepEqual(shownEpic.fields.gates, ["epic:suite"]);
  assert.deepEqual(shownEpic.effectiveGates, ["epic:suite", "lint", "release-check"]);
});

test("SUB-446: work-annotate --gates replaces a record's names whole, and --gates - clears them", async (context) => {
  const fixture = await tree(context, "GATES-EDIT", { epicGates: "epic-suite" });
  const story = (await fixture.story("GATES-EDIT-STORY", 4, "--gates", "unit")).record.id;
  await fixture.annotate(story, 5, "--gates", "e2e,unit,e2e");
  let shown = await fixture.show(story);
  assert.deepEqual(shown.fields.gates, ["e2e", "unit"]);
  assert.deepEqual(shown.effectiveGates, ["e2e", "epic-suite", "unit"]);
  await fixture.annotate(story, 6, "--gates", "-");
  shown = await fixture.show(story);
  assert.equal(Object.hasOwn(shown.fields, "gates"), false, "a cleared record carries no gates field");
  assert.deepEqual(shown.effectiveGates, ["epic-suite"], "the Epic's names still bind it");
  const state = await materializeWorkspace(fixture.workspace);
  assert.equal(Object.hasOwn(state.work.find((entry) => entry.id === story).extensions, WORK_GATES_KEY), false, "the extension is removed, not stored empty");

  await fixture.annotate(fixture.epicId, 7, "--gates", "-");
  await fixture.annotate(fixture.initiativeId, 8, "--gates", "init-check");
  shown = await fixture.show(story);
  assert.deepEqual(shown.effectiveGates, ["init-check"], "an Initiative's names reach the Story through the Epic");
  // An annotation naming the same list again moves nothing and is refused, as any empty annotation is.
  await assert.rejects(() => fixture.annotate(fixture.initiativeId, 9, "--gates", "init-check"), (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID");
});

test("SUB-446: a name that is not a gate name is refused on create and on annotate, and a Subtask carries no gate names", async (context) => {
  const fixture = await tree(context, "GATES-BAD");
  for (const bad of ["has space", "a/b", ".dot-first"]) {
    await assert.rejects(() => fixture.story(`GATES-BAD-${bad.length}`, 4, "--gates", bad), (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /gate name/u.test(error.message), `create refuses ${bad}`);
  }
  await assert.rejects(() => fixture.annotate(fixture.epicId, 5, "--gates", "ok,not ok"), (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /gate name/u.test(error.message));
  await assert.rejects(() => fixture.annotate(fixture.epicId, 5, "--gates", "a,,b"), (error) => error?.reasonCode === "CLI_ARGUMENT_MALFORMED", "an empty entry in the list is malformed");
  const story = (await fixture.story("GATES-BAD-STORY", 6)).record.id;
  await assert.rejects(
    () => cli(["work-create", ...fixture.common, "--at", instant(7), "--external-key", "GATES-BAD-SUB", "--kind", "Subtask", "--parent-id", story, "--title", "subtask", "--gates", "unit"]),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /Initiative, an Epic or a Story/u.test(error.message),
  );
  const state = await materializeWorkspace(fixture.workspace);
  assert.equal(state.work.some((entry) => entry.externalKey === "GATES-BAD-SUB"), false, "nothing was written");
});

test("SUB-446: a record that never names a gate keeps its bytes: no advisory:gates anywhere in the library", async (context) => {
  const fixture = await tree(context, "GATES-NONE");
  const story = (await fixture.story("GATES-NONE-STORY", 4)).record.id;
  await fixture.annotate(story, 5, "--title", "renamed");
  const shown = await fixture.show(story);
  assert.deepEqual(Object.keys(shown.fields).sort(), ["acceptance", "body", "goal", "source"], "fields reads as before");
  assert.deepEqual(shown.effectiveGates, []);
  const state = await materializeWorkspace(fixture.workspace);
  for (const record of state.work) assert.equal(Object.hasOwn(record.extensions, WORK_GATES_KEY), false, record.externalKey);
  assert.equal((await libraryText(fixture.workspace)).includes(WORK_GATES_KEY), false, "no event or projection names the key");
  // Creating with an empty list is the same as leaving the flag out.
  await fixture.story("GATES-NONE-EMPTY", 6, "--gates", "-");
  assert.equal((await libraryText(fixture.workspace)).includes(WORK_GATES_KEY), false);
});

test("SUB-446: a work-batch member carries gates on create and on annotate, and a malformed list is named in the shape pass", async (context) => {
  const fixture = await tree(context, "GATES-BATCH", { epicGates: "suite" });
  const document = (members) => JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members });
  const file = join(fixture.base, "batch.json");
  await writeFile(file, document([
    { verb: "work-create", projectId: fixture.projectId, externalKey: "GATES-BATCH-STORY", kind: "Story", parentId: fixture.epicId, title: "batch story", goal: GOAL, acceptance: ACCEPTANCE, gates: ["unit", "lint", "unit"] },
    { verb: "work-annotate", externalKey: "GATES-BATCH-EPIC", gates: ["suite", "e2e"] },
  ]));
  await cli(["work-batch", "--workspace", fixture.workspace, "--at", instant(4), "--from-file", file]);
  const state = await materializeWorkspace(fixture.workspace);
  const story = state.work.find((entry) => entry.externalKey === "GATES-BATCH-STORY");
  assert.deepEqual(workGates(story), ["lint", "unit"]);
  assert.deepEqual(effectiveWorkGates(state, story.id), ["e2e", "lint", "suite", "unit"]);

  await writeFile(file, document([
    { verb: "work-annotate", externalKey: "GATES-BATCH-EPIC", gates: "suite" },
    { verb: "work-annotate", externalKey: "GATES-BATCH-EPIC", gates: [] },
  ]));
  await assert.rejects(
    () => cli(["work-batch", "--workspace", fixture.workspace, "--at", instant(5), "--from-file", file]),
    (error) => error?.reasonCode === "WORK_BATCH_REFUSED" && /"rule":"gates-shape"/u.test(String(error.message)) && !/advisory-required/u.test(String(error.message)),
    "a gates value that is not a list is the member's shape problem",
  );
  await writeFile(file, document([{ verb: "work-annotate", externalKey: "GATES-BATCH-EPIC", gates: [] }]));
  await cli(["work-batch", "--workspace", fixture.workspace, "--at", instant(6), "--from-file", file]);
  const cleared = await materializeWorkspace(fixture.workspace);
  assert.deepEqual(workGates(cleared.work.find((entry) => entry.id === fixture.epicId)), [], "an annotation member with gates alone clears them");
});

test("SUB-446: replay checks the stored shape: a non-empty list of gate names, sorted without repeats", () => {
  assert.equal(workGatesShapeProblem(["a", "b"]), null);
  for (const bad of [[], ["b", "a"], ["a", "a"], ["bad name"], "a", null, [1]]) {
    assert.notEqual(workGatesShapeProblem(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(workGates({ extensions: { [WORK_GATES_KEY]: { required: false, value: ["b", "a"] } } }), [], "a malformed stored list binds nothing");
});
