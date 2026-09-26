// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertStrictInstant, canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import { ARTIFACT_LANGUAGE_TAGS, parsePromptLanguages } from "./knowledge-language.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY } from "./names.js";
import { MACHINE_SETTINGS_CATALOG } from "./machine-settings.js";
import {
  LEGACY_DISPATCH_TIERS_SETTING_KEY,
  MODELS_TIERS_DEFAULT_VALUE,
  MODELS_TIERS_SETTING_KEY,
  ModelsTiersError,
  legacyTiersValueToModelsTiersValue,
  parseModelsTiers,
} from "./models-tiers.js";

/**
 * Settings are a deliberately small engine-owned overlay surface. The generic
 * profile remains the authority for layer semantics; this module owns the
 * bounded vocabulary that the workspace can actually consume.
 */
export const SETTINGS_CATALOG_VERSION = "tcrn.settings-catalog.v1" as const;
export const WORKSPACE_SETTING_VERSION = "tcrn.workspace-setting.v1" as const;
export const SETTINGS_LAYER_KIND = "workspace_configuration" as const;

export const SETTINGS_REASON_CODES = Object.freeze([
  "SETTINGS_KEY_DEVICE_LEVEL",
  "SETTINGS_KEY_UNREGISTERED",
  "SETTINGS_RECORD_INVALID",
  "SETTINGS_VALUE_INVALID",
] as const);

// TCRN-CROSS-STORY-469 R2, R3 (MIN-227 D13): two layers of configuration. A project-level key is
// an event in the library, so it travels with the library and every device merges it to the same
// value (the later writer in merge order wins); a device-level key lives only in this device's
// directory (machine-settings.ts). Every key of this catalog is project-level.
export type SettingLayer = "project" | "device";
export const SETTINGS_PROJECT_LAYER = "project" as const satisfies SettingLayer;
export const SETTINGS_DEVICE_LAYER = "device" as const satisfies SettingLayer;

// A catalog deletion must leave a replay-compatibility marker behind. Keep this
// list separate from the live catalog: old events may be read, but the setting
// is not a valid target for any new write.
// TCRN-CROSS-MIN-225 D1/D3 (TCRN-CROSS-SUB-258): fitness.minEvents and fitness.windowDays retire with
// the time-based retirement they configured; their recorded values stay readable history.
// TCRN-CROSS-STORY-475 R3 (MIN-227 D10): conference.positionBudgetBytes and
// execution.independenceFloor retire with the conference write verbs they governed.
// TCRN-CROSS-STORY-474 (MIN-227 D7): injection.budgetBytes retires with the session-wide injection
// it budgeted; a prompt's own budget is injection.perPromptBytes.
// TCRN-CROSS-STORY-484 R3, R5 (MIN-227 D3, D11): the dispatch keys retire with dispatch modes and
// classes (execution.dispatchModes, dispatchMode, dispatchClasses); the keys of the mechanisms D3
// switches off retire with them (backup.*, the two subagent-plan keys, execution.subagentPolicy);
// driver.capabilityProfile and storage.backend retire because nothing reads them; and
// execution.maxDispatchDepth retires because nothing reads it either (R5: the consumer search found
// only the catalog, the Atelier copy and its own test). execution.dispatchTiers is renamed
// models.tiers: see RENAMED_SETTING_KEYS.
export const RETIRED_SETTING_KEYS: readonly string[] = Object.freeze([
  "backup.cadence",
  "backup.destination",
  "conference.positionBudgetBytes",
  "driver.capabilityProfile",
  "execution.claudeCodeSubagentPlan",
  "execution.codexSubagentPlan",
  "execution.dispatchClasses",
  "execution.dispatchMode",
  "execution.dispatchModes",
  "execution.dispatchTiers",
  "execution.independenceFloor",
  "execution.maxDispatchDepth",
  "execution.personalessDispatch",
  "execution.subagentPolicy",
  "fitness.minEvents",
  "fitness.windowDays",
  "injection.budgetBytes",
  "model.economyTier",
  "storage.backend",
]);

export type SettingsReasonCode = typeof SETTINGS_REASON_CODES[number];
export type SettingValueType = "enum" | "path" | "string" | "url";
export type SettingControlType = "enum" | "boolean" | "number" | "text";

export type SettingKey =
  | "artifact.language"
  | "design.authority"
  | "engine.requiredVersion"
  | "execution.maxConcurrentSubagents"
  | "injection.perPromptBytes"
  | "knowledge.aggregateBytes"
  | "knowledge.articlesPath"
  | "models.tiers"
  | "quota.fiveHourParallelOffPercent"
  | "quota.fiveHourWaitPercent"
  | "quota.weeklyParallelOffPercent"
  | "quota.weeklyWaitPercent"
  | "retrieval.promptLanguages"
  | "retrieval.scopeExcerptBytes"
  | "retrieval.tau"
  | "storage.segmentBytes"
  | "storage.snapshotEveryEvents"
  | "workspace.generatedArtifactsPath";

// TCRN-CROSS-STORY-484 R3: a retired key whose value lives on under a new name. New writes use the
// new name only (the old one is unregistered); replay reads a recorded value of the old name as the
// new name's value, converted, so it stays the effective value until a write of the new name, the
// later event in merge order, supersedes it. No engine from this change on writes the old name, so
// every old-name event a chain holds comes before its first new-name event.
export const RENAMED_SETTING_KEYS: Readonly<Record<string, SettingKey>> = Object.freeze({
  [LEGACY_DISPATCH_TIERS_SETTING_KEY]: MODELS_TIERS_SETTING_KEY,
});

const renamedValueConverters: Readonly<Record<string, (value: string) => string>> = Object.freeze({
  [LEGACY_DISPATCH_TIERS_SETTING_KEY]: legacyTiersValueToModelsTiersValue,
});

export interface SettingsCatalogEntry {
  readonly key: SettingKey;
  readonly type: SettingValueType;
  readonly controlType: SettingControlType;
  readonly layer: typeof SETTINGS_PROJECT_LAYER;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly defaultValue: string | null;
  // TCRN-CROSS-STORY-484 R4: whether a model may write this key through the CLI. False unless the
  // entry says otherwise; the CLI refusal that reads it is TCRN-CROSS-SUB-341's.
  readonly modelWritable: boolean;
  readonly allowedValues?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly trueValue?: string;
  readonly falseValue?: string;
}

export interface WorkspaceSettingRecord {
  readonly schemaVersion: typeof WORKSPACE_SETTING_VERSION;
  readonly key: SettingKey;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly value: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly tombstone: false;
}

export interface SettingsCatalogReadback {
  readonly schemaVersion: typeof SETTINGS_CATALOG_VERSION;
  readonly layerKind: typeof SETTINGS_LAYER_KIND;
  readonly workspaceId: string;
  readonly settings: readonly {
    readonly key: SettingKey;
    readonly type: SettingValueType;
    readonly controlType: SettingControlType;
      readonly layer: typeof SETTINGS_PROJECT_LAYER;
      readonly defaultValue: string | null;
      readonly currentValue: string | null;
      readonly modelWritable: boolean;
      readonly allowedValues?: readonly string[];
      readonly min?: number;
      readonly max?: number;
      readonly trueValue?: string;
      readonly falseValue?: string;
    }[];
}

export class SettingsError extends Error {
  readonly reasonCode: SettingsReasonCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(reasonCode: SettingsReasonCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "SettingsError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: SettingsReasonCode, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new SettingsError(reasonCode, message, details);
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
}

function assertCanonicalString(value: unknown, label: string, maximumLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value.includes("\u0000")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must be a non-empty bounded string`);
  }
  try {
    canonicalJson(value);
  } catch {
    fail("SETTINGS_VALUE_INVALID", `${label} is not canonical JSON`);
  }
}

function assertWorkspaceRelativeSettingPath(value: string, label: string): void {
  if (isAbsolute(value) || value.includes("\\")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must be a workspace-relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must not escape its workspace`);
  }
}

// TCRN-CROSS-STORY-380. The half of an absolute artifact root's admission rule that this
// function is allowed to decide.
//
// What it may decide is bounded by WHERE IT RUNS. validateWorkspaceSettingRecord is on the
// replay path (packages/core/src/workspace.ts, the settings reducer), so every predicate
// here is answered again on every machine that ever replays this chain. A predicate that
// asked the filesystem whether the directory exists, or compared the path against this
// machine's home, would make a chain recorded on one machine unreplayable on the next —
// the exact opposite of what a portable content-addressed store is for. Shape, and
// containment relative to the workspace being replayed, are the two things that mean the
// same thing everywhere, so they are the two things decided here.
//
// "Outside the machine control home, a real directory, not a symbolic link" is decided at
// the two moments the path is actually used, by assertGeneratedArtifactsRoot in
// artifact-store.ts: `settings-set` calls it before recording the value, and
// `artifact-put` calls it again before writing a byte, because a directory that was real
// when it was declared is not necessarily real when it is used.
function assertAbsoluteArtifactsSettingPath(value: string, label: string, workspaceRoot?: string): void {
  if (value.includes("\\")) {
    fail("SETTINGS_VALUE_INVALID", `${label} must not contain a backslash`);
  }
  // Containment below is decided on the RESOLVED path, so an unnormalized value would be
  // judged as something other than what was written. Refusing it is cheaper than
  // normalizing it: silently storing a different string than the operator typed is the
  // same act the url branch below refuses to commit when it declines to upgrade http.
  if (resolve(value) !== value) {
    fail("SETTINGS_VALUE_INVALID", `${label} must be a normalized absolute path`);
  }
  if (workspaceRoot === undefined) return;
  const workspace = resolve(workspaceRoot);
  const destination = resolve(value);
  if (isInside(workspace, destination) || isInside(resolve(workspace, LEGACY_CONTROL_DIRECTORY), destination)) {
    fail("SETTINGS_VALUE_INVALID", `${label} must be outside the workspace and its control tree`);
  }
}

// When a key is removed from this catalog, add it to RETIRED_SETTING_KEYS in the
// same change so historical events remain legible without reopening new writes.
// TCRN-CROSS-STORY-484 R4: an entry is model-writable only when it says so. No entry says so: every
// key here is an Owner decision (models.tiers, the quota thresholds, the concurrency limit) or is
// written at setup rather than during work, so a model changing one through the CLI is the
// unapproved change R4 refuses. A key that turns out to be routine model work gets
// `modelWritable: true` here, with its reason.
const catalogEntries: readonly (Omit<SettingsCatalogEntry, "layer" | "modelWritable"> & { readonly modelWritable?: boolean })[] = [
  {
    // TCRN-CROSS-STORY-364: the language this workspace writes its knowledge cards in.
    // Its value set is the roster knowledge-language.ts can actually judge, so the two
    // cannot drift. A new installation defaults to English; this platform records zh-CN.
    key: "artifact.language",
    type: "enum",
    controlType: "enum",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "en",
    allowedValues: [...ARTIFACT_LANGUAGE_TAGS],
  },
  {
    // INC-193: which design system this workspace treats as its authority, named by the
    // URL of that system's own documentation. Optional — a workspace with no design
    // system leaves it unset — and purely declarative: the engine never fetches this
    // address and never checks what is behind it, because doing so would cross the
    // offline boundary. Its value set is the whole web, not a closed roster, so it is
    // not vocabulary and does not appear in the dictionary.
    key: "design.authority",
    type: "url",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    key: "engine.requiredVersion",
    type: "string",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    // INIT-027 S239. An orchestration control, a string on the governed surface so it stays
    // compatible with the settings transport; its numeric domain is enforced below.
    // TCRN-CROSS-STORY-484 R5: kept (MIN-229 D2); the orchestrating conversation reads it.
    key: "execution.maxConcurrentSubagents",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "8",
    min: 1,
    max: 32,
  },
  {
    key: "injection.perPromptBytes",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "1600",
    min: 1,
    max: 1600,
  },
  {
    key: "knowledge.aggregateBytes",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "131072",
    min: 4096,
    max: 1_048_576,
  },
  {
    // Article files are repository material, not knowledge-store control bytes. A
    // relative value is anchored at the workspace root; an absolute value is stored
    // as the normalized absolute path the operator supplied. Both forms are refused
    // when they name the control tree, because article writes use ordinary file IO.
    key: "knowledge.articlesPath",
    type: "path",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "docs/knowledge/articles",
  },
  {
    // TCRN-CROSS-STORY-484 R3 (MIN-227 D11, D12): the model tiers per host, each tier a runner, a
    // model and an effort; models-tiers.ts owns the shape and the default table. It replaces
    // execution.dispatchTiers (RENAMED_SETTING_KEYS).
    key: "models.tiers",
    type: "string",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: MODELS_TIERS_DEFAULT_VALUE,
  },
  {
    // TCRN-CROSS-STORY-484 (MIN-233 D2): when the orchestrating conversation shrinks its parallel
    // subagents. Each is a percentage of a usage window: at or above fiveHourParallelOffPercent of
    // the five-hour window it runs one subagent at a time, at or above fiveHourWaitPercent it
    // dispatches none until the window resets; the weekly pair reads the weekly window the same
    // way. weeklyWaitPercent has no default: unset, the weekly window never makes it wait.
    key: "quota.fiveHourParallelOffPercent",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "75",
    min: 1,
    max: 100,
  },
  {
    key: "quota.fiveHourWaitPercent",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "90",
    min: 1,
    max: 100,
  },
  {
    key: "quota.weeklyParallelOffPercent",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "95",
    min: 1,
    max: 100,
  },
  {
    key: "quota.weeklyWaitPercent",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
    min: 1,
    max: 100,
  },
  {
    // TCRN-CROSS-STORY-364: which prompt languages this workspace expects questions in. A
    // list in the one value shape this catalog has: comma-separated roster tags. Unset reads
    // as the artefact language alone, which is the default requirement 1 states.
    key: "retrieval.promptLanguages",
    type: "string",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: null,
  },
  {
    key: "retrieval.scopeExcerptBytes",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "512",
    min: 1,
    max: 65_536,
  },
  {
    // TCRN-CROSS-STORY-362, STORY-474 R3: the strong-hit threshold, in bm25 units. A prompt whose
    // best hit scores below it is answered with nothing (RECALL_NO_STRONG_HIT); above it, it is
    // also every hit's absolute floor. Its default is RECALL_STRONG_TAU (recall.ts), calibrated by
    // retrieval-eval (tests/fixtures/retrieval-eval/strong-threshold.json, TCRN-CROSS-SUB-303). A
    // string-typed number like every other numeric setting here, so the catalog keeps one value
    // shape; the verb parses it and refuses a value it cannot use.
    key: "retrieval.tau",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "17",
    min: 0,
    max: 100,
  },
  {
    key: "storage.segmentBytes",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    // TCRN-CROSS-STORY-468/469: the size a library stream segment rolls at. One MiB keeps what a
    // sync client re-uploads per append small.
    defaultValue: "1048576",
    min: 4096,
    max: 67108864,
  },
  {
    key: "storage.snapshotEveryEvents",
    type: "string",
    controlType: "number",
    layerKind: SETTINGS_LAYER_KIND,
    defaultValue: "512",
    min: 1,
    max: 20_000,
  },
  {
    key: "workspace.generatedArtifactsPath",
    type: "path",
    controlType: "text",
    layerKind: SETTINGS_LAYER_KIND,
    // TCRN-CROSS-STORY-469 R1: relative to the library root, its artifacts/ directory.
    defaultValue: DIRECTORY.artifacts,
  },
];

export const SETTINGS_CATALOG: readonly SettingsCatalogEntry[] = Object.freeze(
  catalogEntries.slice().sort((left, right) => compareCanonicalText(left.key, right.key)).map((entry) => Object.freeze({
    ...entry,
    layer: SETTINGS_PROJECT_LAYER,
    modelWritable: entry.modelWritable ?? false,
    ...(entry.allowedValues === undefined ? {} : { allowedValues: Object.freeze([...entry.allowedValues]) }),
  })),
);

/**
 * Refuse a device-level key on a project-level verb (settings-set, settings-remove): it belongs
 * to this device only, so it is never written into a library. The refusal names the verb that
 * writes it.
 */
export function assertProjectSettingKey(key: unknown): void {
  if (typeof key === "string" && MACHINE_SETTINGS_CATALOG.some((entry) => entry.key === key)) {
    fail("SETTINGS_KEY_DEVICE_LEVEL", `${key} is a device-level setting: it stays in this device's directory; set it with machine-settings-set`, {
      key,
      layer: SETTINGS_DEVICE_LAYER,
      remedy: "machine-settings-set",
    });
  }
}

const catalogByKey = new Map<SettingKey, SettingsCatalogEntry>(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
);

export function isRetiredSettingKey(key: unknown): boolean {
  return typeof key === "string" && RETIRED_SETTING_KEYS.some((retiredKey) => retiredKey === key);
}

/** The key a retired key was renamed to (RENAMED_SETTING_KEYS), or undefined when it was not renamed. */
export function renamedSettingKey(key: unknown): SettingKey | undefined {
  return typeof key === "string" && Object.hasOwn(RENAMED_SETTING_KEYS, key) ? RENAMED_SETTING_KEYS[key] : undefined;
}

/**
 * The record a recorded value of a renamed key stands for under its new name: the same revision and
 * instant, the value converted. Null when the key was not renamed, or when the recorded value cannot
 * be carried over; that record then stays history only, like any other retired key's.
 */
export function renamedSettingRecord(record: {
  readonly key: unknown;
  readonly value: unknown;
  readonly revision: unknown;
  readonly updatedAt: unknown;
}): WorkspaceSettingRecord | null {
  const successor = renamedSettingKey(record.key);
  const convert = typeof record.key === "string" && Object.hasOwn(renamedValueConverters, record.key) ? renamedValueConverters[record.key] : undefined;
  if (successor === undefined || convert === undefined || typeof record.value !== "string") return null;
  try {
    return validateWorkspaceSettingRecord({
      schemaVersion: WORKSPACE_SETTING_VERSION,
      key: successor,
      layerKind: SETTINGS_LAYER_KIND,
      value: convert(record.value),
      revision: record.revision,
      updatedAt: record.updatedAt,
      tombstone: false,
    });
  } catch {
    return null;
  }
}

const engineVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function engineVersionParts(value: string): readonly [number, number, number] {
  const match = engineVersionPattern.exec(value);
  if (match === null) {
    fail("SETTINGS_VALUE_INVALID", "engine.requiredVersion must be a stable semantic version");
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// The bounds come from the catalog entry that already declares them rather than from
// a second table keyed by name: the entry is what the portal renders its stepper from,
// so a separate copy here would be two answers to one question with nothing comparing
// them. Every numeric setting is validated by this one function, which is also why
// adding a numeric key needs no edit here.
function boundedInteger(value: string, entry: SettingsCatalogEntry): void {
  const minimum = entry.min ?? 1;
  const maximum = entry.max ?? Number.MAX_SAFE_INTEGER;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("SETTINGS_VALUE_INVALID", `${entry.key} must be a decimal integer from ${minimum} to ${maximum}`);
  }
}

/** Compare two validated engine versions using release precedence only. */
export function compareEngineVersions(left: string, right: string): number {
  const leftParts = engineVersionParts(left);
  const rightParts = engineVersionParts(right);
  for (const [index, leftPart] of leftParts.entries()) {
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function settingsCatalogEntry(key: unknown): SettingsCatalogEntry {
  if (typeof key !== "string") {
    fail("SETTINGS_KEY_UNREGISTERED", String(key));
  }
  const entry = catalogByKey.get(key as SettingKey);
  if (entry === undefined) {
    fail("SETTINGS_KEY_UNREGISTERED", key);
  }
  return entry;
}

export function validateSettingValue(key: unknown, value: unknown, workspaceRoot?: string): string {
  const entry = settingsCatalogEntry(key);
  assertCanonicalString(value, String(key), 4096);
  if (entry.key === MODELS_TIERS_SETTING_KEY) {
    try {
      parseModelsTiers(value);
    } catch (error) {
      if (error instanceof ModelsTiersError) fail("SETTINGS_VALUE_INVALID", error.message, error.details);
      throw error;
    }
  }
  if (entry.type === "enum" && !entry.allowedValues?.includes(value)) {
    fail(
      "SETTINGS_VALUE_INVALID",
      `${entry.key} is outside its closed enum; allowed values: ${entry.allowedValues?.join(", ") ?? "none"}`,
      { allowedValues: entry.allowedValues ?? [] },
    );
  }
  if (entry.key === "retrieval.promptLanguages" && parsePromptLanguages(value).length === 0) {
    fail(
      "SETTINGS_VALUE_INVALID",
      entry.key + " must be a comma-separated list of known language tags; allowed values: " + ARTIFACT_LANGUAGE_TAGS.join(", "),
      { allowedValues: [...ARTIFACT_LANGUAGE_TAGS] },
    );
  }
  if (entry.key === "engine.requiredVersion") {
    engineVersionParts(value);
  }
  if (entry.controlType === "number") {
    boundedInteger(value, entry);
  }
  if (entry.type === "url") {
    // Shape, never reachability: the engine is offline by construction, so "is this
    // address real" is a question it cannot ask and must not pretend to answer. http is
    // refused rather than upgraded — a declaration that names a plaintext address is a
    // different declaration from one that names a secure address, and silently changing
    // it would record something the writer did not say.
    let parsed;
    try { parsed = new URL(value); } catch { fail("SETTINGS_VALUE_INVALID", `${entry.key} must be a URL`); }
    if (parsed.protocol !== "https:") fail("SETTINGS_VALUE_INVALID", `${entry.key} must use https`);
    if (value.length > 512) fail("SETTINGS_VALUE_INVALID", `${entry.key} must be at most 512 characters`);
    if (/[\u0000-\u001f\u007f]/u.test(value)) fail("SETTINGS_VALUE_INVALID", `${entry.key} must not contain control characters`);
  }
  if (entry.key === "workspace.generatedArtifactsPath") {
    // TCRN-CROSS-STORY-380: an absolute root is admitted so generated blobs can be written
    // to a directory the operator manages — a cloud-synced folder is the case Owner asked
    // for — while the chain, the lease and this manifest stay inside the workspace. The
    // relative form is unchanged and remains the default.
    if (isAbsolute(value)) {
      assertAbsoluteArtifactsSettingPath(value, entry.key, workspaceRoot);
    } else {
      assertWorkspaceRelativeSettingPath(value, entry.key);
    }
  }
  if (entry.key === "knowledge.articlesPath") {
    if (/[\u0000-\u001f\u007f]/u.test(value)) fail("SETTINGS_VALUE_INVALID", `${entry.key} must not contain control characters`);
    if (isAbsolute(value)) {
      if (value.includes("\\") || resolve(value) !== value) {
        fail("SETTINGS_VALUE_INVALID", `${entry.key} must be a normalized absolute path`);
      }
      if (workspaceRoot !== undefined && isInside(resolve(workspaceRoot, LEGACY_CONTROL_DIRECTORY), resolve(value))) {
        fail("SETTINGS_VALUE_INVALID", `${entry.key} must not target the workspace control tree`);
      }
    } else {
      assertWorkspaceRelativeSettingPath(value, entry.key);
      if (workspaceRoot !== undefined && isInside(resolve(workspaceRoot, LEGACY_CONTROL_DIRECTORY), resolve(workspaceRoot, value))) {
        fail("SETTINGS_VALUE_INVALID", `${entry.key} must not target the workspace control tree`);
      }
    }
  }
  return value;
}

/** Resolve the article directory using the setting's explicit workspace-anchor contract. */
export function resolveKnowledgeArticlesPath(workspaceRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

export function validateWorkspaceSettingRecord(value: unknown, workspaceRoot?: string): WorkspaceSettingRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SETTINGS_RECORD_INVALID", "setting record must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["key", "layerKind", "revision", "schemaVersion", "tombstone", "updatedAt", "value"];
  const actual = Object.keys(record).sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(compareCanonicalText))) {
    fail("SETTINGS_RECORD_INVALID", "setting record fields are not exact");
  }
  const entry = settingsCatalogEntry(record.key);
  if (record.schemaVersion !== WORKSPACE_SETTING_VERSION || record.layerKind !== SETTINGS_LAYER_KIND ||
    record.tombstone !== false || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} record envelope is invalid`);
  }
  try {
    assertStrictInstant(record.updatedAt);
  } catch {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} updatedAt is invalid`);
  }
  validateSettingValue(entry.key, record.value, workspaceRoot);
  return record as unknown as WorkspaceSettingRecord;
}

export function createWorkspaceSettingRecord(
  key: unknown,
  value: unknown,
  revision: number,
  updatedAt: string,
  workspaceRoot?: string,
): WorkspaceSettingRecord {
  const entry = settingsCatalogEntry(key);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} revision is invalid`);
  }
  try {
    assertStrictInstant(updatedAt);
  } catch {
    fail("SETTINGS_RECORD_INVALID", `${entry.key} updatedAt is invalid`);
  }
  const normalizedValue = validateSettingValue(entry.key, value, workspaceRoot);
  return validateWorkspaceSettingRecord({
    schemaVersion: WORKSPACE_SETTING_VERSION,
    key: entry.key,
    layerKind: SETTINGS_LAYER_KIND,
    value: normalizedValue,
    revision,
    updatedAt,
    tombstone: false,
  }, workspaceRoot);
}

export function sortWorkspaceSettings(records: Iterable<WorkspaceSettingRecord>): readonly WorkspaceSettingRecord[] {
  return [...records].sort((left, right) => compareCanonicalText(left.key, right.key));
}

export function readSettingsCatalog(
  workspaceId: string,
  records: readonly WorkspaceSettingRecord[],
  effectiveValues: Partial<Record<SettingKey, string>> = {},
): SettingsCatalogReadback {
  return {
    schemaVersion: SETTINGS_CATALOG_VERSION,
    layerKind: SETTINGS_LAYER_KIND,
    workspaceId,
    settings: SETTINGS_CATALOG.map((entry) => ({
      key: entry.key,
      type: entry.type,
      controlType: entry.controlType,
      layer: entry.layer,
      defaultValue: entry.defaultValue,
      currentValue: records.find((record) => record.key === entry.key)?.value ?? effectiveValues[entry.key] ?? entry.defaultValue,
      modelWritable: entry.modelWritable,
      ...(entry.allowedValues === undefined ? {} : { allowedValues: entry.allowedValues }),
      ...(entry.min === undefined ? {} : { min: entry.min }),
      ...(entry.max === undefined ? {} : { max: entry.max }),
      ...(entry.trueValue === undefined ? {} : { trueValue: entry.trueValue }),
      ...(entry.falseValue === undefined ? {} : { falseValue: entry.falseValue }),
    })),
  };
}
