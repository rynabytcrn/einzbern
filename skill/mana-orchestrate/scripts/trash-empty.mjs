#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 (MIN-258 D3, MIN-259 D2): the trash-empty tool of the unattended-commands
// principle v2. In an unattended session rm and rmdir raise a confirmation dialog, so whatever is to
// go is first moved into a trash directory under the session's scratch directory. Once the Owner has
// authorized it, this tool empties the trash directories it is named, and nothing else:
//
//   node trash-empty.mjs --scratch <scratch root> <trash directory>... [--yes]
//
// 1. Each <trash directory> is a path relative to the scratch root, taken as it is written. A
//    wildcard (* ? [ ] { }) is refused, never expanded, and so is an absolute path or a segment that
//    is empty, "." or "..".
// 2. Each is checked one by one: its last segment is trash or trash-<name>; it is a directory and not
//    a symbolic link; its real path lies inside the real path of the scratch root and still ends in
//    that name. No two named directories may be the same or lie one inside the other.
// 3. The scratch root is an existing directory, and neither the filesystem root nor the user's home
//    nor a directory above the home.
// 4. Without --yes the tool prints its plan and deletes nothing (TRASH_EMPTY_PLAN_READY): each
//    directory's real path, how many entries it holds, and their size in bytes, counted without
//    following a link. With --yes it checks each directory again, deletes the entries it holds,
//    keeps the directory itself, and prints the receipt (TRASH_EMPTIED): how many entries of each it
//    deleted, and each one it could not (failed, TRASH_EMPTY_INCOMPLETE).
// 5. When any named directory is refused, nothing at all is deleted (TRASH_EMPTY_REFUSED).
//
// The plan goes to the Owner before --yes: each authorization covers one report that lists the paths
// and sizes, answered once by the Owner. Prints {"ok":true,"reasonCode":...} on stdout, or a reason
// code and its details on stderr with exit code 1. Imports node: built-ins only.

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";

const USAGE = "usage: node trash-empty.mjs --scratch <scratch root> <trash directory>... [--yes]";
const TRASH_NAME = /^trash(?:-.+)?$/u;
const WILDCARD = /[*?[\]{}]/u;
const SEPARATORS = /[\\/]/u;

class Refusal extends Error {
  constructor(reasonCode, details) {
    super(reasonCode);
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function parseArguments(argv) {
  let scratch = null;
  let yes = false;
  const names = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--yes") {
      yes = true;
    } else if (argument === "--scratch") {
      if (scratch !== null || index + 1 >= argv.length) throw new Refusal("TRASH_EMPTY_USAGE", { usage: USAGE });
      index += 1;
      scratch = argv[index];
    } else if (argument.startsWith("-")) {
      throw new Refusal("TRASH_EMPTY_USAGE", { usage: USAGE, unknown: argument });
    } else {
      names.push(argument);
    }
  }
  if (scratch === null || scratch === "" || names.length === 0) throw new Refusal("TRASH_EMPTY_USAGE", { usage: USAGE });
  return { help: false, scratch, yes, names };
}

const inside = (parent, child) => child !== parent && child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

async function realOrResolved(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** The real path of the scratch root, or a refusal when it cannot hold a session's trash. */
async function scratchRoot(given) {
  let root;
  try {
    root = await realpath(resolve(given));
  } catch {
    throw new Refusal("TRASH_EMPTY_SCRATCH_ROOT_REFUSED", { scratch: given, reason: "missing" });
  }
  if (!(await lstat(root)).isDirectory()) throw new Refusal("TRASH_EMPTY_SCRATCH_ROOT_REFUSED", { scratch: root, reason: "not-a-directory" });
  if (parse(root).root === root) throw new Refusal("TRASH_EMPTY_SCRATCH_ROOT_REFUSED", { scratch: root, reason: "filesystem-root" });
  const home = await realOrResolved(homedir());
  if (home === root || inside(root, home)) throw new Refusal("TRASH_EMPTY_SCRATCH_ROOT_REFUSED", { scratch: root, reason: "home-or-above" });
  return root;
}

/** Why a name, as it is written, can never name a trash directory; null when it can. */
function nameRefusal(name) {
  if (WILDCARD.test(name)) return "wildcard";
  if (isAbsolute(name)) return "absolute-path";
  const segments = name.replace(/[\\/]+$/u, "").split(SEPARATORS);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "segment-not-allowed";
  if (!TRASH_NAME.test(segments.at(-1))) return "name-not-trash";
  return null;
}

/** One named directory, checked: its real path, or why it is refused. */
async function check(root, name) {
  const written = nameRefusal(name);
  if (written !== null) return { name, path: null, refused: written };
  // Without its trailing separators, so that a link the name ends in is seen as the link itself.
  const path = join(root, name.replace(/[\\/]+$/u, ""));
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return { name, path, refused: "missing" };
  }
  if (stat.isSymbolicLink()) return { name, path, refused: "symbolic-link" };
  if (!stat.isDirectory()) return { name, path, refused: "not-a-directory" };
  const real = await realOrResolved(path);
  if (!inside(root, real)) return { name, path: real, refused: "outside-scratch-root" };
  if (!TRASH_NAME.test(basename(real))) return { name, path: real, refused: "name-not-trash" };
  return { name, path: real, refused: null };
}

/** How many entries a directory holds and their size in bytes, without following a link. */
async function measure(directory) {
  let bytes = 0;
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const stat = await lstat(child);
      if (stat.isDirectory()) await walk(child);
      else bytes += stat.size;
    }
  };
  await walk(directory);
  return { entries: (await readdir(directory)).length, bytes };
}

/** Every named directory checked; two that are the same or lie one inside the other are both refused. */
async function plan(root, names) {
  const checked = [];
  for (const name of names) checked.push(await check(root, name));
  const accepted = checked.filter((item) => item.refused === null);
  const overlapping = accepted.filter((item) => accepted.some((other) => other !== item
    && (other.path === item.path || inside(other.path, item.path) || inside(item.path, other.path))));
  for (const item of overlapping) item.refused = "overlaps-another";
  return checked;
}

async function emptyDirectory(root, item) {
  const again = await check(root, item.name);
  if (again.refused !== null || again.path !== item.path) {
    return { ...item, deleted: 0, failed: [{ entry: null, reason: again.refused ?? "changed-since-the-plan" }] };
  }
  let deleted = 0;
  const failed = [];
  for (const entry of await readdir(item.path)) {
    try {
      await rm(join(item.path, entry), { recursive: true, force: false });
      deleted += 1;
    } catch (error) {
      failed.push({ entry, reason: error?.code ?? "unknown" });
    }
  }
  return { ...item, deleted, failed };
}

function answer(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = await scratchRoot(parsed.scratch);
  const checked = await plan(root, parsed.names);
  if (checked.some((item) => item.refused !== null)) {
    answer(process.stderr, { ok: false, reasonCode: "TRASH_EMPTY_REFUSED", scratch: root, deleted: 0, directories: checked });
    return 1;
  }
  const directories = [];
  for (const item of checked) directories.push({ name: item.name, path: item.path, ...(await measure(item.path)) });
  const bytes = directories.reduce((sum, item) => sum + item.bytes, 0);
  if (!parsed.yes) {
    answer(process.stdout, { ok: true, reasonCode: "TRASH_EMPTY_PLAN_READY", scratch: root, bytes, directories, next: "run the same command with --yes once the Owner has authorized this plan" });
    return 0;
  }
  const emptied = [];
  for (const item of directories) emptied.push(await emptyDirectory(root, item));
  const complete = emptied.every((item) => item.failed.length === 0);
  answer(complete ? process.stdout : process.stderr, { ok: complete, reasonCode: complete ? "TRASH_EMPTIED" : "TRASH_EMPTY_INCOMPLETE", scratch: root, bytes, directories: emptied });
  return complete ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  if (error instanceof Refusal) answer(process.stderr, { ok: false, reasonCode: error.reasonCode, ...error.details });
  else answer(process.stderr, { ok: false, reasonCode: "TRASH_EMPTY_FAILED", message: String(error?.message ?? error) });
  process.exitCode = 1;
});
