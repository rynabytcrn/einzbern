// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-473 R2, AC1, AC2, AC3 at the CLI (TCRN-CROSS-SUB-300): work-create,
// work-annotate and work-batch take a Story's goal, acceptance and body; a Story without either of
// the two is refused naming the field, in process and through the shipped entry; work-show returns
// the three texts and where they come from, mapping an old ten-block scope on the read; and
// work-list says where each record's fields come from and, with --search, matches and excerpts them.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cli, cliProcess, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";
import { LEGACY_FIXTURE_EXPECTED, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const GOAL = "Let a model write a Story its own way. Nothing else is checked.";
const ACCEPTANCE = "GIVEN a Story with a goal and an acceptance WHEN it is created THEN it is accepted";
const TEN_BLOCK_SCOPE = [
  "## Goal", "Keep the old ten blocks readable.",
  "", "## Requirements", "- Map the Goal and Acceptance Criteria blocks.",
  "", "## Acceptance Criteria", "GIVEN a ten-block scope WHEN work-show reads it THEN the goal and acceptance are mapped",
  "", "## Business Background", "Stories written before the fields.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- An old Story read by a new engine.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "Nothing is migrated.",
].join("\n");

const refusedWith = (reasonCode, field) => (error) => error?.reasonCode === reasonCode && (field === undefined || error.details?.field === field);

async function storyTree(context, key) {
  const fixture = await workspaceFixture(context, { externalKey: key });
  const common = ["--workspace", fixture.workspace, "--project-id", fixture.projectId];
  const initiative = await cli(["work-create", ...common, "--at", instant(2), "--external-key", `${key}-INIT`, "--kind", "Initiative", "--title", "initiative"]);
  const epic = await cli(["work-create", ...common, "--at", instant(3), "--external-key", `${key}-EPIC`, "--kind", "Epic", "--parent-id", initiative.record.id, "--title", "epic"]);
  const story = (storyKey, second, ...flags) => cli(["work-create", ...common, "--at", instant(second), "--external-key", storyKey, "--kind", "Story",
    "--parent-id", epic.record.id, "--title", storyKey, ...flags]);
  const version = async () => (await cli(["status", "--workspace", fixture.workspace])).version;
  return { ...fixture, common, initiativeId: initiative.record.id, epicId: epic.record.id, story, version };
}

async function treeBytes(root) {
  const entries = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const files = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    files[path] = (await readFile(path)).toString("base64");
  }
  return files;
}

test("STORY-473 AC1 (CLI): a Story without an acceptance or a goal is refused naming the field, and nothing is written", async (context) => {
  const tree = await storyTree(context, "SF-AC1");
  const before = await tree.version();
  await assert.rejects(tree.story("SF-AC1-NO-ACCEPTANCE", 4, "--goal", GOAL), refusedWith("WORK_STORY_FIELD_REQUIRED", "acceptance"));
  await assert.rejects(tree.story("SF-AC1-NO-GOAL", 4, "--acceptance", ACCEPTANCE), refusedWith("WORK_STORY_FIELD_REQUIRED", "goal"));
  await assert.rejects(tree.story("SF-AC1-NEITHER", 4), refusedWith("WORK_STORY_FIELD_REQUIRED", "goal"));
  // A scope with no Acceptance Criteria block gives no acceptance either.
  await assert.rejects(tree.story("SF-AC1-SCOPE", 4, "--scope", "## Goal\nRecord who decides.\n\n## Requirements\n- anything"),
    refusedWith("WORK_STORY_FIELD_REQUIRED", "acceptance"));
  assert.equal(await tree.version(), before, "no refusal appended an event");
  // The shipped entry prints the field and the remedy beside the code.
  const run = await cliProcess(["work-create", ...tree.common, "--at", instant(4), "--external-key", "SF-AC1-PROCESS", "--kind", "Story",
    "--parent-id", tree.epicId, "--title", "process", "--goal", GOAL]);
  assert.equal(run.status, 1);
  const refusal = JSON.parse(run.stderr);
  assert.equal(refusal.reasonCode, "WORK_STORY_FIELD_REQUIRED");
  assert.equal(refusal.field, "acceptance");
  assert.match(refusal.remedy, /--acceptance/u);
  assert.equal(await tree.version(), before);
});

test("STORY-473 AC2 (CLI): a goal, an acceptance and a two-paragraph body make a Story, and work-show returns them", async (context) => {
  const tree = await storyTree(context, "SF-AC2");
  const body = "First, what changed and why.\n\nSecond, what stays as it was.";
  const created = await tree.story("SF-AC2-STORY", 4, "--goal", GOAL, "--acceptance", ACCEPTANCE, "--body", body);
  assert.equal(created.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(created.record.summary, "Let a model write a Story its own way", "the summary is the first sentence of the goal");
  const shown = await cli(["work-show", "--workspace", tree.workspace, "--id", created.record.id]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.deepEqual(shown.fields, { goal: GOAL, acceptance: ACCEPTANCE, body, source: "fields" });
  // It moves like any other Story.
  const ready = await cli(["work-transition", "--workspace", tree.workspace, "--at", instant(5), "--id", created.record.id, "--status", "ready"]);
  assert.equal(ready.record.status, "ready");
});

test("STORY-473 AC3 (CLI): the ten-block Story of the old-layout fixture reads through work-show with its goal and acceptance, without a byte written", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-story-fields-cli-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root, control } = await restoreLegacyFixture(base);
  const before = await treeBytes(control);
  const shown = await cli(["work-show", "--workspace", root, "--id", LEGACY_FIXTURE_EXPECTED.records.story.id]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.equal(shown.record.kind, "Story");
  assert.equal(shown.fields.source, "scope", "mapped from the scope on this read");
  assert.ok(typeof shown.fields.goal === "string" && shown.fields.goal.length > 0, "the Goal block is the goal");
  assert.ok(typeof shown.fields.acceptance === "string" && shown.fields.acceptance.length > 0, "the Acceptance Criteria block is the acceptance");
  assert.ok(typeof shown.fields.body === "string" && shown.fields.body.includes("## Requirements"), "the other blocks are the body, under their headings");
  assert.ok(shown.advisory.scope.includes(shown.fields.goal), "the scope itself is still returned as written");
  assert.deepEqual(await treeBytes(control), before, "the read left the old layout as it was");
});

test("STORY-473 R2: a --scope alone still makes a Story, read with the goal and acceptance of its blocks", async (context) => {
  const tree = await storyTree(context, "SF-SCOPE");
  const created = await tree.story("SF-SCOPE-STORY", 4, "--scope", TEN_BLOCK_SCOPE);
  const shown = await cli(["work-show", "--workspace", tree.workspace, "--id", created.record.id]);
  assert.equal(shown.fields.source, "scope");
  assert.equal(shown.fields.goal, "Keep the old ten blocks readable.");
  assert.equal(shown.fields.acceptance, "GIVEN a ten-block scope WHEN work-show reads it THEN the goal and acceptance are mapped");
  assert.ok(shown.fields.body.startsWith("## Requirements"));
  assert.equal(shown.advisory.scope, TEN_BLOCK_SCOPE, "the scope is stored byte for byte");
});

test("STORY-473 R2: work-annotate rewrites goal, acceptance and body, and a Story must keep both fields", async (context) => {
  const tree = await storyTree(context, "SF-ANNOTATE");
  const id = (await tree.story("SF-ANNOTATE-STORY", 4, "--goal", "Before.", "--acceptance", "GIVEN before WHEN read THEN before")).record.id;
  const annotate = (second, ...flags) => cli(["work-annotate", "--workspace", tree.workspace, "--at", instant(second), "--id", id, ...flags]);
  await annotate(5, "--body", "Why it moved.");
  await annotate(6, "--goal", "After.", "--acceptance", "GIVEN after WHEN read THEN after");
  const shown = await cli(["work-show", "--workspace", tree.workspace, "--id", id]);
  assert.deepEqual(shown.fields, { goal: "After.", acceptance: "GIVEN after WHEN read THEN after", body: "Why it moved.", source: "fields" });
  const before = await tree.version();
  await assert.rejects(annotate(7, "--acceptance", " "), (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /acceptance/u.test(error.message));
  assert.equal(await tree.version(), before, "a blank acceptance is not written");
  // A field given to a Story written with a scope wins over that block; the others still map.
  const scoped = (await tree.story("SF-ANNOTATE-SCOPED", 8, "--scope", TEN_BLOCK_SCOPE)).record.id;
  await cli(["work-annotate", "--workspace", tree.workspace, "--at", instant(9), "--id", scoped, "--acceptance", "GIVEN the field WHEN read THEN the field wins"]);
  const mixed = await cli(["work-show", "--workspace", tree.workspace, "--id", scoped]);
  assert.equal(mixed.fields.source, "fields");
  assert.equal(mixed.fields.acceptance, "GIVEN the field WHEN read THEN the field wins", "a field wins over its scope block");
  assert.equal(mixed.fields.goal, "Keep the old ten blocks readable.", "the goal it lacks as a field still comes from the scope");
});

test("STORY-473 R2: a work-batch member with a goal and an acceptance creates a Story; one without is refused", async (context) => {
  const tree = await storyTree(context, "SF-BATCH");
  const batchFile = join(tree.base, "batch.json");
  const member = (key, fields) => ({ verb: "work-create", projectId: tree.projectId, externalKey: key, kind: "Story", parentId: tree.epicId, status: "planned", title: key, ...fields });
  await writeFile(batchFile, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: [member("SF-BATCH-STORY", { goal: GOAL, acceptance: ACCEPTANCE, body: "Batched." })] })}\n`);
  await cli(["work-batch", "--workspace", tree.workspace, "--at", instant(4), "--from-file", batchFile]);
  const listed = await cli(["work-list", "--workspace", tree.workspace, "--kind", "Story"]);
  assert.equal(listed.total, 1);
  const shown = await cli(["work-show", "--workspace", tree.workspace, "--external-key", "SF-BATCH-STORY"]);
  assert.deepEqual(shown.fields, { goal: GOAL, acceptance: ACCEPTANCE, body: "Batched.", source: "fields" });
  const before = await tree.version();
  await writeFile(batchFile, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: [member("SF-BATCH-GOAL-ONLY", { goal: GOAL })] })}\n`);
  await assert.rejects(
    cli(["work-batch", "--workspace", tree.workspace, "--at", instant(5), "--from-file", batchFile]),
    (error) => error?.reasonCode === "WORK_BATCH_REFUSED" && JSON.parse(error.message).problems.some((problem) => problem.rule === "story-fields-required"),
  );
  assert.equal(await tree.version(), before);
});

test("STORY-473 R2: work-list says where each record's fields come from, and --search matches and excerpts them", async (context) => {
  const tree = await storyTree(context, "SF-LIST");
  const withFields = (await tree.story("SF-LIST-FIELDS", 4, "--goal", GOAL, "--acceptance", ACCEPTANCE, "--body", "The quokka paragraph.")).record.id;
  const withScope = (await tree.story("SF-LIST-SCOPE", 5, "--scope", TEN_BLOCK_SCOPE)).record.id;
  const ordinary = await cli(["work-list", "--workspace", tree.workspace]);
  const byId = new Map(ordinary.records.map((record) => [record.id, record]));
  assert.deepEqual(byId.get(withFields).fields, { source: "fields" });
  assert.deepEqual(byId.get(withScope).fields, { source: "scope" });
  assert.deepEqual(byId.get(tree.epicId).fields, { source: "none" });
  assert.equal(Object.hasOwn(byId.get(withFields), "scope"), false, "an ordinary listing carries no Story text");
  // The body's word is in no title, summary, key or scope: only the fields can match it.
  const searched = await cli(["work-list", "--workspace", tree.workspace, "--search", "QUOKKA", "--scope-bytes", "8"]);
  assert.equal(searched.total, 1);
  const [found] = searched.records;
  assert.equal(found.id, withFields);
  assert.equal(found.fields.source, "fields");
  for (const name of ["goal", "acceptance", "body"]) {
    assert.ok(Buffer.byteLength(found.fields[name], "utf8") <= 8, `${name} is an excerpt of at most --scope-bytes`);
  }
  assert.equal(found.fields.goal, GOAL.slice(0, 8));
  const scoped = await cli(["work-list", "--workspace", tree.workspace, "--search", "ten blocks readable", "--scope-bytes", "4096"]);
  assert.equal(scoped.total, 1);
  assert.equal(scoped.records[0].fields.goal, "Keep the old ten blocks readable.", "a scope's fields are mapped in a search listing too");
});

test("STORY-473 R2: work-create --help names each of --goal, --acceptance and --body once", async () => {
  const help = await cli(["work-create", "--help"]);
  const names = help.commands[0].flags.map((flag) => flag.name);
  for (const name of ["goal", "acceptance", "body"]) assert.equal(names.filter((entry) => entry === name).length, 1, name);
});
