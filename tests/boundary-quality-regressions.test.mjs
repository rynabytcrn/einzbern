// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeLibrary, materializeWorkspace, createProject } from "../dist/build/packages/core/src/workspace.js";
import { managedOutputBinding, renderAgentsSections } from "../dist/build/packages/core/src/agents-sections.js";
import { declareChainIdentity, resolveProjectTarget } from "../dist/build/packages/core/src/project-chain.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { applyMachineSettingSet, applyMachineSettingRemove, readMachineSettings } from "../dist/build/packages/core/src/machine-settings.js";

const at = "2026-10-18T06:00:00Z";
async function scratch(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-boundary-quality-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("managed output refuses two-dot-prefixed descendants without changing files or history", async t => {
  const base = await scratch(t), root = join(base, "library");
  const state = await initializeLibrary({ root, createdAt: at });
  for (const name of ["..cache", "..cache/nested", "ordinary"]) {
    const projectRoot = join(root, name);
    await mkdir(projectRoot, { recursive: true });
    await assert.rejects(managedOutputBinding(root, projectRoot, state), { reasonCode: "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY" });
    await assert.rejects(renderAgentsSections(root, { projectRoot, navigation: null, occurredAt: at }), { reasonCode: "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY" });
    await assert.rejects(stat(join(projectRoot, "AGENTS.md")), { code: "ENOENT" });
  }
  await assert.rejects(managedOutputBinding(root, root, state), { reasonCode: "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY" });
  const sibling = join(base, "..sibling"); await mkdir(sibling);
  assert.equal(await managedOutputBinding(root, sibling, state), "bound");
  assert.equal(await managedOutputBinding(root, base, state), "bound");
  assert.equal((await materializeWorkspace(root)).headEventHash, state.headEventHash);
});

test("coordination output cannot bind a two-dot-prefixed library descendant", async t => {
  const base = await scratch(t), root = join(base, "library"), home = join(base, "device");
  const initial = await initializeLibrary({ root, createdAt: at });
  const state = await declareChainIdentity(root, { role: "coordination", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt: at });
  const inner = join(root, "..cache"); await mkdir(inner);
  await registerLibrary({ projectPath: inner, libraryPath: root, registeredAt: at, gitRemote: null }, home);
  assert.equal(await managedOutputBinding(root, inner, state, home), "unconfigured");
});

test("project readiness rejects two-dot-prefixed output descendants", async t => {
  const base = await scratch(t), root = join(base, "library"), home = join(base, "device");
  const initial = await initializeLibrary({ root, createdAt: at });
  await declareChainIdentity(root, { role: "project", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt: at });
  const state = await createProject(root, { externalKey: "BOUNDARY", name: "Boundary", occurredAt: at });
  const projectId = state.projects[0].id;
  const inner = join(root, "..cache"); await mkdir(inner);
  await registerLibrary({ projectPath: inner, libraryPath: root, projectId, registeredAt: at, gitRemote: null }, home);
  const target = await resolveProjectTarget({ libraryId: state.metadata.workspaceId, projectId }, home);
  assert.equal(target.repositoryContexts[0].outputReady, false);
  assert.equal(target.readiness.output.ready, false);
});

test("machine setting set rejects an empty timestamp before creating or replacing a file", async t => {
  const path = join(await scratch(t), "machine-settings.json");
  const input = { path, key: "portal.defaultTheme", value: "dark", occurredAt: "" };
  await assert.rejects(applyMachineSettingSet(input), { reasonCode: "MACHINE_SETTINGS_FILE_INVALID" });
  await assert.rejects(stat(path), { code: "ENOENT" });
  await applyMachineSettingSet({ ...input, occurredAt: at });
  const before = await readFile(path);
  await assert.rejects(applyMachineSettingSet({ ...input, value: "light" }), { reasonCode: "MACHINE_SETTINGS_FILE_INVALID" });
  assert.deepEqual(await readFile(path), before);
  assert.equal((await readMachineSettings(path)).values["portal.defaultTheme"], "dark");
});

test("machine setting remove rejects an empty timestamp before replacement or last-value removal", async t => {
  const path = join(await scratch(t), "machine-settings.json");
  await applyMachineSettingSet({ path, key: "portal.defaultTheme", value: "dark", occurredAt: at });
  for (const extra of [false, true]) {
    if (extra) await applyMachineSettingSet({ path, key: "portal.port", value: "4321", occurredAt: at });
    const before = await readFile(path);
    await assert.rejects(applyMachineSettingRemove({ path, key: "portal.defaultTheme", occurredAt: "" }), { reasonCode: "MACHINE_SETTINGS_FILE_INVALID" });
    assert.deepEqual(await readFile(path), before);
    assert.equal((await readMachineSettings(path)).values["portal.defaultTheme"], "dark");
  }
});

test("machine settings retain their existing nonempty timestamp compatibility", async t => {
  const path = join(await scratch(t), "machine-settings.json"), legacy = "historical nonempty timestamp";
  await applyMachineSettingSet({ path, key: "portal.defaultTheme", value: "dark", occurredAt: legacy });
  await applyMachineSettingSet({ path, key: "portal.port", value: "4321", occurredAt: at });
  await applyMachineSettingRemove({ path, key: "portal.port", occurredAt: legacy });
  assert.equal((await readMachineSettings(path)).updatedAt, legacy);
});
