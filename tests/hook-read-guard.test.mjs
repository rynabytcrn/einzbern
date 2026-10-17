// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readGuardAnswer, runHookEvent } from "../scripts/einzbern-hook.mjs";

test("BL35: dedicated Read denies only large, unbounded reads; all other tools and exceptions fail open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-read-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "boundary"), "x".repeat(32768));
  await writeFile(join(root, "large"), "x".repeat(32769));
  const payload = (file_path, limit) => ({ tool_name: "Read", tool_input: { file_path, ...(limit === undefined ? {} : { limit }) } });
  for (const host of ["claude-code", "codex"]) {
    assert.equal(readGuardAnswer(payload("boundary"), root, host), null);
    for (const limit of [undefined, 201, 0, -1, null, "200", 1.5]) {
      const denied = JSON.parse(readGuardAnswer(payload("large", limit), root, host));
      assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    }
    for (const limit of [1, 200]) assert.equal(readGuardAnswer(payload("large", limit), root, host), null);
    for (const tool_name of ["Bash", "Shell", "shell", "exec_command", "read_file", "mcp__Read"]) {
      assert.equal(readGuardAnswer({ ...payload("large"), tool_name }, root, host), null);
    }
    for (const input of [null, {}, { tool_name: "Read", tool_input: null }, payload("absent"), payload(".")]) {
      assert.equal(readGuardAnswer(input, root, host), null);
    }
  }
  assert.equal(readGuardAnswer(payload("large"), root, "dsh"), null, "DSH is outside this batch");
  const previous = process.env.EINZBERN_HOST;
  process.env.EINZBERN_HOST = "claude-code";
  try {
    const answer = await runHookEvent({ event: "pre-tool-use", payload: payload("large"), cwd: root });
    assert.equal(JSON.parse(answer).hookSpecificOutput.permissionDecision, "deny", "engine dispatch reaches guard");
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_HOST;
    else process.env.EINZBERN_HOST = previous;
  }
});
