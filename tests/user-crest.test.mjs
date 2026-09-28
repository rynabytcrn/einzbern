// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-476 R5, AC3 at the core (TCRN-CROSS-SUB-310): the user-level crest. A card written
// with scope "user" lands in this user's crest -- `crest` in the device directory, or the place the
// device-level key crest.userPath names, which may be a cloud folder -- and not in the library it
// was written from. Any library recalls it, and its hit says scope "user" and its line 「用户」. A
// library's own write never reaches the user crest.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

  const conflictAttempts = await Promise.allSettled([
    runOnDevice(deviceOne, card("UC-CONFLICT-ONE", { subject: "Gull nesting location", summary: "Gull nest sites", snippet: "mark each gull nest" })),
    runOnDevice(deviceTwo, card("UC-CONFLICT-TWO", { subject: "Gull nesting location", summary: "Gull nest sites", snippet: "mark each gull nest" })),
  ]);
  assert.ok(conflictAttempts.some((attempt) => attempt.status === "rejected"), "a cross-device conflict is refused explicitly");
  const conflictEvents = [];
  for (const deviceId of streams) {
    for (const name of (await readdir(join(sharedCrest, "events", deviceId))).filter((entry) => entry.endsWith(".json"))) {
      const event = JSON.parse(await readFile(join(sharedCrest, "events", deviceId, name), "utf8"));
      if (event.metadata.externalKey.startsWith("UC-CONFLICT-")) conflictEvents.push({ deviceId, event });
    }
  }
  assert.ok(conflictEvents.length === 1 || conflictEvents.length === 2, "every accepted concurrent event remains in its own stream");
  for (const { deviceId, event } of conflictEvents) {
    assert.ok((await readFile(join(sharedCrest, "events", deviceId, event.body.file))).length > 0, "each accepted event keeps its body reference");
    assert.equal(event.metadata.extensions.coexistsWith, undefined, "a derived conflict projection is never written back as authority");
  }
  if (conflictEvents.length === 2) {
    await expectReason("KNOWLEDGE_POSSIBLE_CONFLICT", listKnowledgeMetadata(second.workspace, { at, scope: "user" }));
  } else {
    const afterRefusal = await listKnowledgeMetadata(second.workspace, { at, scope: "user", selection: "all" });
    assert.equal(afterRefusal.records.filter((record) => record.externalKey.startsWith("UC-CONFLICT-")).length, 1);
  }
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
