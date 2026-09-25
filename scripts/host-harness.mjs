#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-220 — the platform harness, written once and rendered per host.
//
// The harness is what the hosts run around a session. It observed governed writes, refused
// writes into the control trees, kept a turn from ending on an unmet pact, re-injected the
// output contract and captured declared lessons; TCRN-CROSS-STORY-467 R3 (MIN-227 D3)
// retired all of that with its scripts, and what remains is governed context injection.
// Until this file existed the harness was Claude-only, because it lived
// as hand-kept JSON inside `.claude/settings.json` and nothing rendered it anywhere else.
// A Codex session on this platform ran under no harness at all — and under
// `approval_policy = "never"` with `sandbox_mode = "danger-full-access"`, which makes the
// PreToolUse hook the single constraint that host has.
//
// Owner ruled (2026-08-17) that a host is under the harness from the moment it installs
// its adapter, that capabilities must line up across hosts, and that a capability a host
// genuinely cannot express needs a workaround rather than a silent omission.
//
// So the roster below is keyed on CAPABILITY, not on hook. A capability names what must be
// true; each host then names the mechanism it uses to make it true. That distinction is
// what lets a check answer "this host is missing this capability" instead of the much
// weaker "this file is absent" — and it is the only shape in which the two hosts'
// different mechanisms for the same guarantee can be compared at all.
//
// Both official references were read rather than inferred:
//   https://learn.chatgpt.com/docs/hooks        (Codex)
//   https://code.claude.com/docs/en/hooks       (Claude Code)
// What they agree on: event names, the stdin payload (`hook_event_name`, `tool_name`,
// `tool_input`, `tool_use_id`), the stdout contract (`hookSpecificOutput` with
// `additionalContext` / `permissionDecision`), and blocking by exit 2 with stderr. Codex's
// event set is a strict subset of Claude Code's, and every event this harness uses is in
// it, so for the harness there is no "Claude has one Codex lacks".
// Where they differ: the file (`.claude/settings.json` hooks key vs `.codex/hooks.json`
// root hooks key) and the command path (`${CLAUDE_PROJECT_DIR}` vs an absolute path).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_DIRECTORY_NAMES } from "./lib/names.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOSTS = Object.freeze(["claude", "codex"]);
const CONTAINER_ROOT_HANDLERS = new Set(["scripts/knowledge-inject-hook.mjs"]);
/**
 * What the harness must guarantee, and how each host is made to guarantee it.
 *
 * `mechanism: "hook"` renders into that host's hook file. A capability a host reaches some
 * other way carries a `note` naming the workaround, recorded where it is read.
 */
export const HARNESS_CAPABILITIES = Object.freeze([
  {
    id: "governed-context-injection",
    purpose: "a session opens with governed work and knowledge context in front of it",
    claude: { mechanism: "hook", event: "SessionStart", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
    codex: { mechanism: "hook", event: "SessionStart", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
  },
  {
    id: "per-prompt-context-injection",
    purpose: "each prompt is answered against current governed context, not a stale session opening",
    claude: { mechanism: "hook", event: "UserPromptSubmit", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
    codex: { mechanism: "hook", event: "UserPromptSubmit", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
  },
  {
    id: "post-tool-reference",
    purpose: "each completed tool use can feed the governed reference channel",
    claude: { mechanism: "hook", event: "PostToolUse", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
    codex: { mechanism: "hook", event: "PostToolUse", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
  },
  {
    id: "subagent-task-context-injection",
    purpose: "an explicitly bound subagent receives only its task context at start; unbound children receive no generic knowledge injection",
    claude: { mechanism: "hook", event: "SubagentStart", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
    codex: { mechanism: "hook", event: "SubagentStart", matcher: null, handler: "scripts/knowledge-inject-hook.mjs", timeout: 30 },
  },
]);

/** Hook entries a host must carry, in event order. */
export function hookEntriesFor(host) {
  return HARNESS_CAPABILITIES
    .map((capability) => ({ id: capability.id, ...capability[host] }))
    .filter((entry) => entry.mechanism === "hook");
}

/** Capabilities a host reaches by something other than a hook, with the reason. */
export function nonHookCapabilitiesFor(host) {
  return HARNESS_CAPABILITIES
    .map((capability) => ({ id: capability.id, ...capability[host] }))
    .filter((entry) => entry.mechanism !== "hook");
}

/**
 * Every capability is claimed by every host, one way or another.
 *
 * This is the check Owner's "capabilities must line up" reduces to. It compares the
 * roster against itself, which sounds circular and is not: the failure it prevents is a
 * capability being added for one host and left blank for the other, which is exactly how
 * the harness came to be Claude-only in the first place.
 */
export function capabilityGaps() {
  const gaps = [];
  for (const capability of HARNESS_CAPABILITIES) {
    for (const host of HOSTS) {
      const declared = capability[host];
      if (declared === undefined || typeof declared.mechanism !== "string") {
        gaps.push({ capability: capability.id, host, reason: "no mechanism declared" });
        continue;
      }
      if (declared.mechanism === "hook" && typeof declared.handler !== "string") {
        gaps.push({ capability: capability.id, host, reason: "hook mechanism without a handler" });
      }
      if (declared.mechanism !== "hook" && typeof declared.note !== "string") {
        // A host that reaches a capability another way has to say how, or the roster is
        // recording an omission as if it were a design.
        gaps.push({ capability: capability.id, host, reason: "non-hook mechanism without a stated workaround" });
      }
    }
  }
  return gaps;
}

function handlerArguments(handler, host, containerRoot) {
  const hostArgument = handler === "scripts/knowledge-inject-hook.mjs" ? ` --host ${host}` : "";
  if (CONTAINER_ROOT_HANDLERS.has(handler)) {
    const rootArgument = host === "claude" ? '"${CLAUDE_PROJECT_DIR}"' : JSON.stringify(resolve(containerRoot));
    return ` --container-root ${rootArgument}${hostArgument}`;
  }
  return hostArgument;
}

function claudeCommand(handler) {
  const argumentsText = handlerArguments(handler, "claude", null);
  const target = `\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/${handler}`;
  return `if [ -f "${target}" ]; then node "${target}"${argumentsText}; fi`;
}

function codexCommand(handler, repoRoot, containerRoot) {
  // Codex resolves no project-dir variable, so the command is absolute — the same shape
  // the engine's own generated Codex hooks use.
  return `node ${JSON.stringify(join(repoRoot, handler))}${handlerArguments(handler, "codex", containerRoot)}`;
}

function group(entry, command) {
  const hook = { type: "command", command };
  if (typeof entry.timeout === "number") hook.timeout = entry.timeout;
  const rendered = { hooks: [hook] };
  if (typeof entry.matcher === "string") return { matcher: entry.matcher, ...rendered };
  return rendered;
}

function renderHooks(host, commandFor) {
  const hooks = {};
  for (const entry of hookEntriesFor(host)) {
    hooks[entry.event] ??= [];
    hooks[entry.event].push(group(entry, commandFor(entry)));
  }
  return hooks;
}

/** The `hooks` object for `.claude/settings.json`. */
export function claudeHookSettings() {
  return renderHooks("claude", (entry) => claudeCommand(entry.handler));
}

/** The whole `.codex/hooks.json` document. */
export function codexHookDocument(repoRoot = REPO_ROOT, containerRoot = resolve(REPO_ROOT, "../..")) {
  return {
    description: "Einzbern platform harness for Codex: governed context injection.",
    hooks: renderHooks("codex", (entry) => codexCommand(entry.handler, repoRoot, containerRoot)),
  };
}

/**
 * Does the live Claude settings still carry what the roster says it should?
 *
 * Read-only on purpose. The roster is the authority for what the harness IS, but a
 * generator that silently rewrites a live host's settings mid-session is a worse problem
 * than the drift it fixes, so this reports and lets a human act.
 */
export function claudeHarnessDrift(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    return [{ reason: "settings unreadable", detail: error?.code ?? "INVALID_JSON", path: settingsPath }];
  }
  const findings = [];
  const live = settings?.hooks ?? {};
  for (const entry of hookEntriesFor("claude")) {
    const groups = Array.isArray(live[entry.event]) ? live[entry.event] : [];
    const commands = groups.flatMap((candidate) => (Array.isArray(candidate?.hooks) ? candidate.hooks : []))
      .map((hook) => String(hook?.command ?? ""));
    if (!commands.some((command) => command.includes(entry.handler))) {
      findings.push({ capability: entry.id, event: entry.event, reason: "no live hook runs this handler", handler: entry.handler });
    }
  }
  return findings;
}

if (process.argv[1]?.endsWith("host-harness.mjs")) {
  const gaps = capabilityGaps();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "tcrn.host-harness.v1",
    ok: gaps.length === 0,
    reasonCode: gaps.length === 0 ? "HOST_HARNESS_CAPABILITIES_ALIGNED" : "HOST_HARNESS_CAPABILITY_GAP",
    hosts: [...HOSTS],
    capabilities: HARNESS_CAPABILITIES.map((capability) => capability.id),
    gaps,
  }, null, 2)}\n`);
  if (gaps.length > 0) process.exitCode = 1;
}
