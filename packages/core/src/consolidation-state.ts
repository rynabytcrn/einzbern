import { compareSemver } from "./format-version.js";
// SPDX-License-Identifier: Apache-2.0
import type { WorkspaceState } from "./workspace.js";
import type { ConsolidationIndex, ConsolidationSource } from "./consolidation-format.js";
import { ConsolidationError } from "./consolidation-format.js";
import { SETTINGS_CATALOG } from "./settings.js";
import { configRecordIdentity } from "./config-records.js";
import { workspaceSettingIdentity } from "./project-scope.js";

/** Migration projection only. Original events remain byte/hash-identical in the source archives. */
export function consolidateStates(index: ConsolidationIndex, inputs: readonly { source: ConsolidationSource; state: WorkspaceState }[]): WorkspaceState {
  const primary = inputs.find(entry => entry.source.manifest.libraryId === index.primaryLibraryId)!.state;
  const ids = new Set(index.sources.map(source => source.manifest.libraryId));
  const reference = (value: unknown): unknown => {
    if (typeof value === "string" && ids.has(value)) return index.primaryLibraryId;
    if (Array.isArray(value)) return value.map(reference);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item)]));
    return value;
  };
  const unique = <T>(values: readonly T[], key: (entry: T) => string): T[] => {
    const map = new Map<string, T>();
    for (const value of values) {
      const id = key(value);
      if (map.has(id) && JSON.stringify(map.get(id)) !== JSON.stringify(value)) throw new ConsolidationError("CONSOLIDATION_RECORD_CONFLICT", `different records have the same identity: ${id}`);
      map.set(id, value);
    }
    return [...map.values()];
  };
  const settings: WorkspaceState["settings"][number][] = [];
  const configs: WorkspaceState["configRecords"][number][] = [];
  for (const { source, state } of inputs) {
    if (state.headEventHash !== source.headEventHash || JSON.stringify(state.library?.versionVector) !== JSON.stringify(source.versionVector) || state.library?.rejectedEvents.length) throw new ConsolidationError("CONSOLIDATION_SOURCE_CHANGED", "source head differs or contains rejected events");
    const roots = [...new Set(source.bindings.map(binding => binding.projectId))];
    for (const id of roots) if (!state.projects.some(project => project.id === id && !project.tombstone)) throw new ConsolidationError("CONSOLIDATION_BINDING_INVALID", `project ${id} is absent`);
    for (const setting of state.settings) {
      const libraryLevel = SETTINGS_CATALOG.find(entry => entry.key === setting.key)?.scope === "library";
      if (libraryLevel) {
        const existing = settings.find(entry => entry.projectId === undefined && entry.key === setting.key);
        if (existing && setting.key === "engine.requiredVersion") {
          if (compareSemver(setting.value, existing.value) > 0) settings.splice(settings.indexOf(existing), 1, setting);
          continue;
        }
        if (existing && existing.value !== setting.value) throw new ConsolidationError("CONSOLIDATION_LIBRARY_SETTING_CONFLICT", setting.key);
        if (!existing) settings.push(setting);
      } else if (setting.projectId !== undefined) settings.push(setting);
      else for (const projectId of roots) if (!state.settings.some(entry => entry.key === setting.key && entry.projectId === projectId)) settings.push({ ...setting, projectId });
    }
    for (const record of state.configRecords) {
      if (record.projectId !== undefined) { configs.push(reference(record) as typeof record); continue; }
      for (const projectId of roots) {
        if (state.configRecords.some(entry => entry.collection === record.collection && entry.key === record.key && entry.projectId === projectId)) continue;
        const value = reference(record.value) as typeof record.value;
        configs.push({ ...record, projectId, value: record.collection === "chain" && record.key === "identity" ? { ...value, primaryProjectId: projectId } : value });
      }
    }
  }
  // A shared library's role is global; each project retains its separately scoped role.
  const identity = primary.configRecords.find(record => record.collection === "chain" && record.key === "identity" && record.projectId === undefined);
  if (!identity) throw new ConsolidationError("CONSOLIDATION_BINDING_INVALID", "primary source has no chain identity");
  configs.push({ ...identity, value: { role: "shared", coordinationLibraryId: index.primaryLibraryId } });
  const collections = ["projects", "work", "conferences", "conferencePositions", "conferenceMinutes", "minutes", "gates"] as const;
  const combined = Object.fromEntries(collections.map(name => [name, unique(inputs.flatMap(entry => entry.state[name] as readonly { id: string; projectId?: string }[]), entry => name === "conferencePositions" ? JSON.stringify([entry.projectId, entry.id]) : entry.id).map(reference)]));
  const events = inputs.flatMap(entry => entry.state.events);
  const executionConfig = Object.fromEntries(Object.keys(primary.executionConfig).map(key => {
    const values = inputs.flatMap(entry => (entry.state.executionConfig as unknown as Record<string, unknown[]>)[key] ?? []);
    return [key, unique(values, entry => JSON.stringify(entry))];
  })) as unknown as WorkspaceState["executionConfig"];
  return { ...primary, ...combined, events, version: events.length, settings: unique(settings, entry => workspaceSettingIdentity(entry.key, entry.projectId)),
    configRecords: unique(configs, entry => configRecordIdentity(entry.collection, entry.key, entry.projectId)), executionConfig,
    templates: unique(inputs.flatMap(entry => entry.state.templates), entry => entry.registrationId),
  } as WorkspaceState;
}
