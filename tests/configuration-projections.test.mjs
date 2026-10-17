// SPDX-License-Identifier: Apache-2.0
import { asPinnedDevice } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvents, initializeLibrary, createProject, materializeWorkspace, setWorkspaceSetting } from "../dist/build/packages/core/src/workspace.js";
import { declareChainIdentity } from "../dist/build/packages/core/src/project-chain.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { planConfigurationProjectionRefresh, refreshConfigurationProjections, diagnoseLegacySharedPaths } from "../dist/build/packages/core/src/configuration-projections.js";

import { sortWorkspaceSettings, validateWorkspaceSettingRecord } from "../dist/build/packages/core/src/settings.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";

const at = "2026-10-17T08:00:00Z";
async function fixture(t, home) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "projection-contract-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function library(name, role = "project") {
    const path = join(root, name);
    const state = await initializeLibrary({ root: path, createdAt: at });
    await declareChainIdentity(path, { role, coordinationLibraryId: state.metadata.workspaceId }, { occurredAt: at });
    return { path, libraryId: state.metadata.workspaceId };
  }
  async function project(lib, name, parentProjectId) {
    const state = await createProject(lib.path, { externalKey: name, name, ...(parentProjectId ? { parentProjectId } : {}), occurredAt: at });
    const projectId = state.projects.find(project => project.externalKey === name).id;
    const output = join(root, name); await mkdir(output);
    await registerLibrary({ projectPath: output, libraryPath: lib.path, projectId, registeredAt: at, gitRemote: null }, home);
    return { libraryId: lib.libraryId, projectId, output, path: lib.path };
  }
  return { root, library, project };
}
test("invalidation discovers parent descendants and transitive cross-library common defaults", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home);
  const la = await f.library("lib-a"), lb = await f.library("lib-b"), lc = await f.library("lib-c");
  const a = await f.project(la, "A"), child = await f.project(la, "CHILD", a.projectId);
  const b = await f.project(lb, "B"), c = await f.project(lc, "C");
  for (const [target, dependency] of [[b, child], [c, b]]) await setConfigRecord(target.path, { collection: "chain", key: "common-default", projectId: target.projectId, value: { libraryId: dependency.libraryId, projectId: dependency.projectId }, occurredAt: at });
  const plan = await planConfigurationProjectionRefresh({ libraryId: a.libraryId, projectId: a.projectId });
  assert.deepEqual(new Set(plan.targets.map(target => target.projectId)), new Set([a, child, b, c].map(target => target.projectId)));
  assert.equal(plan.coverage, "known-device-registry-only");
  const all = await planConfigurationProjectionRefresh({ libraryId: la.libraryId });
  assert.ok(all.targets.some(target => target.projectId === c.projectId));
  await rename(lc.path, `${lc.path}-offline`);
  const offline = await planConfigurationProjectionRefresh({ libraryId: a.libraryId, projectId: a.projectId });
  assert.ok(offline.gaps.some(gap => gap.libraryId === c.libraryId && gap.status === "unavailable"));
  const missing = await planConfigurationProjectionRefresh({ libraryId: "library:" + "f".repeat(24) });
  assert.equal(missing.targets[0].status, "unavailable");
}));
test("refresh uses managed writer, preserves user edits and does not authorize arbitrary outputs", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home), lib = await f.library("lib");
  const target = await f.project(lib, "MAIN");
  const source = { libraryId: target.libraryId, projectId: target.projectId };
  const first = await refreshConfigurationProjections(source, { occurredAt: at });
  assert.equal(first.outcomes[0].status, "refreshed");
  const file = join(target.output, "AGENTS.md");
  const original = await readFile(file, "utf8");
  assert.match(original, /<!--/u);
  const edited = original.replace(/(<!--[^\n]*-->\n)/u, "$1User edited this section.\n");
  await writeFile(file, edited);
  const again = await refreshConfigurationProjections(source, { occurredAt: at });
  assert.equal(again.outcomes[0].status, "pending");
  assert.equal(await readFile(file, "utf8"), edited);
  const unknown = await refreshConfigurationProjections(source, { occurredAt: at, outputKeys: ["not-a-registered-output"] });
  assert.ok(unknown.outcomes.some(outcome => outcome.status === "refused"));
  assert.ok(unknown.outcomes.some(outcome => outcome.reason === "not-selected"));
  await setWorkspaceSetting(lib.path, { key: "agents.generation", value: "none", configurationProjectId: target.projectId, occurredAt: at });
  const disabled = await refreshConfigurationProjections(source, { occurredAt: at });
  assert.equal(disabled.outcomes[0].reason, "generation-disabled");
  assert.equal(await readFile(file, "utf8"), edited);
  await rm(target.output, { recursive: true });
  assert.equal((await refreshConfigurationProjections(source, { occurredAt: at })).outcomes[0].status, "unavailable");
}));
test("coordination refresh has only a library target and alternate device execution is refused", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home), lib = await f.library("coord", "coordination");
  const output = join(f.root, "container"); await mkdir(output);
  await registerLibrary({ projectPath: output, libraryPath: lib.path, registeredAt: at, gitRemote: null }, home);
  const source = { libraryId: lib.libraryId };
  const result = await refreshConfigurationProjections(source, { occurredAt: at });
  assert.equal(result.plan.targets.length, 1);
  assert.equal(result.plan.targets[0].projectId, undefined);
  assert.equal(result.outcomes[0].status, "refreshed");
  const otherHome = join(f.root, "other-device");
  const refused = await refreshConfigurationProjections(source, { occurredAt: at, home: otherHome });
  assert.equal(refused.outcomes[0].reason, "execution-requires-current-device-home");
}));
test("legacy diagnostics expose keys and migration actions, not private values; no history mutation", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home), lib = await f.library("legacy");
  const state = await materializeWorkspace(lib.path);
  const values = ["/fixture/private-person/docs", "C:\\fixture\\secret\\articles", "relative/docs", "binding:paths.artifacts"];
  const historical = { ...state, settings: values.map((value, i) => ({ key: i === 1 ? "knowledge.articlesPath" : "workspace.generatedArtifactsPath", value, tombstone: false, ...(i === 1 ? { projectId: "project:" + "a".repeat(24) } : {}) })) };
  const before = JSON.stringify(historical);
  const diagnostics = diagnoseLegacySharedPaths(historical);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every(diagnostic => diagnostic.status === "migration-required" && diagnostic.localBinding.startsWith("paths.")));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-person|secret|Users/u);
  assert.equal(JSON.stringify(historical), before);
  assert.equal((await materializeWorkspace(lib.path)).version, state.version);
}));

test("CLI plans and selectively refreshes registered outputs and reports value-free migration diagnostics", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home), lib = await f.library("cli-library");
  const target = await f.project(lib, "CLI");
  async function cli(args) { let text = ""; await runCli(args, { write: value => { text += value; } }); return JSON.parse(text); }
  const args = ["--workspace", lib.path, "--project-id", target.projectId];
  const plan = await cli(["configuration-projections-plan", ...args]);
  assert.equal(plan.reasonCode, "CONFIGURATION_PROJECTIONS_PLAN_READY");
  assert.equal(plan.targets.length, 1);
  const key = plan.targets[0].outputs[0].key;
  const skipped = await cli(["configuration-projections-refresh", ...args, "--at", at, "--output-keys", "[]"]);
  assert.equal(skipped.outcomes[0].reason, "not-selected");
  const refreshed = await cli(["configuration-projections-refresh", ...args, "--at", at, "--output-keys", JSON.stringify([key])]);
  assert.equal(refreshed.reasonCode, "CONFIGURATION_PROJECTIONS_REFRESH_FINISHED");
  assert.equal(refreshed.outcomes[0].status, "refreshed");
  // Historical replay fixture only: the normal write surface must continue rejecting absolute shared paths.
  const record = validateWorkspaceSettingRecord({ schemaVersion: "tcrn.workspace-setting.v1", layerKind: "workspace_configuration", key: "knowledge.articlesPath", value: "/fixture/private-history/articles", projectId: target.projectId, revision: 1, updatedAt: at, tombstone: false });
  await appendEvents(lib.path, [state => ({ payload: { operation: "settings.updated", record }, projects: state.projects, work: state.work, settings: sortWorkspaceSettings([...state.settings, record]) })], { occurredAt: at });
  const catalog = await cli(["settings-catalog", ...args]);
  assert.equal(catalog.migrationDiagnostics.length, 1);
  assert.equal(catalog.migrationDiagnostics[0].key, "knowledge.articlesPath");
  assert.equal(catalog.migrationDiagnostics[0].target.projectId, target.projectId);
  assert.doesNotMatch(JSON.stringify(catalog.migrationDiagnostics), /private-history|Users/u);
}));
