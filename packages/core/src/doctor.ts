// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R4, AC5 (MIN-227; TCRN-CROSS-SUB-326): doctor, eight checks of this device and
// one project, each with the one reason code it answers when it is red. The doctor command and the
// Atelier status page (TCRN-CROSS-STORY-482 R2) read this same function, so the two never disagree.
//
//   engine-version    engine/current names an installed version whose entry is there, the stable
//                     entry engine/einzbern.mjs is there, and this Node.js meets the floor
//   hooks-present     each host carries exactly one Einzbern hook, as host-hooks.ts renders it, and
//                     the launcher that hook runs is there
//   skill-copies      both copies of the skill hold the tree skills.json records (skill-copies.ts)
//   registry          the registry parses and resolves this project to the library it recorded
//   library-format    the engine answering, and the engine this device has current, both read the
//                     library's format and meet its minimum engine version
//   device-stream     this device's stream is writable: the library's write lock can be taken and a
//                     probe file written where the stream lives
//   managed-sections  every managed section in the project's files agrees with its library record;
//                     the pending ones are listed
//   cloud-flag        the registry's cloud-hosted flag is what the cloud folder table suggests; a
//                     difference is a hint, because the flag is the user's (cloud-roots.ts)
//
// A check never throws: whatever stops it is its red, named in detail.causes, and the other checks
// still run. The library the last five checks look at is the one the registry resolves or, when the
// registry does not resolve this project, the library in the project's own directory, so a missing
// registration is the registry's red alone. Nothing is written except by device-stream: the lock
// and the probe file, both removed again, and the lock directory in the device directory. A library
// this engine may not open is never locked or probed (format-version.ts).

import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import { FRAMEWORK_VERSION } from "./index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { ATOMIC_TEMPORARY_PREFIX } from "./atomic-file.js";
import { streamDirectory } from "./akasha.js";
import { matchCloudRoot } from "./cloud-roots.js";
import type { CloudRootContext } from "./cloud-roots.js";
import { deviceHome as currentDeviceHome, ensureDeviceDirectory, lockPath, registryPath } from "./device-home.js";
import { readDevice } from "./device-identity.js";
import { ENGINE_FILES, engineLauncherPath, engineVersionDirectory, readEngineCurrent } from "./engine-home.js";
import type { EngineCurrent } from "./engine-home.js";
import { LIBRARY_FILES, hasLibraryManifest, openLibrary, readLibraryVersionFields, realLibraryPath } from "./ether-library.js";
import { acquireFileLock } from "./file-lock.js";
import type { FileLock } from "./file-lock.js";
import { ENGINE_FORMAT_VERSION, librarySupportRefusal } from "./format-version.js";
import { HOST_HOOK_FILES, HOST_HOOK_HOSTS, hookLauncherPath, isEinzbernHookCommand, planHostHooks, readHostHooks } from "./host-hooks.js";
import type { HostHookHost, HostHookScope, HostHooksPlan } from "./host-hooks.js";
import { managedSectionRecordKey, managedSectionRecordsFor, planManagedWrite } from "./managed-sections.js";
import { readAgentsNavigation } from "./machine-settings.js";
import { DIRECTORY } from "./names.js";
import { NODE_FLOOR, meetsNodeFloor } from "./node-floor.js";
import { gitRemoteOf, gitTopLevel, normalizeGitRemote, readRegistry } from "./registry.js";
import type { Registry, RegistryEntry, ResolutionPath } from "./registry.js";
import { verifySkillCopies } from "./skill-copies.js";
import { materializeWorkspaceFromGenesis, readLibraryTombstone } from "./workspace.js";

/** The eight checks, in the order doctor reports them. */
export const DOCTOR_CHECKS = Object.freeze([
  "engine-version",
  "hooks-present",
  "skill-copies",
  "registry",
  "library-format",
  "device-stream",
  "managed-sections",
  "cloud-flag",
] as const);
export type DoctorCheckName = typeof DOCTOR_CHECKS[number];

export const DOCTOR_REASON_CODES = Object.freeze([
  "DOCTOR_CLOUD_FLAG_MISMATCH",
  "DOCTOR_DEVICE_STREAM_UNWRITABLE",
  "DOCTOR_ENGINE_NOT_READY",
  "DOCTOR_HOOKS_MISMATCH",
  "DOCTOR_LIBRARY_UNSUPPORTED",
  "DOCTOR_MANAGED_SECTIONS_MISMATCH",
  "DOCTOR_REGISTRY_UNRESOLVED",
  "DOCTOR_SKILL_COPIES_MISMATCH",
] as const);
export type DoctorReasonCode = typeof DOCTOR_REASON_CODES[number];

/** The one reason code each check answers when it is red. */
export const DOCTOR_CHECK_REASON_CODES: Readonly<Record<DoctorCheckName, DoctorReasonCode>> = Object.freeze({
  "engine-version": "DOCTOR_ENGINE_NOT_READY",
  "hooks-present": "DOCTOR_HOOKS_MISMATCH",
  "skill-copies": "DOCTOR_SKILL_COPIES_MISMATCH",
  registry: "DOCTOR_REGISTRY_UNRESOLVED",
  "library-format": "DOCTOR_LIBRARY_UNSUPPORTED",
  "device-stream": "DOCTOR_DEVICE_STREAM_UNWRITABLE",
  "managed-sections": "DOCTOR_MANAGED_SECTIONS_MISMATCH",
  "cloud-flag": "DOCTOR_CLOUD_FLAG_MISMATCH",
});

// How long device-stream waits for the library's write lock before it calls the stream unwritable.
export const DOCTOR_LOCK_TIMEOUT_MS = 2_000 as const;

// The project files managed sections are written into (TCRN-CROSS-STORY-478); a file a library
// record names is read too.
const MANAGED_FILES: readonly string[] = Object.freeze(["AGENTS.md", "CLAUDE.md"]);
const MANAGED_SECTION_COLLECTION = "managed-section";

export interface DoctorInput {
  // The project the checks are about: its hook files, its registration, its library and its files.
  readonly projectRoot: string;
  // The user's home, where both hosts keep their user hooks and skills; the process's by default.
  readonly home?: string;
  // The device directory; EINZBERN_HOME or ~/.einzbern by default.
  readonly deviceHome?: string;
  // What the checks are judged for; this process's Node.js, platform and environment by default.
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly lockTimeoutMs?: number;
}

export interface DoctorCheck {
  readonly check: DoctorCheckName;
  readonly ok: boolean;
  // null while the check is green; its one reason code (DOCTOR_CHECK_REASON_CODES) when it is red.
  readonly reasonCode: DoctorReasonCode | null;
  // What the check found; detail.causes names why it is red and is empty while it is green.
  readonly detail: { readonly [key: string]: JsonValue };
}

type Detail = { readonly [key: string]: JsonValue };

interface DoctorContext {
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly cloud: CloudRootContext;
  readonly lockTimeoutMs: number;
}

// The library the project resolves to, found once for every check that reads it.
interface ProjectLibrary {
  readonly registryCause: string | null;
  readonly registryError: string | null;
  readonly entry: RegistryEntry | null;
  readonly via: ResolutionPath | null;
  // The registered library, or the project's own when the registry does not resolve the project.
  readonly libraryPath: string | null;
  readonly librarySource: "registry" | "project" | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function causeOf(error: unknown): string {
  if (isObject(error) || error instanceof Error) {
    const { reasonCode, code } = error as { readonly reasonCode?: unknown; readonly code?: unknown };
    if (typeof reasonCode === "string") return reasonCode;
    if (typeof code === "string") return code;
  }
  return "DOCTOR_CHECK_FAILED";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function result(check: DoctorCheckName, causes: readonly string[], detail: Detail): DoctorCheck {
  const ok = causes.length === 0;
  return Object.freeze({
    check,
    ok,
    reasonCode: ok ? null : DOCTOR_CHECK_REASON_CODES[check],
    detail: Object.freeze({ ...detail, causes: [...unique(causes)] }),
  });
}

// A check that throws is red with what stopped it; the checks after it still run.
async function guarded(check: DoctorCheckName, run: () => Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (error) {
    return result(check, [causeOf(error)], { error: messageOf(error) });
  }
}

async function entryKind(path: string): Promise<"file" | "directory" | "other" | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "other";
    return stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

// ---- engine-version ----

async function engineVersionCheck(context: DoctorContext): Promise<DoctorCheck> {
  const causes: string[] = [];
  if (!meetsNodeFloor(context.nodeVersion)) causes.push("ENGINE_NODE_TOO_OLD");
  let current: EngineCurrent | null = null;
  try {
    current = await readEngineCurrent(context.deviceHome);
    if (current === null) causes.push("ENGINE_CURRENT_MISSING");
  } catch (error) {
    causes.push(causeOf(error));
  }
  let versionDirectory: string | null = null;
  if (current !== null) {
    versionDirectory = engineVersionDirectory(current.version, context.deviceHome);
    if (await entryKind(join(versionDirectory, ...ENGINE_FILES.entry.split("/"))) !== "file") causes.push("ENGINE_VERSION_MISSING");
  }
  const entry = engineLauncherPath(context.deviceHome);
  const entryPresent = await entryKind(entry) === "file";
  if (!entryPresent) causes.push("ENGINE_ENTRY_MISSING");
  return result("engine-version", causes, {
    current: current?.version ?? null,
    previous: current?.previous ?? null,
    versionDirectory,
    entry,
    entryPresent,
    running: FRAMEWORK_VERSION,
    node: context.nodeVersion,
    nodeFloor: NODE_FLOOR,
  });
}

// ---- hooks-present ----

interface ScopeRead {
  readonly count: number;
  // The host's files as rendered with the hook in this scope, and without it.
  readonly installed: HostHooksPlan;
  readonly bare: HostHooksPlan;
}

interface ScopeEntry {
  readonly scope: HostHookScope;
  readonly path: string;
  readonly read: ScopeRead | null;
  readonly error: string | null;
}

// How many Einzbern hooks run on UserPromptSubmit. Declined navigation adds two pointer hooks on
// separate events; those are checked against the expected document below, not counted as copies.
function einzbernHookCount(text: string | null): number {
  if (text === null || text.trim() === "") return 0;
  // readHostHooks has already refused a file that is not a JSON object.
  const document: unknown = JSON.parse(text);
  const hooks = isObject(document) ? document.hooks : null;
  if (!isObject(hooks)) return 0;
  let count = 0;
  const groups = hooks.UserPromptSubmit;
  if (!Array.isArray(groups)) return 0;
  const list: readonly unknown[] = groups;
  for (const group of list) {
    const entries = isObject(group) ? group.hooks : null;
    if (!Array.isArray(entries)) continue;
    const hookList: readonly unknown[] = entries;
    for (const hook of hookList) {
      if (isObject(hook) && typeof hook.command === "string" && isEinzbernHookCommand(hook.command)) count += 1;
    }
  }
  return count;
}

async function readScope(host: HostHookHost, scope: HostHookScope, root: string, context: DoctorContext): Promise<ScopeRead> {
  const location = { root, home: context.home };
  const navigation = scope === "user" ? await readAgentsNavigation(context.deviceHome) : null;
  const request = { host, scope, deviceHome: context.deviceHome, platform: context.platform, navigation };
  const installed = await readHostHooks(planHostHooks(request), location);
  const bare = await readHostHooks(planHostHooks({ ...request, install: false }), location);
  return { count: einzbernHookCount(installed.files[0]?.before ?? null), installed, bare };
}

function changedFiles(plan: HostHooksPlan): readonly string[] {
  return plan.files.filter((file) => file.changed).map((file) => file.path);
}

async function hooksPresentCheck(context: DoctorContext): Promise<DoctorCheck> {
  const causes: string[] = [];
  let launcher: string | null = null;
  try {
    launcher = hookLauncherPath(context.deviceHome, context.platform);
    if (await entryKind(launcher) !== "file") causes.push("HOOK_LAUNCHER_MISSING");
  } catch (error) {
    causes.push(causeOf(error));
  }
  // A project opened at the home directory has one scope, not the same file counted twice.
  const home = await realpath(context.home).catch(() => context.home);
  const scopes: readonly { readonly scope: HostHookScope; readonly root: string }[] = context.projectRoot === home
    ? [{ scope: "user", root: context.home }]
    : [{ scope: "user", root: context.home }, { scope: "project", root: context.projectRoot }];
  const hosts: JsonValue[] = [];
  for (const host of HOST_HOOK_HOSTS) {
    const hostCauses: string[] = [];
    const entries: ScopeEntry[] = [];
    for (const { scope, root } of scopes) {
      const path = join(root, ...HOST_HOOK_FILES[host].split("/"));
      try {
        entries.push({ scope, path, read: await readScope(host, scope, root, context), error: null });
      } catch (error) {
        // Among them HOST_HOOKS_FILE_UNSUPPORTED: a hook file that is a symbolic link, which the
        // installer neither follows nor replaces, so it cannot put the hook there.
        hostCauses.push(causeOf(error));
        entries.push({ scope, path, read: null, error: messageOf(error) });
      }
    }
    const total = entries.reduce((sum, entry) => sum + (entry.read?.count ?? 0), 0);
    const readable = hostCauses.length === 0;
    if (readable && total === 0) hostCauses.push("HOOK_MISSING");
    if (readable && total > 1) hostCauses.push("HOOK_DUPLICATED");
    const files: JsonValue[] = [];
    for (const entry of entries) {
      if (entry.read === null) {
        files.push({ scope: entry.scope, path: entry.path, error: entry.error });
        continue;
      }
      // With exactly one hook, its scope must be as host-hooks.ts renders it, and the other scope
      // must hold nothing of ours: no old harness hook, deny rule or key.
      const holds = entry.read.count === 1;
      const differs = readable && total === 1 ? changedFiles(holds ? entry.read.installed : entry.read.bare) : [];
      if (differs.length > 0) hostCauses.push(holds ? "HOOK_NOT_AS_EXPECTED" : "HOOK_LEGACY_PRESENT");
      files.push({ scope: entry.scope, path: entry.path, hooks: entry.read.count, differs: [...differs] });
    }
    causes.push(...hostCauses);
    hosts.push({ host, hooks: total, files, causes: [...unique(hostCauses)] });
  }
  return result("hooks-present", causes, { launcher, hosts });
}

// ---- skill-copies ----

async function skillCopiesCheck(context: DoctorContext): Promise<DoctorCheck> {
  const verification = await verifySkillCopies({ home: context.home, deviceHome: context.deviceHome });
  return result("skill-copies", verification.ok ? [] : [verification.reasonCode], {
    record: verification.record,
    copies: verification.copies.map((copy) => ({ host: copy.host, path: copy.path, reasonCode: copy.reasonCode })),
    legacyCopies: [...verification.legacyCopies],
  });
}

// ---- the project's library, and registry ----

function ancestors(path: string): readonly string[] {
  const chain: string[] = [];
  let current = path;
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

// The registry's entry for the project, found in the order resolveLibrary (registry.ts) looks: the
// project or its nearest registered ancestor, its Git working tree's top level, its Git remote. The
// library itself is not opened here: whether this engine may open it is library-format's question.
async function findEntry(registry: Registry, project: string): Promise<{ readonly entry: RegistryEntry; readonly via: ResolutionPath } | null> {
  for (const candidate of ancestors(project)) {
    const entry = registry.entries.find((item) => item.projectPath === candidate);
    if (entry !== undefined) return { entry, via: "project-path" };
  }
  if (registry.entries.length > 0) {
    const top = gitTopLevel(project);
    const topReal = top === null ? null : await realpath(resolve(top)).catch(() => null);
    const entry = topReal === null ? undefined : registry.entries.find((item) => item.projectPath === topReal);
    if (entry !== undefined) return { entry, via: "git-toplevel" };
  }
  if (registry.entries.some((item) => item.gitRemote !== null)) {
    const remote = gitRemoteOf(project);
    const normalized = remote === null ? null : normalizeGitRemote(remote);
    const entry = normalized === null ? undefined : registry.entries.find((item) => item.gitRemote === normalized);
    if (entry !== undefined) return { entry, via: "git-remote" };
  }
  return null;
}

async function locateLibrary(context: DoctorContext): Promise<ProjectLibrary> {
  let registryCause: string | null = null;
  let registryError: string | null = null;
  let found: { readonly entry: RegistryEntry; readonly via: ResolutionPath } | null = null;
  try {
    found = await findEntry(await readRegistry(context.deviceHome), context.projectRoot);
  } catch (error) {
    registryCause = causeOf(error);
    registryError = messageOf(error);
  }
  const base = { registryCause, registryError, entry: found?.entry ?? null, via: found?.via ?? null };
  if (found !== null) return { ...base, libraryPath: found.entry.libraryPath, librarySource: "registry" };
  const own = join(context.projectRoot, DIRECTORY.library);
  try {
    if (await hasLibraryManifest(own)) return { ...base, libraryPath: await realLibraryPath(own), librarySource: "project" };
  } catch {
    // An unreadable project directory holds no library the checks can read.
  }
  return { ...base, libraryPath: null, librarySource: null };
}

// The library id a library's manifest records, read as it stands.
async function manifestLibraryId(libraryPath: string): Promise<{ readonly id: string | null; readonly cause: string | null }> {
  let text: string;
  try {
    text = await readFile(join(await realLibraryPath(libraryPath), LIBRARY_FILES.manifest), "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { id: null, cause: "LIBRARY_NOT_FOUND" };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { id: null, cause: "LIBRARY_MANIFEST_INVALID" };
  }
  const id = isObject(value) ? value.libraryId : undefined;
  return typeof id === "string" ? { id, cause: null } : { id: null, cause: "LIBRARY_MANIFEST_INVALID" };
}

async function registryCheck(context: DoctorContext, located: ProjectLibrary): Promise<DoctorCheck> {
  const entry = located.entry;
  const detail: Detail = {
    registry: registryPath(context.deviceHome),
    project: context.projectRoot,
    via: located.via,
    libraryPath: entry?.libraryPath ?? null,
    libraryId: entry?.libraryId ?? null,
  };
  if (located.registryCause !== null) return result("registry", [located.registryCause], { ...detail, error: located.registryError });
  if (entry === null) return result("registry", ["LIBRARY_NOT_REGISTERED"], detail);
  const recorded = await manifestLibraryId(entry.libraryPath);
  if (recorded.cause !== null) return result("registry", [recorded.cause], detail);
  if (recorded.id !== entry.libraryId) return result("registry", ["LIBRARY_REGISTRY_MISMATCH"], { ...detail, found: recorded.id });
  return result("registry", [], detail);
}

// ---- library-format ----

async function libraryFormatCheck(context: DoctorContext, located: ProjectLibrary): Promise<DoctorCheck> {
  if (located.libraryPath === null) return result("library-format", ["LIBRARY_NOT_FOUND"], { libraryPath: null, source: null });
  const fields = await readLibraryVersionFields(located.libraryPath);
  const causes: string[] = [];
  const where = `library ${fields.root}`;
  const refusal = librarySupportRefusal(fields, { engineVersion: FRAMEWORK_VERSION, supportedFormat: ENGINE_FORMAT_VERSION, where });
  if (refusal !== null) {
    causes.push(refusal.reasonCode);
  } else {
    // The rest of the manifest is judged only once its format is one this engine reads.
    try {
      await openLibrary(fields.root);
    } catch (error) {
      causes.push(causeOf(error));
    }
  }
  // The engine the device's hooks and entry run. Its library format is known only by running it, so
  // it is held to the minimum engine version, which a write that raises the format raises too.
  let current: string | null = null;
  try {
    current = (await readEngineCurrent(context.deviceHome))?.version ?? null;
  } catch {
    // A damaged pointer is engine-version's red.
  }
  if (current !== null && current !== FRAMEWORK_VERSION) {
    const installed = librarySupportRefusal({ minEngineVersion: fields.minEngineVersion }, { engineVersion: current, where });
    if (installed !== null) causes.push(installed.reasonCode);
  }
  return result("library-format", causes, {
    libraryPath: fields.root,
    source: located.librarySource,
    formatVersion: typeof fields.formatVersion === "number" ? fields.formatVersion : null,
    minEngineVersion: typeof fields.minEngineVersion === "string" ? fields.minEngineVersion : null,
    engineVersion: FRAMEWORK_VERSION,
    supportedFormat: ENGINE_FORMAT_VERSION,
    currentEngine: current,
  });
}

// ---- device-stream ----

// Create, write, flush and remove a file the stream's readers skip (an atomic write's temporary
// name); null when it went through, otherwise what stopped it.
async function probeWrite(directory: string): Promise<string | null> {
  const probe = join(directory, `${ATOMIC_TEMPORARY_PREFIX}doctor-${randomBytes(6).toString("hex")}`);
  let handle: FileHandle;
  try {
    handle = await open(probe, "wx");
  } catch (error) {
    return causeOf(error);
  }
  try {
    await handle.writeFile("einzbern doctor probe\n");
    await handle.sync();
    return null;
  } catch (error) {
    return causeOf(error);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(probe, { force: true });
  }
}

async function deviceStreamCheck(context: DoctorContext, located: ProjectLibrary): Promise<DoctorCheck> {
  if (located.libraryPath === null) return result("device-stream", ["LIBRARY_NOT_FOUND"], { libraryPath: null });
  // A library this engine refuses is refused here, before its lock is taken or a byte written.
  const library = await openLibrary(located.libraryPath);
  const base: Detail = { libraryPath: library.root, libraryId: library.manifest.libraryId };
  const tombstone = await readLibraryTombstone(library.root);
  if (tombstone !== null) return result("device-stream", ["LIBRARY_TOMBSTONED"], { ...base, movedTo: tombstone.movedTo });
  const device = await readDevice(context.deviceHome);
  const lock = lockPath(library.manifest.libraryId, context.deviceHome);
  const detail: Detail = { ...base, deviceId: device?.deviceId ?? null, lock };
  await ensureDeviceDirectory(dirname(lock));
  let held: FileLock;
  try {
    held = await acquireFileLock(lock, { timeoutMs: context.lockTimeoutMs });
  } catch (error) {
    const holderPid = isObject(error) && isObject(error.details) ? error.details.holderPid : undefined;
    return result("device-stream", [causeOf(error)], { ...detail, holderPid: typeof holderPid === "string" ? holderPid : null });
  }
  try {
    // This device's stream directory once it has one; before its first write, akasha/, where the
    // first write creates it. The stream directory is never created here: a device directory
    // without a stream manifest reads as a device of unknown version (format-version.ts).
    const stream = device === null ? null : streamDirectory(library.root, device.deviceId);
    const events = join(library.root, DIRECTORY.events);
    const target = stream !== null && await entryKind(stream) === "directory" ? stream : events;
    if (await entryKind(target) !== "directory") return result("device-stream", ["AKASHA_DIRECTORY_MISSING"], { ...detail, probed: target });
    const failure = await probeWrite(target);
    return failure === null
      ? result("device-stream", [], { ...detail, probed: target })
      : result("device-stream", ["STREAM_DIRECTORY_UNWRITABLE"], { ...detail, probed: target, error: failure });
  } finally {
    await held.release();
  }
}

// ---- managed-sections ----

async function managedSectionsCheck(context: DoctorContext, located: ProjectLibrary): Promise<DoctorCheck> {
  if (located.libraryPath === null) return result("managed-sections", ["LIBRARY_NOT_FOUND"], { libraryPath: null });
  // Replayed from the streams, read-only: neither the device cache nor the projection is trusted.
  const state = await materializeWorkspaceFromGenesis(located.libraryPath);
  const recorded = state.configRecords.filter((record) => record.collection === MANAGED_SECTION_COLLECTION);
  const files = [...new Set([...MANAGED_FILES, ...recorded.map((record) => String(record.value.file))])].sort();
  const causes: string[] = [];
  // Pending: what the library already holds as pending, and every section whose file digest no
  // longer agrees with its marker or its record, which the writer would leave pending.
  const pending = new Set(recorded.filter((record) => record.value.state === "pending").map((record) => record.key));
  const removed: string[] = [];
  const problems: JsonValue[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const records = managedSectionRecordsFor(state, file);
    try {
      const plan = await planManagedWrite({ filePath: join(context.projectRoot, ...file.split("/")), file, desired: [], records });
      for (const id of plan.pending) pending.add(managedSectionRecordKey(file, id));
      for (const decision of plan.sections) {
        // Markers the user took out: the section is not put back, and its record will say removed.
        if (decision.result === "removed" && decision.recordChanged) removed.push(managedSectionRecordKey(file, decision.id));
      }
    } catch (error) {
      const cause = causeOf(error);
      // A file the writer cannot write (a symbolic link, say CLAUDE.md to AGENTS.md, or a file that
      // is not UTF-8) disagrees with nothing while the library records no section in it.
      if (cause === "MANAGED_SECTION_FILE_UNSUPPORTED" && records.length === 0) {
        skipped.push(file);
        continue;
      }
      // MANAGED_SECTION_MALFORMED names the line. The writer refuses such a file whole.
      const line = isObject(error) && isObject(error.details) ? error.details.line : undefined;
      causes.push(cause);
      problems.push({ file, reasonCode: cause, line: typeof line === "string" ? Number(line) : null });
    }
  }
  if (pending.size > 0) causes.push("MANAGED_SECTION_PENDING");
  return result("managed-sections", causes, {
    libraryPath: located.libraryPath,
    files,
    pending: [...pending].sort(),
    removed: removed.sort(),
    problems,
    skipped,
  });
}

// ---- cloud-flag ----

async function cloudFlagCheck(context: DoctorContext, located: ProjectLibrary): Promise<DoctorCheck> {
  const entry = located.entry;
  // Without an entry there is no flag to compare; the registry check says why.
  if (entry === null) return result("cloud-flag", [], { registered: false, advisory: true });
  const match = matchCloudRoot(entry.libraryPath, context.cloud);
  const suggested = match !== null;
  const detail: Detail = {
    registered: true,
    libraryPath: entry.libraryPath,
    cloudHosted: entry.cloudHosted,
    suggested,
    provider: match?.provider ?? null,
    cloudRoot: match?.cloudRoot ?? null,
    // Red here is a hint: the flag is the user's, and the table only suggests it.
    advisory: true,
  };
  return result("cloud-flag", entry.cloudHosted === suggested ? [] : ["CLOUD_FLAG_DIFFERS_FROM_SUGGESTION"], detail);
}

// ---- doctor ----

async function doctorContext(input: DoctorInput): Promise<DoctorContext> {
  const given = resolve(input.projectRoot);
  const home = resolve(input.home ?? homedir());
  const platform = input.platform ?? process.platform;
  return {
    // Registered projects are recorded by their real path.
    projectRoot: await realpath(given).catch(() => given),
    home,
    deviceHome: resolve(input.deviceHome ?? currentDeviceHome()),
    nodeVersion: input.nodeVersion ?? process.versions.node,
    platform,
    cloud: { platform, env: input.env ?? process.env, home },
    lockTimeoutMs: input.lockTimeoutMs ?? DOCTOR_LOCK_TIMEOUT_MS,
  };
}

/** The eight checks of this device and one project, in DOCTOR_CHECKS order. Each is green or names its red. */
export async function runDoctor(input: DoctorInput): Promise<readonly DoctorCheck[]> {
  const context = await doctorContext(input);
  const located = await locateLibrary(context);
  const checks: readonly (readonly [DoctorCheckName, () => Promise<DoctorCheck>])[] = [
    ["engine-version", () => engineVersionCheck(context)],
    ["hooks-present", () => hooksPresentCheck(context)],
    ["skill-copies", () => skillCopiesCheck(context)],
    ["registry", () => registryCheck(context, located)],
    ["library-format", () => libraryFormatCheck(context, located)],
    ["device-stream", () => deviceStreamCheck(context, located)],
    ["managed-sections", () => managedSectionsCheck(context, located)],
    ["cloud-flag", () => cloudFlagCheck(context, located)],
  ];
  const results: DoctorCheck[] = [];
  // One after another: device-stream's lock never overlaps another check's reads.
  for (const [check, run] of checks) results.push(await guarded(check, run));
  return Object.freeze(results);
}
