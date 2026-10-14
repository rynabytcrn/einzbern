// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 GWT3, the CLI part (MIN-258 D3; TCRN-CROSS-SUB-511): library-unregister takes
// one entry out of this device's registry by its project path, which need not exist any more. Without
// --yes true it answers the plan and writes nothing; with it, registry.json is copied into
// backups/<UTC>-library-unregister/ of the device directory first and then replaced without that one
// entry, and another entry of the same library stays. A project path no entry has is refused with
// LIBRARY_NOT_REGISTERED. Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 11, 0, second)).toISOString().replace(".000Z", "Z");
};

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

/**
 * A device directory of its own (EINZBERN_HOME for this test) and three registered projects: alpha
 * and beta both keep their records in alpha's library, gamma in its own.
 */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-library-unregister-")));
  const previous = process.env.EINZBERN_HOME;
  const device = join(base, "device");
  process.env.EINZBERN_HOME = device;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const project = async (name) => {
    const root = join(base, name);
    await mkdir(root, { recursive: true });
    return root;
  };
  const alpha = await project("alpha");
  const beta = await project("beta");
  const gamma = await project("gamma");
  const shared = join(alpha, ".ether");
  const own = join(gamma, ".ether");
  // Libraries made by the engine's own initializer, so the registry holds the three entries below alone.
  await initializeLibrary({ root: shared, createdAt: at() });
  await initializeLibrary({ root: own, createdAt: at() });
  for (const [root, library] of [[alpha, shared], [beta, shared], [gamma, own]]) {
    await cli(["library-register", "--project", root, "--library", library, "--at", at(), "--cloud-hosted", "false"]);
  }
  const registry = join(device, "registry.json");
  return { base, device, registry, alpha, beta, gamma, shared, own };
}

const entries = async () => (await cli(["library-list"])).entries;

async function backups(fx) {
  try {
    return (await readdir(join(fx.device, "backups"))).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("541 GWT3: library-unregister is a cataloged write of this device's registry: --project and --at required, --yes optional", () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === "library-unregister");
  assert.equal(entry?.mutates, true);
  assert.deepEqual(entry.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [["project", true, "string"], ["at", true, "instant"], ["yes", false, "boolean"]]);
  assert.equal(entry.flags.some((flag) => flag.name === "timeout-ms" || flag.name === "decided-in"), false, "no library write lock and no model write barrier");
});

test("541 GWT3: without --yes true library-unregister answers the plan and writes nothing", async (context) => {
  const fx = await scratch(context);
  const before = await readFile(fx.registry, "utf8");
  const when = at();
  const plan = await cli(["library-unregister", "--project", fx.beta, "--at", when]);
  assert.equal(plan.reasonCode, "LIBRARY_UNREGISTER_PLAN_READY");
  assert.equal(plan.schemaVersion, "einzbern.library-unregister-plan.v1");
  assert.deepEqual([plan.entry.projectPath, plan.entry.libraryPath], [fx.beta, fx.shared]);
  assert.deepEqual([plan.projectPathExists, plan.libraryPathExists, plan.remaining], [true, true, 2]);
  assert.deepEqual(plan.sameLibraryEntries, [fx.alpha], "the other entry of the same library is named, and stays");
  assert.equal(plan.registry, fx.registry);
  assert.equal(plan.backupDirectory, join(fx.device, "backups", `${when.replace(/[-:]/gu, "")}-library-unregister`));
  assert.equal(await readFile(fx.registry, "utf8"), before, "the registry is as it was");
  assert.deepEqual(await backups(fx), [], "no backup is written for a plan");
  assert.equal((await cli(["library-unregister", "--project", fx.beta, "--at", at(), "--yes", "false"])).reasonCode, "LIBRARY_UNREGISTER_PLAN_READY", "--yes false is a plan too");
  assert.equal((await refusal(["library-unregister", "--project", fx.beta, "--at", at(), "--yes", "maybe"])).reasonCode, "CLI_ARGUMENT_MALFORMED");
});

test("541 GWT3: with --yes true it copies the registry to backups first, then takes out the one entry; the other entry of the same library stays", async (context) => {
  const fx = await scratch(context);
  const before = await readFile(fx.registry, "utf8");
  const when = at();
  const done = await cli(["library-unregister", "--project", fx.beta, "--at", when, "--yes", "true"]);
  assert.equal(done.reasonCode, "LIBRARY_UNREGISTERED");
  assert.equal(done.entry.projectPath, fx.beta);
  const directory = join(fx.device, "backups", `${when.replace(/[-:]/gu, "")}-library-unregister`);
  assert.deepEqual([done.backupDirectory, done.backupPath], [directory, join(directory, "registry.json")]);
  assert.equal(await readFile(done.backupPath, "utf8"), before, "the backup is the registry as it stood");
  const left = await entries();
  assert.deepEqual(left.map((entry) => entry.projectPath), [fx.alpha, fx.gamma]);
  assert.equal(left.find((entry) => entry.projectPath === fx.alpha).libraryPath, fx.shared, "the entry sharing the library id is kept");
  // The project resolves no more; the one that shares its library still does.
  assert.equal((await refusal(["library-resolve", "--cwd", fx.beta])).reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal((await cli(["library-resolve", "--cwd", fx.alpha])).libraryPath, fx.shared);

  // Taking it out again is refused, and the registry and the backups stay as they are.
  const after = await readFile(fx.registry, "utf8");
  const refused = await refusal(["library-unregister", "--project", fx.beta, "--at", at(), "--yes", "true"]);
  assert.equal(refused.reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal(await readFile(fx.registry, "utf8"), after);
  assert.deepEqual(await backups(fx), [`${when.replace(/[-:]/gu, "")}-library-unregister`]);
});

test("541 GWT3: an entry whose project and library are gone is taken out by its recorded path; a second removal at the same instant backs up beside the first", async (context) => {
  const fx = await scratch(context);
  // gamma moves away: its entry now names a project and a library that do not exist.
  await rename(fx.gamma, join(fx.base, "gamma-moved"));
  const when = at();
  const plan = await cli(["library-unregister", "--project", fx.gamma, "--at", when]);
  assert.deepEqual([plan.entry.projectPath, plan.projectPathExists, plan.libraryPathExists, plan.sameLibraryEntries], [fx.gamma, false, false, []]);
  const first = await cli(["library-unregister", "--project", fx.gamma, "--at", when, "--yes", "true"]);
  assert.equal(first.reasonCode, "LIBRARY_UNREGISTERED");
  const second = await cli(["library-unregister", "--project", fx.beta, "--at", when, "--yes", "true"]);
  assert.equal(second.backupDirectory, `${first.backupDirectory}-2`, "a taken backup directory is never written into again");
  assert.deepEqual((await entries()).map((entry) => entry.projectPath), [fx.alpha]);
  // The second backup holds the registry as the first removal left it.
  assert.deepEqual(JSON.parse(await readFile(second.backupPath, "utf8")).entries.map((entry) => entry.projectPath), [fx.alpha, fx.beta]);
});

test("541 GWT3: a project path no entry has is refused with LIBRARY_NOT_REGISTERED, and --project and --at are required", async (context) => {
  const fx = await scratch(context);
  const before = await readFile(fx.registry, "utf8");
  for (const project of [join(fx.base, "nowhere"), join(fx.alpha, ".ether")]) {
    const refused = await refusal(["library-unregister", "--project", project, "--at", at(), "--yes", "true"]);
    assert.equal(refused.reasonCode, "LIBRARY_NOT_REGISTERED", project);
  }
  assert.equal((await refusal(["library-unregister", "--project", fx.alpha])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["library-unregister", "--at", at()])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal(await readFile(fx.registry, "utf8"), before);
  assert.deepEqual(await backups(fx), []);
});
