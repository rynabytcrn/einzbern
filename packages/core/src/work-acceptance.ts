// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";
import { workContent } from "./work-content.js";
import type { RequirementRef, WorkContent, WorkAcceptance, WorkAcceptanceEvidence } from "./work-content.js";
import { effectiveWorkRequirements, resolveWorkRequirement } from "./work-requirements.js";
import type { EffectiveWorkRequirement } from "./work-requirements.js";
export function sameRequirementRef(a: RequirementRef, b: RequirementRef): boolean { return a.workId === b.workId && a.requirementId === b.requirementId && a.version === b.version; }
function workAcceptanceMeaning(work: readonly WorkRecord[], record: WorkRecord, acceptanceId: string): { readonly acceptance: WorkAcceptance | null; readonly effective: readonly EffectiveWorkRequirement[]; readonly constraints: readonly unknown[] } {
  const content = workContent(record);
  const acceptance = content?.acceptance.find(a => a.id === acceptanceId) ?? null;
  const effective = effectiveWorkRequirements([...work.filter(w => w.id !== record.id), record], record.id).filter(r => acceptance && sameRequirementRef(r.ref, acceptance.requirement));
  const constraints: unknown[] = [];
  const seen = new Set<string>(); let current: WorkRecord | undefined = record;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); const c = workContent(current);
    constraints.push({ workId: current.id, meaning: c ? { kind: c.kind, variant: c.variant, goal: c.goal, scope: c.scope, constraints: c.constraints, details: c.details } : Object.fromEntries(["advisory:scope", "advisory:goal", "advisory:acceptance", "advisory:body"].map(key => [key, current!.extensions[key]?.value ?? null])) });
    const parent: string | null = current.parentId; current = parent === null ? undefined : work.find(w => w.id === parent && !w.tombstone);
  }
  return { acceptance, effective, constraints };
}
/** Per-acceptance structural content version; unrelated requirements and display metadata do not invalidate it. */
export function workAcceptanceMeaningDigest(work: readonly WorkRecord[], record: WorkRecord, acceptanceId: string): string {
  return canonicalSha256(workAcceptanceMeaning(work, record, acceptanceId));
}
function compatibleAcceptanceMeaningDigests(work: readonly WorkRecord[], record: WorkRecord, acceptanceId: string): readonly string[] {
  const meaning = workAcceptanceMeaning(work, record, acceptanceId);
  const digests = [canonicalSha256(meaning)];
  const requirement = meaning.effective[0];
  // One acceptance binds one exact requirement ref. Its two roles form a set, but historical
  // evidence hashed their first-allocation order. Admit only the other order of these same
  // two roles, recomputing every other field from the current context; never rewrite evidence.
  if (meaning.effective.length === 1 && requirement?.responsibilities.length === 2 && requirement.responsibilities.includes("implementation") && requirement.responsibilities.includes("verification")) {
    digests.push(canonicalSha256({ ...meaning, effective: [{ ...requirement, responsibilities: [...requirement.responsibilities].reverse() }] }));
  }
  return digests;
}
function evidenceObservation(e: WorkAcceptanceEvidence): string { const { meaningDigest: _digest, ...observation } = e; return canonicalJson(observation); }
/** Only an absent binding on a new observation is derived; explicit bindings are preserved, not upgraded. */
export function bindWorkContentEvidence(work: readonly WorkRecord[], record: WorkRecord, previous?: WorkRecord): WorkContent {
  const content = workContent(record)!;
  const oldEvidence = previous ? workContent(previous)?.evidence ?? [] : [];
  return { ...content, evidence: content.evidence.map(e => {
    if (e.meaningDigest !== undefined) return e; // Explicit historical binding is never upgraded, even for changed/reintroduced observations.
    const old = oldEvidence.find(p => evidenceObservation(p) === evidenceObservation(e));
    if (old) { const { meaningDigest: _provided, ...observation } = e; return { ...observation, ...(old.meaningDigest ? { meaningDigest: old.meaningDigest } : {}) }; }
    return { ...e, meaningDigest: workAcceptanceMeaningDigest(work, record, e.acceptanceId) };
  }) };
}
/** Machine linkage only. The returned empty list is never a claim of semantic verification. */
export function workAcceptanceProblems(work: readonly WorkRecord[], record: WorkRecord, options: { readonly done?: boolean; readonly codeVersion?: string } = {}): readonly string[] {
  const content = workContent(record); if (!content) return [];
  const problems: string[] = [];
  const effective = effectiveWorkRequirements(work, record.id);
  for (const r of effective) if (!content.acceptance.some(a => sameRequirementRef(a.requirement, r.ref))) problems.push(`requirement:${r.ref.workId}/${r.ref.requirementId}@${r.ref.version}:acceptance:missing`);
  for (const a of content.acceptance) {
    if (!resolveWorkRequirement(work, a.requirement) || !effective.some(r => sameRequirementRef(r.ref, a.requirement))) problems.push(`acceptance:${a.id}:requirement:unresolved`);
    if (options.done) {
      const candidate = options.codeVersion ?? content.completion?.codeVersion;
      const meaningDigests = compatibleAcceptanceMeaningDigests(work, record, a.id);
      const evidence = content.evidence.filter(e => e.acceptanceId === a.id && e.acceptanceVersion === a.version && sameRequirementRef(e.requirement, a.requirement) && e.codeVersion === candidate && e.meaningDigest !== undefined && meaningDigests.includes(e.meaningDigest));
      if (!candidate || !evidence.some(e => e.outcome === "satisfied" && e.locator.trim() && e.actual.trim() && !/^(?:pass(?:ed)?|ok|success)$/iu.test(e.actual.trim()))) problems.push(`acceptance:${a.id}:evidence:missing`);
      if (evidence.some(e => e.outcome !== "satisfied")) problems.push(`acceptance:${a.id}:evidence:unresolved`);
    }
  }
  if (options.done) for (const e of content.evidence) {
    const current = content.acceptance.find(a => a.id === e.acceptanceId);
    if (current && (current.version !== e.acceptanceVersion || !sameRequirementRef(current.requirement, e.requirement)) && problems.includes(`acceptance:${current.id}:evidence:missing`)) problems.push(`evidence:${e.acceptanceId}:version:stale`);
  }
  return problems;
}
