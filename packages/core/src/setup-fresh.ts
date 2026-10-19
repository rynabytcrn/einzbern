import { defaultSharedLibraryPath, readStorageLocation, sharedRuntimePath } from "./storage-location.js";
import { configureStorageLocation } from "./storage-configure.js";
import { DIRECTORY } from "./names.js";
import { setConfigRecord } from "./config-records.js";
import { chainIdentity, declareChainIdentity, effectiveProjectState, ensureProjectCoordination, projectCoordinationChoice, resolveCoordinationBinding } from "./project-chain.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R2, R5 (MIN-227; TCRN-CROSS-SUB-323): setup --mode fresh, the first
// installation of Einzbern for a project on this device. The apply runs these steps in this order,
// and the plan lists what each would write in the same order:
//
//   device            this device's identity (device.json), when it has none yet
//   library           the library at --artifacts, by default the device shared library outside the source tree
//                     (the place must not exist or be empty); a project already registered keeps
//                     its library, which is reused. Its language is written as artifact.language
//                     (--language)
//   registry          the project's entry in this device's registry, with the cloud flag (--cloud;
//                     by default what the cloud folder table suggests for the library's real path)
//   skill-copies      ~/.claude/skills/mana-orchestrate and ~/.agents/skills/mana-orchestrate, from
//                     the engine version directory's skill (skill-copies.ts)
//   launchers         the two stable launchers, engine/einzbern.mjs and engine/hook.mjs, from the
//                     engine version directory's launchers/
//   host-hooks        the one Einzbern hook in each host's user settings, and the two pointer hooks
//                     when the navigation section is declined (host-hooks.ts): the user scope, so a
//                     project's own settings never carry the device directory's path
//   writable-roots    when the library is outside the project, the project's host settings name it
//                     as a place the host may write (host-writable-roots.ts); either file that Git
//                     tracks is named in the warnings of the plan and of the receipt
//                     (HOST_WRITABLE_ROOTS_TRACKED_BY_GIT, TCRN-CROSS-SUB-385 R16)
//   machine-settings  the device key agents.navigation (--navigation)
//   managed-sections  CLAUDE.md's import section, AGENTS.md's navigation section when it is written,
//                     and AGENTS.md's variable sections (agents-sections.ts)
//
// The engine version directory is the one engine/current names: the skill's scripts/install.mjs
// puts it there before the wizard runs, laid out as the release is (scripts/pack-release.mjs). An
// original that a step replaces is first copied into backups/<UTC second>/ of the device directory,
// by the module that writes it. Every step compares before it writes, so a second run with the same
// answers writes nothing. Nothing is committed, pushed or deleted, and .gitignore is not touched.
// Where the generated artifacts go is the library's place; workspace.generatedArtifactsPath is not
// written.
//
// TCRN-CROSS-SUB-324, SUB-325: the other modes run these same steps, so each is also exported as a
// building block: SetupRecorder keeps the writes, backups, blockers and warnings of a plan or an
// apply; planWiring and applyWiring run the steps from registry on (restore and repair all of them,
// update only the copies, the launchers and the hooks), against a library the mode found itself.

import { isUtf8 } from "node:buffer";
import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import { FRAMEWORK_VERSION } from "./framework-version.js";
import { AGENTS_FILE, CLAUDE_FILE, agentsFileSections, disableAgentsSection, managedOutputBinding, planClaudeImport, renderAgentsSections } from "./agents-sections.js";
import { writeFileAtomic } from "./atomic-file.js";
import { suggestCloudHosted } from "./cloud-roots.js";
import { ENGINE_HOOK_LAUNCHER, backupsPath, deviceFilePath, engineRoot, ensureDeviceDirectory, registryPath } from "./device-home.js";
import { readDevice, readOrCreateDevice } from "./device-identity.js";
import type { DeviceIdentity } from "./device-identity.js";
import { runDoctor } from "./doctor.js";
import { ENGINE_FILES, engineCurrentPath, engineVersionDirectory, readEngineCurrent } from "./engine-home.js";
import type { EngineCurrent } from "./engine-home.js";
import { hasLibraryManifest, openLibrary } from "./ether-library.js";
import { inspectDshPlugin } from "./dsh-plugin.js";
import { HOST_HOOK_FILES, HOST_HOOK_FILE_HOSTS, applyHostHooks, planHostHooks, readHostHooks } from "./host-hooks.js";
import {
  HostWritableRootsError,
  WRITABLE_ROOTS_FILES,
  WRITABLE_ROOTS_HOSTS,
  applyWritableRoots,
  claudeWritableRoots,
  codexWritableRoots,
  hostFileTrackedByGit,
  planWritableRoots,
  utcStamp,
} from "./host-writable-roots.js";
import { computeInstallTreeDigest } from "./install-tree-digest.js";
import { ARTIFACT_LANGUAGE_TAGS } from "./knowledge-language.js";
import { AGENTS_NAVIGATION_SETTING, MACHINE_SETTINGS_FILE_NAME, applyMachineSettingSet, readAgentsNavigation } from "./machine-settings.js";
import type { AgentsNavigationChoice } from "./machine-settings.js";
import { managedSectionRecordsFor, parseManagedFile, planManagedWrite } from "./managed-sections.js";
import type { ManagedWritePlan } from "./managed-sections.js";
import { BRAND } from "./names.js";
import { gitRemoteOf, normalizeGitRemote, readRegistry, registerLibrary } from "./registry.js";
import type { Registry } from "./registry.js";
import { SETTINGS_CATALOG } from "./settings.js";
import { SETUP_ACTOR, SETUP_APPLIED_SCHEMA_VERSION, SETUP_QUESTIONS, setupFail } from "./setup.js";
import type {
  ResolvedSetupAnswers,
  SetupApplied,
  SetupBackup,
  SetupBlocker,
  SetupColumns,
  SetupCoordination,
  SetupEngineSwitched,
  SetupModeInput,
  SetupModePlan,
  SetupPlan,
  SetupQuestion,
  SetupStep,
  SetupWarning,
  SetupWrite,
  SetupWriteAction,
} from "./setup.js";
import { SKILL_COPY_ROOTS, installSkillCopies, skillCopiesRecordPath, skillCopyPath, verifySkillCopies } from "./skill-copies.js";
import { createProject, initializeLibrary, materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting } from "./workspace.js";
import { canonicalSha256 } from "../../protocol/src/index.js";
import { projectLineage, scopedWorkspaceState } from "./project-scope.js";
import type { WorkspaceState } from "./workspace.js";

// What setup installs from, relative to the engine version directory: the release's layout
// (scripts/pack-release.mjs), from which the skill's install.mjs places the same two launchers.
export const FRESH_ENGINE_TREE = Object.freeze({
  skill: `skill/${BRAND.helper.id}`,
  skillEntry: "SKILL.md",
  launchers: Object.freeze([
    Object.freeze({ from: "launchers/einzbern.mjs", name: ENGINE_FILES.launcher }),
    Object.freeze({ from: "launchers/hook.mjs", name: ENGINE_HOOK_LAUNCHER }),
  ]),
});

export const LANGUAGE_SETTING = "artifact.language";
// Under backups/<UTC second>/ of the device directory: where each step copies the originals it
// replaces (the modules that write them name the first four).
const BACKUP_DIRECTORIES: Readonly<Partial<Record<SetupStep, string>>> = Object.freeze({
  "skill-copies": "skill-copies",
  "host-hooks": "host-hooks",
  "writable-roots": "writable-roots",
  "managed-sections": "managed-sections",
  launchers: "launchers",
  registry: "registry",
});
const HINT_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;

/** What the steps read of a library: its settings and its configuration records. */
export type LibraryState = Pick<WorkspaceState, "settings" | "configRecords">;
const NEW_LIBRARY_STATE: LibraryState = Object.freeze({ settings: [], configRecords: [] });

// The steps from registry on, in the order a plan lists them and an apply runs them.
export const WIRING_STEPS: readonly SetupStep[] = Object.freeze([
  "registry",
  "skill-copies",
  "launchers",
  "host-hooks",
  "writable-roots",
  "machine-settings",
  "managed-sections",
]);

// ---- Small readers ----

type EntryKind = "file" | "directory" | "other";

export async function entryKind(path: string): Promise<EntryKind | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) return "other";
  if (stats.isFile()) return "file";
  return stats.isDirectory() ? "directory" : "other";
}

export function reasonOf(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
  return typeof reasonCode === "string" ? reasonCode : null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A path that may not exist yet, as it will be once created: the real path of its deepest
// existing ancestor with the rest appended (a cloud folder is often reached through a link).
export async function realTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return join(real, ...rest.reverse());
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    rest.push(basename(current));
    current = parent;
  }
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function treeDigestOrNull(path: string): Promise<string | null> {
  try {
    return (await computeInstallTreeDigest(path)).sha256;
  } catch (error) {
    if (reasonOf(error) !== null || typeof (error as { code?: unknown }).code === "string") return null;
    throw error;
  }
}

// A project host file as the writable-roots module reads it: its text, or null when it is absent.
async function readProjectHostFile(path: string, name: string): Promise<string | null> {
  const kind = await entryKind(path);
  if (kind === null) return null;
  if (kind !== "file") throw new HostWritableRootsError("HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED", `${name}: not a regular file`, { file: name });
  const bytes = await readFile(path);
  if (!isUtf8(bytes)) throw new HostWritableRootsError("HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED", `${name}: not UTF-8 text`, { file: name });
  return bytes.toString("utf8");
}

function projectHint(value: string | null): string | null {
  return value !== null && value.length > 0 && value.length <= HINT_MAX_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function normalizedRemote(projectRoot: string): { readonly raw: string | null; readonly normalized: string | null } {
  const raw = gitRemoteOf(projectRoot);
  return { raw, normalized: raw === null ? null : normalizeGitRemote(raw) };
}

// ---- Answers ----

/** A language tag this engine writes in: the tag itself in any case, or its primary language when only one tag has it. */
export function freshLanguageTag(value: string): string {
  const wanted = value.trim().toLowerCase();
  const exact = ARTIFACT_LANGUAGE_TAGS.find((tag) => tag.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  const primary = ARTIFACT_LANGUAGE_TAGS.filter((tag) => tag.toLowerCase().split("-")[0] === wanted);
  const only = primary.length === 1 ? primary[0] : undefined;
  if (only !== undefined) return only;
  return setupFail("SETUP_ANSWER_INVALID", `${value} is not a language this engine writes in; choose one of ${ARTIFACT_LANGUAGE_TAGS.join(", ")}`, {
    question: "language",
    allowed: ARTIFACT_LANGUAGE_TAGS.join(","),
  });
}

/** The language a library writes in when it records none. */
export function defaultLanguage(): string {
  const configured = SETTINGS_CATALOG.find((entry) => entry.key === LANGUAGE_SETTING)?.defaultValue;
  return typeof configured === "string" ? configured : ARTIFACT_LANGUAGE_TAGS[0];
}

/** The language a library records, or null when it records none. */
export function libraryLanguage(state: LibraryState): string | null {
  return state.settings.find((setting) => setting.key === LANGUAGE_SETTING && (Object.hasOwn(state, "configurationProjectId") || setting.projectId === undefined))?.value ?? null;
}

/** Read only the explicitly registered target, or the library defaults for a new target. */
export async function setupTargetState(projectRoot: string, libraryPath: string, deviceHome: string): Promise<WorkspaceState> {
  const root = await realpath(projectRoot);
  const libraryRoot = await realpath(libraryPath);
  const state = await materializeWorkspaceFromGenesis(libraryRoot);
  return scopeSetupTargetState(root, libraryRoot, deviceHome, state);
}

/** Scope already-read migration state without opening its not-yet-created target. */
export async function scopeSetupTargetState(projectRoot: string, libraryPath: string, deviceHome: string, state: WorkspaceState): Promise<WorkspaceState> {
  const root = await realpath(projectRoot);
  const libraryRoot = await realTarget(libraryPath);
  const entry = (await readRegistry(deviceHome)).entries.find(candidate => candidate.projectPath === root);
  if (entry !== undefined && (entry.libraryId !== state.metadata.workspaceId || entry.libraryPath !== libraryRoot)) {
    setupFail("SETUP_LIBRARY_CONFLICT", "declared project binding names another library");
  }
  return scopedWorkspaceState(state, entry?.projectId);
}

export function navigationChoice(navigation: boolean): AgentsNavigationChoice {
  return navigation ? "written" : "declined";
}

// ---- The recorder ----

/** The writes, backups, blockers and warnings of one plan or apply, each path listed once, in step order. */
export class SetupRecorder {
  readonly writes: SetupWrite[] = [];
  readonly backups: SetupBackup[] = [];
  readonly blockers: SetupBlocker[] = [];
  readonly warnings: SetupWarning[] = [];
  readonly backupRoot: string;

  constructor(deviceHome: string, at: string) {
    this.backupRoot = join(backupsPath(deviceHome), utcStamp(at));
  }

  // A path is listed once, at the first step that writes it.
  write(step: SetupStep, path: string, action: SetupWriteAction): void {
    if (!this.writes.some((entry) => entry.path === path)) this.writes.push({ step, path, action });
  }

  backup(step: SetupStep, path: string): void {
    const directory = BACKUP_DIRECTORIES[step];
    if (directory !== undefined && !this.backups.some((entry) => entry.path === path)) this.backups.push({ path, into: join(this.backupRoot, directory) });
  }

  // Where this run copies the originals of `step`.
  backupDirectory(step: SetupStep): string {
    return join(this.backupRoot, BACKUP_DIRECTORIES[step] ?? step);
  }

  block(step: SetupBlocker["step"], path: string, reasonCode: string, message: string): void {
    this.blockers.push({ step, path, reasonCode, message });
  }

  // A project host file Git tracks, which the writable-roots step names this device's library in
  // (TCRN-CROSS-SUB-385 R16): listed once, relative to the project root, in the words
  // scripts/host-render.mjs uses for the same file. It never stops the apply.
  warnTrackedByGit(file: string): void {
    if (this.warnings.some((entry) => entry.file === file)) return;
    this.warnings.push({
      reasonCode: "HOST_WRITABLE_ROOTS_TRACKED_BY_GIT",
      file,
      message: `${file} is tracked by Git and may publish this device's library path if committed`,
    });
  }

  // Run a read; a refusal with a reason code becomes a blocker of `step`, and null is answered.
  async attempt<T>(step: SetupBlocker["step"], path: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      const reasonCode = reasonOf(error);
      if (reasonCode === null) throw error;
      this.block(step, path, reasonCode, messageOf(error));
      return null;
    }
  }
}

// ---- The engine setup installs from ----

export interface EngineSource {
  readonly version: string | null;
  readonly directory: string | null;
}

/** The engine version engine/current names, when it holds every file setup installs from; its absence is a blocker. */
export async function planEngineSource(recorder: SetupRecorder, deviceHome: string): Promise<EngineSource> {
  let current: EngineCurrent | null = null;
  try {
    current = await readEngineCurrent(deviceHome);
  } catch (error) {
    const reasonCode = reasonOf(error);
    if (reasonCode === null) throw error;
    recorder.block("engine", engineCurrentPath(deviceHome), reasonCode, messageOf(error));
    return { version: null, directory: null };
  }
  if (current === null) {
    recorder.block("engine", engineCurrentPath(deviceHome), "SETUP_ENGINE_NOT_INSTALLED",
      "no engine version is current on this device: install one first with the skill's scripts/install.mjs");
    return { version: null, directory: null };
  }
  return engineVersionSource(recorder, current.version, engineVersionDirectory(current.version, deviceHome));
}

/** An engine version directory as a source: complete, or a blocker for each file it lacks. */
export async function engineVersionSource(recorder: SetupRecorder, version: string, directory: string): Promise<EngineSource> {
  const required = [ENGINE_FILES.entry, ...FRESH_ENGINE_TREE.launchers.map((launcher) => launcher.from), `${FRESH_ENGINE_TREE.skill}/${FRESH_ENGINE_TREE.skillEntry}`];
  let complete = true;
  for (const file of required) {
    const path = join(directory, ...file.split("/"));
    if (await entryKind(path) !== "file") {
      complete = false;
      recorder.block("engine", path, "SETUP_ENGINE_INCOMPLETE", `the engine ${version} holds no ${file} to install from`);
    }
  }
  return { version, directory: complete ? directory : null };
}

/** What the skill copies and the launchers are installed from: the skill tree's digest (null when it does not digest) and each launcher's bytes. */
export interface EngineFiles {
  readonly skillDigest: string | null;
  readonly launchers: readonly { readonly name: string; readonly bytes: Buffer }[];
}

/** The files of an engine version directory setup installs from; a skill tree that does not digest is a blocker. */
export async function readEngineFiles(recorder: SetupRecorder, directory: string): Promise<EngineFiles> {
  const source = join(directory, ...FRESH_ENGINE_TREE.skill.split("/"));
  const digest = await recorder.attempt("skill-copies", source, () => computeInstallTreeDigest(source));
  const launchers: { readonly name: string; readonly bytes: Buffer }[] = [];
  for (const launcher of FRESH_ENGINE_TREE.launchers) launchers.push({ name: launcher.name, bytes: await readFile(join(directory, ...launcher.from.split("/"))) });
  return { skillDigest: digest?.sha256 ?? null, launchers };
}

// ---- The answers a device and a library hold ----

/** This device's agents.navigation; a settings file that does not read is a blocker of machine-settings. */
export async function readDeviceNavigation(recorder: SetupRecorder, deviceHome: string): Promise<AgentsNavigationChoice | null> {
  try {
    return await readAgentsNavigation(deviceHome);
  } catch (error) {
    const reasonCode = reasonOf(error);
    if (reasonCode === null) throw error;
    recorder.block("machine-settings", join(deviceHome, MACHINE_SETTINGS_FILE_NAME), reasonCode, messageOf(error));
    return null;
  }
}

/** The device step: device.json is created when it is absent; one that is there must read. */
export async function planDevice(recorder: SetupRecorder, deviceHome: string): Promise<void> {
  const deviceFile = deviceFilePath(deviceHome);
  const deviceKind = await entryKind(deviceFile);
  if (deviceKind === null) recorder.write("device", deviceFile, "create");
  else if (deviceKind !== "file") recorder.block("device", deviceFile, "SETUP_TARGET_UNSUPPORTED", `${deviceFile} is not a regular file`);
  else await recorder.attempt("device", deviceFile, () => readDevice(deviceHome));
}

export async function applyDevice(recorder: SetupRecorder, deviceHome: string, at: string): Promise<DeviceIdentity> {
  const { device, created } = await readOrCreateDevice({ home: deviceHome, now: at });
  if (created) recorder.write("device", deviceFilePath(deviceHome), "create");
  return device;
}

/** The cloud flag a library takes by default: what the registry holds for this project and library, else the cloud folder table's suggestion. */
export function defaultCloud(context: SetupModeInput["context"], libraryPath: string): boolean {
  const registered = context.registered;
  if (registered !== null && registered.libraryPath === libraryPath) return registered.cloudHosted;
  return suggestCloudHosted(libraryPath, { platform: process.platform, env: process.env, home: context.home });
}

// ---- The fresh library ----

interface PlannedLibrary {
  readonly path: string;
  readonly action: "create" | "reuse";
  readonly libraryId: string | null;
  readonly state: LibraryState;
}

async function planLibrary(recorder: SetupRecorder, input: SetupModeInput, artifacts: string): Promise<PlannedLibrary> {
  const registered = input.context.registered;
  if (registered !== null && registered.libraryPath === artifacts) {
    const opened = await recorder.attempt("library", artifacts, () => openLibrary(artifacts));
    if (opened !== null && opened.manifest.libraryId !== registered.libraryId) {
      recorder.block("library", artifacts, "SETUP_LIBRARY_CONFLICT", `${artifacts} holds ${opened.manifest.libraryId}, not the registered ${registered.libraryId}`);
    }
    const state = opened === null ? null : await recorder.attempt("library", artifacts, () => materializeWorkspaceFromGenesis(artifacts));
    return { path: artifacts, action: "reuse", libraryId: registered.libraryId, state: state ?? NEW_LIBRARY_STATE };
  }
  if (registered !== null) {
    recorder.block("library", artifacts, "SETUP_LIBRARY_CONFLICT",
      `this project is registered to the library at ${registered.libraryPath}: answer that place, or move the library there with workspace-relocate`);
    return { path: artifacts, action: "create", libraryId: null, state: NEW_LIBRARY_STATE };
  }
  const kind = await entryKind(artifacts);
  if (kind === "directory") {
    if (await hasLibraryManifest(artifacts)) {
      const state = await materializeWorkspaceFromGenesis(artifacts);
      if (chainIdentity(state)?.role === "shared") return { path: artifacts, action: "reuse", libraryId: state.metadata.workspaceId, state };
      recorder.block("library", artifacts, "SETUP_LIBRARY_EXISTS", `a library is already at ${artifacts}: restore it with setup --mode restore`);
    } else if ((await readdir(artifacts)).length > 0) {
      recorder.block("library", artifacts, "LIBRARY_TARGET_NOT_EMPTY", `${artifacts} is not empty; a library is created in a new or empty directory`);
    }
  } else if (kind !== null) {
    recorder.block("library", artifacts, "LIBRARY_TARGET_INVALID", `${artifacts} is not a directory`);
  }
  return { path: artifacts, action: "create", libraryId: null, state: NEW_LIBRARY_STATE };
}

function questionsFor(input: SetupModeInput, defaults: ResolvedSetupAnswers): readonly SetupQuestion[] {
  const choices: Readonly<Record<string, readonly (string | boolean)[] | null>> = {
    artifacts: null,
    cloud: [true, false],
    language: [...ARTIFACT_LANGUAGE_TAGS],
    navigation: [true, false],
  };
  return SETUP_QUESTIONS.filter((id) => input.answers[id] === undefined).map((id) => ({
    id,
    flag: `--${id}`,
    default: defaults[id],
    choices: choices[id] ?? null,
  }));
}

// ---- The steps from registry on: the plan ----

/** What planWiring needs: the project, the library it is wired to and the answers the steps take. */
export interface WiringPlanInput {
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  // The library the project is wired to; the steps that need one (registry, writable-roots,
  // managed-sections) are left out without it.
  readonly library: { readonly path: string; readonly libraryId: string | null; readonly state: LibraryState } | null;
  readonly cloud: boolean;
  readonly navigation: AgentsNavigationChoice;
  // What this device holds for agents.navigation now.
  readonly deviceNavigation: AgentsNavigationChoice | null;
  // What the skill copies and the launchers come from; null when there is nothing to install from.
  readonly engine: EngineFiles | null;
  // The steps planned; every step from registry on when left out.
  readonly steps?: ReadonlySet<SetupStep>;
  readonly configurationProjectId?: string;
}

function runs(steps: ReadonlySet<SetupStep> | undefined, step: SetupStep): boolean {
  return steps === undefined || steps.has(step);
}

async function planRegistry(recorder: SetupRecorder, input: WiringPlanInput, library: NonNullable<WiringPlanInput["library"]>): Promise<void> {
  const registryFile = registryPath(input.deviceHome);
  const registry: Registry | null = await recorder.attempt("registry", registryFile, () => readRegistry(input.deviceHome));
  if (registry === null) return;
  const remote = normalizedRemote(input.projectRoot).normalized;
  const entry = registry.entries.find((candidate) => candidate.projectPath === input.projectRoot) ?? null;
  const current = entry !== null && entry.libraryPath === library.path && entry.cloudHosted === input.cloud && entry.gitRemote === remote &&
    (library.libraryId === null || entry.libraryId === library.libraryId);
  if (!current) recorder.write("registry", registryFile, await entryKind(registryFile) === null ? "create" : "update");
}

async function planSkillCopies(recorder: SetupRecorder, digest: string, home: string, deviceHome: string): Promise<void> {
  for (const root of SKILL_COPY_ROOTS) {
    const path = skillCopyPath(home, root);
    const kind = await entryKind(path);
    if (kind === null) {
      recorder.write("skill-copies", path, "create");
      continue;
    }
    const held = kind === "directory" ? await treeDigestOrNull(path) : null;
    if (held !== digest) {
      recorder.write("skill-copies", path, "update");
      recorder.backup("skill-copies", path);
    }
  }
  const record = skillCopiesRecordPath(deviceHome);
  const verification = await recorder.attempt("skill-copies", record, () => verifySkillCopies({ home, deviceHome }));
  if (verification === null) return;
  const recorded = verification.reasonCode !== "SKILL_COPIES_NOT_RECORDED" && verification.reasonCode !== "SKILL_COPIES_RECORD_INVALID" &&
    verification.copies.every((copy) => copy.recorded === digest && copy.actual === digest);
  if (!recorded) recorder.write("skill-copies", record, await entryKind(record) === null ? "create" : "update");
}

async function planLaunchers(recorder: SetupRecorder, launchers: EngineFiles["launchers"], deviceHome: string): Promise<void> {
  for (const launcher of launchers) {
    const target = join(engineRoot(deviceHome), launcher.name);
    const kind = await entryKind(target);
    if (kind === null) {
      recorder.write("launchers", target, "create");
      continue;
    }
    if (kind !== "file") {
      recorder.block("launchers", target, "SETUP_TARGET_UNSUPPORTED", `${target} is not a regular file`);
      continue;
    }
    if (!launcher.bytes.equals(await readFile(target))) {
      recorder.write("launchers", target, "update");
      recorder.backup("launchers", target);
    }
  }
}

/** The host-hooks step of a plan: each host's user files, rendered with (or, install false, without) the Einzbern hooks. */
export async function planHooks(recorder: SetupRecorder, home: string, deviceHome: string, navigation: AgentsNavigationChoice | null, install = true): Promise<void> {
  for (const host of HOST_HOOK_FILE_HOSTS) {
    const plan = await recorder.attempt("host-hooks", join(home, ...HOST_HOOK_FILES[host].split("/")),
      async () => readHostHooks(planHostHooks({ host, scope: "user", deviceHome, navigation, install }), { root: home, home }));
    if (plan === null) continue;
    for (const file of plan.files) {
      if (!file.changed || file.after === null) continue;
      recorder.write("host-hooks", file.path, file.before === null ? "create" : "update");
      if (file.before !== null) recorder.backup("host-hooks", file.path);
    }
  }
}

// A host file Git tracks is a warning whether or not this run changes it: once wired, it names this
// device's library until the user takes it out. Git is asked, not the library, which a first
// installation has not created yet.
async function planRoots(recorder: SetupRecorder, projectRoot: string, libraryPath: string): Promise<void> {
  if (inside(projectRoot, libraryPath)) return;
  for (const host of WRITABLE_ROOTS_HOSTS) {
    const name = WRITABLE_ROOTS_FILES[host];
    const path = join(projectRoot, ...name.split("/"));
    if (hostFileTrackedByGit(projectRoot, name)) recorder.warnTrackedByGit(name);
    const outcome = await recorder.attempt("writable-roots", path, async () => {
      const before = await readProjectHostFile(path, name);
      const after = host === "claude-code" ? claudeWritableRoots(before, libraryPath) : codexWritableRoots(before, libraryPath);
      return { before, changed: after !== before };
    });
    if (outcome === null || !outcome.changed) continue;
    recorder.write("writable-roots", path, outcome.before === null ? "create" : "update");
    if (outcome.before !== null) recorder.backup("writable-roots", path);
  }
}

async function planSections(recorder: SetupRecorder, projectRoot: string, state: LibraryState, navigation: AgentsNavigationChoice): Promise<{
  readonly pending: readonly { readonly file: string; readonly id: string }[];
  readonly recordsChange: boolean;
}> {
  // Explicit project opt-out suppresses both root files in the plan, just as apply does.
  if (state.settings.find((entry) => entry.key === "agents.generation")?.value === "none") return { pending: [], recordsChange: false };
  const agentsPath = join(projectRoot, AGENTS_FILE);
  const plans: (ManagedWritePlan | null)[] = [
    await recorder.attempt("managed-sections", agentsPath, () => planManagedWrite({
      filePath: agentsPath,
      file: AGENTS_FILE,
      desired: agentsFileSections(state, navigation).sections.map((section) => ({ id: section.id, body: section.body })),
      records: managedSectionRecordsFor(state, AGENTS_FILE),
    })),
    await recorder.attempt("managed-sections", join(projectRoot, CLAUDE_FILE), () => planClaudeImport(projectRoot, managedSectionRecordsFor(state, CLAUDE_FILE))),
  ];
  const pending: { readonly file: string; readonly id: string }[] = [];
  let recordsChange = false;
  for (const plan of plans) {
    if (plan === null) continue;
    if (plan.write) {
      recorder.write("managed-sections", plan.filePath, plan.before === null ? "create" : "update");
      if (plan.before !== null) recorder.backup("managed-sections", plan.filePath);
    }
    for (const id of plan.pending) pending.push({ file: plan.file, id });
    if (plan.sections.some((decision) => decision.recordChanged)) recordsChange = true;
  }
  if (state.settings.find((entry) => entry.key === "agents.sharedNavigation")?.value === "declined") {
    const agentsPlan = plans[0];
    const navigationDecision = agentsPlan?.sections.find((decision) => decision.id === "navigation");
    const navigationSection = agentsPlan?.before === null || agentsPlan?.before === undefined
      ? undefined
      : parseManagedFile(agentsPlan.before, AGENTS_FILE).sections.find((section) => section.id === "navigation");
    if (navigationDecision?.record.state === "pending") {
      if (!pending.some((section) => section.file === AGENTS_FILE && section.id === "navigation")) {
        pending.push({ file: AGENTS_FILE, id: "navigation" });
      }
    } else if (agentsPlan !== null
      && agentsPlan !== undefined
      && navigationDecision?.record.state === "managed"
      && navigationSection !== undefined
      && navigationSection.digest === navigationSection.bodyDigest
      && navigationSection.digest === navigationDecision.record.digest) {
      recorder.write("managed-sections", agentsPlan.filePath, "update");
      recorder.backup("managed-sections", agentsPlan.filePath);
      recordsChange = true;
    }
  }
  return { pending, recordsChange };
}

// TCRN-CROSS-STORY-540 GWT4 (MIN-258 D3(c); TCRN-CROSS-SUB-507): whether `projectRoot` is the root a
// coordination library's managed sections go to: the project root this device's registry holds for it
// outside every library (agents-sections.ts, managedOutputBinding). Its sections are planned and written
// as a project's are, from the library's own configuration; any other root of a coordination library
// (one within a library, as setup registers its own coordination library) takes none.
async function coordinationSectionsRoot(libraryPath: string, projectRoot: string, state: WorkspaceState, deviceHome: string): Promise<boolean> {
  return managedOutputBinding(libraryPath, projectRoot, state, deviceHome).then((binding) => binding === "bound", () => false);
}

/**
 * Plan the steps from registry on (or those `steps` names), in their order, for a project wired to
 * `library`. Nothing is written; what would stop the apply is a blocker. Answers the managed
 * sections that stay pending. TCRN-CROSS-STORY-540 GWT4 (TCRN-CROSS-SUB-507): for a coordination
 * library's registered root, the managed sections are planned from the library's own configuration
 * (coordinationSectionsRoot).
 */
export async function planWiring(recorder: SetupRecorder, input: WiringPlanInput): Promise<readonly { readonly file: string; readonly id: string }[]> {
  const { projectRoot, home, deviceHome, library, navigation, steps } = input;
  if (library !== null && runs(steps, "registry")) await planRegistry(recorder, input, library);
  const skillDigest = input.engine?.skillDigest ?? null;
  if (skillDigest !== null && runs(steps, "skill-copies")) await planSkillCopies(recorder, skillDigest, home, deviceHome);
  if (input.engine !== null && runs(steps, "launchers")) await planLaunchers(recorder, input.engine.launchers, deviceHome);
  if (runs(steps, "host-hooks")) await planHooks(recorder, home, deviceHome, navigation);
  if (library !== null && runs(steps, "writable-roots")) await planRoots(recorder, projectRoot, library.path);
  const settingsFile = join(deviceHome, MACHINE_SETTINGS_FILE_NAME);
  if (runs(steps, "machine-settings") && input.deviceNavigation !== navigation && recorder.blockers.every((blocker) => blocker.step !== "machine-settings")) {
    recorder.write("machine-settings", settingsFile, await entryKind(settingsFile) === null ? "create" : "update");
  }
  if (library === null || !runs(steps, "managed-sections")) return [];
  if (library.state.configRecords.some((record) => record.collection === "chain" && record.key === "identity" && record.projectId === undefined && record.value.role === "coordination")) {
    const native = await materializeWorkspaceFromGenesis(library.path);
    if (!await coordinationSectionsRoot(library.path, projectRoot, native, deviceHome)) return [];
    const sections = await planSections(recorder, projectRoot, scopedWorkspaceState(native), navigation);
    if (sections.recordsChange) recorder.write("library", library.path, "update");
    return sections.pending;
  }
  const declared = input.configurationProjectId ?? (await readRegistry(deviceHome)).entries.find(entry => entry.projectPath === projectRoot && entry.libraryPath === library.path)?.projectId;
  const view = Object.hasOwn(library.state, "configurationProjectId") || declared === undefined
    ? library.state : await effectiveProjectState(await materializeWorkspaceFromGenesis(library.path), declared, deviceHome);
  const sections = await planSections(recorder, projectRoot, view, navigation);
  if (sections.recordsChange) recorder.write("library", library.path, "update");
  return sections.pending;
}

// ---- The steps from registry on: the apply ----

/** What applyWiring needs: the project, the library it is wired to, the answers and the engine version installed from. */
export interface WiringApplyInput {
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  readonly at: string;
  // The library the project is wired to; the steps that need one are left out without it.
  readonly library: { readonly path: string; readonly libraryId: string } | null;
  readonly cloud: boolean;
  readonly navigation: AgentsNavigationChoice;
  readonly engineDirectory: string;
  readonly steps?: ReadonlySet<SetupStep>;
  // The actor named on each event the steps write into the library, which a chain that enabled
  // attestation requires of every write (a migrated library); none when left out.
  readonly actorId?: string;
  readonly configurationProjectId?: string;
}

/**
 * Setup defines a new configuration target for its explicitly requested project root
 * when no binding exists. It never adopts a same-name, sole or nearby native project.
 * A previously declared binding is checked and reused; its stable identity survives
 * renames. This is part of the existing library step, not another install phase.
 */
export async function ensureSetupProjectBinding(projectRoot: string, libraryPath: string, input: {
  readonly at: string; readonly deviceHome: string; readonly actorId?: string;
}): Promise<string> {
  const root = await realpath(projectRoot);
  const libraryRoot = await realpath(libraryPath);
  const state = await materializeWorkspace(libraryRoot);
  const entry = (await readRegistry(input.deviceHome)).entries.find(candidate => candidate.projectPath === root);
  const identity = chainIdentity(state);
  if (entry?.projectId === undefined && identity?.primaryProjectId !== undefined) {
    projectLineage(state, identity.primaryProjectId);
    return identity.primaryProjectId;
  }
  if (entry?.projectId !== undefined) {
    if (entry.libraryId !== state.metadata.workspaceId || entry.libraryPath !== libraryRoot) setupFail("SETUP_LIBRARY_CONFLICT", "declared project binding names another library");
    projectLineage(state, entry.projectId);
    return entry.projectId;
  }
  // This deterministic declaration is written by setup itself. It is not a guessed
  // binding to any existing work project's id, display name or folder hierarchy.
  const externalKey = `SETUP-CONFIG-${canonicalSha256({ libraryId: state.metadata.workspaceId, projectRoot: root }).toUpperCase()}`;
  const declared = state.projects.find(project => project.externalKey === externalKey && !project.tombstone);
  if (declared !== undefined) return declared.id;
  const created = await createProject(libraryRoot, { externalKey, name: basename(root), occurredAt: input.at,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }) });
  return created.projects.find(project => project.externalKey === externalKey && !project.tombstone)!.id;
}

async function applyRegistry(recorder: SetupRecorder, input: WiringApplyInput, library: NonNullable<WiringApplyInput["library"]>): Promise<void> {
  const { projectRoot, deviceHome, at } = input;
  const remote = normalizedRemote(projectRoot);
  const registryFile = registryPath(deviceHome);
  const entry = (await readRegistry(deviceHome)).entries.find((candidate) => candidate.projectPath === projectRoot) ?? null;
  if (entry !== null && entry.projectId === input.configurationProjectId && entry.libraryPath === library.path && entry.libraryId === library.libraryId && entry.cloudHosted === input.cloud && entry.gitRemote === remote.normalized) return;
  const kind = await entryKind(registryFile);
  await registerLibrary({ projectPath: projectRoot, libraryPath: library.path, ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), registeredAt: at, cloudHosted: input.cloud, gitRemote: remote.raw }, deviceHome);
  recorder.write("registry", registryFile, kind === null ? "create" : "update");
}

async function applySkillCopies(recorder: SetupRecorder, input: WiringApplyInput): Promise<void> {
  const { home, deviceHome, at } = input;
  const record = skillCopiesRecordPath(deviceHome);
  const recordAction: SetupWriteAction = await entryKind(record) === null ? "create" : "update";
  const copies = await installSkillCopies({ source: join(input.engineDirectory, ...FRESH_ENGINE_TREE.skill.split("/")), now: at, home, deviceHome });
  for (const copy of copies.copies) {
    if (copy.action === "reused") continue;
    recorder.write("skill-copies", copy.path, copy.action === "created" ? "create" : "update");
    if (copy.backup !== null) recorder.backup("skill-copies", copy.path);
  }
  if (copies.reasonCode === "SKILL_COPIES_INSTALLED") recorder.write("skill-copies", record, recordAction);
}

async function applyLaunchers(recorder: SetupRecorder, input: WiringApplyInput): Promise<void> {
  const { deviceHome } = input;
  for (const launcher of FRESH_ENGINE_TREE.launchers) {
    const target = join(engineRoot(deviceHome), launcher.name);
    const bytes = await readFile(join(input.engineDirectory, ...launcher.from.split("/")));
    const kind = await entryKind(target);
    if (kind !== null && kind !== "file") setupFail("SETUP_TARGET_UNSUPPORTED", `${target} is not a regular file`, { path: target });
    const before = kind === "file" ? await readFile(target) : null;
    if (before !== null && before.equals(bytes)) continue;
    if (before !== null) {
      const copy = join(recorder.backupDirectory("launchers"), launcher.name);
      if (await entryKind(copy) === null) {
        await ensureDeviceDirectory(dirname(copy));
        await writeFileAtomic(copy, before);
      }
      recorder.backup("launchers", target);
    }
    await ensureDeviceDirectory(engineRoot(deviceHome));
    await writeFileAtomic(target, bytes);
    recorder.write("launchers", target, before === null ? "create" : "update");
  }
}

/** The host-hooks step of an apply: the user scope of both hosts, with (or, install false, without) the Einzbern hooks. */
export async function applyHooks(recorder: SetupRecorder, input: {
  readonly home: string;
  readonly deviceHome: string;
  readonly at: string;
  readonly navigation: AgentsNavigationChoice | null;
  readonly install?: boolean;
}): Promise<void> {
  const { home, deviceHome, at, navigation } = input;
  for (const host of HOST_HOOK_FILE_HOSTS) {
    const hooks = await readHostHooks(planHostHooks({ host, scope: "user", deviceHome, navigation, install: input.install ?? true }), { root: home, home });
    await applyHostHooks(hooks, { at, backupRoot: backupsPath(deviceHome) });
    for (const file of hooks.files) {
      if (!file.changed || file.after === null) continue;
      recorder.write("host-hooks", file.path, file.before === null ? "create" : "update");
      if (file.before !== null) recorder.backup("host-hooks", file.path);
    }
  }
}

async function applyRoots(recorder: SetupRecorder, input: WiringApplyInput, library: NonNullable<WiringApplyInput["library"]>): Promise<void> {
  const { projectRoot, deviceHome, at } = input;
  if (inside(projectRoot, library.path)) return;
  const roots = await planWritableRoots({ projectRoot, libraryPath: library.path });
  for (const file of roots.files) if (file.trackedByGit) recorder.warnTrackedByGit(file.path);
  await applyWritableRoots(roots, { at, home: deviceHome });
  for (const file of roots.files) {
    if (!file.changed) continue;
    const path = join(roots.projectRoot, ...file.path.split("/"));
    recorder.write("writable-roots", path, file.before === null ? "create" : "update");
    if (file.before !== null) recorder.backup("writable-roots", path);
  }
}

async function applyNavigationSetting(recorder: SetupRecorder, input: WiringApplyInput): Promise<void> {
  const settingsFile = join(input.deviceHome, MACHINE_SETTINGS_FILE_NAME);
  if (await readAgentsNavigation(input.deviceHome) === input.navigation) return;
  const action: SetupWriteAction = await entryKind(settingsFile) === null ? "create" : "update";
  await applyMachineSettingSet({ key: AGENTS_NAVIGATION_SETTING, value: input.navigation, occurredAt: input.at, path: settingsFile });
  recorder.write("machine-settings", settingsFile, action);
}

async function applySections(recorder: SetupRecorder, input: WiringApplyInput, library: NonNullable<WiringApplyInput["library"]>): Promise<readonly { readonly file: string; readonly id: string }[]> {
  const { projectRoot, deviceHome, at } = input;
  const existed = new Map<string, boolean>();
  for (const file of [AGENTS_FILE, CLAUDE_FILE]) existed.set(file, await entryKind(join(projectRoot, file)) !== null);
  const actor = input.actorId === undefined ? {} : { actorId: input.actorId };
  const rendered = await renderAgentsSections(library.path, { projectRoot, ...(input.configurationProjectId === undefined ? {} : { configurationProjectId: input.configurationProjectId }), navigation: input.navigation, occurredAt: at, backupRoot: backupsPath(deviceHome), ...actor });
  for (const file of rendered.files) {
    if (!file.written) continue;
    const path = join(projectRoot, file.file);
    recorder.write("managed-sections", path, existed.get(file.file) === true ? "update" : "create");
    if (file.backupPath !== null) recorder.backup("managed-sections", path);
  }
  if (rendered.recorded > 0) recorder.write("library", library.path, "update");
  const pending = rendered.pending.map((section) => ({ file: section.file, id: section.id }));
  const sharedState = await effectiveProjectState(await materializeWorkspace(library.path), input.configurationProjectId, deviceHome);
  if (sharedState.settings.find((entry) => entry.key === "agents.generation")?.value !== "none" && sharedState.settings.find((entry) => entry.key === "agents.sharedNavigation")?.value === "declined" && rendered.sections.some((section) => section.file === AGENTS_FILE && section.id === "navigation" && section.state === "managed")) {
    try {
      const { change } = await disableAgentsSection(library.path, {
        projectRoot,
        ...(input.configurationProjectId === undefined ? {} : { configurationProjectId: input.configurationProjectId }),
        id: "navigation",
        occurredAt: at,
        backupRoot: backupsPath(deviceHome),
        ...actor,
      });
      if (change.written) {
        recorder.write("managed-sections", join(projectRoot, AGENTS_FILE), "update");
        recorder.backup("managed-sections", join(projectRoot, AGENTS_FILE));
      }
      if (change.recordChanged) recorder.write("library", library.path, "update");
    } catch (error) {
      if (reasonOf(error) !== "MANAGED_SECTION_FORCE_REQUIRED") throw error;
      if (!pending.some((section) => section.file === AGENTS_FILE && section.id === "navigation")) {
        pending.push({ file: AGENTS_FILE, id: "navigation" });
      }
    }
  }
  return pending;
}

/**
 * Apply the steps from registry on (or those `steps` names), in their order, each comparing before
 * it writes. Answers the managed sections that stay pending. TCRN-CROSS-STORY-540 GWT4
 * (TCRN-CROSS-SUB-507): a coordination library takes no setup project binding, since its sections are
 * written from its own configuration, and only its registered root takes them (coordinationSectionsRoot).
 */
export async function applyWiring(recorder: SetupRecorder, input: WiringApplyInput): Promise<readonly { readonly file: string; readonly id: string }[]> {
  const { steps, library } = input;
  let coordinationRoot: boolean | null = null;
  if (library !== null) {
    const prior = await materializeWorkspace(library.path);
    const identity = chainIdentity(prior);
    // Contract item 3: the coordination a project library names is resolved, never replaced; one
    // this device does not locate stays unregistered here, and a competing identity refuses.
    if (identity?.role === "project") await resolveCoordinationBinding(identity.coordinationLibraryId, input.deviceHome);
    if (identity?.role === "coordination") coordinationRoot = await coordinationSectionsRoot(library.path, input.projectRoot, prior, input.deviceHome);
    const configurationProjectId = coordinationRoot !== null ? input.configurationProjectId : input.configurationProjectId ?? await ensureSetupProjectBinding(input.projectRoot, library.path, input);
    input = { ...input, ...(configurationProjectId === undefined ? {} : { configurationProjectId }) };
    if ((await materializeWorkspace(library.path)).version !== prior.version) recorder.write("library", library.path, "update");
    // Migrate/restore may have registered the library before these shared steps.
    // Completing that same entry's declared configuration binding is required
    // before any target-specific consumer, including the next prompt hook.
    const entry = (await readRegistry(input.deviceHome)).entries.find(candidate => candidate.projectPath === input.projectRoot);
    if (runs(steps, "registry") || entry?.projectId !== configurationProjectId) await applyRegistry(recorder, input, library);
  }
  if (runs(steps, "skill-copies")) await applySkillCopies(recorder, input);
  if (runs(steps, "launchers")) await applyLaunchers(recorder, input);
  if (runs(steps, "host-hooks")) await applyHooks(recorder, input);
  if (library !== null && runs(steps, "writable-roots")) await applyRoots(recorder, input, library);
  if (runs(steps, "machine-settings")) await applyNavigationSetting(recorder, input);
  return library !== null && runs(steps, "managed-sections") && coordinationRoot !== false ? applySections(recorder, input, library) : [];
}

/** SETUP_APPLIED for a plan, with what the recorder kept (its warnings too) and doctor's eight checks right after. */
export async function setupApplied(plan: SetupPlan, recorder: SetupRecorder, result: {
  readonly deviceId: string | null;
  readonly library: SetupApplied["library"];
  readonly pending: readonly { readonly file: string; readonly id: string }[];
  readonly columns?: SetupColumns;
  readonly engineSwitch?: SetupEngineSwitched;
  // fresh, restore and uninstall (TCRN-CROSS-INIT-053 R46 I08).
  readonly coordination?: SetupCoordination | null;
}): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome } = plan;
  const selfCheck = await runDoctor({ projectRoot, home, deviceHome });
  return {
    schemaVersion: SETUP_APPLIED_SCHEMA_VERSION,
    reasonCode: "SETUP_APPLIED",
    mode: plan.mode,
    at,
    engineVersion: FRAMEWORK_VERSION,
    projectRoot,
    home,
    deviceHome,
    deviceId: result.deviceId,
    answers: plan.resolved,
    library: result.library,
    written: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    pendingSections: result.pending,
    warnings: recorder.warnings,
    ...(result.columns === undefined ? {} : { columns: result.columns }),
    ...(result.engineSwitch === undefined ? {} : { engineSwitch: result.engineSwitch }),
    ...(result.coordination === undefined ? {} : { coordination: result.coordination }),
    selfCheck,
  };
}

// ---- The fresh plan and apply ----

/**
 * Plan a first installation (R2, R5): the answers, each open question's default, and every write
 * and backup in the order the apply makes them. Nothing is written; whatever would stop the apply is
 * a blocker of the plan.
 */
export async function planFreshSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers } = input;
  const { projectRoot, home, deviceHome } = context;
  const recorder = new SetupRecorder(deviceHome, input.at);

  const engine = await planEngineSource(recorder, deviceHome);

  // The answers: what was given, else the default, which on a device and project already set up is
  // what they hold now.
  const artifacts = await realTarget(answers.artifacts === undefined
    ? context.registered?.libraryPath ?? defaultSharedLibraryPath(deviceHome)
    : resolve(projectRoot, answers.artifacts));
  const deviceNavigation = await readDeviceNavigation(recorder, deviceHome);
  // TCRN-CROSS-STORY-548 R4: DSH's plugin, as facts for the plan; nothing here writes a DSH profile.
  const dshPlugin = await inspectDshPlugin({ home, deviceHome });

  // device
  await planDevice(recorder, deviceHome);

  // library
  const library = await planLibrary(recorder, input, artifacts);
  const currentLanguage = libraryLanguage(library.action === "reuse" ? await setupTargetState(projectRoot, library.path, deviceHome) : library.state);
  const defaults: ResolvedSetupAnswers = {
    artifacts,
    cloud: defaultCloud(context, artifacts),
    language: currentLanguage ?? defaultLanguage(),
    navigation: deviceNavigation !== "declined",
  };
  const resolved: ResolvedSetupAnswers = {
    artifacts,
    cloud: answers.cloud ?? defaults.cloud,
    language: answers.language === undefined ? defaults.language : freshLanguageTag(answers.language),
    navigation: answers.navigation ?? defaults.navigation,
  };
  if (library.action === "create") recorder.write("library", library.path, "create");
  else if (currentLanguage !== resolved.language) recorder.write("library", library.path, "update");

  // The coordination binding is part of this plan, including repeat/restore conflicts: the choice
  // the apply makes (project-chain.ts), and the writes it takes. A coordination library at the
  // default location that this device does not register yet is registered (with its Cross
  // Project project when it has none), never created again. The plan names the choice
  // (TCRN-CROSS-INIT-053 R46 I08); a conflict is a blocker and names none.
  let binding: SetupCoordination | null = null;
  try {
    const identity = library.action === "reuse" ? chainIdentity(await materializeWorkspace(library.path)) : null;
    const coordination = basename(artifacts) === DIRECTORY.cloudDefaultParent || artifacts === defaultSharedLibraryPath(deviceHome) || identity?.role === "shared"
      ? { libraryId: library.libraryId, status: "registered" as const, path: library.path }
      : await projectCoordinationChoice(identity, deviceHome);
    binding = { libraryId: coordination.libraryId, status: coordination.status, path: coordination.path };
    if (coordination.status === "create") recorder.write("library", coordination.path!, "create");
    if (coordination.status === "located") {
      const registryFile = registryPath(deviceHome);
      recorder.write("registry", registryFile, await entryKind(registryFile) === null ? "create" : "update");
      const located = await materializeWorkspaceFromGenesis(coordination.path!);
      if (!located.projects.some((entry) => entry.externalKey === "CROSS-PROJECT" && !entry.tombstone)) recorder.write("library", coordination.path!, "update");
    }
    if (identity === null && library.action !== "create") recorder.write("library", library.path, "update");
  } catch (error) { recorder.block("library", library.path, "SETUP_LIBRARY_CONFLICT", String(error)); }

  // registry, skill-copies, launchers, host-hooks, writable-roots, machine-settings, managed-sections
  const files = engine.directory === null ? null : await readEngineFiles(recorder, engine.directory);
  const pending = await planWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    library,
    cloud: resolved.cloud,
    navigation: navigationChoice(resolved.navigation),
    deviceNavigation,
    engine: files,
  });
  if ((basename(artifacts) === DIRECTORY.cloudDefaultParent || artifacts === defaultSharedLibraryPath(deviceHome)) && readStorageLocation(deviceHome) === null) recorder.write("device", join(deviceHome, "storage-location.json"), "create");

  return {
    questions: questionsFor(input, defaults),
    resolved,
    engine: { version: engine.version, directory: engine.directory },
    library: { path: library.path, action: library.action, libraryId: library.libraryId },
    writes: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    pendingSections: pending,
    coordination: binding,
    blockers: recorder.blockers,
    warnings: recorder.warnings,
    ...(dshPlugin.detected ? { dshPlugin } : {}),
  };
}

/**
 * Apply a confirmed first installation (R2, R5): the steps in their order, each comparing before it
 * writes, then doctor's eight checks as the self-check. Answers SETUP_APPLIED with every file
 * written, the originals backed up and the backup directory of this run.
 */
export async function applyFreshSetup(plan: SetupPlan): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome, resolved } = plan;
  const directory = plan.engine.directory;
  if (directory === null) {
    return setupFail("SETUP_ENGINE_NOT_INSTALLED", "the plan names no engine version directory to install from", { deviceHome });
  }
  const planned = plan.library;
  if (planned === null) return setupFail("SETUP_INPUT_INVALID", "the plan names no library", { field: "plan" });
  const recorder = new SetupRecorder(deviceHome, at);

  // device
  const device = await applyDevice(recorder, deviceHome, at);

  // library, and its language
  const remote = normalizedRemote(projectRoot);
  if (planned.action === "create") {
    await initializeLibrary({
      root: planned.path,
      createdAt: at,
      projectName: projectHint(basename(projectRoot)),
      gitRemote: projectHint(remote.normalized),
    });
  }
  const library = await openLibrary(planned.path);
  if (planned.libraryId !== null && library.manifest.libraryId !== planned.libraryId) {
    setupFail("SETUP_LIBRARY_CONFLICT", `${library.root} holds ${library.manifest.libraryId}, not the planned ${planned.libraryId}`, { library: library.root });
  }
  const libraryPath = library.root;
  const libraryId = library.manifest.libraryId;
  if (planned.action === "create") recorder.write("library", libraryPath, "create");
  const central = basename(libraryPath) === DIRECTORY.cloudDefaultParent || libraryPath === defaultSharedLibraryPath(deviceHome);
  if (central && chainIdentity(await materializeWorkspace(libraryPath)) === null) await declareChainIdentity(libraryPath, { role: "shared", coordinationLibraryId: libraryId }, { occurredAt: at, actorId: SETUP_ACTOR });
  const existingIdentity = chainIdentity(await materializeWorkspace(libraryPath));
  const registryFile = registryPath(deviceHome);
  const registryKind = await entryKind(registryFile);
  const coordination = await ensureProjectCoordination(libraryPath, at, deviceHome);
  if (coordination.created) recorder.write("library", coordination.path!, "create");
  // Registering the coordination writes registry.json before the registry step: listed as the plan
  // listed it, from what the file was before.
  if (coordination.status === "create" || coordination.status === "located") {
    recorder.write("registry", registryFile, registryKind === null ? "create" : "update");
    if (coordination.status === "located" && coordination.written) recorder.write("library", coordination.path!, "update");
  }
  if (existingIdentity === null) recorder.write("library", libraryPath, "update");
  const configurationProjectId = await ensureSetupProjectBinding(projectRoot, libraryPath, { at, deviceHome, actorId: SETUP_ACTOR });
  const declaredIdentity = chainIdentity(await materializeWorkspace(libraryPath))!;
  if (declaredIdentity.role === "shared") {
    const current = await materializeWorkspace(libraryPath);
    if (!current.configRecords.some(record => record.collection === "chain" && record.key === "identity" && record.projectId === configurationProjectId)) await setConfigRecord(libraryPath, { collection: "chain", key: "identity", value: { role: "project", primaryProjectId: configurationProjectId, coordinationLibraryId: libraryId }, projectId: configurationProjectId, occurredAt: at, actorId: SETUP_ACTOR });
  } else if (declaredIdentity.primaryProjectId === undefined) await declareChainIdentity(libraryPath, { ...declaredIdentity, primaryProjectId: configurationProjectId }, { occurredAt: at, actorId: SETUP_ACTOR });
  const state = scopedWorkspaceState(await materializeWorkspace(libraryPath), configurationProjectId);
  if (libraryLanguage(state) !== resolved.language) {
    await setWorkspaceSetting(libraryPath, { key: LANGUAGE_SETTING, value: resolved.language, configurationProjectId, occurredAt: at, actorId: SETUP_ACTOR });
    recorder.write("library", libraryPath, "update");
  }

  // registry, skill-copies, launchers, host-hooks, writable-roots, machine-settings, managed-sections
  const pending = await applyWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    at,
    library: { path: libraryPath, libraryId },
    configurationProjectId,
    cloud: resolved.cloud,
    navigation: navigationChoice(resolved.navigation),
    engineDirectory: directory,
  });

  if (declaredIdentity.role === "shared" && readStorageLocation(deviceHome) === null) {
    await configureStorageLocation(deviceHome, libraryPath, sharedRuntimePath(libraryPath, device.deviceId), at, "setup:install", true);
    recorder.write("device", join(deviceHome, "storage-location.json"), "create");
  }

  return setupApplied(plan, recorder, {
    deviceId: device.deviceId,
    library: { path: libraryPath, libraryId, created: planned.action === "create" },
    pending,
    // TCRN-CROSS-INIT-053 R46 (I08): created or found in place, it is registered now; one this device
    // does not locate stays unregistered, and nothing was made in its place.
    coordination: coordination.status === "unregistered"
      ? { libraryId: coordination.libraryId, status: "unregistered", path: null }
      : { libraryId: coordination.libraryId, status: "registered", path: await realpath(coordination.path!) },
  });
}
