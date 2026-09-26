// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-479 R4, R5 and the mechanism of AC2 (MIN-227): the Mana Orchestrate skill is
// placed as ~/.claude/skills/mana-orchestrate and ~/.agents/skills/mana-orchestrate, never under
// ~/.codex/skills and never under the legacy helper's name; skills.json in the device directory
// records each copy's install-tree digest; installing the same tree again changes nothing; and the
// legacy helper's copies and install markers are moved whole to a backup, never deleted. Every
// case runs in a temporary home and a temporary device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeInstallTreeDigest } from "../dist/build/packages/core/src/install-tree-digest.js";
import { BRAND, LEGACY_DEVICE_DIRECTORY, LEGACY_ENGINE_NAME, LEGACY_HELPER_NAME } from "../dist/build/packages/core/src/names.js";
import {
  SKILL_COPIES_SCHEMA_VERSION,
  SkillCopiesError,
  applyLegacySkillCleanup,
  installSkillCopies,
  legacySkillCleanupPlan,
  verifySkillCopies,
} from "../dist/build/packages/core/src/skill-copies.js";

// Anything that fell back to the user's home would land in this empty directory, not the real one.
const guardHome = mkdtempSync(join(tmpdir(), "einzbern-skill-guard-home-"));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.once("exit", () => rmSync(guardHome, { recursive: true, force: true }));

const SKILL = BRAND.helper.id;
const HOST_ROOTS = [".claude/skills", ".agents/skills"];
const LEGACY_ROOTS = [".claude/skills", ".agents/skills", ".codex/skills"];

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 14, 0, second)).toISOString().replace(".000Z", "Z");
};

const skillFiles = (marker = "1") => ({
  "SKILL.md": `---\nname: ${SKILL}\ndescription: test payload ${marker}\n---\n\n# ${BRAND.helper.name}\n`,
  "references/install.md": "# install\n",
  "references/doctor.md": "# doctor\n",
  "agents/openai.yaml": `interface:\n  display_name: "${BRAND.helper.name}"\n`,
  "scripts/install.mjs": "export {};\n",
});

async function writeTree(root, files) {
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return root;
}

async function scratch(context, files = skillFiles()) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-skill-copies-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const device = join(base, "device");
  await mkdir(home);
  const source = await writeTree(join(base, "source", SKILL), files);
  return { base, home, device, source };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Every file under a directory, by POSIX relative path, with its bytes.
async function snapshot(root, relative = "", into = {}) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) await snapshot(root, path, into);
    else into[path] = await readFile(join(root, path), "utf8");
  }
  return into;
}

const digestOf = async (path) => (await computeInstallTreeDigest(path)).sha256;
const copyPath = (home, root) => join(home, ...root.split("/"), SKILL);

test("479-R4, AC2: a fresh home gets the skill in both hosts' roots and nothing under the old name or in ~/.codex", async (context) => {
  const { home, device, source } = await scratch(context);
  const report = await installSkillCopies({ source, home, deviceHome: device, now: at() });
  assert.equal(report.reasonCode, "SKILL_COPIES_INSTALLED");
  assert.equal(report.skill, SKILL);
  assert.deepEqual(report.copies.map((copy) => [copy.host, copy.path, copy.action, copy.backup]), [
    ["claude", copyPath(home, ".claude/skills"), "created", null],
    ["codex", copyPath(home, ".agents/skills"), "created", null],
  ]);
  const expected = await digestOf(source);
  assert.equal(report.installTreeDigest, expected);
  for (const root of HOST_ROOTS) {
    assert.equal(await digestOf(copyPath(home, root)), expected);
    // One entry: the copy, and no temporary left beside it.
    assert.deepEqual(await readdir(join(home, ...root.split("/"))), [SKILL]);
  }
  for (const root of LEGACY_ROOTS) assert.equal(await exists(join(home, ...root.split("/"), LEGACY_HELPER_NAME)), false);
  assert.equal(await exists(join(home, ".codex")), false);
  assert.equal(report.backupDir, null);
  assert.equal(await exists(join(device, "backups")), false);

  const verified = await verifySkillCopies({ home, deviceHome: device });
  assert.deepEqual([verified.ok, verified.reasonCode, verified.legacyCopies], [true, "SKILL_COPIES_VERIFIED", []]);
  assert.deepEqual(verified.copies.map((copy) => [copy.host, copy.reasonCode, copy.recorded, copy.actual]), [
    ["claude", "SKILL_COPY_VERIFIED", expected, expected],
    ["codex", "SKILL_COPY_VERIFIED", expected, expected],
  ]);
});

test("479-R4: skills.json records each copy's path and install-tree digest, and a changed copy stops verifying", async (context) => {
  const { base, home, device, source } = await scratch(context);
  const now = at();
  const report = await installSkillCopies({ source, home, deviceHome: device, now });
  assert.equal(report.record, join(device, "skills.json"));
  const record = JSON.parse(await readFile(report.record, "utf8"));
  assert.deepEqual(record, {
    schemaVersion: SKILL_COPIES_SCHEMA_VERSION,
    skill: SKILL,
    installedAt: now,
    copies: [
      { host: "claude", path: copyPath(home, ".claude/skills"), installTreeDigest: report.installTreeDigest },
      { host: "codex", path: copyPath(home, ".agents/skills"), installTreeDigest: report.installTreeDigest },
    ],
  });
  for (const copy of record.copies) assert.equal(await digestOf(copy.path), copy.installTreeDigest);

  await writeFile(join(copyPath(home, ".claude/skills"), "references", "install.md"), "# install, edited\n");
  const drifted = await verifySkillCopies({ home, deviceHome: device });
  assert.deepEqual([drifted.ok, drifted.reasonCode], [false, "SKILL_COPIES_DRIFTED"]);
  assert.deepEqual(drifted.copies.map((copy) => [copy.host, copy.reasonCode]), [
    ["claude", "SKILL_COPY_DIGEST_MISMATCH"],
    ["codex", "SKILL_COPY_VERIFIED"],
  ]);

  const unrecorded = await verifySkillCopies({ home, deviceHome: join(base, "another-device") });
  assert.deepEqual([unrecorded.ok, unrecorded.reasonCode], [false, "SKILL_COPIES_NOT_RECORDED"]);
  await writeFile(report.record, "{\"schemaVersion\":\"einzbern.skill-copies.v1\"}\n");
  const invalid = await verifySkillCopies({ home, deviceHome: device });
  assert.deepEqual([invalid.ok, invalid.reasonCode, invalid.detail], [false, "SKILL_COPIES_RECORD_INVALID", "fields are not exact"]);
});

test("479-R4: installing the same tree again changes nothing, and a new tree moves each old copy whole to a backup", async (context) => {
  const { base, home, device, source } = await scratch(context);
  const first = await installSkillCopies({ source, home, deviceHome: device, now: at() });
  const recordBytes = await readFile(first.record, "utf8");
  const homeBefore = await snapshot(home);

  const again = await installSkillCopies({ source, home, deviceHome: device, now: at() });
  assert.equal(again.reasonCode, "SKILL_COPIES_CURRENT");
  assert.deepEqual(again.copies.map((copy) => [copy.action, copy.backup]), [["reused", null], ["reused", null]]);
  assert.equal(await readFile(first.record, "utf8"), recordBytes);
  assert.deepEqual(await snapshot(home), homeBefore);
  assert.equal(await exists(join(device, "backups")), false);

  const next = await writeTree(join(base, "source-next", SKILL), { ...skillFiles("2"), "references/restore.md": "# restore\n" });
  const replaced = await installSkillCopies({ source: next, home, deviceHome: device, now: "2026-09-26T15:00:00Z" });
  assert.equal(replaced.reasonCode, "SKILL_COPIES_INSTALLED");
  assert.equal(replaced.backupDir, join(device, "backups", "20260926T150000Z", "skill-copies"));
  assert.deepEqual(replaced.copies.map((copy) => [copy.action, copy.backup]), HOST_ROOTS.map((root) => ["replaced", copyPath(replaced.backupDir, root)]));
  assert.notEqual(replaced.installTreeDigest, first.installTreeDigest);
  for (const copy of replaced.copies) {
    assert.equal(await digestOf(copy.path), replaced.installTreeDigest);
    // The copy it replaced is in the backup, whole.
    assert.equal(await digestOf(copy.backup), first.installTreeDigest);
    assert.deepEqual(await readdir(dirname(copy.path)), [SKILL]);
  }
  const record = JSON.parse(await readFile(first.record, "utf8"));
  assert.equal(record.installedAt, "2026-09-26T15:00:00Z");
  assert.deepEqual(record.copies.map((copy) => copy.installTreeDigest), [replaced.installTreeDigest, replaced.installTreeDigest]);
  const verified = await verifySkillCopies({ home, deviceHome: device });
  assert.deepEqual([verified.ok, verified.reasonCode], [true, "SKILL_COPIES_VERIFIED"]);
});

test("479-R4: a source that is not a skill tree is refused and nothing is written", async (context) => {
  const { home, device, source } = await scratch(context, { "references/install.md": "# install\n" });
  await assert.rejects(
    installSkillCopies({ source, home, deviceHome: device, now: at() }),
    (error) => error instanceof SkillCopiesError && error.reasonCode === "SKILL_SOURCE_INVALID",
  );
  assert.deepEqual(await readdir(home), []);
  assert.equal(await exists(join(device, "skills.json")), false);
});

test("479-R5: the old helper's copies and install markers move whole to a backup, leave nothing behind, and nothing else moves", async (context) => {
  const { base, home, device, source } = await scratch(context);
  const legacyDeviceHome = join(home, LEGACY_DEVICE_DIRECTORY);
  const legacyCopy = {
    "SKILL.md": `---\nname: ${LEGACY_HELPER_NAME}\n---\n`,
    "references/trust-contract.md": "# trust contract\n",
    "bootstrap/trusted-bootstrap.mjs": "export {};\n",
  };
  for (const root of LEGACY_ROOTS) await writeTree(join(home, ...root.split("/"), LEGACY_HELPER_NAME), legacyCopy);
  const markers = {
    "complete-skill-archive.provenance.json": "{\"provenance\":true}\n",
    "installed-copy-claude.json": "{\"host\":\"claude\"}\n",
    "installed-copy-codex.json": "{\"host\":\"codex\"}\n",
    "skill-archive.json": "{\"files\":[]}\n",
    "state.json": "{\"state\":1}\n",
    "trusted-bootstrap.mjs": "export const trusted = true;\n",
  };
  // What the cleanup must leave alone: the old engine itself and anything that only looks alike.
  const kept = {
    [`${LEGACY_ENGINE_NAME}/scripts/${LEGACY_ENGINE_NAME}.mjs`]: "export {};\n",
    [`${LEGACY_ENGINE_NAME}/state.json`]: "{\"nested\":true}\n",
    "installed-copy.json": "{}\n",
    "notes.txt": "keep\n",
  };
  await writeTree(legacyDeviceHome, { ...markers, ...kept });
  const legacyDigest = await digestOf(join(home, ".claude", "skills", LEGACY_HELPER_NAME));

  await installSkillCopies({ source, home, deviceHome: device, now: at() });
  const before = await verifySkillCopies({ home, deviceHome: device });
  assert.deepEqual([before.ok, before.reasonCode], [false, "SKILL_COPIES_LEGACY_PRESENT"]);
  assert.deepEqual(before.legacyCopies, LEGACY_ROOTS.map((root) => join(home, ...root.split("/"), LEGACY_HELPER_NAME)));

  const plan = await legacySkillCleanupPlan({ home, legacyDeviceHome });
  assert.deepEqual(plan.items.map((item) => [item.kind, item.path, item.entryType, item.backupPath]), [
    ...LEGACY_ROOTS.map((root) => ["skill-copy", join(home, ...root.split("/"), LEGACY_HELPER_NAME), "directory", `${root}/${LEGACY_HELPER_NAME}`]),
    ...Object.keys(markers).sort().map((name) => ["marker", join(legacyDeviceHome, name), "file", `${LEGACY_DEVICE_DIRECTORY}/${name}`]),
  ]);

  const backupRoot = join(device, "backups", "20260926T160000Z", "legacy-skill-cleanup");
  const applied = await applyLegacySkillCleanup(plan, { backupRoot });
  assert.equal(applied.reasonCode, "LEGACY_SKILL_CLEANUP_APPLIED");
  assert.deepEqual(applied.absent, []);
  assert.deepEqual(applied.moved.map((entry) => [entry.path, entry.backup]),
    plan.items.map((item) => [item.path, join(backupRoot, ...item.backupPath.split("/"))]));
  for (const item of plan.items) assert.equal(await exists(item.path), false);
  for (const root of LEGACY_ROOTS) {
    const backup = join(backupRoot, ...root.split("/"), LEGACY_HELPER_NAME);
    assert.equal(await digestOf(backup), legacyDigest);
    assert.deepEqual(await snapshot(backup), legacyCopy);
  }
  assert.deepEqual(await snapshot(join(backupRoot, LEGACY_DEVICE_DIRECTORY)), markers);
  assert.deepEqual(await snapshot(legacyDeviceHome), kept);

  const after = await verifySkillCopies({ home, deviceHome: device });
  assert.deepEqual([after.ok, after.reasonCode, after.legacyCopies], [true, "SKILL_COPIES_VERIFIED", []]);
  for (const root of HOST_ROOTS) assert.deepEqual(await readdir(join(home, ...root.split("/"))), [SKILL]);
  assert.deepEqual(await readdir(join(home, ".codex", "skills")), []);

  const again = await applyLegacySkillCleanup(plan, { backupRoot });
  assert.deepEqual([again.reasonCode, again.moved, again.absent], ["LEGACY_SKILL_CLEANUP_NOTHING_TO_MOVE", [], plan.items.map((item) => item.path)]);
  assert.deepEqual((await legacySkillCleanupPlan({ home, legacyDeviceHome })).items, []);
  assert.deepEqual((await legacySkillCleanupPlan({ home: join(base, "empty-home") })).items, []);
});

test("479-R5: a backup is never overwritten: a taken backup path refuses the cleanup before anything moves", async (context) => {
  const { device, home } = await scratch(context);
  const legacyDeviceHome = join(home, LEGACY_DEVICE_DIRECTORY);
  const copy = join(home, ".codex", "skills", LEGACY_HELPER_NAME);
  await writeTree(copy, { "SKILL.md": "legacy\n" });
  await writeTree(legacyDeviceHome, { "state.json": "{\"state\":2}\n" });
  const backupRoot = join(device, "backups", "20260926T170000Z", "legacy-skill-cleanup");
  await writeTree(backupRoot, { [`${LEGACY_DEVICE_DIRECTORY}/state.json`]: "an earlier backup\n" });

  const plan = await legacySkillCleanupPlan({ home, legacyDeviceHome });
  assert.deepEqual(plan.items.map((item) => item.path), [copy, join(legacyDeviceHome, "state.json")]);
  await assert.rejects(
    applyLegacySkillCleanup(plan, { backupRoot }),
    (error) => error instanceof SkillCopiesError && error.reasonCode === "LEGACY_SKILL_CLEANUP_BACKUP_EXISTS",
  );
  assert.deepEqual(await snapshot(copy), { "SKILL.md": "legacy\n" });
  assert.equal(await readFile(join(legacyDeviceHome, "state.json"), "utf8"), "{\"state\":2}\n");
  assert.deepEqual(await snapshot(backupRoot), { [`${LEGACY_DEVICE_DIRECTORY}/state.json`]: "an earlier backup\n" });

  const outside = { ...plan, items: [{ kind: "marker", path: join(dirname(home), "elsewhere.json"), entryType: "file", backupPath: "elsewhere.json" }] };
  await assert.rejects(
    applyLegacySkillCleanup(outside, { backupRoot }),
    (error) => error instanceof SkillCopiesError && error.reasonCode === "LEGACY_SKILL_CLEANUP_PLAN_INVALID",
  );
});
