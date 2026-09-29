// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R6, AC4 / STORY-466 AC3: library-import-legacy turns the frozen old-layout
// workspace into a library whose first stream is its chain, byte for byte: the same event count
// and head, each segment's bytes unchanged. A later event continues the stream in the new
// namespace while the old events keep theirs. A dry run validates the chain in memory and writes
// nothing, and a target that is not empty is refused.
//
// TCRN-CROSS-SUB-421 (TCRN-CROSS-INC-397): the records comparison past one MiB is tested on the
// digest function itself, with a synthetic record set that canonicalSha256 refuses, rather than on
// a synthetic old-layout chain; the real cross-project chain (7.7 MB of records) is measured in the
// package report. A dry run and an import make the same checks and report the same records digest
// and knowledge; the old knowledge store (MIN-239 D7) lands in crest/ byte for byte and answers the
// same cards; an import that stops after writing names its target and what it left there.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  cachePath,
  createKnowledgeUnit,
  importLegacyWorkspace,
  initializeKnowledgeStore,
  listKnowledgeMetadata,
  materializeWorkspace,
  migrateKnowledgeBodies,
  readAllStreams,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { LegacyImportStoppedError, assertLegacyRecordsMatch, legacyRecordsDigest } from "../dist/build/packages/core/src/legacy-import.js";
import { canonicalByteLength, canonicalJson, canonicalSha256, compareCanonicalText } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED as expected, LEGACY_FIXTURE_ROOT, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");
const AT = "2026-09-26T06:00:00Z";
const LATER = "2026-09-26T07:00:00Z";
const RECORD_COLLECTIONS = ["projects", "work", "conferences", "conferencePositions", "conferenceMinutes", "gates", "settings", "templates"];

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-import-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await stat(path);
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${entry.isFile() ? sha256(await readFile(path)) : "directory"}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

// Every file under `root` by its path relative to it (with `/`) as its SHA-256, and every empty
// directory as `<path>/` with null: what a stopped import names.
async function entries(root) {
  const found = {};
  const walk = async (directory) => {
    const names = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCanonicalText(left.name, right.name));
    if (names.length === 0 && directory !== root) found[`${relative(root, directory).split(sep).join("/")}/`] = null;
    for (const entry of names) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found[relative(root, path).split(sep).join("/")] = sha256(await readFile(path));
    }
  };
  await walk(root);
  return found;
}

const recordsOf = (state) => Object.fromEntries(RECORD_COLLECTIONS.map((name) => [name, state[name]]));

// A card as the library's crest takes it: scope workspace unless overridden.
function card(externalKey, subject, overrides = {}) {
  return {
    occurredAt: "2026-09-25T06:00:05Z", externalKey, scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["migration"], subject, summary: `${subject}, in brief`,
    snippet: `${subject}, the line to recall`, accountableOwnerId: "owner:sub-421", sourceReferences: [], sourceDigest: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
    freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${externalKey} body`, ...overrides,
  };
}

// The fixture as its old engine would leave it with a knowledge store beside the chain. The
// workspace root is bound where it was restored, since the old layout binds its store to its root.
// The cards are written through a library that holds the same chain -- an import of the fixture,
// whose own receipt carries no knowledge -- and laid out as the old engine kept them: the marker, a
// metadata file and a body per card (the bodies moved into segments when asked, as cross-project's
// are), and the index view the old layout's reader checks.
async function restoreWithKnowledge(base, { segmented }) {
  const restored = await restoreLegacyFixture(base, "legacy");
  const metadataPath = join(restored.control, "workspace.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.roots = metadata.roots.map((entry) => (entry.kind === "workspace"
    ? { ...entry, canonicalPath: restored.root, path: restored.root, portableIdentity: restored.root.toLowerCase() }
    : entry));
  await writeFile(metadataPath, canonicalJson(metadata));
  const donor = join(base, "donor");
  assert.equal((await cli(["library-import-legacy", "--legacy", restored.root, "--target", donor, "--at", "2026-09-25T06:00:00Z"])).knowledge, null,
    "an old workspace without a knowledge store carries none");
  const projectId = (await materializeWorkspace(donor)).projects.find((entry) => !entry.tombstone).id;
  await initializeKnowledgeStore(donor, { disposableAcknowledged: true });
  const kestrel = await createKnowledgeUnit(donor, card("SUB-421-KESTREL", "Kestrel hover timing"));
  await createKnowledgeUnit(donor, card("SUB-421-KESTREL-NEW", "Kestrel hover timing, measured", { occurredAt: "2026-09-25T06:00:06Z", supersedes: kestrel.id }));
  await createKnowledgeUnit(donor, card("SUB-421-HERON", "Heron wading depth", { scope: "project", projectId }));
  await createKnowledgeUnit(donor, card("SUB-421-OTTER", "Otter slide angle", { retrievalDisposition: "explicit-only" }));
  const crest = join(donor, DIRECTORY.knowledge);
  const all = await listKnowledgeMetadata(donor, { at: AT, selection: "all", limit: 100 });
  const marker = await readKnowledgeStoreMarker(donor);
  const bodies = new Map();
  for (const device of await readdir(join(crest, "events"))) {
    for (const name of await readdir(join(crest, "events", device))) {
      if (name.endsWith(".body")) bodies.set(name.slice(9, -5), await readFile(join(crest, "events", device, name)));
    }
  }
  await mkdir(join(crest, "metadata"));
  await mkdir(join(crest, "bodies"));
  for (const record of all.records) {
    await writeFile(join(crest, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(crest, "bodies", `${record.id}.body`), bodies.get(record.bodySha256));
  }
  const storeJson = join(crest, "store.json");
  await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rm(join(crest, "events"), { recursive: true });
  if (segmented) await migrateKnowledgeBodies(donor, 4096);
  // A read projects the index view into this device's cache; the old layout keeps it in views/.
  await listKnowledgeMetadata(donor, { at: AT, limit: 1 });
  const knowledge = join(restored.control, "knowledge");
  await mkdir(join(knowledge, "views"), { recursive: true });
  for (const entry of ["store.json", "metadata", "bodies"]) await cp(join(crest, entry), join(knowledge, entry), { recursive: true });
  await cp(join(cachePath(expected.workspaceId), "crest-views", "index.json"), join(knowledge, "views", "index.json"));
  await rm(donor, { recursive: true });
  return { ...restored, knowledge };
}

// What knowledge-list answers for a store: how many cards, in all and by default.
async function listed(workspace, at = AT) {
  const total = async (selection) => (await cli(["knowledge-list", "--workspace", workspace, "--at", at, "--selection", selection, "--allow-trailing", "true", "--limit", "1"])).total;
  return { all: await total("all"), default: await total("default") };
}

test("468-R6, AC4 (fixture): an import carries the old chain's events, head and segment bytes into the first stream", async (context) => {
  const base = await scratch(context);
  const { root, events } = await restoreLegacyFixture(base, "legacy");
  const oldTree = await treeDigest(root);
  const legacyState = await materializeWorkspace(root);
  const target = join(base, ".ether");
  const receipt = await cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT, "--project-name", "Legacy fixture"]);
  assert.equal(receipt.reasonCode, "LEGACY_IMPORTED");
  assert.equal(receipt.events, expected.events);
  assert.equal(receipt.headEventHash, expected.headEventHash);
  assert.equal(receipt.workspaceId, expected.workspaceId);
  assert.equal(receipt.knowledge, null, "the fixture has no knowledge store");
  assert.deepEqual(await treeDigest(root), oldTree, "the old workspace was only read");

  // The library keeps the old workspace id, and its root holds the seven entries.
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  assert.equal(manifest.libraryId, expected.workspaceId);
  assert.deepEqual((await readdir(target)).sort(), [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);

  // Every old segment is a stream segment with the same bytes.
  const [deviceId] = await readdir(join(target, "akasha"));
  assert.equal(deviceId, receipt.deviceId);
  const stream = join(target, "akasha", deviceId);
  const oldSegments = (await readdir(events)).filter((name) => name.endsWith(".ndjson")).sort();
  assert.equal(oldSegments.length, expected.segments);
  for (const [index, name] of oldSegments.entries()) {
    const copied = join(stream, `${(index + 1).toString(16).padStart(8, "0")}.ndjson`);
    assert.equal(sha256(await readFile(copied)), sha256(await readFile(join(LEGACY_FIXTURE_ROOT, "control/events", name))), name);
  }
  const streamManifest = JSON.parse(await readFile(join(stream, "manifest.json"), "utf8"));
  assert.deepEqual(
    [streamManifest.identityScheme, streamManifest.sequence, streamManifest.headEventHash, streamManifest.clockHighWater],
    ["legacy", expected.events, expected.headEventHash, expected.events],
  );

  // It replays to the same records, and chain-validate reads it stream by stream.
  const imported = await materializeWorkspace(target);
  assert.equal(imported.version, expected.version);
  assert.deepEqual(imported.library.streams.map((entry) => [entry.streamId, entry.headEventHash]), [[streamManifest.streamId, expected.headEventHash]]);
  assert.deepEqual(imported.work, legacyState.work);
  assert.deepEqual(imported.settings, legacyState.settings);
  assert.equal(imported.work.find((entry) => entry.id === expected.records.story.id)?.externalKey, expected.records.story.externalKey);
  const validated = await cli(["chain-validate", "--workspace", target]);
  assert.deepEqual([validated.reasonCode, validated.layout, validated.events], ["CHAIN_VALIDATED", "library", expected.events]);
  assert.equal((await cli(["status", "--workspace", target])).configProjection, "current", "the imported settings are projected");
});

test("466-AC3 (end to end): after an import, a new event continues the stream in einzbern.* and the old events stay tcrn.*", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreLegacyFixture(base, "legacy");
  const target = join(base, ".ether");
  await cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT]);
  const projectId = (await materializeWorkspace(target)).projects.find((entry) => !entry.tombstone).id;
  const receipt = await cli(["work-create", "--workspace", target, "--at", "2026-09-26T06:00:01Z", "--project-id", projectId,
    "--external-key", "IMPORTED-INITIATIVE", "--kind", "Initiative", "--title", "after-import", "--actor", "agent:importer"]);
  assert.equal(receipt.version, expected.events + 1);

  const { events } = await readAllStreams(target);
  const stored = events.map((entry) => entry.event);
  assert.equal(stored.length, expected.events + 1);
  assert.deepEqual([...new Set(stored.slice(0, -1).map((event) => event.schemaVersion))], ["tcrn.event.v1"], "old events keep the legacy namespace");
  const appended = stored.at(-1);
  assert.equal(appended.schemaVersion, "einzbern.event.v1");
  assert.equal(appended.sequence, expected.events + 1);
  assert.equal(appended.priorHash, expected.headEventHash, "the new event links onto the old head");
  assert.equal(appended.clock, expected.events + 1);
  assert.equal((await cli(["chain-validate", "--workspace", target])).reasonCode, "CHAIN_VALIDATED");
});

test("468-AC4, SUB-421: a dry run under the write tripwire reports the chain, the records and the knowledge, writes nothing and creates no target", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreWithKnowledge(base, { segmented: true });
  const before = await treeDigest(base);
  // The device directory lies under the tripwire too: a dry run needs no device.
  const run = spawnSync(process.execPath, ["--import", tripwirePath, cliPath, "library-import-legacy", "--legacy", root, "--dry-run", "true", "--at", AT], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_TRIPWIRE_ROOT: base, EINZBERN_HOME: join(base, "unused-device") },
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual([report.reasonCode, report.dryRun, report.events, report.headEventHash, report.target],
    ["LEGACY_IMPORT_DRY_RUN", true, expected.events, expected.headEventHash, null]);
  assert.equal(report.segments.length, expected.segments);
  assert.equal(report.records.digest, legacyRecordsDigest(await materializeWorkspace(root)));
  assert.deepEqual([report.knowledge.cards, report.knowledge.defaultCards], [4, 2]);
  assert.deepEqual(await treeDigest(base), before, "nothing was written, the default target and the device directory included");
  await assert.rejects(stat(join(root, ".ether")), { code: "ENOENT" });
});

test("468-R6: a target that is not empty is refused and left as it was", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreLegacyFixture(base, "legacy");
  const target = join(base, "occupied");
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "mine\n");
  await assert.rejects(cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT]), (error) => error?.reasonCode === "LIBRARY_TARGET_NOT_EMPTY");
  assert.deepEqual(await readdir(target), ["keep.txt"]);
});

test("SUB-421 (INC-397): the records digest is canonicalSha256's within one MiB and compares a set past it record by record, refusing nothing and relaxing nothing", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreLegacyFixture(base, "legacy");
  const state = await materializeWorkspace(root);
  assert.equal(legacyRecordsDigest(state), canonicalSha256(recordsOf(state)), "the same canonical form, hashed in pieces");

  // Past one MiB: the fixture's records and 1,100 more work records of about 1.5 KB each.
  const story = state.work.find((entry) => entry.id === expected.records.story.id);
  const synthetic = Array.from({ length: 1_100 }, (_, index) => ({ ...story, id: `work:${index.toString(16).padStart(24, "0")}`, title: `synthetic ${index} ${"x".repeat(1_000)}` }));
  const large = { ...structuredClone(recordsOf(state)), work: [...structuredClone(state.work), ...synthetic] };
  assert.ok(canonicalByteLength(large) > 1_048_576, "the set is past the canonical ceiling");
  assert.throws(() => canonicalSha256(large), (error) => error?.reasonCode === "INPUT_OVERSIZED", "which canonicalSha256 refuses");
  const digest = legacyRecordsDigest(large);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assertLegacyRecordsMatch(large, structuredClone(large));

  // A tampered copy is still refused, and the refusal names what differs.
  const refusedOn = (collections) => (error) => error?.reasonCode === "LEGACY_IMPORT_MISMATCH" && error.details.collections === collections;
  const edited = structuredClone(large);
  edited.work.at(-1).title += "!";
  assert.throws(() => assertLegacyRecordsMatch(large, edited), refusedOn("work"), "one character of the last record");
  const reordered = structuredClone(large);
  [reordered.work[0], reordered.work[1]] = [reordered.work[1], reordered.work[0]];
  assert.throws(() => assertLegacyRecordsMatch(large, reordered), refusedOn("work"), "two records swapped");
  const dropped = { ...structuredClone(large), settings: large.settings.slice(1) };
  assert.throws(() => assertLegacyRecordsMatch(large, dropped), refusedOn("settings"), "a record missing");
  assert.notEqual(legacyRecordsDigest(edited), digest);

  // Nothing is skipped: a record that is not canonical still throws.
  const invalid = structuredClone(large);
  invalid.work.at(-1).rank = 1.5;
  assert.throws(() => legacyRecordsDigest(invalid), (error) => error?.reasonCode === "CANONICAL_VALUE_INVALID");
});

test("SUB-421 (MIN-239 D7): a dry run and an import report the same checks; the old store lands in crest/ byte for byte, answers the same cards and takes new ones beside them", async (context) => {
  const base = await scratch(context);
  const { root, knowledge } = await restoreWithKnowledge(base, { segmented: true });
  const legacyState = await materializeWorkspace(root);
  const carried = Object.fromEntries(Object.entries(await entries(knowledge)).filter(([path]) => !path.startsWith("views/")));
  const carriedBytes = (await Promise.all(Object.keys(carried).map(async (path) => (await stat(join(knowledge, path))).size))).reduce((total, size) => total + size, 0);
  const oldTree = await treeDigest(root);
  const oldCards = await listed(root);
  assert.deepEqual(oldCards, { all: 4, default: 2 }, "the old store read as its engine left it");

  const dryRun = await cli(["library-import-legacy", "--legacy", root, "--at", AT, "--dry-run", "true"]);
  const target = join(base, ".ether");
  const receipt = await cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT]);
  assert.equal(receipt.reasonCode, "LEGACY_IMPORTED");
  assert.deepEqual(receipt.records, dryRun.records, "the dry run made the records check the import made");
  assert.equal(receipt.records.digest, legacyRecordsDigest(legacyState));
  assert.deepEqual(receipt.records.counts, Object.fromEntries(RECORD_COLLECTIONS.map((name) => [name, legacyState[name].length])));
  assert.deepEqual(receipt.knowledge, dryRun.knowledge);
  assert.deepEqual(receipt.knowledge, { cards: oldCards.all, defaultCards: oldCards.default, files: Object.keys(carried).length, bytes: carriedBytes });
  assert.deepEqual(await treeDigest(root), oldTree, "the old workspace was only read");

  // crest/ holds the old store's marker, metadata and bodies byte for byte, the segments included,
  // and nothing else: the views stay behind.
  const crest = join(target, DIRECTORY.knowledge);
  assert.deepEqual(await entries(crest), carried);
  assert.equal(Object.keys(carried).includes("bodies/manifest.json"), true, "the bodies are in segments");
  assert.deepEqual(await listed(target), oldCards, "the library's crest answers the cards the old store answers");

  // config/project.json (SUB-287): the imported settings projected, which status reads as current.
  const projection = JSON.parse(await readFile(join(target, "config", "project.json"), "utf8"));
  assert.equal(projection.schemaVersion, "einzbern.project-config.v1");
  assert.deepEqual(projection.values, Object.fromEntries(legacyState.settings.map(({ key, value }) => [key, value])));
  assert.equal((await cli(["status", "--workspace", target])).configProjection, "current");

  // A new card appends to this device's crest stream beside the carried layout, which keeps its bytes.
  const before = await listed(target, LATER);
  await createKnowledgeUnit(target, card("SUB-421-CRANE", "Crane migration route", { occurredAt: "2026-09-26T06:30:00Z" }));
  const appended = await entries(crest);
  for (const [path, digest] of Object.entries(carried)) assert.equal(appended[path], digest, `the carried layout is not rewritten: ${path}`);
  assert.deepEqual(Object.keys(appended).filter((path) => !Object.hasOwn(carried, path)).every((path) => path.startsWith("events/")), true);
  assert.deepEqual(await listed(target, LATER), { all: before.all + 1, default: before.default + 1 });
});

test("SUB-421: an old store its engine bound to another place is refused with that store's own reason code, in a dry run as in an import, before anything is written", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreWithKnowledge(base, { segmented: false });
  // The chain reads wherever it sits; the old layout's store is bound to the root its engine knew.
  const moved = join(base, "moved");
  await cp(root, moved, { recursive: true });
  const target = join(base, ".ether");
  for (const extra of [["--dry-run", "true"], ["--target", target]]) {
    await assert.rejects(cli(["library-import-legacy", "--legacy", moved, "--at", AT, ...extra]), (error) => error?.reasonCode === "KNOWLEDGE_PATH_INVALID", extra.join(" "));
  }
  await assert.rejects(stat(target), { code: "ENOENT" });
  await assert.rejects(stat(join(moved, ".ether")), { code: "ENOENT" });
});

test("SUB-421 (INC-397): an import that stops after it has written names its target and everything it left there, and removes nothing", async (context) => {
  const base = await scratch(context);
  const { root, knowledge } = await restoreWithKnowledge(base, { segmented: false });
  const stopped = (target, copyTransformForTest) => importLegacyWorkspace(root, target, { createdAt: AT, copyTransformForTest }).then(() => null, (error) => error);

  // The third segment does not land as it was read: the skeleton and three segments are written.
  const chainTarget = join(base, "chain-stop");
  const chainStop = await stopped(chainTarget, (path, bytes) => (path.endsWith("/00000003.ndjson") ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes));
  assert.ok(chainStop instanceof LegacyImportStoppedError, String(chainStop));
  assert.deepEqual([chainStop.reasonCode, chainStop.details.segment, chainStop.details.target, chainStop.target], ["LEGACY_IMPORT_MISMATCH", "00000003.ndjson", chainTarget, chainTarget]);
  const [deviceId] = await readdir(join(chainTarget, "akasha"));
  assert.deepEqual(chainStop.written, [
    ".gitignore", "README.md", ...[1, 2, 3].map((ordinal) => `akasha/${deviceId}/0000000${ordinal}.ndjson`), "artifacts/", "config/", "crest/", "manifest.json",
  ]);
  assert.deepEqual(chainStop.written, Object.keys(await entries(chainTarget)).sort(compareCanonicalText), "exactly what the target holds");
  for (const entry of chainStop.written) assert.equal(chainStop.message.includes(entry), true, `the message names ${entry}`);

  // A carried metadata file does not land as it was read: the chain is in, the store is not whole,
  // and config/project.json was never written.
  const [firstCard] = (await readdir(join(knowledge, "metadata"))).sort(compareCanonicalText);
  const crestTarget = join(base, "crest-stop");
  const crestStop = await stopped(crestTarget, (path, bytes) => (path === `crest/metadata/${firstCard}` ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes));
  assert.ok(crestStop instanceof LegacyImportStoppedError, String(crestStop));
  assert.deepEqual([crestStop.reasonCode, crestStop.details.file, crestStop.details.target], ["LEGACY_IMPORT_MISMATCH", `crest/metadata/${firstCard}`, crestTarget]);
  const left = await entries(crestTarget);
  assert.deepEqual(crestStop.written, Object.keys(left).sort(compareCanonicalText));
  assert.equal(crestStop.written.filter((entry) => /^akasha\/[a-f0-9]{32}\/[0-9a-f]{8}\.ndjson$/u.test(entry)).length, expected.segments);
  assert.deepEqual(crestStop.written.filter((entry) => entry.startsWith("crest/")), ["crest/bodies/", `crest/metadata/${firstCard}`, "crest/store.json"]);
  assert.equal(Object.hasOwn(left, "config/project.json"), false);

  // Nothing was removed: an import into either target again is refused as not empty.
  for (const target of [chainTarget, crestTarget]) {
    await assert.rejects(importLegacyWorkspace(root, target, { createdAt: AT }), (error) => error?.reasonCode === "LIBRARY_TARGET_NOT_EMPTY");
  }
});
