// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, realpath, rename, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEvents, sortWorkspaceSettings, validateWorkspaceSettingRecord, applyEngineModelPolicySet, initializeLibrary, createProject, deleteProject, createWork, annotateWork, materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting, removeWorkspaceSetting, setConfigRecord, removeConfigRecord, registerLibrary, readRegistry, registryPath, withFileLock, declareChainIdentity, chainIdentity, workProjectContexts, resolveProjectTarget, registeredCoordination, ensureProjectCoordination, effectiveProjectState, normalizeInvolvedProjects, involvedProjectsOf, projectLineage, scopedWorkspaceState, enableRule, disableRule, listRules, renderAgentsSections, readSettingsCatalog } from "../dist/build/packages/core/src/index.js";
import { applyMachineSettingSet, readMachineSettingsCatalog } from "../dist/build/packages/core/src/machine-settings.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { unregisterLibrary } from "../dist/build/packages/core/src/registry.js";
import { canonicalJson, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { readAllStreams } from "../dist/build/packages/core/src/akasha.js";

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
const policyDecision = { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: `library:${"b".repeat(24)}` };
async function configureDevicePolicy(f, host = "codex") {
  return applyEngineModelPolicySet({ home: f.home, host, occurredAt: at, actor: "agent:fixture", authorization: policyDecision,
    policy: { categories: [{ order: 10, id: "main", name: "Main", description: "" }],
      tiers: [{ order: 10, category: "main", runner: host, model: "fixture-device-main", effort: "max", note: "" }],
      escalation: { enabled: true, threshold: 2, ceiling: "main" } },
  });
}
// Test-only historical event fixture: validate replay records without using today's retired write surface.
async function appendHistoricalSetting(target, key, value) {
  const record = validateWorkspaceSettingRecord({ schemaVersion: "tcrn.workspace-setting.v1", layerKind: "workspace_configuration",
    key, value, projectId: target.reference.projectId, revision: 1, updatedAt: at, tombstone: false });
  return appendEvents(target.path, [(state) => ({ payload: { operation: "settings.updated", record }, projects: state.projects,
    work: state.work, settings: sortWorkspaceSettings([...state.settings, record]) })], { occurredAt: at });
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

test("MIN291 D1: an optional design authority does not block development, while a declared conflict does", async t => {
  const f = await fixture(t);
  const remote = "https://example.test/alpha";
  await registerLibrary({ projectPath: f.a.repo, libraryPath: f.a.path, projectId: f.a.reference.projectId, registeredAt: at, gitRemote: remote }, f.home);
  await setWorkspaceSetting(f.a.path, { key: "artifact.language", value: "en", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  await configureDevicePolicy(f);
  await setConfigRecord(f.a.path, { collection: "chain", key: "repositories", projectId: f.a.reference.projectId, value: { bindings: [{ id: "alpha", name: "Alpha", repository: remote, buildService: "test", buildProject: "alpha" }] }, occurredAt: at });
  await setConfigRecord(f.a.path, { collection: "gate", key: "alpha", projectId: f.a.reference.projectId, value: { command: [process.execPath, "-e", "process.exit(0)"], root: ".", covers: ["**"], required: true, enabled: true, releaseOnly: false }, occurredAt: at });

  const optional = await resolveProjectTarget(f.a.reference, f.home);
  assert.equal(optional.status, "unconfigured", "the absence stays visible");
  assert.deepEqual(optional.readiness.design, { ready: true, missing: [] }, "an absent authority adds no artificial design requirement");
  assert.equal(optional.readiness.model.ready, true);
  assert.equal(optional.readiness.repository.ready, true);
  assert.equal(optional.readiness.output.ready, true);
  assert.equal(optional.readiness.language.ready, true);
  assert.equal(optional.readiness.development.ready, true, "all non-design development prerequisites are enough");

  await setWorkspaceSetting(f.a.path, { key: "design.authority", value: "https://alpha.example.test", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  const partial = await resolveProjectTarget(f.a.reference, f.home);
  assert.equal(partial.readiness.design.ready, false, "declaring authority activates companion requirements");
  assert.ok(partial.readiness.design.missing.includes("design.repository"));
  assert.ok(partial.readiness.design.missing.includes("design.consumedVersion"));
  assert.equal(partial.readiness.development.ready, false);
  assert.equal(partial.readiness.model.ready, true);
  await configure(f.a, "alpha");
  const childState = await createProject(f.a.path, { externalKey: "ALPHA-CHILD", name: "Alpha child", parentProjectId: f.a.reference.projectId, occurredAt: at });
  const child = childState.projects.find(project => project.parentProjectId === f.a.reference.projectId);
  assert.ok(child);
  const childRepo = join(f.root, "alpha-child-repo"); await mkdir(childRepo);
  await registerLibrary({ projectPath: childRepo, libraryPath: f.a.path, projectId: child.id, registeredAt: at, gitRemote: remote }, f.home);
  await setWorkspaceSetting(f.a.path, { key: "design.authority", value: "https://child.example.test", configurationProjectId: child.id, occurredAt: at });

  const conflict = await resolveProjectTarget({ libraryId: f.a.reference.libraryId, projectId: child.id }, f.home);
  assert.equal(conflict.status, "conflicting");
  assert.deepEqual(conflict.readiness.design, { ready: false, missing: ["design.bundle"] });
  assert.equal(conflict.readiness.model.ready, true, "a design conflict does not rewrite model readiness");
  assert.equal(conflict.readiness.repository.ready, true, "a design conflict does not rewrite repository readiness");
  assert.equal(conflict.readiness.output.ready, true, "a design conflict does not rewrite output readiness");
  assert.equal(conflict.readiness.language.ready, true, "a design conflict does not rewrite language readiness");
  assert.equal(conflict.readiness.development.ready, false);
});

// TCRN-CROSS-STORY-540 GWT1 (TCRN-CROSS-SUB-505): a coordination library this device registered no root
// for outside a library (this fixture registers it in its own device directory, not the process's)
// still records a rule change, with nowhere to write it, and its state is read against no file.
test("coordination rule writes with no registered root record the rule alone and never create managed prose", async t => {
  const f = await fixture(t);
  const input = { libraryRoot: f.coordination.path, projectRoot: f.coordination.path, id: "autonomy", occurredAt: at };
  const enabled = await enableRule(input);
  assert.deepEqual([enabled.status.state, enabled.status.recordedVersion, enabled.outputBindingStatus], ["output-unconfigured", 1, "unconfigured"]);
  assert.equal(enabled.written, false);
  assert.equal((await listRules({ libraryRoot: f.coordination.path })).find(rule => rule.id === "autonomy").state, "output-unconfigured");
  await assert.rejects(renderAgentsSections(f.coordination.path, { projectRoot: f.coordination.path, navigation: null, occurredAt: at }), { reasonCode: "MANAGED_SECTION_OUTPUT_UNREGISTERED" });
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

// INIT-053 U06, choice (a): an undecided relation is stored as absence (approved contract item 4:
// absence reads as undecided; item 12: a new optional field never breaks missing-field replay).
// A format-1 library therefore still takes new work, while the format-2 semantics it cannot hold
// (a selected or coordination-only relation, a chain record) still refuse without an upgrade.
test("U06: a format-1 library takes new work without a relation, stores no field and replays it as undecided; selected, coordination-only and chain records still refuse", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-format-one-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, "library");
  const initial = await initializeLibrary({ root: library, createdAt: at });
  // The library as an engine of format 1 left it: its manifest declares format 1.
  const manifestPath = join(library, "manifest.json");
  await writeFile(manifestPath, canonicalJson({ ...JSON.parse(await readFile(manifestPath, "utf8")), formatVersion: 1 }));
  const projectId = (await createProject(library, { externalKey: "ONE", name: "One", occurredAt: at })).projects[0].id;
  await createWork(library, { projectId, externalKey: "OMITTED", kind: "Initiative", parentId: null, occurredAt: at });
  await createWork(library, { projectId, externalKey: "EXPLICIT", kind: "Initiative", parentId: null, involvedProjects: { state: "undecided", targets: [] }, occurredAt: at });
  const stored = (await readAllStreams(library)).streams.flatMap(stream => stream.events).map(event => event.payload).filter(payload => payload.operation === "work.created");
  assert.equal(stored.length, 2);
  for (const payload of stored) assert.equal(Object.hasOwn(payload.record, "involvedProjects"), false, `${payload.record.externalKey}: undecided is not stored`);
  for (const record of (await materializeWorkspaceFromGenesis(library)).work) {
    assert.equal(Object.hasOwn(record, "involvedProjects"), false);
    assert.deepEqual(involvedProjectsOf(record), { state: "undecided", targets: [] }, `${record.externalKey} replays as undecided`);
  }
  const reference = { libraryId: initial.metadata.workspaceId, projectId };
  for (const [key, involvedProjects] of [["SELECTED", { state: "selected", targets: [reference] }], ["COORDINATION", { state: "coordination-only", targets: [] }]]) {
    await assert.rejects(createWork(library, { projectId, externalKey: key, kind: "Initiative", parentId: null, involvedProjects, occurredAt: at }), error => error.reasonCode === "LIBRARY_FORMAT_UNSUPPORTED", key);
  }
  await assert.rejects(declareChainIdentity(library, { role: "coordination", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt: at }), error => error.reasonCode === "LIBRARY_FORMAT_UNSUPPORTED");
  assert.equal((await materializeWorkspace(library)).work.length, 2, "the refused writes left nothing");
});

test("U06: on format 2 a relation returned to undecided is stored explicitly, and undecided over an absent relation refuses as no change", async t => {
  const f = await fixture(t);
  const projectId = f.coordination.reference.projectId;
  await createWork(f.coordination.path, { projectId, externalKey: "BACK", kind: "Initiative", parentId: null, involvedProjects: { state: "selected", targets: [f.a.reference] }, occurredAt: at });
  const back = deriveStableId("work", "BACK");
  await annotateWork(f.coordination.path, { id: back, involvedProjects: { state: "undecided", targets: [] }, occurredAt: at });
  const record = (await materializeWorkspaceFromGenesis(f.coordination.path)).work.find(entry => entry.id === back);
  assert.deepEqual(record.involvedProjects, { state: "undecided", targets: [] }, "the change back is a stored value");
  await assert.rejects(annotateWork(f.coordination.path, { id: back, involvedProjects: { state: "undecided", targets: [] }, occurredAt: at }), /changed no annotatable field/u);
  await createWork(f.coordination.path, { projectId, externalKey: "PLAIN", kind: "Initiative", parentId: null, occurredAt: at });
  const plain = deriveStableId("work", "PLAIN");
  assert.equal(Object.hasOwn((await materializeWorkspaceFromGenesis(f.coordination.path)).work.find(entry => entry.id === plain), "involvedProjects"), false);
  await assert.rejects(annotateWork(f.coordination.path, { id: plain, involvedProjects: { state: "undecided", targets: [] }, occurredAt: at }), /changed no annotatable field/u);
});

// F06 (U09), within its qualified scope: unavailable registrations are reported, never classified
// from a name or a path. Case 1: a registration recorded with the project role. Case 2: one with no
// recorded role, beside an explicit expected coordination identity that resolves. Case 3: one with
// no recorded role and no expectation. Each case has its positive and its refusal.
test("F06: unavailable registrations are listed by what was recorded, refused without an expectation, and never classified from a name or a path", async t => {
  const f = await fixture(t);
  const coordinationId = f.coordination.reference.libraryId;
  // A registration made before the library had any identity records no role, whatever it is called
  // and wherever it sits: here the place and the name a coordination library would have.
  const legacyPath = join(f.root, "coordination-library");
  const legacy = await initializeLibrary({ root: legacyPath, createdAt: at, projectName: "Cross Project" });
  await registerLibrary({ projectPath: legacyPath, libraryPath: legacyPath, registeredAt: at, gitRemote: null }, f.home);
  assert.equal((await readRegistry(f.home)).entries.find(entry => entry.libraryId === legacy.metadata.workspaceId).chainRole, undefined);
  const offline = async path => { await rename(path, `${path}-offline`); return () => rename(`${path}-offline`, path); };

  // Available, the unclassified library is classified by its records alone: not a coordination.
  assert.equal((await registeredCoordination(f.home)).libraryId, coordinationId);

  // Case 1: the recorded project role is reported as unavailable; as the expected identity it refuses.
  const backA = await offline(f.a.path);
  const found = await registeredCoordination(f.home);
  assert.deepEqual([found.libraryId, found.unavailable, found.unclassifiedUnavailable], [coordinationId, [{ libraryId: f.a.reference.libraryId, path: f.a.path }], []]);
  await assert.rejects(registeredCoordination(f.home, f.a.reference.libraryId), /cannot classify/u);
  await backA();

  // Case 2: beside an expected coordination that resolves, the unclassified unavailable registration
  // is listed apart, and is not a candidate; when the expected coordination itself is away, refused.
  const backLegacy = await offline(legacyPath);
  const expected = await registeredCoordination(f.home, coordinationId);
  assert.deepEqual([expected.libraryId, expected.unclassifiedUnavailable, expected.unavailable], [coordinationId, [{ libraryId: legacy.metadata.workspaceId, path: legacyPath }], []]);
  const backCoordination = await offline(f.coordination.path);
  await assert.rejects(registeredCoordination(f.home, coordinationId), /cannot classify/u);
  await backCoordination();

  // Case 3: without an expectation the same registration refuses discovery, although its path and
  // project name are a coordination library's: neither classifies it.
  await assert.rejects(registeredCoordination(f.home), /cannot classify/u);
  await backLegacy();
  assert.equal((await registeredCoordination(f.home)).libraryId, coordinationId, "once it opens, its records say it is no coordination");

  // A registration recorded as a coordination that does not open is never accepted beside another.
  const other = await f.library("other-coordination", "coordination");
  const backOther = await offline(other.path);
  await assert.rejects(registeredCoordination(f.home, coordinationId), /registered coordination does not open/u);
  await backOther();
});

// F07 (U09): an optional common default supplies only optional project scalars; library-scope and
// collection settings, gate declarations and managed records never inherit, and a common default
// that does not resolve is refused truthfully rather than read as an empty default.
test("F07: common defaults inherit optional project scalars only, and an unresolved common default refuses", async t => {
  const f = await fixture(t); await configure(f.a, "alpha");
  const tiers = JSON.parse(readSettingsCatalog(f.a.reference.libraryId, []).settings.find(entry => entry.key === "models.tiers").currentValue).map(tier => ({ ...tier, model: "alpha-model" }));
  await appendHistoricalSetting(f.a, "models.tiers", JSON.stringify(tiers));
  await setWorkspaceSetting(f.a.path, { key: "workspace.generatedArtifactsPath", value: "alpha-artifacts", occurredAt: at });
  await setConfigRecord(f.a.path, { collection: "gate", key: "alpha-gate", projectId: f.a.reference.projectId, value: { command: [process.execPath, "-e", "process.exit(0)"], root: ".", covers: ["**"], required: true, enabled: true, releaseOnly: false }, occurredAt: at });
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: f.a.reference, occurredAt: at });
  const resolved = await resolveProjectTarget(f.b.reference, f.home);
  const source = key => resolved.settings.find(entry => entry.key === key).source.kind;
  assert.equal(source("design.authority"), "common", "an optional project scalar comes from the common default");
  assert.equal(source("artifact.language"), "common");
  assert.notEqual(source("models.tiers"), "common", "a collection setting never inherits");
  assert.notEqual(source("workspace.generatedArtifactsPath"), "common", "a library-scope setting never inherits");
  assert.equal(resolved.configRecords.some(record => record.collection === "gate"), false, "gate declarations never inherit");
  assert.equal(resolved.readiness.gates.ready, false);
  // The common default names a target this device does not register: refused, not an empty default.
  const unregistered = { libraryId: "library:" + "c".repeat(24), projectId: "project:" + "d".repeat(24) };
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: unregistered, occurredAt: at });
  const refused = await resolveProjectTarget(f.b.reference, f.home);
  assert.deepEqual([refused.status, refused.reason, refused.common.status], ["conflicting", "common-default-unresolved", "unregistered"]);
  await assert.rejects(effectiveProjectState(await materializeWorkspace(f.b.path), f.b.reference.projectId, f.home), /effective configuration unavailable/u);
});

// F02 (U09): the runtime rule write path Atelier takes for a coordination chain, the CLI's
// rule-enable and rule-disable on the coordination registration setup makes, records the rule's
// state and never writes managed prose into the library. TCRN-CROSS-STORY-540 (TCRN-CROSS-SUB-505):
// setup registers such a library as its own project path, which lies within a library, so it has no
// output root: the receipts say so (outputBindingStatus unconfigured) and the rule's state is read
// against no file.
test("F02: rule-enable and rule-disable through the CLI on a setup-made coordination record runtime state and write no prose", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-coordination-rule-")));
  const previous = { home: process.env.EINZBERN_HOME, surface: process.env.EINZBERN_SURFACE };
  const home = join(root, "device");
  process.env.EINZBERN_HOME = home;
  t.after(async () => {
    process.env.EINZBERN_HOME = previous.home;
    if (previous.surface === undefined) delete process.env.EINZBERN_SURFACE; else process.env.EINZBERN_SURFACE = previous.surface;
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await initializeLibrary({ root: project, createdAt: at });
  const coordination = await ensureProjectCoordination(project, at, home);
  const entry = (await readRegistry(home)).entries.find(candidate => candidate.libraryId === coordination.libraryId);
  assert.deepEqual([entry.projectPath, entry.libraryPath, entry.chainRole], [coordination.path, coordination.path, "coordination"]);
  const cli = async args => { let output = ""; await runCli(args, { write: text => { output += text; } }); return JSON.parse(output); };
  await assert.rejects(cli(["rule-enable", "--id", "autonomy", "--project", coordination.path, "--project-id", entry.projectId, "--at", at]), error => error.reasonCode === "MODEL_WRITE_REFUSED", "a model does not change a rule");
  // Atelier's surface, as its runtime rule write runs the CLI (no human-identity claim).
  process.env.EINZBERN_SURFACE = "atelier";
  const enabled = await cli(["rule-enable", "--id", "autonomy", "--project", coordination.path, "--project-id", entry.projectId, "--at", at]);
  assert.deepEqual([enabled.reasonCode, enabled.written, enabled.recorded, enabled.result, enabled.rule.state, enabled.rule.recordedVersion, enabled.outputBindingStatus], ["RULE_ENABLED", false, 1, "unchanged", "output-unconfigured", 1, "unconfigured"]);
  assert.equal((await listRules({ libraryRoot: coordination.path, configurationProjectId: entry.projectId })).find(rule => rule.id === "autonomy").state, "output-unconfigured");
  const listed = await cli(["rule-list", "--project", coordination.path]);
  assert.deepEqual([listed.rules.find(rule => rule.id === "autonomy").state, listed.outputBindingStatus], ["output-unconfigured", "unconfigured"]);
  const disabled = await cli(["rule-disable", "--id", "autonomy", "--project", coordination.path, "--project-id", entry.projectId, "--at", at]);
  assert.deepEqual([disabled.reasonCode, disabled.written, disabled.recorded, disabled.outputBindingStatus], ["RULE_DISABLED", false, 1, "unconfigured"]);
  assert.equal((await listRules({ libraryRoot: coordination.path, configurationProjectId: entry.projectId })).find(rule => rule.id === "autonomy").state, "disabled");
  await assert.rejects(readFile(join(coordination.path, "AGENTS.md")), { code: "ENOENT" }, "no managed prose in the coordination library");
});

// TCRN-CROSS-INIT-053 R46: settings-catalog as the fixture's device, whose registry resolves the targets.
async function catalogAs(f, args) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = f.home;
  try {
    let output = "";
    await runCli(["settings-catalog", ...args], { write: text => { output += text; } });
    return JSON.parse(output);
  } finally { process.env.EINZBERN_HOME = previous; }
}
const rowOf = (catalog, key) => catalog.settings.find(entry => entry.key === key);

// R46 I02 (approved contract item 7; U20 D4): under a common default, settings-catalog still says what
// the target declared itself. A key declared on the target reads its declaredValue; a library key reads
// the library's; a key inherited from the common default reads no declaration and the common default's
// value as inherited; settings-remove takes out the target's own declaration and nothing else.
test("R46 I02: declared, library and inherited values keep their provenance under a common default", async t => {
  const f = await fixture(t); await configure(f.a, "alpha");
  await setWorkspaceSetting(f.b.path, { key: "artifact.language", value: "fr", configurationProjectId: f.b.reference.projectId, occurredAt: at });
  await setWorkspaceSetting(f.b.path, { key: "artifact.language", value: "ja", occurredAt: at });
  await setWorkspaceSetting(f.b.path, { key: "workspace.generatedArtifactsPath", value: "beta-artifacts", occurredAt: at });
  const args = ["--workspace", f.b.path, "--project-id", f.b.reference.projectId];
  const without = await catalogAs(f, args);
  assert.equal(Object.hasOwn(without, "commonDefault"), false, "a target without a common default gets no new field");
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: f.a.reference, occurredAt: at });
  const catalog = await catalogAs(f, args);
  assert.deepEqual(catalog.commonDefault, { reference: f.a.reference, status: "resolved", targetStatus: "configured" });
  const view = (key) => { const row = rowOf(catalog, key); return [row.currentValue, row.declaredValue, row.source.kind]; };
  assert.deepEqual(view("artifact.language"), ["fr", "fr", "project"], "the target's own declaration is its declaredValue");
  assert.equal(rowOf(catalog, "artifact.language").source.projectId, f.b.reference.projectId);
  assert.deepEqual(view("workspace.generatedArtifactsPath"), ["beta-artifacts", "beta-artifacts", "library"], "a library key reads the library's declaration");
  assert.deepEqual(view("design.authority"), ["https://alpha.example.test", null, "common"], "an inherited key is not the target's declaration");
  assert.equal(rowOf(catalog, "design.authority").inheritedValue, "https://alpha.example.test");
  assert.deepEqual([rowOf(catalog, "design.authority").source.libraryId, rowOf(catalog, "design.authority").source.projectId], [f.a.reference.libraryId, f.a.reference.projectId]);
  // The rows that were right without a common default stay as they were, but for the provenance's library.
  for (const key of ["artifact.language", "workspace.generatedArtifactsPath"]) assert.equal(rowOf(catalog, key).declaredValue, rowOf(without, key).declaredValue, key);
  // The effective state the catalog reads rebuilds each record with the project it was declared on:
  // the target's own declaration keeps the target, a library key and an inherited key carry none.
  const effective = await effectiveProjectState(await materializeWorkspace(f.b.path), f.b.reference.projectId, f.home);
  assert.deepEqual(effective.settings.filter(entry => ["artifact.language", "design.authority", "workspace.generatedArtifactsPath"].includes(entry.key)).map(entry => [entry.key, entry.value, entry.projectId ?? null]).sort(),
    [["artifact.language", "fr", f.b.reference.projectId], ["design.authority", "https://alpha.example.test", null], ["workspace.generatedArtifactsPath", "beta-artifacts", null]]);
  // A reset of the target's language takes out its own declaration only: the library's stands and answers.
  await removeWorkspaceSetting(f.b.path, { key: "artifact.language", configurationProjectId: f.b.reference.projectId, occurredAt: at });
  const reset = await catalogAs(f, args);
  assert.deepEqual([rowOf(reset, "artifact.language").currentValue, rowOf(reset, "artifact.language").declaredValue, rowOf(reset, "artifact.language").source.kind], ["ja", null, "library"]);
  assert.deepEqual((await materializeWorkspace(f.b.path)).settings.filter(entry => entry.key === "artifact.language").map(entry => [entry.value, entry.projectId ?? null]), [["ja", null]]);
});

// R46 I03 (approved contract items 6, 7; PP-2): a common default that does not resolve keeps the
// target's catalog readable. Unregistered, unavailable and a cycle each answer SETTINGS_CATALOG_READY
// with commonDefault naming why, every optional project scalar that would inherit from it marked with
// the unresolved source and read as null, and the target's own and its library's values as they are;
// effectiveProjectState and resolveProjectTarget still refuse the target (F07).
test("R46 I03: unregistered, unavailable and cyclic common defaults are read per key, and the effective state still refuses", async t => {
  const f = await fixture(t); await configure(f.a, "alpha");
  await setWorkspaceSetting(f.b.path, { key: "artifact.language", value: "fr", configurationProjectId: f.b.reference.projectId, occurredAt: at });
  await setWorkspaceSetting(f.b.path, { key: "workspace.generatedArtifactsPath", value: "beta-artifacts", occurredAt: at });
  const args = ["--workspace", f.b.path, "--project-id", f.b.reference.projectId];
  const check = async (reference, targetStatus, reason) => {
    const catalog = await catalogAs(f, args);
    assert.equal(catalog.reasonCode, "SETTINGS_CATALOG_READY", reason);
    assert.deepEqual(catalog.commonDefault, { reference, status: "unresolved", targetStatus, reason });
    const unresolved = { inherited: true, kind: "common", libraryId: reference.libraryId, projectId: reference.projectId, projectName: null, status: "unresolved" };
    const authority = rowOf(catalog, "design.authority");
    assert.deepEqual([authority.currentValue, authority.inheritedValue, authority.declaredValue, authority.source, authority.inheritedSource], [null, null, null, unresolved, unresolved], `${targetStatus}: an inheriting key is marked`);
    assert.deepEqual([rowOf(catalog, "artifact.language").currentValue, rowOf(catalog, "artifact.language").declaredValue, rowOf(catalog, "artifact.language").source.kind], ["fr", "fr", "project"], "the target's own declaration stands");
    assert.deepEqual([rowOf(catalog, "workspace.generatedArtifactsPath").currentValue, rowOf(catalog, "workspace.generatedArtifactsPath").source.kind], ["beta-artifacts", "library"], "a library key stands");
    assert.notEqual(rowOf(catalog, "models.tiers").source.status, "unresolved", "a collection never inherits");
    assert.equal(rowOf(catalog, "storage.segmentBytes").source.status, undefined, "a library-scope key never inherits");
    const marked = catalog.settings.filter(row => row.source?.status === "unresolved").map(row => row.key);
    assert.ok(marked.length > 0 && marked.every(key => rowOf(catalog, key).scope === "project" && rowOf(catalog, key).shape !== "collection"), `${targetStatus}: only optional project scalars are marked`);
    assert.equal(catalog.design.status, "unconfigured");
    assert.ok(catalog.design.missing.includes("design.authority"));
    assert.deepEqual(catalog.design.bindings.find(binding => binding.key === "design.authority").source, unresolved);
    const refused = await resolveProjectTarget(f.b.reference, f.home);
    assert.deepEqual([refused.status, refused.reason], ["conflicting", "common-default-unresolved"], "resolution still refuses");
    await assert.rejects(effectiveProjectState(await materializeWorkspace(f.b.path), f.b.reference.projectId, f.home), /effective configuration unavailable/u);
  };
  // Unregistered on this device.
  const unregistered = { libraryId: "library:" + "c".repeat(24), projectId: "project:" + "d".repeat(24) };
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: unregistered, occurredAt: at });
  await check(unregistered, "unregistered", "common-default-unresolved");
  // Registered, but its library is away.
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: f.a.reference, occurredAt: at });
  await rename(f.a.path, `${f.a.path}-away`);
  await check(f.a.reference, "unavailable", "common-default-unresolved");
  await rename(`${f.a.path}-away`, f.a.path);
  // A cycle: alpha's common default is beta again.
  await setConfigRecord(f.a.path, { collection: "chain", key: "common-default", projectId: f.a.reference.projectId, value: f.b.reference, occurredAt: at });
  await check(f.a.reference, "conflicting", "common-default-cycle");
  // The repair the catalog leads to: removing the common default reads the target plainly again.
  await removeConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, occurredAt: at });
  const repaired = await catalogAs(f, args);
  assert.equal(Object.hasOwn(repaired, "commonDefault"), false);
  assert.deepEqual([rowOf(repaired, "design.authority").currentValue, rowOf(repaired, "design.authority").source.kind], [null, "default"]);
  assert.equal(repaired.settings.some(row => row.source?.status === "unresolved"), false);
});

// TCRN-CROSS-INIT-053 R47 (c1-B; Owner 2026-10-09, round 7): a coordination chain keeps ten runtime settings
// for itself, the four library settings with the artifact language and the orchestration limits of the work
// dispatched from it. It lists and writes them for the whole library only; a project override of one refuses
// in the library's words, and models.* and every development key keep the coordination refusal.
const COORDINATION_RUNTIME_KEYS = ["agents.generation", "agents.sharedNavigation", "artifact.language", "engine.requiredVersion", "execution.maxConcurrentSubagents", "quota.fiveHourParallelOffPercent", "quota.fiveHourWaitPercent", "quota.weeklyParallelOffPercent", "quota.weeklyWaitPercent", "storage.segmentBytes", "storage.snapshotEveryEvents", "workspace.generatedArtifactsPath"];
test("R47 c1-B: a coordination chain lists runtime settings but historical quota rows are read-only", async t => {
  const f = await fixture(t);
  const own = ["--workspace", f.coordination.path];
  const targeted = [...own, "--project-id", f.coordination.reference.projectId];
  for (const args of [own, targeted]) {
    const catalog = await catalogAs(f, args);
    assert.deepEqual(catalog.settings.map(row => row.key), COORDINATION_RUNTIME_KEYS);
    assert.deepEqual([...new Set(catalog.settings.flatMap(row => [row.scope, row.layer]))], ["library"]);
    assert.equal(catalog.design, null);
  }
  const written = [["artifact.language", "fr"], ["execution.maxConcurrentSubagents", "3"]];
  for (const [key, value] of written) await setWorkspaceSetting(f.coordination.path, { key, value, occurredAt: at });
  for (const args of [own, targeted]) {
    const catalog = await catalogAs(f, args);
    for (const [key, value] of written) assert.deepEqual([rowOf(catalog, key).currentValue, rowOf(catalog, key).declaredValue, rowOf(catalog, key).source.kind], [value, value, "library"], key);
    assert.deepEqual([rowOf(catalog, "quota.fiveHourWaitPercent").currentValue, rowOf(catalog, "quota.fiveHourWaitPercent").declaredValue, rowOf(catalog, "quota.fiveHourWaitPercent").source.kind], ["90", null, "default"]);
  }
  const native = await materializeWorkspace(f.coordination.path);
  assert.deepEqual(native.settings.filter(record => COORDINATION_RUNTIME_KEYS.includes(record.key)).map(record => [record.key, record.projectId ?? null]), written.map(([key]) => [key, null]));
  assert.deepEqual(scopedWorkspaceState(native, f.coordination.reference.projectId).settings.map(record => [record.key, record.value]), written);
  const projectOverride = /this setting belongs to the whole library and cannot have a project override/u;
  for (const [key, value] of [["artifact.language", "ja"], ["execution.maxConcurrentSubagents", "2"], ["quota.fiveHourParallelOffPercent", "50"], ["quota.fiveHourWaitPercent", "50"], ["quota.weeklyParallelOffPercent", "50"], ["quota.weeklyWaitPercent", "50"], ["workspace.generatedArtifactsPath", "elsewhere"]]) {
    await assert.rejects(setWorkspaceSetting(f.coordination.path, { key, value, configurationProjectId: f.coordination.reference.projectId, occurredAt: at }), key.startsWith("quota.") ? { reasonCode: "SETTINGS_KEY_DEVICE_LEVEL" } : projectOverride, key);
  }
  await assert.rejects(removeWorkspaceSetting(f.coordination.path, { key: "artifact.language", configurationProjectId: f.coordination.reference.projectId, occurredAt: at }), /is not set/u);
  const runtimeOnly = /coordination chains expose runtime settings only/u;
  const tiers = readSettingsCatalog(f.coordination.reference.libraryId, []).settings.find(entry => entry.key === "models.tiers").currentValue;
  for (const projectId of [undefined, f.coordination.reference.projectId]) {
    await assert.rejects(setWorkspaceSetting(f.coordination.path, { key: "models.tiers", value: tiers, ...(projectId === undefined ? {} : { configurationProjectId: projectId }), occurredAt: at }), { reasonCode: "SETTINGS_KEY_DEVICE_LEVEL" });
    await assert.rejects(setWorkspaceSetting(f.coordination.path, { key: "knowledge.articlesPath", value: "articles", ...(projectId === undefined ? {} : { configurationProjectId: projectId }), occurredAt: at }), runtimeOnly);
  }
  for (const key of COORDINATION_RUNTIME_KEYS.filter(key => key.startsWith("quota."))) {
    await assert.rejects(setWorkspaceSetting(f.coordination.path, { key, value: "90", occurredAt: at }), { reasonCode: "SETTINGS_KEY_DEVICE_LEVEL" });
  }
  // Active library declarations still remove normally without opening historical quota writes.
  await removeWorkspaceSetting(f.coordination.path, { key: "execution.maxConcurrentSubagents", occurredAt: at });
  assert.equal(rowOf(await catalogAs(f, targeted), "execution.maxConcurrentSubagents").source.kind, "default");
  // A project chain's catalog is as before: every key, each with its static scope and layer.
  const project = await catalogAs(f, ["--workspace", f.a.path, "--project-id", f.a.reference.projectId]);
  const statics = readSettingsCatalog(f.a.reference.libraryId, []).settings;
  assert.deepEqual(project.settings.map(row => [row.key, row.scope, row.layer]), statics.map(row => [row.key, row.scope, row.layer]));
  for (const key of ["artifact.language", "execution.maxConcurrentSubagents", "quota.weeklyWaitPercent"]) assert.deepEqual([rowOf(project, key).scope, rowOf(project, key).layer], ["project", "project"], key);
  await setWorkspaceSetting(f.a.path, { key: "artifact.language", value: "ja", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  assert.equal(rowOf(await catalogAs(f, ["--workspace", f.a.path, "--project-id", f.a.reference.projectId]), "artifact.language").declaredValue, "ja");
});

// R47 c1-B (approved contract items 7 and 10): a coordination chain's runtime settings are its own. An
// involved project resolves its own values, and a project whose common default is the coordination chain
// gets none of them (the coordination chain is not a development target).
test("R47 c1-B: involved projects and common defaults never take the coordination chain's runtime settings", async t => {
  const f = await fixture(t);
  await setWorkspaceSetting(f.coordination.path, { key: "artifact.language", value: "fr", occurredAt: at });
  await setWorkspaceSetting(f.coordination.path, { key: "execution.maxConcurrentSubagents", value: "3", occurredAt: at });
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "R47-C1B", kind: "Initiative", parentId: null, title: "Coordinated work", involvedProjects: { state: "selected", targets: [f.a.reference] }, occurredAt: at });
  const contexts = await workProjectContexts(state, state.work[0].id, f.home);
  const value = key => contexts.contexts[0].settings.find(entry => entry.key === key);
  assert.deepEqual([value("artifact.language").value, value("artifact.language").source.kind, value("artifact.language").source.libraryId], ["en", "default", f.a.reference.libraryId]);
  assert.deepEqual([value("execution.maxConcurrentSubagents").value, value("execution.maxConcurrentSubagents").source.kind], ["8", "default"]);
  assert.equal(contexts.contexts[0].handoff.output.language, "en");
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: f.coordination.reference, occurredAt: at });
  const resolved = await resolveProjectTarget(f.b.reference, f.home);
  assert.deepEqual([resolved.status, resolved.reason, resolved.common.status, resolved.common.reason], ["conflicting", "common-default-unresolved", "unconfigured", "coordination-is-not-development"]);
  const catalog = await catalogAs(f, ["--workspace", f.b.path, "--project-id", f.b.reference.projectId]);
  for (const key of ["artifact.language", "execution.maxConcurrentSubagents"]) {
    assert.deepEqual([rowOf(catalog, key).currentValue, rowOf(catalog, key).source.kind, rowOf(catalog, key).source.status], [null, "common", "unresolved"], key);
  }
  await assert.rejects(effectiveProjectState(await materializeWorkspace(f.b.path), f.b.reference.projectId, f.home), /effective configuration unavailable/u);
});


test("552: projects with conflicting historical models consume one device policy and handoff exports only explicit variables", async t => {
  const f = await fixture(t);
  for (const [target, model] of [[f.a, "old-alpha"], [f.b, "old-beta"]]) {
    await appendHistoricalSetting(target, "models.tiers", JSON.stringify([{ order: 10, category: "main", runner: "codex", model, effort: "max", note: "" }]));
    await appendHistoricalSetting(target, "quota.fiveHourWaitPercent", target === f.a ? "80" : "90");
  }
  const legacyOnly = await resolveProjectTarget(f.a.reference, f.home);
  assert.equal(legacyOnly.readiness.model.ready, false, "historical project models cannot satisfy device-policy readiness");
  assert.deepEqual(legacyOnly.readiness.model.missing, ["engine.host-policy"]);
  const policy = await configureDevicePolicy(f);
  const variables = [
    ["explicit.handoff", ["handoff"]],
    ["explicit.both", ["agents", "handoff"]],
    ["agents.only", ["agents"]],
    ["private.only", []],
    ["legacy.agents", undefined],
    ["unsafe.absolute", ["handoff"], "/srv/private-output"],
    ["unsafe.secret", ["handoff"], "sk-recorded-before"],
    ["unsafe.description", ["handoff"], "plain-value", "stored at /var/private-info"],
  ];
  for (const [key, exports, value = `value-${key}`, description = ""] of variables) {
    await setConfigRecord(f.a.path, { collection: "variable", key, projectId: f.a.reference.projectId,
      value: { type: "string", value, description, ...(exports === undefined ? {} : { exports }) }, occurredAt: at });
  }
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "SHARED-DEVICE-POLICY", kind: "Initiative", parentId: null,
    involvedProjects: { state: "selected", targets: [f.a.reference, f.b.reference] }, occurredAt: at });
  const work = state.work.find(entry => entry.externalKey === "SHARED-DEVICE-POLICY");
  const result = await workProjectContexts(state, work.id, f.home);
  assert.equal(result.enginePolicy.storeRevision, policy.revision);
  assert.equal(result.conflicts.some(key => key.startsWith("models.") || key.startsWith("quota.")), false);
  for (const context of result.contexts) {
    assert.deepEqual(context.enginePolicy, result.enginePolicy);
    assert.deepEqual(context.handoff.enginePolicy, result.enginePolicy);
    assert.equal(context.readiness.model.ready, true);
    assert.equal(context.enginePolicy.hosts.codex.digest, policy.hosts.codex.digest);
    assert.equal(context.modelCapabilityVerification, "requires-explicit-host-resolution");
    assert.equal(context.handoff.settings.some(entry => entry.key.startsWith("models.") || entry.key.startsWith("quota.")), false);
    assert.equal(context.writeAuthority, "not-granted");
  }
  const alpha = result.contexts.find(context => context.reference.projectId === f.a.reference.projectId);
  assert.deepEqual(alpha.handoff.variables.map(entry => entry.key), ["explicit.both", "explicit.handoff"]);
  assert.deepEqual(alpha.handoff.withheldVariables, [
    { key: "agents.only", reason: "not-exported" },
    { key: "legacy.agents", reason: "not-exported" },
    { key: "private.only", reason: "not-exported" },
    { key: "unsafe.absolute", reason: "absolute-path" },
    { key: "unsafe.description", reason: "absolute-path" },
    { key: "unsafe.secret", reason: "secret-shaped" },
  ]);
  const handoffText = JSON.stringify(alpha.handoff);
  for (const omitted of ["value-agents.only", "value-legacy.agents", "value-private.only", "/srv/private-output", "sk-recorded-before", "/var/private-info"]) assert.equal(handoffText.includes(omitted), false, omitted);
  assert.equal((await materializeWorkspaceFromGenesis(f.a.path)).settings.find(entry => entry.key === "models.tiers").value.includes("old-alpha"), true, "historical model event is preserved");
});


test("552: project handoff resolves device concurrency cap against each project budget using device-directory semantics", async t => {
  const f = await fixture(t);
  await applyMachineSettingSet({ key: "execution.maxConcurrentAgents", value: "3", occurredAt: at, path: join(f.home, "machine-settings.json") });
  await setWorkspaceSetting(f.a.path, { key: "execution.maxConcurrentSubagents", value: "99", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  await setWorkspaceSetting(f.b.path, { key: "execution.maxConcurrentSubagents", value: "2", configurationProjectId: f.b.reference.projectId, occurredAt: at });
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "DEVICE-CAP-HANDOFF", kind: "Initiative", parentId: null,
    involvedProjects: { state: "selected", targets: [f.a.reference, f.b.reference] }, occurredAt: at });
  const work = state.work.find(entry => entry.externalKey === "DEVICE-CAP-HANDOFF");
  const result = await workProjectContexts(state, work.id, f.home);
  for (const context of result.contexts) {
    const alpha = context.reference.projectId === f.a.reference.projectId;
    assert.equal(context.executionConcurrency.deviceLimit, 3, "home names the device directory, not a user's parent home");
    assert.equal(context.deviceSettings.path, join(f.home, "machine-settings.json"));
    assert.equal(context.deviceSettings.settings.find(entry => entry.key === "execution.maxConcurrentAgents").currentValue, "3");
    assert.equal(context.executionConcurrency.projectLimit, alpha ? 99 : 2);
    assert.equal(context.executionConcurrency.effectiveLimit, alpha ? 3 : 2);
    assert.equal(context.executionConcurrency.origin, alpha ? "device" : "project-budget");
    assert.deepEqual(context.handoff.executionConcurrency, context.executionConcurrency);
    assert.equal(context.handoff.settings.find(entry => entry.key === "execution.maxConcurrentSubagents").value, alpha ? "99" : "2", "declaration remains distinct from resolved cap");
    assert.equal(context.writeAuthority, "not-granted");
  }
});

test("552: work handoff consumes a request-bound policy decision, never treating read-only context as dispatch permission", async t => {
  const f = await fixture(t); await configureDevicePolicy(f);
  await applyMachineSettingSet({ key: "execution.maxConcurrentAgents", value: "3", occurredAt: at, path: join(f.home, "machine-settings.json") });
  await setWorkspaceSetting(f.a.path, { key: "execution.maxConcurrentSubagents", value: "1", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "ADMISSION-HANDOFF", kind: "Initiative", parentId: null,
    involvedProjects: { state: "selected", targets: [f.a.reference] }, occurredAt: at });
  const id = state.work.find(entry => entry.externalKey === "ADMISSION-HANDOFF").id;
  const reading = await workProjectContexts(state, id, f.home);
  assert.equal(reading.dispatchAdmitted, false);
  assert.equal(reading.contexts[0].handoff.executionAdmission.status, "not-requested");
  const request = { host: "codex", category: "main", rejections: 4, requestedAgents: 1,
    availableCombinations: [{ runner: "codex", model: "fixture-device-main", effort: "max" }] };
  const resolved = await workProjectContexts(state, id, f.home, request);
  const admission = resolved.contexts[0].executionAdmission;
  assert.equal(admission.status, "admitted");
  assert.equal(admission.selection.record.runner, "codex");
  assert.equal(admission.selection.record.model, "fixture-device-main");
  assert.equal(admission.selection.record.effort, "max");
  assert.equal(admission.request.rejections, 4);
  assert.equal(admission.concurrency.admissionLimit, 1);
  assert.deepEqual(resolved.contexts[0].handoff.executionAdmission, admission);
  assert.equal(resolved.dispatchAdmitted, false, "policy admission does not bypass unresolved repository/output readiness");
  const refused = await workProjectContexts(state, id, f.home, { ...request, requestedAgents: 2 });
  assert.equal(refused.contexts[0].handoff.executionAdmission.status, "refused");
  assert.equal(refused.dispatchAdmitted, false);
  const unsupported = await workProjectContexts(state, id, f.home, { ...request, availableCombinations: [] });
  assert.equal(unsupported.contexts[0].handoff.executionAdmission.status, "refused");
});

test("552: work targets and common defaults share one captured engine/device view and admission timestamp", async t => {
  const f = await fixture(t);
  const policy = await configureDevicePolicy(f);
  await applyMachineSettingSet({ key: "execution.maxConcurrentAgents", value: "3", occurredAt: at, path: join(f.home, "machine-settings.json") });
  await setWorkspaceSetting(f.a.path, { key: "execution.maxConcurrentSubagents", value: "2", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  await setConfigRecord(f.b.path, { collection: "chain", key: "common-default", projectId: f.b.reference.projectId, value: f.a.reference, occurredAt: at });
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "CAPTURED-EXECUTION-VIEW", kind: "Initiative", parentId: null,
    involvedProjects: { state: "selected", targets: [f.a.reference, f.b.reference] }, occurredAt: at });
  const work = state.work.find(entry => entry.externalKey === "CAPTURED-EXECUTION-VIEW");
  const result = await workProjectContexts(state, work.id, f.home, { host: "codex", category: "main", rejections: 0, requestedAgents: 2,
    availableCombinations: [{ runner: "codex", model: "fixture-device-main", effort: "max" }] });
  const expectedDevice = await readMachineSettingsCatalog(join(f.home, "machine-settings.json"));
  const first = result.contexts[0];
  for (const target of result.contexts) {
    const admission = target.executionAdmission;
    assert.equal(target.enginePolicy, result.enginePolicy);
    assert.equal(target.deviceSettings, first.deviceSettings, "device catalog uses the same captured object for every target");
    assert.deepEqual(target.deviceSettings, expectedDevice, "captured catalog preserves the public readback shape");
    assert.equal(target.readiness.model.ready, true);
    assert.equal(admission.status, "admitted");
    assert.equal(admission.policy.digest, result.enginePolicy.hosts.codex.digest);
    assert.equal(admission.policy.revision, policy.hosts.codex.revision);
    assert.equal(admission.policy.storeRevision, result.enginePolicy.storeRevision);
    assert.equal(admission.selection.origin.storeRevision, result.enginePolicy.storeRevision);
    assert.equal(admission.evaluatedAt, first.executionAdmission.evaluatedAt);
    assert.equal(admission.concurrency.deviceLimit, target.executionConcurrency.deviceLimit);
    assert.equal(admission.concurrency.effectiveLimit, target.executionConcurrency.effectiveLimit);
    assert.equal(admission.concurrency.effectiveLimit, 2, "common-default project budget still only tightens the shared device cap");
    assert.equal(target.handoff.executionAdmission, admission);
  }
  const beta = result.contexts.find(target => target.reference.projectId === f.b.reference.projectId);
  assert.equal(beta.common.enginePolicy, result.enginePolicy, "common defaults cannot reread another engine revision");
  assert.equal(beta.common.deviceSettings, first.deviceSettings, "common defaults cannot reread another device cap");
  assert.equal(beta.common.readiness.model.ready, true);
});

test("DOT-E02 actual dot readiness consumes B4 session reads without weakening repository or legacy model checks", async t => {
  const { DOT_REQUIRED_CHECKS } = await import("../dist/build/packages/core/src/dot-execution.js");
  const f = await fixture(t); const remote = "https://example.test/dot-alpha";
  await registerLibrary({ projectPath: f.a.repo, libraryPath: f.a.path, projectId: f.a.reference.projectId, registeredAt: at, gitRemote: remote }, f.home);
  await setWorkspaceSetting(f.a.path, { key: "artifact.language", value: "en", configurationProjectId: f.a.reference.projectId, occurredAt: at });
  await setConfigRecord(f.a.path, { collection: "chain", key: "repositories", projectId: f.a.reference.projectId, value: { bindings: [{ id: "dot-alpha", name: "Alpha", repository: remote, buildService: "test", buildProject: "alpha" }] }, occurredAt: at });
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "DOT-CONSUMER", kind: "Initiative", parentId: null, involvedProjects: { state: "selected", targets: [f.a.reference] }, occurredAt: at });
  const work = state.work.find(item => item.externalKey === "DOT-CONSUMER"); const now = new Date().toISOString();
  const files = ["agents", "mana-orchestrate", "work"].map(logicalKey => ({ logicalKey, sourceVersion: "fixture-v1", sha256: "a".repeat(64), readMethod: "fixture.read", evidenceRef: `fixture:${logicalKey}` }));
  const record = { schemaVersion: "tcrn.execution-context-read.v1", sessionRef: "fixture:actual-session", readAt: now, workReference: work.id, workRevision: work.revision, scopeDigest: work.scopeDigest, files, effectiveRoots: [f.a.repo] };
  const request = { mode: "dot-autonomous", executionTarget: "chatgpt-dot", libraryId: f.a.reference.libraryId, projectRef: f.a.reference, workId: work.id, revisionBinding: { kind: "revision", workRevision: work.revision, scopeDigest: work.scopeDigest }, requestedAgents: 1, requiredTools: ["fixture.read"], actualCapabilityEvidenceRefs: ["fixture:tool"], authorizationEvidenceRef: "fixture:authorization", checks: Object.fromEntries(DOT_REQUIRED_CHECKS.map(name => [name, { status: "pass", evidenceRefs: [`fixture:${name}`], reason: "synthetic evidence, not a live native acceptance" }])), occupancyObservation: { status: "observed", activeAgents: 0, includesParent: true, parentActive: false, platformLimit: 4, observedAt: now, evidenceRef: "fixture:occupancy" }, modelObservation: { status: "unavailable", reason: "not exposed" }, contextRead: { record, expected: { sessionRef: record.sessionRef, workReference: work.id, workRevision: work.revision, scopeDigest: work.scopeDigest, notBefore: now, now, files: files.map(({ logicalKey, sourceVersion, sha256 }) => ({ logicalKey, sourceVersion, sha256 })), effectiveRoots: [f.a.repo] }, observations: files.map(file => ({ sessionRef: record.sessionRef, source: "execution-session", logicalKey: file.logicalKey, evidenceRef: file.evidenceRef, toolName: file.readMethod, readAt: now, sha256: file.sha256, association: "associated" })) } };
  const plain = await workProjectContexts(state, work.id, f.home); assert.equal(plain.dispatchAdmitted, false); assert.equal(plain.contexts[0].readiness.model.ready, false);
  await writeFile(join(f.home, "engine-model-policy.json"), "{malformed-unrelated-host-policy");
  const { workContentDraft } = await import("../dist/build/packages/core/src/index.js");
  // Pure in-memory content-admission fixture; no policy setter, floor change, or native enablement is exercised.
  const typedState = { ...state, work: state.work.map(item => item.id !== work.id ? item : { ...item, extensions: { ...item.extensions, "advisory:work-content": { required: false, value: workContentDraft("Initiative") } } }) };
  assert.equal((await workProjectContexts(typedState, work.id, f.home, request)).contexts[0].executionAdmission.contentReason, "work-content-action-required");
  assert.equal((await workProjectContexts(typedState, work.id, f.home, { ...request, action: "implementation" })).dispatchAdmitted, false);
  assert.equal((await workProjectContexts(typedState, work.id, f.home, { ...request, action: "research" })).dispatchAdmitted, true);
  const native = await workProjectContexts(state, work.id, f.home, request); assert.equal(native.dispatchAdmitted, true); assert.equal(native.contexts[0].modelApplicability.accountQuota.status, "not-applicable");
  // Same actual fixture target through public prepare/record/evidence and review.
  const { runNativeToolCommand } = await import("../dist/build/packages/cli/src/native-tool-commands.js");
  const { normalizeReviewDispatchEvidence } = await import("../scripts/review-evidence.mjs");
  const argsPath = join(f.root, "native-arguments.json"), contractPath = join(f.root, "native-contract.json"), requestPath = join(f.root, "native-request.json");
  await writeFile(argsPath, JSON.stringify({ path: "fixture:task" })); await writeFile(contractPath, JSON.stringify({ ref: "fixture:tool-contract", sha256: "f".repeat(64) })); await writeFile(requestPath, JSON.stringify(request));
  const commandContext = { home: f.home, resolveWorkspace: async selector => { assert.equal(selector, f.coordination.path); return { root: f.coordination.path, state }; } };
  const bindingPath = join(f.root, "native-preparation.json");
  const prepared = await runNativeToolCommand("execution-native-prepare", { workspace: f.coordination.path, request: requestPath, tool: "fixture.read", "tool-contract": contractPath, arguments: argsPath, output: bindingPath }, commandContext);
  assert.equal(prepared.targetDispatchAdmitted, true);
  const response = { sourceTool: "fixture.read", rawResponseRef: "fixture:response", rawResponseValue: { status: "done", terminal: true }, observedAt: new Date().toISOString(), executionStatus: "reported-completed", statusPointer: "/status", statusMapping: { done: "reported-completed" }, resultRefs: ["fixture:deliverable"], association: { status: "associated", invocationRef: "fixture:invocation", responseRef: "fixture:response", argumentsDigest: prepared.attempt.argumentsDigest, evidenceRefs: ["fixture:actual-link"], reason: "synthetic sequential invocation return" }, terminalObservation: { jsonPointer: "/terminal", terminalValues: ["true"], contractRef: "fixture:tool-contract", evidenceRef: "fixture:terminal" }, verification: { status: "pass", evidenceRefs: ["fixture:check"], verifiedAt: new Date().toISOString(), verifiedBy: "fixture:reviewer" } };
  const responsePath = join(f.root, "native-response.json"), recordedPath = join(f.root, "native-record.json"); await writeFile(responsePath, JSON.stringify(response));
  const saved = await runNativeToolCommand("execution-native-record", { binding: bindingPath, response: responsePath, output: recordedPath }, commandContext);
  assert.equal(saved.normalized.complete, true); assert.deepEqual(saved.record.preparation.context, prepared.context);
  assert.equal((await runNativeToolCommand("execution-native-evidence", { "from-file": recordedPath, "work-id": work.id, "work-revision": String(work.revision) }, commandContext)).complete, true);
  assert.equal(normalizeReviewDispatchEvidence(saved, { workId: work.id, workRevision: work.revision }).complete, true);
  // Unknown outcome does not become a retry. An actual non-execution query can.
  const unresolvedBinding = join(f.root, "native-unresolved-preparation.json");
  const unresolved = await runNativeToolCommand("execution-native-prepare", { workspace: f.coordination.path, request: requestPath, tool: "fixture.read", "tool-contract": contractPath, arguments: argsPath, output: unresolvedBinding }, commandContext);
  const pendingPath = join(f.root, "native-pending.json"); await runNativeToolCommand("execution-native-record", { binding: unresolvedBinding, output: pendingPath }, commandContext);
  const retryOutput = join(f.root, "native-retry.json"), reconcilePath = join(f.root, "native-reconciliation.json");
  const retryFlags = { workspace: f.coordination.path, request: requestPath, tool: "fixture.read", "tool-contract": contractPath, arguments: argsPath, "retry-from": pendingPath, output: retryOutput };
  await assert.rejects(runNativeToolCommand("execution-native-prepare", retryFlags, commandContext), /together/u);
  await writeFile(reconcilePath, JSON.stringify({ outcome: "unknown" })); await assert.rejects(runNativeToolCommand("execution-native-prepare", { ...retryFlags, reconciliation: reconcilePath }, commandContext), /query/u);
  await writeFile(reconcilePath, JSON.stringify({ outcome: "confirmed-not-executed", queryTool: "fixture.query", queryRef: "fixture:query-return", queriedAttemptId: unresolved.attempt.attemptId, responseValue: { status: "not-executed" }, observedAt: new Date().toISOString(), notExecutedPointer: "/status", notExecutedValue: "not-executed", contractRef: "fixture:tool-contract" }));
  const retry = await runNativeToolCommand("execution-native-prepare", { ...retryFlags, reconciliation: reconcilePath }, commandContext);
  assert.notEqual(retry.attempt.attemptId, unresolved.attempt.attemptId); assert.equal(retry.retry.previous.record.attempt.attemptId, unresolved.attempt.attemptId);
  await assert.rejects(runNativeToolCommand("execution-native-prepare", { ...retryFlags, "retry-from": recordedPath, reconciliation: reconcilePath, output: join(f.root, "completed-not-retryable.json") }, commandContext), /completed predecessor/u);
  const retryPending = await runNativeToolCommand("execution-native-record", { binding: retryOutput, output: join(f.root, "native-retry-pending.json") }, commandContext); assert.equal(retryPending.normalized.valid, true); assert.equal(retryPending.normalized.complete, false);
  for (const scopeDigest of [undefined, null, "", "not-a-digest"]) {
    const missingScope = { ...state, work: state.work.map(item => item.id === work.id ? { ...item, scopeDigest } : item) };
    const refused = await workProjectContexts(missingScope, work.id, f.home, request);
    const admission = refused.contexts[0].executionAdmission;
    assert.equal(refused.dispatchAdmitted, false, "the request's valid digest cannot replace an unavailable current observation");
    assert.equal(admission.status, "refused");
    assert.equal(admission.checks.work.status, "fail");
    assert.equal(admission.checks.scope.status, "unknown");
    assert.equal(admission.checks.context.status, "unknown");
    assert.match(admission.contextDigest, /^[a-f0-9]{64}$/u, "missing source stays explicit null in the refusal digest rather than causing undefined serialization");
  }
  await assert.rejects(workProjectContexts({ ...state, work: [] }, work.id, f.home, request), /work does not exist/u);
  const differentWork = await workProjectContexts(state, work.id, f.home, { ...request, workId: "work:other" });
  assert.equal(differentWork.dispatchAdmitted, false);
  assert.equal(differentWork.contexts[0].executionAdmission.checks.work.status, "fail");
  const parentReads = { ...request, contextRead: { ...request.contextRead, observations: request.contextRead.observations.map(item => ({ ...item, source: "parent-session" })) } };
  assert.equal((await workProjectContexts(state, work.id, f.home, parentReads)).dispatchAdmitted, false);
  assert.equal((await workProjectContexts(state, work.id, f.home, { ...request, revisionBinding: { ...request.revisionBinding, workRevision: work.revision + 1 } })).dispatchAdmitted, false);
  await removeConfigRecord(f.a.path, { collection: "chain", key: "repositories", projectId: f.a.reference.projectId, occurredAt: at });
  assert.equal((await workProjectContexts(state, work.id, f.home, request)).dispatchAdmitted, false);
});

test("INIT068 legacy planned content dispatch requires action, preserves research and unenabled legacy", async t => {
  const { workContentDraft } = await import("../dist/build/packages/core/src/index.js");
  const f = await fixture(t); await configureDevicePolicy(f);
  const state = await createWork(f.coordination.path, { projectId: f.coordination.reference.projectId, externalKey: "CONTENT-ACTION", kind: "Initiative", parentId: null, involvedProjects: { state: "selected", targets: [f.a.reference] }, occurredAt: at });
  const work = state.work.find(item => item.externalKey === "CONTENT-ACTION");
  const request = { host: "codex", category: "main", rejections: 0, requestedAgents: 1, availableCombinations: [{ runner: "codex", model: "fixture-device-main", effort: "max" }] };
  assert.equal((await workProjectContexts(state, work.id, f.home, request)).contexts[0].executionAdmission.status, "admitted");
  // Pure in-memory content-admission fixture, not evidence that actual capable V or policy enablement exists.
  const typed = { ...state, work: state.work.map(item => item.id !== work.id ? item : { ...item, extensions: { ...item.extensions, "advisory:work-content": { required: false, value: workContentDraft("Initiative") } } }) };
  const ambiguous = await workProjectContexts(typed, work.id, f.home, request);
  assert.equal(ambiguous.contexts[0].executionAdmission.contentReason, "work-content-action-required");
  for (const action of ["research", "coordination"]) {
    const read = await workProjectContexts(typed, work.id, f.home, { ...request, action });
    assert.equal(read.contexts[0].executionAdmission.status, "admitted");
    assert.equal(read.contexts[0].executionAdmission.request.action, action);
  }
  const implementation = await workProjectContexts(typed, work.id, f.home, { ...request, action: "implementation" });
  assert.equal(implementation.contexts[0].executionAdmission.status, "refused");
  assert.equal(implementation.contexts[0].executionAdmission.contentReason, "work-content-incomplete");
  await assert.rejects(workProjectContexts(typed, work.id, f.home, { ...request, action: "pretend-research" }));
});
