// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readExecutionAdmissionSnapshot, resolveExecutionAdmission, resolveExecutionAdmissionFromSnapshot } from "../dist/build/packages/core/src/execution-admission.js";
import { applyEngineModelPolicySet } from "../dist/build/packages/core/src/engine-model-policy.js";
import { applyMachineSettingSet } from "../dist/build/packages/core/src/machine-settings.js";
import { DEFAULT_ENGINE_QUOTA_POLICY, evaluateExecutionQuota } from "../dist/build/packages/core/src/execution-policy.js";
const now = "2026-10-17T12:10:00Z";
const usage = { observedAt: now, source: "fixture-account-report", fiveHourUsedPercent: 10, weeklyUsedPercent: 20 };
const authorization = { decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: `library:${"b".repeat(24)}`, target: "models.engine-policy" };
const tuples = [[10, "flagship", "gpt-6-astra", "max"], [20, "main", "gpt-6.1-sol", "max"], [30, "economy", "gpt-6.1-sol", "low"], [40, "economy", "gpt-5.6-terra", "max"], [50, "economy", "gpt-5.6-terra", "medium"], [60, "economy", "gpt-6-luna", "max"]];
function policy(host = "codex", quota = true) {
  return { categories: ["flagship", "main", "economy"].map((id, order) => ({ id, name: id, description: "", order: order + 1 })),
    tiers: tuples.map(([order, category, model, effort]) => ({ order, category, runner: host, model, effort, note: "" })),
    escalation: { enabled: true, threshold: 2, ceiling: "main" }, ...(quota ? { quota: DEFAULT_ENGINE_QUOTA_POLICY } : {}) };
}
const request = (extra = {}) => ({ host: "codex", category: "economy", rejections: 0, requestedAgents: 2,
  availableCombinations: policy().tiers.map(({ runner, model, effort }) => ({ runner, model, effort })), usage, ...extra });
async function fixture(context) {
  const home = await mkdtemp(join(tmpdir(), "execution-admission-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return { home, now };
}
const save = (home, value = policy(), host = "codex") => applyEngineModelPolicySet({ home, host, policy: value, occurredAt: now, actor: "agent:fixture", authorization });

test("admission carries precise configured staircase, tuple, rejections and policy identity without executing", async context => {
  const options = await fixture(context);
  const snapshot = await save(options.home);
  const before = await readFile(join(options.home, "engine-model-policy.json"), "utf8");
  const expected = [["gpt-6-luna", "max"], ["gpt-5.6-terra", "medium"], ["gpt-5.6-terra", "max"], ["gpt-6.1-sol", "low"], ["gpt-6.1-sol", "max"]];
  for (let rejections = 0; rejections < 12; rejections++) {
    const result = await resolveExecutionAdmission(request({ rejections }), options);
    assert.equal(result.status, "admitted");
    assert.deepEqual(result.reasons, []);
    assert.deepEqual([result.selection.record.model, result.selection.record.effort], expected[Math.min(Math.floor(rejections / 2), 4)]);
    assert.equal(result.selection.record.runner, "codex");
    assert.equal(result.selection.rejections, rejections);
    assert.equal(result.policy.digest, snapshot.hosts.codex.digest);
    assert.equal(result.policy.revision, 1);
    assert.equal(result.capabilities.status, "caller-reported-match");
    assert.equal(result.capabilities.verification, "caller-reported-not-native-verified");
    assert.equal(result.quota.verification, "caller-reported-not-account-verified");
    assert.equal(result.quota.status, "fresh");
    assert.equal(result.quota.decision, "parallel");
  }
  assert.equal(await readFile(join(options.home, "engine-model-policy.json"), "utf8"), before);
  const disabled = policy(); disabled.escalation.enabled = false;
  await save(options.home, disabled);
  const held = await resolveExecutionAdmission(request({ rejections: 12 }), options);
  assert.equal(held.status, "admitted"); assert.equal(held.selection.record.model, "gpt-6-luna");
  assert.equal(held.policy.revision, 2);
  assert.equal((await resolveExecutionAdmission(request({ expectedPolicy: { revision: held.policy.revision, digest: held.policy.digest } }), options)).status, "admitted");
  assert.ok((await resolveExecutionAdmission(request({ expectedPolicy: { revision: held.policy.revision, digest: snapshot.hosts.codex.digest } }), options)).reasons.includes("EXECUTION_POLICY_STALE"));
});

test("admission enforces capability evidence and policy revision without fallback across hosts", async context => {
  const options = await fixture(context);
  await save(options.home);
  const other = policy("claude-code");
  other.tiers = other.tiers.map(tier => ({ ...tier, model: `other-${tier.model}` }));
  await save(options.home, other, "claude-code");
  for (const [extra, reason] of [[{ availableCombinations: undefined }, "EXECUTION_CAPABILITIES_MISSING"], [{ availableCombinations: [] }, "EXECUTION_COMBINATION_UNSUPPORTED"], [{ availableCombinations: [{ runner: "codex", model: "gpt-6-luna", effort: "low" }] }, "EXECUTION_COMBINATION_UNSUPPORTED"], [{ expectedPolicy: { revision: 99, digest: "a".repeat(64) } }, "EXECUTION_POLICY_STALE"]]) {
    const result = await resolveExecutionAdmission(request(extra), options);
    assert.equal(result.status, "refused"); assert.ok(result.reasons.includes(reason));
    assert.equal(result.selection.record.model, "gpt-6-luna");
  }
  const otherResult = await resolveExecutionAdmission(request({ host: "claude-code", availableCombinations: other.tiers.map(({ runner, model, effort }) => ({ runner, model, effort })) }), options);
  assert.equal(otherResult.status, "admitted"); assert.equal(otherResult.selection.record.runner, "claude-code");
  assert.equal(otherResult.selection.record.model, "other-gpt-6-luna");
  const missing = await resolveExecutionAdmission(request({ host: "unknown" }), options);
  assert.equal(missing.status, "refused"); assert.equal(missing.selection, null); assert.equal(missing.policy, null);
  const absentCategory = await resolveExecutionAdmission(request({ category: "review" }), options);
  assert.equal(absentCategory.status, "refused"); assert.equal(absentCategory.selection, null);
  assert.equal(absentCategory.policy.revision, 1); assert.match(absentCategory.policy.digest, /^[a-f0-9]{64}$/u);
});

test("configured quota requires fresh complete observations, serial tightens cap and wait refuses", async context => {
  const options = await fixture(context);
  await save(options.home);
  await applyMachineSettingSet({ path: join(options.home, "machine-settings.json"), key: "execution.maxConcurrentAgents", value: "3", occurredAt: now });
  for (const [observed, reason, status] of [[undefined, "EXECUTION_USAGE_MISSING", "missing"], [{ ...usage, observedAt: "2026-10-17T12:04:59Z" }, "EXECUTION_USAGE_STALE", "stale"], [{ observedAt: now, source: "partial", fiveHourUsedPercent: 80 }, "EXECUTION_USAGE_INCOMPLETE", "fresh"], [{ ...usage, fiveHourUsedPercent: 90 }, "EXECUTION_QUOTA_WAIT", "fresh"]]) {
    const result = await resolveExecutionAdmission(request({ usage: observed, requestedAgents: 1 }), options);
    assert.equal(result.status, "refused"); assert.ok(result.reasons.includes(reason)); assert.equal(result.quota.status, status);
  }
  const boundary = await resolveExecutionAdmission(request({ usage: { ...usage, observedAt: "2026-10-17T12:05:00Z" } }), options);
  assert.equal(boundary.status, "admitted"); assert.equal(boundary.quota.maxAgeMs, 300_000); assert.equal(boundary.quota.ageMs, boundary.quota.maxAgeMs);
  const serialRequest = request({ usage: { ...usage, fiveHourUsedPercent: 75 } });
  const serial = await resolveExecutionAdmission(serialRequest, { ...options, projectLimit: 99 });
  assert.equal(serial.status, "refused"); assert.equal(serial.quota.decision, "serial"); assert.equal(serial.concurrency.effectiveLimit, 3); assert.equal(serial.concurrency.admissionLimit, 1);
  assert.equal((await resolveExecutionAdmission({ ...serialRequest, requestedAgents: 1 }, options)).status, "admitted");
  const weekly = await resolveExecutionAdmission(request({ requestedAgents: 1, usage: { ...usage, weeklyUsedPercent: 100 } }), options);
  assert.equal(weekly.status, "admitted"); assert.equal(weekly.quota.decision, "serial", "nullable weekly wait is disabled, not zero");
  const partialWait = await resolveExecutionAdmission(request({ requestedAgents: 1, usage: { observedAt: now, source: "partial", fiveHourUsedPercent: 90 } }), options);
  assert.deepEqual(partialWait.reasons, ["EXECUTION_USAGE_INCOMPLETE", "EXECUTION_QUOTA_WAIT"]);
  const tightened = await resolveExecutionAdmission(request(), { ...options, projectLimit: 1 });
  assert.equal(tightened.status, "refused"); assert.equal(tightened.concurrency.effectiveLimit, 1);
  const noRaise = await resolveExecutionAdmission(request({ requestedAgents: 4 }), { ...options, projectLimit: 99 });
  assert.equal(noRaise.status, "refused"); assert.equal(noRaise.concurrency.effectiveLimit, 3);
});

test("absent quota extension is explicitly not configured, never an account-safety claim", async context => {
  const options = await fixture(context);
  await save(options.home, policy("codex", false));
  const result = await resolveExecutionAdmission(request({ usage: undefined }), options);
  assert.equal(result.status, "admitted"); assert.equal(result.quota.status, "not-configured");
  assert.equal(result.quota.decision, "not-configured"); assert.equal(result.quota.observedAt, null);
  assert.equal(result.selection.quotaOrigin, "engine-default");
});

test("admission rejects malformed/future observation and corrupt policy rather than concealing errors", async context => {
  const options = await fixture(context);
  await save(options.home);
  for (const extra of [{ requestedAgents: 0 }, { rejections: -1 }, { usage: { ...usage, observedAt: "tomorrow" } }, { usage: { ...usage, observedAt: "2026-10-17T12:10:01Z" } }, { usage: { ...usage, observedAt: "2026-10-17T12:10:00.000000001Z" } }, { usage: { ...usage, source: "" } }, { usage: { ...usage, fiveHourUsedPercent: NaN } }, { usage: { ...usage, weeklyUsedPercent: 101 } }, { usage: { ...usage, unsupported: true } }, { availableCombinations: [{ runner: "codex", model: "m" }] }, { expectedPolicy: { revision: 1, digest: "bad" } }]) {
    await assert.rejects(resolveExecutionAdmission(request(extra), options), { reasonCode: "EXECUTION_POLICY_INVALID" });
  }
  await writeFile(join(options.home, "engine-model-policy.json"), "{}\n");
  await assert.rejects(resolveExecutionAdmission(request(), options), error => error.reasonCode.startsWith("ENGINE_MODEL_POLICY_") && error.reasonCode !== "ENGINE_MODEL_POLICY_UNAVAILABLE");
});

test("quota receipt preserves caller-reported percentages, including zero and unobserved windows, for recomputation", async context => {
  const options = await fixture(context);
  await save(options.home);
  for (const observation of [usage, { ...usage, fiveHourUsedPercent: 0, weeklyUsedPercent: 0 }, { ...usage, fiveHourUsedPercent: 75.25 }, { observedAt: now, source: "partial", fiveHourUsedPercent: 90 }, { observedAt: now, source: "unobserved" }]) {
    const result = await resolveExecutionAdmission(request({ usage: observation, requestedAgents: 1 }), options);
    assert.equal(result.quota.fiveHourUsedPercent, observation.fiveHourUsedPercent ?? null);
    assert.equal(result.quota.weeklyUsedPercent, observation.weeklyUsedPercent ?? null);
    assert.equal(result.quota.source, observation.source);
    assert.equal(result.quota.verification, "caller-reported-not-account-verified");
    const percentages = Object.fromEntries(["fiveHourUsedPercent", "weeklyUsedPercent"].filter(key => result.quota[key] !== null).map(key => [key, result.quota[key]]));
    const recomputed = evaluateExecutionQuota(result.selection.quota, percentages);
    assert.equal(recomputed.decision, result.quota.decision);
    assert.deepEqual(recomputed.unknownWindows, result.quota.unknownWindows);
  }
  const missing = await resolveExecutionAdmission(request({ usage: undefined }), options);
  assert.equal(missing.quota.fiveHourUsedPercent, null);
  assert.equal(missing.quota.weeklyUsedPercent, null);
  const stale = await resolveExecutionAdmission(request({ usage: { ...usage, observedAt: "2026-10-17T12:04:59Z" } }), options);
  assert.equal(stale.quota.status, "stale");
  assert.equal(stale.quota.decision, "unknown");
  assert.equal(stale.quota.fiveHourUsedPercent, 10, "stale observations are retained, not promoted to fresh usage");
  assert.equal(stale.quota.weeklyUsedPercent, 20);
});

test("captured execution snapshot fixes policy and device cap without rereading later file contents", async context => {
  const options = await fixture(context);
  await save(options.home);
  await applyMachineSettingSet({ path: join(options.home, "machine-settings.json"), key: "execution.maxConcurrentAgents", value: "3", occurredAt: now });
  const snapshot = await readExecutionAdmissionSnapshot(options.home);
  const original = resolveExecutionAdmissionFromSnapshot(snapshot, request(), { now });
  assert.deepEqual(original, await resolveExecutionAdmission(request(), options), "default standalone API uses the same resolution");
  assert.equal(original.status, "admitted");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.enginePolicy.hosts), true);
  assert.equal(Object.isFrozen(snapshot.machineSettings.values), true);

  const updated = policy();
  updated.tiers = updated.tiers.map(tier => ({ ...tier, model: `new-${tier.model}` }));
  await save(options.home, updated);
  await applyMachineSettingSet({ path: join(options.home, "machine-settings.json"), key: "execution.maxConcurrentAgents", value: "1", occurredAt: now });
  assert.deepEqual(resolveExecutionAdmissionFromSnapshot(snapshot, request(), { now }), original);
  const current = await resolveExecutionAdmission(request(), options);
  assert.equal(current.policy.revision, 2);
  assert.equal(current.selection.record.model, "new-gpt-6-luna");
  assert.equal(current.concurrency.deviceLimit, 1);
  assert.deepEqual(current.reasons, ["EXECUTION_COMBINATION_UNSUPPORTED", "EXECUTION_CONCURRENCY_EXCEEDED"]);

  await writeFile(join(options.home, "engine-model-policy.json"), "{}\n");
  await writeFile(join(options.home, "machine-settings.json"), "{}\n");
  assert.deepEqual(resolveExecutionAdmissionFromSnapshot(snapshot, request(), { now }), original, "pure snapshot resolution has no filesystem dependency");
  await assert.rejects(readExecutionAdmissionSnapshot(options.home));
});

test("pure snapshot admission validates both device inputs rather than trusting caller-constructed snapshots", async context => {
  const options = await fixture(context);
  await save(options.home);
  const snapshot = await readExecutionAdmissionSnapshot(options.home);
  const corruptedPolicy = structuredClone(snapshot);
  corruptedPolicy.enginePolicy.hosts.codex.digest = "a".repeat(64);
  assert.throws(() => resolveExecutionAdmissionFromSnapshot(corruptedPolicy, request(), { now }), { reasonCode: "ENGINE_MODEL_POLICY_FILE_INVALID" });
  const corruptedMachine = structuredClone(snapshot);
  corruptedMachine.machineSettings.values["execution.maxConcurrentAgents"] = "0";
  assert.throws(() => resolveExecutionAdmissionFromSnapshot(corruptedMachine, request(), { now }), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" });
  for (const corrupted of [{ ...snapshot, home: "relative-device" }, { ...snapshot, ignored: true }]) {
    assert.throws(() => resolveExecutionAdmissionFromSnapshot(corrupted, request(), { now }), { reasonCode: "EXECUTION_POLICY_INVALID" });
  }
  await assert.rejects(readExecutionAdmissionSnapshot("relative-device"), { reasonCode: "EXECUTION_POLICY_INVALID" });
});

test("DOT-E02 legacy admission does not infer native applicability from a dot host string", async context => {
  const options = await fixture(context); await save(options.home);
  await assert.rejects(resolveExecutionAdmission(request({ host: "chatgpt-dot" }), options), /independent dot mode/u);
  await assert.rejects(resolveExecutionAdmission({ ...request(), mode: "dot-autonomous" }, options), /not supported/u);
});
