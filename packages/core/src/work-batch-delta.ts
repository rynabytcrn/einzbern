// SPDX-License-Identifier: Apache-2.0

// Fixed deferred normalization shared by the legacy and private create-batch paths.
// This module deliberately has no callback registration or package-index export.
import { PROTOCOL_LIMITS, canonicalExternalKey, deriveStableId } from "../../protocol/src/index.js";
import { normalizeInvolvedProjects } from "./involved-projects.js";
import { createWorkDelta, annotateWorkDelta, transitionWorkDelta } from "./workspace.js";
import type { MutationDelta, WorkspaceState } from "./workspace.js";
import type { WorkRelationsInput } from "./work-relations.js";
import type { WorkBatchOptions } from "./work-batch.js";

type Builder = (state: WorkspaceState) => MutationDelta;
interface Captures {
  readonly member: Readonly<Record<string, unknown>>;
  readonly options: WorkBatchOptions;
}
const captures = new WeakMap<Builder, Captures>();
// New metadata must be inert even when the actual write takes the legacy path.
const lookupCaptures = captures.get.bind(captures);
const recordCaptures = captures.set.bind(captures);
const freezeCaptures = Object.freeze;

export function createWorkBatchMemberDelta(member: Readonly<Record<string, unknown>>, options: WorkBatchOptions): Builder {
  const builder: Builder = (state) => resolveWorkBatchMemberDelta(member, options.occurredAt, options.actorId)(state);
  // Freeze our metadata only, never the caller-owned member/options.
  recordCaptures(builder, freezeCaptures({ member, options }));
  return builder;
}

export function workBatchMemberCaptures(builder: Builder): Captures | undefined {
  return lookupCaptures(builder);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROTOCOL_LIMITS.maxStringLength;
}

// Resolving a reference by external key is what lets one member act on what an earlier
// member created. `id` still wins when both are given, so an explicit id is never
// silently replaced by a derivation.
export function referencedId(member: Readonly<Record<string, unknown>>): string | null {
  if (isNonEmptyString(member.id)) return member.id;
  if (isNonEmptyString(member.externalKey)) return deriveStableId("work", canonicalExternalKey(member.externalKey));
  return null;
}

// The parent a work-create member puts the record it creates under: `parentId`, else the record
// `parentExternalKey` derives, else none.
export function createdParentId(member: Readonly<Record<string, unknown>>): string | null {
  return isNonEmptyString(member.parentId)
    ? member.parentId
    : isNonEmptyString(member.parentExternalKey)
      ? deriveStableId("work", canonicalExternalKey(member.parentExternalKey))
      : null;
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
export function resolveWorkBatchMemberDelta(member: Readonly<Record<string, unknown>>, occurredAt: string, actorId: string | undefined): (state: WorkspaceState) => MutationDelta {
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
