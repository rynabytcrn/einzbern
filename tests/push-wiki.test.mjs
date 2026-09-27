// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-487 R3, AC3 (TCRN-CROSS-SUB-352): scripts/push-wiki.mjs publishes docs/wiki to
// the Wiki repository. A temporary bare repository stands in for the Wiki's remote, seeded with the
// Home page GitHub creates. The default run is a rehearsal: it mirrors docs/wiki, including its
// Home.md, into a local working tree of the Wiki, commits there and lists what a push would send,
// and the remote does not move. With --execute push the remote's latest commit holds exactly
// docs/wiki. Everything here is temporary; git reads a configuration file of the test's own.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const SCRIPT = join(repositoryRoot, "scripts", "push-wiki.mjs");
const SOURCE = join(repositoryRoot, "docs", "wiki");
const GIT_LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"];

/** A Wiki remote holding the Home page, a working tree cloned from it, and a git of the test's own. */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-push-wiki-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const config = join(base, "gitconfig");
  await writeFile(config, "[user]\n\tname = Wiki Test\n\temail = wiki-test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARIABLES.includes(name))),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args, encoding = "utf8") => execFileSync("git", args, { env, encoding, stdio: ["ignore", "pipe", "pipe"] });
  const remote = join(base, "wiki.git");
  git(["init", "-q", "--bare", remote]);
  const seed = join(base, "seed");
  git(["clone", "-q", remote, seed]);
  await writeFile(join(seed, "Home.md"), "# Home\n\nWritten on the web.\n");
  git(["-C", seed, "add", "-A"]);
  git(["-C", seed, "commit", "-q", "-m", "Initial Home page"]);
  git(["-C", seed, "push", "-q", "origin", "HEAD"]);
  const wiki = join(base, "wiki");
  git(["clone", "-q", remote, wiki]);
  const run = (args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
    return {
      status: result.status,
      receipt: result.stdout.trim() === "" ? null : JSON.parse(result.stdout.trim()),
      refusal: result.stderr.trim() === "" ? null : JSON.parse(result.stderr.trim()),
    };
  };
  const head = (repository) => git(["--git-dir", repository, "rev-parse", "master"]).trim();
  return { base, remote, wiki, git, run, head };
}

/** A directory's files, as forward-slash paths relative to it, sorted; dot-names are not pages. */
async function filesOf(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) files.push(...await filesOf(join(directory, entry.name), `${prefix}${entry.name}/`));
    else files.push(`${prefix}${entry.name}`);
  }
  return files.sort();
}

/** Assert that a commit of a repository holds exactly the files of `source`, byte for byte. */
async function assertTreeIs(context, repository, revision, source) {
  const names = context.git(["--git-dir", repository, "ls-tree", "-r", "--name-only", revision]).split("\n").filter((name) => name !== "").sort();
  assert.deepEqual(names, await filesOf(source));
  for (const name of names) {
    assert.deepEqual(context.git(["--git-dir", repository, "show", `${revision}:${name}`], "buffer"), await readFile(join(source, name)), name);
  }
}

test("487-AC3: the rehearsal commits docs/wiki in the Wiki's working tree and pushes nothing; --execute push makes the remote's latest commit hold exactly docs/wiki", async (context) => {
  const scene = await scratch(context);
  const { wiki, remote, run, head } = scene;
  const seeded = head(remote);
  const pages = await filesOf(SOURCE);
  assert.equal(pages.length > 0, true);
  assert.ok(pages.includes("Home.md"), "Home is a member of docs/wiki");

  const rehearsal = run(["--wiki-dir", wiki, "--source", SOURCE]);
  assert.equal(rehearsal.status, 0, JSON.stringify(rehearsal.refusal));
  const receipt = rehearsal.receipt;
  assert.deepEqual([receipt.reasonCode, receipt.pushed, receipt.upstream], ["WIKI_PUSH_REHEARSED", false, "origin/master"]);
  assert.deepEqual(
    [receipt.added, receipt.updated, receipt.removed],
    [pages.filter((page) => page !== "Home.md"), ["Home.md"], []],
    "docs/wiki is the whole Wiki, including the Home page",
  );
  assert.match(receipt.commit, /^[0-9a-f]{40}$/u);
  assert.deepEqual(receipt.pending.map((entry) => entry.commit), [receipt.commit]);
  assert.match(receipt.pending[0].subject, /^Sync the Wiki from docs\/wiki/u);
  assert.equal(head(remote), seeded, "the rehearsal pushes nothing");
  await assertTreeIs(scene, join(wiki, ".git"), "HEAD", SOURCE);

  const again = run(["--wiki-dir", wiki, "--source", SOURCE]);
  assert.deepEqual([again.status, again.receipt.commit, again.receipt.added, again.receipt.removed], [0, null, [], []], "nothing new to commit");
  assert.deepEqual(again.receipt.pending.map((entry) => entry.commit), [receipt.commit], "the unpushed commit is still listed");
  assert.equal(head(remote), seeded);

  const pushed = run(["--wiki-dir", wiki, "--source", SOURCE, "--execute", "push"]);
  assert.equal(pushed.status, 0, JSON.stringify(pushed.refusal));
  assert.deepEqual([pushed.receipt.reasonCode, pushed.receipt.pushed, pushed.receipt.pending.map((entry) => entry.commit)], ["WIKI_PUSHED", true, [receipt.commit]]);
  assert.equal(head(remote), receipt.commit, "the remote's latest commit is the synced one");
  await assertTreeIs(scene, remote, "master", SOURCE);

  const current = run(["--wiki-dir", wiki, "--source", SOURCE, "--execute", "push"]);
  assert.deepEqual([current.receipt.reasonCode, current.receipt.pushed, current.receipt.pending], ["WIKI_UP_TO_DATE", false, []]);
});

test("487-R3: a changed page, a new one and one in a subdirectory reach the Wiki, and a page the source dropped leaves it", async (context) => {
  const scene = await scratch(context);
  const { base, wiki, remote, run } = scene;
  const source = join(base, "source");
  await cp(SOURCE, source, { recursive: true });
  assert.equal(run(["--wiki-dir", wiki, "--source", source, "--execute", "push"]).receipt.reasonCode, "WIKI_PUSHED");

  const [first, dropped] = await filesOf(source);
  await writeFile(join(source, first), `${await readFile(join(source, first), "utf8")}\nOne more line.\n`);
  await rm(join(source, dropped));
  await writeFile(join(source, "New-Page.md"), "# New page\n");
  await mkdir(join(source, "images"));
  await writeFile(join(source, "images", "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  await writeFile(join(source, ".DS_Store"), "not a page");
  const pushed = run(["--wiki-dir", wiki, "--source", source, "--execute", "push"]);
  assert.equal(pushed.status, 0, JSON.stringify(pushed.refusal));
  assert.deepEqual([pushed.receipt.added, pushed.receipt.updated, pushed.receipt.removed], [["images/diagram.svg", "New-Page.md"].sort(), [first], [dropped]]);
  await assertTreeIs(scene, remote, "master", source);
});

test("487-R3: the refusals, each before anything is written", async (context) => {
  const scene = await scratch(context);
  const { base, wiki, remote, run, head, git } = scene;
  const seeded = head(remote);
  const refused = (args) => {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(result.receipt));
    assert.equal(result.receipt, null);
    return result.refusal.reasonCode;
  };
  assert.equal(refused([]), "PUSH_WIKI_ARGUMENT_MISSING");
  assert.equal(refused(["--wiki-dir", wiki, "--execute", "yes"]), "PUSH_WIKI_ARGUMENT_INVALID");
  assert.equal(refused(["--wiki-dir", wiki, "--force", "true"]), "PUSH_WIKI_ARGUMENT_INVALID");
  assert.equal(refused(["--wiki-dir", wiki, "--wiki-dir", wiki]), "PUSH_WIKI_ARGUMENT_INVALID");

  const plain = join(base, "plain");
  await mkdir(plain);
  assert.equal(refused(["--wiki-dir", plain, "--source", SOURCE]), "PUSH_WIKI_NOT_A_WORKING_TREE");
  assert.equal(refused(["--wiki-dir", join(wiki, "missing"), "--source", SOURCE]), "PUSH_WIKI_NOT_A_WORKING_TREE");
  assert.equal(refused(["--wiki-dir", repositoryRoot, "--source", SOURCE]), "PUSH_WIKI_TARGET_INVALID", "this repository is not the Wiki");
  const inside = join(wiki, "docs");
  await mkdir(inside);
  await writeFile(join(inside, "Page.md"), "# Page\n");
  assert.equal(refused(["--wiki-dir", wiki, "--source", inside]), "PUSH_WIKI_TARGET_INVALID", "the source may not sit inside the Wiki");
  await rm(inside, { recursive: true });

  const empty = join(base, "empty");
  await mkdir(empty);
  assert.equal(refused(["--wiki-dir", wiki, "--source", empty]), "PUSH_WIKI_SOURCE_EMPTY", "mirroring nothing would empty the Wiki");
  assert.equal(refused(["--wiki-dir", wiki, "--source", join(base, "absent")]), "PUSH_WIKI_SOURCE_INVALID");

  const before = git(["-C", wiki, "rev-parse", "HEAD"]).trim();
  await writeFile(join(wiki, "Draft.md"), "# Draft\n");
  assert.equal(refused(["--wiki-dir", wiki, "--source", SOURCE, "--execute", "push"]), "PUSH_WIKI_WORKING_TREE_DIRTY");
  assert.equal(git(["-C", wiki, "rev-parse", "HEAD"]).trim(), before, "nothing is committed");
  await rm(join(wiki, "Draft.md"));

  const local = join(base, "local");
  git(["init", "-q", local]);
  await writeFile(join(local, "Home.md"), "# Home\n");
  git(["-C", local, "add", "-A"]);
  git(["-C", local, "commit", "-q", "-m", "Home"]);
  assert.equal(refused(["--wiki-dir", local, "--source", SOURCE]), "PUSH_WIKI_NO_UPSTREAM");
  assert.equal(head(remote), seeded, "no refusal reached the remote");
  assert.equal(git(["-C", wiki, "status", "--porcelain"]).trim(), "");
});
