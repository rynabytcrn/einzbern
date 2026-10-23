// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readEngineModelPolicyFile, applyEngineModelPolicySet } from "../dist/build/packages/core/src/engine-model-policy.js";
import { resolveHostExecution, recordExecutionQualityEvent, hostRecoveryAction } from "../dist/build/packages/core/src/execution-fallback.js";
import { DEFAULT_ENGINE_QUOTA_POLICY } from "../dist/build/packages/core/src/execution-policy.js";
import { nativeFixture, requestFor, selection, tuple, at } from "./helpers/host-native-fixture.mjs";
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
test("current unsupported selection overrides stale catalog; separate observed fallback works without enumeration", async t => {
  const f = await nativeFixture(t); const p = await readEngineModelPolicyFile(f.home);
  const replacement = { kind: "explicit", tuple: { ...tuple, model: "available-alternative" } };
  const negative = { ...f.request, capabilities: { ...f.request.capabilities, combinations: [tuple], requestedSelectionSupported: "unsupported" } };
  assert.equal(resolveHostExecution(negative, p, "fixture", at).status, "awaiting-choice");
  const fallback = { ...negative, fallbackSelection: replacement, capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported", selectionObservations: [{ selection: replacement, support: "supported", observedAt: at }] } };
  const d = resolveHostExecution(fallback, p, "fixture", at); assert.equal(d.status, "degraded"); assert.deepEqual(d.requestedSelection, replacement);
  assert.equal(resolveHostExecution({ ...fallback, capabilities: { ...fallback.capabilities, selectionObservations: [{ selection: replacement, support: "unknown", observedAt: at }] } }, p, "fixture", at).status, "awaiting-choice");
  for (const fallbackBoundaryAssessment of ["unresolved", "outside"]) assert.equal(resolveHostExecution({ ...fallback, authorization: { ...fallback.authorization, fallbackBoundaryAssessment } }, p, "fixture", at).status, "awaiting-choice");
  assert.equal(resolveHostExecution({ ...fallback, authorization: { ...fallback.authorization, fallbackBoundaryAssessment: "covered", basis: "Existing grant covers this model's provider, data scope and cost" } }, p, "fixture", at).additionalConfirmationsRequired, false);
});
test("T04 valid-schema digest mismatch and unconfigured entry are distinct", async t => {
  const f = await nativeFixture(t); const p = await configure(f); const path = join(f.home, "engine-model-policy.json");
  const bad = structuredClone(p); bad.hosts.codex.digest = "0".repeat(64); await writeFile(path, JSON.stringify(bad));
  await assert.rejects(readEngineModelPolicyFile(f.home), error => error.reasonCode === "ENGINE_MODEL_POLICY_FILE_INVALID" && /digest/u.test(error.message));
  await writeFile(path, JSON.stringify(p));
  const emptyTier = structuredClone(p.hosts.codex); const { revision, digest, updatedAt, actor, decidedIn, decidedInLibraryId, ...config } = emptyTier;
  config.tiers = config.tiers.map(tier => ({ ...tier, model: "", effort: "" }));
  const unconfigured = await applyEngineModelPolicySet({ home: f.home, host: "codex", occurredAt: at, actor: "agent:fixture", authorization: { target: "models.engine-policy", decidedIn, libraryId: decidedInLibraryId }, policy: config });
  assert.equal(resolveHostExecution(f.request, unconfigured, "fixture", at).policyStatus, "entry-unconfigured");
  const claude = { ...f.request, capabilities: { ...f.request.capabilities, hostKind: "claude" } };
  assert.equal(resolveHostExecution(claude, unconfigured, "fixture", at).policyStatus, "unconfigured");
});
test("T05/T06 existing task authority, expiry, explicit deadline and independent saving", async t => {
  const f = await nativeFixture(t); const p = await readEngineModelPolicyFile(f.home);
  for (const status of ["absent", "withdrawn"]) assert.equal(resolveHostExecution({ ...f.request, authorization: { ...f.request.authorization, status } }, p, "fixture", at).status, "blocked");
  assert.equal(resolveHostExecution({ ...f.request, authorization: { ...f.request.authorization, workIds: ["work:other"] } }, p, "fixture", at).status, "blocked");
  assert.equal(resolveHostExecution({ ...f.request, authorization: { ...f.request.authorization, workIds: "all" } }, p, "fixture", at).status, "degraded");
  assert.equal(resolveHostExecution({ ...f.request, authorization: { ...f.request.authorization, expiresAt: at } }, p, "fixture", at).status, "blocked");
  assert.equal(resolveHostExecution({ ...f.request, hardLimits: { deadline: at } }, p, "fixture", at).status, "blocked");
  for (const status of ["pending", "failed"]) {
    assert.equal(resolveHostExecution({ ...f.request, saveRequirement: { requiredBeforeExecution: false, status } }, p, "fixture", at).status, "degraded");
    assert.equal(resolveHostExecution({ ...f.request, saveRequirement: { requiredBeforeExecution: true, status } }, p, "fixture", at).status, "blocked");
  }
  assert.equal(resolveHostExecution({ ...f.request, permissionDenied: true }, p, "fixture", at).status, "blocked");
});
test("T08/T11 stale telemetry is not current capacity; parent accounting and full snapshots", async t => {
  const f = await nativeFixture(t); const p = await readEngineModelPolicyFile(f.home);
  for (const [includesParent, parentActive, active, expected] of [[true, true, 1, "degraded"], [false, true, 0, "degraded"], [false, true, 1, "blocked"], [true, true, 2, "blocked"], [false, false, 1, "degraded"]]) {
    const capabilities = { ...f.request.capabilities, platformCapacity: { limit: 2, includesParent, parentActive, active } };
    assert.equal(resolveHostExecution({ ...f.request, capabilities }, p, "fixture", at).status, expected);
  }
  const fallbackSelection = { kind: "explicit", tuple: { ...tuple, model: "alternative" } };
  const stale = { ...f.request, fallbackSelection, capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported", selectionObservations: [{ selection: fallbackSelection, support: "supported", observedAt: "2026-10-20T00:00:00Z" }] } };
  assert.equal(resolveHostExecution(stale, p, "fixture", at).status, "awaiting-choice");
  assert.throws(() => resolveHostExecution({ ...stale, capabilities: { ...stale.capabilities, selectionObservations: [{ selection: fallbackSelection, support: "supported", observedAt: "2026-10-22T00:00:00Z" }] } }, p, "fixture", at), /future/u);
});

test("saveRequirement is a closed optional schema, not an implicit execution gate", async t => {
  const f = await nativeFixture(t); const policy = await readEngineModelPolicyFile(f.home);
  for (const value of ["saved", {}, { requiredBeforeExecution: "false", status: "saved" }, { requiredBeforeExecution: false, status: "invented" }, { requiredBeforeExecution: false, status: "saved", extra: true }]) {
    assert.throws(() => resolveHostExecution({ ...f.request, saveRequirement: value }, policy, "fixture", at));
  }
  assert.equal(resolveHostExecution({ ...f.request, saveRequirement: { requiredBeforeExecution: false, status: "failed" } }, policy, "fixture", at).status, "degraded");
});

test("fallback admission rejects newer or same-instant negative support in either observation order", () => {
  const original = requestFor({ id: "work:fixture", revision: 1 });
  const policy = { schemaVersion: "tcrn.engine-model-policy.v1", revision: 0, hosts: {} };
  const fallbackSelection = { kind: "explicit", tuple: { ...tuple, model: "fixture-alternative" } };
  const positive = { selection: fallbackSelection, support: "supported", observedAt: "2026-10-21T00:00:00.000000001Z" };
  for (const observedAt of ["2026-10-21T00:00:00.000000002Z", positive.observedAt]) {
    const negative = { ...positive, support: "unsupported", observedAt };
    for (const selectionObservations of [[positive, negative], [negative, positive]]) {
      const request = { ...original, fallbackSelection, capabilities: { ...original.capabilities, requestedSelectionSupported: "unsupported", selectionObservations, combinations: [fallbackSelection.tuple] } };
      const decision = resolveHostExecution(request, policy, "fixture", "2026-10-21T00:00:01Z");
      assert.equal(decision.status, "awaiting-choice"); assert.equal(decision.fallbackApplied, false);
      assert.ok(decision.reasons.includes("no-supported-selection"));
      assert.equal(decision.persistentConfigWrites, 0);
    }
  }
});
test("fallback admission uses the full-precision freshness boundary and retains strict UTC validation", () => {
  const original = requestFor({ id: "work:fixture", revision: 1 });
  const policy = { schemaVersion: "tcrn.engine-model-policy.v1", revision: 0, hosts: {} };
  const fallbackSelection = { kind: "explicit", tuple: { ...tuple, model: "fixture-alternative" } };
  const now = "2026-10-21T00:05:00.000000002Z";
  const request = observedAt => ({ ...original, fallbackSelection, capabilities: { ...original.capabilities, requestedSelectionSupported: "unsupported", hostManagedSupported: false, selectionObservations: [{ selection: fallbackSelection, support: "supported", observedAt }] } });
  for (const [observedAt, expected] of [["2026-10-21T00:00:00.000000001Z", "awaiting-choice"], ["2026-10-21T00:00:00.000000002Z", "degraded"], ["2026-10-21T00:00:00.000000003Z", "degraded"], [now, "degraded"]]) {
    assert.equal(resolveHostExecution(request(observedAt), policy, "fixture", now).status, expected);
  }
  assert.throws(() => resolveHostExecution(request("2026-10-21T00:05:00.000000003Z"), policy, "fixture", now), /future/u);
  assert.throws(() => resolveHostExecution(request("2026-10-21T01:05:00.000000002+01:00"), policy, "fixture", now), /UTC/u);
});
