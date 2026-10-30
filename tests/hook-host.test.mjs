// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-548 R2, AC2: hookHost reads EINZBERN_HOST first. A value in HOST_HOOK_HOSTS
// is the answer; any other value, the empty string included, counts as unset and the old guess
// stands (CLAUDE_PROJECT_DIR → claude-code, otherwise codex). Without EINZBERN_HOST the hook prints
// for Claude Code and Codex exactly the bytes it printed before DSH was a host: the snapshot
// constants below are those bytes, written out literally rather than computed.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createProject, createWork, initializeLibrary, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { hookHost } from "../dist/build/packages/core/src/hook-recall.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
const PROMPT = "How should the zebrafish tank be filled?";
const at = (second) => `2026-10-14T12:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);

// The bytes the hook printed at faaa216a (before TCRN-CROSS-STORY-548), for both hosts.
const SNAPSHOT_USER_PROMPT_SUBMIT = "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"[Story planned] Zebrafish tank · HOOK-STORY · work:7ff15c20d39135680e043cac · Wetland epic ‹ Aviary initiative\"}}\n";
const SNAPSHOT_SESSION_START = "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"This project is managed by Einzbern.\\nLoad the Mana Orchestrate skill before you start work.\\nRecall first: run Einzbern's recall for the task before you plan or change anything.\"}}\n";

test("548-R2: hookHost reads EINZBERN_HOST first and falls back on any value outside the host set", () => {
  const cases = [
    [{}, "codex"],
    [{ CLAUDE_PROJECT_DIR: "/srv/project" }, "claude-code"],
    [{ CLAUDE_PROJECT_DIR: "" }, "codex"],
    [{ EINZBERN_HOST: "dsh" }, "dsh"],
    [{ EINZBERN_HOST: "dsh", CLAUDE_PROJECT_DIR: "/srv/project" }, "dsh"],
    [{ EINZBERN_HOST: "codex", CLAUDE_PROJECT_DIR: "/srv/project" }, "codex"],
    [{ EINZBERN_HOST: "claude-code" }, "claude-code"],
    [{ EINZBERN_HOST: "bogus" }, "codex"],
    [{ EINZBERN_HOST: "bogus", CLAUDE_PROJECT_DIR: "/srv/project" }, "claude-code"],
    [{ EINZBERN_HOST: "" }, "codex"],
    [{ EINZBERN_HOST: "", CLAUDE_PROJECT_DIR: "/srv/project" }, "claude-code"],
    [{ EINZBERN_HOST: "DSH" }, "codex"],
  ];
  for (const [env, expected] of cases) assert.equal(hookHost(env), expected, JSON.stringify(env));
});

async function registeredProject(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-hook-host-")));
  const saved = Object.fromEntries(["EINZBERN_HOME", "EINZBERN_HOST", "CLAUDE_PROJECT_DIR"].map((key) => [key, process.env[key]]));
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  });
  const directory = join(base, "project");
  await mkdir(join(directory, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", directory], { env: GIT_ENV });
  execFileSync("git", ["-C", directory, "remote", "add", "origin", "https://zoo-host/owner/zoo.git"], { env: GIT_ENV });
  const library = join(directory, ".ether");
  await initializeLibrary({ root: library, createdAt: at(0) });
  const projectId = (await createProject(library, { occurredAt: at(1), externalKey: "HOOK-PROJECT", name: "Hook" })).projects[0].id;
  await createWork(library, { occurredAt: at(2), projectId, externalKey: "HOOK-INIT", kind: "Initiative", parentId: null, title: "Aviary initiative", scope: "## Goal\nBuild the heron aviary." });
  await createWork(library, { occurredAt: at(3), projectId, externalKey: "HOOK-EPIC", kind: "Epic", parentId: idOf("HOOK-INIT"), title: "Wetland epic", goal: "Keep the flamingo pond." });
  await createWork(library, {
    occurredAt: at(4), projectId, externalKey: "HOOK-STORY", kind: "Story", parentId: idOf("HOOK-EPIC"), title: "Zebrafish tank",
    goal: "Give the zebrafish a tank.", acceptance: "GIVEN the tank WHEN it is filled THEN the zebrafish swim",
  });
  await setWorkspaceSetting(library, { occurredAt: at(5), key: "retrieval.tau", value: "1" });
  await registerLibrary({ projectPath: directory, libraryPath: library, registeredAt: at(9) });
  return { directory, library };
}

test("548-AC2: without EINZBERN_HOST, Claude Code and Codex get byte-for-byte the output they got before; dsh gets the same shape", async (context) => {
  const { directory, library } = await registeredProject(context);
  const { runHookEvent } = await import(pathToFileURL(join(repositoryRoot, "scripts/einzbern-hook.mjs")).href);
  const environments = [
    ["claude-code", { CLAUDE_PROJECT_DIR: directory }],
    ["codex", {}],
    ["dsh", { EINZBERN_HOST: "dsh", CLAUDE_PROJECT_DIR: directory }],
  ];
  for (const [host, env] of environments) {
    delete process.env.EINZBERN_HOST;
    delete process.env.CLAUDE_PROJECT_DIR;
    Object.assign(process.env, env);
    assert.equal(hookHost(process.env), host);
    const prompt = await runHookEvent({ event: "user-prompt-submit", payload: { prompt: PROMPT }, libraryPath: library, cwd: directory });
    assert.equal(prompt, SNAPSHOT_USER_PROMPT_SUBMIT, `${host}: user-prompt-submit`);
    assert.ok(Buffer.from(prompt, "utf8").equals(Buffer.from(SNAPSHOT_USER_PROMPT_SUBMIT, "utf8")), `${host}: user-prompt-submit bytes`);
    const start = await runHookEvent({ event: "session-start", payload: {}, libraryPath: library, cwd: directory });
    assert.equal(start, SNAPSHOT_SESSION_START, `${host}: session-start`);
    assert.ok(Buffer.from(start, "utf8").equals(Buffer.from(SNAPSHOT_SESSION_START, "utf8")), `${host}: session-start bytes`);
  }
});

test("BL34: native SubagentStart recalls by its documented agent_type before first work", async (context) => {
  const { directory, library } = await registeredProject(context);
  const { runHookEvent } = await import(pathToFileURL(join(repositoryRoot, "scripts/einzbern-hook.mjs")).href);
  for (const host of ["claude-code", "codex"]) {
    process.env.EINZBERN_HOST = host;
    // Both native interfaces provide agent_type, not the delegated task prompt.
    const payload = { hook_event_name: "SubagentStart", cwd: directory, agent_id: "agent-1", agent_type: "zebrafish" };
    const answer = JSON.parse(await runHookEvent({ event: "subagent-start", payload, libraryPath: library, cwd: directory }));
    assert.equal(answer.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.match(answer.hookSpecificOutput.additionalContext, /Recall first:/u);
    assert.match(answer.hookSpecificOutput.additionalContext, /Zebrafish tank · HOOK-STORY/u);
    const empty = JSON.parse(await runHookEvent({ event: "subagent-start", payload: { prompt: PROMPT }, libraryPath: library, cwd: directory }));
    assert.doesNotMatch(empty.hookSpecificOutput.additionalContext, /HOOK-STORY/u, "a made-up native prompt field is not treated as task evidence");
  }
});


test("BL34 scope: DSH subagent navigation remains pointer-only even with a matching agent_type", async (context) => {
  const { directory, library } = await registeredProject(context);
  process.env.EINZBERN_HOST = "dsh";
  const { runHookEvent } = await import(pathToFileURL(join(repositoryRoot, "scripts/einzbern-hook.mjs")).href);
  const answer = JSON.parse(await runHookEvent({ event: "subagent-start", payload: { agent_type: "zebrafish" }, libraryPath: library, cwd: directory }));
  assert.equal(answer.hookSpecificOutput.hookEventName, "SubagentStart");
  assert.match(answer.hookSpecificOutput.additionalContext, /Recall first:/u);
  assert.doesNotMatch(answer.hookSpecificOutput.additionalContext, /HOOK-STORY/u);
});

test("retired SubagentStop is inert for all hosts including legacy marker payloads", async (context) => {
  const { directory, library } = await registeredProject(context);
  const { runHookEvent } = await import(pathToFileURL(join(repositoryRoot, "scripts/einzbern-hook.mjs")).href);
  const previous = { host: process.env.EINZBERN_HOST, home: process.env.EINZBERN_HOME, claude: process.env.CLAUDE_PROJECT_DIR };
  context.after(() => {
    if (previous.host === undefined) delete process.env.EINZBERN_HOST; else process.env.EINZBERN_HOST = previous.host;
    if (previous.home === undefined) delete process.env.EINZBERN_HOME; else process.env.EINZBERN_HOME = previous.home;
    if (previous.claude === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = previous.claude;
  });
  process.env.EINZBERN_HOME = join(directory, ".fixture-device");
  await mkdir(process.env.EINZBERN_HOME, { recursive: true });
  process.env.EINZBERN_HOST = "codex";
  const unassociated = await runHookEvent({ event: "subagent-stop", payload: { last_assistant_message: "ordinary final" }, libraryPath: library, cwd: directory });
  assert.equal(unassociated, null);
  const logPath = join(process.env.EINZBERN_HOME, "log", "hook.ndjson");
  assert.equal(await readFile(logPath, "utf8").catch(() => null), null, "ordinary final adds no hook message or diagnostic");
  const unavailable = await runHookEvent({ event: "subagent-stop", payload: { agent_id: "self-claimed", last_assistant_message: "EINZBERN_SUBAGENT_STOP_V1 {}" }, libraryPath: library, cwd: directory });
  assert.equal(unavailable, null, "a marker cannot revive a retired collector");
  assert.equal(await readFile(logPath, "utf8").catch(() => null), null);
  process.env.EINZBERN_HOST = "claude-code";
  assert.equal(await runHookEvent({ event: "subagent-stop", payload: {}, libraryPath: library, cwd: directory }), null);
  process.env.EINZBERN_HOST = "dsh";
  assert.equal(await runHookEvent({ event: "subagent-stop", payload: {}, libraryPath: library, cwd: directory }), null);
});
