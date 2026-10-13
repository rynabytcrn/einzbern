// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-485 R3, R4, AC3, AC4 core (MIN-227 D4; TCRN-CROSS-SUB-344): running gates and the
// done check. Every planned gate runs whatever the ones before it did, and the run lists every
// red; it is recorded in this device's cache with the target Story ids, coverage matches, and tree
// digest. A Story goes to done only when every gate that applies to it ran green and bound to it in
// the latest run on the current tree and declarations whose targets include it (TCRN-CROSS-STORY-525).
// Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { listGates, setGate } from "../dist/build/packages/core/src/gates-config.js";
import { assertDoneGates } from "../dist/build/packages/core/src/gates-done.js";
import { planGates } from "../dist/build/packages/core/src/gates-plan.js";
import { gateRunsDirectory, gateTreeState, latestGateRun, runGates } from "../dist/build/packages/core/src/gates-run.js";
import { WORK_GATES_KEY, effectiveWorkGates, workAncestorIds } from "../dist/build/packages/core/src/work-gates.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const node = process.execPath;
const STORY = `work:${"1".repeat(24)}`;
const EPIC = `work:${"2".repeat(24)}`;
function gateDiagnostic(run, recordPath) {
  const outputDirectory = dirname(recordPath);
  const gates = run.gates.map(({ name, ok, exitCode, signal, timedOut, outputFile }) => {
    if (exitCode !== null || signal !== null || timedOut) return { name, ok, exitCode, signal, timedOut };
    let processError = "unknown";
    try {
      const output = readFileSync(join(outputDirectory, outputFile), "utf8");
      processError = /einzbern: the gate could not run: ([A-Z][A-Z0-9_]*)(?:\r?\n|$)/u.exec(output)?.[1] ?? processError;
    } catch {
      // The gate result remains useful when its output is unavailable; never echo raw output.
    }
    return { name, ok, exitCode, signal, timedOut, processError };
  });
  return `gate outcomes: ${JSON.stringify(gates)}`;
}

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

/** A Git project, a library and a device directory, all temporary. */
async function setup(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-gates-run-")));
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
  for (const path of ["src/a.ts", "README.md"]) await put(project, path);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "initial"]);
  const desk = join(base, "desk");
  const library = join(base, ".ether");
  process.env.HOME = home;
  process.env.EINZBERN_HOME = desk;
  await runCli(["init", "--workspace", library, "--at", at()], { write: () => {} });
  return { base, project, desk, library, baseCommit: git(project, ["rev-parse", "HEAD"]).trim() };
}

const declare = (argv, covers, extra = {}) => ({ command: argv, root: ".", covers, required: true, enabled: true, releaseOnly: false, ...extra });

async function declareAll(library, gates) {
  for (const [name, gate] of Object.entries(gates)) await setGate(library, { name, gate, occurredAt: at() });
  return materializeWorkspace(library);
}

/** The merged state with one Story and one Epic added, the records a transition would name. */
const withWork = (state) => ({ ...state, work: [...state.work, { id: STORY, kind: "Story" }, { id: EPIC, kind: "Epic" }] });

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

test("485-AC3: two gates red at once give two reds, and a red gate does not stop the next one", async (context) => {
  const { project, desk, library } = await setup(context);
  const state = await declareAll(library, {
    "fail-a": declare([node, "-e", "process.stdout.write('a'); process.exit(3)"], ["**"]),
    "fail-b": declare([node, "-e", "process.stderr.write('b'); process.exit(4)"], ["**"]),
    pass: declare([node, "-e", "process.stdout.write('ok')"], ["**"]),
  });
  const plan = await planGates({ projectRoot: project, gates: listGates(state), release: true });
  const libraryId = state.metadata.workspaceId;
  const { run, recordPath } = await runGates(plan, { libraryId, at: at(), deviceHome: desk });

  assert.deepEqual(run.reds, ["fail-a", "fail-b"], `both reds are reported; ${gateDiagnostic(run, recordPath)}`);
  assert.deepEqual(run.gates.map((gate) => [gate.name, gate.ok, gate.exitCode]), [["fail-a", false, 3], ["fail-b", false, 4], ["pass", true, 0]], `every gate ran; ${gateDiagnostic(run, recordPath)}`);
  const directory = gateRunsDirectory(libraryId, desk);
  assert.deepEqual(await Promise.all(run.gates.map(async (gate) => readFile(join(directory, gate.outputFile), "utf8"))), ["a", "b", "ok"]);
  assert.equal(recordPath, join(directory, `${run.runId}.json`));
  assert.equal(recordPath.startsWith(join(desk, "cache")), true, "the run is in this device's cache");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.schemaVersion, "einzbern.gate-run.v1");
  assert.match(record.treeDigest, /^[0-9a-f]{64}$/u);
  assert.equal(record.base, null);
  assert.deepEqual(record.gates.map((gate) => Object.keys(gate).sort()), Array(3).fill(["exitCode", "matched", "matchedWorkIds", "name", "ok", "outputBytes", "outputFile", "required", "root", "signal", "timedOut", "truncated"]));
  assert.deepEqual(record.workIds, []);
  assert.deepEqual(record, run);
});

test("485-AC3: a timed-out gate does not leave a delayed kill armed after it exits", async (context) => {
  const { project, desk, library } = await setup(context);
  const state = await declareAll(library, {
    stop: declare([node, "-e", "setTimeout(() => process.exit(0), 250)"], ["**"]),
    pass: declare([node, "-e", "process.exit(0)"], ["**"]),
  });
  const libraryId = state.metadata.workspaceId;
  // TCRN-CROSS-SUB-398: the 100 ms budget belongs to the gate it stops. The passing gate is not
  // timed against it: it runs on its own under the default budget, after the stopped gate and
  // inside the window where a delayed kill would land.
  const planOf = (name) => planGates({ projectRoot: project, gates: listGates(state).filter((gate) => gate.name === name), release: true });
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signals.push(signal);
    return originalKill.call(process, pid, signal);
  };
  try {
    const stopped = await runGates(await planOf("stop"), { libraryId, at: at(), deviceHome: desk, timeoutMs: 100 });
    assert.equal(stopped.run.gates.find((gate) => gate.name === "stop")?.timedOut, true, gateDiagnostic(stopped.run, stopped.recordPath));
    assert.deepEqual(stopped.run.gates.map((gate) => [gate.name, gate.ok]), [["stop", false]], gateDiagnostic(stopped.run, stopped.recordPath));
    assert.deepEqual(stopped.run.reds, ["stop"], gateDiagnostic(stopped.run, stopped.recordPath));
    const passed = await runGates(await planOf("pass"), { libraryId, at: at(), deviceHome: desk });
    assert.deepEqual(passed.run.gates.map((gate) => [gate.name, gate.ok, gate.exitCode, gate.timedOut]), [["pass", true, 0, false]], gateDiagnostic(passed.run, passed.recordPath));
    assert.deepEqual(passed.run.reds, [], gateDiagnostic(passed.run, passed.recordPath));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  } finally {
    process.kill = originalKill;
  }
  assert.equal(signals.includes("SIGKILL"), false, `a settled gate has no pending process-group kill: ${signals.join(",")}`);
});

test("485-R3: a gate past its timeout is stopped and red; output is cut at its bound; a missing command is red", async (context) => {
  const { base, project, desk, library } = await setup(context);
  const pidFile = join(base, "stray.pid");
  const state = await declareAll(library, {
    chatty: declare([node, "-e", "process.stdout.write('x'.repeat(5000))"], ["**"]),
    missing: declare(["einzbern-no-such-command"], ["**"]),
    slow: declare([node, "-e", "setTimeout(() => {}, 60000)"], ["**"]),
    stray: declare([node, "-e", `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`], ["**"]),
  });
  const plan = await planGates({ projectRoot: project, gates: listGates(state), release: true });
  const { run, recordPath } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk, timeoutMs: 500, outputBytes: 1_024 });
  const byName = Object.fromEntries(run.gates.map((gate) => [gate.name, gate]));
  assert.equal(byName.chatty.ok, true, gateDiagnostic(run, recordPath));
  assert.equal(byName.chatty.truncated, true, gateDiagnostic(run, recordPath));
  assert.equal(byName.chatty.outputBytes, 1_024, gateDiagnostic(run, recordPath));
  assert.equal(byName.missing.ok, false, gateDiagnostic(run, recordPath));
  assert.equal(byName.missing.exitCode, null, gateDiagnostic(run, recordPath));
  assert.match(await readFile(join(gateRunsDirectory(state.metadata.workspaceId, desk), byName.missing.outputFile), "utf8"), /could not run: ENOENT/u);
  assert.match(gateDiagnostic({ gates: [byName.missing] }, recordPath), /"processError":"ENOENT"/u);
  assert.equal(byName.slow.ok, false, gateDiagnostic(run, recordPath));
  assert.equal(byName.slow.timedOut, true, gateDiagnostic(run, recordPath));
  assert.deepEqual(run.reds, ["missing", "slow"], gateDiagnostic(run, recordPath));
  await assert.rejects(runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk, timeoutMs: 10 }), { reasonCode: "GATES_RUN_INPUT_INVALID" });

  if (process.platform !== "win32") {
    // What a gate leaves running in its process group ends with the gate.
    const pid = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the process the gate left behind was stopped");
  }
});

test("485-AC4 core: a red required gate refuses a Story's done and names it; a red optional gate does not", async (context) => {
  const { project, desk, library, baseCommit } = await setup(context);
  const state = withWork(await declareAll(library, {
    unit: declare([node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["src/**", STORY]),
    lint: declare([node, "-e", "process.exit(2)"], ["src/**"], { required: false }),
    docs: declare([node, "-e", "process.exit(0)"], ["**/*.md"]),
  }));
  const done = (workIds = [STORY]) => assertDoneGates({ projectRoot: project, library: state, workIds, deviceHome: desk });
  await put(project, "src/a.ts", "export const a = 2;\n");

  const notRun = await refusal(() => done());
  assert.equal(notRun.reasonCode, "WORK_DONE_GATES_NOT_RUN");
  assert.match(notRun.details.remedy, /gates-run --work-id <Story id> with --base <commit> or --release/u);
  assert.deepEqual(notRun.details.stories, [STORY]);

  let plan = await planGates({ projectRoot: project, gates: listGates(state), base: baseCommit, workIds: [STORY] });
  assert.deepEqual(plan.gates.map((gate) => gate.name), ["docs", "lint", "unit"], "the change's own gates and every required one (TCRN-CROSS-STORY-525)");
  let gateRun = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk });
  let { run } = gateRun;
  assert.deepEqual(run.reds, ["lint", "unit"], gateDiagnostic(run, gateRun.recordPath));
  const red = await refusal(() => done());
  assert.equal(red.reasonCode, "WORK_DONE_GATES_RED");
  assert.deepEqual(red.details.reds, ["unit"], `only the required red gate holds the Story back; ${gateDiagnostic(run, gateRun.recordPath)}`);
  assert.equal(red.details.runId, run.runId);

  // Records that are not Stories are not held to the gates.
  assert.deepEqual(await done([EPIC]), { checked: false, reason: "no-story", runId: null, treeDigest: null });

  await put(project, "src/ok", "");
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_NOT_RUN", "a run made on another tree does not count");
  plan = await planGates({ projectRoot: project, gates: listGates(state), base: baseCommit, workIds: [STORY] });
  gateRun = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk });
  ({ run } = gateRun);
  assert.deepEqual(run.reds, ["lint"], gateDiagnostic(run, gateRun.recordPath));
  const verdict = await done();
  assert.equal(verdict.checked, true);
  assert.equal(verdict.reason, "green");
  assert.equal(verdict.runId, run.runId);
});

// TCRN-CROSS-STORY-525 GWT1 (MIN-256; TCRN-CROSS-SUB-448; Q8, Q9): the covers need not list the Story.
test("525-GWT1 core (Q8, Q9): no enabled gate, or none that applies, holds no Story back; a required gate covering ** takes a Story its covers do not list to done once green and bound to it", async (context) => {
  const { project, desk, library, baseCommit } = await setup(context);
  const done = (state, workIds = [STORY]) => assertDoneGates({ projectRoot: project, library: state, workIds, deviceHome: desk });
  assert.deepEqual(await done(withWork(await materializeWorkspace(library))), { checked: false, reason: "no-gates", runId: null, treeDigest: null },
    "a library with no enabled gate holds no Story back");

  let state = withWork(await declareAll(library, {
    optional: declare([node, "-e", "process.exit(0)"], ["src/**"], { required: false }),
    off: declare([node, "-e", "process.exit(1)"], ["**"], { enabled: false }),
  }));
  assert.deepEqual(await done(state), { checked: false, reason: "no-applicable-gates", runId: null, treeDigest: null },
    "an optional path gate and a disabled gate apply to no Story");
  assert.deepEqual(await assertDoneGates({ projectRoot: () => Promise.reject(new Error("no root is looked up")), library: state, workIds: [STORY], deviceHome: desk }),
    { checked: false, reason: "no-applicable-gates", runId: null, treeDigest: null }, "no root is looked up when no gate applies");

  state = withWork(await declareAll(library, { all: declare([node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["**"]) }));
  const libraryId = state.metadata.workspaceId;
  const notRun = await refusal(() => done(state));
  assert.deepEqual([notRun.reasonCode, notRun.details.stories], ["WORK_DONE_GATES_NOT_RUN", [STORY]]);
  await runGates(await planGates({ projectRoot: project, gates: listGates(state), release: true }), { libraryId, at: at(), deviceHome: desk });
  assert.equal((await refusal(() => done(state))).reasonCode, "WORK_DONE_GATES_NOT_RUN", "a run made for no Story binds none");

  const plan = () => planGates({ projectRoot: project, gates: listGates(state), base: baseCommit, workIds: [STORY] });
  assert.deepEqual((await plan()).gates.map((gate) => [gate.name, gate.reason, gate.matchedWorkIds]), [["all", "required", [STORY]]]);
  let ran = await runGates(await plan(), { libraryId, at: at(), deviceHome: desk });
  const red = await refusal(() => done(state));
  assert.deepEqual([red.reasonCode, red.details.reds, red.details.runId, red.details.stories], ["WORK_DONE_GATES_RED", ["all"], ran.run.runId, [STORY]], gateDiagnostic(ran.run, ran.recordPath));

  await put(project, "src/ok", "");
  ran = await runGates(await plan(), { libraryId, at: at(), deviceHome: desk });
  assert.deepEqual(ran.run.reds, [], gateDiagnostic(ran.run, ran.recordPath));
  assert.deepEqual(await done(state), { checked: true, reason: "green", runId: ran.run.runId, treeDigest: ran.run.treeDigest });

  // Q9: a run made for two Stories takes either one to done alone.
  const second = `work:${"3".repeat(24)}`;
  const both = { ...state, work: [...state.work, { id: second, kind: "Story" }] };
  const pair = await runGates(await planGates({ projectRoot: project, gates: listGates(state), base: baseCommit, workIds: [second, STORY] }), { libraryId, at: at(), deviceHome: desk });
  assert.deepEqual(pair.run.workIds, [STORY, second].sort());
  assert.equal((await done(both, [second])).runId, pair.run.runId);
  assert.equal((await done(both, [STORY])).runId, pair.run.runId, "the latest run that includes the Story decides");
});

// TCRN-CROSS-STORY-525 (TCRN-CROSS-SUB-448; Q10, Q12): what binds a Story besides a required gate.
test("525 core (Q10, Q12): an ancestor's work cover and a gates field bind a Story, a name no gate is declared by is not covered, and a release-only gate applies to a release run only", async (context) => {
  const { project, desk, library, baseCommit } = await setup(context);
  const INITIATIVE = `work:${"4".repeat(24)}`;
  const declared = await declareAll(library, {
    "epic-suite": declare([node, "-e", "process.exit(0)"], [EPIC], { required: false }),
    named: declare([node, "-e", "process.exit(0)"], ["docs/**"], { required: false }),
    pack: declare([node, "-e", "process.exit(1)"], ["**"], { releaseOnly: true }),
  });
  const libraryId = declared.metadata.workspaceId;
  const tree = (gates = []) => ({ ...declared, work: [...declared.work,
    { id: INITIATIVE, kind: "Initiative", parentId: null, tombstone: false, extensions: gates.length === 0 ? {} : { [WORK_GATES_KEY]: { required: false, value: gates } } },
    { id: EPIC, kind: "Epic", parentId: INITIATIVE, tombstone: false, extensions: {} },
    { id: STORY, kind: "Story", parentId: EPIC, tombstone: false, extensions: {} },
  ] });
  const done = (state) => assertDoneGates({ projectRoot: project, library: state, workIds: [STORY], deviceHome: desk });
  const subjects = (state) => [{ workId: STORY, ancestorIds: workAncestorIds(state.work, STORY), gates: effectiveWorkGates(state, STORY) }];
  const run = async (state, extra) => runGates(await planGates({ projectRoot: project, gates: listGates(state), workIds: [STORY], ...extra }), { libraryId, at: at(), deviceHome: desk });

  // The Epic's work cover binds the Story under it; a run that does not hold that gate for the Story leaves it uncovered.
  let state = tree();
  const unbound = await run(state, { base: baseCommit });
  assert.deepEqual(unbound.run.gates, [], "a plan given no subject knows no ancestor of the Story");
  const uncovered = await refusal(() => done(state));
  assert.deepEqual([uncovered.reasonCode, uncovered.details.gates, uncovered.details.runId, uncovered.details.stories], ["WORK_DONE_GATES_NOT_COVERED", ["epic-suite"], unbound.run.runId, [STORY]]);
  const bound = await run(state, { base: baseCommit, subjects: subjects(state) });
  assert.deepEqual(bound.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["epic-suite", [STORY]]]);
  assert.equal((await done(state)).runId, bound.run.runId, "the release-only gate is not due for a run that is not a release");

  // The Initiative's gates field names a gate: it binds the Story too, and the run before it does not hold it.
  state = tree(["named"]);
  assert.deepEqual((await refusal(() => done(state))).details.gates, ["named"]);
  const named = await run(state, { base: baseCommit, subjects: subjects(state) });
  assert.deepEqual(named.run.gates.map((gate) => [gate.name, gate.matchedWorkIds]), [["epic-suite", [STORY]], ["named", [STORY]]]);
  assert.equal((await done(state)).runId, named.run.runId);

  // A release run holds the release-only gate, and it is red.
  const release = await run(state, { release: true, subjects: subjects(state) });
  assert.deepEqual(release.run.gates.map((gate) => [gate.name, gate.matchedWorkIds, gate.ok]), [["epic-suite", [STORY], true], ["named", [STORY], true], ["pack", [STORY], false]]);
  const red = await refusal(() => done(state));
  assert.deepEqual([red.reasonCode, red.details.reds, red.details.runId], ["WORK_DONE_GATES_RED", ["pack"], release.run.runId]);

  // Q10: a name no gate is declared by is not covered, whatever ran; the refusal names it.
  state = tree(["ghost", "named"]);
  const ghost = await refusal(() => done(state));
  assert.deepEqual([ghost.reasonCode, ghost.details.gates, ghost.details.stories], ["WORK_DONE_GATES_NOT_COVERED", ["ghost"], [STORY]]);
});

test("D8, 525: a release run binds the Story to every gate that applies to it, a required path gate included", async (context) => {
  const { project, desk, library } = await setup(context);
  let state = withWork(await declareAll(library, {
    path: declare([node, "-e", "process.exit(0)"], ["src/**"]),
  }));
  let plan = await planGates({ projectRoot: project, gates: listGates(state), release: true, workIds: [STORY] });
  assert.deepEqual(plan.gates.map((gate) => [gate.name, gate.reason, gate.matchedWorkIds]), [["path", "release", [STORY]]], "a required gate applies to every Story");
  let run = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk });
  assert.equal((await assertDoneGates({ projectRoot: project, library: state, workIds: [STORY], deviceHome: desk })).runId, run.run.runId,
    "the covers need not list the Story");

  state = withWork(await declareAll(library, {
    subject: declare([node, "-e", "process.exit(0)"], [STORY]),
  }));
  plan = await planGates({ projectRoot: project, gates: listGates(state), release: true, workIds: [STORY] });
  assert.deepEqual(plan.gates.map((gate) => [gate.name, gate.reason, gate.matchedWorkIds]), [
    ["path", "release", [STORY]],
    ["subject", "release", [STORY]],
  ]);
  run = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk });
  assert.equal((await assertDoneGates({ projectRoot: project, library: state, workIds: [STORY], deviceHome: desk })).runId, run.run.runId,
    "the exact declared id and recorded matchedWorkIds prove coverage in release mode");
});

test("485-R4: a run counts only for the tree and declarations it was made on, and the latest one decides", async (context) => {
  const { project, desk, library, baseCommit } = await setup(context);
  const state = withWork(await declareAll(library, {
    unit: declare([node, "-e", "process.exit(process.env.GATE_EXIT === '0' ? 0 : 1)"], ["src/**", STORY]),
  }));
  const libraryId = state.metadata.workspaceId;
  const done = () => assertDoneGates({ projectRoot: project, library: state, workIds: [STORY], deviceHome: desk });
  await put(project, "src/a.ts", "export const a = 3;\n");
  const plan = await planGates({ projectRoot: project, gates: listGates(state), base: baseCommit, workIds: [STORY] });
  const green = { ...process.env, GATE_EXIT: "0" };
  const redEnvironment = { ...process.env, GATE_EXIT: "1" };

  // Two runs on one tree: the one with the later instant decides, whichever was made last.
  const early = at();
  const late = at();
  const lateRun = await runGates(plan, { libraryId, at: late, deviceHome: desk, env: redEnvironment });
  assert.deepEqual(lateRun.run.reds, ["unit"], gateDiagnostic(lateRun.run, lateRun.recordPath));
  const earlyRun = await runGates(plan, { libraryId, at: early, deviceHome: desk, env: green });
  assert.deepEqual(earlyRun.run.reds, [], gateDiagnostic(earlyRun.run, earlyRun.recordPath));
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_RED");
  const latestGreen = await runGates(plan, { libraryId, at: at(), deviceHome: desk, env: green });
  const { run } = latestGreen;
  assert.deepEqual(run.reds, [], gateDiagnostic(run, latestGreen.recordPath));
  assert.equal((await done()).runId, run.runId);
  assert.equal((await latestGateRun({ libraryId, deviceHome: desk })).runId, run.runId);

  // A content change moves the tree away from the run; the same content brings it back.
  const before = await gateTreeState(project, ["."]);
  await put(project, "src/a.ts", "export const a = 4;\n");
  assert.notEqual((await gateTreeState(project, ["."])).treeDigest, before.treeDigest);
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_NOT_RUN");
  await put(project, "src/a.ts", "export const a = 3;\n");
  assert.equal((await done()).runId, run.runId, "the tree is the one the run was made on again");

  // A changed declaration is another set of gates, even on the same tree.
  const redeclared = withWork(await declareAll(library, {
    unit: declare([node, "-e", "process.exit(process.env.GATE_EXIT === '0' ? 0 : 1)"], ["src/**", STORY, "test/**"]),
  }));
  const other = await refusal(() => assertDoneGates({ projectRoot: project, library: redeclared, workIds: [STORY], deviceHome: desk }));
  assert.equal(other.reasonCode, "WORK_DONE_GATES_NOT_RUN", "a run under other declarations does not count");

  // A commit moves HEAD, so the run no longer describes the tree.
  git(project, ["commit", "-q", "-am", "change"]);
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_NOT_RUN");
});
