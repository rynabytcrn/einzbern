// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRecall } from "../scripts/performance/recall-summary.mjs";
import { withRecallObservation, observeStage, observeEventRead, observeRecall } from "../dist/build/packages/core/src/recall-observation.js";
test("644: fractional windows, duplicate results and nested spans are separate counts", () => {
  const observation = { correlationId: "one", recallCalls: 1, logicalEventBytes: 10, cpuMicros: 4, elapsedMs: 10, stages: [{ startMs: 0, endMs: 10 }, { startMs: 2, endMs: 8 }] };
  const a = { at: "2026-11-10T00:00:00.125Z", observation };
  const b = { ...a, at: "2026-11-10T00:00:00.250Z", observation: { ...observation, correlationId: "two" } };
  const result = summarizeRecall([a, a, b], { from: a.at, to: b.at });
  assert.equal(result.eventCount, 1); assert.equal(result.recallCount, 1); assert.equal(result.resultLogCount, 2);
  assert.equal(result.stageUnionMs, 10); assert.equal(result.logicalEventBytes, 10); assert.equal(result.osIoBytes, null);
});
test("644: concurrent observations do not mix counters or payloads", async () => {
  const [a, b] = await Promise.all([withRecallObservation(() => observeStage("read", async () => { observeEventRead(10); observeRecall("index-build"); return "secret prompt"; })), withRecallObservation(async () => { observeEventRead(20); })]);
  assert.equal(a.observation.logicalEventBytes, 10); assert.equal(b.observation.logicalEventBytes, 20);
  assert.equal(a.observation.recallCalls, 1); assert.equal(b.observation.recallCalls, 0);
  assert.equal(JSON.stringify(a.observation).includes("secret"), false);
});
