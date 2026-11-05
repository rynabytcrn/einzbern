// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { loadPath, storePath } from "./stored-path.js";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { readStorageLocation } from "./storage-location.js";
import type { StorageLocation } from "./storage-location.js";
import { runtimeTransportReceiptPath, transportRuntimeArea } from "./runtime-transport.js";
import type { RuntimeTransportOptions } from "./runtime-transport.js";
import type { WritableRootsPlan } from "./host-writable-roots.js";

/** Device identity, credentials, registry and host policies remain local. Only derived runtime and backups move. */
export async function configureStorageLocation(home: string, library: string, runtime: string, at: string, decidedIn: string, yes = false, transportOptions: RuntimeTransportOptions = {}): Promise<Record<string, unknown>> {
  assertStrictInstant(at);
  if (!isAbsolute(library) || !isAbsolute(runtime) || resolve(runtime) === resolve(home) || resolve(runtime).startsWith(`${resolve(home)}/`)) throw new Error("STORAGE_LOCATION_INVALID");
  const previous = readStorageLocation(home);
  const from = previous?.runtime ?? home;
  const target = resolve(runtime);
  const areas = ["cache", "locks", "backups"] as const;
  if (!yes) {
    await planRegisteredHostWiring(home, resolve(library), from, target);
    return { reasonCode: "STORAGE_LOCATION_PLAN_READY", library, from, runtime: target, areas };
  }
  return withFileLock(join(home, "storage-location.lock"), async () => {
    // Resolve every registered project before the relocation receipt, runtime directories,
    // pointer or host settings can be written. The same plans are applied after migration.
    const hostPlans = await planRegisteredHostWiring(home, resolve(library), from, target);
    const receiptPath = join(home, "storage-relocation.json");
    const expected = { from, to: target, library: resolve(library), decidedIn };
    let recorded = await readFile(receiptPath, "utf8").then(text => JSON.parse(text) as StoredRelocation, error => { if (error.code === "ENOENT") return null; throw error; });
    if (recorded !== null) recorded = { ...recorded, from: loadPath(home, recorded.from), to: loadPath(home, recorded.to), library: loadPath(home, recorded.library) };
    if (recorded !== null && !sameRelocation(recorded, expected) && from !== target) {
      if (previous === null || previous.runtime !== recorded.to || previous.decidedIn !== recorded.decidedIn) throw new Error("STORAGE_RECOVERY_REQUIRED");
      const archive = join(from, "backups", "storage-locations");
      await mkdir(archive, { recursive: true });
      await writeFileAtomic(join(archive, `${at.replace(/[-:]/gu, "")}.json`), canonicalJson({ pointer: { ...previous, library: storePath(home, previous.library), runtime: storePath(home, previous.runtime) }, receipt: { ...recorded, from: storePath(home, recorded.from), to: storePath(home, recorded.to), library: storePath(home, recorded.library) } }));
      recorded = null;
    }
    // Keep an existing partial transaction's original roots when the pointer was already
    // published before a later step failed. Extra progress data does not change transaction identity.
    const transaction: StoredRelocation = recorded ?? expected;
    const completedAreas: string[] = [];
    let stage: RelocationStage = "runtime";
    let activeArea: typeof areas[number] | null = null;
    let activeTransportReceipt: string | null = null;
    let activeProjectRoot: string | null = null;
    let progress: StorageRelocationProgress | null = null;
    let transactionStarted = false;
    const persistProgress = async (): Promise<void> => {
      progress = await observeRelocationProgress({ home, from, target, at, areas, stage, completedAreas, activeArea, activeTransportReceipt, activeProjectRoot, hostPlans });
      await writeRelocationReceipt(receiptPath, home, transaction, progress);
    };

    try {
      // Even a same-runtime configure can fail while publishing host settings, so the existing
      // relocation receipt also records its recovery point.
      await persistProgress();
      transactionStarted = true;
      await mkdir(target, { recursive: true });
      if (from !== target) {
        const locks = await readdir(join(from, "locks")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        if (locks.length) throw new Error("STORAGE_RUNTIME_BUSY: runtime locks must drain before relocation");
        for (const area of areas) {
          activeArea = area;
          const source = join(from, area), destination = join(target, area);
          const transportReceipt = runtimeTransportReceiptPath(home, source, destination, at);
          activeTransportReceipt = storePath(home, transportReceipt);
          await persistProgress();
          const sourceStat = await lstat(source).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (sourceStat?.isSymbolicLink()) {
            if (await realpath(source) === destination) {
              completedAreas.push(area);
              activeArea = null;
              activeTransportReceipt = null;
              await persistProgress();
              continue;
            }
            throw new Error("STORAGE_UNSAFE_PATH");
          }
          const occupied = await lstat(destination).then(stat => { if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STORAGE_UNSAFE_PATH"); return true; }, error => { if (error.code === "ENOENT") return false; throw error; });
          if (sourceStat === null) {
            if (occupied) await symlink(relative(dirname(source), destination), source, "dir");
          } else {
            if (!sourceStat.isDirectory()) throw new Error("STORAGE_UNSAFE_PATH");
            const pendingCopy = await lstat(transportReceipt).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
            if (occupied && !pendingCopy) throw new Error(`STORAGE_TARGET_NOT_EMPTY: ${destination}`);
            await transportRuntimeArea(home, source, destination, at, transportOptions);
            // Historical evidence paths keep resolving, without keeping a second data copy.
            await symlink(relative(dirname(source), destination), source, "dir");
          }
          completedAreas.push(area);
          activeArea = null;
          activeTransportReceipt = null;
          await persistProgress();
        }
      }

      stage = "storage-pointer";
      await persistProgress();
      const value: StorageLocation = { schemaVersion: "einzbern.storage-location.v2", library: resolve(library), runtime: target, at, decidedIn };
      await writeFileAtomic(join(home, "storage-location.json"), canonicalJson({ ...value, library: storePath(home, value.library), runtime: storePath(home, value.runtime) }));
      stage = "home-forwarding";
      await persistProgress();
      // Refresh only engine forwarding links that still resolve to this configured runtime.
      // A temporary sibling plus rename avoids an interval with no forwarding link.
      for (const area of areas) {
        const source = join(home, area), destination = join(target, area);
        const stat = await lstat(source).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (!stat?.isSymbolicLink() || !isAbsolute(await readlink(source)) || await realpath(source) !== destination) continue;
        const temporary = `${source}.portable-${randomUUID()}`;
        try {
          await symlink(relative(dirname(source), destination), temporary, "dir");
          await rename(temporary, source);
        } finally {
          await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
        await persistProgress();
      }

      stage = "project-wiring";
      await persistProgress();
      const { applyWritableRoots } = await import("./host-writable-roots.js");
      const hostWiring = [];
      for (const plan of hostPlans) {
        activeProjectRoot = plan.projectRoot;
        await persistProgress();
        hostWiring.push(await applyWritableRoots(plan, { at, home }));
        activeProjectRoot = null;
        await persistProgress();
      }
      stage = "complete";
      await persistProgress();
      return { reasonCode: "STORAGE_LOCATION_CONFIGURED", ...value, areas, hostWiring };
    } catch (error) {
      if (transactionStarted) {
        try {
          await persistProgress();
          if (progress !== null) attachStorageProgress(error, progress);
        } catch {
          // Keep the original exception and its reason code if the progress receipt cannot be refreshed.
          const lastProgress = progress as StorageRelocationProgress | null;
          if (lastProgress !== null) attachStorageProgress(error, { ...lastProgress, receiptWrite: "failed" });
        }
      }
      throw error;
    }
  });
}

type StoredRelocation = {
  readonly from: string;
  readonly to: string;
  readonly library: string;
  readonly decidedIn: string;
  readonly progress?: StorageRelocationProgress;
  readonly [key: string]: unknown;
};

type RelocationStage = "runtime" | "storage-pointer" | "home-forwarding" | "project-wiring" | "complete";
type FilesystemState = "directory" | "file" | "forwarding-link" | "symlink" | "other" | "missing" | "unknown";
type ReceiptPhase = "copying" | "verified" | "complete" | "not-created" | "unknown";

interface StorageRelocationProgress {
  readonly schemaVersion: "einzbern.storage-relocation-progress.v1";
  readonly at: string;
  readonly stage: RelocationStage;
  readonly completedAreas: readonly string[];
  readonly activeArea: string | null;
  readonly activeTransportReceipt: string | null;
  readonly activeProjectRoot: string | null;
  readonly storagePointer: { readonly status: "source" | "target" | "other" | "absent" | "unknown"; readonly runtime: string | null };
  readonly runtimeAreas: readonly {
    readonly area: string;
    readonly source: FilesystemState;
    readonly destination: FilesystemState;
    readonly receiptPath: string;
    readonly receiptPhase: ReceiptPhase;
    readonly sourceEntries: { readonly state: "observed" | "not-applicable" | "unknown"; readonly expected: number | null; readonly remaining: number | null; readonly retired: number | null };
  }[];
  readonly homeForwarding: readonly { readonly area: string; readonly state: FilesystemState }[];
  readonly hostWiring: readonly {
    readonly projectRoot: string;
    readonly state: "matches-target" | "matches-before" | "partial" | "unknown" | "not-needed";
    readonly files: readonly { readonly host: string; readonly path: string; readonly state: "matches-target" | "matches-before" | "unknown" }[];
  }[];
  readonly recovery: string;
  readonly receiptWrite?: "failed";
}

type HostFileState = "matches-target" | "matches-before" | "unknown";

function sameRelocation(recorded: StoredRelocation, expected: { from: string; to: string; library: string; decidedIn: string }): boolean {
  return recorded.from === expected.from && recorded.to === expected.to && recorded.library === expected.library && recorded.decidedIn === expected.decidedIn;
}

async function planRegisteredHostWiring(home: string, library: string, from: string, target: string): Promise<WritableRootsPlan[]> {
  const { readRegistry } = await import("./registry.js");
  const { planWritableRoots } = await import("./host-writable-roots.js");
  const plans: WritableRootsPlan[] = [];
  for (const entry of (await readRegistry(home)).entries) {
    if (entry.libraryPath !== library) continue;
    plans.push(await planWritableRoots({
      projectRoot: entry.projectPath,
      libraryPath: entry.libraryPath,
      replacePaths: from === home ? [] : [from],
      runtimePath: target,
    }));
  }
  return plans;
}

async function filesystemState(path: string, forwardingTarget?: string): Promise<FilesystemState> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) {
      if (forwardingTarget !== undefined && await realpath(path).then(actual => actual === resolve(forwardingTarget), () => false)) return "forwarding-link";
      return "symlink";
    }
    return value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  }
}

async function transportReceiptState(path: string, source: string, sourceState: FilesystemState): Promise<{
  readonly phase: ReceiptPhase;
  readonly sourceEntries: StorageRelocationProgress["runtimeAreas"][number]["sourceEntries"];
}> {
  try {
    const receipt = JSON.parse(await readFile(path, "utf8")) as { phase?: unknown; entries?: unknown };
    const phase: ReceiptPhase = receipt.phase === "copying" || receipt.phase === "verified" || receipt.phase === "complete" ? receipt.phase : "unknown";
    if (phase !== "verified" || sourceState !== "directory") return { phase, sourceEntries: { state: "not-applicable", expected: null, remaining: null, retired: null } };
    if (!Array.isArray(receipt.entries)) return { phase, sourceEntries: { state: "unknown", expected: null, remaining: null, retired: null } };
    let remaining = 0;
    let retired = 0;
    for (const entry of receipt.entries) {
      const entryPath = entry !== null && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined;
      if (typeof entryPath !== "string" || isAbsolute(entryPath) || entryPath.includes("\\") || entryPath.split("/").some(part => ["", ".", ".."].includes(part))) {
        return { phase, sourceEntries: { state: "unknown", expected: receipt.entries.length, remaining: null, retired: null } };
      }
      try {
        await lstat(join(source, entryPath));
        remaining += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") retired += 1;
        else return { phase, sourceEntries: { state: "unknown", expected: receipt.entries.length, remaining: null, retired: null } };
      }
    }
    return { phase, sourceEntries: { state: "observed", expected: receipt.entries.length, remaining, retired } };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { phase: missing ? "not-created" : "unknown", sourceEntries: { state: missing ? "not-applicable" : "unknown", expected: null, remaining: null, retired: null } };
  }
}

async function hostFileProgress(plan: WritableRootsPlan): Promise<StorageRelocationProgress["hostWiring"][number]> {
  const files = await Promise.all(plan.files.map(async file => {
    let actual: string | null;
    try { actual = await readFile(join(plan.projectRoot, file.path), "utf8"); }
    catch (error) { actual = (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "<unknown>"; }
    const state: HostFileState = actual === file.after ? "matches-target" : actual === file.before ? "matches-before" : "unknown";
    return { host: file.host, path: file.path, state };
  }));
  const state = plan.libraryInsideProject || files.length === 0 ? "not-needed"
    : files.every(file => file.state === "matches-target") ? "matches-target"
      : files.some(file => file.state === "unknown") ? "unknown"
        : files.some(file => file.state === "matches-target") ? "partial" : "matches-before";
  return { projectRoot: plan.projectRoot, state, files };
}

async function observeRelocationProgress(input: {
  readonly home: string;
  readonly from: string;
  readonly target: string;
  readonly at: string;
  readonly areas: readonly string[];
  readonly stage: RelocationStage;
  readonly completedAreas: readonly string[];
  readonly activeArea: string | null;
  readonly activeTransportReceipt: string | null;
  readonly activeProjectRoot: string | null;
  readonly hostPlans: readonly WritableRootsPlan[];
}): Promise<StorageRelocationProgress> {
  let pointerRuntime: string | null = null;
  let pointerStatus: StorageRelocationProgress["storagePointer"]["status"] = "unknown";
  try {
    const pointer = readStorageLocation(input.home);
    if (pointer === null) pointerStatus = "absent";
    else {
      pointerRuntime = storePath(input.home, pointer.runtime);
      pointerStatus = resolve(pointer.runtime) === resolve(input.target) ? "target" : resolve(pointer.runtime) === resolve(input.from) ? "source" : "other";
    }
  } catch {
    pointerStatus = "unknown";
  }
  const runtimeAreas = await Promise.all(input.areas.map(async area => {
    const source = join(input.from, area), destination = join(input.target, area);
    const receiptPath = runtimeTransportReceiptPath(input.home, source, destination, input.at);
    const sourceState = await filesystemState(source, destination);
    const transport = await transportReceiptState(receiptPath, source, sourceState);
    return {
      area,
      source: sourceState,
      destination: await filesystemState(destination),
      receiptPath: storePath(input.home, receiptPath),
      receiptPhase: transport.phase,
      sourceEntries: transport.sourceEntries,
    };
  }));
  const homeForwarding = await Promise.all(input.areas.map(async area => {
    const destination = join(input.target, area);
    return { area, state: await filesystemState(join(input.home, area), destination) };
  }));
  const hostWiring = await Promise.all(input.hostPlans.map(hostFileProgress));
  const recovery = input.stage === "runtime"
    ? "Retry the same storage-configure request after resolving the error; verified areas resume from their runtime receipts, and the storage pointer remains at its recorded runtime until migration completes."
    : input.stage === "project-wiring"
      ? "The storage pointer already names the target. Retry the same request after resolving the host-file error; current wiring is read back and already-matching files are not rewritten."
      : input.stage === "complete" ? "No recovery is required; the reported pointer, runtime areas and project wiring are complete."
        : "Retry the same storage-configure request after resolving the error; the receipt reports the pointer and forwarding links to reconcile.";
  return {
    schemaVersion: "einzbern.storage-relocation-progress.v1",
    at: input.at,
    stage: input.stage,
    completedAreas: [...input.completedAreas],
    activeArea: input.activeArea,
    activeTransportReceipt: input.activeTransportReceipt,
    activeProjectRoot: input.activeProjectRoot === null ? null : storePath(input.home, input.activeProjectRoot),
    storagePointer: { status: pointerStatus, runtime: pointerRuntime },
    runtimeAreas,
    homeForwarding,
    hostWiring: hostWiring.map(item => ({ ...item, projectRoot: storePath(input.home, item.projectRoot) })),
    recovery,
  };
}

async function writeRelocationReceipt(path: string, home: string, receipt: StoredRelocation, progress: StorageRelocationProgress): Promise<void> {
  await writeFileAtomic(path, canonicalJson({
    ...receipt,
    from: storePath(home, receipt.from),
    to: storePath(home, receipt.to),
    library: storePath(home, receipt.library),
    progress,
  }));
}

function attachStorageProgress(error: unknown, progress: StorageRelocationProgress): void {
  if (!(error instanceof Error)) return;
  const value = error as Error & { details?: unknown };
  const details = value.details !== null && typeof value.details === "object" && !Array.isArray(value.details)
    ? value.details as Record<string, unknown> : {};
  Object.assign(error, { details: { ...details, storageProgress: JSON.stringify(progress) } });
}
