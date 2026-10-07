// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-489 R3, AC2 (fixture) (TCRN-CROSS-SUB-366; MIN-238 D4; STORY-479 R5): the cleanup
// setup --mode migrate runs once the partitions are imported and registered. A temporary home and
// container shaped like this platform's live files before the move (seven events of old hook groups
// at the user's and the container's level, twelve Codex commands, twelve and thirteen deny rules,
// the inert key, trust states for every old Codex hook) keep, after it, one Einzbern
// UserPromptSubmit hook per host in the user's files and none of ours in the container's or a
// project's, empty deny lists at both levels, other tools' hooks and keys, and Codex's hooks switch;
// the old templates, the old helper's copies and markers, the old injection state and the old
// portal launchers are in the device directory's backups and gone from where they were; the old
// workspaces' container and the platform archive are in no list and not touched. The plan writes
// nothing, a second run finds nothing, and a backup place already taken stops the plan and the
// apply before anything moves. Every home, device directory, container and project is temporary.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { CODEX_CONFIG_FILE, HOST_HOOK_FILES, isEinzbernHookCommand, isLegacyHookCommand } from "../dist/build/packages/core/src/host-hooks.js";
import {
  LEGACY_PORTAL_LAUNCHERS,
  LEGACY_TEMPLATE_DIRECTORIES,
  MIGRATE_CLEANUP_REASON_CODES,
  applyCleanup,
  cleanupRootKey,
  planCleanup,
} from "../dist/build/packages/core/src/migrate-cleanup.js";
import {
  LEGACY_CONTAINER_DIRECTORY,
  LEGACY_DEVICE_DIRECTORY,
  LEGACY_ENGINE_NAME,
  LEGACY_HELPER_NAME,
  LEGACY_INERT_SETTINGS_KEY,
  LEGACY_INJECTION_STATE_DIRECTORY,
  LOCAL_DIRECTORY_NAMES,
  PLATFORM_ARCHIVE_DIRECTORY,
} from "../dist/build/packages/core/src/names.js";
import { SetupRecorder } from "../dist/build/packages/core/src/setup-fresh.js";

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-migrate-cleanup-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

const AT = "2026-09-29T10:00:00Z";
const STAMP = "20260929T100000Z";
const CLAUDE = HOST_HOOK_FILES["claude-code"];
const CODEX = HOST_HOOK_FILES.codex;
const LEGACY_SKILL_ROOTS = [".claude/skills", ".agents/skills", ".codex/skills"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Relative path, size, mtime and sha256 of every entry under a directory. */
async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${entry.isFile() ? sha256(await readFile(path)) : entry.isDirectory() ? "directory" : "other"}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

/** Relative path and sha256 of every file under a directory: its content, wherever it now is. */
async function contentDigest(root) {
  return (await treeDigest(root)).map((row) => row.split("|")).map(([path, , , digest]) => `${path}|${digest}`);
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

// Other tools' hooks, which the cleanup keeps.
const OTHER_PROMPT = { hooks: [{ type: "command", command: "echo other-tool", timeout: 5 }] };
const OTHER_TOOL = { matcher: "Write", hooks: [{ type: "command", command: "prettier --write", timeout: 5 }] };
const OTHER_EVENT = { Notification: [{ hooks: [{ type: "command", command: "say done" }] }] };

// The Claude form of the old harness: guarded by the project directory, on seven events.
function claudeOldGroups() {
  const script = (name) => `\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/${name}`;
  const guarded = (name, extra = "") => `if [ -f "${script(name)}" ]; then node "${script(name)}"${extra}; fi`;
  const knowledge = guarded("scripts/knowledge-inject-hook.mjs", ' --container-root "${CLAUDE_PROJECT_DIR}" --host claude');
  return {
    Stop: [
      { hooks: [{ type: "command", command: guarded("tools/stop-pact/hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: guarded("scripts/knowledge-capture-hook.mjs", " --host claude"), timeout: 30 }] },
      { hooks: [{ type: "command", command: guarded("tools/stop-pact/response-style-hook.mjs"), timeout: 10 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: guarded("scripts/agents-zero-hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: knowledge, timeout: 30 }] },
    ],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guarded("scripts/ssh-write-observer.mjs") }] }],
    SessionStart: [{ hooks: [{ type: "command", command: knowledge, timeout: 30 }] }],
    SubagentStart: [
      { hooks: [{ type: "command", command: guarded("scripts/dispatch-telemetry-hook.mjs", " --host claude"), timeout: 10 }] },
      { hooks: [{ type: "command", command: knowledge, timeout: 30 }] },
    ],
    SubagentStop: [{ hooks: [{ type: "command", command: guarded("scripts/dispatch-telemetry-hook.mjs", " --host claude"), timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: knowledge, timeout: 30 }] }],
  };
}

// The Codex form of the old harness: absolute paths into the old engine copy, twelve commands.
function codexOldGroups(engine, container) {
  const node = (name, extra = "") => `node "${join(engine, name)}"${extra}`;
  const root = ` --container-root "${container}"`;
  const knowledge = node("scripts/knowledge-inject-hook.mjs", `${root} --host codex`);
  return {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: node("scripts/ssh-write-observer.mjs", root) }] },
      { matcher: "Edit|Write|apply_patch", hooks: [{ type: "command", command: node("scripts/chain-write-guard.mjs") }] },
    ],
    SessionStart: [{ hooks: [{ type: "command", command: knowledge, timeout: 30 }] }],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: knowledge, timeout: 30 }] },
      { hooks: [{ type: "command", command: node("scripts/agents-zero-hook.mjs", root), timeout: 10 }] },
    ],
    Stop: [
      { hooks: [{ type: "command", command: node("tools/stop-pact/codex-executor.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: node("scripts/knowledge-capture-hook.mjs", `${root} --host codex`), timeout: 30 }] },
      { hooks: [{ type: "command", command: node("tools/stop-pact/codex-response-style-hook.mjs"), timeout: 10 }] },
    ],
    SubagentStart: [
      { hooks: [{ type: "command", command: node("scripts/dispatch-telemetry-hook.mjs", `${root} --host codex`), timeout: 10 }] },
      { hooks: [{ type: "command", command: knowledge, timeout: 30 }] },
    ],
    SubagentStop: [{ hooks: [{ type: "command", command: node("scripts/dispatch-telemetry-hook.mjs", `${root} --host codex`), timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: knowledge, timeout: 30 }] }],
  };
}

// The rules the old harness wrote to fence its directories, in Claude Code's absolute form.
function fenced(directory) {
  return [`Edit(/${directory}/**)`, `Edit(/${directory}/.*)`, `Edit(/${directory}/**/.*)`, `Edit(/${directory}/.*/**)`, `Edit(/${directory}/**/.*/**)`];
}

// The trust states Codex keeps for every hook of a hooks document, one table each.
function trustStates(hooksPath, hooks) {
  const snake = (event) => event.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  const keys = Object.entries(hooks).flatMap(([event, groups]) => groups
    .flatMap((group, groupIndex) => group.hooks.map((_hook, hookIndex) => `${hooksPath}:${snake(event)}:${groupIndex}:${hookIndex}`)));
  return keys.map((key, index) => [`[hooks.state.${JSON.stringify(key)}]`, `trusted_hash = "sha256:${String(index).padStart(4, "0")}"`, ""]);
}

/** A temporary machine: a home, a device directory, a container with its old workspaces and archive, and one project in it. */
async function machine(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-migrate-cleanup-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const container = join(base, "container");
  const project = join(container, "alpha");
  const device = join(base, "device");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  // The old workspaces' container and the platform archive: never in any list.
  await writeTree(join(container, LEGACY_CONTAINER_DIRECTORY), { "cross-project/workspace/marker.txt": "old workspace\n" });
  await writeTree(join(container, PLATFORM_ARCHIVE_DIRECTORY), { "archive.txt": "platform archive\n" });
  return { base, home, container, project, device, legacyDevice: join(home, LEGACY_DEVICE_DIRECTORY) };
}

/** The old harness's host files at the user's, the container's and the project's level, and the Codex config trusting every old hook. */
async function oldHostFiles(m) {
  const oldEngine = join(m.legacyDevice, LEGACY_ENGINE_NAME);
  const userCodexHooks = join(m.home, CODEX);
  const containerCodexHooks = join(m.container, CODEX);
  const files = {
    userClaude: {
      env: { KEEP: "1" },
      permissions: { deny: [
        `Write(~/${LEGACY_DEVICE_DIRECTORY}/**)`,
        `Edit(~/${LEGACY_DEVICE_DIRECTORY}/**)`,
        ...fenced(join(m.container, LEGACY_CONTAINER_DIRECTORY)),
        ...fenced(m.legacyDevice),
      ] },
      hooks: {
        ...claudeOldGroups(),
        UserPromptSubmit: [...claudeOldGroups().UserPromptSubmit, OTHER_PROMPT],
        PreToolUse: [...claudeOldGroups().PreToolUse, OTHER_TOOL],
        ...OTHER_EVENT,
      },
      skipWorkflowUsageWarning: true,
    },
    containerClaude: {
      env: { CONTAINER: "1" },
      hooks: claudeOldGroups(),
      permissions: { deny: [
        ...fenced(join(m.container, LEGACY_CONTAINER_DIRECTORY)),
        ...fenced(m.legacyDevice),
        `Edit(~/${LEGACY_DEVICE_DIRECTORY}/**)`,
        `Edit(**/${LEGACY_DEVICE_DIRECTORY}/**)`,
        `Edit(**/${LEGACY_CONTAINER_DIRECTORY}/**)`,
      ] },
      [LEGACY_INERT_SETTINGS_KEY]: { activation: false, hostProduct: "claude-code" },
    },
    projectClaude: {
      hooks: { UserPromptSubmit: claudeOldGroups().UserPromptSubmit, Notification: OTHER_EVENT.Notification },
      permissions: { deny: [`Edit(**/${LEGACY_CONTAINER_DIRECTORY}/**)`], allow: ["Bash(ls:*)"] },
    },
    userCodex: { description: "the user's own hooks", hooks: { ...codexOldGroups(oldEngine, m.container), PreToolUse: [OTHER_TOOL, ...codexOldGroups(oldEngine, m.container).PreToolUse] } },
    containerCodex: { description: "the old platform harness", hooks: codexOldGroups(oldEngine, m.container) },
  };
  assert.equal(files.userClaude.permissions.deny.length, 12);
  assert.equal(files.containerClaude.permissions.deny.length, 13);
  assert.equal(Object.keys(claudeOldGroups()).length, 7, "seven events of old hook groups per level");
  assert.equal(hookCommands(files.containerCodex).length, 12, "the container's Codex file holds the twelve old commands");
  await writeJson(join(m.home, CLAUDE), files.userClaude);
  await writeJson(join(m.container, CLAUDE), files.containerClaude);
  await writeJson(join(m.project, CLAUDE), files.projectClaude);
  await writeJson(userCodexHooks, files.userCodex);
  await writeJson(containerCodexHooks, files.containerCodex);
  const configHead = ["# the user's own Codex settings", 'model = "gpt-test"', "", "[features]", "hooks = true", "", "[hooks.state]", ""];
  const userStates = trustStates(userCodexHooks, files.userCodex.hooks);
  const containerStates = trustStates(containerCodexHooks, files.containerCodex.hooks);
  await writeFile(join(m.home, CODEX_CONFIG_FILE), [...configHead, ...userStates.flat(), ...containerStates.flat()].join("\n"));
  return { files, configHead, userStates };
}

/** The old installation's other leftovers: templates, the old helper's copies and markers, the injection state and the portal launchers. */
async function oldLeftovers(m) {
  const templates = {};
  for (const root of [m.home, m.container, m.project]) {
    for (const template of LEGACY_TEMPLATE_DIRECTORIES) {
      if (root === m.project && template.startsWith(".codex")) continue;
      const path = join(root, ...template.split("/"));
      await writeTree(path, { "bootstrap.json": "{\"template\":\"bootstrap\"}\n", "stop.json": "{\"template\":\"stop\"}\n" });
      templates[path] = await contentDigest(path);
    }
  }
  for (const root of LEGACY_SKILL_ROOTS) await writeTree(join(m.home, ...root.split("/"), LEGACY_HELPER_NAME), { "SKILL.md": "legacy helper\n" });
  const markers = {
    "complete-skill-archive.provenance.json": "{}\n",
    "installed-copy-claude.json": "{}\n",
    "installed-copy-agents.json": "{}\n",
    "skill-archive.json": "{}\n",
    "state.json": "{}\n",
    "trusted-bootstrap.mjs": "export {};\n",
  };
  // What stays in the old device directory: the old engine copy, its archive and its settings.
  const kept = {
    [`${LEGACY_ENGINE_NAME}/scripts/${LEGACY_ENGINE_NAME}.mjs`]: "export {};\n",
    "attestations/key.json": "{}\n",
    "machine-settings.json": "{}\n",
  };
  await writeTree(m.legacyDevice, { ...markers, ...kept });
  await writeTree(join(m.home, LEGACY_INJECTION_STATE_DIRECTORY), { "state.json": "{\"decisions\":[]}\n" });
  for (const name of LEGACY_PORTAL_LAUNCHERS) await writeFile(join(m.container, name), "#!/bin/sh\n");
  return { templates, markers, kept };
}

function cleanupInput(m, extra = {}) {
  return { home: m.home, deviceHome: m.device, legacyDeviceHome: m.legacyDevice, projectRoots: [m.container, m.project, m.container], navigation: "written", ...extra };
}

function launcherCommand(device) {
  return `node "${join(device, "engine", "hook.mjs")}" user-prompt-submit`;
}

test("489-R3, AC2 (fixture): after the cleanup each host's user file holds one Einzbern UserPromptSubmit hook, the container's and a project's hold none of ours, and neither level keeps a deny rule", async (context) => {
  const m = await machine(context);
  const { files, configHead, userStates } = await oldHostFiles(m);
  const originals = new Map();
  for (const path of [join(m.home, CLAUDE), join(m.home, CODEX), join(m.home, CODEX_CONFIG_FILE), join(m.container, CLAUDE), join(m.container, CODEX), join(m.project, CLAUDE)]) {
    originals.set(path, await readFile(path, "utf8"));
  }

  // The plan writes nothing and lists each file it updates, in the order the apply takes them.
  const before = await treeDigest(m.base);
  const planRecorder = new SetupRecorder(m.device, AT);
  const planned = await planCleanup(planRecorder, cleanupInput(m));
  assert.deepEqual(await treeDigest(m.base), before, "the plan wrote nothing");
  const hostBackups = join(m.device, "backups", STAMP, "host-hooks");
  const expectedItems = [
    [join(m.home, CLAUDE), join(hostBackups, cleanupRootKey(m.home), CLAUDE)],
    [join(m.home, CODEX), join(hostBackups, cleanupRootKey(m.home), CODEX)],
    [join(m.home, CODEX_CONFIG_FILE), join(hostBackups, cleanupRootKey(m.home), CODEX_CONFIG_FILE)],
    [join(m.container, CLAUDE), join(hostBackups, cleanupRootKey(m.container), CLAUDE)],
    [join(m.container, CODEX), join(hostBackups, cleanupRootKey(m.container), CODEX)],
    [join(m.project, CLAUDE), join(hostBackups, cleanupRootKey(m.project), CLAUDE)],
  ];
  assert.deepEqual(planned.map((item) => [item.kind, item.action, item.path, item.into]), expectedItems.map(([path, into]) => ["host-file", "update", path, into]));
  assert.deepEqual(planRecorder.writes.map((entry) => [entry.step, entry.path, entry.action]), expectedItems.map(([path]) => ["host-hooks", path, "update"]));
  assert.deepEqual(planRecorder.backups.map((entry) => [entry.path, entry.into]), expectedItems.map(([path]) => [path, hostBackups]));
  assert.deepEqual(planRecorder.blockers, []);

  const recorder = new SetupRecorder(m.device, AT);
  const applied = await applyCleanup(recorder, { ...cleanupInput(m), at: AT });
  assert.deepEqual(applied, planned, "the apply did what the plan listed");
  assert.deepEqual(recorder.writes, planRecorder.writes);

  // AC2: each user file holds exactly one Einzbern hook, on UserPromptSubmit, and nothing old.
  const userClaude = await readJson(join(m.home, CLAUDE));
  const userCodex = await readJson(join(m.home, CODEX));
  for (const [label, document] of [["claude", userClaude], ["codex", userCodex]]) {
    assert.deepEqual(hookCommands(document).filter((hook) => isEinzbernHookCommand(hook.command)), [{ event: "UserPromptSubmit", command: launcherCommand(m.device) }], label);
    assert.deepEqual(hookCommands(document).filter((hook) => isLegacyHookCommand(hook.command)), [], label);
  }
  // Other tools' hooks and every other key stay.
  const einzbern = { hooks: [{ type: "command", command: launcherCommand(m.device) }] };
  assert.deepEqual(userClaude, {
    env: files.userClaude.env,
    permissions: { deny: [] },
    hooks: { UserPromptSubmit: [einzbern, OTHER_PROMPT], PreToolUse: [OTHER_TOOL], ...OTHER_EVENT },
    skipWorkflowUsageWarning: true,
  });
  assert.deepEqual(userCodex, { description: "the user's own hooks", hooks: { PreToolUse: [OTHER_TOOL], UserPromptSubmit: [einzbern] } });
  // The container and the project keep nothing of ours and everything else.
  assert.deepEqual(await readJson(join(m.container, CLAUDE)), { env: { CONTAINER: "1" }, hooks: {}, permissions: { deny: [] } });
  assert.deepEqual(await readJson(join(m.container, CODEX)), { description: "the old platform harness", hooks: {} });
  assert.deepEqual(await readJson(join(m.project, CLAUDE)), { hooks: { ...OTHER_EVENT }, permissions: { deny: [], allow: ["Bash(ls:*)"] } });
  // Codex's switch stays on; only the trust state of the other tool's unchanged hook stays.
  const kept = userStates[0];
  assert.match(kept[0], /:pre_tool_use:0:0"\]$/u);
  assert.equal(await readFile(join(m.home, CODEX_CONFIG_FILE), "utf8"), [...configHead, ...kept].join("\n"));
  // The originals are in the backups, byte for byte, where the items say.
  for (const [path, into] of expectedItems) assert.equal(await readFile(into, "utf8"), originals.get(path), path);

  // A second run finds nothing to clean and writes nothing.
  const settled = await treeDigest(m.base);
  const again = new SetupRecorder(m.device, "2026-09-29T11:00:00Z");
  assert.deepEqual(await planCleanup(again, cleanupInput(m)), []);
  assert.deepEqual([again.writes, again.backups, again.blockers], [[], [], []]);
  assert.deepEqual(await applyCleanup(again, { ...cleanupInput(m), at: "2026-09-29T11:00:00Z" }), []);
  assert.deepEqual(await treeDigest(m.base), settled);
});

test("489-R3, R4 (fixture): templates, the old helper's copies and markers, the injection state and the old launchers move whole into the backups; the old workspaces' container and the archive stay", async (context) => {
  const m = await machine(context);
  const { templates, markers, kept } = await oldLeftovers(m);
  const oldContainer = await treeDigest(join(m.container, LEGACY_CONTAINER_DIRECTORY));
  const archive = await treeDigest(join(m.container, PLATFORM_ARCHIVE_DIRECTORY));
  const contents = new Map();
  const moved = [
    ...Object.keys(templates),
    join(m.home, LEGACY_INJECTION_STATE_DIRECTORY),
    ...LEGACY_PORTAL_LAUNCHERS.map((name) => join(m.container, name)),
    ...LEGACY_SKILL_ROOTS.map((root) => join(m.home, ...root.split("/"), LEGACY_HELPER_NAME)),
    ...Object.keys(markers).sort().map((name) => join(m.legacyDevice, name)),
  ];
  for (const path of moved) contents.set(path, (await lstat(path)).isDirectory() ? await contentDigest(path) : sha256(await readFile(path)));

  const before = await treeDigest(m.base);
  const planRecorder = new SetupRecorder(m.device, AT);
  const planned = await planCleanup(planRecorder, cleanupInput(m));
  assert.deepEqual(await treeDigest(m.base), before, "the plan wrote nothing");
  const backups = join(m.device, "backups", STAMP);
  const template = (root, name) => [join(root, ...name.split("/")), join(backups, "host-hooks", cleanupRootKey(root), ...name.split("/"))];
  const expected = [
    ["template", ...template(m.home, LEGACY_TEMPLATE_DIRECTORIES[0])],
    ["template", ...template(m.home, LEGACY_TEMPLATE_DIRECTORIES[1])],
    ["template", ...template(m.container, LEGACY_TEMPLATE_DIRECTORIES[0])],
    ["template", ...template(m.container, LEGACY_TEMPLATE_DIRECTORIES[1])],
    ["template", ...template(m.project, LEGACY_TEMPLATE_DIRECTORIES[0])],
    ["injection-state", join(m.home, LEGACY_INJECTION_STATE_DIRECTORY), join(backups, "host-hooks", cleanupRootKey(m.home), LEGACY_INJECTION_STATE_DIRECTORY)],
    ...LEGACY_PORTAL_LAUNCHERS.map((name) => ["launcher", join(m.container, name), join(backups, "launchers", cleanupRootKey(m.container), name)]),
    ...LEGACY_SKILL_ROOTS.map((root) => ["skill-copy", join(m.home, ...root.split("/"), LEGACY_HELPER_NAME), join(backups, "skill-copies", ...root.split("/"), LEGACY_HELPER_NAME)]),
    ...Object.keys(markers).sort().map((name) => ["marker", join(m.legacyDevice, name), join(backups, "skill-copies", LEGACY_DEVICE_DIRECTORY, name)]),
  ];
  assert.deepEqual(planned.map((item) => [item.kind, item.path, item.into]), expected);
  assert.ok(planned.every((item) => item.action === "move"));
  const stepOf = { template: "host-hooks", "injection-state": "host-hooks", launcher: "launchers", "skill-copy": "skill-copies", marker: "skill-copies" };
  assert.deepEqual(planRecorder.writes.map((entry) => [entry.step, entry.path, entry.action]), expected.map(([kind, path]) => [stepOf[kind], path, "move"]));
  assert.deepEqual(planRecorder.backups.map((entry) => entry.into), expected.map(([kind]) => join(backups, stepOf[kind])));
  assert.deepEqual(planRecorder.blockers, []);
  // The old workspaces' container, the archive and the old device directory are in no list.
  for (const excluded of [join(m.container, LEGACY_CONTAINER_DIRECTORY), join(m.container, PLATFORM_ARCHIVE_DIRECTORY), m.legacyDevice]) {
    assert.equal(planned.some((item) => item.path === excluded), false, excluded);
  }

  const recorder = new SetupRecorder(m.device, AT);
  const applied = await applyCleanup(recorder, { ...cleanupInput(m), at: AT });
  assert.deepEqual(applied, planned, "the apply moved what the plan listed");
  for (const [, path, into] of expected) {
    assert.equal(await exists(path), false, `${path} is no longer where it was`);
    const moved = (await lstat(into)).isDirectory() ? await contentDigest(into) : sha256(await readFile(into));
    assert.deepEqual(moved, contents.get(path), `${into} holds what ${path} held`);
  }
  assert.deepEqual(await treeDigest(join(m.container, LEGACY_CONTAINER_DIRECTORY)), oldContainer, "the old workspaces' container is untouched");
  assert.deepEqual(await treeDigest(join(m.container, PLATFORM_ARCHIVE_DIRECTORY)), archive, "the platform archive is untouched");
  const legacyDevice = (await contentDigest(m.legacyDevice)).filter((row) => !row.endsWith("|directory")).map((row) => row.split("|")[0]).sort();
  assert.deepEqual(legacyDevice, Object.keys(kept).sort(), "the old device directory keeps its old engine, archive and settings");

  // A second run finds nothing.
  const again = new SetupRecorder(m.device, "2026-09-29T11:00:00Z");
  assert.deepEqual(await planCleanup(again, cleanupInput(m)), []);
  assert.deepEqual(await applyCleanup(again, { ...cleanupInput(m), at: "2026-09-29T11:00:00Z" }), []);
  assert.deepEqual(again.writes, []);
});

test("489-R3: a backup is never overwritten: a taken backup place stops the plan and the apply before anything moves", async (context) => {
  const m = await machine(context);
  await oldLeftovers(m);
  await oldHostFiles(m);
  const backups = join(m.device, "backups", STAMP);
  // One launcher's backup place and one marker's are already taken by an earlier run in the same second.
  await writeTree(join(backups, "launchers", cleanupRootKey(m.container)), { [LEGACY_PORTAL_LAUNCHERS[0]]: "an earlier backup\n" });
  await writeTree(join(backups, "skill-copies", LEGACY_DEVICE_DIRECTORY), { "state.json": "an earlier backup\n" });
  const before = await treeDigest(m.base);

  const planRecorder = new SetupRecorder(m.device, AT);
  await planCleanup(planRecorder, cleanupInput(m));
  assert.deepEqual(planRecorder.blockers.map((entry) => [entry.step, entry.path, entry.reasonCode]), [
    ["launchers", join(m.container, LEGACY_PORTAL_LAUNCHERS[0]), "MIGRATE_CLEANUP_BACKUP_EXISTS"],
    ["skill-copies", join(m.legacyDevice, "state.json"), "LEGACY_SKILL_CLEANUP_BACKUP_EXISTS"],
  ]);
  assert.ok(MIGRATE_CLEANUP_REASON_CODES.includes(planRecorder.blockers[0].reasonCode));

  // The apply checks every move before it writes anything: a plan that raced the earlier backup
  // stops with nothing moved and no host file rendered.
  const recorder = new SetupRecorder(m.device, AT);
  await assert.rejects(applyCleanup(recorder, { ...cleanupInput(m), at: AT }), (error) => {
    assert.deepEqual([error.reasonCode, error.details.path], ["MIGRATE_CLEANUP_BACKUP_EXISTS", join(m.container, LEGACY_PORTAL_LAUNCHERS[0])]);
    return true;
  });
  assert.deepEqual(await treeDigest(m.base), before, "nothing was written");
  assert.deepEqual(recorder.writes, []);
});

test("489-R3: a project host file host-hooks.ts will not render stops the plan; the user's is left to the wiring, which plans the same file", async (context) => {
  const m = await machine(context);
  await writeJson(join(m.base, "shared-settings.json"), { hooks: claudeOldGroups() });
  await mkdir(join(m.container, ".claude"), { recursive: true });
  await symlink(join(m.base, "shared-settings.json"), join(m.container, CLAUDE));
  await mkdir(join(m.home, ".claude"), { recursive: true });
  await symlink(join(m.base, "shared-settings.json"), join(m.home, CLAUDE));

  const recorder = new SetupRecorder(m.device, AT);
  const planned = await planCleanup(recorder, cleanupInput(m));
  assert.deepEqual(planned, []);
  assert.deepEqual(recorder.blockers.map((entry) => [entry.step, entry.path, entry.reasonCode]), [["host-hooks", join(m.container, CLAUDE), "HOST_HOOKS_FILE_UNSUPPORTED"]]);
  assert.equal((await stat(join(m.base, "shared-settings.json"))).isFile(), true);
});

test("489-R3 (TCRN-CROSS-STORY-478 R4): with navigation declined the user's files are rendered with the two pointer hooks as well", async (context) => {
  const m = await machine(context);
  await oldHostFiles(m);
  const recorder = new SetupRecorder(m.device, AT);
  await applyCleanup(recorder, { ...cleanupInput(m, { navigation: "declined" }), at: AT });
  for (const file of [CLAUDE, CODEX]) {
    const ours = hookCommands(await readJson(join(m.home, file))).filter((hook) => isEinzbernHookCommand(hook.command));
    assert.deepEqual(ours.map((hook) => hook.event).sort(), ["SessionStart", "SubagentStart", "UserPromptSubmit"], file);
  }
  assert.deepEqual(hookCommands(await readJson(join(m.container, CLAUDE))), []);
});
