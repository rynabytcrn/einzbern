import { executionDecisionEligibility } from "./host-capabilities.js";
import { validateHostExecutionRequest, resolveHostExecution } from "./execution-fallback.js";
import type { HostExecutionRequest, HostExecutionDecision } from "./execution-fallback.js";
import { readConsolidationIndex } from "./consolidation-format.js";
// SPDX-License-Identifier: Apache-2.0
import { DOT_EXECUTION_MODE, dotDigest, resolveDotExecutionAdmission, validateDotExecutionRequest } from "./dot-execution.js";
import { assessExecutionContextRead } from "./dot-agents.js";
import type { DotExecutionRequest, DotCheck, DotAdmission } from "./dot-execution.js";
import { readExecutionAdmissionSnapshot, resolveExecutionAdmissionFromSnapshot } from "./execution-admission.js";
import type { ExecutionAdmissionRequest, ExecutionAdmissionSnapshot } from "./execution-admission.js";
import { variableExportDecision } from "./variables.js";
import type { VariableRecordValue } from "./variables.js";
import { engineModelPolicyCatalogFromSnapshot } from "./engine-model-policy.js";
import { MACHINE_SETTINGS_FILE_NAME, MACHINE_SETTINGS_CATALOG, readMachineSettings } from "./machine-settings.js";
import type { MachineSettingsReadback } from "./machine-settings.js";
import { resolveExecutionConcurrency } from "./execution-policy.js";
import { isAbsolute, join } from "node:path";
import { pathIsInside } from "./path-containment.js";
import { deviceHome } from "./device-home.js";
import { realpath } from "node:fs/promises";
import { canonicalJson } from "../../protocol/src/index.js";
import type { ProjectReference } from "../../protocol/src/index.js";
import { openLibrary, hasLibraryManifest } from "./ether-library.js";
import { materializeWorkspace, materializeWorkspaceFromGenesis, initializeLibrary, createProject, readLibraryTombstone } from "./workspace.js";
import type { WorkspaceState, WorkspaceMutationOptions } from "./workspace.js";
import { readRegistry, registerLibrary, normalizeGitRemote, unregisterEntries } from "./registry.js";
import type { Registry, RegistryEntry } from "./registry.js";
import { setConfigRecord } from "./config-records.js";
import { designConfiguration, scopedWorkspaceState } from "./project-scope.js";
import type { ConfigurationSource, ScopedWorkspaceState } from "./project-scope.js";
import { SETTINGS_CATALOG, readSettingsCatalog } from "./settings.js";
import type { SettingKey, SettingsCatalogReadback } from "./settings.js";
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

function projectExecutionConfiguration(snapshot: ExecutionAdmissionSnapshot): {
  readonly snapshot: ExecutionAdmissionSnapshot;
  readonly enginePolicy: ReturnType<typeof engineModelPolicyCatalogFromSnapshot>;
  readonly deviceSettings: MachineSettingsReadback;
} {
  const file = snapshot.machineSettings;
  return Object.freeze({
    snapshot,
    enginePolicy: engineModelPolicyCatalogFromSnapshot(snapshot.enginePolicy, undefined, snapshot.home),
    deviceSettings: Object.freeze({
      schemaVersion: file.schemaVersion, layerKind: file.layerKind, path: join(snapshot.home, MACHINE_SETTINGS_FILE_NAME),
      settings: Object.freeze(MACHINE_SETTINGS_CATALOG.map(entry => Object.freeze({ ...entry, currentValue: Object.hasOwn(file.values, entry.key) ? file.values[entry.key]! : null }))),
      updatedAt: file.updatedAt,
    }),
  });
}

/** Native mode reads the actual device cap, not unrelated host model policy or quota files. */
async function dotProjectExecutionConfiguration(home: string = deviceHome()) {
  if (!isAbsolute(home)) throw new ProjectChainError("device home must be absolute");
  const file = await readMachineSettings(join(home, MACHINE_SETTINGS_FILE_NAME));
  return {
    snapshot: { home, machineSettings: file },
    enginePolicy: { schemaVersion: "tcrn.dot-policy-applicability.v1", applicability: "not-applicable", hosts: {} as Readonly<Record<string, never>>, source: "not-read-for-native-mode" },
    deviceSettings: {
      schemaVersion: file.schemaVersion, layerKind: file.layerKind, path: join(home, MACHINE_SETTINGS_FILE_NAME),
      settings: MACHINE_SETTINGS_CATALOG.map(entry => ({ ...entry, currentValue: Object.hasOwn(file.values, entry.key) ? file.values[entry.key]! : null })), updatedAt: file.updatedAt,
    },
  };
}

/** No caller-supplied path is opened. Repositories sharing one real library are one target. */
export async function resolveProjectTarget(referenceInput: ProjectReference, home?: string, visited = new Set<string>()): Promise<Record<string, unknown>> {
  return resolveProjectTargetFromSnapshot(referenceInput, home, visited);
}

async function resolveProjectTargetFromSnapshot(referenceInput: ProjectReference, home: string | undefined, visited: Set<string>, execution?: ReturnType<typeof projectExecutionConfiguration> | Awaited<ReturnType<typeof dotProjectExecutionConfiguration>>): Promise<Record<string, unknown>> {
  let reference = projectReference(referenceInput);
  const registry = await readRegistry(home);
  if (!registry.entries.some(entry => entry.libraryId === reference.libraryId)) for (const path of new Set(registry.entries.map(entry => entry.libraryPath))) {
    const library = await openLibrary(path).catch(() => null);
    if (library === null || library.manifest.consolidation === undefined) continue;
    const consolidation = await readConsolidationIndex(path, library.manifest);
    if (consolidation?.sources.some(source => source.manifest.libraryId === reference.libraryId)) {
      reference = { ...reference, libraryId: library.manifest.libraryId }; break;
    }
  }
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
    const identity = chainIdentity(state, project.id);
    if (identity?.role !== "project") return { ...base, status: "unconfigured", reason: identity === null ? "chain-role-unclassified" : "coordination-is-not-development", name: project.name };
    const scoped = scopedWorkspaceState(state, project.id);
    const catalog = readSettingsCatalog(state.metadata.workspaceId, scoped.settings);
    const settings = catalog.settings.map(entry => ({ key: entry.key, value: entry.currentValue, source: { ...(scoped.settingSources[entry.key] ?? { kind: "default" as const, projectId: null, projectName: null, inherited: false }), libraryId: reference.libraryId } }));
    const commonRecord = scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "common-default");
    let common: Record<string, unknown> | null = null;
    if (commonRecord) {
      common = await resolveProjectTargetFromSnapshot(projectReference(commonRecord.value), home, seen, execution);
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
      try { const projectRoot = await realpath(entry.projectPath); outputReady = !pathIsInside(root, projectRoot); } catch { /* unavailable output remains unready */ }
      return { projectPath: entry.projectPath, gitRemote: entry.gitRemote, outputReady, binding: matches.length === 1 ? matches[0]! : null, status: matches.length === 1 ? "bound" : matches.length > 1 ? "ambiguous" : "unconfigured" };
    }));
    const { enginePolicy, deviceSettings } = execution ?? projectExecutionConfiguration(await readExecutionAdmissionSnapshot(home));
    const configuredHosts = Object.entries(enginePolicy.hosts).filter(([, policy]) => policy.tiers.some(tier => tier.model.trim() && tier.effort.trim())).map(([host]) => host);
    const language = settings.find(entry => entry.key === "artifact.language");
    const requirements = {
      // A design authority is optional. Its absence remains visible in `design.status`,
      // but does not make unrelated development unavailable.
      design: design.status === "conflicting" ? ["design.bundle"] : design.bindings.some(binding => binding.key === "design.authority" && binding.value !== null) ? [...design.missing] : [],
      model: configuredHosts.length > 0 ? [] : ["engine.host-policy"],
      repository: repositoryContexts.length > 0 && repositoryContexts.every(entry => entry.status === "bound") ? [] : ["registered.repository-build-binding"],
      output: repositoryContexts.length > 0 && repositoryContexts.every(entry => entry.outputReady) ? [] : ["registered.project-output"],
      gates: scoped.configRecords.some(entry => entry.collection === "gate" && entry.value.enabled !== false) ? [] : ["gate.declarations"],
      language: language?.value ? [] : ["artifact.language"],
    };
    const readiness = Object.fromEntries(Object.entries(requirements).map(([operation, missing]) => [operation, { ready: missing.length === 0, missing }]));
    const developmentMissing = [...requirements.design, ...requirements.model, ...requirements.repository, ...requirements.output, ...requirements.language];
    readiness.development = { ready: developmentMissing.length === 0, missing: developmentMissing };
    return { ...base, status: design.status === "conflicting" ? "conflicting" : design.status === "unconfigured" ? "unconfigured" : "configured", name: project.name, libraryPath: root, chain: identity, version: state.version, readiness, enginePolicy, configuredHosts, modelCapabilityVerification: "requires-explicit-host-resolution", repositoryContexts, commonDefaultsContract: "optional project scalar settings only; local gate roots and managed digests never inherit", settings, configRecords: scoped.configRecords, configSources: scoped.configSources, design, common, repositoryBindings: scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "repositories")?.value ?? null, deviceRepositories: entries.map(entry => ({ projectPath: entry.projectPath, gitRemote: entry.gitRemote })), deviceSettings, deviceSettingsSource: "device/user; not a chain default" };
  } catch (error) { return { ...base, status: "conflicting", reason: String(error) }; }
}
/**
 * Approved contract item 9 (INIT-053 U10): the configuration one resolved target hands to whatever
 * applies it. Gate processes receive it as EINZBERN_PROJECT_CONTEXT, with the repository and root
 * they run in, and the native host dispatch passes the same object for that target: its stable
 * reference and the work revision it was resolved for, its version and library, its registered
 * repositories, effective settings with their provenance, design, repository bindings, readiness,
 * output places, enabled rules and variables. Never write authority. A target that does not resolve
 * to a project chain on this device (unregistered, unavailable, invalid, unclassified) has none.
 */
export function projectTargetHandoff(work: { readonly workId: string; readonly workRevision: number }, context: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  if (typeof context.libraryPath !== "string" || !Array.isArray(context.settings)) return null;
  const settings = context.settings as readonly { readonly key: string; readonly value: unknown }[];
  const value = (key: string): unknown => settings.find(entry => entry.key === key)?.value ?? null;
  const records = (Array.isArray(context.configRecords) ? context.configRecords : []) as readonly { readonly collection: string; readonly key: string; readonly value: Readonly<Record<string, unknown>> }[];
  const variables = records.filter(record => record.collection === "variable").map(record => ({ record, reason: variableExportDecision(record.value as unknown as VariableRecordValue, "handoff") }));
  return {
    workId: work.workId, workRevision: work.workRevision, reference: context.reference, version: context.version, libraryPath: context.libraryPath,
    executionAdmission: context.executionAdmission ?? { status: "not-requested", reason: "read-only-context-is-not-dispatch-admission" },
    enginePolicy: context.enginePolicy ?? null, executionConcurrency: context.executionConcurrency ?? null, repositories: context.repositoryContexts, settings: settings.filter(entry => !entry.key.startsWith("models.") && !entry.key.startsWith("quota.")), design: context.design, repositoryBindings: context.repositoryBindings, readiness: context.readiness,
    output: { language: value("artifact.language"), knowledgeArticlesPath: value("knowledge.articlesPath"), generatedArtifactsPath: value("workspace.generatedArtifactsPath") },
    rules: records.filter(record => record.collection === "rule" && record.value.enabled === true).map(record => ({ id: record.key, version: record.value.version, ...(record.value.order === undefined ? {} : { order: record.value.order }) })),
    variables: variables.filter(entry => entry.reason === null).map(({ record }) => ({ key: record.key, value: record.value })),
    withheldVariables: variables.filter(entry => entry.reason !== null).map(({ record, reason }) => ({ key: record.key, reason })),
    writeAuthority: "not-granted",
  };
}

export async function workProjectContexts(state: WorkspaceState, workId: string, home?: string, executionRequest?: ExecutionAdmissionRequest | DotExecutionRequest | HostExecutionRequest): Promise<Record<string, unknown>> {
  const work = state.work.find(entry => entry.id === workId && !entry.tombstone);
  if (!work) throw new ProjectChainError("work does not exist");
  const involvedProjects = involvedProjectsOf(work);
  if (executionRequest !== undefined && "schemaVersion" in executionRequest) {
    return hostWorkProjectContexts(state, workId, validateHostExecutionRequest(executionRequest), home);
  }
  const dotRequest = executionRequest !== undefined && "mode" in executionRequest && executionRequest.mode === DOT_EXECUTION_MODE ? validateDotExecutionRequest(executionRequest) : null;
  // Capture each device file once for this request. All target/common readbacks and admissions
  // share these values; this is not a transaction across the independently stored device files.
  const execution = dotRequest === null ? projectExecutionConfiguration(await readExecutionAdmissionSnapshot(home)) : await dotProjectExecutionConfiguration(home);
  const { enginePolicy, snapshot } = execution;
  const evaluatedAt = new Date().toISOString();
  // Each target resolves on its own: one that fails is a result of its own, never the end of the others.
  const resolved = await Promise.all(involvedProjects.targets.map(async (reference): Promise<Record<string, unknown>> => {
    try { return await resolveProjectTargetFromSnapshot(reference, snapshot.home, new Set(), execution); }
    catch (error) { return { reference, writeAuthority: "not-granted", status: "invalid-chain", reason: String(error) }; }
  }));
  const deviceLimit = Number(snapshot.machineSettings.values["execution.maxConcurrentAgents"] ?? MACHINE_SETTINGS_CATALOG.find(entry => entry.key === "execution.maxConcurrentAgents")!.defaultValue);
  const contexts: Record<string, unknown>[] = resolved.map(context => {
    const settings = context.settings as { key: string; value: unknown }[] | undefined;
    const budget = settings?.find(entry => entry.key === "execution.maxConcurrentSubagents")?.value;
    const executionConcurrency = Array.isArray(settings) ? resolveExecutionConcurrency(deviceLimit, budget == null ? undefined : Number(budget)) : null;
    let executionAdmission: unknown = executionRequest === undefined ? { status: "not-requested", reason: "read-only-context-is-not-dispatch-admission" }
      : !Array.isArray(settings) ? { status: "refused", reasons: ["project-context-unresolved"] }
      : dotRequest !== null ? null
      : resolveExecutionAdmissionFromSnapshot(snapshot as ExecutionAdmissionSnapshot, executionRequest as ExecutionAdmissionRequest, { now: evaluatedAt, ...(budget == null ? {} : { projectLimit: Number(budget) }) });
    let effectiveContext = context;
    if (dotRequest !== null && Array.isArray(settings)) {
      const failCheck = (reason: string): DotCheck => ({ status: "fail", evidenceRefs: [], reason });
      const sameTarget = dotDigest(context.reference) === dotDigest(dotRequest.projectRef);
      const revision = dotRequest.revisionBinding;
      // A freeze is never accepted merely because the caller supplied a digest. This consumer
      // only has an actual revision observation; a supported freeze verifier can be added later.
      const currentScopeDigest = typeof work.scopeDigest === "string" && /^[a-f0-9]{64}$/u.test(work.scopeDigest) ? work.scopeDigest : null;
      const sameWork = currentScopeDigest !== null && dotRequest.workId === workId && revision.kind === "revision" && revision.workRevision === work.revision && revision.scopeDigest === currentScopeDigest;
      // Legacy/missing scope is an unavailable current observation, not a caller-provided
      // substitute. Only a validated actual digest may enter the context expectation.
      const contextAssessment = dotRequest.contextRead === undefined || currentScopeDigest === null ? null : assessExecutionContextRead(dotRequest.contextRead.record, { ...dotRequest.contextRead.expected, workReference: workId, workRevision: work.revision, scopeDigest: currentScopeDigest, now: evaluatedAt, effectiveRoots: (context.repositoryContexts as { projectPath: string }[]).map(repository => repository.projectPath) }, dotRequest.contextRead.observations);
      const checks = { ...dotRequest.checks,
        context: contextAssessment?.check ?? { status: "unknown" as const, evidenceRefs: [], reason: currentScopeDigest === null ? "current work scope digest is unavailable" : "actual-session AGENTS, Mana and work source observations are required" },
        ...(currentScopeDigest === null ? { scope: { status: "unknown" as const, evidenceRefs: [], reason: "current work scope digest is unavailable" } } : {}),
        ...(!sameWork ? { work: failCheck("current work revision/scope differs, or freeze authority is unavailable") } : {}),
        ...(!sameTarget || involvedProjects.state !== "selected" ? { target: failCheck("explicit selected target binding differs") } : {}),
        ...(["blocked", "pending-owner-acceptance", "done", "cancelled"].includes(work.status) ? { state: failCheck("current work state does not allow dispatch") } : {}),
      };
      const { contextRead, ...requestWithoutContextRead } = dotRequest;
      executionAdmission = resolveDotExecutionAdmission({ ...requestWithoutContextRead, checks, ...(contextRead === undefined || currentScopeDigest === null ? {} : { contextRead: { ...contextRead, expected: { ...contextRead.expected, workReference: workId, workRevision: work.revision, scopeDigest: currentScopeDigest, now: evaluatedAt, effectiveRoots: (context.repositoryContexts as { projectPath: string }[]).map(repository => repository.projectPath) } } }) }, { deviceLimit, ...(budget == null ? {} : { projectLimit: Number(budget) }), now: evaluatedAt, contextDigest: dotDigest({ workLibraryId: state.metadata.workspaceId, workId, workRevision: work.revision, scopeDigest: currentScopeDigest, context }) });
      const readiness = context.readiness as Record<string, { ready: boolean; missing: string[] }> | undefined;
      if (readiness !== undefined) {
        const dotAdmission = executionAdmission as DotAdmission;
        const model = { ready: checks.tools.status === "pass", missing: checks.tools.status === "pass" ? [] : ["dot.actual-tool-capability"] };
        const developmentMissing = ["design", "repository", "output", "language"].flatMap(key => readiness[key]?.missing ?? [`${key}.unknown`]);
        developmentMissing.push(...model.missing);
        effectiveContext = { ...context, readiness: { ...readiness, model, development: { ready: developmentMissing.length === 0, missing: developmentMissing } }, modelCapabilityVerification: "dot-native-capability-evidence-not-self-model-policy", modelApplicability: dotAdmission.applicability };
      }
    }
    const effective = { ...effectiveContext, enginePolicy, executionConcurrency, executionAdmission };
    return { ...effective, handoff: projectTargetHandoff({ workId, workRevision: work.revision }, effective) };
  });
  const conflicts: string[] = [];
  for (const key of ["design.authority", "design.buildProject", "artifact.language"]) {
    const values = contexts.map(context => (context.settings as { key: string; value: unknown }[] | undefined)?.find(setting => setting.key === key)?.value).filter(value => value !== undefined);
    if (new Set(values.map(value => canonicalJson(value))).size > 1) conflicts.push(key);
  }
  return { workId, workRevision: work.revision, involvedProjects, enginePolicy, dispatchAdmitted: executionRequest !== undefined && involvedProjects.state === "selected" && contexts.length > 0 && contexts.every(context => (context.executionAdmission as { status: string }).status === "admitted" && (context.readiness as Record<string, { ready: boolean }> | undefined)?.development?.ready === true), executionPolicyCommand: "execution-policy-resolve --host <host> --category <category> --rejections <count>", contexts, conflicts, developmentReady: involvedProjects.state === "selected" && contexts.length > 0 && contexts.every(context => (context.readiness as Record<string, { ready: boolean }> | undefined)?.development?.ready === true), coordinationReady: involvedProjects.state === "coordination-only", writeAuthority: "not-granted", explanation: "Each context applies only to its stable project reference; authorization and writable roots must be checked independently." };
}

/** New native protocol is action-scoped; it never rewrites historical dot/process receipts. */
async function hostWorkProjectContexts(state: WorkspaceState, workId: string, request: HostExecutionRequest, home?: string): Promise<Record<string, unknown>> {
  const work = state.work.find(item => item.id === workId && !item.tombstone)!;
  if (request.workId !== workId || request.workRevision !== work.revision) throw new ProjectChainError("host request work/revision differs from current work");
  const involvedProjects = involvedProjectsOf(work);
  // Dot self-selection/quota are inapplicable; do not parse unrelated model policy for dot.
  // Other hosts preserve policy corruption/I/O errors instead of treating them as absence.
  const policySnapshot = request.capabilities.hostKind === "dot" ? null : await readExecutionAdmissionSnapshot(home);
  const execution = policySnapshot === null ? await dotProjectExecutionConfiguration(home) : projectExecutionConfiguration(policySnapshot);
  const snapshot = execution.snapshot;
  const contexts = await Promise.all(involvedProjects.targets.map(reference => resolveProjectTargetFromSnapshot(reference, home, new Set(), execution)));
  const effectiveRequest = request;
  // Explicit configured caps remain constraints. Default/platform limits are not telemetry gates.
  const scoped = scopedWorkspaceState(state, work.projectId);
  const projectCap = scoped.settings.find(setting => setting.key === "execution.maxConcurrentSubagents")?.value;
  const deviceCap = snapshot.machineSettings.values["execution.maxConcurrentAgents"];
  const reported = request.hardLimits?.concurrency;
  const platform = request.capabilities.platformCapacity;
  const enforceCap = (limit: number, scope: "children" | "total"): void => {
    const observation = reported ?? (platform ? { ...platform, scope: "total" as const } : null);
    let active = observation?.active ?? null;
    if (active !== null && observation) {
      active = scope === "children" ? active - (observation.includesParent && observation.parentActive ? 1 : 0) : active + (!observation.includesParent && observation.parentActive ? 1 : 0);
    }
    if (request.requestedAgents > limit || active !== null && active + request.requestedAgents > limit) constraintReasons.push(`configured-${scope}-concurrency-exceeded`);
    // An unavailable occupancy observation does not turn an ordinary configured cap into
    // a new telemetry gate. Explicit user guarantees belong in request.hardLimits.
  };
  const constraintReasons: string[] = [];
  if (typeof deviceCap === "number") enforceCap(deviceCap, "total");
  if (typeof projectCap === "number") enforceCap(projectCap, "children");
  if (["blocked", "pending-owner-acceptance", "done", "cancelled"].includes(work.status)) constraintReasons.push("current-work-state-does-not-allow-new-dispatch");
  // Optional project association is checked if requested. No selected target is fabricated.
  const target = request.projectRef === undefined ? undefined : contexts.find(context => dotDigest(context.reference) === dotDigest(request.projectRef));
  if (request.projectRef && !target) constraintReasons.push("requested-project-target-not-in-current-work");
  if (request.action === "implementation" && target) {
    const readiness = target.readiness as Record<string, { ready: boolean; missing: string[] }> | undefined;
    if (!readiness || ["design", "repository", "output", "language"].some(key => readiness[key]?.ready !== true)) constraintReasons.push("implementation-target-readiness-unresolved");
  }
  const contextDigest = dotDigest({ libraryId: state.metadata.workspaceId, workId, workRevision: work.revision, involvedProjects, contexts });
  let decision: HostExecutionDecision = resolveHostExecution(effectiveRequest, policySnapshot?.enginePolicy ?? null, contextDigest);
  if (constraintReasons.length) decision = { ...decision, status: "blocked", additionalConfirmationsRequired: false, reasons: [...decision.reasons, ...constraintReasons] };
  const eligible = executionDecisionEligibility(decision) === "executable";
  return {
    schemaVersion: "tcrn.host-project-context.v1", workId, workRevision: work.revision, involvedProjects,
    contexts: contexts.map(context => ({ ...context, executionAdmission: decision, handoff: projectTargetHandoff({ workId, workRevision: work.revision }, { ...context, executionAdmission: decision }) })),
    executionDecision: decision, dispatchAdmitted: eligible, coordinationReady: involvedProjects.state === "coordination-only",
    developmentReady: request.action === "implementation" && eligible, conflicts: [], enginePolicy: execution.enginePolicy,
    writeAuthority: "not-granted", explanation: "Authorization and source permission are reported context, not credentials. Coordination never invents development targets; source scope is checked separately.",
  };
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
    if (identity?.role !== "coordination" && identity?.role !== "shared") continue;
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

type EffectiveSettingEntry = { readonly key: SettingKey; readonly value: string | null; readonly source: ConfigurationSource };

// The effective view a resolved target's settings make over its scoped state. TCRN-CROSS-INIT-053 R46
// (I02, approved contract item 7): a record is rebuilt with the project its value was declared on, as
// the scoped state holds it, so settings-catalog's declaredValue, its modified marker and its reset all
// see this target's own declarations. A library key carries no project, and a value inherited from the
// common default is never this target's declaration, so it carries none either.
function effectiveFromSettings(state: WorkspaceState, scoped: ScopedWorkspaceState, entries: readonly EffectiveSettingEntry[]): ScopedWorkspaceState {
  return { ...scoped,
    settings: entries.filter(entry => entry.value !== null).map(entry => ({ schemaVersion: "tcrn.workspace-setting.v1" as const, layerKind: "workspace_configuration" as const, key: entry.key, value: entry.value!, revision: 1, updatedAt: state.metadata.createdAt, tombstone: false as const,
      ...(entry.source.kind === "project" && entry.source.projectId !== null ? { projectId: entry.source.projectId } : {}) })),
    settingSources: Object.fromEntries(entries.map(entry => [entry.key, entry.source])),
    settingFallbackValues: { ...scoped.settingFallbackValues, ...Object.fromEntries(entries.filter(entry => entry.source.kind === "common").map(entry => [entry.key, entry.value])) },
    settingFallbackSources: { ...scoped.settingFallbackSources, ...Object.fromEntries(entries.filter(entry => entry.source.kind === "common").map(entry => [entry.key, entry.source])) },
  };
}

function effectiveConfigurationUnavailable(context: Readonly<Record<string, unknown>>): ProjectChainError {
  return new ProjectChainError(`effective configuration unavailable: ${String(context.reason ?? context.status)}`);
}

/** Async read boundary for explicitly opted-in cross-chain defaults. Canonical writers
 * continue to use the full native state; this view is never an append replacement. */
export async function effectiveProjectState(state: WorkspaceState, projectId?: string, home?: string): Promise<ReturnType<typeof scopedWorkspaceState>> {
  const scoped = scopedWorkspaceState(state, projectId);
  if (projectId === undefined || !scoped.configRecords.some(record => record.collection === "chain" && record.key === "common-default")) return scoped;
  const context = await resolveProjectTarget({ libraryId: state.metadata.workspaceId, projectId }, home);
  if (!Array.isArray(context.settings) || context.status === "conflicting") throw effectiveConfigurationUnavailable(context);
  return effectiveFromSettings(state, scoped, context.settings as EffectiveSettingEntry[]);
}

/** What settings-catalog says of a target's common default (TCRN-CROSS-INIT-053 R46 I03). */
export interface CommonDefaultReading {
  readonly reference: ProjectReference;
  readonly status: "resolved" | "unresolved";
  // The status the common default's own target resolves to on this device.
  readonly targetStatus: string;
  // Present while unresolved: common-default-cycle when the common defaults lead back to a target
  // already on the way, else common-default-unresolved.
  readonly reason?: "common-default-unresolved" | "common-default-cycle";
}

/** The state the read catalog is built from, what it says of the common default, and the keys it reads as unresolved. */
export interface SettingsCatalogState {
  readonly state: ScopedWorkspaceState;
  // Null when the target names no common default.
  readonly commonDefault: CommonDefaultReading | null;
  // The optional project scalars that would inherit from an unresolved common default.
  readonly unresolvedKeys: readonly SettingKey[];
}

// Whether the common defaults a refusal names lead back into a cycle, at any depth.
function commonDefaultCycle(context: Readonly<Record<string, unknown>> | undefined): boolean {
  for (let current = context; current !== undefined && current !== null; current = current.common as Readonly<Record<string, unknown>> | undefined) {
    if (current.reason === "common-default-cycle") return true;
  }
  return false;
}

/**
 * TCRN-CROSS-INIT-053 R46 (I03; approved contract items 6, 7): the state settings-catalog reads for
 * a target. Without a common default it is the scoped state; with one that resolves, the effective
 * state (effectiveProjectState). A common default that does not resolve (unregistered, unavailable,
 * a cycle or anything else that keeps it from answering) no longer refuses the whole read: the
 * catalog is built on the scoped state, where the target's own, its declared ancestors' and its
 * library's declarations stand as they are, and every optional project scalar that would inherit from
 * the common default is marked with it as an unresolved source; the value is unknown, never the
 * built-in default. Every other refusal stands, and effectiveProjectState and resolveProjectTarget
 * still refuse such a target (F07), so nothing that applies configuration reads it.
 */
export async function settingsCatalogState(state: WorkspaceState, projectId?: string, home?: string): Promise<SettingsCatalogState> {
  const scoped = scopedWorkspaceState(state, projectId);
  const record = projectId === undefined ? undefined : scoped.configRecords.find(entry => entry.collection === "chain" && entry.key === "common-default");
  if (projectId === undefined || record === undefined) return { state: scoped, commonDefault: null, unresolvedKeys: [] };
  const reference = projectReference(record.value);
  const context = await resolveProjectTarget({ libraryId: state.metadata.workspaceId, projectId }, home);
  const common = context.common as Readonly<Record<string, unknown>> | undefined;
  if (context.status === "conflicting" && (context.reason === "common-default-unresolved" || context.reason === "common-default-cycle")) {
    const source: ConfigurationSource = { kind: "common", status: "unresolved", libraryId: reference.libraryId, projectId: reference.projectId, projectName: null, inherited: true };
    const unresolvedKeys = SETTINGS_CATALOG.filter(entry => entry.scope !== "library" && entry.shape !== "collection" && scoped.settingSources[entry.key]?.kind === "default").map(entry => entry.key);
    const marked = Object.fromEntries(unresolvedKeys.map(key => [key, source]));
    return {
      state: { ...scoped, settingSources: { ...scoped.settingSources, ...marked }, settingFallbackSources: { ...scoped.settingFallbackSources, ...marked } },
      commonDefault: { reference, status: "unresolved", targetStatus: String(common?.status ?? "conflicting"), reason: commonDefaultCycle(context) ? "common-default-cycle" : "common-default-unresolved" },
      unresolvedKeys,
    };
  }
  if (!Array.isArray(context.settings) || context.status === "conflicting") throw effectiveConfigurationUnavailable(context);
  return {
    state: effectiveFromSettings(state, scoped, context.settings as EffectiveSettingEntry[]),
    commonDefault: { reference, status: "resolved", targetStatus: String(common?.status) },
    unresolvedKeys: [],
  };
}

/** The catalog's rows as settingsCatalogState reads them: a row inheriting from an unresolved common default has no current and no inherited value. */
export function markUnresolvedCommonDefault(settings: SettingsCatalogReadback["settings"], reading: SettingsCatalogState): SettingsCatalogReadback["settings"] {
  const unresolved = new Set<SettingKey>(reading.unresolvedKeys);
  return settings.map(row => unresolved.has(row.key) ? { ...row, currentValue: null, inheritedValue: null } : row);
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
  if (local !== null && (local.role === "coordination" || local.role === "shared")) {
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
  if (identity?.role === "shared") return { libraryId: identity.coordinationLibraryId, path: root, created: false, written: false, status: "registered" };
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
 * STORY-480 R4/AC4: the registrations setup made for a coordination (chainRole coordination, the
 * library registered as its own project path) that an uninstall takes out of `registry`: all of
 * them once no other registration still names the coordination, else none. A registration whose
 * library cannot be read keeps them, and so does any other registration of the coordination itself.
 * It only reads: releaseSetupCoordination applies it under the registry lock, and the uninstall plan
 * judges with it the registry as it will stand once the project's own entry is out
 * (TCRN-CROSS-INIT-053 R46 I08).
 */
export async function releasableSetupCoordination(registry: Registry, libraryId: string): Promise<readonly RegistryEntry[]> {
  const made = registry.entries.filter(entry => entry.libraryId === libraryId && entry.chainRole === "coordination" && entry.projectPath === entry.libraryPath);
  if (made.length === 0) return [];
  for (const entry of registry.entries) {
    if (made.includes(entry)) continue;
    if (entry.libraryId === libraryId) return [];
    const named = await coordinationNamedBy(entry.libraryPath);
    if (named === undefined || named === libraryId) return [];
  }
  return made;
}

/**
 * STORY-480 R4/AC4: after an uninstall, take out the registration setup made for a coordination once
 * no other registration still names it (releasableSetupCoordination). The library is never written,
 * moved or deleted. Answers the registrations taken out.
 */
export async function releaseSetupCoordination(libraryId: string, home: string = deviceHome()): Promise<readonly RegistryEntry[]> {
  return unregisterEntries((registry) => releasableSetupCoordination(registry, libraryId), home);
}
