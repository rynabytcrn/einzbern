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
//
// TCRN-CROSS-SUB-421 (TCRN-CROSS-INC-397; fixes STORY-468 R6): the records the replay is compared
// on are hashed one record at a time (legacyRecordsDigest), so a chain whose records run past one
// MiB -- cross-project's eight collections measure 7.7 MB -- is compared record for record instead
// of refused with INPUT_OVERSIZED after its segments were written. A dry run makes every check a
// real import makes before it writes: the chain, the records digest and the old knowledge store,
// read through this engine's own reader, and it reports the same digest and counts. The old
// knowledge store (MIN-239 D7) is carried into crest/ as its engine left it -- the marker, the
// metadata and the bodies, byte for byte -- and read back: the library's crest must answer the
// cards the old store answers, by default and in all. Its views stay behind, since a library's
// index view is this device's cache. config/project.json is written once everything checked. An
// import that stops after it has written into its target says what it left there
// (LegacyImportStoppedError).
//
// TCRN-CROSS-SUB-421 R18 (STORY-489): the receipt counts the old store's cards as the store holds
// them. `cards` is every card whatever its status -- since TCRN-CROSS-SUB-425 a card its engine
// marked superseded (extensions.supersededBy) reads as removed, and it is carried with the rest --,
// `removedCards` those that read as removed, and `defaultCards` those knowledge-list answers by
// default; the carried crest must answer all three the same. A store this engine's reader refuses
// is refused with the reader's own reason code, naming the file of the store the refusal is about
// (LegacyKnowledgeRefusedError, `details.file` relative to the store's root).

import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { assertCanonicalJson, assertStrictInstant, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
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
import { KnowledgeCoreError, initializeKnowledgeStore, listKnowledgeMetadata } from "./knowledge-core.js";
import type { KnowledgeStatusFilter } from "./knowledge-core.js";
import { writeConfigProjection } from "./library-config.js";
import { openLegacyWorkspace, replayLegacyWorkspace, validateLegacyChain } from "./legacy-workspace.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY, LEGACY_EVENTS_DIRECTORY, LEGACY_KNOWLEDGE_DIRECTORY } from "./names.js";
import { materializeLibrary } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";
import { FRAMEWORK_VERSION } from "./index.js";

export const LEGACY_IMPORT_REASON_CODES = Object.freeze([
  "LEGACY_IMPORT_MISMATCH",
  // TCRN-CROSS-SUB-421: what an import that stopped after writing answers when what stopped it
  // carries no reason code of its own (a file system error, say).
  "LEGACY_IMPORT_STOPPED",
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

/**
 * TCRN-CROSS-SUB-421 (INC-397): an import that stopped after it had written into its target. It
 * answers with the reason code and details of what stopped it, adds the target, and names what the
 * import left there -- every file and every empty directory, relative to the target, in canonical
 * order -- in `written` and in its message, so a half-built library is never left unannounced.
 * Nothing is removed: the target keeps what was written, to be looked at and moved aside before the
 * import runs again (a target that is not empty is refused).
 */
export class LegacyImportStoppedError extends Error {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, string>>;
  readonly target: string;
  readonly written: readonly string[];

  constructor(cause: unknown, target: string, written: readonly string[]) {
    const code = (cause as { reasonCode?: unknown } | null)?.reasonCode;
    const reasonCode = typeof code === "string" ? code : "LEGACY_IMPORT_STOPPED";
    const causeDetails = (cause as { details?: unknown } | null)?.details;
    const details: Record<string, string> = {};
    if (causeDetails !== null && typeof causeDetails === "object") {
      for (const [key, value] of Object.entries(causeDetails)) if (typeof value === "string") details[key] = value;
    }
    const fileCode = (cause as { code?: unknown } | null)?.code;
    if (typeof code !== "string" && typeof fileCode === "string") details.cause = fileCode;
    const message = String((cause as { message?: unknown } | null)?.message ?? cause);
    super(`${message}; the import stopped after writing ${written.length} entries under ${target}: ${written.join(", ")}`, { cause });
    this.name = "LegacyImportStoppedError";
    this.reasonCode = reasonCode;
    this.details = { ...details, target };
    this.target = target;
    this.written = written;
  }
}

/**
 * TCRN-CROSS-SUB-421 R18: the old knowledge store, refused by this engine's reader of the old layout
 * (KNOWLEDGE_RECORD_INVALID, KNOWLEDGE_PATH_INVALID, KNOWLEDGE_PARTIAL_STATE, ...). It keeps the
 * reader's reason code, string details and message, and names the file of the store the refusal is
 * about -- relative to the store's root, with `/`, or "." for the store as a whole -- in
 * `details.file`, in `file` and in its message; `store` is the store's root. The store is read before
 * the target is touched, so an import refused this way has written nothing, like a dry run.
 */
export class LegacyKnowledgeRefusedError extends Error {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, string>>;
  readonly store: string;
  readonly file: string;

  constructor(cause: KnowledgeCoreError, store: string, file: string) {
    const details: Record<string, string> = {};
    for (const [key, value] of Object.entries(cause.details ?? {})) if (typeof value === "string") details[key] = value;
    super(`${cause.message}: ${file === "." ? "the old knowledge store" : `${file} of the old knowledge store`} ${store}`, { cause });
    this.name = "LegacyKnowledgeRefusedError";
    this.reasonCode = cause.reasonCode;
    this.details = { ...details, file };
    this.store = store;
    this.file = file;
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

/** TCRN-CROSS-SUB-421: the eight record collections an import compares. */
export type LegacyRecordCollection = "projects" | "work" | "conferences" | "conferencePositions" | "conferenceMinutes" | "gates" | "settings" | "templates";
export type LegacyRecordState = Pick<WorkspaceState, LegacyRecordCollection>;

export interface LegacyImportRecords {
  // legacyRecordsDigest of the old chain's replay; a real import's library replays to the same.
  readonly digest: string;
  readonly counts: Readonly<Record<LegacyRecordCollection, number>>;
}

export interface LegacyImportKnowledge {
  // The old store's cards, counted as knowledge-list counts them at the import's instant: `cards`
  // is every card whatever its status (--selection all --status all), `removedCards` those of them
  // that read as removed (--status removed; a card its engine marked superseded, with
  // extensions.supersededBy, reads so and is carried with the rest), and `defaultCards` those it
  // answers by default (valid cards only). The library's crest answers all three the same after an
  // import.
  readonly cards: number;
  readonly removedCards: number;
  readonly defaultCards: number;
  // The files carried into crest/ unchanged -- the marker, one metadata file per card and the
  // bodies, one file per card or segments with their index and manifest -- and their bytes.
  readonly files: number;
  readonly bytes: number;
}

/** An explicit mapping declaration; leaving it out keeps the ordinary, strict carry path. */
export interface LegacyKnowledgeOmission {
  readonly reason: string;
}

export interface LegacyKnowledgeDiagnostic {
  readonly reasonCode: string;
  readonly file: string;
  readonly message: string;
}

export interface LegacyKnowledgeOmittedFile {
  readonly file: string;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly issue: LegacyKnowledgeDiagnostic | null;
}

/** Read-only evidence, never accepted card records or a replacement knowledge store. */
export interface LegacyKnowledgeOmissionReport {
  readonly selection: "omit";
  readonly reason: string;
  readonly store: string;
  readonly presence: "present" | "absent" | "unknown";
  // Counts come only from the ordinary reader. Parsed metadata below cannot establish them.
  readonly counts: Pick<LegacyImportKnowledge, "cards" | "removedCards" | "defaultCards"> | "unknown" | "absent";
  readonly refusal: LegacyKnowledgeDiagnostic | null;
  readonly files: readonly LegacyKnowledgeOmittedFile[];
  readonly unvalidatedCards: readonly { readonly file: string; readonly id: string | null; readonly externalKey: string | null }[];
}

/** The mapping and the single import use the same closed shape and reason constraint. */
export function legacyKnowledgeOmissionIssue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "omitLegacyKnowledge";
  const fields = Object.keys(value);
  const extra = fields.find((field) => field !== "reason");
  if (extra !== undefined) return `omitLegacyKnowledge.${extra}`;
  const reason = (value as { readonly reason?: unknown }).reason;
  return typeof reason === "string" && reason.isWellFormed() && reason.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(reason)
    ? null
    : "omitLegacyKnowledge.reason";
}

export interface LegacyImportOptions {
  readonly createdAt: string;
  readonly dryRun?: boolean;
  readonly projectName?: string | null;
  readonly gitRemote?: string | null;
  readonly omitLegacyKnowledge?: LegacyKnowledgeOmission;
  // Test seam: what lands in the target for one file an import copies, named by its path relative
  // to the target (an import copies it unchanged).
  readonly copyTransformForTest?: (relativePath: string, bytes: Buffer) => Buffer;
}

export interface LegacyImportReport {
  readonly reasonCode: "LEGACY_IMPORT_DRY_RUN" | "LEGACY_IMPORTED";
  readonly dryRun: boolean;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly events: number;
  readonly headEventHash: string | null;
  readonly segments: readonly LegacyImportSegment[];
  // TCRN-CROSS-SUB-421: the same in a dry run and a real import.
  readonly records: LegacyImportRecords;
  // TCRN-CROSS-SUB-421 (MIN-239 D7): the old knowledge store the import carries; null when the old
  // workspace has none, or an explicit omission is reported in knowledgeOmission.
  readonly knowledge: LegacyImportKnowledge | null;
  readonly knowledgeOmission: LegacyKnowledgeOmissionReport | null;
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

function mismatch(message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new LegacyImportError("LEGACY_IMPORT_MISMATCH", message, details);
}

// The collections in the canonical order of their keys: the order canonicalJson writes the object
// they form.
const RECORD_COLLECTIONS: readonly LegacyRecordCollection[] = Object.freeze(([
  "projects", "work", "conferences", "conferencePositions", "conferenceMinutes", "gates", "settings", "templates",
] as LegacyRecordCollection[]).sort(compareCanonicalText));

// One collection as its canonical JSON array: each record serialised by canonicalJson on its own,
// with every check it makes, its terminal LF left off.
function feedCollection(hash: Hash, records: readonly unknown[]): void {
  hash.update("[");
  records.forEach((record, index) => {
    const text = canonicalJson(record);
    hash.update(`${index === 0 ? "" : ","}${text.slice(0, -1)}`);
  });
  hash.update("]");
}

/**
 * TCRN-CROSS-SUB-421 (INC-397): the SHA-256 of the canonical JSON of a state's eight record
 * collections -- the object `{"conferenceMinutes":[...],...,"work":[...]}` and its terminal LF --
 * fed to the hash one record at a time. Each record is serialised by canonicalJson on its own, with
 * every check it makes; the punctuation between them is the whole object's. For a set within the
 * protocol's limits the digest is canonicalSha256 of that object, byte for byte; a set past one MiB
 * is compared the same way instead of being refused. No record is skipped, and a record that is
 * not canonical, or alone exceeds a limit, still throws.
 */
export function legacyRecordsDigest(state: LegacyRecordState): string {
  const hash = createHash("sha256");
  hash.update("{");
  RECORD_COLLECTIONS.forEach((name, index) => {
    hash.update(`${index === 0 ? "" : ","}${JSON.stringify(name)}:`);
    feedCollection(hash, state[name]);
  });
  return hash.update("}\n").digest("hex");
}

// One collection's digest the same way, to name the collections a mismatch differs in.
function collectionDigest(records: readonly unknown[]): string {
  const hash = createHash("sha256");
  feedCollection(hash, records);
  return hash.update("\n").digest("hex");
}

/**
 * TCRN-CROSS-SUB-421: refuse with LEGACY_IMPORT_MISMATCH unless `imported` holds the records `legacy`
 * holds, compared by legacyRecordsDigest; the refusal names each collection that differs.
 */
export function assertLegacyRecordsMatch(legacy: LegacyRecordState, imported: LegacyRecordState): void {
  if (legacyRecordsDigest(imported) === legacyRecordsDigest(legacy)) return;
  const differing = RECORD_COLLECTIONS.filter((name) => collectionDigest(imported[name]) !== collectionDigest(legacy[name]));
  mismatch(`the imported library does not replay to the old chain's records (${differing.join(", ")})`, { collections: differing.join(",") });
}

function recordsReport(state: LegacyRecordState): LegacyImportRecords {
  const counts = Object.fromEntries(RECORD_COLLECTIONS.map((name) => [name, state[name].length]));
  return { digest: legacyRecordsDigest(state), counts: counts as Readonly<Record<LegacyRecordCollection, number>> };
}

// ---- the old knowledge store (MIN-239 D7) ----

// What the old store's root holds as its engine left it. A mutation claim, above all, is a write of
// that engine still running or interrupted, and such a store is not carried.
const LEGACY_KNOWLEDGE_ROOT_ENTRIES: readonly string[] = Object.freeze(["bodies", "metadata", "store.json", "views"]);
const KNOWLEDGE_MARKER_FILE = "store.json";
const KNOWLEDGE_CARRIED_DIRECTORIES: readonly string[] = Object.freeze(["metadata", "bodies"]);

// One carried file of the old store: its path under the store, with `/`, its size and digest.
interface KnowledgeFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface LegacyKnowledge {
  readonly storeRoot: string;
  readonly files: readonly KnowledgeFile[];
  readonly report: LegacyImportKnowledge;
}

async function regularFile(path: string, label: string): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile()) mismatch(`${label} is not a regular file`, { file: label });
  return readFile(path);
}

// The files the import carries, as they are now: the marker, then metadata/ and bodies/ in order.
async function knowledgeFiles(storeRoot: string): Promise<readonly KnowledgeFile[]> {
  const entries = (await readdir(storeRoot)).sort(compareCanonicalText);
  if (entries.join("\0") !== LEGACY_KNOWLEDGE_ROOT_ENTRIES.join("\0")) {
    mismatch(`the old knowledge store holds ${entries.join(", ")}, not only ${LEGACY_KNOWLEDGE_ROOT_ENTRIES.join(", ")}`, { file: LEGACY_KNOWLEDGE_DIRECTORY });
  }
  const files: KnowledgeFile[] = [];
  const add = async (path: string): Promise<void> => {
    const bytes = await regularFile(join(storeRoot, path), `${LEGACY_KNOWLEDGE_DIRECTORY}/${path}`);
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  };
  await add(KNOWLEDGE_MARKER_FILE);
  for (const directory of KNOWLEDGE_CARRIED_DIRECTORIES) {
    for (const name of (await readdir(join(storeRoot, directory))).sort(compareCanonicalText)) await add(`${directory}/${name}`);
  }
  return files;
}

// How many cards knowledge-list answers for the store a root holds, at `at`, with one selection and
// one status. One card is asked for: `total` counts every card the query matches.
async function listedCards(root: string, at: string, selection: "default" | "all", status: KnowledgeStatusFilter): Promise<number> {
  const answer = await listKnowledgeMetadata(root, { at, selection, status, allowTrailing: true, limit: 1 });
  return Number(answer.total);
}

type KnowledgeCardCounts = Pick<LegacyImportKnowledge, "cards" | "removedCards" | "defaultCards">;

// The three counts of a receipt (LegacyImportKnowledge), as the store a root holds answers them.
async function cardCounts(root: string, at: string): Promise<KnowledgeCardCounts> {
  return {
    cards: await listedCards(root, at, "all", "all"),
    removedCards: await listedCards(root, at, "all", "removed"),
    defaultCards: await listedCards(root, at, "default", "valid"),
  };
}

// ---- which file of the old store a refusal is about (TCRN-CROSS-SUB-421 R18) ----

// The one file an old store's views/ holds.
const LEGACY_KNOWLEDGE_VIEW_FILE = "index.json";
// The refusals the reader makes of a file's form, or of what the marker binds, as it parses the
// marker and then each card.
const KNOWLEDGE_FORM_REFUSALS: readonly string[] = Object.freeze(["KNOWLEDGE_CANONICAL_INVALID", "KNOWLEDGE_HIGH_WATER_MISMATCH", "KNOWLEDGE_RECORD_INVALID"]);

async function sortedEntries(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).sort(compareCanonicalText);
  } catch {
    return [];
  }
}

async function holdsCanonicalJson(path: string): Promise<boolean> {
  try {
    assertCanonicalJson((await readFile(path)).toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The file of the old store a refusal of its reader is about, relative to the store's root with `/`,
 * looked for in the order the reader reads the store. It is the file the refusal's message names,
 * as a path under the store or as a card's id. Else, for a refusal of the store's parts
 * (KNOWLEDGE_PARTIAL_STATE), the first entry its root or its views/ holds that its engine never left
 * there, else the first one it lacks, else the index view when the refusal is about the index. Else,
 * for a refusal of a file's form, the first file the reader parses as canonical JSON (the marker, then
 * each card's metadata) that does not hold it, else the marker when the refusal is about the marker.
 * Else ".", the store as a whole: the place its engine bound it to, or how its cards and bodies fit.
 * The store is only read.
 */
async function refusedKnowledgeFile(storeRoot: string, error: KnowledgeCoreError): Promise<string> {
  const rootEntries = await sortedEntries(storeRoot);
  const views = await sortedEntries(join(storeRoot, "views"));
  const metadata = (await sortedEntries(join(storeRoot, "metadata"))).map((name) => `metadata/${name}`);
  const bodies = (await sortedEntries(join(storeRoot, "bodies"))).map((name) => `bodies/${name}`);
  const files = [...rootEntries, ...metadata, ...bodies, ...views.map((name) => `views/${name}`)];
  const { message, reasonCode } = error;
  const roots = [storeRoot];
  try {
    roots.push(await realpath(storeRoot));
  } catch {
    // The store as it was named is the only form a message can hold.
  }
  const named = files
    .filter((file) => roots.some((root) => message.includes(join(root, ...file.split("/")))))
    .sort((left, right) => right.length - left.length)[0];
  if (named !== undefined) return named;
  const card = /knowledge:[a-f0-9]{24}/u.exec(message)?.[0];
  if (card !== undefined && metadata.includes(`metadata/${card}.json`)) return `metadata/${card}.json`;
  if (reasonCode === "KNOWLEDGE_PARTIAL_STATE") {
    const part = rootEntries.find((name) => !LEGACY_KNOWLEDGE_ROOT_ENTRIES.includes(name)) ??
      LEGACY_KNOWLEDGE_ROOT_ENTRIES.find((name) => !rootEntries.includes(name));
    if (part !== undefined) return part;
    const view = views.find((name) => name !== LEGACY_KNOWLEDGE_VIEW_FILE);
    if (view !== undefined) return `views/${view}`;
    if (!views.includes(LEGACY_KNOWLEDGE_VIEW_FILE) || message.includes("knowledge index")) return `views/${LEGACY_KNOWLEDGE_VIEW_FILE}`;
  }
  if (KNOWLEDGE_FORM_REFUSALS.includes(reasonCode)) {
    for (const file of [KNOWLEDGE_MARKER_FILE, ...metadata]) {
      if (!(await holdsCanonicalJson(join(storeRoot, file)))) return file;
    }
    if (reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH" || message.includes("knowledge marker")) return KNOWLEDGE_MARKER_FILE;
  }
  return ".";
}

/**
 * The old workspace's knowledge store, read through this engine's own reader of the old layout (which
 * checks the marker, every card and the index view), or null when the old workspace has none. A store
 * the reader refuses is refused with the reader's reason code, naming the file the refusal is about
 * (LegacyKnowledgeRefusedError).
 */
async function readLegacyKnowledge(legacyRoot: string, at: string): Promise<LegacyKnowledge | null> {
  const storeRoot = join(legacyRoot, LEGACY_CONTROL_DIRECTORY, LEGACY_KNOWLEDGE_DIRECTORY);
  try {
    await lstat(storeRoot);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let counts: KnowledgeCardCounts;
  try {
    counts = await cardCounts(legacyRoot, at);
  } catch (error) {
    if (!(error instanceof KnowledgeCoreError)) throw error;
    throw new LegacyKnowledgeRefusedError(error, storeRoot, await refusedKnowledgeFile(storeRoot, error));
  }
  const files = await knowledgeFiles(storeRoot);
  return {
    storeRoot,
    files,
    report: { ...counts, files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) },
  };
}

function knowledgeDiagnostic(error: unknown, file: string): LegacyKnowledgeDiagnostic {
  const coded = error as { readonly reasonCode?: unknown; readonly code?: unknown; readonly message?: unknown } | null;
  const code = coded?.reasonCode ?? coded?.code;
  return {
    reasonCode: typeof code === "string" ? code : "LEGACY_IMPORT_MISMATCH",
    file,
    message: String(coded?.message ?? error),
  };
}

// MIN-240 D3/D5: inspect what is deliberately left behind. The ordinary reader still makes its
// own checks, and its refusal is retained. A separate inventory names every regular file's raw
// bytes and every noncanonical JSON file, including files the first reader refusal hid. Parsing
// metadata here supplies explicitly unvalidated facts for a later reconstruction, never counts.
// Links are named as unavailable evidence and never followed by this inventory.
async function omittedLegacyKnowledge(legacyRoot: string, at: string, declaration: LegacyKnowledgeOmission): Promise<LegacyKnowledgeOmissionReport> {
  const store = join(legacyRoot, LEGACY_CONTROL_DIRECTORY, LEGACY_KNOWLEDGE_DIRECTORY);
  const report = { selection: "omit" as const, reason: declaration.reason, store };
  let directory: boolean;
  try {
    directory = (await lstat(store)).isDirectory();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { ...report, presence: "absent", counts: "absent", refusal: null, files: [], unvalidatedCards: [] };
    }
    return { ...report, presence: "unknown", counts: "unknown", refusal: knowledgeDiagnostic(error, "."), files: [], unvalidatedCards: [] };
  }
  if (!directory) {
    return { ...report, presence: "present", counts: "unknown", files: [], unvalidatedCards: [], refusal: {
      reasonCode: "KNOWLEDGE_PATH_INVALID", file: ".", message: "the omitted old knowledge store is not a directory (links are not followed)",
    } };
  }
  let counts: LegacyKnowledgeOmissionReport["counts"] = "unknown";
  let refusal: LegacyKnowledgeDiagnostic | null = null;
  try {
    const read = await readLegacyKnowledge(legacyRoot, at);
    if (read !== null) {
      const { cards, removedCards, defaultCards } = read.report;
      counts = { cards, removedCards, defaultCards };
    }
  } catch (error) {
    refusal = knowledgeDiagnostic(error, error instanceof LegacyKnowledgeRefusedError ? error.file : ".");
  }
  const files: LegacyKnowledgeOmittedFile[] = [];
  const unvalidatedCards: { file: string; id: string | null; externalKey: string | null }[] = [];
  const walk = async (directoryPath: string): Promise<void> => {
    let names: readonly string[];
    try {
      names = (await readdir(directoryPath)).sort(compareCanonicalText);
    } catch (error) {
      const file = relative(store, directoryPath).split(sep).join("/") || ".";
      files.push({ file, bytes: null, sha256: null, issue: knowledgeDiagnostic(error, file) });
      return;
    }
    for (const name of names) {
      const path = join(directoryPath, name);
      const file = relative(store, path).split(sep).join("/");
      try {
        const entry = await lstat(path);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.isFile()) {
          files.push({ file, bytes: null, sha256: null, issue: {
            reasonCode: "KNOWLEDGE_PATH_INVALID", file, message: "the omitted entry is not a regular file (links are not followed)",
          } });
          continue;
        }
        const bytes = await readFile(path);
        let issue: LegacyKnowledgeDiagnostic | null = null;
        if (file.endsWith(".json")) {
          try {
            assertCanonicalJson(bytes.toString("utf8"));
          } catch {
            issue = { reasonCode: "KNOWLEDGE_RECORD_INVALID", file, message: "the omitted file does not hold canonical JSON bytes" };
          }
        }
        files.push({ file, bytes: bytes.length, sha256: sha256(bytes), issue });
        if (/^metadata\/[^/]+\.json$/u.test(file)) {
          let parsed: { id?: unknown; externalKey?: unknown } | null = null;
          try {
            const value: unknown = JSON.parse(bytes.toString("utf8"));
            if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed = value;
          } catch {
            // The file remains in the inventory; no card identity is inferred from unreadable JSON.
          }
          unvalidatedCards.push({ file, id: typeof parsed?.id === "string" ? parsed.id : null, externalKey: typeof parsed?.externalKey === "string" ? parsed.externalKey : null });
        }
      } catch (error) {
        files.push({ file, bytes: null, sha256: null, issue: knowledgeDiagnostic(error, file) });
      }
    }
  };
  await walk(store);
  return { ...report, presence: "present", counts, refusal, files, unvalidatedCards };
}

function landing(options: LegacyImportOptions, relativePath: string, bytes: Buffer): Buffer {
  return options.copyTransformForTest?.(relativePath, bytes) ?? bytes;
}

// Carry the old store's files into the library's crest/, each read again, checked against what the
// dry-run part of the import read, and checked by SHA-256 as it lands.
async function carryKnowledge(knowledge: LegacyKnowledge, libraryRoot: string, options: LegacyImportOptions): Promise<void> {
  const crest = join(libraryRoot, DIRECTORY.knowledge);
  for (const directory of KNOWLEDGE_CARRIED_DIRECTORIES) await mkdir(join(crest, directory), { mode: 0o700 });
  for (const file of knowledge.files) {
    const label = `${LEGACY_KNOWLEDGE_DIRECTORY}/${file.path}`;
    const bytes = await regularFile(join(knowledge.storeRoot, file.path), label);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) mismatch(`${label} changed while it was imported`, { file: label });
    const path = join(crest, file.path);
    await writeFileAtomic(path, landing(options, `${DIRECTORY.knowledge}/${file.path}`, bytes));
    if (sha256(await readFile(path)) !== file.sha256) mismatch(`${DIRECTORY.knowledge}/${file.path} does not hash as ${label} did`, { file: `${DIRECTORY.knowledge}/${file.path}` });
  }
}

// After the copy: the old store still holds exactly what was carried, and the library's crest answers
// the three counts the old store answered: every card, the removed ones and the default ones.
async function assertKnowledgeCarried(knowledge: LegacyKnowledge, libraryRoot: string, at: string): Promise<void> {
  const now = await knowledgeFiles(knowledge.storeRoot);
  // Compared file by file: a store's list of files is not held to the canonical ceilings.
  if (now.length !== knowledge.files.length || now.some((file, index) => {
    const carried = knowledge.files[index];
    return carried === undefined || file.path !== carried.path || file.bytes !== carried.bytes || file.sha256 !== carried.sha256;
  })) {
    mismatch("the old knowledge store changed while it was imported", { file: LEGACY_KNOWLEDGE_DIRECTORY });
  }
  const carried = await cardCounts(libraryRoot, at);
  const { cards, removedCards, defaultCards } = knowledge.report;
  if (carried.cards !== cards || carried.removedCards !== removedCards || carried.defaultCards !== defaultCards) {
    mismatch(`the imported crest answers ${carried.cards} cards, ${carried.removedCards} of them removed and ${carried.defaultCards} by default, where the old store answers ${cards}, ${removedCards} and ${defaultCards}`, {
      file: DIRECTORY.knowledge,
    });
  }
}

// ---- what a stopped import left ----

// Every file and every empty directory under `root`, relative to it with `/`, in canonical order;
// empty when `root` is absent. Links are named, never followed.
async function writtenEntries(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const names = (await readdir(directory)).sort(compareCanonicalText);
    if (names.length === 0 && directory !== root) entries.push(`${relative(root, directory).split(sep).join("/")}/`);
    for (const name of names) {
      const path = join(directory, name);
      if ((await lstat(path)).isDirectory()) await walk(path);
      else entries.push(relative(root, path).split(sep).join("/"));
    }
  };
  try {
    await walk(root);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return entries.sort(compareCanonicalText);
}

async function occupied(path: string): Promise<boolean> {
  try {
    return !(await lstat(path)).isDirectory() || (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Import the old-layout workspace at `legacyRoot` into a new library at `target` (which must not
 * exist or be empty), or, with `dryRun`, report what the import would carry without writing.
 */
export async function importLegacyWorkspace(legacyRoot: string, target: string, options: LegacyImportOptions): Promise<LegacyImportReport> {
  // Every check that needs no write, the same in a dry run and a real import.
  assertStrictInstant(options.createdAt);
  if (options.omitLegacyKnowledge !== undefined) {
    const field = legacyKnowledgeOmissionIssue(options.omitLegacyKnowledge);
    if (field !== null) mismatch("omitLegacyKnowledge must contain only a nonempty one-line reason", { field });
  }
  const legacy = await openLegacyWorkspace(legacyRoot);
  const chain = validateLegacyChain(legacy);
  const legacyState = replayLegacyWorkspace(legacy);
  const records = recordsReport(legacyState);
  const knowledge = options.omitLegacyKnowledge === undefined ? await readLegacyKnowledge(legacy.root, options.createdAt) : null;
  const knowledgeOmission = options.omitLegacyKnowledge === undefined ? null : await omittedLegacyKnowledge(legacy.root, options.createdAt, options.omitLegacyKnowledge);
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
    records,
    knowledge: knowledge?.report ?? null,
    knowledgeOmission,
  };
  if (options.dryRun === true) {
    return { reasonCode: "LEGACY_IMPORT_DRY_RUN", dryRun: true, ...report, target: null, deviceId: null, libraryHeadEventHash: null };
  }

  // This device's identity before the target is touched, so a device that cannot be read or made
  // stops the import before it writes.
  const { device } = await readOrCreateDevice();
  const targetPath = resolve(target);
  const occupiedBefore = await occupied(targetPath);
  try {
    const library = await createLibrary(targetPath, {
      createdAt: options.createdAt,
      libraryId: legacy.metadata.workspaceId,
      ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
      ...(options.gitRemote === undefined ? {} : { gitRemote: options.gitRemote }),
    });
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
        await writeFileAtomic(join(directory, segment.name), landing(options, `${DIRECTORY.events}/${device.deviceId}/${segment.name}`, bytes));
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
      if (knowledge !== null) await carryKnowledge(knowledge, library.root, options);
    });

    // The library must replay to what the old chain holds: the events, the stream head and every record.
    const imported = await materializeLibrary(library);
    const stream = imported.library?.streams.find((entry) => entry.deviceId === device.deviceId);
    if (imported.version !== chain.events || stream?.headEventHash !== chain.headEventHash || stream?.sequence !== chain.events) {
      mismatch("the imported library does not replay to the old chain's events and head", { events: String(imported.version) });
    }
    if ((imported.library?.rejectedEvents.length ?? 0) > 0) mismatch("the imported library rejects events of the old chain");
    assertLegacyRecordsMatch(legacyState, imported);
    if (knowledge !== null) await assertKnowledgeCarried(knowledge, library.root, options.createdAt);
    if (knowledgeOmission !== null) {
      await initializeKnowledgeStore(library.root, { disposableAcknowledged: true });
      const empty = await cardCounts(library.root, options.createdAt);
      if (empty.cards !== 0 || empty.removedCards !== 0 || empty.defaultCards !== 0) {
        mismatch("an explicit knowledge omission must create a readable empty crest", { file: DIRECTORY.knowledge });
      }
    }
    // The imported settings and configuration records are the library's project-level
    // configuration (TCRN-CROSS-STORY-469 R2, 478 R1), projected once everything above checked.
    await writeConfigProjection(library.root, {
      versionVector: imported.library?.versionVector ?? {},
      settings: imported.settings,
      configRecords: imported.configRecords,
    });
    return {
      reasonCode: "LEGACY_IMPORTED",
      dryRun: false,
      ...report,
      target: library.root,
      deviceId: device.deviceId,
      libraryHeadEventHash: imported.headEventHash,
    };
  } catch (error) {
    // A target that held something was refused before anything was written; otherwise whatever it
    // holds now, this import wrote.
    if (occupiedBefore) throw error;
    const written = await writtenEntries(targetPath);
    if (written.length === 0) throw error;
    throw new LegacyImportStoppedError(error, targetPath, written);
  }
}
