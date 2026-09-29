// SPDX-License-Identifier: Apache-2.0

import {
  applyMachineSettingRemove,
  applyMachineSettingSet,
  withWorkspaceWriteLock,
  writtenRecordIds,
  createKnowledgeArticle,
  createKnowledgeUnit,
  checkKnowledgeSources,
  createProject,
  applyKnowledgeBatch,
  applyWorkBatch,
  createWork,
  deleteProject,
  deleteWork,
  evaluateKnowledgeFreshness,
  exportKnowledgeCheckpoint,
  exportWorkspace,
  initializeKnowledgeStore,
  initializeLibrary,
  captureKnowledgeUnit,
  listKnowledgeMetadata,
  materializeWorkspace,
  migrateKnowledgeBodies,
  workBatchReceipt,
  workspaceBudgets,
  readKnowledgeBody,
  readKnowledgeSnippet,
  recoverKnowledgeStore,
  rebaseKnowledgeStore,
  refreshKnowledgeArticle,
  reverifyKnowledgeUnit,
  recoverWorkspace,
  createSnapshotManifest,
  readSnapshotManifestFile,
  verifySnapshotManifest,
  transitionWork,
  assertWorkGatesClear,
  releaseGate,
  annotateWork,
  updateProject,
  validateKnowledgeStore,
  validateWorkspace,
  assertGeneratedArtifactsRoot,
  validateSettingValue,
  listArtifacts,
  putArtifact,
  verifyArtifacts,
  readSettingsCatalog,
  readInstallManifest,
  readMachineSettingsCatalog,
  readVocabulary,
  STORY_SCOPE_HEADINGS,
  machineSettingsPath,
  FRAMEWORK_VERSION,
  SETTINGS_CATALOG,
  removeWorkspaceSetting,
  setWorkspaceSetting,
  admitTemplateInWorkspace,
  readTemplateDocumentFile,
  RECALL_CANDIDATE_LIMIT,
  KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY,
  KNOWLEDGE_STORE_SCOPES,
  knowledgeHintFor,
  readKnowledgeHintCards,
  readRecallCards,
  assertDoneGates,
  listGates,
  planGates,
  removeGate,
  runGates,
  setGate,
  languageProviderFromBundle,
  parseLanguageBundle,
  RECALL_DEFAULT_TAU,
  recall,
  readKnowledgeLanguagePolicy,
  recallContextLines,
  recallDocuments,
  recallInputsFromState,
  formatRecallLine,
  resolveQueryLanguage,
  templateBindingFromWorkRecord,
  probeHost,
  validateTemplateDocument,
  materializeFromGenesis,
  openLegacyWorkspace,
  validateLegacyChain,
  hasLibraryManifest,
  openLibrary,
  readAllStreams,
  materializeLibraryRead,
  recordAliases,
  LIBRARY_ID_PATTERN,
  configProjectionStatus,
  defaultImportTarget,
  importLegacyWorkspace,
  readRegistry,
  registerLibrary,
  resolveLibrary,
  suggestCloudHosted,
  readLibraryTombstone,
  relocateLibrary,
  listEngines,
  rollbackEngine,
  updateEngine,
  libraryUpgradeReadiness,
  RELATION_NAMES,
  REVERSE_RELATION_NAMES,
  relationFilter,
  workRelations,
  minutesById,
  minutesView,
  recordMinutes,
  BRAND,
  SKILL_COPIES_FILES,
  computeInstallTreeDigest,
  renderSkillMarkdown,
  STORY_REQUIRED_FIELDS,
  storyFields,
  AGENTS_NAVIGATION_SETTING,
  readAgentsNavigation,
  renderAgentsSections,
  resolveAgentsProject,
  resolveAgentsSection,
  managedSectionRecordsFor,
  listVariables,
  removeVariable,
  renderCustomVariablesSection,
  setVariable,
  writeVariablesSections,
  disableRule,
  enableRule,
  listRules,
  applySetup,
  hookLauncherPath,
  planSetup,
  runDoctor,
} from "../../core/src/index.js";
import type { KnowledgeLanguageBundle, KnowledgeLanguageProvider, RuleChange, RuleStatus, SectionAction, StoryFields, Variable, WithheldEntry, WorkRelationsInput } from "../../core/src/index.js";
import type { DoctorCheck, SetupApplied, SetupOptions, SetupPlan } from "../../core/src/index.js";
import type {
  DoneGatesVerdict,
  KnowledgeCategory,
  KnowledgeFreshnessState,
  KnowledgeHint,
  KnowledgeKind,
  KnowledgeStoreScope,
} from "../../core/src/index.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalExternalKey, canonicalJson, canonicalSha256, deriveStableId } from "../../protocol/src/index.js";
import { isWorkStatus } from "../../protocol/src/index.js";
import type { JsonValue, PlannedDeliveryKind, WorkRecord, WorkStatus } from "../../protocol/src/index.js";
// ProjectRecord is a core type, not a protocol one. The protocol package never exported
// it, so this import resolved to nothing; import elision hid the mistake from every
// runtime check the repo had.
import type { ProjectRecord } from "../../core/src/index.js";

// einzbern-release-verify's inputs: the unpacked tree and its stated install-tree digest.
// The trust root, bundle, subject, repository, workflow and clock it took are retired with
// the signature chain (TCRN-CROSS-STORY-467 R2).
export const RELEASE_REQUIRED_ARGUMENTS = [
  "tree",
  "sha256",
] as const;

export type ReleaseRequiredArgument =
  (typeof RELEASE_REQUIRED_ARGUMENTS)[number];

export function missingReleaseArguments(
  supplied: Readonly<Record<string, string | undefined>>,
): readonly ReleaseRequiredArgument[] {
  return RELEASE_REQUIRED_ARGUMENTS.filter((name) => !supplied[name]);
}

export class WorkflowCliError extends Error {
  readonly reasonCode: string;
  // TCRN-CROSS-INC-378: string facts a caller needs beside the code, such as whether the
  // event was committed; the bin prints the keys it allows on stderr.
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: string, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "WorkflowCliError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface CliIo {
  write(value: string): void;
}

function fail(reasonCode: string, message: string): never {
  throw new WorkflowCliError(reasonCode, message);
}

function parseArguments(arguments_: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  if (arguments_.some((value) => value.length > 65_536)) {
    fail("CLI_INPUT_OVERSIZED", "CLI arguments exceed the local input limit");
  }
  const values: Record<string, string> = {};
  let index = 0;
  while (index < arguments_.length) {
    const token = arguments_[index];
    let name: string;
    let value: string;
    if (token !== undefined && token.startsWith("--") && token.includes("=")) {
      // Attached form --flag=value: split on the FIRST "=" so the value may itself
      // contain "=" or legitimately begin with "--" (unrepresentable in two-token form).
      const equalsAt = token.indexOf("=");
      name = token.slice(2, equalsAt);
      value = token.slice(equalsAt + 1);
      index += 1;
    } else {
      const next = arguments_[index + 1];
      // Two-token form is unchanged: a value beginning with "--" is still rejected,
      // which doubles as missing-value (undefined next) detection.
      if (!token?.startsWith("--") || next === undefined || next.startsWith("--")) {
        fail("CLI_ARGUMENT_MALFORMED", String(token ?? "missing"));
      }
      name = token.slice(2);
      value = next;
      index += 2;
    }
    if (!allowed.includes(name)) {
      fail("CLI_ARGUMENT_UNKNOWN", name);
    }
    if (Object.hasOwn(values, name)) {
      fail("CLI_ARGUMENT_DUPLICATE", name);
    }
    values[name] = value;
  }
  return values;
}

function required(values: Readonly<Record<string, string>>, names: readonly string[]): void {
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) {
    fail("CLI_ARGUMENT_MISSING", missing.join(","));
  }
}

// CQ-05(c): the single arbiter for integer-valued flags. A syntactically malformed value
// fails at the CLI boundary with CLI_ARGUMENT_MALFORMED naming the offending flag, instead
// of reaching core as NaN and being reported under a semantic reason code. The minimum is
// optional; only non-integers and values below it are rejected here, and every other
// integer reaches core for its own judgement.
function integerValue(values: Readonly<Record<string, string>>, name: string, minimum: number = Number.MIN_SAFE_INTEGER): number {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("CLI_ARGUMENT_MALFORMED", name);
  }
  return value;
}

// STORY-178: the file↔pg migration target. Only `file` and `pg` are legal; the
// migration verbs refuse anything else by derivation rather than a hard-coded
// list of typo'd backends.
function boundedInteger(values: Readonly<Record<string, string>>, name: string): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("CLI_ARGUMENT_MALFORMED", name);
  }
  return value;
}

function listValue(value: string | undefined): readonly string[] {
  if (!value || value === "-") return [];
  const values = value.split(",");
  if (values.some((entry) => entry.length === 0)) fail("CLI_ARGUMENT_MALFORMED", "list");
  return values;
}

// INIT-008: a sprint member reference is a qualified cross-partition pointer. The CLI
// accepts the ergonomic `library:<id>#work:<id>` spelling on one flag (an old-layout
// `workspace:<id>` still names its workspace; TCRN-CROSS-STORY-469) and parses it into the
// {workspaceId, workId} object the core stores (# is only the input delimiter, never the
// stored form). Both halves are whole protocol ids; the core re-validates them.
function sprintReference(value: string): { readonly workspaceId: string; readonly workId: string } {
  const hash = value.indexOf("#");
  if (hash < 0) fail("CLI_ARGUMENT_MALFORMED", "sprint must be library:<id>#work:<id>");
  const workspaceId = value.slice(0, hash);
  const workId = value.slice(hash + 1);
  if (!LIBRARY_ID_PATTERN.test(workspaceId) || !/^work:[a-z0-9][a-z0-9._-]{0,127}$/u.test(workId)) {
    fail("CLI_ARGUMENT_MALFORMED", "sprint must be library:<id>#work:<id>");
  }
  return { workspaceId, workId };
}

// TCRN-CROSS-STORY-472 R1: the kinds a new record may take. Incident and Release stay readable
// (work-list --kind still filters by them) but are refused as new records, with the remedy the
// engine gives for the same refusal.
const CREATABLE_WORK_KINDS: readonly string[] = ["Initiative", "Epic", "Story", "Subtask"];
const RETIRED_WORK_KINDS: readonly string[] = ["Incident", "Release"];
const WORK_KIND_RETIRED_REMEDY = "open a Story with a fixes relation (work-create --kind Story --fixes <work id>)";

function assertCreatableKind(kind: string | undefined): void {
  if (kind === undefined) return;
  if (RETIRED_WORK_KINDS.includes(kind)) {
    throw new WorkflowCliError("WORK_KIND_RETIRED", `a new ${kind} is no longer created: ${WORK_KIND_RETIRED_REMEDY}`, { remedy: WORK_KIND_RETIRED_REMEDY });
  }
  if (!CREATABLE_WORK_KINDS.includes(kind)) fail("CLI_ARGUMENT_MALFORMED", `kind=${kind}`);
}

// TCRN-CROSS-STORY-472 R2, R4: the relation flags of work-create and work-annotate. Each names one
// relation's whole list ("-" is the empty list, which on an annotation removes that relation);
// --decided-by is the older name of --decided-in and writes the same advisory:decided-by list.
const RELATION_FLAGS = ["blocked-by", "implements", "supersedes", "fixes", "decided-in"] as const;

function relationsInput(values: Readonly<Record<string, string>>): { readonly relations?: WorkRelationsInput } {
  const relations: { blockedBy?: readonly string[]; implements?: readonly string[]; supersedes?: readonly string[]; fixes?: readonly string[]; decidedIn?: readonly string[] } = {};
  if (values["blocked-by"] !== undefined) relations.blockedBy = listValue(values["blocked-by"]);
  if (values.implements !== undefined) relations.implements = listValue(values.implements);
  if (values.supersedes !== undefined) relations.supersedes = listValue(values.supersedes);
  if (values.fixes !== undefined) relations.fixes = listValue(values.fixes);
  if (values["decided-in"] !== undefined) relations.decidedIn = listValue(values["decided-in"]);
  return Object.keys(relations).length === 0 ? {} : { relations };
}

// TCRN-CROSS-STORY-472 R3: work-list --relation <name>=<id>, a forward or a reverse name.
function relationArgument(value: string): { readonly name: string; readonly id: string } {
  const separator = value.indexOf("=");
  const name = separator < 0 ? "" : value.slice(0, separator);
  const id = separator < 0 ? "" : value.slice(separator + 1);
  if (!([...RELATION_NAMES, ...REVERSE_RELATION_NAMES] as readonly string[]).includes(name) || id.length === 0) {
    fail("CLI_ARGUMENT_MALFORMED", `relation must be <name>=<id> with a name among ${[...RELATION_NAMES, ...REVERSE_RELATION_NAMES].join(", ")}`);
  }
  return { name, id };
}

// TCRN-CROSS-STORY-473 R2 (MIN-227 D8): a Story's goal, acceptance and free body, as flags of
// work-create and work-annotate. A Story is created only with a goal and an acceptance -- these
// flags, or the Goal and Acceptance Criteria blocks of a --scope, which is still taken -- and the
// engine refuses one without either with WORK_STORY_FIELD_REQUIRED naming the field.
const STORY_FIELD_FLAGS = ["goal", "acceptance", "body"] as const;

function storyFieldsInput(values: Readonly<Record<string, string>>): { readonly goal?: string; readonly acceptance?: string; readonly body?: string } {
  return {
    ...(values.goal === undefined ? {} : { goal: values.goal }),
    ...(values.acceptance === undefined ? {} : { acceptance: values.acceptance }),
    ...(values.body === undefined ? {} : { body: values.body }),
  };
}

// Unified nullable-flag spelling: "-" is the canonical null sentinel and an omitted
// flag is null; "null" is a deprecated alias accepted this release for external
// compatibility (see COMMAND_CATALOG deprecatedAliases and the agent-integration doc).
function nullableValue(value: string | undefined): string | null {
  return value === undefined || value === "-" || value === "null" ? null : value;
}

function nullableIntegerValue(values: Readonly<Record<string, string>>, name: string): number | null {
  const raw = values[name];
  if (raw === "-" || raw === "null") return null;
  return integerValue(values, name);
}

function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  fail("CLI_ARGUMENT_MALFORMED", name);
}


// TCRN-CROSS-STORY-364 requirement 3: the card write paths -- knowledge-capture,
// knowledge-create and knowledge-batch's create members (conference-close --distill retired
// with the conference write verbs, TCRN-CROSS-STORY-475 R3) --
// all reach buildMetadata, which refuses fail-closed on a language-configured workspace
// unless it is handed the economy-tier model's answers. The CLI is where those answers
// enter: --language-bundle names a file the Agent wrote after asking the economy-tier model
// configured for the current host. The CLI reads a file and hands over data; it calls no model, and
// the offline leg of verify:p1 still measures that nothing here can.
function readLanguageBundle(path: string): KnowledgeLanguageBundle {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE", `${path}: ${(error as { message?: string }).message ?? "unreadable"}`);
  }
  try {
    return parseLanguageBundle(document);
  } catch (error) {
    fail(String((error as { reasonCode?: unknown }).reasonCode ?? "KNOWLEDGE_LANGUAGE_MODEL_UNAVAILABLE"), String((error as { message?: string }).message ?? path));
  }
}

/** The provider for one card, or none when the caller named no bundle. */
function languageProviderFor(path: string | undefined, cardKey?: string): KnowledgeLanguageProvider | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const bundle = readLanguageBundle(path);
  return cardKey === undefined || cardKey.length === 0
    ? languageProviderFromBundle(bundle)
    : languageProviderFromBundle(bundle, cardKey);
}

/** The mutation options one card write carries: the provider, or nothing at all. */
function languageOptions(path: string | undefined, cardKey?: string, host?: string): { readonly languageProvider?: KnowledgeLanguageProvider; readonly host?: string } {
  const provider = languageProviderFor(path, cardKey);
  return {
    ...(provider === undefined ? {} : { languageProvider: provider }),
    ...(host === undefined ? {} : { host }),
  };
}

/** One provider per card key the bundle carries, for the members of a batch. */
function languageProvidersFor(path: string | undefined): ReadonlyMap<string, KnowledgeLanguageProvider> | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const bundle = readLanguageBundle(path);
  const providers = new Map<string, KnowledgeLanguageProvider>();
  for (const cardKey of Object.keys(bundle.expansions)) providers.set(cardKey, languageProviderFromBundle(bundle, cardKey));
  if (!providers.has(KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY)) {
    providers.set(KNOWLEDGE_LANGUAGE_BUNDLE_FALLBACK_KEY, languageProviderFromBundle(bundle));
  }
  return providers;
}

function jsonValue(value: string | undefined, name: string): unknown {
  try {
    return JSON.parse(value ?? "");
  } catch {
    fail("PROFILE_INPUT_INVALID", name);
  }
}

// TCRN-CROSS-STORY-475 R1: the decisions of minutes-record from a JSON file (an array of strings),
// for decisions whose text holds a comma, which a list flag would split.
function decisionsFromFile(path: string): readonly string[] {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("CLI_ARGUMENT_MALFORMED", `decisions-file ${path}: ${(error as { message?: string }).message ?? "unreadable"}`);
  }
  if (!Array.isArray(document) || !document.every((entry) => typeof entry === "string")) {
    fail("CLI_ARGUMENT_MALFORMED", "decisions-file holds a JSON array of decision texts");
  }
  return document as readonly string[];
}

// INC-244: a successful workspace event must not leave the derived knowledge store frozen at the
// previous high water. TCRN-CROSS-SUB-414 (MIN-235 D7) keeps that purpose without a write: a
// library crest's marker is projected by every knowledge read at the chain head the read replayed,
// so a chain write leaves nothing to rebind. The knowledge rebind that ran after every chain write
// here -- a rebase that took the crest's claim and rewrote its store.json, which two devices
// writing one library contended for -- is gone; a chain write neither reads nor writes the crest.

// TCRN-CROSS-STORY-467 R1: the record ids the last write touched, for the receipt. Set by
// withWriteLock, read once by the receipt writer, cleared at the start of every command.
let lastWrittenIds: readonly string[] | null = null;

function writtenIdsOf(result: unknown, sinceVersion: number | null): readonly string[] {
  if (sinceVersion === null || result === null || typeof result !== "object") return [];
  const candidate = (result as { readonly state?: unknown }).state ?? result;
  if (candidate === null || typeof candidate !== "object" || !Array.isArray((candidate as { readonly events?: unknown }).events)) return [];
  return writtenRecordIds(candidate as Awaited<ReturnType<typeof materializeWorkspace>>, sinceVersion);
}

// TCRN-CROSS-STORY-467 R1: a write verb holds the engine write lock for its whole sequence
// -- the before-read and the write -- so nothing interleaves; the engine write functions take the
// same lock again (it is re-entrant within the flow). There is no caller-supplied version: the
// engine reads the latest state under the lock. TCRN-CROSS-SUB-414: the knowledge rebind that
// followed the write, the one reader of the instant passed here, is gone (see above).
async function withWriteLock<T>(workspace: string, _at: string, operation: () => Promise<T>): Promise<T> {
  return withWorkspaceWriteLock(workspace, async () => {
    let before: { readonly version: number } | null = null;
    try {
      const state = await materializeWorkspace(workspace);
      before = { version: state.version };
    } catch {
      // Recovery verbs deliberately repair residue that makes a pre-read fail.
      // Their own operation remains the authority for whether repair is allowed.
    }
    const result = await operation();
    lastWrittenIds = writtenIdsOf(result, before?.version ?? null);
    return result;
  });
}

function consumeWrittenIds(): readonly string[] | null {
  const ids = lastWrittenIds;
  lastWrittenIds = null;
  return ids;
}

// WSB-1: the mutated record's identity, projected additively so agents never have
// to read views/index.json off-disk to learn the id they just created.
function projectSummary(record: ProjectRecord): Readonly<Record<string, string | number | boolean>> {
  return { id: record.id, revision: record.revision, tombstone: record.tombstone };
}

// INIT-014 (TCRN-AOS-INC-004): the summary carries `externalKey`.
//
// It did not, and `export` — the only read that did — refuses any workspace whose
// canonical form exceeds one MiB, which two of this platform's four chains
// already do. A record id is a one-way digest of its key, so a consumer on the
// paginated path could show a whole work tree and name nothing in it; the one
// downstream reader resorted to re-deriving keys by brute-force digest match,
// which only works for records that follow the naming convention and silently
// leaves the rest anonymous. Returning the key the record already holds costs
// one field and removes that entire class of workaround.
function workSummary(record: WorkRecord): Readonly<Record<string, unknown>> {
  const templateBinding = templateBindingFromWorkRecord(record);
  return {
    id: record.id,
    externalKey: record.externalKey,
    kind: record.kind,
    status: record.status,
    projectId: record.projectId,
    parentId: record.parentId,
    revision: record.revision,
    tombstone: record.tombstone,
    scopeDigest: record.scopeDigest ?? null,
    title: record.title ?? null,
    // TCRN-CROSS-STORY-363. Projected as null when the record carries no summary
    // field, so a listing has one column shape whether or not the record predates
    // the field. The absent-vs-null distinction matters on the chain, where it
    // decides whether a view goes stale; it does not matter to a reader.
    summary: record.summary ?? null,
    createdAt: record.createdAt ?? null,
    labels: record.labels ?? [],
    ...(templateBinding === null ? {} : { templateBinding }),
  };
}

function workScope(record: WorkRecord): string {
  const entry = record.extensions["advisory:scope"];
  const value = entry?.value;
  return typeof value === "string" ? value : "";
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

// TCRN-CROSS-STORY-363. One lowercased haystack per record, built from the four
// fields a reader would search by. Labels join on a space so a two-label record
// cannot produce a match that spans two labels. TCRN-CROSS-STORY-473: a Story
// written with a goal, an acceptance and a body carries no scope, so those three
// are searched too.
function workSearchText(record: WorkRecord): string {
  const fields = storyFields(record);
  return [
    record.externalKey,
    record.title ?? "",
    record.summary ?? "",
    (record.labels ?? []).join(" "),
    workScope(record),
    fields.goal ?? "",
    fields.acceptance ?? "",
    fields.body ?? "",
  ].join("\n").toLowerCase();
}

// TCRN-CROSS-STORY-473 R2: a record's goal, acceptance and body as a search listing shows them: an
// excerpt of at most `excerptBytes` bytes each, the bound --scope-bytes already puts on the scope
// excerpt. A listing carries every record it matches, and whole Story texts across a large library
// would push the page past the canonical ceiling, which refuses the whole listing; work-show
// carries them whole.
function workFieldsExcerpt(record: WorkRecord, excerptBytes: number): StoryFields {
  const fields = storyFields(record);
  const excerpt = (value: string | null): string | null => value === null ? null : truncateUtf8(value, excerptBytes);
  return { goal: excerpt(fields.goal), acceptance: excerpt(fields.acceptance), body: excerpt(fields.body), source: fields.source };
}

function workSearchSummary(record: WorkRecord, scopeBytes: number): Readonly<Record<string, unknown>> {
  return { ...workSummary(record), scope: truncateUtf8(workScope(record), scopeBytes), fields: workFieldsExcerpt(record, scopeBytes) };
}

// TCRN-CROSS-STORY-473 R2: ordinary and searched listings have one four-field shape. The ordinary
// page carries the goal, acceptance and body in full; --search keeps the bounded excerpts below.
function workListSummary(record: WorkRecord): Readonly<Record<string, unknown>> {
  return { ...workSummary(record), fields: storyFields(record) };
}

function workListPageJson(
  state: Awaited<ReturnType<typeof validateWorkspace>>,
  records: readonly unknown[],
  values: Readonly<Record<string, string>>,
): string {
  const page = paginate(state, "work", records, values);
  try {
    return canonicalJson(page);
  } catch (error) {
    if ((error as { readonly reasonCode?: string }).reasonCode === "INPUT_OVERSIZED") {
      const remedy = values.search === undefined ? "lower --limit" : "lower --limit or --scope-bytes";
      fail("CLI_WORK_LIST_OVERSIZED", `work-list page exceeds the canonical byte budget; ${remedy}`);
    }
    throw error;
  }
}

// TCRN-CROSS-STORY-473 R3: the ten-block skeleton is a suggestion. A Story needs its goal and its
// acceptance and nothing else, so the draft says so beside the skeleton it still prints.
const WORK_DRAFT_NOTE = "仅供参考，引擎只校验 goal 与 acceptance";

function workDraft(
  state: Awaited<ReturnType<typeof validateWorkspace>>,
  kind: string,
  projectId: string,
): Readonly<Record<string, unknown>> {
  const headings = kind === "Story" ? [...STORY_SCOPE_HEADINGS] : [];
  const scopeTemplate = headings.map((heading) => `【${heading}】\n<填写 ${heading}>`).join("\n\n");
  // The latest three records written either way, so a library whose Stories now carry fields does
  // not keep offering its older ten-block scopes as the model to follow.
  const examples = state.work
    .filter((record) => !record.tombstone && record.kind === kind && record.projectId === projectId && storyFields(record).source !== "none")
    .slice(-3)
    .reverse()
    .map((record) => ({ id: record.id, externalKey: record.externalKey, kind: record.kind, scope: workScope(record), fields: storyFields(record) }));
  return {
    schemaVersion: "tcrn.work-draft.v1",
    reasonCode: "WORKSPACE_WORK_DRAFT_READY",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    kind,
    projectId,
    headings,
    scopeTemplate,
    skeleton: scopeTemplate,
    template: scopeTemplate,
    optional: true,
    note: WORK_DRAFT_NOTE,
    requiredFields: kind === "Story" ? [...STORY_REQUIRED_FIELDS] : [],
    examples,
  };
}

function workAdvisory(record: WorkRecord): Readonly<Record<string, unknown>> | null {
  const scope = record.extensions["advisory:scope"] as { readonly value: unknown } | undefined;
  const decidedBy = record.extensions["advisory:decided-by"] as { readonly value: unknown } | undefined;
  const verify = record.extensions["advisory:verify"] as { readonly value: unknown } | undefined;
  const sprint = record.extensions["advisory:sprint"] as { readonly value: unknown } | undefined;
  const evidence = record.extensions["advisory:evidence"] as { readonly value: unknown } | undefined;
  const evidenceSnapshot = record.extensions["advisory:evidence-snapshot"] as { readonly value: unknown } | undefined;
  const result = record.extensions["advisory:result"] as { readonly value: unknown } | undefined;
  if (scope === undefined && decidedBy === undefined && verify === undefined && sprint === undefined && evidence === undefined && evidenceSnapshot === undefined && result === undefined) return null;
  return {
    ...(scope !== undefined ? { scope: scope.value } : {}),
    ...(decidedBy !== undefined ? { decidedBy: decidedBy.value } : {}),
    ...(verify !== undefined ? { verify: verify.value } : {}),
    ...(sprint !== undefined ? { sprint: sprint.value } : {}),
    ...(evidence !== undefined ? { evidence: evidence.value } : {}),
    ...(evidenceSnapshot !== undefined ? { evidenceSnapshot: evidenceSnapshot.value } : {}),
    ...(result !== undefined ? { result: result.value } : {}),
  };
}

// WSB-2: governed, budgeted read window over already-materialized, view-verified
// state. offset is >=0, limit >=1; both fail closed with the flag name on malformed input.
function paginate(state: Awaited<ReturnType<typeof validateWorkspace>>, kind: string, records: readonly unknown[], values: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const limit = boundedInteger(values, "limit");
  let offset = 0;
  if (values.offset !== undefined) {
    const parsed = Number(values.offset);
    if (!Number.isSafeInteger(parsed) || parsed < 0) fail("CLI_ARGUMENT_MALFORMED", "offset");
    offset = parsed;
  }
  const windowed = limit === undefined ? records.slice(offset) : records.slice(offset, offset + limit);
  return {
    reasonCode: "WORKSPACE_LIST_READY",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    kind,
    total: records.length,
    truncated: offset + windowed.length < records.length,
    records: windowed,
  };
}

// INC-027 (TCRN-CROSS-INC-027): the default window for `event-list`.
//
// 64 is the engine's own default segment size (initializeWorkspace's
// segmentEventLimit). The storage layer already reads a segment of that many
// events back through the one-MiB bound on a single file, so a default page asks
// for the same granularity the chain is already stored at rather than a number
// invented here. Measured across the four live chains on the platform that filed
// this, the largest single event is 7,008 bytes and the 95th percentile is 3,575,
// which puts a default page around 100 KiB and would need a 16 KiB mean event to
// reach the ceiling.
const EVENT_PAGE_DEFAULT_LIMIT = 64;

// INC-027: the event page — and the one list verb that can outgrow its own receipt.
//
// Every other list projects a summary, so its records are small by construction.
// This one returns each EventRecord verbatim (sequence, id, streamId, occurredAt,
// priorHash, payload, payloadHash, eventHash) because a consumer that re-derives
// the chain has to hash exactly the bytes the engine hashed; a projection would
// break that by definition. Verbatim records mean page size is the payloads'
// business, not the engine's, so a page CAN exceed the one-MiB canonical ceiling.
//
// When it does, this refuses. That refusal is the entire reason paging exists
// here: a silently short page is indistinguishable from the end of the chain,
// which is the exact failure INC-004/INC-005 were filed for — a limit expressing
// itself as absence. CLI_EVENT_PAGE_OVERSIZED is deliberately NOT the protocol's
// INPUT_OVERSIZED that `export` raises on the same ceiling: that code says "this
// chain cannot be read this way" and leaves the caller nowhere to go, while this
// one says "this page cannot" and names the flag that fixes it.
function eventPage(state: Awaited<ReturnType<typeof validateWorkspace>>, values: Readonly<Record<string, string>>): string {
  // The default applies only when the flag is ABSENT. A supplied value still goes
  // through boundedInteger inside paginate, so `--limit 0` stays
  // CLI_ARGUMENT_MALFORMED instead of being quietly replaced by the default.
  const windowed = values.limit === undefined
    ? { ...values, limit: String(EVENT_PAGE_DEFAULT_LIMIT) }
    : values;
  const page = paginate(state, "event", state.events, windowed);
  try {
    return canonicalJson(page);
  } catch (error) {
    if ((error as { readonly reasonCode?: string }).reasonCode === "INPUT_OVERSIZED") {
      fail("CLI_EVENT_PAGE_OVERSIZED", `${(page.records as readonly unknown[]).length} events do not fit one canonical page; lower --limit`);
    }
    throw error;
  }
}

function writeState(
  io: CliIo,
  state: Awaited<ReturnType<typeof validateWorkspace>>,
  record?: Readonly<Record<string, unknown>>,
  warning?: Readonly<Record<string, string>> | null,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  io.write(canonicalJson({
    reasonCode: "WORKSPACE_COMMAND_COMPLETED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    ...writtenIdsField(),
    projects: state.projects.filter((entry) => !entry.tombstone).length,
    work: state.work.filter((entry) => !entry.tombstone).length,
    ...(record ? { record } : {}),
    ...(warning === undefined || warning === null ? {} : { warning }),
    ...extra,
  }));
}

// TCRN-CROSS-STORY-476 R4 (TCRN-CROSS-SUB-311): a work record reaching done and minutes being
// recorded each answer one line asking whether there is knowledge to extract, naming the cards a
// card about it could conflict with. The cards are read once, after the write, from the library's
// crest and this user's; a store that cannot be read gives none, and the write stands either way.
async function knowledgeHints(
  workspace: string,
  at: string,
  state: Awaited<ReturnType<typeof validateWorkspace>>,
  targets: readonly ({ readonly workId: string } | { readonly minutesId: string })[],
): Promise<readonly KnowledgeHint[]> {
  if (targets.length === 0) return [];
  const cards = await readKnowledgeHintCards(workspace, at);
  return targets.map((target) => knowledgeHintFor(state, cards, target));
}

// The records a work-batch document takes to done: transition-to-done targets and Stories born
// directly done, by id or by the id their external key derives, each once, in member order.
function batchDoneWorkIds(document: unknown): readonly string[] {
  const members = (document as { readonly members?: unknown } | null)?.members;
  if (!Array.isArray(members)) return [];
  const ids: string[] = [];
  for (const member of members as readonly unknown[]) {
    if (member === null || typeof member !== "object") continue;
    const entry = member as Readonly<Record<string, unknown>>;
    if (entry.status !== "done" || (entry.verb !== "work-transition" && entry.verb !== "work-create")) continue;
    const id = entry.verb === "work-create" && typeof entry.externalKey === "string" && entry.externalKey.length > 0
      ? deriveStableId("work", canonicalExternalKey(entry.externalKey))
      : typeof entry.id === "string" && entry.id.length > 0
        ? entry.id
        : typeof entry.externalKey === "string" && entry.externalKey.length > 0
          ? deriveStableId("work", canonicalExternalKey(entry.externalKey))
          : null;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// TCRN-CROSS-STORY-476 (problem list #18): every knowledge verb that writes a card answers the ids
// it wrote beside the store's version, as a library write answers its ids beside its version: the
// card written, the card it superseded (whose record the write rewrites), and in a batch every card
// a member wrote or superseded.
function knowledgeWriteReceipt(result: Readonly<Record<string, JsonValue>>): string {
  const ids: string[] = [];
  const add = (value: JsonValue | undefined): void => {
    if (typeof value === "string" && !ids.includes(value)) ids.push(value);
  };
  add(result["id"]);
  add(result["superseded"]);
  const applied = result["applied"];
  if (Array.isArray(applied)) {
    for (const entry of applied) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const member = entry as Readonly<Record<string, JsonValue>>;
      add(member["id"]);
      add(member["superseded"]);
    }
  }
  return canonicalJson({ ...result, ids });
}

// TCRN-CROSS-STORY-476 R5: the store a knowledge read goes to -- the library's crest ("project",
// the default) or this user's crest ("user").
function storeScopeOption(value: string | undefined): { readonly scope?: KnowledgeStoreScope } {
  if (value === undefined) return {};
  if (!(KNOWLEDGE_STORE_SCOPES as readonly string[]).includes(value)) fail("CLI_ARGUMENT_MALFORMED", `scope=${value}`);
  return { scope: value as KnowledgeStoreScope };
}

// TCRN-CROSS-STORY-485 R1 (TCRN-CROSS-SUB-345): a gate's command is its argv, given as one JSON array
// of strings; the engine checks every argument when the gate is declared.
function gateCommandValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail("CLI_ARGUMENT_MALFORMED", "command is a JSON array of strings: the gate's argv, run with no shell");
  }
}

// A boolean flag a caller may leave out, so a gate declared again keeps what it said before.
function optionalBoolean(value: string | undefined, name: string): boolean | undefined {
  return value === undefined ? undefined : booleanValue(value, name);
}

// TCRN-CROSS-STORY-485 R2, R4: the project a library's gate roots are relative to. --project names
// it; left out, it is the project this device's registry holds for the library: the one the current
// directory resolves to when that is this library, or else the only project registered for it.
async function gatesProjectRoot(libraryId: string, project: string | undefined): Promise<string> {
  if (project !== undefined) return resolve(project);
  let here: Awaited<ReturnType<typeof resolveLibrary>> | null = null;
  try {
    here = await resolveLibrary(process.cwd());
  } catch (error) {
    if (typeof (error as { readonly reasonCode?: unknown }).reasonCode !== "string") throw error;
  }
  if (here !== null && here.libraryId === libraryId) return here.entry.projectPath;
  const registered = (await readRegistry()).entries.filter((entry) => entry.libraryId === libraryId);
  if (registered.length === 1) return registered[0]!.projectPath;
  throw new WorkflowCliError(
    "GATES_PROJECT_UNKNOWN",
    registered.length === 0
      ? `no project is registered for library ${libraryId} on this device, so the gates have no root to run in`
      : `library ${libraryId} is registered for ${registered.length} projects on this device`,
    { remedy: "pass --project with the project directory the gate roots are relative to" },
  );
}

// TCRN-CROSS-STORY-485 R4 (TCRN-CROSS-SUB-345): before a Story goes to done, the required gates of its
// change must be green on the tree as it is (gates-done.ts). The records going to done are judged
// against the library as it stands before the write, and a Story the same batch creates counts as
// one; a project is looked up only when a Story is among them and an enabled required declaration
// could cover it. No enabled required coverage is itself a refusal, before a project lookup.
async function doneGates(
  state: Awaited<ReturnType<typeof materializeWorkspace>>,
  workIds: readonly string[],
  created: readonly { readonly id: string; readonly kind: string }[],
  project: string | undefined,
): Promise<DoneGatesVerdict> {
  const known = new Set(state.work.map((record) => record.id));
  const createdStories = created
    .filter((entry) => entry.kind === "Story" && !known.has(entry.id))
    .map((entry) => ({ id: entry.id, kind: "Story" }) as unknown as WorkRecord);
  const work = [...state.work, ...createdStories];
  const gated = workIds.some((id) => work.some((record) => record.id === id && record.kind === "Story")) &&
    listGates(state).some((gate) => gate.enabled && gate.required && gate.covers.length > 0);
  return assertDoneGates({
    projectRoot: gated ? await gatesProjectRoot(state.metadata.workspaceId, project) : "",
    library: { configRecords: state.configRecords, metadata: state.metadata, work },
    workIds,
  });
}

// The records a work-batch document creates, with their kinds, by the id their external key derives.
function batchCreatedKinds(document: unknown): readonly { readonly id: string; readonly kind: string }[] {
  const members = (document as { readonly members?: unknown } | null)?.members;
  if (!Array.isArray(members)) return [];
  const created: { readonly id: string; readonly kind: string }[] = [];
  for (const member of members as readonly unknown[]) {
    if (member === null || typeof member !== "object") continue;
    const entry = member as Readonly<Record<string, unknown>>;
    if (entry.verb !== "work-create" || typeof entry.externalKey !== "string" || entry.externalKey.length === 0 || typeof entry.kind !== "string") continue;
    created.push({ id: deriveStableId("work", canonicalExternalKey(entry.externalKey)), kind: entry.kind });
  }
  return created;
}

// TCRN-CROSS-STORY-467 R1: every write receipt echoes the ids it wrote beside the version
// and head, so no separate read-back ceremony is needed. Read verbs carry no ids.
function writtenIdsField(): { readonly ids?: readonly string[] } {
  const ids = consumeWrittenIds();
  return ids === null ? {} : { ids };
}

// TCRN-CROSS-STORY-510 R2 (TCRN-CROSS-SUB-417): the receipt's effectiveValue is the key's
// currentValue in settings-catalog, read with that verb's arguments, so a key whose unset value is
// derived reads the same in both: an unset models.category is the default categories and every
// other category models.tiers names, not the default table. A set key is still its value and any
// other unset key its default. The readback holds every registered key and no other.
function writeSettingsState(io: CliIo, state: Awaited<ReturnType<typeof materializeWorkspace>>, key: string): void {
  const setting = state.settings.find((entry) => entry.key === key);
  const current = readSettingsCatalog(state.metadata.workspaceId, state.settings,
    state.metadata.storageVersion === 2 ? { "storage.segmentBytes": String(state.metadata.segmentEventLimit) } : {})
    .settings.find((entry) => entry.key === key);
  if (current === undefined) fail("CLI_COMMAND_FAILED", `setting ${key} is not registered`);
  const receipt = {
    schemaVersion: "tcrn.settings-write-receipt.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    recordId: key,
    setting: setting ?? null,
    effectiveValue: current.currentValue,
  } as const;
  io.write(canonicalJson({
    reasonCode: "SETTINGS_WRITE_COMMITTED",
    ...receipt,
    ...writtenIdsField(),
    receiptDigest: canonicalSha256(receipt),
  }));
}

// TCRN-CROSS-STORY-484 R4 (MIN-227 D12; TCRN-CROSS-SUB-341): a model reaches the configuration
// through the CLI, so the CLI refuses it a write of a variable, or of a setting whose catalog entry
// is not modelWritable, with MODEL_WRITE_REFUSED and the remedy of changing it in Atelier. Atelier
// runs the same verbs with EINZBERN_SURFACE=atelier and is let through. The CLI cannot tell who runs
// it, so this is a soft barrier: it stops a model changing a decision in passing, not a model that
// sets EINZBERN_SURFACE itself. Reads are never refused, and a key the engine refuses whoever asks
// (a device-level or unregistered key) keeps its own refusal.
export const SURFACE_ENVIRONMENT_VARIABLE = "EINZBERN_SURFACE" as const;
export const ATELIER_SURFACE = "atelier" as const;
export const MODEL_WRITE_REMEDY = "change it in Atelier" as const;

/**
 * Refuse a write a model makes through the CLI unless `modelWritable` says it may (TCRN-CROSS-STORY-484
 * R4): only a run for Atelier (EINZBERN_SURFACE=atelier) writes the rest. `subject` names the setting
 * key or the variable name for the refusal's details.
 */
export function assertModelWriteAllowed(
  subject: { readonly key: string } | { readonly name: string },
  modelWritable: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (modelWritable || environment[SURFACE_ENVIRONMENT_VARIABLE] === ATELIER_SURFACE) return;
  const target = "key" in subject ? `setting ${subject.key}` : `variable ${subject.name}`;
  throw new WorkflowCliError("MODEL_WRITE_REFUSED", `${target} is changed in Atelier; a model does not write it through the CLI`, {
    ...subject,
    remedy: MODEL_WRITE_REMEDY,
  });
}

// A setting outside the catalog is refused by the engine whoever asks: a device-level key with
// SETTINGS_KEY_DEVICE_LEVEL, an unregistered or retired key with SETTINGS_KEY_UNREGISTERED on a write
// (TCRN-CROSS-STORY-484 AC4) and, never being set, as nothing to remove. It keeps that refusal; only
// a catalog key is left to the barrier.
function assertSettingWriteAllowed(key: string): void {
  const entry = SETTINGS_CATALOG.find((candidate) => candidate.key === key);
  if (entry !== undefined) assertModelWriteAllowed({ key }, entry.modelWritable);
}

function writeVariableState(io: CliIo, state: Awaited<ReturnType<typeof materializeWorkspace>>, name: string): void {
  const variable: Variable | null = listVariables(state).find((entry) => entry.name === name) ?? null;
  const receipt = {
    schemaVersion: "einzbern.variable-write-receipt.v1",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    recordId: name,
    variable,
  } as const;
  io.write(canonicalJson({
    reasonCode: "VARIABLE_WRITE_COMMITTED",
    ...receipt,
    ...writtenIdsField(),
    receiptDigest: canonicalSha256(receipt),
  }));
}

// A variable write has a project destination only when its library is registered to a project.
// Explicit workspaces without a registry remain usable as library-only operations.
async function registeredProjectRootForWorkspace(workspace: string): Promise<string | null> {
  try {
    const project = await resolveAgentsProject(workspace);
    return await realpath(workspace) === project.libraryPath ? project.projectRoot : null;
  } catch (error) {
    if (error !== null && typeof error === "object" && "reasonCode" in error && error.reasonCode === "LIBRARY_NOT_REGISTERED") return null;
    throw error;
  }
}

async function renderVariableSectionsAfterWrite(workspace: string, projectRoot: string | null, at: string, actor: string | undefined): Promise<Awaited<ReturnType<typeof materializeWorkspace>>> {
  if (projectRoot === null) return materializeWorkspace(workspace);
  await writeVariablesSections(workspace, {
    projectRoot,
    occurredAt: at,
    ...(actor === undefined ? {} : { actorId: actor }),
  });
  return materializeWorkspace(workspace);
}

// TCRN-CROSS-STORY-483 R2: one rule as the rule verbs print it, with its order when its record holds
// one (TCRN-CROSS-STORY-508 R7).
function ruleStatusJson(status: RuleStatus): JsonValue {
  return {
    id: status.id,
    version: status.version,
    recordedVersion: status.recordedVersion,
    fileVersion: status.fileVersion,
    section: status.section,
    state: status.state,
    ...(status.order === undefined ? {} : { order: status.order }),
  };
}

// The receipt of rule-enable and rule-disable: the rule's state afterwards, what became of its
// section, and where AGENTS.md was backed up before it was replaced.
function writeRuleChange(io: CliIo, project: { readonly projectRoot: string; readonly libraryPath: string }, change: RuleChange): void {
  io.write(canonicalJson({
    reasonCode: change.action === "enable" ? "RULE_ENABLED" : "RULE_DISABLED",
    workspaceId: change.state.metadata.workspaceId,
    version: change.state.version,
    headEventHash: change.state.headEventHash,
    ...writtenIdsField(),
    projectPath: project.projectRoot,
    libraryPath: project.libraryPath,
    rule: ruleStatusJson(change.status),
    section: change.section,
    file: change.file,
    action: change.action,
    result: change.result,
    written: change.written,
    backupDir: change.backupPath === null ? null : dirname(change.backupPath),
    backupPath: change.backupPath,
    recorded: change.recorded,
  }));
}

function writeTemplateAdmissionState(
  io: CliIo,
  state: Awaited<ReturnType<typeof materializeWorkspace>>,
  templateId: string,
  templateVersion: number,
): void {
  const admitted = state.templates.find((entry) => entry.template.id === templateId && entry.template.version === templateVersion);
  if (admitted === undefined) fail("CLI_COMMAND_FAILED", `template ${templateId}@${templateVersion} was not materialized after admission`);
  io.write(canonicalJson({
    reasonCode: "TEMPLATE_ADMISSION_COMMITTED",
    workspaceId: state.metadata.workspaceId,
    version: state.version,
    headEventHash: state.headEventHash,
    ...writtenIdsField(),
    registrationId: admitted.registrationId,
    templateId: admitted.template.id,
    templateVersion: admitted.template.version,
    templateDigest: admitted.receipt.templateDigest,
    receipt: admitted.receipt,
  }));
}

// WSB-3: the declarative command catalog — the machine-readable source of truth
// for every dispatched verb and its flags, emitted by the `commands` discovery
// verb. New verbs MUST ship a catalog entry (SDC-1); the p3-cli-catalog parity
// test enforces two-way name equality with the dispatcher.
export const COMMAND_CATALOG = Object.freeze([
  // TCRN-CROSS-STORY-380: the three verbs that make workspace.generatedArtifactsPath a
  // real address. artifact-put mutates the workspace (a blob and a manifest line); the
  // other two only read, which is why neither takes --at.
  // TCRN-CROSS-STORY-478 R2 to R5: the engine's managed sections in a project's AGENTS.md and
  // CLAUDE.md, rendered against the library's records. --project names a directory of the project
  // (the current one when left out), and this device's registry gives the project and its library.
  { name: "agents-render", availability: "cli", mutates: true, flags: [{ name: "project", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "artifact-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  { name: "artifact-put", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "file", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "artifact-verify", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-467 R4: replay a chain from genesis without trusting any view, and
  // name the stream, sequence and event where it stops being provable. Zero writes.
  { name: "chain-validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  { name: "commands", availability: "cli", mutates: false, flags: [] },
  // TCRN-CROSS-STORY-480 R4, AC5: doctor's eight checks of this device and one project, --project or
  // the current directory. It changes nothing: device-stream's lock and probe file go again.
  { name: "doctor", availability: "cli", mutates: false, flags: [{ name: "project", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-471 R2, R3: the engine versions in this device's engine/ directory. engine-update
  // installs an unpacked, digest-checked version and makes it current; engine-rollback makes the
  // previous one current again. Both rewrite engine/current alone, never a host file.
  { name: "engine-list", availability: "cli", mutates: false, flags: [] },
  { name: "engine-rollback", availability: "cli", mutates: true, flags: [{ name: "at", required: true, valueKind: "instant" }] },
  { name: "engine-update", availability: "cli", mutates: true, flags: [{ name: "from", required: true, valueKind: "string" }, { name: "sha256", required: true, valueKind: "string" }, { name: "version", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "event-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "export", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-485 R1 to R3: gate declarations (one configuration record per gate), the plan a
  // change and optional Story need, and running it into this device's cache.
  { name: "gates-config-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  { name: "gates-config-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "gates-config-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "command", required: false, valueKind: "string" }, { name: "root", required: false, valueKind: "string" }, { name: "covers", required: false, valueKind: "list" }, { name: "required", required: false, valueKind: "boolean" }, { name: "enabled", required: false, valueKind: "boolean" }, { name: "release-only", required: false, valueKind: "boolean" }, { name: "order", required: false, valueKind: "integer" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "gates-plan", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "project", required: false, valueKind: "string" }, { name: "base", required: false, valueKind: "string" }, { name: "release", required: false, valueKind: "boolean" }, { name: "work-id", required: false, valueKind: "list" }] },
  { name: "gates-run", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "project", required: false, valueKind: "string" }, { name: "base", required: false, valueKind: "string" }, { name: "release", required: false, valueKind: "boolean" }, { name: "work-id", required: false, valueKind: "list" }] },
  { name: "host-probe", availability: "cli", mutates: false, flags: [{ name: "host", required: true, valueKind: "string" }, { name: "model", required: true, valueKind: "string" }, { name: "timeout-ms", required: false, valueKind: "integer" }] },
  { name: "init", availability: "cli", mutates: true, flags: [{ name: "workspace", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "project-name", required: false, valueKind: "string" }, { name: "git-remote", required: false, valueKind: "string" }, { name: "project", required: false, valueKind: "string" }, { name: "cloud-hosted", required: false, valueKind: "boolean" }] },
  { name: "install-manifest", availability: "cli", mutates: false, flags: [] },
  { name: "knowledge-article-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "path", required: true, valueKind: "string" }, { name: "category", required: true, valueKind: "string" }, { name: "title", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "content", required: true, valueKind: "string" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "evidence-ids", required: true, valueKind: "list" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-article-refresh", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "path", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-batch", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "from-file", required: true, valueKind: "string" }, { name: "align-first", required: false, valueKind: "boolean" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-bodies-migrate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "segment-bytes", required: false, valueKind: "integer" }] },
  // TCRN-CROSS-STORY-476 R1, R5: knowledge-create's --lifecycle is optional (active is all it takes),
  // --promotion and --allow-unpromoted are gone with the candidate, knowledge-create and
  // knowledge-capture take scope user, and list, snippet and body read the user crest with --scope user.
  { name: "knowledge-body", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "scope", required: false, valueKind: "string" }, { name: "allow-stale", required: false, valueKind: "boolean" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-capture", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "subject", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "snippet", required: true, valueKind: "string" }, { name: "tags", required: true, valueKind: "list" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "body", required: true, valueKind: "string" }, { name: "external-key", required: false, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "role-scopes", required: false, valueKind: "list" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "source-references", required: false, valueKind: "list" }, { name: "evidence-ids", required: false, valueKind: "list" }, { name: "supersedes", required: false, valueKind: "string" }, { name: "coexist", required: false, valueKind: "boolean" }, { name: "allow-trailing", required: false, valueKind: "boolean" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-checkpoint", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "knowledge-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "scope", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "role-scopes", required: true, valueKind: "list" }, { name: "category", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "tags", required: true, valueKind: "list" }, { name: "subject", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "snippet", required: true, valueKind: "string" }, { name: "accountable-owner-id", required: true, valueKind: "string" }, { name: "source-references", required: true, valueKind: "list" }, { name: "source-digest", required: false, valueKind: "string" }, { name: "supersedes", required: false, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "work-ids", required: false, valueKind: "list" }, { name: "decision-ids", required: false, valueKind: "list" }, { name: "gate-ids", required: false, valueKind: "list" }, { name: "evidence-ids", required: false, valueKind: "list" }, { name: "coexist", required: false, valueKind: "boolean" }, { name: "lifecycle", required: false, valueKind: "string" }, { name: "retrieval", required: true, valueKind: "string" }, { name: "freshness", required: true, valueKind: "string" }, { name: "last-verified", required: true, valueKind: "instant", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "stale-days", required: true, valueKind: "integer", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "export", required: true, valueKind: "string" }, { name: "body", required: true, valueKind: "string" }, { name: "language-bundle", required: false, valueKind: "string" }] },
  { name: "knowledge-freshness", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-init", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "acknowledge-disposable", required: false, valueKind: "boolean" }] },
  { name: "knowledge-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "scope", required: false, valueKind: "string" }, { name: "selection", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "role-scope", required: false, valueKind: "string" }, { name: "category", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "tag", required: false, valueKind: "string" }, { name: "freshness", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-rebase", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "knowledge-recover", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }] },
  { name: "knowledge-reverify", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "expected-revision", required: true, valueKind: "integer" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }] },
  { name: "knowledge-snippet", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "id", required: true, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-source-check", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "knowledge-validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  { name: "library-import-legacy", availability: "cli", mutates: true, flags: [{ name: "legacy", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "target", required: false, valueKind: "string" }, { name: "dry-run", required: false, valueKind: "boolean" }, { name: "project-name", required: false, valueKind: "string" }, { name: "git-remote", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-470 R1: this device's registry of libraries (registry.json in the device
  // directory). library-register writes the registry, never a project or a library.
  { name: "library-list", availability: "cli", mutates: false, flags: [] },
  { name: "library-register", availability: "cli", mutates: true, flags: [{ name: "project", required: true, valueKind: "string" }, { name: "library", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "cloud-hosted", required: false, valueKind: "boolean" }, { name: "git-remote", required: false, valueKind: "string" }] },
  { name: "library-resolve", availability: "cli", mutates: false, flags: [{ name: "cwd", required: false, valueKind: "string" }] },
  // STORY-281: machine-level portal preferences. No workspace and no chain write lock:
  // this layer is not chain-backed, so there is no head to write against — see
  // packages/core/src/machine-settings.ts for why a laptop's default theme is not
  // governed workspace state. `home` exists so a test can point the verbs at a
  // scratch directory instead of the real machine home.
  { name: "machine-settings-catalog", availability: "cli", mutates: false, flags: [{ name: "home", required: false, valueKind: "string" }] },
  { name: "machine-settings-remove", availability: "cli", mutates: true, flags: [{ name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "home", required: false, valueKind: "string" }] },
  { name: "machine-settings-set", availability: "cli", mutates: true, flags: [{ name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "value", required: true, valueKind: "string" }, { name: "home", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-475 R1, R2: minutes in one write, and their reads.
  { name: "minutes-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "work-id", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "minutes-record", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "project-id", required: true, valueKind: "string" }, { name: "title", required: true, valueKind: "string" }, { name: "summary", required: true, valueKind: "string" }, { name: "decisions", required: false, valueKind: "list" }, { name: "decisions-file", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "work-ids", required: false, valueKind: "list" }, { name: "external-key", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "minutes-show", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "id", required: false, valueKind: "string" }, { name: "external-key", required: false, valueKind: "string" }] },
  { name: "project-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "external-key", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "project-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "project-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "project-update", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "recall", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "host", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "query", required: true, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "tau", required: false, valueKind: "string" }, { name: "allow-trailing", required: false, valueKind: "boolean" }] },
  { name: "recover", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  // TCRN-CROSS-STORY-483 R2 (with agents-render and rule-resolve): the Command Spell rules of the
  // project the registry resolves from --project (the current directory when left out).
  // rule-disable takes out a section the user changed only with --force.
  { name: "rule-disable", availability: "cli", mutates: true, flags: [{ name: "id", required: true, valueKind: "string" }, { name: "force", required: false, valueKind: "boolean" }, { name: "at", required: true, valueKind: "instant" }, { name: "project", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "rule-enable", availability: "cli", mutates: true, flags: [{ name: "id", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "project", required: false, valueKind: "string" }, { name: "order", required: false, valueKind: "integer" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "rule-list", availability: "cli", mutates: false, flags: [{ name: "project", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-478 R3 (STORY-483 R2 reuses it): settle a managed section the user changed:
  // overwrite, keep or unmanage; --force overwrites a section the user kept.
  { name: "rule-resolve", availability: "cli", mutates: true, flags: [{ name: "section", required: true, valueKind: "string" }, { name: "action", required: true, valueKind: "string" }, { name: "force", required: false, valueKind: "boolean" }, { name: "at", required: true, valueKind: "instant" }, { name: "project", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "settings-catalog", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  { name: "settings-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "settings-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "key", required: true, valueKind: "string" }, { name: "value", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-480 (C7 of INIT-053): the installation wizard in one of six modes. Without
  // --yes true it answers SETUP_PLAN_READY and writes nothing; with it, SETUP_APPLIED, whose
  // self-check is doctor's eight checks and the hook run once with the project's name as the prompt.
  { name: "setup", availability: "cli", mutates: true, flags: [{ name: "mode", required: true, valueKind: "string" }, { name: "project", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "artifacts", required: false, valueKind: "string" }, { name: "cloud", required: false, valueKind: "boolean" }, { name: "restore", required: false, valueKind: "string" }, { name: "language", required: false, valueKind: "string" }, { name: "navigation", required: false, valueKind: "boolean" }, { name: "archive", required: false, valueKind: "string" }, { name: "rollback", required: false, valueKind: "boolean" }, { name: "managed-sections", required: false, valueKind: "string" }, { name: "mapping", required: false, valueKind: "string" }, { name: "yes", required: false, valueKind: "boolean" }] },
  // TCRN-CROSS-STORY-479 R1: the skill directory this engine generates for its version, written
  // into a missing or empty --out; it runs only where the skill template sits beside the engine.
  { name: "skill-render", availability: "cli", mutates: true, flags: [{ name: "out", required: true, valueKind: "string" }, { name: "version", required: false, valueKind: "string" }] },
  { name: "snapshot-manifest", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }] },
  { name: "snapshot-verify", availability: "cli", mutates: false, flags: [{ name: "root", required: true, valueKind: "string" }, { name: "manifest", required: true, valueKind: "string" }] },
  { name: "status", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  // INC-074/INC-081: seal a retained file archive to an already authoritative
  // TCRN-CROSS-INC-275: PostgreSQL support removed. storage-home-seal was
  // PG-specific; it is removed.
  { name: "template-admit", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "template", required: true, valueKind: "string" }, { name: "owner", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "template-validate", availability: "cli", mutates: false, flags: [{ name: "template", required: true, valueKind: "string" }] },
  { name: "validate", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-484 R1: the project's custom variables, records of the library's variable
  // collection. R4: variable-set and variable-remove, like settings-set and settings-remove on a key
  // that is not modelWritable, are refused with MODEL_WRITE_REFUSED unless they run for Atelier.
  { name: "variable-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }] },
  { name: "variable-remove", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "variable-set", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "name", required: true, valueKind: "string" }, { name: "type", required: true, valueKind: "string" }, { name: "value", required: true, valueKind: "string" }, { name: "description", required: false, valueKind: "string" }, { name: "order", required: false, valueKind: "integer" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "vocabulary", availability: "cli", mutates: false, flags: [] },
  // TCRN-CROSS-STORY-472 R2, R4: the four stored relations and decided-in; --decided-by is the older
  // name of --decided-in. TCRN-CROSS-STORY-473 R2: a Story's goal, acceptance and body.
  { name: "work-annotate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "goal", required: false, valueKind: "string" }, { name: "acceptance", required: false, valueKind: "string" }, { name: "body", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "blocked-by", required: false, valueKind: "list" }, { name: "implements", required: false, valueKind: "list" }, { name: "supersedes", required: false, valueKind: "list" }, { name: "fixes", required: false, valueKind: "list" }, { name: "decided-in", required: false, valueKind: "list" }, { name: "verify", required: false, valueKind: "string" }, { name: "result", required: false, valueKind: "json" }, { name: "sprint", required: false, valueKind: "string" }, { name: "title", required: false, valueKind: "string" }, { name: "summary", required: false, valueKind: "string" }, { name: "labels", required: false, valueKind: "list" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "work-batch", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "from-file", required: true, valueKind: "string" }, { name: "project", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "work-create", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "project-id", required: true, valueKind: "string" }, { name: "external-key", required: true, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "parent-id", required: false, valueKind: "string", nullSentinel: "-", deprecatedAliases: ["null"] }, { name: "status", required: false, valueKind: "string" }, { name: "scope", required: false, valueKind: "string" }, { name: "goal", required: false, valueKind: "string" }, { name: "acceptance", required: false, valueKind: "string" }, { name: "body", required: false, valueKind: "string" }, { name: "decided-by", required: false, valueKind: "list" }, { name: "blocked-by", required: false, valueKind: "list" }, { name: "implements", required: false, valueKind: "list" }, { name: "supersedes", required: false, valueKind: "list" }, { name: "fixes", required: false, valueKind: "list" }, { name: "decided-in", required: false, valueKind: "list" }, { name: "title", required: true, valueKind: "string" }, { name: "summary", required: false, valueKind: "string" }, { name: "labels", required: false, valueKind: "list" }, { name: "template-receipt", required: false, valueKind: "json" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "work-delete", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  { name: "work-draft", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "kind", required: true, valueKind: "string" }, { name: "project-id", required: true, valueKind: "string" }] },
  // TCRN-CROSS-STORY-489 (MIN-235 D17, D11, MIN-238 D4): the gates a migration carried over. work-gate-list
  // reads them, by default the ones that still hold a work item back from done; work-gate-release
  // releases one, recording who, when and why, and runs for Atelier only (MODEL_WRITE_REFUSED otherwise).
  { name: "work-gate-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "work-id", required: false, valueKind: "string" }, { name: "status", required: false, valueKind: "string" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "work-gate-release", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "reason", required: true, valueKind: "string" }, { name: "actor", required: true, valueKind: "string" }] },
  { name: "work-list", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "project-id", required: false, valueKind: "string" }, { name: "kind", required: false, valueKind: "string" }, { name: "status", required: false, valueKind: "string" }, { name: "parent-id", required: false, valueKind: "string" }, { name: "sprint", required: false, valueKind: "string" }, { name: "relation", required: false, valueKind: "string" }, { name: "search", required: false, valueKind: "string" }, { name: "scope-bytes", required: false, valueKind: "integer" }, { name: "limit", required: false, valueKind: "integer" }, { name: "offset", required: false, valueKind: "integer" }] },
  { name: "work-show", availability: "cli", mutates: false, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "id", required: false, valueKind: "string" }, { name: "external-key", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-485 R4: work-transition and work-batch take --project, the project the gates of a
  // Story going to done run in.
  { name: "work-transition", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "id", required: true, valueKind: "string" }, { name: "status", required: true, valueKind: "string" }, { name: "summary", required: false, valueKind: "string" }, { name: "project", required: false, valueKind: "string" }, { name: "actor", required: false, valueKind: "string" }] },
  // TCRN-CROSS-STORY-470 R3: move a library; the old place keeps a tombstone and refuses writes.
  { name: "workspace-relocate", availability: "cli", mutates: true, flags: [{ name: "workspace", required: false, valueKind: "string" }, { name: "to", required: true, valueKind: "string" }, { name: "at", required: true, valueKind: "instant" }, { name: "cloud-hosted", required: false, valueKind: "boolean" }] },
] as const);

// INC-016: `mutates` and `authorityBearing` name two DIFFERENT authorization
// categories. The operator bundle that kept their grant lists disjoint is retired
// (TCRN-CROSS-STORY-467 R2), but the catalog still must not declare a verb as both: a
// write grant carrying authority-bearing output is what the operator authority contract forbade
// outright, and the `commands` verb publishes this catalog to third parties.
//
// The exclusion lives at the declaration, not in a consumer. Three sites read the
// pair independently (tool description, tool annotations, grant gate), mcp.ts
// re-types the catalog through its own local interface, and the `commands` verb
// publishes it to third parties. A contradictory catalog must therefore not be
// constructible, rather than merely unusable through one surface.
export function assertCatalogCategoriesExclusive(
  commands: readonly {
    readonly name: string;
    readonly mutates: boolean;
    readonly authorityBearing?: boolean;
  }[],
): void {
  for (const entry of commands) {
    if (entry.mutates && entry.authorityBearing === true) {
      fail(
        "CLI_CATALOG_CATEGORY_AMBIGUOUS",
        `${entry.name}: a command is either a governed write or authority-bearing output, never both`,
      );
    }
  }
}

// Fail at module load, not at first use: the contradiction is a property of the
// declaration above, and mcp.ts imports this module before it can dispatch anything.
assertCatalogCategoriesExclusive(COMMAND_CATALOG);

// INC-012: authority-bearing is a property of what a verb EMITS, not a flag its author
// remembered to set. A verb minting host-state output without declaring mutates or
// authorityBearing now reddens at the write boundary below, present or future verb alike.
// These are the field names and the state tokens that make a document readable as
// observed host trust state. TCRN-CROSS-STORY-358 retired the only core modules that ever
// hand-declared them (the Codex adapter activation and installer modules) along with
// the test that bound this list two-way against that live declaration
// (tests/act13-authority-output.test.mjs's former vocabulary case; the coverage waiver that
// recorded its disposition retired with coverage conservation). The list below is now a fixed
// historical allowlist, still enforced by the fail-closed tests that remain in that file.
export const AUTHORITY_OUTPUT_FIELDS = Object.freeze([
  "activationState",
  "currentDefinitionApproved",
  "hookFired",
  "trustApprovalObserved",
] as const);

// Retired tokens stay guarded. "approved_current_definition" was withdrawn from the product
// by INC-012 because only the caller-supplied comparison ever minted it; keeping it here
// means re-minting it under any field name still fails closed.
export const AUTHORITY_STATE_TOKENS = Object.freeze([
  "approved_current_definition",
  "host_observed_active",
  "pending_host_approval",
] as const);

const authorityOutputNeedles = Object.freeze([
  ...AUTHORITY_OUTPUT_FIELDS,
  ...AUTHORITY_STATE_TOKENS,
].map((token) => `"${token}"`));

// Only the three properties the boundary judges. The catalog's own literal type carries
// more, and mcp.ts declares its own fuller view of the same rows.
interface CatalogOutputDeclaration {
  readonly name: string;
  readonly mutates: boolean;
  readonly authorityBearing?: boolean;
}

// Object KEYS carry the claim, so caller text that merely mentions a guarded name inside a
// string value is not a finding -- otherwise a knowledge body or a conference position
// quoting these docs would fail a read closed. A guarded token under a differently spelled
// state key is the same claim wearing another name, so the token space is checked too.
export function authorityShapedOutputFields(output: string): readonly string[] {
  if (!authorityOutputNeedles.some((needle) => output.includes(needle))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Bytes that spell the claim but cannot be read are refused rather than waved through.
    return Object.freeze(authorityOutputNeedles
      .filter((needle) => output.includes(needle))
      .map((needle) => needle.slice(1, -1))
      .sort());
  }
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node as readonly unknown[]) walk(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node as Readonly<Record<string, unknown>>)) {
      if ((AUTHORITY_OUTPUT_FIELDS as readonly string[]).includes(key)) found.add(key);
      if (typeof child === "string" && /state$/iu.test(key) &&
        (AUTHORITY_STATE_TOKENS as readonly string[]).includes(child)) {
        found.add(key);
      }
      walk(child);
    }
  };
  walk(parsed);
  return Object.freeze([...found].sort());
}

// The write boundary every dispatched verb passes through. The catalog declares which verbs
// may speak about host trust state; this reads the bytes and checks that declaration rather
// than trusting it. A verb absent from the catalog has declared nothing and may not speak.
export function assertDeclaredOutputCategory(command: string, output: string): void {
  const fields = authorityShapedOutputFields(output);
  if (fields.length === 0) return;
  const entry = (COMMAND_CATALOG as readonly CatalogOutputDeclaration[])
    .find((candidate) => candidate.name === command);
  if (entry !== undefined && (entry.mutates || entry.authorityBearing === true)) return;
  fail(
    "CLI_AUTHORITY_OUTPUT_UNDECLARED",
    `${command} emits host trust state (${fields.join(",")}) without a catalog mutates or authorityBearing declaration`,
  );
}

export async function runCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const command = arguments_[0];
  if (!command || command.startsWith("--")) {
    fail("CLI_COMMAND_REQUIRED", "A governed command is required");
  }
  // S245 retirement boundary: these names remain replay-only historical
  // operations, never callable write/read verbs on the public CLI.
  const retiredProfileBindingVerbs = ["persona" + "-binding-remove", "persona" + "-binding-set"];
  if ([
    "execution-config",
    "host-config-default",
    "host-config-remove",
    "host-config-set",
    "model-plan-assign",
    "model-plan-list",
    "model-plan-remove",
    "model-plan-set",
    "model-plan-unassign",
    ...retiredProfileBindingVerbs,
  ].includes(command)) {
    fail(
      "CLI_COMMAND_UNKNOWN",
      `${command} is a retired replay-only path; use settings-catalog or vocabulary for read-only state`,
    );
  }
  // INC-012: the dispatcher writes only through this wrapper, so the output-category guard
  // covers every verb -- including ones added later, which is the whole point of moving the
  // check from the flag to the bytes.
  const dispatch = async (): Promise<void> => {
    await dispatchCli(arguments_, {
      ...io,
      write: (value: string): void => {
        assertDeclaredOutputCategory(command, value);
        io.write(value);
      },
    });
  };
  // TCRN-CROSS-INC-275: PostgreSQL support removed. The STORY-189 PG-serving
  // facade is removed entirely.
  await dispatch();
}

// TCRN-CROSS-STORY-470 R1 (MIN-227 D19): the verbs whose library may be left to the registry, with
// the other flags each requires. init names the library it creates, so it always takes --workspace.
const REGISTRY_RESOLVED_VERBS: ReadonlyMap<string, readonly string[]> = new Map(COMMAND_CATALOG
  .filter((entry) => entry.name !== "init" && entry.flags.some((flag: { readonly name: string }) => flag.name === "workspace"))
  .map((entry) => [entry.name, entry.flags
    .filter((flag: { readonly name: string; readonly required: boolean }) => flag.required && flag.name !== "workspace")
    .map((flag: { readonly name: string }) => flag.name)]));

function hasFlag(arguments_: readonly string[], name: string): boolean {
  return arguments_.some((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));
}

// TCRN-CROSS-STORY-479 R1 (MIN-227 D28): skill-render writes the skill as this engine generates
// it. The skill template, skill/<skill id>/ without SKILL.md, sits beside the engine in each of the
// three layouts the engine runs from, and is looked up there only, in this order: a release (one
// bundled scripts/einzbern.mjs beside skill/), the source tree (packages/cli/src/index.ts) and its
// build (dist/build/packages/cli/src/index.js). Anywhere else the verb refuses SKILL_SOURCE_MISSING.
const SKILL_SOURCE_CANDIDATES: readonly URL[] = Object.freeze([
  new URL(`../skill/${BRAND.helper.id}/`, import.meta.url),
  new URL(`../../../skill/${BRAND.helper.id}/`, import.meta.url),
  new URL(`../../../../../skill/${BRAND.helper.id}/`, import.meta.url),
]);

// What is copied from the template beside the generated SKILL.md: the wizard references, the Codex
// metadata and the scripts. A template without scripts/ has nothing to copy there.
const SKILL_SOURCE_PARTS: readonly { readonly name: string; readonly required: boolean }[] = Object.freeze([
  { name: "references", required: true },
  { name: "agents", required: true },
  { name: "scripts", required: false },
]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function skillSourceDirectory(): Promise<string> {
  for (const candidate of SKILL_SOURCE_CANDIDATES) {
    const source = fileURLToPath(candidate);
    if (!(await isDirectory(source))) continue;
    for (const part of SKILL_SOURCE_PARTS) {
      if (part.required && !(await isDirectory(join(source, part.name)))) {
        fail("SKILL_SOURCE_MISSING", `${join(source, part.name)} does not exist: the skill template beside this engine is incomplete`);
      }
    }
    return source;
  }
  fail("SKILL_SOURCE_MISSING", `no skill/${BRAND.helper.id}/ beside this engine: skill-render runs only in the engine's source tree or in a release`);
}

// --out names a directory that does not exist yet or is empty; nothing that is there is replaced.
async function assertEmptyOutput(out: string): Promise<void> {
  let names: readonly string[];
  try {
    names = await readdir(out);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return;
    if (code === "ENOTDIR") fail("SKILL_OUT_NOT_EMPTY", `${out} is a file; --out names a missing or empty directory`);
    throw error;
  }
  if (names.length > 0) fail("SKILL_OUT_NOT_EMPTY", `${out} is not empty; --out names a missing or empty directory`);
}

/**
 * The skill directory for one engine version (TCRN-CROSS-STORY-479 R1): SKILL.md rendered for that
 * version against this engine's command catalog, and references/, agents/ and scripts/ copied from
 * the template beside the engine. The template and the rendering are checked before anything is
 * written.
 */
async function renderSkillDirectory(out: string, version: string): Promise<JsonValue> {
  const source = await skillSourceDirectory();
  const markdown = renderSkillMarkdown({ version, catalogNames: COMMAND_CATALOG.map((entry) => entry.name) });
  const target = resolve(out);
  await assertEmptyOutput(target);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, SKILL_COPIES_FILES.entry), markdown);
  for (const part of SKILL_SOURCE_PARTS) {
    const from = join(source, part.name);
    if (await isDirectory(from)) await cp(from, join(target, part.name), { recursive: true, errorOnExist: true, force: false });
  }
  const digest = await computeInstallTreeDigest(target);
  return {
    reasonCode: "SKILL_RENDERED",
    skill: BRAND.helper.id,
    version,
    out: target,
    installTreeDigest: digest.sha256,
    files: digest.entries.map((entry) => entry.path),
  };
}

// TCRN-CROSS-STORY-478: a managed-section refusal names its section as details.section, whichever
// module raised it, so the shipped entry prints it beside details.line and details.file.
async function namingSection<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reasonCode = (error as { readonly reasonCode?: unknown }).reasonCode;
    const details = (error as { readonly details?: unknown }).details;
    if (typeof reasonCode !== "string" || !reasonCode.startsWith("MANAGED_SECTION_") || details === null || typeof details !== "object") throw error;
    const fields = details as Readonly<Record<string, unknown>>;
    if (typeof fields.section === "string" || typeof fields.id !== "string") throw error;
    const strings = Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    throw new WorkflowCliError(reasonCode, error instanceof Error ? error.message : String(error), { ...strings, section: fields.id });
  }
}

// TCRN-CROSS-STORY-480 (C7 of INIT-053): the setup flags as planSetup takes them. A relative
// --artifacts, --restore or --archive is taken from the project; --project from here.
function setupOptions(values: Readonly<Record<string, string>>): SetupOptions {
  const managed = values["managed-sections"];
  if (managed !== undefined && managed !== "keep" && managed !== "remove") fail("CLI_ARGUMENT_MALFORMED", "managed-sections");
  const cloud = optionalBoolean(values.cloud, "cloud");
  const navigation = optionalBoolean(values.navigation, "navigation");
  const rollback = optionalBoolean(values.rollback, "rollback");
  return {
    mode: values.mode ?? "",
    projectRoot: values.project ?? "",
    at: values.at ?? "",
    answers: {
      ...(values.artifacts === undefined ? {} : { artifacts: values.artifacts }),
      ...(cloud === undefined ? {} : { cloud }),
      ...(values.language === undefined ? {} : { language: values.language }),
      ...(navigation === undefined ? {} : { navigation }),
    },
    ...(values.restore === undefined ? {} : { restore: values.restore }),
    ...(values.archive === undefined ? {} : { archive: values.archive }),
    ...(rollback === undefined ? {} : { rollback }),
    ...(managed === undefined ? {} : { managedSections: managed }),
    ...(values.mapping === undefined ? {} : { mapping: values.mapping }),
  };
}

// The hook's self-check after an apply (TCRN-CROSS-STORY-480 R5): the launcher a host's hook runs,
// in a process of its own as a host starts it, from the project's directory, with the project's name
// as a sample prompt. injected is what it would add to that prompt; a launcher never fails a
// prompt, so a failure shows as its reason code on stderr (hookReasonCode) and nothing injected.
const HOOK_SELF_CHECK_TIMEOUT_MS = 60_000;

function hookSelfCheck(applied: SetupApplied): {
  readonly prompt: string;
  readonly exitCode: number | null;
  readonly injected: readonly string[];
  readonly hookReasonCode: string | null;
} {
  const prompt = basename(applied.projectRoot);
  const launcher = hookLauncherPath(applied.deviceHome);
  if (!existsSync(launcher)) return { prompt, exitCode: null, injected: [], hookReasonCode: "HOOK_LAUNCHER_MISSING" };
  const run = spawnSync(process.execPath, [launcher, "user-prompt-submit"], {
    cwd: applied.projectRoot,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "einzbern-setup-self-check", cwd: applied.projectRoot, prompt }),
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: applied.deviceHome },
    maxBuffer: 1_048_576,
    timeout: HOOK_SELF_CHECK_TIMEOUT_MS,
    windowsHide: true,
  });
  let hookReasonCode: string | null = null;
  const said = String(run.stderr ?? "").trim().split("\n").at(-1) ?? "";
  if (said !== "") {
    try {
      const refusal: unknown = JSON.parse(said);
      const code = refusal !== null && typeof refusal === "object" ? (refusal as { readonly reasonCode?: unknown }).reasonCode : undefined;
      hookReasonCode = typeof code === "string" ? code : "HOOK_SELF_CHECK_STDERR";
    } catch {
      hookReasonCode = "HOOK_SELF_CHECK_STDERR";
    }
  }
  if (run.error !== undefined) hookReasonCode = String((run.error as { readonly code?: unknown }).code ?? "HOOK_SELF_CHECK_FAILED");
  let injected: readonly string[] = [];
  const stdout = String(run.stdout ?? "");
  if (run.status === 0 && stdout.trim() !== "") {
    try {
      const answer: unknown = JSON.parse(stdout);
      const output = answer !== null && typeof answer === "object" ? (answer as { readonly hookSpecificOutput?: { readonly additionalContext?: unknown } }).hookSpecificOutput : undefined;
      const context = output?.additionalContext;
      injected = typeof context === "string" && context !== "" ? context.split("\n") : [];
    } catch {
      hookReasonCode ??= "HOOK_OUTPUT_INVALID";
    }
  }
  return { prompt, exitCode: run.status, injected, hookReasonCode };
}

async function dispatchCli(arguments_: readonly string[], io: CliIo): Promise<void> {
  const command = arguments_[0];
  if (!command || command.startsWith("--")) {
    fail("CLI_COMMAND_REQUIRED", "A governed command is required");
  }
  let rest = arguments_.slice(1);
  // A verb run without --workspace works on the library this device's registry resolves from the
  // current directory (project path, Git top level, Git remote), or refuses LIBRARY_NOT_REGISTERED.
  // A verb missing another required flag is left to report CLI_ARGUMENT_MISSING first.
  const otherRequired = REGISTRY_RESOLVED_VERBS.get(command);
  if (otherRequired !== undefined && !rest.includes("--help") && !rest.includes("-h") && !hasFlag(rest, "workspace") &&
    otherRequired.every((name) => hasFlag(rest, name))) {
    rest = ["--workspace", (await resolveLibrary(process.cwd())).libraryPath, ...rest];
  }
  lastWrittenIds = null;
  // requiredShared is the mandatory pair every workspace-event mutation verb demands
  // via required(); shared is the allowed-flag list those verbs pass to parseArguments.
  // Since the time-receipt directory flag went (TCRN-CROSS-STORY-467 R1) the two are the same pair.
  const requiredShared = ["workspace", "at"];
  const shared = requiredShared;
  // STORY-300. The catalog has always carried every flag's name, whether it is
  // required, and what kind of value it takes; there was simply no way to ask it
  // about one verb. So the way to learn a verb's arguments was to run it wrong and
  // read the refusal, or to open the engine -- and `--help`, the thing everyone
  // tries first, was itself refused as a malformed argument 35 times in this
  // chain's history, which makes it the most expensive single refusal in it.
  //
  // This answers from the same array `commands` returns, so the two can never
  // disagree, and reuses that verb's reason code rather than minting one.
  if (rest.includes("--help") || rest.includes("-h")) {
    const entry = COMMAND_CATALOG.find((candidate) => candidate.name === command);
    if (entry === undefined) fail("CLI_COMMAND_UNKNOWN", command);
    io.write(canonicalJson({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands: [entry] }));
    return;
  }
  if (command === "commands") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "CLI_CATALOG_READY", schemaVersion: "tcrn.cli-catalog.v1", commands: COMMAND_CATALOG }));
    return;
  }
  if (command === "host-probe") {
    const values = parseArguments(rest, ["host", "model", "timeout-ms"]);
    required(values, ["host", "model"]);
    const result = await probeHost({
      host: values.host,
      model: values.model,
      ...(values["timeout-ms"] === undefined ? {} : { timeoutMs: integerValue(values, "timeout-ms") }),
    });
    io.write(canonicalJson(result));
    return;
  }
  // TCRN-CROSS-STORY-469 R1: init creates a library at --workspace (a missing or empty
  // directory). The five explicit roots, the workspace external key and the segment limit of
  // the old layout are gone; the project name and Git remote are a hint in the manifest.
  if (command === "init") {
    const values = parseArguments(rest, ["workspace", "at", "project-name", "git-remote", "project", "cloud-hosted"]);
    required(values, ["workspace", "at"]);
    const state = await initializeLibrary({
      root: values.workspace ?? "",
      createdAt: values.at ?? "",
      ...(values["project-name"] === undefined ? {} : { projectName: values["project-name"] }),
      ...(values["git-remote"] === undefined ? {} : { gitRemote: values["git-remote"] }),
    });
    // TCRN-CROSS-STORY-470 R1, R2: --project registers the new library for that project on this
    // device; the cloud-hosted flag is what --cloud-hosted says, or else what the cloud folder
    // table suggests for the library's real path.
    const realPath = state.library?.libraryRoot ?? "";
    const registered = values.project === undefined ? null : await registerLibrary({
      projectPath: values.project,
      libraryPath: realPath,
      registeredAt: values.at ?? "",
      ...(values["cloud-hosted"] === undefined ? {} : { cloudHosted: booleanValue(values["cloud-hosted"], "cloud-hosted") }),
      ...(values["git-remote"] === undefined ? {} : { gitRemote: values["git-remote"] }),
    });
    io.write(canonicalJson({
      reasonCode: "LIBRARY_CREATED",
      workspaceId: state.metadata.workspaceId,
      libraryId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      versionVector: state.library?.versionVector ?? {},
      projects: 0,
      work: 0,
      realPath,
      suggestedCloudHosted: suggestCloudHosted(realPath),
      ...(registered === null ? {} : { registered: registered as unknown as JsonValue }),
    }));
    return;
  }
  // TCRN-CROSS-STORY-470 R1: this device's registry of libraries.
  if (command === "library-register") {
    const values = parseArguments(rest, ["project", "library", "at", "cloud-hosted", "git-remote"]);
    required(values, ["project", "library", "at"]);
    const entry = await registerLibrary({
      projectPath: values.project ?? "",
      libraryPath: values.library ?? "",
      registeredAt: values.at ?? "",
      ...(values["cloud-hosted"] === undefined ? {} : { cloudHosted: booleanValue(values["cloud-hosted"], "cloud-hosted") }),
      ...(values["git-remote"] === undefined ? {} : { gitRemote: values["git-remote"] }),
    });
    io.write(canonicalJson({
      reasonCode: "LIBRARY_REGISTERED",
      entry: entry as unknown as JsonValue,
      realPath: entry.libraryPath,
      suggestedCloudHosted: suggestCloudHosted(entry.libraryPath),
    }));
    return;
  }
  // TCRN-CROSS-STORY-478 R2, R4, R5 (MIN-227 D14, D17): render the engine's sections into the
  // project's AGENTS.md and CLAUDE.md: the variable sections and, when this device's
  // agents.navigation is written, the navigation section; CLAUDE.md's import section unless it
  // imports AGENTS.md already. Each section's outcome and state, the sections waiting for the
  // user, and the directory the originals were backed up to are in the receipt.
  if (command === "agents-render") {
    const values = parseArguments(rest, ["project", "at", "actor"]);
    required(values, ["at"]);
    const at = values.at ?? "";
    const project = await resolveAgentsProject(values.project ?? process.cwd());
    const navigation = await readAgentsNavigation();
    const rendered = await namingSection(() => withWriteLock(project.libraryPath, at, async () => renderAgentsSections(project.libraryPath, {
      projectRoot: project.projectRoot,
      navigation,
      occurredAt: at,
      ...(values.actor ? { actorId: values.actor } : {}),
    })));
    io.write(canonicalJson({
      reasonCode: "AGENTS_RENDERED",
      workspaceId: rendered.state.metadata.workspaceId,
      version: rendered.state.version,
      headEventHash: rendered.state.headEventHash,
      ...writtenIdsField(),
      projectPath: project.projectRoot,
      libraryPath: project.libraryPath,
      navigation: { key: AGENTS_NAVIGATION_SETTING, value: navigation },
      sections: rendered.sections.map((section) => ({ id: section.id, file: section.file, result: section.result, state: section.state })),
      pending: rendered.pending.map((section) => ({ id: section.id, file: section.file })),
      files: rendered.files.map((file) => ({ file: file.file, written: file.written, backupPath: file.backupPath })),
      backupDir: rendered.backupDir,
      withheld: rendered.withheld.map((entry) => ({ name: entry.name, reason: entry.reason })),
      recorded: rendered.recorded,
    }));
    return;
  }
  // TCRN-CROSS-STORY-478 R3: settle one managed section of the project. overwrite puts the engine's
  // text back as the new baseline, keep records the user's text as theirs (never written again),
  // unmanage takes the markers out and leaves the text; --force true overwrites a section the user
  // kept. An enabled rule's version follows an explicit overwrite, and an older engine cannot
  // overwrite a version recorded by a newer one. A file it replaces is backed up first.
  if (command === "rule-resolve") {
    const values = parseArguments(rest, ["section", "action", "force", "at", "project", "actor"]);
    required(values, ["section", "action", "at"]);
    const at = values.at ?? "";
    const force = booleanValue(values.force, "force");
    const project = await resolveAgentsProject(values.project ?? process.cwd());
    const section = values.section ?? "";
    const ruleId = (values.action ?? "") === "overwrite" && section.startsWith("rule:") ? section.slice("rule:".length) : null;
    const { change, state } = await namingSection(() => withWriteLock(project.libraryPath, at, async () => {
      if (ruleId !== null) {
        const status = (await listRules({ libraryRoot: project.libraryPath, projectRoot: project.projectRoot })).find((rule) => rule.id === ruleId);
        if (status !== undefined && status.version !== null && status.recordedVersion !== null && status.recordedVersion > status.version) {
          throw new WorkflowCliError("RULE_VERSION_NEWER", `the library records rule ${ruleId} at version ${status.recordedVersion}; this engine ships version ${status.version}`, {
            id: ruleId,
            recordedVersion: String(status.recordedVersion),
            version: String(status.version),
          });
        }
      }
      const resolved = await resolveAgentsSection(project.libraryPath, {
        projectRoot: project.projectRoot,
        id: section,
        action: (values.action ?? "") as SectionAction,
        force,
        occurredAt: at,
        ...(values.actor ? { actorId: values.actor } : {}),
      });
      let state = resolved.state;
      if (ruleId !== null) {
        const status = (await listRules({ libraryRoot: project.libraryPath, projectRoot: project.projectRoot })).find((rule) => rule.id === ruleId);
        if (status !== undefined && status.recordedVersion !== null && status.state !== "disabled") {
          state = (await enableRule({
            libraryRoot: project.libraryPath,
            projectRoot: project.projectRoot,
            id: ruleId,
            occurredAt: at,
            ...(values.actor ? { actorId: values.actor } : {}),
          })).state;
        }
      }
      return { change: resolved.change, state };
    }));
    io.write(canonicalJson({
      reasonCode: "MANAGED_SECTION_RESOLVED",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      ...writtenIdsField(),
      projectPath: project.projectRoot,
      libraryPath: project.libraryPath,
      section: change.id,
      file: change.file,
      action: change.action,
      result: change.result,
      state: change.record?.state ?? null,
      written: change.written,
      backupDir: change.backupPath === null ? null : dirname(change.backupPath),
      backupPath: change.backupPath,
    }));
    return;
  }
  // TCRN-CROSS-STORY-483 R2, R3 (MIN-228 D3, MIN-229 D6): the Command Spell rules of the project
  // this device's registry resolves. rule-list reads every rule's state and writes nothing.
  // rule-enable records a rule at the version this engine ships and writes its text into AGENTS.md;
  // rule-disable takes the section out and records the rule as disabled, and a section the user
  // changed goes only with --force true. A file they replace is backed up first.
  if (command === "rule-list") {
    const values = parseArguments(rest, ["project"]);
    const project = await resolveAgentsProject(values.project ?? process.cwd());
    const rules = await namingSection(() => listRules({ libraryRoot: project.libraryPath, projectRoot: project.projectRoot }));
    io.write(canonicalJson({
      reasonCode: "RULE_LIST_READY",
      schemaVersion: "einzbern.rule-list.v1",
      projectPath: project.projectRoot,
      libraryPath: project.libraryPath,
      rules: rules.map(ruleStatusJson),
    }));
    return;
  }
  if (command === "rule-enable") {
    const values = parseArguments(rest, ["id", "at", "project", "order", "actor"]);
    required(values, ["id", "at"]);
    const at = values.at ?? "";
    // TCRN-CROSS-STORY-508 R7: --order places the rule's section among the rule sections; left out,
    // the rule keeps the order its record holds.
    const order = boundedInteger(values, "order");
    const project = await resolveAgentsProject(values.project ?? process.cwd());
    const change = await namingSection(() => withWriteLock(project.libraryPath, at, async () => enableRule({
      libraryRoot: project.libraryPath,
      projectRoot: project.projectRoot,
      id: values.id ?? "",
      occurredAt: at,
      ...(order === undefined ? {} : { order }),
      ...(values.actor ? { actorId: values.actor } : {}),
    })));
    writeRuleChange(io, project, change);
    return;
  }
  if (command === "rule-disable") {
    const values = parseArguments(rest, ["id", "force", "at", "project", "actor"]);
    required(values, ["id", "at"]);
    const at = values.at ?? "";
    const force = booleanValue(values.force, "force");
    const project = await resolveAgentsProject(values.project ?? process.cwd());
    const change = await namingSection(() => withWriteLock(project.libraryPath, at, async () => disableRule({
      libraryRoot: project.libraryPath,
      projectRoot: project.projectRoot,
      id: values.id ?? "",
      force,
      occurredAt: at,
      ...(values.actor ? { actorId: values.actor } : {}),
    })));
    writeRuleChange(io, project, change);
    return;
  }
  if (command === "library-resolve") {
    const values = parseArguments(rest, ["cwd"]);
    const resolved = await resolveLibrary(values.cwd ?? process.cwd());
    io.write(canonicalJson({
      reasonCode: "LIBRARY_RESOLVED",
      via: resolved.via,
      libraryPath: resolved.libraryPath,
      libraryId: resolved.libraryId,
      projectPath: resolved.entry.projectPath,
      cloudHosted: resolved.entry.cloudHosted,
    }));
    return;
  }
  // TCRN-CROSS-STORY-470 R3, AC2, AC3: relocate a library (relocate.ts). The host write-root
  // wiring for a library outside its project follows the move (TCRN-CROSS-STORY-470 R5).
  if (command === "workspace-relocate") {
    const values = parseArguments(rest, ["workspace", "to", "at", "cloud-hosted"]);
    required(values, ["workspace", "to", "at"]);
    const report = await relocateLibrary(values.workspace ?? "", values.to ?? "", {
      at: values.at ?? "",
      ...(values["cloud-hosted"] === undefined ? {} : { cloudHosted: booleanValue(values["cloud-hosted"], "cloud-hosted") }),
    });
    io.write(canonicalJson(report as unknown as JsonValue));
    return;
  }
  // TCRN-CROSS-STORY-471 R2, R3 (engine-home.ts): the device's engine versions. engine-list is also
  // what engine-update runs in a new version before it becomes current.
  if (command === "engine-list") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "ENGINE_LIST_READY", ...await listEngines() } as unknown as JsonValue));
    return;
  }
  if (command === "engine-update") {
    const values = parseArguments(rest, ["from", "sha256", "version", "at"]);
    required(values, ["from", "sha256", "version", "at"]);
    io.write(canonicalJson(await updateEngine({
      from: values.from ?? "",
      sha256: values.sha256 ?? "",
      version: values.version ?? "",
      at: values.at ?? "",
    }) as unknown as JsonValue));
    return;
  }
  if (command === "engine-rollback") {
    const values = parseArguments(rest, ["at"]);
    required(values, ["at"]);
    io.write(canonicalJson(await rollbackEngine({ at: values.at ?? "" }) as unknown as JsonValue));
    return;
  }
  // TCRN-CROSS-STORY-480 (setup.ts): plan in the chosen mode; apply the plan only with --yes true. The
  // device directory is this process's (EINZBERN_HOME), the one the library records go through.
  if (command === "setup") {
    const values = parseArguments(rest, ["mode", "project", "at", "artifacts", "cloud", "restore", "language", "navigation", "archive", "rollback", "managed-sections", "mapping", "yes"]);
    required(values, ["mode", "project", "at"]);
    const options = setupOptions(values);
    const confirmed = booleanValue(values.yes, "yes");
    const plan: SetupPlan = await planSetup(options);
    if (!confirmed) {
      io.write(canonicalJson(plan as unknown as JsonValue));
      return;
    }
    const applied = await applySetup(plan);
    io.write(canonicalJson({ ...applied, selfCheck: { checks: applied.selfCheck, ...hookSelfCheck(applied) } } as unknown as JsonValue));
    return;
  }
  // TCRN-CROSS-STORY-480 R4, AC5 (doctor.ts): the eight checks, each {check, ok, reasonCode, detail}.
  if (command === "doctor") {
    const values = parseArguments(rest, ["project"]);
    const projectPath = resolve(values.project ?? process.cwd());
    const checks: readonly DoctorCheck[] = await runDoctor({ projectRoot: projectPath });
    io.write(canonicalJson({ reasonCode: "DOCTOR_READY", ok: checks.every((check) => check.ok), projectPath, checks: checks as unknown as JsonValue }));
    return;
  }
  if (command === "library-list") {
    parseArguments(rest, []);
    const registry = await readRegistry();
    io.write(canonicalJson({ reasonCode: "LIBRARY_REGISTRY_READY", entries: registry.entries as unknown as JsonValue }));
    return;
  }
  // TCRN-CROSS-STORY-468 R6, AC4: import an old-layout workspace into a new library whose first
  // stream is the old chain, byte for byte; --dry-run true validates it in memory and writes
  // nothing. The old workspace is only read. Without --target the library is .ether in the old
  // workspace root.
  if (command === "library-import-legacy") {
    const values = parseArguments(rest, ["legacy", "at", "target", "dry-run", "project-name", "git-remote"]);
    required(values, ["legacy", "at"]);
    const legacy = values.legacy ?? "";
    const dryRun = booleanValue(values["dry-run"], "dry-run");
    io.write(canonicalJson(await importLegacyWorkspace(legacy, values.target ?? defaultImportTarget(legacy), {
      createdAt: values.at ?? "",
      dryRun,
      ...(values["project-name"] === undefined ? {} : { projectName: values["project-name"] }),
      ...(values["git-remote"] === undefined ? {} : { gitRemote: values["git-remote"] }),
    }) as unknown as JsonValue));
    return;
  }
  // TCRN-CROSS-STORY-466 R3 / 467 R4 / 469: validate a chain from genesis. A library is read stream
  // by stream (each structural break names its device, stream and sequence) and replayed merged;
  // an old-layout workspace is read without a single write. `validate` is the same check: views
  // are derived and no longer an authority.
  if (command === "chain-validate" || command === "validate") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    if (await hasLibraryManifest(values.workspace ?? "")) {
      const library = await openLibrary(values.workspace ?? "");
      const read = await readAllStreams(library.root);
      const state = materializeLibraryRead(library, read);
      io.write(canonicalJson({
        reasonCode: "CHAIN_VALIDATED",
        layout: "library",
        workspaceId: state.metadata.workspaceId,
        events: state.version,
        version: state.version,
        headEventHash: state.headEventHash,
        versionVector: state.library?.versionVector ?? {},
        rejectedEventCount: state.library?.rejectedEvents.length ?? 0,
        streams: read.streams.flatMap((stream) => stream.manifest === null ? [] : [{
          deviceId: stream.deviceId,
          streamId: stream.manifest.streamId,
          identityScheme: stream.manifest.identityScheme,
          events: stream.events.length,
          headEventHash: stream.manifest.headEventHash,
        }]),
      }));
      return;
    }
    const legacy = await openLegacyWorkspace(values.workspace ?? "");
    const report = validateLegacyChain(legacy);
    const state = materializeFromGenesis(legacy.metadata, legacy.events);
    io.write(canonicalJson({
      reasonCode: "CHAIN_VALIDATED",
      layout: "legacy",
      workspaceId: legacy.metadata.workspaceId,
      events: report.events,
      version: state.version,
      headEventHash: state.headEventHash,
      streams: report.streams,
    }));
    return;
  }
  if (command === "status") {
    // WSA-3 / SDC-10: status reads authority only, so an agent can always observe the head.
    // Views are this device's cache (TCRN-CROSS-STORY-469 R4) and never verified.
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const workspace = values.workspace ?? "";
    const state = await materializeWorkspace(workspace);
    // TCRN-CROSS-STORY-469 R2: config/project.json is a projection of the merged project-level
    // settings that no read trusts; status says when it does not show them.
    // TCRN-CROSS-STORY-478 R1: and the merged configuration records beside them.
    const configProjection = state.library === undefined ? null : await configProjectionStatus(state.library.libraryRoot, state.settings, state.configRecords);
    // TCRN-CROSS-STORY-470 R3: a relocated library still reads; status says where it went.
    const tombstone = state.library === undefined ? null : await readLibraryTombstone(state.library.libraryRoot);
    // TCRN-CROSS-STORY-471 R4: every device the library knows, the engine version it last wrote with,
    // and a hint when one is unknown or too old to meet a new format.
    const multiDevice = state.library === undefined ? null : await libraryUpgradeReadiness(await openLibrary(state.library.libraryRoot));
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_COMMAND_COMPLETED",
      engineVersion: FRAMEWORK_VERSION,
      workspaceId: state.metadata.workspaceId,
      // TCRN-CROSS-STORY-468 R4: a library's version is a vector of each device's stream
      // sequence; `version` is the merged event count and `headEventHash` one digest over the
      // stream heads. An old-layout workspace (read-only) reports its one chain's length and head.
      layout: state.library === undefined ? "legacy" : "library",
      version: state.version,
      headEventHash: state.headEventHash,
      versionVector: state.library?.versionVector ?? {},
      streams: (state.library?.streams ?? []).map((stream) => ({
        deviceId: stream.deviceId,
        displayName: stream.displayName,
        streamId: stream.streamId,
        sequence: stream.sequence,
        headEventHash: stream.headEventHash,
        engineVersion: stream.engineVersion,
      })),
      rejectedEventCount: state.library?.rejectedEvents.length ?? 0,
      configProjection,
      multiDevice: multiDevice as unknown as JsonValue,
      ...(tombstone === null ? {} : { relocatedTo: tombstone.movedTo, relocatedAt: tombstone.movedAt }),
      projects: state.projects.filter((entry) => !entry.tombstone).length,
      work: state.work.filter((entry) => !entry.tombstone).length,
      // STORY-299: headroom belongs on the one verb that still answers past a
      // ceiling. The view-verifying verbs fail closed when a view is over budget,
      // so a gauge hung on any of them would be readable only while it had nothing
      // to report. It covers every view and the record cap, not just the file that
      // happened to fill up first: the work index and the event cap are the next
      // two walls, and both were found by measurement rather than by an incident.
      budgets: workspaceBudgets(state),
    }));
    return;
  }
  if (command === "export") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(await exportWorkspace(values.workspace ?? ""));
    return;
  }
  if (command === "template-validate") {
    const values = parseArguments(rest, ["template"]);
    required(values, ["template"]);
    const template = await readTemplateDocumentFile(values.template ?? "");
    io.write(canonicalJson(validateTemplateDocument(template)));
    return;
  }
  if (command === "template-admit") {
    const values = parseArguments(rest, [...shared, "template", "owner", "actor"]);
    required(values, [...requiredShared, "template", "owner"]);
    // The external edit surface is read and validated before taking the workspace
    // lease. Only the governed admission event below can make its digest effective.
    const template = await readTemplateDocumentFile(values.template ?? "");
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => admitTemplateInWorkspace(workspace, {
      occurredAt: at,
      template,
      ownerId: values.owner ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeTemplateAdmissionState(io, state, template.id, template.version);
    return;
  }
  if (command === "recover") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, () => recoverWorkspace(workspace));
    writeState(io, state);
    return;
  }
  if (command === "machine-settings-catalog") {
    const values = parseArguments(rest, ["home"]);
    io.write(canonicalJson({ reasonCode: "MACHINE_SETTINGS_CATALOG_READY", ...await readMachineSettingsCatalog(machineSettingsPath(values.home)) }));
    return;
  }
  if (command === "machine-settings-set") {
    const values = parseArguments(rest, ["at", "key", "value", "home"]);
    required(values, ["at", "key", "value"]);
    const file = await applyMachineSettingSet({ key: values.key ?? "", value: values.value ?? "", occurredAt: values.at ?? "", path: machineSettingsPath(values.home) });
    io.write(canonicalJson({ reasonCode: "MACHINE_SETTINGS_WRITE_COMMITTED", ...file }));
    return;
  }
  if (command === "machine-settings-remove") {
    const values = parseArguments(rest, ["at", "key", "home"]);
    required(values, ["at", "key"]);
    const file = await applyMachineSettingRemove({ key: values.key ?? "", occurredAt: values.at ?? "", path: machineSettingsPath(values.home) });
    io.write(canonicalJson({ reasonCode: "MACHINE_SETTINGS_WRITE_COMMITTED", ...file }));
    return;
  }
  if (command === "settings-catalog") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    io.write(canonicalJson({ reasonCode: "SETTINGS_CATALOG_READY", ...readSettingsCatalog(state.metadata.workspaceId, state.settings,
      state.metadata.storageVersion === 2 ? { "storage.segmentBytes": String(state.metadata.segmentEventLimit) } : {}) }));
    return;
  }
  if (command === "install-manifest") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "INSTALL_MANIFEST_READY", ...readInstallManifest() }));
    return;
  }
  // TCRN-CROSS-STORY-479 R1, AC1, AC3: the skill directory for this engine's version, or for
  // --version.
  if (command === "skill-render") {
    const values = parseArguments(rest, ["out", "version"]);
    required(values, ["out"]);
    io.write(canonicalJson(await renderSkillDirectory(values.out ?? "", values.version ?? FRAMEWORK_VERSION)));
    return;
  }
  if (command === "vocabulary") {
    parseArguments(rest, []);
    io.write(canonicalJson({ reasonCode: "VOCABULARY_READY", ...readVocabulary() }));
    return;
  }
  if (command === "settings-remove") {
    const values = parseArguments(rest, [...shared, "key", "actor"]);
    required(values, [...requiredShared, "key"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    assertSettingWriteAllowed(values.key ?? "");
    const state = await withWriteLock(workspace, at, async () => removeWorkspaceSetting(workspace, {
      occurredAt: at, key: values.key ?? "", ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeSettingsState(io, state, values.key ?? "");
    return;
  }
  if (command === "settings-set") {
    const values = parseArguments(rest, [...shared, "key", "value", "actor"]);
    required(values, [...requiredShared, "key", "value"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    assertSettingWriteAllowed(values.key ?? "");
    // TCRN-CROSS-STORY-380: the half of the artifact-root rule a live filesystem has to
    // answer. It cannot live in validateSettingValue, which also runs on the replay path
    // (settings.ts says why), so it runs here, at the moment an operator declares the
    // address — the moment they can still fix a typo. artifact-put asks again before it
    // writes, because a directory that was real when it was declared is not necessarily
    // real when it is used.
    if (values.key === "workspace.generatedArtifactsPath") {
      // Shape first, filesystem second, and in that order deliberately: the shape rule is
      // the one that also runs on replay, so it is the one whose refusal an operator will
      // meet again later. validateSettingValue is the same pure function setWorkspaceSetting
      // is about to call, so calling it here costs a second pass over one string and buys a
      // stable reason code rather than whichever check happened to be reached first.
      await assertGeneratedArtifactsRoot(workspace, validateSettingValue(values.key, values.value ?? "", workspace));
    }
    const state = await withWriteLock(workspace, at, async () => setWorkspaceSetting(workspace, {
      occurredAt: at,
      key: values.key ?? "",
      value: values.value ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeSettingsState(io, state, values.key ?? "");
    return;
  }
  // TCRN-CROSS-STORY-484 R1 (TCRN-CROSS-SUB-341): the custom variables. variable-list reads them with
  // what the custom section of AGENTS.md leaves out and why (R2), and any pending variable sections;
  // variable-set and variable-remove write them for Atelier only (R4). When the workspace is
  // registered to a project, each write renders its variable sections through the managed writer.
  if (command === "variable-list") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const state = await materializeWorkspace(values.workspace ?? "");
    const withheld: readonly WithheldEntry[] = renderCustomVariablesSection(state).withheld;
    const pendingSections = managedSectionRecordsFor(state, "AGENTS.md")
      .filter((record) => record.state === "pending" && (record.id === "variables-system" || record.id === "variables-custom"))
      .map((record) => record.id);
    io.write(canonicalJson({
      reasonCode: "VARIABLE_LIST_READY",
      schemaVersion: "einzbern.variable-list.v1",
      workspaceId: state.metadata.workspaceId,
      variables: listVariables(state),
      withheld,
      pendingSections,
    }));
    return;
  }
  if (command === "variable-set") {
    const values = parseArguments(rest, [...shared, "name", "type", "value", "description", "order", "actor"]);
    // An empty value is a value (a string variable may be empty), so --value is checked for
    // presence rather than for content.
    const missing = [...requiredShared, "name", "type"].filter((flag) => !values[flag]);
    if (!Object.hasOwn(values, "value")) missing.push("value");
    if (missing.length > 0) fail("CLI_ARGUMENT_MISSING", missing.join(","));
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const name = values.name ?? "";
    // TCRN-CROSS-STORY-508 R7: --order places the variable in the custom section. variable-set
    // writes the whole record, so a variable set without --order has none, as one set without
    // --description has an empty description.
    const order = boundedInteger(values, "order");
    assertModelWriteAllowed({ name }, false);
    const projectRoot = await registeredProjectRootForWorkspace(workspace);
    const state = await withWriteLock(workspace, at, async () => {
      await setVariable(workspace, {
        occurredAt: at,
        name,
        type: values.type ?? "",
        value: values.value ?? "",
        ...(values.description === undefined ? {} : { description: values.description }),
        ...(order === undefined ? {} : { order }),
        ...(values.actor ? { actorId: values.actor } : {}),
      });
      return renderVariableSectionsAfterWrite(workspace, projectRoot, at, values.actor);
    });
    writeVariableState(io, state, name);
    return;
  }
  if (command === "variable-remove") {
    const values = parseArguments(rest, [...shared, "name", "actor"]);
    required(values, [...requiredShared, "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const name = values.name ?? "";
    assertModelWriteAllowed({ name }, false);
    const projectRoot = await registeredProjectRootForWorkspace(workspace);
    const state = await withWriteLock(workspace, at, async () => {
      await removeVariable(workspace, {
        occurredAt: at,
        name,
        ...(values.actor ? { actorId: values.actor } : {}),
      });
      return renderVariableSectionsAfterWrite(workspace, projectRoot, at, values.actor);
    });
    writeVariableState(io, state, name);
    return;
  }
  if (command === "artifact-put") {
    // TCRN-CROSS-STORY-380. The engine write lock is the quiesce proof, the same one
    // snapshot-manifest takes below: two puts appending to one manifest without it each write a manifest
    // missing the other's entry, and the loser's blob sits on disk with nothing pointing
    // at it. No chain event is appended — the manifest is the record, and keeping the put
    // off the chain is what lets the blob root be a directory the engine does not own.
    const values = parseArguments(rest, ["workspace", "file", "at"]);
    required(values, ["workspace", "file", "at"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    io.write(canonicalJson(await putArtifact(workspace, { file: values.file ?? "", at })));
    return;
  }
  if (command === "artifact-list") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await listArtifacts(values.workspace ?? "")));
    return;
  }
  if (command === "artifact-verify") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await verifyArtifacts(values.workspace ?? "")));
    return;
  }
  if (command === "snapshot-manifest") {
    // WSF-2: read-only snapshot witness. The engine write lock is the quiesce proof —
    // createSnapshotManifest holds it for the computation (WORKSPACE_LOCKED when another
    // writer never lets go); the manifest is emitted verbatim to stdout as the receipt.
    // --at stays in the catalog unchanged; the lock needs no instant.
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    const workspace = values.workspace ?? "";
    const manifest = await createSnapshotManifest(workspace);
    io.write(manifest);
    return;
  }
  if (command === "snapshot-verify") {
    // WSF-2: recompute a copied control tree against a saved manifest receipt. No
    // lease and no mutation — the target is a copy, not a live workspace.
    const values = parseArguments(rest, ["root", "manifest"]);
    required(values, ["root", "manifest"]);
    const manifest = await readSnapshotManifestFile(values.manifest ?? "");
    io.write(canonicalJson(await verifySnapshotManifest(values.root ?? "", manifest)));
    return;
  }
  if (command === "knowledge-init") {
    const values = parseArguments(rest, ["workspace", "acknowledge-disposable"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await initializeKnowledgeStore(values.workspace ?? "", {
      disposableAcknowledged: booleanValue(values["acknowledge-disposable"], "acknowledge-disposable"),
    })));
    return;
  }
  if (command === "knowledge-recover") {
    const values = parseArguments(rest, ["workspace", "scope"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await recoverKnowledgeStore(values.workspace ?? "", values.scope === undefined ? {} : {
      scope: values.scope as "project" | "user",
    })));
    return;
  }
  if (command === "knowledge-bodies-migrate") {
    const values = parseArguments(rest, ["workspace", "segment-bytes"]);
    required(values, ["workspace"]);
    const segmentBytes = values["segment-bytes"] === undefined ? undefined : integerValue(values, "segment-bytes");
    io.write(canonicalJson(await migrateKnowledgeBodies(values.workspace ?? "", segmentBytes)));
    return;
  }
  if (command === "knowledge-validate") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await validateKnowledgeStore(values.workspace ?? "")));
    return;
  }
  if (command === "knowledge-article-create") {
    const names = ["workspace", "host", "at", "path", "category", "title", "summary", "content", "accountable-owner-id", "evidence-ids", "language-bundle"];
    const values = parseArguments(rest, names);
    required(values, names.filter((name) => !["host", "language-bundle"].includes(name)));
    const categories = ["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"];
    if (!categories.includes(values.category ?? "")) fail("CLI_ARGUMENT_MALFORMED", `category=${values.category ?? ""}`);
    io.write(knowledgeWriteReceipt(await createKnowledgeArticle(values.workspace ?? "", {
      occurredAt: values.at ?? "",
      path: values.path ?? "",
      category: values.category as KnowledgeCategory,
      title: values.title ?? "",
      summary: values.summary ?? "",
      content: values.content ?? "",
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      linkedEvidenceIds: listValue(values["evidence-ids"]),
    }, languageOptions(values["language-bundle"], undefined, values.host))));
    return;
  }
  if (command === "knowledge-article-refresh") {
    const names = ["workspace", "host", "expected-revision", "at", "id", "path", "summary", "language-bundle"];
    const values = parseArguments(rest, names);
    required(values, names.filter((name) => !["host", "language-bundle"].includes(name)));
    io.write(knowledgeWriteReceipt(await refreshKnowledgeArticle(values.workspace ?? "", {
      expectedRevision: integerValue(values, "expected-revision"),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
      path: values.path ?? "",
      summary: values.summary ?? "",
    }, languageOptions(values["language-bundle"], undefined, values.host))));
    return;
  }
  if (command === "knowledge-source-check") {
    const values = parseArguments(rest, ["workspace", "allow-trailing"]);
    required(values, ["workspace"]);
    io.write(canonicalJson(await checkKnowledgeSources(values.workspace ?? "", {
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
    })));
    return;
  }
  if (command === "knowledge-rebase") {
    // TCRN-CROSS-SUB-308: --retire-invalid is gone with every retirement path but --supersedes.
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await rebaseKnowledgeStore(values.workspace ?? "", {
      at: values.at ?? "",
    })));
    return;
  }
  if (command === "knowledge-create") {
    const names = [
      "workspace", "host", "at", "external-key", "scope", "project-id", "role-scopes", "category", "kind", "tags",
      "subject", "summary", "snippet", "accountable-owner-id", "source-references", "source-digest", "supersedes", "work-ids", "decision-ids", "gate-ids", "evidence-ids",
      "coexist", "lifecycle", "retrieval", "freshness", "last-verified", "stale-days", "export", "body", "language-bundle",
    ];
    // TCRN-CROSS-STORY-365: the four backlink lists are optional. They were required with
    // a "-" spelling for "none", which made every card pay four flags to say nothing, and
    // 26 of 28 flags required is what made this verb unusable from a hook.
    // TCRN-CROSS-STORY-476 R1 (TCRN-CROSS-SUB-311): so is --lifecycle. Every card is written
    // active, so the flag takes "active" alone; the two lifecycles a card is no longer written
    // with reach the engine, which refuses them with KNOWLEDGE_LIFECYCLE_RETIRED and its remedy.
    const optional = ["host", "source-digest", "supersedes", "work-ids", "decision-ids", "gate-ids", "evidence-ids", "coexist", "lifecycle", "language-bundle"];
    const values = parseArguments(rest, names);
    required(values, names.filter((name) => !optional.includes(name)));
    // Pre-validate enum-valued flags against their literal unions so an invalid
    // value fails closed here naming the flag, rather than casting uncast into core.
    const enumFlags: readonly (readonly [string, readonly string[]])[] = [
      // TCRN-CROSS-STORY-476 R5: "user" writes the card to this user's crest, recalled in every project.
      ["scope", ["workspace", "project", "role", "user"]],
      ["category", ["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"]],
      ["kind", ["fact", "guide", "decision", "reference", "summary"]],
      ["lifecycle", ["active", "candidate", "retired"]],
      ["retrieval", ["default", "explicit-only", "excluded"]],
      ["freshness", ["fresh", "stale", "unknown"]],
      ["export", ["metadata-only", "excluded"]],
    ];
    for (const [flag, admitted] of enumFlags) {
      const provided = values[flag];
      if (provided !== undefined && !admitted.includes(provided)) fail("CLI_ARGUMENT_MALFORMED", `${flag}=${provided}`);
    }
    io.write(knowledgeWriteReceipt(await createKnowledgeUnit(values.workspace ?? "", {
      occurredAt: values.at ?? "",
      externalKey: values["external-key"] ?? "",
      scope: values.scope as "workspace" | "project" | "role" | "user",
      projectId: nullableValue(values["project-id"]),
      roleScopes: listValue(values["role-scopes"]),
      category: values.category as KnowledgeCategory,
      kind: values.kind as KnowledgeKind,
      tags: listValue(values.tags),
      subject: values.subject ?? "",
      summary: values.summary ?? "",
      snippet: values.snippet ?? "",
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      sourceReferences: listValue(values["source-references"]),
      sourceDigest: values["source-digest"] ?? null,
      supersedes: nullableValue(values.supersedes),
      linkedWorkIds: listValue(values["work-ids"]),
      linkedDecisionIds: listValue(values["decision-ids"]),
      linkedGateIds: listValue(values["gate-ids"]),
      linkedEvidenceIds: listValue(values["evidence-ids"]),
      ...(values.lifecycle === undefined ? {} : { lifecycle: values.lifecycle as "candidate" | "active" | "retired" }),
      retrievalDisposition: values.retrieval as "default" | "explicit-only" | "excluded",
      freshnessState: values.freshness as KnowledgeFreshnessState,
      lastVerified: nullableValue(values["last-verified"]),
      stalenessPolicy: { maximumAgeDays: nullableIntegerValue(values, "stale-days"), unknownDisposition: "fail-closed" },
      exportDisposition: values.export as "metadata-only" | "excluded",
      body: values.body ?? "",
      coexist: booleanValue(values.coexist, "coexist"),
    }, languageOptions(values["language-bundle"], values["external-key"], values.host))));
    return;
  }
  if (command === "knowledge-capture") {
    // TCRN-CROSS-STORY-365: the thin write. Eight required flags -- the store, the
    // instant, the four card fields, the accountable owner, and the body -- and every
    // other shape defaulted in core. Written is retrievable; there is no promotion step.
    // TCRN-CROSS-STORY-476 R5 (TCRN-CROSS-SUB-311): --scope role (the default), workspace or user;
    // a user card goes to this user's crest and is recalled in every project. A project card names
    // its project, which is knowledge-create's to take, and only a role card names roles.
    const names = [
      "workspace", "at", "subject", "summary", "snippet", "tags", "accountable-owner-id", "body",
      "external-key", "scope", "role-scopes", "category", "kind", "source-references", "evidence-ids",
      "supersedes", "coexist", "allow-trailing", "language-bundle",
    ];
    const values = parseArguments(rest, names);
    required(values, ["workspace", "at", "subject", "summary", "snippet", "tags", "accountable-owner-id", "body"]);
    for (const [flag, admitted] of [
      ["scope", ["role", "workspace", "user"]],
      ["category", ["architecture", "domain", "implementation", "standards", "testing", "workflow", "decision", "evidence"]],
      ["kind", ["fact", "guide", "decision", "reference", "summary"]],
    ] as readonly (readonly [string, readonly string[]])[]) {
      const provided = values[flag];
      if (provided !== undefined && !admitted.includes(provided)) fail("CLI_ARGUMENT_MALFORMED", `${flag}=${provided}`);
    }
    if (values.scope !== undefined && values.scope !== "role" && values["role-scopes"] !== undefined) {
      fail("CLI_ARGUMENT_MALFORMED", `role-scopes names roles of a role card, not of scope=${values.scope}`);
    }
    io.write(knowledgeWriteReceipt(await captureKnowledgeUnit(values.workspace ?? "", {
      occurredAt: values.at ?? "",
      subject: values.subject ?? "",
      summary: values.summary ?? "",
      snippet: values.snippet ?? "",
      tags: listValue(values.tags),
      accountableOwnerId: values["accountable-owner-id"] ?? "",
      body: values.body ?? "",
      coexist: booleanValue(values.coexist, "coexist"),
      ...(values["external-key"] ? { externalKey: values["external-key"] } : {}),
      ...(values.scope ? { scope: values.scope as "role" | "workspace" | "user" } : {}),
      ...(values["role-scopes"] ? { roleScopes: listValue(values["role-scopes"]) } : {}),
      ...(values.category ? { category: values.category as KnowledgeCategory } : {}),
      ...(values.kind ? { kind: values.kind as KnowledgeKind } : {}),
      ...(values["source-references"] ? { sourceReferences: listValue(values["source-references"]) } : {}),
      ...(values["evidence-ids"] ? { linkedEvidenceIds: listValue(values["evidence-ids"]) } : {}),
      ...(values.supersedes ? { supersedes: values.supersedes } : {}),
    }, { allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"), ...languageOptions(values["language-bundle"], values["external-key"]) })));
    return;
  }
  if (command === "knowledge-list") {
    // TCRN-CROSS-STORY-476 R1, R5 (TCRN-CROSS-SUB-311): --promotion is gone with the candidate it
    // selected, and --scope user lists this user's crest instead of the library's.
    const values = parseArguments(rest, ["workspace", "at", "scope", "selection", "project-id", "role-scope", "category", "kind", "tag", "freshness", "search", "limit", "offset", "allow-trailing"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await listKnowledgeMetadata(values.workspace ?? "", {
      at: values.at ?? "",
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
      ...storeScopeOption(values.scope),
      ...(values.selection ? { selection: values.selection as "default" | "all" } : {}),
      ...(values["project-id"] ? { projectId: values["project-id"] } : {}),
      ...(values["role-scope"] ? { roleScope: values["role-scope"] } : {}),
      ...(values.category ? { category: values.category as KnowledgeCategory } : {}),
      ...(values.kind ? { kind: values.kind as KnowledgeKind } : {}),
      ...(values.tag ? { tag: values.tag } : {}),
      ...(values.freshness ? { freshness: values.freshness as KnowledgeFreshnessState } : {}),
      ...(values.search ? { search: values.search } : {}),
      // WSB-2: integerValue is the single arbiter of INTEGER-ness here, exactly as it is
      // for target-version. Bare Number() sent NaN into core, which then reported a
      // typo as KNOWLEDGE_INPUT_INVALID "limit" -- a syntax error dressed as a range
      // judgement. The minimum stays unbounded on purpose: core holds the real window
      // rule (>= 1, <= the canonical view-byte budget, offset >= 0), and a CLI-side
      // floor would pre-empt half of it while silently keeping the ceiling.
      ...(values.limit !== undefined ? { limit: integerValue(values, "limit") } : {}),
      ...(values.offset !== undefined ? { offset: integerValue(values, "offset") } : {}),
    })));
    return;
  }
  if (command === "knowledge-snippet") {
    const values = parseArguments(rest, ["workspace", "id", "scope", "allow-trailing"]);
    required(values, ["workspace", "id"]);
    io.write(canonicalJson(await readKnowledgeSnippet(values.workspace ?? "", values.id ?? "", {
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
      ...storeScopeOption(values.scope),
    })));
    return;
  }
  if (command === "knowledge-body") {
    // TCRN-CROSS-STORY-476 R1 (TCRN-CROSS-SUB-311): --allow-unpromoted is gone with the promotion step.
    const values = parseArguments(rest, ["workspace", "id", "at", "scope", "allow-stale", "allow-trailing"]);
    required(values, ["workspace", "id", "at"]);
    io.write(canonicalJson(await readKnowledgeBody(values.workspace ?? "", values.id ?? "", {
      at: values.at ?? "",
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
      allowStale: booleanValue(values["allow-stale"], "allow-stale"),
      ...storeScopeOption(values.scope),
    })));
    return;
  }
  if (command === "knowledge-freshness") {
    const values = parseArguments(rest, ["workspace", "at", "allow-trailing"]);
    required(values, ["workspace", "at"]);
    io.write(canonicalJson(await evaluateKnowledgeFreshness(values.workspace ?? "", values.at ?? "", {
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
    })));
    return;
  }
  // TCRN-CROSS-SUB-308 (TCRN-CROSS-STORY-476 R1, R2): knowledge-promote, knowledge-retire,
  // retire-proposals and retire-sweep are gone. A card is retrievable the moment it is written
  // and retires only when a later card names it with --supersedes, so the four verbs answer
  // CLI_COMMAND_UNKNOWN like any name the catalog does not hold.
  if (command === "knowledge-reverify") {
    const values = parseArguments(rest, ["workspace", "expected-revision", "at", "id"]);
    required(values, ["workspace", "expected-revision", "at", "id"]);
    io.write(knowledgeWriteReceipt(await reverifyKnowledgeUnit(values.workspace ?? "", {
      expectedRevision: integerValue(values, "expected-revision"),
      occurredAt: values.at ?? "",
      id: values.id ?? "",
    })));
    return;
  }
  if (command === "knowledge-batch") {
    // Same shape as work-batch: --from-file because a batch is ordinarily generated.
    // --align-first folds the rebase a chain-written workspace always needs into the same
    // invocation -- N cards, one round trip.
    const values = parseArguments(rest, ["workspace", "host", "at", "from-file", "align-first", "language-bundle"]);
    required(values, ["workspace", "at", "from-file"]);
    const { readFileSync } = await import("node:fs");
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(values["from-file"] ?? "", "utf8"));
    } catch (error) {
      fail("WORK_BATCH_MALFORMED", `${values["from-file"] ?? ""}: ${(error as { message?: string }).message ?? "unreadable"}`);
    }
    const batchProviders = languageProvidersFor(values["language-bundle"]);
    io.write(knowledgeWriteReceipt(await applyKnowledgeBatch(values.workspace ?? "", document, {
      occurredAt: values.at ?? "",
      alignFirst: booleanValue(values["align-first"], "align-first"),
      ...(batchProviders === undefined ? {} : { languageProviders: batchProviders }),
      ...(values.host === undefined ? {} : { mutation: { host: values.host } }),
    })));
    return;
  }
  // TCRN-CROSS-STORY-362: one bm25 answer over the three record families a session can
  // be reminded of, in place of the substring scan that returned everything a tag named
  // or nothing at all. The verb is workspace-addressed like every other verb; --partition
  // is accepted because the injection hook speaks in partitions, and is checked against
  // the path the caller resolved rather than used to resolve one -- a hook whose path
  // resolution drifts gets a refusal instead of an answer from the wrong chain.
  if (command === "recall") {
    // TCRN-CROSS-STORY-474: recall answers from one library, whatever directory it sits in; the
    // partition flag went with the partition registry. --host stays: it names the prompt-language
    // policy the answer is negotiated against.
    const values = parseArguments(rest, ["workspace", "host", "at", "query", "limit", "tau", "allow-trailing"]);
    required(values, ["workspace", "at", "query"]);
    const workspace = values.workspace ?? "";
    const query = values.query ?? "";
    if (query.length === 0 || query.length > 4096 || !query.isWellFormed()) fail("CLI_ARGUMENT_MALFORMED", "query");
    const limit = values.limit === undefined ? undefined : integerValue(values, "limit");
    if (limit !== undefined && (limit < 1 || limit > RECALL_CANDIDATE_LIMIT)) fail("CLI_ARGUMENT_MALFORMED", "limit");
    const state = await validateWorkspace(workspace);
    const settingValue = (key: string): string | undefined => state.settings.find((entry) => entry.key === key)?.value;
    // The flag wins over the setting, the setting over the recorded default: the same
    // order work-list's scope-bytes already uses.
    const configuredTau = Number(settingValue("retrieval.tau") ?? String(RECALL_DEFAULT_TAU));
    const tau = values.tau === undefined
      ? (Number.isFinite(configuredTau) && configuredTau >= 0 ? configuredTau : RECALL_DEFAULT_TAU)
      : Number(values.tau);
    if (!Number.isFinite(tau) || tau < 0) fail("CLI_ARGUMENT_MALFORMED", "tau");
    // TCRN-CROSS-STORY-364 requirement 4: a prompt whose language is outside the recorded
    // prompt languages is answered, and the answer says the translation is owed and which
    // model owes it. The engine calls no model; the hook holding it translates and asks
    // again. Read-side is fail-open, unlike the write path, because a session with no
    // answer is worse than an answer ranked in the wrong language.
    const languageAnswer = resolveQueryLanguage(query, readKnowledgeLanguagePolicy(state.settings, values.host));
    const scopeBytes = Number(settingValue("retrieval.scopeExcerptBytes") ?? "512");
    const scopeExcerptBytes = Number.isSafeInteger(scopeBytes) && scopeBytes > 0 ? scopeBytes : 512;
    // The byte budget of one prompt's answer (TCRN-CROSS-STORY-474 R2): the hit lines are cut to it
    // at whole lines, which is what a host puts in front of the prompt.
    const promptBytes = Number(settingValue("injection.perPromptBytes") ?? "1600");
    const perPromptBytes = Number.isSafeInteger(promptBytes) && promptBytes > 0 ? promptBytes : 1600;
    // TCRN-CROSS-STORY-476 R5 (TCRN-CROSS-SUB-311): the cards come from two stores, the library's
    // crest and this user's crest, each read whole as an explicit search corpus (explicit-only
    // article index cards admitted, the complete corpus before scoring so bm25 keeps its baseline)
    // and each card labelled with its store. A store with no cards to give -- none initialized, or
    // one trailing the chain while the caller did not admit a trailing read -- still leaves the
    // work records and minutes to recall, and its reason code is reported rather than swallowed,
    // so "no cards" is never indistinguishable from "no card matched". knowledgeReasonCode stays
    // the library store's, as it always was.
    const cards = await readRecallCards(workspace, {
      at: values.at ?? "",
      allowTrailing: booleanValue(values["allow-trailing"], "allow-trailing"),
    });
    // TCRN-CROSS-STORY-474 R1: what the index holds is decided in one place (recall-inputs.ts), so
    // the verb and the prompt hook cannot index differently: the Stories, Incidents, Initiatives and
    // Epics with their goal, body and parent titles, every minutes record, and the cards.
    const inputs = recallInputsFromState(state, cards.cards, { scopeExcerptBytes });
    const result = recall({
      // One index per library, whatever path it is read at (TCRN-CROSS-STORY-469).
      cacheKey: state.metadata.workspaceId,
      // The storage checkpoint: the chain head the records were replayed from, and the
      // digests of the two knowledge answers they were read with. Any one moving is a
      // different corpus, and the index is rebuilt from the rows that actually changed.
      // A library's head is one digest over every stream's head, so it moves with any
      // entry of the version vector.
      checkpoint: `${state.headEventHash}:${cards.digest}`,
      documents: () => recallDocuments(inputs),
      query,
      tau,
      ...(limit === undefined ? {} : { limit }),
    });
    io.write(canonicalJson({
      schemaVersion: "tcrn.recall.v1",
      reasonCode: result.reasonCode,
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      at: values.at ?? "",
      knowledgeReasonCode: cards.stores.project.reasonCode,
      // Both stores' reads: each one's reason code and how many cards it gave.
      knowledgeStores: {
        project: { reasonCode: cards.stores.project.reasonCode, cards: cards.stores.project.cards },
        user: { reasonCode: cards.stores.user.reasonCode, cards: cards.stores.user.cards },
      },
      // TCRN-CROSS-SUB-310 (MIN-235 D7): a user crest that gave fewer cards than it holds says so at
      // the top of the answer -- its read refused (the refusal's reasonCode), or cards withheld in
      // unresolved conflict (KNOWLEDGE_POSSIBLE_CONFLICT with unresolvedConflicts and withheldCards)
      // -- so "no user card matched" never stands in for "the user crest was not read".
      // TCRN-CROSS-SUB-413: every version of an id two devices wrote is withheld too, named under
      // unresolvedDuplicates (KNOWLEDGE_DUPLICATE when no pair is withheld as well).
      ...(cards.userCrestDegraded === null ? {} : { userCrestDegraded: cards.userCrestDegraded as unknown as JsonValue }),
      // TCRN-CROSS-SUB-414 (C-R15-1): the cards the library's crest withheld are named the same way,
      // in the same form: an unresolved pair (KNOWLEDGE_POSSIBLE_CONFLICT), versions of an unresolved
      // duplicate (KNOWLEDGE_DUPLICATE when no pair is withheld), cards whose project the chain no
      // longer holds, under unresolvedScopes (KNOWLEDGE_LINK_INVALID when neither is withheld; R16,
      // C-R16-1), or records awaiting chain events this device has not received, under awaitingChain
      // (KNOWLEDGE_HIGH_WATER_MISMATCH when they are all that is withheld), with withheldCards. A
      // refused read stays knowledgeReasonCode.
      ...(cards.projectCrestDegraded === null ? {} : { projectCrestDegraded: cards.projectCrestDegraded as unknown as JsonValue }),
      query,
      queryTokens: [...result.tokens],
      // The canonical protocol carries only safe integers, and a bm25 score is not one.
      // These three are spoken the way every numeric setting in this engine is spoken --
      // as a decimal string -- rather than scaled into an integer whose unit a reader
      // would have to be told.
      tau: result.tau.toFixed(4),
      relativeFloor: result.relativeFloor.toFixed(4),
      limit: result.limit,
      scopeExcerptBytes,
      queryLanguage: languageAnswer.queryLanguage,
      queryTranslation: languageAnswer.queryTranslation,
      telemetry: languageAnswer.telemetry,
      indexed: result.indexed,
      rebuilt: result.rebuilt,
      total: result.total,
      // TCRN-CROSS-STORY-474 R2, R3: each hit also as the one line a host shows (kind and status,
      // title, key, id, the titles above it), and the answer as those lines cut to the prompt's
      // budget. Below the strong-hit threshold the reason code is RECALL_NO_STRONG_HIT and both are
      // empty: a prompt about nothing the library holds gets nothing, not its best weak guesses.
      // A card hit names its store, "project" or "user" (TCRN-CROSS-STORY-476 R5), and its line
      // marks a user card 「用户」.
      records: result.records.map((hit) => ({
        kind: hit.kind, key: hit.key, id: hit.id, status: hit.status,
        title: hit.title, summary: hit.summary, score: hit.score.toFixed(4),
        line: formatRecallLine(hit), parentChain: [...hit.parentChain],
        ...(hit.scope === undefined ? {} : { scope: hit.scope }),
      })),
      perPromptBytes,
      context: [...recallContextLines(result.records, perPromptBytes)],
    }));
    return;
  }
  if (command === "knowledge-checkpoint") {
    const values = parseArguments(rest, ["workspace", "at"]);
    required(values, ["workspace", "at"]);
    io.write(await exportKnowledgeCheckpoint(values.workspace ?? "", values.at ?? ""));
    return;
  }
  // WSE-3: from a chain's attestation.actor.enabled event on, the engine makes a valid
  // --actor mandatory. The verb that wrote that event is retired (TCRN-CROSS-STORY-467 R2);
  // chains that carry it still replay and still demand an actor. --actor itself is catalog-OPTIONAL
  // on every mutation verb (added to each parseArguments allowed list, never to
  // required()): pre-enable it is optional and post-enable the ENGINE enforces it
  // (WORKSPACE_ACTOR_REQUIRED/_INVALID) — the CLI never duplicates that vocabulary,
  // keeping legacy no-actor invocations on non-enabled workspaces byte-identical.
  if (command === "project-create") {
    const values = parseArguments(rest, [...shared, "external-key", "name", "actor"]);
    required(values, [...requiredShared, "external-key", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => createProject(workspace, {
      occurredAt: at, externalKey: values["external-key"] ?? "", name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    const id = deriveStableId("project", canonicalExternalKey(values["external-key"] ?? ""));
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === id)!));
    return;
  }
  if (command === "project-update") {
    const values = parseArguments(rest, [...shared, "id", "name", "actor"]);
    required(values, [...requiredShared, "id", "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => updateProject(workspace, {
      occurredAt: at, id: values.id ?? "", name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "project-delete") {
    const values = parseArguments(rest, [...shared, "id", "actor"]);
    required(values, [...requiredShared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => deleteProject(workspace, {
      occurredAt: at, id: values.id ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeState(io, state, projectSummary(state.projects.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-create") {
    const values = parseArguments(rest, [...shared, "project-id", "external-key", "kind", "parent-id", "status", "scope", ...STORY_FIELD_FLAGS, "decided-by", ...RELATION_FLAGS, "title", "summary", "labels", "template-receipt", "actor"]);
    // TCRN-CROSS-STORY-363: --title is required on the create path. Measured on the
    // cross-project chain on 2026-09-07, 50 of its 843 live work records carried a
    // title; the other 793 were addressable only by external key, so a listing could
    // show a whole tree and name nothing in it. The protocol keeps title optional --
    // every one of those records still replays -- and the refusal lives here, at the
    // one place a new record is born.
    required(values, [...requiredShared, "project-id", "external-key", "kind", "title"]);
    // Fail closed at the CLI boundary naming the offending flag/value, before the
    // uncast enum reaches core and surfaces as an opaque RECORD_MALFORMED on the id.
    // A retired kind is refused with the engine's own code and remedy (TCRN-CROSS-STORY-472 R1).
    assertCreatableKind(values.kind);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const id = deriveStableId("work", canonicalExternalKey(values["external-key"] ?? ""));
    const { state, gates } = await withWriteLock(workspace, at, async () => {
      const before = await materializeWorkspace(workspace);
      const verdict: DoneGatesVerdict | null = values.kind === "Story" && values.status === "done"
        ? await doneGates(before, [id], [{ id, kind: "Story" }], undefined)
        : null;
      return {
        state: await createWork(workspace, {
          occurredAt: at,
          projectId: values["project-id"] ?? "",
          externalKey: values["external-key"] ?? "",
          kind: values.kind as PlannedDeliveryKind,
          parentId: nullableValue(values["parent-id"]),
          ...(values.status ? { status: values.status as WorkStatus } : {}),
          ...(values.scope !== undefined ? { scope: values.scope } : {}),
          ...storyFieldsInput(values),
          ...(values["decided-by"] !== undefined ? { decidedBy: listValue(values["decided-by"]) } : {}),
          ...relationsInput(values),
          ...(values.title !== undefined ? { title: values.title } : {}),
          ...(values.summary !== undefined ? { summary: values.summary } : {}),
          ...(values.labels !== undefined ? { labels: listValue(values.labels) } : {}),
          ...(values["template-receipt"] !== undefined ? { templateAdmission: jsonValue(values["template-receipt"], "template-receipt") } : {}),
          ...(values.actor ? { actorId: values.actor } : {}),
        }),
        gates: verdict,
      };
    });
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === id)!), undefined, gates === null ? {} : { doneGates: gates });
    return;
  }
  if (command === "work-batch") {
    // STORY-300 slice 3. --from-file rather than an inline argument because a batch is
    // ordinarily generated, and because an argv-sized batch would defeat the point.
    // TCRN-CROSS-STORY-485 R4: --project names the project the gates run in, for a Story the batch
    // takes to done (the registry's project for the library when left out).
    const values = parseArguments(rest, [...shared, "from-file", "project", "actor"]);
    required(values, [...requiredShared, "from-file"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const { readFileSync } = await import("node:fs");
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(values["from-file"] ?? "", "utf8"));
    } catch (error) {
      fail("WORK_BATCH_MALFORMED", `${values["from-file"] ?? ""}: ${(error as { message?: string }).message ?? "unreadable"}`);
    }
    const members = Array.isArray((document as { members?: unknown }).members) ? (document as { members: unknown[] }).members.length : 0;
    const doneIds = batchDoneWorkIds(document);
    const { state, gates } = await withWriteLock(workspace, at, async () => {
      // TCRN-CROSS-STORY-485 R4: a Story the batch takes to done passes the gates first; a refusal
      // writes no member. TCRN-CROSS-STORY-489: before those, a gate a migration carried over that
      // still holds a member is named (WORKSPACE_GATE_PENDING, with work-gate-release).
      const before = doneIds.length === 0 ? null : await materializeWorkspace(workspace);
      if (before !== null) assertWorkGatesClear(before, doneIds);
      const verdict: DoneGatesVerdict | null = before === null
        ? null
        : await doneGates(before, doneIds, batchCreatedKinds(document), values.project);
      return {
        state: await applyWorkBatch(workspace, document, {
          occurredAt: at,
          ...(values.actor ? { actorId: values.actor } : {}),
        }),
        gates: verdict,
      };
    });
    // TCRN-CROSS-STORY-476 R4: every member that took a record to done answers its knowledge hint.
    const hints = await knowledgeHints(workspace, at, state, doneIds.map((workId) => ({ workId })));
    // One attestation for the batch, not one per member: the specification defines the
    // receipt per mutation, and a batch is one mutation.
    writeState(io, state, workBatchReceipt(state, members), undefined, {
      ...(hints.length === 0 ? {} : { knowledgeHints: doneIds.map((workId, index) => ({ workId, ...hints[index] })) }),
      ...(gates === null ? {} : { doneGates: gates }),
    });
    return;
  }
  if (command === "work-transition") {
    // TCRN-CROSS-STORY-485 R4: --project names the project the gates run in, for a Story going to
    // done (the registry's project for the library when left out).
    const values = parseArguments(rest, [...shared, "id", "status", "summary", "project", "actor"]);
    required(values, [...requiredShared, "id", "status"]);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const { state, gates } = await withWriteLock(workspace, at, async () => {
      // TCRN-CROSS-STORY-485 R4: a Story goes to done only when the required gates of its change
      // are green on the tree as it is; the refusal names every red required gate.
      // TCRN-CROSS-STORY-489: before those, a gate a migration carried over that still holds the work
      // item is named (WORKSPACE_GATE_PENDING, with work-gate-release).
      const before = values.status === "done" ? await materializeWorkspace(workspace) : null;
      if (before !== null) assertWorkGatesClear(before, [values.id ?? ""]);
      const verdict: DoneGatesVerdict | null = before === null
        ? null
        : await doneGates(before, [values.id ?? ""], [], values.project);
      return {
        state: await transitionWork(workspace, {
          occurredAt: at, id: values.id ?? "", status: values.status as WorkStatus,
          ...(values.summary !== undefined ? { summary: values.summary } : {}),
          ...(values.actor ? { actorId: values.actor } : {}),
        }),
        gates: verdict,
      };
    });
    const transitioned = state.work.find((entry) => entry.id === (values.id ?? ""))!;
    // TCRN-CROSS-STORY-476 R4: a record that reached done asks whether there is knowledge to extract.
    const [hint] = values.status === "done" ? await knowledgeHints(workspace, at, state, [{ workId: transitioned.id }]) : [];
    writeState(io, state, workSummary(transitioned), undefined, {
      ...(hint === undefined ? {} : { knowledgeHint: hint }),
      ...(gates === null ? {} : { doneGates: gates }),
    });
    return;
  }
  if (command === "work-annotate") {
    // E05 + INIT-008: attach non-binding advisory fields to a work record. --title,
    // --summary and --labels ride along on the same event and count as moves in their own
    // right since TCRN-CROSS-STORY-363, so what the core still refuses is an annotation
    // that moves nothing at all: it is WORKSPACE_INPUT_INVALID here rather than an
    // appended event no later read can replay (TCRN-CROSS-INC-269).
    const values = parseArguments(rest, [...shared, "id", "scope", ...STORY_FIELD_FLAGS, "decided-by", ...RELATION_FLAGS, "verify", "result", "sprint", "title", "summary", "labels", "actor"]);
    required(values, [...requiredShared, "id"]);
    const relations = relationsInput(values);
    const fields = storyFieldsInput(values);
    if (values.scope === undefined && Object.keys(fields).length === 0 && values["decided-by"] === undefined && relations.relations === undefined && values.verify === undefined && values.result === undefined && values.sprint === undefined && values.title === undefined && values.summary === undefined && values.labels === undefined) fail("CLI_ARGUMENT_MALFORMED", "annotation-field");
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => annotateWork(workspace, {
      occurredAt: at, id: values.id ?? "",
      ...(values.scope !== undefined ? { scope: values.scope } : {}),
      ...fields,
      ...(values["decided-by"] !== undefined ? { decidedBy: listValue(values["decided-by"]) } : {}),
      ...relations,
      ...(values.verify !== undefined ? { verify: values.verify } : {}),
      ...(values.result !== undefined ? { result: jsonValue(values.result, "result") as JsonValue } : {}),
      ...(values.sprint !== undefined ? { sprint: sprintReference(values.sprint) } : {}),
      ...(values.title !== undefined ? { title: values.title } : {}),
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
      ...(values.labels !== undefined ? { labels: listValue(values.labels) } : {}),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "work-delete") {
    const values = parseArguments(rest, [...shared, "id", "actor"]);
    required(values, [...requiredShared, "id"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => deleteWork(workspace, {
      occurredAt: at, id: values.id ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeState(io, state, workSummary(state.work.find((entry) => entry.id === (values.id ?? ""))!));
    return;
  }
  if (command === "project-list") {
    const values = parseArguments(rest, ["workspace", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const records = state.projects.filter((entry) => !entry.tombstone).map(projectSummary);
    io.write(canonicalJson(paginate(state, "project", records, values)));
    return;
  }
  if (command === "work-list") {
    const values = parseArguments(rest, ["workspace", "project-id", "kind", "status", "parent-id", "sprint", "relation", "search", "scope-bytes", "limit", "offset"]);
    required(values, ["workspace"]);
    if (values.search !== undefined && (values.search.length === 0 || values.search.length > 256 || !values.search.isWellFormed())) {
      fail("CLI_ARGUMENT_MALFORMED", "search");
    }
    // Incident and Release are no longer created, and records of both still read: the filter keeps them.
    if (values.kind !== undefined && !["Initiative", "Epic", "Story", "Subtask", "Incident", "Release"].includes(values.kind)) fail("CLI_ARGUMENT_MALFORMED", `kind=${values.kind}`);
    if (values.status !== undefined && !isWorkStatus(values.status)) fail("CLI_ARGUMENT_MALFORMED", `status=${values.status}`);
    const relation = values.relation === undefined ? undefined : relationArgument(values.relation);
    // INIT-008: filter members of a sprint. The flag carries the qualified reference in the
    // same library:<id>#work:<id> spelling used to annotate; we compare the parsed object
    // against the stored advisory:sprint value by canonical bytes so the round trip is closed.
    const sprintFilter = values.sprint === undefined ? undefined : canonicalJson(sprintReference(values.sprint));
    const state = await validateWorkspace(values.workspace ?? "");
    const configuredScopeBytes = state.settings.find((entry) => entry.key === "retrieval.scopeExcerptBytes")?.value;
    const scopeBytes = values["scope-bytes"] === undefined ? Number(configuredScopeBytes ?? "512") : integerValue(values, "scope-bytes");
    if (scopeBytes < 1 || scopeBytes > 65_536) fail("CLI_ARGUMENT_MALFORMED", "scope-bytes");
    const search = values.search?.toLowerCase();
    // TCRN-CROSS-STORY-472 R3: the records that stand in the named relation to the given id.
    const related = relation === undefined ? undefined : relationFilter(state, relation.name, relation.id);
    const records = state.work.filter((entry) => !entry.tombstone &&
      (related === undefined || related.has(entry.id)) &&
      (values["project-id"] === undefined || entry.projectId === values["project-id"]) &&
      (values.kind === undefined || entry.kind === values.kind) &&
      (values.status === undefined || entry.status === values.status) &&
      // TCRN-CROSS-STORY-363: search reaches the four fields a record can be named
      // by. It matched externalKey and scope alone, which meant a keyword present
      // only in the title -- the field a human actually reads -- returned nothing,
      // and the 40 live cross-project records carrying no scope at all (2026-09-07)
      // were reachable by external key and by nothing else.
      (search === undefined || workSearchText(entry).includes(search)) &&
      (sprintFilter === undefined || canonicalJson((entry.extensions["advisory:sprint"] as { readonly value: unknown } | undefined)?.value ?? null) === sprintFilter) &&
      // CQ-05(c2): the null sentinel must be spelled the same on the way in and on the way
      // out. work-create routes --parent-id through nullableValue, which accepts BOTH "-"
      // and the deprecated alias "null"; this filter used a bare === "-" and so treated
      // "null" as a literal parent id. An agent could therefore create a root work item
      // with --parent-id null and then never find it with the identical spelling — a
      // silent wrong answer (total=0), not a cosmetic inconsistency. Sharing nullableValue
      // makes the round trip closed for every spelling the writer accepts, by construction.
      (values["parent-id"] === undefined || (nullableValue(values["parent-id"]) === null ? entry.parentId === null : entry.parentId === values["parent-id"])))
      .map((entry) => search === undefined ? workListSummary(entry) : workSearchSummary(entry, scopeBytes));
    io.write(workListPageJson(state, records, values));
    return;
  }
  if (command === "work-draft") {
    const values = parseArguments(rest, ["workspace", "kind", "project-id"]);
    required(values, ["workspace", "kind", "project-id"]);
    assertCreatableKind(values.kind);
    const state = await validateWorkspace(values.workspace ?? "");
    if (!state.projects.some((project) => !project.tombstone && project.id === values["project-id"])) {
      fail("WORKSPACE_PROJECT_NOT_FOUND", `project ${values["project-id"] ?? ""} does not exist in this workspace`);
    }
    io.write(canonicalJson(workDraft(state, values.kind ?? "", values["project-id"] ?? "")));
    return;
  }
  // TCRN-CROSS-STORY-468 R5, AC2, AC3: a record is found by id or by external key. It carries
  // the keys it was renamed from (aliases), the records renamed away from its key (aliasedBy),
  // and the events that were rejected against it, so neither a collision nor a lost race is
  // invisible.
  if (command === "work-show") {
    const values = parseArguments(rest, ["workspace", "id", "external-key"]);
    required(values, ["workspace"]);
    if ((values.id === undefined) === (values["external-key"] === undefined)) {
      fail("CLI_ARGUMENT_MALFORMED", "work-show takes exactly one of --id and --external-key");
    }
    const state = await validateWorkspace(values.workspace ?? "");
    const externalKey = values["external-key"]?.toUpperCase();
    const record = state.work.find((entry) => !entry.tombstone && (externalKey === undefined ? entry.id === values.id : entry.externalKey === externalKey));
    if (!record) fail("WORKSPACE_INPUT_INVALID", `work ${values.id ?? values["external-key"] ?? ""} is unavailable`);
    const advisory = workAdvisory(record);
    const aliases = recordAliases(state, record.id);
    const rejectedEvents = (state.library?.rejectedEvents ?? []).filter((entry) => entry.recordId === record.id);
    // TCRN-CROSS-STORY-472 R3: both directions of the record's relations. A forward target this
    // library does not hold as a live record (deleted, or written on a device not merged yet) is
    // listed under missing.
    const relations = workRelations(state, record.id);
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_RECORD_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      kind: "work",
      record: workSummary(record),
      // TCRN-CROSS-STORY-473 R2, AC3: the goal, acceptance and body whole, with where they come
      // from -- the record's own fields, or the blocks of an old scope mapped on this read.
      fields: storyFields(record),
      ...(advisory !== null ? { advisory } : {}),
      relations: { forward: relations.forward, reverse: relations.reverse, missing: relations.missing },
      ...(aliases.aliases.length === 0 ? {} : { aliases: aliases.aliases.map((entry) => ({ externalKey: entry.externalKey, id: entry.id, deviceId: entry.deviceId })) }),
      ...(aliases.aliasedBy.length === 0 ? {} : { aliasedBy: aliases.aliasedBy.map((entry) => ({ externalKey: entry.aliasExternalKey, id: entry.aliasId, deviceId: entry.deviceId })) }),
      ...(rejectedEvents.length === 0 ? {} : { rejectedEvents }),
    }));
    return;
  }
  // TCRN-CROSS-STORY-489 (MIN-235 D17, MIN-238 D4; TCRN-CROSS-SUB-365): the read face of the gates a
  // migration carried over, whose own verbs are retired. Each is the gate record as the chain holds
  // it (specs/gate-v1.md), a released one with its release entry. By default the ones that still hold
  // their work item back from done (pending and blocked); --status pending, blocked or satisfied
  // narrows to one, and --status all lists every gate that is not deleted.
  if (command === "work-gate-list") {
    const values = parseArguments(rest, ["workspace", "work-id", "status", "limit", "offset"]);
    required(values, ["workspace"]);
    const status = values.status;
    if (status !== undefined && !["pending", "blocked", "satisfied", "all"].includes(status)) fail("CLI_ARGUMENT_MALFORMED", `status=${status}`);
    const state = await validateWorkspace(values.workspace ?? "");
    const workId = values["work-id"];
    const records = state.gates.filter((gate) => !gate.tombstone &&
      (status === undefined ? gate.status !== "satisfied" : status === "all" || gate.status === status) &&
      (workId === undefined || gate.workId === workId));
    io.write(canonicalJson(paginate(state, "work-gate", records, values)));
    return;
  }
  // TCRN-CROSS-STORY-489 (MIN-235 D17, D11, MIN-238 D4; TCRN-CROSS-SUB-365): release a gate a
  // migration carried over, recording who (--actor), when (--at) and why (--reason) in the gate
  // itself (specs/gate-v1.md, Release). It runs for Atelier only: without EINZBERN_SURFACE=atelier it
  // is refused with MODEL_WRITE_REFUSED and the remedy of doing it in Atelier before the library is
  // opened, so nothing is appended. The surface is an agreed convention, not proof of who ran the
  // command (MIN-235 D11); assertModelWriteAllowed keeps its own subjects (C-R17-6).
  if (command === "work-gate-release") {
    const values = parseArguments(rest, [...shared, "id", "reason", "actor"]);
    required(values, [...requiredShared, "id", "reason", "actor"]);
    const id = values.id ?? "";
    if (process.env[SURFACE_ENVIRONMENT_VARIABLE] !== ATELIER_SURFACE) {
      throw new WorkflowCliError("MODEL_WRITE_REFUSED", `gate ${id} is released in Atelier; a model does not release it through the CLI`, {
        gate: id,
        remedy: MODEL_WRITE_REMEDY,
      });
    }
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => releaseGate(workspace, {
      occurredAt: at,
      id,
      reason: values.reason ?? "",
      actorId: values.actor ?? "",
    }));
    const released = state.gates.find((entry) => entry.id === id);
    writeState(io, state, released === undefined ? undefined : { ...released });
    return;
  }
  // INC-027 (TCRN-CROSS-INC-027): the event chain itself, read in windows.
  //
  // `export` was the only read that returned events at all, and it refuses any
  // workspace whose canonical form exceeds one MiB — which three of the four
  // chains on this platform already do (1,825,251 / 1,160,601 / 1,134,120
  // canonical event bytes when this was filed). So the one thing a mirror needs in
  // order to reproduce a chain was unreachable precisely on the chains large
  // enough to be worth mirroring. Records come back verbatim, in chain order, so
  // the concatenation of every page is exactly the array `export` would have
  // emitted and feeds validateEventChain unmodified.
  if (command === "event-list") {
    const values = parseArguments(rest, ["workspace", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    io.write(eventPage(state, values));
    return;
  }
  // TCRN-CROSS-STORY-475 (MIN-227 D9, D10): a decision is written down in one command. Every
  // conference verb -- open, append-position, close, cancel and the three conference reads -- is
  // retired and answers CLI_COMMAND_UNKNOWN; every conference event already on a chain still
  // replays, and the minutes its closes wrote are read with minutes-list and minutes-show.
  if (command === "minutes-record") {
    const values = parseArguments(rest, [...shared, "project-id", "external-key", "title", "summary", "decisions", "decisions-file", "decided-by", "work-ids", "actor"]);
    required(values, [...requiredShared, "project-id", "title", "summary"]);
    if ((values.decisions === undefined) === (values["decisions-file"] === undefined)) {
      fail("CLI_ARGUMENT_MALFORMED", "minutes-record takes exactly one of --decisions and --decisions-file");
    }
    const decisions = values["decisions-file"] === undefined ? listValue(values.decisions) : decisionsFromFile(values["decisions-file"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => recordMinutes(workspace, {
      occurredAt: at,
      projectId: values["project-id"] ?? "",
      title: values.title ?? "",
      summary: values.summary ?? "",
      decisions,
      decidedBy: listValue(values["decided-by"]),
      linkedWorkIds: listValue(values["work-ids"]),
      ...(values["external-key"] === undefined ? {} : { externalKey: values["external-key"] }),
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    const written = writtenIdsField();
    const recorded = minutesById(state, (written.ids ?? []).find((id) => id.startsWith("minutes:")) ?? "");
    // TCRN-CROSS-STORY-476 R4: recorded minutes ask whether there is knowledge to extract.
    const [hint] = await knowledgeHints(workspace, at, state, [{ minutesId: recorded.id }]);
    io.write(canonicalJson({
      reasonCode: "MINUTES_RECORDED",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      ...written,
      id: recorded.id,
      externalKey: recorded.externalKey,
      decisions: recorded.decisions,
      ...(hint === undefined ? {} : { knowledgeHint: hint }),
    }));
    return;
  }
  // Every live minutes record, new and historical, in the order recorded; --work-id keeps the ones
  // that link the work record or that the work record names as decided-in.
  if (command === "minutes-list") {
    const values = parseArguments(rest, ["workspace", "project-id", "work-id", "limit", "offset"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const workId = values["work-id"];
    const decidedIn = workId === undefined ? [] : workRelations(state, workId).forward.decidedIn;
    const records = minutesView(state).filter((entry) =>
      (values["project-id"] === undefined || entry.projectId === values["project-id"]) &&
      (workId === undefined || entry.linkedWorkIds.includes(workId) || decidedIn.includes(entry.id)));
    io.write(canonicalJson(paginate(state, "minutes", records, values)));
    return;
  }
  // One minutes record by id or by external key, with the work records that name it as decided-in.
  if (command === "minutes-show") {
    const values = parseArguments(rest, ["workspace", "id", "external-key"]);
    required(values, ["workspace"]);
    if ((values.id === undefined) === (values["external-key"] === undefined)) {
      fail("CLI_ARGUMENT_MALFORMED", "minutes-show takes exactly one of --id and --external-key");
    }
    const state = await validateWorkspace(values.workspace ?? "");
    const record = minutesById(state, values.id ?? values["external-key"] ?? "");
    io.write(canonicalJson({
      reasonCode: "WORKSPACE_RECORD_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      kind: "minutes",
      record,
      decides: workRelations(state, record.id).reverse.decides,
    }));
    return;
  }
  // TCRN-CROSS-STORY-485 R1 (MIN-227 D4; TCRN-CROSS-SUB-345): the gates a library declares, one
  // configuration record each, keyed by name: what runs (an argv), in which directory of the project,
  // which paths under it it covers, and whether it is required, enabled and release-only.
  if (command === "gates-config-list") {
    const values = parseArguments(rest, ["workspace"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    io.write(canonicalJson(paginate(state, "gate", listGates(state), values)));
    return;
  }
  // Declaring a gate that exists keeps whatever the flags leave out; a new gate runs in the project
  // itself (--root .), covers every path (--covers **), and is required and enabled, not release-only.
  // TCRN-CROSS-STORY-508 R7: --order places the gate in a plan; a new gate without it has none.
  if (command === "gates-config-set") {
    const values = parseArguments(rest, [...shared, "name", "command", "root", "covers", "required", "enabled", "release-only", "order", "actor"]);
    required(values, [...requiredShared, "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const name = values.name ?? "";
    const commandValue = values.command === undefined ? undefined : gateCommandValue(values.command);
    const requiredValue = optionalBoolean(values.required, "required");
    const enabledValue = optionalBoolean(values.enabled, "enabled");
    const releaseOnlyValue = optionalBoolean(values["release-only"], "release-only");
    const orderValue = boundedInteger(values, "order");
    const state = await withWriteLock(workspace, at, async () => {
      const existing = listGates(await materializeWorkspace(workspace)).find((gate) => gate.name === name);
      if (commandValue === undefined && existing === undefined) fail("CLI_ARGUMENT_MISSING", "command");
      const order = orderValue ?? existing?.order;
      return setGate(workspace, {
        occurredAt: at,
        name,
        gate: {
          command: commandValue ?? existing?.command,
          root: values.root ?? existing?.root ?? ".",
          covers: values.covers === undefined ? existing?.covers ?? ["**"] : listValue(values.covers),
          required: requiredValue ?? existing?.required ?? true,
          enabled: enabledValue ?? existing?.enabled ?? true,
          releaseOnly: releaseOnlyValue ?? existing?.releaseOnly ?? false,
          ...(order === undefined ? {} : { order }),
        },
        ...(values.actor ? { actorId: values.actor } : {}),
      });
    });
    writeState(io, state, undefined, undefined, { gate: listGates(state).find((gate) => gate.name === name) ?? null });
    return;
  }
  if (command === "gates-config-remove") {
    const values = parseArguments(rest, [...shared, "name", "actor"]);
    required(values, [...requiredShared, "name"]);
    const workspace = values.workspace ?? "";
    const at = values.at ?? "";
    const state = await withWriteLock(workspace, at, async () => removeGate(workspace, {
      occurredAt: at, name: values.name ?? "",
      ...(values.actor ? { actorId: values.actor } : {}),
    }));
    writeState(io, state, undefined, undefined, { removed: values.name ?? "" });
    return;
  }
  // TCRN-CROSS-STORY-485 R2 (MIN-235 D8): the gates a change and optional Story need. Non-release
  // plans name their Git base, and --work-id binds exact Story coverage alongside path coverage.
  if (command === "gates-plan") {
    const values = parseArguments(rest, ["workspace", "project", "base", "release", "work-id"]);
    required(values, ["workspace"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const plan = await planGates({
      projectRoot: await gatesProjectRoot(state.metadata.workspaceId, values.project),
      gates: listGates(state),
      release: booleanValue(values.release, "release"),
      ...(values.base === undefined ? {} : { base: values.base }),
      workIds: values["work-id"] === undefined ? [] : listValue(values["work-id"]),
    });
    io.write(canonicalJson({
      reasonCode: "GATES_PLAN_READY",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      ...plan,
    }));
    return;
  }
  // TCRN-CROSS-STORY-485 R3: run the plan's gates, every one of them whatever the ones before it did,
  // and record the run in this device's cache of the library under the digest of the tree it ran
  // on. The answer lists every red gate, and the required ones among them apart.
  if (command === "gates-run") {
    const values = parseArguments(rest, ["workspace", "at", "project", "base", "release", "work-id"]);
    required(values, ["workspace", "at"]);
    const state = await validateWorkspace(values.workspace ?? "");
    const plan = await planGates({
      projectRoot: await gatesProjectRoot(state.metadata.workspaceId, values.project),
      gates: listGates(state),
      release: booleanValue(values.release, "release"),
      ...(values.base === undefined ? {} : { base: values.base }),
      workIds: values["work-id"] === undefined ? [] : listValue(values["work-id"]),
    });
    const { run, recordPath } = await runGates(plan, { libraryId: state.metadata.workspaceId, at: values.at ?? "" });
    io.write(canonicalJson({
      reasonCode: "GATES_RUN_COMPLETED",
      workspaceId: state.metadata.workspaceId,
      version: state.version,
      headEventHash: state.headEventHash,
      ok: run.reds.length === 0,
      reds: run.reds,
      requiredReds: run.gates.filter((gate) => gate.required && !gate.ok).map((gate) => gate.name),
      run,
      recordPath,
    }));
    return;
  }
  fail("CLI_COMMAND_UNKNOWN", command);
}
