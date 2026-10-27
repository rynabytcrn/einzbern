// SPDX-License-Identifier: Apache-2.0
// Real local transport and installed-launcher fixtures; not native Codex acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createCodexNativeHookBridge, requestCodexNativeHookDecision, waitCodexNativeCollector } from "../scripts/lib/codex-native-hook-ipc.mjs";

const root = resolve(import.meta.dirname, "..");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "en-ipc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const controller = { capability: "ready", async handleSubagentStop({ payload }) {
    calls.push(payload);
    return payload.agent_id === "collector"
      ? { matched: true, decision: "block", reason: "exact raw fixture" }
      : { matched: false, decision: "allow" };
  } };
  const bridge = await createCodexNativeHookBridge({ controller, socketPath: join(directory, "h"), timeoutMs: 2_000 });
  t.after(() => bridge.close());
  return { directory, bridge, calls };
}

test("private local hook transport preserves decisions and removes its socket on close", async t => {
  const { bridge, calls } = await fixture(t);
  assert.equal((await lstat(bridge.socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(await requestCodexNativeHookDecision({ socketPath: bridge.socketPath, payload: { agent_id: "worker" }, timeoutMs: 2_000 }), { matched: false, decision: "allow" });
  assert.equal((await requestCodexNativeHookDecision({ socketPath: bridge.socketPath, payload: { agent_id: "collector" }, timeoutMs: 2_000 })).decision, "block");
  assert.deepEqual(calls.map(call => call.agent_id), ["worker", "collector"]);
  await bridge.close();
  await assert.rejects(() => lstat(bridge.socketPath), { code: "ENOENT" });
});

test("transport refuses a shared directory and propagates controller query failures", async t => {
  const { directory, bridge } = await fixture(t);
  const shared = join(directory, "shared");
  await mkdir(shared);
  await chmod(shared, 0o755);
  await assert.rejects(() => createCodexNativeHookBridge({ controller: { capability: "ready", handleSubagentStop: async () => ({}) }, socketPath: join(shared, "h") }), /DIRECTORY_NOT_PRIVATE/u);
  const broken = await createCodexNativeHookBridge({ controller: { capability: "ready", handleSubagentStop: async () => { throw new Error("query failed"); } }, socketPath: join(directory, "b"), timeoutMs: 2_000 });
  t.after(() => broken.close());
  await assert.rejects(() => requestCodexNativeHookDecision({ socketPath: broken.socketPath, payload: {}, timeoutMs: 2_000 }), /query failed/u);
  assert.equal((await lstat(bridge.socketPath)).isSocket(), true);
});

test("the normal installed launcher reaches the owner controller through its isolated environment", async t => {
  const { directory, bridge, calls } = await fixture(t);
  const home = join(directory, "device");
  const engine = join(home, "engine");
  const scripts = join(engine, "3.3.1", "scripts");
  await mkdir(scripts, { recursive: true });
  const launcher = join(engine, "hook.mjs");
  await copyFile(join(root, "scripts/einzbern-hook-launcher.mjs"), launcher);
  await writeFile(join(scripts, "einzbern-hook.mjs"), `export { runHookEvent } from ${JSON.stringify(pathToFileURL(join(root, "scripts/einzbern-hook.mjs")).href)};\n`);
  await writeFile(join(engine, "current"), JSON.stringify({ schemaVersion: "einzbern.engine-current.v1", version: "3.3.1", previous: null, switchedAt: "2026-10-27T00:00:00Z" }));
  await writeFile(join(home, "registry.json"), JSON.stringify({ schemaVersion: "einzbern.registry.v1", entries: [{ projectPath: directory, libraryPath: join(directory, "library"), gitRemote: null }] }));
  async function launch(agent_id) {
    const child = spawn(process.execPath, [launcher, "subagent-stop"], { cwd: directory, env: { ...process.env, EINZBERN_HOME: home, EINZBERN_HOST: "codex", EINZBERN_CODEX_NATIVE_HOOK_SOCKET: bridge.socketPath }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
    child.stdin.end(JSON.stringify({ cwd: directory, agent_id }));
    assert.equal(await done, 0, stderr);
    return JSON.parse(stdout);
  }
  assert.deepEqual(await launch("worker"), {});
  assert.deepEqual(await launch("collector"), { decision: "block", reason: "exact raw fixture" });
  assert.deepEqual(calls.map(call => call.agent_id), ["worker", "collector"]);
});


test("bridge helper is separate from stop and disconnect aborts owned work", async t => {
  const directory = await mkdtemp(join(tmpdir(), "en-helper-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let stopped = 0, waited = 0, aborted = false;
  const controller = { capability: "ready", handleSubagentStop: async () => { stopped++; return { matched: false, decision: "allow" }; }, waitCollector: async ({ payload, signal }) => {
    waited++; if (payload.hang) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
    return { status: "waited" };
  } };
  const bridge = await createCodexNativeHookBridge({ controller, socketPath: join(directory, "h"), timeoutMs: 50 }); t.after(() => bridge.close());
  assert.equal((await waitCodexNativeCollector({ socketPath: bridge.socketPath, payload: {}, timeoutMs: 50 })).status, "waited");
  assert.equal(stopped, 0); assert.equal(waited, 1);
  const pending = waitCodexNativeCollector({ socketPath: bridge.socketPath, payload: { hang: true }, timeoutMs: 50 });
  await assert.rejects(pending, /TIMEOUT|INCOMPLETE/u); await bridge.close(); assert.equal(aborted, true);
});


test("normal versioned helper CLI invokes helper route without a stop callback", async t => {
  const directory = await mkdtemp(join(tmpdir(), "en-helper-cli-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let stops = 0, waits = 0;
  const controller = { capability: "ready", handleSubagentStop: async () => { stops++; return { matched: false, decision: "allow" }; }, waitCollector: async ({ payload }) => { assert.equal(payload.attemptId, "fixture"); waits++; return { status: "waited" }; } };
  const bridge = await createCodexNativeHookBridge({ controller, socketPath: join(directory, "h"), timeoutMs: 2000 }); t.after(() => bridge.close());
  const child = spawn(process.execPath, [join(root, "scripts/einzbern-hook.mjs"), "collector-wait", JSON.stringify({ attemptId: "fixture" })], { env: { ...process.env, EINZBERN_HOST: "codex", EINZBERN_CODEX_NATIVE_HOOK_SOCKET: bridge.socketPath }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { error += bytes; });
  const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("exit", resolveCode); });
  assert.equal(code, 0, error); assert.equal(JSON.parse(output).status, "waited"); assert.equal(waits, 1); assert.equal(stops, 0);
});
