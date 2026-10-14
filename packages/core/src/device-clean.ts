// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-541 (MIN-258 D3; TCRN-CROSS-SUB-512; r7 Q8): device-clean, the one way to clear what
// installs and updates leave in the device directory. The skill's install script moves its unpacked
// release into trash/install-<UTC>-tmp-<random>/ and setup --mode update stages one in
// trash/setup-update-<UTC>/ (setup-maintain.ts); neither deletes anything, and backups/ keeps every
// copy taken before a write, the pre-update backups named <UTC>-...pre-update-<version> among them.
//
// The plan lists each install and setup-update staging in trash/ and each entry of backups/, with its
// size and the reason it is kept or cleared, judged against engine/current: kept are the pre-update
// backups of the current and the previous version and the stagings of the current version; every
// other staging and backup is cleared. Another entry of trash/ is no staging and is kept. A symbolic
// link, or an entry whose real path is not where its name puts it in the device directory, is refused
// and never touched. The plan writes nothing. With --yes true the cleared entries are deleted one by
// one, each checked again first, and the receipt names each with its size, or why it was not deleted.
// Nothing outside trash/ and backups/ of the device directory is ever deleted, and no link is
// followed: a directory goes with what it holds, a link in it as a link.

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import { assertStrictInstant } from "../../protocol/src/index.js";
import { DEVICE_HOME_ENTRIES, deviceHome as currentDeviceHome } from "./device-home.js";
import { readEngineCurrent } from "./engine-home.js";
import { isEngineVersion } from "./format-version.js";
import { BRAND, DIRECTORY } from "./names.js";

export const DEVICE_CLEAN_PLAN_SCHEMA_VERSION = "einzbern.device-clean-plan.v1" as const;
// The device directory's trash/, where the install script and setup --mode update leave their stagings.
export const DEVICE_TRASH_DIRECTORY = "trash" as const;
export const DEVICE_CLEAN_AREAS = Object.freeze([DEVICE_TRASH_DIRECTORY, DEVICE_HOME_ENTRIES.backups] as const);
export type DeviceCleanArea = typeof DEVICE_CLEAN_AREAS[number];

export const DEVICE_CLEAN_ENGINE_UNKNOWN = "DEVICE_CLEAN_ENGINE_UNKNOWN" as const;

/** Why an entry is kept, cleared or refused: one code each. */
export const DEVICE_CLEAN_REASONS = Object.freeze({
  keep: Object.freeze(["current-version-staging", "not-a-staging", "pre-update-backup-of-current", "pre-update-backup-of-previous"] as const),
  remove: Object.freeze(["older-pre-update-backup", "older-version-staging", "other-backup", "unknown-version-staging"] as const),
  refuse: Object.freeze(["outside-device-directory", "symbolic-link"] as const),
});

export type DeviceCleanKind = "install-staging" | "setup-update-staging" | "pre-update-backup" | "backup" | "other";

export interface DeviceCleanEntry {
  readonly area: DeviceCleanArea;
  readonly name: string;
  readonly path: string;
  readonly kind: DeviceCleanKind;
  // The engine version the entry belongs to, when its name or contents say.
  readonly version: string | null;
  // The bytes of every file and link under it, links not followed.
  readonly bytes: number;
  readonly reason: string;
}

export interface DeviceCleanPlan {
  readonly schemaVersion: typeof DEVICE_CLEAN_PLAN_SCHEMA_VERSION;
  readonly deviceHome: string;
  readonly at: string;
  readonly engine: { readonly current: string; readonly previous: string | null };
  readonly remove: readonly DeviceCleanEntry[];
  readonly keep: readonly DeviceCleanEntry[];
  readonly refused: readonly DeviceCleanEntry[];
  readonly removeBytes: number;
}

export interface DeviceCleanResult extends DeviceCleanPlan {
  // Each cleared entry deleted, with its size.
  readonly removed: readonly { readonly path: string; readonly bytes: number }[];
  // Each cleared entry not deleted, and why: it is gone or moved since the plan, or the deletion failed.
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

export interface DeviceCleanInput {
  // The device directory; EINZBERN_HOME or ~/.einzbern by default (deviceCleanHome).
  readonly deviceHome?: string;
  // The instant of the run, recorded in the plan and the receipt; the engine reads no clock.
  readonly at: string;
}

export class DeviceCleanError extends Error {
  readonly reasonCode: typeof DEVICE_CLEAN_ENGINE_UNKNOWN;
  readonly details: Readonly<Record<string, string>>;

  constructor(message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "DeviceCleanError";
    this.reasonCode = DEVICE_CLEAN_ENGINE_UNKNOWN;
    this.details = details;
  }
}

/** The device directory device-clean works in: `<home>/.einzbern` for a given home, as machine-settings' --home means. */
export function deviceCleanHome(home?: string): string {
  return home === undefined ? currentDeviceHome() : join(home, DIRECTORY.device);
}

const INSTALL_STAGING = /^install-/u;
const SETUP_UPDATE_STAGING = /^setup-update-/u;
const PRE_UPDATE_BACKUP = /(?:^|-)pre-update-(.+)$/u;
const RELEASE_TREE_PREFIX = `${BRAND.engine.id}-`;

function missing(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function codeOf(error: unknown): string {
  const { reasonCode, code } = (error ?? {}) as { readonly reasonCode?: unknown; readonly code?: unknown };
  return typeof reasonCode === "string" ? reasonCode : typeof code === "string" ? code : "DEVICE_CLEAN_FAILED";
}

async function children(directory: string): Promise<readonly Dirent[]> {
  try {
    return [...await readdir(directory, { withFileTypes: true })].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

// The bytes of every file and link under `path`, a link counted as itself and never followed.
async function sizeOf(path: string): Promise<number> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of await children(path)) total += await sizeOf(join(path, entry.name));
  return total;
}

// The version a staging holds: the einzbern-<version> directory its release unpacked to, when there
// is exactly one; null otherwise.
async function stagingVersion(path: string): Promise<string | null> {
  const versions = (await children(path))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(RELEASE_TREE_PREFIX))
    .map((entry) => entry.name.slice(RELEASE_TREE_PREFIX.length))
    .filter((version) => isEngineVersion(version));
  return versions.length === 1 ? versions[0]! : null;
}

interface Verdict {
  readonly kind: DeviceCleanKind;
  readonly version: string | null;
  readonly keep: boolean;
  readonly reason: string;
}

// What an entry of trash/ or backups/ is, and whether it is kept, judged against engine/current.
async function judge(area: DeviceCleanArea, name: string, path: string, current: string, previous: string | null): Promise<Verdict> {
  if (area === DEVICE_TRASH_DIRECTORY) {
    const kind: DeviceCleanKind | null = INSTALL_STAGING.test(name) ? "install-staging" : SETUP_UPDATE_STAGING.test(name) ? "setup-update-staging" : null;
    if (kind === null) return { kind: "other", version: null, keep: true, reason: "not-a-staging" };
    const version = (await lstat(path)).isDirectory() ? await stagingVersion(path) : null;
    if (version === null) return { kind, version, keep: false, reason: "unknown-version-staging" };
    return version === current
      ? { kind, version, keep: true, reason: "current-version-staging" }
      : { kind, version, keep: false, reason: "older-version-staging" };
  }
  const match = PRE_UPDATE_BACKUP.exec(name);
  const version = match !== null && isEngineVersion(match[1]) ? match[1]! : null;
  if (version === null) return { kind: "backup", version: null, keep: false, reason: "other-backup" };
  if (version === current) return { kind: "pre-update-backup", version, keep: true, reason: "pre-update-backup-of-current" };
  if (version === previous) return { kind: "pre-update-backup", version, keep: true, reason: "pre-update-backup-of-previous" };
  return { kind: "pre-update-backup", version, keep: false, reason: "older-pre-update-backup" };
}

// Null when the entry `name` of the area is where its name puts it: no link, and its real path the
// area of the device directory's real path. The refusal's reason otherwise.
async function placeProblem(device: string, area: DeviceCleanArea, name: string): Promise<string | null> {
  const path = join(device, area, name);
  if ((await lstat(path)).isSymbolicLink()) return "symbolic-link";
  const realArea = await realpath(join(device, area));
  if (realArea !== join(await realpath(device), area)) return "outside-device-directory";
  return (await realpath(path)) === join(realArea, name) ? null : "outside-device-directory";
}

type Judged = DeviceCleanEntry & { readonly verdict: "keep" | "remove" | "refuse" };

async function areaEntries(device: string, area: DeviceCleanArea, current: string, previous: string | null): Promise<readonly Judged[]> {
  const root = join(device, area);
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  // An area that is a link, or no directory, could put its entries anywhere: it is refused whole.
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return [{ area, name: area, path: root, kind: "other", version: null, bytes: rootStats.size, reason: rootStats.isSymbolicLink() ? "symbolic-link" : "outside-device-directory", verdict: "refuse" }];
  }
  const judged: Judged[] = [];
  for (const entry of await children(root)) {
    const path = join(root, entry.name);
    const problem = await placeProblem(device, area, entry.name);
    if (problem !== null) {
      judged.push({ area, name: entry.name, path, kind: "other", version: null, bytes: (await lstat(path)).size, reason: problem, verdict: "refuse" });
      continue;
    }
    const verdict = await judge(area, entry.name, path, current, previous);
    judged.push({ area, name: entry.name, path, kind: verdict.kind, version: verdict.version, bytes: await sizeOf(path), reason: verdict.reason, verdict: verdict.keep ? "keep" : "remove" });
  }
  return judged;
}

function entryOf(judged: Judged): DeviceCleanEntry {
  return { area: judged.area, name: judged.name, path: judged.path, kind: judged.kind, version: judged.version, bytes: judged.bytes, reason: judged.reason };
}

/**
 * What device-clean would clear in the device directory (TCRN-CROSS-SUB-512): each staging in trash/
 * and each entry of backups/, kept, cleared or refused, with its size and reason. Writes nothing.
 * DEVICE_CLEAN_ENGINE_UNKNOWN when engine/current names no version, since nothing can be judged.
 */
export async function planDeviceClean(input: DeviceCleanInput): Promise<DeviceCleanPlan> {
  assertStrictInstant(input.at);
  const device = input.deviceHome ?? currentDeviceHome();
  const current = await readEngineCurrent(device);
  if (current === null) {
    throw new DeviceCleanError(`${join(device, DEVICE_HOME_ENTRIES.engine, "current")} names no engine version; device-clean judges what it keeps by it`, { file: join(device, DEVICE_HOME_ENTRIES.engine, "current") });
  }
  const judged = (await Promise.all(DEVICE_CLEAN_AREAS.map((area) => areaEntries(device, area, current.version, current.previous)))).flat();
  const remove = judged.filter((entry) => entry.verdict === "remove").map(entryOf);
  return {
    schemaVersion: DEVICE_CLEAN_PLAN_SCHEMA_VERSION,
    deviceHome: device,
    at: input.at,
    engine: { current: current.version, previous: current.previous },
    remove,
    keep: judged.filter((entry) => entry.verdict === "keep").map(entryOf),
    refused: judged.filter((entry) => entry.verdict === "refuse").map(entryOf),
    removeBytes: remove.reduce((total, entry) => total + entry.bytes, 0),
  };
}

/**
 * Clear what the plan lists to clear (TCRN-CROSS-SUB-512): the plan is made again, and each of its
 * cleared entries is checked once more -- still no link, still in its area of the device directory --
 * and deleted with what it holds, links as links. The receipt names each entry deleted, with its size,
 * and each that was not, with why. Nothing the plan keeps or refuses is touched.
 */
export async function applyDeviceClean(input: DeviceCleanInput): Promise<DeviceCleanResult> {
  const plan = await planDeviceClean(input);
  const removed: { readonly path: string; readonly bytes: number }[] = [];
  const failed: { readonly path: string; readonly reason: string }[] = [];
  for (const entry of plan.remove) {
    let problem: string | null;
    try {
      problem = await placeProblem(plan.deviceHome, entry.area, entry.name);
    } catch (error) {
      problem = missing(error) ? "missing" : codeOf(error);
    }
    if (problem !== null) {
      failed.push({ path: entry.path, reason: problem });
      continue;
    }
    try {
      await rm(entry.path, { recursive: true, force: false });
      removed.push({ path: entry.path, bytes: entry.bytes });
    } catch (error) {
      failed.push({ path: entry.path, reason: codeOf(error) });
    }
  }
  return { ...plan, removed, failed };
}
