// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-426 (TCRN-CROSS-STORY-514 AC4, AC5, AC7; MIN-239 D3, D5, D6): a decision is valid or
// obsolete, one decision at a time, numbered minutes:<id>#D<n> -- the historical minutes' decisions
// too. minutes-record declares in the same write what it supersedes (and by which decision), what it
// withdraws and what it stands beside; a decision close in topic to a valid one it leaves unsettled is
// refused with the candidates named. Obsolete is final. The reads and recall give the valid decisions
// unless asked, an obsolete decision is read with the decision that superseded it, and work-show and
// recall say when a record points at an obsolete decision. Replay checks every declaration, and two
// devices that supersede the same decision leave one supersession and one rejected event.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeKnowledgeStore, materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { promptRecallContext } from "../dist/build/packages/core/src/hook-recall.js";
import {
  DECISION_TOPIC_SHARED_TOKENS,
  DECISION_TOPIC_THRESHOLD,
  decisionAddress,
  decisionLedger,
  decisionTopicConflicts,
  parseDecisionAddress,
  validateMinutesRecord,
} from "../dist/build/packages/core/src/minutes.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { forgeOwnStream } from "./helpers/library-forge.mjs";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const at = (second) => `2026-09-29T10:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const minutesId = (key) => deriveStableId("minutes", key);
const address = (key, number) => decisionAddress(minutesId(key), number);
const OWNER = deriveStableId("owner", "DECISION-LIFECYCLE-OWNER");
const STORY_SCOPE = "## Goal\nKeep the zebrafish tank decisions on record.\n\n## Acceptance Criteria\nGIVEN the tank WHEN it is decided THEN the Story names the minutes";

// The decisions the tests record. The otter archive ones are close in topic to each other; the rest
// share no three words with anything.
const EAST = "Store the otter archive on the east shelf.";
const WEST = "Store the otter archive on the west shelf.";
const PELICAN = "Feed the pelican at noon.";
const MOVE = "Move the otter archive to the west shelf beside the ledger.";

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

const refusal = (args) => runCli(args, { write() {} }).then(() => null, (error) => error);

async function library(context, name = "decision-lifecycle") {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-${name}-`)));
  context.after(async () => { resetRecallCache(); await rm(base, { recursive: true, force: true }); });
  const workspace = join(base, "project", ".ether");
  await cli(["init", "--workspace", workspace, "--project-name", "Decision lifecycle", "--at", at(0)]);
  const projectId = (await cli(["project-create", "--workspace", workspace, "--at", at(1), "--external-key", "DL-PROJECT", "--name", "Decision lifecycle"])).record.id;
  const initiativeId = (await cli(["work-create", "--workspace", workspace, "--at", at(2), "--project-id", projectId, "--external-key", "DL-INIT", "--kind", "Initiative", "--title", "Aquarium initiative"])).record.id;
  const epicId = (await cli(["work-create", "--workspace", workspace, "--at", at(3), "--project-id", projectId, "--external-key", "DL-EPIC", "--kind", "Epic", "--parent-id", initiativeId, "--title", "Aquarium epic"])).record.id;
  const record = (second, key, decisions, extra = []) => cli([
    "minutes-record", "--workspace", workspace, "--at", at(second), "--project-id", projectId, "--external-key", key,
    "--title", `Minutes ${key}`, "--summary", `Recorded as ${key}.`, "--decisions", decisions.join(","), ...extra,
  ]);
  return { base, workspace, projectId, epicId, record };
}

async function version(workspace) {
  return (await cli(["project-list", "--workspace", workspace])).version;
}

test("SUB-426 R2: a decision's number is minutes:<id>#D<n>, and a record's shape is checked on its own", () => {
  const id = minutesId("DL-MIN-1");
  assert.equal(decisionAddress(id, 3), `${id}#D3`);
  assert.deepEqual(parseDecisionAddress(`${id}#D12`), { minutesId: id, number: 12 });
  for (const value of [`${id}#D0`, `${id} D1`, `${id}#d1`, "work:000000000000000000000000#D1", `${id}#D1000`, 12]) {
    assert.equal(parseDecisionAddress(value), null, String(value));
  }
  const base = {
    schemaVersion: "einzbern.minutes.v1", id, externalKey: "DL-MIN-1", projectId: "project:000000000000000000000001",
    title: "t", summary: "s", decisions: ["one", "two"], decidedBy: [], linkedWorkIds: [], recordedAt: at(1), revision: 1, tombstone: false,
  };
  const other = minutesId("DL-MIN-0");
  const declared = (declarations) => ({ ...base, declarations: { supersedes: [], withdraws: [], coexists: [], ...declarations } });
  assert.deepEqual(validateMinutesRecord(base), base, "a record that declares nothing leaves the field out");
  const valid = declared({ supersedes: [{ decision: `${other}#D1`, by: `${id}#D2` }], withdraws: [`${other}#D2`] });
  assert.deepEqual(validateMinutesRecord(valid).declarations, valid.declarations);
  const refused = [
    declared({}),
    declared({ supersedes: [{ decision: `${id}#D1`, by: `${id}#D2` }] }),
    declared({ supersedes: [{ decision: `${other}#D1`, by: `${id}#D3` }] }),
    declared({ supersedes: [{ decision: `${other}#D1`, by: `${other}#D2` }], withdraws: [`${other}#D2`] }),
    declared({ supersedes: [{ decision: `${other}#D1`, by: `${id}#D1` }], withdraws: [`${other}#D1`] }),
    declared({ withdraws: [`${other}#D2`, `${other}#D1`] }),
    declared({ coexists: [`${other}#D1`], withdraws: [`${other}#D1`] }),
    declared({ coexists: [`${id}#D1`] }),
    declared({ withdraws: ["minutes:x#D1 "] }),
    { ...declared({ withdraws: [`${other}#D1`] }), declarations: { withdraws: [`${other}#D1`], supersedes: [] } },
  ];
  for (const record of refused) {
    assert.throws(() => validateMinutesRecord(record), (error) => error?.reasonCode === "MINUTES_RECORD_INVALID", JSON.stringify(record.declarations));
  }
});

test("STORY-514 AC4: minutes that supersede a valid decision make it obsolete both ways, and the reads give it only when asked, with its successor", async (context) => {
  const fx = await library(context);
  const first = await fx.record(10, "DL-MIN-1", [EAST]);
  assert.equal(first.declarations, undefined, "a record that declares nothing answers as it always did");
  assert.deepEqual(first.decisions, [{ number: 1, text: EAST }]);
  const second = await fx.record(11, "DL-MIN-2", [WEST, PELICAN], ["--supersedes", "DL-MIN-1#D1=D1"]);
  assert.equal(second.reasonCode, "MINUTES_RECORDED");
  assert.deepEqual(second.declarations, { supersedes: [{ decision: address("DL-MIN-1", 1), by: address("DL-MIN-2", 1) }], withdraws: [], coexists: [] });
  assert.deepEqual(second.decisions, [{ number: 1, text: WEST, supersedes: [address("DL-MIN-1", 1)] }, { number: 2, text: PELICAN }]);

  // Default reads: the obsolete decision is gone, and so is a record with no valid decision left.
  const listed = await cli(["minutes-list", "--workspace", fx.workspace]);
  assert.deepEqual(listed.records.map((entry) => entry.id), [second.id]);
  const shownFirst = await cli(["minutes-show", "--workspace", fx.workspace, "--id", first.id]);
  assert.deepEqual([shownFirst.record.decisions, shownFirst.record.withheldDecisions], [[], [1]], "the record reads with its obsolete decision withheld");

  // Explicit reads: the obsolete decision, with the decision that superseded it and the minutes that said so.
  const obsolete = await cli(["minutes-list", "--workspace", fx.workspace, "--status", "obsolete"]);
  assert.deepEqual(obsolete.records.map((entry) => entry.id), [first.id]);
  const expectedObsolete = {
    number: 1, text: EAST, status: "obsolete",
    supersededBy: { decision: address("DL-MIN-2", 1), text: WEST, status: "valid" },
    declaredIn: second.id,
  };
  assert.deepEqual(obsolete.records[0].decisions, [expectedObsolete]);
  const all = await cli(["minutes-list", "--workspace", fx.workspace, "--status", "all"]);
  assert.deepEqual(all.records.map((entry) => [entry.id, entry.decisions.map((decision) => decision.status)]), [[first.id, ["obsolete"]], [second.id, ["valid", "valid"]]]);
  assert.deepEqual(all.records[1].decisions[0].supersedes, [address("DL-MIN-1", 1)], "the successor names what it superseded");
  for (const reference of [["--id", address("DL-MIN-1", 1)], ["--external-key", "dl-min-1#D1"]]) {
    const named = await cli(["minutes-show", "--workspace", fx.workspace, ...reference]);
    assert.equal(named.decision, address("DL-MIN-1", 1));
    assert.deepEqual(named.record.decisions, [expectedObsolete], `a decision fetched by its number comes with its successor (${reference[0]})`);
  }
  assert.equal((await refusal(["minutes-show", "--workspace", fx.workspace, "--id", address("DL-MIN-1", 1), "--status", "all"]))?.reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await refusal(["minutes-list", "--workspace", fx.workspace, "--status", "removed"]))?.reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await refusal(["minutes-show", "--workspace", fx.workspace, "--id", address("DL-MIN-1", 2)]))?.reasonCode, "MINUTES_NOT_FOUND");

  // Recall indexes the valid decision alone: the obsolete words find nothing of the first record.
  const recalled = await cli(["recall", "--workspace", fx.workspace, "--at", at(12), "--query", "east shelf otter archive", "--tau", "0"]);
  assert.equal(recalled.records.some((hit) => hit.id === first.id), false, "the first record has no valid decision to index");
  assert.ok(recalled.records.some((hit) => hit.id === second.id));
  assert.equal(recalled.context.some((line) => line.includes("east")), false);

  const validated = await cli(["chain-validate", "--workspace", fx.workspace]);
  assert.equal(validated.reasonCode, "CHAIN_VALIDATED");
  assert.deepEqual(await materializeWorkspaceFromGenesis(fx.workspace), await materializeWorkspace(fx.workspace), "replay and the cached read agree");
});

test("STORY-514 AC5: a decision close in topic to a valid one is refused naming it, until the record supersedes, withdraws or stands beside it", async (context) => {
  const fx = await library(context);
  await fx.record(10, "DL-MIN-1", [EAST]);
  await fx.record(11, "DL-MIN-2", [WEST, PELICAN], ["--supersedes", "DL-MIN-1#D1=D1"]);
  const before = await version(fx.workspace);
  const refused = await refusal(["minutes-record", "--workspace", fx.workspace, "--at", at(12), "--project-id", fx.projectId, "--external-key", "DL-MIN-3",
    "--title", "Move", "--summary", "Moving the archive.", "--decisions", MOVE]);
  assert.equal(refused?.reasonCode, "MINUTES_POSSIBLE_CONFLICT");
  assert.deepEqual(refused.details.conflicts, [address("DL-MIN-2", 1)], "the valid decision is named; the obsolete one is not a candidate");
  assert.match(refused.details.remedy, /--supersedes/u);
  assert.match(refused.message, /D1 ~ /u);
  assert.equal(await version(fx.workspace), before, "a refused record writes nothing");

  const coexisting = await fx.record(13, "DL-MIN-3", [MOVE], ["--coexists", address("DL-MIN-2", 1)]);
  assert.deepEqual(coexisting.declarations, { supersedes: [], withdraws: [], coexists: [address("DL-MIN-2", 1)] });
  const shown = await cli(["minutes-show", "--workspace", fx.workspace, "--id", coexisting.id, "--status", "all"]);
  assert.deepEqual(shown.record.decisions.map((decision) => decision.status), ["valid"]);
  assert.equal((await cli(["minutes-show", "--workspace", fx.workspace, "--id", minutesId("DL-MIN-2")])).record.decisions.length, 2, "standing beside leaves both valid");

  // The rule the refusal applies, at the core: identical decisions are close; one shared word is not.
  const state = await materializeWorkspace(fx.workspace);
  const probe = (decisions) => decisionTopicConflicts(state, { id: minutesId("DL-PROBE"), projectId: fx.projectId, decisions });
  assert.ok(probe([PELICAN]).some((entry) => entry.decision === address("DL-MIN-2", 2) && entry.score >= DECISION_TOPIC_THRESHOLD));
  assert.deepEqual(probe(["Paint the heron gate."]), []);
  assert.ok(DECISION_TOPIC_SHARED_TOKENS >= 3);
});

test("SUB-426: minutes withdraw a decision, or declare an existing decision its successor, as the cleanup of old decisions needs", async (context) => {
  const fx = await library(context);
  await fx.record(10, "DL-MIN-1", [EAST]);
  await fx.record(11, "DL-MIN-2", [WEST, PELICAN], ["--supersedes", "DL-MIN-1#D1=D1"]);
  await fx.record(12, "DL-MIN-3", [MOVE], ["--coexists", address("DL-MIN-2", 1)]);
  const cleanup = await fx.record(13, "DL-MIN-4", ["Settle the heron ledger."], [
    "--withdraws", "DL-MIN-2#D2", "--supersedes", `${address("DL-MIN-3", 1)}=DL-MIN-2#D1`,
  ]);
  assert.deepEqual(cleanup.declarations, {
    supersedes: [{ decision: address("DL-MIN-3", 1), by: address("DL-MIN-2", 1) }],
    withdraws: [address("DL-MIN-2", 2)],
    coexists: [],
  });
  const ledger = decisionLedger(await materializeWorkspace(fx.workspace));
  const state = (key, number) => ledger.decisions.get(address(key, number));
  assert.deepEqual([state("DL-MIN-2", 2).status, state("DL-MIN-2", 2).supersededBy, state("DL-MIN-2", 2).declaredIn], ["obsolete", null, minutesId("DL-MIN-4")], "withdrawn: obsolete with no successor");
  assert.deepEqual([state("DL-MIN-3", 1).status, state("DL-MIN-3", 1).supersededBy], ["obsolete", address("DL-MIN-2", 1)]);
  assert.deepEqual(state("DL-MIN-2", 1).supersedes, [address("DL-MIN-1", 1), address("DL-MIN-3", 1)].sort(), "an existing decision records every decision it now supersedes");

  const withdrawn = await cli(["minutes-show", "--workspace", fx.workspace, "--id", address("DL-MIN-2", 2)]);
  assert.deepEqual(withdrawn.record.decisions, [{ number: 2, text: PELICAN, status: "obsolete", supersededBy: null, declaredIn: minutesId("DL-MIN-4") }]);
  const listed = await cli(["minutes-list", "--workspace", fx.workspace]);
  assert.deepEqual(listed.records.map((entry) => [entry.externalKey, entry.decisions.map((decision) => decision.number), entry.withheldDecisions ?? []]), [
    ["DL-MIN-2", [1], [2]],
    ["DL-MIN-4", [1], []],
  ]);
  assert.equal((await cli(["chain-validate", "--workspace", fx.workspace])).reasonCode, "CHAIN_VALIDATED");
});

test("SUB-426: obsolete is final, and a declaration that names nothing, its own record or another project is refused with nothing written", async (context) => {
  const fx = await library(context);
  await fx.record(10, "DL-MIN-1", [EAST]);
  await fx.record(11, "DL-MIN-2", [WEST], ["--supersedes", "DL-MIN-1#D1=D1"]);
  const otherProject = (await cli(["project-create", "--workspace", fx.workspace, "--at", at(12), "--external-key", "DL-OTHER", "--name", "Other"])).record.id;
  await cli(["minutes-record", "--workspace", fx.workspace, "--at", at(13), "--project-id", otherProject, "--external-key", "DL-OTHER-MIN-1",
    "--title", "Other", "--summary", "Another project.", "--decisions", "Paint the heron gate."]);
  const before = await version(fx.workspace);
  const attempt = (extra) => refusal(["minutes-record", "--workspace", fx.workspace, "--at", at(14), "--project-id", fx.projectId, "--external-key", "DL-MIN-9",
    "--title", "t", "--summary", "s", "--decisions", "Count the quokka burrows.", ...extra]);
  const cases = [
    [["--supersedes", "DL-MIN-1#D1=D1"], "MINUTES_DECISION_OBSOLETE", "an obsolete decision is final"],
    [["--withdraws", "DL-MIN-1#D1"], "MINUTES_DECISION_OBSOLETE", "and cannot be withdrawn again"],
    [["--supersedes", "DL-MIN-2#D1=DL-MIN-1#D1"], "MINUTES_DECISION_OBSOLETE", "an obsolete decision supersedes nothing"],
    [["--coexists", "DL-MIN-1#D1"], "MINUTES_DECISION_OBSOLETE", "and nothing stands beside it"],
    [["--withdraws", "DL-MIN-2#D2"], "MINUTES_NOT_FOUND", "a decision the record does not have"],
    [["--withdraws", "DL-MIN-8#D1"], "MINUTES_NOT_FOUND", "minutes the library does not hold"],
    [["--withdraws", "DL-OTHER-MIN-1#D1"], "MINUTES_RECORD_INVALID", "a decision of another project"],
    [["--withdraws", "D1"], "MINUTES_RECORD_INVALID", "the record's own decision"],
    [["--supersedes", "DL-MIN-2#D1=D2"], "MINUTES_RECORD_INVALID", "a successor the record does not have"],
    [["--supersedes", "DL-MIN-2#D1=D1", "--withdraws", "DL-MIN-2#D1"], "MINUTES_RECORD_INVALID", "two fates for one decision"],
    [["--supersedes", "otter=D1"], "MINUTES_RECORD_INVALID", "not a decision number"],
    [["--supersedes", "DL-MIN-2#D1"], "CLI_ARGUMENT_MALFORMED", "a supersession names its successor"],
    [["--supersedes", "DL-MIN-2#D1=D1=D1"], "CLI_ARGUMENT_MALFORMED", "and only one"],
  ];
  for (const [extra, reasonCode, why] of cases) {
    assert.equal((await attempt(extra))?.reasonCode, reasonCode, why);
  }
  assert.equal(await version(fx.workspace), before, "nothing was written");
});

test("STORY-514 AC7: work-show and recall say which decision replaced the obsolete one a record points at", async (context) => {
  const fx = await library(context);
  const first = await fx.record(10, "DL-MIN-1", [EAST]);
  const story = (await cli(["work-create", "--workspace", fx.workspace, "--at", at(11), "--project-id", fx.projectId, "--external-key", "DL-STORY",
    "--kind", "Story", "--parent-id", fx.epicId, "--scope", STORY_SCOPE, "--title", "Zebrafish tank", "--decided-in", first.id])).record;
  const before = await cli(["work-show", "--workspace", fx.workspace, "--id", story.id]);
  assert.equal(Object.hasOwn(before, "obsoleteDecisions"), false, "nothing to say while the decision is valid");

  await initializeKnowledgeStore(fx.workspace, { disposableAcknowledged: true });
  const card = await cli(["knowledge-create", "--workspace", fx.workspace, "--at", at(12), "--external-key", "DL-CARD", "--scope", "workspace", "--project-id", "-",
    "--role-scopes", "-", "--category", "workflow", "--kind", "fact", "--tags", "lesson", "--subject", "Quokka handling notes",
    "--summary", "How the quokka is handled, as DL-MIN-1 D1 set the shelf", "--snippet", "handle the quokka gently",
    "--accountable-owner-id", OWNER, "--source-references", "-", "--retrieval", "default", "--freshness", "fresh", "--last-verified", "-", "--stale-days", "-",
    "--export", "metadata-only", "--body", "Handle the quokka gently."]);
  assert.equal(card.reasonCode, "KNOWLEDGE_UNIT_CREATED");

  const second = await fx.record(13, "DL-MIN-2", [WEST], ["--supersedes", "DL-MIN-1#D1=D1"]);
  const hint = [{ decision: address("DL-MIN-1", 1), supersededBy: address("DL-MIN-2", 1) }];
  const shown = await cli(["work-show", "--workspace", fx.workspace, "--id", story.id]);
  assert.deepEqual(shown.obsoleteDecisions, hint);
  assert.deepEqual(shown.relations.forward.decidedIn, [first.id], "the stored relation is untouched");

  const recalledStory = await cli(["recall", "--workspace", fx.workspace, "--at", at(14), "--query", "zebrafish tank", "--tau", "0"]);
  const storyHit = recalledStory.records.find((hit) => hit.id === story.id);
  assert.deepEqual(storyHit?.obsoleteDecisions, hint);
  assert.ok(storyHit.line.includes(`过时决策 ${address("DL-MIN-1", 1)}→${address("DL-MIN-2", 1)}`), storyHit.line);
  assert.ok(recalledStory.context.some((line) => line.includes("过时决策")));
  const recalledCard = await cli(["recall", "--workspace", fx.workspace, "--at", at(15), "--query", "quokka handling", "--tau", "0"]);
  const cardHit = recalledCard.records.find((hit) => hit.id === card.id);
  assert.deepEqual(cardHit?.obsoleteDecisions, hint, "a card naming the decision is told what replaced it");
  assert.ok(cardHit.line.includes("过时决策"), cardHit.line);
  const recalledMinutes = await cli(["recall", "--workspace", fx.workspace, "--at", at(16), "--query", "west shelf otter archive", "--tau", "0"]);
  const minutesHit = recalledMinutes.records.find((hit) => hit.id === second.id);
  assert.ok(minutesHit !== undefined, JSON.stringify(recalledMinutes.records));
  assert.equal(Object.hasOwn(minutesHit, "obsoleteDecisions"), false, "a minutes hit carries its valid decisions and no hint");
});

test("MIN-239 D6: the prompt hook recalls valid decisions only and says what replaced an obsolete one", async (context) => {
  const fx = await library(context, "decision-hook");
  const directory = join(fx.base, "project");
  const git = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  await registerLibrary({ projectPath: directory, libraryPath: fx.workspace, registeredAt: at(4) });
  const first = await fx.record(10, "DL-MIN-1", [EAST]);
  await cli(["work-create", "--workspace", fx.workspace, "--at", at(11), "--project-id", fx.projectId, "--external-key", "DL-STORY",
    "--kind", "Story", "--parent-id", fx.epicId, "--scope", STORY_SCOPE, "--title", "Zebrafish tank", "--decided-in", first.id]);
  // A small library lowers the strong-hit threshold the way the recall tests' small libraries do.
  await setWorkspaceSetting(fx.workspace, { occurredAt: at(12), key: "retrieval.tau", value: "0" });
  const ask = (prompt, second) => promptRecallContext({ libraryPath: fx.workspace, prompt, host: "claude-code", cwd: directory, at: at(second) });
  const beforeLines = (await ask("east shelf otter archive", 13))?.lines ?? [];
  assert.ok(beforeLines.some((line) => line.includes("DL-MIN-1")), JSON.stringify(beforeLines));

  await fx.record(14, "DL-MIN-2", [WEST], ["--supersedes", "DL-MIN-1#D1=D1"]);
  const afterLines = (await ask("east shelf otter archive", 15))?.lines ?? [];
  assert.equal(afterLines.some((line) => line.includes("[纪要 DL-MIN-1]")), false, JSON.stringify(afterLines));
  const storyLines = (await ask("zebrafish tank", 16))?.lines ?? [];
  assert.ok(storyLines.some((line) => line.includes(`过时决策 ${address("DL-MIN-1", 1)}→${address("DL-MIN-2", 1)}`)), JSON.stringify(storyLines));
});

test("SUB-426: the historical minutes' decisions are numbered and can be superseded by new minutes", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-decision-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root } = await restoreLegacyFixture(base, "legacy");
  const legacy = (await cli(["minutes-list", "--workspace", root])).records[0];
  assert.equal(legacy.kind, "conference-minutes");
  const historical = decisionAddress(legacy.id, 1);
  const read = await cli(["minutes-show", "--workspace", root, "--id", historical]);
  assert.deepEqual(read.record.decisions, [{ number: 1, text: legacy.decisions[0].text, status: "valid" }], "an old-layout read numbers the historical decision");

  const target = join(base, ".ether");
  await cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", at(1)]);
  const superseding = await cli(["minutes-record", "--workspace", target, "--at", at(2), "--project-id", legacy.projectId, "--external-key", "DL-LEGACY-MIN-1",
    "--title", "Replace the historical decision", "--summary", "The historical decision is replaced.", "--decisions", "Count the quokka burrows.",
    "--supersedes", `${historical}=D1`, "--actor", "agent:claude-opus-5-5"]);
  assert.deepEqual(superseding.declarations.supersedes, [{ decision: historical, by: address("DL-LEGACY-MIN-1", 1) }]);
  const shown = await cli(["minutes-show", "--workspace", target, "--id", historical]);
  assert.deepEqual([shown.record.decisions[0].status, shown.record.decisions[0].supersededBy.decision], ["obsolete", address("DL-LEGACY-MIN-1", 1)]);
  assert.equal(shown.record.kind, "conference-minutes", "the historical record keeps its kind and bytes");
  assert.equal((await cli(["chain-validate", "--workspace", target])).reasonCode, "CHAIN_VALIDATED");
});

test("SUB-426 replay: a record that supersedes an obsolete decision is corrupt, and a library reading it rejects that event", async (context) => {
  const fx = await library(context);
  await fx.record(10, "DL-MIN-1", [EAST]);
  await fx.record(11, "DL-MIN-2", [WEST], ["--supersedes", "DL-MIN-1#D1=D1"]);
  await fx.record(12, "DL-MIN-3", ["Count the quokka burrows."]);
  // Forge the third record into a second supersession of the obsolete decision: the stream stays whole, the rule breaks.
  await forgeOwnStream(fx.workspace, (events) => events.map((event) => event.payload.operation === "minutes.recorded" && event.payload.record.externalKey === "DL-MIN-3"
    ? { ...event, payload: { ...event.payload, record: { ...event.payload.record, declarations: { supersedes: [{ decision: address("DL-MIN-1", 1), by: address("DL-MIN-3", 1) }], withdraws: [], coexists: [] } } } }
    : event));
  const state = await materializeWorkspace(fx.workspace);
  assert.equal(state.library.rejectedEvents.length, 1);
  assert.equal(state.library.rejectedEvents[0].reasonCode, "WORKSPACE_EVENT_CORRUPT");
  assert.match(state.library.rejectedEvents[0].detail, /MINUTES_DECISION_OBSOLETE/u);
  assert.deepEqual(state.minutes.map((entry) => entry.externalKey).sort(), ["DL-MIN-1", "DL-MIN-2"]);
  assert.equal(decisionLedger(state).decisions.get(address("DL-MIN-1", 1)).supersededBy, address("DL-MIN-2", 1), "the first supersession stands");

  // A declaration naming a decision the library does not hold is corrupt the same way.
  await forgeOwnStream(fx.workspace, (events) => events.map((event) => event.payload.operation === "minutes.recorded" && event.payload.record.externalKey === "DL-MIN-3"
    ? { ...event, payload: { ...event.payload, record: { ...event.payload.record, declarations: { supersedes: [], withdraws: [address("DL-MIN-2", 5)], coexists: [] } } } }
    : event));
  const missing = await materializeWorkspace(fx.workspace);
  assert.match(missing.library.rejectedEvents[0].detail, /MINUTES_NOT_FOUND/u);
});

// Two devices, each with its own directory and a fixed identity, so the merged order is the same on every run.
async function deviceHome(base, name, deviceId) {
  const home = join(base, name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "device.json"), `${JSON.stringify({ createdAt: "2026-01-01T00:00:00Z", deviceId, displayName: name, schemaVersion: "einzbern.device.v1" })}\n`);
  return home;
}

async function as(home, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try {
    return await operation();
  } finally {
    process.env.EINZBERN_HOME = previous;
  }
}

test("SUB-426 (V+7): two devices that supersede one decision apart leave one supersession and one rejected event, the same on both", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-decision-devices-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const homeA = await deviceHome(base, "device-a", "a".repeat(32));
  const homeB = await deviceHome(base, "device-b", "b".repeat(32));
  const workspace = join(base, "shared", ".ether");
  const copy = join(base, "copy", ".ether");
  const projectId = await as(homeA, async () => {
    await cli(["init", "--workspace", workspace, "--project-name", "Shared", "--at", at(0)]);
    const id = (await cli(["project-create", "--workspace", workspace, "--at", at(1), "--external-key", "DL-SHARED", "--name", "Shared"])).record.id;
    await cli(["minutes-record", "--workspace", workspace, "--at", at(2), "--project-id", id, "--external-key", "DL-MIN-1",
      "--title", "t", "--summary", "s", "--decisions", EAST]);
    return id;
  });
  await cp(join(base, "shared"), join(base, "copy"), { recursive: true });
  const supersede = (home, root, key, second) => as(home, () => cli(["minutes-record", "--workspace", root, "--at", at(second), "--project-id", projectId,
    "--external-key", key, "--title", key, "--summary", "s", "--decisions", WEST, "--supersedes", "DL-MIN-1#D1=D1"]));
  await supersede(homeA, workspace, "DL-MIN-2", 3);
  await supersede(homeB, copy, "DL-MIN-3", 4);
  // Device B's stream reaches the shared library, as a sync would bring it.
  const streamsB = await readdir(join(copy, "akasha"));
  for (const stream of streamsB.filter((name) => name === "b".repeat(32))) await cp(join(copy, "akasha", stream), join(workspace, "akasha", stream), { recursive: true });

  const readA = await as(homeA, () => materializeWorkspace(workspace));
  const readB = await as(homeB, () => materializeWorkspace(workspace));
  for (const state of [readA, readB]) {
    assert.equal(state.library.rejectedEvents.length, 1, "one of the two supersessions is the rejected event");
    assert.match(state.library.rejectedEvents[0].detail, /MINUTES_DECISION_OBSOLETE/u);
  }
  const winner = decisionLedger(readA).decisions.get(address("DL-MIN-1", 1)).supersededBy;
  assert.equal(decisionLedger(readB).decisions.get(address("DL-MIN-1", 1)).supersededBy, winner, "both devices read the same successor");
  assert.ok([address("DL-MIN-2", 1), address("DL-MIN-3", 1)].includes(winner));
  assert.equal(readA.library.rejectedEvents[0].recordId, winner === address("DL-MIN-2", 1) ? minutesId("DL-MIN-3") : minutesId("DL-MIN-2"));
});
