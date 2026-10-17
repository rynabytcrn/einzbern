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
// other staging and pre-update backup is cleared. Another entry of trash/ is no staging and is kept.
// TCRN-CROSS-SUB-519 (J7-07): any other entry of backups/ is judged by what it holds one level down,
// listed in the plan as its contents. One that holds an original a write replaced is kept. Only one
// that holds the skill copies alone is cleared, and only when, read further down, they are laid out
// as an update replaced them (TCRN-CROSS-SUB-521, J8-06): each host's copy of the released skill,
// which a release places again. The old helper's copies and the install markers the migration moved
// there are originals and kept, and so is anything device-clean does not know. A symbolic link, or
// an entry whose real path is not where its name puts it in the device directory, is refused and
// never touched. The plan writes nothing. With --yes true the
// cleared entries are deleted one by one, each checked again first, and the receipt names each with
// its size, or why it was not deleted. Nothing outside trash/ and backups/ of the device directory is
// ever deleted, and no link is followed: a directory goes with what it holds, a link in it as a link.

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";

import { assertStrictInstant } from "../../protocol/src/index.js";
import { DEVICE_HOME_ENTRIES, deviceHome as currentDeviceHome } from "./device-home.js";
import { readEngineCurrent } from "./engine-home.js";
import { isEngineVersion } from "./format-version.js";
import { BRAND, DIRECTORY, LEGACY_DEVICE_DIRECTORY, LEGACY_HELPER_NAME } from "./names.js";
import { LEGACY_SKILL_ROOTS, SKILL_COPIES_FILES, SKILL_COPY_ROOTS } from "./skill-copies.js";

export const DEVICE_CLEAN_PLAN_SCHEMA_VERSION = "einzbern.device-clean-plan.v1" as const;
// The device directory's trash/, where the install script and setup --mode update leave their stagings.
export const DEVICE_TRASH_DIRECTORY = "trash" as const;
export const DEVICE_CLEAN_AREAS = Object.freeze([DEVICE_TRASH_DIRECTORY, DEVICE_HOME_ENTRIES.backups] as const);
export type DeviceCleanArea = typeof DEVICE_CLEAN_AREAS[number];

export const DEVICE_CLEAN_ENGINE_UNKNOWN = "DEVICE_CLEAN_ENGINE_UNKNOWN" as const;

/** Why an entry is kept, cleared or refused: one code each. */
export const DEVICE_CLEAN_REASONS = Object.freeze({
  keep: Object.freeze(["current-version-staging", "holds-originals", "not-a-staging", "pre-update-backup-of-current", "pre-update-backup-of-previous", "unrecognised-backup"] as const),
  remove: Object.freeze(["older-pre-update-backup", "older-version-staging", "skill-copies-backup", "unknown-version-staging"] as const),
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
  // An entry of backups/ that is judged (TCRN-CROSS-SUB-519): the names of what it holds one level
  // down, sorted; none for a file. Left out for trash/ and for a refused entry, which is not read.
  readonly contents?: readonly string[];
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

// TCRN-CROSS-SUB-519 (J7-07): what a backup other than a pre-update one may hold, one level down. The
// originals a write replaced are no copies of anything: a host's hook files (host-hooks.ts), a host's
// writable roots (host-writable-roots.ts), a project's AGENTS.md and CLAUDE.md (managed-sections.ts),
// the bodies a clearing of the knowledge store took out of the crest (knowledge-core.ts), the
// registry library-unregister rewrote (registry.ts), and (TCRN-CROSS-SUB-521, J8-06) the launchers and
// the registry that setup and the migration replaced, in launchers/ and registry/ (setup-fresh.ts,
// setup-maintain.ts, migrate-cleanup.ts, migrate-legacy.ts).
// skill-copies/ is read further down (TCRN-CROSS-SUB-521, J8-06), since more than one write puts
// copies there. An update moves each host's copy it replaces to <host skill root>/<skill id>
// (installSkillCopies, skill-copies.ts), as an uninstall moves the copies it takes out
// (setup-maintain.ts): only these are copies of a released skill tree, which its release places again.
// The migration moves the old helper's copies to <root it was copied into>/<old helper name> and the
// install markers its retired trust chain left to <old device directory>/<marker>
// (applyLegacySkillCleanup, skill-copies.ts): the only copies there are, which nothing places again.
const SKILL_COPIES_BACKUP = SKILL_COPIES_FILES.backup;
const ORIGINALS_BACKUPS: readonly string[] = Object.freeze(["crest-bodies", "host-hooks", "launchers", "managed-sections", "registry", "writable-roots"]);
const REGISTRY_BACKUP = "registry.json";
// Under skill-copies/, each as its path segments joined by "/": where an update puts each host's
// copy, and where the migration puts the old helper's copies; the markers go in a directory named as
// the old device directory (LEGACY_DEVICE_DIRECTORY).
const UPDATE_COPIES: readonly string[] = Object.freeze(SKILL_COPY_ROOTS.map((root) => [root.root, BRAND.helper.id].join("/")));
const MIGRATED_COPIES: readonly string[] = Object.freeze(LEGACY_SKILL_ROOTS.map((root) => [root, LEGACY_HELPER_NAME].join("/")));
// The directories on the way to those places, the markers' directory among them.
const SKILL_COPIES_WAYS: ReadonlySet<string> = new Set([
  ...[...UPDATE_COPIES, ...MIGRATED_COPIES].flatMap((path) => {
    const segments = path.split("/");
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  }),
  LEGACY_DEVICE_DIRECTORY,
]);

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
  // An entry of backups/ alone: the names of what it holds one level down.
  readonly contents?: readonly string[];
}

// One thing a backup holds, one level down, as lstat finds it: a link is neither a directory nor a file.
interface Held {
  readonly name: string;
  readonly directory: boolean;
  readonly file: boolean;
}

// What the backup at `path` holds one level down, sorted by name, from lstat alone and no link
// followed; nothing when the backup is a file.
async function heldBy(path: string): Promise<readonly Held[]> {
  if (!(await lstat(path)).isDirectory()) return [];
  const held: Held[] = [];
  for (const entry of await children(path)) {
    const stats = await lstat(join(path, entry.name));
    held.push({ name: entry.name, directory: stats.isDirectory(), file: stats.isFile() });
  }
  return held;
}

// What one thing under skill-copies/ is, `at` its path below it, from its lstat alone: a copy an
// update replaced (a directory), what the migration moved there (whatever it was, since it was moved
// whole), a directory on the way to either, or something else.
type SkillCopiesPlace = "update-record" | "update" | "migration" | "way" | "unknown";

function skillCopiesPlace(at: readonly string[], stats: Stats): SkillCopiesPlace {
  const path = at.join("/");
  if (path === SKILL_COPIES_FILES.record) return stats.isFile() ? "update-record" : "unknown";
  if (UPDATE_COPIES.includes(path)) return stats.isDirectory() ? "update" : "unknown";
  if (MIGRATED_COPIES.includes(path) || (at.length === 2 && at[0] === LEGACY_DEVICE_DIRECTORY)) return "migration";
  return SKILL_COPIES_WAYS.has(path) && stats.isDirectory() ? "way" : "unknown";
}

// TCRN-CROSS-SUB-521 (J8-06): the skill copies a backup holds, read down from `path` with lstat alone
// and no link followed, only as far as the places above; of a copy, only whether it holds anything.
// They are cleared only when all they hold is the copies an update replaced. What the migration
// moved there keeps the backup as holding originals, whatever else it holds; anything else keeps it
// as unrecognised: a name on no way to those places, a file or a link where a directory belongs, an
// empty directory, a copy's among them.
async function skillCopiesVerdict(path: string): Promise<{ readonly keep: boolean; readonly reason: string }> {
  const found = new Set<SkillCopiesPlace>();
  const walk = async (directory: string, at: readonly string[]): Promise<void> => {
    const held = await children(directory);
    if (held.length === 0) found.add("unknown");
    for (const entry of held) {
      const below = [...at, entry.name];
      const place = skillCopiesPlace(below, await lstat(join(directory, entry.name)));
      if (place === "way") await walk(join(directory, entry.name), below);
      else if (place === "update" && (await children(join(directory, entry.name))).length === 0) found.add("unknown");
      else found.add(place);
    }
  };
  await walk(path, []);
  if (found.has("migration")) return { keep: true, reason: "holds-originals" };
  if (found.has("update") && !found.has("unknown")) return { keep: false, reason: "skill-copies-backup" };
  return { keep: true, reason: "unrecognised-backup" };
}

// TCRN-CROSS-SUB-519 (J7-07): a backup other than a pre-update one is cleared only when it holds the
// skill copies alone, as a directory, laid out as an update replaced them (TCRN-CROSS-SUB-521). One
// that holds an original a write replaced (host-hooks, writable-roots, managed-sections,
// crest-bodies, launchers, registry, or the file registry.json) is kept, and so is one that holds
// nothing or anything else, or is a file: what device-clean does not know, it does not clear.
async function backupVerdict(path: string, held: readonly Held[]): Promise<{ readonly keep: boolean; readonly reason: string }> {
  if (held.some((entry) => ORIGINALS_BACKUPS.includes(entry.name) || (entry.name === REGISTRY_BACKUP && entry.file))) {
    return { keep: true, reason: "holds-originals" };
  }
  if (held.length > 0 && held.every((entry) => entry.name === SKILL_COPIES_BACKUP && entry.directory)) {
    return skillCopiesVerdict(join(path, SKILL_COPIES_BACKUP));
  }
  return { keep: true, reason: "unrecognised-backup" };
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
  const held = await heldBy(path);
  const contents = held.map((entry) => entry.name);
  const match = PRE_UPDATE_BACKUP.exec(name);
  const version = match !== null && isEngineVersion(match[1]) ? match[1]! : null;
  if (version === null) return { kind: "backup", version: null, contents, ...await backupVerdict(path, held) };
  if (version === current) return { kind: "pre-update-backup", version, keep: true, reason: "pre-update-backup-of-current", contents };
  if (version === previous) return { kind: "pre-update-backup", version, keep: true, reason: "pre-update-backup-of-previous", contents };
  return { kind: "pre-update-backup", version, keep: false, reason: "older-pre-update-backup", contents };
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
    judged.push({
      area, name: entry.name, path, kind: verdict.kind, version: verdict.version, bytes: await sizeOf(path), reason: verdict.reason,
      ...(verdict.contents === undefined ? {} : { contents: verdict.contents }),
      verdict: verdict.keep ? "keep" : "remove",
    });
  }
  return judged;
}

function entryOf(judged: Judged): DeviceCleanEntry {
  return {
    area: judged.area, name: judged.name, path: judged.path, kind: judged.kind, version: judged.version, bytes: judged.bytes, reason: judged.reason,
    ...(judged.contents === undefined ? {} : { contents: judged.contents }),
  };
}

/**
 * What device-clean would clear in the device directory (TCRN-CROSS-SUB-512): each staging in trash/
 * and each entry of backups/, kept, cleared or refused, with its size and reason, and an entry of
 * backups/ with its contents (TCRN-CROSS-SUB-519). Writes nothing.
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
