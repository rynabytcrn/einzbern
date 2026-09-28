// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-508 R1, AC1, AC4 (MIN-236 D6; TCRN-CROSS-SUB-405): models.category, the parent
// table of models.tiers. A category is {id, name, description, order}, ids and orders unique; its
// default is flagship, main and economy; a write that drops a category tier records still name is
// refused with the records that name it, and settings-remove puts a default table back only when the
// other table still agrees with it. Replay checks shapes, never the references between the tables.
// TCRN-CROSS-STORY-510 R2 (TCRN-CROSS-SUB-417): a settings write receipt's effectiveValue is the key's
// currentValue in settings-catalog, so an unset models.category receipts the categories the tiers name.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  appendEvents,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  readModelsCategory,
  readModelsTiers,
  sortWorkspaceSettings,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import {
  MODELS_CATEGORY_DEFAULT_VALUE,
  defaultModelsCategory,
  deriveModelsCategory,
  parseModelsCategory,
  validateModelsCategory,
} from "../dist/build/packages/core/src/models-category.js";
import { defaultModelsTiers } from "../dist/build/packages/core/src/models-tiers.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 28, 6, 0, second)).toISOString().replace(".000Z", "Z");
};

const category = (id, order, name = id, description = "") => ({ id, name, description, order });
const record = (order, categoryId, runner, model = "", effort = "", note = "") => ({ order, category: categoryId, runner, model, effort, note });
const DEFAULT_CATEGORIES = [category("flagship", 10), category("main", 20), category("economy", 30)];

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-models-category-")));
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

const set = (workspace, key, value) => ["settings-set", "--workspace", workspace, "--at", at(), "--key", key, "--value", JSON.stringify(value)];
const remove = (workspace, key) => ["settings-remove", "--workspace", workspace, "--at", at(), "--key", key];
const versionOf = async (workspace) => (await validateWorkspace(workspace)).version;
const catalogRowOf = async (workspace, key) => (await cli(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === key);
const currentValueOf = async (workspace, key) => (await catalogRowOf(workspace, key)).currentValue;

// The settings write receipt as it stands (SUB-417 changes where effectiveValue comes from, nothing
// else): these fields, and receiptDigest taken over all of them but reasonCode, ids and itself.
const RECEIPT_FIELDS = ["effectiveValue", "headEventHash", "ids", "reasonCode", "receiptDigest", "recordId", "schemaVersion", "setting", "version", "workspaceId"];
function assertReceiptShape(receipt) {
  assert.deepEqual(Object.keys(receipt).sort(), RECEIPT_FIELDS);
  assert.deepEqual([receipt.reasonCode, receipt.schemaVersion, receipt.ids], ["SETTINGS_WRITE_COMMITTED", "tcrn.settings-write-receipt.v1", [receipt.recordId]]);
  const { schemaVersion, workspaceId, version, headEventHash, recordId, setting, effectiveValue } = receipt;
  assert.equal(receipt.receiptDigest, canonicalSha256({ schemaVersion, workspaceId, version, headEventHash, recordId, setting, effectiveValue }));
}

// A settings event appended raw, as a device whose write the other never saw would leave it.
function recordedSetting(key, value, updatedAt) {
  const setting = { schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision: 1, updatedAt, tombstone: false };
  return (state) => ({
    payload: { operation: "settings.updated", record: setting },
    projects: state.projects,
    work: state.work,
    settings: sortWorkspaceSettings([...state.settings.filter((entry) => entry.key !== key), setting]),
  });
}

test("508-R1, AC1: GIVEN a new library WHEN settings-catalog THEN models.category is a collection of the models group, flagship, main and economy by default", async (context) => {
  const workspace = await library(context);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  const row = catalog.settings.find((entry) => entry.key === "models.category");
  assert.deepEqual([row.layer, row.shape, row.group, row.order, row.type, row.modelWritable], ["project", "collection", "models", 1, "string", false]);
  assert.equal(row.defaultValue, MODELS_CATEGORY_DEFAULT_VALUE);
  assert.equal(row.currentValue, row.defaultValue);
  assert.deepEqual(JSON.parse(row.defaultValue), DEFAULT_CATEGORIES, "each default category is named by its id, strongest first");
  assert.deepEqual(defaultModelsCategory(), DEFAULT_CATEGORIES);
  assert.deepEqual(readModelsCategory([]), DEFAULT_CATEGORIES, "an unset models.category reads as the default table");
  // The two default tables agree: every default tier record names a default category.
  const tiers = catalog.settings.find((entry) => entry.key === "models.tiers");
  assert.equal(tiers.shape, "collection");
  assert.deepEqual(JSON.parse(tiers.defaultValue).filter((entry) => !DEFAULT_CATEGORIES.some((known) => known.id === entry.category)), []);
});

test("508-R1: models.category validation names the field it refuses; a repeated id or order has its own reason code", async (context) => {
  const valid = [category("main", 20, "Main", "the implementing tier"), category("flagship", 10, "Flagship")];
  assert.deepEqual(validateModelsCategory(valid), [valid[1], valid[0]], "read in ascending order");
  assert.deepEqual(parseModelsCategory(JSON.stringify(valid)), [valid[1], valid[0]]);
  const one = (fields) => [{ ...category("economy", 30), ...fields }];
  const refusals = [
    [{ economy: {} }, "models.category"],
    [[7], "models.category[0]"],
    [[{ id: "economy", name: "economy", order: 30 }], "models.category[0]"],
    [one({ rank: 1 }), "models.category[0]"],
    [one({ id: "Economy" }), "models.category[0].id"],
    [one({ id: "e".repeat(65) }), "models.category[0].id"],
    [one({ name: "" }), "models.category[0].name"],
    [one({ name: "n".repeat(65) }), "models.category[0].name"],
    [one({ description: "line\nbreak" }), "models.category[0].description"],
    [one({ description: "d".repeat(257) }), "models.category[0].description"],
    [one({ order: 0 }), "models.category[0].order"],
    [one({ order: "30" }), "models.category[0].order"],
  ];
  for (const [value, path] of refusals) {
    assert.throws(() => validateModelsCategory(value), (error) => error?.reasonCode === "MODELS_CATEGORY_INVALID" && error.details.path === path, path);
  }
  assert.throws(() => validateModelsCategory([category("main", 10), category("main", 20)]),
    (error) => error?.reasonCode === "MODELS_CATEGORY_DUPLICATE" && error.details.path === "models.category[1].id" && error.details.category === "main");
  assert.throws(() => validateModelsCategory([category("main", 10), category("economy", 10)]),
    (error) => error?.reasonCode === "MODELS_ORDER_DUPLICATE" && error.details.path === "models.category[1].order" && error.details.order === 10);
  assert.throws(() => parseModelsCategory("["), (error) => error?.reasonCode === "MODELS_CATEGORY_INVALID");

  // Through settings-set: the two repeats keep their codes, every other field is SETTINGS_VALUE_INVALID.
  const workspace = await library(context);
  assert.equal((await refusalOf(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("main", 40)]))).reasonCode, "MODELS_CATEGORY_DUPLICATE");
  assert.equal((await refusalOf(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("cheap", 30)]))).reasonCode, "MODELS_ORDER_DUPLICATE");
  const invalid = await refusalOf(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("Cheap", 40)]));
  assert.deepEqual([invalid.reasonCode, invalid.details.path], ["SETTINGS_VALUE_INVALID", "models.category[3].id"]);
  assert.equal(await versionOf(workspace), 0, "no refusal appended an event");
  const written = await cli(set(workspace, "models.category", [category("cheap", 40, "Cheap", "the low-cost tier"), ...DEFAULT_CATEGORIES]));
  assert.equal(written.setting.value, canonicalJson([...DEFAULT_CATEGORIES, category("cheap", 40, "Cheap", "the low-cost tier")]), "stored as canonical JSON in ascending order");
  assert.equal(await currentValueOf(workspace, "models.category"), written.setting.value);
});

test("508-AC4: GIVEN a category tier records still name WHEN a models.category write drops it THEN it is refused, listing the records that name it", async (context) => {
  const workspace = await library(context);
  // The default tiers file two records under economy, at 50 and 60.
  const refused = await refusalOf(set(workspace, "models.category", [category("flagship", 10), category("main", 20)]));
  assert.equal(refused.reasonCode, "MODELS_CATEGORY_IN_USE");
  assert.deepEqual([refused.details.category, refused.details.categories, refused.details.references], ["economy", ["economy"], ["models.tiers.50", "models.tiers.60"]]);
  assert.match(refused.message, /models\.tiers\.50, models\.tiers\.60/u, "the message lists them too");
  assert.equal(await versionOf(workspace), 0);
  // A category no record names may go; once no record names economy, economy may go as well.
  await cli(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("cheap", 40)]));
  await cli(set(workspace, "models.category", DEFAULT_CATEGORIES));
  await cli(set(workspace, "models.tiers", [record(10, "flagship", "claude-code"), record(20, "main", "claude-code")]));
  const dropped = await cli(set(workspace, "models.category", [category("flagship", 10), category("main", 20)]));
  assert.deepEqual(JSON.parse(dropped.setting.value).map((entry) => entry.id), ["flagship", "main"]);
  assert.equal(await versionOf(workspace), 4);
});

test("508-R1, R2: settings-remove puts a default table back only when the other table agrees with it", async (context) => {
  const workspace = await library(context);
  await cli(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("cheap", 40)]));
  await cli(set(workspace, "models.tiers", [record(10, "flagship", "claude-code"), record(20, "cheap", "codex-cli")]));
  await cli(set(workspace, "models.category", [category("flagship", 10), category("main", 20), category("cheap", 40)]));
  const before = await versionOf(workspace);
  // The default tiers file records under economy, which models.category no longer holds.
  const refused = await refusalOf(remove(workspace, "models.tiers"));
  assert.equal(refused.reasonCode, "MODELS_CATEGORY_UNKNOWN");
  assert.deepEqual([refused.details.category, refused.details.references], ["economy", ["models.tiers.50", "models.tiers.60"]]);
  assert.equal(await versionOf(workspace), before);
  // An unset models.category holds the default categories and every other category the tiers name,
  // so removing it never strands a record; the tiers' default then fits.
  await cli(remove(workspace, "models.category"));
  assert.deepEqual(JSON.parse(await currentValueOf(workspace, "models.category")), [...DEFAULT_CATEGORIES, category("cheap", 40)]);
  await cli(remove(workspace, "models.tiers"));
  const state = await materializeWorkspace(workspace);
  assert.deepEqual(state.settings.filter((entry) => entry.key.startsWith("models.")), []);
  assert.deepEqual(readModelsTiers(state.settings), defaultModelsTiers());
  assert.deepEqual(readModelsCategory(state.settings), DEFAULT_CATEGORIES);
});

test("508-R1, R2: replay checks each table's shape and no reference, so tables a merge brought apart still read, and the next write names what is missing", async (context) => {
  const workspace = await library(context);
  const occurredAt = at();
  await appendEvents(workspace, [
    recordedSetting("models.category", canonicalJson([category("flagship", 10)]), occurredAt),
    recordedSetting("models.tiers", canonicalJson([record(10, "economy", "codex", "fixture-codex", "low")]), occurredAt),
  ], { occurredAt });
  const reads = { cached: await materializeWorkspace(workspace), genesis: await materializeWorkspaceFromGenesis(workspace), validate: await validateWorkspace(workspace) };
  for (const [read, state] of Object.entries(reads)) {
    assert.equal(state.version, 2, read);
    assert.deepEqual(state.library.rejectedEvents, [], read);
    assert.deepEqual(readModelsCategory(state.settings).map((entry) => entry.id), ["flagship"], read);
    assert.deepEqual(readModelsTiers(state.settings).map((entry) => entry.category), ["economy"], read);
  }
  const unknown = await refusalOf(set(workspace, "models.category", [category("flagship", 10), category("main", 20)]));
  assert.deepEqual([unknown.reasonCode, unknown.details.category], ["MODELS_CATEGORY_UNKNOWN", "economy"], "a write that leaves the reference missing names it");
  await cli(set(workspace, "models.category", [category("flagship", 10), category("economy", 30)]));
  assert.equal(await versionOf(workspace), 3);
});

test("508-R1: an unset table is derived: the default categories, then every other category the tiers name, by name", () => {
  assert.deepEqual(deriveModelsCategory(), DEFAULT_CATEGORIES);
  assert.deepEqual(deriveModelsCategory(["review", "economy", "audit", "review"]),
    [...DEFAULT_CATEGORIES, category("audit", 40), category("review", 50)]);
  const tiers = { key: "models.tiers", value: canonicalJson([record(10, "review", "claude-code")]) };
  assert.deepEqual(readModelsCategory([tiers]), [...DEFAULT_CATEGORIES, category("review", 40)]);
  const recorded = { key: "models.category", value: canonicalJson([category("review", 5)]) };
  assert.deepEqual(readModelsCategory([tiers, recorded]), [category("review", 5)], "a recorded table is the table");
});

test("510-R2 (SUB-417): GIVEN models.tiers names a category outside the default table WHEN settings-remove models.category THEN the receipt's effectiveValue is settings-catalog's currentValue, that category included", async (context) => {
  const workspace = await library(context);
  // Recorded under another order, name and description than the unset table derives for it, so the
  // receipt cannot pass by echoing the value it removed.
  await cli(set(workspace, "models.category", [...DEFAULT_CATEGORIES, category("cheap", 45, "Cheap", "the low-cost tier")]));
  await cli(set(workspace, "models.tiers", [record(10, "flagship", "claude-code"), record(20, "cheap", "codex-cli")]));
  const removed = await cli(remove(workspace, "models.category"));
  assert.deepEqual([removed.recordId, removed.setting], ["models.category", null]);
  assert.equal(removed.effectiveValue, await currentValueOf(workspace, "models.category"), "the receipt and settings-catalog agree");
  assert.deepEqual(JSON.parse(removed.effectiveValue), [...DEFAULT_CATEGORIES, category("cheap", 40)], "the default categories, then cheap");
  assert.notEqual(removed.effectiveValue, MODELS_CATEGORY_DEFAULT_VALUE, "not the default table, which the receipt used to echo and which lacks cheap");
  assertReceiptShape(removed);
});

test("510-R2 (SUB-417): GIVEN a set key and an unset ordinary key WHEN settings-set or settings-remove THEN the receipt's effectiveValue is what it was, the value or the default, and settings-catalog's currentValue", async (context) => {
  const workspace = await library(context);
  const writes = [
    ["models.category", JSON.stringify([...DEFAULT_CATEGORIES, category("cheap", 40, "Cheap")])],
    // With the tiers naming the default categories only, the unset table is the default table.
    ["models.category", null],
    ["models.tiers", JSON.stringify([record(10, "flagship", "claude-code"), record(20, "main", "claude-code")])],
    ["models.tiers", null],
    ["retrieval.tau", "5"],
    ["retrieval.tau", null],
    ["quota.weeklyWaitPercent", "80"],
    ["quota.weeklyWaitPercent", null],
    ["storage.segmentBytes", "2097152"],
    ["storage.segmentBytes", null],
  ];
  const expected = { "retrieval.tau": ["5", "3"], "quota.weeklyWaitPercent": ["80", null], "storage.segmentBytes": ["2097152", "1048576"] };
  for (const [key, value] of writes) {
    const receipt = await cli(value === null
      ? remove(workspace, key)
      : ["settings-set", "--workspace", workspace, "--at", at(), "--key", key, "--value", value]);
    const row = await catalogRowOf(workspace, key);
    const verb = value === null ? "settings-remove" : "settings-set";
    assert.equal(receipt.setting === null, value === null, `${verb} ${key}`);
    assert.equal(receipt.effectiveValue, receipt.setting?.value ?? row.defaultValue, `${verb} ${key}: the value, or the default, as before`);
    assert.equal(receipt.effectiveValue, row.currentValue, `${verb} ${key}: settings-catalog's currentValue`);
    if (Object.hasOwn(expected, key)) assert.equal(receipt.effectiveValue, expected[key][value === null ? 1 : 0], `${verb} ${key}`);
    assertReceiptShape(receipt);
  }
  assert.equal(await versionOf(workspace), writes.length);
});
