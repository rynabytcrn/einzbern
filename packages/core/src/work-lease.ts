// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-528 (MIN-256; TCRN-CROSS-SUB-456): a work lease. An actor claims a work item for
// a while, and until the lease runs out another actor's transition or annotation of that item, or of
// anything under it, is refused with WORK_LEASED. Two sessions that pick the same Story no longer
// both write it.
//
// A lease is a project-level configuration record of the closed collection `lease`
// (config-records.ts): keyed by the work item's id, scoped to the item's project, holding
// {holder, claimedAt, expiresAt}. It travels with the library and merges like any other record, so
// every device sees the same lease; config/project.json does not show it (library-config.ts).
//
// Whether a lease has run out is judged against the instant of the write, --at: the engine reads no
// clock, so a replay and a retried write judge alike. Only the display (workLeaseView) takes the
// reader's present instant, and what it says is for reading only.
//
// The rules: a claim by the holder renews the lease; a claim is refused while another actor holds an
// unexpired lease on the item, on any item above it or on any item below it. The holder releases at
// any time; another actor needs force (Atelier only, decided at the CLI) while the lease runs, and
// a lease that has run out binds no one, so anyone may clear it.
//
// TCRN-CROSS-STORY-535 (MIN-257 D6): a lease does not outlive its item. Deleting a work item is not a
// write a lease guards, so any actor deletes a leased item, and its lease is removed in the same
// append (leaseRemovalDelta, SUB-475).

import { ProtocolError, assertProtocolId, parseStrictInstant } from "../../protocol/src/index.js";
import type { JsonValue, WorkRecord } from "../../protocol/src/index.js";
import { assertActorId } from "./actor-attestation.js";
import { removeConfigRecordDelta, setConfigRecordDelta } from "./config-records.js";
import type { ConfigRecord } from "./config-records.js";
import { WorkspaceError, appendEvents } from "./workspace.js";
import type { MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const WORK_LEASE_COLLECTION = "lease" as const;
// MIN-256 R1 Q5: --ttl is <n>m or <n>h, 2h when left out, from one minute to a day.
export const WORK_LEASE_TTL_DEFAULT = "2h" as const;
export const WORK_LEASE_TTL_MIN_MINUTES = 1;
export const WORK_LEASE_TTL_MAX_MINUTES = 24 * 60;

export const WORK_LEASE_REASON_CODES = Object.freeze([
  // Another actor holds an unexpired lease that binds the item; details name the holder, when the
  // lease runs out and the item it is held on.
  "WORK_LEASED",
  // A lease record that is not {holder, claimedAt, expiresAt} on a work id, within the TTL bounds.
  "WORK_LEASE_INVALID",
  // A release of an item that holds no lease.
  "WORK_LEASE_NOT_FOUND",
  "WORK_LEASE_TTL_INVALID",
] as const);

export type WorkLeaseReasonCode = typeof WORK_LEASE_REASON_CODES[number];

export class WorkLeaseError extends Error {
  readonly reasonCode: WorkLeaseReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: WorkLeaseReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "WorkLeaseError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: WorkLeaseReasonCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new WorkLeaseError(reasonCode, message, details);
}

/** A lease as its record holds it. */
export interface WorkLease {
  readonly holder: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

/** A lease and the work item it is held on. */
export interface HeldWorkLease extends WorkLease {
  readonly workId: string;
}

/** What a reader is shown of a work item's own lease: the record, and whether it runs at the reader's instant. */
export interface WorkLeaseView extends WorkLease {
  readonly active: boolean;
}

const NANOSECONDS_PER_MINUTE = 60_000_000_000n;
const LEASE_FIELDS = Object.freeze(["claimedAt", "expiresAt", "holder"]);

function instantOf(value: unknown, field: string): bigint {
  try {
    return parseStrictInstant(value);
  } catch (error) {
    if (error instanceof ProtocolError) fail("WORK_LEASE_INVALID", `${field} is not an instant: ${String(value)}`, { field });
    throw error;
  }
}

// An instant in UTC, seconds and as many fraction digits as it has, so a lease reads the same
// whatever offset the --at it was claimed with carried.
function instantText(nanoseconds: bigint): string {
  let whole = nanoseconds / 1_000_000_000n;
  let fraction = nanoseconds % 1_000_000_000n;
  if (fraction < 0n) {
    fraction += 1_000_000_000n;
    whole -= 1n;
  }
  const seconds = new Date(Number(whole) * 1000).toISOString().slice(0, 19);
  return fraction === 0n ? `${seconds}Z` : `${seconds}.${fraction.toString().padStart(9, "0").replace(/0+$/u, "")}Z`;
}

function isWorkId(value: string): boolean {
  try {
    assertProtocolId(value);
  } catch {
    return false;
  }
  return value.startsWith("work:");
}

/**
 * The value a lease record may hold, keyed by a work id: exactly {holder, claimedAt, expiresAt}, the
 * holder an actor id and the lease running from one minute to a day. config-records.ts runs it on
 * every write and every replay of the collection.
 */
export function checkLeaseRecordValue(value: Readonly<Record<string, JsonValue>>, key: string): void {
  if (!isWorkId(key)) fail("WORK_LEASE_INVALID", `a lease is keyed by a work id, not ${key}`, { key });
  if (Object.keys(value).sort().join(",") !== LEASE_FIELDS.join(",")) {
    fail("WORK_LEASE_INVALID", `a lease holds exactly ${LEASE_FIELDS.join(", ")}`, { key });
  }
  try {
    assertActorId(value.holder);
  } catch {
    fail("WORK_LEASE_INVALID", `the holder of a lease is an actor id, not ${String(value.holder)}`, { key });
  }
  const span = instantOf(value.expiresAt, "expiresAt") - instantOf(value.claimedAt, "claimedAt");
  if (span < BigInt(WORK_LEASE_TTL_MIN_MINUTES) * NANOSECONDS_PER_MINUTE || span > BigInt(WORK_LEASE_TTL_MAX_MINUTES) * NANOSECONDS_PER_MINUTE) {
    fail("WORK_LEASE_INVALID", "a lease runs from one minute to 24 hours after it is claimed", { key });
  }
}

/** The minutes a --ttl of `<n>m` or `<n>h` names, 2h when it is left out; refused outside 1m to 24h. */
export function parseLeaseTtl(text: string | undefined): number {
  const value = text ?? WORK_LEASE_TTL_DEFAULT;
  const match = /^([1-9][0-9]{0,4})([mh])$/u.exec(value);
  const minutes = match === null ? Number.NaN : Number(match[1]) * (match[2] === "h" ? 60 : 1);
  if (!(minutes >= WORK_LEASE_TTL_MIN_MINUTES && minutes <= WORK_LEASE_TTL_MAX_MINUTES)) {
    fail("WORK_LEASE_TTL_INVALID", `a lease lasts <n>m or <n>h, from 1m to 24h; ${value} is not one`, { ttl: value });
  }
  return minutes;
}

function leaseRecords(state: Pick<WorkspaceState, "configRecords">): readonly ConfigRecord[] {
  return state.configRecords.filter((record) => record.collection === WORK_LEASE_COLLECTION);
}

function heldLease(record: ConfigRecord): HeldWorkLease {
  return { workId: record.key, holder: String(record.value.holder), claimedAt: String(record.value.claimedAt), expiresAt: String(record.value.expiresAt) };
}

function runsAt(lease: WorkLease, at: bigint): boolean {
  return parseStrictInstant(lease.expiresAt) > at;
}

// The items above `id`, nearest first. A parent the state does not hold ends the walk, and so does
// a cycle, which a valid graph never has.
function ancestorsOf(parents: ReadonlyMap<string, string | null>, id: string): readonly string[] {
  const result: string[] = [];
  const seen = new Set([id]);
  let parent = parents.get(id) ?? null;
  while (parent !== null && !seen.has(parent)) {
    result.push(parent);
    seen.add(parent);
    parent = parents.get(parent) ?? null;
  }
  return result;
}

function parentsOf(work: readonly WorkRecord[]): ReadonlyMap<string, string | null> {
  return new Map(work.map((record) => [record.id, record.parentId]));
}

/** The lease a work item holds itself, as recorded, or null; a lease that has run out stays recorded until it is released or claimed over. */
export function workLease(state: Pick<WorkspaceState, "configRecords">, workId: string): HeldWorkLease | null {
  const record = leaseRecords(state).find((entry) => entry.key === workId);
  return record === undefined ? null : heldLease(record);
}

/**
 * The unexpired lease that binds `workId` at `at`: the item's own, else the nearest one above it;
 * null when none does. A lease below the item does not bind it.
 */
export function activeLease(state: Pick<WorkspaceState, "configRecords" | "work">, workId: string, at: string): HeldWorkLease | null {
  const leases = leaseRecords(state);
  if (leases.length === 0) return null;
  const instant = instantOf(at, "at");
  for (const id of [workId, ...ancestorsOf(parentsOf(state.work), workId)]) {
    const record = leases.find((entry) => entry.key === id);
    if (record !== undefined && runsAt(heldLease(record), instant)) return heldLease(record);
  }
  return null;
}

function leasedError(workId: string, lease: HeldWorkLease): WorkLeaseError {
  return new WorkLeaseError("WORK_LEASED", `work ${workId} is leased to ${lease.holder} until ${lease.expiresAt} (the lease is held on ${lease.workId})`, {
    workId,
    holder: lease.holder,
    expiresAt: lease.expiresAt,
    leasedWorkId: lease.workId,
  });
}

/**
 * Refuse a write to `workId` by `actorId` at `at` while another actor's unexpired lease binds the
 * item (WORK_LEASED). A write that names no actor is another actor's (MIN-256 R1 Q7).
 */
export function assertWorkLeaseAdmits(state: Pick<WorkspaceState, "configRecords" | "work">, workId: string, actorId: string | undefined, at: string): void {
  const lease = activeLease(state, workId, at);
  if (lease !== null && lease.holder !== actorId) throw leasedError(workId, lease);
}

// Another actor's unexpired lease on the item, on an item above it or on an item below it: the
// item's own first, then the nearest above, then those below by id.
function familyConflict(state: WorkspaceState, workId: string, actorId: string, at: bigint): HeldWorkLease | null {
  const foreign = leaseRecords(state).map(heldLease).filter((lease) => lease.holder !== actorId && runsAt(lease, at));
  if (foreign.length === 0) return null;
  const parents = parentsOf(state.work);
  const above = ancestorsOf(parents, workId);
  for (const id of [workId, ...above]) {
    const lease = foreign.find((entry) => entry.workId === id);
    if (lease !== undefined) return lease;
  }
  return foreign.find((lease) => ancestorsOf(parents, lease.workId).includes(workId)) ?? null;
}

export interface ClaimWorkInput {
  readonly id: string;
  readonly actorId: string;
  // `<n>m` or `<n>h`; 2h when left out.
  readonly ttl?: string;
  readonly occurredAt: string;
}

export interface ReleaseWorkInput {
  readonly id: string;
  readonly actorId: string;
  // Release another actor's running lease. The CLI lets only Atelier ask for it (MIN-256 R1 Q7).
  readonly force?: boolean;
  readonly occurredAt: string;
}

/** The delta that claims a work item for `actorId` from `occurredAt` for the TTL; the input is checked before any lock is taken. */
export function claimWorkDelta(input: ClaimWorkInput): (state: WorkspaceState) => MutationDelta {
  assertActorId(input.actorId);
  const minutes = parseLeaseTtl(input.ttl);
  const claimed = instantOf(input.occurredAt, "at");
  const value = {
    holder: input.actorId,
    claimedAt: instantText(claimed),
    expiresAt: instantText(claimed + BigInt(minutes) * NANOSECONDS_PER_MINUTE),
  };
  return (state) => {
    const work = state.work.find((entry) => entry.id === input.id);
    if (work === undefined || work.tombstone) throw new WorkspaceError("WORKSPACE_INPUT_INVALID", `work ${input.id} is unavailable`);
    const conflict = familyConflict(state, work.id, input.actorId, claimed);
    if (conflict !== null) throw leasedError(work.id, conflict);
    return setConfigRecordDelta({ collection: WORK_LEASE_COLLECTION, key: work.id, projectId: work.projectId, value })(state);
  };
}

// The config.record.removed delta of one lease record, in the scope it was recorded in.
function leaseRecordRemoval(record: ConfigRecord): (state: WorkspaceState) => MutationDelta {
  return removeConfigRecordDelta({ collection: WORK_LEASE_COLLECTION, key: record.key, ...(record.projectId === undefined ? {} : { projectId: record.projectId }) });
}

/** The delta that releases the lease a work item holds; the input is checked before any lock is taken. */
export function releaseWorkDelta(input: ReleaseWorkInput): (state: WorkspaceState) => MutationDelta {
  assertActorId(input.actorId);
  const at = instantOf(input.occurredAt, "at");
  return (state) => {
    const record = leaseRecords(state).find((entry) => entry.key === input.id);
    if (record === undefined) fail("WORK_LEASE_NOT_FOUND", `work ${input.id} holds no lease`, { workId: input.id });
    const lease = heldLease(record);
    if (lease.holder !== input.actorId && runsAt(lease, at) && input.force !== true) throw leasedError(input.id, lease);
    return leaseRecordRemoval(record)(state);
  };
}

/**
 * TCRN-CROSS-STORY-535 (TCRN-CROSS-SUB-475): the delta that removes the lease `workId` holds -- the
 * record workLease reads -- for the write that deletes the item, appended just before its
 * work.deleted event; null when the item holds none, so such a delete stays one event. Whoever
 * holds the lease and whether it still runs make no difference.
 */
export function leaseRemovalDelta(state: Pick<WorkspaceState, "configRecords">, workId: string): ((state: WorkspaceState) => MutationDelta) | null {
  const record = leaseRecords(state).find((entry) => entry.key === workId);
  return record === undefined ? null : leaseRecordRemoval(record);
}

/** Claim a work item, or renew the claim its holder has: one event in this device's stream. */
export async function claimWork(workspaceRoot: string, input: ClaimWorkInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvents(workspaceRoot, [claimWorkDelta(input)], input);
}

/** Release the lease a work item holds: one event in this device's stream. */
export async function releaseWork(workspaceRoot: string, input: ReleaseWorkInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvents(workspaceRoot, [releaseWorkDelta(input)], input);
}

/**
 * What work-show, work-list and Atelier show of a work item's own lease: the record and whether it
 * still runs at `now`, the reader's present instant. That flag is for reading only; a write judges
 * a lease by its own --at (MIN-256 R1 Q6).
 */
export function workLeaseView(state: Pick<WorkspaceState, "configRecords">, workId: string, now: string): WorkLeaseView | null {
  const lease = workLease(state, workId);
  if (lease === null) return null;
  return { holder: lease.holder, claimedAt: lease.claimedAt, expiresAt: lease.expiresAt, active: runsAt(lease, instantOf(now, "now")) };
}
