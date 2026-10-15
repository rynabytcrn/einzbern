// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 (MIN-258 D3, MIN-259 D2): the skill's trash-empty tool, which the
// unattended-commands principle v2 names for emptying a session's trash once the Owner authorized it.
// Without --yes it only prints its plan; it refuses a name out of the scratch root, a symbolic link, a
// name that is not trash or trash-<name>, and a wildcard, and then deletes nothing at all; with --yes it
// empties only the directories it is named and keeps them. Every run here works in a temporary
// directory of its own, with a home of its own, and never on a real scratch directory.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, "..", "skill", "mana-orchestrate", "scripts", "trash-empty.mjs");

/** A scratch root with two trash directories to empty, one to keep, a kept evidence directory, and a directory outside. */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-trash-empty-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const root = join(base, "scratch");
  const outside = join(base, "outside");
  await mkdir(home);
  await mkdir(join(root, "r1", "trash", "copy", "nested"), { recursive: true });
  await writeFile(join(root, "r1", "trash", "copy", "nested", "a.txt"), "aaaa");
  await writeFile(join(root, "r1", "trash", "b.txt"), "bb");
  await mkdir(join(root, "trash-r2"));
  await writeFile(join(root, "trash-r2", "c.txt"), "ccc");
  await mkdir(join(root, "r3", "trash"), { recursive: true });
  await writeFile(join(root, "r3", "trash", "kept.txt"), "kept");
  await mkdir(join(root, "r1", "out"));
  await writeFile(join(root, "r1", "out", "evidence.txt"), "evidence");
  await mkdir(join(outside, "trash"), { recursive: true });
  await writeFile(join(outside, "trash", "outside.txt"), "outside");
  await writeFile(join(outside, "precious.txt"), "precious");
  return { base, home, root, outside };
}

/** The tool run with a home of the fixture's own; its JSON answer and exit code. */
async function run(paths, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: paths.home } });
    return { code: 0, answer: stdout.trim().startsWith("{") ? JSON.parse(stdout) : stdout.trim() };
  } catch (error) {
    return { code: error.code, answer: JSON.parse(String(error.stderr).trim().split("\n").at(-1)) };
  }
}

/** Every file the fixture made, with its text: what must still be there after a refusal or a plan. */
async function everyFile(paths) {
  const files = {};
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[path.slice(paths.base.length + 1)] = await readFile(path, "utf8");
    }
  };
  await walk(paths.base);
  return files;
}

test("541 (MIN-259 D2): without --yes the tool prints the plan, each named trash directory's real path, entries and bytes, and deletes nothing", async (context) => {
  const paths = await scratch(context);
  const before = await everyFile(paths);
  const planned = await run(paths, ["--scratch", paths.root, "r1/trash", "trash-r2"]);
  assert.equal(planned.code, 0);
  assert.equal(planned.answer.reasonCode, "TRASH_EMPTY_PLAN_READY");
  assert.equal(planned.answer.scratch, paths.root);
  assert.deepEqual(planned.answer.directories, [
    { name: "r1/trash", path: join(paths.root, "r1", "trash"), entries: 2, bytes: 6 },
    { name: "trash-r2", path: join(paths.root, "trash-r2"), entries: 1, bytes: 3 },
  ]);
  assert.equal(planned.answer.bytes, 9);
  assert.deepEqual(await everyFile(paths), before, "the plan deletes nothing");
});

test("541 (MIN-259 D2): a name out of the scratch root, a symbolic link, a name that is not trash and a wildcard are refused, and nothing is deleted even with --yes", async (context) => {
  const paths = await scratch(context);
  await symlink(join(paths.outside, "trash"), join(paths.root, "trash-link"));
  await symlink(paths.outside, join(paths.root, "via"));
  await mkdir(join(paths.root, "r4"));
  await writeFile(join(paths.root, "r4", "trash"), "a file, not a directory");
  await mkdir(join(paths.root, "trash-x", "inner", "trash"), { recursive: true });
  const before = await everyFile(paths);
  const cases = [
    ["via/trash", "outside-scratch-root"],
    ["../outside/trash", "segment-not-allowed"],
    ["r1/./trash", "segment-not-allowed"],
    [join(paths.outside, "trash"), "absolute-path"],
    ["trash-link", "symbolic-link"],
    ["r1/out", "name-not-trash"],
    ["trashcan", "name-not-trash"],
    ["trash-", "name-not-trash"],
    ["r*/trash", "wildcard"],
    ["trash-*", "wildcard"],
    ["r[13]/trash", "wildcard"],
    ["r9/trash", "missing"],
    ["r4/trash", "not-a-directory"],
  ];
  for (const [name, reason] of cases) {
    const refused = await run(paths, ["--scratch", paths.root, "r1/trash", name, "--yes"]);
    assert.equal(refused.code, 1, name);
    assert.equal(refused.answer.reasonCode, "TRASH_EMPTY_REFUSED", name);
    assert.equal(refused.answer.deleted, 0, name);
    assert.deepEqual(refused.answer.directories.map((item) => [item.name, item.refused]), [["r1/trash", null], [name, reason]], name);
  }
  for (const names of [["trash-x", "trash-x/inner/trash"], ["r1/trash", "r1/trash/"]]) {
    const overlapping = await run(paths, ["--scratch", paths.root, ...names, "--yes"]);
    assert.equal(overlapping.answer.reasonCode, "TRASH_EMPTY_REFUSED", names.join(" "));
    assert.deepEqual(overlapping.answer.directories.map((item) => item.refused), ["overlaps-another", "overlaps-another"], names.join(" "));
  }
  assert.deepEqual(await everyFile(paths), before, "no refusal deletes anything, in the scratch root or outside it");
});

test("541 (MIN-259 D2): the scratch root may not be the filesystem root, the home or a directory above the home", async (context) => {
  const paths = await scratch(context);
  const before = await everyFile(paths);
  for (const [root, name, reason] of [
    [parse(paths.root).root, "trash", "filesystem-root"],
    [paths.home, "trash", "home-or-above"],
    [paths.base, "scratch/r1/trash", "home-or-above"],
    [join(paths.base, "nowhere"), "trash", "missing"],
  ]) {
    const refused = await run(paths, ["--scratch", root, name, "--yes"]);
    assert.equal(refused.code, 1, root);
    assert.deepEqual([refused.answer.reasonCode, refused.answer.reason], ["TRASH_EMPTY_SCRATCH_ROOT_REFUSED", reason], root);
  }
  assert.deepEqual(await everyFile(paths), before);
});

test("541 (MIN-259 D2): with --yes the tool empties only the named trash directories, keeps them, and its receipt counts what it deleted", async (context) => {
  const paths = await scratch(context);
  await symlink(join(paths.outside, "precious.txt"), join(paths.root, "r1", "trash", "link-to-precious"));
  const before = await everyFile(paths);
  const emptied = await run(paths, ["--scratch", paths.root, "r1/trash", "trash-r2", "--yes"]);
  assert.equal(emptied.code, 0);
  assert.equal(emptied.answer.reasonCode, "TRASH_EMPTIED");
  assert.deepEqual(emptied.answer.directories.map((item) => [item.name, item.path, item.entries, item.deleted, item.failed]), [
    ["r1/trash", join(paths.root, "r1", "trash"), 3, 3, []],
    ["trash-r2", join(paths.root, "trash-r2"), 1, 1, []],
  ]);
  assert.ok(emptied.answer.directories[0].bytes >= 6 && emptied.answer.directories[1].bytes === 3);
  assert.deepEqual(await readdir(join(paths.root, "r1", "trash")), [], "the named directory stays, empty");
  assert.deepEqual(await readdir(join(paths.root, "trash-r2")), []);
  const expected = Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith("scratch/r1/trash/") && !path.startsWith("scratch/trash-r2/")));
  assert.deepEqual(await everyFile(paths), expected, "only what the named directories held is gone");
  assert.equal(await readFile(join(paths.outside, "precious.txt"), "utf8"), "precious", "a link in the trash goes, not what it points to");
  assert.equal(await readFile(join(paths.root, "r3", "trash", "kept.txt"), "utf8"), "kept", "a trash directory it was not named keeps its contents");
});

test("541 (MIN-259 D2): the tool answers usage for a missing scratch root, an unknown flag or no name, and imports node: built-ins only", async (context) => {
  const paths = await scratch(context);
  for (const args of [["r1/trash"], ["--scratch", paths.root], ["--scratch", paths.root, "r1/trash", "--all"], ["--scratch"]]) {
    const refused = await run(paths, args);
    assert.deepEqual([refused.code, refused.answer.reasonCode], [1, "TRASH_EMPTY_USAGE"], args.join(" "));
  }
  const help = await run(paths, ["--help"]);
  assert.deepEqual([help.code, help.answer], [0, "usage: node trash-empty.mjs --scratch <scratch root> <trash directory>... [--yes]"]);
  const source = await readFile(SCRIPT, "utf8");
  const specifiers = [...source.matchAll(/^import [^"]+"([^"]+)";$/gmu)].map((match) => match[1]);
  assert.ok(specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("node:")), specifiers.join(", "));
});
