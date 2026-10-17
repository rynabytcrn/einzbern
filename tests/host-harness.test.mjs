// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-220, carried into TCRN-CROSS-STORY-477: the harness is what the hosts run around a
// session, and the Owner ruled that capabilities line up across hosts. Since TCRN-CROSS-STORY-477
// (R1, R3), extended by BL34/35, the harness is rendered by host-hooks.ts; the capability
// roster in scripts/host-harness.mjs and the Codex writer in scripts/host-harness-apply.mjs are
// merged into that module and gone.
//
// The event names asserted here come from the two official references:
//   https://learn.chatgpt.com/docs/hooks and https://code.claude.com/docs/en/hooks

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_HOOK_EVENTS,
  HOST_HOOK_FILE_HOSTS,
  HOST_HOOK_HOSTS,
  isEinzbernHookCommand,
  isLegacyHookCommand,
  mergeHostHooks,
  planHostHooks,
} from "../dist/build/packages/core/src/host-hooks.js";
import { LEGACY_DEVICE_DIRECTORY, LEGACY_ENGINE_NAME, LEGACY_HOOK_SCRIPTS, LOCAL_DIRECTORY_NAMES } from "../dist/build/packages/core/src/names.js";

// Codex's documented event set. Every event the harness uses must be in it, and Codex's set is a
// strict subset of Claude Code's, so membership here settles both directions.
const CODEX_EVENTS = new Set([
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "UserPromptSubmit", "SubagentStop", "Stop", "SessionStart", "SessionEnd", "SubagentStart",
]);
const RETIRED_EVENTS = ["SessionStart", "PostToolUse", "Stop", "SubagentStop"];
const DEVICE = Object.freeze({ darwin: "/srv/einzbern/device", linux: "/srv/einzbern/device", win32: "D:\\Einzbern\\device" });

test("INC-220, 477-R1: both hosts carry the same three engine hooks and commands", () => {
  // TCRN-CROSS-STORY-548 R1: DSH runs the hook too, but only these two keep a hook file.
  assert.deepEqual([...HOST_HOOK_HOSTS], ["claude-code", "codex", "dsh"]);
  assert.deepEqual([...HOST_HOOK_FILE_HOSTS], ["claude-code", "codex"]);
  assert.deepEqual(Object.keys(HOST_HOOK_EVENTS), ["UserPromptSubmit", "SubagentStart", "PreToolUse"]);
  for (const [platform, deviceHome] of Object.entries(DEVICE)) {
    const [claude, codex] = HOST_HOOK_FILE_HOSTS.map((host) => planHostHooks({ host, scope: "user", deviceHome, platform }));
    assert.deepEqual(codex.groups, claude.groups, `${platform}: a capability present on one host is present on the other`);
    assert.deepEqual(Object.keys(claude.groups), ["UserPromptSubmit", "SubagentStart", "PreToolUse"]);
    for (const event of ["UserPromptSubmit", "SubagentStart", "PreToolUse"]) {
      assert.equal(claude.groups[event].length, 1);
      assert.equal(claude.groups[event][0].hooks.length, 1);
    }
  }
});

test("INC-220: every event the harness hooks exists on Codex", () => {
  for (const event of Object.keys(HOST_HOOK_EVENTS)) assert.ok(CODEX_EVENTS.has(event), `${event} is a documented Codex hook event`);
});

test("477-R3: none of the retired events is rendered, and no hook names a checkout, a container or a host", () => {
  for (const [platform, deviceHome] of Object.entries(DEVICE)) {
    for (const host of HOST_HOOK_FILE_HOSTS) {
      const expected = planHostHooks({ host, scope: "project", deviceHome, platform });
      for (const event of RETIRED_EVENTS) assert.equal(Object.hasOwn(expected.groups, event), false, `${platform}/${host}: no ${event}`);
      const [hook] = expected.groups.UserPromptSubmit[0].hooks;
      assert.equal(hook.type, "command", "only type:command runs on Codex");
      assert.equal(hook.command, `node "${expected.launcher}" user-prompt-submit`);
      for (const part of ["${CLAUDE_PROJECT_DIR}", "--container-root", "--host", "scripts/", LEGACY_ENGINE_NAME, LOCAL_DIRECTORY_NAMES.classificationFolder]) {
        assert.equal(hook.command.includes(part), false, `${platform}/${host}: the command does not name ${part}`);
      }
      // The launcher is the device directory's, which the engine never changes on an update.
      assert.ok(expected.launcher.startsWith(deviceHome), `${platform}/${host}: the launcher sits in the device directory`);
    }
  }
});

test("477-R1: the two hosts' files differ only in where they keep the hooks", () => {
  const [claude, codex] = HOST_HOOK_FILE_HOSTS.map((host) => planHostHooks({ host, scope: "user", deviceHome: DEVICE.linux, platform: "linux" }));
  assert.deepEqual([claude.hooksFile, codex.hooksFile], [".claude/settings.json", ".codex/hooks.json"]);
  assert.deepEqual(mergeHostHooks(null, codex).document, mergeHostHooks(null, claude).document);
});

test("477-R3: the old harness's hooks are recognised wherever they ran from, and nothing else is", () => {
  assert.equal(LEGACY_HOOK_SCRIPTS.length, 10);
  for (const script of LEGACY_HOOK_SCRIPTS) {
    const claudeForm = `if [ -f "\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/${script}" ]; then node "\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/${script}" --host claude; fi`;
    const codexForm = `node "/srv/user/${LEGACY_DEVICE_DIRECTORY}/${LEGACY_ENGINE_NAME}/${script}" --container-root "/srv/container"`;
    const windowsForm = `node "D:\\work\\${LEGACY_ENGINE_NAME}\\${script.replaceAll("/", "\\")}"`;
    const relativeForm = `node ${script}`;
    for (const command of [claudeForm, codexForm, windowsForm, relativeForm]) {
      assert.equal(isLegacyHookCommand(command), true, command);
      assert.equal(isEinzbernHookCommand(command), false, command);
    }
  }
  for (const command of [
    "node scripts/knowledge-inject-hook.mjsx",
    "node my-scripts/agents-zero-hook.mjs.bak",
    "echo tools/stop-pact",
    "prettier --write",
    'node "/srv/tools/hook.mjs" user-prompt-submit',
  ]) {
    assert.equal(isLegacyHookCommand(command), false, command);
    assert.equal(isEinzbernHookCommand(command), false, command);
  }
  for (const command of ['node "/srv/einzbern/device/engine/hook.mjs" user-prompt-submit', 'node "D:\\Einzbern\\device\\engine\\hook.mjs" session-start']) {
    assert.equal(isEinzbernHookCommand(command), true, command);
  }
});
