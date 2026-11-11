// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { LibraryRead, StreamManifest, StreamSegment } from "./akasha.js";
import type { EventRecord } from "../../protocol/src/index.js";
import { readConsolidationIndex } from "./consolidation-format.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath, deviceHome, libraryDirectoryName } from "./device-home.js";
import { readDevice } from "./device-identity.js";
import type { Library, LibraryManifest } from "./ether-library.js";
import type { CacheSnapshotHeader } from "./library-cache.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { readStorageLocation } from "./storage-location.js";
import { observeAuthorityWork, observeCacheRead, observeCacheWrite, observeCacheReason, observeEventRead, observeVerificationHelper, observeVerificationRecord, observeVerifiedSegment } from "./recall-observation.js";

const SCHEMA = "einzbern.source-verification.v2";
const PROJECTION = "einzbern.verified-segment-events.v1";
const RECORD_DIRECTORY = "source-verification";
const REPLAY_RECORD_DIRECTORY = "replay-projections";
const REPLAY_SCHEMA = "einzbern.verified-replay-projection.v1";
const RECORD_MAX_BYTES = 65_536;
const FILE_COMMON = 0x8a0c0006;
const VOLUME = 0xc006d000;
const EXTENDED_FLAGS = 0x200;
const DATA_LENGTH = 0x200;
const active = new AsyncLocalStorage<VerificationSession>();

interface NativeIdentity {
  readonly boot: string;
  readonly mount: string;
  readonly volume: string;
  readonly device: number;
  readonly fileId: string;
  readonly generation: number;
  readonly length: string;
  readonly flags: number;
  readonly extendedFlags: string;
  readonly provider: Readonly<Record<string, unknown>>;
}
interface SegmentBinding {
  readonly libraryId: string;
  readonly sourceId: string;
  readonly archive: string;
  readonly streamId: string;
  readonly deviceId: string;
  readonly identityScheme: StreamManifest["identityScheme"];
  readonly segment: StreamSegment;
  readonly rootManifest: string;
  readonly sourceManifest: string;
}
interface PriorVerification {
  readonly schemaVersion: typeof SCHEMA;
  readonly engineVersion: string;
  readonly deviceIdentity: string;
  readonly projection: typeof PROJECTION;
  readonly binding: SegmentBinding;
  readonly native: NativeIdentity;
  readonly streamManifest: string;
  readonly head: string | null;
  readonly vector: number;
  readonly authority: string;
  readonly digest: string;
  readonly coverage: number;
  readonly projectionDigest: string;
  readonly projectionBytes: number;
}
interface Candidate {
  readonly key: string;
  readonly record: Omit<PriorVerification, "authority" | "projectionDigest" | "projectionBytes">;
  events?: readonly EventRecord[];
}
interface VerificationSession {
  readonly library: Library;
  readonly home: string;
  readonly deviceIdentity: string;
  readonly records: string;
  readonly cache: string;
  readonly pending: Candidate[];
  readonly reused: { readonly bytes: number; readonly streamId: string; readonly scope: "live" | "archive" }[];
  helperUnavailable: boolean;
  readonly files: Map<string, OpenSegment>;
}
interface OpenSegment {
  readonly handle: FileHandle;
  readonly path: string;
  readonly segment: StreamSegment;
  readonly binding: SegmentBinding;
  readonly key: string;
  native?: NativeIdentity | null;
  stat?: BigIntStats;
}

export interface VerifiedSegment {
  readonly bytes?: Buffer;
  readonly events?: readonly EventRecord[];
}

function digest(bytes: Uint8Array): string {
  return observeAuthorityWork("cacheHash", () => createHash("sha256").update(bytes).digest("hex"));
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function attributes(common: number, volume = 0, file = 0, extended = 0): string {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt16LE(5);
  bytes.writeUInt32LE(common, 4);
  bytes.writeUInt32LE(volume, 8);
  bytes.writeUInt32LE(file, 16);
  bytes.writeUInt32LE(extended, 20);
  return bytes.toString("base64");
}
function attributeBytes(value: unknown, common: number, volume: number, file: number, extended: number): Buffer | null {
  if (!object(value) || value.result !== 0 || typeof value.bytes !== "string") return null;
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.length !== 8192 || bytes.readUInt32LE() < 24 || bytes.readUInt32LE() > bytes.length) return null;
  if (bytes.readUInt32LE(4) !== common || bytes.readUInt32LE(8) !== volume || bytes.readUInt32LE(12) !== 0 || bytes.readUInt32LE(16) !== file || bytes.readUInt32LE(20) !== extended) return null;
  return bytes.subarray(0, bytes.readUInt32LE());
}
function attributeString(bytes: Buffer, at: number): string | null {
  const start = at + bytes.readInt32LE(at), length = bytes.readUInt32LE(at + 4);
  if (start < at + 8 || length < 1 || start + length > bytes.length || bytes[start + length - 1] !== 0) return null;
  return bytes.subarray(start, start + length - 1).toString("utf8");
}

/** Apple attr.h's packed 4-byte layout, with exact returned and supported sets.
 * Native generation and resident-data flags apply even when Foundation omits
 * iCloud-only keys. Their absence is not a claim that no provider manages a file. */
function nativeIdentity(value: unknown, boot: string, path: string): NativeIdentity | null {
  if (!object(value) || value.resourceError !== null || !object(value.resources)) return null;
  const provider = value.resources;
  const ubiquitous = provider.NSURLIsUbiquitousItemKey === true || provider.NSURLIsUbiquitousItemKey === 1;
  const current = (provider.NSURLIsUbiquitousItemKey === true || provider.NSURLIsUbiquitousItemKey === 1)
    && (provider.NSURLUbiquitousItemIsDownloadingKey === false || provider.NSURLUbiquitousItemIsDownloadingKey === 0)
    && provider.NSURLUbiquitousItemDownloadingStatusKey === "NSURLUbiquitousItemDownloadingStatusCurrent";
  if ((ubiquitous && !current) || provider.NSURLUbiquitousItemIsDownloadingKey === true || provider.NSURLUbiquitousItemIsDownloadingKey === 1
    || (provider.NSURLUbiquitousItemDownloadingStatusKey !== undefined && provider.NSURLUbiquitousItemDownloadingStatusKey !== "NSURLUbiquitousItemDownloadingStatusCurrent")
    || provider.NSURLUbiquitousItemDownloadingErrorKey !== null || typeof provider.NSURLFileResourceIdentifierKey !== "string") return null;
  const file = attributeBytes(value.file, FILE_COMMON, 0, DATA_LENGTH, EXTENDED_FLAGS);
  const volume = attributeBytes(value.volume, 0x80000000, VOLUME & 0x7fffffff, 0, 0);
  if (file === null || file.length < 76 || volume === null || volume.length < 132) return null;
  // validattr follows capabilities and UUID in this request. Unknown support is
  // not silently replaced with a successful fgetattrlist return.
  if ((volume.readUInt32LE(92) & (FILE_COMMON & 0x7fffffff)) !== (FILE_COMMON & 0x7fffffff) || (volume.readUInt32LE(104) & DATA_LENGTH) !== DATA_LENGTH || (volume.readUInt32LE(108) & EXTENDED_FLAGS) !== EXTENDED_FLAGS) return null;
  if ((volume.readUInt32LE(32) & 0x1000) === 0) return null;
  const sourcePath = attributeString(file, 52);
  const mountPoint = attributeString(volume, 24), mountedDevice = attributeString(volume, 36);
  const generation = file.readUInt32LE(40), flags = file.readUInt32LE(36);
  const volumeId = volume.subarray(76, 92).toString("hex");
  if (sourcePath !== path || mountPoint === null || mountedDevice === null || generation === 0 || (flags & 0x40000000) !== 0 || /^0+$/u.test(volumeId)) return null;
  return {
    boot,
    mount: canonicalSha256({ fsid: file.subarray(28, 36).toString("hex"), mountPoint, mountedDevice }),
    volume: volumeId,
    device: file.readUInt32LE(24),
    fileId: file.readBigUInt64LE(44).toString(),
    generation,
    length: file.readBigInt64LE(60).toString(),
    flags,
    extendedFlags: file.readBigUInt64LE(68).toString(),
    provider,
  };
}

async function queryNative(files: readonly OpenSegment[]): Promise<readonly (NativeIdentity | null)[] | null> {
  const session = active.getStore();
  if (session?.helperUnavailable === true) return null;
  let script: string;
  try {
    // The normal build copies this resource. The release bundler carries this
    // exact URL in the CLI, so users need only Node and macOS's system JXA host.
    script = await readFile(new URL("./darwin-source-identity.mjs", import.meta.url), "utf8");
  } catch {
    observeCacheReason("source-verification-helper-missing");
    if (session !== undefined) session.helperUnavailable = true;
    return null;
  }
  const request = JSON.stringify({ fileAttributes: attributes(FILE_COMMON, 0, DATA_LENGTH, EXTENDED_FLAGS), volumeAttributes: attributes(0x80000000, VOLUME), files: files.map(file => ({ path: file.path })) });
  const started = performance.now();
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-", request], { input: script, encoding: "utf8", stdio: "pipe", timeout: 5_000, maxBuffer: 65_536 + files.length * 24_576 });
  observeVerificationHelper(Buffer.byteLength(script), Buffer.byteLength(request), Buffer.byteLength(result.stdout ?? "") + Buffer.byteLength(result.stderr ?? ""), performance.now() - started);
  if (result.status !== 0 || result.error !== undefined) {
    observeCacheReason("source-verification-helper-unavailable");
    if (session !== undefined) session.helperUnavailable = true;
    return null;
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!object(value) || value.schemaVersion !== "einzbern.darwin-source-identity.v1" || value.bootResult !== 0 || typeof value.boot !== "string" || !Array.isArray(value.files) || value.files.length !== files.length) return null;
    const boot = Buffer.from(value.boot, "base64").toString("utf8").split("\0")[0] ?? "";
    if (!/^[A-Fa-f0-9-]{36}$/u.test(boot)) return null;
    return value.files.map((entry, index) => nativeIdentity(entry, boot, files[index]!.path));
  } catch {
    return null;
  }
}

/** This is the existing identity/registry/engine boundary, not runtimeHome.
 * Synchronization controls library/runtime subtrees, never this sibling. No
 * chmod, secret, issuer or claim against a writer of local config is involved. */
async function recordBoundary(library: Library, recordDirectory = RECORD_DIRECTORY): Promise<VerificationSession | null> {
  try {
    const home = await realpath(deviceHome());
    const device = await readDevice(home);
    if (device === null) return null;
    const root = await realpath(library.root);
    const storage = readStorageLocation(deviceHome());
    const records = join(home, recordDirectory, libraryDirectoryName(library.manifest.libraryId));
    const cache = join(cachePath(library.manifest.libraryId), "verified-segments");
    // Resolve existing ancestors, including relocated cache forwarding links.
    const cacheRoot = await realpath(cachePath(library.manifest.libraryId)).catch(() => realpath(join(cachePath(library.manifest.libraryId), "..")));
    const writerRoots = [root, cacheRoot];
    const existingCache = await lstat(cache).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existingCache !== null) writerRoots.push(await realpath(cache));
    if (storage !== null) writerRoots.push(await realpath(storage.library), await realpath(storage.runtime));
    if (writerRoots.some(writer => inside(writer, records))) return null;
    if (!(await lstat(home)).isDirectory()) return null;
    for (const directory of [join(home, recordDirectory), records]) {
      const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (info !== null && (!info.isDirectory() || info.isSymbolicLink())) return null;
    }
    return { library: { ...library, root }, home, deviceIdentity: canonicalSha256(device), records, cache, pending: [], reused: [], helperUnavailable: false, files: new Map() };
  } catch {
    return null;
  }
}

// readCacheSnapshot has already verified stateDigest against the state bytes.
// Bind its complete header without serialising or hashing the large state again.
function replayProjectionDigest(snapshot: CacheSnapshotHeader): string {
  return canonicalSha256({
    schemaVersion: snapshot.schemaVersion,
    libraryId: snapshot.libraryId,
    engineVersion: snapshot.engineVersion,
    version: snapshot.version,
    maxClock: snapshot.maxClock,
    streams: snapshot.streams,
    stateDigest: snapshot.stateDigest,
  });
}

/** A shared/runtime cache checksum is not authority to skip the reducer. Only
 * the independent device record, issued from a validated replay, can attest
 * this exact checkpoint's state and coverage. This applies without native 648. */
async function replayProjectionDigests(boundary: VerificationSession, binding: string): Promise<readonly string[]> {
  let handle;
  try {
    handle = await open(join(boundary.records, "projection.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > RECORD_MAX_BYTES) return [];
    const bytes = await handle.readFile();
    observeVerificationRecord(bytes.length);
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(envelope) || !object(envelope.record) || envelope.checksum !== canonicalSha256(envelope.record)) return [];
    const record = envelope.record;
    return record.schemaVersion === REPLAY_SCHEMA && record.engineVersion === FRAMEWORK_VERSION
      && record.deviceIdentity === boundary.deviceIdentity && record.binding === binding
      && Array.isArray(record.projectionDigests) && record.projectionDigests.every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))
      ? record.projectionDigests as string[] : [];
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

export async function hasVerifiedReplayProjection(library: Library, binding: string, snapshot: CacheSnapshotHeader): Promise<boolean> {
  const boundary = await recordBoundary(library, REPLAY_RECORD_DIRECTORY);
  return boundary !== null && (await replayProjectionDigests(boundary, binding)).includes(replayProjectionDigest(snapshot));
}

/** Called only after a full authority replay or a verified prefix plus replayed
 * tail. The caller passes the header actually written by writeCacheSnapshot. */
export async function recordVerifiedReplayProjection(library: Library, binding: string, snapshot: CacheSnapshotHeader): Promise<void> {
  const boundary = await recordBoundary(library, REPLAY_RECORD_DIRECTORY);
  if (boundary === null) return;
  const prior = await replayProjectionDigests(boundary, binding);
  const projectionDigest = replayProjectionDigest(snapshot);
  if (prior.includes(projectionDigest)) return;
  await mkdir(boundary.records, { recursive: true });
  // Retain prior authenticated prefixes: another legitimate reader may restore
  // an older checkpoint before replaying several new tail events. The existing
  // bounded record size caps this disposable catalogue; eviction only causes
  // full replay, and a binding/device/engine change starts a new catalogue.
  const projectionDigests = [...prior, projectionDigest];
  let text: string;
  do {
    const record = { schemaVersion: REPLAY_SCHEMA, engineVersion: FRAMEWORK_VERSION, deviceIdentity: boundary.deviceIdentity, binding, projectionDigests };
    text = canonicalJson({ record, checksum: canonicalSha256(record) });
    if (Buffer.byteLength(text) <= RECORD_MAX_BYTES) break;
    projectionDigests.shift();
  } while (projectionDigests.length > 0);
  await writeFileAtomic(join(boundary.records, "projection.json"), text);
  observeCacheWrite(Buffer.byteLength(text));
}

async function priorRecord(session: VerificationSession, file: OpenSegment, native: NativeIdentity): Promise<PriorVerification | null> {
  let handle;
  try {
    handle = await open(join(session.records, `${file.key}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 65_536) return null;
    const bytes = await handle.readFile();
    observeVerificationRecord(bytes.length);
    const envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(envelope) || typeof envelope.checksum !== "string" || !object(envelope.record) || canonicalSha256(envelope.record) !== envelope.checksum) return null;
    const record = envelope.record;
    if (record.schemaVersion !== SCHEMA || record.deviceIdentity !== session.deviceIdentity || record.engineVersion !== FRAMEWORK_VERSION || record.projection !== PROJECTION || canonicalSha256(record.binding) !== canonicalSha256(file.binding) || canonicalSha256(record.native) !== canonicalSha256(native) || record.digest !== file.segment.sha256 || record.coverage !== file.segment.bytes || typeof record.projectionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.projectionDigest) || !Number.isSafeInteger(record.projectionBytes) || Number(record.projectionBytes) < 1 || typeof record.authority !== "string" || !/^[a-f0-9]{64}$/u.test(record.authority)) return null;
    return record as unknown as PriorVerification;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Open the operation's native descriptors together. This small metadata pass
 * lets one before/after helper cover every stream, rather than starting a JXA
 * process twice per stream. The normal reader still validates current metadata. */
async function prepareFiles(session: VerificationSession): Promise<boolean> {
  const { listStreamDevices, readStreamManifest } = await import("./akasha.js");
  async function collect(root: string, source: LibraryManifest): Promise<void> {
    const sourceRoot = await realpath(root);
    if (!inside(session.library.root, sourceRoot)) throw new Error("source outside library");
    const archive = relative(session.library.root, sourceRoot).split("\\").join("/");
    for (const deviceId of await listStreamDevices(sourceRoot)) {
      const manifest = await readStreamManifest(sourceRoot, deviceId, { archivedManifest: source });
      if (manifest === null) continue;
      for (const segment of manifest.segments) {
        // Keep the complete batch below the native descriptor budget. Larger
        // libraries use the original reader instead of dropping any checks.
        if (session.files.size >= 128) throw new Error("native descriptor budget");
        const path = join(sourceRoot, "akasha", manifest.deviceId, segment.name);
        if (session.files.has(path)) throw new Error("aliased source descriptor");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const binding: SegmentBinding = { libraryId: session.library.manifest.libraryId, sourceId: source.libraryId, archive, streamId: manifest.streamId, deviceId: manifest.deviceId, identityScheme: manifest.identityScheme, segment, rootManifest: canonicalSha256(session.library.manifest), sourceManifest: canonicalSha256(source) };
        session.files.set(path, { handle, path, segment, binding, key: canonicalSha256({ libraryId: binding.libraryId, sourceId: binding.sourceId, archive, streamId: binding.streamId, segment: segment.name }) });
      }
    }
    const index = await readConsolidationIndex(sourceRoot, source);
    for (const entry of index?.sources ?? []) await collect(join(sourceRoot, entry.archive), entry.manifest);
  }
  try {
    await collect(session.library.root, session.library.manifest);
    const files = [...session.files.values()];
    if (files.length === 0) return false;
    const before = await active.run(session, () => queryNative(files));
    if (before === null || before.every(value => value === null)) return false;
    for (const [index, file] of files.entries()) {
      const stat = await file.handle.stat({ bigint: true });
      const native = before[index];
      file.stat = stat;
      file.native = stat.isFile() && stat.nlink === 1n && native !== undefined && native !== null
        && native.fileId === stat.ino.toString() && native.device === Number(stat.dev) && native.length === stat.size.toString() ? native : null;
    }
    return true;
  } catch {
    observeCacheReason("source-verification-native-preparation-failed");
    return false;
  }
}

async function filesUnchanged(session: VerificationSession): Promise<boolean> {
  const files = [...session.files.values()];
  const after = await active.run(session, () => queryNative(files));
  if (after === null) return false;
  for (const [index, file] of files.entries()) {
    if (file.native === null || file.native === undefined) continue;
    const held = await file.handle.stat({ bigint: true });
    const named = await lstat(file.path, { bigint: true });
    const stat = file.stat!;
    if (!named.isFile() || named.nlink !== 1n || held.nlink !== 1n || named.dev !== held.dev || named.ino !== held.ino || stat.dev !== held.dev || stat.ino !== held.ino || stat.size !== held.size || stat.mtimeNs !== held.mtimeNs || stat.ctimeNs !== held.ctimeNs || canonicalSha256(file.native) !== canonicalSha256(after[index])) return false;
  }
  return true;
}

/** A local record authenticates the compressed, previously validated event
 * projection. Shared cache bytes alone cannot skip source or event validation. */
export async function verifiedStreamSegments(libraryRoot: string, manifest: StreamManifest, sourceManifest?: LibraryManifest): Promise<ReadonlyMap<string, VerifiedSegment> | null> {
  const session = active.getStore();
  if (session === undefined || manifest.segments.length === 0) return null;
  const sourceRoot = await realpath(libraryRoot);
  const source = sourceManifest ?? session.library.manifest;
  const result = new Map<string, VerifiedSegment>();
  for (const segment of manifest.segments) {
    const file = session.files.get(join(sourceRoot, "akasha", manifest.deviceId, segment.name));
    if (file === undefined || file.native === null || file.native === undefined || file.binding.streamId !== manifest.streamId || file.binding.deviceId !== manifest.deviceId || file.binding.identityScheme !== manifest.identityScheme || canonicalSha256(file.binding.segment) !== canonicalSha256(segment) || file.binding.sourceManifest !== canonicalSha256(source)) continue;
    const prior = await priorRecord(session, file, file.native);
    if (prior !== null) {
      let cached;
      try {
        cached = await open(join(session.cache, `${file.key}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await cached.stat();
        if (info.isFile() && info.nlink === 1 && info.size === prior.projectionBytes) {
          const bytes = await cached.readFile();
          observeCacheRead(bytes.length);
          if (bytes.length === prior.projectionBytes && digest(bytes) === prior.projectionDigest) {
            const { gunzipSync } = await import("node:zlib");
            const events: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: segment.bytes * 2 }).toString("utf8"));
            if (Array.isArray(events) && events.length === segment.lastSequence - segment.firstSequence + 1) {
              result.set(segment.name, { events: events as EventRecord[] });
              session.reused.push({ bytes: bytes.length, streamId: manifest.streamId, scope: sourceManifest === undefined ? "live" : "archive" });
              continue;
            }
          }
        }
      } catch { /* A missing or damaged projection uses the original reader. */ }
      finally { await cached?.close(); }
    }
    const bytes = await file.handle.readFile();
    observeEventRead(bytes.length, manifest.streamId, sourceManifest === undefined ? "live" : "archive");
    result.set(segment.name, { bytes });
    if (bytes.length === segment.bytes && digest(bytes) === segment.sha256) {
      session.pending.push({ key: file.key, record: { schemaVersion: SCHEMA, engineVersion: FRAMEWORK_VERSION, deviceIdentity: session.deviceIdentity, projection: PROJECTION, binding: file.binding, native: file.native, streamManifest: canonicalSha256(manifest), head: manifest.headEventHash, vector: manifest.sequence, digest: segment.sha256, coverage: segment.bytes } });
    }
  }
  return result;
}

/** Called only after Akasha has validated the complete stream including head. */
export async function recordVerifiedStreamEvents(libraryRoot: string, manifest: StreamManifest, events: readonly EventRecord[]): Promise<void> {
  const session = active.getStore();
  if (session === undefined) return;
  const archive = relative(session.library.root, await realpath(libraryRoot)).split("\\").join("/");
  for (const candidate of session.pending) {
    if (candidate.record.binding.archive !== archive || candidate.record.binding.streamId !== manifest.streamId || candidate.events !== undefined) continue;
    const segment = candidate.record.binding.segment;
    candidate.events = events.slice(segment.firstSequence - 1, segment.lastSequence);
  }
}

export function hasPendingSourceVerification(): boolean {
  return (active.getStore()?.pending.length ?? 0) > 0;
}

function authorityMetadata(read: LibraryRead): unknown {
  return {
    vector: read.versionVector,
    streams: read.streams.map(stream => stream.manifest),
    consolidation: read.consolidation === undefined ? null : { index: read.consolidation.index, sources: read.consolidation.sources.map(({ source, read: sourceRead }) => ({ source, read: authorityMetadata(sourceRead) })) },
  };
}

/** Only the materializer enters this scope. Public source-event readers always
 * read source bytes. Issuance follows a successful full authority replay. */
export async function withSourceVerification<T>(library: Library, operation: () => Promise<{ readonly value: T; readonly read: LibraryRead; readonly accepted: boolean }>): Promise<T> {
  const session = process.platform !== "darwin" || library.manifest.consolidation === undefined ? null : await recordBoundary(library);
  if (session === null) return (await operation()).value;
  try {
    if (!await prepareFiles(session)) return (await operation()).value;
    const answer = await active.run(session, operation);
    if (!await filesUnchanged(session)) {
      observeCacheReason("source-verification-source-changed");
      return (await operation()).value;
    }
    for (const reused of session.reused) observeVerifiedSegment(reused.bytes, reused.streamId, reused.scope);
    if (answer.accepted && session.pending.length > 0) {
      try {
        // No source, index or cache value selects this device-local destination.
        const boundary = await recordBoundary(library);
        if (boundary === null || boundary.records !== session.records || boundary.cache !== session.cache || boundary.deviceIdentity !== session.deviceIdentity) return answer.value;
        await mkdir(session.records, { recursive: true });
        await mkdir(session.cache, { recursive: true });
        const authority = canonicalSha256({ manifest: library.manifest, read: authorityMetadata(answer.read) });
        const { gzipSync } = await import("node:zlib");
        for (const candidate of session.pending) {
          if (candidate.events === undefined) continue;
          const bytes = gzipSync(JSON.stringify(candidate.events));
          const cacheFile = join(session.cache, `${candidate.key}.bin`);
          await writeFileAtomic(cacheFile, bytes);
          observeCacheWrite(bytes.length);
          const record: PriorVerification = { ...candidate.record, authority, projectionBytes: bytes.length, projectionDigest: digest(bytes) };
          const text = canonicalJson({ record, checksum: canonicalSha256(record) });
          await writeFileAtomic(join(session.records, `${candidate.key}.json`), text);
          observeCacheWrite(Buffer.byteLength(text));
        }
      } catch {
        observeCacheReason("source-verification-record-write-failed");
      }
    }
    return answer.value;
  } finally {
    await Promise.all([...session.files.values()].map(file => file.handle.close().catch(() => undefined)));
  }
}
