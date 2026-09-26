// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-484 R3, R4, R5 (TCRN-CROSS-SUB-339): the settings shrink.
// execution.dispatchTiers is renamed models.tiers, each tier a runner, a model and an effort; a
// recorded execution.dispatchTiers value reads as models.tiers, with the host a row sits under as
// its runner, until a models.tiers write supersedes it. The dispatch keys, the keys of the switched-off
// mechanisms and the keys nothing reads retire: a new write is refused and their history replays.
// Every catalog entry says whether a model may write it (R4), and the four quota keys of MIN-233 D2
// are in the catalog with their defaults.

import { testDeviceHome } from "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SETTINGS_CATALOG,
  appendEvents,
  cachePath,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  sortWorkspaceSettings,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import {
  MODELS_TIERS_DEFAULT_VALUE,
  defaultModelsTiers,
  legacyTiersToModelsTiers,
  parseModelsTiers,
  readModelsTiers,
  validateModelsTiers,
} from "../dist/build/packages/core/src/models-tiers.js";
import { RENAMED_SETTING_KEYS, RETIRED_SETTING_KEYS } from "../dist/build/packages/core/src/settings.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 8, 0, second)).toISOString().replace(".000Z", "Z");
};

// The shape a v1.2.0 chain holds for the Claude Code economy tier (MIN-230 D1): the same model as the
// main tier at effort low. The model names are fixture names.
const LEGACY_TIERS = {
  "claude-code": {
    flagship: { model: "fixture-flagship", effort: "max" },
    main: { model: "fixture-main", effort: "max" },
    economy: { model: "fixture-main", effort: "low" },
  },
  codex: { flagship: null, main: null, economy: { model: "fixture-codex", effort: "max" } },
};
const LEGACY_VALUE = canonicalJson(LEGACY_TIERS);
const CARRIED_OVER = {
  "claude-code": {
    economy: { effort: "low", model: "fixture-main", runner: "claude-code" },
    flagship: { effort: "max", model: "fixture-flagship", runner: "claude-code" },
    main: { effort: "max", model: "fixture-main", runner: "claude-code" },
  },
  codex: { economy: { effort: "max", model: "fixture-codex", runner: "codex" } },
};

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-models-tiers-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: at() });
  return { base, workspace };
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function reasonOf(argv) {
  return runCli(argv, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

// A settings event exactly as the v1.2.0 core wrote it, appended raw: the member carries the record in
// its delta, as that core did while the key was live.
function recordedSetting(key, value, updatedAt, revision = 1) {
  const record = { schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision, updatedAt, tombstone: false };
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

async function append(workspace, members) {
  const occurredAt = at();
  return await appendEvents(workspace, members.map((member) => member(occurredAt)), { occurredAt });
}

// The three ways a chain is read: through this device's cache, replayed from genesis, and validate.
async function readEveryWay(workspace) {
  return {
    cached: await materializeWorkspace(workspace),
    genesis: await materializeWorkspaceFromGenesis(workspace),
    validate: await validateWorkspace(workspace),
  };
}

const tiersOf = (state) => state.settings.find((entry) => entry.key === "models.tiers");

test("484-R3: a recorded execution.dispatchTiers value reads as models.tiers with its host as runner, in every read", async (context) => {
  const { workspace } = await library(context);
  await append(workspace, [(occurredAt) => recordedSetting("execution.dispatchTiers", LEGACY_VALUE, occurredAt)]);
  for (const [read, state] of Object.entries(await readEveryWay(workspace))) {
    assert.equal(state.version, 1, read);
    assert.deepEqual(state.settings.map((entry) => entry.key), ["models.tiers"], `${read}: the old name is history, its value is the new name's`);
    assert.deepEqual(JSON.parse(tiersOf(state).value), CARRIED_OVER, `${read}: each row gains the host it sits under as its runner; a null row stays unfilled`);
    assert.equal(tiersOf(state).revision, 1, read);
    assert.deepEqual(readModelsTiers(state.settings), CARRIED_OVER, read);
  }
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  const entry = catalog.settings.find((setting) => setting.key === "models.tiers");
  assert.deepEqual(JSON.parse(entry.currentValue)["claude-code"].economy, { effort: "low", model: "fixture-main", runner: "claude-code" },
    "the economy tier at effort low carries over with its runner");
  assert.equal(entry.defaultValue, MODELS_TIERS_DEFAULT_VALUE);
  assert.equal(catalog.settings.some((setting) => setting.key === "execution.dispatchTiers"), false);
});

test("484-R3, AC3: a models.tiers write supersedes the carried-over value, and an economy tier can run on codex-cli", async (context) => {
  const { workspace } = await library(context);
  await append(workspace, [(occurredAt) => recordedSetting("execution.dispatchTiers", LEGACY_VALUE, occurredAt)]);
  const next = structuredClone(CARRIED_OVER);
  next["claude-code"].economy = { runner: "codex-cli", model: "fixture-codex", effort: "max" };
  next["claude-code"].review = { runner: "claude-code", model: "fixture-main", effort: "high" };
  delete next["claude-code"].flagship;
  const written = await cli(["settings-set", "--workspace", workspace, "--at", at(), "--key", "models.tiers", "--value", JSON.stringify(next)]);
  assert.equal(written.setting.key, "models.tiers");
  assert.equal(written.setting.revision, 2, "the write follows the carried-over record");
  const states = await readEveryWay(workspace);
  for (const [read, state] of Object.entries(states)) {
    assert.deepEqual(readModelsTiers(state.settings)["claude-code"], {
      economy: { effort: "max", model: "fixture-codex", runner: "codex-cli" },
      main: { effort: "max", model: "fixture-main", runner: "claude-code" },
      review: { effort: "high", model: "fixture-main", runner: "claude-code" },
    }, `${read}: tiers are added and removed freely, and a runner is any runner`);
  }
  assert.deepEqual(states.cached.settings, states.genesis.settings);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.equal(JSON.parse(catalog.settings.find((setting) => setting.key === "models.tiers").currentValue)["claude-code"].economy.runner, "codex-cli");
});

test("484-R3: removing the old name removes the carried-over value, and the catalog reads the default again", async (context) => {
  const { workspace } = await library(context);
  await append(workspace, [(occurredAt) => recordedSetting("execution.dispatchTiers", LEGACY_VALUE, occurredAt)]);
  await append(workspace, [(occurredAt) => removedSetting("execution.dispatchTiers", occurredAt)]);
  for (const [read, state] of Object.entries(await readEveryWay(workspace))) {
    assert.equal(state.version, 2, read);
    assert.deepEqual(state.settings, [], read);
    assert.deepEqual(state.library.rejectedEvents, [], `${read}: the removal is history, not a rejected event`);
    assert.deepEqual(readModelsTiers(state.settings), defaultModelsTiers(), read);
  }
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.equal(catalog.settings.find((setting) => setting.key === "models.tiers").currentValue, MODELS_TIERS_DEFAULT_VALUE);
});

test("484-R3: an old-layout workspace reads its execution.dispatchTiers as models.tiers", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-models-tiers-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root } = await restoreLegacyFixture(base);
  const catalog = await cli(["settings-catalog", "--workspace", root]);
  assert.deepEqual(JSON.parse(catalog.settings.find((setting) => setting.key === "models.tiers").currentValue), {
    "claude-code": { economy: { effort: "max", model: "claude-fixture-model", runner: "claude-code" } },
  }, "the fixture's flagship and main rows were null: unfilled, so left out");
  for (const key of ["execution.dispatchTiers", "execution.dispatchClasses", "execution.dispatchModes"]) {
    assert.equal(catalog.settings.some((setting) => setting.key === key), false, key);
  }
});

// A chain whose cache snapshot was taken while the old name was the only record: version 1 sets an
// interval of two events and one append records the old name and a live key, ending on version 3, where
// the next read writes the snapshot. The append's delta held the old name, as a 1.2.0 core's did; the
// snapshot and the read seeded from it hold what a replay from genesis holds.
test("484-R3: a cache snapshot taken after the old name was recorded seeds the same settings as genesis", async (context) => {
  const { workspace } = await library(context);
  await append(workspace, [(occurredAt) => recordedSetting("storage.snapshotEveryEvents", "2", occurredAt)]);
  await append(workspace, [
    (occurredAt) => recordedSetting("execution.dispatchTiers", LEGACY_VALUE, occurredAt),
    (occurredAt) => recordedSetting("artifact.language", "zh-CN", occurredAt),
  ]);
  await materializeWorkspace(workspace);
  const libraryId = (await materializeWorkspaceFromGenesis(workspace)).metadata.workspaceId;
  const directory = join(cachePath(libraryId, testDeviceHome), "snapshots");
  const header = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
  const snapshot = JSON.parse(await readFile(join(directory, `${header.stateDigest}.json`), "utf8"));
  assert.deepEqual([header.version, snapshot.settings.map((entry) => entry.key)], [3, ["artifact.language", "models.tiers", "storage.snapshotEveryEvents"]]);
  const { result: seeded, metrics } = await withWorkspacePerfInstrumentation(() => materializeWorkspace(workspace));
  assert.equal(metrics.snapshotMaterialize, 1, "the read was seeded from the snapshot");
  const genesis = await materializeWorkspaceFromGenesis(workspace);
  assert.deepEqual(seeded.settings, genesis.settings);
  assert.deepEqual(JSON.parse(tiersOf(genesis).value), CARRIED_OVER);
});

const RETIRED_BY_484 = [
  "backup.cadence",
  "backup.destination",
  "driver.capabilityProfile",
  "execution.claudeCodeSubagentPlan",
  "execution.codexSubagentPlan",
  "execution.dispatchClasses",
  "execution.dispatchMode",
  "execution.dispatchModes",
  "execution.dispatchTiers",
  "execution.maxDispatchDepth",
  "execution.subagentPolicy",
  "storage.backend",
];

test("484-AC4: settings-set execution.dispatchMode is SETTINGS_KEY_UNREGISTERED, as is every key 484 retires", async (context) => {
  const { workspace } = await library(context);
  assert.equal(await reasonOf(["settings-set", "--workspace", workspace, "--at", at(), "--key", "execution.dispatchMode", "--value", "frontier"]), "SETTINGS_KEY_UNREGISTERED");
  for (const key of RETIRED_BY_484) {
    assert.equal(await reasonOf(["settings-set", "--workspace", workspace, "--at", at(), "--key", key, "--value", "manual"]), "SETTINGS_KEY_UNREGISTERED", key);
    assert.ok(RETIRED_SETTING_KEYS.includes(key), `${key} keeps its replay marker`);
  }
  assert.deepEqual(RENAMED_SETTING_KEYS, { "execution.dispatchTiers": "models.tiers" });
  assert.equal((await validateWorkspace(workspace)).version, 0, "no refusal appended an event");
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.deepEqual(RETIRED_BY_484.filter((key) => catalog.settings.some((entry) => entry.key === key)), []);
  assert.equal(catalog.settings.some((entry) => entry.key === "execution.maxConcurrentSubagents"), true, "R5 keeps maxConcurrentSubagents (MIN-229 D2)");
});

test("484-R3: the history of every key 484 retires still replays, and none of it becomes a current setting", async (context) => {
  const { workspace } = await library(context);
  const values = {
    "backup.cadence": "manual",
    "backup.destination": "/backups/elsewhere",
    "driver.capabilityProfile": "default",
    "execution.claudeCodeSubagentPlan": "plan-a",
    "execution.codexSubagentPlan": "plan-b",
    "execution.dispatchClasses": canonicalJson({ implement: { dispatch: true, verify: true } }),
    "execution.dispatchMode": "eco",
    "execution.dispatchModes": canonicalJson({ eco: { implement: "economy" } }),
    "execution.maxDispatchDepth": "2",
    "execution.subagentPolicy": "review-only",
    "storage.backend": "file",
  };
  await append(workspace, Object.entries(values).map(([key, value]) => (occurredAt) => recordedSetting(key, value, occurredAt)));
  await append(workspace, [(occurredAt) => removedSetting("backup.cadence", occurredAt)]);
  for (const [read, state] of Object.entries(await readEveryWay(workspace))) {
    assert.equal(state.version, 12, read);
    assert.deepEqual(state.settings, [], `${read}: recorded values of retired keys are history`);
    assert.deepEqual(state.library.rejectedEvents, [], read);
  }
});

test("484-R3: models.tiers validation names the field it refuses", () => {
  const valid = { "claude-code": { economy: { runner: "codex-cli", model: "fixture-codex", effort: "max" } } };
  assert.deepEqual(validateModelsTiers(valid), valid);
  assert.deepEqual(parseModelsTiers(JSON.stringify(valid)), valid);
  const refusals = [
    [[], "models.tiers"],
    [{ "Claude-Code": {} }, "models.tiers.Claude-Code"],
    [{ codex: [] }, "models.tiers.codex"],
    [{ codex: { economy: { model: "m", effort: "low" } } }, "models.tiers.codex.economy"],
    [{ codex: { economy: { runner: "codex", model: "m", effort: "low", note: "x" } } }, "models.tiers.codex.economy"],
    [{ codex: { economy: { runner: "", model: "m", effort: "low" } } }, "models.tiers.codex.economy.runner"],
    [{ codex: { economy: { runner: "codex", model: "m\nn", effort: "low" } } }, "models.tiers.codex.economy.model"],
    [{ codex: { economy: { runner: "codex", model: "m", effort: 3 } } }, "models.tiers.codex.economy.effort"],
    [{ codex: { "": { runner: "codex", model: "m", effort: "low" } } }, "models.tiers.codex."],
  ];
  for (const [value, path] of refusals) {
    assert.throws(() => validateModelsTiers(value), (error) => error?.reasonCode === "MODELS_TIERS_INVALID" && error.details.path === path, path);
  }
  assert.throws(() => parseModelsTiers("{"), (error) => error?.reasonCode === "MODELS_TIERS_INVALID");
});

test("484-R3: the default table and the legacy mapping", () => {
  const defaults = defaultModelsTiers();
  assert.deepEqual(Object.keys(defaults), ["claude-code", "codex"]);
  for (const host of ["claude-code", "codex"]) {
    assert.deepEqual(defaults[host], Object.fromEntries(["economy", "flagship", "main"].map((tier) => [tier, { effort: "", model: "", runner: host }])));
  }
  assert.equal(MODELS_TIERS_DEFAULT_VALUE, canonicalJson(defaults));
  assert.deepEqual(readModelsTiers([]), defaults, "an unset models.tiers reads as the default table");
  assert.deepEqual(legacyTiersToModelsTiers(LEGACY_TIERS), CARRIED_OVER);
  assert.throws(() => legacyTiersToModelsTiers({ codex: { economy: { model: "m" } } }), (error) => error?.reasonCode === "MODELS_TIERS_INVALID");
  assert.throws(() => legacyTiersToModelsTiers("codex"), (error) => error?.reasonCode === "MODELS_TIERS_INVALID");
});

test("484-R4, MIN-233 D2: every catalog entry says whether a model may write it, and the quota keys carry their defaults", async (context) => {
  const { workspace } = await library(context);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.deepEqual(catalog.settings.map((entry) => [entry.key, entry.modelWritable]), SETTINGS_CATALOG.map((entry) => [entry.key, false]));
  const quota = Object.fromEntries(catalog.settings.filter((entry) => entry.key.startsWith("quota.")).map((entry) => [entry.key, [entry.defaultValue, entry.currentValue, entry.controlType, entry.min, entry.max]]));
  assert.deepEqual(quota, {
    "quota.fiveHourParallelOffPercent": ["75", "75", "number", 1, 100],
    "quota.fiveHourWaitPercent": ["90", "90", "number", 1, 100],
    "quota.weeklyParallelOffPercent": ["95", "95", "number", 1, 100],
    "quota.weeklyWaitPercent": [null, null, "number", 1, 100],
  });
  for (const value of ["0", "101", "7.5"]) {
    assert.equal(await reasonOf(["settings-set", "--workspace", workspace, "--at", at(), "--key", "quota.weeklyWaitPercent", "--value", value]), "SETTINGS_VALUE_INVALID", value);
  }
  const set = await cli(["settings-set", "--workspace", workspace, "--at", at(), "--key", "quota.weeklyWaitPercent", "--value", "98"]);
  assert.equal(set.setting.value, "98");
});
