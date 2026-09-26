// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-469 R4, AC2 / STORY-468 R4: a library's derived state lives only in this
// device's cache, `cache/<library>/` in the device directory, and never in the library:
//
//   views/       the view documents (STATUS.md, index.json, readback.json and, when a library
//                holds extension records, extensions.json), stamped with the engine and the
//                merged head they were projected from;
//   snapshots/   one replay snapshot: the reducer's state after a prefix of the merged events,
//                keyed by the head of every stream it covers and the largest clock among them,
//                so a read resumes the merged replay there instead of at genesis.
//
// Everything here is rebuilt from the streams. A cache file that is missing, damaged, written by
// another engine or no longer describes a prefix of the library is not used, and the next read
// writes a new one: a cache fault is never a library fault. The files are replaced atomically,
// so concurrent readers on one machine never see half a file; the last writer wins, and every
// writer's file is valid.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isAtomicTemporaryName, writeFileAtomic } from "./atomic-file.js";
import { cachePath } from "./device-home.js";

export const LIBRARY_CACHE_DIRECTORIES = Object.freeze({ views: "views", snapshots: "snapshots" } as const);
export const CACHE_SNAPSHOT_SCHEMA_VERSION = "einzbern.cache-snapshot.v1" as const;
export const CACHE_VIEWS_SCHEMA_VERSION = "einzbern.cache-views.v1" as const;
const SNAPSHOT_HEADER_FILE = "snapshot.json";
const VIEWS_STAMP_FILE = ".stamp.json";
const STATE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;

/** The prefix of one stream a snapshot covers: its sequence there and the event hash at it. */
export interface CacheSnapshotStream {
  readonly deviceId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly eventHash: string;
}

/**
 * A snapshot's header. The state it describes is a separate file named by the SHA-256 of its
 * bytes, and the header is written after it, so a header only ever names a complete state.
 */
export interface CacheSnapshotHeader {
  readonly schemaVersion: typeof CACHE_SNAPSHOT_SCHEMA_VERSION;
  readonly libraryId: string;
  readonly engineVersion: string;
  readonly version: number;
  readonly maxClock: number;
  readonly streams: readonly CacheSnapshotStream[];
  readonly stateDigest: string;
}

export interface CacheSnapshot extends CacheSnapshotHeader {
  /** The reducer state, as the engine that wrote it serialised it. */
  readonly state: unknown;
}

/** What the view documents were projected from: the engine and the merged head and version. */
export interface CacheViewStamp {
  readonly schemaVersion: typeof CACHE_VIEWS_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly headEventHash: string | null;
  readonly version: number;
}

/** The cache directory of a library on this device (the device directory's cache/<library>/). */
export function libraryCacheDirectory(libraryId: string, home?: string): string {
  return cachePath(libraryId, home);
}

function snapshotsDirectory(libraryId: string, home?: string): string {
  return join(cachePath(libraryId, home), LIBRARY_CACHE_DIRECTORIES.snapshots);
}

function viewsDirectory(libraryId: string, home?: string): string {
  return join(cachePath(libraryId, home), LIBRARY_CACHE_DIRECTORIES.views);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function snapshotStream(value: unknown): CacheSnapshotStream | null {
  if (!isRecord(value)) return null;
  const { deviceId, streamId, sequence, eventHash } = value;
  if (typeof deviceId !== "string" || typeof streamId !== "string" || typeof eventHash !== "string") return null;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) return null;
  return { deviceId, streamId, sequence: Number(sequence), eventHash };
}

function snapshotHeader(value: unknown, libraryId: string): CacheSnapshotHeader | null {
  if (!isRecord(value) || value.schemaVersion !== CACHE_SNAPSHOT_SCHEMA_VERSION || value.libraryId !== libraryId) return null;
  const { engineVersion, version, maxClock, streams, stateDigest } = value;
  if (typeof engineVersion !== "string" || !isCount(version) || !isCount(maxClock) || !Array.isArray(streams)) return null;
  if (typeof stateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(stateDigest)) return null;
  const parsed = streams.map(snapshotStream);
  if (parsed.some((stream) => stream === null)) return null;
  return {
    schemaVersion: CACHE_SNAPSHOT_SCHEMA_VERSION,
    libraryId,
    engineVersion,
    version,
    maxClock,
    streams: parsed as CacheSnapshotStream[],
    stateDigest,
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The library's snapshot, or null when there is none or it does not verify: a header that does
 * not parse, names another library, or names a state whose bytes do not hash as recorded. A
 * snapshot that does not verify is removed, so it is not read again.
 */
export async function readCacheSnapshot(libraryId: string, home?: string): Promise<CacheSnapshot | null> {
  const directory = snapshotsDirectory(libraryId, home);
  const headerText = await readText(join(directory, SNAPSHOT_HEADER_FILE));
  if (headerText === null) return null;
  let header: CacheSnapshotHeader | null = null;
  try {
    header = snapshotHeader(JSON.parse(headerText), libraryId);
  } catch {
    header = null;
  }
  const stateText = header === null ? null : await readText(join(directory, `${header.stateDigest}.json`));
  if (header === null || stateText === null || sha256(stateText) !== header.stateDigest) {
    await discardCacheSnapshot(libraryId, home);
    return null;
  }
  try {
    return { ...header, state: JSON.parse(stateText) as unknown };
  } catch {
    await discardCacheSnapshot(libraryId, home);
    return null;
  }
}

/** Replace the library's snapshot: the state first, under its digest, then the header naming it. */
export async function writeCacheSnapshot(
  snapshot: Omit<CacheSnapshotHeader, "schemaVersion" | "stateDigest"> & { readonly state: unknown },
  home?: string,
): Promise<CacheSnapshotHeader> {
  const directory = snapshotsDirectory(snapshot.libraryId, home);
  await mkdir(directory, { recursive: true });
  const stateText = `${JSON.stringify(snapshot.state)}\n`;
  const stateDigest = sha256(stateText);
  await writeFileAtomic(join(directory, `${stateDigest}.json`), stateText);
  const header: CacheSnapshotHeader = {
    schemaVersion: CACHE_SNAPSHOT_SCHEMA_VERSION,
    libraryId: snapshot.libraryId,
    engineVersion: snapshot.engineVersion,
    version: snapshot.version,
    maxClock: snapshot.maxClock,
    streams: snapshot.streams,
    stateDigest,
  };
  await writeFileAtomic(join(directory, SNAPSHOT_HEADER_FILE), `${JSON.stringify(header)}\n`);
  // States no header names any more. Another writer's state that its header has not named yet
  // may go too; that header then fails to verify and the next read writes a new snapshot.
  for (const name of await readdir(directory)) {
    if (STATE_FILE_PATTERN.test(name) && name !== `${stateDigest}.json`) await rm(join(directory, name), { force: true });
  }
  return header;
}

/** Remove the library's snapshot (its header and every state file). */
export async function discardCacheSnapshot(libraryId: string, home?: string): Promise<void> {
  await rm(snapshotsDirectory(libraryId, home), { recursive: true, force: true });
}

/** The stamp of the library's cached views, or null when there is none or it does not parse. */
export async function readCacheViewStamp(libraryId: string, home?: string): Promise<CacheViewStamp | null> {
  const text = await readText(join(viewsDirectory(libraryId, home), VIEWS_STAMP_FILE));
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.schemaVersion !== CACHE_VIEWS_SCHEMA_VERSION || typeof value.engineVersion !== "string" ||
      !(value.headEventHash === null || typeof value.headEventHash === "string") || !isCount(value.version)) {
      return null;
    }
    return { schemaVersion: CACHE_VIEWS_SCHEMA_VERSION, engineVersion: value.engineVersion, headEventHash: value.headEventHash, version: value.version };
  } catch {
    return null;
  }
}

export function sameViewStamp(left: CacheViewStamp | null, right: CacheViewStamp): boolean {
  return left !== null && left.engineVersion === right.engineVersion && left.headEventHash === right.headEventHash && left.version === right.version;
}

/**
 * Replace the library's cached views with `documents`, removing any view the projection no
 * longer holds, and stamp them. The stamp is written last, so a stamp only ever describes a
 * complete set.
 */
export async function writeCacheViews(libraryId: string, documents: Readonly<Record<string, string>>, stamp: CacheViewStamp, home?: string): Promise<void> {
  const directory = viewsDirectory(libraryId, home);
  await mkdir(directory, { recursive: true });
  await rm(join(directory, VIEWS_STAMP_FILE), { force: true });
  for (const [name, text] of Object.entries(documents)) await writeFileAtomic(join(directory, name), text);
  for (const name of await readdir(directory)) {
    if (!Object.hasOwn(documents, name) && name !== VIEWS_STAMP_FILE && !isAtomicTemporaryName(name)) await rm(join(directory, name), { force: true });
  }
  await writeFileAtomic(join(directory, VIEWS_STAMP_FILE), `${JSON.stringify(stamp)}\n`);
}

/** One cached view document, or null when the cache does not hold it. */
export async function readCacheView(libraryId: string, name: string, home?: string): Promise<string | null> {
  return readText(join(viewsDirectory(libraryId, home), name));
}

/** Remove everything this device has cached for the library. */
export async function clearLibraryCache(libraryId: string, home?: string): Promise<void> {
  await rm(cachePath(libraryId, home), { recursive: true, force: true });
}
