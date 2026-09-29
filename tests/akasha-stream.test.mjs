// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R2, R3 and STORY-469 R5, AC3: each device appends to its own stream in
// the library, the stream manifest commits the append, and a reader trusts only the manifest.
// TCRN-CROSS-STORY-512 R1, R2 (TCRN-CROSS-INC-396): a read that meets another writer's atomic
// replacement of a manifest reads one whole version, and linked or special files are still refused.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises, { link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  readAllStreams,
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

test("469-R5, 467-AC3: a damaged stream manifest or segment fails closed with the device, segment and sequence named", async (t) => {
  const { home, library } = await fixture(t);
  const { manifest } = await appendToOwnStream(library, DEVICE_A, drafts(3), { home });
  const directory = streamDirectory(library.root, DEVICE_A.deviceId);
  const segmentPath = join(directory, "00000001.ndjson");
  const original = await readFile(segmentPath, "utf8");
  // A byte changed in place is reported where the stream stops being provable.
  await writeFile(segmentPath, original.replace("\"index\":1", "\"index\":7"));
  await assert.rejects(readStreamEvents(library.root, manifest), (error) => error?.reasonCode === "AKASHA_EVENT_CORRUPT" &&
    error.details.deviceId === DEVICE_A.deviceId && error.details.sequence === "2" && error.details.break === "payloadHash" && error.details.segment === "00000001.ndjson");
  // A recorded digest that is wrong while every event checks out is reported against the segment.
  await writeFile(segmentPath, original);
  await assert.rejects(readStreamEvents(library.root, { ...manifest, segments: [{ ...manifest.segments[0], sha256: "0".repeat(64) }] }),
    (error) => error?.reasonCode === "AKASHA_SEGMENT_CORRUPT" && error.details.deviceId === DEVICE_A.deviceId && error.details.segment === "00000001.ndjson");
  const manifestPath = join(directory, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifestText.replace("\"sequence\":3", "\"sequence\":4"));
  await assert.rejects(readStreamManifest(library.root, DEVICE_A.deviceId), (error) => error?.reasonCode === "AKASHA_STREAM_MANIFEST_INVALID" && error.details.deviceId === DEVICE_A.deviceId);
});

// TCRN-CROSS-STORY-512 R1, R2 (TCRN-CROSS-INC-396). A device replaces its stream manifest by
// renaming a finished temporary file over it, and a reader of that stream may be anywhere in its
// own steps when the rename lands. These tests put the rename at each of those steps and read
// another device's stream the two ways the engine does.

const openFile = fsPromises.open;
const OTHER_MACHINE = "other-machine";

// Slips a step in between two of the reader's own file system calls. The replacements are pushed
// into the ESM live bindings, so akasha's `import { lstat, open } from "node:fs/promises"` reaches
// them, and the originals are put back however the read ends.
async function interleaved(replacements, operation) {
  const originals = Object.fromEntries(Object.keys(replacements).map((name) => [name, fsPromises[name]]));
  for (const [name, replacement] of Object.entries(replacements)) fsPromises[name] = replacement(originals[name]);
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    Object.assign(fsPromises, originals);
    syncBuiltinESMExports();
  }
}

// A library this device (A) and another device (B) have written, with B's next append ready: it
// replaces B's stream manifest, the file the reader under test is reading.
async function otherStreamAboutToBeReplaced(t) {
  const { base, home, library } = await fixture(t);
  const otherHome = join(home, OTHER_MACHINE);
  await appendToOwnStream(library, DEVICE_A, drafts(2), { home });
  const before = await appendToOwnStream(library, DEVICE_B, drafts(3), { home: otherHome });
  const directory = streamDirectory(library.root, DEVICE_B.deviceId);
  const stream = {
    base,
    library,
    before,
    after: null,
    landed: false,
    manifestPath: join(directory, "manifest.json"),
    segmentPath: join(directory, "00000001.ndjson"),
    // B's writer runs once, from the first call of the window under test; its own reads pass through.
    async land() {
      stream.landed = true;
      stream.after = await appendToOwnStream(library, DEVICE_B, drafts(2, 3), { home: otherHome });
    },
  };
  return stream;
}

// The two ways the engine reads another device's stream: its manifest and then the segments that
// manifest names, or every stream of the library at once, as materialize and each chain write do.
const OTHER_STREAM_READS = Object.freeze({
  async readStreamManifest(library) {
    const manifest = await readStreamManifest(library.root, DEVICE_B.deviceId);
    return { manifest, events: await readStreamEvents(library.root, manifest) };
  },
  async readAllStreams(library) {
    const read = await readAllStreams(library.root);
    const other = read.streams.find((entry) => entry.deviceId === DEVICE_B.deviceId);
    assert.equal(read.versionVector[DEVICE_B.deviceId], other.manifest.sequence);
    return { manifest: other.manifest, events: other.events };
  },
});

// Where B's rename lands in the reader's steps, and which version the reader then holds.
const REPLACEMENT_WINDOWS = Object.freeze([
  {
    when: "between the reader's open and its stat",
    reads: "before",
    // The reader's open reached the old manifest; the rename takes its last link before the stat.
    replacements: (stream) => ({
      open: (open) => async (target, ...rest) => {
        const handle = await open(target, ...rest);
        if (target === stream.manifestPath && !stream.landed) await stream.land();
        return handle;
      },
    }),
  },
  {
    when: "between the reader's lstat and its open",
    reads: "after",
    // The reader's lstat saw the old manifest; its open finds the new one.
    replacements: (stream) => ({
      lstat: (lstatFile) => async (target, ...rest) => {
        const info = await lstatFile(target, ...rest);
        if (target === stream.manifestPath && !stream.landed) await stream.land();
        return info;
      },
    }),
  },
  {
    when: "inside the reader's lstat",
    reads: "after",
    // The lstat looked the name up while it led to the old manifest and took the file's attributes
    // after the rename: a regular file with no link left.
    replacements: (stream) => ({
      lstat: (lstatFile) => async (target, ...rest) => {
        if (target !== stream.manifestPath || stream.landed) return lstatFile(target, ...rest);
        const looked = await openFile(target, "r");
        try {
          await stream.land();
          const info = await looked.stat();
          assert.equal(info.nlink, 0, "the file the name led to has no link left");
          return info;
        } finally {
          await looked.close();
        }
      },
    }),
  },
]);

for (const window of REPLACEMENT_WINDOWS) {
  for (const [way, readOther] of Object.entries(OTHER_STREAM_READS)) {
    test(`512-R1: another device's manifest replaced ${window.when} reads whole, as it was ${window.reads} the replacement (${way})`, async (t) => {
      const stream = await otherStreamAboutToBeReplaced(t);
      const read = await interleaved(window.replacements(stream), () => readOther(stream.library));
      assert.equal(stream.landed, true, "the rename landed inside the window under test");
      const { before, after } = stream;
      assert.deepEqual(read.manifest, window.reads === "before" ? before.manifest : after.manifest);
      assert.deepEqual(read.events, window.reads === "before" ? before.events : [...before.events, ...after.events],
        "the segments it names read back to its head");
      // The replacement itself committed: the name leads to the newer manifest, with one link.
      assert.deepEqual(await readStreamManifest(stream.library.root, DEVICE_B.deviceId), after.manifest);
      assert.equal((await lstat(stream.manifestPath)).nlink, 1);
    });
  }
}

test("512-R1: while another device's process appends, every read of its stream and every own append here goes through", async (t) => {
  const { home, library } = await fixture(t);
  const otherHome = join(home, OTHER_MACHINE);
  await appendToOwnStream(library, DEVICE_A, drafts(1), { home });
  await appendToOwnStream(library, DEVICE_B, drafts(1), { home: otherHome });
  const appends = 120;
  const core = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(core)});
const library = await m.openLibrary(${JSON.stringify(library.root)});
for (let index = 1; index <= ${appends}; index += 1) {
  await m.appendToOwnStream(library, ${JSON.stringify(DEVICE_B)}, [{ occurredAt: "2026-09-29T01:00:00Z", payload: { operation: "test.noted", index } }], { home: ${JSON.stringify(otherHome)} });
}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let writing = true;
  const written = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      writing = false;
      if (code === 0) resolve();
      else reject(new Error(`the other device's writer exited ${code}: ${stderr}`));
    });
  });
  const refused = [];
  let reads = 0;
  let ownAppends = 0;
  // Each read resolves the other device's manifest after the previous one did, so it never goes back.
  const reader = async () => {
    let seen = 0;
    while (writing) {
      try {
        const other = (await readAllStreams(library.root)).streams.find((entry) => entry.deviceId === DEVICE_B.deviceId);
        if (other.events.length !== other.manifest.sequence || other.manifest.sequence < seen) {
          refused.push(`read ${other.manifest.sequence} with ${other.events.length} events after ${seen}`);
        }
        seen = other.manifest.sequence;
        reads += 1;
      } catch (error) {
        refused.push(`read: ${error?.reasonCode ?? error}`);
      }
    }
  };
  // An own append reads every manifest for its clock, the other device's included.
  const ownWriter = async () => {
    while (writing) {
      try {
        await appendToOwnStream(library, DEVICE_A, drafts(1, ownAppends + 1), { home });
        ownAppends += 1;
      } catch (error) {
        refused.push(`own append: ${error?.reasonCode ?? error}`);
      }
    }
  };
  await Promise.all([written, reader(), reader(), ownWriter()]);
  assert.deepEqual(refused, [], "no read was refused or inconsistent and no own append was refused");
  assert.ok(reads > 0 && ownAppends > 0, `reads ${reads}, own appends ${ownAppends}`);
  const final = await readAllStreams(library.root);
  assert.deepEqual(final.versionVector, { [DEVICE_A.deviceId]: 1 + ownAppends, [DEVICE_B.deviceId]: 1 + appends });
});

async function createFifo(path) {
  if (process.platform === "win32") return { supported: false, reason: "FIFO paths are unsupported on Windows" };
  const child = spawn("mkfifo", [path], { stdio: "ignore" });
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ supported: false, reason: `mkfifo unavailable: ${error.code ?? error.message}` }));
    child.once("exit", (code) => resolve(code === 0 ? { supported: true } : { supported: false, reason: `mkfifo exited ${code}` }));
  });
}

// Moves the manifest aside and puts a symbolic link to a copy of it, outside the library, in its place.
async function symbolicManifest(stream) {
  const outside = join(stream.base, "outside-manifest.json");
  await writeFile(outside, await readFile(stream.manifestPath));
  await rename(stream.manifestPath, join(stream.base, "saved-manifest.json"));
  await symlink(outside, stream.manifestPath);
}

// What is still refused: a file some other name leads to, a symbolic link and a file that is not
// regular, whether it is there before the read or appears inside the reader's own steps.
const REFUSED_SHAPES = Object.freeze([
  { file: "manifest", what: "has a second link that stays", prepare: (stream) => link(stream.manifestPath, join(stream.base, "kept-link.json")) },
  { file: "manifest", what: "gains a second link between the reader's lstat and its open", step: "lstat", make: (stream) => link(stream.manifestPath, join(stream.base, "late-link.json")) },
  { file: "manifest", what: "gains a second link between the reader's open and its stat", step: "open", make: (stream) => link(stream.manifestPath, join(stream.base, "opened-link.json")) },
  { file: "segment", what: "gains a second link between the reader's open and its stat", step: "open", make: (stream) => link(stream.segmentPath, join(stream.base, "segment-link.ndjson")) },
  { file: "manifest", what: "is a symbolic link", prepare: symbolicManifest },
  { file: "manifest", what: "becomes a symbolic link between the reader's lstat and its open", step: "lstat", make: symbolicManifest },
  {
    file: "manifest",
    what: "is a directory",
    prepare: async (stream) => {
      await rename(stream.manifestPath, join(stream.base, "saved-manifest.json"));
      await mkdir(stream.manifestPath);
    },
  },
  {
    file: "manifest",
    what: "is a FIFO",
    prepare: async (stream) => {
      await rename(stream.manifestPath, join(stream.base, "saved-manifest.json"));
      return createFifo(stream.manifestPath);
    },
  },
]);

for (const shape of REFUSED_SHAPES) {
  test(`512-R2: another device's ${shape.file} that ${shape.what} is still refused`, async (t) => {
    const stream = await otherStreamAboutToBeReplaced(t);
    const target = shape.file === "manifest" ? stream.manifestPath : stream.segmentPath;
    const reasonCode = shape.file === "manifest" ? "AKASHA_STREAM_MANIFEST_INVALID" : "AKASHA_SEGMENT_CORRUPT";
    const original = await readFile(target);
    if (shape.prepare !== undefined) {
      const prepared = await shape.prepare(stream);
      if (prepared?.supported === false) {
        t.skip(prepared.reason);
        return;
      }
    }
    let made = shape.step === undefined;
    const replacements = shape.step === undefined ? {} : {
      [shape.step]: (call) => async (path, ...rest) => {
        const result = await call(path, ...rest);
        if (path === target && !made) {
          made = true;
          await shape.make(stream);
        }
        return result;
      },
    };
    for (const [way, readOther] of Object.entries(OTHER_STREAM_READS)) {
      await assert.rejects(interleaved(replacements, () => readOther(stream.library)),
        (error) => error?.reasonCode === reasonCode && error.details?.deviceId === DEVICE_B.deviceId, way);
    }
    assert.equal(made, true, "the change landed inside the window under test");
    if (shape.what.includes("second link")) assert.deepEqual(await readFile(target), original, "the refused file is left as it was");
  });
}
