// SPDX-License-Identifier: Apache-2.0
import type { InvolvedProjects, ProjectReference, WorkRecord } from "../../protocol/src/index.js";
import { canonicalJson } from "../../protocol/src/index.js";

export class InvolvedProjectsError extends Error {
  readonly reasonCode = "WORKSPACE_INPUT_INVALID";
}
export function projectReference(value: unknown): ProjectReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvolvedProjectsError("project reference must be an object");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "libraryId,projectId" || typeof r.libraryId !== "string" || !/^(library|workspace):[a-f0-9]{24}$/u.test(r.libraryId) || typeof r.projectId !== "string" || !/^project:[a-f0-9]{24}$/u.test(r.projectId)) throw new InvolvedProjectsError("project reference requires stable libraryId and projectId");
  return { libraryId: r.libraryId, projectId: r.projectId };
}
export const projectReferenceKey = (value: ProjectReference): string => JSON.stringify([value.libraryId, value.projectId]);
export function normalizeInvolvedProjects(value: unknown): InvolvedProjects {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvolvedProjectsError("involvedProjects must explicitly declare its state and targets");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "state,targets" || !Array.isArray(r.targets)) throw new InvolvedProjectsError("involvedProjects requires exactly state and targets");
  if (r.state === "undecided" || r.state === "coordination-only") {
    if (r.targets.length !== 0) throw new InvolvedProjectsError("only selected work can name project targets");
    return { state: r.state, targets: [] };
  }
  if (r.state !== "selected" || r.targets.length === 0) throw new InvolvedProjectsError("selected work requires targets; clearing requires undecided or coordination-only");
  const targets = [...new Map(r.targets.map(projectReference).map(target => [projectReferenceKey(target), target])).values()].sort((a,b) => projectReferenceKey(a) < projectReferenceKey(b) ? -1 : projectReferenceKey(a) > projectReferenceKey(b) ? 1 : 0);
  return { state: "selected", targets };
}
export function involvedProjectsOf(record: Pick<WorkRecord, "involvedProjects">): InvolvedProjects {
  return record.involvedProjects ?? { state: "undecided", targets: [] };
}
/** What a new record stores: undecided is absence (contract item 4), so it is never written; the other states are. */
export function storedInvolvedProjects(value: InvolvedProjects): InvolvedProjects | undefined {
  return value.state === "undecided" ? undefined : value;
}
export function assertStoredInvolvedProjects(value: unknown): void {
  if (canonicalJson(value) !== canonicalJson(normalizeInvolvedProjects(value))) throw new InvolvedProjectsError("stored involvedProjects must be canonical and deduplicated");
}
export function hasInvolvedProject(record: Pick<WorkRecord, "involvedProjects">, reference: ProjectReference): boolean {
  return involvedProjectsOf(record).targets.some(target => projectReferenceKey(target) === projectReferenceKey(reference));
}

/** Declared child scope is bounded by a declared parent; omission remains undecided. */
export function assertInvolvedProjectScope(work: readonly WorkRecord[], record: WorkRecord): void {
  if (record.parentId === null || involvedProjectsOf(record).state !== "selected") return;
  const parent = work.find(entry => entry.id === record.parentId);
  if (!parent) return;
  const scope = involvedProjectsOf(parent);
  if (scope.state === "undecided") return;
  if (scope.state === "coordination-only" || involvedProjectsOf(record).targets.some(target => !scope.targets.some(candidate => projectReferenceKey(candidate) === projectReferenceKey(target)))) throw new InvolvedProjectsError("child projects exceed the declared parent scope");
}
