import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-467 R3 (MIN-227 D3): the local telemetry store is retired -- nothing
// writes, reads, counts or prunes telemetry records any more, and work-transition no longer
// cites one as evidence. What stays is the record shape and the evidence snapshot, because a
// work record that already carries advisory:evidence-snapshot is re-checked on replay.

import { canonicalJson, canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";

export const TELEMETRY_SCHEMA_VERSION = "tcrn.telemetry.v1" as const;
export const TELEMETRY_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"] as const);
export const TELEMETRY_LINE_BYTES = RUNTIME_CAPACITY.bufferBytes;
export type TelemetryAvailability = typeof TELEMETRY_AVAILABILITY[number];

export interface TelemetryUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export type TelemetryPayload = Readonly<Record<string, unknown>>;

export interface TelemetryRecord {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly session: string;
  readonly payload: TelemetryPayload;
}

export interface TelemetryEvidenceSnapshot {
  readonly schemaVersion: "tcrn.telemetry-evidence.v1";
  readonly id: string;
  readonly digest: string;
  readonly fields: {
    readonly at: string;
    readonly kind: string;
    readonly session: string;
    readonly payload: TelemetryPayload;
  };
}

export class TelemetryError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "TelemetryError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: string, message: string): never {
  throw new TelemetryError(reasonCode, message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("TELEMETRY_RECORD_INVALID", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function nullableText(value: unknown, label: string, _maximum = 256): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed() || value.includes("\u0000")) fail("TELEMETRY_RECORD_INVALID", `${label} must be null or bounded text`);
  canonicalJson(value);
  return value;
}

function requiredText(value: unknown, label: string, _maximum = 256): string {
  const result = nullableText(value, label, _maximum);
  if (result === null) fail("TELEMETRY_RECORD_INVALID", `${label} is required`);
  return result;
}

const FORBIDDEN_PAYLOAD_KEYS = /(?:prompt|body|content|transcript|stdin|stdout|stderr|secret|password|token(?!s)|response)/iu;

function safePayloadValue(value: unknown, key: string): unknown {
  const detached = JSON.parse(canonicalJson(value)) as unknown;
  const pending: { readonly value: unknown; readonly key: string }[] = [{ value: detached, key }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (typeof next.value === "string") {
      if (!next.value.isWellFormed() || next.value.includes("\u0000")) fail("TELEMETRY_RECORD_INVALID", `${next.key} contains invalid text`);
    } else if (next.value !== null && typeof next.value === "object") {
      for (const [childKey, childValue] of Object.entries(next.value)) {
        if (!Array.isArray(next.value) && (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(childKey) || FORBIDDEN_PAYLOAD_KEYS.test(childKey))) fail("TELEMETRY_RECORD_INVALID", `${next.key}.${childKey} is not an allowed telemetry field`);
        pending.push({ value: childValue, key: `${next.key}.${childKey}` });
      }
      Object.freeze(next.value);
    }
  }
  return detached;
}

function nullableCount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("TELEMETRY_RECORD_INVALID", `${label} must be a non-negative integer or null`);
  return Number(value);
}

function usage(value: unknown): TelemetryUsage | null {
  if (value === null || value === undefined) return null;
  const entry = object(value, "usage");
  const keys = Object.keys(entry).sort();
  if (canonicalJson(keys) !== canonicalJson(["inputTokens", "outputTokens", "totalTokens"])) fail("TELEMETRY_RECORD_INVALID", "usage fields are not exact");
  return {
    inputTokens: nullableCount(entry.inputTokens, "usage.inputTokens"),
    outputTokens: nullableCount(entry.outputTokens, "usage.outputTokens"),
    totalTokens: nullableCount(entry.totalTokens, "usage.totalTokens"),
  };
}

function payload(value: unknown): TelemetryPayload {
  const entry = object(value, "payload");
  const expected = ["availability", "dispatchId", "mode", "observedModel", "parentSession", "requestedModel", "requestedTier", "resolvedTier", "source", "taskClass", "usage", "workId"];
  if (canonicalJson(Object.keys(entry).sort()) === canonicalJson(expected)) {
    const availability = entry.availability;
    if (!(TELEMETRY_AVAILABILITY as readonly string[]).includes(availability as string)) fail("TELEMETRY_RECORD_INVALID", "availability");
    return Object.freeze({
      dispatchId: nullableText(entry.dispatchId, "dispatchId"),
      parentSession: nullableText(entry.parentSession, "parentSession"),
      workId: nullableText(entry.workId, "workId"),
      taskClass: nullableText(entry.taskClass, "taskClass", 128),
      mode: nullableText(entry.mode, "mode", 128),
      requestedTier: nullableText(entry.requestedTier, "requestedTier", 128),
      resolvedTier: nullableText(entry.resolvedTier, "resolvedTier", 128),
      requestedModel: nullableText(entry.requestedModel, "requestedModel"),
      observedModel: nullableText(entry.observedModel, "observedModel"),
      usage: usage(entry.usage),
      source: requiredText(entry.source, "source", 128),
      availability: availability as TelemetryAvailability,
    });
  }
  if (Object.keys(entry).length === 0 || typeof entry.source !== "string") fail("TELEMETRY_RECORD_INVALID", "payload requires a source");
  if (Object.keys(entry).some((key) => FORBIDDEN_PAYLOAD_KEYS.test(key))) fail("TELEMETRY_RECORD_INVALID", "payload contains private content");
  const safe: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(entry)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(key)) fail("TELEMETRY_RECORD_INVALID", "payload field name");
    safe[key] = safePayloadValue(entryValue, `payload.${key}`);
  }
  requiredText(safe.source, "payload.source", 128);
  return Object.freeze(safe);
}

export function validateTelemetryRecord(value: unknown): TelemetryRecord {
  const entry = object(value, "telemetry record");
  const expected = ["at", "id", "kind", "payload", "schemaVersion", "session"];
  if (canonicalJson(Object.keys(entry).sort()) !== canonicalJson(expected)) fail("TELEMETRY_RECORD_INVALID", "record fields are not exact");
  if (entry.schemaVersion !== TELEMETRY_SCHEMA_VERSION) fail("TELEMETRY_RECORD_INVALID", "schemaVersion");
  const at = requiredText(entry.at, "at", 64);
  try { parseStrictInstant(at); } catch { fail("TELEMETRY_RECORD_INVALID", "at is not a strict instant"); }
  const kind = requiredText(entry.kind, "kind", 128);
  const session = requiredText(entry.session, "session");
  const body = payload(entry.payload);
  const id = requiredText(entry.id, "id", 128);
  if (!/^telemetry:[a-f0-9]{24}$/u.test(id)) fail("TELEMETRY_RECORD_INVALID", "id");
  const record = Object.freeze({ schemaVersion: TELEMETRY_SCHEMA_VERSION, id, at, kind, session, payload: body });
  if (Buffer.byteLength(canonicalJson(record as unknown as import("../../protocol/src/index.js").JsonValue), "utf8") > TELEMETRY_LINE_BYTES) fail("TELEMETRY_RECORD_INVALID", `record exceeds ${TELEMETRY_LINE_BYTES} bytes`);
  return record;
}

export function telemetryEvidenceSnapshot(record: TelemetryRecord): TelemetryEvidenceSnapshot {
  const validated = validateTelemetryRecord(record);
  return Object.freeze({
    schemaVersion: "tcrn.telemetry-evidence.v1",
    id: validated.id,
    digest: canonicalSha256(validated as unknown as import("../../protocol/src/index.js").JsonValue),
    fields: Object.freeze({
      at: validated.at,
      kind: validated.kind,
      session: validated.session,
      payload: validated.payload,
    }),
  });
}
