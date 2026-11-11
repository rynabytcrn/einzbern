#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R2 (MIN-227 D5): the hook entry of one engine version. The stable
// launcher in the device directory (scripts/einzbern-hook-launcher.mjs, installed as
// engine/hook.mjs) imports this file from engine/<current version>/ only after the prompt's
// directory matched a project in this device's registry, and prints what runHookEvent returns.
// The hook holds no rule of its own (D5): which event is answered and what the answer carries is
// decided here, by the engine version that is current. In the development tree it reads the
// build (dist/build); a release carries it as one file (TCRN-CROSS-STORY-481).
// STORY-646: SubagentStart role names are not tasks; retain navigation before work.
// SessionStart remains a navigation-only fallback. BL-35 adds the narrowly bounded Read guard.
// Codex peer observations use native tool results; no collector or polling process is started.
// TCRN-CROSS-SUB-483 (TCRN-CROSS-STORY-529, MIN-257 D6): every prompt recalled here also leaves
// one line in log/hook.ndjson in the device directory, naming why it got what it got, so a prompt
// that was answered can be told from one that got nothing and from a hook that never ran. The line
// has the launcher's shape (einzbern.hook-log.v1) without container and marker, the launcher's
// note for a prompt the registry does not cover. A line that cannot be written is dropped: the
// hook's output, stderr and exit code stay what they were without it.
// TCRN-CROSS-STORY-548 R3: each recall line also names the host the hook ran under (host:
// claude-code, codex, dsh or kiro, as hookHost reads it), after reasonCode. It is an additive field of
// einzbern.hook-log.v1: the schema version is unchanged, and a v1 reader that takes only
// schemaVersion, at, event, cwd and reasonCode reads these lines as before. The launcher's own
// lines for prompts the registry does not cover are unchanged and carry no host.

import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { meetsNodeFloor } from "../dist/build/packages/core/src/node-floor.js";
import { AGENT_OUTPUT_MAX_BYTES } from "../dist/build/packages/core/src/runtime-input-contract.js";
// Held equal to scripts/einzbern-hook-launcher.mjs (LOG_DIRECTORY, LOG_FILE, LOG_SCHEMA_VERSION).
export const CODEX_PEER_GUARD_CONTRACT = "einzbern.codex-peer-dispatch-guard.v1";
const LOG_DIRECTORY = "log";
const LOG_FILE = "hook.ndjson";
const LOG_SCHEMA_VERSION = "einzbern.hook-log.v1";
// The code the launcher reports on stderr for a failure that carries none of its own.
const UNCODED_FAILURE = "HOOK_LAUNCH_FAILED";

function absolute(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) ? value : null;
}

function payloadDirectory(cwd, body) {
  const workspacePath = Array.isArray(body?.workspacePaths) ? absolute(body.workspacePaths[0]) : null;
  return absolute(cwd) ?? absolute(body?.cwd) ?? workspacePath ?? process.cwd();
}

// One line in log/hook.ndjson for one recall, written as the launcher writes its note: the
// directory 0700, the file 0600, and every failure dropped.
function noteRecall(device, event, cwd, reasonCode, host, observation, versions = {}) {
  try {
    const logDirectory = join(device, LOG_DIRECTORY);
    try {
      mkdirSync(logDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") return;
    }
    const outcome = reasonCode === "HOOK_RECALL_ANSWERED" ? "hit" : reasonCode === "HOOK_RECALL_NO_HITS" ? "no-hit" : reasonCode === "HOOK_RECALL_PROMPT_EMPTY" ? "empty" : "refused-or-error";
    const line = { schemaVersion: LOG_SCHEMA_VERSION, at: new Date().toISOString(), event, cwd, reasonCode, host, ...(observation === undefined ? {} : { outcome, observation, ...versions }) };
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
export async function runHookEvent({ event, payload, libraryPath, cwd, peerGuardObserved = false } = {}) {
  // TCRN-CROSS-STORY-481 R2, R4: the stable launcher refuses older Node.js before it imports this
  // file. Keep this guard for direct callers too: a hook answers nothing, and the CLI is where the
  // floor is reported (ENGINE_NODE_TOO_OLD).
  if (!meetsNodeFloor(process.versions.node)) return null;
  const [{ hookEventName, hookHost, navigationPointerAnswer, promptRecallOutcome, hookProtocolOutput }, { deviceHome }, { kiroHookEventName }, { antigravityHookEventName }] = await Promise.all([
    import("../dist/build/packages/core/src/hook-recall.js"),
    import("../dist/build/packages/core/src/device-home.js"),
    import("../dist/build/packages/core/src/kiro-host.js"),
    import("../dist/build/packages/core/src/antigravity-host.js"),
  ]);
  // Observation is opt-in. Loading its version/cache dependencies before every
  // unobserved event changed startup allocation even on navigation-only paths.
  let observe;
  let versions;
  if (process.env.EINZBERN_RECALL_OBSERVATION === "1") {
    const [observation, cache, framework] = await Promise.all([
      import("../dist/build/packages/core/src/recall-observation.js"),
      import("../dist/build/packages/core/src/library-cache.js"),
      import("../dist/build/packages/core/src/framework-version.js"),
    ]);
    observe = observation.withRecallObservation;
    versions = { engineVersion: framework.FRAMEWORK_VERSION, projectionVersion: cache.CACHE_VIEWS_SCHEMA_VERSION };
  }
  const body = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  // Read once, for the recall and for its log line alike.
  const host = hookHost(process.env);
  const name = host === "kiro"
    ? (kiroHookEventName(event) ?? hookEventName(event))
    : host === "antigravity"
      ? (antigravityHookEventName(event) ?? hookEventName(event))
      : hookEventName(event);
  // Stale owned SubagentStop commands are inert until normal setup retires them.
  if (event === "subagent-stop") return host === "antigravity" ? "{}\n" : null;
  if (["UserPromptSubmit", "SubagentStart"].includes(name) && host === "codex" && !peerGuardObserved) {
    const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
    await runCodexPeerHook(name, body, deviceHome(process.env));
  }
  // DSH retains its existing navigation contract; its next feature batch is separate.
  if (name === "SubagentStart" && host === "dsh") {
    const result = `${navigationPointerAnswer(host, name).output}\n`;
    if (observe !== undefined) {
      const { observation } = await observe(async () => result);
      noteRecall(deviceHome(process.env), event, absolute(cwd) ?? absolute(body.cwd) ?? process.cwd(), "HOOK_RECALL_PROMPT_EMPTY", host, observation, versions);
    }
    return result;
  }
  switch (name) {
    case "PreToolUse": {
      const directory = payloadDirectory(cwd, body);
      if (host === "kiro") {
        const observation = kiroReadGuardObservation(body, directory);
        if (observation.status === "denied") {
          process.stderr.write(`${observation.reason}\n`);
          process.exitCode = 2;
        }
        noteRecall(deviceHome(process.env), event, directory, observation.reasonCode, host);
        return null;
      }
      if (host === "antigravity") {
        const observation = antigravityReadGuardObservation(body, directory);
        noteRecall(deviceHome(process.env), event, directory, observation.reasonCode, host);
        if (observation.status === "denied") {
          return `${JSON.stringify({ decision: "deny", reason: observation.reason })}\n`;
        }
        return `${JSON.stringify({ decision: "allow" })}\n`;
      }
      if (host === "codex" && !peerGuardObserved) {
        const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
        const result = await runCodexPeerHook(name, body, deviceHome(process.env));
        noteRecall(deviceHome(process.env), event, directory, result.reasonCode, host);
        if (result.output !== null) return result.output;
      }
      const answer = readGuardAnswer(body, directory, host);
      if (host !== "dsh") noteRecall(deviceHome(process.env), event, directory, answer === null ? "HOOK_READ_GUARD_OBSERVED" : "HOOK_READ_GUARD_DENIED", host);
      return answer;
    }
    case "PostToolUse":
    case "Stop": {
      if (host !== "codex") return host === "antigravity" ? "{}\n" : null;
      if (peerGuardObserved) return null;
      const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
      const result = await runCodexPeerHook(name, body, deviceHome(process.env));
      if (result.reasonCode !== "HOOK_PEER_NOT_APPLICABLE") {
        noteRecall(deviceHome(process.env), event, payloadDirectory(cwd, body), result.reasonCode, host);
      }
      return result.output;
    }
    case "SubagentStart":
    case "UserPromptSubmit": {
      if (typeof libraryPath !== "string") return host === "antigravity" ? "{}\n" : null;
      const directory = payloadDirectory(cwd, body);
      const device = deviceHome(process.env);
      if (host === "antigravity" && name === "UserPromptSubmit" && body.invocationNum !== undefined && body.invocationNum !== 0) {
        noteRecall(device, event, directory, "HOOK_ANTIGRAVITY_INVOCATION_SKIPPED", host);
        return "{}\n";
      }
      let outcome;
      let observation;
      try {
        // A payload without a prompt string is an empty prompt (HOOK_RECALL_PROMPT_EMPTY).
        const prompt = host === "kiro" && typeof process.env.USER_PROMPT === "string"
          ? process.env.USER_PROMPT
          : host === "antigravity" && typeof body.lastUserInput === "string"
            ? body.lastUserInput
            : (typeof body.prompt === "string" ? body.prompt : "");
        const operation = () => promptRecallOutcome({
          libraryPath,
          // Native SubagentStart has agent_type, not a task prompt. Never read
          // arbitrary transcript paths or claim task-specific injection from a made-up field.
          prompt: name === "SubagentStart" ? "" : prompt,
          event: name,
          host,
          cwd: directory,
        });
        if (observe !== undefined) {
          ({ value: outcome, observation } = await observe(operation, value => { observation = value; }));
        } else { outcome = await operation(); }
      } catch (error) {
        noteRecall(device, event, directory, typeof error?.reasonCode === "string" ? error.reasonCode : UNCODED_FAILURE, host, observation, versions);
        throw error;
      }
      noteRecall(device, event, directory, outcome.reasonCode, host, observation, versions);
      if (name === "SubagentStart") {
        const pointer = navigationPointerAnswer(host, name);
        return `${hookProtocolOutput(host, name, [...pointer.lines, ...(outcome.answer?.lines ?? [])])}\n`;
      }
      if (outcome.answer === null) return host === "antigravity" ? "{}\n" : null;
      return `${outcome.answer.output}\n`;
    }
    case "SessionStart":
      return `${navigationPointerAnswer(host, name).output}\n`;
    default:
      return host === "antigravity" ? "{}\n" : null;
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
  const reason = readGuardReason(payload, cwd);
  if (reason === null) return null;
  return `${JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  } })}\n`;
}

function readGuardReason(payload, cwd) {
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
    return `Read a window of at most 200 lines and ${AGENT_OUTPUT_MAX_BYTES} bytes. If one line exceeds the byte limit, extract a smaller excerpt with a tool.`;
  } catch {
    // An unreadable path, invalid input or filesystem exception must never block a tool.
    return null;
  }
}

/** Launcher-only role check before project resolution. No library recall or project access. */
export async function runPeerDispatchHookEvent({ event, payload, device } = {}) {
  if (!["pre-tool-use", "post-tool-use", "user-prompt-submit", "subagent-start", "stop"].includes(event)) return null;
  const { hookHost, hookEventName } = await import("../dist/build/packages/core/src/hook-recall.js");
  if (hookHost(process.env) !== "codex") return null;
  const { runCodexPeerHook } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
  const result = await runCodexPeerHook(hookEventName(event), payload, device);
  noteRecall(device, event, payload?.cwd ?? process.cwd(), result.reasonCode, "codex");
  return result.output;
}

/** Kiro only denies the documented Read shape; an unfamiliar tool payload stays unknown. */
function kiroReadGuardObservation(payload, cwd) {
  const input = payload?.tool_input;
  // Kiro CLI V3 names the built-in file reader `read_file`; its path argument is `path`.
  // No other read-like tool or undocumented payload is turned into an allow/deny decision.
  if (!payload || payload.tool_name !== "read_file" || input === null || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string" || input.path.length === 0) {
    return { status: "unknown", reasonCode: "HOOK_KIRO_PRETOOL_INPUT_UNKNOWN" };
  }
  try {
    const path = resolve(cwd, input.path);
    if (!statSync(path).isFile()) return { status: "unknown", reasonCode: "HOOK_KIRO_PRETOOL_INPUT_UNKNOWN" };
  } catch {
    return { status: "unknown", reasonCode: "HOOK_KIRO_PRETOOL_INPUT_UNKNOWN" };
  }
  const reason = readGuardReason({ ...payload, tool_name: "Read", tool_input: { ...input, file_path: input.path } }, cwd);
  return reason === null
    ? { status: "allowed", reasonCode: "HOOK_KIRO_PRETOOL_INPUT_OBSERVED" }
    : { status: "denied", reasonCode: "HOOK_KIRO_PRETOOL_INPUT_DENIED", reason };
}

/** Antigravity PreToolUse inspects toolCall.{name,args} for read_file and view_file (1-based inclusive StartLine..EndLine). */
function antigravityReadGuardObservation(payload, cwd) {
  const call = payload?.toolCall;
  const args = call !== null && typeof call === "object" && !Array.isArray(call) ? call.args : null;
  const rawPath =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? typeof args.Path === "string" && args.Path.length > 0
        ? args.Path
        : typeof args.AbsolutePath === "string" && args.AbsolutePath.length > 0
          ? args.AbsolutePath
          : null
      : null;
  if (!call || (call.name !== "read_file" && call.name !== "view_file") || rawPath === null) {
    return { status: "unknown", reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_UNKNOWN" };
  }
  let path;
  let file;
  try {
    path = resolve(cwd, rawPath);
    file = statSync(path);
    if (!file.isFile()) return { status: "unknown", reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_UNKNOWN" };
  } catch {
    return { status: "unknown", reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_UNKNOWN" };
  }
  if (file.size <= AGENT_OUTPUT_MAX_BYTES) {
    return { status: "allowed", reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_OBSERVED" };
  }
  try {
    const startLine = args.StartLine;
    const endLine = args.EndLine;
    const byteOffsetOk = args.ByteOffset === undefined || (Number.isSafeInteger(args.ByteOffset) && args.ByteOffset >= 0);
    const bounded =
      byteOffsetOk &&
      Number.isSafeInteger(startLine) &&
      startLine >= 1 &&
      Number.isSafeInteger(endLine) &&
      endLine >= startLine &&
      endLine - startLine + 1 <= 200;
    if (bounded && !readWindowExceedsLimit(path, startLine, endLine - startLine + 1)) {
      return { status: "allowed", reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_OBSERVED" };
    }
    return {
      status: "denied",
      reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_DENIED",
      reason: `Read a window of at most 200 lines and ${AGENT_OUTPUT_MAX_BYTES} bytes (set StartLine and EndLine with EndLine - StartLine + 1 <= 200). If one line exceeds the byte limit, extract a smaller excerpt with a tool.`,
    };
  } catch {
    return { status: "unknown", reasonCode: "HOOK_ANTIGRAVITY_PRETOOL_INPUT_UNKNOWN" };
  }
}
