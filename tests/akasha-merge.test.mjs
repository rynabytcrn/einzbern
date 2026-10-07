// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R3-R5, AC1-AC3, AC5 and STORY-470 R4: two devices write one library
// apart and merge to the same state; a transition both made is applied once and rejected once;
// a key both took is renamed with an alias; a read a sync placeholder blocks times out.

// The merged reads cache their derived state in the test's own device directory.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendToOwnStream,
  createLibrary,
  createWorkDelta,
  materializeLibrary,
  openLibrary,
  readAllStreams,
  recordAliases,
  streamDirectory,
  transitionWorkDelta,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, createEvent, deriveStableId, eventInputOf } from "../dist/build/packages/protocol/src/index.js";

const A = { deviceId: "a".repeat(32), displayName: "desk" };
const B = { deviceId: "b".repeat(32), displayName: "laptop" };
let tick = 0;
const at = () => {
  tick += 1;
  return new Date(Date.UTC(2026, 8, 26, 0, 0, tick)).toISOString().replace(".000Z", "Z");
};

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), "einzbern-merge-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const library = await createLibrary(join(base, "desk", ".ether"), { createdAt: "2026-09-26T00:00:00Z", projectName: "Merge" });
  return { base, library, homes: { [A.deviceId]: join(base, "home-desk"), [B.deviceId]: join(base, "home-laptop") } };
}

/** The laptop's copy of the library as it was when it last synced. */
async function offlineCopy(base, library) {
  const root = join(base, "laptop", ".ether");
  await cp(library.root, root, { recursive: true });
  return openLibrary(root);
}

/** A sync client carrying each device's own stream to the other copy. */
async function sync(desk, laptop) {
  for (const [from, to, device] of [[desk, laptop, A], [laptop, desk, B]]) {
    const source = streamDirectory(from.root, device.deviceId);
    const target = streamDirectory(to.root, device.deviceId);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true }).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** One write on one device: read its merged state, build the change against it, append it to its own stream. */
async function write(context, library, device, build) {
  const state = await materializeLibrary(library);
  const occurredAt = at();
  const delta = build(state, occurredAt);
  const { events } = await appendToOwnStream(library, device, [{ occurredAt, payload: delta.payload }], { home: context.homes[device.deviceId] });
  return events[0];
}

const createProject = (key) => (_state, occurredAt) => ({
  payload: {
    operation: "project.created",
    record: { schemaVersion: "tcrn.project.v1", id: deriveStableId("project", key), externalKey: key, name: key, revision: 1, updatedAt: occurredAt, tombstone: false },
  },
});
const createInitiative = (projectKey, key, status = "planned") => (state, occurredAt) => createWorkDelta({
  projectId: deriveStableId("project", projectKey), externalKey: key, kind: "Initiative", parentId: null, status, occurredAt,
})(state);
const finish = (key, summary) => (state, occurredAt) => transitionWorkDelta({ id: deriveStableId("work", key), status: "done", summary, occurredAt })(state);

const graphDigest = (state) => canonicalSha256({ projects: state.projects, work: state.work });

test("468-AC1: two devices append 100 events each apart; after sync either merges to the same order, state and version vector", async (t) => {
  const context = await setup(t);
  const desk = context.library;
  const laptop = await offlineCopy(context.base, desk);
  await write(context, desk, A, createProject("DESK"));
  await write(context, laptop, B, createProject("LAPTOP"));
  for (let index = 1; index < 100; index += 1) {
    await write(context, desk, A, createInitiative("DESK", `DESK-INITIATIVE-${index}`));
    await write(context, laptop, B, createInitiative("LAPTOP", `LAPTOP-INITIATIVE-${index}`));
  }
  await sync(desk, laptop);
  const onDesk = await materializeLibrary(desk);
  const onLaptop = await materializeLibrary(laptop);
  assert.deepEqual(onDesk.events.map((event) => event.id), onLaptop.events.map((event) => event.id), "the same merge order");
  assert.equal(graphDigest(onDesk), graphDigest(onLaptop), "the same state");
  assert.equal(onDesk.headEventHash, onLaptop.headEventHash);
  assert.deepEqual(onDesk.library.versionVector, { [A.deviceId]: 100, [B.deviceId]: 100 });
  assert.deepEqual(onLaptop.library.versionVector, { [A.deviceId]: 100, [B.deviceId]: 100 });
  assert.equal(onDesk.version, 200);
  assert.equal(onDesk.work.length, 198);
  assert.deepEqual(onDesk.library.rejectedEvents, []);
  // Both wrote apart, so their clocks overlap: equal clocks fall back to the device id.
  const clocks = onDesk.events.map((event) => [event.clock, event.deviceId]);
  assert.deepEqual(clocks.slice(0, 4), [[1, A.deviceId], [1, B.deviceId], [2, A.deviceId], [2, B.deviceId]]);
});

test("469-D7: the root manifest stays static across device appends, and discovered streams validate their segment digests", async (t) => {
  const context = await setup(t);
  const desk = context.library;
  const laptop = await offlineCopy(context.base, desk);
  const rootManifestPath = join(desk.root, "manifest.json");
  const rootManifestBytes = await readFile(rootManifestPath, "utf8");
  const rootManifest = JSON.parse(rootManifestBytes);

  assert.deepEqual(Object.keys(rootManifest).sort(), ["createdAt", "formatVersion", "libraryId", "minEngineVersion", "project", "schemaVersion"]);
  await write(context, desk, A, createProject("ROOT-MANIFEST-DESK"));
  await write(context, laptop, B, createProject("ROOT-MANIFEST-LAPTOP"));
  await sync(desk, laptop);

  for (const copy of [desk, laptop]) {
    assert.equal(await readFile(join(copy.root, "manifest.json"), "utf8"), rootManifestBytes,
      "ordinary event appends and stream merge do not rewrite the root manifest");
  }

  const discovered = await readAllStreams(desk.root);
  assert.deepEqual(discovered.streams.map((stream) => stream.deviceId).sort(), [A.deviceId, B.deviceId]);
  for (const stream of discovered.streams) {
    assert.ok(stream.manifest, "the discovered device has a committed stream manifest");
    assert.equal(stream.manifest.segments.length, 1);
    assert.match(stream.manifest.segments[0].sha256, /^[a-f0-9]{64}$/u);
  }

  const laptopManifestPath = join(streamDirectory(desk.root, B.deviceId), "manifest.json");
  const laptopManifest = JSON.parse(await readFile(laptopManifestPath, "utf8"));
  laptopManifest.segments[0].sha256 = "0".repeat(64);
  await writeFile(laptopManifestPath, canonicalJson(laptopManifest));
  await assert.rejects(readAllStreams(desk.root), (error) => {
    assert.equal(error.reasonCode, "AKASHA_SEGMENT_CORRUPT");
    assert.equal(error.details.deviceId, B.deviceId);
    assert.equal(error.details.segment, laptopManifest.segments[0].name);
    return true;
  }, "a reader validates the on-disk digest after discovering the device stream");
});

test("468-AC2: both devices move the same item to done; the earlier clock wins and the later is a rejected event", async (t) => {
  const context = await setup(t);
  const desk = context.library;
  await write(context, desk, A, createProject("SHARED"));
  await write(context, desk, A, createInitiative("SHARED", "SHARED-STORY-1", "active"));
  const laptop = await offlineCopy(context.base, desk);
  // Apart: the desk finishes it at clock 3; the laptop writes something else first, then finishes it at clock 4.
  const deskDone = await write(context, desk, A, finish("SHARED-STORY-1", "done on the desk"));
  await write(context, laptop, B, createInitiative("SHARED", "SHARED-OTHER"));
  const laptopDone = await write(context, laptop, B, finish("SHARED-STORY-1", "done on the laptop"));
  assert.deepEqual([deskDone.clock, laptopDone.clock], [3, 4]);
  await sync(desk, laptop);
  for (const library of [desk, laptop]) {
    const state = await materializeLibrary(library);
    const item = state.work.find((record) => record.externalKey === "SHARED-STORY-1");
    assert.equal(item.status, "done");
    assert.equal(item.summary, "done on the desk", "the earlier clock is the one that applies");
    assert.equal(state.library.rejectedEvents.length, 1);
    const [rejected] = state.library.rejectedEvents;
    assert.deepEqual(
      [rejected.eventId, rejected.deviceId, rejected.sequence, rejected.clock, rejected.operation, rejected.recordId, rejected.reasonCode],
      [laptopDone.id, B.deviceId, 2, 4, "work.updated", deriveStableId("work", "SHARED-STORY-1"), "WORKSPACE_EVENT_CORRUPT"],
    );
    assert.equal(state.version, 5, "a rejected event is still counted: it is in a stream");
    assert.ok(state.work.some((record) => record.externalKey === "SHARED-OTHER"), "the laptop's other write applies");
  }
});

test("468-AC3: both devices take the same key apart; the later is renamed to the next free key with an alias, and its own later events follow", async (t) => {
  const context = await setup(t);
  const desk = context.library;
  await write(context, desk, A, createProject("KEYS"));
  const laptop = await offlineCopy(context.base, desk);
  await write(context, desk, A, createInitiative("KEYS", "KEYS-STORY-500"));
  await write(context, laptop, B, createInitiative("KEYS", "KEYS-FIRST"));
  await write(context, laptop, B, createInitiative("KEYS", "KEYS-STORY-500"));
  await write(context, laptop, B, (state, occurredAt) => transitionWorkDelta({ id: deriveStableId("work", "KEYS-STORY-500"), status: "ready", occurredAt })(state));
  await sync(desk, laptop);
  const results = [];
  for (const library of [desk, laptop]) {
    const state = await materializeLibrary(library);
    const original = state.work.find((record) => record.externalKey === "KEYS-STORY-500");
    const renamed = state.work.find((record) => record.externalKey === "KEYS-STORY-501");
    assert.ok(original && renamed, "both records exist");
    assert.equal(original.id, deriveStableId("work", "KEYS-STORY-500"));
    assert.equal(renamed.id, deriveStableId("work", "KEYS-STORY-501"));
    assert.equal(original.status, "planned", "the desk's record is untouched");
    assert.equal(renamed.status, "ready", "the laptop's later transition followed its renamed record");
    assert.deepEqual(state.library.aliases, [{
      kind: "work",
      externalKey: "KEYS-STORY-500",
      id: original.id,
      aliasExternalKey: "KEYS-STORY-501",
      aliasId: renamed.id,
      deviceId: B.deviceId,
      streamId: state.library.streams.find((stream) => stream.deviceId === B.deviceId).streamId,
      sequence: 2,
    }]);
    // Looking up the old key finds the record that holds it and where the other one went.
    assert.deepEqual(recordAliases(state, original.id).aliasedBy.map((entry) => entry.aliasExternalKey), ["KEYS-STORY-501"]);
    assert.deepEqual(recordAliases(state, renamed.id).aliases.map((entry) => entry.externalKey), ["KEYS-STORY-500"]);
    assert.deepEqual(state.library.rejectedEvents, []);
    results.push(canonicalJson({ graph: graphDigest(state), aliases: state.library.aliases }));
  }
  assert.equal(results[0], results[1], "both devices rename the same way");
});

test("468-AC5 / 470-R4: a read that a sync placeholder blocks times out with a reason code instead of hanging", async (t) => {
  const context = await setup(t);
  await write(context, context.library, A, createProject("SLOW"));
  const blocked = (path) => (path.endsWith(".ndjson") ? new Promise(() => {}) : readFile(path));
  const started = Date.now();
  await assert.rejects(readAllStreams(context.library.root, { timeoutMs: 100, readFile: blocked }), (error) => {
    assert.equal(error.reasonCode, "AKASHA_READ_TIMEOUT");
    assert.equal(error.details.deviceId, A.deviceId);
    assert.equal(error.details.file, `${A.deviceId}/00000001.ndjson`);
    return true;
  });
  assert.ok(Date.now() - started < 5000, "it returned promptly");
  await assert.rejects(materializeLibrary(context.library, { timeoutMs: 100, readFile: blocked }), (error) => error.reasonCode === "AKASHA_READ_TIMEOUT");
});

test("468: a forged event, even with its segment digest rewritten, fails closed naming the device, stream and sequence", async (t) => {
  const context = await setup(t);
  const desk = context.library;
  await write(context, desk, A, createProject("FORGE"));
  await write(context, desk, A, createInitiative("FORGE", "FORGE-1"));
  await write(context, desk, A, createInitiative("FORGE", "FORGE-2"));
  const directory = streamDirectory(desk.root, A.deviceId);
  const segment = join(directory, "00000001.ndjson");
  const lines = (await readFile(segment, "utf8")).split("\n").slice(0, -1).map((line) => JSON.parse(line));
  // The forger changes the second event and rebuilds its own hashes, but not the next event's priorHash.
  lines[1].payload.record.title = "Forged";
  Object.assign(lines[1], createEvent(eventInputOf(lines[1]), lines[1].schemaVersion));
  const forged = lines.map((line) => canonicalJson(line)).join("");
  await writeFile(segment, forged);
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.segments[0].bytes = Buffer.byteLength(forged);
  manifest.segments[0].sha256 = (await import("node:crypto")).createHash("sha256").update(forged).digest("hex");
  await writeFile(manifestPath, canonicalJson(manifest));
  await assert.rejects(readAllStreams(desk.root), (error) => {
    assert.equal(error.reasonCode, "AKASHA_EVENT_CORRUPT");
    assert.equal(error.details.deviceId, A.deviceId);
    assert.equal(error.details.sequence, "3");
    assert.equal(error.details.break, "priorHash");
    return true;
  });
});

test("ordinary stream reads do not schedule a product timeout and retain all hydrated data", async (t) => {
  const context = await setup(t);
  await write(context, context.library, A, createProject("HYDRATED"));
  const scheduled = [];
  const original = globalThis.setTimeout;
  let release;
  const hydration = new Promise((resolve) => { release = resolve; });
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  globalThis.setTimeout = (...args) => { scheduled.push(args[1]); return original(...args); };
  try {
    const reading = readAllStreams(context.library.root, { readFile: async (path) => {
      if (path.endsWith(".ndjson")) { entered(); await hydration; }
      return readFile(path);
    }});
    await reached;
    assert.deepEqual(scheduled, [], "omission does not become a thirty-second timer");
    release();
    const read = await reading;
    assert.ok(read.events.length > 0);
    assert.deepEqual(read, await readAllStreams(context.library.root));
  } finally { release(); globalThis.setTimeout = original; }
});
