// SPDX-License-Identifier: Apache-2.0
// Synthetic fixtures only. They do not establish real host invocation or installation acceptance.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAMEWORK_VERSION, initializeLibrary, createProject, createWork, declareChainIdentity } from "../../dist/build/packages/core/src/index.js";
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

/** Synthetic native observation for contract tests; never live-host evidence. */
export async function codexGuardFixture(f, cwd = process.cwd()) {
  const { mkdir, writeFile, realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { hostHookCommand, hookLauncherPath } = await import("../../dist/build/packages/core/src/host-hooks.js");
  const userHome = join(f.root, "user");
  const engine = join(f.home, "engine", FRAMEWORK_VERSION);
  await mkdir(join(engine, "scripts"), { recursive: true });
  await mkdir(join(engine, "launchers"), { recursive: true });
  await writeFile(join(f.home, "engine", "current"), JSON.stringify({ schemaVersion: "einzbern.engine-current.v1", version: FRAMEWORK_VERSION, previous: null, switchedAt: at }));
  const launcher = "// synthetic launcher contract fixture\n";
  await writeFile(join(f.home, "engine", "hook.mjs"), launcher);
  await writeFile(join(engine, "launchers", "hook.mjs"), launcher);
  await writeFile(join(engine, "scripts", "einzbern-hook.mjs"), 'export const CODEX_PEER_GUARD_CONTRACT = "einzbern.codex-peer-dispatch-guard.v1"; export function runPeerDispatchHookEvent() {}\n');
  await mkdir(join(userHome, ".codex"), { recursive: true });
  const command = hostHookCommand(hookLauncherPath(f.home), "PreToolUse", userHome);
  const sourcePath = join(userHome, ".codex", "hooks.json");
  const configPath = join(userHome, ".codex", "config.toml");
  const texts = [JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }), "[features]\nhooks = true\n"];
  await writeFile(sourcePath, texts[0]); await writeFile(configPath, texts[1]);
  const native = { schemaVersion: "tcrn.codex-hook-observation.v1", observedAt: new Date().toISOString(), version: "synthetic-only", cwd: await realpath(cwd),
    raw: { data: [{ cwd: await realpath(cwd), hooks: [{ eventName: "preToolUse", handlerType: "command", command, sourcePath, matcher: null, enabled: true, currentHash: `sha256:${"a".repeat(64)}`, trustStatus: "trusted" }], errors: [], warnings: [] }] },
    files: await Promise.all([sourcePath, configPath].map(async (path, i) => ({ path: await realpath(path), sha256: createHash("sha256").update(texts[i]).digest("hex") }))) };
  const admission = { state: "supported", version: "synthetic-only", evidenceRef: "fixture:hooks-list", preToolUse: true, trust: "permitted", native };
  const admissionPath = join(f.root, "native-admission.json");
  await writeFile(admissionPath, JSON.stringify(admission));
  return { userHome, native, admission, admissionPath };
}
