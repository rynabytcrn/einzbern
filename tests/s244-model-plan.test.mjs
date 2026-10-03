// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: named guard coverage for model-plan replay. Dispatch resolution
// (readDispatchConfig, resolveDispatch) retired with the dispatch settings it read
// (TCRN-CROSS-STORY-484 R3); the tiers are models.tiers (tests/models-tiers.test.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_EXECUTION_CONFIG,
  applyModelPlanAssign,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanRemove,
  applyModelPlanSet,
  validateModelPlanEffort,
  validateModelPlanState,
} from "../dist/build/packages/core/src/index.js";

const at = "2026-01-01T00:00:00Z";

const reason = (callback, reasonCode) => assert.throws(callback, (error) => error?.reasonCode === reasonCode);

test("S369/R4: model-plan fields preserve complete values and reject malformed records", () => {
  const unknown = applyModelPlanSet([], { host: "gemini", name: "valid", defaultModel: "model", updatedAt: at });
  assert.equal(unknown.record.host, "gemini");
  reason(() => applyModelPlanAssign(unknown.records, { host: "gemini", name: "missing", persona: "Verity", model: "model", updatedAt: at }, () => true), "MODEL_PLAN_NOT_FOUND");
  reason(() => applyModelPlanAssign(unknown.records, { host: "gemini", name: "valid", persona: "ghost", model: "model", updatedAt: at }, () => false), "MODEL_PLAN_PERSONA_UNKNOWN");
  reason(() => applyModelPlanSet([], { host: "", name: "valid", defaultModel: "model", updatedAt: at }), "MODEL_PLAN_RECORD_INVALID");
  reason(() => applyModelPlanSet([], { host: 42, name: "valid", defaultModel: "model", updatedAt: at }), "MODEL_PLAN_RECORD_INVALID");
  const long = applyModelPlanSet([], { host: "codex", name: "x".repeat(65), defaultModel: "m".repeat(129), updatedAt: at });
  assert.equal(long.record.name.length, 65); assert.equal(long.record.defaultModel.length, 129);
  reason(() => applyModelPlanSet([], { host: "codex", name: "", defaultModel: "model", updatedAt: at }), "MODEL_PLAN_NAME_INVALID");
  reason(() => applyModelPlanSet([], { host: "codex", name: "valid", defaultModel: "m\u0000", updatedAt: at }), "MODEL_PLAN_DEFAULT_MODEL_INVALID");
});

test("INC-145 M6: an active-plan reference refuses removal", () => {
  const created = applyModelPlanSet([], { host: "claude-code", name: "active-plan", defaultModel: "opus-5", updatedAt: at });
  reason(
    () => applyModelPlanRemove(created.records, { host: "claude-code", name: "active-plan" }, (record) => record.name === "active-plan" ? "setting execution.claudeCodeSubagentPlan" : undefined),
    "MODEL_PLAN_IN_USE",
  );
  assert.equal(created.records.length, 1);
});

// INC-152 wired MODEL_PLAN_IN_USE to the two subagent-plan settings. TCRN-CROSS-STORY-484 R3 retires
// both, and a retired key never becomes a current setting, so no setting holds a plan any more: the
// execution-config removal takes the plan out, and an unknown plan is still refused.
test("INC-152, STORY-484 R3: with the subagent-plan settings retired, no setting holds a plan in use", () => {
  const created = applyModelPlanSet([], { host: "claude-code", name: "wired-plan", defaultModel: "opus-5", updatedAt: at });
  const state = { ...EMPTY_EXECUTION_CONFIG, modelPlans: created.records };
  assert.deepEqual(applyModelPlanRemoveInExecutionConfig(state, { host: "claude-code", name: "wired-plan" }).modelPlans, []);
  reason(() => applyModelPlanRemoveInExecutionConfig(state, { host: "claude-code", name: "missing-plan" }), "MODEL_PLAN_NOT_FOUND");
});

test("S369: free effort values round-trip without a roster", () => {
  for (const effort of ["none", "ultra", "ultracode", "xhigh2", ""]) {
    assert.equal(validateModelPlanEffort(effort, "gemini"), effort);
    const created = applyModelPlanSet([], { host: "gemini", name: `plan-${effort || "empty"}`, defaultModel: "model", defaultEffort: effort, updatedAt: at });
    assert.equal(created.record.defaultEffort, effort);
    const assigned = applyModelPlanAssign(created.records, { host: "gemini", name: created.record.name, persona: "Verity", model: "model", effort, updatedAt: at }, () => true);
    assert.equal(assigned.record.efforts?.Verity, effort);
  }
});

test("S369: historical model-plan envelopes retain optional fields exactly", () => {
  const plain = applyModelPlanSet([], { host: "codex", name: "plain", defaultModel: "gpt-5", updatedAt: at });
  const defaulted = applyModelPlanSet([], { host: "codex", name: "defaulted", defaultModel: "gpt-5", defaultEffort: "ultracode", updatedAt: at });
  const withEfforts = applyModelPlanAssign(plain.records, { host: "codex", name: "plain", persona: "Verity", model: "gpt-5", effort: "xhigh2", updatedAt: at }, () => true);
  const both = applyModelPlanAssign(defaulted.records, { host: "codex", name: "defaulted", persona: "Verity", model: "gpt-5", effort: "", updatedAt: at }, () => true);

  for (const record of [plain.record, defaulted.record, withEfforts.record, both.record]) {
    assert.deepEqual(validateModelPlanState([record]), [record]);
  }
  assert.equal(Object.hasOwn(plain.record, "defaultEffort"), false);
  assert.equal(Object.hasOwn(plain.record, "efforts"), false);
  reason(() => validateModelPlanState([{ ...plain.record, surprise: "x" }]), "MODEL_PLAN_RECORD_INVALID");
});
