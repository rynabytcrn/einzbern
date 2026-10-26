// SPDX-License-Identifier: Apache-2.0
// Synthetic contract tests. These do not prove a native callback, adapter or delivery.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_COLLECTOR_INITIAL_PROGRESS,
  CODEX_SUBAGENT_STOP_CAPABILITY,
  CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX,
  evaluateCodexCollectorStop,
  handleCodexSubagentStop,
  validateCodexCollectorCapacity,
} from "../dist/build/packages/core/src/codex-subagent-stop.js";

const AT = "2026-10-26T12:00:00Z";
const IDENTITY = { role: "collector", batchId: "batch-1", agentId: "native-agent-1", attemptId: "application-attempt-1", parentSessionId: "parent-1" };
function input() {
  return {
    contract: { collector: { ...IDENTITY }, targetAgentIds: ["a", "b", "c"], startedAt: AT, deadline: "2026-10-26T12:05:00Z", queryIntervalMs: 30_000, maxConsecutiveQueryFailures: 3 },
    identity: { ...IDENTITY }, progress: { ...CODEX_COLLECTOR_INITIAL_PROGRESS }, collectorStatus: "live", now: AT,
    observation: { batchId: IDENTITY.batchId, attemptId: IDENTITY.attemptId, sequence: 0, observedAt: AT,
      facts: ["a", "b", "c"].map(agentId => ({ agentId, hostState: "running", finalityKind: "pending", evidenceRef: null, rawResult: null })),
      consecutiveQueryFailures: 0, exception: null },
  };
}
function terminal(value = input()) {
  value.observation.facts = value.observation.facts.map((fact, i) => ({ ...fact, hostState: ["completed", "errored", "shutdown"][i], finalityKind: ["completed", "failed", "cancelled_confirmed"][i], evidenceRef: `synthetic-${i}`, rawResult: { result: i } }));
  return value;
}

test("installed hook never enrolls a self-claimed first marker or consumes local files", async t => {
  const deviceHome = await mkdtemp(join(tmpdir(), "codex-stop-contract-"));
  t.after(() => rm(deviceHome, { recursive: true, force: true }));
  const ordinary = { agent_id: "ordinary", last_assistant_message: "native final unchanged" };
  const before = structuredClone(ordinary);
  assert.deepEqual(await handleCodexSubagentStop({ payload: ordinary, deviceHome }), { matched: false, decision: "allow" });
  assert.deepEqual(ordinary, before);
  for (const agent_id of ["spoof-before-first-binding", IDENTITY.agentId]) {
    const result = await handleCodexSubagentStop({ payload: { agent_id, session_id: IDENTITY.parentSessionId, last_assistant_message: `${CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX}${JSON.stringify({ ...IDENTITY, manifestPath: "/not/read" })}` }, deviceHome });
    assert.deepEqual(result, { matched: false, decision: "allow", reasonCode: "CODEX_STOP_CAPABILITY_UNAVAILABLE" });
  }
  assert.deepEqual(await readdir(deviceHome), []);
  assert.equal(CODEX_SUBAGENT_STOP_CAPABILITY.state, "unverified");
});

test("exactly one collector is cap-exempt but never hard-slot-exempt; other hosts are inapplicable", () => {
  const capacity = { host: "codex", workers: 2, collectors: 1, workerCap: 2, availableSlots: 3 };
  assert.equal(validateCodexCollectorCapacity(capacity).admitted, true);
  for (const collectors of [0, 2]) assert.equal(validateCodexCollectorCapacity({ ...capacity, collectors }).reasonCode, "EXACTLY_ONE_DEDICATED_COLLECTOR");
  assert.equal(validateCodexCollectorCapacity({ ...capacity, workers: 3, availableSlots: 4 }).reasonCode, "WORKER_CAP");
  assert.equal(validateCodexCollectorCapacity({ ...capacity, availableSlots: 2 }).reasonCode, "RESERVE_COLLECTOR_SLOT");
  assert.equal(validateCodexCollectorCapacity({ ...capacity, workers: 1, availableSlots: 1 }).admitted, false);
  for (const host of ["dot", "claude-code", "dsh"]) assert.equal(validateCodexCollectorCapacity({ ...capacity, host }).applicable, false);
});

test("role, batch, exact agent, attempt and parent must all match parent mapping", () => {
  for (const field of Object.keys(IDENTITY)) {
    const value = input(); value.identity[field] = "spoof";
    const result = evaluateCodexCollectorStop(value);
    assert.equal(result.outcome, "unrelated"); assert.equal(result.decision, "allow"); assert.equal(result.final, undefined);
  }
});

test("only same live collector continues; ended is not reused and unknown retains responsibility", () => {
  for (const [collectorStatus, outcome] of [["ended", "already-ended"], ["unknown", "capability-unavailable"]]) {
    const result = evaluateCodexCollectorStop({ ...input(), collectorStatus });
    assert.equal(result.outcome, outcome); assert.equal(result.final, undefined);
  }
});

test("pending and unknown wait boundedly; duplicate/early query is explicit no-progress, not a busy loop", () => {
  const value = input(); value.observation.facts[0].finalityKind = "unknown";
  const first = evaluateCodexCollectorStop(value);
  assert.equal(first.outcome, "waiting"); assert.equal(first.waitUntil, "2026-10-26T12:00:30.000Z");
  value.progress = first.progress;
  assert.equal(evaluateCodexCollectorStop(value).final.exception, "no-progress");
  value.observation.sequence++; value.observation.observedAt = value.now = "2026-10-26T12:00:10Z";
  assert.equal(evaluateCodexCollectorStop(value).final.exception, "no-progress");
  value.observation.observedAt = value.now = "2026-10-26T12:00:30Z";
  assert.equal(evaluateCodexCollectorStop(value).outcome, "waiting");
  value.contract.deadline = "2026-10-26T12:00:40Z";
  assert.equal(evaluateCodexCollectorStop(value).waitUntil, "2026-10-26T12:00:40.000Z");
});

test("inclusive freshness boundary still waits from now, never immediate reentry", () => {
  const start = Date.parse(AT);
  for (const age of [29_999, 30_000]) {
    for (const finalityKind of ["pending", "unknown"]) {
      const value = input();
      value.now = new Date(start + age).toISOString();
      value.observation.facts[0].finalityKind = finalityKind;
      const waiting = evaluateCodexCollectorStop(value);
      assert.equal(waiting.reasonCode, "CODEX_STOP_BOUNDED_WAIT");
      assert.equal(Date.parse(waiting.waitUntil) - Date.parse(value.now), value.contract.queryIntervalMs);
      assert.equal(waiting.progress.nextQueryAt, waiting.waitUntil);
      value.progress = waiting.progress;
      value.observation.sequence++;
      value.observation.observedAt = value.now = new Date(start + age + 1).toISOString();
      assert.equal(evaluateCodexCollectorStop(value).final.exception, "no-progress", "a newer observation cannot authorize early reentry");
    }
  }
  const terminalBoundary = terminal();
  terminalBoundary.now = new Date(start + 30_000).toISOString();
  assert.equal(evaluateCodexCollectorStop(terminalBoundary).outcome, "terminal", "inclusive freshness is unchanged");
  const clamped = input();
  clamped.now = new Date(start + 30_000).toISOString();
  clamped.contract.deadline = new Date(start + 30_001).toISOString();
  const waiting = evaluateCodexCollectorStop(clamped);
  assert.equal(waiting.waitUntil, clamped.contract.deadline);
  assert.ok(Date.parse(waiting.waitUntil) > Date.parse(clamped.now));
  clamped.now = clamped.observation.observedAt = clamped.contract.deadline;
  assert.equal(evaluateCodexCollectorStop(clamped).final.exception, "deadline");
});

test("all confirmed terminal raw facts return once without parent-message or acknowledgement", () => {
  const value = terminal(); const original = structuredClone(value);
  const result = evaluateCodexCollectorStop(value);
  assert.equal(result.decision, "allow"); assert.equal(result.outcome, "terminal");
  assert.deepEqual(result.final, { exception: null, facts: value.observation.facts });
  assert.deepEqual(value, original, "raw facts and inputs are not rewritten or summarized");
  assert.equal(evaluateCodexCollectorStop({ ...value, progress: result.progress }).final, undefined);
});

test("stale/future/pre-dispatch, replay, wrong attempt/batch, order and missing evidence never succeed", () => {
  const cases = [
    v => { v.now = "2026-10-26T12:00:31Z"; },
    v => { v.observation.observedAt = "2026-10-26T12:00:01Z"; },
    v => { v.observation.observedAt = "2026-10-26T11:59:59Z"; },
    v => { v.observation.attemptId = "other"; },
    v => { v.observation.batchId = "other"; },
    v => { v.observation.facts.reverse(); },
    v => { v.observation.facts[0].evidenceRef = null; },
    v => { v.observation.sequence = -1; },
  ];
  for (const mutate of cases) {
    const value = terminal(); mutate(value); const result = evaluateCodexCollectorStop(value);
    assert.equal(result.outcome, "exception"); assert.equal(result.final.exception, "protocol-error");
  }
  const value = terminal(); value.progress = { lastSequence: 0, lastObservedAt: AT, nextQueryAt: null, ended: false };
  assert.equal(evaluateCodexCollectorStop(value).final.exception, "no-progress");
});

test("bounded exceptional exits preserve raw states, including budget/pause/safety/permission", () => {
  for (const exception of ["deadline", "query-failure-limit", "budget-exhausted", "paused", "user-cancelled", "safety", "permission", "no-progress", "protocol-error", "script-error"]) {
    const value = input(); value.observation.exception = exception;
    const result = evaluateCodexCollectorStop(value);
    assert.equal(result.outcome, "exception"); assert.equal(result.decision, "allow");
    assert.deepEqual(result.final, { exception, facts: value.observation.facts });
    assert.equal(evaluateCodexCollectorStop({ ...value, progress: result.progress }).final, undefined);
  }
  const value = input(); value.now = value.observation.observedAt = value.contract.deadline;
  assert.equal(evaluateCodexCollectorStop(value).final.exception, "deadline");
  value.now = value.observation.observedAt = AT; value.observation.consecutiveQueryFailures = 3;
  assert.equal(evaluateCodexCollectorStop(value).final.exception, "query-failure-limit");
});

test("query failure and ambiguous raw states cannot be coerced into success", () => {
  const value = terminal(); value.observation.consecutiveQueryFailures = 1;
  assert.equal(evaluateCodexCollectorStop(value).outcome, "waiting");
  for (const hostState of ["idle", "notLoaded", "interrupted", "shutdown", "notFound"]) {
    const ambiguous = input(); ambiguous.observation.facts[0] = { ...ambiguous.observation.facts[0], hostState, finalityKind: "unknown" };
    assert.equal(evaluateCodexCollectorStop(ambiguous).outcome, "waiting");
  }
});


test("uncertain recovery progress never replays a final or enrolls a replacement", () => {
  for (const progress of [undefined, { ...CODEX_COLLECTOR_INITIAL_PROGRESS, lastSequence: NaN }, { ...CODEX_COLLECTOR_INITIAL_PROGRESS, lastObservedAt: "unknown" }]) {
    const result = evaluateCodexCollectorStop({ ...terminal(), progress });
    assert.equal(result.outcome, "capability-unavailable"); assert.equal(result.final, undefined);
  }
});
