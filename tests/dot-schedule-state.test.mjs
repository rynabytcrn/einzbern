// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { advanceContextPatrol, initialContextPatrolState, resolveScheduleInstance, scheduleScopeDigest } from "../dist/build/packages/core/src/dot-schedule-state.js";
const scope = { purpose: "authorized-context-patrol", libraryScope: ["fixture:library"], projectScope: ["fixture:project"], environmentRef: "fixture:environment" };
function readback(enabled = true, at = "2026-10-20T05:00:00Z") { return { automationId: "fixture:actual-id", scopeDigest: scheduleScopeDigest(scope), intervalMinutes: 20, timezone: "Etc/UTC", isEnabled: enabled, observedAt: at, evidenceRef: "fixture:readback" }; }
function active(override = null) { return advanceContextPatrol(initialContextPatrolState(scope, "fixture:actual-id", override), { kind: "readback", readback: readback() }); }
function check(id, at, extra = {}) { return { checkId: id, observedAt: at, outcome: "success", nativeAttempts: [], visibleTaskRevisions: ["fixture:work@1"], activeAttemptRefs: [], receivedWorkRefs: [], terminalKind: "completed", terminalFingerprint: "fixture:completed", allActionablePathsBlocked: false, blockersExplained: false, independentWorkAvailable: false, evidenceRef: "fixture:check", ...extra }; }
const one = check("one", "2026-10-20T05:00:00Z"); const two = check("two", "2026-10-20T05:20:00Z");
function candidate() { return advanceContextPatrol(advanceContextPatrol(active(), { kind: "check", check: one }), { kind: "check", check: two }); }
// Explicit synthetic action-return observations, not a scheduler call or assembly clock.
function observeAction(state, action, returnedAt) { return advanceContextPatrol(state, { kind: "action-observed", action, automationId: "fixture:actual-id", returnedAt, evidenceRef: `fixture:${action}-return:${returnedAt}` }); }
function failedAction(state, action, returnedAt, error) {
  const observed = observeAction(state, action, returnedAt);
  return advanceContextPatrol(observed, { kind: "action-failed", action, error, actionEvidenceRef: observed.pendingMutation.observation.evidenceRef });
}
test("DOT-S01 actual ID and scope deduplicate; unknown create is queried", () => {
  assert.equal(resolveScheduleInstance(scope, null, [], "unknown").status, "query-required");
  assert.equal(resolveScheduleInstance(scope, "fixture:actual-id", [readback()]).status, "reuse");
  assert.equal(resolveScheduleInstance(scope, "fixture:actual-id", [{ ...readback(), automationId: "fixture:other" }]).status, "query-required");
  assert.equal(resolveScheduleInstance(scope, null, [readback(), { ...readback(), automationId: "fixture:other" }]).status, "conflict");
});
test("DOT-S02 two distinct successful checks are spaced by at least twenty minutes", () => {
  const first = advanceContextPatrol(active(), { kind: "check", check: one });
  assert.equal(advanceContextPatrol(first, { kind: "check", check: one }).terminal.count, 1);
  assert.equal(advanceContextPatrol(first, { kind: "check", check: check("early", "2026-10-20T05:19:59Z") }).terminal.count, 1);
  assert.equal(candidate().pendingAction, "read-before-pause");
});
test("DOT-S02 ordinary blocked/running/failed/unknown is not terminal", () => {
  for (const extra of [{ terminalKind: null }, { activeAttemptRefs: ["fixture:running"] }, { nativeAttempts: [{ attempt: { executionStatus: "unknown" } }] }, { outcome: "failed" }, { outcome: "unknown" }, { terminalKind: "blocked_terminal" }]) {
    assert.equal(advanceContextPatrol(candidate(), { kind: "check", check: check("invalid", "2026-10-20T05:40:00Z", extra) }).terminal, null);
  }
  const blocked = check("blocked", "2026-10-20T05:40:00Z", { terminalKind: "blocked_terminal", terminalFingerprint: "fixture:blocked", allActionablePathsBlocked: true, blockersExplained: true });
  assert.equal(advanceContextPatrol(candidate(), { kind: "check", check: blocked }).terminal.count, 1);
});
test("DOT-S02 pause requires before and after reads; interleaved new work resumes same ID", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  assert.equal(pending.pendingAction, "disable-same-instance");
  const disabled = advanceContextPatrol(observeAction(pending, "pause", "2026-10-20T05:20:01.500Z"), { kind: "readback", readback: readback(false, "2026-10-20T05:20:02Z") });
  assert.equal(disabled.pendingAction, "read-after-pause");
  const resumed = advanceContextPatrol(disabled, { kind: "after-pause", check: check("after", "2026-10-20T05:20:03Z", { receivedWorkRefs: ["fixture:new"] }), readback: readback(false, "2026-10-20T05:20:03Z") });
  assert.equal(resumed.state, "pending-resume"); assert.equal(resumed.automationId, "fixture:actual-id");
  const failed = failedAction(resumed, "resume", "2026-10-20T05:20:03.500Z", "fixture:unknown outcome");
  assert.equal(failed.state, "pending-resume"); assert.deepEqual(failed.receivedWorkRefs, ["fixture:new"]);
  assert.equal(advanceContextPatrol(failed, { kind: "readback", readback: readback(true, "2026-10-20T05:20:04Z") }).state, "active");
});
test("DOT-S02 pause readback with unchanged terminal permits paused only after post-read", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  assert.equal(advanceContextPatrol(observeAction(pending, "pause", "2026-10-20T05:20:01.500Z"), { kind: "after-pause", check: check("after", "2026-10-20T05:20:02Z"), readback: readback(false, "2026-10-20T05:20:02Z") }).state, "paused");
});
test("DOT-S02 keep-enabled override is independent of the stable pause policy", () => {
  const state = active({ mode: "keep-enabled", evidenceRef: "fixture:owner-override" });
  const next = advanceContextPatrol(advanceContextPatrol(state, { kind: "check", check: one }), { kind: "check", check: two });
  assert.equal(next.state, "active"); assert.equal(next.pendingAction, null); assert.equal(next.terminal, null);
});

import { initialDailyConfigBackupState, dailyConfigBackupSlot, evaluateDailyConfigBackup, readbackDailyConfigBackup, recordDailyConfigBackupCompletion } from "../dist/build/packages/core/src/dot-schedule-state.js";
import { validateConfigBackupRetentionPolicy } from "../dist/build/packages/core/src/config-backup-retention.js";
function backupGate() {
  // Explicit synthetic values for sequential tests, never production policy defaults.
  const policy = { schemaVersion: "einzbern.config-backup-retention.v1", activeLimit: 2, transactionLimit: 2, recoveryLimit: 2, maxPackageBytes: 1000, maxTotalBytes: 5000, retentionDuration: 10000, recoveryDuration: 10000, noChangePolicy: "skip", atLimitAction: "stop-new-and-report", retirementMethod: "verified-recovery-move", approvalEvidenceRef: "fixture:policy-approval" };
  const validated = validateConfigBackupRetentionPolicy(policy);
  return { policy, approval: { policyDigest: validated.policyDigest, approvalEvidenceRef: policy.approvalEvidenceRef, approved: true }, whitelistSupported: true, restoreSupported: true, groupBound: true, safeRetirementSupported: true, enablementAuthorized: true };
}
test("DOT-S03/CFG-B03 daily task starts disabled and incomplete policy never becomes defaults", () => {
  const state = initialDailyConfigBackupState({ automationId: "fixture:backup-id", groupRef: "fixture:group", selectionDigest: "a".repeat(64) });
  const denied = evaluateDailyConfigBackup(state, { ...backupGate(), policy: {} }, { deduplicationVerified: true, readbackAvailable: true, actualEnablementAuthorizationRef: "fixture:enable" });
  assert.equal(denied.state.state, "disabled"); assert.equal(denied.reason, "policy-unapproved");
  const ready = evaluateDailyConfigBackup(state, backupGate(), { deduplicationVerified: true, readbackAvailable: true, actualEnablementAuthorizationRef: "fixture:enable" });
  assert.equal(ready.eligible, true); assert.equal(ready.state.state, "pending-enablement");
});
test("DOT-S03 fixed UTC+08 midnight and delayed snapshot are independent from patrol", () => {
  assert.equal(dailyConfigBackupSlot("2026-10-20T15:59:59Z"), "2026-10-19T16:00:00.000Z");
  assert.equal(dailyConfigBackupSlot("2026-10-20T16:00:00Z"), "2026-10-20T16:00:00.000Z");
  const initial = initialDailyConfigBackupState({ automationId: "fixture:backup-id", groupRef: "fixture:group", selectionDigest: "a".repeat(64) });
  const read = { automationId: "fixture:backup-id", groupRef: initial.groupRef, selectionDigest: initial.selectionDigest, timezone: "Asia/Shanghai", dailyLocalTime: "00:00", isEnabled: true, observedAt: atForBackup(), evidenceRef: "fixture:backup-read" };
  assert.equal(readbackDailyConfigBackup(initial, read, backupGate()).state, "unknown");
  const pending = evaluateDailyConfigBackup(initial, backupGate(), { deduplicationVerified: true, readbackAvailable: true, actualEnablementAuthorizationRef: "fixture:enable" }).state;
  const enabled = readbackDailyConfigBackup(pending, read, backupGate());
  const completed = recordDailyConfigBackupCompletion(enabled, { snapshotCapturedAt: "2026-10-20T17:00:00Z", actualCompletedAt: "2026-10-20T17:01:00Z", backupReceiptRef: "fixture:backup-receipt" });
  assert.equal(completed.missedScheduleAt, "2026-10-20T16:00:00.000Z"); assert.equal(completed.actualCompletedAt, "2026-10-20T17:01:00Z");
  assert.equal(active().state, "active");
  const disabled = readbackDailyConfigBackup(completed, { automationId: "fixture:backup-id", groupRef: initial.groupRef, selectionDigest: initial.selectionDigest, timezone: "Asia/Shanghai", dailyLocalTime: "00:00", isEnabled: false, observedAt: "2026-10-20T18:00:00Z", evidenceRef: "fixture:disable-read" }, backupGate());
  assert.equal(disabled.backupReceiptRef, completed.backupReceiptRef); assert.equal(disabled.state, "disabled");
});
function atForBackup() { return "2026-10-20T16:00:00Z"; }

test("J11 scheduler action responsibility survives later terminal task checks", () => {
  const pendingPause = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  assert.deepEqual(advanceContextPatrol(pendingPause, { kind: "check", check: check("late", "2026-10-20T05:40:00Z") }), { ...pendingPause, knownObservationAt: "2026-10-20T05:40:00Z" });
  const paused = advanceContextPatrol(observeAction(pendingPause, "pause", "2026-10-20T05:20:01.500Z"), { kind: "after-pause", check: check("after", "2026-10-20T05:20:02Z"), readback: readback(false, "2026-10-20T05:20:02Z") });
  const resume = advanceContextPatrol(paused, { kind: "new-work", workRefs: ["fixture:new-work"] });
  const failed = failedAction(resume, "resume", "2026-10-20T05:30:00Z", "fixture:resume-unknown");
  for (const kind of ["check", "before-pause"]) {
    const unchanged = advanceContextPatrol(failed, { kind, check: check("late", "2026-10-20T05:40:00Z") });
    assert.equal(unchanged.state, "pending-resume"); assert.equal(unchanged.lastError, failed.lastError);
    assert.deepEqual(unchanged.receivedWorkRefs, failed.receivedWorkRefs); assert.equal(unchanged.pendingAction, "enable-same-instance");
  }
  const stillDisabled = advanceContextPatrol(failed, { kind: "after-pause", check: check("after-resume", "2026-10-20T05:40:00Z"), readback: readback(false, "2026-10-20T05:40:00Z") });
  assert.equal(stillDisabled.state, "pending-resume"); assert.equal(stillDisabled.lastError, failed.lastError);
  assert.deepEqual(stillDisabled.receivedWorkRefs, failed.receivedWorkRefs);
  assert.equal(advanceContextPatrol(failed, { kind: "readback", readback: readback(true, "2026-10-20T05:41:00Z") }).state, "active");
});

test("RJ02 failed pause stays unknown across ordinary checks and new work until fresh same-instance readback", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const failed = failedAction(pending, "pause", "2026-10-20T05:30:00Z", "fixture:pause-outcome-unknown");
  for (const override of [null, { mode: "keep-enabled", evidenceRef: "fixture:owner-override" }]) {
    let unresolved = { ...failed, ownerOverride: override };
    for (const [kind, extra] of [["check", {}], ["check", { terminalKind: null }], ["before-pause", { receivedWorkRefs: ["fixture:check-work"] }], ["check", { outcome: "unknown" }]]) {
      unresolved = advanceContextPatrol(unresolved, { kind, check: check("later", "2026-10-20T05:40:00Z", extra) });
      assert.equal(unresolved.state, "unknown"); assert.equal(unresolved.pendingAction, "query-instance"); assert.equal(unresolved.lastError, failed.lastError);
      assert.deepEqual(unresolved.lastReadback, failed.lastReadback); assert.equal(unresolved.terminal, null);
    }
    unresolved = advanceContextPatrol(unresolved, { kind: "new-work", workRefs: ["fixture:new-work"] });
    assert.equal(unresolved.state, "unknown"); assert.equal(unresolved.pendingAction, "query-instance"); assert.equal(unresolved.lastError, failed.lastError);
    assert.deepEqual(unresolved.receivedWorkRefs, ["fixture:check-work", "fixture:new-work"]);
    assert.throws(() => advanceContextPatrol(unresolved, { kind: "readback", readback: failed.lastReadback }), /actual same-instance action observation/u);
    assert.throws(() => advanceContextPatrol(unresolved, { kind: "readback", readback: { ...readback(true, "2026-10-20T05:41:00Z"), automationId: "fixture:wrong-id" } }), /original instance/u);
    const disabled = advanceContextPatrol(unresolved, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") });
    assert.equal(disabled.state, "pending-resume"); assert.equal(disabled.pendingAction, "enable-same-instance"); assert.equal(disabled.lastError, failed.lastError);
    assert.deepEqual(disabled.receivedWorkRefs, unresolved.receivedWorkRefs); assert.equal(disabled.automationId, failed.automationId);
    const enabled = advanceContextPatrol(observeAction(disabled, "resume", "2026-10-20T05:41:30Z"), { kind: "readback", readback: readback(true, "2026-10-20T05:42:00Z") });
    assert.equal(enabled.state, "active"); assert.equal(enabled.pendingAction, null); assert.equal(enabled.lastError, null); assert.deepEqual(enabled.receivedWorkRefs, []);
    const enabledDirectly = advanceContextPatrol(unresolved, { kind: "readback", readback: readback(true, "2026-10-20T05:41:00Z") });
    assert.equal(enabledDirectly.state, "active"); assert.equal(enabledDirectly.lastError, null);
  }
  assert.equal(advanceContextPatrol(failed, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") }).state, "paused");
  const kept = advanceContextPatrol({ ...failed, ownerOverride: { mode: "keep-enabled", evidenceRef: "fixture:owner-override" } }, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") });
  assert.equal(kept.state, "pending-resume");
});

test("RJ02 actual action boundary rejects late pre-action observations in both readback consumers", () => {
  const prepared = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const pending = observeAction(prepared, "pause", "2026-10-20T05:30:00Z");
  const failed = advanceContextPatrol(pending, { kind: "action-failed", action: "pause", error: "fixture:pause-unknown", actionEvidenceRef: pending.pendingMutation.observation.evidenceRef });
  const unresolved = advanceContextPatrol(failed, { kind: "new-work", workRefs: ["fixture:received-after-pause"] });
  const original = structuredClone(unresolved);
  // Old readback 05:00 < late 05:10 < precheck 05:20:01 < action 05:30.
  // The 05:25 observation also cannot stand in for the later actual action.
  for (const at of ["2026-10-20T05:10:00Z", "2026-10-20T05:25:00Z", "2026-10-20T05:30:00Z"]) {
    assert.throws(() => advanceContextPatrol(unresolved, { kind: "readback", readback: readback(true, at) }), /actual same-instance action observation/u);
    for (const kind of ["readback", "after-pause"]) {
      assert.throws(() => advanceContextPatrol(pending, { kind, readback: readback(false, at), ...(kind === "after-pause" ? { check: check("after", "2026-10-20T05:31:00Z") } : {}) }), /actual same-instance action observation/u);
    }
  }
  assert.deepEqual(unresolved, original);
  for (const difference of [{ automationId: "fixture:wrong-id" }, { scopeDigest: "f".repeat(64) }, { intervalMinutes: 10 }]) {
    assert.throws(() => advanceContextPatrol(unresolved, { kind: "readback", readback: { ...readback(true, "2026-10-20T05:31:00Z"), ...difference } }), /original instance/u);
    assert.throws(() => advanceContextPatrol(pending, { kind: "after-pause", check: check("after", "2026-10-20T05:31:00Z"), readback: { ...readback(false, "2026-10-20T05:31:00Z"), ...difference } }), /original instance/u);
  }
  const disabled = advanceContextPatrol(unresolved, { kind: "readback", readback: readback(false, "2026-10-20T05:31:00Z") });
  assert.equal(disabled.state, "pending-resume"); assert.equal(disabled.pendingMutation.action, "resume"); assert.equal(disabled.pendingMutation.observation, null);
  assert.equal(disabled.lastError, failed.lastError); assert.deepEqual(disabled.receivedWorkRefs, unresolved.receivedWorkRefs);
  const resumed = observeAction(disabled, "resume", "2026-10-20T05:40:00Z");
  for (const at of ["2026-10-20T05:35:00Z", "2026-10-20T05:40:00Z"]) {
    for (const kind of ["readback", "after-pause"]) {
      assert.throws(() => advanceContextPatrol(resumed, { kind, readback: readback(true, at), ...(kind === "after-pause" ? { check: check("after-resume", "2026-10-20T05:41:00Z") } : {}) }), /actual same-instance action observation/u);
    }
  }
  for (const kind of ["readback", "after-pause"]) {
    const enabled = advanceContextPatrol(resumed, { kind, readback: readback(true, "2026-10-20T05:41:00Z"), ...(kind === "after-pause" ? { check: check("after-resume", "2026-10-20T05:41:00Z") } : {}) });
    assert.equal(enabled.state, "active"); assert.equal(enabled.pendingAction, null); assert.equal(enabled.pendingMutation, null); assert.equal(enabled.lastError, null); assert.deepEqual(enabled.receivedWorkRefs, []);
  }
});

test("RJ02 missing or unlinked actual action boundary remains unknown without inventing a clock", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const workRefs = ["fixture:received-work"];
  for (const kind of ["readback", "after-pause"]) {
    const unknown = advanceContextPatrol({ ...pending, receivedWorkRefs: workRefs, lastError: "fixture:missing-return" }, { kind, readback: readback(true, "2026-10-20T06:00:00Z"), ...(kind === "after-pause" ? { check: check("after", "2026-10-20T06:00:01Z") } : {}) });
    assert.equal(unknown.state, "unknown"); assert.equal(unknown.pendingAction, "query-instance"); assert.equal(unknown.pendingMutation.observation, null);
    assert.equal(unknown.lastError, "fixture:missing-return"); assert.deepEqual(unknown.receivedWorkRefs, workRefs); assert.deepEqual(unknown.lastReadback, pending.lastReadback);
  }
  const observed = observeAction(pending, "pause", "2026-10-20T05:30:00Z");
  assert.throws(() => advanceContextPatrol(observed, { kind: "action-failed", action: "pause", error: "fixture:failed", actionEvidenceRef: "fixture:unrelated-action" }), /bind the actual/u);
  // A later failure without an actual source cannot borrow the first attempt's time.
  const unlinked = advanceContextPatrol(observed, { kind: "action-failed", action: "pause", error: "fixture:unlinked-failure" });
  assert.equal(unlinked.pendingMutation.priorReturnedAt, "2026-10-20T05:30:00Z");
  for (const at of ["2026-10-20T05:25:00Z", "2026-10-20T05:30:00Z"]) assert.throws(() => observeAction(unlinked, "pause", at), /causal boundary/u);
  const received = advanceContextPatrol(unlinked, { kind: "new-work", workRefs });
  const unknown = advanceContextPatrol(received, { kind: "readback", readback: readback(true, "2026-10-20T06:00:00Z") });
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.pendingAction, "query-instance"); assert.equal(unknown.pendingMutation.observation, null);
  assert.equal(unknown.lastError, unlinked.lastError); assert.deepEqual(unknown.receivedWorkRefs, workRefs); assert.deepEqual(unknown.lastReadback, pending.lastReadback);
  const legacy = structuredClone(received); delete legacy.pendingMutation;
  const legacyUnknown = advanceContextPatrol(legacy, { kind: "readback", readback: readback(true, "2026-10-20T06:00:00Z") });
  assert.equal(legacyUnknown.state, "unknown");
  assert.equal(advanceContextPatrol(legacyUnknown, { kind: "readback", readback: readback(true, "2026-10-20T06:01:00Z") }).state, "unknown");
  const known = observeAction(received, "pause", "2026-10-20T05:40:00Z");
  const resumed = advanceContextPatrol(known, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") });
  const missingResume = advanceContextPatrol(resumed, { kind: "readback", readback: readback(true, "2026-10-20T05:42:00Z") });
  assert.equal(missingResume.state, "unknown"); assert.equal(missingResume.pendingMutation.action, "resume"); assert.equal(missingResume.lastError, unlinked.lastError);
  assert.deepEqual(missingResume.receivedWorkRefs, workRefs);
  const actualResume = observeAction(missingResume, "resume", "2026-10-20T05:43:00Z");
  assert.equal(advanceContextPatrol(actualResume, { kind: "readback", readback: readback(true, "2026-10-20T05:44:00Z") }).state, "active");
});

test("RJ02 action observations bind the pending kind and instance and cannot move the boundary backward", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  assert.throws(() => observeAction(pending, "resume", "2026-10-20T05:30:00Z"), /pending same-instance mutation/u);
  assert.throws(() => advanceContextPatrol(pending, { kind: "action-observed", action: "pause", automationId: "fixture:wrong-id", returnedAt: "2026-10-20T05:30:00Z", evidenceRef: "fixture:wrong-instance" }), /pending same-instance mutation/u);
  assert.throws(() => observeAction(pending, "pause", "2026-10-20T05:10:00Z"), /causal boundary/u);
  const observed = observeAction(pending, "pause", "2026-10-20T05:30:00Z");
  assert.throws(() => observeAction(observed, "pause", "2026-10-20T05:25:00Z"), /causal boundary/u);
  assert.deepEqual(observeAction(observed, "pause", "2026-10-20T05:30:00Z"), observed);
  assert.equal(observed.state, "pending-pause"); assert.equal(observed.lastReadback.isEnabled, true);
});

test("RJ02 L01/L02 initial queries and request prerequisites never manufacture action observations", () => {
  const initial = initialContextPatrolState(scope, "fixture:actual-id");
  for (const isEnabled of [true, false]) {
    const queried = advanceContextPatrol(initial, { kind: "readback", readback: readback(isEnabled) });
    assert.equal(queried.state, isEnabled ? "active" : "paused"); assert.equal(queried.pendingMutation, null);
  }
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  assert.equal(pending.pendingMutation.requestNotBefore, "2026-10-20T05:20:01Z");
  assert.equal(pending.pendingMutation.priorReturnedAt, null); assert.equal(pending.pendingMutation.observation, null);
  // The prerequisite is inclusive, but only an actual supplied action can fill observation.
  const observed = observeAction(pending, "pause", "2026-10-20T05:20:01Z");
  assert.equal(observed.state, "pending-pause");
  assert.throws(() => advanceContextPatrol(observed, { kind: "readback", readback: readback(false, "2026-10-20T05:20:01Z") }), /actual same-instance action observation/u);
});

test("RJ02 L04/L05/L06 all terminal-clearing paths retain the originating pause request boundary", () => {
  const pending = { ...advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") }), receivedWorkRefs: ["fixture:original-work"], lastError: "fixture:missing-source" };
  const paths = [
    ["unlinked-failure", { kind: "action-failed", action: "pause", error: pending.lastError }, []],
    ["missing-readback", { kind: "readback", readback: readback(true, "2026-10-20T05:41:00Z") }, []],
    ["missing-after-pause", { kind: "after-pause", check: check("after", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:post-work"] }), readback: readback(true, "2026-10-20T05:41:00Z") }, ["fixture:post-work"]],
  ];
  for (const [name, event, extraRefs] of paths) {
    let unknown = advanceContextPatrol(pending, event);
    assert.equal(unknown.terminal, null, name); assert.equal(unknown.state, "unknown", name); assert.equal(unknown.pendingAction, "query-instance", name);
    assert.equal(unknown.pendingMutation.requestNotBefore, "2026-10-20T05:20:01Z", name);
    assert.equal(unknown.pendingMutation.priorReturnedAt, null, name); assert.equal(unknown.pendingMutation.observation, null, name);
    assert.equal(unknown.automationId, pending.automationId, name); assert.equal(unknown.lastError, pending.lastError, name);
    assert.deepEqual(unknown.lastReadback, pending.lastReadback, name); assert.deepEqual(unknown.receivedWorkRefs, ["fixture:original-work", ...extraRefs], name);
    unknown = advanceContextPatrol(unknown, { kind: "new-work", workRefs: ["fixture:new-work"] });
    unknown = advanceContextPatrol(unknown, { kind: "check", check: check("ordinary-later", "2026-10-20T06:00:00Z", { receivedWorkRefs: ["fixture:check-work"] }) });
    const saved = structuredClone(unknown);
    assert.throws(() => observeAction(unknown, "pause", "2026-10-20T05:10:00Z"), /causal boundary/u, name);
    assert.throws(() => observeAction(unknown, "resume", "2026-10-20T05:30:00Z"), /pending same-instance mutation/u, name);
    assert.throws(() => advanceContextPatrol(unknown, { kind: "action-observed", action: "pause", automationId: "fixture:wrong-id", returnedAt: "2026-10-20T05:30:00Z", evidenceRef: "fixture:wrong-instance" }), /pending same-instance mutation/u, name);
    const oldEnabled = advanceContextPatrol(unknown, { kind: "readback", readback: readback(true, "2026-10-20T05:15:00Z") });
    assert.deepEqual(oldEnabled, unknown, name); assert.deepEqual(unknown, saved, name);
    const observed = observeAction(unknown, "pause", "2026-10-20T05:30:00Z");
    const linked = advanceContextPatrol(observed, { kind: "action-failed", action: "pause", error: pending.lastError, actionEvidenceRef: observed.pendingMutation.observation.evidenceRef });
    assert.deepEqual(linked.pendingMutation, observed.pendingMutation, name);
    assert.throws(() => advanceContextPatrol(linked, { kind: "action-failed", action: "pause", error: "fixture:wrong-source", actionEvidenceRef: "fixture:other" }), /bind the actual/u, name);
    assert.equal(advanceContextPatrol(linked, { kind: "readback", readback: readback(true, "2026-10-20T05:31:00Z") }).state, "active", name);
  }
});

test("RJ02 L08/L09/L11/L12 every resume creation entry includes all known triggering prerequisites", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const observed = observeAction(pending, "pause", "2026-10-20T05:30:00Z");
  const paused = advanceContextPatrol(observed, { kind: "after-pause", check: check("paused", "2026-10-20T05:31:00Z"), readback: readback(false, "2026-10-20T05:31:00Z") });
  const failed = failedAction(pending, "pause", "2026-10-20T05:30:00Z", "fixture:pause-unknown");
  const received = advanceContextPatrol(failed, { kind: "new-work", workRefs: ["fixture:received"] });
  const override = { mode: "keep-enabled", evidenceRef: "fixture:override" };
  const cases = [
    ["pending-pause nonterminal check", observed, { kind: "check", check: check("work", "2026-10-20T05:40:00Z", { terminalKind: null }) }, "2026-10-20T05:40:00Z", "2026-10-20T05:00:00Z"],
    ["pending-pause nonterminal before-pause", observed, { kind: "before-pause", check: check("work", "2026-10-20T05:40:00Z", { terminalKind: null }) }, "2026-10-20T05:40:00Z", "2026-10-20T05:00:00Z"],
    ["pending-pause received-work check", observed, { kind: "check", check: check("work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:check-work"] }) }, "2026-10-20T05:40:00Z", "2026-10-20T05:00:00Z"],
    ["pending-pause received-work before-pause", observed, { kind: "before-pause", check: check("work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:check-work"] }) }, "2026-10-20T05:40:00Z", "2026-10-20T05:00:00Z"],
    ["paused nonterminal check", paused, { kind: "check", check: check("work", "2026-10-20T05:40:00Z", { terminalKind: null }) }, "2026-10-20T05:40:00Z", "2026-10-20T05:31:00Z"],
    ["paused nonterminal before-pause", paused, { kind: "before-pause", check: check("work", "2026-10-20T05:40:00Z", { terminalKind: null }) }, "2026-10-20T05:40:00Z", "2026-10-20T05:31:00Z"],
    ["paused keep-enabled check", { ...paused, ownerOverride: override }, { kind: "check", check: check("kept", "2026-10-20T05:40:00Z") }, "2026-10-20T05:40:00Z", "2026-10-20T05:31:00Z"],
    ["paused keep-enabled before-pause", { ...paused, ownerOverride: override }, { kind: "before-pause", check: check("kept", "2026-10-20T05:40:00Z") }, "2026-10-20T05:40:00Z", "2026-10-20T05:31:00Z"],
    ["after-pause work check", observed, { kind: "after-pause", check: check("work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:post-work"] }), readback: readback(false, "2026-10-20T05:31:00Z") }, "2026-10-20T05:40:00Z", "2026-10-20T05:31:00Z"],
    ["after-pause keep-enabled", { ...observed, ownerOverride: override }, { kind: "after-pause", check: check("kept", "2026-10-20T05:40:00Z"), readback: readback(false, "2026-10-20T05:31:00Z") }, "2026-10-20T05:40:00Z", "2026-10-20T05:31:00Z"],
    ["after-pause newer readback", observed, { kind: "after-pause", check: check("older-task", "2026-10-20T05:29:00Z"), readback: readback(false, "2026-10-20T05:41:00Z") }, "2026-10-20T05:41:00Z", "2026-10-20T05:41:00Z"],
    ["readback received work", received, { kind: "readback", readback: readback(false, "2026-10-20T05:40:00Z") }, "2026-10-20T05:40:00Z", "2026-10-20T05:40:00Z"],
    ["readback keep-enabled", { ...failed, ownerOverride: override }, { kind: "readback", readback: readback(false, "2026-10-20T05:40:00Z") }, "2026-10-20T05:40:00Z", "2026-10-20T05:40:00Z"],
  ];
  for (const [name, input, event, prerequisite, readAt] of cases) {
    const resume = advanceContextPatrol(input, event);
    assert.equal(resume.state, "pending-resume", name); assert.equal(resume.pendingMutation.action, "resume", name);
    assert.equal(resume.pendingMutation.requestNotBefore, prerequisite, name); assert.equal(resume.pendingMutation.observation, null, name);
    assert.equal(resume.lastReadback.observedAt, readAt, name); assert.equal(resume.automationId, pending.automationId, name);
    const saved = structuredClone(resume);
    assert.throws(() => observeAction(resume, "resume", "2026-10-20T05:35:00Z"), /causal boundary/u, name);
    if (readAt > "2026-10-20T05:36:00Z") assert.throws(() => advanceContextPatrol(resume, { kind: "readback", readback: readback(true, "2026-10-20T05:36:00Z") }), /stale schedule readback/u, name);
    else assert.equal(advanceContextPatrol(resume, { kind: "readback", readback: readback(true, "2026-10-20T05:36:00Z") }).state, "unknown", name);
    assert.deepEqual(resume, saved, name);
    for (const kind of ["readback", "after-pause"]) {
      const eventFor = (enabled, at) => ({ kind, readback: readback(enabled, at), ...(kind === "after-pause" ? { check: check("resume-read", at) } : {}) });
      const missing = advanceContextPatrol(resume, eventFor(true, "2026-10-20T06:00:00Z"));
      assert.equal(missing.state, "unknown", name); assert.equal(missing.pendingAction, "query-instance", name);
      assert.deepEqual(missing.pendingMutation, resume.pendingMutation, name); assert.equal(missing.lastError, resume.lastError, name); assert.deepEqual(missing.receivedWorkRefs, resume.receivedWorkRefs, name);
      const actual = observeAction(resume, "resume", "2026-10-20T06:01:00Z");
      const disabled = advanceContextPatrol(actual, eventFor(false, "2026-10-20T06:02:00Z"));
      assert.equal(disabled.state, "pending-resume", name); assert.deepEqual(disabled.pendingMutation, actual.pendingMutation, name);
      assert.equal(disabled.lastError, resume.lastError, name); assert.deepEqual(disabled.receivedWorkRefs, resume.receivedWorkRefs, name);
      const enabled = advanceContextPatrol(disabled, eventFor(true, "2026-10-20T06:03:00Z"));
      assert.equal(enabled.state, "active", name); assert.equal(enabled.pendingAction, null, name); assert.equal(enabled.pendingMutation, null, name);
      assert.equal(enabled.lastError, null, name); assert.deepEqual(enabled.receivedWorkRefs, [], name);
    }
  }
});

test("RJ02 L10 untimed new work preserves known pause dependencies without inventing a receipt time", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const observed = observeAction(pending, "pause", "2026-10-20T05:30:00Z");
  const disabled = advanceContextPatrol(observed, { kind: "readback", readback: readback(false, "2026-10-20T05:31:00Z") });
  const paused = advanceContextPatrol(observed, { kind: "after-pause", check: check("paused", "2026-10-20T05:31:00Z"), readback: readback(false, "2026-10-20T05:31:00Z") });
  for (const [name, input, prerequisite, prior] of [
    ["unobserved pause", pending, "2026-10-20T05:20:01Z", null],
    ["observed pause", observed, "2026-10-20T05:30:00Z", "2026-10-20T05:30:00Z"],
    ["disabled pending pause", disabled, "2026-10-20T05:31:00Z", "2026-10-20T05:30:00Z"],
    ["confirmed paused", paused, "2026-10-20T05:31:00Z", null],
  ]) {
    const resume = advanceContextPatrol(input, { kind: "new-work", workRefs: ["fixture:new-work"] });
    assert.equal(resume.state, "pending-resume", name); assert.equal(resume.terminal, null, name);
    assert.equal(resume.pendingMutation.requestNotBefore, prerequisite, name); assert.equal(resume.pendingMutation.priorReturnedAt, prior, name); assert.equal(resume.pendingMutation.observation, null, name);
    assert.throws(() => observeAction(resume, "resume", "2026-10-20T05:10:00Z"), /causal boundary/u, name);
    assert.equal(advanceContextPatrol(resume, { kind: "readback", readback: readback(true, "2026-10-20T06:00:00Z") }).state, "unknown", name);
  }
});

test("RJ02 L13 existing requests keep their boundary and observation across later ordinary events", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const observed = observeAction(pending, "pause", "2026-10-20T05:30:00Z");
  const disabled = advanceContextPatrol(observed, { kind: "readback", readback: readback(false, "2026-10-20T05:31:00Z") });
  assert.deepEqual(observeAction(disabled, "pause", "2026-10-20T05:30:00Z"), disabled);
  const resume = advanceContextPatrol(observed, { kind: "check", check: check("work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:work"] }) });
  const actual = failedAction(resume, "resume", "2026-10-20T05:41:00Z", "fixture:resume-unknown");
  let next = { ...actual, ownerOverride: { mode: "keep-enabled", evidenceRef: "fixture:override" } };
  for (const kind of ["check", "before-pause"]) next = advanceContextPatrol(next, { kind, check: check("later", "2026-10-20T05:55:00Z", { receivedWorkRefs: ["fixture:later-check"] }) });
  next = advanceContextPatrol(next, { kind: "new-work", workRefs: ["fixture:later-work"] });
  next = advanceContextPatrol(next, { kind: "readback", readback: readback(false, "2026-10-20T05:50:00Z") });
  next = advanceContextPatrol(next, { kind: "after-pause", check: check("later", "2026-10-20T05:59:00Z"), readback: readback(false, "2026-10-20T05:51:00Z") });
  assert.deepEqual(next.pendingMutation, actual.pendingMutation); assert.equal(next.lastError, actual.lastError);
  assert.deepEqual(next.receivedWorkRefs, ["fixture:work", "fixture:later-check", "fixture:later-work"]);
  assert.deepEqual(observeAction(next, "resume", "2026-10-20T05:41:00Z"), next);
});

test("RJ02 L09/L10 deferred resume uses earlier known observations without moving the existing pause request", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const failed = advanceContextPatrol(pending, { kind: "action-failed", action: "pause", error: "fixture:missing-pause-source" });
  for (const [input, event] of [
    [failed, { kind: "check", check: check("later-work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:work"] }) }],
    [failed, { kind: "before-pause", check: check("later-work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:work"] }) }],
    [failed, { kind: "readback", readback: readback(false, "2026-10-20T05:40:00Z") }],
    [{ ...pending, lastError: failed.lastError }, { kind: "after-pause", check: check("later-work", "2026-10-20T05:40:00Z", { receivedWorkRefs: ["fixture:work"] }), readback: readback(false, "2026-10-20T05:39:00Z") }],
  ]) {
    const unknown = advanceContextPatrol(input, event);
    assert.equal(unknown.knownObservationAt, "2026-10-20T05:40:00Z");
    assert.equal(unknown.pendingMutation.requestNotBefore, "2026-10-20T05:20:01Z");
    const received = advanceContextPatrol(unknown, { kind: "new-work", workRefs: ["fixture:work"] });
    const actual = observeAction(received, "pause", "2026-10-20T05:30:00Z");
    const resume = advanceContextPatrol(actual, { kind: "readback", readback: readback(false, "2026-10-20T05:31:00Z") });
    assert.equal(resume.pendingMutation.requestNotBefore, "2026-10-20T05:40:00Z");
    assert.equal(resume.pendingMutation.observation, null); assert.equal(resume.lastError, failed.lastError);
    assert.throws(() => observeAction(resume, "resume", "2026-10-20T05:35:00Z"), /causal boundary/u);
    assert.equal(advanceContextPatrol(resume, { kind: "readback", readback: readback(true, "2026-10-20T05:36:00Z") }).state, "unknown");
  }
  const laterCheck = advanceContextPatrol(pending, { kind: "check", check: check("later-terminal", "2026-10-20T05:40:00Z") });
  assert.equal(laterCheck.pendingMutation.requestNotBefore, "2026-10-20T05:20:01Z");
  assert.equal(observeAction(laterCheck, "pause", "2026-10-20T05:30:00Z").pendingMutation.observation.returnedAt, "2026-10-20T05:30:00Z");
  const resume = advanceContextPatrol(laterCheck, { kind: "new-work", workRefs: ["fixture:later-work"] });
  assert.equal(resume.pendingMutation.requestNotBefore, "2026-10-20T05:40:00Z");
  assert.throws(() => observeAction(resume, "resume", "2026-10-20T05:35:00Z"), /causal boundary/u);
});

test("RJ02 L14/L15 missing legacy prerequisite stays unknown and unlinked failures retain both distinct floors", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  const observed = observeAction(pending, "pause", "2026-10-20T05:30:00Z");
  const legacy = structuredClone(observed); delete legacy.pendingMutation.requestNotBefore;
  const unknown = advanceContextPatrol(legacy, { kind: "readback", readback: readback(true, "2026-10-20T06:00:00Z") });
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.pendingMutation.requestNotBefore, undefined);
  assert.equal(advanceContextPatrol(unknown, { kind: "readback", readback: readback(true, "2026-10-20T06:01:00Z") }).state, "unknown");
  assert.throws(() => observeAction(unknown, "pause", "2026-10-20T06:02:00Z"), /known causal boundary/u);
  const failed = advanceContextPatrol(observed, { kind: "action-failed", action: "pause", error: "fixture:unlinked" });
  assert.equal(failed.pendingMutation.requestNotBefore, "2026-10-20T05:30:00Z");
  assert.equal(failed.pendingMutation.priorReturnedAt, "2026-10-20T05:30:00Z"); assert.equal(failed.pendingMutation.observation, null);
  for (const at of ["2026-10-20T05:10:00Z", "2026-10-20T05:25:00Z", "2026-10-20T05:30:00Z"]) assert.throws(() => observeAction(failed, "pause", at), /causal boundary/u);
});

test("J12 eligibility loss cannot establish an observed disabled daily task", () => {
  const initial = initialDailyConfigBackupState({ automationId: "fixture:backup-id", groupRef: "fixture:group", selectionDigest: "a".repeat(64) });
  const scheduler = { deduplicationVerified: true, readbackAvailable: true, actualEnablementAuthorizationRef: "fixture:enable" };
  const read = { automationId: initial.automationId, groupRef: initial.groupRef, selectionDigest: initial.selectionDigest, timezone: "Asia/Shanghai", dailyLocalTime: "00:00", isEnabled: true, observedAt: atForBackup(), evidenceRef: "fixture:backup-read" };
  const enabled = readbackDailyConfigBackup(evaluateDailyConfigBackup(initial, backupGate(), scheduler).state, read, backupGate());
  const denied = { ...backupGate(), approval: null };
  const unauthorized = readbackDailyConfigBackup(initial, read, denied);
  assert.equal(unauthorized.state, "unknown");
  assert.equal(evaluateDailyConfigBackup(evaluateDailyConfigBackup(unauthorized, denied, scheduler).state, denied, scheduler).state.state, "unknown");
  const once = evaluateDailyConfigBackup(enabled, denied, scheduler);
  const twice = evaluateDailyConfigBackup(once.state, denied, scheduler);
  assert.equal(once.state.state, "unknown"); assert.equal(twice.state.state, "unknown"); assert.equal(twice.next, "query-disable-and-readback");
  assert.equal(readbackDailyConfigBackup(twice.state, { ...read, isEnabled: false }, denied).state, "disabled");
});
