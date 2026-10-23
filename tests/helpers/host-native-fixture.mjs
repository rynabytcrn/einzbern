// SPDX-License-Identifier: Apache-2.0
// Synthetic fixtures only. They do not establish real host invocation or installation acceptance.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeLibrary, createProject, createWork, declareChainIdentity } from "../../dist/build/packages/core/src/index.js";
export const tuple = { runner: "codex", model: "fixture-model", effort: "max" };
export const selection = { kind: "explicit", tuple };
export const at = "2026-10-21T00:00:00Z";
export function requestFor(work, extra = {}) {
  return { schemaVersion: "tcrn.host-execution-request.v1", workId: work.id, workRevision: work.revision, action: "decomposition", phase: "dispatch", category: "main", rejections: 0, requestedAgents: 1,
    capabilities: { hostKind: "codex", invocationKind: "native-tool", selectionControl: "explicit", toolName: "fixture.spawn", toolAvailable: true, requestedSelectionSupported: "supported", hostManagedSupported: true }, selection,
    authorization: { status: "covered", basis: "existing user authorization fixture", actions: ["decomposition", "research", "coordination", "implementation"], hosts: ["codex", "claude", "dot"], workIds: [work.id], fallback: "same-host" },
    context: { parent: "read", child: "not-created" }, ...extra };
}
export async function nativeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-host-native-"));
  const home = join(root, "device"); const workspace = join(root, "library");
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = await initializeLibrary({ root: workspace, createdAt: at });
  await declareChainIdentity(workspace, { role: "coordination", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt: at });
  const project = await createProject(workspace, { externalKey: "HOST", name: "Host fixture", occurredAt: at });
  const state = await createWork(workspace, { projectId: project.projects[0].id, externalKey: "INIT-064-SHAPE", kind: "Initiative", parentId: null, title: "Coordination only", involvedProjects: { state: "coordination-only", targets: [] }, occurredAt: at });
  const work = state.work[0];
  return { root, home, workspace, state, work, request: requestFor(work) };
}
