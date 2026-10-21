// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-470 R1, AC1 (MIN-227 D19): this device's registry maps a project to its library.
// A directory inside a registered project resolves to it; another clone of the project, with no
// library of its own, resolves to the same library through its Git remote; an unregistered
// directory is LIBRARY_NOT_REGISTERED; a library that no longer carries the registered id is
// LIBRARY_REGISTRY_MISMATCH; and a verb run without --workspace works on the resolved library.
// TCRN-CROSS-SUB-427: the unregistered refusal offers --workspace only to a verb that takes it.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const REMOTE = "https://example.test/owner/project.git";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 7, 0, second)).toISOString().replace(".000Z", "Z");
};

// A scratch directory with its own device directory, restored when the test ends.
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-registry-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  throw new Error(`${args[0]} was expected to refuse`);
}

function gitRepository(path, remote) {
  execFileSync("git", ["init", "-q", path]);
  if (remote !== null) execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
}

test("470-AC1: a directory inside a registered project resolves to its library", async (context) => {
  const base = await scratch(context);
  const project = join(base, "project");
  await mkdir(join(project, "src", "deep"), { recursive: true });
  const created = await cli(["init", "--workspace", join(project, ".ether"), "--at", at(), "--project", project]);
  assert.equal(created.registered.projectPath, project);
  const resolved = await cli(["library-resolve", "--cwd", join(project, "src", "deep")]);
  assert.deepEqual([resolved.reasonCode, resolved.via, resolved.libraryPath, resolved.libraryId], ["LIBRARY_RESOLVED", "project-path", join(project, ".ether"), created.libraryId]);
  const listed = await cli(["library-list"]);
  // init --project also registered the coordination library it created (EPIC-144 R2); the project
  // still resolves to its own library, never to the coordination library its chain names.
  const coordinationId = (await cli(["chain-identity", "--workspace", join(project, ".ether")])).identity.coordinationLibraryId;
  assert.notEqual(coordinationId, created.libraryId);
  assert.deepEqual(listed.entries.map((entry) => [entry.projectPath, entry.libraryId]), [[join(base, "device", "coordination-library"), coordinationId], [project, created.libraryId]]);
  // The registry is in the device directory; the project holds no pointer to it.
  assert.ok((await readdir(join(base, "device"))).includes("registry.json"));
  assert.deepEqual((await readdir(project)).sort(), [".ether", "src"]);
});

test("470-AC1: another clone of the project, with no library, resolves to the same library through its remote", async (context) => {
  const base = await scratch(context);
  const project = join(base, "project");
  const clone = join(base, "clone");
  gitRepository(project, REMOTE);
  gitRepository(clone, "git@example.test:owner/project.git");
  await mkdir(join(clone, "nested"));
  const created = await cli(["init", "--workspace", join(base, "Ether", "project"), "--at", at(), "--project", project]);
  assert.equal(created.registered.gitRemote, "example.test/owner/project", "the remote is kept in one spelling");
  const resolved = await cli(["library-resolve", "--cwd", join(clone, "nested")]);
  assert.deepEqual([resolved.via, resolved.libraryId, resolved.projectPath], ["git-remote", created.libraryId, project]);
  await assert.rejects(readdir(join(clone, ".ether")), { code: "ENOENT" }, "the clone has no library of its own");
});

test("470-R1: an unregistered directory is LIBRARY_NOT_REGISTERED, and a library that changed is LIBRARY_REGISTRY_MISMATCH", async (context) => {
  const base = await scratch(context);
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  const missing = await refusal(["library-resolve", "--cwd", elsewhere]);
  assert.equal(missing.reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal(missing.details.remedy, "library-register");

  const project = join(base, "project");
  await mkdir(project);
  const library = join(base, "library");
  await cli(["init", "--workspace", library, "--at", at(), "--project", project]);
  // Another library now sits where the registered one was.
  await rm(library, { recursive: true });
  await cli(["init", "--workspace", library, "--at", at()]);
  const mismatch = await refusal(["library-resolve", "--cwd", project]);
  assert.equal(mismatch.reasonCode, "LIBRARY_REGISTRY_MISMATCH");
});

test("470-R1: a verb run without --workspace works on the library the current directory resolves to", async (context) => {
  const base = await scratch(context);
  const project = join(base, "project");
  await mkdir(join(project, "docs"), { recursive: true });
  await cli(["init", "--workspace", join(project, ".ether"), "--at", at(), "--project", project]);
  const env = { ...process.env };
  const run = (args, cwd) => spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: "utf8" });
  // init --project already wrote the chain identity and the setup project (EPIC-144 R2): the verb
  // adds exactly one event to the library the directory resolves to.
  const before = JSON.parse(run(["status"], join(project, "docs")).stdout).version;
  const created = run(["project-create", "--at", at(), "--external-key", "REGISTRY-PROJECT", "--name", "Registry"], join(project, "docs"));
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).version, before + 1);
  const status = run(["status"], join(project, "docs"));
  assert.equal(JSON.parse(status.stdout).version, before + 1);
  const outside = run(["status"], base);
  assert.equal(outside.status, 1);
  assert.equal(JSON.parse(outside.stderr).reasonCode, "LIBRARY_NOT_REGISTERED");
  // Creation and the native/shared interfaces that bind an explicit workspace require it.
  const catalog = await cli(["commands"]);
  const workspaceFlags = catalog.commands.flatMap((entry) => entry.flags.filter((flag) => flag.name === "workspace").map((flag) => [entry.name, flag.required]));
  assert.deepEqual(workspaceFlags.filter(([, isRequired]) => isRequired), [
    ["execution-native-prepare", true],
    ["init", true],
    ["shared-submit-advisory-read", true],
    ["shared-submit-advisory-write", true],
  ]);
  const registry = JSON.parse(await readFile(join(base, "device", "registry.json"), "utf8"));
  assert.equal(registry.schemaVersion, "einzbern.registry.v1");
});

test("INIT-056: engine policy set resolves an omitted workspace through the registry and keeps refusal boundaries", async (context) => {
  const base = await scratch(context);
  const project = join(base, "model-policy-project");
  const library = join(project, ".ether");
  await mkdir(project, { recursive: true });
  await cli(["init", "--workspace", library, "--at", at()]);
  const created = await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "REGISTRY-MODEL-POLICY", "--name", "Registry model policy"]);
  const projectId = created.record.id;
  await cli(["library-register", "--project", project, "--library", library, "--project-id", projectId, "--at", at()]);
  const meeting = await cli([
    "minutes-record", "--workspace", library, "--at", at(), "--project-id", projectId,
    "--title", "Engine model policy", "--summary", "Fixture Owner decision for registry resolution.",
    "--decisions", "Set models.engine-policy for the Codex host.", "--decided-by", "owner:governance",
    "--external-key", "REGISTRY-MODEL-POLICY-OWNER", "--actor", "agent:fixture",
  ]);
  const policy = JSON.stringify({
    categories: [
      { id: "flagship", name: "Flagship", description: "", order: 10 },
      { id: "main", name: "Main", description: "", order: 20 },
      { id: "economy", name: "Economy", description: "", order: 30 },
    ],
    tiers: [
      { order: 10, category: "flagship", runner: "codex", model: "gpt-6-luna", effort: "max", note: "" },
      { order: 20, category: "economy", runner: "codex", model: "gpt-6-luna", effort: "max", note: "" },
    ],
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  });
  const setArgs = [
    "engine-model-policy-set", "--host", "codex", "--policy", policy, "--at", at(),
    "--actor", "agent:fixture", "--decided-in", `${meeting.id}#D1`,
  ];
  const env = { ...process.env };
  const run = (args, cwd) => spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: "utf8" });

  const saved = run(setArgs, project);
  assert.equal(saved.status, 0, saved.stderr);
  const receipt = JSON.parse(saved.stdout);
  assert.equal(receipt.reasonCode, "ENGINE_MODEL_POLICY_WRITE_COMMITTED");
  assert.equal(receipt.readback.selectedHost, "codex");
  assert.equal(receipt.readback.selectedPolicy.actor, "agent:fixture");

  const wrongDecision = run([...setArgs.slice(0, -1), `minutes:${"d".repeat(24)}#D1`], project);
  assert.equal(wrongDecision.status, 1);
  assert.equal(JSON.parse(wrongDecision.stderr).reasonCode, "MODEL_WRITE_AUTHORIZATION_INVALID");

  const elsewhere = join(base, "unregistered");
  await mkdir(elsewhere);
  const unregistered = run(setArgs, elsewhere);
  assert.equal(unregistered.status, 1);
  const refusal = JSON.parse(unregistered.stderr);
  assert.equal(refusal.reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal(refusal.remedy, "library-register");

  const unchanged = await cli(["engine-model-policy-catalog", "--host", "codex"]);
  assert.equal(unchanged.storeRevision, 1, "failed resolution and authorization do not write a policy");
  assert.equal(unchanged.selectedPolicy.actor, "agent:fixture");
});

test("SUB-427: the LIBRARY_NOT_REGISTERED hint offers --workspace only to a verb that takes it", async (context) => {
  const base = await scratch(context);
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  // Verbs without --workspace: the hint names library-register alone; code and details are unchanged.
  for (const args of [["library-resolve", "--cwd", elsewhere], ["rule-list", "--project", elsewhere], ["agents-render", "--project", elsewhere, "--at", at()]]) {
    const refused = await refusal(args);
    assert.equal(refused.reasonCode, "LIBRARY_NOT_REGISTERED", args[0]);
    assert.deepEqual(refused.details, { cwd: elsewhere, remedy: "library-register" }, args[0]);
    assert.match(refused.message, /on this device \(register one with library-register\)$/u, args[0]);
  }
  // A verb that takes --workspace, run from the unregistered directory, is offered it as well.
  const status = spawnSync(process.execPath, [cliPath, "status"], { cwd: elsewhere, env: { ...process.env }, encoding: "utf8" });
  assert.equal(status.status, 1);
  const answer = JSON.parse(status.stderr);
  assert.deepEqual([answer.reasonCode, answer.remedy], ["LIBRARY_NOT_REGISTERED", "library-register"]);
  assert.match(answer.error, /on this device \(register one with library-register, or pass --workspace\)$/u);
});


test("registry mutators queue their complete read/modify/replace behind the same lock", async (context) => {
  const base = await scratch(context);
  const home = process.env.EINZBERN_HOME;
  const { registerLibrary, unregisterLibrary, repointLibrary, readRegistry } = await import("../dist/build/packages/core/src/registry.js");
  const { acquireFileLock } = await import("../dist/build/packages/core/src/file-lock.js");
  const projects = Object.fromEntries(["keep", "remove", "add-a", "add-b"].map((name) => [name, join(base, name)]));
  await Promise.all(Object.values(projects).map((path) => mkdir(path)));
  const library = join(base, "library");
  const created = await cli(["init", "--workspace", library, "--at", at()]);
  for (const name of ["keep", "remove"]) await registerLibrary({ projectPath: projects[name], libraryPath: library, registeredAt: at(), gitRemote: null }, home);
  const destination = join(base, "destination");
  await mkdir(destination);
  const lock = await acquireFileLock(join(home, "registry.json.lock"));
  let settled = 0;
  const mutations = [
    registerLibrary({ projectPath: projects["add-a"], libraryPath: library, registeredAt: at(), gitRemote: null }, home),
    registerLibrary({ projectPath: projects["add-b"], libraryPath: library, registeredAt: at(), gitRemote: null }, home),
    unregisterLibrary(projects.remove, home),
    repointLibrary(created.libraryId, destination, true, home),
  ].map((promise) => promise.finally(() => { settled += 1; }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, 0, "every mutator must respect the registry transaction lock");
    assert.deepEqual((await readRegistry(home)).entries.map((entry) => entry.projectPath).sort(), [projects.keep, projects.remove].sort(), "a held lock leaves the old complete registry readable");
  } finally { await lock.release(); }
  await Promise.all(mutations);
  const entries = (await readRegistry(home)).entries;
  assert.deepEqual(entries.map((entry) => entry.projectPath).sort(), [projects.keep, projects["add-a"], projects["add-b"]].sort(), "concurrent independent registration and removal preserve all unrelated entries");
  const kept = entries.find((entry) => entry.projectPath === projects.keep);
  assert.equal(kept.libraryPath, destination, "repoint survives concurrent registrations");
  assert.equal(kept.cloudHosted, true);
  assert.equal(entries.every((entry) => entry.libraryId === created.libraryId), true);
  assert.equal((await readdir(home)).some((name) => name.endsWith(".lock")), false);
});


test("whole-suite test processes isolate inherited device state without serialising files", async (context) => {
  const base = await scratch(context);
  const environment = { ...process.env, EINZBERN_TEST_DEVICE_ROOT: base };
  const module = new URL("./helpers/device-home.mjs", import.meta.url).href;
  const homes = Array.from({ length: 2 }, () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {testDeviceHome} from ${JSON.stringify(module)};process.stdout.write(testDeviceHome);`], { env: environment, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  });
  assert.notEqual(homes[0], homes[1]);
  for (const home of homes) {
    assert.ok(home.startsWith(base + "/"));
    assert.notEqual(home, environment.EINZBERN_HOME);
    await assert.rejects(readdir(home), { code: "ENOENT" }, "each child reclaims its own device home");
  }
});
