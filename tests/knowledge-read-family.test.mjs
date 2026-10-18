// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-539 GWT2, GWT3 (MIN-256 D6 C5, MIN-258 D1; TCRN-CROSS-SUB-504): the reads are split by
// INIT family as the write guards are (TCRN-CROSS-SUB-485, TCRN-CROSS-SUB-503). A pair of cards two
// devices wrote without seeing each other is no unresolved conflict when the two are of families apart,
// both known, and neither card leaves default selection, recall or a checkpoint for it; a pair of one
// family, or one either card of which has no known family, is named and withheld as before. The
// knowledge hint a done or a minutes-record answers names only the cards of the target's family or of
// no known family, and says how many it left out (filteredByFamily); a target of no known family keeps
// every card.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  captureKnowledgeUnit,
  createKnowledgeUnit,
  createProject,
  createWork,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  materializeWorkspace,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { knowledgeConflictHits, knowledgeProjectionConflict } from "../dist/build/packages/core/src/knowledge-core.js";
import { KNOWLEDGE_HINT_QUESTION, knowledgeHintFor } from "../dist/build/packages/core/src/knowledge-hint.js";
import { applyMachineSettingSet } from "../dist/build/packages/core/src/machine-settings.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-10-14T12:00:00Z";
const at = (second) => `2026-10-14T09:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const OWNER = "owner:sub-504";
const DEVICE_A = "a".repeat(32);
const DEVICE_B = "b".repeat(32);
const HINT_PREFIX = `${KNOWLEDGE_HINT_QUESTION}；可能冲突的卡：`;
const work = (key) => deriveStableId("work", key);
const ids = (records) => records.map((record) => record.id).sort();
const pairs = (...list) => list.map((pair) => [...pair].sort()).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

// A device directory with a fixed identity, so the order of the device streams is the same on every run.
async function deviceHome(base, name, deviceId) {
  const home = join(base, name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "device.json"), `${JSON.stringify({ createdAt: "2026-01-01T00:00:00Z", deviceId, displayName: name, schemaVersion: "einzbern.device.v1" })}\n`);
  return home;
}

// Run `operation` as the device whose directory is `home`, and put the process's device back.
async function as(home, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try {
    return await operation();
  } finally {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
  }
}

async function cli(home, args) {
  return as(home, async () => {
    let output = "";
    await runCli(args, { write(value) { output += value; } });
    return JSON.parse(output);
  });
}

// Two devices, A and B, sharing one library as a synced folder shares it, and two Initiatives of one
// project: RF-INIT-A over RF-EPIC-A, RF-STORY-A1 and RF-STORY-A2; RF-INIT-B over RF-EPIC-B, RF-STORY-B1
// and RF-STORY-B2. `hold(home)` takes that device's crest stream out of the folder and `deliver(home)`
// puts it back, as a folder that delivers late would.
async function twoDevices(context, name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-read-family-${name}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const homeA = await deviceHome(base, "device-a", DEVICE_A);
  const homeB = await deviceHome(base, "device-b", DEVICE_B);
  const workspace = join(base, "shared", ".ether");
  let second = 0;
  const next = () => at(second++);
  const projectId = await as(homeA, async () => {
    await initializeLibrary({ root: workspace, createdAt: next(), libraryId: deriveStableId("library", `RF-${name.toUpperCase()}`) });
    const project = (await createProject(workspace, { occurredAt: next(), externalKey: "RF-PROJECT", name: "Read family" })).projects[0].id;
    for (const side of ["A", "B"]) {
      await createWork(workspace, { occurredAt: next(), projectId: project, externalKey: `RF-INIT-${side}`, kind: "Initiative", parentId: null, title: `Initiative ${side}`, scope: `## Goal\nShip side ${side}.` });
      await createWork(workspace, { occurredAt: next(), projectId: project, externalKey: `RF-EPIC-${side}`, kind: "Epic", parentId: work(`RF-INIT-${side}`), title: `Epic ${side}`, goal: `Hold side ${side}.` });
      for (const n of [1, 2]) {
        await createWork(workspace, {
          occurredAt: next(), projectId: project, externalKey: `RF-STORY-${side}${n}`, kind: "Story", parentId: work(`RF-EPIC-${side}`),
          title: `Story ${side}${n}`, goal: `Deliver ${side}${n}.`, acceptance: `GIVEN ${side}${n} WHEN delivered THEN it works`,
        });
      }
    }
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
    return project;
  });
  const held = join(base, "held");
  await mkdir(held);
  const deviceOf = (home) => (home === homeA ? DEVICE_A : DEVICE_B);
  const crestStream = (home) => join(workspace, DIRECTORY.knowledge, "events", deviceOf(home));
  return {
    base, workspace, projectId, homeA, homeB, next, held,
    hold: (home) => rename(crestStream(home), join(held, deviceOf(home))),
    deliver: (home) => rename(join(held, deviceOf(home)), crestStream(home)),
  };
}

// A role card of the library's crest naming its work by reference.
function capture(fx, subject, sourceReferences, extra = {}) {
  return captureKnowledgeUnit(fx.workspace, {
    occurredAt: fx.next(), subject, summary: `${subject}, in brief`, snippet: `${subject}, the line`, tags: ["family"],
    accountableOwnerId: OWNER, body: `${subject} body`, sourceReferences, ...extra,
  }, { allowTrailing: true });
}

// A card of `scope`: a project card may link its project's work, a user card names it by reference.
function card(fx, key, subject, { scope = "project", sourceReferences = [], linkedWorkIds = [], coexist } = {}) {
  return createKnowledgeUnit(fx.workspace, {
    occurredAt: fx.next(), externalKey: key, scope, projectId: scope === "project" ? fx.projectId : null, roleScopes: [], category: "workflow",
    kind: "fact", tags: ["family"], subject, summary: `${subject}, in brief`, snippet: `${subject}, the line`, accountableOwnerId: OWNER,
    sourceReferences, sourceDigest: canonicalSha256({ key }), supersedes: null, linkedWorkIds, linkedDecisionIds: [], linkedGateIds: [],
    linkedEvidenceIds: [], retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only", body: `${key} body`,
    ...(coexist === undefined ? {} : { coexist }),
  });
}

test("STORY-539 GWT2 (SUB-504): of the pairs two devices wrote, one of INIT families apart is not unresolved; one of one family, or of a family not known, is", async (context) => {
  const fx = await twoDevices(context, "pairs");
  // A writes three cards, then the folder holds A's stream back while B writes three close to them.
  const gullA = await as(fx.homeA, () => capture(fx, "Gull nesting cliff survey", ["RF-STORY-A1"]));
  const heronA = await as(fx.homeA, () => capture(fx, "Heron wading pool depth", ["RF-STORY-A2"]));
  const otterA = await as(fx.homeA, () => capture(fx, "Otter slide angle", ["docs/otters.md"]));
  await fx.hold(fx.homeA);
  const gullB = await as(fx.homeB, () => capture(fx, "Gull nesting cliff census", ["RF-STORY-B1"]));
  const heronB = await as(fx.homeB, () => card(fx, "RF-HERON-B", "Heron wading pool depth check", { linkedWorkIds: [work("RF-STORY-A1")] }));
  const otterB = await as(fx.homeB, () => capture(fx, "Otter slide angle measure", ["RF-STORY-B2"]));
  for (const written of [gullB, heronB, otterB]) assert.equal(Object.hasOwn(written, "conflicts"), false, "B saw none of A's cards");
  await fx.deliver(fx.homeA);

  const unresolved = pairs([heronA.id, heronB.id], [otterA.id, otterB.id]);
  for (const home of [fx.homeA, fx.homeB]) {
    const listed = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
    assert.equal(listed.reasonCode, "KNOWLEDGE_LIST_READY");
    assert.deepEqual(listed.unresolvedConflicts, unresolved, "A's gull card is of A and B's of B: that pair is not named");
    assert.deepEqual(ids(listed.records), [gullA.id, gullB.id].sort(), "the gull pair's cards stay in default selection; the two pairs named leave it");
    const all = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" }));
    assert.deepEqual(all.unresolvedConflicts, unresolved);
    assert.equal(all.total, 6, "selection all lists every card");
    const byId = new Map(all.records.map((record) => [record.id, record]));
    assert.deepEqual(knowledgeConflictHits([byId.get(gullA.id)], byId.get(gullB.id).subject), [gullA.id], "the gull cards score as a conflict, so the scan finds them a pair");
  }
  await as(fx.homeB, async () => {
    const recalled = await readRecallCards(fx.workspace, { at: AT });
    assert.deepEqual(recalled.cards.map((entry) => entry.id).sort(), [gullA.id, gullB.id].sort(), "recall reads the gull pair's cards");
    assert.deepEqual(recalled.projectCrestDegraded, { reasonCode: "KNOWLEDGE_POSSIBLE_CONFLICT", unresolvedConflicts: unresolved, withheldCards: 4 });
    const checkpoint = JSON.parse(await exportKnowledgeCheckpoint(fx.workspace, AT));
    assert.deepEqual(ids(checkpoint.records), [gullA.id, gullB.id].sort(), "a checkpoint's corpus is the default selection's");
  });
});

test("STORY-539 GWT2 (SUB-504): the user crest's pairs are split in the library a read goes through", async (context) => {
  const fx = await twoDevices(context, "user");
  const crest = join(fx.base, "synced", "crest");
  await mkdir(join(fx.base, "synced"));
  for (const home of [fx.homeA, fx.homeB]) await as(home, () => applyMachineSettingSet({ key: "crest.userPath", value: crest, occurredAt: AT }));
  const userStream = async (home) => join(crest, "events", JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId);
  const gullA = await as(fx.homeA, () => card(fx, "RF-USER-GULL-A", "Gull nesting cliff survey", { scope: "user", sourceReferences: ["RF-STORY-A1"] }));
  const heronA = await as(fx.homeA, () => card(fx, "RF-USER-HERON-A", "Heron wading pool depth", { scope: "user", sourceReferences: ["RF-STORY-B1"] }));
  const streamA = await userStream(fx.homeA);
  await rename(streamA, join(fx.held, "user-a"));
  const gullB = await as(fx.homeB, () => card(fx, "RF-USER-GULL-B", "Gull nesting cliff census", { scope: "user", sourceReferences: ["RF-STORY-B2"] }));
  const heronB = await as(fx.homeB, () => card(fx, "RF-USER-HERON-B", "Heron wading pool depth check", { scope: "user", sourceReferences: ["RF-STORY-B2"] }));
  await rename(join(fx.held, "user-a"), streamA);

  const listed = await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT, scope: "user" }));
  assert.deepEqual(listed.unresolvedConflicts, [[heronA.id, heronB.id].sort()], "the herons are both of B; the gulls are of A and of B");
  assert.deepEqual(ids(listed.records), [gullA.id, gullB.id].sort());

  // Read through a library that holds none of that work, no card has a known family: both pairs stand.
  const other = join(fx.base, "other", ".ether");
  await as(fx.homeB, async () => {
    await initializeLibrary({ root: other, createdAt: AT });
    await createProject(other, { occurredAt: AT, externalKey: "RF-OTHER-PROJECT", name: "Other" });
  });
  const elsewhere = await as(fx.homeB, () => listKnowledgeMetadata(other, { at: AT, scope: "user" }));
  assert.deepEqual(elsewhere.unresolvedConflicts, pairs([gullA.id, gullB.id], [heronA.id, heronB.id]));
  assert.deepEqual(elsewhere.records, []);
});

test("STORY-539 GWT3 (SUB-504): the knowledge hint of done, of a work-batch done and of minutes-record names only cards of the target's family or of none, and counts the rest", async (context) => {
  const fx = await twoDevices(context, "hint");
  const home = fx.homeA;
  // Four cards about one thing: one of A by key, one of B by key, one of B by linked work, one of no family.
  const ofA = await as(home, () => capture(fx, "Pelican feeding schedule mornings", ["RF-STORY-A2"]));
  const ofB = await as(home, () => capture(fx, "Pelican feeding schedule evenings", ["RF-STORY-B1"]));
  const linkedB = await as(home, () => card(fx, "RF-PELICAN-LINKED", "Pelican feeding schedule weekends", { linkedWorkIds: [work("RF-STORY-B2")], coexist: true }));
  const none = await as(home, () => capture(fx, "Pelican feeding schedule holidays", ["docs/pelicans.md"], { coexist: true }));
  for (const side of ["A", "B"]) {
    await as(home, () => createWork(fx.workspace, {
      occurredAt: fx.next(), projectId: fx.projectId, externalKey: `RF-STORY-${side}3`, kind: "Story", parentId: work(`RF-EPIC-${side}`), status: "active",
      title: "Pelican feeding schedule", goal: "Publish the pelican feeding schedule.", acceptance: "GIVEN the pelicans WHEN fed THEN the schedule holds",
    }));
  }
  const line = (hint) => `${HINT_PREFIX}${hint.conflictCandidateIds.length === 0 ? "无" : hint.conflictCandidateIds.join("、")}；按族滤掉 ${String(hint.filteredByFamily)} 张`;

  const done = await cli(home, ["work-transition", "--workspace", fx.workspace, "--at", fx.next(), "--id", work("RF-STORY-A3"), "--status", "done"]);
  assert.equal(done.record.status, "done");
  assert.deepEqual([...done.knowledgeHint.conflictCandidateIds].sort(), [ofA.id, none.id].sort(), "a Story of A is told of the card of A and the card of no family");
  assert.equal(done.knowledgeHint.filteredByFamily, 2, "the two cards of B are left out");
  assert.equal(done.knowledgeHint.line, line(done.knowledgeHint));
  assert.match(done.knowledgeHint.line, /；按族滤掉 2 张$/u);

  const batchFile = join(fx.base, "work-batch.json");
  await writeFile(batchFile, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: [{ verb: "work-transition", externalKey: "RF-STORY-B3", status: "done" }] })}\n`);
  const batch = await cli(home, ["work-batch", "--workspace", fx.workspace, "--at", fx.next(), "--from-file", batchFile]);
  assert.equal(batch.knowledgeHints.length, 1);
  const [batchHint] = batch.knowledgeHints;
  assert.equal(batchHint.workId, work("RF-STORY-B3"));
  assert.deepEqual([...batchHint.conflictCandidateIds].sort(), [ofB.id, linkedB.id, none.id].sort(), "a Story of B is told of the cards of B, by key and by linked work, and of the card of no family");
  assert.equal(batchHint.filteredByFamily, 1);
  assert.equal(batchHint.line, line(batchHint));

  const minutes = (key, extra) => cli(home, [
    "minutes-record", "--workspace", fx.workspace, "--at", fx.next(), "--project-id", fx.projectId, "--external-key", key,
    "--title", `Minutes ${key}`, "--summary", "The pelican feeding schedule is set", "--decisions", key === "RF-MIN-A" ? "Order more fish crates." : "Repaint the boathouse door.", ...extra,
  ]);
  const ofMinutesA = await minutes("RF-MIN-A", ["--work-ids", work("RF-STORY-A1")]);
  assert.deepEqual([...ofMinutesA.knowledgeHint.conflictCandidateIds].sort(), [ofA.id, none.id].sort(), "minutes are of the family of the work they link");
  assert.equal(ofMinutesA.knowledgeHint.filteredByFamily, 2);
  assert.equal(ofMinutesA.knowledgeHint.line, line(ofMinutesA.knowledgeHint));
  const unlinked = await minutes("RF-MIN-NONE", []);
  assert.deepEqual([...unlinked.knowledgeHint.conflictCandidateIds].sort(), [ofA.id, ofB.id, linkedB.id, none.id].sort(), "minutes linking no work have no family: every card is named");
  assert.equal(unlinked.knowledgeHint.filteredByFamily, 0);
  assert.match(unlinked.knowledgeHint.line, /；按族滤掉 0 张$/u);

  // At the core: what a hint scores nothing against leaves nothing out.
  const state = await as(home, () => materializeWorkspace(fx.workspace));
  assert.deepEqual(knowledgeHintFor(state, [], { workId: work("RF-STORY-A3") }), { line: `${HINT_PREFIX}无；按族滤掉 0 张`, conflictCandidateIds: [], filteredByFamily: 0 });
});


test("545: completion hints cap ranked candidates at five independently of query capacity", () => {
  const cards = Array.from({ length: 8 }, (_, index) => ({
    id: `knowledge:hint-${index}`, subject: "Pelican feeding schedule", summary: "Pelican feeding schedule",
    snippet: "Pelican feeding schedule", tags: [], sourceReferences: [], linkedWorkIds: [],
    lifecycle: "active", extensions: {}, expansions: {},
  }));
  const state = { work: [{ id: "work:hint", title: "Pelican feeding schedule", externalKey: "HINT", kind: "Story", parentId: null, extensions: {} }], minutes: [], conferenceMinutes: [], conferences: [] };
  const hint = knowledgeHintFor(state, cards, { workId: "work:hint" });
  assert.deepEqual(hint.conflictCandidateIds, cards.slice(0, 5).map(card => card.id));
});


test("545: conflict projection follows stable creation direction, not reverse-only evidence", () => {
  const older = { id: "knowledge:a", updatedAt: "2026-10-14T08:00:00Z", subject: "Amber rotation", summary: "", snippet: "", tags: [], lifecycle: "active", extensions: {} };
  const newer = { ...older, id: "knowledge:b", updatedAt: "2026-10-14T09:00:00Z", subject: "Cobalt deployment", summary: "Amber rotation; Amber rotation" };
  const conflict = (left, right) => knowledgeProjectionConflict(left, right, left.updatedAt, right.updatedAt);
  assert.deepEqual(knowledgeConflictHits([older], newer.subject), []);
  assert.deepEqual(knowledgeConflictHits([newer], older.subject), [newer.id]);
  assert.equal(conflict(older, newer), false);
  assert.equal(conflict(newer, older), false, "enumeration never selects the comparison direction");
  const genuine = { ...newer, subject: "Amber rotation guide" };
  assert.equal(conflict(older, genuine), true);
  assert.equal(conflict(genuine, older), true);
  assert.equal(knowledgeProjectionConflict({ ...older, updatedAt: "2026-10-15T08:00:00Z" }, newer, older.updatedAt, newer.updatedAt), false, "refresh metadata does not replace the original event instant");
  const tied = { ...newer, updatedAt: older.updatedAt };
  assert.equal(conflict(older, tied), false);
  assert.equal(conflict(tied, older), false);
  const reverseTie = { ...tied, id: "knowledge:0" };
  assert.equal(conflict(older, reverseTie), true, "equal-time cards use canonical id, not input order");
  assert.equal(conflict(reverseTie, older), true);
});
