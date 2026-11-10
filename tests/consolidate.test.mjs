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
  const { materializeLibrary } = await import("../dist/build/packages/core/src/workspace.js");
  const { withRecallObservation } = await import("../dist/build/packages/core/src/recall-observation.js");
  await materializeLibrary(f.to);
  const same = await withRecallObservation(() => materializeLibrary(f.to));
  assert.ok(same.observation.cacheReasons.includes("consolidation-checkpoint-validated-full-byte-read"));
  assert.equal(same.observation.replayedEvents, 0);
  const full = await withRecallObservation(() => materializeWorkspaceFromGenesis(f.to));
  assert.deepEqual(same.value, full.value);
  assert.ok(full.observation.replayedEvents > 0);
  t.diagnostic(JSON.stringify({ fullReplay: full.observation, cachedReplay: same.observation }));
  assert.ok(same.observation.logicalEventBytes > 0, "cache never bypasses archive byte validation");
  const { spawnSync } = await import("node:child_process");
  const module = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
  const observer = new URL("../dist/build/packages/core/src/recall-observation.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {materializeLibrary} from ${JSON.stringify(module)}; import {withRecallObservation} from ${JSON.stringify(observer)}; console.log(JSON.stringify((await withRecallObservation(()=>materializeLibrary(process.argv[1]))).observation));`, f.to], { env: process.env, encoding: "utf8" });
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
