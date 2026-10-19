// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initializeLibrary, createProject, declareChainIdentity, setWorkspaceSetting, registerLibrary,
  initializeKnowledgeStore, createKnowledgeUnit, listKnowledgeMetadata, readKnowledgeBody,
  consolidateLibraries, cleanConsolidatedSources, materializeWorkspaceFromGenesis, scopedWorkspaceState, readRegistry,
  setConfigRecord, chainIdentity, resolveProjectTarget, readConsolidationIndex, openLibrary,
  configureStorageLocation, defaultSharedLibraryPath, cachePath, lockPath,
  createWork,
} from "../dist/build/packages/core/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { promptRecallContext } from "../dist/build/packages/core/src/hook-recall.js";
import { recallInputsFromState } from "../dist/build/packages/core/src/recall-inputs.js";
const at = "2026-10-19T12:00:00Z";
const owner = "owner:000000000000000000000001";
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-consolidation-")));
  const old = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(root, "device");
  t.after(async () => { process.env.EINZBERN_HOME = old; await rm(root, { recursive: true, force: true }); });
  const sources = [];
  for (const name of ["coordination", "alpha", "beta"]) {
    const path = join(root, name, "library"), projectPath = join(root, name, "source");
    await mkdir(projectPath, { recursive: true });
    await initializeLibrary({ root: path, createdAt: at });
    const state = await createProject(path, { externalKey: `PROJECT-${name.toUpperCase()}`, name, occurredAt: at });
    const projectId = state.projects[0].id;
    const role = name === "coordination" ? "coordination" : "project";
    const coordinationLibraryId = sources[0]?.id ?? state.metadata.workspaceId;
    await declareChainIdentity(path, { role, coordinationLibraryId, ...(role === "project" ? { primaryProjectId: projectId } : {}) }, { occurredAt: at });
    if (role === "project") await setWorkspaceSetting(path, { key: "design.repository", value: `https://example.test/${name}`, occurredAt: at });
    await registerLibrary({ projectPath, projectId, libraryPath: path, registeredAt: at, gitRemote: null });
    sources.push({ path, id: state.metadata.workspaceId, projectId, projectPath, role });
  }
  await initializeKnowledgeStore(sources[0].path, { disposableAcknowledged: true });
  await initializeKnowledgeStore(sources[1].path, { disposableAcknowledged: true });
  await createKnowledgeUnit(sources[1].path, { externalKey: "ALPHA-LEGACY-LESSON", scope: "workspace", projectId: null,
    roleScopes: [], category: "implementation", kind: "fact", subject: "Preserve the original alloy calibration", summary: "A measured calibration survives migration", snippet: "Read the original calibration evidence", tags: ["migration"], sourceReferences: [], sourceDigest: null, linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null, exportDisposition: "metadata-only", accountableOwnerId: owner,
    body: "The calibrated copper assembly measured seventeen units at room temperature.", lifecycle: "active", occurredAt: at,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" } });
  const mapping = { primary: sources[0].path, sources: sources.map(source => ({ path: source.path, bindings: [{ projectPath: source.projectPath, projectId: source.projectId, role: source.role }] })) };
  const to = join(root, "shared");
  const options = { at, actor: "agent:codex", decidedIn: "minutes:000000000000000000000001#D1", yes: true };
  return { root, sources, mapping, to, options };
}
test("consolidation preserves native events and isolates settings, knowledge, roles and aliases", async t => {
  const f = await fixture(t);
  const before = await Promise.all(f.sources.map(source => materializeWorkspaceFromGenesis(source.path)));
  const report = await consolidateLibraries(f.mapping, f.to, f.options);
  assert.equal(report.reasonCode, "LIBRARIES_CONSOLIDATED");
  const state = await materializeWorkspaceFromGenesis(f.to);
  assert.equal(chainIdentity(state).role, "shared");
  assert.equal(state.library.rejectedEvents.length, 0);
  assert.equal(state.events.length, before.reduce((n, source) => n + source.events.length, 0));
  for (const source of before) for (const event of source.events) assert.deepEqual(state.events.find(entry => entry.id === event.id), event);
  for (const source of f.sources.slice(1)) {
    const scoped = scopedWorkspaceState(state, source.projectId);
    assert.equal(chainIdentity(scoped).role, "project");
    assert.equal(scoped.settings.find(entry => entry.key === "design.repository").value, `https://example.test/${source.role === "project" && source === f.sources[1] ? "alpha" : "beta"}`);
    assert.notEqual((await resolveProjectTarget({ libraryId: source.id, projectId: source.projectId })).status, "unregistered");
  }
  assert.equal(new Set((await readRegistry()).entries.map(entry => entry.libraryPath)).size, 1);
  const alpha = await listKnowledgeMetadata(f.to, { at, projectId: f.sources[1].projectId, selection: "all" });
  const beta = await listKnowledgeMetadata(f.to, { at, projectId: f.sources[2].projectId, selection: "all" });
  assert.equal(alpha.total, 1);
  assert.equal(beta.total, 0);
  const body = await readKnowledgeBody(f.to, alpha.records[0].id, { at });
  assert.match(body.body, /seventeen units/);
  await setWorkspaceSetting(f.to, { key: "design.repository", value: "https://example.test/updated", configurationProjectId: f.sources[1].projectId, occurredAt: at });
  assert.equal(scopedWorkspaceState(await materializeWorkspaceFromGenesis(f.to), f.sources[1].projectId).settings.find(entry => entry.key === "design.repository").value, "https://example.test/updated");
  const provenance = await readConsolidationIndex(f.to, (await openLibrary(f.to)).manifest);
  assert.equal(provenance.sources.length, 3);
  assert.equal(recallInputsFromState({ ...state, work: [{ id: "a", projectId: "alpha", kind: "Story", tombstone: true }, { id: "b", projectId: "beta", kind: "Story", tombstone: true }] }, [], { projectId: "alpha" }).work.length, 0);
});
test("consolidation resumes an interruption after guarding the sources", async t => {
  const f = await fixture(t);
  await assert.rejects(consolidateLibraries(f.mapping, f.to, { ...f.options, faultAt: "guarded" }), /simulated/);
  assert.equal(new Set((await readRegistry()).entries.map(entry => entry.libraryPath)).size, 3);
  await consolidateLibraries(f.mapping, f.to, f.options);
  assert.equal(new Set((await readRegistry()).entries.map(entry => entry.libraryPath)).size, 1);
  assert.equal((await consolidateLibraries(f.mapping, f.to, f.options)).resumed, true);
});
test("consolidation refuses an occupied target, unsafe nesting and a changed archive", async t => {
  const f = await fixture(t);
  await mkdir(f.to); await writeFile(join(f.to, "unique"), "keep me");
  await assert.rejects(consolidateLibraries(f.mapping, f.to, f.options), error => error.reasonCode === "CONSOLIDATION_TARGET_NOT_EMPTY");
  assert.equal(await readFile(join(f.to, "unique"), "utf8"), "keep me");
  await assert.rejects(consolidateLibraries(f.mapping, join(f.sources[0].path, "inside"), f.options), error => error.reasonCode === "CONSOLIDATION_UNSAFE_PATH");
});
test("runtime moves outside the source tree and a persistent device pointer selects the shared default", async t => {
  const f = await fixture(t);
  const home = process.env.EINZBERN_HOME;
  await mkdir(join(home, "cache"), { recursive: true }); await writeFile(join(home, "cache", "owned"), "runtime data");
  const runtime = join(f.root, "cloud", "runtime");
  await configureStorageLocation(home, f.to, runtime, at, f.options.decidedIn, true);
  assert.equal(defaultSharedLibraryPath(home), f.to);
  assert.ok(cachePath(f.sources[0].id).startsWith(runtime));
  assert.ok(lockPath(f.sources[0].id).startsWith(runtime));
  assert.equal(await readFile(join(runtime, "cache", "owned"), "utf8"), "runtime data");
  assert.equal(await readFile(join(home, "cache", "owned"), "utf8"), "runtime data", "historical evidence paths still resolve");
  await configureStorageLocation(home, f.to, runtime, at, f.options.decidedIn, true);
});

test("a fresh shared library recalls global cards and only the selected project's work and cards", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-shared-recall-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(root, "device");
  t.after(async () => {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const library = join(root, "library");
  await initializeLibrary({ root: library, createdAt: at });
  let state = await materializeWorkspaceFromGenesis(library);
  await declareChainIdentity(library, { role: "shared", coordinationLibraryId: state.metadata.workspaceId }, { occurredAt: at });
  const projects = [];
  for (const key of ["ALPHA", "BETA"]) {
    state = await createProject(library, { externalKey: key, name: key, occurredAt: at });
    const id = state.projects.find(project => project.externalKey === key).id;
    const path = join(root, key);
    await mkdir(path);
    await registerLibrary({ projectPath: path, projectId: id, libraryPath: library, registeredAt: at, gitRemote: null });
    await setWorkspaceSetting(library, { key: "retrieval.tau", value: "0", configurationProjectId: id, occurredAt: at });
    await createWork(library, { projectId: id, externalKey: `${key}-INIT`, kind: "Initiative", parentId: null,
      title: `${key} calibration ledger`, scope: `${key} calibration measurements`, occurredAt: at });
    projects.push({ id, path, key });
  }
  await initializeKnowledgeStore(library, { disposableAcknowledged: true });
  for (const project of [null, ...projects]) await createKnowledgeUnit(library, {
    externalKey: `${project?.key ?? "GLOBAL"}-CALIBRATION`, scope: project === null ? "workspace" : "project", projectId: project?.id ?? null, coexist: true,
    roleScopes: [], category: "implementation", kind: "fact", subject: `${project?.key ?? "GLOBAL"} calibration reference`,
    summary: "Measured calibration data", snippet: "Read calibration measurements", tags: ["calibration"],
    sourceReferences: [], sourceDigest: null, linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null, exportDisposition: "metadata-only", accountableOwnerId: owner,
    body: "Calibration measurements are retained as the shared reference.", lifecycle: "active", occurredAt: at,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
  });
  for (const [selected, other] of [[projects[0], projects[1]], [projects[1], projects[0]]]) {
    let output = "";
    await runCli(["recall", "--workspace", library, "--project-id", selected.id, "--at", at, "--query", "calibration", "--tau", "0"], { write: value => { output += value; } });
    const keys = JSON.parse(output).records.map(record => record.key).sort();
    assert.deepEqual(keys, [`${selected.key}-CALIBRATION`, `${selected.key}-INIT`, "GLOBAL-CALIBRATION"].sort());
    const answer = await promptRecallContext({ libraryPath: library, cwd: selected.path, host: "codex", prompt: "calibration", at });
    assert.ok(answer.lines.some(line => line.includes("GLOBAL calibration reference")));
    assert.ok(answer.lines.some(line => line.includes(`${selected.key} calibration reference`)));
    assert.ok(answer.lines.some(line => line.includes(`${selected.key}-INIT`)));
    assert.equal(answer.lines.some(line => line.includes(`${other.key}-INIT`) || line.includes(`${other.key} calibration reference`)), false);
  }
});

test("verified cleanup rejects unique knowledge and removes only redundant, tombstoned copies", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const copies = f.sources.map(source => ({ path: source.path, libraryId: source.id }));
  const plan = await cleanConsolidatedSources(f.to, copies, at);
  assert.ok(plan.removeBytes > 0);
  await writeFile(join(f.sources[1].path, "crest", "unique-evidence"), "must remain");
  await assert.rejects(cleanConsolidatedSources(f.to, copies, at, true), error => error.reasonCode === "CONSOLIDATION_CLEAN_REFUSED");
  assert.equal(await readFile(join(f.sources[1].path, "crest", "unique-evidence"), "utf8"), "must remain");
});
test("an archive changed after publication fails validation", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const index = await readConsolidationIndex(f.to, (await openLibrary(f.to)).manifest);
  const source = index.sources[1];
  const file = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  await writeFile(join(f.to, source.archive, file.path), "corrupted original event");
  await assert.rejects(materializeWorkspaceFromGenesis(f.to));
});

test("verified cleanup clears redundant copies and keeps the target fully replayable", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const copies = f.sources.map(source => ({ path: source.path, libraryId: source.id }));
  const result = await cleanConsolidatedSources(f.to, copies, at, true);
  assert.equal(result.reasonCode, "CONSOLIDATED_SOURCES_CLEANED");
  for (const source of f.sources) await assert.rejects(readFile(join(source.path, "manifest.json")), { code: "ENOENT" });
  assert.equal((await materializeWorkspaceFromGenesis(f.to)).projects.length, 3);
});
