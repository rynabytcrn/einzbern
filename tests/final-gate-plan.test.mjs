// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-433 — production terminal replay and bounded rerun diagnosis.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGateImpactMap, createGateReceiptAuthority, executeQualifiedBatch, issueGateReceipt, qualifyBatch } from "../scripts/final-gate-plan.mjs";
import * as finalGatePlan from "../scripts/final-gate-plan.mjs";

const INPUTS = { sourceDigest: "source-433", environmentDigest: "environment-433", commandDigest: "command-433", baselineDigest: "baseline-433" };

function batchInput(overrides = {}) {
  return { ...INPUTS, series: "EPIC135", pack: "CHAIN-NATIVE", stage: "candidate-final", tasks: [], candidate: { id: "candidate-421", status: "stable", digest: "tree-421" }, queueDigest: "queue-421", trigger: "formal-batch-gate", ...overrides };
}

test("433 replays retained production terminal output and rejects an inner failure behind exit 0", async () => {
  const passedCapture = { ok: true, status: "completed", exitCode: 0, signal: null, stdout: JSON.stringify({ ok: true, status: "passed", exitCode: 0 }), stderr: "" };
  const passed = await executeQualifiedBatch(batchInput(), async () => passedCapture);
  assert.equal(passed.status, "completed");
  const innerFailure = { ...passedCapture, stdout: JSON.stringify({ ok: true, status: "completed", childResults: [{ assessment: { ok: false, reasonCode: "P1_DIAGNOSTIC_PRESENT" } }] }) };
  const rejected = await executeQualifiedBatch(batchInput(), async () => innerFailure);
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.reasonCode, "GATE_PLAN_TERMINAL_EVIDENCE_INVALID");
});

test("433 does not blindly rerun the same failed batch, but an explicit rerun marker does", async () => {
  const base = batchInput();
  const idempotencyKey = qualifyBatch(base).idempotencyKey;
  const prior = { id: "run-433-1", gateId: "gate-433", idempotencyKey, status: "failed", ok: false, reasonCode: "GATE_PLAN_TERMINAL_EVIDENCE_INVALID", inputs: INPUTS, stdout: "captured inner failure", stderr: "", exitCode: 0, signal: null };
  const input = batchInput({ gateId: "gate-433", previousRuns: [prior], lastError: { reasonCode: "GATE_PLAN_TERMINAL_EVIDENCE_INVALID" } });
  let calls = 0;
  const skipped = await executeQualifiedBatch(input, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 0);
  assert.equal(skipped.status, "failed");
  assert.equal(skipped.reasonCode, "BATCH_PRIOR_FAILURE_UNCHANGED");
  assert.equal(skipped.diagnostic.rerunAllowed, false);
  assert.match(skipped.diagnostic.nextAction, /stdout\/stderr\/exit\/signal/u);

  const rerun = await executeQualifiedBatch({ ...input, forceRerun: true }, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 1);
  assert.equal(rerun.status, "completed");
});

// TCRN-CROSS-STORY-460 (SUB-237). B1: a change under specs/ had no gate mapping, so the
// dynamic plan reported unknown impact and ran nothing. Specs are an engine-release face, as
// are schemas/ and extensions/. Red leg: drop the mapping.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINMENT = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "scripts/policy/gate-containment.json"), "utf8"));

test("STORY-460 AC2: a change to specs/ and a test selects engine-release with no unknown impact", () => {
  const impact = buildGateImpactMap({ containment: CONTAINMENT, changedFiles: ["specs/time-attestation-v1.md", "tests/inc378-attestation-repair.test.mjs"] });
  assert.deepEqual(impact.unknown, []);
  assert.deepEqual(impact.affected, ["engine-release"]);
  for (const path of ["schemas/cli-catalog-v1.schema.json", "extensions/aos-requirements-v1.json"]) {
    const other = buildGateImpactMap({ containment: CONTAINMENT, changedFiles: [path] });
    assert.deepEqual([other.unknown, other.affected], [[], ["engine-release"]], path);
  }
});

// B2: platform-doctor exits 1 while launchd is red, which the roster accepts for
// platform-layout, and the runner judged the root by exit code alone. A red root now passes
// only when every failing check carries a reason code its roster group accepts; any other red
// fails it. Red leg: take the exception judgement out and the launchd-only case fails.
const ROSTER = { groups: [{ id: "platform-layout", acceptedExceptions: [{ acceptedAt: "2026-08-15", reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY", reason: "OWNER_RULING_BACKUP_LAYERS_STOPPED" }] }, { id: "engine-release" }] };
const doctor = (checks) => ({ ok: false, status: 1, signal: null, stdout: `${JSON.stringify({ ok: false, checks })}\n`, stderr: "" });

test("STORY-460 AC3: a doctor root red only for a roster exception passes and names it; another red fails", () => {
  const apply = finalGatePlan.applyRosterExceptions ?? ((_id, result) => ({ result, acceptedExceptions: [] }));
  const launchdOnly = doctor([{ name: "launchd", ok: false, reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY" }, { name: "hooks", ok: true }]);
  const accepted = apply("platform-layout", launchdOnly, ROSTER);
  assert.equal(accepted.result.ok, true);
  assert.deepEqual(accepted.acceptedExceptions, ["PLATFORM_LAUNCHD_NOT_ON_DUTY"]);
  const twoReds = doctor([{ name: "launchd", ok: false, reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY" }, { name: "hooks", ok: false, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" }]);
  assert.equal(apply("platform-layout", twoReds, ROSTER).result.ok, false);
  assert.equal(apply("engine-release", launchdOnly, ROSTER).result.ok, false, "another group's exception is not this group's");
  assert.equal(apply("platform-layout", { ...launchdOnly, stdout: "not json" }, ROSTER).result.ok, false, "an unreadable result is not an exception");

  const entry = { id: "platform-layout", command: "node scripts/platform-doctor.mjs --platform-root <container>" };
  const invocation = { executable: "node", argv: ["scripts/platform-doctor.mjs", "--platform-root", resolve(REPOSITORY_ROOT, "../..")], cwd: REPOSITORY_ROOT, command: entry.command };
  const inputs = { sourceDigest: "source-460", environmentDigest: "environment-460", commandDigest: "command-460", baselineDigest: "baseline-460" };
  const receipt = issueGateReceipt(createGateReceiptAuthority(), { entry, invocation, inputs, result: launchdOnly, roster: ROSTER });
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.acceptedExceptions, ["PLATFORM_LAUNCHD_NOT_ON_DUTY"]);
  assert.equal(receipt.exitCode, 1, "the exit code stays what the root returned");
  const failed = issueGateReceipt(createGateReceiptAuthority(), { entry, invocation, inputs, result: twoReds, roster: ROSTER });
  assert.equal(failed.status, "failed");
});

// TCRN-CROSS-INC-383 (SUB-249). The receipt above says completed, yet the operational runner
// still required the root to exit 0: recordExecution threw GATE_PLAN_TERMINAL_EVIDENCE_INVALID
// for a platform-layout root red only on the launchd exception. A receipt completed by a
// roster exception now passes the runner with its real exit code and accepted codes, which
// are re-read from the tracked roster; a receipt issued against another roster does not pass.
// Red leg: take the exception allowance out of the trusted-receipt checks.
const FIXTURE_ROSTER_PATH = resolve(REPOSITORY_ROOT, "tests/fixtures/acceptance-gate-groups.json");
const FIXTURE_ROSTER = JSON.parse(readFileSync(FIXTURE_ROSTER_PATH, "utf8"));
const LAYOUT_INVOCATION = { executable: "node", argv: ["scripts/platform-doctor.mjs", "--platform-root", resolve(REPOSITORY_ROOT, "../..")], cwd: REPOSITORY_ROOT, command: "node scripts/platform-doctor.mjs --platform-root <container>" };

async function runLayoutRoot(doctorResult, issuingRoster = FIXTURE_ROSTER) {
  const inputs = { sourceDigest: "source-383", environmentDigest: "environment-383", commandDigest: "command-383", baselineDigest: "baseline-383" };
  const authority = createGateReceiptAuthority();
  const plan = finalGatePlan.buildDynamicGatePlan({ roster: FIXTURE_ROSTER, containment: CONTAINMENT, inputs, changedFiles: ["docs/platform-container-layout.md"], dependencies: [], configuration: [], generated: [], environment: [], crossRepoChanges: [], candidateReady: true, executionPermission: true, operational: true, requireCompleteImpact: true, gateInvocations: { "platform-layout": LAYOUT_INVOCATION }, receiptAuthority: authority });
  const receipts = [];
  let executed = null;
  let thrown = null;
  try {
    executed = await finalGatePlan.executeSelectedRoots(plan, async (entry) => {
      const receipt = issueGateReceipt(authority, { entry, invocation: entry.invocation, inputs: entry.inputs ?? inputs, result: doctorResult, roster: issuingRoster });
      receipts.push(receipt);
      return receipt;
    }, { getInputs: async () => inputs, rosterPath: FIXTURE_ROSTER_PATH });
  } catch (error) {
    thrown = error.reasonCode ?? String(error.message);
  }
  const outcome = thrown !== null ? `failed:${thrown}` : executed.executable === true && executed.blocked.length === 0 ? "completed" : "failed";
  return { plan, executed, receipts, outcome };
}

test("INC-383: the operational runner accepts a receipt completed by a roster exception", async () => {
  const launchdOnly = doctor([{ name: "launchd", ok: false, reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY" }, { name: "hooks", ok: true }]);
  const { plan, executed, receipts, outcome } = await runLayoutRoot(launchdOnly);
  assert.deepEqual(plan.selected.map(({ id }) => id), ["platform-layout"]);
  assert.equal(plan.integrity.requireInputObserver, true);
  assert.equal(outcome, "completed", JSON.stringify(executed?.blocked ?? outcome));
  assert.deepEqual(executed.blocked, []);
  assert.deepEqual(executed.executed.map(({ id, ok, status, exitCode, acceptedExceptions }) => ({ id, ok, status, exitCode, acceptedExceptions })), [{ id: "platform-layout", ok: true, status: "completed", exitCode: 1, acceptedExceptions: ["PLATFORM_LAUNCHD_NOT_ON_DUTY"] }]);
  const document = JSON.parse(readFileSync(receipts[0].terminalEvidence.path, "utf8"));
  assert.deepEqual([document.status, document.ok, document.exitCode, document.acceptedExceptions], ["completed", true, 1, ["PLATFORM_LAUNCHD_NOT_ON_DUTY"]], "the receipt keeps the real exit code and the accepted codes");
});

test("INC-383: another red, or an exception the tracked roster does not accept, still fails the runner", async () => {
  const withOtherRed = doctor([{ name: "launchd", ok: false, reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY" }, { name: "acceptanceVerdicts", ok: false, reasonCode: "PLATFORM_ACCEPTANCE_LANE_UNPROVEN" }]);
  const other = await runLayoutRoot(withOtherRed);
  assert.equal(other.receipts[0].status, "failed");
  assert.match(other.outcome, /^failed/u);

  const hooksOnly = doctor([{ name: "hooks", ok: false, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" }]);
  const forgedRoster = { groups: FIXTURE_ROSTER.groups.map((group) => group.id === "platform-layout" ? { ...group, acceptedExceptions: [{ acceptedAt: "2026-09-24", reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE", reason: "NOT_IN_THE_TRACKED_ROSTER" }] } : group) };
  const forged = await runLayoutRoot(hooksOnly, forgedRoster);
  assert.deepEqual([forged.receipts[0].status, forged.receipts[0].acceptedExceptions], ["completed", ["PLATFORM_HOOK_TARGET_UNAVAILABLE"]], "the issuing call was handed a roster that accepts the code");
  assert.equal(forged.outcome, "failed:GATE_PLAN_TERMINAL_EVIDENCE_INVALID", "the runner re-reads the tracked roster and refuses a self-reported exception");
});

// TCRN-CROSS-SUB-376 (STORY-491, Q12). Every receipt authority made its store with mkdtemp and
// nothing removed it, so each run of these tests and of the production batch entry left a
// tcrn-code-owned-gates-* directory in TMPDIR. The authority is process-local, so a store is of
// no use once its process is gone: it is removed when that process exits, and not before. A child
// process with its own TMPDIR issues and trusts a receipt, then exits with its own exit code.
// Red leg: take the exit-time removal out and both stores are still there.
test("SUB-376 Q12: a receipt store serves its process and is removed when that process exits", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tcrn-q12-receipt-store-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const child = [
    `import { existsSync } from "node:fs";`,
    `import { createGateReceiptAuthority, issueGateReceipt, queryGateReceipt } from ${JSON.stringify(pathToFileURL(resolve(REPOSITORY_ROOT, "scripts/final-gate-plan.mjs")).href)};`,
    `const entry = { id: "engine-release", command: "node scripts/push-gate.mjs" };`,
    `const invocation = { executable: "node", argv: ["scripts/push-gate.mjs"], cwd: ${JSON.stringify(REPOSITORY_ROOT)}, command: entry.command };`,
    `const inputs = { sourceDigest: "source-q12", environmentDigest: "environment-q12", commandDigest: "command-q12", baselineDigest: "baseline-q12" };`,
    `const first = createGateReceiptAuthority();`,
    `const second = createGateReceiptAuthority();`,
    `const receipt = issueGateReceipt(first, { entry, invocation, inputs, result: { ok: true, status: 0, signal: null, stdout: "", stderr: "" }, roster: { groups: [] } });`,
    `const trusted = queryGateReceipt(first, receipt.terminalEvidence, { gateId: entry.id, expectedInputs: inputs, expectedCommand: entry.command, expectedInvocation: invocation });`,
    `process.stdout.write(JSON.stringify({ stores: [first.storeRoot, second.storeRoot], receiptPresent: existsSync(receipt.terminalEvidence.path), trustedGate: trusted?.gateId ?? null }));`,
    `process.exitCode = 3;`,
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
  });
  assert.equal(run.status, 3, `the child keeps its own exit code: ${run.stderr}`);
  const observed = JSON.parse(run.stdout);
  assert.deepEqual([observed.receiptPresent, observed.trustedGate], [true, "engine-release"], "while the process runs its receipt is on disk and trusted");
  assert.equal(observed.stores.length, 2);
  for (const store of observed.stores) {
    assert.equal(dirname(store), temporaryRoot, "each store is made under the process's TMPDIR");
    assert.equal(existsSync(store), false, `${store} is removed when its process exits`);
  }
  assert.deepEqual(readdirSync(temporaryRoot).filter((name) => name.startsWith("tcrn-code-owned-gates-")), []);
});
