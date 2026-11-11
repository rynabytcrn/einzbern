// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRecall, summarizePairedSamples } from "../scripts/performance/recall-summary.mjs";
import { withRecallObservation, observeStage, observeEventRead, observeRecall } from "../dist/build/packages/core/src/recall-observation.js";
test("644: fractional windows, duplicate results and nested spans are separate counts", () => {
  const observation = { correlationId: "one", recallCalls: 1, logicalEventBytes: 10, cpuMicros: 4, elapsedMs: 10, stages: [{ startMs: 0, endMs: 10 }, { startMs: 2, endMs: 8 }] };
  const a = { at: "2026-11-10T00:00:00.125Z", observation, reasonCode: "HOOK_RECALL_ANSWERED", outcome: "hit" };
  const b = { ...a, at: "2026-11-10T00:00:00.250Z", observation: { ...observation, correlationId: "two" } };
  const result = summarizeRecall([a, a, b], { from: a.at, to: b.at });
  assert.equal(result.eventCount, 1); assert.equal(result.recallCount, 1); assert.equal(result.resultLogCount, 2);
  assert.equal(result.reasonCounts.HOOK_RECALL_ANSWERED, 2); assert.equal(result.outcomeCounts.hit, 2); assert.equal(result.eventOutcomeCounts.hit, 1);
  assert.equal(result.stageUnionMs, 10); assert.equal(result.logicalEventBytes, 10); assert.equal(result.osIoBytes, null);
});
test("644: concurrent observations do not mix counters or payloads", async () => {
  const [a, b] = await Promise.all([withRecallObservation(() => observeStage("read", async () => { observeEventRead(10); observeRecall("index-build"); return "secret prompt"; })), withRecallObservation(async () => { observeEventRead(20); })]);
  assert.equal(a.observation.logicalEventBytes, 10); assert.equal(b.observation.logicalEventBytes, 20);
  assert.equal(a.observation.recallCalls, 1); assert.equal(b.observation.recallCalls, 0);
  assert.equal(JSON.stringify(a.observation).includes("secret"), false);
});

test("645: paired summaries retain failed samples and cannot accept an unconfirmed library", () => {
  const rows = Array.from({ length: 15 }, (_, pair) => (pair % 2 === 0 ? ["baseline", "candidate", "candidate-observed"] : ["candidate", "baseline", "candidate-observed"]).map(mode => ({
    pair, queryIndex: 0, mode, exit: 0, parseError: null, lifecycleElapsedMs: mode === "baseline" ? 20 : 10,
    sample: { authorityHead: "same-head", semanticSha256: "same-output", query: "same-query", at: "2026-11-10T15:00:00Z", logicalEventBytes: mode === "baseline" ? 200 : 100,
      maxRss: pair === 14 ? 200 : 100, operationElapsedMs: 1, operationCpuMicros: 1, processCpuMicros: 2, segmentReads: 1, materializations: 1 },
  }))).flat();
  const summary = summarizePairedSamples(rows);
  assert.equal(summary.cases[0].complete, true);
  assert.equal(summary.cases[0].logicalBytesRatio, 0.5);
  assert.deepEqual(summary.cases[0].groups.baseline.maxRssKiB, { p50: 100, p95: 200 });
  const unconfirmed = summarizePairedSamples(rows.map(row => ({ ...row, sample: { ...row.sample, authorityHead: null, logicalEventBytes: 0 } })));
  assert.equal(unconfirmed.cases[0].complete, false);
  assert.equal(unconfirmed.cases[0].thresholds.logicalBytesAtMost55Percent, null);
  const drifted = summarizePairedSamples(rows.map((row, index) => index === 1 ? { ...row, sample: { ...row.sample, query: "different-query" } } : row));
  assert.equal(drifted.cases[0].matchingPairs, false);
  const failed = summarizePairedSamples(rows.map((row, index) => index === 1 ? { ...row, exit: 1 } : row));
  assert.equal(failed.samples, 45);
  assert.equal(failed.failedSamples, 1);
  assert.equal(failed.cases[0].complete, false);
  assert.deepEqual(failed.cases[0].failures, [{ pair: 0, mode: "candidate", exit: 1, parseError: null }]);
});
