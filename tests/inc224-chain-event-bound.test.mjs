// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-224. The chain's lifetime event bound is not the protocol's
// per-document shape bound, and they must not drift back into one number.
//
// They shared one constant. Every protocol-side use of maxRecords bounds a single
// document or call -- a canonical array's length, an object's property count, the
// context record inputs, the exchange entries, the work graph inputs. Only the
// workspace used it as the number of events a log may accumulate over its lifetime.
// Buying chain headroom by raising the shared constant would have loosened six input
// bounds nobody had measured, to fix one lifetime bound that had been.
//
// The separation is the whole change, so these criteria are about the separation
// holding rather than about either number's value.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROTOCOL_LIMITS, canonicalJson, validateEventChain } from "../dist/build/packages/protocol/src/index.js";
import {
  appendEvents,
  assertWorkspaceRecordCount,
  buildEventPayload,
  createWorkspaceSettingRecord,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  sortWorkspaceSettings,
} from "../dist/build/packages/core/src/index.js";

// INC-399 R4 removes the earlier arbitrary document and lifetime ceilings. Both
// exported compatibility fields now describe the JavaScript array representation.
// Fixtures cross the old boundary without trying to allocate a runtime-sized array.
test("INC-399: document and chain counts cross the former 10,000 boundary", () => {
  assert.equal(PROTOCOL_LIMITS.maxChainEvents, 0xffff_ffff);
  assert.equal(PROTOCOL_LIMITS.maxRecords, 0xffff_ffff);
  for (const count of [10_000, 10_001, PROTOCOL_LIMITS.maxChainEvents]) {
    assert.doesNotThrow(() => assertWorkspaceRecordCount(count));
  }
});

test("INC-399: canonical collections retain every member beyond the old boundary", () => {
  const entries = Array.from({ length: 10_001 }, (_, index) => index);
  assert.deepEqual(JSON.parse(canonicalJson(entries)), entries);
  const object = Object.fromEntries(entries.map((index) => [`k${index}`, index]));
  assert.deepEqual(JSON.parse(canonicalJson(object)), object);
});

// The lifetime bound must still be a bound. Red leg: drop the comparison and the chain
// has no ceiling at all, which is a different defect from the one being fixed.
test("INC-224: the chain bound still refuses past its own ceiling, and refuses nonsense", () => {
  assert.throws(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxChainEvents + 1),
    (error) => error?.reasonCode === "WORKSPACE_RECORD_LIMIT");
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => assertWorkspaceRecordCount(bad),
      (error) => error?.reasonCode === "WORKSPACE_RECORD_LIMIT", String(bad));
  }
});

// The refusal has to name the count it refused, because the operator's next question is
// always "how far past". Red leg: pass a constant string and the number is gone.
test("INC-224: a refused count is reported, not just refused", () => {
  const over = PROTOCOL_LIMITS.maxChainEvents + 7;
  assert.throws(() => assertWorkspaceRecordCount(over), (error) => error?.message === String(over));
});

// TCRN-CROSS-STORY-451 R1: replay without a snapshot validates the whole chain, and it
// measured that chain against the per-document bound. A chain one event past
// maxRecords then read as WORKSPACE_EVENT_CORRUPT on every snapshot-less path. The
// fixture is one append of many members, because each separate append replays the
// whole chain (quadratic), and the members alternate one setting value so no view
// grows with the chain. Red leg: point validateEventChain back at maxRecords.
test("STORY-451: a chain past the per-document bound replays from genesis without a snapshot", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s451-replay-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  const occurredAt = "2026-09-23T00:00:01Z";
  await initializeLibrary({ root: join(base, "workspace"), createdAt: "2026-09-23T00:00:00Z" });
  const settingDelta = (key, value) => (state) => {
    const prior = state.settings.find((entry) => entry.key === key);
    const record = createWorkspaceSettingRecord(key, value, (prior?.revision ?? 0) + 1, occurredAt, workspace);
    return {
      payload: buildEventPayload("settings.updated", record),
      projects: state.projects,
      work: state.work,
      settings: sortWorkspaceSettings([...state.settings.filter((entry) => entry.key !== key), record]),
    };
  };
  const events = 10_001; // former document ceiling plus one, a bounded replay fixture
  // The largest interval keeps this chain snapshot-less under either snapshot rule. The
  // 1 MiB segment keeps each segment index (two keys an event) under its own bounds.
  const deltas = [settingDelta("storage.snapshotEveryEvents", "20000"), settingDelta("storage.segmentBytes", "1048576")];
  while (deltas.length < events) {
    // Any live numeric key does; injection.budgetBytes, the one used here before, is retired
    // (TCRN-CROSS-STORY-474).
    deltas.push(settingDelta("injection.perPromptBytes", deltas.length % 2 === 0 ? "1600" : "1599"));
  }
  const committed = await appendEvents(workspace, deltas, { occurredAt });
  assert.equal(committed.version, events);
  await assert.rejects(stat(join(workspace, ".tcrn-" + "workflow", "snapshots", "manifest.json")), { code: "ENOENT" },
    "precondition: no replay snapshot exists, so replay walks the whole chain");
  const replayed = await materializeWorkspaceFromGenesis(workspace);
  assert.equal(replayed.version, events);
  assert.equal((await materializeWorkspace(workspace)).version, events);
});

// R1 at the protocol layer: the length check runs before any record is read, so a
// placeholder array isolates it. Past maxRecords but within maxChainEvents the chain
// reaches per-record validation; past maxChainEvents it is refused by length. Red
// leg: maxRecords as the bound refuses the first array by length too.
test("STORY-451: validateEventChain bounds the chain by maxChainEvents, not by maxRecords", () => {
  assert.throws(() => validateEventChain(Array.from({ length: 10_001 }, () => null)),
    (error) => error?.reasonCode === "RECORD_MALFORMED",
    "a chain one past the per-document bound is read record by record");
  assert.throws(() => new Array(PROTOCOL_LIMITS.maxChainEvents + 1), RangeError,
    "JavaScript itself cannot represent a longer array; no huge allocation is attempted");
  assert.throws(() => assertWorkspaceRecordCount(PROTOCOL_LIMITS.maxChainEvents + 1),
    (error) => error?.reasonCode === "WORKSPACE_RECORD_LIMIT");
});
