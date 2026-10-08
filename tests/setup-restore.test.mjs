// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-480 R3, AC3 (TCRN-CROSS-SUB-324): setup --mode restore. A library passes eight
// checks before anything is written, and the first that fails stops the restore with its own reason
// code: a library in a newer format stops at the third, and under the write tripwire nothing is
// written. Once all eight pass, the project is registered and wired from the registry on, the
// library's project-level settings are not written, and SETUP_APPLIED names them in one column and
// this device's own settings in the other. Every home, device directory and project here is a
// temporary directory; "another device" is a second device directory and home.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, chainIdentity, computeInstallTreeDigest, createProject, materializeWorkspace, readRegistry, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { DOCTOR_CHECKS } from "../dist/build/packages/core/src/doctor.js";
import { ENGINE_FORMAT_VERSION } from "../dist/build/packages/core/src/format-version.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import { applySetup, planSetup } from "../dist/build/packages/core/src/setup.js";
import { RESTORE_CHECKS, RESTORE_CHECK_REASON_CODES, verifyRestore } from "../dist/build/packages/core/src/setup-restore.js";
import { SKILL_COPY_ROOTS, skillCopyPath } from "../dist/build/packages/core/src/skill-copies.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");
const setupModule = pathToFileURL(join(repositoryRoot, "dist/build/packages/core/src/setup.js")).href;

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-restore-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 4, 0, second)).toISOString().replace(".000Z", "Z");
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

/** Point this process at one device: its directory and its user's home. */
function use(device) {
  process.env.EINZBERN_HOME = device.deviceHome;
  process.env.HOME = device.home;
  process.env.USERPROFILE = device.home;
}

/** The engine version directory as a release lays it out, built from this checkout (tests/setup-fresh.test.mjs). */
async function engineTree(base) {
  const tree = join(base, "trees", FRAMEWORK_VERSION);
  await mkdir(join(tree, "scripts", "policy"), { recursive: true });
  await copyFile(join(repositoryRoot, "scripts/einzbern.mjs"), join(tree, "scripts/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/policy/knowledge-provenance.json"), join(tree, "scripts/policy/knowledge-provenance.json"));
  await cp(join(repositoryRoot, "dist/build"), join(tree, "dist/build"), { recursive: true });
  await mkdir(join(tree, "launchers"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"), join(tree, "launchers/einzbern.mjs"));
  await copyFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"), join(tree, "launchers/hook.mjs"));
  const rendered = await cli(["skill-render", "--out", join(tree, "skill", "mana-orchestrate"), "--version", FRAMEWORK_VERSION]);
  assert.equal(rendered.reasonCode, "SKILL_RENDERED");
  return { tree, sha256: (await computeInstallTreeDigest(tree)).sha256 };
}

/**
 * A temporary base with a project and two devices, a and b, each a device directory and a home. The
 * engine is installed on the devices `engines` names; the process starts as device a.
 */
async function fixture(context, { engines = ["a", "b"] } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-restore-")));
  const project = join(base, "project");
  await mkdir(project, { recursive: true });
  const devices = {};
  for (const name of ["a", "b"]) {
    devices[name] = { home: join(base, `home-${name}`), deviceHome: join(base, `device-${name}`) };
    await mkdir(devices[name].home, { recursive: true });
  }
  const previous = { device: process.env.EINZBERN_HOME, home: process.env.HOME, profile: process.env.USERPROFILE };
  context.after(async () => {
    restoreEnv("EINZBERN_HOME", previous.device);
    restoreEnv("HOME", previous.home);
    restoreEnv("USERPROFILE", previous.profile);
    await rm(base, { recursive: true, force: true });
  });
  if (engines.length > 0) {
    const tree = await engineTree(base);
    for (const name of engines) {
      use(devices[name]);
      const installed = await cli(["engine-update", "--from", tree.tree, "--sha256", tree.sha256, "--version", FRAMEWORK_VERSION, "--at", at()]);
      assert.equal(installed.reasonCode, "ENGINE_UPDATED");
    }
  }
  use(devices.a);
  return { base, project, library: join(project, ".ether"), a: devices.a, b: devices.b };
}

/** Device a installs the project with a fresh library in .ether; the process is device a afterwards. */
async function installOnA(f, answers = {}) {
  use(f.a);
  const planned = await planSetup({ mode: "fresh", projectRoot: f.project, at: at(), home: f.a.home, deviceHome: f.a.deviceHome, answers });
  assert.deepEqual(planned.blockers, []);
  const applied = await applySetup(planned);
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  return applied;
}

function restorePlan(f, device, restore, extra = {}) {
  return planSetup({ mode: "restore", projectRoot: f.project, at: at(), home: device.home, deviceHome: device.deviceHome, restore, ...extra });
}

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

// planSetup in a child process under the write tripwire over `roots`; answers the plan or the refusal.
async function planUnderTripwire(f, device, options, roots) {
  const script = join(f.base, "plan-only.mjs");
  await writeFile(script, [
    `import { planSetup } from ${JSON.stringify(setupModule)};`,
    "try {",
    "  process.stdout.write(JSON.stringify({ ok: true, plan: await planSetup(JSON.parse(process.argv[2])) }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ ok: false, reasonCode: error.reasonCode, details: error.details ?? {}, message: String(error.message) }));",
    "}",
    "",
  ].join("\n"));
  const run = spawnSync(process.execPath, ["--import", tripwirePath, script, JSON.stringify(options)], {
    encoding: "utf8",
    env: { ...process.env, HOME: device.home, EINZBERN_HOME: device.deviceHome, EINZBERN_TRIPWIRE_ROOT: roots.join(delimiter) },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

async function rewriteManifest(library, change) {
  const path = join(library, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, canonicalJson({ ...manifest, ...change }));
}

function git(directory, args) {
  const run = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

/** A refusal of check `check`, with `cause` as what failed in it. */
function stoppedAt(check, cause) {
  return (error) => {
    assert.equal(error.reasonCode, RESTORE_CHECK_REASON_CODES[check], error.message);
    assert.equal(error.details.check, check);
    assert.equal(error.details.item, String(RESTORE_CHECKS.indexOf(check) + 1));
    assert.equal(error.details.cause, cause);
    return true;
  };
}

test("480-AC3: a library in a newer format stops the restore at the third check, and nothing is written", async (context) => {
  const f = await fixture(context);
  await installOnA(f);
  use(f.b);
  const plan = await restorePlan(f, f.b, f.library);
  assert.deepEqual(plan.blockers, []);

  // A newer engine moved the library one format past this engine's (format-version.ts) after the plan was made.
  await rewriteManifest(f.library, { formatVersion: ENGINE_FORMAT_VERSION + 1 });
  const roots = [f.b.home, f.b.deviceHome, f.project];
  const before = await snapshot(roots);
  const refused = await planUnderTripwire(f, f.b, { mode: "restore", projectRoot: f.project, at: at(), home: f.b.home, deviceHome: f.b.deviceHome, restore: f.library }, roots);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.reasonCode, "RESTORE_FORMAT_UNSUPPORTED", refused.message);
  assert.equal(refused.details.check, "format");
  assert.equal(refused.details.item, "3");
  assert.equal(refused.details.cause, "LIBRARY_FORMAT_UNSUPPORTED");
  assert.equal(refused.details.required, String(ENGINE_FORMAT_VERSION + 1));
  assert.equal(refused.details.supported, String(ENGINE_FORMAT_VERSION));
  assert.equal(refused.details.remedy, "engine-update");
  assert.deepEqual(await snapshot(roots), before, "the plan wrote nothing");

  // The apply runs the eight checks again: the plan made before the change is refused the same way.
  await assert.rejects(applySetup(plan), stoppedAt("format", "LIBRARY_FORMAT_UNSUPPORTED"));
  assert.deepEqual(await snapshot(roots), before, "the apply wrote nothing");

  // The checks stop at the third: the first two passed, and nothing after the third ran.
  const verification = await verifyRestore({ projectRoot: f.project, home: f.b.home, deviceHome: f.b.deviceHome, libraryPath: f.library });
  assert.equal(verification.ok, false);
  assert.deepEqual(verification.checks.map((check) => [check.item, check.check, check.ok, check.reasonCode]), [
    [1, "readable", true, null],
    [2, "library", true, null],
    [3, "format", false, "RESTORE_FORMAT_UNSUPPORTED"],
  ]);
});

test("480-R3: each of the other seven checks stops the restore with its own reason code, and nothing is written", async (context) => {
  const f = await fixture(context, { engines: ["a"] });
  const applied = await installOnA(f);
  const deviceA = applied.deviceId;
  use(f.b);
  const roots = [f.b.home, f.b.deviceHome, f.project];
  const copies = join(f.base, "copies");
  await mkdir(copies);
  const refusedWithoutWrites = async (options, check, cause) => {
    const before = await snapshot(roots);
    let refusal = null;
    await assert.rejects(planSetup({ mode: "restore", projectRoot: f.project, at: at(), home: f.b.home, deviceHome: f.b.deviceHome, ...options }), (error) => {
      refusal = error;
      return stoppedAt(check, cause)(error);
    });
    assert.deepEqual(await snapshot(roots), before, `${check}: nothing was written`);
    return refusal;
  };

  // 1 readable: nothing at the place; a placeholder whose bytes never arrive times out.
  await refusedWithoutWrites({ restore: join(f.base, "missing") }, "readable", "ENOENT");
  const blocked = (path) => (path.endsWith(".ndjson") ? new Promise(() => {}) : readFile(path));
  const started = Date.now();
  const timedOut = await verifyRestore({ projectRoot: f.project, home: f.b.home, deviceHome: f.b.deviceHome, libraryPath: f.library }, { readFile: blocked, timeoutMs: 100 });
  assert.ok(Date.now() - started < 5000, "it returned promptly");
  assert.deepEqual(timedOut.checks.map((check) => [check.check, check.ok, check.reasonCode]), [["readable", false, "RESTORE_UNREADABLE"]]);
  assert.equal(timedOut.checks[0].detail.cause, "AKASHA_READ_TIMEOUT");
  assert.equal(timedOut.checks[0].detail.file, `${deviceA}/00000001.ndjson`);

  // 2 library: a directory without a manifest; an old-layout workspace is a migration.
  const empty = join(copies, "empty");
  await mkdir(empty);
  await refusedWithoutWrites({ restore: empty }, "library", "LIBRARY_NOT_FOUND");
  const legacy = join(copies, "legacy");
  await mkdir(join(legacy, ".tcrn-workflow"), { recursive: true });
  await writeFile(join(legacy, ".tcrn-workflow", "workspace.json"), "{}\n");
  const migrate = await refusedWithoutWrites({ restore: legacy }, "library", "LEGACY_WORKSPACE");
  assert.equal(migrate.details.remedy, "--mode migrate");

  // 4 streams: a copy a sync client kept of a conflicting stream manifest.
  const conflicted = join(copies, "conflicted");
  await cp(f.library, conflicted, { recursive: true });
  await writeFile(join(conflicted, "akasha", deviceA, "manifest (conflicted copy 2026-09-27).json"), "{}\n");
  const copy = await refusedWithoutWrites({ restore: conflicted }, "streams", "SYNC_CONFLICT_COPY");
  assert.equal(copy.details.deviceId, deviceA);
  // ... and a segment changed in place, which breaks its stream.
  const forged = join(copies, "forged");
  await cp(f.library, forged, { recursive: true });
  const segment = join(forged, "akasha", deviceA, "00000001.ndjson");
  const text = await readFile(segment, "utf8");
  await writeFile(segment, text.replace("\"artifact.language\"", "\"artifact.languagf\""));
  const broken = await refusedWithoutWrites({ restore: forged }, "streams", "AKASHA_EVENT_CORRUPT");
  assert.equal(broken.details.deviceId, deviceA);

  // 5 project: the library names another repository as its project's.
  const elsewhere = join(f.base, "elsewhere");
  await mkdir(elsewhere);
  git(elsewhere, ["init", "--quiet"]);
  git(elsewhere, ["remote", "add", "origin", "https://example.com/owner/other.git"]);
  const zoo = join(copies, "zoo");
  assert.equal((await cli(["init", "--workspace", zoo, "--at", at(), "--git-remote", "https://example.com/owner/zoo.git"])).reasonCode, "LIBRARY_CREATED");
  await assert.rejects(planSetup({ mode: "restore", projectRoot: elsewhere, at: at(), home: f.b.home, deviceHome: f.b.deviceHome, restore: zoo }), (error) => {
    assert.ok(stoppedAt("project", "PROJECT_REMOTE_DIFFERS")(error));
    assert.equal(error.details.required, "example.com/owner/zoo");
    assert.equal(error.details.actual, "example.com/owner/other");
    return true;
  });

  // 7 device-stream: the library was moved away, and its old place only reads.
  const moved = join(copies, "moved");
  await cp(f.library, moved, { recursive: true });
  await writeFile(join(moved, "TOMBSTONE.json"), canonicalJson({ schemaVersion: "einzbern.tombstone.v1", libraryId: applied.library.libraryId, movedTo: f.library, movedAt: at() }));
  const tombstoned = await refusedWithoutWrites({ restore: moved }, "device-stream", "LIBRARY_TOMBSTONED");
  assert.equal(tombstoned.details.movedTo, f.library);

  // 8 sections: the navigation section was changed by hand after the library recorded it.
  const agents = join(f.project, "AGENTS.md");
  const original = await readFile(agents, "utf8");
  await writeFile(agents, original.replace("This project is managed by Einzbern.", "This project is managed by hand."));
  const diverged = await refusedWithoutWrites({ restore: f.library }, "sections", "MANAGED_SECTION_PENDING");
  assert.equal(diverged.details.section, "AGENTS.md#navigation");
  await writeFile(agents, original);

  // 6 registry: this device already binds the project to another library.
  const other = join(copies, "other");
  assert.equal((await cli(["init", "--workspace", other, "--at", at(), "--project", f.project])).reasonCode, "LIBRARY_CREATED");
  const bound = await refusedWithoutWrites({ restore: f.library }, "registry", "PROJECT_REGISTERED_ELSEWHERE");
  assert.equal(bound.details.registeredLibrary, other);
  assert.equal(bound.details.remedy, "--mode uninstall");
});

test("480-R3: once all eight pass, the project is registered and wired from the registry on, and SETUP_APPLIED names the two columns", async (context) => {
  const f = await fixture(context);
  const first = await installOnA(f, { language: "zh-CN" });
  const library = f.library;
  use(f.b);

  // Without --restore the plan names the question, suggests the project's own library and cannot be applied.
  const unanswered = await planSetup({ mode: "restore", projectRoot: f.project, at: at(), home: f.b.home, deviceHome: f.b.deviceHome });
  assert.equal(unanswered.reasonCode, "SETUP_PLAN_READY");
  assert.deepEqual(unanswered.questions.map((question) => [question.id, question.flag, question.default]), [["restore", "--restore", library], ["cloud", "--cloud", null]]);
  assert.deepEqual(unanswered.blockers.map((blocker) => blocker.reasonCode), ["SETUP_ANSWER_REQUIRED"]);
  assert.deepEqual(unanswered.writes, []);
  assert.equal(unanswered.coordination, null, "R46 I08: without a library there is no coordination to name");
  await assert.rejects(applySetup(unanswered), (error) => error.reasonCode === "SETUP_BLOCKED" && error.details.reasonCode === "SETUP_ANSWER_REQUIRED");
  await assert.rejects(planSetup({ mode: "restore", projectRoot: f.project, at: at(), home: f.b.home, deviceHome: f.b.deviceHome, answers: { language: "en" } }), { reasonCode: "SETUP_OPTION_NOT_APPLICABLE" });

  // Fixture library writes belong to device a; device b is the restore target and
  // must still be absent when the read-only restore plan declares its create row.
  use(f.a);
  const other = await createProject(library, { externalKey: "OTHER-RESTORE-TARGET", name: "Other target", occurredAt: at() });
  const otherId = other.projects.find(project => project.externalKey === "OTHER-RESTORE-TARGET").id;
  await setWorkspaceSetting(library, { configurationProjectId: otherId, key: "artifact.language", value: "fr", occurredAt: at() });
  await setWorkspaceSetting(library, { key: "artifact.language", value: "ko", occurredAt: at() });
  use(f.b);
  await assert.rejects(lstat(join(f.b.deviceHome, "device.json")), { code: "ENOENT" });
  const libraryDigest = (await computeInstallTreeDigest(library)).sha256;
  const planned = await restorePlan(f, f.b, library);
  await assert.rejects(lstat(join(f.b.deviceHome, "device.json")), { code: "ENOENT" }, "planning does not create the restore device");
  assert.equal(planned.mode, "restore");
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.verification.map((check) => [check.item, check.check, check.ok]), RESTORE_CHECKS.map((check, index) => [index + 1, check, true]));
  assert.deepEqual(planned.library, { path: library, action: "reuse", libraryId: first.library.libraryId });
  assert.deepEqual(planned.questions.map((question) => [question.id, question.default]), [["cloud", false]]);
  assert.equal(planned.resolved.language, "zh-CN", "the declared restored target keeps zh-CN independently of library ko and another project fr");
  const expected = [
    ["device", join(f.b.deviceHome, "device.json"), "create"],
    ["registry", join(f.b.deviceHome, "registry.json"), "create"],
    ["skill-copies", join(f.b.home, ".claude", "skills", "mana-orchestrate"), "create"],
    ["skill-copies", join(f.b.home, ".agents", "skills", "mana-orchestrate"), "create"],
    ["skill-copies", join(f.b.deviceHome, "skills.json"), "create"],
    ["launchers", join(f.b.deviceHome, "engine", "einzbern.mjs"), "create"],
    ["launchers", join(f.b.deviceHome, "engine", "hook.mjs"), "create"],
    ["host-hooks", join(f.b.home, ".claude", "settings.json"), "create"],
    ["host-hooks", join(f.b.home, ".codex", "hooks.json"), "create"],
    ["host-hooks", join(f.b.home, ".codex", "config.toml"), "create"],
    ["machine-settings", join(f.b.deviceHome, "machine-settings.json"), "create"],
  ];
  assert.deepEqual(rows(planned.writes), expected, "no library write: the sections already agree with its records");

  const applied = await applySetup(planned);
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(rows(applied.written), expected, "the summary lists every file written");
  assert.deepEqual(applied.library, { path: library, libraryId: first.library.libraryId, created: false });
  assert.notEqual(applied.deviceId, first.deviceId, "device b has an identity of its own");
  assert.equal((await computeInstallTreeDigest(library)).sha256, libraryDigest, "nothing was written into the library");
  const registry = JSON.parse(await readFile(join(f.b.deviceHome, "registry.json"), "utf8"));
  assert.deepEqual(registry.entries.map((entry) => [entry.projectPath, entry.libraryPath, entry.libraryId, entry.cloudHosted]),
    [[f.project, library, first.library.libraryId, false]]);
  for (const root of SKILL_COPY_ROOTS) assert.ok((await lstat(join(skillCopyPath(f.b.home, root), "SKILL.md"))).isFile(), root.host);
  const launcher = join(f.b.deviceHome, "engine", "hook.mjs");
  assert.deepEqual(await einzbernHooks(join(f.b.home, ".claude", "settings.json")), [["UserPromptSubmit", `node "${launcher}" user-prompt-submit`]]);
  assert.deepEqual(await einzbernHooks(join(f.b.home, ".codex", "hooks.json")), [["UserPromptSubmit", `node "${launcher}" user-prompt-submit`]]);

  // Two columns: the project's settings and records that came back, and this device's own keys.
  const project = applied.columns.project;
  assert.deepEqual(project.settings.find((setting) => setting.key === "artifact.language"), { key: "artifact.language", value: "zh-CN" });
  assert.ok(project.records.some((entry) => entry.collection === "managed-section" && entry.count >= 3), JSON.stringify(project.records));
  const device = new Map(applied.columns.device.map((entry) => [entry.key, entry]));
  assert.deepEqual(device.get("registry.cloudHosted"), { key: "registry.cloudHosted", value: "false", flag: "--cloud" });
  assert.deepEqual(device.get("agents.navigation"), { key: "agents.navigation", value: "written", flag: "--navigation" });
  assert.deepEqual(device.get("crest.userPath"), { key: "crest.userPath", value: null, flag: null });
  assert.ok(!applied.columns.device.some((entry) => entry.key === "artifact.language"), "a project-level key is never a device's");
  assert.deepEqual(applied.selfCheck.map((entry) => entry.check), [...DOCTOR_CHECKS]);
  for (const entry of applied.selfCheck) assert.equal(entry.ok, true, `${entry.check}: ${JSON.stringify(entry.detail)}`);

  // Restoring the same library again finds everything in place and writes nothing.
  const again = await restorePlan(f, f.b, library);
  assert.deepEqual(again.writes, []);
  assert.deepEqual((await applySetup(again)).written, []);
});

test("385-R16: a restore of a library outside the project names each project host file Git tracks, in the plan and in SETUP_APPLIED", async (context) => {
  const f = await fixture(context);
  const library = join(f.base, "shared", "Ether", "project");
  git(f.project, ["init", "--quiet"]);
  // Device a installs with the library outside the project, so its wiring writes both host files.
  await installOnA(f, { artifacts: library });
  const files = [".claude/settings.local.json", ".codex/config.toml"];
  use(f.b);
  assert.deepEqual((await restorePlan(f, f.b, library)).warnings, [], "files Git does not track warn of nothing");

  git(f.project, ["add", "--", ...files]);
  const expected = files.map((file) => ({
    reasonCode: "HOST_WRITABLE_ROOTS_TRACKED_BY_GIT",
    file,
    message: `${file} is tracked by Git and may publish this device's library path if committed`,
  }));
  const planned = await restorePlan(f, f.b, library);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.verification.map((check) => check.ok), RESTORE_CHECKS.map(() => true));
  assert.deepEqual(planned.writes.filter((entry) => entry.step === "writable-roots"), [], "the files already name the library");
  assert.deepEqual(planned.warnings, expected, "still, each tracked file is named before anything is written");
  const applied = await applySetup(planned);
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(applied.warnings, expected);
});

// Approved contract item 3 with STORY-480 R3/AC3 (INIT-053 U04): a second device restoring a
// library recognizes the coordination identity the library names and never creates a second one;
// a later first installation there joins the same identity; once the coordination library is at
// the device's default location, a restore registers it as setup does, writing nothing into it.
test("480-R3 (U04): a second device recognizes the restored coordination identity, creates none in its place, and registers it once it is at its default location", async (context) => {
  const f = await fixture(context);
  const first = await installOnA(f);
  const coordinationId = chainIdentity(await materializeWorkspace(f.library)).coordinationLibraryId;
  const coordinationOnA = join(f.a.deviceHome, "coordination-library");
  const coordinationOnB = join(f.b.deviceHome, "coordination-library");
  const digestOnA = (await computeInstallTreeDigest(coordinationOnA)).sha256;
  use(f.b);
  // The plan runs through the shipped entry with every network call refused: restore stays offline.
  const offline = spawnSync(process.execPath, ["--import", join(repositoryRoot, "scripts/no-network.mjs"), join(repositoryRoot, "scripts/einzbern.mjs"),
    "setup", "--mode", "restore", "--project", f.project, "--at", at(), "--restore", f.library], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: f.b.deviceHome, HOME: f.b.home, USERPROFILE: f.b.home },
  });
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(JSON.parse(offline.stdout).reasonCode, "SETUP_PLAN_READY");
  // TCRN-CROSS-INIT-053 R46 (I08): the plan and the receipt name the coordination chain the library
  // names, as this device has it: here unregistered, with nothing made in its place.
  const unregistered = { libraryId: coordinationId, status: "unregistered", path: null };
  assert.deepEqual(JSON.parse(offline.stdout).coordination, unregistered);
  const restoring = await restorePlan(f, f.b, f.library);
  assert.deepEqual(restoring.coordination, unregistered);
  const applied = await applySetup(restoring);
  assert.equal(applied.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(applied.coordination, unregistered);
  assert.equal(await lstat(coordinationOnB).catch(() => null), null, "no second coordination library is created");
  assert.equal(chainIdentity(await materializeWorkspace(f.library)).coordinationLibraryId, coordinationId, "the restored library still names its coordination");
  assert.deepEqual((await readRegistry(f.b.deviceHome)).entries.map((entry) => entry.libraryId), [first.library.libraryId], "the coordination stays unregistered on device b");

  // A later first installation of another project on device b joins the same identity.
  const other = join(f.base, "other");
  await mkdir(other);
  const planned = await planSetup({ mode: "fresh", projectRoot: other, at: at(), home: f.b.home, deviceHome: f.b.deviceHome });
  assert.deepEqual(planned.blockers, []);
  assert.ok(!planned.writes.some((entry) => entry.path === coordinationOnB), "the plan creates no coordination library");
  assert.deepEqual(planned.coordination, unregistered, "R46 I08: a fresh plan names the identity it joins, unregistered here");
  const joined = await applySetup(planned);
  assert.equal(joined.reasonCode, "SETUP_APPLIED");
  assert.deepEqual(joined.coordination, unregistered);
  assert.equal(chainIdentity(await materializeWorkspace(join(other, ".ether"))).coordinationLibraryId, coordinationId, "it joins the identity the restored library names");
  assert.equal(await lstat(coordinationOnB).catch(() => null), null);

  // The coordination library arrives at device b's default location: a restore registers it.
  await cp(coordinationOnA, coordinationOnB, { recursive: true });
  const digestOnB = (await computeInstallTreeDigest(coordinationOnB)).sha256;
  const located = await restorePlan(f, f.b, f.library);
  assert.deepEqual(rows(located.writes), [["registry", join(f.b.deviceHome, "registry.json"), "update"]]);
  assert.deepEqual(located.coordination, { libraryId: coordinationId, status: "located", path: coordinationOnB }, "R46 I08: found at the default location");
  const registered = await applySetup(located);
  assert.deepEqual(rows(registered.written), rows(located.writes), "the apply wrote what the plan listed");
  assert.deepEqual(registered.coordination, { libraryId: coordinationId, status: "registered", path: coordinationOnB }, "R46 I08: the apply registered it");
  const entry = (await readRegistry(f.b.deviceHome)).entries.find((candidate) => candidate.libraryId === coordinationId);
  assert.deepEqual([entry.projectPath, entry.libraryPath, entry.chainRole], [coordinationOnB, coordinationOnB, "coordination"]);
  assert.equal((await computeInstallTreeDigest(coordinationOnB)).sha256, digestOnB, "registering it writes nothing into the coordination library");
  assert.equal((await computeInstallTreeDigest(coordinationOnA)).sha256, digestOnA, "device a's coordination library is untouched");
  const further = await restorePlan(f, f.b, f.library);
  assert.deepEqual(further.writes, [], "a further restore finds everything in place");
  assert.deepEqual(further.coordination, { libraryId: coordinationId, status: "registered", path: coordinationOnB });
});

// Approved contract item 3 (INIT-053 U04): competing coordination identities are a conflict that
// names every candidate and how to settle it, and the refused plan writes nothing.
test("480-R3 (U04): restoring a library that names another coordination than this device's stops with both candidates", async (context) => {
  const f = await fixture(context);
  await installOnA(f);
  const named = chainIdentity(await materializeWorkspace(f.library)).coordinationLibraryId;
  use(f.b);
  const own = join(f.base, "own");
  await mkdir(own);
  assert.equal((await applySetup(await planSetup({ mode: "fresh", projectRoot: own, at: at(), home: f.b.home, deviceHome: f.b.deviceHome }))).reasonCode, "SETUP_APPLIED");
  const deviceCoordination = chainIdentity(await materializeWorkspace(join(own, ".ether"))).coordinationLibraryId;
  assert.notEqual(deviceCoordination, named);
  const registryBefore = await readFile(join(f.b.deviceHome, "registry.json"));
  const projectBefore = await snapshot([f.project, f.b.home]);
  await assert.rejects(restorePlan(f, f.b, f.library), (error) => {
    assert.equal(error.reasonCode, "PROJECT_CHAIN_INVALID", error.message);
    assert.deepEqual(error.details.conflicts, [named, deviceCoordination].sort());
    assert.equal(error.details.remedy, "chain-declare");
    return true;
  });
  const run = spawnSync(process.execPath, [join(repositoryRoot, "scripts/einzbern.mjs"), "setup", "--mode", "restore", "--project", f.project, "--at", at(), "--restore", f.library], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: f.b.deviceHome, HOME: f.b.home, USERPROFILE: f.b.home },
  });
  assert.equal(run.status, 1, run.stdout);
  const refusal = JSON.parse(run.stderr.trim().split("\n").at(-1));
  assert.deepEqual([refusal.reasonCode, refusal.conflicts, refusal.remedy], ["PROJECT_CHAIN_INVALID", [named, deviceCoordination].sort(), "chain-declare"]);
  assert.deepEqual(await readFile(join(f.b.deviceHome, "registry.json")), registryBefore, "the registry is as it was");
  assert.deepEqual(await snapshot([f.project, f.b.home]), projectBefore, "the project and device b's home are as they were");
});
