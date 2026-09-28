// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-508 R3, R4, AC1, AC5 (MIN-236 D5, D6; TCRN-CROSS-SUB-406): the three
// models.escalation settings and the escalation along the order of models.tiers. The keys are
// scalars of the models group, true, 1 and main by default; a model does not write them through the
// CLI, and a ceiling must name a category models.category holds when it is written. resolveModelsTier
// is a pure function: from a category's base record it escalates one record for every threshold
// rejections its caller passes in, across categories and runners, up to the ceiling category's record
// with the smallest order, and not at all while escalation is disabled. The engine keeps no count.

import "./helpers/device-home.mjs";
import { standInForAtelier, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SETTINGS_CATALOG,
  appendEvents,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  readModelsCategory,
  readModelsEscalation,
  readModelsTiers,
  resolveModelsTier,
  sortWorkspaceSettings,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import { MODELS_ESCALATION_SETTING_KEYS } from "../dist/build/packages/core/src/models-escalation.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does; a model's
// shell is withSurface(undefined, ...).
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 28, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const category = (id, order, name = id, description = "") => ({ id, name, description, order });
const record = (order, categoryId, runner, model = "", effort = "", note = "") => ({ order, category: categoryId, runner, model, effort, note });
const DEFAULT_CATEGORIES = [category("flagship", 10), category("main", 20), category("economy", 30)];
const DEFAULT_ESCALATION = { enabled: true, threshold: 1, ceiling: "main" };
const CEILING = "models.escalation.ceiling";

// Two economy records and two main records, their runners crossed; model names are fixture names.
const TIERS = [
  record(10, "flagship", "claude-code", "fixture-flagship", "max"),
  record(20, "main", "codex", "fixture-codex-main", "high"),
  record(30, "main", "claude-code", "fixture-main", "max"),
  record(40, "economy", "codex", "fixture-codex", "low"),
  record(50, "economy", "claude-code", "fixture-economy", "low"),
];

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-models-escalation-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: at() });
  return workspace;
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function refusalOf(argv) {
  return runCli(argv, { write() {} }).then(() => assert.fail(`${argv[0]} was not refused`), (error) => error);
}

const set = (workspace, key, value) => ["settings-set", "--workspace", workspace, "--at", at(), "--key", key, "--value", typeof value === "string" ? value : JSON.stringify(value)];
const remove = (workspace, key) => ["settings-remove", "--workspace", workspace, "--at", at(), "--key", key];
const versionOf = async (workspace) => (await validateWorkspace(workspace)).version;

// resolveModelsTier over TIERS and the default categories, with the default escalation unless told otherwise.
const resolve = (category, rejections, escalation = {}, tiers = TIERS, categories = DEFAULT_CATEGORIES) =>
  resolveModelsTier({ categories, tiers, escalation: { ...DEFAULT_ESCALATION, ...escalation }, category, rejections });
const orderOf = (resolution) => [resolution.record.order, resolution.steps, resolution.atCeiling];

function refusedWith(operation, reasonCode, details = {}) {
  assert.throws(operation, (error) => {
    assert.equal(error?.reasonCode, reasonCode, error?.message);
    for (const [key, value] of Object.entries(details)) assert.deepEqual(error.details?.[key], value, key);
    return true;
  });
}

test("508-AC1: GIVEN a new library WHEN settings-catalog THEN the three models.escalation keys are scalars of the models group, true, 1 and main by default", async (context) => {
  const workspace = await library(context);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  const rows = MODELS_ESCALATION_SETTING_KEYS.map((key) => catalog.settings.find((entry) => entry.key === key));
  assert.deepEqual(rows.map((row) => [row.key, row.layer, row.shape, row.group, row.order, row.defaultValue, row.currentValue, row.modelWritable]), [
    ["models.escalation.enabled", "project", "scalar", "models", 3, "true", "true", false],
    ["models.escalation.threshold", "project", "scalar", "models", 4, "1", "1", false],
    ["models.escalation.ceiling", "project", "scalar", "models", 5, "main", "main", false],
  ]);
  const [enabled, threshold, ceiling] = rows;
  assert.deepEqual([enabled.type, enabled.controlType, enabled.allowedValues, enabled.trueValue, enabled.falseValue], ["enum", "boolean", ["false", "true"], "true", "false"]);
  assert.deepEqual([threshold.type, threshold.controlType, threshold.min, threshold.max], ["string", "number", 1, 100]);
  assert.deepEqual([ceiling.type, ceiling.controlType], ["string", "text"]);
  // The models group: the two tables, then the three keys.
  assert.deepEqual(catalog.settings.filter((entry) => entry.group === "models").sort((left, right) => left.order - right.order).map((entry) => [entry.key, entry.shape]), [
    ["models.category", "collection"],
    ["models.tiers", "collection"],
    ["models.escalation.enabled", "scalar"],
    ["models.escalation.threshold", "scalar"],
    ["models.escalation.ceiling", "scalar"],
  ]);
  assert.deepEqual(readModelsEscalation((await materializeWorkspace(workspace)).settings), DEFAULT_ESCALATION);
  assert.deepEqual(readModelsEscalation([]), DEFAULT_ESCALATION, "an unset key reads as its default");
  // A system setting's key is not a custom variable's name, and these three are system settings now.
  for (const key of MODELS_ESCALATION_SETTING_KEYS) {
    const refused = await refusalOf(["variable-set", "--workspace", workspace, "--at", at(), "--name", key, "--type", "string", "--value", "x"]);
    assert.deepEqual([refused.reasonCode, refused.details.reason], ["VARIABLE_NAME_INVALID", "system-setting"], key);
  }
  assert.equal(await versionOf(workspace), 0);
});

test("508-R3: GIVEN the CLI run from a model's shell WHEN it writes a models.escalation key THEN it is refused with the remedy of changing it in Atelier, and nothing is recorded", async (context) => {
  const workspace = await library(context);
  const writes = [
    () => set(workspace, "models.escalation.enabled", "false"),
    () => set(workspace, "models.escalation.threshold", "2"),
    () => set(workspace, CEILING, "flagship"),
  ];
  for (const argv of writes) {
    const args = argv();
    const refused = await withSurface(undefined, () => refusalOf(args));
    assert.deepEqual([refused.reasonCode, { ...refused.details }], ["MODEL_WRITE_REFUSED", { key: args[args.indexOf("--key") + 1], remedy: "change it in Atelier" }]);
  }
  assert.equal(await versionOf(workspace), 0, "no refused write appended an event");
  // Run for Atelier the same writes commit, and a model may not remove them either.
  for (const argv of writes) assert.equal((await cli(argv())).reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.deepEqual(readModelsEscalation((await materializeWorkspace(workspace)).settings), { enabled: false, threshold: 2, ceiling: "flagship" });
  for (const key of MODELS_ESCALATION_SETTING_KEYS) {
    assert.equal((await withSurface(undefined, () => refusalOf(remove(workspace, key)))).reasonCode, "MODEL_WRITE_REFUSED", key);
  }
  assert.equal(await versionOf(workspace), 3);
  for (const key of MODELS_ESCALATION_SETTING_KEYS) await cli(remove(workspace, key));
  assert.deepEqual(readModelsEscalation((await materializeWorkspace(workspace)).settings), DEFAULT_ESCALATION, "removed, each key reads as its default again");
  // No catalog entry says a model may write it.
  assert.deepEqual(SETTINGS_CATALOG.filter((entry) => entry.key.startsWith("models.escalation.")).map((entry) => [entry.key, entry.modelWritable]),
    MODELS_ESCALATION_SETTING_KEYS.map((key) => [key, false]).sort(([left], [right]) => (left < right ? -1 : 1)));
});

test("508-R3: GIVEN a value outside its bounds, or a ceiling models.category does not hold, WHEN written THEN it is refused and nothing is recorded", async (context) => {
  const workspace = await library(context);
  for (const [key, value] of [
    ["models.escalation.enabled", "yes"],
    ["models.escalation.enabled", "True"],
    ["models.escalation.threshold", "0"],
    ["models.escalation.threshold", "101"],
    ["models.escalation.threshold", "1.5"],
    [CEILING, "Main"],
    [CEILING, "main tier"],
  ]) {
    assert.equal((await refusalOf(set(workspace, key, value))).reasonCode, "SETTINGS_VALUE_INVALID", `${key} ${value}`);
  }
  assert.equal((await refusalOf(set(workspace, CEILING, "Main"))).details.path, CEILING);
  const unknown = await refusalOf(set(workspace, CEILING, "cheap"));
  assert.deepEqual([unknown.reasonCode, unknown.details.path, unknown.details.category], ["MODELS_CATEGORY_UNKNOWN", CEILING, "cheap"]);
  assert.equal(await versionOf(workspace), 0, "no refusal appended an event");

  // Once models.category holds the category, the same ceiling is accepted.
  await cli(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("cheap", 40)]));
  assert.equal((await cli(set(workspace, CEILING, "cheap"))).setting.value, "cheap");
  assert.equal((await cli(set(workspace, "models.escalation.threshold", "100"))).setting.value, "100");
  // settings-remove puts main back, so it is checked the same way: refused while the table lacks main.
  await cli(set(workspace, "models.tiers", [record(10, "flagship", "claude-code"), record(20, "economy", "claude-code")]));
  await cli(set(workspace, "models.category", [category("flagship", 10), category("economy", 30), category("cheap", 40)]));
  const before = await versionOf(workspace);
  const removal = await refusalOf(remove(workspace, CEILING));
  assert.deepEqual([removal.reasonCode, removal.details.path, removal.details.category], ["MODELS_CATEGORY_UNKNOWN", CEILING, "main"]);
  assert.equal(await versionOf(workspace), before);
  await cli(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("cheap", 40)]));
  await cli(remove(workspace, CEILING));
  assert.equal(readModelsEscalation((await materializeWorkspace(workspace)).settings).ceiling, "main");
});

test("508-R3: replay checks a recorded ceiling's name and not its category; a ceiling a merge left without its category is refused where it is used", async (context) => {
  const workspace = await library(context);
  const occurredAt = at();
  const setting = { schemaVersion: "tcrn.workspace-setting.v1", key: CEILING, layerKind: "workspace_configuration", value: "review", revision: 1, updatedAt: occurredAt, tombstone: false };
  await appendEvents(workspace, [(state) => ({
    payload: { operation: "settings.updated", record: setting },
    projects: state.projects,
    work: state.work,
    settings: sortWorkspaceSettings([...state.settings, setting]),
  })], { occurredAt });
  for (const [read, state] of Object.entries({ cached: await materializeWorkspace(workspace), genesis: await materializeWorkspaceFromGenesis(workspace), validate: await validateWorkspace(workspace) })) {
    assert.equal(state.version, 1, read);
    assert.deepEqual(state.library.rejectedEvents, [], read);
    assert.equal(readModelsEscalation(state.settings).ceiling, "review", read);
    const input = { categories: readModelsCategory(state.settings), tiers: readModelsTiers(state.settings), escalation: readModelsEscalation(state.settings), category: "economy", rejections: 0 };
    refusedWith(() => resolveModelsTier(input), "MODELS_CATEGORY_UNKNOWN", { path: CEILING, category: "review" });
    assert.deepEqual(orderOf(resolveModelsTier({ ...input, escalation: { ...input.escalation, enabled: false } })), [60, 0, false], `${read}: disabled, the ceiling is not read`);
  }
});

test("508-AC5: GIVEN a rule naming economy, which files two records, WHEN resolved THEN it gets the one with the larger order", () => {
  assert.deepEqual(resolve("economy", 0), { record: TIERS[4], steps: 0, atCeiling: false });
  assert.deepEqual(resolve("main", 0).record, TIERS[2]);
  // The base record is the largest order whatever the table's order in the value.
  assert.deepEqual(resolve("economy", 0, {}, [...TIERS].reverse()).record, TIERS[4]);
});

test("508-AC5: GIVEN rejections reaching the threshold WHEN resolved again THEN the record one order up, across categories, up to the ceiling category's smallest order and no further", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((rejections) => orderOf(resolve("economy", rejections))), [
    [50, 0, false],
    [40, 1, false],
    [30, 2, false],
    [20, 3, true],
    [20, 3, true],
    [20, 3, true],
  ], "economy to economy on another runner, then into main, stopping at main's smallest order, not at flagship");
  // A threshold of two: one step for every two rejections.
  assert.deepEqual([1, 2, 3, 4, 6, 7].map((rejections) => orderOf(resolve("economy", rejections, { threshold: 2 }))), [
    [50, 0, false],
    [40, 1, false],
    [40, 1, false],
    [30, 2, false],
    [20, 3, true],
    [20, 3, true],
  ]);
  // The ceiling decides where it stops.
  assert.deepEqual(orderOf(resolve("economy", 9, { ceiling: "flagship" })), [10, 4, true]);
  assert.deepEqual([1, 5].map((rejections) => orderOf(resolve("economy", rejections, { ceiling: "economy" }))), [[40, 1, true], [40, 1, true]]);
  assert.deepEqual([0, 1, 2].map((rejections) => orderOf(resolve("main", rejections))), [[30, 0, false], [20, 1, true], [20, 1, true]]);
  // A base record above the ceiling stays where it is.
  assert.deepEqual([0, 3].map((rejections) => orderOf(resolve("flagship", rejections))), [[10, 0, true], [10, 0, true]]);
  // The walk follows the table's order, not the categories': here an economy record sits between two main records.
  const interleaved = [record(10, "main", "claude-code"), record(20, "economy", "codex"), record(30, "main", "codex"), record(40, "economy", "claude-code")];
  assert.deepEqual([1, 2, 3, 4].map((rejections) => [resolve("economy", rejections, {}, interleaved).record.category, orderOf(resolve("economy", rejections, {}, interleaved))]), [
    ["main", [30, 1, false]],
    ["economy", [20, 2, false]],
    ["main", [10, 3, true]],
    ["main", [10, 3, true]],
  ]);
  // The Owner's example (STORY-508 Use Cases): economy at 40 and main at 30; one rejection gives 30.
  const owner = [record(30, "main", "claude-code", "fixture-main", "max"), record(40, "economy", "claude-code", "fixture-main", "low")];
  assert.deepEqual(resolve("economy", 1, {}, owner), { record: owner[0], steps: 1, atCeiling: true });
});

test("508-R3, R4: GIVEN escalation disabled WHEN resolved THEN every rule keeps its category's base record, and the ceiling is not read", () => {
  for (const rejections of [0, 1, 5]) {
    assert.deepEqual(resolve("economy", rejections, { enabled: false }), { record: TIERS[4], steps: 0, atCeiling: false }, String(rejections));
  }
  assert.deepEqual(orderOf(resolve("economy", 3, { enabled: false, ceiling: "nowhere" })), [50, 0, false]);
  assert.deepEqual(orderOf(resolve("flagship", 3, { enabled: false })), [10, 0, false], "atCeiling is false while escalation is off");
});

test("508-R4, D6: GIVEN the default tables WHEN economy escalates THEN it walks the interleaved hosts, no runner filter, and stops at main's smallest order", async (context) => {
  // The call path of a caller outside core: the tables and the three keys as settings-catalog reports them.
  const workspace = await library(context);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  const current = (key) => catalog.settings.find((entry) => entry.key === key).currentValue;
  const input = {
    categories: JSON.parse(current("models.category")),
    tiers: JSON.parse(current("models.tiers")),
    escalation: readModelsEscalation(catalog.settings.filter((entry) => entry.currentValue !== null).map((entry) => ({ key: entry.key, value: entry.currentValue }))),
    category: "economy",
  };
  assert.deepEqual([0, 1, 2, 3, 4].map((rejections) => {
    const resolved = resolveModelsTier({ ...input, rejections });
    return [resolved.record.order, resolved.record.category, resolved.record.runner, resolved.steps, resolved.atCeiling];
  }), [
    [60, "economy", "claude-code", 0, false],
    [50, "economy", "codex", 1, false],
    [40, "main", "claude-code", 2, false],
    [30, "main", "codex", 3, true],
    [30, "main", "codex", 3, true],
  ]);
});

test("508-R4: the rejections come from the argument alone; resolving records nothing and remembers nothing", async (context) => {
  const workspace = await library(context);
  await cli(set(workspace, "models.tiers", TIERS));
  await cli(set(workspace, "models.escalation.threshold", "2"));
  const state = await materializeWorkspace(workspace);
  const input = { categories: readModelsCategory(state.settings), tiers: readModelsTiers(state.settings), escalation: readModelsEscalation(state.settings), category: "economy" };
  const snapshot = canonicalJson(input);
  const first = resolveModelsTier({ ...input, rejections: 4 });
  assert.deepEqual(orderOf(first), [30, 2, false]);
  assert.equal(Object.isFrozen(first), true);
  // The same arguments give the same answer, and fewer rejections give the answer for fewer: nothing carried over.
  assert.deepEqual(resolveModelsTier({ ...input, rejections: 4 }), first);
  assert.deepEqual(orderOf(resolveModelsTier({ ...input, rejections: 0 })), [50, 0, false]);
  assert.equal(canonicalJson(input), snapshot, "the arguments are not changed");
  const after = await materializeWorkspace(workspace);
  assert.deepEqual([after.version, after.headEventHash], [state.version, state.headEventHash], "nothing is appended");
  // The configuration holds the three keys and no count: models.escalation.* is exactly them.
  assert.deepEqual(SETTINGS_CATALOG.map((entry) => entry.key).filter((key) => key.startsWith("models.escalation.")).sort(), [...MODELS_ESCALATION_SETTING_KEYS].sort());
});

test("508-R4: what resolveModelsTier refuses, and with which reason code", () => {
  refusedWith(() => resolve("cheap", 0), "MODELS_CATEGORY_UNKNOWN", { path: "category", category: "cheap" });
  refusedWith(() => resolve("economy", 0, {}, TIERS, [...DEFAULT_CATEGORIES.slice(0, 2)]), "MODELS_CATEGORY_UNKNOWN", { path: "category", category: "economy" });
  refusedWith(() => resolve("flagship", 0, {}, TIERS.slice(1)), "MODELS_CATEGORY_EMPTY", { category: "flagship" });
  refusedWith(() => resolve("economy", 0, { ceiling: "cheap" }), "MODELS_CATEGORY_UNKNOWN", { path: CEILING, category: "cheap" });
  refusedWith(() => resolve("economy", 1, { ceiling: "flagship" }, TIERS.slice(1)), "MODELS_CATEGORY_EMPTY", { path: CEILING, category: "flagship" });
  for (const rejections of [-1, 1.5, "2", Number.NaN, null]) {
    refusedWith(() => resolve("economy", rejections), "MODELS_ESCALATION_INVALID", { path: "rejections" });
  }
  for (const [escalation, path] of [
    [{ threshold: 0 }, "models.escalation.threshold"],
    [{ threshold: "1" }, "models.escalation.threshold"],
    [{ enabled: "true" }, "models.escalation.enabled"],
    [{ ceiling: 7 }, CEILING],
  ]) {
    refusedWith(() => resolve("economy", 1, escalation), "MODELS_ESCALATION_INVALID", { path });
  }
  refusedWith(() => resolveModelsTier({ categories: DEFAULT_CATEGORIES, tiers: TIERS, escalation: null, category: "economy", rejections: 0 }), "MODELS_ESCALATION_INVALID", { path: "escalation" });
  refusedWith(() => resolveModelsTier(null), "MODELS_ESCALATION_INVALID", { path: "input" });
  // Each table keeps its own shape codes.
  refusedWith(() => resolve("economy", 0, {}, [...TIERS, record(50, "main", "codex")]), "MODELS_ORDER_DUPLICATE");
  refusedWith(() => resolve("economy", 0, {}, [{ order: 10, category: "economy" }]), "MODELS_TIERS_INVALID");
  refusedWith(() => resolve("economy", 0, {}, TIERS, [{ id: "economy" }]), "MODELS_CATEGORY_INVALID");
  // A recorded value that does not parse is refused where it is read.
  refusedWith(() => readModelsEscalation([{ key: "models.escalation.enabled", value: "yes" }]), "MODELS_ESCALATION_INVALID", { path: "models.escalation.enabled" });
  refusedWith(() => readModelsEscalation([{ key: "models.escalation.threshold", value: "0" }]), "MODELS_ESCALATION_INVALID", { path: "models.escalation.threshold" });
});
