// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-489 R1, R2, R4, AC1, AC4 (TCRN-CROSS-SUB-365; MIN-235 D17, MIN-238 D4): setup
// --mode migrate --yes true runs the plan. Two old partitions in a temporary container, one the
// frozen old-layout fixture and one the same chain under another workspace id (as every real
// partition has its own), become the first streams of their projects' libraries: each library
// replays and chain-validates to the old chain's events and head, this device's registry gets an
// entry with migratedFrom for each, and the old device directory's portal keys are set, while the
// old container and the old device directory stay byte for byte as they were under the write
// tripwire. The same mapping applied again changes nothing. A write aimed at a migrated old path is
// refused with the library it moved to; an old workspace this device never migrated is refused as
// before. An old chain that changed after it was planned stops the apply and names the partition.
// Every home, device directory, container and project here is temporary.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  DIRECTORY,
  FRAMEWORK_VERSION,
  LEGACY_CONTAINER_DIRECTORY,
  cachePath,
  chainIdentity,
  createKnowledgeUnit,
  declareChainIdentity,
  importLegacyWorkspace,
  initializeKnowledgeStore,
  listKnowledgeMetadata,
  removeWorkspaceSetting,
  resolveProjectTarget,
  setWorkspaceSetting,
  LEGACY_CONTROL_DIRECTORY,
  LEGACY_DEVICE_DIRECTORY,
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTINGS_VERSION,
  initializeLibrary,
  materializeWorkspace,
  openLegacyWorkspace,
  readAllStreams,
  readRegistry,
  registerLibrary,
} from "../dist/build/packages/core/src/index.js";
import { ENGINE_CURRENT_SCHEMA_VERSION, ENGINE_FILES } from "../dist/build/packages/core/src/engine-home.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { MIGRATION_MAPPING_SCHEMA_VERSION, applyMigration, planMigration, readMigrationMapping } from "../dist/build/packages/core/src/migrate-legacy.js";
import { findMigratedEntry } from "../dist/build/packages/core/src/registry.js";
import { FRESH_ENGINE_TREE, SetupRecorder } from "../dist/build/packages/core/src/setup-fresh.js";
import { applySetup, planSetup } from "../dist/build/packages/core/src/setup.js";
import { legacyWorkspaceEventId, legacyWorkspaceStreamId } from "../dist/build/packages/core/src/workspace.js";
import { canonicalJson, createEvent, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED as expected, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-migrate-apply-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

// The second partition's old workspace: the fixture's chain, bound to another workspace, whose id
// derives from its external key as every old workspace id does.
const ALPHA_EXTERNAL_KEY = "LEGACY-ALPHA-WORKSPACE";
const ALPHA_WORKSPACE_ID = deriveStableId("workspace", ALPHA_EXTERNAL_KEY);
// The fixture's one live gate: pending, bound to its Story.
const FIXTURE_GATE_ID = "gate:f48272b1736ccd8d29165c37";
// TCRN-CROSS-STORY-517: the fixture's one live project ("Legacy fixture", seven live work items); its
// id derives from its external key, so every rehomed partition holds the same one.
const FIXTURE_PROJECT_ID = "project:3443417fe20a3dd2b9f42d05";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 29, 8, 0, second)).toISOString().replace(".000Z", "Z");
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Relative path, size, mtime and sha256 of every entry under a directory. */
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

/**
 * A temporary device from before the rename: a home with the old device directory, a device
 * directory whose engine/current names a version holding the files a plan checks for (the
 * migration installs nothing from them: the wiring is TCRN-CROSS-SUB-366's), and a container.
 */
async function machine(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-migrate-apply-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const container = join(base, "container");
  const deviceHome = join(base, "device");
  const legacyDevice = join(home, LEGACY_DEVICE_DIRECTORY);
  await mkdir(legacyDevice, { recursive: true });
  await mkdir(container);
  const version = join(deviceHome, "engine", FRAMEWORK_VERSION);
  const files = [ENGINE_FILES.entry, ...FRESH_ENGINE_TREE.launchers.map((launcher) => launcher.from), `${FRESH_ENGINE_TREE.skill}/${FRESH_ENGINE_TREE.skillEntry}`];
  for (const file of files) {
    await mkdir(dirname(join(version, file)), { recursive: true });
    await writeFile(join(version, file), "// present for the plan's engine check\n");
  }
  await writeFile(join(deviceHome, "engine", ENGINE_FILES.current),
    `${JSON.stringify({ previous: null, schemaVersion: ENGINE_CURRENT_SCHEMA_VERSION, switchedAt: "2026-09-29T07:00:00Z", version: FRAMEWORK_VERSION })}\n`);
  return { base, home, container, deviceHome, legacyDevice, oldContainer: join(container, LEGACY_CONTAINER_DIRECTORY) };
}

/**
 * The frozen fixture's chain written again as the old engine would have written it for another
 * workspace (external key and the id it derives): every event keeps its payload and occurrence and
 * takes the stream and identity that id derives, each segment keeping its events.
 */
async function rehome(root, externalKey) {
  const legacy = await openLegacyWorkspace(root);
  const control = join(root, LEGACY_CONTROL_DIRECTORY);
  const metadata = { ...JSON.parse(await readFile(join(control, "workspace.json"), "utf8")), externalKey, workspaceId: deriveStableId("workspace", externalKey) };
  const streamId = legacyWorkspaceStreamId(metadata);
  let priorHash = null;
  const lines = legacy.events.map((event) => {
    const rewritten = createEvent({
      id: legacyWorkspaceEventId(streamId, event.sequence),
      streamId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      priorHash,
      payload: event.payload,
    }, "tcrn.event.v1");
    priorHash = rewritten.eventHash;
    return canonicalJson(rewritten);
  });
  await writeFile(join(control, "workspace.json"), canonicalJson(metadata));
  for (const segment of legacy.segments) {
    await writeFile(join(control, "events", segment.name), lines.slice(segment.firstSequence - 1, segment.lastSequence).join(""));
  }
  return priorHash;
}

/** An old partition in the container's old layout; answers the old workspace, its id and its chain's head. */
async function oldPartition(m, name, externalKey = null) {
  const { root } = await restoreLegacyFixture(join(m.oldContainer, name), "workspace");
  const head = externalKey === null ? expected.headEventHash : await rehome(root, externalKey);
  return { root, head, workspaceId: externalKey === null ? expected.workspaceId : deriveStableId("workspace", externalKey) };
}

async function project(m, name) {
  const root = join(m.container, name);
  await mkdir(root);
  return root;
}

/** Append events to an old chain as its engine wrote them, in one more segment (tests/migrate-plan.test.mjs); answers the new head. */
async function appendLegacyEvents(root, payloads) {
  const workspace = await openLegacyWorkspace(root);
  let priorHash = workspace.events.at(-1).eventHash;
  let sequence = workspace.events.length;
  const lines = [];
  for (const payload of payloads) {
    sequence += 1;
    const event = createEvent({
      id: legacyWorkspaceEventId(workspace.streamId, sequence),
      streamId: workspace.streamId,
      sequence,
      occurredAt: payload.record.updatedAt,
      priorHash,
      payload,
    }, "tcrn.event.v1");
    lines.push(canonicalJson(event));
    priorHash = event.eventHash;
  }
  const segment = `${String(workspace.segments.length + 1).padStart(6, "0")}.ndjson`;
  await writeFile(join(root, LEGACY_CONTROL_DIRECTORY, "events", segment), lines.join(""));
  return priorHash;
}

/** Old chains declare settings at the library level; after attestation was enabled each payload carries the fixture's actor. */
async function appendLegacySettings(root, settings) {
  const actor = (await openLegacyWorkspace(root)).events.at(-1).payload.actor;
  return appendLegacyEvents(root, settings.map(([key, value], index) => ({
    actor,
    operation: "settings.updated",
    record: { key, layerKind: "workspace_configuration", revision: 1, schemaVersion: "tcrn.workspace-setting.v1", tombstone: false,
      updatedAt: `2026-01-01T00:00:${40 + index}Z`, value },
  })));
}

/**
 * TCRN-CROSS-INIT-053 R47 (R47-05): an old partition whose knowledge store holds two cards, laid out from
 * engine-written records as tests/migrate-plan.test.mjs lays them out; `settings` go into the old chain
 * first, so the store is written at the chain's head. Answers the old workspace and the two card ids.
 */
async function oldCardPartition(m, name, settings = []) {
  const { root } = await restoreLegacyFixture(join(m.oldContainer, name), "workspace");
  const metadataPath = join(root, LEGACY_CONTROL_DIRECTORY, "workspace.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.roots = metadata.roots.map((entry) => (entry.kind === "workspace" ? { ...entry, canonicalPath: root, path: root, portableIdentity: root.toLowerCase() } : entry));
  await writeFile(metadataPath, canonicalJson(metadata));
  if (settings.length > 0) await appendLegacySettings(root, settings);
  const donor = join(m.base, `${name}-donor`);
  await importLegacyWorkspace(root, donor, { createdAt: "2026-09-25T06:00:00Z" });
  await initializeKnowledgeStore(donor, { disposableAcknowledged: true });
  // Two cards on different subjects; the store is told they coexist.
  const subjects = [`${name} release archives carry a digest file beside them`, `${name} wizard recall smoke asks for the newest card`];
  const bodies = new Map();
  for (const [index, externalKey] of ["CARD-SMOKE-OLDER", "CARD-SMOKE-NEWEST"].entries()) {
    const body = `${externalKey}: ${name} source text`;
    const created = await createKnowledgeUnit(donor, {
      occurredAt: `2026-09-25T06:00:0${index + 1}Z`, externalKey, scope: "workspace", projectId: null, roleScopes: [],
      category: "workflow", kind: "fact", tags: ["migration"], subject: subjects[index],
      summary: `${externalKey} summary`, snippet: `${externalKey} snippet`, accountableOwnerId: "owner:r47", sourceReferences: [], sourceDigest: null,
      linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
      freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only", body, coexist: true,
    });
    bodies.set(created.id, body);
  }
  const listed = await listKnowledgeMetadata(donor, { at: "2026-09-30T06:00:00Z", selection: "all", status: "all", limit: 100 });
  const marker = await readKnowledgeStoreMarker(donor);
  const knowledge = join(root, LEGACY_CONTROL_DIRECTORY, "knowledge");
  for (const directory of ["metadata", "bodies", "views"]) await mkdir(join(knowledge, directory), { recursive: true });
  const storedMarker = JSON.parse(await readFile(join(donor, DIRECTORY.knowledge, "store.json"), "utf8"));
  await writeFile(join(knowledge, "store.json"), canonicalJson({ ...storedMarker, version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  for (const record of listed.records) {
    await writeFile(join(knowledge, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(knowledge, "bodies", `${record.id}.body`), bodies.get(record.id));
  }
  await writeFile(join(knowledge, "views", "index.json"), await readFile(join(cachePath(expected.workspaceId), "crest-views", "index.json")));
  const byKey = new Map(listed.records.map((record) => [record.externalKey, record]));
  return { root, newest: byKey.get("CARD-SMOKE-NEWEST"), older: byKey.get("CARD-SMOKE-OLDER") };
}

async function writeMapping(m, partitions, file = join(m.base, "mapping.json")) {
  await writeFile(file, `${JSON.stringify({ schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION, partitions }, null, 2)}\n`);
  return file;
}

async function writeLegacySettings(m, values) {
  await writeFile(join(m.legacyDevice, "machine-settings.json"), `${JSON.stringify({
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    schemaVersion: MACHINE_SETTINGS_VERSION,
    updatedAt: "2026-09-24T03:54:18.104Z",
    values,
  })}\n`);
}

/** One CLI run through the shipped entry as this device, optionally under the write tripwire. */
function run(m, args, { tripwire = [] } = {}) {
  return spawnSync(process.execPath, [...(tripwire.length === 0 ? [] : ["--import", tripwirePath]), cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: m.home,
      USERPROFILE: m.home,
      EINZBERN_HOME: m.deviceHome,
      ...(tripwire.length === 0 ? {} : { EINZBERN_TRIPWIRE_ROOT: tripwire.join(delimiter) }),
    },
  });
}

function receipt(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function refusal(result) {
  assert.equal(result.status, 1, result.stdout);
  return JSON.parse(result.stderr.trim().split("\n").at(-1));
}

function setup(m, mapping, extra = [], options = {}) {
  return run(m, ["setup", "--mode", "migrate", "--project", m.container, "--mapping", mapping, "--at", at(), ...extra], options);
}

/** The two-partition container of 489-AC1, migrated once; answers everything the tests look at. */
async function migrated(context, { registry = false } = {}) {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  const alpha = await oldPartition(m, "alpha", ALPHA_EXTERNAL_KEY);
  const alphaProject = await project(m, "alpha");
  await writeLegacySettings(m, { "portal.defaultTheme": "dark", "agents.navigation": "written" });
  if (registry) {
    // A library this device registered before the migration: the migration keeps its entry.
    const other = join(m.base, "other");
    await mkdir(other);
    await initializeLibrary({ root: join(other, ".ether"), createdAt: at() });
    await registerLibrary({ projectPath: other, libraryPath: join(other, ".ether"), registeredAt: at(), cloudHosted: false, gitRemote: null }, m.deviceHome);
  }
  const mapping = await writeMapping(m, [
    { partition: "cross-project", legacyWorkspace: crossProject.root, projectRoot: m.container },
    { partition: "alpha", legacyWorkspace: alpha.root, projectRoot: alphaProject, projectName: "Alpha", gitRemote: "https://example.invalid/team/alpha.git" },
  ]);
  const targets = [join(m.container, ".ether"), join(alphaProject, ".ether")];
  return { m, crossProject, alpha, alphaProject, mapping, targets };
}

test("489-R1, R2, AC1 (fixture): setup --mode migrate --yes true imports each partition as its library's first stream, registers it with migratedFrom and sets the portal keys, and writes nothing old", async (context) => {
  const { m, crossProject, alpha, alphaProject, mapping, targets } = await migrated(context);
  const oldBefore = await treeDigest(m.oldContainer);
  const legacyDeviceBefore = await treeDigest(m.legacyDevice);

  // The apply runs in a process whose every write under the old container and the old device
  // directory is refused.
  const applied = receipt(setup(m, mapping, ["--yes", "true"], { tripwire: [m.oldContainer, m.legacyDevice] }));
  assert.deepEqual([applied.reasonCode, applied.mode], ["SETUP_APPLIED", "migrate"]);
  // TCRN-CROSS-INIT-053 R47 (R47-05): the project's own library holds no card, so the smoke has nothing to ask for.
  assert.deepEqual(applied.recallSmoke, { status: "no-card" });
  assert.deepEqual(await treeDigest(m.oldContainer), oldBefore, "no old workspace was written");
  assert.deepEqual(await treeDigest(m.legacyDevice), legacyDeviceBefore, "the old device directory was only read");

  const registryFile = join(m.deviceHome, "registry.json");
  const settingsFile = join(m.deviceHome, "machine-settings.json");
  assert.deepEqual(applied.written.map((entry) => [entry.step, entry.path, entry.action]), [
    ["device", join(m.deviceHome, "device.json"), "create"],
    ["library", targets[0], "create"],
    ["library", targets[1], "create"],
    ["registry", registryFile, "create"],
    ["machine-settings", settingsFile, "create"],
    // TCRN-CROSS-SUB-366: then the fresh mode's wiring, all but the registry; the project's own
    // library (its language and section records) is listed once, at its import.
    ["skill-copies", join(m.home, ".claude", "skills", "mana-orchestrate"), "create"],
    ["skill-copies", join(m.home, ".agents", "skills", "mana-orchestrate"), "create"],
    ["skill-copies", join(m.deviceHome, "skills.json"), "create"],
    ["launchers", join(m.deviceHome, "engine", "einzbern.mjs"), "create"],
    ["launchers", join(m.deviceHome, "engine", "hook.mjs"), "create"],
    ["host-hooks", join(m.home, ".claude", "settings.json"), "create"],
    ["host-hooks", join(m.home, ".codex", "hooks.json"), "create"],
    ["host-hooks", join(m.home, ".codex", "config.toml"), "create"],
    ["managed-sections", join(m.container, "AGENTS.md"), "create"],
    ["managed-sections", join(m.container, "CLAUDE.md"), "create"],
  ]);
  assert.deepEqual(applied.library, { path: targets[0], libraryId: expected.workspaceId, created: true });
  assert.deepEqual(applied.migration.partitions.map((entry) => [entry.partition, entry.action, entry.target, entry.libraryId, entry.events, entry.headEventHash]), [
    ["cross-project", "imported", targets[0], expected.workspaceId, expected.events, expected.headEventHash],
    ["alpha", "imported", targets[1], ALPHA_WORKSPACE_ID, expected.events, alpha.head],
  ]);

  // 489-AC1: each library chain-validates, and its one stream is the old stream, imported as it
  // was: the old chain's events up to the old head. alpha's ends there; in the project's own library
  // this device went on writing the stream after the import, with the language and the section
  // records of the wiring (TCRN-CROSS-SUB-366), so the old head is its event at the old count.
  for (const [target, partition] of [[targets[0], crossProject], [targets[1], alpha]]) {
    const validated = receipt(run(m, ["chain-validate", "--workspace", target]));
    assert.deepEqual([validated.reasonCode, validated.layout, validated.workspaceId, validated.rejectedEventCount],
      ["CHAIN_VALIDATED", "library", partition.workspaceId, 0], target);
    assert.deepEqual(validated.streams.map((stream) => stream.identityScheme), ["legacy"], target);
    const [stream] = (await readAllStreams(target)).streams;
    assert.equal(stream.events[expected.events - 1].eventHash, partition.head, target);
    if (target === targets[1]) assert.deepEqual([validated.events, validated.streams[0].headEventHash], [expected.events, partition.head], target);
    else assert.ok(validated.events > expected.events, target);
  }

  // The registry: one entry per project, each with the old workspace it was migrated from.
  const registry = await readRegistry(m.deviceHome);
  assert.deepEqual(registry.entries.map((entry) => [entry.projectPath, entry.libraryPath, entry.libraryId, entry.gitRemote, entry.cloudHosted, entry.migratedFrom]), [
    [m.container, targets[0], expected.workspaceId, null, false, crossProject.root],
    [alphaProject, targets[1], ALPHA_WORKSPACE_ID, "example.invalid/team/alpha", false, alpha.root],
  ]);
  assert.deepEqual(applied.migration.registry, registry.entries);
  assert.equal((await findMigratedEntry(alpha.root, m.deviceHome))?.libraryPath, targets[1], "the old path finds the library it moved to");

  // The portal key travels; the old device's other keys do not.
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.deepEqual(settings.values, { "agents.navigation": "written", "portal.defaultTheme": "dark" });
  assert.deepEqual(applied.migration.deviceSettings.keys, [{ key: "portal.defaultTheme", value: "dark", current: null, action: "set" }]);

  // MIN-238 D4: the fixture's pending gate is pending in the library, as it was in the old chain.
  const library = await materializeWorkspace(targets[0]);
  assert.deepEqual(library.gates.filter((gate) => !gate.tombstone).map((gate) => [gate.id, gate.status]), [[FIXTURE_GATE_ID, "pending"]]);
  assert.equal(applied.selfCheck.checks.length, 8, "doctor's eight checks ran as the self-check");
});

test("489-R1 (TCRN-CROSS-SUB-365): the same mapping applied again skips every migrated partition and writes nothing", async (context) => {
  const { m, mapping, targets } = await migrated(context);
  receipt(setup(m, mapping, ["--yes", "true"]));
  const files = [join(m.deviceHome, "registry.json"), join(m.deviceHome, "machine-settings.json"), join(m.deviceHome, "device.json")];
  const libraries = await Promise.all(targets.map((target) => treeDigest(target)));
  const before = await Promise.all(files.map(async (file) => [file, sha256(await readFile(file)), (await stat(file)).mtimeMs]));

  const replanned = receipt(setup(m, mapping));
  assert.deepEqual(replanned.migration.partitions.map((entry) => [entry.partition, entry.targetState, entry.action]), [
    ["cross-project", "migrated", "skip"],
    ["alpha", "migrated", "skip"],
  ]);
  assert.deepEqual([replanned.writes, replanned.blockers, replanned.backups], [[], [], []], "a second plan has nothing to write and nothing that stops it");
  assert.deepEqual(replanned.library, { path: targets[0], action: "reuse", libraryId: expected.workspaceId });

  // Every write under the old container, the old device directory and both libraries is refused.
  const again = receipt(setup(m, mapping, ["--yes", "true"], { tripwire: [m.oldContainer, m.legacyDevice, ...targets] }));
  assert.equal(again.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.migration.partitions.map((entry) => [entry.partition, entry.action, entry.events, entry.headEventHash]), [
    ["cross-project", "skipped", expected.events, expected.headEventHash],
    ["alpha", "skipped", expected.events, replanned.migration.partitions[1].headEventHash],
  ]);
  assert.deepEqual(again.library, { path: targets[0], libraryId: expected.workspaceId, created: false });
  assert.deepEqual(await Promise.all(files.map(async (file) => [file, sha256(await readFile(file)), (await stat(file)).mtimeMs])), before);
  for (const [index, target] of targets.entries()) assert.deepEqual(await treeDigest(target), libraries[index], target);
});

test("489-R4, AC4 (fixture): a write aimed at a migrated old path is refused with the library it moved to; an old workspace never migrated keeps its own refusal", async (context) => {
  const { m, crossProject, alpha, mapping, targets } = await migrated(context);
  receipt(setup(m, mapping, ["--yes", "true"]));
  const oldBefore = await treeDigest(m.oldContainer);
  const writes = (root) => [
    ["project-create", "--workspace", root, "--at", at(), "--external-key", "AFTER-MIGRATION", "--name", "After", "--actor", "agent:migrator"],
    ["work-transition", "--workspace", root, "--at", at(), "--id", expected.records.story.id, "--status", "done", "--actor", "agent:migrator"],
    ["work-annotate", "--workspace", root, "--at", at(), "--id", expected.records.story.id, "--summary", "after the migration", "--actor", "agent:migrator"],
  ];
  for (const [partition, target] of [[crossProject, targets[0]], [alpha, targets[1]]]) {
    for (const args of writes(partition.root)) {
      const error = refusal(run(m, args));
      assert.deepEqual([error.reasonCode, error.layout, error.movedTo, error.remedy], ["LEGACY_WORKSPACE_MIGRATED", "legacy", target, `--workspace ${target}`], args[0]);
      assert.match(error.error, /opens read-only/u);
    }
    // It still reads, from the old chain.
    const status = receipt(run(m, ["status", "--workspace", partition.root]));
    assert.deepEqual([status.layout, status.headEventHash], ["legacy", partition.head]);
  }
  assert.deepEqual(await treeDigest(m.oldContainer), oldBefore, "no refused write left a trace");

  // An old workspace this device never migrated is refused as before.
  const { root: elsewhere } = await restoreLegacyFixture(join(m.base, "elsewhere"), "workspace");
  const untouched = refusal(run(m, writes(elsewhere)[0]));
  assert.deepEqual([untouched.reasonCode, untouched.remedy, untouched.movedTo], ["LEGACY_WORKSPACE_READ_ONLY", "library-import-legacy", undefined]);

  // A registry that does not read cannot name the new place; the write is refused all the same.
  await writeFile(join(m.deviceHome, "registry.json"), "not json\n");
  assert.equal(refusal(run(m, writes(crossProject.root)[0])).reasonCode, "LEGACY_WORKSPACE_READ_ONLY");
});

test("489-R1: an old chain that changed after it was planned stops the apply at its partition, and a new plan finishes the migration", async (context) => {
  const { m, crossProject, alpha, mapping, targets } = await migrated(context);
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = m.deviceHome;
  context.after(() => {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
  });
  const planned = await planSetup({ mode: "migrate", projectRoot: m.container, at: at(), home: m.home, deviceHome: m.deviceHome, mapping });
  assert.deepEqual(planned.blockers, []);

  // The old engine writes alpha's chain once more after the plan was read: a project update, in
  // one more segment, signed by the fixture's actor.
  const workspace = await openLegacyWorkspace(alpha.root);
  const last = workspace.events.at(-1);
  const state = await materializeWorkspace(alpha.root);
  const projectRecord = state.projects.find((entry) => !entry.tombstone);
  const appended = createEvent({
    id: legacyWorkspaceEventId(workspace.streamId, last.sequence + 1),
    streamId: workspace.streamId,
    sequence: last.sequence + 1,
    occurredAt: "2026-01-01T00:00:40Z",
    priorHash: last.eventHash,
    payload: { actor: last.payload.actor, operation: "project.updated", record: { ...projectRecord, name: "Renamed", revision: projectRecord.revision + 1, updatedAt: "2026-01-01T00:00:40Z" } },
  }, "tcrn.event.v1");
  await writeFile(join(alpha.root, LEGACY_CONTROL_DIRECTORY, "events", `${String(workspace.segments.length + 1).padStart(6, "0")}.ndjson`), canonicalJson(appended));

  await assert.rejects(applySetup(planned), (error) => {
    assert.equal(error.reasonCode, "LEGACY_IMPORT_MISMATCH");
    assert.deepEqual([error.details.partition, error.details.target], ["alpha", targets[1]]);
    assert.match(error.message, /^partition alpha: /u);
    return true;
  });
  // cross-project, planned first, is in its library; nothing was registered.
  assert.equal((await materializeWorkspace(targets[0])).version, expected.events);
  assert.deepEqual((await readRegistry(m.deviceHome)).entries, []);

  // Planned again, alpha's library holds the chain as it now is: both partitions are skipped and
  // the apply registers them.
  const replanned = await planSetup({ mode: "migrate", projectRoot: m.container, at: at(), home: m.home, deviceHome: m.deviceHome, mapping });
  assert.deepEqual(replanned.migration.partitions.map((entry) => [entry.partition, entry.targetState, entry.action, entry.events]), [
    ["cross-project", "migrated", "skip", expected.events],
    ["alpha", "migrated", "skip", expected.events + 1],
  ]);
  const finished = await applySetup(replanned);
  assert.deepEqual(finished.migration.partitions.map((entry) => entry.action), ["skipped", "skipped"]);
  assert.deepEqual((await readRegistry(m.deviceHome)).entries.map((entry) => entry.migratedFrom), [crossProject.root, alpha.root]);
});

test("489-R1: a library at the target with the partition's workspace id but not its chain stops the plan as diverged", async (context) => {
  const { m, alphaProject, mapping, targets } = await migrated(context);
  await initializeLibrary({ root: targets[1], createdAt: at(), libraryId: ALPHA_WORKSPACE_ID });
  const planned = receipt(setup(m, mapping));
  const alphaPlan = planned.migration.partitions.find((entry) => entry.partition === "alpha");
  assert.deepEqual([alphaPlan.targetState, alphaPlan.action, alphaPlan.workspaceId, alphaPlan.events], ["not-empty", "blocked", ALPHA_WORKSPACE_ID, expected.events]);
  assert.deepEqual(planned.blockers.map((entry) => [entry.step, entry.path, entry.reasonCode]), [["library", targets[1], "LEGACY_IMPORT_MISMATCH"]]);
  assert.match(planned.blockers[0].message, /diverged/u);
  assert.equal(refusal(setup(m, mapping, ["--yes", "true"])).reasonCode, "SETUP_BLOCKED");
  assert.deepEqual(await readdir(alphaProject), [".ether"]);
});

test("489-R2 (registry): an entry with migratedFrom reads beside one without, re-registering the same library keeps it, and an existing registry is backed up before the migration changes it", async (context) => {
  const { m, crossProject, mapping, targets } = await migrated(context, { registry: true });
  const registryFile = join(m.deviceHome, "registry.json");
  const original = await readFile(registryFile);

  const planned = receipt(setup(m, mapping));
  assert.deepEqual(planned.writes.filter((entry) => entry.step === "registry").map((entry) => entry.action), ["update"]);
  assert.equal(planned.backups.length, 1);
  assert.equal(planned.backups[0].path, registryFile);
  const applied = receipt(setup(m, mapping, ["--yes", "true"]));
  assert.deepEqual(applied.backups.map((entry) => entry.path), [registryFile]);
  assert.deepEqual(await readFile(join(applied.backups[0].into, "registry.json")), original, "the registry as it was before the migration");

  const registry = await readRegistry(m.deviceHome);
  // By project path: the container, its alpha project, then the project registered before.
  assert.deepEqual(registry.entries.map((entry) => Object.hasOwn(entry, "migratedFrom")), [true, true, false], "the entry the migration did not write keeps its shape");

  // Registering the same library again keeps migratedFrom; another library does not inherit it.
  await registerLibrary({ projectPath: m.container, libraryPath: targets[0], registeredAt: at(), cloudHosted: true, gitRemote: null }, m.deviceHome);
  assert.equal((await findMigratedEntry(crossProject.root, m.deviceHome))?.cloudHosted, true);
  const other = join(m.base, "other-library");
  await initializeLibrary({ root: other, createdAt: at() });
  await registerLibrary({ projectPath: m.container, libraryPath: other, registeredAt: at(), cloudHosted: false, gitRemote: null }, m.deviceHome);
  assert.equal(await findMigratedEntry(crossProject.root, m.deviceHome), null);

  // An entry whose migratedFrom is not an absolute path is never written, and a registry holding
  // one does not read.
  await assert.rejects(registerLibrary({ projectPath: m.container, libraryPath: targets[0], registeredAt: at(), migratedFrom: "old/workspace" }, m.deviceHome),
    { reasonCode: "LIBRARY_REGISTRY_INVALID" });
  const document = JSON.parse(await readFile(registryFile, "utf8"));
  await writeFile(registryFile, JSON.stringify({ ...document, entries: [{ ...document.entries[0], migratedFrom: "relative/path" }] }));
  await assert.rejects(readRegistry(m.deviceHome), { reasonCode: "LIBRARY_REGISTRY_INVALID" });
});

// INIT-053 U08: the migration's own steps as the wizard runs them, in this process as the device
// the fixture's CLI runs created: the plan and the apply of migrate-legacy.ts, without the wiring of
// a project (setup.ts does that for --project; see the U08 note in the migration wiki).
async function asDevice(m, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = m.deviceHome;
  try {
    return await operation();
  } finally {
    process.env.EINZBERN_HOME = previous;
  }
}

async function migrateOnly(m, mappingFile) {
  const instant = at();
  const input = { mapping: await readMigrationMapping(mappingFile), mappingFile, home: m.home, deviceHome: m.deviceHome, legacyDeviceHome: m.legacyDevice, at: instant };
  const planned = await asDevice(m, () => planMigration(input));
  const recorder = new SetupRecorder(m.deviceHome, instant);
  const applied = planned.blockers.length > 0 ? null : await asDevice(m, () => applyMigration(recorder, { migration: planned.migration, deviceHome: m.deviceHome, at: instant }));
  return { planned, applied, written: recorder.writes };
}

const rowsOf = (writes) => writes.map((entry) => [entry.step, entry.path, entry.action]);

// INIT-053 U08 (approved contract item 1): the mapping's explicit chainRole is the only source of a
// migrated library's chain role. Nine rows, the container's cross-project as the coordination and
// eight projects, each its own old workspace: the plan names every identity, the apply writes them
// after the old chains, signed by the setup actor, the registry records each role, and a migrated
// project chain resolves as a project rather than as an unclassified chain.
test("489-R1, U08 (fixture): a nine-row mapping with explicit roles writes one coordination and eight project identities, and none resolves as unclassified", async (context) => {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  const rows = [{ partition: "cross-project", legacyWorkspace: crossProject.root, projectRoot: m.container, chainRole: "coordination" }];
  for (const name of names) {
    const old = await oldPartition(m, name, `LEGACY-${name.toUpperCase()}-WORKSPACE`);
    rows.push({ partition: name, legacyWorkspace: old.root, projectRoot: await project(m, name), chainRole: "project" });
  }
  const mapping = await writeMapping(m, rows);
  const coordination = { role: "coordination", coordinationLibraryId: crossProject.workspaceId };
  const projectIdentity = { role: "project", coordinationLibraryId: crossProject.workspaceId };
  const expectedIdentities = [["cross-project", coordination], ...names.map((name) => [name, projectIdentity])];

  // The wizard's plan for the container names every identity before anything is written.
  const wizardPlan = receipt(setup(m, mapping));
  assert.deepEqual(wizardPlan.migration.partitions.map((entry) => [entry.partition, entry.action, entry.chainIdentity]), expectedIdentities.map(([name, identity]) => [name, "import", identity]));

  const { planned, applied, written } = await migrateOnly(m, mapping);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(applied.partitions.map((entry) => [entry.partition, entry.action, entry.chainIdentity]), expectedIdentities.map(([name, identity]) => [name, "imported", identity]));
  assert.deepEqual(rowsOf(written), rowsOf(planned.writes), "the apply wrote what the plan listed");
  for (const row of rows) {
    const library = join(row.projectRoot, ".ether");
    const identity = chainIdentity(await materializeWorkspace(library));
    assert.deepEqual([identity.role, identity.coordinationLibraryId], [row.chainRole, crossProject.workspaceId], row.partition);
    // The identity follows the old chain in the library's one stream, signed by the wizard.
    const streams = (await readAllStreams(library)).streams;
    assert.equal(streams.length, 1, row.partition);
    const event = streams[0].events.find((candidate) => candidate.payload.record?.collection === "chain" && candidate.payload.record?.key === "identity");
    assert.equal(event?.payload.actor, "agent:setup", row.partition);
    assert.equal(streams[0].events.indexOf(event), expected.events, `${row.partition}: right after the old chain`);
  }
  const registry = await readRegistry(m.deviceHome);
  assert.deepEqual(registry.entries.map((entry) => entry.chainRole).sort(), ["coordination", ...names.map(() => "project")].sort());

  // Resolution of a migrated project chain once a project of it is registered with its identity.
  const alphaRoot = rows[1].projectRoot;
  const alphaLibrary = join(alphaRoot, ".ether");
  const alphaState = await materializeWorkspace(alphaLibrary);
  const alphaProject = alphaState.projects.find((entry) => !entry.tombstone);
  await asDevice(m, () => registerLibrary({ projectPath: alphaRoot, libraryPath: alphaLibrary, projectId: alphaProject.id, registeredAt: at(), cloudHosted: false, gitRemote: null }, m.deviceHome));
  const resolved = await resolveProjectTarget({ libraryId: alphaState.metadata.workspaceId, projectId: alphaProject.id }, m.deviceHome);
  assert.notEqual(resolved.reason, "chain-role-unclassified");
  assert.equal(resolved.chain.role, "project");
});

// INIT-053 U08: a library migrated before its mapping named roles stays unclassified and resolves as
// such; the roles added later are written once (the plan lists both library writes and the registry
// write), the same mapping then changes nothing, and a library that declares another identity stops
// the plan instead of having its role rewritten.
test("489-R1, U08 (fixture): roles added to a mapping already applied are written once; another declared identity stops the plan", async (context) => {
  const { m, crossProject, alpha, alphaProject, mapping, targets } = await migrated(context);
  const first = receipt(setup(m, mapping, ["--yes", "true"]));
  assert.deepEqual(first.migration.partitions.map((entry) => entry.chainIdentity), [null, null], "without chainRole both stay unclassified");
  for (const target of targets) assert.equal(chainIdentity(await materializeWorkspace(target)), null);
  const alphaProjectId = (await materializeWorkspace(targets[1])).projects.find((entry) => !entry.tombstone).id;
  await asDevice(m, () => registerLibrary({ projectPath: alphaProject, libraryPath: targets[1], projectId: alphaProjectId, registeredAt: at(), cloudHosted: false, gitRemote: "https://example.invalid/team/alpha.git" }, m.deviceHome));
  const reference = { libraryId: alpha.workspaceId, projectId: alphaProjectId };
  assert.equal((await resolveProjectTarget(reference, m.deviceHome)).reason, "chain-role-unclassified", "unclassified until a role is given");

  const roled = await writeMapping(m, [
    { partition: "cross-project", legacyWorkspace: crossProject.root, projectRoot: m.container, chainRole: "coordination" },
    { partition: "alpha", legacyWorkspace: alpha.root, projectRoot: alphaProject, projectName: "Alpha", gitRemote: "https://example.invalid/team/alpha.git", chainRole: "project" },
  ], join(m.base, "roled.json"));
  const { planned, applied, written } = await migrateOnly(m, roled);
  assert.deepEqual(planned.migration.partitions.map((entry) => [entry.action, entry.chainIdentity?.role ?? null]), [["skip", "coordination"], ["skip", "project"]]);
  assert.deepEqual(rowsOf(planned.writes), [
    ["library", targets[0], "update"],
    ["library", targets[1], "update"],
    ["registry", join(m.deviceHome, "registry.json"), "update"],
  ]);
  assert.deepEqual(rowsOf(written), rowsOf(planned.writes), "the apply wrote what the plan listed");
  assert.deepEqual(applied.partitions.map((entry) => entry.chainIdentity), [
    { role: "coordination", coordinationLibraryId: crossProject.workspaceId },
    { role: "project", coordinationLibraryId: crossProject.workspaceId },
  ]);
  assert.deepEqual((await readRegistry(m.deviceHome)).entries.map((entry) => entry.chainRole), ["coordination", "project"]);
  assert.notEqual((await resolveProjectTarget(reference, m.deviceHome)).reason, "chain-role-unclassified");
  assert.deepEqual((await migrateOnly(m, roled)).planned.writes, [], "the same mapping again changes nothing");

  // alpha now declares itself a coordination chain: the plan stops on it, naming the library.
  await asDevice(m, () => declareChainIdentity(targets[1], { role: "coordination", coordinationLibraryId: alpha.workspaceId }, { occurredAt: at(), actorId: "agent:setup" }));
  const refused = await migrateOnly(m, roled);
  assert.deepEqual(refused.planned.blockers.map((entry) => [entry.path, entry.reasonCode]), [[targets[1], "SETUP_LIBRARY_CONFLICT"]]);
  assert.deepEqual(refused.planned.migration.partitions.map((entry) => entry.action), ["skip", "blocked"]);
  assert.equal(refused.applied, null);
});

// TCRN-CROSS-INIT-053 R46 (I07; PC-2): with roles, --project names a project partition. The nine-row
// mapping in its real shape (the container root is the coordination partition; eight project
// partitions in directories of their own, three of them under a nested folder) goes through setup
// --mode migrate both ways. The coordination root is refused at plan time with one blocker that names
// a project partition's root, the plan still lists all nine partitions and plans no project language
// or wiring, and its apply imports nothing; a plan changed by hand to drop the blocker is refused
// before any import. A project partition's root imports all nine, writes each identity, wires that
// project, and writes no project language into the coordination chain.
test("R46 I07 (fixture): --project at the coordination partition's root is refused at plan time and imports nothing; at a project partition's root all nine import", async (context) => {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  const nested = new Set(["delta", "epsilon", "zeta"]);
  const rows = [{ partition: "cross-project", legacyWorkspace: crossProject.root, projectRoot: m.container, chainRole: "coordination" }];
  for (const name of names) {
    const old = await oldPartition(m, name, `LEGACY-${name.toUpperCase()}-WORKSPACE`);
    const projectRoot = nested.has(name) ? join(m.container, "Platform Folder", name) : join(m.container, name);
    await mkdir(projectRoot, { recursive: true });
    rows.push({ partition: name, legacyWorkspace: old.root, projectRoot, chainRole: "project" });
  }
  // TCRN-CROSS-STORY-517: the --project partition's old chain holds a live project, so its row names it.
  rows[1] = { ...rows[1], projectId: FIXTURE_PROJECT_ID };
  const mapping = await writeMapping(m, rows);
  const targets = rows.map((row) => join(row.projectRoot, ".ether"));
  const migrate = (project, extra = []) => run(m, ["setup", "--mode", "migrate", "--project", project, "--mapping", mapping, "--at", at(), ...extra]);
  const before = { container: await treeDigest(m.container), device: await treeDigest(m.deviceHome), home: await treeDigest(m.home) };

  // The coordination partition's root: one blocker, the whole migration shown, no language or wiring.
  const refusedPlan = receipt(migrate(m.container));
  assert.equal(refusedPlan.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(refusedPlan.blockers.map((blocker) => [blocker.step, blocker.path, blocker.reasonCode]), [["library", m.container, "SETUP_ANSWER_INVALID"]]);
  assert.equal(refusedPlan.blockers[0].message,
    `--project names the coordination partition cross-project: a coordination chain takes no project language or project wiring. Plan again with --project set to the root of a partition whose chainRole is "project" (for example ${rows[1].projectRoot}) and the same --mapping.`);
  assert.deepEqual(refusedPlan.migration.partitions.map((entry) => [entry.partition, entry.action, entry.chainIdentity?.role ?? null]), rows.map((row) => [row.partition, "import", row.chainRole]));
  assert.equal(refusedPlan.writes.some((entry) => entry.path === targets[0] && entry.action === "update"), false, "no language row for the coordination chain");
  assert.deepEqual(refusedPlan.writes.filter((entry) => ["skill-copies", "launchers", "host-hooks", "managed-sections"].includes(entry.step)), [], "no project wiring is planned");
  assert.deepEqual(refusedPlan.pendingSections, []);
  assert.equal(Object.hasOwn(refusedPlan, "coordination"), false, "migrate names no coordination binding (R46 I08)");
  const blocked = refusal(migrate(m.container, ["--yes", "true"]));
  assert.equal(blocked.reasonCode, "SETUP_BLOCKED");
  for (const target of targets) await assert.rejects(lstat(target), { code: "ENOENT" }, `${target}: nothing is imported`);
  assert.deepEqual({ container: await treeDigest(m.container), device: await treeDigest(m.deviceHome), home: await treeDigest(m.home) }, before, "the refused run wrote nothing");

  // The same plan with its blocker dropped by hand: the apply refuses before any import.
  const handEdited = await asDevice(m, async () => ({ ...await planSetup({ mode: "migrate", projectRoot: m.container, mapping, at: at(), home: m.home, deviceHome: m.deviceHome }), blockers: [] }));
  await assert.rejects(asDevice(m, () => applySetup(handEdited)), (error) => error.reasonCode === "SETUP_ANSWER_INVALID" && error.details.field === "project" && error.details.partition === "cross-project");
  for (const target of targets) await assert.rejects(lstat(target), { code: "ENOENT" }, `${target}: still nothing imported`);
  assert.deepEqual({ container: await treeDigest(m.container), device: await treeDigest(m.deviceHome), home: await treeDigest(m.home) }, before, "the refused apply wrote nothing");

  // A project partition's root: all nine import with their identities, and the project is wired.
  const projectRoot = rows[1].projectRoot;
  const plannedForProject = receipt(migrate(projectRoot));
  assert.deepEqual(plannedForProject.blockers, []);
  // TCRN-CROSS-INIT-053 R47 (R47-04): the old coordination chain declares no language, so its own row is
  // the catalog default; it declares no orchestration limit, so none is listed. R48 (J-2): that row is
  // listed with action default and written nowhere, so the coordination library records no language.
  const ownLanguage = { key: "artifact.language", value: "en", source: "legacy-default" };
  assert.deepEqual(plannedForProject.migration.partitions[0].coordinationSettings, [{ ...ownLanguage, action: "default" }]);
  assert.deepEqual(refusedPlan.migration.partitions[0].coordinationSettings, [{ ...ownLanguage, action: "default" }], "the refused plan shows the same row");
  for (const entry of plannedForProject.migration.partitions.slice(1)) assert.equal(Object.hasOwn(entry, "coordinationSettings"), false, entry.partition);
  const applied = receipt(migrate(projectRoot, ["--yes", "true"]));
  assert.deepEqual([applied.reasonCode, applied.mode], ["SETUP_APPLIED", "migrate"]);
  assert.deepEqual(applied.migration.partitions.map((entry) => [entry.partition, entry.action]), rows.map((row) => [row.partition, "imported"]));
  assert.deepEqual(applied.library, { path: targets[1], libraryId: deriveStableId("workspace", "LEGACY-ALPHA-WORKSPACE"), created: true });
  for (const [index, row] of rows.entries()) {
    const identity = chainIdentity(await materializeWorkspace(targets[index]));
    assert.deepEqual([identity.role, identity.coordinationLibraryId], [row.chainRole, crossProject.workspaceId], row.partition);
  }
  // The coordination chain holds the old chain and its identity. R48 (J-2): no language is written into
  // it (the old chain declared none), and no project language either (none names a project).
  const coordinationEvents = (await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events);
  assert.equal(coordinationEvents.length, expected.events + 1, "the old chain, then its identity; no language");
  assert.equal(coordinationEvents[expected.events].payload.record?.key, "identity");
  assert.equal(coordinationEvents.slice(expected.events).some((event) => event.payload.record?.key === "artifact.language"), false, "no artifact.language in the coordination chain");
  assert.equal(coordinationEvents.slice(expected.events).some((event) => event.payload.record?.projectId !== undefined), false, "no project language in the coordination chain");
  // The coordination library reads the catalog default and records no language, so its write language
  // policy stays off: a card is written there without a language bundle.
  const coordinationLanguage = receipt(run(m, ["settings-catalog", "--workspace", targets[0]])).settings.find((entry) => entry.key === "artifact.language");
  assert.deepEqual([coordinationLanguage.currentValue, coordinationLanguage.source?.kind ?? null], ["en", "default"], "the catalog default, not a library record");
  receipt(run(m, ["knowledge-init", "--workspace", targets[0], "--acknowledge-disposable", "true"]));
  const card = receipt(run(m, ["knowledge-capture", "--workspace", targets[0], "--at", at(), "--subject", "Coordination card after the migration",
    "--summary", "A card the coordination library takes without a language bundle", "--snippet", "no language bundle needed", "--tags", "lesson",
    "--accountable-owner-id", deriveStableId("owner", "MIGRATE-APPLY-OWNER"), "--body", "Written without a language bundle.", "--allow-trailing", "true"]));
  assert.equal(typeof card.reasonCode, "string", JSON.stringify(card));
  const coordinationAfterCard = (await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events).length;
  assert.equal((await materializeWorkspace(targets[1])).settings.some((setting) => setting.key === "artifact.language" && setting.value === applied.answers.language), true, "the project chain records the language");
  for (const file of ["AGENTS.md", "CLAUDE.md"]) assert.ok((await lstat(join(projectRoot, file))).isFile(), `${file} is wired into the project`);
  await assert.rejects(lstat(join(m.container, "AGENTS.md")), { code: "ENOENT" }, "the coordination root gets no project wiring");

  // The same mapping again: the row is still the default, and nothing is written into any library.
  const replanned = receipt(migrate(projectRoot));
  assert.deepEqual(replanned.migration.partitions[0].coordinationSettings, [{ ...ownLanguage, action: "default" }]);
  assert.deepEqual(replanned.writes.filter((entry) => entry.step === "library"), []);
  const again = receipt(migrate(projectRoot, ["--yes", "true"]));
  assert.deepEqual(again.written.filter((entry) => entry.step === "library"), []);
  assert.equal((await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events).length, coordinationAfterCard, "the coordination chain is as it was");

  // The control: once the coordination library records the same en at its library level, its write
  // language policy is on, and the same kind of write without a language bundle is refused. Writing the
  // default as a record (the apply before R48) did this to every migrated coordination library.
  await asDevice(m, () => setWorkspaceSetting(targets[0], { key: "artifact.language", value: "en", occurredAt: at(), actorId: "agent:setup" }));
  const refusedCard = refusal(run(m, ["knowledge-capture", "--workspace", targets[0], "--at", at(), "--subject", "Coordination card once a language is recorded",
    "--summary", "The same write once the library records its language", "--snippet", "language bundle needed now", "--tags", "lesson",
    "--accountable-owner-id", deriveStableId("owner", "MIGRATE-APPLY-OWNER"), "--body", "Refused without a language bundle.", "--allow-trailing", "true"]));
  assert.equal(refusedCard.reasonCode, "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE");
});

// TCRN-CROSS-INIT-053 R47 (R47-04; Owner 2026-10-09 round 7, c1-B; audit P6): the coordination chain keeps
// its own artifact language and orchestration limit through the migration. In the nine-row mapping the
// old coordination chain declares fr and execution.maxConcurrentSubagents 3 at its library level: the
// plan lists both rows for the coordination partition alone, the import carries both (the wizard writes
// neither), the coordination library reads them at its library level through settings-catalog, and no
// project library reads either. The coordination root as --project is still refused at plan time, and
// the same mapping applied again writes nothing.
test("R47-04 (fixture): the coordination partition's own language and orchestration limit are listed in its plan, carried by the import, and never reach a project chain", async (context) => {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  await appendLegacySettings(crossProject.root, [["artifact.language", "fr"], ["execution.maxConcurrentSubagents", "3"]]);
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  const rows = [{ partition: "cross-project", legacyWorkspace: crossProject.root, projectRoot: m.container, chainRole: "coordination" }];
  for (const name of names) {
    const old = await oldPartition(m, name, `LEGACY-${name.toUpperCase()}-WORKSPACE`);
    rows.push({ partition: name, legacyWorkspace: old.root, projectRoot: await project(m, name), chainRole: "project" });
  }
  // TCRN-CROSS-STORY-517: the --project partition's old chain holds a live project, so its row names it.
  rows[1] = { ...rows[1], projectId: FIXTURE_PROJECT_ID };
  const mapping = await writeMapping(m, rows);
  const targets = rows.map((row) => join(row.projectRoot, ".ether"));
  const migrate = (projectRoot, extra = []) => run(m, ["setup", "--mode", "migrate", "--project", projectRoot, "--mapping", mapping, "--at", at(), ...extra]);
  const carried = [
    { key: "artifact.language", value: "fr", source: "legacy-declared", action: "carried" },
    { key: "execution.maxConcurrentSubagents", value: "3", source: "legacy-declared", action: "carried" },
  ];

  // The coordination root is still refused at plan time; the plan shows its rows all the same.
  const refusedPlan = receipt(migrate(m.container));
  assert.deepEqual(refusedPlan.blockers.map((blocker) => [blocker.path, blocker.reasonCode]), [[m.container, "SETUP_ANSWER_INVALID"]]);
  assert.deepEqual(refusedPlan.migration.partitions[0].coordinationSettings, carried);

  const projectRoot = rows[1].projectRoot;
  const planned = receipt(migrate(projectRoot));
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.migration.partitions[0].coordinationSettings, carried);
  assert.equal(planned.migration.partitions[0].language, "fr");
  for (const entry of planned.migration.partitions.slice(1)) assert.equal(Object.hasOwn(entry, "coordinationSettings"), false, entry.partition);
  assert.equal(planned.resolved.language, "en", "the project's own language is not the coordination chain's");

  const applied = receipt(migrate(projectRoot, ["--yes", "true"]));
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(applied.recallSmoke, { status: "no-card" });
  const catalog = (library, extra = []) => receipt(run(m, ["settings-catalog", "--workspace", library, ...extra])).settings;
  const runtime = (settings) => Object.fromEntries(settings.filter((entry) => ["artifact.language", "execution.maxConcurrentSubagents"].includes(entry.key))
    .map((entry) => [entry.key, [entry.currentValue, entry.scope, entry.source?.kind ?? null]]));
  assert.deepEqual(runtime(catalog(targets[0])), { "artifact.language": ["fr", "library", "library"], "execution.maxConcurrentSubagents": ["3", "library", "library"] },
    "the coordination library reads its own values at the library level");
  const coordinationEvents = (await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events);
  assert.deepEqual(coordinationEvents.slice(expected.events + 2).map((event) => event.payload.record?.key), ["identity"], "the import carried both; the wizard wrote neither");
  const projectId = (await readRegistry(m.deviceHome)).entries.find((entry) => entry.projectPath === projectRoot).projectId;
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue;
    const reads = [runtime(catalog(targets[index])), ...(index === 1 ? [runtime(catalog(targets[index], ["--project-id", projectId]))] : [])];
    for (const read of reads) {
      assert.notEqual(read["artifact.language"][0], "fr", row.partition);
      assert.notEqual(read["execution.maxConcurrentSubagents"][0], "3", row.partition);
    }
  }

  const again = receipt(migrate(projectRoot, ["--yes", "true"]));
  assert.deepEqual(again.migration.partitions.map((entry) => entry.action), rows.map(() => "skipped"));
  assert.deepEqual(again.written.filter((entry) => entry.step === "library"), [], "the same mapping writes nothing into a library");
  assert.equal((await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events).length, coordinationEvents.length);

  // TCRN-CROSS-INIT-053 R48 (J-2): a key the old chain declares and the coordination library no longer
  // holds (removed after the import) is a write row again; the apply writes the old chain's value at the
  // library level, signed agent:setup, and the next plan reads it carried.
  for (const key of ["artifact.language", "execution.maxConcurrentSubagents"]) {
    await asDevice(m, () => removeWorkspaceSetting(targets[0], { key, occurredAt: at(), actorId: "agent:setup" }));
  }
  const removed = (await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events).length;
  const rewrite = receipt(migrate(projectRoot));
  assert.deepEqual(rewrite.migration.partitions[0].coordinationSettings, carried.map((row) => ({ ...row, action: "write" })));
  const rewritten = receipt(migrate(projectRoot, ["--yes", "true"]));
  assert.deepEqual(rewritten.written.filter((entry) => entry.step === "library").map((entry) => [entry.path, entry.action]), [[targets[0], "update"]], "one library entry: the coordination library, updated");
  const written = (await readAllStreams(targets[0])).streams.flatMap((stream) => stream.events).slice(removed).map((event) => event.payload);
  assert.deepEqual(written.map((payload) => [payload.operation, payload.record?.key, payload.record?.value, Object.hasOwn(payload.record ?? {}, "projectId"), payload.actor]),
    [["settings.updated", "artifact.language", "fr", false, "agent:setup"], ["settings.updated", "execution.maxConcurrentSubagents", "3", false, "agent:setup"]]);
  assert.deepEqual(receipt(migrate(projectRoot)).migration.partitions[0].coordinationSettings, carried);
});

// TCRN-CROSS-INIT-053 R47 (R47-05; audit P1): after the import, before the cleanup and the wiring, the
// wizard asks the prompt hook's recall for the newest valid card of the project's own library by its
// subject. A library imported with two old cards answers a hit naming the newest one.
test("R47-05 (fixture): the recall smoke finds the newest valid card of the project's own library, and the apply goes on", async (context) => {
  const m = await machine(context);
  const old = await oldCardPartition(m, "alpha");
  const alphaProject = await project(m, "alpha");
  const mapping = await writeMapping(m, [{ partition: "alpha", legacyWorkspace: old.root, projectRoot: alphaProject }]);
  const applied = receipt(run(m, ["setup", "--mode", "migrate", "--project", alphaProject, "--mapping", mapping, "--at", at(), "--yes", "true"]));
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(applied.recallSmoke, { status: "hit", cardId: old.newest.id, query: old.newest.subject });
  assert.ok(applied.written.some((entry) => entry.step === "managed-sections"), "the project is wired after the smoke");
});

// TCRN-CROSS-INIT-053 R47 (R47-05): a miss stops the apply after the import and before the cleanup and the
// wiring, with SETUP_RECALL_SMOKE_MISSED. Here the old chain's retrieval.tau is set where recall can have no
// strong hit. Nothing in the home (the old installation, the host files, the skill copies) is touched,
// the project gets no managed section and the device no launcher; once the library's tau is back, the
// same mapping applied again skips the migrated partition and goes on from the smoke.
test("R47-05 (fixture): a forced miss stops before the cleanup and the wiring, and the same mapping goes on once recall finds the card", async (context) => {
  const m = await machine(context);
  const old = await oldCardPartition(m, "alpha", [["retrieval.tau", "1000000"]]);
  const alphaProject = await project(m, "alpha");
  const mapping = await writeMapping(m, [{ partition: "alpha", legacyWorkspace: old.root, projectRoot: alphaProject }]);
  const library = join(alphaProject, ".ether");
  const homeBefore = await treeDigest(m.home);
  const apply = () => run(m, ["setup", "--mode", "migrate", "--project", alphaProject, "--mapping", mapping, "--at", at(), "--yes", "true"]);

  const missed = refusal(apply());
  assert.deepEqual([missed.reasonCode, missed.target], ["SETUP_RECALL_SMOKE_MISSED", library]);
  assert.ok(missed.error.includes(old.newest.id), "the refusal names the card it asked for");
  // TCRN-CROSS-INIT-053 R48 (PA2-3): the shipped entry passes the card and the query on as fields.
  assert.deepEqual([missed.cardId, missed.query], [old.newest.id, old.newest.subject], "the refusal carries cardId and query");
  assert.ok((await readRegistry(m.deviceHome)).entries.some((entry) => entry.libraryPath === library), "the import and the registry entry stay");
  assert.deepEqual(await treeDigest(m.home), homeBefore, "no cleanup and no host wiring: the home is as it was");
  for (const file of ["AGENTS.md", "CLAUDE.md"]) await assert.rejects(lstat(join(alphaProject, file)), { code: "ENOENT" }, `${file}: not wired`);
  for (const path of [join(m.deviceHome, "engine", "einzbern.mjs"), join(m.deviceHome, "engine", "hook.mjs"), join(m.deviceHome, "skills.json"), join(m.deviceHome, "backups")]) {
    await assert.rejects(lstat(path), { code: "ENOENT" }, `${path}: nothing of the cleanup or the wiring`);
  }

  // The library's tau goes back to its default; the same mapping goes on from the smoke.
  await asDevice(m, () => removeWorkspaceSetting(library, { key: "retrieval.tau", occurredAt: at(), actorId: "agent:setup" }));
  const resumed = receipt(apply());
  assert.deepEqual(resumed.migration.partitions.map((entry) => entry.action), ["skipped"]);
  assert.deepEqual(resumed.recallSmoke, { status: "hit", cardId: old.newest.id, query: old.newest.subject });
  for (const file of ["AGENTS.md", "CLAUDE.md"]) assert.ok((await lstat(join(alphaProject, file))).isFile(), `${file} is wired once the smoke hits`);
  assert.ok((await lstat(join(m.deviceHome, "engine", "hook.mjs"))).isFile());
});

// TCRN-CROSS-STORY-517 GWT1, GWT3 (R50 D-517-1; fixes STORY-489): a project partition whose old chain holds
// a live project. Without projectId the wizard's plan stops on that partition, lists the project as the
// one candidate and imports nothing; with it the migration reuses that project: no configuration project
// of setup's own is created, and the registry entry, the identity's primaryProjectId, the language and
// the managed-section records all name the old chain's project. The same mapping again writes nothing.
test("STORY-517 GWT1, GWT3 (fixture): a project partition with an old project reuses the project its mapping row names and creates none", async (context) => {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  const alpha = await oldPartition(m, "alpha", ALPHA_EXTERNAL_KEY);
  const alphaProject = await project(m, "alpha");
  const rows = [
    { partition: "cross-project", legacyWorkspace: crossProject.root, projectRoot: m.container, chainRole: "coordination" },
    { partition: "alpha", legacyWorkspace: alpha.root, projectRoot: alphaProject, chainRole: "project" },
  ];
  const targets = rows.map((row) => join(row.projectRoot, ".ether"));
  const migrate = (mapping, extra = []) => run(m, ["setup", "--mode", "migrate", "--project", alphaProject, "--mapping", mapping, "--language", "zh-CN", "--at", at(), ...extra]);

  // No projectId: the plan stops on alpha and names its old project; the apply imports nothing.
  const unbound = await writeMapping(m, rows, join(m.base, "unbound.json"));
  const before = { container: await treeDigest(m.container), device: await treeDigest(m.deviceHome), home: await treeDigest(m.home) };
  const asked = receipt(migrate(unbound));
  assert.deepEqual(asked.blockers.map((blocker) => [blocker.step, blocker.path, blocker.reasonCode]), [["library", targets[1], "SETUP_ANSWER_INVALID"]]);
  assert.match(asked.blockers[0].message, /^partition alpha is a project chain whose old chain holds live projects: name the one its configuration \(language, managed sections, registry entry\) belongs to as projectId in its --mapping row, one of project:3443417fe20a3dd2b9f42d05 "Legacy fixture" \(7 work items\)\./u);
  assert.deepEqual(asked.migration.partitions[1].projectCandidates.map((entry) => [entry.id, entry.name, entry.work]), [[FIXTURE_PROJECT_ID, "Legacy fixture", 7]]);
  assert.equal(refusal(migrate(unbound, ["--yes", "true"])).reasonCode, "SETUP_BLOCKED");
  for (const target of targets) await assert.rejects(lstat(target), { code: "ENOENT" }, `${target}: nothing is imported`);
  assert.deepEqual({ container: await treeDigest(m.container), device: await treeDigest(m.deviceHome), home: await treeDigest(m.home) }, before, "the refused run wrote nothing");

  // projectId names it: the migration reuses it.
  const bound = await writeMapping(m, [rows[0], { ...rows[1], projectId: FIXTURE_PROJECT_ID }], join(m.base, "bound.json"));
  const planned = receipt(migrate(bound));
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.migration.partitions[1].chainIdentity, { role: "project", coordinationLibraryId: crossProject.workspaceId, primaryProjectId: FIXTURE_PROJECT_ID });
  assert.deepEqual(planned.migration.registry.map((entry) => entry.projectId ?? null), [null, FIXTURE_PROJECT_ID]);
  const applied = receipt(migrate(bound, ["--yes", "true"]));
  assert.deepEqual([applied.reasonCode, applied.answers.language], ["SETUP_APPLIED", "zh-CN"]);
  const state = await materializeWorkspace(targets[1]);
  assert.deepEqual(state.projects.filter((entry) => !entry.tombstone).map((entry) => entry.id), [FIXTURE_PROJECT_ID], "no project beside the old chain's own");
  assert.equal(state.projects.some((entry) => entry.externalKey.startsWith("SETUP-CONFIG-")), false, "no configuration project of setup's own");
  assert.deepEqual(chainIdentity(state), { role: "project", coordinationLibraryId: crossProject.workspaceId, primaryProjectId: FIXTURE_PROJECT_ID });
  const registry = await readRegistry(m.deviceHome);
  assert.deepEqual(registry.entries.map((entry) => [entry.projectPath, entry.chainRole, entry.projectId ?? null]).sort(), [
    [alphaProject, "project", FIXTURE_PROJECT_ID],
    [m.container, "coordination", null],
  ].sort());
  assert.deepEqual(applied.migration.registry.find((entry) => entry.projectPath === alphaProject).projectId, FIXTURE_PROJECT_ID);
  const language = receipt(run(m, ["settings-catalog", "--workspace", targets[1], "--project-id", FIXTURE_PROJECT_ID])).settings.find((entry) => entry.key === "artifact.language");
  assert.deepEqual([language.currentValue, language.source.kind, language.source.projectId], ["zh-CN", "project", FIXTURE_PROJECT_ID]);
  assert.deepEqual(state.settings.filter((entry) => entry.key === "artifact.language").map((entry) => entry.projectId ?? null), [FIXTURE_PROJECT_ID]);
  const sections = state.configRecords.filter((entry) => entry.collection === "managed-section");
  assert.deepEqual(sections.filter((entry) => entry.key.startsWith("AGENTS.md#")).map((entry) => entry.key).sort(), ["AGENTS.md#navigation", "AGENTS.md#variables-custom", "AGENTS.md#variables-system"]);
  assert.deepEqual([...new Set(sections.map((entry) => entry.projectId))], [FIXTURE_PROJECT_ID], "every managed-section record names the old chain's project");
  // Every write after the old chain is signed by the setup actor.
  const written = (await readAllStreams(targets[1])).streams.flatMap((stream) => stream.events).slice(expected.events);
  assert.ok(written.length > 0);
  assert.deepEqual([...new Set(written.map((event) => event.payload.actor))], ["agent:setup"]);

  // The same mapping again: nothing is written into a library or the registry.
  const again = receipt(migrate(bound, ["--yes", "true"]));
  assert.deepEqual(again.written.filter((entry) => entry.step === "library" || entry.step === "registry"), []);
});
