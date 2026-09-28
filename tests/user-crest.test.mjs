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
//
// TCRN-CROSS-SUB-413 (STORY-476 D7): the same two devices writing one external key before either
// delivers. The key's versions are an unresolved duplicate, named by list, a read of its id and
// recall, withheld from default selection and recall, and resolved by --supersedes naming the id;
// the same record twice is one card, and a forked, altered or self-contradicting stream is refused.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

// TCRN-CROSS-SUB-413: a knowledge verb's answer, as a host reads it from the CLI.
async function cli(args) {
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  return JSON.parse(output);
}

// Every committed event of one external key in a shared crest, read from disk, as the duplicate
// diagnostic names its versions: in the canonical order of the device ids.
async function versionsOnDisk(crest, externalKey) {
  const found = [];
  for (const deviceId of (await readdir(join(crest, "events"))).sort()) {
    for (const name of (await readdir(join(crest, "events", deviceId))).filter((entry) => entry.endsWith(".json")).sort()) {
      const event = JSON.parse(await readFile(join(crest, "events", deviceId, name), "utf8"));
      if (event.metadata.externalKey !== externalKey) continue;
      found.push({
        deviceId, sequence: event.sequence, eventHash: event.eventHash,
        updatedAt: event.metadata.updatedAt, subject: event.metadata.subject, bodySha256: event.metadata.bodySha256,
      });
    }
  }
  return found;
}

// TCRN-CROSS-SUB-413 (STORY-476 D7): the state R14 left refusing the whole crest. A writes a control
// card and then external key UC-SHARED-KEY about kestrels; before the folder delivers A's stream, B
// writes the same key about beavers. The folder then delivers A's stream.
async function sameKeyOnTwoDevices(shared) {
  const { workspace, deviceA, deviceB } = shared;
  const heron = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-HERON", { subject: "Heron wading depth" })));
  const kestrel = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-SHARED-KEY", {
    occurredAt: instant(3), subject: "Kestrel hover timing", summary: "Kestrel notes", snippet: "time the kestrel hover", body: "Body of A's kestrel version",
  })));
  await shared.hold(deviceA);
  const beaver = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-SHARED-KEY", {
    occurredAt: instant(4), subject: "Beaver dam height", summary: "Beaver notes", snippet: "measure the beaver dam", body: "Body of B's beaver version",
  })));
  await shared.deliver(deviceA);
  return { heron, kestrel, beaver, id: kestrel.id };
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

test("R15 D7 (SUB-413): one external key two devices wrote before either delivered is an unresolved duplicate, not a refusal of the crest: its versions leave default list and recall, list, a read of its id and recall name both devices and versions, and every other card reads, recalls and is written", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const { heron, beaver, id } = await sameKeyOnTwoDevices(shared);
  assert.deepEqual([beaver.reasonCode, beaver.id], ["KNOWLEDGE_UNIT_CREATED", id], "B saw no card under the key, and one external key is one id");
  const versions = await versionsOnDisk(shared.crest, "UC-SHARED-KEY");
  assert.deepEqual(versions.map((version) => version.subject).sort(), ["Beaver dam height", "Kestrel hover timing"]);
  assert.notEqual(versions[0].deviceId, versions[1].deviceId, "each version sits in its own device's stream");
  const bodyOf = (version) => (version.subject === "Kestrel hover timing" ? "Body of A's kestrel version" : "Body of B's beaver version");
  const entry = { id, externalKey: "UC-SHARED-KEY", versions };
  const expected = { reasonCode: "KNOWLEDGE_DUPLICATE", unresolvedDuplicates: [entry], withheldCards: 2 };

  for (const home of [deviceA, deviceB]) {
    const listed = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
    assert.equal(listed.reasonCode, "KNOWLEDGE_LIST_READY", "the crest reads on either device: no KNOWLEDGE_PARTIAL_STATE");
    assert.deepEqual(listed.unresolvedDuplicates, [entry], "the list names the key, both devices and their versions at its top");
    assert.equal(Object.hasOwn(listed, "unresolvedConflicts"), false);
    assert.deepEqual(sortedIds(listed.records), [heron.id], "neither version is a default answer; the control card is");
    const all = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user", selection: "all" }));
    assert.deepEqual(all.records.map((record) => `${record.id} ${record.subject}`).sort(),
      [`${heron.id} Heron wading depth`, `${id} Beaver dam height`, `${id} Kestrel hover timing`].sort(), "selection all lists each version");
    assert.deepEqual(all.unresolvedDuplicates, [entry]);

    // A read of the id answers every version, named by its device, with the same diagnostic.
    const snippet = await asDevice(home, () => readKnowledgeSnippet(workspace, id, { scope: "user" }));
    assert.deepEqual(snippet.unresolvedDuplicates, [entry], "a read of the id gives the same diagnostic");
    assert.deepEqual(snippet.versions.map((version) => [version.deviceId, version.sequence, version.eventHash, version.subject]),
      versions.map((version) => [version.deviceId, version.sequence, version.eventHash, version.subject]));
    assert.equal(Object.hasOwn(snippet, "subject"), false, "no version is answered as the card");
    const body = await asDevice(home, () => readKnowledgeBody(workspace, id, { at, scope: "user" }));
    assert.deepEqual(body.unresolvedDuplicates, [entry]);
    assert.deepEqual(body.versions.map((version) => [version.deviceId, version.body]), versions.map((version) => [version.deviceId, bodyOf(version)]));
    assert.equal(Object.hasOwn(body, "body"), false);
    // Another card reads as it always has, with nothing added.
    assert.deepEqual(await asDevice(home, () => readKnowledgeSnippet(workspace, heron.id, { scope: "user" })), {
      schemaVersion: "tcrn.knowledge-snippet.v1", scope: "user", id: heron.id,
      subject: "Heron wading depth", summary: "Summary UC-A-HERON", snippet: "Snippet UC-A-HERON", revision: 1,
    });

    // Recall gives every other user card and names the key, both devices and versions at its top.
    const read = await asDevice(home, () => readRecallCards(workspace, { at }));
    assert.deepEqual(read.cards.map((card) => [card.id, card.scope]), [[heron.id, "user"]]);
    assert.deepEqual(read.userCrestDegraded, expected);
    const answer = await asDevice(home, () => recallCli(workspace, "kestrel hover timing"));
    assert.deepEqual(answer.userCrestDegraded, expected);
    assert.deepEqual(answer.knowledgeStores.user, { reasonCode: "KNOWLEDGE_LIST_READY", cards: 1 });
    assert.equal(answer.records.some((record) => record.id === id), false, "no version is recalled");
    const control = await asDevice(home, () => recallCli(workspace, "heron wading depth"));
    assert.deepEqual(control.records.filter((record) => record.kind === "card").map((record) => record.id), [heron.id], "the control card is recalled");
  }
  // The CLI's list and read answers carry the diagnostic as core gives it.
  const listedByCli = await asDevice(deviceB, () => cli(["knowledge-list", "--workspace", workspace, "--at", at, "--scope", "user"]));
  assert.deepEqual([listedByCli.reasonCode, listedByCli.unresolvedDuplicates, listedByCli.total], ["KNOWLEDGE_LIST_READY", [entry], 1]);
  const readByCli = await asDevice(deviceA, () => cli(["knowledge-body", "--workspace", workspace, "--id", id, "--at", at, "--scope", "user"]));
  assert.deepEqual([readByCli.unresolvedDuplicates, readByCli.versions.length], [[entry], 2]);

  // An unrelated card is written on either device, and listed and recalled on both.
  const otter = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-OTTER", { subject: "Otter holt survey" })));
  const vole = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-VOLE", { subject: "Vole tunnel depth" })));
  assert.deepEqual([otter.reasonCode, vole.reasonCode], ["KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED"]);
  for (const home of [deviceA, deviceB]) {
    assert.deepEqual(sortedIds((await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }))).records), [heron.id, otter.id, vole.id].sort());
    assert.deepEqual((await asDevice(home, () => readRecallCards(workspace, { at }))).cards.map((card) => card.id).sort(), [heron.id, otter.id, vole.id].sort());
  }

  // A write that sees the key is refused as before, and one about a version's subject names the key.
  await expectReason("KNOWLEDGE_DUPLICATE", asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-SHARED-KEY", { subject: "Beaver lodge entrance" }))));
  const refused = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-KESTREL-3", { subject: "Kestrel hover timing" }))).then(() => null, (error) => error);
  assert.deepEqual([refused?.reasonCode, refused?.details?.conflicts], ["KNOWLEDGE_POSSIBLE_CONFLICT", [id]]);
  assert.deepEqual((await shared.events()).map((event) => event.externalKey).filter((key) => key === "UC-SHARED-KEY" || key === "UC-A-KESTREL-3"),
    ["UC-SHARED-KEY", "UC-SHARED-KEY"], "a refused write commits nothing");
});

test("R15 D7 (SUB-413): --supersedes naming the id resolves the duplicate on both devices: every version leaves default list and recall and stays readable by id, the diagnostic is gone and the new card is recalled at once", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const { heron, id } = await sameKeyOnTwoDevices(shared);
  const settled = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-KESTREL-SETTLED", {
    occurredAt: instant(8), subject: "Kestrel hover timing", summary: "Settled kestrel notes", snippet: "time the kestrel hover again",
    body: "The settled kestrel card.", supersedes: id,
  })));
  assert.deepEqual([settled.reasonCode, settled.superseded, settled.conflicts], ["KNOWLEDGE_UNIT_CREATED", id, undefined], "the write names the id it replaced");
  const answers = [];
  for (const home of [deviceA, deviceB]) {
    const listed = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
    assert.equal(Object.hasOwn(listed, "unresolvedDuplicates"), false, "the diagnostic is gone");
    assert.deepEqual(sortedIds(listed.records), [heron.id, settled.id].sort(), "no version is a default answer; the new card is");
    const all = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user", selection: "all" }));
    assert.deepEqual(all.records.filter((record) => record.id === id).map((record) => record.extensions.supersededBy), [settled.id, settled.id],
      "every version names the card that replaced it");
    const snippet = await asDevice(home, () => readKnowledgeSnippet(workspace, id, { scope: "user" }));
    assert.equal(Object.hasOwn(snippet, "unresolvedDuplicates"), false);
    const body = await asDevice(home, () => readKnowledgeBody(workspace, id, { at, scope: "user" }));
    assert.equal(Object.hasOwn(body, "unresolvedDuplicates"), false);
    assert.deepEqual(body.versions.map((version) => version.body).sort(), ["Body of A's kestrel version", "Body of B's beaver version"],
      "each version's body stays readable by its id");
    const read = await asDevice(home, () => readRecallCards(workspace, { at }));
    assert.equal(read.userCrestDegraded, null);
    assert.deepEqual(read.cards.map((card) => card.id).sort(), [heron.id, settled.id].sort());
    const answer = await asDevice(home, () => recallCli(workspace, "kestrel hover timing"));
    assert.equal(Object.hasOwn(answer, "userCrestDegraded"), false);
    assert.deepEqual(answer.records.filter((record) => record.kind === "card").map((record) => record.id), [settled.id], "the new card is recalled at once, and no version is");
    answers.push({ listed, all, snippet, body });
  }
  assert.deepEqual(answers[0], answers[1], "both devices read the same crest");
  assert.equal((await versionsOnDisk(shared.crest, "UC-SHARED-KEY")).length, 2, "both versions' events stay in their streams");
});

test("R15 D7 (SUB-413): both versions count toward the user crest's budget until --supersedes resolves the duplicate, and neither does after", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const full = "x".repeat(8_192);
  const subjects = ["Otter holt survey", "Newt pond census", "Badger sett mapping", "Heron colony count", "Stoat winter coat", "Hare form spotting", "Plover scrape watch",
    "Curlew call record", "Lizard basking rock", "Moth trap catalogue", "Grebe dive length", "Shrew burrow route", "Swift nest ledge", "Toad crossing night"];
  for (const [index, subject] of subjects.entries()) {
    await asDevice(deviceA, () => createKnowledgeUnit(workspace, card(`UC-A-FULL-${index}`, { subject, body: full })));
  }
  await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-SHARED-BUDGET", { subject: "Kestrel hover timing", body: full })));
  await shared.hold(deviceA);
  await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-SHARED-BUDGET", { subject: "Beaver dam height", body: full })));
  await shared.deliver(deviceA);
  const id = deriveStableId("knowledge", "UC-SHARED-BUDGET");
  // Fourteen cards and both versions are sixteen bodies of 8192 bytes: the whole budget, 131072.
  const refused = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-ONE-BYTE", { subject: "Wagtail roost tree", body: "w" }))).then(() => null, (error) => error);
  assert.deepEqual([refused?.reasonCode, refused?.details], ["KNOWLEDGE_LIMIT_EXCEEDED", { bodyBytes: 16 * 8_192 + 1, limit: 131_072 }], "both unresolved versions are live bytes");
  const settled = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-B-SETTLED", { subject: "Kestrel hover timing", body: "k", supersedes: id })));
  assert.equal(settled.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const after = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-FULL-AFTER", { subject: "Wagtail roost tree", body: full })));
  assert.equal(after.reasonCode, "KNOWLEDGE_UNIT_CREATED", "neither version holds budget once the id is superseded: 14 x 8192 + 1 + 8192 bytes fit");
});

test("R15 D7 (SUB-413): a version the metadata/body layout holds and a device's version of one key are a duplicate that names the layout as no device, and --supersedes resolves it", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB, crest, base } = { ...shared, base: dirname(dirname(shared.crest)) };
  const kestrel = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-SHARED-LEGACY", { subject: "Kestrel hover timing", body: "Legacy kestrel body" })));
  // Lay A's card out as an engine before events wrote it, then hold that layout back from B.
  const [stream] = await readdir(join(crest, "events"));
  const [eventName] = (await readdir(join(crest, "events", stream))).filter((name) => name.endsWith(".json"));
  const event = JSON.parse(await readFile(join(crest, "events", stream, eventName), "utf8"));
  const legacyHeld = join(base, "legacy-held");
  await mkdir(join(legacyHeld, "metadata"), { recursive: true });
  await mkdir(join(legacyHeld, "bodies"), { recursive: true });
  await writeFile(join(legacyHeld, "metadata", `${kestrel.id}.json`), canonicalJson(event.metadata));
  await writeFile(join(legacyHeld, "bodies", `${kestrel.id}.body`), await readFile(join(crest, "events", stream, event.body.file)));
  await rm(join(crest, "events"), { recursive: true, force: true });
  const beaver = await asDevice(deviceB, () => createKnowledgeUnit(workspace, card("UC-SHARED-LEGACY", { subject: "Beaver dam height", body: "Stream beaver body" })));
  for (const name of ["metadata", "bodies"]) await rename(join(legacyHeld, name), join(crest, name));

  const [streamVersion] = await versionsOnDisk(crest, "UC-SHARED-LEGACY");
  const entry = {
    id: beaver.id,
    externalKey: "UC-SHARED-LEGACY",
    versions: [streamVersion, {
      deviceId: null, sequence: null, eventHash: null,
      updatedAt: event.metadata.updatedAt, subject: "Kestrel hover timing", bodySha256: event.metadata.bodySha256,
    }],
  };
  const listed = await asDevice(deviceA, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
  assert.deepEqual([listed.unresolvedDuplicates, listed.total], [[entry], 0], "the layout's version is named with no device, after the device's");
  const body = await asDevice(deviceB, () => readKnowledgeBody(workspace, beaver.id, { at, scope: "user" }));
  assert.deepEqual(body.versions.map((version) => [version.deviceId, version.body]), [[streamVersion.deviceId, "Stream beaver body"], [null, "Legacy kestrel body"]]);

  const settled = await asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-A-SETTLED", { subject: "Kestrel hover timing", supersedes: beaver.id })));
  assert.deepEqual([settled.reasonCode, settled.superseded], ["KNOWLEDGE_UNIT_CREATED", beaver.id]);
  for (const home of [deviceA, deviceB]) {
    const resolved = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user" }));
    assert.equal(Object.hasOwn(resolved, "unresolvedDuplicates"), false);
    assert.deepEqual(sortedIds(resolved.records), [settled.id]);
  }
});

test("R15 D7 (SUB-413) negative: the same record written on two devices is one card, and a write that already sees the key is refused as before", async (context) => {
  const shared = await twoDevices(context);
  const { workspace, deviceA, deviceB } = shared;
  const input = card("UC-SAME-RECORD", { subject: "Kestrel hover timing" });
  const first = await asDevice(deviceA, () => createKnowledgeUnit(workspace, input));
  await expectReason("KNOWLEDGE_DUPLICATE", asDevice(deviceA, () => createKnowledgeUnit(workspace, card("UC-SAME-RECORD", { subject: "Beaver dam height" }))));
  await shared.hold(deviceA);
  const second = await asDevice(deviceB, () => createKnowledgeUnit(workspace, input));
  await shared.deliver(deviceA);
  assert.equal(second.id, first.id);
  assert.deepEqual((await shared.events()).map((event) => event.externalKey), ["UC-SAME-RECORD", "UC-SAME-RECORD"], "each device committed the record in its own stream");
  for (const home of [deviceA, deviceB]) {
    const listed = await asDevice(home, () => listKnowledgeMetadata(workspace, { at, scope: "user", selection: "all" }));
    assert.equal(Object.hasOwn(listed, "unresolvedDuplicates"), false, "one record twice is no duplicate");
    assert.deepEqual(sortedIds(listed.records), [first.id], "it is one card");
    assert.equal((await asDevice(home, () => readKnowledgeSnippet(workspace, first.id, { scope: "user" }))).subject, "Kestrel hover timing");
    const read = await asDevice(home, () => readRecallCards(workspace, { at }));
    assert.deepEqual([read.cards.map((card) => card.id), read.userCrestDegraded], [[first.id], null]);
    await expectReason("KNOWLEDGE_DUPLICATE", asDevice(home, () => createKnowledgeUnit(workspace, card("UC-SAME-RECORD", { subject: "Beaver dam height" }))));
  }
});

test("R15 D7 (SUB-413) negative: a forked or altered stream is still refused naming its device, and so is one stream that holds two different records for one id", async (context) => {
  const { base, home } = await device(context);
  const first = await library(base, "refusals");
  const heron = await createKnowledgeUnit(first.workspace, card("UC-HERON", { subject: "Heron wading depth" }));
  await createKnowledgeUnit(first.workspace, card("UC-OTTER", { subject: "Otter holt survey" }));
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  const stream = join(home, "crest", "events", deviceId);
  const aside = join(base, "aside");
  await mkdir(aside);
  const eventNames = (await readdir(stream)).filter((name) => name.endsWith(".json")).sort();
  const refusal = () => listKnowledgeMetadata(first.workspace, { at, scope: "user" }).then(() => null, (error) => error);

  // A fork: a second event at sequence 2.
  const forked = `00000002-${"f".repeat(64)}.json`;
  await writeFile(join(stream, forked), await readFile(join(stream, eventNames[1])));
  let refused = await refusal();
  assert.equal(refused?.reasonCode, "KNOWLEDGE_PARTIAL_STATE");
  assert.ok(refused.message.includes(`${deviceId}: event stream has a gap or fork at sequence 3`), refused.message);
  await rename(join(stream, forked), join(aside, forked));

  // An altered event: its bytes no longer hash to the name it carries.
  const original = await readFile(join(stream, eventNames[1]), "utf8");
  await writeFile(join(stream, eventNames[1]), original.replace("Otter holt survey", "Otter holt census"));
  refused = await refusal();
  assert.equal(refused?.reasonCode, "KNOWLEDGE_RECORD_INVALID");
  assert.ok(refused.message.includes(`${deviceId}/${eventNames[1]}: event hash`), refused.message);
  await writeFile(join(stream, eventNames[1]), original);
  assert.equal((await refusal()), null, "the restored stream reads");

  // A third event, validly chained and hashed, carrying a different record for the first card's id:
  // one writer scans before it writes, so no writer of this engine leaves a stream like that.
  const [heronEvent, otterEvent] = await Promise.all(eventNames.map(async (name) => JSON.parse(await readFile(join(stream, name), "utf8"))));
  const metadata = { ...heronEvent.metadata, subject: "Heron wading depth, revised" };
  const bodyFile = `00000003-${metadata.bodySha256}.body`;
  await writeFile(join(stream, bodyFile), await readFile(join(stream, heronEvent.body.file)));
  const unsigned = { schemaVersion: heronEvent.schemaVersion, deviceId, sequence: 3, occurredAt: metadata.updatedAt, priorHash: otterEvent.eventHash, metadata, body: { ...heronEvent.body, file: bodyFile } };
  const eventHash = canonicalSha256(unsigned);
  await writeFile(join(stream, `00000003-${eventHash}.json`), canonicalJson({ ...unsigned, eventHash }));
  refused = await refusal();
  assert.equal(refused?.reasonCode, "KNOWLEDGE_PARTIAL_STATE");
  assert.ok(refused.message.includes(`${heron.id}: writer ${deviceId} holds conflicting events for one knowledge id`), refused.message);
  assert.equal((await readRecallCards(first.workspace, { at })).userCrestDegraded?.reasonCode, "KNOWLEDGE_PARTIAL_STATE", "recall names the refusal");
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
