// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveStoreBackend, SegmentedKnowledgeStoreBackend } from "./store-backend.js";
import type { FileStoreBackendProfile, StoreBackend, StoreBackendPlacement } from "./store-backend.js";

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
  cachePath,
  deviceHome,
  ensureDeviceDirectory,
  USER_CREST_EVENTS_DIRECTORY,
  userCrestCachePath,
  userCrestEventsPath,
  userCrestLockPath,
  userCrestPath,
} from "./device-home.js";
import { isAtomicTemporaryName } from "./atomic-file.js";
import { readOrCreateDevice } from "./device-identity.js";
import { FileLockError, withFileLock } from "./file-lock.js";
import { readUserCrestPath } from "./machine-settings.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY, LEGACY_KNOWLEDGE_DIRECTORY } from "./names.js";

export const KNOWLEDGE_CORE_VERSION = "tcrn.knowledge-core.v1" as const;
export const KNOWLEDGE_STORE_SCHEMA_VERSION = "tcrn.knowledge-store.v1" as const;
export const KNOWLEDGE_METADATA_SCHEMA_VERSION = "tcrn.knowledge-unit-metadata.v1" as const;

export const KNOWLEDGE_LIMITS = Object.freeze({
  maximumBodyBytes: 8_192,
  maximumArticleBytes: PROTOCOL_LIMITS.maxCanonicalBytes,
  maximumSummaryBytes: 2_048,
  maximumSnippetBytes: 512,
  maximumMetadataBytes: 32_768,
  // STORY-330: the knowledge budget is bounded by the same canonical view ceiling as
  // the protocol. The previous 128 KiB value was a historical record count surrogate:
  // 35 cards measured 63,316 bytes of source data while their derived index measured
  // 52,851 bytes (5.0% of the 1 MiB view ceiling). TCRN-CROSS-SUB-309: what the budget
  // counts is card bodies alone (see capacityBodyBytes).
  maximumAggregateBytes: PROTOCOL_LIMITS.maxCanonicalBytes,
  maximumQueryResults: 8,
  maximumLocators: 16,
  maximumLinksPerClass: 64,
  maximumTags: 32,
  maximumRoleScopes: 16,
});

const KNOWLEDGE_AGGREGATE_DEFAULT = 131_072 as const;

function knowledgeAggregateLimit(workspace: WorkspaceState): number {
  const configured = workspace.settings.find((entry) => entry.key === "knowledge.aggregateBytes")?.value;
  const value = configured === undefined ? KNOWLEDGE_AGGREGATE_DEFAULT : Number(configured);
  if (!Number.isSafeInteger(value) || value < 4_096 || value > PROTOCOL_LIMITS.maxCanonicalBytes) {
    fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge.aggregateBytes is outside its declared bounds");
  }
  return value;
}

// TCRN-CROSS-SUB-309 (TCRN-CROSS-STORY-476 R3): knowledge.aggregateBytes counts card bodies
// and nothing else -- not the store marker, not the metadata, not the derived index -- and
// only the bodies of cards that are still live. A card a later card superseded (the one
// retirement left, TCRN-CROSS-SUB-308), or one an older engine retired, gives its body back to
// the budget; a superseded body stays in its immutable store or event stream for explicit reads,
// is excluded from default recall, and is never physically deleted by superseding.
// The count reads each record's own bodyBytes, which a full read binds to the body on disk, so
// a metadata-only read measures the same number, and a store written before this is measured
// the new way the first time it is read: nothing is migrated or rewritten.
function countsTowardCapacity(metadata: KnowledgeUnitMetadata): boolean {
  return metadata.lifecycle !== "retired" && metadata.extensions.supersededBy === undefined;
}

function capacityBodyBytes(records: readonly KnowledgeUnitMetadata[]): number {
  return records.reduce((total, metadata) => total + (countsTowardCapacity(metadata) ? metadata.bodyBytes : 0), 0);
}

function assertWithinCapacity(bodyBytes: number, limit: number, label: string): void {
  if (bodyBytes > limit) fail("KNOWLEDGE_LIMIT_EXCEEDED", label, { bodyBytes, limit });
}

export const KNOWLEDGE_REASON_CODES = Object.freeze([
  // TCRN-CROSS-STORY-469: an old-layout workspace's knowledge store is read, never written.
  "LEGACY_WORKSPACE_READ_ONLY",
  "KNOWLEDGE_ALREADY_EXISTS",
  "KNOWLEDGE_ARTICLE_CREATED",
  "KNOWLEDGE_ARTICLE_REFRESHED",
  "KNOWLEDGE_BODY_ACCESS_DENIED",
  "KNOWLEDGE_CANONICAL_INVALID",
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
  "KNOWLEDGE_SOURCE_CHANGED",
  "KNOWLEDGE_SOURCES_ALIGNED",
  "KNOWLEDGE_SOURCE_MISSING",
  "KNOWLEDGE_SOURCE_UNCHECKABLE",
  "KNOWLEDGE_SPECIAL_FILE",
  "KNOWLEDGE_STORE_INITIALIZED",
  "KNOWLEDGE_STORE_REBASED",
  "KNOWLEDGE_STORE_VALID",
  "KNOWLEDGE_UNIT_CREATED",
] as const);

export type KnowledgeReasonCode = typeof KNOWLEDGE_REASON_CODES[number];
// TCRN-CROSS-STORY-476 R5: "user" writes the card to this user's crest, the one store every
// project recalls from; the other three write it to the library's crest. The one scope value
// says both where a card applies and where it is stored, rather than a second field saying where.
export type KnowledgeScope = "workspace" | "project" | "role" | "user";
/** TCRN-CROSS-STORY-476 R5: which store a card lives in -- the library's crest or this user's. */
export type KnowledgeStoreScope = "project" | "user";
export const KNOWLEDGE_STORE_SCOPES: readonly KnowledgeStoreScope[] = Object.freeze(["project", "user"]);

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
const USER_CREST_EVENT_FILE_PATTERN = /^(\d{8,})-([a-f0-9]{64})\.json$/u;
const USER_CREST_BODY_FILE_PATTERN = /^(\d{8,})-([a-f0-9]{64})\.body$/u;
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

// In a library (TCRN-CROSS-STORY-469) the marker binds the store to the library id (workspaceId)
// and to the library head (eventHighWaterDigest): one digest over every stream's head, so it moves
// with any entry of the version vector, whichever device wrote it. An old-layout store binds its
// workspace id and its one chain's head.
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

// TCRN-CROSS-STORY-476 R5: what a write reads from a scan of either store, a library's crest
// (KnowledgeStoreScan) or the user crest (UserCrestScan).
interface CrestScan {
  readonly storeRoot: string;
  readonly marker: KnowledgeStoreMarker;
  readonly units: readonly ScannedKnowledgeUnit[];
  readonly index: Readonly<Record<string, JsonValue>>;
  readonly capacity: { readonly bodyBytes: number; readonly limit: number };
}

// The user crest, read: no library, no chain head and no links to check a card against beyond
// the card itself. `device` is the device directory whose cache holds its index view.
interface UserCrestScan extends CrestScan {
  readonly device: string;
  readonly eventOnly: boolean;
  readonly eventHeads: readonly { readonly deviceId: string; readonly sequence: number; readonly eventHash: string }[];
  // TCRN-CROSS-SUB-310 (MIN-235 D7): pairs of live cards from two writers that each wrote without
  // seeing the other, which the write-time conflict check would have refused. Each pair is in
  // canonical id order and so is the list. Both cards stay readable; default selection leaves
  // them out until a write resolves the pair (projectUserCrestUnits).
  readonly unresolvedConflicts: readonly (readonly string[])[];
  // TCRN-CROSS-SUB-413 (STORY-476 D7): every id more than one writer wrote with differing metadata,
  // in canonical id order, resolved or not. Their versions are not in `units`.
  readonly duplicates: readonly UserCrestDuplicate[];
}

// TCRN-CROSS-SUB-310: the one writer a user-crest card came from -- a device's event stream, named
// by its device id, or the metadata/body layout an engine before events wrote under the store's
// mutation claim. One writer scans before it writes, so it saw every earlier card of its own.
const USER_CREST_LEGACY_LINEAGE = "legacy" as const;

interface UserCrestUnit extends ScannedKnowledgeUnit {
  readonly lineage: string;
  // TCRN-CROSS-SUB-413: the event that holds the card in its device's stream; null for a card the
  // metadata/body layout holds.
  readonly event: { readonly sequence: number; readonly eventHash: string } | null;
}

// TCRN-CROSS-SUB-413 (STORY-476 D7): one knowledge id -- one external key, since the id is derived
// from the key -- that more than one writer wrote with differing metadata, each before it saw the
// other's. None of its versions is the card: every one stays in its writer's stream and is read
// explicitly, none is selected by default or recalled while the id is unresolved, and a card whose
// supersedes names the id replaces every version at once (projectUserCrestUnits).
interface UserCrestDuplicate {
  readonly id: string;
  readonly externalKey: string;
  // One version per writer, in canonical order of the writer (its device id, or `legacy`).
  readonly versions: readonly UserCrestUnit[];
}

interface KnowledgeStoreScan {
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly metadataRoot: string;
  readonly bodiesRoot: string;
  // The old layout's views/ directory; null for a library, whose index view is this device's cache.
  readonly viewsRoot: string | null;
  readonly marker: KnowledgeStoreMarker;
  readonly workspace: WorkspaceState;
  readonly units: readonly ScannedKnowledgeUnit[];
  readonly index: Readonly<Record<string, JsonValue>>;
  // WSC-2: in rebase mode, the id-sorted set of live (non-retired) records whose
  // scope/project no longer resolves against the advanced workspace head. Empty
  // otherwise; dangling work references have their own non-blocking diagnostic.
  readonly linkInvalid: readonly string[];
  // Live records may retain links to work items removed from the current chain.
  // They remain readable and writable, while validation reports these links.
  readonly danglingWorkLinks: readonly { readonly knowledgeId: string; readonly workIds: readonly string[] }[];
  // TCRN-CROSS-SUB-309: the budget as this read measured it -- live card body bytes -- and
  // the knowledge.aggregateBytes limit it is held to.
  readonly capacity: { readonly bodyBytes: number; readonly limit: number };
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

function sourceRoots(workspaceRoot: string, workspace: WorkspaceState): readonly string[] {
  const roots = workspace.metadata.roots.map((root) => root.canonicalPath);
  const containerRoot = resolve(workspaceRoot, "../../..");
  return [...new Set([workspaceRoot, containerRoot, process.cwd(), ...roots])];
}

async function resolveSourceFile(reference: string, workspaceRoot: string, workspace: WorkspaceState): Promise<string | null> {
  if (!sourceReferenceIsFile(reference)) return null;
  if (reference.startsWith("/") || reference.includes("\\")) return null;
  for (const root of sourceRoots(workspaceRoot, workspace)) {
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
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path, "utf8") > 512 ||
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
  assertArticleField(title, 512, "article title");
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
    assertBoundedString(value, 512, label);
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
    markerBytes: 16_384,
    metadataBytes: KNOWLEDGE_LIMITS.maximumMetadataBytes,
    bodyBytes: KNOWLEDGE_LIMITS.maximumBodyBytes,
    viewBytes: PROTOCOL_LIMITS.maxCanonicalBytes,
    recordBytes: 0,
  }),
});

function storeBackendFor(storeRoot: string, options: KnowledgeReadOptions = {}): StoreBackend {
  let located: Promise<string | null> | undefined;
  return resolveStoreBackend(storeRoot, knowledgeBackendProfile, {
    beforeDescriptorReadForTest: options.beforeDescriptorReadForTest,
    afterDescriptorOpenForTest: options.afterDescriptorOpenForTest,
  }, { knowledgeViewFile: () => (located ??= libraryKnowledgeViewFile(storeRoot)) });
}

// TCRN-CROSS-STORY-469 R4: a library's knowledge index view is derived state, so it is this
// device's cache, cache/<library>/crest-views/index.json, never a file in crest/. An old-layout
// store (read-only) keeps its views/ directory.
export const KNOWLEDGE_CACHE_VIEWS_DIRECTORY = "crest-views" as const;

async function libraryKnowledgeViewFile(storeRoot: string): Promise<string | null> {
  const libraryRoot = dirname(storeRoot);
  if (!(await hasLibraryManifest(libraryRoot))) return null;
  return join(cachePath((await openLibrary(libraryRoot)).manifest.libraryId), KNOWLEDGE_CACHE_VIEWS_DIRECTORY, "index.json");
}

/**
 * Run a crest write under this machine's lock of the library (TCRN-CROSS-STORY-469 R3): the lock
 * file lives in the device directory, never in the library, and it is the one every chain write
 * takes, so the writers on one machine never interleave. The mutation claim inside crest/ stays
 * the crash journal a recovery reads. Nothing here makes two devices' crest writes safe against
 * each other. An old-layout store is read-only: its writers refuse on their own.
 */
export async function withCrestWriteLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  if (!(await hasLibraryManifest(resolve(workspaceRoot)))) return operation();
  return withWorkspaceWriteLock(workspaceRoot, () => operation());
}

export async function migrateKnowledgeBodies(workspaceRootInput: string, segmentBytes = 1_048_576): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(workspaceRootInput, () => migrateKnowledgeBodiesUnlocked(workspaceRootInput, segmentBytes));
}

async function migrateKnowledgeBodiesUnlocked(workspaceRootInput: string, segmentBytes = 1_048_576): Promise<Readonly<Record<string, JsonValue>>> {
  // Body migration is a disposable-store rewrite. It may run while the chain
  // head has advanced past store.json; the ordinary metadata-only trailing read
  // is the established way to locate the store without pretending its marker
  // is current. The caller rebase/validates the marker after the rewrite.
  const scan = await scanKnowledgeStore(workspaceRootInput, { allowTrailing: true }, false, "metadata-only");
  const backend = storeBackendFor(scan.storeRoot);
  if (!(backend instanceof SegmentedKnowledgeStoreBackend)) {
    fail("KNOWLEDGE_PARTIAL_STATE", "the local segmented knowledge backend is unavailable");
  }
  const result = await backend.migrateKnowledgeBodies(segmentBytes);
  return { schemaVersion: "tcrn.knowledge-body-migration.v1", ...result };
}

// The claim protocol is file-native (STORY-177, like STORY-174's workspace leases):
// mutation.claim is the O_EXCL exclusive file whose identity the release verifies.
// Only the data-plane IO rides through the StoreBackend; these helpers stay.
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveFile(path: string, bytes: Buffer | string): Promise<ExclusiveFile> {
  const parent = await boundDirectory(dirname(path));
  const parentBefore = await lstat(parent);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      fail("KNOWLEDGE_LINK_UNSAFE", path);
    }
    await handle.close();
    handle = undefined;
    const named = await lstat(path);
    const parentAfter = await lstat(parent);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(opened, named) || !sameIdentity(parentBefore, parentAfter)) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    await syncDirectory(parent);
    return { path, identity: { dev: named.dev, ino: named.ino } };
  } catch (error) {
    await handle?.close();
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
  if (typeof input !== "string" || input.length === 0 || input.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(input)) {
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
  if (value.length === 0 || value.length > 512) {
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
    (!Number.isSafeInteger(normalizedValue.stalenessPolicy.maximumAgeDays) || Number(normalizedValue.stalenessPolicy.maximumAgeDays) < 1 || Number(normalizedValue.stalenessPolicy.maximumAgeDays) > 3_650)) ||
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
  assertBoundedString(metadata.subject, 512, "subject");
  assertBoundedString(metadata.summary, KNOWLEDGE_LIMITS.maximumSummaryBytes, "summary");
  assertBoundedString(metadata.snippet, KNOWLEDGE_LIMITS.maximumSnippetBytes, "snippet");
  assertSortedStrings(metadata.roleScopes, KNOWLEDGE_LIMITS.maximumRoleScopes, "role scopes", /^[a-z][a-z0-9-]{0,63}$/u);
  assertSortedStrings(metadata.tags, KNOWLEDGE_LIMITS.maximumTags, "tags", /^[a-z0-9][a-z0-9-]{0,63}$/u);
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
  const index = knowledgeLinkIndexFor(workspace);
  const project = metadata.projectId === null ? undefined : index.liveProject(metadata.projectId);
  // TCRN-CROSS-STORY-476 R5: a user card lives in the user crest and never in a library's.
  if (metadata.scope === "user" ||
    (metadata.scope === "workspace" && (metadata.projectId !== null || metadata.roleScopes.length !== 0)) ||
    (metadata.scope === "project" && (!project || metadata.roleScopes.length !== 0)) ||
    (metadata.scope === "role" && metadata.roleScopes.length === 0) ||
    (metadata.projectId !== null && !project)) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:scope`);
  }
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

function requireBody(unit: ScannedKnowledgeUnit): Buffer {
  if (unit.body === null) fail("KNOWLEDGE_RECORD_INVALID", `${unit.metadata.id}:body was not admitted`);
  return unit.body;
}

function knowledgeIndex(marker: KnowledgeStoreMarker, metadata: readonly KnowledgeUnitMetadata[]): Readonly<Record<string, JsonValue>> {
  const records = [...metadata]
    .sort((left, right) => compareCanonicalText(left.id, right.id))
    // Existing stores predate STORY-326. Keep the derived view byte-compatible
    // for the default null value while metadata-first reads expose supersedes:null.
    .map((record) => Object.fromEntries(Object.entries(record).filter(([key]) =>
      !(key === "supersedes" && record.supersedes === null) &&
      !(key === "retirement" && record.retirement === null) &&
      !(key === "expansions" && Object.keys(record.expansions ?? {}).length === 0))));
  return {
    schemaVersion: "tcrn.knowledge-index.v1",
    authority: "derived-rebuildable",
    workspaceId: marker.workspaceId,
    eventHighWaterDigest: marker.eventHighWaterDigest,
    version: marker.version,
    records: records as unknown as readonly JsonValue[],
    indexDigest: canonicalSha256(records),
  };
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

// A store root holds exactly its three entries (an old-layout store adds views/), and a mutation
// claim only while a write that admitted it runs.
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
  readonly capacityBytes: number;
  readonly aggregateLimit: number;
}

interface RecordChecks {
  readonly shape: (value: Readonly<Record<string, JsonValue>>) => KnowledgeUnitMetadata;
  // WSC-2, rebase only: scope/project liveness, whose KNOWLEDGE_LINK_INVALID is collected.
  readonly links: ((metadata: KnowledgeUnitMetadata) => void) | null;
  readonly danglingWorkLinks: ((metadata: KnowledgeUnitMetadata) => readonly string[]) | null;
  readonly body: (metadata: KnowledgeUnitMetadata, body: Buffer) => void;
}

// Every card of a store, each checked by `checks` against what that store binds: a library's
// crest checks links against the library, the user crest against the card alone. The budget is
// asked for once, after the id sets are checked and before the first card is read.
async function scanStoreRecords(
  backend: StoreBackend,
  roots: { readonly metadataRoot: string; readonly bodiesRoot: string },
  bodyMode: "full" | "metadata-only",
  aggregateLimitOf: () => number,
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
  const aggregateLimit = aggregateLimitOf();
  // TCRN-CROSS-SUB-309: live card body bytes only (capacityBodyBytes).
  let capacityBytes = 0;
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
    // record's body may have been reclaimed and is read as absent.
    const hasBody = bodyIdSet.has(id);
    if (metadata.lifecycle !== "retired" && !hasBody) {
      fail("KNOWLEDGE_PARTIAL_STATE", `${id}:live record is missing its body`);
    }
    const body = bodyMode === "full" && hasBody
      ? await backend.readKnowledgeBody(id)
      : null;
    if (body !== null) checks.body(metadata, body);
    if (countsTowardCapacity(metadata)) capacityBytes += metadata.bodyBytes;
    assertWithinCapacity(capacityBytes, aggregateLimit, "knowledge aggregate bytes");
    if (metadata.id !== id) {
      fail("KNOWLEDGE_PATH_INVALID", id);
    }
    units.push({ metadataPath, bodyPath, metadata, body });
  }
  units.sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  const metadataById = new Map(units.map((unit) => [unit.metadata.id, unit.metadata]));
  for (const unit of units) validateSupersedesLink(unit.metadata, metadataById);
  danglingWorkLinks.sort((left, right) => compareCanonicalText(left.knowledgeId, right.knowledgeId));
  return { units, linkInvalid: linkInvalid.sort(compareCanonicalText), danglingWorkLinks, capacityBytes, aggregateLimit };
}

// A view kept in this device's cache (a library's crest, the user crest): another device's crest
// writes never reach it, so a missing or out-of-date copy is projected again rather than read as
// a partial store.
async function projectCachedView(backend: StoreBackend, index: Readonly<Record<string, JsonValue>>): Promise<void> {
  const cached = await backend.readKnowledgeView().then((bytes) => bytes.toString("utf8"), () => null);
  if (cached !== canonicalJson(index)) await backend.writeKnowledgeView(canonicalJson(index));
}

async function scanKnowledgeStore(
  workspaceRootInput: string,
  options: KnowledgeReadOptions = {},
  allowClaim = false,
  bodyMode: "full" | "metadata-only" = "full",
  rebase = false,
  allowStaleIndex = false,
): Promise<KnowledgeStoreScan> {
  const workspace = await materializeWorkspace(workspaceRootInput);
  const workspaceRoot = await boundDirectory(workspaceRootInput);
  // WSR-1: read the ACTIVE binding, not the raw roots array, so this stays the
  // single definition of the authority root across a relocation.
  const storedWorkspaceRoot = activeWorkspaceRoot(workspace.metadata);
  if (storedWorkspaceRoot !== workspaceRoot) {
    fail("KNOWLEDGE_PATH_INVALID", "knowledge store is not under the Workspace authority root");
  }
  const storeRoot = await boundDirectory(await knowledgeStorePath(workspaceRoot), workspaceRoot);
  const metadataRoot = await boundDirectory(resolve(storeRoot, "metadata"), storeRoot);
  const bodiesRoot = await boundDirectory(resolve(storeRoot, "bodies"), storeRoot);
  const inLibrary = await hasLibraryManifest(workspaceRoot);
  const viewsRoot = inLibrary ? null : await boundDirectory(resolve(storeRoot, "views"), storeRoot);
  // STORY-177: marker, metadata/body/view and their enumeration ride through the
  // StoreBackend; directory-structure validation stays file-native below.
  const backend = storeBackendFor(storeRoot, options);
  await assertStoreRootEntries(storeRoot, !inLibrary, allowClaim);
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
  const { units, linkInvalid, danglingWorkLinks, capacityBytes, aggregateLimit } = await scanStoreRecords(backend, { metadataRoot, bodiesRoot }, bodyMode, () => knowledgeAggregateLimit(workspace), {
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
  if (viewsRoot !== null) {
    const viewEntries = await readdir(viewsRoot);
    if (JSON.stringify(viewEntries.sort(compareCanonicalText)) !== JSON.stringify(["index.json"])) {
      fail("KNOWLEDGE_PARTIAL_STATE", "knowledge views are not exact");
    }
  }
  // TCRN-CROSS-STORY-023: the index is a derived rebuildable view whose `records`
  // array is a re-serialization of the metadata, so charging its bytes against the cap
  // taxed every record roughly twice. TCRN-CROSS-SUB-309 went the rest of the way: the
  // cap now counts live card bodies only (capacityBodyBytes), not the marker and not
  // the metadata either. The index is still validated byte-for-byte against the
  // canonical rebuild below.
  if (inLibrary) {
    await projectCachedView(backend, index);
  } else {
    const viewBytes = await backend.readKnowledgeView();
    const view = viewBytes.toString("utf8");
    if (!allowStaleIndex && view !== canonicalJson(index)) {
      fail("KNOWLEDGE_PARTIAL_STATE", "knowledge index is stale");
    }
  }
  return {
    workspaceRoot, storeRoot, metadataRoot, bodiesRoot, viewsRoot, marker, workspace, units, index,
    linkInvalid,
    danglingWorkLinks,
    capacity: { bodyBytes: capacityBytes, limit: aggregateLimit },
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

function userCrestPlacement(device: string): StoreBackendPlacement {
  const view = join(userCrestCachePath(device), KNOWLEDGE_CACHE_VIEWS_DIRECTORY, "index.json");
  return { knowledgeViewFile: async () => view };
}

function userCrestBackend(storeRoot: string, device: string, options: KnowledgeReadOptions = {}): StoreBackend {
  return resolveStoreBackend(storeRoot, knowledgeBackendProfile, {
    beforeDescriptorReadForTest: options.beforeDescriptorReadForTest,
    afterDescriptorOpenForTest: options.afterDescriptorOpenForTest,
  }, userCrestPlacement(device));
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

interface UserCrestEventStreams {
  readonly units: readonly UserCrestUnit[];
  readonly eventCount: number;
  readonly heads: readonly { readonly deviceId: string; readonly sequence: number; readonly eventHash: string }[];
}

async function readUserCrestFile(path: string, maximumBytes: number): Promise<Buffer> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    fail("KNOWLEDGE_PARTIAL_STATE", `${path}:${String((error as { code?: string }).code ?? error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) fail("KNOWLEDGE_LINK_UNSAFE", path);
  if (before.size > BigInt(maximumBytes)) fail("KNOWLEDGE_LIMIT_EXCEEDED", path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened) || opened.size > BigInt(maximumBytes)) {
      fail("KNOWLEDGE_SOURCE_CHANGED", path);
    }
    const bounded = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maximumBytes) fail("KNOWLEDGE_LIMIT_EXCEEDED", path);
    const bytes = Buffer.from(bounded.subarray(0, bytesRead));
    const after = await handle.stat({ bigint: true });
    if (after.size > BigInt(maximumBytes) || !sameIdentity(opened, after) || opened.size !== after.size || BigInt(bytes.length) !== after.size) {
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
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) fail("KNOWLEDGE_LINK_UNSAFE", path);
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

async function readUserCrestEventStreams(
  storeRoot: string,
  bodyMode: "full" | "metadata-only",
): Promise<UserCrestEventStreams> {
  const eventsPath = userCrestEventsPath(storeRoot);
  try {
    await lstat(eventsPath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { units: [], eventCount: 0, heads: [] };
    fail("KNOWLEDGE_PATH_INVALID", `${eventsPath}:${String((error as { code?: string }).code ?? error)}`);
  }
  const eventsRoot = await boundDirectory(eventsPath, storeRoot);
  const units: UserCrestUnit[] = [];
  const heads: { deviceId: string; sequence: number; eventHash: string }[] = [];
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
      const eventMatch = USER_CREST_EVENT_FILE_PATTERN.exec(streamEntry.name);
      if (eventMatch !== null && streamEntry.isFile()) {
        files.push({ name: streamEntry.name, sequence: Number(eventMatch[1]), eventHash: eventMatch[2] as string });
        continue;
      }
      if (USER_CREST_BODY_FILE_PATTERN.test(streamEntry.name) && streamEntry.isFile()) {
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
      const event = validateUserCrestEvent(parseCanonicalObject(await readUserCrestFile(eventPath, KNOWLEDGE_LIMITS.maximumMetadataBytes + 4_096), "user crest event", "KNOWLEDGE_RECORD_INVALID"), deviceId, file.name);
      if (event.sequence !== file.sequence || event.eventHash !== file.eventHash || event.priorHash !== priorHash) {
        fail("KNOWLEDGE_PARTIAL_STATE", `${deviceId}: event chain breaks at sequence ${file.sequence}`);
      }
      const bodyPath = resolve(streamRoot, event.body.file);
      if (!bodyNames.has(event.body.file)) fail("KNOWLEDGE_PARTIAL_STATE", `${deviceId}/${file.name}: body reference is missing`);
      await assertUserCrestBodyReference(bodyPath, event.body.bytes);
      const body = bodyMode === "full" ? await readUserCrestFile(bodyPath, KNOWLEDGE_LIMITS.maximumBodyBytes) : null;
      if (body !== null) validateMetadataBody(event.metadata, body, null);
      units.push({
        metadataPath: eventPath,
        bodyPath,
        metadata: event.metadata,
        body,
        readBody: async () => readUserCrestFile(bodyPath, KNOWLEDGE_LIMITS.maximumBodyBytes),
        lineage: deviceId,
        event: { sequence: event.sequence, eventHash: event.eventHash },
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
  return { units, eventCount, heads };
}

interface UserCrestProjection {
  readonly units: readonly UserCrestUnit[];
  readonly unresolvedConflicts: readonly (readonly string[])[];
  readonly duplicates: readonly UserCrestDuplicate[];
}

// Of the cards that replace one card, the one its projected supersededBy names: the latest
// written, and of those written at one instant the last in canonical id order.
function latestReplacement(replacements: readonly UserCrestUnit[]): UserCrestUnit {
  return [...replacements].sort((left, right) => {
    const leftAt = parseStrictInstant(left.metadata.updatedAt);
    const rightAt = parseStrictInstant(right.metadata.updatedAt);
    return leftAt === rightAt ? compareCanonicalText(left.metadata.id, right.metadata.id) : leftAt < rightAt ? -1 : 1;
  }).at(-1) as UserCrestUnit;
}

// TCRN-CROSS-SUB-310 (MIN-235 D7; R14 (a)): the user crest's cards, merged from every writer.
// A shared folder can deliver one device's events after another device has already written: two
// cards about one thing then stand side by side although neither writer saw the other, which the
// write-time conflict check exists to refuse. Such a pair is not a reason to refuse the whole
// crest: it is returned as an unresolved conflict, and only its two cards leave default selection.
// A pair counts only when its cards come from different writers and neither acknowledges the other:
// one writer scans before it writes, so the conflicts it saw were refused, or recorded in the new
// card's coexistsWith (--coexist, or beside a card it supersedes). A write that supersedes either
// card resolves the pair. A card replaced by more than one card -- two devices that replaced it
// before either saw the other's replacement -- is replaced either way; every replacement stays
// live, and replacements that collide form an unresolved pair like any other.
//
// TCRN-CROSS-SUB-413 (STORY-476 D7): two writers can also write one external key, and so one id,
// before either sees the other's. That is not a reason to refuse the crest either. The records are
// grouped by id: one record delivered twice, or written the same by two writers, is one card; a
// writer holding two different records for one id is refused, since one writer scans before it
// writes and a stream like that is not one this engine writes; and differing records from different
// writers are the versions of a duplicate, held apart from the cards (UserCrestDuplicate). Each
// version's own supersedes still replaces the card it names, and a card whose supersedes names the
// duplicate's id replaces every version. Versions are not paired: they are withheld already.
function projectUserCrestUnits(units: readonly UserCrestUnit[]): UserCrestProjection {
  const written = new Map<string, UserCrestUnit[]>();
  for (const unit of units) written.set(unit.metadata.id, [...(written.get(unit.metadata.id) ?? []), unit]);
  const byId = new Map<string, UserCrestUnit>();
  const divergent = new Map<string, readonly UserCrestUnit[]>();
  for (const [id, records] of written) {
    const versions: UserCrestUnit[] = [];
    for (const unit of [...records].sort((left, right) => compareCanonicalText(left.lineage, right.lineage))) {
      if (versions.some((version) => canonicalJson(version.metadata) === canonicalJson(unit.metadata))) continue;
      if (versions.some((version) => version.lineage === unit.lineage)) {
        fail("KNOWLEDGE_PARTIAL_STATE", `${id}: writer ${unit.lineage} holds conflicting events for one knowledge id`);
      }
      versions.push(unit);
    }
    if (versions.length === 1) byId.set(id, versions[0] as UserCrestUnit);
    else divergent.set(id, versions);
  }
  const replacements = new Map<string, UserCrestUnit[]>();
  for (const unit of [...byId.values(), ...[...divergent.values()].flat()]) {
    if (unit.metadata.supersedes === null) continue;
    if (!byId.has(unit.metadata.supersedes) && !divergent.has(unit.metadata.supersedes)) {
      fail("KNOWLEDGE_LINK_INVALID", `${unit.metadata.id}:supersedes:${unit.metadata.supersedes}`);
    }
    replacements.set(unit.metadata.supersedes, [...(replacements.get(unit.metadata.supersedes) ?? []), unit]);
  }
  const projectReplaced = (unit: UserCrestUnit): UserCrestUnit => {
    const successors = replacements.get(unit.metadata.id);
    // A card the metadata/body layout already marked replaced keeps the mark it was written with.
    if (successors === undefined || unit.metadata.extensions.supersededBy !== undefined) return unit;
    const successor = latestReplacement(successors);
    const metadata = validateExistingMetadataShape({
      ...unit.metadata,
      extensions: { ...unit.metadata.extensions, supersededBy: successor.metadata.id },
      revision: unit.metadata.revision + 1,
      updatedAt: successor.metadata.updatedAt,
    }, null);
    return { ...unit, metadata };
  };
  const projected = [...byId.values()].map(projectReplaced)
    .sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
  const duplicates = [...divergent].map(([id, versions]): UserCrestDuplicate => ({
    id,
    externalKey: (versions[0] as UserCrestUnit).metadata.externalKey,
    versions: versions.map(projectReplaced),
  })).sort((left, right) => compareCanonicalText(left.id, right.id));
  const byProjectedId = new Map(projected.map((unit) => [unit.metadata.id, unit.metadata]));
  for (const duplicate of duplicates) byProjectedId.set(duplicate.id, (duplicate.versions[0] as UserCrestUnit).metadata);
  for (const unit of [...projected, ...duplicates.flatMap((duplicate) => duplicate.versions)]) validateSupersedesLink(unit.metadata, byProjectedId);
  const unresolvedConflicts: (readonly string[])[] = [];
  for (let leftIndex = 0; leftIndex < projected.length; leftIndex += 1) {
    const left = projected[leftIndex] as UserCrestUnit;
    if (!countsTowardCapacity(left.metadata)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < projected.length; rightIndex += 1) {
      const right = projected[rightIndex] as UserCrestUnit;
      if (!countsTowardCapacity(right.metadata) || left.lineage === right.lineage) continue;
      const conflicts = knowledgeConflictHits([left.metadata], right.metadata.subject, [right.metadata.id]).length > 0 ||
        knowledgeConflictHits([right.metadata], left.metadata.subject, [left.metadata.id]).length > 0;
      const acknowledged = left.metadata.extensions.coexistsWith?.includes(right.metadata.id) === true ||
        right.metadata.extensions.coexistsWith?.includes(left.metadata.id) === true;
      if (conflicts && !acknowledged) unresolvedConflicts.push([left.metadata.id, right.metadata.id]);
    }
  }
  return { units: projected, unresolvedConflicts, duplicates };
}

// The ids of the cards an unresolved conflict holds out of default selection.
function unresolvedConflictIds(scan: Pick<UserCrestScan, "unresolvedConflicts">): ReadonlySet<string> {
  return new Set(scan.unresolvedConflicts.flat());
}

// TCRN-CROSS-SUB-413: a duplicate is unresolved while one of its versions is still live -- not
// replaced and not retired. A card whose supersedes names its id resolves it.
function unresolvedDuplicates(scan: Pick<UserCrestScan, "duplicates">): readonly UserCrestDuplicate[] {
  return scan.duplicates.filter((duplicate) => duplicate.versions.some((version) => countsTowardCapacity(version.metadata)));
}

// Every record the user crest holds -- its cards and every version of every duplicate -- in
// canonical id order, the versions of one id in their canonical writer order: what its index view,
// its budget and a `--selection all` list read.
function userCrestRecords(scan: Pick<UserCrestScan, "units" | "duplicates">): readonly ScannedKnowledgeUnit[] {
  return [...scan.units, ...scan.duplicates.flatMap((duplicate) => duplicate.versions)]
    .sort((left, right) => compareCanonicalText(left.metadata.id, right.metadata.id));
}

// Which writer holds a version, and where: the device whose event stream holds it, with the event's
// sequence and hash; all three null for a version the metadata/body layout holds.
function duplicateVersionIdentity(version: UserCrestUnit): Readonly<Record<string, JsonValue>> {
  return version.event === null
    ? { deviceId: null, sequence: null, eventHash: null }
    : { deviceId: version.lineage, sequence: version.event.sequence, eventHash: version.event.eventHash };
}

// The diagnostic entry of one duplicate, as knowledge-list, a read of its id and recall name it
// (knowledge-core-v1.md, "Storage and authority").
function duplicateDiagnostic(duplicate: UserCrestDuplicate): Readonly<Record<string, JsonValue>> {
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
  const actual = (await readdir(storeRoot)).sort(compareCanonicalText);
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
): Promise<UserCrestScan> {
  const parent = await userCrestParent(location, false);
  const storeRoot = await boundDirectory(join(parent, basename(location.root)), parent);
  const backend = userCrestBackend(storeRoot, location.device, options);
  const marker = validateMarker(parseCanonicalObject(await backend.readKnowledgeMarker(), "knowledge marker", "KNOWLEDGE_RECORD_INVALID"));
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
  let legacyUnits: readonly UserCrestUnit[] = [];
  if (legacyLayout) {
    const metadataRoot = await boundDirectory(resolve(storeRoot, "metadata"), storeRoot);
    const bodiesRoot = await boundDirectory(resolve(storeRoot, "bodies"), storeRoot);
    const legacy = await scanStoreRecords(backend, { metadataRoot, bodiesRoot }, bodyMode, () => KNOWLEDGE_AGGREGATE_DEFAULT, {
      shape: (value) => validateMetadataShape(value, null),
      links: null,
      danglingWorkLinks: null,
      body: (metadata, body) => validateMetadataBody(metadata, body, null),
    });
    legacyUnits = legacy.units.map((unit): UserCrestUnit => ({ ...unit, lineage: USER_CREST_LEGACY_LINEAGE, event: null }));
  }
  const streams = hasEvents ? await readUserCrestEventStreams(storeRoot, bodyMode) : { units: [], eventCount: 0, heads: [] };
  const { units, unresolvedConflicts, duplicates } = projectUserCrestUnits([...legacyUnits, ...streams.units]);
  // TCRN-CROSS-SUB-413: every live version of a duplicate is live body bytes until a card
  // supersedes its id; the index view lists every version beside the cards.
  const records = userCrestRecords({ units, duplicates }).map((unit) => unit.metadata);
  // O-1 is pending (R14 (b)): a merge whose live bodies exceed the budget is refused whole here,
  // unchanged; recall reports the refusal as a degraded user crest (readRecallCards).
  const capacityBytes = capacityBodyBytes(records);
  const aggregateLimit = KNOWLEDGE_AGGREGATE_DEFAULT;
  assertWithinCapacity(capacityBytes, aggregateLimit, "knowledge aggregate bytes");
  const eventHighWaterDigest = streams.eventCount === 0
    ? marker.eventHighWaterDigest
    : canonicalSha256({ schemaVersion: USER_CREST_EVENT_HEAD_SCHEMA_VERSION, heads: streams.heads } as unknown as JsonValue);
  const projectedMarker: KnowledgeStoreMarker = {
    ...marker,
    version: marker.version + streams.eventCount,
    eventHighWaterDigest,
  };
  const index = knowledgeIndex(projectedMarker, records);
  await projectCachedView(backend, index);
  return {
    storeRoot, device: location.device, eventOnly: !legacyLayout, eventHeads: streams.heads, marker: projectedMarker, units, index,
    capacity: { bodyBytes: capacityBytes, limit: aggregateLimit }, unresolvedConflicts, duplicates,
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
  if (entries.some((entry) => entry !== USER_CREST_EVENTS_DIRECTORY)) {
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
  try {
    await writeExclusiveFile(resolve(storeRoot, "store.json"), canonicalJson(marker));
  } catch (error) {
    if (!(error instanceof KnowledgeCoreError) || error.reasonCode !== "KNOWLEDGE_ALREADY_EXISTS") throw error;
    const markerBytes = await userCrestBackend(storeRoot, location.device).readKnowledgeMarker();
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
  const markerBytes = await userCrestBackend(storeRoot, location.device).readKnowledgeMarker();
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

async function writeImmutableUserCrestFile(path: string, bytes: Buffer | string): Promise<void> {
  try {
    await writeExclusiveFile(path, bytes);
  } catch (error) {
    if (!(error instanceof KnowledgeCoreError) || error.reasonCode !== "KNOWLEDGE_ALREADY_EXISTS") throw error;
    const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    const existing = await readUserCrestFile(path, Math.max(expected.length, 1));
    if (!existing.equals(expected)) fail("KNOWLEDGE_PARTIAL_STATE", `${path}: immutable event data differs`);
  }
}

/**
 * The user crest as a read sees it, under this machine's lock of it; `read` runs inside the lock.
 * Before the crest's first card there is nothing to read, and `read` is handed null.
 */
async function readUserCrest<T>(options: KnowledgeReadOptions, read: (scan: UserCrestScan | null) => Promise<T>): Promise<T> {
  const location = await locateUserCrest();
  if (!(await userCrestInitialized(location.root))) return read(null);
  return withUserCrestLock(location, async () => read(await scanUserCrest(location, options, false, "metadata-only")));
}

function assertStoreScope(scope: unknown): asserts scope is KnowledgeStoreScope | undefined {
  if (scope !== undefined && !(KNOWLEDGE_STORE_SCOPES as readonly unknown[]).includes(scope)) {
    fail("KNOWLEDGE_INPUT_INVALID", `scope=${String(scope)}`);
  }
}

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

async function acquireMutationClaim(scan: KnowledgeStoreScan): Promise<KnowledgeMutationClaim> {
  await assertKnowledgeWritable(scan.workspaceRoot);
  return claimKnowledgeStore(scan);
}

// The claim itself, in the store root of a library's crest or of the user crest: the O_EXCL
// crash journal a recovery reads.
async function claimKnowledgeStore(scan: Pick<CrestScan, "storeRoot" | "marker">): Promise<KnowledgeMutationClaim> {
  const token = randomBytes(24).toString("hex");
  const acquiredAt = new Date().toISOString();
  try {
    const claim = await writeExclusiveFile(resolve(scan.storeRoot, "mutation.claim"), canonicalJson({
      schemaVersion: "tcrn.knowledge-mutation-claim.v1",
      workspaceId: scan.marker.workspaceId,
      version: scan.marker.version,
      token,
      pid: process.pid,
      acquiredAt,
    }));
    return { ...claim, workspaceId: scan.marker.workspaceId, token, pid: process.pid, acquiredAt };
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_ALREADY_EXISTS") {
      fail("KNOWLEDGE_LOCKED", "knowledge mutation claim exists");
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
    return withUserCrestLock(location, () => recoverUserCrestUnlocked(location, options));
  }
  return withCrestWriteLock(workspaceRoot, () => recoverKnowledgeStoreUnlocked(workspaceRoot, options));
}

async function recoverUserCrestUnlocked(location: UserCrestLocation, options: KnowledgeReadOptions): Promise<Readonly<Record<string, JsonValue>>> {
  const claimedRoot = join(await userCrestParent(location, false), basename(location.root));
  const claim = await readMutationClaim(claimedRoot);
  if (claim === null) {
    return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERY_NOT_NEEDED", recovered: false, scope: "user" };
  }
  if (processIsAlive(claim.pid)) fail("KNOWLEDGE_LOCKED", "knowledge mutation claim belongs to a live process");
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
  const backend = userCrestBackend(scan.storeRoot, location.device, options);
  await writeIndex(backend, scan.marker, userCrestRecords(scan).map((unit) => unit.metadata));
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
  if (claim === null) {
    return { schemaVersion: "tcrn.knowledge-recovery-result.v1", reasonCode: "KNOWLEDGE_RECOVERY_NOT_NEEDED", recovered: false };
  }
  if (processIsAlive(claim.pid)) fail("KNOWLEDGE_LOCKED", "knowledge mutation claim belongs to a live process");
  const scan = await scanKnowledgeStore(workspaceRoot, options, true, "full", false, true);
  const boundClaim = await readMutationClaim(scan.storeRoot);
  if (boundClaim === null || boundClaim.token !== claim.token || boundClaim.pid !== claim.pid ||
    boundClaim.workspaceId !== scan.marker.workspaceId || !sameIdentity(boundClaim.identity, claim.identity)) {
    fail("KNOWLEDGE_SOURCE_CHANGED", "knowledge mutation claim changed during recovery");
  }
  const backend = storeBackendFor(scan.storeRoot, options);
  const readView = async (): Promise<Readonly<Record<string, JsonValue>>> => {
    const viewValue = parseCanonicalObject(await backend.readKnowledgeView(), "knowledge index", "KNOWLEDGE_RECORD_INVALID");
    if (viewValue.schemaVersion !== "tcrn.knowledge-index.v1" || viewValue.authority !== "derived-rebuildable" ||
      viewValue.workspaceId !== scan.marker.workspaceId || viewValue.eventHighWaterDigest !== scan.marker.eventHighWaterDigest ||
      !Number.isSafeInteger(viewValue.version) || Number(viewValue.version) < 0 || !Array.isArray(viewValue.records) ||
      typeof viewValue.indexDigest !== "string" || !/^[a-f0-9]{64}$/u.test(viewValue.indexDigest)) {
      fail("KNOWLEDGE_RECORD_INVALID", "knowledge index fields");
    }
    return viewValue;
  };
  // A library's view is this device's cache (the scan above has just projected it again), so it
  // cannot tell whether the interrupted mutation wrote records the marker does not count yet;
  // the version then advances, which is safe whenever it is not needed.
  const viewValue = scan.viewsRoot === null ? null : await readView();
  const indexNeedsVersionAdvance = viewValue === null || (scan.marker.version === Number(viewValue.version) &&
    canonicalJson(viewValue) !== canonicalJson(scan.index));
  const marker: KnowledgeStoreMarker = indexNeedsVersionAdvance
    ? { ...scan.marker, version: scan.marker.version + 1 }
    : scan.marker;
  await backend.writeKnowledgeMarker(canonicalJson(marker));
  await writeIndex(backend, marker, scan.units.map((unit) => unit.metadata));
  let reclaimedRetiredBodies = 0;
  for (const unit of scan.units) {
    if (unit.metadata.lifecycle !== "retired" || unit.body === null) continue;
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
    version: marker.version,
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

// TCRN-CROSS-STORY-365: a card the writer replaced stops being a default answer. It is
// still readable explicitly and still exports; it just no longer competes with the card
// that supersedes it, which is the whole point of having chosen --supersedes.
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
  // one function every write path reaches. knowledge-create calls it directly,
  // knowledge-capture calls it through captureKnowledgeUnit, and conference-close --distill
  // calls it once per distilled decision.
  //
  // Fail-closed: a workspace that records artifact.language and cannot produce the
  // translation refuses here, with the reason code the caller can act on, rather than
  // storing prose in a language its own retrieval set does not cover.
  let language;
  try {
    language = applyWriteLanguagePolicy(
      { subject: input.subject, summary: input.summary, snippet: input.snippet },
      readKnowledgeLanguagePolicy(workspace.settings, host),
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
  return metadata;
}

async function writeIndex(backend: StoreBackend, marker: KnowledgeStoreMarker, metadata: readonly KnowledgeUnitMetadata[]): Promise<void> {
  await backend.writeKnowledgeView(canonicalJson(knowledgeIndex(marker, metadata)));
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
  const metadataRoot = await ensureNewDirectory(resolve(storeRoot, "metadata"), storeRoot);
  const bodiesRoot = await ensureNewDirectory(resolve(storeRoot, "bodies"), storeRoot);
  void metadataRoot;
  void bodiesRoot;
  // A library's index view goes to the device cache (libraryKnowledgeViewFile); only an old-layout
  // store, which this engine no longer creates, had a views/ directory in its root.
  const marker: KnowledgeStoreMarker = {
    schemaVersion: KNOWLEDGE_STORE_SCHEMA_VERSION,
    workspaceId: workspace.metadata.workspaceId,
    eventHighWaterDigest: workspace.headEventHash,
    version: 0,
    disposable: true,
    authority: "metadata-index-authority-body-separate",
  };
  const backend = storeBackendFor(storeRoot);
  await backend.writeKnowledgeMarker(canonicalJson(marker));
  await backend.writeKnowledgeView(canonicalJson(knowledgeIndex(marker, [])));
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

export async function readKnowledgeStoreMarker(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  // INC-244: this is the bounded diagnostic read used before automatic rebase.
  // It is separate from validateKnowledgeStore so the strict validation contract
  // cannot accidentally become a trailing-read exemption.
  const scan = await scanKnowledgeStore(workspaceRoot, { ...options, allowTrailing: true }, false, "metadata-only");
  return {
    schemaVersion: "tcrn.knowledge-store-marker-read.v1",
    reasonCode: "KNOWLEDGE_STORE_MARKER_READ",
    workspaceId: scan.marker.workspaceId,
    version: scan.marker.version,
    records: scan.units.length,
    indexDigest: scan.index.indexDigest ?? "",
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    ...(scan.marker.lastSweepAt === undefined ? {} : { lastSweepAt: scan.marker.lastSweepAt }),
    ...trailingDisclosure(scan),
  };
}

export async function validateKnowledgeStore(workspaceRoot: string, options: KnowledgeReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  const scan = await scanKnowledgeStore(workspaceRoot, options);
  return {
    schemaVersion: "tcrn.knowledge-store-validation.v1",
    reasonCode: "KNOWLEDGE_STORE_VALID",
    workspaceId: scan.marker.workspaceId,
    version: scan.marker.version,
    records: scan.units.length,
    indexDigest: scan.index.indexDigest ?? "",
    eventHighWaterDigest: scan.marker.eventHighWaterDigest,
    // TCRN-CROSS-SUB-309: the capacity report -- live card body bytes against the
    // knowledge.aggregateBytes limit.
    capacity: { bodyBytes: scan.capacity.bodyBytes, limit: scan.capacity.limit },
    ...(scan.danglingWorkLinks.length === 0 ? {} : { danglingWorkLinks: scan.danglingWorkLinks }),
  };
}

// TCRN-CROSS-STORY-476 R5: the store a create lands in -- a library's crest or the user crest --
// and how that store is laid out on first use, scanned, claimed and written.
interface CrestWriteTarget<S extends CrestScan> {
  readonly scope: KnowledgeStoreScope;
  readonly prepare: () => Promise<void>;
  readonly admissionScan: (options: KnowledgeReadOptions) => Promise<S>;
  readonly scan: (options: KnowledgeReadOptions, allowClaim: boolean) => Promise<S>;
  readonly claim: (scan: S) => Promise<KnowledgeMutationClaim>;
  readonly backend: (storeRoot: string, options: KnowledgeReadOptions) => StoreBackend;
  // What a card's links are checked against: the library's state, or null for the user crest.
  readonly linkState: (scan: S) => WorkspaceState | null;
}

function libraryCrestTarget(workspaceRoot: string): CrestWriteTarget<KnowledgeStoreScan> {
  return {
    scope: "project",
    prepare: async () => undefined,
    admissionScan: (options) => mutationAdmissionScan(workspaceRoot, options),
    scan: (options, allowClaim) => scanKnowledgeStore(workspaceRoot, options, allowClaim),
    claim: (scan) => acquireMutationClaim(scan),
    backend: (storeRoot, options) => storeBackendFor(storeRoot, options),
    linkState: (scan) => scan.workspace,
  };
}

/**
 * Write one card. TCRN-CROSS-STORY-476 R5: scope "user" writes it to this user's crest, under this
 * machine's lock of the user crest, and the crest's first card lays the crest out; the library at
 * `workspaceRoot` still supplies the language policy and the source files the card names. Every
 * other scope writes the library's crest, as it always did.
 */
export async function createKnowledgeUnit(workspaceRoot: string, input: CreateKnowledgeUnitInput, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  if (input.scope === "user") {
    const location = await locateUserCrest();
    return withUserCrestLock(location, () => createUserCrestEvent(workspaceRoot, input, options, location));
  }
  return withCrestWriteLock(workspaceRoot, () => createKnowledgeUnitUnlocked(workspaceRoot, input, options, libraryCrestTarget(workspaceRoot)));
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
    : await calculateKnowledgeSourceDigest(workspaceRoot, workspace, input.sourceReferences, input.body);
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
  // much as a card: a conflict it scores against (named once per id), an id and external key it may
  // not reuse, and live body bytes of the budget. A write whose supersedes names a duplicate's id
  // replaces every version of it at once; it is refused only when every version is retired.
  const records = userCrestRecords(scan);
  const replacedRecords = metadata.supersedes === null ? [] : records.filter((unit) => unit.metadata.id === metadata.supersedes);
  if (metadata.supersedes !== null && replacedRecords.every((unit) => unit.metadata.lifecycle === "retired")) {
    fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:supersedes:${metadata.supersedes}`);
  }
  const conflicts = [...new Set(knowledgeConflictHits(
    records.map((unit) => unit.metadata),
    metadata.subject,
    metadata.supersedes === null ? [metadata.id] : [metadata.id, metadata.supersedes],
  ))];
  if (conflicts.length > 0 && metadata.supersedes === null && input.coexist !== true) {
    fail("KNOWLEDGE_POSSIBLE_CONFLICT", conflicts.join(","), { conflicts: [...conflicts] });
  }
  // TCRN-CROSS-SUB-310: the conflicts this write saw and was admitted beside -- with --coexist, or
  // beside the card it supersedes -- are recorded in the card, so a reader tells them from a
  // conflict no writer saw (projectUserCrestUnits). A library's write records only --coexist.
  const written: KnowledgeUnitMetadata = conflicts.length === 0
    ? metadata
    : { ...metadata, extensions: { coexistsWith: conflicts.slice(0, KNOWLEDGE_LIMITS.maximumQueryResults) } };
  if (written !== metadata) validateMetadataBody(validateMetadataShape(written as unknown as Readonly<Record<string, JsonValue>>, null), body, null);
  const metadataBytes = Buffer.from(canonicalJson(written), "utf8");
  if (metadataBytes.length > KNOWLEDGE_LIMITS.maximumMetadataBytes) fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge create budget");
  if (records.some((unit) => unit.metadata.id === metadata.id || unit.metadata.externalKey === metadata.externalKey)) {
    fail("KNOWLEDGE_DUPLICATE", metadata.id);
  }

  // The records this write replaces, as the next read projects them. A retired one gives no bytes
  // back and is left as it is. A record of the metadata/body layout carries no body reader of its
  // own (a version of a duplicate can be one), so its body is read as an explicit read reads it.
  const replaced = new Map<ScannedKnowledgeUnit, KnowledgeUnitMetadata>();
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
    replaced.set(unit, supersededMetadata);
  }
  const projectedMetadata = records.map((unit) => replaced.get(unit) ?? unit.metadata).concat(written);
  assertWithinCapacity(capacityBodyBytes(projectedMetadata), scan.capacity.limit, "knowledge create budget");

  const sequenceText = String(sequence).padStart(8, "0");
  const bodyFile = `${sequenceText}-${written.bodySha256}.body`;
  const bodyPath = resolve(streamRoot, bodyFile);
  await writeImmutableUserCrestFile(bodyPath, body);
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
  await writeImmutableUserCrestFile(eventPath, canonicalJson(event));
  crash("after-metadata-write", options.faultAt);
  // The user crest root manifest is initialized once. Event heads carry the changing high-water
  // projection, so no multi-device writer performs a shared manifest update.
  crash("after-marker-write", options.faultAt);
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

async function createKnowledgeUnitUnlocked<S extends CrestScan>(
  workspaceRoot: string,
  input: CreateKnowledgeUnitInput,
  options: KnowledgeMutationOptions,
  target: CrestWriteTarget<S>,
): Promise<Readonly<Record<string, JsonValue>>> {
  assertBoundedString(input.body, KNOWLEDGE_LIMITS.maximumBodyBytes, "body");
  const body = Buffer.from(input.body, "utf8");
  const workspace = await materializeWorkspace(workspaceRoot);
  const sourceDigest = input.sourceDigest && input.sourceDigest.length > 0
    ? input.sourceDigest
    : await calculateKnowledgeSourceDigest(workspaceRoot, workspace, input.sourceReferences, input.body);
  const metadata = buildMetadata({ ...input, sourceDigest }, body, workspace, options.languageProvider, options.host);
  await target.prepare();
  const initial = await target.admissionScan(options);
  const claim = await target.claim(initial);
  // WSC-6: every escape from the claim-held region that leaves this process alive must
  // give the claim back. scanKnowledgeStore alone raises eight distinct reason codes, and
  // one leaked claim bricks the store for good: each later mutationAdmissionScan re-maps
  // the resulting partial state to KNOWLEDGE_LOCKED, and no verb can clear it.
  //
  // The KNOWLEDGE_FAULT_INJECTED exemption is deliberate. A real SIGKILL never runs a
  // finally block, so a retained claim is the operating system's doing, not ours, and it
  // is the signal that the store is mid-write. crash() is the only executable proxy for
  // that scenario; releasing on it would turn the fault-injection tests into a weaker
  // duplicate of the ordinary-error path and leave "a crash leaves the store claim-held"
  // with no executable expression anywhere. This is why the reverify/policy/article
  // finallys below are NOT the model to copy here.
  let released = false;
  try {
    const scan = await target.scan(options, true);
    const linkState = target.linkState(scan);
    let superseded: ScannedKnowledgeUnit | undefined;
    if (metadata.supersedes !== null) {
      superseded = scan.units.find((unit) => unit.metadata.id === metadata.supersedes);
      if (superseded === undefined || superseded.metadata.lifecycle === "retired") {
        fail("KNOWLEDGE_LINK_INVALID", `${metadata.id}:supersedes:${metadata.supersedes}`);
      }
    }
    // TCRN-CROSS-STORY-365: score before writing. Above the threshold the writer must have
    // said which it is -- this card replaces those (--supersedes) or stands beside them
    // (--coexist) -- and the refusal hands back the hit list rather than only naming it.
    const conflicts = knowledgeConflictHits(
      scan.units.map((unit) => unit.metadata),
      metadata.subject,
      metadata.supersedes === null ? [metadata.id] : [metadata.id, metadata.supersedes],
    );
    if (conflicts.length > 0 && metadata.supersedes === null && input.coexist !== true) {
      fail("KNOWLEDGE_POSSIBLE_CONFLICT", conflicts.join(","), { conflicts: [...conflicts] });
    }
    const written: KnowledgeUnitMetadata = conflicts.length === 0 || metadata.supersedes !== null
      ? metadata
      : { ...metadata, extensions: { coexistsWith: conflicts.slice(0, KNOWLEDGE_LIMITS.maximumQueryResults) } };
    // The replaced card carries the mark, so "which one did this replace" is answerable
    // from either end and default retrieval drops the loser without deleting it.
    const supersededMetadata: KnowledgeUnitMetadata | null = superseded === undefined ? null : {
      ...superseded.metadata,
      extensions: { ...superseded.metadata.extensions, supersededBy: written.id },
      revision: superseded.metadata.revision + 1,
      updatedAt: input.occurredAt,
    };
    if (written !== metadata) validateMetadataBody(validateMetadataShape(written as unknown as Readonly<Record<string, JsonValue>>, linkState), body, linkState);
    if (supersededMetadata !== null && superseded !== undefined) {
      validateMetadataBody(validateExistingMetadataShape(supersededMetadata, linkState), requireBody(superseded), linkState);
    }
    const metadataBytes = Buffer.from(canonicalJson(written), "utf8");
    const marker: KnowledgeStoreMarker = { ...scan.marker, version: scan.marker.version + 1 };
    const projectedMetadata = [...scan.units.map((unit) =>
      supersededMetadata !== null && unit.metadata.id === supersededMetadata.id ? supersededMetadata : unit.metadata), written];
    // TCRN-CROSS-SUB-309: the create projection mirrors the scan's measure -- the live card
    // bodies once this write lands. The new body joins it, and a card this write supersedes
    // leaves it, which is how a replacement makes room rather than doubling the store.
    // STORY-330: no record-count admission branch remains. The body budget and the
    // canonical metadata/body limits are the capacity checks.
    if (metadataBytes.length > KNOWLEDGE_LIMITS.maximumMetadataBytes) {
      fail("KNOWLEDGE_LIMIT_EXCEEDED", "knowledge create budget");
    }
    // The scan measured knowledge.aggregateBytes against the same state (a library's settings, or
    // the default for the user crest), so the limit is the scan's.
    assertWithinCapacity(capacityBodyBytes(projectedMetadata), scan.capacity.limit, "knowledge create budget");
    if (scan.units.some((unit) => unit.metadata.id === metadata.id || unit.metadata.externalKey === metadata.externalKey)) {
      fail("KNOWLEDGE_DUPLICATE", metadata.id);
    }
    const backend = target.backend(scan.storeRoot, options);
    await backend.writeKnowledgeBody(written.id, body);
    crash("after-body-write", options.faultAt);
    await backend.writeKnowledgeMetadata(written.id, metadataBytes);
    if (supersededMetadata !== null) await backend.writeKnowledgeMetadata(supersededMetadata.id, canonicalJson(supersededMetadata));
    crash("after-metadata-write", options.faultAt);
    await backend.writeKnowledgeMarker(canonicalJson(marker));
    crash("after-marker-write", options.faultAt);
    await writeIndex(backend, marker, projectedMetadata);
    await releaseMutationClaim(scan.storeRoot, claim);
    released = true;
    const final = await target.scan(options, false);
    return {
      schemaVersion: "tcrn.knowledge-create-result.v1",
      reasonCode: "KNOWLEDGE_UNIT_CREATED",
      id: written.id,
      externalKey: written.externalKey,
      revision: written.revision,
      version: final.marker.version,
      // A card in the user crest says so; a library's answer keeps the shape it always had.
      ...(target.scope === "user" ? { scope: "user" } : {}),
      ...(conflicts.length > 0 ? { conflicts: [...conflicts] } : {}),
      ...(supersededMetadata === null ? {} : { superseded: supersededMetadata.id }),
    };
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_FAULT_INJECTED") released = true;
    throw error;
  } finally {
    if (!released) await releaseMutationClaim(initial.storeRoot, claim);
  }
}

export async function createKnowledgeArticle(
  workspaceRoot: string,
  input: KnowledgeArticleCreateInput,
  options: KnowledgeMutationOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  try { assertStrictInstant(input.occurredAt); } catch (error) { fail("KNOWLEDGE_INPUT_INVALID", String(error)); }
  if (!ARTICLE_CATEGORY_VALUES.includes(input.category)) fail("KNOWLEDGE_INPUT_INVALID", "article category");
  assertArticleField(input.title, 512, "article title");
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
  const workspace = await materializeWorkspace(workspaceRoot);
  const article = await articlePathFor(workspaceRoot, workspace, input.path);
  const markdown = articleMarkdown(input.category, input.title, input.content);
  const body = articleIndexBody(input.title, input.summary, input.path);
  const articleBytes = await writeArticleBytes(article.file, markdown, false);
  const sourceDigest = sha256(articleBytes);
  const externalKey = `ARTICLE-${sha256(input.path).slice(0, 24).toUpperCase()}`;
  try {
    const created = await createKnowledgeUnit(workspaceRoot, {
      occurredAt: input.occurredAt,
      externalKey,
      scope: "workspace",
      projectId: null,
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
  readonly scope?: "role" | "workspace" | "user";
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
 * omitted, it is read here and the mutation claim inside createKnowledgeUnit is what
 * serialises writers.
 */
export async function captureKnowledgeUnit(
  workspaceRoot: string,
  input: CaptureKnowledgeUnitInput,
  options: KnowledgeMutationOptions = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  // A derived key so the hook never has to invent one, and so the same lesson written
  // twice at the same instant is a duplicate rather than a second card.
  const externalKey = input.externalKey ??
    `CAPTURE-${createHash("sha256").update(`${input.subject}\u0000${input.body}\u0000${input.occurredAt}`, "utf8").digest("hex").slice(0, 24).toUpperCase()}`;
  const scope = input.scope ?? "role";
  return createKnowledgeUnit(workspaceRoot, {
    occurredAt: input.occurredAt,
    externalKey,
    scope,
    projectId: null,
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

// WSC-2: re-bind the store to the advanced workspace head after full per-record
// re-validation. Invalid scope/project links still block the rebase; dangling work
// links remain attached and are reported without blocking access. Single version step
// under a mutation claim.
export async function rebaseKnowledgeStore(...args: Parameters<typeof rebaseKnowledgeStoreUnlocked>): Promise<Readonly<Record<string, JsonValue>>> {
  return withCrestWriteLock(args[0], () => rebaseKnowledgeStoreUnlocked(...args));
}

async function rebaseKnowledgeStoreUnlocked(workspaceRoot: string, input: {
  readonly at: string;
}, options: KnowledgeMutationOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(input.at);
  const workspace = await materializeWorkspace(workspaceRoot);
  const initial = await mutationAdmissionScan(workspaceRoot, options, true);
  const claim = await acquireMutationClaim(initial);
  // WSC-6: see createKnowledgeUnit for the full rationale, including why
  // KNOWLEDGE_FAULT_INJECTED is exempt.
  let released = false;
  try {
    const scan = await scanKnowledgeStore(workspaceRoot, options, true, "full", true);
    // Scope/project offenders still block rebase. Dangling linked work is diagnostic only;
    // neither this write nor its receipt retires or rewrites those records.
    const offenders = scan.linkInvalid;
    if (offenders.length > 0) {
      fail("KNOWLEDGE_REBASE_BLOCKED", offenders.join(","));
    }
    const marker: KnowledgeStoreMarker = { ...scan.marker, eventHighWaterDigest: workspace.headEventHash ?? scan.marker.eventHighWaterDigest, version: scan.marker.version + 1 };
    const backend = storeBackendFor(scan.storeRoot, options);
    crash("after-metadata-write", options.faultAt);
    await backend.writeKnowledgeMarker(canonicalJson(marker));
    crash("after-marker-write", options.faultAt);
    await writeIndex(backend, marker, scan.units.map((unit) => unit.metadata));
    await releaseMutationClaim(scan.storeRoot, claim);
    released = true;
    const final = await scanKnowledgeStore(workspaceRoot, options);
    return {
      schemaVersion: "tcrn.knowledge-rebase-result.v1",
      reasonCode: "KNOWLEDGE_STORE_REBASED",
      version: final.marker.version,
      eventHighWaterDigest: final.marker.eventHighWaterDigest,
      // The v1 result keeps its two fields: a rebase that lands retired nothing and had no
      // scope/project offender, since such an offender still refuses it.
      retired: 0,
      offenders: [],
      ...(final.danglingWorkLinks.length === 0 ? {} : { danglingWorkLinks: final.danglingWorkLinks }),
    };
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_FAULT_INJECTED") released = true;
    throw error;
  } finally {
    if (!released) await releaseMutationClaim(initial.storeRoot, claim);
  }
}

interface NormalizedListQuery {
  readonly selection: "default" | "all";
  readonly search: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

// WSC-4: the metadata selection behind listKnowledgeMetadata. (The WSC-7 context-route
// bridge that shared it went with the context router, TCRN-CROSS-STORY-467 R2.)
function normalizeListQuery(query: KnowledgeListQuery): NormalizedListQuery {
  assertEvaluationInstant(query.at);
  const selection = query.selection ?? "default";
  assertSelection(selection);
  let search: string | undefined;
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length === 0 || query.search.length > 256 || !query.search.isWellFormed()) {
      fail("KNOWLEDGE_INPUT_INVALID", "search term");
    }
    search = query.search.toLowerCase();
  }
  // Annotated because the default comes from a literal-typed limits constant; the
  // variable really holds whichever caller-supplied page size is within bounds.
  let limit: number = KNOWLEDGE_LIMITS.maximumQueryResults;
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > PROTOCOL_LIMITS.maxCanonicalBytes) {
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
  return { selection, search, limit, offset };
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
  const tokens = [...search.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,31}|[一-鿿]+/gu)].map((match) => match[0]);
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
function trailingDisclosure(scan: KnowledgeStoreScan): Readonly<Record<string, JsonValue>> {
  if (scan.marker.eventHighWaterDigest === scan.workspace.headEventHash) return {};
  return {
    knowledgeStoreTrailing: true,
    storeHighWaterDigest: scan.marker.eventHighWaterDigest,
    chainHeadEventHash: scan.workspace.headEventHash,
  };
}

// TCRN-CROSS-STORY-476 R5: a read of the user crest carries `scope: "user"` where a library's
// read carries its trailing disclosure; the user crest has no chain head to trail.
const USER_CREST_DISCLOSURE: Readonly<Record<string, JsonValue>> = Object.freeze({ scope: "user" });

/**
 * The card metadata a query selects. `query.scope` "user" reads this user's crest (TCRN-CROSS-STORY-476
 * R5), whichever library `workspaceRoot` names, and lists nothing before the crest's first card;
 * left out, the library's crest, exactly as before. TCRN-CROSS-SUB-310: a user crest holding
 * unresolved conflicts answers them as `unresolvedConflicts` (pairs of card ids), and its default
 * selection leaves their cards out; selection "all" lists them. TCRN-CROSS-SUB-413: likewise an id
 * more than one writer wrote, answered as `unresolvedDuplicates` (duplicateDiagnostic) while it is
 * unresolved: default selection leaves out every version, and selection "all" lists each one.
 */
export async function listKnowledgeMetadata(workspaceRoot: string, query: KnowledgeListQuery): Promise<Readonly<Record<string, JsonValue>>> {
  const normalized = normalizeListQuery(query);
  assertStoreScope(query.scope);
  if (query.scope === "user") {
    return readUserCrest(query, async (scan) => {
      if (scan === null) return knowledgeListAnswer([], query, normalized, USER_CREST_DISCLOSURE);
      const duplicates = unresolvedDuplicates(scan);
      const withheld = new Set([...unresolvedConflictIds(scan), ...duplicates.map((duplicate) => duplicate.id)]);
      const matched = selectKnowledgeMetadata({ units: userCrestRecords(scan) }, query, normalized, true)
        .filter((metadata) => normalized.selection !== "default" || !withheld.has(metadata.id));
      return knowledgeListAnswer(matched, query, normalized, {
        ...USER_CREST_DISCLOSURE,
        ...(scan.unresolvedConflicts.length === 0 ? {} : { unresolvedConflicts: scan.unresolvedConflicts as unknown as JsonValue }),
        ...(duplicates.length === 0 ? {} : { unresolvedDuplicates: duplicates.map(duplicateDiagnostic) }),
      });
    });
  }
  const scan = await scanKnowledgeStore(workspaceRoot, query, false, "metadata-only");
  return knowledgeListAnswer(selectKnowledgeMetadata(scan, query, normalized, true), query, normalized, trailingDisclosure(scan));
}

function knowledgeListAnswer(
  matched: readonly KnowledgeUnitMetadata[],
  query: KnowledgeListQuery,
  normalized: NormalizedListQuery,
  disclosure: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  // WSC-4: truncate with a continuation window instead of failing when more than
  // one page matches — the metadata-first surface stays usable past a single page.
  const records = matched.slice(normalized.offset, normalized.offset + normalized.limit);
  return {
    schemaVersion: "tcrn.knowledge-list.v1",
    reasonCode: "KNOWLEDGE_LIST_READY",
    ...disclosure,
    selection: normalized.selection,
    at: query.at,
    total: matched.length,
    offset: normalized.offset,
    truncated: normalized.offset + records.length < matched.length,
    records: records as unknown as readonly JsonValue[],
    resultDigest: canonicalSha256(records),
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
function duplicateReadDisclosure(duplicate: UserCrestDuplicate): Readonly<Record<string, JsonValue>> {
  return unresolvedDuplicates({ duplicates: [duplicate] }).length === 0
    ? USER_CREST_DISCLOSURE
    : { ...USER_CREST_DISCLOSURE, unresolvedDuplicates: [duplicateDiagnostic(duplicate)] };
}

/**
 * One card's snippet; `options.scope` "user" reads it from this user's crest (TCRN-CROSS-STORY-476 R5).
 * TCRN-CROSS-SUB-413: the id of a user-crest duplicate answers every version's snippet under
 * `versions`, each named by its writer, in place of one card's fields.
 */
export async function readKnowledgeSnippet(workspaceRoot: string, id: string, options: KnowledgeScopedReadOptions = {}): Promise<Readonly<Record<string, JsonValue>>> {
  assertKnowledgeReadId(id);
  assertStoreScope(options.scope);
  if (options.scope === "user") {
    return readUserCrest(options, async (scan) => {
      const duplicate = scan?.duplicates.find((entry) => entry.id === id);
      if (duplicate === undefined) return knowledgeSnippetAnswer(id, scan === null ? [] : scan.units, USER_CREST_DISCLOSURE);
      return {
        schemaVersion: "tcrn.knowledge-snippet.v1",
        ...duplicateReadDisclosure(duplicate),
        id,
        versions: duplicate.versions.map((version) => ({
          ...duplicateVersionIdentity(version),
          subject: version.metadata.subject,
          summary: version.metadata.summary,
          snippet: version.metadata.snippet,
          revision: version.metadata.revision,
        })),
      };
    });
  }
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  return knowledgeSnippetAnswer(id, scan.units, trailingDisclosure(scan));
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
 * TCRN-CROSS-SUB-413: the id of a user-crest duplicate answers every version's body under
 * `versions`, each named by its writer, once every version passes the check one card's body does.
 */
export async function readKnowledgeBody(workspaceRoot: string, id: string, options: KnowledgeBodyReadOptions): Promise<Readonly<Record<string, JsonValue>>> {
  assertKnowledgeReadId(id);
  assertEvaluationInstant(options.at);
  assertStoreScope(options.scope);
  if (options.scope === "user") {
    return readUserCrest(options, async (scan) => {
      if (scan === null) fail("KNOWLEDGE_NOT_FOUND", id);
      const backend = userCrestBackend(scan.storeRoot, scan.device, options);
      const duplicate = scan.duplicates.find((entry) => entry.id === id);
      if (duplicate === undefined) return knowledgeBodyAnswer(id, scan.units, options, backend, null, USER_CREST_DISCLOSURE);
      const freshness = duplicate.versions.map((version) => readableBodyFreshness(version.metadata, options));
      const versions: Readonly<Record<string, JsonValue>>[] = [];
      for (const [index, version] of duplicate.versions.entries()) {
        const body = version.readBody === undefined ? await backend.readKnowledgeBody(id) : await version.readBody();
        validateMetadataBody(version.metadata, body, null);
        versions.push({
          ...duplicateVersionIdentity(version),
          revision: version.metadata.revision,
          freshness: freshness[index] as KnowledgeFreshnessState,
          bodySha256: version.metadata.bodySha256,
          body: body.toString("utf8"),
        });
      }
      return { schemaVersion: "tcrn.knowledge-body-read.v1", ...duplicateReadDisclosure(duplicate), id, versions, explicit: true };
    });
  }
  const scan = await scanKnowledgeStore(workspaceRoot, options, false, "metadata-only");
  return knowledgeBodyAnswer(id, scan.units, options, storeBackendFor(scan.storeRoot, options), scan.workspace, trailingDisclosure(scan));
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
  const records = scan.units.map((unit) => ({
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
  for (const unit of scan.units) {
    const references = unit.metadata.sourceReferences.filter(sourceReferenceIsFile);
    if (references.length === 0) {
      reports.push({ id: unit.metadata.id, status: "uncheckable", sourceReferences: unit.metadata.sourceReferences as unknown as JsonValue, expectedDigest: unit.metadata.sourceDigest, action: "none" });
      continue;
    }
    try {
      const parts = await sourceDigestParts(scan.workspaceRoot, scan.workspace, references);
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
  const initial = await mutationAdmissionScan(workspaceRoot, options);
  const claim = await acquireMutationClaim(initial);
  let released = false;
  try {
    const scan = await scanKnowledgeStore(workspaceRoot, options, true);
    const unit = scan.units.find((entry) => entry.metadata.id === input.id);
    if (!unit) fail("KNOWLEDGE_NOT_FOUND", input.id);
    if (unit.metadata.revision !== input.expectedRevision) {
      fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedRevision}:${unit.metadata.revision}`);
    }
    if ((unit.metadata.promotionState !== undefined && unit.metadata.promotionState !== "promoted") || unit.metadata.lifecycle === "retired") {
      fail("KNOWLEDGE_LIFECYCLE_INVALID", "only an eligible, non-retired record can be re-verified");
    }
    const metadata: KnowledgeUnitMetadata = { ...unit.metadata, lastVerified: input.occurredAt, freshnessState: "fresh", revision: unit.metadata.revision + 1, updatedAt: input.occurredAt };
    const unitBody = requireBody(unit);
    const validated = validateExistingMetadataShape(metadata, scan.workspace);
    validateMetadataBody(validated, unitBody, scan.workspace);
    const marker: KnowledgeStoreMarker = { ...scan.marker, version: scan.marker.version + 1 };
    const projectedMetadata = scan.units.map((entry) => entry.metadata.id === metadata.id ? metadata : entry.metadata);
    const backend = storeBackendFor(scan.storeRoot, options);
    await backend.writeKnowledgeMetadata(unit.metadata.id, canonicalJson(metadata));
    crash("after-metadata-write", options.faultAt);
    await backend.writeKnowledgeMarker(canonicalJson(marker));
    crash("after-marker-write", options.faultAt);
    await writeIndex(backend, marker, projectedMetadata);
    await releaseMutationClaim(scan.storeRoot, claim);
    released = true;
    await scanKnowledgeStore(workspaceRoot, options);
    return {
      schemaVersion: "tcrn.knowledge-reverify-result.v1",
      reasonCode: "KNOWLEDGE_REVERIFIED",
      id: metadata.id,
      lastVerified: metadata.lastVerified,
      revision: metadata.revision,
      version: marker.version,
    };
  } catch (error) {
    // WSC-6: same crash exemption as createKnowledgeUnit -- a simulated crash must leave
    // the claim exactly where a real SIGKILL would, since finally never runs for one.
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_FAULT_INJECTED") released = true;
    throw error;
  } finally {
    if (!released) await releaseMutationClaim(initial.storeRoot, claim);
  }
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
  const initial = await mutationAdmissionScan(workspaceRoot, options);
  const claim = await acquireMutationClaim(initial);
  let released = false;
  try {
    const scan = await scanKnowledgeStore(workspaceRoot, options, true);
    const unit = scan.units.find((entry) => entry.metadata.id === input.id);
    if (unit === undefined) fail("KNOWLEDGE_NOT_FOUND", input.id);
    if (unit.metadata.revision !== input.expectedRevision) fail("KNOWLEDGE_CAS_MISMATCH", `${input.expectedRevision}:${unit.metadata.revision}`);
    if (unit.metadata.kind !== "reference" || unit.metadata.retrievalDisposition !== "explicit-only" || unit.metadata.lifecycle === "retired") {
      fail("KNOWLEDGE_LIFECYCLE_INVALID", "only an active article index can be refreshed");
    }
    if (!unit.metadata.sourceReferences.includes(input.path)) fail("KNOWLEDGE_PATH_INVALID", "article identity does not match source path");
    const workspaceArticle = await articlePathFor(scan.workspaceRoot, scan.workspace, input.path);
    const articleBytes = await readArticleBytes(workspaceArticle.file);
    const article = parseArticleMarkdown(articleBytes, input.path);
    const sourceDigest = sha256(articleBytes);
    let language;
    try {
      language = applyWriteLanguagePolicy(
        { subject: article.title, summary: input.summary, snippet: truncateArticleUtf8(input.summary, KNOWLEDGE_LIMITS.maximumSnippetBytes) },
        readKnowledgeLanguagePolicy(scan.workspace.settings, options.host),
        options.languageProvider,
      );
    } catch (error) {
      if (error instanceof KnowledgeLanguageError) fail(error.reasonCode, error.message, error.details as Readonly<Record<string, JsonValue>>);
      throw error;
    }
    const body = articleIndexBody(article.title, input.summary, input.path);
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
      bodyBytes: Buffer.byteLength(body, "utf8"),
      revision: unit.metadata.revision + 1,
      updatedAt: input.occurredAt,
      expansions: language.expansions,
    };
    const validated = validateExistingMetadataShape(metadata, scan.workspace);
    validateMetadataBody(validated, Buffer.from(body, "utf8"), scan.workspace);
    const secondRead = await readArticleBytes(workspaceArticle.file);
    if (!secondRead.equals(articleBytes)) fail("KNOWLEDGE_SOURCE_CHANGED", workspaceArticle.file);
    const marker: KnowledgeStoreMarker = { ...scan.marker, version: scan.marker.version + 1 };
    const projectedMetadata = scan.units.map((entry) => entry.metadata.id === metadata.id ? metadata : entry.metadata);
    // TCRN-CROSS-SUB-309: the refreshed index body replaces the old one in the body budget.
    assertWithinCapacity(capacityBodyBytes(projectedMetadata), knowledgeAggregateLimit(scan.workspace), "article refresh aggregate bytes");
    const backend = storeBackendFor(scan.storeRoot, options);
    await backend.writeKnowledgeBody(metadata.id, Buffer.from(body, "utf8"));
    crash("after-body-write", options.faultAt);
    await backend.writeKnowledgeMetadata(metadata.id, canonicalJson(metadata));
    crash("after-metadata-write", options.faultAt);
    await backend.writeKnowledgeMarker(canonicalJson(marker));
    crash("after-marker-write", options.faultAt);
    await writeIndex(backend, marker, projectedMetadata);
    await releaseMutationClaim(scan.storeRoot, claim);
    released = true;
    await scanKnowledgeStore(workspaceRoot, options);
    return {
      schemaVersion: "tcrn.knowledge-article-refresh-result.v1",
      reasonCode: "KNOWLEDGE_ARTICLE_REFRESHED",
      id: metadata.id,
      revision: metadata.revision,
      version: marker.version,
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
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_FAULT_INJECTED") released = true;
    throw error;
  } finally {
    if (!released) await releaseMutationClaim(initial.storeRoot, claim);
  }
}

// INC-256: change the freshness policy without changing the card's content or
// verification instant. This is a metadata migration operation, so it advances
// the disposable store version and revision exactly like the other mutations.
// A null maximum age also clears a stale state that was produced by the old
// calendar policy; a later explicit source check or re-verification can mark the
// record stale again when a current source actually warrants it.
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
  if ((maximumAgeDays !== null && (!Number.isSafeInteger(maximumAgeDays) || maximumAgeDays < 1 || maximumAgeDays > 3_650)) ||
    (unknownDisposition !== "fail-closed" && unknownDisposition !== "fail-open")) {
    fail("KNOWLEDGE_INPUT_INVALID", "staleness policy");
  }
  const initial = await mutationAdmissionScan(workspaceRoot, options);
  const claim = await acquireMutationClaim(initial);
  let released = false;
  try {
    const scan = await scanKnowledgeStore(workspaceRoot, options, true);
    const unit = scan.units.find((entry) => entry.metadata.id === input.id);
    if (!unit) fail("KNOWLEDGE_NOT_FOUND", input.id);
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
    if (unit.metadata.lifecycle !== "retired") validateMetadataBody(validated, requireBody(unit), scan.workspace);
    const marker: KnowledgeStoreMarker = { ...scan.marker, version: scan.marker.version + 1 };
    const projectedMetadata = scan.units.map((entry) => entry.metadata.id === metadata.id ? metadata : entry.metadata);
    const backend = storeBackendFor(scan.storeRoot, options);
    await backend.writeKnowledgeMetadata(unit.metadata.id, canonicalJson(metadata));
    crash("after-metadata-write", options.faultAt);
    await backend.writeKnowledgeMarker(canonicalJson(marker));
    crash("after-marker-write", options.faultAt);
    await writeIndex(backend, marker, projectedMetadata);
    await releaseMutationClaim(scan.storeRoot, claim);
    released = true;
    await scanKnowledgeStore(workspaceRoot, options);
    return {
      schemaVersion: "tcrn.knowledge-policy-result.v1",
      reasonCode: "KNOWLEDGE_POLICY_UPDATED",
      id: metadata.id,
      maximumAgeDays: metadata.stalenessPolicy.maximumAgeDays,
      unknownDisposition: metadata.stalenessPolicy.unknownDisposition,
      revision: metadata.revision,
      version: marker.version,
    };
  } catch (error) {
    if (error instanceof KnowledgeCoreError && error.reasonCode === "KNOWLEDGE_FAULT_INJECTED") released = true;
    throw error;
  } finally {
    if (!released) await releaseMutationClaim(initial.storeRoot, claim);
  }
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
  const scan = await scanKnowledgeStore(workspaceRoot, { ...options, allowTrailing: false }, false, "metadata-only");
  const records = scan.units.map((unit) => unit.metadata).filter((metadata) => isDefaultSelectable(metadata, at));
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
