// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-MIN-225 (TCRN-CROSS-SUB-258) and TCRN-CROSS-INC-389: the retired fitness settings.
// fitness.windowDays and fitness.minEvents configured the 1.2.0 fitness window; they are retired
// keys whose recorded values replay as history in every read, and the write verbs refuse them.
//
// TCRN-CROSS-SUB-308 moved these cases here from tests/story-377-retire-sweep.test.mjs, which was
// deleted with its subject (retire-sweep, retire-proposals, the fitness statistic and the manual
// retire). The settings replay they prove is not part of that subject and stays; the one assertion
// that read retire-proposals went with that verb, and the fixture keeps only what they use.

import { testDeviceHome } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  appendEvents,
  cachePath,
  createProject,
  initializeKnowledgeStore,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  sortWorkspaceSettings,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";

async function fixture(t, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s377-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: "2026-01-01T00:00:00Z" });
  await createProject(workspace, {
    occurredAt: "2026-01-01T00:00:01Z",
    externalKey: `${externalKey}-PROJECT`,
    name: "Story 377 fixture",
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace };
}

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function reasonOf(argv) {
  return runCli(argv, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

// AC6: fitness.windowDays and fitness.minEvents are retired settings. A new write is refused as an
// unregistered key, and a chain that recorded one of them before the retirement still replays.
test("MIN-225: the retired fitness settings refuse new writes and their history still replays", async (t) => {
  const fx = await fixture(t, "FIXTURE-MIN-225-SETTINGS");
  await appendEvents(fx.workspace, [
    (state) => ({
      payload: { operation: "settings.updated", record: { schemaVersion: "tcrn.workspace-setting.v1", key: "fitness.windowDays", layerKind: "workspace_configuration", value: "30", revision: 1, updatedAt: "2026-01-02T00:00:00Z", tombstone: false } },
      projects: state.projects,
      work: state.work,
      settings: state.settings,
    }),
  ], { occurredAt: "2026-01-02T00:00:00Z" });
  const state = await materializeWorkspace(fx.workspace);
  assert.equal(state.version, 2, "the chain with the recorded value replays");
  assert.equal(state.settings.some((entry) => entry.key.startsWith("fitness.")), false, "the recorded value is history, not a current setting");
  for (const key of ["fitness.windowDays", "fitness.minEvents"]) {
    assert.equal(await reasonOf(["settings-set", "--workspace", fx.workspace, "--at", "2026-01-03T00:00:00Z", "--key", key, "--value", "30"]), "SETTINGS_KEY_UNREGISTERED", key);
  }
  assert.equal((await cliJson(["settings-catalog", "--workspace", fx.workspace])).settings.some((entry) => entry.key.startsWith("fitness.")), false, "the catalog no longer offers them");
});

// TCRN-CROSS-INC-389 (STORY-465 R7): settings events exactly as the v1.2.0 core wrote them, appended raw.
// Until SUB-258 the fitness keys were live, so a recorded value also entered the current settings of that
// core: the member that records one carries it in its delta, and the views and any replay snapshot that
// append writes hold it, as they do on a chain written by 1.2.0 (problem list #578). A removal carries the
// payload removeWorkspaceSetting writes.
function recordedSetting(key, value, updatedAt) {
  const record = { schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision: 1, updatedAt, tombstone: false };
  return (state) => ({
    payload: { operation: "settings.updated", record },
    projects: state.projects,
    work: state.work,
    settings: sortWorkspaceSettings([...state.settings.filter((entry) => entry.key !== key), record]),
  });
}

function removedSetting(key, updatedAt) {
  return (state) => ({
    payload: { operation: "settings.removed", record: { key, updatedAt } },
    projects: state.projects,
    work: state.work,
    settings: state.settings.filter((entry) => entry.key !== key),
  });
}

async function appendSettingEvents(fx, occurredAt, members) {
  return await appendEvents(fx.workspace, members, { occurredAt });
}

function settle(read) {
  return read.then((state) => ({ state }), (error) => ({ error }));
}

// The three ways a chain is read: through this device's cache, seeded from its snapshot when there is one
// (every read verb), replayed from genesis, and validate. Each gives its state or its refusal.
async function readEveryWay(workspace) {
  return {
    snapshotSeeded: await settle(materializeWorkspace(workspace)),
    genesis: await settle(materializeWorkspaceFromGenesis(workspace)),
    validate: await settle(validateWorkspace(workspace)),
  };
}

// INC-389 R1: a chain that set fitness.windowDays or fitness.minEvents under 1.1.0-1.2.0 and removed it
// again was valid there. The removal of a retired key is history, like the value it removed, so every read
// opens the chain and neither record is a current setting.
test("INC-389: a removed retired fitness setting replays as history in every read", async (t) => {
  for (const [key, value, label] of [["fitness.windowDays", "30", "WINDOW-DAYS"], ["fitness.minEvents", "5", "MIN-EVENTS"]]) {
    const fx = await fixture(t, `FIXTURE-INC-389-REMOVED-${label}`);
    await appendSettingEvents(fx, "2026-01-02T00:00:00Z", [recordedSetting(key, value, "2026-01-02T00:00:00Z")]);
    await appendSettingEvents(fx, "2026-01-03T00:00:00Z", [removedSetting(key, "2026-01-03T00:00:00Z")]);
    for (const [read, { state, error }] of Object.entries(await readEveryWay(fx.workspace))) {
      assert.equal(error, undefined, `${key} ${read}: ${error?.reasonCode} ${error?.message}`);
      assert.equal(state.version, 3, `${key} ${read}`);
      assert.deepEqual(state.settings, [], `${key} ${read}: the value and its removal are history, not a current setting`);
    }
  }
});

// INC-389 R1: the same holds for a key retired before fitness, model.economyTier.
test("INC-389: an earlier retired key set then removed replays in every read", async (t) => {
  const fx = await fixture(t, "FIXTURE-INC-389-REMOVED-ECONOMY-TIER");
  await appendSettingEvents(fx, "2026-01-02T00:00:00Z", [recordedSetting("model.economyTier", "claude-sonnet-5", "2026-01-02T00:00:00Z")]);
  await appendSettingEvents(fx, "2026-01-03T00:00:00Z", [removedSetting("model.economyTier", "2026-01-03T00:00:00Z")]);
  for (const [read, { state, error }] of Object.entries(await readEveryWay(fx.workspace))) {
    assert.equal(error, undefined, `${read}: ${error?.reasonCode} ${error?.message}`);
    assert.equal(state.version, 3, read);
    assert.deepEqual(state.settings, [], `${read}: the value and its removal are history, not a current setting`);
  }
});

// The device cache's snapshot of the fixture's library (TCRN-CROSS-STORY-469 R4): its version and the setting
// keys its state holds.
async function newestSnapshotSettings(fx) {
  const libraryId = (await materializeWorkspaceFromGenesis(fx.workspace)).metadata.workspaceId;
  const directory = join(cachePath(libraryId, testDeviceHome), "snapshots");
  const header = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
  const state = JSON.parse(await readFile(join(directory, `${header.stateDigest}.json`), "utf8"));
  return { version: header.version, keys: state.settings.map((entry) => entry.key) };
}

// A chain whose cache snapshot was taken after fitness.windowDays was recorded: version 2 sets an interval of
// two events, and one append records the retired key and a live one, ending on version 4, where the next read
// writes the snapshot. The snapshot is a replay by this engine, so the retired key in it is history, as in a
// replay from genesis; a snapshot another engine wrote, which might still list the key as live, is never read.
async function snapshotWhileRetiredKeyLive(t, externalKey) {
  const fx = await fixture(t, externalKey);
  await appendSettingEvents(fx, "2026-01-02T00:00:00Z", [recordedSetting("storage.snapshotEveryEvents", "2", "2026-01-02T00:00:00Z")]);
  await appendSettingEvents(fx, "2026-01-03T00:00:00Z", [
    recordedSetting("fitness.windowDays", "30", "2026-01-03T00:00:00Z"),
    recordedSetting("artifact.language", "zh-CN", "2026-01-03T00:00:00Z"),
  ]);
  await materializeWorkspace(fx.workspace);
  assert.deepEqual(await newestSnapshotSettings(fx), { version: 4, keys: ["artifact.language", "storage.snapshotEveryEvents"] }, "the snapshot holds the retired key as history");
  return fx;
}

// INC-389 R2 (#566), TCRN-CROSS-STORY-469 R4: a read seeded from the cache snapshot and a replay from genesis
// hold the same settings.
test("INC-389: a cache snapshot taken after a retired key was recorded seeds the same settings as genesis", async (t) => {
  const fx = await snapshotWhileRetiredKeyLive(t, "FIXTURE-INC-389-SNAPSHOT");
  const { result: seeded, metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(fx.workspace));
  assert.equal(metrics.snapshotMaterialize, 1, "the read was seeded from the snapshot");
  const genesis = await materializeWorkspaceFromGenesis(fx.workspace);
  assert.deepEqual(seeded.settings, genesis.settings, "the snapshot seed and genesis hold the same settings");
  assert.deepEqual(seeded.settings.map((entry) => entry.key), ["artifact.language", "storage.snapshotEveryEvents"], "neither holds the retired key");
  assert.deepEqual(seeded, genesis, "the two reads are the same state");
});

// INC-389 R1 and R2 (#529, #566): the same chain removes the retired key after the snapshot. Both reads take
// the removal as history and agree.
test("INC-389: a retired key removed after a cache snapshot reads the same in both replays", async (t) => {
  const fx = await snapshotWhileRetiredKeyLive(t, "FIXTURE-INC-389-SNAPSHOT-REMOVED");
  await appendSettingEvents(fx, "2026-01-04T00:00:00Z", [removedSetting("fitness.windowDays", "2026-01-04T00:00:00Z")]);
  assert.equal((await newestSnapshotSettings(fx)).version, 4, "the removal comes after the newest snapshot");
  const reads = { snapshotSeeded: await settle(materializeWorkspace(fx.workspace)), genesis: await settle(materializeWorkspaceFromGenesis(fx.workspace)) };
  for (const [read, { state, error }] of Object.entries(reads)) {
    assert.equal(error, undefined, `${read}: ${error?.reasonCode} ${error?.message}`);
    assert.equal(state.version, 5, read);
  }
  assert.deepEqual(reads.snapshotSeeded.state.settings, reads.genesis.state.settings, "both reads hold the same settings");
  assert.deepEqual(reads.genesis.state.settings.map((entry) => entry.key), ["artifact.language", "storage.snapshotEveryEvents"], "neither holds the retired key");
});

// INC-389 changes only how replay reads a retired key. A live key removed without ever being set does not
// apply in any read: in a library it is a rejected event (TCRN-CROSS-STORY-468 R5), listed with its reason and
// skipped. The write verbs still refuse both fitness keys without appending.
test("INC-389: live key rules and retired key refusals are unchanged", async (t) => {
  const corrupt = await fixture(t, "FIXTURE-INC-389-LIVE-REMOVE");
  await appendSettingEvents(corrupt, "2026-01-02T00:00:00Z", [removedSetting("artifact.language", "2026-01-02T00:00:00Z")]);
  for (const [read, { state, error }] of Object.entries(await readEveryWay(corrupt.workspace))) {
    assert.equal(error, undefined, read);
    assert.deepEqual(state.settings, [], read);
    const [rejected] = state.library.rejectedEvents;
    assert.equal(rejected?.reasonCode, "WORKSPACE_EVENT_CORRUPT", read);
    assert.equal(rejected.operation, "settings.removed", read);
    assert.match(rejected.detail, /cannot remove unknown setting artifact\.language/u, read);
  }
  const fx = await fixture(t, "FIXTURE-INC-389-REFUSALS");
  for (const key of ["fitness.windowDays", "fitness.minEvents"]) {
    const write = ["--workspace", fx.workspace, "--at", "2026-01-02T00:00:00Z", "--key", key];
    assert.equal(await reasonOf(["settings-set", ...write, "--value", "30"]), "SETTINGS_KEY_UNREGISTERED", key);
    assert.equal(await reasonOf(["settings-remove", ...write]), "WORKSPACE_INPUT_INVALID", key);
  }
  assert.equal((await validateWorkspace(fx.workspace)).version, 1, "no refusal appended an event");
});
