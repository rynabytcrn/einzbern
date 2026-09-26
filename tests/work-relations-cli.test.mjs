// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-472 AC1, AC2, AC3, R3, R4 at the CLI (TCRN-CROSS-SUB-298): a new Incident is
// refused with the remedy, relations are flags on work-create and work-annotate, work-show reads
// both directions, and work-list filters by a relation.

import assert from "node:assert/strict";
import test from "node:test";

import { appendHistoricalWorkCreate, cli, cliProcess, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const STORY_SCOPE = [
  "## Goal",
  "为谁:the reader of a defect. 目的锚:STORY-472. 符合性判据:the fix names what it fixes. 判定人:machine-checked lane.",
  "", "## Requirements", "- 实现 relation flags.",
  "", "## Acceptance Criteria", "GIVEN Story A blocked-by B WHEN work-show B THEN blocks A",
  "", "## Business Background", "实测 seventy Incidents in ten days.",
  "", "## Preconditions", "- None.",
  "", "## Assumptions", "- None.",
  "", "## Use Cases & Examples", "- A defect found at acceptance becomes a Story that fixes the original.",
  "", "## Feature Toggle & Setting", "None.",
  "", "## Permissions", "None.",
  "", "## Implementation Notes", "新增 the relation flags.",
].join("\n");

async function storyTree(context) {
  const fixture = await workspaceFixture(context, { externalKey: "REL-CLI" });
  const common = ["--workspace", fixture.workspace, "--project-id", fixture.projectId];
  const initiative = await cli(["work-create", ...common, "--at", instant(2), "--external-key", "REL-CLI-INIT", "--kind", "Initiative", "--title", "initiative"]);
  const epic = await cli(["work-create", ...common, "--at", instant(3), "--external-key", "REL-CLI-EPIC", "--kind", "Epic", "--parent-id", initiative.record.id, "--title", "epic"]);
  const story = (key, second, ...flags) => cli(["work-create", ...common, "--at", instant(second), "--external-key", key, "--kind", "Story",
    "--parent-id", epic.record.id, "--title", key, "--scope", STORY_SCOPE, ...flags]);
  return { ...fixture, common, epicId: epic.record.id, story };
}

test("STORY-472 AC1: work-create --kind Incident is refused with a remedy naming a Story and fixes", async (context) => {
  const fixture = await workspaceFixture(context, { externalKey: "REL-CLI-AC1" });
  for (const kind of ["Incident", "Release"]) {
    await assert.rejects(
      () => cli(["work-create", "--workspace", fixture.workspace, "--at", instant(2), "--project-id", fixture.projectId, "--external-key", `REL-CLI-${kind.toUpperCase()}`, "--kind", kind, "--title", "new"]),
      (error) => error?.reasonCode === "WORK_KIND_RETIRED" && /Story/u.test(error.details?.remedy ?? "") && /fixes/u.test(error.details?.remedy ?? ""),
    );
  }
  // The shipped entry prints the remedy beside the code.
  const run = await cliProcess(["work-create", "--workspace", fixture.workspace, "--at", instant(2), "--project-id", fixture.projectId, "--external-key", "REL-CLI-PROCESS", "--kind", "Incident", "--title", "new"]);
  assert.equal(run.status, 1);
  const refusal = JSON.parse(run.stderr);
  assert.equal(refusal.reasonCode, "WORK_KIND_RETIRED");
  assert.match(refusal.remedy, /--kind Story --fixes/u);
  await assert.rejects(
    () => cli(["work-draft", "--workspace", fixture.workspace, "--kind", "Incident", "--project-id", fixture.projectId]),
    (error) => error?.reasonCode === "WORK_KIND_RETIRED",
    "work-draft offers no skeleton for a retired kind",
  );
  const listed = await cli(["work-list", "--workspace", fixture.workspace, "--kind", "Incident"]);
  assert.equal(listed.total, 0, "work-list still filters by the historical kind");
});

test("STORY-472 AC2: Story A --blocked-by B, and work-show B shows blocks A", async (context) => {
  const tree = await storyTree(context);
  const b = (await tree.story("REL-CLI-B", 4)).record.id;
  const a = (await tree.story("REL-CLI-A", 5, "--blocked-by", b)).record.id;
  const shownB = await cli(["work-show", "--workspace", tree.workspace, "--id", b]);
  assert.deepEqual(shownB.relations.reverse.blocks, [a]);
  assert.deepEqual(shownB.relations.forward.blockedBy, []);
  const shownA = await cli(["work-show", "--workspace", tree.workspace, "--id", a]);
  assert.deepEqual(shownA.relations.forward.blockedBy, [b]);
  assert.equal(shownA.relations.forward.parent, tree.epicId, "parent is the record's parentId");
  assert.deepEqual(shownA.relations.missing, []);
  const blocked = await cli(["work-list", "--workspace", tree.workspace, "--relation", `blocked-by=${b}`]);
  assert.deepEqual(blocked.records.map((record) => record.id), [a]);
  const blockers = await cli(["work-list", "--workspace", tree.workspace, "--relation", `blocks=${a}`]);
  assert.deepEqual(blockers.records.map((record) => record.id), [b]);
});

test("STORY-472 AC3: a historical Incident reads through work-show, and a new Story --fixes it", async (context) => {
  const tree = await storyTree(context);
  const incident = await appendHistoricalWorkCreate(tree.workspace, {
    externalKey: "REL-CLI-INC-389", projectId: tree.projectId, kind: "Incident", status: "done", title: "a historical incident", occurredAt: instant(4),
  });
  const shown = await cli(["work-show", "--workspace", tree.workspace, "--external-key", "REL-CLI-INC-389"]);
  assert.equal(shown.record.kind, "Incident");
  const fix = (await tree.story("REL-CLI-FIX", 5, "--fixes", incident.id, "--decided-in", "minutes:c8953141f2d862c26ff3db46")).record.id;
  const reread = await cli(["work-show", "--workspace", tree.workspace, "--id", incident.id]);
  assert.deepEqual(reread.relations.reverse.fixedBy, [fix]);
  const fixShown = await cli(["work-show", "--workspace", tree.workspace, "--id", fix]);
  assert.deepEqual(fixShown.relations.forward.fixes, [incident.id]);
  assert.deepEqual(fixShown.relations.forward.decidedIn, ["minutes:c8953141f2d862c26ff3db46"]);
  assert.deepEqual(fixShown.advisory.decidedBy, ["minutes:c8953141f2d862c26ff3db46"], "decided-in is written to the decided-by list");

  const fixedBy = await cli(["work-list", "--workspace", tree.workspace, "--relation", `fixed-by=${fix}`]);
  assert.deepEqual(fixedBy.records.map((record) => record.id), [incident.id]);
  const fixes = await cli(["work-list", "--workspace", tree.workspace, "--relation", `fixes=${incident.id}`]);
  assert.deepEqual(fixes.records.map((record) => record.id), [fix]);
  await assert.rejects(
    () => cli(["work-list", "--workspace", tree.workspace, "--relation", `causes=${incident.id}`]),
    (error) => error?.reasonCode === "CLI_ARGUMENT_MALFORMED",
  );
});

test("STORY-472 R3, R4: an annotation replaces a named list, --decided-by is the older name of --decided-in, and a deleted target shows as missing", async (context) => {
  const tree = await storyTree(context);
  const [x, y] = [(await tree.story("REL-CLI-X", 4)).record.id, (await tree.story("REL-CLI-Y", 5)).record.id];
  const z = (await tree.story("REL-CLI-Z", 6, "--implements", x)).record.id;
  await cli(["work-annotate", "--workspace", tree.workspace, "--at", instant(7), "--id", z, "--supersedes", y, "--decided-by", "minutes:c8953141f2d862c26ff3db46"]);
  let shown = await cli(["work-show", "--workspace", tree.workspace, "--id", z]);
  assert.deepEqual(shown.relations.forward.implements, [x], "a list the annotation does not name is kept");
  assert.deepEqual(shown.relations.forward.supersedes, [y]);
  assert.deepEqual(shown.relations.forward.decidedIn, ["minutes:c8953141f2d862c26ff3db46"]);

  await cli(["work-delete", "--workspace", tree.workspace, "--at", instant(8), "--id", y]);
  shown = await cli(["work-show", "--workspace", tree.workspace, "--id", z]);
  assert.deepEqual(shown.relations.missing, [y], "the deleted target is marked missing, not dropped");

  await cli(["work-annotate", "--workspace", tree.workspace, "--at", instant(9), "--id", z, "--supersedes", "-"]);
  shown = await cli(["work-show", "--workspace", tree.workspace, "--id", z]);
  assert.deepEqual(shown.relations.forward.supersedes, [], "an empty list removes the relation");
  assert.deepEqual(shown.relations.missing, []);
  await assert.rejects(
    () => cli(["work-annotate", "--workspace", tree.workspace, "--at", instant(10), "--id", z, "--fixes", z]),
    (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID",
    "a record does not relate to itself",
  );
});

test("STORY-472 R4: work-create --help lists the relation flags", async () => {
  const help = await cli(["work-create", "--help"]);
  const flags = help.commands[0].flags.map((flag) => flag.name);
  for (const flag of ["blocked-by", "implements", "supersedes", "fixes", "decided-in", "decided-by"]) assert.ok(flags.includes(flag), flag);
  const listHelp = await cli(["work-list", "--help"]);
  assert.ok(listHelp.commands[0].flags.some((flag) => flag.name === "relation"));
});
