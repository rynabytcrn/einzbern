// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { summarizeGateResult } from "../scripts/preflight.mjs";
import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
function section(text, start, end) {
  assert.equal(text.split(start).length, 2, start);
  const tail = text.slice(text.indexOf(start));
  assert.ok(tail.includes(end), end);
  return tail.slice(0, tail.indexOf(end));
}
test("audit: compiler process failure survives empty diagnostic filtering", async () => {
  const body = section(await source("scripts/task.mjs"), '  let diagnostics = "";', '  return success("TYPECHECK_VERIFIED"');
  class LocalCommandError extends Error {}
  const check = new Function("run", "LocalCommandError", "assertion", "process", "compiler", "invocation", body);
  const assertion = (ok, reason) => { if (!ok) throw new Error(reason); };
  const invoke = (run) => check(run, LocalCommandError, assertion, { execPath: "node" }, "tsc.js", []);
  assert.doesNotThrow(() => invoke(() => ""));
  assert.throws(() => invoke(() => { throw new LocalCommandError("node tsc.js --noEmit"); }), /TYPECHECK_/u);
  assert.throws(() => invoke(() => "warning"), /TYPECHECK_DIAGNOSTIC/u);
});
test("audit: final preflight status requires a successful clean result", () => {
  const command = ["git", "status", "--porcelain=v1", "--untracked-files=all"];
  for (const [status, stdout, expected] of [[0, "", true], [0, " M fixture.txt\n", false], [1, "", false], [null, "", false]]) {
    assert.equal(summarizeGateResult("checkout-clean", command, { status, stdout }).ok, expected);
  }
});
test("audit: final push status failure cannot pass", async () => {
  const body = section(await source("scripts/push-gate.mjs"), '  const post = run("git",', '\n});');
  const judge = new Function("run", "fail", body);
  const fail = (reason) => { throw new Error(reason); };
  assert.doesNotThrow(() => judge(() => ({ ok: true, output: "" }), fail));
  assert.throws(() => judge(() => ({ ok: false, output: "unavailable" }), fail), /PUSH_GATE_GIT_UNAVAILABLE/u);
  assert.throws(() => judge(() => ({ ok: true, output: " M fixture" }), fail), /PUSH_GATE_GATES_MUTATED_SOURCE/u);
});
test("audit: rejected isolated origin diagnostic is value-free", async () => {
  const body = section(await source("scripts/isolated-proof.mjs"), 'if (!ENGINE_REPOSITORY_NAMES.some', '\n\nconst temporary');
  const judge = new Function("origin", "ENGINE_REPOSITORY_NAMES", body);
  assert.doesNotThrow(() => judge("https://github.com/public-owner/example.git", ["example"]));
  const dummyUserinfo = ["dummy-user", "dummy-password"].join(":");
  const origin = ["https://", dummyUserinfo, "@example.invalid/example.git"].join("");
  assert.throws(() => judge(origin, ["example"]), (error) => error.message === "ISOLATED_ORIGIN_INVALID");
});
test("audit: benchmark accepts the synthesizer library path", async () => {
  const text = await source("scripts/bench/bench-replay.mjs");
  const body = section(text, "if (!workspace", "\n\nconst VERBS");
  const judge = new Function("workspace", "process", body);
  const process = { stderr: { write() {} }, exit(code) { throw new Error(`exit:${code}`); } };
  assert.doesNotThrow(() => judge("/tmp/synthetic/ws-100/library", process));
  assert.throws(() => judge("/tmp/synthetic/unrelated", process), /exit:2/u);
  assert.match(await source("scripts/bench/synthesize-chain.mjs"), /join\(wsDir, "library"\)/u);
});
test("audit: protocol proof evaluator identity matches installed Ajv", async () => {
  const text = await source("scripts/lib/protocol-proof.mjs");
  const require = createRequire(new URL("../scripts/lib/protocol-proof.mjs", import.meta.url));
  const version = require("ajv/package.json").version;
  assert.ok(text.includes(`ajv@${version}-draft-2020-12`));
});
for (const { name, commit, digest } of [
  { name: "PR24", commit: "b543cd4365fc388f1d217b8caecace24cf2836f1", digest: "de36be9877b705c41d86e3aed18fc252925f93aebd432e8a789746f0a2a23751" },
  { name: "PR25", commit: "c653cc387e72fdcba55370676d7246cd8d2efacd", digest: "de825bf72a84bbb476cb6557f6bc9fed6f7c8ea8e81acaf635e32fa20ffc98cb" },
]) test(`audit: ${name} reviewed merge classification is exact in commit and full line`, async (context) => {
  const result = spawnSync("git", ["cat-file", "commit", commit], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  if (result.status !== 0) { context.skip("reviewed historical commit unavailable in this clone"); return; }
  const names = await source("packages/core/src/names.ts");
  const upstreamOwner = /owner:\s*"([^"]+)"/u.exec(names)?.[1];
  assert.ok(upstreamOwner);
  const subject = result.stdout.split("\n").find((line) => createHash("sha256").update(line).digest("hex") === digest);
  assert.ok(subject);
  const owner = /^Merge pull request #\d+ from ([^/\s]+)\//u.exec(subject)?.[1];
  assert.ok(owner);
  assert.deepEqual(scanPrivacyEntries([{ label: `git-commit:${commit}`, kind: "commit", content: result.stdout }], { owner: upstreamOwner }), []);
  const scan = (label, content, kind = "commit") => scanPrivacyEntries([{ label, kind, content }], { owner });
  assert.deepEqual(scan(`git-commit:${commit}`, result.stdout), []);
  assert.ok(scan(`git-commit:${"a".repeat(40)}`, subject).length > 0);
  assert.ok(scan(`git-commit:${commit}`, `${subject} changed`).length > 0);
  assert.ok(scan(`git-commit:${commit}`, subject, "blob").length > 0);
  assert.ok(scan(`git-commit:${commit}`, subject, "tag").length > 0);
  assert.ok(scan(`git-commit:${commit}`, `${result.stdout}\nprivate ${owner}`).length > 0);
});
