// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initializeLibrary, createProject, declareChainIdentity, setWorkspaceSetting, registerLibrary,
  initializeKnowledgeStore, createKnowledgeUnit, listKnowledgeMetadata, readKnowledgeBody,
  consolidateLibraries, cleanConsolidatedSources, materializeWorkspaceFromGenesis, scopedWorkspaceState, readRegistry,
  setConfigRecord, chainIdentity, resolveProjectTarget, readConsolidationIndex, openLibrary,
  configureStorageLocation, defaultSharedLibraryPath, cachePath, lockPath,
  createWork, appendEvents, createWorkDelta,
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
    const { readRecallAuthority } = await import("../dist/build/packages/core/src/recall-authority.js");
    const { readRecallCards } = await import("../dist/build/packages/core/src/recall-inputs.js");
    const { authority } = await readRecallAuthority(library);
    for (const status of ["valid", "removed", "all"]) assert.deepEqual(await readRecallCards(library, { at, projectId: selected.id, status }, authority), await readRecallCards(library, { at, projectId: selected.id, status }), "645: project/status differential");
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

test("647: validated source snapshots preserve consolidated state and corrupt cache falls back", async t => {
  const f = await fixture(t);
  for (const source of f.sources) await setWorkspaceSetting(source.path, { key: "storage.snapshotEveryEvents", value: "1", occurredAt: at });
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { readCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  const expected = await materializeWorkspaceFromGenesis(f.to);
  const first = await materializeLibrary(f.to);
  const second = await materializeLibrary(f.to);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  for (const source of f.sources) assert.notEqual(await readCacheSnapshot(source.id), null);
  // A damaged derived checkpoint is not authority. Full archive validation still
  // precedes cache use and the normal replay rebuilds its disposable projection.
  const { readdir } = await import("node:fs/promises");
  const snapshots = join(cachePath(f.sources[0].id), "snapshots");
  for (const name of await readdir(snapshots)) if (name.endsWith(".json")) await writeFile(join(snapshots, name), "broken cache\n");
  assert.deepEqual(await materializeLibrary(f.to), expected);
});

test("647: full consolidated checkpoint skips replay, survives restart and resumes necessary tail", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary: cachedMaterializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  // Exercise 647 independently: the existing actual-byte reader seam disables
  // 648 while keeping consolidation checkpoints and all original assertions.
  const materializeLibrary = root => cachedMaterializeLibrary(root, { readFile });
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  await materializeLibrary(f.to);
  const same = await withRecallObservation(() => materializeLibrary(f.to));
  assert.ok(same.observation.cacheReasons.includes("consolidation-checkpoint-validated"));
  assert.equal(same.observation.replayedEvents, 0);
  const full = await withRecallObservation(() => materializeWorkspaceFromGenesis(f.to));
  assert.deepEqual(same.value, full.value);
  assert.ok(full.observation.replayedEvents > 0);
  t.diagnostic(JSON.stringify({ fullReplay: full.observation, cachedReplay: same.observation }));
  assert.ok(same.observation.logicalEventBytes > 0, "cache never bypasses archive byte validation");
  const { spawnSync } = await import("node:child_process");
  const module = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
  const observer = new URL("../dist/build/packages/core/src/recall-observation.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readFile} from "node:fs/promises"; import {materializeLibrary} from ${JSON.stringify(module)}; import {withRecallObservation} from ${JSON.stringify(observer)}; console.log(JSON.stringify((await withRecallObservation(()=>materializeLibrary(process.argv[1],{readFile}))).observation));`, f.to], { env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).replayedEvents, 0);
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "2", occurredAt: at });
  assert.deepEqual(await materializeLibrary(f.to), await materializeWorkspaceFromGenesis(f.to));
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "3", occurredAt: at });
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "4", occurredAt: at });
  assert.deepEqual(await materializeLibrary(f.to), await materializeWorkspaceFromGenesis(f.to));
  const originalHome = process.env.EINZBERN_HOME;
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "5", occurredAt: at });
  try {
    process.env.EINZBERN_HOME = join(f.root, "second-writer");
    await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "6", occurredAt: at });
  } finally { process.env.EINZBERN_HOME = originalHome; }
  const appended = await withRecallObservation(() => materializeLibrary(f.to));
  assert.ok(appended.observation.replayedEvents > 0);
  assert.deepEqual(appended.value, await materializeWorkspaceFromGenesis(f.to));
  const { readCacheSnapshot, writeCacheSnapshot, discardCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  const libraryId = (await openLibrary(f.to)).manifest.libraryId;
  const checkpoint = await readCacheSnapshot(libraryId);
  await writeCacheSnapshot({ ...checkpoint, state: { ...checkpoint.state, consolidationBinding: "mismatched-generation" } });
  const invalid = await withRecallObservation(() => materializeLibrary(f.to));
  assert.ok(invalid.observation.cacheReasons.includes("consolidation-checkpoint-miss-full-replay"));
  assert.deepEqual(invalid.value, await materializeWorkspaceFromGenesis(f.to));
  await discardCacheSnapshot(libraryId);
  assert.deepEqual(await materializeLibrary(f.to), await materializeWorkspaceFromGenesis(f.to));
  const index = await readConsolidationIndex(f.to, (await openLibrary(f.to)).manifest);
  const source = index.sources[1];
  const entry = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const path = join(f.to, source.archive, entry.path);
  const bytes = await readFile(path);
  const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1;
  await writeFile(path, changed);
  await assert.rejects(materializeLibrary(f.to), "same-length archive tampering must reject even with a warm checkpoint");
});

test("647: unsupported nested generation refuses instead of adopting the prior checkpoint", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  await materializeLibrary(f.to);
  const next = join(f.root, "next-generation");
  const bindings = f.mapping.sources.flatMap(source => source.bindings);
  const extra = join(f.root, "gamma-library");
  const projectPath = join(f.root, "gamma-source");
  await mkdir(projectPath);
  await initializeLibrary({ root: extra, createdAt: at });
  const gamma = await createProject(extra, { externalKey: "GAMMA", name: "Gamma", occurredAt: at });
  const projectId = gamma.projects[0].id;
  await declareChainIdentity(extra, { role: "project", coordinationLibraryId: (await openLibrary(f.to)).manifest.libraryId, primaryProjectId: projectId }, { occurredAt: at });
  await registerLibrary({ projectPath, projectId, libraryPath: extra, registeredAt: at, gitRemote: null });
  await assert.rejects(consolidateLibraries({ primary: f.to, sources: [{ path: f.to, bindings }, { path: extra, bindings: [{ projectPath, projectId, role: "project" }] }] }, next, f.options), { reasonCode: "CONSOLIDATION_MAPPING_INVALID" });
  assert.deepEqual(await materializeLibrary(f.to), await materializeWorkspaceFromGenesis(f.to));
});

test("647: warm checkpoint rejects coherently rehashed source history at unchanged vector", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { createEvent, eventInputOf, canonicalJson } = await import("../dist/build/packages/protocol/src/index.js");
  const { createHash } = await import("node:crypto");
  await materializeLibrary(f.to);
  const index = await readConsolidationIndex(f.to, (await openLibrary(f.to)).manifest);
  const source = index.sources[1];
  const file = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const path = join(f.to, source.archive, file.path);
  const events = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  const last = events.at(-1);
  events[events.length - 1] = createEvent({ ...eventInputOf(last), occurredAt: "2026-10-19T12:00:01Z" }, last.schemaVersion);
  const text = events.map(event => canonicalJson(event)).join("");
  await writeFile(path, text);
  const manifestPath = path.replace(/[^/]+$/u, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.headEventHash = events.at(-1).eventHash;
  const segment = manifest.segments.find(segment => path.endsWith(segment.name));
  segment.bytes = Buffer.byteLength(text);
  segment.sha256 = createHash("sha256").update(text).digest("hex");
  await writeFile(manifestPath, canonicalJson(manifest));
  await assert.rejects(materializeLibrary(f.to), { reasonCode: "CONSOLIDATION_SOURCE_CHANGED" });
});

test("647: incremental source-stream matrix preserves status, queries and governance across restart", async t => {
  const f = await fixture(t);
  for (const source of f.sources) {
    for (let index = 0; index < 4; index += 1) await createWork(source.path, {
      projectId: source.projectId, externalKey: `${source.role}-${source.projectId.slice(-8)}-${index}`,
      kind: "Initiative", parentId: null, title: `Calibration ${index}`, scope: "Calibrated assembly evidence", occurredAt: at,
    });
  }
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary: cachedMaterializeLibrary, workspaceViewDocuments, transitionWorkDelta } = await import("../dist/build/packages/core/src/workspace.js");
  // Exercise 647 independently: the existing actual-byte reader seam disables
  // 648 while keeping consolidation checkpoints and all original assertions.
  const materializeLibrary = root => cachedMaterializeLibrary(root, { readFile });
  const { workContentContext } = await import("../dist/build/packages/core/src/work-content-context.js");
  const { recall, recallDocuments, resetRecallCache } = await import("../dist/build/packages/core/src/recall.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const { readCacheSnapshot, writeCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  const libraryId = (await openLibrary(f.to)).manifest.libraryId;
  t.after(resetRecallCache);
  await materializeLibrary(f.to);
  const samples = [];
  const compare = async (scenario, replayedEvents) => {
    const candidate = await withRecallObservation(() => materializeLibrary(f.to));
    const full = await withRecallObservation(() => materializeWorkspaceFromGenesis(f.to));
    assert.deepEqual(candidate.value, full.value, scenario);
    assert.deepEqual(workspaceViewDocuments(candidate.value), workspaceViewDocuments(full.value), `${scenario}: status/index/readback`);
    for (const source of f.sources) {
      const cached = scopedWorkspaceState(candidate.value, source.projectId);
      const genesis = scopedWorkspaceState(full.value, source.projectId);
      assert.deepEqual(chainIdentity(cached), chainIdentity(genesis), `${scenario}: scoped authority`);
      const query = (state, mode) => recall({
        cacheKey: `${scenario}:${source.projectId}:${mode}`, checkpoint: state.headEventHash,
        documents: () => recallDocuments(recallInputsFromState(state, [], { projectId: source.projectId })),
        query: "Calibration", tau: 0,
      });
      const answer = query(cached, "candidate");
      assert.ok(answer.records.length > 0);
      assert.deepEqual(answer, query(genesis, "genesis"), `${scenario}: query results/scores`);
      const id = cached.work.find(work => work.projectId === source.projectId).id;
      assert.deepEqual(workContentContext(candidate.value, id), workContentContext(full.value, id), `${scenario}: inherited governance`);
      const input = { id, status: "ready", occurredAt: at };
      assert.deepEqual(transitionWorkDelta(input)(candidate.value), transitionWorkDelta(input)(full.value), `${scenario}: transition admission`);
      for (const state of [candidate.value, full.value]) assert.throws(() => transitionWorkDelta({ ...input, status: "active" })(state), { reasonCode: "INVALID_TRANSITION" });
    }
    assert.equal(candidate.observation.replayedEvents, replayedEvents, scenario);
    assert.equal(candidate.observation.logicalEventBytes, full.observation.logicalEventBytes, "647 still verifies every source byte");
    assert.equal(candidate.observation.eventReadsBySource.reduce((bytes, source) => bytes + source.bytes, 0), candidate.observation.logicalEventBytes);
    assert.ok(candidate.observation.eventReadsBySource.some(source => source.scope === "archive"));
    assert.ok(candidate.observation.metadataReadBytes > 0);
    assert.ok(candidate.observation.cacheReadBytes > 0);
    assert.ok(candidate.observation.segmentHashCpuMicros > 0);
    assert.ok(candidate.observation.eventValidationCpuMicros > 0);
    samples.push({ scenario, candidate: candidate.observation, full: full.observation });
    return candidate.value;
  };
  await compare("unchanged", 0);
  let checkpoint = await readCacheSnapshot(libraryId);
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "7", occurredAt: at });
  await writeCacheSnapshot(checkpoint);
  await compare("one stream, one append", 1);
  checkpoint = await readCacheSnapshot(libraryId);
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "8", occurredAt: at });
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "9", occurredAt: at });
  await writeCacheSnapshot(checkpoint);
  await compare("one stream, multiple appends", 2);
  checkpoint = await readCacheSnapshot(libraryId);
  const home = process.env.EINZBERN_HOME;
  try {
    for (const device of ["laptop", "desktop"]) {
      process.env.EINZBERN_HOME = join(f.root, device);
      await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: device === "laptop" ? "10" : "11", occurredAt: at });
    }
  } finally {
    process.env.EINZBERN_HOME = home;
  }
  await writeCacheSnapshot(checkpoint);
  const expected = await compare("multiple source streams append", 2);
  const { spawnSync } = await import("node:child_process");
  const module = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
  const observer = new URL("../dist/build/packages/core/src/recall-observation.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readFile} from "node:fs/promises"; import {materializeLibrary} from ${JSON.stringify(module)}; import {withRecallObservation} from ${JSON.stringify(observer)}; console.log(JSON.stringify(await withRecallObservation(()=>materializeLibrary(process.argv[1],{readFile}))));`, f.to], { env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const restarted = JSON.parse(child.stdout);
  assert.deepEqual(restarted.value, expected);
  assert.equal(restarted.observation.replayedEvents, 0);
  for (let pair = 0; pair < 15; pair += 1) {
    const run = async full => withRecallObservation(() => full ? materializeWorkspaceFromGenesis(f.to) : materializeLibrary(f.to));
    const firstFull = pair % 2 === 0;
    const first = await run(firstFull), second = await run(!firstFull);
    assert.deepEqual(first.value, second.value);
    samples.push({ pair, candidate: (firstFull ? second : first).observation, full: (firstFull ? first : second).observation });
  }
  t.diagnostic(JSON.stringify({ matrix: samples, restarted: restarted.observation, testProcessResources: process.resourceUsage() }));
});

test("648: full verification detects authentic same-length, same-name, missing and incomplete source anomalies", async t => {
  const f = await fixture(t);
  // This scenario asserts native partial reads. Give that real path enough
  // archived work to be eligible, while leaving the changed alpha object and
  // all integrity/byte assertions unchanged. Small full reads have own coverage.
  const beta = f.sources[2];
  await appendEvents(beta.path, Array.from({ length: 20 }, (_, n) => createWorkDelta({
    projectId: beta.projectId, externalKey: `NATIVE-INTEGRITY-${n}`, kind: "Initiative", parentId: null,
    title: `Native integrity payload ${n}`, scope: "Native integrity input",
    body: "calibration ".repeat(20000), occurredAt: at,
  })), { occurredAt: at });
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const library = await openLibrary(f.to);
  const index = await readConsolidationIndex(f.to, library.manifest);
  const source = index.sources[1];
  const entry = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const path = join(f.to, source.archive, entry.path);
  const original = await readFile(path), originalStat = await stat(path);
  const expected = await materializeWorkspaceFromGenesis(f.to);
  await materializeLibrary(f.to);
  const warm = await withRecallObservation(() => materializeLibrary(f.to));
  assert.deepEqual(warm.value, expected);
  assert.ok(warm.observation.cacheReadBytes > 0);
  assert.equal(warm.observation.cacheWriteBytes, 0);
  if (process.platform === "darwin") assert.ok(warm.observation.verifiedSegmentsBySource.length > 0, "the eligible input must actually use native verification");
  const observations = [{ scenario: "warm unchanged, native resident-file proof", observation: warm.observation }];
  const rejects = async (scenario, predicate) => {
    let observation;
    await assert.rejects(withRecallObservation(() => materializeLibrary(f.to), value => { observation = value; }), predicate);
    assert.ok(observation.logicalEventBytes > 0, scenario);
    observations.push({ scenario, observation });
  };
  const restore = async () => {
    await writeFile(path, original);
    await utimes(path, originalStat.atime, originalStat.mtime);
  };
  const changed = Buffer.from(original);
  changed[changed.length - 2] ^= 1;
  await writeFile(path, changed);
  await utimes(path, originalStat.atime, originalStat.mtime);
  await rejects("in-place same-length corruption with restored mtime");
  await restore();
  await writeFile(`${path}.replacement`, changed);
  await utimes(`${path}.replacement`, originalStat.atime, originalStat.mtime);
  await rename(`${path}.replacement`, path);
  await rejects("same-name same-length replacement with restored mtime");
  await restore();
  await writeFile(`${path}.replacement`, original);
  await rename(`${path}.replacement`, path);
  const replaced = await withRecallObservation(() => materializeLibrary(f.to));
  assert.deepEqual(replaced.value, expected, "byte-identical replacement is valid after full verification");
  assert.equal(replaced.observation.logicalEventBytes, original.length, "only the changed object needs full source verification");
  observations.push({ scenario: "byte-identical replacement fully read", observation: replaced.observation });
  await rename(path, `${path}.missing`);
  await rejects("missing historical segment", { reasonCode: "AKASHA_SEGMENT_CORRUPT" });
  await rename(`${path}.missing`, path);
  await writeFile(path, original.subarray(0, Math.floor(original.length / 2)));
  await rejects("partially populated historical segment", { reasonCode: "AKASHA_SEGMENT_CORRUPT" });
  await restore();
  const indexPath = join(f.to, library.manifest.consolidation.index);
  const originalIndex = await readFile(indexPath);
  await writeFile(indexPath, Buffer.concat([originalIndex, Buffer.from(" ")]));
  await rejects("index digest mismatch", { reasonCode: "CONSOLIDATION_DIGEST_MISMATCH" });
  await writeFile(indexPath, originalIndex);
  const { readStreamManifest, readStreamEvents, buildStreamEvents, appendStreamEvents } = await import("../dist/build/packages/core/src/akasha.js");
  const archive = join(f.to, source.archive);
  const deviceId = Object.keys(source.versionVector)[0];
  const manifest = await readStreamManifest(archive, deviceId, { archivedManifest: source.manifest });
  const events = await readStreamEvents(archive, manifest, { archivedManifest: source.manifest });
  const setting = events.find(event => event.payload.operation === "settings.updated");
  await appendStreamEvents({ root: archive, manifest: source.manifest }, manifest, buildStreamEvents(manifest, [{ occurredAt: at, payload: setting.payload }], manifest.clockHighWater));
  await rejects("authentic source append under an unchanged consolidation index", /CONSOLIDATION_SOURCE_CHANGED/u);
  t.diagnostic(JSON.stringify({ fullReadAnomalies: observations, helperScriptBytes: observations.reduce((bytes, sample) => bytes + sample.observation.verificationHelperScriptBytes, 0), readSkipAcceptance: "unclaimed" }));
});

test("648: a real mmap mutation cannot be hidden by a warm replay checkpoint", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  await materializeLibrary(f.to);
  const index = await readConsolidationIndex(f.to, (await openLibrary(f.to)).manifest);
  const source = index.sources[1];
  const entry = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const path = join(f.to, source.archive, entry.path);
  const { spawn } = await import("node:child_process");
  const python = spawn("/usr/bin/python3", ["-c", "import mmap,sys\nf=open(sys.argv[1],'r+b')\nm=mmap.mmap(f.fileno(),0)\nm[-2]=m[-2]^1\nprint('mapped',flush=True)\nsys.stdin.read(1)\nm.close()\nf.close()", path], { stdio: ["pipe", "pipe", "pipe"] });
  const finished = new Promise((resolve, reject) => { python.once("error", reject); python.once("exit", (code, signal) => resolve({ code, signal })); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mmap fixture did not become ready")), 3000);
      python.stdout.once("data", data => { clearTimeout(timer); data.toString().includes("mapped") ? resolve() : reject(new Error("unexpected mmap fixture output")); });
      python.once("error", error => { clearTimeout(timer); reject(error); });
      python.once("exit", code => { clearTimeout(timer); reject(new Error(`mmap fixture exited early: ${code}`)); });
    });
    await assert.rejects(materializeLibrary(f.to));
  } finally {
    python.stdin.end("\n");
    const timer = setTimeout(() => python.kill("SIGTERM"), 3000);
    try { assert.deepEqual(await finished, { code: 0, signal: null }); } finally { clearTimeout(timer); }
  }
});

test("647: a new supported consolidation generation invalidates the previous base and replays changed sources", async t => {
  const f = await fixture(t);
  const copies = [];
  for (const source of f.sources) {
    const path = join(f.root, "next-sources", source.projectId);
    await cp(source.path, path, { recursive: true });
    copies.push({ ...source, path });
  }
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const { readCacheSnapshot, writeCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  await materializeLibrary(f.to);
  const previous = await readCacheSnapshot(f.sources[0].id);
  for (const source of copies.slice(1)) await setWorkspaceSetting(source.path, { key: "design.repository", value: `https://example.test/next-${source.projectId}`, occurredAt: at });
  for (const source of copies) await registerLibrary({ projectPath: source.projectPath, projectId: source.projectId, libraryPath: source.path, registeredAt: at, gitRemote: null });
  const next = join(f.root, "next-shared");
  await consolidateLibraries({ primary: copies[0].path, sources: copies.map(source => ({ path: source.path, bindings: [{ projectPath: source.projectPath, projectId: source.projectId, role: source.role }] })) }, next, f.options);
  await writeCacheSnapshot(previous);
  const changed = await withRecallObservation(() => materializeLibrary(next));
  assert.ok(changed.observation.cacheReasons.includes("consolidation-checkpoint-miss-full-replay"));
  assert.ok(changed.observation.replayedEvents > 0);
  assert.deepEqual(changed.value, await materializeWorkspaceFromGenesis(next));
  for (const source of copies.slice(1)) assert.equal(scopedWorkspaceState(changed.value, source.projectId).settings.find(setting => setting.key === "design.repository").value, `https://example.test/next-${source.projectId}`);
  const warm = await withRecallObservation(() => materializeLibrary(next));
  assert.equal(warm.observation.replayedEvents, 0);
  assert.deepEqual(warm.value, changed.value);
});

test("647: valid checkpoint payload paired with foreign or damaged coverage never seeds replay", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const { readCacheSnapshot, writeCacheSnapshot, discardCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  const expected = await materializeWorkspaceFromGenesis(f.to);
  await materializeLibrary(f.to);
  const valid = await readCacheSnapshot(f.sources[0].id);
  for (const [scenario, checkpoint] of [
    ["foreign engine", { ...valid, engineVersion: "0.0.0" }],
    ["damaged coverage", { ...valid, maxClock: valid.maxClock + 1 }],
    ["foreign base", { ...valid, state: { ...valid.state, consolidationBinding: "foreign-base" } }],
    ["incompatible checkpoint", { ...valid, state: { ...valid.state, consolidationCheckpoint: null } }],
    ["damaged projection shape", { ...valid, state: { ...valid.state, work: null } }],
  ]) {
    await writeCacheSnapshot(checkpoint);
    const result = await withRecallObservation(() => materializeLibrary(f.to));
    assert.ok(result.observation.cacheReasons.includes("consolidation-checkpoint-miss-full-replay"), scenario);
    assert.deepEqual(result.value, expected, scenario);
  }
  await discardCacheSnapshot(f.sources[0].id);
  assert.deepEqual(await materializeLibrary(f.to), expected, "missing checkpoint");
  const oldState = await readCacheSnapshot(f.sources[0].id);
  await setWorkspaceSetting(f.to, { key: "storage.snapshotEveryEvents", value: "13", occurredAt: at });
  const { readAllStreams } = await import("../dist/build/packages/core/src/akasha.js");
  const advanced = await readAllStreams(f.to);
  const appended = await materializeWorkspaceFromGenesis(f.to);
  // A torn/mispaired header claims the new tail is already materialized while
  // its valid, hashed projection still contains only the older state.
  await writeCacheSnapshot({
    ...oldState, version: appended.version,
    maxClock: Math.max(...advanced.events.map(entry => entry.clock)),
    streams: advanced.streams.filter(stream => stream.manifest?.headEventHash).map(({ manifest }) => ({ deviceId: manifest.deviceId, streamId: manifest.streamId, sequence: manifest.sequence, eventHash: manifest.headEventHash })),
  });
  const repaired = await withRecallObservation(() => materializeLibrary(f.to));
  assert.ok(repaired.observation.cacheReasons.includes("consolidation-checkpoint-miss-full-replay"));
  assert.deepEqual(repaired.value, appended, "a valid old state cannot skip a newly committed event");
});

test("647/648: recomputing a snapshot checksum cannot attest a forged reducer projection", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const { readCacheSnapshot, writeCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  const expected = await materializeWorkspaceFromGenesis(f.to);
  await materializeLibrary(f.to, { readFile });
  for (const [mode, options] of [["checkpoint-full", { readFile }], ["native", {}]]) {
    const snapshot = await readCacheSnapshot(f.sources[0].id);
    await writeCacheSnapshot({ ...snapshot, state: { ...snapshot.state, projects: snapshot.state.projects.map((project, index) => index === 0 ? { ...project, name: "Forged cached projection" } : project) } });
    assert.equal((await readCacheSnapshot(f.sources[0].id)).state.projects[0].name, "Forged cached projection", "the ordinary checksum is valid");
    const result = await withRecallObservation(() => materializeLibrary(f.to, options));
    assert.ok(result.observation.cacheReasons.includes("consolidation-checkpoint-miss-full-replay"), mode);
    assert.ok(result.observation.replayedEvents > 0, mode);
    assert.deepEqual(result.value, expected, mode);
    const warm = await withRecallObservation(() => materializeLibrary(f.to, options));
    assert.equal(warm.observation.replayedEvents, 0, `${mode}: the newly attested projection remains reusable`);
  }
});

test("647: absent or damaged independent projection proof requires authority replay", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const expected = await materializeWorkspaceFromGenesis(f.to);
  await materializeLibrary(f.to, { readFile });
  const proof = join(process.env.EINZBERN_HOME, "replay-projections", f.sources[0].id.replace(":", "-"), "projection.json");
  for (const kind of ["missing", "damaged"]) {
    if (kind === "missing") await rm(proof);
    else await writeFile(proof, "damaged independent proof\n");
    const result = await withRecallObservation(() => materializeLibrary(f.to, { readFile }));
    assert.ok(result.observation.cacheReasons.includes("consolidation-checkpoint-miss-full-replay"), kind);
    assert.ok(result.observation.replayedEvents > 0, kind);
    assert.deepEqual(result.value, expected, kind);
    assert.equal((await withRecallObservation(() => materializeLibrary(f.to, { readFile }))).observation.replayedEvents, 0);
  }
});

test("647: a root proof miss cannot attest an unverified source snapshot", async t => {
  const f = await fixture(t);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { readCacheSnapshot, writeCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  await setWorkspaceSetting(f.sources[1].path, { key: "storage.snapshotEveryEvents", value: "1", occurredAt: at });
  await materializeLibrary(f.sources[1].path);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const expected = await materializeWorkspaceFromGenesis(f.to);
  await materializeLibrary(f.to, { readFile });
  const source = await readCacheSnapshot(f.sources[1].id);
  assert.ok(source);
  await writeCacheSnapshot({ ...source, state: { ...source.state, projects: source.state.projects.map(project => ({ ...project, name: "Forged source projection" })) } });
  await rm(join(process.env.EINZBERN_HOME, "replay-projections", f.sources[0].id.replace(":", "-"), "projection.json"));
  assert.deepEqual(await materializeLibrary(f.to, { readFile }), expected);
  assert.deepEqual(await materializeLibrary(f.to, { readFile }), expected, "the newly attested root still matches genesis");
});

test("648: a checksum-valid cache claim is not authority for unread source bytes", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { createHash } = await import("node:crypto");
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { readCacheSnapshot } = await import("../dist/build/packages/core/src/library-cache.js");
  const expected = await materializeWorkspaceFromGenesis(f.to);
  await materializeLibrary(f.to);
  const library = await openLibrary(f.to);
  const index = await readConsolidationIndex(f.to, library.manifest);
  const source = index.sources[1];
  const entry = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const path = join(f.to, source.archive, entry.path);
  const snapshot = await readCacheSnapshot(library.manifest.libraryId);
  const proofClaim = {
    libraryId: library.manifest.libraryId,
    sourceId: source.manifest.libraryId,
    segment: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    indexDigest: library.manifest.consolidation.sha256,
    sourceHead: source.headEventHash,
    versionVector: source.versionVector,
    verification: "claimed-by-cache-writer",
  };
  // Model a writer of the existing cache files, without calling the engine's
  // cache writer or changing permissions. A content digest is publicly
  // recomputable, so it detects damage but does not identify this writer.
  const stateText = `${JSON.stringify({ ...snapshot.state, sourceByteVerification: proofClaim })}\n`;
  const stateDigest = createHash("sha256").update(stateText).digest("hex");
  const directory = join(cachePath(library.manifest.libraryId), "snapshots");
  const header = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
  await writeFile(join(directory, `${stateDigest}.json`), stateText);
  await writeFile(join(directory, "snapshot.json"), `${JSON.stringify({ ...header, stateDigest })}\n`);
  assert.deepEqual((await readCacheSnapshot(library.manifest.libraryId)).state.sourceByteVerification, proofClaim);
  assert.deepEqual(await materializeLibrary(f.to), expected, "a disposable cache extension changes no authority");
  const before = await stat(path);
  const original = await readFile(path);
  const changed = Buffer.from(original);
  changed[changed.length - 2] ^= 1;
  await writeFile(path, changed);
  await utimes(path, before.atime, before.mtime);
  await assert.rejects(materializeLibrary(f.to), "even a checksum-valid claim cannot conceal same-length source corruption");
});

test("648: the source event API still reads its actual archive after a warm consolidated checkpoint", async t => {
  const f = await fixture(t);
  await consolidateLibraries(f.mapping, f.to, f.options);
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { readStreamManifest, readStreamEvents } = await import("../dist/build/packages/core/src/akasha.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  const state = await materializeLibrary(f.to);
  await materializeLibrary(f.to);
  const index = await readConsolidationIndex(f.to, (await openLibrary(f.to)).manifest);
  for (const source of index.sources) {
    const archive = join(f.to, source.archive);
    const { readdir } = await import("node:fs/promises");
    for (const deviceId of await readdir(join(archive, "akasha"))) {
      const options = { archivedManifest: source.manifest };
      const manifest = await readStreamManifest(archive, deviceId, options);
      if (manifest === null) continue;
      const read = await withRecallObservation(() => readStreamEvents(archive, manifest, options));
      assert.equal(read.value.length, manifest.sequence);
      assert.equal(read.observation.logicalEventBytes, manifest.segments.reduce((total, segment) => total + segment.bytes, 0));
      assert.ok(read.observation.eventReadsBySource.every(entry => entry.scope === "archive"));
      for (const event of read.value) assert.deepEqual(state.events.find(entry => entry.id === event.id), event);
    }
  }
});
