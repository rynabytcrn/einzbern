import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-475 R1-R3 (MIN-227 D9, D10): a decision is written down, not deliberated into
// existence. One minutes.recorded event carries a whole record -- title, summary, decisions,
// the participants who decided and the work it bears on -- where a conference took an open, a
// position per participant and a close. Decision n of a record is Dn (its list index plus one),
// so "<minutes id> Dn" names one decision anywhere.
//
// The minutes a conference close wrote stay exactly as they were and are read beside the new
// ones: minutesView merges both into one read-only list, a historical record titled by its
// conference. Their records keep the tcrn.* schema; a new one is einzbern.minutes.v1.
//
// TCRN-CROSS-SUB-426 (MIN-239 D3, D5, D6): a decision is valid or obsolete, one decision at a time.
// Its number is minutes:<id>#D<n>, the historical minutes' decisions included. A decision becomes
// obsolete only when minutes are recorded that say so in the same write: the record's
// `declarations` name the decisions it supersedes (and the decision that supersedes each, one of its
// own or one already recorded) and the decisions it withdraws, which leave no successor. Obsolete is
// final. A record whose decision is close in topic to a valid decision is refused unless it
// supersedes, withdraws or declares that it stands beside that decision (`coexists`). Reads give the
// valid decisions unless asked for the obsolete ones, and an obsolete decision is read with the
// decision that superseded it.
//
// TCRN-CROSS-SUB-486 (TCRN-CROSS-STORY-531, MIN-256 D6 C5): only a close decision of the record's own
// INIT family, or of a family either side cannot name, refuses it. A close decision of another family
// -- the work the record links and the work that decision's minutes link lead to different Initiatives
// (work-family.ts) -- is written into the record's `coexists` as the writer's own declaration would be,
// and the minutes-record receipt warns of it.

import { assertProtocolId, canonicalExternalKey, compareCanonicalText, deriveStableId, parseStrictInstant } from "../../protocol/src/index.js";
import type { ConferenceMinutes } from "./conference.js";
import { recallTextTokens } from "./recall.js";
import { familiesApart, referenceFamilies } from "./work-family.js";
import type { WorkFamilyState } from "./work-family.js";
import type { WorkspaceState } from "./workspace.js";

export const MINUTES_RECORD_VERSION = "einzbern.minutes.v1" as const;
export const MINUTES_RECORDED_OPERATION = "minutes.recorded" as const;

/** At most this many decisions in one record, and at most this many participants and linked records. */
export const MINUTES_DECISIONS_LIMIT = RUNTIME_CAPACITY.arrayEntries;
const MINUTES_LIST_LIMIT = RUNTIME_CAPACITY.arrayEntries;
const MINUTES_TITLE_BYTES = RUNTIME_CAPACITY.bufferBytes;
const MINUTES_TEXT_BYTES = RUNTIME_CAPACITY.bufferBytes;

export const MINUTES_REASON_CODES = Object.freeze([
  "MINUTES_DECISION_OBSOLETE",
  "MINUTES_EXTERNAL_KEY_REQUIRED",
  "MINUTES_NOT_FOUND",
  "MINUTES_POSSIBLE_CONFLICT",
  "MINUTES_RECORD_INVALID",
] as const);
export type MinutesReasonCode = typeof MINUTES_REASON_CODES[number];

export class MinutesError extends Error {
  readonly reasonCode: MinutesReasonCode;
  // TCRN-CROSS-SUB-426: a topic refusal names its candidate decisions under `conflicts` and the way
  // out under `remedy`, the two keys the CLI entry prints beside the code.
  readonly details: Readonly<Record<string, string | readonly string[]>> | undefined;
  constructor(reasonCode: MinutesReasonCode, message: string, details?: Readonly<Record<string, string | readonly string[]>>) {
    super(message);
    this.name = "MinutesError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: MinutesReasonCode, message: string, details?: Readonly<Record<string, string | readonly string[]>>): never {
  throw new MinutesError(reasonCode, message, details);
}

/** One supersession a record declares: `decision` is obsolete from then on, superseded by `by`. */
export interface MinutesSupersession {
  readonly decision: string;
  readonly by: string;
}

/**
 * What a record declares about decisions already recorded (TCRN-CROSS-SUB-426): the ones it
 * supersedes, each with the decision that supersedes it (one of this record's or a valid one already
 * recorded); the ones it withdraws, which leave no successor; and the valid ones it stands beside
 * although close in topic. Every entry is a decision number, minutes:<id>#D<n>; each list is sorted
 * (supersedes by `decision`) and has no repeats.
 */
export interface MinutesDeclarations {
  readonly supersedes: readonly MinutesSupersession[];
  readonly withdraws: readonly string[];
  readonly coexists: readonly string[];
}

export interface MinutesRecord {
  readonly schemaVersion: typeof MINUTES_RECORD_VERSION;
  readonly id: string;
  readonly externalKey: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly decidedBy: readonly string[];
  readonly linkedWorkIds: readonly string[];
  readonly recordedAt: string;
  readonly revision: number;
  readonly tombstone: boolean;
  // TCRN-CROSS-SUB-426: present only on a record that declares something.
  readonly declarations?: MinutesDeclarations;
}

/** A decision's state (TCRN-CROSS-SUB-426, MIN-239 D3): valid, or obsolete for good. */
export type DecisionStatus = "valid" | "obsolete";

/** Which decisions a read gives: the valid ones (the default), the obsolete ones, or all of them. */
export type DecisionStatusFilter = "valid" | "obsolete" | "all";
export const DECISION_STATUS_FILTERS: readonly DecisionStatusFilter[] = Object.freeze(["valid", "obsolete", "all"]);

/** The decision that superseded an obsolete one, as a read shows it beside it. */
export interface MinutesDecisionSuccessor {
  readonly decision: string;
  readonly text: string;
  readonly status: DecisionStatus;
}

/**
 * One decision, numbered from 1 within its record. A read of the valid decisions gives `number`
 * and `text`, and `supersedes` when the decision superseded others. A read that asks for the
 * obsolete ones (or names the decision) gives every decision its `status`, and an obsolete one the
 * decision that superseded it (`supersededBy`, null when it was withdrawn) and the minutes that
 * declared it obsolete (`declaredIn`).
 */
export interface MinutesDecision {
  readonly number: number;
  readonly text: string;
  readonly status?: DecisionStatus;
  readonly supersedes?: readonly string[];
  readonly supersededBy?: MinutesDecisionSuccessor | null;
  readonly declaredIn?: string;
}

/** A record as the read verbs list it: new minutes and a conference's historical minutes alike. */
export interface MinutesViewEntry {
  readonly id: string;
  // Null for historical minutes: a conference close stored only the id derived from the key.
  readonly externalKey: string | null;
  readonly kind: "minutes" | "conference-minutes";
  readonly projectId: string;
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly MinutesDecision[];
  readonly decidedBy: readonly string[];
  readonly linkedWorkIds: readonly string[];
  readonly recordedAt: string;
  // TCRN-CROSS-SUB-426: what the record declared, when it declared anything, and -- in a read of the
  // valid decisions -- the numbers of its obsolete decisions that read leaves out, when there are any.
  readonly declarations?: MinutesDeclarations;
  readonly withheldDecisions?: readonly number[];
}

const RECORD_FIELDS = ["schemaVersion", "id", "externalKey", "projectId", "title", "summary", "decisions", "decidedBy", "linkedWorkIds", "recordedAt", "revision", "tombstone"];
const DECLARATION_FIELDS = ["coexists", "supersedes", "withdraws"];
const SUPERSESSION_FIELDS = ["by", "decision"];

/** A decision's number: its minutes id and its place in the record, minutes:<id>#D<n>. */
export const DECISION_ADDRESS_PATTERN = /^(minutes:[a-z0-9][a-z0-9._-]*)#D([1-9][0-9]*)$/u;

/** One decision named by its number. */
export interface DecisionReference {
  readonly minutesId: string;
  readonly number: number;
}

/** The number of decision `number` of the minutes `minutesId`. */
export function decisionAddress(minutesId: string, number: number): string {
  return `${minutesId}#D${String(number)}`;
}

/** The minutes id and number a decision number names, or null when the value is not one. */
export function parseDecisionAddress(value: unknown): DecisionReference | null {
  if (typeof value !== "string") return null;
  const match = DECISION_ADDRESS_PATTERN.exec(value);
  if (match === null) return null;
  try {
    assertProtocolId(match[1]);
  } catch {
    return null;
  }
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { minutesId: match[1] ?? "", number };
}

function text(value: unknown, label: string, budget: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || !value.isWellFormed() || value.includes("\u0000")) {
    fail("MINUTES_RECORD_INVALID", `${label} must be non-empty text`);
  }
  if (Buffer.byteLength(value, "utf8") > budget) fail("MINUTES_RECORD_INVALID", `${label} exceeds ${String(budget)} bytes`);
  return value;
}

function ids(value: unknown, label: string, namespace: string | null): readonly string[] {
  if (!Array.isArray(value) || value.length > MINUTES_LIST_LIMIT) fail("MINUTES_RECORD_INVALID", `${label} must be a list of at most ${String(MINUTES_LIST_LIMIT)} ids`);
  const list = value as readonly unknown[];
  for (const entry of list) {
    try {
      assertProtocolId(entry);
    } catch {
      fail("MINUTES_RECORD_INVALID", `${label} holds ${String(entry)}, which is not an id`);
    }
    if (namespace !== null && !(entry as string).startsWith(`${namespace}:`)) fail("MINUTES_RECORD_INVALID", `${label} holds ${String(entry)}, which is not a ${namespace} id`);
  }
  if (new Set(list).size !== list.length) fail("MINUTES_RECORD_INVALID", `${label} repeats an id`);
  return [...(list as readonly string[])];
}

function exactFields(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MINUTES_RECORD_INVALID", `${label} is an object`);
  const document = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(document).sort(compareCanonicalText);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) {
    fail("MINUTES_RECORD_INVALID", `${label} has exactly the fields ${fields.join(", ")}`);
  }
  return document;
}

function decisionNumbers(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MINUTES_LIST_LIMIT) fail("MINUTES_RECORD_INVALID", `${label} must be a list of at most ${String(MINUTES_LIST_LIMIT)} decision numbers`);
  let previous: string | null = null;
  for (const entry of value as readonly unknown[]) {
    if (parseDecisionAddress(entry) === null) fail("MINUTES_RECORD_INVALID", `${label} holds ${String(entry)}, which is not a decision number (minutes:<id>#D<n>)`);
    if (previous !== null && compareCanonicalText(previous, entry as string) >= 0) fail("MINUTES_RECORD_INVALID", `${label} must be sorted without repeats`);
    previous = entry as string;
  }
  return [...(value as readonly string[])];
}

/**
 * TCRN-CROSS-SUB-426: check a record's declarations against the record alone. Exactly the three
 * lists, at least one of them non-empty; every entry a decision number; supersedes sorted by
 * `decision`, the others sorted, none repeated. A decision is made obsolete once, and never one of
 * this record's own (a record declares about decisions already recorded); the decision that
 * supersedes one is not made obsolete by the same record, and when it is this record's own it is
 * one of its decisions; a decision declared to stand beside the record is neither its own nor made
 * obsolete by it.
 */
function validateDeclarations(value: unknown, recordId: string, decisionCount: number): MinutesDeclarations {
  const document = exactFields(value, DECLARATION_FIELDS, "declarations");
  if (!Array.isArray(document.supersedes) || document.supersedes.length > MINUTES_LIST_LIMIT) {
    fail("MINUTES_RECORD_INVALID", `declarations.supersedes must be a list of at most ${String(MINUTES_LIST_LIMIT)} supersessions`);
  }
  const supersedes: MinutesSupersession[] = [];
  let previous: string | null = null;
  for (const entry of document.supersedes as readonly unknown[]) {
    const supersession = exactFields(entry, SUPERSESSION_FIELDS, "a supersession");
    for (const field of SUPERSESSION_FIELDS) {
      if (parseDecisionAddress(supersession[field]) === null) {
        fail("MINUTES_RECORD_INVALID", `a supersession's ${field} ${String(supersession[field])} is not a decision number (minutes:<id>#D<n>)`);
      }
    }
    const decision = supersession.decision as string;
    if (previous !== null && compareCanonicalText(previous, decision) >= 0) fail("MINUTES_RECORD_INVALID", "declarations.supersedes must be sorted by decision without repeats");
    previous = decision;
    supersedes.push({ decision, by: supersession.by as string });
  }
  const withdraws = decisionNumbers(document.withdraws, "declarations.withdraws");
  const coexists = decisionNumbers(document.coexists, "declarations.coexists");
  if (supersedes.length + withdraws.length + coexists.length === 0) {
    fail("MINUTES_RECORD_INVALID", "declarations name at least one decision; a record with nothing to declare leaves them out");
  }
  const own = (address: string): DecisionReference | null => {
    const reference = parseDecisionAddress(address);
    return reference !== null && reference.minutesId === recordId ? reference : null;
  };
  const obsoleted = [...supersedes.map((entry) => entry.decision), ...withdraws];
  if (new Set(obsoleted).size !== obsoleted.length) fail("MINUTES_RECORD_INVALID", "a decision is superseded or withdrawn once");
  for (const address of obsoleted) {
    if (own(address) !== null) fail("MINUTES_RECORD_INVALID", `${address} is a decision of this record; a record declares about decisions already recorded`);
  }
  for (const { decision, by } of supersedes) {
    if (obsoleted.includes(by)) fail("MINUTES_RECORD_INVALID", `${by} cannot supersede ${decision}: this record makes it obsolete`);
    const reference = own(by);
    if (reference !== null && reference.number > decisionCount) fail("MINUTES_RECORD_INVALID", `${by} is not a decision of this record`);
  }
  for (const address of coexists) {
    if (own(address) !== null) fail("MINUTES_RECORD_INVALID", `${address} is a decision of this record; it stands beside decisions already recorded`);
    if (obsoleted.includes(address)) fail("MINUTES_RECORD_INVALID", `${address} is made obsolete by this record and cannot also stand beside it`);
  }
  return { supersedes, withdraws, coexists };
}

/**
 * Check a minutes record against its closed shape: exactly its twelve fields, and `declarations`
 * when it declares something about decisions already recorded (TCRN-CROSS-SUB-426); an id that is
 * the one its external key derives; one to 64 non-empty decisions; participant and linked-work ids
 * without repeats; a strict recordedAt. Replay and the write path run the same check; whether the
 * decisions a record declares about exist and are valid is assertDeclarationsResolve's.
 */
export function validateMinutesRecord(value: unknown): MinutesRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MINUTES_RECORD_INVALID", "a minutes record is an object");
  const document = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(document).sort(compareCanonicalText);
  const fields = Object.hasOwn(document, "declarations") ? [...RECORD_FIELDS, "declarations"] : RECORD_FIELDS;
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) {
    fail("MINUTES_RECORD_INVALID", `a minutes record has exactly the fields ${RECORD_FIELDS.join(", ")}, and declarations when it declares any`);
  }
  if (document.schemaVersion !== MINUTES_RECORD_VERSION) fail("MINUTES_RECORD_INVALID", `schemaVersion must be ${MINUTES_RECORD_VERSION}`);
  let externalKey: string;
  try {
    externalKey = canonicalExternalKey(document.externalKey);
  } catch {
    fail("MINUTES_RECORD_INVALID", `externalKey ${String(document.externalKey)} is not an external key`);
  }
  if (externalKey !== document.externalKey) fail("MINUTES_RECORD_INVALID", "externalKey must be in its canonical (upper-case) form");
  if (document.id !== deriveStableId("minutes", externalKey)) fail("MINUTES_RECORD_INVALID", `id must be the one ${externalKey} derives`);
  try {
    assertProtocolId(document.projectId);
  } catch {
    fail("MINUTES_RECORD_INVALID", "projectId is not an id");
  }
  if (!Array.isArray(document.decisions) || document.decisions.length === 0 || document.decisions.length > MINUTES_DECISIONS_LIMIT) {
    fail("MINUTES_RECORD_INVALID", `decisions must be a list of 1 to ${String(MINUTES_DECISIONS_LIMIT)} entries`);
  }
  const decisions = (document.decisions as readonly unknown[]).map((entry, index) => text(entry, `decision D${String(index + 1)}`, MINUTES_TEXT_BYTES));
  try {
    parseStrictInstant(document.recordedAt);
  } catch {
    fail("MINUTES_RECORD_INVALID", "recordedAt is not a strict instant");
  }
  if (document.revision !== 1 || document.tombstone !== false) fail("MINUTES_RECORD_INVALID", "a minutes record is written once: revision 1, not a tombstone");
  const declarations = Object.hasOwn(document, "declarations") ? validateDeclarations(document.declarations, document.id as string, decisions.length) : null;
  return {
    schemaVersion: MINUTES_RECORD_VERSION,
    id: document.id as string,
    externalKey,
    projectId: document.projectId as string,
    title: text(document.title, "title", MINUTES_TITLE_BYTES),
    summary: text(document.summary, "summary", MINUTES_TEXT_BYTES),
    decisions,
    decidedBy: ids(document.decidedBy, "decidedBy", null),
    linkedWorkIds: ids(document.linkedWorkIds, "linkedWorkIds", "work"),
    recordedAt: document.recordedAt as string,
    revision: 1,
    tombstone: false,
    ...(declarations === null ? {} : { declarations }),
  };
}

/** What a declaration check reads of the minutes already recorded. */
export interface DecisionLookup {
  /** A live minutes record, new or historical: its project and how many decisions it has. */
  readonly minutes: (minutesId: string) => { readonly projectId: string; readonly decisions: number } | undefined;
  /** Whether a decision has been made obsolete already. */
  readonly obsolete: (address: string) => boolean;
}

/** The decisions a record makes obsolete, superseded or withdrawn. */
function obsoletedBy(record: Pick<MinutesRecord, "declarations">): readonly string[] {
  return record.declarations === undefined
    ? []
    : [...record.declarations.supersedes.map((entry) => entry.decision), ...record.declarations.withdraws];
}

/** A DecisionLookup over live minutes of both kinds: the new records declare what is obsolete. */
export function decisionLookup(minutes: Iterable<MinutesRecord>, conferenceMinutes: Iterable<ConferenceMinutes>): DecisionLookup {
  const records = new Map<string, { readonly projectId: string; readonly decisions: number }>();
  const obsolete = new Set<string>();
  for (const record of minutes) {
    if (record.tombstone) continue;
    records.set(record.id, { projectId: record.projectId, decisions: record.decisions.length });
    for (const address of obsoletedBy(record)) obsolete.add(address);
  }
  for (const record of conferenceMinutes) {
    if (!record.tombstone) records.set(record.id, { projectId: record.projectId, decisions: record.decisions.length });
  }
  return { minutes: (minutesId) => records.get(minutesId), obsolete: (address) => obsolete.has(address) };
}

/**
 * TCRN-CROSS-SUB-426: check what a record declares against the minutes already recorded. Every
 * decision it names outside itself is a decision of a live minutes record of the same project
 * (MINUTES_NOT_FOUND, MINUTES_RECORD_INVALID); a decision it supersedes or withdraws is not obsolete
 * already, because obsolete is final (MINUTES_DECISION_OBSOLETE). On the write path the decision that
 * supersedes one and a decision the record stands beside must be valid as well; replay asks only that
 * they exist, so a record another device made obsolete first does not take this one down with it.
 */
export function assertDeclarationsResolve(record: MinutesRecord, lookup: DecisionLookup, check: "write" | "replay"): void {
  const declarations = record.declarations;
  if (declarations === undefined) return;
  const foreign = (address: string, role: string): boolean => {
    const reference = parseDecisionAddress(address);
    if (reference === null || reference.minutesId === record.id) return false;
    const target = lookup.minutes(reference.minutesId);
    if (target === undefined || reference.number > target.decisions) fail("MINUTES_NOT_FOUND", `${role} ${address}: no such decision in this library`);
    if (target.projectId !== record.projectId) fail("MINUTES_RECORD_INVALID", `${role} ${address} is a decision of another project`);
    return true;
  };
  const final = (address: string): void => {
    if (lookup.obsolete(address)) fail("MINUTES_DECISION_OBSOLETE", `${address} is obsolete already; an obsolete decision is final, and a mistake is corrected by a new decision`);
  };
  for (const { decision, by } of declarations.supersedes) {
    foreign(decision, "supersedes");
    final(decision);
    if (foreign(by, "superseded by") && check === "write" && lookup.obsolete(by)) {
      fail("MINUTES_DECISION_OBSOLETE", `${by} is obsolete and cannot supersede ${decision}`);
    }
  }
  for (const decision of declarations.withdraws) {
    foreign(decision, "withdraws");
    final(decision);
  }
  for (const decision of declarations.coexists) {
    if (foreign(decision, "coexists") && check === "write" && lookup.obsolete(decision)) {
      fail("MINUTES_DECISION_OBSOLETE", `${decision} is obsolete; only a valid decision can stand beside new minutes`);
    }
  }
}

/** Number a record's decisions D1..Dn. */
export function numberedDecisions(decisions: readonly string[]): readonly MinutesDecision[] {
  return decisions.map((entry, index) => ({ number: index + 1, text: entry }));
}

function instantOrder(left: string, right: string): number {
  const difference = parseStrictInstant(left) - parseStrictInstant(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

// The numbered external key recorded last: the latest recordedAt, and the later record on a tie.
function latestNumberedKey(records: readonly MinutesRecord[]): string | undefined {
  let latest: MinutesRecord | undefined;
  for (const record of records) {
    if (!/\d$/u.test(record.externalKey)) continue;
    if (latest === undefined || instantOrder(record.recordedAt, latest.recordedAt) >= 0) latest = record;
  }
  return latest?.externalKey;
}

/**
 * The key a new record takes when its writer gives none: the next number after the largest one
 * under the same prefix (`TCRN-CROSS-MIN-232` gives `TCRN-CROSS-MIN-233`, keeping the width of
 * its digits), skipping a number whose id is already taken. Without a prefix, the prefix of the
 * record written last is used. A library with no numbered minutes key under that prefix -- a
 * conference close never stored its key -- needs the first one given explicitly.
 */
export function nextMinutesExternalKey(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes">, prefix?: string): string {
  const numbered = state.minutes
    .map((record) => /^(.*?)(\d+)$/u.exec(record.externalKey))
    .filter((match): match is RegExpExecArray => match !== null);
  const base = prefix === undefined ? latestNumberedKey(state.minutes)?.replace(/\d+$/u, "") : prefix.toUpperCase();
  const sameBase = numbered.filter((match) => match[1] === base);
  if (base === undefined || sameBase.length === 0) {
    fail("MINUTES_EXTERNAL_KEY_REQUIRED", base === undefined
      ? "no numbered minutes key exists yet; give --external-key for the first record"
      : `no minutes key under ${base} exists yet; give --external-key for the first record`);
  }
  const width = Math.max(...sameBase.map((match) => (match[2] ?? "").length));
  const taken = new Set([...state.minutes.map((record) => record.id), ...state.conferenceMinutes.map((record) => record.id)]);
  let next = sameBase.reduce((largest, match) => (BigInt(match[2] ?? "0") > largest ? BigInt(match[2] ?? "0") : largest), 0n);
  for (;;) {
    next += 1n;
    const candidate = `${base}${next.toString().padStart(width, "0")}`;
    if (!taken.has(deriveStableId("minutes", candidate))) return canonicalExternalKey(candidate);
  }
}

/** One decision with its state (TCRN-CROSS-SUB-426). */
export interface DecisionState {
  readonly decision: string;
  readonly minutesId: string;
  readonly number: number;
  readonly text: string;
  readonly projectId: string;
  readonly status: DecisionStatus;
  // The decision that superseded this one; null while it is valid and when it was withdrawn.
  readonly supersededBy: string | null;
  // The minutes that made it obsolete; null while it is valid.
  readonly declaredIn: string | null;
  // The decisions this one superseded, in canonical order.
  readonly supersedes: readonly string[];
}

/** Every decision of the live minutes, by its number and by its record (in number order). */
export interface DecisionLedger {
  readonly decisions: ReadonlyMap<string, DecisionState>;
  readonly records: ReadonlyMap<string, readonly DecisionState[]>;
}

type LedgerState = Pick<WorkspaceState, "minutes" | "conferenceMinutes">;

/**
 * The state of every decision of the live minutes, new and historical: valid, unless a record
 * declared it superseded (by the decision named with it) or withdrawn. Replay admits one such
 * declaration per decision; were there two, the one recorded first would stand.
 */
export function decisionLedger(state: LedgerState): DecisionLedger {
  interface Mutable { status: DecisionStatus; supersededBy: string | null; declaredIn: string | null; readonly supersedes: string[] }
  const base: { readonly minutesId: string; readonly projectId: string; readonly decisions: readonly string[] }[] = [
    ...state.minutes.filter((record) => !record.tombstone),
    ...state.conferenceMinutes.filter((record) => !record.tombstone),
  ].map((record) => ({ minutesId: record.id, projectId: record.projectId, decisions: record.decisions }));
  const mutable = new Map<string, Mutable>();
  for (const record of base) {
    record.decisions.forEach((_, index) => mutable.set(decisionAddress(record.minutesId, index + 1), { status: "valid", supersededBy: null, declaredIn: null, supersedes: [] }));
  }
  const declaring = state.minutes
    .filter((record) => !record.tombstone && record.declarations !== undefined)
    .sort((left, right) => instantOrder(left.recordedAt, right.recordedAt) || compareCanonicalText(left.id, right.id));
  for (const record of declaring) {
    const declarations = record.declarations as MinutesDeclarations;
    const obsolete = (address: string, by: string | null): void => {
      const entry = mutable.get(address);
      if (entry === undefined || entry.status === "obsolete") return;
      entry.status = "obsolete";
      entry.supersededBy = by;
      entry.declaredIn = record.id;
      if (by !== null) mutable.get(by)?.supersedes.push(address);
    };
    for (const { decision, by } of declarations.supersedes) obsolete(decision, by);
    for (const decision of declarations.withdraws) obsolete(decision, null);
  }
  const decisions = new Map<string, DecisionState>();
  const records = new Map<string, readonly DecisionState[]>();
  for (const record of base) {
    const states = record.decisions.map((textValue, index): DecisionState => {
      const address = decisionAddress(record.minutesId, index + 1);
      const entry = mutable.get(address) as Mutable;
      return {
        decision: address,
        minutesId: record.minutesId,
        number: index + 1,
        text: textValue,
        projectId: record.projectId,
        status: entry.status,
        supersededBy: entry.supersededBy,
        declaredIn: entry.declaredIn,
        supersedes: [...entry.supersedes].sort(compareCanonicalText),
      };
    });
    for (const entry of states) decisions.set(entry.decision, entry);
    records.set(record.minutesId, states);
  }
  return { decisions, records };
}

// A decision as a read shows it. A read of the valid decisions keeps each one's number and text, as
// it always did, and adds what it superseded; an explicit read gives every decision its state.
function decisionEntry(entry: DecisionState, ledger: DecisionLedger, explicit: boolean): MinutesDecision {
  const successor = (address: string | null): MinutesDecisionSuccessor | null => {
    if (address === null) return null;
    const next = ledger.decisions.get(address);
    return { decision: address, text: next?.text ?? "", status: next?.status ?? "valid" };
  };
  return {
    number: entry.number,
    text: entry.text,
    ...(explicit ? { status: entry.status } : {}),
    ...(entry.supersedes.length === 0 ? {} : { supersedes: entry.supersedes }),
    ...(explicit && entry.status === "obsolete" ? { supersededBy: successor(entry.supersededBy), declaredIn: entry.declaredIn ?? "" } : {}),
  };
}

interface ViewBase {
  readonly id: string;
  readonly externalKey: string | null;
  readonly kind: "minutes" | "conference-minutes";
  readonly projectId: string;
  readonly title: string;
  readonly summary: string;
  readonly decidedBy: readonly string[];
  readonly linkedWorkIds: readonly string[];
  readonly recordedAt: string;
  readonly declarations?: MinutesDeclarations;
}

// Every live record, new and historical, before its decisions are chosen.
function viewBases(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes" | "conferences">): readonly ViewBase[] {
  const conferences = new Map(state.conferences.map((conference) => [conference.id, conference]));
  const bases: ViewBase[] = [
    ...state.minutes.filter((record) => !record.tombstone).map((record): ViewBase => ({
      id: record.id,
      externalKey: record.externalKey,
      kind: "minutes",
      projectId: record.projectId,
      title: record.title,
      summary: record.summary,
      decidedBy: record.decidedBy,
      linkedWorkIds: record.linkedWorkIds,
      recordedAt: record.recordedAt,
      ...(record.declarations === undefined ? {} : { declarations: record.declarations }),
    })),
    ...state.conferenceMinutes.filter((record) => !record.tombstone).map((record): ViewBase => {
      const conference = conferences.get(record.conferenceId);
      return {
        id: record.id,
        externalKey: null,
        kind: "conference-minutes",
        projectId: record.projectId,
        title: conference?.title ?? record.conferenceId,
        summary: record.summary,
        decidedBy: conference?.participantIds ?? [],
        linkedWorkIds: conference?.linkedWorkIds ?? [],
        recordedAt: record.updatedAt,
      };
    }),
  ];
  return bases.sort((left, right) => instantOrder(left.recordedAt, right.recordedAt) || compareCanonicalText(left.id, right.id));
}

// One record of a read: its decisions of the asked status, or null when it has none. A read of the
// valid decisions names the numbers it leaves out.
function viewEntry(base: ViewBase, ledger: DecisionLedger, filter: DecisionStatusFilter): MinutesViewEntry | null {
  const states = ledger.records.get(base.id) ?? [];
  const chosen = filter === "all" ? states : states.filter((entry) => entry.status === filter);
  if (chosen.length === 0 && filter !== "all") return null;
  const withheld = filter === "valid" ? states.filter((entry) => entry.status === "obsolete").map((entry) => entry.number) : [];
  return {
    ...base,
    decisions: chosen.map((entry) => decisionEntry(entry, ledger, filter !== "valid")),
    ...(withheld.length === 0 ? {} : { withheldDecisions: withheld }),
  };
}

/**
 * Every live minutes record, new and historical, in the order it was recorded (then by id): a
 * new record as written, and a conference's minutes titled by that conference, decided by its
 * participants, linked to its work, with no external key to show. TCRN-CROSS-SUB-426: with the valid
 * decisions of each record (the default), a record none of whose decisions is valid left out; or with
 * its obsolete decisions, a record with none left out; or with all of them.
 */
export function minutesView(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes" | "conferences">, filter: DecisionStatusFilter = "valid"): readonly MinutesViewEntry[] {
  const ledger = decisionLedger(state);
  return viewBases(state).map((base) => viewEntry(base, ledger, filter)).filter((entry): entry is MinutesViewEntry => entry !== null);
}

/**
 * One record of the minutes, by id or by external key; MINUTES_NOT_FOUND when none matches. Its
 * decisions are the ones `filter` asks for, and a record with none of them is answered with an empty
 * list. TCRN-CROSS-SUB-426: a decision number -- minutes:<id>#D<n>, or <external key>#D<n> -- is a
 * read of that one decision whatever its state, answered with it alone as an explicit read shows it.
 */
export function minutesById(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes" | "conferences">, idOrKey: string, filter: DecisionStatusFilter = "valid"): MinutesViewEntry {
  const numbered = /^(.+)#D([1-9][0-9]*)$/u.exec(idOrKey);
  const recordRef = numbered === null ? idOrKey : numbered[1] ?? "";
  const key = recordRef.startsWith("minutes:") ? null : recordRef.toUpperCase();
  const base = viewBases(state).find((entry) => (key === null ? entry.id === recordRef : entry.externalKey === key));
  if (base === undefined) fail("MINUTES_NOT_FOUND", `no minutes ${idOrKey} in this library`);
  const ledger = decisionLedger(state);
  if (numbered === null) return viewEntry(base, ledger, filter) ?? { ...base, decisions: [], ...withheldOf(base, ledger, filter) };
  const decision = ledger.decisions.get(decisionAddress(base.id, Number(numbered[2])));
  if (decision === undefined) fail("MINUTES_NOT_FOUND", `no decision ${idOrKey} in this library`);
  return { ...base, decisions: [decisionEntry(decision, ledger, true)] };
}

function withheldOf(base: ViewBase, ledger: DecisionLedger, filter: DecisionStatusFilter): { readonly withheldDecisions?: readonly number[] } {
  if (filter !== "valid") return {};
  const withheld = (ledger.records.get(base.id) ?? []).filter((entry) => entry.status === "obsolete").map((entry) => entry.number);
  return withheld.length === 0 ? {} : { withheldDecisions: withheld };
}

/**
 * TCRN-CROSS-SUB-426: a decision as a writer names it -- minutes:<id>#D<n>, <external key>#D<n> for
 * minutes recorded with a key, or D<n> for decision n of the record being written (`self`) -- as its
 * number, minutes:<id>#D<n>. Whether the decision exists is assertDeclarationsResolve's to say.
 */
export function resolveDecisionReference(reference: string, self: string): string {
  const own = /^D([1-9][0-9]*)$/u.exec(reference);
  if (own !== null) return decisionAddress(self, Number(own[1]));
  if (parseDecisionAddress(reference) !== null) return reference;
  const keyed = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)#D([1-9][0-9]*)$/u.exec(reference);
  if (keyed !== null) {
    try {
      return decisionAddress(deriveStableId("minutes", keyed[1]), Number(keyed[2]));
    } catch {
      // Not an external key after all; refused below.
    }
  }
  return fail("MINUTES_RECORD_INVALID", `${reference} is not a decision number: minutes:<id>#D<n>, <external key>#D<n> or D<n>`);
}

/** What a writer declares, as it named the decisions (resolveDecisionReference). */
export interface MinutesDeclarationInput {
  readonly supersedes?: readonly { readonly decision: string; readonly by: string }[];
  readonly withdraws?: readonly string[];
  readonly coexists?: readonly string[];
}

/** A writer's declarations as a record stores them, or null when it declares nothing. */
export function declarationsFromInput(input: MinutesDeclarationInput, self: string): MinutesDeclarations | null {
  const supersedes = (input.supersedes ?? [])
    .map((entry) => ({ decision: resolveDecisionReference(entry.decision, self), by: resolveDecisionReference(entry.by, self) }))
    .sort((left, right) => compareCanonicalText(left.decision, right.decision));
  const sorted = (list: readonly string[] | undefined): readonly string[] => (list ?? []).map((entry) => resolveDecisionReference(entry, self)).sort(compareCanonicalText);
  const withdraws = sorted(input.withdraws);
  const coexists = sorted(input.coexists);
  return supersedes.length + withdraws.length + coexists.length === 0 ? null : { supersedes, withdraws, coexists };
}

/**
 * TCRN-CROSS-SUB-426 (MIN-239 D5): how close two decisions are in topic. Each text is read as its
 * recall tokens (recallTextTokens); a token weighs ln(1 + (N + 10) / (df + 1)) over the N decisions
 * compared, df of them carrying it -- a word every record uses weighs little, and in a library of a
 * few decisions every word weighs about the same. The score is the weighted cosine of the two token
 * sets. Two decisions are close at DECISION_TOPIC_THRESHOLD, when they share at least
 * DECISION_TOPIC_SHARED_TOKENS tokens: measured on the recorded cross-project corpus (1,618 decisions,
 * tests/fixtures/retrieval-eval/minutes-compact.json), 68 pairs of decisions of different records
 * reach it, a later ruling restating or replacing an earlier one, and none of the recorder's notes
 * that every record ends with.
 */
export const DECISION_TOPIC_THRESHOLD = 0.5;
export const DECISION_TOPIC_SHARED_TOKENS = 3;

/** The document frequencies of a set of token sets, and how many there are. */
export interface TopicCorpus {
  readonly size: number;
  readonly frequency: ReadonlyMap<string, number>;
}

export function topicCorpus(documents: Iterable<ReadonlySet<string>>): TopicCorpus {
  const frequency = new Map<string, number>();
  let size = 0;
  for (const document of documents) {
    size += 1;
    for (const token of document) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  return { size, frequency };
}

/** The weight of a token `frequency` of `size` documents carry: ln(1 + (N + 10) / (df + 1)). */
export function topicTokenWeight(size: number, frequency: number): number {
  return Math.log(1 + (size + 10) / (frequency + 1));
}

/** A token's weight in a corpus (topicTokenWeight). */
export function topicWeight(corpus: TopicCorpus, token: string): number {
  return topicTokenWeight(corpus.size, corpus.frequency.get(token) ?? 0);
}

/** One decision of a record being written that is close in topic to a valid decision already recorded. */
export interface DecisionTopicConflict {
  // The number of the decision being written, 1-based.
  readonly number: number;
  // The valid decision it is close to.
  readonly decision: string;
  readonly score: number;
  // TCRN-CROSS-SUB-486 (STORY-531): true when the minutes of that decision are of INIT families apart
  // from the record's, both known (work-family.ts); false when they share one, or either is not known.
  readonly otherFamily: boolean;
}

/** What the topic check reads: the decisions, and the work and conferences their families come from. */
type TopicState = LedgerState & WorkFamilyState;

/** The record a topic check is about; linked work it leaves out is no work. */
type TopicRecord = Pick<MinutesRecord, "id" | "projectId" | "decisions" | "declarations"> & { readonly linkedWorkIds?: readonly string[] };

/**
 * The valid decisions of the record's project that a decision of `record` is close in topic to, and
 * that its declarations do not settle: a decision it supersedes or withdraws, the decision that
 * supersedes one, and a decision it stands beside are settled. Strongest first, then by number and
 * decision number. TCRN-CROSS-SUB-486 (STORY-531, Q11): each is classed by INIT family -- the
 * record's families are those of the work it links, an existing decision's those of the work its
 * minutes link (a conference's minutes, the conference's).
 */
export function decisionTopicConflicts(state: TopicState, record: TopicRecord): readonly DecisionTopicConflict[] {
  const ledger = decisionLedger(state);
  const recordFamilies = referenceFamilies(state, record.linkedWorkIds ?? []);
  const minutesFamilies = new Map<string, readonly string[] | null>();
  const otherFamily = (minutesId: string): boolean => {
    if (!minutesFamilies.has(minutesId)) minutesFamilies.set(minutesId, referenceFamilies(state, [minutesId]));
    return familiesApart(recordFamilies, minutesFamilies.get(minutesId) ?? null);
  };
  const settled = new Set<string>(record.declarations === undefined ? [] : [
    ...record.declarations.supersedes.flatMap((entry) => [entry.decision, entry.by]),
    ...record.declarations.withdraws,
    ...record.declarations.coexists,
  ]);
  const existing = [...ledger.decisions.values()].map((entry) => ({ entry, tokens: recallTextTokens(entry.text) }));
  const written = record.decisions.map((entry) => recallTextTokens(entry));
  const corpus = topicCorpus([...existing.map((entry) => entry.tokens), ...written]);
  const norms = new Map<ReadonlySet<string>, number>();
  const norm = (tokens: ReadonlySet<string>): number => {
    let value = norms.get(tokens);
    if (value === undefined) {
      value = Math.sqrt([...tokens].reduce((sum, token) => sum + topicWeight(corpus, token) ** 2, 0));
      norms.set(tokens, value);
    }
    return value;
  };
  const conflicts: DecisionTopicConflict[] = [];
  const candidates = existing.filter(({ entry }) => entry.status === "valid" && entry.projectId === record.projectId && !settled.has(entry.decision));
  written.forEach((tokens, index) => {
    for (const candidate of candidates) {
      let shared = 0;
      let dot = 0;
      for (const token of tokens) {
        if (!candidate.tokens.has(token)) continue;
        shared += 1;
        dot += topicWeight(corpus, token) ** 2;
      }
      if (shared < DECISION_TOPIC_SHARED_TOKENS) continue;
      const score = dot / (norm(tokens) * norm(candidate.tokens));
      if (score >= DECISION_TOPIC_THRESHOLD) conflicts.push({ number: index + 1, decision: candidate.entry.decision, score, otherFamily: otherFamily(candidate.entry.minutesId) });
    }
  });
  return conflicts.sort((left, right) => right.score - left.score || left.number - right.number || compareCanonicalText(left.decision, right.decision));
}

/**
 * Refuse a record a decision of which is close in topic to a valid decision its declarations do not
 * settle (MINUTES_POSSIBLE_CONFLICT), naming each such decision under `conflicts`, strongest first.
 * TCRN-CROSS-SUB-486 (STORY-531): only a decision of the record's own INIT family, or of a family
 * either side cannot name, refuses it; the refusal names the others under `otherFamilyConflicts`.
 * The decisions of another family are answered, strongest first, for the record to stand beside.
 */
export function assertNoDecisionTopicConflict(state: TopicState, record: TopicRecord): readonly DecisionTopicConflict[] {
  const conflicts = decisionTopicConflicts(state, record);
  const blocking = conflicts.filter((entry) => !entry.otherFamily);
  const apart = conflicts.filter((entry) => entry.otherFamily);
  if (blocking.length === 0) return apart;
  const named = [...new Set(blocking.map((entry) => entry.decision))].slice(0, MINUTES_LIST_LIMIT);
  const others = [...new Set(apart.map((entry) => entry.decision))].slice(0, MINUTES_LIST_LIMIT);
  const pairs = blocking.map((entry) => `D${String(entry.number)} ~ ${entry.decision} (${entry.score.toFixed(2)})`).join("; ");
  return fail("MINUTES_POSSIBLE_CONFLICT", `a decision is close in topic to a valid decision: ${pairs}; declare which it supersedes or withdraws, or that it stands beside it`, {
    conflicts: named,
    ...(others.length === 0 ? {} : { otherFamilyConflicts: others }),
    remedy: "for each decision named: --supersedes <decision>=D<n>, --withdraws <decision> or --coexists <decision>",
  });
}

/**
 * TCRN-CROSS-SUB-486 (STORY-531): `record` standing beside `decisions` as well -- the valid decisions
 * of another INIT family that assertNoDecisionTopicConflict answered -- by adding them to its
 * declarations' coexists, as a writer's --coexists would. The record keeps its shape and is checked
 * again; a record with none to add is answered as it is.
 */
export function standBeside(record: MinutesRecord, decisions: readonly string[]): MinutesRecord {
  const declared = record.declarations?.coexists ?? [];
  const added = decisions.filter((decision) => !declared.includes(decision));
  if (added.length === 0) return record;
  return validateMinutesRecord({
    ...record,
    declarations: {
      supersedes: record.declarations?.supersedes ?? [],
      withdraws: record.declarations?.withdraws ?? [],
      coexists: [...new Set([...declared, ...added])].sort(compareCanonicalText),
    },
  });
}

/** TCRN-CROSS-SUB-486: one decision a minutes-record receipt warns that the record stands beside. */
export interface MinutesConflictWarning {
  readonly reasonCode: "MINUTES_POSSIBLE_CONFLICT";
  readonly decision: string;
  readonly text: string;
  // The Initiatives the work its minutes link leads to.
  readonly families: readonly string[];
  readonly message: string;
}

/**
 * The warnings of a minutes-record receipt (TCRN-CROSS-SUB-486): every decision `record` stands
 * beside that its writer did not declare (`declared`, as declarationsFromInput resolves --coexists) --
 * those the write added because they are of another INIT family -- with its text and families, in
 * `state`, the library after the write.
 */
export function standBesideWarnings(state: TopicState, record: Pick<MinutesViewEntry, "declarations">, declared: readonly string[]): readonly MinutesConflictWarning[] {
  const added = (record.declarations?.coexists ?? []).filter((decision) => !declared.includes(decision));
  if (added.length === 0) return [];
  const ledger = decisionLedger(state);
  return added.map((decision): MinutesConflictWarning => {
    const families = referenceFamilies(state, [parseDecisionAddress(decision)?.minutesId ?? ""]) ?? [];
    return {
      reasonCode: "MINUTES_POSSIBLE_CONFLICT",
      decision,
      text: ledger.decisions.get(decision)?.text ?? "",
      families,
      message: `${decision} is close in topic but of another INIT family (${families.join(", ")}); the record stands beside it (declarations.coexists)`,
    };
  });
}

/**
 * TCRN-CROSS-SUB-426 (MIN-239 D5): an obsolete decision a record points at, and the decision that
 * superseded it (null when it was withdrawn).
 */
export interface ObsoleteDecisionHint {
  readonly decision: string;
  readonly supersededBy: string | null;
}

/** The obsolete decisions among `decisions` (decision numbers), each once, in the order given. */
export function obsoleteDecisionHints(ledger: DecisionLedger, decisions: readonly string[]): readonly ObsoleteDecisionHint[] {
  const hints: ObsoleteDecisionHint[] = [];
  const seen = new Set<string>();
  for (const address of decisions) {
    const entry = ledger.decisions.get(address);
    if (entry === undefined || entry.status !== "obsolete" || seen.has(address)) continue;
    seen.add(address);
    hints.push({ decision: address, supersededBy: entry.supersededBy });
  }
  return hints;
}

/** The decisions of the named minutes records (by id), in record and number order. */
export function decisionsOfMinutes(ledger: DecisionLedger, minutesIds: readonly string[]): readonly string[] {
  return minutesIds.flatMap((minutesId) => (ledger.records.get(minutesId) ?? []).map((entry) => entry.decision));
}

const NAMED_DECISION = /(minutes:[a-z0-9][a-z0-9._-]*|[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s*#?\s*D([1-9][0-9]*)(?![0-9])/gu;

/**
 * The decisions a text names, as decision numbers: minutes:<id>#D<n> or minutes:<id> D<n>, and a
 * minutes external key followed by #D<n> or D<n> -- the whole key, or its tail after a hyphen when
 * only one minutes record carries it (MIN-145 D2 for TCRN-CROSS-MIN-145 D2). A name that no live
 * minutes record carries, or that more than one does, names nothing.
 */
export function decisionsNamedIn(state: Pick<WorkspaceState, "minutes">, ledger: DecisionLedger, value: string): readonly string[] {
  const keys = state.minutes.filter((record) => !record.tombstone).map((record) => [record.externalKey, record.id] as const);
  const named: string[] = [];
  for (const match of value.matchAll(NAMED_DECISION)) {
    const name = match[1] ?? "";
    let minutesId: string | undefined;
    if (name.startsWith("minutes:")) {
      minutesId = name;
    } else {
      const key = name.toUpperCase();
      const exact = keys.find(([externalKey]) => externalKey === key);
      const tails = keys.filter(([externalKey]) => externalKey.endsWith(`-${key}`));
      minutesId = exact?.[1] ?? (tails.length === 1 ? tails[0]?.[1] : undefined);
    }
    if (minutesId === undefined) continue;
    const address = decisionAddress(minutesId, Number(match[2]));
    if (ledger.decisions.has(address) && !named.includes(address)) named.push(address);
  }
  return named;
}
