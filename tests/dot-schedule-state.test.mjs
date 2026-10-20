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
