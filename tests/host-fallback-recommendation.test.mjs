// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import test from "node:test";
import assert from "node:assert/strict";
import { recommendHostFallbacks, resolveHostExecution } from "../dist/build/packages/core/src/execution-fallback.js";
import { readEngineModelPolicyFile } from "../dist/build/packages/core/src/engine-model-policy.js";
import { nativeFixture, tuple, at } from "./helpers/host-native-fixture.mjs";
const explicit = tuple => ({ kind: "explicit", tuple });
test("T20 recommendation uses observed options, soft ordering and three-display budget, not authorization count", async t => {
  const f = await nativeFixture(t), policy = await readEngineModelPolicyFile(f.home);
  const options = [{ ...tuple, model: "other" }, { ...tuple, effort: "low" }, { ...tuple, model: "third" }, { ...tuple, model: "fourth" }];
  const request = { ...f.request, capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported", combinations: options } };
  const result = recommendHostFallbacks(request, policy, at);
  assert.equal(result.candidates.length, 3); assert.equal(result.omittedCount, 2); assert.equal(result.candidates[0].selection.tuple.model, tuple.model);
  assert.equal(result.candidates[0].selection.tuple.effort, "low"); assert.equal(result.candidates.every(item => item.expectedCost === "unknown" && item.expectedQuality === "unknown"), true);
  assert.equal(result.executionAdmission, false); assert.equal(result.persistentConfigWrites, 0);
  // An option outside the display budget remains directly usable under existing category authority.
  const decision = resolveHostExecution({ ...request, fallbackSelection: explicit(options[3]) }, policy, "fixture", at);
  assert.equal(decision.status, "degraded"); assert.equal(decision.additionalConfirmationsRequired, false);
});
test("T20 never invents effort mappings or supported options; stale/negative observations are respected", async t => {
  const f = await nativeFixture(t), policy = await readEngineModelPolicyFile(f.home);
  const candidate = explicit({ runner: "another-provider", model: "reported", effort: "provider-special" });
  const request = { ...f.request, capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported", hostManagedSupported: false, selectionObservations: [{ selection: candidate, support: "supported", observedAt: at }] } };
  const result = recommendHostFallbacks(request, policy, at);
  assert.equal(result.candidates.length, 1); assert.deepEqual(result.candidates[0].selection, candidate); assert.equal(result.candidates[0].authorizationDecision, "awaiting-choice");
  assert.equal(recommendHostFallbacks({ ...request, capabilities: { ...request.capabilities, selectionObservations: [] } }, policy, at).candidates.length, 0);
  assert.equal(recommendHostFallbacks({ ...request, capabilities: { ...request.capabilities, selectionObservations: [{ selection: candidate, support: "supported", observedAt: "2026-10-20T00:00:00Z" }] } }, policy, at).candidates.length, 0);
});
test("T20 hard limits and actual tool absence are not recommendations; core never requires recommendation", async t => {
  const f = await nativeFixture(t), policy = await readEngineModelPolicyFile(f.home);
  assert.equal(recommendHostFallbacks({ ...f.request, capabilities: { ...f.request.capabilities, toolAvailable: false } }, policy, at).candidates.length, 0);
  const limited = { ...f.request, hardLimits: { exactSelection: f.request.selection }, capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported", combinations: [{ ...tuple, effort: "low" }] } };
  assert.equal(recommendHostFallbacks(limited, policy, at).candidates.length, 0);
  assert.equal(resolveHostExecution(f.request, policy, "no-recommendation-module", at).status, "degraded");
});

test("recommendation CLI is independently reachable and returns no execution or save receipt", async t => {
  const f = await nativeFixture(t); const path = join(f.root, "recommend.json");
  await writeFile(path, JSON.stringify({ ...f.request, capabilities: { ...f.request.capabilities, requestedSelectionSupported: "unsupported", combinations: [{ ...tuple, effort: "low" }] } }));
  let output = ""; await runCli(["execution-fallback-candidates", "--request", path, "--at", at], { write: value => { output += value; } });
  const result = JSON.parse(output); assert.equal(result.schemaVersion, "tcrn.host-fallback-recommendation.v1"); assert.equal(result.executionAdmission, false); assert.equal(result.persistentConfigWrites, 0); assert.equal(result.candidates.length, 2);
});
