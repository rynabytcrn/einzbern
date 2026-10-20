// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { DOT_REQUIRED_CHECKS, resolveDotExecutionAdmission, validateDotExecutionRequest } from "../dist/build/packages/core/src/dot-execution.js";
import { EXECUTION_HOSTS } from "../dist/build/packages/core/src/execution-config.js";
const at = "2026-10-20T05:00:00Z";
function request() {
  return { mode: "dot-autonomous", executionTarget: "chatgpt-dot", libraryId: `library:${"a".repeat(24)}`, projectRef: { libraryId: `library:${"a".repeat(24)}`, projectId: `project:${"b".repeat(24)}` }, workId: `work:${"c".repeat(24)}`, revisionBinding: { kind: "revision", workRevision: 1, scopeDigest: "d".repeat(64) }, requestedAgents: 1, requiredTools: ["native.fixture"], actualCapabilityEvidenceRefs: ["fixture:capability"], authorizationEvidenceRef: "fixture:authorization", checks: Object.fromEntries(DOT_REQUIRED_CHECKS.map(name => [name, { status: "pass", evidenceRefs: [`fixture:${name}`], reason: "synthetic unit-test input, not a production observation" }])), occupancyObservation: { status: "observed", activeAgents: 1, includesParent: true, parentActive: true, platformLimit: 7, observedAt: at, evidenceRef: "fixture:occupancy" }, modelObservation: { status: "unavailable", reason: "not exposed" } };
}
const options = { deviceLimit: 6, projectLimit: 4, now: at, contextDigest: "e".repeat(64) };
test("DOT-E02 native applicability is not a model/quota pass or a legacy host", () => {
  const a = resolveDotExecutionAdmission(request(), options);
  assert.equal(a.status, "admitted");
  assert.deepEqual(Object.values(a.applicability).map(x => x.status), Array(4).fill("not-applicable"));
  assert.equal(a.modelObservation.status, "unavailable");
  assert.deepEqual(EXECUTION_HOSTS, ["claude-code", "codex", "dsh"]);
  assert.equal(a.concurrency.availableSlots, 3); assert.equal(a.concurrency.reservation, "none");
});
test("DOT-E02 unknown scope, absent evidence and unsupported exact delegation do not pass", () => {
  const r = request(); r.checks.scope.status = "unknown";
  assert.ok(resolveDotExecutionAdmission(r, options).reasonCodes.includes("DOT_SCOPE_UNKNOWN"));
  r.checks.context.evidenceRefs = []; assert.throws(() => validateDotExecutionRequest(r));
  const exact = { ...request(), exactDelegation: { runner: "native", model: "unselectable", effort: "exact", supported: false, actualInvocationMetadataRef: null } };
  assert.ok(resolveDotExecutionAdmission(exact, options).reasonCodes.includes("DOT_EXACT_DELEGATION_UNSUPPORTED"));
});
test("DOT-E02 parent occupancy is counted exactly once; unknown is not free", () => {
  const r = request(); r.occupancyObservation.includesParent = false;
  assert.equal(resolveDotExecutionAdmission(r, options).concurrency.availableSlots, 2);
  r.occupancyObservation = { ...r.occupancyObservation, status: "unknown", activeAgents: null, platformLimit: null };
  assert.ok(resolveDotExecutionAdmission(r, options).reasonCodes.includes("DOT_OCCUPANCY_UNKNOWN"));
});
test("DOT-E02 platform/project/device limits and stale observations refuse without quota inference", () => {
  const r = request(); r.requestedAgents = 4;
  assert.ok(resolveDotExecutionAdmission(r, options).reasonCodes.includes("DOT_CONCURRENCY_EXCEEDED"));
  r.requestedAgents = 1; r.occupancyObservation.observedAt = "2026-10-20T04:00:00Z";
  assert.ok(resolveDotExecutionAdmission(r, options).reasonCodes.includes("DOT_OCCUPANCY_STALE"));
});
test("DOT-E02 unknown mode, host substitution and an exception field are rejected", () => {
  assert.throws(() => validateDotExecutionRequest({ ...request(), mode: "codex" }));
  assert.throws(() => validateDotExecutionRequest({ ...request(), batchException: true }));
  assert.throws(() => validateDotExecutionRequest({ ...request(), selectedTuple: { runner: "codex", model: "fixture", effort: "max" } }));
});
