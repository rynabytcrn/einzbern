// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readGuardAnswer, runHookEvent } from "../scripts/einzbern-hook.mjs";

test("BL35: dedicated Read bounds large windows by bytes and lines and retains its tool and host scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-read-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "boundary"), "x".repeat(32768));
  await writeFile(join(root, "large"), JSON.stringify({ diagnostic: "界".repeat(11000) }));
  await writeFile(join(root, "multi"), `${"界".repeat(6000)}\n${"界".repeat(6000)}\n${"small\n".repeat(215)}`);
  await writeFile(join(root, "windows"), `${"x".repeat(32767)}\n${"x".repeat(32768)}\nshort`);
  const payload = (file_path, limit, offset) => ({
    tool_name: "Read",
    tool_input: { file_path, ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) },
  });
  function assertDenied(input, host) {
    const denied = JSON.parse(readGuardAnswer(input, root, host));
    assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /32768 bytes/u);
  }
  for (const host of ["claude-code", "codex"]) {
    assert.equal(readGuardAnswer(payload("boundary"), root, host), null);
    for (const limit of [undefined, 1, 200, 201, 0, -1, null, "200", 1.5]) {
      assertDenied(payload("large", limit), host);
    }
    assertDenied(payload("multi", 2), host);
    assertDenied(payload("multi", 200, 1), host);
    assertDenied(payload("multi", 201, 3), host);
    assert.equal(readGuardAnswer(payload("multi", 1), root, host), null);
    assert.equal(readGuardAnswer(payload("multi", 2, 2), root, host), null);
    assert.equal(readGuardAnswer(payload("multi", 200, 3), root, host), null);
    assert.equal(readGuardAnswer(payload("windows", 1, 1), root, host), null, "a full 32 KiB window fits");
    assertDenied(payload("windows", 1, 2), host);
    assert.equal(readGuardAnswer(payload("windows", 1, 3), root, host), null, "a short window after long lines fits");
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
