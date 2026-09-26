// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-475 R1-R3, AC1-AC3 at the CLI (TCRN-CROSS-SUB-307): minutes-record writes a
// decision down in one command and echoes the minutes id with D1..Dn; minutes-list and
// minutes-show read every minutes record, the ones a retired conference close wrote included, in
// a library and in an old-layout workspace alike; decided-in on work-create and work-annotate
// names a minutes id; and no conference verb is left.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const at = (second) => `2026-09-26T14:00:${String(second).padStart(2, "0")}Z`;
const STORY_SCOPE = "## Goal\nKeep the decisions of the minutes CLI on record.\n\n## Acceptance Criteria\nGIVEN recorded minutes WHEN the story names them THEN minutes-show lists the story";
const THREE_DECISIONS = ["Record minutes in one write", "Number the decisions D1 to Dn", "Keep the conference history readable"];

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

const refusedWith = (reasonCode) => (error) => error?.reasonCode === reasonCode;

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-minutes-cli-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, ".ether");
  await cli(["init", "--workspace", workspace, "--project-name", "Minutes CLI", "--at", at(0)]);
  const projectId = (await cli(["project-create", "--workspace", workspace, "--at", at(1), "--external-key", "MC-PROJECT", "--name", "Minutes CLI"])).record.id;
  const initiativeId = (await cli(["work-create", "--workspace", workspace, "--at", at(2), "--project-id", projectId, "--external-key", "MC-INIT", "--kind", "Initiative", "--title", "Minutes initiative"])).record.id;
  const epicId = (await cli(["work-create", "--workspace", workspace, "--at", at(3), "--project-id", projectId, "--external-key", "MC-EPIC", "--kind", "Epic", "--parent-id", initiativeId, "--title", "Minutes epic"])).record.id;
  const storyId = (await cli(["work-create", "--workspace", workspace, "--at", at(4), "--project-id", projectId, "--external-key", "MC-STORY", "--kind", "Story", "--parent-id", epicId, "--scope", STORY_SCOPE, "--title", "Minutes story"])).record.id;
  return { base, workspace, projectId, epicId, storyId };
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

test("STORY-475 AC1: one minutes-record writes once and echoes the minutes id with D1 to D3", async (context) => {
  const fixture = await library(context);
  const before = (await cli(["project-list", "--workspace", fixture.workspace])).version;
  const receipt = await cli([
    "minutes-record", "--workspace", fixture.workspace, "--at", at(5), "--project-id", fixture.projectId, "--external-key", "MC-MIN-007",
    "--title", "Minutes verbs", "--summary", "The minutes verbs replace the conference", "--decisions", THREE_DECISIONS.join(","),
    "--decided-by", "owner:governance", "--work-ids", fixture.storyId,
  ]);
  assert.equal(receipt.reasonCode, "MINUTES_RECORDED");
  assert.equal(receipt.version, before + 1, "one write");
  assert.equal(receipt.id, deriveStableId("minutes", "MC-MIN-007"));
  assert.equal(receipt.externalKey, "MC-MIN-007");
  assert.deepEqual(receipt.decisions, THREE_DECISIONS.map((text, index) => ({ number: index + 1, text })), "D1 to D3 in the order given");
  assert.ok(receipt.ids.includes(receipt.id), "the receipt names what it wrote");

  // minutes-show by id and by key (in any case) answers the same record.
  const shown = await cli(["minutes-show", "--workspace", fixture.workspace, "--id", receipt.id]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.equal(shown.kind, "minutes");
  assert.equal(shown.record.kind, "minutes");
  assert.equal(shown.record.title, "Minutes verbs");
  assert.deepEqual(shown.record.decidedBy, ["owner:governance"]);
  assert.deepEqual(shown.record.linkedWorkIds, [fixture.storyId]);
  assert.deepEqual(shown.record.decisions, receipt.decisions);
  assert.deepEqual(shown.decides, [], "no work record names these minutes as decided-in yet");
  assert.deepEqual((await cli(["minutes-show", "--workspace", fixture.workspace, "--external-key", "mc-min-007"])).record, shown.record);

  // A key-less record takes the next number with the width of the digits kept; --decisions-file
  // carries a decision whose text holds a comma.
  const decisionsFile = join(fixture.base, "decisions.json");
  await writeFile(decisionsFile, JSON.stringify(["Split the verb, then merge the reads"]));
  const next = await cli([
    "minutes-record", "--workspace", fixture.workspace, "--at", at(6), "--project-id", fixture.projectId,
    "--title", "Follow-up", "--summary", "A second record", "--decisions-file", decisionsFile,
  ]);
  assert.equal(next.externalKey, "MC-MIN-008");
  assert.deepEqual(next.decisions, [{ number: 1, text: "Split the verb, then merge the reads" }]);
});

test("STORY-475 R1: minutes-record and minutes-show refuse what they cannot read, and a refusal writes nothing", async (context) => {
  const fixture = await library(context);
  const record = (extra) => cli(["minutes-record", "--workspace", fixture.workspace, "--at", at(5), "--project-id", fixture.projectId, "--title", "t", "--summary", "s", ...extra]);
  const before = (await cli(["project-list", "--workspace", fixture.workspace])).version;
  await assert.rejects(record(["--external-key", "MC-MIN-1"]), refusedWith("CLI_ARGUMENT_MALFORMED"), "no decisions at all");
  const decisionsFile = join(fixture.base, "decisions.json");
  await writeFile(decisionsFile, JSON.stringify(["one"]));
  await assert.rejects(record(["--external-key", "MC-MIN-1", "--decisions", "one", "--decisions-file", decisionsFile]), refusedWith("CLI_ARGUMENT_MALFORMED"), "both decision flags");
  await writeFile(decisionsFile, JSON.stringify({ decisions: ["one"] }));
  await assert.rejects(record(["--external-key", "MC-MIN-1", "--decisions-file", decisionsFile]), refusedWith("CLI_ARGUMENT_MALFORMED"), "a decisions file that is not an array of strings");
  await assert.rejects(record(["--decisions", "one"]), refusedWith("MINUTES_EXTERNAL_KEY_REQUIRED"), "the first minutes of a library name their key");
  await assert.rejects(record(["--external-key", "MC-MIN-1", "--decisions", "one", "--decided-by", "Owner"]), refusedWith("MINUTES_RECORD_INVALID"), "a decider is a protocol id");
  assert.equal((await cli(["project-list", "--workspace", fixture.workspace])).version, before, "nothing was written");

  await assert.rejects(cli(["minutes-show", "--workspace", fixture.workspace]), refusedWith("CLI_ARGUMENT_MALFORMED"));
  await assert.rejects(cli(["minutes-show", "--workspace", fixture.workspace, "--id", "minutes:000000000000000000000000", "--external-key", "MC-MIN-1"]), refusedWith("CLI_ARGUMENT_MALFORMED"));
  await assert.rejects(cli(["minutes-show", "--workspace", fixture.workspace, "--id", "minutes:000000000000000000000000"]), refusedWith("MINUTES_NOT_FOUND"));
});

test("STORY-475 R2: decided-in on work-create names new minutes, and minutes-list and minutes-show read the relation from both ends", async (context) => {
  const fixture = await library(context);
  const linked = await cli(["minutes-record", "--workspace", fixture.workspace, "--at", at(5), "--project-id", fixture.projectId, "--external-key", "MC-MIN-1", "--title", "Linked", "--summary", "s", "--decisions", "one", "--work-ids", fixture.storyId]);
  const deciding = await cli(["minutes-record", "--workspace", fixture.workspace, "--at", at(6), "--project-id", fixture.projectId, "--title", "Deciding", "--summary", "s", "--decisions", "two"]);
  const created = await cli([
    "work-create", "--workspace", fixture.workspace, "--at", at(7), "--project-id", fixture.projectId, "--external-key", "MC-STORY-2", "--kind", "Story",
    "--parent-id", fixture.epicId, "--scope", STORY_SCOPE, "--title", "Decided story", "--decided-in", deciding.id,
  ]);
  assert.equal(created.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  const storyId = created.record.id;
  const story = await cli(["work-show", "--workspace", fixture.workspace, "--id", storyId]);
  assert.deepEqual(story.relations.forward.decidedIn, [deciding.id], "the story names the minutes it was decided in");
  assert.deepEqual((await cli(["minutes-show", "--workspace", fixture.workspace, "--id", deciding.id])).decides, [storyId], "and the minutes read it back");

  const list = await cli(["minutes-list", "--workspace", fixture.workspace]);
  assert.equal(list.reasonCode, "WORKSPACE_LIST_READY");
  assert.equal(list.kind, "minutes");
  assert.deepEqual(list.records.map((entry) => entry.id), [linked.id, deciding.id], "in the order recorded");
  const ids = async (extra) => (await cli(["minutes-list", "--workspace", fixture.workspace, ...extra])).records.map((entry) => entry.id);
  assert.deepEqual(await ids(["--work-id", fixture.storyId]), [linked.id], "--work-id keeps minutes that link the work record");
  assert.deepEqual(await ids(["--work-id", storyId]), [deciding.id], "and minutes the work record names as decided-in");
  assert.deepEqual(await ids(["--project-id", "project:000000000000000000000000"]), []);
  const page = await cli(["minutes-list", "--workspace", fixture.workspace, "--limit", "1", "--offset", "1"]);
  assert.deepEqual([page.total, page.truncated, page.records.map((entry) => entry.id)], [2, false, [deciding.id]]);

  await assert.rejects(
    cli(["work-annotate", "--workspace", fixture.workspace, "--at", at(8), "--id", fixture.storyId, "--decided-in", "MC-MIN-1"]),
    refusedWith("WORKSPACE_INPUT_INVALID"), "decided-in names a minutes id, not a key",
  );
});

test("STORY-475 AC2: the minutes a conference close wrote in an old-layout workspace read through minutes-list and minutes-show, without a byte written", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-minutes-cli-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root, control } = await restoreLegacyFixture(base);
  const before = await treeBytes(control);
  const list = await cli(["minutes-list", "--workspace", root]);
  assert.equal(list.total, 1);
  const [historical] = list.records;
  assert.equal(historical.kind, "conference-minutes");
  assert.equal(historical.externalKey, null, "a conference close never stored its key");
  const shown = await cli(["minutes-show", "--workspace", root, "--id", historical.id]);
  assert.equal(shown.reasonCode, "WORKSPACE_RECORD_READY");
  assert.deepEqual(shown.record, historical);
  assert.ok(shown.record.decisions.length > 0 && shown.record.decisions.every((decision, index) => decision.number === index + 1), "numbered D1 to Dn");
  await assert.rejects(
    cli(["minutes-record", "--workspace", root, "--at", at(9), "--project-id", historical.projectId, "--external-key", "MC-MIN-1", "--title", "t", "--summary", "s", "--decisions", "one"]),
    refusedWith("LEGACY_WORKSPACE_READ_ONLY"), "an old-layout workspace takes no new minutes",
  );
  assert.deepEqual(await treeBytes(control), before, "the reads and the refusal left the old layout as it was");
});

test("STORY-475 AC3, R3: conference-open answers CLI_COMMAND_UNKNOWN, and the catalog has minutes verbs and no conference verb", async () => {
  await assert.rejects(cli(["conference-open", "--workspace", "./unused/.ether"]), refusedWith("CLI_COMMAND_UNKNOWN"));
  const names = COMMAND_CATALOG.map((entry) => entry.name);
  assert.deepEqual(names.filter((name) => name.startsWith("conference-")), []);
  const mutates = Object.fromEntries(COMMAND_CATALOG.filter((entry) => entry.name.startsWith("minutes-")).map((entry) => [entry.name, entry.mutates]));
  assert.deepEqual(mutates, { "minutes-list": false, "minutes-record": true, "minutes-show": false });
});
