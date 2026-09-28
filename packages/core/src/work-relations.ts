// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-472 R2, R3 (MIN-227 D6): the trail from a defect to the decision behind it is a
// chain of relations, not a record kind. Six relation names form a closed vocabulary: parent,
// blocked-by, implements, supersedes, fixes and decided-in. A work record stores only its forward
// relations. parent is its parentId; decided-in is the advisory:decided-by list of minutes ids it
// already carried; the other four live in one required:false extension, advisory:relations, as
// {blockedBy, implements, supersedes, fixes}, each a sorted list of work ids without repeats.
//
// The reverse relations -- blocks, implemented-by, superseded-by, fixed-by and decides -- are a
// projection computed when a record is read, never an event field. Writing both directions would
// let them disagree the moment one write lands and the other does not; reading them from the one
// stored direction cannot.
//
// A write checks that every work target exists and is live and that a record does not relate to
// itself. Replay checks only the shape of the stored value: an old chain, and a merge of devices
// that each saw different records, must still read.

import { assertProtocolId, compareCanonicalText } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";
import { WorkspaceError } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";

export const RELATIONS_EXTENSION_KEY = "advisory:relations" as const;
const DECIDED_BY_EXTENSION_KEY = "advisory:decided-by";

export const RELATION_NAMES = Object.freeze(["parent", "blocked-by", "implements", "supersedes", "fixes", "decided-in"] as const);
export const REVERSE_RELATION_NAMES = Object.freeze(["blocks", "implemented-by", "superseded-by", "fixed-by", "decides"] as const);
export type RelationName = typeof RELATION_NAMES[number];
export type ReverseRelationName = typeof REVERSE_RELATION_NAMES[number];

/** The most targets one relation of one record may name. */
export const RELATION_LIST_LIMIT = 64;

/** The four relations advisory:relations stores, by field name. */
export const STORED_RELATION_FIELDS = Object.freeze(["blockedBy", "implements", "supersedes", "fixes"] as const);
export type StoredRelationField = typeof STORED_RELATION_FIELDS[number];

// Each stored field, the relation name it is written under and the reverse name it is read back as.
const STORED_RELATIONS: readonly { readonly field: StoredRelationField; readonly name: RelationName; readonly reverse: ReverseRelationName }[] = [
  { field: "blockedBy", name: "blocked-by", reverse: "blocks" },
  { field: "implements", name: "implements", reverse: "implemented-by" },
  { field: "supersedes", name: "supersedes", reverse: "superseded-by" },
  { field: "fixes", name: "fixes", reverse: "fixed-by" },
];

/** What a write may say about a record's relations: the four stored lists and decided-in. */
export interface WorkRelationsInput {
  readonly blockedBy?: readonly string[];
  readonly implements?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly fixes?: readonly string[];
  readonly decidedIn?: readonly string[];
}

/** The advisory:relations value: only the lists that name at least one target. */
export type StoredWorkRelations = { readonly [field in StoredRelationField]?: readonly string[] };

/**
 * A write's relations after validation, ready to become extensions. Each stored list the write
 * names replaces that list whole, and an empty one removes it; a list it does not name is kept
 * (mergeStoredRelations).
 */
export interface NormalizedWorkRelations {
  readonly lists?: StoredWorkRelations;
  // The decided-in list for advisory:decided-by, when the write named it.
  readonly decidedIn?: readonly string[];
}

export interface WorkRelationsView {
  readonly forward: {
    readonly parent: string | null;
    readonly blockedBy: readonly string[];
    readonly implements: readonly string[];
    readonly supersedes: readonly string[];
    readonly fixes: readonly string[];
    readonly decidedIn: readonly string[];
  };
  readonly reverse: {
    readonly blocks: readonly string[];
    readonly implementedBy: readonly string[];
    readonly supersededBy: readonly string[];
    readonly fixedBy: readonly string[];
    readonly decides: readonly string[];
  };
  /** Forward work or minutes targets this library does not currently hold as live records. */
  readonly missing: readonly string[];
}

const INPUT_FIELDS: readonly string[] = [...STORED_RELATION_FIELDS, "decidedIn"];

function refuse(message: string): never {
  throw new WorkspaceError("WORKSPACE_INPUT_INVALID", message);
}

function isIdOf(namespace: string, value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(`${namespace}:`)) return false;
  try {
    assertProtocolId(value);
  } catch {
    return false;
  }
  return true;
}

/** Whether a value is a well-formed work id. */
export function isWorkId(value: unknown): value is string {
  return isIdOf("work", value);
}

function isMinutesId(value: unknown): value is string {
  return isIdOf("minutes", value);
}

/** A stored advisory:relations value read leniently: an absent or unreadable value reads as none. */
export function storedRelationsOf(value: unknown): StoredWorkRelations {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return {};
  const stored: { [field in StoredRelationField]?: readonly string[] } = {};
  for (const field of STORED_RELATION_FIELDS) {
    const list = (value as { readonly [key: string]: unknown })[field];
    if (Array.isArray(list)) stored[field] = list.filter((entry): entry is string => typeof entry === "string");
  }
  return stored;
}

/** The stored forward relations of a record. */
export function storedRelations(record: Pick<WorkRecord, "extensions">): StoredWorkRelations {
  return storedRelationsOf(record.extensions[RELATIONS_EXTENSION_KEY]?.value);
}

/**
 * The advisory:relations value after a write: each list the write names replaces the stored one
 * whole, the others stay, and empty lists drop out. Null when no list is left, which removes the
 * extension.
 */
export function mergeStoredRelations(current: StoredWorkRelations, lists: StoredWorkRelations): StoredWorkRelations | null {
  const merged: { [field in StoredRelationField]?: readonly string[] } = {};
  for (const field of STORED_RELATION_FIELDS) {
    const list = Object.hasOwn(lists, field) ? lists[field] : current[field];
    if (list !== undefined && list.length > 0) merged[field] = [...list];
  }
  return Object.keys(merged).length === 0 ? null : merged;
}

/** The decided-in list of a record: its advisory:decided-by minutes ids. */
export function decidedInOf(record: Pick<WorkRecord, "extensions">): readonly string[] {
  const value = record.extensions[DECIDED_BY_EXTENSION_KEY]?.value;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Validate what a write says about the relations of work record `id` against the state it is
 * built on: only the five known fields; every stored target a live work record other than `id`;
 * each list without repeats, sorted, and at most RELATION_LIST_LIMIT long (an empty list is how a
 * write removes one); decided-in a non-empty list of minutes ids, checked for shape only, like
 * advisory:decided-by.
 */
export function validateRelationsInput(state: Pick<WorkspaceState, "work">, id: string, input: WorkRelationsInput): NormalizedWorkRelations {
  if (input === null || typeof input !== "object" || Array.isArray(input)) refuse(`work ${id} relations must be an object`);
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.includes(key)) refuse(`work ${id} relation ${key} is not one of ${INPUT_FIELDS.join(", ")}`);
  }
  const live = new Map(state.work.map((record) => [record.id, record]));
  const lists: { [field in StoredRelationField]?: readonly string[] } = {};
  for (const { field, name } of STORED_RELATIONS) {
    const list: unknown = input[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) refuse(`work ${id} ${name} must be a list of work ids`);
    for (const target of list as readonly unknown[]) {
      if (!isWorkId(target)) refuse(`work ${id} ${name} target ${String(target)} is not a work id`);
      if (target === id) refuse(`work ${id} cannot be ${name} itself`);
    }
    const unique = [...new Set(list as readonly string[])].sort(compareCanonicalText);
    if (unique.length > RELATION_LIST_LIMIT) refuse(`work ${id} ${name} names ${String(unique.length)} targets; at most ${String(RELATION_LIST_LIMIT)}`);
    for (const target of unique) {
      const record = live.get(target);
      if (record === undefined || record.tombstone) refuse(`work ${id} ${name} target ${target} is not a live work record`);
    }
    lists[field] = unique;
  }
  let decidedIn: readonly string[] | undefined;
  if (input.decidedIn !== undefined) {
    const list: unknown = input.decidedIn;
    if (!Array.isArray(list) || list.length === 0 || !list.every((entry) => isMinutesId(entry))) {
      refuse(`work ${id} decided-in must be a non-empty list of minutes ids`);
    }
    decidedIn = [...(list as readonly string[])];
  }
  return {
    ...(Object.keys(lists).length === 0 ? {} : { lists }),
    ...(decidedIn === undefined ? {} : { decidedIn }),
  };
}

/**
 * What is wrong with a stored advisory:relations value of record `id`, or null when nothing is:
 * an object of the four stored fields, each a non-empty, sorted list of at most
 * RELATION_LIST_LIMIT work ids without repeats, none of them `id`. Replay runs this; it never
 * asks whether a target exists.
 */
export function relationsShapeProblem(value: unknown, id: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "must be an object";
  const keys = Object.keys(value);
  if (keys.length === 0) return "must name at least one relation";
  for (const key of keys) {
    if (!(STORED_RELATION_FIELDS as readonly string[]).includes(key)) return `field ${key} is not one of ${STORED_RELATION_FIELDS.join(", ")}`;
    const list: unknown = (value as { readonly [field: string]: unknown })[key];
    if (!Array.isArray(list) || list.length === 0 || list.length > RELATION_LIST_LIMIT) {
      return `${key} must be a non-empty list of at most ${String(RELATION_LIST_LIMIT)} work ids`;
    }
    let previous: string | null = null;
    for (const entry of list as readonly unknown[]) {
      if (!isWorkId(entry) || entry === id) return `${key} names an invalid target`;
      if (previous !== null && compareCanonicalText(previous, entry) >= 0) return `${key} must be sorted without repeats`;
      previous = entry;
    }
  }
  return null;
}

/**
 * Both directions of a record's relations. Forward is what the record stores (parent from its
 * parentId). Reverse is projected by one scan of the live records: who is blocked by it,
 * implements it, supersedes it or fixes it; and, asked of a minutes id, which records name it as
 * decided-in (decides). `missing` projects forward targets that are not live in this library; it
 * is recomputed on every read so a minutes record arriving later clears its missing marker without
 * changing the stored relation.
 */
export function workRelations(state: Pick<WorkspaceState, "work" | "minutes" | "conferenceMinutes">, id: string): WorkRelationsView {
  const record = state.work.find((entry) => entry.id === id);
  const stored = record === undefined ? {} : storedRelations(record);
  const reverse: { [name in ReverseRelationName]: string[] } = {
    "blocks": [], "implemented-by": [], "superseded-by": [], "fixed-by": [], "decides": [],
  };
  for (const other of state.work) {
    if (other.tombstone) continue;
    const relations = storedRelations(other);
    for (const { field, reverse: name } of STORED_RELATIONS) {
      if (relations[field]?.includes(id) === true) reverse[name].push(other.id);
    }
    if (decidedInOf(other).includes(id)) reverse.decides.push(other.id);
  }
  const sorted = (list: readonly string[]): readonly string[] => [...list].sort(compareCanonicalText);
  const forward = {
    parent: record?.parentId ?? null,
    blockedBy: stored.blockedBy ?? [],
    implements: stored.implements ?? [],
    supersedes: stored.supersedes ?? [],
    fixes: stored.fixes ?? [],
    decidedIn: record === undefined ? [] : decidedInOf(record),
  };
  const liveWork = new Set(state.work.filter((entry) => !entry.tombstone).map((entry) => entry.id));
  const liveMinutes = new Set([
    ...state.minutes.filter((entry) => !entry.tombstone).map((entry) => entry.id),
    ...state.conferenceMinutes.filter((entry) => !entry.tombstone).map((entry) => entry.id),
  ]);
  const workTargets = [
    ...(forward.parent === null ? [] : [forward.parent]),
    ...forward.blockedBy, ...forward.implements, ...forward.supersedes, ...forward.fixes,
  ];
  const missing = sorted([...new Set([
    ...workTargets.filter((target) => !liveWork.has(target)),
    ...forward.decidedIn.filter((target) => isMinutesId(target) && !liveMinutes.has(target)),
  ])]);
  return {
    forward,
    reverse: {
      blocks: sorted(reverse.blocks),
      implementedBy: sorted(reverse["implemented-by"]),
      supersededBy: sorted(reverse["superseded-by"]),
      fixedBy: sorted(reverse["fixed-by"]),
      decides: sorted(reverse.decides),
    },
    missing,
  };
}

/**
 * The ids X for which "X <name> <targetId>" holds, forward or reverse name alike: `blocked-by B`
 * is every live record blocked by B, `blocks B` is every record B is blocked by. For `decides`,
 * X is a minutes id, so a filter over work records keeps none. An unknown name is refused.
 */
export function relationFilter(state: Pick<WorkspaceState, "work">, name: string, targetId: string): ReadonlySet<string> {
  const matches = new Set<string>();
  const live = state.work.filter((record) => !record.tombstone);
  const target = state.work.find((record) => record.id === targetId);
  const forward = STORED_RELATIONS.find((entry) => entry.name === name);
  const backward = STORED_RELATIONS.find((entry) => entry.reverse === name);
  if (name === "parent") {
    for (const record of live) if (record.parentId === targetId) matches.add(record.id);
  } else if (name === "decided-in") {
    for (const record of live) if (decidedInOf(record).includes(targetId)) matches.add(record.id);
  } else if (name === "decides") {
    for (const minutesId of target === undefined ? [] : decidedInOf(target)) matches.add(minutesId);
  } else if (forward !== undefined) {
    for (const record of live) if (storedRelations(record)[forward.field]?.includes(targetId) === true) matches.add(record.id);
  } else if (backward !== undefined) {
    for (const id of target === undefined ? [] : storedRelations(target)[backward.field] ?? []) matches.add(id);
  } else {
    refuse(`relation ${name} is not one of ${[...RELATION_NAMES, ...REVERSE_RELATION_NAMES].join(", ")}`);
  }
  return matches;
}
