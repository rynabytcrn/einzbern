// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-480 R4, AC4 and STORY-478 R6 (TCRN-CROSS-SUB-325): the modes for an installation
// that already runs. An update installs a newer release from a local archive or its unpacked
// directory, switches engine/current and lays the skill copies, the launchers and the hooks again
// from it, one of each per host, and writes no managed section; a rollback goes back. A repair puts
// back what is missing and a second repair changes nothing. An uninstall takes the hooks, both skill
// copies and the registry entry away, moves them into the backups, and leaves the library's tree as
// it was. Every home, device directory and project here is a temporary directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, chainIdentity, computeInstallTreeDigest, materializeWorkspace, readRegistry } from "../dist/build/packages/core/src/index.js";
import { DOCTOR_CHECKS } from "../dist/build/packages/core/src/doctor.js";
import { parseEngineVersion } from "../dist/build/packages/core/src/format-version.js";
import { MACHINE_SETTINGS_FILE_NAME } from "../dist/build/packages/core/src/machine-settings.js";
import { applySetup, planSetup } from "../dist/build/packages/core/src/setup.js";
import { SKILL_COPY_ROOTS, skillCopyPath } from "../dist/build/packages/core/src/skill-copies.js";
import { writeUstar } from "../scripts/lib/tar.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const parts = parseEngineVersion(FRAMEWORK_VERSION);
// Derived from the running version: a literal would stop being newer the day the engine reaches it.
const NEWER = `${parts.major}.${BigInt(parts.minor) + 1n}.0`;

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-maintain-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 5, 0, second)).toISOString().replace(".000Z", "Z");
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
 * An engine version directory as a release lays it out, built from this checkout (tests/setup-fresh.test.mjs),
 * answering as `version`: another version patches the version the built framework-version module declares.
 */
async function engineTree(base, version) {
  const tree = join(base, "trees", version);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  if (version !== FRAMEWORK_VERSION) {
    // The engine version lives in its own module (packages/core/src/framework-version.ts), which
    // the barrel re-exports: the built leaf is where another version is declared.
    const leaf = join(tree, "dist/build/packages/core/src/framework-version.js");
    const declaration = `export const FRAMEWORK_VERSION = "${FRAMEWORK_VERSION}";`;
    const source = await readFile(leaf, "utf8");
    assert.ok(source.includes(declaration), "the built framework-version module declares the engine version");
    await writeFile(leaf, source.replace(declaration, `export const FRAMEWORK_VERSION = "${version}";`));
  }
  await mkdir(join(tree, "launchers"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), join(tree, "launchers/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), join(tree, "launchers/hook.mjs"));
  const rendered = await cli(["skill-render", "--out", join(tree, "skill", "mana-orchestrate"), "--version", version]);
  assert.equal(rendered.reasonCode, "SKILL_RENDERED");
  return { tree, version, sha256: (await computeInstallTreeDigest(tree)).sha256 };
}

async function treeFiles(root, directory = root) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(root, path));
    else files.push({ path: relative(root, path).split(sep).join("/"), bytes: await readFile(path) });
  }
  return files;
}

/**
 * The release of `version` as scripts/pack-release.mjs lays it out: the directory einzbern-<version>/
 * with its manifest, and einzbern-<version>.tar.gz with its .sha256 beside it.
 */
async function releaseOf(base, version) {
  const engine = await engineTree(base, version);
  const directory = join(base, "release", `einzbern-${version}`);
  await cp(engine.tree, directory, { recursive: true });
  const digest = await computeInstallTreeDigest(engine.tree);
  const manifest = { schemaVersion: "einzbern.release-manifest.v1", version, nodeFloor: "24.0.0", installTreeDigest: digest.sha256, files: digest.entries };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const records = (await treeFiles(directory)).map((file) => ({ path: `einzbern-${version}/${file.path}`, bytes: file.bytes, mode: 0o644 }));
  const archive = join(base, "release", `einzbern-${version}.tar.gz`);
  const bytes = gzipSync(writeUstar(records));
  await writeFile(archive, bytes);
  await writeFile(`${archive}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  einzbern-${version}.tar.gz\n`);
  return { directory, archive, installTreeDigest: digest.sha256, skillDigest: (await computeInstallTreeDigest(join(engine.tree, "skill", "mana-orchestrate"))).sha256 };
}

/** A temporary home, device directory and project, with this checkout's engine installed and the project set up fresh. */
async function installed(context, { before = null } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-maintain-")));
  const home = join(base, "home");
  const deviceHome = join(base, "device");
  const project = join(base, "project");
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
  const engine = await engineTree(base, FRAMEWORK_VERSION);
  assert.equal((await cli(["engine-update", "--from", engine.tree, "--sha256", engine.sha256, "--version", FRAMEWORK_VERSION, "--at", at()])).reasonCode, "ENGINE_UPDATED");
  const f = { base, home, deviceHome, project, library: join(project, ".ether") };
  if (before !== null) await before(f);
  const fresh = await applySetup(await plan(f, "fresh"));
  assertSelfCheckGreen(fresh);
  return { ...f, fresh };
}

function plan(f, mode, extra = {}) {
  return planSetup({ mode, projectRoot: f.project, at: at(), home: f.home, deviceHome: f.deviceHome, ...extra });
}

function rows(writes) {
  return writes.map((entry) => [entry.step, entry.path, entry.action]);
}

function assertSelfCheckGreen(applied) {
  assert.deepEqual(applied.selfCheck.map((entry) => entry.check), [...DOCTOR_CHECKS]);
  for (const entry of applied.selfCheck) assert.equal(entry.ok, true, `${entry.check}: ${JSON.stringify(entry.detail)}`);
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

async function copyDigests(f) {
  return Promise.all(SKILL_COPY_ROOTS.map(async (root) => (await computeInstallTreeDigest(skillCopyPath(f.home, root))).sha256));
}

async function current(f) {
  return JSON.parse(await readFile(join(f.deviceHome, "engine", "current"), "utf8"));
}

const exists = async (path) => (await lstat(path).catch(() => null)) !== null;

test("480-R4: update installs a newer release, switches engine/current and lays one copy and one hook per host again; a rollback goes back", async (context) => {
  const f = await installed(context);
  const sections = await Promise.all(["AGENTS.md", "CLAUDE.md"].map((file) => readFile(join(f.project, file))));
  const claudeCopy = skillCopyPath(f.home, SKILL_COPY_ROOTS[0]);
  const agentsCopy = skillCopyPath(f.home, SKILL_COPY_ROOTS[1]);
  const record = join(f.deviceHome, "skills.json");
  const pointer = join(f.deviceHome, "engine", "current");

  // Nothing to roll back to yet; no release named; a release and a rollback at once.
  const nothing = await plan(f, "update", { rollback: true });
  assert.deepEqual(nothing.blockers.map((blocker) => blocker.reasonCode), ["ENGINE_ROLLBACK_UNAVAILABLE"]);
  await assert.rejects(applySetup(nothing), (error) => error.reasonCode === "SETUP_BLOCKED" && error.details.reasonCode === "ENGINE_ROLLBACK_UNAVAILABLE");
  const unnamed = await plan(f, "update");
  assert.deepEqual(unnamed.questions.map((question) => [question.id, question.flag, question.default]), [["archive", "--archive", null]]);
  assert.deepEqual(unnamed.blockers.map((blocker) => blocker.reasonCode), ["SETUP_ANSWER_REQUIRED"]);
  await assert.rejects(plan(f, "update", { archive: join(f.base, "x.tar.gz"), rollback: true }), { reasonCode: "SETUP_INPUT_INVALID" });

  const release = await releaseOf(f.base, NEWER);
  // An archive that does not have the sha256 its .sha256 states is not installed.
  const tampered = join(f.base, "release", "tampered.tar.gz");
  await copyFile(release.archive, tampered);
  await writeFile(`${tampered}.sha256`, `${"0".repeat(64)}  tampered.tar.gz\n`);
  assert.deepEqual((await plan(f, "update", { archive: tampered })).blockers.map((blocker) => blocker.reasonCode), ["INSTALL_ARCHIVE_DIGEST_MISMATCH"]);

  const planned = await plan(f, "update", { archive: release.archive });
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.engineSwitch, { source: release.archive, from: FRAMEWORK_VERSION, to: NEWER, installTreeDigest: release.installTreeDigest });
  const staging = join(f.deviceHome, "trash", `setup-update-${stampOf(planned.at)}`);
  const expected = [
    ["engine", staging, "create"],
    ["engine", join(f.deviceHome, "engine", NEWER), "create"],
    ["engine", pointer, "update"],
    ["skill-copies", claudeCopy, "update"],
    ["skill-copies", agentsCopy, "update"],
    ["skill-copies", record, "update"],
  ];
  assert.deepEqual(rows(planned.writes), expected, "the launchers and the hooks are already current; no managed section is planned");
  const updated = await applySetup(planned);
  assert.deepEqual(rows(updated.written), expected);
  assert.deepEqual(updated.engineSwitch, {
    source: release.archive,
    from: FRAMEWORK_VERSION,
    to: NEWER,
    installTreeDigest: release.installTreeDigest,
    reasonCode: "ENGINE_UPDATED",
    installed: "copied",
    incompatible: 0,
  });
  assert.deepEqual(updated.backups.map((entry) => entry.path), [claudeCopy, agentsCopy], "the copies it replaced are backed up");
  assert.equal((await current(f)).version, NEWER);
  assert.equal((await current(f)).previous, FRAMEWORK_VERSION);
  assert.deepEqual(await copyDigests(f), [release.skillDigest, release.skillDigest], "both copies are the new version's skill");
  assert.equal((await einzbernHooks(join(f.home, ".claude", "settings.json"))).length, 1);
  assert.equal((await einzbernHooks(join(f.home, ".codex", "hooks.json"))).length, 1);
  assert.deepEqual(await Promise.all(["AGENTS.md", "CLAUDE.md"].map((file) => readFile(join(f.project, file)))), sections, "478-R6: no managed section is written");
  assert.ok(await exists(join(staging, `einzbern-${NEWER}`, "scripts", "einzbern.mjs")), "the unpacked release stays in the device directory's trash");
  assertSelfCheckGreen(updated);

  // A rollback makes the previous version current again, and the copies follow it.
  const back = await plan(f, "update", { rollback: true });
  assert.deepEqual(back.blockers, []);
  assert.deepEqual(back.engineSwitch, { source: null, from: NEWER, to: FRAMEWORK_VERSION, installTreeDigest: null });
  assert.deepEqual(rows(back.writes), [
    ["engine", pointer, "update"],
    ["skill-copies", claudeCopy, "update"],
    ["skill-copies", agentsCopy, "update"],
    ["skill-copies", record, "update"],
  ]);
  const rolled = await applySetup(back);
  assert.equal(rolled.engineSwitch.reasonCode, "ENGINE_ROLLED_BACK");
  assert.equal((await current(f)).version, FRAMEWORK_VERSION);
  assert.equal((await current(f)).previous, NEWER);
  const original = (await computeInstallTreeDigest(join(f.deviceHome, "engine", FRAMEWORK_VERSION, "skill", "mana-orchestrate"))).sha256;
  assert.deepEqual(await copyDigests(f), [original, original]);
  assert.equal((await einzbernHooks(join(f.home, ".claude", "settings.json"))).length, 1);
  assert.equal((await einzbernHooks(join(f.home, ".codex", "hooks.json"))).length, 1);
  assertSelfCheckGreen(rolled);

  // The unpacked release directory installs too: the version is already there, so it is reused.
  const again = await plan(f, "update", { archive: release.directory });
  assert.deepEqual(again.blockers, []);
  assert.ok(!again.writes.some((entry) => entry.path === join(f.deviceHome, "engine", NEWER)), "an installed version is not copied again");
  const reused = await applySetup(again);
  assert.equal(reused.engineSwitch.installed, "reused");
  assert.equal((await current(f)).version, NEWER);
  assert.deepEqual(await copyDigests(f), [release.skillDigest, release.skillDigest]);
  assertSelfCheckGreen(reused);
});

test("480-R4: repair puts back what is missing, and a second repair changes nothing", async (context) => {
  const f = await installed(context);
  const claudeCopy = skillCopyPath(f.home, SKILL_COPY_ROOTS[0]);
  const settings = join(f.home, ".claude", "settings.json");
  await rm(claudeCopy, { recursive: true, force: true });
  await writeFile(settings, "{}\n");

  const planned = await plan(f, "repair");
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.library, { path: f.library, action: "reuse", libraryId: f.fresh.library.libraryId });
  assert.deepEqual(planned.questions.map((question) => [question.id, question.default]), [["cloud", false], ["navigation", true]]);
  const expected = [
    ["skill-copies", claudeCopy, "create"],
    ["skill-copies", join(f.deviceHome, "skills.json"), "update"],
    ["host-hooks", settings, "update"],
  ];
  assert.deepEqual(rows(planned.writes), expected);
  const repaired = await applySetup(planned);
  assert.deepEqual(rows(repaired.written), expected);
  // R46 I08: repair names no coordination binding, in the plan or the receipt.
  assert.deepEqual([Object.hasOwn(planned, "coordination"), Object.hasOwn(repaired, "coordination")], [false, false]);
  assert.deepEqual(repaired.backups.map((entry) => entry.path), [settings], "the settings file is backed up before it is replaced");
  assertSelfCheckGreen(repaired);

  const files = [settings, join(f.home, ".codex", "hooks.json"), join(f.project, "AGENTS.md"), join(f.project, "CLAUDE.md"), join(f.deviceHome, "registry.json"), join(f.deviceHome, "skills.json")];
  const before = await Promise.all(files.map((path) => readFile(path)));
  const again = await plan(f, "repair");
  assert.deepEqual(again.writes, []);
  const second = await applySetup(again);
  assert.deepEqual(second.written, []);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before, "every file keeps its bytes");
  assertSelfCheckGreen(second);

  // A project this device never registered has nothing to repair.
  const stranger = join(f.base, "stranger");
  await mkdir(stranger);
  const refused = await planSetup({ mode: "repair", projectRoot: stranger, at: at(), home: f.home, deviceHome: f.deviceHome });
  assert.deepEqual(refused.blockers.map((blocker) => blocker.reasonCode), ["LIBRARY_NOT_REGISTERED"]);
});

test("478-AC5: repair removes this device's old navigation section when the answer changes to declined", async (context) => {
  const f = await installed(context);
  const agents = join(f.project, "AGENTS.md");
  assert.match(await readFile(agents, "utf8"), /id=navigation/u);

  const planned = await plan(f, "repair", { answers: { navigation: false } });
  assert.deepEqual(planned.blockers, []);
  assert.equal(planned.resolved.navigation, false);
  assert.ok(planned.writes.some((entry) => entry.step === "managed-sections" && entry.path === agents && entry.action === "update"));
  assert.ok(planned.writes.some((entry) => entry.step === "library" && entry.path === f.library && entry.action === "update"));

  const applied = await applySetup(planned);
  assert.doesNotMatch(await readFile(agents, "utf8"), /id=navigation/u);
  assert.equal(JSON.parse(await readFile(join(f.deviceHome, MACHINE_SETTINGS_FILE_NAME), "utf8")).values["agents.navigation"], "declined");
  assert.deepEqual(applied.pendingSections, []);
  assertSelfCheckGreen(applied);

  const again = await plan(f, "repair", { answers: { navigation: false } });
  assert.ok(!again.writes.some((entry) => entry.step === "managed-sections" && entry.path === agents), "the removed section does not return on rerun");
  assert.doesNotMatch(await readFile(agents, "utf8"), /id=navigation/u);
});

test("478-AC1: the model-write refusal stays active, while a controlled Atelier setup write succeeds", async (context) => {
  const f = await installed(context);
  const previous = process.env.EINZBERN_SURFACE;
  delete process.env.EINZBERN_SURFACE;
  const args = ["settings-set", "--workspace", f.library, "--at", at(), "--actor", "agent:test", "--key", "design.authority", "--value", "https://design.example/system"];
  try {
    await assert.rejects(cli(args), (error) => error.reasonCode === "MODEL_WRITE_REFUSED");
    // This covers the existing UI-surface convention only; it makes no human-identity claim.
    process.env.EINZBERN_SURFACE = "atelier";
    assert.equal((await cli(args)).reasonCode, "SETTINGS_WRITE_COMMITTED");
  } finally {
    restoreEnv("EINZBERN_SURFACE", previous);
  }
});

test("480-AC4: uninstall takes the hooks, both skill copies and the registry entry away into the backups, and the library's tree stays as it was", async (context) => {
  const f = await installed(context, {
    before: async (fixture) => {
      await mkdir(join(fixture.home, ".claude"), { recursive: true });
      await writeFile(join(fixture.home, ".claude", "settings.json"), `${JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool notify" }] }] } }, null, 2)}\n`);
    },
  });
  const libraryDigest = (await computeInstallTreeDigest(f.library)).sha256;
  const sections = await Promise.all(["AGENTS.md", "CLAUDE.md"].map((file) => readFile(join(f.project, file))));
  const registry = join(f.deviceHome, "registry.json");
  const registryBefore = await readFile(registry);
  const settings = join(f.home, ".claude", "settings.json");
  const copies = SKILL_COPY_ROOTS.map((root) => skillCopyPath(f.home, root));
  const record = join(f.deviceHome, "skills.json");

  const planned = await plan(f, "uninstall");
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.questions.map((question) => [question.id, question.flag, question.default]), [["managedSections", "--managed-sections", "keep"]]);
  const backupDir = join(f.deviceHome, "backups", stampOf(planned.at));
  const moves = [...copies.map((path) => ["skill-copies", path, "move"]), ["skill-copies", record, "move"], ["registry", registry, "update"]];
  assert.deepEqual(rows(planned.writes).filter((entry) => entry[0] !== "host-hooks"), moves);
  assert.ok(planned.writes.some((entry) => entry.step === "host-hooks" && entry.path === settings && entry.action === "update"));
  assert.ok(!planned.writes.some((entry) => entry.path.startsWith(f.library)), "nothing in the library is written");

  const applied = await applySetup(planned);
  assert.deepEqual(rows(applied.written), rows(planned.writes), "the summary lists what the plan said");
  assert.equal(applied.backupDir, backupDir);
  // Hooks: Einzbern's are gone from both hosts, another tool's and every other key stay.
  assert.deepEqual(await einzbernHooks(settings), []);
  assert.deepEqual(await einzbernHooks(join(f.home, ".codex", "hooks.json")).catch(() => []), []);
  const kept = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(kept.theme, "dark");
  assert.deepEqual(kept.hooks.UserPromptSubmit.map((group) => group.hooks.map((hook) => hook.command)), [["other-tool notify"]]);
  // Copies and skills.json: moved whole into the backups, never deleted.
  for (const [index, root] of SKILL_COPY_ROOTS.entries()) {
    assert.equal(await exists(copies[index]), false, root.host);
    assert.ok(await exists(join(backupDir, "skill-copies", ...root.root.split("/"), "mana-orchestrate", "SKILL.md")), root.host);
  }
  assert.equal(await exists(record), false);
  assert.ok(await exists(join(backupDir, "skill-copies", "skills.json")));
  // Registry: the entry is gone, and the file as it was is in the backups.
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")).entries, []);
  assert.deepEqual(await readFile(join(backupDir, "registry", "registry.json")), registryBefore);
  // The library and, with keep, the project's files are as they were.
  assert.equal((await computeInstallTreeDigest(f.library)).sha256, libraryDigest, "480-AC4: the library's tree digest is unchanged");
  assert.deepEqual(await Promise.all(["AGENTS.md", "CLAUDE.md"].map((file) => readFile(join(f.project, file)))), sections);
  assert.deepEqual(applied.library, { path: f.library, libraryId: f.fresh.library.libraryId, created: false });
  const doctor = new Map(applied.selfCheck.map((entry) => [entry.check, entry]));
  assert.equal(doctor.get("hooks-present").ok, false);
  assert.equal(doctor.get("skill-copies").ok, false);
  assert.deepEqual(doctor.get("registry").detail.causes, ["LIBRARY_NOT_REGISTERED"]);

  // A second uninstall finds nothing left to take out.
  assert.deepEqual((await plan(f, "uninstall", { managedSections: "keep" })).writes, []);
});

test("480-AC4: uninstall with --managed-sections remove takes the section markers out and keeps their text, and still writes nothing into the library", async (context) => {
  const f = await installed(context);
  const libraryDigest = (await computeInstallTreeDigest(f.library)).sha256;
  const agents = join(f.project, "AGENTS.md");
  const claude = join(f.project, "CLAUDE.md");
  const originals = await Promise.all([readFile(agents, "utf8"), readFile(claude, "utf8")]);

  const planned = await plan(f, "uninstall", { managedSections: "remove" });
  assert.deepEqual(planned.questions, []);
  assert.deepEqual(rows(planned.writes).filter((entry) => entry[0] === "managed-sections"), [["managed-sections", agents, "update"], ["managed-sections", claude, "update"]]);
  const applied = await applySetup(planned);
  const [after, claudeAfter] = await Promise.all([readFile(agents, "utf8"), readFile(claude, "utf8")]);
  assert.doesNotMatch(after, /einzbern:section/u);
  assert.match(after, /This project is managed by Einzbern\./u, "the text stays, the user's from now on");
  assert.doesNotMatch(claudeAfter, /einzbern:section/u);
  assert.match(claudeAfter, /^@AGENTS\.md$/mu);
  const backups = join(applied.backupDir, "managed-sections");
  const copies = [];
  for (const directory of await readdir(backups)) {
    for (const name of await readdir(join(backups, directory))) copies.push(await readFile(join(backups, directory, name), "utf8"));
  }
  assert.deepEqual(copies.sort(), [...originals].sort(), "both files are backed up as they were");
  assert.equal((await computeInstallTreeDigest(f.library)).sha256, libraryDigest, "the library's records of the sections are not written");
});

// TCRN-CROSS-STORY-480 R4/AC4 with approved contract item 3 (INIT-053 U04): the coordination
// registration setup made goes with the last uninstall that leaves no registered project naming the
// coordination; a registered project that still names it, or whose library cannot be read, keeps
// it. No library is written, moved or deleted on any of these paths.
test("480-AC4 (U04): uninstall keeps the coordination registration while a registered project names it or cannot be read, takes it out with the last one, and never touches a library", async (context) => {
  const f = await installed(context);
  const coordination = join(f.deviceHome, "coordination-library");
  const coordinationId = chainIdentity(await materializeWorkspace(f.library)).coordinationLibraryId;
  const projects = [f.project, join(f.base, "second"), join(f.base, "third")];
  for (const project of projects.slice(1)) {
    await mkdir(project);
    const applied = await applySetup(await planSetup({ mode: "fresh", projectRoot: project, at: at(), home: f.home, deviceHome: f.deviceHome }));
    assert.equal(applied.reasonCode, "SETUP_APPLIED");
    assert.ok(!applied.written.some((entry) => entry.path === coordination), "a second project joins the registered coordination and creates none");
    assert.equal(chainIdentity(await materializeWorkspace(join(project, ".ether"))).coordinationLibraryId, coordinationId);
  }
  const libraries = [...projects.map((project) => join(project, ".ether")), coordination];
  const digests = () => Promise.all(libraries.map(async (path) => (await computeInstallTreeDigest(path)).sha256));
  const before = await digests();
  const registered = async () => (await readRegistry(f.deviceHome)).entries.map((entry) => entry.projectPath);
  // TCRN-CROSS-INIT-053 R46 (I08): the plan says what the apply then does to setup's coordination
  // registration, released or retained, and the receipt says what it did.
  const uninstallPlanned = async (project) => {
    const planned = await planSetup({ mode: "uninstall", projectRoot: project, at: at(), home: f.home, deviceHome: f.deviceHome, managedSections: "keep" });
    const applied = await applySetup(planned);
    assert.deepEqual(applied.coordination, planned.coordination, `${project}: the receipt names what the plan named`);
    return applied;
  };
  const coordinationAs = (status) => ({ libraryId: coordinationId, status, path: coordination });

  // Referenced: the other two projects still name the coordination.
  const referenced = await uninstallPlanned(projects[0]);
  assert.equal(referenced.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(referenced.coordination, coordinationAs("retained"));
  assert.deepEqual(await registered(), [coordination, projects[1], projects[2]], "a referenced coordination registration stays");

  // Unreadable: the third project's library is away, so nothing proves the coordination unnamed.
  const away = `${libraries[2]}-away`;
  await rename(libraries[2], away);
  assert.deepEqual((await uninstallPlanned(projects[1])).coordination, coordinationAs("retained"));
  assert.deepEqual(await registered(), [coordination, projects[2]], "a registration whose library cannot be read keeps it");
  await rename(away, libraries[2]);

  // Unreferenced: the last project naming it goes, and the registration setup made goes with it.
  assert.deepEqual((await uninstallPlanned(projects[2])).coordination, coordinationAs("released"));
  assert.deepEqual(await registered(), [], "the coordination registration goes with the last project naming it");
  assert.deepEqual(await digests(), before, "no library was written, moved or deleted");
  assert.ok((await lstat(join(coordination, "manifest.json"))).isFile(), "the coordination library itself stays");
});
