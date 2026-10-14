// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-534 (MIN-257 D6; TCRN-CROSS-SUB-469): the tree digest of a run made for a Story is
// taken over the content, as it is now, of the files the commits of the Story and its Subtasks
// touched, and leaves HEAD out (einzbern.gate-tree.v3); the record names each of those files with its
// content digest. A commit elsewhere leaves the digest as it was; a change to one of the Story's
// files, in the working tree or committed, moves it. When the Story has no commit under any root (Q1)
// the run takes HEAD and every change, as a run made without keys does, so its digest is never a
// constant. Every project and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { planGates } from "../dist/build/packages/core/src/gates-plan.js";
import { GATE_TREE_SCHEMA_VERSION, gateRunsDirectory, gateTreeState, latestGateRun, runGates } from "../dist/build/packages/core/src/gates-run.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const node = process.execPath;
const STORY = `work:${"1".repeat(24)}`;
const LIBRARY = `workspace:${"a".repeat(24)}`;
// The keys of the Story and its Subtask, as workSubjectKeys gives them.
const KEYS = ["TCRN-TEST-STORY-1", "TCRN-TEST-SUB-7"];
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const gate = (name, root) => ({ name, command: [node, "-e", "process.exit(0)"], root, covers: ["**"], required: true, enabled: true, releaseOnly: false });

function git(root, args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=gates-test", "-c", "user.email=gates-test-at-example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function put(root, path, text = `${path}\n`) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/**
 * A Git project in a temporary directory: an initial commit, then the Story's commit, which changes
 * src/a.ts, and its Subtask's, which adds docs/sub.md and deletes src/b.ts. tools/ holds a file no
 * commit of the Story touched.
 */
async function setup(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-gate-tree-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  git(project, ["init", "-q"]);
  for (const path of ["src/a.ts", "src/b.ts", "README.md", "docs/guide.md", "tools/x.mjs"]) await put(project, path);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "initial"]);
  await put(project, "src/a.ts", "export const a = 2;\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-STORY-1: change a"]);
  await put(project, "docs/sub.md", "sub\n");
  git(project, ["rm", "-q", "src/b.ts"]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "TCRN-TEST-SUB-7 (TCRN-TEST-STORY-1): add the sub page and drop b"]);
  return { project, desk: join(base, "desk") };
}

const head = (project) => git(project, ["rev-parse", "HEAD"]).trim();

// The digest taken again over the files a state recorded, as the done check takes it.
const again = (project, recorded) => gateTreeState(project, recorded.trees.map((tree) => tree.root), {
  paths: Object.fromEntries(recorded.trees.filter((tree) => tree.files !== undefined).map((tree) => [tree.root, tree.files.map((file) => file.path)])),
});

test("534-GWT1 (digest): another session's commit and files elsewhere leave the digest of a run made for the Story as it was; HEAD is not part of it", async (context) => {
  const { project } = await setup(context);
  const before = await gateTreeState(project, ["."], { keys: KEYS });
  assert.deepEqual(before.trees.map((tree) => tree.paths), [["docs/sub.md", "src/a.ts", "src/b.ts"]]);
  const headBefore = head(project);
  const whole = await gateTreeState(project, ["."]);

  await put(project, "README.md", "# Another session's Story\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-STORY-2: another session's Story"]);
  await put(project, "tools/x.mjs", "edited, not committed\n");
  await put(project, "elsewhere.txt", "untracked\n");
  assert.notEqual(head(project), headBefore, "HEAD moved");

  const after = await gateTreeState(project, ["."], { keys: KEYS });
  assert.equal(after.treeDigest, before.treeDigest, "the Story's files are as they were");
  assert.deepEqual(after.trees, before.trees);
  assert.equal((await again(project, before)).treeDigest, before.treeDigest, "read again over the recorded files, the digest is the same");
  assert.notEqual((await gateTreeState(project, ["."])).treeDigest, whole.treeDigest, "a run made without keys sees every change");
});

test("534-GWT2 (digest): a change to one of the Story's files moves the digest, uncommitted or committed; the same content brings it back, through another commit too", async (context) => {
  const { project } = await setup(context);
  const recorded = await gateTreeState(project, ["."], { keys: KEYS });
  assert.equal((await again(project, recorded)).treeDigest, recorded.treeDigest);

  // Uncommitted: the Story's own file.
  await put(project, "src/a.ts", "export const a = 3;\n");
  const edited = await again(project, recorded);
  assert.notEqual(edited.treeDigest, recorded.treeDigest);
  assert.deepEqual(edited.trees[0].files.find((file) => file.path === "src/a.ts"), { path: "src/a.ts", digest: sha("export const a = 3;\n") });
  assert.notEqual((await gateTreeState(project, ["."], { keys: KEYS })).treeDigest, recorded.treeDigest, "a run made now records another digest");
  await put(project, "src/a.ts", "export const a = 2;\n");
  assert.equal((await again(project, recorded)).treeDigest, recorded.treeDigest, "the same content again");

  // A file the Subtask deleted comes back, and goes again.
  await put(project, "src/b.ts", "back\n");
  assert.notEqual((await again(project, recorded)).treeDigest, recorded.treeDigest);
  await unlink(join(project, "src/b.ts"));
  assert.equal((await again(project, recorded)).treeDigest, recorded.treeDigest);

  // Committed, under a message that names no key: the Subtask's file.
  await put(project, "docs/sub.md", "changed\n");
  git(project, ["commit", "-q", "-am", "an unkeyed commit"]);
  assert.notEqual((await again(project, recorded)).treeDigest, recorded.treeDigest, "a committed change to a Subtask's file");
  assert.notEqual((await gateTreeState(project, ["."], { keys: KEYS })).treeDigest, recorded.treeDigest);

  // Another commit puts the content back: HEAD differs, the digest is the run's again.
  await put(project, "docs/sub.md", "sub\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-SUB-7 (TCRN-TEST-STORY-1): put the page back"]);
  assert.equal((await again(project, recorded)).treeDigest, recorded.treeDigest);
  assert.equal((await gateTreeState(project, ["."], { keys: KEYS })).treeDigest, recorded.treeDigest);
});

test("534-GWT3: the record names every file the Story's commits touched under each root with its content digest, a deleted one included, and no HEAD; a root they did not reach names none", async (context) => {
  const { project, desk } = await setup(context);
  const plan = await planGates({ projectRoot: project, gates: [gate("unit", "."), gate("tools", "tools")], base: "HEAD", workIds: [STORY], subjectKeys: KEYS });
  const { run, recordPath } = await runGates(plan, { libraryId: LIBRARY, at: at(), deviceHome: desk });
  assert.deepEqual(run.trees, [
    {
      root: ".", git: true, paths: ["docs/sub.md", "src/a.ts", "src/b.ts"], files: [
        { path: "docs/sub.md", digest: sha("sub\n") },
        { path: "src/a.ts", digest: sha("export const a = 2;\n") },
        { path: "src/b.ts", digest: "deleted" },
      ],
    },
    { root: "tools", git: true, paths: [], files: [] },
  ]);
  assert.ok(run.trees.every((tree) => !Object.hasOwn(tree, "head") && !Object.hasOwn(tree, "changes")), "no HEAD and no digest of the other changes");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.deepEqual(record.trees, run.trees);
  assert.equal(GATE_TREE_SCHEMA_VERSION, "einzbern.gate-tree.v3");
  assert.equal(record.treeDigest, canonicalSha256({ schemaVersion: "einzbern.gate-tree.v3", trees: run.trees }));
  assert.equal((await latestGateRun({ libraryId: LIBRARY, deviceHome: desk })).runId, run.runId, "the record reads as a run");

  // A file under a root the Story's commits did not reach changes: the run's digest stays.
  await put(project, "tools/x.mjs", "changed\n");
  assert.equal((await gateTreeState(project, [".", "tools"], { keys: KEYS })).treeDigest, run.treeDigest);
  assert.equal((await again(project, run)).treeDigest, run.treeDigest);
});

test("534 Q1: a run for a Story with no commit under any root takes HEAD and every change, as a run made without keys, so a commit elsewhere moves it", async (context) => {
  const { project, desk } = await setup(context);
  const keys = ["TCRN-TEST-STORY-3"];
  const keyed = await gateTreeState(project, ["."], { keys });
  assert.deepEqual(keyed, await gateTreeState(project, ["."]));
  assert.deepEqual([Object.keys(keyed.trees[0]).sort(), keyed.trees[0].head], [["changes", "git", "head", "root"], head(project)]);

  const plan = await planGates({ projectRoot: project, gates: [gate("unit", ".")], base: "HEAD", workIds: [STORY], subjectKeys: keys });
  assert.deepEqual(plan.subjectKeys, keys);
  const { run } = await runGates(plan, { libraryId: LIBRARY, at: at(), deviceHome: desk });
  assert.deepEqual([run.treeDigest, run.trees], [keyed.treeDigest, keyed.trees]);

  await put(project, "README.md", "# Elsewhere\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-STORY-2: elsewhere"]);
  assert.notEqual((await gateTreeState(project, ["."], { keys })).treeDigest, run.treeDigest, "not a constant: a commit anywhere moves it");
});

test("534: a run made without keys, a release run among them, records each root's HEAD and the digest of every changed and untracked file, as before", async (context) => {
  const { project, desk } = await setup(context);
  await put(project, "elsewhere.txt", "untracked\n");
  const changes = createHash("sha256").update(`elsewhere.txt\u0000${sha("untracked\n")}`, "utf8").digest("hex");
  const release = await runGates(await planGates({ projectRoot: project, gates: [gate("unit", ".")], release: true }), { libraryId: LIBRARY, at: at(), deviceHome: desk });
  const bound = await runGates(await planGates({ projectRoot: project, gates: [gate("unit", ".")], base: "HEAD", workIds: [STORY] }), { libraryId: LIBRARY, at: at(), deviceHome: desk });
  for (const { run } of [release, bound]) {
    assert.deepEqual(run.trees, [{ root: ".", git: true, head: head(project), changes }]);
    assert.equal(run.treeDigest, (await gateTreeState(project, ["."])).treeDigest);
  }
  assert.equal(release.run.release, true);
});

test("534: a record whose root names its paths without their digests (einzbern.gate-tree.v2), or whose files do not follow its paths, is not taken as a run", async (context) => {
  const { project, desk } = await setup(context);
  const plan = await planGates({ projectRoot: project, gates: [gate("unit", ".")], base: "HEAD", workIds: [STORY], subjectKeys: KEYS });
  const { run } = await runGates(plan, { libraryId: LIBRARY, at: at(), deviceHome: desk });
  const directory = gateRunsDirectory(LIBRARY, desk);
  const [tree] = run.trees;
  const later = [
    ["v2", { root: ".", git: true, head: "f".repeat(40), changes: "0".repeat(64), paths: tree.paths }],
    ["head", { ...tree, head: head(project) }],
    ["short", { ...tree, files: tree.files.slice(1) }],
    ["order", { ...tree, files: [...tree.files].reverse() }],
    ["climbs", { root: ".", git: true, paths: ["../outside"], files: [{ path: "../outside", digest: "deleted" }] }],
    ["absolute", { root: ".", git: true, paths: ["/etc/hosts"], files: [{ path: "/etc/hosts", digest: "deleted" }] }],
  ];
  for (const [index, [label, shape]] of later.entries()) {
    const runId = `20261014T100000Z-${String(index).padStart(12, "0")}`;
    await writeFile(join(directory, `${runId}.json`), canonicalJson({ ...run, runId, at: at(), trees: [shape] }));
    assert.equal((await latestGateRun({ libraryId: LIBRARY, deviceHome: desk })).runId, run.runId, `${label}: a later record that does not read as a run is skipped`);
  }
});
