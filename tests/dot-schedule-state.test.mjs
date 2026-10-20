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
  const disabled = advanceContextPatrol(pending, { kind: "readback", readback: readback(false, "2026-10-20T05:20:02Z") });
  assert.equal(disabled.pendingAction, "read-after-pause");
  const resumed = advanceContextPatrol(disabled, { kind: "after-pause", check: check("after", "2026-10-20T05:20:03Z", { receivedWorkRefs: ["fixture:new"] }), readback: readback(false, "2026-10-20T05:20:03Z") });
  assert.equal(resumed.state, "pending-resume"); assert.equal(resumed.automationId, "fixture:actual-id");
  const failed = advanceContextPatrol(resumed, { kind: "action-failed", action: "resume", error: "fixture:unknown outcome" });
  assert.equal(failed.state, "pending-resume"); assert.deepEqual(failed.receivedWorkRefs, ["fixture:new"]);
  assert.equal(advanceContextPatrol(failed, { kind: "readback", readback: readback(true, "2026-10-20T05:20:04Z") }).state, "active");
});
test("DOT-S02 pause readback with unchanged terminal permits paused only after post-read", () => {
  const pending = advanceContextPatrol(candidate(), { kind: "before-pause", check: check("before", "2026-10-20T05:20:01Z") });
  assert.equal(advanceContextPatrol(pending, { kind: "after-pause", check: check("after", "2026-10-20T05:20:02Z"), readback: readback(false, "2026-10-20T05:20:02Z") }).state, "paused");
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
  assert.deepEqual(advanceContextPatrol(pendingPause, { kind: "check", check: check("late", "2026-10-20T05:40:00Z") }), pendingPause);
  const paused = advanceContextPatrol(pendingPause, { kind: "after-pause", check: check("after", "2026-10-20T05:20:02Z"), readback: readback(false, "2026-10-20T05:20:02Z") });
  const resume = advanceContextPatrol(paused, { kind: "new-work", workRefs: ["fixture:new-work"] });
  const failed = advanceContextPatrol(resume, { kind: "action-failed", action: "resume", error: "fixture:resume-unknown" });
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
  const failed = advanceContextPatrol(pending, { kind: "action-failed", action: "pause", error: "fixture:pause-outcome-unknown" });
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
    assert.throws(() => advanceContextPatrol(unresolved, { kind: "readback", readback: failed.lastReadback }), /new same-instance readback/u);
    assert.throws(() => advanceContextPatrol(unresolved, { kind: "readback", readback: { ...readback(true, "2026-10-20T05:41:00Z"), automationId: "fixture:wrong-id" } }), /original instance/u);
    const disabled = advanceContextPatrol(unresolved, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") });
    assert.equal(disabled.state, "pending-resume"); assert.equal(disabled.pendingAction, "enable-same-instance"); assert.equal(disabled.lastError, failed.lastError);
    assert.deepEqual(disabled.receivedWorkRefs, unresolved.receivedWorkRefs); assert.equal(disabled.automationId, failed.automationId);
    const enabled = advanceContextPatrol(disabled, { kind: "readback", readback: readback(true, "2026-10-20T05:42:00Z") });
    assert.equal(enabled.state, "active"); assert.equal(enabled.pendingAction, null); assert.equal(enabled.lastError, null); assert.deepEqual(enabled.receivedWorkRefs, []);
    const enabledDirectly = advanceContextPatrol(unresolved, { kind: "readback", readback: readback(true, "2026-10-20T05:41:00Z") });
    assert.equal(enabledDirectly.state, "active"); assert.equal(enabledDirectly.lastError, null);
  }
  assert.equal(advanceContextPatrol(failed, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") }).state, "paused");
  const kept = advanceContextPatrol({ ...failed, ownerOverride: { mode: "keep-enabled", evidenceRef: "fixture:owner-override" } }, { kind: "readback", readback: readback(false, "2026-10-20T05:41:00Z") });
  assert.equal(kept.state, "pending-resume");
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
