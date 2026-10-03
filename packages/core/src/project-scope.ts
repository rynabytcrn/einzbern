// SPDX-License-Identifier: Apache-2.0

import { SETTINGS_CATALOG, assertSettingWriteConsistent, readSettingsCatalog, settingsCatalogEntry } from "./settings.js";
import type { SettingKey, WorkspaceSettingRecord } from "./settings.js";
import type { ConfigRecord } from "./config-records.js";
import type { ProjectRecord, WorkspaceState } from "./workspace.js";

export class ProjectScopeError extends Error {
  readonly reasonCode = "WORKSPACE_INPUT_INVALID";
  constructor(message: string, readonly details?: Readonly<Record<string, unknown>>) { super(message); this.name = "ProjectScopeError"; }
}

export interface ConfigurationSource {
  readonly kind: "project" | "library" | "default";
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly inherited: boolean;
}

/** Stable declared ancestry only. A path, display name or sole registry entry never implies it. */
export function projectLineage(state: Pick<WorkspaceState, "projects">, projectId?: string): readonly ProjectRecord[] {
  if (projectId === undefined) return [];
  const result: ProjectRecord[] = [];
  const seen = new Set<string>();
  let id: string | undefined = projectId;
  while (id !== undefined) {
    if (seen.has(id)) throw new ProjectScopeError("project ancestry contains a cycle", { projectId, id });
    seen.add(id);
    const project = state.projects.find((entry) => entry.id === id && !entry.tombstone);
    if (project === undefined) throw new ProjectScopeError("project scope is absent or deleted in this library", { projectId, id });
    result.push(project);
    id = project.parentProjectId;
  }
  return result;
}

export function workspaceSettingIdentity(key: string, projectId?: string): string {
  return projectId === undefined ? key : JSON.stringify([projectId, key]);
}

export function assertSettingScope(state: WorkspaceState, key: string, projectId?: string): void {
  projectLineage(state, projectId);
  if (projectId !== undefined && settingsCatalogEntry(key).scope === "library") {
    throw new ProjectScopeError("this setting belongs to the whole library and cannot have a project override", { key, projectId });
  }
}

export type ScopedWorkspaceState = WorkspaceState & {
  readonly configurationProjectId: string | null;
  readonly settingSources: Readonly<Partial<Record<SettingKey, ConfigurationSource>>>;
  readonly settingFallbackValues: Readonly<Partial<Record<SettingKey, string | null>>>;
  readonly settingFallbackSources: Readonly<Partial<Record<SettingKey, ConfigurationSource>>>;
  readonly configSources: Readonly<Record<string, ConfigurationSource>>;
};

export const DESIGN_CONFIGURATION_KEYS = Object.freeze([
  "design.authority", "design.repository", "design.pullRequestTarget", "design.productionDocs",
  "design.buildService", "design.buildProject", "design.consumedVersion",
] as const satisfies readonly SettingKey[]);

export function designConfiguration(state: Pick<ScopedWorkspaceState, "settings"> & Partial<Pick<ScopedWorkspaceState, "configurationProjectId" | "settingSources">>): {
  readonly status: "unconfigured" | "conflicting" | "declared";
  readonly publicationVerification: "unverified";
  readonly bindings: readonly { readonly key: SettingKey; readonly value: string | null; readonly source: ConfigurationSource }[];
  readonly missing: readonly SettingKey[];
} {
  const bindings = DESIGN_CONFIGURATION_KEYS.map((key) => ({ key, value: state.settings.find((entry) => entry.key === key)?.value ?? null,
    source: state.settingSources?.[key] ?? { kind: state.settings.some((entry) => entry.key === key) ? "library" as const : "default" as const, projectId: null, projectName: null, inherited: state.settings.some((entry) => entry.key === key) && state.configurationProjectId != null } }));
  const missing = bindings.filter((entry) => entry.value === null).map((entry) => entry.key);
  const authoritySource = bindings[0]!.source;
  // A new local authority cannot silently borrow another authority’s inherited publication bindings.
  // Explicit local companion declarations are valid; the application’s consumed version may be local.
  const conflicting = bindings.some((entry) => entry.key !== "design.consumedVersion" && entry.value !== null && entry.source.inherited && entry.source.projectId !== authoritySource.projectId);
  return { status: missing.length > 0 ? "unconfigured" : conflicting ? "conflicting" : "declared", publicationVerification: "unverified", bindings, missing };
}

/** Read view; never pass it to appendEvents as the replacement for the full native state. */
export function scopedWorkspaceState(state: WorkspaceState, projectId?: string): ScopedWorkspaceState {
  const lineage = projectLineage(state, projectId);
  const scopes: readonly (string | undefined)[] = [...lineage.map((entry) => entry.id), undefined];
  const source = (scope: string | undefined): ConfigurationSource => ({
    kind: scope === undefined ? "library" : "project", projectId: scope ?? null,
    projectName: scope === undefined ? null : lineage.find((entry) => entry.id === scope)?.name ?? null,
    inherited: scope !== projectId,
  });
  const settingSources: Partial<Record<SettingKey, ConfigurationSource>> = {};
  const settingFallbackValues: Partial<Record<SettingKey, string | null>> = {};
  const settingFallbackSources: Partial<Record<SettingKey, ConfigurationSource>> = {};
  const settings: WorkspaceSettingRecord[] = [];
  const fallbackRecords: WorkspaceSettingRecord[] = [];
  for (const entry of SETTINGS_CATALOG) {
    const eligible = entry.scope === "library" ? [undefined] : scopes;
    const record = eligible.map((scope) => state.settings.find((value) => value.key === entry.key && value.projectId === scope)).find((value) => value !== undefined);
    const fallback = eligible.filter((scope) => scope !== (entry.scope === "library" ? undefined : projectId)).map((scope) => state.settings.find((value) => value.key === entry.key && value.projectId === scope)).find((value) => value !== undefined);
    if (fallback !== undefined) fallbackRecords.push(fallback);
    settingFallbackValues[entry.key] = fallback?.value ?? entry.defaultValue;
    settingFallbackSources[entry.key] = fallback === undefined ? { kind: "default", projectId: null, projectName: null, inherited: false } : source(fallback.projectId);
    if (record !== undefined) { settings.push(record); settingSources[entry.key] = source(record.projectId); }
    else settingSources[entry.key] = { kind: "default", projectId: null, projectName: null, inherited: false };
  }
  for (const entry of readSettingsCatalog(state.metadata.workspaceId, fallbackRecords).settings) settingFallbackValues[entry.key] = entry.currentValue;
  const configRecords: ConfigRecord[] = [];
  const configSources: Record<string, ConfigurationSource> = {};
  const seen = new Set<string>();
  for (const scope of scopes) for (const record of state.configRecords) {
    if (record.projectId !== scope) continue;
    // Gate roots/coverage and file digests are specific to their actual target, not inheritable values.
    if ((record.collection === "managed-section" || record.collection === "gate") && scope !== projectId) continue;
    const identity = JSON.stringify([record.collection, record.key]);
    if (seen.has(identity)) continue;
    seen.add(identity); configRecords.push(record); configSources[identity] = source(scope);
  }
  return { ...state, settings, configRecords, configurationProjectId: projectId ?? null, settingSources, settingFallbackValues, settingFallbackSources, configSources };
}

/** A parent write must keep every descendant's category/tier/ceiling references coherent. */
export function assertScopedSettingWriteConsistent(state: WorkspaceState, key: string, value: string | null, projectId?: string): void {
  assertSettingScope(state, key, projectId);
  if (!["models.category", "models.tiers", "models.escalation.ceiling"].includes(key)) return;
  const prospective = state.settings.filter((record) => !(record.key === key && record.projectId === projectId));
  if (value !== null) prospective.push({ schemaVersion: "tcrn.workspace-setting.v1", layerKind: "workspace_configuration", key: key as SettingKey, value, revision: 1, updatedAt: "2000-01-01T00:00:00.000Z", tombstone: false, ...(projectId === undefined ? {} : { projectId }) });
  const next = { ...state, settings: prospective };
  for (const target of [undefined, ...state.projects.filter((entry) => !entry.tombstone).map((entry) => entry.id)]) {
    const before = scopedWorkspaceState(state, target);
    const after = scopedWorkspaceState(next, target);
    const previousValue = before.settings.find((record) => record.key === key)?.value ?? null;
    const nextValue = after.settings.find((record) => record.key === key)?.value ?? null;
    if (previousValue === nextValue) continue;
    // The original table is needed to distinguish a dropped, still-referenced
    // category from an unknown reference. The effective reset value may inherit.
    assertSettingWriteConsistent(before.settings, key, nextValue);
  }
}
