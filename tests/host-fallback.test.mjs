// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readEngineModelPolicyFile, applyEngineModelPolicySet } from "../dist/build/packages/core/src/engine-model-policy.js";
import { resolveHostExecution, recordExecutionQualityEvent, hostRecoveryAction } from "../dist/build/packages/core/src/execution-fallback.js";
import { DEFAULT_ENGINE_QUOTA_POLICY } from "../dist/build/packages/core/src/execution-policy.js";
import { nativeFixture, selection, tuple, at } from "./helpers/host-native-fixture.mjs";
async function configure(f, extra = {}) {
  return applyEngineModelPolicySet({ home: f.home, host: "codex", occurredAt: at, actor: "agent:fixture", authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId }, policy: { categories: [{ id: "main", name: "Main", order: 10, description: "" }], tiers: [{ ...tuple, model: "configured-unavailable", category: "main", order: 10, note: "" }], escalation: { enabled: true, threshold: 2, ceiling: "main" }, ...extra } });
}
test("T02 actual unavailable configured tuple uses already-authorized fallback, zero confirmations/writes", async t => {
  const f = await nativeFixture(t); const policy = await configure(f); const path = join(f.home, "engine-model-policy.json"); const before = await readFile(path, "utf8");
  const request = { ...f.request, capabilities: { ...f.request.capabilities, combinations: [tuple] }, fallbackSelection: selection };
  const d = resolveHostExecution(request, policy, "fixture-context", at);
  assert.equal(d.status, "degraded"); assert.equal(d.fallbackApplied, true); assert.equal(d.policyStatus, "unsupported");
  assert.equal(d.configuredIntent.tuple.model, "configured-unavailable"); assert.deepEqual(d.requestedSelection, selection);
  assert.equal(d.actualSelection.status, "unknown"); assert.equal(d.additionalConfirmationsRequired, false); assert.equal(d.persistentConfigWrites, 0);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(resolveHostExecution({ ...request, authorization: { ...request.authorization, fallback: "none" } }, policy, "fixture", at).status, "awaiting-choice");
  assert.equal(resolveHostExecution({ ...request, hardLimits: { exactSelection: { kind: "explicit", tuple: { ...tuple, model: "configured-unavailable" } } } }, policy, "fixture", at).status, "blocked");
});
test("T04 absence is distinct from malformed policy, bad digest and read failure", async t => {
  const f = await nativeFixture(t); const empty = await readEngineModelPolicyFile(f.home);
  assert.equal(resolveHostExecution(f.request, empty, "fixture", at).policyStatus, "unconfigured");
  await mkdir(f.home, { recursive: true }); const path = join(f.home, "engine-model-policy.json");
  await writeFile(path, "{not json"); await assert.rejects(readEngineModelPolicyFile(f.home));
  await writeFile(path, JSON.stringify({ ...empty, hosts: { codex: { digest: "invalid" } } })); await assert.rejects(readEngineModelPolicyFile(f.home));
  // A directory at a file path is an actual read error, not a synthetic policyStatus label.
  const badHome = join(f.root, "directory-policy"); await mkdir(join(badHome, "engine-model-policy.json"), { recursive: true });
  await assert.rejects(readEngineModelPolicyFile(badHome));
});
test("T09 technical incidents never increment quality rejection or silently reset history", () => {
  let history = { rejections: 1, eventIds: [] };
  for (const kind of ["model-unavailable", "rate-limit", "network", "telemetry-unavailable", "policy-error"]) history = recordExecutionQualityEvent(history, { id: kind, kind });
  assert.equal(history.rejections, 1);
  history = recordExecutionQualityEvent(history, { id: "review-1", kind: "quality-rejected" }); assert.equal(history.rejections, 2);
  assert.equal(recordExecutionQualityEvent(history, { id: "review-1", kind: "quality-rejected" }).rejections, 2);
  assert.equal(hostRecoveryAction("network", "not-executed"), "retry-with-backoff");
  assert.equal(hostRecoveryAction("network", "unknown"), "reconcile");
  assert.equal(hostRecoveryAction("permission-denied", "not-executed"), "stop-affected-action");
});
test("known hard limits remain enforced but unknown optional slots/usage are not invented", async t => {
  const f = await nativeFixture(t); const p = await readEngineModelPolicyFile(f.home);
  assert.equal(resolveHostExecution(f.request, p, "fixture", at).status, "degraded");
  for (const hardLimits of [{ remainingCalls: 0 }, { budgetSatisfied: false }, { concurrency: { limit: 2, active: null, includesParent: true, parentActive: true, scope: "total" } }]) assert.equal(resolveHostExecution({ ...f.request, hardLimits }, p, "fixture", at).status, "blocked");
  assert.equal(resolveHostExecution({ ...f.request, previousOutcome: "unknown", capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported" } }, p, "fixture", at).status, "reconcile");
});
test("optional missing usage window allows work; observed configured threshold still applies", async t => {
  const f = await nativeFixture(t); const p = await configure(f, { quota: DEFAULT_ENGINE_QUOTA_POLICY });
  const request = { ...f.request, capabilities: { ...f.request.capabilities, usage: { observedAt: at, weeklyUsedPercent: 35 } } };
  assert.equal(resolveHostExecution(request, p, "fixture", at).status, "degraded");
  assert.equal(resolveHostExecution({ ...request, capabilities: { ...request.capabilities, usage: { observedAt: at, fiveHourUsedPercent: 95 } } }, p, "fixture", at).status, "blocked");
});
