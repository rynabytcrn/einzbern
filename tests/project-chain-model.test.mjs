// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, realpath, rename, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeLibrary, createProject, deleteProject, createWork, annotateWork, materializeWorkspace, materializeWorkspaceFromGenesis, setWorkspaceSetting, removeWorkspaceSetting, setConfigRecord, removeConfigRecord, registerLibrary, readRegistry, registryPath, withFileLock, declareChainIdentity, chainIdentity, workProjectContexts, resolveProjectTarget, registeredCoordination, ensureProjectCoordination, effectiveProjectState, normalizeInvolvedProjects, involvedProjectsOf, projectLineage, scopedWorkspaceState, enableRule, disableRule, listRules, renderAgentsSections, readSettingsCatalog } from "../dist/build/packages/core/src/index.js";
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
  await setWorkspaceSetting(f.a.path, { key: "models.tiers", value: JSON.stringify(tiers), configurationProjectId: f.a.reference.projectId, occurredAt: at });
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
// state and never writes managed prose into the library.
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
  assert.deepEqual([enabled.reasonCode, enabled.written, enabled.recorded, enabled.result, enabled.rule.state], ["RULE_ENABLED", false, 1, "unchanged", "enabled"]);
  assert.equal((await listRules({ libraryRoot: coordination.path, configurationProjectId: entry.projectId })).find(rule => rule.id === "autonomy").state, "enabled");
  assert.equal((await cli(["rule-list", "--project", coordination.path])).rules.find(rule => rule.id === "autonomy").state, "enabled");
  const disabled = await cli(["rule-disable", "--id", "autonomy", "--project", coordination.path, "--project-id", entry.projectId, "--at", at]);
  assert.deepEqual([disabled.reasonCode, disabled.written, disabled.recorded], ["RULE_DISABLED", false, 1]);
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
