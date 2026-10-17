// SPDX-License-Identifier: Apache-2.0
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, win32 } from "node:path";
import { openLibrary } from "./ether-library.js";
import { readRegistry, withLibraryRepointLock } from "./registry.js";
import type { RegistryEntry } from "./registry.js";
import { assertLibraryWritable, materializeWorkspace, readLibraryTombstone } from "./workspace.js";
import type { WorkspaceState, WorkspaceMutationOptions } from "./workspace.js";
import { scopedWorkspaceState } from "./project-scope.js";
import { projectReference } from "./involved-projects.js";
import { chainIdentity } from "./chain-identity.js";
import { renderAgentsSections } from "./agents-sections.js";
import { readAgentsNavigation } from "./machine-settings.js";
import { deviceHome } from "./device-home.js";

export interface ConfigurationProjectionSource { readonly libraryId: string; readonly projectId?: string }
export interface ConfigurationProjectionTarget extends ConfigurationProjectionSource {
  readonly key: string;
  readonly libraryPath: string | null;
  readonly outputs: readonly { readonly key: string; readonly projectPath: string }[];
  readonly status: "pending" | "unavailable";
  readonly reason: string;
}
export interface ConfigurationProjectionPlan {
  readonly source: ConfigurationProjectionSource;
  readonly coverage: "known-device-registry-only";
  readonly targets: readonly ConfigurationProjectionTarget[];
  readonly gaps: readonly { readonly libraryId: string; readonly status: "unavailable"; readonly reason: string }[];
}
const targetKey = (target: ConfigurationProjectionSource): string => JSON.stringify([target.libraryId, target.projectId ?? null]);
interface Node { target: ConfigurationProjectionTarget; dependencies: string[] }

/** Conservative invalidation, not a claim that every scalar actually changed. No remote discovery. */
export async function planConfigurationProjectionRefresh(source: ConfigurationProjectionSource, options: { readonly home?: string } = {}): Promise<ConfigurationProjectionPlan> {
  const registry = await readRegistry(options.home);
  const groups = new Map<string, RegistryEntry[]>();
  for (const entry of registry.entries) groups.set(entry.libraryId, [...(groups.get(entry.libraryId) ?? []), entry]);
  const nodes = new Map<string, Node>();
  const gaps: ConfigurationProjectionPlan["gaps"][number][] = [];
  for (const [libraryId, entries] of groups) {
    let state: WorkspaceState;
    let root: string;
    let coordination: boolean;
    try {
      const paths = new Set(await Promise.all(entries.map(entry => realpath(entry.libraryPath))));
      if (paths.size !== 1) throw new Error("ambiguous-library-binding");
      root = [...paths][0]!;
      if ((await openLibrary(root)).manifest.libraryId !== libraryId || await readLibraryTombstone(root) !== null) throw new Error("invalid-library-identity");
      state = await materializeWorkspace(root);
      coordination = chainIdentity(state)?.role === "coordination";
    } catch {
      gaps.push({ libraryId, status: "unavailable", reason: "registered-library-unavailable-or-invalid" });
      continue;
    }
    const add = (projectId?: string): void => {
      const reference = { libraryId, ...(projectId === undefined ? {} : { projectId }) };
      const key = targetKey(reference);
      const bound = coordination ? entries : projectId === undefined ? [] : entries.filter(entry => entry.projectId === projectId);
      const outputs = [...new Set(bound.map(entry => entry.projectPath))].sort().map(projectPath => ({ key: JSON.stringify([libraryId, projectId ?? null, projectPath]), projectPath }));
      const dependencies: string[] = [];
      let reason = outputs.length ? "affected-declaration" : "output-unregistered";
      let status: ConfigurationProjectionTarget["status"] = "pending";
      try {
        if (projectId !== undefined) {
          dependencies.push(targetKey({ libraryId }));
          const project = state.projects.find(candidate => candidate.id === projectId)!;
          if (project.parentProjectId !== undefined) dependencies.push(targetKey({ libraryId, projectId: project.parentProjectId }));
          const common = scopedWorkspaceState(state, projectId).configRecords.find(record => record.collection === "chain" && record.key === "common-default");
          if (common !== undefined) dependencies.push(targetKey(projectReference(common.value)));
        }
      } catch { status = "unavailable"; reason = "invalid-project-dependency"; }
      nodes.set(key, { target: { ...reference, key, libraryPath: root, outputs, status, reason }, dependencies });
    };
    add();
    if (!coordination) for (const project of state.projects.filter(project => !project.tombstone)) add(project.id);
    for (const entry of entries) {
      if (!coordination && entry.projectId !== undefined && !nodes.has(targetKey(entry))) gaps.push({ libraryId, status: "unavailable", reason: "registered-project-absent-or-deleted" });
    }
  }
  const affected = new Set([targetKey(source)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, node] of nodes) if (!affected.has(key) && node.dependencies.some(dependency => affected.has(dependency))) { affected.add(key); changed = true; }
  }
  const targets = [...affected].sort().map(key => nodes.get(key)?.target ?? { ...source, key, libraryPath: null, outputs: [], status: "unavailable" as const, reason: "source-unregistered-or-unavailable" }).filter(target =>
    // Library-default graph vertices are not extra output obligations when actual project targets exist.
    target.projectId !== undefined || target.outputs.length > 0 || ![...nodes.values()].some(node => node.target.libraryId === target.libraryId && node.target.projectId !== undefined));
  return { source, coverage: "known-device-registry-only", targets, gaps };
}

export interface ConfigurationProjectionOutcome {
  readonly targetKey: string;
  readonly outputKey: string | null;
  readonly status: "refreshed" | "pending" | "unavailable" | "refused";
  readonly reason: string;
  readonly pendingSections?: readonly { readonly id: string; readonly file: string }[];
}
export interface ConfigurationProjectionRefreshResult {
  readonly plan: ConfigurationProjectionPlan;
  readonly outcomes: readonly ConfigurationProjectionOutcome[];
}
/** Explicit invocation only. Re-plan from registry, never execute caller-supplied paths or a stale plan. */
export async function refreshConfigurationProjections(source: ConfigurationProjectionSource, options: WorkspaceMutationOptions & { readonly home?: string; readonly outputKeys?: readonly string[] }): Promise<ConfigurationProjectionRefreshResult> {
  // This explicit CLI consumer is not called by Portal's already-pinned settings writes.
  // Declaration receipts only plan. Pin the registry before any library lock so a
  // registered output cannot switch between discovery and the managed write.
  if (options.home !== undefined && resolve(options.home) !== resolve(deviceHome())) return refreshUnderRegistryLock(source, options);
  return withLibraryRepointLock(() => refreshUnderRegistryLock(source, options), options.home);
}

async function refreshUnderRegistryLock(source: ConfigurationProjectionSource, options: WorkspaceMutationOptions & { readonly home?: string; readonly outputKeys?: readonly string[] }): Promise<ConfigurationProjectionRefreshResult> {
  const plan = await planConfigurationProjectionRefresh(source, options);
  const outcomes: ConfigurationProjectionOutcome[] = [];
  if (options.home !== undefined && resolve(options.home) !== resolve(deviceHome())) {
    return { plan, outcomes: [{ targetKey: targetKey(source), outputKey: null, status: "refused", reason: "execution-requires-current-device-home" }] };
  }
  const navigation = await readAgentsNavigation();
  const known = new Set(plan.targets.flatMap(target => target.outputs.map(output => output.key)));
  for (const key of options.outputKeys ?? []) if (!known.has(key)) outcomes.push({ targetKey: targetKey(source), outputKey: key, status: "refused", reason: "unknown-or-unaffected-output" });
  for (const target of plan.targets) {
    if (target.status === "unavailable" || !target.libraryPath || target.outputs.length === 0) {
      outcomes.push({ targetKey: target.key, outputKey: null, status: "unavailable", reason: target.reason });
      continue;
    }
    for (const output of target.outputs) {
      if (options.outputKeys !== undefined && !options.outputKeys.includes(output.key)) {
        outcomes.push({ targetKey: target.key, outputKey: output.key, status: "pending", reason: "not-selected" });
        continue;
      }
      try {
        await realpath(output.projectPath);
      } catch { outcomes.push({ targetKey: target.key, outputKey: output.key, status: "unavailable", reason: "registered-output-unavailable" }); continue; }
      try {
        await assertLibraryWritable(target.libraryPath);
        const state = await materializeWorkspace(target.libraryPath);
        // Coordination output belongs to its library, never to a fabricated development project.
        if (chainIdentity(state)?.role === "coordination" && target.projectId !== undefined) {
          outcomes.push({ targetKey: target.key, outputKey: output.key, status: "refused", reason: "coordination-requires-library-target" }); continue;
        }
        const rendered = await renderAgentsSections(target.libraryPath, {
          projectRoot: output.projectPath, navigation, occurredAt: options.occurredAt,
          ...(target.projectId === undefined ? {} : { configurationProjectId: target.projectId }),
          ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        });
        const pending = rendered.pending.length > 0 || rendered.sections.some(section => section.state !== "managed");
        const disabled = rendered.files.length === 0;
        outcomes.push({ targetKey: target.key, outputKey: output.key, status: pending || disabled ? "pending" : "refreshed", reason: disabled ? "generation-disabled" : pending ? "user-section-decision-required" : "managed-render-completed", pendingSections: rendered.pending });
      } catch (error) {
        const code = (error as { reasonCode?: unknown }).reasonCode;
        outcomes.push({ targetKey: target.key, outputKey: output.key, status: "refused", reason: typeof code === "string" && /^[A-Z][A-Z0-9_]+$/u.test(code) ? code : "managed-render-refused" });
      }
    }
  }
  return { plan, outcomes };
}

export interface LegacySharedPathDiagnostic {
  readonly target: ConfigurationProjectionSource;
  readonly key: string;
  readonly status: "migration-required";
  readonly localBinding: string;
  readonly action: "Configure the local binding, then explicitly update the shared declaration. Existing files and history are unchanged.";
}
/** Inspect declarations, not resolved device paths. Never include the private historical value. */
export function diagnoseLegacySharedPaths(state: Pick<WorkspaceState, "metadata" | "settings">): readonly LegacySharedPathDiagnostic[] {
  const bindings: Readonly<Record<string, string>> = { "workspace.generatedArtifactsPath": "paths.artifacts", "knowledge.articlesPath": "paths.knowledgeArticles" };
  return state.settings.flatMap(record => {
    const localBinding = bindings[record.key];
    if (record.tombstone || localBinding === undefined || !(isAbsolute(record.value) || win32.isAbsolute(record.value))) return [];
    return [{ target: { libraryId: state.metadata.workspaceId, ...(record.projectId === undefined ? {} : { projectId: record.projectId }) }, key: record.key, status: "migration-required" as const, localBinding, action: "Configure the local binding, then explicitly update the shared declaration. Existing files and history are unchanged." as const }];
  });
}
