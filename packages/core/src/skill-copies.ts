// SPDX-License-Identifier: Apache-2.0
import { renameRetryBudget } from "./io-policy.js";

// TCRN-CROSS-STORY-479 R4, R5 (MIN-227): the Mana Orchestrate skill as this machine's two hosts
// read it. Claude Code reads a user skill from ~/.claude/skills and Codex from ~/.agents/skills,
// so the skill tree is placed as ~/.claude/skills/mana-orchestrate and
// ~/.agents/skills/mana-orchestrate; ~/.codex/skills is never written (only the legacy helper
// was ever copied there). The install-tree digest of each copy is recorded in skills.json in the
// device directory, and verifySkillCopies compares the copies with that record.
//
// Nothing here deletes a copy or a marker. A copy that is about to be replaced is moved whole to
// backups/<UTC instant>/skill-copies/ in the device directory first, and the new tree is copied
// into a temporary sibling, checked against the source's digest and renamed into place, so a host
// never loads half a skill. Installing the same tree again finds both copies current and changes
// nothing. The legacy helper's copies (in both hosts' roots and ~/.codex/skills) and the install
// markers its retired trust chain left in the old device directory are listed by a plan, and
// applying the plan moves each of them under a backup root; a backup that already exists is never
// overwritten. The only thing this module removes is its own half-built temporary.

import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import { ATOMIC_TEMPORARY_PREFIX, writeFileAtomic } from "./atomic-file.js";
import { DEVICE_HOME_ENTRIES, backupsPath, deviceHome as currentDeviceHome, ensureDeviceDirectory } from "./device-home.js";
import { withFileLock } from "./file-lock.js";
import { InstallTreeError, computeInstallTreeDigest } from "./install-tree-digest.js";
import type { InstallTreeDigest } from "./install-tree-digest.js";
import { BRAND, LEGACY_DEVICE_DIRECTORY, LEGACY_HELPER_NAME } from "./names.js";

export const SKILL_COPIES_SCHEMA_VERSION = "einzbern.skill-copies.v1" as const;
export const SKILL_COPIES_FILES = Object.freeze({
  // In the device directory.
  record: "skills.json",
  // In locks/ of the device directory.
  lock: "skills.lock",
  // Under backups/<UTC instant>/ of the device directory.
  backup: "skill-copies",
  // At the root of a skill tree: what makes a directory a skill to both hosts.
  entry: "SKILL.md",
} as const);

export type SkillCopyHost = "claude" | "codex";

export interface SkillCopyRoot {
  readonly host: SkillCopyHost;
  // The host's user skill root, relative to the home directory, with POSIX separators.
  readonly root: string;
}

// Where each host reads a user skill (the same two roots the install manifest names).
export const SKILL_COPY_ROOTS: readonly SkillCopyRoot[] = Object.freeze([
  { host: "claude", root: ".claude/skills" },
  { host: "codex", root: ".agents/skills" },
]);

// Every root the legacy helper was ever copied into: both roots above and Codex's older one.
export const LEGACY_SKILL_ROOTS: readonly string[] = Object.freeze([".claude/skills", ".agents/skills", ".codex/skills"]);

// The install markers the legacy helper's trust chain wrote into the old device directory; they
// retired with it (TCRN-CROSS-STORY-467 R2). installed-copy-<host>.json is matched by pattern.
export const LEGACY_SKILL_MARKER_FILES: readonly string[] = Object.freeze([
  "complete-skill-archive.provenance.json",
  "skill-archive.json",
  "state.json",
  "trusted-bootstrap.mjs",
]);
const LEGACY_INSTALLED_COPY_PATTERN = /^installed-copy-.+\.json$/u;

export const SKILL_COPIES_REASON_CODES = Object.freeze([
  "LEGACY_SKILL_CLEANUP_BACKUP_EXISTS",
  "LEGACY_SKILL_CLEANUP_MOVE_FAILED",
  "LEGACY_SKILL_CLEANUP_PLAN_INVALID",
  "SKILL_COPY_BACKUP_EXISTS",
  "SKILL_COPY_DIGEST_MISMATCH",
  "SKILL_COPY_MOVE_FAILED",
  "SKILL_SOURCE_INVALID",
] as const);
export type SkillCopiesReasonCode = typeof SKILL_COPIES_REASON_CODES[number];

export class SkillCopiesError extends Error {
  readonly reasonCode: SkillCopiesReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: SkillCopiesReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "SkillCopiesError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: SkillCopiesReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new SkillCopiesError(reasonCode, message, details);
}

export interface SkillCopyRecord {
  readonly host: SkillCopyHost;
  readonly path: string;
  readonly installTreeDigest: string;
}

export interface SkillCopiesRecord {
  readonly schemaVersion: typeof SKILL_COPIES_SCHEMA_VERSION;
  readonly skill: string;
  readonly installedAt: string;
  readonly copies: readonly SkillCopyRecord[];
}

/** Whether a file name in the old device directory is one of the legacy helper's install markers. */
export function isLegacySkillMarker(name: string): boolean {
  return LEGACY_SKILL_MARKER_FILES.includes(name) || LEGACY_INSTALLED_COPY_PATTERN.test(name);
}

export function skillCopiesRecordPath(home: string = currentDeviceHome()): string {
  return join(home, SKILL_COPIES_FILES.record);
}

/** Where a host's copy of the skill lives under a home directory. */
export function skillCopyPath(home: string, root: SkillCopyRoot): string {
  return join(home, ...root.root.split("/"), BRAND.helper.id);
}

// The UTC second as a directory name that is legal on every platform: 20260926T140000Z.
function utcStamp(now: string): string {
  const milliseconds = Number(parseStrictInstant(now) / 1_000_000n);
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[-:]/gu, "");
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

// The digest of a tree that is expected to be a skill copy, or null when it cannot be taken (not a
// directory, a link or special file inside, or unreadable).
async function treeDigestOrNull(path: string): Promise<string | null> {
  try {
    return (await computeInstallTreeDigest(path)).sha256;
  } catch (error) {
    if (error instanceof InstallTreeError || typeof (error as { code?: unknown }).code === "string") return null;
    throw error;
  }
}

async function sourceDigest(source: string): Promise<InstallTreeDigest> {
  let digest: InstallTreeDigest;
  try {
    digest = await computeInstallTreeDigest(source);
  } catch (error) {
    if (!(error instanceof InstallTreeError)) throw error;
    fail("SKILL_SOURCE_INVALID", `${source}: ${error.message}`, { source, cause: error.reasonCode });
  }
  if (!digest.entries.some((entry) => entry.path === SKILL_COPIES_FILES.entry)) {
    fail("SKILL_SOURCE_INVALID", `${source} holds no ${SKILL_COPIES_FILES.entry}`, { source });
  }
  return digest;
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

// Move an entry by renaming it. On Windows a rename of a directory another process holds open
// (an indexer, an antivirus scanner) fails for a moment, so those failures are retried with
// backoff. A move to another volume (EXDEV) is refused rather than turned into copy and delete.
async function moveEntry(from: string, to: string, reasonCode: SkillCopiesReasonCode): Promise<void> {
  const retries = renameRetryBudget();
  let wait = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = String((error as { code?: string }).code ?? "UNKNOWN");
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= retries) {
        fail(reasonCode, `${from} could not be moved to ${to} (${code})`, { from, to, code });
      }
      await delay(wait);
      wait = Math.min(wait * 2, 500);
    }
  }
}

type LoadedRecord =
  | { readonly state: "missing" }
  | { readonly state: "invalid"; readonly detail: string }
  | { readonly state: "valid"; readonly record: SkillCopiesRecord };

const RECORD_FIELDS = ["copies", "installedAt", "schemaVersion", "skill"];
const COPY_FIELDS = ["host", "installTreeDigest", "path"];
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const HOSTS: readonly string[] = SKILL_COPY_ROOTS.map((root) => root.host);

function exactFields(value: unknown, fields: readonly string[]): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort(compareCanonicalText).join("\u0000") === fields.join("\u0000");
}

function isStrictInstant(value: unknown): boolean {
  try {
    parseStrictInstant(value);
    return true;
  } catch {
    return false;
  }
}

function validateRecord(value: unknown): SkillCopiesRecord | string {
  if (!exactFields(value, RECORD_FIELDS)) return "fields are not exact";
  if (value.schemaVersion !== SKILL_COPIES_SCHEMA_VERSION) return `schemaVersion must be ${SKILL_COPIES_SCHEMA_VERSION}`;
  if (value.skill !== BRAND.helper.id) return `skill must be ${BRAND.helper.id}`;
  if (!isStrictInstant(value.installedAt)) return "installedAt must be a strict instant";
  if (!Array.isArray(value.copies)) return "copies must be an array";
  const copies: SkillCopyRecord[] = [];
  for (const copy of value.copies as readonly unknown[]) {
    if (!exactFields(copy, COPY_FIELDS)) return "a copy's fields are not exact";
    const { host, path, installTreeDigest } = copy;
    if (typeof host !== "string" || !HOSTS.includes(host)) return "a copy names an unknown host";
    if (copies.some((seen) => seen.host === host)) return `host ${host} is recorded twice`;
    if (typeof path !== "string" || !isAbsolute(path)) return "a copy's path must be absolute";
    if (typeof installTreeDigest !== "string" || !DIGEST_PATTERN.test(installTreeDigest)) return "a copy's installTreeDigest must be 64 lowercase hexadecimal characters";
    copies.push({ host: host as SkillCopyHost, path, installTreeDigest });
  }
  return {
    schemaVersion: SKILL_COPIES_SCHEMA_VERSION,
    skill: BRAND.helper.id,
    installedAt: String(value.installedAt),
    copies,
  };
}

async function loadRecord(path: string): Promise<LoadedRecord> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { state: "missing" };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "invalid", detail: "not JSON" };
  }
  const record = validateRecord(value);
  return typeof record === "string" ? { state: "invalid", detail: record } : { state: "valid", record };
}

export interface InstallSkillCopiesInput {
  // The skill tree to place: SKILL.md at its root and regular files only (what skill-render --out writes).
  readonly source: string;
  // A strict instant: names the backup directory and is recorded as installedAt.
  readonly now: string;
  // The home directory whose .claude/skills and .agents/skills receive the copies (default: the user's).
  readonly home?: string;
  // The device directory that keeps skills.json and the backups (default: EINZBERN_HOME or ~/.einzbern).
  readonly deviceHome?: string;
}

export type SkillCopyAction = "created" | "replaced" | "reused";

export interface InstalledSkillCopy {
  readonly host: SkillCopyHost;
  readonly path: string;
  // created: nothing was there; replaced: what was there moved to `backup`; reused: it already held these bytes.
  readonly action: SkillCopyAction;
  readonly installTreeDigest: string;
  readonly backup: string | null;
}

export interface SkillCopiesInstallReport {
  // SKILL_COPIES_CURRENT: both copies already held this tree and skills.json already said so; nothing was written.
  readonly reasonCode: "SKILL_COPIES_INSTALLED" | "SKILL_COPIES_CURRENT";
  readonly skill: string;
  readonly installTreeDigest: string;
  readonly files: number;
  readonly record: string;
  readonly backupDir: string | null;
  readonly copies: readonly InstalledSkillCopy[];
}

interface PlannedCopy {
  readonly host: SkillCopyHost;
  readonly path: string;
  readonly action: SkillCopyAction;
  readonly backup: string | null;
}

// Copy the source into a temporary sibling of the target, check it, move what the target held to
// its backup, and rename the temporary into place. A failure before the rename leaves the target as
// it was; a failed rename tries to put the moved copy back with the same retry policy. If recovery
// also fails, the previous copy stays at its backup path and the error names both failures.
async function placeCopy(source: string, expected: string, copy: PlannedCopy): Promise<void> {
  const parent = dirname(copy.path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `${ATOMIC_TEMPORARY_PREFIX}${randomBytes(6).toString("hex")}-${BRAND.helper.id}`);
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    const copied = await computeInstallTreeDigest(temporary);
    if (copied.sha256 !== expected) {
      fail("SKILL_COPY_DIGEST_MISMATCH", "the copy does not hash as its source did", { required: expected, actual: copied.sha256, target: copy.path });
    }
    if (copy.backup !== null) {
      await mkdir(dirname(copy.backup), { recursive: true });
      await moveEntry(copy.path, copy.backup, "SKILL_COPY_MOVE_FAILED");
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  try {
    await moveEntry(temporary, copy.path, "SKILL_COPY_MOVE_FAILED");
  } catch (error) {
    let failure = error;
    if (copy.backup !== null) {
      try {
        await moveEntry(copy.backup, copy.path, "SKILL_COPY_MOVE_FAILED");
      } catch (rollbackError) {
        const primaryMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        // Keep the publication's reason and details: recovery must not replace the primary failure
        // with its own from/to/code. Include the recovery path in the message too, for CLI callers.
        failure = new SkillCopiesError(
          error instanceof SkillCopiesError ? error.reasonCode : "SKILL_COPY_MOVE_FAILED",
          `${primaryMessage}; rollback failed: ${rollbackMessage}; previous copy remains at ${copy.backup}`,
          {
            ...(error instanceof SkillCopiesError ? error.details : {}),
            backup: copy.backup,
            rollbackError: rollbackMessage,
            ...(rollbackError instanceof SkillCopiesError ? { rollbackCode: rollbackError.details.code ?? "UNKNOWN" } : {}),
          },
        );
      }
    }
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      const primaryMessage = failure instanceof Error ? failure.message : String(failure);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new SkillCopiesError(
        failure instanceof SkillCopiesError ? failure.reasonCode : "SKILL_COPY_MOVE_FAILED",
        `${primaryMessage}; temporary cleanup failed: ${cleanupMessage}; temporary path: ${temporary}`,
        {
          ...(failure instanceof SkillCopiesError ? failure.details : {}),
          temporary,
          cleanupError: cleanupMessage,
        },
      );
    }
    throw failure;
  }
}

/**
 * Place the skill tree as ~/.claude/skills/mana-orchestrate and ~/.agents/skills/mana-orchestrate
 * and record both copies' install-tree digests in skills.json (TCRN-CROSS-STORY-479 R4). A copy
 * that already holds the tree is kept; anything else at a copy's path is moved whole to
 * backups/<UTC instant>/skill-copies/<its path under the home> in the device directory first.
 */
export async function installSkillCopies(input: InstallSkillCopiesInput): Promise<SkillCopiesInstallReport> {
  const stamp = utcStamp(input.now);
  const home = resolve(input.home ?? homedir());
  const device = resolve(input.deviceHome ?? currentDeviceHome());
  const source = resolve(input.source);
  const digest = await sourceDigest(source);
  const lock = join(device, DEVICE_HOME_ENTRIES.locks, SKILL_COPIES_FILES.lock);
  await ensureDeviceDirectory(dirname(lock));
  return withFileLock(lock, async () => {
    const backupDir = join(backupsPath(device), stamp, SKILL_COPIES_FILES.backup);
    const planned: PlannedCopy[] = [];
    for (const root of SKILL_COPY_ROOTS) {
      const path = skillCopyPath(home, root);
      const existing = await lstatOrNull(path);
      let action: SkillCopyAction = "created";
      if (existing !== null) {
        const held = existing.isDirectory() ? await treeDigestOrNull(path) : null;
        action = held === digest.sha256 ? "reused" : "replaced";
      }
      const backup = action === "replaced" ? join(backupDir, ...root.root.split("/"), BRAND.helper.id) : null;
      if (backup !== null && await lstatOrNull(backup) !== null) {
        fail("SKILL_COPY_BACKUP_EXISTS", `${backup} already exists; a backup is never overwritten`, { backup });
      }
      planned.push({ host: root.host, path, action, backup });
    }
    for (const copy of planned) {
      if (copy.action !== "reused") await placeCopy(source, digest.sha256, copy);
    }
    const copies: SkillCopyRecord[] = planned.map((copy) => ({ host: copy.host, path: copy.path, installTreeDigest: digest.sha256 }));
    const recordPath = skillCopiesRecordPath(device);
    const previous = await loadRecord(recordPath);
    const recorded = previous.state === "valid" && canonicalJson(previous.record.copies) === canonicalJson(copies);
    const current = recorded && planned.every((copy) => copy.action === "reused");
    if (!current) {
      const record: SkillCopiesRecord = { schemaVersion: SKILL_COPIES_SCHEMA_VERSION, skill: BRAND.helper.id, installedAt: input.now, copies };
      await ensureDeviceDirectory(device);
      await writeFileAtomic(recordPath, canonicalJson(record));
    }
    return {
      reasonCode: current ? "SKILL_COPIES_CURRENT" : "SKILL_COPIES_INSTALLED",
      skill: BRAND.helper.id,
      installTreeDigest: digest.sha256,
      files: digest.files,
      record: recordPath,
      backupDir: planned.some((copy) => copy.backup !== null) ? backupDir : null,
      copies: planned.map((copy) => ({ host: copy.host, path: copy.path, action: copy.action, installTreeDigest: digest.sha256, backup: copy.backup })),
    };
  });
}

export type SkillCopyVerificationCode =
  | "SKILL_COPY_VERIFIED"
  | "SKILL_COPY_MISSING"
  | "SKILL_COPY_UNREADABLE"
  | "SKILL_COPY_NOT_RECORDED"
  | "SKILL_COPY_DIGEST_MISMATCH";

export interface SkillCopyVerification {
  readonly host: SkillCopyHost;
  readonly path: string;
  readonly ok: boolean;
  readonly reasonCode: SkillCopyVerificationCode;
  readonly recorded: string | null;
  readonly actual: string | null;
}

export interface SkillCopiesVerification {
  readonly ok: boolean;
  // In this order of precedence: the record is missing or unreadable, a copy does not verify, a
  // legacy helper copy is still in a host's root.
  readonly reasonCode:
    | "SKILL_COPIES_VERIFIED"
    | "SKILL_COPIES_NOT_RECORDED"
    | "SKILL_COPIES_RECORD_INVALID"
    | "SKILL_COPIES_DRIFTED"
    | "SKILL_COPIES_LEGACY_PRESENT";
  readonly record: string;
  readonly detail: string | null;
  readonly copies: readonly SkillCopyVerification[];
  readonly legacyCopies: readonly string[];
}

async function legacySkillCopies(home: string): Promise<{ readonly root: string; readonly path: string; readonly stats: Stats }[]> {
  const found: { readonly root: string; readonly path: string; readonly stats: Stats }[] = [];
  for (const root of LEGACY_SKILL_ROOTS) {
    const path = join(home, ...root.split("/"), LEGACY_HELPER_NAME);
    const stats = await lstatOrNull(path);
    if (stats !== null) found.push({ root, path, stats });
  }
  return found;
}

/**
 * Compare both copies with skills.json and look for a legacy helper copy in the three roots it was
 * ever placed in (TCRN-CROSS-STORY-479 R4, R5). Nothing is written.
 */
export async function verifySkillCopies(input: { readonly home?: string; readonly deviceHome?: string } = {}): Promise<SkillCopiesVerification> {
  const home = resolve(input.home ?? homedir());
  const device = resolve(input.deviceHome ?? currentDeviceHome());
  const recordPath = skillCopiesRecordPath(device);
  const loaded = await loadRecord(recordPath);
  const recorded = loaded.state === "valid" ? loaded.record.copies : [];
  const copies: SkillCopyVerification[] = [];
  for (const root of SKILL_COPY_ROOTS) {
    const path = skillCopyPath(home, root);
    const entry = recorded.find((copy) => copy.host === root.host && copy.path === path);
    const stats = await lstatOrNull(path);
    const actual = stats !== null && stats.isDirectory() ? await treeDigestOrNull(path) : null;
    let reasonCode: SkillCopyVerificationCode = "SKILL_COPY_VERIFIED";
    if (stats === null) reasonCode = "SKILL_COPY_MISSING";
    else if (actual === null) reasonCode = "SKILL_COPY_UNREADABLE";
    else if (entry === undefined) reasonCode = "SKILL_COPY_NOT_RECORDED";
    else if (actual !== entry.installTreeDigest) reasonCode = "SKILL_COPY_DIGEST_MISMATCH";
    copies.push({
      host: root.host,
      path,
      ok: reasonCode === "SKILL_COPY_VERIFIED",
      reasonCode,
      recorded: entry === undefined ? null : entry.installTreeDigest,
      actual,
    });
  }
  const legacyCopies = (await legacySkillCopies(home)).map((copy) => copy.path);
  let reasonCode: SkillCopiesVerification["reasonCode"] = "SKILL_COPIES_VERIFIED";
  if (loaded.state === "missing") reasonCode = "SKILL_COPIES_NOT_RECORDED";
  else if (loaded.state === "invalid") reasonCode = "SKILL_COPIES_RECORD_INVALID";
  else if (copies.some((copy) => !copy.ok)) reasonCode = "SKILL_COPIES_DRIFTED";
  else if (legacyCopies.length > 0) reasonCode = "SKILL_COPIES_LEGACY_PRESENT";
  return {
    ok: reasonCode === "SKILL_COPIES_VERIFIED",
    reasonCode,
    record: recordPath,
    detail: loaded.state === "invalid" ? loaded.detail : null,
    copies,
    legacyCopies,
  };
}

export type LegacySkillCleanupKind = "skill-copy" | "marker";
export type LegacyEntryType = "directory" | "file" | "symlink" | "other";

export interface LegacySkillCleanupItem {
  readonly kind: LegacySkillCleanupKind;
  readonly path: string;
  readonly entryType: LegacyEntryType;
  // Where the entry goes under the backup root, with POSIX separators: a copy keeps its place
  // under the home directory, a marker goes under the old device directory's name.
  readonly backupPath: string;
}

export interface LegacySkillCleanupPlan {
  readonly home: string;
  readonly legacyDeviceHome: string;
  readonly items: readonly LegacySkillCleanupItem[];
}

function entryType(stats: Stats): LegacyEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * List what the legacy helper left on this machine (TCRN-CROSS-STORY-479 R5): its copies under
 * ~/.claude/skills, ~/.agents/skills and ~/.codex/skills, and its install markers in the old device
 * directory (installed-copy-*.json, skill-archive.json, complete-skill-archive.provenance.json,
 * trusted-bootstrap.mjs, state.json). Nothing else in that directory is listed, and nothing is written.
 */
export async function legacySkillCleanupPlan(input: { readonly home?: string; readonly legacyDeviceHome?: string } = {}): Promise<LegacySkillCleanupPlan> {
  const home = resolve(input.home ?? homedir());
  const legacyDeviceHome = resolve(input.legacyDeviceHome ?? join(home, LEGACY_DEVICE_DIRECTORY));
  const items: LegacySkillCleanupItem[] = (await legacySkillCopies(home)).map((copy) => ({
    kind: "skill-copy",
    path: copy.path,
    entryType: entryType(copy.stats),
    backupPath: `${copy.root}/${LEGACY_HELPER_NAME}`,
  }));
  let names: string[] = [];
  try {
    names = await readdir(legacyDeviceHome);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  for (const name of names.filter(isLegacySkillMarker).sort(compareCanonicalText)) {
    const path = join(legacyDeviceHome, name);
    const stats = await lstatOrNull(path);
    if (stats !== null) items.push({ kind: "marker", path, entryType: entryType(stats), backupPath: `${LEGACY_DEVICE_DIRECTORY}/${name}` });
  }
  return { home, legacyDeviceHome, items };
}

export interface MovedLegacyEntry {
  readonly path: string;
  readonly backup: string;
}

export interface LegacySkillCleanupResult {
  readonly reasonCode: "LEGACY_SKILL_CLEANUP_APPLIED" | "LEGACY_SKILL_CLEANUP_NOTHING_TO_MOVE";
  readonly backupRoot: string;
  readonly moved: readonly MovedLegacyEntry[];
  // Planned entries that were no longer there: applying a plan a second time moves nothing.
  readonly absent: readonly string[];
}

function isInside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset !== "" && !isAbsolute(offset) && offset.split(sep)[0] !== "..";
}

/**
 * Move every entry of a plan under `backupRoot` (TCRN-CROSS-STORY-479 R5). Nothing is deleted:
 * each entry is renamed whole to its backup path, and a backup path that is already taken refuses
 * the whole cleanup before anything moves.
 */
export async function applyLegacySkillCleanup(plan: LegacySkillCleanupPlan, options: { readonly backupRoot: string }): Promise<LegacySkillCleanupResult> {
  const backupRoot = resolve(options.backupRoot);
  const pending: MovedLegacyEntry[] = [];
  const absent: string[] = [];
  for (const item of plan.items) {
    const segments = item.backupPath.split("/");
    if (isAbsolute(item.backupPath) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      fail("LEGACY_SKILL_CLEANUP_PLAN_INVALID", `${item.backupPath} is not a relative backup path`, { backupPath: item.backupPath });
    }
    if (!isInside(plan.home, item.path) && !isInside(plan.legacyDeviceHome, item.path)) {
      fail("LEGACY_SKILL_CLEANUP_PLAN_INVALID", `${item.path} is outside the home and the old device directory`, { path: item.path });
    }
    if (await lstatOrNull(item.path) === null) {
      absent.push(item.path);
      continue;
    }
    const backup = join(backupRoot, ...segments);
    if (await lstatOrNull(backup) !== null) {
      fail("LEGACY_SKILL_CLEANUP_BACKUP_EXISTS", `${backup} already exists; a backup is never overwritten`, { backup });
    }
    pending.push({ path: item.path, backup });
  }
  const moved: MovedLegacyEntry[] = [];
  for (const entry of pending) {
    await mkdir(dirname(entry.backup), { recursive: true });
    await moveEntry(entry.path, entry.backup, "LEGACY_SKILL_CLEANUP_MOVE_FAILED");
    moved.push(entry);
  }
  return {
    reasonCode: moved.length > 0 ? "LEGACY_SKILL_CLEANUP_APPLIED" : "LEGACY_SKILL_CLEANUP_NOTHING_TO_MOVE",
    backupRoot,
    moved,
    absent,
  };
}
