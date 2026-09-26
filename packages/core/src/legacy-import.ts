// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-468 R6, AC4 / STORY-466 AC3: an old-layout workspace becomes a library whose
// first stream is its chain, byte for byte. The old workspace is only read (openLegacyWorkspace
// takes no lock and writes nothing) and its whole chain is validated from genesis first. A dry run
// stops there and reports what an import would carry, without creating a file. A real import
// creates the library under the old workspace id, so every record, reference and receipt keeps
// the id it had, copies each old segment into this device's stream directory unchanged (checked
// file by file against its SHA-256), and commits a stream manifest that keeps the old stream id
// and event identities (identityScheme "legacy"), the old sequence and head, and a clock
// high-water mark equal to the old event count (an old event's clock is its sequence). The new
// library is then replayed and must hold the same events, head and records as the old chain.
// This device's later events continue the same stream: the next sequence, a priorHash on the old
// head, and einzbern.event.v1 while the old events stay tcrn.event.v1.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import {
  STREAM_MANIFEST_FILE,
  STREAM_MANIFEST_SCHEMA_VERSION,
  segmentName,
  streamDirectory,
  validateStreamManifest,
  withLibraryWriteLock,
} from "./akasha.js";
import type { StreamManifest, StreamSegment } from "./akasha.js";
import { readOrCreateDevice } from "./device-identity.js";
import { LIBRARY_FORMAT_VERSION, createLibrary } from "./ether-library.js";
import { writeConfigProjection } from "./library-config.js";
import { openLegacyWorkspace, replayLegacyWorkspace, validateLegacyChain } from "./legacy-workspace.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY, LEGACY_EVENTS_DIRECTORY } from "./names.js";
import { materializeLibrary } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";
import { FRAMEWORK_VERSION } from "./index.js";

export const LEGACY_IMPORT_REASON_CODES = Object.freeze([
  "LEGACY_IMPORT_MISMATCH",
] as const);
export type LegacyImportReasonCode = typeof LEGACY_IMPORT_REASON_CODES[number];

export class LegacyImportError extends Error {
  readonly reasonCode: LegacyImportReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: LegacyImportReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "LegacyImportError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface LegacyImportSegment {
  readonly source: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface LegacyImportOptions {
  readonly createdAt: string;
  readonly dryRun?: boolean;
  readonly projectName?: string | null;
  readonly gitRemote?: string | null;
}

export interface LegacyImportReport {
  readonly reasonCode: "LEGACY_IMPORT_DRY_RUN" | "LEGACY_IMPORTED";
  readonly dryRun: boolean;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly events: number;
  readonly headEventHash: string | null;
  readonly segments: readonly LegacyImportSegment[];
  // Present on a real import only.
  readonly target: string | null;
  readonly deviceId: string | null;
  readonly libraryHeadEventHash: string | null;
}

/** Where an import puts the library when no target is named: `.ether` in the old workspace root. */
export function defaultImportTarget(legacyRoot: string): string {
  return join(resolve(legacyRoot), DIRECTORY.library);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordsDigest(state: WorkspaceState): string {
  return canonicalSha256({
    projects: state.projects,
    work: state.work,
    conferences: state.conferences,
    conferencePositions: state.conferencePositions,
    conferenceMinutes: state.conferenceMinutes,
    gates: state.gates,
    settings: state.settings,
    templates: state.templates,
  } as unknown as JsonValue);
}

function mismatch(message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new LegacyImportError("LEGACY_IMPORT_MISMATCH", message, details);
}

/**
 * Import the old-layout workspace at `legacyRoot` into a new library at `target` (which must not
 * exist or be empty), or, with `dryRun`, report what the import would carry without writing.
 */
export async function importLegacyWorkspace(legacyRoot: string, target: string, options: LegacyImportOptions): Promise<LegacyImportReport> {
  const legacy = await openLegacyWorkspace(legacyRoot);
  const chain = validateLegacyChain(legacy);
  const legacyState = replayLegacyWorkspace(legacy);
  const segments: LegacyImportSegment[] = legacy.segments.map((segment, index) => ({
    source: segment.name,
    name: segmentName(index + 1, segment.name.endsWith(".ndjson") ? "ndjson" : "json"),
    bytes: segment.bytes,
    sha256: segment.sha256,
    firstSequence: segment.firstSequence,
    lastSequence: segment.lastSequence,
  }));
  const report = {
    workspaceId: legacy.metadata.workspaceId,
    streamId: legacy.streamId,
    events: chain.events,
    headEventHash: chain.headEventHash,
    segments,
  };
  if (options.dryRun === true) {
    return { reasonCode: "LEGACY_IMPORT_DRY_RUN", dryRun: true, ...report, target: null, deviceId: null, libraryHeadEventHash: null };
  }

  const library = await createLibrary(target, {
    createdAt: options.createdAt,
    libraryId: legacy.metadata.workspaceId,
    ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
    ...(options.gitRemote === undefined ? {} : { gitRemote: options.gitRemote }),
  });
  const { device } = await readOrCreateDevice();
  await withLibraryWriteLock(library, async () => {
    const directory = streamDirectory(library.root, device.deviceId);
    await mkdir(directory, { recursive: true });
    const sourceDirectory = join(legacy.root, LEGACY_CONTROL_DIRECTORY, LEGACY_EVENTS_DIRECTORY);
    const streamSegments: StreamSegment[] = [];
    for (const segment of segments) {
      const bytes = await readFile(join(sourceDirectory, segment.source));
      if (bytes.length !== segment.bytes || sha256(bytes) !== segment.sha256) {
        mismatch(`${segment.source} changed while it was imported`, { segment: segment.source });
      }
      await writeFileAtomic(join(directory, segment.name), bytes);
      const copied = await readFile(join(directory, segment.name));
      if (sha256(copied) !== segment.sha256) mismatch(`${segment.name} does not hash as ${segment.source} did`, { segment: segment.name });
      streamSegments.push({ name: segment.name, firstSequence: segment.firstSequence, lastSequence: segment.lastSequence, bytes: segment.bytes, sha256: segment.sha256 });
    }
    const manifest: StreamManifest = validateStreamManifest({
      schemaVersion: STREAM_MANIFEST_SCHEMA_VERSION,
      streamId: legacy.streamId,
      deviceId: device.deviceId,
      displayName: device.displayName,
      identityScheme: "legacy",
      sequence: chain.events,
      headEventHash: chain.headEventHash,
      clockHighWater: chain.events,
      segments: streamSegments,
      engineVersion: FRAMEWORK_VERSION,
      formatVersion: LIBRARY_FORMAT_VERSION,
    }, device.deviceId);
    await writeFileAtomic(join(directory, STREAM_MANIFEST_FILE), canonicalJson(manifest));
  });

  // The library must replay to what the old chain holds: the events, the stream head and every record.
  const imported = await materializeLibrary(library);
  const stream = imported.library?.streams.find((entry) => entry.deviceId === device.deviceId);
  if (imported.version !== chain.events || stream?.headEventHash !== chain.headEventHash || stream?.sequence !== chain.events) {
    mismatch("the imported library does not replay to the old chain's events and head", { events: String(imported.version) });
  }
  if ((imported.library?.rejectedEvents.length ?? 0) > 0 || recordsDigest(imported) !== recordsDigest(legacyState)) {
    mismatch("the imported library does not replay to the old chain's records");
  }
  // The imported settings are project-level settings of the library (TCRN-CROSS-STORY-469 R2).
  await writeConfigProjection(library.root, { versionVector: imported.library?.versionVector ?? {}, settings: imported.settings });
  return {
    reasonCode: "LEGACY_IMPORTED",
    dryRun: false,
    ...report,
    target: library.root,
    deviceId: device.deviceId,
    libraryHeadEventHash: imported.headEventHash,
  };
}
