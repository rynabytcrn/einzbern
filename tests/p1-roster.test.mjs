// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-218 — the P1 roster is one list, and each entry points at itself.
//
// Sharing the list removes the drift between the two runners. It does not remove the
// smaller drift inside an entry: a roster naming the verb `source` beside a script that
// runs something else would still read as coverage while covering the wrong thing. So
// each pair is checked against package.json rather than trusted.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { P1_SEQUENCE, P1_TASKS, P1_GATE_SPECS } from "../scripts/p1-sequence.mjs";
import { P1_GATE_SPECS as PREFLIGHT_SPECS } from "../scripts/preflight.mjs";
import { buildRedLocatorPlan, containedGroupIds, locateContainedGates } from "../scripts/gate-red-locator.mjs";
import { buildContainedExecutionPlan, ENGINE_PUSH_GATE_CHILDREN, inspectP8FailureTerminal, pushGateChildConclusion, pushGateExecutionPlan } from "../scripts/lib/push-gate-children.mjs";
import { validateHostEvidenceProvenance } from "../scripts/lib/push-gate-output.mjs";
import { P8_VERSION, p8FailureTerminal } from "../scripts/lib/p8-workflow-rc.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts;

test("preflight runs the roster, not a copy of it", () => {
  // The identity is the whole point: preflight's list and P1's list must be the same
  // object, so a gate added to one cannot be missing from the other.
  assert.equal(PREFLIGHT_SPECS, P1_GATE_SPECS);
  assert.deepEqual(PREFLIGHT_SPECS.map(([key]) => key), P1_TASKS);
});

test("every rostered script exists", () => {
  for (const { task, script } of P1_SEQUENCE) {
    assert.equal(typeof scripts[script], "string", `${task} names package script ${script}, which does not exist`);
  }
  // The README's four statements of the P1 gate count were checked here against the roster.
  // TCRN-CROSS-STORY-486 (SUB-347) replaced that README with the rendered Einzbern README,
  // which states no gate count, so the check went with the claims it held to the roster.
});

test("a rostered script dispatches the verb it is listed beside", () => {
  for (const { task, script, dispatchesThroughTask } of P1_SEQUENCE) {
    const dispatched = scripts[script].match(/^node scripts\/task\.mjs ([a-z0-9-]+)$/u);
    if (dispatchesThroughTask) {
      assert.ok(dispatched, `${script} should dispatch through task.mjs but runs: ${scripts[script]}`);
      assert.equal(dispatched[1], task, `${script} runs task ${dispatched[1]}, not ${task}`);
      continue;
    }
    // The declared exception, and it must stay an exception: if the script ever starts
    // dispatching through task.mjs, the roster entry is stale and should drop the flag.
    assert.equal(dispatched, null, `${script} now dispatches through task.mjs — drop dispatchesThroughTask:false`);
  }
});

test("the two gates this drift hid are on the roster", () => {
  // Named rather than counted. A count goes green again the moment any two gates exist,
  // including two that are not these — and these two are the ones that were missing:
  // `no-sibling-dependency` proves the repository stands without its siblings, and the
  // isolated clone was the one world not running it.
  assert.ok(P1_TASKS.includes("no-sibling-dependency"));
  assert.ok(P1_TASKS.includes("portal"));
});

test("467-R4/R5: the roster is the twelve retained legs, in order", () => {
  // TCRN-CROSS-STORY-467 R2 removed source, verification-map, governance and budget with
  // the scripts they ran; the retained list is stated literally so a removal is an edit here.
  assert.deepEqual([...P1_TASKS], [
    "format-check", "lint", "typecheck", "build", "test", "portal", "archive",
    "no-sibling-dependency", "offline", "privacy", "links", "retrieval-eval",
  ]);
});

test("the roster names each verb once", () => {
  assert.equal(new Set(P1_TASKS).size, P1_TASKS.length);
});

test("STORY-349 top-level gate containment selects roots and preserves the semantic roster", () => {
  // MIN-149 removed helper-release and helper-suite with STORY-382: the helper repository
  // no longer carries the two scripts those groups ran. The order is asserted literally
  // rather than by count so that removing a group is a visible edit here, not a number.
  const declaration = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/policy/gate-containment.json"), "utf8"));
  assert.deepEqual(declaration.topLevel, ["engine-release", "platform-layout", "product-gates"]);
  assert.deepEqual(declaration.executionOrder, [
    "engine-release", "platform-layout", "product-gates",
  ]);
  const groups = new Map(declaration.groups.map((group) => [group.id, group]));
  // TCRN-CROSS-STORY-467 R2 removed engine-guards with the guard mutation check it ran.
  assert.deepEqual(groups.get("engine-release").contains, ["engine-p1", "engine-p8"]);
  assert.deepEqual(groups.get("engine-p1").contains, ["engine-suite"]);
  assert.equal(groups.get("engine-p8").command, "pnpm verify:p8");
  assert.equal(groups.has("helper-release"), false);
  assert.equal(groups.has("helper-suite"), false);
  assert.deepEqual(groups.get("platform-layout").contains, ["chain-validate"]);
  assert.deepEqual(ENGINE_PUSH_GATE_CHILDREN.map(({ script }) => script), ["verify:p1", "verify:p8"]);
});

test("STORY-413 final gate planning selects each top-level root once and records containment", () => {
  const declaration = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/policy/gate-containment.json"), "utf8"));
  const plan = buildContainedExecutionPlan(declaration);
  assert.deepEqual(plan.selected.map(({ id }) => id), declaration.topLevel);
  assert.deepEqual(plan.coveredBy.map(({ id, coveredBy }) => ({ id, coveredBy })), [
    { id: "engine-p1", coveredBy: "engine-release" },
    { id: "engine-suite", coveredBy: "engine-release" },
    { id: "engine-p8", coveredBy: "engine-release" },
    { id: "chain-validate", coveredBy: "platform-layout" },
  ]);
  const pushPlan = pushGateExecutionPlan(declaration);
  assert.deepEqual(pushPlan.pushGateChildren.map(({ id, script }) => ({ id, script })), [
    { id: "engine-p1", script: "verify:p1" },
    { id: "engine-p8", script: "verify:p8" },
  ]);
  const wrongOrder = { ...declaration, executionOrder: ["engine-p1", "engine-release", "platform-layout"] };
  assert.throws(() => buildContainedExecutionPlan(wrongOrder), (error) => error.reasonCode === "GATE_CONTAINMENT_ROOT_ORDER_INVALID");
  const wrongChild = { ...declaration, groups: declaration.groups.map((group) => group.id === "engine-p8" ? { ...group, command: "pnpm verify:p1" } : group) };
  assert.throws(() => pushGateExecutionPlan(wrongChild), (error) => error.reasonCode === "GATE_CONTAINMENT_PUSH_PLAN_INVALID");
  const cyclic = { ...declaration, groups: declaration.groups.map((group) => group.id === "engine-p1" ? { ...group, contains: ["engine-p1"] } : group) };
  assert.throws(() => buildContainedExecutionPlan(cyclic), (error) => error.reasonCode === "GATE_CONTAINMENT_CYCLE");
  const assertDirectCycle = (groups, target) => assert.throws(
    () => containedGroupIds({ schemaVersion: "tcrn.gate-containment.v1", groups }, "root"),
    (error) => error.reasonCode === "GATE_CONTAINMENT_CYCLE" && error.message === target,
  );
  assertDirectCycle([{ id: "root", contains: ["root"] }], "root");
  assertDirectCycle([{ id: "root", contains: ["child"] }, { id: "child", contains: ["root"] }], "root");
});

test("interrupted push-gate children are not-verifiable", () => {
  assert.equal(pushGateChildConclusion({ exitCode: 0, signal: null, error: null }), "verified");
  assert.equal(pushGateChildConclusion({ exitCode: 1, signal: null, error: null }), "blocked");
  assert.equal(pushGateChildConclusion({ exitCode: 1, signal: "SIGTERM", error: null }), "not-verifiable");
  assert.equal(pushGateChildConclusion({ exitCode: 1, signal: null, error: { code: "ETIMEDOUT" } }), "not-verifiable");
});

test("a P8 failure terminal is observable while the child remains blocked", () => {
  const receipt = p8FailureTerminal({ reasonCode: "PRIVACY_FINDINGS", error: "OWNER_PRIVATE_IDENTIFIER:build" });
  const result = { exitCode: 1, signal: null, error: null };
  const assessment = inspectP8FailureTerminal({
    stdout: Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"),
    stderr: Buffer.alloc(0),
    ...result,
  });
  assert.equal(assessment.ok, true);
  assert.equal(assessment.reasonCode, "P8_FAILURE_TERMINAL_VALID");
  assert.equal(assessment.terminalReasonCode, "PRIVACY_FINDINGS");
  assert.equal(pushGateChildConclusion(result), "blocked");

  const missing = inspectP8FailureTerminal({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...result });
  assert.equal(missing.ok, false);
  assert.ok(missing.findings.some((finding) => finding.code === "CHILD_TERMINAL_MISSING"));
  const successExit = inspectP8FailureTerminal({ stdout: Buffer.from(`${JSON.stringify(receipt)}\n`), stderr: "", exitCode: 0, signal: null, error: null });
  assert.equal(successExit.ok, false);
  assert.ok(successExit.findings.some((finding) => finding.code === "P8_FAILURE_TERMINAL_EXIT_INVALID"));
});

test("STORY-350 red locator runs every contained child separately and returns each conclusion", async () => {
  const declaration = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/policy/gate-containment.json"), "utf8"));
  const plan = buildRedLocatorPlan(declaration, "engine-release");
  const calls = [];
  const result = await locateContainedGates(declaration, "engine-release", {
    runner: async (spec) => {
      calls.push(spec.id);
      return { ok: spec.id !== "engine-p1", reasonCode: spec.id === "engine-p1" ? "GATE_CHILD_RED" : "GATE_CHILD_GREEN" };
    },
  });
  assert.deepEqual(calls, plan.map((spec) => spec.id));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "GATE_RED_LOCATED");
  assert.deepEqual(result.children.map(({ id, ok }) => ({ id, ok })), [
    { id: "engine-p1", ok: false },
    { id: "engine-suite", ok: true },
    { id: "engine-p8", ok: true },
  ]);
  for (const [value, code] of [[null, "PUSH_GATE_HOST_EVIDENCE_INVALID"], [{ observedAt: "bad" }, "PUSH_GATE_HOST_EVIDENCE_INVALID"], [{ observedAt: "2026-09-19", supersededBy: "x", currentClaim: "active" }, "PUSH_GATE_HOST_EVIDENCE_PROVENANCE_INVALID"]]) assert.equal(validateHostEvidenceProvenance(value).reasonCode, code);
  assert.equal(validateHostEvidenceProvenance({ observedAt: "2026-09-19", supersededBy: "x", currentClaim: "none" }).ok, true);
});

const probeTimingPath = resolve(REPO_ROOT, "dist/evidence/p1/push-gate-timing-probe.json");
const probeProgressPath = resolve(REPO_ROOT, "dist/evidence/p1/push-gate-progress-probe.json");
const pushGatePath = resolve(REPO_ROOT, "scripts/push-gate.mjs");

// TCRN-CROSS-INC-271: derive stage roster from source rather than restating it.
// Parsing timedStage calls ensures the list cannot drift again when push-gate.mjs
// adds a new stage.
function deriveExpectedTimingStages() {
  const pushGateSource = readFileSync(pushGatePath, "utf8");

  // Match explicit timedStage("<name>", ...) calls with quoted string literals.
  // The ENGINE_PUSH_GATE_CHILDREN loop uses backtick templates, so it is not matched.
  const explicitMatches = [...pushGateSource.matchAll(/await timedStage\("([^"]+)"/gu)];
  const allExplicitStages = explicitMatches.map((m) => m[1]);

  // Explicit stages are: [git-status-before, ..., tag-ancestry, git-status-after].
  // We want: [git-status-before, ..., tag-ancestry, child:*, git-status-after].
  // So we exclude git-status-after, add child stages, then add git-status-after back.
  const stagesBeforeFinal = allExplicitStages.slice(0, -1);

  // The ENGINE_PUSH_GATE_CHILDREN loop generates child:<script> stages.
  // Scripts are ["verify:p1", "verify:p8"] per lib/push-gate-children.mjs.
  const childStages = ["child:verify:p1", "child:verify:p8"];

  // git-status-after is the final stage, added explicitly after the loop.
  return [...stagesBeforeFinal, ...childStages, "git-status-after"];
}

const expectedTimingStages = deriveExpectedTimingStages();

test("INC-266 push-gate timing accounts for every phase and keeps the success output contract", async () => {
  const pushGateSource = readFileSync(pushGatePath, "utf8");

  // Assert 1: The derived roster is non-empty and contains no duplicate stage names.
  // A duplicate stage name would cause the accounting to overwrite itself and lose a phase.
  assert.ok(expectedTimingStages.length > 0, "expected timing stages list is empty");
  const uniqueStages = new Set(expectedTimingStages);
  assert.equal(
    uniqueStages.size,
    expectedTimingStages.length,
    `stage roster has duplicates: ${expectedTimingStages.filter((s, i) => expectedTimingStages.indexOf(s) !== i).join(", ")}`,
  );

  // Assert 2: Every timedStage call in push-gate.mjs is awaited.
  // An unawaited timedStage would run outside the accounting, and its time would vanish from the
  // total -- the opposite of "accounts for every phase".
  // Count calls that match "await timedStage(" (actual awaited calls) versus all timedStage( calls.
  // Exclude the function definition itself (which is not a call).
  const awaitedCalls = [...pushGateSource.matchAll(/await\s+timedStage\(/gu)].length;
  const allCalls = [...pushGateSource.matchAll(/timedStage\(/gu)];
  const nonDefinitionCalls = allCalls.filter((match) => {
    // Exclude the function definition: check if preceded by "async function"
    const before = pushGateSource.slice(Math.max(0, match.index - 50), match.index);
    return !/async\s+function\s*$/.test(before);
  }).length;
  assert.equal(
    awaitedCalls,
    nonDefinitionCalls,
    `${nonDefinitionCalls - awaitedCalls} timedStage call(s) are not awaited; all calls must be awaited`,
  );

  // Assert 3: Every child stage the roster expects is declared in ENGINE_PUSH_GATE_CHILDREN.
  // This ensures the test's derived list matches the actual loop that generates child stages,
  // rather than being a second hand-written copy that can drift.
  const childStagesFromRoster = expectedTimingStages.filter((name) => name.startsWith("child:"));
  const scriptsFromRoster = childStagesFromRoster.map((name) => name.slice("child:".length));
  const scriptsFromEngine = ENGINE_PUSH_GATE_CHILDREN.map(({ script }) => script);
  assert.deepEqual(
    scriptsFromRoster,
    scriptsFromEngine,
    "child stage roster does not match ENGINE_PUSH_GATE_CHILDREN",
  );

  // Assert 4: push-gate.mjs writes the timing document with the correct schema version and structure.
  // Assert against the SOURCE TEXT, not a fabricated document: verify the source actually contains
  // the correct schema version string and writes it to the output.
  assert.ok(
    pushGateSource.includes('schemaVersion: "tcrn.push-gate-timing.v1"'),
    'push-gate.mjs must write schemaVersion: "tcrn.push-gate-timing.v1"',
  );
  assert.ok(
    pushGateSource.includes('command: "node scripts/push-gate.mjs"'),
    'push-gate.mjs must write command: "node scripts/push-gate.mjs"',
  );
  assert.ok(
    pushGateSource.includes("stages: stageTimings"),
    "push-gate.mjs must write stages from the stageTimings array",
  );
  assert.ok(pushGateSource.includes('schemaVersion: "tcrn.push-gate-progress.v1"'));

  // The real gate is intentionally expensive. Its test-only probe executes the same
  // timing wrappers and final stdout writer, but does not launch the child gates.
  // The parent test captures that process's actual stdout and compares it with the
  // evidence written after stdout has been emitted; no second producer reconstructs it.
  await rm(probeTimingPath, { force: true });
  await rm(probeProgressPath, { force: true });
  const probe = spawnSync(process.execPath, [pushGatePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      TCRN_PUSH_GATE_TIMING_PROBE: "1",
      TCRN_PUSH_GATE_TIMING_EVIDENCE_PATH: probeTimingPath,
      TCRN_PUSH_GATE_PROGRESS_EVIDENCE_PATH: probeProgressPath,
    },
  });
  assert.equal(probe.status, 0, `${probe.stdout ?? ""}${probe.stderr ?? ""}`);
  assert.equal(probe.stderr, "");
  const observedStdout = probe.stdout.trimEnd();
  const observedContract = JSON.parse(observedStdout);
  assert.deepEqual(Object.keys(observedContract), ["ok", "reasonCode", "version", "childResults"]);
  assert.deepEqual(
    { ok: observedContract.ok, reasonCode: observedContract.reasonCode, version: observedContract.version },
    { ok: true, reasonCode: "PUSH_GATE_VERIFIED", version: P8_VERSION },
  );
  assert.deepEqual(observedContract.childResults.map(({ script }) => script), ENGINE_PUSH_GATE_CHILDREN.map(({ script }) => script));
  assert.ok(observedContract.childResults.every(({ exit }) => exit.status === 0 && exit.signal === null && exit.error === null));
  const probeEvidence = JSON.parse(await readFile(probeTimingPath, "utf8"));
  const progressEvidence = JSON.parse(await readFile(probeProgressPath, "utf8"));
  assert.equal(probeEvidence.stdoutObserved, observedStdout);
  assert.equal(probeEvidence.sourceDigest, createHash("sha256").update(await readFile(pushGatePath)).digest("hex"));
  assert.ok(probeEvidence.stages.every((stage) => !Object.hasOwn(stage, "line")));
  assert.deepEqual(probeEvidence.stages.map(({ name }) => name), expectedTimingStages);
  assert.equal(progressEvidence.conclusion, "verified");
  assert.equal(progressEvidence.reasonCode, "PUSH_GATE_VERIFIED");
  assert.equal(progressEvidence.activeStage, null);
  assert.deepEqual(progressEvidence.completedStages.map(({ name }) => name), expectedTimingStages);
});
