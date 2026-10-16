// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R3, R4, R5; AC1 and AC4 (the mechanism) (MIN-227 D4, D5): a host's hook
// file carries exactly one Einzbern hook group, on UserPromptSubmit, whose one command runs the
// stable launcher in the device directory. Rendering keeps other tools' hooks and every other key;
// it takes out the old platform harness's hooks, the permissions.deny rules that fenced the old
// directories and the old inert key, keeps Codex's hooks switch on and drops the trust states of
// hooks that are gone. Everything here is temporary: a home, a device directory and a container
// shaped like this platform's live files before the move (seven events of old hook groups at each
// level, twelve Codex commands, other tools' hooks, twelve and thirteen deny rules, the inert key).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_CONFIG_FILE,
  HOST_HOOK_FILES,
  applyHostHooks,
  codexHookConfig,
  hookLauncherPath,
  isEinzbernHookCommand,
  isLegacyDenyRule,
  isLegacyHookCommand,
  mergeHostHooks,
  planHostHooks,
  readHostHooks,
} from "../dist/build/packages/core/src/host-hooks.js";
import {
  DIRECTORY,
  LEGACY_CONTAINER_DIRECTORY,
  LEGACY_DEVICE_DIRECTORY,
  LEGACY_ENGINE_NAME,
  LEGACY_INERT_SETTINGS_KEY,
  LOCAL_DIRECTORY_NAMES,
} from "../dist/build/packages/core/src/names.js";

const AT = "2026-09-26T10:00:00Z";
const STAMP = "20260926T100000Z";
const CLAUDE = HOST_HOOK_FILES["claude-code"];
const CODEX = HOST_HOOK_FILES.codex;

async function scratch(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-host-hooks-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const container = join(base, "container");
  await mkdir(home, { recursive: true });
  await mkdir(container, { recursive: true });
  return { base, home, container, device: join(home, DIRECTORY.device) };
}

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function hookCommands(document) {
  return Object.entries(document.hooks ?? {}).flatMap(([event, groups]) => groups
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => ({ event, command: hook.command })));
}

function launcherCommand(device) {
  return `node "${join(device, "engine", "hook.mjs")}" user-prompt-submit`;
}

// Other tools' hooks, which every render keeps.
const OTHER_PROMPT = { hooks: [{ type: "command", command: "echo other-tool", timeout: 5 }] };
const OTHER_TOOL = { matcher: "Write", hooks: [{ type: "command", command: "prettier --write", timeout: 5 }] };
const OTHER_EVENT = { Notification: [{ hooks: [{ type: "command", command: "say done" }] }] };

// The Claude form of the old harness: guarded by the project directory, seven events.
function claudeOldGroups() {
  const script = (name) => `\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/${name}`;
  const guarded = (name, extra = "") => `if [ -f "${script(name)}" ]; then node "${script(name)}"${extra}; fi`;
  const knowledge = guarded("scripts/knowledge-inject-hook.mjs", ' --container-root "${CLAUDE_PROJECT_DIR}" --host claude');
  return {
    Stop: [
      { hooks: [{ type: "command", command: guarded("tools/stop-pact/hook.mjs"), timeout: 10 }] },
      { hooks: [{ type: "command", command: guarded("scripts/knowledge-capture-hook.mjs", ' --container-root "${CLAUDE_PROJECT_DIR}" --host claude'), timeout: 30 }] },
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

function userDenyRules(home, container) {
  return [
    `Write(~/${LEGACY_DEVICE_DIRECTORY}/**)`,
    `Edit(~/${LEGACY_DEVICE_DIRECTORY}/**)`,
    ...fenced(join(container, LEGACY_CONTAINER_DIRECTORY)),
    ...fenced(join(home, LEGACY_DEVICE_DIRECTORY)),
  ];
}

function containerDenyRules(home, container) {
  return [
    ...fenced(join(container, LEGACY_CONTAINER_DIRECTORY)),
    ...fenced(join(home, LEGACY_DEVICE_DIRECTORY)),
    `Edit(~/${LEGACY_DEVICE_DIRECTORY}/**)`,
    `Edit(**/${LEGACY_DEVICE_DIRECTORY}/**)`,
    `Edit(**/${LEGACY_CONTAINER_DIRECTORY}/**)`,
  ];
}

// The trust states Codex keeps for every hook of a hooks document, one table each.
function trustStates(hooksPath, hooks) {
  const snake = (event) => event.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  const keys = Object.entries(hooks).flatMap(([event, groups]) => groups
    .flatMap((group, groupIndex) => group.hooks.map((_hook, hookIndex) => `${hooksPath}:${snake(event)}:${groupIndex}:${hookIndex}`)));
  return keys.map((key, index) => [`[hooks.state.${JSON.stringify(key)}]`, `trusted_hash = "sha256:${String(index).padStart(4, "0")}"`, ""]);
}

async function render(host, scope, root, home, device, options = {}) {
  const plan = await readHostHooks(planHostHooks({ host, scope, deviceHome: device, ...options }), { root, home });
  return { plan, applied: await applyHostHooks(plan, { at: AT }) };
}

test("477-AC1, AC4: after the move each host's user file holds one Einzbern UserPromptSubmit hook, the container holds none, and neither level keeps an old deny rule", async (t) => {
  const { home, container, device } = await scratch(t);
  const oldEngine = join(home, LEGACY_DEVICE_DIRECTORY, LEGACY_ENGINE_NAME);
  const userCodexHooks = join(home, CODEX);
  const containerCodexHooks = join(container, CODEX);

  const userClaude = {
    env: { KEEP: "1" },
    permissions: { deny: userDenyRules(home, container) },
    hooks: {
      ...claudeOldGroups(),
      UserPromptSubmit: [...claudeOldGroups().UserPromptSubmit, OTHER_PROMPT],
      PreToolUse: [...claudeOldGroups().PreToolUse, OTHER_TOOL],
      ...OTHER_EVENT,
    },
    skipWorkflowUsageWarning: true,
  };
  const containerClaude = {
    env: { CONTAINER: "1" },
    hooks: claudeOldGroups(),
    permissions: { deny: containerDenyRules(home, container) },
    [LEGACY_INERT_SETTINGS_KEY]: { activation: false, hostProduct: "claude-code" },
  };
  const oldCodex = codexOldGroups(oldEngine, container);
  const userCodex = { description: "the user's own hooks", hooks: { ...oldCodex, PreToolUse: [OTHER_TOOL, ...oldCodex.PreToolUse] } };
  const containerCodex = { description: "the old platform harness", hooks: oldCodex };
  assert.equal(hookCommands(containerCodex).length, 12, "the container's Codex file holds the twelve old commands");
  assert.equal(containerClaude.permissions.deny.length, 13);
  assert.equal(userClaude.permissions.deny.length, 12);
  assert.equal(Object.keys(claudeOldGroups()).length, 7, "seven events of old hook groups per level");

  const configHead = ["# the user's own Codex settings", 'model = "gpt-test"', "", "[features]", "hooks = true", "", `[projects.${JSON.stringify(container)}]`, 'trust_level = "trusted"', "", "[hooks.state]", ""];
  const userStates = trustStates(userCodexHooks, userCodex.hooks);
  const containerStates = trustStates(containerCodexHooks, containerCodex.hooks);
  const configBefore = [...configHead, ...userStates.flat(), ...containerStates.flat()].join("\n");
  await writeJson(join(home, CLAUDE), userClaude);
  await writeJson(join(container, CLAUDE), containerClaude);
  await writeJson(userCodexHooks, userCodex);
  await writeJson(containerCodexHooks, containerCodex);
  await writeFile(join(home, CODEX_CONFIG_FILE), configBefore);
  const before = {
    userClaude: await readFile(join(home, CLAUDE), "utf8"),
    containerClaude: await readFile(join(container, CLAUDE), "utf8"),
    userCodex: await readFile(userCodexHooks, "utf8"),
    config: configBefore,
  };

  // Installing: the user's files get the hook, the container's are only cleaned.
  for (const host of ["claude-code", "codex"]) {
    const { plan, applied } = await render(host, "user", home, home, device);
    assert.equal(applied.reasonCode, "HOST_HOOKS_WRITTEN", host);
    assert.ok(plan.removedHooks.length > 0, `${host}: the old hooks are listed as removed`);
    const cleaned = await render(host, "project", container, home, device, { install: false });
    assert.equal(cleaned.applied.reasonCode, "HOST_HOOKS_WRITTEN", `${host} container`);
  }

  // AC1: each user file holds exactly one Einzbern hook, on UserPromptSubmit, and nothing of the old harness.
  const claude = await readJson(join(home, CLAUDE));
  const codex = await readJson(userCodexHooks);
  for (const [label, document] of [["claude", claude], ["codex", codex]]) {
    const ours = hookCommands(document).filter((hook) => isEinzbernHookCommand(hook.command));
    assert.deepEqual(ours, [{ event: "UserPromptSubmit", command: launcherCommand(device) }], `${label}: one Einzbern hook`);
    assert.deepEqual(hookCommands(document).filter((hook) => isLegacyHookCommand(hook.command)), [], `${label}: no old hook`);
  }
  // Other tools' hooks and the rest of each file stay, in their order.
  assert.deepEqual(claude.hooks, {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: launcherCommand(device) }] }, OTHER_PROMPT],
    PreToolUse: [OTHER_TOOL],
    ...OTHER_EVENT,
  });
  assert.deepEqual(claude.env, { KEEP: "1" });
  assert.equal(claude.skipWorkflowUsageWarning, true);
  assert.deepEqual(codex, {
    description: "the user's own hooks",
    hooks: { PreToolUse: [OTHER_TOOL], UserPromptSubmit: [{ hooks: [{ type: "command", command: launcherCommand(device) }] }] },
  });

  // The container keeps no hook of ours, old or new, and keeps everything else.
  const containerClaudeAfter = await readJson(join(container, CLAUDE));
  assert.deepEqual(containerClaudeAfter, { env: { CONTAINER: "1" }, hooks: {}, permissions: { deny: [] } }, "old hooks, all thirteen deny rules and the inert key are gone");
  assert.deepEqual(await readJson(containerCodexHooks), { description: "the old platform harness", hooks: {} });

  // AC4: both levels' permissions.deny are empty.
  assert.deepEqual(claude.permissions, { deny: [] });
  assert.deepEqual(containerClaudeAfter.permissions, { deny: [] });

  // Codex's config keeps its switch and the one trust state whose hook did not change (the other
  // tool's PreToolUse hook at position 0); every trust state of a removed or replaced hook is gone,
  // and every other byte stays.
  const kept = userStates[0];
  assert.match(kept[0], /:pre_tool_use:0:0"\]$/u);
  assert.equal(await readFile(join(home, CODEX_CONFIG_FILE), "utf8"), [...configHead, ...kept].join("\n"));

  // The originals went to the device directory first, byte for byte.
  const backups = join(device, "backups", STAMP, "host-hooks");
  const roots = await readdir(backups);
  assert.equal(roots.length, 2, "one directory for the home and one for the container");
  const copies = new Map();
  for (const root of roots) {
    for (const name of [CLAUDE, CODEX, CODEX_CONFIG_FILE]) {
      const copy = await readFile(join(backups, root, name), "utf8").catch(() => null);
      if (copy !== null) copies.set(`${root}/${name}`, copy);
    }
  }
  const backedUp = [...copies.values()];
  for (const original of [before.userClaude, before.containerClaude, before.userCodex, before.config]) {
    assert.ok(backedUp.includes(original), "each replaced original is in the backups");
  }

  // Rendering again changes nothing.
  for (const host of ["claude-code", "codex"]) {
    const again = await render(host, "user", home, home, device);
    assert.deepEqual([again.applied.reasonCode, again.applied.backupDir], ["HOST_HOOKS_CURRENT", null], `${host} user`);
    assert.deepEqual(again.plan.removedHooks, []);
    const cleanAgain = await render(host, "project", container, home, device, { install: false });
    assert.equal(cleanAgain.applied.reasonCode, "HOST_HOOKS_CURRENT", `${host} container`);
  }
});

test("477-R5: the command is node, the quoted launcher path and one word, on macOS, Linux and Windows", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    const expected = planHostHooks({ host: "claude-code", scope: "user", deviceHome: "/srv/einzbern device", platform });
    assert.equal(expected.groups.UserPromptSubmit[0].hooks[0].command, 'node "/srv/einzbern device/engine/hook.mjs" user-prompt-submit');
  }
  for (const deviceHome of ["D:\\Einzbern\\device", "D:/Einzbern/device"]) {
    const expected = planHostHooks({ host: "codex", scope: "user", deviceHome, platform: "win32" });
    assert.equal(expected.groups.UserPromptSubmit[0].hooks[0].command, 'node "D:\\Einzbern\\device\\engine\\hook.mjs" user-prompt-submit');
  }
  for (const platform of ["darwin", "linux", "win32"]) {
    const deviceHome = platform === "win32" ? "D:\\Einzbern\\device" : "/srv/einzbern/device";
    for (const host of ["claude-code", "codex"]) {
      const [group] = planHostHooks({ host, scope: "user", deviceHome, platform }).groups.UserPromptSubmit;
      const { command } = group.hooks[0];
      assert.match(command, /^node "[^"$`%]+" user-prompt-submit$/u, `${platform}/${host}: one quoted path and a word`);
      for (const shell of ["if [", "; fi", "&&", "||", "|", "${", "$(", "--container-root", "--host", "CLAUDE_PROJECT_DIR"]) {
        assert.equal(command.includes(shell), false, `${platform}/${host}: no ${shell}`);
      }
    }
  }

  // A launcher path a shell would read inside the quotes, or a relative one, is refused.
  const refused = [
    ["relative/device", "darwin"],
    ["/srv/$HOME/device", "linux"],
    ["/srv/`id`/device", "linux"],
    ['/srv/"quoted"/device', "darwin"],
    ["/srv/back\\slash", "darwin"],
    ["D:\\%USERPROFILE%\\device", "win32"],
    ["\\\\server\\share\\device", "win32"],
    ["device", "win32"],
  ];
  for (const [deviceHome, platform] of refused) {
    assert.throws(() => hookLauncherPath(deviceHome, platform), (error) => error?.reasonCode === "HOST_HOOKS_PATH_UNSUPPORTED", `${platform}: ${deviceHome}`);
  }

  // On this machine the line runs as written, through the shell a host hands it to, even with a
  // space and a non-ASCII character in the device directory.
  if (process.platform !== "win32") {
    const { base } = await scratch(t);
    const device = join(base, "device dir 设备");
    const launcher = hookLauncherPath(device);
    await mkdir(join(launcher, ".."), { recursive: true });
    await writeFile(launcher, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const [group] = planHostHooks({ host: "claude-code", scope: "user", deviceHome: device }).groups.UserPromptSubmit;
    const { command } = group.hooks[0];
    assert.equal(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }), '["user-prompt-submit"]');
    const viaShell = spawnSync(command, { shell: true, encoding: "utf8" });
    assert.deepEqual([viaShell.status, viaShell.stdout], [0, '["user-prompt-submit"]']);
  }
});

test("477-R1, R3: only UserPromptSubmit is rendered, the same for both hosts, and a clean-only plan renders nothing", () => {
  const deviceHome = "/srv/einzbern/device";
  const claude = planHostHooks({ host: "claude-code", scope: "user", deviceHome, platform: "linux" });
  const codex = planHostHooks({ host: "codex", scope: "project", deviceHome, platform: "linux" });
  assert.deepEqual(Object.keys(claude.groups), ["UserPromptSubmit"]);
  assert.deepEqual(codex.groups, claude.groups);
  assert.deepEqual([claude.hooksFile, claude.configFile, codex.hooksFile, codex.configFile], [CLAUDE, null, CODEX, CODEX_CONFIG_FILE]);
  assert.deepEqual(mergeHostHooks(null, claude).document, { hooks: claude.groups });
  const clean = planHostHooks({ host: "claude-code", scope: "project", deviceHome, platform: "linux", install: false });
  assert.deepEqual(clean.groups, {});
  assert.deepEqual(mergeHostHooks(null, clean).document, {});
  assert.throws(() => planHostHooks({ host: "cursor", scope: "user", deviceHome }), (error) => error?.reasonCode === "HOST_HOOKS_INPUT_INVALID");
  // TCRN-CROSS-STORY-548 R1, AC1: DSH is a host the hook runs under, but no hook file is planned for it.
  for (const scope of ["user", "project"]) {
    assert.throws(() => planHostHooks({ host: "dsh", scope, deviceHome }), (error) => error?.reasonCode === "HOST_HOOKS_HOST_NOT_FILE_BASED" && error.details.host === "dsh");
  }
  assert.equal(Object.hasOwn(HOST_HOOK_FILES, "dsh"), false, "no hook file is named for DSH");
  assert.throws(() => planHostHooks({ host: "codex", scope: "machine", deviceHome }), (error) => error?.reasonCode === "HOST_HOOKS_INPUT_INVALID");
});

test("477-R3: another tool's hook sharing a group with an old hook stays in its group, and a moved device directory is replaced in place", () => {
  const deviceHome = "/srv/einzbern/device";
  const expected = planHostHooks({ host: "codex", scope: "user", deviceHome, platform: "linux" });
  const mixed = {
    matcher: "startup",
    hooks: [
      { type: "command", command: 'node "/opt/old/tcrn-workflow/scripts/knowledge-inject-hook.mjs" --host codex' },
      { type: "command", command: "echo mine" },
    ],
  };
  const moved = { hooks: [{ type: "command", command: 'node "/opt/elsewhere/engine/hook.mjs" user-prompt-submit', timeout: 30 }] };
  const merged = mergeHostHooks({ hooks: { SessionStart: [mixed], UserPromptSubmit: [OTHER_PROMPT, moved, OTHER_TOOL] } }, expected);
  assert.deepEqual(merged.document.hooks.SessionStart, [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }]);
  assert.deepEqual(merged.document.hooks.UserPromptSubmit, [OTHER_PROMPT, ...expected.groups.UserPromptSubmit, OTHER_TOOL], "the new group takes the old one's place");
  assert.deepEqual(merged.removedHooks.map((hook) => hook.event), ["SessionStart", "UserPromptSubmit"]);
  const again = mergeHostHooks(merged.document, expected);
  assert.deepEqual([again.document, again.removedHooks], [merged.document, []], "merging again changes nothing and lists nothing");

  // Two copies of the Einzbern group become one.
  const doubled = mergeHostHooks({ hooks: { UserPromptSubmit: [...expected.groups.UserPromptSubmit, ...expected.groups.UserPromptSubmit] } }, expected);
  assert.deepEqual(doubled.document.hooks.UserPromptSubmit, expected.groups.UserPromptSubmit);
  assert.equal(doubled.removedHooks.length, 1);
});

test("477-R4: only the deny rules that fence the old directories go, and a user's own rules stay", () => {
  const deviceHome = "/srv/einzbern/device";
  const expected = planHostHooks({ host: "claude-code", scope: "user", deviceHome, platform: "linux" });
  const own = ["Read(./secrets/**)", "Bash(curl:*)", "Edit(/srv/project-tcrn-workspace-notes/**)"];
  const old = [`Edit(//srv/c/${LEGACY_CONTAINER_DIRECTORY}/**)`, `Write(~/${LEGACY_DEVICE_DIRECTORY}/**)`, `Edit(**/${LEGACY_DEVICE_DIRECTORY}/**)`, `Edit(D:\\c\\${LEGACY_CONTAINER_DIRECTORY}\\**)`];
  for (const rule of old) assert.equal(isLegacyDenyRule(rule), true, rule);
  for (const rule of own) assert.equal(isLegacyDenyRule(rule), false, rule);
  const merged = mergeHostHooks({ permissions: { allow: ["Read(/**)"], deny: [...old.slice(0, 2), ...own, ...old.slice(2)] } }, expected);
  assert.deepEqual(merged.document.permissions, { allow: ["Read(/**)"], deny: own });
  assert.deepEqual(merged.removedDenyRules, old);
  assert.deepEqual(mergeHostHooks({ permissions: { deny: old } }, expected).document.permissions, { deny: [] }, "an emptied list stays, empty");
  // Codex's hooks file has no permissions of Claude's shape; nothing there is read as a rule.
  const codex = planHostHooks({ host: "codex", scope: "user", deviceHome, platform: "linux" });
  assert.deepEqual(mergeHostHooks({ permissions: { deny: old } }, codex).document.permissions, { deny: old });
});

test("477-R4: Codex's config keeps its hooks switch on and every byte that is not ours", () => {
  const change = (enableHooks) => ({ hooksPath: "/srv/user/.codex/hooks.json", before: null, after: { hooks: {} }, enableHooks });
  assert.equal(codexHookConfig(null, change(true)).text, "[features]\nhooks = true\n");
  assert.equal(codexHookConfig(null, change(false)).text, "");
  assert.equal(codexHookConfig('model = "m"\n', change(true)).text, 'model = "m"\n\n[features]\nhooks = true\n');
  assert.equal(codexHookConfig("[features]\nhooks = false # off\nother = 1\n", change(true)).text, "[features]\nhooks = true # off\nother = 1\n");
  assert.equal(codexHookConfig("[features]\nother = 1\n", change(true)).text, "[features]\nhooks = true\nother = 1\n");
  assert.equal(codexHookConfig("features.hooks = false\n", change(true)).text, "features.hooks = true\n");
  assert.equal(codexHookConfig("[features]\r\nother = 1\r\n", change(true)).text, "[features]\r\nhooks = true\r\nother = 1\r\n");
  const current = "[features]\nhooks = true\n";
  const unchanged = codexHookConfig(current, change(true));
  assert.deepEqual([unchanged.text, unchanged.hooksEnabled], [current, false]);
  assert.equal(codexHookConfig("[features]\nhooks = false\n", change(false)).text, "[features]\nhooks = false\n", "a clean-only render leaves the switch alone");
  for (const source of ["features = { hooks = true }\n", "[[features]]\nhooks = true\n", "[features]\nhooks = \"yes\"\n", 'model = "unclosed\n']) {
    assert.throws(() => codexHookConfig(source, change(true)), (error) => error?.reasonCode === "HOST_HOOKS_FILE_UNSUPPORTED", source);
  }

  // A trust state names its hooks file: another file's states stay, even for the same event.
  const hooks = { UserPromptSubmit: [OTHER_PROMPT] };
  const states = [
    '[hooks.state."/srv/user/.codex/hooks.json:user_prompt_submit:0:0"]',
    'trusted_hash = "sha256:1"',
    "",
    '[hooks.state."/srv/user/.codex/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:2"',
    "",
    '[hooks.state."/srv/project/.codex/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:3"',
    "",
  ].join("\n");
  const edit = codexHookConfig(`[features]\nhooks = true\n\n${states}`, { hooksPath: "/srv/user/.codex/hooks.json", before: { hooks: { ...hooks, Stop: [OTHER_TOOL] } }, after: { hooks }, enableHooks: true });
  assert.deepEqual(edit.removedTrustStates, ["/srv/user/.codex/hooks.json:stop:0:0"]);
  assert.equal(edit.text, [
    "[features]",
    "hooks = true",
    "",
    '[hooks.state."/srv/user/.codex/hooks.json:user_prompt_submit:0:0"]',
    'trusted_hash = "sha256:1"',
    "",
    '[hooks.state."/srv/project/.codex/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:3"',
    "",
  ].join("\n"));
});

test("477: a file this cannot follow is refused before anything is written, and so is one that changed after it was read", async (t) => {
  const { home, device } = await scratch(t);
  const expected = planHostHooks({ host: "claude-code", scope: "user", deviceHome: device });
  const settings = join(home, CLAUDE);
  for (const [content, reason] of [
    ["{ not json", "not JSON"],
    ["[]\n", "not a JSON object"],
    ['{"hooks": []}\n', "hooks is not an object"],
    ['{"hooks": {"UserPromptSubmit": {}}}\n', "hooks.UserPromptSubmit is not a list"],
    ['{"permissions": {"deny": "Edit(**)"}}\n', "permissions.deny is not a list"],
  ]) {
    await mkdir(join(settings, ".."), { recursive: true });
    await writeFile(settings, content);
    await assert.rejects(readHostHooks(expected, { root: home, home }), (error) => error?.reasonCode === "HOST_HOOKS_FILE_UNSUPPORTED" && error.message.includes(reason), reason);
    assert.equal(await readFile(settings, "utf8"), content);
  }
  await rm(settings);
  await writeFile(join(home, "elsewhere.json"), "{}\n");
  await symlink(join(home, "elsewhere.json"), settings);
  await assert.rejects(readHostHooks(expected, { root: home, home }), (error) => error?.reasonCode === "HOST_HOOKS_FILE_UNSUPPORTED");
  await rm(settings);

  // Changed between reading and writing: refused, the file as the other writer left it, no backup.
  await writeJson(settings, { env: { A: "1" } });
  const plan = await readHostHooks(expected, { root: home, home });
  await writeJson(settings, { env: { A: "2" } });
  await assert.rejects(applyHostHooks(plan, { at: AT }), (error) => error?.reasonCode === "HOST_HOOKS_CONCURRENT_MODIFICATION");
  assert.deepEqual(await readJson(settings), { env: { A: "2" } });
  assert.equal(await readdir(join(device, "backups")).catch(() => null), null);

  // Hooks written for Windows are not applied on this machine, nor the other way round.
  const elsewhere = process.platform === "win32" ? "linux" : "win32";
  const foreign = planHostHooks({ host: "claude-code", scope: "user", deviceHome: elsewhere === "win32" ? "D:\\Einzbern\\device" : "/srv/einzbern/device", platform: elsewhere });
  const foreignPlan = await readHostHooks(foreign, { root: home, home });
  await assert.rejects(applyHostHooks(foreignPlan, { at: AT }), (error) => error?.reasonCode === "HOST_HOOKS_INPUT_INVALID");
  await assert.rejects(readHostHooks(expected, { root: join(home, "absent"), home }), (error) => error?.reasonCode === "HOST_HOOKS_INPUT_INVALID");
});

test("478-AC5, 477-R5: a device that declined the navigation section gets the two pointer hooks in both hosts' files, and loses them once it chooses written", async (t) => {
  const { home, device } = await scratch(t);
  for (const platform of ["darwin", "linux", "win32"]) {
    const deviceHome = platform === "win32" ? "D:\\Einzbern\\device" : "/srv/einzbern/device";
    const launcher = hookLauncherPath(deviceHome, platform);
    for (const host of ["claude-code", "codex"]) {
      const expected = planHostHooks({ host, scope: "user", deviceHome, platform, navigation: "declined" });
      const commands = Object.fromEntries(Object.entries(expected.groups).map(([event, groups]) => [event, groups.flatMap((group) => group.hooks.map((hook) => hook.command))]));
      assert.deepEqual(commands, {
        UserPromptSubmit: [`node "${launcher}" user-prompt-submit`],
        SessionStart: [`node "${launcher}" session-start`],
        SubagentStart: [`node "${launcher}" subagent-start`],
      }, `${platform}/${host}`);
      for (const [command] of Object.values(commands)) assert.equal(isEinzbernHookCommand(command), true, command);
    }
  }

  const declined = await render("claude-code", "user", home, home, device, { navigation: "declined" });
  assert.equal(declined.applied.reasonCode, "HOST_HOOKS_WRITTEN");
  const settings = await readJson(join(home, CLAUDE));
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["SessionStart", "SubagentStart", "UserPromptSubmit"]);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, `node "${hookLauncherPath(device)}" session-start`);
  assert.equal((await render("claude-code", "user", home, home, device, { navigation: "declined" })).applied.reasonCode, "HOST_HOOKS_CURRENT", "rendering again writes nothing");
  const codex = await render("codex", "user", home, home, device, { navigation: "declined" });
  assert.equal(codex.applied.reasonCode, "HOST_HOOKS_WRITTEN");
  assert.deepEqual(Object.keys((await readJson(join(home, CODEX))).hooks).sort(), ["SessionStart", "SubagentStart", "UserPromptSubmit"]);
  assert.match(await readFile(join(home, CODEX_CONFIG_FILE), "utf8"), /^\[features\]\nhooks = true\n/mu);

  // Written: the pointer hooks come out of the file again, and the prompt hook stays where it was.
  const written = await render("claude-code", "user", home, home, device, { navigation: "written" });
  assert.equal(written.applied.reasonCode, "HOST_HOOKS_WRITTEN");
  assert.deepEqual(written.plan.removedHooks.map((hook) => hook.event).sort(), ["SessionStart", "SubagentStart"]);
  const after = await readJson(join(home, CLAUDE));
  assert.deepEqual(Object.keys(after.hooks), ["UserPromptSubmit"]);
  assert.deepEqual(after.hooks.UserPromptSubmit, settings.hooks.UserPromptSubmit);
});
