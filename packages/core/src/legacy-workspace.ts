// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-466 R2, AC1 / STORY-467 R4, AC3: the old workspace layout
// (`<root>/<LEGACY_CONTROL_DIRECTORY>/`) opened read-only. This reader takes no lease, reads no view,
// creates no directory and writes no snapshot, cache or index: it reads workspace.json and
// the event segments, checks every event's identity and hashes from genesis, and replays
// through the engine's own reducer. A break is reported with the stream, the sequence and
// the event id where the chain stops being provable.
//
// The directory walk follows the engine that wrote these trees: the event segments are the
// entries of events/ (the manifest and the .idx files beside them are that engine's
// sidecars, never its authority), numbered without a gap, NDJSON for storage version 2
// and JSON arrays for storage version 1.

import { lstat, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { assertCanonicalJson, canonicalSha256, createEvent, isEventSchemaVersion } from "../../protocol/src/index.js";
import type { EventRecord, JsonValue } from "../../protocol/src/index.js";
import { LEGACY_CONTROL_DIRECTORY, LEGACY_EVENTS_DIRECTORY } from "./names.js";
import {
  WORKSPACE_STORAGE_VERSION,
  legacyWorkspaceEventId,
  legacyWorkspaceStreamId,
  materializeFromGenesis,
  parseLegacyWorkspaceMetadata,
} from "./workspace.js";
import type { WorkspaceMetadata, WorkspaceState } from "./workspace.js";

export const LEGACY_WORKSPACE_REASON_CODES = Object.freeze([
  "CHAIN_EVENT_CORRUPT",
  "CHAIN_PRIOR_HASH_BROKEN",
  "LEGACY_WORKSPACE_NOT_FOUND",
] as const);
export type LegacyWorkspaceReasonCode = typeof LEGACY_WORKSPACE_REASON_CODES[number];

export class LegacyWorkspaceError extends Error {
  readonly reasonCode: LegacyWorkspaceReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: LegacyWorkspaceReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "LegacyWorkspaceError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface LegacySegment {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LegacyWorkspace {
  readonly root: string;
  readonly metadata: WorkspaceMetadata;
  readonly streamId: string;
  readonly events: readonly EventRecord[];
  readonly segments: readonly LegacySegment[];
}

export type ChainBreakKind = "payloadHash" | "eventHash" | "priorHash";

export interface ChainBreak {
  readonly reasonCode: "CHAIN_PRIOR_HASH_BROKEN" | "CHAIN_EVENT_CORRUPT";
  readonly streamId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly detail: string;
}

export interface ChainReport {
  readonly events: number;
  readonly headEventHash: string | null;
  readonly streams: readonly { readonly streamId: string; readonly events: number; readonly headEventHash: string | null }[];
}

const EVENT_FIELDS = ["eventHash", "id", "occurredAt", "payload", "payloadHash", "priorHash", "schemaVersion", "sequence", "streamId"];
// The engine that wrote these trees kept one segment up to 64 MiB; nothing larger is read.
const SEGMENT_MAXIMUM_BYTES = 67_108_864;
const METADATA_MAXIMUM_BYTES = 1_048_576;

function corrupt(message: string, details: Readonly<Record<string, string>>): never {
  throw new LegacyWorkspaceError("CHAIN_EVENT_CORRUPT", message, details);
}

async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    corrupt(`${path} is not a readable regular file`, { segment: path.split(/[\\/]/u).at(-1) ?? path });
  }
  return readFile(path);
}

/** The control directory of an old-layout workspace, or null when there is none. */
export async function legacyControlDirectory(rootInput: string): Promise<string | null> {
  const control = join(resolve(rootInput), LEGACY_CONTROL_DIRECTORY);
  try {
    const metadata = await lstat(join(control, "workspace.json"));
    return metadata.isFile() ? control : null;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR") return null;
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseSegment(name: string, content: Buffer, ndjson: boolean, streamId: string, nextSequence: number): EventRecord[] {
  const where = (line: number): Readonly<Record<string, string>> => ({ streamId, segment: name, sequence: String(nextSequence + line), line: String(line + 1) });
  if (ndjson) {
    const text = content.toString("utf8");
    if (!text.endsWith("\n") || text.endsWith("\n\n") || text.length === 1) corrupt(`${name} is not canonical NDJSON`, where(0));
    return text.split("\n").slice(0, -1).map((line, index) => {
      let parsed: JsonValue;
      try {
        parsed = assertCanonicalJson(`${line}\n`);
      } catch (error) {
        corrupt(`${name} line ${index + 1}: ${String((error as { message?: string }).message ?? error)}`, where(index));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) corrupt(`${name} line ${index + 1} is not an event`, where(index));
      return parsed as unknown as EventRecord;
    });
  }
  let parsed: JsonValue;
  try {
    parsed = assertCanonicalJson(content.toString("utf8"));
  } catch (error) {
    corrupt(`${name}: ${String((error as { message?: string }).message ?? error)}`, where(0));
  }
  if (!Array.isArray(parsed) || parsed.length === 0) corrupt(`${name} is not an event array`, where(0));
  return parsed.map((event, index) => {
    if (event === null || typeof event !== "object" || Array.isArray(event)) corrupt(`${name} entry ${index + 1} is not an event`, where(index));
    return event as unknown as EventRecord;
  });
}

/**
 * Open `<root>/<LEGACY_CONTROL_DIRECTORY>/` read-only: metadata and every event, unvalidated beyond
 * parsing. Nothing is created, locked or written.
 */
export async function openLegacyWorkspace(rootInput: string): Promise<LegacyWorkspace> {
  const root = resolve(rootInput);
  const control = await legacyControlDirectory(root);
  if (control === null) {
    throw new LegacyWorkspaceError("LEGACY_WORKSPACE_NOT_FOUND", `${root} has no old-layout workspace`, { layout: "legacy" });
  }
  const metadata = parseLegacyWorkspaceMetadata((await readRegularFile(join(control, "workspace.json"), METADATA_MAXIMUM_BYTES)).toString("utf8"));
  const streamId = legacyWorkspaceStreamId(metadata);
  const ndjson = metadata.storageVersion === WORKSPACE_STORAGE_VERSION;
  const eventsDirectory = join(control, LEGACY_EVENTS_DIRECTORY);
  const names = (await readdir(eventsDirectory)).sort();
  const pattern = ndjson ? /^\d{6}\.ndjson$/u : /^\d{6}\.json$/u;
  const segmentNames = names.filter((name) => !(ndjson && (name === "manifest.json" || name.endsWith(".idx"))));
  const events: EventRecord[] = [];
  const segments: LegacySegment[] = [];
  for (const [index, name] of segmentNames.entries()) {
    if (!pattern.test(name)) corrupt(`unexpected event entry ${name}`, { streamId, segment: name });
    if (name !== `${String(index + 1).padStart(6, "0")}.${ndjson ? "ndjson" : "json"}`) {
      corrupt(`event segment gap at ${name}`, { streamId, segment: name });
    }
    const content = await readRegularFile(join(eventsDirectory, name), SEGMENT_MAXIMUM_BYTES);
    segments.push({ name, bytes: content.length, sha256: sha256(content) });
    events.push(...parseSegment(name, content, ndjson, streamId, events.length + 1));
  }
  return { root, metadata, streamId, events, segments };
}

/** The first place the chain stops being provable, or null when every event checks out. */
export function findLegacyChainBreak(workspace: LegacyWorkspace): ChainBreak | null {
  let prior: string | null = null;
  for (const [index, event] of workspace.events.entries()) {
    const sequence = index + 1;
    const eventId = typeof event.id === "string" ? event.id : "unknown";
    const broken = (reasonCode: ChainBreak["reasonCode"], detail: string): ChainBreak => ({ reasonCode, streamId: workspace.streamId, sequence, eventId, detail });
    const fields = Object.keys(event).sort();
    if (fields.length !== EVENT_FIELDS.length || fields.some((field, position) => field !== EVENT_FIELDS[position])) {
      return broken("CHAIN_EVENT_CORRUPT", "event fields");
    }
    // An old-layout chain written before EPIC-141 holds tcrn.event.v1 only; one the engine kept
    // writing until the switch to libraries may continue in einzbern.event.v1.
    if (!isEventSchemaVersion(event.schemaVersion)) return broken("CHAIN_EVENT_CORRUPT", "schemaVersion");
    if (event.sequence !== sequence) return broken("CHAIN_EVENT_CORRUPT", "sequence");
    if (event.streamId !== workspace.streamId || event.id !== legacyWorkspaceEventId(workspace.streamId, sequence)) {
      return broken("CHAIN_EVENT_CORRUPT", "identity");
    }
    let rebuilt: EventRecord;
    try {
      rebuilt = createEvent({
        id: event.id,
        streamId: event.streamId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        priorHash: event.priorHash,
        payload: event.payload,
      }, event.schemaVersion);
    } catch {
      return broken("CHAIN_EVENT_CORRUPT", "envelope");
    }
    const kind: ChainBreakKind | null = event.payloadHash !== canonicalSha256(event.payload)
      ? "payloadHash"
      : event.eventHash !== rebuilt.eventHash
        ? "eventHash"
        : event.priorHash !== prior
          ? "priorHash"
          : null;
    if (kind !== null) return broken("CHAIN_PRIOR_HASH_BROKEN", kind);
    prior = event.eventHash;
  }
  return null;
}

/** Validate the whole chain from genesis; a break throws with its stream, sequence and event id. */
export function validateLegacyChain(workspace: LegacyWorkspace): ChainReport {
  const found = findLegacyChainBreak(workspace);
  if (found !== null) {
    throw new LegacyWorkspaceError(found.reasonCode, `chain breaks at ${found.streamId} sequence ${found.sequence} (${found.detail})`, {
      layout: "legacy",
      streamId: found.streamId,
      sequence: String(found.sequence),
      eventId: found.eventId,
      break: found.detail,
    });
  }
  const headEventHash = workspace.events.at(-1)?.eventHash ?? null;
  return {
    events: workspace.events.length,
    headEventHash,
    streams: [{ streamId: workspace.streamId, events: workspace.events.length, headEventHash }],
  };
}

/** Replay a validated old-layout workspace from genesis through the engine's reducer. */
export function replayLegacyWorkspace(workspace: LegacyWorkspace): WorkspaceState {
  validateLegacyChain(workspace);
  return materializeFromGenesis(workspace.metadata, workspace.events);
}
