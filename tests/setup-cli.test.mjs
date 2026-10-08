// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-480 AC1 to AC5, R5, R6 (TCRN-CROSS-SUB-327): the wizard through the CLI. setup
// plans and writes nothing without --yes true, applies with it, and reports doctor's eight checks
// and the hook run once with the project's name as the prompt, with the lines it injected; a second
// run writes nothing; a restore of a library in a newer format stops at its third check, and the
// shipped entry names the check; an uninstall leaves the library's tree as it was; doctor answers
// its eight checks; migrate is the entry for an installation from before the rename. Every home,
// device directory and project here is a temporary directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { renderWritableRoots } from "../scripts/host-render.mjs";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  DOCTOR_CHECKS,
  FRAMEWORK_VERSION,
  computeInstallTreeDigest,
  createProject,
  createWork,
  materializeWorkspace,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { ENGINE_FORMAT_VERSION } from "../dist/build/packages/core/src/format-version.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import { SKILL_COPY_ROOTS, skillCopyPath } from "../dist/build/packages/core/src/skill-copies.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-setup-cli-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 6, 0, second)).toISOString().replace(".000Z", "Z");
};

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The engine version directory as a release lays it out, with the hook entry the launcher imports. */
async function engineTree(base) {
  const tree = join(base, "trees", FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook.mjs"), join(tree, "scripts/einzbern-hook.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  await mkdir(join(tree, "launchers"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), join(tree, "launchers/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), join(tree, "launchers/hook.mjs"));
  const rendered = await cli(["skill-render", "--out", join(tree, "skill", "mana-orchestrate"), "--version", FRAMEWORK_VERSION]);
  assert.equal(rendered.reasonCode, "SKILL_RENDERED");
  return { tree, sha256: (await computeInstallTreeDigest(tree)).sha256 };
}

/** A temporary home, device directory with this checkout's engine installed, and a project named zebrafish. */
async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-setup-cli-")));
  const home = join(base, "home");
  const deviceHome = join(base, "device");
  const project = join(base, "zebrafish");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const previous = { device: process.env.EINZBERN_HOME, home: process.env.HOME, profile: process.env.USERPROFILE };
  process.env.EINZBERN_HOME = deviceHome;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  context.after(async () => {
    restoreEnv("EINZBERN_HOME", previous.device);
    restoreEnv("HOME", previous.home);
    restoreEnv("USERPROFILE", previous.profile);
    await rm(base, { recursive: true, force: true });
  });
  const engine = await engineTree(base);
  assert.equal((await cli(["engine-update", "--from", engine.tree, "--sha256", engine.sha256, "--version", FRAMEWORK_VERSION, "--at", at()])).reasonCode, "ENGINE_UPDATED");
  return { base, home, deviceHome, project, library: join(project, ".ether") };
}

const setup = (f, mode, ...flags) => cli(["setup", "--mode", mode, "--project", f.project, "--at", at(), ...flags]);

function rows(writes) {
  return writes.map((entry) => [entry.step, entry.path, entry.action]);
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

function assertChecksGreen(checks) {
  assert.deepEqual(checks.map((entry) => entry.check), [...DOCTOR_CHECKS]);
  for (const entry of checks) assert.equal(entry.ok, true, `${entry.check}: ${JSON.stringify(entry.detail)}`);
}

// Git in a temporary project, under the fixture's temporary home; nothing is committed, so no
// identity is configured.
function git(directory, ...args) {
  const run = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test("480-AC1, AC2 through the CLI: setup plans without --yes and writes nothing, applies with --yes true and reports the self-check, and a second run writes nothing", async (context) => {
  const f = await fixture(context);
  const roots = [f.home, f.deviceHome, f.project];
  const before = await snapshot(roots);
  const planned = await setup(f, "fresh");
  assert.equal(planned.reasonCode, "SETUP_PLAN_READY");
  assert.equal(planned.mode, "fresh");
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.questions.map((question) => question.flag), ["--artifacts", "--cloud", "--language", "--navigation"]);
  // EPIC-144 R2: besides its 14 writes, a first installation creates this device's coordination
  // library, and the plan lists that write before the apply.
  const coordination = join(f.deviceHome, "coordination-library");
  assert.deepEqual(planned.writes.filter((entry) => entry.path === coordination).map((entry) => [entry.step, entry.action]), [["library", "create"]]);
  assert.equal(planned.writes.filter((entry) => entry.path !== coordination).length, 14);
  assert.deepEqual(planned.warnings, []);
  assert.deepEqual(await snapshot(roots), before, "without --yes true nothing is written");

  const applied = await setup(f, "fresh", "--yes", "true");
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(rows(applied.written), rows(planned.writes), "the summary lists what the plan said");
  assert.deepEqual(applied.warnings, []);
  assert.deepEqual(applied.library.path, f.library);
  // The self-check: doctor's eight checks, and the hook run once as a host runs it.
  assertChecksGreen(applied.selfCheck.checks);
  assert.equal(applied.selfCheck.prompt, "zebrafish");
  assert.equal(applied.selfCheck.exitCode, 0);
  assert.equal(applied.selfCheck.hookReasonCode, null);
  assert.deepEqual(applied.selfCheck.injected, [], "a new library has nothing to inject yet");

  const again = await setup(f, "fresh", "--yes", "true");
  assert.deepEqual(again.written, []);
  assertChecksGreen(again.selfCheck.checks);

  for (const [flags, name] of [[["--managed-sections", "maybe"], "managed-sections"], [["--yes", "maybe"], "yes"], [["--cloud", "perhaps"], "cloud"]]) {
    await assert.rejects(setup(f, "uninstall", ...flags), (error) => error.reasonCode === "CLI_ARGUMENT_MALFORMED" && error.message === name, name);
  }
});

test("480-R5 through the CLI: after an apply the hook runs once with the project's name, and the receipt carries the lines it injected", async (context) => {
  const f = await fixture(context);
  await setup(f, "fresh", "--yes", "true");
  // A library that knows the zebrafish: the prompt "zebrafish" now has a strong hit.
  const projectId = (await createProject(f.library, { occurredAt: at(), externalKey: "ZOO", name: "Zoo" })).projects[0].id;
  const idOf = async (key) => (await materializeWorkspace(f.library)).work.find((record) => record.externalKey === key).id;
  await createWork(f.library, { occurredAt: at(), projectId, externalKey: "ZOO-INIT", kind: "Initiative", parentId: null, title: "Aviary initiative", scope: "## Goal\nBuild the heron aviary." });
  await createWork(f.library, { occurredAt: at(), projectId, externalKey: "ZOO-EPIC", kind: "Epic", parentId: await idOf("ZOO-INIT"), title: "Wetland epic", goal: "Keep the flamingo pond." });
  await createWork(f.library, {
    occurredAt: at(), projectId, externalKey: "ZOO-STORY", kind: "Story", parentId: await idOf("ZOO-EPIC"), title: "Zebrafish tank",
    goal: "Give the zebrafish a tank.", acceptance: "GIVEN the tank WHEN it is filled THEN the zebrafish swim",
  });
  await setWorkspaceSetting(f.library, { occurredAt: at(), key: "retrieval.tau", value: "1" });

  const repaired = await setup(f, "repair", "--yes", "true");
  assert.equal(repaired.reasonCode, "SETUP_APPLIED");
  assert.equal(repaired.mode, "repair");
  assert.deepEqual(repaired.written, [], "a whole installation needs no repair");
  assertChecksGreen(repaired.selfCheck.checks);
  assert.equal(repaired.selfCheck.prompt, "zebrafish");
  assert.equal(repaired.selfCheck.exitCode, 0);
  assert.equal(repaired.selfCheck.hookReasonCode, null);
  assert.ok(repaired.selfCheck.injected.some((line) => line.includes("Zebrafish tank")), JSON.stringify(repaired.selfCheck.injected));
});

test("480-AC3 through the CLI: a restore of a library in a newer format stops at the third check, and the shipped entry names the check", async (context) => {
  const f = await fixture(context);
  await setup(f, "fresh", "--yes", "true");
  const manifestPath = join(f.library, "manifest.json");
  // One past the format this engine reads (format-version.ts), whatever that format is.
  await writeFile(manifestPath, canonicalJson({ ...JSON.parse(await readFile(manifestPath, "utf8")), formatVersion: ENGINE_FORMAT_VERSION + 1 }));
  const roots = [f.home, f.deviceHome, f.project];
  const before = await snapshot(roots);
  for (const flags of [[], ["--yes", "true"]]) {
    await assert.rejects(setup(f, "restore", "--restore", f.library, ...flags), (error) => {
      assert.equal(error.reasonCode, "RESTORE_FORMAT_UNSUPPORTED");
      assert.equal(error.details.check, "format");
      assert.equal(error.details.item, "3");
      return true;
    });
  }
  assert.deepEqual(await snapshot(roots), before, "nothing was written");

  const run = spawnSync(process.execPath, [join(repositoryRoot, "scripts/einzbern.mjs"), "setup", "--mode", "restore", "--project", f.project, "--at", at(), "--restore", f.library], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: f.deviceHome, HOME: f.home, USERPROFILE: f.home },
  });
  assert.equal(run.status, 1, run.stdout);
  const refusal = JSON.parse(run.stderr.trim().split("\n").at(-1));
  assert.equal(refusal.reasonCode, "RESTORE_FORMAT_UNSUPPORTED");
  assert.equal(refusal.check, "format");
  assert.equal(refusal.required, String(ENGINE_FORMAT_VERSION + 1));
  assert.equal(refusal.supported, String(ENGINE_FORMAT_VERSION));
  assert.equal(refusal.remedy, "engine-update");
});

test("480-AC4, AC5 through the CLI: doctor answers eight green checks; uninstall takes the hooks, the copies and the registry entry out and leaves the library's tree as it was", async (context) => {
  const f = await fixture(context);
  await setup(f, "fresh", "--yes", "true");
  const doctor = await cli(["doctor", "--project", f.project]);
  assert.equal(doctor.reasonCode, "DOCTOR_READY");
  assert.equal(doctor.ok, true);
  assert.equal(doctor.projectPath, f.project);
  assertChecksGreen(doctor.checks);
  for (const entry of doctor.checks) assert.deepEqual(Object.keys(entry).sort(), ["check", "detail", "ok", "reasonCode"]);

  const libraryDigest = (await computeInstallTreeDigest(f.library)).sha256;
  const sections = await Promise.all(["AGENTS.md", "CLAUDE.md"].map((file) => readFile(join(f.project, file))));
  const planned = await setup(f, "uninstall");
  assert.deepEqual(planned.questions.map((question) => [question.flag, question.default]), [["--managed-sections", "keep"]]);
  const removed = await setup(f, "uninstall", "--managed-sections", "keep", "--yes", "true");
  assert.equal(removed.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(await einzbernHooks(join(f.home, ".claude", "settings.json")), []);
  assert.deepEqual(await einzbernHooks(join(f.home, ".codex", "hooks.json")), []);
  for (const root of SKILL_COPY_ROOTS) assert.equal(await lstat(skillCopyPath(f.home, root)).catch(() => null), null, root.host);
  assert.deepEqual(JSON.parse(await readFile(join(f.deviceHome, "registry.json"), "utf8")).entries, []);
  assert.equal((await computeInstallTreeDigest(f.library)).sha256, libraryDigest, "480-AC4: the library's tree digest is unchanged");
  assert.deepEqual(await Promise.all(["AGENTS.md", "CLAUDE.md"].map((file) => readFile(join(f.project, file)))), sections);
  assert.deepEqual(removed.selfCheck.injected, [], "an unregistered project's prompt gets nothing");

  const after = await cli(["doctor", "--project", f.project]);
  assert.equal(after.ok, false);
  const red = after.checks.filter((entry) => !entry.ok).map((entry) => [entry.check, entry.reasonCode]);
  assert.deepEqual(red.filter(([check]) => ["hooks-present", "skill-copies", "registry"].includes(check)), [
    ["hooks-present", "DOCTOR_HOOKS_MISMATCH"],
    ["skill-copies", "DOCTOR_SKILL_COPIES_MISMATCH"],
    ["registry", "DOCTOR_REGISTRY_UNRESOLVED"],
  ]);
});

test("480-R6 through the CLI: migrate is the entry for an installation from before the rename", async (context) => {
  const f = await fixture(context);
  await assert.rejects(setup(f, "migrate"), { reasonCode: "SETUP_MIGRATE_NOTHING" });
  await assert.rejects(setup(f, "migrate", "--artifacts", join(f.base, "elsewhere")), { reasonCode: "SETUP_OPTION_NOT_APPLICABLE" });
  await mkdir(join(f.home, ".tcrn-workflow"));
  // TCRN-CROSS-STORY-489 R1: migrate plans what it found and takes the four answers; with no mapping
  // to follow and none to infer, the plan names the question and --yes true applies nothing.
  const migrate = await setup(f, "migrate", "--cloud", "true", "--language", "zh", "--navigation", "false");
  assert.equal(migrate.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(migrate.questions.map((question) => question.id), ["mapping"]);
  assert.deepEqual([migrate.resolved.cloud, migrate.resolved.language, migrate.resolved.navigation], [true, "zh-CN", false]);
  assert.deepEqual(migrate.blockers.map((blocker) => [blocker.step, blocker.reasonCode]), [["library", "SETUP_ANSWER_REQUIRED"]]);
  await assert.rejects(setup(f, "migrate", "--yes", "true"), (error) => error.reasonCode === "SETUP_BLOCKED" && error.details.reasonCode === "SETUP_ANSWER_REQUIRED");
  const fresh = await setup(f, "fresh");
  assert.equal(fresh.context.suggestedMode, "migrate");
  assert.equal(fresh.context.legacy.deviceDirectory, join(f.home, ".tcrn-workflow"));
  await assert.rejects(setup(f, "install"), { reasonCode: "SETUP_MODE_INVALID" });
});

test("385-R16 through the CLI: with the library outside the project, a host file Git tracks is a warning of the plan, of SETUP_APPLIED and of a repair plan, in host-render's words, and Git is left alone", async (context) => {
  const f = await fixture(context);
  const library = join(f.base, "libraries", "zebrafish");
  const files = [".claude/settings.local.json", ".codex/config.toml"];
  git(f.project, "init", "-q");
  await mkdir(join(f.project, ".claude"));
  await mkdir(join(f.project, ".codex"));
  await writeFile(join(f.project, ".claude", "settings.local.json"), `${JSON.stringify({ model: "house-model" })}\n`);
  await writeFile(join(f.project, ".codex", "config.toml"), "model = \"house-model\"\n");
  git(f.project, "add", "--", ...files);

  const roots = [f.home, f.deviceHome, f.project];
  const before = await snapshot(roots);
  const planned = await setup(f, "fresh", "--artifacts", library);
  assert.equal(planned.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.warnings.map((warning) => [warning.reasonCode, warning.file]), files.map((file) => ["HOST_WRITABLE_ROOTS_TRACKED_BY_GIT", file]));
  assert.deepEqual(await snapshot(roots), before, "the plan names the files and writes nothing");

  const applied = await setup(f, "fresh", "--artifacts", library, "--yes", "true");
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(applied.warnings, planned.warnings, "the receipt names the same files");
  // scripts/host-render.mjs, the development script, says the same of the same files.
  const rendered = [];
  for (const host of ["claude-code", "codex"]) rendered.push(...(await renderWritableRoots({ host, root: f.project, library, planOnly: true })).warnings);
  assert.deepEqual(applied.warnings, rendered);
  assert.deepEqual((await setup(f, "repair")).warnings, planned.warnings, "a repair plan names them too");
  assert.equal(git(f.project, "status", "--porcelain", "--", ...files), files.map((file) => `AM ${file}\n`).join(""), "the files stay staged as they were: nothing is committed or unstaged");
});
