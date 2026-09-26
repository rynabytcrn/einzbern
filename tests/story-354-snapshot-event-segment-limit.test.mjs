// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-354 (round 2): walkControlTree's boundReadFileBytes applied the
// generic PROTOCOL_LIMITS.maxCanonicalBytes ceiling (1 MiB) to every file it read, event
// segments included. That ceiling is right for small documents but wrong for an event
// segment, which legitimately grows up to its configured storage.segmentBytes before it
// rolls, so any segment that merely crossed 1 MiB made createSnapshotManifest and
// verifySnapshotManifest fail closed with SNAPSHOT_PATH_INVALID ("exceeds the snapshot read
// limit"). The fix reads event segments under the segment bound and every other file under
// the original 1 MiB ceiling.
//
// TCRN-CROSS-STORY-469: the witness now covers a library, whose event segments are the
// akasha/<device>/<ordinal>.ndjson files, read under AKASHA_SEGMENT_BYTES_MAXIMUM. The
// library's segments roll at storage.segmentBytes (1 MiB by default), so this fixture raises
// it to let one segment grow past the generic ceiling without rolling.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvents,
  createProject,
  createSnapshotManifest,
  createWorkDelta,
  initializeLibrary,
  setWorkspaceSetting,
  verifySnapshotManifest,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-05T05:00:${String(second).padStart(2, "0")}Z`;

// 1500 minimal work.created ("Initiative", parentless, no scope/title/labels) events pad the
// device's first segment well past the 1 MiB ceiling this test exists to lift for event
// segments, while staying under the raised roll size (so the segment never rolls to
// 00000002.ndjson) and under the unrelated per-view projection budget.
const PAD_COUNT = 1500;
const SEGMENT_BYTES = 4 * 1_048_576;

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s354-seglimit-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: instant(0) });
  return { base, workspace };
}

test("STORY-354 snapshot-manifest reads an event segment past the generic 1 MiB file limit", async (context) => {
  const fx = await fixture(context);
  await setWorkspaceSetting(fx.workspace, { key: "storage.segmentBytes", value: String(SEGMENT_BYTES), occurredAt: instant(1) });
  let state = await createProject(fx.workspace, {
    externalKey: "STORY-354-SEGLIMIT-PROJECT",
    name: "Event segment limit coverage",
    occurredAt: instant(1),
  });
  const projectId = state.projects[0].id;
  const deltas = [];
  for (let i = 0; i < PAD_COUNT; i += 1) {
    deltas.push(createWorkDelta({
      projectId,
      externalKey: `STORY-354-PAD-${i}`,
      kind: "Initiative",
      parentId: null,
      status: "active",
      occurredAt: instant(2),
    }));
  }
  state = await appendEvents(fx.workspace, deltas, { occurredAt: instant(2) });

  const [deviceId] = await readdir(join(fx.workspace, "akasha"));
  const segmentRelativePath = `akasha/${deviceId}/00000001.ndjson`;
  const segmentPath = join(fx.workspace, segmentRelativePath);
  const segmentBytes = (await stat(segmentPath)).size;
  assert.ok(
    segmentBytes > PROTOCOL_LIMITS.maxCanonicalBytes,
    `precondition: the segment must exceed the snapshot read limit (${PROTOCOL_LIMITS.maxCanonicalBytes} bytes) to exercise the fix; got ${segmentBytes} bytes from ${PAD_COUNT} padding events`,
  );
  assert.deepEqual((await readdir(join(fx.workspace, "akasha", deviceId))).sort(), ["00000001.ndjson", "manifest.json"], "the padded stream has not rolled");
  const segmentSha256 = createHash("sha256").update(await readFile(segmentPath)).digest("hex");

  const manifestText = await createSnapshotManifest(fx.workspace);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, "tcrn.workspace-snapshot-manifest.v1");
  assert.equal(manifest.validate.workspace, "valid");
  assert.equal(manifest.version, state.version);

  const segmentEntry = manifest.files.find((entry) => entry.path === segmentRelativePath);
  assert.ok(segmentEntry, "manifest must cover the oversized event segment, not silently skip it");
  assert.equal(segmentEntry.bytes, segmentBytes, "manifest must record the segment's full size, not a truncated read");
  assert.equal(segmentEntry.sha256, segmentSha256, "manifest must hash the segment's full content, not a truncated read");

  assert.equal((await verifySnapshotManifest(fx.workspace, manifestText)).reasonCode, "SNAPSHOT_VERIFIED");
});
