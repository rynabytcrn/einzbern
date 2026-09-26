// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-470 R3, AC2, AC3 (MIN-227 D19, D20): move a library. The target must not exist
// or be an empty directory, must not be inside the library or contain it, and must be writable.
// Under this machine's lock of the library every file and directory is copied, each file checked
// by SHA-256 as it lands, and the copy is compared with the source file by file with the backup
// witness's digests. The copy is then replayed from genesis and must reach the same stream heads
// and version vector. Only then does this device's registry point at the new place, and the old
// place gets TOMBSTONE.json (where it went and when): it still reads, and every write there
// refuses LIBRARY_TOMBSTONED. Nothing is deleted from the old place. A failure before the
// tombstone removes only what this relocation created in the target; the source is untouched.

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { isAtomicTemporaryName, writeFileAtomic } from "./atomic-file.js";
import { readAllStreams } from "./akasha.js";
import { suggestCloudHosted } from "./cloud-roots.js";
import { openLibrary } from "./ether-library.js";
import { DIRECTORY } from "./names.js";
import { repointLibrary } from "./registry.js";
import { libraryTreeDigests } from "./workspace-snapshot.js";
import {
  LIBRARY_TOMBSTONE_FILE,
  LIBRARY_TOMBSTONE_SCHEMA_VERSION,
  materializeLibraryRead,
  withWorkspaceWriteLock,
} from "./workspace.js";
import type { LibraryTombstone } from "./workspace.js";

export const RELOCATE_REASON_CODES = Object.freeze([
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
  // The user's flag for the new place; left out, the cloud folder table's suggestion.
  readonly cloudHosted?: boolean;
  // Test seam: what lands in the target for one source file (a relocation copies it unchanged).
  readonly copyTransformForTest?: (relativePath: string, bytes: Buffer) => Buffer;
}

export interface RelocationReport {
  readonly reasonCode: "LIBRARY_RELOCATED";
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
}

function fail(reasonCode: RelocateReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new RelocateError(reasonCode, message, details);
}

function sha256(bytes: Uint8Array): string {
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

// Make sure the target exists, is empty and takes a write; returns the directories this run made.
async function prepareTarget(target: string): Promise<readonly string[]> {
  const created: string[] = [];
  let existing;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (!existing.isDirectory()) fail("RELOCATE_TARGET_NOT_EMPTY", `${target} is not a directory`, { target });
    if ((await readdir(target)).length > 0) fail("RELOCATE_TARGET_NOT_EMPTY", `${target} is not empty`, { target });
  } else {
    let first = target;
    while (!(await lstat(dirname(first)).then(() => true, () => false))) first = dirname(first);
    try {
      await mkdir(target, { recursive: true });
    } catch (error) {
      fail("RELOCATE_TARGET_NOT_WRITABLE", `${target} cannot be created: ${String((error as { code?: string }).code ?? error)}`, { target });
    }
    created.push(first);
  }
  const probe = join(target, `.einzbern-probe-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(probe, "");
    await rm(probe, { force: true });
  } catch (error) {
    for (const directory of created) await rm(directory, { recursive: true, force: true });
    fail("RELOCATE_TARGET_NOT_WRITABLE", `${target} does not take a write: ${String((error as { code?: string }).code ?? error)}`, { target });
  }
  return created;
}

// Copy the library tree: every directory, and every file but atomic temporaries and an in-flight
// knowledge claim, each file checked by SHA-256 as it lands.
async function copyTree(source: string, target: string, options: RelocateOptions): Promise<{ readonly files: number; readonly bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (from: string, to: string): Promise<void> => {
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      if (isAtomicTemporaryName(entry.name) || entry.name === LIBRARY_TOMBSTONE_FILE) continue;
      const sourcePath = join(from, entry.name);
      const relativePath = relative(source, sourcePath).split(sep).join("/");
      if (relativePath === `${DIRECTORY.knowledge}/mutation.claim`) continue;
      const targetPath = join(to, entry.name);
      if (entry.isDirectory()) {
        await mkdir(targetPath);
        await walk(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) fail("RELOCATE_COPY_MISMATCH", `${relativePath} is not a regular file`, { file: relativePath });
      const content = await readFile(sourcePath);
      const landing = options.copyTransformForTest?.(relativePath, content) ?? content;
      await writeFileAtomic(targetPath, landing);
      const copied = await readFile(targetPath);
      if (sha256(copied) !== sha256(content)) fail("RELOCATE_COPY_MISMATCH", `${relativePath} does not hash as its source`, { file: relativePath });
      files += 1;
      bytes += content.length;
    }
  };
  await walk(source, target);
  return { files, bytes };
}

/** Relocate the library at `sourceInput` to `targetInput` (see the module comment). */
export async function relocateLibrary(sourceInput: string, targetInput: string, options: RelocateOptions): Promise<RelocationReport> {
  assertStrictInstant(options.at);
  return withWorkspaceWriteLock(sourceInput, async (sourceRoot) => {
    const source = await openLibrary(sourceRoot);
    const target = await realTarget(targetInput);
    if (inside(source.root, target) || inside(target, source.root)) {
      fail("RELOCATE_TARGET_INSIDE_SOURCE", `${target} and ${source.root} contain one another`, { target, source: source.root });
    }
    const created = await prepareTarget(target);
    const cleanUp = async (): Promise<void> => {
      if (created.length > 0) {
        for (const directory of created) await rm(directory, { recursive: true, force: true });
        return;
      }
      for (const name of await readdir(target).catch(() => [])) await rm(join(target, name), { recursive: true, force: true });
    };
    let copied: { readonly files: number; readonly bytes: number };
    let versionVector: Readonly<Record<string, number>>;
    let headEventHash: string | null;
    try {
      copied = await copyTree(source.root, target, options);
      // The copy against the source, file by file, with the backup witness's digests.
      const expected = canonicalJson(await libraryTreeDigests(source.root) as unknown as JsonValue);
      if (canonicalJson(await libraryTreeDigests(target) as unknown as JsonValue) !== expected) {
        fail("RELOCATE_COPY_MISMATCH", `${target} does not hold the files ${source.root} holds`, { target });
      }
      // The copy must replay to the same streams.
      const before = materializeLibraryRead(source, await readAllStreams(source.root));
      const moved = await openLibrary(target);
      const after = materializeLibraryRead(moved, await readAllStreams(moved.root));
      if (after.headEventHash !== before.headEventHash || canonicalJson(after.library?.versionVector ?? {}) !== canonicalJson(before.library?.versionVector ?? {})) {
        fail("RELOCATE_REPLAY_MISMATCH", `${target} does not replay to the heads ${source.root} has`, { target });
      }
      versionVector = after.library?.versionVector ?? {};
      headEventHash = after.headEventHash;
    } catch (error) {
      await cleanUp();
      throw error;
    }
    const suggestedCloudHosted = suggestCloudHosted(target);
    const cloudHosted = options.cloudHosted ?? suggestedCloudHosted;
    const entries = await repointLibrary(source.manifest.libraryId, target, cloudHosted);
    const tombstone: LibraryTombstone = {
      schemaVersion: LIBRARY_TOMBSTONE_SCHEMA_VERSION,
      libraryId: source.manifest.libraryId,
      movedTo: target,
      movedAt: options.at,
    };
    await writeFileAtomic(join(source.root, LIBRARY_TOMBSTONE_FILE), canonicalJson(tombstone as unknown as JsonValue));
    return {
      reasonCode: "LIBRARY_RELOCATED",
      libraryId: source.manifest.libraryId,
      from: source.root,
      to: target,
      files: copied.files,
      bytes: copied.bytes,
      headEventHash,
      versionVector,
      registryEntries: entries.length,
      cloudHosted,
      suggestedCloudHosted,
      tombstone,
    };
  });
}
