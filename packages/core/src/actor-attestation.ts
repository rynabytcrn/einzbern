// SPDX-License-Identifier: Apache-2.0

// WSE-1: the actor-attestation contract (SDC-2). Shared constants and validators
// that workspace.ts and the WS-D event operations reuse so actor identity is
// carried and enforced through one payload constructor. This module defines the
// contract only; WSE-2/WSE-3 enforce it. No new dependencies.

import type { JsonValue } from "../../protocol/src/index.js";
import { assertProtocolId, assertStrictInstant } from "../../protocol/src/index.js";
import { parseDecisionAddress } from "./minutes.js";

export const ACTOR_ATTESTATION_SCHEMA_VERSION = "tcrn.actor-attestation.v1" as const;
export const ACTOR_ATTESTATION_ENABLE_OPERATION = "attestation.actor.enabled" as const;
export const ACTOR_ATTESTATION_REGISTRATION_ID = "extension:actor-attestation-v1" as const;
export const ACTOR_PREFIXES = Object.freeze(["owner", "profile", "agent"] as const);

export const ACTOR_ATTESTATION_REASON_CODES = Object.freeze([
  "ACTOR_ATTESTATION_INVALID",
  "ACTOR_ID_INVALID",
  "EVENT_PAYLOAD_EXTRA_INVALID",
] as const);
export type ActorAttestationReasonCode = typeof ACTOR_ATTESTATION_REASON_CODES[number];

export class ActorAttestationError extends Error {
  readonly reasonCode: ActorAttestationReasonCode;
  constructor(reasonCode: ActorAttestationReasonCode, detail: string) {
    super(`${reasonCode}: ${detail}`);
    this.name = "ActorAttestationError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ActorAttestationReasonCode, detail: string): never {
  throw new ActorAttestationError(reasonCode, detail);
}

// An actor id is a protocol stableId whose prefix is one of the allowlist
// {owner, profile, agent} (owner: reuses the knowledge-core accountable-owner
// convention). Any other prefix, uppercase, or non-stableId input fails closed.
export function assertActorId(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    fail("ACTOR_ID_INVALID", String(value));
  }
  const colon = value.indexOf(":");
  const prefix = colon === -1 ? "" : value.slice(0, colon);
  if (!ACTOR_PREFIXES.includes(prefix as typeof ACTOR_PREFIXES[number])) {
    fail("ACTOR_ID_INVALID", value);
  }
  try {
    assertProtocolId(value);
  } catch {
    fail("ACTOR_ID_INVALID", value);
  }
}

// WSD-1 (SDC-2): the registered per-operation extras table. An event payload may
// carry a top-level key beyond {operation, record, actor} ONLY when this table
// registers that key for the payload's operation, and a registered operation MUST
// carry exactly its registered extras — never an ad-hoc shape. conference.closed
// carries the closing minutes so a close is one atomic event.
export const EVENT_PAYLOAD_OPERATION_EXTRAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "conference.closed": Object.freeze(["minutes"]),
});

// TCRN-CROSS-STORY-526 (MIN-256; TCRN-CROSS-SUB-452): the optional per-operation extras. A
// configuration write may record how it was let through: the surface it came from (`surface`, cli
// or atelier) and the Owner decision it cites (`decidedIn`, minutes:<id>#D<n>, with
// `decidedInLibraryId`, the library whose minutes hold that decision; the two travel together). A
// payload may carry any of them for the operations this table names and none for any other; an event
// written without them is byte for byte what it was before.
// TCRN-CROSS-STORY-541 (MIN-258 D3; TCRN-CROSS-SUB-510): gate.updated may carry them too, since
// work-gate-release, which appends it to release a gate, takes --decided-in; an engine that
// predates this rejects such an event on replay.
export const WRITE_SURFACES = Object.freeze(["atelier", "cli"] as const);
export type WriteSurface = typeof WRITE_SURFACES[number];
export const WRITE_AUTHORIZATION_EXTRAS = Object.freeze(["decidedIn", "decidedInLibraryId", "surface"] as const);
export const EVENT_PAYLOAD_OPTIONAL_EXTRAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "config.record.set": WRITE_AUTHORIZATION_EXTRAS,
  "config.record.removed": WRITE_AUTHORIZATION_EXTRAS,
  "gate.updated": WRITE_AUTHORIZATION_EXTRAS,
  "settings.updated": WRITE_AUTHORIZATION_EXTRAS,
  "settings.removed": WRITE_AUTHORIZATION_EXTRAS,
});

/** How a configuration write was let through, as its event records it (TCRN-CROSS-SUB-452). */
export interface WriteAuthorization {
  readonly surface?: WriteSurface;
  readonly decidedIn?: string;
  readonly decidedInLibraryId?: string;
}

const LIBRARY_ID = /^(library|workspace):[a-f0-9]{24}$/u;

// TCRN-CROSS-STORY-527 (Q5; TCRN-CROSS-SUB-477): the decision Atelier's approval of a pending proposal
// cites is the proposal itself, proposal:<key of the proposal record>@<the instant it was proposed>
// (config-proposals.ts), in this library and from surface atelier. An engine that predates the value
// rejects such an event on replay and skips it.
const PROPOSAL_DECISION = /^proposal:((?:gate|rule):[^\s@]+)@([^\s@]+)$/u;

/** The decidedIn of the approval of the proposal recorded under `key` at `proposedAt`. */
export function proposalDecision(key: string, proposedAt: string): string {
  return `proposal:${key}@${proposedAt}`;
}

/** The proposal a decidedIn of the form proposal:<key>@<proposedAt> names, or null for any other value. */
export function parseProposalDecision(value: unknown): { readonly key: string; readonly proposedAt: string } | null {
  if (typeof value !== "string") return null;
  const match = PROPOSAL_DECISION.exec(value);
  if (match === null) return null;
  try {
    assertStrictInstant(match[2]);
  } catch {
    return null;
  }
  return { key: match[1]!, proposedAt: match[2]! };
}

/** The payload extras a write's authorization adds: none when there is none. */
export function writeAuthorizationExtras(authorization: WriteAuthorization | undefined): Readonly<Record<string, JsonValue>> {
  if (authorization === undefined) return {};
  return {
    ...(authorization.decidedIn === undefined ? {} : { decidedIn: authorization.decidedIn }),
    ...(authorization.decidedInLibraryId === undefined ? {} : { decidedInLibraryId: authorization.decidedInLibraryId }),
    ...(authorization.surface === undefined ? {} : { surface: authorization.surface }),
  };
}

/**
 * What is wrong with the authorization extras `fields` holds, or null when they are well formed:
 * surface is cli or atelier, decidedIn is a decision number and decidedInLibraryId a library id, and
 * the last two come together. The write path and replay ask the same question.
 *
 * TCRN-CROSS-STORY-527 (Q5): decidedIn may also name a proposal Atelier approved,
 * proposal:<key>@<proposedAt>, which is recorded with surface atelier.
 */
export function writeAuthorizationProblem(fields: Readonly<Record<string, unknown>>): string | null {
  const present = (key: string): boolean => Object.hasOwn(fields, key);
  if (present("surface") && !WRITE_SURFACES.includes(fields.surface as WriteSurface)) return "surface is cli or atelier";
  if (present("decidedIn") !== present("decidedInLibraryId")) return "decidedIn and decidedInLibraryId are recorded together";
  const proposal = present("decidedIn") ? parseProposalDecision(fields.decidedIn) : null;
  if (present("decidedIn") && proposal === null && parseDecisionAddress(fields.decidedIn) === null) {
    return "decidedIn is a decision number, minutes:<id>#D<n>, or an approved proposal, proposal:<key>@<proposedAt>";
  }
  if (proposal !== null && fields.surface !== "atelier") return "a proposal's approval is recorded with surface atelier";
  if (present("decidedInLibraryId") && (typeof fields.decidedInLibraryId !== "string" || !LIBRARY_ID.test(fields.decidedInLibraryId))) {
    return "decidedInLibraryId is a library id";
  }
  return null;
}

const reservedPayloadKeys = new Set(["operation", "record", "actor"]);

// The single event-payload constructor WS-D operations must reuse: {operation,
// record} before attestation is enabled, {operation, record, actor} after, plus
// exactly the extras the table above registers for the operation and any of the
// optional extras the second table allows it. The actor, when present, is
// validated here so no operation can bypass it.
export function buildEventPayload(operation: string, record: JsonValue, actor?: string, extras?: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const registered = EVENT_PAYLOAD_OPERATION_EXTRAS[operation] ?? [];
  const optional = EVENT_PAYLOAD_OPTIONAL_EXTRAS[operation] ?? [];
  const supplied = Object.keys(extras ?? {}).filter((key) => !optional.includes(key)).sort();
  if (JSON.stringify(supplied) !== JSON.stringify([...registered].sort())) {
    fail("EVENT_PAYLOAD_EXTRA_INVALID", `${operation} extras must be exactly [${registered.join(",")}]`);
  }
  const payload: Record<string, JsonValue> = { operation, record };
  for (const key of registered) {
    const value = extras?.[key];
    if (reservedPayloadKeys.has(key) || value === undefined) {
      fail("EVENT_PAYLOAD_EXTRA_INVALID", `${operation} extra ${key} is invalid`);
    }
    payload[key] = value;
  }
  const chosen: Record<string, JsonValue> = {};
  for (const key of optional) {
    const value = extras?.[key];
    if (value !== undefined) chosen[key] = value;
  }
  const problem = writeAuthorizationProblem(chosen);
  if (problem !== null) fail("EVENT_PAYLOAD_EXTRA_INVALID", `${operation} ${problem}`);
  Object.assign(payload, chosen);
  if (actor === undefined) {
    return payload;
  }
  assertActorId(actor);
  payload.actor = actor;
  return payload;
}

// The enable event's record: {schemaVersion, version:1}. Appending it through the
// event log turns on mandatory actor attestation for every later event.
export function buildActorAttestationEnableRecord(): Readonly<Record<string, JsonValue>> {
  return { schemaVersion: ACTOR_ATTESTATION_SCHEMA_VERSION, version: 1 };
}

export function validateActorAttestationEnableRecord(value: unknown): asserts value is Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ACTOR_ATTESTATION_INVALID", "enable record must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "schemaVersion" || keys[1] !== "version" ||
    record.schemaVersion !== ACTOR_ATTESTATION_SCHEMA_VERSION || record.version !== 1) {
    fail("ACTOR_ATTESTATION_INVALID", "enable record shape");
  }
}

// The extension-registration-v1 record for this extension, event-scoped and
// off-by-default. schemaDigest is supplied by the caller (the sha256 of
// schemas/actor-attestation-v1.schema.json) so it never drifts from the file.
export function buildActorAttestationRegistration(schemaDigest: string): Readonly<Record<string, JsonValue>> {
  return {
    schemaVersion: "tcrn.extension-registration.v1",
    id: ACTOR_ATTESTATION_REGISTRATION_ID,
    version: 1,
    requiredByDefault: false,
    appliesTo: ["event"],
    schemaDigest,
  };
}
