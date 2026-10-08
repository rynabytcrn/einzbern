import { readMachineSettingsCatalog, machineSettingsPath } from "./machine-settings.js";
// SPDX-License-Identifier: Apache-2.0
import { join, relative, isAbsolute } from "node:path";
import { deviceHome } from "./device-home.js";
import { realpath } from "node:fs/promises";
import { canonicalJson } from "../../protocol/src/index.js";
import type { ProjectReference } from "../../protocol/src/index.js";
import { openLibrary, hasLibraryManifest } from "./ether-library.js";
import { materializeWorkspace, materializeWorkspaceFromGenesis, initializeLibrary, createProject, readLibraryTombstone } from "./workspace.js";
import type { WorkspaceState, WorkspaceMutationOptions } from "./workspace.js";
import { readRegistry, registerLibrary, normalizeGitRemote, unregisterEntries } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import { setConfigRecord } from "./config-records.js";
import { designConfiguration, scopedWorkspaceState } from "./project-scope.js";
import { readSettingsCatalog } from "./settings.js";
import { involvedProjectsOf, projectReference, projectReferenceKey } from "./involved-projects.js";

import { ProjectChainError, chainIdentity } from "./chain-identity.js";
import type { ChainIdentity } from "./chain-identity.js";
export { ProjectChainError, chainIdentity, checkChainRecord } from "./chain-identity.js";
export type { ChainIdentity } from "./chain-identity.js";
export async function declareChainIdentity(root: string, identity: ChainIdentity, options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  const state = await materializeWorkspace(root);
  if (identity.role === "coordination" && identity.coordinationLibraryId !== state.metadata.workspaceId) throw new ProjectChainError("coordination identity must name its own library");
  const previous = chainIdentity(state);
  if (canonicalJson(previous) === canonicalJson(identity)) return state;
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
        if (entry.source.kind !== "default" || catalog.settings.find(candidate => candidate.key === entry.key)?.scope === "library" || catalog.settings.find(candidate => candidate.key === entry.key)?.shape === "collection") continue;
        const fallback = defaults.find(other => other.key === entry.key);
        if (fallback && fallback.source.kind !== "default") { entry.value = fallback.value; entry.source = { ...fallback.source, kind: "common" as typeof entry.source.kind, inherited: true }; }
      }
    }
    const effective = { ...scoped,
      settings: settings.filter(entry => entry.value !== null).map(entry => ({ schemaVersion: "tcrn.workspace-setting.v1" as const, layerKind: "workspace_configuration" as const, key: entry.key, value: entry.value!, revision: 1, updatedAt: state.metadata.createdAt, tombstone: false as const })),
      settingSources: Object.fromEntries(settings.map(entry => [entry.key, entry.source])),
    };
    const design = designConfiguration(effective);
    const repositories = scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "repositories")?.value ?? null;
    const declaredRepositories = (repositories?.bindings ?? []) as { repository: string; id: string; buildService: string; buildProject: string }[];
    const repositoryContexts = await Promise.all(entries.map(async entry => {
      const matches = declaredRepositories.filter(binding => entry.gitRemote !== null && normalizeGitRemote(binding.repository) === entry.gitRemote);
      let outputReady = false;
      try { const projectRoot = await realpath(entry.projectPath); const relation = relative(root, projectRoot); outputReady = relation !== "" && (relation.startsWith("..") || isAbsolute(relation)); } catch { /* unavailable output remains unready */ }
      return { projectPath: entry.projectPath, gitRemote: entry.gitRemote, outputReady, binding: matches.length === 1 ? matches[0]! : null, status: matches.length === 1 ? "bound" : matches.length > 1 ? "ambiguous" : "unconfigured" };
    }));
    const models = settings.find(entry => entry.key === "models.tiers");
    const language = settings.find(entry => entry.key === "artifact.language");
    const requirements = {
      design: design.status === "declared" ? [] : ["design.bundle"],
      model: models?.value && JSON.parse(models.value).some((tier: { model?: string; runner?: string }) => Boolean(tier.model?.trim() && tier.runner?.trim())) ? [] : ["models.tiers"],
      repository: repositoryContexts.length > 0 && repositoryContexts.every(entry => entry.status === "bound") ? [] : ["registered.repository-build-binding"],
      output: repositoryContexts.length > 0 && repositoryContexts.every(entry => entry.outputReady) ? [] : ["registered.project-output"],
      gates: scoped.configRecords.some(entry => entry.collection === "gate" && entry.value.enabled !== false) ? [] : ["gate.declarations"],
      language: language?.value ? [] : ["artifact.language"],
    };
    const readiness = Object.fromEntries(Object.entries(requirements).map(([operation, missing]) => [operation, { ready: missing.length === 0, missing }]));
    const developmentMissing = [...requirements.design, ...requirements.model, ...requirements.repository, ...requirements.output, ...requirements.language];
    readiness.development = { ready: developmentMissing.length === 0, missing: developmentMissing };
    return { ...base, status: design.status === "conflicting" ? "conflicting" : design.status === "unconfigured" ? "unconfigured" : "configured", name: project.name, libraryPath: root, chain: identity, version: state.version, readiness, repositoryContexts, commonDefaultsContract: "optional project scalar settings only; local gate roots and managed digests never inherit", settings, configRecords: scoped.configRecords, configSources: scoped.configSources, design, common, repositoryBindings: scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "repositories")?.value ?? null, deviceRepositories: entries.map(entry => ({ projectPath: entry.projectPath, gitRemote: entry.gitRemote })), deviceSettings: await readMachineSettingsCatalog(machineSettingsPath(home)), deviceSettingsSource: "device/user; not a chain default" };
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
  return { workId, workRevision: work.revision, involvedProjects, contexts, conflicts, developmentReady: involvedProjects.state === "selected" && contexts.every(context => (context.readiness as Record<string, { ready: boolean }> | undefined)?.development?.ready === true), coordinationReady: involvedProjects.state === "coordination-only", writeAuthority: "not-granted", explanation: "Each context applies only to its stable project reference; authorization and writable roots must be checked independently." };
}

type RegisteredLocation = { readonly libraryId: string; readonly path: string };

/** What coordination discovery found among this device's registrations (F06). */
export interface CoordinationDiscovery extends RegisteredLocation {
  // Registrations recorded with the project role whose library this device cannot open: reported,
  // never classified further.
  readonly unavailable: readonly RegisteredLocation[];
  // Registrations without a recorded role whose library this device cannot open. They are listed
  // only beside an explicit expected identity that resolved; without one they refuse discovery.
  readonly unclassifiedUnavailable: readonly RegisteredLocation[];
}

/** Competing coordination identities: a conflict naming every candidate, never a silent choice (contract item 3). */
export class CoordinationConflictError extends ProjectChainError {
  readonly details: { readonly conflicts: readonly string[]; readonly remedy: string };
  constructor(message: string, conflicts: Iterable<string>, remedy = "chain-declare") {
    super(message);
    this.details = { conflicts: [...new Set(conflicts)].sort(), remedy };
  }
}

interface RegisteredDiscovery {
  readonly candidates: ReadonlyMap<string, RegisteredLocation>;
  readonly unavailable: readonly RegisteredLocation[];
  readonly unclassifiedUnavailable: readonly RegisteredLocation[];
  // The coordination identities the opened project libraries name.
  readonly named: ReadonlySet<string>;
}

// This device's registrations, read once. With an expected identity, that identity's registrations
// are classified strictly and every other registration is only probed for whether it opens; a role
// is never inferred from a name or a path, and a recorded coordination that cannot be opened is
// never accepted beside the expected one. Without one, every registration is classified.
async function discoverRegistered(home: string | undefined, expectedId: string | undefined): Promise<RegisteredDiscovery> {
  const registry = await readRegistry(home);
  const candidates = new Map<string, RegisteredLocation>();
  const unavailable: RegisteredLocation[] = [];
  const unclassifiedUnavailable: RegisteredLocation[] = [];
  const named = new Set<string>();
  for (const entry of registry.entries) {
    const location = { libraryId: entry.libraryId, path: entry.libraryPath };
    if (expectedId !== undefined && entry.libraryId !== expectedId) {
      try { await openLibrary(entry.libraryPath); }
      catch (error) {
        if (entry.chainRole === "project") unavailable.push(location);
        else if (entry.chainRole === undefined) unclassifiedUnavailable.push(location);
        else throw new ProjectChainError(`coordination discovery cannot classify ${entry.libraryId}: a registered coordination does not open (${String(error)})`);
      }
      continue;
    }
    let state: WorkspaceState;
    try { state = await materializeWorkspace(entry.libraryPath); }
    catch (error) {
      if (expectedId === undefined && entry.chainRole === "project") { unavailable.push(location); continue; }
      throw new ProjectChainError(`coordination discovery cannot classify ${entry.libraryId}: ${String(error)}`);
    }
    if (state.metadata.workspaceId !== entry.libraryId) throw new ProjectChainError("registered coordination identity mismatch");
    const identity = chainIdentity(state);
    if (identity?.role === "project") named.add(identity.coordinationLibraryId);
    if (identity?.role !== "coordination") continue;
    const path = await realpath(entry.libraryPath);
    const previous = candidates.get(entry.libraryId);
    if (previous && previous.path !== path) throw new ProjectChainError(`coordination has competing locations: ${previous.path}, ${path}`);
    candidates.set(entry.libraryId, { libraryId: entry.libraryId, path });
  }
  return { candidates, unavailable, unclassifiedUnavailable, named };
}

/** Resolve a synchronized binding before any fresh/restore write. Missing restoration
 * bindings are actionable conflicts, never permission to mint a replacement identity. */
export async function registeredCoordination(home?: string, expectedId?: string): Promise<CoordinationDiscovery | null> {
  const found = await discoverRegistered(home, expectedId);
  if (found.candidates.size > 1) throw new CoordinationConflictError(`competing coordination identities: ${[...found.candidates.keys()].join(", ")}`, found.candidates.keys());
  if (expectedId && !found.candidates.size) throw new ProjectChainError(`register the restored coordination library ${expectedId} before continuing`);
  const candidate = [...found.candidates.values()][0];
  return candidate ? { ...candidate, unavailable: found.unavailable, unclassifiedUnavailable: found.unclassifiedUnavailable } : null;
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


/** Where this device's setup creates a coordination library when it needs a new one. */
export function defaultCoordinationPath(home: string = deviceHome()): string {
  return join(home, "coordination-library");
}

/** Where this device has the coordination identity a project library names (contract item 3). */
export interface CoordinationBinding {
  readonly libraryId: string;
  // registered: this device's registry locates it; located: it is the library at this device's
  // default coordination location, not registered yet; unregistered: this device does not locate
  // it, and nothing is created in its place.
  readonly status: "registered" | "located" | "unregistered";
  // Null while unregistered.
  readonly path: string | null;
}

// The library at this device's default coordination location, read without writing; null when the
// location holds no library.
async function defaultCoordination(home: string): Promise<{ readonly libraryId: string; readonly role: ChainIdentity["role"] | null; readonly path: string } | null> {
  const path = defaultCoordinationPath(home);
  if (!await hasLibraryManifest(path)) return null;
  const state = await materializeWorkspaceFromGenesis(path);
  return { libraryId: state.metadata.workspaceId, role: chainIdentity(state)?.role ?? null, path: await realpath(path) };
}

/**
 * Contract item 3: resolve on this device the coordination identity a project library names,
 * writing nothing. A registration of it is checked strictly; otherwise the library at this
 * device's default coordination location is it (located) or not; otherwise this device does not
 * locate it (unregistered) and nothing replaces it. Another coordination identity this device
 * registers, or holds at its default location, competes with it: a conflict naming both.
 */
export async function resolveCoordinationBinding(expectedId: string, home: string = deviceHome()): Promise<CoordinationBinding> {
  if ((await readRegistry(home)).entries.some(entry => entry.libraryId === expectedId)) {
    const found = await registeredCoordination(home, expectedId);
    return { libraryId: expectedId, status: "registered", path: found!.path };
  }
  const own = await registeredCoordination(home);
  if (own !== null) throw new CoordinationConflictError(`the library names coordination ${expectedId}, but this device's coordination is ${own.libraryId}`, [expectedId, own.libraryId]);
  const local = await defaultCoordination(home);
  if (local !== null && local.role === "coordination") {
    if (local.libraryId === expectedId) return { libraryId: expectedId, status: "located", path: local.path };
    throw new CoordinationConflictError(`the library names coordination ${expectedId}, but this device's default coordination location holds ${local.libraryId}`, [expectedId, local.libraryId]);
  }
  return { libraryId: expectedId, status: "unregistered", path: null };
}

/**
 * A restored library's coordination binding, checked on this device without writing. An
 * unclassified library carries none. A project library names one (resolveCoordinationBinding). A
 * coordination library is its own, and another coordination identity this device registers
 * competes with it.
 */
export async function restoredCoordinationBinding(identity: ChainIdentity | null, libraryId: string, home: string = deviceHome()): Promise<CoordinationBinding | null> {
  if (identity === null) return null;
  if (identity.role === "project") return resolveCoordinationBinding(identity.coordinationLibraryId, home);
  const own = await registeredCoordination(home, (await readRegistry(home)).entries.some(entry => entry.libraryId === libraryId) ? libraryId : undefined);
  if (own !== null && own.libraryId !== libraryId) throw new CoordinationConflictError(`the restored coordination ${libraryId} competes with this device's coordination ${own.libraryId}`, [libraryId, own.libraryId]);
  return null;
}

/** The coordination a project library joins on this device, decided without writing. */
export interface ProjectCoordinationChoice {
  // As a binding, or create: a new coordination library at this device's default location.
  readonly status: CoordinationBinding["status"] | "create";
  // Null only for create.
  readonly libraryId: string | null;
  // Null only while unregistered.
  readonly path: string | null;
}

/**
 * Contract item 3 and EPIC-144 R2: which coordination a project library joins on this device,
 * decided without writing. The identity its own chain record names; else the coordination this
 * device registers; else the one this device's registered project libraries name; else the
 * coordination library at the default location; else a new one there. Competing identities, an
 * occupied default location, and registered project libraries this device cannot open while no
 * coordination is known refuse rather than mint a second identity.
 */
export async function projectCoordinationChoice(identity: ChainIdentity | null, home: string = deviceHome()): Promise<ProjectCoordinationChoice> {
  if (identity?.role === "coordination") throw new ProjectChainError("fresh project setup requires a concrete project library");
  if (identity !== null) return resolveCoordinationBinding(identity.coordinationLibraryId, home);
  const found = await discoverRegistered(home, undefined);
  if (found.candidates.size > 1) throw new CoordinationConflictError(`competing coordination identities: ${[...found.candidates.keys()].join(", ")}`, found.candidates.keys());
  const own = [...found.candidates.values()][0];
  const named = [...found.named].filter(id => !found.candidates.has(id)).sort();
  if (own !== undefined) {
    if (named.length > 0) throw new CoordinationConflictError(`this device's coordination is ${own.libraryId}, but registered project libraries name ${named.join(", ")}`, [own.libraryId, ...named]);
    return { status: "registered", libraryId: own.libraryId, path: own.path };
  }
  if (named.length > 1) throw new CoordinationConflictError(`registered project libraries name competing coordination identities: ${named.join(", ")}`, named);
  if (named.length === 1) return resolveCoordinationBinding(named[0]!, home);
  if (found.unavailable.length > 0) {
    throw new ProjectChainError(`the coordination this device's projects join is unknown while registered project libraries do not open (${found.unavailable.map(entry => entry.libraryId).join(", ")}); make them available, or declare this library's coordination with chain-declare`);
  }
  const local = await defaultCoordination(home);
  if (local !== null) {
    if (local.role !== "coordination") throw new ProjectChainError("default coordination location is occupied by an unclassified or project library; select its identity explicitly");
    return { status: "located", libraryId: local.libraryId, path: local.path };
  }
  return { status: "create", libraryId: null, path: defaultCoordinationPath(home) };
}

/**
 * Register a coordination library the way setup does: the library is its own project path, under
 * its Cross Project project. With createProject, a missing Cross Project project is created first;
 * without it the registration names none. Answers whether the library was written.
 */
export async function registerSetupCoordination(path: string, occurredAt: string, home: string = deviceHome(), options: { readonly createProject: boolean } = { createProject: true }): Promise<boolean> {
  let current = await materializeWorkspace(path);
  const named = (state: WorkspaceState): WorkspaceState["projects"][number] | undefined => state.projects.find(entry => entry.externalKey === "CROSS-PROJECT" && !entry.tombstone);
  let written = false;
  if (named(current) === undefined && options.createProject) {
    current = await createProject(path, { externalKey: "CROSS-PROJECT", name: "Cross Project", occurredAt });
    written = true;
  }
  const project = named(current);
  await registerLibrary({ projectPath: path, libraryPath: path, ...(project === undefined ? {} : { projectId: project.id }), registeredAt: occurredAt, gitRemote: null }, home);
  return written;
}

/** Installation lifecycle; low-level initializeLibrary remains an unclassified factory. */
// `written`: the coordination library was written to (created, or given its Cross Project project).
export async function ensureProjectCoordination(root: string, occurredAt: string, home = deviceHome()): Promise<{ libraryId: string; path: string | null; created: boolean; written: boolean; status: ProjectCoordinationChoice["status"] }> {
  const identity = chainIdentity(await materializeWorkspace(root));
  const choice = await projectCoordinationChoice(identity, home);
  let libraryId = choice.libraryId;
  let written = false;
  if (choice.status === "create") {
    const initial = await initializeLibrary({ root: choice.path!, createdAt: occurredAt, projectName: "Cross Project" });
    await declareChainIdentity(choice.path!, { role: "coordination", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt });
    libraryId = initial.metadata.workspaceId;
    written = true;
  }
  if (choice.status === "create" || choice.status === "located") written = await registerSetupCoordination(choice.path!, occurredAt, home) || written;
  if (identity === null) await declareChainIdentity(root, { role: "project", coordinationLibraryId: libraryId! }, { occurredAt });
  return { libraryId: libraryId!, path: choice.path, created: choice.status === "create", written, status: choice.status };
}

/**
 * The coordination identity the library at `path` names, read without writing: its own id for a
 * coordination library, null for an unclassified one, undefined when it cannot be read.
 */
export async function coordinationNamedBy(path: string): Promise<string | null | undefined> {
  try {
    const state = await materializeWorkspaceFromGenesis(path);
    const identity = chainIdentity(state);
    return identity === null ? null : identity.role === "coordination" ? state.metadata.workspaceId : identity.coordinationLibraryId;
  } catch {
    return undefined;
  }
}

/**
 * STORY-480 R4/AC4: after an uninstall, take out the registration setup made for a coordination
 * (chainRole coordination, the library registered as its own project path) once no other
 * registration still names it. A registration whose library cannot be read keeps it, and so does
 * any other registration of the coordination itself. The library is never written, moved or
 * deleted. Answers the registrations taken out.
 */
export async function releaseSetupCoordination(libraryId: string, home: string = deviceHome()): Promise<readonly RegistryEntry[]> {
  return unregisterEntries(async (registry) => {
    const made = registry.entries.filter(entry => entry.libraryId === libraryId && entry.chainRole === "coordination" && entry.projectPath === entry.libraryPath);
    if (made.length === 0) return [];
    for (const entry of registry.entries) {
      if (made.includes(entry)) continue;
      if (entry.libraryId === libraryId) return [];
      const named = await coordinationNamedBy(entry.libraryPath);
      if (named === undefined || named === libraryId) return [];
    }
    return made;
  }, home);
}
