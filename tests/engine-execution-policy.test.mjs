// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { applyMachineSettingSet } from "../dist/build/packages/core/src/machine-settings.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { applyEngineModelPolicySet, resolveEngineExecutionPolicy, resolveEngineExecutionPolicyFromSnapshot, validateEngineModelPolicy } from "../dist/build/packages/core/src/engine-model-policy.js";
import { DEFAULT_ENGINE_QUOTA_POLICY, evaluateExecutionQuota, resolveExecutionConcurrency, validateEngineQuotaPolicy } from "../dist/build/packages/core/src/execution-policy.js";

const authorization = { decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: `library:${"b".repeat(24)}`, target: "models.engine-policy" };
function policy(host = "codex") {
  return {
    categories: ["flagship", "main", "economy"].map((id, index) => ({ id, name: id, description: "", order: index + 1 })),
    tiers: [
      [10, "flagship", "gpt-6-astra", "max"],
      [20, "main", "gpt-6.1-sol", "max"],
      [30, "economy", "gpt-6.1-sol", "low"],
      [40, "economy", "gpt-5.6-terra", "max"],
      [50, "economy", "gpt-5.6-terra", "medium"],
      [60, "economy", "gpt-6-luna", "max"],
    ].map(([order, category, model, effort]) => ({ order, category, runner: host, model, effort, note: "" })),
    escalation: { enabled: true, threshold: 2, ceiling: "main" },
  };
}
const save = (home, host, value) => applyEngineModelPolicySet({ home, host, policy: value, occurredAt: "2026-10-17T12:00:00Z", actor: "agent:fixture", authorization });

test("552: persisted host policy resolves every exact return-count boundary without Astra or project fallback", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "engine-execution-policy-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(resolveEngineExecutionPolicy({ home, host: "codex", category: "economy", rejections: 0 }), { reasonCode: "ENGINE_MODEL_POLICY_UNAVAILABLE" });
  const snapshot = await save(home, "codex", policy());
  const expected = [["gpt-6-luna", "max"], ["gpt-5.6-terra", "medium"], ["gpt-5.6-terra", "max"], ["gpt-6.1-sol", "low"], ["gpt-6.1-sol", "max"]];
  for (let rejections = 0; rejections <= 12; rejections++) {
    const result = await resolveEngineExecutionPolicy({ home, host: "codex", category: "economy", rejections });
    assert.deepEqual([result.record.model, result.record.effort], expected[Math.min(Math.floor(rejections / 2), 4)]);
    assert.equal(result.origin.revision, 1);
    assert.equal(result.origin.storeRevision, 1);
    assert.equal(result.origin.digest, snapshot.hosts.codex.digest);
    assert.equal(result.capabilityStatus, "unchecked");
    assert.equal(result.atCeiling, rejections >= 8);
    assert.equal(result.quotaOrigin, "engine-default");
  }
  assert.throws(() => resolveEngineExecutionPolicyFromSnapshot(snapshot, { host: "constructor", category: "economy", rejections: 0 }), { reasonCode: "ENGINE_MODEL_POLICY_UNAVAILABLE" });
  assert.throws(() => resolveEngineExecutionPolicyFromSnapshot(snapshot, { host: "codex", category: "economy", rejections: 0, availableCombinations: [] }), { reasonCode: "ENGINE_MODEL_POLICY_UNAVAILABLE" });
  const available = [{ runner: "codex", model: "gpt-6-luna", effort: "max" }];
  assert.equal(resolveEngineExecutionPolicyFromSnapshot(snapshot, { host: "codex", category: "economy", rejections: 0, availableCombinations: available }).capabilityStatus, "verified-by-caller");
  for (const rejections of [-1, 0.5, Infinity]) assert.throws(() => resolveEngineExecutionPolicyFromSnapshot(snapshot, { host: "codex", category: "economy", rejections }), { reasonCode: "MODELS_ESCALATION_INVALID" });
  await writeFile(join(home, "engine-model-policy.json"), "{bad");
  await assert.rejects(resolveEngineExecutionPolicy({ home, host: "codex", category: "economy", rejections: 0 }), { reasonCode: "ENGINE_MODEL_POLICY_FILE_INVALID" });
});

test("552: disabled escalation stays at base, host partitions stay independent, quota extension preserves historical digest", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "engine-execution-policy-hosts-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const legacy = policy();
  const codex = await save(home, "codex", legacy);
  assert.equal(codex.hosts.codex.digest, canonicalSha256({ host: "codex", ...legacy }));
  assert.equal(Object.hasOwn(codex.hosts.codex, "quota"), false);
  const other = policy("claude-code");
  other.escalation.enabled = false;
  other.quota = { ...DEFAULT_ENGINE_QUOTA_POLICY, weeklyWaitPercent: 99 };
  const saved = await save(home, "claude-code", other);
  assert.deepEqual(saved.hosts.codex, codex.hosts.codex);
  const selected = await resolveEngineExecutionPolicy({ home, host: "claude-code", category: "economy", rejections: 100 });
  assert.equal(selected.record.runner, "claude-code");
  assert.equal(selected.record.model, "gpt-6-luna");
  assert.equal(selected.steps, 0);
  assert.equal(selected.atCeiling, false);
  assert.equal(selected.quotaOrigin, "device-host-policy");
  assert.equal(selected.quota.weeklyWaitPercent, 99);
  const blank = policy();
  blank.tiers[5].model = "";
  await save(home, "codex", blank);
  await assert.rejects(resolveEngineExecutionPolicy({ home, host: "codex", category: "economy", rejections: 0 }), { reasonCode: "ENGINE_MODEL_POLICY_UNAVAILABLE" });
  await assert.rejects(resolveEngineExecutionPolicy({ home, host: "claude-code", category: "unknown", rejections: 0 }), { reasonCode: "MODELS_CATEGORY_UNKNOWN" });
  const persisted = JSON.parse(await readFile(join(home, "engine-model-policy.json"), "utf8"));
  persisted.hosts["claude-code"].quota.weeklyWaitPercent = 98;
  assert.throws(() => resolveEngineExecutionPolicyFromSnapshot(persisted, { host: "claude-code", category: "economy", rejections: 0 }), { reasonCode: "ENGINE_MODEL_POLICY_FILE_INVALID" });
  assert.throws(() => validateEngineModelPolicy("codex", { ...legacy, quota: { ...DEFAULT_ENGINE_QUOTA_POLICY, observedUsage: 5 } }), { reasonCode: "EXECUTION_POLICY_INVALID" });
  assert.throws(() => validateEngineModelPolicy("codex", { ...legacy, escalation: { ...legacy.escalation, ceiling: false } }), { reasonCode: "ENGINE_MODEL_POLICY_INVALID" });
  assert.throws(() => validateEngineModelPolicy("codex", policy("claude-code")), { reasonCode: "ENGINE_MODEL_POLICY_INVALID" });
});

test("552: quota decisions are separate observations and project concurrency cannot expand device cap", () => {
  assert.equal(resolveExecutionConcurrency(4, 100).effectiveLimit, 4);
  assert.equal(resolveExecutionConcurrency(4, 2).effectiveLimit, 2);
  assert.equal(resolveExecutionConcurrency(4).origin, "device");
  assert.throws(() => resolveExecutionConcurrency(4, 0), { reasonCode: "EXECUTION_POLICY_INVALID" });
  const decision = (fiveHourUsedPercent, weeklyUsedPercent) => evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, { fiveHourUsedPercent, weeklyUsedPercent }).decision;
  assert.equal(decision(74.99, 94.99), "parallel");
  assert.equal(decision(75, 0), "serial");
  assert.equal(decision(0, 95), "serial");
  assert.equal(decision(90, 0), "wait");
  assert.equal(decision(0, 100), "serial");
  assert.deepEqual(evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, {}), { decision: "unknown", unknownWindows: ["five-hour", "weekly"] });
  assert.equal(evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, { fiveHourUsedPercent: 90 }).decision, "wait");
  for (const value of [-1, 101, NaN]) assert.throws(() => evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, { fiveHourUsedPercent: value }), { reasonCode: "EXECUTION_POLICY_INVALID" });
  for (const observation of [null, [], "usage"]) assert.throws(() => evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, observation), { reasonCode: "EXECUTION_POLICY_INVALID" });
  assert.throws(() => validateEngineQuotaPolicy({ ...DEFAULT_ENGINE_QUOTA_POLICY, fiveHourWaitPercent: 50 }), { reasonCode: "EXECUTION_POLICY_INVALID" });
});


test("552: CLI resolves device cap and quota separately without changing policy or choosing host defaults", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "engine-execution-policy-cli-"));
  const previousHome = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    if (previousHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  await save(home, "codex", policy());
  await applyMachineSettingSet({ key: "execution.maxConcurrentAgents", value: "3", occurredAt: "2026-10-17T12:00:00Z" });
  const before = await readFile(join(home, "engine-model-policy.json"), "utf8");
  const cli = async (extra = []) => {
    let text = "";
    await runCli(["execution-policy-resolve", "--host", "codex", "--category", "economy", "--rejections", "4", ...extra], { write(value) { text += value; } });
    return JSON.parse(text);
  };
  const unknown = await cli(["--project-budget", "100"]);
  assert.equal(unknown.reasonCode, "EXECUTION_POLICY_RESOLVED");
  assert.equal(unknown.record.model, "gpt-5.6-terra");
  assert.equal(unknown.record.effort, "max");
  assert.equal(unknown.concurrency.deviceLimit, 3);
  assert.equal(unknown.concurrency.effectiveLimit, 3);
  assert.equal(unknown.quotaDecision.decision, "unknown");
  assert.equal(unknown.observationSource, "unavailable");
  assert.equal(unknown.origin.revision, 1);
  assert.equal(unknown.capabilityStatus, "unchecked");
  const waiting = await cli(["--project-budget", "2", "--usage", JSON.stringify({ fiveHourUsedPercent: 90, weeklyUsedPercent: 20 })]);
  assert.equal(waiting.concurrency.effectiveLimit, 2);
  assert.equal(waiting.concurrency.origin, "project-budget");
  assert.equal(waiting.quotaDecision.decision, "wait");
  assert.equal(waiting.observationSource, "caller-supplied-unverified");
  assert.equal(await readFile(join(home, "engine-model-policy.json"), "utf8"), before);
  await assert.rejects(cli(["--project-budget", "0"]));
  await assert.rejects(cli(["--usage", JSON.stringify({ fiveHourUsedPercent: 101 })]));
});

test("partial usage never erases a known quota restriction", () => {
  assert.deepEqual(evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, { fiveHourUsedPercent: 80 }), { decision: "serial", unknownWindows: ["weekly"] });
  assert.equal(evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, { weeklyUsedPercent: 96 }).decision, "serial");
  assert.equal(evaluateExecutionQuota(DEFAULT_ENGINE_QUOTA_POLICY, { fiveHourUsedPercent: 90 }).decision, "wait");
});
