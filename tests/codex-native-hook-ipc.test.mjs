// SPDX-License-Identifier: Apache-2.0
// Retired-hook fixtures only. No socket server, RPC or real host is started.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { runHookEvent } from "../scripts/einzbern-hook.mjs";

test("the old IPC helper is not shipped as an active fallback", async () => {
  await assert.rejects(access(new URL("../scripts/lib/codex-native-hook-ipc.mjs", import.meta.url)), { code: "ENOENT" });
});

test("stale stop/wait invocations cannot reactivate transport even with stale payload and environment", async t => {
  const keys = ["EINZBERN_HOST", "EINZBERN_CODEX_NATIVE_HOOK_SOCKET"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } });
  process.env.EINZBERN_CODEX_NATIVE_HOOK_SOCKET = "/nonexistent/retired/socket";
  for (const host of ["codex", "claude-code", "dsh", "chatgpt-dot", "unknown"]) {
    process.env.EINZBERN_HOST = host;
    for (const event of ["subagent-stop", "collector-wait"]) {
      assert.equal(await runHookEvent({ event, payload: { agent_id: "old-collector", last_assistant_message: "EINZBERN_SUBAGENT_STOP_V1 {}" }, nativeController: { handleSubagentStop() { throw new Error("must not call retired controller"); } } }), null, `${host}/${event}`);
    }
  }
});
