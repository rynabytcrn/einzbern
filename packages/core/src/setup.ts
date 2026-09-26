// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R1, R2, R5, R6 (MIN-227 D24; TCRN-CROSS-SUB-323): the engine side of the
// installation wizard, `setup`. The wizard has six modes (SETUP_MODES) and two steps:
//
//   planSetup   reads this device and the project and writes nothing. It answers SETUP_PLAN_READY:
//               the answers already given, the questions still open (each with the default it would
//               take), every file the apply would write, every original it would back up first, and
//               whatever stops the apply (a host file that is a symbolic link, a library already
//               there, an engine that is not installed), so the user sees it before confirming.
//   applySetup  runs a plan the user confirmed: SETUP_APPLIED, with each file written, the backup
//               directory and doctor's eight checks as the self-check.
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
// the wiring taken out with the library left as it is). migrate answers SETUP_MIGRATE_PENDING when it
// finds an old installation, whose migration is the second batch's (SUB-364 to SUB-366). Whatever the
// mode, the wizard never commits, pushes, edits .gitignore or deletes anything: what it takes out is
// moved into the device directory's backups.

import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import { FRAMEWORK_VERSION } from "./index.js";
import { assertStrictInstant } from "../../protocol/src/index.js";
import { deviceFilePath, deviceHome as currentDeviceHome } from "./device-home.js";
import type { DoctorCheck } from "./doctor.js";
import { readEngineCurrent } from "./engine-home.js";
import { legacyControlDirectory } from "./legacy-workspace.js";
import { LEGACY_DEVICE_DIRECTORY } from "./names.js";
import { readRegistry } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import { applyFreshSetup, planFreshSetup } from "./setup-fresh.js";
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

export const SETUP_MODES = Object.freeze(["fresh", "restore", "update", "repair", "migrate", "uninstall"] as const);
export type SetupMode = typeof SETUP_MODES[number];

export const SETUP_PLAN_SCHEMA_VERSION = "einzbern.setup-plan.v1" as const;
export const SETUP_APPLIED_SCHEMA_VERSION = "einzbern.setup-applied.v1" as const;

export const SETUP_REASON_CODES = Object.freeze([
  // A given answer is not one the question takes (details: question).
  "SETUP_ANSWER_INVALID",
  // The mode needs an answer that has no default (restore's library, update's release); the plan
  // names the question.
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
  // migrate found one; its migration is not in this engine yet.
  "SETUP_MIGRATE_PENDING",
  "SETUP_MODE_INVALID",
  "SETUP_MODE_UNAVAILABLE",
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
// The questions of the other modes: the library restore reads, the release update installs, and
// what uninstall does with the managed sections.
export type SetupModeQuestionId = "restore" | "archive" | "managedSections";

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
  // plan then holds a SETUP_ANSWER_REQUIRED blocker until it is answered.
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
  // Every file and directory the apply writes, in the order it writes them, and every original it
  // copies first; backupDir holds the copies of this run.
  readonly writes: readonly SetupWrite[];
  readonly backups: readonly SetupBackup[];
  readonly backupDir: string | null;
  // Managed sections the user changed: they stay as they are and wait for rule-resolve.
  readonly pendingSections: readonly { readonly file: string; readonly id: string }[];
  // What stops the apply. A plan with any is still a plan: it is shown, not applied.
  readonly blockers: readonly SetupBlocker[];
}

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
  // restore: the project-level settings that came back with the library, and the device-level ones
  // to set again here.
  readonly columns?: SetupColumns;
  // update: the engine switch it made.
  readonly engineSwitch?: SetupEngineSwitched;
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

/** What a mode's planner answers; planSetup puts it into the plan. */
export type SetupModePlan = Pick<SetupPlan, "questions" | "resolved" | "engine" | "library" | "writes" | "backups" | "backupDir" | "pendingSections" | "blockers" | "verification" | "engineSwitch">;

interface SetupModeEntry {
  readonly options: readonly SetupOptionName[];
  readonly plan: (input: SetupModeInput) => Promise<SetupModePlan>;
  readonly apply: (plan: SetupPlan) => Promise<SetupApplied>;
}

function unavailable(mode: SetupMode): never {
  return setupFail("SETUP_MODE_UNAVAILABLE", `setup --mode ${mode} is not available in this engine yet`, { mode });
}

function migratePlan(input: SetupModeInput): never {
  const { legacy } = input.context;
  if (!legacy.detected) {
    setupFail("SETUP_MIGRATE_NOTHING", "no installation from before the rename was found here: there is nothing to migrate", { mode: "migrate", remedy: "--mode fresh" });
  }
  return setupFail("SETUP_MIGRATE_PENDING", "an installation from before the rename was found; migrating it is not in this engine yet", {
    mode: "migrate",
    ...(legacy.controlDirectory === null ? {} : { controlDirectory: legacy.controlDirectory }),
    ...(legacy.deviceDirectory === null ? {} : { deviceDirectory: legacy.deviceDirectory }),
  });
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
  migrate: { options: ["mapping"], plan: async (input: SetupModeInput): Promise<SetupModePlan> => migratePlan(input), apply: async (): Promise<SetupApplied> => unavailable("migrate") },
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
 * whatever stops the apply. A mode not in this engine yet answers SETUP_MODE_UNAVAILABLE, and
 * migrate SETUP_MIGRATE_PENDING when it finds an installation from before the rename (R6).
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
