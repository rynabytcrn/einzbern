import { workContent, workContentMissing, contentFail } from "./work-content.js";
import { readWorkContentPolicy, workContentPolicyApplies } from "./work-content-templates.js";
import { workRequirementProblems, effectiveWorkRequirements } from "./work-requirements.js";
import { workAcceptanceProblems } from "./work-acceptance.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-525 (MIN-256; TCRN-CROSS-SUB-446): the gates a work record names. An Initiative,
// an Epic or a Story may carry the required:false extension advisory:gates, a list of gate names
// sorted in utf8-byte-order-v1 without repeats; a write deduplicates and sorts what it is given, and
// an empty list removes the field. A Story is held to the names it carries and to those of every
// ancestor on its parent chain (effectiveWorkGates): gates an Epic or an Initiative names bind each
// Story under it. A record that never names a gate keeps the bytes it had before the field existed.
//
// A name is checked for its shape only (isGateName). Whether the library declares that gate is a
// question for the plan and the done check (gates-plan.ts, gates-done.ts), never for the record, so
// a record may name a gate a project declares later and replay never asks what a library declares.

import { compareCanonicalText } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";
import { isGateName } from "./gates-config.js";
import type { WorkspaceState } from "./workspace.js";

export const WORK_GATES_KEY = "advisory:gates" as const;

/** The most gate names one record may carry. */
export const WORK_GATES_LIMIT = RUNTIME_CAPACITY.arrayEntries;

/** The kinds that may carry gate names: what binds a Story is named on it or above it. */
export const WORK_GATES_KINDS = Object.freeze(["Initiative", "Epic", "Story"] as const);

/**
 * A write's gate names as they are stored: each once, sorted in utf8-byte-order-v1. An empty list is
 * a removal. Null when the value is not a list of gate names.
 */
export function normalizedWorkGates(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > WORK_GATES_LIMIT || !value.every((entry) => isGateName(entry))) return null;
  return [...new Set(value as readonly string[])].sort(compareCanonicalText);
}

/**
 * What is wrong with a stored advisory:gates value, or null when nothing is: a non-empty list of at
 * most WORK_GATES_LIMIT gate names, sorted in utf8-byte-order-v1 without repeats. Replay runs this;
 * it never asks whether the library declares a gate.
 */
export function workGatesShapeProblem(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > WORK_GATES_LIMIT) {
    return `must be a non-empty list of at most ${String(WORK_GATES_LIMIT)} gate names`;
  }
  let previous: string | null = null;
  for (const entry of value as readonly unknown[]) {
    if (!isGateName(entry)) return "names something that is not a gate name";
    if (previous !== null && compareCanonicalText(previous, entry) >= 0) return "must be sorted without repeats";
    previous = entry;
  }
  return null;
}

/** The gate names a record carries itself; none when it carries no well-formed list. */
export function workGates(record: Pick<WorkRecord, "extensions">): readonly string[] {
  // A record a batch is about to create may be a partial one here (doneGates in the CLI).
  const extensions = record.extensions as Readonly<Record<string, { readonly value?: unknown } | undefined>> | undefined;
  const value = extensions?.[WORK_GATES_KEY]?.value;
  return workGatesShapeProblem(value) === null ? [...(value as readonly string[])] : [];
}

/**
 * The ids of a record's ancestors along its parent chain in `work`, nearest first. The walk stops at a
 * record with no parent, at a parent `work` does not hold, and at a record it has already passed.
 */
export function workAncestorIds(work: readonly Pick<WorkRecord, "id" | "parentId">[], workId: string): readonly string[] {
  const byId = new Map(work.map((record) => [record.id, record]));
  const ancestors: string[] = [];
  const seen = new Set<string>([workId]);
  let parentId = byId.get(workId)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId) && byId.has(parentId)) {
    ancestors.push(parentId);
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return ancestors;
}

/**
 * The gate names that bind a record: those it carries and those of every ancestor on its parent
 * chain, each once, sorted in utf8-byte-order-v1. A deleted record contributes none; a record the
 * state does not hold is bound by none.
 */
export function effectiveWorkGates(state: Pick<WorkspaceState, "work">, workId: string): readonly string[] {
  const record = state.work.find((entry) => entry.id === workId);
  if (record === undefined) return [];
  const names = new Set<string>();
  for (const id of [workId, ...workAncestorIds(state.work, workId)]) {
    const entry = state.work.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.tombstone === true) continue;
    for (const name of workGates(entry)) names.add(name);
  }
  return [...names].sort(compareCanonicalText);
}

/**
 * TCRN-CROSS-STORY-530 (MIN-256; TCRN-CROSS-SUB-450; Q13): the external keys a Story's commits are
 * known by: each Story's own and those of all its Subtasks, sorted, each once. A record `work` does not
 * hold, or one without an external key, adds none.
 */
export function workSubjectKeys(work: readonly Pick<WorkRecord, "id" | "externalKey" | "kind" | "parentId">[], workIds: readonly string[]): readonly string[] {
  const keys = new Set<string>();
  for (const workId of new Set(workIds)) {
    for (const record of work) {
      const key = (record as { readonly externalKey?: unknown }).externalKey;
      if (typeof key !== "string" || key.length === 0) continue;
      if (record.id === workId || (record.parentId === workId && record.kind === "Subtask")) keys.add(key);
    }
  }
  return [...keys].sort(compareCanonicalText);
}

// INIT-068: structural content admission. Not semantic verification or a new gate record.
export function workContentAdmissionProblems(state: Pick<WorkspaceState, "work" | "settings">, record: WorkRecord, phase: "draft" | "write" | "start" | "done"): readonly string[] {
  const content = workContent(record);
  const policy = readWorkContentPolicy(state, record.projectId);
  if (!content) return workContentPolicyApplies(policy, record, state.work) ? ["content:required"] : [];
  if (phase === "draft") return [];
  const work = [...state.work.filter(w => w.id !== record.id), record];
  const problems = [...workContentMissing(content, phase), ...workRequirementProblems(work, record), ...workAcceptanceProblems(work, record, { done: phase === "done" })];
  if (phase === "start" || phase === "done") {
    for (const ancestorId of workAncestorIds(work, record.id)) {
      const ancestor = work.find(w => w.id === ancestorId);
      if (ancestor && workContent(ancestor)) for (const problem of workRequirementProblems(work, ancestor)) problems.push(`ancestor:${ancestorId}:${problem}`);
    }
    for (const effective of effectiveWorkRequirements(work, record.id)) {
      if (!effective.requirement.text.trim() || !effective.sources.length || effective.sources.some(s => s.extraction !== "complete" || !s.text.trim())) problems.push(`inherited:${effective.ref.workId}/${effective.ref.requirementId}:source:unverified`);
    }
  }
  return problems;
}
export function assertWorkContentAdmission(state: Pick<WorkspaceState, "work" | "settings">, record: WorkRecord, phase: "draft" | "write" | "start" | "done"): void {
  const problems = workContentAdmissionProblems(state, record, phase);
  if (problems.length) contentFail("WORK_CONTENT_INCOMPLETE", `${record.id}: ${problems.join("; ")}`);
}
