// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-SUB-425 R18 (follow-up to TCRN-CROSS-STORY-341; TCRN-CROSS-STORY-514 R4): the
// metadata/body layout an engine before event streams left in a library's crest, and the one verb
// that rewrites it, knowledge-bodies-migrate.
//
// 1. A layout whose bodies are already in segments, or partly in segments, keeps every body it holds:
//    the migration carries the bodies of the segments over, changes nothing when no body file is left
//    to move, and answers how many bodies the layout held before and after the run.
// 2. --clear-removed true --at <instant> clears the bodies of the removed cards from the layout -- a
//    card another card superseded, by this engine or by the mark an older one stored, and a card a
//    removal event names -- on a device that is the library's sole writer, after copying the
//    layout's bodies/ into backups/<UTC second>/crest-bodies/<library>/ of the device directory.
// 3. A layout that still holds one body file per card migrates as it always did.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  backupsPath,
  createKnowledgeUnit,
  createProject,
  FileStoreBackend,
  initializeKnowledgeStore,
  initializeLibrary,
  libraryDirectoryName,
  listKnowledgeMetadata,
  migrateKnowledgeBodies,
  readKnowledgeBody,
  removeKnowledgeUnit,
  SegmentedKnowledgeStoreBackend,
  validateKnowledgeStore,
  validateWorkspace,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { canonicalJson, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const AT = "2026-09-30T12:00:00Z";
const CLEAR_AT = "2026-09-30T12:30:00Z";
const CLEAR_STAMP = "20260930T123000Z";
const LATER_AT = "2026-09-30T12:45:00Z";
const instant = (second) => `2026-09-30T10:00:${String(second).padStart(2, "0")}Z`;
const OWNER = "owner:sub-425-r18";
const ACTOR = "agent:sub-425-r18";
const DEVICE_A = "a".repeat(32);
const DEVICE_B = "b".repeat(32);
const MIGRATION = "tcrn.knowledge-body-migration.v1";

const profile = {
  reasonCodes: {
    pathInvalid: "KNOWLEDGE_PATH_INVALID",
    linkUnsafe: "KNOWLEDGE_LINK_UNSAFE",
    specialFile: "KNOWLEDGE_SPECIAL_FILE",
    limitExceeded: "KNOWLEDGE_LIMIT_EXCEEDED",
    sourceChanged: "KNOWLEDGE_SOURCE_CHANGED",
    alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
  },
  limits: { markerBytes: 16384, metadataBytes: 65536, bodyBytes: 8192, viewBytes: 1048576, recordBytes: 0 },
};

// A device directory with a fixed identity.
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

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

// Every file under `root`, by its path below it, as base64.
async function tree(root) {
  const files = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(directory, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, name);
      else files[name] = (await readFile(path)).toString("base64");
    }
  };
  await walk(root, "");
  return files;
}

// The files of the layout's bodies/, by name.
async function bodyFiles(store) {
  const files = {};
  for (const name of (await readdir(join(store, "bodies"))).sort()) files[name] = await readFile(join(store, "bodies", name));
  return files;
}

// What every body segment holds, as one text.
function segmentText(files) {
  return Object.entries(files).filter(([name]) => name.endsWith(".ndjson")).map(([, bytes]) => bytes.toString("utf8")).join("");
}

// A card of the library's crest, scope workspace, with a body long enough that a 4096-byte segment
// holds only a few.
function card(externalKey, subject, overrides = {}) {
  return {
    occurredAt: instant(5), externalKey, scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["bodies"], subject, summary: `${subject}, in brief`,
    snippet: `${subject}, the line to recall`, accountableOwnerId: OWNER, sourceReferences: [], sourceDigest: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
    freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${externalKey} `.repeat(120), ...overrides,
  };
}

// A library written by device A whose crest an engine before event streams left: one metadata file
// and one body file per card -- heron, kestrel, otter, crane, plover and heron-new -- and the mark that
// engine stored on the card it replaced (heron, replaced by heron-new), which reads as a removal.
async function olderEngineLibrary(context, name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-r18-bodies-${name}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const homeA = await deviceHome(base, "device-a", DEVICE_A);
  const homeB = await deviceHome(base, "device-b", DEVICE_B);
  const workspace = join(base, "shared", ".ether");
  const libraryId = deriveStableId("library", `SUB-425-R18-${name.toUpperCase()}`);
  const store = join(workspace, DIRECTORY.knowledge);
  const ids = await as(homeA, async () => {
    await initializeLibrary({ root: workspace, createdAt: instant(0), libraryId });
    await createProject(workspace, { occurredAt: instant(1), externalKey: "SUB-425-R18-PROJECT", name: "R18 bodies" });
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
    const written = {};
    for (const [key, externalKey, subject] of [
      ["heron", "R18-HERON", "Heron wading depth"],
      ["kestrel", "R18-KESTREL", "Kestrel hover timing"],
      ["otter", "R18-OTTER", "Otter slide angle"],
      ["crane", "R18-CRANE", "Crane migration route"],
      ["plover", "R18-PLOVER", "Plover scrape watch"],
    ]) written[key] = (await createKnowledgeUnit(workspace, card(externalKey, subject))).id;
    written.heronNew = (await createKnowledgeUnit(workspace, card("R18-HERON-NEW", "Heron wading depth, measured", { occurredAt: instant(6), coexist: true }))).id;
    return written;
  });
  const all = await as(homeA, () => listKnowledgeMetadata(workspace, { at: AT, selection: "all", limit: 1_000 }));
  const marker = await as(homeA, () => readKnowledgeStoreMarker(workspace));
  const streamBodies = new Map();
  for (const entry of await readdir(join(store, "events", DEVICE_A))) {
    if (entry.endsWith(".body")) streamBodies.set(entry.slice(9, -5), await readFile(join(store, "events", DEVICE_A, entry)));
  }
  await mkdir(join(store, "metadata"));
  await mkdir(join(store, "bodies"));
  const bodies = new Map();
  for (const record of all.records) {
    bodies.set(record.id, streamBodies.get(record.bodySha256));
    await writeFile(join(store, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(store, "bodies", `${record.id}.body`), streamBodies.get(record.bodySha256));
  }
  const storeJson = join(store, "store.json");
  await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rm(join(store, "events"), { recursive: true });
  const stored = async (id, change) => {
    const path = join(store, "metadata", `${id}.json`);
    await writeFile(path, canonicalJson(change(JSON.parse(await readFile(path, "utf8")))));
  };
  await stored(ids.heronNew, (metadata) => ({ ...metadata, supersedes: ids.heron }));
  await stored(ids.heron, (metadata) => ({ ...metadata, extensions: { ...metadata.extensions, supersededBy: ids.heronNew }, revision: metadata.revision + 1 }));
  return { base, homeA, homeB, workspace, store, libraryId, ids, bodies };
}

// What the crest answers: every card of every status, the validation, and the body of each valid
// card named.
async function answers(fx, validIds) {
  return as(fx.homeA, async () => ({
    all: (await listKnowledgeMetadata(fx.workspace, { at: AT, status: "all", limit: 1_000 })).records,
    validation: await validateKnowledgeStore(fx.workspace),
    bodies: Object.fromEntries(await Promise.all(validIds.map(async (id) => [id, (await readKnowledgeBody(fx.workspace, id, { at: AT })).body]))),
  }));
}

const byteTotal = (fx, ids) => ids.reduce((total, id) => total + fx.bodies.get(id).length, 0);

test("R18 (STORY-341 follow-up): a crest whose metadata/body layout is already in segments keeps every body through two more migrations, and reads as before", async (context) => {
  const fx = await olderEngineLibrary(context, "segmented");
  const first = await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  assert.deepEqual(first, { schemaVersion: MIGRATION, before: 6, after: 6, bodyBytes: byteTotal(fx, Object.values(fx.ids)) });
  const segmented = await bodyFiles(fx.store);
  assert.ok(Object.keys(segmented).filter((name) => name.endsWith(".ndjson")).length > 1, "the bodies span more than one segment");
  assert.equal(Object.keys(segmented).some((name) => name.endsWith(".body")), false);
  const valid = [fx.ids.kestrel, fx.ids.otter, fx.ids.crane, fx.ids.plover, fx.ids.heronNew];
  const before = await answers(fx, valid);
  for (const id of valid) assert.equal(before.bodies[id], fx.bodies.get(id).toString("utf8"));
  // Before R18 the first of these runs found no body file, rewrote the segments from none and left an
  // empty manifest, answering before 0 and after 0, and every read then refused the crest as partial.
  for (const run of [1, 2]) {
    const again = await cli(fx.homeA, ["knowledge-bodies-migrate", "--workspace", fx.workspace, "--segment-bytes", "4096"]);
    assert.deepEqual(again, first, `run ${run} answers the bodies the layout holds, before and after`);
    assert.deepEqual(await bodyFiles(fx.store), segmented, `run ${run} leaves every segment, index and the manifest as they were`);
  }
  assert.deepEqual(await answers(fx, valid), before, "the list, the validation and every valid card's body answer as before");
});

test("R18: a migration stopped after its manifest, before it removed the body files it had moved, finishes without losing a body", async (context) => {
  const fx = await olderEngineLibrary(context, "stopped");
  const perCard = await bodyFiles(fx.store);
  await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  const segmented = await bodyFiles(fx.store);
  // Two of the body files it moved are still there, as a run that stopped in its last step leaves them.
  const leftover = Object.keys(perCard).slice(0, 2);
  for (const name of leftover) await writeFile(join(fx.store, "bodies", name), perCard[name]);
  const finished = await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  assert.deepEqual(finished, { schemaVersion: MIGRATION, before: 6, after: 6, bodyBytes: byteTotal(fx, Object.values(fx.ids)) });
  assert.deepEqual(await bodyFiles(fx.store), segmented, "the segments hold every body, and the leftover body files are gone");
  const valid = [fx.ids.kestrel, fx.ids.otter, fx.ids.crane, fx.ids.plover, fx.ids.heronNew];
  const read = await answers(fx, valid);
  assert.equal(read.validation.reasonCode, "KNOWLEDGE_STORE_VALID");
  for (const id of valid) assert.equal(read.bodies[id], fx.bodies.get(id).toString("utf8"));
});

test("R18: the segmented backend carries its segments' bodies into the rewrite, moves only what a body file adds, and refuses a body file that disagrees with its segment", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-r18-backend-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "knowledge");
  await mkdir(join(root, "bodies"), { recursive: true });
  const file = new FileStoreBackend(root, profile);
  const segmented = new SegmentedKnowledgeStoreBackend(file);
  const [first, second, third] = ["knowledge:aaaaaaaaaaaaaaaaaaaaaaaa", "knowledge:bbbbbbbbbbbbbbbbbbbbbbbb", "knowledge:cccccccccccccccccccccccc"];
  await file.writeKnowledgeBody(first, "first body");
  await file.writeKnowledgeBody(second, "second body");
  assert.deepEqual(await segmented.migrateKnowledgeBodies(4096), { before: 2, after: 2, bodyBytes: 21 });
  // Nothing to move: nothing written, the bodies the segments hold answered; a segment size below the
  // floor is still refused.
  const moved = await tree(root);
  assert.deepEqual(await segmented.migrateKnowledgeBodies(4096), { before: 2, after: 2, bodyBytes: 21 });
  assert.equal((await refusalOf(() => segmented.migrateKnowledgeBodies(100)))?.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED");
  assert.deepEqual(await tree(root), moved);
  // A body file for a card the segments do not hold, beside a copy of one they do.
  await file.writeKnowledgeBody(third, "third body");
  await file.writeKnowledgeBody(second, "second body");
  assert.deepEqual(await segmented.migrateKnowledgeBodies(4096), { before: 3, after: 3, bodyBytes: 31 });
  assert.equal((await readdir(join(root, "bodies"))).some((name) => name.endsWith(".body")), false);
  for (const [id, body] of [[first, "first body"], [second, "second body"], [third, "third body"]]) {
    assert.equal((await segmented.readKnowledgeBody(id)).toString("utf8"), body);
  }
  // A body file that disagrees with the body its segment holds is refused before anything is written.
  await file.writeKnowledgeBody(first, "a different first body");
  const disagreeing = await tree(root);
  assert.equal((await refusalOf(() => segmented.migrateKnowledgeBodies(4096)))?.reasonCode, "KNOWLEDGE_PARTIAL_STATE");
  assert.deepEqual(await tree(root), disagreeing);
});

test("R18 (STORY-514 R4): --clear-removed clears the removed cards' bodies from the layout, keeps every valid card's byte for byte, backs the layout up first, and changes nothing a second time", async (context) => {
  const fx = await olderEngineLibrary(context, "clear");
  await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  // This engine removes kestrel with a removal event and supersedes otter with a card in its stream;
  // heron was superseded by the older engine. Each is removed, and the layout still holds its body.
  await as(fx.homeA, () => removeKnowledgeUnit(fx.workspace, { occurredAt: instant(7), id: fx.ids.kestrel, reason: "invalid", basis: "the hover was timed into the wind", actor: ACTOR }));
  const otterNew = (await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("R18-OTTER-NEW", "Otter slide angle, remeasured", { occurredAt: instant(8), supersedes: fx.ids.otter })))).id;
  const removed = [fx.ids.heron, fx.ids.kestrel, fx.ids.otter];
  const validLegacy = [fx.ids.crane, fx.ids.plover, fx.ids.heronNew];
  const beforeFiles = await bodyFiles(fx.store);
  for (const id of removed) assert.ok(segmentText(beforeFiles).includes(`"id":"${id}"`), `the layout holds ${id}'s body before the clearing`);
  const keptBefore = (await as(fx.homeA, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed", limit: 100 }))).records;
  assert.deepEqual(keptBefore.map((record) => record.id).sort(), [...removed].sort());
  const before = await answers(fx, [...validLegacy, otterNew]);
  const events = await tree(join(fx.store, "events"));
  const metadata = await tree(join(fx.store, "metadata"));

  const cleared = await cli(fx.homeA, ["knowledge-bodies-migrate", "--workspace", fx.workspace, "--segment-bytes", "4096", "--clear-removed", "true", "--at", CLEAR_AT]);
  const backupDir = join(backupsPath(fx.homeA), CLEAR_STAMP, "crest-bodies", libraryDirectoryName(fx.libraryId));
  assert.deepEqual(cleared, { schemaVersion: MIGRATION, before: 6, after: 3, bodyBytes: byteTotal(fx, validLegacy), clearedBodies: 3, backupDir });
  const afterFiles = await bodyFiles(fx.store);
  for (const id of removed) assert.equal(segmentText(afterFiles).includes(id), false, `no segment holds ${id}`);
  const reader = new SegmentedKnowledgeStoreBackend(new FileStoreBackend(fx.store, profile));
  assert.deepEqual(await reader.listKnowledgeBodies(), validLegacy.map((id) => `${id}.body`).sort());
  for (const id of validLegacy) assert.deepEqual(await reader.readKnowledgeBody(id), fx.bodies.get(id), `${id}'s body is kept byte for byte`);
  const manifest = JSON.parse(afterFiles["manifest.json"].toString("utf8"));
  assert.equal(manifest.count, 3);
  assert.equal(manifest.segments.reduce((total, segment) => total + segment.records, 0), 3, "the manifest and the point indexes name the bodies kept");
  const backup = {};
  for (const name of (await readdir(backupDir)).sort()) backup[name] = await readFile(join(backupDir, name));
  assert.deepEqual(backup, beforeFiles, "the backup holds the layout's bodies/ as it was");
  // Every read answers as before: the valid cards and their bodies, the removed cards as they are kept.
  assert.deepEqual(await answers(fx, [...validLegacy, otterNew]), before);
  assert.deepEqual((await as(fx.homeA, () => listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed", limit: 100 }))).records, keptBefore);
  for (const id of removed) {
    assert.equal((await as(fx.homeA, () => refusalOf(() => readKnowledgeBody(fx.workspace, id, { at: AT }))))?.reasonCode, "KNOWLEDGE_CARD_REMOVED");
  }
  assert.deepEqual(await tree(join(fx.store, "events")), events, "no event file or stream body is touched");
  assert.deepEqual(await tree(join(fx.store, "metadata")), metadata, "and no metadata file");

  const again = await cli(fx.homeA, ["knowledge-bodies-migrate", "--workspace", fx.workspace, "--segment-bytes", "4096", "--clear-removed", "true", "--at", LATER_AT]);
  assert.deepEqual(again, { schemaVersion: MIGRATION, before: 3, after: 3, bodyBytes: byteTotal(fx, validLegacy), clearedBodies: 0, backupDir: null });
  assert.deepEqual(await bodyFiles(fx.store), afterFiles, "a second run changes nothing");
  assert.deepEqual(await readdir(backupsPath(fx.homeA)), [CLEAR_STAMP], "and backs nothing up");
});

test("R18: a layout still holding one body file per card migrates as before, removed cards' bodies with the rest; only --clear-removed clears them", async (context) => {
  const fx = await olderEngineLibrary(context, "per-card");
  const perCard = await bodyFiles(fx.store);
  assert.equal(Object.keys(perCard).every((name) => name.endsWith(".body")), true);
  const migrated = await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  assert.deepEqual(migrated, { schemaVersion: MIGRATION, before: 6, after: 6, bodyBytes: byteTotal(fx, Object.values(fx.ids)) });
  const reader = new SegmentedKnowledgeStoreBackend(new FileStoreBackend(fx.store, profile));
  for (const id of Object.values(fx.ids)) assert.deepEqual(await reader.readKnowledgeBody(id), fx.bodies.get(id), `${id}'s body moved into the segments`);
  assert.equal(Object.keys(await bodyFiles(fx.store)).some((name) => name.endsWith(".body")), false);
  assert.equal(await exists(backupsPath(fx.homeA)), false, "a migration without --clear-removed backs nothing up");
  // The per-card layout cleared in the same run: moved and cleared in one rewrite.
  const second = await olderEngineLibrary(context, "per-card-clear");
  const cleared = await as(second.homeA, () => migrateKnowledgeBodies(second.workspace, 4096, { clearRemoved: true, at: CLEAR_AT }));
  const keptIds = Object.values(second.ids).filter((id) => id !== second.ids.heron);
  assert.deepEqual([cleared.before, cleared.after, cleared.bodyBytes, cleared.clearedBodies], [6, 5, byteTotal(second, keptIds), 1]);
  const secondReader = new SegmentedKnowledgeStoreBackend(new FileStoreBackend(second.store, profile));
  assert.deepEqual(await secondReader.listKnowledgeBodies(), keptIds.map((id) => `${id}.body`).sort());
  assert.equal(Object.keys(await bodyFiles(second.store)).some((name) => name.endsWith(".body")), false);
});

test("R18: --clear-removed runs only where the library's writes are this device's alone; another device's chain stream or crest stream refuses it with KNOWLEDGE_SOLE_WRITER_REQUIRED, and nothing is written", async (context) => {
  for (const [label, write] of [
    ["chain", (fx) => as(fx.homeB, () => createProject(fx.workspace, { occurredAt: instant(9), externalKey: "SUB-425-R18-ON-B", name: "Written on B" }))],
    ["crest", (fx) => as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("R18-STORK", "Stork nest chimney", { occurredAt: instant(9) })))],
  ]) {
    const fx = await olderEngineLibrary(context, `shared-${label}`);
    await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
    await write(fx);
    const before = await tree(fx.workspace);
    const refusal = await as(fx.homeA, () => refusalOf(() => migrateKnowledgeBodies(fx.workspace, 4096, { clearRemoved: true, at: CLEAR_AT })));
    assert.equal(refusal?.reasonCode, "KNOWLEDGE_SOLE_WRITER_REQUIRED", label);
    assert.deepEqual(refusal.details, { deviceId: DEVICE_A, writers: [DEVICE_A, DEVICE_B] }, label);
    assert.deepEqual(await tree(fx.workspace), before, `${label}: nothing is written`);
    assert.equal(await exists(backupsPath(fx.homeA)), false, `${label}: nothing is backed up`);
    // A migration without the clearing is not a single-writer step, and still runs.
    assert.equal((await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096))).after, 6, label);
  }
});

test("R18: --clear-removed takes --at and --at is taken only with it, a backup place already taken refuses, and an old-layout store refuses it", async (context) => {
  const fx = await olderEngineLibrary(context, "inputs");
  await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  const before = await tree(fx.workspace);
  for (const [label, run] of [
    ["no --at", () => cli(fx.homeA, ["knowledge-bodies-migrate", "--workspace", fx.workspace, "--clear-removed", "true"])],
    ["--at alone", () => cli(fx.homeA, ["knowledge-bodies-migrate", "--workspace", fx.workspace, "--at", CLEAR_AT])],
    ["malformed --at", () => cli(fx.homeA, ["knowledge-bodies-migrate", "--workspace", fx.workspace, "--clear-removed", "true", "--at", "2026-09-30 12:30"])],
  ]) {
    assert.equal((await refusalOf(run))?.reasonCode, "KNOWLEDGE_INPUT_INVALID", label);
  }
  // A backup is never overwritten: a place already taken refuses before the layout is written.
  const taken = join(backupsPath(fx.homeA), CLEAR_STAMP, "crest-bodies", libraryDirectoryName(fx.libraryId));
  await mkdir(taken, { recursive: true });
  assert.equal((await as(fx.homeA, () => refusalOf(() => migrateKnowledgeBodies(fx.workspace, 4096, { clearRemoved: true, at: CLEAR_AT }))))?.reasonCode, "KNOWLEDGE_ALREADY_EXISTS");
  assert.deepEqual(await tree(fx.workspace), before, "no refusal wrote the library");
  assert.deepEqual(await readdir(taken), []);
  // An old-layout workspace's store is read-only, whatever its bodies hold.
  const { root, control } = await restoreLegacyFixture(fx.base, "legacy");
  const legacy = await as(fx.homeA, () => validateWorkspace(root));
  const knowledge = join(control, "knowledge");
  for (const directory of ["metadata", "bodies", "views"]) await mkdir(join(knowledge, directory), { recursive: true });
  const marker = { schemaVersion: "tcrn.knowledge-store.v1", workspaceId: legacy.metadata.workspaceId, eventHighWaterDigest: legacy.headEventHash, version: 0, disposable: true, authority: "metadata-index-authority-body-separate" };
  await writeFile(join(knowledge, "store.json"), canonicalJson(marker));
  const oldTree = await tree(root);
  assert.equal((await as(fx.homeA, () => refusalOf(() => migrateKnowledgeBodies(root, 4096, { clearRemoved: true, at: LATER_AT }))))?.reasonCode, "LEGACY_WORKSPACE_READ_ONLY");
  assert.deepEqual(await tree(root), oldTree);
});
