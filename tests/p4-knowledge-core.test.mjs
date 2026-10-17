// SPDX-License-Identifier: Apache-2.0

import { testDeviceHome } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeCoreError,
  checkKnowledgeSources,
  createKnowledgeUnit,
  knowledgeLinkIndexCountsForTest,
  createProject,
  createWork,
  deleteProject,
  deleteWork,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  materializeWorkspace,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  recoverKnowledgeStore,
  reverifyKnowledgeUnit,
  validateKnowledgeStore,
  acquireFileLock,
  cachePath,
  lockPath,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { calculateKnowledgeSourceDigest, readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (day, second = 0) => `2026-07-${String(day).padStart(2, "0")}T14:00:${String(second).padStart(2, "0")}Z`;
const joinParts = (parts, separator) => parts.join(separator);
const credentialReference = () => joinParts(["https://", "user", ":", "secret", "@", "example.test/current"], "");
const privateReference = () => joinParts(["/", "Users", "/source/current"], "");

function knowledgeAjv() {
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addKeyword({
    keyword: "x-tcrn-maxUtf8Bytes",
    schemaType: "number",
    type: "string",
    validate: (maximumBytes, value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
  });
  return ajv;
}

async function workspaceFixture({ externalKey = "FIXTURE-KNOWLEDGE-CORE", initialize = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p4-knowledge-")));
  const workspace = join(base, "workspace");
  // The library id follows the fixture key, so two fixtures with one key hold byte-identical chains.
  await initializeLibrary({ root: workspace, createdAt: instant(11), libraryId: deriveStableId("library", externalKey) });
  let state = await createProject(workspace, {
    occurredAt: instant(11, 1),
    externalKey: "FIXTURE-KNOWLEDGE-PROJECT",
    name: "Knowledge Fixture",
  });
  state = await createWork(workspace, {
    occurredAt: instant(11, 2),
    projectId: state.projects[0].id,
    externalKey: "FIXTURE-KNOWLEDGE-WORK",
    kind: "Initiative",
    parentId: null,
    status: "active",
  });
  if (initialize) await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return {
    base,
    workspace,
    store: join(workspace, DIRECTORY.knowledge),
    // TCRN-CROSS-STORY-469 R4: the knowledge index view is this device's cache, not a file in crest/.
    indexView: join(cachePath(deriveStableId("library", externalKey), testDeviceHome), "crest-views", "index.json"),
    projectId: state.projects[0].id,
    workId: state.work[0].id,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function unitInput(fixture, key, options = {}) {
  return {
    expectedVersion: options.expectedVersion ?? 0,
    occurredAt: options.occurredAt ?? instant(11, 3),
    externalKey: key,
    scope: options.scope ?? "project",
    projectId: options.projectId === undefined ? fixture.projectId : options.projectId,
    roleScopes: options.roleScopes ?? [],
    category: options.category ?? "implementation",
    kind: options.kind ?? "guide",
    tags: options.tags ?? ["knowledge", "workflow"],
    subject: options.subject ?? `Subject ${key}`,
    summary: options.summary ?? `Summary ${key}`,
    snippet: options.snippet ?? `Snippet ${key}`,
    accountableOwnerId: options.accountableOwnerId ?? deriveStableId("owner", `${key}-OWNER`),
    sourceReferences: options.sourceReferences ?? [`evidence://fixture/${key.toLowerCase()}`],
    sourceDigest: options.sourceDigest === undefined ? canonicalSha256({ key, source: "current-explicit" }) : options.sourceDigest,
    supersedes: options.supersedes ?? null,
    linkedWorkIds: options.linkedWorkIds ?? [fixture.workId],
    linkedDecisionIds: options.linkedDecisionIds ?? [deriveStableId("decision", `${key}-DECISION`)],
    linkedGateIds: options.linkedGateIds ?? [deriveStableId("gate", `${key}-GATE`)],
    linkedEvidenceIds: options.linkedEvidenceIds ?? [deriveStableId("evidence", `${key}-EVIDENCE`)],
    lifecycle: options.lifecycle ?? "active",
    retrievalDisposition: options.retrievalDisposition ?? "default",
    freshnessState: options.freshnessState ?? "fresh",
    lastVerified: options.lastVerified === undefined ? instant(11, 2) : options.lastVerified,
    stalenessPolicy: options.stalenessPolicy ?? { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: options.exportDisposition ?? "metadata-only",
    body: options.body ?? `Body ${key}`,
    // TCRN-CROSS-STORY-365: this fixture writes a family of cards that differ only by
    // key, so the write-time conflict scorer sees each one as a possible duplicate of
    // the last. That is the scorer being right about a deliberate fixture, so the
    // fixture states the writer's answer once instead of per case.
    coexist: options.coexist ?? true,
  };
}

async function expectReason(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

function settle(operation) {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function cliJson(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

// TCRN-CROSS-SUB-414: a library's crest keeps each card as a record in the writing device's event
// stream, crest/events/<device id>/. The stream of this test process's device.
async function streamRoot(fixture) {
  const [deviceId] = await readdir(join(fixture.store, "events"));
  return join(fixture.store, "events", deviceId);
}

// The latest event this device's stream holds for a card, with its path and its body file's.
async function cardEvent(fixture, id) {
  const root = await streamRoot(fixture);
  let found = null;
  for (const name of (await readdir(root)).filter((entry) => entry.endsWith(".json")).sort()) {
    const event = JSON.parse(await readFile(join(root, name), "utf8"));
    if (event.metadata.id === id) found = { path: join(root, name), event, bodyPath: event.body === null ? null : join(root, event.body.file) };
  }
  return found;
}

// TCRN-CROSS-SUB-414: the crest as an engine before event streams left it -- one metadata file and
// one body file per card, the marker's version counting its writes. This lays the fixture's crest
// down that way, every record as the streams hold it now, and takes the streams away, so the read
// and write paths that still meet such a crest keep their proof.
async function asOlderEngineCrest(fixture) {
  const at = "2099-01-01T00:00:00Z";
  const all = await listKnowledgeMetadata(fixture.workspace, { at, selection: "all", limit: 1_000_000 });
  const marker = await readKnowledgeStoreMarker(fixture.workspace);
  const root = await streamRoot(fixture);
  const bodies = new Map();
  for (const name of (await readdir(root)).filter((entry) => entry.endsWith(".body"))) bodies.set(name.slice(9, -5), await readFile(join(root, name)));
  await mkdir(join(fixture.store, "metadata"));
  await mkdir(join(fixture.store, "bodies"));
  for (const record of all.records) {
    await writeFile(join(fixture.store, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(fixture.store, "bodies", `${record.id}.body`), bodies.get(record.bodySha256));
  }
  const storeJson = join(fixture.store, "store.json");
  await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rm(join(fixture.store, "events"), { recursive: true });
}

// TCRN-CROSS-SUB-308: nothing writes lifecycle "retired" any more, but a store an older engine
// wrote may hold such a record. This lays one down the way that engine's knowledge-retire left
// it -- the metadata at the next revision, lifecycle "retired", the body reclaimed -- so the read
// and write paths that still meet one keep their proof. TCRN-CROSS-SUB-414: that engine wrote the
// metadata/body layout, so the crest is laid down that way first (asOlderEngineCrest).
async function retireByHand(fixture, id) {
  if (await stat(join(fixture.store, "events")).then(() => true, () => false)) await asOlderEngineCrest(fixture);
  const path = join(fixture.store, "metadata", `${id}.json`);
  const metadata = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, canonicalJson({ ...metadata, lifecycle: "retired", revision: metadata.revision + 1 }));
  await rm(join(fixture.store, "bodies", `${id}.body`));
}

function deterministicPermutations(values) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (remaining.length === 0) {
      result.push(prefix);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  visit([], values);
  return result;
}

test("WSC-1: real workspace knowledge admission requires explicit disposability acknowledgment", async () => {
  const fixture = await workspaceFixture({ externalKey: "REAL-WORKSPACE-ONE", initialize: false });
  try {
    await expectReason("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", () => initializeKnowledgeStore(fixture.workspace));
    const result = await initializeKnowledgeStore(fixture.workspace, { disposableAcknowledged: true });
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    assert.equal(result.admission, "acknowledged-disposable");
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-STORY-469: a library has no workspace key to carry the FIXTURE- mark, so no library is
// admitted implicitly; every initialization acknowledges that the store is disposable.
test("WSC-1: a library is never admitted without the acknowledgment", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-ADMISSION", initialize: false });
  try {
    await expectReason("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", () => initializeKnowledgeStore(fixture.workspace));
    const result = await initializeKnowledgeStore(fixture.workspace, { disposableAcknowledged: true });
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    assert.equal(result.admission, "acknowledged-disposable");
  } finally {
    await fixture.close();
  }
});

test("WSC-1: knowledge-init CLI round-trips the acknowledgment flag", async () => {
  const fixture = await workspaceFixture({ externalKey: "REAL-WORKSPACE-CLI", initialize: false });
  try {
    let output = "";
    await runCli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], { write: (value) => { output += value; } });
    const result = JSON.parse(output);
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    assert.equal(result.admission, "acknowledged-disposable");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-SUB-414 (MIN-235 D7): a chain write no longer leaves a library's crest behind -- every
// read projects it at the chain head it replayed -- so there is nothing for a rebase to re-bind. The
// rebase stays the full re-validation against that head, and writes nothing.
test("WSC-2, SUB-414: a chain write leaves the crest current, and knowledge-rebase re-validates it without a write", async () => {
  const fixture = await workspaceFixture();
  try {
    const manifest = await readFile(join(fixture.store, "store.json"));
    const advanced = await createProject(fixture.workspace, { occurredAt: instant(20, 2), externalKey: "FIXTURE-KNOWLEDGE-PROJECT-TWO", name: "Two" });
    const validation = await validateKnowledgeStore(fixture.workspace);
    assert.equal(validation.reasonCode, "KNOWLEDGE_STORE_VALID", "the crest answers at the advanced head with no rebase");
    assert.equal(validation.eventHighWaterDigest, advanced.headEventHash);
    const result = await rebaseKnowledgeStore(fixture.workspace, { at: instant(20, 3) });
    assert.equal(result.reasonCode, "KNOWLEDGE_STORE_REBASED");
    assert.equal(result.retired, 0);
    assert.deepEqual(result.offenders, []);
    assert.deepEqual([result.version, result.eventHighWaterDigest], [validation.version, advanced.headEventHash], "the rebase answers the projection it re-validated");
    assert.deepEqual(await readFile(join(fixture.store, "store.json")), manifest, "and writes nothing: store.json is the bytes initialization wrote");
    assert.deepEqual(await readdir(fixture.store), ["store.json"]);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

// SUB-386: a dangling work link is reported through rebase and remains attached to the card;
// rebase does not become another retirement path.
test("WSC-2: knowledge-rebase reports dangling work without retiring the record", async () => {
  const fixture = await workspaceFixture();
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "REBASE-OFFENDER", {}));
    await deleteWork(fixture.workspace, { occurredAt: instant(21, 2), id: fixture.workId });
    const rebased = await rebaseKnowledgeStore(fixture.workspace, { at: instant(21, 3), retireInvalid: true });
    assert.equal(rebased.reasonCode, "KNOWLEDGE_STORE_REBASED");
    assert.deepEqual(rebased.danglingWorkLinks, [{ knowledgeId: created.id, workIds: [fixture.workId] }]);
    assert.deepEqual((await validateKnowledgeStore(fixture.workspace)).danglingWorkLinks,
      [{ knowledgeId: created.id, workIds: [fixture.workId] }]);
    const { event } = await cardEvent(fixture, created.id);
    assert.equal((await readdir(await streamRoot(fixture))).filter((name) => name.endsWith(".json")).length, 1, "the rebase appended no record");
    assert.deepEqual([event.metadata.lifecycle, event.metadata.revision], ["active", 1], "the record remains active and unmodified");
    assert.deepEqual(event.metadata.linkedWorkIds, [fixture.workId], "the dangling link stays attached");
    assert.equal((await readKnowledgeBody(fixture.workspace, created.id, { at: instant(21, 4) })).body, "Body REBASE-OFFENDER");
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false, "the rebase takes no mutation claim");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-SUB-414 (R16, C-R16-1): the scope/project offender under the new semantics. A project
// deleted under a live card used to refuse every read and write of the crest with
// KNOWLEDGE_LINK_INVALID, and the rebase with KNOWLEDGE_REBASE_BLOCKED, with no way out (the
// retire-invalid escape went with SUB-308, and a supersede could not pass the read). Now the card is
// named as `unresolvedScopes` and leaves default selection; every other card reads and is written;
// the rebase still refuses with KNOWLEDGE_REBASE_BLOCKED and the id-sorted offender list, and
// validate and a checkpoint with KNOWLEDGE_LINK_INVALID, each naming the card and the remedy; a
// write of the card itself is refused naming it; and a card superseding it lets all three answer.
// It also pins the project index's tombstone exclusion (CQ-10): keep a deleted project in the index
// and the card is never named.
test("WSC-2, SUB-414 R16: a project deleted under a live card names it as the rebase's offender with the remedy, and a card superseding it lets the rebase answer", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-GONE-PROJECT" });
  try {
    const gone = (await createProject(fixture.workspace, { occurredAt: instant(20, 1), externalKey: "FIXTURE-KNOWLEDGE-GONE", name: "Gone" }))
      .projects.find((project) => project.externalKey === "FIXTURE-KNOWLEDGE-GONE").id;
    const orphan = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "REBASE-SCOPE-OFFENDER", { projectId: gone, linkedWorkIds: [] }));
    const kept = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "REBASE-SCOPE-KEPT"));
    await deleteProject(fixture.workspace, { occurredAt: instant(20, 2), id: gone });
    const { event } = await cardEvent(fixture, orphan.id);
    const unresolvedScopes = [{ id: orphan.id, deviceId: event.deviceId, sequence: event.sequence, eventHash: event.eventHash, projectId: gone }];
    const details = { unresolvedScopes, remedy: `write a card with knowledge-create --supersedes ${orphan.id}` };
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(21) });
    assert.deepEqual(listed.records.map((record) => record.id), [kept.id], "the offender leaves default selection");
    assert.deepEqual(listed.unresolvedScopes, unresolvedScopes);
    const blocked = await settle(rebaseKnowledgeStore(fixture.workspace, { at: instant(21, 1) }));
    assert.equal(blocked.reason?.reasonCode, "KNOWLEDGE_REBASE_BLOCKED");
    assert.equal(blocked.reason.message, orphan.id, "the refusal names the offender");
    assert.deepEqual(blocked.reason.details, details, "and the remedy");
    for (const strict of [() => validateKnowledgeStore(fixture.workspace), () => exportKnowledgeCheckpoint(fixture.workspace, instant(21))]) {
      const refused = await settle(strict());
      assert.deepEqual([refused.reason?.reasonCode, refused.reason?.message, refused.reason?.details], ["KNOWLEDGE_LINK_INVALID", `${orphan.id}:scope`, details]);
    }
    await expectReason("KNOWLEDGE_LINK_INVALID", () => reverifyKnowledgeUnit(fixture.workspace, { expectedRevision: 1, occurredAt: instant(21, 2), id: orphan.id }));
    assert.equal((await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "REBASE-SCOPE-UNRELATED", { occurredAt: instant(21, 2) }))).reasonCode, "KNOWLEDGE_UNIT_CREATED");
    const replacement = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "REBASE-SCOPE-REPLACEMENT", { occurredAt: instant(21, 3), supersedes: orphan.id }));
    assert.equal(replacement.superseded, orphan.id);
    const rebased = await rebaseKnowledgeStore(fixture.workspace, { at: instant(21, 4) });
    assert.deepEqual([rebased.reasonCode, rebased.retired, rebased.offenders], ["KNOWLEDGE_STORE_REBASED", 0, []]);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal(Object.hasOwn(await listKnowledgeMetadata(fixture.workspace, { at: instant(21) }), "unresolvedScopes"), false);
    assert.deepEqual((await cardEvent(fixture, orphan.id)).event, event, "the offender's record is the one it was written with");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-SUB-414: a rebase has no write for a fault point to interrupt, so a simulated crash
// never fires in it and it never leaves a claim. The one claim a crest can still hold is the crash
// journal an interrupted writer of the metadata/body layout left, and that locks the rebase, as it
// locks every write, until knowledge-recover completes it.
test("WSC-2, SUB-414: a rebase has no fault point, and a claim an interrupted older writer left locks it until recovery", async () => {
  const fixture = await workspaceFixture();
  try {
    await createProject(fixture.workspace, { occurredAt: instant(22, 2), externalKey: "FIXTURE-KNOWLEDGE-PROJECT-THREE", name: "Three" });
    const manifest = await readFile(join(fixture.store, "store.json"));
    const rebased = await rebaseKnowledgeStore(fixture.workspace, { at: instant(22, 4) }, { faultAt: "after-marker-write" });
    assert.equal(rebased.reasonCode, "KNOWLEDGE_STORE_REBASED", "there is no marker write to crash after");
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false);
    const marker = await readKnowledgeStoreMarker(fixture.workspace);
    await writeFile(join(fixture.store, "mutation.claim"), canonicalJson({
      schemaVersion: "tcrn.knowledge-mutation-claim.v1", workspaceId: marker.workspaceId, version: marker.version,
      token: "c".repeat(48), pid: process.pid + 1_000_000, acquiredAt: instant(22, 5),
    }));
    await expectReason("KNOWLEDGE_LOCKED", () => rebaseKnowledgeStore(fixture.workspace, { at: instant(22, 5) }));
    await expectReason("KNOWLEDGE_LOCKED", () => createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-WHILE-CLAIMED")));
    assert.equal((await recoverKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_RECOVERED");
    assert.equal((await rebaseKnowledgeStore(fixture.workspace, { at: instant(22, 6) })).reasonCode, "KNOWLEDGE_STORE_REBASED");
    assert.deepEqual(await readFile(join(fixture.store, "store.json")), manifest, "neither the rebase nor the recovery wrote store.json");
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-STORY-469 R4: the index view is this device's cache. Deleted or damaged, it is projected
// again by the next read instead of reading as a partial store, and another device, whose cache has
// never held it, reads the same store and projects its own.
test("469-R4: a library's knowledge index view is the device cache, rebuilt when missing or stale", async (t) => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-CACHE-VIEW" });
  t.after(() => fixture.close());
  await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-CACHE-VIEW"));
  const expected = await readFile(fixture.indexView, "utf8");
  assert.equal(JSON.parse(expected).records.length, 1);

  await rm(fixture.indexView);
  assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  assert.equal(await readFile(fixture.indexView, "utf8"), expected, "a missing view is projected again");
  await writeFile(fixture.indexView, "{not an index");
  assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).total, 1);
  assert.equal(await readFile(fixture.indexView, "utf8"), expected, "a damaged view is projected again");

  const otherDevice = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p4-other-device-")));
  const previous = process.env.EINZBERN_HOME;
  t.after(() => rm(otherDevice, { recursive: true, force: true }));
  try {
    process.env.EINZBERN_HOME = otherDevice;
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    const libraryId = deriveStableId("library", "FIXTURE-KNOWLEDGE-CACHE-VIEW");
    assert.equal(await readFile(join(cachePath(libraryId, otherDevice), "crest-views", "index.json"), "utf8"), expected, "the other device projects the same view");
  } finally {
    process.env.EINZBERN_HOME = previous;
  }
  assert.deepEqual((await readdir(fixture.store)).sort(), ["events", "store.json"], "no view was written into crest/");
});

// TCRN-CROSS-STORY-469 R3: a crest write takes this machine's lock of the library, the lock every
// chain write takes, and it lives in the device directory. While another writer holds it, the
// knowledge write waits, then lands.
test("469-R3: a crest write waits for this machine's lock of the library", async (t) => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-LOCK" });
  t.after(() => fixture.close());
  const holder = await acquireFileLock(lockPath(deriveStableId("library", "FIXTURE-KNOWLEDGE-LOCK"), testDeviceHome));
  let landed = false;
  const pending = createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-AFTER-LOCK")).then((result) => { landed = true; return result; });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  assert.equal(landed, false, "the write waits while another writer holds the lock");
  await holder.release();
  const created = await pending;
  assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.equal((await validateKnowledgeStore(fixture.workspace)).records, 1);
});

test("empty Knowledge bootstrap is closed, schema-valid, deterministic, and body-free", async () => {
  const fixture = await workspaceFixture();
  try {
    const validation = await validateKnowledgeStore(fixture.workspace);
    assert.equal(validation.reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal(validation.version, 0);
    assert.equal(validation.records, 0);
    // crest/ holds the store's own files; the library root keeps its seven entries; the derived
    // index view is in the device cache (TCRN-CROSS-STORY-469 R1, R4). TCRN-CROSS-SUB-414: before
    // its first card the crest is its root manifest alone; each device's first card lays out its
    // own event stream.
    assert.deepEqual((await readdir(fixture.store)).sort(), ["store.json"]);
    assert.deepEqual((await readdir(fixture.workspace)).sort(), [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);
    const index1 = await readFile(fixture.indexView, "utf8");
    const index2 = await readFile(fixture.indexView, "utf8");
    assert.equal(index1, index2);
    assert.deepEqual(JSON.parse(index1).records, []);
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/knowledge-core-v1.schema.json", import.meta.url), "utf8"));
    const ajv = knowledgeAjv();
    assert.equal(ajv.validate(schema, JSON.parse(await readFile(join(fixture.store, "store.json"), "utf8"))), true, JSON.stringify(ajv.errors));
  } finally {
    await fixture.close();
  }
});

test("metadata/body separation, default omission, explicit reads, freshness, and checkpoint policy are exact", async () => {
  const fixture = await workspaceFixture();
  try {
    const input = unitInput(fixture, "KNOWLEDGE-ALPHA");
    const created = await createKnowledgeUnit(fixture.workspace, input);
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.equal(created.version, 1);
    const id = created.id;
    // TCRN-CROSS-SUB-414: the card is one event in this device's stream: its metadata inside the
    // event, its body in a file of its own beside it.
    const written = await cardEvent(fixture, id);
    const metadataText = canonicalJson(written.event.metadata);
    const eventText = await readFile(written.path, "utf8");
    const bodyText = await readFile(written.bodyPath, "utf8");
    assert.equal(bodyText, input.body);
    assert.equal(eventText.includes(input.body), false);
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/knowledge-core-v1.schema.json", import.meta.url), "utf8"));
    const ajv = knowledgeAjv();
    assert.equal(ajv.validate(schema, JSON.parse(metadataText)), true, JSON.stringify(ajv.errors));
    // TCRN-CROSS-INC-282 (Owner ruling TCRN-CROSS-MIN-158 D1): the default selection is
    // every active card, so a card answers the default listing, the body read and the
    // checkpoint from the moment it is written, before any promotion step. Withholding it
    // until promotion is what made a written card unretrievable with no signal.
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" })).records.length, 1);
    assert.equal((await readKnowledgeSnippet(fixture.workspace, id)).snippet, input.snippet);
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12) })).body, input.body);
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12), allowUnpromoted: true })).body, input.body);
    const writtenCheckpoint = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
    assert.equal(writtenCheckpoint.includes(input.body), false);
    assert.equal(JSON.parse(writtenCheckpoint).records.length, 1, "the checkpoint corpus is the default selection, which a written card joins at once");
    // TCRN-CROSS-SUB-308: there is no promotion step to take; the written record is active.
    const stored = JSON.parse(metadataText);
    assert.equal(stored.lifecycle, "active");
    assert.equal(Object.hasOwn(stored, "promotionState"), false);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    const checkpoint = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
    assert.equal(checkpoint.includes(input.body), false);
    assert.equal(JSON.parse(checkpoint).records.length, 1);
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: instant(12) })).body, input.body);
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records[0].state, "fresh");
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, "2026-08-20T14:00:00Z")).records[0].state, "stale");
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: "2026-08-20T14:00:00Z" })).records.length, 0);
    await expectReason("KNOWLEDGE_BODY_ACCESS_DENIED", () => readKnowledgeBody(fixture.workspace, id, { at: "2026-08-20T14:00:00Z" }));
    assert.equal((await readKnowledgeBody(fixture.workspace, id, { at: "2026-08-20T14:00:00Z", allowStale: true })).body, input.body);
  } finally {
    await fixture.close();
  }
});

test("metadata-only surfaces never open bodies while explicit/full integrity paths do", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-METADATA-ONLY" });
  try {
    // TCRN-CROSS-INC-282: no promotion step remains; an active write is immediately eligible.
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-METADATA-ONLY"));
    const { bodyPath } = await cardEvent(fixture, created.id);
    const observed = [];
    const observation = { beforeDescriptorReadForTest: async (path) => { observed.push(path); } };
    await listKnowledgeMetadata(fixture.workspace, { at: instant(12), ...observation });
    await readKnowledgeSnippet(fixture.workspace, created.id, observation);
    await evaluateKnowledgeFreshness(fixture.workspace, instant(12), observation);
    await exportKnowledgeCheckpoint(fixture.workspace, instant(12), observation);
    assert.equal(observed.includes(bodyPath), false);
    observed.length = 0;
    await readKnowledgeBody(fixture.workspace, created.id, { at: instant(12), ...observation });
    assert.deepEqual(observed.filter((path) => path.endsWith(".body")), [bodyPath]);
    observed.length = 0;
    await validateKnowledgeStore(fixture.workspace, observation);
    assert.deepEqual(observed.filter((path) => path.endsWith(".body")), [bodyPath]);

    const backing = join(fixture.base, "body-backing");
    await rename(bodyPath, backing);
    await symlink(backing, bodyPath);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    assert.equal((await readKnowledgeSnippet(fixture.workspace, created.id)).id, created.id);
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records.length, 1);
    assert.equal(JSON.parse(await exportKnowledgeCheckpoint(fixture.workspace, instant(12))).records.length, 1);
    await expectReason("KNOWLEDGE_LINK_UNSAFE", () => validateKnowledgeStore(fixture.workspace));
    await expectReason("KNOWLEDGE_LINK_UNSAFE", () => readKnowledgeBody(fixture.workspace, created.id, { at: instant(12) }));
  } finally {
    await fixture.close();
  }
});

test("checkpoint is exactly the promoted fresh default-selection corpus", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-CHECKPOINT-PARITY" });
  try {
    const defaultUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-DEFAULT", {}));
    const explicitUnit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-EXPLICIT", {
      occurredAt: instant(11, 4), retrievalDisposition: "explicit-only",
    }));
    // TCRN-CROSS-INC-282: both cards are promoted at write; what keeps the explicit-only
    // card out of the checkpoint is its retrieval disposition, which is the point.
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12) });
    const checkpoint = JSON.parse(await exportKnowledgeCheckpoint(fixture.workspace, instant(12)));
    assert.deepEqual(checkpoint.records.map((record) => record.id), listed.records.map((record) => record.id));
    assert.deepEqual(checkpoint.records.map((record) => record.id), [defaultUnit.id]);
    assert.equal(checkpoint.records.some((record) => record.id === explicitUnit.id), false);
  } finally {
    await fixture.close();
  }
});

test("unknown freshness fails closed and metadata filters remain deterministic", async () => {
  const fixture = await workspaceFixture();
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-UNKNOWN", {
      freshnessState: "unknown",
      lastVerified: null,
      roleScopes: ["reviewer"],
      scope: "role",
      category: "testing",
      tags: ["review", "testing"],
    }));
    assert.equal((await evaluateKnowledgeFreshness(fixture.workspace, instant(12))).records[0].state, "fresh");
    // TCRN-CROSS-INC-282: an unknown-freshness card that computes fresh is an active card,
    // so the default selection carries it. It used to be withheld for being unpromoted.
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records.length, 1);
    const filtered = await listKnowledgeMetadata(fixture.workspace, {
      at: instant(12), selection: "all", roleScope: "reviewer", category: "testing", tag: "review", freshness: "fresh",
    });
    assert.equal(filtered.records.length, 1);
    assert.equal((await readKnowledgeBody(fixture.workspace, created.id, { at: instant(12), allowUnpromoted: true })).body, "Body KNOWLEDGE-UNKNOWN");
  } finally {
    await fixture.close();
  }
});

test("governed Knowledge CLI exposes init, validate, create, list, snippet, body, freshness, and checkpoint", async () => {
  const fixture = await workspaceFixture({ initialize: false, externalKey: "FIXTURE-KNOWLEDGE-CLI" });
  try {
    let output = "";
    await runCli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "KNOWLEDGE_STORE_INITIALIZED");
    const input = unitInput(fixture, "KNOWLEDGE-CLI");
    const createArguments = [
      "knowledge-create", "--workspace", fixture.workspace, "--at", input.occurredAt,
      "--external-key", input.externalKey, "--scope", input.scope, "--project-id", input.projectId,
      "--role-scopes", "-", "--category", input.category, "--kind", input.kind, "--tags", input.tags.join(","),
      "--subject", input.subject, "--summary", input.summary, "--snippet", input.snippet,
      "--accountable-owner-id", input.accountableOwnerId,
      "--source-references", input.sourceReferences.join(","), "--source-digest", input.sourceDigest,
      "--work-ids", input.linkedWorkIds.join(","), "--decision-ids", input.linkedDecisionIds.join(","),
      "--gate-ids", input.linkedGateIds.join(","), "--evidence-ids", input.linkedEvidenceIds.join(","),
      "--retrieval", input.retrievalDisposition, "--freshness", input.freshnessState,
      "--last-verified", input.lastVerified, "--stale-days", String(input.stalenessPolicy.maximumAgeDays),
      "--export", input.exportDisposition, "--body", input.body,
    ];
    // TCRN-CROSS-SUB-308: the candidate lifecycle is refused at the write, before the store
    // moves. TCRN-CROSS-SUB-311: --lifecycle is optional, and the write that leaves it out
    // lands active.
    const candidateArguments = [...createArguments, "--lifecycle", "candidate"];
    await expectReason("KNOWLEDGE_LIFECYCLE_RETIRED", () => runCli(candidateArguments, { write() {} }));
    assert.equal((await validateKnowledgeStore(fixture.workspace)).version, 0);
    output = "";
    await runCli(createArguments, { write: (value) => { output += value; } });
    const created = JSON.parse(output);
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    // A knowledge write answers the ids it wrote beside the store version (TCRN-CROSS-SUB-311).
    assert.deepEqual(created.ids, [created.id]);
    assert.equal(created.version, 1);
    for (const [command, extra, expected] of [
      ["knowledge-validate", [], "KNOWLEDGE_STORE_VALID"],
      ["knowledge-list", ["--at", instant(12), "--selection", "all"], "KNOWLEDGE_LIST_READY"],
      ["knowledge-freshness", ["--at", instant(12)], "KNOWLEDGE_FRESHNESS_EVALUATED"],
    ]) {
      output = "";
      await runCli([command, "--workspace", fixture.workspace, ...extra], { write: (value) => { output += value; } });
      assert.equal(JSON.parse(output).reasonCode, expected);
    }
    output = "";
    await runCli(["knowledge-snippet", "--workspace", fixture.workspace, "--id", created.id], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).snippet, input.snippet);
    output = "";
    await runCli(["knowledge-body", "--workspace", fixture.workspace, "--id", created.id, "--at", instant(12)],
      { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).body, input.body);
    // The promotion verb is gone: the card was retrievable from the write.
    await expectReason("CLI_COMMAND_UNKNOWN", () => runCli([
      "knowledge-promote", "--workspace", fixture.workspace, "--expected-revision", "1",
      "--at", instant(12, 1), "--id", created.id, "--state", "promoted",
    ], { write() {} }));
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    output = "";
    await runCli(["knowledge-checkpoint", "--workspace", fixture.workspace, "--at", instant(12)], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "KNOWLEDGE_CHECKPOINT_READY");
    await expectReason("KNOWLEDGE_SELECTION_INVALID", () => runCli([
      "knowledge-list", "--workspace", fixture.workspace, "--at", instant(12), "--selection", "everything",
    ], { write() {} }));
  } finally {
    await fixture.close();
  }
});

test("WSB-4: knowledge-create null sentinel '-' round-trips to null and the deprecated 'null' alias is byte-equivalent", async () => {
  const sentinelInput = (fixture) => unitInput(fixture, "KNOWLEDGE-SENTINEL", {
    scope: "workspace",
    projectId: null,
    roleScopes: [],
    linkedWorkIds: [],
    freshnessState: "unknown",
    lastVerified: null,
  });
  const listFlag = (values) => (values.length === 0 ? "-" : values.join(","));
  const createArguments = (fixture, projectSpelling, lastVerifiedSpelling) => {
    const input = sentinelInput(fixture);
    return [
      "knowledge-create", "--workspace", fixture.workspace, "--at", input.occurredAt,
      "--external-key", input.externalKey, "--scope", input.scope, "--project-id", projectSpelling,
      "--role-scopes", "-", "--category", input.category, "--kind", input.kind, "--tags", listFlag(input.tags),
      "--subject", input.subject, "--summary", input.summary, "--snippet", input.snippet,
      "--accountable-owner-id", input.accountableOwnerId,
      "--source-references", listFlag(input.sourceReferences), "--source-digest", input.sourceDigest,
      "--work-ids", listFlag(input.linkedWorkIds), "--decision-ids", listFlag(input.linkedDecisionIds),
      "--gate-ids", listFlag(input.linkedGateIds), "--evidence-ids", listFlag(input.linkedEvidenceIds),
      "--lifecycle", input.lifecycle, "--retrieval", input.retrievalDisposition, "--freshness", input.freshnessState,
      "--last-verified", lastVerifiedSpelling, "--stale-days", String(input.stalenessPolicy.maximumAgeDays),
      "--export", input.exportDisposition, "--body", input.body,
    ];
  };
  const storedRecord = async (fixture, created) => {
    const view = JSON.parse(await readFile(fixture.indexView, "utf8"));
    return view.records.find((entry) => entry.id === created.id);
  };
  const createViaCli = async (projectSpelling, lastVerifiedSpelling) => {
    const fixture = await workspaceFixture({ initialize: false, externalKey: "FIXTURE-KNOWLEDGE-SENTINEL" });
    await runCli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], { write() {} });
    let output = "";
    await runCli(createArguments(fixture, projectSpelling, lastVerifiedSpelling), { write: (value) => { output += value; } });
    const created = JSON.parse(output);
    return { fixture, created, output, record: await storedRecord(fixture, created) };
  };

  const dash = await createViaCli("-", "-");
  const alias = await createViaCli("null", "null");
  const programmatic = await workspaceFixture({ initialize: false, externalKey: "FIXTURE-KNOWLEDGE-SENTINEL" });
  try {
    assert.equal(dash.created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    // '-' is the canonical null spelling for both flags.
    assert.equal(dash.record.projectId, null);
    assert.equal(dash.record.lastVerified, null);
    // Deprecated 'null' alias produces a byte-identical committed record and envelope.
    assert.equal(alias.output, dash.output);
    assert.deepEqual(alias.record, dash.record);
    // The CLI '-' spelling round-trips to the same stored record as programmatic explicit nulls.
    await initializeKnowledgeStore(programmatic.workspace, { disposableAcknowledged: true });
    const direct = await createKnowledgeUnit(programmatic.workspace, sentinelInput(programmatic));
    const directRecord = await storedRecord(programmatic, direct);
    assert.deepEqual(directRecord, dash.record);
  } finally {
    await dash.fixture.close();
    await alias.fixture.close();
    await programmatic.close();
  }
});

test("selection and strict evaluation instants fail before Knowledge-store scanning", async () => {
  const empty = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-VALIDATION-ORDER" });
  try {
    let opened = false;
    const observer = { beforeDescriptorReadForTest: async () => { opened = true; } };
    await expectReason("KNOWLEDGE_SELECTION_INVALID", () => listKnowledgeMetadata(empty.workspace, {
      at: instant(12), selection: "candidate-leak", ...observer,
    }));
    assert.equal(opened, false);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => evaluateKnowledgeFreshness(empty.workspace, "2026-07-11", observer));
    assert.equal(opened, false);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => exportKnowledgeCheckpoint(empty.workspace, "not-an-instant", observer));
    assert.equal(opened, false);
    await createKnowledgeUnit(empty.workspace, unitInput(empty, "KNOWLEDGE-INELIGIBLE", {
      retrievalDisposition: "excluded", freshnessState: "unknown", lastVerified: null,
    }));
    opened = false;
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => exportKnowledgeCheckpoint(empty.workspace, "2026-02-30T00:00:00Z", observer));
    assert.equal(opened, false);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => evaluateKnowledgeFreshness(empty.workspace, "2026-02-30T00:00:00Z", observer));
    assert.equal(opened, false);
  } finally {
    await empty.close();
  }
});

test("WSC-3: provenance is enforced at the write, and the candidate path around it is closed", async () => {
  // TCRN-CROSS-INC-282: an active write is immediately eligible, so a missing owner, source or
  // evidence is refused where the writer can see it instead of being parked in a state no
  // reader returns. TCRN-CROSS-SUB-308: the lifecycle "candidate" write that used to take the
  // cheap path around that floor is refused before provenance is judged, and writes nothing.
  const incompleteProvenance = [
    ["source", { sourceReferences: [] }],
    ["evidence", { linkedEvidenceIds: [] }],
    ["owner-empty", { accountableOwnerId: "" }],
    ["owner-namespace", { accountableOwnerId: deriveStableId("profile", "UNADMITTED-OWNER") }],
  ];
  for (const [label, override] of incompleteProvenance) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROVENANCE-ACTIVE-${label.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_PROVENANCE_INVALID", () => createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-PROVENANCE-ACTIVE-${label.toUpperCase()}`, override),
      ));
    } finally {
      await fixture.close();
    }
  }
  for (const [label, override] of incompleteProvenance) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-PROVENANCE-${label.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_LIFECYCLE_RETIRED", () => createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-PROVENANCE-${label.toUpperCase()}`, { ...override, lifecycle: "candidate" }),
      ));
      const validation = await validateKnowledgeStore(fixture.workspace);
      assert.deepEqual([validation.version, validation.records], [0, 0], `${label}: the refused candidate wrote nothing`);
    } finally {
      await fixture.close();
    }
  }
});

test("WSC-6: the write enforces machine checks for tags and snippet", async () => {
  // TCRN-CROSS-INC-282: the two checks refuse the write itself. TCRN-CROSS-SUB-308 removed
  // the promotion step they also guarded; buildMetadata now enforces them at write time.
  for (const [label, override] of [
    ["no-tags", { tags: [] }],
    ["empty-snippet", { snippet: "" }],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-WRITE-CHECK-${label.toUpperCase()}` });
    try {
      await expectReason("KNOWLEDGE_PROMOTION_INVALID", () => createKnowledgeUnit(fixture.workspace,
        unitInput(fixture, `KNOWLEDGE-WRITE-CHECK-${label.toUpperCase()}`, override)));
    } finally {
      await fixture.close();
    }
  }
  // a fully-governed card is written active without a promotion marker
  const ok = await workspaceFixture({ externalKey: "FIXTURE-PROMOTE-CHECK-OK" });
  try {
    const created = await createKnowledgeUnit(ok.workspace, unitInput(ok, "KNOWLEDGE-CHECK-OK"));
    assert.equal(Object.hasOwn(created, "promotionState"), false);
  } finally {
    await ok.close();
  }
});

test("WSE-5: a work-log candidate carrying an event reference and chain-matching accountable owner promotes unchanged", async () => {
  // Rationale linkage (work-log-v1 Event linkage): the event -> work-log -> evidence
  // audit walk is expressible today with zero schema or engine change. A work-log
  // decision candidate that lists a covered event as an `event:<eventHash>` source
  // reference, sets accountableOwnerId to the attested owner: actor, and carries the
  // evidence link passes createKnowledgeUnit and the existing promotion validation.
  const eventReference = (fixture, seed) => `event:${canonicalSha256({ workId: fixture.workId, seed })}`;
  const agentActor = deriveStableId("agent", "WORK-LOG-AGENT");

  for (const [label, override] of [
    // owner: actor -> exact accountableOwnerId match, event reference only
    ["owner-actor", (fixture) => ({ kind: "decision", sourceReferences: [eventReference(fixture, "owner")] })],
    // profile:/agent: actor -> owning owner stays accountable, actor id rides in sourceReferences
    ["agent-actor", (fixture) => ({ kind: "decision", sourceReferences: [eventReference(fixture, "agent"), agentActor] })],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-WORK-LOG-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(
        fixture.workspace,
        unitInput(fixture, `WORK-LOG-${label.toUpperCase()}`, override(fixture)),
      );
      assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
      // creation itself proves the event reference survives storage: a reference the
      // source-reference grammar rejected or redaction rewrote would fail closed here.
      // TCRN-CROSS-STORY-365, TCRN-CROSS-SUB-308: every card is immediately eligible;
      // there is no later promotion step or metadata marker.
      assert.equal(Object.hasOwn(created, "promotionState"), false);
    } finally {
      await fixture.close();
    }
  }

  // TCRN-CROSS-INC-282: half-supplied provenance on a relaxed kind used to be the one
  // shape that landed a candidate and then refused promotion -- a card written,
  // unretrievable, and unrepairable by any verb. This case was that refusal's proof; it is
  // now the proof of what replaced it. A source with no evidence id is written active and
  // answers the default selection immediately.
  const halfSupplied = await workspaceFixture({ externalKey: "FIXTURE-WORK-LOG-NO-EVIDENCE" });
  try {
    const created = await createKnowledgeUnit(halfSupplied.workspace, unitInput(halfSupplied, "WORK-LOG-NO-EVIDENCE", {
      kind: "decision",
      sourceReferences: [eventReference(halfSupplied, "no-evidence")],
      linkedEvidenceIds: [],
    }));
    assert.equal(Object.hasOwn(created, "promotionState"), false, "a source without an evidence id is still a written card");
    const listed = await listKnowledgeMetadata(halfSupplied.workspace, { at: instant(12) });
    assert.equal(listed.records.some((record) => record.id === created.id), true, "default recall answers for it at once");
  } finally {
    await halfSupplied.close();
  }
});

test("WSC-5: reverify admits a written card and refuses a retired record, and nothing retires by hand", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-LIFECYCLE" });
  try {
    // TCRN-CROSS-SUB-308: manual retirement is gone -- the verb answers as unknown.
    const kept = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-RETIRE-ME", { occurredAt: instant(11, 3) }));
    await expectReason("CLI_COMMAND_UNKNOWN", () => runCli(["knowledge-retire", "--workspace", fixture.workspace,
      "--expected-revision", "1", "--at", instant(11, 4), "--id", kept.id], { write() {} }));
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "default" })).records.some((r) => r.id === kept.id), true);

    // reverify: a written card re-verifies under CAS
    const written = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-REVERIFY-ME", { occurredAt: instant(11, 6) }));
    await expectReason("KNOWLEDGE_CAS_MISMATCH", () => reverifyKnowledgeUnit(fixture.workspace, { expectedRevision: 2, occurredAt: instant(11, 7), id: written.id }));
    const reverified = await reverifyKnowledgeUnit(fixture.workspace, { expectedRevision: 1, occurredAt: instant(13, 9), id: written.id });
    assert.equal(reverified.reasonCode, "KNOWLEDGE_REVERIFIED");
    assert.equal(reverified.lastVerified, instant(13, 9));

    // a retired record an older engine left is not re-verified
    await retireByHand(fixture, kept.id);
    await expectReason("KNOWLEDGE_LIFECYCLE_INVALID", () => reverifyKnowledgeUnit(fixture.workspace, { expectedRevision: 2, occurredAt: instant(13, 10), id: kept.id }));
  } finally {
    await fixture.close();
  }
});

test("WSC-4: knowledge-list supports bounded substring search over subject and tags", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-SEARCH" });
  try {
    await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-ALPHA", { occurredAt: instant(11, 3), subject: "Retry backoff policy", tags: ["knowledge", "resilience"] }));
    await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-BETA", { occurredAt: instant(11, 4), subject: "Cache invalidation rules", tags: ["knowledge", "caching"] }));
    const bySubject = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "backoff" });
    assert.equal(bySubject.total, 1);
    assert.equal(bySubject.records[0].subject, "Retry backoff policy");
    const byTag = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "caching" });
    assert.equal(byTag.total, 1);
    assert.equal(byTag.records[0].subject, "Cache invalidation rules");
    const caseInsensitive = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "RETRY" });
    assert.equal(caseInsensitive.total, 1);
    const none = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "nonexistent-term" });
    assert.equal(none.total, 0);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", search: "x".repeat(300) })).total, 0);
    await expectReason("KNOWLEDGE_INPUT_INVALID", () => listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all", limit: 0 }));
  } finally {
    await fixture.close();
  }
});

test("WSC-3: knowledge-create accepts unsorted arrays and sorts them server-side", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-CAPTURE-SORT" });
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "KNOWLEDGE-SORT", {
      tags: ["workflow", "knowledge", "architecture"],
      roleScopes: [],
    }));
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    const { metadata } = (await cardEvent(fixture, created.id)).event;
    assert.deepEqual(metadata.tags, ["architecture", "knowledge", "workflow"]);
    // the stored record is canonical and re-validates
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  } finally {
    await fixture.close();
  }
});

// INC-399 R4: the fixture separates earlier product ceilings, the ordinary page
// window, and immutable capacities of the executing runtime.
test("INC-399: knowledge capacity bindings describe the running representation", async () => {
  const contract = JSON.parse(await readFile(new URL("../packages/core/fixtures/p4-knowledge-core-cases.json", import.meta.url), "utf8"));
  const { RUNTIME_CAPACITY } = await import("../scripts/lib/runtime-capacity.mjs");
  for (const [field, capacity] of Object.entries(contract.capacityBindings)) {
    assert.equal(KNOWLEDGE_LIMITS[field], RUNTIME_CAPACITY[capacity], field);
    assert.ok(KNOWLEDGE_LIMITS[field] > contract.formerProductCeilings[field]);
  }
  assert.equal(contract.defaultQueryWindow, 8);
  assert.equal(Object.hasOwn(KNOWLEDGE_LIMITS, "maximumAggregateBytes"), false);
});

test("64 real insertion orders produce exact index, list, and checkpoint parity", async () => {
  const fixtureContract = JSON.parse(await readFile(
    new URL("../packages/core/fixtures/p4-knowledge-core-cases.json", import.meta.url),
    "utf8",
  ));
  const logicalKeys = ["KNOWLEDGE-PERM-A", "KNOWLEDGE-PERM-B", "KNOWLEDGE-PERM-C", "KNOWLEDGE-PERM-D", "KNOWLEDGE-PERM-E"];
  const orders = deterministicPermutations(logicalKeys).slice(0, fixtureContract.propertyPermutations);
  assert.equal(orders.length, 64);
  assert.equal(new Set(orders.map((order) => JSON.stringify(order))).size, 64);
  const corpusDigest = canonicalSha256(orders);
  assert.equal(corpusDigest, fixtureContract.permutationCorpusDigest);
  let baseline;
  for (const order of orders) {
    const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-PERMUTATION-CORPUS" });
    try {
      for (const [version, key] of order.entries()) {
        await createKnowledgeUnit(fixture.workspace, unitInput(fixture, key, {
          occurredAt: instant(11, 3 + logicalKeys.indexOf(key)),
        }));
      }
      // TCRN-CROSS-INC-282: no promote pass remains; the corpus under comparison is the written one.
      const indexBytes = await readFile(fixture.indexView, "utf8");
      const listBytes = canonicalJson(await listKnowledgeMetadata(fixture.workspace, { at: instant(12) }));
      const checkpointBytes = await exportKnowledgeCheckpoint(fixture.workspace, instant(12));
      const observation = {
        indexBytes,
        indexDigest: JSON.parse(indexBytes).indexDigest,
        listBytes,
        listDigest: JSON.parse(listBytes).resultDigest,
        checkpointBytes,
        checkpointDigest: JSON.parse(checkpointBytes).checkpointDigest,
      };
      baseline ??= observation;
      assert.deepEqual(observation, baseline);
    } finally {
      await fixture.close();
    }
  }
});

test("input, link, redaction, Unicode, body, summary, and snippet boundaries fail closed", async () => {
  for (const [label, mutate, reasonCode] of [
    ["unicode", (input) => ({ ...input, subject: `broken-${String.fromCharCode(0xd800)}` }), "KNOWLEDGE_CANONICAL_INVALID"],
    ["work-link", (input) => ({ ...input, linkedWorkIds: [deriveStableId("work", "MISSING")] }), "KNOWLEDGE_LINK_INVALID"],
    ["credential", (input) => ({ ...input, sourceReferences: [credentialReference()] }), "KNOWLEDGE_REDACTION_REQUIRED"],
    ["query", (input) => ({ ...input, sourceReferences: ["evidence://fixture/current?credential=raw"] }), "KNOWLEDGE_REDACTION_REQUIRED"],
    ["private", (input) => ({ ...input, sourceReferences: [privateReference()] }), "KNOWLEDGE_REDACTION_REQUIRED"],
  ]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-BOUNDARY-${label.toUpperCase()}` });
    try {
      await expectReason(reasonCode, () => createKnowledgeUnit(fixture.workspace, mutate(unitInput(fixture, `KNOWLEDGE-${label.toUpperCase()}`))));
    } finally {
      await fixture.close();
    }
  }
  const liveLike = await workspaceFixture({ externalKey: "LIVE-LIKE-KNOWLEDGE", initialize: false });
  try {
    await expectReason("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", () => initializeKnowledgeStore(liveLike.workspace));
  } finally {
    await liveLike.close();
  }
});

test("INC-399: schema and runtime preserve UTF-8 beyond the former field ceilings", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/knowledge-core-v1.schema.json", import.meta.url), "utf8"));
  const customAjv = knowledgeAjv();
  const stockAjv = new Ajv2020({ strict: false, validateFormats: false });
  for (const [field, former, prefix] of [["subject", 512, ""], ["summary", 2048, ""], ["snippet", 512, ""], ["sourceReferences", 512, "evidence-ref-"]]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-UTF8-${field.toUpperCase()}` });
    try {
      const complete = `${prefix}${"é".repeat(former + 1)}`;
      const override = field === "sourceReferences" ? { sourceReferences: [complete] } : { [field]: complete };
      const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `KNOWLEDGE-UTF8-${field.toUpperCase()}`, override));
      const { metadata } = (await cardEvent(fixture, created.id)).event;
      assert.equal(customAjv.validate(schema, metadata), true, JSON.stringify(customAjv.errors));
      assert.equal(stockAjv.validate(schema, metadata), true, JSON.stringify(stockAjv.errors));
      assert.deepEqual(metadata[field], field === "sourceReferences" ? [complete] : complete);
      const invalid = { ...metadata, [field]: field === "sourceReferences" ? 7 : null };
      assert.equal(customAjv.validate(schema, invalid), false, "type protections still apply");
    } finally { await fixture.close(); }
  }
});

test("duplicate, revision CAS, lifecycle, and concurrent writer integrity fail closed", async () => {
  const fixture = await workspaceFixture();
  try {
    const input = unitInput(fixture, "KNOWLEDGE-CAS");
    const created = await createKnowledgeUnit(fixture.workspace, input);
    // TCRN-CROSS-SUB-308: a refused lifecycle is judged before the claim is taken, so it
    // leaves no claim and no version step behind.
    await expectReason("KNOWLEDGE_LIFECYCLE_RETIRED", () => createKnowledgeUnit(fixture.workspace,
      unitInput(fixture, "KNOWLEDGE-CAS-CANDIDATE", { lifecycle: "candidate" })));
    assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false);
    assert.equal((await validateKnowledgeStore(fixture.workspace)).version, 1);
    await expectReason("KNOWLEDGE_DUPLICATE", () => createKnowledgeUnit(fixture.workspace, { ...input }));
    // The record revision is still compared; the store-version CAS beside it is gone
    // (TCRN-CROSS-STORY-467 R1).
    await expectReason("KNOWLEDGE_CAS_MISMATCH", () => reverifyKnowledgeUnit(fixture.workspace, {
      expectedRevision: 2, occurredAt: instant(12), id: created.id,
    }));
    assert.equal((await reverifyKnowledgeUnit(fixture.workspace, {
      expectedRevision: 1, occurredAt: instant(12), id: created.id,
    })).version, 2);
  } finally {
    await fixture.close();
  }
  const concurrent = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-CONCURRENT" });
  try {
    const outcomes = await Promise.all([
      settle(createKnowledgeUnit(concurrent.workspace, unitInput(concurrent, "KNOWLEDGE-CONCURRENT-A"))),
      settle(createKnowledgeUnit(concurrent.workspace, unitInput(concurrent, "KNOWLEDGE-CONCURRENT-B"))),
    ]);
    // Without a store-version CAS two writers that do not overlap both land; two that do
    // overlap meet the mutation claim and one is refused. Either way nothing is lost or
    // half-written: the store validates at exactly the number of writes that landed.
    const fulfilled = outcomes.filter((entry) => entry.status === "fulfilled").length;
    assert.ok(fulfilled >= 1);
    for (const entry of outcomes.filter((outcome) => outcome.status === "rejected")) {
      assert.equal(entry.reason.reasonCode, "KNOWLEDGE_LOCKED");
    }
    assert.equal((await validateKnowledgeStore(concurrent.workspace)).version, fulfilled);
  } finally {
    await concurrent.close();
  }
});

// TCRN-CROSS-SUB-414: an event stream's record is bound by its event hash, so a record edited in
// place is refused for the hash; one edited and signed again reaches the metadata checks. `change`
// rewrites the card's latest event, and `resign` recomputes its hash and file name.
async function tamperEvent(fixture, id, change, { resign }) {
  const { path, event } = await cardEvent(fixture, id);
  const { eventHash: original, ...unsigned } = change(structuredClone(event));
  const eventHash = resign ? canonicalSha256(unsigned) : original;
  await rm(path);
  await writeFile(resign ? join(await streamRoot(fixture), `${String(event.sequence).padStart(8, "0")}-${eventHash}.json`) : path, canonicalJson({ ...unsigned, eventHash }));
}

test("link, special-file, source-replacement, unknown-field, and partial-state attacks fail closed", async () => {
  for (const kind of ["symlink", "hardlink", "directory"]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-${kind.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `KNOWLEDGE-${kind.toUpperCase()}`));
      const { bodyPath } = await cardEvent(fixture, created.id);
      const backing = join(fixture.base, `body-${kind}`);
      if (kind === "symlink") {
        await rename(bodyPath, backing);
        await symlink(backing, bodyPath);
      } else if (kind === "hardlink") {
        await link(bodyPath, backing);
      } else {
        await unlink(bodyPath);
        await mkdir(bodyPath);
      }
      await expectReason(kind === "directory" ? "KNOWLEDGE_SPECIAL_FILE" : "KNOWLEDGE_LINK_UNSAFE", () => validateKnowledgeStore(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
  const replacement = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-REPLACEMENT" });
  try {
    const input = unitInput(replacement, "KNOWLEDGE-REPLACEMENT");
    const created = await createKnowledgeUnit(replacement.workspace, input);
    const { bodyPath } = await cardEvent(replacement, created.id);
    let replaced = false;
    await expectReason("KNOWLEDGE_SOURCE_CHANGED", () => readKnowledgeBody(replacement.workspace, created.id, {
      at: instant(12), allowUnpromoted: true,
      async beforeDescriptorReadForTest(path) {
        if (!replaced && path === bodyPath) {
          replaced = true;
          await rename(bodyPath, `${join(replacement.base, "replaced-body")}`);
          await writeFile(bodyPath, input.body);
        }
      },
    }));
  } finally {
    await replacement.close();
  }
  // An unknown field and a mistyped one: in an event signed again, and in the metadata/body layout
  // an older engine left. An event edited in place is refused for its hash.
  for (const [label, change] of [
    ["unknown-field", (metadata) => ({ ...metadata, extraAuthority: true })],
    ["mistyped-field", (metadata) => ({ ...metadata, subject: 7 })],
  ]) {
    const signed = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-SIGNED-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(signed.workspace, unitInput(signed, `KNOWLEDGE-SIGNED-${label.toUpperCase()}`));
      await tamperEvent(signed, created.id, (event) => ({ ...event, metadata: change(event.metadata) }), { resign: true });
      await expectReason("KNOWLEDGE_RECORD_INVALID", () => validateKnowledgeStore(signed.workspace));
      await expectReason("KNOWLEDGE_RECORD_INVALID", () => listKnowledgeMetadata(signed.workspace, { at: instant(12) }));
    } finally {
      await signed.close();
    }
    const older = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-OLDER-${label.toUpperCase()}` });
    try {
      const created = await createKnowledgeUnit(older.workspace, unitInput(older, `KNOWLEDGE-OLDER-${label.toUpperCase()}`));
      await asOlderEngineCrest(older);
      const path = join(older.store, "metadata", `${created.id}.json`);
      await writeFile(path, canonicalJson(change(JSON.parse(await readFile(path, "utf8")))));
      await expectReason("KNOWLEDGE_RECORD_INVALID", () => validateKnowledgeStore(older.workspace));
    } finally {
      await older.close();
    }
  }
  const edited = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-EDITED-EVENT" });
  try {
    const created = await createKnowledgeUnit(edited.workspace, unitInput(edited, "KNOWLEDGE-EDITED-EVENT"));
    await tamperEvent(edited, created.id, (event) => ({ ...event, metadata: { ...event.metadata, summary: "edited in place" } }), { resign: false });
    await expectReason("KNOWLEDGE_RECORD_INVALID", () => listKnowledgeMetadata(edited.workspace, { at: instant(12) }));
  } finally {
    await edited.close();
  }
  // TCRN-CROSS-SUB-414: a write commits one event, after its body, with no claim to hold. A crash
  // before the event leaves a body no event names, which reads ignore; a crash after it leaves the
  // committed card. Either way the crest reads, holds no claim, and takes the next write.
  for (const [faultAt, landed] of [["after-body-write", 0], ["after-metadata-write", 1], ["after-marker-write", 1]]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-FAULT-${faultAt.toUpperCase()}` });
    try {
      const input = unitInput(fixture, `KNOWLEDGE-FAULT-${faultAt.toUpperCase()}`);
      await expectReason("KNOWLEDGE_FAULT_INJECTED", () => createKnowledgeUnit(fixture.workspace, input, { faultAt }));
      const validation = await validateKnowledgeStore(fixture.workspace);
      assert.deepEqual([validation.reasonCode, validation.records], ["KNOWLEDGE_STORE_VALID", landed], faultAt);
      assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false, `${faultAt} leaves no claim`);
      if (landed === 0) assert.equal((await createKnowledgeUnit(fixture.workspace, input)).reasonCode, "KNOWLEDGE_UNIT_CREATED", "the interrupted write can be made again");
    } finally {
      await fixture.close();
    }
  }

  // WSC-6: the record mutations carry the same crash points as create. A crash after the event of
  // a re-verification leaves it committed and no claim behind. (The promote and retire siblings
  // went with their verbs, TCRN-CROSS-SUB-308.)
  for (const verb of ["reverify"]) {
    const fixture = await workspaceFixture({ externalKey: `FIXTURE-KNOWLEDGE-SIBLING-${verb.toUpperCase()}` });
    try {
      const unit = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `KNOWLEDGE-SIBLING-${verb.toUpperCase()}`));
      const run = () => reverifyKnowledgeUnit(fixture.workspace, { expectedRevision: 1, occurredAt: instant(12, 5), id: unit.id }, { faultAt: "after-metadata-write" });
      await expectReason("KNOWLEDGE_FAULT_INJECTED", run);
      assert.equal((await readdir(fixture.store)).includes("mutation.claim"), false, `${verb} leaves no claim after a simulated crash`);
      const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12, 6), selection: "all" });
      assert.equal(listed.records.find((record) => record.id === unit.id).revision, 2, "the committed record stands");
    } finally {
      await fixture.close();
    }
  }
});

test("INIT-047 knowledge inventory admits more than 64 records while query pages remain bounded", async () => {
  const count = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-COUNT" });
  try {
    assert.equal(Object.hasOwn(KNOWLEDGE_LIMITS, "maximumRecords"), false);
    for (let index = 0; index < 65; index += 1) {
      await createKnowledgeUnit(count.workspace, unitInput(count, `KNOWLEDGE-COUNT-${index}`, {
        occurredAt: instant(11, 3),
        body: "small",
      }));
    }
    const inventory = await listKnowledgeMetadata(count.workspace, { at: instant(12), selection: "all", limit: 100 });
    assert.equal(inventory.total, 65);
    assert.equal(inventory.records.length, 65);
  } finally {
    await count.close();
  }
  const query = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-QUERY" });
  try {
    for (let index = 0; index < 9; index += 1) {
      await createKnowledgeUnit(query.workspace, unitInput(query, `KNOWLEDGE-QUERY-${index}`, {
        occurredAt: instant(11, 3 + index),
      }));
    }
    // WSC-4: more matches than one page truncates with a continuation window
    // instead of failing closed.
    const page = await listKnowledgeMetadata(query.workspace, { at: instant(12), selection: "all" });
    assert.equal(page.total, 9);
    assert.equal(page.records.length, 8);
    assert.equal(page.truncated, true);
    const next = await listKnowledgeMetadata(query.workspace, { at: instant(12), selection: "all", offset: 8 });
    assert.equal(next.records.length, 1);
    assert.equal(next.truncated, false);
  } finally {
    await query.close();
  }
  // TCRN-CROSS-SUB-310 R17 (MIN-238 D1): no total bounds the inventory either. The old default of
  // knowledge.aggregateBytes, 131,072 body bytes, refused the eighteenth 7,500-byte body; each is admitted.
  const aggregate = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-AGGREGATE" });
  try {
    for (let index = 0; index < 18; index += 1) {
      const created = await createKnowledgeUnit(aggregate.workspace, unitInput(aggregate, `KNOWLEDGE-AGGREGATE-${index}`, {
        occurredAt: instant(11, 3),
        body: "x".repeat(7_500),
      }));
      assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED", String(index));
    }
    const validation = await validateKnowledgeStore(aggregate.workspace);
    assert.deepEqual([validation.reasonCode, validation.records, Object.hasOwn(validation, "capacity")], ["KNOWLEDGE_STORE_VALID", 18, false]);
    await expectReason("KNOWLEDGE_PATH_INVALID", () => readKnowledgeBody(aggregate.workspace, "../escape", {
      at: instant(12), allowUnpromoted: true, allowStale: true,
    }));
  } finally {
    await aggregate.close();
  }
});

test("Knowledge implementation has no predecessor, network, database, or AOS read authority", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-RUNTIME-KNOWLEDGE-BOUNDARY" });
  try {
    assert.equal((await validateKnowledgeStore(fixture.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.deepEqual((await listKnowledgeMetadata(fixture.workspace, { at: instant(11, 3) })).records, []);
    assert.equal(KnowledgeCoreError.prototype instanceof Error, true);
  } finally {
    await fixture.close();
  }
  const corePackage = JSON.parse(await readFile(new URL("../packages/core/package.json", import.meta.url), "utf8"));
  const cliPackage = JSON.parse(await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
  assert.deepEqual(corePackage.dependencies ?? {}, {});
  assert.deepEqual(cliPackage.dependencies ?? {}, {});
  assert.ok(KnowledgeCoreError.prototype instanceof Error);
});

// CQ-02c. `scope` was the one enum in this header still admitted through a coercing
// membership test, two lines above `category`, which was already written correctly. A
// caller of the programmatic createKnowledgeUnit API passes `scope` straight through to
// the persisted metadata (knowledge-core.ts:941), so a coercible value was written to disk
// in a field the exported type declares as an enum.
test("CQ-02c: knowledge metadata scope refuses values that only coerce to a member", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-SCOPE-COERCION" });
  try {
    const vectors = [
      ["single-element array", ["project"]],
      ["plain object with toString", { toString: () => "project" }],
      ["boxed String", new String("project")],
      // Regression anchors only -- already refused before the guard existed.
      ["anchor number", 1],
      ["anchor null", null],
      ["anchor plain object", {}],
    ];
    for (const [label, scope] of vectors) {
      await assert.rejects(
        // The override is applied AFTER unitInput, whose `options.scope ?? "project"`
        // would otherwise silently substitute a legal value for the null anchor.
        () => createKnowledgeUnit(fixture.workspace, { ...unitInput(fixture, `SCOPE-${label.replace(/[^A-Za-z]/gu, "").toUpperCase()}`), scope }),
        (error) => {
          assert.equal(error?.reasonCode, "KNOWLEDGE_RECORD_INVALID", `${label}: got ${error?.reasonCode}`);
          return true;
        },
        label,
      );
    }
    // The guard must not have closed the legal values. Each scope carries its own link
    // shape: workspace scope admits no project or work links, role scope carries role
    // scopes. Rejected creates do not advance the store version, so the successful ones
    // number from zero.
    const legalScopes = [
      ["workspace", { projectId: null, roleScopes: [], linkedWorkIds: [] }],
      ["project", { projectId: fixture.projectId, roleScopes: [] }],
      ["role", { projectId: fixture.projectId, roleScopes: ["reviewer"] }],
    ];
    for (const [index, [scope, shape]] of legalScopes.entries()) {
      const created = await createKnowledgeUnit(fixture.workspace, {
        ...unitInput(fixture, `SCOPE-OK-${scope.toUpperCase()}`, { ...shape }),
        scope,
      });
      assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED", scope);
    }
    // Read the scopes back off disk: the create result does not carry `scope`, so this is
    // what actually shows the legal values survived the guard as strings.
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" });
    const persisted = listed.records.filter((record) => record.externalKey.startsWith("SCOPE-OK-"));
    assert.deepEqual(persisted.map((record) => record.scope).sort(), ["project", "role", "workspace"]);
    for (const record of persisted) assert.equal(typeof record.scope, "string");
  } finally {
    await fixture.close();
  }
});

// CQ-10, knowledge-core half. Link liveness ran `workspace.projects.find` once per record
// and `workspace.work.find` once per linked work id, so a scan of R records paid R linear
// passes over the workspace. The lookups are now served by maps memoized on the workspace
// state. Per the plan's acceptance criterion 3 this is asserted as a DETERMINISTIC COUNT,
// not as a timing, because a timing assertion is noise on a shared machine and a
// performance regression is invisible to every other gate.
test("CQ-10: knowledge link liveness builds one index per workspace state, not one per record", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-LINK-INDEX" });
  try {
    const recordCount = 6;
    for (let index = 0; index < recordCount; index += 1) {
      await createKnowledgeUnit(fixture.workspace, unitInput(fixture, `LINK-INDEX-${index}`, {}));
    }
    const before = knowledgeLinkIndexCountsForTest();
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" });
    const scanned = listed.records.filter((record) => record.externalKey.startsWith("LINK-INDEX-"));
    assert.equal(scanned.length, recordCount, "the fixture must actually exercise multiple records");
    const after = knowledgeLinkIndexCountsForTest();
    const builds = after.builds - before.builds;
    const lookups = after.lookups - before.lookups;
    // Builds are bounded by the number of materialized workspace states the read path
    // walks, NOT by the number of records. A per-record rebuild shows up here as >= 6.
    assert.ok(builds < recordCount, `link index built ${builds} times for ${recordCount} records`);
    // And the index must actually be the thing answering the lookups. Without this, a call
    // site reverted to `workspace.*.find` would leave the build count untouched and this
    // test would pass with the defect fully reintroduced.
    assert.ok(lookups >= recordCount, `link index served only ${lookups} lookups for ${recordCount} records`);
  } finally {
    await fixture.close();
  }
});

// The index replaces `find`. This pins the lookup-miss behaviours: an id that is absent
// from the index must still be refused, for both the project and the linked-work lookup.
//
// Two related properties are deliberately NOT claimed here, to keep this test honest about
// what it proves. (1) Tombstone exclusion is already pinned by the WSC-2 tests -- the
// project index's by the one where a project is deleted under a live card, the work index's by
// the dangling-work one -- and dropping `!entry.tombstone` from the index builder reddens them,
// so re-asserting it here would add proof mass without adding coverage. (2) The builder is
// first-wins to match `find`, but a materialized workspace has unique record ids, so no
// test can distinguish first-wins from last-wins; that choice rests on review, not proof.
test("CQ-10: the link index still refuses links that are absent from the workspace", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-LINK-SEMANTICS" });
  try {
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fixture.workspace, unitInput(fixture, "LINK-UNKNOWN-WORK", {
      linkedWorkIds: [deriveStableId("work", "NO-SUCH-WORK")],
    })));
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fixture.workspace, unitInput(fixture, "LINK-UNKNOWN-PROJECT", {
      projectId: deriveStableId("project", "NO-SUCH-PROJECT"),
    })));
    // The live link still resolves.
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "LINK-LIVE"));
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  } finally {
    await fixture.close();
  }
});

test("SUB-386: dangling linked work is diagnosed without blocking reads or writes", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-DANGLING-WORK" });
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "DANGLING-WORK-CARD"));
    const danglingId = deriveStableId("work", "SUB386-DANGLING-WORK");
    // TCRN-CROSS-SUB-414: a record linking work its chain no longer holds is one an older engine
    // could leave; laid down in its metadata/body layout.
    await asOlderEngineCrest(fixture);
    const metadataPath = join(fixture.store, "metadata", `${created.id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, canonicalJson({ ...metadata, linkedWorkIds: [danglingId] }));

    const validation = await validateKnowledgeStore(fixture.workspace);
    assert.deepEqual(validation.danglingWorkLinks, [{ knowledgeId: created.id, workIds: [danglingId] }]);
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(12) })).records[0].id, created.id);
    assert.equal((await readKnowledgeBody(fixture.workspace, created.id, { at: instant(12) })).body, "Body DANGLING-WORK-CARD");

    const reverified = await reverifyKnowledgeUnit(fixture.workspace, {
      id: created.id, expectedRevision: 1, occurredAt: instant(12),
    });
    assert.equal(reverified.reasonCode, "KNOWLEDGE_REVERIFIED");
    const second = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "WRITE-WITH-DANGLING-WORK", {
      expectedVersion: 2, occurredAt: instant(12, 1),
    }));
    assert.equal(second.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.deepEqual((await validateKnowledgeStore(fixture.workspace)).danglingWorkLinks,
      [{ knowledgeId: created.id, workIds: [danglingId] }]);
  } finally {
    await fixture.close();
  }
});

test("SUB-386: historical promotion metadata and candidate records remain readable", async () => {
  const fixture = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-HISTORICAL-PROMOTION" });
  try {
    const created = await createKnowledgeUnit(fixture.workspace, unitInput(fixture, "HISTORICAL-CANDIDATE"));
    await asOlderEngineCrest(fixture);
    const metadataPath = join(fixture.store, "metadata", `${created.id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, canonicalJson({ ...metadata, lifecycle: "candidate", promotionState: "candidate" }));

    assert.equal((await validateKnowledgeStore(fixture.workspace)).records, 1);
    const historical = (await listKnowledgeMetadata(fixture.workspace, { at: instant(12), selection: "all" })).records[0];
    assert.equal(historical.promotionState, "candidate");
    assert.equal((await readKnowledgeBody(fixture.workspace, created.id, { at: instant(12) })).body, "Body HISTORICAL-CANDIDATE");
  } finally {
    await fixture.close();
  }
});

test("TCRN-CROSS-SUB-310 R17 (MIN-238 D1, MIN-239 D1): past the old default the per-card body limit is what still fires", async () => {
  // STORY-023 stopped charging the derived index and SUB-309 the marker and the metadata; R17 charges
  // nothing at all. A store whose bodies alone are past the old 131,072-byte default of
  // knowledge.aggregateBytes takes a body at the per-card limit, and one byte past that limit is
  // refused with the reason code it always had, writing nothing.
  const fx = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-S023" });
  try {
    for (let i = 0; i < 18; i += 1) {
      await createKnowledgeUnit(fx.workspace, unitInput(fx, `S023-${i}`, {
        occurredAt: instant(11, 3), body: "x".repeat(7_500),
      }));
    }
    // TCRN-CROSS-SUB-414: each card is an event (its metadata) and a body file in this device's stream.
    let sumBody = 0;
    const stream = await streamRoot(fx);
    for (const n of (await readdir(stream)).filter((name) => name.endsWith(".body"))) sumBody += (await readFile(join(stream, n))).length;
    const oldDefault = 131_072;
    assert.equal(sumBody, 18 * 7_500);
    assert.ok(sumBody > oldDefault, `the bodies alone are past the old default: ${sumBody} > ${oldDefault}`);
    const atLimit = await createKnowledgeUnit(fx.workspace, unitInput(fx, "S023-AT-LIMIT", {
      occurredAt: instant(11, 3), body: "x".repeat(8_192),
    }));
    assert.equal(atLimit.reasonCode, "KNOWLEDGE_UNIT_CREATED", "a body at the per-card limit is admitted");
    const files = (await readdir(stream)).length;
    const above = await createKnowledgeUnit(fx.workspace, unitInput(fx, "S023-PAST-LIMIT", {
      occurredAt: instant(11, 3), body: "x".repeat(8_193),
    }));
    assert.equal(above.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.ok((await readdir(stream)).length > files, "the complete above-former-ceiling card was recorded");
    const validation = await validateKnowledgeStore(fx.workspace);
    assert.deepEqual([validation.reasonCode, validation.records, Object.hasOwn(validation, "capacity")], ["KNOWLEDGE_STORE_VALID", 20, false]);
  } finally { await fx.close(); }
});

test("TCRN-CROSS-STORY-025: search matches the summary, not only subject and tags", async () => {
  // A curated card's searchable substance lives in its summary; a machine-shaped
  // subject is not what a reader searches for. Before this, search scanned only
  // subject+tags, so a term present only in the summary was unfindable.
  const fx = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-S025" });
  try {
    await createKnowledgeUnit(fx.workspace, unitInput(fx, "S025-CARD", {
      subject: "Subject S025-CARD",
      summary: "Layout-thrashing animations reflow every frame; animate transform and opacity instead.",
      tags: ["knowledge", "workflow"],
    }));
    const hit = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all", search: "layout-thrashing" });
    assert.equal(hit.records.length, 1, "a summary-only term must be found");
    const miss = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all", search: "nonexistent-token-zzz" });
    assert.equal(miss.records.length, 0, "a term present nowhere must not match");
  } finally { await fx.close(); }
});

test("TCRN-CROSS-STORY-024: a retired record without its body keeps the store valid, and a live record still requires one", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-KNOWLEDGE-S024" });
  try {
    const bodiesDir = join(fx.workspace, DIRECTORY.knowledge, "bodies");
    const created = await createKnowledgeUnit(fx.workspace, unitInput(fx, "S024-RECLAIM", {
      occurredAt: instant(11, 3), body: "x".repeat(7_500),
    }));
    // A retirement an older engine made reclaimed the body file (TCRN-CROSS-SUB-308: nothing
    // retires by hand now), and the store is still valid without it. That engine wrote the
    // metadata/body layout (TCRN-CROSS-SUB-414), which retireByHand lays down first.
    await retireByHand(fx, created.id);
    const bodyFile = join(bodiesDir, `${created.id}.body`);
    await assert.rejects(readFile(bodyFile), "retired body must be deleted");
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    // The retired record survives as a metadata-only audit entry.
    const all = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all" });
    assert.equal(all.records.some((r) => r.id === created.id), true, "retired record kept as audit entry");
    // Integrity still fires: a LIVE record missing its body corrupts the store, in the older layout
    // and in an event stream alike.
    const live = await createKnowledgeUnit(fx.workspace, unitInput(fx, "S024-LIVE", { occurredAt: instant(11, 5) }));
    await rm((await cardEvent(fx, live.id)).bodyPath);
    await expectReason("KNOWLEDGE_PARTIAL_STATE", () => validateKnowledgeStore(fx.workspace));
  } finally { await fx.close(); }
});

test("INIT-047: relevance ordering changes with the query and source-free fragments are selectable", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-RANK" });
  try {
    const fragment = (key, subject, summary, expectedVersion) => unitInput(fx, key, {
      expectedVersion,
      kind: "fact",
      sourceReferences: [],
      sourceDigest: null,
      linkedWorkIds: [],
      linkedEvidenceIds: [],
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      lastVerified: null,
      freshnessState: "fresh",
      subject,
      summary,
    });
    const alpha = await createKnowledgeUnit(fx.workspace, fragment("INIT047-ALPHA", "shared alpha", "shared beta", 0));
    await createKnowledgeUnit(fx.workspace, fragment("INIT047-BETA", "shared beta", "shared alpha", 1));
    assert.equal(Object.hasOwn(alpha, "promotionState"), false);
    const alphaOrder = (await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "alpha" })).records.map((record) => record.externalKey);
    const betaOrder = (await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "beta" })).records.map((record) => record.externalKey);
    assert.deepEqual(alphaOrder, ["INIT047-ALPHA", "INIT047-BETA"]);
    assert.deepEqual(betaOrder, ["INIT047-BETA", "INIT047-ALPHA"]);
    assert.equal((await evaluateKnowledgeFreshness(fx.workspace, instant(12))).records.find((record) => record.id === alpha.id).state, "fresh");
  } finally { await fx.close(); }
});

test("INIT-047 supersedes rejects an unavailable target before writing", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-SUPERSEDES" });
  try {
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-MISSING-TARGET", {
      supersedes: deriveStableId("knowledge", "INIT047-MISSING-TARGET-NOT-HERE"),
    })));
    assert.equal((await validateKnowledgeStore(fx.workspace)).records, 0);
  } finally { await fx.close(); }
});

test("INIT-047 source digest check reports changes without hiding metadata", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-SOURCE-CHECK" });
  try {
    await writeFile(join(fx.workspace, "source.md"), "source-v1");
    const sourced = await createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-SOURCE-CHECK", {
      kind: "reference",
      sourceReferences: ["source.md"],
      sourceDigest: null,
      linkedEvidenceIds: [deriveStableId("evidence", "INIT047-SOURCE-CHECK")],
      retrievalDisposition: "explicit-only",
      lastVerified: instant(11, 3),
      freshnessState: "fresh",
    }));
    assert.equal(Object.hasOwn(sourced, "promotionState"), false, "the receipt omits the retired promotion marker");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "unchanged");
    await writeFile(join(fx.workspace, "source.md"), "source-v2");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "changed");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all", search: "source-check" })).records.length, 1);
  } finally { await fx.close(); }
});

test("knowledge sources allow dot-prefixed children without permitting parent or symlink escapes", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-SOURCE-CONTAINMENT" });
  try {
    await mkdir(join(fx.workspace, "..cache"));
    await writeFile(join(fx.workspace, "..cache/source.md"), "inside source");
    await mkdir(join(fx.base, "outside"));
    await writeFile(join(fx.base, "outside/source.md"), "outside source");
    await symlink(join(fx.base, "outside"), join(fx.workspace, "..linked"), "dir");
    await symlink(join(fx.base, "outside/source.md"), join(fx.workspace, "..cache/linked.md"), "file");
    const workspace = await materializeWorkspace(fx.workspace);
    const digest = (reference) => calculateKnowledgeSourceDigest(fx.workspace, workspace, [reference], "fallback");
    assert.equal(await digest("..cache/source.md"), createHash("sha256").update("inside source").digest("hex"));
    for (const reference of ["../outside/source.md", "..linked/source.md", "..cache/linked.md"]) {
      assert.equal(await digest(reference), createHash("sha256").update("fallback").digest("hex"), reference);
    }
  } finally { await fx.close(); }
});

test("INIT-047 article index cards stay explicit-only for default context", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-ARTICLE-INDEX" });
  try {
    await writeFile(join(fx.workspace, "article.md"), "article-v1");
    const article = await createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-ARTICLE-INDEX", {
      kind: "reference",
      sourceReferences: ["article.md"],
      sourceDigest: null,
      linkedEvidenceIds: [deriveStableId("evidence", "INIT047-ARTICLE-INDEX")],
      retrievalDisposition: "explicit-only",
      lastVerified: instant(11, 3),
      freshnessState: "fresh",
    }));
    assert.equal(Object.hasOwn(article, "promotionState"), false, "the receipt omits the retired promotion marker");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12) })).records.length, 0);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "article-index" })).records.length, 1);
  } finally { await fx.close(); }
});

test("STORY-366 GWT1: an article stores full Markdown outside the chain and only a bounded reference index inside", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-STORY-366-CREATE" });
  try {
    const content = "中文".repeat(1_500);
    const owner = deriveStableId("owner", "STORY-366-OWNER");
    const evidence = deriveStableId("evidence", "STORY-366-ARTICLE");
    const created = await cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--at", instant(11, 3), "--path", "..cache/topology.md", "--category", "architecture", "--title", "分区 拓扑", "--summary", "迁移摘要", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]);
    assert.equal(created.reasonCode, "KNOWLEDGE_ARTICLE_CREATED");
    assert.ok(created.articleBytes > Buffer.byteLength(content, "utf8"));
    assert.ok(created.bodyBytes <= 8_192);
    const articlePath = join(fx.workspace, "docs/knowledge/articles/..cache/topology.md");
    const markdown = await readFile(articlePath, "utf8");
    assert.match(markdown, /^---\ncategory: architecture\ntitle: 分区 拓扑\n---\n/u);
    assert.ok(markdown.includes(content));
    assert.equal(created.sourceDigest, createHash("sha256").update(markdown).digest("hex"));
    const stored = await cardEvent(fx, created.id);
    const metadata = stored.event.metadata;
    const storedBody = await readFile(stored.bodyPath);
    assert.equal(metadata.kind, "reference");
    assert.equal(metadata.retrievalDisposition, "explicit-only");
    assert.deepEqual(metadata.sourceReferences, ["..cache/topology.md"]);
    assert.deepEqual(metadata.linkedEvidenceIds, [evidence]);
    assert.equal(metadata.accountableOwnerId, owner);
    assert.ok(metadata.bodyBytes <= 8_192);
    assert.ok(storedBody.length <= 8_192);
    assert.equal(storedBody.toString("utf8").includes(content), false);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12) })).records.length, 0);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "分区 拓扑" })).records.length, 1);
    await assert.rejects(
      () => cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--at", instant(11, 4), "--path", "..cache/topology.md", "--category", "architecture", "--title", "分区 拓扑", "--summary", "duplicate", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]),
      (error) => error?.reasonCode === "KNOWLEDGE_ALREADY_EXISTS",
    );
    await assert.rejects(
      () => cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--at", instant(11, 4), "--path", "../escape.md", "--category", "architecture", "--title", "Unsafe", "--summary", "unsafe", "--content", content, "--accountable-owner-id", owner, "--evidence-ids", evidence]),
      (error) => error?.reasonCode === "KNOWLEDGE_PATH_INVALID",
    );
  } finally { await fx.close(); }
});

test("STORY-366 GWT2: refresh reads the edited file, updates its digest and summary, and keeps identity stable", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-STORY-366-REFRESH" });
  try {
    const owner = deriveStableId("owner", "STORY-366-REFRESH-OWNER");
    const evidence = deriveStableId("evidence", "STORY-366-REFRESH");
    const created = await cliJson(["knowledge-article-create", "--workspace", fx.workspace, "--at", instant(11, 3), "--path", "refresh.md", "--category", "workflow", "--title", "刷新文章", "--summary", "初始摘要", "--content", "正文一".repeat(1_500), "--accountable-owner-id", owner, "--evidence-ids", evidence]);
    const articlePath = join(fx.workspace, "docs/knowledge/articles/refresh.md");
    const before = await readFile(articlePath, "utf8");
    await writeFile(articlePath, `${before}追加的正文标记`);
    const refreshed = await cliJson(["knowledge-article-refresh", "--workspace", fx.workspace, "--expected-revision", "1", "--at", instant(11, 4), "--id", created.id, "--path", "refresh.md", "--summary", "更新摘要"]);
    assert.equal(refreshed.reasonCode, "KNOWLEDGE_ARTICLE_REFRESHED");
    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.previousSourceDigest, created.sourceDigest);
    const after = await readFile(articlePath, "utf8");
    assert.equal(refreshed.sourceDigest, createHash("sha256").update(after).digest("hex"));
    assert.notEqual(refreshed.sourceDigest, created.sourceDigest);
    // TCRN-CROSS-SUB-414: the refresh wrote the card again, a record naming the one it replaces.
    const { event } = await cardEvent(fx, created.id);
    const metadata = event.metadata;
    assert.equal(metadata.summary, "更新摘要");
    assert.equal(metadata.revision, 2);
    assert.match(event.replaces, /^[a-f0-9]{64}$/u);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "更新摘要" })).records[0].id, created.id);
    await assert.rejects(
      () => cliJson(["knowledge-article-refresh", "--workspace", fx.workspace, "--expected-revision", "1", "--at", instant(11, 5), "--id", created.id, "--path", "refresh.md", "--summary", "stale"]),
      (error) => error?.reasonCode === "KNOWLEDGE_CAS_MISMATCH",
    );
  } finally { await fx.close(); }
});

test("INIT-047: supersedes is validated, source digests are computed and source changes are reported", async () => {
  const fx = await workspaceFixture({ externalKey: "FIXTURE-INIT047-SOURCES" });
  try {
    const fragment = (key, expectedVersion, overrides = {}) => unitInput(fx, key, {
      expectedVersion,
      kind: "fact",
      sourceReferences: [], sourceDigest: null, linkedWorkIds: [], linkedEvidenceIds: [],
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, lastVerified: null, freshnessState: "fresh",
      ...overrides,
    });
    // A retired target is still refused; nothing retires a card by hand now (TCRN-CROSS-SUB-308), so
    // the retired record is the one an older engine would have left.
    const retiredTarget = await createKnowledgeUnit(fx.workspace, fragment("INIT047-RETIRED", 0));
    await retireByHand(fx, retiredTarget.id);
    await expectReason("KNOWLEDGE_LINK_INVALID", () => createKnowledgeUnit(fx.workspace, fragment("INIT047-AFTER-RETIRE", 1, { supersedes: retiredTarget.id })));
    const old = await createKnowledgeUnit(fx.workspace, fragment("INIT047-OLD", 1));
    const replacement = await createKnowledgeUnit(fx.workspace, fragment("INIT047-NEW", 2, { supersedes: old.id }));
    const listed = await listKnowledgeMetadata(fx.workspace, { at: instant(12), selection: "all" });
    assert.equal(listed.records.find((record) => record.id === replacement.id).supersedes, old.id);
    // TCRN-CROSS-SUB-425 (MIN-239 D3, D4): the supersede removed `old`, conflict superseded, and a
    // removed card is terminal: no later card supersedes it.
    await expectReason("KNOWLEDGE_CARD_REMOVED", () => createKnowledgeUnit(fx.workspace, fragment("INIT047-AFTER-REMOVE", 3, { supersedes: old.id })));

    await writeFile(join(fx.workspace, "source.md"), "source-v1");
    const sourced = await createKnowledgeUnit(fx.workspace, unitInput(fx, "INIT047-SOURCE", {
      kind: "reference",
      sourceReferences: ["source.md"], sourceDigest: null, linkedEvidenceIds: [deriveStableId("evidence", "INIT047-SOURCE")],
      retrievalDisposition: "explicit-only", lastVerified: instant(11, 3), freshnessState: "fresh",
    }));
    const { metadata } = (await cardEvent(fx, sourced.id)).event;
    assert.equal(metadata.sourceDigest, createHash("sha256").update("source-v1").digest("hex"));
    assert.equal(Object.hasOwn(sourced, "promotionState"), false, "the receipt omits the retired promotion marker");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "unchanged");
    await writeFile(join(fx.workspace, "source.md"), "source-v2");
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "changed");
    await rm(join(fx.workspace, "source.md"));
    assert.equal((await checkKnowledgeSources(fx.workspace)).records.find((record) => record.id === sourced.id).status, "missing");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: instant(12), search: "INIT047-SOURCE" })).records.length, 1);
  } finally { await fx.close(); }
});

// TCRN-CROSS-STORY-359: verifyP4Knowledge retired with the rest of the phase verbs and it
// was the only reader of these three fixture fields. Re-hung here, in the file that drives
// the corpus, so the fixture cannot silently drift away from the values it declares.
test("STORY-359 the p4 knowledge fixture declares the corpus sizes verifyP4Knowledge used to pin", async () => {
  const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p4-knowledge-core-cases.json", import.meta.url), "utf8"));
  assert.equal(fixture.freshnessCases.length, 3);
  assert.equal(fixture.promotionCases.length, 3);
  assert.equal(fixture.permutationLogicalRecords, 5);
});
