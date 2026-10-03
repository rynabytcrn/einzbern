// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-SUB-425 (TCRN-CROSS-STORY-514 R1, R3, R4; MIN-239 D3, D4, D6): a knowledge card is valid or
// removed. A removal names its reason -- superseded, invalid, or duplicate (it repeats a work item or a
// decision) -- its basis, its actor and its instant, and it is terminal: no verb restores a card, and a
// removed card is refused a second removal, a supersede, a rewrite and every read of its snippet or
// body. A removal is an event in the remover's own stream of the crest, so it travels with the crest;
// no event file is deleted, and each device clears the bodies its own stream holds for removed cards at
// its next write. Reads answer valid cards unless asked for another status: knowledge-list, recall and
// the prompt hook leave removed cards out, and --status removed answers the removed cards alone, each as
// it is kept -- its id, external key, subject, removal and the supersession it took part in, with no
// summary, snippet or body; a recall hit on one carries the removal as the list gives it (TCRN-CROSS-SUB-426
// R17 续作修订三). A card another card supersedes is removed by it (conflict superseded).
//
// Two devices share one library the way a synced folder shares it: both write into one directory, and
// "not delivered yet" is the test holding a device's new files out of it, then putting them back.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_REMOVAL_REASONS,
  KNOWLEDGE_STATUS_FILTERS,
  cachePath,
  captureKnowledgeUnit,
  createKnowledgeUnit,
  createProject,
  deleteProject,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeSnippet,
  removeKnowledgeUnit,
  reverifyKnowledgeUnit,
  updateKnowledgeStalenessPolicy,
  validateKnowledgeStore,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { applyMachineSettingSet } from "../dist/build/packages/core/src/machine-settings.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { readKnowledgeHintCards } from "../dist/build/packages/core/src/knowledge-hint.js";
import { canonicalJson, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-29T12:00:00Z";
const instant = (second) => `2026-09-29T10:00:${String(second).padStart(2, "0")}Z`;
const OWNER = "owner:sub-425";
const ACTOR = "agent:claude-opus-5-5";
const DEVICE_A = "a".repeat(32);
const DEVICE_B = "b".repeat(32);
const DEVICE_C = "c".repeat(32);

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

function refusalOf(operation) {
  return operation().then(() => null, (error) => error);
}

// A card of the library's crest: scope workspace, so it names no project or work. Its summary and snippet
// repeat only its key, so no two cards score as a conflict unless their subjects do.
function card(externalKey, subject, overrides = {}) {
  return {
    occurredAt: instant(5), externalKey, scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["lifecycle"], subject, summary: `${externalKey} summary`,
    snippet: `${externalKey} snippet`, accountableOwnerId: OWNER, sourceReferences: [], sourceDigest: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
    freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${externalKey} body`, ...overrides,
  };
}

// A card of this user's crest.
function userCard(externalKey, subject, overrides = {}) {
  return card(externalKey, subject, { scope: "user", ...overrides });
}

// Devices A, B and C sharing one library; A laid it and its crest out. `holdNew(home, before)` takes
// the crest files a device wrote since `before` (its stream's entries then) out of the folder, and the
// function it answers puts them back. `holdStream(home)` takes a device's whole crest stream out.
async function sharedLibrary(context, name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-sub425-${name}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const homeA = await deviceHome(base, "device-a", DEVICE_A);
  const homeB = await deviceHome(base, "device-b", DEVICE_B);
  const homeC = await deviceHome(base, "device-c", DEVICE_C);
  const workspace = join(base, "shared", ".ether");
  const libraryId = deriveStableId("library", `SUB-425-${name.toUpperCase()}`);
  const project = await as(homeA, async () => {
    await initializeLibrary({ root: workspace, createdAt: instant(0), libraryId });
    const state = await createProject(workspace, { occurredAt: instant(1), externalKey: "SUB-425-PROJECT", name: "Lifecycle" });
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
    return state.projects[0].id;
  });
  const store = join(workspace, DIRECTORY.knowledge);
  const held = join(base, "held");
  await mkdir(held);
  const deviceOf = (home) => ({ [homeA]: DEVICE_A, [homeB]: DEVICE_B, [homeC]: DEVICE_C })[home];
  const crestStream = (home) => join(store, "events", deviceOf(home));
  return {
    base, workspace, store, libraryId, project, homeA, homeB, homeC,
    crestStream,
    entries: async (home) => (await readdir(crestStream(home)).catch(() => [])).sort(),
    holdNew: async (home, before) => {
      const moved = [];
      for (const entry of await readdir(crestStream(home))) {
        if (before.includes(entry)) continue;
        await rename(join(crestStream(home), entry), join(held, entry));
        moved.push(entry);
      }
      return async () => { for (const entry of moved) await rename(join(held, entry), join(crestStream(home), entry)); };
    },
    // A copy of a device's stream as it is now, and a hold that shows that copy in the stream's place
    // -- as a folder that has delivered nothing the device wrote since, deletions included -- until the
    // function it answers puts the stream as it is back.
    snapshot: async (home) => {
      const copy = join(held, `${deviceOf(home)}-snapshot`);
      await rm(copy, { recursive: true, force: true });
      await cp(crestStream(home), copy, { recursive: true });
      return copy;
    },
    holdSince: async (home, copy) => {
      const current = join(held, `${deviceOf(home)}-current`);
      await rename(crestStream(home), current);
      await cp(copy, crestStream(home), { recursive: true });
      return async () => {
        await rm(crestStream(home), { recursive: true, force: true });
        await rename(current, crestStream(home));
      };
    },
    holdStream: async (home) => {
      const target = join(held, `${deviceOf(home)}-stream`);
      await rename(crestStream(home), target);
      return async () => { await rename(target, crestStream(home)); };
    },
  };
}

// The events of one crest stream, in order.
async function streamEvents(stream) {
  const names = (await readdir(stream).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => ({ name, event: JSON.parse(await readFile(join(stream, name), "utf8")) })));
}

// The body files a stream holds for one card's records, and whether each is still there.
async function bodyFilesOf(stream, id) {
  const present = new Set(await readdir(stream).catch(() => []));
  return (await streamEvents(stream))
    .filter(({ event }) => event.metadata?.id === id && event.body !== null && event.body !== undefined)
    .map(({ event }) => ({ file: event.body.file, present: present.has(event.body.file) }));
}

// What a removed card keeps, and nothing else.
function assertKept(record, expected) {
  assert.deepEqual(Object.keys(record).sort(), ["externalKey", "id", "removal", "status", "subject", ...(expected.supersedes === undefined ? [] : ["supersedes"])].sort(),
    `${record.id} keeps its id, external key, subject, removal and supersession, and nothing else`);
  assert.equal(record.status, "removed");
  for (const [key, value] of Object.entries(expected)) {
    if (key === "removal") {
      for (const [field, expectedValue] of Object.entries(value)) assert.deepEqual(record.removal[field], expectedValue, `${record.id} removal.${field}`);
    } else {
      assert.deepEqual(record[key], value, `${record.id} ${key}`);
    }
  }
}

test("SUB-425 AC1: a card removed as invalid leaves default list, recall and the hint, --status removed answers what it keeps with its body cleared, and nothing restores it", async (context) => {
  const fx = await sharedLibrary(context, "ac1");
  const plover = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-PLOVER", "Plover roost moved to the north spit")));
  const dunlin = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-DUNLIN", "Dunlin flocks feed at low tide", { occurredAt: instant(6) })));
  const eventsBefore = (await streamEvents(fx.crestStream(fx.homeA))).map(({ name }) => name);
  const basis = "the north spit roost was abandoned in 2026; the survey of 2026-09-20 found it empty";
  const removed = await cli(fx.homeA, ["knowledge-remove", "--workspace", fx.workspace, "--at", instant(7), "--id", plover.id,
    "--reason", "invalid", "--basis", basis, "--actor", ACTOR]);
  assert.equal(removed.reasonCode, "KNOWLEDGE_UNIT_REMOVED");
  assert.deepEqual(removed.ids, [plover.id], "the receipt names the card it removed");
  assert.deepEqual([removed.id, removed.externalKey, removed.subject, removed.clearedBodies], [plover.id, "SUB-425-PLOVER", "Plover roost moved to the north spit", 1]);
  assert.deepEqual({ ...removed.removal, eventHash: typeof removed.removal.eventHash }, {
    reason: "invalid", basis, actor: ACTOR, removedAt: instant(7), supersededBy: null, deviceId: DEVICE_A, sequence: 3, eventHash: "string",
  });

  // The removal is an event after the stream's other events, none of which is deleted; the card's body
  // file is cleared from the stream, and the other card's is not.
  const events = await streamEvents(fx.crestStream(fx.homeA));
  assert.deepEqual(events.map(({ name }) => name).slice(0, 2), eventsBefore, "every earlier event file stays");
  assert.equal(events.length, 3);
  assert.deepEqual(events[2].event.removal, { id: plover.id, reason: "invalid", basis, actor: ACTOR, supersededBy: null });
  assert.equal(events[2].event.schemaVersion, "einzbern.crest-removal.v1");
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), plover.id)).map((entry) => entry.present), [false], "the removed card's body is cleared");
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), dunlin.id)).map((entry) => entry.present), [true]);

  // Default reads answer valid cards only: list (default and --selection all), recall and the hint.
  for (const home of [fx.homeA, fx.homeB]) {
    const listed = await cli(home, ["knowledge-list", "--workspace", fx.workspace, "--at", AT]);
    assert.deepEqual([listed.status, listed.records.map((record) => record.id)], ["valid", [dunlin.id]]);
    const everyValid = await cli(home, ["knowledge-list", "--workspace", fx.workspace, "--at", AT, "--selection", "all"]);
    assert.deepEqual(everyValid.records.map((record) => record.id), [dunlin.id], "--selection all chooses among the valid cards");
    const cards = await as(home, () => readRecallCards(fx.workspace, { at: AT }));
    assert.deepEqual([cards.cards.map((entry) => entry.id), cards.removedCardIds], [[dunlin.id], []]);
    assert.deepEqual((await as(home, () => readKnowledgeHintCards(fx.workspace, AT))).map((entry) => entry.id), [dunlin.id]);
    const recalled = await cli(home, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "plover roost north spit", "--tau", "0"]);
    assert.equal(recalled.records.some((hit) => hit.id === plover.id), false, "recall leaves the removed card out");
    assert.equal(Object.hasOwn(recalled, "status"), false);
  }

  // --status removed answers the card as it is kept; --status all answers both.
  const onlyRemoved = await cli(fx.homeB, ["knowledge-list", "--workspace", fx.workspace, "--at", AT, "--status", "removed"]);
  assert.deepEqual([onlyRemoved.status, onlyRemoved.total], ["removed", 1]);
  assertKept(onlyRemoved.records[0], {
    id: plover.id, externalKey: "SUB-425-PLOVER", subject: "Plover roost moved to the north spit",
    removal: { reason: "invalid", basis, actor: ACTOR, removedAt: instant(7), supersededBy: null, deviceId: DEVICE_A, sequence: 3 },
  });
  const both = await cli(fx.homeB, ["knowledge-list", "--workspace", fx.workspace, "--at", AT, "--status", "all"]);
  assert.deepEqual(both.records.map((record) => [record.id, record.status ?? "valid"]), [[dunlin.id, "valid"], [plover.id, "removed"]].sort((left, right) => left[0].localeCompare(right[0])));
  const searched = await cli(fx.homeB, ["knowledge-list", "--workspace", fx.workspace, "--at", AT, "--status", "removed", "--search", "plover"]);
  assert.deepEqual(searched.records.map((record) => record.id), [plover.id], "a search matches a removed card's subject");
  const filtered = await cli(fx.homeB, ["knowledge-list", "--workspace", fx.workspace, "--at", AT, "--status", "removed", "--tag", "lifecycle"]);
  assert.deepEqual(filtered.records, [], "a removed card keeps no tag to filter by");
  const recalledRemoved = await cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "plover roost north spit", "--tau", "0", "--status", "removed"]);
  const hit = recalledRemoved.records.find((entry) => entry.id === plover.id);
  assert.deepEqual([recalledRemoved.status, hit?.status, hit?.summary], ["removed", "removed", ""]);
  assert.ok(hit.line.startsWith("[卡片 已移除] Plover roost moved to the north spit"), hit.line);
  // TCRN-CROSS-SUB-426 R17 续作修订三 (STORY-514 AC1): the hit carries the removal the list answers -- why,
  // on what basis, by whom, when and by which card -- and --status removed recalls the removed cards alone.
  assert.deepEqual(hit.removal, onlyRemoved.records[0].removal);
  assert.deepEqual([hit.removal.reason, hit.removal.basis, hit.removal.actor, hit.removal.supersededBy], ["invalid", basis, ACTOR, null]);
  const dunlinRemoved = await cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "dunlin flocks low tide", "--tau", "0", "--status", "removed"]);
  assert.equal(dunlinRemoved.records.some((entry) => entry.id === dunlin.id), false, "--status removed recalls no valid card");
  const dunlinAll = await cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "dunlin flocks low tide", "--tau", "0", "--status", "all"]);
  assert.equal(Object.hasOwn(dunlinAll.records.find((entry) => entry.id === dunlin.id) ?? { removal: "missing hit" }, "removal"), false, "--status all recalls the valid card, with no removal");

  // The body and the snippet are refused, naming the removal; so is every write of the card.
  for (const read of [
    () => readKnowledgeBody(fx.workspace, plover.id, { at: AT }),
    () => readKnowledgeSnippet(fx.workspace, plover.id),
  ]) {
    const refusal = await as(fx.homeB, () => refusalOf(read));
    assert.equal(refusal?.reasonCode, "KNOWLEDGE_CARD_REMOVED");
    assert.deepEqual([refusal.details.id, refusal.details.removal.reason, refusal.details.removal.basis], [plover.id, "invalid", basis]);
    assert.match(refusal.details.remedy, /--status removed/u);
  }
  for (const write of [
    () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(8), id: plover.id, reason: "invalid", basis: "again", actor: ACTOR }),
    () => reverifyKnowledgeUnit(fx.workspace, { expectedRevision: 1, occurredAt: instant(8), id: plover.id }),
    () => updateKnowledgeStalenessPolicy(fx.workspace, { expectedRevision: 1, occurredAt: instant(8), id: plover.id, stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" } }),
    () => createKnowledgeUnit(fx.workspace, card("SUB-425-PLOVER-AGAIN", "Plover roost moved to the south spit", { occurredAt: instant(8), supersedes: plover.id })),
  ]) {
    assert.equal((await as(fx.homeA, () => refusalOf(write)))?.reasonCode, "KNOWLEDGE_CARD_REMOVED");
  }
  assert.equal((await as(fx.homeA, () => refusalOf(() => createKnowledgeUnit(fx.workspace, card("SUB-425-PLOVER", "Plover roost, rewritten", { occurredAt: instant(8) })))))?.reasonCode,
    "KNOWLEDGE_DUPLICATE", "a removed card's key stays taken: a mistake is answered by a new card");
  assert.equal((await streamEvents(fx.crestStream(fx.homeA))).length, 3, "no refused write wrote an event");
  // No verb restores a card.
  const knowledgeVerbs = COMMAND_CATALOG.map((entry) => entry.name).filter((name) => name.startsWith("knowledge-"));
  assert.equal(knowledgeVerbs.some((name) => /restore|unremove|revive|undo/u.test(name)), false);
  assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === "knowledge-remove")?.mutates, true);

  // The strict surfaces answer; the index view covers the removed card as it is kept.
  const validation = await as(fx.homeB, () => validateKnowledgeStore(fx.workspace));
  assert.deepEqual([validation.reasonCode, validation.records], ["KNOWLEDGE_STORE_VALID", 2]);
  const checkpoint = JSON.parse(await as(fx.homeB, () => exportKnowledgeCheckpoint(fx.workspace, AT)));
  assert.deepEqual(checkpoint.records.map((record) => record.id), [dunlin.id]);
  const view = JSON.parse(await readFile(join(cachePath(fx.libraryId, fx.homeB), "crest-views", "index.json"), "utf8"));
  const viewed = view.records.find((record) => record.id === plover.id);
  assertKept(viewed, { id: plover.id, removal: { reason: "invalid", basis } });
});

test("SUB-425 AC1: removed as a duplicate of a work item, in the user crest, the card is removed and its body refused", async (context) => {
  const fx = await sharedLibrary(context, "duplicate");
  const crest = join(fx.base, "synced", "crest");
  await mkdir(join(fx.base, "synced"));
  for (const home of [fx.homeA, fx.homeB]) await as(home, () => applyMachineSettingSet({ key: "crest.userPath", value: crest, occurredAt: AT }));
  const kept = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, userCard("SUB-425-USER-KEPT", "Knot migration counts peak in May")));
  const repeat = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, userCard("SUB-425-USER-REPEAT", "Survey window is the spring tide", { occurredAt: instant(6) })));
  const basis = "TCRN-CROSS-STORY-514 holds the survey window in its scope";
  const removed = await cli(fx.homeB, ["knowledge-remove", "--workspace", fx.workspace, "--at", instant(7), "--id", repeat.id,
    "--reason", "duplicate", "--basis", basis, "--actor", "owner:sub-425", "--scope", "user"]);
  assert.deepEqual([removed.reasonCode, removed.scope, removed.removal.reason, removed.removal.deviceId, removed.clearedBodies], ["KNOWLEDGE_UNIT_REMOVED", "user", "duplicate", DEVICE_B, 0],
    "B's stream holds no body of the card A wrote");
  for (const home of [fx.homeA, fx.homeB]) {
    assert.deepEqual((await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, scope: "user" }))).records.map((record) => record.id), [kept.id]);
    const removedList = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, scope: "user", status: "removed" }));
    assertKept(removedList.records[0], { id: repeat.id, removal: { reason: "duplicate", basis, actor: "owner:sub-425", deviceId: DEVICE_B } });
    assert.equal((await as(home, () => refusalOf(() => readKnowledgeBody(fx.workspace, repeat.id, { at: AT, scope: "user" }))))?.reasonCode, "KNOWLEDGE_CARD_REMOVED");
    assert.deepEqual((await as(home, () => readRecallCards(fx.workspace, { at: AT }))).cards.map((entry) => entry.id), [kept.id]);
  }
  // A holds the body until its next write to the user crest, which clears it; every event stays.
  const streamA = join(crest, "events", DEVICE_A);
  assert.deepEqual((await bodyFilesOf(streamA, repeat.id)).map((entry) => entry.present), [true]);
  await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, userCard("SUB-425-USER-NEXT", "Sanderling run the swash line", { occurredAt: instant(8) })));
  assert.deepEqual((await bodyFilesOf(streamA, repeat.id)).map((entry) => entry.present), [false], "A cleared its own stream's body at its next write");
  assert.equal((await streamEvents(streamA)).length, 3);
  assert.equal((await streamEvents(join(crest, "events", DEVICE_B))).length, 1);
  assert.equal((await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT, scope: "user", status: "all" }))).total, 3);
});

test("SUB-425 AC2: a removal one device records reaches the other with the crest, which reads the same removal and clears its own body at its next write; every event file stays", async (context) => {
  const fx = await sharedLibrary(context, "ac2");
  const curlew = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-CURLEW", "Curlew nest on the saltmarsh edge")));
  const godwit = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-425-GODWIT", "Godwit tide timing at the estuary", { occurredAt: instant(6) })));
  // B removes A's card before the removal reaches A.
  const beforeB = await fx.entries(fx.homeB);
  const removed = await as(fx.homeB, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(7), id: curlew.id, reason: "invalid", basis: "the saltmarsh edge flooded; no nest was found", actor: ACTOR }));
  assert.deepEqual([removed.reasonCode, removed.clearedBodies], ["KNOWLEDGE_UNIT_REMOVED", 0]);
  const deliver = await fx.holdNew(fx.homeB, beforeB);
  assert.deepEqual((await as(fx.homeA, () => listKnowledgeMetadata(fx.workspace, { at: AT }))).records.map((record) => record.id).sort(), [curlew.id, godwit.id].sort(),
    "before the removal reaches A, A still reads the card");
  await deliver();
  const answers = async (home) => as(home, async () => ({
    listed: canonicalJson(await listKnowledgeMetadata(fx.workspace, { at: AT })),
    removed: canonicalJson(await listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" })),
    validation: canonicalJson(await validateKnowledgeStore(fx.workspace)),
    recall: canonicalJson((await readRecallCards(fx.workspace, { at: AT })).cards.map((entry) => entry.id)),
    snippet: (await refusalOf(() => readKnowledgeSnippet(fx.workspace, curlew.id)))?.reasonCode,
  }));
  const onA = await answers(fx.homeA);
  assert.deepEqual(await answers(fx.homeB), onA, "both devices read the same removal");
  assert.equal(onA.snippet, "KNOWLEDGE_CARD_REMOVED");
  assert.deepEqual(JSON.parse(onA.listed).records.map((record) => record.id), [godwit.id]);
  assertKept(JSON.parse(onA.removed).records[0], { id: curlew.id, removal: { reason: "invalid", deviceId: DEVICE_B, sequence: 2 } });
  // A's stream still holds the card's body until A writes; then A clears it. No event file goes.
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), curlew.id)).map((entry) => entry.present), [true]);
  const knot = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-KNOT", "Knot numbers peak in autumn", { occurredAt: instant(8) })));
  assert.equal(knot.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), curlew.id)).map((entry) => entry.present), [false]);
  assert.deepEqual([(await streamEvents(fx.crestStream(fx.homeA))).length, (await streamEvents(fx.crestStream(fx.homeB))).length], [2, 2]);
  assert.deepEqual(await answers(fx.homeA), await answers(fx.homeB));
  assert.equal((await as(fx.homeA, () => validateKnowledgeStore(fx.workspace))).reasonCode, "KNOWLEDGE_STORE_VALID");
});

test("SUB-425 AC3: a card written with --supersedes removes the card it supersedes (conflict superseded) and clears its body; the new card is valid", async (context) => {
  const fx = await sharedLibrary(context, "ac3");
  const subject = "Tern colony count method on the shingle bank";
  const old = await as(fx.homeA, () => captureKnowledgeUnit(fx.workspace, {
    occurredAt: instant(5), subject, summary: "count from the hide at dawn", snippet: "dawn count from the hide", tags: ["terns"],
    accountableOwnerId: OWNER, body: "Count from the hide at dawn.", externalKey: "SUB-425-TERN-OLD",
  }));
  const replacement = await cli(fx.homeA, ["knowledge-capture", "--workspace", fx.workspace, "--at", instant(6), "--subject", subject,
    "--summary", "count by drone at midday", "--snippet", "midday drone count", "--tags", "terns", "--accountable-owner-id", "owner:sub-425-new",
    "--body", "Count by drone at midday.", "--external-key", "SUB-425-TERN-NEW", "--supersedes", old.id]);
  assert.deepEqual([replacement.reasonCode, replacement.superseded], ["KNOWLEDGE_UNIT_CREATED", old.id]);
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), old.id)).map((entry) => entry.present), [false], "the superseded card's body is cleared");
  assert.equal((await streamEvents(fx.crestStream(fx.homeA))).length, 2, "and its event stays");
  for (const home of [fx.homeA, fx.homeB]) {
    assert.deepEqual((await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" }))).records.map((record) => record.id), [replacement.id]);
    const removed = (await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" }))).records;
    assert.equal(removed.length, 1);
    assertKept(removed[0], {
      id: old.id, subject,
      removal: { reason: "superseded", supersededBy: replacement.id, basis: `superseded by ${replacement.id}`, actor: "owner:sub-425-new", removedAt: instant(6), deviceId: null, sequence: null, eventHash: null },
    });
    assert.equal((await as(home, () => refusalOf(() => readKnowledgeBody(fx.workspace, old.id, { at: AT }))))?.reasonCode, "KNOWLEDGE_CARD_REMOVED");
    assert.equal((await as(home, () => readKnowledgeBody(fx.workspace, replacement.id, { at: AT }))).body, "Count by drone at midday.");
  }
  // knowledge-remove can record the same reason, naming a valid card that supersedes the one removed.
  const lapwing = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-425-LAPWING", "Lapwing meadow nesting survey", { occurredAt: instant(7) })));
  const refusals = [
    [{ reason: "superseded" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ reason: "invalid", supersededBy: replacement.id }, "KNOWLEDGE_INPUT_INVALID"],
    [{ reason: "superseded", supersededBy: deriveStableId("knowledge", "SUB-425-NOWHERE") }, "KNOWLEDGE_LINK_INVALID"],
    [{ reason: "superseded", supersededBy: old.id }, "KNOWLEDGE_CARD_REMOVED"],
  ];
  for (const [change, reasonCode] of refusals) {
    const refusal = await as(fx.homeB, () => refusalOf(() => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(8), id: lapwing.id, basis: "the replacement covers it", actor: ACTOR, ...change })));
    assert.equal(refusal?.reasonCode, reasonCode, JSON.stringify(change));
  }
  const byOther = await as(fx.homeB, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(8), id: lapwing.id, reason: "superseded", supersededBy: replacement.id, basis: "the drone count covers the meadow too", actor: ACTOR }));
  assert.deepEqual([byOther.removal.reason, byOther.removal.supersededBy, byOther.clearedBodies], ["superseded", replacement.id, 1]);
});

test("SUB-425: a removal combined with an unresolved duplicate, a lost project and an unresolved pair leaves the crest readable on both devices and resolves what it removes", async (context) => {
  const fx = await sharedLibrary(context, "combined");
  // One key written on both devices before either delivers: an unresolved duplicate (SUB-413).
  const beforeA = await fx.entries(fx.homeA);
  const onA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-SHARED", "Oystercatcher feeding on the mussel beds")));
  const deliverA = await fx.holdNew(fx.homeA, beforeA);
  await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-425-SHARED", "Oystercatcher feeding on the cockle beds", { occurredAt: instant(6) })));
  // Two cards about one thing, one on each device: an unresolved pair (SUB-310).
  const beforeB = await fx.entries(fx.homeB);
  const pairB = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-425-PAIR-B", "Redshank alarm call near the sluice gate", { occurredAt: instant(7) })));
  const deliverB = await fx.holdNew(fx.homeB, beforeB);
  await deliverA();
  const pairA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-PAIR-A", "Redshank alarm call near the sluice", { occurredAt: instant(8) })));
  await deliverB();
  // A card whose project is deleted after it was written (SUB-414 R16).
  const lost = await as(fx.homeA, async () => (await createProject(fx.workspace, { occurredAt: instant(9), externalKey: "SUB-425-LOST", name: "Lost" })).projects.find((project) => project.externalKey === "SUB-425-LOST").id);
  const orphan = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-ORPHAN", "Whimbrel passage count", { occurredAt: instant(10), scope: "project", projectId: lost })));
  await as(fx.homeA, () => deleteProject(fx.workspace, { occurredAt: instant(11), id: lost }));
  const named = await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
  assert.deepEqual([named.unresolvedDuplicates?.map((entry) => entry.id), named.unresolvedConflicts, named.unresolvedScopes?.map((entry) => entry.id)],
    [[onA.id], [[pairA.id, pairB.id].sort()], [orphan.id]], "each is named, and no read refuses the crest");
  assert.equal((await as(fx.homeB, () => refusalOf(() => validateKnowledgeStore(fx.workspace))))?.reasonCode, "KNOWLEDGE_LINK_INVALID");

  // Removing each resolves it: the duplicate's id (every version), one card of the pair, the orphan.
  const remove = (home, id, second, reason = "invalid") => as(home, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(second), id, reason, basis: `${id} removed by the combined case`, actor: ACTOR }));
  // Each device clears what its own stream holds of the removed cards when it writes: B its version
  // of the duplicate at once, A its version at its next write, and B the pair's card at its next.
  const duplicate = await remove(fx.homeB, onA.id, 20, "duplicate");
  assert.deepEqual([duplicate.reasonCode, duplicate.clearedBodies], ["KNOWLEDGE_UNIT_REMOVED", 1]);
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), onA.id)).map((entry) => entry.present), [true]);
  const pair = await remove(fx.homeA, pairB.id, 21);
  assert.deepEqual([pair.reasonCode, pair.clearedBodies], ["KNOWLEDGE_UNIT_REMOVED", 1], "A clears its version of the duplicate; the pair's card is in B's stream");
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeA), onA.id)).map((entry) => entry.present), [false]);
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeB), pairB.id)).map((entry) => entry.present), [true]);
  const lostCard = await remove(fx.homeB, orphan.id, 22);
  assert.deepEqual([lostCard.reasonCode, lostCard.clearedBodies], ["KNOWLEDGE_UNIT_REMOVED", 1], "B clears the pair's card; the orphan is in A's stream");
  assert.deepEqual((await bodyFilesOf(fx.crestStream(fx.homeB), pairB.id)).map((entry) => entry.present), [false]);
  for (const home of [fx.homeA, fx.homeB]) {
    const listed = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
    assert.deepEqual([listed.records.map((record) => record.id), Object.hasOwn(listed, "unresolvedDuplicates"), Object.hasOwn(listed, "unresolvedConflicts"), Object.hasOwn(listed, "unresolvedScopes")],
      [[pairA.id], false, false, false]);
    const removed = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" }));
    assert.deepEqual(removed.records.map((record) => record.id), [onA.id, orphan.id, pairB.id].sort(), "one removed record per id, the duplicate's versions among them");
    assert.equal((await as(home, () => validateKnowledgeStore(fx.workspace))).reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal((await as(home, () => readRecallCards(fx.workspace, { at: AT }))).projectCrestDegraded, null);
  }
});

test("SUB-425: a removal delivered before the card it removes waits for it, and two devices that each removed one card read the earlier removal", async (context) => {
  const fx = await sharedLibrary(context, "pending");
  const sanderling = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-SANDERLING", "Sanderling chase the waves")));
  await as(fx.homeB, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(7), id: sanderling.id, reason: "invalid", basis: "B found it wrong", actor: ACTOR }));
  // C has B's stream but not yet A's: the removal names a card C does not hold, and C reads on.
  const deliver = await fx.holdStream(fx.homeA);
  const waiting = await as(fx.homeC, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "all" }));
  assert.deepEqual([waiting.reasonCode, waiting.total], ["KNOWLEDGE_LIST_READY", 0]);
  assert.equal((await as(fx.homeC, () => validateKnowledgeStore(fx.workspace))).reasonCode, "KNOWLEDGE_STORE_VALID");
  await deliver();
  assert.deepEqual((await as(fx.homeC, () => listKnowledgeMetadata(fx.workspace, { at: AT }))).records, []);
  assertKept((await as(fx.homeC, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" }))).records[0], { id: sanderling.id, removal: { deviceId: DEVICE_B } });

  // A and B each remove one card before either sees the other's removal: both events stay, and the
  // earlier removal stands on every device.
  const knot = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-KNOT", "Knot wheel over the bay", { occurredAt: instant(8) })));
  const copyA = await fx.snapshot(fx.homeA);
  const removedOnA = await as(fx.homeA, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(12), id: knot.id, reason: "invalid", basis: "A: the bay count was wrong", actor: ACTOR }));
  assert.equal(removedOnA.clearedBodies, 1, "A cleared the body its own stream held");
  // B has received neither A's removal nor the deletion of the body.
  const deliverA = await fx.holdSince(fx.homeA, copyA);
  await as(fx.homeB, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(10), id: knot.id, reason: "duplicate", basis: "B: STORY-514 holds it", actor: ACTOR }));
  await deliverA();
  for (const home of [fx.homeA, fx.homeB, fx.homeC]) {
    const removed = (await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" }))).records.find((record) => record.id === knot.id);
    assertKept(removed, { id: knot.id, removal: { reason: "duplicate", basis: "B: STORY-514 holds it", deviceId: DEVICE_B, removedAt: instant(10) } });
    assert.equal((await as(home, () => validateKnowledgeStore(fx.workspace))).reasonCode, "KNOWLEDGE_STORE_VALID");
  }
  const removalEvents = [];
  for (const home of [fx.homeA, fx.homeB]) {
    for (const { event } of await streamEvents(fx.crestStream(home))) if (event.removal?.id === knot.id) removalEvents.push(event.deviceId);
  }
  assert.deepEqual(removalEvents.sort(), [DEVICE_A, DEVICE_B], "both removal events stay");
});

test("SUB-425: knowledge-remove checks its input before anything is written, and the status filter is one of three", async (context) => {
  const fx = await sharedLibrary(context, "input");
  const stilt = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-425-STILT", "Black-winged stilt on the scrape")));
  const base = { occurredAt: instant(7), id: stilt.id, reason: "invalid", basis: "wrong site", actor: ACTOR };
  const before = await fx.entries(fx.homeA);
  for (const [change, reasonCode] of [
    [{ reason: "obsolete" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ basis: "" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ basis: "   " }, "KNOWLEDGE_INPUT_INVALID"],
    [{ actor: "claude" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ actor: "system:engine" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ occurredAt: "yesterday" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ id: "knowledge:not-an-id" }, "KNOWLEDGE_INPUT_INVALID"],
    [{ id: deriveStableId("knowledge", "SUB-425-NOWHERE") }, "KNOWLEDGE_NOT_FOUND"],
  ]) {
    const refusal = await as(fx.homeA, () => refusalOf(() => removeKnowledgeUnit(fx.workspace, { ...base, ...change })));
    assert.equal(refusal?.reasonCode, reasonCode, JSON.stringify(change).slice(0, 80));
  }
  assert.deepEqual(await fx.entries(fx.homeA), before, "no refused removal wrote a file");
  assert.equal((await as(fx.homeA, () => refusalOf(() => removeKnowledgeUnit(fx.workspace, base, { scope: "user" }))))?.reasonCode, "KNOWLEDGE_NOT_FOUND",
    "the user crest holds no card before its first");
  const cliRefusal = await as(fx.homeA, () => refusalOf(() => runCli(["knowledge-remove", "--workspace", fx.workspace, "--at", instant(7), "--id", stilt.id,
    "--reason", "stale", "--basis", "wrong", "--actor", ACTOR], { write() {} })));
  assert.equal(cliRefusal?.reasonCode, "CLI_ARGUMENT_MALFORMED");
  const missing = await as(fx.homeA, () => refusalOf(() => runCli(["knowledge-remove", "--workspace", fx.workspace, "--at", instant(7), "--id", stilt.id, "--reason", "invalid"], { write() {} })));
  assert.equal(missing?.reasonCode, "CLI_ARGUMENT_MISSING", "the basis and the actor are required");
  assert.deepEqual([...KNOWLEDGE_REMOVAL_REASONS], ["superseded", "invalid", "duplicate"]);
  assert.deepEqual([...KNOWLEDGE_STATUS_FILTERS], ["valid", "removed", "all"]);
  // knowledge-list takes a card status only; recall also takes obsolete (TCRN-CROSS-SUB-426 R17 续作修订二).
  for (const [verb, status] of [[["knowledge-list"], "obsolete"], [["knowledge-list"], "gone"], [["recall", "--query", "stilt"], "gone"]]) {
    const refusal = await as(fx.homeA, () => refusalOf(() => runCli([verb[0], "--workspace", fx.workspace, "--at", AT, ...verb.slice(1), "--status", status], { write() {} })));
    assert.equal(refusal?.reasonCode, "CLI_ARGUMENT_MALFORMED", `${verb[0]} --status ${status}`);
  }
  assert.equal((await as(fx.homeA, () => refusalOf(() => listKnowledgeMetadata(fx.workspace, { at: AT, status: "gone" }))))?.reasonCode, "KNOWLEDGE_SELECTION_INVALID");
  // Where it was admitted, it is removed once, and what it removed is what every read answers.
  const removed = await as(fx.homeA, () => removeKnowledgeUnit(fx.workspace, base));
  assert.equal(removed.version, (await as(fx.homeA, () => validateKnowledgeStore(fx.workspace))).version);
});
