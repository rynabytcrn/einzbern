// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-526 (MIN-256; TCRN-CROSS-SUB-451): a configuration write the model barrier
// refuses goes through when it cites an Owner decision by its number, minutes:<id>#D<n>. The decision
// must exist, in the library written to or, when that library does not hold the minutes, in the
// coordination library its chain identity names, opened read-only through this device's registry;
// its minutes must name owner:governance among those who decided; it must be valid, since an obsolete
// decision (superseded or withdrawn) authorizes nothing; and its text must name the target: the name
// itself, with no name character on either side (so engine:test is not named by engine:test-wiring),
// or <prefix>.* for a target under <prefix>. (so models.escalation.* names models.escalation.ceiling
// but not models.tiers). Any other answer is MODEL_WRITE_AUTHORIZATION_INVALID with the decision, the
// target and the reason.
//
// The check makes a write traceable to a decision. It does not prove the Owner took it: a model can
// record minutes whose deciders name owner:governance and cite them. MIN-256 D4 accepts that boundary.

import { chainIdentity } from "./chain-identity.js";
import { decisionAddress, minutesById, parseDecisionAddress } from "./minutes.js";
import type { DecisionReference, MinutesViewEntry } from "./minutes.js";
import { readRegistry } from "./registry.js";
import { materializeWorkspaceFromGenesis } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";

export const WRITE_AUTHORIZATION_INVALID = "MODEL_WRITE_AUTHORIZATION_INVALID" as const;
/** The decider whose decision authorizes a write the model barrier refuses. */
export const WRITE_AUTHORIZATION_DECIDER = "owner:governance" as const;
/** How a decision is cited: its minutes id and its number in the record. */
export const DECIDED_IN_VALUE_SHAPE = "minutes:<id>#D<n>" as const;

export const WRITE_AUTHORIZATION_REASONS = Object.freeze([
  "malformed",
  "not-found",
  "not-owner-decided",
  "obsolete",
  "target-not-named",
] as const);
export type WriteAuthorizationReason = typeof WRITE_AUTHORIZATION_REASONS[number];

export interface WriteAuthorizationErrorDetails {
  readonly decidedIn: string;
  readonly target: string;
  readonly reason: WriteAuthorizationReason;
}

export class WriteAuthorizationError extends Error {
  readonly reasonCode = WRITE_AUTHORIZATION_INVALID;
  readonly details: WriteAuthorizationErrorDetails;

  constructor(message: string, details: WriteAuthorizationErrorDetails) {
    super(message);
    this.name = "WriteAuthorizationError";
    this.details = details;
  }
}

// The reason is in the text as well as in the details, since the CLI entry prints only some details on
// stderr (TCRN-CROSS-SUB-455: the Wiki tells a reader to look for it there).
function refuse(decidedIn: string, target: string, reason: WriteAuthorizationReason, message: string): never {
  throw new WriteAuthorizationError(`${decidedIn} does not authorize ${target} (${reason}): ${message}`, { decidedIn, target, reason });
}

/** The decision a --decided-in value cites; MODEL_WRITE_AUTHORIZATION_INVALID (malformed) when it is not a decision number. */
export function parseDecidedIn(decidedIn: string, target: string): DecisionReference {
  const reference = parseDecisionAddress(decidedIn);
  if (reference === null) refuse(decidedIn, target, "malformed", `a decision is cited as ${DECIDED_IN_VALUE_SHAPE}`);
  return reference;
}

// A character a name can hold: the target is named only where none stands on either side of it.
const NAME_CHARACTER = /[A-Za-z0-9._:-]/u;
// <prefix>.*, with no name character before the prefix or after the star.
const PREFIX_WILDCARD = /(?<![A-Za-z0-9._:*-])([A-Za-z0-9._:-]+)\.\*(?![A-Za-z0-9._:*-])/gu;

/** Whether `text` names `target`: the name itself, bounded, or <prefix>.* for a target under <prefix>. */
export function decisionNamesTarget(text: string, target: string): boolean {
  if (target === "") return false;
  for (let index = text.indexOf(target); index !== -1; index = text.indexOf(target, index + 1)) {
    const before = index === 0 ? "" : text.charAt(index - 1);
    const after = text.charAt(index + target.length);
    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
  }
  for (const match of text.matchAll(PREFIX_WILDCARD)) {
    const prefix = match[1] ?? "";
    if (prefix !== "" && target.startsWith(`${prefix}.`) && target.length > prefix.length + 1) return true;
  }
  return false;
}

type MinutesState = Pick<WorkspaceState, "minutes" | "conferenceMinutes" | "conferences">;

export interface VerifyWriteAuthorizationInput {
  // The library the write goes to, as read inside its write lock.
  readonly state: MinutesState & Pick<WorkspaceState, "configRecords" | "metadata">;
  // The --decided-in value: minutes:<id>#D<n>.
  readonly decidedIn: string;
  // What the write changes: a gate's name, a rule's id, a setting's key or a variable's name.
  readonly target: string;
  // The device directory whose registry locates the coordination library; this device's by default.
  readonly home?: string;
}

/** A write's authorization, checked: the decision it cites and the library whose minutes hold it. */
export interface VerifiedWriteAuthorization {
  readonly decidedIn: string;
  readonly libraryId: string;
  readonly target: string;
}

function holdsMinutes(state: MinutesState, minutesId: string): boolean {
  return state.minutes.some((record) => record.id === minutesId && !record.tombstone) ||
    state.conferenceMinutes.some((record) => record.id === minutesId && !record.tombstone);
}

// The coordination library the written library's chain identity names, read from genesis (no cache
// is written) at a location this device's registry gives for it; null when the written library is
// unclassified or is the coordination library itself, or no registered location of it opens.
async function coordinationState(state: VerifyWriteAuthorizationInput["state"], home: string | undefined): Promise<WorkspaceState | null> {
  const identity = chainIdentity(state);
  if (identity === null || identity.coordinationLibraryId === state.metadata.workspaceId) return null;
  const paths = [...new Set((await readRegistry(home)).entries
    .filter((entry) => entry.libraryId === identity.coordinationLibraryId)
    .map((entry) => entry.libraryPath))];
  for (const path of paths) {
    try {
      const coordination = await materializeWorkspaceFromGenesis(path);
      if (coordination.metadata.workspaceId === identity.coordinationLibraryId) return coordination;
    } catch {
      // A registered location that does not open is passed over; the next one may.
    }
  }
  return null;
}

/**
 * Check that the decision `decidedIn` authorizes a write of `target` (TCRN-CROSS-SUB-451): it is
 * found, decided with owner:governance, valid, and names the target. Answers the decision and the
 * library whose minutes hold it; refuses with MODEL_WRITE_AUTHORIZATION_INVALID otherwise.
 */
export async function verifyWriteAuthorization(input: VerifyWriteAuthorizationInput): Promise<VerifiedWriteAuthorization> {
  const { decidedIn, target } = input;
  const reference = parseDecidedIn(decidedIn, target);
  let source: { readonly state: MinutesState; readonly libraryId: string } | null = holdsMinutes(input.state, reference.minutesId)
    ? { state: input.state, libraryId: input.state.metadata.workspaceId }
    : null;
  if (source === null) {
    const coordination = await coordinationState(input.state, input.home);
    if (coordination !== null && holdsMinutes(coordination, reference.minutesId)) source = { state: coordination, libraryId: coordination.metadata.workspaceId };
  }
  if (source === null) refuse(decidedIn, target, "not-found", `no minutes ${reference.minutesId} in this library or the coordination library it names`);
  let entry: MinutesViewEntry;
  try {
    entry = minutesById(source.state, decisionAddress(reference.minutesId, reference.number));
  } catch (error) {
    if ((error as { readonly reasonCode?: unknown }).reasonCode === "MINUTES_NOT_FOUND") {
      refuse(decidedIn, target, "not-found", `the minutes ${reference.minutesId} have no decision D${String(reference.number)}`);
    }
    throw error;
  }
  const decision = entry.decisions[0];
  if (decision === undefined) refuse(decidedIn, target, "not-found", `the minutes ${reference.minutesId} have no decision D${String(reference.number)}`);
  if (!entry.decidedBy.includes(WRITE_AUTHORIZATION_DECIDER)) {
    refuse(decidedIn, target, "not-owner-decided", `its minutes were not decided by ${WRITE_AUTHORIZATION_DECIDER}`);
  }
  if (decision.status === "obsolete") refuse(decidedIn, target, "obsolete", "the decision is obsolete; only a valid decision authorizes a write");
  if (!decisionNamesTarget(decision.text, target)) {
    refuse(decidedIn, target, "target-not-named", `the decision does not name ${target}, or a <prefix>.* it falls under`);
  }
  return { decidedIn: decisionAddress(reference.minutesId, reference.number), libraryId: source.libraryId, target };
}
