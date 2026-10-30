// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-480 R1, R2, R5, R6, AC1, AC2 (TCRN-CROSS-SUB-323): setup --mode fresh. A plan
// lists every file it would write and writes none; the apply with the default answers leaves the
// library, the registry entry, both skill copies, one hook per host, CLAUDE.md's import section and
// AGENTS.md's navigation section, lists each file it wrote and passes doctor's eight checks; a
// second run writes nothing. Originals are backed up before they are replaced, a symbolic link in
// a host file stops the plan before anything is written, and migrate says what it found.
// Every home, device directory and project here is a temporary directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, chainIdentity, computeInstallTreeDigest, materializeWorkspace, readStorageLocation, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { DOCTOR_CHECKS, runDoctor } from "../dist/build/packages/core/src/doctor.js";
import { SETUP_MODES, applySetup, detectSetupContext, planSetup } from "../dist/build/packages/core/src/setup.js";
import { SKILL_COPY_ROOTS, skillCopyPath } from "../dist/build/packages/core/src/skill-copies.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");
const setupModule = pathToFileURL(join(repositoryRoot, "dist/build/packages/core/src/setup.js")).href;

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-setup-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 3, 0, second)).toISOString().replace(".000Z", "Z");
};
const stampOf = (instant) => instant.replace(/[-:]/gu, "");

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * The engine version directory as a release lays it out (scripts/pack-release.mjs), built from this
 * checkout the way tests/engine-home.test.mjs builds one: the entry, dist/build and the policy file
 * it reads, plus the two launchers and the skill rendered for this version.
 */
async function engineTree(base) {
  const tree = join(base, "trees", FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook.mjs"), join(tree, "scripts/einzbern-hook.mjs"));
  await mkdir(join(tree, "scripts", "lib"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  await mkdir(join(tree, "launchers"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), join(tree, "launchers/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), join(tree, "launchers/hook.mjs"));
  const rendered = await cli(["skill-render", "--out", join(tree, "skill", "mana-orchestrate"), "--version", FRAMEWORK_VERSION]);
  assert.equal(rendered.reasonCode, "SKILL_RENDERED");
  return { tree, sha256: (await computeInstallTreeDigest(tree)).sha256 };
}

/** A temporary home, device directory and project; the engine installed on the device unless told not to. */
async function fixture(context, { engine = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-setup-")));
  const home = join(base, "home");
  const deviceHome = join(base, "device");
  const project = join(base, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const previous = { device: process.env.EINZBERN_HOME, home: process.env.HOME, profile: process.env.USERPROFILE };
  // The library writes go through the process's device directory, as the engine's own do.
  process.env.EINZBERN_HOME = deviceHome;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  context.after(async () => {
    restoreEnv("EINZBERN_HOME", previous.device);
    restoreEnv("HOME", previous.home);
    restoreEnv("USERPROFILE", previous.profile);
    await rm(base, { recursive: true, force: true });
  });
  if (engine) {
    const tree = await engineTree(base);
    const installed = await cli(["engine-update", "--from", tree.tree, "--sha256", tree.sha256, "--version", FRAMEWORK_VERSION, "--at", at()]);
    assert.equal(installed.reasonCode, "ENGINE_UPDATED");
  }
  return { base, home, deviceHome, project };
}

function plan(f, answers = {}, extra = {}) {
  return planSetup({ mode: "fresh", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome, answers, ...extra });
}

function rows(writes) {
  return writes.map((entry) => [entry.step, entry.path, entry.action]);
}

// Every hook command that runs the Einzbern launcher, per event.
async function einzbernHooks(path) {
  const document = JSON.parse(await readFile(path, "utf8"));
  const found = [];
  for (const [event, groups] of Object.entries(document.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (/^node "[^"]+[\\/]engine[\\/]hook\.mjs" [a-z-]+$/u.test(hook.command)) found.push([event, hook.command]);
      }
    }
  }
  return found;
}

function assertSelfCheckGreen(applied) {
  assert.deepEqual(applied.selfCheck.map((entry) => entry.check), [...DOCTOR_CHECKS]);
  for (const entry of applied.selfCheck) assert.equal(entry.ok, true, `${entry.check}: ${JSON.stringify(entry.detail)}`);
}

// Every file and directory under the roots, with its size and modification time.
async function snapshot(roots) {
  const lines = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      lines.push(`${path} ${entry.isDirectory() ? "dir" : stats.size} ${stats.mtimeMs}`);
      if (entry.isDirectory()) await walk(path);
    }
  }
  for (const root of roots) await walk(root);
  return lines;
}

// Git in a temporary project, under the fixture's temporary home. The tests only put files into the
// index: they never commit, so no identity is configured.
function git(directory, ...args) {
  const run = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

// The project as a Git repository holding its two host files, each with content of its own; a test
// puts them into the index with `git add` when it wants them tracked.
const HOST_FILES = Object.freeze([".claude/settings.local.json", ".codex/config.toml"]);
async function repositoryWithHostFiles(project) {
  git(project, "init", "-q");
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(join(project, ".codex"), { recursive: true });
  await writeFile(join(project, ".claude", "settings.local.json"), "{}\n");
  await writeFile(join(project, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

// The warning setup gives for each tracked host file, in the words scripts/host-render.mjs uses.
function trackedWarnings(files = HOST_FILES) {
  return files.map((file) => ({
    reasonCode: "HOST_WRITABLE_ROOTS_TRACKED_BY_GIT",
    file,
    message: `${file} is tracked by Git and may publish this device's library path if committed`,
  }));
}

// planSetup in a child process under the write tripwire over the home, the device directory and the project.
async function planUnderTripwire(f, options) {
  const script = join(f.base, "plan-only.mjs");
  await writeFile(script, `import { planSetup } from ${JSON.stringify(setupModule)};\nprocess.stdout.write(JSON.stringify(await planSetup(JSON.parse(process.argv[2]))));\n`);
  const run = spawnSync(process.execPath, ["--import", tripwirePath, script, JSON.stringify(options)], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, EINZBERN_HOME: f.deviceHome, EINZBERN_TRIPWIRE_ROOT: [f.home, f.deviceHome, f.project].join(delimiter) },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("480-R1, R6: six modes, and migrate names an installation from before the rename", async (context) => {
  assert.deepEqual([...SETUP_MODES], ["fresh", "restore", "update", "repair", "migrate", "uninstall"]);
  const f = await fixture(context, { engine: false });
  await assert.rejects(planSetup({ mode: "install", projectRoot: f.project, at: at() }), { reasonCode: "SETUP_MODE_INVALID" });
  await assert.rejects(plan(f, {}, { restore: join(f.base, "library") }), { reasonCode: "SETUP_OPTION_NOT_APPLICABLE" });
  await assert.rejects(plan(f, { language: "de-DE" }), { reasonCode: "SETUP_ANSWER_INVALID" });
  await assert.rejects(planSetup({ mode: "migrate", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome }), { reasonCode: "SETUP_MIGRATE_NOTHING" });
  assert.equal((await detectSetupContext({ projectRoot: f.project, home: f.home, deviceHome: f.deviceHome })).suggestedMode, "fresh");

  // The old device directory in the home is an installation from before the rename.
  await mkdir(join(f.home, ".tcrn-workflow"));
  const found = await detectSetupContext({ projectRoot: f.project, home: f.home, deviceHome: f.deviceHome });
  assert.deepEqual(found.legacy, { detected: true, controlDirectory: null, deviceDirectory: join(f.home, ".tcrn-workflow") });
  assert.equal(found.suggestedMode, "migrate");
  // TCRN-CROSS-STORY-489 R1: migrate plans it; with no mapping to follow and none to infer, the plan
  // names the question and cannot be applied.
  const migrate = await planSetup({ mode: "migrate", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome });
  assert.equal(migrate.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(migrate.context.legacy, found.legacy);
  assert.equal(migrate.migration.mapping, null);
  assert.deepEqual(migrate.blockers.map((blocker) => [blocker.step, blocker.reasonCode]), [["engine", "SETUP_ENGINE_NOT_INSTALLED"], ["library", "SETUP_ANSWER_REQUIRED"]]);
  await assert.rejects(applySetup(migrate), { reasonCode: "SETUP_BLOCKED" });
  // A fresh plan still plans, and says which mode the context points to; with no engine current it cannot be applied.
  const fresh = await plan(f, { language: "zh" });
  assert.equal(fresh.context.suggestedMode, "migrate");
  assert.equal(fresh.resolved.language, "zh-CN");
  for (const language of ["fr", "ja", "ko"]) {
    assert.equal((await plan(f, { language })).resolved.language, language, `${language} is backed by the core language policy`);
  }
  assert.deepEqual(fresh.blockers.map((blocker) => [blocker.step, blocker.reasonCode]), [["engine", "SETUP_ENGINE_NOT_INSTALLED"]]);
  await assert.rejects(applySetup(fresh), (error) => {
    assert.equal(error.reasonCode, "SETUP_BLOCKED");
    assert.equal(error.details.reasonCode, "SETUP_ENGINE_NOT_INSTALLED");
    return true;
  });
  assert.equal(await lstat(join(dirname(f.deviceHome), "Ether")).catch(() => null), null, "nothing was written");
});

test("480-AC1: the default answers install the library, the registry entry, both skill copies, current hooks per host and the managed sections, and list every file", async (context) => {
  const f = await fixture(context);
  const planned = await plan(f);
  assert.equal(planned.reasonCode, "SETUP_PLAN_READY");
  assert.equal(planned.mode, "fresh");
  assert.deepEqual(planned.blockers, []);
  assert.equal(planned.context.suggestedMode, "fresh");
  // One screen of questions, each with the default it takes.
  assert.deepEqual(planned.questions.map((question) => [question.id, question.flag, question.default]), [
    ["artifacts", "--artifacts", join(dirname(f.deviceHome), "Ether")],
    ["cloud", "--cloud", false],
    ["language", "--language", "en"],
    ["navigation", "--navigation", true],
  ]);
  const expected = [
    ["device", join(f.deviceHome, "device.json"), "create"],
    ["library", join(dirname(f.deviceHome), "Ether"), "create"],
    ["registry", join(f.deviceHome, "registry.json"), "create"],
    ["skill-copies", join(f.home, ".claude", "skills", "mana-orchestrate"), "create"],
    ["skill-copies", join(f.home, ".agents", "skills", "mana-orchestrate"), "create"],
    ["skill-copies", join(f.deviceHome, "skills.json"), "create"],
    ["launchers", join(f.deviceHome, "engine", "einzbern.mjs"), "create"],
    ["launchers", join(f.deviceHome, "engine", "hook.mjs"), "create"],
    ["host-hooks", join(f.home, ".claude", "settings.json"), "create"],
    ["host-hooks", join(f.home, ".codex", "hooks.json"), "create"],
    ["host-hooks", join(f.home, ".codex", "config.toml"), "create"],
    ["writable-roots", join(f.project, ".claude/settings.local.json"), "create"],
    ["writable-roots", join(f.project, ".codex/config.toml"), "create"],
    ["machine-settings", join(f.deviceHome, "machine-settings.json"), "create"],
    ["managed-sections", join(f.project, "AGENTS.md"), "create"],
    ["managed-sections", join(f.project, "CLAUDE.md"), "create"],
    ["device", join(f.deviceHome, "storage-location.json"), "create"],
  ];
  assert.deepEqual(rows(planned.writes), expected);
  assert.deepEqual(planned.backups, []);
  assert.equal(planned.backupDir, null);
  // TCRN-CROSS-INIT-053 R46 (I08): the plan names the coordination chain it creates at this device's
  // default location, and the receipt the one it registered there.
  assert.deepEqual(planned.coordination, { libraryId: null, status: "registered", path: join(dirname(f.deviceHome), "Ether") });

  const applied = await applySetup(planned);
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(rows(applied.written), expected, "the summary lists every file written");
  assert.equal(applied.backupDir, null);
  assert.equal(applied.library.created, true);
  assert.deepEqual(applied.answers, { artifacts: join(dirname(f.deviceHome), "Ether"), cloud: false, language: "en", navigation: true });

  const manifest = JSON.parse(await readFile(join(dirname(f.deviceHome), "Ether", "manifest.json"), "utf8"));
  assert.equal(manifest.libraryId, applied.library.libraryId);
  assert.equal(manifest.project.name, "project");
  const registry = JSON.parse(await readFile(join(f.deviceHome, "registry.json"), "utf8"));
  // The coordination library is registered as setup registers it, its own path the project path,
  // and the project's library names it (EPIC-144 R2).
  const coordination = join(dirname(f.deviceHome), "Ether");
  const coordinationId = chainIdentity(await materializeWorkspace(join(dirname(f.deviceHome), "Ether"))).coordinationLibraryId;
  assert.deepEqual(registry.entries.map((entry) => [entry.projectPath, entry.libraryPath, entry.libraryId, entry.cloudHosted, entry.chainRole]),
    [[f.project, join(dirname(f.deviceHome), "Ether"), applied.library.libraryId, false, "project"]]);
  assert.deepEqual(applied.coordination, { libraryId: coordinationId, status: "registered", path: coordination });
  const state = await materializeWorkspace(join(dirname(f.deviceHome), "Ether"));
  assert.equal(state.settings.find((setting) => setting.key === "artifact.language")?.value, "en");
  for (const root of SKILL_COPY_ROOTS) assert.ok((await lstat(join(skillCopyPath(f.home, root), "SKILL.md"))).isFile(), root.host);
  const launcher = join(f.deviceHome, "engine", "hook.mjs");
  assert.deepEqual(await readFile(launcher), await readFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs")));
  assert.deepEqual(await einzbernHooks(join(f.home, ".claude", "settings.json")), [["UserPromptSubmit", `node "${launcher}" user-prompt-submit`], ["SubagentStart", `node "${launcher}" subagent-start`], ["PreToolUse", `node "${launcher}" pre-tool-use`]]);
  assert.deepEqual(await einzbernHooks(join(f.home, ".codex", "hooks.json")), [["UserPromptSubmit", `node "${launcher}" user-prompt-submit`], ["SubagentStart", `node "${launcher}" subagent-start`], ["PreToolUse", `node "${launcher}" pre-tool-use`]]);
  assert.match(await readFile(join(f.home, ".codex", "config.toml"), "utf8"), /^\[features\]\nhooks = true$/mu);
  const claude = await readFile(join(f.project, "CLAUDE.md"), "utf8");
  assert.match(claude, /<!-- einzbern:section id=claude-import rev=1 digest=[0-9a-f]{64} -->\n@AGENTS\.md\n<!-- einzbern:section-end id=claude-import -->/u);
  const agents = await readFile(join(f.project, "AGENTS.md"), "utf8");
  assert.match(agents, /<!-- einzbern:section id=navigation rev=1 digest=[0-9a-f]{64} -->\nThis project is managed by Einzbern\./u);
  assert.equal(JSON.parse(await readFile(join(f.deviceHome, "machine-settings.json"), "utf8")).values["agents.navigation"], "written");
  // Nothing in the project names this machine's paths, and the project's own host settings are untouched.
  for (const file of ["AGENTS.md", "CLAUDE.md"]) assert.ok(!(await readFile(join(f.project, file), "utf8")).includes(f.base), file);
  assert.ok((await readFile(join(f.project, ".claude/settings.local.json"), "utf8")).includes(applied.library.path));
  assert.equal(await lstat(join(f.project, ".ether")).catch(() => null), null);
  assertSelfCheckGreen(applied);
});

test("480-AC2: a second run with the same answers plans no write and writes nothing: no second hook, copy or section", async (context) => {
  const f = await fixture(context);
  const first = await applySetup(await plan(f));
  assertSelfCheckGreen(first);
  const files = [
    join(f.home, ".claude", "settings.json"),
    join(f.home, ".codex", "hooks.json"),
    join(f.home, ".codex", "config.toml"),
    join(f.project, "AGENTS.md"),
    join(f.project, "CLAUDE.md"),
    join(f.deviceHome, "registry.json"),
    join(f.deviceHome, "skills.json"),
    join(f.deviceHome, "machine-settings.json"),
  ];
  const before = await Promise.all(files.map((path) => readFile(path, "utf8")));
  const copies = await snapshot([join(f.home, ".claude", "skills"), join(f.home, ".agents", "skills")]);

  const context2 = await detectSetupContext({ projectRoot: f.project, home: f.home, deviceHome: f.deviceHome });
  assert.equal(context2.registered?.libraryPath, join(dirname(f.deviceHome), "Ether"));
  assert.equal(context2.suggestedMode, "update");
  const again = await plan(f);
  assert.deepEqual(again.blockers, []);
  assert.equal(again.library.action, "reuse");
  assert.deepEqual(again.writes, [], "a second plan writes nothing");
  // R46 I08: the second plan finds the coordination chain the first registered.
  const registeredCoordination = { libraryId: chainIdentity(await materializeWorkspace(join(dirname(f.deviceHome), "Ether"))).coordinationLibraryId, status: "registered", path: join(dirname(f.deviceHome), "Ether") };
  assert.deepEqual(again.coordination, registeredCoordination);
  assert.deepEqual(again.questions.map((question) => [question.id, question.default]), [
    ["artifacts", join(dirname(f.deviceHome), "Ether")],
    ["cloud", false],
    ["language", "en"],
    ["navigation", true],
  ]);
  const second = await applySetup(again);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.coordination, registeredCoordination);
  assert.equal(second.library.created, false);
  assert.equal(second.library.libraryId, first.library.libraryId);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before, "every file keeps its bytes");
  assert.deepEqual(await snapshot([join(f.home, ".claude", "skills"), join(f.home, ".agents", "skills")]), copies);
  assert.equal((await einzbernHooks(join(f.home, ".claude", "settings.json"))).length, 3);
  assert.equal((await einzbernHooks(join(f.home, ".codex", "hooks.json"))).length, 3);
  assert.equal((before[3].match(/einzbern:section id=navigation /gu) ?? []).length, 1);
  assertSelfCheckGreen(second);
});

test("480-R5: without --yes nothing is written: the plan runs under the write tripwire, before and after an installation", async (context) => {
  const f = await fixture(context);
  const options = { mode: "fresh", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome };
  const roots = [f.home, f.deviceHome, f.project];
  const before = await snapshot(roots);
  const first = await planUnderTripwire(f, options);
  assert.equal(first.reasonCode, "SETUP_PLAN_READY");
  assert.ok(first.writes.length > 0);
  assert.deepEqual(await snapshot(roots), before, "the plan wrote nothing");

  await applySetup(await plan(f));
  const installed = await snapshot(roots);
  const again = await planUnderTripwire(f, { ...options, at: at() });
  assert.equal(again.library.action, "reuse");
  assert.deepEqual(again.writes, []);
  assert.deepEqual(await snapshot(roots), installed, "a plan over an installation writes nothing either");
});

test("480-R5: every host file and project file is backed up before it is replaced, and what is not Einzbern's stays", async (context) => {
  const f = await fixture(context);
  const originals = new Map([
    [join(f.home, ".claude", "settings.json"), `${JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool notify" }] }] } }, null, 2)}\n`],
    [join(f.home, ".codex", "config.toml"), "model = \"other\"\n"],
    [join(f.project, "CLAUDE.md"), "# Project\n\nHouse rules.\n"],
    [join(f.project, "AGENTS.md"), "# Agents\n\nBe brief.\n"],
  ]);
  for (const [path, text] of originals) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, text);
  }
  const planned = await plan(f);
  const stamp = stampOf(planned.at);
  const backupDir = join(f.deviceHome, "backups", stamp);
  assert.equal(planned.backupDir, backupDir);
  assert.deepEqual(planned.backups.map((entry) => [entry.path, entry.into]), [
    [join(f.home, ".claude", "settings.json"), join(backupDir, "host-hooks")],
    [join(f.home, ".codex", "config.toml"), join(backupDir, "host-hooks")],
    [join(f.project, "AGENTS.md"), join(backupDir, "managed-sections")],
    [join(f.project, "CLAUDE.md"), join(backupDir, "managed-sections")],
  ]);
  for (const path of originals.keys()) assert.ok(planned.writes.some((entry) => entry.path === path && entry.action === "update"), path);

  const applied = await applySetup(planned);
  assert.equal(applied.backupDir, backupDir);
  assert.deepEqual(applied.backups, planned.backups);
  const copies = [];
  for (const line of await snapshot([backupDir])) {
    const path = line.slice(0, line.indexOf(" "));
    if (!line.includes(" dir ")) copies.push(await readFile(path, "utf8"));
  }
  assert.deepEqual([...copies].sort(), [...originals.values()].sort(), "each original is backed up byte for byte");
  const settings = JSON.parse(await readFile(join(f.home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.hooks.UserPromptSubmit.map((group) => group.hooks.map((hook) => hook.command)), [
    ["other-tool notify"],
    [`node "${join(f.deviceHome, "engine", "hook.mjs")}" user-prompt-submit`],
  ]);
  assert.match(await readFile(join(f.home, ".codex", "config.toml"), "utf8"), /^model = "other"$/mu);
  assert.ok((await readFile(join(f.project, "CLAUDE.md"), "utf8")).startsWith("# Project\n\nHouse rules.\n"));
  assert.ok((await readFile(join(f.project, "AGENTS.md"), "utf8")).startsWith("# Agents\n\nBe brief.\n"));
  assertSelfCheckGreen(applied);
});

test("480-R2: a library outside the project gets the project's host write roots; declined device navigation adds pointer hooks without removing shared navigation", async (context) => {
  const f = await fixture(context);
  const library = join(f.base, "elsewhere", "Ether", "project");
  const planned = await plan(f, { artifacts: library, cloud: false, language: "en", navigation: false });
  assert.deepEqual(planned.questions, []);
  assert.deepEqual(planned.blockers, []);
  const roots = [join(f.project, ".claude", "settings.local.json"), join(f.project, ".codex", "config.toml")];
  for (const path of roots) assert.ok(planned.writes.some((entry) => entry.step === "writable-roots" && entry.path === path && entry.action === "create"), path);
  assert.deepEqual(planned.warnings, [], "385-R16: a project Git does not track warns of nothing");
  const applied = await applySetup(planned);
  assert.deepEqual(applied.warnings, []);
  assert.equal(applied.library.path, library);
  assert.deepEqual(JSON.parse(await readFile(roots[0], "utf8")).permissions.additionalDirectories, [library]);
  assert.ok((await readFile(roots[1], "utf8")).includes(JSON.stringify(library)));
  // Device decline changes local hooks, not the shared project navigation declaration.
  assert.match(await readFile(join(f.project, "AGENTS.md"), "utf8"), /id=navigation /u);
  assert.equal(JSON.parse(await readFile(join(f.deviceHome, "machine-settings.json"), "utf8")).values["agents.navigation"], "declined");
  assert.deepEqual((await einzbernHooks(join(f.home, ".claude", "settings.json"))).map(([event]) => event).sort(), ["PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"]);
  const again = await plan(f, { artifacts: library, navigation: false });
  assert.deepEqual(again.writes, []);
});

test("480-R5: a host file that is a symbolic link, or a library already at the chosen place, stops the plan and the apply writes nothing", async (context) => {
  const f = await fixture(context);
  const dotfiles = join(f.base, "dotfiles");
  await mkdir(dotfiles);
  await writeFile(join(dotfiles, "settings.json"), "{}\n");
  await mkdir(join(f.home, ".claude"));
  await symlink(join(dotfiles, "settings.json"), join(f.home, ".claude", "settings.json"));
  const planned = await plan(f);
  assert.deepEqual(planned.blockers.map((blocker) => [blocker.step, blocker.path, blocker.reasonCode]), [
    ["host-hooks", join(f.home, ".claude", "settings.json"), "HOST_HOOKS_FILE_UNSUPPORTED"],
  ]);
  const before = await snapshot([f.home, f.deviceHome, f.project]);
  await assert.rejects(applySetup(planned), (error) => {
    assert.equal(error.reasonCode, "SETUP_BLOCKED");
    assert.equal(error.details.reasonCode, "HOST_HOOKS_FILE_UNSUPPORTED");
    assert.equal(error.details.path, join(f.home, ".claude", "settings.json"));
    return true;
  });
  assert.deepEqual(await snapshot([f.home, f.deviceHome, f.project]), before);

  const other = join(f.base, "other");
  await mkdir(other);
  const created = await cli(["init", "--workspace", join(other, ".ether"), "--at", at()]);
  assert.equal(created.reasonCode, "LIBRARY_CREATED");
  const taken = await plan(f, { artifacts: join(other, ".ether") });
  assert.ok(taken.blockers.some((blocker) => blocker.step === "library" && blocker.reasonCode === "SETUP_LIBRARY_EXISTS"));
});

test("385-R16: with the library outside the project, fresh and repair name each host file Git tracks before anything is written, and SETUP_APPLIED names it again", async (context) => {
  const f = await fixture(context);
  const library = join(f.base, "elsewhere", "Ether", "project");
  const answers = { artifacts: library, cloud: false, language: "en", navigation: true };
  await repositoryWithHostFiles(f.project);
  assert.deepEqual((await plan(f, answers)).warnings, [], "files Git does not track yet warn of nothing");

  git(f.project, "add", "--", ...HOST_FILES);
  const roots = [f.home, f.deviceHome, f.project];
  const before = await snapshot(roots);
  const planned = await planUnderTripwire(f, { mode: "fresh", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome, answers });
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.warnings, trackedWarnings(), "each tracked host file is named, file by file");
  for (const file of HOST_FILES) {
    assert.ok(planned.writes.some((entry) => entry.step === "writable-roots" && entry.path === join(f.project, ...file.split("/")) && entry.action === "update"), file);
  }
  assert.deepEqual(await snapshot(roots), before, "the plan and its warnings wrote nothing, Git's index included");

  const applied = await applySetup(await plan(f, answers));
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(applied.warnings, trackedWarnings(), "SETUP_APPLIED names the same files");
  // The wizard warns and leaves Git alone: both files name the library, stay staged as they were, and nothing is committed.
  for (const file of HOST_FILES) assert.ok((await readFile(join(f.project, ...file.split("/")), "utf8")).includes(library), file);
  assert.equal(git(f.project, "status", "--porcelain", "--", ...HOST_FILES), HOST_FILES.map((file) => `AM ${file}\n`).join(""));
  assert.notEqual(spawnSync("git", ["-C", f.project, "rev-parse", "--verify", "--quiet", "HEAD"]).status, 0, "no commit was made");
  assertSelfCheckGreen(applied);

  // A repair of the whole installation writes nothing and still names both files: they hold this device's library path.
  const repair = await planSetup({ mode: "repair", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome });
  assert.deepEqual(repair.blockers, []);
  assert.deepEqual(repair.writes, []);
  assert.deepEqual(repair.warnings, trackedWarnings());
  const repaired = await applySetup(repair);
  assert.deepEqual(repaired.written, []);
  assert.deepEqual(repaired.warnings, trackedWarnings());

  // Only a tracked file is named: once the Codex file leaves the index (its file stays), the Claude file alone is.
  git(f.project, "rm", "--cached", "--force", "--quiet", "--", ".codex/config.toml");
  assert.deepEqual((await planSetup({ mode: "repair", projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome })).warnings,
    trackedWarnings([".claude/settings.local.json"]));
});

test("385-R16: a library inside the project writes no host file, so tracked host files warn of nothing", async (context) => {
  const f = await fixture(context);
  await repositoryWithHostFiles(f.project);
  git(f.project, "add", "--", ...HOST_FILES);
  const planned = await plan(f, { artifacts: join(f.project, ".ether") });
  assert.deepEqual(planned.blockers, []);
  assert.equal(planned.resolved.artifacts, join(f.project, ".ether"));
  assert.deepEqual(planned.writes.filter((entry) => entry.step === "writable-roots"), []);
  assert.deepEqual(planned.warnings, []);
  const applied = await applySetup(planned);
  assert.deepEqual(applied.warnings, []);
  assert.equal(await readFile(join(f.project, ".codex", "config.toml"), "utf8"), "[features]\nhooks = true\n");
  assert.equal(await readFile(join(f.project, ".claude", "settings.local.json"), "utf8"), "{}\n");
});

test("548-AC4: the fresh plan lists what the DSH profiles say about the plugin, and plans no write under .dsh", async (context) => {
  const f = await fixture(context);
  assert.equal(Object.hasOwn(await plan(f), "dshPlugin"), false, "no DSH profiles, no dshPlugin");
  const profile = join(f.home, ".dsh", "profiles", "p1");
  await mkdir(join(profile, "node_modules", "dsh-mana-orchestrate"), { recursive: true });
  await writeFile(join(profile, "package.json"), `${JSON.stringify({ dependencies: { "dsh-mana-orchestrate": "^0.1.0" } })}\n`);
  await writeFile(join(profile, "node_modules", "dsh-mana-orchestrate", "package.json"), `${JSON.stringify({ name: "dsh-mana-orchestrate", version: "0.1.0" })}\n`);
  const planned = await plan(f);
  assert.equal(planned.dshPlugin.detected, true);
  assert.deepEqual(planned.dshPlugin.profiles.map((entry) => [entry.name, entry.installed, entry.version, entry.hookPathMatches]), [["p1", true, "0.1.0", true]]);
  assert.deepEqual(planned.writes.filter((entry) => entry.path.startsWith(join(f.home, ".dsh"))), [], "no step writes a DSH profile");
});


test("agents.generation none suppresses root files in both setup planning and application", async (context) => {
  const f = await fixture(context);
  await applySetup(await plan(f));
  const library = join(dirname(f.deviceHome), "Ether");
  await setWorkspaceSetting(library, { key: "agents.generation", value: "none", occurredAt: at() });
  // Missing files must not be re-created, and the opt-out does not remove any user files.
  await rm(join(f.project, "AGENTS.md"));
  await rm(join(f.project, "CLAUDE.md"));
  const next = await plan(f, {}, { mode: "repair" });
  assert.equal(next.writes.some((entry) => entry.step === "managed-sections" && [join(f.project, "AGENTS.md"), join(f.project, "CLAUDE.md")].includes(entry.path)), false);
  const applied = await applySetup(next);
  assert.equal(applied.written.some((entry) => [join(f.project, "AGENTS.md"), join(f.project, "CLAUDE.md")].includes(entry.path)), false);
  await assert.rejects(lstat(join(f.project, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.project, "CLAUDE.md")), { code: "ENOENT" });
});

test("fresh defaults reuse one external library for different projects with separate stable scopes", async context => {
  const f = await fixture(context);
  const first = await applySetup(await plan(f));
  const secondRoot = join(f.base, "second-project");
  await mkdir(secondRoot);
  const second = await applySetup(await planSetup({ mode: "fresh", projectRoot: secondRoot, at: at(), home: f.home, deviceHome: f.deviceHome, answers: { language: "zh-CN" } }));
  assertSelfCheckGreen(second);
  assert.equal(second.library.path, first.library.path);
  assert.equal(second.library.libraryId, first.library.libraryId);
  const registry = JSON.parse(await readFile(join(f.deviceHome, "registry.json"), "utf8"));
  assert.equal(new Set(registry.entries.map(entry => entry.libraryId)).size, 1);
  assert.equal(new Set(registry.entries.map(entry => entry.projectId)).size, 2);
  for (const root of [f.project, secondRoot]) await assert.rejects(lstat(join(root, ".ether")), { code: "ENOENT" });
  const check = projectRoot => runDoctor({ projectRoot, home: f.home, deviceHome: f.deviceHome });
  for (const root of [f.project, secondRoot]) assertSelfCheckGreen({ selfCheck: await check(root) });
  const document = join(f.project, "AGENTS.md");
  const original = await readFile(document, "utf8");
  const changed = original.replace("### design.authority", "### owner.editedDesignAuthority");
  assert.notEqual(changed, original);
  await writeFile(document, changed);
  const edited = (await check(f.project)).find(entry => entry.check === "managed-sections");
  assert.equal(edited.ok, false);
  assert.deepEqual(edited.detail.pending, ["AGENTS.md#variables-system"]);
  assertSelfCheckGreen({ selfCheck: await check(secondRoot) });
});

test("a user-chosen local parent creates one Ether and later projects reuse its shared identity", async context => {
  const f = await fixture(context), library = join(f.base, "Selected storage", "Ether");
  const first = await applySetup(await plan(f, { artifacts: library, cloud: false }));
  assertSelfCheckGreen(first);
  assert.equal(first.library.path, library);
  const readme = await readFile(join(library, "README.md"), "utf8");
  assert.ok(readme.includes("Ether/akasha/"));
  assert.ok(readme.includes("父目录由用户选择"));
  assert.equal(readme.includes("<云盘>/Ether/<项目名>"), false);
  assert.equal(chainIdentity(await materializeWorkspace(library)).role, "shared");
  assert.equal(readStorageLocation(f.deviceHome).library, library);
  const second = { ...f, project: join(f.base, "second source") };
  await mkdir(second.project);
  const next = await plan(second);
  assert.equal(next.resolved.artifacts, library);
  const applied = await applySetup(next);
  assertSelfCheckGreen(applied);
  assert.equal(applied.library.libraryId, first.library.libraryId);
  const entries = JSON.parse(await readFile(join(f.deviceHome, "registry.json"), "utf8")).entries;
  assert.equal(new Set(entries.map(entry => entry.libraryPath)).size, 1);
  assert.equal(new Set(entries.map(entry => entry.projectId)).size, 2);
  assert.equal(await lstat(join(f.project, ".ether")).catch(() => null), null);
  assert.equal(await lstat(join(second.project, ".ether")).catch(() => null), null);
});

test("restoring a shared Ether on another device retains its chosen location and isolates device runtime", async context => {
  const f = await fixture(context), library = join(f.base, "Chosen parent", "Ether");
  await applySetup(await plan(f, { artifacts: library, cloud: false }));
  const b = { ...f, home: join(f.base, "home-b"), deviceHome: join(f.base, "device-b"), project: join(f.base, "source-b") };
  await mkdir(b.home); await mkdir(b.project);
  process.env.EINZBERN_HOME = b.deviceHome; process.env.HOME = b.home; process.env.USERPROFILE = b.home;
  const tree = join(f.base, "trees", FRAMEWORK_VERSION);
  await cli(["engine-update", "--from", tree, "--sha256", (await computeInstallTreeDigest(tree)).sha256, "--version", FRAMEWORK_VERSION, "--at", at()]);
  const restored = await applySetup(await planSetup({ mode: "restore", projectRoot: b.project, home: b.home, deviceHome: b.deviceHome, at: at(), restore: library, answers: { cloud: false, navigation: true } }));
  assertSelfCheckGreen(restored);
  assert.equal(readStorageLocation(b.deviceHome).library, library);
  assert.notEqual(readStorageLocation(b.deviceHome).runtime, readStorageLocation(f.deviceHome).runtime);
  const next = { ...b, project: join(f.base, "source-c") }; await mkdir(next.project);
  assert.equal((await plan(next)).resolved.artifacts, library);
});


test("DOT-I01/I02: explicit chatgpt-dot skip never installs host hooks, skill copies, device or library", async context => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-dot-setup-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const projectRoot = join(base, "project"); const home = join(base, "home"); const deviceHome = join(base, "device");
  await mkdir(projectRoot); await mkdir(home);
  const dot = { binding: { root: projectRoot, agentsPath: join(projectRoot, "AGENTS.md"), provenancePath: join(projectRoot, ".dot", "provenance.json"), backupRoot: join(projectRoot, ".dot", "recovery"), projectReference: "fixture:project", ownerId: "fixture:dot" }, source: null, enginePath: join(base, "unread-engine"), manaSkillPath: join(base, "unread-skill"), preInjection: "skip" };
  const options = { mode: "fresh", projectRoot, home, deviceHome, at: at(), executionTarget: "chatgpt-dot", dot };
  const plan = await planSetup(options);
  assert.equal(plan.executionTarget, "chatgpt-dot"); assert.deepEqual(plan.writes, []); assert.equal(plan.library, null);
  const receipt = await applySetup(plan); assert.equal(receipt.dot.status, "skipped"); assert.equal(receipt.dot.sessionRead, "not-verified");
  assert.deepEqual(receipt.selfCheck, [], "traditional doctor checks do not certify dot");
  assert.deepEqual(await readdir(home), []); assert.deepEqual(await readdir(projectRoot), []);
  await assert.rejects(lstat(deviceHome), error => error.code === "ENOENT");
  await assert.rejects(planSetup({ ...options, mode: "migrate" }), error => error.reasonCode === "SETUP_TARGET_UNSUPPORTED");
  await assert.rejects(planSetup({ ...options, executionTarget: "dot" }), error => error.reasonCode === "SETUP_TARGET_UNSUPPORTED");
  await assert.rejects(planSetup({ ...options, projectRoot: "." }), error => error.reasonCode === "SETUP_INPUT_INVALID");
  await assert.rejects(planSetup({ ...options, answers: { navigation: true } }), error => error.reasonCode === "SETUP_OPTION_NOT_APPLICABLE");
});


// These are declared synthetic observations through the PUBLIC setup API, not
// evidence that any real host/version grants capability or trust.
for (const state of ["supported", "unsupported", "unknown"]) {
  test(`public fresh setup carries ${state} Codex observations through apply and repeat`, async t => {
    const f = await fixture(t);
    const codexAdmission = { state, version: "synthetic-observed-version", evidenceRef: "synthetic-fixture-only:fresh", subagentStop: state === "supported", trust: state === "supported" ? "permitted" : "unknown" };
    const planned = await plan(f, {}, { codexAdmission });
    assert.deepEqual(planned.blockers, []);
    assert.deepEqual(planned.codexAdmission, codexAdmission);
    assert.deepEqual(planned.modelPolicyOnboarding.defaultCategories, ["flagship", "main", "economy"]);
    assert.deepEqual(planned.modelPolicyOnboarding.codexPeerRequiredCategories, ["main", "economy"]);
    assert.deepEqual(planned.modelPolicyOnboarding.optionalModelCategories, ["flagship"]);
    assert.equal(planned.modelPolicyOnboarding.hostSelection, "explicit");
    assert.equal(planned.modelPolicyOnboarding.persistence, "explicit-actor-and-owner-decision");
    const applied = await applySetup(planned);
    assert.deepEqual(applied.modelPolicyOnboarding, planned.modelPolicyOnboarding);
    await assert.rejects(readFile(join(f.deviceHome, "engine-model-policy.json")), { code: "ENOENT" });
    assert.deepEqual(applied.codexAdmission, codexAdmission);
    assertSelfCheckGreen(applied);
    for (const host of ["codex", "claude"]) {
      const document = JSON.parse(await readFile(join(f.home, `.${host}`, host === "codex" ? "hooks.json" : "settings.json"), "utf8"));
      assert.equal(Object.hasOwn(document.hooks, "SubagentStop"), false);
    }
    const again = await plan(f, {}, { codexAdmission });
    assert.deepEqual(again.writes, []);
    assert.deepEqual((await applySetup(again)).written, []);
  });
}

test("public setup rejects malformed admission and cannot override a later hooks=false restriction", async t => {
  const f = await fixture(t);
  const admission = { state: "supported", version: "synthetic-only", evidenceRef: "synthetic-fixture-only:restriction", subagentStop: true, trust: "permitted" };
  for (const codexAdmission of [null, {}, { ...admission, state: "guessed" }, { ...admission, subagentStop: "true" }, { ...admission, trust: "restricted" }, { ...admission, evidenceRef: null }, { ...admission, enableHooksAuthorized: true }]) {
    await assert.rejects(plan(f, {}, { codexAdmission }), { reasonCode: "HOST_HOOKS_INPUT_INVALID" });
  }
  const planned = await plan(f, {}, { codexAdmission: admission });
  admission.evidenceRef = "changed-after-plan";
  assert.equal(planned.codexAdmission.evidenceRef, "synthetic-fixture-only:restriction", "the checked mode input snapshots the observation");
  await mkdir(join(f.home, ".codex"), { recursive: true });
  const restricted = "# user restriction\n[features]\nhooks = false\n";
  await writeFile(join(f.home, ".codex", "config.toml"), restricted);
  await assert.rejects(applySetup(planned), /explicit installation-plan authority/u);
  assert.equal(await readFile(join(f.home, ".codex", "config.toml"), "utf8"), restricted);
  const denied = await plan(f, {}, { codexAdmission: planned.codexAdmission });
  assert.ok(denied.blockers.some(blocker => blocker.reasonCode === "HOST_HOOKS_FILE_UNSUPPORTED"));
  await assert.rejects(planSetup({ mode: "fresh", executionTarget: "chatgpt-dot", projectRoot: f.project, at: at(), codexAdmission: planned.codexAdmission }), { reasonCode: "SETUP_OPTION_NOT_APPLICABLE" });
});
