// SPDX-License-Identifier: Apache-2.0
// Reducer checkpoint proof is also required on the full-source path. Keep its
// device boundary independent of the optional native descriptor/helper reader.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath, deviceHome, libraryDirectoryName } from "./device-home.js";
import { readDevice } from "./device-identity.js";
import type { Library } from "./ether-library.js";
import type { CacheSnapshotHeader } from "./library-cache.js";
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { readStorageLocation } from "./storage-location.js";
import { observeCacheWrite, observeVerificationRecord } from "./recall-observation.js";

const RECORD_DIRECTORY = "source-verification";
const REPLAY_RECORD_DIRECTORY = "replay-projections";
const REPLAY_SCHEMA = "einzbern.verified-replay-projection.v1";
const RECORD_MAX_BYTES = 65_536;
export interface VerificationBoundary {
  readonly library: Library;
  readonly home: string;
  readonly deviceIdentity: string;
  readonly records: string;
  readonly cache: string;
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** This is the existing identity/registry/engine boundary, not runtimeHome.
 * Synchronization controls library/runtime subtrees, never this sibling. No
 * chmod, secret, issuer or claim against a writer of local config is involved. */
export async function recordBoundary(library: Library, recordDirectory = RECORD_DIRECTORY): Promise<VerificationBoundary | null> {
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
    return { library: { ...library, root }, home, deviceIdentity: canonicalSha256(device), records, cache };
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
async function replayProjectionDigests(boundary: VerificationBoundary, binding: string): Promise<readonly string[]> {
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
