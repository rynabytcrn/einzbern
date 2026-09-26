// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R2, R5 (MIN-227; TCRN-CROSS-SUB-323): setup --mode fresh, the first
// installation of Einzbern for a project on this device. The apply runs these steps in this order,
// and the plan lists what each would write in the same order:
//
//   device            this device's identity (device.json), when it has none yet
//   library           the library at --artifacts, by default .ether in the project, created there
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
//                     as a place the host may write (host-writable-roots.ts)
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

import { isUtf8 } from "node:buffer";
import type { Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import { FRAMEWORK_VERSION } from "./index.js";
import { AGENTS_FILE, CLAUDE_FILE, agentsFileSections, planClaudeImport, renderAgentsSections } from "./agents-sections.js";
import { writeFileAtomic } from "./atomic-file.js";
import { suggestCloudHosted } from "./cloud-roots.js";
import { ENGINE_HOOK_LAUNCHER, backupsPath, deviceFilePath, engineRoot, ensureDeviceDirectory, registryPath } from "./device-home.js";
import { readDevice, readOrCreateDevice } from "./device-identity.js";
import { runDoctor } from "./doctor.js";
import { ENGINE_FILES, engineCurrentPath, engineVersionDirectory, readEngineCurrent } from "./engine-home.js";
import type { EngineCurrent } from "./engine-home.js";
import { hasLibraryManifest, openLibrary } from "./ether-library.js";
import { HOST_HOOK_FILES, HOST_HOOK_HOSTS, applyHostHooks, planHostHooks, readHostHooks } from "./host-hooks.js";
import {
  HostWritableRootsError,
  WRITABLE_ROOTS_FILES,
  WRITABLE_ROOTS_HOSTS,
  applyWritableRoots,
  claudeWritableRoots,
  codexWritableRoots,
  planWritableRoots,
  utcStamp,
} from "./host-writable-roots.js";
import { computeInstallTreeDigest } from "./install-tree-digest.js";
import { ARTIFACT_LANGUAGE_TAGS } from "./knowledge-language.js";
import { AGENTS_NAVIGATION_SETTING, MACHINE_SETTINGS_FILE_NAME, applyMachineSettingSet, readAgentsNavigation } from "./machine-settings.js";
import type { AgentsNavigationChoice } from "./machine-settings.js";
import { managedSectionRecordsFor, planManagedWrite } from "./managed-sections.js";
import type { ManagedWritePlan } from "./managed-sections.js";
import { BRAND, DIRECTORY } from "./names.js";
import { gitRemoteOf, normalizeGitRemote, readRegistry, registerLibrary } from "./registry.js";
import type { Registry } from "./registry.js";
import { SETTINGS_CATALOG } from "./settings.js";
import { SETUP_APPLIED_SCHEMA_VERSION, SETUP_QUESTIONS, setupFail } from "./setup.js";
import type {
  ResolvedSetupAnswers,
  SetupApplied,
  SetupBackup,
  SetupBlocker,
  SetupModeInput,
  SetupModePlan,
  SetupPlan,
  SetupQuestion,
  SetupStep,
  SetupWrite,
  SetupWriteAction,
} from "./setup.js";
import { SKILL_COPY_ROOTS, installSkillCopies, skillCopiesRecordPath, skillCopyPath, verifySkillCopies } from "./skill-copies.js";
import { initializeLibrary, materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting } from "./workspace.js";
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

const LANGUAGE_SETTING = "artifact.language";
// Under backups/<UTC second>/ of the device directory: where each step copies the originals it
// replaces (the modules that write them name the first four).
const BACKUP_DIRECTORIES: Readonly<Partial<Record<SetupStep, string>>> = Object.freeze({
  "skill-copies": "skill-copies",
  "host-hooks": "host-hooks",
  "writable-roots": "writable-roots",
  "managed-sections": "managed-sections",
  launchers: "launchers",
});
const HINT_MAX_LENGTH = 512;

type EmptyState = Pick<WorkspaceState, "settings" | "configRecords">;
const NEW_LIBRARY_STATE: EmptyState = Object.freeze({ settings: [], configRecords: [] });

// ---- Small readers ----

type EntryKind = "file" | "directory" | "other";

async function entryKind(path: string): Promise<EntryKind | null> {
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

function reasonOf(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
  return typeof reasonCode === "string" ? reasonCode : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A path that may not exist yet, as it will be once created: the real path of its deepest
// existing ancestor with the rest appended (a cloud folder is often reached through a link).
async function realTarget(path: string): Promise<string> {
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

function defaultLanguage(): string {
  const configured = SETTINGS_CATALOG.find((entry) => entry.key === LANGUAGE_SETTING)?.defaultValue;
  return typeof configured === "string" ? configured : ARTIFACT_LANGUAGE_TAGS[0];
}

function navigationChoice(navigation: boolean): AgentsNavigationChoice {
  return navigation ? "written" : "declined";
}

// ---- The plan ----

class PlanRecorder {
  readonly writes: SetupWrite[] = [];
  readonly backups: SetupBackup[] = [];
  readonly blockers: SetupBlocker[] = [];
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

  block(step: SetupBlocker["step"], path: string, reasonCode: string, message: string): void {
    this.blockers.push({ step, path, reasonCode, message });
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

interface EngineSource {
  readonly version: string | null;
  readonly directory: string | null;
}

async function planEngine(recorder: PlanRecorder, deviceHome: string): Promise<EngineSource> {
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
  const directory = engineVersionDirectory(current.version, deviceHome);
  const required = [ENGINE_FILES.entry, ...FRESH_ENGINE_TREE.launchers.map((launcher) => launcher.from), `${FRESH_ENGINE_TREE.skill}/${FRESH_ENGINE_TREE.skillEntry}`];
  let complete = true;
  for (const file of required) {
    const path = join(directory, ...file.split("/"));
    if (await entryKind(path) !== "file") {
      complete = false;
      recorder.block("engine", path, "SETUP_ENGINE_INCOMPLETE", `the current engine ${current.version} holds no ${file} to install from`);
    }
  }
  return { version: current.version, directory: complete ? directory : null };
}

interface PlannedLibrary {
  readonly path: string;
  readonly action: "create" | "reuse";
  readonly libraryId: string | null;
  readonly state: EmptyState;
}

async function planLibrary(recorder: PlanRecorder, input: SetupModeInput, artifacts: string): Promise<PlannedLibrary> {
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

async function planSkillCopies(recorder: PlanRecorder, source: string, home: string, deviceHome: string): Promise<void> {
  const digest = await recorder.attempt("skill-copies", source, () => computeInstallTreeDigest(source));
  if (digest === null) return;
  for (const root of SKILL_COPY_ROOTS) {
    const path = skillCopyPath(home, root);
    const kind = await entryKind(path);
    if (kind === null) {
      recorder.write("skill-copies", path, "create");
      continue;
    }
    const held = kind === "directory" ? await treeDigestOrNull(path) : null;
    if (held !== digest.sha256) {
      recorder.write("skill-copies", path, "update");
      recorder.backup("skill-copies", path);
    }
  }
  const record = skillCopiesRecordPath(deviceHome);
  const verification = await recorder.attempt("skill-copies", record, () => verifySkillCopies({ home, deviceHome }));
  if (verification === null) return;
  const recorded = verification.reasonCode !== "SKILL_COPIES_NOT_RECORDED" && verification.reasonCode !== "SKILL_COPIES_RECORD_INVALID" &&
    verification.copies.every((copy) => copy.recorded === digest.sha256 && copy.actual === digest.sha256);
  if (!recorded) recorder.write("skill-copies", record, await entryKind(record) === null ? "create" : "update");
}

async function planLaunchers(recorder: PlanRecorder, directory: string, deviceHome: string): Promise<void> {
  for (const launcher of FRESH_ENGINE_TREE.launchers) {
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
    const [wanted, held] = await Promise.all([readFile(join(directory, ...launcher.from.split("/"))), readFile(target)]);
    if (!wanted.equals(held)) {
      recorder.write("launchers", target, "update");
      recorder.backup("launchers", target);
    }
  }
}

async function planHooks(recorder: PlanRecorder, home: string, deviceHome: string, navigation: AgentsNavigationChoice): Promise<void> {
  for (const host of HOST_HOOK_HOSTS) {
    const plan = await recorder.attempt("host-hooks", join(home, ...HOST_HOOK_FILES[host].split("/")),
      async () => readHostHooks(planHostHooks({ host, scope: "user", deviceHome, navigation }), { root: home, home }));
    if (plan === null) continue;
    for (const file of plan.files) {
      if (!file.changed || file.after === null) continue;
      recorder.write("host-hooks", file.path, file.before === null ? "create" : "update");
      if (file.before !== null) recorder.backup("host-hooks", file.path);
    }
  }
}

async function planRoots(recorder: PlanRecorder, projectRoot: string, libraryPath: string): Promise<void> {
  if (inside(projectRoot, libraryPath)) return;
  for (const host of WRITABLE_ROOTS_HOSTS) {
    const name = WRITABLE_ROOTS_FILES[host];
    const path = join(projectRoot, ...name.split("/"));
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

async function planSections(recorder: PlanRecorder, projectRoot: string, library: PlannedLibrary, navigation: AgentsNavigationChoice): Promise<{
  readonly pending: readonly { readonly file: string; readonly id: string }[];
  readonly recordsChange: boolean;
}> {
  const state = library.state;
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
  return { pending, recordsChange };
}

/**
 * Plan a first installation (R2, R5): the answers, each open question's default, and every write
 * and backup in the order the apply makes them. Nothing is written; whatever would stop the apply is
 * a blocker of the plan.
 */
export async function planFreshSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers } = input;
  const { projectRoot, home, deviceHome } = context;
  const recorder = new PlanRecorder(deviceHome, input.at);

  const engine = await planEngine(recorder, deviceHome);

  // The answers: what was given, else the default, which on a device and project already set up is
  // what they hold now.
  const artifacts = await realTarget(answers.artifacts === undefined
    ? context.registered?.libraryPath ?? join(projectRoot, DIRECTORY.library)
    : resolve(projectRoot, answers.artifacts));
  let deviceNavigation: AgentsNavigationChoice | null = null;
  const settingsFile = join(deviceHome, MACHINE_SETTINGS_FILE_NAME);
  try {
    deviceNavigation = await readAgentsNavigation(deviceHome);
  } catch (error) {
    const reasonCode = reasonOf(error);
    if (reasonCode === null) throw error;
    recorder.block("machine-settings", settingsFile, reasonCode, messageOf(error));
  }

  // device
  const deviceFile = deviceFilePath(deviceHome);
  const deviceKind = await entryKind(deviceFile);
  if (deviceKind === null) recorder.write("device", deviceFile, "create");
  else if (deviceKind !== "file") recorder.block("device", deviceFile, "SETUP_TARGET_UNSUPPORTED", `${deviceFile} is not a regular file`);
  else await recorder.attempt("device", deviceFile, () => readDevice(deviceHome));

  // library
  const library = await planLibrary(recorder, input, artifacts);
  const currentLanguage = library.state.settings.find((setting) => setting.key === LANGUAGE_SETTING)?.value ?? null;
  const reusedCloud = context.registered !== null && context.registered.libraryPath === artifacts ? context.registered.cloudHosted : null;
  const defaults: ResolvedSetupAnswers = {
    artifacts,
    cloud: reusedCloud ?? suggestCloudHosted(artifacts, { platform: process.platform, env: process.env, home }),
    language: currentLanguage ?? defaultLanguage(),
    navigation: deviceNavigation !== "declined",
  };
  const resolved: ResolvedSetupAnswers = {
    artifacts,
    cloud: answers.cloud ?? defaults.cloud,
    language: answers.language === undefined ? defaults.language : freshLanguageTag(answers.language),
    navigation: answers.navigation ?? defaults.navigation,
  };
  const navigation = navigationChoice(resolved.navigation);
  if (library.action === "create") recorder.write("library", library.path, "create");
  else if (currentLanguage !== resolved.language) recorder.write("library", library.path, "update");

  // registry
  const registryFile = registryPath(deviceHome);
  const registry: Registry | null = await recorder.attempt("registry", registryFile, () => readRegistry(deviceHome));
  if (registry !== null) {
    const remote = normalizedRemote(projectRoot).normalized;
    const entry = registry.entries.find((candidate) => candidate.projectPath === projectRoot) ?? null;
    const current = entry !== null && entry.libraryPath === library.path && entry.cloudHosted === resolved.cloud && entry.gitRemote === remote &&
      (library.libraryId === null || entry.libraryId === library.libraryId);
    if (!current) recorder.write("registry", registryFile, await entryKind(registryFile) === null ? "create" : "update");
  }

  // skill-copies and launchers, from the engine version directory
  if (engine.directory !== null) {
    await planSkillCopies(recorder, join(engine.directory, ...FRESH_ENGINE_TREE.skill.split("/")), home, deviceHome);
    await planLaunchers(recorder, engine.directory, deviceHome);
  }

  // host-hooks, writable-roots
  await planHooks(recorder, home, deviceHome, navigation);
  await planRoots(recorder, projectRoot, library.path);

  // machine-settings, managed-sections
  if (deviceNavigation !== navigation && recorder.blockers.every((blocker) => blocker.step !== "machine-settings")) {
    recorder.write("machine-settings", settingsFile, await entryKind(settingsFile) === null ? "create" : "update");
  }
  const sections = await planSections(recorder, projectRoot, library, navigation);
  if (sections.recordsChange) recorder.write("library", library.path, "update");

  return {
    questions: questionsFor(input, defaults),
    resolved,
    engine: { version: engine.version, directory: engine.directory },
    library: { path: library.path, action: library.action, libraryId: library.libraryId },
    writes: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    pendingSections: sections.pending,
    blockers: recorder.blockers,
  };
}

// ---- The apply ----

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
  const recorder = new PlanRecorder(deviceHome, at);
  const backupRoot = backupsPath(deviceHome);
  const navigation = navigationChoice(resolved.navigation);

  // device
  const { device, created } = await readOrCreateDevice({ home: deviceHome, now: at });
  if (created) recorder.write("device", deviceFilePath(deviceHome), "create");

  // library, and its language
  const remote = normalizedRemote(projectRoot);
  if (plan.library.action === "create") {
    await initializeLibrary({
      root: plan.library.path,
      createdAt: at,
      projectName: projectHint(basename(projectRoot)),
      gitRemote: projectHint(remote.normalized),
    });
  }
  const library = await openLibrary(plan.library.path);
  if (plan.library.libraryId !== null && library.manifest.libraryId !== plan.library.libraryId) {
    setupFail("SETUP_LIBRARY_CONFLICT", `${library.root} holds ${library.manifest.libraryId}, not the planned ${plan.library.libraryId}`, { library: library.root });
  }
  const libraryPath = library.root;
  const libraryId = library.manifest.libraryId;
  if (plan.library.action === "create") recorder.write("library", libraryPath, "create");
  const state = await materializeWorkspace(libraryPath);
  if (state.settings.find((setting) => setting.key === LANGUAGE_SETTING)?.value !== resolved.language) {
    await setWorkspaceSetting(libraryPath, { key: LANGUAGE_SETTING, value: resolved.language, occurredAt: at });
    recorder.write("library", libraryPath, "update");
  }

  // registry
  const registryFile = registryPath(deviceHome);
  const entry = (await readRegistry(deviceHome)).entries.find((candidate) => candidate.projectPath === projectRoot) ?? null;
  if (entry === null || entry.libraryPath !== libraryPath || entry.libraryId !== libraryId || entry.cloudHosted !== resolved.cloud || entry.gitRemote !== remote.normalized) {
    const action: SetupWriteAction = await entryKind(registryFile) === null ? "create" : "update";
    await registerLibrary({ projectPath: projectRoot, libraryPath, registeredAt: at, cloudHosted: resolved.cloud, gitRemote: remote.raw }, deviceHome);
    recorder.write("registry", registryFile, action);
  }

  // skill-copies
  const record = skillCopiesRecordPath(deviceHome);
  const recordAction: SetupWriteAction = await entryKind(record) === null ? "create" : "update";
  const copies = await installSkillCopies({ source: join(directory, ...FRESH_ENGINE_TREE.skill.split("/")), now: at, home, deviceHome });
  for (const copy of copies.copies) {
    if (copy.action === "reused") continue;
    recorder.write("skill-copies", copy.path, copy.action === "created" ? "create" : "update");
    if (copy.backup !== null) recorder.backup("skill-copies", copy.path);
  }
  if (copies.reasonCode === "SKILL_COPIES_INSTALLED") recorder.write("skill-copies", record, recordAction);

  // launchers
  for (const launcher of FRESH_ENGINE_TREE.launchers) {
    const target = join(engineRoot(deviceHome), launcher.name);
    const bytes = await readFile(join(directory, ...launcher.from.split("/")));
    const kind = await entryKind(target);
    if (kind !== null && kind !== "file") setupFail("SETUP_TARGET_UNSUPPORTED", `${target} is not a regular file`, { path: target });
    const before = kind === "file" ? await readFile(target) : null;
    if (before !== null && before.equals(bytes)) continue;
    if (before !== null) {
      const copy = join(recorder.backupRoot, BACKUP_DIRECTORIES.launchers ?? "launchers", launcher.name);
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

  // host-hooks: the user scope of both hosts
  for (const host of HOST_HOOK_HOSTS) {
    const hooks = await readHostHooks(planHostHooks({ host, scope: "user", deviceHome, navigation }), { root: home, home });
    await applyHostHooks(hooks, { at, backupRoot });
    for (const file of hooks.files) {
      if (!file.changed || file.after === null) continue;
      recorder.write("host-hooks", file.path, file.before === null ? "create" : "update");
      if (file.before !== null) recorder.backup("host-hooks", file.path);
    }
  }

  // writable-roots, for a library outside the project
  if (!inside(projectRoot, libraryPath)) {
    const roots = await planWritableRoots({ projectRoot, libraryPath });
    await applyWritableRoots(roots, { at, home: deviceHome });
    for (const file of roots.files) {
      if (!file.changed) continue;
      const path = join(roots.projectRoot, ...file.path.split("/"));
      recorder.write("writable-roots", path, file.before === null ? "create" : "update");
      if (file.before !== null) recorder.backup("writable-roots", path);
    }
  }

  // machine-settings, then managed-sections
  const settingsFile = join(deviceHome, MACHINE_SETTINGS_FILE_NAME);
  if (await readAgentsNavigation(deviceHome) !== navigation) {
    const action: SetupWriteAction = await entryKind(settingsFile) === null ? "create" : "update";
    await applyMachineSettingSet({ key: AGENTS_NAVIGATION_SETTING, value: navigation, occurredAt: at, path: settingsFile });
    recorder.write("machine-settings", settingsFile, action);
  }
  const existed = new Map<string, boolean>();
  for (const file of [AGENTS_FILE, CLAUDE_FILE]) existed.set(file, await entryKind(join(projectRoot, file)) !== null);
  const rendered = await renderAgentsSections(libraryPath, { projectRoot, navigation, occurredAt: at, backupRoot });
  for (const file of rendered.files) {
    if (!file.written) continue;
    const path = join(projectRoot, file.file);
    recorder.write("managed-sections", path, existed.get(file.file) === true ? "update" : "create");
    if (file.backupPath !== null) recorder.backup("managed-sections", path);
  }
  if (rendered.recorded > 0) recorder.write("library", libraryPath, "update");

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
    deviceId: device.deviceId,
    answers: resolved,
    library: { path: libraryPath, libraryId, created: plan.library.action === "create" },
    written: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    pendingSections: rendered.pending.map((section) => ({ file: section.file, id: section.id })),
    selfCheck,
  };
}
