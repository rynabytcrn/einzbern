// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { LibraryRead, StreamManifest, StreamSegment } from "./akasha.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath, deviceHome, libraryDirectoryName } from "./device-home.js";
import { readDevice } from "./device-identity.js";
import type { Library, LibraryManifest } from "./ether-library.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { readStorageLocation } from "./storage-location.js";
import { observeAuthorityWork, observeCacheRead, observeCacheWrite, observeCacheReason, observeEventRead, observeVerificationHelper, observeVerificationRecord, observeVerifiedSegment } from "./recall-observation.js";

const SCHEMA = "einzbern.source-verification.v1";
const PROJECTION = "einzbern.verified-segment-bytes.v1";
const RECORD_DIRECTORY = "source-verification";
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
}
interface Candidate {
  readonly key: string;
  readonly record: Omit<PriorVerification, "authority">;
  readonly bytes: Buffer;
}
interface VerificationSession {
  readonly library: Library;
  readonly home: string;
  readonly deviceIdentity: string;
  readonly records: string;
  readonly cache: string;
  readonly pending: Candidate[];
  helperUnavailable: boolean;
}
interface OpenSegment {
  readonly handle: FileHandle;
  readonly path: string;
  readonly segment: StreamSegment;
  readonly binding: SegmentBinding;
  readonly key: string;
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
 * Missing provider keys are unknown. Only positively current cloud files enter
 * this first implementation; ordinary local files retain the full reader. */
function nativeIdentity(value: unknown, boot: string, path: string): NativeIdentity | null {
  if (!object(value) || value.resourceError !== null || !object(value.resources)) return null;
  const provider = value.resources;
  if (provider.NSURLIsUbiquitousItemKey !== true && provider.NSURLIsUbiquitousItemKey !== 1) return null;
  if (provider.NSURLUbiquitousItemIsDownloadingKey !== false && provider.NSURLUbiquitousItemIsDownloadingKey !== 0) return null;
  if (provider.NSURLUbiquitousItemDownloadingStatusKey !== "NSURLUbiquitousItemDownloadingStatusCurrent" || provider.NSURLUbiquitousItemDownloadingErrorKey !== null || typeof provider.NSURLFileResourceIdentifierKey !== "string") return null;
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
    script = await readFile(new URL("../../../scripts/lib/darwin-source-identity.mjs", import.meta.url), "utf8");
  } catch {
    observeCacheReason("source-verification-helper-missing");
    if (session !== undefined) session.helperUnavailable = true;
    return null;
  }
  const request = JSON.stringify({ fileAttributes: attributes(FILE_COMMON, 0, DATA_LENGTH, EXTENDED_FLAGS), volumeAttributes: attributes(0x80000000, VOLUME), files: files.map((file, index) => ({ fd: index + 3, path: file.path })) });
  const started = performance.now();
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-", request], { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe", ...files.map(file => file.handle.fd)], timeout: 5_000, maxBuffer: 2_097_152 });
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
async function recordBoundary(library: Library): Promise<VerificationSession | null> {
  if (process.platform !== "darwin") return null;
  try {
    const home = await realpath(deviceHome());
    const device = await readDevice(home);
    if (device === null) return null;
    const root = await realpath(library.root);
    const storage = readStorageLocation(deviceHome());
    const records = join(home, RECORD_DIRECTORY, libraryDirectoryName(library.manifest.libraryId));
    const cache = join(cachePath(library.manifest.libraryId), "verified-segments");
    // Resolve existing ancestors, including relocated cache forwarding links.
    const cacheRoot = await realpath(cachePath(library.manifest.libraryId)).catch(() => realpath(join(cachePath(library.manifest.libraryId), "..")));
    const writerRoots = [root, cacheRoot];
    const existingCache = await lstat(cache).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existingCache !== null) writerRoots.push(await realpath(cache));
    if (storage !== null) writerRoots.push(await realpath(storage.library), await realpath(storage.runtime));
    if (writerRoots.some(writer => inside(writer, records))) return null;
    if (!(await lstat(home)).isDirectory()) return null;
    for (const directory of [join(home, RECORD_DIRECTORY), records]) {
      const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (info !== null && (!info.isDirectory() || info.isSymbolicLink())) return null;
    }
    return { library: { ...library, root }, home, deviceIdentity: canonicalSha256(device), records, cache, pending: [], helperUnavailable: false };
  } catch {
    return null;
  }
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
    if (record.schemaVersion !== SCHEMA || record.deviceIdentity !== session.deviceIdentity || record.engineVersion !== FRAMEWORK_VERSION || record.projection !== PROJECTION || canonicalSha256(record.binding) !== canonicalSha256(file.binding) || canonicalSha256(record.native) !== canonicalSha256(native) || record.digest !== file.segment.sha256 || record.coverage !== file.segment.bytes || typeof record.authority !== "string" || !/^[a-f0-9]{64}$/u.test(record.authority)) return null;
    return record as unknown as PriorVerification;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Prepared bytes are still passed through Akasha's normal segment hash,
 * canonical event, chain and head validators. This never returns a state. */
export async function verifiedStreamSegments(libraryRoot: string, manifest: StreamManifest, sourceManifest?: LibraryManifest): Promise<ReadonlyMap<string, Buffer> | null> {
  const session = active.getStore();
  if (session === undefined || manifest.segments.length === 0) return null;
  const files: OpenSegment[] = [];
  const result = new Map<string, Buffer>();
  const candidates: Candidate[] = [];
  const reusedSegments: OpenSegment[] = [];
  try {
    const sourceRoot = await realpath(libraryRoot);
    if (!inside(session.library.root, sourceRoot)) return null;
    const archive = relative(session.library.root, sourceRoot).split("\\").join("/");
    const source = sourceManifest ?? session.library.manifest;
    // Bound descriptor batches avoid a dependency on the user's fd limit.
    for (let offset = 0; offset < manifest.segments.length; offset += 24) {
      const batch: OpenSegment[] = [];
      for (const segment of manifest.segments.slice(offset, offset + 24)) {
        const path = join(sourceRoot, "akasha", manifest.deviceId, segment.name);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const binding: SegmentBinding = { libraryId: session.library.manifest.libraryId, sourceId: source.libraryId, archive, streamId: manifest.streamId, deviceId: manifest.deviceId, segment, rootManifest: canonicalSha256(session.library.manifest), sourceManifest: canonicalSha256(source) };
        const file = { handle, path, segment, binding, key: canonicalSha256({ libraryId: binding.libraryId, sourceId: binding.sourceId, archive, streamId: binding.streamId, segment: segment.name }) };
        files.push(file);
        batch.push(file);
      }
      const before = await queryNative(batch);
      if (before === null || before.every(entry => entry === null)) return null;
      const stats = await Promise.all(batch.map(file => file.handle.stat({ bigint: true })));
      const reused = new Set<string>();
      for (const [index, file] of batch.entries()) {
        const native = before[index];
        const stat = stats[index]!;
        if (!stat.isFile() || stat.nlink !== 1n) return null;
        const bound = native !== null && native !== undefined && native.fileId === stat.ino.toString() && native.device === Number(stat.dev) && native.length === stat.size.toString();
        const prior = bound ? await priorRecord(session, file, native) : null;
        let bytes: Buffer | null = null;
        if (prior !== null) {
          let cached;
          try {
            cached = await open(join(session.cache, `${file.key}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW);
            const info = await cached.stat();
            if (info.isFile() && info.nlink === 1 && info.size === prior.coverage) {
              bytes = await cached.readFile();
              observeCacheRead(bytes.length);
              if (bytes.length !== prior.coverage || digest(bytes) !== prior.digest) bytes = null;
            }
          } catch { bytes = null; } finally { await cached?.close(); }
        }
        if (bytes === null) {
          bytes = await file.handle.readFile();
          observeEventRead(bytes.length, manifest.streamId, sourceManifest === undefined ? "live" : "archive");
          if (bound && bytes.length === file.segment.bytes && digest(bytes) === file.segment.sha256) {
            candidates.push({ key: file.key, bytes, record: { schemaVersion: SCHEMA, engineVersion: FRAMEWORK_VERSION, deviceIdentity: session.deviceIdentity, projection: PROJECTION, binding: file.binding, native, streamManifest: canonicalSha256(manifest), head: manifest.headEventHash, vector: manifest.sequence, digest: file.segment.sha256, coverage: file.segment.bytes } });
          }
        } else {
          reused.add(file.key);
        }
        result.set(file.segment.name, bytes);
      }
      const after = await queryNative(batch);
      if (after === null) return null;
      for (const [index, file] of batch.entries()) {
        const held = await file.handle.stat({ bigint: true });
        const named = await lstat(file.path, { bigint: true });
        const stat = stats[index]!;
        if (!named.isFile() || named.nlink !== 1n || held.nlink !== 1n || named.dev !== held.dev || named.ino !== held.ino || stat.dev !== held.dev || stat.ino !== held.ino || stat.size !== held.size || stat.mtimeNs !== held.mtimeNs || stat.ctimeNs !== held.ctimeNs || canonicalSha256(before[index]) !== canonicalSha256(after[index])) return null;
        if (reused.has(file.key)) reusedSegments.push(file);
      }
      for (const file of batch) await file.handle.close();
    }
    session.pending.push(...candidates);
    for (const file of reusedSegments) observeVerifiedSegment(result.get(file.segment.name)!.length, manifest.streamId, sourceManifest === undefined ? "live" : "archive");
    return result;
  } catch {
    // A probe/cache/record fault is never a replacement source error. Akasha
    // performs its original full read and reports its original error meaning.
    return null;
  } finally {
    await Promise.all(files.map(file => file.handle.close().catch(() => undefined)));
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
  const session = library.manifest.consolidation === undefined ? null : await recordBoundary(library);
  if (session === null) return (await operation()).value;
  const answer = await active.run(session, operation);
  if (answer.accepted && session.pending.length > 0) {
    try {
      // Recheck the real destination after reading untrusted inputs; no path in
      // an event, index, source or shared cache chooses a local record name.
      const boundary = await recordBoundary(library);
      if (boundary === null || boundary.records !== session.records || boundary.cache !== session.cache || boundary.deviceIdentity !== session.deviceIdentity) return answer.value;
      await mkdir(session.records, { recursive: true });
      await mkdir(session.cache, { recursive: true });
      const authority = canonicalSha256({ manifest: library.manifest, read: authorityMetadata(answer.read) });
      for (const candidate of session.pending) {
        const cacheFile = join(session.cache, `${candidate.key}.bin`);
        // Use the established atomic writer, which also accepts Buffer data.
        await writeFileAtomic(cacheFile, candidate.bytes.toString("utf8"));
        observeCacheWrite(candidate.bytes.length);
        const record: PriorVerification = { ...candidate.record, authority };
        const text = canonicalJson({ record, checksum: canonicalSha256(record) });
        await writeFileAtomic(join(session.records, `${candidate.key}.json`), text);
        observeCacheWrite(Buffer.byteLength(text));
      }
    } catch {
      observeCacheReason("source-verification-record-write-failed");
    }
  }
  return answer.value;
}
