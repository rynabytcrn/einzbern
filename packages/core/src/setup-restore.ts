// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R3, AC3 (MIN-227 D24; TCRN-CROSS-SUB-324): setup --mode restore, which
// connects this device and a project to a library that already exists: made on another device,
// left from before a reinstall, or kept in a backup or a cloud drive. Before anything is written the
// library passes eight checks, in this order, each with its one reason code:
//
//   1 readable        RESTORE_UNREADABLE: the place exists and every file the checks read is read
//                     in time; a sync client's placeholder that does not arrive is AKASHA_READ_TIMEOUT
//   2 library         RESTORE_NOT_A_LIBRARY: a library manifest is there (an old-layout workspace is
//                     a migration instead), and it is valid wherever this engine can judge it
//   3 format          RESTORE_FORMAT_UNSUPPORTED: this engine reads the library's format and meets
//                     its minimum engine version, and those of every stream (format-version.ts)
//   4 streams         RESTORE_STREAM_INVALID: every stream's hash chain holds, and no stream
//                     directory holds a copy a sync client made of a conflicting file
//   5 project         RESTORE_PROJECT_MISMATCH: the Git remote the library's manifest names as its
//                     project's is this project's, when both are known
//   6 registry        RESTORE_REGISTRY_BOUND_ELSEWHERE: this device's registry does not bind the
//                     project to another library, or to another copy of this one that is still there
//   7 device-stream   RESTORE_DEVICE_STREAM: this device's stream can be created or reused: the
//                     library was not moved away, and the directory it is written in is writable
//   8 sections        RESTORE_SECTIONS_DIVERGED: every managed section in the project's files
//                     agrees with the library's record of it, and none of the files is malformed
//
// The first check that fails stops the restore, and nothing is written: planning refuses with that
// check's reason code, and so does an apply, which runs the eight checks again. Once all eight pass,
// the steps of a first installation run from the registry on (setup-fresh.ts), with this device's
// identity created first when it has none (its stream needs it). The library's project-level
// settings are not written: they come back with the library, and SETUP_APPLIED lists them in one
// column beside the device-level settings, which never travel with a library, in the other.

import { constants } from "node:fs";
import { access, readdir, readFile as readFileBytes, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import { FRAMEWORK_VERSION } from "./index.js";
import { assertCanonicalJson, canonicalJson } from "../../protocol/src/index.js";
import { AGENTS_FILE, CLAUDE_FILE } from "./agents-sections.js";
import { isAtomicTemporaryName } from "./atomic-file.js";
import { AKASHA_READ_TIMEOUT_DEFAULT_MS, STREAM_MANIFEST_FILE, readAllStreams } from "./akasha.js";
import type { ReadBytes } from "./akasha.js";
import { readDevice } from "./device-identity.js";
import { LIBRARY_FILES, validateLibraryManifest } from "./ether-library.js";
import type { Library } from "./ether-library.js";
import { ENGINE_FORMAT_VERSION, librarySupportRefusal } from "./format-version.js";
import { legacyControlDirectory } from "./legacy-workspace.js";
import { MACHINE_SETTINGS_CATALOG, MACHINE_SETTINGS_FILE_NAME, readMachineSettings } from "./machine-settings.js";
import { managedSectionRecordsFor, planManagedWrite } from "./managed-sections.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY } from "./names.js";
import { gitRemoteOf, normalizeGitRemote, readRegistry } from "./registry.js";
import type { SetupApplied, SetupColumns, SetupModeInput, SetupModePlan, SetupPlan, SetupQuestion, ResolvedSetupAnswers } from "./setup.js";
import { SETUP_ACTOR, setupFail } from "./setup.js";
import {
  SetupRecorder,
  applyDevice,
  applyWiring,
  defaultCloud,
  defaultLanguage,
  entryKind,
  libraryLanguage,
  messageOf,
  navigationChoice,
  planDevice,
  planEngineSource,
  planWiring,
  readDeviceNavigation,
  readEngineFiles,
  reasonOf,
  setupApplied,
} from "./setup-fresh.js";
import { materializeLibraryRead, materializeWorkspace, readLibraryTombstone } from "./workspace.js";
import type { WorkspaceState } from "./workspace.js";

/** The eight checks, in the order they run. */
export const RESTORE_CHECKS = Object.freeze([
  "readable",
  "library",
  "format",
  "streams",
  "project",
  "registry",
  "device-stream",
  "sections",
] as const);
export type RestoreCheckName = typeof RESTORE_CHECKS[number];

export const RESTORE_REASON_CODES = Object.freeze([
  "RESTORE_DEVICE_STREAM",
  "RESTORE_FORMAT_UNSUPPORTED",
  "RESTORE_NOT_A_LIBRARY",
  "RESTORE_PROJECT_MISMATCH",
  "RESTORE_REGISTRY_BOUND_ELSEWHERE",
  "RESTORE_SECTIONS_DIVERGED",
  "RESTORE_STREAM_INVALID",
  "RESTORE_UNREADABLE",
] as const);
export type RestoreReasonCode = typeof RESTORE_REASON_CODES[number];

/** The one reason code each check answers when it fails. */
export const RESTORE_CHECK_REASON_CODES: Readonly<Record<RestoreCheckName, RestoreReasonCode>> = Object.freeze({
  readable: "RESTORE_UNREADABLE",
  library: "RESTORE_NOT_A_LIBRARY",
  format: "RESTORE_FORMAT_UNSUPPORTED",
  streams: "RESTORE_STREAM_INVALID",
  project: "RESTORE_PROJECT_MISMATCH",
  registry: "RESTORE_REGISTRY_BOUND_ELSEWHERE",
  "device-stream": "RESTORE_DEVICE_STREAM",
  sections: "RESTORE_SECTIONS_DIVERGED",
});

/** A restore the checks stopped: details.check and details.item name the check, details.cause what failed in it. */
export class RestoreError extends Error {
  readonly reasonCode: RestoreReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: RestoreReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "RestoreError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface RestoreCheck {
  // 1 to 8, and its name.
  readonly item: number;
  readonly check: RestoreCheckName;
  readonly ok: boolean;
  // null while it passes; its one reason code when it fails.
  readonly reasonCode: RestoreReasonCode | null;
  // What it found; detail.cause names what failed.
  readonly detail: Readonly<Record<string, string>>;
}

export interface RestoreInput {
  // The project's real path.
  readonly projectRoot: string;
  readonly home: string;
  readonly deviceHome: string;
  // The library to restore from, absolute.
  readonly libraryPath: string;
}

export interface RestoreReadOptions {
  // Test seam: how a file of the library is read (a sync client's placeholder can block it).
  readonly readFile?: ReadBytes;
  // How long one read may take before it is AKASHA_READ_TIMEOUT.
  readonly timeoutMs?: number;
}

export interface VerifiedLibrary {
  readonly root: string;
  readonly libraryId: string;
  // The library merged from the streams the checks read.
  readonly state: WorkspaceState;
  // This device's stream: created at its first write, or reused.
  readonly deviceStream: { readonly deviceId: string | null; readonly action: "create" | "reuse" };
}

export interface RestoreVerification {
  // Whether all eight passed; `checks` ends at the first that failed.
  readonly ok: boolean;
  readonly libraryPath: string;
  readonly checks: readonly RestoreCheck[];
  readonly library: VerifiedLibrary | null;
}

// ---- What the checks read ----

type Detail = Readonly<Record<string, string>>;

class CheckFailure {
  readonly cause: string;
  readonly message: string;
  readonly detail: Detail;

  constructor(cause: string, message: string, detail: Detail = {}) {
    this.cause = cause;
    this.message = message;
    this.detail = detail;
  }
}

// The string details an error carries, as the CLI passes them on.
function stringDetails(error: unknown): Detail {
  const details = error !== null && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  if (details === null || typeof details !== "object") return {};
  return Object.fromEntries(Object.entries(details as Readonly<Record<string, unknown>>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function failureOf(error: unknown, fallback: string): CheckFailure {
  const code = (error as { code?: unknown } | null)?.code;
  return new CheckFailure(reasonOf(error) ?? (typeof code === "string" ? code : fallback), messageOf(error), stringDetails(error));
}

const SEGMENT_NAME = /^[0-9a-f]{8}\.(?:ndjson|json)$/u;
const SEGMENT_STEM = /^[0-9a-f]{8}(?![0-9a-f])/u;
const DEVICE_ID_STEM = /^[0-9a-f]{32}(?![0-9a-f])/u;
const DEVICE_ID = /^[0-9a-f]{32}$/u;

// What a sync client names the copy it keeps of a file two machines changed: "manifest (conflicted
// copy ...).json", "manifest 2.json", "manifest (1).json", "manifest-HOST.json",
// "manifest.sync-conflict-....json" — the file's own stem with something added. In a library only
// the stream files can be copied so, since each has one writer; a copy means two writers.
function isConflictCopy(name: string, stems: readonly RegExp[]): boolean {
  if (isAtomicTemporaryName(name)) return false;
  if (/conflict/iu.test(name)) return true;
  return stems.some((stem) => stem.test(name));
}

interface Snapshot {
  readonly root: string;
  readonly directory: boolean;
  readonly entries: readonly string[];
  // Every file the checks read, by absolute path.
  readonly files: ReadonlyMap<string, Buffer>;
  // akasha/: its entries, and each device directory's entries.
  readonly akasha: readonly string[] | null;
  readonly streams: ReadonlyMap<string, readonly string[]>;
}

function timedReader(readFile: ReadBytes, timeoutMs: number): ReadBytes {
  return (path) => new Promise<Buffer>((resolveRead, rejectRead) => {
    const timer = setTimeout(() => {
      rejectRead(new CheckFailure("AKASHA_READ_TIMEOUT", `reading ${path} did not finish in ${timeoutMs} ms`, {
        file: path.split(/[\\/]/u).slice(-2).join("/"),
        timeoutMs: String(timeoutMs),
      }));
    }, timeoutMs);
    readFile(path).then((bytes) => {
      clearTimeout(timer);
      resolveRead(bytes);
    }, (error: unknown) => {
      clearTimeout(timer);
      rejectRead(error);
    });
  });
}

// 1 readable: the place, its manifest and every file of akasha/, each read within the timeout.
async function readSnapshot(libraryPath: string, options: RestoreReadOptions): Promise<Snapshot | CheckFailure> {
  let root: string;
  let directory: boolean;
  try {
    root = await realpath(libraryPath);
    directory = (await stat(root)).isDirectory();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return new CheckFailure(code, `nothing is at ${libraryPath}`, { path: libraryPath });
    return failureOf(error, "RESTORE_UNREADABLE");
  }
  if (!directory) return { root, directory, entries: [], files: new Map(), akasha: null, streams: new Map() };
  const read = timedReader(options.readFile ?? readFileBytes, options.timeoutMs ?? AKASHA_READ_TIMEOUT_DEFAULT_MS);
  const files = new Map<string, Buffer>();
  const streams = new Map<string, readonly string[]>();
  let entries: readonly string[] = [];
  let akasha: readonly string[] | null = null;
  try {
    entries = (await readdir(root)).sort();
    if (entries.includes(LIBRARY_FILES.manifest) && await entryKind(join(root, LIBRARY_FILES.manifest)) === "file") {
      files.set(join(root, LIBRARY_FILES.manifest), await read(join(root, LIBRARY_FILES.manifest)));
    }
    const events = join(root, DIRECTORY.events);
    if (await entryKind(events) === "directory") {
      akasha = (await readdir(events)).sort();
      for (const deviceId of akasha) {
        const stream = join(events, deviceId);
        if (!DEVICE_ID.test(deviceId) || await entryKind(stream) !== "directory") continue;
        const names = (await readdir(stream)).sort();
        streams.set(deviceId, names);
        for (const name of names) {
          if (name !== STREAM_MANIFEST_FILE && !SEGMENT_NAME.test(name)) continue;
          if (await entryKind(join(stream, name)) === "file") files.set(join(stream, name), await read(join(stream, name)));
        }
      }
    }
  } catch (error) {
    return error instanceof CheckFailure ? error : failureOf(error, "RESTORE_UNREADABLE");
  }
  return { root, directory, entries, files, akasha, streams };
}

// ---- The eight checks ----

interface ManifestRead {
  readonly parsed: Readonly<Record<string, unknown>>;
  // The manifest as this engine validates it, or null when its format is one this engine cannot judge.
  readonly manifest: Library["manifest"] | null;
}

// 2 library.
async function libraryCheck(snapshot: Snapshot): Promise<ManifestRead | CheckFailure> {
  const path = join(snapshot.root, LIBRARY_FILES.manifest);
  if (!snapshot.directory) return new CheckFailure("LIBRARY_NOT_FOUND", `${snapshot.root} is a file, not a library`, { path: snapshot.root });
  const bytes = snapshot.files.get(path);
  if (bytes === undefined) {
    const legacy = await legacyControlDirectory(snapshot.root) !== null ||
      (basename(snapshot.root) === LEGACY_CONTROL_DIRECTORY && snapshot.entries.includes("workspace.json"));
    return legacy
      ? new CheckFailure("LEGACY_WORKSPACE", `${snapshot.root} holds an old-layout workspace, which is migrated rather than restored`, { path: snapshot.root, remedy: "--mode migrate" })
      : new CheckFailure("LIBRARY_NOT_FOUND", `${snapshot.root} holds no ${LIBRARY_FILES.manifest}: it is not a library`, { path: snapshot.root });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return new CheckFailure("LIBRARY_MANIFEST_INVALID", `${path} is not JSON`, { file: LIBRARY_FILES.manifest });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new CheckFailure("LIBRARY_MANIFEST_INVALID", `${path} is not an object`, { file: LIBRARY_FILES.manifest });
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  // A newer format may change the rest of the manifest: the format check judges it first.
  const fields = { formatVersion: record.formatVersion, minEngineVersion: record.minEngineVersion };
  if (librarySupportRefusal(fields, { engineVersion: FRAMEWORK_VERSION }) !== null) return { parsed: record, manifest: null };
  try {
    const manifest = validateLibraryManifest(parsed, path);
    if (canonicalJson(manifest) !== bytes.toString("utf8")) {
      return new CheckFailure("LIBRARY_MANIFEST_INVALID", `${path} is not in canonical form`, { file: LIBRARY_FILES.manifest });
    }
    return { parsed: record, manifest };
  } catch (error) {
    return failureOf(error, "LIBRARY_MANIFEST_INVALID");
  }
}

// 3 format: the library's manifest and every stream manifest.
function formatCheck(snapshot: Snapshot, read: ManifestRead): Detail | CheckFailure {
  const where = `library ${snapshot.root}`;
  const refusal = librarySupportRefusal({ formatVersion: read.parsed.formatVersion, minEngineVersion: read.parsed.minEngineVersion }, { engineVersion: FRAMEWORK_VERSION, where });
  if (refusal !== null) return new CheckFailure(refusal.reasonCode, refusal.message, refusal.details);
  for (const deviceId of snapshot.streams.keys()) {
    const bytes = snapshot.files.get(join(snapshot.root, DIRECTORY.events, deviceId, STREAM_MANIFEST_FILE));
    if (bytes === undefined) continue;
    let parsed: unknown = null;
    try {
      parsed = assertCanonicalJson(bytes.toString("utf8"));
    } catch {
      // A manifest that does not parse is the streams check's to name.
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const stream = librarySupportRefusal({ formatVersion: (parsed as Readonly<Record<string, unknown>>).formatVersion }, {
      engineVersion: FRAMEWORK_VERSION,
      where: `stream ${DIRECTORY.events}/${deviceId}`,
      details: { deviceId },
    });
    if (stream !== null) return new CheckFailure(stream.reasonCode, stream.message, stream.details);
  }
  const format = read.parsed.formatVersion;
  const minimum = read.parsed.minEngineVersion;
  return {
    formatVersion: typeof format === "number" ? String(format) : "",
    minEngineVersion: typeof minimum === "string" ? minimum : "",
    engineVersion: FRAMEWORK_VERSION,
    supported: String(ENGINE_FORMAT_VERSION),
  };
}

// 4 streams: no copy a sync client made, and every stream's chain, merged.
async function streamsCheck(snapshot: Snapshot, manifest: Library["manifest"], options: RestoreReadOptions): Promise<{ readonly state: WorkspaceState; readonly detail: Detail } | CheckFailure> {
  for (const name of snapshot.akasha ?? []) {
    if (!DEVICE_ID.test(name) && isConflictCopy(name, [DEVICE_ID_STEM])) {
      return new CheckFailure("SYNC_CONFLICT_COPY", `${DIRECTORY.events}/${name} is a copy a sync client made of a conflicting stream`, { file: `${DIRECTORY.events}/${name}` });
    }
  }
  for (const [deviceId, names] of snapshot.streams) {
    for (const name of names) {
      if (name === STREAM_MANIFEST_FILE || SEGMENT_NAME.test(name)) continue;
      if (isConflictCopy(name, [/^manifest/u, SEGMENT_STEM])) {
        return new CheckFailure("SYNC_CONFLICT_COPY", `${DIRECTORY.events}/${deviceId}/${name} is a copy a sync client made of a conflicting file`, {
          deviceId,
          file: `${deviceId}/${name}`,
        });
      }
    }
  }
  const cached: ReadBytes = async (path) => snapshot.files.get(path) ?? (options.readFile ?? readFileBytes)(path);
  try {
    const read = await readAllStreams(snapshot.root, { readFile: cached, timeoutMs: options.timeoutMs ?? AKASHA_READ_TIMEOUT_DEFAULT_MS });
    const state = materializeLibraryRead({ root: snapshot.root, manifest }, read);
    return { state, detail: { streams: String(read.streams.length), events: String(read.events.length) } };
  } catch (error) {
    if (reasonOf(error) === null) throw error;
    return failureOf(error, "RESTORE_STREAM_INVALID");
  }
}

// 5 project.
function projectCheck(projectRoot: string, manifest: Library["manifest"]): Detail | CheckFailure {
  const hint = manifest.project.gitRemote;
  const raw = gitRemoteOf(projectRoot);
  const remote = raw === null ? null : normalizeGitRemote(raw);
  const library = hint === null ? null : normalizeGitRemote(hint);
  if (library !== null && remote !== null && library !== remote) {
    return new CheckFailure("PROJECT_REMOTE_DIFFERS", `the library belongs to the project at ${library}, and this project's remote is ${remote}`, { required: library, actual: remote });
  }
  return { ...(library === null ? {} : { library }), ...(remote === null ? {} : { project: remote }) };
}

// 6 registry.
async function registryCheck(input: RestoreInput, root: string, libraryId: string): Promise<Detail | CheckFailure> {
  let entries;
  try {
    entries = (await readRegistry(input.deviceHome)).entries;
  } catch (error) {
    if (reasonOf(error) === null) throw error;
    return failureOf(error, "LIBRARY_REGISTRY_INVALID");
  }
  const entry = entries.find((candidate) => candidate.projectPath === input.projectRoot);
  if (entry === undefined) return { registered: "false" };
  const bound = { registeredLibrary: entry.libraryPath, registeredId: entry.libraryId };
  if (entry.libraryId !== libraryId) {
    return new CheckFailure("PROJECT_REGISTERED_ELSEWHERE", `this project is registered to ${entry.libraryId} at ${entry.libraryPath}, not to ${libraryId}`, {
      ...bound,
      remedy: "--mode uninstall",
    });
  }
  if (entry.libraryPath === root) return { registered: "true", ...bound };
  // The same library at another place: restoring from here is a move only when that place no longer
  // holds it; otherwise there would be two copies of one library, each written apart.
  let held: string | null = null;
  try {
    const text = await readFileBytes(join(entry.libraryPath, LIBRARY_FILES.manifest), "utf8");
    const parsed: unknown = JSON.parse(text);
    const id = parsed !== null && typeof parsed === "object" ? (parsed as { libraryId?: unknown }).libraryId : undefined;
    held = typeof id === "string" ? id : null;
  } catch {
    held = null;
  }
  if (held === libraryId && await readLibraryTombstone(entry.libraryPath) === null) {
    return new CheckFailure("LIBRARY_COPY_REGISTERED", `this device already uses ${libraryId} at ${entry.libraryPath}; ${root} is another copy of it`, {
      ...bound,
      remedy: "workspace-relocate",
    });
  }
  return { registered: "true", ...bound, moved: "true" };
}

// 7 device-stream: nothing is written here, not even a probe; the directory the stream is written
// in must be one this process may write.
async function deviceStreamCheck(input: RestoreInput, root: string): Promise<{ readonly stream: VerifiedLibrary["deviceStream"]; readonly detail: Detail } | CheckFailure> {
  const tombstone = await readLibraryTombstone(root);
  if (tombstone !== null) {
    return new CheckFailure("LIBRARY_TOMBSTONED", `${root} was moved to ${tombstone.movedTo || "an unrecorded place"}; it only reads`, { movedTo: tombstone.movedTo });
  }
  let deviceId: string | null;
  try {
    deviceId = (await readDevice(input.deviceHome))?.deviceId ?? null;
  } catch (error) {
    if (reasonOf(error) === null) throw error;
    return failureOf(error, "DEVICE_IDENTITY_INVALID");
  }
  const events = join(root, DIRECTORY.events);
  if (await entryKind(events) !== "directory") return new CheckFailure("AKASHA_DIRECTORY_MISSING", `${root} has no ${DIRECTORY.events}/ directory`, { file: DIRECTORY.events });
  let target = events;
  let action: "create" | "reuse" = "create";
  if (deviceId !== null) {
    const stream = join(events, deviceId);
    const kind = await entryKind(stream);
    if (kind === "directory") {
      target = stream;
      action = "reuse";
    } else if (kind !== null) {
      return new CheckFailure("AKASHA_STREAM_NOT_DIRECTORY", `${DIRECTORY.events}/${deviceId} is not a directory`, { deviceId, file: `${DIRECTORY.events}/${deviceId}` });
    }
  }
  try {
    await access(target, constants.W_OK);
  } catch (error) {
    return failureOf(error, "STREAM_DIRECTORY_UNWRITABLE");
  }
  return { stream: { deviceId, action }, detail: { deviceId: deviceId ?? "", action } };
}

// 8 sections.
async function sectionsCheck(projectRoot: string, state: WorkspaceState): Promise<Detail | CheckFailure> {
  const recorded = state.configRecords.filter((record) => record.collection === "managed-section").map((record) => String(record.value.file));
  const files = [...new Set([AGENTS_FILE, CLAUDE_FILE, ...recorded])].sort();
  const diverged: string[] = [];
  for (const file of files) {
    const records = managedSectionRecordsFor(state, file);
    try {
      const plan = await planManagedWrite({ filePath: join(projectRoot, ...file.split("/")), file, desired: [], records });
      for (const id of plan.pending) diverged.push(`${file}#${id}`);
    } catch (error) {
      const cause = reasonOf(error);
      if (cause === null) throw error;
      // A file the writer cannot write disagrees with nothing while the library records no section in it.
      if (cause === "MANAGED_SECTION_FILE_UNSUPPORTED" && records.length === 0) continue;
      return failureOf(error, cause);
    }
  }
  if (diverged.length > 0) {
    return new CheckFailure("MANAGED_SECTION_PENDING", `these managed sections differ from the library's records: ${diverged.join(", ")}`, {
      file: diverged[0]?.split("#")[0] ?? "",
      section: diverged.join(","),
    });
  }
  return { files: files.join(",") };
}

class CheckRun {
  readonly checks: RestoreCheck[] = [];

  pass(check: RestoreCheckName, detail: Detail): void {
    this.checks.push({ item: this.checks.length + 1, check, ok: true, reasonCode: null, detail });
  }

  fail(check: RestoreCheckName, failure: CheckFailure): RestoreVerification["checks"] {
    this.checks.push({
      item: this.checks.length + 1,
      check,
      ok: false,
      reasonCode: RESTORE_CHECK_REASON_CODES[check],
      detail: { ...failure.detail, cause: failure.cause, message: failure.message },
    });
    return this.checks;
  }
}

/**
 * The eight checks of a library before it is restored (R3), in order, up to the first that fails.
 * Nothing is written: not a probe, not a lock, not the device cache.
 */
export async function verifyRestore(input: RestoreInput, options: RestoreReadOptions = {}): Promise<RestoreVerification> {
  const run = new CheckRun();
  const stopped = (check: RestoreCheckName, failure: CheckFailure): RestoreVerification => ({
    ok: false,
    libraryPath: input.libraryPath,
    checks: run.fail(check, failure),
    library: null,
  });
  const snapshot = await readSnapshot(input.libraryPath, options);
  if (snapshot instanceof CheckFailure) return stopped("readable", snapshot);
  run.pass("readable", { path: snapshot.root, files: String(snapshot.files.size) });

  const read = await libraryCheck(snapshot);
  if (read instanceof CheckFailure) return stopped("library", read);
  run.pass("library", read.manifest === null ? {} : { libraryId: read.manifest.libraryId });

  const format = formatCheck(snapshot, read);
  if (format instanceof CheckFailure) return stopped("format", format);
  // A format this engine reads has had its manifest validated by the library check.
  const manifest = read.manifest;
  if (manifest === null) return stopped("format", new CheckFailure("LIBRARY_FORMAT_UNSUPPORTED", `library ${snapshot.root} cannot be judged by engine ${FRAMEWORK_VERSION}`));
  run.pass("format", format);

  const streams = await streamsCheck(snapshot, manifest, options);
  if (streams instanceof CheckFailure) return stopped("streams", streams);
  run.pass("streams", streams.detail);

  const project = projectCheck(input.projectRoot, manifest);
  if (project instanceof CheckFailure) return stopped("project", project);
  run.pass("project", project);

  const registry = await registryCheck(input, snapshot.root, manifest.libraryId);
  if (registry instanceof CheckFailure) return stopped("registry", registry);
  run.pass("registry", registry);

  const device = await deviceStreamCheck(input, snapshot.root);
  if (device instanceof CheckFailure) return stopped("device-stream", device);
  run.pass("device-stream", device.detail);

  const sections = await sectionsCheck(input.projectRoot, streams.state);
  if (sections instanceof CheckFailure) return stopped("sections", sections);
  run.pass("sections", sections);

  return {
    ok: true,
    libraryPath: input.libraryPath,
    checks: run.checks,
    library: { root: snapshot.root, libraryId: manifest.libraryId, state: streams.state, deviceStream: device.stream },
  };
}

/** The refusal of a verification that stopped: the failed check's reason code, with its name, number and cause. */
export function restoreRefusal(verification: RestoreVerification): RestoreError {
  const failed = verification.checks.find((check) => !check.ok);
  if (failed === undefined || failed.reasonCode === null) {
    return new RestoreError("RESTORE_UNREADABLE", `${verification.libraryPath} was not checked`, { check: "readable", item: "1" });
  }
  const { message, ...detail } = failed.detail;
  return new RestoreError(failed.reasonCode, `check ${failed.item} (${failed.check}) stopped the restore: ${message ?? failed.reasonCode}`, {
    ...detail,
    check: failed.check,
    item: String(failed.item),
    library: verification.libraryPath,
  });
}

async function verified(input: RestoreInput): Promise<VerifiedLibrary> {
  const verification = await verifyRestore(input);
  if (!verification.ok || verification.library === null) throw restoreRefusal(verification);
  return verification.library;
}

// ---- The plan and the apply ----

// Where a library to restore usually is: the project's own .ether, or the library this device
// registered for the project.
async function suggestedLibrary(input: SetupModeInput): Promise<string | null> {
  const own = join(input.context.projectRoot, DIRECTORY.library);
  if (await entryKind(join(own, LIBRARY_FILES.manifest)) === "file") return own;
  return input.context.registered?.libraryPath ?? null;
}

function restoreQuestions(input: SetupModeInput, library: string | null, cloud: boolean | null): readonly SetupQuestion[] {
  const questions: SetupQuestion[] = [];
  if (input.options.restore === undefined) questions.push({ id: "restore", flag: "--restore", default: library, choices: null });
  if (input.answers.cloud === undefined) questions.push({ id: "cloud", flag: "--cloud", default: cloud, choices: [true, false] });
  return questions;
}

/**
 * Plan a restore (R3): the eight checks of the library --restore names, then every write of the
 * steps from registry on. A check that fails refuses the plan with its reason code (RestoreError);
 * without --restore the plan names the question and cannot be applied (SETUP_ANSWER_REQUIRED).
 */
export async function planRestoreSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers } = input;
  const { projectRoot, home, deviceHome } = context;
  const recorder = new SetupRecorder(deviceHome, input.at);
  const deviceNavigation = await readDeviceNavigation(recorder, deviceHome);
  const navigation = answers.navigation ?? deviceNavigation !== "declined";

  if (input.options.restore === undefined) {
    const suggested = await suggestedLibrary(input);
    recorder.block("library", projectRoot, "SETUP_ANSWER_REQUIRED", "name the library to restore from with --restore <library path>");
    const artifacts = suggested ?? join(projectRoot, DIRECTORY.library);
    return {
      questions: restoreQuestions(input, suggested, null),
      resolved: { artifacts, cloud: answers.cloud ?? defaultCloud(context, artifacts), language: defaultLanguage(), navigation },
      engine: { version: null, directory: null },
      library: null,
      writes: [],
      backups: [],
      backupDir: null,
      pendingSections: [],
      blockers: recorder.blockers,
    };
  }

  const verification = await verifyRestore({ projectRoot, home, deviceHome, libraryPath: resolve(projectRoot, input.options.restore) });
  if (!verification.ok || verification.library === null) throw restoreRefusal(verification);
  const library = verification.library;

  const engine = await planEngineSource(recorder, deviceHome);
  await planDevice(recorder, deviceHome);
  const cloud = defaultCloud(context, library.root);
  const resolved: ResolvedSetupAnswers = {
    artifacts: library.root,
    cloud: answers.cloud ?? cloud,
    language: libraryLanguage(library.state) ?? defaultLanguage(),
    navigation,
  };
  const pending = await planWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    library: { path: library.root, libraryId: library.libraryId, state: library.state },
    cloud: resolved.cloud,
    navigation: navigationChoice(navigation),
    deviceNavigation,
    engine: engine.directory === null ? null : await readEngineFiles(recorder, engine.directory),
  });
  return {
    questions: restoreQuestions(input, library.root, cloud),
    resolved,
    engine: { version: engine.version, directory: engine.directory },
    library: { path: library.root, action: "reuse", libraryId: library.libraryId },
    writes: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    pendingSections: pending,
    blockers: recorder.blockers,
    warnings: recorder.warnings,
    verification: verification.checks,
  };
}

// The two columns: the library's settings and records for the project, and this device's own keys.
async function restoreColumns(libraryPath: string, deviceHome: string, cloud: boolean): Promise<SetupColumns> {
  const state = await materializeWorkspace(libraryPath);
  const counts = new Map<string, number>();
  for (const record of state.configRecords) counts.set(record.collection, (counts.get(record.collection) ?? 0) + 1);
  const machine = await readMachineSettings(join(deviceHome, MACHINE_SETTINGS_FILE_NAME));
  const flags: Readonly<Record<string, string>> = { "agents.navigation": "--navigation" };
  return {
    project: {
      settings: [...state.settings].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)).map((setting) => ({ key: setting.key, value: setting.value })),
      records: [...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([collection, count]) => ({ collection, count })),
    },
    device: [
      { key: "registry.cloudHosted", value: String(cloud), flag: "--cloud" },
      ...MACHINE_SETTINGS_CATALOG.map((entry) => ({ key: entry.key, value: machine.values[entry.key] ?? null, flag: flags[entry.key] ?? null })),
    ],
  };
}

/**
 * Apply a confirmed restore (R3): the eight checks run again and the first that fails refuses with
 * nothing written; then this device's identity when it has none, and the steps from registry on.
 * SETUP_APPLIED carries the two columns of settings.
 */
export async function applyRestoreSetup(plan: SetupPlan): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome, resolved } = plan;
  const planned = plan.library;
  if (planned === null || planned.libraryId === null) return setupFail("SETUP_INPUT_INVALID", "the plan names no library to restore", { field: "plan" });
  const directory = plan.engine.directory;
  if (directory === null) return setupFail("SETUP_ENGINE_NOT_INSTALLED", "the plan names no engine version directory to install from", { deviceHome });
  const library = await verified({ projectRoot, home, deviceHome, libraryPath: planned.path });
  if (library.libraryId !== planned.libraryId) {
    setupFail("SETUP_LIBRARY_CONFLICT", `${library.root} holds ${library.libraryId}, not the planned ${planned.libraryId}`, { library: library.root });
  }
  const recorder = new SetupRecorder(deviceHome, at);
  const device = await applyDevice(recorder, deviceHome, at);
  const pending = await applyWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    at,
    library: { path: library.root, libraryId: library.libraryId },
    cloud: resolved.cloud,
    navigation: navigationChoice(resolved.navigation),
    engineDirectory: directory,
    actorId: SETUP_ACTOR,
  });
  return setupApplied(plan, recorder, {
    deviceId: device.deviceId,
    library: { path: library.root, libraryId: library.libraryId, created: false },
    pending,
    columns: await restoreColumns(library.root, deviceHome, resolved.cloud),
  });
}
