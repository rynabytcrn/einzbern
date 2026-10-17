// SPDX-License-Identifier: Apache-2.0
import { appendHistoricalModelSetting, historicalValidationRefusal } from "./helpers/historical-model-settings.mjs";
// TCRN-CROSS-STORY-484 R3, R4, R5 (TCRN-CROSS-SUB-339): the settings shrink.
// execution.dispatchTiers is renamed models.tiers; a recorded execution.dispatchTiers value reads as
// models.tiers, with the host a row sits under as its runner, until a models.tiers write supersedes
// it. The dispatch keys, the keys of the switched-off mechanisms and the keys nothing reads retire: a
// new write is refused and their history replays. Every catalog entry says whether a model may write
// it (R4), and the four quota keys of MIN-233 D2 are in the catalog with their defaults.
//
// TCRN-CROSS-STORY-508 R2, R4, AC2, AC3 (MIN-236 D5, D6; TCRN-CROSS-SUB-405): models.tiers is one
// table of records {order, category, runner, model, effort, note}. A legacy value, per host or the
// renamed execution.dispatchTiers, reads as records without its event changing; a record naming a
// missing category, or repeating another's order, is refused when written; a category's base record
// is its largest order. models.category, the parent table, has tests/models-category.test.mjs.

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
  baseModelsTier,
  cachePath,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  readModelsCategory,
  sortWorkspaceSettings,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import {
  MODELS_TIERS_DEFAULT_VALUE,
  defaultModelsTiers,
  legacyHostTiersToModelsTiers,
  legacyTiersToModelsTiers,
  parseModelsTiers,
  readModelsTiers,
  validateModelsTiers,
} from "../dist/build/packages/core/src/models-tiers.js";
import { MODELS_CATEGORY_DEFAULT_VALUE } from "../dist/build/packages/core/src/models-category.js";
import { RENAMED_SETTING_KEYS, RETIRED_SETTING_KEYS, currentSettingRecord } from "../dist/build/packages/core/src/settings.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

// Historical model scenarios below use explicit archived-event fixtures; actual CLI writes
// are separately asserted to refuse device-owned keys. Other CLI reads/writes remain real.
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
// What it reads as (TCRN-CROSS-STORY-508 R2): a record per host and tier, the null rows left out,
// numbered from 10 in steps of 10 category by category (flagship, main, economy), and within a
// category codex before claude-code, so claude-code's record is each category's base.
const record = (order, category, runner, model, effort, note = "") => ({ order, category, runner, model, effort, note });
const CARRIED_OVER = [
  record(10, "flagship", "claude-code", "fixture-flagship", "max"),
  record(20, "main", "claude-code", "fixture-main", "max"),
  record(30, "economy", "codex", "fixture-codex", "max"),
  record(40, "economy", "claude-code", "fixture-main", "low"),
];
// The TCRN-CROSS-STORY-484 default table as that change recorded it: per host, the default tiers.
const HOST_DEFAULTS = Object.fromEntries(["claude-code", "codex"].map((host) => [
  host,
  Object.fromEntries(["flagship", "main", "economy"].map((tier) => [tier, { runner: host, model: "", effort: "" }])),
]));
const DEFAULT_RECORDS = [
  record(10, "flagship", "codex", "", ""),
  record(20, "flagship", "claude-code", "", ""),
  record(30, "main", "codex", "", ""),
  record(40, "main", "claude-code", "", ""),
  record(50, "economy", "codex", "", ""),
  record(60, "economy", "claude-code", "", ""),
];

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

function refusalOf(argv) {
  return runCli(argv, { write() {} }).then(() => assert.fail(`${argv[0]} was not refused`), (error) => error);
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
const setTiers = (workspace, value) => ["settings-set", "--workspace", workspace, "--at", at(), "--key", "models.tiers", "--value", JSON.stringify(value)];

test("484-R3, 508-AC2: a recorded execution.dispatchTiers value reads as models.tiers records with its host as runner, in every read", async (context) => {
  const { workspace } = await library(context);
  await append(workspace, [(occurredAt) => recordedSetting("execution.dispatchTiers", LEGACY_VALUE, occurredAt)]);
  for (const [read, state] of Object.entries(await readEveryWay(workspace))) {
    assert.equal(state.version, 1, read);
    assert.deepEqual(state.settings.map((entry) => entry.key), ["models.tiers"], `${read}: the old name is history, its value is the new name's`);
    assert.deepEqual(JSON.parse(tiersOf(state).value), CARRIED_OVER, `${read}: each row gains the host it sits under as its runner; a null row stays unfilled`);
    assert.equal(tiersOf(state).value, canonicalJson(CARRIED_OVER), `${read}: the carried-over value is canonical, in ascending order`);
    assert.equal(tiersOf(state).revision, 1, read);
    assert.deepEqual(readModelsTiers(state.settings), CARRIED_OVER, read);
    // AC2: the categories hold economy, main and flagship, every record names one, and no two
    // records share an order.
    const categories = readModelsCategory(state.settings).map((category) => category.id);
    assert.deepEqual(["economy", "main", "flagship"].filter((id) => !categories.includes(id)), [], read);
    assert.deepEqual(CARRIED_OVER.filter((entry) => !categories.includes(entry.category)), [], read);
    assert.equal(new Set(readModelsTiers(state.settings).map((entry) => entry.order)).size, CARRIED_OVER.length, read);
  }
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  const entry = catalog.settings.find((setting) => setting.key === "models.tiers");
  assert.deepEqual(baseModelsTier(JSON.parse(entry.currentValue), "economy"), record(40, "economy", "claude-code", "fixture-main", "low"),
    "the economy tier at effort low carries over with its runner, and is the economy category's base record");
  assert.equal(entry.defaultValue, MODELS_TIERS_DEFAULT_VALUE);
  assert.equal(catalog.settings.find((setting) => setting.key === "models.category").currentValue, MODELS_CATEGORY_DEFAULT_VALUE,
    "the tiers name only default categories, so the categories are the default table");
  assert.equal(catalog.settings.some((setting) => setting.key === "execution.dispatchTiers"), false);
});

test("484-R3, AC3: a models.tiers write supersedes the carried-over value, and an economy tier can run on codex-cli", async (context) => {
  const { workspace } = await library(context);
  await append(workspace, [(occurredAt) => recordedSetting("execution.dispatchTiers", LEGACY_VALUE, occurredAt)]);
  const next = [
    record(30, "economy", "codex-cli", "fixture-codex", "max", "runs outside the host"),
    record(20, "main", "claude-code", "fixture-main", "max"),
    record(25, "main", "claude-code", "fixture-main", "high"),
  ];
  const written = await appendHistoricalModelSetting(setTiers(workspace, next));
  assert.equal(written.setting.key, "models.tiers");
  assert.equal(written.setting.revision, 2, "the write follows the carried-over record");
  const sorted = [next[1], next[2], next[0]];
  assert.equal(written.setting.value, canonicalJson(sorted), "the table is stored as canonical JSON in ascending order");
  const states = await readEveryWay(workspace);
  for (const [read, state] of Object.entries(states)) {
    assert.deepEqual(readModelsTiers(state.settings), sorted, `${read}: records are added and removed freely, and a runner is any runner`);
  }
  assert.deepEqual(states.cached.settings, states.genesis.settings);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.equal(baseModelsTier(JSON.parse(catalog.settings.find((setting) => setting.key === "models.tiers").currentValue), "economy").runner, "codex-cli");
});

test("Historical validator/replay 508-AC3: a models.tiers record that names a missing category, or repeats another record's order, is refused, and nothing is recorded", async (context) => {
  const { workspace } = await library(context);
  const unknown = await historicalValidationRefusal(setTiers(workspace, [record(10, "economy", "codex", "m", "low"), record(20, "cheap", "codex", "m", "low")]));
  assert.equal(unknown.reasonCode, "MODELS_CATEGORY_UNKNOWN");
  assert.deepEqual([unknown.details.path, unknown.details.category, unknown.details.references], ["models.tiers.20.category", "cheap", ["models.tiers.20"]]);
  const repeated = await historicalValidationRefusal(setTiers(workspace, [record(10, "economy", "codex", "m", "low"), record(10, "main", "codex", "m", "max")]));
  assert.equal(repeated.reasonCode, "MODELS_ORDER_DUPLICATE");
  assert.deepEqual([repeated.details.path, repeated.details.order], ["models.tiers[1].order", 10]);
  assert.equal((await validateWorkspace(workspace)).version, 0, "no refusal appended an event");
  // The category exists once models.category holds it, and the same record is then accepted.
  const categories = [...JSON.parse(MODELS_CATEGORY_DEFAULT_VALUE), { id: "cheap", name: "Cheap", description: "", order: 40 }];
  await appendHistoricalModelSetting(["settings-set", "--workspace", workspace, "--at", at(), "--key", "models.category", "--value", JSON.stringify(categories)]);
  const accepted = await appendHistoricalModelSetting(setTiers(workspace, [record(10, "economy", "codex", "m", "low"), record(20, "cheap", "codex", "m", "low")]));
  assert.deepEqual(JSON.parse(accepted.setting.value).map((entry) => entry.category), ["economy", "cheap"]);
  assert.equal((await validateWorkspace(workspace)).version, 2);
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
  assert.deepEqual(JSON.parse(catalog.settings.find((setting) => setting.key === "models.tiers").currentValue), [
    record(10, "economy", "claude-code", "claude-fixture-model", "max"),
  ], "the fixture's flagship and main rows were null: unfilled, so left out");
  for (const key of ["execution.dispatchTiers", "execution.dispatchClasses", "execution.dispatchModes"]) {
    assert.equal(catalog.settings.some((setting) => setting.key === key), false, key);
  }
});

test("Historical validator/replay 508-R2: a models.tiers value TCRN-CROSS-STORY-484 recorded, one table per host, reads as records in every read, and its event keeps its bytes", async (context) => {
  const { workspace } = await library(context);
  const perHost = {
    "claude-code": {
      main: { runner: "claude-code", model: "fixture-main", effort: "max" },
      review: { runner: "claude-code", model: "fixture-review", effort: "high" },
    },
    codex: {
      economy: { runner: "codex-cli", model: "fixture-codex", effort: "low" },
      main: { runner: "codex", model: "fixture-codex-main", effort: "high" },
    },
  };
  const value = canonicalJson(perHost);
  await append(workspace, [(occurredAt) => recordedSetting("models.tiers", value, occurredAt)]);
  // main (codex, then claude-code), economy, then the tier name outside the defaults as a category of
  // its own.
  const expected = [
    record(10, "main", "codex", "fixture-codex-main", "high"),
    record(20, "main", "claude-code", "fixture-main", "max"),
    record(30, "economy", "codex-cli", "fixture-codex", "low"),
    record(40, "review", "claude-code", "fixture-review", "high"),
  ];
  for (const [read, state] of Object.entries(await readEveryWay(workspace))) {
    assert.deepEqual(readModelsTiers(state.settings), expected, read);
    assert.equal(tiersOf(state).value, canonicalJson(expected), `${read}: the current value is the records`);
    assert.deepEqual(state.library.rejectedEvents, [], read);
    assert.equal(state.events[0].payload.record.value, value, `${read}: the event keeps the value it recorded`);
  }
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.deepEqual(JSON.parse(catalog.settings.find((setting) => setting.key === "models.category").currentValue).map((category) => [category.id, category.order]),
    [["flagship", 10], ["main", 20], ["economy", 30], ["review", 40]], "an unset models.category holds the tier name outside the defaults, by name after them");
  // The derived category exists for the next write, and a name that is nowhere is still refused.
  await appendHistoricalModelSetting(setTiers(workspace, [record(40, "review", "claude-code", "fixture-review", "max")]));
  assert.equal((await historicalValidationRefusal(setTiers(workspace, [record(40, "audit", "claude-code", "fixture-review", "max")]))).reasonCode, "MODELS_CATEGORY_UNKNOWN");
  // A snapshot another build wrote before the record table seeds the same records a replay holds.
  const legacy = { schemaVersion: "tcrn.workspace-setting.v1", key: "models.tiers", layerKind: "workspace_configuration", value, revision: 1, updatedAt: at(), tombstone: false };
  assert.deepEqual(currentSettingRecord(legacy), { ...legacy, value: canonicalJson(expected) });
  const language = { ...legacy, key: "artifact.language", value: "en" };
  assert.equal(currentSettingRecord(language), language, "every other record is left as it is");
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

test("Historical validator/replay 508-R2: models.tiers validation names the field it refuses", () => {
  const valid = [record(20, "economy", "codex-cli", "fixture-codex", "max"), record(10, "main", "claude-code", "fixture-main", "max", "the reviewer")];
  assert.deepEqual(validateModelsTiers(valid), [valid[1], valid[0]], "read in ascending order");
  assert.deepEqual(validateModelsTiers([]), [], "an empty table is a table");
  const long = record(10001, "economy", "codex", "m".repeat(257), "ultra", "n".repeat(257));
  assert.deepEqual(validateModelsTiers([long]), [long], "former field/order ceilings are not admission limits");
  assert.deepEqual(parseModelsTiers(JSON.stringify(valid)), [valid[1], valid[0]]);
  const one = (fields) => [{ ...record(10, "economy", "codex", "m", "low"), ...fields }];
  const refusals = [
    [{ codex: {} }, "models.tiers"],
    ["records", "models.tiers"],
    [[null], "models.tiers[0]"],
    [[{ order: 10, category: "economy", runner: "codex", model: "m", effort: "low" }], "models.tiers[0]"],
    [one({ host: "codex" }), "models.tiers[0]"],
    [one({ order: 0 }), "models.tiers[0].order"],
    [one({ order: 1.5 }), "models.tiers[0].order"],
    [one({ order: "10" }), "models.tiers[0].order"],
    [one({ category: "Economy" }), "models.tiers[0].category"],
    [one({ runner: "" }), "models.tiers[0].runner"],
    [one({ model: "m\nn" }), "models.tiers[0].model"],
    [one({ effort: 3 }), "models.tiers[0].effort"],
    [one({ note: "tab\there" }), "models.tiers[0].note"],
  ];
  for (const [value, path] of refusals) {
    assert.throws(() => validateModelsTiers(value), (error) => error?.reasonCode === "MODELS_TIERS_INVALID" && error.details.path === path, path);
  }
  assert.throws(() => validateModelsTiers([...one({}), ...one({ category: "main" })]),
    (error) => error?.reasonCode === "MODELS_ORDER_DUPLICATE" && error.details.path === "models.tiers[1].order" && error.details.order === 10);
  assert.throws(() => parseModelsTiers("{"), (error) => error?.reasonCode === "MODELS_TIERS_INVALID");
  // A write takes the array only; a read still takes the per-host value TCRN-CROSS-STORY-484 recorded.
  assert.deepEqual(parseModelsTiers(canonicalJson(HOST_DEFAULTS)), DEFAULT_RECORDS);
});

test("Historical validator/replay 508-R2: a write refuses the per-host value and stores the array in canonical order", async (context) => {
  const { workspace } = await library(context);
  const perHost = await historicalValidationRefusal(setTiers(workspace, { codex: { economy: { runner: "codex", model: "m", effort: "low" } } }));
  assert.deepEqual([perHost.reasonCode, perHost.details.path], ["SETTINGS_VALUE_INVALID", "models.tiers"]);
  const noNote = await historicalValidationRefusal(setTiers(workspace, [{ order: 10, category: "economy", runner: "codex", model: "m", effort: "low" }]));
  assert.deepEqual([noNote.reasonCode, noNote.details.path], ["SETTINGS_VALUE_INVALID", "models.tiers[0]"]);
  const written = await appendHistoricalModelSetting(["settings-set", "--workspace", workspace, "--at", at(), "--key", "models.tiers",
    "--value", ` [ {"runner":"codex","order":20,"note":"","model":"m","effort":"low","category":"economy"}, {"order":10,"category":"main","runner":"codex","model":"m","effort":"max","note":""} ] `]);
  assert.equal(written.setting.value, canonicalJson([record(10, "main", "codex", "m", "max"), record(20, "economy", "codex", "m", "low")]));
});

test("Historical validator/replay 508-R4: a category's base record is its largest order, whatever its runner; a category without a record is MODELS_CATEGORY_EMPTY", () => {
  const tiers = validateModelsTiers([
    record(10, "main", "claude-code", "fixture-main", "max"),
    record(30, "economy", "codex-cli", "fixture-codex", "low"),
    record(40, "economy", "claude-code", "fixture-main", "low"),
    record(20, "main", "codex", "fixture-codex-main", "high"),
  ]);
  assert.equal(baseModelsTier(tiers, "economy").order, 40);
  assert.equal(baseModelsTier(tiers, "main").runner, "codex", "no runner filter: the largest order wins");
  assert.throws(() => baseModelsTier(tiers, "flagship"), (error) => error?.reasonCode === "MODELS_CATEGORY_EMPTY" && error.details.category === "flagship");
  assert.throws(() => baseModelsTier([], "economy"), (error) => error?.reasonCode === "MODELS_CATEGORY_EMPTY");
  assert.deepEqual(baseModelsTier(defaultModelsTiers(), "economy"), record(60, "economy", "claude-code", "", ""), "the default economy base is claude-code's record");
});

test("Historical validator/replay 508-R2: the default table is the TCRN-CROSS-STORY-484 default read as records, and the legacy mappings", () => {
  const defaults = defaultModelsTiers();
  assert.deepEqual(defaults, DEFAULT_RECORDS);
  assert.equal(MODELS_TIERS_DEFAULT_VALUE, canonicalJson(defaults));
  assert.deepEqual(readModelsTiers([]), defaults, "an unset models.tiers reads as the default table");
  // Equivalent to the old default: every host and tier once, the host as runner, unfilled.
  assert.deepEqual(defaults.map((entry) => `${entry.runner} ${entry.category} ${entry.model}|${entry.effort}|${entry.note}`).sort(),
    Object.entries(HOST_DEFAULTS).flatMap(([host, tiers]) => Object.keys(tiers).map((tier) => `${host} ${tier} ||`)).sort());
  assert.deepEqual(legacyHostTiersToModelsTiers(HOST_DEFAULTS), defaults);
  assert.deepEqual(legacyTiersToModelsTiers(LEGACY_TIERS), CARRIED_OVER);
  assert.throws(() => legacyTiersToModelsTiers({ codex: { economy: { model: "m" } } }), (error) => error?.reasonCode === "MODELS_TIERS_INVALID");
  assert.throws(() => legacyTiersToModelsTiers("codex"), (error) => error?.reasonCode === "MODELS_TIERS_INVALID");
  assert.throws(() => legacyHostTiersToModelsTiers({ codex: { economy: { model: "m", effort: "low" } } }),
    (error) => error?.reasonCode === "MODELS_TIERS_INVALID" && error.details.path === "models.tiers.codex.economy");
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
    assert.equal((await historicalValidationRefusal(["settings-set", "--workspace", workspace, "--at", at(), "--key", "quota.weeklyWaitPercent", "--value", value])).reasonCode, "SETTINGS_VALUE_INVALID", value);
    assert.equal(await reasonOf(["settings-set", "--workspace", workspace, "--at", at(), "--key", "quota.weeklyWaitPercent", "--value", value]), "SETTINGS_KEY_DEVICE_LEVEL");
  }
  const set = await appendHistoricalModelSetting(["settings-set", "--workspace", workspace, "--at", at(), "--key", "quota.weeklyWaitPercent", "--value", "98"]);
  assert.equal(set.setting.value, "98");
});
