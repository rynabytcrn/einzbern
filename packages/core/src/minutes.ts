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

import { assertProtocolId, canonicalExternalKey, compareCanonicalText, deriveStableId, parseStrictInstant } from "../../protocol/src/index.js";
import type { WorkspaceState } from "./workspace.js";

export const MINUTES_RECORD_VERSION = "einzbern.minutes.v1" as const;
export const MINUTES_RECORDED_OPERATION = "minutes.recorded" as const;

/** At most this many decisions in one record, and at most this many participants and linked records. */
export const MINUTES_DECISIONS_LIMIT = 64;
const MINUTES_LIST_LIMIT = 64;
const MINUTES_TITLE_BYTES = 512;
const MINUTES_TEXT_BYTES = 4_096;

export const MINUTES_REASON_CODES = Object.freeze([
  "MINUTES_EXTERNAL_KEY_REQUIRED",
  "MINUTES_NOT_FOUND",
  "MINUTES_RECORD_INVALID",
] as const);
export type MinutesReasonCode = typeof MINUTES_REASON_CODES[number];

export class MinutesError extends Error {
  readonly reasonCode: MinutesReasonCode;
  constructor(reasonCode: MinutesReasonCode, message: string) {
    super(message);
    this.name = "MinutesError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: MinutesReasonCode, message: string): never {
  throw new MinutesError(reasonCode, message);
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
}

/** One decision, numbered from 1 within its record. */
export interface MinutesDecision {
  readonly number: number;
  readonly text: string;
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
}

const RECORD_FIELDS = ["schemaVersion", "id", "externalKey", "projectId", "title", "summary", "decisions", "decidedBy", "linkedWorkIds", "recordedAt", "revision", "tombstone"];

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

/**
 * Check a minutes record against its closed shape: exactly its twelve fields; an id that is the
 * one its external key derives; one to 64 non-empty decisions; participant and linked-work ids
 * without repeats; a strict recordedAt. Replay and the write path run the same check.
 */
export function validateMinutesRecord(value: unknown): MinutesRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MINUTES_RECORD_INVALID", "a minutes record is an object");
  const document = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(document).sort(compareCanonicalText);
  if (keys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every((field) => keys.includes(field))) {
    fail("MINUTES_RECORD_INVALID", `a minutes record has exactly the fields ${RECORD_FIELDS.join(", ")}`);
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
  };
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

/**
 * Every live minutes record, new and historical, in the order it was recorded (then by id): a
 * new record as written, and a conference's minutes titled by that conference, decided by its
 * participants, linked to its work, with no external key to show.
 */
export function minutesView(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes" | "conferences">): readonly MinutesViewEntry[] {
  const conferences = new Map(state.conferences.map((conference) => [conference.id, conference]));
  const entries: MinutesViewEntry[] = [
    ...state.minutes.filter((record) => !record.tombstone).map((record): MinutesViewEntry => ({
      id: record.id,
      externalKey: record.externalKey,
      kind: "minutes",
      projectId: record.projectId,
      title: record.title,
      summary: record.summary,
      decisions: numberedDecisions(record.decisions),
      decidedBy: record.decidedBy,
      linkedWorkIds: record.linkedWorkIds,
      recordedAt: record.recordedAt,
    })),
    ...state.conferenceMinutes.filter((record) => !record.tombstone).map((record): MinutesViewEntry => {
      const conference = conferences.get(record.conferenceId);
      return {
        id: record.id,
        externalKey: null,
        kind: "conference-minutes",
        projectId: record.projectId,
        title: conference?.title ?? record.conferenceId,
        summary: record.summary,
        decisions: numberedDecisions(record.decisions),
        decidedBy: conference?.participantIds ?? [],
        linkedWorkIds: conference?.linkedWorkIds ?? [],
        recordedAt: record.updatedAt,
      };
    }),
  ];
  return entries.sort((left, right) => instantOrder(left.recordedAt, right.recordedAt) || compareCanonicalText(left.id, right.id));
}

/** One record of minutesView, by id or by external key; MINUTES_NOT_FOUND when none matches. */
export function minutesById(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes" | "conferences">, idOrKey: string): MinutesViewEntry {
  const view = minutesView(state);
  const key = idOrKey.startsWith("minutes:") ? null : idOrKey.toUpperCase();
  const found = view.find((entry) => (key === null ? entry.id === idOrKey : entry.externalKey === key));
  if (found === undefined) fail("MINUTES_NOT_FOUND", `no minutes ${idOrKey} in this library`);
  return found;
}
