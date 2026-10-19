// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withLibraryWriteLock } from "./akasha.js";
import { readDevice } from "./device-identity.js";
import { openLibrary } from "./ether-library.js";
import { withFileLock } from "./file-lock.js";
import { DIRECTORY, renderLibraryReadme } from "./names.js";
import { readRegistry } from "./registry.js";
import { relocateLibrary } from "./relocate.js";
import type { RelocationReport } from "./relocate.js";
import { configureStorageLocation } from "./storage-configure.js";
import { readStorageLocation, sharedRuntimePath } from "./storage-location.js";
import { libraryTreeDigests } from "./workspace-snapshot.js";
import { LIBRARY_TOMBSTONE_FILE, readLibraryTombstone } from "./workspace.js";

const json = (value: unknown): string => canonicalJson(value as JsonValue);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
function refuse(message: string): never { throw Object.assign(new Error(message), { reasonCode: "STORAGE_CONSOLIDATION_REFUSED" }); }
function contains(parent: string, path: string): boolean { const part = relative(parent, path); return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part)); }

interface Journal {
  readonly from: string;
  readonly to: string;
  readonly runtimeFrom: string;
  readonly runtimeTo: string;
  readonly retireRuntimeRoot: string;
  readonly decidedIn: string;
  readonly at: string;
  readonly completed?: boolean;
  readonly relocation?: RelocationReport;
}

/** One shared library, at a user-chosen parent. No cloud-provider or source-path restriction. */
export async function consolidateStorage(home: string, fromInput: string, toInput: string, retireRuntimeRootInput: string, at: string, decidedIn: string, yes = false): Promise<Record<string, unknown>> {
  assertStrictInstant(at);
  const from = resolve(fromInput), to = resolve(toInput), retireRuntimeRoot = resolve(retireRuntimeRootInput);
  if (from === to || contains(from, to) || contains(to, from) || contains(retireRuntimeRoot, to) || contains(to, retireRuntimeRoot)) refuse("overlapping storage roots");
  const device = await readDevice(home);
  if (device === null) refuse("a device identity is required");
  const journalPath = join(home, "storage-consolidation.json");
  const previous = await readFile(journalPath, "utf8").then(text => JSON.parse(text) as Journal, error => { if (error.code === "ENOENT") return null; throw error; });
  if (previous && (previous.from !== from || previous.to !== to || previous.decidedIn !== decidedIn || previous.retireRuntimeRoot !== retireRuntimeRoot)) refuse("another storage consolidation requires recovery");
  if (previous?.completed) return { reasonCode: "STORAGE_CONSOLIDATED", ...previous, resumed: true };
  const pointer = readStorageLocation(home);
  if (pointer === null || (pointer.library !== from && pointer.library !== to)) refuse("the configured library does not match this migration");
  const journal: Journal = previous ?? { from, to, runtimeFrom: pointer.runtime, runtimeTo: sharedRuntimePath(to, device.deviceId), retireRuntimeRoot, decidedIn, at };
  if (dirname(journal.runtimeFrom) !== retireRuntimeRoot || basename(journal.runtimeFrom) !== device.deviceId || retireRuntimeRoot === home) refuse("the exact retired runtime root must contain only this device");
  if (await exists(retireRuntimeRoot)) {
    if ((await lstat(retireRuntimeRoot)).isSymbolicLink() || (await readdir(retireRuntimeRoot)).some(name => ![device.deviceId, ".DS_Store"].includes(name))) refuse("the runtime root contains unowned entries");
    if (await exists(journal.runtimeFrom) && ((await lstat(journal.runtimeFrom)).isSymbolicLink() || (await readdir(journal.runtimeFrom)).some(name => !["cache", "locks", "backups", ".DS_Store"].includes(name)))) refuse("the retired device directory contains unowned entries");
  }
  if (!yes) return { reasonCode: "STORAGE_CONSOLIDATION_PLAN_READY", ...journal, retire: [from, retireRuntimeRoot] };
  return withFileLock(join(home, "storage-consolidation.lock"), async () => {
    await writeFileAtomic(journalPath, json(journal));
    // Finder's display metadata is backed up; it is never treated as library content to overwrite.
    if (!await exists(join(to, "manifest.json")) && await exists(to)) {
      if ((await lstat(to)).isSymbolicLink() || (await readdir(to)).some(name => name !== ".DS_Store")) refuse("the destination is occupied");
      const metadata = join(to, ".DS_Store");
      if (await exists(metadata)) {
        const backup = join(journal.runtimeFrom, "backups", "storage-locations");
        await mkdir(backup, { recursive: true });
        await rename(metadata, join(backup, `${digest(to)}-finder-metadata`));
      }
    }
    const relocation = await exists(from) ? await relocateLibrary(from, to, { at: journal.at }) : journal.relocation;
    if (relocation === undefined) refuse("the source is absent without a published relocation receipt");
    await writeFileAtomic(journalPath, json({ ...journal, relocation }));
    await configureStorageLocation(home, to, journal.runtimeTo, journal.at, decidedIn, true);
    // Keep the established ~/.einzbern evidence paths, without retaining the old top-level name.
    for (const area of ["cache", "locks", "backups"]) {
      const link = join(home, area), destination = join(journal.runtimeTo, area);
      if (!await exists(destination)) continue;
      if (await exists(link)) {
        if (!(await lstat(link)).isSymbolicLink() || await realpath(link) !== destination) refuse(`unexpected device forwarding path: ${link}`);
        const staging = `${link}.storage-link`;
        if (await exists(staging)) refuse(`link staging is occupied: ${staging}`);
        await symlink(destination, staging, process.platform === "win32" ? "junction" : "dir");
        await rename(staging, link);
      } else await symlink(destination, link, process.platform === "win32" ? "junction" : "dir");
    }
    const target = await openLibrary(to);
    await withLibraryWriteLock(target, async () => {
      if (await exists(from)) {
        const marker = await readLibraryTombstone(from);
        if (marker?.movedTo !== to || marker.libraryId !== target.manifest.libraryId || (await readRegistry(home)).entries.some(entry => entry.libraryPath === from)) refuse("the old library is still active");
        if ((await readdir(from)).some(name => ![".gitignore", "README.md", "manifest.json", "akasha", "crest", "config", "artifacts", LIBRARY_TOMBSTONE_FILE, ".DS_Store"].includes(name))) refuse("the old library contains unowned root entries");
        const sourceFiles = (await libraryTreeDigests(from)).filter(file => file.path !== LIBRARY_TOMBSTONE_FILE);
        const targetFiles = new Map((await libraryTreeDigests(to)).map(file => [file.path, file]));
        if (sourceFiles.some(file => targetFiles.get(file.path)?.sha256 !== file.sha256)) refuse("an old-library file has no identical destination");
        const proof = join(to, DIRECTORY.artifacts, "relocations", relocation.transactionId);
        await mkdir(proof, { recursive: true });
        await writeFileAtomic(join(proof, "source-tombstone.json"), await readFile(join(from, LIBRARY_TOMBSTONE_FILE), "utf8"));
        await writeFileAtomic(join(proof, "storage.json"), json({ ...journal, relocation, sourceFiles }));
        // Delete an exact, rechecked file list; unknown entries and links are retained as errors.
        const clear = async (root: string, prefix = ""): Promise<void> => {
          for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
            const part = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (prefix === "" && ["manifest.json", LIBRARY_TOMBSTONE_FILE].includes(part)) continue;
            const path = join(root, part);
            if (entry.isDirectory()) { await clear(root, part); await rmdir(path); }
            else {
              const saved = sourceFiles.find(file => file.path === part);
              if (!entry.isFile() || (part !== LIBRARY_TOMBSTONE_FILE && (!saved || saved.sha256 !== digest(await readFile(path))))) refuse(`unverified old-library entry: ${part}`);
              await unlink(path);
            }
          }
        };
        await clear(from); await unlink(join(from, "manifest.json")); await unlink(join(from, LIBRARY_TOMBSTONE_FILE)); await rmdir(from);
      }
    });
    if (await exists(journal.runtimeFrom)) {
      for (const area of ["cache", "locks", "backups"]) {
        const path = join(journal.runtimeFrom, area);
        if (!await exists(path)) continue;
        if (!(await lstat(path)).isSymbolicLink() || await realpath(path) !== join(journal.runtimeTo, area)) refuse(`unverified runtime forwarding link: ${path}`);
        await unlink(path);
      }
      const metadata = join(journal.runtimeFrom, ".DS_Store");
      if (await exists(metadata)) await rename(metadata, join(journal.runtimeTo, "backups", "storage-locations", "old-device-finder-metadata"));
      await rmdir(journal.runtimeFrom);
    }
    if (await exists(retireRuntimeRoot)) {
      const metadata = join(retireRuntimeRoot, ".DS_Store");
      if (await exists(metadata)) await rename(metadata, join(journal.runtimeTo, "backups", "storage-locations", "old-runtime-finder-metadata"));
      await rmdir(retireRuntimeRoot);
    }
    await writeFileAtomic(journalPath, json({ ...journal, completed: true }));
    return { reasonCode: "STORAGE_CONSOLIDATED", ...journal, completed: true, relocation, retired: [from, retireRuntimeRoot] };
  });
}

/** Refresh generated documentation after acceptance; retain the previous README as evidence. */
export async function refreshLibraryReadme(root: string, at: string): Promise<Record<string, unknown>> {
  assertStrictInstant(at);
  const library = await openLibrary(root);
  return withLibraryWriteLock(library, async () => {
    const path = join(library.root, "README.md"), text = renderLibraryReadme();
    const previous = await readFile(path, "utf8");
    if (previous === text) return { reasonCode: "LIBRARY_README_CURRENT", path };
    const archive = join(library.root, DIRECTORY.artifacts, "relocations", "readme");
    await mkdir(archive, { recursive: true });
    await writeFileAtomic(join(archive, `${digest(previous)}.md`), previous);
    await writeFileAtomic(path, text);
    return { reasonCode: "LIBRARY_README_REFRESHED", path, previousSha256: digest(previous), sha256: digest(text), at };
  });
}
