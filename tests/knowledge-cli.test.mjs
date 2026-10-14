// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-476 AC1 to AC4 at the CLI (TCRN-CROSS-SUB-311). A card written through the CLI
// is recalled at once, with no lifecycle flag and no promotion step (AC1); a conflicting card is
// refused until it names the one it supersedes, which then leaves default retrieval (AC2); a card
// written with --scope user lands in this user's crest and another project recalls it marked user
// (AC3); a work record reaching done, and minutes being recorded, answer a line asking whether
// there is knowledge to extract, with the cards a card about it could conflict with (AC4). Every
// knowledge write answers the ids it wrote beside the store version (problem list #18).

import "./helpers/device-home.mjs";
import { ATELIER_SURFACE, withSurface } from "./helpers/workspace-fixture.mjs";
import { heavyLockDirectoryUnder, usePrivateHeavySlots } from "./helpers/heavy-slots.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { createProject, initializeKnowledgeStore, initializeLibrary, registerLibrary } from "../dist/build/packages/core/src/index.js";
import { USER_CREST_ID } from "../dist/build/packages/core/src/knowledge-core.js";
import { KNOWLEDGE_HINT_QUESTION } from "../dist/build/packages/core/src/knowledge-hint.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalJson, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-09-27T09:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const OWNER = deriveStableId("owner", "KNOWLEDGE-CLI-OWNER");
const HINT_PREFIX = `${KNOWLEDGE_HINT_QUESTION}；可能冲突的卡：`;
// TCRN-CROSS-SUB-504 (STORY-539): the line ends with the cards left out by INIT family; these cards name no
// work, so none is.
const HINT_UNFILTERED = "；按族滤掉 0 张";

// A device directory of this test's own, so the user crest it writes is never another test's, and a
// heavy-run slot directory beside it for the gates-run a test runs (TCRN-CROSS-SUB-502, STORY-538 GWT5).
async function device(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-knowledge-cli-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
    await rm(base, { recursive: true, force: true });
  });
  usePrivateHeavySlots(context, heavyLockDirectoryUnder(base));
  return base;
}

async function library(base, name) {
  const workspace = join(base, name, ".ether");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const state = await createProject(workspace, { occurredAt: at(1), externalKey: `${name.toUpperCase()}-PROJECT`, name });
  await registerLibrary({ projectPath: join(base, name), libraryPath: workspace, projectId: state.projects[0].id, registeredAt: at(2) }, process.env.EINZBERN_HOME);
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { workspace, projectId: state.projects[0].id };
}

async function cli(args) {
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error);
}

// knowledge-create with every flag it still requires and nothing else: no --lifecycle.
function createArgs(workspace, second, card, extra = []) {
  return [
    "knowledge-create", "--workspace", workspace, "--at", at(second),
    "--external-key", card.key, "--scope", card.scope ?? "workspace", "--project-id", card.projectId ?? "-",
    "--role-scopes", "-", "--category", "workflow", "--kind", "fact", "--tags", card.tags ?? "lesson",
    "--subject", card.subject, "--summary", card.summary, "--snippet", card.snippet,
    "--accountable-owner-id", OWNER, "--source-references", "-",
    "--retrieval", "default", "--freshness", "fresh", "--last-verified", "-", "--stale-days", "-",
    "--export", "metadata-only", "--body", card.body ?? `${card.subject}.`,
    ...extra,
  ];
}

function captureArgs(workspace, second, card, extra = []) {
  return [
    "knowledge-capture", "--workspace", workspace, "--at", at(second),
    "--subject", card.subject, "--summary", card.summary, "--snippet", card.snippet, "--tags", "lesson",
    "--accountable-owner-id", OWNER, "--body", card.body ?? `${card.subject}.`, "--allow-trailing", "true",
    ...extra,
  ];
}

async function recallCli(workspace, second, query) {
  return cli(["recall", "--workspace", workspace, "--at", at(second), "--query", query, "--tau", "0", "--allow-trailing", "true"]);
}

test("476-AC1 (CLI): a card written without a lifecycle flag is recalled at once, and nothing about it is a candidate", async (context) => {
  const base = await device(context);
  const { workspace } = await library(base, "alpha");
  const created = await cli(createArgs(workspace, 10, {
    key: "KC-PANGOLIN", subject: "Pangolin scale inventory", summary: "How the pangolin scales are counted", snippet: "count pangolin scales at dusk",
  }));
  assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.deepEqual(created.ids, [created.id], "the receipt names the card it wrote");
  assert.equal(created.version, 1, "beside the store version");
  assert.equal(Object.hasOwn(created, "promotionState"), false, "the create receipt omits the retired promotion marker");

  const answer = await recallCli(workspace, 11, "pangolin scale inventory");
  const hit = answer.records.find((record) => record.id === created.id);
  assert.equal(hit?.kind, "card", `the card is recalled the moment it is written: ${JSON.stringify(answer.records)}`);
  assert.equal(hit.scope, "project");
  assert.equal(hit.line, `[卡片] Pangolin scale inventory · ${created.id}`);
  assert.deepEqual(answer.knowledgeStores.project, { reasonCode: "KNOWLEDGE_LIST_READY", cards: 1 });

  const listed = await cli(["knowledge-list", "--workspace", workspace, "--at", at(12), "--selection", "all"]);
  assert.deepEqual(listed.records.map((record) => [record.id, record.lifecycle]), [[created.id, "active"]]);
  assert.equal(Object.hasOwn(listed.records[0], "promotionState"), false, "new metadata omits the retired promotion marker");
  assert.equal(listed.records.some((record) => Object.values(record).includes("candidate")), false, "no field holds the candidate");

  // The two lifecycles a card is no longer written with are refused with the remedy; anything
  // else is not a lifecycle at all.
  const candidate = await refusal(createArgs(workspace, 13, { key: "KC-CANDIDATE", subject: "Candidate card", summary: "s", snippet: "s" }, ["--lifecycle", "candidate"]));
  assert.equal(candidate?.reasonCode, "KNOWLEDGE_LIFECYCLE_RETIRED");
  assert.deepEqual([candidate.details.required, candidate.details.actual], ["active", "candidate"]);
  const bogus = await refusal(createArgs(workspace, 13, { key: "KC-BOGUS", subject: "Bogus card", summary: "s", snippet: "s" }, ["--lifecycle", "dormant"]));
  assert.equal(bogus?.reasonCode, "CLI_ARGUMENT_MALFORMED");
  const active = await cli(createArgs(workspace, 14, { key: "KC-ACTIVE", subject: "Explicitly active card", summary: "s", snippet: "s" }, ["--lifecycle", "active"]));
  assert.equal(active.reasonCode, "KNOWLEDGE_UNIT_CREATED", "--lifecycle active is still taken");
  // The flags that only served the candidate are gone.
  assert.equal((await refusal(["knowledge-list", "--workspace", workspace, "--at", at(15), "--promotion", "candidate"]))?.reasonCode, "CLI_ARGUMENT_UNKNOWN");
  assert.equal((await refusal(["knowledge-body", "--workspace", workspace, "--id", created.id, "--at", at(15), "--allow-unpromoted", "true"]))?.reasonCode, "CLI_ARGUMENT_UNKNOWN");
  assert.equal((await cli(["knowledge-body", "--workspace", workspace, "--id", created.id, "--at", at(15)])).body, "Pangolin scale inventory.");

  // The thin capture is recalled at once too, and its receipt has the same shape.
  const captured = await cli(captureArgs(workspace, 16, { subject: "Okapi stripe survey", summary: "Stripes tell okapi apart", snippet: "photograph okapi stripes" }));
  assert.equal(captured.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.deepEqual(captured.ids, [captured.id]);
  assert.equal(captured.version, 3);
  assert.equal((await recallCli(workspace, 17, "okapi stripe survey")).records.find((record) => record.id === captured.id)?.scope, "project");
});

test("476-AC2, SUB-425 (CLI): a conflicting card is refused until it supersedes the older one, which is then removed and leaves default retrieval", async (context) => {
  const base = await device(context);
  const { workspace } = await library(base, "beta");
  const older = await cli(createArgs(workspace, 20, {
    key: "KC-WOMBAT-1", subject: "Wombat burrow etiquette", summary: "How to enter a wombat burrow", snippet: "knock before the burrow",
  }));
  const newer = { key: "KC-WOMBAT-2", subject: "Wombat burrow etiquette revised", summary: "Enter a wombat burrow only at dusk", snippet: "wait for dusk" };
  const refused = await refusal(createArgs(workspace, 21, newer));
  assert.equal(refused?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
  assert.deepEqual(refused.details.conflicts, [older.id], "the refusal hands back the card it conflicts with");

  const replaced = await cli(createArgs(workspace, 22, newer, ["--supersedes", older.id]));
  assert.equal(replaced.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.equal(replaced.superseded, older.id);
  assert.deepEqual(replaced.ids, [replaced.id, older.id], "the receipt names both records the write touched");
  assert.equal(replaced.version, 2);

  const answer = await recallCli(workspace, 23, "wombat burrow etiquette");
  const cards = answer.records.filter((record) => record.kind === "card").map((record) => record.id);
  assert.deepEqual(cards, [replaced.id], "the superseded card is no longer recalled");
  const listed = await cli(["knowledge-list", "--workspace", workspace, "--at", at(24)]);
  assert.deepEqual(listed.records.map((record) => record.id), [replaced.id], "nor listed by default");
  const all = await cli(["knowledge-list", "--workspace", workspace, "--at", at(24), "--selection", "all"]);
  assert.equal(all.records.some((record) => record.id === older.id), false, "nor with --selection all, which chooses among valid cards");
  // TCRN-CROSS-SUB-425 (MIN-239 D4, D6): it is removed, conflict superseded, and --status removed reads
  // what it keeps.
  const removed = await cli(["knowledge-list", "--workspace", workspace, "--at", at(24), "--status", "removed"]);
  assert.deepEqual(removed.records.map((record) => [record.id, record.status, record.removal.reason, record.removal.supersededBy]), [[older.id, "removed", "superseded", replaced.id]]);
  assert.equal((await refusal(["knowledge-body", "--workspace", workspace, "--id", older.id, "--at", at(24)]))?.reasonCode, "KNOWLEDGE_CARD_REMOVED");

  // A knowledge batch answers every card record it wrote the same way.
  const batch = join(base, "knowledge-batch.json");
  await writeFile(batch, `${JSON.stringify({
    schemaVersion: "tcrn.knowledge-batch.v1",
    members: [{
      verb: "knowledge-create", externalKey: "KC-WOMBAT-3", scope: "workspace", projectId: null, roleScopes: [], category: "workflow", kind: "fact",
      tags: ["lesson"], subject: "Wombat burrow etiquette at night", summary: "Enter a wombat burrow at night only with a lamp", snippet: "carry a lamp",
      accountableOwnerId: OWNER, sourceReferences: [], sourceDigest: null, supersedes: replaced.id, linkedWorkIds: [], linkedDecisionIds: [],
      linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", body: "Carry a lamp.",
    }],
  })}\n`);
  const applied = await cli(["knowledge-batch", "--workspace", workspace, "--at", at(25), "--from-file", batch]);
  assert.equal(applied.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
  const written = applied.applied[0].id;
  assert.equal(applied.applied[0].superseded, replaced.id);
  assert.deepEqual(applied.ids, [written, replaced.id]);
  assert.equal(applied.version, 3);
});

test("476-AC3 (CLI): --scope user writes this user's crest, and another project recalls the card marked user", async (context) => {
  const base = await device(context);
  const first = await library(base, "first");
  const second = await library(base, "second");
  await cli(["library-register", "--project", join(base, "first"), "--library", first.workspace, "--at", at(28)]);
  await cli(["library-register", "--project", join(base, "second"), "--library", second.workspace, "--at", at(29)]);
  const created = await cli(createArgs(first.workspace, 30, {
    key: "KC-QUOLL", scope: "user", subject: "Quoll den survey", summary: "Count the quoll dens at dawn", snippet: "quoll dens at dawn",
  }));
  assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.equal(created.scope, "user");
  assert.deepEqual(created.ids, [created.id]);
  assert.equal(created.version, 1, "the user crest's own version");

  const crest = join(base, "device", "crest");
  const marker = JSON.parse(await readFile(join(crest, "store.json"), "utf8"));
  await writeFile(join(crest, "mutation.claim"), canonicalJson({
    schemaVersion: "tcrn.knowledge-mutation-claim.v1", workspaceId: USER_CREST_ID, version: marker.version,
    token: "c".repeat(48), pid: process.pid + 1_000_000, acquiredAt: at(30),
  }));
  const recovered = await cli(["knowledge-recover", "--workspace", first.workspace, "--scope", "user"]);
  assert.deepEqual([recovered.reasonCode, recovered.recovered, recovered.scope], ["KNOWLEDGE_RECOVERED", true, "user"]);

  // Not in the library it was written from; in the user crest, whichever library asks.
  assert.equal((await cli(["knowledge-list", "--workspace", first.workspace, "--at", at(31), "--selection", "all"])).total, 0);
  const listed = await cli(["knowledge-list", "--workspace", second.workspace, "--at", at(31), "--scope", "user"]);
  assert.equal(listed.scope, "user");
  assert.deepEqual(listed.records.map((record) => [record.id, record.scope]), [[created.id, "user"]]);
  assert.equal((await cli(["knowledge-snippet", "--workspace", second.workspace, "--id", created.id, "--scope", "user"])).snippet, "quoll dens at dawn");
  assert.equal((await cli(["knowledge-body", "--workspace", second.workspace, "--id", created.id, "--at", at(31), "--scope", "user"])).body, "Quoll den survey.");

  const answer = await recallCli(second.workspace, 32, "quoll den survey");
  const hit = answer.records.find((record) => record.id === created.id);
  assert.equal(hit?.scope, "user", `another project recalls the user card: ${JSON.stringify(answer.records)}`);
  assert.equal(hit.line, `[卡片 用户] Quoll den survey · ${created.id}`);
  assert.deepEqual(answer.knowledgeStores, {
    project: { reasonCode: "KNOWLEDGE_LIST_READY", cards: 0 },
    user: { reasonCode: "KNOWLEDGE_LIST_READY", cards: 1 },
  });

  // knowledge-capture takes --scope user the same way.
  const captured = await cli(captureArgs(second.workspace, 33, { subject: "Numbat termite routes", summary: "Numbats follow termite routes", snippet: "follow the termites" }, ["--scope", "user"]));
  assert.equal(captured.scope, "user");
  assert.equal((await recallCli(first.workspace, 34, "numbat termite routes")).records.find((record) => record.id === captured.id)?.scope, "user");
  // A user card names no role; a project capture requires an explicit stable id; a store is project or user.
  assert.equal((await refusal(captureArgs(second.workspace, 35, { subject: "s", summary: "s", snippet: "s" }, ["--scope", "user", "--role-scopes", "implementation"])))?.reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await refusal(captureArgs(second.workspace, 35, { subject: "s", summary: "s", snippet: "s" }, ["--scope", "project"])))?.reasonCode, "KNOWLEDGE_INPUT_INVALID");
  assert.equal((await refusal(["knowledge-list", "--workspace", second.workspace, "--at", at(35), "--scope", "role"]))?.reasonCode, "CLI_ARGUMENT_MALFORMED");
});

test("476-AC4 (CLI): done and minutes-record answer the knowledge line, naming the cards a card about them could conflict with", async (context) => {
  const base = await device(context);
  const { workspace, projectId } = await library(base, "gamma");
  const card = await cli(createArgs(workspace, 40, {
    key: "KC-QUOKKA", subject: "Quokka photo etiquette", summary: "Never feed a quokka for a photo", snippet: "no feeding for photos",
  }));
  const minutesCard = await cli(createArgs(workspace, 41, {
    key: "KC-CASSOWARY", subject: "Cassowary trail closure", summary: "Close the cassowary trail in nesting season", snippet: "close the trail",
  }));
  // A Story sits under an Epic under an Initiative.
  await cli(["work-create", "--workspace", workspace, "--at", at(42), "--project-id", projectId, "--external-key", "KC-INIT", "--kind", "Initiative", "--title", "Visitor guides"]);
  await cli(["work-create", "--workspace", workspace, "--at", at(42), "--project-id", projectId, "--external-key", "KC-EPIC", "--kind", "Epic", "--parent-id", deriveStableId("work", "KC-INIT"), "--title", "Wildlife guides"]);
  const epicId = deriveStableId("work", "KC-EPIC");
  const story = await cli([
    "work-create", "--workspace", workspace, "--at", at(42), "--project-id", projectId, "--external-key", "KC-STORY-1", "--parent-id", epicId,
    "--kind", "Story", "--status", "active", "--title", "Quokka photo etiquette guide",
    "--goal", "Write the quokka photo etiquette guide for visitors", "--acceptance", "GIVEN a visitor WHEN they read the guide THEN they know the quokka photo etiquette",
  ]);
  const storyId = story.record.id;

  const projectRoot = join(base, "gamma");
  const gateCommand = [process.execPath, "-e", "process.exit(0)"];
  // TCRN-CROSS-STORY-513 R1 (TCRN-CROSS-SUB-422): gates are declared as Atelier declares them; the CLI
  // refuses a model's gates-config-set.
  const declaration = await withSurface(ATELIER_SURFACE, () => cli([
    "gates-config-set", "--workspace", workspace, "--project-id", projectId, "--at", at(43), "--name", "fixture-story-coverage",
    "--command", JSON.stringify(gateCommand), "--root", ".", "--covers", storyId, "--required", "true",
  ]));
  assert.deepEqual(declaration.gate, {
    name: "fixture-story-coverage", command: gateCommand, root: ".", covers: [storyId], required: true, enabled: true, releaseOnly: false,
  });
  const gateRun = await cli([
    "gates-run", "--workspace", workspace, "--project-id", projectId, "--at", at(43), "--project", projectRoot,
    "--release", "true", "--work-id", storyId,
  ]);
  assert.equal(gateRun.reasonCode, "GATES_RUN_COMPLETED");
  assert.equal(gateRun.ok, true);
  assert.deepEqual(gateRun.requiredReds, []);
  assert.deepEqual(gateRun.run.workIds, [storyId]);
  assert.deepEqual(gateRun.run.gates.map(({ name, required, matchedWorkIds, ok }) => [name, required, matchedWorkIds, ok]), [
    ["fixture-story-coverage", true, [storyId], true],
  ], "the required gate ran green with exact coverage for this Story");

  const done = await cli(["work-transition", "--workspace", workspace, "--at", at(43), "--id", storyId, "--status", "done", "--project", projectRoot]);
  assert.equal(done.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(done.record.status, "done");
  assert.deepEqual(done.knowledgeHint.conflictCandidateIds, [card.id], "the card about the same thing is named");
  assert.equal(done.knowledgeHint.line, `${HINT_PREFIX}${card.id}${HINT_UNFILTERED}`);

  // A transition that does not reach done asks nothing.
  const story2Id = deriveStableId("work", "KC-STORY-2");
  await cli([
    "work-create", "--workspace", workspace, "--at", at(44), "--project-id", projectId, "--external-key", "KC-STORY-2", "--parent-id", epicId,
    "--kind", "Story", "--title", "Emu fence repair", "--goal", "Repair the emu fence", "--acceptance", "GIVEN the fence WHEN repaired THEN it stands",
  ]);
  const ready = await cli(["work-transition", "--workspace", workspace, "--at", at(45), "--id", story2Id, "--status", "ready"]);
  assert.equal(Object.hasOwn(ready, "knowledgeHint"), false);

  const minutes = await cli([
    "minutes-record", "--workspace", workspace, "--at", at(46), "--project-id", projectId, "--external-key", "KC-MIN-1",
    "--title", "Trail season", "--summary", "Cassowary trail closure in nesting season", "--decisions", "close the trail from August",
  ]);
  assert.equal(minutes.reasonCode, "MINUTES_RECORDED");
  assert.deepEqual(minutes.knowledgeHint.conflictCandidateIds, [minutesCard.id]);
  assert.equal(minutes.knowledgeHint.line, `${HINT_PREFIX}${minutesCard.id}${HINT_UNFILTERED}`);
  const quiet = await cli([
    "minutes-record", "--workspace", workspace, "--at", at(47), "--project-id", projectId,
    "--title", "Budget", "--summary", "Printer toner reorder", "--decisions", "reorder toner quarterly",
  ]);
  assert.deepEqual(quiet.knowledgeHint, { line: `${HINT_PREFIX}无${HINT_UNFILTERED}`, conflictCandidateIds: [], filteredByFamily: 0 }, "minutes about nothing a card holds name no card");

  // A batch answers one hint per record it takes to done.
  const batch = join(base, "work-batch.json");
  await writeFile(batch, `${JSON.stringify({
    schemaVersion: "tcrn.work-batch.v1",
    members: [
      { verb: "work-transition", externalKey: "KC-STORY-2", status: "active" },
      { verb: "work-transition", externalKey: "KC-STORY-2", status: "done" },
    ],
  })}\n`);
  const batchCoverage = await withSurface(ATELIER_SURFACE, () => cli([
    "gates-config-set", "--workspace", workspace, "--project-id", projectId, "--at", at(48), "--name", "fixture-story-coverage",
    "--covers", `${storyId},${story2Id}`,
  ]));
  assert.equal(batchCoverage.gate.covers.includes(storyId), true);
  assert.equal(batchCoverage.gate.covers.includes(story2Id), true);
  const batchGateRun = await cli([
    "gates-run", "--workspace", workspace, "--project-id", projectId, "--at", at(48), "--project", projectRoot,
    "--release", "true", "--work-id", story2Id,
  ]);
  assert.equal(batchGateRun.reasonCode, "GATES_RUN_COMPLETED");
  assert.equal(batchGateRun.ok, true);
  assert.deepEqual(batchGateRun.requiredReds, []);
  assert.deepEqual(batchGateRun.run.workIds, [story2Id]);
  assert.deepEqual(batchGateRun.run.gates.map(({ name, required, matchedWorkIds, ok }) => [name, required, matchedWorkIds, ok]), [
    ["fixture-story-coverage", true, [story2Id], true],
  ], "the required gate ran green with exact coverage for the batch Story");
  const applied = await cli(["work-batch", "--workspace", workspace, "--at", at(48), "--from-file", batch, "--project", projectRoot]);
  assert.equal(applied.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.deepEqual(applied.knowledgeHints, [{ workId: story2Id, line: `${HINT_PREFIX}无${HINT_UNFILTERED}`, conflictCandidateIds: [], filteredByFamily: 0 }]);
});

// Problem list #11 (TCRN-CROSS-SUB-309): the bin printed only string details, so a knowledge write
// refused for its budget said neither how large it would be nor the limit, and a possible
// conflict did not name the cards. Both reach stderr now. TCRN-CROSS-SUB-310 R17 (MIN-238 D1): the
// store budget is gone, so the size refusal left is a card's own limit, and it names the field.
test("476 (bin): a refused knowledge write names the field past its card limit, or the cards it conflicts with, on stderr", async (context) => {
  const base = await device(context);
  const { workspace } = await library(base, "delta");
  const bin = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const run = (args) => {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 1, result.stdout);
    return JSON.parse(result.stderr.trim().split("\n").at(-1));
  };
  const fits = await cli(createArgs(workspace, 49, { key: "KC-FULL", subject: "Full card", summary: "s", snippet: "s", body: "x".repeat(8_192) }));
  assert.equal(fits.reasonCode, "KNOWLEDGE_UNIT_CREATED", "a body at the card limit is admitted");
  const oversized = await cli(createArgs(workspace, 50, { key: "KC-HUGE", subject: "Huge card", summary: "s", snippet: "s", body: "x".repeat(8_193) }));
  assert.equal(oversized.reasonCode, "KNOWLEDGE_UNIT_CREATED", "the old per-card ceiling no longer refuses the complete body");

  const kept = await cli(createArgs(workspace, 51, { key: "KC-DINGO-1", subject: "Dingo fence patrol", summary: "Walk the dingo fence weekly", snippet: "weekly patrol" }));
  const conflict = run(createArgs(workspace, 52, { key: "KC-DINGO-2", subject: "Dingo fence patrol schedule", summary: "Walk the dingo fence daily", snippet: "daily patrol" }));
  assert.equal(conflict.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
  assert.deepEqual(conflict.conflicts, [kept.id]);
});

// MIN-235 D9 (TCRN-CROSS-SUB-302): the recall cases above pass --tau 0, written when the default was a
// bm25 number calibrated on the cross-project chain. The default now counts words only one record of
// the library carries; these ask again with no --tau and nothing recorded.
async function recallAtDefault(workspace, second, query) {
  return cli(["recall", "--workspace", workspace, "--at", at(second), "--query", query, "--allow-trailing", "true"]);
}

test("D9 (476-AC1, AC3 at the default threshold): a project card and a user card are recalled by their subjects, and an unrelated prompt is answered with nothing", async (context) => {
  const base = await device(context);
  const first = await library(base, "gamma");
  const second = await library(base, "delta");
  await cli(["library-register", "--project", join(base, "gamma"), "--library", first.workspace, "--at", at(60)]);
  await cli(["library-register", "--project", join(base, "delta"), "--library", second.workspace, "--at", at(61)]);
  const project = await cli(createArgs(first.workspace, 62, {
    key: "KC-PANGOLIN-D9", subject: "Pangolin scale inventory", summary: "How the pangolin scales are counted", snippet: "count pangolin scales at dusk",
  }));
  const user = await cli(createArgs(first.workspace, 63, {
    key: "KC-QUOLL-D9", scope: "user", subject: "Quoll den survey", summary: "Count the quoll dens at dawn", snippet: "quoll dens at dawn",
  }));

  const found = await recallAtDefault(first.workspace, 64, "pangolin scale inventory");
  assert.equal(found.reasonCode, "RECALL_READY");
  assert.equal(found.tau, "3.0000", "the shipped default");
  assert.deepEqual(found.records.map((record) => [record.id, record.scope]), [[project.id, "project"]]);
  // Another project recalls the user card, marked user.
  const elsewhere = await recallAtDefault(second.workspace, 65, "quoll den survey");
  assert.equal(elsewhere.reasonCode, "RECALL_READY");
  assert.deepEqual(elsewhere.records.map((record) => [record.id, record.scope]), [[user.id, "user"]]);

  for (const workspace of [first.workspace, second.workspace]) {
    for (const query of ["what is the weather like in Paris today", "how many scales does a fish have", "推荐一部好看的电影"]) {
      const quiet = await recallAtDefault(workspace, 66, query);
      assert.equal(quiet.reasonCode, "RECALL_NO_STRONG_HIT", query);
      assert.deepEqual([quiet.records, quiet.context], [[], []], query);
    }
  }
  // The one-word coincidence is answered at --tau 0: the emptiness above hangs on the threshold.
  const lowered = await recallCli(first.workspace, 67, "how many scales does a fish have");
  assert.deepEqual(lowered.records.map((record) => record.id), [project.id]);
});

// TCRN-CROSS-INIT-053 R46 (I04; U20 D5): a library whose knowledge store was never created lists as an
// empty inventory that says so, both as the library was made (its store directory empty) and with that
// directory gone, and recall reads it as a ready store with no card. A file, a link, or a directory that
// holds anything without its marker at the store's place is still refused with its own reason code, and
// the list of a store that exists carries no new field.
test("R46 I04 (CLI): a library that never created its knowledge store lists an empty inventory; a file, a link or a directory without its marker is still refused", async (context) => {
  const base = await device(context);
  const workspace = join(base, "fresh", ".ether");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const store = join(workspace, "crest");
  const args = ["knowledge-list", "--workspace", workspace, "--at", at(1)];
  const view = (answer) => [answer.schemaVersion, answer.reasonCode, answer.knowledgeStore, answer.total, answer.records, answer.truncated];
  const absent = ["tcrn.knowledge-list.v1", "KNOWLEDGE_LIST_READY", "absent", 0, [], false];
  assert.deepEqual(await readdir(store), [], "a library is made with its store directory empty");
  assert.deepEqual(view(await cli(args)), absent, "as made");
  const recalled = await recallCli(workspace, 2, "anything the library might know");
  assert.deepEqual(recalled.knowledgeStores.project, { reasonCode: "KNOWLEDGE_LIST_READY", cards: 0 }, "recall reads the empty inventory as a ready store");
  assert.deepEqual(recalled.records, []);
  await rename(store, join(base, "store-away"));
  assert.deepEqual(view(await cli(args)), absent, "with the store directory gone");

  const refused = async () => (await refusal(args))?.reasonCode;
  await writeFile(store, "not a store\n");
  assert.equal(await refused(), "KNOWLEDGE_SPECIAL_FILE", "a file at the store's place");
  await rename(store, join(base, "store-file"));
  await symlink(join(base, "store-away"), store);
  assert.equal(await refused(), "KNOWLEDGE_LINK_UNSAFE", "a link at the store's place");
  await rename(store, join(base, "store-link"));
  await mkdir(join(store, "metadata"), { recursive: true });
  assert.equal(await refused(), "KNOWLEDGE_PATH_INVALID", "a directory holding something without its marker");

  await rename(store, join(base, "store-partial"));
  // A store is initialized over a chain that holds something.
  await createProject(workspace, { occurredAt: at(3), externalKey: "FRESH-PROJECT", name: "fresh" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const present = await cli(args);
  assert.deepEqual([present.reasonCode, present.total, Object.hasOwn(present, "knowledgeStore")], ["KNOWLEDGE_LIST_READY", 0, false], "an existing store's list carries no new field");
});
