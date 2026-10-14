// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 GWT4 (MIN-258 D3; TCRN-CROSS-SUB-512; r7 Q8): device-clean lists the stagings in
// the device directory's trash/ and the entries of its backups/, each with its size and the reason it
// is kept or cleared, and writes nothing; with --yes true it deletes only what the plan clears. Kept
// always: the pre-update backups of the current and the previous engine version (engine/current) and
// the stagings of the current version. A symbolic link, or an area that leads out of the device
// directory, is refused and never touched. Every device directory here is a temporary one, reached
// through --home as the machine-settings verbs take it.

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
const BACKUPS = {
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
 * backups of earlier updates; outside it, a file a staging links to.
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
  await put(`backups/${BACKUPS.stamp}/host-hooks/settings.json`, "{}\n");
  await put(`backups/${BACKUPS.oldEngine}/einzbern.mjs`, "export {};\n");
  for (const name of [BACKUPS.pre201, BACKUPS.pre202, BACKUPS.pre203, BACKUPS.pre210]) await put(`backups/${name}/engine/current`, "{}\n");
  await put(`backups/${BACKUPS.update210}/skill-copies/SKILL.md`, "# skill\n");
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
    ["backups", BACKUPS.pre203, "pre-update-backup-of-previous"],
    ["backups", BACKUPS.pre210, "pre-update-backup-of-current"],
  ]);
  assert.deepEqual(named(plan.remove), [
    ["trash", STAGINGS.install202, "older-version-staging"],
    ["trash", STAGINGS.install203, "older-version-staging"],
    ["trash", STAGINGS.updateUnknown, "unknown-version-staging"],
    ["backups", BACKUPS.stamp, "other-backup"],
    ["backups", BACKUPS.oldEngine, "other-backup"],
    ["backups", BACKUPS.pre201, "older-pre-update-backup"],
    ["backups", BACKUPS.pre202, "older-pre-update-backup"],
    ["backups", BACKUPS.update210, "other-backup"],
  ]);
  assert.deepEqual(plan.refused, []);
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
  assert.deepEqual(await readdir(join(fx.deviceHome, "backups")).then((names) => names.sort()), [BACKUPS.pre203, BACKUPS.pre210].sort());
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
  assert.deepEqual(plan.keep.filter((entry) => entry.area === "backups").map((entry) => entry.name), [BACKUPS.pre210]);
  assert.ok(plan.remove.some((entry) => entry.name === BACKUPS.pre203 && entry.reason === "older-pre-update-backup"));
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
