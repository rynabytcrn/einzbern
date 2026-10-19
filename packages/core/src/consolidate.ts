import { consolidateStates } from "./consolidation-state.js";
import type { WorkspaceState } from "./workspace.js";
// SPDX-License-Identifier: Apache-2.0
import { copyFile, lstat, mkdir, readFile, readdir, unlink, rm, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { withFileLock } from "./file-lock.js";
import { writeFileAtomic } from "./atomic-file.js";
import { deviceHome } from "./device-home.js";
import { openLibrary } from "./ether-library.js";
import { chainIdentity } from "./chain-identity.js";
import { materializeWorkspaceFromGenesis, projectConfiguration, readLibraryTombstone, LIBRARY_TOMBSTONE_FILE } from "./workspace.js";
import { readRegistry, repointConsolidatedLibraries } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import { applyWritableRoots, planWritableRoots } from "./host-writable-roots.js";
import { ConsolidationError, digestBytes, readConsolidationIndex } from "./consolidation-format.js";
import type { ConsolidationIndex, ConsolidationSource } from "./consolidation-format.js";

export interface ConsolidationMapping {
  readonly primary: string;
  readonly sources: readonly { readonly path: string; readonly bindings: ConsolidationSource["bindings"] }[];
}
function refuse(code: string, detail: string): never { throw new ConsolidationError(code, detail); }
async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }); }
function inside(parent: string, path: string): boolean { return path === parent || path.startsWith(`${parent}/`); }
async function inventory(root: string, prefix = ""): Promise<ConsolidationSource["inventory"]> {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    if (name === ".DS_Store" || (prefix === "" && name === LIBRARY_TOMBSTONE_FILE)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const stats = await lstat(join(root, path));
    if (stats.isSymbolicLink()) refuse("CONSOLIDATION_UNSAFE_PATH", join(root, path));
    if (stats.isDirectory()) files.push(...await inventory(root, path));
    else if (stats.isFile()) { const bytes = await readFile(join(root, path)); files.push({ path, bytes: bytes.length, sha256: digestBytes(bytes) }); }
    else refuse("CONSOLIDATION_UNSAFE_PATH", join(root, path));
  }
  return files;
}
async function checkedCopy(source: string, target: string, file: { bytes: number; sha256: string }): Promise<void> {
  const bytes = await readFile(source);
  if (bytes.length !== file.bytes || digestBytes(bytes) !== file.sha256) refuse("CONSOLIDATION_SOURCE_CHANGED", source);
  await mkdir(dirname(target), { recursive: true });
  if (await exists(target)) {
    if (digestBytes(await readFile(target)) !== file.sha256) refuse("CONSOLIDATION_TARGET_CHANGED", target);
  } else await copyFile(source, target);
  if (digestBytes(await readFile(target)) !== file.sha256) refuse("CONSOLIDATION_COPY_MISMATCH", target);
}
const json = (value: unknown): string => canonicalJson(value as JsonValue);

/** Prepare/verify before publication. A retry resumes only this exact, digest-bound transaction. */
export async function consolidateLibraries(mapping: ConsolidationMapping, toInput: string, options: { at: string; actor: string; decidedIn: string; yes?: boolean; faultAt?: string }): Promise<Record<string, unknown>> {
  assertStrictInstant(options.at);
  const to = join(await realpath(dirname(resolve(toInput))), basename(resolve(toInput)));
  if (!mapping || !Array.isArray(mapping.sources) || mapping.sources.length < 2 || !mapping.sources.some(source => resolve(source.path) === resolve(mapping.primary))) refuse("CONSOLIDATION_MAPPING_INVALID", "explicit primary and source bindings required");
  mapping = { primary: (await openLibrary(mapping.primary)).root, sources: await Promise.all(mapping.sources.map(async source => ({ path: (await openLibrary(source.path)).root, bindings: await Promise.all(source.bindings.map(async (binding: ConsolidationSource["bindings"][number]) => ({ ...binding, projectPath: await realpath(binding.projectPath) }))) }))) };
  const paths = mapping.sources.map(source => resolve(source.path));
  if (new Set(paths).size !== paths.length || paths.some(path => inside(path, to) || inside(to, path))) refuse("CONSOLIDATION_UNSAFE_PATH", to);
  const run = async (): Promise<Record<string, unknown>> => {
    const entries = (await readRegistry()).entries;
    const sources: ConsolidationSource[] = [];
    const states: WorkspaceState[] = [];
    for (const row of mapping.sources) {
      const path = resolve(row.path);
      const library = await openLibrary(path);
      if (library.manifest.consolidation) refuse("CONSOLIDATION_MAPPING_INVALID", "nested consolidation is not supported");
      const state = await materializeWorkspaceFromGenesis(path);
      states.push(state);
      const role = chainIdentity(state)?.role;
      if (row.bindings.some(binding => binding.role !== role || !state.projects.some(project => project.id === binding.projectId && !project.tombstone))) refuse("CONSOLIDATION_BINDING_INVALID", path);
      sources.push({ manifest: library.manifest, archive: `artifacts/consolidation/${library.manifest.libraryId.replace(":", "-")}`, bindings: row.bindings, headEventHash: state.headEventHash, versionVector: state.library!.versionVector, inventory: await inventory(path) });
    }
    const primary = sources[paths.indexOf(resolve(mapping.primary))]!;
    if (primary.bindings.some(binding => binding.role !== "coordination")) refuse("CONSOLIDATION_BINDING_INVALID", "primary must be the coordination library");
    const index: ConsolidationIndex = { schemaVersion: "einzbern.consolidation.v1", at: options.at, actor: options.actor, decidedIn: options.decidedIn, primaryLibraryId: primary.manifest.libraryId, primaryVersionVector: primary.versionVector, sources };
    consolidateStates(index, sources.map((source, i) => ({ source, state: states[i]! })));
    const indexText = json(index);
    const transaction = digestBytes(indexText);
    const journalPath = join(deviceHome(), "consolidations", `${digestBytes(to)}.json`);
    if (!options.yes) return { reasonCode: "CONSOLIDATION_PLAN_READY", to, sources: sources.map(source => ({ libraryId: source.manifest.libraryId, projects: source.bindings, head: source.headEventHash, files: source.inventory.length, bytes: source.inventory.reduce((n, file) => n + file.bytes, 0) })), transaction };
    await mkdir(dirname(journalPath), { recursive: true });
    let journal: { transaction: string; index: ConsolidationIndex; entries: readonly RegistryEntry[]; phase: string };
    if (await exists(journalPath)) {
      journal = JSON.parse(await readFile(journalPath, "utf8"));
      // at is part of the provenance; a retry reuses the first receipt's instant.
      if (json(journal.index.sources) !== json(sources) || journal.index.primaryLibraryId !== index.primaryLibraryId || journal.index.actor !== index.actor || journal.index.decidedIn !== index.decidedIn) refuse("CONSOLIDATION_RECOVERY_REQUIRED", "sources or authorization differ from the durable transaction");
    } else {
      if (await exists(to) && (await readdir(to)).length) refuse("CONSOLIDATION_TARGET_NOT_EMPTY", to);
      journal = { transaction, index, entries: entries.filter(entry => sources.some(source => source.manifest.libraryId === entry.libraryId)), phase: "prepared" };
      await writeFileAtomic(journalPath, json(journal));
    }
    const provenance = journal.index;
    await mkdir(to, { recursive: true });
    for (const area of ["akasha", "crest", "config", "artifacts"]) await mkdir(join(to, area), { recursive: true });
    if (journal.phase === "complete") {
      const current = await materializeWorkspaceFromGenesis(to);
      return { reasonCode: "LIBRARIES_CONSOLIDATED", to, libraryId: current.metadata.workspaceId, transaction: journal.transaction, version: current.version, resumed: true };
    }
    if (journal.phase === "prepared") {
    await writeFileAtomic(join(to, LIBRARY_TOMBSTONE_FILE), json({ schemaVersion: "einzbern.tombstone.v1", libraryId: primary.manifest.libraryId, movedTo: to, movedAt: provenance.at }));
    // Source manifests are archived as source.json; these archives are never independently writable libraries.
    for (const [i, source] of provenance.sources.entries()) for (const file of source.inventory) {
      const archived = file.path === "manifest.json" ? "source.json" : file.path;
      await checkedCopy(join(paths[i]!, file.path), join(to, source.archive, archived), file);
      if (source.manifest.libraryId === primary.manifest.libraryId && file.path !== "manifest.json") await checkedCopy(join(paths[i]!, file.path), join(to, file.path), file);
    }
    await mkdir(join(to, "artifacts/consolidation"), { recursive: true });
    await writeFileAtomic(join(to, "artifacts/consolidation/index.json"), json(provenance));
    await writeFileAtomic(join(to, "manifest.json"), json({ ...primary.manifest, formatVersion: 3, minEngineVersion: "3.0.1", consolidation: { index: "artifacts/consolidation/index.json", sha256: digestBytes(json(provenance)) } }));
    }
    const verified = await materializeWorkspaceFromGenesis(to);
    if (primary.inventory.some(file => file.path === "crest/store.json")) {
      const { validateKnowledgeStore } = await import("./knowledge-core.js");
      await validateKnowledgeStore(to);
    }
    if (verified.library?.rejectedEvents.length || verified.projects.length !== (await Promise.all(paths.map(async path => (await materializeWorkspaceFromGenesis(path)).projects.length))).reduce((a,b)=>a+b,0)) refuse("CONSOLIDATION_REPLAY_MISMATCH", to);
    journal.phase = "verified";
    await writeFileAtomic(journalPath, json(journal));
    await projectConfiguration(to, verified);
    if (options.faultAt === "verified") throw new Error("simulated consolidation interruption");
    const replacements: RegistryEntry[] = journal.entries.map(entry => {
      const source = provenance.sources.find(source => source.manifest.libraryId === entry.libraryId)!;
      const binding = source.bindings.find(binding => binding.projectPath === entry.projectPath);
      if (!binding) refuse("CONSOLIDATION_BINDING_INVALID", entry.projectPath);
      return { ...entry, projectId: binding.projectId, chainRole: binding.role, libraryId: primary.manifest.libraryId, libraryPath: to, cloudHosted: true };
    });
    // Guards are durable before registry publication. A retry accepts only our own guard.
    for (const path of paths) {
      const previous = await readLibraryTombstone(path);
      if (previous && (previous.movedTo !== to || previous.libraryId !== (await openLibrary(path)).manifest.libraryId)) refuse("CONSOLIDATION_RECOVERY_REQUIRED", path);
      if (!previous) await writeFileAtomic(join(path, LIBRARY_TOMBSTONE_FILE), json({ schemaVersion: "einzbern.tombstone.v1", libraryId: (await openLibrary(path)).manifest.libraryId, movedTo: to, movedAt: provenance.at }));
    }
    if (options.faultAt === "guarded") throw new Error("simulated consolidation interruption");
    await repointConsolidatedLibraries(journal.entries, replacements, provenance.at);
    await unlink(join(to, LIBRARY_TOMBSTONE_FILE)).catch(error => { if (error.code !== "ENOENT") throw error; });
    journal.phase = "published";
    await writeFileAtomic(journalPath, json(journal));
    const hostWiring = [];
    const obsolete = paths;
    for (const entry of replacements) {
      const plan = await planWritableRoots({ projectRoot: entry.projectPath, libraryPath: to, replacePaths: obsolete });
      hostWiring.push(await applyWritableRoots(plan, { at: provenance.at }));
    }
    journal.phase = "complete";
    await writeFileAtomic(journalPath, json(journal));
    return { reasonCode: "LIBRARIES_CONSOLIDATED", to, libraryId: primary.manifest.libraryId, transaction: journal.transaction, journal: journalPath, sourceLibraries: sources.length, projects: verified.projects.length, work: verified.work.length, version: verified.version, headEventHash: verified.headEventHash, hostWiring };
  };
  if (!options.yes) return run();
  // Locks are acquired in stable identity order; every source writer uses these same locks.
  const libraries = await Promise.all(paths.map(path => openLibrary(path)));
  const { withLibraryWriteLock } = await import("./akasha.js");
  const locked = [...libraries].sort((a,b)=>a.manifest.libraryId.localeCompare(b.manifest.libraryId));
  const lock = (n: number): Promise<Record<string, unknown>> => n === locked.length ? run() : withLibraryWriteLock(locked[n]!, () => lock(n+1), { command: "workspace-consolidate" });
  return withFileLock(join(deviceHome(), "consolidation.lock"), () => lock(0));
}

/** Remove only vacated libraries whose complete authoritative content is preserved in this total. */
export async function cleanConsolidatedSources(toInput: string, copies: readonly { path: string; libraryId: string }[], at: string, yes = false): Promise<Record<string, unknown>> {
  assertStrictInstant(at);
  const to = resolve(toInput), library = await openLibrary(to);
  const index = await readConsolidationIndex(to, library.manifest);
  if (!index || !Array.isArray(copies) || !copies.length) refuse("CONSOLIDATION_CLEAN_REFUSED", "a shared target and an exact copy list are required");
  const targetState = await materializeWorkspaceFromGenesis(to);
  if (targetState.library?.rejectedEvents.length) refuse("CONSOLIDATION_CLEAN_REFUSED", "target has rejected events");
  const planned: { path: string; libraryId: string; bytes: number; files?: number; disposition: string }[] = [];
  const seen = new Set<string>();
  for (const copy of copies) {
    const path = resolve(copy.path);
    if (seen.has(path) || inside(to, path) || inside(path, to)) refuse("CONSOLIDATION_CLEAN_REFUSED", path);
    seen.add(path);
    const source = index.sources.find(source => source.manifest.libraryId === copy.libraryId);
    if (!source) refuse("CONSOLIDATION_CLEAN_REFUSED", "copy identity is not in the committed provenance");
    if (!await exists(path)) { planned.push({ path, libraryId: copy.libraryId, bytes: 0, disposition: "already-absent" }); continue; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("CONSOLIDATION_CLEAN_REFUSED", path);
    if ((await readdir(path)).some(name => ![".gitignore", "README.md", "manifest.json", "akasha", "crest", "config", "artifacts", LIBRARY_TOMBSTONE_FILE, ".DS_Store"].includes(name))) refuse("CONSOLIDATION_CLEAN_REFUSED", "unrecognized library-root content");
    const marker = await readLibraryTombstone(path);
    const own = await openLibrary(path);
    if (!marker || marker.libraryId !== copy.libraryId || own.manifest.libraryId !== copy.libraryId || !marker.movedTo) refuse("CONSOLIDATION_CLEAN_REFUSED", "copy is not a vacated source");
    if ((await readRegistry()).entries.some(entry => entry.libraryPath === path)) refuse("CONSOLIDATION_CLEAN_REFUSED", "a registry entry still uses the copy");
    const state = await materializeWorkspaceFromGenesis(path);
    const eventHashes = new Map(targetState.events.map(event => [event.id, event.eventHash]));
    if (state.library?.rejectedEvents.length || state.events.some(event => eventHashes.get(event.id) !== event.eventHash)) refuse("CONSOLIDATION_CLEAN_REFUSED", "copy contains unpreserved events");
    const files = await inventory(path);
    for (const file of files.filter(file => file.path.startsWith("crest/") || file.path.startsWith("artifacts/"))) {
      const archived = source.inventory.find(saved => saved.path === file.path);
      if (!archived || archived.sha256 !== file.sha256) refuse("CONSOLIDATION_CLEAN_REFUSED", `unpreserved file: ${file.path}`);
      if (digestBytes(await readFile(join(to, source.archive, file.path))) !== file.sha256) refuse("CONSOLIDATION_CLEAN_REFUSED", `archive changed: ${file.path}`);
    }
    planned.push({ path, libraryId: copy.libraryId, bytes: files.reduce((n, file) => n + file.bytes, 0), files: files.length, disposition: "clear" });
  }
  const report = { reasonCode: yes ? "CONSOLIDATED_SOURCES_CLEANED" : "CONSOLIDATION_CLEAN_PLAN_READY", target: to, at, copies: planned, removeBytes: planned.reduce((n, copy) => n + copy.bytes, 0) };
  if (yes) {
    const { withLibraryWriteLock } = await import("./akasha.js");
    await withLibraryWriteLock(library, async () => {
      // Revalidate immediately under the target writer lock. No history or evidence is rewritten.
      await cleanConsolidatedSources(to, copies, at, false);
      await mkdir(join(to, "artifacts/consolidation/cleanup"), { recursive: true });
      await writeFileAtomic(join(to, "artifacts/consolidation/cleanup", `${at.replace(/[-:]/gu, "")}.json`), json(report));
      for (const copy of planned) if (copy.disposition === "clear") {
        // The relocation receipt is unique evidence, even though the vacated event tree is redundant.
        const receipt = await readFile(join(copy.path, LIBRARY_TOMBSTONE_FILE));
        await writeFileAtomic(join(to, "artifacts/consolidation/cleanup", `${digestBytes(copy.path)}-tombstone.json`), receipt.toString("utf8"));
        await rm(copy.path, { recursive: true });
      }
    }, { command: "workspace-consolidate-clean" });
  }
  return report;
}
