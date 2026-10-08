// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R1, R2, R5, R6 (MIN-227 D24; TCRN-CROSS-SUB-323): the engine side of the
// installation wizard, `setup`. The wizard has six modes (SETUP_MODES) and two steps:
//
//   planSetup   reads this device and the project and writes nothing. It answers SETUP_PLAN_READY:
//               the answers already given, the questions still open (each with the default it would
//               take), every file the apply would write, every original it would back up first, and
//               whatever stops the apply (a host file that is a symbolic link, a library already
//               there, an engine that is not installed), so the user sees it before confirming.
//               Its warnings name what does not stop the apply but should be seen first: a project
//               host file Git tracks, into which the apply writes this device's library path
//               (HOST_WRITABLE_ROOTS_TRACKED_BY_GIT, TCRN-CROSS-SUB-385 R16).
//   applySetup  runs a plan the user confirmed: SETUP_APPLIED, with each file written, the backup
//               directory, the same warnings and doctor's eight checks as the self-check.
//
// An open question takes its default when the plan is applied; a skill asks all of them on one
// screen first, and shows the files for one final confirmation (skill references install.md).
// Which mode fits this device and project is detectSetupContext's answer (R1): an engine already
// current and the project registered, an installation from before the rename (the old control
// directory in the project or the old device directory), or neither.
//
// Each mode is one row of the mode table: fresh (setup-fresh.ts), restore (setup-restore.ts: eight
// checks of the library before anything is written), and update, repair and uninstall
// (setup-maintain.ts: a newer engine or the previous one with --rollback true, the wiring put back,
// the wiring taken out with the library left as it is). migrate (TCRN-CROSS-STORY-489 R1,
// TCRN-CROSS-SUB-364) plans an old installation's migration: each old workspace the mapping names
// becomes the first stream of its project's library (migrate-legacy.ts), and the plan says what each
// partition carries and what stops it; SETUP_MIGRATE_NOTHING when there is no old installation. Its
// apply (TCRN-CROSS-SUB-365) makes this device's identity when it has none, then imports each
// partition and compares its head with the plan's, writes the registry entries with migratedFrom
// and sets the portal keys this device does not hold; a partition already migrated is skipped, so
// the same mapping applied again writes nothing. Then (TCRN-CROSS-SUB-366) it writes the language
// into the project's own library, takes off what the old installation left on this device
// (migrate-cleanup.ts: the old hooks, deny rules and inert key of the user's and each mapped
// project's host files, the template directories, the old helper's copies and markers, the old
// injection state and the old portal launchers) and wires the project as fresh does, all but the
// registry step, whose entries it wrote itself. Whatever the mode, the wizard never commits,
// pushes, edits .gitignore or deletes anything: what it takes out is moved into the device
// directory's backups.

import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { assertStrictInstant } from "../../protocol/src/index.js";
import { deviceFilePath, deviceHome as currentDeviceHome } from "./device-home.js";
import type { DoctorCheck } from "./doctor.js";
import { readEngineCurrent } from "./engine-home.js";
import { ARTIFACT_LANGUAGE_TAGS } from "./knowledge-language.js";
import { legacyControlDirectory } from "./legacy-workspace.js";
import { applyCleanup, planCleanup } from "./migrate-cleanup.js";
import type { MigrateCleanupInput, MigrateCleanupItem } from "./migrate-cleanup.js";
import { applyMigration, inferMigrationMapping, planMigration, readMigrationMapping } from "./migrate-legacy.js";
import type { MigrationApplied, MigrationPartitionPlan, MigrationPlan } from "./migrate-legacy.js";
import { DIRECTORY, LEGACY_DEVICE_DIRECTORY } from "./names.js";
import { readRegistry } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import {
  LANGUAGE_SETTING,
  SetupRecorder,
  WIRING_STEPS,
  applyDevice,
  applyFreshSetup,
  applyWiring,
  ensureSetupProjectBinding,
  defaultCloud,
  defaultLanguage,
  freshLanguageTag,
  libraryLanguage,
  scopeSetupTargetState,
  navigationChoice,
  planDevice,
  planEngineSource,
  planFreshSetup,
  planWiring,
  readDeviceNavigation,
  readEngineFiles,
  realTarget,
  setupApplied,
} from "./setup-fresh.js";
import type { WorkspaceState } from "./workspace.js";
import {
  applyRepairSetup,
  applyUninstallSetup,
  applyUpdateSetup,
  planRepairSetup,
  planUninstallSetup,
  planUpdateSetup,
} from "./setup-maintain.js";
import { applyRestoreSetup, planRestoreSetup } from "./setup-restore.js";
import type { RestoreCheck } from "./setup-restore.js";
import { materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting } from "./workspace.js";
import { scopedWorkspaceState } from "./project-scope.js";

export const SETUP_MODES = Object.freeze(["fresh", "restore", "update", "repair", "migrate", "uninstall"] as const);
export type SetupMode = typeof SETUP_MODES[number];

export const SETUP_PLAN_SCHEMA_VERSION = "einzbern.setup-plan.v1" as const;
export const SETUP_APPLIED_SCHEMA_VERSION = "einzbern.setup-applied.v1" as const;
// The actor the wizard names on each event it writes into a library (TCRN-CROSS-SUB-366): a library
// a migration imported carries its old chain, and a chain that enabled attestation refuses a write
// that names no actor. Like Atelier's agent:portal, it says which surface wrote the event; it proves
// nothing about who ran it.
export const SETUP_ACTOR = "agent:setup" as const;

export const SETUP_REASON_CODES = Object.freeze([
  // A given answer is not one the question takes (details: question).
  "SETUP_ANSWER_INVALID",
  // The mode needs an answer that has no default (restore's library, update's release, migrate's
  // mapping); the plan names the question.
  "SETUP_ANSWER_REQUIRED",
  // The plan names something that stops the apply; its blockers say what.
  "SETUP_BLOCKED",
  // The plan is for another device directory than the one this process writes through.
  "SETUP_DEVICE_HOME_MISMATCH",
  // No engine version is current on this device, or the current one lacks a file setup installs from.
  "SETUP_ENGINE_INCOMPLETE",
  "SETUP_ENGINE_NOT_INSTALLED",
  "SETUP_INPUT_INVALID",
  // A library is already at the chosen place, or the project is registered to another one.
  "SETUP_LIBRARY_CONFLICT",
  "SETUP_LIBRARY_EXISTS",
  // migrate found no installation from before the rename.
  "SETUP_MIGRATE_NOTHING",
  "SETUP_MODE_INVALID",
  // An option that belongs to another mode.
  "SETUP_OPTION_NOT_APPLICABLE",
  // A file setup would replace is not a regular file.
  "SETUP_TARGET_UNSUPPORTED",
] as const);
export type SetupReasonCode = typeof SETUP_REASON_CODES[number];

export class SetupError extends Error {
  readonly reasonCode: SetupReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: SetupReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "SetupError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export function setupFail(reasonCode: SetupReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new SetupError(reasonCode, message, details);
}

// ---- Answers, questions, writes ----

/** The four questions of a first installation, on one screen (R5), each with its flag. */
export const SETUP_QUESTIONS = Object.freeze(["artifacts", "cloud", "language", "navigation"] as const);
export type SetupQuestionId = typeof SETUP_QUESTIONS[number];
// The questions of the other modes: the library restore reads, the release update installs, what
// uninstall does with the managed sections, and which library each old workspace migrate finds
// becomes.
export type SetupModeQuestionId = "restore" | "archive" | "managedSections" | "mapping";

export interface SetupAnswers {
  // The library's place; a relative path is taken from the project root.
  readonly artifacts?: string;
  readonly cloud?: boolean;
  // A language tag the library writes in (artifact.language).
  readonly language?: string;
  // Whether AGENTS.md gets the navigation section (agents.navigation written or declined).
  readonly navigation?: boolean;
}

export interface ResolvedSetupAnswers {
  readonly artifacts: string;
  readonly cloud: boolean;
  readonly language: string;
  readonly navigation: boolean;
}

export interface SetupQuestion {
  readonly id: SetupQuestionId | SetupModeQuestionId;
  readonly flag: string;
  // What the apply takes when the question stays open; null when there is nothing to take, and the
  // plan then holds a SETUP_ANSWER_REQUIRED blocker until it is answered. migrate's mapping is the
  // exception: its default is null, and the apply takes the mapping the plan inferred
  // (migration.mapping) unless there is none, which is the blocker.
  readonly default: string | boolean | null;
  // The values it takes, or null for a path.
  readonly choices: readonly (string | boolean)[] | null;
}

// The options every mode may be given besides the answers; each belongs to the modes that list it.
export const SETUP_OPTIONS = Object.freeze(["artifacts", "cloud", "language", "navigation", "restore", "archive", "rollback", "managedSections", "mapping"] as const);
export type SetupOptionName = typeof SETUP_OPTIONS[number];

/** The options of the modes other than fresh, as given (C7 of INIT-053); each belongs to the modes that list it. */
export interface SetupModeOptions {
  // restore: the library to restore from; a relative path is taken from the project root.
  readonly restore?: string;
  readonly archive?: string;
  readonly rollback?: boolean;
  readonly managedSections?: "keep" | "remove";
  readonly mapping?: string;
}

// Besides the answers, the options of the other modes (C7 of INIT-053): a library to restore, a
// local archive, a rollback, what uninstall does with managed sections, a migration mapping.
export interface SetupOptions extends SetupModeOptions {
  readonly mode: string;
  // The project being set up.
  readonly projectRoot: string;
  // The instant everything this run writes is stamped with; backups are named by its second.
  readonly at: string;
  // The user's home, where both hosts keep their user hooks and skills; the process's by default.
  readonly home?: string;
  // The device directory; EINZBERN_HOME or ~/.einzbern by default.
  readonly deviceHome?: string;
  readonly answers?: SetupAnswers;
}

// What one write does to a file or directory: it is created, what is there is changed, or it is
// moved whole into the backups of this run (uninstall; nothing is deleted).
export type SetupWriteAction = "create" | "update" | "move";

export type SetupStep =
  | "engine"
  | "device"
  | "library"
  | "registry"
  | "skill-copies"
  | "launchers"
  | "host-hooks"
  | "writable-roots"
  | "machine-settings"
  | "managed-sections";

export interface SetupWrite {
  readonly step: SetupStep;
  readonly path: string;
  readonly action: SetupWriteAction;
}

export interface SetupBackup {
  // The original that is copied before it is replaced, and the directory the copy goes under.
  readonly path: string;
  readonly into: string;
}

export interface SetupBlocker {
  readonly step: SetupStep | "engine" | "context";
  readonly path: string;
  readonly reasonCode: string;
  readonly message: string;
}

// What the user should see before confirming but does not stop the apply (TCRN-CROSS-SUB-385 R16):
// a project host file Git tracks (it is in the index), into which the writable-roots step writes
// this device's library path, so that committing the file would publish the path. One per file,
// worded as scripts/host-render.mjs words it for the same file. The wizard changes nothing about
// it: it never commits, unstages or ignores a file.
export interface SetupWarning {
  readonly reasonCode: "HOST_WRITABLE_ROOTS_TRACKED_BY_GIT";
  // The host file, relative to the project root: .claude/settings.local.json or .codex/config.toml.
  readonly file: string;
  readonly message: string;
}

// ---- The context: which mode fits (R1) ----

export interface SetupContext {
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  // The version engine/current names, or null when none is current (or the pointer does not read).
  readonly engine: string | null;
  // Whether this device has its identity (device.json).
  readonly device: boolean;
  // The registry's entry for this project, and whether the registry could be read at all.
  readonly registered: RegistryEntry | null;
  readonly registryReadable: boolean;
  // An installation from before the rename: the old control directory in the project, or the old
  // device directory in the home.
  readonly legacy: {
    readonly detected: boolean;
    readonly controlDirectory: string | null;
    readonly deviceDirectory: string | null;
  };
  // The mode this context points to; the user chooses.
  readonly suggestedMode: SetupMode;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function projectDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0 || input.includes("\u0000")) {
    setupFail("SETUP_INPUT_INVALID", "the project must be a directory", { field: "project" });
  }
  const given = resolve(input);
  let real: string;
  try {
    real = await realpath(given);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") setupFail("SETUP_INPUT_INVALID", `the project ${given} does not exist`, { field: "project", project: given });
    throw error;
  }
  if (!(await stat(real)).isDirectory()) setupFail("SETUP_INPUT_INVALID", `the project ${given} is not a directory`, { field: "project", project: given });
  return real;
}

function suggestMode(engine: string | null, registered: RegistryEntry | null, legacyDetected: boolean): SetupMode {
  if (registered !== null) return engine === null ? "repair" : "update";
  return legacyDetected ? "migrate" : "fresh";
}

/**
 * This device and project as setup finds them (R1, R6): the engine that is current, whether the
 * device has its identity, the project's registration and an installation from before the rename.
 * Nothing is written.
 */
export async function detectSetupContext(input: { readonly projectRoot: string; readonly home?: string; readonly deviceHome?: string }): Promise<SetupContext> {
  const projectRoot = await projectDirectory(input.projectRoot);
  const home = resolve(input.home ?? homedir());
  const deviceHome = resolve(input.deviceHome ?? currentDeviceHome());
  let engine: string | null = null;
  try {
    engine = (await readEngineCurrent(deviceHome))?.version ?? null;
  } catch (error) {
    // A pointer that does not read is no engine; doctor names why.
    if (typeof (error as { reasonCode?: unknown }).reasonCode !== "string") throw error;
  }
  let registered: RegistryEntry | null = null;
  let registryReadable = true;
  try {
    registered = (await readRegistry(deviceHome)).entries.find((entry) => entry.projectPath === projectRoot) ?? null;
  } catch (error) {
    if (typeof (error as { reasonCode?: unknown }).reasonCode !== "string") throw error;
    registryReadable = false;
  }
  const controlDirectory = await legacyControlDirectory(projectRoot);
  const legacyDevice = join(home, LEGACY_DEVICE_DIRECTORY);
  const deviceDirectory = await exists(legacyDevice) ? legacyDevice : null;
  const detected = controlDirectory !== null || deviceDirectory !== null;
  return {
    projectRoot,
    home,
    deviceHome,
    engine,
    device: await exists(deviceFilePath(deviceHome)),
    registered,
    registryReadable,
    legacy: { detected, controlDirectory, deviceDirectory },
    suggestedMode: suggestMode(engine, registered, detected),
  };
}

// ---- Plans and their apply ----

export interface SetupPlan {
  readonly schemaVersion: typeof SETUP_PLAN_SCHEMA_VERSION;
  readonly reasonCode: "SETUP_PLAN_READY";
  readonly mode: SetupMode;
  readonly at: string;
  // The engine answering the plan.
  readonly engineVersion: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  readonly context: SetupContext;
  // The answers given, the questions still open with their defaults, and what the apply takes.
  readonly answers: SetupAnswers;
  // The options of the other modes, as given.
  readonly options: SetupModeOptions;
  readonly questions: readonly SetupQuestion[];
  readonly resolved: ResolvedSetupAnswers;
  // The engine version setup installs from: its skill tree and its two stable launchers.
  readonly engine: { readonly version: string | null; readonly directory: string | null };
  // The library: created at `path`, or one that is there reused (the project's registered library,
  // or the one restore reads); null while a mode still has to be told which.
  readonly library: { readonly path: string; readonly action: "create" | "reuse"; readonly libraryId: string | null } | null;
  // restore: the eight checks of the library, all passed (setup-restore.ts).
  readonly verification?: readonly RestoreCheck[];
  // update: the engine version current now and the one the apply makes current.
  readonly engineSwitch?: SetupEngineSwitch;
  // migrate: the mapping it follows and, for each partition, the library it becomes, the chain's
  // events and head, the gates that are not satisfied and the open work; the registry entries, the
  // device settings that move (migrate-legacy.ts) and what the cleanup takes off (migrate-cleanup.ts).
  readonly migration?: SetupMigrationPlan;
  // Every file and directory the apply writes, in the order it writes them, and every original it
  // copies first; backupDir holds the copies of this run.
  readonly writes: readonly SetupWrite[];
  readonly backups: readonly SetupBackup[];
  readonly backupDir: string | null;
  // Managed sections the user changed: they stay as they are and wait for rule-resolve.
  readonly pendingSections: readonly { readonly file: string; readonly id: string }[];
  // What stops the apply. A plan with any is still a plan: it is shown, not applied.
  readonly blockers: readonly SetupBlocker[];
  // What does not stop the apply but is shown before it: each project host file Git tracks while
  // the library sits outside the project, whether or not the apply changes the file.
  readonly warnings: readonly SetupWarning[];
}

/**
 * migrate's plan (TCRN-CROSS-STORY-489 R1, R3): the migration migrate-legacy.ts plans, with its
 * hostCleanup as migrate-cleanup.ts fills it in: each host file updated and each entry moved into
 * this run's backups, {kind, path, action, into}.
 */
export type SetupMigrationPlan = MigrationPlan & { readonly hostCleanup: readonly MigrateCleanupItem[] };

/** What migrate's apply did: the partitions, the registry entries and the portal keys (migrate-legacy.ts), and hostCleanup as it was made. */
export type SetupMigrationApplied = MigrationApplied & { readonly hostCleanup: readonly MigrateCleanupItem[] };

/** update and rollback: the version current before and after, and for an update the release it installs from. */
export interface SetupEngineSwitch {
  // The release archive or unpacked release directory; null for a rollback.
  readonly source: string | null;
  readonly from: string | null;
  readonly to: string;
  // The install-tree digest the release states; null for a rollback.
  readonly installTreeDigest: string | null;
}

/** The switch as it was made (engine-home.ts): copied or already there, and how many registered libraries the engine now current cannot open. */
export interface SetupEngineSwitched extends SetupEngineSwitch {
  readonly reasonCode: "ENGINE_UPDATED" | "ENGINE_ROLLED_BACK";
  readonly installed: "copied" | "reused" | null;
  readonly incompatible: number;
}

/**
 * The two columns a restore reports (R3): what came back with the library for the project, and what
 * never travels with a library and is set on each device, with the setup flag that sets it.
 */
export interface SetupColumns {
  readonly project: {
    readonly settings: readonly { readonly key: string; readonly value: string }[];
    readonly records: readonly { readonly collection: string; readonly count: number }[];
  };
  readonly device: readonly { readonly key: string; readonly value: string | null; readonly flag: string | null }[];
}

export interface SetupApplied {
  readonly schemaVersion: typeof SETUP_APPLIED_SCHEMA_VERSION;
  readonly reasonCode: "SETUP_APPLIED";
  readonly mode: SetupMode;
  readonly at: string;
  // The engine that applied the plan.
  readonly engineVersion: string;
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  // This device's id; null when it has none (a mode that writes no device file).
  readonly deviceId: string | null;
  readonly answers: ResolvedSetupAnswers;
  // The project's library; null when the mode ran for a project this device has not registered.
  readonly library: { readonly path: string; readonly libraryId: string; readonly created: boolean } | null;
  // Each file and directory written, and each original copied before it was replaced.
  readonly written: readonly SetupWrite[];
  readonly backups: readonly SetupBackup[];
  readonly backupDir: string | null;
  readonly pendingSections: readonly { readonly file: string; readonly id: string }[];
  // The plan's warnings, found again as the apply wired the project.
  readonly warnings: readonly SetupWarning[];
  // restore: the project-level settings that came back with the library, and the device-level ones
  // to set again here.
  readonly columns?: SetupColumns;
  // update: the engine switch it made.
  readonly engineSwitch?: SetupEngineSwitched;
  // migrate: each partition's library as the apply left it (imported, or skipped as migrated
  // already), each registry entry with migratedFrom, the portal keys (migrate-legacy.ts) and what
  // the cleanup took off (migrate-cleanup.ts).
  readonly migration?: SetupMigrationApplied;
  // doctor's eight checks right after the apply.
  readonly selfCheck: readonly DoctorCheck[];
}

/** What a mode's planner is given: the context and the checked inputs. */
export interface SetupModeInput {
  readonly mode: SetupMode;
  readonly at: string;
  readonly context: SetupContext;
  readonly answers: SetupAnswers;
  readonly options: SetupModeOptions;
}

/** What a mode's planner answers; planSetup puts it into the plan, with no warnings when the mode names none. */
export type SetupModePlan = Pick<SetupPlan, "questions" | "resolved" | "engine" | "library" | "writes" | "backups" | "backupDir" | "pendingSections" | "blockers" | "verification" | "engineSwitch" | "migration">
  & { readonly warnings?: readonly SetupWarning[] };

interface SetupModeEntry {
  readonly options: readonly SetupOptionName[];
  readonly plan: (input: SetupModeInput) => Promise<SetupModePlan>;
  readonly apply: (plan: SetupPlan) => Promise<SetupApplied>;
}

// migrate's questions, on one screen with the skill's references migrate.md: the mapping, then the
// three answers the project's wiring takes.
function migrateQuestions(input: SetupModeInput, defaults: ResolvedSetupAnswers): readonly SetupQuestion[] {
  const questions: SetupQuestion[] = [];
  if (input.options.mapping === undefined) questions.push({ id: "mapping", flag: "--mapping", default: null, choices: null });
  if (input.answers.cloud === undefined) questions.push({ id: "cloud", flag: "--cloud", default: defaults.cloud, choices: [true, false] });
  if (input.answers.language === undefined) questions.push({ id: "language", flag: "--language", default: defaults.language, choices: [...ARTIFACT_LANGUAGE_TAGS] });
  if (input.answers.navigation === undefined) questions.push({ id: "navigation", flag: "--navigation", default: defaults.navigation, choices: [true, false] });
  return questions;
}

// The fresh mode's steps a migration runs after its cleanup: every one but the registry, whose
// entries the migration writes itself, each with migratedFrom (migrate-legacy.ts). Built when it is
// asked for: the step list lives in a module this one sits in an import cycle with.
function migrateWiringSteps(): ReadonlySet<SetupStep> {
  return new Set(WIRING_STEPS.filter((step) => step !== "registry"));
}

// What the cleanup looks at (migrate-cleanup.ts): the home, the device directory, the old device
// directory, and each project the mapping names with the project setup runs for.
function migrateCleanupInput(context: SetupContext, partitions: readonly MigrationPartitionPlan[], navigation: boolean): MigrateCleanupInput {
  return {
    home: context.home,
    deviceHome: context.deviceHome,
    legacyDeviceHome: context.legacy.deviceDirectory,
    projectRoots: [...partitions.map((partition) => partition.projectRoot), context.projectRoot],
    navigation: navigationChoice(navigation),
  };
}

// The records the project's own library starts from: the old chain it is imported from, or, when an
// earlier run imported it, the library as it stands. Both are read from genesis and nothing is
// written; null for a partition the plan stops at.
async function ownLibraryState(recorder: SetupRecorder, own: MigrationPartitionPlan | null): Promise<WorkspaceState | null> {
  if (own === null || own.action === "blocked") return null;
  const source = own.action === "skip" ? own.target : own.legacyWorkspace;
  return recorder.attempt("library", source, () => materializeWorkspaceFromGenesis(source));
}

/**
 * Plan a migration (TCRN-CROSS-STORY-489 R1, R3; TCRN-CROSS-SUB-364, SUB-366): SETUP_MIGRATE_NOTHING
 * without an installation from before the rename. The mapping is --mapping's file (a relative one is
 * taken from the project), else the old workspace in the project itself; with neither, the question
 * stays open and SETUP_ANSWER_REQUIRED stops the apply. Each partition's plan comes from
 * planMigration. The writes are this device's identity when it has none, then the migration's in the
 * order it makes them, then the language of the project's own library, the cleanup
 * (migrate-cleanup.ts, whose items are migration.hostCleanup) and the fresh mode's steps from
 * skill-copies on, each file listed at the first step that writes it. Nothing is written.
 */
async function planMigrateSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers, options } = input;
  const { projectRoot, home, deviceHome, legacy } = context;
  if (!legacy.detected) {
    setupFail("SETUP_MIGRATE_NOTHING", "no installation from before the rename was found here: there is nothing to migrate", { mode: "migrate", remedy: "--mode fresh" });
  }
  const language = answers.language === undefined ? null : freshLanguageTag(answers.language);
  const recorder = new SetupRecorder(deviceHome, input.at);
  const engine = await planEngineSource(recorder, deviceHome);
  const deviceNavigation = await readDeviceNavigation(recorder, deviceHome);
  await planDevice(recorder, deviceHome);

  const mappingFile = options.mapping === undefined ? null : resolve(projectRoot, options.mapping);
  const mapping = mappingFile === null ? inferMigrationMapping(projectRoot, legacy.controlDirectory) : await readMigrationMapping(mappingFile);
  if (mapping === null) {
    recorder.block("library", projectRoot, "SETUP_ANSWER_REQUIRED",
      "name the migration mapping with --mapping <file>: the project whose library each old workspace becomes");
  }
  const planned = await planMigration({
    mapping,
    mappingFile,
    home,
    deviceHome,
    legacyDeviceHome: legacy.deviceDirectory,
    at: input.at,
    ...(answers.cloud === undefined ? {} : { cloud: answers.cloud }),
  });
  for (const write of planned.writes) recorder.write(write.step, write.path, write.action);
  for (const backup of planned.backups) recorder.backup(backup.step, backup.path);
  for (const blocker of planned.blockers) {
    // A file both readers refuse, such as this device's machine settings, stops the apply once.
    if (recorder.blockers.some((held) => held.step === blocker.step && held.path === blocker.path && held.reasonCode === blocker.reasonCode)) continue;
    recorder.block(blocker.step, blocker.path, blocker.reasonCode, blocker.message);
  }

  // The answers the project's own wiring takes: its library is the one its partition becomes, and
  // its language the one that library records (the old chain's, or the library's once imported).
  const own = planned.migration.partitions.find((partition) => partition.projectRoot === projectRoot) ?? null;
  const retainedState = await ownLibraryState(recorder, own);
  const ownState = retainedState === null ? null : await scopeSetupTargetState(projectRoot, own!.target, deviceHome, retainedState);
  const ownLanguage = ownState === null ? own?.language ?? null : libraryLanguage(ownState);
  const artifacts = own?.target ?? await realTarget(join(projectRoot, DIRECTORY.library));
  const defaults: ResolvedSetupAnswers = {
    artifacts,
    cloud: defaultCloud(context, artifacts),
    language: ownLanguage ?? defaultLanguage(),
    navigation: deviceNavigation !== "declined",
  };
  const resolved: ResolvedSetupAnswers = {
    artifacts,
    cloud: answers.cloud ?? defaults.cloud,
    language: language ?? defaults.language,
    navigation: answers.navigation ?? defaults.navigation,
  };
  if (own !== null && ownState !== null && ownLanguage !== resolved.language) recorder.write("library", own.target, "update");

  // The cleanup, then skill-copies, launchers, host-hooks, writable-roots, machine-settings and
  // managed-sections as fresh plans them. Without a mapping there are no projects to clean or wire
  // yet: the plan waits for its answer.
  let hostCleanup: readonly MigrateCleanupItem[] = [];
  let pending: readonly { readonly file: string; readonly id: string }[] = [];
  if (mapping !== null) {
    hostCleanup = await planCleanup(recorder, migrateCleanupInput(context, planned.migration.partitions, resolved.navigation));
    const files = engine.directory === null ? null : await readEngineFiles(recorder, engine.directory);
    pending = await planWiring(recorder, {
      projectRoot,
      home,
      deviceHome,
      library: own === null || ownState === null ? null : { path: own.target, libraryId: own.workspaceId, state: ownState },
      cloud: resolved.cloud,
      navigation: navigationChoice(resolved.navigation),
      deviceNavigation,
      engine: files,
      steps: migrateWiringSteps(),
    });
  }
  return {
    questions: migrateQuestions(input, defaults),
    resolved,
    engine: { version: engine.version, directory: engine.directory },
    // A partition migrated by an earlier run keeps the library it has.
    library: own === null ? null : { path: own.target, action: own.action === "skip" ? "reuse" : "create", libraryId: own.workspaceId },
    writes: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    pendingSections: pending,
    blockers: recorder.blockers,
    warnings: recorder.warnings,
    migration: { ...planned.migration, hostCleanup },
  };
}

// The project's own library records the language the plan resolved; a library that records it
// already is not written. The event names SETUP_ACTOR, which a chain that enabled attestation
// requires of every write.
async function applyLibraryLanguage(recorder: SetupRecorder, libraryPath: string, language: string, at: string, projectRoot: string, deviceHome: string): Promise<string> {
  const configurationProjectId = await ensureSetupProjectBinding(projectRoot, libraryPath, { at, deviceHome, actorId: SETUP_ACTOR });
  if (libraryLanguage(scopedWorkspaceState(await materializeWorkspace(libraryPath), configurationProjectId)) === language) return configurationProjectId;
  await setWorkspaceSetting(libraryPath, { key: LANGUAGE_SETTING, value: language, configurationProjectId, occurredAt: at, actorId: SETUP_ACTOR });
  recorder.write("library", libraryPath, "update");
  return configurationProjectId;
}

/**
 * Apply a confirmed migration (TCRN-CROSS-STORY-489 R1 to R4; TCRN-CROSS-SUB-365, SUB-366): this
 * device's identity when it has none, then applyMigration in the plan's order (each partition
 * imported and its head compared with the plan's, or skipped as migrated already; the registry
 * entries with migratedFrom; the portal keys); then the language of the project's own library, the
 * cleanup (migrate-cleanup.ts) and the fresh mode's steps from skill-copies on, each reading its
 * files again before it writes them. SETUP_APPLIED carries what it did as migration, hostCleanup
 * included, the project's own library, and doctor's eight checks. No old workspace is written and no
 * gate is satisfied.
 */
async function applyMigrateSetup(plan: SetupPlan): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome, resolved } = plan;
  const migration = plan.migration;
  if (migration === undefined || migration.mapping === null) {
    return setupFail("SETUP_INPUT_INVALID", "the plan names no migration to apply", { field: "plan" });
  }
  const directory = plan.engine.directory;
  if (directory === null) {
    return setupFail("SETUP_ENGINE_NOT_INSTALLED", "the plan names no engine version directory to install from", { deviceHome });
  }
  const recorder = new SetupRecorder(deviceHome, at);
  const device = await applyDevice(recorder, deviceHome, at);
  const applied = await applyMigration(recorder, { migration, deviceHome, at });
  const own = applied.partitions.find((partition) => partition.projectRoot === projectRoot) ?? null;
  const configurationProjectId = own === null ? undefined : await applyLibraryLanguage(recorder, own.target, resolved.language, at, projectRoot, deviceHome);
  const hostCleanup = await applyCleanup(recorder, { ...migrateCleanupInput(plan.context, migration.partitions, resolved.navigation), at });
  const pending = await applyWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    at,
    library: own === null ? null : { path: own.target, libraryId: own.libraryId },
    ...(configurationProjectId === undefined ? {} : { configurationProjectId }),
    cloud: resolved.cloud,
    navigation: navigationChoice(resolved.navigation),
    engineDirectory: directory,
    steps: migrateWiringSteps(),
    actorId: SETUP_ACTOR,
  });
  const receipt = await setupApplied(plan, recorder, {
    deviceId: device.deviceId,
    library: own === null ? null : { path: own.target, libraryId: own.libraryId, created: own.action === "imported" },
    pending,
  });
  // Project binding and wiring may enrich the imported registry entries. The receipt
  // describes the final explicit registration, not the earlier import snapshot.
  const registry = (await readRegistry(deviceHome)).entries;
  return { ...receipt, migration: { ...applied, registry, hostCleanup } };
}

// The mode table. Each row names the options its mode takes, its planner and its apply; the rows
// call into their modules lazily, so the order the modules load in never matters.
const MODE_TABLE: Readonly<Record<SetupMode, SetupModeEntry>> = Object.freeze({
  fresh: {
    options: ["artifacts", "cloud", "language", "navigation"],
    plan: (input: SetupModeInput): Promise<SetupModePlan> => planFreshSetup(input),
    apply: (plan: SetupPlan): Promise<SetupApplied> => applyFreshSetup(plan),
  },
  restore: {
    options: ["restore", "cloud", "navigation"],
    plan: (input: SetupModeInput): Promise<SetupModePlan> => planRestoreSetup(input),
    apply: (plan: SetupPlan): Promise<SetupApplied> => applyRestoreSetup(plan),
  },
  update: {
    options: ["archive", "rollback"],
    plan: (input: SetupModeInput): Promise<SetupModePlan> => planUpdateSetup(input),
    apply: (plan: SetupPlan): Promise<SetupApplied> => applyUpdateSetup(plan),
  },
  repair: {
    options: ["cloud", "navigation"],
    plan: (input: SetupModeInput): Promise<SetupModePlan> => planRepairSetup(input),
    apply: (plan: SetupPlan): Promise<SetupApplied> => applyRepairSetup(plan),
  },
  migrate: {
    options: ["mapping", "cloud", "language", "navigation"],
    plan: (input: SetupModeInput): Promise<SetupModePlan> => planMigrateSetup(input),
    apply: (plan: SetupPlan): Promise<SetupApplied> => applyMigrateSetup(plan),
  },
  uninstall: {
    options: ["managedSections"],
    plan: (input: SetupModeInput): Promise<SetupModePlan> => planUninstallSetup(input),
    apply: (plan: SetupPlan): Promise<SetupApplied> => applyUninstallSetup(plan),
  },
});

function isSetupMode(value: unknown): value is SetupMode {
  return typeof value === "string" && (SETUP_MODES as readonly string[]).includes(value);
}

function givenOptions(options: SetupOptions): readonly SetupOptionName[] {
  const answers = options.answers ?? {};
  const given: SetupOptionName[] = [];
  for (const name of SETUP_QUESTIONS) if (answers[name] !== undefined) given.push(name);
  if (options.restore !== undefined) given.push("restore");
  if (options.archive !== undefined) given.push("archive");
  if (options.rollback !== undefined) given.push("rollback");
  if (options.managedSections !== undefined) given.push("managedSections");
  if (options.mapping !== undefined) given.push("mapping");
  return given;
}

function checkedAnswers(answers: SetupAnswers): SetupAnswers {
  const invalid = (question: SetupQuestionId, message: string): never => setupFail("SETUP_ANSWER_INVALID", message, { question });
  if (answers.artifacts !== undefined &&
    (typeof answers.artifacts !== "string" || answers.artifacts.trim() === "" || answers.artifacts.includes("\u0000"))) {
    invalid("artifacts", "the library location must be a path");
  }
  if (answers.cloud !== undefined && typeof answers.cloud !== "boolean") invalid("cloud", "cloud is true or false");
  if (answers.language !== undefined && (typeof answers.language !== "string" || answers.language.trim() === "")) invalid("language", "the language is a language tag");
  if (answers.navigation !== undefined && typeof answers.navigation !== "boolean") invalid("navigation", "navigation is true or false");
  return {
    ...(answers.artifacts === undefined ? {} : { artifacts: answers.artifacts }),
    ...(answers.cloud === undefined ? {} : { cloud: answers.cloud }),
    ...(answers.language === undefined ? {} : { language: answers.language }),
    ...(answers.navigation === undefined ? {} : { navigation: answers.navigation }),
  };
}

function isPathText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");
}

function checkedModeOptions(options: SetupOptions): SetupModeOptions {
  const invalid = (field: string, message: string): never => setupFail("SETUP_INPUT_INVALID", message, { field });
  if (options.restore !== undefined && !isPathText(options.restore)) invalid("restore", "the library to restore must be a path");
  if (options.archive !== undefined && !isPathText(options.archive)) invalid("archive", "the archive must be a path");
  if (options.mapping !== undefined && !isPathText(options.mapping)) invalid("mapping", "the mapping must be a path");
  if (options.rollback !== undefined && typeof options.rollback !== "boolean") invalid("rollback", "rollback is true or false");
  if (options.managedSections !== undefined && options.managedSections !== "keep" && options.managedSections !== "remove") {
    invalid("managedSections", "managed sections are kept (keep) or have their markers removed (remove)");
  }
  return {
    ...(options.restore === undefined ? {} : { restore: options.restore }),
    ...(options.archive === undefined ? {} : { archive: options.archive }),
    ...(options.rollback === undefined ? {} : { rollback: options.rollback }),
    ...(options.managedSections === undefined ? {} : { managedSections: options.managedSections }),
    ...(options.mapping === undefined ? {} : { mapping: options.mapping }),
  };
}

/**
 * Plan a setup in `mode` (R1, R5): nothing is written. Answers SETUP_PLAN_READY with the answers
 * given, the open questions and their defaults, the files the apply would write and back up, and
 * whatever stops the apply. migrate answers SETUP_MIGRATE_NOTHING when it finds no installation from
 * before the rename (R6).
 */
export async function planSetup(options: SetupOptions): Promise<SetupPlan> {
  if (!isSetupMode(options.mode)) setupFail("SETUP_MODE_INVALID", `mode must be one of ${SETUP_MODES.join(", ")}`, { mode: String(options.mode) });
  const mode = options.mode;
  try {
    assertStrictInstant(options.at);
  } catch {
    setupFail("SETUP_INPUT_INVALID", "at must be a strict instant (YYYY-MM-DDTHH:MM:SSZ)", { field: "at" });
  }
  for (const [field, value] of [["home", options.home], ["deviceHome", options.deviceHome]] as const) {
    if (value !== undefined && (typeof value !== "string" || !isAbsolute(value))) setupFail("SETUP_INPUT_INVALID", `${field} must be an absolute path`, { field });
  }
  const entry = MODE_TABLE[mode];
  for (const option of givenOptions(options)) {
    if (!entry.options.includes(option)) setupFail("SETUP_OPTION_NOT_APPLICABLE", `${option} does not belong to setup --mode ${mode}`, { mode, option });
  }
  const answers = checkedAnswers(options.answers ?? {});
  const modeOptions = checkedModeOptions(options);
  const context = await detectSetupContext({
    projectRoot: options.projectRoot,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.deviceHome === undefined ? {} : { deviceHome: options.deviceHome }),
  });
  const planned = await entry.plan({ mode, at: options.at, context, answers, options: modeOptions });
  return {
    schemaVersion: SETUP_PLAN_SCHEMA_VERSION,
    reasonCode: "SETUP_PLAN_READY",
    mode,
    at: options.at,
    engineVersion: FRAMEWORK_VERSION,
    projectRoot: context.projectRoot,
    home: context.home,
    deviceHome: context.deviceHome,
    context,
    answers,
    options: modeOptions,
    ...planned,
    warnings: planned.warnings ?? [],
  };
}

/**
 * Apply a plan the user confirmed (R2, R5). A plan with blockers is refused (SETUP_BLOCKED, naming
 * the first), and so is one for another device directory than the one this process writes its
 * library records through. Each step reads its files again before it writes them.
 */
export async function applySetup(plan: SetupPlan): Promise<SetupApplied> {
  if (plan === null || typeof plan !== "object" || plan.reasonCode !== "SETUP_PLAN_READY" || !isSetupMode(plan.mode)) {
    setupFail("SETUP_INPUT_INVALID", "applySetup takes a plan from planSetup", { field: "plan" });
  }
  const first = plan.blockers[0];
  if (first !== undefined) {
    setupFail("SETUP_BLOCKED", `the plan cannot be applied: ${first.message}`, {
      blockers: String(plan.blockers.length),
      reasonCode: first.reasonCode,
      step: first.step,
      path: first.path,
    });
  }
  const writing = resolve(currentDeviceHome());
  if (plan.deviceHome !== writing) {
    setupFail("SETUP_DEVICE_HOME_MISMATCH", `the plan is for the device directory ${plan.deviceHome}, but this process writes through ${writing}`, {
      required: plan.deviceHome,
      actual: writing,
    });
  }
  return MODE_TABLE[plan.mode].apply(plan);
}
