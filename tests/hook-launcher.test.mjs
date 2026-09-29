// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-477 R1, R2, R5, AC2, AC3 (MIN-227 D5; TCRN-CROSS-SUB-312): the one hook a host
// runs for Einzbern goes through the stable launcher (scripts/einzbern-hook-launcher.mjs, installed
// as engine/hook.mjs in the device directory). A prompt typed where no project is registered ends
// the hook with exit code 0, no output and no library file read (AC2); a registered project's
// prompt with a strong hit gets the hit's title line as additionalContext (AC3), and so does
// another clone of the project, found through its remote without starting git; a prompt with no
// strong hit gets nothing. The launcher reads the remote git reads and spells it as the registry
// does, and imports the engine through a file URL built for the platform (R5).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { FRAMEWORK_VERSION, createKnowledgeUnit, createProject, createWork, initializeLibrary, removeKnowledgeUnit, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { deviceHome } from "../dist/build/packages/core/src/device-home.js";
import { NODE_FLOOR } from "../dist/build/packages/core/src/node-floor.js";
import { NAVIGATION_LINES } from "../dist/build/packages/core/src/agents-sections.js";
import { hookProtocolOutput, navigationPointerAnswer } from "../dist/build/packages/core/src/hook-recall.js";
import { HOST_HOOK_LAUNCHER } from "../dist/build/packages/core/src/host-hooks.js";
import { gitRemoteOf, normalizeGitRemote, registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import * as launcher from "../scripts/einzbern-hook-launcher.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recorderPath = join(repositoryRoot, "tests/helpers/fs-read-recorder.mjs");
const REMOTE = "https://zoo-host/owner/zoo.git";
const PROMPT = "How should the zebrafish tank be filled?";
const at = (second) => `2026-09-26T12:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);
const STORY_LINE = `[Story planned] Zebrafish tank · HOOK-STORY · ${idOf("HOOK-STORY")} · Wetland epic ‹ Aviary initiative`;
// The engine entry of a stand-in version: it answers with what the launcher gave it.
const ECHO_ENTRY = [
  "export async function runHookEvent({ event, payload, libraryPath, cwd }) {",
  "  return `${JSON.stringify({ event, libraryPath, cwd, prompt: payload.prompt })}\\n`;",
  "}",
  "",
].join("\n");
// git as a test runs it: no user or system configuration (signing, hooks) reaches it.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

function git(args) {
  return execFileSync("git", args, { env: GIT_ENV, encoding: "utf8" });
}

function gitRepository(directory, remote) {
  git(["init", "-q", directory]);
  if (remote !== null) git(["-C", directory, "remote", "add", "origin", remote]);
}

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-hook-launcher-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return { base, home };
}

/**
 * Install what the hook runs the way an installer does: this build as engine/<version>/ (or a
 * stand-in entry), engine/current naming it, and the launcher as engine/hook.mjs.
 */
async function installEngine(home, entry = null) {
  const engine = join(home, "engine");
  const tree = join(engine, FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  if (entry === null) {
    await copyFile(join(repositoryRoot, "scripts/einzbern-hook.mjs"), join(tree, "scripts/einzbern-hook.mjs"));
    await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
    await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  } else {
    await writeFile(join(tree, "scripts/einzbern-hook.mjs"), entry);
  }
  await writeFile(join(engine, "current"), `${JSON.stringify({ previous: null, schemaVersion: "einzbern.engine-current.v1", switchedAt: at(0), version: FRAMEWORK_VERSION })}\n`);
  const installed = join(engine, HOST_HOOK_LAUNCHER);
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), installed);
  return installed;
}

async function zooLibrary(library) {
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
  // TCRN-CROSS-SUB-303 calibrated the default strong-hit threshold on the cross-project corpus; this
  // three-record library lowers retrieval.tau the way the recall tests' small libraries do.
  await setWorkspaceSetting(library, { occurredAt: at(5), key: "retrieval.tau", value: "1" });
}

/** A Git working tree with a library in .ether, registered on this device with its remote. */
async function registeredProject(base, projectName = "project", remote = REMOTE) {
  const directory = join(base, projectName);
  await mkdir(join(directory, "src"), { recursive: true });
  gitRepository(directory, remote);
  const library = join(directory, ".ether");
  await zooLibrary(library);
  const entry = await registerLibrary({ projectPath: directory, libraryPath: library, registeredAt: at(9) });
  assert.equal(entry.gitRemote, normalizeGitRemote(remote));
  return { directory, library };
}

function runHook(launcherPath, { home, cwd, prompt = PROMPT, event = "user-prompt-submit", env = {}, preload = null, input = null }) {
  const payload = { session_id: "hook-launcher-test", transcript_path: join(home, "transcript.jsonl"), cwd, hook_event_name: "UserPromptSubmit", prompt };
  return spawnSync(process.execPath, [...(preload === null ? [] : ["--import", pathToFileURL(preload).href]), launcherPath, event], {
    cwd,
    input: input ?? JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: home, CLAUDE_PROJECT_DIR: cwd, ...env },
  });
}

function refusal(run) {
  assert.equal(run.status, 0, "a failing hook still exits 0");
  assert.equal(run.stdout, "");
  const lines = run.stderr.trim().split("\n");
  assert.equal(lines.length, 1, run.stderr);
  return JSON.parse(lines[0]).reasonCode;
}

test("481-R2, R4: a below-floor Node.js silently skips importing the versioned hook entry", async (context) => {
  assert.equal(launcher.HOOK_NODE_FLOOR, NODE_FLOOR, "the stable launcher and engine floor stay aligned");
  const { base, home } = await scratch(context);
  const oldNodeFailure = [
    'if (process.versions.node === "22.12.0") throw new SyntaxError("simulated old-Node parse failure");',
    'export async function runHookEvent() { throw new Error("unexpected engine hook call"); }',
    "",
  ].join("\n");
  const launcherPath = await installEngine(home, oldNodeFailure);
  const { directory } = await registeredProject(base);
  const preload = join(base, "older-node.mjs");
  await writeFile(preload, 'Object.defineProperty(process.versions, "node", { value: "22.12.0" });\n');
  const userHome = join(base, "user-home");
  await mkdir(userHome);

  const oldNode = runHook(launcherPath, { home, cwd: directory, preload, env: { HOME: userHome, USERPROFILE: userHome } });
  assert.deepEqual([oldNode.status, oldNode.stdout, oldNode.stderr], [0, "", ""]);

  const supportedNode = runHook(launcherPath, { home, cwd: directory, env: { HOME: userHome, USERPROFILE: userHome } });
  assert.equal(refusal(supportedNode), "HOOK_LAUNCH_FAILED", "supported-runtime hook failures remain diagnosable");
});

test("477-AC2: a prompt where no project is registered ends the hook with exit 0, no output and no library file read", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory, library } = await registeredProject(base);
  // A Git working tree with a remote of its own, so the remote route is taken and misses too.
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  gitRepository(elsewhere, "https://zoo-host/someone/else.git");
  await rm(join(home, "cache"), { recursive: true, force: true });
  const record = join(base, "reads.tsv");
  const env = { EINZBERN_READ_RECORD_ROOT: library, EINZBERN_READ_RECORD_FILE: record };

  const miss = runHook(launcherPath, { home, cwd: elsewhere, env, preload: recorderPath });
  assert.equal(miss.status, 0, miss.stderr);
  assert.equal(miss.stdout, "");
  assert.equal(miss.stderr, "");
  await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" }, "no call opened, read, listed or statted anything in the library");
  await assert.rejects(readdir(join(home, "cache")), { code: "ENOENT" }, "no library was replayed through this device's cache");

  // The same recorder sees the reads a registered project's prompt makes.
  const hit = runHook(launcherPath, { home, cwd: join(directory, "src"), env, preload: recorderPath });
  assert.equal(hit.status, 0, hit.stderr);
  assert.notEqual(hit.stdout, "");
  const reads = (await readFile(record, "utf8")).trim().split("\n").map((line) => line.split("\t")[1]);
  assert.ok(reads.includes(join(library, "manifest.json")), "the library's manifest was read");
});

test("477-AC3: a registered project's prompt with a strong hit gets the hit's title line as additionalContext", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory } = await registeredProject(base);

  const run = runHook(launcherPath, { home, cwd: join(directory, "src") });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: STORY_LINE } });
  assert.equal(run.stdout, `${hookProtocolOutput("claude-code", "UserPromptSubmit", [STORY_LINE])}\n`);

  // Codex runs the same command and reads the same answer.
  const codex = runHook(launcherPath, { home, cwd: directory, env: { CLAUDE_PROJECT_DIR: undefined } });
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.stdout, run.stdout);

  // 474 R3: a prompt with no strong hit gets no answer at all.
  const quiet = runHook(launcherPath, { home, cwd: directory, prompt: "rename parser module, rerun compiler" });
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""]);
  // An event this engine does not answer prints nothing either.
  const other = runHook(launcherPath, { home, cwd: directory, event: "stop" });
  assert.deepEqual([other.status, other.stdout, other.stderr], [0, "", ""]);
});

test("SUB-387: both registered projects recall the same user-crest card through the hook", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const first = await registeredProject(base, "first", REMOTE);
  const second = await registeredProject(base, "second", "https://zoo-host/owner/quoll.git");
  const created = await createKnowledgeUnit(first.library, {
    occurredAt: at(10), externalKey: "HOOK-USER-QUOLL", scope: "user", projectId: null, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["lesson"], subject: "Quoll den cleaning schedule",
    summary: "Clean the quoll den before dusk", snippet: "clean quoll den before dusk",
    accountableOwnerId: deriveStableId("owner", "HOOK-USER-QUOLL-OWNER"),
    sourceReferences: ["evidence://hook/quoll"], sourceDigest: canonicalSha256({ source: "hook-quoll" }), supersedes: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [deriveStableId("evidence", "HOOK-USER-QUOLL")],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    body: "Clean the den before dusk.",
  });
  const line = `[卡片 用户] Quoll den cleaning schedule · ${created.id}`;
  for (const project of [first, second]) {
    const run = runHook(launcherPath, { home, cwd: join(project.directory, "src"), prompt: "What is the quoll den cleaning schedule?" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } });
    assert.equal(run.stdout, `${hookProtocolOutput("claude-code", "UserPromptSubmit", [line])}\n`);
  }
});

// TCRN-CROSS-SUB-425 (TCRN-CROSS-STORY-514 R4, AC1; MIN-239 D6): the prompt hook recalls valid cards
// only, always. Once the card a prompt found is removed, the same prompt gets nothing.
test("SUB-425: the prompt hook recalls valid cards only, and a removed card's prompt gets nothing", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const project = await registeredProject(base);
  const created = await createKnowledgeUnit(project.library, {
    occurredAt: at(10), externalKey: "HOOK-USER-NUMBAT", scope: "user", projectId: null, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["lesson"], subject: "Numbat termite feeding hours",
    summary: "Numbats feed on termites by day", snippet: "numbat termite feeding by day",
    accountableOwnerId: deriveStableId("owner", "HOOK-USER-NUMBAT-OWNER"),
    sourceReferences: ["evidence://hook/numbat"], sourceDigest: canonicalSha256({ source: "hook-numbat" }), supersedes: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [deriveStableId("evidence", "HOOK-USER-NUMBAT")],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    body: "Feed at midday.",
  });
  const prompt = "What are the numbat termite feeding hours?";
  const found = runHook(launcherPath, { home, cwd: join(project.directory, "src"), prompt });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).hookSpecificOutput.additionalContext, `[卡片 用户] Numbat termite feeding hours · ${created.id}`);
  const removed = await removeKnowledgeUnit(project.library, {
    occurredAt: at(11), id: created.id, reason: "invalid", basis: "numbats feed by day only in winter", actor: "agent:claude-opus-5-5",
  }, { scope: "user" });
  assert.equal(removed.reasonCode, "KNOWLEDGE_UNIT_REMOVED");
  const quiet = runHook(launcherPath, { home, cwd: join(project.directory, "src"), prompt });
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""], "the removed card is not recalled");
});

test("478-AC5: the pointer hooks answer with the three navigation lines on both hosts, reading no library file", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory, library } = await registeredProject(base);
  const record = join(base, "reads.tsv");
  const env = { EINZBERN_READ_RECORD_ROOT: library, EINZBERN_READ_RECORD_FILE: record };
  for (const [word, event] of [["session-start", "SessionStart"], ["subagent-start", "SubagentStart"]]) {
    const run = runHook(launcherPath, { home, cwd: join(directory, "src"), event: word, env, preload: recorderPath });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: event, additionalContext: NAVIGATION_LINES.join("\n") } }, word);
    assert.equal(run.stdout, `${navigationPointerAnswer("claude-code", event).output}\n`);
    const codex = runHook(launcherPath, { home, cwd: directory, event: word, env: { ...env, CLAUDE_PROJECT_DIR: undefined }, preload: recorderPath });
    assert.deepEqual([codex.status, codex.stdout, codex.stderr], [0, run.stdout, ""], `${word}: Codex reads the same answer`);
  }
  await assert.rejects(readFile(record, "utf8"), { code: "ENOENT" }, "a pointer hook reads nothing in the library");
  assert.deepEqual(navigationPointerAnswer("codex", "SessionStart").lines, NAVIGATION_LINES);
  assert.throws(() => navigationPointerAnswer("codex", "UserPromptSubmit"), (error) => error?.reasonCode === "HOOK_INPUT_INVALID");

  // Where no project is registered, a pointer hook ends like any other: exit 0 and nothing printed.
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  const miss = runHook(launcherPath, { home, cwd: elsewhere, event: "session-start" });
  assert.deepEqual([miss.status, miss.stdout, miss.stderr], [0, "", ""]);
});

test("477-AC3: the answer is cut to injection.perPromptBytes at whole lines", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory, library } = await registeredProject(base);
  const bytes = Buffer.byteLength(STORY_LINE, "utf8");
  await setWorkspaceSetting(library, { occurredAt: at(20), key: "injection.perPromptBytes", value: String(bytes - 1) });
  const cut = runHook(launcherPath, { home, cwd: directory });
  assert.deepEqual([cut.status, cut.stdout, cut.stderr], [0, "", ""], "the one line does not fit, so there is no answer");
  await setWorkspaceSetting(library, { occurredAt: at(21), key: "injection.perPromptBytes", value: String(bytes) });
  const fits = runHook(launcherPath, { home, cwd: directory });
  assert.equal(fits.status, 0, fits.stderr);
  assert.equal(JSON.parse(fits.stdout).hookSpecificOutput.additionalContext, STORY_LINE);
});

test("477-R2: another clone with the project's remote and no library matches the registry, without starting git", async (context) => {
  const { base, home } = await scratch(context);
  const { library } = await registeredProject(base);
  const clone = join(base, "clone");
  gitRepository(clone, "git@zoo-host:owner/zoo.git");
  await mkdir(join(clone, "deep", "er"), { recursive: true });
  git(["-C", clone, "-c", "user.name=hook", "-c", "user.email=hook", "commit", "-q", "--allow-empty", "-m", "start"]);
  const worktree = join(base, "worktree");
  git(["-C", clone, "worktree", "add", "-q", "--detach", worktree]);

  // A stand-in engine answers with what the launcher matched; no git is on the PATH.
  const echoLauncher = await installEngine(home, ECHO_ENTRY);
  const noGit = join(base, "empty-path");
  await mkdir(noGit);
  for (const cwd of [clone, join(clone, "deep", "er"), worktree]) {
    const run = runHook(echoLauncher, { home, cwd, prompt: "zebrafish", env: { PATH: noGit } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { event: "user-prompt-submit", libraryPath: library, cwd, prompt: "zebrafish" }, cwd);
  }
  await assert.rejects(readdir(join(clone, ".ether")), { code: "ENOENT" }, "the clone has no library of its own");

  // With the engine itself, the clone's prompt gets the project's title line.
  await rm(join(home, "engine"), { recursive: true });
  const engineLauncher = await installEngine(home);
  const answered = runHook(engineLauncher, { home, cwd: join(clone, "deep") });
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(JSON.parse(answered.stdout).hookSpecificOutput.additionalContext, STORY_LINE);
});

test("477-R2: the launcher reads the remote git reads and spells it as the registry does", async (context) => {
  const { base } = await scratch(context);
  const core = "[core]\n\tbare = false\n";
  const configs = {
    "quoted, commented, cased and continued": `${core}[remote "upstream"]\n\turl = https://example.test/upstream/zoo.git\n[REMOTE "origin"] # a comment\n\tURL = "git@Zoo-Host:owner/zoo farm.git" ; trailing\n\turl = https://example.test/second.git\n[remote.mirror]\n\turl = git@zoo-host:owner/mi\\\nrror.git\n`,
    "no origin: the first remote by name, which answers with its name without a url": `${core}[remote "zeta"]\n\turl = https://example.test/zeta.git\n[remote "alpha"]\n\tfetch = +refs/heads/*:refs/remotes/alpha/*\n[remote "beta"]\n\turl = https://example.test/beta.git\n`,
    "an empty url clears the ones before it": `${core}[remote "origin"]\n\turl = https://example.test/first.git\n\turl =\n\turl = https://example.test/third.git\n`,
    "carriage returns": `${core}[remote "origin"]\r\n\turl = https://example.test/crlf.git\r\n`,
    "a file git refuses": `${core}[remote "origin"]\n\turl = "unterminated\n`,
    "no remote": core,
  };
  for (const [name, text] of Object.entries(configs)) {
    const repository = join(base, `repo-${Object.keys(configs).indexOf(name)}`);
    gitRepository(repository, null);
    await writeFile(join(repository, ".git", "config"), text);
    await mkdir(join(repository, "nested"));
    assert.equal(launcher.repositoryRemote(join(repository, "nested")), gitRemoteOf(join(repository, "nested")), name);
  }
  // A .git file naming a separate git directory, which has no commondir.
  const separate = join(base, "separate");
  await mkdir(join(base, "modules"));
  git(["init", "-q", "--separate-git-dir", join(base, "modules", "separate"), separate]);
  git(["-C", separate, "remote", "add", "origin", "git://zoo-host:9418/owner/zoo.git"]);
  assert.equal(launcher.repositoryRemote(separate), gitRemoteOf(separate));
  assert.equal(launcher.repositoryRemote(separate), "git://zoo-host:9418/owner/zoo.git");
  assert.equal(launcher.repositoryRemote(base), null, "outside a working tree there is no remote");

  const urls = [
    "https://example.test/owner/zoo.git", "git@zoo-host:owner/zoo.git", "git://Zoo-Host:9418/owner/zoo.git",
    "git://zoo-host/owner/zoo", "git://example.test/owner/zoo.git/", "HTTPS://Zoo-Bot@Zoo-Host/Owner/Zoo.git",
    "https://example.test:8443/owner/zoo.git", "git@zoo-host:22/owner/zoo.git", "zoo-host:owner/zoo", "file:///opt/git/zoo.git",
    "/opt/git/zoo.git", "../relative/zoo.git", "D:\\repositories\\zoo.git", "  https://example.test/owner/zoo.git/  ", "origin",
  ];
  for (const url of urls) assert.equal(launcher.normalizeGitRemote(url), normalizeGitRemote(url), url);
});

test("477-R5: the launcher finds the device directory as the engine does and imports the entry through a file URL", () => {
  assert.equal(launcher.hookEntryUrl("D:\\Einzbern Devices\\Ada Lovelace\\.einzbern\\engine", "1.2.1", "win32"), "file:///D:/Einzbern%20Devices/Ada%20Lovelace/.einzbern/engine/1.2.1/scripts/einzbern-hook.mjs");
  assert.equal(launcher.hookEntryUrl("/opt/zoo #1 100%/.einzbern/engine", "1.2.1", "linux"), "file:///opt/zoo%20%231%20100%25/.einzbern/engine/1.2.1/scripts/einzbern-hook.mjs");
  for (const env of [{}, { EINZBERN_HOME: "" }, { EINZBERN_HOME: "relative/device" }, { EINZBERN_HOME: "/elsewhere/device" }]) {
    assert.equal(launcher.deviceDirectory(env, "/opt/ada"), deviceHome(env, "/opt/ada"), JSON.stringify(env));
  }
});

test("477-R2: a changed library, a missing engine, a damaged registry and a bad input end the hook with exit 0 and no output", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const { directory, library } = await registeredProject(base);
  assert.notEqual(runHook(launcherPath, { home, cwd: directory }).stdout, "", "the prompt hits while the registry names this library");

  // Another library now sits where the registered one was: resolveLibrary refuses, and the hook is silent.
  await rm(library, { recursive: true });
  await zooLibrary(library);
  const changed = runHook(launcherPath, { home, cwd: directory });
  assert.deepEqual([changed.status, changed.stdout, changed.stderr], [0, "", ""]);

  assert.equal(refusal(runHook(launcherPath, { home, cwd: directory, input: "not json" })), "HOOK_INPUT_INVALID");
  assert.equal(refusal(runHook(launcherPath, { home, cwd: directory, input: " ".repeat(launcher.HOOK_STDIN_MAX_BYTES + 1) })), "HOOK_INPUT_TOO_LARGE");
  assert.equal(refusal(runHook(launcherPath, { home, cwd: directory, event: "" })), "HOOK_EVENT_MISSING");
  await rm(join(home, "engine", "current"));
  assert.equal(refusal(runHook(launcherPath, { home, cwd: directory })), "HOOK_ENGINE_CURRENT_INVALID");
  await writeFile(join(home, "registry.json"), "{");
  assert.equal(refusal(runHook(launcherPath, { home, cwd: directory })), "HOOK_REGISTRY_INVALID");
  // Without a registry the device has no project, and the hook says nothing at all.
  await rm(join(home, "registry.json"));
  const none = runHook(launcherPath, { home, cwd: directory });
  assert.deepEqual([none.status, none.stdout, none.stderr], [0, "", ""]);
});

// MIN-235 D9 (TCRN-CROSS-SUB-302): the zoo library with no retrieval.tau recorded, so the hook answers
// at the shipped default. zooLibrary records 1 for the cases above, written when the default was a
// bm25 number calibrated on the cross-project chain; the default now counts words only one record
// carries, and holds in a library this small.
async function zooLibraryAtDefault(library) {
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
}

test("D9 (477-AC3, SUB-387 at the default threshold): a Story's prompt and a user card's prompt get their lines, and unrelated prompts get nothing", async (context) => {
  const { base, home } = await scratch(context);
  const launcherPath = await installEngine(home);
  const directory = join(base, "project");
  await mkdir(join(directory, "src"), { recursive: true });
  gitRepository(directory, REMOTE);
  const library = join(directory, ".ether");
  await zooLibraryAtDefault(library);
  await registerLibrary({ projectPath: directory, libraryPath: library, registeredAt: at(9) });

  const run = runHook(launcherPath, { home, cwd: join(directory, "src") });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: STORY_LINE } });
  for (const prompt of ["rename parser module, rerun compiler", "What time does the pharmacy close on Sundays?", "今天的天气怎么样"]) {
    const quiet = runHook(launcherPath, { home, cwd: directory, prompt });
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""], prompt);
  }

  const created = await createKnowledgeUnit(library, {
    occurredAt: at(10), externalKey: "HOOK-USER-QUOLL", scope: "user", projectId: null, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["lesson"], subject: "Quoll den cleaning schedule",
    summary: "Clean the quoll den before dusk", snippet: "clean quoll den before dusk",
    accountableOwnerId: deriveStableId("owner", "HOOK-USER-QUOLL-OWNER"),
    sourceReferences: ["evidence://hook/quoll"], sourceDigest: canonicalSha256({ source: "hook-quoll" }), supersedes: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [deriveStableId("evidence", "HOOK-USER-QUOLL")],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    body: "Clean the den before dusk.",
  });
  const card = runHook(launcherPath, { home, cwd: directory, prompt: "What is the quoll den cleaning schedule?" });
  assert.equal(card.status, 0, card.stderr);
  assert.deepEqual(JSON.parse(card.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `[卡片 用户] Quoll den cleaning schedule · ${created.id}` } });
  const stillQuiet = runHook(launcherPath, { home, cwd: directory, prompt: "rename parser module, rerun compiler" });
  assert.deepEqual([stillQuiet.status, stillQuiet.stdout, stillQuiet.stderr], [0, "", ""]);
});
