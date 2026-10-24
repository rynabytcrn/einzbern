import { normalizeInvolvedProjects } from "./involved-projects.js";
// SPDX-License-Identifier: Apache-2.0

// STORY-300 slice 3: apply an ordered, heterogeneous sequence of work-record writes as
// one act -- one write lock, one replay, one clock reading and one view projection.
//
// The Story this belongs to opens with the cost it exists to remove: recording N facts
// should cost O(1) chain-write round trips. Filing four knowledge cards on 2026-08-19 took
// sixteen, because every record needs its version read, its write made, and its receipt
// read back. That is the ceremony the platform's own audit called backwards.
//
// Two things here are less obvious than the batching.
//
// FAILURE ATTRIBUTION. The acceptance criterion asks that a member which failed only
// because an earlier member did be structurally distinguishable from one that failed on
// its own -- and it must be structural, not a difference in message wording. That falls
// out of running two passes. The shape pass needs no state, so every member is judged
// independently and all of its verdicts are reported together: those are failures a
// member owns. The apply pass is ordered and all-or-nothing, so the first member to fail
// against accumulated state ends it, and the members after it were never evaluated at
// all. "Not evaluated" is a different fact from "evaluated and failed", and reporting it
// as its own list is the distinction the criterion is about.
//
// INTRA-BATCH REFERENCES. A work id is derived from its external key, so a member acting
// on a record an earlier member created would otherwise have to carry a hash the caller
// computed by hand. Members may name `externalKey` instead of `id`, and `parentExternalKey`
// instead of `parentId`, and the batch derives both. That second one is not a convenience:
// a Story must hang under a parent, so without it the commonest batch there is -- open an
// Epic and the Stories beneath it -- cannot be written at all.

import {
  PROTOCOL_LIMITS,
  ProtocolError,
  canonicalExternalKey,
  deriveStableId,
  parseStrictInstant,
} from "../../protocol/src/index.js";
import type { JsonValue, WorkRecord } from "../../protocol/src/index.js";
import {
  WorkspaceError,
  appendEvents,
  createWorkDelta,
  annotateWorkDelta,
  transitionWorkDelta,
} from "./workspace.js";
import type { MutationDelta, WorkspaceState } from "./workspace.js";
import { WorkLeaseError, assertWorkLeaseAdmits } from "./work-lease.js";
import type { WorkRelationsInput } from "./work-relations.js";

export const WORK_BATCH_SCHEMA_VERSION = "tcrn.work-batch.v1" as const;
export const WORK_BATCH_VERBS = Object.freeze(["work-create", "work-transition", "work-annotate"]);

// TCRN-CROSS-STORY-472 R1: the kinds a batch may create. Incident and Release are refused with the
// reason code the single verb gives (WORK_KIND_RETIRED) and its remedy, in the shape pass, so a
// batch hears it for every such member at once.
const WORK_KINDS = Object.freeze(["Initiative", "Epic", "Story", "Subtask"]);
const RETIRED_WORK_KINDS = Object.freeze(["Incident", "Release"]);
const WORK_STATUSES = Object.freeze(["planned", "ready", "active", "done", "cancelled"]);
// TCRN-CROSS-STORY-472 R4: a member's relations, by field name; each a list of ids.
const RELATION_FIELDS = Object.freeze(["blockedBy", "implements", "supersedes", "fixes", "decidedIn"]);

export interface WorkBatchProblem {
  readonly index: number;
  readonly verb: string | null;
  readonly rule: string;
  readonly detail: string;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROTOCOL_LIMITS.maxStringLength;
}

// Resolving a reference by external key is what lets one member act on what an earlier
// member created. `id` still wins when both are given, so an explicit id is never
// silently replaced by a derivation.
function referencedId(member: Readonly<Record<string, unknown>>): string | null {
  if (isNonEmptyString(member.id)) return member.id;
  if (isNonEmptyString(member.externalKey)) return deriveStableId("work", canonicalExternalKey(member.externalKey));
  return null;
}

// The parent a work-create member puts the record it creates under: `parentId`, else the record
// `parentExternalKey` derives, else none.
function createdParentId(member: Readonly<Record<string, unknown>>): string | null {
  return isNonEmptyString(member.parentId)
    ? member.parentId
    : isNonEmptyString(member.parentExternalKey)
      ? deriveStableId("work", canonicalExternalKey(member.parentExternalKey))
      : null;
}

// The shape of a member's relations: an object of the five known fields, each a list of strings.
// Whether the targets exist is the delta's question, asked against the accumulated state, so a
// member may relate to a record an earlier member created.
function relationsProblem(value: unknown): string | null {
  if (!isObject(value)) return "relations is an object";
  for (const [field, list] of Object.entries(value)) {
    if (!RELATION_FIELDS.includes(field)) return `relation ${field} is not one of ${RELATION_FIELDS.join(", ")}`;
    if (!Array.isArray(list) || !list.every((entry) => isNonEmptyString(entry))) return `relation ${field} is a list of ids`;
  }
  return null;
}

// TCRN-CROSS-STORY-525 (TCRN-CROSS-SUB-446): a member's gates are a list of names; whether each is a
// gate name, and whether its kind may carry them, is the delta's question, as for the single verbs.
function gatesProblem(value: unknown): string | null {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry)) ? null : "gates is a list of gate names";
}

// The shape pass. Every member is judged against the same rules the single verbs apply at
// their CLI boundary, with no workspace state involved -- which is precisely why every
// verdict here belongs to the member that earned it.
function shapeProblems(members: readonly unknown[]): readonly WorkBatchProblem[] {
  const problems: WorkBatchProblem[] = [];
  members.forEach((member, index) => {
    if (!isObject(member)) {
      problems.push({ index, verb: null, rule: "member-object", detail: "a batch member is an object" });
      return;
    }
    const verb = isNonEmptyString(member.verb) ? member.verb : null;
    if (verb === null || !WORK_BATCH_VERBS.includes(verb)) {
      problems.push({ index, verb, rule: "verb-known", detail: `verb must be one of ${WORK_BATCH_VERBS.join(", ")}` });
      return;
    }
    if (verb === "work-create") {
      // TCRN-CROSS-STORY-363: title joins the required three. The batch is a creation
      // path like the single verb, and leaving it optional here would have made a batch
      // the one remaining way to mint a record nothing but its external key names --
      // which is the condition the requirement exists to end, not a shape it exempts.
      for (const field of ["projectId", "externalKey", "kind", "title"]) {
        if (!isNonEmptyString(member[field])) problems.push({ index, verb, rule: "field-required", detail: field });
      }
      if (member.kind !== undefined && RETIRED_WORK_KINDS.includes(member.kind as string)) {
        problems.push({ index, verb, rule: "kind-retired", detail: `WORK_KIND_RETIRED: kind=${String(member.kind)}; open a Story with a fixes relation` });
      } else if (member.kind !== undefined && !WORK_KINDS.includes(member.kind as string)) {
        problems.push({ index, verb, rule: "kind-known", detail: `kind=${String(member.kind)}` });
      }
      if (member.relations !== undefined) {
        const problem = relationsProblem(member.relations);
        if (problem !== null) problems.push({ index, verb, rule: "relations-shape", detail: problem });
      }
      if (member.gates !== undefined) {
        const problem = gatesProblem(member.gates);
        if (problem !== null) problems.push({ index, verb, rule: "gates-shape", detail: problem });
      }
      if (member.status !== undefined && !WORK_STATUSES.includes(member.status as string)) {
        problems.push({ index, verb, rule: "status-known", detail: `status=${String(member.status)}` });
      }
      // TCRN-CROSS-STORY-473 R2: a Story needs a goal and an acceptance, as fields or from a
      // scope. The engine judges the mapping at the reducer; a Story member naming neither is
      // refused here, so the whole batch is reported at once rather than one member per round trip.
      if (member.kind === "Story" && member.content === undefined && member.scope === undefined && (member.goal === undefined || member.acceptance === undefined)) {
        problems.push({ index, verb, rule: "story-fields-required", detail: "a new Story carries goal and acceptance, or a scope they map from" });
      }
      return;
    }
    if (!isNonEmptyString(member.id) && !isNonEmptyString(member.externalKey)) {
      problems.push({ index, verb, rule: "reference-required", detail: "id or externalKey names the record to act on" });
    }
    if (verb === "work-transition") {
      if (!WORK_STATUSES.includes(member.status as string)) {
        problems.push({ index, verb, rule: "status-known", detail: `status=${String(member.status)}` });
      }
      return;
    }
    if (member.involvedProjects === undefined && member.scope === undefined && member.decidedBy === undefined && member.sprint === undefined && member.summary === undefined && member.relations === undefined &&
      member.goal === undefined && member.acceptance === undefined && member.body === undefined && member.gates === undefined && member.content === undefined) {
      problems.push({ index, verb, rule: "advisory-required", detail: "an annotation carries at least one of scope, decidedBy, sprint, summary, relations, goal, acceptance, body, gates" });
    }
    if (member.relations !== undefined) {
      const problem = relationsProblem(member.relations);
      if (problem !== null) problems.push({ index, verb, rule: "relations-shape", detail: problem });
    }
    if (member.gates !== undefined) {
      const problem = gatesProblem(member.gates);
      if (problem !== null) problems.push({ index, verb, rule: "gates-shape", detail: problem });
    }
  });
  return problems;
}

function relationsOf(member: Readonly<Record<string, unknown>>): { readonly relations?: WorkRelationsInput } {
  return member.relations === undefined ? {} : { relations: member.relations as WorkRelationsInput };
}

// TCRN-CROSS-STORY-525: a member's gate names, passed through for the engine to judge.
function gatesOf(member: Readonly<Record<string, unknown>>): { readonly gates?: readonly string[] } {
  return member.gates === undefined ? {} : { gates: member.gates as readonly string[] };
}

// TCRN-CROSS-STORY-473 R2: a member's Story fields, passed through for the engine to judge.
function storyFieldsOf(member: Readonly<Record<string, unknown>>): { readonly goal?: string; readonly acceptance?: string; readonly body?: string; readonly content?: unknown } {
  return {
    ...(member.goal === undefined ? {} : { goal: member.goal as string }),
    ...(member.acceptance === undefined ? {} : { acceptance: member.acceptance as string }),
    ...(member.body === undefined ? {} : { body: member.body as string }),
    ...(member.content === undefined ? {} : { content: member.content }),
  };
}

// TCRN-CROSS-STORY-528 (MIN-256; TCRN-CROSS-SUB-457): a transition or an annotation member writes as
// the batch's actor, so another actor's lease refuses it as it refuses the single verb, and the
// batch writes nothing.
function deltaFor(member: Readonly<Record<string, unknown>>, occurredAt: string, actorId: string | undefined): (state: WorkspaceState) => MutationDelta {
  if (member.verb === "work-create") {
    return createWorkDelta({
      projectId: member.projectId as string,
      externalKey: member.externalKey as string,
      kind: member.kind as never,
      parentId: createdParentId(member),
      ...(member.status === undefined ? {} : { status: member.status as never }),
      ...(member.scope === undefined ? {} : { scope: member.scope as string }),
      ...(member.decidedBy === undefined ? {} : { decidedBy: member.decidedBy as readonly string[] }),
      ...relationsOf(member),
      ...(member.involvedProjects === undefined ? {} : { involvedProjects: normalizeInvolvedProjects(member.involvedProjects) }),
      ...storyFieldsOf(member),
      ...gatesOf(member),
      ...(member.templateAdmission === undefined ? {} : { templateAdmission: member.templateAdmission }),
      title: member.title as string,
      ...(member.summary === undefined ? {} : { summary: member.summary as string }),
      occurredAt,
    });
  }
  const id = referencedId(member) as string;
  if (member.verb === "work-transition") {
    return transitionWorkDelta({
      id,
      status: member.status as never,
      ...(member.summary === undefined ? {} : { summary: member.summary as string }),
      occurredAt,
      ...(actorId === undefined ? {} : { actorId }),
    });
  }
  return annotateWorkDelta({
    id,
    ...(member.expectedRevision === undefined ? {} : { expectedRevision: member.expectedRevision as number }),
    ...(member.scope === undefined ? {} : { scope: member.scope as string }),
    ...(member.decidedBy === undefined ? {} : { decidedBy: member.decidedBy as readonly string[] }),
    ...(member.sprint === undefined ? {} : { sprint: member.sprint as never }),
    ...relationsOf(member),
      ...(member.involvedProjects === undefined ? {} : { involvedProjects: normalizeInvolvedProjects(member.involvedProjects) }),
    ...storyFieldsOf(member),
    ...gatesOf(member),
    ...(member.summary === undefined ? {} : { summary: member.summary as string }),
    occurredAt,
    ...(actorId === undefined ? {} : { actorId }),
  });
}

export interface WorkBatchOptions {
  // TCRN-CROSS-STORY-467 R1: no expected version -- the engine applies the batch under its
  // write lock against the latest state.
  readonly occurredAt: string;
  readonly actorId?: string;
}

export async function applyWorkBatch(
  workspaceRoot: string,
  document: unknown,
  options: WorkBatchOptions,
): Promise<WorkspaceState> {
  if (!isObject(document) || document.schemaVersion !== WORK_BATCH_SCHEMA_VERSION || !Array.isArray(document.members)) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `a batch is ${WORK_BATCH_SCHEMA_VERSION} with a members array`);
  }
  const members = document.members as readonly unknown[];
  if (members.length === 0) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", "a batch carries at least one member");
  }
  if (members.length > PROTOCOL_LIMITS.maxRecords) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `members=${members.length}`);
  }
  const problems = shapeProblems(members);
  if (problems.length > 0) {
    // Every shape verdict at once. A member is refused here on its own terms, never
    // because of a neighbour, so there is nothing consequential to separate out.
    throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({ stage: "shape", problems }));
  }
  // Resolve member inputs inside its indexed delta, so normalization failures receive
  // the same attribution as state-dependent refusals from appendEvents.
  const deltas = members.map((member) => (state: WorkspaceState) =>
    deltaFor(member as Readonly<Record<string, unknown>>, options.occurredAt, options.actorId)(state));
  try {
    return await appendEvents(workspaceRoot, deltas, options);
  } catch (error) {
    // The index comes from appendEvents, which is the only thing that knows it. Counting
    // completed closures from out here was wrong three ways: the counter advanced after
    // the closure returned while actor injection and event construction ran afterwards
    // and throw too, a pre-loop failure (instant, lock) left it at zero and blamed
    // member zero, and a last-member failure fell through unattributed.
    const failing = (error as { memberIndex?: unknown }).memberIndex;
    if (typeof failing !== "number") throw error;
    const carried = (error as { reasonCode?: unknown }).reasonCode;
    const reason = typeof carried === "string" && carried.length > 0 ? carried : "WORKSPACE_ERROR";
    const detail = error instanceof Error ? error.message : String(error);
    const phase = (error as { memberPhase?: unknown }).memberPhase;
    // "the closure refused this member" and "the event this member produced could not be
    // built" are different facts about the same index, and a caller deciding what to fix
    // needs to know which.
    throw applyRefusal(members, failing, typeof phase === "string" ? phase : "delta", reason, detail);
  }
}

// The refusal of the apply pass. The apply pass is ordered and all-or-nothing, so exactly one
// member is ever evaluated-and-failed and everything after it is unevaluated. Reporting the second
// group as its own list is the structural distinction: those members are not being called invalid,
// they are being called unjudged.
function applyRefusal(members: readonly unknown[], failing: number, phase: string, reasonCode: string, detail: string): WorkspaceError {
  const member = members[failing];
  return new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({
    stage: "apply",
    failed: {
      index: failing,
      verb: isObject(member) ? member.verb ?? null : null,
      phase,
      reasonCode,
      detail,
    },
    notEvaluated: Array.from({ length: members.length - failing - 1 }, (_, offset) => failing + offset + 1),
  }));
}

// A key that does not canonicalize, or an instant that does not parse, is for the shape or the apply
// pass to refuse, not for the lease check.
function resolvedOrNull<T>(resolve: () => T): T | null {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof ProtocolError) return null;
    throw error;
  }
}

/**
 * TCRN-CROSS-STORY-536 (MIN-257 D6; TCRN-CROSS-SUB-472): hold every transition and annotation member
 * of a batch to the leases at `occurredAt`, as the apply pass would hold it, before anything else
 * judges the batch -- the gates of a Story it takes to done above all. Members are judged in order,
 * and a record an earlier member creates sits under the parent that member names, so a member that
 * acts on it is bound by a lease above it. The first member another actor's unexpired lease binds
 * refuses the whole batch with the WORK_BATCH_REFUSED of the apply pass (EPIC-149 R4 Q3): failed
 * names the member, WORK_LEASED, and in its detail the holder and when the lease runs out; the
 * members after it are not evaluated. A work-create member is not held by a lease (MIN-256 R1 Q7),
 * and a document that is not a batch is left for applyWorkBatch to refuse.
 *
 * TCRN-CROSS-SUB-496: leases are judged only at an `occurredAt` the write takes. Any other is the
 * write's to refuse (TIMESTAMP_INVALID), for the reason it gets in a library that holds no lease, so
 * no member is held to a lease at it.
 */
export function assertWorkBatchLeases(state: Pick<WorkspaceState, "configRecords" | "work">, document: unknown, options: WorkBatchOptions): void {
  if (!isObject(document) || document.schemaVersion !== WORK_BATCH_SCHEMA_VERSION || !Array.isArray(document.members)) return;
  if (resolvedOrNull(() => parseStrictInstant(options.occurredAt)) === null) return;
  const members = document.members as readonly unknown[];
  // The lease walk reads only a record's id and parentId, so a record a member creates joins the
  // view as those two; a later entry for an id takes the place of an earlier one.
  const work: WorkRecord[] = [...state.work];
  const view = { configRecords: state.configRecords, work };
  for (const [index, member] of members.entries()) {
    if (!isObject(member)) continue;
    if (member.verb === "work-create") {
      const created = resolvedOrNull(() => isNonEmptyString(member.externalKey)
        ? { id: deriveStableId("work", canonicalExternalKey(member.externalKey)), parentId: createdParentId(member) }
        : null);
      if (created !== null) work.push(created as unknown as WorkRecord);
      continue;
    }
    if (member.verb !== "work-transition" && member.verb !== "work-annotate") continue;
    const id = resolvedOrNull(() => referencedId(member));
    if (id === null) continue;
    try {
      assertWorkLeaseAdmits(view, id, options.actorId, options.occurredAt);
    } catch (error) {
      // Only a lease that binds the member is the member's; the instant parses (above), and anything
      // else is thrown as it is.
      if (error instanceof WorkLeaseError && error.reasonCode === "WORK_LEASED") throw applyRefusal(members, index, "delta", error.reasonCode, error.message);
      throw error;
    }
  }
}

export function workBatchReceipt(state: WorkspaceState, members: number): Readonly<Record<string, JsonValue>> {
  return {
    schemaVersion: "tcrn.work-batch-result.v1",
    reasonCode: "WORK_BATCH_APPLIED",
    members,
    version: state.version,
    headEventHash: state.headEventHash,
  };
}
