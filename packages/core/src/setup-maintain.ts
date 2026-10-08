// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-480 R4, AC4 and STORY-478 R6 (MIN-227 D24; TCRN-CROSS-SUB-325): the modes for an
// installation that already runs on this device.
//
//   update     --archive names a release: the file einzbern-<version>.tar.gz with its .sha256 beside
//              it, or the directory einzbern-<version>/ it unpacks to. The plan reads and checks it in
//              memory: the archive's sha256, then the install-tree digest its manifest states. The
//              apply unpacks it into trash/setup-update-<UTC second>/ of the device directory, where it
//              stays, and installs it with engine-update (engine-home.ts), which checks it again, runs
//              it once and makes it current. Then the skill copies, the launchers and the host hooks
//              are laid again from the version now current. No managed section is written: an engine
//              upgrade writes no project file (TCRN-CROSS-STORY-478 R6).
//   rollback   update --rollback true: engine-rollback makes the previous version current again, and
//              the same three steps follow it. Nothing is fetched or unpacked.
//   repair     the steps of a first installation from the registry on, again, for the project's
//              registered library (setup-fresh.ts). Each compares before it writes, so a repair of an
//              installation that is whole writes nothing. The library's settings are not written.
//   uninstall  the Einzbern hook groups taken out of both hosts' user settings, both skill copies and
//              skills.json moved whole into the backups of this run, and the project's registry entry
//              removed once registry.json is copied there, with the registration setup made for the
//              coordination the project names once no other registration names it (STORY-480 R4,
//              project-chain.ts). The libraries are only read, and left exactly as they are.
//              --managed-sections keep, the default, leaves the sections in the project's files;
//              remove takes their markers out and leaves their text, which is the user's from then on
//              (unmanage, agents-sections.ts), without writing the library's records of them.
//
// Nothing is deleted by any of them: what is taken out is moved into the device directory.

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import { AGENTS_FILE, CLAUDE_FILE, disableAgentsSection, resolveSection } from "./agents-sections.js";
import { writeFileAtomic } from "./atomic-file.js";
import { DEVICE_HOME_ENTRIES, backupsPath, ensureDeviceDirectory, registryPath } from "./device-home.js";
import { readDevice } from "./device-identity.js";
import { ENGINE_FILES, engineCurrentPath, engineVersionDirectory, readEngineCurrent, rollbackEngine, updateEngine } from "./engine-home.js";
import type { EngineCurrent, EngineSwitchReport } from "./engine-home.js";
import { openLibrary } from "./ether-library.js";
import { isEngineVersion } from "./format-version.js";
import { utcStamp } from "./host-writable-roots.js";
import { INSTALL_TREE_DIGEST_VERSION, computeInstallTreeDigest, normalizedInstallBytes } from "./install-tree-digest.js";
import { readAgentsNavigation } from "./machine-settings.js";
import type { AgentsNavigationChoice } from "./machine-settings.js";
import { managedSectionRecordsFor, parseManagedFile } from "./managed-sections.js";
import { BRAND, DIRECTORY } from "./names.js";
import { readRegistry, unregisterLibrary } from "./registry.js";
import { coordinationNamedBy, releasableSetupCoordination, releaseSetupCoordination } from "./project-chain.js";
import type { Registry, RegistryEntry } from "./registry.js";
import { SETUP_ACTOR, setupFail } from "./setup.js";
import type {
  ResolvedSetupAnswers,
  SetupAnswers,
  SetupApplied,
  SetupContext,
  SetupCoordination,
  SetupEngineSwitch,
  SetupModeInput,
  SetupModePlan,
  SetupPlan,
  SetupQuestion,
  SetupStep,
} from "./setup.js";
import {
  FRESH_ENGINE_TREE,
  SetupRecorder,
  applyDevice,
  applyHooks,
  applyWiring,
  defaultCloud,
  defaultLanguage,
  entryKind,
  engineVersionSource,
  libraryLanguage,
  navigationChoice,
  planDevice,
  planEngineSource,
  planHooks,
  planWiring,
  readDeviceNavigation,
  readEngineFiles,
  reasonOf,
  setupApplied,
  setupTargetState,
} from "./setup-fresh.js";
import type { EngineFiles, EngineSource, LibraryState } from "./setup-fresh.js";
import { SKILL_COPIES_FILES, SKILL_COPY_ROOTS, skillCopiesRecordPath, skillCopyPath } from "./skill-copies.js";
import { materializeWorkspaceFromGenesis } from "./workspace.js";
import { scopedWorkspaceState } from "./project-scope.js";

// ---- The release an update installs ----

export const RELEASE_REASON_CODES = Object.freeze([
  "INSTALL_ARCHIVE_DIGEST_MISMATCH",
  "INSTALL_ARCHIVE_INVALID",
  "INSTALL_ARCHIVE_UNREADABLE",
  "INSTALL_SHA256_MISSING",
  "INSTALL_TREE_DIGEST_MISMATCH",
] as const);
export type ReleaseReasonCode = typeof RELEASE_REASON_CODES[number];

/** A release an update cannot install; the reason codes are the ones the skill's install.mjs answers. */
export class ReleaseSourceError extends Error {
  readonly reasonCode: ReleaseReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: ReleaseReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ReleaseSourceError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function releaseFail(reasonCode: ReleaseReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new ReleaseSourceError(reasonCode, message, details);
}

const RELEASE_MANIFEST_FILE = "manifest.json";
const RELEASE_MANIFEST_SCHEMA_VERSION = "einzbern.release-manifest.v1";
const DIGEST = /^[0-9a-f]{64}$/u;
const TAR_BLOCK = 512;
// Where an update unpacks a release, in the device directory, as the skill's install.mjs does; it
// is left there.
const STAGING_DIRECTORY = "trash";
// What update and rollback lay again from the version they make current.
const ENGINE_STEPS: ReadonlySet<SetupStep> = new Set<SetupStep>(["skill-copies", "launchers", "host-hooks"]);

interface ReleaseFile {
  // Relative to the version directory, with POSIX separators.
  readonly path: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

interface Release {
  readonly source: string;
  readonly version: string;
  readonly installTreeDigest: string;
  // The version directory's files, manifest.json set aside: the tree its digest is taken over.
  readonly files: readonly ReleaseFile[];
  readonly manifest: Buffer;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The install-tree digest of files held in memory, as computeInstallTreeDigest takes it on disk.
function treeDigest(files: readonly { readonly path: string; readonly bytes: Buffer }[]): string {
  const entries = files.map((file) => {
    const bytes = normalizedInstallBytes(file.bytes);
    return { path: file.path, size: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
  return createHash("sha256").update(canonicalJson({ schemaVersion: INSTALL_TREE_DIGEST_VERSION, entries }), "utf8").digest("hex");
}

function tarText(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function tarOctal(block: Buffer, offset: number, length: number): number {
  const value = tarText(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) releaseFail("INSTALL_ARCHIVE_INVALID", "a tar header holds a field that is not an octal number");
  return Number.parseInt(value, 8);
}

function safePath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\") || path.includes("\u0000") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    releaseFail("INSTALL_ARCHIVE_INVALID", `the archive holds ${JSON.stringify(path)}, a path that leaves the directory it is unpacked into`, { path });
  }
  return path;
}

// The regular files of a ustar archive (the reader of the skill's install.mjs): links, devices and
// extension headers are refused, as are absolute or climbing paths, duplicates, bad checksums and a
// cut archive; directory entries are read past.
function readUstar(archive: Buffer): readonly ReleaseFile[] {
  if (archive.length % TAR_BLOCK !== 0) releaseFail("INSTALL_ARCHIVE_INVALID", "the archive is not a whole number of tar blocks");
  const files: ReleaseFile[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ;) {
    if (offset + TAR_BLOCK > archive.length) releaseFail("INSTALL_ARCHIVE_INVALID", "the archive ends before its end-of-archive blocks");
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (archive.length - offset < 2 * TAR_BLOCK || !archive.subarray(offset).every((byte) => byte === 0)) {
        releaseFail("INSTALL_ARCHIVE_INVALID", "the archive does not end in two zero blocks");
      }
      return files;
    }
    let sum = 0;
    for (let index = 0; index < TAR_BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
    if (tarOctal(header, 148, 8) !== sum) releaseFail("INSTALL_ARCHIVE_INVALID", "a tar header's checksum does not match its bytes");
    if (tarText(header, 257, 6) !== "ustar" || header[262] !== 0) releaseFail("INSTALL_ARCHIVE_INVALID", "a header is not a ustar header");
    const prefix = tarText(header, 345, 155);
    const name = prefix === "" ? tarText(header, 0, 100) : `${prefix}/${tarText(header, 0, 100)}`;
    const type = String.fromCharCode(header[156] ?? 0);
    const size = tarOctal(header, 124, 12);
    const start = offset + TAR_BLOCK;
    if (start + size > archive.length) releaseFail("INSTALL_ARCHIVE_INVALID", `${name} is cut short`, { path: name });
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === "5") {
      safePath(name.endsWith("/") ? name.slice(0, -1) : name);
      continue;
    }
    if (type !== "0" && type !== "\u0000") releaseFail("INSTALL_ARCHIVE_INVALID", `${name} is a tar entry of type ${JSON.stringify(type)}; only files are unpacked`, { path: name });
    const path = safePath(name);
    if (seen.has(path)) releaseFail("INSTALL_ARCHIVE_INVALID", `${path} is in the archive twice`, { path });
    seen.add(path);
    files.push({ path, mode: tarOctal(header, 100, 8) & 0o777, bytes: archive.subarray(start, start + size) });
  }
}

// The release's manifest checked, the tree it states the digest of, and the files setup installs from.
function checkedRelease(source: string, version: string, files: readonly ReleaseFile[]): Release {
  const manifestFile = files.find((file) => file.path === RELEASE_MANIFEST_FILE);
  let manifest: unknown = null;
  try {
    manifest = manifestFile === undefined ? null : JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    manifest = null;
  }
  const record = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) ? manifest as Readonly<Record<string, unknown>> : {};
  const stated = record.installTreeDigest;
  if (manifestFile === undefined || record.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION || record.version !== version || typeof stated !== "string" || !DIGEST.test(stated)) {
    releaseFail("INSTALL_ARCHIVE_INVALID", `the release's ${RELEASE_MANIFEST_FILE} is not an ${RELEASE_MANIFEST_SCHEMA_VERSION} manifest for ${version}`, { path: RELEASE_MANIFEST_FILE });
  }
  const tree = files.filter((file) => file.path !== RELEASE_MANIFEST_FILE);
  const required = [ENGINE_FILES.entry, ...FRESH_ENGINE_TREE.launchers.map((launcher) => launcher.from), `${FRESH_ENGINE_TREE.skill}/${FRESH_ENGINE_TREE.skillEntry}`];
  for (const path of required) {
    if (!tree.some((file) => file.path === path)) releaseFail("INSTALL_ARCHIVE_INVALID", `the release holds no ${path}`, { path });
  }
  const actual = treeDigest(tree);
  if (actual !== stated) releaseFail("INSTALL_TREE_DIGEST_MISMATCH", `${source} does not hash as its manifest states`, { required: stated, actual });
  return { source, version, installTreeDigest: stated, files: tree, manifest: manifestFile.bytes };
}

async function releaseFromArchive(source: string): Promise<Release> {
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch (error) {
    return releaseFail("INSTALL_ARCHIVE_UNREADABLE", `${source} cannot be read (${String((error as { code?: string }).code ?? "error")})`, { file: source });
  }
  let stated: string;
  try {
    stated = await readFile(`${source}.sha256`, "utf8");
  } catch {
    return releaseFail("INSTALL_SHA256_MISSING", `${source}.sha256 cannot be read: an archive is installed only with the sha256 it was published with`, { file: `${source}.sha256` });
  }
  const expected = stated.trim().split(/\s+/u)[0] ?? "";
  if (!DIGEST.test(expected)) releaseFail("INSTALL_SHA256_MISSING", `${source}.sha256 does not state a sha256`, { file: `${source}.sha256` });
  const actual = sha256(bytes);
  if (actual !== expected) releaseFail("INSTALL_ARCHIVE_DIGEST_MISMATCH", `${source} does not have the sha256 it was published with`, { required: expected, actual });
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes);
  } catch {
    return releaseFail("INSTALL_ARCHIVE_INVALID", "the archive is not gzip data", { file: source });
  }
  const entries = readUstar(tar);
  const top = entries[0]?.path.split("/")[0] ?? "";
  const version = top.startsWith(`${BRAND.engine.id}-`) ? top.slice(BRAND.engine.id.length + 1) : "";
  if (!isEngineVersion(version) || !entries.every((entry) => entry.path.startsWith(`${top}/`))) {
    releaseFail("INSTALL_ARCHIVE_INVALID", `the archive is not one ${BRAND.engine.id}-<version>/ directory`, { file: source });
  }
  return checkedRelease(source, version, entries.map((entry) => ({ ...entry, path: entry.path.slice(top.length + 1) })));
}

async function releaseFromDirectory(source: string): Promise<Release> {
  const files: ReleaseFile[] = [];
  async function walk(relativePath: string): Promise<void> {
    const directory = relativePath === "" ? source : join(source, ...relativePath.split("/"));
    for (const name of (await readdir(directory)).sort(compareCanonicalText)) {
      const path = relativePath === "" ? name : `${relativePath}/${name}`;
      const absolute = join(source, ...path.split("/"));
      const stats = await lstat(absolute);
      if (stats.isDirectory()) await walk(path);
      else if (stats.isFile()) files.push({ path, mode: stats.mode & 0o777, bytes: await readFile(absolute) });
      else releaseFail("INSTALL_ARCHIVE_INVALID", `${path} is not a regular file`, { path });
    }
  }
  await walk("");
  let version: unknown = null;
  try {
    const manifest: unknown = JSON.parse(files.find((file) => file.path === RELEASE_MANIFEST_FILE)?.bytes.toString("utf8") ?? "null");
    version = manifest !== null && typeof manifest === "object" ? (manifest as { version?: unknown }).version : null;
  } catch {
    version = null;
  }
  if (!isEngineVersion(version)) releaseFail("INSTALL_ARCHIVE_INVALID", `${source} holds no release ${RELEASE_MANIFEST_FILE} naming its version`, { file: source });
  return checkedRelease(source, version, files);
}

/** A release to install: the archive einzbern-<version>.tar.gz (its .sha256 beside it), or the directory it unpacks to. Nothing is written. */
async function readRelease(source: string): Promise<Release> {
  let stats: Stats;
  try {
    stats = await lstat(source);
  } catch (error) {
    return releaseFail("INSTALL_ARCHIVE_UNREADABLE", `${source} cannot be read (${String((error as { code?: string }).code ?? "error")})`, { file: source });
  }
  if (stats.isDirectory()) return releaseFromDirectory(source);
  if (!stats.isFile()) releaseFail("INSTALL_ARCHIVE_INVALID", `${source} is neither a release archive nor an unpacked release`, { file: source });
  return releaseFromArchive(source);
}

// What the skill copies and the launchers of a release would be: the skill tree's digest and the launchers' bytes.
function releaseEngineFiles(release: Release): EngineFiles {
  const prefix = `${FRESH_ENGINE_TREE.skill}/`;
  const skill = release.files.filter((file) => file.path.startsWith(prefix)).map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes }));
  return {
    skillDigest: treeDigest(skill),
    launchers: FRESH_ENGINE_TREE.launchers.map((launcher) => ({ name: launcher.name, bytes: release.files.find((file) => file.path === launcher.from)?.bytes ?? Buffer.alloc(0) })),
  };
}

// Where this run unpacks a release: trash/setup-update-<UTC second> of the device directory, or the
// first free name after it.
async function stagingDirectory(deviceHome: string, at: string): Promise<string> {
  const base = join(deviceHome, STAGING_DIRECTORY, `setup-update-${utcStamp(at)}`);
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (await entryKind(candidate) === null) return candidate;
  }
}

// Unpack the release under `staging`: the version directory, and its manifest beside it.
async function stageRelease(release: Release, staging: string): Promise<string> {
  const tree = join(staging, `${BRAND.engine.id}-${release.version}`);
  for (const file of release.files) {
    const target = join(tree, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: file.mode });
  }
  await writeFile(join(staging, RELEASE_MANIFEST_FILE), release.manifest);
  return tree;
}

async function treeDigestOrNull(path: string): Promise<string | null> {
  try {
    return (await computeInstallTreeDigest(path)).sha256;
  } catch (error) {
    if (reasonOf(error) !== null || typeof (error as { code?: unknown }).code === "string") return null;
    throw error;
  }
}

// ---- What the maintenance modes read ----

async function currentEngine(recorder: SetupRecorder, deviceHome: string): Promise<EngineCurrent | null> {
  return recorder.attempt("engine", engineCurrentPath(deviceHome), () => readEngineCurrent(deviceHome));
}

// The registered library's settings and records, for the answers; null when it does not open.
async function registeredState(entry: RegistryEntry | null): Promise<LibraryState | null> {
  if (entry === null) return null;
  try {
    return scopedWorkspaceState(await materializeWorkspaceFromGenesis(entry.libraryPath), entry.projectId);
  } catch (error) {
    if (reasonOf(error) === null) throw error;
    return null;
  }
}

// The answers of an installation that is there: the registered library and its cloud flag, the
// library's language and this device's navigation choice, unless given.
function maintainedAnswers(context: SetupContext, answers: SetupAnswers, state: LibraryState | null, deviceNavigation: AgentsNavigationChoice | null): ResolvedSetupAnswers {
  const artifacts = context.registered?.libraryPath ?? join(context.projectRoot, DIRECTORY.library);
  return {
    artifacts,
    cloud: answers.cloud ?? defaultCloud(context, artifacts),
    language: (state === null ? null : libraryLanguage(state)) ?? defaultLanguage(),
    navigation: answers.navigation ?? deviceNavigation !== "declined",
  };
}

function registeredLibrary(context: SetupContext): SetupModePlan["library"] {
  const entry = context.registered;
  return entry === null ? null : { path: entry.libraryPath, action: "reuse", libraryId: entry.libraryId };
}

function appliedLibrary(plan: SetupPlan): SetupApplied["library"] {
  const library = plan.library;
  return library === null || library.libraryId === null ? null : { path: library.path, libraryId: library.libraryId, created: false };
}

function planResult(recorder: SetupRecorder, parts: Pick<SetupModePlan, "questions" | "resolved" | "engine" | "library" | "pendingSections"> & { readonly engineSwitch?: SetupEngineSwitch; readonly coordination?: SetupCoordination | null }): SetupModePlan {
  return {
    ...parts,
    writes: recorder.writes,
    backups: recorder.backups,
    backupDir: recorder.backups.length > 0 ? recorder.backupRoot : null,
    blockers: recorder.blockers,
    warnings: recorder.warnings,
  };
}

// ---- update and rollback ----

interface EngineTarget {
  readonly engine: EngineSource;
  readonly files: EngineFiles | null;
  readonly engineSwitch: SetupEngineSwitch;
}

async function planRollback(recorder: SetupRecorder, deviceHome: string, current: EngineCurrent | null): Promise<EngineTarget | null> {
  const pointer = engineCurrentPath(deviceHome);
  if (current === null) {
    recorder.block("engine", pointer, "ENGINE_ROLLBACK_UNAVAILABLE", "no engine version is current on this device");
    return null;
  }
  if (current.previous === null) {
    recorder.block("engine", pointer, "ENGINE_ROLLBACK_UNAVAILABLE", `${current.version} is current and there is no previous version to go back to`);
    return null;
  }
  const directory = engineVersionDirectory(current.previous, deviceHome);
  if (await entryKind(directory) !== "directory") {
    recorder.block("engine", directory, "ENGINE_ROLLBACK_UNAVAILABLE", `the previous version ${current.previous} is no longer installed`);
    return null;
  }
  const engine = await engineVersionSource(recorder, current.previous, directory);
  recorder.write("engine", pointer, "update");
  return {
    engine,
    files: engine.directory === null ? null : await readEngineFiles(recorder, engine.directory),
    engineSwitch: { source: null, from: current.version, to: current.previous, installTreeDigest: null },
  };
}

async function planRelease(recorder: SetupRecorder, input: SetupModeInput, source: string, current: EngineCurrent | null): Promise<EngineTarget | null> {
  const { deviceHome } = input.context;
  const release = await recorder.attempt("engine", source, () => readRelease(source));
  if (release === null) return null;
  const directory = engineVersionDirectory(release.version, deviceHome);
  recorder.write("engine", await stagingDirectory(deviceHome, input.at), "create");
  const kind = await entryKind(directory);
  if (kind === null) {
    recorder.write("engine", directory, "create");
  } else if (kind !== "directory" || await treeDigestOrNull(directory) !== release.installTreeDigest) {
    recorder.block("engine", directory, "ENGINE_VERSION_CONFLICT", `${directory} already holds a ${release.version} with other bytes`);
  }
  const pointer = engineCurrentPath(deviceHome);
  recorder.write("engine", pointer, await entryKind(pointer) === null ? "create" : "update");
  return {
    engine: { version: release.version, directory },
    files: releaseEngineFiles(release),
    engineSwitch: { source, from: current?.version ?? null, to: release.version, installTreeDigest: release.installTreeDigest },
  };
}

/**
 * Plan an update (R4): the release --archive names, read and checked in memory, or with --rollback
 * true the previous version; then what the skill copies, the launchers and the host hooks would
 * become. Nothing is written, and no managed section is planned.
 */
export async function planUpdateSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers, options } = input;
  const { projectRoot, home, deviceHome } = context;
  if (options.rollback === true && options.archive !== undefined) {
    setupFail("SETUP_INPUT_INVALID", "a rollback installs nothing: give --rollback true without --archive", { field: "rollback" });
  }
  const recorder = new SetupRecorder(deviceHome, input.at);
  const current = await currentEngine(recorder, deviceHome);
  let target: EngineTarget | null = null;
  const questions: SetupQuestion[] = [];
  if (options.rollback === true) {
    target = await planRollback(recorder, deviceHome, current);
  } else if (options.archive !== undefined) {
    target = await planRelease(recorder, input, resolve(projectRoot, options.archive), current);
  } else {
    questions.push({ id: "archive", flag: "--archive", default: null, choices: null });
    recorder.block("engine", projectRoot, "SETUP_ANSWER_REQUIRED", "name the release to update from with --archive <local archive>, or roll back with --rollback true");
  }
  const deviceNavigation = await readDeviceNavigation(recorder, deviceHome);
  await planWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    library: null,
    cloud: false,
    navigation: navigationChoice(deviceNavigation !== "declined"),
    deviceNavigation,
    engine: target?.files ?? null,
    steps: ENGINE_STEPS,
  });
  return planResult(recorder, {
    questions,
    resolved: maintainedAnswers(context, answers, await registeredState(context.registered), deviceNavigation),
    engine: target?.engine ?? { version: current?.version ?? null, directory: null },
    library: registeredLibrary(context),
    pendingSections: [],
    ...(target === null ? {} : { engineSwitch: target.engineSwitch }),
  });
}

/**
 * Apply an update or a rollback (R4): the release is read and checked again, unpacked and installed
 * through engine-update, or engine-rollback makes the previous version current; then the skill
 * copies, the launchers and the host hooks are laid from the version now current.
 */
export async function applyUpdateSetup(plan: SetupPlan): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome } = plan;
  const planned = plan.engineSwitch;
  if (planned === undefined) return setupFail("SETUP_INPUT_INVALID", "the plan names no engine version to switch to", { field: "plan" });
  const recorder = new SetupRecorder(deviceHome, at);
  let before: EngineCurrent | null = null;
  try {
    before = await readEngineCurrent(deviceHome);
  } catch (error) {
    // A damaged pointer is replaced by an update; there is no version to name as the one before.
    if (reasonOf(error) === null) throw error;
  }
  let report: EngineSwitchReport;
  if (planned.source === null) {
    report = await rollbackEngine({ at, home: deviceHome });
    recorder.write("engine", engineCurrentPath(deviceHome), "update");
  } else {
    const release = await readRelease(planned.source);
    if (release.version !== planned.to || release.installTreeDigest !== planned.installTreeDigest) {
      setupFail("SETUP_INPUT_INVALID", `${planned.source} is not the release the plan was made for`, { field: "archive" });
    }
    const staging = await stagingDirectory(deviceHome, at);
    const tree = await stageRelease(release, staging);
    recorder.write("engine", staging, "create");
    const pointer = await entryKind(engineCurrentPath(deviceHome));
    report = await updateEngine({ from: tree, sha256: release.installTreeDigest, version: release.version, at, home: deviceHome });
    if (report.installed === "copied") recorder.write("engine", engineVersionDirectory(release.version, deviceHome), "create");
    recorder.write("engine", engineCurrentPath(deviceHome), pointer === null ? "create" : "update");
  }
  const deviceNavigation = await readAgentsNavigation(deviceHome);
  await applyWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    at,
    library: null,
    cloud: plan.resolved.cloud,
    navigation: navigationChoice(deviceNavigation !== "declined"),
    engineDirectory: engineVersionDirectory(report.current.version, deviceHome),
    steps: ENGINE_STEPS,
  });
  return setupApplied(plan, recorder, {
    deviceId: (await readDevice(deviceHome))?.deviceId ?? null,
    library: appliedLibrary(plan),
    pending: [],
    engineSwitch: {
      source: planned.source,
      from: before?.version ?? null,
      to: report.current.version,
      installTreeDigest: planned.installTreeDigest,
      reasonCode: report.reasonCode,
      installed: report.installed ?? null,
      incompatible: report.incompatible,
    },
  });
}

// ---- repair ----

// The project's registered library, opened and replayed; each thing that stops it is a blocker.
async function repairLibrary(recorder: SetupRecorder, context: SetupContext): Promise<{ readonly path: string; readonly libraryId: string; readonly state: LibraryState } | null> {
  const entry = context.registered;
  if (entry === null) {
    recorder.block("registry", registryPath(context.deviceHome), context.registryReadable ? "LIBRARY_NOT_REGISTERED" : "LIBRARY_REGISTRY_INVALID",
      "this device has no library registered for the project: install it with setup --mode fresh, or restore its library with setup --mode restore");
    return null;
  }
  const opened = await recorder.attempt("library", entry.libraryPath, () => openLibrary(entry.libraryPath));
  if (opened === null) return null;
  if (opened.manifest.libraryId !== entry.libraryId) {
    recorder.block("library", entry.libraryPath, "SETUP_LIBRARY_CONFLICT", `${entry.libraryPath} holds ${opened.manifest.libraryId}, not the registered ${entry.libraryId}`);
    return null;
  }
  const state = await recorder.attempt("library", entry.libraryPath, () => setupTargetState(context.projectRoot, entry.libraryPath, context.deviceHome));
  return state === null ? null : { path: opened.root, libraryId: entry.libraryId, state };
}

function answerQuestions(input: SetupModeInput, resolved: ResolvedSetupAnswers): readonly SetupQuestion[] {
  const questions: SetupQuestion[] = [];
  if (input.answers.cloud === undefined) questions.push({ id: "cloud", flag: "--cloud", default: resolved.cloud, choices: [true, false] });
  if (input.answers.navigation === undefined) questions.push({ id: "navigation", flag: "--navigation", default: resolved.navigation, choices: [true, false] });
  return questions;
}

async function planChangedNavigationRemoval(
  recorder: SetupRecorder,
  projectRoot: string,
  library: { readonly path: string; readonly state: LibraryState } | null,
  deviceNavigation: AgentsNavigationChoice | null,
  navigation: boolean,
  pending: readonly { readonly file: string; readonly id: string }[],
): Promise<readonly { readonly file: string; readonly id: string }[]> {
  const navigationSection = { file: AGENTS_FILE, id: "navigation" };
  if (deviceNavigation !== "written" || navigation || library === null) return pending;
  const records = managedSectionRecordsFor(library.state, AGENTS_FILE);
  const record = records.find((entry) => entry.id === navigationSection.id);
  if (record?.state === "pending") {
    return pending.some((section) => section.file === AGENTS_FILE && section.id === "navigation") ? pending : [...pending, navigationSection];
  }
  if (record?.state !== "managed") return pending;
  const filePath = join(projectRoot, AGENTS_FILE);
  if (await entryKind(filePath) !== "file") return pending;
  const source = await recorder.attempt("managed-sections", filePath, () => readFile(filePath, "utf8"));
  if (source === null) return pending;
  const parsed = await recorder.attempt("managed-sections", filePath, async () => parseManagedFile(source, AGENTS_FILE));
  if (parsed === null) return pending;
  const section = parsed.sections.find((entry) => entry.id === navigationSection.id);
  if (section === undefined) return pending;
  if (section.digest !== section.bodyDigest || section.digest !== record.digest) {
    return pending.some((entry) => entry.file === AGENTS_FILE && entry.id === "navigation") ? pending : [...pending, navigationSection];
  }
  recorder.write("managed-sections", filePath, "update");
  recorder.backup("managed-sections", filePath);
  recorder.write("library", library.path, "update");
  return pending;
}

async function applyChangedNavigationRemoval(
  plan: SetupPlan,
  recorder: SetupRecorder,
  libraryPath: string,
  pending: readonly { readonly file: string; readonly id: string }[],
  removeNavigation: boolean,
): Promise<readonly { readonly file: string; readonly id: string }[]> {
  if (!removeNavigation) return pending;
  const entry = (await readRegistry(plan.deviceHome)).entries.find(candidate => candidate.projectPath === plan.projectRoot);
  const state = await setupTargetState(plan.projectRoot, libraryPath, plan.deviceHome);
  const record = managedSectionRecordsFor(state, AGENTS_FILE).find((entry) => entry.id === "navigation");
  if (record?.state === "pending") {
    return pending.some((section) => section.file === AGENTS_FILE && section.id === "navigation")
      ? pending
      : [...pending, { file: AGENTS_FILE, id: "navigation" }];
  }
  if (record?.state !== "managed") return pending;
  const filePath = join(plan.projectRoot, AGENTS_FILE);
  if (await entryKind(filePath) !== "file") return pending;
  const parsed = parseManagedFile(await readFile(filePath, "utf8"), AGENTS_FILE);
  const section = parsed.sections.find((entry) => entry.id === "navigation");
  if (section === undefined) return pending;
  if (section.digest !== section.bodyDigest || section.digest !== record.digest) {
    return pending.some((entry) => entry.file === AGENTS_FILE && entry.id === "navigation")
      ? pending
      : [...pending, { file: AGENTS_FILE, id: "navigation" }];
  }
  try {
    const { change } = await disableAgentsSection(libraryPath, {
      projectRoot: plan.projectRoot,
      ...(entry?.projectId === undefined ? {} : { configurationProjectId: entry.projectId }),
      id: "navigation",
      occurredAt: plan.at,
      backupRoot: backupsPath(plan.deviceHome),
      actorId: SETUP_ACTOR,
    });
    if (change.written) {
      recorder.write("managed-sections", join(plan.projectRoot, AGENTS_FILE), "update");
      recorder.backup("managed-sections", join(plan.projectRoot, AGENTS_FILE));
    }
    if (change.recordChanged) recorder.write("library", libraryPath, "update");
    return pending;
  } catch (error) {
    if (reasonOf(error) !== "MANAGED_SECTION_FORCE_REQUIRED") throw error;
    return pending.some((section) => section.file === AGENTS_FILE && section.id === "navigation")
      ? pending
      : [...pending, { file: AGENTS_FILE, id: "navigation" }];
  }
}

/**
 * Plan a repair (R4): the steps of a first installation from the registry on, for the project's
 * registered library, with this device's identity first when it has none. Nothing is written; a
 * repair of a whole installation plans no write.
 */
export async function planRepairSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers } = input;
  const { projectRoot, home, deviceHome } = context;
  const recorder = new SetupRecorder(deviceHome, input.at);
  const engine = await planEngineSource(recorder, deviceHome);
  const deviceNavigation = await readDeviceNavigation(recorder, deviceHome);
  const library = await repairLibrary(recorder, context);
  await planDevice(recorder, deviceHome);
  const resolved = maintainedAnswers(context, answers, library?.state ?? null, deviceNavigation);
  let pending = library === null ? [] : await planWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    library,
    cloud: resolved.cloud,
    navigation: navigationChoice(resolved.navigation),
    deviceNavigation,
    engine: engine.directory === null ? null : await readEngineFiles(recorder, engine.directory),
  });
  pending = await planChangedNavigationRemoval(recorder, projectRoot, library, deviceNavigation, resolved.navigation, pending);
  return planResult(recorder, {
    questions: answerQuestions(input, resolved),
    resolved,
    engine,
    library: library === null ? registeredLibrary(context) : { path: library.path, action: "reuse", libraryId: library.libraryId },
    pendingSections: pending,
  });
}

/** Apply a repair (R4): each step compares before it writes, so a second repair writes nothing. */
export async function applyRepairSetup(plan: SetupPlan): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome, resolved } = plan;
  const directory = plan.engine.directory;
  if (directory === null) return setupFail("SETUP_ENGINE_NOT_INSTALLED", "the plan names no engine version directory to install from", { deviceHome });
  const planned = plan.library;
  if (planned === null || planned.libraryId === null) return setupFail("SETUP_INPUT_INVALID", "the plan names no registered library", { field: "plan" });
  const library = await openLibrary(planned.path);
  if (library.manifest.libraryId !== planned.libraryId) {
    setupFail("SETUP_LIBRARY_CONFLICT", `${library.root} holds ${library.manifest.libraryId}, not the registered ${planned.libraryId}`, { library: library.root });
  }
  const recorder = new SetupRecorder(deviceHome, at);
  const device = await applyDevice(recorder, deviceHome, at);
  const removeNavigation = plan.answers.navigation === false && await readAgentsNavigation(deviceHome) === "written";
  let pending = await applyWiring(recorder, {
    projectRoot,
    home,
    deviceHome,
    at,
    library: { path: library.root, libraryId: planned.libraryId },
    cloud: resolved.cloud,
    navigation: navigationChoice(resolved.navigation),
    engineDirectory: directory,
    actorId: SETUP_ACTOR,
  });
  pending = await applyChangedNavigationRemoval(plan, recorder, planned.path, pending, removeNavigation);
  return setupApplied(plan, recorder, { deviceId: device.deviceId, library: appliedLibrary(plan), pending });
}

// ---- uninstall ----

// Where uninstall moves a skill copy or skills.json: the backups of this run, laid out as
// installSkillCopies lays the copies it replaces.
function skillCopyBackup(recorder: SetupRecorder, root: string): string {
  return join(recorder.backupDirectory("skill-copies"), ...root.split("/"), BRAND.helper.id);
}

// The managed sections a project file holds; a file that is absent, or not a regular file the
// section writer writes, holds none.
async function sectionsIn(path: string, file: string): Promise<readonly string[]> {
  if (await entryKind(path) !== "file") return [];
  const text = await readFile(path, "utf8");
  return parseManagedFile(text, file).sections.map((section) => section.id);
}

function managedSectionsChoice(input: SetupModeInput): "keep" | "remove" {
  return input.options.managedSections ?? "keep";
}

// TCRN-CROSS-INIT-053 R46 (I08): where this device registers coordination `libraryId`, setup's own
// registration of it first; null when it registers it nowhere.
function coordinationLocation(registry: Registry, libraryId: string): string | null {
  const entries = registry.entries.filter((entry) => entry.libraryId === libraryId);
  return (entries.find((entry) => entry.chainRole === "coordination" && entry.projectPath === entry.libraryPath) ?? entries[0])?.libraryPath ?? null;
}

// The coordination an uninstall releases or retains with the project registered as `registered`,
// judged without writing on `registry` as it will stand once that entry is out, by the rule the apply
// releases by (releasableSetupCoordination). Null when the project's library names no coordination
// (unclassified) or does not read.
async function uninstallCoordination(registry: Registry, registered: RegistryEntry): Promise<SetupCoordination | null> {
  const named = await coordinationNamedBy(registered.libraryPath);
  if (typeof named !== "string") return null;
  const remaining: Registry = { ...registry, entries: registry.entries.filter((entry) => entry.projectPath !== registered.projectPath) };
  const released = await releasableSetupCoordination(remaining, named);
  return released.length > 0
    ? { libraryId: named, status: "released", path: released[0]!.libraryPath }
    : { libraryId: named, status: "retained", path: coordinationLocation(remaining, named) };
}

/**
 * Plan an uninstall (R4): the hook groups that come out of both hosts' user settings, the skill
 * copies and skills.json that move into the backups, the registry entry that is removed and, with
 * --managed-sections remove, the project files whose section markers come out. A library is only
 * read, to know which coordination it names, and never written.
 */
export async function planUninstallSetup(input: SetupModeInput): Promise<SetupModePlan> {
  const { context, answers } = input;
  const { projectRoot, home, deviceHome } = context;
  const recorder = new SetupRecorder(deviceHome, input.at);
  const choice = managedSectionsChoice(input);

  await planHooks(recorder, home, deviceHome, null, false);
  for (const root of SKILL_COPY_ROOTS) {
    const path = skillCopyPath(home, root);
    if (await entryKind(path) === null) continue;
    recorder.write("skill-copies", path, "move");
    recorder.backup("skill-copies", path);
  }
  const record = skillCopiesRecordPath(deviceHome);
  if (await entryKind(record) !== null) {
    recorder.write("skill-copies", record, "move");
    recorder.backup("skill-copies", record);
  }
  if (context.registered !== null) {
    recorder.write("registry", registryPath(deviceHome), "update");
    recorder.backup("registry", registryPath(deviceHome));
  }
  if (choice === "remove") {
    for (const file of [AGENTS_FILE, CLAUDE_FILE]) {
      const path = join(projectRoot, file);
      const sections = await recorder.attempt("managed-sections", path, () => sectionsIn(path, file));
      if (sections === null || sections.length === 0) continue;
      recorder.write("managed-sections", path, "update");
      recorder.backup("managed-sections", path);
    }
  }
  const questions: SetupQuestion[] = input.options.managedSections === undefined
    ? [{ id: "managedSections", flag: "--managed-sections", default: "keep", choices: ["keep", "remove"] }]
    : [];
  return planResult(recorder, {
    questions,
    resolved: maintainedAnswers(context, answers, await registeredState(context.registered), await readAgentsNavigation(deviceHome).catch(() => null)),
    engine: { version: null, directory: null },
    library: registeredLibrary(context),
    pendingSections: [],
    coordination: context.registered === null ? null : await uninstallCoordination(await readRegistry(deviceHome), context.registered),
  });
}

// Move an entry into its backup; one already there is never overwritten.
async function moveIntoBackup(from: string, to: string): Promise<void> {
  if (await entryKind(to) !== null) setupFail("SETUP_TARGET_UNSUPPORTED", `${to} already exists; a backup is never overwritten`, { path: to });
  await ensureDeviceDirectory(dirname(to));
  await rename(from, to);
}

/**
 * Apply an uninstall (R4, AC4): the hooks come out, the skill copies and skills.json move into the
 * backups of this run, and the registry entry goes once registry.json is copied there, and with it
 * the registration setup made for the coordination the project's library names, once no other
 * registration names that coordination (releaseSetupCoordination). Libraries are only read, so
 * their trees are as they were; with --managed-sections remove the section markers come out of the
 * project's files and their text stays.
 */
export async function applyUninstallSetup(plan: SetupPlan): Promise<SetupApplied> {
  const { at, projectRoot, home, deviceHome } = plan;
  const recorder = new SetupRecorder(deviceHome, at);

  await applyHooks(recorder, { home, deviceHome, at, navigation: null, install: false });
  for (const root of SKILL_COPY_ROOTS) {
    const path = skillCopyPath(home, root);
    if (await entryKind(path) === null) continue;
    await moveIntoBackup(path, skillCopyBackup(recorder, root.root));
    recorder.write("skill-copies", path, "move");
    recorder.backup("skill-copies", path);
  }
  const record = skillCopiesRecordPath(deviceHome);
  if (await entryKind(record) !== null) {
    await moveIntoBackup(record, join(recorder.backupDirectory("skill-copies"), SKILL_COPIES_FILES.record));
    recorder.write("skill-copies", record, "move");
    recorder.backup("skill-copies", record);
  }
  const registryFile = registryPath(deviceHome);
  const registered = (await readRegistry(deviceHome)).entries.find((entry) => entry.projectPath === projectRoot);
  let binding: SetupCoordination | null = null;
  if (registered !== undefined) {
    const copy = join(recorder.backupDirectory("registry"), DEVICE_HOME_ENTRIES.registry);
    if (await entryKind(copy) === null) {
      await ensureDeviceDirectory(dirname(copy));
      await writeFileAtomic(copy, await readFile(registryFile));
    }
    // The coordination this project's library names (none when it is unclassified or does not read).
    const coordination = await coordinationNamedBy(registered.libraryPath);
    await unregisterLibrary(projectRoot, deviceHome);
    if (typeof coordination === "string") {
      // TCRN-CROSS-INIT-053 R46 (I08): the receipt says whether setup's registration of it went.
      const released = await releaseSetupCoordination(coordination, deviceHome);
      binding = released.length > 0
        ? { libraryId: coordination, status: "released", path: released[0]!.libraryPath }
        : { libraryId: coordination, status: "retained", path: coordinationLocation(await readRegistry(deviceHome), coordination) };
    }
    recorder.write("registry", registryFile, "update");
    recorder.backup("registry", registryFile);
  }
  if ((plan.options.managedSections ?? "keep") === "remove") {
    for (const file of [AGENTS_FILE, CLAUDE_FILE]) {
      const path = join(projectRoot, file);
      let written = false;
      for (const id of await sectionsIn(path, file)) {
        const change = await resolveSection({ projectRoot, id, action: "unmanage", records: [], at, backupRoot: backupsPath(deviceHome) });
        written ||= change.written;
      }
      if (!written) continue;
      recorder.write("managed-sections", path, "update");
      recorder.backup("managed-sections", path);
    }
  }
  return setupApplied(plan, recorder, {
    deviceId: (await readDevice(deviceHome))?.deviceId ?? null,
    library: appliedLibrary(plan),
    pending: [],
    coordination: binding,
  });
}
