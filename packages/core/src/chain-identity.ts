// SPDX-License-Identifier: Apache-2.0
import type { WorkspaceState } from "./workspace.js";
import type { ConfigRecordValue } from "./config-records.js";
import { projectReference } from "./involved-projects.js";
export class ProjectChainError extends Error {
  readonly reasonCode = "PROJECT_CHAIN_INVALID";
}
export interface ChainIdentity {
  readonly primaryProjectId?: string;
  readonly role: "coordination" | "project" | "shared";
  readonly coordinationLibraryId: string;
}
const libraryId = (value: unknown): value is string => typeof value === "string" && /^(library|workspace):[a-f0-9]{24}$/u.test(value);
/** Canonical records travel in device streams; registries only locate them. */
export function checkChainRecord(value: ConfigRecordValue, key: string): void {
  if (key === "identity") {
    if (Object.keys(value).filter(field => field !== "primaryProjectId").sort().join(",") !== "coordinationLibraryId,role" || (value.primaryProjectId !== undefined && (typeof value.primaryProjectId !== "string" || !/^project:[a-f0-9]{24}$/u.test(value.primaryProjectId))) || !["coordination", "project", "shared"].includes(String(value.role)) || !libraryId(value.coordinationLibraryId)) throw new ProjectChainError("chain identity requires an explicit role and coordination library identity");
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
export function chainIdentity(state: Pick<WorkspaceState, "configRecords" | "metadata"> & { readonly configurationProjectId?: string | null }, projectId?: string): ChainIdentity | null {
  const target = projectId ?? state.configurationProjectId ?? undefined;
  const record = (target === undefined ? undefined : state.configRecords.find(r => r.collection === "chain" && r.key === "identity" && r.projectId === target)) ?? state.configRecords.find(r => r.collection === "chain" && r.key === "identity" && r.projectId === undefined);
  if (!record) return null;
  checkChainRecord(record.value, record.key);
  const identity = record.value as unknown as ChainIdentity;
  if ((identity.role === "coordination" || identity.role === "shared") && identity.coordinationLibraryId !== state.metadata.workspaceId) throw new ProjectChainError("coordination identity must name its own library");
  return identity;
}

/** Library-wide identity remains visible when a project-specific identity is effective. */
export function isSharedLibrary(state: Pick<WorkspaceState, "configRecords">): boolean {
  return state.configRecords.some(record => record.collection === "chain" && record.key === "identity" && record.projectId === undefined && record.value.role === "shared");
}
