// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { readStorageLocation } from "./storage-location.js";
import type { StorageLocation } from "./storage-location.js";
import { runtimeTransportReceiptPath, transportRuntimeArea } from "./runtime-transport.js";
import type { RuntimeTransportOptions } from "./runtime-transport.js";
/** Device identity, credentials, registry and host policies remain local. Only derived runtime and backups move. */
export async function configureStorageLocation(home: string, library: string, runtime: string, at: string, decidedIn: string, yes = false, transportOptions: RuntimeTransportOptions = {}): Promise<Record<string, unknown>> {
  assertStrictInstant(at);
  if (!isAbsolute(library) || !isAbsolute(runtime) || resolve(runtime) === resolve(home) || resolve(runtime).startsWith(`${resolve(home)}/`)) throw new Error("STORAGE_LOCATION_INVALID");
  const previous = readStorageLocation(home);
  const from = previous?.runtime ?? home;
  const target = resolve(runtime);
  const areas = ["cache", "locks", "backups"];
  if (!yes) return { reasonCode: "STORAGE_LOCATION_PLAN_READY", library, from, runtime: target, areas };
  return withFileLock(join(home, "storage-location.lock"), async () => {
    const receiptPath = join(home, "storage-relocation.json");
    const expected = { from, to: target, library: resolve(library), decidedIn };
    let recorded = await readFile(receiptPath, "utf8").then(text => JSON.parse(text), error => { if (error.code === "ENOENT") return null; throw error; });
    if (recorded !== null && canonicalJson(recorded) !== canonicalJson(expected) && from !== target) {
      if (previous === null || previous.runtime !== recorded.to || previous.decidedIn !== recorded.decidedIn) throw new Error("STORAGE_RECOVERY_REQUIRED");
      const archive = join(from, "backups", "storage-locations");
      await mkdir(archive, { recursive: true });
      await writeFileAtomic(join(archive, `${at.replace(/[-:]/gu, "")}.json`), canonicalJson({ pointer: previous, receipt: recorded }));
      recorded = null;
    }
    if (from !== target && recorded === null) {
      await writeFileAtomic(receiptPath, canonicalJson(expected));
      recorded = expected;
    }
    await mkdir(target, { recursive: true });
    if (from !== target) {
      const locks = await readdir(join(from, "locks")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      if (locks.length) throw new Error("STORAGE_RUNTIME_BUSY: runtime locks must drain before relocation");
      for (const area of areas) {
        const source = join(from, area), destination = join(target, area);
        const sourceStat = await lstat(source).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (sourceStat?.isSymbolicLink()) {
          if (recorded !== null && await realpath(source) === destination) continue;
          throw new Error("STORAGE_UNSAFE_PATH");
        }
        const occupied = await lstat(destination).then(stat => { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STORAGE_UNSAFE_PATH"); return true; }, error => { if (error.code === "ENOENT") return false; throw error; });
        if (sourceStat === null) {
          if (occupied && recorded !== null) await symlink(destination, source, process.platform === "win32" ? "junction" : "dir");
          continue;
        }
        if (!sourceStat.isDirectory()) throw new Error("STORAGE_UNSAFE_PATH");
        const pendingCopy = await lstat(runtimeTransportReceiptPath(home, source, destination, at)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        if (occupied && !pendingCopy) throw new Error(`STORAGE_TARGET_NOT_EMPTY: ${destination}`);
        await transportRuntimeArea(home, source, destination, at, transportOptions);
        // Historical evidence paths keep resolving, without keeping a second data copy.
        await symlink(destination, source, process.platform === "win32" ? "junction" : "dir");
      }
    }
    const value: StorageLocation = { schemaVersion: "einzbern.storage-location.v1", library: resolve(library), runtime: target, at, decidedIn };
    await writeFileAtomic(join(home, "storage-location.json"), canonicalJson(value));
    const { readRegistry } = await import("./registry.js");
    const { planWritableRoots, applyWritableRoots } = await import("./host-writable-roots.js");
    const hostWiring = [];
    for (const entry of (await readRegistry(home)).entries) if (entry.libraryPath === value.library) hostWiring.push(await applyWritableRoots(await planWritableRoots({ projectRoot: entry.projectPath, libraryPath: entry.libraryPath, replacePaths: from === home ? [] : [from] }), { at, home }));
    return { reasonCode: "STORAGE_LOCATION_CONFIGURED", ...value, areas, hostWiring };
  });
}
