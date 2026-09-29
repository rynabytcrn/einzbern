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
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  FRAMEWORK_VERSION,
  LEGACY_CONTAINER_DIRECTORY,
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
import { MIGRATION_MAPPING_SCHEMA_VERSION } from "../dist/build/packages/core/src/migrate-legacy.js";
import { findMigratedEntry } from "../dist/build/packages/core/src/registry.js";
import { FRESH_ENGINE_TREE } from "../dist/build/packages/core/src/setup-fresh.js";
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
