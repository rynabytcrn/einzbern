// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-220 — the harness is one roster rendered per host.
//
// Owner ruled that a host is under the harness from the moment it installs its adapter,
// that capabilities line up across hosts, and that a capability a host cannot express
// needs a workaround rather than a silent omission. Before this, the harness existed only
// as hand-kept JSON inside `.claude/settings.json`, so Codex ran under nothing at all.
//
// The event names, payload fields and blocking contracts asserted here come from the two
// official references, not from what the repository happened to already do:
//   https://learn.chatgpt.com/docs/hooks and https://code.claude.com/docs/en/hooks

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HARNESS_CAPABILITIES,
  HOSTS,
  capabilityGaps,
  claudeHarnessDrift,
  claudeHookSettings,
  codexHookDocument,
  hookEntriesFor,
  nonHookCapabilitiesFor,
} from "../scripts/host-harness.mjs";
import { applyHostHarness, harnessBytes } from "../scripts/host-harness-apply.mjs";
import { LOCAL_DIRECTORY_NAMES } from "../dist/build/packages/core/src/index.js";

// Codex's documented event set. Every event the harness uses must be in it, and Codex's
// set is a strict subset of Claude Code's, so membership here settles both directions.
const CODEX_EVENTS = new Set([
  "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
  "UserPromptSubmit", "SubagentStop", "Stop", "SessionStart", "SessionEnd", "SubagentStart",
]);

test("INC-220 every capability is claimed by every host", () => {
  assert.deepEqual(capabilityGaps(), [], "a capability blank for one host is how the harness became Claude-only");
  // TCRN-CROSS-STORY-467 R3: governed context injection is what remains of the roster.
  assert.deepEqual(HARNESS_CAPABILITIES.map((capability) => capability.id), [
    "governed-context-injection",
    "per-prompt-context-injection",
    "post-tool-reference",
    "subagent-task-context-injection",
  ]);
});

test("INC-220 a host that reaches a capability without a hook must say how", () => {
  // This is the workaround requirement, made checkable. Its first case, Claude's declarative
  // deny list with no Codex equivalent, went with the control-tree refusal
  // (TCRN-CROSS-STORY-467 R3); the next capability a host reaches without a hook still has
  // to record what that host does instead.
  for (const host of HOSTS) {
    for (const entry of nonHookCapabilitiesFor(host)) {
      assert.equal(typeof entry.note, "string");
      assert.ok(entry.note.length > 40, `${host}/${entry.id} needs a real explanation, not a label`);
    }
  }
});

test("INC-220 every rostered event exists on Codex", () => {
  for (const entry of hookEntriesFor("codex")) {
    assert.ok(CODEX_EVENTS.has(entry.event), `${entry.event} is not a documented Codex hook event`);
  }
});

test("STORY-467 R3: every rendered hook runs the knowledge-inject handler and nothing else", () => {
  // STORY-372 generated SubagentStart and SubagentStop telemetry hooks for both hosts, and
  // the roster also carried the governed-write observer, the control-tree guard, the stop
  // pact, lesson capture, the output-contract injection and the Codex response-style check.
  // All of them are retired with their scripts (TCRN-CROSS-STORY-467 R3).
  for (const host of HOSTS) {
    assert.deepEqual([...new Set(hookEntriesFor(host).map((entry) => entry.handler))], ["scripts/knowledge-inject-hook.mjs"]);
  }
  const commands = [...Object.values(claudeHookSettings()), ...Object.values(codexHookDocument("/repo").hooks)]
    .flat()
    .flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.equal(commands.length, 2 * HARNESS_CAPABILITIES.length);
  for (const command of commands) assert.match(command, /scripts\/knowledge-inject-hook\.mjs" --container-root /u);
});

test("STORY-418 both hosts register the bound subagent context path separately from telemetry", () => {
  for (const host of HOSTS) {
    const entries = hookEntriesFor(host).filter((entry) => entry.id === "subagent-task-context-injection");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, "SubagentStart");
    assert.equal(entries[0].handler, "scripts/knowledge-inject-hook.mjs");
    assert.equal(entries[0].timeout, 30);
  }
});

test("TCRN-CROSS-STORY-393 both hosts register the PostToolUse reference path", () => {
  for (const host of HOSTS) {
    const entries = hookEntriesFor(host).filter((entry) => entry.id === "post-tool-reference");
    assert.deepEqual(entries.map((entry) => ({ event: entry.event, handler: entry.handler, timeout: entry.timeout })), [
      { event: "PostToolUse", handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
    ]);
  }
  assert.equal(claudeHookSettings().PostToolUse.length, 1);
  assert.equal(codexHookDocument("/repo").hooks.PostToolUse.length, 1);
  assert.match(claudeHookSettings().PostToolUse[0].hooks[0].command, /scripts\/knowledge-inject-hook\.mjs" --container-root "\$\{CLAUDE_PROJECT_DIR\}" --host claude; fi$/u);
  assert.match(codexHookDocument("/repo").hooks.PostToolUse[0].hooks[0].command, /scripts\/knowledge-inject-hook\.mjs" --container-root "[^"]+" --host codex$/u);
});

test("INC-220 the two renderings carry the same handlers for the same capabilities", () => {
  // Rendering differences are legitimate — file shape and command form. A capability
  // present on one host and absent on the other is not.
  const claude = new Set(hookEntriesFor("claude").map((entry) => entry.id));
  const codex = new Set(hookEntriesFor("codex").map((entry) => entry.id));
  const claudeOnly = [...claude].filter((id) => !codex.has(id));
  assert.deepEqual(claudeOnly, [], "Codex would be missing a capability Claude has");
  for (const id of [...codex].filter((entry) => !claude.has(entry))) {
    const capability = HARNESS_CAPABILITIES.find((entry) => entry.id === id);
    assert.notEqual(capability.claude.mechanism, "hook", `${id} is a hook on Codex only`);
    assert.equal(typeof capability.claude.note, "string", `${id} needs Claude's mechanism stated`);
  }
});

test("INC-220 the Codex document is shaped the way the host documents it", () => {
  const document = codexHookDocument("/repo");
  assert.equal(typeof document.description, "string");
  for (const [event, groups] of Object.entries(document.hooks)) {
    assert.ok(CODEX_EVENTS.has(event));
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command", "only type:command runs on Codex");
        // Codex resolves no project-dir variable; a template would be written literally.
        assert.ok(!hook.command.includes("${CLAUDE_PROJECT_DIR}"), "Codex commands must be absolute");
        assert.ok(hook.command.startsWith("node \"/repo/"));
      }
    }
  }
  // TCRN-CROSS-INC-368: a managed Codex copy's install location says nothing about the
  // container, so every Codex command names its container root. Each event is checked,
  // not one representative leg (accept-r3 issue #157's lesson). The other handlers that
  // carried the flag are retired with their scripts (TCRN-CROSS-STORY-467 R3).
  for (const groups of Object.values(document.hooks)) {
    for (const group of groups) {
      assert.match(group.hooks[0].command, /scripts\/knowledge-inject-hook\.mjs" --container-root "[^"]+" --host codex$/u);
    }
  }
});

test("INC-220 the Claude rendering keeps the project-dir form that host resolves", () => {
  for (const groups of Object.values(claudeHookSettings())) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.ok(hook.command.includes("${CLAUDE_PROJECT_DIR}"));
        assert.ok(hook.command.startsWith(`if [ -f "\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/`), "Claude hooks are inert outside the platform tree");
      }
    }
  }
  for (const groups of Object.values(claudeHookSettings())) {
    for (const group of groups) {
      assert.match(group.hooks[0].command, /scripts\/knowledge-inject-hook\.mjs" --container-root "\$\{CLAUDE_PROJECT_DIR\}" --host claude; fi$/u);
    }
  }
});

test("INC-220 harness drift is reported when a live Claude hook is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-harness-"));
  try {
    const path = join(root, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: {} }));
    const drift = claudeHarnessDrift(path);
    assert.deepEqual(drift.map((finding) => finding.capability), hookEntriesFor("claude").map((entry) => entry.id), "every missing hook is named");
    // The control-tree deny rules are no longer part of the harness (TCRN-CROSS-STORY-467 R3).
    writeFileSync(path, JSON.stringify({ hooks: claudeHookSettings() }));
    assert.deepEqual(claudeHarnessDrift(path), [], "a rendered harness without deny rules has no drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INC-220 applying the Codex harness is idempotent and atomic", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-harness-"));
  try {
    mkdirSync(join(root, ".codex"), { recursive: true });
    const first = applyHostHarness("codex", root, { repoRoot: "/repo" });
    assert.equal(first.reasonCode, "HOST_HARNESS_WRITTEN");
    assert.equal(readFileSync(first.path, "utf8"), harnessBytes("codex", "/repo", root));
    const second = applyHostHarness("codex", root, { repoRoot: "/repo" });
    assert.equal(second.reasonCode, "HOST_HARNESS_ALREADY_CURRENT");
    assert.equal(second.wrote, false, "an unchanged harness is not rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INC-220 Claude's settings are not writable through the applier", () => {
  // Rewriting a live session's settings underneath it is a worse failure than the drift.
  assert.throws(() => harnessBytes("claude"), (error) => error?.reasonCode === "HOST_HARNESS_NOT_WRITABLE");
});
