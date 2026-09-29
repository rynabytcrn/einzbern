// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  PROTOCOL_LIMITS,
  ProtocolError,
  WORK_SUMMARY_MAX_BYTES,
  assertCanonicalJson,
  assertProtocolId,
  assertStrictInstant,
  assertWorkTransition,
  canonicalExternalKey,
  canonicalByteLength,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  createEvent,
  deriveLegacyEventId,
  deriveStableId,
  EVENT_SCHEMA_VERSION,
  isWorkSummary,
  validateWorkGraph,
} from "../../protocol/src/index.js";
import type {
  EventRecord,
  ExtensionRegistration,
  JsonValue,
  WorkKind,
  WorkRecord,
  WorkStatus,
} from "../../protocol/src/index.js";
import { assertDistinctRootShape, rootPortableIdentity } from "./root-identity.js";
import { FileLockError } from "./file-lock.js";
import { AKASHA_SEGMENT_BYTES_DEFAULT, appendStreamEvents, emptyStreamManifest, readAllStreams, streamEventId, withLibraryWriteLock } from "./akasha.js";
import type { LibraryRead, LibraryReadOptions, MergedEvent, StreamManifest } from "./akasha.js";
import {
  CACHE_VIEWS_SCHEMA_VERSION,
  clearLibraryCache,
  discardCacheSnapshot,
  readCacheSnapshot,
  readCacheViewStamp,
  sameViewStamp,
  writeCacheSnapshot,
  writeCacheViews,
} from "./library-cache.js";
import type { CacheSnapshot, CacheViewStamp } from "./library-cache.js";
import { writeConfigProjection } from "./library-config.js";
import { LIBRARY_ID_PATTERN, createLibrary, hasLibraryManifest, openLibrary, realLibraryPath } from "./ether-library.js";
import type { Library } from "./ether-library.js";
import { readOrCreateDevice } from "./device-identity.js";
import { legacyControlDirectory, openLegacyWorkspace, replayLegacyWorkspace } from "./legacy-workspace.js";
import { LEGACY_CONTROL_DIRECTORY } from "./names.js";
// TCRN-CROSS-STORY-489 R4: used only inside functions; registry.ts imports nothing from this module.
import { findMigratedEntry } from "./registry.js";
import { recordClosureValidation, recordCollectionScan, recordExtensionClosureValidation, recordFullMaterialize, recordSnapshotMaterialize, recordTerminalGraphValidation } from "./workspace-perf-instrumentation.js";
import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ActorAttestationError,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  assertActorId,
  buildEventPayload,
  validateActorAttestationEnableRecord,
} from "./actor-attestation.js";
import {
  ConferenceError,
  openConference,
  validateConferenceMinutes,
  validateConferencePosition,
  validateConferenceRequest,
} from "./conference.js";
import { AssignmentGateError, validateGateRecord } from "./assignment-gate.js";
import { MINUTES_RECORDED_OPERATION, MINUTES_RECORD_VERSION, MinutesError, nextMinutesExternalKey, validateMinutesRecord } from "./minutes.js";
import type { MinutesRecord } from "./minutes.js";
import type { ConferenceMinutes, ConferencePosition, ConferenceRequest } from "./conference.js";
import {
  EMPTY_EXECUTION_CONFIG,
  applyHostConfigDefault,
  applyHostConfigRemove,
  applyHostConfigSet,
  applyLegacyCustomPersonaSet,
  applyCustomPersonaRemove,
  applyCustomPersonaSet,
  applyModelPlanAssignInExecutionConfig,
  applyModelPlanRemoveInExecutionConfig,
  applyModelPlanSetInExecutionConfig,
  applyModelPlanUnassignInExecutionConfig,
  applyPersonaPresetOverrideInExecutionConfig,
  applyPersonaPresetRemoveInExecutionConfig,
  applyPersonaPresetRestoreInExecutionConfig,
  applyPersonaBindingRemove,
  applyPersonaBindingSet,
  assertExecutionHost,
  validateConfigurationName,
  validateModel,
  validateNote,
} from "./execution-config.js";
import type { ExecutionConfigState, ExecutionHost } from "./execution-config.js";
import type { GateRecord } from "./assignment-gate.js";
import { GateIdentityError, validateGateIdentityDecision } from "./gate-identity.js";
import type { GateIdentityDecision } from "./gate-identity.js";
import type { CanonicalRoot } from "./root-identity.js";
import { FRAMEWORK_VERSION } from "./index.js";
import { summarizeGoal } from "./story-scope-compliance.js";
import { deriveStoryFieldsFromScope, missingStoryField, storyFields, storyOwnerDeciderNamed } from "./story-fields.js";
import type { StoryRequiredField } from "./story-fields.js";
import {
  TemplateAdmissionError,
  admitTemplate,
  createTemplateAdmissionRecord,
  templateBindingFromReceipt,
  templateRecordMatchesBinding,
  templateRecordForBinding,
  templateRegistry,
  validateBoundTemplateWork,
  validateTemplateAdmissionRecord,
  validateTemplateAdmissionReceipt,
} from "./template-admission.js";
import type { TemplateAdmissionRecord } from "./template-admission.js";
import {
  SETTINGS_CATALOG,
  SETTINGS_LAYER_KIND,
  SettingsError,
  assertProjectSettingKey,
  assertSettingWriteConsistent,
  compareEngineVersions,
  createWorkspaceSettingRecord,
  currentSettingRecord,
  isRetiredSettingKey,
  readRecordedSettingRecord,
  renamedSettingKey,
  renamedSettingRecord,
  sortWorkspaceSettings,
} from "./settings.js";
import type { WorkspaceSettingRecord } from "./settings.js";
import {
  telemetryEvidenceSnapshot,
  TelemetryError,
  validateTelemetryRecord,
} from "./telemetry.js";
import type { TelemetryEvidenceSnapshot } from "./telemetry.js";
// TCRN-CROSS-STORY-472: used only inside functions. work-relations.ts imports WorkspaceError from
// this module, so nothing here may read one of its bindings while the module is being evaluated.
import { mergeStoredRelations, relationsShapeProblem, storedRelationsOf, validateRelationsInput } from "./work-relations.js";
import type { NormalizedWorkRelations, WorkRelationsInput } from "./work-relations.js";
import { ConfigRecordError, configRecordId, configRecordIdentity, isConfigRecordCollection, isConfigRecordOperation, readConfigRecordEvent, sortConfigRecords } from "./config-records.js";
import type { ConfigRecord } from "./config-records.js";

export const WORKSPACE_SCHEMA_VERSION = "tcrn.workspace.v1" as const;
export const WORKSPACE_STORAGE_VERSION = 2 as const;
export const WORKSPACE_LEGACY_STORAGE_VERSION = 1 as const;
export const WORKSPACE_SEGMENT_BYTES_DEFAULT = 16_777_216 as const;
export const WORKSPACE_SEGMENT_BYTES_MIN = 4_096 as const;
export const WORKSPACE_SEGMENT_BYTES_MAX = 67_108_864 as const;
export const WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES = 4_194_304 as const;
// The old-layout control directory, named by the names module (read-only from EPIC-141 on).
export const WORKSPACE_CONTROL_DIRECTORY = LEGACY_CONTROL_DIRECTORY;
export const WORKSPACE_REASON_CODES = Object.freeze([
  // TCRN-CROSS-STORY-469: a path that names neither a library nor an old-layout workspace, and a
  // write aimed at an old-layout workspace, which opens read-only.
  // TCRN-CROSS-STORY-489 R4: a write aimed at an old-layout workspace this device migrated names
  // the library it moved to (details.movedTo).
  "LEGACY_WORKSPACE_MIGRATED",
  "LEGACY_WORKSPACE_READ_ONLY",
  "LIBRARY_NOT_FOUND",
  // TCRN-CROSS-STORY-470 R3: a write aimed at a library that was relocated; it names the new place.
  "LIBRARY_TOMBSTONED",
  "WORKSPACE_ACTOR_INVALID",
  "WORKSPACE_ACTOR_REQUIRED",
  "WORKSPACE_ALREADY_EXISTS",
  "EXECUTION_PERSONA_IN_USE",
  "EXECUTION_PERSONA_UNKNOWN",
  "MODEL_PLAN_ASSIGNMENT_INVALID",
  "MODEL_PLAN_DEFAULT_MODEL_INVALID",
  "MODEL_PLAN_HOST_UNKNOWN",
  "MODEL_PLAN_IN_USE",
  "MODEL_PLAN_NAME_INVALID",
  "MODEL_PLAN_NOT_FOUND",
  "MODEL_PLAN_PERSONA_UNKNOWN",
  "MODEL_PLAN_RECORD_INVALID",
  "PERSONA_CONTENT_INVALID",
  "PERSONA_DESCRIPTION_INVALID",
  "PERSONA_FIELD_INVALID",
  "PERSONA_NAME_INVALID",
  "PERSONA_NAME_CONFLICT",
  "PERSONA_NOT_FOUND",
  "PERSONA_PRESET_IN_USE",
  "PERSONA_PRESET_NOT_FOUND",
  "PERSONA_PRESET_TOMBSTONED",
  "PERSONA_PROMPT_INVALID",
  "PERSONA_RECORD_INVALID",
  "PERSONA_ROLE_INVALID",
  "WORKSPACE_EVENT_CORRUPT",
  "WORKSPACE_FAULT_INJECTED",
  "WORKSPACE_FILESYSTEM_UNSUPPORTED",
  "WORKSPACE_ENGINE_VERSION_MISMATCH",
  "WORKSPACE_GATE_EVIDENCE_UNRESOLVED",
  "WORKSPACE_GATE_IDENTITY_REFUSED",
  "WORKSPACE_GATE_IDENTITY_REQUIRED",
  "WORKSPACE_GATE_PENDING",
  "WORKSPACE_INPUT_INVALID",
  "WORKSPACE_INPUT_OVERSIZED",
  "WORKSPACE_LOCKED",
  "WORKSPACE_MIGRATION_APPLY_UNAVAILABLE",
  "WORKSPACE_MIGRATION_DOWNGRADE",
  "WORKSPACE_MIGRATION_FUTURE",
  "WORKSPACE_STORAGE_MIGRATION_IN_PROGRESS",
  "WORKSPACE_STORAGE_MIGRATION_LIMIT_INVALID",
  "WORKSPACE_STORAGE_MIGRATION_MISMATCH",
  "WORKSPACE_STORAGE_MIGRATION_NOT_APPLIED",
  "WORKSPACE_STORAGE_MIGRATION_VERIFIED",
  "WORKSPACE_PATH_ESCAPE",
  "WORKSPACE_PATH_INVALID",
  "WORKSPACE_RECORD_LIMIT",
  // WSR-1 (relocation): the four STATE codes live here, not in
  // workspace-relocation.ts, because validateMetadata/readMetadata raise them and
  // fail() is typed to WorkspaceReasonCode. Every other relocation code is owned by
  // the relocation module's own frozen list.
  "WORKSPACE_RELOCATION_ADOPTION_REQUIRED",
  "WORKSPACE_RELOCATION_FOREIGN_ADDRESS",
  "WORKSPACE_RELOCATION_LEDGER_INVALID",
  "WORKSPACE_RELOCATION_VACATED",
  "WORKSPACE_SCHEMA_INVALID",
  "WORKSPACE_SNAPSHOT_INVALID",
  // INC-074: a workspace whose chain has been migrated to Postgres carries a
  // storage-home sentinel (`storage-home.json` in the control directory). The file backend
  // refuses every mutating verb on such a workspace — the write door is closed, so
  // a caller driving the engine without TCRN_PG_* (the ceremony.mjs fork mechanism)
  // can no longer fork the chain. Read-only verbs stay open so the tree remains a
  // forensible archive. Named here because the write-lock gate raises it and
  // fail() is typed to WorkspaceReasonCode.
  "WORKSPACE_STORAGE_RELOCATED",
  // TCRN-CROSS-STORY-473 R2 (MIN-227 D8): a Story needs a goal and an acceptance, as fields or
  // mapped from an old scope; details.field names the missing one. It replaces the two Story
  // scope codes (scope required, scope invalid) that retired with the ten-block contract.
  "WORK_STORY_FIELD_REQUIRED",
  "WORKSPACE_OWNER_ACCEPTANCE_REQUIRED",
  "WORKSPACE_VIEW_STALE",
  // STORY-299. Two codes, two different moments, deliberately not one code.
  // BUDGET_EXCEEDED is raised while nothing has been written: the projection was
  // measured before the segment was committed and does not fit, so the command
  // fails with the chain untouched and must not be retried unchanged.
  // UNWRITTEN is the opposite case and never appears as a command's reason code:
  // the fact is committed and durable, only the derived view could not be
  // persisted. It rides on a successful receipt so the caller learns the truth
  // without being told its write failed -- the defect INC-198 recorded.
  "WORKSPACE_VIEW_BUDGET_EXCEEDED",
  "WORKSPACE_VIEW_UNWRITTEN",
  // STORY-300 slice 3: a batch is refused for its shape before any state is consulted,
  // or by the first member that fails against accumulated state. The two are separate
  // codes because they answer different questions about whose fault it is.
  "WORK_BATCH_MALFORMED",
  "WORK_BATCH_REFUSED",
  // TCRN-CROSS-STORY-472 R1 (MIN-227 D6): a new record is an Initiative, Epic, Story or Subtask.
  // An Incident, a Release (and the never-creatable Review and Knowledge) already on a chain still
  // reads, transitions and can be the target of a relation; a new one is refused with a remedy.
  "WORK_KIND_RETIRED",
] as const);

export type WorkspaceReasonCode = typeof WORKSPACE_REASON_CODES[number];
// A library append has two windows (TCRN-CROSS-STORY-469): before the stream is written, and
// after its manifest commits. The old writer's temporary-file and view windows went with it.
export type WorkspaceCrashPoint =
  | "before-write"
  | "after-event-commit";

export class WorkspaceError extends Error {
  readonly reasonCode: WorkspaceReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: WorkspaceReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "WorkspaceError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

// WSR-1: the relocation ledger. An APPEND-ONLY record of address rebindings that
// travels inside the control tree it describes. It is a TENTH, OPTIONAL metadata
// field: absent on every workspace that never relocates, so those files stay
// byte-identical to 0.8.0 (see the T25 byte-neutrality proof). Absent, not empty —
// emitting `relocations: []` unconditionally would change every existing
// workspace.json digest and turn an additive change into a migration.
export const WORKSPACE_RELOCATION_ENTRY_VERSION = "tcrn.workspace-relocation.v1" as const;
export const WORKSPACE_RELOCATION_IDENTITY_VERSION = "tcrn.workspace-relocation-identity.v1" as const;
// OD-B (Owner ruling): sixteen. A workspace that has moved house sixteen times has
// an operational problem a cap does not fix, and each entry carries ten root paths
// in a file that is re-read on EVERY workspace operation. Picked deliberately so it
// does not become an accidental constant.
export const WORKSPACE_RELOCATION_LEDGER_LIMIT = 16 as const;

export type WorkspaceRelocationStage = "vacated" | "adopted" | "aborted";

export interface WorkspaceRelocationBasis {
  readonly controlManifestSha256: string;
  readonly headEventHash: string | null;
  readonly version: number;
}

export interface WorkspaceRelocationAuthorityRecord {
  readonly actorId: string;
  readonly authorityFileSha256: string;
}

export interface WorkspaceRelocationEntry {
  readonly schemaVersion: typeof WORKSPACE_RELOCATION_ENTRY_VERSION;
  readonly sequence: number;
  readonly relocationId: string;
  readonly stage: WorkspaceRelocationStage;
  readonly at: string;
  readonly from: readonly CanonicalRoot[];
  readonly to: readonly CanonicalRoot[];
  readonly basis: WorkspaceRelocationBasis;
  readonly authority: WorkspaceRelocationAuthorityRecord;
}

// The three-state discriminator plus the ordinary case. Computed from ONE file and
// the address the reader is standing at — no network, no registry, no side channel.
export type WorkspaceRelocationState =
  | "live"
  | "vacated"
  | "adoption-required"
  | "foreign-address";

// Admission modes for readMetadata. The DEFAULT MUST be the strict value: a
// permissive default breaks nothing visible and silently disables the whole
// mechanism, which is why guard G1 exists and why T4 asserts the default refuses.
export type WorkspaceAdmission = "live" | "adoption" | "abort" | "any";

export interface WorkspaceMetadata {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  readonly storageVersion: 1 | 2;
  readonly minimumStorageVersion: 1;
  readonly maximumStorageVersion: 1 | 2;
  readonly workspaceId: string;
  readonly externalKey: string;
  readonly createdAt: string;
  readonly segmentEventLimit: number;
  readonly roots: readonly CanonicalRoot[];
  readonly relocations?: readonly WorkspaceRelocationEntry[];
}

export interface ProjectRecord {
  readonly schemaVersion: "tcrn.project.v1";
  readonly id: string;
  readonly externalKey: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: boolean;
}

// TCRN-CROSS-STORY-468 R4, R5: what a merged read of a library reports beside the state. An
// event that was valid on the device that wrote it but does not apply to the merged state is
// rejected: recorded here, skipped, and never silently dropped. A create whose key another
// device took first keeps its record under the next free key, and the alias says so.
export interface RejectedEvent {
  readonly eventId: string;
  readonly streamId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly clock: number;
  readonly operation: string | null;
  readonly recordId: string | null;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface KeyAlias {
  readonly kind: "project" | "work";
  // The key and id the later writer asked for; the earlier writer's record holds them.
  readonly externalKey: string;
  readonly id: string;
  // The next free key, and its id, under which the later writer's record now lives.
  readonly aliasExternalKey: string;
  readonly aliasId: string;
  readonly deviceId: string;
  readonly streamId: string;
  readonly sequence: number;
}

export interface LibraryStreamHead {
  readonly deviceId: string;
  readonly streamId: string;
  readonly displayName: string;
  readonly identityScheme: "einzbern" | "legacy";
  readonly sequence: number;
  readonly headEventHash: string | null;
  readonly clockHighWater: number;
  readonly engineVersion: string;
  readonly formatVersion: number;
}

export interface LibraryReplay {
  readonly libraryRoot: string;
  readonly versionVector: Readonly<Record<string, number>>;
  readonly streams: readonly LibraryStreamHead[];
  readonly rejectedEvents: readonly RejectedEvent[];
  readonly aliases: readonly KeyAlias[];
}

export interface WorkspaceState {
  readonly metadata: WorkspaceMetadata;
  readonly version: number;
  readonly headEventHash: string | null;
  // Present when the state was merged from the streams of a library.
  readonly library?: LibraryReplay;
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  // WSD-1: additive extension-record collections materialized from the same
  // event chain, each sorted by projectId then id in utf8-byte-order-v1. Empty
  // for every workspace that contains no conference/gate events.
  readonly conferences: readonly ConferenceRequest[];
  readonly conferencePositions: readonly ConferencePosition[];
  readonly conferenceMinutes: readonly ConferenceMinutes[];
  // TCRN-CROSS-STORY-475 R1: minutes recorded in one event (minutes.ts), sorted like the other
  // extension collections. A conference's historical minutes stay in conferenceMinutes; minutesView
  // reads both.
  readonly minutes: readonly MinutesRecord[];
  readonly gates: readonly GateRecord[];
  readonly settings: readonly WorkspaceSettingRecord[];
  readonly executionConfig: ExecutionConfigState;
  readonly templates: readonly TemplateAdmissionRecord[];
  // TCRN-CROSS-STORY-478 R1 (SUB-315): the project-level configuration records a library's
  // config.record.* events leave (config-records.ts), sorted by collection then key. An
  // old-layout workspace has none.
  readonly configRecords: readonly ConfigRecord[];
  readonly events: readonly EventRecord[];
  // WSE-2: the sequence of the attestation.actor.enabled event once one has been
  // replayed, else null. From this sequence onward (the enabling event itself
  // included), every mutation payload MUST carry a valid actor; before it, and
  // for every workspace that never enables attestation, actor stays absent and
  // the derived state and export bytes are byte-identical to rc.4.
  readonly attestationEnabledAtSequence: number | null;
}

// TCRN-CROSS-STORY-469 R4: a replay seed from this device's cache (library-cache.ts). It holds the
// reducer's collections after the first `version` merged events, which the reader hands back as
// `prefixEvents`; the replay continues with the events after them. It is never the backup
// snapshot manifest (workspace-snapshot.ts) and never replaces a single event.
interface ReplaySeed {
  readonly version: number;
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  readonly conferences: readonly ConferenceRequest[];
  readonly conferencePositions: readonly ConferencePosition[];
  readonly conferenceMinutes: readonly ConferenceMinutes[];
  readonly minutes: readonly MinutesRecord[];
  readonly gates: readonly GateRecord[];
  readonly settings: readonly WorkspaceSettingRecord[];
  readonly executionConfig: ExecutionConfigState;
  readonly templates: readonly TemplateAdmissionRecord[];
  readonly configRecords: readonly ConfigRecord[];
  readonly attestationEnabledAtSequence: number | null;
  readonly prefixEvents: readonly EventRecord[];
}

export interface WorkspaceMutationOptions {
  readonly occurredAt: string;
  // WSE-2: the accountable actor for this mutation. Caller-supplied like
  // occurredAt (no clock, no randomness — determinism preserved). Once
  // attestation is enabled it is mandatory (WORKSPACE_ACTOR_REQUIRED) and
  // validated (WORKSPACE_ACTOR_INVALID); the enabling event carries it too.
  readonly actorId?: string;
  readonly crashAt?: WorkspaceCrashPoint;
  // Runs inside the write lock, before the state is read: a test seam that holds the lock
  // open so a concurrent writer can be observed waiting for it.
  readonly insideWriteLockForTest?: () => Promise<void>;
  // STORY-299: a test-facing knob for the pre-commit view budget, the same shape
  // and the same purpose as crashAt above. It only ever narrows -- a caller cannot
  // raise the protocol ceiling with it -- so the refusal it exercises is the same
  // refusal a real chain gets, reachable without first building a chain large
  // enough to fill a megabyte.
  readonly viewBudgetBytes?: number;
}

const projectFields = ["schemaVersion", "id", "externalKey", "name", "revision", "updatedAt", "tombstone"];
const rootFields = ["kind", "path", "canonicalPath", "portableIdentity"];
const projectOperations = new Set(["project.created", "project.updated", "project.deleted"]);
// work.annotated (E05): an additive operation that attaches non-binding advisory
// extensions to a live work record without changing its status. It follows the WSD-1
// contract -- a workspace that uses it is unreadable by a binary predating it, while
// workspaces that never annotate stay fully readable and storageVersion stays 1.
const workOperations = new Set(["work.created", "work.updated", "work.deleted", "work.annotated"]);
// WSD-1: conference/gate records persist as additive event-log operations. A
// workspace that contains one of these events is unreadable by pre-WSD-1
// binaries (they fail closed at the unknown-operation check below); workspaces
// that never use them stay fully readable, and storageVersion stays 1.
const conferenceOperations = new Set(["conference.created", "conference.updated", "conference.position.appended", "conference.closed"]);
// TCRN-CROSS-STORY-475 R1: a minutes record in one event. A chain that uses it is unreadable by a
// binary predating it, like every additive operation before it.
const minutesOperations = new Set<string>([MINUTES_RECORDED_OPERATION]);
const gateOperations = new Set(["gate.created", "gate.updated", "gate.deleted"]);
const settingsOperations = new Set(["settings.updated", "settings.removed"]);
const legacyPresetOperation = "execution." + "persona" + "-preset";
const executionOperations = new Set([
  "execution.configuration.set",
  "execution.configuration.removed",
  "execution.default.set",
  "execution.binding.set",
  "execution.binding.removed",
  "execution.persona.set",
  "execution.persona.removed",
  "execution.model-plan.set",
  "execution.model-plan.assigned",
  "execution.model-plan.unassigned",
  "execution.model-plan.removed",
  `${legacyPresetOperation}.override`,
  `${legacyPresetOperation}.restore`,
  `${legacyPresetOperation}.removed`,
]);
const templateOperations = new Set(["template.admitted"]);
const metadataFields = [
  "schemaVersion",
  "storageVersion",
  "minimumStorageVersion",
  "maximumStorageVersion",
  "workspaceId",
  "externalKey",
  "createdAt",
  "segmentEventLimit",
  "roots",
];
// WSR-1: the ten-field form. Kept as a second closed list rather than making
// `relocations` optional inside exactFields, so a workspace that carries the field
// is checked just as exactly as one that does not — an "optional" arm inside the
// exactness check is how a closed schema stops being closed.
const metadataFieldsWithRelocations = [...metadataFields, "relocations"];
const relocationEntryFields = ["schemaVersion", "sequence", "relocationId", "stage", "at", "from", "to", "basis", "authority"];
const relocationBasisFields = ["controlManifestSha256", "headEventHash", "version"];
const relocationAuthorityFields = ["actorId", "authorityFileSha256"];
const relocationStages = new Set<string>(["vacated", "adopted", "aborted"]);
// f8: the metadata root order. resolveWorkspace compares INDEX-WISE, so every
// relocation `from`/`to` array must preserve it exactly.
const relocationRootKindOrder = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];

function fail(reasonCode: WorkspaceReasonCode, message: string): never {
  throw new WorkspaceError(reasonCode, message);
}

// WSA-1 typing: JsonValue's object arm is an index-signature type, and the
// built-in Array.isArray guard only removes the mutable-array form, so an
// inline `typeof v === "object" && !Array.isArray(v)` chain leaves the readonly
// array arm in the union and every field read fails. This predicate states the
// same runtime test once and reports the narrowing the test really proves.
function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

// WSA-1 typing: the record interfaces are structurally JSON objects, but
// TypeScript grants an implicit index signature only to anonymous object types,
// so an interface never satisfies JsonValue by plain assignment. This
// homomorphic mapped type restates a record's own fields as an anonymous type,
// which does carry that index signature. Nothing is asserted away: the compiler
// still checks every field of T against JsonValue at the use site, and a record
// that gained a non-JSON field would still be rejected. The recursion covers the
// nested case (ExtensionValue inside WorkRecord.extensions has the same missing
// index signature); a field that already is a JsonValue is kept verbatim rather
// than restated, so its check is the compiler's, not this type's.
type JsonFields<T> = T extends JsonValue ? T : { readonly [K in keyof T]: JsonFields<T[K]> };

// These two are identity at run time. They exist so the restatement above is
// instantiated at a concrete record type, where the compiler verifies the record
// really does satisfy it -- no assertion is involved, and a record field that
// stopped being JSON would fail here.
function projectJsonFields(record: ProjectRecord): JsonFields<ProjectRecord> {
  return record;
}

function workJsonFields(record: WorkRecord): JsonFields<WorkRecord> {
  return record;
}

function exactFields(value: unknown, expected: readonly string[], reasonCode: WorkspaceReasonCode, label: string): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(reasonCode, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareCanonicalText);
  const required = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(reasonCode, `${label} fields are not exact`);
  }
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

export function assertWorkspaceRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || isAbsolute(value) || value.includes("\\")) {
    fail("WORKSPACE_PATH_ESCAPE", String(value));
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("WORKSPACE_PATH_ESCAPE", value);
  }
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_PATH_INVALID", error.message);
    }
    throw error;
  }
}

// TCRN-CROSS-INC-224: this is the chain's LIFETIME event bound. validateEventChain and
// workspaceBudgets answer to the same maxChainEvents (TCRN-CROSS-STORY-451); every other
// use of the old shared constant bounds the shape of one document or call; conflating
// the two meant a year of accumulated governance was measured against the same number
// as a single canonical array's length.
export function assertWorkspaceRecordCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > PROTOCOL_LIMITS.maxChainEvents) {
    fail("WORKSPACE_RECORD_LIMIT", String(count));
  }
}

// STORY-174 (174.3): the data-plane copies of boundFile/boundDirectory/
// ensureDirectory/atomicWrite moved into FileBackend (storage-backend.ts). The bound
// directory check below stays here for root resolution and the write-lock gate; the
// lease, recovery and mutation-claim machinery it once served was replaced by the
// engine file lock (TCRN-CROSS-STORY-467).
async function boundDirectory(path: string, workspaceRoot?: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail("WORKSPACE_PATH_INVALID", `${path}: ${String((error as { code?: string }).code ?? error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("WORKSPACE_PATH_INVALID", `${path} must be a real directory`);
  }
  const resolved = await realpath(path);
  if (workspaceRoot && !inside(workspaceRoot, resolved)) {
    fail("WORKSPACE_PATH_ESCAPE", path);
  }
  const after = await lstat(resolved);
  if (!after.isDirectory() || metadata.dev !== after.dev || metadata.ino !== after.ino) {
    fail("WORKSPACE_PATH_INVALID", `${path} changed while resolving`);
  }
  return resolved;
}

function crash(point: WorkspaceCrashPoint, selected?: WorkspaceCrashPoint): void {
  if (point === selected) {
    fail("WORKSPACE_FAULT_INJECTED", `injected crash at ${point}`);
  }
}

function validateProject(record: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_EVENT_CORRUPT"): ProjectRecord {
  exactFields(record, projectFields, reasonCode, "project record");
  if (record.schemaVersion !== "tcrn.project.v1" || typeof record.id !== "string" || typeof record.externalKey !== "string" ||
    typeof record.name !== "string" || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
    typeof record.updatedAt !== "string" || typeof record.tombstone !== "boolean") {
    fail(reasonCode, "project record types are invalid");
  }
  try {
    if (record.externalKey !== canonicalExternalKey(record.externalKey) || record.id !== deriveStableId("project", record.externalKey)) {
      fail(reasonCode, "project identity is invalid");
    }
    assertStrictInstant(record.updatedAt);
    canonicalJson(record.name);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail(reasonCode, error.message);
    }
    throw error;
  }
  if ([...record.name].length < 1 || [...record.name].length > 512) {
    fail("WORKSPACE_INPUT_OVERSIZED", "project name limit exceeded");
  }
  return record as unknown as ProjectRecord;
}

function deriveRelocationId(input: {
  readonly workspaceId: string;
  readonly sequence: number;
  readonly from: readonly CanonicalRoot[];
  readonly to: readonly CanonicalRoot[];
  readonly basis: WorkspaceRelocationBasis;
}): string {
  return `relocation:${canonicalSha256({
    schemaVersion: WORKSPACE_RELOCATION_IDENTITY_VERSION,
    workspaceId: input.workspaceId,
    sequence: input.sequence,
    from: input.from,
    to: input.to,
    basis: input.basis,
  }).slice(0, 24)}`;
}

function relocationRootArray(value: unknown, label: string): readonly CanonicalRoot[] {
  if (!Array.isArray(value) || value.length !== 5) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label} must hold five roots`);
  }
  const roots: CanonicalRoot[] = [];
  for (const [index, entry] of value.entries()) {
    exactFields(entry, rootFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}]`);
    if (typeof entry.kind !== "string" || typeof entry.path !== "string" ||
      typeof entry.canonicalPath !== "string" || typeof entry.portableIdentity !== "string") {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}] types are invalid`);
    }
    if (entry.kind !== relocationRootKindOrder[index]) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}] must be ${String(relocationRootKindOrder[index])}`);
    }
    if (entry.portableIdentity !== rootPortableIdentity(entry.canonicalPath)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}[${index}] portableIdentity is not derived from its canonicalPath`);
    }
    roots.push(entry as unknown as CanonicalRoot);
  }
  try {
    assertDistinctRootShape(roots);
  } catch (error) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `${label}: ${String((error as { message?: string }).message ?? error)}`);
  }
  return roots;
}

// WSR-1: the post-read ledger validator. Runs inside validateMetadata, so a
// malformed or spliced ledger is refused at the same choke point a malformed root
// array is — before any caller sees the metadata at all.
function validateRelocationLedger(value: unknown, roots: readonly CanonicalRoot[], workspaceId: string): readonly WorkspaceRelocationEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", "relocations must be a non-empty array when present");
  }
  if (value.length > WORKSPACE_RELOCATION_LEDGER_LIMIT) {
    fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations exceed the ${String(WORKSPACE_RELOCATION_LEDGER_LIMIT)} entry cap`);
  }
  const entries: WorkspaceRelocationEntry[] = [];
  // The binding in force before the entry being read. It starts at `roots` and only
  // an `adopted` entry moves it. This is what makes a hop unspliceable: a `vacated`
  // entry must restate the exact binding that preceded it, byte for byte.
  let binding: readonly CanonicalRoot[] = roots;
  for (const [index, raw] of value.entries()) {
    exactFields(raw, relocationEntryFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}]`);
    if (raw.schemaVersion !== WORKSPACE_RELOCATION_ENTRY_VERSION) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].schemaVersion`);
    }
    if (raw.sequence !== index + 1) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].sequence is not contiguous`);
    }
    if (typeof raw.stage !== "string" || !relocationStages.has(raw.stage)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].stage`);
    }
    if (typeof raw.relocationId !== "string" || !/^relocation:[a-f0-9]{24}$/u.test(raw.relocationId)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].relocationId`);
    }
    try {
      assertStrictInstant(raw.at);
    } catch {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].at`);
    }
    const from = relocationRootArray(raw.from, `relocations[${index}].from`);
    const to = relocationRootArray(raw.to, `relocations[${index}].to`);
    exactFields(raw.basis, relocationBasisFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].basis`);
    const basisValue = raw.basis as Readonly<Record<string, unknown>>;
    if (typeof basisValue.controlManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(basisValue.controlManifestSha256) ||
      !(basisValue.headEventHash === null || (typeof basisValue.headEventHash === "string" && /^[a-f0-9]{64}$/u.test(basisValue.headEventHash))) ||
      !Number.isSafeInteger(basisValue.version) || Number(basisValue.version) < 0) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].basis is invalid`);
    }
    const basis: WorkspaceRelocationBasis = {
      controlManifestSha256: basisValue.controlManifestSha256,
      headEventHash: basisValue.headEventHash as string | null,
      version: basisValue.version as number,
    };
    exactFields(raw.authority, relocationAuthorityFields, "WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].authority`);
    const authorityValue = raw.authority as Readonly<Record<string, unknown>>;
    if (typeof authorityValue.authorityFileSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(authorityValue.authorityFileSha256)) {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].authority.authorityFileSha256`);
    }
    try {
      assertProtocolId(authorityValue.actorId);
    } catch {
      fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].authority.actorId`);
    }
    const entry = raw as unknown as WorkspaceRelocationEntry;
    const previous = entries[index - 1];
    if (entry.stage === "vacated") {
      if (previous !== undefined && previous.stage === "vacated") {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}] follows an uncompleted hop`);
      }
      if (canonicalJson(from) !== canonicalJson(binding)) {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].from is not the binding it replaced`);
      }
      if (entry.relocationId !== deriveRelocationId({ workspaceId, sequence: entry.sequence, from, to, basis })) {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}].relocationId is not derived from its own content`);
      }
    } else {
      if (previous === undefined || previous.stage !== "vacated") {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}] does not complete a vacated hop`);
      }
      if (entry.relocationId !== previous.relocationId ||
        canonicalJson(from) !== canonicalJson(previous.from) ||
        canonicalJson(to) !== canonicalJson(previous.to) ||
        canonicalJson(basis) !== canonicalJson(previous.basis)) {
        fail("WORKSPACE_RELOCATION_LEDGER_INVALID", `relocations[${index}] does not restate its hop`);
      }
      if (entry.stage === "adopted") {
        binding = to;
      }
    }
    entries.push(entry);
  }
  return entries;
}

// WSR-1: the binding in force. `relocations` absent means `roots`; otherwise the
// `to` of the newest hop an `adopted` completed, and an `aborted` pair reverts to
// the binding before it.
//
// `roots` is NEVER rewritten. The synthesised design had adopt overwrite it, which
// contradicts the ledger's own chaining rule one line later: the first hop's `from`
// must equal `roots` byte for byte, so overwriting `roots` makes the ledger
// self-invalidating on the very next read. Keeping `roots` as the immutable
// original binding is what makes this accessor load-bearing rather than cosmetic —
// after an adopt the two genuinely differ, which is why the four call sites below
// are the complete change set and why T5/T6/T7 can actually go red.
export function activeBinding(metadata: WorkspaceMetadata): readonly CanonicalRoot[] {
  let binding: readonly CanonicalRoot[] = metadata.roots;
  for (const entry of metadata.relocations ?? []) {
    if (entry.stage === "adopted") {
      binding = entry.to;
    }
  }
  return binding;
}

export function activeWorkspaceRoot(metadata: WorkspaceMetadata): string | undefined {
  return activeBinding(metadata).find((root) => root.kind === "workspace")?.canonicalPath;
}

function validateMetadata(value: unknown): WorkspaceMetadata {
  // WSR-1: the ten-field form is admitted only when the field is actually present.
  // A workspace without it is checked against the identical nine-field closed list
  // it has always been checked against.
  const relocationsPresent = value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.hasOwn(value, "relocations");
  exactFields(value, relocationsPresent ? metadataFieldsWithRelocations : metadataFields, "WORKSPACE_SCHEMA_INVALID", "workspace metadata");
  if (typeof value.storageVersion === "number" && value.storageVersion > WORKSPACE_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_FUTURE", String(value.storageVersion));
  }
  if (typeof value.storageVersion === "number" && value.storageVersion < WORKSPACE_LEGACY_STORAGE_VERSION) {
    fail("WORKSPACE_MIGRATION_DOWNGRADE", String(value.storageVersion));
  }
  const legacyStorage = value.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION && value.minimumStorageVersion === 1 &&
    value.maximumStorageVersion === 1 && Number.isSafeInteger(value.segmentEventLimit) &&
    Number(value.segmentEventLimit) >= 2 && Number(value.segmentEventLimit) <= 1024;
  const segmentedStorage = value.storageVersion === WORKSPACE_STORAGE_VERSION && value.minimumStorageVersion === 1 &&
    value.maximumStorageVersion === WORKSPACE_STORAGE_VERSION && Number.isSafeInteger(value.segmentEventLimit) &&
    Number(value.segmentEventLimit) >= WORKSPACE_SEGMENT_BYTES_MIN && Number(value.segmentEventLimit) <= WORKSPACE_SEGMENT_BYTES_MAX;
  if (value.schemaVersion !== WORKSPACE_SCHEMA_VERSION || (!legacyStorage && !segmentedStorage) ||
    typeof value.workspaceId !== "string" || typeof value.externalKey !== "string" ||
    typeof value.createdAt !== "string" || !Array.isArray(value.roots) || value.roots.length !== 5) {
    fail("WORKSPACE_SCHEMA_INVALID", "workspace metadata is not V1");
  }
  try {
    if (value.externalKey !== canonicalExternalKey(value.externalKey) || value.workspaceId !== deriveStableId("workspace", value.externalKey)) {
      fail("WORKSPACE_SCHEMA_INVALID", "workspace identity is invalid");
    }
    assertStrictInstant(value.createdAt);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_SCHEMA_INVALID", error.message);
    }
    throw error;
  }
  for (const root of value.roots) {
    exactFields(root, rootFields, "WORKSPACE_SCHEMA_INVALID", "workspace root entry");
    if (typeof root.kind !== "string" || typeof root.path !== "string" || typeof root.canonicalPath !== "string" ||
      typeof root.portableIdentity !== "string") {
      fail("WORKSPACE_SCHEMA_INVALID", "workspace root entry types are invalid");
    }
    try {
      canonicalJson(root);
    } catch (error) {
      if (error instanceof ProtocolError) {
        fail("WORKSPACE_SCHEMA_INVALID", error.message);
      }
      throw error;
    }
  }
  if (relocationsPresent) {
    validateRelocationLedger(value.relocations, value.roots as unknown as readonly CanonicalRoot[], value.workspaceId);
  }
  return value as unknown as WorkspaceMetadata;
}

function workspaceStreamId(metadata: WorkspaceMetadata): string {
  return `stream:${canonicalSha256({
    schemaVersion: "tcrn.workspace-stream-identity.v1",
    workspaceId: metadata.workspaceId,
    createdAt: metadata.createdAt,
  }).slice(0, 24)}`;
}

function workspaceEventId(streamId: string, sequence: number): string {
  return deriveLegacyEventId(streamId, sequence);
}

function payloadRecord(payload: JsonValue, operation: string, actorRequired: boolean): Readonly<Record<string, JsonValue>> {
  // WSD-1 (SDC-2): the payload field set is {operation, record} plus exactly the
  // extras the shared table registers for this operation (conference.closed
  // carries 'minutes'), so the read side mirrors the single payload constructor.
  // WSE-2: from the attestation.actor.enabled event onward (that event included),
  // actor joins the exact field set and is validated here, so the replay reducer
  // enforces the same mandatory attestation as the live append path — a
  // hand-tampered log that drops or forges actor after enable fails closed.
  const extras = EVENT_PAYLOAD_OPERATION_EXTRAS[operation] ?? [];
  if (actorRequired) {
    const carriesActor = payload !== null && typeof payload === "object" && !Array.isArray(payload) && "actor" in payload;
    if (!carriesActor) {
      fail("WORKSPACE_ACTOR_REQUIRED", `${operation} requires an actor after attestation is enabled`);
    }
    exactFields(payload, ["operation", "record", "actor", ...extras], "WORKSPACE_EVENT_CORRUPT", "event payload");
    try {
      assertActorId((payload as Readonly<Record<string, JsonValue>>).actor);
    } catch (error) {
      if (error instanceof ActorAttestationError) {
        fail("WORKSPACE_ACTOR_INVALID", `${operation} actor is invalid`);
      }
      throw error;
    }
  } else {
    exactFields(payload, ["operation", "record", ...extras], "WORKSPACE_EVENT_CORRUPT", "event payload");
  }
  if (payload.operation !== operation) {
    fail("WORKSPACE_EVENT_CORRUPT", `expected ${operation}`);
  }
  const record = payload.record;
  if (!isJsonObject(record)) {
    fail("WORKSPACE_EVENT_CORRUPT", `${operation} record is invalid`);
  }
  return record;
}

// WSD-1: the single-event atomic close payload — exactly {minutes, operation,
// record} where record is the conference at status closed and minutes is the
// revision-1 minutes record bound to it.
function closePayload(payload: JsonValue, actorRequired: boolean): { readonly record: Readonly<Record<string, JsonValue>>; readonly minutes: JsonValue } {
  const record = payloadRecord(payload, "conference.closed", actorRequired);
  const minutes = (payload as Readonly<Record<string, JsonValue>>).minutes;
  if (minutes === null || minutes === undefined || typeof minutes !== "object" || Array.isArray(minutes)) {
    fail("WORKSPACE_EVENT_CORRUPT", "conference.closed minutes is invalid");
  }
  return { record, minutes };
}

// WSD-1: map extension-validator failures (ConferenceError/AssignmentGateError)
// to the fail-closed replay reason so the unchanged record validators are reused
// verbatim by the reducer.
function extensionRecordOrCorrupt<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ConferenceError || error instanceof AssignmentGateError || error instanceof GateIdentityError || error instanceof SettingsError || error instanceof TemplateAdmissionError || error instanceof MinutesError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
}

// WSD-1: a mutated extension record must equal its current revision on every
// field except the explicitly mutable ones — immutable identity and binding
// fields (projectId, conferenceId, workId, ...) are pinned byte-exactly.
function assertPinnedExtensionFields(current: JsonValue, next: JsonValue, mutableFields: readonly string[], label: string): void {
  const currentRest: Record<string, unknown> = { ...(current as Readonly<Record<string, unknown>>) };
  const nextRest: Record<string, unknown> = { ...(next as Readonly<Record<string, unknown>>) };
  for (const field of mutableFields) {
    delete currentRest[field];
    delete nextRest[field];
  }
  if (canonicalJson(currentRest) !== canonicalJson(nextRest)) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} mutates a pinned field`);
  }
}

function sortExtensionRecords<T extends { readonly projectId: string; readonly id: string }>(records: Iterable<T>): readonly T[] {
  return [...records].sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id));
}

// WSA-2: the ancestor closure of a work record — the record plus every ancestor
// reachable by walking parentId, bounded by the frozen four-level hierarchy. A
// missing link stops the walk (validateWorkGraph then fails REFERENTIAL_INTEGRITY
// on the record whose parent is absent); a cycle stops after both endpoints are
// collected (validateWorkGraph then fails GRAPH_CYCLE).
function collectWorkClosure(work: Map<string, WorkRecord>, record: WorkRecord): readonly WorkRecord[] {
  const closure = new Map<string, WorkRecord>([[record.id, record]]);
  let cursor: WorkRecord | undefined = record;
  while (cursor && cursor.parentId !== null) {
    const parent = work.get(cursor.parentId);
    if (!parent || closure.has(parent.id)) {
      break;
    }
    closure.set(parent.id, parent);
    cursor = parent;
  }
  return [...closure.values()];
}

// WSA-2: per-event relationship validation. Validates only the mutated record's
// closure (record + ancestor chain) instead of the whole work graph, which
// removes the per-event full validateWorkGraph that made materialize quadratic.
// The terminal validateWorkGraph over the full set still runs once. This catches
// prefix-invalid intermediate states (a child before its parent, a live child of
// a just-tombstoned parent) that a terminal-only check would miss.
// CQ-10b correction: the ancestor walk is O(delta), but the delete arm below is a
// full scan of the work map, so this function is NOT O(delta) on a work.deleted
// event. The scan is counted by recordCollectionScan so the proof can bound it.
function validateWorkClosure(work: Map<string, WorkRecord>, projects: Map<string, ProjectRecord>, record: WorkRecord, registry: readonly ExtensionRegistration[] = []): void {
  const project = projects.get(record.projectId);
  if (!project || (project.tombstone && !record.tombstone)) {
    fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} references an unavailable project`);
  }
  const closure = collectWorkClosure(work, record);
  recordClosureValidation(closure.length);
  try {
    validateWorkGraph(closure, registry);
  } catch (error) {
    if (error instanceof ProtocolError) {
      fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
    }
    throw error;
  }
  if (record.tombstone) {
    // CQ-10b: this is a full scan of the work map, not part of the ancestor-bounded
    // closure above, and it runs once per work delete. It is counted separately so
    // the proof sees it; measurement (4% of replay at the reachable ceiling) says
    // leave it as a scan rather than trade a fail-closed corruption check for an
    // incrementally maintained live-children index.
    recordCollectionScan(work.size);
    for (const candidate of work.values()) {
      if (!candidate.tombstone && candidate.parentId === record.id) {
        fail("WORKSPACE_EVENT_CORRUPT", `TOMBSTONE_REFERENCED:${candidate.id}`);
      }
    }
  }
}

// WSD-1: O(delta) referential checks for a conference/gate reducer arm — bounded
// map lookups of the records the mutated record references (its project, its
// linked work, its conference), never a scan of a whole collection per event
// (SDC-3). The visit count feeds the extension closure counter.
function requireLiveProject(projects: Map<string, ProjectRecord>, projectId: string, label: string): void {
  const project = projects.get(projectId);
  if (!project || project.tombstone) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references an unavailable project`);
  }
}

function requireLiveWork(work: Map<string, WorkRecord>, projectId: string, workId: string, label: string): void {
  const record = work.get(workId);
  if (!record || record.tombstone || record.projectId !== projectId) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references unavailable work ${workId}`);
  }
}

function requireEventBoundTimestamp(updatedAt: string, event: EventRecord, label: string): void {
  if (updatedAt !== event.occurredAt) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} timestamp is not event-bound`);
  }
}

function requireOpenConference(conferences: Map<string, ConferenceRequest>, conferenceId: string, label: string): ConferenceRequest {
  const conference = conferences.get(conferenceId);
  if (!conference) {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references an unknown conference`);
  }
  if (conference.status !== "open") {
    fail("WORKSPACE_EVENT_CORRUPT", `${label} references a conference that is not open`);
  }
  return conference;
}

// WSD-4: the gate lifecycle graph. Off-by-default enforcement: a gate carries no
// meaning until created. pending<->blocked flip freely; pending/blocked reach
// satisfied only with resolving conference-minutes evidence; satisfied is
// terminal (the only exit is a gate.deleted tombstone, which is a separate
// operation, not a status move). The same map gates the verb and the reducer.
const GATE_TRANSITIONS: Record<GateRecord["status"], readonly GateRecord["status"][]> = Object.freeze({
  pending: ["blocked", "satisfied"],
  blocked: ["pending", "satisfied"],
  satisfied: [],
});
// WSD-4: strong satisfaction binding. A gate becomes satisfied only when its
// evidence locator resolves to stored, non-tombstoned conference minutes whose
// conference anchors the gate's work item; the resolving locator is persisted in
// the gate's own extensions map (a required:false entry that needs no registry
// row), so the reducer re-resolves the identical evidence a hand-tampered log
// cannot forge.
const GATE_EVIDENCE_KEY = "gate-evidence:conference-minutes";
// gate-v1: what the identity check decided, written down so an auditor can see which
// roster was in force when this gate closed. It is deliberately self-contained -- the
// acting actor and the roster's digest, nothing that has to be fetched to be read.
//
// Replay checks this entry's shape and never re-reads the roster. That is the whole
// point: a chain whose readability depended on an external file still being present
// would brick on ordinary key rotation, or on a restore onto a machine that never had
// it. The digest here is a record of what was checked, not something to check against.
const GATE_IDENTITY_KEY = "gate-identity:decision";
const CONFERENCE_MINUTES_LOCATOR_NAMESPACE = "conference-minutes";

function resolveGateEvidence(locator: string, gate: GateRecord, minutes: readonly ConferenceMinutes[], conferences: readonly ConferenceRequest[]): boolean {
  const separator = locator.indexOf(":");
  if (separator < 0 || locator.slice(0, separator) !== CONFERENCE_MINUTES_LOCATOR_NAMESPACE) {
    return false;
  }
  try {
    assertProtocolId(locator);
  } catch {
    return false;
  }
  const minutesId = `minutes:${locator.slice(separator + 1)}`;
  const record = minutes.find((entry) => !entry.tombstone && entry.id === minutesId);
  if (!record) {
    return false;
  }
  if (gate.workId === null) {
    return true;
  }
  const conference = conferences.find((entry) => entry.id === record.conferenceId);
  return conference !== undefined && conference.linkedWorkIds.includes(gate.workId);
}

function gateEvidenceExtensions(base: Readonly<Record<string, unknown>>, locator: string): Readonly<Record<string, unknown>> {
  return { ...base, [GATE_EVIDENCE_KEY]: { required: false, value: locator } };
}

function gateIdentityExtensions(base: Readonly<Record<string, unknown>>, decision: GateIdentityDecision): Readonly<Record<string, unknown>> {
  return { ...base, [GATE_IDENTITY_KEY]: { required: false, value: { actorId: decision.actorId, authorityFileSha256: decision.authorityFileSha256 } } };
}

function readGateEvidenceLocator(extensions: Readonly<Record<string, unknown>>): string | undefined {
  const entry = extensions[GATE_EVIDENCE_KEY];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const value = (entry as Readonly<Record<string, unknown>>).value;
  return typeof value === "string" ? value : undefined;
}

// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-365; MIN-235 D17, D11; MIN-238 D4): the release of a gate a
// migration carried over. The gate verbs and the conference verbs are retired, so a gate that was
// still pending when its chain became a library can no longer be satisfied by citing minutes; it
// stays pending, holding its work item back from done, until it is released in Atelier. A release
// is a gate.updated to satisfied whose one extensions delta is this entry, written down whole: who
// released it (an actor id), when (the event's own instant) and why. Replay re-checks all three and
// never needs anything outside the chain. The CLI verb refuses a model (MODEL_WRITE_REFUSED unless
// EINZBERN_SURFACE=atelier); that surface is an agreed convention, not proof of who ran it (D11).
const GATE_RELEASE_KEY = "gate-evidence:atelier-release";
const GATE_RELEASE_FIELDS = ["actor", "reason", "releasedAt"];
const GATE_RELEASE_REASON_MAXIMUM_BYTES = 2_048;
/** The verb a gate is released with, named by the refusal a gate that is not satisfied gives. */
export const GATE_RELEASE_VERB = "work-gate-release" as const;

/** A release as its entry records it (TCRN-CROSS-STORY-489). */
export interface GateRelease {
  readonly actor: string;
  readonly reason: string;
  readonly releasedAt: string;
}

// The release entry's value, checked: exactly the three fields, a valid actor, a reason of one to
// GATE_RELEASE_REASON_MAXIMUM_BYTES bytes that is not blank, and a strict instant. The verb refuses
// with WORKSPACE_INPUT_INVALID or WORKSPACE_ACTOR_INVALID, replay with WORKSPACE_EVENT_CORRUPT.
function checkedGateRelease(value: unknown, reasonCode: WorkspaceReasonCode): GateRelease {
  exactFields(value, GATE_RELEASE_FIELDS, reasonCode, "gate release");
  const { actor, reason, releasedAt } = value;
  try {
    assertActorId(actor);
  } catch (error) {
    if (!(error instanceof ActorAttestationError)) throw error;
    fail(reasonCode === "WORKSPACE_INPUT_INVALID" ? "WORKSPACE_ACTOR_INVALID" : reasonCode, `gate release actor ${String(actor)} is not an actor id`);
  }
  if (typeof reason !== "string" || !reason.isWellFormed() || reason.trim() === "" ||
    Buffer.byteLength(reason, "utf8") > GATE_RELEASE_REASON_MAXIMUM_BYTES) {
    fail(reasonCode, `a gate release gives its reason in one to ${GATE_RELEASE_REASON_MAXIMUM_BYTES} bytes of text`);
  }
  try {
    assertStrictInstant(releasedAt);
  } catch {
    fail(reasonCode, "a gate release records its instant");
  }
  return { actor, reason, releasedAt: releasedAt as string };
}

function gateReleaseExtensions(base: Readonly<Record<string, unknown>>, release: GateRelease): Readonly<Record<string, unknown>> {
  return { ...base, [GATE_RELEASE_KEY]: { required: false, value: { actor: release.actor, reason: release.reason, releasedAt: release.releasedAt } } };
}

// Replay of a release (a gate.updated to satisfied that carries GATE_RELEASE_KEY): the entry is
// well formed, its instant is the event's (the record's updatedAt is bound to the event before
// this runs), its actor is the one the event was signed with when the chain signs its events,
// and it is the only extensions delta, so no minutes locator or identity entry rides along.
// Before attestation is enabled an event carries no actor, and the entry's actor stands
// uncorroborated, as an identity decision's does.
function assertGateReleaseReplay(current: GateRecord, record: GateRecord, signer: JsonValue | undefined): void {
  const entry = record.extensions[GATE_RELEASE_KEY];
  const release = checkedGateRelease(entry !== null && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Readonly<Record<string, unknown>>).value
    : undefined, "WORKSPACE_EVENT_CORRUPT");
  if (release.releasedAt !== record.updatedAt) {
    fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} release names ${release.releasedAt}, not the instant it was written at`);
  }
  if (signer !== undefined && signer !== release.actor) {
    fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} release names ${release.actor} but the event was signed by ${String(signer)}`);
  }
  if (canonicalJson(record.extensions) !== canonicalJson(gateReleaseExtensions(current.extensions, release))) {
    fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} release extensions are not exact`);
  }
}

// E05 (advisory scope-on-record): advisory fields on a work record, written by the
// additive work.annotated operation. Both are required:false extensions -- no registry
// row; Story scope gates execution and Owner-decided completion, while a binary
// predating them still reads any workspace that never annotates. advisory:scope is an
// authoritative one-line scope/intent statement; advisory:decided-by backlinks the
// governing conference minutes, so an executor reads a work item's scope off the record
// itself rather than reconstructing it from a compressed external key.
const ADVISORY_SCOPE_KEY = "advisory:scope";
const ADVISORY_DECIDED_BY_KEY = "advisory:decided-by";
const ADVISORY_VERIFY_KEY = "advisory:verify";
const ADVISORY_EVIDENCE_KEY = "advisory:evidence";
const ADVISORY_EVIDENCE_SNAPSHOT_KEY = "advisory:evidence-snapshot";
// TCRN-CROSS-STORY-435/436: a native result annotation is the small, on-chain
// outcome surface used by current-stage batch qualification. It is deliberately
// advisory (like scope/verify): it never changes status and never substitutes for
// the acceptance roster or a gate.
const ADVISORY_RESULT_KEY = "advisory:result";
const NATIVE_IMPLEMENTATION_RESULT_VERSION = "tcrn.native-implementation-result.v1";
const WORK_SCOPE_REFERENCE_VERSION = "tcrn.work-scope-reference.v1" as const;
// INIT-008: advisory:sprint is the member-side tag that puts a work record on a
// sprint / release-train batch. Its value is a QUALIFIED reference to the sprint
// (a Release record) -- {workspaceId, workId} of full protocol ids -- so a member
// on one partition can point at a sprint on another (the cross partition). It is
// additive exactly like the other advisory keys: no new operation, no registry
// row, and a workspace that never sprints is byte-identical. The one caveat is the
// same as every advisory key and work.annotated itself -- a binary predating this
// key fails the closed anti-smuggling replay guard on a chain that USES it, which
// is why it ships in a minor release (0.5.0) that readers of such chains must pin.
const ADVISORY_SPRINT_KEY = "advisory:sprint";
// TCRN-CROSS-STORY-472 R2: the forward relations blocked-by, implements, supersedes and fixes
// (work-relations.ts). decided-in is advisory:decided-by and parent is parentId, so neither is here.
// The literal is repeated rather than imported: see the import of work-relations.js above.
const ADVISORY_RELATIONS_KEY = "advisory:relations";
// TCRN-CROSS-STORY-473 R2: a Story's goal, acceptance and free body (story-fields.ts). Any kind may
// carry them; a Story must have a goal and an acceptance.
const ADVISORY_GOAL_KEY = "advisory:goal";
const ADVISORY_ACCEPTANCE_KEY = "advisory:acceptance";
const ADVISORY_BODY_KEY = "advisory:body";
const ADVISORY_KEYS: readonly string[] = [
  ADVISORY_SCOPE_KEY,
  ADVISORY_DECIDED_BY_KEY,
  ADVISORY_VERIFY_KEY,
  ADVISORY_SPRINT_KEY,
  ADVISORY_EVIDENCE_KEY,
  ADVISORY_EVIDENCE_SNAPSHOT_KEY,
  ADVISORY_RESULT_KEY,
  ADVISORY_RELATIONS_KEY,
  ADVISORY_GOAL_KEY,
  ADVISORY_ACCEPTANCE_KEY,
  ADVISORY_BODY_KEY,
];

// TCRN-CROSS-STORY-472 R1: the kinds no write creates any more. Records of these kinds on a chain
// keep reading and replaying (validateWorkGraph still accepts them).
const RETIRED_WORK_KINDS: readonly string[] = ["Incident", "Release", "Review", "Knowledge"];
const WORK_KIND_RETIRED_REMEDY = "open a Story with a fixes relation (work-create --kind Story --fixes <work id>)";

// A sprint reference is a qualified cross-partition pointer: the workspaceId (derived,
// so `workspace:` + 24 hex) plus the work id of the sprint's Release record. Both halves
// are whole protocol ids re-validatable on their own -- the advisory:decided-by
// convention of carrying full ids, never a packed/compressed form.
export interface SprintReference {
  readonly workspaceId: string;
  readonly workId: string;
}

type WorkAdvisoryInput = {
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly verify?: string;
  readonly sprint?: SprintReference;
  readonly evidence?: string;
  readonly evidenceSnapshot?: TelemetryEvidenceSnapshot;
  readonly result?: JsonValue;
  // TCRN-CROSS-STORY-472 R2, R4: the forward relations, validated against the state the write is
  // built on. Stored as advisory:relations; decidedIn is written to advisory:decided-by.
  readonly relations?: WorkRelationsInput;
  readonly goal?: string;
  readonly acceptance?: string;
  readonly body?: string;
};

type WorkAnnotationInput = WorkAdvisoryInput & {
  readonly id: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly occurredAt: string;
};

function isSprintReference(value: unknown): value is SprintReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  // Membership check without a comparator: compareCanonicalText throws
  // CanonicalOrderError on an ill-formed-Unicode key, and this predicate must return
  // false for any bad shape rather than throw a foreign error at a direct caller.
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 2 || !Object.hasOwn(value as object, "workId") || !Object.hasOwn(value as object, "workspaceId")) return false;
  const { workspaceId, workId } = value as { readonly workspaceId: unknown; readonly workId: unknown };
  // The id of the library the member lives in; an old-layout workspace id is still a valid one
  // (TCRN-CROSS-STORY-469: a library's id stands where the workspace id stood).
  if (typeof workspaceId !== "string" || !LIBRARY_ID_PATTERN.test(workspaceId)) return false;
  if (typeof workId !== "string" || workId.slice(0, workId.indexOf(":")) !== "work") return false;
  try {
    assertProtocolId(workId);
  } catch {
    return false;
  }
  return true;
}

const ADVISORY_FIELD_KEYS = Object.freeze({ scope: ADVISORY_SCOPE_KEY, decidedBy: ADVISORY_DECIDED_BY_KEY, sprint: ADVISORY_SPRINT_KEY, verify: ADVISORY_VERIFY_KEY, evidence: ADVISORY_EVIDENCE_KEY, evidenceSnapshot: ADVISORY_EVIDENCE_SNAPSHOT_KEY, result: ADVISORY_RESULT_KEY, relations: ADVISORY_RELATIONS_KEY, goal: ADVISORY_GOAL_KEY, acceptance: ADVISORY_ACCEPTANCE_KEY, body: ADVISORY_BODY_KEY });

// `relations` is the validated form of advisory.relations (validateRelationsInput), never the raw
// input: each stored list it names replaces that list of advisory:relations whole (an empty one
// removes it, and the extension goes when no list is left), and its decided-in list is written as
// advisory:decided-by.
function workAdvisoryExtensions(base: Readonly<Record<string, unknown>>, advisory: WorkAdvisoryInput, relations?: NormalizedWorkRelations): Readonly<Record<string, unknown>> {
  const next: Record<string, unknown> = { ...base };
  for (const field of Object.keys(ADVISORY_FIELD_KEYS) as Array<keyof WorkAdvisoryInput>) {
    if (field === "relations") continue;
    const value = advisory[field];
    if (value === undefined) continue;
    const copied = field === "decidedBy" ? [...(value as readonly string[])] : field === "sprint" ? { workspaceId: (value as SprintReference).workspaceId, workId: (value as SprintReference).workId } : value;
    next[ADVISORY_FIELD_KEYS[field]] = { required: false, value: copied };
  }
  if (relations !== undefined) {
    if (relations.decidedIn !== undefined) next[ADVISORY_DECIDED_BY_KEY] = { required: false, value: [...relations.decidedIn] };
    if (relations.lists !== undefined) {
      const current = storedRelationsOf((base[ADVISORY_RELATIONS_KEY] as { readonly value?: unknown } | undefined)?.value);
      const merged = mergeStoredRelations(current, relations.lists);
      if (merged === null) {
        delete next[ADVISORY_RELATIONS_KEY];
      } else {
        next[ADVISORY_RELATIONS_KEY] = { required: false, value: { ...merged } };
      }
    }
  }
  return next;
}

// TCRN-CROSS-STORY-472 R2, R4: a write's relations, checked against the state it is built on.
// decided-in and the older decided-by name one relation, so a write may give both only when they
// agree.
function workRelationsForWrite(state: WorkspaceState, id: string, input: WorkAdvisoryInput): NormalizedWorkRelations | undefined {
  if (input.relations === undefined) return undefined;
  const relations = validateRelationsInput(state, id, input.relations);
  if (relations.decidedIn !== undefined && input.decidedBy !== undefined &&
    canonicalJson([...input.decidedBy] as JsonValue) !== canonicalJson([...relations.decidedIn] as JsonValue)) {
    fail("WORKSPACE_INPUT_INVALID", `work ${id} names decided-in and decided-by differently; they are one relation`);
  }
  return relations;
}

function workExtensionsDigest(extensions: Readonly<Record<string, unknown>>): string {
  return canonicalSha256(extensions as JsonValue);
}

function workScopeReference(digest: string): Readonly<Record<string, unknown>> {
  return { required: false, value: { schemaVersion: WORK_SCOPE_REFERENCE_VERSION, digest } };
}

function workEventExtensions(record: WorkRecord, deduplicateScope: boolean): WorkRecord["extensions"] {
  if (!deduplicateScope || typeof record.extensions[ADVISORY_SCOPE_KEY]?.value !== "string" || record.scopeDigest === null || record.scopeDigest === undefined) {
    return record.extensions;
  }
  return {
    ...record.extensions,
    [ADVISORY_SCOPE_KEY]: workScopeReference(record.scopeDigest),
  } as unknown as WorkRecord["extensions"];
}

function normalizeWorkRecord(record: WorkRecord, reasonCode: WorkspaceReasonCode = "WORKSPACE_EVENT_CORRUPT"): WorkRecord {
  const currentFields = ["scopeDigest", "title", "createdAt", "labels"];
  const present = currentFields.filter((field) => Object.hasOwn(record, field)).length;
  if (present === 0) {
    return { ...record, scopeDigest: null, title: null, createdAt: null, labels: [] };
  }
  if (present !== currentFields.length ||
    (record.scopeDigest !== null && (typeof record.scopeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.scopeDigest))) ||
    (record.title !== null && typeof record.title !== "string") ||
    (record.createdAt !== null && (typeof record.createdAt !== "string" || (() => { try { assertStrictInstant(record.createdAt); return false; } catch { return true; } })())) ||
    !Array.isArray(record.labels) || record.labels.some((label) => typeof label !== "string") || new Set(record.labels).size !== record.labels.length) {
    fail(reasonCode, `work ${String(record.id)} field upgrade is invalid`);
  }
  // TCRN-CROSS-STORY-363. The summary is checked only where it is present. It is
  // deliberately NOT filled in for the records that predate it: this function runs
  // on every replayed event, and adding a field here would change the bytes every
  // derived view digests without any event having changed -- eight partitions'
  // views stale at once, for a field nobody wrote.
  if (Object.hasOwn(record, "summary") && !isWorkSummary(record.summary)) {
    fail(reasonCode, `work ${String(record.id)} summary is invalid`);
  }
  return record;
}

function normalizeWorkLabels(value: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_INPUT_INVALID"): readonly string[] {
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string" || label.length === 0 || label.length > 128) || new Set(value).size !== value.length) {
    fail(reasonCode, "work labels must be unique bounded strings");
  }
  return [...value].sort(compareCanonicalText);
}

function normalizeWorkTitle(value: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_INPUT_INVALID"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || [...value].length > 512) {
    fail(reasonCode, "work title must be a non-empty bounded string");
  }
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof ProtocolError) fail(reasonCode, error.message);
    throw error;
  }
  return value;
}

// TCRN-CROSS-STORY-363. The write-path bound on a caller-supplied summary. It
// shares isWorkSummary with replay so the rule has one statement, and it reports
// the byte budget in the message because "too long" is unactionable when the
// budget is bytes and the author counted characters.
function normalizeWorkSummary(value: unknown, reasonCode: WorkspaceReasonCode = "WORKSPACE_INPUT_INVALID"): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isWorkSummary(value)) {
    fail(reasonCode, `work summary must be a non-empty string of at most ${String(WORK_SUMMARY_MAX_BYTES)} UTF-8 bytes`);
  }
  return value as string;
}

function workFieldsForWrite(record: WorkRecord): WorkRecord {
  const normalized = normalizeWorkRecord(record);
  return {
    ...normalized,
    scopeDigest: workExtensionsDigest(normalized.extensions),
    title: normalized.title ?? null,
    createdAt: normalized.createdAt ?? null,
    labels: normalized.labels ?? [],
  };
}

function resolveWorkRecord(raw: WorkRecord, current: WorkRecord | undefined, reasonCode: WorkspaceReasonCode): WorkRecord {
  const record = normalizeWorkRecord(raw, reasonCode);
  const scopeEntry = record.extensions[ADVISORY_SCOPE_KEY];
  const scopeValue = scopeEntry?.value;
  if (scopeValue !== null && typeof scopeValue === "object" && !Array.isArray(scopeValue)) {
    exactFields(scopeValue, ["digest", "schemaVersion"], reasonCode, "work scope reference");
    const reference = scopeValue as Readonly<Record<string, unknown>>;
    if (reference.schemaVersion !== WORK_SCOPE_REFERENCE_VERSION || typeof reference.digest !== "string" || !/^[a-f0-9]{64}$/u.test(reference.digest) || record.scopeDigest !== reference.digest || current === undefined) {
      fail(reasonCode, `work ${record.id} scope reference is not resolvable`);
    }
    const previousScope = current.extensions[ADVISORY_SCOPE_KEY];
    if (previousScope === undefined || typeof previousScope.value !== "string" || workExtensionsDigest(current.extensions) !== reference.digest) {
      fail(reasonCode, `work ${record.id} scope reference does not match its predecessor`);
    }
    const extensions = { ...record.extensions, [ADVISORY_SCOPE_KEY]: previousScope } as WorkRecord["extensions"];
    if (workExtensionsDigest(extensions) !== record.scopeDigest) {
      fail(reasonCode, `work ${record.id} scope reference would change extensions`);
    }
    return { ...record, extensions };
  }
  if (record.scopeDigest !== null && record.scopeDigest !== undefined && record.scopeDigest !== workExtensionsDigest(record.extensions)) {
    fail(reasonCode, `work ${record.id} scope digest does not match extensions`);
  }
  return record;
}

function isMinutesId(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const separator = value.indexOf(":");
  if (separator < 0 || value.slice(0, separator) !== "minutes") {
    return false;
  }
  try {
    assertProtocolId(value);
  } catch {
    return false;
  }
  return true;
}

function advisoryHasMinutes(record: Pick<WorkRecord, "extensions">): boolean {
  const entry = record.extensions[ADVISORY_DECIDED_BY_KEY];
  return Array.isArray(entry?.value) && entry.value.length > 0 && entry.value.every((item) => isMinutesId(item));
}

function assertStoryCompletionAdmission(record: WorkRecord, targetStatus: WorkStatus): void {
  if (record.kind !== "Story" || targetStatus !== "done") return;
  // TCRN-CROSS-STORY-473: the decider is read from the goal, as a field or mapped from an old scope.
  if (storyOwnerDeciderNamed(storyFields(record)) && !advisoryHasMinutes(record)) {
    fail("WORKSPACE_OWNER_ACCEPTANCE_REQUIRED", "Owner-decided Story requires a decided-by minutes backlink before done");
  }
}

const STORY_FIELD_REMEDY: Readonly<Record<StoryRequiredField, string>> = {
  goal: "give --goal, or a scope whose Goal block holds it",
  acceptance: "give --acceptance, or a scope whose Acceptance Criteria block holds it",
};

// TCRN-CROSS-STORY-473 R2: a Story has a goal and an acceptance -- its fields, or the Goal and
// Acceptance Criteria blocks of its scope. Nothing else about its prose is checked.
function assertStoryFields(record: Pick<WorkRecord, "id" | "kind" | "extensions">): void {
  if (record.kind !== "Story") return;
  const field = missingStoryField(storyFields(record));
  if (field === null) return;
  throw new WorkspaceError(
    "WORK_STORY_FIELD_REQUIRED",
    `Story ${record.id} has no ${field}: ${STORY_FIELD_REMEDY[field]}`,
    { field, remedy: STORY_FIELD_REMEDY[field] },
  );
}

function isStoryFieldText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.isWellFormed() && !value.includes("\u0000");
}

function validateWorkAdvisoryInput(input: WorkAdvisoryInput, id: string, reasonCode: WorkspaceReasonCode): void {
  const checks: ReadonlyArray<readonly [keyof WorkAdvisoryInput, (value: unknown) => boolean, string]> = [
    ["scope", (value) => typeof value === "string" && value.length > 0, "advisory scope must be a non-empty string"],
    ["decidedBy", (value) => Array.isArray(value) && value.length > 0 && value.every((item) => isMinutesId(item)), "advisory decided-by must be a non-empty list of minutes ids"],
    ["sprint", isSprintReference, "advisory sprint must be a {workspaceId, workId} qualified reference"],
    ["goal", isStoryFieldText, "advisory goal must be non-empty text"],
    ["acceptance", isStoryFieldText, "advisory acceptance must be non-empty text"],
    ["body", isStoryFieldText, "advisory body must be non-empty text"],
  ];
  for (const [field, valid, message] of checks) {
    if (input[field] !== undefined && !valid(input[field])) fail(reasonCode, message);
  }
  if (input.verify !== undefined) assertAdvisoryEntryShape(ADVISORY_VERIFY_KEY, { required: false, value: input.verify }, id, reasonCode);
  if (input.evidence !== undefined) assertAdvisoryEntryShape(ADVISORY_EVIDENCE_KEY, { required: false, value: input.evidence }, id, reasonCode);
  if (input.evidenceSnapshot !== undefined) assertAdvisoryEntryShape(ADVISORY_EVIDENCE_SNAPSHOT_KEY, { required: false, value: input.evidenceSnapshot }, id, reasonCode);
  if (input.result !== undefined) assertAdvisoryEntryShape(ADVISORY_RESULT_KEY, { required: false, value: input.result }, id, reasonCode);
}

// Defence in depth on the advisory value shape. The terminal validateWorkGraph over the
// whole materialized set already proves each advisory entry is a required:false
// {required, value} pair under a valid protocol-id key (a required:true key would fail
// UNKNOWN_REQUIRED_EXTENSION because advisory keys carry no registry row); this adds the
// value semantics the extension map is deliberately agnostic about.
function assertAdvisoryEntryShape(key: string, entry: unknown, id: string, reasonCode: WorkspaceReasonCode): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(reasonCode, `work ${id} advisory ${key} is malformed`);
  }
  const value = (entry as Readonly<Record<string, unknown>>).value;
  if (key === ADVISORY_SCOPE_KEY) {
    if (typeof value !== "string" || value.length === 0) {
      fail(reasonCode, `work ${id} advisory scope must be a non-empty string`);
    }
    return;
  }
  if (key === ADVISORY_SPRINT_KEY) {
    if (!isSprintReference(value)) {
      fail(reasonCode, `work ${id} advisory sprint must be a {workspaceId, workId} qualified reference`);
    }
    return;
  }
  if (key === ADVISORY_GOAL_KEY || key === ADVISORY_ACCEPTANCE_KEY || key === ADVISORY_BODY_KEY) {
    if (!isStoryFieldText(value)) fail(reasonCode, `work ${id} ${key} must be non-empty text`);
    return;
  }
  if (key === ADVISORY_RELATIONS_KEY) {
    // Shape only: replay never asks whether a target exists (TCRN-CROSS-STORY-472).
    const problem = relationsShapeProblem(value, id);
    if (problem !== null) fail(reasonCode, `work ${id} advisory relations ${problem}`);
    return;
  }
  if (key === ADVISORY_VERIFY_KEY) {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096 || value.includes("\u0000") || !value.isWellFormed()) {
      fail(reasonCode, `work ${id} advisory verify must be non-empty bounded text`);
    }
    return;
  }
  if (key === ADVISORY_EVIDENCE_KEY) {
    if (typeof value !== "string" || !/^telemetry:[a-f0-9]{24}$/u.test(value)) {
      fail(reasonCode, `work ${id} advisory evidence must be a telemetry id`);
    }
    return;
  }
  if (key === ADVISORY_EVIDENCE_SNAPSHOT_KEY) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(reasonCode, `work ${id} advisory evidence snapshot is malformed`);
    }
    const snapshot = value as Readonly<Record<string, unknown>>;
    try {
      exactFields(snapshot, ["schemaVersion", "id", "digest", "fields"], reasonCode, "telemetry evidence snapshot");
      if (snapshot.schemaVersion !== "tcrn.telemetry-evidence.v1" || typeof snapshot.id !== "string" ||
        !/^telemetry:[a-f0-9]{24}$/u.test(snapshot.id) || typeof snapshot.digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(snapshot.digest)) {
        fail(reasonCode, `work ${id} advisory evidence snapshot identity is malformed`);
      }
      const fields = snapshot.fields;
      if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
        fail(reasonCode, `work ${id} advisory evidence snapshot fields are malformed`);
      }
      const fieldRecord = fields as Readonly<Record<string, unknown>>;
      exactFields(fieldRecord, ["at", "kind", "session", "payload"], reasonCode, "telemetry evidence snapshot fields");
      const record = validateTelemetryRecord({
        schemaVersion: "tcrn.telemetry.v1",
        id: snapshot.id,
        at: fieldRecord.at,
        kind: fieldRecord.kind,
        session: fieldRecord.session,
        payload: fieldRecord.payload,
      });
      const expected = telemetryEvidenceSnapshot(record);
      if (canonicalJson(expected as unknown as JsonValue) !== canonicalJson(value as JsonValue)) {
        fail(reasonCode, `work ${id} advisory evidence snapshot digest or fields do not match`);
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof ProtocolError) fail(reasonCode, error.message);
      if (error instanceof TelemetryError) fail(reasonCode, `${error.reasonCode}:${error.message}`);
      throw error;
    }
    return;
  }
  if (key === ADVISORY_RESULT_KEY) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(reasonCode, `work ${id} advisory result is malformed`);
    }
    const result = value as Readonly<Record<string, unknown>>;
    const required = [
      "command", "dependencies", "evidence", "exitCode", "ok", "revision", "schemaVersion", "scopeDigest", "status", "workId",
    ];
    const allowed = [
      "candidateDigest", "candidateId", "command", "dependencies", "evidence", "exitCode",
      "invalidated", "ok", "queueDigest", "reason", "revision", "schemaVersion", "scopeDigest",
      "stale", "status", "workId",
    ];
    const actual = Object.keys(result).sort(compareCanonicalText);
    if (actual.some((field) => !allowed.includes(field)) || required.some((field) => !Object.hasOwn(result, field))) {
      fail(reasonCode, `work ${id} advisory result fields are malformed`);
    }
    if (result.schemaVersion !== NATIVE_IMPLEMENTATION_RESULT_VERSION
      || typeof result.status !== "string" || result.status.length === 0
      || typeof result.ok !== "boolean"
      || (result.exitCode !== null && (typeof result.exitCode !== "number" || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0))
      || typeof result.command !== "string" || result.command.length === 0 || Buffer.byteLength(result.command, "utf8") > 4_096
      || (typeof result.evidence === "string" ? result.evidence.length === 0 : (!Array.isArray(result.evidence) || result.evidence.length === 0 || !result.evidence.every((entry) => typeof entry === "string" && entry.length > 0)))
      || !Array.isArray(result.dependencies) || result.dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
      || new Set(result.dependencies).size !== result.dependencies.length
      || typeof result.workId !== "string" || result.workId !== id
      || typeof result.revision !== "number" || !Number.isSafeInteger(result.revision) || result.revision < 1
      || typeof result.scopeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(result.scopeDigest)
      || result.candidateId !== undefined && result.candidateId !== null && typeof result.candidateId !== "string"
      || result.candidateDigest !== undefined && result.candidateDigest !== null && (typeof result.candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(result.candidateDigest))
      || result.queueDigest !== undefined && result.queueDigest !== null && typeof result.queueDigest !== "string"
      || result.invalidated !== undefined && result.invalidated !== null && typeof result.invalidated !== "boolean"
      || result.stale !== undefined && result.stale !== null && typeof result.stale !== "boolean"
      || result.reason !== undefined && result.reason !== null && (typeof result.reason !== "string" || result.reason.length === 0)) {
      fail(reasonCode, `work ${id} advisory result fields are malformed`);
    }
    return;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => isMinutesId(item))) {
    fail(reasonCode, `work ${id} advisory decided-by must be a non-empty list of minutes ids`);
  }
}

function assertWorkTransitionEvidence(current: WorkRecord, next: WorkRecord, reasonCode: WorkspaceReasonCode): void {
  const currentExtensions: Record<string, unknown> = { ...current.extensions };
  const nextExtensions: Record<string, unknown> = { ...next.extensions };
  const currentEvidence = currentExtensions[ADVISORY_EVIDENCE_KEY];
  const nextEvidence = nextExtensions[ADVISORY_EVIDENCE_KEY];
  const currentSnapshot = currentExtensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY];
  const nextSnapshot = nextExtensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY];
  delete currentExtensions[ADVISORY_EVIDENCE_KEY];
  delete currentExtensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY];
  delete nextExtensions[ADVISORY_EVIDENCE_KEY];
  delete nextExtensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY];
  if (canonicalJson(currentExtensions as JsonValue) !== canonicalJson(nextExtensions as JsonValue)) {
    fail(reasonCode, `work ${next.id} transition changed a non-evidence extension`);
  }
  if (currentEvidence !== undefined || currentSnapshot !== undefined) {
    if (canonicalJson((currentEvidence ?? null) as JsonValue) !== canonicalJson((next.extensions[ADVISORY_EVIDENCE_KEY] ?? null) as JsonValue) ||
      canonicalJson((currentSnapshot ?? null) as JsonValue) !== canonicalJson((next.extensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY] ?? null) as JsonValue)) {
      fail(reasonCode, `work ${next.id} transition changed existing evidence`);
    }
    return;
  }
  if (nextEvidence === undefined && nextSnapshot === undefined) return;
  if (next.status !== "done" || nextEvidence === undefined || nextSnapshot === undefined) {
    fail(reasonCode, `work ${next.id} evidence applies only as a complete done transition`);
  }
  assertAdvisoryEntryShape(ADVISORY_EVIDENCE_KEY, next.extensions[ADVISORY_EVIDENCE_KEY], next.id, reasonCode);
  assertAdvisoryEntryShape(ADVISORY_EVIDENCE_SNAPSHOT_KEY, next.extensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY], next.id, reasonCode);
  const snapshot = (nextSnapshot as { readonly value?: unknown }).value;
  const evidence = (nextEvidence as { readonly value?: unknown }).value;
  const snapshotId = snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Readonly<Record<string, unknown>>).id
    : undefined;
  if (evidence !== snapshotId) {
    fail(reasonCode, `work ${next.id} evidence id and snapshot id differ`);
  }
}

// The work.annotated guard: only the annotatable fields may differ from the prior
// revision, and at least one must. Every other extension entry stays byte-identical, so
// an annotation can neither introduce a foreign extension, drop one, nor alter it -- the
// same anti-smuggling shape the gate evidence path enforces with an exact comparison.
//
// TCRN-CROSS-INC-269: this was a replay-only guard, and the verb had no counterpart to
// it. The verb's own no-op check compared title and labels as well, so an annotation
// that moved only those -- neither is an extension -- passed the verb, appended, and
// then failed every later read of that workspace as WORKSPACE_EVENT_CORRUPT. Like
// assertGateClearance, the predicate now takes its reason code from the caller and runs
// on both paths: WORKSPACE_INPUT_INVALID on the verb, WORKSPACE_EVENT_CORRUPT in replay.
// One predicate, so the two cannot drift apart again.
//
// TCRN-CROSS-STORY-363 finishes that repair from the other end. INC-269 closed the hole
// by refusing a title-only annotation on both paths, which left title, labels and now
// summary writable only in the company of an advisory change -- and a summary backfill
// has no advisory change to make: it is not allowed to touch the scope it reads. So the
// "at least one moved" test now counts the three top-level annotatable fields alongside
// the advisory keys. This is a widening in the safe direction only: every event that
// replayed before still replays, an empty delta is still refused because nothing moved,
// and the non-advisory extension comparison below is untouched, so nothing new can be
// smuggled through. What becomes legal is exactly the write the verb was already the
// only producer of.
interface WorkAnnotationFields {
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly title: string | null;
  readonly summary: string | null;
  readonly labels: readonly string[];
}

function workAnnotationFields(record: WorkRecord): WorkAnnotationFields {
  return {
    extensions: record.extensions,
    title: record.title ?? null,
    summary: record.summary ?? null,
    labels: record.labels ?? [],
  };
}

function assertWorkAnnotation(
  current: WorkAnnotationFields,
  next: WorkAnnotationFields,
  id: string,
  reasonCode: WorkspaceReasonCode,
): void {
  const advisory = new Set(ADVISORY_KEYS);
  const keys = new Set([...Object.keys(current.extensions), ...Object.keys(next.extensions)]);
  let changed = current.title !== next.title || current.summary !== next.summary ||
    canonicalJson(current.labels as JsonValue) !== canonicalJson(next.labels as JsonValue);
  for (const key of keys) {
    const before = canonicalJson((current.extensions[key] ?? null) as JsonValue);
    const after = canonicalJson((next.extensions[key] ?? null) as JsonValue);
    if (!advisory.has(key)) {
      if (before !== after) {
        fail(reasonCode, `work ${id} annotation changed non-advisory extension ${key}`);
      }
      continue;
    }
    if (before !== after) {
      changed = true;
    }
    if (Object.hasOwn(next.extensions, key)) {
      assertAdvisoryEntryShape(key, next.extensions[key], id, reasonCode);
    }
  }
  if (!changed) {
    fail(reasonCode, `work ${id} annotation changed no annotatable field`);
  }
}

// WSD-4: the designated set is exactly "a transition whose target is done".
// cancelled/blocked/ready targets are exempt so cleanup can never wedge. A
// non-tombstoned unsatisfied gate anchored to the work item blocks the move. The
// identical predicate runs on the verb (WORKSPACE_GATE_PENDING) and in replay
// (WORKSPACE_EVENT_CORRUPT), so a hand-tampered log cannot bypass the live check.
//
// TCRN-CROSS-MIN-102 裁定一: this counted `pending` alone, while GATE_TRANSITIONS
// lets a gate move pending↔blocked freely and without evidence. Flipping a gate to
// blocked therefore *released* the work item — two legal commands took an
// unsatisfied gate out of the way of done, in a state whose name says the opposite.
// The predicate is now "not satisfied", which is what a gate means: satisfied is
// the only state reached by citing resolving minutes, and it is terminal. The
// documented deadlock escape is unchanged and is still the tombstone route, not
// blocked. No gate on this platform has ever held blocked, so the reducer side of
// this tightening is retroactive over an empty set here; for a foreign chain that
// did use it, replay now refuses a work record that was driven to done past a
// blocked gate, which is the defect being named rather than a new rule.
function assertGateClearance(gates: Iterable<GateRecord>, workId: string, targetStatus: string, reasonCode: WorkspaceReasonCode): void {
  if (targetStatus !== "done") {
    return;
  }
  const candidates = [...gates];
  // CQ-10b: counted full scan of the gate collection. The early return above means
  // it runs only on a transition whose target is done, and done is terminal, so it
  // fires at most once per work record rather than once per work.updated.
  recordCollectionScan(candidates.length);
  const blocking = candidates
    .filter((gate) => !gate.tombstone && gate.status !== "satisfied" && gate.workId === workId)
    .map((gate) => gate.id)
    .sort(compareCanonicalText);
  if (blocking.length === 0) return;
  if (reasonCode !== "WORKSPACE_GATE_PENDING") {
    fail(reasonCode, `work ${workId} is blocked by pending gate(s) ${blocking.join(",")}`);
  }
  // TCRN-CROSS-STORY-489 (MIN-238 D4): on the verb the refusal names each gate and the one way it
  // is released, in Atelier (GATE_RELEASE_VERB); a migration never satisfies a gate by itself.
  throw new WorkspaceError(
    reasonCode,
    `work ${workId} is blocked by pending gate(s) ${blocking.join(",")}; each is released in Atelier with ${GATE_RELEASE_VERB} --id <gate> --reason <why>`,
    { workId, gates: blocking.join(","), remedy: `${GATE_RELEASE_VERB} --id ${blocking[0]} --reason <why>, in Atelier` },
  );
}

/**
 * Refuse, before anything else is checked or written, a move to done of any of `workIds` while a
 * gate that is not satisfied holds it (WORKSPACE_GATE_PENDING, naming the gates and how each is
 * released). The transition checks the same thing again as it writes; this lets a caller name the
 * gate before it weighs anything slower, such as the project's code gates (TCRN-CROSS-STORY-489).
 */
export function assertWorkGatesClear(state: Pick<WorkspaceState, "gates">, workIds: readonly string[]): void {
  for (const workId of workIds) assertGateClearance(state.gates, workId, "done", "WORKSPACE_GATE_PENDING");
}

// TCRN-CROSS-STORY-468 R5: in a merged replay an event that does not apply is undone, not fatal.
// The reducer's collections record what each event changes while a journal is open, so a
// rejected event's partial effects are rolled back before the next event is applied.
class ReplayJournal {
  entries: (() => void)[] | null = null;

  begin(): void {
    this.entries = [];
  }

  commit(): void {
    this.entries = null;
  }

  rollback(): void {
    const entries = this.entries ?? [];
    this.entries = null;
    for (let index = entries.length - 1; index >= 0; index -= 1) entries[index]?.();
  }
}

class JournaledMap<K, V> extends Map<K, V> {
  private journal: ReplayJournal | undefined;

  constructor(entries: Iterable<readonly [K, V]>, journal: ReplayJournal) {
    super(entries);
    this.journal = journal;
  }

  override set(key: K, value: V): this {
    const entries = this.journal?.entries;
    if (entries !== null && entries !== undefined) {
      const had = super.has(key);
      const previous = super.get(key);
      entries.push(() => {
        if (had) super.set(key, previous as V);
        else super.delete(key);
      });
    }
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    const entries = this.journal?.entries;
    if (entries !== null && entries !== undefined && super.has(key)) {
      const previous = super.get(key) as V;
      entries.push(() => {
        super.set(key, previous);
      });
    }
    return super.delete(key);
  }
}

interface ReplayOrigin {
  readonly deviceId: string;
  readonly streamId: string;
  readonly clock: number;
}

// The next free key after a collision: the numeric suffix counts up (keeping its width), and a key
// without one gains "-2", "-3", ... Deterministic, so every device renames the same way.
function nextFreeExternalKey(externalKey: string, taken: (candidate: string) => boolean): string {
  const match = /^(.*?)(\d+)$/u.exec(externalKey);
  for (let step = 1; ; step += 1) {
    const candidate = match === null
      ? `${externalKey}-${step + 1}`
      : `${match[1] ?? ""}${(BigInt(match[2] ?? "0") + BigInt(step)).toString().padStart((match[2] ?? "").length, "0")}`;
    if (!taken(candidate)) return candidate;
  }
}

// The merge's own state after a prefix of the merged events, as a cache snapshot keeps it.
interface MergeReplayCheckpoint {
  readonly rejected: readonly RejectedEvent[];
  readonly aliases: readonly KeyAlias[];
  readonly redirects: readonly { readonly streamId: string; readonly entries: readonly { readonly from: string; readonly id: string; readonly externalKey: string }[] }[];
  readonly reserved: readonly string[];
}

class MergeReplay {
  readonly rejected: RejectedEvent[] = [];
  readonly aliases: KeyAlias[] = [];
  private readonly origins: ReadonlyMap<EventRecord, ReplayOrigin>;
  // Per stream: an id that stream created under a key another device held first, and where the
  // record now lives. Only that stream's later events follow the redirect.
  private readonly redirects = new Map<string, Map<string, { readonly id: string; readonly externalKey: string }>>();
  private readonly reserved = new Set<string>();
  private pending: KeyAlias | null = null;

  constructor(origins: ReadonlyMap<EventRecord, ReplayOrigin>, resume?: MergeReplayCheckpoint) {
    this.origins = origins;
    if (resume !== undefined) {
      this.rejected.push(...resume.rejected);
      this.aliases.push(...resume.aliases);
      for (const stream of resume.redirects) {
        this.redirects.set(stream.streamId, new Map(stream.entries.map((entry) => [entry.from, { id: entry.id, externalKey: entry.externalKey }])));
      }
      for (const id of resume.reserved) this.reserved.add(id);
    }
  }

  /** The merge's state so far, for a snapshot to resume from. */
  checkpoint(): MergeReplayCheckpoint {
    return {
      rejected: [...this.rejected],
      aliases: [...this.aliases],
      redirects: [...this.redirects.entries()]
        .filter(([, entries]) => entries.size > 0)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([streamId, entries]) => ({
          streamId,
          entries: [...entries.entries()].sort(([left], [right]) => compareCanonicalText(left, right)).map(([from, target]) => ({ from, ...target })),
        })),
      reserved: [...this.reserved].sort(compareCanonicalText),
    };
  }

  origin(event: EventRecord): ReplayOrigin {
    const origin = this.origins.get(event);
    if (origin === undefined) fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} has no stream`);
    return origin;
  }

  /** The event as this merge applies it: a colliding create renamed, a renamed record's later events redirected. */
  view(event: EventRecord, projects: ReadonlyMap<string, ProjectRecord>, work: ReadonlyMap<string, WorkRecord>): EventRecord {
    this.pending = null;
    const payload = event.payload;
    if (!isJsonObject(payload) || typeof payload.operation !== "string" || !isJsonObject(payload.record)) return event;
    const kind = payload.operation.startsWith("work.") ? "work" : payload.operation.startsWith("project.") ? "project" : null;
    const source = payload.record;
    if (kind === null || typeof source.id !== "string") return event;
    const origin = this.origin(event);
    const redirects = this.redirects.get(origin.streamId) ?? new Map<string, { readonly id: string; readonly externalKey: string }>();
    this.redirects.set(origin.streamId, redirects);
    const existing: ReadonlyMap<string, unknown> = kind === "work" ? work : projects;
    const record: Record<string, JsonValue> = { ...source };
    let changed = false;
    if (payload.operation === `${kind}.created` && existing.has(source.id) && typeof source.externalKey === "string") {
      const aliasExternalKey = nextFreeExternalKey(source.externalKey, (candidate) => {
        const candidateId = deriveStableId(kind, candidate);
        return existing.has(candidateId) || this.reserved.has(candidateId);
      });
      const aliasId = deriveStableId(kind, aliasExternalKey);
      this.reserved.add(aliasId);
      redirects.set(source.id, { id: aliasId, externalKey: aliasExternalKey });
      this.pending = {
        kind,
        externalKey: source.externalKey,
        id: source.id,
        aliasExternalKey,
        aliasId,
        deviceId: origin.deviceId,
        streamId: origin.streamId,
        sequence: event.sequence,
      };
      record.id = aliasId;
      record.externalKey = aliasExternalKey;
      changed = true;
    } else {
      const target = redirects.get(source.id);
      if (target !== undefined) {
        record.id = target.id;
        record.externalKey = target.externalKey;
        changed = true;
      }
    }
    if (kind === "work") {
      for (const field of ["parentId", "projectId"]) {
        const value = record[field];
        const target = typeof value === "string" ? redirects.get(value) : undefined;
        if (target !== undefined) {
          record[field] = target.id;
          changed = true;
        }
      }
    }
    return changed ? { ...event, payload: { ...payload, record } } : event;
  }

  reject(event: EventRecord, viewed: EventRecord, error: unknown): void {
    const origin = this.origin(event);
    const payload = viewed.payload;
    const record = isJsonObject(payload) && isJsonObject(payload.record) ? payload.record : null;
    const recordId = [record?.id, record?.registrationId, record?.key].find((value) => typeof value === "string");
    this.rejected.push({
      eventId: event.id,
      streamId: origin.streamId,
      deviceId: origin.deviceId,
      sequence: event.sequence,
      clock: origin.clock,
      operation: isJsonObject(payload) && typeof payload.operation === "string" ? payload.operation : null,
      recordId: typeof recordId === "string" ? recordId : null,
      reasonCode: String((error as { reasonCode?: unknown }).reasonCode ?? "WORKSPACE_EVENT_CORRUPT"),
      detail: String((error as { message?: unknown }).message ?? error).slice(0, 512),
    });
  }

  settle(rejected: boolean): void {
    if (!rejected && this.pending !== null) this.aliases.push(this.pending);
    this.pending = null;
  }
}

function isReplayRejection(error: unknown): boolean {
  return error instanceof WorkspaceError || error instanceof ProtocolError;
}

function materialize(metadata: WorkspaceMetadata, events: readonly EventRecord[], snapshot?: ReplaySeed, merge?: MergeReplay): WorkspaceState {
  if (snapshot === undefined) {
    recordFullMaterialize();
  } else {
    recordSnapshotMaterialize();
  }
  const journal = merge === undefined ? null : new ReplayJournal();
  const collection = <K, V>(entries: Iterable<readonly [K, V]>): Map<K, V> => (journal === null ? new Map<K, V>(entries) : new JournaledMap<K, V>(entries, journal));
  const projects = collection<string, ProjectRecord>((snapshot?.projects ?? []).map((record) => [record.id, record]));
  const work = collection<string, WorkRecord>((snapshot?.work ?? []).map((record) => [record.id, record]));
  const conferences = collection<string, ConferenceRequest>((snapshot?.conferences ?? []).map((record) => [record.id, record]));
  const conferencePositions = collection<string, ConferencePosition>((snapshot?.conferencePositions ?? []).map((record) => [record.id, record]));
  const conferenceMinutes = collection<string, ConferenceMinutes>((snapshot?.conferenceMinutes ?? []).map((record) => [record.id, record]));
  const minutesRecords = collection<string, MinutesRecord>((snapshot?.minutes ?? []).map((record) => [record.id, record]));
  const gates = collection<string, GateRecord>((snapshot?.gates ?? []).map((record) => [record.id, record]));
  // TCRN-CROSS-INC-389 R2: a replay snapshot taken while a key was live still lists it after the key
  // retires, as a 1.1.0-1.2.0 snapshot listed fitness.windowDays. The device cache only reads a
  // snapshot its own engine version wrote, and the seed still drops retired keys, the rule the
  // settings.updated arm below applies on a replay from genesis, so both reads hold the same settings.
  // The convention is the one settings.ts states for RETIRED_SETTING_KEYS: historical events remain
  // legible without reopening new writes. TCRN-CROSS-STORY-484 R3: a renamed key's record in such a
  // snapshot seeds its new name, as the settings.updated arm does on a replay from genesis.
  // TCRN-CROSS-STORY-508 R2: and a models.tiers value from before the record table seeds as records.
  const settings = collection<string, WorkspaceSettingRecord>((snapshot?.settings ?? []).flatMap((record) => {
    if (!isRetiredSettingKey(record.key)) return [currentSettingRecord(record)];
    const successor = renamedSettingRecord(record);
    return successor === null ? [] : [successor];
  }).map((record) => [record.key, record]));
  let executionConfig: ExecutionConfigState = snapshot?.executionConfig ?? EMPTY_EXECUTION_CONFIG;
  const templates = collection<string, TemplateAdmissionRecord>((snapshot?.templates ?? []).map((record) => [record.registrationId, record]));
  const configRecords = collection<string, ConfigRecord>((snapshot?.configRecords ?? []).map((record) => [configRecordIdentity(record.collection, record.key), record]));
  const workspaceRoot = metadata.roots.find((root) => root.kind === "workspace")?.path;
  let attestationEnabledAtSequence: number | null = snapshot?.attestationEnabledAtSequence ?? null;
  for (const sourceEvent of events) {
    const event = merge === undefined ? sourceEvent : merge.view(sourceEvent, projects, work);
    const scalars = { executionConfig, attestationEnabledAtSequence };
    journal?.begin();
    let rejected = false;
    try {
    const payload = event.payload;
    if (!isJsonObject(payload) || typeof payload.operation !== "string") {
      fail("WORKSPACE_EVENT_CORRUPT", `event ${event.id} payload is invalid`);
    }
    // The operation is bound once so the string narrowing above survives into the
    // extension-record closures below, which re-read it.
    const operation: string = payload.operation;
    // WSE-2: the attestation.actor.enabled chain event turns mandatory actor
    // attestation on for itself and every later event; it is a control event that
    // touches no record graph, and a second one is a corrupt chain. Tracking it
    // inside the single event loop keeps validation one-pass and replay-order
    // exact — the enabling event carries the enabling actor and is the first that
    // requires one, so actorRequired is derived after this branch has run.
    if (operation === ACTOR_ATTESTATION_ENABLE_OPERATION) {
      if (attestationEnabledAtSequence !== null) {
        fail("WORKSPACE_EVENT_CORRUPT", "duplicate attestation.actor.enabled event");
      }
      const record = payloadRecord(payload, ACTOR_ATTESTATION_ENABLE_OPERATION, true);
      try {
        validateActorAttestationEnableRecord(record);
      } catch (error) {
        if (error instanceof ActorAttestationError) {
          fail("WORKSPACE_EVENT_CORRUPT", "attestation enable record is invalid");
        }
        throw error;
      }
      attestationEnabledAtSequence = event.sequence;
      continue;
    }
    const actorRequired = attestationEnabledAtSequence !== null;
    if (templateOperations.has(operation)) {
      const record = extensionRecordOrCorrupt(() => validateTemplateAdmissionRecord(
        payloadRecord(payload, operation, actorRequired),
      ));
      requireEventBoundTimestamp(record.receipt.admittedAt, event, `template ${record.template.id}@${record.template.version}`);
      const key = `${record.template.id}@${record.template.version}`;
      if (templates.has(key)) fail("WORKSPACE_EVENT_CORRUPT", `duplicate template admission ${key}`);
      templates.set(key, record);
      continue;
    }
    if (projectOperations.has(operation)) {
      const record = validateProject(payloadRecord(payload, operation, actorRequired));
      const current = projects.get(record.id);
      if (record.updatedAt !== event.occurredAt) {
        fail("WORKSPACE_EVENT_CORRUPT", `project ${record.id} timestamp is not event-bound`);
      }
      if (operation === "project.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid project create ${record.id}`);
        }
      } else if (!current || current.tombstone || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        (operation === "project.updated" && record.tombstone) || (operation === "project.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid project mutation ${record.id}`);
      }
      if (operation === "project.deleted") {
        // CQ-10b: counted full scan. Fires only on project.deleted, which is rare
        // and few in number, so its measured contribution is nil.
        recordCollectionScan(work.size);
        if ([...work.values()].some((entry) => entry.projectId === record.id && !entry.tombstone)) {
          fail("WORKSPACE_EVENT_CORRUPT", `project ${record.id} deletion precedes its live work`);
        }
      }
      projects.set(record.id, record);
      // WSA-2: a project event does not change the work graph; the only work->project
      // invariant it can break (a deleted project with live work) is checked above.
      continue;
    }
    if (workOperations.has(operation)) {
      const rawRecord = payloadRecord(payload, operation, actorRequired) as unknown as WorkRecord;
      const current = work.get(rawRecord.id);
      const record = resolveWorkRecord(rawRecord, current, "WORKSPACE_EVENT_CORRUPT");
      if (record.updatedAt !== event.occurredAt) {
        fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} timestamp is not event-bound`);
      }
      if (operation === "work.created") {
        if (current || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid work create ${record.id}`);
        }
        // The honest createWork writes no advisory extension, but a hand-crafted or
        // tail-appended work.created could plant a malformed advisory:* value that the
        // envelope-only terminal graph validator would admit while the annotate path
        // rejects the identical bytes. Re-run the advisory value-shape check here so
        // create and annotate enforce one invariant and no forged create can smuggle a
        // bad advisory value in through the one door that used to skip it.
        for (const key of ADVISORY_KEYS) {
          if (Object.hasOwn(record.extensions, key)) {
            if (key === ADVISORY_VERIFY_KEY) fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} verify command may only be written by work.annotated`);
            if (key === ADVISORY_EVIDENCE_KEY || key === ADVISORY_EVIDENCE_SNAPSHOT_KEY) {
              fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} completion evidence may only be written by a done transition`);
            }
            assertAdvisoryEntryShape(key, (record.extensions as Readonly<Record<string, unknown>>)[key], record.id, "WORKSPACE_EVENT_CORRUPT");
          }
        }
      } else if (!current || current.tombstone || record.revision !== current.revision + 1 || record.externalKey !== current.externalKey ||
        record.projectId !== current.projectId || record.kind !== current.kind || record.parentId !== current.parentId ||
        (operation === "work.updated" && record.tombstone) || (operation === "work.deleted" && !record.tombstone) ||
        (operation === "work.annotated" && record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid work mutation ${record.id}`);
      }
      if (operation === "work.updated" && current) {
        try {
          assertWorkTransition(current.status, record.status);
        } catch (error) {
          if (error instanceof ProtocolError) {
            fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
          }
          throw error;
        }
        // WSD-4 replay parity: the gate precondition the verb enforces is
        // re-checked against the gates materialized so far, so a hand-crafted log
        // that drives a work item to done past a pending gate fails closed.
        assertGateClearance(gates.values(), record.id, record.status, "WORKSPACE_EVENT_CORRUPT");
        assertWorkTransitionEvidence(current, record, "WORKSPACE_EVENT_CORRUPT");
      }
      // work.annotated (E05): not a transition -- status is unchanged and the only
      // extension delta is the advisory keys. Both invariants replay as
      // WORKSPACE_EVENT_CORRUPT so a hand-crafted annotation cannot smuggle a status
      // change or a foreign extension past the reducer.
      if (operation === "work.annotated" && current) {
        if (record.status !== current.status) {
          fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} annotation changed status`);
        }
        if (canonicalJson((current.extensions[ADVISORY_EVIDENCE_KEY] ?? null) as JsonValue) !== canonicalJson((record.extensions[ADVISORY_EVIDENCE_KEY] ?? null) as JsonValue) ||
          canonicalJson((current.extensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY] ?? null) as JsonValue) !== canonicalJson((record.extensions[ADVISORY_EVIDENCE_SNAPSHOT_KEY] ?? null) as JsonValue)) {
          fail("WORKSPACE_EVENT_CORRUPT", `work ${record.id} annotation changed completion evidence`);
        }
        assertWorkAnnotation(workAnnotationFields(current), workAnnotationFields(record), record.id, "WORKSPACE_EVENT_CORRUPT");
      }
      extensionRecordOrCorrupt(() => validateBoundTemplateWork(record, [...templates.values()]));
      work.set(record.id, record);
      validateWorkClosure(work, projects, record, templateRegistry([...templates.values()]));
      continue;
    }
    if (conferenceOperations.has(operation)) {
      // WSD-1: conference reducer arms. Every check here is a bounded lookup
      // against the maps materialized so far — O(delta) per event, and no
      // work-closure metrics (the closure counters stay work-only).
      // CQ-10b correction: the gate arm below is not scan-free. A gate.satisfied
      // transition copies the whole conference and minutes maps to resolve its
      // evidence; that copy is counted by recordCollectionScan.
      if (operation === "conference.created") {
        const record = extensionRecordOrCorrupt(() => openConference(payloadRecord(payload, operation, actorRequired)));
        requireEventBoundTimestamp(record.updatedAt, event, `conference ${record.id}`);
        if (conferences.has(record.id) || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid conference create ${record.id}`);
        }
        requireLiveProject(projects, record.projectId, `conference ${record.id}`);
        for (const workId of record.linkedWorkIds) {
          requireLiveWork(work, record.projectId, workId, `conference ${record.id}`);
        }
        recordExtensionClosureValidation(2 + record.linkedWorkIds.length);
        conferences.set(record.id, record);
        continue;
      }
      if (operation === "conference.updated") {
        const record = extensionRecordOrCorrupt(() => validateConferenceRequest(payloadRecord(payload, operation, actorRequired)));
        requireEventBoundTimestamp(record.updatedAt, event, `conference ${record.id}`);
        const current = requireOpenConference(conferences, record.id, `conference ${record.id}`);
        if (record.status !== "cancelled" || record.tombstone || record.revision !== current.revision + 1) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid conference mutation ${record.id}`);
        }
        assertPinnedExtensionFields(current as unknown as JsonValue, record as unknown as JsonValue, ["status", "revision", "updatedAt"], `conference ${record.id}`);
        recordExtensionClosureValidation(2);
        conferences.set(record.id, record);
        continue;
      }
      if (operation === "conference.position.appended") {
        const record = extensionRecordOrCorrupt(() => validateConferencePosition(payloadRecord(payload, operation, actorRequired)));
        requireEventBoundTimestamp(record.updatedAt, event, `conference position ${record.id}`);
        if (conferencePositions.has(record.id) || record.revision !== 1 || record.tombstone) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid conference position ${record.id}`);
        }
        const conference = requireOpenConference(conferences, record.conferenceId, `conference position ${record.id}`);
        if (record.projectId !== conference.projectId) {
          fail("WORKSPACE_EVENT_CORRUPT", `conference position ${record.id} is not bound to its conference project`);
        }
        recordExtensionClosureValidation(2);
        conferencePositions.set(record.id, record);
        continue;
      }
      const parts = closePayload(payload, actorRequired);
      const record = extensionRecordOrCorrupt(() => validateConferenceRequest(parts.record));
      const minutes = extensionRecordOrCorrupt(() => validateConferenceMinutes(parts.minutes));
      requireEventBoundTimestamp(record.updatedAt, event, `conference ${record.id}`);
      requireEventBoundTimestamp(minutes.updatedAt, event, `conference minutes ${minutes.id}`);
      const current = requireOpenConference(conferences, record.id, `conference ${record.id}`);
      if (record.status !== "closed" || record.tombstone || record.revision !== current.revision + 1) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid conference close ${record.id}`);
      }
      assertPinnedExtensionFields(current as unknown as JsonValue, record as unknown as JsonValue, ["status", "revision", "updatedAt"], `conference ${record.id}`);
      if (conferenceMinutes.has(minutes.id) || minutesRecords.has(minutes.id) || minutes.revision !== 1 || minutes.tombstone ||
        minutes.conferenceId !== record.id || minutes.projectId !== record.projectId) {
        fail("WORKSPACE_EVENT_CORRUPT", `conference minutes ${minutes.id} are not bound to the closing conference`);
      }
      recordExtensionClosureValidation(3);
      conferences.set(record.id, record);
      conferenceMinutes.set(minutes.id, minutes);
      continue;
    }
    if (minutesOperations.has(operation)) {
      // TCRN-CROSS-STORY-475 R1: one record, written once. Its id (the one its external key derives)
      // is new to the minutes a conference ever closed too, its project is live, and so is every
      // work record it links.
      const record = extensionRecordOrCorrupt(() => validateMinutesRecord(payloadRecord(payload, operation, actorRequired)));
      requireEventBoundTimestamp(record.recordedAt, event, `minutes ${record.id}`);
      if (minutesRecords.has(record.id) || conferenceMinutes.has(record.id)) {
        fail("WORKSPACE_EVENT_CORRUPT", `duplicate minutes ${record.id}`);
      }
      requireLiveProject(projects, record.projectId, `minutes ${record.id}`);
      for (const workId of record.linkedWorkIds) {
        requireLiveWork(work, record.projectId, workId, `minutes ${record.id}`);
      }
      recordExtensionClosureValidation(1 + record.linkedWorkIds.length);
      minutesRecords.set(record.id, record);
      continue;
    }
    if (gateOperations.has(operation)) {
      // WSD-1: gate reducer arms, O(delta) like the conference arms above.
      const record = extensionRecordOrCorrupt(() => validateGateRecord(payloadRecord(payload, operation, actorRequired)));
      requireEventBoundTimestamp(record.updatedAt, event, `gate ${record.id}`);
      if (operation === "gate.created") {
        if (gates.has(record.id) || record.revision !== 1 || record.tombstone || record.status !== "pending") {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid gate create ${record.id}`);
        }
        requireLiveProject(projects, record.projectId, `gate ${record.id}`);
        if (record.workId !== null) {
          requireLiveWork(work, record.projectId, record.workId, `gate ${record.id}`);
        }
        recordExtensionClosureValidation(2 + (record.workId === null ? 0 : 1));
        gates.set(record.id, record);
        continue;
      }
      const current = gates.get(record.id);
      if (!current || current.tombstone || record.revision !== current.revision + 1 ||
        (operation === "gate.updated" && record.tombstone) || (operation === "gate.deleted" && !record.tombstone)) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid gate mutation ${record.id}`);
      }
      // WSD-4: a gate.updated must walk the lifecycle graph, and a move to
      // satisfied must carry evidence that re-resolves here (parity with the
      // verb) and whose only extensions delta is the persisted locator entry.
      // gate.deleted keeps mutating tombstone alone; every other move pins
      // extensions, so a non-satisfied transition cannot smuggle in extensions.
      let gateMutableFields: readonly string[] = operation === "gate.updated" ? ["status", "revision", "updatedAt"] : ["tombstone", "revision", "updatedAt"];
      if (operation === "gate.updated") {
        if (!GATE_TRANSITIONS[current.status].includes(record.status)) {
          fail("WORKSPACE_EVENT_CORRUPT", `invalid gate transition ${record.id}`);
        }
        if (record.status === "satisfied" && record.extensions[GATE_RELEASE_KEY] !== undefined) {
          // TCRN-CROSS-STORY-489: released in Atelier rather than satisfied by resolving minutes;
          // who, when and why are checked from the event alone.
          const signer = payload !== null && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Readonly<Record<string, JsonValue>>).actor
            : undefined;
          assertGateReleaseReplay(current, record, signer);
          gateMutableFields = ["status", "revision", "updatedAt", "extensions"];
        } else if (record.status === "satisfied") {
          const locator = readGateEvidenceLocator(record.extensions);
          // CQ-10b: counted collection copy. Two full copies fed to array .find while
          // the Maps are in hand; runs once per gate-satisfied transition, and only
          // once a locator is present (the undefined case short-circuits before the
          // copies are built, so it must not be counted).
          if (locator !== undefined) {
            recordCollectionScan(conferenceMinutes.size + conferences.size);
          }
          if (locator === undefined || !resolveGateEvidence(locator, current, [...conferenceMinutes.values()], [...conferences.values()])) {
            fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} evidence does not resolve`);
          }
          // The identity entry is optional here and stays optional forever: replay has
          // no roster and cannot know whether one was required when this event was
          // written. What it can do without reading anything external is insist the
          // entry is well formed, and that the actor it names is the actor the event
          // was signed with -- a record that disagrees with itself is corrupt whoever
          // wrote it.
          let expectedExtensions = gateEvidenceExtensions(current.extensions, locator);
          const identityEntry = record.extensions[GATE_IDENTITY_KEY];
          if (identityEntry !== undefined) {
            const decision = extensionRecordOrCorrupt(() => validateGateIdentityDecision(
              (identityEntry as { readonly value?: unknown } | null)?.value,
            ));
            const signer = payload !== null && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Readonly<Record<string, JsonValue>>).actor
              : undefined;
            // Before attestation is enabled the payload carries no actor, so there is
            // nothing to contradict and the entry stands uncorroborated. That is worth
            // knowing rather than papering over: on such a chain the decision names an
            // actor the event itself does not, and only a deployment that enables
            // attestation gets the cross-check. Attestation stays a separate opt-in --
            // gating one irreversible setting behind another would be a worse trade.
            if (signer !== undefined && signer !== decision.actorId) {
              fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} identity decision names ${decision.actorId} but the event was signed by ${String(signer)}`);
            }
            expectedExtensions = gateIdentityExtensions(expectedExtensions, decision);
          }
          if (canonicalJson(record.extensions) !== canonicalJson(expectedExtensions)) {
            fail("WORKSPACE_EVENT_CORRUPT", `gate ${record.id} evidence extensions are not exact`);
          }
          gateMutableFields = ["status", "revision", "updatedAt", "extensions"];
        }
      }
      assertPinnedExtensionFields(
        current as unknown as JsonValue,
        record as unknown as JsonValue,
        gateMutableFields,
        `gate ${record.id}`,
      );
      recordExtensionClosureValidation(2);
      gates.set(record.id, record);
      continue;
    }
    if (settingsOperations.has(operation)) {
      const body = payloadRecord(payload, operation, actorRequired);
      if (operation === "settings.removed") {
        exactFields(body, ["key", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "setting removal record");
        if (typeof body.key !== "string" || typeof body.updatedAt !== "string") fail("WORKSPACE_EVENT_CORRUPT", "setting removal record is invalid");
        try { assertStrictInstant(body.updatedAt); } catch { fail("WORKSPACE_EVENT_CORRUPT", "setting removal timestamp is invalid"); }
        requireEventBoundTimestamp(body.updatedAt, event, `setting ${body.key}`);
        // TCRN-CROSS-INC-389 R1: the removal of a retired key is history, read like the settings.updated
        // records for it below. The envelope checks above still apply; the current settings are neither
        // consulted nor changed, since they never hold a retired key. A chain that set and then removed
        // fitness.windowDays under 1.1.0-1.2.0 was valid there and stays readable (settings.ts, on
        // RETIRED_SETTING_KEYS: historical events remain legible without reopening new writes). A live
        // key removed while unset is still a corrupt chain.
        if (isRetiredSettingKey(body.key)) {
          // TCRN-CROSS-STORY-484 R3: removing a renamed key removed the value its new name carries.
          const successorKey = renamedSettingKey(body.key);
          if (successorKey !== undefined) settings.delete(successorKey);
          continue;
        }
        const current = settings.get(body.key);
        if (current === undefined) fail("WORKSPACE_EVENT_CORRUPT", `cannot remove unknown setting ${body.key}`);
        settings.delete(body.key);
        continue;
      }
      if (isRetiredSettingKey(body.key)) {
        // Historical settings.updated records for retired keys remain readable,
        // but their values must never become current state or pass the live
        // catalog/value validator. Preserve only the common event-bound envelope
        // checks needed to distinguish a valid legacy record from corruption.
        exactFields(body, ["key", "layerKind", "revision", "schemaVersion", "tombstone", "updatedAt", "value"], "WORKSPACE_EVENT_CORRUPT", "retired setting record");
        if (typeof body.updatedAt !== "string") fail("WORKSPACE_EVENT_CORRUPT", "retired setting timestamp is invalid");
        try { assertStrictInstant(body.updatedAt); } catch { fail("WORKSPACE_EVENT_CORRUPT", "retired setting timestamp is invalid"); }
        requireEventBoundTimestamp(body.updatedAt, event, `setting ${body.key}`);
        // TCRN-CROSS-STORY-484 R3: a renamed key's value is its new name's value, converted
        // (execution.dispatchTiers carries over as models.tiers), until a write of the new name.
        const successor = renamedSettingRecord({ key: body.key, value: body.value, revision: body.revision, updatedAt: body.updatedAt });
        if (successor !== null) settings.set(successor.key, successor);
        continue;
      }
      // TCRN-CROSS-STORY-508 R2: a value whose shape has since changed is read in the current shape
      // (a per-host models.tiers value as records), and the event keeps its bytes. Replay checks each
      // value's shape and no reference between models.category and models.tiers: that is the write's.
      const record = extensionRecordOrCorrupt(() => readRecordedSettingRecord(
        body,
        workspaceRoot,
      ));
      requireEventBoundTimestamp(record.updatedAt, event, `setting ${record.key}`);
      const current = settings.get(record.key);
      // TCRN-CROSS-STORY-469 R2 (MIN-227 D13): in a library a project-level setting is the last
      // write in merge order. A device that set a key without having seen another device's write
      // to it carries a revision that no longer follows, and its write still takes effect, so
      // every device reads the value the later clock wrote. One writer's chain (an old-layout
      // workspace) keeps the strict revision sequence.
      const revisionFollows = merge !== undefined ||
        (current === undefined ? record.revision === 1 : record.revision === current.revision + 1);
      if (!revisionFollows || record.layerKind !== SETTINGS_LAYER_KIND || record.tombstone !== false) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid setting mutation ${record.key}`);
      }
      settings.set(record.key, record);
      continue;
    }
    if (isConfigRecordOperation(operation)) {
      // TCRN-CROSS-STORY-478 R1 (SUB-315): a project-level configuration record. Merge order is
      // clock, then device id, so the set applied last is the later writer's, on every device.
      // Removing a key the merged state does not hold (another device removed it first) is
      // rejected like any event that no longer applies. Only a library carries these events.
      if (merge === undefined) fail("WORKSPACE_EVENT_CORRUPT", `${operation} is a library operation; an old-layout workspace has none`);
      const body = payloadRecord(payload, operation, actorRequired);
      try {
        const change = readConfigRecordEvent(operation, body);
        const identity = configRecordIdentity(change.collection, change.key);
        if (change.value === undefined) {
          if (!configRecords.has(identity)) throw new ConfigRecordError("CONFIG_RECORD_NOT_FOUND", `${change.collection} ${change.key} is not set`);
          configRecords.delete(identity);
        } else {
          configRecords.set(identity, { collection: change.collection, key: change.key, value: change.value });
        }
      } catch (error) {
        if (error instanceof ConfigRecordError) fail("WORKSPACE_EVENT_CORRUPT", `${error.reasonCode}:${error.message}`);
        throw error;
      }
      continue;
    }
    if (executionOperations.has(operation)) {
      // INIT-026 S232: replay reuses the same apply functions the write path
      // used, so referential integrity is re-proved on every materialize; an
      // event sequence that violates it is a corrupt chain, not a soft state.
      const body = payloadRecord(payload, operation, actorRequired) as Record<string, unknown>;
      try {
        if (operation === "execution.persona.set") {
          const applied = body.schemaVersion === "tcrn.persona.v1"
            ? applyLegacyCustomPersonaSet(executionConfig, {
                schemaVersion: body.schemaVersion,
                id: body.id,
                name: body.name,
                description: body.description,
                role: body.role,
                prompt: body.prompt,
                revision: body.revision,
                updatedAt: String(body.updatedAt),
                tombstone: body.tombstone,
              })
            : applyCustomPersonaSet(executionConfig, {
                name: body.name,
                role: body.role,
                jobTitle: body.jobTitle,
                mission: body.mission,
                refusals: body.refusals,
                authorityBoundary: body.authorityBoundary,
                contactWhen: body.contactWhen,
                requiredInputs: body.requiredInputs,
                deliverables: body.deliverables,
                successCriteria: body.successCriteria,
                updatedAt: String(body.updatedAt),
              });
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona ${String(body.name)}`);
          if (body.schemaVersion !== "tcrn.persona.v1" && canonicalJson(applied.record) !== canonicalJson(body)) fail("WORKSPACE_EVENT_CORRUPT", `persona ${applied.record.id} mutation record is not canonical`);
          executionConfig = applied.state;
        } else if (operation === "execution.persona.removed") {
          exactFields(body, ["name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "persona removal record");
          if (typeof body.updatedAt !== "string") fail("WORKSPACE_EVENT_CORRUPT", "persona removal timestamp is invalid");
          requireEventBoundTimestamp(body.updatedAt, event, `persona ${String(body.name)}`);
          executionConfig = applyCustomPersonaRemove(executionConfig, { name: body.name });
        } else if (operation === "execution.model-plan.set") {
          const applied = applyModelPlanSetInExecutionConfig(executionConfig, {
            host: body.host,
            name: body.name,
            defaultModel: body.defaultModel,
            // STORY-282: replay has to carry every field the write carried, or the
            // reconstructed record differs from the stored body and the canonical
            // comparison below refuses the event as corrupt.
            ...(body.defaultEffort === undefined ? {} : { defaultEffort: body.defaultEffort }),
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan ${String(body.name)}`);
          if (canonicalJson(applied.record) !== canonicalJson(body)) fail("WORKSPACE_EVENT_CORRUPT", `model plan ${String(body.name)} mutation record is not canonical`);
          executionConfig = applied.state;
        } else if (operation === "execution.model-plan.assigned") {
          const applied = applyModelPlanAssignInExecutionConfig(executionConfig, {
            host: body.host,
            name: body.name,
            persona: body.persona,
            model: body.model,
            ...(body.effort === undefined ? {} : { effort: body.effort }),
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan assignment ${String(body.persona)}`);
          const canonicalBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "persona" && key !== "model" && key !== "effort"));
          if (canonicalJson(applied.record) !== canonicalJson(canonicalBody as unknown as JsonValue)) fail("WORKSPACE_EVENT_CORRUPT", "model plan assignment record is not canonical");
          executionConfig = applied.state;
        } else if (operation === "execution.model-plan.unassigned") {
          const applied = applyModelPlanUnassignInExecutionConfig(executionConfig, {
            host: body.host,
            name: body.name,
            persona: body.persona,
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan unassignment ${String(body.persona)}`);
          const canonicalBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "persona"));
          if (canonicalJson(applied.record) !== canonicalJson(canonicalBody as unknown as JsonValue)) fail("WORKSPACE_EVENT_CORRUPT", "model plan unassignment record is not canonical");
          executionConfig = applied.state;
        } else if (operation === "execution.model-plan.removed") {
          exactFields(body, ["host", "name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "model plan removal record");
          requireEventBoundTimestamp(String(body.updatedAt), event, `model plan ${String(body.name)}`);
          executionConfig = applyModelPlanRemoveInExecutionConfig(executionConfig, { host: body.host, name: body.name });
        } else if (operation === `${legacyPresetOperation}.override`) {
          const applied = applyPersonaPresetOverrideInExecutionConfig(executionConfig, {
            name: body.name,
            fields: body.fields as Readonly<Record<string, unknown>>,
            updatedAt: String(body.updatedAt),
          });
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona preset ${String(body.name)}`);
          if (canonicalJson(applied.record) !== canonicalJson(body)) fail("WORKSPACE_EVENT_CORRUPT", "persona preset override is not canonical");
          executionConfig = applied.state;
        } else if (operation === `${legacyPresetOperation}.restore`) {
          exactFields(body, ["field", "name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "persona preset restore record");
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona preset ${String(body.name)}`);
          executionConfig = applyPersonaPresetRestoreInExecutionConfig(executionConfig, { name: body.name, field: body.field, updatedAt: String(body.updatedAt) });
        } else if (operation === `${legacyPresetOperation}.removed`) {
          exactFields(body, ["name", "updatedAt"], "WORKSPACE_EVENT_CORRUPT", "persona preset removal record");
          requireEventBoundTimestamp(String(body.updatedAt), event, `persona preset ${String(body.name)}`);
          executionConfig = applyPersonaPresetRemoveInExecutionConfig(executionConfig, { name: body.name });
        } else if (operation === "execution.configuration.set") {
          executionConfig = applyHostConfigSet(executionConfig, {
            host: body.host as ExecutionHost,
            name: validateConfigurationName(body.name),
            model: validateModel(body.model),
            note: validateNote(body.note),
            updatedAt: String(body.updatedAt),
          }).state;
        } else if (operation === "execution.configuration.removed") {
          executionConfig = applyHostConfigRemove(executionConfig, { host: body.host as ExecutionHost, name: validateConfigurationName(body.name) });
        } else if (operation === "execution.default.set") {
          executionConfig = applyHostConfigDefault(executionConfig, {
            host: body.host as ExecutionHost,
            configurationName: body.configurationName === null ? null : validateConfigurationName(body.configurationName),
            updatedAt: String(body.updatedAt),
          });
        } else if (operation === "execution.binding.set") {
          executionConfig = applyPersonaBindingSet(executionConfig, {
            profileId: String(body.profileId),
            host: body.host as ExecutionHost,
            configurationName: validateConfigurationName(body.configurationName),
            updatedAt: String(body.updatedAt),
          });
        } else {
          executionConfig = applyPersonaBindingRemove(executionConfig, { profileId: String(body.profileId), host: body.host as ExecutionHost });
        }
      } catch (error) {
        fail("WORKSPACE_EVENT_CORRUPT", `invalid execution mutation: ${String((error as Error).message ?? error)}`);
      }
      continue;
    }
    fail("WORKSPACE_EVENT_CORRUPT", `unknown operation ${operation}`);
    } catch (error) {
      if (merge === undefined || journal === null || !isReplayRejection(error)) throw error;
      rejected = true;
      journal.rollback();
      executionConfig = scalars.executionConfig;
      attestationEnabledAtSequence = scalars.attestationEnabledAtSequence;
      merge.reject(sourceEvent, event, error);
    } finally {
      journal?.commit();
      merge?.settle(rejected);
    }
  }
  const projectRecords = [...projects.values()].sort((left, right) => compareCanonicalText(left.id, right.id));
  recordTerminalGraphValidation();
  const templateRecords = [...templates.values()].sort((left, right) => compareCanonicalText(left.registrationId, right.registrationId));
  const workRecords = validateWorkGraph([...work.values()], templateRegistry(templateRecords));
  const settingRecords = sortWorkspaceSettings(settings.values());
  const engineRequirement = settingRecords.find((record) => record.key === "engine.requiredVersion");
  if (engineRequirement !== undefined && compareEngineVersions(FRAMEWORK_VERSION, engineRequirement.value) < 0) {
    throw new WorkspaceError(
      "WORKSPACE_ENGINE_VERSION_MISMATCH",
      `workspace requires engine version ${engineRequirement.value}; current engine version is ${FRAMEWORK_VERSION}`,
      { required: engineRequirement.value, actual: FRAMEWORK_VERSION },
    );
  }
  return {
    metadata,
    version: snapshot === undefined ? events.length : snapshot.version + events.length,
    headEventHash: events.at(-1)?.eventHash ?? snapshot?.prefixEvents.at(-1)?.eventHash ?? null,
    projects: projectRecords,
    work: workRecords,
    conferences: sortExtensionRecords(conferences.values()),
    conferencePositions: sortExtensionRecords(conferencePositions.values()),
    conferenceMinutes: sortExtensionRecords(conferenceMinutes.values()),
    minutes: sortExtensionRecords(minutesRecords.values()),
    gates: sortExtensionRecords(gates.values()),
    settings: settingRecords,
    executionConfig,
    templates: templateRecords,
    configRecords: sortConfigRecords(configRecords.values()),
    events: snapshot === undefined ? events : [...snapshot.prefixEvents, ...events],
    attestationEnabledAtSequence,
  };
}

// INC-198: a view may not grow without bound. Both the graph digest and the index
// used to canonicalise the whole record set in one value, and `canonicalJson`
// refuses past one MiB — so a workspace that simply accumulated enough governed
// prose stopped being readable at all, because every read verifies its views. The
// cross-project chain crossed that line at 611 records (1.55 MiB canonical, 48%
// over) and could no longer validate, list, show, or export.
//
// Both replacements keep full detection power while staying linear in record
// count rather than in prose length. The digest hashes each record first and then
// hashes the vector of hashes: any byte that changes inside any record still
// changes the result. The index keeps every record's identity and status verbatim
// and carries each extension as the digest of its value — the extension's content
// is not lost, because views are derived and rebuildable and no read path sources
// prose from here (reads materialise from the event log). `.v2` marks the shape.
function digestedExtensions(extensions: WorkRecord["extensions"]): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const key of Object.keys(extensions).sort(compareCanonicalText)) {
    digests[key] = canonicalSha256(extensions[key]);
  }
  return digests;
}

// STORY-299. Hash each record, then hash the vector of hashes: any byte that
// changes inside any record still changes the result, and so does reordering two
// records, because the vector is not sorted or deduplicated. Unlike the shape
// above, the result does not grow with the collection -- which is the whole point.
//
// This is the single place the collection-summary shape is written. The work index
// still uses the per-record shape (STORY-302 carries that ceiling); when it moves,
// it moves by calling this, not by growing a second copy of the idea.
function collectionDigest(records: readonly unknown[]): string {
  return canonicalSha256(records.map((record) => canonicalSha256(record)));
}

// STORY-299. Measure, then serialise -- never the other way round. `canonicalJson`
// fails closed at the ceiling, so asking it first turns "this view is 40 KB over
// budget" into a bare refusal carrying no number, and turns the capacity meter
// into something that stops reading exactly when it matters.
function canonicalViewDocument(name: string, value: unknown, budgetBytes: number): string {
  const bytes = canonicalByteLength(value);
  if (bytes > budgetBytes) {
    fail("WORKSPACE_VIEW_BUDGET_EXCEEDED", `${name} projects to ${bytes} bytes against a ${budgetBytes} byte budget`);
  }
  return canonicalJson(value);
}

function summarisedCollection(records: readonly unknown[]): { readonly count: number; readonly digest: string } {
  return { count: records.length, digest: collectionDigest(records) };
}

// STORY-299. One writing of the view shapes, two readers of it: the projection
// below serialises them and enforces the budget, and the meter reports their size
// without enforcing anything. Keeping them apart is what lets `status` still
// answer on a workspace that has crossed the ceiling -- a gauge built out of the
// failing path would go silent exactly when it is needed.
type ViewSource =
  | { readonly name: string; readonly text: string }
  | { readonly name: string; readonly value: unknown };

function viewSources(state: WorkspaceState): readonly ViewSource[] {
  const activeProjects = state.projects.filter((record) => !record.tombstone);
  const activeWork = state.work.filter((record) => !record.tombstone);
  const graphDigest = canonicalSha256({
    projects: activeProjects.map((record) => canonicalSha256(record)),
    work: activeWork.map((record) => canonicalSha256(record)),
  });
  const readback = {
    schemaVersion: "tcrn.workspace-readback.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projectCount: activeProjects.length,
    workCount: activeWork.length,
    graphDigest,
    authority: "derived-rebuildable",
  };
  const status = [
    "# Workspace Status",
    "",
    `- Workspace: \`${state.metadata.workspaceId}\``,
    `- Version: ${state.version}`,
    `- Projects: ${activeProjects.length}`,
    `- Work records: ${activeWork.length}`,
    `- Graph digest: \`${graphDigest}\``,
    "- Authority: derived and rebuildable from the event chain",
    "",
  ].join("\n");
  const sources: ViewSource[] = [
    { name: "STATUS.md", text: status },
    {
      name: "index.json",
      value: {
        schemaVersion: "tcrn.workspace-index.v2",
        projects: activeProjects,
        work: activeWork.map((record) => ({ ...record, extensions: digestedExtensions(record.extensions) })),
      },
    },
    { name: "readback.json", value: readback },
  ];
  // WSD-1: the extension index is a fourth view emitted ONLY when the workspace
  // holds at least one conference or gate record (positions and minutes cannot
  // exist without their conference), so the three views above and the view set
  // stay byte-identical for every workspace without extension records. STORY-299
  // does not touch that condition: the view set stays four, so no view is ever
  // orphaned and no deletion mechanism is owed.
  if (state.conferences.length + state.gates.length + state.settings.length + state.templates.length + state.minutes.length > 0) {
    // STORY-299: v2 is a fixed-length verification summary, not an index. v1 carried
    // every conference, position, minutes and gate record whole, so the file grew with
    // the governed prose written into the chain and crossed the one MiB canonical
    // ceiling at 532 records (INC-198), taking eight read verbs down with it.
    //
    // The shape deliberately does NOT copy what 0.11.17 did to the work index. That
    // fix keeps each record's identity and status verbatim and digests only the
    // extension bag, which removes the prose term but keeps the per-record one -- it
    // is linear, and measurement puts its own ceiling eight weeks out (STORY-302).
    // Applied literally here it would not even help: extension-record prose lives in
    // first-class fields rather than in an extension bag, so digesting the bag alone
    // grows this file by 537 bytes on the cross-project chain. What is copied is the
    // method -- hash each record, hash the vector, bump the schema version, keep no
    // compatibility read path -- not the target.
    //
    // Every collection follows the same rule, settings and templates included. An
    // exception for a collection that happens to be small today is how the linear
    // term comes back the day one of its fields grows.
    //
    // Nothing is lost: views are derived and rebuildable, no code anywhere parses
    // this file (its only readers are the byte-equality check in validateWorkspace
    // and an opaque copy in migration), and the prose is served from replay through
    // conference-position-list and conference-minutes-list. What is given up is
    // browsing identities by opening the file, which the helper payload already
    // advises against.
    const collections: Record<string, { readonly count: number; readonly digest: string }> = {
      conferences: summarisedCollection(state.conferences),
      conferencePositions: summarisedCollection(state.conferencePositions),
      conferenceMinutes: summarisedCollection(state.conferenceMinutes),
      gates: summarisedCollection(state.gates),
      ...(state.settings.length === 0 ? {} : { settings: summarisedCollection(state.settings) }),
      ...(state.templates.length === 0 ? {} : { templates: summarisedCollection(state.templates) }),
      // TCRN-CROSS-STORY-475: present only when there are minutes, so every other view stays byte-identical.
      ...(state.minutes.length === 0 ? {} : { minutes: summarisedCollection(state.minutes) }),
    };
    const digestsOnly: Record<string, string> = {};
    for (const key of Object.keys(collections).sort(compareCanonicalText)) {
      digestsOnly[key] = collections[key]?.digest ?? "";
    }
    sources.push({
      name: "extensions.json",
      value: {
        schemaVersion: "tcrn.workspace-extension-index.v2",
        ...collections,
        extensionsDigest: canonicalSha256(digestsOnly),
      },
    });
  }
  return sources;
}

/**
 * The derived views of a state (STATUS.md, index.json, readback.json, extensions.json), as
 * canonical text. They are projections, never an authority: a library does not store them, and
 * the device cache keeps them (TCRN-CROSS-STORY-469 R4).
 */
export function workspaceViewDocuments(state: WorkspaceState): Readonly<Record<string, string>> {
  return viewDocuments(state);
}

function viewDocuments(state: WorkspaceState, budgetBytes: number = PROTOCOL_LIMITS.maxCanonicalBytes): Readonly<Record<string, string>> {
  const documents: Record<string, string> = {};
  for (const source of viewSources(state)) {
    if ("text" in source) {
      if (Buffer.byteLength(source.text, "utf8") > budgetBytes) {
        fail("WORKSPACE_VIEW_BUDGET_EXCEEDED", `${source.name} projects past a ${budgetBytes} byte budget`);
      }
      documents[source.name] = source.text;
      continue;
    }
    documents[source.name] = canonicalViewDocument(source.name, source.value, budgetBytes);
  }
  return documents;
}

export interface WorkspaceBudgetReport {
  readonly views: readonly {
    readonly name: string;
    readonly bytes: number;
    readonly limitBytes: number;
    readonly headroomBytes: number;
  }[];
  readonly maxSegmentBytes: number;
  readonly events: { readonly count: number; readonly limit: number; readonly headroomEvents: number };
}

/**
 * What is left before each ceiling, reported rather than judged.
 *
 * Every number here was a wall someone hit without warning first: the view ceiling
 * that locked eight read verbs (INC-198), the segment ceiling, and the record cap
 * -- which is the hardest of the three, because it is checked inside materialize
 * and so takes `status` and `recover` down with it rather than merely refusing
 * writes. Names only, never a host path.
 */
export function workspaceBudgets(state: WorkspaceState): WorkspaceBudgetReport {
  const limitBytes = PROTOCOL_LIMITS.maxCanonicalBytes;
  const views = viewSources(state).map((source) => {
    const bytes = "text" in source ? Buffer.byteLength(source.text, "utf8") : canonicalByteLength(source.value);
    return { name: source.name, bytes, limitBytes, headroomBytes: limitBytes - bytes };
  });
  let maxSegmentBytes = 0;
  if (state.metadata.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION) {
    const segmentLimit = state.metadata.segmentEventLimit;
    for (let start = 0; start < state.events.length; start += segmentLimit) {
      const bytes = canonicalByteLength(state.events.slice(start, start + segmentLimit));
      if (bytes > maxSegmentBytes) maxSegmentBytes = bytes;
    }
  } else {
    const segmentLimit = segmentBytesForState(state);
    let segmentBytes = 0;
    let segmentEvents = 0;
    for (const event of state.events) {
      const eventBytes = Buffer.byteLength(canonicalJson(event), "utf8");
      if (segmentEvents > 0 && segmentBytes + eventBytes > segmentLimit) {
        if (segmentBytes > maxSegmentBytes) maxSegmentBytes = segmentBytes;
        segmentBytes = 0;
        segmentEvents = 0;
      }
      segmentBytes += eventBytes;
      segmentEvents += 1;
    }
    if (segmentBytes > maxSegmentBytes) maxSegmentBytes = segmentBytes;
  }
  return {
    views,
    maxSegmentBytes,
    // TCRN-CROSS-STORY-451: the limit the chain is actually held to, which is also the
    // ceiling platform-doctor's chainHeadroom reports.
    events: {
      count: state.events.length,
      limit: PROTOCOL_LIMITS.maxChainEvents,
      headroomEvents: PROTOCOL_LIMITS.maxChainEvents - state.events.length,
    },
  };
}

// TCRN-CROSS-STORY-467 R1 (MIN-227 D3): one writer at a time on this machine, through the
// engine-held lock of the library in the device directory. A writer takes the lock, reads the
// latest merged state under it, builds its delta against that state and appends to its own
// stream; a second writer waits instead of failing a version comparison, so two concurrent
// writes both land, in order. A holder that died leaves a lock the next writer breaks. Writers
// on different devices never share a file, so they need no lock between them.

// The lock is re-entrant within one async flow: a verb that holds it for a whole
// read-append-follow-up sequence (the CLI does, so its before/after reads and the knowledge
// rebind cannot interleave with another writer) calls write functions that take it again.
const heldWriteLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `operation` as this machine's only writer of the library, holding the library's lock in
 * the device directory (TCRN-CROSS-STORY-467 R1, 469 R3). An old-layout workspace refuses.
 */
export async function withWorkspaceWriteLock<T>(
  workspaceRootInput: string,
  operation: (workspaceRoot: string) => Promise<T>,
): Promise<T> {
  const layout = await resolveLayout(workspaceRootInput);
  if (layout.kind === "legacy") return refuseLegacyWrite(layout.root);
  await refuseTombstonedWrite(layout.root);
  const held = heldWriteLocks.getStore() ?? new Set<string>();
  if (held.has(layout.root)) return operation(layout.root);
  try {
    return await withLibraryWriteLock(
      layout.library,
      () => heldWriteLocks.run(new Set([...held, layout.root]), () => operation(layout.root)),
    );
  } catch (error) {
    if (error instanceof FileLockError && error.reasonCode === "FILE_LOCK_TIMEOUT") {
      fail("WORKSPACE_LOCKED", "another writer on this machine holds the library write lock");
    }
    throw error;
  }
}

// WSR-1 relocation kit. Three narrow functions the relocation verbs need and that
// no other caller should reach for. They are exported rather than duplicated
// because the alternative — a second metadata reader and a second atomic writer in
// workspace-relocation.ts — would put the platform's single most load-bearing
// read/write pair in two places, and the drift would be silent.

// TCRN-CROSS-STORY-469 (MIN-227 D19, D21): the engine writes libraries only. A path names either
// a library (it holds manifest.json) or an old-layout workspace (it holds the old control
// directory). An old-layout workspace opens read-only: its reads replay the old chain from
// genesis without writing anything, and every write refuses with LEGACY_WORKSPACE_READ_ONLY,
// pointing at library-import-legacy. The five explicit roots are no longer part of opening.
type WorkspaceLayout =
  | { readonly kind: "library"; readonly root: string; readonly library: Library }
  | { readonly kind: "legacy"; readonly root: string };

async function resolveLayout(workspaceRootInput: string): Promise<WorkspaceLayout> {
  // TCRN-CROSS-STORY-470 R2, AC5: a library given through a symbolic link opens at its real path.
  const root = await boundDirectory(await realLibraryPath(workspaceRootInput));
  if (await hasLibraryManifest(root)) return { kind: "library", root, library: await openLibrary(root) };
  if (await legacyControlDirectory(root) !== null) return { kind: "legacy", root };
  throw new WorkspaceError("LIBRARY_NOT_FOUND", `${root} holds neither a library nor an old-layout workspace`, { workspace: root });
}

// TCRN-CROSS-STORY-470 R3: a relocated library leaves TOMBSTONE.json in its old place. It still
// reads, and every write there refuses and names where the library went.
export const LIBRARY_TOMBSTONE_FILE = "TOMBSTONE.json" as const;
export const LIBRARY_TOMBSTONE_SCHEMA_VERSION = "einzbern.tombstone.v1" as const;

export interface LibraryTombstone {
  readonly schemaVersion: typeof LIBRARY_TOMBSTONE_SCHEMA_VERSION;
  readonly libraryId: string;
  readonly movedTo: string;
  readonly movedAt: string;
}

/** The tombstone a relocation left at a library root, or null when there is none. */
export async function readLibraryTombstone(root: string): Promise<LibraryTombstone | null> {
  let text: string;
  try {
    text = await readFile(join(root, LIBRARY_TOMBSTONE_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
  // A tombstone that does not parse still marks the place as vacated; it just cannot say where to.
  return {
    schemaVersion: LIBRARY_TOMBSTONE_SCHEMA_VERSION,
    libraryId: typeof record.libraryId === "string" ? record.libraryId : "",
    movedTo: typeof record.movedTo === "string" ? record.movedTo : "",
    movedAt: typeof record.movedAt === "string" ? record.movedAt : "",
  };
}

async function refuseTombstonedWrite(root: string): Promise<void> {
  const tombstone = await readLibraryTombstone(root);
  if (tombstone === null) return;
  throw new WorkspaceError(
    "LIBRARY_TOMBSTONED",
    `${root} was relocated to ${tombstone.movedTo || "an unrecorded place"} at ${tombstone.movedAt || "an unrecorded time"}; it opens read-only`,
    { workspace: root, movedTo: tombstone.movedTo, remedy: `--workspace ${tombstone.movedTo}` },
  );
}

// TCRN-CROSS-STORY-489 R4 (TCRN-CROSS-SUB-365): an old-layout workspace that setup --mode migrate
// moved into a library is refused with that library, which this device's registry names: the
// entry whose migratedFrom is this old workspace is its tombstone, and nothing is written into the
// old workspace itself. Without one, or with a registry that does not read, the write is refused
// as before; either way nothing is written.
async function refuseLegacyWrite(root: string): Promise<never> {
  let movedTo: string | null = null;
  try {
    movedTo = (await findMigratedEntry(root))?.libraryPath ?? null;
  } catch (error) {
    if (typeof (error as { reasonCode?: unknown }).reasonCode !== "string") throw error;
  }
  if (movedTo !== null) {
    throw new WorkspaceError(
      "LEGACY_WORKSPACE_MIGRATED",
      `${root} is an old-layout workspace this device migrated into the library at ${movedTo}; it opens read-only, and writes go to the library`,
      { workspace: root, layout: "legacy", movedTo, remedy: `--workspace ${movedTo}` },
    );
  }
  throw new WorkspaceError(
    "LEGACY_WORKSPACE_READ_ONLY",
    `${root} is an old-layout workspace and opens read-only; import it into a library with library-import-legacy`,
    { workspace: root, layout: "legacy", remedy: "library-import-legacy" },
  );
}

async function materializeLayout(layout: WorkspaceLayout, options: LibraryReadOptions = {}): Promise<WorkspaceState> {
  return layout.kind === "library"
    ? materializeLibrary(layout.library, options)
    : replayLegacyWorkspace(await openLegacyWorkspace(layout.root));
}

/** The current state of a library, merged from every stream, or of an old-layout workspace, read-only. */
export async function materializeWorkspace(workspaceRootInput: string): Promise<WorkspaceState> {
  return materializeLayout(await resolveLayout(workspaceRootInput));
}

/** The state replayed from genesis, without this device's cache: what validation compares against. */
export async function materializeWorkspaceFromGenesis(workspaceRootInput: string): Promise<WorkspaceState> {
  const layout = await resolveLayout(workspaceRootInput);
  return layout.kind === "library"
    ? materializeLibraryRead(layout.library, await readAllStreams(layout.library.root))
    : replayLegacyWorkspace(await openLegacyWorkspace(layout.root));
}

export interface InitializeLibraryOptions {
  readonly root: string;
  readonly createdAt: string;
  readonly projectName?: string | null;
  readonly gitRemote?: string | null;
  readonly libraryId?: string;
}

/** Create a library (TCRN-CROSS-STORY-469 R1) and return its empty state. */
export async function initializeLibrary(options: InitializeLibraryOptions): Promise<WorkspaceState> {
  assertStrictInstant(options.createdAt);
  const library = await createLibrary(options.root, {
    createdAt: options.createdAt,
    ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
    ...(options.gitRemote === undefined ? {} : { gitRemote: options.gitRemote }),
    ...(options.libraryId === undefined ? {} : { libraryId: options.libraryId }),
  });
  return materializeLibrary(library);
}

// TCRN-CROSS-STORY-468 R4, STORY-469: a library's metadata in the shape the reducer reads. A
// library has no roots to bind and no external key of its own; its id is the workspace id
// every record and receipt reports.
export const LIBRARY_HEAD_SCHEMA_VERSION = "einzbern.library-head.v1" as const;

export function libraryWorkspaceMetadata(library: Library): WorkspaceMetadata {
  const identity = library.manifest.libraryId.slice(library.manifest.libraryId.indexOf(":") + 1);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    storageVersion: WORKSPACE_STORAGE_VERSION,
    minimumStorageVersion: 1,
    maximumStorageVersion: WORKSPACE_STORAGE_VERSION,
    workspaceId: library.manifest.libraryId,
    externalKey: `LIBRARY-${identity.toUpperCase()}`,
    createdAt: library.manifest.createdAt,
    segmentEventLimit: AKASHA_SEGMENT_BYTES_DEFAULT,
    roots: [{ kind: "workspace", path: library.root, canonicalPath: library.root, portableIdentity: rootPortableIdentity(library.root) }],
  };
}

/** A library's head: one digest over every stream's head, so it moves whenever any stream does. */
export function libraryHeadDigest(streams: readonly Pick<LibraryStreamHead, "deviceId" | "headEventHash">[]): string | null {
  const heads = streams
    .filter((stream) => stream.headEventHash !== null)
    .map((stream) => [stream.deviceId, stream.headEventHash as string])
    .sort((left, right) => compareCanonicalText(left[0] as string, right[0] as string));
  return heads.length === 0 ? null : canonicalSha256({ schemaVersion: LIBRARY_HEAD_SCHEMA_VERSION, heads });
}

function streamHead(manifest: StreamManifest): LibraryStreamHead {
  return {
    deviceId: manifest.deviceId,
    streamId: manifest.streamId,
    displayName: manifest.displayName,
    identityScheme: manifest.identityScheme,
    sequence: manifest.sequence,
    headEventHash: manifest.headEventHash,
    clockHighWater: manifest.clockHighWater,
    engineVersion: manifest.engineVersion,
    formatVersion: manifest.formatVersion,
  };
}

type LibraryReadShape = { readonly streams: readonly { readonly manifest: StreamManifest | null }[]; readonly events: readonly MergedEvent[]; readonly versionVector: Readonly<Record<string, number>> };

// A seed read back from this device's cache, with the merge state it resumes.
interface LibrarySeed {
  readonly seed: ReplaySeed;
  readonly merge: MergeReplayCheckpoint;
}

interface LibraryReplayResult {
  readonly state: WorkspaceState;
  readonly merge: MergeReplay;
}

/**
 * Replay a library's merged events (TCRN-CROSS-STORY-468 R3-R5): from genesis, or from a seed
 * that covers a prefix of them. Streams were validated structurally when they were read; here
 * an event that does not apply to the merged state is rejected, and a create whose key another
 * device held first is renamed with an alias. The result does not depend on which device
 * merges: the order and the renaming are both deterministic.
 */
function replayLibrary(library: Library, read: LibraryReadShape, cached?: LibrarySeed): LibraryReplayResult {
  const tail = cached === undefined ? read.events : read.events.slice(cached.seed.version);
  const origins = new Map<EventRecord, ReplayOrigin>(tail.map((entry) => [entry.event, { deviceId: entry.deviceId, streamId: entry.streamId, clock: entry.clock }]));
  const merge = new MergeReplay(origins, cached?.merge);
  const state = materialize(libraryWorkspaceMetadata(library), tail.map((entry) => entry.event), cached?.seed, merge);
  const streams = read.streams.flatMap((stream) => (stream.manifest === null ? [] : [streamHead(stream.manifest)]));
  return {
    state: {
      ...state,
      headEventHash: libraryHeadDigest(streams),
      library: {
        libraryRoot: library.root,
        versionVector: read.versionVector,
        streams,
        rejectedEvents: merge.rejected,
        aliases: merge.aliases,
      },
    },
    merge,
  };
}

/** Replay a library's merged events from genesis, without this device's cache. */
export function materializeLibraryRead(library: Library, read: LibraryReadShape): WorkspaceState {
  return replayLibrary(library, read).state;
}

// TCRN-CROSS-STORY-469 R4: the replay state a cache snapshot keeps, serialised as the engine holds
// it. Only the engine version that wrote it reads it back.
interface LibrarySnapshotState {
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  readonly conferences: readonly ConferenceRequest[];
  readonly conferencePositions: readonly ConferencePosition[];
  readonly conferenceMinutes: readonly ConferenceMinutes[];
  readonly minutes: readonly MinutesRecord[];
  readonly gates: readonly GateRecord[];
  readonly settings: readonly WorkspaceSettingRecord[];
  readonly executionConfig: ExecutionConfigState;
  readonly templates: readonly TemplateAdmissionRecord[];
  readonly configRecords: readonly ConfigRecord[];
  readonly attestationEnabledAtSequence: number | null;
  readonly merge: MergeReplayCheckpoint;
}

// A snapshot without one of these collections (one written before it existed) is not a seed.
const SNAPSHOT_COLLECTIONS = ["projects", "work", "conferences", "conferencePositions", "conferenceMinutes", "minutes", "gates", "settings", "templates", "configRecords"] as const;

function snapshotState(value: unknown): LibrarySnapshotState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (SNAPSHOT_COLLECTIONS.some((name) => !Array.isArray(record[name]))) return null;
  if (record.executionConfig === null || typeof record.executionConfig !== "object" || Array.isArray(record.executionConfig)) return null;
  if (!(record.attestationEnabledAtSequence === null || Number.isSafeInteger(record.attestationEnabledAtSequence))) return null;
  const merge = record.merge as Readonly<Record<string, unknown>> | null | undefined;
  if (merge === null || typeof merge !== "object" || Array.isArray(merge)) return null;
  if (!["rejected", "aliases", "redirects", "reserved"].every((name) => Array.isArray(merge[name]))) return null;
  return value as LibrarySnapshotState;
}

/**
 * The seed a snapshot gives this read, or null when it does not describe a prefix of it: the
 * snapshot's engine differs, a stream it covers no longer holds the event it recorded at its
 * sequence, or an event it does not cover would sort inside it (another device's late event
 * with a clock at or below the snapshot's largest). Covered events are then exactly the first
 * `version` merged events, and the replay resumes after them.
 */
function seedFromSnapshot(snapshot: CacheSnapshot, read: LibraryRead): LibrarySeed | null {
  if (snapshot.engineVersion !== FRAMEWORK_VERSION) return null;
  const streams = new Map(read.streams.map((stream) => [stream.deviceId, stream]));
  const covered = new Map<string, number>();
  for (const recorded of snapshot.streams) {
    const stream = streams.get(recorded.deviceId);
    const event = stream?.events[recorded.sequence - 1];
    if (stream?.manifest?.streamId !== recorded.streamId || event === undefined || event.sequence !== recorded.sequence || event.eventHash !== recorded.eventHash) {
      return null;
    }
    covered.set(recorded.deviceId, recorded.sequence);
  }
  let prefix = 0;
  for (const [index, entry] of read.events.entries()) {
    if (entry.event.sequence <= (covered.get(entry.deviceId) ?? 0)) {
      if (index !== prefix) return null;
      prefix += 1;
    } else if (entry.clock <= snapshot.maxClock) {
      return null;
    }
  }
  if (prefix !== snapshot.version) return null;
  const state = snapshotState(snapshot.state);
  if (state === null) return null;
  const { merge, ...collections } = state;
  return { seed: { version: prefix, ...collections, prefixEvents: read.events.slice(0, prefix).map((entry) => entry.event) }, merge };
}

// The snapshot interval: storage.snapshotEveryEvents, or its catalog default.
function snapshotInterval(state: WorkspaceState): number {
  const configured = Number(state.settings.find((entry) => entry.key === "storage.snapshotEveryEvents")?.value ?? SETTINGS_CATALOG.find((entry) => entry.key === "storage.snapshotEveryEvents")?.defaultValue);
  return Number.isSafeInteger(configured) && configured >= 1 ? configured : 512;
}

async function cachedSeed(library: Library, read: LibraryRead): Promise<LibrarySeed | null> {
  try {
    const snapshot = await readCacheSnapshot(library.manifest.libraryId);
    if (snapshot === null) return null;
    const seeded = seedFromSnapshot(snapshot, read);
    if (seeded === null) await discardCacheSnapshot(library.manifest.libraryId);
    return seeded;
  } catch {
    return null;
  }
}

/**
 * Bring this device's cache of the library up to a replay: the view documents when they were
 * projected from another head or engine, and a new snapshot once the replay has gone
 * storage.snapshotEveryEvents events past the one it resumed from. The cache is derived, so a
 * failure to write it is left to the next read, except where the caller asked for it (recover).
 */
async function refreshLibraryCache(
  library: Library,
  read: LibraryRead,
  replay: LibraryReplayResult,
  seededVersion: number | null,
  options: { readonly force?: boolean; readonly strict?: boolean } = {},
): Promise<void> {
  const libraryId = library.manifest.libraryId;
  try {
    const stamp: CacheViewStamp = {
      schemaVersion: CACHE_VIEWS_SCHEMA_VERSION,
      engineVersion: FRAMEWORK_VERSION,
      headEventHash: replay.state.headEventHash,
      version: replay.state.version,
    };
    if (options.force === true || !sameViewStamp(await readCacheViewStamp(libraryId), stamp)) {
      await writeCacheViews(libraryId, viewDocuments(replay.state), stamp);
    }
    const due = replay.state.version - (seededVersion ?? 0) >= snapshotInterval(replay.state);
    if (replay.state.version > 0 && (options.force === true || due)) {
      await writeCacheSnapshot({
        libraryId,
        engineVersion: FRAMEWORK_VERSION,
        version: replay.state.version,
        maxClock: read.events.reduce((largest, entry) => Math.max(largest, entry.clock), 0),
        streams: read.streams.flatMap((stream) => (stream.manifest === null || stream.manifest.sequence === 0 || stream.manifest.headEventHash === null
          ? []
          : [{ deviceId: stream.deviceId, streamId: stream.manifest.streamId, sequence: stream.manifest.sequence, eventHash: stream.manifest.headEventHash }])),
        state: {
          projects: replay.state.projects,
          work: replay.state.work,
          conferences: replay.state.conferences,
          conferencePositions: replay.state.conferencePositions,
          conferenceMinutes: replay.state.conferenceMinutes,
          minutes: replay.state.minutes,
          gates: replay.state.gates,
          settings: replay.state.settings,
          executionConfig: replay.state.executionConfig,
          templates: replay.state.templates,
          configRecords: replay.state.configRecords,
          attestationEnabledAtSequence: replay.state.attestationEnabledAtSequence,
          merge: replay.merge.checkpoint(),
        } satisfies LibrarySnapshotState,
      });
    }
  } catch (error) {
    if (options.strict === true) throw error;
  }
}

/**
 * Replay a library through this device's cache (TCRN-CROSS-STORY-469 R4): resume from the
 * snapshot when it describes a prefix of what was read, otherwise from genesis, then refresh the
 * cache. A seed the rest of the events cannot be replayed onto is a cache fault, and the replay
 * starts again from genesis; the result is the same state either way.
 */
async function replayLibraryThroughCache(library: Library, read: LibraryRead): Promise<WorkspaceState> {
  const cached = await cachedSeed(library, read);
  let replay: LibraryReplayResult | null = null;
  if (cached !== null) {
    try {
      replay = replayLibrary(library, read, cached);
    } catch {
      replay = null;
    }
  }
  const seededVersion = replay === null ? null : cached?.seed.version ?? null;
  replay ??= replayLibrary(library, read);
  await refreshLibraryCache(library, read, replay, seededVersion);
  return replay.state;
}

/** Read every stream of a library and replay them merged, through this device's cache. */
export async function materializeLibrary(libraryOrRoot: Library | string, options: LibraryReadOptions = {}): Promise<WorkspaceState> {
  const library = typeof libraryOrRoot === "string" ? await openLibrary(libraryOrRoot) : libraryOrRoot;
  return replayLibraryThroughCache(library, await readAllStreams(library.root, options));
}

/** The keys a record was renamed from, and the records renamed away from its key (TCRN-CROSS-STORY-468 R5). */
export function recordAliases(state: WorkspaceState, id: string): { readonly aliases: readonly KeyAlias[]; readonly aliasedBy: readonly KeyAlias[] } {
  const aliases = state.library?.aliases ?? [];
  return {
    aliases: aliases.filter((entry) => entry.aliasId === id),
    aliasedBy: aliases.filter((entry) => entry.id === id),
  };
}

// TCRN-CROSS-STORY-466 R2 / STORY-467 R4: the read-only faces the old-layout reader
// (legacy-workspace.ts) needs. Each wraps the same function the engine itself uses, so
// the reader parses metadata, binds event identities and replays exactly as a write
// path would; none of them takes a lease, reads a view or touches the filesystem.

/** Parse `workspace.json` bytes against the closed metadata shape, without any address admission. */
export function parseLegacyWorkspaceMetadata(text: string): WorkspaceMetadata {
  try {
    return validateMetadata(assertCanonicalJson(text));
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error instanceof ProtocolError) fail("WORKSPACE_SCHEMA_INVALID", error.message);
    fail("WORKSPACE_SCHEMA_INVALID", String(error));
  }
}

/** The stream id an old-layout workspace binds every event to. */
export function legacyWorkspaceStreamId(metadata: WorkspaceMetadata): string {
  return workspaceStreamId(metadata);
}

/** The event id an old-layout workspace binds to a sequence of its stream. */
export function legacyWorkspaceEventId(streamId: string, sequence: number): string {
  return workspaceEventId(streamId, sequence);
}

/** Replay already-read events from genesis through the engine's own reducer. Pure. */
export function materializeFromGenesis(metadata: WorkspaceMetadata, events: readonly EventRecord[]): WorkspaceState {
  return materialize(metadata, events);
}

/**
 * Validate by replaying: every stream (or the old chain) is checked structurally and replayed.
 * Views are derived and no longer an authority to compare against.
 */
/**
 * The state the read verbs validate and answer from: every stream read and checked, merged
 * through this device's cache (TCRN-CROSS-STORY-469 R4). chain-validate and
 * materializeWorkspaceFromGenesis replay from genesis instead.
 */
export async function validateWorkspace(workspaceRootInput: string): Promise<WorkspaceState> {
  return materializeWorkspace(workspaceRootInput);
}

// WSA-1: a mutation builder validates its input against the claim-fresh state and
// returns both the event payload and the already-validated next-state record sets.
// projects must be id-sorted and work must be validateWorkGraph output so the
// constructed committed state is byte-identical to a fresh materialize.
export interface MutationDelta {
  readonly payload: JsonValue;
  readonly projects: readonly ProjectRecord[];
  readonly work: readonly WorkRecord[];
  // WSD-1: extension collections flow through the delta additively; a builder
  // that leaves one undefined keeps the claim-fresh state's collection, so the
  // constructed committed state stays byte-identical to a fresh materialize.
  readonly conferences?: readonly ConferenceRequest[];
  readonly conferencePositions?: readonly ConferencePosition[];
  readonly conferenceMinutes?: readonly ConferenceMinutes[];
  readonly minutes?: readonly MinutesRecord[];
  readonly gates?: readonly GateRecord[];
  readonly settings?: readonly WorkspaceSettingRecord[];
  readonly executionConfig?: ExecutionConfigState;
  readonly templates?: readonly TemplateAdmissionRecord[];
  readonly configRecords?: readonly ConfigRecord[];
}

function segmentBytesForState(state: WorkspaceState): number {
  if (state.metadata.storageVersion === WORKSPACE_LEGACY_STORAGE_VERSION) {
    return state.metadata.segmentEventLimit;
  }
  const configured = state.settings.find((entry) => entry.key === "storage.segmentBytes")?.value;
  const value = configured === undefined ? state.metadata.segmentEventLimit : Number(configured);
  if (!Number.isSafeInteger(value) || value < WORKSPACE_SEGMENT_BYTES_MIN || value > WORKSPACE_SEGMENT_BYTES_MAX) {
    fail("WORKSPACE_SCHEMA_INVALID", "storage.segmentBytes is outside its declared bounds");
  }
  return value;
}

// STORY-300. One append and many appends are the same operation with a different
// count, so there is one implementation of it and `appendEvent` is the N=1 case.
//
// That framing is the point rather than a tidiness preference. A separate batch
// path would be a road only batches travel: it would rot quietly, because every
// existing verb -- all thirty-two of them -- would keep exercising the other one.
// Written this way, a defect in the batch path is a defect in every single write,
// which is the only arrangement that keeps both honest.
function committedFrom(
  prior: WorkspaceState,
  delta: MutationDelta,
  event: EventRecord,
  isEnableEvent: boolean,
  events: readonly EventRecord[],
): WorkspaceState {
  return {
    metadata: prior.metadata,
    version: event.sequence,
    headEventHash: event.eventHash,
    projects: delta.projects,
    work: delta.work,
    conferences: delta.conferences ?? prior.conferences,
    conferencePositions: delta.conferencePositions ?? prior.conferencePositions,
    conferenceMinutes: delta.conferenceMinutes ?? prior.conferenceMinutes,
    minutes: delta.minutes ?? prior.minutes,
    gates: delta.gates ?? prior.gates,
    settings: delta.settings ?? prior.settings,
    executionConfig: delta.executionConfig ?? prior.executionConfig,
    templates: delta.templates ?? prior.templates,
    configRecords: delta.configRecords ?? prior.configRecords,
    events,
    attestationEnabledAtSequence: isEnableEvent ? event.sequence : prior.attestationEnabledAtSequence,
  };
}

// TCRN-CROSS-STORY-469 (MIN-227 D20): a write in a library, under this machine's lock of it.
// The merged state is read under the lock, every delta is built against it, and the events go
// to this device's own stream with the next sequences and clocks one above the largest clock
// this machine has seen, so they sort after everything the writer saw. An old-layout workspace
// refuses in withWorkspaceWriteLock.
export async function appendEvents(
  workspaceRootInput: string,
  buildDeltas: readonly ((state: WorkspaceState) => MutationDelta)[],
  options: WorkspaceMutationOptions,
): Promise<WorkspaceState> {
  assertStrictInstant(options.occurredAt);
  if (buildDeltas.length === 0) {
    fail("WORKSPACE_INPUT_INVALID", "an append carries at least one event");
  }
  return withWorkspaceWriteLock(workspaceRootInput, async (root) => {
    await options.insideWriteLockForTest?.();
    const library = await openLibrary(root);
    const { device } = await readOrCreateDevice();
    // WSA-1: the single full replay per mutation, read under the lock, so the state every
    // delta is built against is the latest one this machine has, and a batch is one mutation:
    // one lock, one replay.
    const read = await readAllStreams(library.root);
    const state = await replayLibraryThroughCache(library, read);
    const own = read.streams.find((stream) => stream.deviceId === device.deviceId)?.manifest ?? emptyStreamManifest(library, device);
    const clockBase = Math.max(own.clockHighWater, ...read.streams.map((stream) => stream.manifest?.clockHighWater ?? 0));
    const appended: EventRecord[] = [];
    let current = state;
    for (const [memberIndex, buildDelta] of buildDeltas.entries()) {
      // STORY-300 slice 3: the member index and phase ride on a refusal, attached rather than
      // substituted, so a batch caller learns which member failed and at which step.
      let phase: "delta" | "actor" | "event" = "delta";
      try {
      // Each member sees the state the members before it produced, which is what makes an
      // ordered batch express a dependency.
      const delta = buildDelta(current);
      // WSE-2: once attestation is enabled (or on the enabling event itself) a valid actor is
      // mandatory and joins the hashed payload; before it, no actor is written. The reducer
      // re-derives the boundary and enforces the same rule on replay.
      phase = "actor";
      const deltaPayload = delta.payload;
      const isEnableEvent = isJsonObject(deltaPayload) && deltaPayload.operation === ACTOR_ATTESTATION_ENABLE_OPERATION;
      const actorRequired = current.attestationEnabledAtSequence !== null || isEnableEvent;
      let payload: JsonValue = deltaPayload;
      if (actorRequired) {
        if (options.actorId === undefined) {
          fail("WORKSPACE_ACTOR_REQUIRED", "a valid actor is mandatory once attestation is enabled");
        }
        try {
          assertActorId(options.actorId);
        } catch (error) {
          if (error instanceof ActorAttestationError) {
            fail("WORKSPACE_ACTOR_INVALID", options.actorId);
          }
          throw error;
        }
        payload = { ...(deltaPayload as Readonly<Record<string, JsonValue>>), actor: options.actorId };
      }
      phase = "event";
      const sequence = own.sequence + memberIndex + 1;
      const event = createEvent({
        id: streamEventId(own, sequence),
        streamId: own.streamId,
        sequence,
        clock: clockBase + memberIndex + 1,
        deviceId: own.deviceId,
        occurredAt: options.occurredAt,
        priorHash: appended.at(-1)?.eventHash ?? own.headEventHash,
        payload,
      }, EVENT_SCHEMA_VERSION);
      appended.push(event);
      current = committedFrom(current, delta, event, isEnableEvent, [...state.events, ...appended]);
      } catch (error) {
        Object.assign(error as object, { memberIndex, memberPhase: phase });
        throw error;
      }
    }
    assertWorkspaceRecordCount(state.version + buildDeltas.length);
    // STORY-299: the view projection is measured before a byte is written, so a projection
    // over budget is a clean refusal with nothing appended.
    viewDocuments(current, options.viewBudgetBytes ?? PROTOCOL_LIMITS.maxCanonicalBytes);
    crash("before-write", options.crashAt);
    const committed = await appendStreamEvents(library, own, appended, { segmentBytes: segmentBytesForState(current) });
    crash("after-event-commit", options.crashAt);
    const streams = [...(state.library?.streams ?? []).filter((stream) => stream.deviceId !== device.deviceId), streamHead(committed)]
      .sort((left, right) => compareCanonicalText(left.deviceId, right.deviceId));
    return {
      ...current,
      version: state.version + appended.length,
      headEventHash: libraryHeadDigest(streams),
      library: {
        libraryRoot: library.root,
        versionVector: { ...(state.library?.versionVector ?? {}), [device.deviceId]: committed.sequence },
        streams,
        rejectedEvents: state.library?.rejectedEvents ?? [],
        aliases: state.library?.aliases ?? [],
      },
    };
  });
}

// TCRN-CROSS-STORY-467 R1: the records a write touched, for the receipt every mutating
// verb returns: each event after the first `sinceVersion` events of the state contributes its
// record id (and a closed conference its minutes id), in append order, without repeats.
export function writtenRecordIds(state: WorkspaceState, sinceVersion: number): readonly string[] {
  const ids: string[] = [];
  for (const event of state.events.slice(sinceVersion)) {
    if (!isJsonObject(event.payload)) continue;
    const operation = event.payload.operation;
    if (typeof operation === "string" && isConfigRecordOperation(operation)) {
      if (isJsonObject(event.payload.record)) {
        const { collection, key } = event.payload.record;
        if (typeof collection === "string" && isConfigRecordCollection(collection) && typeof key === "string") {
          const id = configRecordId(collection, key);
          if (!ids.includes(id)) ids.push(id);
        }
      }
      continue;
    }
    for (const key of ["record", "minutes"]) {
      const value = event.payload[key];
      if (!isJsonObject(value)) continue;
      // A record names itself by id; a template admission by its registration id and a
      // setting by its key, which is the identity its receipt reports as recordId.
      const identity = [value.id, value.registrationId, value.key].find((candidate) => typeof candidate === "string");
      if (typeof identity === "string" && !ids.includes(identity)) ids.push(identity);
    }
  }
  return ids;
}

async function appendEvent(workspaceRootInput: string, buildDelta: (state: WorkspaceState) => MutationDelta, options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvents(workspaceRootInput, [buildDelta], options);
}

function sortedProjects(records: readonly ProjectRecord[]): readonly ProjectRecord[] {
  return [...records].sort((left, right) => compareCanonicalText(left.id, right.id));
}

function projectById(state: WorkspaceState, id: string): ProjectRecord {
  const record = state.projects.find((entry) => entry.id === id);
  if (!record || record.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `project ${id} is unavailable`);
  }
  return record;
}

function workById(state: WorkspaceState, id: string): WorkRecord {
  const record = state.work.find((entry) => entry.id === id);
  if (!record || record.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `work ${id} is unavailable`);
  }
  return record;
}

export async function createProject(workspaceRoot: string, input: {
  readonly externalKey: string;
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("project", externalKey);
  return appendEvent(workspaceRoot, (state) => {
    if (state.projects.some((record) => record.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `project ${id} already exists`);
    }
    const record = validateProject({
      schemaVersion: "tcrn.project.v1",
      id,
      externalKey,
      name: input.name,
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
    }, "WORKSPACE_INPUT_INVALID");
    return { payload: { operation: "project.created", record: projectJsonFields(record) }, projects: sortedProjects([...state.projects, record]), work: state.work };
  }, input);
}

export async function updateProject(workspaceRoot: string, input: {
  readonly id: string;
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const current = projectById(state, input.id);
    const record = validateProject(
      { ...current, name: input.name, revision: current.revision + 1, updatedAt: input.occurredAt },
      "WORKSPACE_INPUT_INVALID",
    );
    return { payload: { operation: "project.updated", record: projectJsonFields(record) }, projects: sortedProjects(state.projects.map((entry) => entry.id === record.id ? record : entry)), work: state.work };
  }, input);
}

export async function deleteProject(workspaceRoot: string, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const current = projectById(state, input.id);
    if (state.work.some((record) => record.projectId === current.id && !record.tombstone)) {
      fail("WORKSPACE_INPUT_INVALID", `project ${current.id} still owns live work`);
    }
    const record = { ...current, revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
    return { payload: { operation: "project.deleted", record: projectJsonFields(record) }, projects: sortedProjects(state.projects.map((entry) => entry.id === record.id ? record : entry)), work: state.work };
  }, input);
}

// STORY-300 slice 3: createWork's delta, exposed so a batch can compose it. createWork
// already did all its validation inside the closure, so unlike transitionWork nothing
// moves -- this only gives the batch a handle on what the single verb already ran.
export function createWorkDelta(input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly relations?: WorkRelationsInput;
  readonly goal?: string;
  readonly acceptance?: string;
  readonly body?: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly templateAdmission?: unknown;
  readonly occurredAt: string;
}): (state: WorkspaceState) => MutationDelta {
  return (state) => createWorkReducerDelta(state, input);
}

export async function createWork(workspaceRoot: string, input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly relations?: WorkRelationsInput;
  readonly goal?: string;
  readonly acceptance?: string;
  readonly body?: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly templateAdmission?: unknown;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => createWorkReducerDelta(state, input), input);
}

function createWorkReducerDelta(state: WorkspaceState, input: {
  readonly projectId: string;
  readonly externalKey: string;
  readonly kind: WorkKind;
  readonly parentId: string | null;
  readonly status?: WorkStatus;
  readonly scope?: string;
  readonly decidedBy?: readonly string[];
  readonly relations?: WorkRelationsInput;
  readonly goal?: string;
  readonly acceptance?: string;
  readonly body?: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly labels?: readonly string[];
  readonly templateAdmission?: unknown;
  readonly occurredAt: string;
}): MutationDelta {
  // TCRN-CROSS-STORY-472 R1: refused on the write path only. Replay and validateWorkGraph keep
  // accepting the historical kinds, so every chain that holds one still reads.
  if (RETIRED_WORK_KINDS.includes(input.kind)) {
    throw new WorkspaceError(
      "WORK_KIND_RETIRED",
      `a new ${input.kind} is no longer created: ${WORK_KIND_RETIRED_REMEDY}`,
      { kind: input.kind, remedy: WORK_KIND_RETIRED_REMEDY },
    );
  }
  const externalKey = canonicalExternalKey(input.externalKey);
  const id = deriveStableId("work", externalKey);
  {
    projectById(state, input.projectId);
    if (state.work.some((record) => record.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `work ${id} already exists`);
    }
    // WSA-3 (write-path admission, create side): a `done` Initiative may not
    // acquire a NEW live child. transitionWork already refuses to close an
    // Initiative that still holds live work; without this mirror the same
    // invariant is enforced only at the closing instant, so re-opening the
    // subtree afterwards is a create away and "done" stops meaning "finished".
    // Like its transition-side twin this lives in the reducer — the write path's
    // input validation — and NOT in validateWorkGraph, which replay runs over
    // every historical event and which therefore fail-closes chains that legally
    // closed an Initiative before the rule existed (TCRN-AOS-INC-048).
    if (input.parentId !== null) {
      const parent = state.work.find((record) => record.id === input.parentId);
      const status = input.status ?? "planned";
      if (parent && parent.kind === "Initiative" && parent.status === "done" && !parent.tombstone
        && status !== "done" && status !== "cancelled") {
        fail("WORKSPACE_INPUT_INVALID",
          `cannot add live work under Initiative ${parent.id}: it is already done`);
      }
    }
    validateWorkAdvisoryInput(input, id, "WORKSPACE_INPUT_INVALID");
    const relations = workRelationsForWrite(state, id, input);
    const title = normalizeWorkTitle(input.title);
    const labels = normalizeWorkLabels(input.labels ?? []);
    // TCRN-CROSS-STORY-363, STORY-473. An explicit --summary wins; otherwise the first
    // sentence of the goal -- the goal field, or the Goal block of the scope -- which is
    // where the author already wrote the one-line answer. A record with neither carries
    // summary: null rather than no field, so every record born after this change has one shape.
    const summary = input.summary === undefined
      ? summarizeGoal(input.goal ?? deriveStoryFieldsFromScope(input.scope).goal, WORK_SUMMARY_MAX_BYTES)
      : normalizeWorkSummary(input.summary);
    const templateReceipt = input.templateAdmission === undefined
      ? undefined
      : validateTemplateAdmissionReceipt(input.templateAdmission);
    const templateRecord = templateReceipt === undefined
      ? undefined
      : templateRecordForBinding(state.templates, templateBindingFromReceipt(templateReceipt));
    if (templateReceipt !== undefined && (templateRecord === undefined || !templateRecordMatchesBinding(templateRecord, templateBindingFromReceipt(templateReceipt)))) {
      throw new TemplateAdmissionError("TEMPLATE_UNKNOWN", `${templateReceipt.templateId}@${templateReceipt.templateVersion}`);
    }
    if (templateRecord !== undefined && !templateRecord.template.appliesTo.includes(input.kind)) {
      throw new TemplateAdmissionError("TEMPLATE_NOT_APPLICABLE", `${templateRecord.template.id}:${input.kind}`);
    }
    const extensions: Record<string, unknown> = workAdvisoryExtensions({}, input, relations);
    if (templateReceipt !== undefined && templateRecord !== undefined) {
      extensions[templateRecord.registrationId] = { required: true, value: templateBindingFromReceipt(templateReceipt) };
    }
    const record: WorkRecord = {
      schemaVersion: "tcrn.work.v1",
      id,
      externalKey,
      projectId: input.projectId,
      kind: input.kind,
      parentId: input.parentId,
      status: input.status ?? "planned",
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: extensions as WorkRecord["extensions"],
      scopeDigest: workExtensionsDigest(extensions),
      title,
      createdAt: input.occurredAt,
      labels,
      summary,
    };
    // TCRN-CROSS-STORY-473 R1, R2: a Story is checked for its goal and its acceptance and
    // nothing else, bound to a template or not; the ten-block contract is gone.
    assertStoryFields(record);
    validateBoundTemplateWork(record, state.templates);
    assertStoryCompletionAdmission(record, record.status);
    const work = validateWorkGraph([...state.work, record], templateRegistry(state.templates));
    return { payload: { operation: "work.created", record: workJsonFields(record) }, projects: state.projects, work };
  }
}


/**
 * WSA-3 write-path admission: whether the subtree below `recordId` in `work`
 * holds any live non-terminal record, at any depth. Used only by transitionWork
 * when closing an Initiative to done — a tombstoned descendant holds no open
 * work and is skipped. Lives here (not in the protocol graph validator) so the
 * check fires on a live mutation, never on replay.
 */
function hasLiveNonTerminalDescendant(work: readonly WorkRecord[], recordId: string): boolean {
  for (const candidate of work) {
    if (candidate.parentId !== recordId) continue;
    if (candidate.tombstone) continue;
    if (candidate.status !== "done" && candidate.status !== "cancelled") return true;
    if (hasLiveNonTerminalDescendant(work, candidate.id)) return true;
  }
  return false;
}

// STORY-300 slice 3: both of transitionWork's admission rules, evaluated against a
// supplied state rather than against a freshly materialized one.
//
// They used to run before appendEvent, each re-materializing the persisted workspace.
// That is correct for a single transition and wrong inside a batch: a member closing a
// record an earlier member of the same batch created would read a workspace where it does
// not exist yet, and fail indistinguishably from the record genuinely not existing. It was
// also two full replays per transition, so a batch of N transitions built the naive way
// would pay 2N of them -- the batch's O(1) round-trip claim failing quietly inside a verb
// that looks batched from outside.
//
// Moving them into the delta closure is safe, and the safety is specific rather than
// assumed. The closure runs only on the write path: materialize() reconstructs state from
// stored event payloads and never receives or invokes it. What IS shared with replay is
// validateWorkGraph, which materialize calls over the reconstructed set -- and that is
// exactly what the WSA-3 comment below was warning about. A rule placed there would refuse
// a chain that legitimately closed an Initiative before 0.10.0 while descendants were open.
// A rule placed here fires on live mutations only, which is what it always did.
function assertTransitionAdmission(state: WorkspaceState, input: { readonly id: string; readonly status: WorkStatus }): void {
  // A live write-path admission rule; historical chains remain replayable. Before a Story
  // enters an execution or completion state it has a goal and an acceptance (TCRN-CROSS-STORY-473:
  // fields, or the blocks of its scope); a record bound to a template is checked against it.
  if (["ready", "active", "done"].includes(input.status)) {
    const current = workById(state, input.id);
    validateBoundTemplateWork(current, state.templates);
    assertStoryFields(current);
    assertStoryCompletionAdmission(current, input.status);
  }
  // WSA-3 (write-path admission): closing an Initiative to `done` is an act of
  // completion — its whole subtree must already be terminal, or the close is
  // premature. This must never reach validateWorkGraph, which replay runs over every
  // historical event: as write-path admission it fires only on a live "close this INIT"
  // mutation, so historical chains stay readable and the rule still holds going forward.
  // (A tombstoned descendant holds no open work.)
  if (input.status === "done") {
    const current = state.work.find((entry) => entry.id === input.id);
    if (current && current.kind === "Initiative" && !current.tombstone
      && hasLiveNonTerminalDescendant(state.work, current.id)) {
      fail("WORKSPACE_INPUT_INVALID",
        `cannot close Initiative ${input.id} to done: it still holds live non-terminal work`);
    }
  }
}

export function transitionWorkDelta(input: { readonly id: string; readonly status: WorkStatus; readonly summary?: string | null; readonly occurredAt: string }): (state: WorkspaceState) => MutationDelta {
  return (state) => {
    assertTransitionAdmission(state, input);
    return transitionWorkReducerDelta(state, input);
  };
}

// TCRN-CROSS-STORY-467 R3: a transition no longer cites a telemetry record as evidence --
// the telemetry it named is neither written nor read any more. A record that already
// carries advisory:evidence and its snapshot keeps both, and replay still checks them.
export async function transitionWork(workspaceRoot: string, input: {
  readonly id: string;
  readonly status: WorkStatus;
  readonly summary?: string | null;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    assertTransitionAdmission(state, input);
    return transitionWorkReducerDelta(state, input);
  }, input);
}

function transitionWorkReducerDelta(state: WorkspaceState, input: { readonly id: string; readonly status: WorkStatus; readonly summary?: string | null; readonly occurredAt: string }): MutationDelta {
  {
    const current = workById(state, input.id);
    assertWorkTransition(current.status, input.status);
    // WSD-4: a non-tombstoned pending gate anchored to this work item blocks a
    // transition whose target is done (the designated set); the reducer replays
    // the identical predicate as WORKSPACE_EVENT_CORRUPT.
    assertGateClearance(state.gates, current.id, input.status, "WORKSPACE_GATE_PENDING");
    // TCRN-CROSS-STORY-363. The closing sentence is written at the transition
    // that closes the record, which is the only moment it can be true. Omitting
    // --summary keeps whatever the record already carries -- including carrying
    // no summary field at all, which is how a pre-363 record stays byte-identical
    // through a transition instead of acquiring a null nobody wrote.
    const summarised: WorkRecord = input.summary === undefined
      ? workFieldsForWrite(current)
      : { ...workFieldsForWrite(current), summary: normalizeWorkSummary(input.summary) };
    // A transition carries no advisory input since the telemetry evidence id went
    // (TCRN-CROSS-STORY-467 R3); the record keeps the extensions it has.
    const extensions = summarised.extensions;
    const record: WorkRecord = { ...summarised, extensions: extensions as WorkRecord["extensions"], scopeDigest: workExtensionsDigest(extensions), status: input.status, revision: current.revision + 1, updatedAt: input.occurredAt };
    assertWorkTransitionEvidence(current, record, "WORKSPACE_INPUT_INVALID");
    validateBoundTemplateWork(record, state.templates);
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry), templateRegistry(state.templates));
    const storedRecord: WorkRecord = { ...record, extensions: workEventExtensions(record, true) };
    return { payload: { operation: "work.updated", record: workJsonFields(storedRecord) }, projects: state.projects, work };
  }
}

/** What releasing a gate takes besides the instant: the gate, why it is released, and who releases it. */
export interface ReleaseGateInput {
  readonly id: string;
  readonly reason: string;
  readonly actorId: string;
}

/**
 * Release a gate that is not satisfied (TCRN-CROSS-STORY-489; MIN-235 D17, D11; MIN-238 D4): one
 * gate.updated to satisfied whose only extensions delta is the release entry, recording who
 * released it, when (the event's instant) and why, which replay checks again. The actor is always
 * named, whether or not the chain signs its events. A gate that is deleted or already satisfied is
 * refused with WORKSPACE_INPUT_INVALID, and nothing is written. Only Atelier runs this through the
 * CLI (work-gate-release refuses a model with MODEL_WRITE_REFUSED).
 */
export async function releaseGate(workspaceRoot: string, input: ReleaseGateInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => releaseGateDelta(state, input), input);
}

function releaseGateDelta(state: WorkspaceState, input: ReleaseGateInput & { readonly occurredAt: string }): MutationDelta {
  const current = state.gates.find((gate) => gate.id === input.id);
  if (current === undefined || current.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `gate ${input.id} is unavailable`);
  }
  if (current.status === "satisfied") {
    fail("WORKSPACE_INPUT_INVALID", `gate ${input.id} is satisfied already; a satisfied gate is not released again`);
  }
  const release = checkedGateRelease({ actor: input.actorId, reason: input.reason, releasedAt: input.occurredAt }, "WORKSPACE_INPUT_INVALID");
  let record: GateRecord;
  try {
    record = validateGateRecord({
      ...current,
      status: "satisfied",
      revision: current.revision + 1,
      updatedAt: input.occurredAt,
      extensions: gateReleaseExtensions(current.extensions, release),
    });
  } catch (error) {
    if (error instanceof AssignmentGateError) fail("WORKSPACE_INPUT_INVALID", `gate ${input.id} cannot be released: ${error.message}`);
    throw error;
  }
  const gates = sortExtensionRecords([...state.gates.filter((gate) => gate.id !== record.id), record]);
  return {
    payload: { operation: "gate.updated", record: record as unknown as JsonValue },
    projects: state.projects,
    work: state.work,
    gates,
  };
}

// E05 (scope-on-record): attach advisory fields to a live work record. It never changes
// status and never touches a gate, so an annotation cannot advance, block, or unblock
// work; the transition path separately enforces Story scope and Owner acceptance.
// validateWorkGraph re-validates the merged extensions (rejecting a
// required:true advisory key, which carries no registry row), and the reducer replays
// the advisory-only delta as WORKSPACE_EVENT_CORRUPT.
// STORY-300 slice 3: annotateWork's delta, exposed so a batch can compose it. Like
// createWork and unlike transitionWork, all of its validation already lived inside the
// closure, so nothing moves across the replay boundary here.
export function annotateWorkDelta(input: WorkAnnotationInput): (state: WorkspaceState) => MutationDelta {
  return (state) => annotateWorkReducerDelta(state, input);
}

export async function annotateWork(workspaceRoot: string, input: WorkAnnotationInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => annotateWorkReducerDelta(state, input), input);
}

function annotateWorkReducerDelta(state: WorkspaceState, input: WorkAnnotationInput): MutationDelta {
  const current = workById(state, input.id);
  if (current.tombstone) {
    fail("WORKSPACE_INPUT_INVALID", `work ${input.id} is deleted`);
  }
  if (input.scope === undefined && input.decidedBy === undefined && input.verify === undefined && input.result === undefined && input.sprint === undefined && input.relations === undefined && input.goal === undefined && input.acceptance === undefined && input.body === undefined && input.title === undefined && input.summary === undefined && input.labels === undefined) {
    fail("WORKSPACE_INPUT_INVALID", "an annotation must set scope, decided-by, verify, result, sprint, relations, goal, acceptance, body, title, summary, or labels");
  }
  validateWorkAdvisoryInput(input, input.id, "WORKSPACE_INPUT_INVALID");
  // TCRN-CROSS-STORY-472: each relation list an annotation names is replaced whole.
  const relations = workRelationsForWrite(state, input.id, input);
  const title = input.title === undefined ? current.title ?? null : normalizeWorkTitle(input.title);
  const labels = input.labels === undefined ? current.labels ?? [] : normalizeWorkLabels(input.labels);
  // TCRN-CROSS-STORY-363. This is the door the historical backfill goes through:
  // an annotation may set the summary of a record that has no summary field, and
  // that is the only way a pre-363 record acquires one -- by an event that says
  // who wrote it and when, not by a replay-time default.
  const summary = input.summary === undefined ? current.summary : normalizeWorkSummary(input.summary);
  const extensions = workAdvisoryExtensions(current.extensions, input, relations);
  // TCRN-CROSS-INC-269: the reducer's own predicate, run before the event exists.
  // title, labels and summary are top-level work fields rather than extensions, so an
  // annotation that moved only them once satisfied a separate no-op check here and
  // failed the reducer -- the write returned a complete receipt and every later read of
  // the workspace came back WORKSPACE_EVENT_CORRUPT, with recover no help because the
  // log was intact and the appended record was the damage. There is now one predicate
  // and no second no-op comparison beside it: a duplicate that agreed with the reducer
  // would mask this call's removal, and a duplicate that disagreed would recreate
  // INC-269 exactly. TCRN-CROSS-STORY-363.
  assertWorkAnnotation(
    workAnnotationFields(current),
    { extensions, title, summary: summary ?? null, labels },
    input.id,
    "WORKSPACE_INPUT_INVALID",
  );
  const record: WorkRecord = {
    ...workFieldsForWrite(current),
    extensions: extensions as WorkRecord["extensions"],
    scopeDigest: workExtensionsDigest(extensions),
    title,
    labels,
    ...(summary === undefined ? {} : { summary }),
    revision: current.revision + 1,
    updatedAt: input.occurredAt,
  };
  // TCRN-CROSS-STORY-473 R2: an annotation that rewrites what a Story's goal or acceptance is read
  // from must leave both in place. One that touches neither -- a title, a summary, a relation --
  // stays open to every Story, including one written before the fields existed.
  if (input.goal !== undefined || input.acceptance !== undefined || input.scope !== undefined) {
    assertStoryFields(record);
  }
  validateBoundTemplateWork(record, state.templates);
  const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry), templateRegistry(state.templates));
  return { payload: { operation: "work.annotated", record: workJsonFields(record) }, projects: state.projects, work };
}


export async function deleteWork(workspaceRoot: string, input: {
  readonly id: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const current = workById(state, input.id);
    const record: WorkRecord = { ...workFieldsForWrite(current), revision: current.revision + 1, updatedAt: input.occurredAt, tombstone: true };
    validateBoundTemplateWork(record, state.templates);
    const work = validateWorkGraph(state.work.map((entry) => entry.id === record.id ? record : entry), templateRegistry(state.templates));
    const storedRecord: WorkRecord = { ...record, extensions: workEventExtensions(record, true) };
    return { payload: { operation: "work.deleted", record: workJsonFields(storedRecord) }, projects: state.projects, work };
  }, input);
}

// TCRN-CROSS-STORY-475 R1, R2 (MIN-227 D9, D10): record minutes in one write. The external key is
// the writer's, or the next free number under the prefix of the minutes recorded last
// (nextMinutesExternalKey); either way the id it derives must be new, to the minutes a conference
// ever closed as well. Every linked work record is live and in the minutes' project.
export interface RecordMinutesInput {
  readonly externalKey?: string;
  // Used only when no externalKey is given: the prefix to number under (TCRN-CROSS-MIN- say).
  readonly externalKeyPrefix?: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly decidedBy: readonly string[];
  readonly linkedWorkIds: readonly string[];
}

export function recordMinutesDelta(input: RecordMinutesInput & { readonly occurredAt: string }): (state: WorkspaceState) => MutationDelta {
  return (state) => {
    projectById(state, input.projectId);
    for (const workId of input.linkedWorkIds) {
      if (workById(state, workId).projectId !== input.projectId) {
        fail("WORKSPACE_INPUT_INVALID", `work ${workId} is outside project ${input.projectId}`);
      }
    }
    const externalKey = input.externalKey === undefined
      ? nextMinutesExternalKey(state, input.externalKeyPrefix)
      : canonicalExternalKey(input.externalKey);
    const id = deriveStableId("minutes", externalKey);
    if (state.minutes.some((entry) => entry.id === id) || state.conferenceMinutes.some((entry) => entry.id === id)) {
      fail("WORKSPACE_INPUT_INVALID", `minutes ${externalKey} (${id}) already exist`);
    }
    const record = validateMinutesRecord({
      schemaVersion: MINUTES_RECORD_VERSION,
      id,
      externalKey,
      projectId: input.projectId,
      title: input.title,
      summary: input.summary,
      decisions: [...input.decisions],
      decidedBy: [...input.decidedBy],
      linkedWorkIds: [...input.linkedWorkIds],
      recordedAt: input.occurredAt,
      revision: 1,
      tombstone: false,
    });
    return {
      payload: buildEventPayload(MINUTES_RECORDED_OPERATION, record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      minutes: sortExtensionRecords([...state.minutes, record]),
    };
  };
}

export async function recordMinutes(workspaceRoot: string, input: RecordMinutesInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, recordMinutesDelta(input), input);
}

// WSE-2: the attestation.actor.enabled chain event is history now. Its write verb is
// retired (TCRN-CROSS-STORY-467 R2); a chain that carries it still replays through the
// reducer above and still demands an actor from that event on, which appendEvents
// enforces for every later write.

// TCRN-CROSS-STORY-475 R3 (MIN-227 D10): the conference write verbs -- open, append a position,
// close (with its execution-form declaration, the execution.independenceFloor check and the
// conference.positionBudgetBytes budget) and cancel -- are retired. Decisions are recorded as minutes
// (recordMinutes above); every conference event already on a chain replays through the reducer
// arms, which keep every check they made.

// INIT-027 S238. Custom personas are content records on the same governed
// execution surface. Their ids are derived from names inside profile-store.ts;
// callers provide the human name and the event carries the validated record.
export async function setCustomPersonaInWorkspace(workspaceRoot: string, input: {
  readonly name: unknown;
  readonly role: unknown;
  readonly jobTitle?: unknown;
  readonly mission?: unknown;
  readonly refusals?: unknown;
  readonly authorityBoundary?: unknown;
  readonly contactWhen?: unknown;
  readonly requiredInputs?: unknown;
  readonly deliverables?: unknown;
  readonly successCriteria?: unknown;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const applied = applyCustomPersonaSet(state.executionConfig, {
      name: input.name,
      role: input.role,
      jobTitle: input.jobTitle,
      mission: input.mission,
      refusals: input.refusals,
      authorityBoundary: input.authorityBoundary,
      contactWhen: input.contactWhen,
      requiredInputs: input.requiredInputs,
      deliverables: input.deliverables,
      successCriteria: input.successCriteria,
      updatedAt: input.occurredAt,
    });
    return {
      payload: buildEventPayload("execution.persona.set", applied.record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      executionConfig: applied.state,
    };
  }, input);
}

export async function setModelPlanInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly name: string; readonly defaultModel: string; readonly defaultEffort?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const applied = applyModelPlanSetInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.model-plan.set", applied.record as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function assignModelPlanInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly name: string; readonly persona: string; readonly model: string; readonly effort?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const applied = applyModelPlanAssignInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.model-plan.assigned", { ...applied.record, persona: input.persona, model: input.model, ...(input.effort === undefined ? {} : { effort: input.effort }) } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function unassignModelPlanInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly name: string; readonly persona: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const applied = applyModelPlanUnassignInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload("execution.model-plan.unassigned", { ...applied.record, persona: input.persona } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function removeModelPlanInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => ({
    payload: buildEventPayload("execution.model-plan.removed", { host: input.host, name: input.name, updatedAt: input.occurredAt } as unknown as JsonValue),
    projects: state.projects,
    work: state.work,
    executionConfig: applyModelPlanRemoveInExecutionConfig(state.executionConfig, { host: input.host, name: input.name }),
  }), input);
}

export async function overridePersonaPresetInWorkspace(workspaceRoot: string, input: {
  readonly name: string; readonly fields: Readonly<Record<string, unknown>>;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const applied = applyPersonaPresetOverrideInExecutionConfig(state.executionConfig, { ...input, updatedAt: input.occurredAt });
    return { payload: buildEventPayload(`${legacyPresetOperation}.override`, applied.record as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applied.state };
  }, input);
}

export async function restorePersonaPresetInWorkspace(workspaceRoot: string, input: {
  readonly name: string; readonly field?: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const field = input.field ?? "";
    const next = applyPersonaPresetRestoreInExecutionConfig(state.executionConfig, { name: input.name, field, updatedAt: input.occurredAt });
    return { payload: buildEventPayload(`${legacyPresetOperation}.restore`, { name: input.name, field, updatedAt: input.occurredAt } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: next };
  }, input);
}

export async function removePersonaInWorkspace(workspaceRoot: string, input: {
  readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => {
    const isPreset = state.executionConfig.personaTombstones.includes(input.name) || state.executionConfig.personas.every((persona) => persona.name !== input.name);
    if (isPreset) {
      return { payload: buildEventPayload(`${legacyPresetOperation}.removed`, { name: input.name, updatedAt: input.occurredAt } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applyPersonaPresetRemoveInExecutionConfig(state.executionConfig, { name: input.name }) };
    }
    return { payload: buildEventPayload("execution.persona.removed", { name: input.name, updatedAt: input.occurredAt } as unknown as JsonValue), projects: state.projects, work: state.work, executionConfig: applyCustomPersonaRemove(state.executionConfig, { name: input.name }) };
  }, input);
}

export async function removeCustomPersonaInWorkspace(workspaceRoot: string, input: {
  readonly name: unknown;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return appendEvent(workspaceRoot, (state) => ({
    payload: buildEventPayload("execution.persona.removed", {
      name: input.name as JsonValue,
      updatedAt: input.occurredAt,
    } as JsonValue),
    projects: state.projects,
    work: state.work,
    executionConfig: applyCustomPersonaRemove(state.executionConfig, { name: input.name }),
  }), input);
}

// INIT-026 S232. Five verbs, one event each: an audit trail where "the default
// moved" is one legible line, never a diff of a rewritten blob. Validation and
// referential integrity run in the apply functions, against the claim-fresh
// state, and the SAME functions run again on every replay.
export async function setHostConfigurationInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly name: string; readonly model: string; readonly note: string | null;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, (state) => {
    const applied = applyHostConfigSet(state.executionConfig, {
      host: input.host as ExecutionHost,
      name: validateConfigurationName(input.name),
      model: validateModel(input.model),
      note: validateNote(input.note),
      updatedAt: input.occurredAt,
    });
    return {
      payload: buildEventPayload("execution.configuration.set", {
        host: input.host, name: input.name, model: input.model, note: validateNote(input.note), updatedAt: input.occurredAt,
      } as unknown as JsonValue),
      projects: state.projects, work: state.work, executionConfig: applied.state,
    };
  }, input);
}

export async function removeHostConfigurationInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly name: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, (state) => ({
    payload: buildEventPayload("execution.configuration.removed", {
      host: input.host, name: input.name, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyHostConfigRemove(state.executionConfig, { host: input.host as ExecutionHost, name: validateConfigurationName(input.name) }),
  }), input);
}

export async function setHostDefaultInWorkspace(workspaceRoot: string, input: {
  readonly host: string; readonly configurationName: string | null;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, (state) => ({
    payload: buildEventPayload("execution.default.set", {
      host: input.host, configurationName: input.configurationName, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyHostConfigDefault(state.executionConfig, {
      host: input.host as ExecutionHost,
      configurationName: input.configurationName === null ? null : validateConfigurationName(input.configurationName),
      updatedAt: input.occurredAt,
    }),
  }), input);
}

export async function setPersonaBindingInWorkspace(workspaceRoot: string, input: {
  readonly profileId: string; readonly host: string; readonly configurationName: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, (state) => ({
    payload: buildEventPayload("execution.binding.set", {
      profileId: input.profileId, host: input.host, configurationName: input.configurationName, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyPersonaBindingSet(state.executionConfig, {
      profileId: input.profileId, host: input.host as ExecutionHost,
      configurationName: validateConfigurationName(input.configurationName), updatedAt: input.occurredAt,
    }),
  }), input);
}

export async function removePersonaBindingInWorkspace(workspaceRoot: string, input: {
  readonly profileId: string; readonly host: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertExecutionHost(input.host);
  return appendEvent(workspaceRoot, (state) => ({
    payload: buildEventPayload("execution.binding.removed", {
      profileId: input.profileId, host: input.host, updatedAt: input.occurredAt,
    } as unknown as JsonValue),
    projects: state.projects, work: state.work,
    executionConfig: applyPersonaBindingRemove(state.executionConfig, { profileId: input.profileId, host: input.host as ExecutionHost }),
  }), input);
}

// gate-v1: the gate write verbs (create, transition, delete) are retired with the rest of
// the authority family (TCRN-CROSS-STORY-467 R2). Gate records already on a chain still
// replay -- lifecycle, evidence re-resolution and the identity-decision shape are checked by
// the reducer above -- and a pending one still holds its work item back from done.

// INIT-022 S212: a template file is inert until this governed admission event
// records its digest, version, owner, and schema in the workspace chain. The
// reducer derives the extension registry from these records; callers cannot
// smuggle a required template extension in through a work payload alone.
export async function admitTemplateInWorkspace(workspaceRoot: string, input: {
  readonly template: unknown;
  readonly ownerId: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const receipt = admitTemplate(input.template, { ownerId: input.ownerId, admittedAt: input.occurredAt });
  const record = createTemplateAdmissionRecord(input.template, receipt);
  return appendEvent(workspaceRoot, (state) => {
    if (state.templates.some((entry) => entry.template.id === record.template.id && entry.template.version === record.template.version)) {
      throw new TemplateAdmissionError("TEMPLATE_DUPLICATE", `${record.template.id}@${record.template.version}`);
    }
    const templates = [...state.templates, record].sort((left, right) => compareCanonicalText(left.registrationId, right.registrationId));
    return {
      payload: buildEventPayload("template.admitted", record as unknown as JsonValue),
      projects: state.projects,
      work: state.work,
      templates,
    };
  }, input);
}

// TCRN-CROSS-STORY-469 R2: after a project-level setting commits, config/project.json shows the
// merged values. It is a convenience for readers outside the engine, never read back, so a failure
// to write it does not undo the committed setting; status reports a projection that is out of date.
// TCRN-CROSS-STORY-478 R1 (SUB-315): it shows the configuration records too, and a record write
// (config-records.ts) projects through here as well.
export async function projectConfiguration(root: string, state: WorkspaceState): Promise<void> {
  try {
    await writeConfigProjection(root, { versionVector: state.library?.versionVector ?? {}, settings: state.settings, configRecords: state.configRecords });
  } catch {
    // Left to the next project-level write; status shows it as stale meanwhile.
  }
}

// INIT-022 S213: settings are a bounded workspace_configuration overlay, not an
// ungoverned JSON sidecar. Each write is an append-only event and the replay arm
// above enforces the same key, layer, revision, and value contract. They are the
// project level (TCRN-CROSS-STORY-469 R2): a device-level key is refused here and
// written by machine-settings-set. TCRN-CROSS-STORY-508 R1, R2: a write of models.category or
// models.tiers is also checked against the other table as it stands (assertSettingWriteConsistent);
// R3: so is a write of models.escalation.ceiling, which may only name a category models.category
// holds. A settings-remove runs the same check on the default it puts back.
export async function setWorkspaceSetting(workspaceRoot: string, input: {
  readonly key: string;
  readonly value: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertProjectSettingKey(input.key);
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const committed = await appendEvent(root, (state) => {
      const current = state.settings.find((record) => record.key === input.key);
      const record = createWorkspaceSettingRecord(
        input.key,
        input.value,
        (current?.revision ?? 0) + 1,
        input.occurredAt,
        workspaceRoot,
      );
      assertSettingWriteConsistent(state.settings, record.key, record.value);
      return {
        payload: buildEventPayload("settings.updated", record as unknown as JsonValue),
        projects: state.projects,
        work: state.work,
        settings: sortWorkspaceSettings([
          ...state.settings.filter((entry) => entry.key !== record.key),
          record,
        ]),
      };
    }, input);
    await projectConfiguration(root, committed);
    return committed;
  });
}

export async function removeWorkspaceSetting(workspaceRoot: string, input: {
  readonly key: string;
} & WorkspaceMutationOptions): Promise<WorkspaceState> {
  assertProjectSettingKey(input.key);
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const committed = await appendEvent(root, (state) => {
      const current = state.settings.find((record) => record.key === input.key);
      if (current === undefined) fail("WORKSPACE_INPUT_INVALID", `setting ${input.key} is not set`);
      assertSettingWriteConsistent(state.settings, input.key, null);
      return {
        payload: buildEventPayload("settings.removed", { key: input.key, updatedAt: input.occurredAt } as unknown as JsonValue),
        projects: state.projects,
        work: state.work,
        settings: sortWorkspaceSettings(state.settings.filter((entry) => entry.key !== input.key)),
      };
    }, input);
    await projectConfiguration(root, committed);
    return committed;
  });
}

/**
 * Rebuild this device's cache of the library (TCRN-CROSS-STORY-469 R4): drop it, replay the
 * merged streams from genesis, and write the views and a snapshot of the result. The library
 * itself is only read.
 */
export async function recoverWorkspace(workspaceRoot: string): Promise<WorkspaceState> {
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const library = await openLibrary(root);
    await clearLibraryCache(library.manifest.libraryId);
    const read = await readAllStreams(library.root);
    const replay = replayLibrary(library, read);
    await refreshLibraryCache(library, read, replay, null, { force: true, strict: true });
    return replay.state;
  });
}

export async function exportWorkspace(workspaceRoot: string): Promise<string> {
  const state = await materializeWorkspace(workspaceRoot);
  // WSD-1: extension collections are exported ONLY when present so the export
  // bytes (and the archive digest) stay identical for every workspace without
  // conference/gate events. canonicalJson sorts keys, so conditional inclusion
  // is byte-stable.
  const extensionCollections = state.conferences.length + state.gates.length + state.settings.length + state.templates.length + state.minutes.length > 0
    ? {
      conferences: state.conferences,
      conferencePositions: state.conferencePositions,
      conferenceMinutes: state.conferenceMinutes,
      gates: state.gates,
      ...(state.settings.length === 0 ? {} : { settings: state.settings }),
      ...(state.templates.length === 0 ? {} : { templates: state.templates }),
      ...(state.minutes.length === 0 ? {} : { minutes: state.minutes }),
    }
    : {};
  return canonicalJson({
    schemaVersion: "tcrn.workspace-export.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    projects: state.projects,
    work: state.work,
    ...extensionCollections,
    events: state.events,
  });
}

export async function createWorkspaceArchive(workspaceRoot: string): Promise<Buffer> {
  const exported = await exportWorkspace(workspaceRoot);
  return Buffer.from(canonicalJson({
    schemaVersion: "tcrn.workspace-archive.v1",
    mediaType: "application/vnd.tcrn.workspace-archive+json",
    contentSha256: canonicalSha256(assertCanonicalJson(exported)),
    content: assertCanonicalJson(exported),
  }), "utf8");
}
