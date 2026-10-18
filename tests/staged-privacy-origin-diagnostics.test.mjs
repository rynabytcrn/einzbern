// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const checker = resolve(import.meta.dirname, "../scripts/verify-staged-privacy.mjs");

test("a rejected origin diagnostic does not echo synthetic credential userinfo", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-origin-diagnostic-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dummyUserinfo = ["fixture-user", "fixture-password"].join(":");
  const origin = ["https://", dummyUserinfo, "@example.invalid/unrelated.git"].join("");
  for (const args of [["init", "-q"], ["remote", "add", "origin", origin]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).reasonCode, "PRIVACY_ORIGIN_UNEXPECTED");
  assert.equal(result.stderr.includes(dummyUserinfo), false, "refusal must not echo origin userinfo");
  assert.equal(result.stderr.includes(origin), false, "refusal must not echo the rejected origin");
});
