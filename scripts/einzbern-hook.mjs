#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R2 (MIN-227 D5): the hook entry of one engine version. The stable
// launcher in the device directory (scripts/einzbern-hook-launcher.mjs, installed as
// engine/hook.mjs) imports this file from engine/<current version>/ only after the prompt's
// directory matched a project in this device's registry, and prints what runHookEvent returns.
// The hook holds no rule of its own (D5): which event is answered and what the answer carries is
// decided here, by the engine version that is current. In the development tree it reads the
// build (dist/build); a release carries it as one file (TCRN-CROSS-STORY-481).
// TCRN-CROSS-STORY-478 R4: session-start and subagent-start, the pointer hooks of a device that
// declined the navigation section, are answered with the navigation lines alone; they read nothing.
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

import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { meetsNodeFloor } from "../dist/build/packages/core/src/node-floor.js";

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
  const [{ hookEventName, hookHost, navigationPointerAnswer, promptRecallOutcome }, { deviceHome }] = await Promise.all([
    import("../dist/build/packages/core/src/hook-recall.js"),
    import("../dist/build/packages/core/src/device-home.js"),
  ]);
  const body = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const name = hookEventName(event);
  // Read once, for the recall and for its log line alike.
  const host = hookHost(process.env);
  switch (name) {
    case "UserPromptSubmit": {
      if (typeof libraryPath !== "string") return null;
      const directory = absolute(cwd) ?? absolute(body.cwd) ?? process.cwd();
      const device = deviceHome(process.env);
      let outcome;
      try {
        // A payload without a prompt string is an empty prompt (HOOK_RECALL_PROMPT_EMPTY).
        outcome = await promptRecallOutcome({
          libraryPath,
          prompt: typeof body.prompt === "string" ? body.prompt : "",
          host,
          cwd: directory,
        });
      } catch (error) {
        noteRecall(device, event, directory, typeof error?.reasonCode === "string" ? error.reasonCode : UNCODED_FAILURE, host);
        throw error;
      }
      noteRecall(device, event, directory, outcome.reasonCode, host);
      return outcome.answer === null ? null : `${outcome.answer.output}\n`;
    }
    case "SessionStart":
    case "SubagentStart":
      return `${navigationPointerAnswer(host, name).output}\n`;
    default:
      return null;
  }
}
