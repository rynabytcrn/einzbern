// SPDX-License-Identifier: Apache-2.0
import { canonicalJson } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";

export const WORK_CONTENT_VERSION = "tcrn.work-content.v1" as const;
export const WORK_CONTENT_KEY = "advisory:work-content" as const;
export type ContentWorkKind = "Initiative" | "Epic" | "Story" | "Subtask";
export interface WorkSource {
  readonly id: string;
  readonly kind: "approved-draft" | "decision" | "parent-work" | "user-request";
  readonly locator: string;
  readonly version: string;
  readonly extraction: "complete" | "partial" | "unavailable";
  readonly text: string;
}
export interface RequirementRef { readonly workId: string; readonly requirementId: string; readonly version: number }
export interface WorkRequirement {
  readonly id: string;
  readonly version: number;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly shared: boolean;
  readonly disposition: "required" | "deferred" | "removed";
  readonly decision?: string;
}
export interface RequirementAllocation extends RequirementRef {
  readonly childId: string;
  readonly responsibility: "implementation" | "verification";
}
export interface WorkAcceptance {
  readonly id: string;
  readonly version: number;
  readonly requirement: RequirementRef;
  readonly scenario: string;
  readonly expected: string;
  readonly method: string;
}
export interface WorkAcceptanceEvidence {
  readonly acceptanceId: string;
  /** Engine-bound structural version of the actual acceptance context. */
  readonly meaningDigest?: string;
  readonly acceptanceVersion: number;
  readonly requirement: RequirementRef;
  readonly codeVersion: string;
  readonly locator: string;
  readonly actual: string;
  readonly outcome: "satisfied" | "failed" | "unverified";
  readonly kind: "machine" | "source-behavior-review" | "owner-visual";
}
export interface WorkContent {
  readonly schemaVersion: typeof WORK_CONTENT_VERSION;
  readonly kind: ContentWorkKind;
  readonly variant: "standard" | "defect";
  readonly goal: string;
  readonly sources: readonly WorkSource[];
  readonly scope: string;
  readonly constraints: readonly string[];
  readonly requirements: readonly WorkRequirement[];
  readonly allocations: readonly RequirementAllocation[];
  readonly acceptance: readonly WorkAcceptance[];
  readonly evidence: readonly WorkAcceptanceEvidence[];
  readonly body: string;
  /** Type-specific prose, not mandatory headings in the free body. */
  readonly details: Readonly<Record<string, string>>;
  readonly completion?: { readonly result: string; readonly codeVersion: string };
  /** Actual Owner decision locator, checked against this work's deciding minutes on write. */
  readonly changeDecision?: string;
  readonly approved?: boolean;
}
export class WorkContentError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) { super(message); this.name = "WorkContentError"; this.reasonCode = reasonCode; }
}
export function contentFail(reason: string, message: string): never { throw new WorkContentError(reason, message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) contentFail("WORK_CONTENT_INVALID", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) contentFail("WORK_CONTENT_INVALID", "missing or unknown content fields");
}
function str(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.includes("\u0000")) contentFail("WORK_CONTENT_INVALID", `${label} must be text`);
}
function positive(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) contentFail("WORK_CONTENT_INVALID", `${label} must be a positive integer`);
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) contentFail("WORK_CONTENT_INVALID", `${label} must be an array`);
  return value;
}
function texts(value: unknown, label: string): void { for (const item of list(value, label)) str(item, label); }
function ref(value: unknown): void {
  const r = object(value, "requirement reference");
  // Allocations extend a reference, so their additional keys are checked separately.
  for (const key of ["workId", "requirementId"]) { str(r[key], key); if (!(r[key] as string).trim()) contentFail("WORK_CONTENT_INVALID", `${key} is empty`); }
  positive(r.version, "requirement version");
}
function unique(rows: unknown[], label: string): void {
  const seen = new Set<string>();
  for (const row of rows) { const r = object(row, label); str(r.id, `${label}.id`); if (!r.id.trim() || seen.has(r.id)) contentFail("WORK_CONTENT_INVALID", `${label} ids must be nonempty and unique`); seen.add(r.id); }
}
/** Shape only, including incomplete drafts. Completeness is a separate lifecycle question. */
export function validateWorkContent(value: unknown): WorkContent {
  const c = object(value, "content");
  const keys = ["schemaVersion", "kind", "variant", "goal", "sources", "scope", "constraints", "requirements", "allocations", "acceptance", "evidence", "body", "details", "completion", "changeDecision", "approved"];
  if (Object.keys(c).some(key => !keys.includes(key))) contentFail("WORK_CONTENT_INVALID", "unknown content field");
  if (c.schemaVersion !== WORK_CONTENT_VERSION || !["Initiative", "Epic", "Story", "Subtask"].includes(String(c.kind))) contentFail("WORK_CONTENT_INVALID", "unsupported content schema or kind");
  if (!["standard", "defect"].includes(String(c.variant)) || (c.variant === "defect" && c.kind !== "Story")) contentFail("WORK_CONTENT_INVALID", "defect is a Story variant");
  for (const k of ["goal", "scope", "body"]) str(c[k], k);
  texts(c.constraints, "constraints");
  for (const [key, val] of Object.entries(object(c.details, "details"))) str(val, `details.${key}`);
  const sources = list(c.sources, "sources"); unique(sources, "source");
  for (const row of sources) { const r = object(row, "source"); exact(r, ["id", "kind", "locator", "version", "extraction", "text"]); for (const k of ["locator", "version", "text"]) str(r[k], k); if (!["approved-draft", "decision", "parent-work", "user-request"].includes(String(r.kind)) || !["complete", "partial", "unavailable"].includes(String(r.extraction))) contentFail("WORK_CONTENT_INVALID", "source kind/extraction"); }
  const requirements = list(c.requirements, "requirements"); unique(requirements, "requirement");
  for (const row of requirements) { const r = object(row, "requirement"); exact(r, ["id", "version", "text", "sourceIds", "shared", "disposition"], ["decision"]); positive(r.version, "requirement version"); str(r.text, "requirement text"); texts(r.sourceIds, "sourceIds"); if (typeof r.shared !== "boolean" || !["required", "deferred", "removed"].includes(String(r.disposition))) contentFail("WORK_CONTENT_INVALID", "requirement shared/disposition"); if (r.decision !== undefined) str(r.decision, "decision"); }
  for (const row of list(c.allocations, "allocations")) { ref(row); const r = object(row, "allocation"); exact(r, ["workId", "requirementId", "version", "childId", "responsibility"]); str(r.childId, "childId"); if (!["implementation", "verification"].includes(String(r.responsibility))) contentFail("WORK_CONTENT_INVALID", "allocation responsibility"); }
  const acceptance = list(c.acceptance, "acceptance"); unique(acceptance, "acceptance");
  for (const row of acceptance) { const r = object(row, "acceptance"); exact(r, ["id", "version", "requirement", "scenario", "expected", "method"]); exact(object(r.requirement, "requirement"), ["workId", "requirementId", "version"]); positive(r.version, "acceptance version"); ref(r.requirement); for (const k of ["scenario", "expected", "method"]) str(r[k], k); }
  for (const row of list(c.evidence, "evidence")) { const r = object(row, "evidence"); exact(r, ["acceptanceId", "acceptanceVersion", "requirement", "codeVersion", "locator", "actual", "outcome", "kind"], ["meaningDigest"]); if (r.meaningDigest !== undefined && (typeof r.meaningDigest !== "string" || !/^[a-f0-9]{64}$/u.test(r.meaningDigest))) contentFail("WORK_CONTENT_INVALID", "invalid evidence meaningDigest"); exact(object(r.requirement, "requirement"), ["workId", "requirementId", "version"]); for (const k of ["acceptanceId", "codeVersion", "locator", "actual"]) str(r[k], k); positive(r.acceptanceVersion, "acceptanceVersion"); ref(r.requirement); if (!["satisfied", "failed", "unverified"].includes(String(r.outcome)) || !["machine", "source-behavior-review", "owner-visual"].includes(String(r.kind))) contentFail("WORK_CONTENT_INVALID", "evidence outcome/kind"); }
  if (c.completion !== undefined) { const r = object(c.completion, "completion"); exact(r, ["result", "codeVersion"]); str(r.result, "completion.result"); str(r.codeVersion, "completion.codeVersion"); }
  if (c.changeDecision !== undefined) str(c.changeDecision, "changeDecision");
  if (c.approved !== undefined && typeof c.approved !== "boolean") contentFail("WORK_CONTENT_INVALID", "approved must be boolean");
  canonicalJson(value);
  return value as unknown as WorkContent;
}
export function workContent(record: Pick<WorkRecord, "extensions">): WorkContent | null {
  const value = record.extensions[WORK_CONTENT_KEY]?.value;
  return value === undefined ? null : validateWorkContent(value);
}
export function workContentFields(content: WorkContent): { goal: string; acceptance: string; body: string } {
  return {
    goal: content.goal,
    acceptance: content.acceptance.map(a => `${a.id}@${a.version} [${a.requirement.workId}/${a.requirement.requirementId}@${a.requirement.version}] ${a.scenario}: ${a.expected} (${a.method})`).join("\n"),
    body: [content.body, content.scope, ...content.constraints, ...content.sources.map(s => `${s.id} ${s.locator}@${s.version} [${s.extraction}]\n${s.text}`), ...content.requirements.map(r => `${r.id}@${r.version}: ${r.text}`), ...Object.entries(content.details).map(([k,v]) => `${k}: ${v}`), content.completion?.result ?? ""].filter(Boolean).join("\n\n"),
  };
}
export const WORK_CONTENT_DETAIL_FIELDS: Readonly<Record<ContentWorkKind, readonly string[]>> = Object.freeze({
  Initiative: ["boundary", "approvalBasis", "allocationPlan"],
  Epic: ["deliverables", "interfaces", "dependencies", "childResponsibilities"],
  Story: ["behavior", "discretion"],
  Subtask: ["assignedRequirements", "deliverables", "dependencies", "verificationOwner"],
});
export const WORK_DEFECT_DETAIL_FIELDS = Object.freeze(["expected", "actual", "reproduction", "affectedVersion", "fixBoundary", "regression"]);
export function workContentDraft(kind: ContentWorkKind, options: { readonly variant?: "standard" | "defect" } = {}): WorkContent {
  const variant = options.variant ?? "standard";
  return validateWorkContent({ schemaVersion: WORK_CONTENT_VERSION, kind, variant, goal: "", sources: [], scope: "", constraints: [], requirements: [], allocations: [], acceptance: [], evidence: [], body: "", details: Object.fromEntries([...WORK_CONTENT_DETAIL_FIELDS[kind], ...(variant === "defect" ? WORK_DEFECT_DETAIL_FIELDS : [])].map(k => [k, ""])) });
}
export function workContentMissing(content: WorkContent, phase: "draft" | "write" | "start" | "done" = "write"): readonly string[] {
  if (phase === "draft") return [];
  const missing: string[] = [];
  if (!content.goal.trim()) missing.push("goal");
  if (!content.scope.trim()) missing.push("scope");
  if (!content.sources.length) missing.push("sources");
  if (!content.requirements.length) missing.push("requirements");
  if (!content.acceptance.length) missing.push("acceptance");
  for (const k of [...WORK_CONTENT_DETAIL_FIELDS[content.kind], ...(content.variant === "defect" ? WORK_DEFECT_DETAIL_FIELDS : [])]) if (!content.details[k]?.trim()) missing.push(`details.${k}`);
  for (const s of content.sources) if (!s.locator.trim() || !s.version.trim() || (s.extraction === "complete" && !s.text.trim())) missing.push(`sources.${s.id}`);
  for (const r of content.requirements) if (!r.text.trim() || !r.sourceIds.length) missing.push(`requirements.${r.id}`);
  for (const a of content.acceptance) if (![a.scenario, a.expected, a.method].every(v => v.trim())) missing.push(`acceptance.${a.id}`);
  if (phase === "start" || phase === "done") for (const s of content.sources) if (s.extraction !== "complete") missing.push(`sources.${s.id}.extraction`);
  if (phase === "done" && (!content.completion?.result.trim() || !content.completion.codeVersion.trim())) missing.push("completion");
  return missing;
}
