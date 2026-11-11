// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  initializeLibrary, createProject, declareChainIdentity, setWorkspaceSetting,
  createWork, consolidateLibraries, materializeLibrary, materializeWorkspaceFromGenesis,
  openLibrary, readConsolidationIndex, readAllStreams, cachePath, configureStorageLocation,
  registerLibrary,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { withRecallObservation } from "../dist/build/packages/core/src/recall-observation.js";

const at = "2026-11-11T12:00:00Z";
const native = process.platform === "darwin";
const spawnSync = childProcess.spawnSync;
const hits = observation => observation.verifiedSegmentsBySource.reduce((sum, source) => sum + source.segments, 0);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "einzbern-source-verification-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(root, "device");
  process.env.EINZBERN_HOME = home;
  t.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const sources = [];
  for (const name of ["coordination", "alpha"]) {
    const path = join(root, name);
    const initial = await initializeLibrary({ root: path, createdAt: at });
    const state = await createProject(path, { externalKey: `VERIFY-${name}`, name, occurredAt: at });
    const projectId = state.projects[0].id;
    const role = name === "coordination" ? "coordination" : "project";
    await declareChainIdentity(path, { role, coordinationLibraryId: sources[0]?.id ?? initial.metadata.workspaceId, ...(role === "project" ? { primaryProjectId: projectId } : {}) }, { occurredAt: at });
    await setWorkspaceSetting(path, { key: "storage.segmentBytes", value: "4096", occurredAt: at });
    for (let n = 0; n < 3; n += 1) await createWork(path, { projectId, externalKey: `VERIFY-${name}-${n}`, kind: "Initiative", parentId: null, title: `Calibration ${name} ${n}`, scope: "calibration ".repeat(80), occurredAt: at });
    sources.push({ path, id: initial.metadata.workspaceId, projectId, role });
  }
  for (const source of sources) {
    const projectPath = join(root, "projects", source.role);
    await fs.mkdir(projectPath, { recursive: true });
    await registerLibrary({ projectPath, projectId: source.projectId, libraryPath: source.path, registeredAt: at, gitRemote: null });
  }
  const library = join(root, "shared");
  await consolidateLibraries({ primary: sources[0].path, sources: sources.map(source => ({ path: source.path, bindings: [{ projectPath: join(root, "projects", source.role), projectId: source.projectId, role: source.role }] })) }, library, { at, actor: "agent:codex", decidedIn: "minutes:000000000000000000000001#D1", yes: true });
  const manifest = (await openLibrary(library)).manifest;
  const index = await readConsolidationIndex(library, manifest);
  const source = index.sources.find(source => source.manifest.libraryId === sources[1].id);
  const segment = source.inventory.find(file => /akasha\/.*\.ndjson$/u.test(file.path));
  const target = join(library, source.archive, segment.path);
  return { root, home, library, manifest, sources, target, records: join(home, "source-verification", manifest.libraryId.replace(":", "-")), cache: join(cachePath(manifest.libraryId), "verified-segments") };
}

// A controlled provider response exercises the eligibility branches on local
// fixtures. fgetattrlist, held-object identity, boot, mount and generations
// still come from the system helper. These tests do not claim real hydration.
function provider(t, change = () => {}) {
  let queries = 0;
  t.mock.method(childProcess, "spawnSync", (command, arguments_, options) => {
    const result = spawnSync(command, arguments_, options);
    if (command !== "/usr/bin/osascript" || result.status !== 0) return result;
    const value = JSON.parse(result.stdout);
    queries += 1;
    for (const file of value.files) file.resources = {
      NSURLIsUbiquitousItemKey: true,
      NSURLUbiquitousItemIsDownloadingKey: false,
      NSURLUbiquitousItemDownloadingStatusKey: "NSURLUbiquitousItemDownloadingStatusCurrent",
      NSURLUbiquitousItemDownloadingErrorKey: null,
      NSURLFileResourceIdentifierKey: "controlled-provider-identity",
    };
    change(value, queries, JSON.parse(arguments_.at(-1)));
    return { ...result, stdout: JSON.stringify(value) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
async function read(f) {
  return withRecallObservation(() => materializeLibrary(f.library));
}
async function warm(f) {
  await read(f);
  const result = await read(f);
  assert.ok(hits(result.observation) > 0);
  assert.equal(result.observation.logicalEventBytes, 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  return result;
}
async function editRecord(f, change) {
  const name = (await fs.readdir(f.records)).find(name => name.endsWith(".json"));
  const path = join(f.records, name);
  const envelope = JSON.parse(await fs.readFile(path, "utf8"));
  change(envelope.record);
  envelope.checksum = canonicalSha256(envelope.record);
  await fs.writeFile(path, canonicalJson(envelope));
}
async function corrupt(f) {
  const bytes = await fs.readFile(f.target);
  const changed = bytes.toString("utf8").replace('"name":"alpha"', '"name":"Alpha"');
  assert.notEqual(changed, bytes.toString("utf8"));
  assert.equal(Buffer.byteLength(changed), bytes.length);
  return Buffer.from(changed);
}

test("unknown per-file provider status preserves full source reads", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t, value => { for (const file of value.files) file.resources = {}; });
  const result = await read(f);
  assert.equal(hits(result.observation), 0);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

test("resident native local files reuse without provider-only download keys", { skip: !native }, async t => {
  const f = await fixture(t);
  const result = await warm(f);
  assert.ok(result.observation.cacheReadBytes > 0);
  assert.ok(result.observation.verificationRecordBytes > 0);
});

test("verified projections avoid repeated event validation and batch native helpers", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  const first = await read(f);
  const result = await read(f);
  assert.ok(hits(result.observation) > 0);
  assert.equal(result.observation.logicalEventBytes, 0);
  assert.ok(result.observation.verificationHelperScriptBytes > 0);
  const helper = await fs.readFile(new URL("../scripts/lib/darwin-source-identity.mjs", import.meta.url));
  assert.equal(result.observation.verificationHelperScriptBytes, helper.length * 2);
  assert.ok(result.observation.cacheReadBytes < first.observation.logicalEventBytes + first.observation.cacheReadBytes);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

test("verified byte reuse preserves complete state, append, rollover and public events", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  const first = await warm(f);
  assert.ok(first.observation.cacheReadBytes > 0);
  assert.ok(first.observation.verificationRecordBytes > 0);
  assert.ok(first.observation.verificationHelperScriptBytes > 0);
  await setWorkspaceSetting(f.library, { key: "storage.snapshotEveryEvents", value: "7", occurredAt: at });
  let result = await read(f);
  assert.ok(result.observation.logicalEventBytes > 0, "the changed active segment is fully read");
  assert.ok(hits(result.observation) > 0, "unchanged segments still reuse verified bytes");
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  await createWork(f.library, { projectId: f.sources[0].projectId, externalKey: "VERIFY-LARGE", kind: "Initiative", parentId: null, title: "New calibration", scope: "calibration ".repeat(700), occurredAt: at });
  result = await read(f);
  assert.ok(result.observation.logicalEventBytes > 0, "the new segment is fully read");
  assert.ok(hits(result.observation) > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  const events = await withRecallObservation(() => readAllStreams(f.library));
  assert.ok(events.observation.logicalEventBytes > 0, "public source-event API still reads actual sources");
  assert.equal(hits(events.observation), 0);
  assert.ok(events.value.consolidation.sources[1].read.events.length > 0);
});

test("prior verification stays in the device home when runtime is relocated into the source", { skip: !native }, async t => {
  const f = await fixture(t);
  await configureStorageLocation(f.home, f.library, join(f.library, ".einzbern", "runtime"), at, "minutes:000000000000000000000001#D1", true);
  provider(t);
  await warm(f);
  assert.ok((await fs.readdir(f.records)).length > 0);
  assert.ok(cachePath(f.manifest.libraryId).startsWith(f.library));
  assert.equal(f.records.startsWith(f.library), false);
});

test("a device home inside the source cannot issue or consume records", { skip: !native }, async t => {
  const f = await fixture(t);
  const nested = join(f.library, "nested-device");
  await fs.cp(f.home, nested, { recursive: true });
  process.env.EINZBERN_HOME = nested;
  provider(t);
  const result = await read(f);
  assert.equal(hits(result.observation), 0);
  assert.ok(result.observation.logicalEventBytes > 0);
});

for (const field of ["boot", "mount", "volume", "generation", "deviceIdentity", "engineVersion", "projection", "library", "source", "coverage"]) {
  test(`a prior record with wrong ${field} falls back`, { skip: !native }, async t => {
    const f = await fixture(t);
    provider(t);
    await warm(f);
    await editRecord(f, record => {
      if (["boot", "mount", "volume"].includes(field)) record.native[field] = "different-identity";
      else if (field === "generation") record.native.generation += 1;
      else if (field === "library") record.binding.libraryId = "library:" + "f".repeat(24);
      else if (field === "source") record.binding.sourceId = "library:" + "f".repeat(24);
      else if (field === "coverage") record.coverage += 1;
      else record[field] = "different-version";
    });
    const result = await read(f);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  });
}

for (const kind of ["record-missing", "record-damaged", "cache-missing", "cache-damaged"]) {
  test(`${kind} cannot authorize reuse`, { skip: !native }, async t => {
    const f = await fixture(t);
    provider(t);
    await warm(f);
    const directory = kind.startsWith("record") ? f.records : f.cache;
    const path = join(directory, (await fs.readdir(directory))[0]);
    if (kind.endsWith("missing")) await fs.unlink(path);
    else await fs.writeFile(path, "broken record/cache\n");
    const result = await read(f);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  });
}

test("a coherent shared projection cannot replace the independent local digest", { skip: !native }, async t => {
  const f = await fixture(t);
  provider(t);
  await warm(f);
  const path = join(f.cache, (await fs.readdir(f.cache)).find(name => name.endsWith(".bin")));
  const events = JSON.parse(gunzipSync(await fs.readFile(path)).toString("utf8"));
  events[0].payload = { ...events[0].payload, forgedProjection: "shared writer" };
  await fs.writeFile(path, gzipSync(JSON.stringify(events)));
  const result = await read(f);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

for (const kind of ["zero-generation", "unsupported-attributes", "network-volume", "incomplete-download", "provider-unknown", "helper-failure", "helper-timeout"]) {
  test(`${kind} preserves the full reader`, { skip: !native }, async t => {
    const f = await fixture(t);
    provider(t, value => {
      for (const file of value.files) {
        if (kind === "zero-generation") { const bytes = Buffer.from(file.file.bytes, "base64"); bytes.writeUInt32LE(0, 40); file.file.bytes = bytes.toString("base64"); }
        if (kind === "unsupported-attributes") { const bytes = Buffer.from(file.volume.bytes, "base64"); bytes.writeUInt32LE(0, 92); file.volume.bytes = bytes.toString("base64"); }
        if (kind === "network-volume") { const bytes = Buffer.from(file.volume.bytes, "base64"); bytes.writeUInt32LE(0, 32); file.volume.bytes = bytes.toString("base64"); }
        if (kind === "incomplete-download") file.resources.NSURLUbiquitousItemIsDownloadingKey = true;
        if (kind === "provider-unknown") file.resources = {};
      }
    });
    if (kind.startsWith("helper-")) {
      t.mock.method(childProcess, "spawnSync", () => ({ status: kind === "helper-failure" ? 1 : null, stdout: "", stderr: "", error: kind === "helper-timeout" ? Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) : undefined }));
      syncBuiltinESMExports();
    }
    const result = await read(f);
    assert.equal(hits(result.observation), 0);
    assert.ok(result.observation.logicalEventBytes > 0);
    assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
  });
}

test("an unavailable helper resource preserves the full reader", { skip: !native }, async t => {
  const f = await fixture(t);
  const original = fs.readFile;
  t.mock.method(fs, "readFile", (path, ...arguments_) => {
    if (String(path).endsWith("/darwin-source-identity.mjs")) return Promise.reject(Object.assign(new Error("missing helper"), { code: "ENOENT" }));
    return original(path, ...arguments_);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await read(f);
  assert.equal(hits(result.observation), 0);
  assert.ok(result.observation.logicalEventBytes > 0);
  assert.deepEqual(result.value, await materializeWorkspaceFromGenesis(f.library));
});

for (const kind of ["in-place", "same-name-replacement", "rename", "hardlink", "concurrent-after-query"]) {
  test(`${kind} after verification cannot conceal corruption`, { skip: !native }, async t => {
    const f = await fixture(t);
    let mutate = false;
    const changed = await corrupt(f);
    provider(t, (value, queries, request) => {
      if (mutate && kind === "concurrent-after-query" && request.files.some(file => file.path === f.target)) {
        writeFileSync(f.target, changed);
        mutate = false;
      }
    });
    await warm(f);
    if (kind === "in-place") { const before = await fs.stat(f.target); await fs.writeFile(f.target, changed); await fs.utimes(f.target, before.atime, before.mtime); }
    if (kind === "same-name-replacement") { const path = join(f.root, "replacement"); await fs.writeFile(path, changed); await fs.rename(path, f.target); }
    if (kind === "rename") { await fs.rename(f.target, join(f.root, "original")); await fs.writeFile(f.target, changed); }
    if (kind === "hardlink") await fs.link(f.target, join(f.root, "second-name"));
    if (kind === "concurrent-after-query") mutate = true;
    await assert.rejects(materializeLibrary(f.library));
    await assert.rejects(materializeWorkspaceFromGenesis(f.library));
  });
}
