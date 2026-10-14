// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 GWT4 (MIN-258 D3; TCRN-CROSS-SUB-512; r7 Q8): device-clean lists the stagings in
// the device directory's trash/ and the entries of its backups/, each with its size and the reason it
// is kept or cleared, and writes nothing; with --yes true it deletes only what the plan clears. Kept
// always: the pre-update backups of the current and the previous engine version (engine/current) and
// the stagings of the current version. TCRN-CROSS-SUB-519 (J7-07): any other entry of backups/ is
// judged by what it holds one level down, listed as its contents; only one that holds the skill copies
// alone is cleared, and one that holds an original a write replaced, or anything else, is kept. A
// symbolic link, or an area that leads out of the device directory, is refused and never touched.
// Every device directory here is a temporary one, reached through --home as the machine-settings verbs
// take it.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";

const AT = "2026-10-14T15:00:00Z";

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

const STAGINGS = {
  install202: "install-2026-10-10T123314Z-tmp-4a9b87f674190654",
  install203: "install-2026-10-14T014958Z-tmp-855c06bde833febf",
  update210: "setup-update-20261014T132031Z",
  updateUnknown: "setup-update-20261013T000000Z",
};
// Named and laid out, one level down, as the backups/ of the machine J7-07 was judged on after its
// 2.1.0 update.
const BACKUPS = {
  codexRebuild: "2026-10-02T17-04-23-006Z",
  stamp: "20261002T170423Z",
  oldEngine: "20261010T020830Z-o10-old-engine-1.2.1",
  pre201: "20261010T021653Z-o5-pre-update-2.0.1",
  pre202: "20261010T123302Z-r55-pre-update-2.0.2",
  pre203: "20261014T014958Z-pre-update-2.0.3",
  pre210: "20261014T132027Z-pre-update-2.1.0",
  update210: "20261014T132031Z",
};

/**
 * A user's home whose .einzbern has 2.1.0 current and 2.0.3 before it, the stagings an install and an
 * update leave in trash/ (one of an unknown version), an entry of trash/ that is no staging, and the
 * backups this machine holds: a rebuild of Codex hooks, the hook files' originals, an old engine, four
 * pre-update backups and the skill copies the 2.1.0 update replaced; outside it, a file a staging links
 * to.
 */
async function device(context, { previous = "2.0.3" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-device-clean-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const deviceHome = join(home, ".einzbern");
  const put = async (relative, text) => {
    const path = join(deviceHome, ...relative.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await put("engine/current", JSON.stringify({ schemaVersion: "einzbern.engine-current.v1", version: "2.1.0", previous, switchedAt: "2026-10-14T13:20:31Z" }));
  await put(`trash/${STAGINGS.install202}/einzbern-2.0.2/scripts/einzbern.mjs`, "export {};\n");
  await put(`trash/${STAGINGS.install202}/manifest.json`, "{}\n");
  await put(`trash/${STAGINGS.install203}/einzbern-2.0.3/scripts/einzbern.mjs`, "export const v = 3;\n");
  await put(`trash/${STAGINGS.update210}/einzbern-2.1.0/scripts/einzbern.mjs`, "export const v = 10;\n");
  await put(`trash/${STAGINGS.update210}/manifest.json`, "{}\n");
  await put(`trash/${STAGINGS.updateUnknown}/partial.txt`, "half an unpack\n");
  await put("trash/notes/keep.txt", "the user's own\n");
  await put(`backups/${BACKUPS.codexRebuild}/codex-hooks-rebuild/hooks.json`, "{}\n");
  await put(`backups/${BACKUPS.stamp}/host-hooks/5d41402abc4b2a76/.codex/hooks.json`, "{\"hooks\":{}}\n");
  await put(`backups/${BACKUPS.stamp}/host-hooks/5d41402abc4b2a76/.codex/config.toml`, "model = \"o\"\n");
  await put(`backups/${BACKUPS.oldEngine}/einzbern.mjs`, "export {};\n");
  for (const name of [BACKUPS.pre201, BACKUPS.pre202, BACKUPS.pre203, BACKUPS.pre210]) await put(`backups/${name}/engine/current`, "{}\n");
  for (const host of [".agents", ".claude"]) await put(`backups/${BACKUPS.update210}/skill-copies/${host}/skills/mana-orchestrate/SKILL.md`, "# skill\n");
  // A staging that links out of the device directory: the link goes with it, never what it names.
  const outside = join(base, "outside.txt");
  await writeFile(outside, "not the device's\n");
  await symlink(outside, join(deviceHome, "trash", STAGINGS.install202, "linked-out"));
  return { base, home, deviceHome, outside };
}

// Every path under `root`, with what it is: dir, link, or a file's size; links are not followed.
async function tree(root) {
  const found = [];
  const walk = async (directory, prefix) => {
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
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      found.push(`${name}:${stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : String(stats.size)}`);
      if (stats.isDirectory() && !stats.isSymbolicLink()) await walk(path, name);
    }
  };
  await walk(root, "");
  return found;
}

const named = (entries) => entries.map((entry) => [entry.area, entry.name, entry.reason]);
const clean = (fx, ...more) => ["device-clean", "--at", AT, "--home", fx.home, ...more];

test("541 GWT4: device-clean is a cataloged write of the device directory: --at required, --yes and --home optional", () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === "device-clean");
  assert.equal(entry?.mutates, true);
  assert.deepEqual(entry.flags.map((flag) => [flag.name, flag.required, flag.valueKind]), [["at", true, "instant"], ["yes", false, "boolean"], ["home", false, "string"]]);
});

test("541 GWT4: without --yes true device-clean lists what it would clear and keep, with sizes and reasons, and writes nothing", async (context) => {
  const fx = await device(context);
  const before = await tree(fx.home);
  const plan = await cli(clean(fx));
  assert.equal(plan.reasonCode, "DEVICE_CLEAN_PLAN_READY");
  assert.equal(plan.schemaVersion, "einzbern.device-clean-plan.v1");
  assert.deepEqual([plan.deviceHome, plan.at, plan.engine], [fx.deviceHome, AT, { current: "2.1.0", previous: "2.0.3" }]);
  assert.deepEqual(named(plan.keep), [
    ["trash", "notes", "not-a-staging"],
    ["trash", STAGINGS.update210, "current-version-staging"],
    ["backups", BACKUPS.codexRebuild, "unrecognised-backup"],
    ["backups", BACKUPS.stamp, "holds-originals"],
    ["backups", BACKUPS.oldEngine, "unrecognised-backup"],
    ["backups", BACKUPS.pre203, "pre-update-backup-of-previous"],
    ["backups", BACKUPS.pre210, "pre-update-backup-of-current"],
  ]);
  assert.deepEqual(named(plan.remove), [
    ["trash", STAGINGS.install202, "older-version-staging"],
    ["trash", STAGINGS.install203, "older-version-staging"],
    ["trash", STAGINGS.updateUnknown, "unknown-version-staging"],
    ["backups", BACKUPS.pre201, "older-pre-update-backup"],
    ["backups", BACKUPS.pre202, "older-pre-update-backup"],
    ["backups", BACKUPS.update210, "skill-copies-backup"],
  ]);
  assert.deepEqual(plan.refused, []);
  // SUB-519: every entry of backups/ names what it holds one level down; trash/ entries name nothing.
  assert.deepEqual([...plan.keep, ...plan.remove].filter((entry) => entry.area === "backups").map((entry) => [entry.name, entry.kind, entry.contents]), [
    [BACKUPS.codexRebuild, "backup", ["codex-hooks-rebuild"]],
    [BACKUPS.stamp, "backup", ["host-hooks"]],
    [BACKUPS.oldEngine, "backup", ["einzbern.mjs"]],
    [BACKUPS.pre203, "pre-update-backup", ["engine"]],
    [BACKUPS.pre210, "pre-update-backup", ["engine"]],
    [BACKUPS.pre201, "pre-update-backup", ["engine"]],
    [BACKUPS.pre202, "pre-update-backup", ["engine"]],
    [BACKUPS.update210, "backup", ["skill-copies"]],
  ]);
  assert.equal([...plan.keep, ...plan.remove].some((entry) => entry.area === "trash" && "contents" in entry), false);
  const install202 = plan.remove[0];
  assert.deepEqual([install202.kind, install202.version, install202.path], ["install-staging", "2.0.2", join(fx.deviceHome, "trash", STAGINGS.install202)]);
  assert.equal(install202.bytes, "export {};\n".length + "{}\n".length + (await lstat(join(fx.deviceHome, "trash", STAGINGS.install202, "linked-out"))).size, "files and the link itself, the link not followed");
  assert.equal(plan.removeBytes, plan.remove.reduce((total, entry) => total + entry.bytes, 0));
  assert.ok(plan.remove.every((entry) => entry.bytes > 0));
  assert.deepEqual(await tree(fx.home), before, "a plan writes nothing");
});

test("541 GWT4: with --yes true it deletes only the entries the plan clears, names each with its size, and keeps the rest", async (context) => {
  const fx = await device(context);
  const plan = await cli(clean(fx));
  const done = await cli(clean(fx, "--yes", "true"));
  assert.equal(done.reasonCode, "DEVICE_CLEANED");
  assert.deepEqual(done.removed, plan.remove.map((entry) => ({ path: entry.path, bytes: entry.bytes })));
  assert.deepEqual(done.failed, []);
  assert.deepEqual(await readdir(join(fx.deviceHome, "trash")).then((names) => names.sort()), ["notes", STAGINGS.update210].sort());
  assert.deepEqual(await readdir(join(fx.deviceHome, "backups")).then((names) => names.sort()), [BACKUPS.codexRebuild, BACKUPS.stamp, BACKUPS.oldEngine, BACKUPS.pre203, BACKUPS.pre210].sort());
  assert.equal(await readFile(join(fx.deviceHome, "backups", BACKUPS.stamp, "host-hooks", "5d41402abc4b2a76", ".codex", "hooks.json"), "utf8"), "{\"hooks\":{}}\n", "the hook files' originals stay");
  assert.equal(await readFile(join(fx.deviceHome, "trash", "notes", "keep.txt"), "utf8"), "the user's own\n");
  assert.equal(await readFile(fx.outside, "utf8"), "not the device's\n", "the file a cleared staging linked to is still there");
  assert.equal(await readFile(join(fx.deviceHome, "engine", "current"), "utf8").then((text) => JSON.parse(text).version), "2.1.0", "engine/ is never touched");
  // A second run finds nothing more to clear.
  const again = await cli(clean(fx, "--yes", "true"));
  assert.deepEqual([again.remove, again.removed, again.failed], [[], [], []]);
});

test("541 GWT4: with no previous version only the current version's pre-update backup is kept", async (context) => {
  const fx = await device(context, { previous: null });
  const plan = await cli(clean(fx));
  assert.deepEqual(plan.keep.filter((entry) => entry.kind === "pre-update-backup").map((entry) => entry.name), [BACKUPS.pre210]);
  assert.ok(plan.remove.some((entry) => entry.name === BACKUPS.pre203 && entry.reason === "older-pre-update-backup"));
});

test("541 GWT4 (SUB-519): a backup is cleared only when it holds the skill copies alone; one that holds an original, or anything device-clean does not know, is kept with its contents", async (context) => {
  const fx = await device(context);
  const put = async (relative, text) => {
    const path = join(fx.deviceHome, "backups", ...relative.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const more = {
    crestBodies: "20261015T010000Z",
    writableRoots: "20261015T010001Z",
    managedSections: "20261015T010002Z",
    unregister: "20261015T010003Z-library-unregister",
    mixed: "20261015T010004Z",
    empty: "20261015T010005Z",
    file: "20261015T010006Z",
    skillAndOther: "20261015T010007Z",
    linkedSkill: "20261015T010008Z",
  };
  await put(`${more.crestBodies}/crest-bodies/library-0123456789abcdef/0001.body`, "the only copy of a body\n");
  await put(`${more.writableRoots}/writable-roots/9a0b1c2d3e4f5a6b/settings.json`, "{}\n");
  await put(`${more.managedSections}/managed-sections/7c8d9e0f1a2b3c4d/AGENTS.md`, "# the project's own\n");
  await put(`${more.unregister}/registry.json`, "{\"entries\":[]}\n");
  await put(`${more.mixed}/skill-copies/.claude/skills/mana-orchestrate/SKILL.md`, "# skill\n");
  await put(`${more.mixed}/host-hooks/5d41402abc4b2a76/.claude/settings.json`, "{}\n");
  await mkdir(join(fx.deviceHome, "backups", more.empty));
  await writeFile(join(fx.deviceHome, "backups", more.file), "a file, no directory\n");
  await put(`${more.skillAndOther}/skill-copies/.agents/skills/mana-orchestrate/SKILL.md`, "# skill\n");
  await put(`${more.skillAndOther}/notes.txt`, "something else\n");
  // skill-copies that is a link: lstat finds no directory, and the link is not followed.
  const linkedTo = join(fx.base, "skill-copies-elsewhere");
  await mkdir(linkedTo);
  await writeFile(join(linkedTo, "SKILL.md"), "# not the device's\n");
  await mkdir(join(fx.deviceHome, "backups", more.linkedSkill));
  await symlink(linkedTo, join(fx.deviceHome, "backups", more.linkedSkill, "skill-copies"));

  const plan = await cli(clean(fx));
  const added = new Set(Object.values(more));
  const judged = (entries) => entries.filter((entry) => added.has(entry.name)).map((entry) => [entry.name, entry.kind, entry.reason, entry.contents]);
  assert.deepEqual(judged(plan.keep), [
    [more.crestBodies, "backup", "holds-originals", ["crest-bodies"]],
    [more.writableRoots, "backup", "holds-originals", ["writable-roots"]],
    [more.managedSections, "backup", "holds-originals", ["managed-sections"]],
    [more.unregister, "backup", "holds-originals", ["registry.json"]],
    [more.mixed, "backup", "holds-originals", ["host-hooks", "skill-copies"]],
    [more.empty, "backup", "unrecognised-backup", []],
    [more.file, "backup", "unrecognised-backup", []],
    [more.skillAndOther, "backup", "unrecognised-backup", ["notes.txt", "skill-copies"]],
    [more.linkedSkill, "backup", "unrecognised-backup", ["skill-copies"]],
  ]);
  assert.deepEqual(judged(plan.remove), []);
  assert.deepEqual(plan.remove.filter((entry) => entry.area === "backups").map((entry) => [entry.name, entry.reason]), [
    [BACKUPS.pre201, "older-pre-update-backup"],
    [BACKUPS.pre202, "older-pre-update-backup"],
    [BACKUPS.update210, "skill-copies-backup"],
  ]);

  const done = await cli(clean(fx, "--yes", "true"));
  assert.deepEqual(done.removed, plan.remove.map((entry) => ({ path: entry.path, bytes: entry.bytes })));
  assert.deepEqual(done.failed, []);
  const left = new Set(await readdir(join(fx.deviceHome, "backups")));
  assert.deepEqual([...added].filter((name) => !left.has(name)), [], "every backup the plan keeps is still there");
  assert.equal(await readFile(join(fx.deviceHome, "backups", more.crestBodies, "crest-bodies", "library-0123456789abcdef", "0001.body"), "utf8"), "the only copy of a body\n");
  assert.equal(await readFile(join(fx.deviceHome, "backups", more.unregister, "registry.json"), "utf8"), "{\"entries\":[]}\n");
  assert.equal(await readFile(join(linkedTo, "SKILL.md"), "utf8"), "# not the device's\n", "what a link in a backup names is never touched");
});

test("541 GWT4: a symbolic link in trash/ and a backups/ that leads out of the device directory are refused and never touched", async (context) => {
  const fx = await device(context);
  const precious = join(fx.base, "precious");
  await mkdir(precious);
  await writeFile(join(precious, "data.txt"), "precious\n");
  const link = join(fx.deviceHome, "trash", "install-2026-01-01T000000Z-tmp-0000000000000000");
  await symlink(precious, link);
  // backups/ itself moved out and linked back: every entry under it would be outside the device directory.
  const elsewhere = join(fx.base, "elsewhere");
  await rename(join(fx.deviceHome, "backups"), elsewhere);
  await symlink(elsewhere, join(fx.deviceHome, "backups"));
  const elsewhereBefore = await tree(elsewhere);

  const plan = await cli(clean(fx));
  assert.deepEqual(named(plan.refused), [["trash", "install-2026-01-01T000000Z-tmp-0000000000000000", "symbolic-link"], ["backups", "backups", "symbolic-link"]]);
  assert.equal(plan.remove.some((entry) => entry.area === "backups" || entry.path === link), false);
  const done = await cli(clean(fx, "--yes", "true"));
  assert.deepEqual(done.failed, []);
  assert.equal((await lstat(link)).isSymbolicLink(), true, "the link stays");
  assert.equal(await readFile(join(precious, "data.txt"), "utf8"), "precious\n", "what it names stays");
  assert.deepEqual(await tree(elsewhere), elsewhereBefore, "nothing under the linked backups/ is touched");
  assert.equal((await lstat(join(fx.deviceHome, "backups"))).isSymbolicLink(), true);
});

test("541 GWT4: without engine/current nothing is judged: DEVICE_CLEAN_ENGINE_UNKNOWN, and nothing is written", async (context) => {
  const fx = await device(context);
  await rm(join(fx.deviceHome, "engine", "current"));
  const before = await tree(fx.home);
  for (const args of [clean(fx), clean(fx, "--yes", "true")]) {
    const refused = await refusal(args);
    assert.equal(refused.reasonCode, "DEVICE_CLEAN_ENGINE_UNKNOWN");
  }
  assert.deepEqual(await tree(fx.home), before);
  assert.equal((await refusal(["device-clean", "--home", fx.home])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(clean(fx, "--yes", "sure"))).reasonCode, "CLI_ARGUMENT_MALFORMED");
});
