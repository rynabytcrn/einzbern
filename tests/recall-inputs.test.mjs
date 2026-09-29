// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-474 R1, R2 at the core (TCRN-CROSS-SUB-301): recall indexes Stories (and
// historical Incidents) on title, goal and body, Initiatives and Epics on title and goal, never a
// Subtask, and every status; minutes and cards share the index; a hit is one line with kind,
// status, title, key, id and the titles above it, and an answer is cut to its byte budget at
// whole lines.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProject, createWork, initializeLibrary, transitionWork } from "../dist/build/packages/core/src/index.js";
import { recall, recallDocuments, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { formatRecallLine, recallContextLines, recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { recordMinutes } from "../dist/build/packages/core/src/workspace.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { appendHistoricalWorkCreate } from "./helpers/workspace-fixture.mjs";

const at = (second) => `2026-09-26T12:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);

const CARDS = [{
  id: "knowledge:000000000000000000000001", externalKey: "RI-CARD", subject: "Quokka handling notes", summary: "How the quokka is handled",
  snippet: "handle the quokka gently", tags: ["reference"], expansions: "",
}];

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-recall-inputs-")));
  context.after(() => { rm(base, { recursive: true, force: true }); resetRecallCache(); });
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "RI-PROJECT", name: "Recall inputs" })).projects[0].id;
  await createWork(workspace, {
    occurredAt: at(2), projectId, externalKey: "RI-INIT", kind: "Initiative", parentId: null, title: "Aviary initiative",
    scope: "## Goal\nBuild the heron aviary.\n\n## Requirements\n- the pelican enclosure is out of scope for the index",
  });
  await createWork(workspace, { occurredAt: at(3), projectId, externalKey: "RI-EPIC", kind: "Epic", parentId: idOf("RI-INIT"), title: "Wetland epic", goal: "Keep the flamingo pond." });
  await createWork(workspace, {
    occurredAt: at(4), projectId, externalKey: "RI-STORY", kind: "Story", parentId: idOf("RI-EPIC"), title: "Zebrafish tank",
    goal: "Give the zebrafish a tank.", acceptance: "GIVEN the tank WHEN it is filled THEN the zebrafish swim", body: "The axolotl shares the tank.",
  });
  await createWork(workspace, { occurredAt: at(5), projectId, externalKey: "RI-SUBTASK", kind: "Subtask", parentId: idOf("RI-STORY"), title: "Narwhal filter step" });
  for (const [index, status] of ["ready", "active", "done"].entries()) {
    await transitionWork(workspace, { occurredAt: at(6 + index), id: idOf("RI-STORY"), status });
  }
  await appendHistoricalWorkCreate(workspace, {
    externalKey: "RI-INC", projectId, kind: "Incident", parentId: idOf("RI-STORY"), status: "done", title: "Leaking capybara valve", occurredAt: at(9),
  });
  const state = await recordMinutes(workspace, {
    occurredAt: at(10), externalKey: "RI-MIN-1", projectId, title: "Otter decision", summary: "The otter moves.",
    decisions: ["Move the otter to the east pond.", "Keep the old pond."], decidedBy: [], linkedWorkIds: [],
  });
  return state;
}

function answer(state, query) {
  const documents = recallDocuments(recallInputsFromState(state, CARDS));
  return recall({ cacheKey: `recall-inputs-${query}`, checkpoint: String(state.headEventHash), documents: () => documents, query, tau: 0 }).records;
}

test("STORY-474 R1: a Subtask is not indexed; a done Story is, on its title, goal and body", async (context) => {
  const state = await library(context);
  const inputs = recallInputsFromState(state, CARDS);
  assert.deepEqual(inputs.work.map((entry) => entry.externalKey).sort(), ["RI-EPIC", "RI-INC", "RI-INIT", "RI-STORY"], "no Subtask among the inputs");
  assert.equal(answer(state, "narwhal").filter((hit) => hit.kind === "work").length, 0, "the Subtask's title finds nothing");
  for (const term of ["zebrafish", "axolotl"]) {
    const hit = answer(state, term).find((entry) => entry.kind === "work");
    assert.equal(hit?.id, idOf("RI-STORY"), `${term} reaches the done Story`);
  }
  // Recall answers a raw work list by the same policy, whoever built it.
  const raw = recallDocuments({ work: [{ id: "work:x", externalKey: "RAW-SUB", kind: "Subtask", status: "active", title: "raw subtask", summary: "s", scope: "", labels: [] }] });
  assert.deepEqual(raw, []);
});

test("STORY-474 AC2 (core): a done Story's hit reads as one line with its title, id, done, Epic and Initiative", async (context) => {
  const state = await library(context);
  const hit = answer(state, "zebrafish").find((entry) => entry.kind === "work");
  assert.equal(hit.status, "done");
  assert.deepEqual(hit.parentChain, ["Wetland epic", "Aviary initiative"]);
  const line = formatRecallLine(hit);
  assert.equal(line, `[Story done] Zebrafish tank · RI-STORY · ${idOf("RI-STORY")} · Wetland epic ‹ Aviary initiative`);
  const incident = answer(state, "capybara").find((entry) => entry.kind === "work");
  assert.equal(incident?.recordKind, "Incident", "a historical Incident is indexed like a Story");
  assert.match(formatRecallLine(incident), /^\[Incident done\] Leaking capybara valve · RI-INC · .* · Zebrafish tank ‹ Wetland epic ‹ Aviary initiative$/u, "its chain walks its parentId");
});

test("STORY-474 R1: an Initiative and an Epic are found by title and goal, not by the rest of their scope", async (context) => {
  const state = await library(context);
  assert.equal(answer(state, "heron").find((entry) => entry.kind === "work")?.id, idOf("RI-INIT"), "the Initiative's goal");
  assert.equal(answer(state, "flamingo").find((entry) => entry.kind === "work")?.id, idOf("RI-EPIC"), "the Epic's goal");
  assert.equal(answer(state, "wetland").find((entry) => entry.kind === "work")?.id, idOf("RI-EPIC"), "the Epic's title");
  assert.equal(answer(state, "pelican").filter((entry) => entry.kind === "work").length, 0, "a Requirements block is not indexed");
});

test("STORY-474 R1: minutes and cards share the index with the work records, and each has its line", async (context) => {
  const state = await library(context);
  const minutes = answer(state, "otter").find((entry) => entry.kind === "minutes");
  assert.equal(minutes?.key, "RI-MIN-1", "a minutes record is keyed by its external key");
  assert.equal(formatRecallLine(minutes), "[纪要 RI-MIN-1] Otter decision · D1 Move the otter to the east pond. …");
  const card = answer(state, "quokka").find((entry) => entry.kind === "card");
  assert.equal(formatRecallLine(card), "[卡片] Quokka handling notes · knowledge:000000000000000000000001");
});

test("STORY-474 R2: an answer is cut to its byte budget at whole lines", async (context) => {
  const state = await library(context);
  const hits = answer(state, "zebrafish otter quokka");
  assert.ok(hits.length >= 3);
  const lines = hits.map(formatRecallLine);
  const all = recallContextLines(hits, 1_000_000);
  assert.deepEqual(all, lines);
  const firstTwo = Buffer.byteLength(`${lines[0]}\n${lines[1]}`, "utf8");
  assert.deepEqual(recallContextLines(hits, firstTwo), lines.slice(0, 2), "two lines fit exactly");
  assert.deepEqual(recallContextLines(hits, firstTwo - 1), lines.slice(0, 1), "one byte less and the second line is dropped whole");
  assert.deepEqual(recallContextLines(hits, 0), []);
  const long = formatRecallLine({ ...hits[0], title: "长".repeat(400) });
  assert.ok(Buffer.byteLength(long, "utf8") <= 480 && long.endsWith("…"), "a line is capped at a code point");
});

test("SUB-426 (MIN-239 D6): a minutes record is indexed with its valid decisions, its lead numbered as recorded", async (context) => {
  const state = await library(context);
  const projectId = state.projects[0].id;
  const workspace = state.library.libraryRoot;
  // The otter decision D1 is superseded by a decision on another pond; D2 stays valid.
  const next = await recordMinutes(workspace, {
    occurredAt: at(11), externalKey: "RI-MIN-2", projectId, title: "Heron decision", summary: "The heron moves instead.",
    decisions: ["Move the heron to the north marsh."], decidedBy: [], linkedWorkIds: [],
    supersedes: [{ decision: "RI-MIN-1#D1", by: "D1" }],
  });
  const minutes = recallInputsFromState(next, CARDS).minutes.find((entry) => entry.externalKey === "RI-MIN-1");
  assert.deepEqual(minutes.decisions, ["Keep the old pond."], "the obsolete decision is not indexed");
  assert.deepEqual(minutes.decisionNumbers, [2]);
  const hit = answer(next, "old pond").find((entry) => entry.kind === "minutes" && entry.key === "RI-MIN-1");
  assert.equal(formatRecallLine(hit), "[纪要 RI-MIN-1] Otter decision · D2 Keep the old pond.");
  assert.equal(answer(next, "east").some((entry) => entry.key === "RI-MIN-1"), false, "the words only the obsolete decision held find nothing");
  const untouched = recallInputsFromState(next, CARDS).minutes.find((entry) => entry.externalKey === "RI-MIN-2");
  assert.equal(Object.hasOwn(untouched, "decisionNumbers"), false, "a record with every decision valid reads as it always did");
});
