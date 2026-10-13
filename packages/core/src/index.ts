// SPDX-License-Identifier: Apache-2.0

export { FRAMEWORK_VERSION } from "./framework-version.js";
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
  AGENTS_NAVIGATION_SETTING,
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
  readAgentsNavigation,
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
  admitTemplateInWorkspace,
  assertWorkGatesClear,
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
  recordMinutes,
  recoverWorkspace,
  releaseGate,
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
// TCRN-CROSS-STORY-484 R3, TCRN-CROSS-STORY-508 R1, R2, R4: models.category and models.tiers, two
// tables of records; readModelsCategory and readModelsTiers are the effective tables of a settings
// list, and baseModelsTier is a category's base record, the one a rule naming the category gets.
export { MODELS_CATEGORY_SETTING_KEY } from "./models-category.js";
export type { ModelsCategories, ModelsCategoryRecord } from "./models-category.js";
export { MODELS_TIERS_SETTING_KEY, baseModelsTier, readModelsCategory, readModelsTiers } from "./models-tiers.js";
export type { ModelsTierRecord, ModelsTiers } from "./models-tiers.js";
// TCRN-CROSS-STORY-508 R3, R4 (MIN-236 D5): the three models.escalation settings and the escalation
// along the order of models.tiers. readModelsEscalation is their effective values; resolveModelsTier,
// a pure function, is the record a rule naming a category gets after the rejections its caller counts
// and passes in, the engine keeping no count.
export { readModelsEscalation, resolveModelsTier } from "./models-escalation.js";
export type { ModelsEscalation, ModelsTierResolution, ModelsTierResolutionInput } from "./models-escalation.js";
// TCRN-CROSS-STORY-484 R1: the project's custom variables, records of the library's variable
// collection; a credential-shaped value or description is refused when written.
export { VARIABLE_TYPES, listVariables, removeVariable, setVariable } from "./variables.js";
export type { Variable, VariableType } from "./variables.js";
// TCRN-CROSS-STORY-484 R2: the system and custom variable sections of AGENTS.md, and what each
// leaves out (an absolute path, a credential shape) with its reason.
export { renderCustomVariablesSection, renderSystemVariablesSection, writeVariablesSections } from "./variables-sections.js";
export type { VariablesSectionsResult, WithheldEntry } from "./variables-sections.js";
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
// TCRN-CROSS-STORY-473 R1: the Story scope validator, its refusal text and the scope-based
// Owner-decider probe retired with the ten-block contract; the headings, the summary and the
// template floor stay.
export {
  STORY_SCOPE_HEADINGS,
  deriveWorkSummary,
  validateTemplateScope,
} from "./story-scope-compliance.js";
// TCRN-CROSS-STORY-473 R2, R3: the field reader, which work-show and work-list project, and the two
// fields a Story must have, which work-draft names.
export { STORY_REQUIRED_FIELDS, storyFields } from "./story-fields.js";
export type { StoryFields } from "./story-fields.js";
export type {
  ScopeTemplateDefinition,
  StoryScopeHeading,
  StoryScopeProblem,
  StoryScopeProblemCode,
  StoryScopeSection,
  StoryScopeValidation,
} from "./story-scope-compliance.js";
// TCRN-CROSS-SUB-414 (R16): knowledgeStorePath and readKnowledgeStoreMarker left the barrel with the
// CLI's rebind after each chain write, the last caller either had in a recorded consumer root. Core
// finds the crest through knowledgeStorePath inside core, and the tests that read the projected
// marker import it from knowledge-core.ts, as artifact-store.ts's readers do above.
// TCRN-CROSS-SUB-425: removeKnowledgeUnit, the removal reasons and the read status filter are the
// CLI's knowledge-remove and the --status of knowledge-list and recall.
export {
  KNOWLEDGE_CONFLICT_SCORE_THRESHOLD,
  KNOWLEDGE_CORE_VERSION,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_METADATA_SCHEMA_VERSION,
  KNOWLEDGE_PROVENANCE_POLICY,
  KNOWLEDGE_REASON_CODES,
  KNOWLEDGE_REMOVAL_REASONS,
  KNOWLEDGE_STATUS_FILTERS,
  KNOWLEDGE_STORE_SCHEMA_VERSION,
  KNOWLEDGE_STORE_SCOPES,
  KnowledgeCoreError,
  captureKnowledgeUnit,
  createKnowledgeArticle,
  createKnowledgeUnit,
  calculateKnowledgeSourceDigest,
  checkKnowledgeSources,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  migrateKnowledgeBodies,
  knowledgeConflictHits,
  knowledgeLinkIndexCountsForTest,
  knowledgeRelevanceScore,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  recoverKnowledgeStore,
  refreshKnowledgeArticle,
  removeKnowledgeUnit,
  reverifyKnowledgeUnit,
  updateKnowledgeStalenessPolicy,
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
  KnowledgeReadOptions,
  KnowledgeReasonCode,
  KnowledgeRemovalReason,
  KnowledgeRetrievalDisposition,
  KnowledgeScope,
  KnowledgeStalenessPolicy,
  KnowledgeStatusFilter,
  KnowledgeStoreScope,
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
  EVENT_PAYLOAD_OPTIONAL_EXTRAS,
  WRITE_AUTHORIZATION_EXTRAS,
  WRITE_SURFACES,
  assertActorId,
  buildEventPayload,
  buildActorAttestationEnableRecord,
  validateActorAttestationEnableRecord,
  buildActorAttestationRegistration,
  writeAuthorizationExtras,
  writeAuthorizationProblem,
} from "./actor-attestation.js";
export type { WriteAuthorization, WriteSurface } from "./actor-attestation.js";
export type {
  DependencyRecord,
  DependencyWorkReference,
  DependencyReasonCode,
  DependencyKind,
  DependencyStatus,
} from "./dependency.js";
// TCRN-CROSS-STORY-475 R3: the conference write path, its distillation and its position binding
// are retired; the record validators, the read helper and the historical vocabulary stay.
export {
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
} from "./conference.js";
// TCRN-CROSS-STORY-475 R1, R2: minutes, recorded in one write (recordMinutes above) and read with
// the minutes a conference close wrote. TCRN-CROSS-SUB-426 (MIN-239 D6): the reads give the valid
// decisions unless asked for the obsolete ones or all of them.
export { DECISION_STATUS_FILTERS, minutesById, minutesView } from "./minutes.js";
export type { DecisionStatusFilter } from "./minutes.js";
// TCRN-CROSS-STORY-526 (MIN-256; TCRN-CROSS-SUB-451): a refused configuration write that cites an
// Owner decision (--decided-in minutes:<id>#D<n>) is checked against the minutes before it goes through.
export {
  DECIDED_IN_VALUE_SHAPE,
  WRITE_AUTHORIZATION_DECIDER,
  WRITE_AUTHORIZATION_INVALID,
  WRITE_AUTHORIZATION_REASONS,
  WriteAuthorizationError,
  decisionNamesTarget,
  parseDecidedIn,
  verifyWriteAuthorization,
} from "./write-authorization.js";
export type {
  VerifiedWriteAuthorization,
  VerifyWriteAuthorizationInput,
  WriteAuthorizationErrorDetails,
  WriteAuthorizationReason,
} from "./write-authorization.js";
export type {
  ConferenceRequest,
  ConferencePosition,
  ConferenceMinutes,
  ConferenceReasonCode,
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
// TCRN-CROSS-STORY-472 R2, R3: relations between work records; the forward direction is stored,
// the reverse projected when read.
export { RELATION_NAMES, REVERSE_RELATION_NAMES, relationFilter, workRelations } from "./work-relations.js";
export type { WorkRelationsInput } from "./work-relations.js";
export { KNOWLEDGE_BATCH_SCHEMA_VERSION, KNOWLEDGE_BATCH_VERBS, applyKnowledgeBatch } from "./knowledge-batch.js";
export type { KnowledgeBatchOptions, KnowledgeBatchProblem } from "./knowledge-batch.js";
// TCRN-CROSS-STORY-362: the recall core's public face is the verb's face. The index,
// the selector and the tokenizers stay internal to ./recall.js, where the evaluation
// harness and the tests import them directly; only what the CLI dispatches is barrelled.
// TCRN-CROSS-STORY-364: the artefact-language policy is re-exported because the CLI reads
// it on the recall path (the prompt-language fallback) and the migration executor reads it
// on the write path. Both go through the barrel like every other core consumer.
// TCRN-CROSS-SUB-311: expansionsText left the barrel when the recall verb began reading its
// cards through readRecallCards, which flattens a card's phrasings inside core; the recorder
// and the tests that call it read ./knowledge-language.js directly.
export {
  applyWriteLanguagePolicy,
  detectLanguage,
  KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY,
  languageProviderFromBundle,
  parseLanguageBundle,
  readKnowledgeLanguagePolicy,
  resolveQueryLanguage,
} from "./knowledge-language.js";
export type { KnowledgeLanguageBundle, KnowledgeLanguageProvider } from "./knowledge-language.js";
export { RECALL_DEFAULT_TAU, recall, recallDocuments } from "./recall.js";
// TCRN-CROSS-STORY-474 R1, R2: what recall indexes, read from a state, and how a hit reads as one
// line; the verb builds its input here, as the prompt hook does.
export { formatRecallLine, readRecallCards, recallContextLines, recallInputsFromState } from "./recall-inputs.js";
// TCRN-CROSS-SUB-426 (MIN-239 D5): the obsolete decisions a recalled work record or card points at,
// and those of the minutes a work record was decided in, as work-show answers them.
export { recallDecisionHints, workObsoleteDecisions } from "./recall-inputs.js";
// TCRN-CROSS-STORY-476 R4: the line a done transition and minutes-record answer, asking whether there
// is knowledge to extract and naming the cards a card about it could conflict with. R5: recall reads
// the library's crest and this user's (readRecallCards above), and a read verb names its store.
export { knowledgeHintFor, readKnowledgeHintCards } from "./knowledge-hint.js";
export type { KnowledgeHint } from "./knowledge-hint.js";
// TCRN-CROSS-STORY-485 R1 to R4: gate declarations in the library, the gates a change needs, running
// them into this device's cache, and the check a Story passes on its way to done.
export { listGates, removeGate, setGate } from "./gates-config.js";
export { planGates } from "./gates-plan.js";
export { runGates } from "./gates-run.js";
export { assertDoneGates } from "./gates-done.js";
export type { DoneGatesVerdict } from "./gates-done.js";
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
// TCRN-CROSS-STORY-477 R1, R3, R4, R5: the one Einzbern hook a host's settings carry, rendered
// with everything of the old harness taken out.
export { HOST_HOOK_HOSTS, HOST_HOOK_SCOPES, applyHostHooks, planHostHooks, readHostHooks } from "./host-hooks.js";
// TCRN-CROSS-STORY-477 R2, AC3: what that hook answers for a prompt in a registered project, and
// (TCRN-CROSS-STORY-478 R4) what the two pointer hooks answer.
export { hookEventName, hookHost, navigationPointerAnswer, promptRecallContext } from "./hook-recall.js";
// TCRN-CROSS-STORY-478 R1 (TCRN-CROSS-SUB-315): a library's project-level configuration records, set
// and removed as events and merged like its settings.
export { configRecord, configRecords, removeConfigRecord, setConfigRecord } from "./config-records.js";
export type { ConfigRecord } from "./config-records.js";
// TCRN-CROSS-STORY-478 R1, R2, R6 (TCRN-CROSS-SUB-316): the managed-section writer.
export { applyManagedWrite, managedSectionRecordsFor, parseManagedFile, planManagedWrite } from "./managed-sections.js";
export type { ManagedSectionRecord } from "./managed-sections.js";
// TCRN-CROSS-STORY-478 R3, R4, R5 (TCRN-CROSS-SUB-317): the sections of AGENTS.md and CLAUDE.md, the
// navigation lines, and the three dispositions of a section the user changed.
export {
  NAVIGATION_LINES,
  disableAgentsSection,
  ensureClaudeImport,
  renderAgentsSections,
  resolveAgentsProject,
  resolveAgentsSection,
} from "./agents-sections.js";
export type { SectionAction } from "./agents-sections.js";
// TCRN-CROSS-STORY-483 R1 (TCRN-CROSS-SUB-335): the four Command Spell rules this engine ships, each
// with its version and its Chinese and English text.
export { BUILT_IN_RULES, builtInRule, ruleBody } from "./rules-catalog.js";
export type { BuiltInRule, BuiltInRuleId } from "./rules-catalog.js";
// TCRN-CROSS-STORY-483 R2, R3 (TCRN-CROSS-SUB-336): the rules a project has enabled, the state each
// of them is in, and enabling and disabling one.
export { RULE_STATES, disableRule, enableRule, listRules } from "./rules.js";
export type { RuleChange, RuleState, RuleStatus } from "./rules.js";
// TCRN-CROSS-STORY-471 R2, R3: the engine versions installed on this device, the pointer to the one
// in use, and switching between them.
export { listEngines, rollbackEngine, updateEngine } from "./engine-home.js";
// TCRN-CROSS-STORY-481 R4 (TCRN-CROSS-SUB-331): the oldest Node.js this engine runs on, and the check
// that refuses an older one with ENGINE_NODE_TOO_OLD {required, actual}. The CLI entry and the hook
// entry import node-floor.js itself rather than this barrel: they ask before the rest of the engine loads.
export { NODE_FLOOR, NODE_FLOOR_REASON_CODES, NodeFloorError, assertNodeFloor, meetsNodeFloor } from "./node-floor.js";
export type { NodeFloorReasonCode } from "./node-floor.js";
// TCRN-CROSS-STORY-471 R4: whether every device of a library runs an engine that may meet the next
// format, and the hint naming the ones to upgrade first.
export { libraryUpgradeReadiness } from "./akasha.js";
// TCRN-CROSS-STORY-479: only the skill renderer and its install file map have consumers outside core.
export { renderSkillMarkdown } from "./skill-render.js";
export { SKILL_COPIES_FILES } from "./skill-copies.js";
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
export { compareMergedEvents, readAllStreams } from "./akasha.js";
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
// TCRN-CROSS-STORY-480 R4, AC5 (TCRN-CROSS-SUB-326, SUB-327): doctor, the eight checks of this device
// and one project, each green or naming its red; the doctor verb reads it, and every setup apply
// reports it as its self-check.
export { DOCTOR_CHECKS, DOCTOR_CHECK_REASON_CODES, DOCTOR_REASON_CODES, runDoctor } from "./doctor.js";
export type { DoctorCheck, DoctorCheckName, DoctorInput, DoctorReasonCode } from "./doctor.js";
// TCRN-CROSS-STORY-480 R1 to R6 (TCRN-CROSS-SUB-323 to SUB-327): setup, the installation wizard: a
// plan that writes nothing and the apply of a confirmed plan, in six modes. fresh installs
// (setup-fresh.ts); restore passes eight checks of the library first (setup-restore.ts); update,
// rollback, repair and uninstall keep an installation that is there (setup-maintain.ts); migrate
// names what it found from before the rename.
export { SETUP_MODES, SETUP_REASON_CODES, SetupError, applySetup, detectSetupContext, planSetup } from "./setup.js";
export type { SetupApplied, SetupContext, SetupMode, SetupOptions, SetupPlan, SetupReasonCode } from "./setup.js";
export { FRESH_ENGINE_TREE } from "./setup-fresh.js";
export { RESTORE_CHECKS, RESTORE_REASON_CODES, RestoreError, verifyRestore } from "./setup-restore.js";
export type { RestoreCheck, RestoreReasonCode, RestoreVerification } from "./setup-restore.js";
export { RELEASE_REASON_CODES, ReleaseSourceError } from "./setup-maintain.js";
export type { ReleaseReasonCode } from "./setup-maintain.js";
// The launcher a host's hook runs, which the setup self-check runs the way a host does.
export { hookLauncherPath } from "./host-hooks.js";

export * from "./project-scope.js";

export * from "./involved-projects.js";

export * from "./project-chain.js";
