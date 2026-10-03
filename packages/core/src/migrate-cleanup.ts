// SPDX-License-Identifier: Apache-2.0
import { renameRetryBudget } from "./io-policy.js";

// TCRN-CROSS-STORY-489 R3, AC2 (TCRN-CROSS-SUB-366; MIN-238 D4; TCRN-CROSS-STORY-479 R5): what setup
// --mode migrate takes off this device once it has imported and registered the partitions, before
// the fresh mode's wiring puts in what is new (setup.ts). The old platform harness left six kinds
// of thing, and each is either written again without what was ours (update, its original copied
// first) or moved whole into this run's backups in the device directory (move); nothing is deleted:
//
//   host-file        each host's hook files, rendered by host-hooks.ts: in the user's home with the
//                    one Einzbern hook (and the two pointer hooks when navigation is declined), in
//                    each project the mapping names (the container root among them) and the project
//                    setup runs for with none. The old harness's hook groups on every event, the
//                    permissions.deny rules that fenced the old directories and the old inert key
//                    come out; other tools' hooks and every other key stay; Codex's hooks switch
//                    stays on and the trust state of each hook that went goes with it. A file with
//                    nothing of ours to take out is not a cleanup item: the user's is the wiring's
//                    to write, a project's stays as it is.
//   template         the old adapter's template directories, .claude/<old engine name>/ and
//                    .codex/<old engine name>/, in the home and in each of those projects
//   injection-state  the old injection chain's state directory in the home
//   launcher         the old portal's three launchers in the root of each of those projects
//   skill-copy       the old helper's copies in the hosts' skill roots, and
//   marker           the install markers its retired trust chain left in the old device directory,
//                    both listed and moved by skill-copies.ts
//
// Everything goes into backups/<UTC second>/ of the device directory, laid out as each module that
// writes a backup lays it out: host-hooks/<root key>/<file> for a host file's original (as
// applyHostHooks copies it) and for each template directory, laid out as under its root, with the
// injection state under the home's key; launchers/<root key>/<name> for an old launcher; and
// skill-copies/<place> for the old helper's copies and markers (as applyLegacySkillCleanup moves
// them). A root key is the first sixteen hexadecimal digits of the SHA-256 of the root's path, as
// applyHostHooks names a root. The old workspaces' container and the platform archive are in no list,
// and the old device directory stays where it is, with its old engine copy, less its markers.
//
// planCleanup writes nothing: it records each file, template, launcher, state directory, copy and
// marker the apply would write or move, the original it copies first, and what stops the apply (a
// host file host-hooks.ts will not render, a backup place already taken, since a backup is never
// overwritten, and an entry on another volume than the device directory, which a rename cannot
// move). applyCleanup reads everything again before it writes it, so a second run finds nothing.

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// The barrel is loaded first, so every module below is evaluated in the order the engine's own entry
// evaluates it, whichever module a caller imports first.
import "./index.js";
import { backupsPath } from "./device-home.js";
import { HOST_HOOK_FILES, HOST_HOOK_HOSTS, applyHostHooks, planHostHooks, readHostHooks } from "./host-hooks.js";
import type { HostHookFile, HostHookHost, HostHookScope, HostHooksPlan } from "./host-hooks.js";
import type { AgentsNavigationChoice } from "./machine-settings.js";
import type { MigrationCleanupItem } from "./migrate-legacy.js";
import { LEGACY_DEVICE_DIRECTORY, LEGACY_ENGINE_NAME, LEGACY_INJECTION_STATE_DIRECTORY } from "./names.js";
import type { SetupStep } from "./setup.js";
import { entryKind, messageOf, reasonOf } from "./setup-fresh.js";
import type { SetupRecorder } from "./setup-fresh.js";
import { SkillCopiesError, applyLegacySkillCleanup, legacySkillCleanupPlan } from "./skill-copies.js";
import type { LegacySkillCleanupPlan } from "./skill-copies.js";

export const MIGRATE_CLEANUP_REASON_CODES = Object.freeze([
  // Something is already where an entry would be moved to; a backup is never overwritten.
  "MIGRATE_CLEANUP_BACKUP_EXISTS",
  // An entry sits on another volume than the device directory, so a rename cannot move it.
  "MIGRATE_CLEANUP_CROSS_VOLUME",
  "MIGRATE_CLEANUP_MOVE_FAILED",
] as const);
export type MigrateCleanupReasonCode = typeof MIGRATE_CLEANUP_REASON_CODES[number];

export class MigrateCleanupError extends Error {
  readonly reasonCode: MigrateCleanupReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: MigrateCleanupReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "MigrateCleanupError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: MigrateCleanupReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new MigrateCleanupError(reasonCode, message, details);
}

// The old adapter's template directories, relative to a root, with POSIX separators.
export const LEGACY_TEMPLATE_DIRECTORIES: readonly string[] = Object.freeze([`.claude/${LEGACY_ENGINE_NAME}`, `.codex/${LEGACY_ENGINE_NAME}`]);
// The old portal's launchers in a project's root: one each for cmd.exe, Finder and a POSIX shell.
export const LEGACY_PORTAL_LAUNCHERS: readonly string[] = Object.freeze([".cmd", ".command", ".sh"].map((extension) => `${LEGACY_ENGINE_NAME}-portal${extension}`));

export type MigrateCleanupKind = "host-file" | "template" | "injection-state" | "launcher" | "skill-copy" | "marker";

/** One thing the cleanup takes off: {path, action, into} (the plan's hostCleanup) and what kind of thing it is. */
export interface MigrateCleanupItem extends MigrationCleanupItem {
  readonly kind: MigrateCleanupKind;
}

export interface MigrateCleanupInput {
  // The user's home, where both hosts keep their user hooks and skills and Codex its config.toml.
  readonly home: string;
  // The device directory, whose backups/<UTC second>/ receives everything.
  readonly deviceHome: string;
  // The old device directory, which holds the old helper's install markers; the home's when null.
  readonly legacyDeviceHome: string | null;
  // The projects whose own host files, templates and launchers are cleaned: each project the mapping
  // names and the project setup runs for. One that is not a directory is passed over (the plan
  // already stops at it).
  readonly projectRoots: readonly string[];
  // The navigation answer the user's hook files are rendered with.
  readonly navigation: AgentsNavigationChoice;
}

export interface MigrateCleanupApplyInput extends MigrateCleanupInput {
  // The instant the backups are named by, to the second: the recorder's.
  readonly at: string;
}

// ---- Small readers ----

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** The key a root's backups are filed under: the first sixteen hexadecimal digits of the SHA-256 of its path, as applyHostHooks names it. */
export function cleanupRootKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

interface CleanupRoots {
  readonly home: string;
  readonly projects: readonly string[];
}

// The home and the projects as host-hooks.ts names them (resolved, not followed through links); a
// project that is not a directory, or that is the home, is left out.
async function cleanupRoots(input: MigrateCleanupInput): Promise<CleanupRoots> {
  const home = resolve(input.home);
  const realHome = await realpath(home).catch(() => home);
  const projects: string[] = [];
  for (const given of input.projectRoots) {
    const root = resolve(given);
    if (root === home || root === realHome || projects.includes(root)) continue;
    if (await entryKind(root) !== "directory") continue;
    projects.push(root);
  }
  return { home, projects };
}

function addItem(items: MigrateCleanupItem[], item: MigrateCleanupItem): void {
  if (!items.some((entry) => entry.path === item.path)) items.push(item);
}

// ---- Host files ----

interface HostTarget {
  readonly root: string;
  readonly scope: HostHookScope;
  readonly host: HostHookHost;
}

// The user's files first, then each project's, each host in host-hooks.ts's order.
function hostTargets(roots: CleanupRoots): readonly HostTarget[] {
  return [
    ...HOST_HOOK_HOSTS.map((host): HostTarget => ({ root: roots.home, scope: "user", host })),
    ...roots.projects.flatMap((root) => HOST_HOOK_HOSTS.map((host): HostTarget => ({ root, scope: "project", host }))),
  ];
}

function readTarget(target: HostTarget, input: MigrateCleanupInput, home: string): Promise<HostHooksPlan> {
  const user = target.scope === "user";
  const expectation = planHostHooks({
    host: target.host,
    scope: target.scope,
    deviceHome: input.deviceHome,
    navigation: user ? input.navigation : null,
    install: user,
  });
  return readHostHooks(expectation, { root: target.root, home });
}

// Whether rendering takes out something of ours: an old or surplus hook, an old deny rule, the old
// inert key, or a trust state whose hook went.
function takesOut(plan: HostHooksPlan): boolean {
  return plan.removedHooks.length + plan.removedDenyRules.length + plan.removedKeys.length + plan.removedTrustStates.length > 0;
}

// Where applyHostHooks copies a file's original in this run.
function hostFileBackup(recorder: SetupRecorder, file: HostHookFile): string {
  return join(recorder.backupDirectory("host-hooks"), cleanupRootKey(file.root), ...file.name.split("/"));
}

// Record the files a rendering writes, as the host-hooks step records them; each that was there
// before is a cleanup item.
function recordHostFiles(recorder: SetupRecorder, plan: HostHooksPlan, items: MigrateCleanupItem[]): void {
  for (const file of plan.files) {
    if (!file.changed || file.after === null) continue;
    recorder.write("host-hooks", file.path, file.before === null ? "create" : "update");
    if (file.before === null) continue;
    recorder.backup("host-hooks", file.path);
    addItem(items, { kind: "host-file", path: file.path, action: "update", into: hostFileBackup(recorder, file) });
  }
}

// ---- Moves ----

interface Move {
  readonly kind: MigrateCleanupKind;
  readonly step: SetupStep;
  readonly path: string;
  readonly into: string;
}

interface Moves {
  // The templates, the injection state and the launchers, which this module moves.
  readonly own: readonly Move[];
  // The old helper's copies and markers, which skill-copies.ts moves.
  readonly skills: LegacySkillCleanupPlan;
  readonly skillMoves: readonly Move[];
}

async function moveTargets(recorder: SetupRecorder, input: MigrateCleanupInput, roots: CleanupRoots): Promise<Moves> {
  const own: Move[] = [];
  const hostBackups = recorder.backupDirectory("host-hooks");
  for (const root of [roots.home, ...roots.projects]) {
    for (const template of LEGACY_TEMPLATE_DIRECTORIES) {
      const segments = template.split("/");
      const path = join(root, ...segments);
      if (await lstatOrNull(path) !== null) own.push({ kind: "template", step: "host-hooks", path, into: join(hostBackups, cleanupRootKey(root), ...segments) });
    }
  }
  const injection = join(roots.home, LEGACY_INJECTION_STATE_DIRECTORY);
  if (await lstatOrNull(injection) !== null) {
    own.push({ kind: "injection-state", step: "host-hooks", path: injection, into: join(hostBackups, cleanupRootKey(roots.home), LEGACY_INJECTION_STATE_DIRECTORY) });
  }
  for (const root of roots.projects) {
    for (const name of LEGACY_PORTAL_LAUNCHERS) {
      const path = join(root, name);
      if (await lstatOrNull(path) !== null) own.push({ kind: "launcher", step: "launchers", path, into: join(recorder.backupDirectory("launchers"), cleanupRootKey(root), name) });
    }
  }
  const skills = await legacySkillCleanupPlan({ home: roots.home, legacyDeviceHome: input.legacyDeviceHome ?? join(roots.home, LEGACY_DEVICE_DIRECTORY) });
  const skillBackups = recorder.backupDirectory("skill-copies");
  const skillMoves = skills.items.map((item): Move => ({ kind: item.kind, step: "skill-copies", path: item.path, into: join(skillBackups, ...item.backupPath.split("/")) }));
  return { own, skills, skillMoves };
}

// The nearest part of a path that exists, the path itself included.
async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    if (await lstatOrNull(current) !== null) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

interface MoveRefusal {
  readonly reasonCode: string;
  readonly message: string;
}

function isSkillMove(move: Move): boolean {
  return move.kind === "skill-copy" || move.kind === "marker";
}

// What stops a move: a backup place that is taken (skill-copies.ts names its own with its own code),
// or a device directory on another volume than the entry.
async function moveRefusal(move: Move): Promise<MoveRefusal | null> {
  if (await lstatOrNull(move.into) !== null) {
    return {
      reasonCode: isSkillMove(move) ? "LEGACY_SKILL_CLEANUP_BACKUP_EXISTS" : "MIGRATE_CLEANUP_BACKUP_EXISTS",
      message: `${move.into} already exists; a backup is never overwritten`,
    };
  }
  const source = await lstatOrNull(move.path);
  if (source === null) return null;
  const target = await stat(await nearestExisting(dirname(move.into)));
  if (source.dev === target.dev) return null;
  return {
    reasonCode: "MIGRATE_CLEANUP_CROSS_VOLUME",
    message: `${move.path} is on another volume than the device directory's backups, and a move is a rename: move it by hand or put the device directory on its volume`,
  };
}

function refuse(move: Move, refusal: MoveRefusal): never {
  if (refusal.reasonCode === "LEGACY_SKILL_CLEANUP_BACKUP_EXISTS") throw new SkillCopiesError("LEGACY_SKILL_CLEANUP_BACKUP_EXISTS", refusal.message, { backup: move.into });
  return fail(refusal.reasonCode === "MIGRATE_CLEANUP_CROSS_VOLUME" ? "MIGRATE_CLEANUP_CROSS_VOLUME" : "MIGRATE_CLEANUP_BACKUP_EXISTS", refusal.message, { path: move.path, into: move.into });
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

// Move an entry by renaming it. On Windows a rename of a directory another process holds open (an
// indexer, an antivirus scanner) fails for a moment, so those failures are retried with backoff. A
// move to another volume (EXDEV) is refused rather than turned into copy and delete.
async function moveEntry(from: string, to: string): Promise<void> {
  const retries = renameRetryBudget();
  let wait = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = String((error as { code?: string }).code ?? "UNKNOWN");
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= retries) fail("MIGRATE_CLEANUP_MOVE_FAILED", `${from} could not be moved to ${to} (${code})`, { from, to, code });
      await delay(wait);
      wait = Math.min(wait * 2, 500);
    }
  }
}

function recordMove(recorder: SetupRecorder, move: Move, items: MigrateCleanupItem[]): void {
  recorder.write(move.step, move.path, "move");
  recorder.backup(move.step, move.path);
  addItem(items, { kind: move.kind, path: move.path, action: "move", into: move.into });
}

// ---- The plan and the apply ----

/**
 * Plan the cleanup (TCRN-CROSS-STORY-489 R3): each host file rendered without what was ours, then
 * each template directory, the injection state, each old launcher and the old helper's copies and
 * markers moved, in the order the apply takes them. The writes, the originals copied first and what
 * stops the apply go into the recorder; the answer is the plan's hostCleanup. Nothing is written. A
 * user host file host-hooks.ts will not render is the wiring's blocker (setup-fresh.ts plans the same
 * file), so it is not recorded twice.
 */
export async function planCleanup(recorder: SetupRecorder, input: MigrateCleanupInput): Promise<readonly MigrateCleanupItem[]> {
  const roots = await cleanupRoots(input);
  const items: MigrateCleanupItem[] = [];
  for (const target of hostTargets(roots)) {
    let plan: HostHooksPlan;
    try {
      plan = await readTarget(target, input, roots.home);
    } catch (error) {
      const reasonCode = reasonOf(error);
      if (reasonCode === null) throw error;
      if (target.scope === "project") recorder.block("host-hooks", join(target.root, ...HOST_HOOK_FILES[target.host].split("/")), reasonCode, messageOf(error));
      continue;
    }
    if (takesOut(plan)) recordHostFiles(recorder, plan, items);
  }
  const moves = await moveTargets(recorder, input, roots);
  for (const move of [...moves.own, ...moves.skillMoves]) {
    const refusal = await moveRefusal(move);
    if (refusal !== null) recorder.block(move.step, move.path, refusal.reasonCode, refusal.message);
    recordMove(recorder, move, items);
  }
  return items;
}

/**
 * Apply the cleanup (TCRN-CROSS-STORY-489 R3, AC2): every entry to move is checked first, so a taken
 * backup place or another volume stops the cleanup before anything is written; then each host file
 * is read again and rendered, and written when that takes out something of ours, its original copied
 * first (applyHostHooks); then each entry is renamed whole into its backup. Answers what was done, in
 * the plan's shape; a second run finds nothing and writes nothing.
 */
export async function applyCleanup(recorder: SetupRecorder, input: MigrateCleanupApplyInput): Promise<readonly MigrateCleanupItem[]> {
  const roots = await cleanupRoots(input);
  const items: MigrateCleanupItem[] = [];
  const moves = await moveTargets(recorder, input, roots);
  for (const move of [...moves.own, ...moves.skillMoves]) {
    const refusal = await moveRefusal(move);
    if (refusal !== null) refuse(move, refusal);
  }
  // One host file after another, each read right before it is written: a Codex config.toml that one
  // rendering changed is read again for the next.
  for (const target of hostTargets(roots)) {
    const plan = await readTarget(target, input, roots.home);
    if (!takesOut(plan)) continue;
    await applyHostHooks(plan, { at: input.at, backupRoot: backupsPath(input.deviceHome) });
    recordHostFiles(recorder, plan, items);
  }
  for (const move of moves.own) {
    await mkdir(dirname(move.into), { recursive: true });
    await moveEntry(move.path, move.into);
    recordMove(recorder, move, items);
  }
  const moved = await applyLegacySkillCleanup(moves.skills, { backupRoot: recorder.backupDirectory("skill-copies") });
  for (const entry of moved.moved) {
    const planned = moves.skillMoves.find((move) => move.path === entry.path);
    if (planned !== undefined) recordMove(recorder, { ...planned, into: entry.backup }, items);
  }
  return items;
}
