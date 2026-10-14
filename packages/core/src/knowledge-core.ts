import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
import { scopedWorkspaceState } from "./project-scope.js";
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveStoreBackend, SegmentedKnowledgeStoreBackend } from "./store-backend.js";
import type { FileStoreBackendProfile, StoreBackend } from "./store-backend.js";

import {
  ProtocolError,
  assertCanonicalJson,
  assertProtocolId,
  assertStrictInstant,
  canonicalExternalKey,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  deriveStableId,
  parseStrictInstant,
  PROTOCOL_LIMITS,
  validateKnowledgeRecord,
} from "../../protocol/src/index.js";
import type { JsonValue, KnowledgeRecord, WorkRecord } from "../../protocol/src/index.js";
import {
  applyWriteLanguagePolicy,
  expansionsAreBounded,
  KnowledgeLanguageError,
  readKnowledgeLanguagePolicy,
} from "./knowledge-language.js";
import type { KnowledgeExpansions, KnowledgeLanguageProvider } from "./knowledge-language.js";
import { activeWorkspaceRoot, materializeWorkspace, withWorkspaceWriteLock } from "./workspace.js";
import type { ProjectRecord, WorkspaceState } from "./workspace.js";
import { SETTINGS_CATALOG, resolveKnowledgeArticlesPath } from "./settings.js";
import { hasLibraryManifest, openLibrary } from "./ether-library.js";
import {
  backupsPath,
  cachePath,
  deviceHome,
  ensureDeviceDirectory,
  libraryDirectoryName,
  USER_CREST_EVENTS_DIRECTORY,
  userCrestCachePath,
  userCrestEventsPath,
  userCrestLockPath,
  userCrestPath,
  userCrestSnapshotPath,
  USER_CREST_SNAPSHOT_SCHEMA_VERSION,
} from "./device-home.js";
import { isAtomicTemporaryName, writeFileAtomic } from "./atomic-file.js";
import { assertActorId } from "./actor-attestation.js";
import { readDevice, readOrCreateDevice } from "./device-identity.js";
import { FileLockError, acquireFileLock, withFileLock } from "./file-lock.js";
import type { FileLock } from "./file-lock.js";
import { readUserCrestPath } from "./machine-settings.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY, LEGACY_KNOWLEDGE_DIRECTORY } from "./names.js";
import { assertKnowledgeNotRecorded } from "./knowledge-duplicates.js";
import { readRegistry } from "./registry.js";

export const KNOWLEDGE_CORE_VERSION = "tcrn.knowledge-core.v1" as const;
export const KNOWLEDGE_STORE_SCHEMA_VERSION = "tcrn.knowledge-store.v1" as const;
export const KNOWLEDGE_METADATA_SCHEMA_VERSION = "tcrn.knowledge-unit-metadata.v1" as const;

// The limits of one card and of one read. TCRN-CROSS-SUB-310 R17 (MIN-238 D1, D5; MIN-239 D1): nothing
// bounds the sum of a crest's card bodies, the library's or the user's -- the knowledge.aggregateBytes
// setting and the one-MiB ceiling above it are gone -- so no read, write, recall, recovery or merge of
// two devices' streams refuses for the bytes the bodies add up to. Each card is still held to these,
// and one past its limit is refused with KNOWLEDGE_LIMIT_EXCEEDED.
export const KNOWLEDGE_QUERY_DEFAULT_RESULTS = 8;
// Storage page target: an operational chunk size, never a total-store or per-record refusal.
const KNOWLEDGE_INDEX_PAGE_TARGET_BYTES = 1_048_576;
export const KNOWLEDGE_LIMITS = Object.freeze({
  maximumBodyBytes: RUNTIME_CAPACITY.bufferBytes,
  maximumArticleBytes: PROTOCOL_LIMITS.maxCanonicalBytes,
  maximumSummaryBytes: RUNTIME_CAPACITY.bufferBytes,
  maximumSnippetBytes: RUNTIME_CAPACITY.bufferBytes,
  maximumMetadataBytes: RUNTIME_CAPACITY.bufferBytes,
  maximumQueryResults: RUNTIME_CAPACITY.arrayEntries,
  maximumLocators: RUNTIME_CAPACITY.arrayEntries,
  maximumLinksPerClass: RUNTIME_CAPACITY.arrayEntries,
  maximumTags: RUNTIME_CAPACITY.arrayEntries,
  maximumRoleScopes: RUNTIME_CAPACITY.arrayEntries,
});

// A live record: no later card supersedes it and an older engine did not retire it. Only live cards
// form an unresolved conflict, hold a duplicate unresolved or are named for a project the chain no
// longer holds. TCRN-CROSS-SUB-425 (MIN-239 D3, D4): a superseded card is removed, and so is a card a
// removal event names; a scan's `removals` say which, and no removed card is live. Its records stay
// in their immutable store or event stream, and no read answers their content.
function isLiveRecord(metadata: KnowledgeUnitMetadata): boolean {
  return metadata.lifecycle !== "retired" && metadata.extensions.supersededBy === undefined;
}

export const KNOWLEDGE_REASON_CODES = Object.freeze([
  // TCRN-CROSS-STORY-469: an old-layout workspace's knowledge store is read, never written.
  "LEGACY_WORKSPACE_READ_ONLY",
  "KNOWLEDGE_ALREADY_EXISTS",
  "KNOWLEDGE_ARTICLE_CREATED",
  "KNOWLEDGE_ARTICLE_REFRESHED",
  "KNOWLEDGE_BODY_ACCESS_DENIED",
  "KNOWLEDGE_CANONICAL_INVALID",
  // TCRN-CROSS-SUB-425 (STORY-514 R1, MIN-239 D3, D4): the card a read or a write names is removed.
  // Removed is terminal, so its snippet and body are refused, and so is writing it again.
  "KNOWLEDGE_CARD_REMOVED",
  "KNOWLEDGE_CAS_MISMATCH",
  "KNOWLEDGE_CHECKPOINT_READY",
  "KNOWLEDGE_DISPOSABLE_ACK_REQUIRED",
  "KNOWLEDGE_DUPLICATE",
  "KNOWLEDGE_FAULT_INJECTED",
  "KNOWLEDGE_FRESHNESS_EVALUATED",
  "KNOWLEDGE_HIGH_WATER_MISMATCH",
  "KNOWLEDGE_INPUT_INVALID",
  "KNOWLEDGE_LANGUAGE_INVALID",
  "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE",
  "KNOWLEDGE_LIFECYCLE_INVALID",
  // TCRN-CROSS-SUB-308 (TCRN-CROSS-STORY-476 R1): a write that names the candidate (or the
  // retired) lifecycle. Every card is written active; see buildMetadata.
  "KNOWLEDGE_LIFECYCLE_RETIRED",
  "KNOWLEDGE_LIMIT_EXCEEDED",
  "KNOWLEDGE_LINK_INVALID",
  "KNOWLEDGE_LINK_UNSAFE",
  "KNOWLEDGE_LIST_READY",
  "KNOWLEDGE_LOCKED",
  "KNOWLEDGE_NOT_FOUND",
  "KNOWLEDGE_PARTIAL_STATE",
  "KNOWLEDGE_PATH_INVALID",
  "KNOWLEDGE_POLICY_UPDATED",
  "KNOWLEDGE_POSSIBLE_CONFLICT",
  "KNOWLEDGE_PROMOTION_INVALID",
  "KNOWLEDGE_PROVENANCE_INVALID",
  "KNOWLEDGE_REBASE_BLOCKED",
  "KNOWLEDGE_RECORD_INVALID",
  "KNOWLEDGE_REDACTION_REQUIRED",
  "KNOWLEDGE_RECOVERY_NOT_NEEDED",
  "KNOWLEDGE_RECOVERED",
  "KNOWLEDGE_REVERIFIED",
  "KNOWLEDGE_SELECTION_INVALID",
  // TCRN-CROSS-SUB-425 R18: knowledge-bodies-migrate --clear-removed on a library another device writes.
  // The metadata/body layout belongs to no device, so only the library's sole writer rewrites it.
  "KNOWLEDGE_SOLE_WRITER_REQUIRED",
  "KNOWLEDGE_SOURCE_CHANGED",
  "KNOWLEDGE_SOURCES_ALIGNED",
  "KNOWLEDGE_SOURCE_MISSING",
  "KNOWLEDGE_SOURCE_UNCHECKABLE",
  "KNOWLEDGE_SPECIAL_FILE",
  "KNOWLEDGE_STORE_INITIALIZED",
  "KNOWLEDGE_STORE_REBASED",
  "KNOWLEDGE_STORE_VALID",
  "KNOWLEDGE_UNIT_CREATED",
  // TCRN-CROSS-SUB-425: knowledge-remove recorded a removal event.
  "KNOWLEDGE_UNIT_REMOVED",
] as const);

export type KnowledgeReasonCode = typeof KNOWLEDGE_REASON_CODES[number];
// TCRN-CROSS-STORY-476 R5: "user" writes the card to this user's crest, the one store every
// project recalls from; the other three write it to the library's crest. The one scope value
// says both where a card applies and where it is stored, rather than a second field saying where.
export type KnowledgeScope = "workspace" | "project" | "role" | "user";
/** TCRN-CROSS-STORY-476 R5: which store a card lives in -- the library's crest or this user's. */
export type KnowledgeStoreScope = "project" | "user";
export const KNOWLEDGE_STORE_SCOPES: readonly KnowledgeStoreScope[] = Object.freeze(["project", "user"]);

// TCRN-CROSS-SUB-425 (TCRN-CROSS-STORY-514 R1, R4; MIN-239 D3, D4, D6): a card is valid or removed,
// and removed is terminal: nothing restores it, and a mistaken removal is answered by a new card. A
// card is removed for one of three reasons -- another card superseded it in a conflict, it was judged
// invalid, or it repeats what a work item or a decision holds -- and every removal names its basis,
// its actor and its instant. A removal is an event in the remover's own stream of the crest, so it
// travels with the crest to every device, and no event file is deleted; what a removed card keeps is
// its id, external key, subject, the removal and the supersession it took part in. Its body is
// cleared: each device deletes the body files its own stream holds for removed cards the next time it
// writes to that crest (clearRemovedBodies), and no read returns a removed card's summary, snippet or
// body. Reads answer valid cards unless asked for another status (KnowledgeStatusFilter).
export type KnowledgeRemovalReason = "superseded" | "invalid" | "duplicate";
export const KNOWLEDGE_REMOVAL_REASONS: readonly KnowledgeRemovalReason[] = Object.freeze(["superseded", "invalid", "duplicate"]);
/** Which cards a read answers: the valid ones (the default), the removed ones, or both. */
export type KnowledgeStatusFilter = "valid" | "removed" | "all";
export const KNOWLEDGE_STATUS_FILTERS: readonly KnowledgeStatusFilter[] = Object.freeze(["valid", "removed", "all"]);
// The removal event, one schema for a library's crest and the user crest: it names no chain and no
// body, only the card it removes and why.
const CREST_REMOVAL_SCHEMA_VERSION = "einzbern.crest-removal.v1" as const;
// A removal's basis is a bounded sentence, held to the summary's budget.
const KNOWLEDGE_REMOVAL_BASIS_BYTES = RUNTIME_CAPACITY.bufferBytes;

/**
 * TCRN-CROSS-STORY-476 R5: the identity a user crest's marker binds where a library's crest binds
 * its library id. It is one value for every user crest: the crest belongs to a person, not to a
 * device or a library, and may be shared through a cloud folder by all of that person's devices.
 * The user crest has no chain, so the high-water digest it binds is this identity's own digest.
 */
export const USER_CREST_ID = deriveStableId("user-crest", "USER-CREST");
const USER_CREST_HIGH_WATER = createHash("sha256").update(USER_CREST_ID, "utf8").digest("hex");
const USER_CREST_EVENT_SCHEMA_VERSION = "tcrn.user-crest-event.v1" as const;
const USER_CREST_EVENT_HEAD_SCHEMA_VERSION = "tcrn.user-crest-head.v1" as const;
// The names every crest event stream uses, a library's and the user crest's alike: the event
// `<sequence>-<event hash>.json` and its body `<sequence>-<body sha256>.body`.
const CREST_EVENT_FILE_PATTERN = /^(\d{8,})-([a-f0-9]{64})\.json$/u;
const CREST_BODY_FILE_PATTERN = /^(\d{8,})-([a-f0-9]{64})\.body$/u;
// TCRN-CROSS-SUB-414 (STORY-476 D7, MIN-235 D7): a library crest's card writes are events in the
// writing device's own stream, crest/events/<device id>/, the directory name the user crest uses.
const CREST_EVENT_SCHEMA_VERSION = "einzbern.crest-event.v1" as const;
const CREST_EVENTS_DIRECTORY = USER_CREST_EVENTS_DIRECTORY;
// The most chain streams one event may name as the chain it was written against, and so the
// largest event file a reader admits: the metadata budget, the event's own fields, and the chain.
const CREST_EVENT_CHAIN_LIMIT = RUNTIME_CAPACITY.arrayEntries;
const CREST_EVENT_MAXIMUM_BYTES = RUNTIME_CAPACITY.bufferBytes;
export type KnowledgeCategory = "architecture" | "domain" | "implementation" | "standards" | "testing" | "workflow" | "decision" | "evidence";
export type KnowledgeKind = "fact" | "guide" | "decision" | "reference" | "summary";
export type KnowledgeLifecycle = "candidate" | "active" | "retired";
export type KnowledgeRetrievalDisposition = "default" | "explicit-only" | "excluded";
export type KnowledgePromotionState = "candidate" | "promoted" | "rejected";
export type KnowledgeFreshnessState = "fresh" | "stale" | "unknown";
export type KnowledgeExportDisposition = "metadata-only" | "excluded";
export type KnowledgeFaultPoint = "after-body-write" | "after-metadata-write" | "after-marker-write";

// The retirement record a 1.2.0 fitness sweep wrote into a card's metadata. It is a read-only
// historical format: readers and the schema admit it, and nothing writes it (TCRN-CROSS-SUB-258;
// the sweep, the manual retire and the fitness statistic are gone, TCRN-CROSS-SUB-308).
export interface KnowledgeRetirementRecord {
  readonly schemaVersion: "tcrn.knowledge-retirement.v1";
  readonly id: string;
  readonly reason: "zero-retrieval-zero-reference";
  readonly retrievalCount: number;
  readonly referenceCount: number;
  readonly observedEvents: number;
  readonly windowDays: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly sweptAt: string;
}

export class KnowledgeCoreError extends Error {
  readonly reasonCode: KnowledgeReasonCode;
  // TCRN-CROSS-STORY-365: a refusal that names a set of records has to hand that set
  // over as data, not only inside the message. KNOWLEDGE_POSSIBLE_CONFLICT is the first
  // such refusal; the field stays optional so every other throw site is unchanged.
  readonly details?: Readonly<Record<string, JsonValue>>;

  constructor(reasonCode: KnowledgeReasonCode, message: string, details?: Readonly<Record<string, JsonValue>>) {
    super(message);
    this.name = "KnowledgeCoreError";
    this.reasonCode = reasonCode;
    if (details !== undefined) this.details = details;
  }
}

export interface KnowledgeStalenessPolicy {
  readonly maximumAgeDays: number | null;
  readonly unknownDisposition: "fail-closed" | "fail-open";
}

// TCRN-CROSS-STORY-365: the metadata extension slot, which was declared open and
// validated shut (Record<string, never>). Two bounded keys now live in it, both written
// by the create path and by nothing else: `coexistsWith` records which existing cards a
// --coexist write scored as possible conflicts, and `supersededBy` marks the card a
// --supersedes write replaced. Both are knowledge ids, so the slot stays a closed roster
// of two keys rather than an open bag.
export interface KnowledgeUnitExtensions {
  readonly coexistsWith?: readonly string[];
  readonly supersededBy?: string;
}

export interface KnowledgeUnitMetadata {
  readonly schemaVersion: typeof KNOWLEDGE_METADATA_SCHEMA_VERSION;
  readonly id: string;
  readonly externalKey: string;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly roleScopes: readonly string[];
  readonly category: KnowledgeCategory;
  readonly kind: KnowledgeKind;
  readonly tags: readonly string[];
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  readonly accountableOwnerId: string;
  readonly sourceReferences: readonly string[];
  readonly sourceDigest: string;
  readonly supersedes: string | null;
  readonly linkedWorkIds: readonly string[];
  readonly linkedDecisionIds: readonly string[];
  readonly linkedGateIds: readonly string[];
  readonly linkedEvidenceIds: readonly string[];
  readonly lifecycle: KnowledgeLifecycle;
  readonly retrievalDisposition: KnowledgeRetrievalDisposition;
  // Historical records may carry this field. New records use lifecycle and
  // retrievalDisposition directly and omit the retired promotion marker.
  readonly promotionState?: KnowledgePromotionState;
  readonly freshnessState: KnowledgeFreshnessState;
  readonly lastVerified: string | null;
  readonly stalenessPolicy: KnowledgeStalenessPolicy;
  readonly redactionDisposition: "focused-reference-redaction-v1";
  readonly exportDisposition: KnowledgeExportDisposition;
  readonly authority: "workspace-knowledge-metadata";
  readonly sourceProvenance: "explicit-current-source-reference";
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly extensions: KnowledgeUnitExtensions;
  readonly retirement?: KnowledgeRetirementRecord;
  // TCRN-CROSS-STORY-364: the question phrasings this card is retrievable by, keyed by
  // prompt language. Empty on a workspace that has recorded no artefact language, and on
  // every card written before this field existed.
  readonly expansions: KnowledgeExpansions;
}

export interface CreateKnowledgeUnitInput {
  readonly occurredAt: string;
  readonly externalKey: string;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly roleScopes: readonly string[];
  readonly category: KnowledgeCategory;
  readonly kind: KnowledgeKind;
  readonly tags: readonly string[];
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  readonly accountableOwnerId: string;
  readonly sourceReferences: readonly string[];
  readonly sourceDigest: string | null;
  readonly supersedes?: string | null;
  readonly linkedWorkIds: readonly string[];
  readonly linkedDecisionIds: readonly string[];
  readonly linkedGateIds: readonly string[];
  readonly linkedEvidenceIds: readonly string[];
  // TCRN-CROSS-SUB-308: every card is written active, so this may be left out. A caller that
  // still names "candidate" or "retired" is refused with KNOWLEDGE_LIFECYCLE_RETIRED.
  readonly lifecycle?: KnowledgeLifecycle;
  readonly retrievalDisposition: KnowledgeRetrievalDisposition;
  readonly freshnessState: KnowledgeFreshnessState;
  readonly lastVerified: string | null;
  readonly stalenessPolicy: KnowledgeStalenessPolicy;
  readonly exportDisposition: KnowledgeExportDisposition;
  readonly body: string;
  // TCRN-CROSS-STORY-365: the writer's answer to a possible conflict. `supersedes` is the
  // other answer; with neither, a scored conflict refuses the write.
  readonly coexist?: boolean;
}

export interface KnowledgeArticleCreateInput {
  readonly occurredAt: string;
  readonly projectId?: string;
  /** Markdown file path relative to the effective articles directory. */
  readonly path: string;
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly accountableOwnerId: string;
  readonly linkedEvidenceIds: readonly string[];
}

export interface KnowledgeArticleRefreshInput {
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly id: string;
  /** Markdown file path relative to the effective articles directory. */
  readonly path: string;
  readonly summary: string;
}

export interface KnowledgeReadOptions {
  readonly beforeDescriptorReadForTest?: (path: string) => Promise<void>;
  readonly afterDescriptorOpenForTest?: (path: string) => Promise<void>;
  // TCRN-CROSS-INC-226: admit a metadata-first read against a store whose marker
  // trails the chain head, and label the answer rather than refusing it. Off by
  // default, so every existing caller keeps the exact refusal it has today.
  readonly allowTrailing?: boolean;
}

// TCRN-CROSS-STORY-476 R5: a read that can be pointed at this user's crest instead of the
// library's. Left out, it reads the library's crest, so every existing caller reads what it read.
export interface KnowledgeScopedReadOptions extends KnowledgeReadOptions {
  readonly scope?: KnowledgeStoreScope;
}

export interface KnowledgeMutationOptions extends KnowledgeReadOptions {
  readonly faultAt?: KnowledgeFaultPoint;
  // TCRN-CROSS-STORY-364: the answers the recorded economy-tier model produced for this
  // write. The engine never calls a model; the write-path hook that does supplies them
  // here, and a workspace that has recorded an artefact language refuses the write when
  // they are absent.
  readonly languageProvider?: KnowledgeLanguageProvider;
  readonly host?: string;
}

export interface KnowledgeListQuery extends KnowledgeScopedReadOptions {
  readonly selection?: "default" | "all";
  // TCRN-CROSS-SUB-425 (MIN-239 D6): which cards the list answers. Left out, the valid ones; the
  // removed ones only when the caller asks for them, in the form a removed card keeps.
  readonly status?: KnowledgeStatusFilter;
  readonly at: string;
  readonly projectId?: string;
  readonly roleScope?: string;
  readonly category?: KnowledgeCategory;
  readonly kind?: KnowledgeKind;
  readonly tag?: string;
  readonly freshness?: KnowledgeFreshnessState;
  readonly promotionState?: KnowledgePromotionState;
  // WSC-4: a bounded case-insensitive substring over subject and tags, and a
  // budgeted window over the ordered result set.
  readonly search?: string;
  /** Allow explicit-only index cards on a deliberate recall corpus read. */
  readonly includeExplicitOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface KnowledgeBodyReadOptions extends KnowledgeScopedReadOptions {
  readonly at: string;
  readonly allowUnpromoted?: boolean;
  readonly allowStale?: boolean;
}

/** TCRN-CROSS-SUB-425: one removal, as knowledge-remove records it. */
export interface KnowledgeRemoveInput {
  readonly occurredAt: string;
  readonly id: string;
  readonly reason: KnowledgeRemovalReason;
  // Why, in a sentence the next reader can check: what the card got wrong, or which work item or
  // decision already holds it.
  readonly basis: string;
  // Who removed it: an owner:, profile: or agent: id.
  readonly actor: string;
  // The card that supersedes it; named for the reason "superseded" and for no other.
  readonly supersededBy?: string | null;
}

/** Where a removal is recorded: the library's crest (the default) or this user's crest. */
export interface KnowledgeRemoveOptions extends KnowledgeMutationOptions {
  readonly scope?: KnowledgeStoreScope;
}

// In a library (TCRN-CROSS-STORY-469) the marker binds the store to the library id (workspaceId).
// TCRN-CROSS-SUB-414: it is written once, by initialization, and binds the library identity's
// own digest as its high water; a read answers the marker projected over the event streams, its
// high water the chain head it read (scanLibraryCrest). A crest an engine before events wrote
// keeps the library head its last write bound, and that value is read, never compared or
// rewritten. An old-layout store binds its workspace id and its one chain's head.
interface KnowledgeStoreMarker {
  readonly schemaVersion: typeof KNOWLEDGE_STORE_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly eventHighWaterDigest: string;
  readonly version: number;
  readonly disposable: true;
  readonly authority: "metadata-index-authority-body-separate";
  readonly lastSweepAt?: string;
}

interface UserCrestEvent {
  readonly schemaVersion: typeof USER_CREST_EVENT_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly priorHash: string | null;
  readonly metadata: KnowledgeUnitMetadata;
  readonly body: { readonly file: string; readonly sha256: string; readonly bytes: number };
  readonly eventHash: string;
}

// TCRN-CROSS-SUB-414: one chain stream as a library crest event saw it when it was written: the
// device, the sequence of the stream's head and that head event's hash.
interface ChainPosition {
  readonly deviceId: string;
  readonly sequence: number;
  readonly eventHash: string;
}

// TCRN-CROSS-SUB-414 (STORY-476 D7, MIN-235 D7): one record of a library crest, appended to the
// writing device's stream. `chain` is every chain stream's head the write read, so a reader knows
// whether its own chain holds what the card was written against; `replaces` is the digest of the
// stored record of the same card this record replaces (a re-verification, a policy update, an
// article refresh), null for the record that writes a card for the first time. The body is the
// record's own copy, null only for a record that is retired (an older engine reclaimed its body).
interface LibraryCrestEvent {
  readonly schemaVersion: typeof CREST_EVENT_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly priorHash: string | null;
  readonly chain: readonly ChainPosition[];
  readonly replaces: string | null;
  readonly metadata: KnowledgeUnitMetadata;
  readonly body: { readonly file: string; readonly sha256: string; readonly bytes: number } | null;
  readonly eventHash: string;
}

// The head of one device's crest event stream.
interface CrestEventHead {
  readonly deviceId: string;
  readonly sequence: number;
  readonly eventHash: string;
}

// TCRN-CROSS-SUB-414: a library crest record whose event was written against chain events this
// device has not received yet: the card it belongs to and the event that holds the record.
interface AwaitingChainEntry {
  readonly id: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly eventHash: string;
}

// TCRN-CROSS-SUB-414 (R16, C-R16-1): a live library crest record whose project the chain it was read
// against no longer holds -- the project was deleted after the card was written, or by another device
// before either device received the other's write: the card, the device and event that hold the
// record (all three null for a record of the metadata/body layout, as a duplicate's version names
// one), and the project id that no longer resolves.
interface UnresolvedScopeEntry {
  readonly id: string;
  readonly deviceId: string | null;
  readonly sequence: number | null;
  readonly eventHash: string | null;
  readonly projectId: string;
}

// TCRN-CROSS-SUB-425 (MIN-239 D4): one removal as its event holds it, in the stream of the device that
// recorded it, after that device's other events. The same schema serves a library's crest and the
// user crest; it carries no chain position, since it links nothing the chain holds.
interface CrestRemovalEvent {
  readonly schemaVersion: typeof CREST_REMOVAL_SCHEMA_VERSION;
  readonly deviceId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly priorHash: string | null;
  readonly removal: {
    readonly id: string;
    readonly reason: KnowledgeRemovalReason;
    readonly basis: string;
    readonly actor: string;
    readonly supersededBy: string | null;
  };
  readonly eventHash: string;
}

// TCRN-CROSS-SUB-425: the removal a read projects for one card. A removal event gives it, or a card
// that supersedes this one (knowledge-create --supersedes, and the supersessions every engine before
// recorded): that removal has no event of its own, so its device, sequence and event hash are null,
// its basis names the card that superseded it, and its actor is that card's accountable owner, null
// only when the mark an older engine stored names a card the crest does not hold.
interface CrestRemoval {
  readonly id: string;
  readonly reason: KnowledgeRemovalReason;
  readonly basis: string;
  readonly actor: string | null;
  readonly removedAt: string;
  readonly supersededBy: string | null;
  readonly deviceId: string | null;
  readonly sequence: number | null;
  readonly eventHash: string | null;
}

// TCRN-CROSS-SUB-425: the body file one stream event names, and whether the stream still holds it. A
// scan admits a missing body only for a removed card (admitCrestBodies).
interface StreamBodyReference {
  readonly path: string;
  readonly file: string;
  readonly bytes: number;
  readonly present: boolean;
}

// A body file some device's stream holds for a card: what a writer on that device clears once the
// card is removed (clearRemovedBodies).
interface CrestStreamBody {
  readonly id: string;
  readonly deviceId: string;
  readonly path: string;
  readonly present: boolean;
}

// What a removed card keeps (knowledge-core-v1.md, "Valid and removed"): its id, external key and
// subject, the supersession it named, and the removal. Its summary, snippet, links and body are gone.
interface RemovedCardRecord {
  readonly id: string;
  readonly externalKey: string;
  readonly subject: string;
  readonly status: "removed";
  readonly removal: Readonly<Record<string, JsonValue>>;
  readonly supersedes?: string;
}

// One record of a crest's index and of a list page: a valid card's metadata, or a removed card.
type KnowledgeIndexRecord = KnowledgeUnitMetadata | RemovedCardRecord;

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface ExclusiveFile {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface KnowledgeMutationClaim extends ExclusiveFile {
  readonly workspaceId: string;
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

interface ScannedKnowledgeUnit {
  readonly metadataPath: string;
  readonly bodyPath: string;
  readonly metadata: KnowledgeUnitMetadata;
  readonly body: Buffer | null;
  readonly readBody?: () => Promise<Buffer>;
}

// TCRN-CROSS-SUB-310: the one writer a crest record came from -- a device's event stream, named by
// its device id, or the metadata/body layout an engine before events wrote under the store's
// mutation claim. One writer scans before it writes, so it saw every earlier card of its own.
const USER_CREST_LEGACY_LINEAGE = "legacy" as const;

// One record of a crest, as a scan read it: the card's metadata and where it came from.
interface CrestUnit extends ScannedKnowledgeUnit {
  readonly lineage: string;
  // TCRN-CROSS-SUB-413: the event that holds the record in its device's stream; null for a record
  // the metadata/body layout holds.
  readonly event: { readonly sequence: number; readonly eventHash: string } | null;
  // TCRN-CROSS-SUB-414: the stored record of the same card this record replaces (its recordDigest);
  // null for the record that writes a card for the first time, and for every user-crest record.
  readonly replaces: string | null;
  // TCRN-CROSS-SUB-414: the chain streams a library crest event was written against; null for a
  // record with no event, and for every user-crest record.
  readonly chain: readonly ChainPosition[] | null;
  // The recordDigest of the metadata as stored, which a scan's projection never changes.
  readonly storedDigest: string;
  // TCRN-CROSS-SUB-425: the body file a stream event names; null for a record the metadata/body
  // layout holds and for a stream record written without a body.
  readonly streamBody: StreamBodyReference | null;
}

// TCRN-CROSS-SUB-413 (STORY-476 D7): one knowledge id -- one external key, since the id is derived
// from the key -- that more than one writer wrote with differing metadata, each before it saw the
// other's. None of its versions is the card: every one stays in its writer's stream and is read
// explicitly, none is selected by default or recalled while the id is unresolved, and a card whose
// supersedes names the id replaces every version at once (projectCrestUnits). TCRN-CROSS-SUB-425: that
// card, or a removal of the id, removes the id with every version, and no read answers them then.
interface CrestDuplicate {
  readonly id: string;
  readonly externalKey: string;
  // One version per writer, in canonical order of the writer (its device id, or `legacy`).
  readonly versions: readonly CrestUnit[];
}

// TCRN-CROSS-STORY-476 R5: what a write reads from a scan of either store, a library's crest
// (KnowledgeStoreScan) or the user crest (UserCrestScan). TCRN-CROSS-SUB-414: both are merged from
// every writer's records, so both answer what a merge can hold besides its cards.
interface CrestScan {
  readonly storeRoot: string;
  readonly marker: KnowledgeStoreMarker;
  // The cards: one record per id, projected (a card another card replaced carries supersededBy).
  readonly units: readonly CrestUnit[];
  readonly index: KnowledgeIndex;
  // TCRN-CROSS-SUB-310 (MIN-235 D7): pairs of live cards from two writers that each wrote without
  // seeing the other, which the write-time conflict check would have refused. Each pair is in
  // canonical id order and so is the list. Both cards stay readable; default selection leaves
  // them out until a write resolves the pair (projectCrestUnits).
  readonly unresolvedConflicts: readonly (readonly string[])[];
  // TCRN-CROSS-SUB-413 (STORY-476 D7): every id more than one writer wrote with differing metadata,
  // in canonical id order, resolved or not. Their versions are not in `units`.
  readonly duplicates: readonly CrestDuplicate[];
  // TCRN-CROSS-SUB-414: the library crest records written against chain events this device has
  // not received, in canonical id order; their cards leave default selection until the chain
  // arrives. Always empty for the user crest and an old-layout store.
  readonly awaitingChain: readonly AwaitingChainEntry[];
  // TCRN-CROSS-SUB-414 (R16): the library crest's live records whose project the chain this read
  // replayed no longer holds, in canonical id order, then writer, then sequence; their cards leave
  // default selection until a card supersedes them. Always empty for the user crest and an
  // old-layout store.
  readonly unresolvedScopes: readonly UnresolvedScopeEntry[];
  // The head of every device's crest event stream, in canonical device order.
  readonly eventHeads: readonly CrestEventHead[];
  // TCRN-CROSS-SUB-425 (MIN-239 D3, D4): the removed cards, by id, each with the removal a read
  // projects for it (projectRemovals). Their records stay in `units` and `duplicates`, for the writes
  // that must still see them (an id and external key no card may reuse), and nothing that answers a
  // card's content reads them.
  readonly removals: ReadonlyMap<string, CrestRemoval>;
  // Every body file the crest's device streams name, with its card: what a device clears from its own
  // stream once the card is removed. Empty for an old-layout store.
  readonly streamBodies: readonly CrestStreamBody[];
}

// The user crest, read: no library, no chain head and no links to check a card against beyond
// the card itself. `device` is the device directory whose cache holds its index view.
interface UserCrestScan extends CrestScan {
  readonly device: string;
  readonly eventOnly: boolean;
}

interface KnowledgeStoreScan extends CrestScan {
  // TCRN-CROSS-SUB-414: a library's crest, merged from its device streams and any metadata/body
  // layout, or an old-layout workspace's store, read as its engine left it.
  readonly layout: "library" | "old-layout";
  readonly workspaceRoot: string;
  // The metadata/body layout's directories; null for a library crest that holds only event streams.
  readonly metadataRoot: string | null;
  readonly bodiesRoot: string | null;
  // The old layout's views/ directory; null for a library, whose index view is this device's cache.
  readonly viewsRoot: string | null;
  readonly workspace: WorkspaceState;
  // WSC-2: in rebase mode, the id-sorted set of live (non-retired) records whose
  // scope/project no longer resolves against the advanced workspace head. Empty
  // otherwise; dangling work references have their own non-blocking diagnostic.
  // TCRN-CROSS-SUB-414 (R16): in a library's crest a record some card superseded is not live, and
  // one whose project alone no longer resolves is also named in `unresolvedScopes`.
  readonly linkInvalid: readonly string[];
  // Live records may retain links to work items removed from the current chain.
  // They remain readable and writable, while validation reports these links.
  readonly danglingWorkLinks: readonly { readonly knowledgeId: string; readonly workIds: readonly string[] }[];
}

const markerFields = ["schemaVersion", "workspaceId", "eventHighWaterDigest", "version", "disposable", "authority"];
const metadataFields = [
  "schemaVersion", "id", "externalKey", "scope", "projectId", "roleScopes", "category", "kind", "tags", "subject",
  "summary", "snippet", "accountableOwnerId", "sourceReferences", "sourceDigest", "supersedes", "linkedWorkIds", "linkedDecisionIds", "linkedGateIds",
  "linkedEvidenceIds", "lifecycle", "retrievalDisposition", "freshnessState", "lastVerified",
  "stalenessPolicy", "redactionDisposition", "exportDisposition", "authority", "sourceProvenance", "bodySha256",
  "bodyBytes", "revision", "updatedAt", "extensions", "expansions",
];
const stalenessFields = ["maximumAgeDays", "unknownDisposition"];
const extensionFields = ["coexistsWith", "supersededBy"];
const retirementFields = ["schemaVersion", "id", "reason", "retrievalCount", "referenceCount", "observedEvents", "windowDays", "windowStart", "windowEnd", "sweptAt"];
const knowledgeIdPattern = /^knowledge:[a-f0-9]{24}$/u;

// TCRN-CROSS-STORY-365: extensions were validated as exactly empty. They are now a closed
// roster of two keys whose values are knowledge ids, so the slot admits what the create
// path writes and nothing else. An existing record carrying `{}` passes unchanged, which
// is why no stored store needs rewriting for this.
function extensionsAreBounded(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Readonly<Record<string, unknown>>).every(([key, item]) => {
    if (!extensionFields.includes(key)) return false;
    if (key === "supersededBy") return typeof item === "string" && knowledgeIdPattern.test(item);
    if (!Array.isArray(item) || item.length === 0 || item.length > KNOWLEDGE_LIMITS.maximumQueryResults) return false;
    return item.every((entry, index) => typeof entry === "string" && knowledgeIdPattern.test(entry) &&
      (index === 0 || compareCanonicalText(String(item[index - 1]), entry) < 0));
  });
}

// STORY-327/348: provenance is data, not code. The policy file is loaded from
// the repository's own policy directory so adding a kind changes behavior without
// editing this algorithm; the module-relative URLs cover both source execution and the
// compiled CLI. There is no lookup by a sibling checkout folder name.
function readKnowledgeProvenancePolicy(): Readonly<{ readonly relaxedKinds: readonly string[]; readonly strictKinds: readonly string[] }> {
  const candidates = [
    resolve(process.cwd(), "scripts/policy/knowledge-provenance.json"),
    new URL("../../../scripts/policy/knowledge-provenance.json", import.meta.url),
    new URL("../../../../../scripts/policy/knowledge-provenance.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { readonly schemaVersion?: unknown; readonly relaxedKinds?: unknown; readonly strictKinds?: unknown };
      if (parsed.schemaVersion === "tcrn.knowledge-provenance-policy.v1" && Array.isArray(parsed.relaxedKinds) && Array.isArray(parsed.strictKinds) &&
        parsed.relaxedKinds.every((kind) => typeof kind === "string") && parsed.strictKinds.every((kind) => typeof kind === "string")) {
        return Object.freeze({ relaxedKinds: Object.freeze([...parsed.relaxedKinds] as string[]), strictKinds: Object.freeze([...parsed.strictKinds] as string[]) });
      }
    } catch {
      // Try the next repository-relative candidate; an absent policy is a hard
      // source error below, never an implicit fallback to a stale code roster.
    }
  }
  throw new Error("KNOWLEDGE_PROVENANCE_POLICY_UNREADABLE");
}

export const KNOWLEDGE_PROVENANCE_POLICY = readKnowledgeProvenancePolicy();

function isRelaxedProvenanceKind(kind: KnowledgeKind): boolean {
  return (KNOWLEDGE_PROVENANCE_POLICY.relaxedKinds as readonly string[]).includes(kind);
}

function fail(reasonCode: KnowledgeReasonCode, message: string, details?: Readonly<Record<string, JsonValue>>): never {
  throw new KnowledgeCoreError(reasonCode, message, details);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceReferenceIsFile(reference: string): boolean {
  return !reference.includes("://") && !/^[a-z][a-z0-9+.-]*:/iu.test(reference);
}

async function sourceRoots(workspaceRoot: string, workspace: WorkspaceState): Promise<readonly string[]> {
  const roots = workspace.metadata.roots.map((root) => root.canonicalPath);
  const projectId = (workspace as WorkspaceState & { readonly configurationProjectId?: string | null }).configurationProjectId ?? undefined;
  const registered = (await readRegistry()).entries.filter((entry) => entry.libraryId === workspace.metadata.workspaceId && entry.projectId === projectId);
  const articlesRoot = resolveKnowledgeArticlesPath(workspaceRoot, articleSettingValue(workspace));
  return [...new Set([articlesRoot, ...registered.map((entry) => entry.projectPath), workspaceRoot, ...roots])];
}

async function resolveSourceFile(reference: string, workspaceRoot: string, workspace: WorkspaceState): Promise<string | null> {
  if (!sourceReferenceIsFile(reference)) return null;
  if (reference.startsWith("/") || reference.includes("\\")) return null;
  for (const root of await sourceRoots(workspaceRoot, workspace)) {
    const candidate = resolve(root, reference);
    if (!inside(root, candidate)) continue;
    try {
      const before = await lstat(candidate);
      if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) continue;
      const canonical = await realpath(candidate);
      if (!inside(root, canonical)) continue;
      const after = await lstat(canonical);
      if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !sameIdentity(before, after)) continue;
      return canonical;
    } catch {
      // Try the next declared source root. A missing source is reported by the
      // explicit check command rather than making a metadata-only read fail.
    }
  }
  return null;
}

async function hashSourceFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1) fail("KNOWLEDGE_SPECIAL_FILE", path);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const final = await handle.stat();
    if (!sameIdentity(initial, final) || initial.size !== final.size) fail("KNOWLEDGE_SOURCE_CHANGED", path);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function sourceDigestParts(
  workspaceRoot: string,
  workspace: WorkspaceState,
  references: readonly string[],
): Promise<readonly { readonly reference: string; readonly path: string | null; readonly digest: string | null }[]> {
  const parts = [];
  for (const reference of references) {
    const path = await resolveSourceFile(reference, workspaceRoot, workspace);
    parts.push({ reference, path, digest: path === null ? null : await hashSourceFile(path) });
  }
  return parts;
}

// STORY-328: one source uses its raw SHA-256 so the stored digest is directly
// comparable with the file; multiple sources use a canonical digest of their
// ordered reference/digest pairs. Cards without file-backed references still get
// a deterministic self-computed digest, but the explicit check reports them as
// uncheckable rather than pretending a URI is a file.
export async function calculateKnowledgeSourceDigest(
  workspaceRoot: string,
  workspace: WorkspaceState,
  references: readonly string[],
  fallbackBody: string,
): Promise<string> {
  const parts = await sourceDigestParts(workspaceRoot, workspace, references);
  const fileParts = parts.filter((part) => part.digest !== null);
  if (fileParts.length === 1 && parts.length === 1) return fileParts[0]!.digest!;
  if (fileParts.length > 0) return sha256(canonicalJson(parts.map((part) => ({ reference: part.reference, digest: part.digest }))));
  return sha256(fallbackBody);
}

const ARTICLE_CATEGORY_VALUES: readonly KnowledgeCategory[] = [
  "architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence",
];

function articleSettingValue(workspace: WorkspaceState): string {
  const configured = workspace.settings.find((entry) => entry.key === "knowledge.articlesPath")?.value;
  if (configured !== undefined) return configured;
  const defaultValue = SETTINGS_CATALOG.find((entry) => entry.key === "knowledge.articlesPath")?.defaultValue;
  if (typeof defaultValue !== "string" || defaultValue.length === 0) fail("KNOWLEDGE_PATH_INVALID", "knowledge.articlesPath has no default");
  return defaultValue;
}

function assertArticlePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 ||
    isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) {
    fail("KNOWLEDGE_PATH_INVALID", "article path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") || !path.endsWith(".md")) {
    fail("KNOWLEDGE_PATH_INVALID", "article path");
  }
}

function assertArticleField(value: string, maximumBytes: number, label: string): void {
  assertBoundedString(value, maximumBytes, label);
  if (/[\r\n\u0000-\u001f\u007f]/u.test(value)) fail("KNOWLEDGE_INPUT_INVALID", label);
}

async function articleDirectory(workspaceRoot: string, workspace: WorkspaceState): Promise<string> {
  const configured = articleSettingValue(workspace);
  const root = resolveKnowledgeArticlesPath(workspaceRoot, configured);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail("KNOWLEDGE_PATH_INVALID", `${root}:${String(error)}`);
  }
  return boundDirectory(root);
}

async function articlePathFor(workspaceRoot: string, workspace: WorkspaceState, articlePath: string): Promise<{ readonly root: string; readonly file: string }> {
  assertArticlePath(articlePath);
  const root = await articleDirectory(workspaceRoot, workspace);
  const file = resolve(root, articlePath);
  if (!inside(root, file)) fail("KNOWLEDGE_PATH_INVALID", articlePath);
  try {
    await boundDirectory(dirname(file), root);
  } catch (error) {
    let missing = false;
    try {
      await lstat(dirname(file));
    } catch (filesystemError) {
      missing = (filesystemError as { readonly code?: string }).code === "ENOENT";
    }
    if (!missing) throw error;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await boundDirectory(dirname(file), root);
    } catch (filesystemError) {
      if (filesystemError instanceof KnowledgeCoreError) throw filesystemError;
      fail("KNOWLEDGE_PATH_INVALID", `${dirname(file)}:${String(filesystemError)}`);
    }
  }
  return { root, file };
}

async function readArticleBytes(path: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat();
    if (!initial.isFile() || initial.nlink !== 1) fail("KNOWLEDGE_SPECIAL_FILE", path);
    if (initial.size > KNOWLEDGE_LIMITS.maximumArticleBytes) fail("KNOWLEDGE_LIMIT_EXCEEDED", "article file");
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (!sameIdentity(initial, final) || initial.size !== final.size) fail("KNOWLEDGE_SOURCE_CHANGED", path);
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) fail("KNOWLEDGE_CANONICAL_INVALID", "article file is not canonical UTF-8");
    return bytes;
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    const code = (error as { readonly code?: string }).code;
    if (code === "ENOENT") fail("KNOWLEDGE_SOURCE_MISSING", path);
    if (code === "ELOOP" || code === "ENOTDIR") fail("KNOWLEDGE_LINK_UNSAFE", path);
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  } finally {
    await handle?.close();
  }
  return Buffer.alloc(0);
}

async function writeArticleBytes(path: string, bytes: Buffer, replace: boolean): Promise<Buffer> {
  if (bytes.length > KNOWLEDGE_LIMITS.maximumArticleBytes) fail("KNOWLEDGE_LIMIT_EXCEEDED", "article file");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (replace ? constants.O_TRUNC : constants.O_EXCL);
    handle = await open(path, flags, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length) fail("KNOWLEDGE_SOURCE_CHANGED", path);
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    const code = (error as { readonly code?: string }).code;
    if (!replace && code === "EEXIST") fail("KNOWLEDGE_ALREADY_EXISTS", path);
    if (code === "ELOOP" || code === "ENOTDIR") fail("KNOWLEDGE_LINK_UNSAFE", path);
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  } finally {
    await handle?.close();
  }
  return readArticleBytes(path);
}

function articleMarkdown(category: KnowledgeCategory, title: string, content: string): Buffer {
  return Buffer.from(`---\ncategory: ${category}\ntitle: ${title}\n---\n\n${content}`, "utf8");
}

function parseArticleMarkdown(bytes: Buffer, path: string): { readonly category: KnowledgeCategory; readonly title: string; readonly content: string } {
  const text = bytes.toString("utf8");
  const match = /^---\ncategory: ([^\n]+)\ntitle: ([^\n]*)\n---\n\n?([\s\S]*)$/u.exec(text);
  if (match === null || !ARTICLE_CATEGORY_VALUES.includes(match[1] as KnowledgeCategory)) {
    fail("KNOWLEDGE_RECORD_INVALID", `${path}:article front matter`);
  }
  const title = match[2] ?? "";
  assertArticleField(title, RUNTIME_CAPACITY.bufferBytes, "article title");
  return { category: match[1] as KnowledgeCategory, title, content: match[3] ?? "" };
}

function articleIndexBody(title: string, summary: string, path: string): string {
  const body = `${title}\n${summary}\nSource: ${path}`;
  assertBoundedString(body, KNOWLEDGE_LIMITS.maximumBodyBytes, "article index body");
  return body;
}

function truncateArticleUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function articleSourceReference(path: string): readonly string[] {
  return [path];
}

async function removeArticleIfExact(path: string, expected: Buffer): Promise<void> {
  try {
    const actual = await readArticleBytes(path);
    if (actual.equals(expected)) await rm(path, { force: true });
  } catch {
    // The original mutation error is the useful receipt; cleanup is best effort.
  }
}

function exactFields(value: unknown, expected: readonly string[], label: string, reasonCode: KnowledgeReasonCode): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(reasonCode, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const required = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(reasonCode, `${label} fields are not exact`);
  }
}

function assertBoundedString(value: unknown, maximumBytes: number, label: string): asserts value is string {
  if (typeof value !== "string") {
    fail("KNOWLEDGE_INPUT_INVALID", `${label} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", label);
  }
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("KNOWLEDGE_CANONICAL_INVALID", error.message);
    }
    throw error;
  }
}

function assertSortedStrings(values: unknown, maximum: number, label: string, pattern?: RegExp): asserts values is readonly string[] {
  if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length ||
    values.some((value) => typeof value !== "string" || (pattern ? !pattern.test(value) : false))) {
    fail("KNOWLEDGE_INPUT_INVALID", label);
  }
  for (const value of values) {
    assertBoundedString(value, RUNTIME_CAPACITY.stringCodeUnits, label);
  }
  if (JSON.stringify(values) !== JSON.stringify([...values].sort(compareCanonicalText))) {
    fail("KNOWLEDGE_CANONICAL_INVALID", `${label} must be sorted`);
  }
}

function assertLinkIds(values: unknown, namespace: string | null, label: string): asserts values is readonly string[] {
  assertSortedStrings(values, KNOWLEDGE_LIMITS.maximumLinksPerClass, label);
  for (const value of values) {
    try {
      assertProtocolId(value);
    } catch (error) {
      fail("KNOWLEDGE_LINK_INVALID", `${label}:${String(error)}`);
    }
    if (namespace && !value.startsWith(`${namespace}:`)) {
      fail("KNOWLEDGE_LINK_INVALID", `${label}:${value}`);
    }
  }
}

async function boundDirectory(path: string, parent?: string): Promise<string> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink()) {
    fail("KNOWLEDGE_LINK_UNSAFE", path);
  }
  if (!before.isDirectory()) {
    fail("KNOWLEDGE_SPECIAL_FILE", path);
  }
  const canonical = await realpath(path);
  if (parent && !inside(parent, canonical)) {
    fail("KNOWLEDGE_PATH_INVALID", path);
  }
  const after = await lstat(canonical);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", path);
  }
  return canonical;
}

// STORY-177: the knowledge store's data-plane IO rides through a StoreBackend.
// The profile maps the shared physical failures to the knowledge reason-code
// family and carries each file type's byte bound (the same bounds the former
// readBoundRegularFile call sites passed). The file backend is the default; an
// injected factory (withStoreBackendFactory) can swap in a PG backend.
const knowledgeBackendProfile: FileStoreBackendProfile = Object.freeze({
  reasonCodes: Object.freeze({
    pathInvalid: "KNOWLEDGE_PATH_INVALID",
    linkUnsafe: "KNOWLEDGE_LINK_UNSAFE",
    specialFile: "KNOWLEDGE_SPECIAL_FILE",
    limitExceeded: "KNOWLEDGE_LIMIT_EXCEEDED",
    sourceChanged: "KNOWLEDGE_SOURCE_CHANGED",
    alreadyExists: "KNOWLEDGE_ALREADY_EXISTS",
  }),
  limits: Object.freeze({
    markerBytes: RUNTIME_CAPACITY.bufferBytes,
    metadataBytes: KNOWLEDGE_LIMITS.maximumMetadataBytes,
    bodyBytes: KNOWLEDGE_LIMITS.maximumBodyBytes,
    viewBytes: PROTOCOL_LIMITS.maxCanonicalBytes,
    recordBytes: 0,
  }),
});

function storeBackendFor(storeRoot: string, options: KnowledgeReadOptions = {}): StoreBackend {
  return libraryKnowledgeView(storeRoot, options).file(KNOWLEDGE_VIEW_FILE);
}

// TCRN-CROSS-STORY-469 R4: a library's knowledge index view is derived state, so it is this
// device's cache, cache/<library>/crest-views/index.json, never a file in crest/. An old-layout
// store (read-only) keeps its views/ directory. TCRN-CROSS-SUB-428 (INC-398): the folder holds
// index.json and, past the canonical ceiling, the page files it names (knowledgeViewFiles).
export const KNOWLEDGE_CACHE_VIEWS_DIRECTORY = "crest-views" as const;
const KNOWLEDGE_VIEW_FILE = "index.json" as const;
const KNOWLEDGE_VIEW_PAGE_FILE_PATTERN = /^index-(\d{6,})\.json$/u;

async function libraryKnowledgeViewFolder(storeRoot: string): Promise<string | null> {
  const libraryRoot = dirname(storeRoot);
  if (!(await hasLibraryManifest(libraryRoot))) return null;
  return join(cachePath((await openLibrary(libraryRoot)).manifest.libraryId), KNOWLEDGE_CACHE_VIEWS_DIRECTORY);
}

// A store backend whose view is the file `name` of this device's view folder, or, where the folder
// is null, an old-layout store's views/index.json.
function knowledgeViewFileBackend(
  storeRoot: string,
  options: KnowledgeReadOptions,
  folder: () => Promise<string | null>,
  name: string,
): StoreBackend {
  return resolveStoreBackend(storeRoot, knowledgeBackendProfile, {
    beforeDescriptorReadForTest: options.beforeDescriptorReadForTest,
    afterDescriptorOpenForTest: options.afterDescriptorOpenForTest,
  }, { knowledgeViewFile: async () => {
    const located = await folder();
    return located === null ? null : join(located, name);
  } });
}

// This device's view of a library's crest; an old-layout store's folder is null.
function libraryKnowledgeView(storeRoot: string, options: KnowledgeReadOptions = {}): KnowledgeViewPlace {
  let located: Promise<string | null> | undefined;
  const folder = (): Promise<string | null> => (located ??= libraryKnowledgeViewFolder(storeRoot));
  return { folder, file: (name) => knowledgeViewFileBackend(storeRoot, options, folder, name) };
}

/**
 * Run a crest write under this machine's lock of the library (TCRN-CROSS-STORY-469 R3): the lock
 * file lives in the device directory, never in the library, and it is the one every chain write
 * takes, so the writers on one machine never interleave. TCRN-CROSS-SUB-414: those writers share
 * one thing, this device's crest event stream, which is what the lock serialises; two devices never
 * write one file of a crest, since each appends only to its own stream and nothing but
 * initialization writes the root manifest. An old-layout store is read-only: its writers refuse
 * on their own.
 */
export async function withCrestWriteLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  if (!(await hasLibraryManifest(resolve(workspaceRoot)))) return operation();
  return withWorkspaceWriteLock(workspaceRoot, () => operation());
}

// TCRN-CROSS-STORY-529 (TCRN-CROSS-SUB-481): a library crest write scans the crest, digests its sources
// and judges the card outside the lock, and holds the lock for the append alone: under it, the crest's
// device streams must stand where the scan found them, or the write scans again. A write another
// writer outran CREST_OPTIMISTIC_ATTEMPTS times scans under the lock, as every write once did.
const CREST_OPTIMISTIC_ATTEMPTS = 4;

// How a crest write commits what it built from `scan`: under the lock, after the heads check.
type CrestCommit = <T>(scan: CrestScan, commit: () => Promise<T>) => Promise<T>;

class CrestMovedSinceScan extends Error {}

async function optimisticCrestWrite<T>(workspaceRoot: string, write: (commitUnderLock: CrestCommit) => Promise<T>): Promise<T> {
  const checked: CrestCommit = (scan, commit) => withCrestWriteLock(workspaceRoot, async () => {
    if (await currentCrestHeads(scan.storeRoot) !== crestHeadsKey(scan.eventHeads)) throw new CrestMovedSinceScan();
    return commit();
  });
  for (let attempt = 1; attempt <= CREST_OPTIMISTIC_ATTEMPTS; attempt += 1) {
    try {
      return await write(checked);
    } catch (error) {
      if (!(error instanceof CrestMovedSinceScan)) throw error;
    }
  }
  return withCrestWriteLock(workspaceRoot, () => write((_scan, commit) => commit()));
}

function crestHeadsKey(heads: readonly CrestEventHead[]): string {
  return JSON.stringify(heads.filter((head) => head.sequence > 0)
    .map((head) => [head.deviceId, head.sequence, head.eventHash])
    .sort((left, right) => compareCanonicalText(String(left[0]), String(right[0]))));
}

// The head of every device stream of a crest from its file names alone -- no event is read -- in the
// form crestHeadsKey gives a scan's heads. An absent events/ directory has none.
async function currentCrestHeads(storeRoot: string): Promise<string> {
  const eventsPath = userCrestEventsPath(storeRoot);
  let devices;
  try {
    devices = await readdir(eventsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return crestHeadsKey([]);
    throw error;
  }
  const heads: CrestEventHead[] = [];
  for (const entry of devices) {
    if (isAtomicTemporaryName(entry.name) || !entry.isDirectory()) continue;
    let head: CrestEventHead | null = null;
    for (const name of await readdir(join(eventsPath, entry.name))) {
      if (isAtomicTemporaryName(name)) continue;
      const match = CREST_EVENT_FILE_PATTERN.exec(name);
      if (match === null) continue;
      const sequence = Number(match[1]);
      if (head === null || sequence > head.sequence) head = { deviceId: entry.name, sequence, eventHash: match[2] as string };
    }
    if (head !== null) heads.push(head);
  }
  return crestHeadsKey(heads);
}

/**
 * knowledge-bodies-migrate (STORY-341): rewrite the metadata/body layout's bodies/ into segments, under
 * this machine's lock of the library. TCRN-CROSS-SUB-425 R18 (fixes STORY-341): a layout already in
 * segments, or partly in them, keeps every body it holds, and one with no body file left to move is
 * not written; the answer counts the bodies the layout holds before and after the run.
 * `options.clearRemoved` (STORY-514 R4) clears the removed cards' bodies from the layout as well, and
 * takes `options.at`, the instant its backup is named by (clearRemovedKnowledgeBodies).
 */
export async function migrateKnowledgeBodies(
  workspaceRootInput: string,
  segmentBytes = 1_048_576,
  options: { readonly clearRemoved?: boolean; readonly at?: string } = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  const at = options.at;
  if (options.clearRemoved !== true) {
    if (at !== undefined) fail("KNOWLEDGE_INPUT_INVALID", "--at is taken only with --clear-removed true");
    return withCrestWriteLock(workspaceRootInput, () => migrateKnowledgeBodiesUnlocked(workspaceRootInput, segmentBytes));
  }
  if (at === undefined) fail("KNOWLEDGE_INPUT_INVALID", "--clear-removed true takes --at, the instant its backup is named by");
  assertEvaluationInstant(at);
  return withCrestWriteLock(workspaceRootInput, () => clearRemovedKnowledgeBodies(workspaceRootInput, segmentBytes, at));
}

async function migrateKnowledgeBodiesUnlocked(workspaceRootInput: string, segmentBytes = 1_048_576): Promise<Readonly<Record<string, JsonValue>>> {
  // Body migration is a disposable-store rewrite of the metadata/body layout's bodies/ into
  // segments. TCRN-CROSS-SUB-414: it writes neither store.json nor an event stream, so an event
  // stream's bodies stay where their events name them, and a crest holding only event streams has
  // nothing to migrate. An old-layout store is read-only, and so refuses it.
  await assertKnowledgeWritable(resolve(workspaceRootInput));
  const scan = await scanKnowledgeStore(workspaceRootInput, { allowTrailing: true }, false, "metadata-only");
  if (scan.bodiesRoot === null) return { schemaVersion: "tcrn.knowledge-body-migration.v1", before: 0, after: 0, bodyBytes: 0 };
  const backend = storeBackendFor(scan.storeRoot);
  if (!(backend instanceof SegmentedKnowledgeStoreBackend)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "the local segmented knowledge backend is unavailable");
  }
  const result = await backend.migrateKnowledgeBodies(segmentBytes);
  return { schemaVersion: "tcrn.knowledge-body-migration.v1", ...result };
}

// Where a clearing of the metadata/body layout backs its bodies/ up: backups/<UTC second>/ of the device
// directory, as every backup of this engine (MIN-238 D4), then this directory and the library's name.
const KNOWLEDGE_BODIES_BACKUP_DIRECTORY = "crest-bodies" as const;

// The UTC second as a directory name that is legal everywhere: 20260930T123000Z.
function backupStamp(at: string): string {
  const milliseconds = Number(parseStrictInstant(at) / 1_000_000n);
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[-:]/gu, "");
}

/**
 * TCRN-CROSS-SUB-425 R18 (STORY-514 R4; MIN-239 D4): clear the removed cards' bodies from the
 * metadata/body layout an engine before event streams left in a library's crest -- a card another card
 * superseded (by this engine, or by the mark an older one stored) and a card a removal event names --
 * which no device clears at its writes, since the layout is no device's stream. It is the library's
 * single-writer step: it runs under this machine's lock of the library, only on a device whose writes
 * are the library's only ones (assertSoleLibraryWriter), after a full read of the crest that binds
 * every body. It copies bodies/ as it is into backups/<UTC second>/crest-bodies/<library>/ of the device
 * directory first, then rewrites the segments without those bodies -- any body file left is moved in
 * the same rewrite -- every other body byte for byte, with the manifest and the point indexes. A run
 * with nothing to clear and nothing to move writes nothing and backs nothing up, so a second run
 * changes nothing. Metadata, event files, the streams' bodies and an old-layout store are not touched.
 */
async function clearRemovedKnowledgeBodies(workspaceRootInput: string, segmentBytes: number, at: string): Promise<Readonly<Record<string, JsonValue>>> {
  await assertKnowledgeWritable(resolve(workspaceRootInput));
  const scan = await mutationAdmissionScan(workspaceRootInput, {});
  if (scan.bodiesRoot === null) {
    return { schemaVersion: "tcrn.knowledge-body-migration.v1", before: 0, after: 0, bodyBytes: 0, clearedBodies: 0, backupDir: null };
  }
  await assertSoleLibraryWriter(scan);
  const backend = storeBackendFor(scan.storeRoot);
  if (!(backend instanceof SegmentedKnowledgeStoreBackend)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "the local segmented knowledge backend is unavailable");
  }
  const directory = join(backupsPath(deviceHome()), backupStamp(at), KNOWLEDGE_BODIES_BACKUP_DIRECTORY, libraryDirectoryName(scan.workspace.metadata.workspaceId));
  const backup: { directory: string | null } = { directory: null };
  const result = await backend.clearKnowledgeBodies(new Set(scan.removals.keys()), segmentBytes, async (files) => {
    await backupKnowledgeBodies(directory, files);
    backup.directory = directory;
  });
  return {
    schemaVersion: "tcrn.knowledge-body-migration.v1",
    before: result.before,
    after: result.after,
    bodyBytes: result.bodyBytes,
    clearedBodies: result.cleared,
    backupDir: backup.directory,
  };
}

// TCRN-CROSS-SUB-425 R18: refuse unless this device is the library's sole writer -- every stream of its
// chain (akasha/) and every stream of its crest (crest/events/) is this device's -- since the
// metadata/body layout is no device's stream, and two devices never write one file of a crest.
async function assertSoleLibraryWriter(scan: KnowledgeStoreScan): Promise<void> {
  const device = await readDevice(deviceHome());
  const writers = new Set((scan.workspace.library?.streams ?? []).map((stream) => stream.deviceId));
  for (const deviceId of await crestStreamDevices(scan.storeRoot)) writers.add(deviceId);
  const named = [...writers].sort(compareCanonicalText);
  if (device === null || named.some((deviceId) => deviceId !== device.deviceId)) {
    fail("KNOWLEDGE_SOLE_WRITER_REQUIRED", `${named.filter((deviceId) => deviceId !== device?.deviceId).join(",")} also write this library: only its sole writer clears the metadata/body layout`, {
      deviceId: device?.deviceId ?? null,
      writers: named,
    });
  }
}

// The devices with a stream in a crest's events/, whether or not it holds an event yet.
async function crestStreamDevices(storeRoot: string): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(resolve(storeRoot, CREST_EVENTS_DIRECTORY));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    fail("KNOWLEDGE_PATH_INVALID", `${storeRoot}:${String(error)}`);
  }
  return entries.filter((name) => !isAtomicTemporaryName(name));
}

// Copy the files of a layout's bodies/ into a backup directory of their own. A backup is never
// overwritten: a directory already there refuses (KNOWLEDGE_ALREADY_EXISTS) before the layout is written.
async function backupKnowledgeBodies(directory: string, files: readonly { readonly name: string; readonly bytes: Buffer }[]): Promise<void> {
  await ensureDeviceDirectory(dirname(directory));
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      fail("KNOWLEDGE_ALREADY_EXISTS", `${directory}: a backup of this second is already there; run again with a later --at`, { backupDir: directory });
    }
    fail("KNOWLEDGE_PATH_INVALID", `${directory}:${String(error)}`);
  }
  for (const file of files) await writeFileAtomic(join(directory, file.name), file.bytes);
}

// The claim protocol is file-native (STORY-177, like STORY-174's workspace leases):
// mutation.claim is the O_EXCL exclusive file whose identity the release verifies.
// TCRN-CROSS-SUB-414: this engine takes no claim of its own; it reads, and recovers, the claim an
// interrupted writer of the metadata/body layout left. Only the data-plane IO rides through the
// StoreBackend; these helpers stay.
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// INC-400: these are staging names, not a new record format. The owner and raw-byte digest
// let explicit recovery distinguish this device's complete publication from foreign or
// changed leftovers. A scan never removes a staging name, even in another device's stream.
const CREST_TEMP_NAME = /^\.tmp-crest-([a-f0-9]{32})-([1-9][0-9]*)-([a-f0-9]{64})-([a-f0-9]{24})-(store\.json|[0-9]{8,}-[a-f0-9]{64}\.(?:json|body))$/u;
const CREST_PUBLISH_WAIT_MS = 1_000;

function sameCrestBytes(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs;
}

// Waiting is restricted to a complete, same-inode staging link beside this final name.
// No byte is read while nlink is two. The bound inode must become single-linked; a
// persistent link, replacement, extra link, or changed staging file fails closed.
async function settleCrestPublication(path: string, before: BigIntStats): Promise<BigIntStats> {
  if (before.isSymbolicLink() || !before.isFile()) fail("KNOWLEDGE_LINK_UNSAFE", path);
  if (before.nlink === 1n) return before;
  if (before.nlink !== 2n) fail("KNOWLEDGE_LINK_UNSAFE", path);
  const parent = await boundDirectory(dirname(path));
  const parentBefore = await lstat(parent, { bigint: true });
  const deadline = Date.now() + CREST_PUBLISH_WAIT_MS;
  let temporary: string | undefined;
  for (;;) {
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || !sameCrestBytes(before, named) ||
      !sameIdentity(parentBefore, await lstat(parent, { bigint: true }))) fail("KNOWLEDGE_SOURCE_CHANGED", path);
    if (named.nlink === 1n) return named;
    if (named.nlink !== 2n) fail("KNOWLEDGE_LINK_UNSAFE", path);
    if (temporary === undefined) {
      for (const entry of await readdir(parent)) {
        const match = CREST_TEMP_NAME.exec(entry);
        if (match?.[5] !== basename(path)) continue;
        const candidate = join(parent, entry);
        let stats;
        try { stats = await lstat(candidate, { bigint: true }); } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") continue;
          throw error;
        }
        if (!sameIdentity(before, stats)) continue;
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 2n || !sameCrestBytes(before, stats)) {
          fail("KNOWLEDGE_LINK_UNSAFE", candidate);
        }
        temporary = candidate;
        break;
      }
      // The publisher can unlink its staging name between our lstat and readdir.
      if (temporary === undefined) {
        const settled = await lstat(path, { bigint: true });
        if (settled.isFile() && !settled.isSymbolicLink() && settled.nlink === 1n && sameCrestBytes(before, settled)) return settled;
        fail("KNOWLEDGE_LINK_UNSAFE", path);
      }
    } else {
      try {
        const staged = await lstat(temporary, { bigint: true });
        if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 2n || !sameCrestBytes(before, staged)) {
          fail("KNOWLEDGE_LINK_UNSAFE", temporary);
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        const settled = await lstat(path, { bigint: true });
        if (settled.isFile() && !settled.isSymbolicLink() && settled.nlink === 1n && sameCrestBytes(before, settled)) return settled;
        fail("KNOWLEDGE_LINK_UNSAFE", path);
      }
    }
    if (Date.now() >= deadline) fail("KNOWLEDGE_LINK_UNSAFE", `${path}: publication did not become single-linked`);
    await delay(5);
  }
}

async function readCrestMarker(backend: StoreBackend, storeRoot: string): Promise<Buffer> {
  const path = resolve(storeRoot, "store.json");
  try {
    const before = await lstat(path, { bigint: true });
    if (before.nlink === 2n) await settleCrestPublication(path, before);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    // The backend retains its existing missing-marker reason and observation hooks.
  }
  return backend.readKnowledgeMarker();
}

async function writeExclusiveFile(path: string, bytes: Buffer | string, deviceId: string): Promise<ExclusiveFile> {
  const parent = await boundDirectory(dirname(path));
  const parentBefore = await lstat(parent, { bigint: true });
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  const temporary = join(parent, `.tmp-crest-${deviceId}-${process.pid}-${sha256(expected)}-${randomBytes(12).toString("hex")}-${basename(path)}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let staged: BigIntStats | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    staged = await handle.stat({ bigint: true });
    await handle.writeFile(expected);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== BigInt(expected.length) || !sameIdentity(staged, opened)) {
      fail("KNOWLEDGE_LINK_UNSAFE", temporary);
    }
    await handle.close();
    handle = undefined;
    const ready = await lstat(temporary, { bigint: true });
    if (!ready.isFile() || ready.isSymbolicLink() || ready.nlink !== 1n || !sameCrestBytes(opened, ready) ||
      !sameIdentity(parentBefore, await lstat(parent, { bigint: true }))) fail("KNOWLEDGE_SOURCE_CHANGED", temporary);
    // link is an atomic, no-replace publication. Unsupported filesystems fail rather
    // than falling back to opening a partially visible final file or overwriting one.
    await link(temporary, path);
    const published = await lstat(path, { bigint: true });
    const linked = await lstat(temporary, { bigint: true });
    if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 2n ||
      linked.nlink !== 2n || !sameCrestBytes(opened, published) || !sameCrestBytes(opened, linked) ||
      !sameIdentity(parentBefore, await lstat(parent, { bigint: true }))) fail("KNOWLEDGE_SOURCE_CHANGED", path);
    await syncDirectory(parent);
    await unlink(temporary);
    staged = undefined;
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || !sameCrestBytes(opened, named) ||
      !sameIdentity(parentBefore, await lstat(parent, { bigint: true }))) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    await syncDirectory(parent);
    return { path, identity: { dev: named.dev, ino: named.ino } };
  } catch (error) {
    await handle?.close();
    if (staged !== undefined) {
      // Cleanup belongs only to this attempt's still-bound staging inode. A swapped
      // name is evidence, and is left in place rather than deleting somebody's file.
      try {
        const named = await lstat(temporary, { bigint: true });
        if (named.isFile() && !named.isSymbolicLink() && sameIdentity(staged, named)) await unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as { code?: string }).code !== "ENOENT") throw cleanupError;
      }
    }
    if ((error as { code?: string }).code === "EEXIST") {
      fail("KNOWLEDGE_ALREADY_EXISTS", path);
    }
    if (error instanceof KnowledgeCoreError) {
      throw error;
    }
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  }
}

// TCRN-CROSS-STORY-469 R1: a library keeps its knowledge store in crest/; an old-layout
// workspace's store stays where its engine wrote it and is only ever read.
export async function knowledgeStorePath(workspaceRoot: string): Promise<string> {
  return await hasLibraryManifest(workspaceRoot)
    ? resolve(workspaceRoot, DIRECTORY.knowledge)
    : resolve(workspaceRoot, LEGACY_CONTROL_DIRECTORY, LEGACY_KNOWLEDGE_DIRECTORY);
}

async function assertKnowledgeWritable(workspaceRoot: string): Promise<void> {
  if (!await hasLibraryManifest(workspaceRoot)) {
    fail("LEGACY_WORKSPACE_READ_ONLY", `${workspaceRoot} is an old-layout workspace; its knowledge store is read-only`);
  }
}

// A library's crest/ exists from the start and is empty until the store is initialized there.
async function ensureEmptyStoreRoot(path: string, parent: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return ensureNewDirectory(path, parent);
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  }
  if (entries.length > 0) fail("KNOWLEDGE_ALREADY_EXISTS", path);
  return boundDirectory(path, parent);
}

async function ensureNewDirectory(path: string, parent: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      fail("KNOWLEDGE_ALREADY_EXISTS", path);
    }
    fail("KNOWLEDGE_PATH_INVALID", `${path}:${String(error)}`);
  }
  return boundDirectory(path, parent);
}

function parseCanonicalObject(bytes: Buffer, label: string, reasonCode: KnowledgeReasonCode): Readonly<Record<string, JsonValue>> {
  try {
    const parsed = assertCanonicalJson(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(reasonCode, `${label} must be an object`);
    }
    return parsed as Readonly<Record<string, JsonValue>>;
  } catch (error) {
    if (error instanceof KnowledgeCoreError) {
      throw error;
    }
    if (error instanceof ProtocolError) {
      fail(reasonCode, error.message);
    }
    fail(reasonCode, String(error));
  }
}

function validateMarker(value: Readonly<Record<string, JsonValue>>): KnowledgeStoreMarker {
  exactFields(value, Object.hasOwn(value, "lastSweepAt") ? [...markerFields, "lastSweepAt"] : markerFields, "knowledge marker", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== KNOWLEDGE_STORE_SCHEMA_VERSION || typeof value.workspaceId !== "string" ||
    !/^(?:workspace|library|user-crest):[a-f0-9]{24}$/u.test(value.workspaceId) || typeof value.eventHighWaterDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.eventHighWaterDigest) || !Number.isSafeInteger(value.version) || Number(value.version) < 0 ||
    value.disposable !== true || value.authority !== "metadata-index-authority-body-separate") {
    fail("KNOWLEDGE_RECORD_INVALID", "knowledge marker fields are invalid");
  }
  if (Object.hasOwn(value, "lastSweepAt")) {
    if (typeof value.lastSweepAt !== "string") fail("KNOWLEDGE_RECORD_INVALID", "knowledge marker lastSweepAt");
    try { assertStrictInstant(value.lastSweepAt); } catch { fail("KNOWLEDGE_RECORD_INVALID", "knowledge marker lastSweepAt"); }
  }
  return value as unknown as KnowledgeStoreMarker;
}

function assertPromotableProvenance(metadata: KnowledgeUnitMetadata): void {
  try {
    assertProtocolId(metadata.accountableOwnerId);
  } catch (error) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `accountable owner:${String(error)}`);
  }
  if (!metadata.accountableOwnerId.startsWith("owner:")) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `${metadata.id}:accountable owner is required`);
  }
  if (!isRelaxedProvenanceKind(metadata.kind) &&
    (metadata.sourceReferences.length === 0 || metadata.linkedEvidenceIds.length === 0)) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `${metadata.id}:source and evidence are required for ${metadata.kind} knowledge`);
  }
  // TCRN-CROSS-INC-282: a relaxed-kind card that names a source but no evidence id used to
  // be refused here. Nothing refused the write, so the card landed as a candidate the
  // default selection did not return, and this refusal then made that candidate
  // unpromotable by anyone -- written, unretrievable, and unrepairable in one step. The
  // rule is gone rather than moved: for a relaxed kind, provenance is what the writer
  // chose to attach, and half of it is more than none.
  // WSC-6 / OD-18: current records require at least one retrieval tag and a non-empty
  // snippet. buildMetadata applies these checks before writing, where the writer can see them;
  // historical promoted records remain subject to them when read.
  if (metadata.tags.length === 0 || metadata.snippet.length === 0) {
    fail("KNOWLEDGE_PROMOTION_INVALID", `${metadata.id}:promotion requires at least one tag and a non-empty snippet`);
  }
}

// STORY-326: records written before `supersedes` existed are admitted as the
// explicit null value. The derived index keeps null fields omitted for those
// legacy records, so an existing store remains byte-valid until its next normal
// mutation rewrites the derived view.
// TCRN-CROSS-STORY-364 extends the same admission to `expansions`: a record written
// before phrasings existed reads as one carrying none, and the derived view below keeps
// omitting the empty value so an existing store stays byte-valid until its next write.
function normalizeMetadataRecord(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const withSupersedes = Object.hasOwn(value, "supersedes") ? value : { ...value, supersedes: null };
  return Object.hasOwn(withSupersedes, "expansions") ? withSupersedes : { ...withSupersedes, expansions: {} };
}

function validateRetirementRecord(value: unknown, expectedId?: string): KnowledgeRetirementRecord | undefined {
  if (value === undefined) return undefined;
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail("KNOWLEDGE_RECORD_INVALID", "retirement record");
  const entry = value as Readonly<Record<string, unknown>>;
  exactFields(entry, retirementFields, "retirement record", "KNOWLEDGE_RECORD_INVALID");
  if (entry.schemaVersion !== "tcrn.knowledge-retirement.v1" || typeof entry.id !== "string" || !knowledgeIdPattern.test(entry.id) ||
    (expectedId !== undefined && entry.id !== expectedId) || entry.reason !== "zero-retrieval-zero-reference" ||
    !Number.isSafeInteger(entry.retrievalCount) || Number(entry.retrievalCount) < 0 ||
    !Number.isSafeInteger(entry.referenceCount) || Number(entry.referenceCount) < 0 ||
    !Number.isSafeInteger(entry.observedEvents) || Number(entry.observedEvents) < 1 ||
    !Number.isSafeInteger(entry.windowDays) || Number(entry.windowDays) < 1 ||
    typeof entry.windowStart !== "string" || typeof entry.windowEnd !== "string" || typeof entry.sweptAt !== "string") {
    fail("KNOWLEDGE_RECORD_INVALID", "retirement record fields");
  }
  for (const instant of [entry.windowStart, entry.windowEnd, entry.sweptAt]) {
    try { assertStrictInstant(instant); } catch { fail("KNOWLEDGE_RECORD_INVALID", "retirement record instant"); }
  }
  return value as KnowledgeRetirementRecord;
}

// TCRN-CROSS-STORY-358: relocated from the retired packages/core/src/artifact-lifecycle.ts
// (git tag attic-2026-09 keeps the original module). This was the module's only
// live consumer outside its own barrel re-export and its own now-deleted test, so
// the behavior moves in with its one caller instead of surviving as a public
// export with nothing left to call it. Transformation logic is unchanged from the
// original; only the failure path now speaks this file's own reason code, since
// every caller already normalizes any thrown error into KNOWLEDGE_REDACTION_REQUIRED
// (see the sourceReferences loop in validateMetadataShape below) and never needed
// to distinguish the two.
function redactArtifactReference(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || /[\u0000-\u001f\u007f]/u.test(input)) {
    fail("KNOWLEDGE_REDACTION_REQUIRED", "artifact reference must be a bounded printable string");
  }
  let value = input.replace(/^ +| +$/gu, "");
  if (/^(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|var\/folders)\/)/u.test(value)) {
    return "[redacted-private-path]";
  }
  try {
    const schemeRelative = value.startsWith("//");
    const url = new URL(schemeRelative ? `https:${value}` : value);
    if (url.host !== "") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      value = schemeRelative ? `//${url.host}${url.pathname}` : url.toString();
    } else {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/u.test(value)) {
        fail("KNOWLEDGE_REDACTION_REQUIRED", "unsupported hierarchical URL userinfo");
      }
      value = value.split(/[?#]/u, 1)[0] ?? "";
    }
  } catch (error) {
    if (error instanceof KnowledgeCoreError) {
      throw error;
    }
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/?#]*@/u.test(value)) {
      fail("KNOWLEDGE_REDACTION_REQUIRED", "malformed hierarchical URL userinfo");
    }
    value = value.split(/[?#]/u, 1)[0] ?? "";
  }
  value = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-private-identifier]")
    .replace(/(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gu, "[redacted-credential]")
    .replace(/\/(?:Users|home|private|var\/folders)\/[^\s]*/gu, "/[redacted-private-path]");
  if (value.length === 0) {
    fail("KNOWLEDGE_REDACTION_REQUIRED", "redacted artifact reference is empty or oversized");
  }
  try {
    canonicalJson(value);
  } catch (error) {
    fail("KNOWLEDGE_REDACTION_REQUIRED", String(error));
  }
  return value;
}

// `workspace` is the library a card's links are checked against; null is the user crest, whose
// cards are checked against themselves (validateUserCrestLinks).
function validateMetadataShape(value: Readonly<Record<string, JsonValue>>, workspace: WorkspaceState | null, deferLinks = false): KnowledgeUnitMetadata {
  const normalizedValue = normalizeMetadataRecord(value);
  exactFields(normalizedValue, [
    ...metadataFields,
    ...(Object.hasOwn(normalizedValue, "promotionState") ? ["promotionState"] : []),
    ...(Object.hasOwn(normalizedValue, "retirement") ? ["retirement"] : []),
  ], "knowledge metadata", "KNOWLEDGE_RECORD_INVALID");
  exactFields(normalizedValue.stalenessPolicy, stalenessFields, "knowledge staleness policy", "KNOWLEDGE_RECORD_INVALID");
  if (normalizedValue.schemaVersion !== KNOWLEDGE_METADATA_SCHEMA_VERSION || typeof normalizedValue.id !== "string" ||
    typeof normalizedValue.externalKey !== "string" || typeof normalizedValue.scope !== "string" ||
    !["workspace", "project", "role", "user"].includes(normalizedValue.scope) ||
    (normalizedValue.projectId !== null && typeof normalizedValue.projectId !== "string") || typeof normalizedValue.category !== "string" ||
    !["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"].includes(normalizedValue.category) ||
    typeof normalizedValue.kind !== "string" || !["fact", "guide", "decision", "reference", "summary"].includes(normalizedValue.kind) ||
    typeof normalizedValue.subject !== "string" || typeof normalizedValue.summary !== "string" || typeof normalizedValue.snippet !== "string" ||
    typeof normalizedValue.accountableOwnerId !== "string" ||
    typeof normalizedValue.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(normalizedValue.sourceDigest) ||
    (normalizedValue.supersedes !== null && typeof normalizedValue.supersedes !== "string") ||
    typeof normalizedValue.lifecycle !== "string" || !["candidate", "active", "retired"].includes(normalizedValue.lifecycle) ||
    typeof normalizedValue.retrievalDisposition !== "string" || !["default", "explicit-only", "excluded"].includes(normalizedValue.retrievalDisposition) ||
    (Object.hasOwn(normalizedValue, "promotionState") && (typeof normalizedValue.promotionState !== "string" || !["candidate", "promoted", "rejected"].includes(normalizedValue.promotionState))) ||
    typeof normalizedValue.freshnessState !== "string" || !["fresh", "stale", "unknown"].includes(normalizedValue.freshnessState) ||
    (normalizedValue.lastVerified !== null && typeof normalizedValue.lastVerified !== "string") ||
    normalizedValue.redactionDisposition !== "focused-reference-redaction-v1" ||
    typeof normalizedValue.exportDisposition !== "string" || !["metadata-only", "excluded"].includes(normalizedValue.exportDisposition) ||
    normalizedValue.authority !== "workspace-knowledge-metadata" || normalizedValue.sourceProvenance !== "explicit-current-source-reference" ||
    typeof normalizedValue.bodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(normalizedValue.bodySha256) ||
    !Number.isSafeInteger(normalizedValue.bodyBytes) || Number(normalizedValue.bodyBytes) < 0 ||
    !Number.isSafeInteger(normalizedValue.revision) || Number(normalizedValue.revision) < 1 || typeof normalizedValue.updatedAt !== "string" ||
    !extensionsAreBounded(normalizedValue.extensions) || !expansionsAreBounded(normalizedValue.expansions)) {
    fail("KNOWLEDGE_RECORD_INVALID", String(normalizedValue.id ?? "unknown"));
  }
  validateRetirementRecord(normalizedValue.retirement, typeof normalizedValue.id === "string" ? normalizedValue.id : undefined);
  if ((normalizedValue.stalenessPolicy.maximumAgeDays !== null &&
    (!Number.isSafeInteger(normalizedValue.stalenessPolicy.maximumAgeDays) || Number(normalizedValue.stalenessPolicy.maximumAgeDays) < 1 || Number(normalizedValue.stalenessPolicy.maximumAgeDays) > Number.MAX_SAFE_INTEGER)) ||
    (normalizedValue.stalenessPolicy.unknownDisposition !== "fail-closed" && normalizedValue.stalenessPolicy.unknownDisposition !== "fail-open")) {
    fail("KNOWLEDGE_RECORD_INVALID", "staleness policy is invalid");
  }
  const metadata = normalizedValue as unknown as KnowledgeUnitMetadata;
  try {
    assertProtocolId(metadata.id);
    canonicalExternalKey(metadata.externalKey);
    assertStrictInstant(metadata.updatedAt);
    if (metadata.lastVerified !== null) assertStrictInstant(metadata.lastVerified);
    if (metadata.supersedes !== null) {
      assertProtocolId(metadata.supersedes);
      if (!metadata.supersedes.startsWith("knowledge:") || metadata.supersedes === metadata.id) {
        fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:supersedes`);
      }
    }
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    fail(error instanceof ProtocolError && error.reasonCode === "CANONICAL_VALUE_INVALID" ? "KNOWLEDGE_CANONICAL_INVALID" : "KNOWLEDGE_RECORD_INVALID", String(error));
  }
  if (deriveStableId("knowledge", metadata.externalKey) !== metadata.id) {
    fail("KNOWLEDGE_RECORD_INVALID", `${metadata.id}:identity binding`);
  }
  assertBoundedString(metadata.subject, RUNTIME_CAPACITY.stringCodeUnits, "subject");
  assertBoundedString(metadata.summary, KNOWLEDGE_LIMITS.maximumSummaryBytes, "summary");
  assertBoundedString(metadata.snippet, KNOWLEDGE_LIMITS.maximumSnippetBytes, "snippet");
  assertSortedStrings(metadata.roleScopes, KNOWLEDGE_LIMITS.maximumRoleScopes, "role scopes", /^[a-z][a-z0-9-]*$/u);
  assertSortedStrings(metadata.tags, KNOWLEDGE_LIMITS.maximumTags, "tags", /^[a-z0-9][a-z0-9-]*$/u);
  assertSortedStrings(metadata.sourceReferences, KNOWLEDGE_LIMITS.maximumLocators, "source references");
  assertLinkIds(metadata.linkedWorkIds, "work", "linked work IDs");
  assertLinkIds(metadata.linkedDecisionIds, "decision", "linked decision IDs");
  assertLinkIds(metadata.linkedGateIds, "gate", "linked gate IDs");
  assertLinkIds(metadata.linkedEvidenceIds, "evidence", "linked evidence IDs");
  // WSC-3 / SDC-6: provenance (owner:-prefixed accountable owner, non-empty source
  // and evidence links) is enforced for current records and historical promoted ones.
  // Historical candidate or rejected records retain the shape they were written with.
  if (metadata.promotionState === undefined || metadata.promotionState === "promoted") {
    assertPromotableProvenance(metadata);
  }
  for (const reference of metadata.sourceReferences) {
    // TCRN-CROSS-STORY-358: redactArtifactReference now raises KnowledgeCoreError
    // rather than ArtifactLifecycleError, so a `try` wrapped around the comparison
    // would hit the instanceof re-throw and drop metadata.id from the message. The
    // value is taken first and compared outside the try, which keeps the refusal
    // naming the record it came from on both paths.
    let redacted: string;
    try {
      redacted = redactArtifactReference(reference);
    } catch (error) {
      fail("KNOWLEDGE_REDACTION_REQUIRED", `${metadata.id}:${String(error)}`);
    }
    if (redacted !== reference) {
      fail("KNOWLEDGE_REDACTION_REQUIRED", metadata.id);
    }
  }
  // WSC-2: link liveness is validated separately so a rebase can tolerate it, and
  // retired records skip it durably — they are tombstoned audit records whose
  // backlinks into now-removed work are intentionally preserved.
  if (!deferLinks && metadata.lifecycle !== "retired") {
    if (workspace === null) validateUserCrestLinks(metadata);
    else validateMetadataLinks(metadata, workspace);
  }
  if (metadata.freshnessState === "unknown" && metadata.lastVerified !== null) {
    fail("KNOWLEDGE_RECORD_INVALID", `${metadata.id}:freshness`);
  }
  return metadata;
}

// CQ-10: link liveness used to run `workspace.projects.find` once per record and
// `workspace.work.find` once per linked work id, so a scan of R records over a workspace
// of P projects and W work items cost O(R*P + R*L*W) linear scans. The lookups are now
// served by maps built once per workspace state and memoized on it, which is a constant
// factor change only -- no reason code, ordering, or result changes.
//
// The maps are FIRST-WINS, because they replace `find`, which returns the first match.
// A last-wins map would silently change which duplicate id a lookup resolves to. No test
// can distinguish the two -- a materialized workspace has unique record ids -- so this is
// a review-level choice, not a proven one.
//
// The lookups are exposed as functions rather than as the raw maps so that the counters
// below sit ON the lookup path. A counter that only tallied index BUILDS would stay green
// if the call sites reverted to `workspace.*.find`, since the index would still be built
// and then ignored -- that is exactly the empty proof this package exists to avoid.
interface KnowledgeLinkIndex {
  readonly liveProject: (id: string) => ProjectRecord | undefined;
  readonly liveWork: (id: string) => WorkRecord | undefined;
}

const knowledgeLinkIndexes = new WeakMap<WorkspaceState, KnowledgeLinkIndex>();
let knowledgeLinkIndexBuilds = 0;
let knowledgeLinkIndexLookups = 0;

function knowledgeLinkIndexFor(workspace: WorkspaceState): KnowledgeLinkIndex {
  const cached = knowledgeLinkIndexes.get(workspace);
  if (cached !== undefined) return cached;
  knowledgeLinkIndexBuilds += 1;
  const projects = new Map<string, ProjectRecord>();
  for (const entry of workspace.projects) {
    if (!entry.tombstone && !projects.has(entry.id)) projects.set(entry.id, entry);
  }
  const work = new Map<string, WorkRecord>();
  for (const entry of workspace.work) {
    if (!entry.tombstone && !work.has(entry.id)) work.set(entry.id, entry);
  }
  const index: KnowledgeLinkIndex = {
    liveProject: (id) => {
      knowledgeLinkIndexLookups += 1;
      return projects.get(id);
    },
    liveWork: (id) => {
      knowledgeLinkIndexLookups += 1;
      return work.get(id);
    },
  };
  knowledgeLinkIndexes.set(workspace, index);
  return index;
}

// Test seam: the deterministic counts CQ-10 is asserted against, per the plan's acceptance
// criterion 3 (assert counts, not timings). A per-record linear scan shows up as one build
// per record; a call site that bypasses the index shows up as zero lookups.
export function knowledgeLinkIndexCountsForTest(): { readonly builds: number; readonly lookups: number } {
  return { builds: knowledgeLinkIndexBuilds, lookups: knowledgeLinkIndexLookups };
}

// WSC-2: scope/project liveness (KNOWLEDGE_LINK_INVALID:scope) and linked-work
// liveness (KNOWLEDGE_LINK_INVALID:<workId>) — the two checks a rebase tolerates
// (collecting offenders) and a retired record is durably exempt from.
function validateMetadataScope(metadata: KnowledgeUnitMetadata, workspace: WorkspaceState): void {
  if (scopeOffence(metadata, workspace) !== null) fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:scope`);
}

// Why a record's scope/project does not resolve against a chain, or null when it does. "shape" is a
// record no write of this engine produces whatever the chain holds: a user card in a library's
// crest (TCRN-CROSS-STORY-476 R5), or a scope its project and role scopes contradict. "project" is a
// consistent record whose project the chain does not hold live: TCRN-CROSS-SUB-414 (R16) names that
// one in a library's crest rather than refusing the crest. One project lookup either way (CQ-10).
function scopeOffence(metadata: KnowledgeUnitMetadata, workspace: WorkspaceState): "shape" | "project" | null {
  const index = knowledgeLinkIndexFor(workspace);
  const project = metadata.projectId === null ? undefined : index.liveProject(metadata.projectId);
  if (metadata.scope === "user" ||
    (metadata.scope === "workspace" && (metadata.projectId !== null || metadata.roleScopes.length !== 0)) ||
    (metadata.scope === "project" && (metadata.projectId === null || metadata.roleScopes.length !== 0)) ||
    (metadata.scope === "role" && metadata.roleScopes.length === 0)) {
    return "shape";
  }
  return metadata.projectId !== null && !project ? "project" : null;
}

function danglingLinkedWorkIds(metadata: KnowledgeUnitMetadata, workspace: WorkspaceState): readonly string[] {
  const index = knowledgeLinkIndexFor(workspace);
  return metadata.linkedWorkIds.filter((workId) => {
    const work = index.liveWork(workId);
    return !work || metadata.projectId === null || work.projectId !== metadata.projectId;
  });
}

function validateMetadataLinks(metadata: KnowledgeUnitMetadata, workspace: WorkspaceState): void {
  validateMetadataScope(metadata, workspace);
  const dangling = danglingLinkedWorkIds(metadata, workspace);
  if (dangling.length > 0) fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:${dangling[0]}`);
}

function validateExistingMetadataShape(metadata: KnowledgeUnitMetadata, workspace: WorkspaceState | null): KnowledgeUnitMetadata {
  const validated = validateMetadataShape(metadata as unknown as Readonly<Record<string, JsonValue>>, workspace, true);
  if (validated.lifecycle !== "retired") {
    if (workspace === null) validateUserCrestLinks(validated);
    else validateMetadataScope(validated, workspace);
  }
  return validated;
}

// TCRN-CROSS-STORY-476 R5: a card in the user crest is a user card, and a user card belongs to
// no library: it names no project and no role, and links no work record, since every work record
// is one library's. Decision, gate and evidence ids stay shape-checked, as they are everywhere.
function validateUserCrestLinks(metadata: KnowledgeUnitMetadata): void {
  if (metadata.scope !== "user" || metadata.projectId !== null || metadata.roleScopes.length !== 0) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:scope`);
  }
  const workId = metadata.linkedWorkIds[0];
  if (workId !== undefined) fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:${workId}`);
}

function validateSupersedesLink(
  metadata: KnowledgeUnitMetadata,
  records: ReadonlyMap<string, KnowledgeUnitMetadata>,
): void {
  if (metadata.supersedes === null) return;
  const target = records.get(metadata.supersedes);
  // The write path rejects a retired target. A store may hold a superseded record that an
  // older engine retired afterwards, so the read checks existence rather than reapplying the
  // historical admission rule.
  if (target === undefined) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:supersedes:${metadata.supersedes}`);
  }
}

// `workspace` null is the user crest, whose card record stands under USER_CREST_ID.
function validateMetadataBody(metadata: KnowledgeUnitMetadata, body: Buffer, workspace: WorkspaceState | null): void {
  if (metadata.bodyBytes !== body.length || sha256(body) !== metadata.bodySha256) {
    fail("KNOWLEDGE_RECORD_INVALID", `${metadata.id}:body binding`);
  }
  const protocolRecord: KnowledgeRecord = {
    schemaVersion: "tcrn.knowledge.v1",
    id: metadata.id,
    projectId: metadata.projectId ?? (workspace === null ? USER_CREST_ID : workspace.metadata.workspaceId),
    subject: metadata.subject,
    body: body.toString("utf8"),
    revision: metadata.revision,
    updatedAt: metadata.updatedAt,
    tombstone: metadata.lifecycle === "retired",
    extensions: {},
  };
  if (!Buffer.from(protocolRecord.body, "utf8").equals(body)) {
    fail("KNOWLEDGE_CANONICAL_INVALID", `${metadata.id}:body is not canonical UTF-8`);
  }
  try {
    validateKnowledgeRecord(protocolRecord);
  } catch (error) {
    fail(error instanceof ProtocolError && error.reasonCode === "CANONICAL_VALUE_INVALID" ? "KNOWLEDGE_CANONICAL_INVALID" : "KNOWLEDGE_RECORD_INVALID", String(error));
  }
}

// TCRN-CROSS-SUB-428 (INC-398): a crest's derived index. `document` is the index as every engine
// before wrote it whole, `tcrn.knowledge-index.v1`; `recordTexts` holds the canonical form of each
// of its records, in its order. Its digest and this device's view files are built from them one
// record at a time, so no single canonical value holds every record: neither the protocol's one-MiB
// canonical ceiling nor its record-count limit bounds a crest's index (knowledgeViewFiles).
interface KnowledgeIndex {
  readonly document: Readonly<Record<string, JsonValue>>;
  readonly recordTexts: readonly string[];
}

const KNOWLEDGE_INDEX_SCHEMA_VERSION = "tcrn.knowledge-index.v1" as const;
const KNOWLEDGE_INDEX_PAGES_SCHEMA_VERSION = "tcrn.knowledge-index-pages.v1" as const;
const KNOWLEDGE_INDEX_PAGE_SCHEMA_VERSION = "tcrn.knowledge-index-page.v1" as const;

// TCRN-CROSS-SUB-425: a crest's index holds each valid card's metadata and each removed card as it
// keeps it (indexRecords); an old-layout store's holds every record as its engine wrote it.
function knowledgeIndex(marker: KnowledgeStoreMarker, metadata: readonly KnowledgeIndexRecord[]): KnowledgeIndex {
  const records = [...metadata]
    .sort((left, right) => compareCanonicalText(left.id, right.id))
    // Existing stores predate STORY-326. Keep the derived view byte-compatible
    // for the default null value while metadata-first reads expose supersedes:null.
    .map((entry) => {
      const record = entry as unknown as Readonly<Record<string, unknown>>;
      return Object.fromEntries(Object.entries(record).filter(([key]) =>
        !(key === "supersedes" && record.supersedes === null) &&
        !(key === "retirement" && record.retirement === null) &&
        !(key === "expansions" && Object.keys((record.expansions ?? {}) as object).length === 0)));
    }) as unknown as readonly JsonValue[];
  const recordTexts = records.map(canonicalEntryText);
  return {
    document: {
      schemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION,
      authority: "derived-rebuildable",
      workspaceId: marker.workspaceId,
      eventHighWaterDigest: marker.eventHighWaterDigest,
      version: marker.version,
      records,
      indexDigest: canonicalListSha256(recordTexts),
    },
    recordTexts,
  };
}

// One value's canonical form as an entry of a canonical list: canonicalJson without its terminal LF.
function canonicalEntryText(value: JsonValue): string {
  return canonicalJson(value).slice(0, -1);
}

// TCRN-CROSS-SUB-428 (INC-398): the sha256 of a list as canonicalJson serializes it -- wherever the
// list fits one canonical value, exactly the digest canonicalSha256 gives it -- hashed from its
// entries' canonical forms one at a time, so no count or size of the list bounds it.
function canonicalListSha256(entryTexts: readonly string[]): string {
  const hash = createHash("sha256").update("[", "utf8");
  for (const [position, text] of entryTexts.entries()) {
    if (position > 0) hash.update(",", "utf8");
    hash.update(text, "utf8");
  }
  return hash.update("]\n", "utf8").digest("hex");
}

function knowledgeViewPageFile(page: number): string {
  return `index-${String(page).padStart(6, "0")}.json`;
}

interface KnowledgeViewFile {
  readonly name: string;
  readonly text: string;
}

// TCRN-CROSS-SUB-428 (INC-398): the files of this device's view of `index`, the pages before the
// head that names them. While the whole index fits the protocol's canonical ceiling (one MiB, and no
// more records than one canonical list may hold), the view is index.json alone, byte for byte what
// every engine before wrote. Past it, index.json is a head, `tcrn.knowledge-index-pages.v1`, naming
// how many records the index holds, how many pages hold them and the index digest; page n is
// index-<n, six digits>.json, `tcrn.knowledge-index-page.v1`, holding the next records in index order
// within the same ceiling. The records of the pages in page order are the index's records, and their
// canonical list hashes to the head's `indexDigest`.
function knowledgeViewFiles(index: KnowledgeIndex): readonly KnowledgeViewFile[] {
  const records = index.document.records as readonly JsonValue[];
  const entryBytes = index.recordTexts.map((text) => Buffer.byteLength(text, "utf8"));
  // The whole index is its fields around an empty list, plus each record and the commas between them.
  const wholeBytes = Buffer.byteLength(canonicalJson({ ...index.document, records: [] }), "utf8") +
    entryBytes.reduce((total, bytes) => total + bytes, Math.max(0, records.length - 1));
  if (wholeBytes <= KNOWLEDGE_INDEX_PAGE_TARGET_BYTES && records.length <= PROTOCOL_LIMITS.maxRecords) {
    return [{ name: KNOWLEDGE_VIEW_FILE, text: canonicalJson(index.document) }];
  }
  // A page's own fields are measured at the widest page number there can be.
  const pageBudget = KNOWLEDGE_INDEX_PAGE_TARGET_BYTES -
    Buffer.byteLength(canonicalJson({ schemaVersion: KNOWLEDGE_INDEX_PAGE_SCHEMA_VERSION, page: Number.MAX_SAFE_INTEGER, records: [] }), "utf8");
  const bounds: { readonly from: number; readonly to: number }[] = [];
  let from = 0;
  let used = 0;
  for (const [position, bytes] of entryBytes.entries()) {
    const added = position === from ? bytes : bytes + 1;
    if (position > from && (used + added > pageBudget || position - from >= PROTOCOL_LIMITS.maxRecords)) {
      bounds.push({ from, to: position });
      from = position;
      used = bytes;
    } else {
      used += added;
    }
  }
  bounds.push({ from, to: records.length });
  const pages = bounds.map((bound, page) => ({
    name: knowledgeViewPageFile(page + 1),
    text: canonicalJson({ schemaVersion: KNOWLEDGE_INDEX_PAGE_SCHEMA_VERSION, page: page + 1, records: records.slice(bound.from, bound.to) }),
  }));
  const { document } = index;
  return [...pages, {
    name: KNOWLEDGE_VIEW_FILE,
    text: canonicalJson({
      schemaVersion: KNOWLEDGE_INDEX_PAGES_SCHEMA_VERSION,
      authority: document.authority,
      workspaceId: document.workspaceId,
      eventHighWaterDigest: document.eventHighWaterDigest,
      version: document.version,
      count: records.length,
      pages: pages.length,
      indexDigest: document.indexDigest,
    }),
  }];
}

async function claimPresence(storeRoot: string): Promise<"absent" | "present"> {
  try {
    const metadata = await lstat(resolve(storeRoot, "mutation.claim"));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is unsafe");
    }
    return "present";
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    if ((error as { code?: string }).code === "ENOENT") return "absent";
    fail("KNOWLEDGE_PARTIAL_STATE", String(error));
  }
}

async function readMutationClaim(storeRoot: string): Promise<KnowledgeMutationClaim | null> {
  const path = resolve(storeRoot, "mutation.claim");
  let stats;
  try { stats = await lstat(path); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is unsafe");
  }
  const value = parseCanonicalObject(await readFile(path), "knowledge mutation claim", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== "tcrn.knowledge-mutation-claim.v1" || typeof value.workspaceId !== "string" ||
    typeof value.token !== "string" || !/^[a-f0-9]{48}$/u.test(value.token) ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 0 ||
    !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.acquiredAt !== "string") {
    fail("KNOWLEDGE_RECORD_INVALID", "knowledge mutation claim fields");
  }
  try { assertStrictInstant(value.acquiredAt); } catch { fail("KNOWLEDGE_RECORD_INVALID", "knowledge mutation claim acquiredAt"); }
  return { path, identity: { dev: stats.dev, ino: stats.ino }, workspaceId: String(value.workspaceId), token: String(value.token), pid: Number(value.pid), acquiredAt: String(value.acquiredAt) };
}

// An old-layout store's root holds exactly its four entries, and a mutation claim only while a
// write of its engine ran (a library's crest checks its own root, scanLibraryCrest).
async function assertStoreRootEntries(storeRoot: string, viewsInRoot: boolean, allowClaim: boolean): Promise<void> {
  const rootEntries = (await readdir(storeRoot)).sort(compareCanonicalText);
  const expectedRootEntries = ["bodies", "metadata", "store.json", ...(viewsInRoot ? ["views"] : []), ...(allowClaim ? ["mutation.claim"] : [])].sort(compareCanonicalText);
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge store root entries are not exact");
  }
  if (!allowClaim && await claimPresence(storeRoot) === "present") {
    fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is present");
  }
}

interface ScannedRecords {
  readonly units: readonly ScannedKnowledgeUnit[];
  readonly linkInvalid: readonly string[];
  readonly danglingWorkLinks: readonly { readonly knowledgeId: string; readonly workIds: readonly string[] }[];
  // TCRN-CROSS-SUB-425 R18: the ids of the live records that hold no body, in listing order, when the
  // checks defer them (RecordChecks.missingBodies); empty otherwise, since the first refuses the scan.
  readonly missingBodies: readonly string[];
}

interface RecordChecks {
  readonly shape: (value: Readonly<Record<string, JsonValue>>) => KnowledgeUnitMetadata;
  // WSC-2, rebase only: scope/project liveness, whose KNOWLEDGE_LINK_INVALID is collected.
  readonly links: ((metadata: KnowledgeUnitMetadata) => void) | null;
  readonly danglingWorkLinks: ((metadata: KnowledgeUnitMetadata) => readonly string[]) | null;
  readonly body: (metadata: KnowledgeUnitMetadata, body: Buffer) => void;
  // TCRN-CROSS-SUB-425 R18: "deferred" hands a live record that holds no body back to the caller, which
  // admits it once it knows the card is removed (a library's crest, whose metadata/body layout
  // knowledge-bodies-migrate --clear-removed clears); left out, such a record refuses the scan.
  readonly missingBodies?: "deferred";
}

// Every card of a store, each checked by `checks` against what that store binds: a library's
// crest checks links against the library, the user crest against the card alone.
async function scanStoreRecords(
  backend: StoreBackend,
  roots: { readonly metadataRoot: string; readonly bodiesRoot: string },
  bodyMode: "full" | "metadata-only",
  checks: RecordChecks,
): Promise<ScannedRecords> {
  const metadataNames = await backend.listKnowledgeMetadata();
  const bodyNames = await backend.listKnowledgeBodies();
  const metadataIds = metadataNames.map((name) => name.endsWith(".json") ? name.slice(0, -5) : "");
  const bodyIds = bodyNames.map((name) => name.endsWith(".body") ? name.slice(0, -5) : "");
  const bodyIdSet = new Set(bodyIds);
  const metadataIdSet = new Set(metadataIds);
  // TCRN-CROSS-STORY-024: retiring a record reclaims its body (a retired body is
  // already unreadable through readKnowledgeBody), so a retired record may lack a
  // body file. The invariant is no longer set-equality but: every body has a
  // matching metadata (no orphan bodies) and both id sets are well-formed; the
  // "every live record has a body" half is enforced per-record below, once the
  // lifecycle is known.
  if (metadataIds.some((id) => !/^knowledge:[a-f0-9]{24}$/u.test(id)) || bodyIds.some((id) => !/^knowledge:[a-f0-9]{24}$/u.test(id)) ||
    bodyIds.some((id) => !metadataIdSet.has(id))) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge metadata/body sets differ");
  }
  const units: ScannedKnowledgeUnit[] = [];
  const linkInvalid: string[] = [];
  const danglingWorkLinks: { knowledgeId: string; workIds: readonly string[] }[] = [];
  const missingBodies: string[] = [];
  for (const id of metadataIds) {
    const metadataPath = resolve(roots.metadataRoot, `${id}.json`);
    const bodyPath = resolve(roots.bodiesRoot, `${id}.body`);
    const metadataBytes = await backend.readKnowledgeMetadata(id);
    const metadata = checks.shape(parseCanonicalObject(metadataBytes, "knowledge metadata", "KNOWLEDGE_RECORD_INVALID"));
    if (checks.danglingWorkLinks !== null && metadata.lifecycle !== "retired") {
      const workIds = checks.danglingWorkLinks(metadata);
      if (workIds.length > 0) danglingWorkLinks.push({ knowledgeId: metadata.id, workIds });
    }
    if (checks.links !== null && metadata.lifecycle !== "retired") {
      try {
        checks.links(metadata);
      } catch (error) {
        if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_LINK_INVALID") {
          linkInvalid.push(metadata.id);
        } else {
          throw error;
        }
      }
    }
    // TCRN-CROSS-STORY-024: a live record must still carry its body; a retired
    // record's body may have been reclaimed and is read as absent. TCRN-CROSS-SUB-425 R18: so may a
    // removed card's, which a caller that defers the check admits once it knows the removals.
    const hasBody = bodyIdSet.has(id);
    if (metadata.lifecycle !== "retired" && !hasBody) {
      if (checks.missingBodies !== "deferred") fail("KNOWLEDGE_PARTIAL_STATE", `${id}:live record is missing its body`);
      missingBodies.push(id);
    }
    const body = bodyMode === "full" && hasBody
      ? await backend.readKnowledgeBody(id)
      : null;
    if (body !== null) checks.body(metadata, body);
    if (metadata.id !== id) {
      fail("KNOWLEDGE_PATH_INVALID", id);
    }
    units.push({ metadataPath, bodyPath, metadata, body });
  }
  units.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  const metadataById = new Map(units.map((unit) => [unit.metadata.id, unit.metadata]));
  for (const unit of units) validateSupersedesLink(unit.metadata, metadataById);
  danglingWorkLinks.sort((left, right) => compareCanonicalText(left.knowledgeId, right.knowledgeId));
  return { units, linkInvalid: linkInvalid.sort(compareCanonicalText), danglingWorkLinks, missingBodies };
}

// TCRN-CROSS-SUB-428 (INC-398): where this device keeps its index view of a crest: the folder of its
// cache that holds the view's files (null only for an old-layout store, whose views/ this engine
// never writes), and a backend that reads and writes one file of it.
interface KnowledgeViewPlace {
  readonly folder: () => Promise<string | null>;
  readonly file: (name: string) => StoreBackend;
}

// A view kept in this device's cache (a library's crest, the user crest): another device's crest
// writes never reach it, so a missing or out-of-date copy is projected again rather than read as
// a partial store. TCRN-CROSS-SUB-428 (INC-398): each of its files (knowledgeViewFiles) whose cached
// bytes differ is written again, the pages before the head, and a page file past the pages the head
// names is removed. It is a cache, so nothing here fails the read, or the committed write, that asks
// for it: what cannot be projected is left for the next read to project again.
async function projectKnowledgeView(place: KnowledgeViewPlace, index: KnowledgeIndex): Promise<void> {
  try {
    const folder = await place.folder();
    if (folder === null) return;
    const files = knowledgeViewFiles(index);
    for (const file of files) {
      const backend = place.file(file.name);
      const cached = await backend.readKnowledgeView().then((bytes) => bytes.toString("utf8"), () => null);
      if (cached !== file.text) await backend.writeKnowledgeView(file.text);
    }
    const pages = files.length - 1;
    for (const name of await readdir(folder)) {
      const page = KNOWLEDGE_VIEW_PAGE_FILE_PATTERN.exec(name);
      if (page !== null && Number(page[1]) > pages) await rm(join(folder, name), { force: true });
    }
  } catch {
    // Left for the next read to project again.
  }
}

// The workspace a knowledge read is about, its bound root and the place of its store, before the
// store itself is read.
interface KnowledgeStorePlace {
  readonly workspace: WorkspaceState;
  readonly workspaceRoot: string;
  readonly storePath: string;
}

async function knowledgeStorePlace(workspaceRootInput: string): Promise<KnowledgeStorePlace> {
  const workspace = await materializeWorkspace(workspaceRootInput);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  // WSR-1: read the ACTIVE binding, not the raw roots array, so this stays the
  // single definition of the authority root across a relocation.
  const storedWorkspaceRoot = activeWorkspaceRoot(workspace.metadata);
  if (storedWorkspaceRoot !== workspaceRoot) {
    fail("KNOWLEDGE_PATH_INVALID", "knowledge store is not under the Workspace authority root");
  }
  return { workspace, workspaceRoot, storePath: await knowledgeStorePath(workspaceRoot) };
}

async function scanKnowledgeStore(
  workspaceRootInput: string,
  options: KnowledgeReadOptions = {},
  allowClaim = false,
  bodyMode: "full" | "metadata-only" = "full",
  rebase = false,
  allowStaleIndex = false,
): Promise<KnowledgeStoreScan> {
  return scanKnowledgeStoreAt(await knowledgeStorePlace(workspaceRootInput), options, allowClaim, bodyMode, rebase, allowStaleIndex);
}

async function scanKnowledgeStoreAt(
  place: KnowledgeStorePlace,
  options: KnowledgeReadOptions,
  allowClaim: boolean,
  bodyMode: "full" | "metadata-only",
  rebase: boolean,
  allowStaleIndex: boolean,
): Promise<KnowledgeStoreScan> {
  const { workspace, workspaceRoot } = place;
  const storeRoot = await boundDirectory(place.storePath, workspaceRoot);
  if (await hasLibraryManifest(workspaceRoot)) {
    return scanLibraryCrest(workspace, workspaceRoot, storeRoot, options, allowClaim, bodyMode, rebase);
  }
  return scanOldLayoutStore(workspace, workspaceRoot, storeRoot, options, allowClaim, bodyMode, rebase, allowStaleIndex);
}

// TCRN-CROSS-INIT-053 R46 (I04): whether a library's knowledge store was never created. A library
// is made with its store directory empty (initializeLibrary), and a store is created there by its first
// card or initialization; so the store is absent when its place holds nothing at all, or when the place
// itself is gone. A file, a link, an unreadable place, or a directory holding anything without its
// marker is not absent: the scan refuses each of them with its own reason code, as it always did. An
// old-layout workspace is never read as absent.
async function libraryStoreNeverCreated(place: KnowledgeStorePlace): Promise<boolean> {
  if (!await hasLibraryManifest(place.workspaceRoot)) return false;
  let entry;
  try {
    entry = await lstat(place.storePath);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
  try {
    return (await readdir(place.storePath)).length === 0;
  } catch {
    return false;
  }
}

// An old-layout workspace's store (knowledge/ in its control directory), read exactly as its
// engine left it: metadata/, bodies/ and views/ beside a marker bound to the old chain's head.
// It is read-only (TCRN-CROSS-STORY-469), so its marker can trail its chain, and a read admits
// that only when asked to (TCRN-CROSS-INC-226).
async function scanOldLayoutStore(
  workspace: WorkspaceState,
  workspaceRoot: string,
  storeRoot: string,
  options: KnowledgeReadOptions,
  allowClaim: boolean,
  bodyMode: "full" | "metadata-only",
  rebase: boolean,
  allowStaleIndex: boolean,
): Promise<KnowledgeStoreScan> {
  const metadataRoot = await boundDirectory(resolve(storeRoot, "metadata"), storeRoot);
  const bodiesRoot = await boundDirectory(resolve(storeRoot, "bodies"), storeRoot);
  const viewsRoot = await boundDirectory(resolve(storeRoot, "views"), storeRoot);
  // STORY-177: marker, metadata/body/view and their enumeration ride through the
  // StoreBackend; directory-structure validation stays file-native below.
  const backend = storeBackendFor(storeRoot, options);
  await assertStoreRootEntries(storeRoot, true, allowClaim);
  const markerBytes = await backend.readKnowledgeMarker();
  const marker = validateMarker(parseCanonicalObject(
    markerBytes,
    "knowledge marker",
    "KNOWLEDGE_RECORD_INVALID",
  ));
  // WSC-2: a rebase deliberately runs against an advanced head, so it skips only
  // the high-water equality; workspace identity binding stays mandatory.
  //
  // TCRN-CROSS-INC-226 adds the second exemption. Requiring exact equality on the
  // read path made the retrieval surface answer only in a workspace nobody was
  // working in: one work-create was measured taking all six partitions dark until
  // a hand-run rebase, because any event moves the head. The exemption is deliberately
  // narrow. `bodyMode === "metadata-only"` selects the SIX scans that read metadata: the
  // five metadata-first read verbs, and exportKnowledgeCheckpoint, which opts back out at
  // its own call site because an export artifact must not be stale-able. An earlier
  // version of this comment asserted there were five, and the checkpoint inherited the
  // exemption unnoticed and undisclosed for exactly as long as the miscount stood
  // (TCRN-CROSS-INC-232). `validate`, every mutation and the rebase itself keep the
  // strict equality they had. What the strictness bought is not discarded but
  // moved into the answer: a trailing read is labelled with both heads (see
  // `trailingDisclosure`), so a stale card is impossible to mistake for a current one.
  const trailingAdmitted = options.allowTrailing === true && bodyMode === "metadata-only" && !rebase;
  if (marker.workspaceId !== workspace.metadata.workspaceId || (!rebase && !trailingAdmitted && marker.eventHighWaterDigest !== workspace.headEventHash)) {
    fail("KNOWLEDGE_HIGH_WATER_MISMATCH", marker.workspaceId);
  }
  // WSC-2: shape remains fully validated. Rebase defers scope/project liveness into the
  // offender list; dangling work references are collected separately as non-blocking diagnostics.
  const { units, linkInvalid, danglingWorkLinks } = await scanStoreRecords(backend, { metadataRoot, bodiesRoot }, bodyMode, {
    shape: (value) => {
      const metadata = validateMetadataShape(value, workspace, true);
      if (!rebase && metadata.lifecycle !== "retired") validateMetadataScope(metadata, workspace);
      return metadata;
    },
    links: rebase ? (metadata) => validateMetadataScope(metadata, workspace) : null,
    danglingWorkLinks: (metadata) => danglingLinkedWorkIds(metadata, workspace),
    body: (metadata, body) => validateMetadataBody(metadata, body, workspace),
  });
  const index = knowledgeIndex(marker, units.map((unit) => unit.metadata));
  const viewEntries = await readdir(viewsRoot);
  if (JSON.stringify(viewEntries.sort(compareCanonicalText)) !== JSON.stringify(["index.json"])) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge views are not exact");
  }
  // TCRN-CROSS-STORY-023: the index is a derived rebuildable view whose `records`
  // array is a re-serialization of the metadata; it is validated byte-for-byte against
  // the canonical rebuild below. No card body is charged against a total
  // (TCRN-CROSS-SUB-310 R17, MIN-238 D1).
  const viewBytes = await backend.readKnowledgeView();
  const view = viewBytes.toString("utf8");
  if (!allowStaleIndex && view !== canonicalJson(index.document)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge index is stale");
  }
  const cards = units.map(metadataBodyLayoutUnit);
  // TCRN-CROSS-SUB-425: the store is read, never written, and its index view is its engine's, so the
  // index above keeps every record as that engine wrote it. A card its engine marked superseded is
  // removed as every read now answers it; the store holds no removal event.
  return {
    layout: "old-layout", workspaceRoot, storeRoot, metadataRoot, bodiesRoot, viewsRoot, marker, workspace,
    units: cards, index,
    linkInvalid,
    danglingWorkLinks,
    unresolvedConflicts: [], duplicates: [], awaitingChain: [], unresolvedScopes: [], eventHeads: [],
    removals: projectRemovals(cards, [], []), streamBodies: [],
  };
}

// A record the metadata/body layout holds, as a crest record: its one writer is that layout.
function metadataBodyLayoutUnit(unit: ScannedKnowledgeUnit): CrestUnit {
  return { ...unit, lineage: USER_CREST_LEGACY_LINEAGE, event: null, replaces: null, chain: null, storedDigest: recordDigest(unit.metadata), streamBody: null };
}

// TCRN-CROSS-SUB-414: the digest a later record of the same card names in its `replaces`: the
// canonical form of the metadata as a scan admits it.
function recordDigest(metadata: KnowledgeUnitMetadata): string {
  return sha256(canonicalJson(metadata));
}

// TCRN-CROSS-SUB-414: every chain stream's head a library's replay holds, in canonical device
// order: what a library crest event records as the chain it was written against.
function chainPositions(workspace: WorkspaceState): readonly ChainPosition[] {
  return (workspace.library?.streams ?? [])
    .filter((stream) => stream.sequence > 0 && stream.headEventHash !== null)
    .map((stream) => ({ deviceId: stream.deviceId, sequence: stream.sequence, eventHash: stream.headEventHash as string }))
    .sort((left, right) => compareCanonicalText(left.deviceId, right.deviceId));
}

const chainEventHashes = new WeakMap<WorkspaceState, ReadonlyMap<string, string>>();

// The hash of one chain stream's event at one sequence, from the events a replay holds.
function chainEventHash(workspace: WorkspaceState, streamId: string, sequence: number): string | undefined {
  let hashes = chainEventHashes.get(workspace);
  if (hashes === undefined) {
    const built = new Map<string, string>();
    for (const event of workspace.events) built.set(`${event.streamId}\u0000${event.sequence}`, event.eventHash);
    chainEventHashes.set(workspace, built);
    hashes = built;
  }
  return hashes.get(`${streamId}\u0000${sequence}`);
}

// Whether this device's chain holds every chain event a library crest event was written against:
// each named stream has reached the sequence, and its event there is the one named.
function chainHolds(workspace: WorkspaceState, chain: readonly ChainPosition[]): boolean {
  const streams = workspace.library?.streams ?? [];
  return chain.every((position) => {
    const stream = streams.find((entry) => entry.deviceId === position.deviceId);
    if (stream === undefined || stream.sequence < position.sequence) return false;
    if (stream.sequence === position.sequence) return stream.headEventHash === position.eventHash;
    return chainEventHash(workspace, stream.streamId, position.sequence) === position.eventHash;
  });
}

function validateChainPositions(value: readonly unknown[], where: string): readonly ChainPosition[] {
  const positions: ChainPosition[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("KNOWLEDGE_RECORD_INVALID", `${where}: chain`);
    exactFields(entry, ["deviceId", "eventHash", "sequence"], "crest event chain position", "KNOWLEDGE_RECORD_INVALID");
    const position = entry as Readonly<Record<string, unknown>>;
    if (typeof position.deviceId !== "string" || !/^[a-f0-9]{32}$/u.test(position.deviceId) ||
      !Number.isSafeInteger(position.sequence) || Number(position.sequence) < 1 ||
      typeof position.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(position.eventHash) ||
      (positions.length > 0 && compareCanonicalText((positions.at(-1) as ChainPosition).deviceId, position.deviceId) >= 0)) {
      fail("KNOWLEDGE_RECORD_INVALID", `${where}: chain`);
    }
    positions.push({ deviceId: position.deviceId, sequence: Number(position.sequence), eventHash: position.eventHash });
  }
  return positions;
}

// TCRN-CROSS-SUB-414: one library crest event, checked against the device stream and file that
// hold it. Its metadata is checked for shape here; its links are checked against the chain once
// the records are merged (scanLibraryCrest), since only a card's current record is bound to them.
function validateLibraryCrestEvent(value: Readonly<Record<string, JsonValue>>, deviceId: string, filename: string, workspace: WorkspaceState): LibraryCrestEvent {
  const where = `${deviceId}/${filename}`;
  exactFields(value, ["schemaVersion", "deviceId", "sequence", "occurredAt", "priorHash", "chain", "replaces", "metadata", "body", "eventHash"], "crest event", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== CREST_EVENT_SCHEMA_VERSION || value.deviceId !== deviceId || !/^[a-f0-9]{32}$/u.test(deviceId) ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || typeof value.occurredAt !== "string" ||
    (value.priorHash !== null && (typeof value.priorHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.priorHash))) ||
    (value.replaces !== null && (typeof value.replaces !== "string" || !/^[a-f0-9]{64}$/u.test(value.replaces))) ||
    typeof value.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.eventHash) ||
    !Array.isArray(value.chain) || value.chain.length > CREST_EVENT_CHAIN_LIMIT ||
    value.metadata === null || typeof value.metadata !== "object" || Array.isArray(value.metadata) ||
    (value.body !== null && (typeof value.body !== "object" || Array.isArray(value.body)))) {
    fail("KNOWLEDGE_RECORD_INVALID", `${where}: event fields`);
  }
  validateChainPositions(value.chain, where);
  const sequenceText = String(Number(value.sequence)).padStart(8, "0");
  const metadata = validateMetadataShape(value.metadata as Readonly<Record<string, JsonValue>>, workspace, true);
  if (metadata.scope === "user" || value.occurredAt !== metadata.updatedAt || filename !== `${sequenceText}-${value.eventHash}.json`) {
    fail("KNOWLEDGE_RECORD_INVALID", `${where}: event binding`);
  }
  if (value.body === null) {
    // Only a retired record goes without a body: an older engine reclaimed it.
    if (metadata.lifecycle !== "retired") fail("KNOWLEDGE_RECORD_INVALID", `${where}: event binding`);
  } else {
    const bodyValue = value.body as Readonly<Record<string, JsonValue>>;
    exactFields(bodyValue, ["file", "sha256", "bytes"], "crest body reference", "KNOWLEDGE_RECORD_INVALID");
    if (!Number.isSafeInteger(bodyValue.bytes) || bodyValue.file !== `${sequenceText}-${metadata.bodySha256}.body` ||
      bodyValue.sha256 !== metadata.bodySha256 || bodyValue.bytes !== metadata.bodyBytes) {
      fail("KNOWLEDGE_RECORD_INVALID", `${where}: event binding`);
    }
  }
  try { assertStrictInstant(value.occurredAt); } catch { fail("KNOWLEDGE_RECORD_INVALID", `${where}: occurredAt`); }
  const { eventHash, ...unsigned } = value;
  if (canonicalSha256(unsigned as unknown as JsonValue) !== eventHash) fail("KNOWLEDGE_RECORD_INVALID", `${where}: event hash`);
  return value as unknown as LibraryCrestEvent;
}

// TCRN-CROSS-SUB-414 (STORY-476 D7, MIN-235 D7): a library's crest, read. Its records are the events
// every device appended to its own stream, crest/events/<device id>/, beside any metadata/body layout
// an engine before events left; this read merges them (projectCrestUnits) and projects the marker
// and this device's index view from them. Neither projection is authority, and nothing here writes
// the crest. The read answers at the chain head it replayed, so a chain write never leaves the crest
// behind; a record written against chain events this device has not received is named in
// `awaitingChain`, its card leaves default selection, and its links are checked once they arrive.
// R16 (C-R16-1): a live card whose project that chain no longer holds is named in
// `unresolvedScopes` and leaves default selection too, rather than refusing the whole crest.
async function scanLibraryCrest(
  workspace: WorkspaceState,
  workspaceRoot: string,
  storeRoot: string,
  options: KnowledgeReadOptions,
  allowClaim: boolean,
  bodyMode: "full" | "metadata-only",
  rebase: boolean,
): Promise<KnowledgeStoreScan> {
  const backend = storeBackendFor(storeRoot, options);
  // The marker first: a crest nobody initialized has none, and says so as it always did.
  const marker = validateMarker(parseCanonicalObject(await readCrestMarker(backend, storeRoot), "knowledge marker", "KNOWLEDGE_RECORD_INVALID"));
  const entries = (await readdir(storeRoot)).filter((entry) => !CREST_TEMP_NAME.test(entry));
  const hasMetadata = entries.includes("metadata");
  const hasBodies = entries.includes("bodies");
  const hasEvents = entries.includes(CREST_EVENTS_DIRECTORY);
  const expected = [
    "store.json",
    ...(hasMetadata && hasBodies ? ["bodies", "metadata"] : []),
    ...(hasEvents ? [CREST_EVENTS_DIRECTORY] : []),
    ...(allowClaim && entries.includes("mutation.claim") ? ["mutation.claim"] : []),
  ].sort(compareCanonicalText);
  if (hasMetadata !== hasBodies || JSON.stringify([...entries].sort(compareCanonicalText)) !== JSON.stringify(expected)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "knowledge store root entries are not exact");
  }
  if (!allowClaim && await claimPresence(storeRoot) === "present") fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is present");
  if (marker.workspaceId !== workspace.metadata.workspaceId) fail("KNOWLEDGE_HIGH_WATER_MISMATCH", marker.workspaceId);
  const legacyLayout = hasMetadata && hasBodies;
  const metadataRoot = legacyLayout ? await boundDirectory(resolve(storeRoot, "metadata"), storeRoot) : null;
  const bodiesRoot = legacyLayout ? await boundDirectory(resolve(storeRoot, "bodies"), storeRoot) : null;
  let legacyUnits: readonly CrestUnit[] = [];
  let legacyMissingBodies: readonly string[] = [];
  if (metadataRoot !== null && bodiesRoot !== null) {
    // Links are checked on the merged cards below, not on each stored record.
    const legacy = await scanStoreRecords(backend, { metadataRoot, bodiesRoot }, bodyMode, {
      shape: (value) => validateMetadataShape(value, workspace, true),
      links: null,
      danglingWorkLinks: null,
      body: (metadata, body) => validateMetadataBody(metadata, body, workspace),
      missingBodies: "deferred",
    });
    legacyUnits = legacy.units.map(metadataBodyLayoutUnit);
    legacyMissingBodies = legacy.missingBodies;
  }
  const reading: CrestStreamReading = {
    linkState: workspace,
    validate: (value, deviceId, filename) => validateLibraryCrestEvent(value, deviceId, filename, workspace),
    maximumEventBytes: CREST_EVENT_MAXIMUM_BYTES,
    library: true,
    hooks: options,
  };
  const streams = hasEvents ? await readCrestEventStreams(storeRoot, reading) : EMPTY_CREST_EVENT_STREAMS;
  // TCRN-CROSS-SUB-425: the removals the streams hold, and the supersessions, decide which cards are
  // removed; only then are the bodies admitted, since a removed card's may be cleared.
  const projection = projectCrestUnits([...legacyUnits, ...streams.units], streams.removals, workspace, true);
  const { removals, unresolvedConflicts } = projection;
  // TCRN-CROSS-SUB-425 R18: a removed card's record of the metadata/body layout may hold no body, since
  // knowledge-bodies-migrate --clear-removed clears it there; every other live record still holds its own.
  const unadmitted = legacyMissingBodies.find((id) => !removals.has(id));
  if (unadmitted !== undefined) fail("KNOWLEDGE_PARTIAL_STATE", `${unadmitted}:live record is missing its body`);
  const { admitted, streamBodies } = await admitCrestBodies(streams, removals, bodyMode, reading);
  const units = projection.units.map((unit) => withAdmittedBody(unit, admitted));
  const duplicates = projection.duplicates.map((duplicate) => ({ ...duplicate, versions: duplicate.versions.map((version) => withAdmittedBody(version, admitted)) }));
  const awaitingChain: AwaitingChainEntry[] = [];
  for (const unit of streams.units) {
    if (unit.chain === null || unit.event === null || chainHolds(workspace, unit.chain)) continue;
    awaitingChain.push({ id: unit.metadata.id, deviceId: unit.lineage, sequence: unit.event.sequence, eventHash: unit.event.eventHash });
  }
  awaitingChain.sort((left, right) => compareCanonicalText(left.id, right.id) || compareCanonicalText(left.deviceId, right.deviceId) || left.sequence - right.sequence);
  const awaitingIds = new Set(awaitingChain.map((entry) => entry.id));
  // TCRN-CROSS-SUB-413: the cards and every version of a duplicate. TCRN-CROSS-SUB-310 R17 (MIN-238
  // D1): however many body bytes the merged streams hold, the read answers; nothing sums them.
  const records = crestRecords({ units, duplicates });
  // WSC-2: the current record of each card is bound to the chain this read replayed. Rebase defers
  // scope/project liveness into the offender list; dangling work references are diagnostics.
  // TCRN-CROSS-SUB-414 (R16, C-R16-1): a project deleted after a card was written -- or by another
  // device before either received the other's write, when the deleting device could not see the
  // card -- no longer refuses every read and write of the crest. A live record whose project alone
  // no longer resolves is named in `unresolvedScopes`, and its card leaves default selection and
  // recall until a card supersedes it; a superseded one is not live, and is tolerated as a retired
  // one always was. The strict surfaces still refuse while one is named (assertScopesResolve, and
  // the rebase's offenders). A record whose scope contradicts itself is still refused.
  // TCRN-CROSS-SUB-425: a removed card is not live either: whatever project or work it named, it is
  // named in no `unresolvedScopes` and no `danglingWorkLinks`, and no rebase counts it an offender.
  const linkInvalid = new Set<string>();
  const unresolvedScopes: UnresolvedScopeEntry[] = [];
  const dangling = new Map<string, Set<string>>();
  for (const unit of records) {
    const { metadata } = unit;
    if (metadata.lifecycle === "retired" || awaitingIds.has(metadata.id)) continue;
    const removed = removals.has(metadata.id);
    const offence = scopeOffence(metadata, workspace);
    if (offence === "project") {
      if (isLiveRecord(metadata) && !removed) {
        unresolvedScopes.push({ id: metadata.id, ...recordIdentity(unit), projectId: metadata.projectId as string });
        if (rebase) linkInvalid.add(metadata.id);
      }
    } else if (offence === "shape") {
      if (!rebase) fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:scope`);
      linkInvalid.add(metadata.id);
    }
    if (removed) continue;
    const workIds = danglingLinkedWorkIds(metadata, workspace);
    if (workIds.length > 0) dangling.set(metadata.id, new Set([...(dangling.get(metadata.id) ?? []), ...workIds]));
  }
  // In canonical id order, and the records of one id in canonical writer order (a device id, or
  // `legacy` for the metadata/body layout), as a duplicate's versions are.
  unresolvedScopes.sort((left, right) => compareCanonicalText(left.id, right.id) ||
    compareCanonicalText(left.deviceId ?? USER_CREST_LEGACY_LINEAGE, right.deviceId ?? USER_CREST_LEGACY_LINEAGE) ||
    (left.sequence ?? 0) - (right.sequence ?? 0));
  const danglingWorkLinks = [...dangling]
    .map(([knowledgeId, workIds]) => ({ knowledgeId, workIds: [...workIds].sort(compareCanonicalText) }))
    .sort((left, right) => compareCanonicalText(left.knowledgeId, right.knowledgeId));
  // The marker a read answers: its version advanced by every event, its high water the chain head
  // this read was bound against. It is a projection, never persisted.
  const projectedMarker: KnowledgeStoreMarker = {
    ...marker,
    eventHighWaterDigest: workspace.headEventHash ?? marker.eventHighWaterDigest,
    version: marker.version + streams.eventCount,
  };
  const index = knowledgeIndex(projectedMarker, indexRecords(records.map((unit) => unit.metadata), removals));
  await projectKnowledgeView(libraryKnowledgeView(storeRoot, options), index);
  return {
    layout: "library", workspaceRoot, storeRoot, metadataRoot, bodiesRoot, viewsRoot: null, marker: projectedMarker, workspace, units, index,
    linkInvalid: [...linkInvalid].sort(compareCanonicalText),
    danglingWorkLinks,
    unresolvedConflicts, duplicates, awaitingChain, unresolvedScopes, eventHeads: streams.heads,
    removals, streamBodies,
  };
}

// ---- TCRN-CROSS-STORY-476 R13 (MIN-235 D7): the user crest ----
//
// One knowledge store per person rather than per library: the card a writer files with scope
// "user" is recalled in every project. Its static root marker binds USER_CREST_ID; each device
// appends immutable metadata/body events under its own stream. Reads derive combined heads and
// this device's cache index from those streams; neither projection is authority. A card names no
// project, role or work (validateUserCrestLinks). Its place is the device-level key crest.userPath,
// which may be a cloud folder, or `crest` in the device directory. This device's lock serializes
// only local operations; independent devices never replace one another's event files.

interface UserCrestLocation {
  readonly device: string;
  readonly root: string;
  // crest.userPath named the place: the folder that holds it is then never created here, so a
  // cloud folder that is not mounted is refused rather than replaced by a local one.
  readonly configured: boolean;
}

async function locateUserCrest(): Promise<UserCrestLocation> {
  const device = deviceHome();
  const root = await readUserCrestPath(device);
  return { device, root, configured: root !== userCrestPath({}, device) };
}

// This device's view of the user crest, in its cache.
function userCrestKnowledgeView(storeRoot: string, device: string, options: KnowledgeReadOptions = {}): KnowledgeViewPlace {
  const folder = join(userCrestCachePath(device), KNOWLEDGE_CACHE_VIEWS_DIRECTORY);
  const located = async (): Promise<string | null> => folder;
  return { folder: located, file: (name) => knowledgeViewFileBackend(storeRoot, options, located, name) };
}

function userCrestBackend(storeRoot: string, device: string, options: KnowledgeReadOptions = {}): StoreBackend {
  return userCrestKnowledgeView(storeRoot, device, options).file(KNOWLEDGE_VIEW_FILE);
}

/** Run a read or a write of the user crest under this machine's lock of it. */
async function withUserCrestLock<T>(location: UserCrestLocation, operation: () => Promise<T>): Promise<T> {
  const path = userCrestLockPath(location.device);
  await ensureDeviceDirectory(dirname(path));
  try {
    return await withFileLock(path, operation);
  } catch (error) {
    if (error instanceof FileLockError && error.reasonCode === "FILE_LOCK_TIMEOUT") {
      fail("KNOWLEDGE_LOCKED", "another process on this machine holds the user crest lock");
    }
    throw error;
  }
}

// The user crest exists from its first card on. Before that its place is absent, or an empty
// folder made ready for it, and a read answers with nothing rather than failing. Anything else in
// its place -- a link, a file, a folder of other things -- is left for the scan to name.
async function userCrestInitialized(root: string): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    fail("KNOWLEDGE_PATH_INVALID", `${root}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (!entry.isDirectory()) return true;
  return (await readdir(root)).length > 0;
}

// The folder that holds the user crest, as a real path, so the crest's own place can be checked
// to sit in it and not to be a link (boundDirectory). Only the device directory is created.
async function userCrestParent(location: UserCrestLocation, create: boolean): Promise<string> {
  const parent = dirname(location.root);
  if (create && !location.configured) await ensureDeviceDirectory(parent);
  try {
    return await realpath(parent);
  } catch (error) {
    fail("KNOWLEDGE_PATH_INVALID", `${parent}:${String((error as { code?: string }).code ?? error)}`);
  }
}

// The streams of a crest as a first pass reads them: every card record with the body file its event
// names, unread (admitCrestBodies reads and checks the bodies once the removed cards are known), and
// every removal event, each in its stream's order.
interface CrestEventStreams {
  readonly units: readonly CrestUnit[];
  readonly removals: readonly CrestRemovalEvent[];
  readonly eventCount: number;
  readonly heads: readonly CrestEventHead[];
}

const EMPTY_CREST_EVENT_STREAMS: CrestEventStreams = Object.freeze({ units: [], removals: [], eventCount: 0, heads: [] });

// One crest event as its stream holds it, whichever crest: the user crest's (validateUserCrestEvent)
// or a library's (validateLibraryCrestEvent), whose records can replace one another and carry the
// chain they were written against.
interface ValidatedCrestEvent {
  readonly sequence: number;
  readonly eventHash: string;
  readonly priorHash: string | null;
  readonly metadata: KnowledgeUnitMetadata;
  readonly body: { readonly file: string; readonly sha256: string; readonly bytes: number } | null;
  readonly replaces: string | null;
  readonly chain: readonly ChainPosition[] | null;
}

// One file of a crest event stream, read through a no-follow descriptor bound to the file it
// names. `hooks` are the descriptor-read observation seams a read's options carry, as the store
// backend honours them for the metadata/body layout.
async function readUserCrestFile(path: string, maximumBytes: number, hooks: KnowledgeReadOptions = {}): Promise<Buffer> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    fail("KNOWLEDGE_PARTIAL_STATE", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  before = await settleCrestPublication(path, before);
  if (before.size > BigInt(maximumBytes)) fail("KNOWLEDGE_LIMIT_EXCEEDED", path);
  await hooks.beforeDescriptorReadForTest?.(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened) || opened.size > BigInt(maximumBytes)) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    await hooks.afterDescriptorOpenForTest?.(path);
    const bounded = Buffer.alloc(Number(opened.size));
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximumBytes) fail("KNOWLEDGE_LIMIT_EXCEEDED", path);
    const bytes = Buffer.from(bounded.subarray(0, bytesRead));
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (after.nlink !== 1n || named.nlink !== 1n || !named.isFile() || named.isSymbolicLink() ||
      after.size > BigInt(maximumBytes) || !sameCrestBytes(opened, after) || !sameCrestBytes(opened, named) ||
      opened.ctimeNs !== after.ctimeNs || opened.ctimeNs !== named.ctimeNs || BigInt(bytes.length) !== after.size) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    return bytes;
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    return fail("KNOWLEDGE_PATH_INVALID", `${path}:${String((error as { code?: string }).code ?? error)}`);
  } finally {
    await handle?.close();
  }
}

async function assertUserCrestBodyReference(path: string, expectedBytes: number): Promise<void> {
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    fail("KNOWLEDGE_PARTIAL_STATE", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  stats = await settleCrestPublication(path, stats);
  if (stats.size !== BigInt(expectedBytes)) fail("KNOWLEDGE_PARTIAL_STATE", `${path}:body reference size`);
}

function validateUserCrestEvent(value: Readonly<Record<string, JsonValue>>, deviceId: string, filename: string): UserCrestEvent {
  exactFields(value, ["schemaVersion", "deviceId", "sequence", "occurredAt", "priorHash", "metadata", "body", "eventHash"], "user crest event", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== USER_CREST_EVENT_SCHEMA_VERSION || value.deviceId !== deviceId || !/^[a-f0-9]{32}$/u.test(deviceId) ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || typeof value.occurredAt !== "string" ||
    (value.priorHash !== null && (typeof value.priorHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.priorHash))) ||
    typeof value.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.eventHash) ||
    value.metadata === null || typeof value.metadata !== "object" || Array.isArray(value.metadata) ||
    value.body === null || typeof value.body !== "object" || Array.isArray(value.body)) {
    fail("KNOWLEDGE_RECORD_INVALID", `${deviceId}/${filename}: event fields`);
  }
  const sequence = Number(value.sequence);
  const bodyValue = value.body as Readonly<Record<string, JsonValue>>;
  exactFields(bodyValue, ["file", "sha256", "bytes"], "user crest body reference", "KNOWLEDGE_RECORD_INVALID");
  const metadata = validateMetadataShape(value.metadata as Readonly<Record<string, JsonValue>>, null);
  const bodyFile = `${String(sequence).padStart(8, "0")}-${metadata.bodySha256}.body`;
  if (!Number.isSafeInteger(bodyValue.bytes) || Number(bodyValue.bytes) < 0 || metadata.scope !== "user" || value.occurredAt !== metadata.updatedAt || bodyValue.file !== bodyFile ||
    bodyValue.sha256 !== metadata.bodySha256 || bodyValue.bytes !== metadata.bodyBytes ||
    typeof value.eventHash !== "string" || filename !== `${String(sequence).padStart(8, "0")}-${value.eventHash}.json`) {
    fail("KNOWLEDGE_RECORD_INVALID", `${deviceId}/${filename}: event binding`);
  }
  try { assertStrictInstant(value.occurredAt); } catch { fail("KNOWLEDGE_RECORD_INVALID", `${deviceId}/${filename}: occurredAt`); }
  const { eventHash, ...unsigned } = value;
  if (canonicalSha256(unsigned as unknown as JsonValue) !== eventHash) {
    fail("KNOWLEDGE_RECORD_INVALID", `${deviceId}/${filename}: event hash`);
  }
  return value as unknown as UserCrestEvent;
}

// TCRN-CROSS-SUB-425: the bounded sentence a removal gives as its basis.
function assertRemovalBasis(value: unknown, label: string, reasonCode: KnowledgeReasonCode): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > KNOWLEDGE_REMOVAL_BASIS_BYTES ||
    !value.isWellFormed()) {
    fail(reasonCode, label);
  }
}

// TCRN-CROSS-SUB-425 (MIN-239 D3, D4): one removal event, checked against the device stream and file
// that hold it, whichever crest: its reason, basis, actor and the card that superseded the one it
// removes (named for the reason "superseded" and for no other). The card it removes need not be
// delivered yet: the removal waits for it (projectRemovals).
function validateCrestRemovalEvent(value: Readonly<Record<string, JsonValue>>, deviceId: string, filename: string): CrestRemovalEvent {
  const where = `${deviceId}/${filename}`;
  exactFields(value, ["schemaVersion", "deviceId", "sequence", "occurredAt", "priorHash", "removal", "eventHash"], "crest removal event", "KNOWLEDGE_RECORD_INVALID");
  if (value.schemaVersion !== CREST_REMOVAL_SCHEMA_VERSION || value.deviceId !== deviceId || !/^[a-f0-9]{32}$/u.test(deviceId) ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || typeof value.occurredAt !== "string" ||
    (value.priorHash !== null && (typeof value.priorHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.priorHash))) ||
    typeof value.eventHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.eventHash) ||
    filename !== `${String(Number(value.sequence)).padStart(8, "0")}-${value.eventHash}.json`) {
    fail("KNOWLEDGE_RECORD_INVALID", `${where}: removal event fields`);
  }
  exactFields(value.removal, ["id", "reason", "basis", "actor", "supersededBy"], "crest removal", "KNOWLEDGE_RECORD_INVALID");
  const removal = value.removal as Readonly<Record<string, JsonValue>>;
  if (typeof removal.id !== "string" || !knowledgeIdPattern.test(removal.id) ||
    typeof removal.reason !== "string" || !(KNOWLEDGE_REMOVAL_REASONS as readonly string[]).includes(removal.reason) ||
    (removal.supersededBy !== null && (typeof removal.supersededBy !== "string" || !knowledgeIdPattern.test(removal.supersededBy) || removal.supersededBy === removal.id)) ||
    (removal.reason === "superseded") !== (removal.supersededBy !== null)) {
    fail("KNOWLEDGE_RECORD_INVALID", `${where}: removal`);
  }
  assertRemovalBasis(removal.basis, `${where}: removal basis`, "KNOWLEDGE_RECORD_INVALID");
  try { assertActorId(removal.actor); } catch { fail("KNOWLEDGE_RECORD_INVALID", `${where}: removal actor`); }
  try { assertStrictInstant(value.occurredAt); } catch { fail("KNOWLEDGE_RECORD_INVALID", `${where}: occurredAt`); }
  const { eventHash, ...unsigned } = value;
  if (canonicalSha256(unsigned as unknown as JsonValue) !== eventHash) fail("KNOWLEDGE_RECORD_INVALID", `${where}: event hash`);
  return value as unknown as CrestRemovalEvent;
}

// How one crest's event streams are read. The user crest (TCRN-CROSS-SUB-310) admits only regular
// files into a stream and checks every event's body file, whatever the read. A library's crest
// (TCRN-CROSS-SUB-414) reads its streams as its metadata/body layout was always read: a
// metadata-first surface checks only that the stream names an event's body and never touches the
// file, and a full read or an explicit body read refuses a link or a special file where it finds one
// (KNOWLEDGE_LINK_UNSAFE, KNOWLEDGE_SPECIAL_FILE).
interface CrestStreamReading {
  // What a body is checked against: a library's state, or null for the user crest.
  readonly linkState: WorkspaceState | null;
  readonly validate: (value: Readonly<Record<string, JsonValue>>, deviceId: string, filename: string) => ValidatedCrestEvent;
  readonly maximumEventBytes: number;
  readonly library: boolean;
  // The read's descriptor observation seams.
  readonly hooks: KnowledgeReadOptions;
}

// A file of a library crest's stream: a special file in a body's or an event's place is named as
// one before the descriptor read, which refuses a link.
async function readLibraryCrestFile(path: string, maximumBytes: number, hooks: KnowledgeReadOptions): Promise<Buffer> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    fail("KNOWLEDGE_PARTIAL_STATE", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (!stats.isSymbolicLink() && !stats.isFile()) fail("KNOWLEDGE_SPECIAL_FILE", path);
  return readUserCrestFile(path, maximumBytes, hooks);
}

// A file of a crest's stream, read the way that crest reads its streams (CrestStreamReading).
function crestFileReader(reading: CrestStreamReading): (path: string, maximumBytes: number) => Promise<Buffer> {
  return (path, maximumBytes) => reading.library
    ? readLibraryCrestFile(path, maximumBytes, reading.hooks)
    : readUserCrestFile(path, maximumBytes, reading.hooks);
}

// Every device stream of a crest's events/ directory, in each stream's own order: a stream is a
// chain of events from sequence 1, each naming the previous one's hash, and each card event's body is
// a file of the same stream written before it. A body no event names is an interrupted write's and
// is ignored. TCRN-CROSS-SUB-425: an event is a card's record or a removal (validateCrestRemovalEvent),
// and this first pass reads the events alone: whether each body the events name is still in its
// stream is noted here and judged by admitCrestBodies, once the removed cards -- whose bodies a device
// clears from its own stream -- are known.
async function readCrestEventStreams(storeRoot: string, reading: CrestStreamReading): Promise<CrestEventStreams> {
  const eventsPath = userCrestEventsPath(storeRoot);
  try {
    await lstat(eventsPath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return EMPTY_CREST_EVENT_STREAMS;
    fail("KNOWLEDGE_PATH_INVALID", `${eventsPath}:${String((error as { code?: string }).code ?? error)}`);
  }
  const eventsRoot = await boundDirectory(eventsPath, storeRoot);
  const readFileOf = crestFileReader(reading);
  const units: CrestUnit[] = [];
  const removals: CrestRemovalEvent[] = [];
  const heads: CrestEventHead[] = [];
  let eventCount = 0;
  const deviceEntries = await readdir(eventsRoot, { withFileTypes: true });
  for (const entry of deviceEntries) {
    if (isAtomicTemporaryName(entry.name)) continue;
    if (!/^[a-f0-9]{32}$/u.test(entry.name) || !entry.isDirectory()) {
      fail("KNOWLEDGE_PARTIAL_STATE", `${eventsPath}: unexpected entry ${entry.name}`);
    }
    const deviceId = entry.name;
    const streamRoot = await boundDirectory(resolve(eventsRoot, deviceId), eventsRoot);
    const streamEntries = await readdir(streamRoot, { withFileTypes: true });
    const files: { readonly name: string; readonly sequence: number; readonly eventHash: string }[] = [];
    const bodyNames = new Set<string>();
    for (const streamEntry of streamEntries) {
      if (isAtomicTemporaryName(streamEntry.name)) continue;
      const admitted = reading.library || streamEntry.isFile();
      const eventMatch = CREST_EVENT_FILE_PATTERN.exec(streamEntry.name);
      if (eventMatch !== null && admitted) {
        files.push({ name: streamEntry.name, sequence: Number(eventMatch[1]), eventHash: eventMatch[2] as string });
        continue;
      }
      if (CREST_BODY_FILE_PATTERN.test(streamEntry.name) && admitted) {
        bodyNames.add(streamEntry.name);
        continue;
      }
      fail("KNOWLEDGE_PARTIAL_STATE", `${eventsPath}/${deviceId}: unexpected entry ${streamEntry.name}`);
    }
    files.sort((left, right) => left.sequence - right.sequence || compareCanonicalText(left.name, right.name));
    let priorHash: string | null = null;
    for (const [index, file] of files.entries()) {
      if (file.sequence !== index + 1) {
        fail("KNOWLEDGE_PARTIAL_STATE", `${deviceId}: event stream has a gap or fork at sequence ${index + 1}`);
      }
      const eventPath = resolve(streamRoot, file.name);
      const value = parseCanonicalObject(await readFileOf(eventPath, reading.maximumEventBytes), "crest event", "KNOWLEDGE_RECORD_INVALID");
      if (value.schemaVersion === CREST_REMOVAL_SCHEMA_VERSION) {
        const removal = validateCrestRemovalEvent(value, deviceId, file.name);
        if (removal.sequence !== file.sequence || removal.eventHash !== file.eventHash || removal.priorHash !== priorHash) {
          fail("KNOWLEDGE_PARTIAL_STATE", `${deviceId}: event chain breaks at sequence ${file.sequence}`);
        }
        removals.push(removal);
        priorHash = removal.eventHash;
        eventCount += 1;
        continue;
      }
      const event = reading.validate(value, deviceId, file.name);
      if (event.sequence !== file.sequence || event.eventHash !== file.eventHash || event.priorHash !== priorHash) {
        fail("KNOWLEDGE_PARTIAL_STATE", `${deviceId}: event chain breaks at sequence ${file.sequence}`);
      }
      const streamBody: StreamBodyReference | null = event.body === null
        ? null
        : { path: resolve(streamRoot, event.body.file), file: event.body.file, bytes: event.body.bytes, present: bodyNames.has(event.body.file) };
      units.push({
        metadataPath: eventPath,
        bodyPath: streamBody?.path ?? eventPath,
        metadata: event.metadata,
        body: null,
        readBody: async () => fail("KNOWLEDGE_RECORD_INVALID", `${event.metadata.id}:body was not admitted`),
        lineage: deviceId,
        event: { sequence: event.sequence, eventHash: event.eventHash },
        replaces: event.replaces,
        chain: event.chain,
        storedDigest: recordDigest(event.metadata),
        streamBody,
      });
      priorHash = event.eventHash;
      eventCount += 1;
    }
    if (files.length > 0) {
      const last = files.at(-1) as { readonly sequence: number; readonly eventHash: string };
      heads.push({ deviceId, sequence: last.sequence, eventHash: last.eventHash });
    }
  }
  heads.sort((left, right) => compareCanonicalText(left.deviceId, right.deviceId));
  return { units, removals, eventCount, heads };
}

// Where a stream record sits: its device and sequence.
function streamRecordKey(lineage: string, sequence: number): string {
  return `${lineage}\u0000${sequence}`;
}

// What the second pass admits for one stream record: its body as the read's mode reads it, and how an
// explicit read opens it.
interface AdmittedStreamBody {
  readonly body: Buffer | null;
  readonly readBody: () => Promise<Buffer>;
}

// TCRN-CROSS-SUB-425: the second pass over a crest's streams. Every record of a card that is not
// removed must still find the body its event names, as every record always had to: a metadata-first
// read checks that the stream holds it (and, for the user crest, its size), and a full read reads and
// binds it. A removed card's records need not: its bodies are cleared, device by device, and none is
// read; an explicit read of one is refused (KNOWLEDGE_CARD_REMOVED). Also answered: every body file
// the streams name, with its card and device, for the writer that clears its own (clearRemovedBodies).
async function admitCrestBodies(
  streams: CrestEventStreams,
  removed: ReadonlyMap<string, CrestRemoval>,
  bodyMode: "full" | "metadata-only",
  reading: CrestStreamReading,
): Promise<{ readonly admitted: ReadonlyMap<string, AdmittedStreamBody>; readonly streamBodies: readonly CrestStreamBody[] }> {
  const readFileOf = crestFileReader(reading);
  const admitted = new Map<string, AdmittedStreamBody>();
  const streamBodies: CrestStreamBody[] = [];
  for (const unit of streams.units) {
    if (unit.event === null) continue;
    const key = streamRecordKey(unit.lineage, unit.event.sequence);
    const id = unit.metadata.id;
    const reference = unit.streamBody;
    if (reference !== null) streamBodies.push({ id, deviceId: unit.lineage, path: reference.path, present: reference.present });
    if (removed.has(id)) {
      admitted.set(key, { body: null, readBody: async () => fail("KNOWLEDGE_CARD_REMOVED", id) });
      continue;
    }
    if (reference === null) continue;
    if (!reference.present) fail("KNOWLEDGE_PARTIAL_STATE", `${unit.lineage}/${basename(unit.metadataPath)}: body reference is missing`);
    if (!reading.library) await assertUserCrestBodyReference(reference.path, reference.bytes);
    const body = bodyMode === "full" ? await readFileOf(reference.path, KNOWLEDGE_LIMITS.maximumBodyBytes) : null;
    if (body !== null) validateMetadataBody(unit.metadata, body, reading.linkState);
    admitted.set(key, { body, readBody: async () => readFileOf(reference.path, KNOWLEDGE_LIMITS.maximumBodyBytes) });
  }
  return { admitted, streamBodies };
}

// A projected record with what the second pass admitted for it: its body and body reader.
function withAdmittedBody(unit: CrestUnit, admitted: ReadonlyMap<string, AdmittedStreamBody>): CrestUnit {
  if (unit.event === null) return unit;
  const entry = admitted.get(streamRecordKey(unit.lineage, unit.event.sequence));
  return entry === undefined ? unit : { ...unit, body: entry.body, readBody: entry.readBody };
}

interface CrestProjection {
  readonly units: readonly CrestUnit[];
  readonly unresolvedConflicts: readonly (readonly string[])[];
  readonly duplicates: readonly CrestDuplicate[];
  readonly removals: ReadonlyMap<string, CrestRemoval>;
}

// Of two removals of one card, the one that stands: the earlier, then one an event holds before one a
// supersession derives, then the event's device and sequence in canonical order.
function compareRemovals(left: CrestRemoval, right: CrestRemoval): number {
  const leftAt = parseStrictInstant(left.removedAt);
  const rightAt = parseStrictInstant(right.removedAt);
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  if ((left.deviceId === null) !== (right.deviceId === null)) return left.deviceId === null ? 1 : -1;
  return compareCanonicalText(left.deviceId ?? "", right.deviceId ?? "") || (left.sequence ?? 0) - (right.sequence ?? 0);
}

// TCRN-CROSS-SUB-425 (MIN-239 D3, D4; C-R17-3): the removed cards of a crest and the removal each one
// carries. A removal event removes the card it names: a card this crest holds, or the versions of an
// id two writers wrote (every version at once); one naming a card not delivered yet waits for it, as a
// card whose supersedes names a card not delivered yet does. A card another card supersedes is removed
// by that supersession -- conflict superseded -- the id of a duplicate once every version is
// superseded; the mark an older engine stored counts as the supersession it recorded. A record an
// older engine retired and no card superseded is read as its engine left it. Of several removals of
// one card, from devices that each removed it before either saw the other's, the earliest stands; it
// is terminal either way.
function projectRemovals(cards: readonly CrestUnit[], duplicates: readonly CrestDuplicate[], events: readonly CrestRemovalEvent[]): ReadonlyMap<string, CrestRemoval> {
  const held = new Map<string, readonly CrestUnit[]>();
  for (const unit of cards) held.set(unit.metadata.id, [unit]);
  for (const duplicate of duplicates) held.set(duplicate.id, duplicate.versions);
  const candidates = new Map<string, CrestRemoval[]>();
  const add = (removal: CrestRemoval): void => {
    candidates.set(removal.id, [...(candidates.get(removal.id) ?? []), removal]);
  };
  for (const event of events) {
    if (!held.has(event.removal.id)) continue;
    add({
      id: event.removal.id, reason: event.removal.reason, basis: event.removal.basis, actor: event.removal.actor,
      removedAt: event.occurredAt, supersededBy: event.removal.supersededBy,
      deviceId: event.deviceId, sequence: event.sequence, eventHash: event.eventHash,
    });
  }
  for (const [id, records] of held) {
    const successorId = (records[0] as CrestUnit).metadata.extensions.supersededBy;
    if (successorId === undefined || records.some((record) => record.metadata.extensions.supersededBy === undefined)) continue;
    const successor = held.get(successorId)?.[0];
    add({
      id, reason: "superseded", basis: `superseded by ${successorId}`, actor: successor?.metadata.accountableOwnerId ?? null,
      removedAt: (records[0] as CrestUnit).metadata.updatedAt, supersededBy: successorId,
      deviceId: null, sequence: null, eventHash: null,
    });
  }
  const removals = new Map<string, CrestRemoval>();
  for (const [id, list] of candidates) removals.set(id, [...list].sort(compareRemovals)[0] as CrestRemoval);
  return removals;
}

// The removal a card that supersedes `id` makes of it, as the next read derives it (projectRemovals).
function supersessionRemoval(id: string, successor: KnowledgeUnitMetadata): CrestRemoval {
  return {
    id, reason: "superseded", basis: `superseded by ${successor.id}`, actor: successor.accountableOwnerId,
    removedAt: successor.updatedAt, supersededBy: successor.id, deviceId: null, sequence: null, eventHash: null,
  };
}

// Of the cards that replace one card, the one its projected supersededBy names: the latest
// written, and of those written at one instant the last in canonical id order.
function latestReplacement(replacements: readonly CrestUnit[]): CrestUnit {
  return [...replacements].sort((left, right) => {
    const leftAt = parseStrictInstant(left.metadata.updatedAt);
    const rightAt = parseStrictInstant(right.metadata.updatedAt);
    return leftAt === rightAt ? compareCanonicalText(left.metadata.id, right.metadata.id) : leftAt < rightAt ? -1 : 1;
  }).at(-1) as CrestUnit;
}

// The order records of one id are merged in: by writer (canonical, so the metadata/body layout's
// `legacy` comes after every device id), and a writer's own records in the order it wrote them.
function compareCrestRecords(left: CrestUnit, right: CrestUnit): number {
  return compareCanonicalText(left.lineage, right.lineage) || (left.event?.sequence ?? 0) - (right.event?.sequence ?? 0);
}

// TCRN-CROSS-SUB-310 (MIN-235 D7; R14 (a)): a crest's cards, merged from every writer. A shared
// folder can deliver one device's events after another device has already written: two cards about
// one thing then stand side by side although neither writer saw the other, which the write-time
// conflict check exists to refuse. Such a pair is not a reason to refuse the whole crest: it is
// returned as an unresolved conflict, and only its two cards leave default selection. A pair counts
// only when its cards were first written by different writers and neither acknowledges the other:
// one writer scans before it writes, so the conflicts it saw were refused, or recorded in the new
// card's coexistsWith (--coexist, or beside a card it supersedes). A write that supersedes either
// card resolves the pair. A card replaced by more than one card -- two devices that replaced it
// before either saw the other's replacement -- is replaced either way; every replacement stays
// live, and replacements that collide form an unresolved pair like any other.
//
// TCRN-CROSS-SUB-413 (STORY-476 D7): two writers can also write one external key, and so one id,
// before either sees the other's. That is not a reason to refuse the crest either. The records are
// grouped by id: one record delivered twice, or written the same by two writers, is one record; a
// writer that writes a second record for an id without replacing its first is refused, since one
// writer scans before it writes and a stream like that is not one this engine writes; and differing
// records from different writers that neither replaced are the versions of a duplicate, held apart
// from the cards (CrestDuplicate). Each version's own supersedes still replaces the card it names,
// and a card whose supersedes names the duplicate's id replaces every version. Versions are not
// paired: they are withheld already.
//
// TCRN-CROSS-SUB-414 (STORY-476 D7): a library crest's card can be written again -- re-verified,
// re-policied, its article refreshed -- as a new record naming the stored record it replaces. A
// writer's latest record of an id stands for all its earlier ones; of the writers' latest records,
// the ones no other record replaces are the card's current records: one is the card, more than one
// a duplicate, so two devices that each rewrote one card before either saw the other's rewrite hold
// both rewrites as versions and lose neither. A library crest event whose supersedes names a card
// not delivered yet is admitted (`toleratePendingSupersedes`): the card is replaced when it arrives.
// `linkState` is what a projected record is checked against: null for the user crest, whose cards
// are checked against the card alone; a library's state, whose links the caller checks after the merge.
//
// TCRN-CROSS-SUB-425 (MIN-239 D3, D4): the removal events of every stream remove the cards they name,
// and a card another card supersedes is removed by it (projectRemovals). A removed card is in no
// unresolved pair, and a duplicate whose id is removed is resolved.
function projectCrestUnits(
  units: readonly CrestUnit[],
  removalEvents: readonly CrestRemovalEvent[],
  linkState: WorkspaceState | null,
  toleratePendingSupersedes: boolean,
): CrestProjection {
  const written = new Map<string, CrestUnit[]>();
  for (const unit of units) written.set(unit.metadata.id, [...(written.get(unit.metadata.id) ?? []), unit]);
  const byId = new Map<string, CrestUnit>();
  const divergent = new Map<string, readonly CrestUnit[]>();
  // The writer that first wrote each card: the one whose record replaces nothing.
  const origins = new Map<string, string>();
  for (const [id, records] of written) {
    const distinct: CrestUnit[] = [];
    for (const unit of [...records].sort(compareCrestRecords)) {
      if (distinct.some((kept) => kept.storedDigest === unit.storedDigest)) continue;
      distinct.push(unit);
    }
    const latest = new Map<string, CrestUnit>();
    for (const unit of distinct) {
      if (latest.has(unit.lineage) && unit.replaces === null) {
        fail("KNOWLEDGE_PARTIAL_STATE", `${id}: writer ${unit.lineage} holds conflicting events for one knowledge id`);
      }
      latest.set(unit.lineage, unit);
    }
    const replaced = new Set(distinct.flatMap((unit) => unit.replaces === null ? [] : [unit.replaces]));
    const current = [...latest.values()].filter((unit) => !replaced.has(unit.storedDigest));
    if (current.length === 0) fail("KNOWLEDGE_PARTIAL_STATE", `${id}: its records replace one another`);
    origins.set(id, (distinct.find((unit) => unit.replaces === null) ?? current[0] as CrestUnit).lineage);
    if (current.length === 1) byId.set(id, current[0] as CrestUnit);
    else divergent.set(id, current);
  }
  const replacements = new Map<string, CrestUnit[]>();
  // The stored records whose supersedes names a card not delivered yet.
  const pendingSupersedes = new Set<string>();
  for (const unit of [...byId.values(), ...[...divergent.values()].flat()]) {
    if (unit.metadata.supersedes === null) continue;
    if (!byId.has(unit.metadata.supersedes) && !divergent.has(unit.metadata.supersedes)) {
      if (toleratePendingSupersedes && unit.event !== null) {
        pendingSupersedes.add(unit.storedDigest);
        continue;
      }
      fail("KNOWLEDGE_LINK_INVALID", `${unit.metadata.id}:supersedes:${unit.metadata.supersedes}`);
    }
    replacements.set(unit.metadata.supersedes, [...(replacements.get(unit.metadata.supersedes) ?? []), unit]);
  }
  const projectReplaced = (unit: CrestUnit): CrestUnit => {
    const successors = replacements.get(unit.metadata.id);
    // A card whose own record already carries the mark keeps the mark it was written with.
    if (successors === undefined || unit.metadata.extensions.supersededBy !== undefined) return unit;
    const successor = latestReplacement(successors);
    const replacedMetadata: KnowledgeUnitMetadata = {
      ...unit.metadata,
      extensions: { ...unit.metadata.extensions, supersededBy: successor.metadata.id },
      revision: unit.metadata.revision + 1,
      updatedAt: successor.metadata.updatedAt,
    };
    const metadata = linkState === null
      ? validateExistingMetadataShape(replacedMetadata, null)
      : validateMetadataShape(replacedMetadata as unknown as Readonly<Record<string, JsonValue>>, linkState, true);
    return { ...unit, metadata };
  };
  const projected = [...byId.values()].map(projectReplaced)
    .sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  const duplicates = [...divergent].map(([id, versions]): CrestDuplicate => ({
    id,
    externalKey: (versions[0] as CrestUnit).metadata.externalKey,
    versions: versions.map(projectReplaced),
  })).sort((left, right) => compareCanonicalText(left.id, right.id));
  const byProjectedId = new Map(projected.map((unit) => [unit.metadata.id, unit.metadata]));
  for (const duplicate of duplicates) byProjectedId.set(duplicate.id, (duplicate.versions[0] as CrestUnit).metadata);
  for (const unit of [...projected, ...duplicates.flatMap((duplicate) => duplicate.versions)]) {
    if (!pendingSupersedes.has(unit.storedDigest)) validateSupersedesLink(unit.metadata, byProjectedId);
  }
  const removals = projectRemovals(projected, duplicates, removalEvents);
  const live = (unit: CrestUnit): boolean => isLiveRecord(unit.metadata) && !removals.has(unit.metadata.id);
  const unresolvedConflicts: (readonly string[])[] = [];
  for (let leftIndex = 0; leftIndex < projected.length; leftIndex += 1) {
    const left = projected[leftIndex] as CrestUnit;
    if (!live(left)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < projected.length; rightIndex += 1) {
      const right = projected[rightIndex] as CrestUnit;
      if (!live(right) || origins.get(left.metadata.id) === origins.get(right.metadata.id)) continue;
      const conflicts = knowledgeConflictHits([left.metadata], right.metadata.subject, [right.metadata.id]).length > 0 ||
        knowledgeConflictHits([right.metadata], left.metadata.subject, [left.metadata.id]).length > 0;
      const acknowledged = left.metadata.extensions.coexistsWith?.includes(right.metadata.id) === true ||
        right.metadata.extensions.coexistsWith?.includes(left.metadata.id) === true;
      if (conflicts && !acknowledged) unresolvedConflicts.push([left.metadata.id, right.metadata.id]);
    }
  }
  return { units: projected, unresolvedConflicts, duplicates, removals };
}

// The ids of the cards an unresolved conflict holds out of default selection.
function unresolvedConflictIds(scan: Pick<CrestScan, "unresolvedConflicts">): ReadonlySet<string> {
  return new Set(scan.unresolvedConflicts.flat());
}

// TCRN-CROSS-SUB-413: a duplicate is unresolved while one of its versions is still live -- not
// replaced and not retired. A card whose supersedes names its id resolves it; TCRN-CROSS-SUB-425: so
// does a removal of its id, which removes every version.
function unresolvedDuplicates(scan: Pick<CrestScan, "duplicates" | "removals">): readonly CrestDuplicate[] {
  return scan.duplicates.filter((duplicate) => !scan.removals.has(duplicate.id) &&
    duplicate.versions.some((version) => isLiveRecord(version.metadata)));
}

// TCRN-CROSS-SUB-425: what one removal says, as a removed card, a refusal naming one and a list carry
// it: why, on what basis, by whom and when, the card that superseded it, and the event that holds it
// (all three null for a removal a supersession derives).
function removalDiagnostic(removal: CrestRemoval): Readonly<Record<string, JsonValue>> {
  return {
    reason: removal.reason,
    basis: removal.basis,
    actor: removal.actor,
    removedAt: removal.removedAt,
    supersededBy: removal.supersededBy,
    deviceId: removal.deviceId,
    sequence: removal.sequence,
    eventHash: removal.eventHash,
  };
}

// A removed card as it is kept: its id, external key and subject (of its first record, in canonical
// writer order, for an id two writers wrote), the supersession its own record named, and its removal.
function removedCardRecord(metadata: KnowledgeUnitMetadata, removal: CrestRemoval): RemovedCardRecord {
  return {
    id: metadata.id,
    externalKey: metadata.externalKey,
    subject: metadata.subject,
    status: "removed",
    removal: removalDiagnostic(removal),
    ...(metadata.supersedes === null ? {} : { supersedes: metadata.supersedes }),
  };
}

// TCRN-CROSS-SUB-425: the records of a crest's index, in canonical id order: every valid card's
// metadata (a duplicate's versions each as its own record, as before) and one record per removed
// card, as it is kept. `records` are a crest's records in that order (crestRecords).
function indexRecords(records: readonly KnowledgeUnitMetadata[], removals: ReadonlyMap<string, CrestRemoval>): readonly KnowledgeIndexRecord[] {
  const indexed: KnowledgeIndexRecord[] = [];
  const kept = new Set<string>();
  for (const metadata of records) {
    const removal = removals.get(metadata.id);
    if (removal === undefined) {
      indexed.push(metadata);
    } else if (!kept.has(metadata.id)) {
      kept.add(metadata.id);
      indexed.push(removedCardRecord(metadata, removal));
    }
  }
  return indexed;
}

// A crest's index records, from its scan.
function crestIndexRecords(scan: Pick<CrestScan, "units" | "duplicates" | "removals">): readonly KnowledgeIndexRecord[] {
  return indexRecords(crestRecords(scan).map((unit) => unit.metadata), scan.removals);
}

// TCRN-CROSS-SUB-425: the records of a crest's valid cards, in crestRecords order.
function validCrestRecords(scan: Pick<CrestScan, "units" | "duplicates" | "removals">): readonly CrestUnit[] {
  return crestRecords(scan).filter((unit) => !scan.removals.has(unit.metadata.id));
}

// How many records a scan's index holds: what knowledge-validate and the marker read report.
function indexRecordCount(scan: Pick<CrestScan, "index">): number {
  return (scan.index.document.records as readonly JsonValue[]).length;
}

// TCRN-CROSS-SUB-425: what a refusal naming a removed card says to do instead.
const REMOVED_READ_REMEDY = "the card is removed: read its removal with knowledge-list --status removed";
const REMOVED_WRITE_REMEDY = "removal is terminal: write a new card with knowledge-create";

// TCRN-CROSS-SUB-425 (MIN-239 D3): refuse a read of a removed card's content, or a write of it, with
// KNOWLEDGE_CARD_REMOVED, the removal in the details.
function assertNotRemoved(scan: Pick<CrestScan, "removals">, id: string, remedy: string): void {
  const removal = scan.removals.get(id);
  if (removal === undefined) return;
  fail("KNOWLEDGE_CARD_REMOVED", `${id} is removed (${removal.reason}): ${removal.basis}`, { id, removal: removalDiagnostic(removal), remedy });
}

// TCRN-CROSS-SUB-425 (MIN-239 D4): clear, from this device's own stream of a crest, the body files of
// the cards removed once a write lands (`removed`). A device clears only its own stream -- two devices
// never write one file of a crest -- so a card whose records another device's stream holds is cleared
// there by that device, at its next write after the removal reaches it. It runs after the write's
// event is committed, under this machine's lock of the crest; a file it cannot remove is left for the
// next write and never turns the committed write into a refusal. Answers how many it removed.
async function clearRemovedBodies(scan: Pick<CrestScan, "streamBodies">, deviceId: string, removed: Iterable<string>): Promise<number> {
  const ids = new Set(removed);
  let cleared = 0;
  for (const entry of scan.streamBodies) {
    if (entry.deviceId !== deviceId || !entry.present || !ids.has(entry.id)) continue;
    try {
      await rm(entry.path);
      cleared += 1;
    } catch {
      // Left for this device's next write.
    }
  }
  return cleared;
}

// Every record a crest holds -- its cards and every version of every duplicate -- in canonical id
// order, the versions of one id in their canonical writer order: what its index view and a
// `--selection all` list read.
function crestRecords(scan: Pick<CrestScan, "units" | "duplicates">): readonly CrestUnit[] {
  return [...scan.units, ...scan.duplicates.flatMap((duplicate) => duplicate.versions)]
    .sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
}

// Which writer holds a record, and where: the device whose event stream holds it, with the event's
// sequence and hash; all three null for a record the metadata/body layout holds.
function recordIdentity(unit: CrestUnit): { readonly deviceId: string | null; readonly sequence: number | null; readonly eventHash: string | null } {
  return unit.event === null
    ? { deviceId: null, sequence: null, eventHash: null }
    : { deviceId: unit.lineage, sequence: unit.event.sequence, eventHash: unit.event.eventHash };
}

// A duplicate's version, named the same way.
function duplicateVersionIdentity(version: CrestUnit): Readonly<Record<string, JsonValue>> {
  return { ...recordIdentity(version) };
}

// The diagnostic entry of one duplicate, as knowledge-list, a read of its id and recall name it
// (knowledge-core-v1.md, "Storage and authority").
function duplicateDiagnostic(duplicate: CrestDuplicate): Readonly<Record<string, JsonValue>> {
  return {
    id: duplicate.id,
    externalKey: duplicate.externalKey,
    versions: duplicate.versions.map((version) => ({
      ...duplicateVersionIdentity(version),
      updatedAt: version.metadata.updatedAt,
      subject: version.metadata.subject,
      bodySha256: version.metadata.bodySha256,
    })),
  };
}

async function assertUserCrestRootEntries(storeRoot: string, legacyLayout: boolean, hasEvents: boolean, allowClaim: boolean): Promise<void> {
  const actual = (await readdir(storeRoot)).filter((entry) => !CREST_TEMP_NAME.test(entry)).sort(compareCanonicalText);
  const expected = (legacyLayout
    ? ["bodies", "metadata", "store.json", ...(hasEvents ? [USER_CREST_EVENTS_DIRECTORY] : [])]
    : ["store.json", USER_CREST_EVENTS_DIRECTORY])
    .concat(allowClaim ? ["mutation.claim"] : [])
    .sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("KNOWLEDGE_PARTIAL_STATE", "user crest root entries are not exact");
  if (!allowClaim && await claimPresence(storeRoot) === "present") fail("KNOWLEDGE_PARTIAL_STATE", "mutation claim is present");
}

async function scanUserCrest(
  location: UserCrestLocation,
  options: KnowledgeReadOptions = {},
  allowClaim = false,
  bodyMode: "full" | "metadata-only" = "full",
  projectView = true,
): Promise<UserCrestScan> {
  const parent = await userCrestParent(location, false);
  const storeRoot = await boundDirectory(join(parent, basename(location.root)), parent);
  const backend = userCrestBackend(storeRoot, location.device, options);
  const marker = validateMarker(parseCanonicalObject(await readCrestMarker(backend, storeRoot), "knowledge marker", "KNOWLEDGE_RECORD_INVALID"));
  // A library's crest put in the user crest's place is not a user crest, and the other way round
  // (scanKnowledgeStore compares the marker with the library id).
  if (marker.workspaceId !== USER_CREST_ID || marker.eventHighWaterDigest !== USER_CREST_HIGH_WATER) {
    fail("KNOWLEDGE_HIGH_WATER_MISMATCH", marker.workspaceId);
  }
  const rootEntries = await readdir(storeRoot);
  const hasEvents = rootEntries.includes(USER_CREST_EVENTS_DIRECTORY);
  const hasLegacyMetadata = rootEntries.includes("metadata");
  const hasLegacyBodies = rootEntries.includes("bodies");
  if (hasLegacyMetadata !== hasLegacyBodies) fail("KNOWLEDGE_PARTIAL_STATE", "user crest legacy metadata/body layout is incomplete");
  const legacyLayout = hasLegacyMetadata && hasLegacyBodies;
  await assertUserCrestRootEntries(storeRoot, legacyLayout, hasEvents, allowClaim);
  if (!legacyLayout && !hasEvents) fail("KNOWLEDGE_PARTIAL_STATE", "user crest event streams are missing");
  let legacyUnits: readonly CrestUnit[] = [];
  if (legacyLayout) {
    const metadataRoot = await boundDirectory(resolve(storeRoot, "metadata"), storeRoot);
    const bodiesRoot = await boundDirectory(resolve(storeRoot, "bodies"), storeRoot);
    const legacy = await scanStoreRecords(backend, { metadataRoot, bodiesRoot }, bodyMode, {
      shape: (value) => validateMetadataShape(value, null),
      links: null,
      danglingWorkLinks: null,
      body: (metadata, body) => validateMetadataBody(metadata, body, null),
    });
    legacyUnits = legacy.units.map(metadataBodyLayoutUnit);
  }
  const reading: CrestStreamReading = {
    linkState: null,
    validate: (value, deviceId, filename) => ({ ...validateUserCrestEvent(value, deviceId, filename), replaces: null, chain: null }),
    maximumEventBytes: RUNTIME_CAPACITY.bufferBytes,
    library: false,
    hooks: options,
  };
  const streams = hasEvents ? await readCrestEventStreams(storeRoot, reading) : EMPTY_CREST_EVENT_STREAMS;
  // TCRN-CROSS-SUB-425: removals decide which cards are removed before any body is admitted.
  const projection = projectCrestUnits([...legacyUnits, ...streams.units], streams.removals, null, false);
  const { removals, unresolvedConflicts } = projection;
  const { admitted, streamBodies } = await admitCrestBodies(streams, removals, bodyMode, reading);
  const units = projection.units.map((unit) => withAdmittedBody(unit, admitted));
  const duplicates = projection.duplicates.map((duplicate) => ({ ...duplicate, versions: duplicate.versions.map((version) => withAdmittedBody(version, admitted)) }));
  // TCRN-CROSS-SUB-413: the index view lists every version of a duplicate beside the cards.
  // TCRN-CROSS-SUB-310 R17 (MIN-238 D1): however many body bytes the merged streams hold, the read
  // answers; nothing sums them, so recall never finds the user crest refused for its bodies' size.
  // TCRN-CROSS-SUB-425: a removed card is indexed as it is kept.
  const records = indexRecords(crestRecords({ units, duplicates }).map((unit) => unit.metadata), removals);
  const eventHighWaterDigest = streams.eventCount === 0
    ? marker.eventHighWaterDigest
    : canonicalSha256({ schemaVersion: USER_CREST_EVENT_HEAD_SCHEMA_VERSION, heads: streams.heads } as unknown as JsonValue);
  const projectedMarker: KnowledgeStoreMarker = {
    ...marker,
    version: marker.version + streams.eventCount,
    eventHighWaterDigest,
  };
  const index = knowledgeIndex(projectedMarker, records);
  if (projectView) await projectKnowledgeView(userCrestKnowledgeView(storeRoot, location.device, options), index);
  return {
    storeRoot, device: location.device, eventOnly: !legacyLayout, eventHeads: streams.heads, marker: projectedMarker, units, index,
    unresolvedConflicts, duplicates, awaitingChain: [], unresolvedScopes: [], removals, streamBodies,
  };
}

// The root marker is created once and never advanced by card writes. Each device appends immutable
// events beneath events/<device id>/; every read reconstructs metadata from those streams.
// TCRN-CROSS-SUB-310 (R14 (c)): this exclusive create is the one operation of this engine that
// writes the user crest's root manifest (knowledge-core-v1.md lists it); recovery never does.
async function ensureUserCrest(location: UserCrestLocation): Promise<void> {
  if (await userCrestInitialized(location.root)) {
    try {
      await lstat(join(location.root, "store.json"));
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  const parent = await userCrestParent(location, true);
  const rootPath = join(parent, basename(location.root));
  try {
    await mkdir(rootPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${rootPath}:${String(error)}`);
  }
  const storeRoot = await boundDirectory(rootPath, parent);
  const entries = await readdir(storeRoot);
  if (entries.includes("store.json")) return;
  if (entries.some((entry) => entry !== USER_CREST_EVENTS_DIRECTORY && !CREST_TEMP_NAME.test(entry))) {
    fail("KNOWLEDGE_PARTIAL_STATE", "user crest has content without a root marker");
  }
  const eventsPath = userCrestEventsPath(storeRoot);
  try {
    await mkdir(eventsPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${eventsPath}:${String(error)}`);
  }
  const eventsRoot = await boundDirectory(eventsPath, storeRoot);
  const eventEntries = await readdir(eventsRoot);
  if (eventEntries.some((entry) => !isAtomicTemporaryName(entry))) {
    fail("KNOWLEDGE_PARTIAL_STATE", "user crest events exist without a root marker");
  }
  const marker: KnowledgeStoreMarker = {
    schemaVersion: KNOWLEDGE_STORE_SCHEMA_VERSION,
    workspaceId: USER_CREST_ID,
    eventHighWaterDigest: USER_CREST_HIGH_WATER,
    version: 0,
    disposable: true,
    authority: "metadata-index-authority-body-separate",
  };
  const { device } = await readOrCreateDevice({ home: location.device });
  try {
    await writeExclusiveFile(resolve(storeRoot, "store.json"), canonicalJson(marker), device.deviceId);
  } catch (error) {
    if (!(error instanceof KnowledgeCoreError) || error.reasonCode !== "KNOWLEDGE_ALREADY_EXISTS") throw error;
    const markerBytes = await readCrestMarker(userCrestBackend(storeRoot, location.device), storeRoot);
    const existing = validateMarker(parseCanonicalObject(markerBytes, "knowledge marker", "KNOWLEDGE_RECORD_INVALID"));
    if (existing.workspaceId !== USER_CREST_ID || existing.eventHighWaterDigest !== USER_CREST_HIGH_WATER) {
      fail("KNOWLEDGE_SOURCE_CHANGED", "user crest root marker changed during initialization");
    }
  }
  await syncDirectory(storeRoot);
}

async function ensureUserCrestEventRoot(location: UserCrestLocation): Promise<{ readonly storeRoot: string; readonly eventsRoot: string }> {
  await ensureUserCrest(location);
  const parent = await userCrestParent(location, false);
  const storeRoot = await boundDirectory(join(parent, basename(location.root)), parent);
  const markerBytes = await readCrestMarker(userCrestBackend(storeRoot, location.device), storeRoot);
  const marker = validateMarker(parseCanonicalObject(markerBytes, "knowledge marker", "KNOWLEDGE_RECORD_INVALID"));
  if (marker.workspaceId !== USER_CREST_ID || marker.eventHighWaterDigest !== USER_CREST_HIGH_WATER) {
    fail("KNOWLEDGE_HIGH_WATER_MISMATCH", marker.workspaceId);
  }
  const eventsPath = userCrestEventsPath(storeRoot);
  try {
    await mkdir(eventsPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${eventsPath}:${String(error)}`);
  }
  const eventsRoot = await boundDirectory(eventsPath, storeRoot);
  return { storeRoot, eventsRoot };
}

async function writeImmutableUserCrestFile(path: string, bytes: Buffer | string, deviceId: string): Promise<void> {
  try {
    await writeExclusiveFile(path, bytes, deviceId);
  } catch (error) {
    if (!(error instanceof KnowledgeCoreError) || error.reasonCode !== "KNOWLEDGE_ALREADY_EXISTS") throw error;
    const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    const existing = await readUserCrestFile(path, Math.max(expected.length, 1));
    if (!existing.equals(expected)) fail("KNOWLEDGE_PARTIAL_STATE", `${path}: immutable event data differs`);
  }
}

// Recovery is an explicit operation under this device's lock. It can release only
// this device's staging files in its own stream (or its first marker publication),
// with the native device identity, OS owner, inode, raw digest and record/body
// binding all checked. Staging bytes are quarantined here, never returned as cards.
async function recoverCrestPublications(storeRootInput: string, home: string, workspace: WorkspaceState | null): Promise<number> {
  const device = await readDevice(home);
  if (device === null) return 0;
  const deviceId = device.deviceId;
  const storeRoot = await boundDirectory(storeRootInput);
  const directories = [storeRoot];
  const streamPath = join(storeRoot, USER_CREST_EVENTS_DIRECTORY, deviceId);
  try { directories.push(await boundDirectory(streamPath, storeRoot)); } catch (error) {
    try { await lstat(streamPath); } catch (missing) {
      if ((missing as { code?: string }).code === "ENOENT") return recoverDirectory(storeRoot);
      throw missing;
    }
    throw error;
  }
  let recovered = 0;
  for (const directory of directories) recovered += await recoverDirectory(directory);
  return recovered;

  async function recoverDirectory(directory: string): Promise<number> {
    const parentBefore = await lstat(directory, { bigint: true });
    const candidates: { readonly path: string; readonly stats: BigIntStats; readonly final: string; readonly linked: boolean }[] = [];
    for (const entry of await readdir(directory)) {
      const match = CREST_TEMP_NAME.exec(entry);
      if (match === null || match[1] !== deviceId || (directory === storeRoot) !== (match[5] === "store.json")) continue;
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid)) fail("KNOWLEDGE_RECORD_INVALID", `${entry}: publisher pid`);
      if (processIsAlive(pid)) fail("KNOWLEDGE_LOCKED", `${entry}: publisher is still alive`);
      const temporary = join(directory, entry);
      const final = join(directory, match[5]!);
      const before = await lstat(temporary, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1n && before.nlink !== 2n) ||
        (before.mode & 0o777n) !== 0o600n || (process.geteuid !== undefined && before.uid !== BigInt(process.geteuid()))) {
        fail("KNOWLEDGE_LINK_UNSAFE", temporary);
      }
      let named: BigIntStats | undefined;
      try { named = await lstat(final, { bigint: true }); } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      const linked = before.nlink === 2n;
      if (linked && (named === undefined || !named.isFile() || named.isSymbolicLink() || named.nlink !== 2n || !sameCrestBytes(before, named))) {
        fail("KNOWLEDGE_LINK_UNSAFE", temporary);
      }
      if (!linked && named !== undefined && sameIdentity(before, named)) fail("KNOWLEDGE_LINK_UNSAFE", temporary);
      const maximum = match[5] === "store.json" ? knowledgeBackendProfile.limits.markerBytes
        : match[5]!.endsWith(".body") ? KNOWLEDGE_LIMITS.maximumBodyBytes
        : workspace === null ? RUNTIME_CAPACITY.bufferBytes : CREST_EVENT_MAXIMUM_BYTES;
      if (before.size > BigInt(maximum)) fail("KNOWLEDGE_LIMIT_EXCEEDED", temporary);
      const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== before.nlink || !sameCrestBytes(before, opened) || opened.ctimeNs !== before.ctimeNs) {
          fail("KNOWLEDGE_SOURCE_CHANGED", temporary);
        }
        bytes = Buffer.alloc(Number(before.size));
        let position = 0;
        while (position < bytes.length) {
          const read = await handle.read(bytes, position, bytes.length - position, position);
          if (read.bytesRead === 0) fail("KNOWLEDGE_SOURCE_CHANGED", temporary);
          position += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (after.nlink !== before.nlink || !sameCrestBytes(before, after) || before.ctimeNs !== after.ctimeNs) {
          fail("KNOWLEDGE_SOURCE_CHANGED", temporary);
        }
      } finally { await handle.close(); }
      if (sha256(bytes) !== match[3]) fail("KNOWLEDGE_RECORD_INVALID", `${temporary}: staging digest`);
      if (match[5]!.endsWith(".body")) {
        if (sha256(bytes) !== CREST_BODY_FILE_PATTERN.exec(match[5]!)?.[2]) fail("KNOWLEDGE_RECORD_INVALID", `${temporary}: body digest`);
      } else {
        const value = parseCanonicalObject(bytes, "crest publication", "KNOWLEDGE_RECORD_INVALID");
        if (match[5] === "store.json") {
          const marker = validateMarker(value);
          const id = workspace?.metadata.workspaceId ?? USER_CREST_ID;
          const highWater = workspace === null ? USER_CREST_HIGH_WATER : libraryCrestIdentityDigest(id);
          if (marker.workspaceId !== id || marker.eventHighWaterDigest !== highWater || marker.version !== 0) {
            fail("KNOWLEDGE_HIGH_WATER_MISMATCH", temporary);
          }
        } else if (value.schemaVersion === CREST_REMOVAL_SCHEMA_VERSION) validateCrestRemovalEvent(value, deviceId, match[5]!);
        else if (workspace === null) validateUserCrestEvent(value, deviceId, match[5]!);
        else validateLibraryCrestEvent(value, deviceId, match[5]!, workspace);
      }
      candidates.push({ path: temporary, stats: before, final, linked });
    }
    // Validate the complete candidate set before releasing any staging link.
    for (const candidate of candidates) {
      const named = await lstat(candidate.path, { bigint: true });
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== candidate.stats.nlink ||
        !sameCrestBytes(candidate.stats, named) || candidate.stats.ctimeNs !== named.ctimeNs ||
        !sameIdentity(parentBefore, await lstat(directory, { bigint: true }))) fail("KNOWLEDGE_SOURCE_CHANGED", candidate.path);
      if (candidate.linked) {
        const final = await lstat(candidate.final, { bigint: true });
        if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 2n || !sameCrestBytes(named, final)) {
          fail("KNOWLEDGE_LINK_UNSAFE", candidate.final);
        }
      }
      await unlink(candidate.path);
      await syncDirectory(directory);
      if (candidate.linked) {
        const final = await lstat(candidate.final, { bigint: true });
        if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1n ||
          !sameCrestBytes(candidate.stats, final)) fail("KNOWLEDGE_LINK_UNSAFE", candidate.final);
      }
    }
    return candidates.length;
  }
}

// A stopped first initialization can leave only its private staging bytes and an
// empty events directory. Recovery discards those bytes, but never creates a root
// manifest: the existing initialization operation still owns that first publication.
async function crestInitializationIncomplete(storeRoot: string, user: boolean): Promise<boolean> {
  try { await lstat(join(storeRoot, "store.json")); return false; } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const entries = (await readdir(storeRoot)).filter((entry) => !CREST_TEMP_NAME.test(entry));
  if (user) {
    if (entries.length !== 1 || entries[0] !== USER_CREST_EVENTS_DIRECTORY) fail("KNOWLEDGE_PARTIAL_STATE", storeRoot);
    const events = await boundDirectory(userCrestEventsPath(storeRoot), storeRoot);
    if ((await readdir(events)).some((entry) => !isAtomicTemporaryName(entry))) fail("KNOWLEDGE_PARTIAL_STATE", events);
  } else if (entries.length !== 0) fail("KNOWLEDGE_PARTIAL_STATE", storeRoot);
  return true;
}

/**
 * The user crest as a read sees it. Before the crest's first card there is nothing to read, and `read`
 * is handed null. TCRN-CROSS-STORY-529 (TCRN-CROSS-SUB-482): a read takes no lock. It answers from this
 * device's snapshot of the crest while the crest's folder stands as the snapshot found it. A
 * snapshot missing or behind the crest is rebuilt under the lock when the lock is free; while a
 * writer holds it, the read answers from the snapshot it has -- the writer replaces it once its event
 * is down -- or, with none, from a scan of the crest as it stands that leaves the view alone.
 */
async function readUserCrest<T>(options: KnowledgeReadOptions, read: (scan: UserCrestScan | null) => Promise<T>): Promise<T> {
  const location = await locateUserCrest();
  if (!(await userCrestInitialized(location.root))) return read(null);
  const snapshot = await loadUserCrestSnapshot(location, options);
  if (snapshot !== null && snapshot.current) return read(snapshot.scan);
  const lock = await tryUserCrestLock(location);
  if (lock === null) {
    return read(snapshot?.scan ?? await scanUserCrest(location, options, false, "metadata-only", false));
  }
  let scan: UserCrestScan;
  try {
    scan = await scanForUserCrestSnapshot(location, options);
  } finally {
    await lock.release().catch(() => undefined);
  }
  return read(scan);
}

// The user crest lock when no one holds it, or null at once when someone does.
async function tryUserCrestLock(location: UserCrestLocation): Promise<FileLock | null> {
  const path = userCrestLockPath(location.device);
  await ensureDeviceDirectory(dirname(path));
  try {
    return await acquireFileLock(path, { timeoutMs: 0, command: "einzbern user-crest-snapshot" });
  } catch (error) {
    if (error instanceof FileLockError && error.reasonCode === "FILE_LOCK_TIMEOUT") return null;
    throw error;
  }
}

// What a unit of the snapshot keeps: everything but its body and body reader, which a load rebuilds.
function snapshotUnitDocument(unit: CrestUnit): Readonly<Record<string, unknown>> {
  return {
    metadataPath: unit.metadataPath, bodyPath: unit.bodyPath, metadata: unit.metadata, lineage: unit.lineage, event: unit.event,
    replaces: unit.replaces, chain: unit.chain, storedDigest: unit.storedDigest, streamBody: unit.streamBody,
  };
}

// The user crest's folder, resolved as a scan resolves it.
async function userCrestStoreRoot(location: UserCrestLocation): Promise<string> {
  const parent = await userCrestParent(location, false);
  return boundDirectory(join(parent, basename(location.root)), parent);
}

// What a snapshot is current against: every entry of the crest's folder, of events/ and of each device
// stream, with its size, modification time and inode. A new or forked event, an altered or removed
// file, another layout's folders -- anything a scan would read differently -- changes it; no event is read.
async function userCrestFingerprint(storeRoot: string): Promise<string> {
  const entries: (string | number)[][] = [];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    const listed = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareCanonicalText(left.name, right.name));
    for (const entry of listed) {
      if (isAtomicTemporaryName(entry.name) || CREST_TEMP_NAME.test(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) {
        entries.push([`${prefix}${entry.name}/`]);
        await walk(entryPath, `${prefix}${entry.name}/`, depth + 1);
        continue;
      }
      const info = await lstat(entryPath);
      entries.push([`${prefix}${entry.name}`, info.size, info.mtimeMs, info.ino]);
    }
  };
  await walk(storeRoot, "", 0);
  return sha256(JSON.stringify(entries));
}

// A scan for the snapshot, under the user crest lock. The fingerprint is taken first, so a change
// during the scan leaves the snapshot behind the crest, to be rebuilt, and never ahead of it.
async function scanForUserCrestSnapshot(location: UserCrestLocation, options: KnowledgeReadOptions): Promise<UserCrestScan> {
  const fingerprint = await userCrestFingerprint(await userCrestStoreRoot(location));
  const scan = await scanUserCrest(location, options, false, "metadata-only");
  await writeUserCrestSnapshot(scan, fingerprint);
  return scan;
}

/** Replace this device's snapshot of an event-stream user crest with `scan`, by an atomic rename. */
async function writeUserCrestSnapshot(scan: UserCrestScan, fingerprint: string): Promise<void> {
  if (!scan.eventOnly) return;
  const path = userCrestSnapshotPath(scan.device);
  await ensureDeviceDirectory(dirname(path));
  const document = {
    schemaVersion: USER_CREST_SNAPSHOT_SCHEMA_VERSION,
    storeRoot: scan.storeRoot,
    fingerprint,
    eventHeads: scan.eventHeads,
    marker: scan.marker,
    index: scan.index,
    units: scan.units.map(snapshotUnitDocument),
    duplicates: scan.duplicates.map((duplicate) => ({ id: duplicate.id, externalKey: duplicate.externalKey, versions: duplicate.versions.map(snapshotUnitDocument) })),
    unresolvedConflicts: scan.unresolvedConflicts,
    removals: [...scan.removals.entries()],
    streamBodies: scan.streamBodies,
  };
  await writeFileAtomic(path, `${JSON.stringify(document)}\n`);
}

// After a write, under the lock: the snapshot the next read answers from. The write itself has
// landed; a crest this scan cannot read leaves no snapshot, so the next read scans and names it.
async function refreshUserCrestSnapshot(location: UserCrestLocation, options: KnowledgeReadOptions): Promise<void> {
  try {
    await scanForUserCrestSnapshot(location, options);
  } catch {
    await rm(userCrestSnapshotPath(location.device), { force: true }).catch(() => undefined);
  }
}

// A unit of the snapshot with the body reader the scan gave it: a removed card's refuses, a card
// whose event names a body reads that file, and any other is not admitted.
function snapshotUnit(value: CrestUnit, removals: ReadonlyMap<string, CrestRemoval>, options: KnowledgeReadOptions): CrestUnit {
  const unit: CrestUnit = { ...value, body: null };
  if (unit.event === null) return unit;
  const id = unit.metadata.id;
  const reference = unit.streamBody;
  const readBody = removals.has(id)
    ? async (): Promise<Buffer> => fail("KNOWLEDGE_CARD_REMOVED", id)
    : reference === null
      ? async (): Promise<Buffer> => fail("KNOWLEDGE_RECORD_INVALID", `${id}:body was not admitted`)
      : async (): Promise<Buffer> => readUserCrestFile(reference.path, KNOWLEDGE_LIMITS.maximumBodyBytes, options);
  return { ...unit, readBody };
}

/**
 * This device's snapshot of the user crest, and whether it is current: the crest's folder as the
 * snapshot found it (userCrestFingerprint). Null when there is none, it is unreadable, or it is of a crest in another place.
 */
async function loadUserCrestSnapshot(location: UserCrestLocation, options: KnowledgeReadOptions): Promise<{ readonly scan: UserCrestScan; readonly current: boolean } | null> {
  let value: Record<string, unknown>;
  let storeRoot: string;
  try {
    value = JSON.parse(await readFile(userCrestSnapshotPath(location.device), "utf8")) as Record<string, unknown>;
    storeRoot = await userCrestStoreRoot(location);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || value.schemaVersion !== USER_CREST_SNAPSHOT_SCHEMA_VERSION || value.storeRoot !== storeRoot || typeof value.fingerprint !== "string" ||
    !Array.isArray(value.eventHeads) || !Array.isArray(value.units) || !Array.isArray(value.duplicates) || !Array.isArray(value.removals) ||
    !Array.isArray(value.unresolvedConflicts) || !Array.isArray(value.streamBodies) || value.marker === null || typeof value.marker !== "object" ||
    value.index === null || typeof value.index !== "object") {
    return null;
  }
  const removals = new Map(value.removals as [string, CrestRemoval][]);
  const eventHeads = value.eventHeads as CrestEventHead[];
  const scan: UserCrestScan = {
    storeRoot, device: location.device, eventOnly: true, eventHeads,
    marker: value.marker as KnowledgeStoreMarker,
    units: (value.units as CrestUnit[]).map((unit) => snapshotUnit(unit, removals, options)),
    index: value.index as KnowledgeIndex,
    unresolvedConflicts: value.unresolvedConflicts as string[][],
    duplicates: (value.duplicates as CrestDuplicate[]).map((duplicate) => ({ ...duplicate, versions: duplicate.versions.map((unit) => snapshotUnit(unit, removals, options)) })),
    awaitingChain: [], unresolvedScopes: [], removals,
    streamBodies: value.streamBodies as CrestStreamBody[],
  };
  let current: boolean;
  try {
    current = await userCrestFingerprint(storeRoot) === value.fingerprint;
  } catch {
    current = false;
  }
  return { scan, current };
}

function assertStoreScope(scope: unknown): asserts scope is KnowledgeStoreScope | undefined {
  if (scope !== undefined && !(KNOWLEDGE_STORE_SCOPES as readonly unknown[]).includes(scope)) {
    fail("KNOWLEDGE_INPUT_INVALID", `scope=${String(scope)}`);
  }
}

// TCRN-CROSS-SUB-414: what a library crest write, and a rebase, read first: the whole crest, every
// body bound (a mutation validates every body binding). A write takes no claim of its own -- it
// appends to this device's stream under this machine's lock -- so a mutation claim can only be one
// an interrupted writer of the metadata/body layout left, which knowledge-recover completes; until
// then the crest is KNOWLEDGE_LOCKED rather than partial.
async function mutationAdmissionScan(workspaceRoot: string, options: KnowledgeReadOptions, rebase = false): Promise<KnowledgeStoreScan> {
  try {
    return await scanKnowledgeStore(workspaceRoot, options, false, "full", rebase);
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_PARTIAL_STATE") {
      const root = await knowledgeStorePath(workspaceRoot);
      if (await claimPresence(root) === "present") fail("KNOWLEDGE_LOCKED", "knowledge mutation claim exists");
    }
    throw error;
  }
}

async function releaseMutationClaim(storeRoot: string, claim: ExclusiveFile & { readonly token: string }): Promise<void> {
  const current = await lstat(claim.path);
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !sameIdentity(current, claim.identity)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "knowledge claim identity changed");
  }
  const released = resolve(storeRoot, `released-${claim.token}`);
  await rename(claim.path, released);
  const moved = await lstat(released);
  if (!sameIdentity(moved, claim.identity) || moved.isSymbolicLink() || !moved.isFile() || moved.nlink !== 1) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "released knowledge claim identity changed");
  }
  await rm(released);
  await syncDirectory(storeRoot);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

/**
 * Recover a knowledge mutation left behind by a process that is no longer alive.
 * Recovery only admits a source-consistent metadata/body set; an orphan body or a
 * malformed claim remains blocked instead of being guessed away.
 */
export async function recoverKnowledgeStore(workspaceRoot: string, options: KnowledgeScopedReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertStoreScope(options.scope);
  if (options.scope === "user") {
    const location = await locateUserCrest();
    if (!(await userCrestInitialized(location.root))) {
      return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERY_NOT_NEEDED", recovered: false, scope: "user" };
    }
    return withUserCrestLock(location, async () => {
      const recovered = await recoverUserCrestUnlocked(location, options);
      await refreshUserCrestSnapshot(location, options);
      return recovered;
    });
  }
  return withCrestWriteLock(workspaceRoot, () => recoverKnowledgeStoreUnlocked(workspaceRoot, options));
}

async function recoverUserCrestUnlocked(location: UserCrestLocation, options: KnowledgeReadOptions): Promise<Readonly<Record<string, JsonValue>>> {
  const claimedRoot = join(await userCrestParent(location, false), basename(location.root));
  const claim = await readMutationClaim(claimedRoot);
  if (claim !== null && processIsAlive(claim.pid)) fail("KNOWLEDGE_LOCKED", "knowledge mutation claim belongs to a live process");
  const publications = await recoverCrestPublications(claimedRoot, location.device, null);
  if (claim === null) {
    if (publications > 0) {
      if (await crestInitializationIncomplete(claimedRoot, true)) {
        return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERED", recovered: true, scope: "user", reclaimedRetiredBodies: 0 };
      }
      const scan = await scanUserCrest(location, options, false, "full");
      await writeIndex(userCrestKnowledgeView(scan.storeRoot, location.device, options), scan.marker, crestIndexRecords(scan));
      return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERED", recovered: true, scope: "user", version: scan.marker.version, reclaimedRetiredBodies: 0 };
    }
    return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERY_NOT_NEEDED", recovered: false, scope: "user" };
  }
  const scan = await scanUserCrest(location, options, true, "full");
  const boundClaim = await readMutationClaim(scan.storeRoot);
  if (boundClaim === null || boundClaim.token !== claim.token || boundClaim.pid !== claim.pid ||
    boundClaim.workspaceId !== USER_CREST_ID || !sameIdentity(boundClaim.identity, claim.identity)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "knowledge user-crest claim changed during recovery");
  }
  // TCRN-CROSS-SUB-310 (MIN-235 D7; R14 (c)): recovery never writes the root manifest, whichever
  // layouts the crest holds. The marker a scan answers is a projection over every event stream
  // (scanUserCrest), not the manifest, and persisting it would bind the manifest to one moment of
  // the streams and refuse every later read. What recovery repairs is this device's derived index
  // and the claim an interrupted writer of the metadata/body layout left; it deletes no body.
  await writeIndex(userCrestKnowledgeView(scan.storeRoot, location.device, options), scan.marker, crestIndexRecords(scan));
  await releaseMutationClaim(scan.storeRoot, boundClaim);
  await scanUserCrest(location, options);
  return {
    schemaVersion: "tcrn.knowledge-recovery-result.v1",
    reasonCode: "KNOWLEDGE_RECOVERED",
    recovered: true,
    scope: "user",
    version: scan.marker.version,
    reclaimedRetiredBodies: 0,
  };
}

async function recoverKnowledgeStoreUnlocked(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const claimedRoot = await knowledgeStorePath(workspaceRoot);
  const claim = await readMutationClaim(claimedRoot);
  if (claim !== null) await assertKnowledgeWritable(workspaceRoot);
  if (claim !== null && processIsAlive(claim.pid)) fail("KNOWLEDGE_LOCKED", "knowledge mutation claim belongs to a live process");
  const publications = await hasLibraryManifest(workspaceRoot)
    ? await recoverCrestPublications(claimedRoot, deviceHome(), await materializeWorkspace(workspaceRoot)) : 0;
  if (claim === null) {
    if (publications > 0) {
      if (await crestInitializationIncomplete(claimedRoot, false)) {
        return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERED", recovered: true, reclaimedRetiredBodies: 0 };
      }
      const scan = await scanKnowledgeStore(workspaceRoot, options, false, "full");
      await writeIndex(libraryKnowledgeView(scan.storeRoot, options), scan.marker, crestIndexRecords(scan));
      return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERED", recovered: true, version: scan.marker.version, reclaimedRetiredBodies: 0 };
    }
    return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERY_NOT_NEEDED", recovered: false };
  }
  const scan = await scanKnowledgeStore(workspaceRoot, options, true, "full", false, true);
  const boundClaim = await readMutationClaim(scan.storeRoot);
  if (boundClaim === null || boundClaim.token !== claim.token || boundClaim.pid !== claim.pid ||
    boundClaim.workspaceId !== scan.marker.workspaceId || !sameIdentity(boundClaim.identity, claim.identity)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "knowledge mutation claim changed during recovery");
  }
  // TCRN-CROSS-SUB-414 (MIN-235 D7): recovery never writes the root manifest. The marker a scan
  // answers is a projection over every event stream (scanLibraryCrest), and persisting it would bind
  // the manifest to one moment of the streams and of the chain. What recovery completes is the stopped
  // write of the metadata/body layout that left the claim: this device's derived index is projected
  // again, and a record that write retired gives back the body it still holds, as that layout's
  // retire did. No event stream is touched.
  const backend = storeBackendFor(scan.storeRoot, options);
  await writeIndex(libraryKnowledgeView(scan.storeRoot, options), scan.marker, crestIndexRecords(scan));
  let reclaimedRetiredBodies = 0;
  for (const unit of crestRecords(scan)) {
    if (unit.event !== null || unit.metadata.lifecycle !== "retired" || unit.body === null) continue;
    if (backend instanceof SegmentedKnowledgeStoreBackend) await backend.removeKnowledgeBody(unit.metadata.id);
    else await rm(unit.bodyPath, { force: true });
    reclaimedRetiredBodies += 1;
  }
  await releaseMutationClaim(scan.storeRoot, boundClaim);
  await scanKnowledgeStore(workspaceRoot, options);
  return {
    schemaVersion: "tcrn.knowledge-recovery-result.v1",
    reasonCode: "KNOWLEDGE_RECOVERED",
    recovered: true,
    version: scan.marker.version,
    reclaimedRetiredBodies,
  };
}

function crash(point: KnowledgeFaultPoint, selected?: KnowledgeFaultPoint): void {
  if (point === selected) {
    fail("KNOWLEDGE_FAULT_INJECTED", point);
  }
}

function computeFreshness(metadata: KnowledgeUnitMetadata, at: string): KnowledgeFreshnessState {
  let now: bigint;
  try {
    now = parseStrictInstant(at);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
  // STORY-327: freshness is change-driven. A null policy means the card never
  // expires by clock, and an absent verification instant is no longer a reason
  // to hide a card from default retrieval. Keep an explicit stale state visible
  // until a re-verification, but do not manufacture a stale result from time.
  if (metadata.stalenessPolicy.maximumAgeDays === null) {
    return metadata.freshnessState === "stale" ? "stale" : "fresh";
  }
  if (metadata.lastVerified === null) return metadata.freshnessState === "stale" ? "stale" : "fresh";
  if (metadata.freshnessState === "unknown") return "fresh";
  let verified: bigint;
  try {
    verified = parseStrictInstant(metadata.lastVerified);
  } catch (error) {
    fail("KNOWLEDGE_RECORD_INVALID", String(error));
  }
  if (now < verified) {
    fail("KNOWLEDGE_INPUT_INVALID", "freshness evaluation precedes last verification");
  }
  const maximumAge = BigInt(metadata.stalenessPolicy.maximumAgeDays) * 86_400_000_000_000n;
  return metadata.freshnessState === "stale" || now - verified > maximumAge ? "stale" : "fresh";
}

function assertEvaluationInstant(at: string): void {
  try {
    assertStrictInstant(at);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
}

function assertSelection(selection: unknown): asserts selection is "default" | "all" {
  if (selection !== "default" && selection !== "all") {
    fail("KNOWLEDGE_SELECTION_INVALID", String(selection));
  }
}

// TCRN-CROSS-STORY-365: a card the writer replaced stops being a default answer: it no longer
// competes with the card that supersedes it, which is the whole point of having chosen
// --supersedes. TCRN-CROSS-SUB-425 (MIN-239 D4): it is removed as well, so no read answers its
// content and its body is cleared; the scan's removals keep it out before this test is reached.
//
// TCRN-CROSS-INC-282 (Owner rulings TCRN-CROSS-MIN-146 D1, TCRN-CROSS-MIN-158 D1): the
// default selection is every active card. It used to require promotionState "promoted",
// the promotion gate TCRN-CROSS-MIN-146 abolished, which stranded every card written
// before that ruling plus every shape STORY-365's predicate did not reach. "rejected" is
// the one state still read: rejection is a writer's explicit "do not answer with this",
// not a gate a card has to pass. The other conjuncts are the writer's own declarations --
// superseded, retired, excluded, export-restricted, stale -- and stay as they were.
function isDefaultSelectable(metadata: KnowledgeUnitMetadata, at: string): boolean {
  return metadata.extensions.supersededBy === undefined &&
    metadata.promotionState !== "rejected" && metadata.lifecycle === "active" &&
    metadata.retrievalDisposition === "default" && metadata.exportDisposition === "metadata-only" &&
    computeFreshness(metadata, at) === "fresh";
}

// TCRN-CROSS-SUB-308 (TCRN-CROSS-STORY-476 R1, TCRN-CROSS-MIN-227 D9): the candidate lifecycle
// and the promotion step that moved a card out of it are retired, and a card retires only when
// a later card names it with --supersedes. A write therefore lands lifecycle "active" whatever
// it asked for: left out or "active" is written, "candidate" and "retired" are refused with the
// remedy, and anything else is not a lifecycle at all. Records written before this keep the
// lifecycle and promotion state they were written with; they are read, never rewritten.
function assertWritableLifecycle(lifecycle: unknown): void {
  if (lifecycle === undefined || lifecycle === "active") return;
  if (lifecycle === "candidate") {
    fail("KNOWLEDGE_LIFECYCLE_RETIRED", "the candidate lifecycle is retired: a card is retrievable the moment it is written", {
      required: "active", actual: "candidate", remedy: "write the card with lifecycle active, or leave the lifecycle out",
    });
  }
  if (lifecycle === "retired") {
    fail("KNOWLEDGE_LIFECYCLE_RETIRED", "a card is not written retired: it retires when a later card supersedes it", {
      required: "active", actual: "retired", remedy: "write the replacement card with --supersedes naming the card it retires",
    });
  }
  fail("KNOWLEDGE_INPUT_INVALID", `lifecycle=${String(lifecycle)}`);
}

function buildMetadata(
  input: CreateKnowledgeUnitInput,
  body: Buffer,
  workspace: WorkspaceState,
  languageProvider?: KnowledgeLanguageProvider,
  host?: string,
): KnowledgeUnitMetadata {
  assertWritableLifecycle(input.lifecycle);
  if (input.projectId !== null && !workspace.projects.some((project) => project.id === input.projectId && !project.tombstone)) {
    fail("KNOWLEDGE_LINK_INVALID", `unknown project ${input.projectId}`);
  }
  let externalKey: string;
  try {
    externalKey = canonicalExternalKey(input.externalKey);
    assertStrictInstant(input.occurredAt);
    if (input.lastVerified !== null) assertStrictInstant(input.lastVerified);
  } catch (error) {
    fail(error instanceof ProtocolError && error.reasonCode === "CANONICAL_VALUE_INVALID" ? "KNOWLEDGE_CANONICAL_INVALID" : "KNOWLEDGE_INPUT_INVALID", String(error));
  }
  // Reference cards are rejected at capture when their source/evidence contract
  // is absent (the explicit write-time boundary in STORY-327). TCRN-CROSS-INC-282
  // extends that boundary to `guide` through the write-time check below; this check
  // stays because it names the kind rather than a stored record id.
  if (input.kind === "reference" && (input.sourceReferences.length === 0 || input.linkedEvidenceIds.length === 0)) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `${input.kind} knowledge requires source and evidence links`);
  }
  // TCRN-CROSS-STORY-365 (Owner ruling TCRN-CROSS-MIN-146): a card is retrievable the
  // moment it is written.
  //
  // TCRN-CROSS-INC-282 (Owner rulings TCRN-CROSS-MIN-146 D1, TCRN-CROSS-MIN-158 D1):
  // strict kinds enforce their provenance contract at write time, so a `guide` with no
  // source or evidence is refused where its writer can see it. TCRN-CROSS-SUB-308 closed
  // the last way round it, the lifecycle "candidate" write (see assertWritableLifecycle).
  //
  // TCRN-CROSS-STORY-364 (Owner ruling TCRN-CROSS-MIN-160 D3): the write-path hook, on the
  // one function every write path reaches. knowledge-create calls it directly, and
  // knowledge-capture calls it through captureKnowledgeUnit.
  //
  // Fail-closed: a workspace that records artifact.language and cannot produce the
  // translation refuses here, with the reason code the caller can act on, rather than
  // storing prose in a language its own retrieval set does not cover.
  let language;
  try {
    language = applyWriteLanguagePolicy(
      { subject: input.subject, summary: input.summary, snippet: input.snippet },
      readKnowledgeLanguagePolicy(scopedWorkspaceState(workspace, input.projectId ?? undefined).settings, host),
      languageProvider,
    );
  } catch (error) {
    if (error instanceof KnowledgeLanguageError) fail(error.reasonCode, error.message, error.details as Readonly<Record<string, JsonValue>>);
    throw error;
  }
  const metadata: KnowledgeUnitMetadata = {
    schemaVersion: KNOWLEDGE_METADATA_SCHEMA_VERSION,
    id: deriveStableId("knowledge", externalKey),
    externalKey,
    scope: input.scope,
    projectId: input.projectId,
    // WSC-3: arrays are canonically sorted server-side so an agent never has to
    // pre-sort them (the stored record stays canonical; validateMetadataShape
    // still asserts the sorted invariant on read).
    roleScopes: [...input.roleScopes].sort(compareCanonicalText),
    category: input.category,
    kind: input.kind,
    tags: [...input.tags].sort(compareCanonicalText),
    subject: language.subject,
    summary: language.summary,
    snippet: language.snippet,
    accountableOwnerId: input.accountableOwnerId,
    sourceReferences: [...input.sourceReferences].sort(compareCanonicalText),
    sourceDigest: input.sourceDigest ?? "",
    supersedes: input.supersedes ?? null,
    linkedWorkIds: [...input.linkedWorkIds].sort(compareCanonicalText),
    linkedDecisionIds: [...input.linkedDecisionIds].sort(compareCanonicalText),
    linkedGateIds: [...input.linkedGateIds].sort(compareCanonicalText),
    linkedEvidenceIds: [...input.linkedEvidenceIds].sort(compareCanonicalText),
    // TCRN-CROSS-SUB-308: written is active and retrievable; nothing new is a candidate.
    lifecycle: "active",
    retrievalDisposition: input.retrievalDisposition,
    freshnessState: input.freshnessState,
    lastVerified: input.lastVerified,
    stalenessPolicy: input.stalenessPolicy,
    redactionDisposition: "focused-reference-redaction-v1",
    exportDisposition: input.exportDisposition,
    authority: "workspace-knowledge-metadata",
    sourceProvenance: "explicit-current-source-reference",
    bodySha256: sha256(body),
    bodyBytes: body.length,
    revision: 1,
    updatedAt: input.occurredAt,
    extensions: {},
    expansions: language.expansions,
  };
  assertPromotableProvenance(metadata);
  // TCRN-CROSS-STORY-476 R5: the writer's library supplies the language policy above either way;
  // a user card's links are checked for the user crest it is bound for, not against the library.
  const linkState = input.scope === "user" ? null : workspace;
  const validated = validateMetadataShape(metadata as unknown as Readonly<Record<string, JsonValue>>, linkState);
  validateMetadataBody(validated, body, linkState);
  // TCRN-CROSS-SUB-426 (MIN-239 D5, C-R17-5): a card that repeats a work record or a valid decision of the library is refused.
  assertKnowledgeNotRecorded(workspace, metadata, input.body);
  return metadata;
}

async function writeIndex(place: KnowledgeViewPlace, marker: KnowledgeStoreMarker, metadata: readonly KnowledgeIndexRecord[]): Promise<void> {
  await projectKnowledgeView(place, knowledgeIndex(marker, metadata));
}

export async function initializeKnowledgeStore(workspaceRootInput: string, options: { readonly disposableAcknowledged?: boolean } = {}): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(workspaceRootInput, () => initializeKnowledgeStoreUnlocked(workspaceRootInput, options));
}

async function initializeKnowledgeStoreUnlocked(workspaceRootInput: string, options: { readonly disposableAcknowledged?: boolean } = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const workspace = await materializeWorkspace(workspaceRootInput);
  // WSC-1: the store is a disposable derived index that is never the system of record, and
  // every initialization acknowledges that explicitly. Old-layout FIXTURE- workspaces used to be
  // admitted implicitly; a library has no workspace key to carry that mark, and an old-layout
  // workspace is read-only (TCRN-CROSS-STORY-469).
  if (options.disposableAcknowledged !== true) {
    fail("KNOWLEDGE_DISPOSABLE_ACK_REQUIRED", workspace.metadata.workspaceId);
  }
  if (!workspace.headEventHash) {
    fail("KNOWLEDGE_HIGH_WATER_MISMATCH", "knowledge store requires a non-empty Workspace authority");
  }
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  await assertKnowledgeWritable(workspaceRoot);
  const storeRoot = await ensureEmptyStoreRoot(await knowledgeStorePath(workspaceRoot), workspaceRoot);
  // TCRN-CROSS-SUB-414 (MIN-235 D7): initialization is the one operation of this engine that writes
  // a library crest's root manifest, and it creates it once, exclusively, never replacing one. The
  // manifest binds the library id and that id's own digest, not the chain head of the moment, so it
  // holds the same bytes whichever device writes it. Cards go to each device's event stream, which
  // the first write lays out; the index view is this device's cache (libraryKnowledgeViewFolder).
  const marker: KnowledgeStoreMarker = {
    schemaVersion: KNOWLEDGE_STORE_SCHEMA_VERSION,
    workspaceId: workspace.metadata.workspaceId,
    eventHighWaterDigest: libraryCrestIdentityDigest(workspace.metadata.workspaceId),
    version: 0,
    disposable: true,
    authority: "metadata-index-authority-body-separate",
  };
  const { device } = await readOrCreateDevice();
  await writeExclusiveFile(resolve(storeRoot, "store.json"), canonicalJson(marker), device.deviceId);
  await syncDirectory(storeRoot);
  await scanKnowledgeStore(workspaceRoot);
  return {
    schemaVersion: "tcrn.knowledge-store-init-result.v1",
    reasonCode: "KNOWLEDGE_STORE_INITIALIZED",
    workspaceId: marker.workspaceId,
    version: marker.version,
    records: 0,
    bodyStorage: "separate-explicit-read-only",
    admission: "acknowledged-disposable",
  };
}

// TCRN-CROSS-SUB-414: the high water a library crest's root manifest binds when it is created: the
// library id's own digest, as the user crest's binds its identity's.
function libraryCrestIdentityDigest(libraryId: string): string {
  return createHash("sha256").update(libraryId, "utf8").digest("hex");
}

export async function readKnowledgeStoreMarker(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  // INC-244: the bounded diagnostic read of the marker. It is separate from validateKnowledgeStore
  // so the strict validation contract cannot accidentally become a trailing-read exemption.
  // TCRN-CROSS-SUB-414: a library's marker is answered as projected, its version advanced by every
  // event and its high water the chain head the read was bound against.
  const scan = await scanKnowledgeStore(workspaceRoot, { ...options, allowTrailing: true }, false, "metadata-only");
  return {
    schemaVersion: "tcrn.knowledge-store-marker-read.v1",
    reasonCode: "KNOWLEDGE_STORE_MARKER_READ",
    workspaceId: scan.marker.workspaceId,
    version: scan.marker.version,
    records: indexRecordCount(scan),
    indexDigest: scan.index.document.indexDigest ?? "",
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    ...(scan.marker.lastSweepAt === undefined ? {} : { lastSweepAt: scan.marker.lastSweepAt }),
    ...trailingDisclosure(scan),
  };
}

// TCRN-CROSS-SUB-414: the strict surfaces -- validate, a checkpoint and a rebase -- answer only for
// a crest this device's chain holds whole. A record written against chain events this device has not
// received (a partial restore that left the crest newer than the chain, or a folder that delivered a
// card before the chain events it was written against) refuses them, naming the records.
function assertChainHoldsCrest(scan: KnowledgeStoreScan): void {
  if (scan.awaitingChain.length === 0) return;
  fail("KNOWLEDGE_HIGH_WATER_MISMATCH", `${scan.awaitingChain.length} crest record(s) await chain events this device does not hold`, {
    awaitingChain: awaitingChainDiagnostic(scan.awaitingChain),
  });
}

function awaitingChainDiagnostic(entries: readonly AwaitingChainEntry[]): JsonValue {
  return entries.map((entry) => ({ id: entry.id, deviceId: entry.deviceId, sequence: entry.sequence, eventHash: entry.eventHash }));
}

// TCRN-CROSS-SUB-414 (R16, C-R16-1): validate and a checkpoint answer only for a crest whose live cards
// all resolve against the chain. While a card whose project the chain no longer holds is named in
// `unresolvedScopes`, they refuse with the code a read of such a card always met,
// KNOWLEDGE_LINK_INVALID (`<id>:scope`, the first card named), details naming every such record
// and the remedy: the one retirement there is (TCRN-CROSS-SUB-308), a card that supersedes it.
function assertScopesResolve(scan: CrestScan): void {
  const [first] = scan.unresolvedScopes;
  if (first === undefined) return;
  fail("KNOWLEDGE_LINK_INVALID", `${first.id}:scope`, unresolvedScopeDetails(scan.unresolvedScopes));
}

// What a strict surface's refusal carries for the cards whose project the chain no longer holds: the
// records, as knowledge-list names them, and the remedy that resolves them, naming every card.
function unresolvedScopeDetails(entries: readonly UnresolvedScopeEntry[]): Readonly<Record<string, JsonValue>> {
  const ids = [...new Set(entries.map((entry) => entry.id))];
  return {
    unresolvedScopes: unresolvedScopeDiagnostic(entries),
    remedy: ids.length === 1
      ? `write a card with knowledge-create --supersedes ${ids[0] as string}`
      : `write a card with knowledge-create --supersedes <id> for each of ${ids.join(", ")}`,
  };
}

function unresolvedScopeDiagnostic(entries: readonly UnresolvedScopeEntry[]): JsonValue {
  return entries.map((entry) => ({ id: entry.id, deviceId: entry.deviceId, sequence: entry.sequence, eventHash: entry.eventHash, projectId: entry.projectId }));
}

export async function validateKnowledgeStore(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanKnowledgeStore(workspaceRoot, options);
  assertScopesResolve(scan);
  assertChainHoldsCrest(scan);
  return {
    schemaVersion: "tcrn.knowledge-store-validation.v1",
    reasonCode: "KNOWLEDGE_STORE_VALID",
    workspaceId: scan.marker.workspaceId,
    version: scan.marker.version,
    records: indexRecordCount(scan),
    indexDigest: scan.index.document.indexDigest ?? "",
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    // TCRN-CROSS-SUB-310 R17: no `capacity` report. It measured the live card bodies against the
    // knowledge.aggregateBytes limit (TCRN-CROSS-SUB-309), and that limit is gone (MIN-238 D1).
    ...(scan.danglingWorkLinks.length === 0 ? {} : { danglingWorkLinks: scan.danglingWorkLinks }),
  };
}

/**
 * Write one card. TCRN-CROSS-STORY-476 R5: scope "user" writes it to this user's crest, under this
 * machine's lock of the user crest, and the crest's first card lays the crest out; the library at
 * `workspaceRoot` still supplies the language policy and the source files the card names. Every
 * other scope writes the library's crest: TCRN-CROSS-SUB-414, as an event appended to this device's
 * stream of it (createLibraryCrestEvent).
 */
export async function createKnowledgeUnit(workspaceRoot: string, input: CreateKnowledgeUnitInput, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  if (input.scope === "user") {
    const location = await locateUserCrest();
    return withUserCrestLock(location, async () => {
      const created = await createUserCrestEvent(workspaceRoot, input, options, location);
      await refreshUserCrestSnapshot(location, options);
      return created;
    });
  }
  return optimisticCrestWrite(workspaceRoot, (commitUnderLock) => createLibraryCrestEvent(workspaceRoot, input, options, commitUnderLock));
}

async function createUserCrestEvent(
  workspaceRoot: string,
  input: CreateKnowledgeUnitInput,
  options: KnowledgeMutationOptions,
  location: UserCrestLocation,
): Promise<Readonly<Record<string, JsonValue>>> {
  assertBoundedString(input.body, KNOWLEDGE_LIMITS.maximumBodyBytes, "body");
  const body = Buffer.from(input.body, "utf8");
  const workspace = await materializeWorkspace(workspaceRoot);
  const sourceDigest = input.sourceDigest && input.sourceDigest.length > 0
    ? input.sourceDigest
    : await calculateKnowledgeSourceDigest(workspaceRoot, scopedWorkspaceState(workspace, input.projectId ?? undefined), input.sourceReferences, input.body);
  const metadata = buildMetadata({ ...input, sourceDigest }, body, workspace, options.languageProvider, options.host);
  const { eventsRoot } = await ensureUserCrestEventRoot(location);
  const { device } = await readOrCreateDevice({ home: location.device });
  const streamPath = resolve(eventsRoot, device.deviceId);
  try {
    await mkdir(streamPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${streamPath}:${String(error)}`);
  }
  const streamRoot = await boundDirectory(streamPath, eventsRoot);
  const scan = await scanUserCrest(location, options, false, "metadata-only");
  const prior = scan.eventHeads.find((head) => head.deviceId === device.deviceId);
  const sequence = (prior?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) fail("KNOWLEDGE_LIMIT_EXCEEDED", "user crest event sequence");

  // TCRN-CROSS-SUB-413: a write sees every record the crest holds, each version of a duplicate as
  // much as a card: a conflict it scores against (named once per id) and an id and external key it
  // may not reuse. A write whose supersedes names a duplicate's id replaces every version of it at
  // once; it is refused only when every version is retired. TCRN-CROSS-SUB-310 R17 (MIN-238 D1): no
  // total of the crest's bodies admits or refuses it; its own card is held to KNOWLEDGE_LIMITS.
  // TCRN-CROSS-SUB-425: a removed card is terminal -- no write supersedes it, and no write scores
  // against it -- while its id and external key stay taken. The card a write supersedes is removed by
  // that write (conflict superseded).
  const records = crestRecords(scan);
  if (metadata.supersedes !== null) assertNotRemoved(scan, metadata.supersedes, REMOVED_WRITE_REMEDY);
  const replacedRecords = metadata.supersedes === null ? [] : records.filter((unit) => unit.metadata.id === metadata.supersedes);
  if (metadata.supersedes !== null && replacedRecords.every((unit) => unit.metadata.lifecycle === "retired")) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:supersedes:${metadata.supersedes}`);
  }
  const conflicts = [...new Set(knowledgeConflictHits(
    records.filter((unit) => !scan.removals.has(unit.metadata.id)).map((unit) => unit.metadata),
    metadata.subject,
    metadata.supersedes === null ? [metadata.id] : [metadata.id, metadata.supersedes],
  ))];
  if (conflicts.length > 0 && metadata.supersedes === null && input.coexist !== true) {
    fail("KNOWLEDGE_POSSIBLE_CONFLICT", conflicts.join(","), { conflicts: [...conflicts] });
  }
  // TCRN-CROSS-SUB-310: the conflicts this write saw and was admitted beside -- with --coexist, or
  // beside the card it supersedes -- are recorded in the card, so a reader tells them from a
  // conflict no writer saw (projectCrestUnits). A library's write records them the same way
  // (TCRN-CROSS-SUB-414, createLibraryCrestEvent).
  const written: KnowledgeUnitMetadata = conflicts.length === 0
    ? metadata
    : { ...metadata, extensions: { coexistsWith: conflicts.slice(0, KNOWLEDGE_LIMITS.maximumQueryResults) } };
  if (written !== metadata) validateMetadataBody(validateMetadataShape(written as unknown as Readonly<Record<string, JsonValue>>, null), body, null);
  const metadataBytes = Buffer.from(canonicalJson(written), "utf8");
  if (metadataBytes.length > KNOWLEDGE_LIMITS.maximumMetadataBytes) fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge create budget");
  if (records.some((unit) => unit.metadata.id === metadata.id || unit.metadata.externalKey === metadata.externalKey)) {
    fail("KNOWLEDGE_DUPLICATE", metadata.id);
  }

  // The records this write replaces are checked as the next read projects them, with their bodies.
  // A retired one is left as it is. A record of the metadata/body layout carries no body reader of
  // its own (a version of a duplicate can be one), so its body is read as an explicit read reads it.
  for (const unit of replacedRecords) {
    if (unit.metadata.lifecycle === "retired") continue;
    const supersededMetadata: KnowledgeUnitMetadata = {
      ...unit.metadata,
      extensions: { ...unit.metadata.extensions, supersededBy: written.id },
      revision: unit.metadata.revision + 1,
      updatedAt: input.occurredAt,
    };
    const oldBody = unit.body ?? (unit.readBody === undefined
      ? await userCrestBackend(scan.storeRoot, location.device, options).readKnowledgeBody(unit.metadata.id)
      : await unit.readBody());
    validateMetadataBody(validateExistingMetadataShape(supersededMetadata, null), oldBody, null);
  }

  const sequenceText = String(sequence).padStart(8, "0");
  const bodyFile = `${sequenceText}-${written.bodySha256}.body`;
  const bodyPath = resolve(streamRoot, bodyFile);
  await writeImmutableUserCrestFile(bodyPath, body, device.deviceId);
  crash("after-body-write", options.faultAt);
  const unsigned: Omit<UserCrestEvent, "eventHash"> = {
    schemaVersion: USER_CREST_EVENT_SCHEMA_VERSION,
    deviceId: device.deviceId,
    sequence,
    occurredAt: written.updatedAt,
    priorHash: prior?.eventHash ?? null,
    metadata: written,
    body: { file: bodyFile, sha256: written.bodySha256, bytes: written.bodyBytes },
  };
  const eventHash = canonicalSha256(unsigned as unknown as JsonValue);
  const event: UserCrestEvent = { ...unsigned, eventHash };
  const eventPath = resolve(streamRoot, `${sequenceText}-${eventHash}.json`);
  await writeImmutableUserCrestFile(eventPath, canonicalJson(event), device.deviceId);
  crash("after-metadata-write", options.faultAt);
  // The user crest root manifest is initialized once. Event heads carry the changing high-water
  // projection, so no multi-device writer performs a shared manifest update.
  crash("after-marker-write", options.faultAt);
  // TCRN-CROSS-SUB-425 (MIN-239 D4): this device's stream gives up the bodies of the removed cards,
  // the one this write superseded among them.
  await clearRemovedBodies(scan, device.deviceId, [...scan.removals.keys(), ...(metadata.supersedes === null ? [] : [metadata.supersedes])]);
  // TCRN-CROSS-SUB-310 (R14 (d)): the event is committed, so the answer is the write's own: nothing
  // after this point re-reads the crest. An event another device delivered meanwhile cannot turn a
  // committed write into a refusal; the next read reports any conflict it forms. The version is
  // the one this write's scan projected, advanced by this event.
  return {
    schemaVersion: "tcrn.knowledge-create-result.v1",
    reasonCode: "KNOWLEDGE_UNIT_CREATED",
    id: written.id,
    externalKey: written.externalKey,
    revision: written.revision,
    version: scan.marker.version + 1,
    scope: "user",
    ...(conflicts.length > 0 ? { conflicts: [...conflicts] } : {}),
    ...(metadata.supersedes === null ? {} : { superseded: metadata.supersedes }),
  };
}

// TCRN-CROSS-SUB-414: where this device appends to a library's crest -- its own stream,
// crest/events/<device id>/, laid out by its first write -- and the head the write continues.
interface LibraryCrestStream {
  readonly streamRoot: string;
  readonly deviceId: string;
  readonly prior: CrestEventHead | undefined;
}

async function libraryCrestStream(scan: KnowledgeStoreScan): Promise<LibraryCrestStream> {
  const eventsPath = resolve(scan.storeRoot, CREST_EVENTS_DIRECTORY);
  try {
    await mkdir(eventsPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${eventsPath}:${String(error)}`);
  }
  const eventsRoot = await boundDirectory(eventsPath, scan.storeRoot);
  const { device } = await readOrCreateDevice({ home: deviceHome() });
  const streamPath = resolve(eventsRoot, device.deviceId);
  try {
    await mkdir(streamPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${streamPath}:${String(error)}`);
  }
  const streamRoot = await boundDirectory(streamPath, eventsRoot);
  return { streamRoot, deviceId: device.deviceId, prior: scan.eventHeads.find((head) => head.deviceId === device.deviceId) };
}

// TCRN-CROSS-SUB-414 (STORY-476 D7, MIN-235 D7): append one record to this device's stream of a
// library's crest as the event after the head the write's scan read: its body first, then the event
// that commits it, each created exclusively and never replaced. The event names the chain the write
// was checked against and, for a card written again, the stored record it replaces. Nothing else of
// the crest is written: not the root manifest, not another device's stream, not the metadata/body
// layout, and no claim is taken; this machine's lock of the library is what serialises the writers
// of this one stream.
async function appendLibraryCrestEvent(
  scan: KnowledgeStoreScan,
  metadata: KnowledgeUnitMetadata,
  body: Buffer | null,
  replaces: CrestUnit | null,
  faultAt: KnowledgeFaultPoint | undefined,
): Promise<CrestEventHead> {
  const stream = await libraryCrestStream(scan);
  const sequence = (stream.prior?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) fail("KNOWLEDGE_LIMIT_EXCEEDED", "crest event sequence");
  const chain = chainPositions(scan.workspace);
  if (chain.length > CREST_EVENT_CHAIN_LIMIT) fail("KNOWLEDGE_LIMIT_EXCEEDED", "crest event chain");
  const sequenceText = String(sequence).padStart(8, "0");
  let reference: LibraryCrestEvent["body"] = null;
  if (body !== null) {
    reference = { file: `${sequenceText}-${metadata.bodySha256}.body`, sha256: metadata.bodySha256, bytes: metadata.bodyBytes };
    await writeImmutableUserCrestFile(resolve(stream.streamRoot, reference.file), body, stream.deviceId);
  }
  crash("after-body-write", faultAt);
  const unsigned: Omit<LibraryCrestEvent, "eventHash"> = {
    schemaVersion: CREST_EVENT_SCHEMA_VERSION,
    deviceId: stream.deviceId,
    sequence,
    occurredAt: metadata.updatedAt,
    priorHash: stream.prior?.eventHash ?? null,
    chain,
    replaces: replaces?.storedDigest ?? null,
    metadata,
    body: reference,
  };
  const eventHash = canonicalSha256(unsigned as unknown as JsonValue);
  const event = canonicalJson({ ...unsigned, eventHash } as unknown as JsonValue);
  if (Buffer.byteLength(event, "utf8") > CREST_EVENT_MAXIMUM_BYTES) fail("KNOWLEDGE_LIMIT_EXCEEDED", "crest event");
  await writeImmutableUserCrestFile(resolve(stream.streamRoot, `${sequenceText}-${eventHash}.json`), event, stream.deviceId);
  crash("after-metadata-write", faultAt);
  // The root manifest is not written: the event is the commit (initializeKnowledgeStore).
  crash("after-marker-write", faultAt);
  return { deviceId: stream.deviceId, sequence, eventHash };
}

// TCRN-CROSS-SUB-414: this device's index view once a write's event is committed, projected from the
// write's own scan and the record it appended: what the next read projects, unless another device's
// events arrive first, and then that read projects it again. It is a cache in the device directory,
// and failing to write it never fails the write. TCRN-CROSS-SUB-428 (INC-398; R14 (d)): nor does
// anything else here -- building the index or projecting it -- turn the committed write into a
// refusal; what fails is left for the next read, which projects the view again.
async function projectViewAfterWrite(scan: KnowledgeStoreScan, records: readonly KnowledgeIndexRecord[], options: KnowledgeReadOptions): Promise<void> {
  try {
    await writeIndex(libraryKnowledgeView(scan.storeRoot, options), { ...scan.marker, version: scan.marker.version + 1 }, records);
  } catch {
    // Left for the next read to project again.
  }
}

// A crest record's body, as an explicit read reads it: from its event stream, or through the store
// backend for the metadata/body layout.
async function crestRecordBody(scan: KnowledgeStoreScan, unit: CrestUnit, options: KnowledgeReadOptions): Promise<Buffer> {
  if (unit.body !== null) return unit.body;
  return unit.readBody === undefined ? storeBackendFor(scan.storeRoot, options).readKnowledgeBody(unit.metadata.id) : unit.readBody();
}

// TCRN-CROSS-SUB-414: write one card to a library's crest, as an event in this device's stream. The
// write reads the whole crest first -- every writer's records merged -- and sees every record of it:
// a card or a version of a duplicate is a conflict it scores against (named once per id), and an id
// and external key it may not reuse; no total of the crest's bodies admits or refuses it
// (TCRN-CROSS-SUB-310 R17, MIN-238 D1). A write whose supersedes names a duplicate's id replaces
// every version of it; the replaced card is not rewritten, since a read
// projects the mark from this card's supersedes. The conflicts the write saw and was admitted beside
// -- with --coexist, or beside the card it supersedes -- are recorded in the new card (SUB-310 (a)),
// so a reader tells them from a conflict no writer saw. A committed event is answered from the
// write's own scan, its version the scanned one plus one: nothing another device delivers meanwhile
// can turn it into a refusal, and the next read reports any conflict it forms.
async function createLibraryCrestEvent(
  workspaceRoot: string,
  input: CreateKnowledgeUnitInput,
  options: KnowledgeMutationOptions,
  commitUnderLock: CrestCommit,
): Promise<Readonly<Record<string, JsonValue>>> {
  assertBoundedString(input.body, KNOWLEDGE_LIMITS.maximumBodyBytes, "body");
  await assertKnowledgeWritable(resolve(workspaceRoot));
  const body = Buffer.from(input.body, "utf8");
  const workspace = await materializeWorkspace(workspaceRoot);
  const sourceDigest = input.sourceDigest && input.sourceDigest.length > 0
    ? input.sourceDigest
    : await calculateKnowledgeSourceDigest(workspaceRoot, scopedWorkspaceState(workspace, input.projectId ?? undefined), input.sourceReferences, input.body);
  const metadata = buildMetadata({ ...input, sourceDigest }, body, workspace, options.languageProvider, options.host);
  const scan = await mutationAdmissionScan(workspaceRoot, options);
  // The chain the event will name is the one the scan read, so the card's links are held to it.
  validateMetadataLinks(metadata, scan.workspace);
  // TCRN-CROSS-SUB-425: a removed card is terminal -- no write supersedes it and none scores against
  // it -- while its id and external key stay taken; the card this write supersedes it removes.
  const records = crestRecords(scan);
  if (metadata.supersedes !== null) assertNotRemoved(scan, metadata.supersedes, REMOVED_WRITE_REMEDY);
  const replacedRecords = metadata.supersedes === null ? [] : records.filter((unit) => unit.metadata.id === metadata.supersedes);
  if (metadata.supersedes !== null && replacedRecords.every((unit) => unit.metadata.lifecycle === "retired")) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:supersedes:${metadata.supersedes}`);
  }
  // TCRN-CROSS-STORY-365: score before writing. Above the threshold the writer must have said which
  // it is -- this card replaces those (--supersedes) or stands beside them (--coexist) -- and the
  // refusal hands back the hit list rather than only naming it.
  const conflicts = [...new Set(knowledgeConflictHits(
    records.filter((unit) => !scan.removals.has(unit.metadata.id)).map((unit) => unit.metadata),
    metadata.subject,
    metadata.supersedes === null ? [metadata.id] : [metadata.id, metadata.supersedes],
  ))];
  if (conflicts.length > 0 && metadata.supersedes === null && input.coexist !== true) {
    fail("KNOWLEDGE_POSSIBLE_CONFLICT", conflicts.join(","), { conflicts: [...conflicts] });
  }
  const written: KnowledgeUnitMetadata = conflicts.length === 0
    ? metadata
    : { ...metadata, extensions: { coexistsWith: conflicts.slice(0, KNOWLEDGE_LIMITS.maximumQueryResults) } };
  if (written !== metadata) validateMetadataBody(validateMetadataShape(written as unknown as Readonly<Record<string, JsonValue>>, scan.workspace), body, scan.workspace);
  // The records this write replaces, as the next read projects them. A retired one is left as it is.
  const replaced = new Map<CrestUnit, KnowledgeUnitMetadata>();
  for (const unit of replacedRecords) {
    if (unit.metadata.lifecycle === "retired") continue;
    const supersededMetadata: KnowledgeUnitMetadata = {
      ...unit.metadata,
      extensions: { ...unit.metadata.extensions, supersededBy: written.id },
      revision: unit.metadata.revision + 1,
      updatedAt: input.occurredAt,
    };
    validateMetadataBody(validateMetadataShape(supersededMetadata as unknown as Readonly<Record<string, JsonValue>>, scan.workspace, true), await crestRecordBody(scan, unit, options), scan.workspace);
    replaced.set(unit, supersededMetadata);
  }
  if (Buffer.byteLength(canonicalJson(written), "utf8") > KNOWLEDGE_LIMITS.maximumMetadataBytes) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge create budget");
  }
  // The records once this write lands, which this device's index view projects after it: the card it
  // supersedes is removed (TCRN-CROSS-SUB-425).
  const removalsAfter = metadata.supersedes === null
    ? scan.removals
    : new Map<string, CrestRemoval>([...scan.removals, [metadata.supersedes, supersessionRemoval(metadata.supersedes, written)]]);
  const projectedMetadata = indexRecords(records.map((unit) => replaced.get(unit) ?? unit.metadata).concat(written), removalsAfter);
  if (records.some((unit) => unit.metadata.id === metadata.id || unit.metadata.externalKey === metadata.externalKey)) {
    fail("KNOWLEDGE_DUPLICATE", metadata.id);
  }
  await commitUnderLock(scan, async () => {
    const head = await appendLibraryCrestEvent(scan, written, body, null, options.faultAt);
    await clearRemovedBodies(scan, head.deviceId, removalsAfter.keys());
    await projectViewAfterWrite(scan, projectedMetadata, options);
  });
  return {
    schemaVersion: "tcrn.knowledge-create-result.v1",
    reasonCode: "KNOWLEDGE_UNIT_CREATED",
    id: written.id,
    externalKey: written.externalKey,
    revision: written.revision,
    version: scan.marker.version + 1,
    ...(conflicts.length > 0 ? { conflicts: [...conflicts] } : {}),
    ...(metadata.supersedes === null ? {} : { superseded: metadata.supersedes }),
  };
}

// TCRN-CROSS-SUB-425: a removal as knowledge-remove admits it, checked before anything is read.
interface NormalizedRemoval {
  readonly occurredAt: string;
  readonly id: string;
  readonly reason: KnowledgeRemovalReason;
  readonly basis: string;
  readonly actor: string;
  readonly supersededBy: string | null;
}

function normalizeRemoveInput(input: KnowledgeRemoveInput): NormalizedRemoval {
  if (typeof input.id !== "string" || !knowledgeIdPattern.test(input.id)) fail("KNOWLEDGE_INPUT_INVALID", `id=${String(input.id)}`);
  try { assertStrictInstant(input.occurredAt); } catch (error) { fail("KNOWLEDGE_INPUT_INVALID", String(error)); }
  if (!(KNOWLEDGE_REMOVAL_REASONS as readonly unknown[]).includes(input.reason)) fail("KNOWLEDGE_INPUT_INVALID", `reason=${String(input.reason)}`);
  if (typeof input.basis !== "string" || input.basis.trim().length === 0 || !input.basis.isWellFormed()) fail("KNOWLEDGE_INPUT_INVALID", "basis");
  if (Buffer.byteLength(input.basis, "utf8") > KNOWLEDGE_REMOVAL_BASIS_BYTES) fail("KNOWLEDGE_LIMIT_EXCEEDED", "basis");
  try { assertActorId(input.actor); } catch { fail("KNOWLEDGE_INPUT_INVALID", `actor=${String(input.actor)}`); }
  const supersededBy = input.supersededBy ?? null;
  if (input.reason === "superseded") {
    if (supersededBy === null || !knowledgeIdPattern.test(supersededBy) || supersededBy === input.id) {
      fail("KNOWLEDGE_INPUT_INVALID", "the reason superseded names the card that supersedes it (supersededBy)");
    }
  } else if (supersededBy !== null) {
    fail("KNOWLEDGE_INPUT_INVALID", `supersededBy is named only for the reason superseded, not ${input.reason}`);
  }
  return { occurredAt: input.occurredAt, id: input.id, reason: input.reason, basis: input.basis, actor: input.actor, supersededBy };
}

// What a crest must hold for a removal to be written: the card, not removed yet, and, for the reason
// superseded, the card that supersedes it, itself valid. Answers the removed card's first record.
function assertRemovable(scan: CrestScan, removal: NormalizedRemoval): KnowledgeUnitMetadata {
  const records = crestRecords(scan);
  const card = records.find((unit) => unit.metadata.id === removal.id);
  if (card === undefined) fail("KNOWLEDGE_NOT_FOUND", removal.id);
  assertNotRemoved(scan, removal.id, REMOVED_WRITE_REMEDY);
  if (removal.supersededBy !== null) {
    if (!records.some((unit) => unit.metadata.id === removal.supersededBy)) fail("KNOWLEDGE_LINK_INVALID", `${removal.id}:supersededBy:${removal.supersededBy}`);
    assertNotRemoved(scan, removal.supersededBy, REMOVED_WRITE_REMEDY);
  }
  return card.metadata;
}

// TCRN-CROSS-SUB-425: append one removal to a device's own stream of a crest, as the event after the
// head the removal's scan read, created exclusively and never replaced. It carries no body: nothing
// is written before it, and the event is the commit.
async function appendCrestRemovalEvent(
  streamRoot: string,
  deviceId: string,
  prior: CrestEventHead | undefined,
  removal: NormalizedRemoval,
  faultAt: KnowledgeFaultPoint | undefined,
): Promise<CrestEventHead> {
  const sequence = (prior?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) fail("KNOWLEDGE_LIMIT_EXCEEDED", "crest event sequence");
  crash("after-body-write", faultAt);
  const unsigned: Omit<CrestRemovalEvent, "eventHash"> = {
    schemaVersion: CREST_REMOVAL_SCHEMA_VERSION,
    deviceId,
    sequence,
    occurredAt: removal.occurredAt,
    priorHash: prior?.eventHash ?? null,
    removal: { id: removal.id, reason: removal.reason, basis: removal.basis, actor: removal.actor, supersededBy: removal.supersededBy },
  };
  const eventHash = canonicalSha256(unsigned as unknown as JsonValue);
  const event = canonicalJson({ ...unsigned, eventHash } as unknown as JsonValue);
  await writeImmutableUserCrestFile(resolve(streamRoot, `${String(sequence).padStart(8, "0")}-${eventHash}.json`), event, deviceId);
  crash("after-metadata-write", faultAt);
  crash("after-marker-write", faultAt);
  return { deviceId, sequence, eventHash };
}

// The removal a committed removal event makes, as the next read projects it.
function eventRemoval(removal: NormalizedRemoval, head: CrestEventHead): CrestRemoval {
  return {
    id: removal.id, reason: removal.reason, basis: removal.basis, actor: removal.actor, removedAt: removal.occurredAt,
    supersededBy: removal.supersededBy, deviceId: head.deviceId, sequence: head.sequence, eventHash: head.eventHash,
  };
}

// A committed removal's answer: the card as it is now kept, the version the write's scan projected
// advanced by this event, and how many body files this device's own stream gave up.
function removalAnswer(
  card: KnowledgeUnitMetadata,
  removal: CrestRemoval,
  version: number,
  clearedBodies: number,
  disclosure: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  return {
    schemaVersion: "tcrn.knowledge-remove-result.v1",
    reasonCode: "KNOWLEDGE_UNIT_REMOVED",
    ...disclosure,
    id: card.id,
    externalKey: card.externalKey,
    subject: card.subject,
    removal: removalDiagnostic(removal),
    version,
    clearedBodies,
  };
}

/**
 * TCRN-CROSS-SUB-425 (TCRN-CROSS-STORY-514 R1, R3; MIN-239 D3, D4, D5): remove one card, from the
 * library's crest or, with `options.scope` "user", from this user's crest. The removal names its
 * reason -- superseded (with the card that supersedes it), invalid, or duplicate (it repeats a work
 * item or a decision) -- its basis and its actor, and it is terminal: a removed card is refused a
 * second removal, a supersede, a re-verification, a policy update, an article refresh, and every read
 * of its snippet or body; there is no verb that restores it. It is written as a removal event in this
 * device's stream of the crest, after the whole crest is read, under this machine's lock of it; no
 * event file is deleted, and this device's stream then gives up the bodies of every removed card it
 * holds (clearRemovedBodies). Another device reads the removal once the crest delivers it, and clears
 * its own stream's bodies at its next write. A committed removal is answered from its own scan.
 */
export async function removeKnowledgeUnit(workspaceRoot: string, input: KnowledgeRemoveInput, options: KnowledgeRemoveOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertStoreScope(options.scope);
  const removal = normalizeRemoveInput(input);
  if (options.scope === "user") {
    const location = await locateUserCrest();
    if (!(await userCrestInitialized(location.root))) fail("KNOWLEDGE_NOT_FOUND", removal.id);
    return withUserCrestLock(location, async () => {
      const removed = await removeUserCrestCard(location, removal, options);
      await refreshUserCrestSnapshot(location, options);
      return removed;
    });
  }
  return optimisticCrestWrite(workspaceRoot, (commitUnderLock) => removeLibraryCrestCard(workspaceRoot, removal, options, commitUnderLock));
}

async function removeLibraryCrestCard(workspaceRoot: string, removal: NormalizedRemoval, options: KnowledgeRemoveOptions, commitUnderLock: CrestCommit): Promise<Readonly<Record<string, JsonValue>>> {
  await assertKnowledgeWritable(resolve(workspaceRoot));
  const scan = await mutationAdmissionScan(workspaceRoot, options);
  const card = assertRemovable(scan, removal);
  const { removed, clearedBodies } = await commitUnderLock(scan, async () => {
    const stream = await libraryCrestStream(scan);
    const head = await appendCrestRemovalEvent(stream.streamRoot, stream.deviceId, stream.prior, removal, options.faultAt);
    const appended = eventRemoval(removal, head);
    const removalsAfter = new Map<string, CrestRemoval>([...scan.removals, [removal.id, appended]]);
    const cleared = await clearRemovedBodies(scan, head.deviceId, removalsAfter.keys());
    await projectViewAfterWrite(scan, indexRecords(crestRecords(scan).map((unit) => unit.metadata), removalsAfter), options);
    return { removed: appended, clearedBodies: cleared };
  });
  return removalAnswer(card, removed, scan.marker.version + 1, clearedBodies, {});
}

async function removeUserCrestCard(location: UserCrestLocation, removal: NormalizedRemoval, options: KnowledgeRemoveOptions): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanUserCrest(location, options, false, "metadata-only");
  const card = assertRemovable(scan, removal);
  const { eventsRoot } = await ensureUserCrestEventRoot(location);
  const { device } = await readOrCreateDevice({ home: location.device });
  const streamPath = resolve(eventsRoot, device.deviceId);
  try {
    await mkdir(streamPath, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") fail("KNOWLEDGE_PATH_INVALID", `${streamPath}:${String(error)}`);
  }
  const streamRoot = await boundDirectory(streamPath, eventsRoot);
  const prior = scan.eventHeads.find((head) => head.deviceId === device.deviceId);
  const head = await appendCrestRemovalEvent(streamRoot, device.deviceId, prior, removal, options.faultAt);
  const removed = eventRemoval(removal, head);
  const clearedBodies = await clearRemovedBodies(scan, device.deviceId, [...scan.removals.keys(), removal.id]);
  return removalAnswer(card, removed, scan.marker.version + 1, clearedBodies, USER_CREST_DISCLOSURE);
}

// TCRN-CROSS-SUB-414: the card a re-verification, a policy update or an article refresh writes
// again: the one card of that id. An id two writers wrote before either saw the other's is not one
// card, and is refused (KNOWLEDGE_DUPLICATE) until a card that supersedes it resolves it.
// TCRN-CROSS-SUB-425: a removed card is not written again, whatever removed it (KNOWLEDGE_CARD_REMOVED).
function libraryCrestCard(scan: KnowledgeStoreScan, id: string): CrestUnit {
  assertNotRemoved(scan, id, REMOVED_WRITE_REMEDY);
  if (scan.duplicates.some((duplicate) => duplicate.id === id)) fail("KNOWLEDGE_DUPLICATE", id);
  const unit = scan.units.find((entry) => entry.metadata.id === id);
  if (unit === undefined) fail("KNOWLEDGE_NOT_FOUND", id);
  return unit;
}

export async function createKnowledgeArticle(
  workspaceRoot: string,
  input: KnowledgeArticleCreateInput,
  options: KnowledgeMutationOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  try { assertStrictInstant(input.occurredAt); } catch (error) { fail("KNOWLEDGE_INPUT_INVALID", String(error)); }
  if (!ARTICLE_CATEGORY_VALUES.includes(input.category)) fail("KNOWLEDGE_INPUT_INVALID", "article category");
  assertArticleField(input.title, RUNTIME_CAPACITY.bufferBytes, "article title");
  assertArticleField(input.summary, KNOWLEDGE_LIMITS.maximumSummaryBytes, "article summary");
  if (typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > KNOWLEDGE_LIMITS.maximumArticleBytes) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "article content");
  }
  try {
    assertProtocolId(input.accountableOwnerId);
  } catch (error) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", `accountable owner:${String(error)}`);
  }
  if (!input.accountableOwnerId.startsWith("owner:")) fail("KNOWLEDGE_PROVENANCE_INVALID", "article accountable owner");
  if (!Array.isArray(input.linkedEvidenceIds) || input.linkedEvidenceIds.length === 0) {
    fail("KNOWLEDGE_PROVENANCE_INVALID", "article evidence links");
  }
  for (const evidenceId of input.linkedEvidenceIds) {
    try { assertProtocolId(evidenceId); } catch (error) { fail("KNOWLEDGE_PROVENANCE_INVALID", String(error)); }
    if (!evidenceId.startsWith("evidence:")) fail("KNOWLEDGE_PROVENANCE_INVALID", evidenceId);
  }
  const workspace = scopedWorkspaceState(await materializeWorkspace(workspaceRoot), input.projectId);
  const article = await articlePathFor(workspaceRoot, workspace, input.path);
  const markdown = articleMarkdown(input.category, input.title, input.content);
  const body = articleIndexBody(input.title, input.summary, input.path);
  const articleBytes = await writeArticleBytes(article.file, markdown, false);
  const sourceDigest = sha256(articleBytes);
  const externalKey = `ARTICLE-${sha256(input.projectId === undefined ? input.path : canonicalJson({ projectId: input.projectId, path: input.path })).slice(0, 24).toUpperCase()}`;
  try {
    const created = await createKnowledgeUnit(workspaceRoot, {
      occurredAt: input.occurredAt,
      externalKey,
      scope: input.projectId === undefined ? "workspace" : "project",
      projectId: input.projectId ?? null,
      roleScopes: [],
      category: input.category,
      kind: "reference",
      tags: ["article", input.category],
      subject: input.title,
      summary: input.summary,
      snippet: truncateArticleUtf8(input.summary, KNOWLEDGE_LIMITS.maximumSnippetBytes),
      accountableOwnerId: input.accountableOwnerId,
      sourceReferences: articleSourceReference(input.path),
      sourceDigest,
      supersedes: null,
      linkedWorkIds: [],
      linkedDecisionIds: [],
      linkedGateIds: [],
      linkedEvidenceIds: input.linkedEvidenceIds,
      lifecycle: "active",
      retrievalDisposition: "explicit-only",
      freshnessState: "fresh",
      lastVerified: input.occurredAt,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only",
      body,
    }, options);
    return {
      ...created,
      schemaVersion: "tcrn.knowledge-article-create-result.v1",
      reasonCode: "KNOWLEDGE_ARTICLE_CREATED",
      path: article.file,
      articlePath: input.path,
      articleBytes: articleBytes.length,
      sourceDigest,
      bodyBytes: Buffer.byteLength(body, "utf8"),
      category: input.category,
      title: input.title,
      summary: input.summary,
    };
  } catch (error) {
    await removeArticleIfExact(article.file, articleBytes);
    throw error;
  }
}

export interface CaptureKnowledgeUnitInput {
  readonly occurredAt: string;
  readonly subject: string;
  readonly summary: string;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly accountableOwnerId: string;
  readonly body: string;
  readonly externalKey?: string;
  readonly roleScopes?: readonly string[];
  readonly category?: KnowledgeCategory;
  readonly kind?: KnowledgeKind;
  readonly sourceReferences?: readonly string[];
  readonly linkedEvidenceIds?: readonly string[];
  readonly supersedes?: string | null;
  readonly coexist?: boolean;
  // TCRN-CROSS-STORY-476 R5 (TCRN-CROSS-SUB-311): where the card applies, and so where it is
  // stored. Left out it is a role card in the library's crest, as a capture always was;
  // "workspace" is a card of the whole library, and "user" a card of this user's crest, recalled
  // in every project. Neither of those two names a role.
  readonly scope?: "role" | "workspace" | "project" | "user";
  readonly projectId?: string;
}

/**
 * TCRN-CROSS-STORY-365: the thin capture path, under Owner ruling TCRN-CROSS-MIN-146.
 *
 * Everything a lesson card does not need to state is defaulted here rather than demanded
 * of the caller: a role-scoped, workspace-anchored card with no project, no work, decision
 * or gate backlinks, no clock-driven staleness and no promotion step. What is left is the
 * card itself -- what it is about, what it says, how to find it, and who is accountable
 * for it -- plus the instant and the store this write lands in.
 *
 * The store version is optional because the caller of this verb is a Stop hook with no
 * reason to have read the marker first. Supplied, it is the ordinary compare-and-set;
 * omitted, it is read here and this machine's lock of the store is what serialises writers
 * (TCRN-CROSS-SUB-414: a library card is an event appended to this device's stream).
 */
export async function captureKnowledgeUnit(
  workspaceRoot: string,
  input: CaptureKnowledgeUnitInput,
  options: KnowledgeMutationOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  // A derived key so the hook never has to invent one, and so the same lesson written
  // twice at the same instant is a duplicate rather than a second card.
  const externalKey = input.externalKey ??
    `CAPTURE-${createHash("sha256").update(`${input.projectId === undefined ? "" : input.projectId + "\u0000"}${input.subject}\u0000${input.body}\u0000${input.occurredAt}`, "utf8").digest("hex").slice(0, 24).toUpperCase()}`;
  const scope = input.scope ?? "role";
  if ((scope === "project") !== (input.projectId !== undefined)) fail("KNOWLEDGE_INPUT_INVALID", "a project capture requires its stable project id; other scopes do not accept one");
  return createKnowledgeUnit(workspaceRoot, {
    occurredAt: input.occurredAt,
    externalKey,
    scope,
    projectId: input.projectId ?? null,
    roleScopes: input.roleScopes ?? (scope === "role" ? ["implementation"] : []),
    category: input.category ?? "workflow",
    kind: input.kind ?? "fact",
    tags: input.tags,
    subject: input.subject,
    summary: input.summary,
    snippet: input.snippet,
    accountableOwnerId: input.accountableOwnerId,
    sourceReferences: input.sourceReferences ?? [],
    sourceDigest: null,
    supersedes: input.supersedes ?? null,
    linkedWorkIds: [],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: input.linkedEvidenceIds ?? [],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: null,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: input.body,
    ...(input.coexist === undefined ? {} : { coexist: input.coexist }),
  }, options);
}

// WSC-2: re-validate every record against the advanced workspace head. Invalid scope/project links
// still block the rebase; dangling work links remain attached and are reported without blocking
// access.
//
// TCRN-CROSS-SUB-414 (MIN-235 D7): a rebase no longer re-binds anything. A library crest's marker is
// projected by every read at the chain head that read replayed (scanLibraryCrest), so there is no
// stored high water to move, and rebasing writes nothing: not store.json, not a claim, not an event.
// It is the full re-validation it always was -- every record's shape, body binding and links against
// the chain as it stands -- refused as KNOWLEDGE_REBASE_BLOCKED for a scope/project offender and as
// KNOWLEDGE_HIGH_WATER_MISMATCH for a record this device's chain does not hold yet; answered, it
// reports the projected version and the chain head, and this device's index view is projected
// again. knowledge-rebase and knowledge-batch --align-first stay accepted and answer the same shape.
export async function rebaseKnowledgeStore(...args: Parameters<typeof rebaseKnowledgeStoreUnlocked>): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(args[0], () => rebaseKnowledgeStoreUnlocked(...args));
}

async function rebaseKnowledgeStoreUnlocked(workspaceRoot: string, input: {
  readonly at: string;
}, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(input.at);
  await assertKnowledgeWritable(resolve(workspaceRoot));
  const scan = await mutationAdmissionScan(workspaceRoot, options, true);
  // Scope/project offenders still block rebase. Dangling linked work is diagnostic only; the rebase
  // retires and rewrites nothing. TCRN-CROSS-SUB-414 (R16): an offender whose project alone no longer
  // resolves is named with its record and the remedy, as validate names it; one a card superseded is
  // no longer live, and no longer an offender.
  const offenders = scan.linkInvalid;
  if (offenders.length > 0) {
    fail("KNOWLEDGE_REBASE_BLOCKED", offenders.join(","), scan.unresolvedScopes.length === 0 ? undefined : unresolvedScopeDetails(scan.unresolvedScopes));
  }
  assertChainHoldsCrest(scan);
  return {
    schemaVersion: "tcrn.knowledge-rebase-result.v1",
    reasonCode: "KNOWLEDGE_STORE_REBASED",
    version: scan.marker.version,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    // The v1 result keeps its two fields: a rebase that lands retired nothing and had no
    // scope/project offender, since such an offender still refuses it.
    retired: 0,
    offenders: [],
    ...(scan.danglingWorkLinks.length === 0 ? {} : { danglingWorkLinks: scan.danglingWorkLinks }),
  };
}

interface NormalizedListQuery {
  readonly selection: "default" | "all";
  readonly status: KnowledgeStatusFilter;
  readonly search: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

// TCRN-CROSS-SUB-425: a status filter a read names, "valid" when it names none.
function assertStatusFilter(status: unknown): asserts status is KnowledgeStatusFilter {
  if (!(KNOWLEDGE_STATUS_FILTERS as readonly unknown[]).includes(status)) fail("KNOWLEDGE_SELECTION_INVALID", `status=${String(status)}`);
}

// WSC-4: the metadata selection behind listKnowledgeMetadata. (The WSC-7 context-route
// bridge that shared it went with the context router, TCRN-CROSS-STORY-467 R2.)
function normalizeListQuery(query: KnowledgeListQuery): NormalizedListQuery {
  assertEvaluationInstant(query.at);
  const selection = query.selection ?? "default";
  assertSelection(selection);
  const status = query.status ?? "valid";
  assertStatusFilter(status);
  let search: string | undefined;
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length === 0 || !query.search.isWellFormed()) {
      fail("KNOWLEDGE_INPUT_INVALID", "search term");
    }
    search = query.search.toLowerCase();
  }
  // Annotated because the default comes from a literal-typed limits constant; the
  // variable really holds whichever caller-supplied page size is within bounds.
  let limit: number = KNOWLEDGE_QUERY_DEFAULT_RESULTS;
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > Number.MAX_SAFE_INTEGER) {
      fail("KNOWLEDGE_INPUT_INVALID", "limit");
    }
    limit = query.limit;
  }
  let offset = 0;
  if (query.offset !== undefined) {
    if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
      fail("KNOWLEDGE_INPUT_INVALID", "offset");
    }
    offset = query.offset;
  }
  return { selection, status, search, limit, offset };
}

function occurrenceCount(text: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(token, offset);
    if (found < 0) break;
    count += 1;
    offset = found + token.length;
  }
  return count;
}

function relevanceTokens(search: string): readonly string[] {
  const tokens = [...search.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]+|[一-鿿]+/gu)].map((match) => match[0]);
  return tokens.length === 0 ? [search.toLowerCase()] : [...new Set(tokens)];
}

// STORY-321: this is intentionally a small, dependency-free field-weighted
// scorer. Subject and exact tags carry the strongest signal, summary carries
// supporting context, and snippet carries bounded detail. Ties retain the old
// canonical-id order, while different queries can change the order whenever
// their field matches differ.
export function knowledgeRelevanceScore(metadata: KnowledgeUnitMetadata, search: string | undefined): number {
  if (search === undefined) return 0;
  const tokens = relevanceTokens(search);
  const subject = metadata.subject.toLowerCase();
  const summary = metadata.summary.toLowerCase();
  const snippet = metadata.snippet.toLowerCase();
  return tokens.reduce((score, token) => score
    + occurrenceCount(subject, token) * 8
    + occurrenceCount(summary, token) * 4
    + occurrenceCount(snippet, token) * 2
    + metadata.tags.reduce((tagScore, tag) => tagScore + (tag.toLowerCase() === token ? 12 : occurrenceCount(tag.toLowerCase(), token) * 3), 0), 0);
}

// TCRN-CROSS-STORY-365: the write-time conflict threshold, in the units the scorer above
// already produces. A subject-field token hit is worth 8, so 16 is two of them: the point
// at which an existing card is about the same thing rather than merely sharing one word.
// A one-token subject therefore cannot by itself raise a conflict -- with a single token
// the scorer has nothing to discriminate on, and a verdict drawn from it would fire on
// every card that happens to contain the word.
export const KNOWLEDGE_CONFLICT_SCORE_THRESHOLD = 16 as const;

/** Live cards that score at or above the threshold against a subject, in canonical id order. */
export function knowledgeConflictHits(
  existing: readonly KnowledgeUnitMetadata[],
  subject: string,
  excluded: readonly string[] = [],
): readonly string[] {
  return existing
    .filter((metadata) => metadata.lifecycle !== "retired" && metadata.extensions?.supersededBy === undefined && !excluded.includes(metadata.id) &&
      knowledgeRelevanceScore(metadata, subject) >= KNOWLEDGE_CONFLICT_SCORE_THRESHOLD)
    .map((metadata) => metadata.id)
    .sort(compareCanonicalText);
}

// TCRN-CROSS-INC-282: the searched selection reads promotionState the same way the default
// one does. Two selections disagreeing about which cards exist is how a card gets listed
// and then cannot be found by the words it stores.
function explicitlySelectable(metadata: KnowledgeUnitMetadata, at: string): boolean {
  return metadata.extensions.supersededBy === undefined && metadata.promotionState !== "rejected" && metadata.lifecycle === "active" &&
    metadata.retrievalDisposition !== "excluded" && metadata.exportDisposition === "metadata-only" &&
    computeFreshness(metadata, at) !== "stale";
}

// TCRN-CROSS-STORY-362 requirement 4. This filter used to demand that the whole search
// string appear inside one field, while the scorer directly above it already worked in
// tokens. The two therefore disagreed: a two-word search returned nothing unless those
// two words sat adjacent in one field, so the filter refused exactly what the scorer
// was built to rank, and a Chinese search -- one contiguous run, one token to the
// scorer, one long literal to the filter -- matched only a card quoting it verbatim.
// Both now read relevanceTokens, and a card is admitted when one of its tokens lands.
// The tag comparison lowercases the tag as well; the old one did not, so a card filed
// under a capitalised tag was unreachable by the tag it carried.
function knowledgeSearchMatches(metadata: KnowledgeUnitMetadata, search: string): boolean {
  const subject = metadata.subject.toLowerCase();
  const summary = metadata.summary.toLowerCase();
  const snippet = metadata.snippet.toLowerCase();
  return relevanceTokens(search).some((token) => subject.includes(token) || summary.includes(token)
    || snippet.includes(token) || metadata.tags.some((tag) => tag.toLowerCase().includes(token)));
}

function selectKnowledgeMetadata(
  scan: Pick<CrestScan, "units">,
  query: KnowledgeListQuery,
  normalized: NormalizedListQuery,
  includeExplicitOnly = false,
): readonly KnowledgeUnitMetadata[] {
  const { selection, search } = normalized;
  const selected = scan.units.map((unit) => unit.metadata).filter((metadata) => {
    const freshness = computeFreshness(metadata, query.at);
    const explicitCorpus = includeExplicitOnly && (query.includeExplicitOnly === true || search !== undefined);
    if (selection === "default" && !(explicitCorpus ? explicitlySelectable(metadata, query.at) : isDefaultSelectable(metadata, query.at))) return false;
    return (!query.projectId || metadata.projectId === query.projectId) &&
      (!query.roleScope || metadata.roleScopes.includes(query.roleScope)) &&
      (!query.category || metadata.category === query.category) && (!query.kind || metadata.kind === query.kind) &&
      (!query.tag || metadata.tags.includes(query.tag)) && (!query.freshness || freshness === query.freshness) &&
      (!query.promotionState || metadata.promotionState === query.promotionState) &&
      // TCRN-CROSS-INC-230: the snippet is searched too. It was the one bounded metadata
      // field the filter held in hand and did not look at, so a card was unfindable by the
      // specifics it stores -- and the snippet is exactly where a card puts specifics,
      // being the field defined as its bounded excerpt. Found by filing a card whose
      // snippet said "flake", then searching for it and getting nothing. Bodies stay
      // unsearched on purpose: that is the metadata-first budget discipline, and it is a
      // different rule from overlooking a field already loaded.
      (search === undefined || knowledgeSearchMatches(metadata, search));
  });
  return selected.sort((left, right) => {
    const scoreDifference = knowledgeRelevanceScore(right, search) - knowledgeRelevanceScore(left, search);
    return scoreDifference === 0 ? compareCanonicalText(left.id, right.id) : scoreDifference;
  });
}

// TCRN-CROSS-INC-226: the price of admitting a trailing read is that the answer says
// so. When the store is aligned this contributes nothing, so an aligned response is
// byte-identical to what it was before the exemption existed and no caller reading
// today's shape has to change. When it trails, three fields appear together: the flag
// a caller can branch on, and both digests, so "how stale" is answerable from the
// response rather than by a second round trip.
//
// TCRN-CROSS-SUB-414: a library's crest never trails. Every read answers at the chain head it
// replayed (scanLibraryCrest), so a chain write leaves nothing behind to disclose, and
// --allow-trailing, still accepted, changes nothing about a library's answer. Only an old-layout
// store, read-only with its marker bound to its chain's head, can trail.
function trailingDisclosure(scan: KnowledgeStoreScan): Readonly<Record<string, JsonValue>> {
  if (scan.layout === "library" || scan.marker.eventHighWaterDigest === scan.workspace.headEventHash) return {};
  return {
    knowledgeStoreTrailing: true,
    storeHighWaterDigest: scan.marker.eventHighWaterDigest,
    chainHeadEventHash: scan.workspace.headEventHash,
  };
}

// TCRN-CROSS-STORY-476 R5: a read of the user crest carries `scope: "user"` where a library's
// read carries its trailing disclosure; the user crest has no chain head to trail.
const USER_CREST_DISCLOSURE: Readonly<Record<string, JsonValue>> = Object.freeze({ scope: "user" });

// TCRN-CROSS-INIT-053 R46 (I04): what a list of a library whose knowledge store was never created
// carries at its top. A list of a store that exists carries nothing new.
const ABSENT_STORE_DISCLOSURE: Readonly<Record<string, JsonValue>> = Object.freeze({ knowledgeStore: "absent" });

// What a crest merged from more than one writer says at the top of a list: its unresolved pairs
// (TCRN-CROSS-SUB-310), its unresolved duplicates (TCRN-CROSS-SUB-413) and, for a library's crest,
// the records awaiting chain events this device has not received (TCRN-CROSS-SUB-414) and the live
// records whose project the chain no longer holds (TCRN-CROSS-SUB-414 R16). Nothing when it holds
// none of them.
function mergedCrestDisclosure(scan: CrestScan): Readonly<Record<string, JsonValue>> {
  const duplicates = unresolvedDuplicates(scan);
  return {
    ...(scan.unresolvedConflicts.length === 0 ? {} : { unresolvedConflicts: scan.unresolvedConflicts as unknown as JsonValue }),
    ...(duplicates.length === 0 ? {} : { unresolvedDuplicates: duplicates.map(duplicateDiagnostic) }),
    ...(scan.awaitingChain.length === 0 ? {} : { awaitingChain: awaitingChainDiagnostic(scan.awaitingChain) }),
    ...(scan.unresolvedScopes.length === 0 ? {} : { unresolvedScopes: unresolvedScopeDiagnostic(scan.unresolvedScopes) }),
  };
}

// The records of one id awaiting chain events, and those of it whose project the chain no longer
// holds, as a read of that id carries them at its top.
function awaitingReadDisclosure(scan: CrestScan, id: string): Readonly<Record<string, JsonValue>> {
  const entries = scan.awaitingChain.filter((entry) => entry.id === id);
  const unresolved = scan.unresolvedScopes.filter((entry) => entry.id === id);
  return {
    ...(entries.length === 0 ? {} : { awaitingChain: awaitingChainDiagnostic(entries) }),
    ...(unresolved.length === 0 ? {} : { unresolvedScopes: unresolvedScopeDiagnostic(unresolved) }),
  };
}

// The ids a merged crest's default selection leaves out: both cards of an unresolved pair, every
// version of an unresolved duplicate, and a library card with a record awaiting chain events or a
// live record whose project the chain no longer holds.
function withheldCardIds(scan: CrestScan): ReadonlySet<string> {
  return new Set([
    ...unresolvedConflictIds(scan),
    ...unresolvedDuplicates(scan).map((duplicate) => duplicate.id),
    ...scan.awaitingChain.map((entry) => entry.id),
    ...scan.unresolvedScopes.map((entry) => entry.id),
  ]);
}

/**
 * The card metadata a query selects. `query.scope` "user" reads this user's crest (TCRN-CROSS-STORY-476
 * R5), whichever library `workspaceRoot` names, and lists nothing before the crest's first card;
 * left out, the library's crest, exactly as before. TCRN-CROSS-SUB-310: a crest holding
 * unresolved conflicts answers them as `unresolvedConflicts` (pairs of card ids), and its default
 * selection leaves their cards out; selection "all" lists them. TCRN-CROSS-SUB-413: likewise an id
 * more than one writer wrote, answered as `unresolvedDuplicates` (duplicateDiagnostic) while it is
 * unresolved: default selection leaves out every version, and selection "all" lists each one.
 * TCRN-CROSS-SUB-414: a library's crest answers both the same way, and names under `awaitingChain`
 * the records written against chain events this device has not received, whose cards default
 * selection leaves out until the chain arrives. R16: and under `unresolvedScopes` the live records
 * whose project the chain no longer holds, whose cards default selection leaves out until a card
 * supersedes them. TCRN-CROSS-INIT-053 R46 (I04): a library whose store was never created answers an
 * empty list with `knowledgeStore: "absent"`; every other store state answers as it did.
 */
export async function listKnowledgeMetadata(workspaceRoot: string, query: KnowledgeListQuery): Promise<Readonly<Record<string, JsonValue>>> {
  const normalized = normalizeListQuery(query);
  assertStoreScope(query.scope);
  if (query.scope === "user") {
    return readUserCrest(query, async (scan) => {
      if (scan === null) return knowledgeListAnswer([], query, normalized, USER_CREST_DISCLOSURE);
      return mergedCrestList(scan, query, normalized, USER_CREST_DISCLOSURE);
    });
  }
  const place = await knowledgeStorePlace(workspaceRoot);
  // TCRN-CROSS-INIT-053 R46 (I04): a library whose store was never created holds no card yet: an empty
  // inventory that says so, never a refusal.
  if (await libraryStoreNeverCreated(place)) return knowledgeListAnswer([], query, normalized, ABSENT_STORE_DISCLOSURE);
  const scan = await scanKnowledgeStoreAt(place, query, false, "metadata-only", false, false);
  return mergedCrestList(scan, query, normalized, trailingDisclosure(scan));
}

// TCRN-CROSS-SUB-425 (MIN-239 D6): a list answers the valid cards unless it asks for another status.
// `selection` chooses among the valid ones as it always did; the removed ones, asked for with status
// "removed" or "all", are each answered as it is kept, whatever the selection.
function mergedCrestList(
  scan: CrestScan,
  query: KnowledgeListQuery,
  normalized: NormalizedListQuery,
  disclosure: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  const withheld = withheldCardIds(scan);
  const valid = normalized.status === "removed"
    ? []
    : selectKnowledgeMetadata({ units: crestRecords(scan).filter((unit) => !scan.removals.has(unit.metadata.id)) }, query, normalized, true)
      .filter((metadata) => normalized.selection !== "default" || !withheld.has(metadata.id));
  const removed = normalized.status === "valid" ? [] : selectRemovedCards(scan, query, normalized);
  const matched = normalized.status === "all" ? rankedRecords(valid, removed, normalized.search) : [...valid, ...removed];
  return knowledgeListAnswer(matched, query, normalized, { ...disclosure, ...mergedCrestDisclosure(scan) });
}

// A removed card's relevance to a search: its subject is all it keeps, weighted as a subject is.
function removedRelevanceScore(record: RemovedCardRecord, search: string | undefined): number {
  if (search === undefined) return 0;
  const subject = record.subject.toLowerCase();
  return relevanceTokens(search).reduce((score, token) => score + occurrenceCount(subject, token) * 8, 0);
}

// TCRN-CROSS-SUB-425: the removed cards a list selects, as each is kept, most relevant first and then
// in canonical id order. A removed card keeps no project, role, category, kind, tag or freshness, so
// a list filtered by any of those selects none of them; a search matches its subject alone.
function selectRemovedCards(
  scan: Pick<CrestScan, "units" | "duplicates" | "removals">,
  query: KnowledgeListQuery,
  normalized: NormalizedListQuery,
): readonly RemovedCardRecord[] {
  if (query.projectId || query.roleScope || query.category || query.kind || query.tag || query.freshness || query.promotionState) return [];
  const { search } = normalized;
  const kept = indexRecords(crestRecords(scan).filter((unit) => scan.removals.has(unit.metadata.id)).map((unit) => unit.metadata), scan.removals) as readonly RemovedCardRecord[];
  return kept
    .filter((record) => search === undefined || relevanceTokens(search).some((token) => record.subject.toLowerCase().includes(token)))
    .sort((left, right) => removedRelevanceScore(right, search) - removedRelevanceScore(left, search) || compareCanonicalText(left.id, right.id));
}

// Valid and removed cards in one list: most relevant first, then in canonical id order.
function rankedRecords(valid: readonly KnowledgeUnitMetadata[], removed: readonly RemovedCardRecord[], search: string | undefined): readonly KnowledgeIndexRecord[] {
  const scored = [
    ...valid.map((record) => ({ record: record as KnowledgeIndexRecord, score: knowledgeRelevanceScore(record, search) })),
    ...removed.map((record) => ({ record: record as KnowledgeIndexRecord, score: removedRelevanceScore(record, search) })),
  ];
  return scored.sort((left, right) => right.score - left.score || compareCanonicalText(left.record.id, right.record.id)).map((entry) => entry.record);
}

function knowledgeListAnswer(
  matched: readonly KnowledgeIndexRecord[],
  query: KnowledgeListQuery,
  normalized: NormalizedListQuery,
  disclosure: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  // WSC-4: truncate with a continuation window instead of failing when more than
  // one page matches — the metadata-first surface stays usable past a single page.
  const records = matched.slice(normalized.offset, normalized.offset + normalized.limit) as unknown as readonly JsonValue[];
  return {
    schemaVersion: "tcrn.knowledge-list.v1",
    reasonCode: "KNOWLEDGE_LIST_READY",
    ...disclosure,
    selection: normalized.selection,
    // TCRN-CROSS-SUB-425: which cards the list answered, "valid" unless the caller asked otherwise.
    status: normalized.status,
    at: query.at,
    total: matched.length,
    offset: normalized.offset,
    truncated: normalized.offset + records.length < matched.length,
    records,
    // TCRN-CROSS-SUB-428 (INC-398): the page's digest is hashed record by record, so a page as large
    // as the whole crest -- the page recall and the knowledge hint read -- is never refused for size.
    resultDigest: canonicalListSha256(records.map(canonicalEntryText)),
  };
}

function assertKnowledgeReadId(id: string): void {
  try {
    assertProtocolId(id);
    if (!id.startsWith("knowledge:")) fail("KNOWLEDGE_PATH_INVALID", id);
  } catch (error) {
    if (error instanceof KnowledgeCoreError) throw error;
    fail("KNOWLEDGE_PATH_INVALID", String(error));
  }
}

// TCRN-CROSS-SUB-413: a read of a duplicate's id carries at its top the entry knowledge-list names
// while the duplicate is unresolved, and nothing more once a card has superseded it.
function duplicateReadDisclosure(duplicate: CrestDuplicate, disclosure: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return unresolvedDuplicates({ duplicates: [duplicate], removals: new Map() }).length === 0
    ? disclosure
    : { ...disclosure, unresolvedDuplicates: [duplicateDiagnostic(duplicate)] };
}

/**
 * One card's snippet; `options.scope` "user" reads it from this user's crest (TCRN-CROSS-STORY-476 R5).
 * TCRN-CROSS-SUB-413: the id of a duplicate answers every version's snippet under `versions`, each
 * named by its writer, in place of one card's fields; TCRN-CROSS-SUB-414 answers a library crest's
 * duplicates the same way.
 */
export async function readKnowledgeSnippet(workspaceRoot: string, id: string, options: KnowledgeScopedReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertKnowledgeReadId(id);
  assertStoreScope(options.scope);
  if (options.scope === "user") {
    return readUserCrest(options, async (scan) => {
      if (scan === null) return knowledgeSnippetAnswer(id, [], USER_CREST_DISCLOSURE);
      return crestSnippetAnswer(scan, id, USER_CREST_DISCLOSURE);
    });
  }
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  return crestSnippetAnswer(scan, id, trailingDisclosure(scan));
}

// TCRN-CROSS-SUB-425 (C-R17-3): a removed card has no snippet to give: the read is refused, naming the
// removal (KNOWLEDGE_CARD_REMOVED).
function crestSnippetAnswer(scan: CrestScan, id: string, disclosure: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  assertNotRemoved(scan, id, REMOVED_READ_REMEDY);
  const awaiting = awaitingReadDisclosure(scan, id);
  const duplicate = scan.duplicates.find((entry) => entry.id === id);
  if (duplicate === undefined) return knowledgeSnippetAnswer(id, scan.units, { ...disclosure, ...awaiting });
  return {
    schemaVersion: "tcrn.knowledge-snippet.v1",
    ...duplicateReadDisclosure(duplicate, disclosure),
    ...awaiting,
    id,
    versions: duplicate.versions.map((version) => ({
      ...duplicateVersionIdentity(version),
      subject: version.metadata.subject,
      summary: version.metadata.summary,
      snippet: version.metadata.snippet,
      revision: version.metadata.revision,
    })),
  };
}

function knowledgeSnippetAnswer(id: string, units: readonly ScannedKnowledgeUnit[], disclosure: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const unit = units.find((entry) => entry.metadata.id === id);
  if (!unit) fail("KNOWLEDGE_NOT_FOUND", id);
  return {
    schemaVersion: "tcrn.knowledge-snippet.v1",
    ...disclosure,
    id,
    subject: unit.metadata.subject,
    summary: unit.metadata.summary,
    snippet: unit.metadata.snippet,
    revision: unit.metadata.revision,
  };
}

/**
 * One card's body, read explicitly; `options.scope` "user" reads it from this user's crest (TCRN-CROSS-STORY-476 R5).
 * TCRN-CROSS-SUB-413: the id of a duplicate answers every version's body under `versions`, each
 * named by its writer, once every version passes the check one card's body does; TCRN-CROSS-SUB-414
 * answers a library crest's duplicates the same way.
 */
export async function readKnowledgeBody(workspaceRoot: string, id: string, options: KnowledgeBodyReadOptions): Promise<Readonly<Record<string, JsonValue>>> {
  assertKnowledgeReadId(id);
  assertEvaluationInstant(options.at);
  assertStoreScope(options.scope);
  if (options.scope === "user") {
    return readUserCrest(options, async (scan) => {
      if (scan === null) fail("KNOWLEDGE_NOT_FOUND", id);
      return crestBodyAnswer(scan, id, options, userCrestBackend(scan.storeRoot, scan.device, options), null, USER_CREST_DISCLOSURE);
    });
  }
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  return crestBodyAnswer(scan, id, options, storeBackendFor(scan.storeRoot, options), scan.workspace, trailingDisclosure(scan));
}

// TCRN-CROSS-SUB-425 (C-R17-3): a removed card's body is cleared, and an explicit read of it is refused
// before any body file is opened, naming the removal (KNOWLEDGE_CARD_REMOVED).
async function crestBodyAnswer(
  scan: CrestScan,
  id: string,
  options: KnowledgeBodyReadOptions,
  backend: StoreBackend,
  linkState: WorkspaceState | null,
  disclosure: Readonly<Record<string, JsonValue>>,
): Promise<Readonly<Record<string, JsonValue>>> {
  assertNotRemoved(scan, id, REMOVED_READ_REMEDY);
  const awaiting = awaitingReadDisclosure(scan, id);
  const duplicate = scan.duplicates.find((entry) => entry.id === id);
  if (duplicate === undefined) return knowledgeBodyAnswer(id, scan.units, options, backend, linkState, { ...disclosure, ...awaiting });
  const freshness = duplicate.versions.map((version) => readableBodyFreshness(version.metadata, options));
  const versions: Readonly<Record<string, JsonValue>>[] = [];
  for (const [index, version] of duplicate.versions.entries()) {
    const body = version.readBody === undefined ? await backend.readKnowledgeBody(id) : await version.readBody();
    validateMetadataBody(version.metadata, body, linkState);
    versions.push({
      ...duplicateVersionIdentity(version),
      revision: version.metadata.revision,
      freshness: freshness[index] as KnowledgeFreshnessState,
      bodySha256: version.metadata.bodySha256,
      body: body.toString("utf8"),
    });
  }
  return { schemaVersion: "tcrn.knowledge-body-read.v1", ...duplicateReadDisclosure(duplicate, disclosure), ...awaiting, id, versions, explicit: true };
}

// The freshness of a card whose body an explicit read may open; a card it may not open is refused.
function readableBodyFreshness(metadata: KnowledgeUnitMetadata, options: KnowledgeBodyReadOptions): KnowledgeFreshnessState {
  const freshness = computeFreshness(metadata, options.at);
  // TCRN-CROSS-INC-282: body access answers the same question the selection does. While
  // this leg still demanded "promoted", a card the default list now returns had a body the
  // CLI refused to read without --allow-unpromoted, which is the reported defect one layer
  // down. "rejected" is what --allow-unpromoted still opens.
  if ((!options.allowUnpromoted && metadata.promotionState === "rejected") ||
    (!options.allowStale && freshness !== "fresh") || metadata.retrievalDisposition === "excluded" || metadata.lifecycle === "retired") {
    fail("KNOWLEDGE_BODY_ACCESS_DENIED", metadata.id);
  }
  return freshness;
}

async function knowledgeBodyAnswer(
  id: string,
  units: readonly ScannedKnowledgeUnit[],
  options: KnowledgeBodyReadOptions,
  backend: StoreBackend,
  linkState: WorkspaceState | null,
  disclosure: Readonly<Record<string, JsonValue>>,
): Promise<Readonly<Record<string, JsonValue>>> {
  const unit = units.find((entry) => entry.metadata.id === id);
  if (!unit) fail("KNOWLEDGE_NOT_FOUND", id);
  const freshness = readableBodyFreshness(unit.metadata, options);
  const body = unit.readBody === undefined ? await backend.readKnowledgeBody(id) : await unit.readBody();
  validateMetadataBody(unit.metadata, body, linkState);
  return {
    schemaVersion: "tcrn.knowledge-body-read.v1",
    ...disclosure,
    id,
    revision: unit.metadata.revision,
    freshness,
    bodySha256: unit.metadata.bodySha256,
    body: body.toString("utf8"),
    explicit: true,
  };
}

export async function evaluateKnowledgeFreshness(workspaceRoot: string, at: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertEvaluationInstant(at);
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  // TCRN-CROSS-SUB-425: a removed card keeps no freshness to evaluate; the valid cards are evaluated.
  const records = validCrestRecords(scan).map((unit) => ({
    id: unit.metadata.id,
    state: computeFreshness(unit.metadata, at),
    lastVerified: unit.metadata.lastVerified,
    maximumAgeDays: unit.metadata.stalenessPolicy.maximumAgeDays,
  }));
  records.sort((left, right) => compareCanonicalText(left.id, right.id));
  return {
    schemaVersion: "tcrn.knowledge-freshness-evaluation.v1",
    reasonCode: "KNOWLEDGE_FRESHNESS_EVALUATED",
    ...trailingDisclosure(scan),
    at,
    records,
    evaluationDigest: canonicalSha256(records),
  };
}

// STORY-328: source verification is an explicit, bounded operation. Ordinary
// metadata reads do not walk source files; this command visits at most the
// declared sourceReferences of each admitted card and turns changed/missing
// files into actionable report records instead of hiding the card or rejecting
// the whole knowledge store.
export async function checkKnowledgeSources(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanKnowledgeStore(workspaceRoot, { ...options, allowTrailing: options.allowTrailing ?? true }, false, "metadata-only");
  const reports: Array<Record<string, JsonValue>> = [];
  // TCRN-CROSS-SUB-425: a removed card keeps no sources to check; the valid cards are checked.
  for (const unit of validCrestRecords(scan)) {
    const references = unit.metadata.sourceReferences.filter(sourceReferenceIsFile);
    if (references.length === 0) {
      reports.push({ id: unit.metadata.id, status: "uncheckable", sourceReferences: unit.metadata.sourceReferences as unknown as JsonValue, expectedDigest: unit.metadata.sourceDigest, action: "none" });
      continue;
    }
    try {
      const parts = await sourceDigestParts(scan.workspaceRoot, scopedWorkspaceState(scan.workspace, unit.metadata.projectId ?? undefined), references);
      const missing = parts.filter((part) => part.path === null).map((part) => part.reference);
      if (missing.length > 0) {
        reports.push({ id: unit.metadata.id, status: "missing", sourceReferences: missing, expectedDigest: unit.metadata.sourceDigest, action: "report-and-reverify-or-retire" });
        continue;
      }
      const actualDigest = parts.length === 1 ? parts[0]!.digest! : sha256(canonicalJson(parts.map((part) => ({ reference: part.reference, digest: part.digest }))));
      const changed = actualDigest !== unit.metadata.sourceDigest;
      reports.push({ id: unit.metadata.id, status: changed ? "changed" : "unchanged", sourceReferences: references as unknown as JsonValue, expectedDigest: unit.metadata.sourceDigest, actualDigest, action: changed ? "reverify-or-retire" : "none" });
    } catch (error) {
      reports.push({ id: unit.metadata.id, status: "changed", sourceReferences: references as unknown as JsonValue, expectedDigest: unit.metadata.sourceDigest, action: "report-and-reverify-or-retire", detail: "source could not be hashed consistently" });
    }
  }
  reports.sort((left, right) => compareCanonicalText(String(left.id), String(right.id)));
  const changed = reports.filter((report) => report.status === "changed");
  const missing = reports.filter((report) => report.status === "missing");
  const uncheckable = reports.filter((report) => report.status === "uncheckable");
  const reasonCode = changed.length > 0
    ? "KNOWLEDGE_SOURCE_CHANGED"
    : missing.length > 0
      ? "KNOWLEDGE_SOURCE_MISSING"
      : uncheckable.length === reports.length && reports.length > 0
        ? "KNOWLEDGE_SOURCE_UNCHECKABLE"
        : "KNOWLEDGE_SOURCES_ALIGNED";
  return {
    schemaVersion: "tcrn.knowledge-source-check.v1",
    reasonCode,
    ...trailingDisclosure(scan),
    records: reports,
    changed: changed.length,
    missing: missing.length,
    uncheckable: uncheckable.length,
    resultDigest: canonicalSha256(reports),
  };
}

// WSC-5: re-verify an eligible record — touch lastVerified to the given instant and
// restore a fresh posture, so knowledge does not decay irreversibly out of default
// selection. Historical candidate and rejected records remain ineligible (OD-17).
// TCRN-CROSS-SUB-414: the card is written again as a new record in this device's stream, naming the
// record it replaces; nothing of the crest is rewritten (appendLibraryCrestEvent).
export async function reverifyKnowledgeUnit(...args: Parameters<typeof reverifyKnowledgeUnitUnlocked>): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(args[0], () => reverifyKnowledgeUnitUnlocked(...args));
}

async function reverifyKnowledgeUnitUnlocked(workspaceRoot: string, input: {
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly id: string;
}, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    assertProtocolId(input.id);
    assertStrictInstant(input.occurredAt);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail("KNOWLEDGE_INPUT_INVALID", "reverify versions");
  }
  await assertKnowledgeWritable(resolve(workspaceRoot));
  const scan = await mutationAdmissionScan(workspaceRoot, options);
  const unit = libraryCrestCard(scan, input.id);
  if (unit.metadata.revision !== input.expectedRevision) {
    fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedRevision}:${unit.metadata.revision}`);
  }
  if ((unit.metadata.promotionState !== undefined && unit.metadata.promotionState !== "promoted") || unit.metadata.lifecycle === "retired") {
    fail("KNOWLEDGE_LIFECYCLE_INVALID", "only an eligible, non-retired record can be re-verified");
  }
  const metadata: KnowledgeUnitMetadata = { ...unit.metadata, lastVerified: input.occurredAt, freshnessState: "fresh", revision: unit.metadata.revision + 1, updatedAt: input.occurredAt };
  const body = await crestRecordBody(scan, unit, options);
  validateMetadataBody(validateExistingMetadataShape(metadata, scan.workspace), body, scan.workspace);
  const head = await appendLibraryCrestEvent(scan, metadata, body, unit, options.faultAt);
  // TCRN-CROSS-SUB-425: every write clears this device's bodies of removed cards.
  await clearRemovedBodies(scan, head.deviceId, scan.removals.keys());
  await projectViewAfterWrite(scan, indexRecords(crestRecords(scan).map((entry) => entry === unit ? metadata : entry.metadata), scan.removals), options);
  return {
    schemaVersion: "tcrn.knowledge-reverify-result.v1",
    reasonCode: "KNOWLEDGE_REVERIFIED",
    id: metadata.id,
    lastVerified: metadata.lastVerified,
    revision: metadata.revision,
    version: scan.marker.version + 1,
  };
}

export async function refreshKnowledgeArticle(...args: Parameters<typeof refreshKnowledgeArticleUnlocked>): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(args[0], () => refreshKnowledgeArticleUnlocked(...args));
}

async function refreshKnowledgeArticleUnlocked(
  workspaceRoot: string,
  input: KnowledgeArticleRefreshInput,
  options: KnowledgeMutationOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    assertProtocolId(input.id);
    assertStrictInstant(input.occurredAt);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail("KNOWLEDGE_INPUT_INVALID", "article refresh versions");
  }
  assertArticleField(input.summary, KNOWLEDGE_LIMITS.maximumSummaryBytes, "article summary");
  await assertKnowledgeWritable(resolve(workspaceRoot));
  const scan = await mutationAdmissionScan(workspaceRoot, options);
  const unit = libraryCrestCard(scan, input.id);
  if (unit.metadata.revision !== input.expectedRevision) fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedRevision}:${unit.metadata.revision}`);
  if (unit.metadata.kind !== "reference" || unit.metadata.retrievalDisposition !== "explicit-only" || unit.metadata.lifecycle === "retired") {
    fail("KNOWLEDGE_LIFECYCLE_INVALID", "only an active article index can be refreshed");
  }
  if (!unit.metadata.sourceReferences.includes(input.path)) fail("KNOWLEDGE_PATH_INVALID", "article identity does not match source path");
  const workspaceArticle = await articlePathFor(scan.workspaceRoot, scopedWorkspaceState(scan.workspace, unit.metadata.projectId ?? undefined), input.path);
  const articleBytes = await readArticleBytes(workspaceArticle.file);
  const article = parseArticleMarkdown(articleBytes, input.path);
  const sourceDigest = sha256(articleBytes);
  let language;
  try {
    language = applyWriteLanguagePolicy(
      { subject: article.title, summary: input.summary, snippet: truncateArticleUtf8(input.summary, KNOWLEDGE_LIMITS.maximumSnippetBytes) },
      readKnowledgeLanguagePolicy(scopedWorkspaceState(scan.workspace, unit.metadata.projectId ?? undefined).settings, options.host),
      options.languageProvider,
    );
  } catch (error) {
    if (error instanceof KnowledgeLanguageError) fail(error.reasonCode, error.message, error.details as Readonly<Record<string, JsonValue>>);
    throw error;
  }
  const body = Buffer.from(articleIndexBody(article.title, input.summary, input.path), "utf8");
  const metadata: KnowledgeUnitMetadata = {
    ...unit.metadata,
    category: article.category,
    tags: ["article", article.category].sort(compareCanonicalText),
    subject: language.subject,
    summary: language.summary,
    snippet: language.snippet,
    sourceDigest,
    freshnessState: "fresh",
    lastVerified: input.occurredAt,
    bodySha256: sha256(body),
    bodyBytes: body.length,
    revision: unit.metadata.revision + 1,
    updatedAt: input.occurredAt,
    expansions: language.expansions,
  };
  validateMetadataBody(validateExistingMetadataShape(metadata, scan.workspace), body, scan.workspace);
  const secondRead = await readArticleBytes(workspaceArticle.file);
  if (!secondRead.equals(articleBytes)) fail("KNOWLEDGE_SOURCE_CHANGED", workspaceArticle.file);
  // The records once the refreshed card lands, which this device's index view projects after it; no
  // total of the crest's bodies is checked (TCRN-CROSS-SUB-310 R17, MIN-238 D1).
  const projectedMetadata = indexRecords(crestRecords(scan).map((entry) => entry === unit ? metadata : entry.metadata), scan.removals);
  const head = await appendLibraryCrestEvent(scan, metadata, body, unit, options.faultAt);
  // TCRN-CROSS-SUB-425: every write clears this device's bodies of removed cards.
  await clearRemovedBodies(scan, head.deviceId, scan.removals.keys());
  await projectViewAfterWrite(scan, projectedMetadata, options);
  return {
    schemaVersion: "tcrn.knowledge-article-refresh-result.v1",
    reasonCode: "KNOWLEDGE_ARTICLE_REFRESHED",
    id: metadata.id,
    revision: metadata.revision,
    version: scan.marker.version + 1,
    path: workspaceArticle.file,
    articlePath: input.path,
    articleBytes: articleBytes.length,
    previousSourceDigest: unit.metadata.sourceDigest,
    sourceDigest: metadata.sourceDigest,
    bodyBytes: metadata.bodyBytes,
    category: metadata.category,
    title: metadata.subject,
    summary: metadata.summary,
  };
}

// INC-256: change the freshness policy without changing the card's content or
// verification instant. This is a metadata migration operation, so it advances
// the disposable store version and revision exactly like the other mutations.
// A null maximum age also clears a stale state that was produced by the old
// calendar policy; a later explicit source check or re-verification can mark the
// record stale again when a current source actually warrants it.
// TCRN-CROSS-SUB-414: the card is written again as a new record in this device's stream; a retired
// record, whose body an older engine may have reclaimed, is written again without one.
export async function updateKnowledgeStalenessPolicy(...args: Parameters<typeof updateKnowledgeStalenessPolicyUnlocked>): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(args[0], () => updateKnowledgeStalenessPolicyUnlocked(...args));
}

async function updateKnowledgeStalenessPolicyUnlocked(workspaceRoot: string, input: {
  readonly expectedRevision: number;
  readonly occurredAt: string;
  readonly id: string;
  readonly stalenessPolicy: KnowledgeStalenessPolicy;
}, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  try {
    assertProtocolId(input.id);
    assertStrictInstant(input.occurredAt);
  } catch (error) {
    fail("KNOWLEDGE_INPUT_INVALID", String(error));
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail("KNOWLEDGE_INPUT_INVALID", "policy versions");
  }
  const maximumAgeDays = input.stalenessPolicy?.maximumAgeDays;
  const unknownDisposition = input.stalenessPolicy?.unknownDisposition;
  if ((maximumAgeDays !== null && (!Number.isSafeInteger(maximumAgeDays) || maximumAgeDays < 1 || maximumAgeDays > Number.MAX_SAFE_INTEGER)) ||
    (unknownDisposition !== "fail-closed" && unknownDisposition !== "fail-open")) {
    fail("KNOWLEDGE_INPUT_INVALID", "staleness policy");
  }
  await assertKnowledgeWritable(resolve(workspaceRoot));
  const scan = await mutationAdmissionScan(workspaceRoot, options);
  const unit = libraryCrestCard(scan, input.id);
  if (unit.metadata.revision !== input.expectedRevision) {
    fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedRevision}:${unit.metadata.revision}`);
  }
  const metadata: KnowledgeUnitMetadata = {
    ...unit.metadata,
    stalenessPolicy: input.stalenessPolicy,
    freshnessState: maximumAgeDays === null ? "fresh" : unit.metadata.freshnessState,
    revision: unit.metadata.revision + 1,
    updatedAt: input.occurredAt,
  };
  const validated = validateExistingMetadataShape(metadata, scan.workspace);
  const body = unit.metadata.lifecycle === "retired" ? null : await crestRecordBody(scan, unit, options);
  if (body !== null) validateMetadataBody(validated, body, scan.workspace);
  const head = await appendLibraryCrestEvent(scan, metadata, body, unit, options.faultAt);
  // TCRN-CROSS-SUB-425: every write clears this device's bodies of removed cards.
  await clearRemovedBodies(scan, head.deviceId, scan.removals.keys());
  await projectViewAfterWrite(scan, indexRecords(crestRecords(scan).map((entry) => entry === unit ? metadata : entry.metadata), scan.removals), options);
  return {
    schemaVersion: "tcrn.knowledge-policy-result.v1",
    reasonCode: "KNOWLEDGE_POLICY_UPDATED",
    id: metadata.id,
    maximumAgeDays: metadata.stalenessPolicy.maximumAgeDays,
    unknownDisposition: metadata.stalenessPolicy.unknownDisposition,
    revision: metadata.revision,
    version: scan.marker.version + 1,
  };
}

export async function exportKnowledgeCheckpoint(workspaceRoot: string, at: string, options: KnowledgeReadOptions = {}): Promise<string> {
  assertEvaluationInstant(at);
  // TCRN-CROSS-INC-232: a checkpoint is never taken against a trailing store, whatever
  // the caller passes. This is the sixth metadata-only scan while the INC-226 comment
  // said there were five, so it inherited the read exemption unnoticed -- and it is the
  // only one of the six whose result carries no trailing disclosure, which left its
  // eventHighWaterDigest (a field the strict equality used to guarantee was the chain
  // head) free to be a stale head reported with nothing beside it for comparison. A
  // checkpoint is this surface's export artifact: the strongest answer it produces and
  // the one a reader is least able to re-derive. It takes the strict rule, not a label.
  // TCRN-CROSS-SUB-414: for a library's crest the strict rule is that this device's chain holds
  // every record, and the corpus is the default selection's. R16: and that every live card's project
  // resolves against it.
  const scan = await scanKnowledgeStore(workspaceRoot, { ...options, allowTrailing: false }, false, "metadata-only");
  assertScopesResolve(scan);
  assertChainHoldsCrest(scan);
  const withheld = withheldCardIds(scan);
  // TCRN-CROSS-SUB-425: a removed card is in no checkpoint.
  const records = scan.units.map((unit) => unit.metadata).filter((metadata) => !withheld.has(metadata.id) && !scan.removals.has(metadata.id) && isDefaultSelectable(metadata, at));
  records.sort((left, right) => compareCanonicalText(left.id, right.id));
  return canonicalJson({
    schemaVersion: "tcrn.knowledge-checkpoint.v1",
    reasonCode: "KNOWLEDGE_CHECKPOINT_READY",
    workspaceId: scan.marker.workspaceId,
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    version: scan.marker.version,
    at,
    bodyStorage: "excluded",
    records,
    checkpointDigest: canonicalSha256(records),
  });
}
