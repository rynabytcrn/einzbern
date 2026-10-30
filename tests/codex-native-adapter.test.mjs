// SPDX-License-Identifier: Apache-2.0
// Source/API retirement checks, not native host acceptance or a transport simulation.
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import * as core from "../dist/build/packages/core/src/index.js";

const source = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
test("the collector controller and its cap exemption are absent from the public API", async () => {
  for (const name of ["codexNativeDynamicToolSpecs", "createCodexNativeController", "handleCodexSubagentStop", "evaluateCodexCollectorStop", "validateCodexCollectorCapacity", "CODEX_COLLECTOR_INITIAL_PROGRESS"]) {
    assert.equal(Object.hasOwn(core, name), false, name);
  }
  await assert.rejects(access(new URL("../packages/core/src/codex-subagent-stop.ts", import.meta.url)), { code: "ENOENT" });
  assert.doesNotMatch(await source("packages/core/src/index.ts"), /codex-subagent-stop/u);
});

test("the installed hook has no collector controller, wait command or IPC fallback", async () => {
  const hook = await source("scripts/einzbern-hook.mjs");
  for (const marker of ["collector-wait", "nativeController", "requestCodexNativeHookDecision", "waitCodexNativeCollector", "EINZBERN_CODEX_NATIVE_HOOK_SOCKET", "codex-native-hook-ipc"]) assert.equal(hook.includes(marker), false, marker);
});
