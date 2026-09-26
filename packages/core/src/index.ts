// SPDX-License-Identifier: Apache-2.0

export const FRAMEWORK_VERSION = "1.2.1" as const;
export const DEFAULT_MODE = "development" as const;

export type WorkflowMode = "development" | "release";

export type RootKind =
  | "framework"
  | "workspace"
  | "transient"
  | "evidence-locator"
  | "release-trust";

export interface ExplicitRoot {
  readonly kind: RootKind;
  readonly path: string;
}

export interface DevelopmentAdmission {
  readonly admitted: true;
  readonly mode: "development";
  readonly projectCommandNetwork: "process-guarded-offline";
  readonly osNetworkSandbox: "not-provided";
  readonly telemetry: "disabled";
}

export interface ReleaseAdmissionRequest {
  readonly mode: "release";
  readonly trustRootPath: string;
  readonly bundlePath: string;
  readonly subject: string;
  readonly repository: string;
  readonly workflow: string;
}

export function admitDevelopment(): DevelopmentAdmission {
  return {
    admitted: true,
    mode: DEFAULT_MODE,
    projectCommandNetwork: "process-guarded-offline",
    osNetworkSandbox: "not-provided",
    telemetry: "disabled",
  };
}

export { assertDistinctRoots, RootIdentityError } from "./root-identity.js";
export type { CanonicalRoot } from "./root-identity.js";
// TCRN-CROSS-STORY-469: the old layout's control directory, which the engine reads and never
// writes. The storage backends, the segment index and the storage-home sentinel of the old
// layout's writer are gone with it.
export { WORKSPACE_CONTROL_DIRECTORY } from "./workspace.js";
export type { WorkspaceCrashPoint } from "./workspace.js";
// STORY-281: machine-level portal preferences. Deliberately not chain-backed — see
// the module header for why a laptop's default theme is not governed workspace state.
export {
  MACHINE_SETTINGS_CATALOG,
  MACHINE_SETTINGS_DIRECTORY,
  MACHINE_SETTINGS_FILE_NAME,
  MACHINE_SETTINGS_LAYER_KIND,
  MACHINE_SETTINGS_REASON_CODES,
  MACHINE_SETTINGS_VERSION,
  MACHINE_SETTING_KEYS,
  MachineSettingsError,
  applyMachineSettingRemove,
  applyMachineSettingSet,
  assertMachineSettingKey,
  machineSettingsPath,
  readMachineSettings,
  readMachineSettingsCatalog,
  validateMachineSettingValue,
  validateMachineSettingsFile,
} from "./machine-settings.js";
export type { MachineSettingKey, MachineSettingsCatalogEntry, MachineSettingsFile, MachineSettingsReadback } from "./machine-settings.js";
// STORY-177: the knowledge/artifact store data-plane backend is part of the public
// core surface so a future PG store backend can implement it. StoreBackendError is
// the fail-closed refusal shape; FileStoreBackend is the converged file
// implementation; withStoreBackendFactory is the test-seam injection.
export { StoreBackendError, FileStoreBackend, SegmentedKnowledgeStoreBackend, withStoreBackendFactory } from "./store-backend.js";
export type { StoreBackend } from "./store-backend.js";
export {
  CONTROL_TREE_SKELETON_DIRECTORIES,
  CONTROL_TREE_TRANSPORT_RESIDUE_PATHS,
  SNAPSHOT_REASON_CODES,
  SnapshotError,
  createSnapshotManifest,
  readGovernedDocumentFile,
  readSnapshotManifestFile,
  verifySnapshotManifest,
} from "./workspace-snapshot.js";
export type { SnapshotReasonCode } from "./workspace-snapshot.js";
// TCRN-CROSS-STORY-380. Exactly the four names packages/cli/src/index.ts calls, and no
// more: scripts/policy/core-export-consumers.json reports every barrel symbol the
// consumer roots do not name, and a constant or type re-exported here "for completeness"
// is a symbol whose only consumer is its own test — the shape TCRN-CROSS-STORY-358 spent
// an Epic removing. artifact-store.ts still exports its schema versions and reason codes
// for readers of that module; the barrel is not that reader.
export {
  assertGeneratedArtifactsRoot,
  listArtifacts,
  putArtifact,
  verifyArtifacts,
} from "./artifact-store.js";
export {
  BACKGROUND_RESOURCE_LIMITS,
  BACKGROUND_RESOURCE_REASON_CODES,
  BACKGROUND_RESOURCE_REGISTRATION_VERSION,
  BACKGROUND_RESOURCE_RESIDUE_VERSION,
  BackgroundResourceError,
  buildRegistrationLine,
  buildResidueReport,
  detectResidue,
  parseProcessTable,
  parseRegistrationLine,
  parseRegistry,
} from "./background-resource.js";
export type {
  BackgroundResourceReasonCode,
  ProcessRow,
  ResidueEntry,
  ResidueReason,
  ResidueReport,
  ResidueStatus,
  SpawnRegistration,
} from "./background-resource.js";
export {
  WORKSPACE_REASON_CODES,
  WORKSPACE_RELOCATION_ENTRY_VERSION,
  WORKSPACE_RELOCATION_IDENTITY_VERSION,
  WORKSPACE_RELOCATION_LEDGER_LIMIT,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STORAGE_VERSION,
  WorkspaceError,
  activeBinding,
  activeWorkspaceRoot,
  appendConferencePositionInWorkspace,
  admitTemplateInWorkspace,
  cancelConferenceInWorkspace,
  closeConferenceInWorkspace,
  assertWorkspaceRecordCount,
  assertWorkspaceRelativePath,
  createProject,
  createWorkspaceArchive,
  createWork,
  createWorkDelta,
  annotateWork,
  annotateWorkDelta,
  appendEvents,
  deleteProject,
  deleteWork,
  exportWorkspace,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  openConferenceInWorkspace,
  recoverWorkspace,
  removeHostConfigurationInWorkspace,
  removeCustomPersonaInWorkspace,
  removePersonaBindingInWorkspace,
  removePersonaInWorkspace,
  restorePersonaPresetInWorkspace,
  overridePersonaPresetInWorkspace,
  setCustomPersonaInWorkspace,
  setHostConfigurationInWorkspace,
  setHostDefaultInWorkspace,
  setPersonaBindingInWorkspace,
  setWorkspaceSetting,
  removeWorkspaceSetting,
  transitionWork,
  transitionWorkDelta,
  updateProject,
  validateWorkspace,
  withWorkspaceWriteLock,
  writtenRecordIds,
  workspaceBudgets,
  workspaceViewDocuments,
  WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
} from "./workspace.js";
export type {
  InitializeLibraryOptions,
  ProjectRecord,
  SprintReference,
  WorkspaceAdmission,
  WorkspaceMetadata,
  WorkspaceMutationOptions,
  WorkspaceReasonCode,
  WorkspaceRelocationAuthorityRecord,
  WorkspaceRelocationBasis,
  WorkspaceRelocationEntry,
  WorkspaceRelocationStage,
  WorkspaceRelocationState,
  WorkspaceState,
} from "./workspace.js";
export {
  TemplateAdmissionError,
  admitTemplate,
  createTemplateAdmissionRecord,
  readTemplateDocumentFile,
  templateBindingFromReceipt,
  templateBindingFromWorkRecord,
  templateDigest,
  templateRecordForBinding,
  templateRecordMatchesBinding,
  templateRegistry,
  validateBoundTemplateWork,
  validateTemplateAdmissionReceipt,
  validateTemplateAdmissionRecord,
  validateTemplateDocument,
} from "./template-admission.js";
export type { TemplateAdmissionRecord } from "./template-admission.js";
export {
  SETTINGS_CATALOG,
  SETTINGS_CATALOG_VERSION,
  SETTINGS_LAYER_KIND,
  SETTINGS_REASON_CODES,
  WORKSPACE_SETTING_VERSION,
  SettingsError,
  compareEngineVersions,
  createWorkspaceSettingRecord,
  readSettingsCatalog,
  settingsCatalogEntry,
  sortWorkspaceSettings,
  validateSettingValue,
  validateWorkspaceSettingRecord,
} from "./settings.js";
export type {
  SettingKey,
  SettingValueType,
  SettingsCatalogEntry,
  SettingsCatalogReadback,
  SettingsReasonCode,
  WorkspaceSettingRecord,
} from "./settings.js";
export {
  INSTALL_MANIFEST,
  INSTALL_MANIFEST_REQUIRED_ITEM_IDS,
  INSTALL_MANIFEST_VERSION,
  assertInstallManifestComplete,
  readInstallManifest,
} from "./install-manifest.js";
export {
  EMPTY_EXECUTION_CONFIG,
  EXECUTION_CONFIG_VERSION,
  EXECUTION_HOSTS,
  EXECUTION_CONFIG_REASON_CODES,
  ExecutionConfigError,
  applyHostConfigDefault,
  applyHostConfigRemove,
  applyHostConfigSet,
  applyLegacyCustomPersonaSet,
  applyCustomPersonaSet,
  applyCustomPersonaRemove,
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
  validateExecutionConfigState,
  validateModel,
  validateNote,
} from "./execution-config.js";
export {
  readDispatchConfig,
  resolveDispatch,
} from "./dispatch-config.js";
export {
  MODEL_PLAN_REASON_CODES,
  MODEL_PLAN_VERSION,
  ModelPlanError,
  applyModelPlanAssign,
  applyModelPlanRemove,
  applyModelPlanSet,
  applyModelPlanUnassign,
  readModelPlans,
  validateModelPlanEffort,
  validateModelPlanModel,
  validateModelPlanName,
  validateModelPlanState,
} from "./model-plan.js";
export type { ModelPlanHost, ModelPlanReasonCode, ModelPlanRecord } from "./model-plan.js";
export type {
  ExecutionConfigState,
  ExecutionHost,
  ExecutionConfigReasonCode,
  HostConfigurationRecord,
  HostDefaultRecord,
  PersonaBindingRecord,
} from "./execution-config.js";
export {
  CORE_REFERENCE_PERSONAS,
  EMPTY_PERSONA_STORE,
  PERSONA_REASON_CODES,
  PERSONA_CONTENT_FIELDS,
  PERSONA_NARRATIVE_FIELDS,
  PERSONA_RECORD_VERSION,
  PERSONA_ROLES,
  PERSONA_ROLE_DEFINITIONS,
  PERSONA_STORE_VERSION,
  PersonaStoreError,
  allPersonaReadback,
  applyLegacyPersonaSet,
  applyPersonaPresetOverride,
  applyPersonaPresetRemove,
  applyPersonaPresetRestore,
  applyPersonaRemove,
  applyPersonaSet,
  derivePersonaId,
  personaExists,
  validatePersonaDescription,
  validatePersonaContent,
  validatePersonaJobTitle,
  validatePersonaName,
  validatePersonaPrompt,
  validatePersonaRole,
  validatePersonaStoreState,
  validatePersonaPresetOverride,
} from "./profile-store.js";
export type {
  PersonaReasonCode,
  PersonaRecord,
  PersonaRole,
  PersonaContentField,
  PersonaPresetOverrideRecord,
  PersonaReadback,
  PersonaStoreState,
  ReferencePersonaReadback,
} from "./profile-store.js";
export {
  STORY_SCOPE_HEADINGS,
  deriveWorkSummary,
  storyScopeFromRecord,
  storyScopeNamesOwnerDecider,
  validateStoryRecord,
  validateStoryScope,
  validateTemplateScope,
} from "./story-scope-compliance.js";
export type {
  ScopeTemplateDefinition,
  StoryScopeHeading,
  StoryScopeProblem,
  StoryScopeProblemCode,
  StoryScopeSection,
  StoryScopeValidation,
} from "./story-scope-compliance.js";
export {
  KNOWLEDGE_CONFLICT_SCORE_THRESHOLD,
  KNOWLEDGE_CORE_VERSION,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_METADATA_SCHEMA_VERSION,
  KNOWLEDGE_PROVENANCE_POLICY,
  KNOWLEDGE_REASON_CODES,
  KNOWLEDGE_STORE_SCHEMA_VERSION,
  KnowledgeCoreError,
  captureKnowledgeUnit,
  createKnowledgeArticle,
  createKnowledgeUnit,
  calculateKnowledgeSourceDigest,
  checkKnowledgeSources,
  evaluateKnowledgeFitness,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  knowledgeStorePath,
  migrateKnowledgeBodies,
  knowledgeConflictHits,
  knowledgeLinkIndexCountsForTest,
  knowledgeRelevanceScore,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeStoreMarker,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  recoverKnowledgeStore,
  retireKnowledgeUnit,
  retireKnowledgeSweep,
  refreshKnowledgeArticle,
  reverifyKnowledgeUnit,
  updateKnowledgeStalenessPolicy,
  transitionKnowledgePromotion,
  validateKnowledgeStore,
} from "./knowledge-core.js";
export type {
  CaptureKnowledgeUnitInput,
  CreateKnowledgeUnitInput,
  KnowledgeArticleCreateInput,
  KnowledgeArticleRefreshInput,
  KnowledgeBodyReadOptions,
  KnowledgeCategory,
  KnowledgeExportDisposition,
  KnowledgeFaultPoint,
  KnowledgeFreshnessState,
  KnowledgeKind,
  KnowledgeLifecycle,
  KnowledgeListQuery,
  KnowledgeMutationOptions,
  KnowledgePromotionState,
  KnowledgeReadOptions,
  KnowledgeFitnessRecord,
  KnowledgeFitnessResult,
  KnowledgeRetirementRecord,
  KnowledgeReasonCode,
  KnowledgeRetrievalDisposition,
  KnowledgeScope,
  KnowledgeStalenessPolicy,
  KnowledgeUnitExtensions,
  KnowledgeUnitMetadata,
} from "./knowledge-core.js";
export {
  COLLECTION_ATTRIBUTION_NOTE,
  COLLECTION_REASON_CODES,
  CollectionError,
  collectConferenceReceipts,
  collectExecutionReceipt,
  verifyCollectedTranscript,
} from "./execution-collection.js";
export type {
  CollectedReceipt,
  CollectionContext,
  CollectionPlanEntry,
  CollectionReasonCode,
  CollectionResult,
  ObservedInvocation,
} from "./execution-collection.js";
export {
  DEPENDENCY_VERSION,
  DEPENDENCY_KINDS,
  DEPENDENCY_STATUSES,
  DEPENDENCY_REASON_CODES,
  DependencyError,
  validateDependencyRecord,
  canonicalDependencyDigest,
  assertDependencyEndpoints,
  orderDependencies,
  assertNoDependencyCycle,
  listDependencyBlockers,
  listDependenciesByWorkItem,
} from "./dependency.js";
export {
  ACTOR_ATTESTATION_SCHEMA_VERSION,
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  ACTOR_ATTESTATION_REGISTRATION_ID,
  ACTOR_PREFIXES,
  ActorAttestationError,
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  assertActorId,
  buildEventPayload,
  buildActorAttestationEnableRecord,
  validateActorAttestationEnableRecord,
  buildActorAttestationRegistration,
} from "./actor-attestation.js";
export type {
  DependencyRecord,
  DependencyWorkReference,
  DependencyReasonCode,
  DependencyKind,
  DependencyStatus,
} from "./dependency.js";
export {
  CONFERENCE_DISTILL_SUMMARY_BYTES,
  CONFERENCE_POSITION_CEILING_BYTES,
  CONFERENCE_REQUEST_VERSION,
  CONFERENCE_POSITION_VERSION,
  CONFERENCE_MINUTES_VERSION,
  CONFERENCE_TYPES,
  CONFERENCE_STATUSES,
  CONFERENCE_OUTCOME_CLASSES,
  CONFERENCE_EXECUTION_FORMS,
  CONFERENCE_REASON_CODES,
  ConferenceError,
  validateConferenceRequest,
  validateConferencePosition,
  validateConferenceMinutes,
  openConference,
  appendConferencePosition,
  listConferencesByWorkItem,
  closeConference,
  distillConferenceKnowledge,
} from "./conference.js";
export type {
  ConferenceRequest,
  ConferencePosition,
  ConferenceMinutes,
  ConferenceDecisionCandidate,
  ConferenceReasonCode,
  DistillConferenceOptions,
} from "./conference.js";
export { VOCABULARY_VERSION, readVocabulary } from "./vocabulary.js";
export {
  EXECUTION_MODES,
  HOST_EXECUTION_RECEIPT_VERSION,
  EXECUTION_MODE_EXTENSION_KEY,
  EXECUTION_RECEIPT_EXTENSION_KEY,
  MULTI_AGENT_DEFAULT_TYPES,
  EXECUTION_AVAILABILITY,
  EXECUTION_REASON_CODES,
  ExecutionError,
  validateHostExecutionReceipt,
  readExecutionMode,
  classifyConferenceExecution,
} from "./conference-execution.js";
export type {
  ExecutionMode,
  ExecutionReasonCode,
  HostExecutionReceipt,
  ExecutionModeDeclaration,
  ExecutionClassification,
  ClassifyInput,
} from "./conference-execution.js";
export {
  ASSIGNMENT_VERSION,
  GATE_VERSION,
  ASSIGNMENT_STATUSES,
  GATE_STATUSES,
  GATE_OUTCOME_CLASSES,
  ASSIGNMENT_GATE_REASON_CODES,
  AssignmentGateError,
  validateAssignmentRecord,
  validateGateRecord,
  listAssignmentsByWorkItem,
  listGatesByWorkItem,
} from "./assignment-gate.js";
export type {
  AssignmentRecord,
  GateRecord,
  AssignmentGateReasonCode,
} from "./assignment-gate.js";
export {
  GATE_IDENTITY_REASON_CODES,
  GateIdentityError,
  validateGateIdentityDecision,
} from "./gate-identity.js";
export type { GateIdentityDecision, GateIdentityReasonCode } from "./gate-identity.js";
export {
  CORE_PERSONA_BUNDLE_VERSION,
  CORE_PERSONA_PROFILE_VERSION,
  CORE_PERSONA_REASON_CODES,
  CORE_PERSONA_SOURCE_MANIFEST_SHA256,
  CORE_REFERENCE_PERSONA_IDS,
  CorePersonaError,
  generateCorePersonaBundle,
  isCoreReferencePersonaId,
  validateCorePersonaBundle,
  validateCorePersonaProfile,
  validateCorePersonaProfileShape,
} from "./reference-profiles.js";
export type { CorePersonaBundle, CorePersonaProfile, CorePersonaReasonCode } from "./reference-profiles.js";
export { WORK_BATCH_SCHEMA_VERSION, WORK_BATCH_VERBS, applyWorkBatch, workBatchReceipt } from "./work-batch.js";
export type { WorkBatchOptions, WorkBatchProblem } from "./work-batch.js";
export { KNOWLEDGE_BATCH_SCHEMA_VERSION, KNOWLEDGE_BATCH_VERBS, applyKnowledgeBatch } from "./knowledge-batch.js";
export type { KnowledgeBatchOptions, KnowledgeBatchProblem } from "./knowledge-batch.js";
// TCRN-CROSS-STORY-362: the recall core's public face is the verb's face. The index,
// the selector and the tokenizers stay internal to ./recall.js, where the evaluation
// harness and the tests import them directly; only what the CLI dispatches is barrelled.
// TCRN-CROSS-STORY-364: the artefact-language policy is re-exported because the CLI reads
// it on the recall path (the prompt-language fallback) and the migration executor reads it
// on the write path. Both go through the barrel like every other core consumer.
export {
  applyWriteLanguagePolicy,
  detectLanguage,
  expansionsText,
  KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY,
  languageProviderFromBundle,
  parseLanguageBundle,
  readKnowledgeLanguagePolicy,
  resolveQueryLanguage,
} from "./knowledge-language.js";
export type { KnowledgeLanguageBundle, KnowledgeLanguageProvider } from "./knowledge-language.js";
export { RECALL_CANDIDATE_LIMIT, RECALL_DEFAULT_TAU, recall, recallDocuments } from "./recall.js";
export type { RecallKnowledgeInput, RecallMinutesInput, RecallWorkInput } from "./recall.js";
export {
  probeHost,
} from "./host-probe.js";
// TCRN-CROSS-STORY-466: every product, directory and schema name, and the legacy alias
// table, come from one module.
export {
  ALIAS_TABLE_END_MARKER,
  ALIAS_TABLE_START_MARKER,
  BRAND,
  DIRECTORY,
  DIRECTORY_GLOSSARY,
  ENGINE_REPOSITORY_NAMES,
  LEGACY_BRAND_NAME,
  LEGACY_CONTAINER_DIRECTORY,
  LEGACY_CONTROL_DIRECTORY,
  LEGACY_DEVICE_DIRECTORY,
  LEGACY_ENGINE_NAME,
  LEGACY_EVENTS_DIRECTORY,
  LEGACY_HELPER_NAME,
  LEGACY_KNOWLEDGE_DIRECTORY,
  LEGACY_NAMES,
  LEGACY_PORTAL_NAME,
  LEGACY_REPOSITORY_NAMES,
  LEGACY_SCHEMA_NAMESPACE,
  LOCAL_DIRECTORY_NAMES,
  PLATFORM_ARCHIVE_DIRECTORY,
  SCHEMA_NAMESPACE,
  WORKSPACE_WRITE_LOCK_FILE,
  isLegacySchemaVersion,
  legacyInstalledEnginePath,
  renderLegacyAliasTable,
  renderLibraryReadme,
} from "./names.js";
export type { BrandEntry, DirectoryGlossaryEntry, LegacyNameEntry } from "./names.js";
// TCRN-CROSS-STORY-466 R2 / STORY-467 R4: the old workspace layout, opened read-only for
// chain-validate and for the later import into a library.
export {
  LEGACY_WORKSPACE_REASON_CODES,
  LegacyWorkspaceError,
  findLegacyChainBreak,
  legacyControlDirectory,
  openLegacyWorkspace,
  replayLegacyWorkspace,
  validateLegacyChain,
} from "./legacy-workspace.js";
export type { ChainBreak, ChainBreakKind, ChainReport, LegacySegment, LegacyWorkspace, LegacyWorkspaceReasonCode } from "./legacy-workspace.js";
export { materializeFromGenesis, parseLegacyWorkspaceMetadata } from "./workspace.js";
// TCRN-CROSS-STORY-467 R1: the engine-held file lock that serialises writers.
export { FILE_LOCK_REASON_CODES, FILE_LOCK_SCHEMA_VERSION, FileLockError, acquireFileLock, withFileLock } from "./file-lock.js";
export type { FileLock, FileLockOptions, FileLockReasonCode } from "./file-lock.js";
// TCRN-CROSS-STORY-467 R2: release trust is the install-tree digest.
export {
  INSTALL_TREE_DIGEST_VERSION,
  INSTALL_TREE_REASON_CODES,
  InstallTreeError,
  computeInstallTreeDigest,
  normalizedInstallBytes,
  verifyInstallTree,
} from "./install-tree-digest.js";
export type { InstallTreeDigest, InstallTreeEntry, InstallTreeReasonCode, InstallTreeVerification } from "./install-tree-digest.js";
// TCRN-CROSS-STORY-469 R3, R5: the device directory and the atomic file replacement every
// manifest write goes through.
export {
  DEVICE_HOME_ENTRIES,
  DEVICE_HOME_ENVIRONMENT_VARIABLE,
  DeviceHomeError,
  backupsPath,
  cachePath,
  deviceFilePath,
  deviceHome,
  engineRoot,
  ensureDeviceDirectory,
  libraryDirectoryName,
  lockPath,
  registryPath,
} from "./device-home.js";
export { ATOMIC_FILE_REASON_CODES, ATOMIC_TEMPORARY_PREFIX, AtomicFileError, isAtomicTemporaryName, writeFileAtomic } from "./atomic-file.js";
// TCRN-CROSS-STORY-469 R2: whether config/project.json shows a library's merged project-level settings.
export { configProjectionStatus } from "./library-config.js";
// TCRN-CROSS-STORY-468 R6: an old-layout workspace imported as a library's first stream.
export { defaultImportTarget, importLegacyWorkspace } from "./legacy-import.js";
// TCRN-CROSS-STORY-470 R1: this device's registry of libraries and resolution from a directory.
export { readRegistry, registerLibrary, resolveLibrary } from "./registry.js";
// TCRN-CROSS-STORY-470 R2: the cloud folders a cloud-hosted flag is suggested for.
export { suggestCloudHosted } from "./cloud-roots.js";
// TCRN-CROSS-STORY-470 R3: moving a library, and the tombstone its old place keeps.
export { relocateLibrary } from "./relocate.js";
export { readLibraryTombstone } from "./workspace.js";
// TCRN-CROSS-STORY-470 R5: a project's own host settings naming a library that sits outside it.
export { applyWritableRoots, planWritableRoots } from "./host-writable-roots.js";
export type { AtomicFileReasonCode, AtomicWriteOptions } from "./atomic-file.js";
// TCRN-CROSS-STORY-468 R1: this device's identity in the device directory.
export {
  DEVICE_DISPLAY_NAME_MAX_LENGTH,
  DEVICE_IDENTITY_REASON_CODES,
  DEVICE_SCHEMA_VERSION,
  DeviceIdentityError,
  displayNameFromHostname,
  readDevice,
  readOrCreateDevice,
  setDeviceDisplayName,
  validateDeviceIdentity,
} from "./device-identity.js";
export type { DeviceIdentity, DeviceIdentityReasonCode, ReadOrCreateDeviceOptions } from "./device-identity.js";
// TCRN-CROSS-STORY-469 R1, R6: a library's root, its manifest and README.
export {
  LIBRARY_FILES,
  LIBRARY_FORMAT_VERSION,
  LIBRARY_GITIGNORE,
  LIBRARY_ID_PATTERN,
  LIBRARY_MANIFEST_SCHEMA_VERSION,
  LIBRARY_REASON_CODES,
  LIBRARY_ROOT_ENTRIES,
  LibraryError,
  createLibrary,
  hasLibraryManifest,
  newLibraryId,
  openLibrary,
  validateLibraryManifest,
} from "./ether-library.js";
export type { CreateLibraryOptions, Library, LibraryManifest, LibraryProjectHint, LibraryReasonCode } from "./ether-library.js";
// TCRN-CROSS-STORY-468 R2, R3: each device's stream in a library, appended under this
// machine's lock of the library and committed by its stream manifest.
export {
  AKASHA_REASON_CODES,
  AKASHA_SEGMENT_BYTES_DEFAULT,
  AKASHA_SEGMENT_BYTES_MAXIMUM,
  AkashaError,
  STREAM_MANIFEST_FILE,
  STREAM_MANIFEST_SCHEMA_VERSION,
  appendStreamEvents,
  appendToOwnStream,
  buildStreamEvents,
  clockHighWater,
  emptyStreamManifest,
  listStreamDevices,
  readStreamEvents,
  readStreamManifest,
  segmentName,
  streamDirectory,
  streamEventId,
  validateStreamManifest,
  withLibraryWriteLock,
} from "./akasha.js";
export type {
  AkashaReasonCode,
  AppendOptions,
  EventDraft,
  ReadBytes,
  StreamIdentityScheme,
  StreamManifest,
  StreamOwner,
  StreamReadOptions,
  StreamSegment,
} from "./akasha.js";
// TCRN-CROSS-STORY-468 R3-R5, STORY-470 R4: every stream of a library read (with a timeout per
// file) and replayed merged: the version vector, rejected events and key aliases.
export { AKASHA_READ_TIMEOUT_DEFAULT_MS, compareMergedEvents, readAllStreams } from "./akasha.js";
export type { LibraryRead, LibraryReadOptions, MergedEvent, StreamRead } from "./akasha.js";
export {
  LIBRARY_HEAD_SCHEMA_VERSION,
  libraryHeadDigest,
  libraryWorkspaceMetadata,
  materializeLibrary,
  materializeLibraryRead,
  recordAliases,
} from "./workspace.js";
export type { KeyAlias, LibraryReplay, LibraryStreamHead, RejectedEvent } from "./workspace.js";
