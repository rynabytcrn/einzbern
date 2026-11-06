#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R2 (MIN-227 D5): the hook entry of one engine version. The stable
// launcher in the device directory (scripts/einzbern-hook-launcher.mjs, installed as
// engine/hook.mjs) imports this file from engine/<current version>/ only after the prompt's
// directory matched a project in this device's registry, and prints what runHookEvent returns.
// The hook holds no rule of its own (D5): which event is answered and what the answer carries is
// decided here, by the engine version that is current. In the development tree it reads the
// build (dist/build); a release carries it as one file (TCRN-CROSS-STORY-481).
// BL-34: SubagentStart recalls from the native agent_type and includes navigation before work.
// SessionStart remains a navigation-only fallback. BL-35 adds the narrowly bounded Read guard.
// Codex peer observations use native tool results; no collector or polling process is started.
// TCRN-CROSS-SUB-483 (TCRN-CROSS-STORY-529, MIN-257 D6): every prompt recalled here also leaves
// one line in log/hook.ndjson in the device directory, naming why it got what it got, so a prompt
// that was answered can be told from one that got nothing and from a hook that never ran. The line
// has the launcher's shape (einzbern.hook-log.v1) without container and marker, the launcher's
// note for a prompt the registry does not cover. A line that cannot be written is dropped: the
// hook's output, stderr and exit code stay what they were without it.
// TCRN-CROSS-STORY-548 R3: each recall line also names the host the hook ran under (host:
// claude-code, codex or dsh, as hookHost reads it), after reasonCode. It is an additive field of
// einzbern.hook-log.v1: the schema version is unchanged, and a v1 reader that takes only
// schemaVersion, at, event, cwd and reasonCode reads these lines as before. The launcher's own
// lines for prompts the registry does not cover are unchanged and carry no host.

import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { meetsNodeFloor } from "../dist/build/packages/core/src/node-floor.js";
import { AGENT_OUTPUT_MAX_BYTES } from "../dist/build/packages/core/src/runtime-input-contract.js";
// Held equal to scripts/einzbern-hook-launcher.mjs (LOG_DIRECTORY, LOG_FILE, LOG_SCHEMA_VERSION).
const LOG_DIRECTORY = "log";
const LOG_FILE = "hook.ndjson";
const LOG_SCHEMA_VERSION = "einzbern.hook-log.v1";
// The code the launcher reports on stderr for a failure that carries none of its own.
const UNCODED_FAILURE = "HOOK_LAUNCH_FAILED";

function absolute(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) ? value : null;
}

// One line in log/hook.ndjson for one recall, written as the launcher writes its note: the
// directory 0700, the file 0600, and every failure dropped.
function noteRecall(device, event, cwd, reasonCode, host) {
  try {
    const logDirectory = join(device, LOG_DIRECTORY);
    try {
      mkdirSync(logDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") return;
    }
    const line = { schemaVersion: LOG_SCHEMA_VERSION, at: new Date().toISOString(), event, cwd, reasonCode, host };
    appendFileSync(join(logDirectory, LOG_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // A hook never blocks a session, and a line it cannot write changes nothing it answers.
  }
}

/**
 * Answer one hook event. `event` is the word on the hook's command line (user-prompt-submit),
 * `payload` the JSON object the host wrote on stdin, `libraryPath` the library of the registry
 * entry the launcher matched and `cwd` the directory it matched from (the payload's cwd, or this
 * process's, when left out). Returns the text for stdout, or null when the hook prints nothing.
 */
export async function runHookEvent({ event, payload, libraryPath, cwd } = {}) {
  // TCRN-CROSS-STORY-481 R2, R4: the stable launcher refuses older Node.js before it imports this
  // file. Keep this guard for direct callers too: a hook answers nothing, and the CLI is where the
  // floor is reported (ENGINE_NODE_TOO_OLD).
  if (!meetsNodeFloor(process.versions.node)) return null;
  const [{ hookEventName, hookHost, navigationPointerAnswer, promptRecallOutcome, hookProtocolOutput }, { deviceHome }] = await Promise.all([
    import("../dist/build/packages/core/src/hook-recall.js"),
    import("../dist/build/packages/core/src/device-home.js"),
  ]);
  const body = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const name = hookEventName(event);
  // Read once, for the recall and for its log line alike.
  const host = hookHost(process.env);
  // Stale owned SubagentStop commands are inert until normal setup retires them.
  if (event === "subagent-stop") return null;
  if (name === "UserPromptSubmit" && host === "codex") {
    const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
    await runCodexPeerHook(name, body, deviceHome(process.env));
  }
  // DSH retains its existing navigation contract; its next feature batch is separate.
  if (name === "SubagentStart" && host === "dsh") return `${navigationPointerAnswer(host, name).output}\n`;
  switch (name) {
    case "PreToolUse": {
      const directory = absolute(cwd) ?? absolute(body.cwd) ?? process.cwd();
      if (host === "codex" && ["mcp__codex_app__wait_threads", "mcp__codex_app__read_thread", "mcp__codex_app__send_message_to_thread"].includes(body.tool_name)) {
        const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
        const result = await runCodexPeerHook(name, body, deviceHome(process.env));
        noteRecall(deviceHome(process.env), event, directory, result.reasonCode, host);
        return result.output;
      }
      const answer = readGuardAnswer(body, directory, host);
      if (host !== "dsh") noteRecall(deviceHome(process.env), event, directory, answer === null ? "HOOK_READ_GUARD_OBSERVED" : "HOOK_READ_GUARD_DENIED", host);
      return answer;
    }
    case "PostToolUse":
    case "Stop": {
      if (host !== "codex") return null;
      const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
      const result = await runCodexPeerHook(name, body, deviceHome(process.env));
      if (result.reasonCode !== "HOOK_PEER_NOT_APPLICABLE") {
        noteRecall(deviceHome(process.env), event, absolute(cwd) ?? absolute(body.cwd) ?? process.cwd(), result.reasonCode, host);
      }
      return result.output;
    }
    case "SubagentStart":
    case "UserPromptSubmit": {
      if (typeof libraryPath !== "string") return null;
      const directory = absolute(cwd) ?? absolute(body.cwd) ?? process.cwd();
      const device = deviceHome(process.env);
      let outcome;
      try {
        // A payload without a prompt string is an empty prompt (HOOK_RECALL_PROMPT_EMPTY).
        outcome = await promptRecallOutcome({
          libraryPath,
          // Native SubagentStart has agent_type, not a task prompt. Never read
          // arbitrary transcript paths or claim task-specific injection from a made-up field.
          prompt: name === "SubagentStart" ? (typeof body.agent_type === "string" ? body.agent_type : "") : (typeof body.prompt === "string" ? body.prompt : ""),
          event: name,
          host,
          cwd: directory,
        });
      } catch (error) {
        noteRecall(device, event, directory, typeof error?.reasonCode === "string" ? error.reasonCode : UNCODED_FAILURE, host);
        throw error;
      }
      noteRecall(device, event, directory, outcome.reasonCode, host);
      if (name === "SubagentStart") {
        const pointer = navigationPointerAnswer(host, name);
        return `${hookProtocolOutput(host, name, [...pointer.lines, ...(outcome.answer?.lines ?? [])])}\n`;
      }
      return outcome.answer === null ? null : `${outcome.answer.output}\n`;
    }
    case "SessionStart":
      return `${navigationPointerAnswer(host, name).output}\n`;
    default:
      return null;
  }
}

// A text Read's offset is one-based. Count bytes, including line endings, from the opened
// file and stop at the requested window, EOF or the byte limit. The prefix is scanned in chunks.
function readWindowExceedsLimit(path, offset, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) return false;
    const buffer = Buffer.alloc(8192);
    let remaining = file.size;
    let skip = offset - 1;
    let bytes = 0;
    while (remaining > 0) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count === 0) break;
      remaining -= count;
      const chunk = buffer.subarray(0, count);
      let cursor = 0;
      while (cursor < count) {
        const newline = chunk.indexOf(10, cursor);
        const end = newline < 0 ? count : newline + 1;
        if (skip === 0) {
          bytes += end - cursor;
          if (bytes > AGENT_OUTPUT_MAX_BYTES) return true;
          if (newline >= 0 && --limit === 0) return false;
        } else if (newline >= 0) {
          skip -= 1;
        }
        cursor = end;
      }
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** BL-35: only a dedicated Read is enforceable. Shell commands are never interpreted. */
export function readGuardAnswer(payload, cwd, host) {
  if (host === "dsh") return null;
  try {
    if (payload?.tool_name !== "Read") return null;
    const input = payload.tool_input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    if (typeof input.file_path !== "string" || input.file_path.length === 0) return null;
    const path = resolve(cwd, input.file_path);
    const file = statSync(path);
    if (!file.isFile() || file.size <= AGENT_OUTPUT_MAX_BYTES) return null;
    const offset = input.offset === undefined ? 1 : input.offset;
    const bounded = Number.isSafeInteger(offset) && offset >= 0
      && Number.isSafeInteger(input.limit) && input.limit > 0 && input.limit <= 200;
    if (bounded && !readWindowExceedsLimit(path, Math.max(1, offset), input.limit)) return null;
    return `${JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Read a window of at most 200 lines and ${AGENT_OUTPUT_MAX_BYTES} bytes. If one line exceeds the byte limit, extract a smaller excerpt with a tool.`,
    } })}\n`;
  } catch {
    // An unreadable path, invalid input or filesystem exception must never block a tool.
    return null;
  }
}
