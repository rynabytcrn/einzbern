// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-476 R5, AC3 at the core (TCRN-CROSS-SUB-310): the user-level crest. A card written
// with scope "user" lands in this user's crest -- `crest` in the device directory, or the place the
// device-level key crest.userPath names, which may be a cloud folder -- and not in the library it
// was written from. Any library recalls it, and its hit says scope "user" and its line 「用户」. A
// library's own write never reaches the user crest.
//
// TCRN-CROSS-SUB-310 R14 (MIN-235 D7): two devices sharing the crest through a folder that delivers
// late. A same-subject pair no writer saw is withheld and named, not a refusal of the whole crest
// (a); recovery never writes the root manifest (c); a committed write is answered as created (d);
// and a user crest that gave recall fewer cards than it holds is named at the top of recall. Each
// delay is the test's own step, so every case has one outcome. (b), a merge past the budget, is
// O-1's: only its diagnostic is asserted.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { userCrestCachePath, userCrestLockPath } from "../dist/build/packages/core/src/device-home.js";
import { acquireFileLock, createProject, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import {
  USER_CREST_ID,
  createKnowledgeUnit,
  initializeKnowledgeStore,
  listKnowledgeMetadata,
  recoverKnowledgeStore,
  readKnowledgeBody,
  readKnowledgeSnippet,
} from "../dist/build/packages/core/src/knowledge-core.js";
import { applyMachineSettingSet, readUserCrestPath } from "../dist/build/packages/core/src/machine-settings.js";
import { recall, recallDocuments, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { formatRecallLine, readRecallCards, recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = "2026-09-26T12:00:00Z";
const instant = (second) => `2026-09-26T11:00:${String(second).padStart(2, "0")}Z`;
const execFile = promisify(execFileCallback);

// A device directory of this test's own, so the user crest it writes is never another test's.
async function device(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-user-crest-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
    await rm(base, { recursive: true, force: true });
  });
  return { base, home };
}

async function library(base, name) {
  const workspace = join(base, name);
  await initializeLibrary({ root: workspace, createdAt: instant(0) });
  const state = await createProject(workspace, { occurredAt: instant(1), externalKey: `${name.toUpperCase()}-PROJECT`, name });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { workspace, state, projectId: state.projects[0].id };
}

function card(key, overrides = {}) {
  return {
    occurredAt: instant(2),
    externalKey: key,
    scope: "user",
    projectId: null,
    roleScopes: [],
    category: "workflow",
    kind: "guide",
    tags: ["lesson"],
    subject: `Subject ${key}`,
    summary: `Summary ${key}`,
    snippet: `Snippet ${key}`,
    accountableOwnerId: deriveStableId("owner", `${key}-OWNER`),
    sourceReferences: [`evidence://user-crest/${key.toLowerCase()}`],
    sourceDigest: canonicalSha256({ key }),
    supersedes: null,
    linkedWorkIds: [],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: [deriveStableId("evidence", `${key}-EVIDENCE`)],
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: `Body ${key}`,
    ...overrides,
  };
}

function cardHit(state, cards, query) {
  const documents = recallDocuments(recallInputsFromState(state, cards));
  return recall({ cacheKey: `user-crest-${query}`, checkpoint: query, documents: () => documents, query, tau: 0 }).records
    .find((hit) => hit.kind === "card");
}

async function expectReason(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

// Run `operation` as the device whose directory is `home`, and put this test's device back after.
async function asDevice(home, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try {
    return await operation();
  } finally {
    process.env.EINZBERN_HOME = previous;
  }
}

// The recall verb's answer, as a host reads it from the CLI.
async function recallCli(workspace, query) {
  let output = "";
  await runCli(["recall", "--workspace", workspace, "--at", at, "--query", query, "--tau", "0", "--allow-trailing", "true"], { write(value) { output += value; } });
  return JSON.parse(output);
}

const sortedIds = (records) => records.map((record) => record.id).sort();

// TCRN-CROSS-SUB-310 (MIN-235 D7): two devices, A (this test's device directory) and B, sharing one
// user crest through a folder that delivers files late. `hold` takes a device's whole stream out of
// the shared folder, as if the folder had not delivered it yet, and `deliver` puts it back;
// `holdLatest` takes out only the stream's newest event and body and answers the function that
// delivers them. Every step of the delay is the test's own, so each outcome is the only one.
async function twoDevices(context) {
  const { base, home: deviceA } = await device(context);
  const deviceB = join(base, "device-b");
  const crest = join(base, "synced", "crest");
  const held = join(base, "held");
  await mkdir(join(base, "synced"));
  await mkdir(held);
  const shared = await library(base, "shared");
  for (const home of [deviceA, deviceB]) {
    await asDevice(home, () => applyMachineSettingSet({ key: "crest.userPath", value: crest, occurredAt: at }));
  }
  const streamOf = async (home) => join(crest, "events", JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId);
  return {
    ...shared,
    crest,
    deviceA,
    deviceB,
    hold: async (home) => { const stream = await streamOf(home); await rename(stream, join(held, basename(stream))); },
    deliver: async (home) => { const stream = await streamOf(home); await rename(join(held, basename(stream)), stream); },
    holdLatest: async (home) => {
      const stream = await streamOf(home);
      const latest = (await readdir(stream)).filter((name) => name.endsWith(".json")).sort().at(-1);
      const names = [latest, JSON.parse(await readFile(join(stream, latest), "utf8")).body.file];
      for (const name of names) await rename(join(stream, name), join(held, name));
      return async () => { for (const name of names) await rename(join(held, name), join(stream, name)); };
    },
    // The body of the stream's newest event only: a folder can deliver an event before its body.
    holdLatestBody: async (home) => {
      const stream = await streamOf(home);
      const latest = (await readdir(stream)).filter((name) => name.endsWith(".json")).sort().at(-1);
      const name = JSON.parse(await readFile(join(stream, latest), "utf8")).body.file;
      await rename(join(stream, name), join(held, name));
      return async () => { await rename(join(held, name), join(stream, name)); };
    },
    // Every committed event in the shared crest: its device's stream, its card's external key, and
    // the conflicts its writer recorded.
    events: async () => {
      const found = [];
      for (const deviceId of (await readdir(join(crest, "events"))).sort()) {
        for (const name of (await readdir(join(crest, "events", deviceId))).filter((entry) => entry.endsWith(".json")).sort()) {
          const event = JSON.parse(await readFile(join(crest, "events", deviceId, name), "utf8"));
          found.push({ deviceId, externalKey: event.metadata.externalKey, coexistsWith: event.metadata.extensions.coexistsWith ?? null });
        }
      }
      return found;
    },
  };
}

async function treeSnapshot(root) {
  const files = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${relative}/`);
      else files[relative] = (await readFile(join(directory, entry.name))).toString("base64");
    }
  };
  await walk(root, "");
  return files;
}

test("476-R5 / AC3: a user card lands in <device>/crest, not in its library, and another library recalls it as scope user", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "first");
  const second = await library(base, "second");
  const created = await createKnowledgeUnit(first.workspace, card("UC-WOMBAT", {
    subject: "Wombat burrow etiquette", summary: "How to enter a wombat burrow", snippet: "knock before entering the burrow",
  }));
  assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.equal(created.scope, "user", "the answer says which store the card went to");

  // The first write laid the user crest out in the device directory, bound to the user-crest
  // identity rather than to a library id, with its index view in this device's cache.
  const crest = join(home, "crest");
  assert.deepEqual((await readdir(crest)).sort(), ["events", "store.json"]);
  const marker = JSON.parse(await readFile(join(crest, "store.json"), "utf8"));
  assert.equal(marker.workspaceId, USER_CREST_ID);
  assert.match(marker.workspaceId, /^user-crest:[a-f0-9]{24}$/u);
  assert.equal(marker.authority, "metadata-index-authority-body-separate", "the marker keeps the existing V1 schema while events carry authority");
  assert.equal(marker.version, 0, "the root manifest is initialized once and never rewritten by card appends");
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  const stream = join(crest, "events", deviceId);
  const [eventName] = (await readdir(stream)).filter((name) => name.endsWith(".json"));
  const event = JSON.parse(await readFile(join(stream, eventName), "utf8"));
  assert.equal(event.metadata.id, created.id);
  assert.equal(event.metadata.scope, "user");
  assert.equal(event.metadata.projectId, null);
  assert.equal(event.priorHash, null);
  assert.equal((await readFile(join(stream, event.body.file), "utf8")), "Body UC-WOMBAT");
  assert.ok((await stat(join(userCrestCachePath(home), "crest-views", "index.json"))).isFile());
  await assert.rejects(stat(userCrestLockPath(home)), { code: "ENOENT" }, "the user crest lock is given back");

  // The library it was written from holds nothing.
  assert.equal((await listKnowledgeMetadata(first.workspace, { at, selection: "all" })).total, 0);

  // The second library has a card of its own; its recall reads both stores and labels each card.
  const own = await createKnowledgeUnit(second.workspace, card("UC-PLATYPUS", {
    scope: "project", projectId: second.projectId, subject: "Platypus feeding schedule", summary: "When the platypus eats", snippet: "feed at dusk",
  }));
  assert.equal(own.scope, undefined, "a library's answer keeps the shape it always had");
  const read = await readRecallCards(second.workspace, { at });
  assert.deepEqual(read.cards.map((entry) => [entry.externalKey, entry.scope]), [["UC-PLATYPUS", "project"], ["UC-WOMBAT", "user"]]);
  assert.deepEqual([read.stores.project.reasonCode, read.stores.user.reasonCode], ["KNOWLEDGE_LIST_READY", "KNOWLEDGE_LIST_READY"]);
  assert.deepEqual([read.stores.project.cards, read.stores.user.cards], [1, 1]);

  const hit = cardHit(second.state, read.cards, "wombat burrow");
  assert.equal(hit?.id, created.id, "the user card is recalled in a library it was not written in");
  assert.equal(hit.scope, "user");
  assert.equal(formatRecallLine(hit), `[卡片 用户] Wombat burrow etiquette · ${created.id}`);
  const ownHit = cardHit(second.state, read.cards, "platypus feeding");
  assert.equal(ownHit?.id, own.id);
  assert.equal(ownHit.scope, "project");
  assert.equal(formatRecallLine(ownHit), `[卡片] Platypus feeding schedule · ${own.id}`, "a library card's line is unchanged");

  // And in the library it was written from.
  const firstRead = await readRecallCards(first.workspace, { at });
  assert.deepEqual(firstRead.cards.map((entry) => [entry.id, entry.scope]), [[created.id, "user"]]);
});

test("R13: a committed user event remains readable after interruption without a root-manifest recovery write", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "first");
  const second = await library(base, "second");
  const firstBefore = await treeSnapshot(first.workspace);
  const secondBefore = await treeSnapshot(second.workspace);
  const interrupted = createKnowledgeUnit(first.workspace, card("UC-RECOVERY", {
    subject: "Koala eucalyptus rotation", summary: "Move koalas between eucalyptus groves", snippet: "rotate koala groves",
  }), { faultAt: "after-metadata-write" });
  await expectReason("KNOWLEDGE_FAULT_INJECTED", interrupted);
  const crest = join(home, "crest");
  assert.deepEqual((await readdir(crest)).sort(), ["events", "store.json"]);
  const manifestBefore = await readFile(join(crest, "store.json"), "utf8");
  const recovered = await recoverKnowledgeStore(first.workspace, { scope: "user" });
  assert.deepEqual([recovered.reasonCode, recovered.recovered], ["KNOWLEDGE_RECOVERY_NOT_NEEDED", false]);
  assert.equal(await readFile(join(crest, "store.json"), "utf8"), manifestBefore, "recovery leaves the static root manifest unchanged");
  assert.deepEqual(await treeSnapshot(first.workspace), firstBefore, "the caller library keeps every byte");
  assert.deepEqual(await treeSnapshot(second.workspace), secondBefore, "the other project library keeps every byte");

  const id = deriveStableId("knowledge", "UC-RECOVERY");
  const listed = await listKnowledgeMetadata(second.workspace, { at, scope: "user" });
  assert.deepEqual(listed.records.map((record) => [record.id, record.scope]), [[id, "user"]]);
  assert.equal((await readKnowledgeBody(second.workspace, id, { at, scope: "user" })).body, "Body UC-RECOVERY");
  assert.deepEqual(JSON.parse(await readFile(join(userCrestCachePath(home), "crest-views", "index.json"), "utf8")).records.map((record) => record.id), [id]);
});

test("R13: a legacy user crest stays readable as new events append, with its metadata and root marker untouched", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "legacy");
  const legacyCard = await createKnowledgeUnit(first.workspace, card("UC-LEGACY", { subject: "Wren nest material" }));
  const crest = join(home, "crest");
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  const eventDirectory = join(crest, "events", deviceId);
  const eventFile = (await readdir(eventDirectory)).find((name) => name.endsWith(".json"));
  const event = JSON.parse(await readFile(join(eventDirectory, eventFile), "utf8"));
  await mkdir(join(crest, "metadata"));
  await mkdir(join(crest, "bodies"));
  const legacyMetadataPath = join(crest, "metadata", `${legacyCard.id}.json`);
  const legacyBodyPath = join(crest, "bodies", `${legacyCard.id}.body`);
  await writeFile(legacyMetadataPath, canonicalJson(event.metadata));
  await writeFile(legacyBodyPath, await readFile(join(eventDirectory, event.body.file)));
  await rm(join(crest, "events"), { recursive: true, force: true });
  const legacyMarker = JSON.parse(await readFile(join(crest, "store.json"), "utf8"));
  legacyMarker.authority = "metadata-index-authority-body-separate";
  legacyMarker.version = 1;
  await writeFile(join(crest, "store.json"), canonicalJson(legacyMarker));
  const markerBefore = await readFile(join(crest, "store.json"), "utf8");
  const metadataBefore = await readFile(legacyMetadataPath, "utf8");

  assert.equal((await listKnowledgeMetadata(first.workspace, { at, scope: "user" })).total, 1);
  assert.equal((await readKnowledgeBody(first.workspace, legacyCard.id, { at, scope: "user" })).body, "Body UC-LEGACY");
  await createKnowledgeUnit(first.workspace, card("UC-APPENDED", { subject: "Raven feather collection" }));
  assert.equal((await listKnowledgeMetadata(first.workspace, { at, scope: "user", selection: "all" })).total, 2);
  assert.equal(await readFile(join(crest, "store.json"), "utf8"), markerBefore);
  assert.equal(await readFile(legacyMetadataPath, "utf8"), metadataBefore);
});

test("R13 D10: superseded user bodies remain auditable and leave active/default recall", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "supersede");
  const subject = "Pademelon shelter repair sequence";
  const old = await createKnowledgeUnit(first.workspace, card("UC-OLD-SHELTER", {
    subject, summary: "Outdated pademelon shelter instructions", snippet: "old shelter repair steps", body: "Archived body for the old shelter plan.",
  }));
  const replacement = await createKnowledgeUnit(first.workspace, card("UC-NEW-SHELTER", {
    subject, summary: "Current pademelon shelter instructions", snippet: "current shelter repair steps", body: "Current body for the shelter plan.", supersedes: old.id,
  }));
  const all = await listKnowledgeMetadata(first.workspace, { at, scope: "user", selection: "all" });
  const oldRecord = all.records.find((record) => record.id === old.id);
  assert.equal(oldRecord.extensions.supersededBy, replacement.id);
  assert.deepEqual((await listKnowledgeMetadata(first.workspace, { at, scope: "user" })).records.map((record) => record.id), [replacement.id]);
  assert.equal((await readKnowledgeBody(first.workspace, old.id, { at, scope: "user" })).body, "Archived body for the old shelter plan.");
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  const stream = join(home, "crest", "events", deviceId);
  assert.equal((await readdir(stream)).filter((name) => name.endsWith(".body")).length, 2, "both immutable body references stay on disk");
  const recallCards = await readRecallCards(first.workspace, { at });
  assert.deepEqual(recallCards.cards.map((entry) => entry.id), [replacement.id], "the superseded body is absent from the recall corpus");
  const recallResult = recall({
    cacheKey: "r13-user-superseded-card",
    checkpoint: recallCards.digest,
    documents: () => recallDocuments({ cards: recallCards.cards }),
    query: "outdated pademelon shelter",
    tau: 0,
  });
  assert.equal(recallResult.records.some((record) => record.id === old.id), false);
});

test("476-R5: crest.userPath puts the user crest in a cloud folder, stored as its real path, and reads and writes go there", async (context) => {
  const { base, home } = await device(context);
  const cloud = join(base, "cloud-storage");
  await mkdir(cloud);
  // A cloud folder is often reached through a link; the setting keeps the real path, because the
  // crest refuses a link on its way in.
  await symlink(cloud, join(base, "Cloud"));
  const settings = await applyMachineSettingSet({ key: "crest.userPath", value: join(base, "Cloud", "crest"), occurredAt: at });
  assert.equal(settings.values["crest.userPath"], join(cloud, "crest"));
  assert.equal(await readUserCrestPath(), join(cloud, "crest"));

  const first = await library(base, "first");
  const created = await createKnowledgeUnit(first.workspace, card("UC-QUOLL", { subject: "Quoll den survey", body: "Count the quoll dens at dawn." }));
  assert.equal((await readdir(join(cloud, "crest", "events"))).length, 1);
  await assert.rejects(stat(join(home, "crest")), { code: "ENOENT" }, "the default place stays empty");

  const listed = await listKnowledgeMetadata(first.workspace, { at, scope: "user" });
  assert.equal(listed.scope, "user");
  assert.deepEqual(listed.records.map((record) => record.id), [created.id]);
  assert.equal((await readKnowledgeSnippet(first.workspace, created.id, { scope: "user" })).subject, "Quoll den survey");
  const body = await readKnowledgeBody(first.workspace, created.id, { at, scope: "user" });
  assert.equal(body.body, "Count the quoll dens at dawn.");
  assert.equal(body.scope, "user");
  // The library's crest is still read by default, and it does not have the card.
  await expectReason("KNOWLEDGE_NOT_FOUND", readKnowledgeSnippet(first.workspace, created.id));
  await expectReason("KNOWLEDGE_INPUT_INVALID", listKnowledgeMetadata(first.workspace, { at, scope: "device" }));

  // A second user card joins the same cloud crest.
  await createKnowledgeUnit(first.workspace, card("UC-NUMBAT", { subject: "Numbat termite diet" }));
  assert.equal((await listKnowledgeMetadata(first.workspace, { at, scope: "user" })).total, 2);
  assert.equal(JSON.parse(await readFile(join(cloud, "crest", "store.json"), "utf8")).version, 0);
});

test("R13 D7: simultaneous writes from two devices append separate streams and both cards survive", async (context) => {
  const { base, home: deviceOne } = await device(context);
  const second = await library(base, "shared-library");
  const sharedParent = join(base, "synced");
  const sharedCrest = join(sharedParent, "crest");
  await mkdir(sharedParent);
  const previous = process.env.EINZBERN_HOME;
  let runOnDevice;
  const deviceTwo = join(base, "second-device");
  try {
    process.env.EINZBERN_HOME = deviceOne;
    await applyMachineSettingSet({ key: "crest.userPath", value: sharedCrest, occurredAt: at });
    process.env.EINZBERN_HOME = deviceTwo;
    await applyMachineSettingSet({ key: "crest.userPath", value: sharedCrest, occurredAt: at });
    await mkdir(deviceTwo, { recursive: true });
    process.env.EINZBERN_HOME = previous;

    const moduleUrl = new URL("../dist/build/packages/core/src/knowledge-core.js", import.meta.url).href;
    runOnDevice = async (home, input) => {
      const payload = Buffer.from(JSON.stringify({ workspace: second.workspace, input })).toString("base64");
      const source = `import { createKnowledgeUnit } from ${JSON.stringify(moduleUrl)}; const { workspace, input } = JSON.parse(Buffer.from(${JSON.stringify(payload)}, "base64").toString("utf8")); await createKnowledgeUnit(workspace, input);`;
      return execFile(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, EINZBERN_HOME: home } });
    };
    await Promise.all([
      runOnDevice(deviceOne, card("UC-DEVICE-ONE", { subject: "Marmot burrow safety", summary: "Marmot burrow notes", snippet: "mark the marmot burrow" })),
      runOnDevice(deviceTwo, card("UC-DEVICE-TWO", { subject: "Saffron finch hatch timing", summary: "Finch hatch notes", snippet: "check the saffron finch nest" })),
    ]);
  } finally {
    process.env.EINZBERN_HOME = previous;
  }

  const streams = await readdir(join(sharedCrest, "events"));
  assert.equal(streams.length, 2, "each device owns one append-only stream");
  for (const deviceId of streams) assert.equal((await readdir(join(sharedCrest, "events", deviceId))).filter((name) => name.endsWith(".json")).length, 1);
  const listed = await listKnowledgeMetadata(second.workspace, { at, scope: "user", selection: "all" });
  assert.deepEqual(listed.records.map((record) => record.externalKey).sort(), ["UC-DEVICE-ONE", "UC-DEVICE-TWO"]);
  assert.equal((await readKnowledgeBody(second.workspace, deriveStableId("knowledge", "UC-DEVICE-ONE"), { at, scope: "user" })).body, "Body UC-DEVICE-ONE");
  assert.equal((await readKnowledgeBody(second.workspace, deriveStableId("knowledge", "UC-DEVICE-TWO"), { at, scope: "user" })).body, "Body UC-DEVICE-TWO");
  assert.equal(JSON.parse(await readFile(join(sharedCrest, "store.json"), "utf8")).version, 0);
  // Two cards about different things hold nothing back: recall reads the user crest whole.
  const recalled = await readRecallCards(second.workspace, { at });
  assert.deepEqual(recalled.cards.filter((entry) => entry.scope === "user").map((entry) => entry.externalKey).sort(), ["UC-DEVICE-ONE", "UC-DEVICE-TWO"]);
  assert.equal(recalled.userCrestDegraded, null);
  // TCRN-CROSS-SUB-310 (R14 (d)): the two same-subject writes this test once raced -- and then
  // accepted whichever of a refusal or two committed events came out -- are the deterministic
  // cases below: the refusal when the other card has arrived, the committed pair when it has not.
});

test("R14 (a) D7: a same-subject card B wrote before A's stream arrived is withheld with its pair; every other user card is read, recalled and written, and --supersedes resolves the pair", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const marmot = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-MARMOT", {
    subject: "Marmot burrow safety", summary: "Marmot burrow notes", snippet: "mark the marmot burrow",
  })));
  const gullA = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL", { subject: "Gull nesting location" })));
  await shared.hold(deviceA);
  const gullB = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL", { subject: "Gull nesting location" })));
  assert.deepEqual([gullB.reasonCode, gullB.conflicts], ["KNOWLEDGE_UNIT_CREATED", undefined], "B saw no gull card, so nothing refused it");
  assert.equal(Object.hasOwn(await asDevice(deviceB, () => recallCli(workspace, "gull nesting location")), "userCrestDegraded"), false,
    "before the folder delivers A's stream there is nothing to hold back");
  await shared.deliver(deviceA);

  const pair = [gullA.id, gullB.id].sort();
  for (const home of [deviceA, deviceB]) {
    const listed = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
    assert.equal(listed.reasonCode, "KNOWLEDGE_LIST_READY", "the crest still reads on either device");
    assert.deepEqual(listed.unresolvedConflicts, [pair], "the pair is named");
    assert.deepEqual(sortedIds(listed.records), [marmot.id], "only the pair leaves default selection");
    const all = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user", selection: "all" }));
    assert.deepEqual(sortedIds(all.records), [marmot.id, ...pair].sort(), "selection all lists both cards of the pair");
    assert.deepEqual(all.unresolvedConflicts, [pair]);
  }
  // Both cards of the pair stay readable, and neither event was rewritten with a conflict mark.
  assert.equal((await asDevice(deviceA, () => readKnowledgeBody(workspace, gullB.id, { at, scope: "user" }))).body, "Body UC-B-GULL");
  assert.equal((await asDevice(deviceB, () => readKnowledgeSnippet(workspace, gullA.id, { scope: "user" }))).subject, "Gull nesting location");
  assert.deepEqual((await shared.events()).filter((event) => event.externalKey.includes("GULL")).map((event) => [event.externalKey, event.coexistsWith]).sort(),
    [["UC-A-GULL", null], ["UC-B-GULL", null]]);

  // Recall gives every other user card and says at its top which it held back and why.
  const expected = { reasonCode: "KNOWLEDGE_POSSIBLE_CONFLICT", unresolvedConflicts: [pair], withheldCards: 2 };
  const read = await asDevice(deviceA, () => readRecallCards(workspace, { at }));
  assert.deepEqual(read.cards.map((entry) => [entry.id, entry.scope]), [[marmot.id, "user"]]);
  assert.deepEqual(read.userCrestDegraded, expected);
  assert.equal(cardHit(shared.state, read.cards, "marmot burrow")?.id, marmot.id);
  const answer = await asDevice(deviceA, () => recallCli(workspace, "marmot burrow safety"));
  assert.deepEqual(answer.userCrestDegraded, expected);
  assert.deepEqual(answer.knowledgeStores.user, { reasonCode: "KNOWLEDGE_LIST_READY", cards: 1 });
  assert.deepEqual(answer.records.filter((record) => record.kind === "card").map((record) => [record.id, record.scope]), [[marmot.id, "user"]]);

  // An unrelated card is written as ever, on either device, and recalled.
  const otter = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-OTTER", { subject: "Otter holt survey" })));
  assert.equal(otter.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.deepEqual((await asDevice(deviceB, () => readRecallCards(workspace, { at }))).cards.map((entry) => entry.id).sort(), [marmot.id, otter.id].sort());

  // A new card on the same subject is refused, naming both cards of the pair.
  const refused = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL-3", { subject: "Gull nesting location" }))).then(() => null, (error) => error);
  assert.deepEqual([refused?.reasonCode, refused?.details?.conflicts], ["KNOWLEDGE_POSSIBLE_CONFLICT", pair]);

  // --supersedes naming one card of the pair resolves it. The write saw the pair's other card and
  // is admitted beside it, which the new card records.
  const replacement = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL-2", {
    subject: "Gull nesting location", supersedes: gullB.id,
  })));
  assert.deepEqual([replacement.reasonCode, replacement.superseded, replacement.conflicts], ["KNOWLEDGE_UNIT_CREATED", gullB.id, [gullA.id]]);
  for (const home of [deviceA, deviceB]) {
    const resolved = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
    assert.equal(Object.hasOwn(resolved, "unresolvedConflicts"), false, "no pair is left");
    assert.deepEqual(sortedIds(resolved.records), [marmot.id, gullA.id, otter.id, replacement.id].sort(), "the pair's other card returns; the superseded one leaves");
    assert.deepEqual(resolved.records.find((record) => record.id === replacement.id).extensions.coexistsWith, [gullA.id]);
  }
  const after = await asDevice(deviceA, () => recallCli(workspace, "gull nesting location"));
  assert.equal(Object.hasOwn(after, "userCrestDegraded"), false);
  assert.deepEqual(after.records.filter((record) => record.kind === "card").map((record) => record.id).sort(), [gullA.id, replacement.id].sort());
});

test("R14 (a) D7 negative: with A's stream delivered, B's same-subject card is refused before anything is written, and one writer's own cards form no pair", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const gullA = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL", { subject: "Gull nesting location" })));
  const refused = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL", { subject: "Gull nesting location" }))).then(() => null, (error) => error);
  assert.deepEqual([refused?.reasonCode, refused?.details?.conflicts], ["KNOWLEDGE_POSSIBLE_CONFLICT", [gullA.id]], "the refusal is explicit and names A's card");
  assert.deepEqual((await shared.events()).map((event) => event.externalKey), ["UC-A-GULL"], "nothing of B's card was committed");

  // One writer scans before it writes: its supersede beside its own same-subject card is admitted,
  // recorded, and forms no pair.
  const heron = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-HERON", { subject: "Heron wading depth" })));
  const moved = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL-2", { subject: "Gull nesting location", supersedes: heron.id })));
  assert.deepEqual([moved.reasonCode, moved.conflicts], ["KNOWLEDGE_UNIT_CREATED", [gullA.id]]);
  for (const home of [deviceA, deviceB]) {
    const listed = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
    assert.equal(Object.hasOwn(listed, "unresolvedConflicts"), false);
    assert.deepEqual(sortedIds(listed.records), [gullA.id, moved.id].sort());
    assert.equal((await asDevice(home, () => readRecallCards(workspace, { at }))).userCrestDegraded, null);
  }
});

test("R14 (a) D7: cards one writer wrote -- here the metadata/body layout, whose supersede beside a same-subject card recorded nothing -- form no pair", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "one-writer");
  const gull = await createKnowledgeUnit(first.workspace, card("UC-GULL", { subject: "Gull nesting location" }));
  const heron = await createKnowledgeUnit(first.workspace, card("UC-HERON", { subject: "Heron wading depth" }));
  const moved = await createKnowledgeUnit(first.workspace, card("UC-GULL-MOVED", { subject: "Gull nesting location", supersedes: heron.id }));
  // Lay the three cards out as an engine before events wrote them: one metadata file and one body
  // each, the replacement carrying no coexistsWith.
  const crest = join(home, "crest");
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  const stream = join(crest, "events", deviceId);
  await mkdir(join(crest, "metadata"));
  await mkdir(join(crest, "bodies"));
  for (const name of (await readdir(stream)).filter((entry) => entry.endsWith(".json"))) {
    const event = JSON.parse(await readFile(join(stream, name), "utf8"));
    const metadata = { ...event.metadata, extensions: {} };
    await writeFile(join(crest, "metadata", `${metadata.id}.json`), canonicalJson(metadata));
    await writeFile(join(crest, "bodies", `${metadata.id}.body`), await readFile(join(stream, event.body.file)));
  }
  await rm(join(crest, "events"), { recursive: true, force: true });

  const listed = await listKnowledgeMetadata(first.workspace, { at, scope: "user" });
  assert.equal(Object.hasOwn(listed, "unresolvedConflicts"), false, "one writer saw its own earlier card before it wrote");
  assert.deepEqual(sortedIds(listed.records), [gull.id, moved.id].sort());
  assert.equal((await readRecallCards(first.workspace, { at })).userCrestDegraded, null);
});

test("R14 (a) D7: two devices that each supersede the same card before either delivers keep the crest readable; the two replacements form a pair that --supersedes resolves", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const gullA = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL", { subject: "Gull nesting location" })));
  await shared.hold(deviceA);
  const gullB = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL", { subject: "Gull nesting location" })));
  await shared.deliver(deviceA);
  // Each device resolves the pair by replacing B's card; A's replacement has not reached B.
  const byA = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL-FIX", {
    occurredAt: instant(5), subject: "Gull nesting location", supersedes: gullB.id,
  })));
  const deliverA = await shared.holdLatest(deviceA);
  const byB = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL-FIX", {
    occurredAt: instant(6), subject: "Gull nesting location", supersedes: gullB.id,
  })));
  assert.deepEqual([byA.conflicts, byB.conflicts], [[gullA.id], [gullA.id]]);
  await deliverA();

  const listed = await asDevice(deviceB, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
  assert.equal(listed.reasonCode, "KNOWLEDGE_LIST_READY", "competing replacements no longer refuse the crest");
  assert.deepEqual(listed.unresolvedConflicts, [[byA.id, byB.id].sort()]);
  assert.deepEqual(sortedIds(listed.records), [gullA.id]);
  const all = await asDevice(deviceA, () => listKnowledgeMetadata(workspace, { at, scope: "user", selection: "all" }));
  assert.equal(all.records.find((record) => record.id === gullB.id).extensions.supersededBy, byB.id, "the replaced card names its latest replacement");
  assert.equal((await asDevice(deviceA, () => readRecallCards(workspace, { at }))).userCrestDegraded.withheldCards, 2);

  const settled = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL-SETTLED", {
    occurredAt: instant(7), subject: "Gull nesting location", supersedes: byB.id,
  })));
  assert.deepEqual(settled.conflicts, [gullA.id, byA.id].sort());
  const resolved = await asDevice(deviceB, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
  assert.equal(Object.hasOwn(resolved, "unresolvedConflicts"), false);
  assert.deepEqual(sortedIds(resolved.records), [gullA.id, byA.id, settled.id].sort());
});

test("R14 (d) D7: a write whose event is committed is answered as created, though A's same-subject event arrives between B's scan and B's answer", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const gullA = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-GULL", { subject: "Gull nesting location" })));
  // The folder will deliver A's event before its body, so a read of the crest after B's commit
  // could only refuse: B's answer must not depend on one.
  const deliverBody = await shared.holdLatestBody(deviceA);
  await shared.hold(deviceA);
  // B has read the crest before, so B's write reads this device's cached index view, which a
  // scan does after it has read every stream: that is when the folder delivers A's event.
  assert.equal((await asDevice(deviceB, () => listKnowledgeMetadata(workspace, { at, scope: "user" }))).total, 0);
  let delivered = false;
  const written = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-GULL", { subject: "Gull nesting location" }), {
    beforeDescriptorReadForTest: async (path) => {
      if (delivered || basename(path) !== "index.json") return;
      delivered = true;
      await shared.deliver(deviceA);
    },
  }));
  assert.equal(delivered, true, "A's event arrived while B's write was under way");
  assert.deepEqual([written.reasonCode, written.id, written.version, written.conflicts],
    ["KNOWLEDGE_UNIT_CREATED", deriveStableId("knowledge", "UC-B-GULL"), 1, undefined], "the answer is the committed write's own");
  // The answer matches the disk: B's event is committed beside A's, each in its own stream.
  const events = await shared.events();
  assert.deepEqual(events.map((event) => event.externalKey).sort(), ["UC-A-GULL", "UC-B-GULL"]);
  assert.notEqual(events[0].deviceId, events[1].deviceId);
  await expectReason("KNOWLEDGE_PARTIAL_STATE", asDevice(deviceB, () => listKnowledgeMetadata(workspace, { at, scope: "user" })));
  // Once A's body arrives, the next read names the pair the delivery formed rather than refusing.
  await deliverBody();
  const listed = await asDevice(deviceB, () => listKnowledgeMetadata(workspace, { at, scope: "user", selection: "all" }));
  assert.deepEqual(listed.unresolvedConflicts, [[gullA.id, written.id].sort()]);
  assert.deepEqual(sortedIds(listed.records), [gullA.id, written.id].sort());
});

test("R14 (b) diagnostic only: a merge past the user crest's budget is named at the top of CLI recall (O-1 pending: nothing else about it is asserted)", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const subjectsA = ["Otter holt survey", "Kestrel hover timing", "Newt pond census", "Badger sett mapping", "Heron colony count", "Vole tunnel depth", "Stoat winter coat", "Hare form spotting", "Plover scrape watch"];
  const subjectsB = ["Beaver dam height", "Curlew call record", "Lizard basking rock", "Moth trap catalogue", "Grebe dive length", "Shrew burrow route", "Swift nest ledge", "Toad crossing night", "Wagtail roost tree"];
  for (const [index, subject] of subjectsA.entries()) {
    await asDevice(deviceA, () => createKnowledgeUnit(workspace, card(`UC-A-BUDGET-${index}`, { subject, body: "x".repeat(8_000) })));
  }
  await shared.hold(deviceA);
  for (const [index, subject] of subjectsB.entries()) {
    await asDevice(deviceB, () => createKnowledgeUnit(workspace, card(`UC-B-BUDGET-${index}`, { subject, body: "x".repeat(8_000) })));
  }
  assert.equal(Object.hasOwn(await asDevice(deviceB, () => recallCli(workspace, "beaver dam height")), "userCrestDegraded"), false,
    "each device's own cards are within the budget");
  await shared.deliver(deviceA);
  const answer = await asDevice(deviceA, () => recallCli(workspace, "beaver dam height"));
  assert.equal(answer.userCrestDegraded?.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED", "the degraded user crest is named at the top of the answer");
});

test("R14 (c) D7: recovering a crest that holds the metadata/body layout, event streams and a stale claim leaves store.json untouched, and reads and writes go on", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "mixed");
  // A card in the metadata/body layout an engine before events wrote, with that engine's marker...
  const legacyCard = await createKnowledgeUnit(first.workspace, card("UC-LEGACY-WREN", { subject: "Wren nest material" }));
  const crest = join(home, "crest");
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  const stream = join(crest, "events", deviceId);
  const event = JSON.parse(await readFile(join(stream, (await readdir(stream)).find((name) => name.endsWith(".json"))), "utf8"));
  await mkdir(join(crest, "metadata"));
  await mkdir(join(crest, "bodies"));
  await writeFile(join(crest, "metadata", `${legacyCard.id}.json`), canonicalJson(event.metadata));
  await writeFile(join(crest, "bodies", `${legacyCard.id}.body`), await readFile(join(stream, event.body.file)));
  await rm(join(crest, "events"), { recursive: true, force: true });
  const legacyMarker = JSON.parse(await readFile(join(crest, "store.json"), "utf8"));
  legacyMarker.version = 1;
  await writeFile(join(crest, "store.json"), canonicalJson(legacyMarker));
  // ...an event this engine appended beside it...
  const eventCard = await createKnowledgeUnit(first.workspace, card("UC-EVENT-RAVEN", { subject: "Raven feather collection" }));
  const manifest = await readFile(join(crest, "store.json"));
  // ...and the claim an interrupted writer of that layout left.
  const claim = (pid) => canonicalJson({
    schemaVersion: "tcrn.knowledge-mutation-claim.v1", workspaceId: USER_CREST_ID, version: 1, token: "a".repeat(48), pid, acquiredAt: instant(30),
  });

  // Negative: a claim a live process holds is not taken over, and nothing is written.
  await writeFile(join(crest, "mutation.claim"), claim(process.pid));
  await expectReason("KNOWLEDGE_LOCKED", recoverKnowledgeStore(first.workspace, { scope: "user" }));
  assert.deepEqual(await readFile(join(crest, "store.json")), manifest);
  assert.ok((await stat(join(crest, "mutation.claim"))).isFile(), "the live claim stays");

  // Positive: the claim of a writer that is gone is recovered, and the root manifest keeps every byte.
  await writeFile(join(crest, "mutation.claim"), claim(process.pid + 1_000_000));
  const recovered = await recoverKnowledgeStore(first.workspace, { scope: "user" });
  assert.deepEqual([recovered.reasonCode, recovered.recovered, recovered.version], ["KNOWLEDGE_RECOVERED", true, 2]);
  assert.deepEqual(await readFile(join(crest, "store.json")), manifest, "recovery persists no projected marker");
  assert.deepEqual((await readdir(crest)).sort(), ["bodies", "events", "metadata", "store.json"], "the claim is released");
  assert.deepEqual(sortedIds((await listKnowledgeMetadata(first.workspace, { at, scope: "user" })).records), [legacyCard.id, eventCard.id].sort());
  assert.equal((await readKnowledgeBody(first.workspace, legacyCard.id, { at, scope: "user" })).body, "Body UC-LEGACY-WREN");
  const later = await createKnowledgeUnit(first.workspace, card("UC-EVENT-HERON", { subject: "Heron wading depth" }));
  assert.deepEqual([later.reasonCode, later.version], ["KNOWLEDGE_UNIT_CREATED", 3]);
  assert.equal((await listKnowledgeMetadata(first.workspace, { at, scope: "user" })).total, 3);
  assert.deepEqual(await readFile(join(crest, "store.json")), manifest);
  assert.equal((await recoverKnowledgeStore(first.workspace, { scope: "user" })).reasonCode, "KNOWLEDGE_RECOVERY_NOT_NEEDED");
});

test("476-R5: a library write never reaches the user crest, and a user card names no project, role or work", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "first");
  await createKnowledgeUnit(first.workspace, card("UC-PROJECT-ONLY", { scope: "project", projectId: first.projectId, subject: "Bilby nest lining" }));
  await createKnowledgeUnit(first.workspace, card("UC-WORKSPACE-ONLY", { scope: "workspace", subject: "Echidna spine care" }));
  await createKnowledgeUnit(first.workspace, card("UC-ROLE-ONLY", { scope: "role", roleScopes: ["implementation"], subject: "Dingo fence repair" }));
  await assert.rejects(stat(join(home, "crest")), { code: "ENOENT" }, "no library write lays the user crest out");
  const user = await listKnowledgeMetadata(first.workspace, { at, scope: "user" });
  assert.deepEqual([user.total, user.records], [0, []], "an unwritten user crest lists nothing rather than failing");
  assert.equal((await listKnowledgeMetadata(first.workspace, { at, selection: "all" })).total, 3);
  await expectReason("KNOWLEDGE_NOT_FOUND", readKnowledgeSnippet(first.workspace, deriveStableId("knowledge", "UC-PROJECT-ONLY"), { scope: "user" }));

  const work = deriveStableId("work", "UC-WORK");
  await expectReason("KNOWLEDGE_LINK_INVALID", createKnowledgeUnit(first.workspace, card("UC-NAMES-PROJECT", { projectId: first.projectId })));
  await expectReason("KNOWLEDGE_LINK_INVALID", createKnowledgeUnit(first.workspace, card("UC-NAMES-ROLE", { roleScopes: ["implementation"] })));
  await expectReason("KNOWLEDGE_LINK_INVALID", createKnowledgeUnit(first.workspace, card("UC-LINKS-WORK", { linkedWorkIds: [work] })));
  await assert.rejects(stat(join(home, "crest")), { code: "ENOENT" }, "a refused user card lays nothing out");
});

test("476-R5: a write and a read of the user crest each wait for this machine's locks/user-crest.lock", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "first");
  await mkdir(join(home, "locks"), { recursive: true });
  const settle = (promise) => {
    const state = { done: false };
    return { state, promise: promise.then((value) => { state.done = true; return value; }) };
  };
  const pause = () => new Promise((resolve) => { setTimeout(resolve, 150); });

  let held = await acquireFileLock(userCrestLockPath(home));
  const write = settle(createKnowledgeUnit(first.workspace, card("UC-KOALA", { subject: "Koala eucalyptus rotation" })));
  await pause();
  assert.equal(write.state.done, false, "the write waits while another process holds the lock");
  await assert.rejects(stat(join(home, "crest")), { code: "ENOENT" }, "and has not touched the crest");
  await held.release();
  assert.equal((await write.promise).reasonCode, "KNOWLEDGE_UNIT_CREATED");

  held = await acquireFileLock(userCrestLockPath(home));
  const read = settle(listKnowledgeMetadata(first.workspace, { at, scope: "user" }));
  await pause();
  assert.equal(read.state.done, false, "the read waits too");
  await held.release();
  assert.equal((await read.promise).total, 1);
});
