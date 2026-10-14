// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-537 (MIN-252 D3 BL-43, MIN-257 D6, Q10; TCRN-CROSS-SUB-488): the push gate leaves
// verify:p1 out only when the gate run it is part of has carried every P1 leg -- a gate named for the
// leg, in this repository, running the leg's own script, green, with its whole output and nothing the
// zero-warning rule rejects -- and names the run and the gates in its receipt (GWT1). A run on its
// own, or a run short of any one of those, runs verify:p1 in full (GWT2, GWT3). The decision is proved
// on the pure function, and the push gate's wiring through its timing probe, which starts no child.
// Every output file here is a temporary one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { P1_SEQUENCE } from "../scripts/p1-sequence.mjs";
import {
  GATE_RUN_PRIOR_VARIABLE,
  assessP1Coverage,
  commandRunsScript,
  gateNamesLeg,
  judgeLegOutput,
  parseGateRunPrior,
} from "../scripts/lib/push-gate-p1-coverage.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RUN_ID = "20261014T100000Z-0123456789ab";
const ROOT = "/projects/tcrn-workflow";
const OUTPUTS = `/device/cache/gate-runs/${RUN_ID}`;

// A leg's terminal receipt as its gate prints it; the test leg's carries an empty `errors`, as the
// real one does.
function receiptFor(leg) {
  if (!leg.dispatchesThroughTask) return { ok: true, reasonCode: "PORTAL_VERIFY_TRAIN_GREEN", commands: [], unverified: [], observations: [] };
  const receipt = { ok: true, command: leg.task, reasonCode: `${leg.task.toUpperCase().replaceAll("-", "_")}_VERIFIED` };
  return leg.task === "test" ? { ...receipt, tests: ["tests/a.test.mjs"], result: "passed", progress: { status: "completed", errors: [] } } : receipt;
}

/** A run whose gates carry every leg, the way the engine's library declares them, then engine:release's turn. */
function fullRun({ root = ROOT, outputs = OUTPUTS } = {}) {
  const gates = P1_SEQUENCE.map((leg, index) => ({
    name: `engine:${leg.task}`,
    root: "TCRN Platform/tcrn-workflow",
    directory: root,
    command: ["corepack", "pnpm@11.3.0", "run", "--silent", leg.script],
    ok: true,
    truncated: false,
    outputFile: `${outputs}/${index + 1}-engine_${leg.task}.log`,
  }));
  const files = new Map(P1_SEQUENCE.map((leg, index) => [gates[index].outputFile, `${JSON.stringify(receiptFor(leg))}\n`]));
  return { gates, files };
}

function assess({ gates, files }, extra = {}) {
  return assessP1Coverage({
    prior: JSON.stringify({ runId: RUN_ID, gates }),
    repositoryRoot: ROOT,
    readOutput: (path) => (files.has(path) ? Buffer.from(files.get(path), "utf8") : null),
    ...extra,
  });
}

const legRow = (coverage, task) => coverage.legs.find((row) => row.leg === task);

function change(run, task, edit) {
  const index = P1_SEQUENCE.findIndex((leg) => leg.task === task);
  const gates = run.gates.map((gate, at) => (at === index ? { ...gate, ...edit } : gate));
  return { gates, files: run.files };
}

test("537-GWT1: every leg green, whole and warning-free in this repository is carried, and the coverage names the run and each leg's gate", () => {
  const run = fullRun();
  const coverage = assess(run);
  assert.equal(coverage.covered, true, JSON.stringify(coverage.legs.filter((row) => !row.ok)));
  assert.equal(coverage.reasonCode, "P1_COVERED_BY_GATE_RUN");
  assert.equal(coverage.runId, RUN_ID);
  assert.deepEqual(coverage.legs.map(({ leg, gate }) => [leg, gate]), P1_SEQUENCE.map((leg) => [leg.task, `engine:${leg.task}`]));
  for (const [index, row] of coverage.legs.entries()) {
    assert.equal(row.outputFile, run.gates[index].outputFile);
    assert.match(row.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("537-GWT2: a run short of a leg, or with a red, cut or diagnostic-bearing leg, is not carried; each says which leg and why", () => {
  const run = fullRun();
  const missing = { gates: run.gates.filter((gate) => gate.name !== "engine:links"), files: run.files };
  const cases = [
    ["a leg has no gate", missing, "links", "P1_LEG_GATE_MISSING"],
    ["a leg is red", change(run, "lint", { ok: false }), "lint", "P1_LEG_GATE_RED"],
    ["a leg's output was cut", change(run, "test", { truncated: true }), "test", "P1_LEG_OUTPUT_TRUNCATED"],
  ];
  const warned = new Map(run.files);
  const typecheckFile = run.gates[P1_SEQUENCE.findIndex((leg) => leg.task === "typecheck")].outputFile;
  warned.set(typecheckFile, `warning: TS6385 'x' is deprecated\n${warned.get(typecheckFile)}`);
  cases.push(["a leg's output carries a warning", { gates: run.gates, files: warned }, "typecheck", "P1_LEG_DIAGNOSTIC_PRESENT"]);
  const unreadable = new Map(run.files);
  unreadable.delete(run.gates[0].outputFile);
  cases.push(["a leg's output cannot be read", { gates: run.gates, files: unreadable }, "format-check", "P1_LEG_OUTPUT_UNREADABLE"]);
  const twice = new Map(run.files);
  const offlineFile = run.gates[P1_SEQUENCE.findIndex((leg) => leg.task === "offline")].outputFile;
  twice.set(offlineFile, `${twice.get(offlineFile)}${twice.get(offlineFile)}`);
  cases.push(["a leg printed its receipt twice", { gates: run.gates, files: twice }, "offline", "P1_LEG_RECEIPT_MISSING"]);
  for (const [label, shaped, task, reasonCode] of cases) {
    const coverage = assess(shaped);
    assert.equal(coverage.covered, false, label);
    assert.equal(coverage.reasonCode, "P1_COVERAGE_INCOMPLETE", label);
    assert.equal(legRow(coverage, task).ok, false, label);
    assert.equal(legRow(coverage, task).reasonCode, reasonCode, label);
    assert.equal(coverage.legs.filter((row) => !row.ok).length, 1, `${label}: only that leg is short`);
  }
});

test("537-GWT3: a leg's gate in another root, or running another command, is not relied on", () => {
  const run = fullRun();
  const foreign = assess(change(run, "test", { directory: "/projects/tcrn-workflow-helper" }));
  assert.equal(foreign.covered, false);
  assert.equal(legRow(foreign, "test").reasonCode, "P1_LEG_ROOT_FOREIGN");
  for (const command of [
    ["corepack", "pnpm@11.3.0", "run", "--silent", "test", "--", "--test-name-pattern", "537"],
    ["corepack", "pnpm@11.3.0", "run", "--silent", "verify:privacy"],
    ["node", "scripts/task.mjs", "test"],
    ["npx", "pnpm", "run", "test"],
  ]) {
    const mismatched = assess(change(run, "test", { command }));
    assert.equal(mismatched.covered, false, JSON.stringify(command));
    assert.equal(legRow(mismatched, "test").reasonCode, "P1_LEG_COMMAND_MISMATCH", JSON.stringify(command));
  }
  // A second gate named for the leg in this repository still carries it when the foreign one does not.
  const helper = { ...run.gates[P1_SEQUENCE.findIndex((leg) => leg.task === "test")], name: "helper:test", directory: "/projects/tcrn-workflow-helper" };
  assert.equal(assess({ gates: [helper, ...run.gates], files: run.files }).covered, true);
});

test("537-GWT2: on its own, with the test seam set, or with a variable that does not parse, verify:p1 is not left out", () => {
  const run = fullRun();
  assert.equal(assessP1Coverage({ prior: undefined, repositoryRoot: ROOT, readOutput: () => null }), null, "no run: nothing to assess");
  const injected = assess(run, { injection: JSON.stringify({ lint: "LINT_INJECTED" }) });
  assert.deepEqual([injected.covered, injected.reasonCode], [false, "P1_COVERAGE_INJECTION_SET"]);
  for (const prior of ["not json", "[]", JSON.stringify({ runId: RUN_ID }), JSON.stringify({ runId: "", gates: [] }),
    JSON.stringify({ runId: RUN_ID, gates: [{ ...run.gates[0], outputFile: "relative/1-engine_format-check.log" }] }),
    JSON.stringify({ runId: RUN_ID, gates: [{ ...run.gates[0], outputFile: `/device/cache/gate-runs/another-run/1-engine_format-check.log` }] }),
    JSON.stringify({ runId: RUN_ID, gates: [{ ...run.gates[0], ok: "true" }] })]) {
    assert.equal(parseGateRunPrior(prior).ok, false, prior);
    const coverage = assessP1Coverage({ prior, repositoryRoot: ROOT, readOutput: () => null });
    assert.deepEqual([coverage.covered, coverage.reasonCode], [false, "P1_COVERAGE_PRIOR_INVALID"], prior);
  }
  const empty = assessP1Coverage({ prior: JSON.stringify({ runId: RUN_ID, gates: [] }), repositoryRoot: ROOT, readOutput: () => null });
  assert.equal(empty.covered, false, "the first gate of a run carries nothing");
  assert.equal(empty.legs.every((row) => row.reasonCode === "P1_LEG_GATE_MISSING"), true);
});

test("537: a leg's gate is named for it and runs exactly its script; its receipt is judged as P1's receipt is", () => {
  assert.equal(gateNamesLeg("engine:test", "test"), true);
  assert.equal(gateNamesLeg("test", "test"), true);
  assert.equal(gateNamesLeg("engine:test-wiring", "test"), false);
  assert.equal(gateNamesLeg("engine:contest", "test"), false);
  for (const command of [["pnpm", "run", "test"], ["pnpm", "run", "--silent", "test"], ["pnpm", "run", "-s", "test"], ["corepack", "pnpm", "run", "test"], ["corepack", "pnpm@11.3.0", "run", "--silent", "test"]]) {
    assert.equal(commandRunsScript(command, "test"), true, JSON.stringify(command));
  }
  for (const command of [["pnpm", "test"], ["pnpm", "run", "--silent", "--silent", "test"], ["corepack", "pnpm@latest", "run", "test"], ["pnpm", "run", "test", "x"], ["pnpm", "exec", "test"]]) {
    assert.equal(commandRunsScript(command, "test"), false, JSON.stringify(command));
  }
  const testLeg = P1_SEQUENCE.find((leg) => leg.task === "test");
  const portalLeg = P1_SEQUENCE.find((leg) => leg.task === "portal");
  assert.equal(judgeLegOutput(`${JSON.stringify(receiptFor(testLeg))}\n`, testLeg), "P1_LEG_COVERED");
  assert.equal(judgeLegOutput(`${JSON.stringify(receiptFor(portalLeg))}\n`, portalLeg), "P1_LEG_COVERED");
  assert.equal(judgeLegOutput(`${JSON.stringify({ ...receiptFor(testLeg), progress: { errors: ["one test failed"] } })}\n`, testLeg), "P1_LEG_DIAGNOSTIC_PRESENT");
  assert.equal(judgeLegOutput(`${JSON.stringify({ ok: true, command: "lint", reasonCode: "LINT_VERIFIED" })}\n`, testLeg), "P1_LEG_RECEIPT_MISSING", "another leg's receipt");
  assert.equal(judgeLegOutput(`${JSON.stringify({ ...receiptFor(portalLeg), command: "portal" })}\n`, portalLeg), "P1_LEG_RECEIPT_MISSING", "the portal leg's receipt has no command");
  assert.equal(judgeLegOutput(Buffer.from([0xff, 0xfe, 0x0a]), testLeg), "P1_LEG_OUTPUT_UNREADABLE");
});

// The push gate's timing probe runs every stage and writes the real receipt but starts no child: what
// it does with verify:p1 is what the real gate does.
async function probePushGate(context, prior) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-push-gate-p1-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, TCRN_PUSH_GATE_TIMING_PROBE: "1", TCRN_PUSH_GATE_TIMING_EVIDENCE_PATH: join(base, "timing.json"), TCRN_PUSH_GATE_PROGRESS_EVIDENCE_PATH: join(base, "progress.json") };
  delete env[GATE_RUN_PRIOR_VARIABLE];
  delete env.EINZBERN_P1_INJECT;
  if (prior !== undefined) {
    const outputs = join(base, "gate-runs", RUN_ID);
    await mkdir(outputs, { recursive: true });
    const run = prior(fullRun({ root: await realpath(REPO_ROOT), outputs }));
    for (const [path, text] of run.files) await writeFile(path, text);
    env[GATE_RUN_PRIOR_VARIABLE] = JSON.stringify({ runId: RUN_ID, gates: run.gates });
  }
  const probe = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/push-gate.mjs")], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(probe.status, 0, `${probe.stdout ?? ""}${probe.stderr ?? ""}`);
  const receipt = JSON.parse(probe.stdout.trimEnd());
  const timing = JSON.parse(await readFile(join(base, "timing.json"), "utf8"));
  return { receipt, stages: timing.stages.map(({ name }) => name) };
}

test("537-GWT1 wiring: inside a run that carries every leg, the push gate starts no verify:p1 and its receipt names the run and the gates", async (context) => {
  const { receipt, stages } = await probePushGate(context, (run) => run);
  assert.equal(receipt.reasonCode, "PUSH_GATE_VERIFIED");
  const [p1, p8] = receipt.childResults;
  assert.equal(p1.script, "verify:p1");
  assert.equal(p1.notStarted, true);
  assert.deepEqual(p1.assessment, { ok: true, reasonCode: "P1_COVERED_BY_GATE_RUN", findings: [] });
  assert.equal(p1.coveredBy.runId, RUN_ID);
  assert.deepEqual(p1.coveredBy.gates.map(({ leg, gate }) => [leg, gate]), P1_SEQUENCE.map((leg) => [leg.task, `engine:${leg.task}`]));
  assert.equal(p8.script, "verify:p8", "verify:p8 is judged as before");
  assert.equal(Object.hasOwn(p8, "coveredBy"), false);
  assert.equal(stages.includes("child:verify:p1") && stages.includes("child:verify:p8"), true, "the decision is timed as verify:p1's stage");
});

test("537-GWT2 wiring: a run short of a leg, and the push gate on its own, run verify:p1 in full", async (context) => {
  const short = await probePushGate(context, (run) => ({ gates: run.gates.filter((gate) => gate.name !== "engine:retrieval-eval"), files: run.files }));
  const [p1] = short.receipt.childResults;
  assert.equal(p1.notStarted, undefined, "verify:p1 ran");
  assert.equal(Object.hasOwn(p1, "coveredBy"), false);
  assert.equal(p1.p1Coverage.covered, false);
  assert.deepEqual(p1.p1Coverage.legs.filter((row) => !row.ok).map(({ leg, reasonCode }) => [leg, reasonCode]), [["retrieval-eval", "P1_LEG_GATE_MISSING"]]);

  const alone = await probePushGate(context, undefined);
  const [own] = alone.receipt.childResults;
  assert.equal(own.notStarted, undefined, "verify:p1 ran");
  assert.equal(Object.hasOwn(own, "coveredBy") || Object.hasOwn(own, "p1Coverage"), false, "a push gate on its own has nothing to say about a run");
});
