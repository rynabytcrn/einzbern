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
export interface NativeToolRecord { readonly attempt: NativeToolAttempt; readonly admission: DotAdmission; readonly response: NativeToolResponseInput; readonly evidence: NativeToolEvidence }
export interface NativeEvidenceAssessment { readonly requested: true; readonly evidenceType: "native-tool"; readonly valid: boolean; readonly complete: boolean; readonly status: "invalid" | "pending" | "unverified" | "associated"; readonly problems: readonly string[]; readonly evidence: unknown; readonly authentication: "source-association-only-not-provider-authentication"; readonly executionResponsibility: "retained" | "terminal-confirmed" }
/** Review accepts original source material, not a bare envelope or a passed flag. */
export function normalizeNativeToolEvidence(value: unknown, expected: { readonly workId?: string | null; readonly workRevision?: number | null } = {}): NativeEvidenceAssessment {
  const problems: string[] = []; let complete = false; let pending = false; let associated = false; let terminalConfirmed = false;
  try {
    const wrapped = value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "record");
    const source = wrapped ? dotObject(value, "native saved record", ["record", "normalized"]).record : value;
    const record = dotObject(source, "native record", ["attempt", "admission", "response", "evidence"]);
    const admission = validateDotAdmission(record.admission);
    const attempt = validateNativeToolAttempt(record.attempt, admission);
    if (expected.workId != null && attempt.workId !== expected.workId) fail("review work differs from attempt");
    if (expected.workRevision != null && (attempt.revisionBinding.kind !== "revision" || attempt.revisionBinding.workRevision !== expected.workRevision)) fail("review revision differs from attempt");
    if (record.response === undefined && record.evidence === undefined) pending = true;
    else {
      const rebuilt = recordNativeToolResponse(attempt, record.admission as DotAdmission, record.response as NativeToolResponseInput);
      if (dotDigest(rebuilt) !== dotDigest(record.evidence)) fail("evidence differs from actual source observations");
      if (rebuilt.association.status === "invalid") fail("response association is invalid");
      associated = rebuilt.association.status === "associated";
      terminalConfirmed = associated && rebuilt.executionFinality === "confirmed";
      complete = terminalConfirmed && rebuilt.executionStatus === "reported-completed" && rebuilt.verification.status === "pass";
    }
  } catch (error) { problems.push(String(error)); }
  return { requested: true, evidenceType: "native-tool", valid: problems.length === 0, complete, status: problems.length ? "invalid" : pending ? "pending" : associated ? "associated" : "unverified", problems, evidence: value, authentication: "source-association-only-not-provider-authentication", executionResponsibility: problems.length === 0 && terminalConfirmed ? "terminal-confirmed" : "retained" };
}
export interface NativeToolHistory { readonly records: readonly NativeToolRecord[]; readonly observations: readonly { readonly key: string; readonly observedAt: string }[]; readonly current: NativeToolEvidence | null }
/** No mutation of prior records; late accepted/running observations cannot regress confirmed finality. */
export function appendNativeToolRecord(history: NativeToolHistory, record: NativeToolRecord): { readonly status: "appended" | "duplicate" | "conflict"; readonly history: NativeToolHistory; readonly problems: readonly string[]; readonly rejectedRecord?: NativeToolRecord } {
  if (history.records.some(item => !normalizeNativeToolEvidence(item).valid) || history.current !== null && !history.records.some(item => dotDigest(item.evidence) === dotDigest(history.current)) || history.current === null && history.records.length > 0) return { status: "conflict", history, rejectedRecord: record, problems: ["history current state must come from retained validated returns"] };
  const assessment = normalizeNativeToolEvidence(record);
  if (!assessment.valid) return { status: "conflict", history, rejectedRecord: record, problems: assessment.problems };
  const evidence = record.evidence;
  const key = dotDigest([evidence.attemptId, evidence.toolName, evidence.providerRef?.value ?? null, evidence.providerEventRef?.value ?? evidence.rawResponse.sha256]);
  const existing = history.records.find(item => dotDigest([item.evidence.attemptId, item.evidence.toolName, item.evidence.providerRef?.value ?? null, item.evidence.providerEventRef?.value ?? item.evidence.rawResponse.sha256]) === key);
  if (history.records.some(item => item.attempt.attemptId !== record.attempt.attemptId || dotDigest(item.attempt) !== dotDigest(record.attempt))) return { status: "conflict", history, rejectedRecord: record, problems: ["history belongs to another attempt, work, revision or tool"] };
  if (existing) {
    if (dotDigest({ ...existing.evidence, observedAt: null }) !== dotDigest({ ...evidence, observedAt: null })) return { status: "conflict", history, rejectedRecord: record, problems: ["same event key has conflicting content"] };
    return { status: "duplicate", history: { ...history, observations: [...history.observations, { key, observedAt: evidence.observedAt }] }, problems: [] };
  }
  const current = history.current;
  const currentConfirmed = current?.association.status === "associated" && current.executionFinality === "confirmed";
  const returnedConfirmed = evidence.association.status === "associated" && evidence.executionFinality === "confirmed";
  if (currentConfirmed && returnedConfirmed && current!.executionStatus !== evidence.executionStatus) return { status: "conflict", history, rejectedRecord: record, problems: ["contradictory confirmed terminal states"] };
  const useNew = current === null || !currentConfirmed && (returnedConfirmed || dotInstant(evidence.observedAt, "observedAt") >= dotInstant(current.observedAt, "observedAt"));
  return { status: "appended", history: { records: [...history.records, record], observations: [...history.observations, { key, observedAt: evidence.observedAt }], current: useNew ? evidence : current }, problems: [] };
}

export type NativeRetryReconciliation = { readonly outcome: "confirmed-terminal"; readonly record: NativeToolRecord }
  | { readonly outcome: "confirmed-not-executed"; readonly queryTool: string; readonly queryRef: string; readonly queriedAttemptId: string; readonly responseValue: unknown; readonly observedAt: string; readonly notExecutedPointer: string; readonly notExecutedValue: string; readonly contractRef: string };
/** Unknown outcome is not retry permission. The original attempt and evidence remain immutable. */
export function createNativeToolRetry(previous: NativeToolAttempt, admission: DotAdmission, input: Parameters<typeof createNativeToolAttempt>[1], reconciliation: NativeRetryReconciliation): { readonly previousAttemptId: string; readonly reconciliationDigest: string; readonly attempt: NativeToolAttempt } {
  validateNativeToolAttempt(previous);
  let reconciledAt: string;
  if (reconciliation.outcome === "confirmed-terminal") {
    if (!normalizeNativeToolEvidence(reconciliation.record).valid || dotDigest(reconciliation.record.attempt) !== dotDigest(previous) || reconciliation.record.evidence.association.status !== "associated" || reconciliation.record.evidence.executionFinality !== "confirmed" || !["failed", "cancelled"].includes(reconciliation.record.evidence.executionStatus)) fail("retry needs an associated confirmed failure/cancellation or actual non-execution query");
    reconciledAt = reconciliation.record.evidence.observedAt;
  } else if (reconciliation.outcome === "confirmed-not-executed") {
    dotText(reconciliation.queryRef, "queryRef"); dotText(reconciliation.queryTool, "queryTool"); dotText(reconciliation.notExecutedValue, "notExecutedValue");
    if (reconciliation.queriedAttemptId !== previous.attemptId || reconciliation.contractRef !== previous.toolContractObservation.ref || String(pointer(reconciliation.responseValue, reconciliation.notExecutedPointer)) !== reconciliation.notExecutedValue) fail("non-execution query does not bind the original attempt and tool contract");
    reconciledAt = reconciliation.observedAt;
  } else fail("pending outcome requires an actual query before retry");
  if (dotInstant(reconciledAt, "reconciledAt") < dotInstant(previous.requestedAt, "previous requestedAt") || dotInstant(input.requestedAt, "retry requestedAt") < dotInstant(reconciledAt, "reconciledAt")) fail("retry must follow the actual reconciliation, never redate an old attempt");
  if (admission.request.workId !== previous.workId || input.toolName !== previous.toolName) fail("retry cannot silently change work or tool");
  return { previousAttemptId: previous.attemptId, reconciliationDigest: dotDigest(reconciliation), attempt: createNativeToolAttempt(admission, input) };
}
