// SPDX-License-Identifier: Apache-2.0
// Source regressions for the Codex-only bounded collector continuation. This suite is authored
// for the batch build and is intentionally not run by the implementation package.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX,
  CODEX_SUBAGENT_STOP_SNAPSHOT_SCHEMA,
  createCodexSubagentStopManifest,
  handleCodexSubagentStop,
} from "../dist/build/packages/core/src/codex-subagent-stop.js";

const AT = "2026-10-26T12:00:00Z";
const COLLECTOR = "/root/collector_1";
const TARGETS = ["/root/target_a", "/root/target_b", "/root/target_c"];

async function fixture(t, { deadline = "2026-10-26T12:05:00Z", maxConsecutiveQueryFailures = 3 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-codex-stop-")));
  const deviceHome = join(root, "device");
  const manifest = createCodexSubagentStopManifest({
    deviceHome,
    batchId: "batch-20261026-1",
    nonce: "opaque-nonce-0123456789",
    collectorTaskName: COLLECTOR,
    targetTaskNames: TARGETS,
    queryIntervalMs: 30_000,
    deadline,
    maxConsecutiveQueryFailures,
  });
  await mkdir(dirname(manifest.manifestPath), { recursive: true });
  await writeFile(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, deviceHome, manifest };
}

function payload(manifest, overrides = {}) {
  return {
    session_id: "session-real-1",
    agent_id: "agent-real-1",
    stop_hook_active: false,
    last_assistant_message: `${CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX}${JSON.stringify({ batchId: manifest.batchId, nonce: manifest.nonce, manifestPath: manifest.manifestPath })}`,
    ...overrides,
  };
}

function row(taskName, finalityKind, evidenceRef = null) {
  return {
    taskName,
    hostState: finalityKind === "pending" || finalityKind === "unknown" ? "running" : `native-${finalityKind}`,
    finalityKind,
    evidenceRef,
  };
}

function snapshot(manifest, {
  observedAt = AT,
  states = ["pending", "pending", "pending"],
  nextQueryAt = "2026-10-26T12:00:30Z",
  consecutiveQueryFailures = 0,
  latestQueryError = null,
  exceptionReason = null,
  reportState = "not-started",
} = {}) {
  const terminalState = ["completed", "failed", "cancelled_confirmed"];
  return {
    schemaVersion: CODEX_SUBAGENT_STOP_SNAPSHOT_SCHEMA,
    batchId: manifest.batchId,
    nonce: manifest.nonce,
    observedAt,
    targets: manifest.targetTaskNames.map((name, index) => row(name, states[index], terminalState.includes(states[index]) ? `native-evidence://${index}` : null)),
    nextQueryAt,
    consecutiveQueryFailures,
    latestQueryError,
    exceptionReason,
    reportAttempt: {
      state: reportState,
      attemptedAt: ["in-flight", "acknowledged", "unknown", "failed"].includes(reportState) ? "2026-10-26T12:00:01Z" : null,
      toolName: ["in-flight", "acknowledged", "unknown", "failed"].includes(reportState) ? "native-parent-message" : null,
      evidenceRef: reportState === "acknowledged" ? "native-tool-result://ack-1" : null,
      detail: reportState === "unknown" ? "connection ended before acknowledgement" : null,
    },
  };
}

async function saveSnapshot(manifest, value) {
  await writeFile(manifest.snapshotPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function bindFirstStop(f, now = AT) {
  const result = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now });
  assert.equal(result.decision, "block", "the first matching stop binds real IDs and immediately continues synchronously");
  assert.equal(result.reasonCode, "CODEX_STOP_FIRST_BINDING");
  const binding = JSON.parse(await readFile(f.manifest.bindingPath, "utf8"));
  assert.deepEqual([binding.sessionId, binding.agentId], ["session-real-1", "agent-real-1"]);
  return result;
}

test("manifest helper fixes device-local batch paths and rejects fabricated or duplicate task names", async (t) => {
  const f = await fixture(t);
  assert.equal(f.manifest.manifestPath, join(f.deviceHome, "subagent-stop", "batches", f.manifest.batchId, "manifest.json"));
  assert.equal(f.manifest.snapshotPath, join(dirname(f.manifest.manifestPath), "snapshot.json"));
  assert.throws(() => createCodexSubagentStopManifest({ ...f.manifest, deviceHome: f.deviceHome, collectorTaskName: "collector_1" }), /actual native/u);
  assert.throws(() => createCodexSubagentStopManifest({ ...f.manifest, deviceHome: f.deviceHome, targetTaskNames: [COLLECTOR, COLLECTOR] }), /unique/u);
});

test("ordinary messages, wrong nonce and mismatched agent/session never bind or block", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await handleCodexSubagentStop({ payload: { last_assistant_message: "ordinary final" }, deviceHome: f.deviceHome, now: AT }), { matched: false, decision: "allow" });
  const wrongNonce = payload(f.manifest, { last_assistant_message: `${CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX}${JSON.stringify({ batchId: f.manifest.batchId, nonce: "different-nonce", manifestPath: f.manifest.manifestPath })}` });
  assert.equal((await handleCodexSubagentStop({ payload: wrongNonce, deviceHome: f.deviceHome, now: AT })).decision, "allow");
  assert.equal(await readFile(f.manifest.bindingPath, "utf8").catch(() => null), null, "a wrong nonce does not bind IDs");
  await bindFirstStop(f);
  for (const changed of [{ agent_id: "agent-replacement" }, { session_id: "session-replacement" }]) {
    const result = await handleCodexSubagentStop({ payload: payload(f.manifest, changed), deviceHome: f.deviceHome, now: AT });
    assert.equal(result.decision, "allow");
    assert.equal(result.reasonCode, "CODEX_STOP_ID_MISMATCH");
  }
  const binding = JSON.parse(await readFile(f.manifest.bindingPath, "utf8"));
  assert.deepEqual([binding.sessionId, binding.agentId], ["session-real-1", "agent-real-1"], "a replacement cannot rebind the same nonce");
});

test("pending snapshots enforce wait/query cadence, stop_hook_active is not completion, and no-progress repeats fail open", async (t) => {
  const f = await fixture(t);
  await bindFirstStop(f);
  await saveSnapshot(f.manifest, snapshot(f.manifest));
  const early = await handleCodexSubagentStop({ payload: payload(f.manifest, { stop_hook_active: true }), deviceHome: f.deviceHome, now: "2026-10-26T12:00:10Z" });
  assert.equal(early.decision, "block");
  assert.equal(early.reasonCode, "CODEX_STOP_WAIT_UNTIL_QUERY");
  assert.match(early.reason, /native wait\/sleep until 2026-10-26T12:00:30Z/u);
  const rapidRepeat = await handleCodexSubagentStop({ payload: payload(f.manifest, { stop_hook_active: true }), deviceHome: f.deviceHome, now: "2026-10-26T12:00:10Z" });
  assert.equal(rapidRepeat.decision, "allow", "the same snapshot cannot cause a fast Stop/block loop");
  const due = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: "2026-10-26T12:00:31Z" });
  assert.equal(due.decision, "block");
  assert.equal(due.reasonCode, "CODEX_STOP_QUERY_DUE");
  assert.match(due.reason, /each manifest targetTaskNames entry exactly once now/u);
  assert.equal((await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: "2026-10-26T12:00:31Z" })).decision, "allow");
  await saveSnapshot(f.manifest, snapshot(f.manifest, { observedAt: "2026-10-26T12:00:31Z", nextQueryAt: "2026-10-26T12:01:01Z" }));
  const advanced = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: "2026-10-26T12:00:32Z" });
  assert.equal(advanced.reasonCode, "CODEX_STOP_WAIT_UNTIL_QUERY", "a new snapshot permits the next bounded interval");
});

test("completed, failed and confirmed-cancelled targets remain distinct and require acknowledged one-time reporting", async (t) => {
  const f = await fixture(t);
  await bindFirstStop(f);
  await saveSnapshot(f.manifest, snapshot(f.manifest, { states: ["completed", "failed", "cancelled_confirmed"], nextQueryAt: null, reportState: "acknowledged" }));
  const result = await handleCodexSubagentStop({ payload: payload(f.manifest, { stop_hook_active: true }), deviceHome: f.deviceHome, now: AT });
  assert.equal(result.decision, "allow");
  assert.equal(result.reasonCode, "CODEX_STOP_REPORT_ACKNOWLEDGED");

  const unreported = await fixture(t);
  await bindFirstStop(unreported);
  await saveSnapshot(unreported.manifest, snapshot(unreported.manifest, { states: ["completed", "failed", "cancelled_confirmed"], nextQueryAt: null }));
  const report = await handleCodexSubagentStop({ payload: payload(unreported.manifest), deviceHome: unreported.deviceHome, now: AT });
  assert.equal(report.reasonCode, "CODEX_STOP_REPORT_ONCE");
  assert.match(report.reason, /reportAttempt state in-flight/u);
  const repeated = await handleCodexSubagentStop({ payload: payload(unreported.manifest), deviceHome: unreported.deviceHome, now: AT });
  assert.equal(repeated.decision, "allow", "a missing acknowledgement never authorizes another send");
});

test("an unknown target is not treated as complete even when the other fixed targets are terminal", async (t) => {
  const f = await fixture(t);
  await bindFirstStop(f);
  await saveSnapshot(f.manifest, snapshot(f.manifest, { states: ["unknown", "completed", "failed"] }));
  const result = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: AT });
  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "CODEX_STOP_WAIT_UNTIL_QUERY");
  assert.doesNotMatch(result.reason, /parent-message/u, "unknown is not terminal and cannot produce a success report");
});

test("in-flight reconciliation, unknown delivery and failed delivery do not trigger a second message", async (t) => {
  const f = await fixture(t);
  await bindFirstStop(f);
  await saveSnapshot(f.manifest, snapshot(f.manifest, { states: ["completed", "completed", "failed"], nextQueryAt: null, reportState: "in-flight" }));
  const reconcile = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: AT });
  assert.equal(reconcile.reasonCode, "CODEX_STOP_REPORT_RECONCILE_ONCE");
  assert.match(reconcile.reason, /do not call the parent-message tool again/u);
  const unreconciled = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: AT });
  assert.equal(unreconciled.decision, "allow");
  assert.equal(unreconciled.reasonCode, "CODEX_STOP_REPORT_UNCONFIRMED");

  for (const reportState of ["unknown", "failed"]) {
    const another = await fixture(t);
    await bindFirstStop(another);
    await saveSnapshot(another.manifest, snapshot(another.manifest, { states: ["completed", "completed", "completed"], nextQueryAt: null, reportState }));
    const final = await handleCodexSubagentStop({ payload: payload(another.manifest), deviceHome: another.deviceHome, now: AT });
    assert.equal(final.decision, "allow");
    assert.equal(final.reasonCode, reportState === "unknown" ? "CODEX_STOP_REPORT_UNKNOWN" : "CODEX_STOP_REPORT_FAILED");
  }
});

test("deadline, query failure, cancellation, script and protocol exceptions each get one focused continuation", async (t) => {
  const cases = [
    { exceptionReason: "deadline", deadline: "2026-10-26T12:00:10Z", now: "2026-10-26T12:00:11Z" },
    { exceptionReason: null, maxConsecutiveQueryFailures: 2, consecutiveQueryFailures: 2, expected: "query-failure-limit" },
    { exceptionReason: "user-cancelled" },
    { exceptionReason: "script-error" },
    { exceptionReason: "protocol-error" },
  ];
  for (const item of cases) {
    const f = await fixture(t, item);
    await bindFirstStop(f);
    await saveSnapshot(f.manifest, snapshot(f.manifest, {
      consecutiveQueryFailures: item.consecutiveQueryFailures ?? 0,
      exceptionReason: item.exceptionReason,
    }));
    const now = item.now ?? AT;
    const exception = item.expected ?? item.exceptionReason;
    const first = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now });
    assert.equal(first.decision, "block", exception);
    assert.equal(first.reasonCode, "CODEX_STOP_EXCEPTION_REPORT_ONCE", exception);
    assert.match(first.reason, new RegExp(exception, "u"));
    const second = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now });
    assert.equal(second.decision, "allow", `${exception}: no repeated error continuation`);
  }
});

test("malformed snapshots block once as a protocol error, then leave unresolved responsibility visible", async (t) => {
  const f = await fixture(t);
  await bindFirstStop(f);
  await saveSnapshot(f.manifest, { schemaVersion: CODEX_SUBAGENT_STOP_SNAPSHOT_SCHEMA, batchId: f.manifest.batchId, nonce: "wrong" });
  const first = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: AT });
  assert.equal(first.reasonCode, "CODEX_STOP_PROTOCOL_ERROR_ONCE");
  const second = await handleCodexSubagentStop({ payload: payload(f.manifest), deviceHome: f.deviceHome, now: AT });
  assert.equal(second.decision, "allow");
  assert.equal(second.reasonCode, "CODEX_STOP_PROTOCOL_ERROR_UNCONFIRMED");
});
