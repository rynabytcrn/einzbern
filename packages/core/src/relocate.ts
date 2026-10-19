// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-470 R3, AC2, AC3 (MIN-227 D19, D20): move a library. The target must not exist
// or be an empty directory, must not be inside the library or contain it, and must be writable.
// Under this machine's lock of the library every file and directory is copied, each file checked
// by SHA-256 as it lands, and the copy is compared with the source file by file with the backup
// witness's digests. The copy is then replayed from genesis and must reach the same stream heads
// and version vector. The destination stays guarded until the source receives a durable relocation
// receipt/tombstone and this device's registry points at the new place. The source still reads, and every write there
// refuses LIBRARY_TOMBSTONED. Nothing is deleted from the old place. A failure before the
// tombstone removes only unchanged, identity-matching attempt entries; the source is untouched.
// An interrupted publication is resumed from its source receipt by retrying the same command.
//
// TCRN-CROSS-STORY-470 R5: the move then wires the hosts itself. Every project this device has
// registered for the library names the new place in its own host settings when the library now
// sits outside it (host-writable-roots.ts), and the report says, project by project, what was
// written or why it could not be; a project whose wiring fails does not undo the move.

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { isAtomicTemporaryName, writeFileAtomic } from "./atomic-file.js";
import { readAllStreams, withLibraryWriteLock } from "./akasha.js";
import { suggestCloudHosted } from "./cloud-roots.js";
import { openLibrary } from "./ether-library.js";
import { applyWritableRoots, planWritableRoots } from "./host-writable-roots.js";
import type { AppliedWritableRoots } from "./host-writable-roots.js";
import { DIRECTORY } from "./names.js";
import { withLibraryRepointLock } from "./registry.js";
import { FileLockError } from "./file-lock.js";
import { libraryTreeDigests } from "./workspace-snapshot.js";
import {
  LIBRARY_TOMBSTONE_FILE,
  LIBRARY_TOMBSTONE_SCHEMA_VERSION,
  materializeLibraryRead,
  readLibraryTombstone,
  withWorkspaceWriteLock,
  WorkspaceError,
} from "./workspace.js";
import type { LibraryTombstone } from "./workspace.js";

export const RELOCATE_REASON_CODES = Object.freeze([
  "RELOCATE_RECOVERY_REQUIRED",
  "RELOCATE_COPY_MISMATCH",
  "RELOCATE_REPLAY_MISMATCH",
  "RELOCATE_TARGET_INSIDE_SOURCE",
  "RELOCATE_TARGET_NOT_EMPTY",
  "RELOCATE_TARGET_NOT_WRITABLE",
] as const);
export type RelocateReasonCode = typeof RELOCATE_REASON_CODES[number];

export class RelocateError extends Error {
  readonly reasonCode: RelocateReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: RelocateReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "RelocateError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface RelocateOptions {
  readonly at: string;
  readonly timeoutMs?: number;
  // The user's flag for the new place; left out, the cloud folder table's suggestion.
  readonly cloudHosted?: boolean;
  // Test seam: what lands in the target for one source file (a relocation copies it unchanged).
  readonly publicationStepForTest?: (phase: "copy-verified" | "before-source-tombstone" | "source-tombstoned" | "registry-repointed") => void | Promise<void>;
  readonly copyTransformForTest?: (relativePath: string, bytes: Buffer) => Buffer;
}

// One registered project's host wiring after the move: what was written, or why it could not be.
export interface RelocationHostWiringFailure {
  readonly reasonCode: string;
  readonly projectRoot: string;
  readonly error: string;
}
export type RelocationHostWiring = AppliedWritableRoots | RelocationHostWiringFailure;

export interface RelocationReport {
  readonly reasonCode: "LIBRARY_RELOCATED";
  readonly transactionId: string;
  readonly occurredAt: string;
  readonly receiptDisposition: "completed" | "resumed" | "historical-completion";
  readonly libraryId: string;
  readonly from: string;
  readonly to: string;
  readonly files: number;
  readonly bytes: number;
  readonly headEventHash: string | null;
  readonly versionVector: Readonly<Record<string, number>>;
  readonly registryEntries: number;
  readonly cloudHosted: boolean;
  readonly suggestedCloudHosted: boolean;
  readonly tombstone: LibraryTombstone;
  readonly hostWiring: readonly RelocationHostWiring[];
}

function fail(reasonCode: RelocateReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new RelocateError(reasonCode, message, details);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

// The real path of `path` even where it does not exist yet: its nearest existing ancestor's real
// path, joined with the rest.
async function realTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(current.slice(parent.length).replace(/^[\\/]+/u, ""));
      current = parent;
    }
  }
}

interface RootIdentity { readonly path: string; readonly dev: string; readonly ino: string }
interface OwnedEntry extends RootIdentity { readonly kind: "file" | "directory"; readonly digest?: string }
interface PendingGuard extends LibraryTombstone {
  readonly kind: "relocation-pending";
  readonly transactionId: string;
  readonly source: RootIdentity;
  readonly target: RootIdentity;
  readonly sourceTreeDigest: string;
  readonly owned: readonly OwnedEntry[];
}
interface RelocationReceipt {
  readonly schemaVersion: "einzbern.relocation-receipt.v1";
  readonly guard: PendingGuard;
  readonly report: Omit<RelocationReport, "hostWiring">;
  readonly projectRoots: readonly string[];
  readonly streams: readonly { readonly deviceId: string; readonly streamId: string; readonly sequence: number; readonly eventHash: string | null }[];
}

async function identity(path: string): Promise<RootIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RELOCATE_RECOVERY_REQUIRED", `${path} is not the recorded directory`, { target: path });
  return { path, dev: String(metadata.dev), ino: String(metadata.ino) };
}

async function sameIdentity(recorded: RootIdentity): Promise<boolean> {
  try {
    const current = await identity(recorded.path);
    return current.path === recorded.path && current.dev === recorded.dev && current.ino === recorded.ino;
  } catch { return false; }
}

function recovery(guard: PendingGuard, message: string): never {
  fail("RELOCATE_RECOVERY_REQUIRED", message, {
    source: guard.source.path, target: guard.target.path, transactionId: guard.transactionId,
    remedy: "Retry workspace-relocate with the same source and target after publication; before publication use workspace-relocate-discard --workspace <source> --to <target> --transaction-id <transactionId> to remove only verified attempt-owned entries.",
  });
}

async function guardText(target: string): Promise<string | null> {
  try { return await readFile(join(target, LIBRARY_TOMBSTONE_FILE), "utf8"); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
}

function parseGuard(text: string): PendingGuard | null {
  try {
    const value = JSON.parse(text) as PendingGuard;
    const validIdentity = (entry: RootIdentity): boolean => entry !== null && typeof entry === "object" && typeof entry.path === "string" && isAbsolute(entry.path) && resolve(entry.path) === entry.path && /^\d+$/u.test(entry.dev) && /^\d+$/u.test(entry.ino);
    if (value.kind !== "relocation-pending" || value.schemaVersion !== LIBRARY_TOMBSTONE_SCHEMA_VERSION ||
        typeof value.transactionId !== "string" || !/^[a-f0-9]{32}$/u.test(value.transactionId) ||
        typeof value.libraryId !== "string" || !validIdentity(value.source) || !validIdentity(value.target) ||
        inside(value.source.path, value.target.path) || inside(value.target.path, value.source.path) ||
        value.movedTo !== value.source.path || typeof value.sourceTreeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceTreeDigest) ||
        !Array.isArray(value.owned) || value.owned.some(entry => !validIdentity(entry) ||
          !["file", "directory"].includes(entry.kind) || (entry.kind === "file" && (!inside(value.target.path, entry.path) || entry.path === join(value.target.path, LIBRARY_TOMBSTONE_FILE) || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.digest))) ||
          (entry.kind === "directory" && !inside(value.target.path, entry.path) && !inside(entry.path, value.target.path)))) return null;
    if (new Set(value.owned.map(entry => entry.path)).size !== value.owned.length) return null;
    assertStrictInstant(value.movedAt);
    return value;
  } catch { return null; }
}

function parseReceipt(text: string): RelocationReceipt | null {
  try {
    const tombstone = JSON.parse(text) as LibraryTombstone & { relocation?: RelocationReceipt };
    const receipt = tombstone.relocation;
    if (receipt?.schemaVersion !== "einzbern.relocation-receipt.v1") return null;
    const guard = parseGuard(canonicalJson(receipt.guard as unknown as JsonValue));
    if (guard === null) return null;
    const report = receipt.report;
    const nonnegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
    if (report === null || typeof report !== "object" || report.reasonCode !== "LIBRARY_RELOCATED" ||
        report.transactionId !== guard.transactionId || report.occurredAt !== guard.movedAt || report.receiptDisposition !== "completed" ||
        report.libraryId !== guard.libraryId || report.from !== guard.source.path || report.to !== guard.target.path ||
        !nonnegative(report.files) || !nonnegative(report.bytes) || !nonnegative(report.registryEntries) ||
        !(report.headEventHash === null || typeof report.headEventHash === "string") ||
        typeof report.cloudHosted !== "boolean" || typeof report.suggestedCloudHosted !== "boolean" ||
        report.versionVector === null || typeof report.versionVector !== "object" || Array.isArray(report.versionVector) ||
        Object.values(report.versionVector).some(value => !nonnegative(value)) ||
        !Array.isArray(receipt.projectRoots) || receipt.projectRoots.some(path => typeof path !== "string" || !isAbsolute(path)) ||
        new Set(receipt.projectRoots).size !== receipt.projectRoots.length || receipt.projectRoots.length !== report.registryEntries ||
        !Array.isArray(receipt.streams) || receipt.streams.some(stream => stream === null || typeof stream !== "object" ||
          typeof stream.deviceId !== "string" || typeof stream.streamId !== "string" || !nonnegative(stream.sequence) ||
          !(stream.eventHash === null || typeof stream.eventHash === "string") || report.versionVector[stream.deviceId] !== stream.sequence) ||
        new Set(receipt.streams.map(stream => stream.deviceId)).size !== receipt.streams.length ||
        Object.keys(report.versionVector).length !== receipt.streams.length) return null;
    const expected = { schemaVersion: LIBRARY_TOMBSTONE_SCHEMA_VERSION, libraryId: guard.libraryId, movedTo: guard.target.path, movedAt: guard.movedAt };
    if (canonicalJson(report.tombstone as unknown as JsonValue) !== canonicalJson(expected) ||
        tombstone.schemaVersion !== expected.schemaVersion || tombstone.libraryId !== expected.libraryId ||
        tombstone.movedTo !== expected.movedTo || tombstone.movedAt !== expected.movedAt) return null;
    return receipt;
  } catch { return null; }
}

async function assertGuard(guard: PendingGuard): Promise<void> {
  if (!await sameIdentity(guard.source) || !await sameIdentity(guard.target) ||
      await guardText(guard.target.path) !== canonicalJson(guard as unknown as JsonValue)) recovery(guard, "relocation identities or pending guard changed; no recovery writes were made");
}

async function treeDigest(root: string, guard?: PendingGuard): Promise<string> {
  if (guard !== undefined) await assertGuard(guard);
  const files = await libraryTreeDigests(root);
  // Exclude only the exact validated attempt guard, never an arbitrary tombstone/file.
  return sha256(canonicalJson(files.filter(entry => guard === undefined || entry.path !== LIBRARY_TOMBSTONE_FILE) as unknown as JsonValue));
}

async function createOwnedDirectory(path: string, owned: OwnedEntry[]): Promise<void> {
  await mkdir(path);
  owned.push({ ...await identity(path), kind: "directory" });
}

async function prepareTarget(target: string, owned: OwnedEntry[]): Promise<RootIdentity> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try { await lstat(current); break; }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; missing.push(current); current = dirname(current); }
  }
  for (const directory of missing.reverse()) await createOwnedDirectory(directory, owned);
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RELOCATE_TARGET_NOT_EMPTY", `${target} is not a directory`, { target });
  const result = await identity(target);
  if ((await readdir(target)).length > 0) fail("RELOCATE_TARGET_NOT_EMPTY", `${target} is not empty`, { target });
  return result;
}

async function writeOwnedFile(path: string, bytes: Uint8Array, owned: OwnedEntry[]): Promise<void> {
  const handle = await open(path, "wx");
  try {
    const metadata = await handle.stat({ bigint: true });
    // Record the intended digest first: a partial write is retained rather than guessed safe to remove.
    owned.push({ path, dev: String(metadata.dev), ino: String(metadata.ino), kind: "file", digest: sha256(bytes) });
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

// No recursive deletion, no directory enumeration used as a deletion list, and no unlink of a
// replacement/modified entry. An incomplete cleanup keeps the pending guard and its durable ledger.
async function cleanOwned(guard: PendingGuard): Promise<boolean> {
  await assertGuard(guard);
  for (const entry of [...guard.owned].reverse()) {
    if (entry.kind === "directory" && inside(entry.path, guard.target.path)) continue;
    const metadata = await lstat(entry.path, { bigint: true }).catch(error => { if ((error as { code?: string }).code === "ENOENT") return null; throw error; });
    if (metadata === null) continue;
    for (const ancestor of guard.owned.filter(candidate => candidate.kind === "directory" && candidate.path !== entry.path && inside(candidate.path, entry.path))) {
      if (!await sameIdentity(ancestor).catch(() => false)) return false;
    }
    if (String(metadata.dev) !== entry.dev || String(metadata.ino) !== entry.ino || metadata.isSymbolicLink()) return false;
    if (entry.kind === "file") {
      if (!metadata.isFile() || sha256(await readFile(entry.path)) !== entry.digest) return false;
      await unlink(entry.path);
    } else {
      if (!metadata.isDirectory()) return false;
      try { await rmdir(entry.path); } catch { return false; }
    }
  }
  if ((await readdir(guard.target.path)).some(name => name !== LIBRARY_TOMBSTONE_FILE)) return false;
  await assertGuard(guard);
  await unlink(join(guard.target.path, LIBRARY_TOMBSTONE_FILE));
  for (const entry of [...guard.owned].reverse().filter(entry => entry.kind === "directory" && inside(entry.path, guard.target.path))) {
    if (!await sameIdentity(entry).catch(() => false)) continue;
    // Keep an ancestor containing unrelated content; never recursively remove it.
    await rmdir(entry.path).catch(() => undefined);
  }
  return true;
}

async function copyTree(source: string, target: string, options: RelocateOptions, owned: OwnedEntry[], persist: () => Promise<void>): Promise<{ readonly files: number; readonly bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (isAtomicTemporaryName(entry.name) || entry.name === LIBRARY_TOMBSTONE_FILE) continue;
      const sourcePath = join(from, entry.name);
      const relativePath = relative(source, sourcePath).split(sep).join("/");
      if (relativePath === `${DIRECTORY.knowledge}/mutation.claim`) continue;
      if (relativePath === DIRECTORY.device) continue;
      const targetPath = join(to, entry.name);
      if (entry.isDirectory()) {
        await createOwnedDirectory(targetPath, owned);
        await persist();
        await walk(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) fail("RELOCATE_COPY_MISMATCH", `${relativePath} is not a regular file`, { file: relativePath });
      const content = await readFile(sourcePath);
      const landing = options.copyTransformForTest?.(relativePath, content) ?? content;
      await writeOwnedFile(targetPath, landing, owned);
      await persist();
      if (sha256(await readFile(targetPath)) !== sha256(content)) fail("RELOCATE_COPY_MISMATCH", `${relativePath} does not hash as its source`, { file: relativePath });
      files += 1;
      bytes += content.length;
    }
  };
  await walk(source, target);
  return { files, bytes };
}

function reasonCodeOf(error: unknown): string {
  const reasonCode = (error as { reasonCode?: unknown } | null)?.reasonCode;
  return typeof reasonCode === "string" ? reasonCode : "HOST_WRITABLE_ROOTS_FAILED";
}

// Wire every registered project to where the library went, one project at a time.
async function wireProjects(projectRoots: readonly string[], libraryPath: string, at: string): Promise<readonly RelocationHostWiring[]> {
  const wiring: RelocationHostWiring[] = [];
  for (const projectRoot of projectRoots) {
    try {
      wiring.push(await applyWritableRoots(await planWritableRoots({ projectRoot, libraryPath }), { at }));
    } catch (error) {
      wiring.push({ reasonCode: reasonCodeOf(error), projectRoot, error: String((error as { message?: unknown } | null)?.message ?? error) });
    }
  }
  return wiring;
}

/**
 * Relocate the library at `sourceInput` to `targetInput` (see the module comment).
 *
 * TCRN-CROSS-STORY-538 GWT4 (TCRN-CROSS-SUB-500): this write holds the library write lock from the
 * copy to the tombstone, and must: it cannot hold it for an append alone, because what it writes is
 * the whole library. The copy is compared with the source file by file and replayed to the source's
 * heads, then the source receipt blocks source writes, the registry points at the guarded copy,
 * and only then is the destination unlocked. A write of this machine landing between the copy and the tombstone would be in the
 * source alone, left in a library nothing points at any more, so no write may land while the library
 * moves, and the lock is what keeps them out: every writer of this machine takes it for its append or
 * its manifest, and finds the tombstone once it has it. A blob artifact-put copies before it takes
 * the lock is the one file that can still arrive while the library moves; arriving before the
 * comparison it fails the move (RELOCATE_COPY_MISMATCH, the copy undone), and after the tombstone the
 * put is turned away when it takes the lock to record it. The host wiring follows once the lock is
 * released: it writes the projects' files, not the library.
 */
export async function relocateLibrary(sourceInput: string, targetInput: string, options: RelocateOptions): Promise<RelocationReport> {
  assertStrictInstant(options.at);
  const moved = await withLibraryRepointLock(async (transaction) => {
    const source = await openLibrary(sourceInput);
    const target = await realTarget(targetInput);
    const oldText = await guardText(source.root);
    if (oldText !== null) {
      const receipt = parseReceipt(oldText);
      if (receipt !== null) {
        const saved = receipt;
        // This is the only tombstone bypass: a strict, identity-bound published transaction.
        return withLibraryWriteLock(source, async () => {
          const guard = saved.guard;
          if (guard.source.path !== source.root || guard.target.path !== target || guard.libraryId !== source.manifest.libraryId ||
              !await sameIdentity(guard.source) || !await sameIdentity(guard.target) || await guardText(source.root) !== oldText ||
              saved.report.libraryId !== guard.libraryId || saved.report.from !== source.root || saved.report.to !== target ||
              transaction.entries.filter(entry => entry.libraryId === guard.libraryId).length !== saved.projectRoots.length ||
              transaction.entries.some(entry => entry.libraryId === guard.libraryId && (!saved.projectRoots.includes(entry.projectPath) || (entry.libraryPath !== source.root && entry.libraryPath !== target)))) recovery(guard, "relocation receipt no longer matches these roots or registrations");
          const destination = await openLibrary(target);
          if (destination.manifest.libraryId !== guard.libraryId) recovery(guard, "destination library identity changed");
          const read = await readAllStreams(target);
          if (!Array.isArray(saved.streams) || saved.streams.some(witness => {
            const stream = read.streams.find(entry => entry.deviceId === witness.deviceId);
            return stream?.manifest?.streamId !== witness.streamId || (witness.sequence > 0 && stream?.events[witness.sequence - 1]?.eventHash !== witness.eventHash);
          })) recovery(guard, "destination history does not continue the recorded relocation");
          const pending = await guardText(target);
          if (pending === null) {
            if (transaction.entries.some(entry => entry.libraryId === guard.libraryId && entry.libraryPath !== target)) recovery(guard, "completed destination no longer has its recorded registration");
            // Return the historical receipt, not a fresh verification of a legitimately advanced tree.
            return { report: { ...saved.report, receiptDisposition: "historical-completion" as const }, projectRoots: saved.projectRoots };
          }
          await assertGuard(guard);
          const state = materializeLibraryRead(destination, read);
          if (await treeDigest(target, guard) !== guard.sourceTreeDigest || state.headEventHash !== saved.report.headEventHash ||
              canonicalJson(state.library?.versionVector ?? {}) !== canonicalJson(saved.report.versionVector)) recovery(guard, "pending destination differs from the verified relocation copy");
          await transaction.repoint(guard.libraryId, target, saved.report.cloudHosted);
          await options.publicationStepForTest?.("registry-repointed");
          await assertGuard(guard);
          await unlink(join(target, LIBRARY_TOMBSTONE_FILE));
          return { report: { ...saved.report, receiptDisposition: "resumed" as const }, projectRoots: saved.projectRoots };
        }, { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), command: "workspace-relocate" }).catch((error: unknown) => {
          if (error instanceof FileLockError && error.reasonCode === "FILE_LOCK_TIMEOUT") {
            throw new WorkspaceError("WORKSPACE_LOCKED", "another writer on this machine holds the library write lock", {
              holderPid: error.details?.holderPid ?? "unknown",
              holderCommand: error.details?.holderCommand ?? "unknown",
              heldSince: error.details?.heldSince ?? "unknown",
            });
          }
          throw error;
        });
      }
    }
    return withWorkspaceWriteLock(source.root, async () => {
      if (inside(source.root, target) || inside(target, source.root)) fail("RELOCATE_TARGET_INSIDE_SOURCE", `${target} and ${source.root} contain one another`, { target, source: source.root });
      const existingGuard = await guardText(target);
      if (existingGuard !== null) {
        const pending = parseGuard(existingGuard);
        if (pending !== null) recovery(pending, "an interrupted preparation remains guarded; explicitly discard its verified attempt-owned entries before retrying");
      }
      const owned: OwnedEntry[] = [];
      const targetIdentity = await prepareTarget(target, owned);
      let guard: PendingGuard = {
        schemaVersion: LIBRARY_TOMBSTONE_SCHEMA_VERSION, kind: "relocation-pending", transactionId: randomBytes(16).toString("hex"),
        libraryId: source.manifest.libraryId, movedTo: source.root, movedAt: options.at,
        source: await identity(source.root), target: targetIdentity, sourceTreeDigest: await treeDigest(source.root), owned: [...owned],
      };
      // Exclusive creation means an unrelated tombstone is never overwritten.
      const initial = await open(join(target, LIBRARY_TOMBSTONE_FILE), "wx");
      try { await initial.writeFile(canonicalJson(guard as unknown as JsonValue)); await initial.sync(); } finally { await initial.close(); }
      const persist = async (): Promise<void> => {
        await assertGuard(guard);
        guard = { ...guard, owned: [...owned] };
        await writeFileAtomic(join(target, LIBRARY_TOMBSTONE_FILE), canonicalJson(guard as unknown as JsonValue));
      };
      let copied: { readonly files: number; readonly bytes: number };
      let receipt: RelocationReceipt;
      try {
        copied = await copyTree(source.root, target, options, owned, persist);
        if (await treeDigest(source.root) !== guard.sourceTreeDigest || await treeDigest(target, guard) !== guard.sourceTreeDigest) fail("RELOCATE_COPY_MISMATCH", `${target} does not hold the files ${source.root} holds`, { target });
        const before = materializeLibraryRead(source, await readAllStreams(source.root));
        const destination = await openLibrary(target);
        const read = await readAllStreams(target);
        const after = materializeLibraryRead(destination, read);
        if (after.headEventHash !== before.headEventHash || canonicalJson(after.library?.versionVector ?? {}) !== canonicalJson(before.library?.versionVector ?? {})) fail("RELOCATE_REPLAY_MISMATCH", `${target} does not replay to the source heads`, { target });
        const suggestedCloudHosted = suggestCloudHosted(target);
        const cloudHosted = options.cloudHosted ?? suggestedCloudHosted;
        const entries = transaction.entries.filter(entry => entry.libraryId === source.manifest.libraryId);
        const tombstone: LibraryTombstone = { schemaVersion: LIBRARY_TOMBSTONE_SCHEMA_VERSION, libraryId: source.manifest.libraryId, movedTo: target, movedAt: options.at };
        receipt = {
          schemaVersion: "einzbern.relocation-receipt.v1", guard,
          report: { reasonCode: "LIBRARY_RELOCATED", transactionId: guard.transactionId, occurredAt: guard.movedAt, receiptDisposition: "completed", libraryId: source.manifest.libraryId, from: source.root, to: target,
            files: copied.files, bytes: copied.bytes, headEventHash: after.headEventHash, versionVector: after.library?.versionVector ?? {},
            registryEntries: entries.length, cloudHosted, suggestedCloudHosted, tombstone },
          projectRoots: entries.map(entry => entry.projectPath),
          streams: read.streams.flatMap(stream => stream.manifest === null ? [] : [{ deviceId: stream.deviceId, streamId: stream.manifest.streamId, sequence: stream.manifest.sequence, eventHash: stream.manifest.headEventHash }]),
        };
        await options.publicationStepForTest?.("copy-verified");
      } catch (error) {
        // Persist all known owned entries even if a copy failed before its normal ledger checkpoint.
        await persist().catch(() => undefined);
        if (!await cleanOwned(guard).catch(() => false)) recovery(guard, `copy failed and changed/unrecorded entries were retained: ${String(error)}`);
        throw error;
      }
      // Publication is one-way and recoverable: never unlock a destination while the source writes.
      // No cleanup/rollback after this point; a failed response is resolved from the durable receipt.
      try {
        await options.publicationStepForTest?.("before-source-tombstone");
        await writeFileAtomic(join(source.root, LIBRARY_TOMBSTONE_FILE), canonicalJson({ ...receipt.report.tombstone, relocation: receipt } as unknown as JsonValue));
        await options.publicationStepForTest?.("source-tombstoned");
        await transaction.repoint(source.manifest.libraryId, target, receipt.report.cloudHosted);
        await options.publicationStepForTest?.("registry-repointed");
        await assertGuard(guard);
        await unlink(join(target, LIBRARY_TOMBSTONE_FILE));
      } catch (error) { recovery(guard, `relocation publication interrupted; retry the same source and target: ${String(error)}`); }
      return { report: receipt.report, projectRoots: receipt.projectRoots };
    });
  });
  return { ...moved.report, hostWiring: await wireProjects(moved.projectRoots, moved.report.to, options.at) };
}

/** Explicit, transaction-bound recovery for a preparation that never published a source tombstone.
 * Changed/unrecorded entries are retained and the guard remains; this is never recursive deletion. */
export async function discardRelocationPreparation(sourceInput: string, targetInput: string, transactionId: string): Promise<{ readonly reasonCode: "RELOCATE_PREPARATION_DISCARDED"; readonly transactionId: string; readonly target: string }> {
  return withLibraryRepointLock(async () => withWorkspaceWriteLock(sourceInput, async (sourceRoot) => {
    const target = await realTarget(targetInput);
    const text = await guardText(target);
    const guard = text === null ? null : parseGuard(text);
    if (guard === null || guard.transactionId !== transactionId || guard.source.path !== sourceRoot || guard.target.path !== target) fail("RELOCATE_RECOVERY_REQUIRED", "no matching pending preparation; nothing removed", { source: sourceRoot, target, transactionId });
    if (await readLibraryTombstone(sourceRoot) !== null || (await openLibrary(sourceRoot)).manifest.libraryId !== guard.libraryId || await treeDigest(sourceRoot) !== guard.sourceTreeDigest) recovery(guard, "source changed or relocation was published; do not discard the destination");
    if (!await cleanOwned(guard)) recovery(guard, "changed or unrecorded destination entries were retained; inspect them before any further recovery");
    return { reasonCode: "RELOCATE_PREPARATION_DISCARDED", transactionId, target };
  }));
}
