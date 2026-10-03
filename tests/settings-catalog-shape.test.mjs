// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-508 R5 (MIN-236 D7; TCRN-CROSS-SUB-404): every row of settings-catalog and
// machine-settings-catalog carries its layout -- shape, group and order -- and the layout table of
// specs/settings-catalog-v1.md gives the same answer.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { MACHINE_SETTINGS_CATALOG, SETTINGS_CATALOG, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { SETTING_GROUPS } from "../dist/build/packages/core/src/settings.js";

const at = "2026-09-28T00:00:00Z";
// The collection keys of TCRN-CROSS-STORY-508; every other key is a scalar.
const COLLECTION_KEYS = new Set(["models.category", "models.tiers"]);

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-settings-shape-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "library"), createdAt: at });
  return join(base, "library");
}

const layoutOf = (row) => ({ key: row.key, layer: row.layer, shape: row.shape, group: row.group, order: row.order });

function assertLayoutFields(row) {
  assert.ok(row.shape === "collection" || row.shape === "scalar", `${row.key}: shape ${row.shape}`);
  assert.ok(SETTING_GROUPS.includes(row.group), `${row.key}: group ${row.group}`);
  assert.ok(Number.isSafeInteger(row.order) && row.order >= 1, `${row.key}: order ${row.order}`);
}

function assertUnique(places, message) {
  const repeated = places.filter((place, index) => places.indexOf(place) !== index);
  assert.deepEqual(repeated, [], message);
}

// The rows of the layout table in specs/settings-catalog-v1.md.
async function specLayout() {
  const text = await readFile(new URL("../specs/settings-catalog-v1.md", import.meta.url), "utf8");
  const section = text.split("\n## Layout: shape, group and order")[1]?.split("\n## ")[0] ?? "";
  const pattern = /^\| `([a-z]+)` \| `([^`]+)`( \(\*planned\*\))? \| (project|library|device) \| (collection|scalar) \| ([1-9][0-9]*) \|$/gmu;
  return [...section.matchAll(pattern)].map((match) => ({
    group: match[1],
    key: match[2],
    planned: match[3] !== undefined,
    layer: match[4],
    shape: match[5],
    order: Number(match[6]),
  }));
}

test("STORY-508 R5: GIVEN a new library WHEN settings-catalog THEN every row carries shape, group and order, models.tiers is a collection and the rest scalars", async (t) => {
  const workspace = await library(t);
  const catalog = await cli(["settings-catalog", "--workspace", workspace]);
  assert.equal(catalog.reasonCode, "SETTINGS_CATALOG_READY");
  assert.ok(catalog.settings.length > 0);
  for (const row of catalog.settings) {
    assertLayoutFields(row);
    assert.equal(row.layer, SETTINGS_CATALOG.find((entry) => entry.key === row.key).layer, row.key);
    assert.equal(row.shape, COLLECTION_KEYS.has(row.key) ? "collection" : "scalar", row.key);
  }
  const tiers = catalog.settings.find((row) => row.key === "models.tiers");
  assert.deepEqual([tiers?.shape, tiers?.group], ["collection", "models"]);
  assertUnique(catalog.settings.map((row) => `${row.layer} ${row.group} ${row.order}`), "order is unique within a layer and a group");
  // The CLI answers what the core catalog holds.
  assert.deepEqual(catalog.settings.map(layoutOf), SETTINGS_CATALOG.map(layoutOf));
});

test("STORY-508 R5: GIVEN machine-settings-catalog THEN every row carries the three fields, a scalar of the device layer", async () => {
  const catalog = await cli(["machine-settings-catalog"]);
  assert.equal(catalog.reasonCode, "MACHINE_SETTINGS_CATALOG_READY");
  assert.ok(catalog.settings.length > 0);
  for (const row of catalog.settings) {
    assertLayoutFields(row);
    assert.deepEqual([row.layer, row.shape], ["device", "scalar"], row.key);
  }
  assertUnique(catalog.settings.map((row) => `${row.layer} ${row.group} ${row.order}`), "order is unique within a layer and a group");
  assert.deepEqual(catalog.settings.map(layoutOf), MACHINE_SETTINGS_CATALOG.map(layoutOf));
});

test("STORY-508 R5: a group that holds keys of both layers has one display order", () => {
  const rows = [...SETTINGS_CATALOG, ...MACHINE_SETTINGS_CATALOG];
  assertUnique(rows.map((row) => `${row.group} ${row.order}`), "order is unique within a group across both catalogs");
  // Both layers do share a group, so the rule above is not vacuous.
  const shared = SETTING_GROUPS.filter((group) => new Set(rows.filter((row) => row.group === group).map((row) => row.layer)).size === 2);
  assert.ok(shared.length > 0);
});

test("STORY-508 R5: the layout table of specs/settings-catalog-v1.md is the catalogs' layout", async () => {
  const table = await specLayout();
  assert.ok(table.length >= SETTINGS_CATALOG.length + MACHINE_SETTINGS_CATALOG.length, "the table was read");
  assertUnique(table.map((row) => row.key), "one row per key");
  // The groups appear in SETTING_GROUPS order, the order the settings page shows them, and each
  // group's rows ascend by a unique order.
  assert.deepEqual([...new Set(table.map((row) => row.group))], [...SETTING_GROUPS]);
  for (const group of SETTING_GROUPS) {
    const orders = table.filter((row) => row.group === group).map((row) => row.order);
    assert.deepEqual(orders, [...orders].sort((left, right) => left - right), group);
    assertUnique(orders, group);
  }
  // Every catalogued key has its row, unmarked; a planned row names a key no catalog holds yet.
  const catalogued = new Map([...SETTINGS_CATALOG, ...MACHINE_SETTINGS_CATALOG].map((entry) => [entry.key, entry]));
  for (const entry of catalogued.values()) {
    const row = table.find((candidate) => candidate.key === entry.key);
    assert.deepEqual(row === undefined ? undefined : layoutOf(row), layoutOf(entry), entry.key);
    assert.equal(row?.planned, false, `${entry.key} is catalogued; its row is no longer planned`);
  }
  for (const row of table.filter((candidate) => candidate.planned)) {
    assert.equal(catalogued.has(row.key), false, row.key);
    assert.equal(row.shape, COLLECTION_KEYS.has(row.key) ? "collection" : "scalar", row.key);
  }
  assert.deepEqual(table.filter((row) => !row.planned && !catalogued.has(row.key)).map((row) => row.key), [], "every unmarked row is catalogued");
});
