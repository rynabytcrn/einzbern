// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, realpath, rename, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeLibrary, createProject, deleteProject, createWork, annotateWork, materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting, setConfigRecord, registerLibrary, unregisterLibrary, readRegistry, registryPath, withFileLock, declareChainIdentity, chainIdentity, workProjectContexts, resolveProjectTarget, registeredCoordination, ensureProjectCoordination, normalizeInvolvedProjects, involvedProjectsOf, projectLineage, scopedWorkspaceState, enableRule, disableRule, listRules, renderAgentsSections } from "../dist/build/packages/core/src/index.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = "2026-10-08T08:00:00Z";
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-project-chain-")));
  // This fixture owns all libraries and registry entries below root; no live roots.
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "device");
  async function library(name, role, coordinationId) {
    const path = join(root, name);
    const initial = await initializeLibrary({ root: path, createdAt: at });
    await declareChainIdentity(path, { role, coordinationLibraryId: coordinationId ?? initial.metadata.workspaceId }, { occurredAt: at });
    const state = await createProject(path, { externalKey: name.toUpperCase(), name: "Equal project name", occurredAt: at });
    const projectId = state.projects[0].id;
    const repo = join(root, `${name}-repo`); await mkdir(repo);
    await registerLibrary({ projectPath: repo, libraryPath: path, projectId, registeredAt: at, gitRemote: null }, home);
    return { path, repo, reference: { libraryId: state.metadata.workspaceId, projectId } };
  }
  const coordination = await library("coordination", "coordination");
  const a = await library("alpha", "project", coordination.reference.libraryId);
  const b = await library("beta", "project", coordination.reference.libraryId);
  return { root, home, coordination, a, b, library };
}
async function configure(target, suffix) {
  for (const [key, value] of Object.entries({ "design.authority": `https://${suffix}.example.test`, "design.repository": `https://example.test/${suffix}`, "design.pullRequestTarget": "main", "design.productionDocs": `https://${suffix}.example.test/docs`, "design.buildService": "build", "design.buildProject": suffix, "design.consumedVersion": "1.0.0", "artifact.language": suffix === "alpha" ? "en" : "fr" })) {
    await setWorkspaceSetting(target.path, { key, value, configurationProjectId: target.reference.projectId, occurredAt: at });
  }
}
test("Cross Project work reaches independent project settings and never grants access", async t => {
  const f = await fixture(t); await configure(f.a, "alpha"); await configure(f.b, "beta");
  const selected = { state: "selected", targets: [f.b.reference, f.a.reference, f.a.reference] };
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "CROSS-INIT", kind: "Initiative", parentId: null, title: "Two projects", involvedProjects: selected, occurredAt: at });
  const id = state.work[0].id;
  const contexts = await workProjectContexts(state, id, f.home);
  assert.equal(contexts.contexts.length, 2); assert.equal(contexts.developmentReady, false, "design declaration alone is not development readiness");
  assert.equal(contexts.writeAuthority, "not-granted");
  assert.ok(contexts.conflicts.includes("design.authority")); assert.ok(contexts.conflicts.includes("artifact.language"));
  for (const context of contexts.contexts) assert.equal(context.settings.find(s => s.key === "design.authority").source.libraryId, context.reference.libraryId);
  assert.deepEqual((await materializeWorkspaceFromGenesis(f.coordination.path)).work, (await materializeWorkspace(f.coordination.path)).work);
  await annotateWork(f.coordination.path, { id, expectedRevision: 1, involvedProjects: { state: "coordination-only", targets: [] }, occurredAt: at });
  await assert.rejects(annotateWork(f.coordination.path, { id, expectedRevision: 1, involvedProjects: { state: "undecided", targets: [] }, occurredAt: at }), /revision changed/u);
  assert.equal((await workProjectContexts(await materializeWorkspace(f.coordination.path), id, f.home)).coordinationReady, true);
});
test("legacy absence, explicit empty states and invalid selected shape stay distinct", () => {
  assert.deepEqual(involvedProjectsOf({}), { state: "undecided", targets: [] });
  assert.throws(() => normalizeInvolvedProjects({ state: "selected", targets: [] }));
  assert.throws(() => normalizeInvolvedProjects({ state: "selected", targets: [{ libraryId: "folder", projectId: "name" }] }));
  assert.throws(() => normalizeInvolvedProjects({ state: "coordination-only", targets: [{ libraryId: "library:" + "a".repeat(24), projectId: "project:" + "b".repeat(24) }] }));
});
test("registration preserves identity across devices; missing target does not become a default", async t => {
  const f = await fixture(t);
  assert.equal((await registeredCoordination(f.home)).libraryId, f.coordination.reference.libraryId);
  const secondHome = join(f.root, "second-device");
  await registerLibrary({ projectPath: f.coordination.repo, libraryPath: f.coordination.path, projectId: f.coordination.reference.projectId, registeredAt: at, gitRemote: null }, secondHome);
  assert.equal((await registeredCoordination(secondHome, f.coordination.reference.libraryId)).libraryId, f.coordination.reference.libraryId);
  assert.equal((await resolveProjectTarget(f.a.reference, secondHome)).status, "unregistered");
  await unregisterLibrary(f.a.repo, f.home);
  assert.equal((await resolveProjectTarget(f.a.reference, f.home)).status, "unregistered");
  await assert.rejects(registeredCoordination(secondHome, f.b.reference.libraryId), /register the restored coordination/u);
});
test("one product can bind Einzbern and generated Mana without two product identities", async t => {
  const f = await fixture(t);
  await setConfigRecord(f.a.path, { collection: "chain", key: "repositories", projectId: f.a.reference.projectId, value: { bindings: [
    { id: "engine", name: "Einzbern", repository: "https://example.test/engine", buildService: "local", buildProject: "engine" },
    { id: "helper", name: "Mana Orchestrate", repository: "https://example.test/helper", buildService: "generated-by-engine", buildProject: "lockstep" },
  ] }, occurredAt: at });
  const state = await materializeWorkspaceFromGenesis(f.a.path);
  assert.equal(state.configRecords.find(record => record.key === "repositories").value.bindings.length, 2);
  assert.equal(chainIdentity(state).coordinationLibraryId, f.coordination.reference.libraryId);
  const previous = state.version;
  assert.equal((await declareChainIdentity(f.a.path, chainIdentity(state), { occurredAt: at })).version, previous);
});
test("coordination development settings are refused; ancestry and common defaults are explicit", async t => {
  const f = await fixture(t); await configure(f.a, "alpha");
  await assert.rejects(setWorkspaceSetting(f.coordination.path, { key: "design.authority", value: "https://example.test", occurredAt: at }), /coordination chains/u);
  assert.equal(scopedWorkspaceState(await materializeWorkspace(f.coordination.path)).settings.some(entry => entry.key === "design.authority"), false);
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: f.a.reference, occurredAt: at });
  const resolved = await resolveProjectTarget(f.b.reference, f.home);
  assert.equal(resolved.settings.find(entry => entry.key === "design.authority").source.kind, "common");
  await setConfigRecord(f.a.path, { collection: "chain", key: "common-default", projectId: f.a.reference.projectId, value: f.b.reference, occurredAt: at });
  assert.equal((await resolveProjectTarget(f.a.reference, f.home)).status, "conflicting");
});
test("child scope never inherits selected targets and cannot exceed an explicit parent", async t => {
  const f = await fixture(t);
  await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "PARENT", kind: "Initiative", parentId: null, involvedProjects: { state: "selected", targets: [f.a.reference] }, occurredAt: at });
  const parentId = deriveStableId("work", "PARENT");
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "CHILD", kind: "Epic", parentId, occurredAt: at });
  assert.equal(involvedProjectsOf(state.work.find(entry => entry.externalKey === "CHILD")).state, "undecided");
  await assert.rejects(annotateWork(f.coordination.path, { id: deriveStableId("work", "CHILD"), involvedProjects: { state: "selected", targets: [f.b.reference] }, occurredAt: at }), /exceed/u);
});


test("fresh project installation creates one explicit coordination identity and repeats reuse it", async t => {
  const f = await fixture(t);
  const emptyHome = join(f.root, "fresh-device");
  const root = join(f.root, "fresh-project");
  await initializeLibrary({ root, createdAt: at });
  const first = await ensureProjectCoordination(root, at, emptyHome);
  const repeated = await ensureProjectCoordination(root, at, emptyHome);
  assert.equal(first.created, true); assert.equal(repeated.created, false);
  assert.equal(repeated.libraryId, first.libraryId);
  const second = join(f.root, "other-project"); await initializeLibrary({ root: second, createdAt: at });
  assert.equal((await ensureProjectCoordination(second, at, emptyHome)).libraryId, first.libraryId);
  assert.equal(chainIdentity(await materializeWorkspaceFromGenesis(second)).role, "project");
  assert.equal(chainIdentity(await materializeWorkspaceFromGenesis(first.path)).role, "coordination");
});


test("restored concrete identity reuses its canonical project on a differently named device root", async t => {
  const f = await fixture(t);
  const { ensureSetupProjectBinding } = await import("../dist/build/packages/core/src/setup-fresh.js");
  const identity = chainIdentity(await materializeWorkspace(f.a.path));
  await declareChainIdentity(f.a.path, { ...identity, primaryProjectId: f.a.reference.projectId }, { occurredAt: at });
  const secondRoot = join(f.root, "renamed-checkout"); await mkdir(secondRoot);
  assert.equal(await ensureSetupProjectBinding(secondRoot, f.a.path, { at, deviceHome: join(f.root, "other-device") }), f.a.reference.projectId);
});


test("unavailable, invalid, deleted and duplicate registered target locations remain distinct", async t => {
  const f = await fixture(t);
  await rename(f.a.path, f.a.path + "-saved");
  assert.equal((await resolveProjectTarget(f.a.reference, f.home)).status, "unavailable");
  await mkdir(f.a.path);
  assert.equal((await resolveProjectTarget(f.a.reference, f.home)).status, "invalid-chain");
  await deleteProject(f.b.path, { id: f.b.reference.projectId, occurredAt: at });
  assert.equal((await resolveProjectTarget(f.b.reference, f.home)).status, "project-deleted");
  const third = await f.library("gamma", "project", f.coordination.reference.libraryId);
  const duplicate = join(f.root, "restored-gamma");
  await cp(third.path, duplicate, { recursive: true });
  const repo = join(f.root, "restored-gamma-repo"); await mkdir(repo);
  await registerLibrary({ projectPath: repo, libraryPath: duplicate, projectId: third.reference.projectId, registeredAt: at, gitRemote: null }, f.home);
  const ambiguous = await resolveProjectTarget(third.reference, f.home);
  assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(ambiguous.reference, third.reference);
});


test("declared ancestry retains provenance and mixed authority bundles are conflicting", async t => {
  const f = await fixture(t); await configure(f.a, "alpha");
  const state = await createProject(f.a.path, { externalKey: "CHILD-PROJECT", name: "Child", parentProjectId: f.a.reference.projectId, occurredAt: at });
  const child = state.projects.find(project => project.externalKey === "CHILD-PROJECT");
  const repo = join(f.root, "child-repo"); await mkdir(repo);
  await registerLibrary({ projectPath: repo, libraryPath: f.a.path, projectId: child.id, registeredAt: at, gitRemote: null }, f.home);
  const reference = { libraryId: f.a.reference.libraryId, projectId: child.id };
  const inherited = await resolveProjectTarget(reference, f.home);
  assert.equal(inherited.status, "configured");
  assert.equal(inherited.settings.find(entry => entry.key === "design.authority").source.projectId, f.a.reference.projectId);
  await setWorkspaceSetting(f.a.path, { key: "design.authority", value: "https://child.example.test", configurationProjectId: child.id, occurredAt: at });
  assert.equal((await resolveProjectTarget(reference, f.home)).status, "conflicting");
  assert.throws(() => projectLineage({ projects: [{ ...child, parentProjectId: child.id }] }, child.id), /cycle/u);
  assert.throws(() => projectLineage({ projects: [child] }, child.id), /absent/u);
});

test("coordination retains local runtime records without inheriting development settings", async t => {
  const f = await fixture(t);
  await setConfigRecord(f.coordination.path, { collection: "variable", key: "runtime.note", value: { type: "string", value: "coordination", description: "Runtime note" }, occurredAt: at });
  const native = await materializeWorkspace(f.coordination.path);
  const scoped = scopedWorkspaceState(native);
  assert.equal(scoped.configRecords.find(r => r.collection === "variable").value.value, "coordination");
  assert.equal(scoped.configSources[JSON.stringify(["variable", "runtime.note"])].kind, "library");
  assert.equal(scoped.settings.some(s => s.key === "design.authority"), false);
});
test("coordination discovery reports a known unavailable unrelated project but refuses an expected unavailable chain", async t => {
  const f = await fixture(t);
  await rename(f.a.path, f.a.path + "-offline");
  const found = await registeredCoordination(f.home);
  assert.equal(found.libraryId, f.coordination.reference.libraryId);
  assert.deepEqual(found.unavailable, [{ libraryId: f.a.reference.libraryId, path: f.a.path }]);
  await assert.rejects(registeredCoordination(f.home, f.a.reference.libraryId), /cannot classify/u);
  await rename(f.coordination.path, f.coordination.path + "-offline");
  await assert.rejects(registeredCoordination(f.home), /cannot classify/u);
});
test("operation readiness separates gate declarations from models, repository and design", async t => {
  const f = await fixture(t); await configure(f.a, "alpha");
  let target = await resolveProjectTarget(f.a.reference, f.home);
  assert.equal(target.readiness.design.ready, true);
  assert.equal(target.readiness.model.ready, false);
  assert.equal(target.readiness.repository.ready, false);
  assert.equal(target.readiness.development.ready, false);
  assert.equal(target.design.publicationVerification, "unverified");
  await setConfigRecord(f.a.path, { collection: "gate", key: "own", projectId: f.a.reference.projectId, value: { command: [process.execPath, "-e", "process.exit(0)"], root: ".", covers: ["**"], required: true, enabled: true, releaseOnly: false }, occurredAt: at });
  target = await resolveProjectTarget(f.a.reference, f.home);
  assert.equal(target.readiness.gates.ready, true);
  assert.equal(target.readiness.development.ready, false);
});

test("coordination rule writes preserve runtime enable/disable and never create managed prose", async t => {
  const f = await fixture(t);
  const input = { libraryRoot: f.coordination.path, projectRoot: f.coordination.path, id: "autonomy", occurredAt: at };
  const enabled = await enableRule(input);
  assert.equal(enabled.status.state, "enabled");
  assert.equal(enabled.written, false);
  assert.equal((await listRules({ libraryRoot: f.coordination.path })).find(rule => rule.id === "autonomy").state, "enabled");
  await assert.rejects(renderAgentsSections(f.coordination.path, { projectRoot: f.coordination.path, navigation: null, occurredAt: at }), /managed prose/u);
  const disabled = await disableRule(input);
  assert.equal(disabled.status.state, "disabled");
  assert.equal(disabled.written, false);
});

test("registry exclusion spans a complete consumer operation, so rebinding cannot interleave", async t => {
  const f = await fixture(t);
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const acquired = new Promise(resolve => { entered = resolve; });
  const consumer = withFileLock(`${registryPath(f.home)}.lock`, async () => {
    entered(); await barrier;
    assert.ok((await readRegistry(f.home)).entries.some(entry => entry.projectPath === f.a.repo));
  });
  await acquired;
  const unregister = unregisterLibrary(f.a.repo, f.home);
  release(); await consumer;
  assert.equal(await unregister, true);
  assert.equal((await readRegistry(f.home)).entries.some(entry => entry.projectPath === f.a.repo), false);
});
