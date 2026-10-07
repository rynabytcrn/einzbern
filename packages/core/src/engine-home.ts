import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-471 R2, R3 and STORY-469 R3 (MIN-227 D22, D23): the engine versions installed on
// this device, in engine/ of the device directory:
//
//   engine/<version>/    one whole engine per version, as it was unpacked and checked
//   engine/current       the version in use and the one before it (einzbern.engine-current.v1)
//   engine/einzbern.mjs  the stable entry (scripts/einzbern-launcher.mjs): every hook and registry
//                        pointer names this file and never a version directory
//
// Switching versions rewrites engine/current alone, atomically, so a host's settings.json or
// hooks.json never changes when the engine does. The pointer is a file on every platform, so
// nothing here needs a symbolic link (Windows).
//
// engine-update installs a version from a directory that is already unpacked, checked against the
// install-tree digest its publisher stated (specs/release-trust-v1.md); fetching it is the
// installer's job, and the engine never reaches the network. Before a version becomes current it
// runs once (engine-list) to prove that it starts, that it is the version it was installed as, and
// which library format it reads; after the switch every library in this device's registry is
// checked against it. engine-rollback makes the previous version current again. Installing,
// switching and rolling back hold the device's engine lock, so two of them never interleave.

import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { cp, lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { ATOMIC_TEMPORARY_PREFIX, writeFileAtomic } from "./atomic-file.js";
import { DEVICE_HOME_ENTRIES, deviceHome, engineRoot, ensureDeviceDirectory } from "./device-home.js";
import { readLibraryVersionFields } from "./ether-library.js";
import { withFileLock } from "./file-lock.js";
import { ENGINE_FORMAT_VERSION, compareSemver, isEngineVersion, librarySupportRefusal } from "./format-version.js";
import { computeInstallTreeDigest, verifyInstallTree } from "./install-tree-digest.js";
import { readRegistry } from "./registry.js";
import { FRAMEWORK_VERSION } from "./index.js";

// Keep callback output explicit: the test-controller wrapper does not preserve execFile's custom promisifier.
function runFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error !== null) {
        rejectRun(error);
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

export const ENGINE_CURRENT_SCHEMA_VERSION = "einzbern.engine-current.v1" as const;
export const ENGINE_FILES = Object.freeze({
  // In engine/ of the device directory.
  current: "current",
  launcher: "einzbern.mjs",
  // In a version directory: what the stable entry runs.
  entry: "scripts/einzbern.mjs",
  // In locks/ of the device directory.
  lock: "engine.lock",
} as const);
// No product deadline: the invoking operator owns cancellation.

export const ENGINE_HOME_REASON_CODES = Object.freeze([
  "ENGINE_CURRENT_INVALID",
  "ENGINE_PROBE_FAILED",
  "ENGINE_ROLLBACK_UNAVAILABLE",
  "ENGINE_TREE_INVALID",
  "ENGINE_VERSION_CONFLICT",
  "ENGINE_VERSION_INVALID",
  "ENGINE_VERSION_MISMATCH",
  "INSTALL_TREE_DIGEST_MISMATCH",
] as const);
export type EngineHomeReasonCode = typeof ENGINE_HOME_REASON_CODES[number];

export class EngineHomeError extends Error {
  readonly reasonCode: EngineHomeReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: EngineHomeReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "EngineHomeError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: EngineHomeReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new EngineHomeError(reasonCode, message, details);
}

export interface EngineCurrent {
  readonly schemaVersion: typeof ENGINE_CURRENT_SCHEMA_VERSION;
  readonly version: string;
  readonly previous: string | null;
  readonly switchedAt: string;
}

export function engineCurrentPath(home: string = deviceHome()): string {
  return join(engineRoot(home), ENGINE_FILES.current);
}

/** The stable entry every hook and registry pointer names. */
export function engineLauncherPath(home: string = deviceHome()): string {
  return join(engineRoot(home), ENGINE_FILES.launcher);
}

export function engineVersionDirectory(version: string, home: string = deviceHome()): string {
  if (!isEngineVersion(version)) fail("ENGINE_VERSION_INVALID", `${version} is not an engine version (x.y.z, with an optional pre-release)`);
  return join(engineRoot(home), version);
}

const CURRENT_FIELDS = ["previous", "schemaVersion", "switchedAt", "version"];

function validateCurrent(value: unknown, path: string): EngineCurrent {
  const invalid = (message: string): never => fail("ENGINE_CURRENT_INVALID", `${path}: ${message}`, { file: path });
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("not an object");
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join("\u0000") !== CURRENT_FIELDS.join("\u0000")) invalid("fields are not exact");
  if (record.schemaVersion !== ENGINE_CURRENT_SCHEMA_VERSION) invalid(`schemaVersion must be ${ENGINE_CURRENT_SCHEMA_VERSION}`);
  if (!isEngineVersion(record.version)) invalid("version is not an engine version");
  if (record.previous !== null && !isEngineVersion(record.previous)) invalid("previous is neither null nor an engine version");
  try {
    assertStrictInstant(record.switchedAt);
  } catch {
    invalid("switchedAt must be a strict instant");
  }
  return Object.freeze({
    schemaVersion: ENGINE_CURRENT_SCHEMA_VERSION,
    version: String(record.version),
    previous: record.previous === null ? null : String(record.previous),
    switchedAt: String(record.switchedAt),
  });
}

/** Which version is current on this device, or null when none is. */
export async function readEngineCurrent(home: string = deviceHome()): Promise<EngineCurrent | null> {
  const path = engineCurrentPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("ENGINE_CURRENT_INVALID", `${path} is not JSON`, { file: path });
  }
  return validateCurrent(value, path);
}

async function writeEngineCurrent(current: EngineCurrent, home: string): Promise<void> {
  await ensureDeviceDirectory(engineRoot(home));
  await writeFileAtomic(engineCurrentPath(home), canonicalJson(current as unknown as JsonValue));
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** The versions installed on this device, oldest first. A half-copied version (a temporary) is not one. */
export async function listEngineVersions(home: string = deviceHome()): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(engineRoot(home), { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isEngineVersion(entry.name))
    .map((entry) => entry.name)
    .sort(compareSemver);
}

export interface EngineListing {
  // The engine answering: its version and the newest library format it reads.
  readonly engineVersion: string;
  readonly formatVersion: number;
  readonly engineRoot: string;
  readonly launcher: { readonly path: string; readonly present: boolean };
  readonly current: EngineCurrent | null;
  // ENGINE_CURRENT_INVALID when engine/current exists but cannot be read as a pointer.
  readonly currentReasonCode: string | null;
  readonly versions: readonly string[];
}

/** The engine versions on this device, which is current, and the engine that answers. Nothing is written. */
export async function listEngines(home: string = deviceHome()): Promise<EngineListing> {
  let current: EngineCurrent | null = null;
  let currentReasonCode: string | null = null;
  try {
    current = await readEngineCurrent(home);
  } catch (error) {
    if (!(error instanceof EngineHomeError)) throw error;
    // A damaged pointer is reported, not fatal: engine-update repairs it, and runs this listing
    // as the new version's first answer.
    currentReasonCode = error.reasonCode;
  }
  return {
    engineVersion: FRAMEWORK_VERSION,
    formatVersion: ENGINE_FORMAT_VERSION,
    engineRoot: engineRoot(home),
    launcher: { path: engineLauncherPath(home), present: await isRegularFile(engineLauncherPath(home)) },
    current,
    currentReasonCode,
    versions: await listEngineVersions(home),
  };
}

export interface EngineProbe {
  readonly engineVersion: string;
  readonly formatVersion: number;
}

/** Run an installed version once (engine-list) to learn that it starts, what version it is and which format it reads. */
async function probeEngine(directory: string, home: string): Promise<EngineProbe> {
  let stdout: string;
  try {
    ({ stdout } = await runFile(process.execPath, [join(directory, ENGINE_FILES.entry), "engine-list"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, EINZBERN_HOME: home },
      maxBuffer: RUNTIME_CAPACITY.bufferBytes,

      windowsHide: true,
    }));
  } catch (error) {
    const said = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").at(-1) ?? "";
    fail("ENGINE_PROBE_FAILED", `${directory} did not answer engine-list: ${said || String((error as Error).message)}`, { target: directory });
  }
  let answer: unknown = null;
  try {
    answer = JSON.parse(stdout.trim());
  } catch {
    answer = null;
  }
  const record = answer !== null && typeof answer === "object" && !Array.isArray(answer) ? answer as Readonly<Record<string, unknown>> : {};
  const { engineVersion, formatVersion } = record;
  if (record.reasonCode !== "ENGINE_LIST_READY" || !isEngineVersion(engineVersion) ||
    typeof formatVersion !== "number" || !Number.isSafeInteger(formatVersion) || formatVersion < 1) {
    fail("ENGINE_PROBE_FAILED", `${directory} answered engine-list with something other than its version and format`, { target: directory });
  }
  return { engineVersion, formatVersion };
}

export interface LibraryCompatibility {
  readonly projectPath: string;
  readonly libraryPath: string;
  readonly libraryId: string;
  readonly formatVersion: number | null;
  readonly minEngineVersion: string | null;
  // Whether the engine now current opens this library; when not, why.
  readonly opens: boolean;
  readonly reasonCode: string | null;
  readonly details: Readonly<Record<string, string>>;
}

const INCOMPATIBLE = new Set(["ENGINE_TOO_OLD", "LIBRARY_FORMAT_UNSUPPORTED"]);

/** Check every library in this device's registry against an engine (TCRN-CROSS-STORY-471 R3). Nothing is written. */
async function checkRegisteredLibraries(engine: EngineProbe, home: string): Promise<{ readonly libraries: readonly LibraryCompatibility[]; readonly incompatible: number }> {
  const libraries: LibraryCompatibility[] = [];
  for (const entry of (await readRegistry(home)).entries) {
    const base = { projectPath: entry.projectPath, libraryPath: entry.libraryPath, libraryId: entry.libraryId };
    try {
      const fields = await readLibraryVersionFields(entry.libraryPath);
      const refusal = librarySupportRefusal(fields, {
        engineVersion: engine.engineVersion,
        supportedFormat: engine.formatVersion,
        where: `library ${entry.libraryPath}`,
      });
      libraries.push({
        ...base,
        formatVersion: typeof fields.formatVersion === "number" && Number.isSafeInteger(fields.formatVersion) ? fields.formatVersion : null,
        minEngineVersion: isEngineVersion(fields.minEngineVersion) ? fields.minEngineVersion : null,
        opens: refusal === null,
        reasonCode: refusal?.reasonCode ?? null,
        details: refusal?.details ?? {},
      });
    } catch (error) {
      const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
      if (typeof reasonCode !== "string") throw error;
      libraries.push({ ...base, formatVersion: null, minEngineVersion: null, opens: false, reasonCode, details: {} });
    }
  }
  return { libraries, incompatible: libraries.filter((entry) => entry.reasonCode !== null && INCOMPATIBLE.has(entry.reasonCode)).length };
}

async function withEngineLock<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const path = join(home, DEVICE_HOME_ENTRIES.locks, ENGINE_FILES.lock);
  await ensureDeviceDirectory(dirname(path));
  return withFileLock(path, operation);
}

export interface EngineSwitchReport {
  readonly reasonCode: "ENGINE_UPDATED" | "ENGINE_ROLLED_BACK";
  readonly current: EngineCurrent;
  // engine-update: whether the version was copied now or was already installed with these bytes.
  readonly installed?: "copied" | "reused";
  readonly engine: EngineProbe;
  readonly launcher: { readonly path: string; readonly present: boolean };
  readonly libraries: readonly LibraryCompatibility[];
  readonly incompatible: number;
}

export interface EngineUpdateInput {
  // An unpacked engine, laid out as this repository is: scripts/einzbern.mjs runs it.
  readonly from: string;
  // The install-tree digest its publisher stated.
  readonly sha256: string;
  readonly version: string;
  readonly at: string;
  readonly home?: string;
}

async function report(
  reasonCode: EngineSwitchReport["reasonCode"],
  current: EngineCurrent,
  engine: EngineProbe,
  home: string,
  installed?: "copied" | "reused",
): Promise<EngineSwitchReport> {
  return {
    reasonCode,
    current,
    ...(installed === undefined ? {} : { installed }),
    engine,
    launcher: { path: engineLauncherPath(home), present: await isRegularFile(engineLauncherPath(home)) },
    ...await checkRegisteredLibraries(engine, home),
  };
}

/**
 * Install a checked engine version and make it current (TCRN-CROSS-STORY-471 R2, R3): the tree must
 * hash as stated and carry scripts/einzbern.mjs; it is copied to engine/<version>/ (or, when that
 * directory already holds the same bytes, reused), run once, and only then named in engine/current,
 * with the version it replaces as the previous one. A failure leaves engine/current as it was.
 */
export async function updateEngine(input: EngineUpdateInput): Promise<EngineSwitchReport> {
  assertStrictInstant(input.at);
  const home = input.home ?? deviceHome();
  const target = engineVersionDirectory(input.version, home);
  const from = resolve(input.from);
  const stated = await verifyInstallTree(from, input.sha256);
  if (!stated.ok) fail("INSTALL_TREE_DIGEST_MISMATCH", `${from} does not hash as stated`, { required: stated.expected, actual: stated.actual });
  if (!(await isRegularFile(join(from, ENGINE_FILES.entry)))) {
    fail("ENGINE_TREE_INVALID", `${from} holds no ${ENGINE_FILES.entry} to run`, { target: from });
  }
  return withEngineLock(home, async () => {
    let installed: "copied" | "reused";
    let existing: Stats | undefined;
    try {
      existing = await lstat(target);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    if (existing !== undefined) {
      let actual = "not a directory";
      if (existing.isDirectory() && !existing.isSymbolicLink()) {
        actual = await computeInstallTreeDigest(target).then((digest) => digest.sha256, () => "unreadable");
      }
      if (actual !== input.sha256) {
        fail("ENGINE_VERSION_CONFLICT", `${target} already holds a ${input.version} with other bytes`, { required: input.sha256, actual, target });
      }
      installed = "reused";
    } else {
      await ensureDeviceDirectory(engineRoot(home));
      const temporary = join(engineRoot(home), `${ATOMIC_TEMPORARY_PREFIX}${randomBytes(6).toString("hex")}-${input.version}`);
      try {
        await cp(from, temporary, { recursive: true, errorOnExist: true, force: false });
        const copied = await computeInstallTreeDigest(temporary);
        if (copied.sha256 !== input.sha256) {
          fail("INSTALL_TREE_DIGEST_MISMATCH", "the copy does not hash as its source was stated", { required: input.sha256, actual: copied.sha256 });
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      installed = "copied";
    }
    let engine: EngineProbe;
    try {
      engine = await probeEngine(target, home);
      if (engine.engineVersion !== input.version) {
        fail("ENGINE_VERSION_MISMATCH", `${target} runs as ${engine.engineVersion}, not ${input.version}`, { required: input.version, actual: engine.engineVersion });
      }
    } catch (error) {
      // Only a version this update copied is taken away again.
      if (installed === "copied") await rm(target, { recursive: true, force: true });
      throw error;
    }
    let before: EngineCurrent | null = null;
    try {
      before = await readEngineCurrent(home);
    } catch (error) {
      // A damaged pointer is replaced; there is no previous version to keep from it.
      if (!(error instanceof EngineHomeError)) throw error;
    }
    const current: EngineCurrent = Object.freeze({
      schemaVersion: ENGINE_CURRENT_SCHEMA_VERSION,
      version: input.version,
      previous: before === null ? null : before.version === input.version ? before.previous : before.version,
      switchedAt: input.at,
    });
    await writeEngineCurrent(current, home);
    return report("ENGINE_UPDATED", current, engine, home, installed);
  });
}

/**
 * Make the previous version current again (TCRN-CROSS-STORY-471 R3): it must still be installed and
 * must start; the version it replaces becomes the previous one, so a second rollback undoes the first.
 */
export async function rollbackEngine(input: { readonly at: string; readonly home?: string }): Promise<EngineSwitchReport> {
  assertStrictInstant(input.at);
  const home = input.home ?? deviceHome();
  return withEngineLock(home, async () => {
    const before = await readEngineCurrent(home);
    if (before === null) fail("ENGINE_ROLLBACK_UNAVAILABLE", "no engine version is current on this device", { remedy: "engine-update" });
    if (before.previous === null) {
      fail("ENGINE_ROLLBACK_UNAVAILABLE", `${before.version} is current and there is no previous version to go back to`, { remedy: "engine-update" });
    }
    const target = engineVersionDirectory(before.previous, home);
    if (!(await isRegularFile(join(target, ENGINE_FILES.entry)))) {
      fail("ENGINE_ROLLBACK_UNAVAILABLE", `the previous version ${before.previous} is no longer installed`, { required: before.previous, remedy: "engine-update" });
    }
    const engine = await probeEngine(target, home);
    if (engine.engineVersion !== before.previous) {
      fail("ENGINE_VERSION_MISMATCH", `${target} runs as ${engine.engineVersion}, not ${before.previous}`, { required: before.previous, actual: engine.engineVersion });
    }
    const current: EngineCurrent = Object.freeze({
      schemaVersion: ENGINE_CURRENT_SCHEMA_VERSION,
      version: before.previous,
      previous: before.version,
      switchedAt: input.at,
    });
    await writeEngineCurrent(current, home);
    return report("ENGINE_ROLLED_BACK", current, engine, home);
  });
}
