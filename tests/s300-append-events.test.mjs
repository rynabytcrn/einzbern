// SPDX-License-Identifier: Apache-2.0
//
// STORY-300 slice 2. One append and many appends are the same operation with a
// different count, so there is one implementation and the single write is its N=1
// case. Every existing chain-write verb -- thirty-two call sites -- now runs the
// batch code path, which is the arrangement that keeps it from rotting: a defect
// in the fold is a defect in every write, not in a road only batches travel.
//
// What the rest of the suite already proves is the N=1 half: it passes unchanged,
// byte for byte, against the generalised kernel. What it cannot reach is the fold
// itself, so these are its criteria.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvents,
  initializeLibrary,
  materializeWorkspace,
  setWorkspaceSetting,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { compareCanonicalText, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

// The delta a project-create verb builds, rebuilt here so a batch can be made of
// real operations rather than of shapes replay would refuse. The id derivation and
// the sorted insertion are the two parts that must match the verb exactly: replay
// re-derives both, and a hand-made approximation of either is read as corruption.
function projectCreated(externalKey, name, occurredAt) {
  const id = deriveStableId("project", externalKey);
  return (state) => {
    const record = {
      schemaVersion: "tcrn.project.v1",
      id,
      externalKey,
      name,
      revision: 1,
      updatedAt: occurredAt,
      tombstone: false,
    };
    return {
      payload: { operation: "project.created", record },
      projects: [...state.projects, record].sort((left, right) => compareCanonicalText(left.id, right.id)),
      work: state.work,
    };
  };
}

function instant(offset) {
  return `2026-01-01T00:00:${String(offset).padStart(2, "0")}Z`;
}

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s300-append-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  const workspace = join(base, "workspace");
  return { workspace };
}

// This device's stream directory in the library (TCRN-CROSS-STORY-468 R2).
async function ownStream(workspace) {
  const devices = await readdir(join(workspace, "akasha"));
  assert.equal(devices.length, 1, "one device has written");
  return join(workspace, "akasha", devices[0]);
}

// A batch member builds its delta from the state the members before it produced.
// Red leg: hand every member the pre-batch state and the second project's payload
// stops seeing the first, so the fold produces a chain replay refuses.
test("STORY-300: each member of a batch sees what the members before it wrote", async (context) => {
  const { workspace } = await fixture(context);
  const seen = [];
  const committed = await appendEvents(workspace, [0, 1, 2].map((index) => {
    const build = projectCreated(`PROJECT-${index}`, `Project ${index}`, instant(2));
    return (state) => {
      seen.push(state.version);
      return build(state);
    };
  }), { occurredAt: instant(2) });

  assert.deepEqual(seen, [0, 1, 2], "each member is built against the version its predecessor committed");
  assert.equal(committed.version, 3, "one batch, three events");
  assert.equal(committed.projects.length, 3);
  // The chain the batch wrote must be the chain a fresh replay reads.
  const rematerialized = await materializeWorkspace(workspace);
  assert.equal(rematerialized.version, 3);
  assert.equal(rematerialized.headEventHash, committed.headEventHash);
  // Sorted for the comparison because the chain sorts projects by derived id, which
  // is a hash and therefore unrelated to the order the batch wrote them in.
  assert.deepEqual(rematerialized.projects.map((entry) => entry.externalKey).sort(), ["PROJECT-0", "PROJECT-1", "PROJECT-2"]);
  assert.equal((await validateWorkspace(workspace)).version, 3, "views match the state the batch returned");
});

// A library stream rolls to a new segment at storage.segmentBytes (4 KiB here), so a batch of
// padded projects crosses segments. Segments are named by ascending hex ordinals, each recorded
// in the stream manifest with its sequence range, and the whole batch replays.
test("STORY-300: a batch that crosses a segment boundary writes ascending and replays clean", async (context) => {
  const { workspace } = await fixture(context);
  const segmentBytes = await setWorkspaceSetting(workspace, { key: "storage.segmentBytes", value: "4096", occurredAt: instant(1) });
  assert.equal(segmentBytes.settings.find((entry) => entry.key === "storage.segmentBytes")?.value, "4096");
  const padding = "x".repeat(900);
  const committed = await appendEvents(workspace,
    Array.from({ length: 12 }, (_, index) => projectCreated(`SPAN-${index}`, `Span ${index} ${padding}`, instant(5))),
    { occurredAt: instant(5) });
  assert.equal(committed.version, 13, "one setting and a batch of twelve");
  const stream = await ownStream(workspace);
  const manifest = JSON.parse(await readFile(join(stream, "manifest.json"), "utf8"));
  const names = manifest.segments.map((segment) => segment.name);
  assert.ok(names.length > 1, "the batch opened further segments");
  assert.deepEqual(names, names.map((_, index) => `${(index + 1).toString(16).padStart(8, "0")}.ndjson`), "segments are ascending hex ordinals");
  assert.ok(manifest.segments.every((segment, index) => index === 0 || segment.firstSequence === manifest.segments[index - 1].lastSequence + 1));
  const rematerialized = await materializeWorkspace(workspace);
  assert.equal(rematerialized.version, 13);
  assert.equal(rematerialized.headEventHash, committed.headEventHash);
  assert.equal((await validateWorkspace(workspace)).version, 13);
});

// Refusal is all-or-nothing and unconditional: a member that throws leaves the
// chain exactly as it was. Red leg: move the fold after the first writeSegment and
// the version advances while the call still fails -- INC-198's shape, rebuilt.
test("STORY-300: a member that refuses leaves the chain untouched", async (context) => {
  const { workspace } = await fixture(context);
  const before = await materializeWorkspace(workspace);
  await assert.rejects(() => appendEvents(workspace, [
    projectCreated("PROJECT-OK", "Ok", instant(2)),
    () => { throw new Error("member two cannot build its delta"); },
  ], { occurredAt: instant(2) }));

  const after = await materializeWorkspace(workspace);
  assert.equal(after.version, before.version, "a refused batch does not advance the version");
  assert.equal(after.headEventHash, before.headEventHash, "a refused batch does not move the head");
  assert.equal(after.projects.length, before.projects.length, "not even the member that succeeded is left behind");
  assert.deepEqual(await readdir(join(workspace, "akasha")), [], "no stream was written");
});

// One batch is one mutation: one write lock and one replay for the whole batch
// (TCRN-CROSS-STORY-467 R1 replaced the per-call version check with the lock). Red leg:
// take the lock per member and another writer can land between two members of one batch.
test("STORY-300: a batch takes the write lock once, not once per member", async (context) => {
  const { workspace } = await fixture(context);
  let entered = 0;
  const committed = await appendEvents(workspace,
    [0, 1].map((index) => projectCreated(`ONCE-${index}`, `Once ${index}`, instant(2))),
    { occurredAt: instant(2), async insideWriteLockForTest() { entered += 1; } });
  assert.equal(entered, 1, "the whole batch ran inside one lock acquisition");
  assert.equal(committed.version, 2, "both members landed in the one mutation");
});
