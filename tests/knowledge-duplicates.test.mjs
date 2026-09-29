// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-426 (TCRN-CROSS-STORY-514 AC6, R3; MIN-239 D5; C-R17-5): before a card is written it
// is compared with the text of every live work record and every valid decision of the library, and a
// card that repeats one is refused with KNOWLEDGE_ALREADY_RECORDED, naming the record and where the
// content belongs. The check sits in the one card write every verb reaches, so knowledge-create,
// knowledge-capture, a knowledge-batch member and a card bound for the user's crest meet it alike. A
// card that says something of its own is written, and a withdrawn decision is not compared.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeKnowledgeStore, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import {
  KNOWLEDGE_DUPLICATE_REASON_CODES,
  KNOWLEDGE_DUPLICATE_SHARED_TOKENS,
  KNOWLEDGE_DUPLICATE_THRESHOLD,
  knowledgeDuplicateMatches,
} from "../dist/build/packages/core/src/knowledge-duplicates.js";
import { decisionAddress } from "../dist/build/packages/core/src/minutes.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-09-29T11:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const OWNER = deriveStableId("owner", "KNOWLEDGE-DUPLICATES-OWNER");

const GOAL = "Replace the brass heron valves in the aviary pump room before the winter inspection, and log each valve serial in the maintenance ledger.";
const ACCEPTANCE = "GIVEN a replaced valve WHEN the inspector checks the pump room THEN its serial is in the maintenance ledger";
const DECISION = "Keep the pelican feeding log in the east boathouse and review it every Monday with the keeper on duty.";

// A card that says again what the Story says, and one that says what the decision says.
const STORY_REPEAT = {
  key: "KD-STORY-REPEAT",
  subject: "Brass heron valves are replaced before the winter inspection",
  summary: "Replace the brass heron valves in the aviary pump room before the winter inspection",
  snippet: "log each valve serial in the maintenance ledger",
  body: GOAL,
};
const DECISION_REPEAT = {
  key: "KD-DECISION-REPEAT",
  subject: "The pelican feeding log lives in the east boathouse",
  summary: "Keep the pelican feeding log in the east boathouse and review it every Monday",
  snippet: "reviewed every Monday by the keeper on duty",
  body: DECISION,
};
// A lesson about the same valves that the Story does not hold.
const LESSON = {
  key: "KD-LESSON",
  subject: "Heron valve threads strip when torqued cold",
  summary: "A valve fitted below five degrees strips its thread; warm the fitting first",
  snippet: "warm the brass fitting before torquing it",
  body: "Measured on the third valve: a cold fitting stripped at forty newton metres. Warm the fitting with a heat gun for two minutes, then torque it.",
};

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

const refusal = (args) => runCli(args, { write() {} }).then(() => null, (error) => error);

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-knowledge-duplicates-")));
  // A device directory of this test's own, so a user card it writes is never another test's.
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
    await rm(base, { recursive: true, force: true });
  });
  const workspace = join(base, ".ether");
  await cli(["init", "--workspace", workspace, "--project-name", "Knowledge duplicates", "--at", at(0)]);
  const projectId = (await cli(["project-create", "--workspace", workspace, "--at", at(1), "--external-key", "KD-PROJECT", "--name", "Knowledge duplicates"])).record.id;
  const initiativeId = (await cli(["work-create", "--workspace", workspace, "--at", at(2), "--project-id", projectId, "--external-key", "KD-INIT", "--kind", "Initiative", "--title", "Aviary"])).record.id;
  const epicId = (await cli(["work-create", "--workspace", workspace, "--at", at(3), "--project-id", projectId, "--external-key", "KD-EPIC", "--kind", "Epic", "--parent-id", initiativeId, "--title", "Pump room"])).record.id;
  const storyId = (await cli(["work-create", "--workspace", workspace, "--at", at(4), "--project-id", projectId, "--external-key", "KD-STORY", "--kind", "Story",
    "--parent-id", epicId, "--title", "Heron valve replacement", "--goal", GOAL, "--acceptance", ACCEPTANCE])).record.id;
  const minutes = await cli(["minutes-record", "--workspace", workspace, "--at", at(5), "--project-id", projectId, "--external-key", "KD-MIN-1",
    "--title", "Boathouse", "--summary", "Where the feeding log is kept.", "--decisions", DECISION]);
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, projectId, storyId, minutesId: minutes.id };
}

function createArgs(workspace, second, card, extra = []) {
  return [
    "knowledge-create", "--workspace", workspace, "--at", at(second),
    "--external-key", card.key, "--scope", card.scope ?? "workspace", "--project-id", "-",
    "--role-scopes", "-", "--category", "workflow", "--kind", "fact", "--tags", "lesson",
    "--subject", card.subject, "--summary", card.summary, "--snippet", card.snippet,
    "--accountable-owner-id", OWNER, "--source-references", "-",
    "--retrieval", "default", "--freshness", "fresh", "--last-verified", "-", "--stale-days", "-",
    "--export", "metadata-only", "--body", card.body,
    ...extra,
  ];
}

async function cardCount(workspace, second, scope) {
  return (await cli(["knowledge-list", "--workspace", workspace, "--at", at(second), "--selection", "all", ...(scope === undefined ? [] : ["--scope", scope])])).total;
}

test("STORY-514 AC6: a card repeating a work record is refused, naming it and where its content belongs, and nothing is written", async (context) => {
  const fx = await library(context);
  const refused = await refusal(createArgs(fx.workspace, 10, STORY_REPEAT));
  assert.equal(refused?.reasonCode, "KNOWLEDGE_ALREADY_RECORDED");
  assert.notEqual(refused.reasonCode, "KNOWLEDGE_DUPLICATE", "not the code of one key written by two writers");
  assert.deepEqual(KNOWLEDGE_DUPLICATE_REASON_CODES, ["KNOWLEDGE_ALREADY_RECORDED"]);
  assert.equal(refused.details.target, fx.storyId);
  assert.match(refused.details.remedy, /work-annotate/u);
  assert.match(refused.message, /work KD-STORY/u);
  assert.equal(await cardCount(fx.workspace, 11), 0, "the store holds no card");
});

test("STORY-514 AC6: a card repeating a valid decision is refused, and once the decision is withdrawn it is not compared", async (context) => {
  const fx = await library(context);
  const refused = await refusal(createArgs(fx.workspace, 10, DECISION_REPEAT));
  assert.equal(refused?.reasonCode, "KNOWLEDGE_ALREADY_RECORDED");
  assert.equal(refused.details.target, decisionAddress(fx.minutesId, 1));
  assert.match(refused.details.remedy, /minutes-record/u);

  await cli(["minutes-record", "--workspace", fx.workspace, "--at", at(11), "--project-id", fx.projectId, "--external-key", "KD-MIN-2",
    "--title", "Withdrawal", "--summary", "The boathouse ruling is withdrawn.", "--decisions", "Paint the heron gate green.", "--withdraws", "KD-MIN-1#D1"]);
  const written = await cli(createArgs(fx.workspace, 12, DECISION_REPEAT));
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED", "only valid decisions are compared");
});

test("STORY-514 R3: a card that says something the records do not is written, though it shares their words", async (context) => {
  const fx = await library(context);
  const written = await cli(createArgs(fx.workspace, 10, LESSON));
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const state = await materializeWorkspace(fx.workspace);
  assert.deepEqual(knowledgeDuplicateMatches(state, LESSON, LESSON.body), []);
  const [match] = knowledgeDuplicateMatches(state, STORY_REPEAT, STORY_REPEAT.body);
  assert.equal(match.kind, "work");
  assert.equal(match.key, "KD-STORY");
  assert.ok(match.score >= KNOWLEDGE_DUPLICATE_THRESHOLD && match.shared >= KNOWLEDGE_DUPLICATE_SHARED_TOKENS);
  assert.deepEqual(knowledgeDuplicateMatches(state, { subject: "Heron", summary: "valves", snippet: "pump room" }, "winter"), [], "too few words to repeat anything");
});

test("C-R17-5: knowledge-capture, a knowledge-batch member and a card for the user's crest meet the same check", async (context) => {
  const fx = await library(context);
  const captured = await refusal([
    "knowledge-capture", "--workspace", fx.workspace, "--at", at(10),
    "--subject", STORY_REPEAT.subject, "--summary", STORY_REPEAT.summary, "--snippet", STORY_REPEAT.snippet, "--tags", "lesson",
    "--accountable-owner-id", OWNER, "--body", STORY_REPEAT.body, "--allow-trailing", "true",
  ]);
  assert.equal(captured?.reasonCode, "KNOWLEDGE_ALREADY_RECORDED");

  const document = join(fx.base, "batch.json");
  await writeFile(document, JSON.stringify({
    schemaVersion: "tcrn.knowledge-batch.v1",
    members: [{
      verb: "knowledge-create", externalKey: "KD-BATCH-REPEAT", scope: "workspace", projectId: null, roleScopes: [],
      category: "workflow", kind: "fact", tags: ["lesson"], subject: DECISION_REPEAT.subject, summary: DECISION_REPEAT.summary, snippet: DECISION_REPEAT.snippet,
      accountableOwnerId: OWNER, sourceReferences: [], sourceDigest: canonicalSha256({ card: "KD-BATCH-REPEAT" }),
      linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [],
      retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only", body: DECISION_REPEAT.body,
    }],
  }));
  const batched = await refusal(["knowledge-batch", "--workspace", fx.workspace, "--at", at(11), "--from-file", document]);
  assert.equal(batched?.reasonCode, "WORK_BATCH_REFUSED");
  assert.equal(JSON.parse(batched.message).failed.reasonCode, "KNOWLEDGE_ALREADY_RECORDED", "the member's own code is carried");

  const user = await refusal(createArgs(fx.workspace, 12, { ...STORY_REPEAT, scope: "user" }));
  assert.equal(user?.reasonCode, "KNOWLEDGE_ALREADY_RECORDED", "a user card is compared with the library it is written from");
  assert.equal(await cardCount(fx.workspace, 13), 0);
  assert.equal(await cardCount(fx.workspace, 13, "user"), 0);
});
