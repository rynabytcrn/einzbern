// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R2, R3 and STORY-469 R5, AC3: each device appends to its own stream in
// the library, the stream manifest commits the append, and a reader trusts only the manifest.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  appendStreamEvents,
  appendToOwnStream,
  buildStreamEvents,
  clockHighWater,
  createLibrary,
  emptyStreamManifest,
  listStreamDevices,
  readStreamEvents,
  readStreamManifest,
  segmentName,
  streamDirectory,
  withLibraryWriteLock,
} from "../dist/build/packages/core/src/index.js";
import { deriveEventId, deriveStreamId } from "../dist/build/packages/protocol/src/index.js";

const DEVICE_A = { deviceId: "a".repeat(32), displayName: "desk" };
const DEVICE_B = { deviceId: "b".repeat(32), displayName: "laptop" };
const drafts = (count, from = 0) => Array.from({ length: count }, (_, index) => ({
  occurredAt: `2026-09-26T00:${String(Math.floor((from + index) / 60) % 60).padStart(2, "0")}:${String((from + index) % 60).padStart(2, "0")}Z`,
  payload: { operation: "test.noted", index: from + index },
}));

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "einzbern-akasha-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "device-home");
  const library = await createLibrary(join(base, ".ether"), { createdAt: "2026-09-26T00:00:00Z" });
  return { base, home, library };
}

async function treeDigest(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else entries.push(`${relative(root, path)}:${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  }
  await walk(root);
  return entries.sort().join("\n");
}

test("468-R2: a device appends to akasha/<device id>/ and the stream reads back exactly", async (t) => {
  const { home, library } = await fixture(t);
  const { manifest, events } = await appendToOwnStream(library, DEVICE_A, drafts(3), { home });
  assert.deepEqual(await listStreamDevices(library.root), [DEVICE_A.deviceId]);
  assert.deepEqual((await readdir(streamDirectory(library.root, DEVICE_A.deviceId))).sort(), ["00000001.ndjson", "manifest.json"]);
  assert.equal(manifest.streamId, deriveStreamId(library.manifest.libraryId, DEVICE_A.deviceId));
  assert.equal(manifest.identityScheme, "einzbern");
  assert.deepEqual([manifest.sequence, manifest.clockHighWater, manifest.headEventHash], [3, 3, events[2].eventHash]);
  assert.deepEqual(events.map((event) => [event.sequence, event.clock, event.deviceId, event.id]),
    [1, 2, 3].map((sequence) => [sequence, sequence, DEVICE_A.deviceId, deriveEventId(manifest.streamId, sequence)]));
  assert.deepEqual(await readStreamManifest(library.root, DEVICE_A.deviceId), manifest);
  assert.deepEqual(await readStreamEvents(library.root, manifest), events);
  const more = await appendToOwnStream(library, DEVICE_A, drafts(2, 3), { home });
  assert.equal(more.events[0].priorHash, events[2].eventHash, "the stream continues from its head");
  assert.deepEqual((await readStreamEvents(library.root, more.manifest)).map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test("468-R2, 469-R6: segments roll at storage.segmentBytes and are named by lowercase hex ordinals", async (t) => {
  const { home, library } = await fixture(t);
  let manifest;
  for (let round = 0; round < 12; round += 1) ({ manifest } = await appendToOwnStream(library, DEVICE_A, drafts(3, round * 3), { home, segmentBytes: 700 }));
  const names = manifest.segments.map((segment) => segment.name);
  assert.ok(names.length >= 11, `enough segments to pass nine: ${names.length}`);
  assert.deepEqual(names, names.map((_, index) => segmentName(index + 1)));
  assert.ok(names.includes("0000000a.ndjson"), "the tenth segment is 0000000a, not 00000010");
  assert.ok(manifest.segments.every((segment, index) => index === 0 || segment.firstSequence === manifest.segments[index - 1].lastSequence + 1));
  assert.equal((await readStreamEvents(library.root, manifest)).length, 36);
  for (const segment of manifest.segments) assert.equal((await stat(join(streamDirectory(library.root, DEVICE_A.deviceId), segment.name))).size, segment.bytes);
});

test("469-AC3: a crash after the segment write and before the manifest leaves the previous stream readable and its tail unread", async (t) => {
  const { home, library } = await fixture(t);
  const first = await appendToOwnStream(library, DEVICE_A, drafts(2), { home });
  const segmentPath = join(streamDirectory(library.root, DEVICE_A.deviceId), "00000001.ndjson");
  const committedBytes = (await stat(segmentPath)).size;
  await assert.rejects(appendToOwnStream(library, DEVICE_A, drafts(2, 2), { home, crashAt: "after-segment-write" }),
    (error) => error?.reasonCode === "AKASHA_WRITE_INTERRUPTED");
  assert.ok((await stat(segmentPath)).size > committedBytes, "the dead writer's bytes are on disk");
  const manifest = await readStreamManifest(library.root, DEVICE_A.deviceId);
  assert.deepEqual(manifest, first.manifest, "the manifest is still the previous one");
  assert.deepEqual(await readStreamEvents(library.root, manifest), first.events, "and only its events are read");
  // The next write cuts the uncommitted tail off and continues the sequence.
  const next = await appendToOwnStream(library, DEVICE_A, drafts(1, 9), { home });
  assert.deepEqual(next.events.map((event) => event.sequence), [3]);
  assert.equal(next.events[0].payload.index, 9, "the interrupted events were never committed");
  assert.deepEqual((await readStreamEvents(library.root, next.manifest)).map((event) => event.payload.index), [0, 1, 9]);
  // A segment file the manifest does not name is never read.
  await writeFile(join(streamDirectory(library.root, DEVICE_A.deviceId), "00000009.ndjson"), "not an event\n");
  assert.equal((await readStreamEvents(library.root, next.manifest)).length, 3);
});

test("468-R2: a device writes only its own directory; another device's stream is byte-identical before and after", async (t) => {
  const { home, library } = await fixture(t);
  await appendToOwnStream(library, DEVICE_B, drafts(4), { home: join(home, "other-machine") });
  const before = await treeDigest(streamDirectory(library.root, DEVICE_B.deviceId));
  await appendToOwnStream(library, DEVICE_A, drafts(5), { home });
  await appendToOwnStream(library, DEVICE_A, drafts(5, 5), { home });
  assert.equal(await treeDigest(streamDirectory(library.root, DEVICE_B.deviceId)), before);
  assert.deepEqual(await listStreamDevices(library.root), [DEVICE_A.deviceId, DEVICE_B.deviceId]);
});

test("468-R3: a new event's clock is one above the largest clock this machine has seen", async (t) => {
  const { home, library } = await fixture(t);
  await appendToOwnStream(library, DEVICE_B, drafts(50), { home });
  assert.equal(await clockHighWater(library.root), 50);
  const { events } = await appendToOwnStream(library, DEVICE_A, drafts(2), { home });
  assert.deepEqual(events.map((event) => [event.sequence, event.clock]), [[1, 51], [2, 52]]);
  // A pure build from a manifest and a clock base gives the same answer the append used.
  const manifest = emptyStreamManifest(library, DEVICE_A);
  assert.deepEqual(buildStreamEvents(manifest, drafts(1), 7).map((event) => event.clock), [8]);
});

test("468-R2: an append that does not continue the stream is refused before any byte is written", async (t) => {
  const { home, library } = await fixture(t);
  const { manifest, events } = await appendToOwnStream(library, DEVICE_A, drafts(2), { home });
  const digest = await treeDigest(library.root);
  await assert.rejects(withLibraryWriteLock(library, () => appendStreamEvents(library, manifest, events), { home }),
    (error) => error?.reasonCode === "AKASHA_INPUT_INVALID");
  assert.equal(await treeDigest(library.root), digest);
});

test("468-R2: two processes of one device append concurrently and the sequence stays whole", async (t) => {
  const { home, library } = await fixture(t);
  const core = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;
  const writer = (label) => new Promise((resolve, reject) => {
    const script = `const m = await import(${JSON.stringify(core)});
const library = await m.openLibrary(${JSON.stringify(library.root)});
for (let index = 0; index < 20; index += 1) {
  await m.appendToOwnStream(library, ${JSON.stringify(DEVICE_A)}, [{ occurredAt: "2026-09-26T01:00:00Z", payload: { operation: "test.noted", writer: ${JSON.stringify(label)}, index } }], { home: ${JSON.stringify(home)} });
}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${stderr}`))));
  });
  await Promise.all([writer("one"), writer("two")]);
  const manifest = await readStreamManifest(library.root, DEVICE_A.deviceId);
  const events = await readStreamEvents(library.root, manifest);
  assert.equal(manifest.sequence, 40);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
  for (const label of ["one", "two"]) {
    assert.deepEqual(events.filter((event) => event.payload.writer === label).map((event) => event.payload.index), Array.from({ length: 20 }, (_, index) => index), `${label} lost nothing`);
  }
});

test("469-R5: a damaged stream manifest or segment fails closed with the device and segment named", async (t) => {
  const { home, library } = await fixture(t);
  const { manifest } = await appendToOwnStream(library, DEVICE_A, drafts(3), { home });
  const directory = streamDirectory(library.root, DEVICE_A.deviceId);
  const segmentPath = join(directory, "00000001.ndjson");
  const original = await readFile(segmentPath, "utf8");
  await writeFile(segmentPath, original.replace("\"index\":1", "\"index\":7"));
  await assert.rejects(readStreamEvents(library.root, manifest), (error) => error?.reasonCode === "AKASHA_SEGMENT_CORRUPT" && error.details.deviceId === DEVICE_A.deviceId && error.details.segment === "00000001.ndjson");
  await writeFile(segmentPath, original);
  const manifestPath = join(directory, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifestText.replace("\"sequence\":3", "\"sequence\":4"));
  await assert.rejects(readStreamManifest(library.root, DEVICE_A.deviceId), (error) => error?.reasonCode === "AKASHA_STREAM_MANIFEST_INVALID" && error.details.deviceId === DEVICE_A.deviceId);
});
