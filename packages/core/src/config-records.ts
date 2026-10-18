import { checkChainRecord } from "./chain-identity.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-478 R1 (MIN-227 D13; TCRN-CROSS-SUB-315): project-level configuration records.
// Four closed collections travel with a library as events, the way its settings do: the managed
// sections the engine writes into a project's files (STORY-478), the Command Spell rules
// (STORY-483), the custom variables (STORY-484) and the gate declarations (STORY-485). A record is
// set or removed by an event in this device's stream, and every device that merges the library
// replays those events in merge order (clock, then device id), so the later writer wins on every
// device. Removing a key the merged state no longer holds, because another device removed it
// first, is a rejected event: recorded, skipped, and never a failed read. An old-layout workspace
// has no such operation. After each write config/project.json projects the records beside the
// settings (library-config.ts); like the settings, no read trusts that projection.

import { ProtocolError, canonicalByteLength, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { buildEventPayload, writeAuthorizationExtras } from "./actor-attestation.js";
import type { WriteAuthorization } from "./actor-attestation.js";
import { checkProposalRecordValue } from "./config-proposals.js";
import { checkGateRecordValue } from "./gates-config.js";
import { checkManagedSectionRecordValue } from "./managed-sections.js";
import { checkRuleRecordValue } from "./rules.js";
import { checkVariableRecordValue } from "./variables.js";
import { checkLeaseRecordValue } from "./work-lease.js";
import { appendEvents, projectConfiguration } from "./workspace.js";
import type { MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";
import { projectLineage } from "./project-scope.js";

export const CONFIG_RECORD_SET_OPERATION = "config.record.set" as const;
export const CONFIG_RECORD_REMOVED_OPERATION = "config.record.removed" as const;

export const CONFIG_RECORD_REASON_CODES = Object.freeze([
  "CONFIG_RECORD_COLLECTION_UNKNOWN",
  "CONFIG_RECORD_EVENT_INVALID",
  "CONFIG_RECORD_KEY_INVALID",
  "CONFIG_RECORD_NOT_FOUND",
  "CONFIG_RECORD_VALUE_INVALID",
] as const);

export type ConfigRecordReasonCode = typeof CONFIG_RECORD_REASON_CODES[number];

export class ConfigRecordError extends Error {
  readonly reasonCode: ConfigRecordReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: ConfigRecordReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "ConfigRecordError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: ConfigRecordReasonCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new ConfigRecordError(reasonCode, message, details);
}

export type ConfigRecordCollection = "gate" | "managed-section" | "rule" | "variable" | "chain" | "lease" | "proposal";
export type ConfigRecordValue = Readonly<Record<string, JsonValue>>;

/** The check a collection adds on top of the shape every record meets. It throws to refuse. */
export type ConfigRecordValueCheck = (value: ConfigRecordValue, key: string) => void;

// A key names one record inside its collection: a managed section as `<file>#<section id>`, a rule
// by its id, a variable or a gate by its name. It is bounded and carries no control character.
export const CONFIG_RECORD_KEY_MAX_BYTES = RUNTIME_CAPACITY.bufferBytes;
// Every value is a JSON object that canonicalises to at most this many bytes.
export const CONFIG_RECORD_VALUE_MAX_BYTES = RUNTIME_CAPACITY.bufferBytes;

// The closed table: one row per collection. A collection outside it is refused on write and its
// events are rejected on replay. Each Story replaces its own row's check with the one for its
// values; the rows are kept apart so those changes do not touch one another.
const CONFIG_RECORD_VALUE_CHECKS: Readonly<Record<ConfigRecordCollection, ConfigRecordValueCheck>> = Object.freeze({
  // TCRN-CROSS-STORY-478: a managed section's file, id, revision, digest and state, keyed
  // <file>#<id> (SUB-316, managed-sections.ts).
  "managed-section": checkManagedSectionRecordValue,
  chain: checkChainRecord,

  // TCRN-CROSS-STORY-483: whether a Command Spell rule is enabled and the version it was enabled
  // at, keyed by the rule's id (SUB-336, rules.ts).
  rule: checkRuleRecordValue,

  // TCRN-CROSS-STORY-484: a custom variable's type, value and description, keyed by its name
  // (SUB-340, variables.ts).
  variable: checkVariableRecordValue,

  // TCRN-CROSS-STORY-485: a gate declaration, keyed by the gate's name (SUB-343, gates-config.ts).
  gate: checkGateRecordValue,

  // TCRN-CROSS-STORY-528 (MIN-256): a work lease, {holder, claimedAt, expiresAt}, keyed by the work
  // item's id and scoped to the item's project (SUB-456, work-lease.ts). config/project.json does
  // not show it.
  lease: checkLeaseRecordValue,

  // TCRN-CROSS-STORY-527 (MIN-257 D6, Q5; TCRN-CROSS-SUB-477): a change to a gate or a rule that waits
  // for Atelier, {kind, action, payload, status, proposedBy, proposedAt, rejectedBy?, rejectedAt?},
  // keyed gate:<name> or rule:<id> (config-proposals.ts). config/project.json does not show it.
  proposal: checkProposalRecordValue,
});

/** The collections of the closed table, sorted. */
export const CONFIG_RECORD_COLLECTIONS: readonly ConfigRecordCollection[] = Object.freeze(
  (Object.keys(CONFIG_RECORD_VALUE_CHECKS) as ConfigRecordCollection[]).sort(compareCanonicalText),
);

/** One project-level configuration record as the merged state holds it. */
export interface ConfigRecord {
  readonly collection: ConfigRecordCollection;
  readonly key: string;
  readonly projectId?: string;
  readonly value: ConfigRecordValue;
}

/** What one config.record.* event changes; a removal carries no value. */
export interface ConfigRecordChange {
  readonly collection: ConfigRecordCollection;
  readonly key: string;
  readonly projectId?: string;
  readonly value?: ConfigRecordValue;
}

export function isConfigRecordCollection(value: unknown): value is ConfigRecordCollection {
  return typeof value === "string" && Object.hasOwn(CONFIG_RECORD_VALUE_CHECKS, value);
}

export function isConfigRecordOperation(operation: string): boolean {
  return operation === CONFIG_RECORD_SET_OPERATION || operation === CONFIG_RECORD_REMOVED_OPERATION;
}

export function assertConfigRecordCollection(value: unknown): asserts value is ConfigRecordCollection {
  if (!isConfigRecordCollection(value)) {
    fail("CONFIG_RECORD_COLLECTION_UNKNOWN", `${String(value)} is not a configuration record collection`, {
      collection: String(value),
      known: CONFIG_RECORD_COLLECTIONS.join(","),
    });
  }
}

export function assertConfigRecordKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > CONFIG_RECORD_KEY_MAX_BYTES ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("CONFIG_RECORD_KEY_INVALID", `a configuration record key is 1 to ${CONFIG_RECORD_KEY_MAX_BYTES} bytes without surrounding space or control characters`, {
      key: typeof value === "string" ? value : String(value),
    });
  }
}

/**
 * The value a record of `collection` may hold: a JSON object that canonicalises within
 * CONFIG_RECORD_VALUE_MAX_BYTES and passes the collection's own check. Returns a detached copy.
 */
export function checkConfigRecordValue(collection: ConfigRecordCollection, key: string, value: unknown): ConfigRecordValue {
  const where = { collection, key };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CONFIG_RECORD_VALUE_INVALID", `the value of ${collection} ${key} is not a JSON object`, where);
  }
  let bytes: number;
  try {
    bytes = canonicalByteLength(value);
  } catch (error) {
    if (error instanceof ProtocolError) fail("CONFIG_RECORD_VALUE_INVALID", `the value of ${collection} ${key} is not canonical JSON: ${error.message}`, where);
    throw error;
  }
  if (bytes > CONFIG_RECORD_VALUE_MAX_BYTES) {
    fail("CONFIG_RECORD_VALUE_INVALID", `the value of ${collection} ${key} is ${bytes} bytes; the bound is ${CONFIG_RECORD_VALUE_MAX_BYTES}`, where);
  }
  const copy = JSON.parse(canonicalJson(value)) as ConfigRecordValue;
  try {
    CONFIG_RECORD_VALUE_CHECKS[collection](copy, key);
  } catch (error) {
    // A collection's own refusal, whatever module raised it, is this module's value refusal, so a
    // replay rejects the event instead of failing the read. It keeps its own code in refusedBy.
    const refusedBy = (error as { readonly reasonCode?: unknown }).reasonCode;
    if (error instanceof ConfigRecordError || typeof refusedBy !== "string") throw error;
    fail("CONFIG_RECORD_VALUE_INVALID", `the value of ${collection} ${key} is refused: ${refusedBy}: ${(error as Error).message}`, { ...where, refusedBy });
  }
  return copy;
}

/** The record of a config.record.set or config.record.removed event, checked. */
export function readConfigRecordEvent(operation: string, record: Readonly<Record<string, JsonValue>>): ConfigRecordChange {
  const expected = [...(operation === CONFIG_RECORD_SET_OPERATION ? ["collection", "key", "value"] : ["collection", "key"]), ...(Object.hasOwn(record, "projectId") ? ["projectId"] : [])].sort(compareCanonicalText);
  if (Object.hasOwn(record, "projectId") && (typeof record.projectId !== "string" || !/^project:[a-f0-9]{24}$/u.test(record.projectId))) fail("CONFIG_RECORD_EVENT_INVALID", "invalid project scope");
  if (record.collection === "chain" && ((record.key === "identity" && record.projectId !== undefined) || (record.key !== "identity" && record.projectId === undefined))) fail("CONFIG_RECORD_EVENT_INVALID", "invalid chain record scope");
  if (record.collection === "lease" && record.projectId === undefined) fail("CONFIG_RECORD_EVENT_INVALID", "a lease is scoped to its work item's project");
  const scope = typeof record.projectId === "string" ? { projectId: record.projectId } : {};
  const actual = Object.keys(record).sort(compareCanonicalText);
  if (!isConfigRecordOperation(operation) || actual.join(",") !== expected.join(",")) {
    fail("CONFIG_RECORD_EVENT_INVALID", `a ${operation} record holds exactly ${expected.join(", ")}`, { operation });
  }
  assertConfigRecordCollection(record.collection);
  assertConfigRecordKey(record.key);
  if (operation === CONFIG_RECORD_REMOVED_OPERATION) return { collection: record.collection, key: record.key, ...scope };
  return { collection: record.collection, key: record.key, value: checkConfigRecordValue(record.collection, record.key, record.value), ...scope };
}

/** The identity of a record in the merged state: its collection and key. */
export function configRecordIdentity(collection: string, key: string, projectId?: string): string {
  return JSON.stringify(projectId === undefined ? [collection, key] : [collection, key, projectId]);
}

/** The receipt id of a configuration record: its closed collection and key. */
export function configRecordId(collection: ConfigRecordCollection, key: string, projectId?: string): string {
  return projectId === undefined ? `${collection}:${key}` : `${collection}:${projectId}:${key}`;
}

export function sortConfigRecords(records: Iterable<ConfigRecord>): readonly ConfigRecord[] {
  return [...records].sort((left, right) => compareCanonicalText(left.projectId ?? "", right.projectId ?? "") || compareCanonicalText(left.collection, right.collection) || compareCanonicalText(left.key, right.key));
}

/** The records of one collection in a merged state, sorted by key. */
export function configRecords(state: Pick<WorkspaceState, "configRecords">, collection: string): readonly ConfigRecord[] {
  assertConfigRecordCollection(collection);
  return state.configRecords.filter((record) => record.collection === collection && ("configurationProjectId" in state || record.projectId === undefined));
}

/** One record of a merged state, or null when its key is not set. */
export function configRecord(state: Pick<WorkspaceState, "configRecords">, collection: string, key: string): ConfigRecord | null {
  assertConfigRecordCollection(collection);
  return configRecords(state, collection).find((record) => record.key === key) ?? null;
}

export interface ConfigRecordSetInput {
  readonly collection: string;
  readonly key: string;
  readonly projectId?: string;
  readonly value: unknown;
  // TCRN-CROSS-STORY-526 (TCRN-CROSS-SUB-452): how the write was let through, recorded in its event
  // beside the record (surface, decidedIn, decidedInLibraryId); left out, the event is as it was.
  readonly authorization?: WriteAuthorization;
}

export interface ConfigRecordRemoveInput {
  readonly collection: string;
  readonly key: string;
  readonly projectId?: string;
  readonly authorization?: WriteAuthorization;
}

/** The delta that sets one record, for appendEvents; the input is checked before any lock is taken. */
export function setConfigRecordDelta(input: ConfigRecordSetInput): (state: WorkspaceState) => MutationDelta {
  assertConfigRecordCollection(input.collection);
  assertConfigRecordKey(input.key);
  // Admission only: historical chain records retain their original replay validator.
  if (input.collection === "chain" && input.key === "identity" && typeof (input.value as Record<string, unknown> | null)?.role !== "string") fail("CONFIG_RECORD_VALUE_INVALID", "chain identity role must be a string");
  const record: ConfigRecord = { collection: input.collection, key: input.key, ...(input.projectId === undefined ? {} : { projectId: input.projectId }), value: checkConfigRecordValue(input.collection, input.key, input.value) };
  return (state) => {
    projectLineage(state, input.projectId);
    if (input.collection === "chain" && input.key === "identity" && "value" in input && typeof (input.value as Record<string, unknown>)?.primaryProjectId === "string") projectLineage(state, (input.value as Record<string, unknown>).primaryProjectId as string);
    if (input.collection === "chain" && input.key === "identity" && "value" in input && (input.value as Record<string, unknown>)?.role === "coordination" && (input.value as Record<string, unknown>)?.coordinationLibraryId !== state.metadata.workspaceId) fail("CONFIG_RECORD_VALUE_INVALID", "coordination identity must refer to this library");
    if (input.collection === "chain" && ((input.key === "identity" && input.projectId !== undefined) || (input.key !== "identity" && input.projectId === undefined))) fail("CONFIG_RECORD_VALUE_INVALID", "chain identity is library scoped; common defaults require an explicit project");
    if (input.collection === "lease" && input.projectId === undefined) fail("CONFIG_RECORD_VALUE_INVALID", "a lease is scoped to its work item's project");
    return {
    payload: buildEventPayload(CONFIG_RECORD_SET_OPERATION, { collection: record.collection, key: record.key, value: record.value, ...(record.projectId === undefined ? {} : { projectId: record.projectId }) }, undefined, writeAuthorizationExtras(input.authorization)),
    projects: state.projects,
    work: state.work,
    configRecords: sortConfigRecords([
      ...state.configRecords.filter((entry) => configRecordIdentity(entry.collection, entry.key, entry.projectId) !== configRecordIdentity(record.collection, record.key, record.projectId)),
      record,
    ]),
  };
  };
}

/** The delta that removes one record; a key the merged state does not hold is refused. */
export function removeConfigRecordDelta(input: ConfigRecordRemoveInput): (state: WorkspaceState) => MutationDelta {
  const collection = input.collection;
  const key = input.key;
  assertConfigRecordCollection(collection);
  assertConfigRecordKey(key);
  return (state) => {
    projectLineage(state, input.projectId);
    if (input.collection === "chain" && input.key === "identity" && "value" in input && typeof (input.value as Record<string, unknown>)?.primaryProjectId === "string") projectLineage(state, (input.value as Record<string, unknown>).primaryProjectId as string);
    if (input.collection === "chain" && input.key === "identity" && "value" in input && (input.value as Record<string, unknown>)?.role === "coordination" && (input.value as Record<string, unknown>)?.coordinationLibraryId !== state.metadata.workspaceId) fail("CONFIG_RECORD_VALUE_INVALID", "coordination identity must refer to this library");
    if (input.collection === "chain" && ((input.key === "identity" && input.projectId !== undefined) || (input.key !== "identity" && input.projectId === undefined))) fail("CONFIG_RECORD_VALUE_INVALID", "chain identity is library scoped; common defaults require an explicit project");
    if (!state.configRecords.some((entry) => entry.collection === collection && entry.key === key && entry.projectId === input.projectId)) {
      fail("CONFIG_RECORD_NOT_FOUND", `${collection} ${key} is not set`, { collection, key });
    }
    return {
      payload: buildEventPayload(CONFIG_RECORD_REMOVED_OPERATION, { collection, key, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) }, undefined, writeAuthorizationExtras(input.authorization)),
      projects: state.projects,
      work: state.work,
      configRecords: state.configRecords.filter((entry) => entry.collection !== collection || entry.key !== key || entry.projectId !== input.projectId),
    };
  };
}

/**
 * Set one record in a library: as this machine's only writer of it, against the latest merged
 * state, appended to this device's stream; then config/project.json shows the merged records.
 */
export async function setConfigRecord(workspaceRoot: string, input: ConfigRecordSetInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const delta = setConfigRecordDelta(input);
  // TCRN-CROSS-STORY-529 (TCRN-CROSS-SUB-481): only the append and the projection that follows it hold
  // the lock; the merged state is read and the delta built outside it.
  return appendEvents(workspaceRoot, [delta], input, (root, committed) => projectConfiguration(root, committed));
}

/** Remove one record from a library, the same way; a key the merged state does not hold is refused. */
export async function removeConfigRecord(workspaceRoot: string, input: ConfigRecordRemoveInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const delta = removeConfigRecordDelta(input);
  return appendEvents(workspaceRoot, [delta], input, (root, committed) => projectConfiguration(root, committed));
}
