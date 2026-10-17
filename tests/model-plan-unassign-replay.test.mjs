// SPDX-License-Identifier: Apache-2.0
// F15: new unassignments remove the last effort; old buggy envelopes remain
// replayable without leaking orphan efforts into current state or rewriting history.

import { testDeviceHome } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvents,
  applyModelPlanAssign,
  applyModelPlanSet,
  applyModelPlanUnassign,
  cachePath,
  initializeLibrary,
  materializeFromGenesis,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  validateModelPlanState,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  assignModelPlanInWorkspace,
  setModelPlanInWorkspace,
  unassignModelPlanInWorkspace,
} from "../dist/build/packages/core/src/workspace.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";
import { readOwnStream } from "./helpers/library-forge.mjs";

const instant = (second) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString().replace(".000Z", "Z");
const identity = { host: "codex", name: "legacy-plan" };
const valid = (records) => assert.deepEqual(validateModelPlanState(records), records);

test("F15: unassign removes the last effort without mutating the prior record or other assignments", () => {
  const created = applyModelPlanSet([], { ...identity, defaultModel: "model", defaultEffort: "high", updatedAt: instant(1) });
  const assigned = applyModelPlanAssign(created.records, { ...identity, persona: "Verity", model: "model", effort: "low", updatedAt: instant(2) }, () => true);
  const shared = applyModelPlanAssign(assigned.records, { ...identity, persona: "Ilya", model: "other", updatedAt: instant(3) }, () => true);
  const unassigned = applyModelPlanUnassign(shared.records, { ...identity, persona: "Verity", updatedAt: instant(4) });
  assert.deepEqual(unassigned.record.assignments, { Ilya: "other" });
  assert.equal(Object.hasOwn(unassigned.record, "efforts"), false);
  assert.equal(unassigned.record.defaultEffort, "high");
  assert.equal(unassigned.record.revision, shared.record.revision + 1);
  assert.equal(unassigned.record.updatedAt, instant(4));
  assert.deepEqual(shared.record.efforts, { Verity: "low" });
  assert.deepEqual(shared.record.assignments, { Ilya: "other", Verity: "model" });
  valid(unassigned.records);

  const both = applyModelPlanAssign(shared.records, { ...identity, persona: "Ilya", model: "other", effort: "medium", updatedAt: instant(4) }, () => true);
  const one = applyModelPlanUnassign(both.records, { ...identity, persona: "Verity", updatedAt: instant(5) });
  assert.deepEqual(one.record.efforts, { Ilya: "medium" });
  valid(one.records);
  const last = applyModelPlanUnassign(one.records, { ...identity, persona: "Ilya", updatedAt: instant(6) });
  assert.deepEqual(last.record.assignments, {});
  assert.equal(Object.hasOwn(last.record, "efforts"), false);
  valid(last.records);

  for (const efforts of [undefined, {}]) {
    const { efforts: _prior, ...plain } = shared.record;
    const record = { ...plain, ...(efforts === undefined ? {} : { efforts }) };
    const result = applyModelPlanUnassign([record], { ...identity, persona: "Verity", updatedAt: instant(4) });
    assert.equal(Object.hasOwn(result.record, "efforts"), false);
    valid(result.records);
  }
});

async function fixture(t, { snapshots = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-model-plan-unassign-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: instant(0) });
  if (snapshots) {
    const record = { schemaVersion: "tcrn.workspace-setting.v1", key: "storage.snapshotEveryEvents", layerKind: "workspace_configuration", value: "2", revision: 1, updatedAt: instant(0), tombstone: false };
    await appendEvents(workspace, [(state) => ({ payload: { operation: "settings.updated", record }, projects: state.projects, work: state.work, settings: [record] })], { occurredAt: instant(0) });
  }
  await setModelPlanInWorkspace(workspace, { ...identity, defaultModel: "model", occurredAt: instant(1) });
  const assigned = await assignModelPlanInWorkspace(workspace, { ...identity, persona: "Verity", model: "model", effort: "low", occurredAt: instant(2) });
  return { workspace, assigned: assigned.executionConfig.modelPlans[0], metadata: assigned.metadata };
}

// This is the pre-fix writer's actual envelope, not a relaxed record validator.
function historicalUnassign(record, persona, second) {
  const assignments = { ...record.assignments };
  delete assignments[persona];
  const efforts = record.efforts === undefined ? undefined : { ...record.efforts };
  if (efforts !== undefined) delete efforts[persona];
  return {
    ...record,
    assignments,
    ...(efforts === undefined || Object.keys(efforts).length === 0 ? {} : { efforts }),
    revision: record.revision + 1,
    updatedAt: instant(second),
  };
}

async function appendHistorical(workspace, operation, record, fields = {}) {
  return appendEvents(workspace, [(state) => ({
    payload: { operation: `execution.model-plan.${operation}`, record: { ...record, ...fields } },
    projects: state.projects,
    work: state.work,
    executionConfig: { ...state.executionConfig, modelPlans: [record] },
  })], { occurredAt: record.updatedAt });
}

async function historicalChain(t, options = {}) {
  const fx = await fixture(t, options);
  const unassigned = historicalUnassign(fx.assigned, "Verity", 3);
  await appendHistorical(fx.workspace, "unassigned", unassigned, { persona: "Verity" });
  if (options.snapshots) await materializeWorkspace(fx.workspace);
  const reset = applyModelPlanSet([unassigned], { ...identity, defaultModel: "old-next-model", updatedAt: instant(4) }).record;
  await appendHistorical(fx.workspace, "set", reset);
  const reassigned = applyModelPlanAssign([reset], { ...identity, persona: "Ilya", model: "old-assignment", updatedAt: instant(5) }, () => true).record;
  await appendHistorical(fx.workspace, "assigned", reassigned, { persona: "Ilya", model: "old-assignment" });
  return { ...fx, unassigned, reset, reassigned };
}

async function sourceBytes(workspace) {
  const { directory, manifest } = await readOwnStream(workspace);
  return Promise.all(["manifest.json", ...manifest.segments.map((segment) => segment.name)].map(async (name) => [name, await readFile(join(directory, name))]));
}

test("F15: the workspace unassign writer persists a valid effort-free record that replays exactly", async (t) => {
  const fx = await fixture(t);
  const written = await unassignModelPlanInWorkspace(fx.workspace, { ...identity, persona: "Verity", occurredAt: instant(3) });
  const record = written.executionConfig.modelPlans[0];
  assert.deepEqual(record.assignments, {});
  assert.equal(Object.hasOwn(record, "efforts"), false);
  valid(written.executionConfig.modelPlans);
  const replayed = await materializeWorkspaceFromGenesis(fx.workspace);
  assert.deepEqual(replayed.library.rejectedEvents, []);
  assert.deepEqual(replayed.executionConfig, written.executionConfig);
  assert.equal(Object.hasOwn((await readOwnStream(fx.workspace)).events.at(-1).payload.record, "efforts"), false);
});

test("F15: the exact legacy unassign and its historical follow-on set/assign replay without changing source bytes or hashes", async (t) => {
  const fx = await historicalChain(t);
  const before = await sourceBytes(fx.workspace);
  const events = (await readOwnStream(fx.workspace)).events;
  for (const read of [materializeWorkspaceFromGenesis, materializeWorkspace, validateWorkspace]) {
    const state = await read(fx.workspace);
    assert.deepEqual(state.library.rejectedEvents, []);
    assert.deepEqual(state.executionConfig.modelPlans[0].assignments, { Ilya: "old-assignment" });
    assert.equal(Object.hasOwn(state.executionConfig.modelPlans[0], "efforts"), false);
    valid(state.executionConfig.modelPlans);
    assert.deepEqual(state.events.map((event) => event.eventHash), events.map((event) => event.eventHash));
  }
  const direct = materializeFromGenesis(fx.metadata, events);
  valid(direct.executionConfig.modelPlans);
  assert.equal(Object.hasOwn(direct.executionConfig.modelPlans[0], "efforts"), false);
  assert.deepEqual(await sourceBytes(fx.workspace), before);
});

test("F15: historical reassignment can restore its recorded effort, and a later historical unassign remains legible", async (t) => {
  const fx = await historicalChain(t);
  const reassigned = applyModelPlanAssign([fx.reassigned], { ...identity, persona: "Verity", model: "restored", updatedAt: instant(6) }, () => true).record;
  await appendHistorical(fx.workspace, "assigned", reassigned, { persona: "Verity", model: "restored" });
  const restored = await materializeWorkspaceFromGenesis(fx.workspace);
  assert.deepEqual(restored.library.rejectedEvents, []);
  assert.deepEqual(restored.executionConfig.modelPlans[0].efforts, { Verity: "low" });
  const unassigned = historicalUnassign(reassigned, "Verity", 7);
  await appendHistorical(fx.workspace, "unassigned", unassigned, { persona: "Verity" });
  const state = await materializeWorkspaceFromGenesis(fx.workspace);
  assert.deepEqual(state.library.rejectedEvents, []);
  assert.deepEqual(state.executionConfig.modelPlans[0].assignments, { Ilya: "old-assignment" });
  assert.equal(Object.hasOwn(state.executionConfig.modelPlans[0], "efforts"), false);
  valid(state.executionConfig.modelPlans);
});

for (const mutation of ["set", "assign", "unassign"]) {
  test(`F15: cached historical state accepts a new normalized ${mutation} without resurrecting stale effort`, async (t) => {
    const fx = await historicalChain(t, { snapshots: true });
    const projected = await materializeWorkspace(fx.workspace);
    const snapshotDirectory = join(cachePath(projected.metadata.workspaceId, testDeviceHome), "snapshots");
    const header = JSON.parse(await readFile(join(snapshotDirectory, "snapshot.json"), "utf8"));
    const snapshot = JSON.parse(await readFile(join(snapshotDirectory, `${header.stateDigest}.json`), "utf8"));
    assert.equal(header.version, projected.version);
    assert.deepEqual(snapshot.executionConfig.modelPlans[0].efforts, { Verity: "low" }, "the internal replay seed retains only the exact historical envelope");
    const { result: cached, metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
    assert.equal(metrics.snapshotMaterialize, 1);
    assert.deepEqual(cached, await materializeWorkspaceFromGenesis(fx.workspace));
    assert.equal(Object.hasOwn(cached.executionConfig.modelPlans[0], "efforts"), false);
    const options = { ...identity, occurredAt: instant(6) };
    const written = mutation === "set"
      ? await setModelPlanInWorkspace(fx.workspace, { ...options, defaultModel: "new-model" })
      : mutation === "assign"
        ? await assignModelPlanInWorkspace(fx.workspace, { ...options, persona: "Verity", model: "new-assignment" })
        : await unassignModelPlanInWorkspace(fx.workspace, { ...options, persona: "Ilya" });
    assert.equal(Object.hasOwn(written.executionConfig.modelPlans[0], "efforts"), false);
    valid(written.executionConfig.modelPlans);
    for (const read of [materializeWorkspace, materializeWorkspaceFromGenesis, validateWorkspace]) {
      const state = await read(fx.workspace);
      assert.deepEqual(state.library.rejectedEvents, []);
      assert.deepEqual(state.executionConfig, written.executionConfig);
      valid(state.executionConfig.modelPlans);
    }
    const latest = (await readOwnStream(fx.workspace)).events.at(-1);
    assert.equal(Object.hasOwn(latest.payload.record, "efforts"), false, "the new event records corrected state, not the replay seed");
  });
}

test("F15: legacy compatibility rejects changed effort values, extra orphans, fields, and revisions", async (t) => {
  const variations = [
    { efforts: { Verity: "high" } },
    { efforts: { Verity: "low", Ilya: "high" } },
    { unexpected: "not historical" },
    { revision: 99 },
  ];
  for (const variation of variations) {
    const fx = await fixture(t);
    const bad = { ...historicalUnassign(fx.assigned, "Verity", 3), ...variation };
    await appendHistorical(fx.workspace, "unassigned", bad, { persona: "Verity" });
    const state = await materializeWorkspaceFromGenesis(fx.workspace);
    assert.equal(state.library.rejectedEvents.length, 1);
    assert.equal(state.library.rejectedEvents[0].reasonCode, "WORKSPACE_EVENT_CORRUPT");
    assert.deepEqual(state.executionConfig.modelPlans, [fx.assigned]);
    const events = (await readOwnStream(fx.workspace)).events;
    assert.throws(() => materializeFromGenesis(fx.metadata, events), { reasonCode: "WORKSPACE_EVENT_CORRUPT" });
  }
});

test("F15: inherited historical efforts do not permit arbitrary orphans in later mutations", async (t) => {
  const fx = await historicalChain(t, { snapshots: true });
  await materializeWorkspace(fx.workspace);
  const bad = { ...fx.reassigned, defaultModel: "forged", revision: fx.reassigned.revision + 1, updatedAt: instant(6), efforts: { Verity: "low", Sable: "high" } };
  await appendHistorical(fx.workspace, "set", bad);
  for (const read of [materializeWorkspace, materializeWorkspaceFromGenesis]) {
    const state = await read(fx.workspace);
    assert.equal(state.library.rejectedEvents.length, 1);
    assert.equal(state.library.rejectedEvents[0].reasonCode, "WORKSPACE_EVENT_CORRUPT");
    assert.equal(state.executionConfig.modelPlans[0].revision, fx.reassigned.revision);
    valid(state.executionConfig.modelPlans);
  }
});
