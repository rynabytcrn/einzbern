// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { JsonValue, WorkRecord } from "../../protocol/src/index.js";
import { WORK_CONTENT_KEY, workContent, contentFail } from "./work-content.js";
import type { WorkContent, WorkRequirement, WorkSource, RequirementRef } from "./work-content.js";
export interface EffectiveWorkRequirement {
  readonly ref: RequirementRef;
  readonly requirement: WorkRequirement;
  readonly sources: readonly WorkSource[];
  readonly inherited: boolean;
  readonly responsibilities: readonly ("implementation" | "verification")[];
}
function ancestry(work: readonly WorkRecord[], id: string): string[] {
  const result: string[] = []; let current: string | null = id;
  while (current && !result.includes(current)) { result.push(current); current = work.find(w => w.id === current)?.parentId ?? null; }
  return result;
}
/** Shared constraints flow down; a local requirement flows only through an assigned child branch. */
export function effectiveWorkRequirements(work: readonly WorkRecord[], workId: string): readonly EffectiveWorkRequirement[] {
  const lineage = ancestry(work, workId); const result: EffectiveWorkRequirement[] = [];
  for (const id of lineage) {
    const record = work.find(w => w.id === id && !w.tombstone); if (!record) continue;
    const content = workContent(record); if (!content) continue;
    for (const requirement of content.requirements) {
      if (requirement.disposition !== "required") continue;
      const allocations = content.allocations.filter(a => a.workId === id && a.requirementId === requirement.id && a.version === requirement.version && lineage.includes(a.childId));
      if (id !== workId && !requirement.shared && !allocations.length) continue;
      // Preserve allocation order here: historical acceptance evidence binds this projection.
      result.push({ ref: { workId: id, requirementId: requirement.id, version: requirement.version }, requirement, sources: content.sources.filter(s => requirement.sourceIds.includes(s.id)), inherited: id !== workId, responsibilities: [...new Set(allocations.map(a => a.responsibility))] });
    }
  }
  return result;
}
export function resolveWorkRequirement(work: readonly WorkRecord[], ref: RequirementRef): WorkRequirement | null {
  const record = work.find(w => w.id === ref.workId && !w.tombstone);
  return record ? workContent(record)?.requirements.find(r => r.id === ref.requirementId && r.version === ref.version) ?? null : null;
}
export function workRequirementProblems(work: readonly WorkRecord[], record: WorkRecord): readonly string[] {
  const content = workContent(record); if (!content) return [];
  const problems: string[] = []; const children = work.filter(w => w.parentId === record.id && !w.tombstone);
  for (const r of content.requirements) {
    for (const id of r.sourceIds) if (!content.sources.some(s => s.id === id)) problems.push(`requirement:${r.id}:source:${id}:missing`);
    if (r.disposition !== "required" && !r.decision?.trim()) problems.push(`requirement:${r.id}:decision:missing`);
    if (r.disposition === "required" && (children.length > 0 || record.kind === "Initiative" || record.kind === "Epic")) {
      for (const role of ["implementation", "verification"] as const) if (!content.allocations.some(a => a.workId === record.id && a.requirementId === r.id && a.version === r.version && a.responsibility === role && children.some(c => c.id === a.childId))) problems.push(`requirement:${r.id}:allocation:${role}:unresolved`);
    }
  }
  for (const a of content.allocations) {
    if (!resolveWorkRequirement(work, a)) problems.push(`allocation:${a.requirementId}:version:missing`);
    if (a.workId !== record.id || !children.some(c => c.id === a.childId)) problems.push(`allocation:${a.requirementId}:child:invalid`);
  }
  return problems;
}
function requirementMeaning(r: WorkRequirement): string { const { version: _version, ...meaning } = r; return canonicalJson(meaning); }
export interface WorkContentChangeImpact {
  readonly changedMeaning: boolean;
  readonly approvalChanged: boolean;
  readonly changedRequirements: readonly string[];
  readonly changedAcceptance: readonly string[];
  readonly affectedWorkIds: readonly string[];
  readonly affectedEvidence: readonly { readonly workId: string; readonly acceptanceId: string; readonly locator: string }[];
  readonly requiresDecision: boolean;
}
function bindingMeaning(content: WorkContent): Pick<WorkContent, "kind" | "variant" | "goal" | "scope" | "constraints" | "details"> {
  return { kind: content.kind, variant: content.variant, goal: content.goal, scope: content.scope, constraints: content.constraints, details: content.details };
}
function approvalSources(content: WorkContent): readonly WorkSource[] { return content.sources.filter(s => ["approved-draft", "decision"].includes(s.kind) && s.extraction === "complete"); }
// Compare allocation sets without changing the historical acceptance-evidence projection above.
function allocationMeaning(content: WorkContent): readonly string[] { return [...new Set(content.allocations.map(a => canonicalJson(a)))].sort(); }
function responsibilityMeaning(requirement: EffectiveWorkRequirement | undefined): string {
  return canonicalJson(requirement ? { ref: requirement.ref, responsibilities: [...requirement.responsibilities].sort() } : null);
}
/** Deterministic structural version, never a proof of semantic equivalence. */
export function workContentMeaningDigest(work: readonly WorkRecord[], record: WorkRecord): string {
  const content = workContent(record);
  return canonicalSha256({ direct: content ? { ...bindingMeaning(content), requirements: content.requirements, allocations: allocationMeaning(content), acceptance: content.acceptance, sources: content.sources } : null,
    inherited: ancestry(work, record.id).slice(1).map(id => { const parent = work.find(w => w.id === id); const c = parent && workContent(parent); return { workId: id, meaning: c ? bindingMeaning(c) : null }; }),
    effective: effectiveWorkRequirements([...work.filter(w => w.id !== record.id), record], record.id).map(r => ({ ...r, responsibilities: [...r.responsibilities].sort() })) });
}
export function workContentChangeImpact(work: readonly WorkRecord[], previous: WorkRecord, next: WorkContent): WorkContentChangeImpact {
  const old = workContent(previous);
  if (!old) return { changedMeaning: false, approvalChanged: false, changedRequirements: [], changedAcceptance: [], affectedWorkIds: [], affectedEvidence: [], requiresDecision: false };
  const changedMeaning = canonicalJson(bindingMeaning(old)) !== canonicalJson(bindingMeaning(next));
  const approvalChanged = old.approved !== next.approved || canonicalJson(approvalSources(old)) !== canonicalJson(approvalSources(next));
  const changedSources = new Set([...old.sources, ...next.sources].filter(s => canonicalJson(old.sources.find(n => n.id === s.id) ?? null) !== canonicalJson(next.sources.find(n => n.id === s.id) ?? null)).map(s => s.id));
  const requirementIds = [...new Set([...old.requirements, ...next.requirements].map(r => r.id))];
  const changedRequirements = requirementIds.filter(id => { const r = old.requirements.find(x => x.id === id), n = next.requirements.find(x => x.id === id); return !r || !n || r.version !== n.version || requirementMeaning(r) !== requirementMeaning(n) || [...r.sourceIds, ...n.sourceIds].some(s => changedSources.has(s)); });
  const changedAcceptance = [...new Set([...old.acceptance, ...next.acceptance].map(a => a.id))].filter(id => { const a = old.acceptance.find(x => x.id === id), n = next.acceptance.find(x => x.id === id); return !a || !n || canonicalJson(a) !== canonicalJson(n); });
  // Allocation edits need a decision but do not change the requirement's own version contract.
  const oldAllocations = new Set(allocationMeaning(old)), nextAllocations = new Set(allocationMeaning(next));
  const changedAllocations = canonicalJson([...oldAllocations]) !== canonicalJson([...nextAllocations]);
  const allocationIds = new Set([...old.allocations, ...next.allocations].filter(a => a.workId === previous.id && oldAllocations.has(canonicalJson(a)) !== nextAllocations.has(canonicalJson(a))).map(a => a.requirementId));
  const impactedIds = new Set([...changedRequirements, ...[...old.acceptance, ...next.acceptance].filter(a => changedAcceptance.includes(a.id) && a.requirement.workId === previous.id).map(a => a.requirement.requirementId)]);
  const candidate: WorkRecord = { ...previous, extensions: { ...previous.extensions, [WORK_CONTENT_KEY]: { required: false, value: next as unknown as JsonValue } } };
  const beforeWork = work.map(w => w.id === previous.id ? previous : w), candidateWork = work.map(w => w.id === previous.id ? candidate : w);
  const affectedAllocationIds = new Map<string, ReadonlySet<string>>();
  const affectedWorkIds = beforeWork.filter(w => {
    if (w.status === "done" || w.status === "cancelled" || w.tombstone) return false;
    const before = effectiveWorkRequirements(beforeWork, w.id).filter(r => r.ref.workId === previous.id);
    const after = effectiveWorkRequirements(candidateWork, w.id).filter(r => r.ref.workId === previous.id);
    const allocationChanges = new Set([...allocationIds].filter(id => w.id === previous.id || responsibilityMeaning(before.find(r => r.ref.requirementId === id)) !== responsibilityMeaning(after.find(r => r.ref.requirementId === id))));
    affectedAllocationIds.set(w.id, allocationChanges);
    return (changedMeaning && ancestry(beforeWork, w.id).includes(previous.id)) || (w.id === previous.id && (changedRequirements.length > 0 || changedAcceptance.length > 0 || changedAllocations)) || allocationChanges.size > 0 || [...before, ...after].some(r => impactedIds.has(r.ref.requirementId));
  }).map(w => w.id);
  const affectedEvidence = beforeWork.filter(w => affectedWorkIds.includes(w.id)).flatMap(w => (workContent(w)?.evidence ?? []).filter(e => changedMeaning || (w.id === previous.id && changedAcceptance.includes(e.acceptanceId)) || (e.requirement.workId === previous.id && (impactedIds.has(e.requirement.requirementId) || affectedAllocationIds.get(w.id)?.has(e.requirement.requirementId)))).map(e => ({ workId: w.id, acceptanceId: e.acceptanceId, locator: e.locator })));
  const protectedApproval = old.approved === true || approvalSources(old).length > 0;
  return { changedMeaning, approvalChanged, changedRequirements, changedAcceptance, affectedWorkIds, affectedEvidence, requiresDecision: protectedApproval && (changedMeaning || approvalChanged || changedRequirements.length > 0 || changedAcceptance.length > 0 || changedAllocations) };
}
export function assertWorkContentChange(work: readonly WorkRecord[], previous: WorkRecord, next: WorkContent): void {
  const old = workContent(previous); if (!old) return;
  if ((previous.status === "done" || previous.status === "cancelled") && canonicalJson(old) !== canonicalJson(next)) contentFail("WORK_CONTENT_TERMINAL", "terminal content is historical; create a linked follow-up");
  // Approval provenance is retained, not a mutable switch that disables future protection.
  if ((old.approved === true && next.approved !== true) || approvalSources(old).some(s => !next.sources.some(n => n.id === s.id && canonicalJson(n) === canonicalJson(s)))) contentFail("WORK_CONTENT_APPROVAL_PROVENANCE", "retain prior approval provenance; append a superseding decision rather than erase it");
  const impact = workContentChangeImpact(work, previous, next);
  for (const r of old.requirements) {
    const n = next.requirements.find(x => x.id === r.id);
    if (!n) contentFail("WORK_REQUIREMENT_VERSION", `retain ${r.id} with removed disposition and actual decision`);
    if (n.version < r.version || (impact.changedRequirements.includes(r.id) && n.version <= r.version)) contentFail("WORK_REQUIREMENT_VERSION", `${r.id}: changed meaning/source requires a new version`);
  }
  for (const a of old.acceptance) { const n = next.acceptance.find(x => x.id === a.id); if (n && (n.version < a.version || (impact.changedAcceptance.includes(a.id) && n.version <= a.version))) contentFail("WORK_ACCEPTANCE_VERSION", `${a.id}: changed acceptance requires a new version`); }
  if (impact.requiresDecision && !next.changeDecision?.trim()) contentFail("WORK_CONTENT_DECISION_REQUIRED", "approved scope/design/method change requires the actual Owner decision");
}
export const WORK_CONTENT_IMPACT_KEY = "advisory:work-content-impact" as const;
export interface RecordedWorkContentImpact {
  readonly schemaVersion: "tcrn.work-content-impact.v1";
  readonly previousRevision: number;
  readonly currentRevision: number;
  readonly previousMeaningDigest: string;
  readonly currentMeaningDigest: string;
  readonly impact: WorkContentChangeImpact;
}
export function readWorkContentImpact(record: Pick<WorkRecord, "extensions">): RecordedWorkContentImpact | null {
  const value = record.extensions[WORK_CONTENT_IMPACT_KEY]?.value;
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) contentFail("WORK_CONTENT_IMPACT_INVALID", "impact must be an object");
  const v = value as unknown as RecordedWorkContentImpact;
  if (v.schemaVersion !== "tcrn.work-content-impact.v1" || !Number.isSafeInteger(v.previousRevision) || !Number.isSafeInteger(v.currentRevision) || v.currentRevision !== v.previousRevision + 1 || !/^[a-f0-9]{64}$/u.test(v.previousMeaningDigest) || !/^[a-f0-9]{64}$/u.test(v.currentMeaningDigest) || !v.impact || !Array.isArray(v.impact.affectedWorkIds) || !Array.isArray(v.impact.affectedEvidence)) contentFail("WORK_CONTENT_IMPACT_INVALID", "invalid recorded impact binding");
  const impact = v.impact;
  if (v.previousRevision < 1 || typeof impact.changedMeaning !== "boolean" || typeof impact.approvalChanged !== "boolean" || typeof impact.requiresDecision !== "boolean" || [impact.changedRequirements, impact.changedAcceptance, impact.affectedWorkIds].some(rows => !Array.isArray(rows) || rows.some(row => typeof row !== "string")) || impact.affectedEvidence.some(row => row === null || typeof row !== "object" || typeof row.workId !== "string" || typeof row.acceptanceId !== "string" || typeof row.locator !== "string")) contentFail("WORK_CONTENT_IMPACT_INVALID", "invalid recorded impact fields");
  return v;
}
