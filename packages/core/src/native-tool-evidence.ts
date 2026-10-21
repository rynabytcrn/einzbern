// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { dotDigest, dotInstant, dotObject, dotRefs, dotSha, dotText, validateRevisionBinding, validateDotExecutionRequest, resolveDotExecutionAdmission } from "./dot-execution.js";
import type { DotAdmission, RevisionBinding } from "./dot-execution.js";
import type { ProjectReference } from "../../protocol/src/index.js";

export const NATIVE_TOOL_ATTEMPT_VERSION = "tcrn.native-tool-attempt.v1" as const;
export const NATIVE_TOOL_EVIDENCE_VERSION = "tcrn.native-tool-evidence.v1" as const;
export class NativeToolEvidenceError extends Error { readonly reasonCode = "NATIVE_TOOL_EVIDENCE_INVALID"; }
export interface NativeToolAttempt {
  readonly schemaVersion: typeof NATIVE_TOOL_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly libraryId: string;
  readonly projectRef: ProjectReference;
  readonly workId: string;
  readonly revisionBinding: RevisionBinding;
  readonly admissionDigest: string;
  readonly scopeDigest: string;
  readonly toolName: string;
  readonly toolContractObservation: { readonly ref: string; readonly sha256: string };
  readonly requestedAt: string;
  readonly argumentsDigest: string;
  readonly executionStatus: "unknown";
  readonly executionFinality: "unknown";
}
export interface ProviderObservation { readonly value: string; readonly sourceRef: string; readonly jsonPointer: string }
export type NativeExecutionStatus = "accepted" | "running" | "reported-completed" | "failed" | "cancelled" | "unknown";
export interface NativeToolEvidence {
  readonly schemaVersion: typeof NATIVE_TOOL_EVIDENCE_VERSION;
  readonly evidenceType: "native-tool";
  readonly source: "native-tool-return";
  readonly attemptId: string;
  readonly libraryId: string;
  readonly projectRef: ProjectReference;
  readonly workId: string;
  readonly revisionBinding: RevisionBinding;
  readonly admissionDigest: string;
  readonly toolName: string;
  readonly observedAt: string;
  readonly executionStatus: NativeExecutionStatus;
  readonly executionFinality: "confirmed" | "unknown";
  readonly finalityEvidenceRef?: string;
  readonly resultRefs: readonly string[];
  readonly rawResponse: { readonly ref: string; readonly sha256: string; readonly sourceTool: string };
  readonly association: { readonly status: "associated" | "unverified" | "invalid"; readonly evidenceRefs: readonly string[]; readonly reason: string };
  readonly verification: { readonly status: "unverified" | "pass" | "fail"; readonly evidenceRefs: readonly string[]; readonly verifiedAt?: string; readonly verifiedBy?: string };
  readonly providerRef?: ProviderObservation;
  readonly providerEventRef?: ProviderObservation;
  readonly providerStartedAt?: ProviderObservation;
  readonly providerFinishedAt?: ProviderObservation;
}
/** Source observations accompany, rather than replace, the actual response bytes. */
export interface NativeToolResponseInput {
  readonly sourceTool: string;
  readonly rawResponseRef: string;
  readonly rawResponseValue: unknown;
  readonly observedAt: string;
  readonly executionStatus: NativeExecutionStatus;
  readonly statusPointer?: string;
  readonly statusMapping?: Readonly<Record<string, NativeExecutionStatus>>;
  readonly providerPointers?: Partial<Record<"providerRef" | "providerEventRef" | "providerStartedAt" | "providerFinishedAt", string>>;
  readonly resultRefs: readonly string[];
  readonly association: { readonly status: "associated" | "unverified" | "invalid"; readonly invocationRef: string | null; readonly responseRef: string | null; readonly argumentsDigest: string | null; readonly evidenceRefs: readonly string[]; readonly reason: string };
  readonly terminalObservation?: { readonly jsonPointer: string; readonly terminalValues: readonly string[]; readonly contractRef: string; readonly evidenceRef: string };
  readonly verification: NativeToolEvidence["verification"];
}
function fail(message: string): never { throw new NativeToolEvidenceError(message); }
function pointer(value: unknown, path: string): unknown {
  if (!path.startsWith("/")) return fail("provider pointer must be a nonempty JSON pointer");
  let item = value;
  for (const token of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(token)) return fail("malformed JSON pointer");
    const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (item === null || typeof item !== "object" || !Object.hasOwn(item, key)) return fail("provider pointer is absent in actual response");
    item = (item as Record<string, unknown>)[key];
  }
  return item;
}
export function validateDotAdmission(value: unknown): DotAdmission {
  const a = dotObject(value, "admission", ["schemaVersion", "status", "reasonCodes", "request", "requestDigest", "contextDigest", "evaluatedAt", "applicability", "checks", "concurrency", "modelObservation"]);
  const request = validateDotExecutionRequest(a.request);
  const c = dotObject(a.concurrency, "concurrency", ["deviceLimit", "projectLimit", "platformLimit", "effectiveLimit", "occupiedSlots", "availableSlots", "reservation"]);
  const recomputed = resolveDotExecutionAdmission(request, { deviceLimit: Number(c.deviceLimit), ...(c.projectLimit === null ? {} : { projectLimit: Number(c.projectLimit) }), now: String(a.evaluatedAt), contextDigest: String(a.contextDigest) });
  if (dotDigest(recomputed) !== dotDigest(value)) fail("admission receipt differs from its evaluated inputs");
  return recomputed;
}
export function validateNativeToolAttempt(value: unknown, admissionValue?: unknown): NativeToolAttempt {
  const a = dotObject(value, "attempt", ["schemaVersion", "attemptId", "libraryId", "projectRef", "workId", "revisionBinding", "admissionDigest", "scopeDigest", "toolName", "toolContractObservation", "requestedAt", "argumentsDigest", "executionStatus", "executionFinality"]);
  if (a.schemaVersion !== NATIVE_TOOL_ATTEMPT_VERSION || a.executionStatus !== "unknown" || a.executionFinality !== "unknown") fail("pending attempt must retain unknown execution and finality");
  for (const key of ["attemptId", "libraryId", "workId", "toolName"]) dotText(a[key], key);
  for (const key of ["admissionDigest", "scopeDigest", "argumentsDigest"]) dotSha(a[key], key);
  const revision = validateRevisionBinding(a.revisionBinding); if (revision.scopeDigest !== a.scopeDigest) fail("attempt scope mismatch");
  const p = dotObject(a.projectRef, "projectRef", ["libraryId", "projectId"]);
  if (p.libraryId !== a.libraryId || !/^(library|workspace):[a-f0-9]{24}$/u.test(String(a.libraryId)) || !/^project:[a-f0-9]{24}$/u.test(String(p.projectId))) fail("attempt project identity invalid");
  const contract = dotObject(a.toolContractObservation, "toolContractObservation", ["ref", "sha256"]); dotText(contract.ref, "tool contract ref"); dotSha(contract.sha256, "tool contract digest");
  dotInstant(a.requestedAt, "requestedAt");
  if (admissionValue !== undefined) {
    const admission = validateDotAdmission(admissionValue);
    if (admission.status !== "admitted" || dotDigest(admission) !== a.admissionDigest) fail("attempt requires matching admitted receipt");
    for (const key of ["libraryId", "projectRef", "workId", "revisionBinding"] as const) if (dotDigest(a[key]) !== dotDigest(admission.request[key])) fail(`attempt ${key} differs from admission`);
    if (!admission.request.requiredTools.includes(String(a.toolName))) fail("tool was not admitted");
    const age = dotInstant(a.requestedAt, "requestedAt") - dotInstant(admission.evaluatedAt, "evaluatedAt");
    if (age < 0n || age > 300_000_000_000n) fail("prepare immediately before calling the tool");
  }
  return value as NativeToolAttempt;
}
/** A local random ID is never labelled as a provider ID. This does not invoke a tool. */
export function createNativeToolAttempt(admission: DotAdmission, input: { readonly toolName: string; readonly toolContractObservation: NativeToolAttempt["toolContractObservation"]; readonly requestedAt: string; readonly argumentsValue: unknown }): NativeToolAttempt {
  const attempt: NativeToolAttempt = { schemaVersion: NATIVE_TOOL_ATTEMPT_VERSION, attemptId: `local-attempt:${randomUUID()}`, libraryId: admission.request.libraryId, projectRef: admission.request.projectRef, workId: admission.request.workId, revisionBinding: admission.request.revisionBinding, admissionDigest: dotDigest(admission), scopeDigest: admission.request.revisionBinding.scopeDigest, toolName: input.toolName, toolContractObservation: input.toolContractObservation, requestedAt: input.requestedAt, argumentsDigest: dotDigest(input.argumentsValue), executionStatus: "unknown", executionFinality: "unknown" };
  return validateNativeToolAttempt(attempt, admission);
}
export function recordNativeToolResponse(attemptValue: NativeToolAttempt, admission: DotAdmission, input: NativeToolResponseInput): NativeToolEvidence {
  const attempt = validateNativeToolAttempt(attemptValue, admission);
  dotObject(input, "response", ["sourceTool", "rawResponseRef", "rawResponseValue", "observedAt", "executionStatus", "statusPointer", "statusMapping", "providerPointers", "resultRefs", "association", "terminalObservation", "verification"]);
  if (!Object.hasOwn(input, "rawResponseValue") || input.rawResponseValue === undefined || input.rawResponseValue === null || typeof input.rawResponseValue === "object" && Object.keys(input.rawResponseValue).length === 0) fail("no actual response: retain the pending attempt, do not fabricate evidence");
  dotText(input.rawResponseRef, "rawResponseRef"); if (input.sourceTool !== attempt.toolName) fail("response tool differs from attempt");
  if (dotInstant(input.observedAt, "observedAt") < dotInstant(attempt.requestedAt, "requestedAt")) fail("response predates attempt");
  dotRefs(input.resultRefs, "resultRefs");
  const statuses: readonly NativeExecutionStatus[] = ["accepted", "running", "reported-completed", "failed", "cancelled", "unknown"];
  if (!statuses.includes(input.executionStatus)) fail("unsupported execution status");
  if (input.statusMapping !== undefined) {
    dotObject(input.statusMapping, "statusMapping", Object.keys(input.statusMapping));
    if (Object.values(input.statusMapping).some(status => !statuses.includes(status))) fail("unsupported status mapping");
  }
  if (input.executionStatus !== "unknown") {
    if (!input.statusPointer || !input.statusMapping || input.statusMapping[String(pointer(input.rawResponseValue, input.statusPointer))] !== input.executionStatus) fail("execution status needs actual raw field and explicit tool mapping");
  }
  const a = dotObject(input.association, "association", ["status", "invocationRef", "responseRef", "argumentsDigest", "evidenceRefs", "reason"]);
  if (!["associated", "unverified", "invalid"].includes(String(a.status))) fail("association status invalid");
  dotRefs(a.evidenceRefs, "association.evidenceRefs", a.status === "associated"); dotText(a.reason, "association.reason");
  if (a.status === "associated" && (typeof a.invocationRef !== "string" || !a.invocationRef.trim() || a.responseRef !== input.rawResponseRef || a.argumentsDigest !== attempt.argumentsDigest)) fail("association requires actual invocation/response linkage and matching arguments");
  const v = dotObject(input.verification, "verification", ["status", "evidenceRefs", "verifiedAt", "verifiedBy"]);
  if (!["unverified", "pass", "fail"].includes(String(v.status))) fail("verification status invalid");
  dotRefs(v.evidenceRefs, "verification.evidenceRefs", v.status !== "unverified");
  if (v.status !== "unverified") { dotInstant(v.verifiedAt, "verifiedAt"); dotText(v.verifiedBy, "verifiedBy"); }
  let executionFinality: "confirmed" | "unknown" = "unknown";
  if (input.terminalObservation !== undefined) {
    const terminal = dotObject(input.terminalObservation, "terminalObservation", ["jsonPointer", "terminalValues", "contractRef", "evidenceRef"]);
    dotText(terminal.contractRef, "terminal contract"); dotText(terminal.evidenceRef, "terminal evidence"); dotRefs(terminal.terminalValues, "terminal values", true); dotText(terminal.jsonPointer, "terminal pointer");
    if (terminal.contractRef !== attempt.toolContractObservation.ref || !["reported-completed", "failed", "cancelled"].includes(input.executionStatus) || !terminal.terminalValues.includes(String(pointer(input.rawResponseValue, terminal.jsonPointer)))) fail("terminality requires matching provider contract and actual terminal field");
    executionFinality = "confirmed";
  }
  const provider: Partial<Record<"providerRef" | "providerEventRef" | "providerStartedAt" | "providerFinishedAt", ProviderObservation>> = {};
  if (input.providerPointers !== undefined) {
    dotObject(input.providerPointers, "providerPointers", ["providerRef", "providerEventRef", "providerStartedAt", "providerFinishedAt"]);
    for (const key of ["providerRef", "providerEventRef", "providerStartedAt", "providerFinishedAt"] as const) {
      const p = input.providerPointers[key]; if (p === undefined) continue;
      const value = pointer(input.rawResponseValue, p); dotText(value, key);
      if (key === "providerRef" && value === attempt.attemptId) fail("a local attempt ID cannot be represented as a provider ID");
      if (key.endsWith("At")) dotInstant(value, key);
      provider[key] = { value, sourceRef: input.rawResponseRef, jsonPointer: p };
    }
  }
  return { schemaVersion: NATIVE_TOOL_EVIDENCE_VERSION, evidenceType: "native-tool", source: "native-tool-return", attemptId: attempt.attemptId, libraryId: attempt.libraryId, projectRef: attempt.projectRef, workId: attempt.workId, revisionBinding: attempt.revisionBinding, admissionDigest: attempt.admissionDigest, toolName: attempt.toolName, observedAt: input.observedAt, executionStatus: input.executionStatus, executionFinality, ...(input.terminalObservation ? { finalityEvidenceRef: input.terminalObservation.evidenceRef } : {}), resultRefs: input.resultRefs, rawResponse: { ref: input.rawResponseRef, sha256: dotDigest(input.rawResponseValue), sourceTool: input.sourceTool }, association: { status: input.association.status, evidenceRefs: input.association.evidenceRefs, reason: input.association.reason }, verification: input.verification, ...provider };
}
export interface NativeDispatchBinding {
  readonly schemaVersion: "tcrn.native-dispatch-preparation.v1";
  readonly context: Record<string, unknown>;
  readonly targetDispatchAdmitted: boolean;
  readonly admission: DotAdmission | null;
  readonly attempt: NativeToolAttempt | null;
  readonly retry?: { readonly previous: unknown; readonly reconciliation: NativeRetryReconciliation };
  readonly digest: string;
}
/** Reconsume the saved real target/context; an isolated pure admission is not dispatch. */
export function validateNativeDispatchBinding(value: unknown, depth = 0): NativeDispatchBinding {
  if (depth > 16) fail("retry ancestry exceeds the bounded evidence limit");
  const p = dotObject(value, "native preparation", ["schemaVersion", "context", "targetDispatchAdmitted", "admission", "attempt", "retry", "digest"]);
  const { digest, ...payload } = p;
  if (p.schemaVersion !== "tcrn.native-dispatch-preparation.v1" || dotDigest(payload) !== digest || p.targetDispatchAdmitted !== true) fail("native preparation must be admitted and intact");
  const admission = validateDotAdmission(p.admission); const attempt = validateNativeToolAttempt(p.attempt, admission);
  const context = p.context as Record<string, unknown>;
  const targets = (context?.involvedProjects as { state?: unknown; targets?: unknown[] } | undefined);
  const target = Array.isArray(context?.contexts) ? context.contexts.find((item: Record<string, unknown>) => dotDigest(item.reference) === dotDigest(attempt.projectRef)) as Record<string, unknown> | undefined : undefined;
  if (!target || targets?.state !== "selected" || !Array.isArray(targets.targets) || !targets.targets.some(item => dotDigest(item) === dotDigest(attempt.projectRef)) || (target.readiness as { development?: { ready?: unknown } } | undefined)?.development?.ready !== true || dotDigest(target.executionAdmission) !== dotDigest(admission) || context.workId !== attempt.workId || attempt.revisionBinding.kind !== "revision" || context.workRevision !== attempt.revisionBinding.workRevision) fail("native attempt differs from captured project context");
  const roots = Array.isArray(target.repositoryContexts) ? target.repositoryContexts.map((item: { projectPath: string }) => item.projectPath).sort() : null;
  if (!roots || !admission.request.contextRead || dotDigest(roots) !== dotDigest([...admission.request.contextRead.expected.effectiveRoots].sort())) fail("captured target roots differ from actual-session context");
  if (p.retry !== undefined) {
    const retry = dotObject(p.retry, "retry", ["previous", "reconciliation"]);
    const prior = normalizeNativeToolEvidence(retry.previous, {}, depth + 1);
    if (!prior.valid) fail("retry predecessor is invalid");
    const previous = nativeSavedAttempt(retry.previous, true);
    validateNativeRetry(previous, admission, { toolName: attempt.toolName, requestedAt: attempt.requestedAt }, retry.reconciliation as NativeRetryReconciliation, depth + 1);
    if (previous.attemptId === attempt.attemptId) fail("retry must use a new attempt ID");
  }
  return value as NativeDispatchBinding;
}
export interface NativeToolRecord { readonly preparation: NativeDispatchBinding; readonly attempt: NativeToolAttempt; readonly admission: DotAdmission; readonly response: NativeToolResponseInput; readonly evidence: NativeToolEvidence }
export interface NativeEvidenceAssessment { readonly requested: true; readonly evidenceType: "native-tool"; readonly valid: boolean; readonly complete: boolean; readonly status: "invalid" | "pending" | "unverified" | "associated"; readonly problems: readonly string[]; readonly evidence: unknown; readonly authentication: "source-association-only-not-provider-authentication"; readonly executionResponsibility: "retained" | "terminal-confirmed" }
/** Review accepts original source material, not a bare envelope or a passed flag. */
export function normalizeNativeToolEvidence(value: unknown, expected: { readonly workId?: string | null; readonly workRevision?: number | null } = {}, depth = 0): NativeEvidenceAssessment {
  const problems: string[] = []; let complete = false; let pending = false; let associated = false; let terminalConfirmed = false;
  try {
    const wrapped = value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "record");
    if (depth > 16) fail("retry ancestry exceeds the bounded evidence limit");
    const saved = wrapped ? dotObject(value, "native saved record", ["record", "normalized", "history", "appendStatus", "problems", "rejectedRecord"]) : null;
    let source = saved ? saved.record : value;
    let historyRecords: readonly NativeToolRecord[] | null = null;
    if (saved?.history !== undefined) {
      const latest = normalizeNativeToolEvidence(saved.record, expected, depth);
      if (!latest.valid) fail("saved latest record is invalid");
      const history = validateNativeToolHistory(saved.history, depth);
      historyRecords = history.records;
      if (saved.appendStatus === "conflict" || saved.rejectedRecord !== undefined) fail("unresolved conflicting native return");
      const newest = source as NativeToolRecord;
      if (newest.response !== undefined && !history.records.some(item => nativeObservationContent(item.evidence) === nativeObservationContent(newest.evidence))) fail("saved return is absent from validated history");
      if (history.records.some(item => dotDigest(item.attempt) !== dotDigest(newest.attempt))) fail("saved history belongs to another attempt");
      if (history.current !== null) source = history.records.find(item => dotDigest(item.evidence) === dotDigest(history.current));
    }
    const record = dotObject(source, "native record", ["preparation", "attempt", "admission", "response", "evidence"]);
    const preparation = validateNativeDispatchBinding(record.preparation, depth);
    const admission = validateDotAdmission(record.admission);
    const attempt = validateNativeToolAttempt(record.attempt, admission);
    if (dotDigest(preparation.attempt) !== dotDigest(attempt) || dotDigest(preparation.admission) !== dotDigest(admission)) fail("record differs from saved preparation");
    if (expected.workId != null && attempt.workId !== expected.workId) fail("review work differs from attempt");
    if (expected.workRevision != null && (attempt.revisionBinding.kind !== "revision" || attempt.revisionBinding.workRevision !== expected.workRevision)) fail("review revision differs from attempt");
    if (record.response === undefined && record.evidence === undefined) pending = true;
    else {
      const rebuilt = recordNativeToolResponse(attempt, record.admission as DotAdmission, record.response as NativeToolResponseInput);
      if (dotDigest(rebuilt) !== dotDigest(record.evidence)) fail("evidence differs from actual source observations");
      if (rebuilt.association.status === "invalid") fail("response association is invalid");
      associated = rebuilt.association.status === "associated";
      terminalConfirmed = associated && rebuilt.executionFinality === "confirmed";
      complete = terminalConfirmed && rebuilt.executionStatus === "reported-completed" && verifiedDeliveryPass(rebuilt, historyRecords?.map(item => item.evidence) ?? [rebuilt]);
    }
  } catch (error) { problems.push(String(error)); }
  return { requested: true, evidenceType: "native-tool", valid: problems.length === 0, complete, status: problems.length ? "invalid" : pending ? "pending" : associated ? "associated" : "unverified", problems, evidence: value, authentication: "source-association-only-not-provider-authentication", executionResponsibility: problems.length === 0 && terminalConfirmed ? "terminal-confirmed" : "retained" };
}
/** Storage locations and local reread times do not change provider event content. */
function nativeEventContent(e: NativeToolEvidence): string {
  const provider = Object.fromEntries(["providerRef", "providerEventRef", "providerStartedAt", "providerFinishedAt"].map(key => [key, (e[key as keyof NativeToolEvidence] as ProviderObservation | undefined)?.value ?? null]));
  return dotDigest({ attemptId: e.attemptId, toolName: e.toolName, rawSha256: e.rawResponse.sha256, executionStatus: e.executionStatus, executionFinality: e.executionFinality, association: e.association.status, ...provider });
}
/** Independent checks are observations of bound deliverables, not provider events. */
function nativeObservationContent(e: NativeToolEvidence): string {
  return dotDigest({ event: nativeEventContent(e), resultRefs: [...new Set(e.resultRefs)].sort(), verification: e.verification });
}
function verifiedDeliveryPass(current: NativeToolEvidence, records: readonly NativeToolEvidence[]): boolean {
  if (current.resultRefs.length === 0) return false;
  const delivery = dotDigest([...new Set(current.resultRefs)].sort());
  let newest: bigint | null = null; let status: "unverified" | "pass" | "fail" = "unverified";
  for (const evidence of records) {
    const verification = evidence.verification;
    if (evidence.attemptId !== current.attemptId || evidence.association.status !== "associated" || dotDigest([...new Set(evidence.resultRefs)].sort()) !== delivery || verification.status === "unverified") continue;
    const at = dotInstant(verification.verifiedAt, "verifiedAt");
    if (at < dotInstant(current.observedAt, "terminal observedAt") || at < dotInstant(evidence.observedAt, "verified source observedAt")) continue;
    if (newest === null || at > newest) { newest = at; status = verification.status; }
    else if (at === newest && verification.status === "fail") status = "fail";
  }
  return status === "pass";
}
export function nativeSavedAttempt(value: unknown, forRetry = false): NativeToolAttempt {
  const saved = dotObject(value, "saved native return", ["record", "normalized", "history", "appendStatus", "problems", "rejectedRecord"]);
  const current = (saved.history as NativeToolHistory | undefined)?.current ?? (saved.record as NativeToolRecord).evidence;
  if (forRetry && current?.association.status === "associated" && current.executionFinality === "confirmed" && current.executionStatus === "reported-completed") fail("a completed predecessor is not retryable");
  return validateNativeToolAttempt((saved.record as NativeToolRecord).attempt);
}
export function validateNativeToolHistory(value: unknown, depth = 0): NativeToolHistory {
  const raw = dotObject(value, "native history", ["records", "observations", "current"]);
  if (!Array.isArray(raw.records) || !Array.isArray(raw.observations) || raw.records.length > 256 || raw.observations.length > 1024) fail("native history exceeds bounded evidence limits");
  let rebuilt: NativeToolHistory = { records: [], observations: [], current: null };
  for (const record of raw.records) { const next = appendNativeToolRecord(rebuilt, record as NativeToolRecord, depth); if (next.status !== "appended") fail("history contains conflicting or duplicate records"); rebuilt = next.history; }
  if (dotDigest(rebuilt.current) !== dotDigest(raw.current)) fail("history current state differs from actual retained returns");
  for (const rawObservation of raw.observations) { const observation = dotObject(rawObservation, "history observation", ["key", "observedAt", "sourceRef"]); dotSha(observation.key, "event key"); dotInstant(observation.observedAt, "observedAt"); dotText(observation.sourceRef, "observation sourceRef"); if (!rebuilt.observations.some(item => item.key === observation.key)) fail("history observation has no retained event"); }
  if (rebuilt.observations.some(expected => !(raw.observations as NativeToolHistory["observations"]).some(item => item.key === expected.key && item.observedAt === expected.observedAt && item.sourceRef === expected.sourceRef))) fail("history omitted an original event observation");
  return value as NativeToolHistory;
}
export interface NativeToolHistory { readonly records: readonly NativeToolRecord[]; readonly observations: readonly { readonly key: string; readonly observedAt: string; readonly sourceRef: string }[]; readonly current: NativeToolEvidence | null }
/** No mutation of prior records; late accepted/running observations cannot regress confirmed finality. */
export function appendNativeToolRecord(history: NativeToolHistory, record: NativeToolRecord, depth = 0): { readonly status: "appended" | "duplicate" | "conflict"; readonly history: NativeToolHistory; readonly problems: readonly string[]; readonly rejectedRecord?: NativeToolRecord } {
  if (history.records.length >= 256 || history.observations.length >= 1024) return { status: "conflict", history, rejectedRecord: record, problems: ["history capacity reached; preserve existing evidence"] };
  if (history.records.some(item => !normalizeNativeToolEvidence(item, {}, depth).valid) || history.current !== null && !history.records.some(item => dotDigest(item.evidence) === dotDigest(history.current)) || history.current === null && history.records.length > 0) return { status: "conflict", history, rejectedRecord: record, problems: ["history current state must come from retained validated returns"] };
  const assessment = normalizeNativeToolEvidence(record, {}, depth);
  if (!assessment.valid) return { status: "conflict", history, rejectedRecord: record, problems: assessment.problems };
  const evidence = record.evidence;
  const key = dotDigest([evidence.attemptId, evidence.toolName, evidence.providerRef?.value ?? null, evidence.providerEventRef?.value ?? evidence.rawResponse.sha256]);
  const existing = history.records.find(item => dotDigest([item.evidence.attemptId, item.evidence.toolName, item.evidence.providerRef?.value ?? null, item.evidence.providerEventRef?.value ?? item.evidence.rawResponse.sha256]) === key);
  if (history.records.some(item => item.attempt.attemptId !== record.attempt.attemptId || dotDigest(item.attempt) !== dotDigest(record.attempt))) return { status: "conflict", history, rejectedRecord: record, problems: ["history belongs to another attempt, work, revision or tool"] };
  if (existing) {
    if (nativeEventContent(existing.evidence) !== nativeEventContent(evidence)) return { status: "conflict", history, rejectedRecord: record, problems: ["same event key has conflicting content"] };
    if (history.records.some(item => nativeObservationContent(item.evidence) === nativeObservationContent(evidence))) return { status: "duplicate", history: { ...history, observations: [...history.observations, { key, observedAt: evidence.observedAt, sourceRef: evidence.rawResponse.ref }] }, problems: [] };
    // Same provider bytes with a different independent check retain both original
    // records. Execution current remains monotone; completion is reassessed above.
  }
  const current = history.current;
  const currentConfirmed = current?.association.status === "associated" && current.executionFinality === "confirmed";
  const returnedConfirmed = evidence.association.status === "associated" && evidence.executionFinality === "confirmed";
  if (currentConfirmed && returnedConfirmed && current!.executionStatus !== evidence.executionStatus) return { status: "conflict", history, rejectedRecord: record, problems: ["contradictory confirmed terminal states"] };
  const useNew = current === null || !currentConfirmed && (returnedConfirmed || dotInstant(evidence.observedAt, "observedAt") >= dotInstant(current.observedAt, "observedAt"));
  return { status: "appended", history: { records: [...history.records, record], observations: [...history.observations, { key, observedAt: evidence.observedAt, sourceRef: evidence.rawResponse.ref }], current: useNew ? evidence : current }, problems: [] };
}

export type NativeRetryReconciliation = { readonly outcome: "confirmed-terminal"; readonly record: NativeToolRecord }
  | { readonly outcome: "confirmed-not-executed"; readonly queryTool: string; readonly queryRef: string; readonly queriedAttemptId: string; readonly responseValue: unknown; readonly observedAt: string; readonly notExecutedPointer: string; readonly notExecutedValue: string; readonly contractRef: string };
/** Unknown outcome is not retry permission. The original attempt and evidence remain immutable. */
export function createNativeToolRetry(previous: NativeToolAttempt, admission: DotAdmission, input: Parameters<typeof createNativeToolAttempt>[1], reconciliation: NativeRetryReconciliation): { readonly previousAttemptId: string; readonly reconciliationDigest: string; readonly attempt: NativeToolAttempt } {
  validateNativeRetry(previous, admission, input, reconciliation);
  return { previousAttemptId: previous.attemptId, reconciliationDigest: dotDigest(reconciliation), attempt: createNativeToolAttempt(admission, input) };
}
function validateNativeRetry(previous: NativeToolAttempt, admission: DotAdmission, input: { readonly toolName: string; readonly requestedAt: string }, reconciliation: NativeRetryReconciliation, depth = 0): void {
  validateNativeToolAttempt(previous);
  let reconciledAt: string;
  if (reconciliation.outcome === "confirmed-terminal") {
    dotObject(reconciliation, "terminal reconciliation", ["outcome", "record"]);
    if (!normalizeNativeToolEvidence(reconciliation.record, {}, depth).valid || dotDigest(reconciliation.record.attempt) !== dotDigest(previous) || reconciliation.record.evidence.association.status !== "associated" || reconciliation.record.evidence.executionFinality !== "confirmed" || !["failed", "cancelled"].includes(reconciliation.record.evidence.executionStatus)) fail("retry needs an associated confirmed failure/cancellation or actual non-execution query");
    reconciledAt = reconciliation.record.evidence.observedAt;
  } else if (reconciliation.outcome === "confirmed-not-executed") {
    dotObject(reconciliation, "non-execution reconciliation", ["outcome", "queryTool", "queryRef", "queriedAttemptId", "responseValue", "observedAt", "notExecutedPointer", "notExecutedValue", "contractRef"]);
    dotText(reconciliation.queryRef, "queryRef"); dotText(reconciliation.queryTool, "queryTool"); dotText(reconciliation.notExecutedValue, "notExecutedValue");
    if (reconciliation.queriedAttemptId !== previous.attemptId || reconciliation.contractRef !== previous.toolContractObservation.ref || String(pointer(reconciliation.responseValue, reconciliation.notExecutedPointer)) !== reconciliation.notExecutedValue) fail("non-execution query does not bind the original attempt and tool contract");
    reconciledAt = reconciliation.observedAt;
  } else fail("pending outcome requires an actual query before retry");
  if (dotInstant(reconciledAt, "reconciledAt") < dotInstant(previous.requestedAt, "previous requestedAt") || dotInstant(input.requestedAt, "retry requestedAt") < dotInstant(reconciledAt, "reconciledAt")) fail("retry must follow the actual reconciliation, never redate an old attempt");
  if (admission.request.workId !== previous.workId || admission.request.libraryId !== previous.libraryId || dotDigest(admission.request.projectRef) !== dotDigest(previous.projectRef) || input.toolName !== previous.toolName) fail("retry cannot silently change work or tool");

}

// General native protocol. Legacy v1 dot records above are intentionally unchanged.
import { HOST_EXECUTION_DECISION_VERSION, executionDecisionEligibility, hostObject, hostText, HostExecutionError } from "./host-capabilities.js";
import type { HostExecutionDecision } from "./execution-fallback.js";
import { validateHostExecutionRequest } from "./execution-fallback.js";
export const HOST_NATIVE_PREPARATION_VERSION = "tcrn.host-native-preparation.v1" as const;
export const HOST_NATIVE_RECORD_VERSION = "tcrn.host-native-record.v1" as const;
export interface HostNativePreparation {
  readonly schemaVersion: typeof HOST_NATIVE_PREPARATION_VERSION;
  readonly context: Record<string, unknown>;
  readonly decision: HostExecutionDecision;
  readonly attempt: null | { readonly id: string; readonly identityKind: "local-correlation"; readonly toolName: string; readonly argumentsValue: unknown; readonly requestedAt: string };
  readonly digest: string;
}
export type HostNativeStatus = "unknown" | "accepted" | "running" | "completed" | "failed" | "cancelled";
export interface HostNativeEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: "host-response" | "work-report" | "cancel-requested" | "cancel-accepted" | "review";
  readonly raw?: unknown;
  readonly sourceTool?: string;
  readonly sourceRef?: string;
  /** Only maps a field that actually exists in raw; absent metadata remains unknown. */
  readonly status?: { readonly pointer: string; readonly mapping: Readonly<Record<string, HostNativeStatus>> };
  readonly terminal?: { readonly pointer: string; readonly values: readonly string[]; readonly contract: string };
  readonly actualSelection?: { readonly pointer: string };
  readonly providerId?: { readonly pointer: string };
  readonly report?: { readonly summary: string; readonly contextReads: readonly string[]; readonly artifacts: readonly string[]; readonly checks: readonly string[]; readonly limitations: readonly string[] };
  readonly review?: { readonly status: "pass" | "fail"; readonly reviewer: string; readonly evidence: readonly string[] };
}
export interface HostNativeRecord {
  readonly schemaVersion: typeof HOST_NATIVE_RECORD_VERSION;
  readonly preparation: HostNativePreparation;
  readonly events: readonly HostNativeEvent[];
  readonly validation: { readonly status: "valid"; readonly authentication: "not-performed" };
  readonly execution: HostNativeStatus;
  readonly executionFinality: "confirmed" | "unknown";
  readonly evidenceQuality: "limited" | "complete";
  readonly verification: "unverified" | "pass" | "fail";
  readonly taskOutcome: "pending" | "delivered-awaiting-review" | "accepted-by-review" | "rejected-by-review";
  readonly cancellation: { readonly requested: boolean; readonly accepted: boolean };
  readonly occupancy: "retained-or-unknown" | "released";
  readonly followup: "required" | "terminal-confirmed";
  readonly processFields: "not-applicable";
  readonly actualSelection: unknown;
  readonly providerId: unknown;
  readonly conflicts: readonly string[];
  readonly digest: string;
}
export function validateHostNativePreparation(value: unknown): HostNativePreparation {
  const p = hostObject(value, "host preparation", ["schemaVersion", "context", "decision", "attempt", "digest"]);
  if (p.schemaVersion !== HOST_NATIVE_PREPARATION_VERSION) throw new HostExecutionError("unknown native preparation protocol");
  const { digest, ...payload } = p;
  if (digest !== dotDigest(payload)) throw new HostExecutionError("native preparation digest mismatch");
  const decision = p.decision as HostExecutionDecision;
  if (decision?.schemaVersion !== HOST_EXECUTION_DECISION_VERSION || executionDecisionEligibility(decision) === "uninterpretable") throw new HostExecutionError("uninterpretable execution decision");
  validateHostExecutionRequest(decision.request);
  const context = p.context as Record<string, unknown>;
  if (!context || context.workId !== decision.request.workId || context.workRevision !== decision.request.workRevision || dotDigest(context.executionDecision) !== dotDigest(decision)) throw new HostExecutionError("decision differs from project context");
  if (p.attempt !== null) {
    if (executionDecisionEligibility(decision) !== "executable" || context.dispatchAdmitted !== true) throw new HostExecutionError("nonexecutable preparation cannot start an attempt");
    const a = hostObject(p.attempt, "host attempt", ["id", "identityKind", "toolName", "argumentsValue", "requestedAt"]);
    hostText(a.id, "local attempt id");
    if (!String(a.id).startsWith("local-attempt:") || a.identityKind !== "local-correlation" || a.toolName !== decision.request.capabilities.toolName || !Object.hasOwn(a, "argumentsValue")) throw new HostExecutionError("invalid local attempt association");
    dotInstant(a.requestedAt, "requestedAt");
  }
  return value as HostNativePreparation;
}
const hostStatuses: readonly HostNativeStatus[] = ["unknown", "accepted", "running", "completed", "failed", "cancelled"];
function validateHostNativeEvent(value: unknown, p: HostNativePreparation): HostNativeEvent {
  const e = hostObject(value, "native event", ["id", "at", "kind", "raw", "sourceTool", "sourceRef", "status", "terminal", "actualSelection", "providerId", "report", "review"]);
  hostText(e.id, "event id");
  if (dotInstant(e.at, "event at") < dotInstant(p.attempt?.requestedAt, "requestedAt")) throw new HostExecutionError("event predates invocation");
  if (!["host-response", "work-report", "cancel-requested", "cancel-accepted", "review"].includes(String(e.kind))) throw new HostExecutionError("unknown native event kind");
  if (e.sourceRef !== undefined) hostText(e.sourceRef, "event sourceRef");
  if (e.kind === "host-response" || e.kind === "cancel-accepted") {
    // Raw is retained even when it is a string and no structured fields are available.
    if (!Object.hasOwn(e, "raw") || e.raw === undefined) throw new HostExecutionError("actual host return required");
    hostText(e.sourceTool, "source tool");
    if (e.kind === "host-response" && e.sourceTool !== p.attempt?.toolName) throw new HostExecutionError("response tool differs from invocation");
  } else if (["raw", "sourceTool", "status", "terminal", "actualSelection", "providerId"].some(key => Object.hasOwn(e, key))) throw new HostExecutionError("work report/cancel request/review cannot forge host fields");
  if (e.status !== undefined) {
    const s = hostObject(e.status, "status observation", ["pointer", "mapping"]); hostText(s.pointer, "status pointer");
    if (!s.mapping || typeof s.mapping !== "object" || Array.isArray(s.mapping) || Object.values(s.mapping).some(status => !hostStatuses.includes(status as HostNativeStatus))) throw new HostExecutionError("invalid status mapping");
    const rawStatus = String(pointer(e.raw, s.pointer));
    if (!Object.hasOwn(s.mapping, rawStatus)) throw new HostExecutionError("actual status has no declared mapping");
  }
  if (e.terminal !== undefined) {
    const t = hostObject(e.terminal, "terminal observation", ["pointer", "values", "contract"]); hostText(t.pointer, "terminal pointer"); hostText(t.contract, "terminal contract"); dotRefs(t.values, "terminal values", true);
    if (e.kind !== "host-response" || !e.status || !t.values.includes(String(pointer(e.raw, t.pointer)))) throw new HostExecutionError("terminality requires actual terminal host response");
    const s = e.status as HostNativeEvent["status"];
    const status = s!.mapping[String(pointer(e.raw, s!.pointer))];
    if (!["completed", "failed", "cancelled"].includes(String(status))) throw new HostExecutionError("nonterminal host status cannot prove finality");
  }
  for (const field of ["actualSelection", "providerId"]) if (e[field] !== undefined) {
    const observation = hostObject(e[field], field, ["pointer"]); hostText(observation.pointer, `${field} pointer`);
    const observed = pointer(e.raw, observation.pointer);
    if (field === "providerId" && observed === p.attempt?.id) throw new HostExecutionError("local correlation is not a provider identity");
  }
  if (e.kind === "work-report") {
    const report = hostObject(e.report, "work report", ["summary", "contextReads", "artifacts", "checks", "limitations"]); hostText(report.summary, "report summary");
    for (const key of ["contextReads", "artifacts", "checks", "limitations"]) dotRefs(report[key], key);
  } else if (e.report !== undefined) throw new HostExecutionError("report must use work-report event");
  if (e.kind === "review") {
    const review = hostObject(e.review, "review", ["status", "reviewer", "evidence"]);
    if (!["pass", "fail"].includes(String(review.status))) throw new HostExecutionError("invalid review outcome"); hostText(review.reviewer, "reviewer"); dotRefs(review.evidence, "review evidence", true);
  } else if (e.review !== undefined) throw new HostExecutionError("review must use independent review event");
  return value as HostNativeEvent;
}
/** Pure recorder, not a launcher or authentication service. No synthetic process fields. */
export function recordHostNativeEvents(preparationValue: unknown, incoming: readonly HostNativeEvent[], previous?: unknown): HostNativeRecord {
  const preparation = validateHostNativePreparation(preparationValue);
  if (!preparation.attempt) throw new HostExecutionError("preparation has no executable attempt");
  if (!Array.isArray(incoming)) throw new HostExecutionError("events must be an array");
  let events: HostNativeEvent[] = [];
  if (previous !== undefined) {
    const prior = normalizeHostNativeRecord(previous);
    if (prior.preparation.digest !== preparation.digest) throw new HostExecutionError("prior record belongs to another attempt");
    events = [...prior.events];
  }
  for (const raw of incoming) {
    const event = validateHostNativeEvent(raw, preparation);
    if (!events.some(old => dotDigest(old) === dotDigest(event))) events.push(event);
  }
  const conflicts: string[] = [];
  const ids = new Map<string, string>();
  for (const event of events) { const hash = dotDigest(event); if (ids.has(event.id) && ids.get(event.id) !== hash) conflicts.push(`conflicting-event:${event.id}`); ids.set(event.id, hash); }
  // Original arrival order remains stored. Evaluation uses observed time; a late accepted event
  // cannot erase a confirmed terminal. Contradictory terminals require reconciliation.
  const ordered = [...events].sort((a, b) => Number(dotInstant(a.at, "event at") - dotInstant(b.at, "event at")));
  let execution: HostNativeStatus = "unknown";
  const terminals = new Set<HostNativeStatus>();
  let actualSelection: unknown = { status: "unknown", reason: "not returned by host" };
  let providerId: unknown = { status: "unknown", reason: "not returned by host" };
  let verification: HostNativeRecord["verification"] = "unverified";
  for (const e of ordered) {
    if (e.kind === "host-response") {
      if (e.status) { const status = e.status.mapping[String(pointer(e.raw, e.status.pointer))]!; execution = status; if (e.terminal) terminals.add(status); }
      if (e.actualSelection) actualSelection = { status: "observed", value: pointer(e.raw, e.actualSelection.pointer), eventId: e.id };
      if (e.providerId) providerId = { status: "observed", value: pointer(e.raw, e.providerId.pointer), eventId: e.id };
    }
    if (e.kind === "review") verification = e.review!.status;
  }
  if (terminals.size > 1) conflicts.push("conflicting-host-terminals");
  const confirmed = terminals.size === 1 && conflicts.length === 0;
  if (confirmed) execution = [...terminals][0]!;
  if (conflicts.length) execution = "unknown";
  const delivered = events.some(event => event.kind === "work-report");
  const payload = {
    schemaVersion: HOST_NATIVE_RECORD_VERSION, preparation, events,
    validation: { status: "valid" as const, authentication: "not-performed" as const }, execution,
    executionFinality: confirmed ? "confirmed" as const : "unknown" as const,
    evidenceQuality: "limited" as const,
    verification, taskOutcome: verification === "fail" ? "rejected-by-review" as const : verification === "pass" && delivered ? "accepted-by-review" as const : delivered ? "delivered-awaiting-review" as const : "pending" as const,
    cancellation: { requested: events.some(e => e.kind === "cancel-requested"), accepted: events.some(e => e.kind === "cancel-accepted") },
    occupancy: confirmed ? "released" as const : "retained-or-unknown" as const,
    followup: confirmed ? "terminal-confirmed" as const : "required" as const,
    processFields: "not-applicable" as const, actualSelection, providerId, conflicts,
  };
  return { ...payload, digest: dotDigest(payload) };
}
export function normalizeHostNativeRecord(value: unknown): HostNativeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostExecutionError("native record must be object");
  const record = value as HostNativeRecord;
  if (record.schemaVersion !== HOST_NATIVE_RECORD_VERSION) throw new HostExecutionError("unknown native record protocol");
  const calculated = recordHostNativeEvents(record.preparation, record.events);
  if (dotDigest(calculated) !== dotDigest(record)) throw new HostExecutionError("native record differs from retained events");
  return calculated;
}
