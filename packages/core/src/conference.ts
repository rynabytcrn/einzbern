// SPDX-License-Identifier: Apache-2.0

import { assertProtocolId, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";

export const CONFERENCE_REQUEST_VERSION = "tcrn.conference.v1.request" as const;
export const CONFERENCE_POSITION_VERSION = "tcrn.conference.v1.position" as const;
export const CONFERENCE_MINUTES_VERSION = "tcrn.conference.v1.minutes" as const;

export const CONFERENCE_TYPES = Object.freeze(["strategy", "architecture", "risk", "verification", "release", "incident", "retrospective"] as const);
export const CONFERENCE_STATUSES = Object.freeze(["open", "closed", "cancelled"] as const);

// INIT-026 S234 wrote an execution form on a conference close ("conference:execution-form") and
// execution.independenceFloor decided which closes had to declare "independent". TCRN-CROSS-STORY-475
// R3 retired both with the conference write verbs; the values and the floor names stay here as the
// read-only vocabulary of the minutes a conference close wrote (vocabulary.ts).
export const CONFERENCE_EXECUTION_FORMS = Object.freeze(["independent", "single-context"] as const);
export type ConferenceExecutionForm = typeof CONFERENCE_EXECUTION_FORMS[number];

export function independenceFloorCovers(floor: string, conferenceType: string): boolean {
  switch (floor) {
    case "verification": return conferenceType === "verification";
    case "verification-and-risk": return conferenceType === "verification" || conferenceType === "risk";
    case "all": return (CONFERENCE_TYPES as readonly string[]).includes(conferenceType);
    default: return false;
  }
}
export const CONFERENCE_OUTCOME_CLASSES = Object.freeze(["discussion_only", "recommendation", "role_decision", "blocked", "owner_intent_required"] as const);

// The codes replay and the read verbs can still raise. CONFERENCE_DISTILLED,
// CONFERENCE_MINUTES_UNBOUND and CONFERENCE_POSITION_UNBOUND left with the write path they belonged to
// (TCRN-CROSS-STORY-475 R3).
export const CONFERENCE_REASON_CODES = Object.freeze([
  "CONFERENCE_ANCHOR_REQUIRED",
  "CONFERENCE_BUDGET_EXCEEDED",
  "CONFERENCE_DESIRED_OUTCOME_REQUIRED",
  "CONFERENCE_SCHEMA_INVALID",
  "CONFERENCE_UNICODE_INVALID",
  "CONFERENCE_UNKNOWN_FIELD",
  "CONFERENCE_VALIDATED",
] as const);

export type ConferenceReasonCode = typeof CONFERENCE_REASON_CODES[number];

const maximumTextBytes = 2_048;
const maximumExtensionProperties = 64;

/**
 * The hard ceiling on a single `position`, and the only budget replay knows about.
 *
 * A deliberation's positions are carried verbatim — summarising one is exactly the
 * thing the deliberation-adoption convention forbids — and at 2,048 bytes a CJK
 * position ran out at roughly 680 characters, which forced 23 of this platform's
 * deliberations to be split across continuation records purely to fit.
 *
 * Why a ceiling *and* a setting, rather than the setting alone: this predicate runs
 * in the replay reducer, so if the admissible size depended on a workspace setting
 * then the same bytes would be legal or illegal according to where they sit in the
 * chain. That would falsify conference-v1's store-independent promise and leave the
 * schema unable to state a bound at all. So replay knows only this constant, record
 * validity stays a pure function of the bytes, and the per-deployment budget
 * (`conference.positionBudgetBytes`) is enforced on the write path instead — the
 * shape `execution.independenceFloor` already uses.
 *
 * Raising this is a one-way step for a chain that uses it: an engine older than the
 * release that introduced it reads an over-2,048 position as WORKSPACE_EVENT_CORRUPT,
 * which is why it is version-gated once here rather than nudged upward repeatedly.
 * Only `position` is raised; every other conference text field keeps 2,048, which
 * also keeps the per-segment envelope within its 1 MiB canonical bound.
 * TCRN-CROSS-MIN-102 裁定四.
 */
export const CONFERENCE_POSITION_CEILING_BYTES = 8_192;

export class ConferenceError extends Error {
  readonly reasonCode: ConferenceReasonCode;
  constructor(reasonCode: ConferenceReasonCode, message: string) {
    super(message);
    this.name = "ConferenceError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: ConferenceReasonCode, message: string): never {
  throw new ConferenceError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("CONFERENCE_SCHEMA_INVALID", label);
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string, optional: readonly string[] = []): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  const allowed = [...fields, ...optional];
  const unknown = actual.filter((field) => !allowed.includes(field));
  if (unknown.length > 0) fail("CONFERENCE_UNKNOWN_FIELD", `${label}:${unknown.join(",")}`);
  if (wanted.some((field) => !actual.includes(field))) fail("CONFERENCE_SCHEMA_INVALID", label);
}

function id(value: unknown, label: string): string {
  try { assertProtocolId(value); } catch { fail("CONFERENCE_SCHEMA_INVALID", label); }
  return value as string;
}

function text(value: unknown, label: string, budget: number = maximumTextBytes): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.length === 0) fail("CONFERENCE_UNICODE_INVALID", label);
  if (Buffer.byteLength(value, "utf8") > budget) fail("CONFERENCE_BUDGET_EXCEEDED", label);
  return value;
}

function instant(value: unknown, label: string): string {
  try { parseStrictInstant(value); } catch { fail("CONFERENCE_SCHEMA_INVALID", label); }
  return value as string;
}

function boundedTextArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value)) fail("CONFERENCE_SCHEMA_INVALID", label);
  if (value.length > maximum) fail("CONFERENCE_BUDGET_EXCEEDED", label);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function idArray(value: unknown, label: string, { min = 0, max = 64, unique = true } = {}): readonly string[] {
  if (!Array.isArray(value)) fail("CONFERENCE_SCHEMA_INVALID", label);
  if (value.length < min) fail("CONFERENCE_ANCHOR_REQUIRED", label);
  if (value.length > max) fail("CONFERENCE_BUDGET_EXCEEDED", label);
  const ids = value.map((entry, index) => id(entry, `${label}[${index}]`));
  if (unique && new Set(ids).size !== ids.length) fail("CONFERENCE_SCHEMA_INVALID", `${label} duplicate`);
  return ids;
}

function extensions(value: unknown): Readonly<Record<string, unknown>> {
  const map = record(value, "extensions");
  const keys = Object.keys(map);
  if (keys.length > maximumExtensionProperties) fail("CONFERENCE_BUDGET_EXCEEDED", "extensions");
  for (const key of keys) {
    id(key, `extensions key ${key}`);
    const entry = record(map[key], `extensions.${key}`);
    exact(entry, ["required", "value"], `extensions.${key}`);
    if (typeof entry.required !== "boolean") fail("CONFERENCE_SCHEMA_INVALID", `extensions.${key}.required`);
  }
  return map;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function common(document: Readonly<Record<string, unknown>>): { revision: number; updatedAt: string; tombstone: boolean; extensions: Readonly<Record<string, unknown>> } {
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 1) fail("CONFERENCE_SCHEMA_INVALID", "revision");
  if (typeof document.tombstone !== "boolean") fail("CONFERENCE_SCHEMA_INVALID", "tombstone");
  return { revision: document.revision as number, updatedAt: instant(document.updatedAt, "updatedAt"), tombstone: document.tombstone as boolean, extensions: extensions(document.extensions) };
}

export interface ConferenceRequest {
  readonly schemaVersion: typeof CONFERENCE_REQUEST_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly type: typeof CONFERENCE_TYPES[number];
  readonly title: string;
  readonly linkedWorkIds: readonly string[];
  readonly desiredOutcome: string;
  readonly participantIds: readonly string[];
  readonly status: typeof CONFERENCE_STATUSES[number];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateConferenceRequest(value: unknown): ConferenceRequest {
  const document = record(value, "conference request");
  if (document.schemaVersion !== CONFERENCE_REQUEST_VERSION) fail("CONFERENCE_SCHEMA_INVALID", "request schemaVersion");
  exact(document, ["schemaVersion", "id", "projectId", "type", "title", "linkedWorkIds", "desiredOutcome", "participantIds", "status", "revision", "updatedAt", "tombstone", "extensions"], "conference request");
  if (!CONFERENCE_TYPES.includes(document.type as ConferenceRequest["type"])) fail("CONFERENCE_SCHEMA_INVALID", "request type");
  if (!CONFERENCE_STATUSES.includes(document.status as ConferenceRequest["status"])) fail("CONFERENCE_SCHEMA_INVALID", "request status");
  if (typeof document.desiredOutcome !== "string" || document.desiredOutcome.length === 0) fail("CONFERENCE_DESIRED_OUTCOME_REQUIRED", "desiredOutcome");
  return deepFreeze({
    schemaVersion: CONFERENCE_REQUEST_VERSION,
    id: id(document.id, "id"),
    projectId: id(document.projectId, "projectId"),
    type: document.type as ConferenceRequest["type"],
    title: text(document.title, "title"),
    linkedWorkIds: idArray(document.linkedWorkIds, "linkedWorkIds", { min: 1 }),
    desiredOutcome: text(document.desiredOutcome, "desiredOutcome"),
    participantIds: idArray(document.participantIds, "participantIds"),
    status: document.status as ConferenceRequest["status"],
    ...common(document),
  });
}

export interface ConferencePosition {
  readonly schemaVersion: typeof CONFERENCE_POSITION_VERSION;
  readonly id: string;
  readonly conferenceId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly stance?: string;
  readonly position: string;
  readonly risks: readonly string[];
  readonly recommendations: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateConferencePosition(value: unknown): ConferencePosition {
  const document = record(value, "conference position");
  if (document.schemaVersion !== CONFERENCE_POSITION_VERSION) fail("CONFERENCE_SCHEMA_INVALID", "position schemaVersion");
  exact(document, ["schemaVersion", "id", "conferenceId", "projectId", "actorId", "position", "risks", "recommendations", "evidenceIds", "revision", "updatedAt", "tombstone", "extensions"], "conference position", ["stance"]);
  const stance = Object.hasOwn(document, "stance") ? text(document.stance, "stance") : undefined;
  return deepFreeze({
    schemaVersion: CONFERENCE_POSITION_VERSION,
    id: id(document.id, "id"),
    conferenceId: id(document.conferenceId, "conferenceId"),
    projectId: id(document.projectId, "projectId"),
    actorId: id(document.actorId, "actorId"),
    ...(stance === undefined ? {} : { stance }),
    position: text(document.position, "position", CONFERENCE_POSITION_CEILING_BYTES),
    risks: boundedTextArray(document.risks, "risks", 32),
    recommendations: boundedTextArray(document.recommendations, "recommendations", 32),
    evidenceIds: idArray(document.evidenceIds, "evidenceIds", { max: 32 }),
    ...common(document),
  });
}

export interface ConferenceMinutes {
  readonly schemaVersion: typeof CONFERENCE_MINUTES_VERSION;
  readonly id: string;
  readonly conferenceId: string;
  readonly projectId: string;
  readonly summary: string;
  readonly outcomeClass: typeof CONFERENCE_OUTCOME_CLASSES[number];
  readonly decisions: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function validateConferenceMinutes(value: unknown): ConferenceMinutes {
  const document = record(value, "conference minutes");
  if (document.schemaVersion !== CONFERENCE_MINUTES_VERSION) fail("CONFERENCE_SCHEMA_INVALID", "minutes schemaVersion");
  exact(document, ["schemaVersion", "id", "conferenceId", "projectId", "summary", "outcomeClass", "decisions", "unresolvedIssues", "revision", "updatedAt", "tombstone", "extensions"], "conference minutes");
  if (!CONFERENCE_OUTCOME_CLASSES.includes(document.outcomeClass as ConferenceMinutes["outcomeClass"])) fail("CONFERENCE_SCHEMA_INVALID", "minutes outcomeClass");
  return deepFreeze({
    schemaVersion: CONFERENCE_MINUTES_VERSION,
    id: id(document.id, "id"),
    conferenceId: id(document.conferenceId, "conferenceId"),
    projectId: id(document.projectId, "projectId"),
    summary: text(document.summary, "summary"),
    outcomeClass: document.outcomeClass as ConferenceMinutes["outcomeClass"],
    decisions: boundedTextArray(document.decisions, "decisions", 32),
    unresolvedIssues: boundedTextArray(document.unresolvedIssues, "unresolvedIssues", 32),
    ...common(document),
  });
}

// The conference.created replay arm checks a request with this: a conference is opened open. The
// write verbs that opened, argued, closed and cancelled conferences, the close's distillation into
// knowledge candidates and the position-to-conference binding they used were retired by
// TCRN-CROSS-STORY-475 R3 (MIN-227 D10); decisions are recorded as minutes (minutes.ts) and every
// conference event already on a chain still replays.
export function openConference(value: unknown): ConferenceRequest {
  const request = validateConferenceRequest(value);
  if (request.status !== "open") fail("CONFERENCE_SCHEMA_INVALID", "opened conference must be status open");
  return request;
}

export function listConferencesByWorkItem(workId: unknown, requests: readonly unknown[]): readonly ConferenceRequest[] {
  const target = id(workId, "workId");
  return requests
    .map((value) => validateConferenceRequest(value))
    .filter((request) => !request.tombstone && request.linkedWorkIds.includes(target))
    .sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}
