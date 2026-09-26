// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-471 R2, R3, AC2, AC3 and STORY-469 R3 (MIN-227 D22, D23): engine versions live in
// engine/<version>/ of the device directory, engine/current names the one in use, and hooks name
// only the stable entry engine/einzbern.mjs. Switching versions rewrites engine/current alone, so
// the host files stay byte for byte and their hooks keep running; rollback makes the previous
// version current again, and every refused update leaves engine/current where it was.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, computeInstallTreeDigest } from "../dist/build/packages/core/src/index.js";
import { compareSemver, parseEngineVersion } from "../dist/build/packages/core/src/format-version.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const parts = parseEngineVersion(FRAMEWORK_VERSION);
// Derived from the running version: a literal would stop being newer the day the engine reaches it.
const NEWER = `${parts.major}.${BigInt(parts.minor) + 1n}.0`;
const OLDER = "0.1.0";
assert.ok(compareSemver(OLDER, FRAMEWORK_VERSION) < 0 && compareSemver(FRAMEWORK_VERSION, NEWER) < 0);

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 14, 0, second)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-engine-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return { base, home };
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

/**
 * A minimal runnable engine unpacked at <base>/trees/<version>: this build's entry, its dist/build
 * and the policy file it reads at load, answering as `version`.
 */
async function engineTree(base, version, name = version) {
  const tree = join(base, "trees", name);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  if (version !== FRAMEWORK_VERSION) {
    const index = join(tree, "dist/build/packages/core/src/index.js");
    const declaration = `export const FRAMEWORK_VERSION = "${FRAMEWORK_VERSION}";`;
    const source = await readFile(index, "utf8");
    assert.ok(source.includes(declaration), "the built index declares the engine version");
    await writeFile(index, source.replace(declaration, `export const FRAMEWORK_VERSION = "${version}";`));
  }
  return { tree, version, sha256: (await computeInstallTreeDigest(tree)).sha256 };
}

const update = (engine) => cli(["engine-update", "--from", engine.tree, "--sha256", engine.sha256, "--version", engine.version, "--at", at()]);

/** Place the stable entry the way an installer does: engine/einzbern.mjs in the device directory. */
async function installLauncher(home) {
  await mkdir(join(home, "engine"), { recursive: true });
  const launcher = join(home, "engine", "einzbern.mjs");
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), launcher);
  return launcher;
}

function viaLauncher(home, args) {
  return spawnSync(process.execPath, [join(home, "engine", "einzbern.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: home },
  });
}

function stderrRefusal(run) {
  return JSON.parse(run.stderr.trim().split("\n").at(-1));
}

test("471-R2: engine-update copies a checked version into engine/<version>, runs it once and makes it current", async (context) => {
  const { base, home } = await scratch(context);
  const empty = await cli(["engine-list"]);
  assert.equal(empty.reasonCode, "ENGINE_LIST_READY");
  assert.equal(empty.engineVersion, FRAMEWORK_VERSION);
  assert.equal(empty.formatVersion, 1);
  assert.equal(empty.current, null);
  assert.deepEqual(empty.versions, []);
  assert.deepEqual(empty.launcher, { path: join(home, "engine", "einzbern.mjs"), present: false });
  const engine = await engineTree(base, FRAMEWORK_VERSION);
  const installed = await update(engine);
  assert.equal(installed.reasonCode, "ENGINE_UPDATED");
  assert.equal(installed.installed, "copied");
  assert.deepEqual(installed.engine, { engineVersion: FRAMEWORK_VERSION, formatVersion: 1 });
  assert.equal(installed.current.version, FRAMEWORK_VERSION);
  assert.equal(installed.current.previous, null);
  assert.deepEqual(installed.libraries, []);
  assert.equal((await computeInstallTreeDigest(join(home, "engine", FRAMEWORK_VERSION))).sha256, engine.sha256, "the installed copy hashes as stated");
  assert.equal(await readFile(join(home, "engine", "current"), "utf8"), canonicalJson(installed.current));
  assert.deepEqual((await readdir(join(home, "engine"))).sort(), [FRAMEWORK_VERSION, "current"].sort(), "no temporary copy is left behind");
  const again = await update(engine);
  assert.equal(again.installed, "reused", "the same bytes under the same version are reused");
  assert.equal(again.current.previous, null, "re-installing the current version keeps its previous");
  const listed = await cli(["engine-list"]);
  assert.equal(listed.current.version, FRAMEWORK_VERSION);
  assert.deepEqual(listed.versions, [FRAMEWORK_VERSION]);
});

test("471-AC2: switching current leaves settings.json and .codex/hooks.json byte for byte, and their hooks still run", async (context) => {
  const { base, home } = await scratch(context);
  const older = await engineTree(base, FRAMEWORK_VERSION);
  const newer = await engineTree(base, NEWER);
  await update(older);
  await update(newer);
  const launcher = await installLauncher(home);
  const project = join(base, "project");
  await mkdir(project);
  const library = join(project, ".ether");
  await cli(["init", "--workspace", library, "--at", at(), "--project", project]);
  // The host files name the stable entry and nothing else; they stand in for ~/.claude/settings.json
  // and the project's .codex/hooks.json.
  const command = `"${process.execPath}" "${launcher}" status --workspace "${library}"`;
  const hostFiles = [join(base, "user-home", ".claude", "settings.json"), join(project, ".codex", "hooks.json")];
  for (const path of hostFiles) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } }, null, 2)}\n`);
  }
  const bytes = await Promise.all(hostFiles.map((path) => readFile(path)));
  const hookVersions = async () => {
    const versions = [];
    for (const path of hostFiles) {
      const hook = JSON.parse(await readFile(path, "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;
      const run = spawnSync(hook, { shell: true, encoding: "utf8", env: { ...process.env, EINZBERN_HOME: home } });
      assert.equal(run.status, 0, run.stderr);
      const status = JSON.parse(run.stdout);
      assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
      versions.push(status.engineVersion);
    }
    return versions;
  };
  assert.deepEqual(await hookVersions(), [NEWER, NEWER]);
  const rolled = await cli(["engine-rollback", "--at", at()]);
  assert.equal(rolled.current.version, FRAMEWORK_VERSION);
  assert.deepEqual(await Promise.all(hostFiles.map((path) => readFile(path))), bytes, "rolling back changes no host file");
  assert.deepEqual(await hookVersions(), [FRAMEWORK_VERSION, FRAMEWORK_VERSION], "the same hooks now run the older version");
  const forward = await update(newer);
  assert.equal(forward.installed, "reused");
  assert.deepEqual(await Promise.all(hostFiles.map((path) => readFile(path))), bytes, "switching forward changes no host file");
  assert.deepEqual(await hookVersions(), [NEWER, NEWER]);
});

test("471-AC3: after an update, rollback points current at the old version and status runs through the stable entry", async (context) => {
  const { base, home } = await scratch(context);
  const older = await engineTree(base, FRAMEWORK_VERSION);
  const newer = await engineTree(base, NEWER);
  await update(older);
  await installLauncher(home);
  const project = join(base, "project");
  await mkdir(project);
  const library = join(project, ".ether");
  // The library is made through the stable entry, by the version current at the time.
  const init = viaLauncher(home, ["init", "--workspace", library, "--at", at(), "--project", project]);
  assert.equal(init.status, 0, init.stderr);
  const updated = await update(newer);
  assert.equal(updated.current.version, NEWER);
  assert.equal(updated.current.previous, FRAMEWORK_VERSION);
  assert.deepEqual(updated.libraries.map((entry) => [entry.libraryPath, entry.opens, entry.reasonCode]), [[library, true, null]],
    "the registered library opens under the new version");
  assert.equal(JSON.parse(viaLauncher(home, ["status", "--workspace", library]).stdout).engineVersion, NEWER);
  const rolled = await cli(["engine-rollback", "--at", at()]);
  assert.equal(rolled.reasonCode, "ENGINE_ROLLED_BACK");
  assert.deepEqual(rolled.engine, { engineVersion: FRAMEWORK_VERSION, formatVersion: 1 });
  assert.equal(rolled.current.version, FRAMEWORK_VERSION);
  assert.equal(rolled.current.previous, NEWER);
  assert.equal(JSON.parse(await readFile(join(home, "engine", "current"), "utf8")).version, FRAMEWORK_VERSION);
  const status = viaLauncher(home, ["status", "--workspace", library]);
  assert.equal(status.status, 0, status.stderr);
  const answered = JSON.parse(status.stdout);
  assert.equal(answered.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(answered.engineVersion, FRAMEWORK_VERSION);
  // A second rollback undoes the first.
  assert.equal((await cli(["engine-rollback", "--at", at()])).current.version, NEWER);
});

test("471-R3: a tree that does not hash as stated, runs as another version or does not start is refused, and current does not move", async (context) => {
  const { base, home } = await scratch(context);
  await update(await engineTree(base, FRAMEWORK_VERSION));
  const pointer = await readFile(join(home, "engine", "current"));
  const newer = await engineTree(base, NEWER);
  const mismatch = await refusal(["engine-update", "--from", newer.tree, "--sha256", "0".repeat(64), "--version", NEWER, "--at", at()]);
  assert.equal(mismatch.reasonCode, "INSTALL_TREE_DIGEST_MISMATCH");
  assert.equal(mismatch.details.actual, newer.sha256);
  const mislabelled = await refusal(["engine-update", "--from", newer.tree, "--sha256", newer.sha256, "--version", "9.8.7", "--at", at()]);
  assert.equal(mislabelled.reasonCode, "ENGINE_VERSION_MISMATCH");
  assert.deepEqual([mislabelled.details.required, mislabelled.details.actual], ["9.8.7", NEWER]);
  const bare = join(base, "trees", "bare");
  await mkdir(bare, { recursive: true });
  await writeFile(join(bare, "README.md"), "no engine here\n");
  const bareRefusal = await refusal(["engine-update", "--from", bare, "--sha256", (await computeInstallTreeDigest(bare)).sha256, "--version", NEWER, "--at", at()]);
  assert.equal(bareRefusal.reasonCode, "ENGINE_TREE_INVALID");
  const broken = join(base, "trees", "broken");
  await mkdir(join(broken, "scripts"), { recursive: true });
  await writeFile(join(broken, "scripts", "einzbern.mjs"), "process.exitCode = 3;\n");
  const brokenRefusal = await refusal(["engine-update", "--from", broken, "--sha256", (await computeInstallTreeDigest(broken)).sha256, "--version", NEWER, "--at", at()]);
  assert.equal(brokenRefusal.reasonCode, "ENGINE_PROBE_FAILED");
  assert.equal((await refusal(["engine-update", "--from", newer.tree, "--sha256", newer.sha256, "--version", "latest", "--at", at()])).reasonCode, "ENGINE_VERSION_INVALID");
  assert.deepEqual(await readFile(join(home, "engine", "current")), pointer, "engine/current is where it was");
  assert.deepEqual((await readdir(join(home, "engine"))).sort(), [FRAMEWORK_VERSION, "current"].sort(), "nothing refused is left installed");
  // engine/<version> holding other bytes is a conflict and is never overwritten.
  const altered = await engineTree(base, FRAMEWORK_VERSION, "altered");
  await writeFile(join(altered.tree, "EXTRA.md"), "another build\n");
  const alteredDigest = (await computeInstallTreeDigest(altered.tree)).sha256;
  const conflict = await refusal(["engine-update", "--from", altered.tree, "--sha256", alteredDigest, "--version", FRAMEWORK_VERSION, "--at", at()]);
  assert.equal(conflict.reasonCode, "ENGINE_VERSION_CONFLICT");
  assert.equal((await readdir(join(home, "engine", FRAMEWORK_VERSION))).includes("EXTRA.md"), false, "the installed version keeps its own bytes");
  assert.deepEqual(await readFile(join(home, "engine", "current")), pointer);
});

test("471-R3: rollback needs a previous version that is still installed", async (context) => {
  const { base, home } = await scratch(context);
  const nothing = await refusal(["engine-rollback", "--at", at()]);
  assert.equal(nothing.reasonCode, "ENGINE_ROLLBACK_UNAVAILABLE");
  await update(await engineTree(base, FRAMEWORK_VERSION));
  assert.equal((await refusal(["engine-rollback", "--at", at()])).reasonCode, "ENGINE_ROLLBACK_UNAVAILABLE", "the first version has no previous one");
  await update(await engineTree(base, NEWER));
  await rename(join(home, "engine", FRAMEWORK_VERSION), join(base, "moved-away"));
  const gone = await refusal(["engine-rollback", "--at", at()]);
  assert.equal(gone.reasonCode, "ENGINE_ROLLBACK_UNAVAILABLE");
  assert.equal(gone.details.required, FRAMEWORK_VERSION);
  assert.equal(JSON.parse(await readFile(join(home, "engine", "current"), "utf8")).version, NEWER, "current stays where it was");
});

test("471-R3: after a switch every registered library is checked against the engine now current", async (context) => {
  const { base } = await scratch(context);
  const projects = { plain: join(base, "plain"), future: join(base, "future") };
  for (const project of Object.values(projects)) {
    await mkdir(project);
    await cli(["init", "--workspace", join(project, ".ether"), "--at", at(), "--project", project]);
  }
  const futureManifest = join(projects.future, ".ether", "manifest.json");
  await writeFile(futureManifest, canonicalJson({ ...JSON.parse(await readFile(futureManifest, "utf8")), formatVersion: 99 }));
  const downgraded = await update(await engineTree(base, OLDER));
  const byProject = Object.fromEntries(downgraded.libraries.map((entry) => [entry.projectPath, entry]));
  assert.equal(byProject[projects.plain].opens, false);
  assert.equal(byProject[projects.plain].reasonCode, "ENGINE_TOO_OLD");
  assert.deepEqual([byProject[projects.plain].details.required, byProject[projects.plain].details.actual], [FRAMEWORK_VERSION, OLDER]);
  assert.equal(byProject[projects.future].reasonCode, "LIBRARY_FORMAT_UNSUPPORTED");
  assert.deepEqual([byProject[projects.future].details.required, byProject[projects.future].details.supported], ["99", "1"]);
  assert.equal(downgraded.incompatible, 2);
  const restored = await update(await engineTree(base, FRAMEWORK_VERSION));
  const again = Object.fromEntries(restored.libraries.map((entry) => [entry.projectPath, entry]));
  assert.equal(again[projects.plain].opens, true);
  assert.equal(again[projects.plain].reasonCode, null);
  assert.equal(again[projects.future].reasonCode, "LIBRARY_FORMAT_UNSUPPORTED");
  assert.equal(restored.incompatible, 1);
});

test("471-R2: the stable entry refuses when no version is current or the current one is not installed, and passes exit codes through", async (context) => {
  const { base, home } = await scratch(context);
  await installLauncher(home);
  const none = viaLauncher(home, ["engine-list"]);
  assert.equal(none.status, 1);
  assert.equal(stderrRefusal(none).reasonCode, "ENGINE_CURRENT_INVALID");
  const current = join(home, "engine", "current");
  await writeFile(current, canonicalJson({ schemaVersion: "einzbern.engine-current.v1", version: NEWER, previous: null, switchedAt: at() }));
  const missing = viaLauncher(home, ["engine-list"]);
  assert.equal(missing.status, 1);
  assert.equal(stderrRefusal(missing).reasonCode, "ENGINE_NOT_INSTALLED");
  await writeFile(current, "{");
  assert.equal(stderrRefusal(viaLauncher(home, ["engine-list"])).reasonCode, "ENGINE_CURRENT_INVALID");
  // engine-list reports a damaged pointer rather than failing, and engine-update replaces it.
  const listed = await cli(["engine-list"]);
  assert.equal(listed.current, null);
  assert.equal(listed.currentReasonCode, "ENGINE_CURRENT_INVALID");
  const repaired = await update(await engineTree(base, FRAMEWORK_VERSION));
  assert.equal(repaired.current.previous, null);
  const answered = viaLauncher(home, ["engine-list"]);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(JSON.parse(answered.stdout).current.version, FRAMEWORK_VERSION);
  const unknown = viaLauncher(home, ["no-such-verb"]);
  assert.equal(unknown.status, 1, "the engine's exit code comes through the stable entry");
  assert.equal(stderrRefusal(unknown).reasonCode, "CLI_COMMAND_UNKNOWN");
});
