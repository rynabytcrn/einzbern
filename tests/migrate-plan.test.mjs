// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-489 R1, AC1 (dry-run form) / STORY-480 R6 (TCRN-CROSS-SUB-364; MIN-235 D17,
// MIN-238 D4): setup --mode migrate plans the migration of an installation from before the rename.
// Old partitions restored from the frozen old-layout fixture into a temporary container, with a
// mapping file, plan one library per partition with the fixture's events and head, the open work
// and every gate that is not satisfied, item by item, and nothing is written under the write
// tripwire. A target that is not a new or empty directory, an old workspace that does not read and
// a project registered elsewhere stop the apply; with no mapping to follow and none to infer, the
// plan names the question. Every home, device directory, container and project here is temporary.
// TCRN-CROSS-SUB-421 R18: a partition whose old knowledge store is refused still lists its chain,
// and the refusal is a blocker of its own on the file of the store it names.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  LEGACY_CONTAINER_DIRECTORY,
  LEGACY_CONTROL_DIRECTORY,
  LEGACY_DEVICE_DIRECTORY,
  DIRECTORY,
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTINGS_VERSION,
  applyMachineSettingSet,
  cachePath,
  createKnowledgeUnit,
  importLegacyWorkspace,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  materializeWorkspace,
  openLegacyWorkspace,
  registerLibrary,
  replayLegacyWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { MIGRATION_MAPPING_SCHEMA_VERSION, applyMigration, planMigration, readMigrationMapping } from "../dist/build/packages/core/src/migrate-legacy.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { installTripwire } from "./helpers/fs-write-tripwire.mjs";
import { applySetup, planSetup } from "../dist/build/packages/core/src/setup.js";
import { legacyWorkspaceEventId } from "../dist/build/packages/core/src/workspace.js";
import { canonicalJson, createEvent } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED as expected, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-migrate-plan-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

// The fixture's one live gate: pending, bound to its Story.
const FIXTURE_GATE = Object.freeze({
  id: "gate:f48272b1736ccd8d29165c37",
  workId: expected.records.story.id,
  status: "pending",
  title: "Decision gate",
  outcomeClass: "role_decision",
});

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 29, 6, 0, second)).toISOString().replace(".000Z", "Z");
};

/** A temporary device before the rename: a home with the old device directory (unless told not to), a device directory and a container. */
async function machine(context, { legacyDevice = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-migrate-plan-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const container = join(base, "container");
  await mkdir(legacyDevice ? join(home, LEGACY_DEVICE_DIRECTORY) : home, { recursive: true });
  await mkdir(container);
  return { base, home, deviceHome: join(base, "device"), container, legacyDevice: join(home, LEGACY_DEVICE_DIRECTORY) };
}

/** An old partition in the container's old layout, restored from the frozen fixture; answers the old workspace. */
async function oldPartition(m, name) {
  return (await restoreLegacyFixture(join(m.container, LEGACY_CONTAINER_DIRECTORY, name), "workspace")).root;
}

async function project(m, name) {
  const root = join(m.container, name);
  await mkdir(root);
  return root;
}

/** Bind an old workspace's knowledge store to the root the workspace was restored at, as its engine bound a store to its root. */
async function bindWhereRestored(root) {
  const metadataPath = join(root, LEGACY_CONTROL_DIRECTORY, "workspace.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.roots = metadata.roots.map((entry) => (entry.kind === "workspace"
    ? { ...entry, canonicalPath: root, path: root, portableIdentity: root.toLowerCase() }
    : entry));
  await writeFile(metadataPath, canonicalJson(metadata));
}

/** Two old cards, laid out from engine-written records; the TMS variant has exactly its two JSON byte defects. */
async function oldKnowledgePartition(m, name, broken = false) {
  const root = await oldPartition(m, name);
  await bindWhereRestored(root);
  const donor = join(m.base, `${name}-donor`);
  await importLegacyWorkspace(root, donor, { createdAt: "2026-09-25T06:00:00Z" });
  await initializeKnowledgeStore(donor, { disposableAcknowledged: true });
  const bodies = new Map();
  for (const [index, externalKey] of ["CARD-FALSIFIABLE-NOT-CORRECT", "CARD-COUNT-ONLY-GATE"].entries()) {
    const body = `${externalKey}: ${name} source text`;
    const created = await createKnowledgeUnit(donor, {
      occurredAt: `2026-09-25T06:00:0${index + 1}Z`, externalKey, scope: "workspace", projectId: null, roleScopes: [],
      category: "workflow", kind: "fact", tags: ["migration"], subject: `${externalKey} ${name}`,
      summary: `${externalKey} summary`, snippet: `${externalKey} snippet`, accountableOwnerId: "owner:sub-421", sourceReferences: [], sourceDigest: null,
      linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
      freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only", body,
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
  const damaged = ["store.json", `metadata/${listed.records[0].id}.json`];
  if (broken) for (const file of damaged) await writeFile(join(knowledge, file), JSON.stringify(JSON.parse(await readFile(join(knowledge, file), "utf8")), null, 4));
  return { root, knowledge, damaged };
}

async function writeMapping(m, partitions, file = join(m.base, "mapping.json")) {
  await writeFile(file, `${JSON.stringify({ schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION, partitions }, null, 2)}\n`);
  return file;
}

const plan = (m, extra = {}) => planSetup({ mode: "migrate", projectRoot: m.container, at: at(), home: m.home, deviceHome: m.deviceHome, ...extra });

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

/** The open work of an old chain as the plan counts it: neither done nor cancelled, by status. */
function openWork(state) {
  const byStatus = { planned: 0, ready: 0, active: 0, blocked: 0, "pending-owner-acceptance": 0 };
  let total = 0;
  for (const record of state.work) {
    if (record.tombstone || record.status === "done" || record.status === "cancelled") continue;
    byStatus[record.status] += 1;
    total += 1;
  }
  return { total, byStatus };
}

/** Append events to an old chain as its engine wrote them, in one more segment; answers the new head. */
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

test("489-R1, AC1 (fixture): a two-partition mapping plans two libraries with the fixture's events and head, the open work and the pending gate, and writes nothing under the tripwire", async (context) => {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  const alpha = await oldPartition(m, "alpha");
  const alphaProject = await project(m, "alpha");
  const settingsFrom = join(m.legacyDevice, "machine-settings.json");
  await writeFile(settingsFrom, `${JSON.stringify({
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    schemaVersion: MACHINE_SETTINGS_VERSION,
    updatedAt: "2026-09-24T03:54:18.104Z",
    values: { "portal.defaultTheme": "dark" },
  })}\n`);
  const partitions = [
    { partition: "cross-project", legacyWorkspace: crossProject, projectRoot: m.container },
    { partition: "alpha", legacyWorkspace: alpha, projectRoot: alphaProject, projectName: "Alpha", gitRemote: "https://example.invalid/team/alpha.git" },
  ];
  const mapping = await writeMapping(m, partitions);

  // setup --mode migrate without --yes, in a process whose every write under the container, the
  // home and the device directory is refused.
  const before = await treeDigest(m.base);
  const run = spawnSync(process.execPath, ["--import", tripwirePath, cliPath, "setup", "--mode", "migrate", "--project", m.container, "--mapping", mapping, "--at", at()], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: m.home,
      USERPROFILE: m.home,
      EINZBERN_HOME: m.deviceHome,
      EINZBERN_TRIPWIRE_ROOT: [m.container, m.home, m.deviceHome].join(delimiter),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await treeDigest(m.base), before, "the plan wrote nothing");
  const planned = JSON.parse(run.stdout);
  assert.deepEqual([planned.reasonCode, planned.mode], ["SETUP_PLAN_READY", "migrate"]);

  const { migration } = planned;
  assert.equal(migration.mappingFile, mapping);
  assert.deepEqual(migration.mapping, { schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION, partitions }, "the mapping in the file's shape");
  const targets = [join(m.container, ".ether"), join(alphaProject, ".ether")];
  assert.deepEqual(migration.partitions.map((entry) => [entry.partition, entry.legacyWorkspace, entry.projectRoot, entry.target, entry.targetState, entry.action]), [
    ["cross-project", crossProject, m.container, targets[0], "absent", "import"],
    ["alpha", alpha, alphaProject, targets[1], "absent", "import"],
  ]);
  // The dry-run form of 489-AC1: each library would start from the old chain's events and head.
  const state = replayLegacyWorkspace(await openLegacyWorkspace(crossProject));
  const open = openWork(state);
  assert.ok(open.total > 0);
  for (const entry of migration.partitions) {
    assert.deepEqual([entry.workspaceId, entry.events, entry.headEventHash], [expected.workspaceId, expected.events, expected.headEventHash], entry.partition);
    assert.deepEqual(entry.openItems, open, entry.partition);
    assert.deepEqual(entry.unsatisfiedGates, [FIXTURE_GATE], `${entry.partition}: the deleted gate is not listed, the pending one is`);
    assert.equal(entry.language, null);
  }
  assert.deepEqual(migration.partitions.map((entry) => [entry.projectName, entry.gitRemote]), [["container", null], ["Alpha", "example.invalid/team/alpha"]]);
  assert.deepEqual(migration.registry, [
    { partition: "cross-project", projectPath: m.container, libraryPath: targets[0], libraryId: expected.workspaceId, cloudHosted: false, gitRemote: null, migratedFrom: crossProject },
    { partition: "alpha", projectPath: alphaProject, libraryPath: targets[1], libraryId: expected.workspaceId, cloudHosted: false, gitRemote: "example.invalid/team/alpha", migratedFrom: alpha },
  ]);
  assert.deepEqual(migration.deviceSettings, {
    from: settingsFrom,
    to: join(m.deviceHome, "machine-settings.json"),
    keys: [{ key: "portal.defaultTheme", value: "dark", current: null, action: "set" }],
  });
  assert.deepEqual(migration.hostCleanup, []);

  // What the apply writes, in its order, and the one thing that stops it here: no engine is installed.
  // With nothing old on this device the cleanup has nothing to take off, and without an engine the
  // wiring (TCRN-CROSS-SUB-366) plans no skill copy or launcher: it writes the user's hooks and the
  // container's managed sections, and the language and the navigation choice go into files already
  // listed.
  assert.deepEqual(planned.writes.map((entry) => [entry.step, entry.path, entry.action]), [
    ["device", join(m.deviceHome, "device.json"), "create"],
    ["library", targets[0], "create"],
    ["library", targets[1], "create"],
    ["registry", join(m.deviceHome, "registry.json"), "create"],
    ["machine-settings", join(m.deviceHome, "machine-settings.json"), "create"],
    ["host-hooks", join(m.home, ".claude", "settings.json"), "create"],
    ["host-hooks", join(m.home, ".codex", "hooks.json"), "create"],
    ["host-hooks", join(m.home, ".codex", "config.toml"), "create"],
    ["managed-sections", join(m.container, "AGENTS.md"), "create"],
    ["managed-sections", join(m.container, "CLAUDE.md"), "create"],
  ]);
  assert.deepEqual(planned.blockers.map((entry) => [entry.step, entry.reasonCode]), [["engine", "SETUP_ENGINE_NOT_INSTALLED"]]);
  assert.deepEqual(planned.library, { path: targets[0], action: "create", libraryId: expected.workspaceId });
  assert.deepEqual(planned.questions.map((question) => [question.id, question.default]), [["cloud", false], ["language", "en"], ["navigation", true]]);
});

test("489-R1 (MIN-235 D17, MIN-238 D4): every gate that is not satisfied is listed item by item, and a pending gate stays pending", async (context) => {
  const m = await machine(context);
  const root = await oldPartition(m, "design-system");
  const designProject = await project(m, "design-system");
  const workspace = await openLegacyWorkspace(root);
  const state = replayLegacyWorkspace(workspace);
  const projectId = state.projects.find((entry) => !entry.tombstone).id;
  // After attestation was enabled every payload carries the actor the fixture writes with.
  const actor = workspace.events.at(-1).payload.actor;
  const gate = (id, outcomeClass, title, status, revision, occurredAt) => ({
    extensions: {},
    id,
    outcomeClass,
    projectId,
    revision,
    schemaVersion: "tcrn.gate.v1",
    status,
    title,
    tombstone: false,
    updatedAt: occurredAt,
    workId: expected.records.story.id,
  });
  const ownerGate = gate("gate:00000000000000000000a001", "owner_intent_required", "Owner intent gate", "pending", 1, "2026-01-01T00:00:35Z");
  const blockedGate = gate("gate:00000000000000000000b002", "recommendation", "Recommendation gate", "pending", 1, "2026-01-01T00:00:36Z");
  const head = await appendLegacyEvents(root, [
    { actor, operation: "gate.created", record: ownerGate },
    { actor, operation: "gate.created", record: blockedGate },
    { actor, operation: "gate.updated", record: { ...blockedGate, status: "blocked", revision: 2, updatedAt: "2026-01-01T00:00:37Z" } },
  ]);
  const mapping = await writeMapping(m, [{ partition: "design-system", legacyWorkspace: root, projectRoot: designProject }]);
  const before = await treeDigest(root);

  const planned = await plan(m, { mapping });
  const [entry] = planned.migration.partitions;
  assert.deepEqual([entry.action, entry.events, entry.headEventHash], ["import", expected.events + 3, head]);
  assert.deepEqual(entry.unsatisfiedGates, [
    { id: ownerGate.id, workId: expected.records.story.id, status: "pending", title: "Owner intent gate", outcomeClass: "owner_intent_required" },
    { id: blockedGate.id, workId: expected.records.story.id, status: "blocked", title: "Recommendation gate", outcomeClass: "recommendation" },
    FIXTURE_GATE,
  ]);
  // The plan turned nothing satisfied: the old chain is byte for byte as it was and still holds them.
  assert.deepEqual(await treeDigest(root), before);
  const after = replayLegacyWorkspace(await openLegacyWorkspace(root));
  assert.deepEqual(after.gates.filter((record) => !record.tombstone).map((record) => [record.id, record.status]), [
    [ownerGate.id, "pending"],
    [blockedGate.id, "blocked"],
    [FIXTURE_GATE.id, "pending"],
  ]);
});

test("489-R1: a target that is not a new or empty directory, an old workspace that does not read and a project registered elsewhere stop the apply", async (context) => {
  const m = await machine(context);
  const partitions = [];
  // cross-project: an empty .ether is where the library goes.
  partitions.push({ partition: "cross-project", legacyWorkspace: await oldPartition(m, "cross-project"), projectRoot: m.container });
  await mkdir(join(m.container, ".ether"));
  // alpha: its .ether holds a file of the user's.
  const alphaProject = await project(m, "alpha");
  partitions.push({ partition: "alpha", legacyWorkspace: await oldPartition(m, "alpha"), projectRoot: alphaProject });
  await mkdir(join(alphaProject, ".ether"));
  await writeFile(join(alphaProject, ".ether", "keep.txt"), "mine\n");
  // beta: its .ether is a file.
  const betaProject = await project(m, "beta");
  partitions.push({ partition: "beta", legacyWorkspace: await oldPartition(m, "beta"), projectRoot: betaProject });
  await writeFile(join(betaProject, ".ether"), "not a directory\n");
  // gamma: the old workspace the mapping names holds no old control directory.
  const gammaWorkspace = join(m.container, LEGACY_CONTAINER_DIRECTORY, "gamma", "workspace");
  await mkdir(gammaWorkspace, { recursive: true });
  partitions.push({ partition: "gamma", legacyWorkspace: gammaWorkspace, projectRoot: await project(m, "gamma") });
  // delta: this device registered the project to another library.
  const deltaProject = await project(m, "delta");
  partitions.push({ partition: "delta", legacyWorkspace: await oldPartition(m, "delta"), projectRoot: deltaProject });
  const elsewhere = join(m.base, "elsewhere");
  await initializeLibrary({ root: elsewhere, createdAt: at() });
  await registerLibrary({ projectPath: deltaProject, libraryPath: elsewhere, registeredAt: at(), cloudHosted: false, gitRemote: null }, m.deviceHome);
  // epsilon: the project the mapping names does not exist.
  const epsilonProject = join(m.container, "epsilon");
  partitions.push({ partition: "epsilon", legacyWorkspace: await oldPartition(m, "epsilon"), projectRoot: epsilonProject });
  const mapping = await writeMapping(m, partitions);

  const planned = await plan(m, { mapping });
  assert.deepEqual(planned.migration.partitions.map((entry) => [entry.partition, entry.targetState, entry.action]), [
    ["cross-project", "empty", "import"],
    ["alpha", "not-empty", "blocked"],
    ["beta", "not-a-directory", "blocked"],
    ["gamma", "absent", "blocked"],
    ["delta", "absent", "blocked"],
    ["epsilon", "absent", "blocked"],
  ]);
  assert.deepEqual(planned.blockers.filter((entry) => entry.step !== "engine").map((entry) => [entry.step, entry.path, entry.reasonCode]), [
    ["library", join(alphaProject, ".ether"), "LIBRARY_TARGET_NOT_EMPTY"],
    ["library", join(betaProject, ".ether"), "LIBRARY_TARGET_INVALID"],
    ["library", gammaWorkspace, "LEGACY_WORKSPACE_NOT_FOUND"],
    ["registry", join(deltaProject, ".ether"), "SETUP_LIBRARY_CONFLICT"],
    ["library", epsilonProject, "SETUP_INPUT_INVALID"],
  ]);
  // A chain that does not read is unknown, never none.
  const gamma = planned.migration.partitions.find((entry) => entry.partition === "gamma");
  assert.deepEqual([gamma.workspaceId, gamma.events, gamma.headEventHash, gamma.unsatisfiedGates, gamma.openItems], [null, null, null, null, null]);
  assert.deepEqual(planned.writes.filter((entry) => entry.step === "library").map((entry) => entry.path), [join(m.container, ".ether")]);
  await assert.rejects(applySetup(planned), (error) => error.reasonCode === "SETUP_BLOCKED" && error.details.blockers === String(planned.blockers.length));
  assert.deepEqual(await readdir(join(alphaProject, ".ether")), ["keep.txt"]);
  assert.equal((await stat(join(betaProject, ".ether"))).isFile(), true);
});

test("SUB-421 R18: a partition whose old knowledge store is refused still lists its chain's events, head, gates and open work, and the refusal is a blocker of its own on the file it names", async (context) => {
  const m = await machine(context);
  // tms: a store whose marker another tool saved again, indented and without its terminal LF.
  const tms = await oldPartition(m, "tms");
  await bindWhereRestored(tms);
  const tmsStore = join(tms, LEGACY_CONTROL_DIRECTORY, "knowledge");
  for (const directory of ["bodies", "metadata", "views"]) await mkdir(join(tmsStore, directory), { recursive: true });
  await writeFile(join(tmsStore, "store.json"), JSON.stringify({ workspaceId: expected.workspaceId }, null, 4));
  // moved: a store bound to the root its engine knew, not to where the old workspace sits now.
  const moved = await oldPartition(m, "moved");
  const movedStore = join(moved, LEGACY_CONTROL_DIRECTORY, "knowledge");
  await mkdir(movedStore);
  // clean: no store at all.
  const clean = await oldPartition(m, "clean");
  const projects = { tms: await project(m, "tms"), moved: await project(m, "moved"), clean: await project(m, "clean") };
  const mapping = await writeMapping(m, [
    { partition: "tms", legacyWorkspace: tms, projectRoot: projects.tms },
    { partition: "moved", legacyWorkspace: moved, projectRoot: projects.moved },
    { partition: "clean", legacyWorkspace: clean, projectRoot: projects.clean },
  ]);
  const before = await treeDigest(m.base);

  const planned = await plan(m, { mapping });
  assert.deepEqual(await treeDigest(m.base), before, "the plan wrote nothing");
  assert.deepEqual(planned.migration.partitions.map((entry) => [entry.partition, entry.targetState, entry.action]), [
    ["tms", "absent", "blocked"],
    ["moved", "absent", "blocked"],
    ["clean", "absent", "import"],
  ]);
  // The chain of every partition is listed, a refused store's included.
  const open = openWork(replayLegacyWorkspace(await openLegacyWorkspace(clean)));
  for (const entry of planned.migration.partitions) {
    assert.deepEqual([entry.workspaceId, entry.events, entry.headEventHash], [expected.workspaceId, expected.events, expected.headEventHash], entry.partition);
    assert.deepEqual(entry.unsatisfiedGates, [FIXTURE_GATE], entry.partition);
    assert.deepEqual(entry.openItems, open, entry.partition);
  }
  // Each refusal is a blocker of its own, on the file of the store it names: the marker, or the store
  // as a whole when it is about the place the store is bound to.
  const refused = planned.blockers.filter((entry) => entry.reasonCode.startsWith("KNOWLEDGE_"));
  assert.deepEqual(refused.map((entry) => [entry.step, entry.path, entry.reasonCode]), [
    ["library", join(tmsStore, "store.json"), "KNOWLEDGE_RECORD_INVALID"],
    ["library", movedStore, "KNOWLEDGE_PATH_INVALID"],
  ]);
  assert.match(refused[0].message, /store\.json of the old knowledge store/u);
  assert.deepEqual(planned.writes.filter((entry) => entry.step === "library").map((entry) => entry.path), [join(projects.clean, ".ether")]);
  await assert.rejects(applySetup(planned), (error) => error.reasonCode === "SETUP_BLOCKED");
  assert.deepEqual(await treeDigest(m.base), before);
});

test("SUB-421 R20: a batch mapping omits only the declared TMS store, keeps its two-file evidence and pending gate, and carries other knowledge byte for byte", async (context) => {
  const m = await machine(context);
  const tms = await oldKnowledgePartition(m, "TMS", true);
  const healthy = await oldKnowledgePartition(m, "healthy");
  const projects = { TMS: await project(m, "TMS"), healthy: await project(m, "healthy") };
  const plain = [
    { partition: "TMS", legacyWorkspace: tms.root, projectRoot: projects.TMS },
    { partition: "healthy", legacyWorkspace: healthy.root, projectRoot: projects.healthy },
  ];
  const mappingFile = await writeMapping(m, plain);
  const input = { mapping: await readMigrationMapping(mappingFile), mappingFile, home: m.home, deviceHome: m.deviceHome, legacyDeviceHome: m.legacyDevice, at: at() };
  const oldBefore = [await treeDigest(tms.root), await treeDigest(healthy.root)];
  installTripwire([tms.root, healthy.root]);
  const refused = await planMigration(input);
  assert.deepEqual(refused.migration.partitions.map((entry) => entry.action), ["blocked", "import"]);
  assert.deepEqual(refused.blockers.map((blocker) => [blocker.reasonCode, blocker.path]), [["KNOWLEDGE_RECORD_INVALID", join(tms.knowledge, "store.json")]]);
  const written = [];
  const recorder = { write: (...args) => written.push(args), backup: () => {}, backupDirectory: () => join(m.base, "backups") };
  await assert.rejects(applyMigration(recorder, { migration: refused.migration, deviceHome: m.deviceHome, at: input.at }), (error) => error.reasonCode === "SETUP_BLOCKED");
  for (const root of Object.values(projects)) await assert.rejects(stat(join(root, DIRECTORY.library)), { code: "ENOENT" });
  const omission = { reason: "MIN-240 (b): leave TMS knowledge behind and rebuild its two cards after the actual migration" };
  const explicit = [{ ...plain[0], omitLegacyKnowledge: omission }, plain[1]];
  // The mapping itself is outside the protected old trees.
  await writeMapping(m, explicit, mappingFile);
  const acceptedInput = { ...input, mapping: await readMigrationMapping(mappingFile) };
  const planned = await planMigration(acceptedInput);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.migration.partitions.map((entry) => entry.action), ["import", "import"]);
  const tmsPlan = planned.migration.partitions[0];
  assert.deepEqual([tmsPlan.knowledge, tmsPlan.knowledgeOmission.selection, tmsPlan.knowledgeOmission.reason, tmsPlan.knowledgeOmission.counts], [null, "omit", omission.reason, "unknown"]);
  assert.deepEqual(tmsPlan.knowledgeOmission.files.filter((file) => file.issue?.reasonCode === "KNOWLEDGE_RECORD_INVALID").map((file) => file.file).sort(), tms.damaged.sort());
  assert.deepEqual(tmsPlan.knowledgeOmission.unvalidatedCards.map((card) => card.externalKey).sort(), ["CARD-COUNT-ONLY-GATE", "CARD-FALSIFIABLE-NOT-CORRECT"]);
  for (const entry of planned.migration.partitions) {
    assert.deepEqual([entry.events, entry.headEventHash, entry.unsatisfiedGates], [expected.events, expected.headEventHash, [FIXTURE_GATE]]);
  }
  const applied = await applyMigration(recorder, { migration: planned.migration, deviceHome: m.deviceHome, at: input.at });
  assert.deepEqual(applied.partitions[0].knowledgeOmission, tmsPlan.knowledgeOmission);
  assert.deepEqual(applied.partitions[1].knowledge, planned.migration.partitions[1].knowledge);
  for (const [name, old] of [["TMS", tms], ["healthy", healthy]]) {
    const target = join(projects[name], DIRECTORY.library);
    const listed = await listKnowledgeMetadata(target, { at: input.at, selection: "all", status: "all", limit: 100 });
    assert.equal(listed.total, name === "TMS" ? 0 : 2);
    const state = await materializeWorkspace(target);
    assert.deepEqual(state.gates, replayLegacyWorkspace(await openLegacyWorkspace(old.root)).gates);
    assert.deepEqual([applied.partitions.find((entry) => entry.partition === name).events, applied.partitions.find((entry) => entry.partition === name).headEventHash], [expected.events, expected.headEventHash]);
  }
  for (const directory of ["metadata", "bodies"]) for (const name of await readdir(join(healthy.knowledge, directory))) {
    assert.deepEqual(await readFile(join(projects.healthy, DIRECTORY.library, DIRECTORY.knowledge, directory, name)), await readFile(join(healthy.knowledge, directory, name)));
  }
  assert.deepEqual(await readFile(join(projects.healthy, DIRECTORY.library, DIRECTORY.knowledge, "store.json")), await readFile(join(healthy.knowledge, "store.json")));
  assert.deepEqual([await treeDigest(tms.root), await treeDigest(healthy.root)], oldBefore);
  const again = await planMigration(acceptedInput);
  assert.deepEqual(again.blockers, []);
  assert.deepEqual(again.migration.partitions.map((entry) => entry.action), ["skip", "skip"]);
  assert.deepEqual(again.migration.partitions[0].knowledgeOmission, tmsPlan.knowledgeOmission);
  const skipped = await applyMigration(recorder, { migration: again.migration, deviceHome: m.deviceHome, at: input.at });
  assert.deepEqual(skipped.partitions[0].knowledgeOmission, tmsPlan.knowledgeOmission);
  const changed = await planMigration({ ...acceptedInput, mapping: { ...acceptedInput.mapping, partitions: [explicit[0], { ...plain[1], omitLegacyKnowledge: omission }] } });
  assert.equal(changed.migration.partitions[1].action, "blocked", "an omission never removes already carried knowledge");
  assert.equal(changed.blockers.some((blocker) => blocker.reasonCode === "LEGACY_IMPORT_MISMATCH"), true);
});

test("489-R1: with no --mapping and no old workspace in the project, the plan names the mapping and cannot be applied", async (context) => {
  const m = await machine(context);
  const before = await treeDigest(m.base);
  const planned = await plan(m);
  assert.equal(planned.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(planned.context.legacy, { detected: true, controlDirectory: null, deviceDirectory: m.legacyDevice });
  assert.deepEqual(planned.questions.map((question) => question.id), ["mapping", "cloud", "language", "navigation"]);
  assert.deepEqual(planned.questions[0], { id: "mapping", flag: "--mapping", default: null, choices: null });
  const { migration } = planned;
  assert.deepEqual([migration.mappingFile, migration.mapping, migration.partitions, migration.registry], [null, null, [], []]);
  const required = planned.blockers.filter((entry) => entry.reasonCode === "SETUP_ANSWER_REQUIRED");
  assert.deepEqual(required.map((entry) => [entry.step, entry.path]), [["library", m.container]]);
  assert.match(required[0].message, /--mapping/u);
  assert.deepEqual(planned.writes.filter((entry) => entry.step !== "device"), []);
  assert.equal(planned.library, null);
  await assert.rejects(applySetup(planned), (error) => error.reasonCode === "SETUP_BLOCKED");
  assert.deepEqual(await treeDigest(m.base), before);
});

test("489-R1: an old workspace in the project itself is the mapping the plan proposes", async (context) => {
  const m = await machine(context, { legacyDevice: false });
  const { root } = await restoreLegacyFixture(m.base, "legacy-project");
  const planned = await planSetup({ mode: "migrate", projectRoot: root, at: at(), home: m.home, deviceHome: m.deviceHome });
  assert.deepEqual(planned.context.legacy, { detected: true, controlDirectory: join(root, LEGACY_CONTROL_DIRECTORY), deviceDirectory: null });
  assert.deepEqual(planned.migration.mapping, {
    schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION,
    partitions: [{ partition: "legacy-project", legacyWorkspace: root, projectRoot: root }],
  });
  assert.equal(planned.migration.mappingFile, null);
  assert.equal(planned.questions[0].id, "mapping", "the proposal is shown to be confirmed");
  assert.deepEqual(planned.blockers.filter((entry) => entry.reasonCode === "SETUP_ANSWER_REQUIRED"), []);
  const [entry] = planned.migration.partitions;
  assert.deepEqual([entry.target, entry.action, entry.events, entry.headEventHash], [join(root, ".ether"), "import", expected.events, expected.headEventHash]);
  assert.deepEqual(planned.library, { path: join(root, ".ether"), action: "create", libraryId: expected.workspaceId });
  assert.equal(planned.resolved.artifacts, join(root, ".ether"));
  assert.deepEqual(planned.migration.deviceSettings, { from: null, to: join(m.deviceHome, "machine-settings.json"), keys: [] });
});

test("489-R1: a mapping that does not read or does not check answers SETUP_ANSWER_INVALID and names the question", async (context) => {
  const m = await machine(context);
  const good = { partition: "alpha", legacyWorkspace: join(m.base, "old-alpha"), projectRoot: join(m.base, "alpha") };
  const other = { partition: "beta", legacyWorkspace: join(m.base, "old-beta"), projectRoot: join(m.base, "beta") };
  const mapping = (partitions, schemaVersion = MIGRATION_MAPPING_SCHEMA_VERSION) => JSON.stringify({ schemaVersion, partitions });
  const cases = [
    ["missing", null, undefined],
    ["not-json", "{", undefined],
    ["bare-list", JSON.stringify([good]), undefined],
    ["other-schema", mapping([good], "einzbern.migration-mapping.v0"), "schemaVersion"],
    ["no-partition", mapping([]), "partitions"],
    ["unknown-field", mapping([{ ...good, library: join(m.base, "library") }]), "library"],
    ["relative-project", mapping([{ ...good, projectRoot: "alpha" }]), "projectRoot"],
    ["relative-workspace", mapping([{ ...good, legacyWorkspace: "old-alpha" }]), "legacyWorkspace"],
    ["partition-twice", mapping([good, { ...other, partition: "alpha" }]), "partition"],
    ["workspace-twice", mapping([good, { ...other, legacyWorkspace: good.legacyWorkspace }]), "legacyWorkspace"],
    ["project-twice", mapping([good, { ...other, projectRoot: `${good.projectRoot}/` }]), "projectRoot"],
    ["two-line-name", mapping([{ ...good, projectName: "two\nlines" }]), "projectName"],
    ["omission-boolean", mapping([{ ...good, omitLegacyKnowledge: true }]), "omitLegacyKnowledge"],
    ["omission-null", mapping([{ ...good, omitLegacyKnowledge: null }]), "omitLegacyKnowledge"],
    ["omission-list", mapping([{ ...good, omitLegacyKnowledge: [] }]), "omitLegacyKnowledge"],
    ["omission-no-reason", mapping([{ ...good, omitLegacyKnowledge: {} }]), "omitLegacyKnowledge.reason"],
    ["omission-reason-number", mapping([{ ...good, omitLegacyKnowledge: { reason: 1 } }]), "omitLegacyKnowledge.reason"],
    ["omission-reason-blank", mapping([{ ...good, omitLegacyKnowledge: { reason: " " } }]), "omitLegacyKnowledge.reason"],
    ["omission-reason-lines", mapping([{ ...good, omitLegacyKnowledge: { reason: "two\nlines" } }]), "omitLegacyKnowledge.reason"],
    ["omission-reason-control", mapping([{ ...good, omitLegacyKnowledge: { reason: "x\u0000y" } }]), "omitLegacyKnowledge.reason"],
    ["omission-reason-high-surrogate", mapping([{ ...good, omitLegacyKnowledge: { reason: "x\ud800y" } }]), "omitLegacyKnowledge.reason"],
    ["omission-reason-low-surrogate", mapping([{ ...good, omitLegacyKnowledge: { reason: "x\udc00y" } }]), "omitLegacyKnowledge.reason"],
    ["omission-extra", mapping([{ ...good, omitLegacyKnowledge: { reason: "why", unchecked: true } }]), "omitLegacyKnowledge.unchecked"],
  ];
  for (const [label, content, field] of cases) {
    const file = join(m.base, `${label}.json`);
    if (content !== null) await writeFile(file, content);
    await assert.rejects(readMigrationMapping(file), (error) => {
      assert.deepEqual([error.reasonCode, error.details.question, error.details.file], ["SETUP_ANSWER_INVALID", "mapping", file], label);
      if (field !== undefined) assert.equal(error.details.field, field, label);
      return true;
    });
  }
  const longReason = "x".repeat(513) + " 🧭";
  const longMapping = await writeMapping(m, [{ ...good, omitLegacyKnowledge: { reason: longReason } }]);
  const beforeLongRead = await treeDigest(m.base);
  assert.equal((await readMigrationMapping(longMapping)).partitions[0].omitLegacyKnowledge.reason, longReason, "mapping preserves the complete admitted omission reason");
  assert.deepEqual(await treeDigest(m.base), beforeLongRead, "reading a long omission reason writes nothing");
  const accepted = await readMigrationMapping(await writeMapping(m, [good, { ...other, projectName: "Beta", gitRemote: "https://example.invalid/team/beta.git" }]));
  assert.deepEqual(accepted.partitions.map((entry) => Object.keys(entry).sort()), [
    ["legacyWorkspace", "partition", "projectRoot"],
    ["gitRemote", "legacyWorkspace", "partition", "projectName", "projectRoot"],
  ]);
});

test("480-R6, 489-R1: migrate takes --mapping, --cloud, --language and --navigation and no other answer", async (context) => {
  const m = await machine(context);
  const crossProject = await oldPartition(m, "cross-project");
  await writeMapping(m, [{ partition: "cross-project", legacyWorkspace: crossProject, projectRoot: m.container }], join(m.container, "mapping.json"));
  const before = await treeDigest(m.base);
  installTripwire([m.container, m.home, m.deviceHome]);
  const planned = await plan(m, { mapping: "mapping.json", answers: { cloud: true, language: "zh", navigation: false } });
  assert.equal(planned.migration.mappingFile, join(m.container, "mapping.json"), "a relative --mapping is taken from the project");
  assert.deepEqual(planned.questions, []);
  assert.deepEqual(planned.resolved, { artifacts: join(m.container, ".ether"), cloud: true, language: "zh-CN", navigation: false });
  assert.deepEqual(planned.migration.registry.map((entry) => entry.cloudHosted), [true]);
  await assert.rejects(plan(m, { answers: { artifacts: join(m.base, "elsewhere") } }), { reasonCode: "SETUP_OPTION_NOT_APPLICABLE" });
  await assert.rejects(plan(m, { restore: join(m.base, "library") }), { reasonCode: "SETUP_OPTION_NOT_APPLICABLE" });
  await assert.rejects(plan(m, { mapping: "mapping.json", answers: { language: "de-DE" } }), (error) => {
    assert.deepEqual([error.reasonCode, error.details.question, error.details.allowed], ["SETUP_ANSWER_INVALID", "language", "en,fr,ja,ko,zh-CN"]);
    assert.match(error.message, /^de-DE is not a language this engine writes in/u);
    return true;
  });
  assert.deepEqual(await treeDigest(m.base), before, "the alias plan and refusals wrote nothing");
  // With no installation from before the rename there is nothing to migrate, whatever a mapping names.
  const bare = await machine(context, { legacyDevice: false });
  const bareBefore = await treeDigest(bare.base);
  await assert.rejects(plan(bare, { mapping: join(m.container, "mapping.json") }), { reasonCode: "SETUP_MIGRATE_NOTHING" });
  assert.deepEqual(await treeDigest(bare.base), bareBefore);
});

for (const language of ["en", "zh-CN", "ja", "ko", "fr"]) {
  test(`480-R6, 489-R1: migrate plans canonical ${language} through the CLI and writes nothing under the tripwire`, async (context) => {
    const m = await machine(context);
    const crossProject = await oldPartition(m, "cross-project");
    const partitions = [{ partition: "cross-project", legacyWorkspace: crossProject, projectRoot: m.container }];
    const mapping = await writeMapping(m, partitions, join(m.container, "mapping.json"));
    const before = await treeDigest(m.base);
    const argv = ["--import", join(repositoryRoot, "scripts/no-network.mjs"), "--import", tripwirePath, cliPath,
      "setup", "--mode", "migrate", "--project", m.container, "--mapping", "mapping.json",
      "--cloud", "true", "--language", language, "--navigation", "false", "--at", at()];
    const run = spawnSync(process.execPath, argv, {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: m.home,
        USERPROFILE: m.home,
        EINZBERN_HOME: m.deviceHome,
        EINZBERN_TRIPWIRE_ROOT: [m.container, m.home, m.deviceHome, guardHome].join(delimiter),
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const after = await treeDigest(m.base);
    assert.deepEqual(after, before, `${language}: the CLI plan wrote nothing`);
    assert.deepEqual(await readdir(guardHome), [], "the fallback home stays empty");
    const planned = JSON.parse(run.stdout);
    assert.deepEqual([planned.reasonCode, planned.mode, planned.questions], ["SETUP_PLAN_READY", "migrate", []]);
    assert.deepEqual(planned.resolved, { artifacts: join(m.container, ".ether"), cloud: true, language, navigation: false });
    assert.equal(planned.migration.mappingFile, mapping, "a relative --mapping is taken from the project");
    assert.deepEqual(planned.migration.mapping, { schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION, partitions });
    const [entry] = planned.migration.partitions;
    assert.deepEqual([entry.action, entry.events, entry.headEventHash, entry.unsatisfiedGates], ["import", expected.events, expected.headEventHash, [FIXTURE_GATE]]);
    assert.deepEqual(planned.migration.registry, [{
      partition: "cross-project", projectPath: m.container, libraryPath: join(m.container, ".ether"),
      libraryId: expected.workspaceId, cloudHosted: true, gitRemote: null, migratedFrom: crossProject,
    }]);
    assert.deepEqual(planned.migration.deviceSettings, { from: null, to: join(m.deviceHome, "machine-settings.json"), keys: [] });
    assert.deepEqual(planned.blockers.map((blocker) => [blocker.step, blocker.reasonCode]), [["engine", "SETUP_ENGINE_NOT_INSTALLED"]]);
    context.diagnostic(JSON.stringify({
      language, argv: [process.execPath, ...argv], protectedRoots: [m.container, m.home, m.deviceHome, guardHome],
      fixtureBeforeSha256: sha256(JSON.stringify(before)), fixtureAfterSha256: sha256(JSON.stringify(after)),
      stdout: run.stdout, stderr: run.stderr, exitCode: run.status,
    }));
  });
}

test("489-R1 (R2): the portal keys of the old device directory's machine settings are set, kept or refused key by key", async (context) => {
  const m = await machine(context);
  const from = join(m.legacyDevice, "machine-settings.json");
  const to = join(m.deviceHome, "machine-settings.json");
  await writeFile(from, `${JSON.stringify({
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    schemaVersion: MACHINE_SETTINGS_VERSION,
    updatedAt: "2026-09-24T03:54:18.104Z",
    values: {
      "agents.navigation": "written",
      "portal.defaultLocale": "ja",
      "portal.defaultPartition": "cross-project",
      "portal.defaultTheme": "dark",
      "portal.port": "99",
    },
  })}\n`);
  await applyMachineSettingSet({ key: "portal.defaultLocale", value: "en", occurredAt: at(), path: to });
  await applyMachineSettingSet({ key: "portal.defaultPartition", value: "cross-project", occurredAt: at(), path: to });
  const input = { mapping: null, mappingFile: null, home: m.home, deviceHome: m.deviceHome, legacyDeviceHome: m.legacyDevice, at: at() };
  const before = await treeDigest(m.base);
  const planned = await planMigration(input);
  assert.deepEqual(planned.migration.deviceSettings, {
    from,
    to,
    keys: [
      { key: "portal.defaultLocale", value: "ja", current: "en", action: "kept" },
      { key: "portal.defaultPartition", value: "cross-project", current: "cross-project", action: "unchanged" },
      { key: "portal.defaultTheme", value: "dark", current: null, action: "set" },
      { key: "portal.port", value: "99", current: null, action: "invalid" },
    ],
  });
  assert.deepEqual(planned.writes, [{ step: "machine-settings", path: to, action: "update" }]);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(await treeDigest(m.base), before);

  // A file that does not read as settings stops the apply; it is not skipped.
  await writeFile(from, "not json\n");
  const unreadable = await planMigration(input);
  assert.deepEqual(unreadable.blockers.map((entry) => [entry.step, entry.path, entry.reasonCode]), [["machine-settings", from, "MACHINE_SETTINGS_FILE_INVALID"]]);
  assert.deepEqual(unreadable.migration.deviceSettings.keys, []);
});
