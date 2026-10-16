// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-483 (TCRN-CROSS-STORY-529 GWT4, MIN-257 D6): every prompt the hook recalls for in a
// registered project leaves one line in log/hook.ndjson in the device directory, with at, event,
// cwd and the reasonCode of what recall gave (promptRecallOutcome): answered, no hits, an empty
// prompt, a library the registry no longer confirms, or the code of the failure itself. The line
// has the launcher's shape (einzbern.hook-log.v1) without container and marker. A line that cannot
// be written is dropped, and the hook prints exactly what it printed with a writable log.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { FRAMEWORK_VERSION, createProject, createWork, initializeLibrary, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { HOOK_RECALL_OUTCOME_CODES, hookProtocolOutput, promptRecallContext, promptRecallOutcome } from "../dist/build/packages/core/src/hook-recall.js";
import { HOST_HOOK_LAUNCHER } from "../dist/build/packages/core/src/host-hooks.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const REMOTE = "https://zoo-host/owner/zoo.git";
const PROMPT = "How should the zebrafish tank be filled?";
const QUIET = "rename parser module, rerun compiler";
const at = (second) => `2026-10-14T12:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);
const STORY_LINE = `[Story planned] Zebrafish tank · HOOK-STORY · ${idOf("HOOK-STORY")} · Wetland epic ‹ Aviary initiative`;
// TCRN-CROSS-STORY-548 R3: host follows reasonCode, an additive field of einzbern.hook-log.v1.
const RECALL_KEYS = ["schemaVersion", "at", "event", "cwd", "reasonCode", "host"];
// What a v1 reader written before the host field takes from each line.
const V1_KEYS = ["schemaVersion", "at", "event", "cwd", "reasonCode"];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-hook-recall-log-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return { base, home };
}

/** This build installed the way an installer does: engine/<version>/, engine/current and the launcher. */
async function installEngine(home) {
  const engine = join(home, "engine");
  const tree = join(engine, FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook.mjs"), join(tree, "scripts/einzbern-hook.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  await writeFile(join(engine, "current"), `${JSON.stringify({ previous: null, schemaVersion: "einzbern.engine-current.v1", switchedAt: at(0), version: FRAMEWORK_VERSION })}\n`);
  const installed = join(engine, HOST_HOOK_LAUNCHER);
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), installed);
  return installed;
}

/** A Git working tree with a three-record library in .ether, registered on this device. */
async function registeredProject(base) {
  const directory = join(base, "project");
  await mkdir(join(directory, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", directory], { env: GIT_ENV });
  execFileSync("git", ["-C", directory, "remote", "add", "origin", REMOTE], { env: GIT_ENV });
  const library = join(directory, ".ether");
  await initializeLibrary({ root: library, createdAt: at(0) });
  const projectId = (await createProject(library, { occurredAt: at(1), externalKey: "HOOK-PROJECT", name: "Hook" })).projects[0].id;
  await createWork(library, {
    occurredAt: at(2), projectId, externalKey: "HOOK-INIT", kind: "Initiative", parentId: null, title: "Aviary initiative",
    scope: "## Goal\nBuild the heron aviary.",
  });
  await createWork(library, { occurredAt: at(3), projectId, externalKey: "HOOK-EPIC", kind: "Epic", parentId: idOf("HOOK-INIT"), title: "Wetland epic", goal: "Keep the flamingo pond." });
  await createWork(library, {
    occurredAt: at(4), projectId, externalKey: "HOOK-STORY", kind: "Story", parentId: idOf("HOOK-EPIC"), title: "Zebrafish tank",
    goal: "Give the zebrafish a tank.", acceptance: "GIVEN the tank WHEN it is filled THEN the zebrafish swim",
  });
  // As in tests/hook-launcher.test.mjs: a three-record library lowers the strong-hit threshold.
  await setWorkspaceSetting(library, { occurredAt: at(5), key: "retrieval.tau", value: "1" });
  await registerLibrary({ projectPath: directory, libraryPath: library, registeredAt: at(9) });
  return { directory, library };
}

function runHook(launcherPath, { home, cwd, prompt = PROMPT, event = "user-prompt-submit", env = {} }) {
  const payload = { session_id: "hook-recall-log-test", transcript_path: join(home, "transcript.jsonl"), cwd, hook_event_name: "UserPromptSubmit", prompt };
  return spawnSync(process.execPath, [launcherPath, event], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...withoutHost(process.env), EINZBERN_HOME: home, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
}

function withoutHost(env) {
  const copy = { ...env };
  delete copy.EINZBERN_HOST;
  return copy;
}

async function hookLog(home) {
  try {
    return (await readFile(join(home, "log", "hook.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const summary = (line) => [line.event, line.cwd, line.reasonCode];

test("SUB-483: the outcome codes, and promptRecallContext still gives the outcome's answer", async (context) => {
  assert.deepEqual([...HOOK_RECALL_OUTCOME_CODES], ["HOOK_RECALL_ANSWERED", "HOOK_RECALL_NO_HITS", "HOOK_RECALL_PROMPT_EMPTY", "HOOK_RECALL_LIBRARY_UNCONFIRMED"]);
  const { base } = await scratch(context);
  const { directory, library } = await registeredProject(base);
  const request = { libraryPath: library, prompt: PROMPT, host: "claude-code", cwd: join(directory, "src"), at: at(20) };
  const answered = await promptRecallOutcome(request);
  assert.equal(answered.reasonCode, "HOOK_RECALL_ANSWERED");
  assert.deepEqual(answered.answer, { lines: [STORY_LINE], output: hookProtocolOutput("claude-code", "UserPromptSubmit", [STORY_LINE]) });
  assert.deepEqual(await promptRecallContext(request), answered.answer);
  for (const [prompt, reasonCode] of [[QUIET, "HOOK_RECALL_NO_HITS"], [" \n\t", "HOOK_RECALL_PROMPT_EMPTY"]]) {
    assert.deepEqual(await promptRecallOutcome({ ...request, prompt }), { answer: null, reasonCode }, prompt);
    assert.equal(await promptRecallContext({ ...request, prompt }), null, prompt);
  }
  const elsewhere = { ...request, libraryPath: join(base, "elsewhere", ".ether") };
  assert.deepEqual(await promptRecallOutcome(elsewhere), { answer: null, reasonCode: "HOOK_RECALL_LIBRARY_UNCONFIRMED" });
  await assert.rejects(promptRecallOutcome({ ...request, libraryPath: "" }), { reasonCode: "HOOK_INPUT_INVALID" });
});

test("SUB-483 (GWT4): each prompt the launcher passes to a registered project's recall adds one line naming why", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory } = await registeredProject(base);
  const cwd = join(directory, "src");
  await assert.rejects(stat(join(home, "log")), { code: "ENOENT" }, "nothing has been logged yet");

  const answered = runHook(launcherPath, { home, cwd });
  assert.deepEqual([answered.status, answered.stderr], [0, ""]);
  assert.equal(answered.stdout, `${hookProtocolOutput("claude-code", "UserPromptSubmit", [STORY_LINE])}\n`, "the answer is unchanged");
  let log = await hookLog(home);
  assert.equal(log.length, 1);
  assert.deepEqual(Object.keys(log[0]), RECALL_KEYS);
  assert.deepEqual({ ...log[0], at: undefined }, { schemaVersion: "einzbern.hook-log.v1", at: undefined, event: "user-prompt-submit", cwd, reasonCode: "HOOK_RECALL_ANSWERED", host: "claude-code" });
  assert.equal(new Date(log[0].at).toISOString(), log[0].at);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(home, "log"))).mode & 0o777, 0o700, "the log directory is the user's alone");
    assert.equal((await stat(join(home, "log", "hook.ndjson"))).mode & 0o777, 0o600, "the log file is the user's alone");
  }

  // A prompt without a strong hit and an empty one print nothing, and each still leaves its line.
  for (const prompt of [QUIET, "   "]) {
    const quiet = runHook(launcherPath, { home, cwd: directory, prompt });
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""], prompt);
  }
  // A pointer hook reads nothing and recalls nothing, so it leaves no line.
  const pointer = runHook(launcherPath, { home, cwd: directory, event: "session-start" });
  assert.deepEqual([pointer.status, pointer.stderr], [0, ""]);
  assert.notEqual(pointer.stdout, "");
  log = await hookLog(home);
  assert.deepEqual(log.map(summary), [
    ["user-prompt-submit", cwd, "HOOK_RECALL_ANSWERED"],
    ["user-prompt-submit", directory, "HOOK_RECALL_NO_HITS"],
    ["user-prompt-submit", directory, "HOOK_RECALL_PROMPT_EMPTY"],
  ]);
  assert.ok(log.every((line) => Object.keys(line).join() === RECALL_KEYS.join()));
});

test("SUB-483: a library the registry no longer confirms and a failed recall are noted with their codes", async (context) => {
  const { base, home } = await scratch(context);
  const { directory } = await registeredProject(base);
  const { runHookEvent } = await import(pathToFileURL(join(repositoryRoot, "scripts/einzbern-hook.mjs")).href);
  const elsewhere = join(base, "elsewhere", ".ether");
  assert.equal(await runHookEvent({ event: "user-prompt-submit", payload: { prompt: PROMPT }, libraryPath: elsewhere, cwd: directory }), null);
  // A failure is passed on as before; its own code is what the line names.
  await assert.rejects(runHookEvent({ event: "user-prompt-submit", payload: { prompt: PROMPT }, libraryPath: "", cwd: directory }), { reasonCode: "HOOK_INPUT_INVALID" });
  // A payload without a prompt string is an empty prompt.
  assert.equal(await runHookEvent({ event: "user-prompt-submit", payload: {}, libraryPath: elsewhere, cwd: directory }), null);
  assert.deepEqual((await hookLog(home)).map(summary), [
    ["user-prompt-submit", directory, "HOOK_RECALL_LIBRARY_UNCONFIRMED"],
    ["user-prompt-submit", directory, "HOOK_INPUT_INVALID"],
    ["user-prompt-submit", directory, "HOOK_RECALL_PROMPT_EMPTY"],
  ]);
});

test("SUB-483: a log that cannot be written changes nothing the hook prints, and is left as it was", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory } = await registeredProject(base);
  const triple = (run) => [run.status, run.stdout, run.stderr];
  const expected = new Map();
  for (const prompt of [PROMPT, QUIET]) expected.set(prompt, triple(runHook(launcherPath, { home, cwd: directory, prompt })));
  assert.equal((await hookLog(home)).length, 2);
  assert.notEqual(expected.get(PROMPT)[1], "");

  // log is a file: its directory cannot be made.
  await rm(join(home, "log"), { recursive: true });
  await writeFile(join(home, "log"), "not a directory\n");
  for (const prompt of [PROMPT, QUIET]) assert.deepEqual(triple(runHook(launcherPath, { home, cwd: directory, prompt })), expected.get(prompt), prompt);
  assert.equal(await readFile(join(home, "log"), "utf8"), "not a directory\n");

  // hook.ndjson is a directory: the line cannot be appended.
  await rm(join(home, "log"));
  await mkdir(join(home, "log", "hook.ndjson"), { recursive: true });
  for (const prompt of [PROMPT, QUIET]) assert.deepEqual(triple(runHook(launcherPath, { home, cwd: directory, prompt })), expected.get(prompt), prompt);
  assert.ok((await stat(join(home, "log", "hook.ndjson"))).isDirectory());
});

test("548-R3: a recall line names the host EINZBERN_HOST declares, and a v1 reader still reads every line", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory } = await registeredProject(base);
  const claude = runHook(launcherPath, { home, cwd: directory });
  const dsh = runHook(launcherPath, { home, cwd: directory, env: { EINZBERN_HOST: "dsh" } });
  const codex = runHook(launcherPath, { home, cwd: directory, prompt: QUIET, env: { CLAUDE_PROJECT_DIR: "" } });
  for (const run of [claude, dsh, codex]) assert.deepEqual([run.status, run.stderr], [0, ""]);
  assert.equal(dsh.stdout, claude.stdout, "dsh reads the same protocol");
  const log = await hookLog(home);
  assert.deepEqual(log.map((line) => [line.reasonCode, line.host]), [
    ["HOOK_RECALL_ANSWERED", "claude-code"],
    ["HOOK_RECALL_ANSWERED", "dsh"],
    ["HOOK_RECALL_NO_HITS", "codex"],
  ]);
  assert.ok(log.every((line) => line.schemaVersion === "einzbern.hook-log.v1"), "the schema version is unchanged");
  // A v1 reader picks its five keys and ignores the rest; each line reads as it did before.
  const v1 = log.map((line) => Object.fromEntries(V1_KEYS.map((key) => [key, line[key]])));
  assert.deepEqual(v1.map((line) => Object.keys(line)), log.map(() => V1_KEYS));
  assert.deepEqual(v1.map(summary), [
    ["user-prompt-submit", directory, "HOOK_RECALL_ANSWERED"],
    ["user-prompt-submit", directory, "HOOK_RECALL_ANSWERED"],
    ["user-prompt-submit", directory, "HOOK_RECALL_NO_HITS"],
  ]);
  assert.ok(v1.every((line) => V1_KEYS.every((key) => typeof line[key] === "string" && line[key].length > 0)));
});
