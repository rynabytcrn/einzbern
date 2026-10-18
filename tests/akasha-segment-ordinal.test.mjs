// SPDX-License-Identifier: Apache-2.0
// Sequential fixtures: a refused rollover must not replace committed segment bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendStreamEvents, appendToOwnStream, buildStreamEvents, createLibrary,
  readStreamEvents, readStreamManifest, streamDirectory, withLibraryWriteLock,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const DEVICE = { deviceId: "a".repeat(32), displayName: "ordinal-fixture" };
const draft = (index) => ({ occurredAt: "2026-10-18T00:00:00Z", payload: { operation: "test.noted", index } });

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "einzbern-segment-ordinal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "device");
  const library = await createLibrary(join(base, ".ether"), { createdAt: "2026-10-18T00:00:00Z" });
  const first = await appendToOwnStream(library, DEVICE, [draft(1)], { home });
  return { home, library, ...first, directory: streamDirectory(library.root, DEVICE.deviceId) };
}

for (const direct of [false, true]) {
  test(`nonconsecutive segment ordinal refuses before rollover writes (${direct ? "direct append" : "manifest read"})`, async (t) => {
    const { home, library, manifest, directory } = await fixture(t);
    const originalPath = join(directory, manifest.segments[0].name);
    const renamedPath = join(directory, "00000002.ndjson");
    await rename(originalPath, renamedPath);
    const malformed = { ...manifest, segments: [{ ...manifest.segments[0], name: "00000002.ndjson" }] };
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, canonicalJson(malformed));
    const before = await readFile(renamedPath);
    const manifestBefore = await readFile(manifestPath);
    const events = buildStreamEvents(malformed, [draft(2)], malformed.clockHighWater);
    let refusal;
    try {
      if (direct) {
        await withLibraryWriteLock(library, () => appendStreamEvents(library, malformed, events, { segmentBytes: before.length }), { home });
      } else {
        await appendToOwnStream(library, DEVICE, [draft(2)], { home, segmentBytes: before.length });
      }
    } catch (error) { refusal = error; }
    assert.deepEqual(await readFile(renamedPath), before, "a refused append preserves committed segment bytes");
    assert.deepEqual(await readFile(manifestPath), manifestBefore, "a refused append preserves the committed manifest");
    assert.equal(refusal?.reasonCode, "AKASHA_STREAM_MANIFEST_INVALID");
    await assert.rejects(readStreamManifest(library.root, DEVICE.deviceId), { reasonCode: "AKASHA_STREAM_MANIFEST_INVALID" });
  });
}

test("a JSON segment retains its bytes and continues with the next NDJSON ordinal", async (t) => {
  const { home, library, manifest, events, directory } = await fixture(t);
  const name = "00000001.json";
  const bytes = canonicalJson(events);
  await writeFile(join(directory, name), bytes);
  await rm(join(directory, manifest.segments[0].name));
  const jsonManifest = { ...manifest, segments: [{ ...manifest.segments[0], name, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }] };
  await writeFile(join(directory, "manifest.json"), canonicalJson(jsonManifest));
  const appended = await appendToOwnStream(library, DEVICE, [draft(2)], { home });
  assert.deepEqual(appended.manifest.segments.map((segment) => segment.name), ["00000001.json", "00000002.ndjson"]);
  assert.equal(await readFile(join(directory, name), "utf8"), bytes);
  assert.deepEqual(await readStreamEvents(library.root, appended.manifest), [...events, ...appended.events]);
});
