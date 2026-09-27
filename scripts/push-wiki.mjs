// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-STORY-487 R3 (TCRN-CROSS-SUB-352): publish docs/wiki to the project's Wiki. A GitHub
// Wiki is a Git repository of its own. Its pages are edited in this repository, under docs/wiki,
// and never on the web, so the source directory is the whole of the Wiki: this script mirrors it
// into a local working tree of the Wiki repository (--wiki-dir), copying every file of the source,
// including Home.md when present, and removing every tracked file the source no longer has. It
// commits the result there.
//
// That is all it does unless it is told otherwise. By default it is a rehearsal: it syncs, commits
// in the local working tree and prints the commits a push would send, and it pushes nothing. Only
// `--execute push` runs git push, to the branch the working tree tracks; a push is a publication,
// made once the Owner has authorised it (TCRN-CROSS-SUB-354).
//
// Usage:
//   node scripts/push-wiki.mjs --wiki-dir <Wiki working tree> [--source <directory>] [--execute push]
//
// --source defaults to this repository's docs/wiki; a relative path is taken from the current
// directory. The Wiki working tree must be the top of a Git working tree that is neither this
// repository nor holds the source, with nothing uncommitted and a branch that tracks a remote
// branch. The source must hold at least one file, regular files only; names that begin with a
// dot are not pages and are skipped. Every git call is `git -C <Wiki working tree> ...`, run
// without a shell, and the commit takes the identity git is configured with there. The receipt
// is one JSON line on stdout; a refusal is one JSON line on stderr and exit code 1.

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = ["--wiki-dir", "--source", "--execute"];
// A git hook exports these for the repository it runs in; left in place they would point every
// `git -C <Wiki working tree>` call back at that repository.
const GIT_LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];
const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARIABLES.includes(name)));

class PushWikiError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function refuse(reasonCode, message, details = {}) {
  throw new PushWikiError(reasonCode, message, details);
}

function parseFlags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag)) refuse("PUSH_WIKI_ARGUMENT_INVALID", `unknown argument ${JSON.stringify(flag)}; the flags are ${FLAGS.join(", ")}`, { flag: String(flag) });
    if (value === undefined || value === "" || value.startsWith("--")) refuse("PUSH_WIKI_ARGUMENT_INVALID", `${flag} needs a value`, { flag });
    if (Object.hasOwn(values, flag)) refuse("PUSH_WIKI_ARGUMENT_INVALID", `${flag} is given twice`, { flag });
    values[flag] = value;
  }
  if (values["--wiki-dir"] === undefined) refuse("PUSH_WIKI_ARGUMENT_MISSING", "--wiki-dir names the local working tree of the Wiki repository", { flag: "--wiki-dir" });
  if (values["--execute"] !== undefined && values["--execute"] !== "push") {
    refuse("PUSH_WIKI_ARGUMENT_INVALID", "--execute takes push and nothing else; without it the script only rehearses", { flag: "--execute" });
  }
  return {
    wikiDir: resolve(values["--wiki-dir"]),
    source: resolve(values["--source"] ?? join(repositoryRoot, "docs", "wiki")),
    push: values["--execute"] === "push",
  };
}

function git(directory, args) {
  try {
    return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnvironment });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    refuse("PUSH_WIKI_GIT_FAILED", `git ${args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`, { command: `git ${args[0]}` });
  }
}

// Whether `inner` is `outer` or lies inside it.
function within(inner, outer) {
  const path = relative(outer, inner);
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep) && resolve(outer, path) === inner);
}

// The source's files as forward-slash paths relative to it, sorted; dot-names are skipped.
function sourceFiles(source) {
  let stats;
  try {
    stats = lstatSync(source);
  } catch {
    refuse("PUSH_WIKI_SOURCE_INVALID", `the source ${source} does not exist`, { source });
  }
  if (!stats.isDirectory()) refuse("PUSH_WIKI_SOURCE_INVALID", `the source ${source} is not a directory`, { source });
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(source, path).split(sep).join("/"));
      else refuse("PUSH_WIKI_SOURCE_INVALID", `${path} is neither a file nor a directory; the Wiki holds regular files only`, { path: relative(source, path) });
    }
  };
  walk(source);
  if (files.length === 0) refuse("PUSH_WIKI_SOURCE_EMPTY", `the source ${source} holds no page; mirroring it would empty the Wiki`, { source });
  return files;
}

function sameBytes(path, bytes) {
  try {
    return readFileSync(path).equals(bytes);
  } catch {
    return false;
  }
}

function main() {
  const options = parseFlags(process.argv.slice(2));
  const files = sourceFiles(options.source);
  const source = realpathSync(options.source);

  let top;
  try {
    top = realpathSync(git(options.wikiDir, ["rev-parse", "--show-toplevel"]).trim());
  } catch (error) {
    if (error instanceof PushWikiError) refuse("PUSH_WIKI_NOT_A_WORKING_TREE", `${options.wikiDir} is not a Git working tree`, { wikiDir: options.wikiDir });
    throw error;
  }
  if (top !== realpathSync(options.wikiDir)) {
    refuse("PUSH_WIKI_NOT_A_WORKING_TREE", `${options.wikiDir} is inside the working tree ${top}; name the top of the Wiki's working tree`, { wikiDir: options.wikiDir });
  }
  if (within(top, realpathSync(repositoryRoot)) || within(realpathSync(repositoryRoot), top) || within(source, top)) {
    refuse("PUSH_WIKI_TARGET_INVALID", `${top} is not a Wiki working tree apart from this repository and the source`, { wikiDir: top });
  }
  if (git(top, ["status", "--porcelain", "--untracked-files=all"]).trim() !== "") {
    refuse("PUSH_WIKI_WORKING_TREE_DIRTY", `${top} has uncommitted changes; the Wiki working tree must be clean before it is synced`, { wikiDir: top });
  }
  let upstream;
  try {
    upstream = git(top, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim();
  } catch (error) {
    if (error instanceof PushWikiError) refuse("PUSH_WIKI_NO_UPSTREAM", `the branch of ${top} tracks no remote branch to push to`, { wikiDir: top });
    throw error;
  }

  // Mirror the source into the working tree.
  const tracked = git(top, ["ls-files", "-z"]).split("\0").filter((path) => path !== "");
  const added = [];
  const updated = [];
  for (const file of files) {
    const bytes = readFileSync(join(source, ...file.split("/")));
    const target = join(top, ...file.split("/"));
    if (sameBytes(target, bytes)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    (tracked.includes(file) ? updated : added).push(file);
  }
  const removed = tracked.filter((path) => !files.includes(path));
  for (const path of removed) git(top, ["rm", "-q", "--", path]);
  git(top, ["add", "-A"]);

  let commit = null;
  if (git(top, ["status", "--porcelain"]).trim() !== "") {
    let origin = "";
    try {
      origin = ` at ${execFileSync("git", ["-C", source, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvironment }).trim()}`;
    } catch {
      // A source outside Git has no commit to name.
    }
    git(top, ["commit", "-q", "-m", `Sync the Wiki from docs/wiki${origin}`]);
    commit = git(top, ["rev-parse", "HEAD"]).trim();
  }

  const pending = git(top, ["log", "--format=%H%x09%s", `${upstream}..HEAD`]).split("\n").filter((line) => line !== "").map((line) => {
    const [hash, ...subject] = line.split("\t");
    return { commit: hash, subject: subject.join("\t") };
  });
  const pushed = options.push && pending.length > 0;
  if (pushed) git(top, ["push", "-q"]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    // A rehearsal pushes nothing; a push with nothing to send finds the Wiki up to date.
    reasonCode: !options.push ? "WIKI_PUSH_REHEARSED" : pushed ? "WIKI_PUSHED" : "WIKI_UP_TO_DATE",
    source,
    wikiDir: top,
    upstream,
    added,
    updated,
    removed,
    commit,
    pending,
    pushed,
  })}\n`);
}

try {
  main();
} catch (error) {
  const reasonCode = error instanceof PushWikiError ? error.reasonCode : "PUSH_WIKI_FAILED";
  const details = error instanceof PushWikiError ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
