// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-534 (MIN-257 D6; TCRN-CROSS-SUB-470): the done check reads again the files a run
// made for a Story recorded, and takes the files the commits of the Story and its Subtasks touch now
// (Q2). A commit another session makes elsewhere leaves the run standing, so the Story goes to done
// without its gates running again (GWT1); a change to one of the Story's files, uncommitted or
// committed, or a new commit of the Story's that touches another file, refuses it with
// WORK_DONE_GATES_NOT_RUN and names the files in changedPaths and addedPaths (GWT2); the content the
// run read brings the run back. Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { listGates, setGate } from "../dist/build/packages/core/src/gates-config.js";
import { assertDoneGates } from "../dist/build/packages/core/src/gates-done.js";
import { planGates } from "../dist/build/packages/core/src/gates-plan.js";
import { gateRunsDirectory, runGates } from "../dist/build/packages/core/src/gates-run.js";
import { workSubjectKeys } from "../dist/build/packages/core/src/work-gates.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 10, 0, second)).toISOString().replace(".000Z", "Z");
};

const node = process.execPath;
const STORY = `work:${"1".repeat(24)}`;
const OTHER_STORY = `work:${"3".repeat(24)}`;
const SUBTASK = `work:${"5".repeat(24)}`;
const LATER_SUBTASK = `work:${"6".repeat(24)}`;
const record = (id, externalKey, kind, parentId = null) => ({ id, externalKey, kind, parentId, tombstone: false, extensions: {} });

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
 * A Git project whose Story has two commits, src/a.ts by the Story and docs/sub.md by its Subtask; a
 * library that declares one required gate in each of `roots` and holds the Story and the Subtask; and
 * a device directory: all temporary.
 */
async function setup(context, roots = ["."]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-gates-done-paths-")));
  const previousHome = process.env.HOME;
  const previousDeviceHome = process.env.EINZBERN_HOME;
  const home = join(base, "home");
  await mkdir(home);
  context.after(async () => {
    restoreEnv("HOME", previousHome);
    restoreEnv("EINZBERN_HOME", previousDeviceHome);
    await rm(base, { recursive: true, force: true });
  });
  const project = join(base, "project");
  await mkdir(project);
  git(project, ["init", "-q"]);
  for (const path of ["src/a.ts", "README.md", "pkg/x.ts", "tools/y.mjs"]) await put(project, path);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "initial"]);
  await put(project, "src/a.ts", "export const a = 2;\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-STORY-1: change a"]);
  await put(project, "docs/sub.md", "sub\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "TCRN-TEST-SUB-7 (TCRN-TEST-STORY-1): add the sub page"]);
  const desk = join(base, "desk");
  const library = join(base, ".ether");
  process.env.HOME = home;
  process.env.EINZBERN_HOME = desk;
  await runCli(["init", "--workspace", library, "--at", at()], { write: () => {} });
  for (const [index, root] of roots.entries()) {
    await setGate(library, { name: `unit-${index}`, gate: { command: [node, "-e", "process.exit(0)"], root, covers: ["**"], required: true, enabled: true, releaseOnly: false }, occurredAt: at() });
  }
  const declared = await materializeWorkspace(library);
  const state = { ...declared, work: [...declared.work, record(STORY, "TCRN-TEST-STORY-1", "Story"), record(SUBTASK, "TCRN-TEST-SUB-7", "Subtask", STORY)] };
  return { project, desk, state };
}

// A run made now for the Stories, as gates-run --work-id makes it: their keys come from the work records.
async function runFor(project, desk, state, workIds = [STORY]) {
  const plan = await planGates({ projectRoot: project, gates: listGates(state), base: "HEAD", workIds, subjectKeys: workSubjectKeys(state.work, workIds) });
  const { run } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk });
  assert.deepEqual(run.reds, []);
  return run;
}

const done = (project, desk, state, workIds = [STORY]) => assertDoneGates({ projectRoot: project, library: state, workIds, deviceHome: desk });

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return assert.fail("the done check let the Story through");
}

const head = (project) => git(project, ["rev-parse", "HEAD"]).trim();

test("534-GWT1: after the run another session commits files the Story's commits did not touch; done passes on the same run, the gates not run again", async (context) => {
  const { project, desk, state } = await setup(context);
  const run = await runFor(project, desk, state);
  assert.deepEqual(run.trees.map((tree) => tree.paths), [["docs/sub.md", "src/a.ts"]]);
  const before = head(project);

  await put(project, "README.md", "# Another session\n");
  await put(project, "tools/y.mjs", "another session's tool\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-STORY-2: another session's Story"]);
  await put(project, "elsewhere.txt", "untracked\n");
  assert.notEqual(head(project), before, "HEAD moved");

  const verdict = await done(project, desk, state);
  assert.deepEqual([verdict.checked, verdict.reason, verdict.runId, verdict.treeDigest], [true, "green", run.runId, run.treeDigest]);
  const records = (await readdir(gateRunsDirectory(state.metadata.workspaceId, desk))).filter((name) => name.endsWith(".json"));
  assert.deepEqual(records, [`${run.runId}.json`], "no gate ran again");
});

test("534-GWT2: a change to one of the Story's files, uncommitted or committed, refuses done with WORK_DONE_GATES_NOT_RUN and names it in changedPaths; the content the run read brings the run back", async (context) => {
  const { project, desk, state } = await setup(context);
  const run = await runFor(project, desk, state);

  await put(project, "src/a.ts", "export const a = 3;\n");
  const uncommitted = await refusal(() => done(project, desk, state));
  assert.deepEqual(
    [uncommitted.reasonCode, uncommitted.details.stories, uncommitted.details.changedPaths, uncommitted.details.addedPaths],
    ["WORK_DONE_GATES_NOT_RUN", [STORY], ["src/a.ts"], []],
  );
  assert.notEqual(uncommitted.details.treeDigest, run.treeDigest, "the digest a run made now would record");
  await put(project, "src/a.ts", "export const a = 2;\n");
  assert.equal((await done(project, desk, state)).runId, run.runId, "the content the run read");

  await put(project, "docs/sub.md", "changed\n");
  git(project, ["commit", "-q", "-am", "an unkeyed commit"]);
  const committed = await refusal(() => done(project, desk, state));
  assert.deepEqual([committed.reasonCode, committed.details.changedPaths, committed.details.addedPaths], ["WORK_DONE_GATES_NOT_RUN", ["docs/sub.md"], []]);

  await put(project, "docs/sub.md", "sub\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-SUB-7 (TCRN-TEST-STORY-1): put the page back"]);
  assert.equal((await done(project, desk, state)).runId, run.runId, "another commit put the content back");
});

test("534 Q2: a new commit of the Story's that touches a file the run did not read refuses done and names it in addedPaths, as does a Subtask recorded after the run; a run made then passes", async (context) => {
  const { project, desk, state } = await setup(context);
  // A commit of a Subtask the library does not hold yet, its message naming the Subtask alone.
  await put(project, "tools/y.mjs", "the later Subtask's tool\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-SUB-8: a tool"]);
  const run = await runFor(project, desk, state);
  assert.deepEqual(run.trees.map((tree) => tree.paths), [["docs/sub.md", "src/a.ts"]]);

  await put(project, "src/c.ts", "export const c = 1;\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "TCRN-TEST-STORY-1: add c"]);
  const added = await refusal(() => done(project, desk, state));
  assert.deepEqual([added.reasonCode, added.details.changedPaths, added.details.addedPaths], ["WORK_DONE_GATES_NOT_RUN", [], ["src/c.ts"]]);
  const later = await runFor(project, desk, state);
  assert.equal((await done(project, desk, state)).runId, later.runId);

  const grown = { ...state, work: [...state.work, record(LATER_SUBTASK, "TCRN-TEST-SUB-8", "Subtask", STORY)] };
  const recorded = await refusal(() => done(project, desk, grown));
  assert.deepEqual([recorded.reasonCode, recorded.details.changedPaths, recorded.details.addedPaths], ["WORK_DONE_GATES_NOT_RUN", [], ["tools/y.mjs"]]);
  const last = await runFor(project, desk, grown);
  assert.deepEqual(last.trees.map((tree) => tree.paths), [["docs/sub.md", "src/a.ts", "src/c.ts", "tools/y.mjs"]]);
  assert.equal((await done(project, desk, grown)).runId, last.runId);
});

test("534: with a gate root below the project, a refusal names each of the Story's files once, from the project root", async (context) => {
  const { project, desk, state } = await setup(context, [".", "pkg"]);
  await put(project, "pkg/x.ts", "export const x = 2;\n");
  git(project, ["commit", "-q", "-am", "TCRN-TEST-STORY-1: change x"]);
  const run = await runFor(project, desk, state);
  assert.deepEqual(run.trees.map((tree) => [tree.root, tree.paths]), [[".", ["docs/sub.md", "pkg/x.ts", "src/a.ts"]], ["pkg", ["x.ts"]]]);
  assert.equal((await done(project, desk, state)).runId, run.runId);

  await put(project, "pkg/x.ts", "export const x = 3;\n");
  await put(project, "pkg/z.ts", "export const z = 1;\n");
  git(project, ["add", "pkg/z.ts"]);
  git(project, ["commit", "-q", "-m", "TCRN-TEST-STORY-1: add z", "--", "pkg/z.ts"]);
  const refused = await refusal(() => done(project, desk, state));
  assert.deepEqual([refused.reasonCode, refused.details.changedPaths, refused.details.addedPaths], ["WORK_DONE_GATES_NOT_RUN", ["pkg/x.ts"], ["pkg/z.ts"]]);
});

test("534 Q1: a run made while the Story had no commit took HEAD and every change; the Story's first commit refuses done, with no file of the Story's to name", async (context) => {
  const { project, desk, state } = await setup(context);
  const grown = { ...state, work: [...state.work, record(OTHER_STORY, "TCRN-TEST-STORY-3", "Story")] };
  const run = await runFor(project, desk, grown, [OTHER_STORY]);
  assert.deepEqual([Object.keys(run.trees[0]).sort(), run.trees[0].head], [["changes", "git", "head", "root"], head(project)]);
  assert.equal((await done(project, desk, grown, [OTHER_STORY])).runId, run.runId);

  await put(project, "src/d.ts", "export const d = 1;\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "TCRN-TEST-STORY-3: add d"]);
  const refused = await refusal(() => done(project, desk, grown, [OTHER_STORY]));
  assert.deepEqual(
    [refused.reasonCode, refused.details.stories, refused.details.changedPaths, refused.details.addedPaths],
    ["WORK_DONE_GATES_NOT_RUN", [OTHER_STORY], [], []],
  );
});
