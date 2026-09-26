// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-474 R3, AC1, AC4 at the core (TCRN-CROSS-SUB-302): a prompt whose best hit
// scores below the strong-hit threshold is answered with nothing. Ten prompts that have nothing to
// do with the library are all answered empty; with the threshold at zero the same ten are not --
// the proof that the emptiness hangs on the threshold and not on the corpus -- and a prompt about
// the library is still answered.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SETTINGS_CATALOG, createProject, createWork, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { RECALL_STRONG_TAU, recall, recallDocuments, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { recordMinutes } from "../dist/build/packages/core/src/workspace.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-09-26T13:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);

// Every record of the fixture library carries "the" and "and", and no other word the prompts use,
// so a prompt made of those and of words the library never uses matches every record weakly and
// none strongly.
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

function ask(state, query, tau) {
  const documents = recallDocuments(recallInputsFromState(state, CARDS));
  return recall({ cacheKey: "strong-hit", checkpoint: String(state.headEventHash), documents: () => documents, query, ...(tau === undefined ? {} : { tau }) });
}

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

test("STORY-474 AC4 (core): with the threshold at zero the same prompts are answered, so the emptiness hangs on the threshold", async (context) => {
  const state = await library(context);
  const leaked = UNRELATED.filter((prompt) => ask(state, prompt, 0).records.length > 0);
  assert.ok(leaked.length > 0, "tau 0 turns the all-empty case red: at least one unrelated prompt gets an answer");
  assert.ok(UNRELATED.filter((prompt) => ask(state, prompt, 0).reasonCode === "RECALL_READY").length > 0);
});

test("STORY-474 R3: a prompt about the library is still answered, and an exact key is always a strong hit", async (context) => {
  const state = await library(context);
  const answer = ask(state, "zebrafish heater");
  assert.equal(answer.reasonCode, "RECALL_READY");
  assert.ok(answer.records.some((hit) => hit.id === idOf("SH-STORY")));
  const byKey = ask(state, "what about SH-STORY-2 and the weather");
  assert.equal(byKey.reasonCode, "RECALL_READY");
  assert.equal(byKey.records[0]?.id, idOf("SH-STORY-2"));
  for (const tau of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => ask(state, "zebrafish", tau), (error) => error?.reasonCode === "RECALL_TAU_INVALID", String(tau));
  }
});

test("STORY-474 Feature Toggle: retrieval.tau defaults to the strong-hit threshold, and injection.budgetBytes is retired", () => {
  const tau = SETTINGS_CATALOG.find((entry) => entry.key === "retrieval.tau");
  assert.equal(tau.defaultValue, String(RECALL_STRONG_TAU));
  assert.equal(SETTINGS_CATALOG.some((entry) => entry.key === "injection.budgetBytes"), false);
  assert.ok(SETTINGS_CATALOG.some((entry) => entry.key === "injection.perPromptBytes"), "a prompt's own budget stays");
});
