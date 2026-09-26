// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-470 R1, AC1 (MIN-227 D19): this device's registry maps a project to its library.
// A directory inside a registered project resolves to it; another clone of the project, with no
// library of its own, resolves to the same library through its Git remote; an unregistered
// directory is LIBRARY_NOT_REGISTERED; a library that no longer carries the registered id is
// LIBRARY_REGISTRY_MISMATCH; and a verb run without --workspace works on the resolved library.

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
  assert.deepEqual(listed.entries.map((entry) => [entry.projectPath, entry.libraryId]), [[project, created.libraryId]]);
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
  const created = run(["project-create", "--at", at(), "--external-key", "REGISTRY-PROJECT", "--name", "Registry"], join(project, "docs"));
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).version, 1);
  const status = run(["status"], join(project, "docs"));
  assert.equal(JSON.parse(status.stdout).version, 1);
  const outside = run(["status"], base);
  assert.equal(outside.status, 1);
  assert.equal(JSON.parse(outside.stderr).reasonCode, "LIBRARY_NOT_REGISTERED");
  // The catalog declares --workspace optional everywhere but init.
  const catalog = await cli(["commands"]);
  const workspaceFlags = catalog.commands.flatMap((entry) => entry.flags.filter((flag) => flag.name === "workspace").map((flag) => [entry.name, flag.required]));
  assert.deepEqual(workspaceFlags.filter(([, isRequired]) => isRequired), [["init", true]]);
  const registry = JSON.parse(await readFile(join(base, "device", "registry.json"), "utf8"));
  assert.equal(registry.schemaVersion, "einzbern.registry.v1");
});
