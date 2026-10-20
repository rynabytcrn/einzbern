// SPDX-License-Identifier: Apache-2.0
import { normalizeNativeToolEvidence } from "./native-tool-evidence.js";
import { dotDigest, dotInstant, dotSha, dotText } from "./dot-execution.js";
export const CONTEXT_PATROL_INTERVAL_MINUTES = 20;
export interface ScheduleScope { readonly purpose: string; readonly libraryScope: readonly string[]; readonly projectScope: readonly string[]; readonly environmentRef: string }
export interface ScheduleReadback { readonly automationId: string; readonly scopeDigest: string; readonly intervalMinutes: number; readonly timezone: string; readonly isEnabled: boolean; readonly observedAt: string; readonly evidenceRef: string }
export interface PatrolCheck {
  readonly checkId: string; readonly observedAt: string; readonly outcome: "success" | "failed" | "unknown";
  readonly nativeAttempts: readonly unknown[];
  readonly visibleTaskRevisions: readonly string[]; readonly activeAttemptRefs: readonly string[]; readonly receivedWorkRefs: readonly string[];
  readonly terminalKind: "completed" | "blocked_terminal" | null; readonly terminalFingerprint: string | null;
  readonly allActionablePathsBlocked: boolean; readonly blockersExplained: boolean; readonly independentWorkAvailable: boolean;
  readonly evidenceRef: string;
}
type PatrolMutation = {
  readonly action: "pause" | "resume";
  /** Known request prerequisites only, never an actual return or completion observation. */
  readonly requestNotBefore: string | null;
  /** Prior actual boundary is a lower bound only, never proof of this mutation. */
  readonly priorReturnedAt: string | null;
  /** Actual update return/error observation, never the earlier task check or assembly clock. */
  readonly observation: { readonly automationId: string; readonly returnedAt: string; readonly evidenceRef: string } | null;
};
export interface ContextPatrolState {
  readonly schemaVersion: "tcrn.context-patrol-state.v1";
  readonly scope: ScheduleScope; readonly automationId: string | null; readonly lastReadback: ScheduleReadback | null;
  /** Latest supplied observation for future requests, never a replacement for current action evidence. */
  readonly knownObservationAt: string | null;
  readonly state: "unknown" | "active" | "pause-candidate" | "pending-pause" | "paused" | "pending-resume";
  readonly terminal: { readonly kind: "completed" | "blocked_terminal"; readonly fingerprint: string; readonly count: number; readonly firstAt: string; readonly lastAt: string; readonly checkIds: readonly string[]; readonly visibleTaskRevisions: readonly string[] } | null;
  readonly receivedWorkRefs: readonly string[];
  readonly pendingAction: "query-instance" | "read-before-pause" | "disable-same-instance" | "read-after-pause" | "enable-same-instance" | null;
  readonly pendingMutation: PatrolMutation | null;
  readonly lastError: string | null;
  readonly ownerOverride: { readonly mode: "keep-enabled"; readonly evidenceRef: string } | null;
}
export type PatrolEvent = { readonly kind: "check" | "before-pause"; readonly check: PatrolCheck }
  | { readonly kind: "after-pause"; readonly check: PatrolCheck; readonly readback: ScheduleReadback }
  | { readonly kind: "readback"; readonly readback: ScheduleReadback }
  | { readonly kind: "new-work"; readonly workRefs: readonly string[] }
  | { readonly kind: "action-observed"; readonly action: "pause" | "resume"; readonly automationId: string; readonly returnedAt: string; readonly evidenceRef: string }
  | { readonly kind: "action-failed"; readonly action: "pause" | "resume"; readonly error: string; readonly actionEvidenceRef?: string };
export function scheduleScopeDigest(scope: ScheduleScope): string { return dotDigest({ ...scope, libraryScope: [...new Set(scope.libraryScope)].sort(), projectScope: [...new Set(scope.projectScope)].sort() }); }
/** No name matching, create operation or scheduler SDK. Unknown creation must be queried first. */
export function resolveScheduleInstance(scope: ScheduleScope, savedId: string | null, observations: readonly ScheduleReadback[], createOutcome: "not-attempted" | "unknown" = "not-attempted"): { readonly status: "reuse" | "query-required" | "create-eligible" | "conflict"; readonly automationId: string | null; readonly reason?: "same-instance-observation-conflict" } {
  const groups = new Map<string, { item: ScheduleReadback; at: number; conflicts: readonly ScheduleReadback[] }>();
  for (const item of observations) {
    dotText(item.automationId, "automationId"); dotSha(item.scopeDigest, "scopeDigest"); dotText(item.timezone, "timezone"); dotText(item.evidenceRef, "evidenceRef");
    const at = dotInstant(item.observedAt, "observedAt");
    if (!Number.isSafeInteger(item.intervalMinutes) || item.intervalMinutes <= 0 || typeof item.isEnabled !== "boolean") throw new Error("schedule observation requires an explicit interval and enabled state");
    const previous = groups.get(item.automationId);
    if (!previous || at > previous.at) groups.set(item.automationId, { item, at, conflicts: [] });
    else if (at === previous.at && (item.scopeDigest !== previous.item.scopeDigest || item.intervalMinutes !== previous.item.intervalMinutes || item.timezone !== previous.item.timezone || item.isEnabled !== previous.item.isEnabled)) groups.set(item.automationId, { ...previous, conflicts: [...previous.conflicts, item] });
  }
  const digest = scheduleScopeDigest(scope);
  // Conflicting observations of one instance require another read, not a claim
  // that two instances exist. A strictly newer valid observation supersedes them.
  const ambiguous = [...groups.values()].find(group => group.conflicts.length > 0 && (group.item.automationId === savedId || [group.item, ...group.conflicts].some(item => item.scopeDigest === digest)));
  if (ambiguous) return { status: "query-required", automationId: savedId ?? ambiguous.item.automationId, reason: "same-instance-observation-conflict" };
  const matches = [...groups.values()].map(group => group.item).filter(item => item.scopeDigest === digest);
  if (savedId !== null) {
    const item = matches.find(candidate => candidate.automationId === savedId);
    return { status: item === undefined ? "query-required" : matches.some(candidate => candidate.automationId !== savedId) ? "conflict" : "reuse", automationId: savedId };
  }
  if (matches.length > 1) return { status: "conflict", automationId: null };
  if (matches[0]) return { status: "reuse", automationId: matches[0].automationId };
  return { status: createOutcome === "unknown" ? "query-required" : "create-eligible", automationId: null };
}
export function initialContextPatrolState(scope: ScheduleScope, automationId: string | null, ownerOverride: ContextPatrolState["ownerOverride"] = null): ContextPatrolState {
  if (automationId !== null) dotText(automationId, "automationId");
  if (ownerOverride !== null) dotText(ownerOverride.evidenceRef, "ownerOverride.evidenceRef");
  return { schemaVersion: "tcrn.context-patrol-state.v1", scope, automationId, lastReadback: null, knownObservationAt: null, state: "unknown", terminal: null, receivedWorkRefs: [], pendingAction: "query-instance", pendingMutation: null, lastError: null, ownerOverride };
}
function terminalCheck(check: PatrolCheck): boolean {
  dotText(check.checkId, "checkId"); dotInstant(check.observedAt, "check.observedAt"); dotText(check.evidenceRef, "check.evidenceRef");
  return check.outcome === "success" && check.terminalFingerprint !== null && check.terminalFingerprint.trim().length > 0 && check.activeAttemptRefs.length === 0 && Array.isArray(check.nativeAttempts) && check.nativeAttempts.every(attempt => normalizeNativeToolEvidence(attempt).executionResponsibility === "terminal-confirmed") && check.receivedWorkRefs.length === 0 && !check.independentWorkAvailable
    && (check.terminalKind === "completed" || check.terminalKind === "blocked_terminal" && check.allActionablePathsBlocked && check.blockersExplained);
}
function validateReadback(state: ContextPatrolState, readback: ScheduleReadback): void {
  dotText(readback.automationId, "automationId"); dotInstant(readback.observedAt, "readback.observedAt"); dotText(readback.evidenceRef, "readback.evidenceRef");
  if (state.automationId !== null && state.automationId !== readback.automationId || readback.scopeDigest !== scheduleScopeDigest(state.scope) || readback.intervalMinutes !== CONTEXT_PATROL_INTERVAL_MINUTES || typeof readback.isEnabled !== "boolean") throw new Error("patrol readback differs from the original instance, scope or 20 minute interval");
  if (state.lastReadback && dotInstant(readback.observedAt, "observedAt") < dotInstant(state.lastReadback.observedAt, "previous observedAt")) throw new Error("stale schedule readback cannot overwrite current observation");
}
function latestPatrolPrerequisite(...times: readonly (string | null | undefined)[]): string | null {
  return times.reduce<string | null>((latest, at) => at == null ? latest : latest === null || dotInstant(at, "request prerequisite") > dotInstant(latest, "previous request prerequisite") ? at : latest, null);
}
/** Sequential guidance only. The caller performs each actual action and supplies real readbacks. */
export function advanceContextPatrol(state: ContextPatrolState, event: PatrolEvent): ContextPatrolState {
  const next = advancePatrolEvent(state, event);
  // Accepted later observations constrain future requests, not an already pending
  // action. Rejected events throw above and cannot advance either boundary.
  const knownObservationAt = latestPatrolPrerequisite(state.knownObservationAt, "check" in event ? event.check.observedAt : null, "readback" in event ? event.readback.observedAt : null, event.kind === "action-observed" ? event.returnedAt : null);
  return knownObservationAt === state.knownObservationAt ? next : { ...next, knownObservationAt };
}
function advancePatrolEvent(state: ContextPatrolState, event: PatrolEvent): ContextPatrolState {
  const queryUnresolved = state.state === "unknown" && state.pendingAction === "query-instance";
  const mutation: PatrolMutation | null = state.pendingMutation ?? (state.state === "pending-pause" ? { action: "pause", requestNotBefore: null, priorReturnedAt: null, observation: null } : state.state === "pending-resume" ? { action: "resume", requestNotBefore: null, priorReturnedAt: null, observation: null } : null);
  const actionFloor = mutation?.observation?.returnedAt ?? mutation?.priorReturnedAt ?? null;
  const requestedMutation = (action: PatrolMutation["action"], ...prerequisites: readonly string[]): PatrolMutation => ({ action, requestNotBefore: latestPatrolPrerequisite(mutation?.requestNotBefore, state.knownObservationAt, state.terminal?.lastAt, state.lastReadback?.observedAt, actionFloor, ...prerequisites), priorReturnedAt: actionFloor, observation: null });
  // Only creation of a new request adds prerequisites. Later checks/readbacks of
  // the same pending resume must not retrospectively invalidate its actual source.
  const resumeMutation = (...prerequisites: readonly string[]): PatrolMutation => mutation?.action === "resume" ? mutation : requestedMutation("resume", ...prerequisites);
  const resume = (workRefs: readonly string[], error: string | null = state.lastError, ...prerequisites: readonly string[]): ContextPatrolState => ({ ...state, state: "pending-resume", terminal: null, receivedWorkRefs: [...new Set([...state.receivedWorkRefs, ...workRefs])], pendingAction: state.automationId === null ? "query-instance" : "enable-same-instance", pendingMutation: resumeMutation(...prerequisites), lastError: error });
  // Both readback consumers require a real action boundary. Missing legacy/action
  // data stays unresolved; no task-check time is promoted to an update observation.
  const actionReadbackReady = (readback: ScheduleReadback): boolean => {
    validateReadback(state, readback);
    const observation = mutation?.observation;
    if (mutation !== null || state.pendingMutation === undefined && queryUnresolved && state.lastError !== null) {
      if (!observation || mutation?.requestNotBefore == null) return false;
      if (observation.automationId !== readback.automationId || dotInstant(readback.observedAt, "readback.observedAt") <= dotInstant(observation.returnedAt, "action returnedAt")) throw new Error("scheduler readback must follow the actual same-instance action observation");
    }
    if (queryUnresolved && state.lastReadback !== null && dotInstant(readback.observedAt, "readback.observedAt") <= dotInstant(state.lastReadback.observedAt, "previous observedAt")) throw new Error("an unresolved scheduler action requires a new same-instance readback");
    return true;
  };
  const missingAction = (workRefs: readonly string[] = []): ContextPatrolState => ({ ...state, state: "unknown", terminal: null, pendingAction: "query-instance", ...(mutation === null ? {} : { pendingMutation: mutation }), receivedWorkRefs: [...new Set([...state.receivedWorkRefs, ...workRefs])] });
  if (event.kind === "action-observed") {
    dotText(event.automationId, "action automationId"); dotText(event.evidenceRef, "action evidenceRef");
    const at = dotInstant(event.returnedAt, "action returnedAt");
    if (mutation === null || mutation.action !== event.action || state.automationId === null || event.automationId !== state.automationId) throw new Error("action observation must match the pending same-instance mutation");
    if (mutation.requestNotBefore == null) throw new Error("action observation requires the pending request's known causal boundary");
    if (at < dotInstant(mutation.requestNotBefore, "request not before") || actionFloor !== null && (mutation.observation === null ? at <= dotInstant(actionFloor, "previous action observation") : at < dotInstant(actionFloor, "previous action observation"))) throw new Error("action observation predates or reuses an unresolved prior causal boundary");
    return { ...state, pendingMutation: { ...mutation, observation: { automationId: event.automationId, returnedAt: event.returnedAt, evidenceRef: event.evidenceRef } } };
  }
  if (event.kind === "new-work") {
    if (event.workRefs.length === 0) throw new Error("new work needs actual references");
    if (queryUnresolved) return { ...state, terminal: null, receivedWorkRefs: [...new Set([...state.receivedWorkRefs, ...event.workRefs])] };
    return state.state === "active" && state.lastReadback?.isEnabled === true ? { ...state, terminal: null, receivedWorkRefs: [...new Set([...state.receivedWorkRefs, ...event.workRefs])], pendingAction: null } : resume(event.workRefs);
  }
  if (event.kind === "action-failed") {
    dotText(event.error, "action error");
    if (event.actionEvidenceRef !== undefined) {
      dotText(event.actionEvidenceRef, "actionEvidenceRef");
      if (mutation === null || mutation.action !== event.action || mutation.observation?.evidenceRef !== event.actionEvidenceRef) throw new Error("failure must bind the actual pending action observation");
    }
    // An unlinked failure may belong to a later actual attempt. Never reuse the
    // earlier attempt's boundary merely because pause/resume has the same name.
    const pendingMutation: PatrolMutation = event.actionEvidenceRef === undefined ? requestedMutation(event.action) : { action: event.action, requestNotBefore: mutation?.requestNotBefore ?? null, priorReturnedAt: mutation?.priorReturnedAt ?? null, observation: mutation?.observation ?? null };
    return event.action === "resume" ? { ...resume([], event.error), pendingMutation } : { ...state, state: "unknown", terminal: null, pendingAction: "query-instance", pendingMutation, lastError: event.error };
  }
  if (event.kind === "readback") {
    if (!actionReadbackReady(event.readback)) return missingAction();
    const next = { ...state, automationId: event.readback.automationId, lastReadback: event.readback, lastError: null };
    if (state.state === "pending-pause") return { ...next, pendingAction: "read-after-pause" };
    if ((mutation?.action === "resume" || state.ownerOverride !== null || state.receivedWorkRefs.length > 0) && !event.readback.isEnabled) return { ...next, state: "pending-resume", pendingAction: "enable-same-instance", pendingMutation: resumeMutation(event.readback.observedAt), lastError: state.lastError };
    return { ...next, state: event.readback.isEnabled ? "active" : "paused", terminal: null, receivedWorkRefs: event.readback.isEnabled ? [] : state.receivedWorkRefs, pendingAction: null, pendingMutation: null };
  }
  const check = event.check;
  const validTerminal = terminalCheck(check);
  if (event.kind === "after-pause") {
    if (state.state !== "pending-pause" && state.state !== "pending-resume") throw new Error("post-pause read requires an actual pending same-instance pause/resume");
    if (!actionReadbackReady(event.readback)) return missingAction(check.receivedWorkRefs);
    if (state.state === "pending-resume") return event.readback.isEnabled
      ? { ...state, automationId: event.readback.automationId, lastReadback: event.readback, state: "active", terminal: null, receivedWorkRefs: [], pendingAction: null, pendingMutation: null, lastError: null }
      : { ...resume(check.receivedWorkRefs, state.lastError, check.observedAt, event.readback.observedAt), automationId: event.readback.automationId, lastReadback: event.readback };
    const unchanged = validTerminal && dotInstant(check.observedAt, "post-pause task read") >= dotInstant(event.readback.observedAt, "post-pause schedule read") && state.terminal !== null && check.terminalKind === state.terminal.kind && check.terminalFingerprint === state.terminal.fingerprint && dotDigest(check.visibleTaskRevisions) === dotDigest(state.terminal.visibleTaskRevisions);
    if (!unchanged || state.ownerOverride !== null || state.receivedWorkRefs.length > 0) return { ...resume(check.receivedWorkRefs, state.lastError, check.observedAt, event.readback.observedAt), automationId: event.readback.automationId, lastReadback: event.readback };
    if (event.readback.isEnabled) return { ...state, lastReadback: event.readback, state: "active", terminal: null, pendingAction: null, pendingMutation: null, lastError: null };
    return { ...state, lastReadback: event.readback, state: "paused", pendingAction: null, pendingMutation: null, lastError: null };
  }
  // Task observations cannot settle an outstanding scheduler action. Only the
  // matching scheduler readback/post-pause path above can discharge it.
  if (queryUnresolved || state.state === "pending-resume") return { ...state, receivedWorkRefs: [...new Set([...state.receivedWorkRefs, ...check.receivedWorkRefs])] };
  if (state.state === "pending-pause") return validTerminal && check.receivedWorkRefs.length === 0 ? state : resume(check.receivedWorkRefs, state.lastError, check.observedAt);
  if (!validTerminal) {
    if (state.state === "paused") return resume(check.receivedWorkRefs, check.outcome === "success" ? null : "task state unknown; pause not established", check.observedAt);
    return { ...state, terminal: null, state: state.lastReadback?.isEnabled ? "active" : "unknown", pendingAction: state.lastReadback?.isEnabled ? null : "query-instance", lastError: check.outcome === "success" ? null : "check failed or unknown" };
  }
  if (state.ownerOverride !== null) return state.lastReadback?.isEnabled ? { ...state, state: "active", terminal: null, pendingAction: null } : resume([], state.lastError, check.observedAt);
  if (state.automationId === null || state.lastReadback === null) return { ...state, terminal: null, pendingAction: "query-instance" };
  const old = state.terminal;
  const same = old !== null && old.kind === check.terminalKind && old.fingerprint === check.terminalFingerprint && dotDigest(old.visibleTaskRevisions) === dotDigest(check.visibleTaskRevisions);
  if (event.kind === "before-pause") {
    if (!same || old.count < 2 || state.pendingAction !== "read-before-pause" || dotInstant(check.observedAt, "before pause") < dotInstant(old.lastAt, "last check")) return { ...state, terminal: null, state: "active", pendingAction: null };
    return { ...state, terminal: { ...old, lastAt: check.observedAt }, state: "pending-pause", pendingAction: "disable-same-instance", pendingMutation: requestedMutation("pause", check.observedAt) };
  }
  if (same && old.checkIds.includes(check.checkId)) return state;
  if (same && dotInstant(check.observedAt, "check at") < dotInstant(old.lastAt, "last at")) return { ...state, terminal: null, state: "active", pendingAction: null, lastError: "out-of-order check" };
  const spaced = same && dotInstant(check.observedAt, "check at") - dotInstant(old.lastAt, "last at") >= BigInt(CONTEXT_PATROL_INTERVAL_MINUTES * 60) * 1_000_000_000n;
  const terminal: NonNullable<ContextPatrolState["terminal"]> = same ? { ...old, ...(spaced ? { count: Math.min(2, old.count + 1), lastAt: check.observedAt, checkIds: [...old.checkIds, check.checkId] } : {}) }
    : { kind: check.terminalKind!, fingerprint: check.terminalFingerprint!, count: 1, firstAt: check.observedAt, lastAt: check.observedAt, checkIds: [check.checkId], visibleTaskRevisions: check.visibleTaskRevisions };
  return { ...state, terminal, receivedWorkRefs: [], state: terminal.count >= 2 ? "pause-candidate" : "active", pendingAction: terminal.count >= 2 ? "read-before-pause" : null, lastError: null };
}

import { evaluateConfigBackupEnablement } from "./config-backup-retention.js";
import type { ConfigBackupEnablementPrerequisites } from "./config-backup-retention.js";
export const DAILY_CONFIG_BACKUP_TIMEZONE = "Asia/Shanghai" as const;
export const DAILY_CONFIG_BACKUP_LOCAL_TIME = "00:00" as const;
export interface DailyConfigBackupState {
  readonly schemaVersion: "tcrn.daily-config-backup-state.v1"; readonly automationId: string | null;
  readonly groupRef: string; readonly selectionDigest: string; readonly policyRef: string | null;
  readonly scheduleTimezone: typeof DAILY_CONFIG_BACKUP_TIMEZONE; readonly dailyLocalTime: typeof DAILY_CONFIG_BACKUP_LOCAL_TIME;
  readonly state: "disabled" | "pending-enablement" | "enabled" | "unknown";
  readonly lastScheduledAt: string | null; readonly actualCompletedAt: string | null; readonly missedScheduleAt: string | null;
  readonly backupReceiptRef: string | null; readonly lastReadbackRef: string | null; readonly lastError: string | null;
  readonly lastReadbackAt: string | null;
  /** Retained across request changes; an older action is never reused for a later request. */
  readonly lastActionAt: string | null;
  /** The current query/update responsibility, not evidence that its desired state was reached. */
  readonly pendingReadback: { readonly desiredEnabled: boolean; readonly boundary: DailyScheduleObservation | null } | null;
}
interface DailyScheduleObservation { readonly automationId: string; readonly desiredEnabled: boolean; readonly returnedAt: string; readonly evidenceRef: string }
export interface DailyBackupReadback { readonly automationId: string; readonly groupRef: string; readonly selectionDigest: string; readonly timezone: string; readonly dailyLocalTime: string; readonly isEnabled: boolean; readonly observedAt: string; readonly evidenceRef: string }
export function initialDailyConfigBackupState(input: { readonly automationId: string | null; readonly groupRef: string; readonly selectionDigest: string }): DailyConfigBackupState {
  dotText(input.groupRef, "backup group"); dotSha(input.selectionDigest, "backup selection digest");
  if (input.automationId !== null) dotText(input.automationId, "backup automation ID");
  return { schemaVersion: "tcrn.daily-config-backup-state.v1", ...input, policyRef: null, scheduleTimezone: DAILY_CONFIG_BACKUP_TIMEZONE, dailyLocalTime: DAILY_CONFIG_BACKUP_LOCAL_TIME, state: "disabled", lastScheduledAt: null, actualCompletedAt: null, missedScheduleAt: null, backupReceiptRef: null, lastReadbackRef: null, lastError: null, lastReadbackAt: null, lastActionAt: null, pendingReadback: null };
}
/** Fixed UTC+08:00 midnight; travel timezone and patrol state are deliberately not inputs. */
export function dailyConfigBackupSlot(now: string): string {
  dotInstant(now, "now");
  const shifted = new Date(Date.parse(now) + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 60 * 60 * 1000).toISOString();
}
export function evaluateDailyConfigBackup(state: DailyConfigBackupState, prerequisites: ConfigBackupEnablementPrerequisites, scheduler: { readonly deduplicationVerified: boolean; readonly readbackAvailable: boolean; readonly actualEnablementAuthorizationRef: string | null; readonly actionObservation?: DailyScheduleObservation | null }): { readonly state: DailyConfigBackupState; readonly eligible: boolean; readonly reason: string; readonly next: "keep-disabled" | "query-disable-and-readback" | "request-authorized-update-and-readback" } {
  const gate = evaluateConfigBackupEnablement(prerequisites);
  const eligible = gate.eligible && scheduler.deduplicationVerified && scheduler.readbackAvailable && scheduler.actualEnablementAuthorizationRef !== null && scheduler.actualEnablementAuthorizationRef.trim().length > 0;
  const reason = !gate.eligible ? gate.reason : !scheduler.deduplicationVerified || !scheduler.readbackAvailable ? "scheduler-unavailable" : !scheduler.actualEnablementAuthorizationRef?.trim() ? "enablement-unapproved" : "ready";
  const needsReadback = eligible || state.state !== "disabled" || state.pendingReadback != null;
  const prior = state.pendingReadback;
  const sameRequest = prior?.desiredEnabled === eligible && state.policyRef === gate.policyDigest;
  let boundary = sameRequest ? prior?.boundary ?? null : null;
  const observation = scheduler.actionObservation;
  if (observation != null) {
    dotText(observation.automationId, "daily action automationId"); dotText(observation.evidenceRef, "daily action evidenceRef");
    const at = dotInstant(observation.returnedAt, "daily action returnedAt");
    if (!needsReadback || observation.desiredEnabled !== eligible || state.automationId !== null && observation.automationId !== state.automationId) throw new Error("daily action observation must match the current same-instance request");
    const repeatedBoundary = sameRequest && prior?.boundary?.returnedAt === observation.returnedAt && prior.boundary.evidenceRef === observation.evidenceRef && prior.boundary.automationId === observation.automationId;
    if (state.lastReadbackAt != null && at < dotInstant(state.lastReadbackAt, "last daily readback") || state.lastActionAt != null && (at < dotInstant(state.lastActionAt, "previous daily action") || at === dotInstant(state.lastActionAt, "previous daily action") && !repeatedBoundary)) throw new Error("daily action observation predates or reuses the current causal boundary");
    boundary = observation;
  }
  // Neither eligibility nor an old readback time stands in for a real current
  // query/update return. Re-evaluation preserves an unresolved same request.
  return { state: { ...state, state: eligible ? "pending-enablement" : needsReadback ? "unknown" : "disabled", policyRef: gate.policyDigest, lastActionAt: observation?.returnedAt ?? state.lastActionAt ?? null, pendingReadback: needsReadback ? { desiredEnabled: eligible, boundary } : null, lastError: needsReadback && state.lastError !== null ? state.lastError : eligible ? null : reason }, eligible, reason, next: eligible ? "request-authorized-update-and-readback" : needsReadback ? "query-disable-and-readback" : "keep-disabled" };
}
export function readbackDailyConfigBackup(state: DailyConfigBackupState, readback: DailyBackupReadback, prerequisites: ConfigBackupEnablementPrerequisites): DailyConfigBackupState {
  const at = dotInstant(readback.observedAt, "backup readback at"); dotText(readback.evidenceRef, "backup readback ref"); dotText(readback.automationId, "backup automation ID");
  if (state.automationId !== null && state.automationId !== readback.automationId || readback.groupRef !== state.groupRef || readback.selectionDigest !== state.selectionDigest || readback.timezone !== DAILY_CONFIG_BACKUP_TIMEZONE || readback.dailyLocalTime !== DAILY_CONFIG_BACKUP_LOCAL_TIME) throw new Error("daily backup readback differs from original ID, group, selection or fixed schedule");
  const gate = evaluateConfigBackupEnablement(prerequisites);
  if (typeof readback.isEnabled !== "boolean") throw new Error("daily backup enablement readback must be explicit");
  if (state.lastReadbackAt != null && at <= dotInstant(state.lastReadbackAt, "last daily readback")) throw new Error("stale or replayed daily backup readback cannot overwrite the latest observation");
  const next = { ...state, automationId: readback.automationId, lastReadbackAt: readback.observedAt, lastReadbackRef: readback.evidenceRef };
  const pending = state.pendingReadback;
  if (pending != null || state.state === "unknown" || state.state === "pending-enablement") {
    if (!pending?.boundary) return { ...next, state: "unknown", lastError: state.lastError ?? "daily-query-or-update-observation-required" };
    if (pending.boundary.automationId !== readback.automationId || at <= dotInstant(pending.boundary.returnedAt, "daily action returnedAt")) throw new Error("daily backup readback must follow the actual same-instance query or update");
    if (readback.isEnabled !== pending.desiredEnabled) return { ...next, state: pending.desiredEnabled ? "pending-enablement" : "unknown", lastError: state.lastError ?? "daily-requested-state-not-observed" };
  }
  if (readback.isEnabled && (!gate.eligible || state.policyRef !== gate.policyDigest || !["pending-enablement", "enabled"].includes(state.state))) return { ...next, state: "unknown", lastError: "enabled-without-required-policy-capability-or-authorization" };
  return { ...next, state: readback.isEnabled ? "enabled" : "disabled", pendingReadback: null, lastError: null };
}
/** Delayed execution records a current snapshot only; it never manufactures midnight history. */
export function recordDailyConfigBackupCompletion(state: DailyConfigBackupState, completion: { readonly snapshotCapturedAt: string; readonly actualCompletedAt: string; readonly backupReceiptRef: string }): DailyConfigBackupState {
  if (state.state !== "enabled") throw new Error("disabled or unknown daily backup cannot claim a run");
  if (dotInstant(completion.actualCompletedAt, "actualCompletedAt") < dotInstant(completion.snapshotCapturedAt, "snapshotCapturedAt")) throw new Error("completion predates actual snapshot");
  dotText(completion.backupReceiptRef, "backupReceiptRef");
  const slot = dailyConfigBackupSlot(completion.snapshotCapturedAt);
  return { ...state, lastScheduledAt: slot, actualCompletedAt: completion.actualCompletedAt, missedScheduleAt: dotInstant(slot, "slot") === dotInstant(completion.snapshotCapturedAt, "capturedAt") ? null : slot, backupReceiptRef: completion.backupReceiptRef, lastError: null };
}
