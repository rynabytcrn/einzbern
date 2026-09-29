// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-489 AC1, AC2, AC3, AC4 (fixture) (TCRN-CROSS-SUB-366; MIN-238 D4): a temporary
// machine from before the rename, migrated end to end through the shipped entry. The home holds the
// old device directory (the old engine copy, the old helper's install markers, its machine settings),
// the old helper's copies, the old injection state and user host files with the old harness's hooks
// and deny rules; the container holds two old partitions, the platform archive, container host files
// with the old harness's hooks, deny rules and inert key, the old templates and the old portal
// launchers; an engine is installed in the device directory. setup --mode migrate plans without
// writing, then --yes true imports and registers both partitions, takes the old installation off
// into the device directory's backups and wires the container as fresh does: each library holds its
// old chain up to the old head (AC1), each host keeps one hook and no deny rule (AC2), doctor's eight
// checks are green (AC3), a write to an old path names the library it moved to (AC4), and the old
// workspaces' container and the archive are not touched. A second run finds nothing to do. The
// migrated library's old chain enabled attestation, so a later repair, and a second device's
// restore, write their section records under the wizard's actor and leave AGENTS.md and the
// records in agreement.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  FRAMEWORK_VERSION,
  LEGACY_CONTAINER_DIRECTORY,
  LEGACY_CONTROL_DIRECTORY,
  LEGACY_DEVICE_DIRECTORY,
  LEGACY_ENGINE_NAME,
  LEGACY_HELPER_NAME,
  LOCAL_DIRECTORY_NAMES,
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTINGS_VERSION,
  PLATFORM_ARCHIVE_DIRECTORY,
  computeInstallTreeDigest,
  materializeWorkspaceFromGenesis,
  openLegacyWorkspace,
  readAllStreams,
} from "../dist/build/packages/core/src/index.js";
import { DOCTOR_CHECKS } from "../dist/build/packages/core/src/doctor.js";
import { CODEX_CONFIG_FILE, HOST_HOOK_FILES, isEinzbernHookCommand, isLegacyHookCommand } from "../dist/build/packages/core/src/host-hooks.js";
import { LEGACY_PORTAL_LAUNCHERS, LEGACY_TEMPLATE_DIRECTORIES } from "../dist/build/packages/core/src/migrate-cleanup.js";
import { MIGRATION_MAPPING_SCHEMA_VERSION } from "../dist/build/packages/core/src/migrate-legacy.js";
import { LEGACY_INERT_SETTINGS_KEY, LEGACY_INJECTION_STATE_DIRECTORY } from "../dist/build/packages/core/src/names.js";
import { SETUP_ACTOR } from "../dist/build/packages/core/src/setup.js";
import { legacyWorkspaceEventId, legacyWorkspaceStreamId } from "../dist/build/packages/core/src/workspace.js";
import { canonicalJson, createEvent, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED as expected, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-migrate-e2e-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

const CLAUDE = HOST_HOOK_FILES["claude-code"];
const CODEX = HOST_HOOK_FILES.codex;
const LEGACY_SKILL_ROOTS = [".claude/skills", ".agents/skills", ".codex/skills"];
const ALPHA_EXTERNAL_KEY = "LEGACY-ALPHA-WORKSPACE";
// The fixture's one live gate: pending, bound to its Story.
const FIXTURE_GATE_ID = "gate:f48272b1736ccd8d29165c37";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 29, 12, 0, second)).toISOString().replace(".000Z", "Z");
};
const stampOf = (instant) => instant.replace(/[-:]/gu, "");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Relative path, size, mtime and sha256 of every entry under a directory. */
async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${entry.isFile() ? sha256(await readFile(path)) : "directory"}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeTree(root, files) {
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

function hookCommands(document) {
  return Object.entries(document.hooks ?? {}).flatMap(([event, groups]) => groups
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => ({ event, command: hook.command })));
}

/** One CLI run through the shipped entry as this machine, optionally under the write tripwire. */
function run(m, args, { tripwire = [] } = {}) {
  return spawnSync(process.execPath, [...(tripwire.length === 0 ? [] : ["--import", tripwirePath]), cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: m.home,
      USERPROFILE: m.home,
      EINZBERN_HOME: m.device,
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

/**
 * The engine version directory as a release lays it out (scripts/pack-release.mjs), built from this
 * checkout, and installed as the current engine of the device m names, one tree per device.
 */
async function installEngine(m) {
  const tree = join(m.base, "trees", basename(m.device), FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook.mjs"), join(tree, "scripts/einzbern-hook.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  await mkdir(join(tree, "launchers"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), join(tree, "launchers/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), join(tree, "launchers/hook.mjs"));
  assert.equal(receipt(run(m, ["skill-render", "--out", join(tree, "skill", "mana-orchestrate"), "--version", FRAMEWORK_VERSION])).reasonCode, "SKILL_RENDERED");
  const digest = (await computeInstallTreeDigest(tree)).sha256;
  const installed = receipt(run(m, ["engine-update", "--from", tree, "--sha256", digest, "--version", FRAMEWORK_VERSION, "--at", at()]));
  assert.equal(installed.reasonCode, "ENGINE_UPDATED");
}

/**
 * The frozen fixture's chain written again as the old engine would have written it for another
 * workspace (external key and the id it derives), so that every partition has its own id as every
 * real one does.
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

// The Claude form of the old harness: guarded by the project directory, on seven events.
function claudeOldGroups() {
  const script = (name) => `\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/${name}`;
  const guarded = (name) => `if [ -f "${script(name)}" ]; then node "${script(name)}"; fi`;
  const knowledge = guarded("scripts/knowledge-inject-hook.mjs");
  return {
    Stop: [
      { hooks: [{ type: "command", command: guarded("tools/stop-pact/hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: guarded("scripts/knowledge-capture-hook.mjs"), timeout: 30 }] },
      { hooks: [{ type: "command", command: guarded("tools/stop-pact/response-style-hook.mjs"), timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: guarded("scripts/agents-zero-hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: knowledge, timeout: 30 }] },
    ],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guarded("scripts/ssh-write-observer.mjs") }] }],
    SessionStart: [{ hooks: [{ type: "command", command: knowledge, timeout: 30 }] }],
    SubagentStart: [
      { hooks: [{ type: "command", command: guarded("scripts/dispatch-telemetry-hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: knowledge, timeout: 30 }] },
    ],
    SubagentStop: [{ hooks: [{ type: "command", command: guarded("scripts/dispatch-telemetry-hook.mjs"), timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: knowledge, timeout: 30 }] }],
  };
}

// The Codex form: absolute paths into the old engine copy.
function codexOldGroups(engine) {
  const node = (name) => `node "${join(engine, name)}"`;
  return {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: node("scripts/ssh-write-observer.mjs") }] },
      { matcher: "Edit|Write|apply_patch", hooks: [{ type: "command", command: node("scripts/chain-write-guard.mjs") }] },
    ],
    SessionStart: [{ hooks: [{ type: "command", command: node("scripts/knowledge-inject-hook.mjs"), timeout: 30 }] }],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: node("scripts/knowledge-inject-hook.mjs"), timeout: 30 }] },
      { hooks: [{ type: "command", command: node("scripts/agents-zero-hook.mjs"), timeout: 10 }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: node("tools/stop-pact/codex-executor.mjs"), timeout: 10 }] }],
    SubagentStart: [{ hooks: [{ type: "command", command: node("scripts/dispatch-telemetry-hook.mjs"), timeout: 10 }] }],
    SubagentStop: [{ hooks: [{ type: "command", command: node("scripts/dispatch-telemetry-hook.mjs"), timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: node("scripts/knowledge-inject-hook.mjs"), timeout: 30 }] }],
  };
}

function fenced(directory) {
  return [`Edit(/${directory}/**)`, `Edit(/${directory}/.*)`, `Edit(/${directory}/**/.*)`];
}

function trustStates(hooksPath, hooks) {
  const snake = (event) => event.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return Object.entries(hooks).flatMap(([event, groups]) => groups
    .flatMap((group, groupIndex) => group.hooks.map((_hook, hookIndex) => `${hooksPath}:${snake(event)}:${groupIndex}:${hookIndex}`)))
    .flatMap((key, index) => [`[hooks.state.${JSON.stringify(key)}]`, `trusted_hash = "sha256:${String(index).padStart(4, "0")}"`, ""]);
}

// Other tools' hooks and keys, which the migration keeps.
const OTHER_PROMPT = { hooks: [{ type: "command", command: "echo other-tool", timeout: 5 }] };
const OTHER_TOOL = { matcher: "Write", hooks: [{ type: "command", command: "prettier --write", timeout: 5 }] };

/** The temporary machine from before the rename, with an engine installed. */
async function oldMachine(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-migrate-e2e-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const container = join(base, "container");
  const alphaProject = join(container, "alpha");
  const device = join(base, "device");
  const legacyDevice = join(home, LEGACY_DEVICE_DIRECTORY);
  const oldContainer = join(container, LEGACY_CONTAINER_DIRECTORY);
  const archive = join(container, PLATFORM_ARCHIVE_DIRECTORY);
  await mkdir(alphaProject, { recursive: true });
  const m = { base, home, container, alphaProject, device, legacyDevice, oldContainer, archive };
  await installEngine(m);

  // The old partitions and the platform archive.
  const crossProject = (await restoreLegacyFixture(join(oldContainer, "cross-project"), "workspace")).root;
  const alpha = (await restoreLegacyFixture(join(oldContainer, "alpha"), "workspace")).root;
  const alphaHead = await rehome(alpha, ALPHA_EXTERNAL_KEY);
  await writeTree(archive, { "chain-snapshots/readme.txt": "the platform archive\n" });

  // The old device directory: the old engine copy, the old helper's install markers and the portal key.
  const oldEngine = join(legacyDevice, LEGACY_ENGINE_NAME);
  await writeTree(legacyDevice, {
    [`${LEGACY_ENGINE_NAME}/scripts/${LEGACY_ENGINE_NAME}.mjs`]: "export {};\n",
    "attestations/key.json": "{}\n",
    "installed-copy-claude.json": "{}\n",
    "installed-copy-agents.json": "{}\n",
    "skill-archive.json": "{}\n",
    "state.json": "{}\n",
    "trusted-bootstrap.mjs": "export {};\n",
    "complete-skill-archive.provenance.json": "{}\n",
  });
  await writeFile(join(legacyDevice, "machine-settings.json"), `${JSON.stringify({
    layerKind: MACHINE_SETTINGS_LAYER_KIND,
    schemaVersion: MACHINE_SETTINGS_VERSION,
    updatedAt: "2026-09-24T03:54:18.104Z",
    values: { "portal.defaultTheme": "dark" },
  })}\n`);

  // Host files at both levels, and Codex's config trusting every old hook.
  const containerDeny = [...fenced(oldContainer), ...fenced(legacyDevice), `Edit(**/${LEGACY_CONTAINER_DIRECTORY}/**)`];
  const userDeny = [`Edit(~/${LEGACY_DEVICE_DIRECTORY}/**)`, ...fenced(oldContainer)];
  await writeJson(join(home, CLAUDE), {
    env: { KEEP: "1" },
    hooks: { ...claudeOldGroups(), UserPromptSubmit: [...claudeOldGroups().UserPromptSubmit, OTHER_PROMPT] },
    permissions: { deny: userDeny },
  });
  await writeJson(join(container, CLAUDE), {
    env: { CONTAINER: "1" },
    hooks: claudeOldGroups(),
    permissions: { deny: containerDeny },
    [LEGACY_INERT_SETTINGS_KEY]: { activation: false },
  });
  const userCodexHooks = { hooks: { ...codexOldGroups(oldEngine), PreToolUse: [OTHER_TOOL] } };
  const containerCodexHooks = { description: "the old platform harness", hooks: codexOldGroups(oldEngine) };
  await writeJson(join(home, CODEX), userCodexHooks);
  await writeJson(join(container, CODEX), containerCodexHooks);
  await writeFile(join(home, CODEX_CONFIG_FILE), ["[features]", "hooks = true", "", "[hooks.state]", "",
    ...trustStates(join(home, CODEX), userCodexHooks.hooks), ...trustStates(join(container, CODEX), containerCodexHooks.hooks)].join("\n"));

  // The rest of the old installation: templates, the old helper's copies, the injection state and
  // the old portal launchers.
  for (const template of LEGACY_TEMPLATE_DIRECTORIES) await writeTree(join(container, ...template.split("/")), { "bootstrap.json": "{}\n", "stop.json": "{}\n" });
  for (const root of LEGACY_SKILL_ROOTS) await writeTree(join(home, ...root.split("/"), LEGACY_HELPER_NAME), { "SKILL.md": "legacy helper\n" });
  await writeTree(join(home, LEGACY_INJECTION_STATE_DIRECTORY), { "state.json": "{\"decisions\":[]}\n" });
  for (const name of LEGACY_PORTAL_LAUNCHERS) await writeFile(join(container, name), "#!/bin/sh\n");

  const mapping = join(base, "mapping.json");
  await writeJson(mapping, {
    schemaVersion: MIGRATION_MAPPING_SCHEMA_VERSION,
    partitions: [
      { partition: "cross-project", legacyWorkspace: crossProject, projectRoot: container },
      { partition: "alpha", legacyWorkspace: alpha, projectRoot: alphaProject, projectName: "Alpha", gitRemote: "https://example.invalid/team/alpha.git" },
    ],
  });
  return {
    ...m,
    mapping,
    partitions: [
      { root: crossProject, target: join(container, ".ether"), workspaceId: expected.workspaceId, head: expected.headEventHash },
      { root: alpha, target: join(alphaProject, ".ether"), workspaceId: deriveStableId("workspace", ALPHA_EXTERNAL_KEY), head: alphaHead },
    ],
  };
}

function setup(m, extra = [], options = {}) {
  return run(m, ["setup", "--mode", "migrate", "--project", m.container, "--mapping", m.mapping, "--at", at(), ...extra], options);
}

const ANSWERS = ["--cloud", "false", "--language", "zh-CN", "--navigation", "true"];

test("489-AC1, AC2, AC3, AC4 (fixture): setup --mode migrate --yes true on a machine from before the rename migrates both partitions, takes the old installation off into the backups and leaves doctor's eight checks green", async (context) => {
  const m = await oldMachine(context);
  const machineBefore = await treeDigest(m.base);
  const oldContainer = await treeDigest(m.oldContainer);
  const archive = await treeDigest(m.archive);

  // The plan writes nothing anywhere, lists what the cleanup takes off and stops at nothing.
  const planned = receipt(setup(m, ANSWERS, { tripwire: [m.base] }));
  assert.deepEqual(await treeDigest(m.base), machineBefore, "the plan wrote nothing");
  assert.deepEqual([planned.reasonCode, planned.questions, planned.blockers], ["SETUP_PLAN_READY", [], []]);
  const kinds = planned.migration.hostCleanup.map((item) => item.kind);
  assert.deepEqual([...new Set(kinds)], ["host-file", "template", "injection-state", "launcher", "skill-copy", "marker"]);
  for (const excluded of [m.oldContainer, m.archive, m.legacyDevice]) {
    assert.equal(planned.migration.hostCleanup.some((item) => item.path === excluded), false, excluded);
    assert.equal(planned.writes.some((entry) => entry.path === excluded), false, excluded);
  }

  // The apply, in a process whose every write under the old workspaces' container and the archive is refused.
  const applyAt = at();
  const applied = receipt(run(m, ["setup", "--mode", "migrate", "--project", m.container, "--mapping", m.mapping, "--at", applyAt, ...ANSWERS, "--yes", "true"],
    { tripwire: [m.oldContainer, m.archive] }));
  assert.deepEqual([applied.reasonCode, applied.mode], ["SETUP_APPLIED", "migrate"]);
  assert.deepEqual(await treeDigest(m.oldContainer), oldContainer, "the old workspaces' container is untouched");
  assert.deepEqual(await treeDigest(m.archive), archive, "the platform archive is untouched");
  assert.deepEqual(applied.migration.hostCleanup, planned.migration.hostCleanup.map((item) => ({
    ...item,
    into: item.into.replace(stampOf(planned.at), stampOf(applyAt)),
  })), "the apply took off what the plan listed");
  assert.equal(applied.backupDir, join(m.device, "backups", stampOf(applyAt)));

  // AC1: each library chain-validates and carries its old chain up to the old head: alpha's ends
  // there, the container's goes on with this device's writes (the language and the sections).
  for (const [index, partition] of m.partitions.entries()) {
    const validated = receipt(run(m, ["chain-validate", "--workspace", partition.target]));
    assert.deepEqual([validated.reasonCode, validated.workspaceId, validated.rejectedEventCount], ["CHAIN_VALIDATED", partition.workspaceId, 0], partition.target);
    const [stream] = (await readAllStreams(partition.target)).streams;
    assert.equal(stream.manifest.identityScheme, "legacy");
    assert.equal(stream.events[expected.events - 1].eventHash, partition.head, partition.target);
    if (index === 1) assert.deepEqual([validated.events, validated.streams[0].headEventHash], [expected.events, partition.head]);
  }
  const library = await materializeWorkspaceFromGenesis(m.partitions[0].target);
  assert.equal(library.settings.find((setting) => setting.key === "artifact.language")?.value, "zh-CN", "the language answer is the library's");
  assert.deepEqual(library.gates.filter((gate) => !gate.tombstone).map((gate) => [gate.id, gate.status]), [[FIXTURE_GATE_ID, "pending"]], "a pending gate stays pending");
  const written = (await readAllStreams(m.partitions[0].target)).streams[0].events.slice(expected.events);
  assert.ok(written.length > 0);
  assert.ok(written.every((event) => event.payload.actor === SETUP_ACTOR), "the wizard's writes name its actor");

  // AC2: one Einzbern hook per host, in the user's files; none of ours in the container's; no deny
  // rule at either level; other tools' hooks and keys, and Codex's hooks switch, stay.
  for (const file of [CLAUDE, CODEX]) {
    const user = await readJson(join(m.home, file));
    assert.deepEqual(hookCommands(user).filter((hook) => isEinzbernHookCommand(hook.command)).map((hook) => hook.event), ["UserPromptSubmit"], file);
    const container = await readJson(join(m.container, file));
    for (const document of [user, container]) assert.deepEqual(hookCommands(document).filter((hook) => isLegacyHookCommand(hook.command)), [], file);
    assert.deepEqual(hookCommands(container).filter((hook) => isEinzbernHookCommand(hook.command)), [], file);
  }
  const userClaude = await readJson(join(m.home, CLAUDE));
  assert.deepEqual([userClaude.env, userClaude.permissions, userClaude.hooks.UserPromptSubmit[1]], [{ KEEP: "1" }, { deny: [] }, OTHER_PROMPT]);
  assert.deepEqual(await readJson(join(m.container, CLAUDE)), { env: { CONTAINER: "1" }, hooks: {}, permissions: { deny: [] } });
  assert.deepEqual((await readJson(join(m.home, CODEX))).hooks.PreToolUse, [OTHER_TOOL]);
  const config = await readFile(join(m.home, CODEX_CONFIG_FILE), "utf8");
  assert.match(config, /^\[features\]\nhooks = true\n/u);
  assert.equal(config.includes(join(m.container, CODEX)), false, "no trust state of a removed hook stays");
  assert.match(config, /:pre_tool_use:0:0"\]/u, "the other tool's unchanged hook keeps its trust state");

  // Every item is in the backups; what moved is no longer where it was.
  for (const item of applied.migration.hostCleanup) {
    assert.equal(await exists(item.into), true, item.into);
    if (item.action === "move") assert.equal(await exists(item.path), false, item.path);
  }
  assert.deepEqual((await readdir(m.legacyDevice)).sort(), ["attestations", LEGACY_ENGINE_NAME, "machine-settings.json"].sort(), "the old device directory keeps its old engine, archive and settings");

  // AC3: doctor's eight checks, as the self-check and as the doctor verb answers them.
  assert.deepEqual([applied.selfCheck.exitCode, applied.selfCheck.hookReasonCode], [0, null], "the hook ran once as a host runs it");
  assert.deepEqual(applied.selfCheck.checks.map((entry) => [entry.check, entry.ok]), DOCTOR_CHECKS.map((check) => [check, true]),
    JSON.stringify(applied.selfCheck.checks.filter((entry) => !entry.ok)));
  const doctor = receipt(run(m, ["doctor", "--project", m.container]));
  assert.deepEqual([doctor.reasonCode, doctor.ok], ["DOCTOR_READY", true], JSON.stringify(doctor.checks.filter((entry) => !entry.ok)));

  // AC4: a write to an old workspace names the library it moved to.
  const error = refusal(run(m, ["work-annotate", "--workspace", m.partitions[1].root, "--at", at(), "--id", expected.records.story.id, "--summary", "after", "--actor", "agent:migrator"]));
  assert.deepEqual([error.reasonCode, error.movedTo], ["LEGACY_WORKSPACE_MIGRATED", m.partitions[1].target]);

  // A second run finds nothing to do: nothing to write, back up, clean or refuse, and writes nothing.
  const replanned = receipt(setup(m, ANSWERS));
  assert.deepEqual([replanned.writes, replanned.backups, replanned.blockers, replanned.migration.hostCleanup], [[], [], [], []]);
  const settled = await treeDigest(m.base);
  const again = receipt(setup(m, [...ANSWERS, "--yes", "true"], { tripwire: [m.oldContainer, m.archive, ...m.partitions.map((partition) => partition.target)] }));
  assert.deepEqual([again.written, again.migration.hostCleanup], [[], []]);
  const changed = (await treeDigest(m.base)).filter((row) => !settled.includes(row)).map((row) => row.split("|")[0]);
  assert.deepEqual(changed.filter((path) => !path.startsWith("device/")), [], "only the device directory's own bookkeeping moved");
});

/** A machine from before the rename, migrated once with the navigation section written. */
async function migratedMachine(context) {
  const m = await oldMachine(context);
  assert.equal(receipt(setup(m, [...ANSWERS, "--yes", "true"])).reasonCode, "SETUP_APPLIED");
  return m;
}

const NAVIGATION_SECTION = /<!-- einzbern:section id=navigation /u;

/** The managed-section records a library holds, key to state, replayed from genesis. */
async function sectionRecords(library) {
  const state = await materializeWorkspaceFromGenesis(library);
  return Object.fromEntries(state.configRecords.filter((record) => record.collection === "managed-section").map((record) => [record.key, record.value.state]));
}

/** The actor of every event a library holds beyond the old chain it was imported from. */
async function actorsAfterImport(library) {
  return (await readAllStreams(library)).streams.flatMap((stream) => stream.events
    .slice(stream.manifest.identityScheme === "legacy" ? expected.events : 0)
    .map((event) => event.payload.actor));
}

function assertDoctorGreen(receiptBody) {
  assert.deepEqual(receiptBody.selfCheck.checks.map((entry) => [entry.check, entry.ok]), DOCTOR_CHECKS.map((check) => [check, true]),
    JSON.stringify(receiptBody.selfCheck.checks.filter((entry) => !entry.ok)));
}

test("489 (TCRN-CROSS-SUB-366, problems #4): after a migration, repair with --navigation false succeeds on the migrated library, and AGENTS.md and the library's section records agree", async (context) => {
  const m = await migratedMachine(context);
  const library = m.partitions[0].target;
  const agents = join(m.container, "AGENTS.md");
  assert.match(await readFile(agents, "utf8"), NAVIGATION_SECTION);
  assert.equal((await sectionRecords(library))["AGENTS.md#navigation"], "managed");

  // The chain the library carries enabled attestation: the section's record goes under the
  // wizard's actor, in the same run as the section leaves the file.
  const repaired = receipt(run(m, ["setup", "--mode", "repair", "--project", m.container, "--navigation", "false", "--at", at(), "--yes", "true"],
    { tripwire: [m.oldContainer, m.archive] }));
  assert.equal(repaired.reasonCode, "SETUP_APPLIED");
  assert.doesNotMatch(await readFile(agents, "utf8"), NAVIGATION_SECTION);
  const records = await sectionRecords(library);
  assert.equal(Object.hasOwn(records, "AGENTS.md#navigation"), false, "the navigation section's record left with the section");
  assert.ok(Object.keys(records).length > 0 && Object.values(records).every((state) => state === "managed"), JSON.stringify(records));
  assert.ok((await actorsAfterImport(library)).every((actor) => actor === SETUP_ACTOR), "every event after the old chain names the wizard");
  assert.deepEqual(repaired.pendingSections, []);
  assertDoctorGreen(repaired);
  const validated = receipt(run(m, ["chain-validate", "--workspace", library]));
  assert.deepEqual([validated.reasonCode, validated.rejectedEventCount], ["CHAIN_VALIDATED", 0]);
});

test("489 (TCRN-CROSS-SUB-366, problems #4): a second device restores the migrated library, writes its section records in its own stream under the wizard's actor, and AGENTS.md and the records agree", async (context) => {
  const m = await migratedMachine(context);
  const library = m.partitions[0].target;
  const second = { ...m, home: join(m.base, "home2"), device: join(m.base, "device2") };
  await mkdir(second.home, { recursive: true });
  await installEngine(second);

  // The second device declines the navigation section, so the restore takes it out of AGENTS.md
  // and its record out of the library; nothing of the first device's is written.
  const restored = receipt(run(second, ["setup", "--mode", "restore", "--project", m.container, "--restore", library, "--cloud", "false", "--navigation", "false", "--at", at(), "--yes", "true"],
    { tripwire: [m.oldContainer, m.archive, m.home, m.device] }));
  assert.equal(restored.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(restored.library, { path: library, libraryId: m.partitions[0].workspaceId, created: false });
  assert.doesNotMatch(await readFile(join(m.container, "AGENTS.md"), "utf8"), NAVIGATION_SECTION);
  assert.equal(Object.hasOwn(await sectionRecords(library), "AGENTS.md#navigation"), false);
  const streams = (await readAllStreams(library)).streams;
  const own = streams.filter((stream) => stream.manifest.identityScheme !== "legacy");
  assert.equal(own.length, 1, "the second device writes its own stream");
  assert.ok(own[0].events.length > 0 && own[0].events.every((event) => event.payload.actor === SETUP_ACTOR));
  assertDoctorGreen(restored);
  const validated = receipt(run(second, ["chain-validate", "--workspace", library]));
  assert.deepEqual([validated.reasonCode, validated.rejectedEventCount], ["CHAIN_VALIDATED", 0]);
});
