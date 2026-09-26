#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R2 (MIN-227 D5): the hook entry of one engine version. The stable
// launcher in the device directory (scripts/einzbern-hook-launcher.mjs, installed as
// engine/hook.mjs) imports this file from engine/<current version>/ only after the prompt's
// directory matched a project in this device's registry, and prints what runHookEvent returns.
// The hook holds no rule of its own (D5): which event is answered and what the answer carries is
// decided here, by the engine version that is current. In the development tree it reads the
// build (dist/build); a release carries it as one file (TCRN-CROSS-STORY-481).

import { isAbsolute } from "node:path";

import { assertNodeFloor } from "../dist/build/packages/core/src/node-floor.js";

function absolute(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value) ? value : null;
}

/**
 * Answer one hook event. `event` is the word on the hook's command line (user-prompt-submit),
 * `payload` the JSON object the host wrote on stdin, `libraryPath` the library of the registry
 * entry the launcher matched and `cwd` the directory it matched from (the payload's cwd, or this
 * process's, when left out). Returns the text for stdout, or null when the hook prints nothing.
 */
export async function runHookEvent({ event, payload, libraryPath, cwd } = {}) {
  // TCRN-CROSS-STORY-481 R4: an older Node.js is refused before the rest of the engine loads.
  assertNodeFloor(process.versions.node);
  const { hookEventName, hookHost, promptRecallContext } = await import("../dist/build/packages/core/src/hook-recall.js");
  const body = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  switch (hookEventName(event)) {
    case "UserPromptSubmit": {
      if (typeof libraryPath !== "string" || typeof body.prompt !== "string") return null;
      const answer = await promptRecallContext({
        libraryPath,
        prompt: body.prompt,
        host: hookHost(process.env),
        cwd: absolute(cwd) ?? absolute(body.cwd) ?? process.cwd(),
      });
      return answer === null ? null : `${answer.output}\n`;
    }
    default:
      return null;
  }
}
