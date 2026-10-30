// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LIGHT_STEPS, LIGHT_TESTS, P1_CLASSIFICATION, canonical, lightRoster } from "../scripts/ci/light-roster.mjs";
import { judgeLightStep } from "../scripts/ci/light-runner.mjs";
import { verifyBaseline } from "../scripts/ci/baseline-evidence.mjs";
import { P1_SEQUENCE, P1_TASKS } from "../scripts/p1-sequence.mjs";
import { judgeLegOutput } from "../scripts/lib/push-gate-p1-coverage.mjs";

const executed = { exitCode: 0, signal: null, status: "executed" };
const totals = (patch = {}) => Object.entries({ tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 1, ...patch }).map(([key, value]) => `# ${key} ${value}\n`).join("");

test("ci-light has an exact bounded roster, explicit full-P1 classification and honest coverage", () => {
  assert.deepEqual(LIGHT_STEPS.map(row => row.id), ["format-check", "links", "test-wiring", "lint", "build", "contracts", "portal-proof", "ds-reconcile", "ds-proof", "no-sibling-dependency", "offline", "retrieval-eval", "archive", "privacy"]);
  assert.deepEqual(Object.keys(P1_CLASSIFICATION).sort(), [...P1_TASKS].sort());
  assert.equal(P1_CLASSIFICATION.typecheck, "nested:build");
  assert.equal(P1_CLASSIFICATION.test, "notRunHere");
  assert.equal(P1_CLASSIFICATION.portal, "notRunHere");
  assert.deepEqual(LIGHT_TESTS, ["tests/ci-artifact-transport.test.mjs", "tests/ci-light-contract.test.mjs", "tests/ci-light-evidence.test.mjs", "tests/ci-test-roster.test.mjs", "tests/cross-repo-privacy.test.mjs", "tests/p1-roster.test.mjs", "tests/protocol-proof.test.mjs", "tests/protocol-v1.test.mjs"]);
  assert.ok(LIGHT_TESTS.every(path => !/[?*]/u.test(path)));
  const seen = new Set();
  for (const row of LIGHT_STEPS) {
    assert.ok(!seen.has(row.id));
    for (const dependency of row.requires) assert.ok(seen.has(dependency), `${row.id} must follow ${dependency}`);
    seen.add(row.id);
  }
  assert.deepEqual(LIGHT_STEPS.find(row => row.id === "privacy").requires, ["archive"]);
  const { rosterDigest, ...roster } = lightRoster();
  assert.equal(rosterDigest, createHash("sha256").update(JSON.stringify(canonical(roster))).digest("hex"));
  assert.equal(roster.coverage, "light");
  assert.equal(roster.localValidationRequired, "full");
  assert.deepEqual(roster.packageSmoke, { id: "package-smoke", requires: ["build"], retainedSeparately: true });
  assert.deepEqual(roster.notRunHere, ["full-core", "full-portal", "full-impact-regressions", "PF2-H1", "P8", "release-validation"]);
});

test("light receipts cannot satisfy the existing full/selective baseline or full test push gate", () => {
  const expected = { repository: "example/project", base: "a".repeat(40) };
  const receipt = { state: "verified", repository: expected.repository, sha: expected.base, runId: "1", attempt: "2", workflow: ".github/workflows/ci.yml", conclusion: "success", evidenceDigest: "b".repeat(64) };
  for (const verification of ["CI_LIGHT_VERIFIED", "CI_VERIFIED", "CI_SELECTED_VERIFIED"]) {
    assert.equal(verifyBaseline({ ...receipt, coverage: "light", verification }, expected).eligible, false);
  }
  assert.equal(verifyBaseline({ ...receipt, coverage: "full", verification: "CI_VERIFIED" }, expected).eligible, true);
  const leg = P1_SEQUENCE.find(row => row.task === "test");
  for (const reasonCode of ["CI_LIGHT_VERIFIED", "CI_LIGHT_STEPS_VERIFIED", "TESTS_VERIFIED"]) {
    assert.notEqual(judgeLegOutput(JSON.stringify({ ok: true, command: "test", reasonCode, coverage: "light", result: "passed", progress: { status: "completed", errors: [] } }), leg), "P1_LEG_COVERED");
  }
});

test("light child judgement rejects missing, ambiguous, failed and cancelled raw receipts", () => {
  const row = LIGHT_STEPS.find(item => item.id === "build");
  const raw = JSON.stringify({ ok: true, reasonCode: "BUILD_VERIFIED" });
  assert.equal(judgeLightStep(row, executed, raw, "").ok, true);
  for (const patch of [{ exitCode: 1 }, { exitCode: null, signal: "SIGTERM" }, { status: "blocked" }, { status: "timed_out" }]) assert.equal(judgeLightStep(row, { ...executed, ...patch }, raw, "").ok, false);
  for (const [stdout, stderr] of [["", ""], [raw, raw], [JSON.stringify({ ok: false, reasonCode: "BUILD_VERIFIED" }), ""], [JSON.stringify({ ok: true, reasonCode: "CI_LIGHT_VERIFIED" }), ""], [JSON.stringify({ ok: true, reasonCode: "BUILD_VERIFIED", injected: true }), ""]]) assert.equal(judgeLightStep(row, executed, stdout, stderr).ok, false);
});

test("bounded tests require nonempty unambiguous totals and retain skipped/todo honestly", () => {
  const row = LIGHT_STEPS.find(item => item.id === "contracts");
  assert.equal(judgeLightStep(row, executed, totals(), "").ok, true);
  for (const raw of ["", totals({ tests: 0, pass: 0 }), totals({ fail: 1, pass: 0 }), totals({ cancelled: 1, pass: 0 }), totals() + totals(), totals().replace("# todo 0\n", "")]) assert.equal(judgeLightStep(row, executed, raw, "").ok, false);
  const result = judgeLightStep(row, executed, totals({ tests: 3, skipped: 1, todo: 1 }), "");
  assert.equal(result.testTotals.skipped, 1);
  assert.equal(result.testTotals.todo, 1);
});

test("privacy refuses bounded history or missing archive coverage even with a green child exit", () => {
  const row = LIGHT_STEPS.find(item => item.id === "privacy");
  const report = { ok: true, reasonCode: "PRIVACY_SOURCE_CLEAN", privacyScope: "HEAD-reachable", archiveScanned: true };
  assert.equal(judgeLightStep(row, executed, JSON.stringify(report), "").ok, true);
  for (const patch of [{ privacyScope: "changed" }, { archiveScanned: false }, { historyBase: "a".repeat(40) }]) assert.equal(judgeLightStep(row, executed, JSON.stringify({ ...report, ...patch }), "").ok, false);
});

test("light build retains the real build task rather than a second independent typecheck", async () => {
  assert.deepEqual(LIGHT_STEPS.find(row => row.id === "build").argv, ["scripts/task.mjs", "build"]);
  assert.ok(!LIGHT_STEPS.some(row => row.id === "typecheck"));
  const source = await readFile(new URL("../scripts/task.mjs", import.meta.url), "utf8");
  assert.match(source, /async function build\(\) \{\n  const checked = await typecheck\(\);\n  await safeResetOutputDirectory/u);
});
