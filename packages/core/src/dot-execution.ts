// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { canonicalJson, parseStrictInstant } from "../../protocol/src/index.js";
import type { ExecutionContextRead, ExecutionContextReadExpectation, ExecutionContextReadObservation } from "./dot-agents.js";
import type { ProjectReference } from "../../protocol/src/index.js";
import { resolveNativeExecutionConcurrency } from "./execution-policy.js";

export const DOT_EXECUTION_MODE = "dot-autonomous" as const;
export const DOT_EXECUTION_TARGET = "chatgpt-dot" as const;
export const DOT_ADMISSION_VERSION = "tcrn.dot-admission.v1" as const;
export type RevisionBinding = { readonly kind: "revision"; readonly workRevision: number; readonly scopeDigest: string }
  | { readonly kind: "frozen-scope"; readonly scopeDigest: string; readonly frozenAt: string; readonly freezeEvidenceRef: string };
export interface DotCheck { readonly status: "pass" | "fail" | "unknown"; readonly evidenceRefs: readonly string[]; readonly reason: string }
export const DOT_REQUIRED_CHECKS = ["work", "scope", "target", "permission", "tools", "state", "context", "output", "verification"] as const;
export type DotCheckName = typeof DOT_REQUIRED_CHECKS[number];
export interface DotExecutionRequest {
  readonly mode: typeof DOT_EXECUTION_MODE;
  readonly executionTarget: typeof DOT_EXECUTION_TARGET;
  readonly libraryId: string;
  readonly projectRef: ProjectReference;
  readonly workId: string;
  readonly revisionBinding: RevisionBinding;
  readonly requestedAgents: number;
  readonly requiredTools: readonly string[];
  readonly actualCapabilityEvidenceRefs: readonly string[];
  readonly authorizationEvidenceRef: string;
  readonly checks: Readonly<Record<DotCheckName, DotCheck>>;
  readonly occupancyObservation: { readonly status: "observed" | "unknown"; readonly activeAgents: number | null; readonly includesParent: boolean; readonly parentActive: boolean; readonly platformLimit: number | null; readonly observedAt: string; readonly evidenceRef: string };
  readonly modelObservation: { readonly status: "unavailable"; readonly reason: string } | { readonly status: "observed"; readonly value: string; readonly sourceRef: string };
  readonly contextRead?: { readonly record: ExecutionContextRead; readonly expected: ExecutionContextReadExpectation; readonly observations: readonly ExecutionContextReadObservation[] };
  readonly exactDelegation?: { readonly runner: string; readonly model: string; readonly effort: string; readonly supported: boolean; readonly actualInvocationMetadataRef: string | null; readonly observedTuple?: { readonly runner: string; readonly model: string; readonly effort: string } };
}
export interface DotAdmission {
  readonly schemaVersion: typeof DOT_ADMISSION_VERSION;
  readonly status: "admitted" | "refused";
  readonly reasonCodes: readonly string[];
  readonly request: DotExecutionRequest;
  readonly requestDigest: string;
  readonly contextDigest: string;
  readonly evaluatedAt: string;
  readonly applicability: Readonly<Record<"selfModelSelection" | "modelTier" | "modelEscalation" | "accountQuota", { readonly status: "not-applicable"; readonly reason: string }>>;
  readonly checks: DotExecutionRequest["checks"];
  readonly concurrency: ReturnType<typeof resolveNativeExecutionConcurrency>;
  readonly modelObservation: DotExecutionRequest["modelObservation"];
}
export class DotExecutionError extends Error { readonly reasonCode = "DOT_EXECUTION_INVALID"; }
export function dotObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DotExecutionError(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) throw new DotExecutionError(`${path} contains unsupported fields`);
  return result;
}
export function dotText(value: unknown, path: string): asserts value is string { if (typeof value !== "string" || !value.trim()) throw new DotExecutionError(`${path} must be nonempty`); }
export function dotDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value as Parameters<typeof canonicalJson>[0])).digest("hex"); }
export function dotSha(value: unknown, path: string): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new DotExecutionError(`${path} must be SHA-256`); }
export function dotInstant(value: unknown, path: string): bigint { if (typeof value !== "string" || !value.endsWith("Z")) throw new DotExecutionError(`${path} must be UTC`); return parseStrictInstant(value); }
export function dotRefs(value: unknown, path: string, nonempty = false): asserts value is readonly string[] { if (!Array.isArray(value) || nonempty && !value.length) throw new DotExecutionError(`${path} must be an array${nonempty ? " with evidence" : ""}`); for (const ref of value) dotText(ref, path); }
export function validateRevisionBinding(value: unknown): RevisionBinding {
  const r = dotObject(value, "revisionBinding", ["kind", "workRevision", "scopeDigest", "frozenAt", "freezeEvidenceRef"]);
  dotSha(r.scopeDigest, "scopeDigest");
  if (r.kind === "revision") {
    if (Object.keys(r).length !== 3 || !Number.isSafeInteger(r.workRevision) || Number(r.workRevision) < 1) throw new DotExecutionError("revision binding requires a positive workRevision only");
  } else if (r.kind === "frozen-scope") {
    if (Object.keys(r).length !== 4) throw new DotExecutionError("frozen binding requires supported freeze evidence only");
    dotInstant(r.frozenAt, "frozenAt"); dotText(r.freezeEvidenceRef, "freezeEvidenceRef");
  } else throw new DotExecutionError("unknown revision binding");
  return value as RevisionBinding;
}
export function validateDotExecutionRequest(value: unknown): DotExecutionRequest {
  const r = dotObject(value, "request", ["mode", "executionTarget", "libraryId", "projectRef", "workId", "revisionBinding", "requestedAgents", "requiredTools", "actualCapabilityEvidenceRefs", "authorizationEvidenceRef", "checks", "occupancyObservation", "modelObservation", "contextRead", "exactDelegation"]);
  if (r.mode !== DOT_EXECUTION_MODE || r.executionTarget !== DOT_EXECUTION_TARGET) throw new DotExecutionError("explicit dot mode and target required");
  const p = dotObject(r.projectRef, "projectRef", ["libraryId", "projectId"]);
  if (!/^(library|workspace):[a-f0-9]{24}$/u.test(String(r.libraryId)) || p.libraryId !== r.libraryId || !/^project:[a-f0-9]{24}$/u.test(String(p.projectId)) || !/^work:[a-z0-9][a-z0-9._-]{0,127}$/u.test(String(r.workId))) throw new DotExecutionError("stable library/project/work binding required");
  validateRevisionBinding(r.revisionBinding);
  if (!Number.isSafeInteger(r.requestedAgents) || Number(r.requestedAgents) < 1) throw new DotExecutionError("requestedAgents must be positive");
  dotRefs(r.requiredTools, "requiredTools", true); dotRefs(r.actualCapabilityEvidenceRefs, "actualCapabilityEvidenceRefs", true); dotText(r.authorizationEvidenceRef, "authorizationEvidenceRef");
  const checks = dotObject(r.checks, "checks", DOT_REQUIRED_CHECKS);
  for (const name of DOT_REQUIRED_CHECKS) {
    const c = dotObject(checks[name], `checks.${name}`, ["status", "evidenceRefs", "reason"]);
    if (!["pass", "fail", "unknown"].includes(String(c.status))) throw new DotExecutionError("unknown check status");
    dotRefs(c.evidenceRefs, `${name}.evidenceRefs`, c.status === "pass"); dotText(c.reason, `${name}.reason`);
  }
  const o = dotObject(r.occupancyObservation, "occupancyObservation", ["status", "activeAgents", "includesParent", "parentActive", "platformLimit", "observedAt", "evidenceRef"]);
  if (!["observed", "unknown"].includes(String(o.status)) || typeof o.includesParent !== "boolean" || typeof o.parentActive !== "boolean") throw new DotExecutionError("explicit occupancy accounting required");
  if (o.status === "unknown" && (o.activeAgents !== null || o.platformLimit !== null)) throw new DotExecutionError("unknown occupancy must not infer counts");
  if (o.status === "observed" && (!Number.isSafeInteger(o.activeAgents) || Number(o.activeAgents) < 0 || !Number.isSafeInteger(o.platformLimit) || Number(o.platformLimit) < 1)) throw new DotExecutionError("observed occupancy requires actual counts and platform limit");
  dotInstant(o.observedAt, "occupancy.observedAt"); dotText(o.evidenceRef, "occupancy.evidenceRef");
  const model = dotObject(r.modelObservation, "modelObservation", ["status", "reason", "value", "sourceRef"]);
  if (model.status === "unavailable") { if (Object.keys(model).length !== 2) throw new DotExecutionError("unavailable model has no invented value"); dotText(model.reason, "model.reason"); }
  else if (model.status === "observed") { if (Object.keys(model).length !== 3) throw new DotExecutionError("observed model requires source"); dotText(model.value, "model.value"); dotText(model.sourceRef, "model.sourceRef"); }
  else throw new DotExecutionError("model observation required");
  if (r.exactDelegation !== undefined) {
    const d = dotObject(r.exactDelegation, "exactDelegation", ["runner", "model", "effort", "supported", "actualInvocationMetadataRef", "observedTuple"]);
    for (const key of ["runner", "model", "effort"]) dotText(d[key], key);
    if (d.observedTuple !== undefined) { const tuple = dotObject(d.observedTuple, "observedTuple", ["runner", "model", "effort"]); for (const key of ["runner", "model", "effort"]) dotText(tuple[key], key); }
    if (typeof d.supported !== "boolean" || d.actualInvocationMetadataRef !== null && typeof d.actualInvocationMetadataRef !== "string") throw new DotExecutionError("exact delegation capability observation required");
  }
  return value as DotExecutionRequest;
}
/** Pure evidence assessment, not authentication, a reservation, or a host fallback. */
export function resolveDotExecutionAdmission(value: DotExecutionRequest, options: { readonly deviceLimit: number; readonly projectLimit?: number; readonly now: string; readonly contextDigest: string }): DotAdmission {
  const request = validateDotExecutionRequest(value); const now = dotInstant(options.now, "now"); dotSha(options.contextDigest, "contextDigest");
  const o = request.occupancyObservation;
  const concurrency = resolveNativeExecutionConcurrency(options.deviceLimit, options.projectLimit, o.platformLimit, o.activeAgents, o.includesParent, o.parentActive);
  const reasonCodes = DOT_REQUIRED_CHECKS.filter(name => request.checks[name].status !== "pass").map(name => `DOT_${name.toUpperCase()}_${request.checks[name].status.toUpperCase()}`);
  const age = now - dotInstant(o.observedAt, "occupancy.observedAt");
  if (age < 0n || age > 300_000_000_000n) reasonCodes.push("DOT_OCCUPANCY_STALE");
  if (concurrency.availableSlots === null) reasonCodes.push("DOT_OCCUPANCY_UNKNOWN");
  else if (request.requestedAgents > concurrency.availableSlots) reasonCodes.push("DOT_CONCURRENCY_EXCEEDED");
  if (request.exactDelegation && (!request.exactDelegation.supported || !request.exactDelegation.actualInvocationMetadataRef?.trim() || !request.exactDelegation.observedTuple || ["runner", "model", "effort"].some(key => request.exactDelegation!.observedTuple![key as "runner" | "model" | "effort"] !== request.exactDelegation![key as "runner" | "model" | "effort"]))) reasonCodes.push("DOT_EXACT_DELEGATION_UNSUPPORTED");
  const na = { status: "not-applicable" as const, reason: "dot self model selection, tiers, escalation and account quota are not controllable or observable admission inputs" };
  return { schemaVersion: DOT_ADMISSION_VERSION, status: reasonCodes.length ? "refused" : "admitted", reasonCodes, request, requestDigest: dotDigest(request), contextDigest: options.contextDigest, evaluatedAt: options.now, applicability: { selfModelSelection: na, modelTier: na, modelEscalation: na, accountQuota: na }, checks: request.checks, concurrency, modelObservation: request.modelObservation };
}
