// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-474 R3, AC1, AC4 at the core (TCRN-CROSS-SUB-302, SUB-303): a prompt whose best
// hit scores below the strong-hit threshold is answered with nothing. On the recorded cross-project
// corpus every prompt of the unrelated group is answered with nothing; with the threshold at zero
// the same group is answered -- the proof that the emptiness hangs on the threshold and not on the
// corpus -- and a prompt about the library is still answered.
//
// MIN-235 D9 (TCRN-CROSS-SUB-302): the threshold is measured on both ends at once. In the library
// the acceptance probe built -- one Initiative, one Epic and two Stories written with the goal and
// body fields -- a Story's goal words, body words and title were each answered with nothing at the
// shipped default of 17 (bm25 3.65, 3.16 and 4.43 at threshold zero), while an unrelated prompt
// reached 16.98 on the recorded corpus: no fixed bm25 number sat between the two. The threshold is
// now counted in words that only one record of the library carries (recallScoreUnit) and becomes
// a bm25 floor in the library it is put to, and one default answers the small library's related
// queries, stays silent on its unrelated ones, and stays silent on the recorded corpus's unrelated
// group.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SETTINGS_CATALOG, createProject, createWork, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { RECALL_STRONG_TAU, RecallIndex, recall, recallDocuments, recallScoreUnit, recallStrongHitFloor, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { recordMinutes } from "../dist/build/packages/core/src/workspace.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-09-26T13:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);
const FIXTURES = new URL("./fixtures/retrieval-eval/", import.meta.url);
const readFixture = async (name) => JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"));

// Every record of the fixture library carries "the" and "and", and no other word the prompts use,
// so a prompt made of those and of words the library never uses matches nothing that counts.
const CARDS = [
  { id: "knowledge:000000000000000000000011", externalKey: "SH-CARD-1", subject: "The zebrafish tank and the heater", summary: "the heater and the thermostat", snippet: "keep the zebrafish warm and fed", tags: ["reference"], expansions: "" },
  { id: "knowledge:000000000000000000000012", externalKey: "SH-CARD-2", subject: "The otter pond and the filter", summary: "the filter and the pump", snippet: "clean the pond and the filter", tags: ["lesson"], expansions: "" },
];

const UNRELATED = [
  "what is the weather and the forecast today",
  "write a poem about the sea and the sky",
  "how do you cook the rice and the beans",
  "translate the sentence into French and German",
  "name the capital of Australia and the capital of Peru",
  "summarize the plot of the novel and the film",
  "convert the temperature and the units to metric",
  "play the music and shuffle the playlist",
  "今天的天气怎么样",
  "推荐一部好看的电影",
];

// D9's small library, the one the R13 acceptance probe measured: its related queries are a Story's
// goal words, its body words and its title, and the other Story's goal words and title.
const SMALL_RELATED = [
  { query: "pangolin sighting tally", key: "D9-STORY-1", field: "goal" },
  { query: "quokka moult calendar", key: "D9-STORY-1", field: "body" },
  { query: "Offline tally sheet", key: "D9-STORY-1", field: "title" },
  { query: "nest photo", key: "D9-STORY-2", field: "goal" },
  { query: "Photo attachment", key: "D9-STORY-2", field: "title" },
];

// Its unrelated prompts: each shares at most one word with the library, so at threshold zero the
// coincidence is answered and at the default it is not.
const SMALL_UNRELATED = [
  "what is on the football calendar this season",
  "how long does a photo print take to dry",
  "is the new tablet worth buying",
  "sheet music for a beginner piano piece",
  "best signal booster for a rural house",
  "can I watch films offline on a plane",
  "how do I cook the rice and the beans",
  "今天的天气怎么样",
  "推荐一部好看的电影",
  "明天早上七点叫我起床",
];

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-strong-hit-")));
  context.after(() => { rm(base, { recursive: true, force: true }); resetRecallCache(); });
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "SH-PROJECT", name: "Strong hit" })).projects[0].id;
  await createWork(workspace, { occurredAt: at(2), projectId, externalKey: "SH-INIT", kind: "Initiative", parentId: null, title: "The aquarium and the ponds", goal: "Run the aquarium and the ponds." });
  await createWork(workspace, { occurredAt: at(3), projectId, externalKey: "SH-EPIC", kind: "Epic", parentId: idOf("SH-INIT"), title: "The tanks and the filters", goal: "Keep the tanks and the filters clean." });
  await createWork(workspace, {
    occurredAt: at(4), projectId, externalKey: "SH-STORY", kind: "Story", parentId: idOf("SH-EPIC"), title: "The zebrafish tank and the heater",
    goal: "Give the zebrafish a tank and a heater.", acceptance: "GIVEN the tank and the heater WHEN it is filled THEN the zebrafish swim", body: "The axolotl and the zebrafish share the tank.",
  });
  await createWork(workspace, {
    occurredAt: at(5), projectId, externalKey: "SH-STORY-2", kind: "Story", parentId: idOf("SH-EPIC"), title: "The otter pond and the pump",
    goal: "Move the otter over and fit the pump.", acceptance: "GIVEN the pond and the pump WHEN the otter moves THEN the water flows",
  });
  return recordMinutes(workspace, {
    occurredAt: at(6), externalKey: "SH-MIN-1", projectId, title: "The otter and the pond", summary: "the otter moves and the pond gets cleaned",
    decisions: ["Move the otter east and the pump with it."], decidedBy: [], linkedWorkIds: [],
  });
}

/** One Initiative, one Epic and two Stories written with the goal and body fields, as the D9 probe wrote them. */
async function smallLibrary(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-strong-hit-small-")));
  context.after(() => { rm(base, { recursive: true, force: true }); resetRecallCache(); });
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "D9-PROJECT", name: "d9" })).projects[0].id;
  await createWork(workspace, { occurredAt: at(2), projectId, externalKey: "D9-INIT-1", kind: "Initiative", parentId: null, title: "Field notebook platform" });
  await createWork(workspace, { occurredAt: at(3), projectId, externalKey: "D9-EPIC-1", kind: "Epic", parentId: idOf("D9-INIT-1"), title: "Survey capture" });
  await createWork(workspace, {
    occurredAt: at(4), projectId, externalKey: "D9-STORY-1", kind: "Story", parentId: idOf("D9-EPIC-1"), title: "Offline tally sheet",
    goal: "Rangers record the pangolin sighting tally while the tablet has no signal",
    acceptance: "GIVEN no signal WHEN a ranger saves a tally THEN it syncs later",
    body: "The quokka moult calendar decides which transect is walked first each morning.",
  });
  return createWork(workspace, {
    occurredAt: at(5), projectId, externalKey: "D9-STORY-2", kind: "Story", parentId: idOf("D9-EPIC-1"), title: "Photo attachment",
    goal: "Attach a photo of each nest to its survey entry",
    acceptance: "GIVEN a nest entry WHEN a photo is attached THEN it shows in the entry",
  });
}

function ask(state, query, tau, cards = CARDS) {
  const documents = recallDocuments(recallInputsFromState(state, cards));
  return recall({ cacheKey: `strong-hit-${state.metadata.workspaceId}`, checkpoint: String(state.headEventHash), documents: () => documents, query, ...(tau === undefined ? {} : { tau }) });
}

// The recorded corpus as the recall verb would index it: the fixtures are recall-inputs.ts's output.
async function recordedCorpus() {
  const [work, minutes, cards] = await Promise.all(["work-compact.json", "minutes-compact.json", "cards-compact.json"].map(readFixture));
  return recallDocuments({ knowledge: cards.records, minutes: minutes.records, work: work.records, scopeExcerptBytes: 512 });
}

function askCorpus(documents, query, tau) {
  return recall({ cacheKey: "strong-hit-corpus", checkpoint: "recorded", documents: () => documents, query, ...(tau === undefined ? {} : { tau }) });
}

/** The best ranked score of each query, in recallScoreUnit units of the index. */
function bestScores(documents, queries) {
  const index = new RecallIndex(documents, "best-scores");
  try {
    return queries.map((query) => ({ query, best: (index.search(query)[0]?.score ?? 0) / recallScoreUnit(index.size) }));
  } finally {
    index.close();
  }
}

test("D9 form (SUB-302): the threshold is counted in words only one record of the library carries", () => {
  assert.equal(recallScoreUnit(4), Math.log(3.5 / 1.5), "the weight FTS5 gives a word one of four records carries");
  assert.equal(recallScoreUnit(600), Math.log(599.5 / 1.5));
  assert.ok(recallScoreUnit(600) / recallScoreUnit(4) > 7, "the same match weighs seven times more in six hundred records than in four");
  assert.equal(recallStrongHitFloor(RECALL_STRONG_TAU, 600), RECALL_STRONG_TAU * recallScoreUnit(600));
  assert.ok(recallStrongHitFloor(RECALL_STRONG_TAU, 600) > 16.9767, "above the best unrelated bm25 of the recorded corpus");
  assert.ok(recallStrongHitFloor(RECALL_STRONG_TAU, 4) < 2.9811, "below the lowest related bm25 of the small library");
  // One or two records: FTS5 floors every inverse document frequency at 1e-6, and so does the unit.
  assert.equal(recallScoreUnit(2), 1e-6);
  assert.equal(recallScoreUnit(1), 1e-6);
  assert.equal(recallScoreUnit(0), 1e-6);
});

test("D9 (SUB-302, SUB-303): the default sits above every unrelated prompt of both libraries and at or below every related query of the small one", async (context) => {
  const state = await smallLibrary(context);
  const small = recallDocuments(recallInputsFromState(state, []));
  assert.equal(small.length, 4, "an Initiative, an Epic and two Stories");
  const related = bestScores(small, SMALL_RELATED.map((entry) => entry.query));
  const unrelatedSmall = bestScores(small, SMALL_UNRELATED);
  const negatives = (await readFixture("negative-queries.json")).queries.map((entry) => entry.query);
  const large = await recordedCorpus();
  const unrelatedLarge = bestScores(large, negatives);
  const lowestRelated = Math.min(...related.map((entry) => entry.best));
  const highestUnrelated = Math.max(...unrelatedSmall.map((entry) => entry.best), ...unrelatedLarge.map((entry) => entry.best));
  assert.ok(highestUnrelated < RECALL_STRONG_TAU, `the best unrelated score ${highestUnrelated} stays below ${RECALL_STRONG_TAU}`);
  assert.ok(RECALL_STRONG_TAU <= lowestRelated, `the lowest related score ${lowestRelated} reaches ${RECALL_STRONG_TAU}`);
  // The calibration rule retrieval-eval holds: the smallest whole number above the best unrelated score.
  assert.equal(RECALL_STRONG_TAU, Math.floor(highestUnrelated) + 1);
  // The same prompts in raw bm25: no fixed number separates them, which is what D9 found.
  const rawLowestRelated = lowestRelated * recallScoreUnit(small.length);
  const rawHighestUnrelated = Math.max(...unrelatedLarge.map((entry) => entry.best)) * recallScoreUnit(large.length);
  assert.ok(rawLowestRelated < rawHighestUnrelated, `bm25 ${rawLowestRelated} for a related query, ${rawHighestUnrelated} for an unrelated one`);
  const setting = SETTINGS_CATALOG.find((entry) => entry.key === "retrieval.tau");
  assert.equal(setting.defaultValue, String(RECALL_STRONG_TAU), "and retrieval.tau defaults to it");
});

test("D9 (SUB-302): in a small library written with the goal and body fields, goal words, body words and titles are answered at the default", async (context) => {
  const state = await smallLibrary(context);
  try {
    for (const { query, key, field } of SMALL_RELATED) {
      const answer = ask(state, query, undefined, []);
      assert.equal(answer.tau, RECALL_STRONG_TAU, query);
      assert.equal(answer.reasonCode, "RECALL_READY", `${field}: ${query}`);
      assert.equal(answer.records[0]?.id, idOf(key), `${field}: ${query}`);
      assert.equal(answer.floor, recallStrongHitFloor(RECALL_STRONG_TAU, 4), "the floor of a four-record library");
      assert.ok(answer.records[0].score >= answer.floor);
    }
  } finally {
    resetRecallCache();
  }
});

test("D9 (SUB-302): the small library's unrelated prompts are answered with nothing at the default, and at threshold zero they are answered", async (context) => {
  const state = await smallLibrary(context);
  try {
    for (const query of SMALL_UNRELATED) {
      const answer = ask(state, query, undefined, []);
      assert.equal(answer.reasonCode, "RECALL_NO_STRONG_HIT", query);
      assert.deepEqual(answer.records, [], query);
    }
    const answeredAtZero = SMALL_UNRELATED.filter((query) => ask(state, query, 0, []).records.length > 0);
    assert.ok(answeredAtZero.length >= 5, `threshold 0 answers the coincidences, so the emptiness hangs on the threshold: ${answeredAtZero.join(" | ")}`);
  } finally {
    resetRecallCache();
  }
});

test("STORY-474 AC1 (core): ten prompts unrelated to the library are all answered with nothing", async (context) => {
  const state = await library(context);
  assert.equal(UNRELATED.length, 10);
  for (const prompt of UNRELATED) {
    const answer = ask(state, prompt);
    assert.equal(answer.reasonCode, "RECALL_NO_STRONG_HIT", prompt);
    assert.deepEqual(answer.records, [], prompt);
    assert.equal(answer.tau, RECALL_STRONG_TAU);
  }
});

test("STORY-474 AC1, AC4 on the recorded corpus: the unrelated group is answered with nothing, and at threshold zero it is answered", async () => {
  const documents = await recordedCorpus();
  const negatives = (await readFixture("negative-queries.json")).queries;
  assert.ok(negatives.length >= 10);
  assert.deepEqual([...new Set(negatives.map((entry) => entry.language))].sort(), ["en", "zh"]);
  assert.ok(negatives.some((entry) => /\bI\b/u.test(entry.query)), "the group carries the one-letter I that used to reach the key column");
  try {
    for (const { query } of negatives) {
      const answer = askCorpus(documents, query);
      assert.equal(answer.reasonCode, "RECALL_NO_STRONG_HIT", query);
      assert.deepEqual(answer.records, [], query);
      assert.equal(answer.floor, recallStrongHitFloor(RECALL_STRONG_TAU, answer.indexed), "the default becomes this corpus's bm25 floor");
    }
    const answeredAtZero = negatives.filter(({ query }) => askCorpus(documents, query, 0).records.length > 0);
    assert.ok(answeredAtZero.length > 0, "threshold 0 turns the all-empty group red: the emptiness hangs on the threshold");
  } finally {
    resetRecallCache();
  }
});

test("STORY-474 R3: a prompt about the library is still answered, and a named key is always a strong hit", async (context) => {
  const documents = await recordedCorpus();
  try {
    const answer = askCorpus(documents, "SSH 远程跑命令,参数里带空格和括号,到那边就报语法错误");
    assert.equal(answer.reasonCode, "RECALL_READY");
    assert.equal(answer.records[0]?.id, "knowledge:939fa8fb8993235cece099e9", "the card the question was written for");
    const fragment = askCorpus(documents, "what did INIT019-C12 say");
    assert.equal(fragment.reasonCode, "RECALL_READY", "a key fragment naming one record is as deliberate as its key");
    assert.equal(fragment.records[0]?.key, "TCRN-INIT019-C12-L");
  } finally {
    resetRecallCache();
  }
  const state = await library(context);
  const byKey = ask(state, "what about SH-STORY-2 and the weather");
  assert.equal(byKey.reasonCode, "RECALL_READY");
  assert.equal(byKey.records[0]?.id, idOf("SH-STORY-2"));
  // Whatever the threshold: the largest value retrieval.tau takes still answers a named record.
  const atMaximum = ask(state, "what about SH-STORY-2 and the weather", 100);
  assert.equal(atMaximum.reasonCode, "RECALL_READY");
  assert.deepEqual(atMaximum.records.map((record) => record.id), [idOf("SH-STORY-2")]);
  for (const tau of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => ask(state, "zebrafish", tau), (error) => error?.reasonCode === "RECALL_TAU_INVALID", String(tau));
  }
});

test("STORY-474 Feature Toggle: retrieval.tau defaults to the strong-hit threshold, and injection.budgetBytes is retired", () => {
  const tau = SETTINGS_CATALOG.find((entry) => entry.key === "retrieval.tau");
  assert.equal(tau.defaultValue, String(RECALL_STRONG_TAU));
  assert.ok(Number.isSafeInteger(RECALL_STRONG_TAU), "a whole number, the only kind the setting takes");
  assert.equal(SETTINGS_CATALOG.some((entry) => entry.key === "injection.budgetBytes"), false);
  assert.ok(SETTINGS_CATALOG.some((entry) => entry.key === "injection.perPromptBytes"), "a prompt's own budget stays");
});
