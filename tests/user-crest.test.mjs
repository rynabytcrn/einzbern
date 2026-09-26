// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-476 R5, AC3 at the core (TCRN-CROSS-SUB-310): the user-level crest. A card written
// with scope "user" lands in this user's crest -- `crest` in the device directory, or the place the
// device-level key crest.userPath names, which may be a cloud folder -- and not in the library it
// was written from. Any library recalls it, and its hit says scope "user" and its line 「用户」. A
// library's own write never reaches the user crest.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
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
  readKnowledgeBody,
  readKnowledgeSnippet,
} from "../dist/build/packages/core/src/knowledge-core.js";
import { applyMachineSettingSet, readUserCrestPath } from "../dist/build/packages/core/src/machine-settings.js";
import { recall, recallDocuments, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { formatRecallLine, readRecallCards, recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = "2026-09-26T12:00:00Z";
const instant = (second) => `2026-09-26T11:00:${String(second).padStart(2, "0")}Z`;

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
  assert.deepEqual((await readdir(crest)).sort(), ["bodies", "metadata", "store.json"]);
  assert.deepEqual(await readdir(join(crest, "metadata")), [`${created.id}.json`]);
  const marker = JSON.parse(await readFile(join(crest, "store.json"), "utf8"));
  assert.equal(marker.workspaceId, USER_CREST_ID);
  assert.match(marker.workspaceId, /^user-crest:[a-f0-9]{24}$/u);
  assert.equal(marker.version, 1);
  assert.ok((await stat(join(userCrestCachePath(home), "crest-views", "index.json"))).isFile());
  await assert.rejects(stat(userCrestLockPath(home)), { code: "ENOENT" }, "the user crest lock is given back");
  const stored = JSON.parse(await readFile(join(crest, "metadata", `${created.id}.json`), "utf8"));
  assert.equal(stored.scope, "user");
  assert.equal(stored.projectId, null);

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
  assert.deepEqual(await readdir(join(cloud, "crest", "metadata")), [`${created.id}.json`]);
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
  assert.equal(JSON.parse(await readFile(join(cloud, "crest", "store.json"), "utf8")).version, 2);
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
