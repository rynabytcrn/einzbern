// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-468 R2, R3 and STORY-469 R5 (MIN-227 D20, D21): akasha, the event truth of a
// library. Every device writes only its own directory, `akasha/<device id>/`, which holds its
// segments and one stream manifest; nothing in a library has two writers, so a sync client can
// never produce a conflicted copy of an event file.
//
// A segment is canonical NDJSON, one event per line, named by an eight-digit lowercase hex
// ordinal (`00000001.ndjson`). An imported old-layout stream may also hold `.json` segments,
// the JSON arrays its old engine wrote, byte for byte. The stream manifest names every
// committed segment with its sequence range, byte length and SHA-256, and it is replaced
// atomically after the segment bytes are durable: it is the commit point. A reader trusts only
// the manifest: it reads each named segment up to the recorded length, so bytes a crashed
// writer appended after its last manifest are never read, and the next append on that device
// cuts them off before it writes.
//
// Appends on one machine are serialised by the device-local lock of the library
// (device-home lockPath), so two processes of one device continue one sequence. Each new event
// takes the next sequence of its stream and a clock one above the largest clock any stream
// manifest on this machine records (R3).

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile as readFileBytes } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  EVENT_SCHEMA_VERSION,
  assertCanonicalJson,
  canonicalJson,
  createEvent,
  deriveEventId,
  deriveLegacyEventId,
  deriveStreamId,
  eventClock,
  findStreamChainBreak,
  isDeviceId,
} from "../../protocol/src/index.js";
import type { EventRecord, JsonValue } from "../../protocol/src/index.js";
import { writeFileAtomic, isAtomicTemporaryName } from "./atomic-file.js";
import { ensureDeviceDirectory, lockPath } from "./device-home.js";
import { readDevice } from "./device-identity.js";
import type { DeviceIdentity } from "./device-identity.js";
import type { Library } from "./ether-library.js";
import { LIBRARY_FORMAT_VERSION } from "./ether-library.js";
import { withFileLock } from "./file-lock.js";
import type { FileLockOptions } from "./file-lock.js";
import { assertLibrarySupported, upgradeReadiness } from "./format-version.js";
import type { DeviceEngine, UpgradeReadiness } from "./format-version.js";
import { DIRECTORY } from "./names.js";
import { FRAMEWORK_VERSION } from "./index.js";

export const STREAM_MANIFEST_SCHEMA_VERSION = "einzbern.stream-manifest.v1" as const;
export const STREAM_MANIFEST_FILE = "manifest.json" as const;
export const AKASHA_SEGMENT_BYTES_DEFAULT = 1_048_576 as const;
// One segment is never read past this, whatever a manifest claims.
export const AKASHA_SEGMENT_BYTES_MAXIMUM = 67_108_864 as const;
const SEGMENT_NAME_PATTERN = /^[0-9a-f]{8}\.(?:ndjson|json)$/u;

export const AKASHA_REASON_CODES = Object.freeze([
  "AKASHA_EVENT_CORRUPT",
  "AKASHA_INPUT_INVALID",
  "AKASHA_READ_TIMEOUT",
  "AKASHA_SEGMENT_CORRUPT",
  "AKASHA_STREAM_MANIFEST_INVALID",
  "AKASHA_WRITE_INTERRUPTED",
] as const);
export type AkashaReasonCode = typeof AKASHA_REASON_CODES[number];

export class AkashaError extends Error {
  readonly reasonCode: AkashaReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: AkashaReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "AkashaError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export type StreamIdentityScheme = "einzbern" | "legacy";

export interface StreamSegment {
  readonly name: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface StreamManifest {
  readonly schemaVersion: typeof STREAM_MANIFEST_SCHEMA_VERSION;
  readonly streamId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly identityScheme: StreamIdentityScheme;
  readonly sequence: number;
  readonly headEventHash: string | null;
  readonly clockHighWater: number;
  readonly segments: readonly StreamSegment[];
  readonly engineVersion: string;
  readonly formatVersion: number;
}

export interface EventDraft {
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

function fail(reasonCode: AkashaReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new AkashaError(reasonCode, message, details);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function streamDirectory(libraryRoot: string, deviceId: string): string {
  if (!isDeviceId(deviceId)) fail("AKASHA_INPUT_INVALID", `${deviceId} is not a device id`);
  return join(libraryRoot, DIRECTORY.events, deviceId);
}

/** The eight-digit hex name of the segment at a 1-based ordinal. */
export function segmentName(ordinal: number, extension: "ndjson" | "json" = "ndjson"): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 0xffffffff) fail("AKASHA_INPUT_INVALID", `segment ordinal ${ordinal}`);
  return `${ordinal.toString(16).padStart(8, "0")}.${extension}`;
}

/** The id the event at `sequence` of this stream must carry. */
export function streamEventId(manifest: Pick<StreamManifest, "streamId" | "identityScheme">, sequence: number): string {
  return manifest.identityScheme === "legacy" ? deriveLegacyEventId(manifest.streamId, sequence) : deriveEventId(manifest.streamId, sequence);
}

const MANIFEST_FIELDS = ["clockHighWater", "deviceId", "displayName", "engineVersion", "formatVersion", "headEventHash", "identityScheme", "schemaVersion", "segments", "sequence", "streamId"];
const SEGMENT_FIELDS = ["bytes", "firstSequence", "lastSequence", "name", "sha256"];

export function validateStreamManifest(value: unknown, deviceId: string): StreamManifest {
  const where = { deviceId, file: `${DIRECTORY.events}/${deviceId}/${STREAM_MANIFEST_FILE}` };
  const invalid = (message: string): never => fail("AKASHA_STREAM_MANIFEST_INVALID", `${where.file}: ${message}`, where);
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("not an object");
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join("\u0000") !== MANIFEST_FIELDS.join("\u0000")) invalid("fields are not exact");
  if (record.schemaVersion !== STREAM_MANIFEST_SCHEMA_VERSION) invalid(`schemaVersion must be ${STREAM_MANIFEST_SCHEMA_VERSION}`);
  if (record.deviceId !== deviceId) invalid("deviceId does not name its own directory");
  if (typeof record.streamId !== "string" || !/^stream:[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.streamId)) invalid("streamId");
  if (typeof record.displayName !== "string" || record.displayName.length === 0 || record.displayName.length > 64) invalid("displayName");
  if (record.identityScheme !== "einzbern" && record.identityScheme !== "legacy") invalid("identityScheme");
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 0) invalid("sequence");
  const sequence = Number(record.sequence);
  if ((sequence === 0) !== (record.headEventHash === null)) invalid("headEventHash is null exactly when the stream is empty");
  if (record.headEventHash !== null && (typeof record.headEventHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.headEventHash))) invalid("headEventHash");
  if (!Number.isSafeInteger(record.clockHighWater) || Number(record.clockHighWater) < sequence) invalid("clockHighWater");
  if (typeof record.engineVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(record.engineVersion)) invalid("engineVersion");
  if (!Number.isSafeInteger(record.formatVersion) || Number(record.formatVersion) < 1) invalid("formatVersion");
  if (!Array.isArray(record.segments)) invalid("segments");
  const segments: StreamSegment[] = [];
  let next = 1;
  for (const [index, entry] of (record.segments as readonly unknown[]).entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).sort().join("\u0000") !== SEGMENT_FIELDS.join("\u0000")) invalid(`segment ${index + 1} fields`);
    const segment = entry as Readonly<Record<string, unknown>>;
    if (typeof segment.name !== "string" || !SEGMENT_NAME_PATTERN.test(segment.name)) invalid(`segment ${index + 1} name`);
    if (segment.firstSequence !== next || !Number.isSafeInteger(segment.lastSequence) || Number(segment.lastSequence) < next) invalid(`segment ${index + 1} sequence range`);
    if (!Number.isSafeInteger(segment.bytes) || Number(segment.bytes) < 1 || Number(segment.bytes) > AKASHA_SEGMENT_BYTES_MAXIMUM) invalid(`segment ${index + 1} bytes`);
    if (typeof segment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(segment.sha256)) invalid(`segment ${index + 1} sha256`);
    segments.push(Object.freeze({
      name: String(segment.name),
      firstSequence: next,
      lastSequence: Number(segment.lastSequence),
      bytes: Number(segment.bytes),
      sha256: String(segment.sha256),
    }));
    next = Number(segment.lastSequence) + 1;
  }
  if (next - 1 !== sequence) invalid("segments do not end at the stream sequence");
  if (new Set(segments.map((segment) => segment.name)).size !== segments.length) invalid("segment names repeat");
  return Object.freeze({
    schemaVersion: STREAM_MANIFEST_SCHEMA_VERSION,
    streamId: String(record.streamId),
    deviceId,
    displayName: String(record.displayName),
    identityScheme: record.identityScheme as StreamIdentityScheme,
    sequence,
    headEventHash: record.headEventHash as string | null,
    clockHighWater: Number(record.clockHighWater),
    segments: Object.freeze(segments),
    engineVersion: String(record.engineVersion),
    formatVersion: Number(record.formatVersion),
  });
}

export type ReadBytes = (path: string) => Promise<Buffer>;

export interface StreamReadOptions {
  // Test seam: how file bytes are read (a sync client's placeholder can block this).
  readonly readFile?: ReadBytes;
}

/** The device directories under akasha/, sorted. Temporary and foreign entries are skipped. */
export async function listStreamDevices(libraryRoot: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(join(libraryRoot, DIRECTORY.events), { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !isAtomicTemporaryName(entry.name) && isDeviceId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A device's stream manifest, or null when its directory holds none yet. A manifest is the
 * commit point, so a stream without one has no committed events; a manifest that exists but
 * does not validate fails closed.
 */
export async function readStreamManifest(libraryRoot: string, deviceId: string, options: StreamReadOptions = {}): Promise<StreamManifest | null> {
  const path = join(streamDirectory(libraryRoot, deviceId), STREAM_MANIFEST_FILE);
  let bytes: Buffer;
  try {
    bytes = await (options.readFile ?? readFileBytes)(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let parsed: JsonValue;
  try {
    parsed = assertCanonicalJson(bytes.toString("utf8"));
  } catch {
    fail("AKASHA_STREAM_MANIFEST_INVALID", `${DIRECTORY.events}/${deviceId}/${STREAM_MANIFEST_FILE} is not canonical JSON`, { deviceId });
  }
  // TCRN-CROSS-STORY-471 R1: a stream a newer format wrote is refused before its shape is judged.
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    assertLibrarySupported({ formatVersion: (parsed as Readonly<Record<string, unknown>>).formatVersion }, {
      engineVersion: FRAMEWORK_VERSION,
      where: `stream ${DIRECTORY.events}/${deviceId}`,
      details: { deviceId },
    });
  }
  return validateStreamManifest(parsed, deviceId);
}

function parseSegment(manifest: StreamManifest, segment: StreamSegment, bytes: Buffer): EventRecord[] {
  const where = { deviceId: manifest.deviceId, streamId: manifest.streamId, segment: segment.name };
  const text = bytes.toString("utf8");
  let values: unknown[];
  if (segment.name.endsWith(".ndjson")) {
    if (!text.endsWith("\n") || text.endsWith("\n\n")) fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} is not canonical NDJSON`, where);
    values = text.split("\n").slice(0, -1).map((line, index) => {
      try {
        return assertCanonicalJson(`${line}\n`);
      } catch {
        return fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} line ${index + 1} is not canonical JSON`, { ...where, sequence: String(segment.firstSequence + index) });
      }
    });
  } else {
    let parsed: JsonValue;
    try {
      parsed = assertCanonicalJson(text);
    } catch {
      fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} is not a canonical JSON array`, where);
    }
    if (!Array.isArray(parsed)) fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} is not an event array`, where);
    values = [...parsed];
  }
  if (values.length !== segment.lastSequence - segment.firstSequence + 1) {
    fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} holds ${values.length} events, its manifest says ${segment.lastSequence - segment.firstSequence + 1}`, where);
  }
  return values as EventRecord[];
}

/** Read one segment's committed bytes: exactly the recorded length, which must hash as recorded. */
async function readSegmentBytes(libraryRoot: string, manifest: StreamManifest, segment: StreamSegment, readFile: ReadBytes): Promise<{ readonly bytes: Buffer; readonly digestMatches: boolean }> {
  const where = { deviceId: manifest.deviceId, streamId: manifest.streamId, segment: segment.name };
  let content: Buffer;
  try {
    content = await readFile(join(streamDirectory(libraryRoot, manifest.deviceId), segment.name));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} is missing`, where);
    if (code === "EISDIR") fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} is not a file`, where);
    throw error;
  }
  if (content.length < segment.bytes) fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} is shorter than its manifest records`, where);
  const committed = content.subarray(0, segment.bytes);
  return { bytes: committed, digestMatches: sha256(committed) === segment.sha256 };
}

/**
 * Every committed event of one stream, validated link by link: identity, sequence, rising
 * clock, hashes and priorHash, ending at the manifest's head. A break fails closed with the
 * device, stream and sequence where the stream stops being provable.
 */
export async function readStreamEvents(libraryRoot: string, manifest: StreamManifest, options: StreamReadOptions = {}): Promise<readonly EventRecord[]> {
  const readFile = options.readFile ?? readFileBytes;
  const events: EventRecord[] = [];
  let mismatched: StreamSegment | null = null;
  for (const segment of manifest.segments) {
    const { bytes, digestMatches } = await readSegmentBytes(libraryRoot, manifest, segment, readFile);
    if (!digestMatches && mismatched === null) mismatched = segment;
    events.push(...parseSegment(manifest, segment, bytes));
  }
  // A segment that no longer hashes as recorded is still read, so a change made in place is
  // reported where the stream stops being provable (TCRN-CROSS-STORY-467 AC3); a digest that
  // is wrong while every event checks out is reported against the segment.
  const found = findStreamChainBreak(events, {
    streamId: manifest.streamId,
    eventId: (sequence) => streamEventId(manifest, sequence),
    ...(manifest.identityScheme === "einzbern" ? { deviceId: manifest.deviceId } : {}),
  });
  if (found !== null) {
    const holding = manifest.segments.find((segment) => segment.firstSequence <= found.sequence && found.sequence <= segment.lastSequence);
    fail("AKASHA_EVENT_CORRUPT", `stream ${manifest.streamId} of device ${manifest.deviceId} breaks at sequence ${found.sequence} (${found.kind})`, {
      deviceId: manifest.deviceId,
      streamId: manifest.streamId,
      sequence: String(found.sequence),
      eventId: found.eventId,
      break: found.kind,
      ...(holding === undefined ? {} : { segment: holding.name }),
    });
  }
  if (mismatched !== null) {
    fail("AKASHA_SEGMENT_CORRUPT", `${mismatched.name} does not hash as its manifest records`, { deviceId: manifest.deviceId, streamId: manifest.streamId, segment: mismatched.name });
  }
  const head = events.at(-1);
  if ((head?.eventHash ?? null) !== manifest.headEventHash || (head !== undefined && eventClock(head) !== manifest.clockHighWater)) {
    fail("AKASHA_EVENT_CORRUPT", `stream ${manifest.streamId} of device ${manifest.deviceId} does not end at its manifest's head`, {
      deviceId: manifest.deviceId,
      streamId: manifest.streamId,
      sequence: String(manifest.sequence),
      break: "head",
    });
  }
  return events;
}

/**
 * Every device a library knows, from its akasha/ directories, with the engine version its stream
 * manifest records; a directory without a committed manifest is a device whose version is unknown
 * (TCRN-CROSS-STORY-471 R4). Nothing is written.
 */
export async function readStreamDevices(libraryRoot: string, options: StreamReadOptions = {}): Promise<readonly DeviceEngine[]> {
  const devices: DeviceEngine[] = [];
  for (const deviceId of await listStreamDevices(libraryRoot)) {
    const manifest = await readStreamManifest(libraryRoot, deviceId, options);
    devices.push({ deviceId, displayName: manifest?.displayName ?? null, engineVersion: manifest?.engineVersion ?? null });
  }
  return devices;
}

/**
 * Whether every device of the library runs an engine that may meet the target format, judged for
 * this engine as the writer (format-version.ts upgradeReadiness). A write that would raise the
 * library's format calls this and assertUpgradeReady before it writes (TCRN-CROSS-STORY-471 R4).
 */
export async function libraryUpgradeReadiness(library: Library, options: { readonly targetFormat?: number; readonly home?: string } = {}): Promise<UpgradeReadiness> {
  const self = options.home === undefined ? await readDevice() : await readDevice(options.home);
  return upgradeReadiness({
    formatVersion: library.manifest.formatVersion,
    minEngineVersion: library.manifest.minEngineVersion,
    devices: await readStreamDevices(library.root),
  }, {
    engineVersion: FRAMEWORK_VERSION,
    selfDeviceId: self?.deviceId ?? null,
    ...(options.targetFormat === undefined ? {} : { targetFormat: options.targetFormat }),
  });
}

/** The largest clock any stream manifest on this machine records: the next event's clock is one above it. */
export async function clockHighWater(libraryRoot: string, options: StreamReadOptions = {}): Promise<number> {
  let highest = 0;
  for (const deviceId of await listStreamDevices(libraryRoot)) {
    const manifest = await readStreamManifest(libraryRoot, deviceId, options);
    if (manifest !== null && manifest.clockHighWater > highest) highest = manifest.clockHighWater;
  }
  return highest;
}

/** Run `operation` while holding this machine's write lock of the library. */
export async function withLibraryWriteLock<T>(library: Library, operation: () => Promise<T>, options: FileLockOptions & { readonly home?: string } = {}): Promise<T> {
  const path = options.home === undefined ? lockPath(library.manifest.libraryId) : lockPath(library.manifest.libraryId, options.home);
  await ensureDeviceDirectory(dirname(path));
  return withFileLock(path, operation, options);
}

export interface AppendOptions {
  // storage.segmentBytes: a segment that would grow past this is closed and a new one begun.
  readonly segmentBytes?: number;
  // Test seam: a simulated process death after the segment bytes are durable and before the
  // stream manifest is replaced.
  readonly crashAt?: "after-segment-write";
}

export interface StreamOwner {
  readonly deviceId: string;
  readonly displayName: string;
}

/** A stream's manifest before its first event. */
export function emptyStreamManifest(library: Library, device: StreamOwner): StreamManifest {
  return Object.freeze({
    schemaVersion: STREAM_MANIFEST_SCHEMA_VERSION,
    streamId: deriveStreamId(library.manifest.libraryId, device.deviceId),
    deviceId: device.deviceId,
    displayName: device.displayName,
    identityScheme: "einzbern",
    sequence: 0,
    headEventHash: null,
    clockHighWater: 0,
    segments: Object.freeze([]),
    engineVersion: FRAMEWORK_VERSION,
    formatVersion: LIBRARY_FORMAT_VERSION,
  });
}

/**
 * Build the next events of a stream from drafts: consecutive sequences after the stream's head,
 * and clocks rising from one above `clockBase` (the largest clock seen on this machine). Pure.
 */
export function buildStreamEvents(manifest: StreamManifest, drafts: readonly EventDraft[], clockBase: number): readonly EventRecord[] {
  const events: EventRecord[] = [];
  let clock = Math.max(clockBase, manifest.clockHighWater);
  let priorHash = manifest.headEventHash;
  for (const [index, draft] of drafts.entries()) {
    const sequence = manifest.sequence + index + 1;
    clock += 1;
    const event = createEvent({
      id: streamEventId(manifest, sequence),
      streamId: manifest.streamId,
      sequence,
      clock,
      deviceId: manifest.deviceId,
      occurredAt: draft.occurredAt,
      priorHash,
      payload: draft.payload,
    }, EVENT_SCHEMA_VERSION);
    events.push(event);
    priorHash = event.eventHash;
  }
  return events;
}

async function durableWrite(path: string, bytes: string, flags: "a" | "w"): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateTo(path: string, length: number): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const size = (await handle.stat()).size;
    if (size < length) fail("AKASHA_SEGMENT_CORRUPT", `${path} is shorter than its manifest records`);
    if (size > length) {
      await handle.truncate(length);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

/**
 * Append already-built events to this device's stream and commit them by replacing the stream
 * manifest. The caller holds the library write lock and passes the manifest it read under it.
 * Bytes past the manifest's last committed length (a crashed writer's tail) are cut off first.
 */
export async function appendStreamEvents(
  library: Library,
  manifest: StreamManifest,
  events: readonly EventRecord[],
  options: AppendOptions = {},
): Promise<StreamManifest> {
  if (events.length === 0) fail("AKASHA_INPUT_INVALID", "an append carries at least one event");
  const segmentBytes = options.segmentBytes ?? AKASHA_SEGMENT_BYTES_DEFAULT;
  const directory = streamDirectory(library.root, manifest.deviceId);
  await mkdir(directory, { recursive: true });
  const found = findStreamChainBreak(events, {
    streamId: manifest.streamId,
    eventId: (sequence) => streamEventId(manifest, sequence),
    deviceId: manifest.deviceId,
    firstSequence: manifest.sequence + 1,
    priorHash: manifest.headEventHash,
    priorClock: manifest.clockHighWater,
  });
  if (found !== null) fail("AKASHA_INPUT_INVALID", `event at sequence ${found.sequence} does not continue the stream (${found.kind})`);
  const segments = [...manifest.segments];
  const last = segments.at(-1);
  // The active segment: the last one, if it is NDJSON and has room; otherwise a new one. Bytes a
  // crashed writer left after the committed length are cut off before anything is appended.
  let active: StreamSegment | null = last !== undefined && last.name.endsWith(".ndjson") && last.bytes < segmentBytes ? last : null;
  if (active !== null) await truncateTo(join(directory, active.name), active.bytes);
  const appended = new Map<string, string>();
  const fresh = new Set<string>();
  for (const event of events) {
    const line = canonicalJson(event);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (active === null || (active.bytes > 0 && active.bytes + lineBytes > segmentBytes)) {
      active = { name: segmentName(segments.length + 1), firstSequence: event.sequence, lastSequence: event.sequence - 1, bytes: 0, sha256: "" };
      segments.push(active);
      fresh.add(active.name);
    }
    appended.set(active.name, `${appended.get(active.name) ?? ""}${line}`);
    active = { ...active, lastSequence: event.sequence, bytes: active.bytes + lineBytes };
    segments[segments.length - 1] = active;
  }
  // A fresh segment is written whole (replacing any uncommitted file of that name); the
  // active one is appended to.
  for (const [name, bytes] of appended) {
    await durableWrite(join(directory, name), bytes, fresh.has(name) ? "w" : "a");
  }
  const committed: StreamSegment[] = [];
  for (const segment of segments) {
    if (!appended.has(segment.name)) {
      committed.push(segment);
      continue;
    }
    const bytes = (await readFileBytes(join(directory, segment.name))).subarray(0, segment.bytes);
    if (bytes.length !== segment.bytes) fail("AKASHA_SEGMENT_CORRUPT", `${segment.name} readback is short`);
    committed.push(Object.freeze({ ...segment, sha256: sha256(bytes) }));
  }
  if (options.crashAt === "after-segment-write") {
    fail("AKASHA_WRITE_INTERRUPTED", "interrupted after the segment write, before the manifest", { deviceId: manifest.deviceId });
  }
  const head = events.at(-1) as EventRecord;
  const next: StreamManifest = Object.freeze({
    ...manifest,
    sequence: head.sequence,
    headEventHash: head.eventHash,
    clockHighWater: eventClock(head),
    segments: Object.freeze(committed),
    engineVersion: FRAMEWORK_VERSION,
    formatVersion: LIBRARY_FORMAT_VERSION,
  });
  await writeFileAtomic(join(directory, STREAM_MANIFEST_FILE), canonicalJson(validateStreamManifest(next, manifest.deviceId)));
  return next;
}

/**
 * The whole write of drafts to this device's stream, under the library write lock: read every
 * stream manifest for the clock, build the events, append and commit.
 */
export async function appendToOwnStream(
  library: Library,
  device: Pick<DeviceIdentity, "deviceId" | "displayName">,
  drafts: readonly EventDraft[],
  options: AppendOptions & FileLockOptions & { readonly home?: string } = {},
): Promise<{ readonly manifest: StreamManifest; readonly events: readonly EventRecord[] }> {
  return withLibraryWriteLock(library, async () => {
    const manifest = await readStreamManifest(library.root, device.deviceId) ?? emptyStreamManifest(library, device);
    const events = buildStreamEvents(manifest, drafts, await clockHighWater(library.root));
    return { manifest: await appendStreamEvents(library, manifest, events, options), events };
  }, options);
}

// TCRN-CROSS-STORY-468 R3, R4 and STORY-470 R4: reading every stream of a library. Each read of a
// file carries a timeout, because a sync client may have evicted a segment to a placeholder
// whose read blocks until the file is fetched: a read that does not finish in time fails with
// AKASHA_READ_TIMEOUT naming the device and the file, rather than hanging the engine.
export const AKASHA_READ_TIMEOUT_DEFAULT_MS = 30_000 as const;

export interface LibraryReadOptions extends StreamReadOptions {
  readonly timeoutMs?: number;
}

export interface StreamRead {
  readonly deviceId: string;
  // null: the device directory holds no manifest yet, so the stream has no committed events.
  readonly manifest: StreamManifest | null;
  readonly events: readonly EventRecord[];
}

export interface MergedEvent {
  readonly event: EventRecord;
  readonly deviceId: string;
  readonly streamId: string;
  readonly clock: number;
}

export interface LibraryRead {
  readonly streams: readonly StreamRead[];
  // Every committed event of every stream, in merge order: clock, then device id, then sequence.
  readonly events: readonly MergedEvent[];
  // Each device's stream sequence: the library's version is this vector, not one number.
  readonly versionVector: Readonly<Record<string, number>>;
}

function timed(readFile: ReadBytes, timeoutMs: number, deviceId: string): ReadBytes {
  return (path) => new Promise<Buffer>((resolveRead, rejectRead) => {
    const timer = setTimeout(() => {
      rejectRead(new AkashaError("AKASHA_READ_TIMEOUT", `reading ${path} did not finish in ${timeoutMs} ms`, {
        deviceId,
        file: path.split(/[\\/]/u).slice(-2).join("/"),
        timeoutMs: String(timeoutMs),
      }));
    }, timeoutMs);
    readFile(path).then((bytes) => {
      clearTimeout(timer);
      resolveRead(bytes);
    }, (error: unknown) => {
      clearTimeout(timer);
      rejectRead(error);
    });
  });
}

/** Merge order: clock, then device id, then sequence. The same streams merge the same way on every device. */
export function compareMergedEvents(left: MergedEvent, right: MergedEvent): number {
  return left.clock - right.clock ||
    (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0) ||
    left.event.sequence - right.event.sequence;
}

/**
 * Read and validate every stream of a library and merge their events. A structural failure in
 * any stream (a manifest, a segment digest, an event's identity, hash, priorHash or clock) fails
 * closed, naming the device, stream and sequence; whether events apply to the merged state is
 * the reducer's question, not this one.
 */
export async function readAllStreams(libraryRoot: string, options: LibraryReadOptions = {}): Promise<LibraryRead> {
  const readFile = options.readFile ?? readFileBytes;
  const timeoutMs = options.timeoutMs ?? AKASHA_READ_TIMEOUT_DEFAULT_MS;
  const streams: StreamRead[] = [];
  const merged: MergedEvent[] = [];
  const versionVector: Record<string, number> = {};
  for (const deviceId of await listStreamDevices(libraryRoot)) {
    const reader = timed(readFile, timeoutMs, deviceId);
    const manifest = await readStreamManifest(libraryRoot, deviceId, { readFile: reader });
    const events = manifest === null ? [] : await readStreamEvents(libraryRoot, manifest, { readFile: reader });
    streams.push({ deviceId, manifest, events });
    if (manifest === null) continue;
    versionVector[deviceId] = manifest.sequence;
    for (const event of events) merged.push({ event, deviceId, streamId: manifest.streamId, clock: eventClock(event) });
  }
  merged.sort(compareMergedEvents);
  return { streams, events: merged, versionVector: Object.freeze(versionVector) };
}
