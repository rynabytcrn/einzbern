import { readMachineSettingsCatalog, machineSettingsPath } from "./machine-settings.js";
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { deviceHome } from "./device-home.js";
import { realpath } from "node:fs/promises";
import { canonicalJson } from "../../protocol/src/index.js";
import type { ProjectReference } from "../../protocol/src/index.js";
import { openLibrary, hasLibraryManifest } from "./ether-library.js";
import { materializeWorkspace, initializeLibrary, createProject, readLibraryTombstone } from "./workspace.js";
import type { WorkspaceState, WorkspaceMutationOptions } from "./workspace.js";
import { readRegistry, registerLibrary } from "./registry.js";
import { setConfigRecord } from "./config-records.js";
import type { ConfigRecordValue } from "./config-records.js";
import { designConfiguration, scopedWorkspaceState } from "./project-scope.js";
import { readSettingsCatalog } from "./settings.js";
import { involvedProjectsOf, projectReference, projectReferenceKey } from "./involved-projects.js";

export class ProjectChainError extends Error {
  readonly reasonCode = "PROJECT_CHAIN_INVALID";
}
export interface ChainIdentity {
  readonly primaryProjectId?: string;
  readonly role: "coordination" | "project";
  readonly coordinationLibraryId: string;
}
const libraryId = (value: unknown): value is string => typeof value === "string" && /^(library|workspace):[a-f0-9]{24}$/u.test(value);
/** Canonical records travel in device streams; registries only locate them. */
export function checkChainRecord(value: ConfigRecordValue, key: string): void {
  if (key === "identity") {
    if (Object.keys(value).filter(field => field !== "primaryProjectId").sort().join(",") !== "coordinationLibraryId,role" || (value.primaryProjectId !== undefined && (typeof value.primaryProjectId !== "string" || !/^project:[a-f0-9]{24}$/u.test(value.primaryProjectId))) || !["coordination", "project"].includes(String(value.role)) || !libraryId(value.coordinationLibraryId)) throw new ProjectChainError("chain identity requires an explicit role and coordination library identity");
    return;
  }
  if (key === "common-default") { projectReference(value); return; }
  if (key === "repositories") {
    if (Object.keys(value).join(",") !== "bindings" || !Array.isArray(value.bindings) || value.bindings.length === 0) throw new ProjectChainError("repositories require a nonempty bindings list");
    const ids = new Set<string>();
    for (const binding of value.bindings) {
      if (binding === null || typeof binding !== "object" || Array.isArray(binding) || Object.keys(binding).sort().join(",") !== "buildProject,buildService,id,name,repository" || [binding.id, binding.name, binding.repository, binding.buildService, binding.buildProject].some(field => typeof field !== "string" || field.trim() === "")) throw new ProjectChainError("each repository requires its own id, name, repository, buildService and buildProject");
      if (ids.has(String(binding.id))) throw new ProjectChainError("repository binding ids must be unique");
      ids.add(String(binding.id));
    }
    return;
  }
  throw new ProjectChainError("unknown chain record");
}
export function chainIdentity(state: Pick<WorkspaceState, "configRecords" | "metadata">): ChainIdentity | null {
  const record = state.configRecords.find(r => r.collection === "chain" && r.key === "identity" && r.projectId === undefined);
  if (!record) return null;
  checkChainRecord(record.value, record.key);
  const identity = record.value as unknown as ChainIdentity;
  if (identity.role === "coordination" && identity.coordinationLibraryId !== state.metadata.workspaceId) throw new ProjectChainError("coordination identity must name its own library");
  return identity;
}
export async function declareChainIdentity(root: string, identity: ChainIdentity, options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(root);
  if (identity.role === "coordination" && identity.coordinationLibraryId !== state.metadata.workspaceId) throw new ProjectChainError("coordination identity must name its own library");
  if (canonicalJson(chainIdentity(state)) === canonicalJson(identity)) return state;
  return setConfigRecord(root, { collection: "chain", key: "identity", value: identity, ...options });
}
export type ProjectTargetStatus = "unregistered" | "unavailable" | "invalid-chain" | "project-absent" | "project-deleted" | "ambiguous" | "unconfigured" | "conflicting" | "configured";
/** No caller-supplied path is opened. Repositories sharing one real library are one target. */
export async function resolveProjectTarget(referenceInput: ProjectReference, home?: string, visited = new Set<string>()): Promise<Record<string, unknown>> {
  const reference = projectReference(referenceInput);
  const base = { reference, writeAuthority: "not-granted" };
  const key = projectReferenceKey(reference);
  if (visited.has(key)) return { ...base, status: "conflicting", reason: "common-default-cycle" };
  const seen = new Set(visited).add(key);
  const entries = (await readRegistry(home)).entries.filter(entry => entry.libraryId === reference.libraryId && entry.projectId === reference.projectId);
  if (!entries.length) return { ...base, status: "unregistered" };
  const paths = new Set<string>();
  for (const entry of entries) { try { paths.add(await realpath(entry.libraryPath)); } catch { return { ...base, status: "unavailable", location: entry.libraryPath }; } }
  if (paths.size !== 1) return { ...base, status: "ambiguous", candidates: [...paths] };
  const root = [...paths][0]!;
  let state: WorkspaceState;
  try {
    const tombstone = await readLibraryTombstone(root);
    if (tombstone !== null) return { ...base, status: "invalid-chain", reason: "LIBRARY_TOMBSTONED", tombstone };
    const library = await openLibrary(root);
    if (library.manifest.libraryId !== reference.libraryId) return { ...base, status: "invalid-chain", reason: "identity-mismatch" };
    state = await materializeWorkspace(root);
  } catch (error) { return { ...base, status: "invalid-chain", reason: String(error) }; }
  const project = state.projects.find(entry => entry.id === reference.projectId);
  if (!project) return { ...base, status: "project-absent" };
  if (project.tombstone) return { ...base, status: "project-deleted" };
  try {
    const identity = chainIdentity(state);
    if (identity?.role !== "project") return { ...base, status: "unconfigured", reason: identity === null ? "chain-role-unclassified" : "coordination-is-not-development", name: project.name };
    const scoped = scopedWorkspaceState(state, project.id);
    const catalog = readSettingsCatalog(state.metadata.workspaceId, scoped.settings);
    const settings = catalog.settings.map(entry => ({ key: entry.key, value: entry.currentValue, source: { ...(scoped.settingSources[entry.key] ?? { kind: "default" as const, projectId: null, projectName: null, inherited: false }), libraryId: reference.libraryId } }));
    const commonRecord = scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "common-default");
    let common: Record<string, unknown> | null = null;
    if (commonRecord) {
      common = await resolveProjectTarget(projectReference(commonRecord.value), home, seen);
      if (!["configured", "unconfigured"].includes(String(common.status)) || !Array.isArray(common.settings)) return { ...base, status: "conflicting", reason: "common-default-unresolved", common };
      const defaults = common.settings as typeof settings;
      for (const entry of settings) {
        if (entry.source.kind !== "default" || catalog.settings.find(candidate => candidate.key === entry.key)?.scope === "library") continue;
        const fallback = defaults.find(other => other.key === entry.key);
        if (fallback && fallback.source.kind !== "default") { entry.value = fallback.value; entry.source = { ...fallback.source, kind: "common" as typeof entry.source.kind, inherited: true }; }
      }
    }
    const effective = { ...scoped,
      settings: settings.filter(entry => entry.value !== null).map(entry => ({ schemaVersion: "tcrn.workspace-setting.v1" as const, layerKind: "workspace_configuration" as const, key: entry.key, value: entry.value!, revision: 1, updatedAt: state.metadata.createdAt, tombstone: false as const })),
      settingSources: Object.fromEntries(settings.map(entry => [entry.key, entry.source])),
    };
    const design = designConfiguration(effective);
    return { ...base, status: design.status === "conflicting" ? "conflicting" : design.status === "unconfigured" ? "unconfigured" : "configured", name: project.name, chain: identity, version: state.version, settings, configRecords: scoped.configRecords, configSources: scoped.configSources, design, common, repositoryBindings: scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "repositories")?.value ?? null, deviceRepositories: entries.map(entry => ({ projectPath: entry.projectPath, gitRemote: entry.gitRemote })), deviceSettings: await readMachineSettingsCatalog(machineSettingsPath(home)), deviceSettingsSource: "device/user; not a chain default" };
  } catch (error) { return { ...base, status: "conflicting", reason: String(error) }; }
}
export async function workProjectContexts(state: WorkspaceState, workId: string, home?: string): Promise<Record<string, unknown>> {
  const work = state.work.find(entry => entry.id === workId && !entry.tombstone);
  if (!work) throw new ProjectChainError("work does not exist");
  const involvedProjects = involvedProjectsOf(work);
  const contexts = await Promise.all(involvedProjects.targets.map(reference => resolveProjectTarget(reference, home)));
  const conflicts: string[] = [];
  for (const key of ["design.authority", "design.buildProject", "models.tiers", "artifact.language"]) {
    const values = contexts.map(context => (context.settings as { key: string; value: unknown }[] | undefined)?.find(setting => setting.key === key)?.value).filter(value => value !== undefined);
    if (new Set(values.map(value => canonicalJson(value))).size > 1) conflicts.push(key);
  }
  return { workId, involvedProjects, contexts, conflicts, developmentReady: involvedProjects.state === "selected" && contexts.every(context => context.status === "configured"), coordinationReady: involvedProjects.state === "coordination-only", writeAuthority: "not-granted", explanation: "Each context applies only to its stable project reference; authorization and writable roots must be checked independently." };
}

/** Resolve a synchronized binding before any fresh/restore write. Missing restoration
 * bindings are actionable conflicts, never permission to mint a replacement identity. */
export async function registeredCoordination(home?: string, expectedId?: string): Promise<{ libraryId: string; path: string } | null> {
  const registry = await readRegistry(home);
  const candidates = new Map<string, { libraryId: string; path: string }>();
  for (const entry of registry.entries) {
    if (expectedId !== undefined && entry.libraryId !== expectedId) continue;
    const state = await materializeWorkspace(entry.libraryPath);
    if (state.metadata.workspaceId !== entry.libraryId) throw new ProjectChainError("registered coordination identity mismatch");
    if (chainIdentity(state)?.role !== "coordination") continue;
    const path = await realpath(entry.libraryPath);
    const previous = candidates.get(entry.libraryId);
    if (previous && previous.path !== path) throw new ProjectChainError(`coordination has competing locations: ${previous.path}, ${path}`);
    candidates.set(entry.libraryId, { libraryId: entry.libraryId, path });
  }
  if (candidates.size > 1) throw new ProjectChainError(`competing coordination identities: ${[...candidates.keys()].join(", ")}`);
  if (expectedId && !candidates.size) throw new ProjectChainError(`register the restored coordination library ${expectedId} before continuing`);
  return [...candidates.values()][0] ?? null;
}

/** Async read boundary for explicitly opted-in cross-chain defaults. Canonical writers
 * continue to use the full native state; this view is never an append replacement. */
export async function effectiveProjectState(state: WorkspaceState, projectId?: string, home?: string): Promise<ReturnType<typeof scopedWorkspaceState>> {
  const scoped = scopedWorkspaceState(state, projectId);
  if (projectId === undefined || !scoped.configRecords.some(record => record.collection === "chain" && record.key === "common-default")) return scoped;
  const context = await resolveProjectTarget({ libraryId: state.metadata.workspaceId, projectId }, home);
  if (!Array.isArray(context.settings) || context.status === "conflicting") throw new ProjectChainError(`effective configuration unavailable: ${String(context.reason ?? context.status)}`);
  type Entry = { key: import("./settings.js").SettingKey; value: string | null; source: import("./project-scope.js").ConfigurationSource };
  const entries = context.settings as Entry[];
  return { ...scoped,
    settings: entries.filter(entry => entry.value !== null).map(entry => ({ schemaVersion: "tcrn.workspace-setting.v1", layerKind: "workspace_configuration", key: entry.key, value: entry.value!, revision: 1, updatedAt: state.metadata.createdAt, tombstone: false })),
    settingSources: Object.fromEntries(entries.map(entry => [entry.key, entry.source])),
    settingFallbackValues: { ...scoped.settingFallbackValues, ...Object.fromEntries(entries.filter(entry => entry.source.kind === "common").map(entry => [entry.key, entry.value])) },
    settingFallbackSources: { ...scoped.settingFallbackSources, ...Object.fromEntries(entries.filter(entry => entry.source.kind === "common").map(entry => [entry.key, entry.source])) },
  };
}


/** Installation lifecycle; low-level initializeLibrary remains an unclassified factory. */
export async function ensureProjectCoordination(root: string, occurredAt: string, home = deviceHome()): Promise<{ libraryId: string; path: string; created: boolean }> {
  const state = await materializeWorkspace(root);
  const identity = chainIdentity(state);
  if (identity?.role === "coordination") throw new ProjectChainError("fresh project setup requires a concrete project library");
  let coordination = await registeredCoordination(home, identity?.coordinationLibraryId);
  let created = false;
  if (!coordination) {
    const path = join(home, "coordination-library");
    if (await hasLibraryManifest(path)) {
      const existing = await materializeWorkspace(path);
      if (chainIdentity(existing)?.role !== "coordination") throw new ProjectChainError("default coordination location is occupied by an unclassified or project library; select its identity explicitly");
    } else {
      const initial = await initializeLibrary({ root: path, createdAt: occurredAt, projectName: "Cross Project" });
      await declareChainIdentity(path, { role: "coordination", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt });
      created = true;
    }
    let current = await materializeWorkspace(path);
    let project = current.projects.find(entry => entry.externalKey === "CROSS-PROJECT" && !entry.tombstone);
    if (!project) {
      current = await createProject(path, { externalKey: "CROSS-PROJECT", name: "Cross Project", occurredAt });
      project = current.projects.find(entry => entry.externalKey === "CROSS-PROJECT" && !entry.tombstone)!;
    }
    await registerLibrary({ projectPath: path, libraryPath: path, projectId: project.id, registeredAt: occurredAt, gitRemote: null }, home);
    coordination = { path, libraryId: current.metadata.workspaceId };
  }
  if (identity === null) await declareChainIdentity(root, { role: "project", coordinationLibraryId: coordination.libraryId }, { occurredAt });
  return { ...coordination, created };
}
