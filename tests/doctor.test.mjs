// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-480 R4, AC5 (TCRN-CROSS-SUB-326): doctor's eight checks. A device and a project
// set up the way setup leaves them are green on all eight; then each check is made red on its own,
// and only that check turns red, with its own reason code and the cause in its detail.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FRAMEWORK_VERSION,
  HOST_HOOK_HOSTS,
  acquireFileLock,
  applyHostHooks,
  initializeLibrary,
  installSkillCopies,
  lockPath,
  planHostHooks,
  readHostHooks,
  registerLibrary,
} from "../dist/build/packages/core/src/index.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { DOCTOR_CHECKS, DOCTOR_CHECK_REASON_CODES, DOCTOR_REASON_CODES, runDoctor } from "../dist/build/packages/core/src/doctor.js";
import { renderSection, sectionDigest } from "../dist/build/packages/core/src/managed-sections.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-doctor-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

const AT = "2026-09-27T01:00:00Z";
const SECTION_BODY = "Read docs/navigation.md before a task.\n";

// engine/<version> with its entry, engine/current naming it, and the two stable launchers.
async function writeEngine(deviceHome, version, previous = null) {
  const engine = join(deviceHome, "engine");
  await mkdir(join(engine, version, "scripts"), { recursive: true });
  await writeFile(join(engine, version, "scripts", "einzbern.mjs"), "export {};\n");
  await writeFile(join(engine, "current"), canonicalJson({ schemaVersion: "einzbern.engine-current.v1", version, previous, switchedAt: AT }));
  await writeFile(join(engine, "einzbern.mjs"), "export {};\n");
  await writeFile(join(engine, "hook.mjs"), "export {};\n");
}

// A device and a project as setup leaves them: the engine current, one hook in each host's user
// settings, both skill copies recorded, a registered library in the project, and one managed
// section in AGENTS.md with its library record.
async function healthy(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-doctor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const deviceHome = join(home, ".einzbern");
  const project = join(base, "project");
  await mkdir(deviceHome, { recursive: true });
  await mkdir(project, { recursive: true });
  // The library writes below go through this device directory, as the engine's own writes do.
  process.env.EINZBERN_HOME = deviceHome;
  await writeEngine(deviceHome, FRAMEWORK_VERSION);
  for (const host of HOST_HOOK_HOSTS) {
    await applyHostHooks(await readHostHooks(planHostHooks({ host, scope: "user", deviceHome }), { root: home, home }), { at: AT });
  }
  const skill = join(base, "skill");
  await mkdir(join(skill, "references"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: mana-orchestrate\ndescription: doctor fixture\n---\n");
  await writeFile(join(skill, "references", "doctor.md"), "# doctor\n");
  await installSkillCopies({ source: skill, now: AT, home, deviceHome });
  const library = join(project, ".ether");
  await initializeLibrary({ root: library, createdAt: AT });
  await registerLibrary({ projectPath: project, libraryPath: library, registeredAt: AT, cloudHosted: false, gitRemote: null }, deviceHome);
  await writeFile(join(project, "AGENTS.md"), `# Project\n\n${renderSection({ id: "navigation", rev: 1, body: SECTION_BODY })}`);
  await setConfigRecord(library, {
    collection: "managed-section",
    key: "AGENTS.md#navigation",
    value: { file: "AGENTS.md", id: "navigation", rev: 1, digest: sectionDigest(SECTION_BODY), state: "managed" },
    occurredAt: AT,
  });
  return { base, home, deviceHome, project, library };
}

function doctor(fixture, options = {}) {
  return runDoctor({ projectRoot: fixture.project, home: fixture.home, deviceHome: fixture.deviceHome, lockTimeoutMs: 50, ...options });
}

function byCheck(results, check) {
  return results.find((entry) => entry.check === check);
}

// Exactly `check` is red, with its own reason code and `cause` among its causes; the other seven are green.
function assertOnlyRed(results, check, cause) {
  assert.deepEqual(results.map((entry) => entry.check), [...DOCTOR_CHECKS]);
  for (const entry of results) {
    if (entry.check === check) {
      assert.equal(entry.ok, false, `${check} is red`);
      assert.equal(entry.reasonCode, DOCTOR_CHECK_REASON_CODES[check]);
      assert.ok(entry.detail.causes.includes(cause), `${check} names ${cause}: ${JSON.stringify(entry.detail)}`);
    } else {
      assert.equal(entry.ok, true, `${entry.check} stays green: ${JSON.stringify(entry.detail)}`);
      assert.equal(entry.reasonCode, null);
      assert.deepEqual(entry.detail.causes, []);
    }
  }
}

async function libraryId(fixture) {
  return JSON.parse(await readFile(join(fixture.library, "manifest.json"), "utf8")).libraryId;
}

async function lockFiles(fixture) {
  return (await readdir(join(fixture.deviceHome, "locks"))).filter((name) => name.endsWith(".lock"));
}

test("480-R4: each of the eight checks answers one reason code of its own", () => {
  assert.equal(DOCTOR_CHECKS.length, 8);
  assert.deepEqual(Object.keys(DOCTOR_CHECK_REASON_CODES).sort(), [...DOCTOR_CHECKS].sort());
  const codes = Object.values(DOCTOR_CHECK_REASON_CODES);
  assert.equal(new Set(codes).size, 8, "no two checks share a reason code");
  assert.deepEqual([...codes].sort(), [...DOCTOR_REASON_CODES].sort());
});

test("480-AC5: a device and project as setup leaves them are green on all eight checks, and doctor leaves nothing behind", async (context) => {
  const fixture = await healthy(context);
  const results = await doctor(fixture);
  assert.deepEqual(results.map((entry) => [entry.check, entry.ok, entry.reasonCode]), DOCTOR_CHECKS.map((check) => [check, true, null]));
  for (const entry of results) assert.deepEqual(entry.detail.causes, [], entry.check);
  assert.equal(byCheck(results, "engine-version").detail.current, FRAMEWORK_VERSION);
  assert.deepEqual(byCheck(results, "hooks-present").detail.hosts.map((host) => [host.host, host.hooks]), HOST_HOOK_HOSTS.map((host) => [host, 1]));
  assert.equal(byCheck(results, "registry").detail.via, "project-path");
  assert.equal(byCheck(results, "library-format").detail.source, "registry");
  assert.deepEqual(byCheck(results, "managed-sections").detail.pending, []);
  assert.equal(byCheck(results, "cloud-flag").detail.advisory, true);
  // The probe file and the lock are gone again.
  const probed = byCheck(results, "device-stream").detail.probed;
  assert.ok(probed.startsWith(join(fixture.library, "akasha")), probed);
  assert.deepEqual((await readdir(probed)).filter((name) => name.startsWith(".tmp-")), []);
  assert.deepEqual(await lockFiles(fixture), []);
});

test("480-AC5: engine-version is red without engine/current, and on a Node.js below the floor", async (context) => {
  const fixture = await healthy(context);
  assertOnlyRed(await doctor(fixture, { nodeVersion: "22.11.0" }), "engine-version", "ENGINE_NODE_TOO_OLD");
  await rm(join(fixture.deviceHome, "engine", "current"));
  assertOnlyRed(await doctor(fixture), "engine-version", "ENGINE_CURRENT_MISSING");
});

test("480-AC5: hooks-present is red for a host without its hook", async (context) => {
  const fixture = await healthy(context);
  await writeFile(join(fixture.home, ".claude", "settings.json"), "{}\n");
  const results = await doctor(fixture);
  assertOnlyRed(results, "hooks-present", "HOOK_MISSING");
  const hosts = byCheck(results, "hooks-present").detail.hosts;
  assert.deepEqual(hosts.map((host) => [host.host, host.causes]), [["claude-code", ["HOOK_MISSING"]], ["codex", []]]);
});

test("480-AC5: hooks-present is red for a host whose hook is in both scopes", async (context) => {
  const fixture = await healthy(context);
  const plan = await readHostHooks(planHostHooks({ host: "codex", scope: "project", deviceHome: fixture.deviceHome }), { root: fixture.project, home: fixture.home });
  await applyHostHooks(plan, { at: AT });
  assertOnlyRed(await doctor(fixture), "hooks-present", "HOOK_DUPLICATED");
});

// problems-w1-host-hooks.md #7: a settings file linked into a dotfiles repository is refused by the
// installer (HOST_HOOKS_FILE_UNSUPPORTED); doctor shows that reason rather than a missing hook.
test("480-AC5: hooks-present names HOST_HOOKS_FILE_UNSUPPORTED for a hook file that is a symbolic link", async (context) => {
  const fixture = await healthy(context);
  const settings = join(fixture.home, ".claude", "settings.json");
  const dotfiles = join(fixture.base, "dotfiles");
  await mkdir(dotfiles);
  await rename(settings, join(dotfiles, "settings.json"));
  await symlink(join(dotfiles, "settings.json"), settings);
  const results = await doctor(fixture);
  assertOnlyRed(results, "hooks-present", "HOST_HOOKS_FILE_UNSUPPORTED");
  assert.deepEqual(byCheck(results, "hooks-present").detail.hosts[0].causes, ["HOST_HOOKS_FILE_UNSUPPORTED"]);
});

test("480-AC5: skill-copies is red when a copy no longer holds the recorded tree", async (context) => {
  const fixture = await healthy(context);
  await writeFile(join(fixture.home, ".claude", "skills", "mana-orchestrate", "SKILL.md"), "---\nname: mana-orchestrate\ndescription: edited\n---\n");
  const results = await doctor(fixture);
  assertOnlyRed(results, "skill-copies", "SKILL_COPIES_DRIFTED");
  assert.deepEqual(byCheck(results, "skill-copies").detail.copies.map((copy) => copy.reasonCode), ["SKILL_COPY_DIGEST_MISMATCH", "SKILL_COPY_VERIFIED"]);
});

test("480-AC5: registry is red when the project is not registered, and the project's own library is still checked", async (context) => {
  const fixture = await healthy(context);
  await rm(join(fixture.deviceHome, "registry.json"));
  const results = await doctor(fixture);
  assertOnlyRed(results, "registry", "LIBRARY_NOT_REGISTERED");
  assert.equal(byCheck(results, "library-format").detail.source, "project");
  assert.equal(byCheck(results, "cloud-flag").detail.registered, false);
  await writeFile(join(fixture.deviceHome, "registry.json"), "not a registry\n");
  assertOnlyRed(await doctor(fixture), "registry", "LIBRARY_REGISTRY_INVALID");
});

test("480-AC5: library-format is red when the engine this device has current is older than the library needs", async (context) => {
  const fixture = await healthy(context);
  await writeEngine(fixture.deviceHome, "0.0.1", FRAMEWORK_VERSION);
  const results = await doctor(fixture);
  assertOnlyRed(results, "library-format", "ENGINE_TOO_OLD");
  assert.equal(byCheck(results, "library-format").detail.currentEngine, "0.0.1");
  assert.equal(byCheck(results, "library-format").detail.minEngineVersion, FRAMEWORK_VERSION);
});

test("480-AC5: device-stream is red while the library's write lock cannot be taken", async (context) => {
  const fixture = await healthy(context);
  const held = await acquireFileLock(lockPath(await libraryId(fixture), fixture.deviceHome));
  try {
    const results = await doctor(fixture);
    assertOnlyRed(results, "device-stream", "FILE_LOCK_TIMEOUT");
    assert.equal(byCheck(results, "device-stream").detail.holderPid, String(process.pid));
  } finally {
    await held.release();
  }
});

test("480-AC5: managed-sections is red and lists a section the user changed, or a file whose markers do not parse", async (context) => {
  const fixture = await healthy(context);
  const agents = join(fixture.project, "AGENTS.md");
  // A CLAUDE.md linked to AGENTS.md holds no section of its own: it is skipped, not red.
  await symlink("AGENTS.md", join(fixture.project, "CLAUDE.md"));
  const linked = await doctor(fixture);
  assert.deepEqual(linked.map((entry) => entry.ok), DOCTOR_CHECKS.map(() => true));
  assert.deepEqual(byCheck(linked, "managed-sections").detail.skipped, ["CLAUDE.md"]);
  const original = await readFile(agents, "utf8");
  await writeFile(agents, original.replace("before a task.", "before every task."));
  const results = await doctor(fixture);
  assertOnlyRed(results, "managed-sections", "MANAGED_SECTION_PENDING");
  assert.deepEqual(byCheck(results, "managed-sections").detail.pending, ["AGENTS.md#navigation"]);
  await writeFile(agents, original.replace("<!-- einzbern:section-end id=navigation -->\n", ""));
  const malformed = await doctor(fixture);
  assertOnlyRed(malformed, "managed-sections", "MANAGED_SECTION_MALFORMED");
  assert.deepEqual(byCheck(malformed, "managed-sections").detail.problems, [{ file: "AGENTS.md", reasonCode: "MANAGED_SECTION_MALFORMED", line: 3 }]);
});

test("480-AC5: cloud-flag is red, as a hint, when the registry's flag differs from the cloud folder table", async (context) => {
  const fixture = await healthy(context);
  await registerLibrary({ projectPath: fixture.project, libraryPath: fixture.library, registeredAt: AT, cloudHosted: true, gitRemote: null }, fixture.deviceHome);
  const results = await doctor(fixture);
  assertOnlyRed(results, "cloud-flag", "CLOUD_FLAG_DIFFERS_FROM_SUGGESTION");
  const detail = byCheck(results, "cloud-flag").detail;
  assert.deepEqual([detail.cloudHosted, detail.suggested, detail.advisory], [true, false, true]);
});

// An engine never locks or writes a library it may not open (format-version.ts): a library in a
// newer format is library-format's red, and device-stream refuses it before its lock or a probe.
test("480-R4: a library in a newer format is refused before its lock is taken or a probe written", async (context) => {
  const fixture = await healthy(context);
  const manifestPath = join(fixture.library, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, canonicalJson({ ...manifest, formatVersion: manifest.formatVersion + 1 }));
  const streams = await readdir(join(fixture.library, "akasha"), { recursive: true });
  const results = await doctor(fixture);
  assert.equal(byCheck(results, "library-format").reasonCode, "DOCTOR_LIBRARY_UNSUPPORTED");
  assert.deepEqual(byCheck(results, "library-format").detail.causes, ["LIBRARY_FORMAT_UNSUPPORTED"]);
  assert.deepEqual(byCheck(results, "device-stream").detail.causes, ["LIBRARY_FORMAT_UNSUPPORTED"]);
  assert.deepEqual(await lockFiles(fixture), []);
  assert.deepEqual(await readdir(join(fixture.library, "akasha"), { recursive: true }), streams);
});
