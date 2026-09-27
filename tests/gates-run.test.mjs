// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-485 R3, R4, AC3, AC4 core (MIN-227 D4; TCRN-CROSS-SUB-344): running gates and the
// done check. Every planned gate runs whatever the ones before it did, and the run lists every
// red; it is recorded in this device's cache with the digest of the tree it ran on. A Story goes
// to done only when the latest run on the tree as it is, under the declarations as they are, has
// no red required gate. Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const node = process.execPath;
const STORY = `work:${"1".repeat(24)}`;
const EPIC = `work:${"2".repeat(24)}`;

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
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
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
  process.env.EINZBERN_HOME = desk;
  await runCli(["init", "--workspace", library, "--at", at()], { write: () => {} });
  return { base, project, desk, library };
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

  assert.deepEqual(run.reds, ["fail-a", "fail-b"], "both reds are reported");
  assert.deepEqual(run.gates.map((gate) => [gate.name, gate.ok, gate.exitCode]), [["fail-a", false, 3], ["fail-b", false, 4], ["pass", true, 0]], "every gate ran");
  const directory = gateRunsDirectory(libraryId, desk);
  assert.deepEqual(await Promise.all(run.gates.map(async (gate) => readFile(join(directory, gate.outputFile), "utf8"))), ["a", "b", "ok"]);
  assert.equal(recordPath, join(directory, `${run.runId}.json`));
  assert.equal(recordPath.startsWith(join(desk, "cache")), true, "the run is in this device's cache");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.schemaVersion, "einzbern.gate-run.v1");
  assert.match(record.treeDigest, /^[0-9a-f]{64}$/u);
  assert.equal(record.base, null);
  assert.deepEqual(record.gates.map((gate) => Object.keys(gate).sort()), Array(3).fill(["exitCode", "name", "ok", "outputBytes", "outputFile", "required", "root", "signal", "timedOut", "truncated"]));
  assert.deepEqual(record, run);
});

test("485-AC3: a timed-out gate does not leave a delayed kill armed after it exits", async (context) => {
  const { project, desk, library } = await setup(context);
  const state = await declareAll(library, {
    stop: declare([node, "-e", "setTimeout(() => process.exit(0), 250)"], ["**"]),
    pass: declare([node, "-e", "process.exit(0)"], ["**"]),
  });
  const plan = await planGates({ projectRoot: project, gates: listGates(state), release: true });
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signals.push(signal);
    return originalKill.call(process, pid, signal);
  };
  try {
    const { run } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk, timeoutMs: 100 });
    assert.equal(run.gates.find((gate) => gate.name === "stop")?.timedOut, true);
    assert.deepEqual(run.gates.map((gate) => [gate.name, gate.ok]), [["pass", true], ["stop", false]]);
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
  const { run } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk, timeoutMs: 500, outputBytes: 1_024 });
  const byName = Object.fromEntries(run.gates.map((gate) => [gate.name, gate]));
  assert.equal(byName.chatty.ok, true);
  assert.equal(byName.chatty.truncated, true);
  assert.equal(byName.chatty.outputBytes, 1_024);
  assert.equal(byName.missing.ok, false);
  assert.equal(byName.missing.exitCode, null);
  assert.match(await readFile(join(gateRunsDirectory(state.metadata.workspaceId, desk), byName.missing.outputFile), "utf8"), /could not run: ENOENT/u);
  assert.equal(byName.slow.ok, false);
  assert.equal(byName.slow.timedOut, true);
  assert.deepEqual(run.reds, ["missing", "slow"]);
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
  const { project, desk, library } = await setup(context);
  const state = withWork(await declareAll(library, {
    unit: declare([node, "-e", "process.exit(require('node:fs').existsSync('src/ok') ? 0 : 1)"], ["src/**"]),
    lint: declare([node, "-e", "process.exit(2)"], ["src/**"], { required: false }),
    docs: declare([node, "-e", "process.exit(0)"], ["**/*.md"]),
  }));
  const done = (workIds = [STORY]) => assertDoneGates({ projectRoot: project, library: state, workIds, deviceHome: desk });
  await put(project, "src/a.ts", "export const a = 2;\n");

  const notRun = await refusal(() => done());
  assert.equal(notRun.reasonCode, "WORK_DONE_GATES_NOT_RUN");
  assert.equal(notRun.details.remedy, "gates-run");
  assert.deepEqual(notRun.details.stories, [STORY]);

  let plan = await planGates({ projectRoot: project, gates: listGates(state) });
  assert.deepEqual(plan.gates.map((gate) => gate.name), ["lint", "unit"], "the change's own gates");
  let { run } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk });
  assert.deepEqual(run.reds, ["lint", "unit"]);
  const red = await refusal(() => done());
  assert.equal(red.reasonCode, "WORK_DONE_GATES_RED");
  assert.deepEqual(red.details.reds, ["unit"], "only the required red gate holds the Story back");
  assert.equal(red.details.runId, run.runId);

  // Records that are not Stories are not held to the gates.
  assert.deepEqual(await done([EPIC]), { checked: false, reason: "no-story", runId: null, treeDigest: null });

  await put(project, "src/ok", "");
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_NOT_RUN", "a run made on another tree does not count");
  plan = await planGates({ projectRoot: project, gates: listGates(state) });
  ({ run } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: at(), deviceHome: desk }));
  assert.deepEqual(run.reds, ["lint"]);
  const verdict = await done();
  assert.equal(verdict.checked, true);
  assert.equal(verdict.reason, "green");
  assert.equal(verdict.runId, run.runId);
});

test("485-R4: a project that declares no enabled gate does not hold a Story back", async (context) => {
  const { project, desk, library } = await setup(context);
  const bare = withWork(await materializeWorkspace(library));
  assert.deepEqual(await assertDoneGates({ projectRoot: project, library: bare, workIds: [STORY], deviceHome: desk }), { checked: false, reason: "no-gates", runId: null, treeDigest: null });
  const disabled = withWork(await declareAll(library, { unit: declare([node, "-e", "process.exit(1)"], ["**"], { enabled: false }) }));
  assert.deepEqual(await assertDoneGates({ projectRoot: project, library: disabled, workIds: [STORY], deviceHome: desk }), { checked: false, reason: "no-gates", runId: null, treeDigest: null });
});

test("485-R4: a run counts only for the tree and declarations it was made on, and the latest one decides", async (context) => {
  const { project, desk, library } = await setup(context);
  const state = withWork(await declareAll(library, {
    unit: declare([node, "-e", "process.exit(process.env.GATE_EXIT === '0' ? 0 : 1)"], ["src/**"]),
  }));
  const libraryId = state.metadata.workspaceId;
  const done = () => assertDoneGates({ projectRoot: project, library: state, workIds: [STORY], deviceHome: desk });
  await put(project, "src/a.ts", "export const a = 3;\n");
  const plan = await planGates({ projectRoot: project, gates: listGates(state) });
  const green = { ...process.env, GATE_EXIT: "0" };
  const redEnvironment = { ...process.env, GATE_EXIT: "1" };

  // Two runs on one tree: the one with the later instant decides, whichever was made last.
  const early = at();
  const late = at();
  await runGates(plan, { libraryId, at: late, deviceHome: desk, env: redEnvironment });
  await runGates(plan, { libraryId, at: early, deviceHome: desk, env: green });
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_RED");
  const { run } = await runGates(plan, { libraryId, at: at(), deviceHome: desk, env: green });
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
    unit: declare([node, "-e", "process.exit(process.env.GATE_EXIT === '0' ? 0 : 1)"], ["src/**", "test/**"]),
  }));
  const other = await refusal(() => assertDoneGates({ projectRoot: project, library: redeclared, workIds: [STORY], deviceHome: desk }));
  assert.equal(other.reasonCode, "WORK_DONE_GATES_NOT_RUN", "a run under other declarations does not count");

  // A commit moves HEAD, so the run no longer describes the tree.
  git(project, ["commit", "-q", "-am", "change"]);
  assert.equal((await refusal(() => done())).reasonCode, "WORK_DONE_GATES_NOT_RUN");
});
