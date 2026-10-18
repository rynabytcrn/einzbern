// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { configurationContract, annotateConfigValue } from "../dist/build/packages/core/src/configuration-contract.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { SETTINGS_CATALOG } from "../dist/build/packages/core/src/settings.js";
import { MACHINE_SETTINGS_CATALOG } from "../dist/build/packages/core/src/machine-settings.js";

test("configuration dictionary exhaustively derives registered keys and authoritative defaults from catalogs", () => {
  const contract = configurationContract();
  const entries = [...SETTINGS_CATALOG, ...MACHINE_SETTINGS_CATALOG];
  assert.ok(entries.length >= 34);
  assert.equal(contract.settings.length, entries.length);
  assert.equal(new Set(entries.map(entry => entry.key)).size, entries.length, "registered keys are unique across both catalogs");
  assert.equal(new Set(entries.map(entry => `${entry.group}:${entry.order}`)).size, entries.length, "group orders are unique across both catalogs");
  assert.deepEqual(contract.settings.map((entry) => entry.key).sort(), entries.map((entry) => entry.key).sort());
  for (const entry of entries) {
    const row = contract.settings.find((candidate) => candidate.key === entry.key);
    assert.equal(row.defaultValue, entry.defaultValue);
    assert.equal(row.min, entry.min);
    assert.equal(row.max, entry.max);
    assert.deepEqual(row.allowedValues, entry.allowedValues);
    for (const field of ["semanticType", "scope", "registeredScope", "owner", "source", "storageSource", "sharing", "export", "consumer", "effect", "compatibility"]) assert.ok(row[field], `${entry.key}.${field}`);
    if (entry.defaultValue !== null) annotateConfigValue(entry.key, entry.defaultValue, "default");
  }
  assert.ok(contract.limits.length > 0);
  assert.equal(contract.independentEntries.find((entry) => entry.kind === "config-project-json").classification, "projection");
  assert.equal(contract.independentEntries.find((entry) => entry.kind === "quota-observation").classification, "runtime-state");
});

test("typed readback is strict, lossless about absence and raw transport, and uses catalog validation", () => {
  assert.equal(annotateConfigValue("models.escalation.enabled", "false").semanticValue, false);
  assert.equal(annotateConfigValue("models.escalation.enabled", "true").semanticValue, true);
  assert.throws(() => annotateConfigValue("models.escalation.enabled", "1"));
  assert.throws(() => annotateConfigValue("models.escalation.enabled", "False"));
  assert.equal(annotateConfigValue("execution.maxConcurrentSubagents", "8").semanticValue, 8);
  assert.throws(() => annotateConfigValue("execution.maxConcurrentSubagents", "1.5"));
  assert.throws(() => annotateConfigValue("execution.maxConcurrentSubagents", "9007199254740992"));
  assert.throws(() => annotateConfigValue("portal.port", "80"));
  assert.throws(() => annotateConfigValue("portal.defaultTheme", "unknown"));
  assert.throws(() => annotateConfigValue("unknown.key", null), { reasonCode: "CONFIGURATION_KEY_UNKNOWN" });
  assert.equal(annotateConfigValue("design.authority", null, "absent").semanticValue, null);
  assert.equal(annotateConfigValue("design.authority", null, "absent").valueOrigin, "absent");
  assert.throws(() => annotateConfigValue("design.authority", ""));
  assert.throws(() => annotateConfigValue("design.authority", "http://example.com"));
  const language = annotateConfigValue("retrieval.promptLanguages", "zh-CN, en,en");
  assert.deepEqual(language.semanticValue, ["en", "zh-CN"]);
  assert.equal(language.rawValue, "zh-CN, en,en");
  const category = SETTINGS_CATALOG.find((entry) => entry.key === "models.category");
  assert.ok(Array.isArray(annotateConfigValue(category.key, category.defaultValue).semanticValue));
});

test("dictionary separates historical storage from effective host authority and device state from shared projections", () => {
  const rows = configurationContract().settings;
  for (const row of rows.filter((entry) => entry.key.startsWith("models.") || entry.key.startsWith("quota."))) {
    assert.equal(row.scope, "host");
    assert.equal(row.registeredScope, "project");
    assert.match(row.source, /engine-model-policy/);
    assert.match(row.compatibility, /historical/);
    assert.match(row.inheritance, /no project fallback/);
  }
  assert.equal(rows.find((row) => row.key === "storage.segmentBytes").scope, "library");
  assert.equal(rows.find((row) => row.key === "portal.port").effect, "restart");
  assert.equal(rows.find((row) => row.key === "execution.maxConcurrentHeavyRuns").effect, "next slot acquisition");
});


test("typed historical declarations never masquerade as resolved device-host runtime values", () => {
  for (const [key, value] of [["models.escalation.enabled", "false"], ["quota.fiveHourWaitPercent", "80"], ["quota.weeklyWaitPercent", null]]) {
    const annotated = annotateConfigValue(key, value, value === null ? "absent" : "stored");
    assert.equal(annotated.valueRole, "historical-declaration");
    assert.equal(annotated.valueSource, "project-compatibility");
    assert.equal(annotated.rawValue, value);
    assert.match(annotated.contract.source, /device engine-model-policy/u, "family authority is explicitly separate from supplied value provenance");
    assert.equal(Object.hasOwn(annotated, "effectiveRuntimeValue"), false);
  }
  const current = annotateConfigValue("retrieval.tau", "3", "stored");
  assert.equal(current.valueRole, "resolved-setting");
  assert.equal(current.valueSource, "caller-supplied-setting");
  assert.equal(current.semanticValue, 3);
});


test("configuration contract includes runtime ownership and the canonical CLI flag catalog", () => {
  const contract = configurationContract(COMMAND_CATALOG);
  assert.equal(contract.runtimeInputs.commandCatalogAttached, true);
  assert.deepEqual(contract.runtimeInputs.commandCatalog, COMMAND_CATALOG);
  assert.ok(contract.runtimeInputs.entries.some(entry => entry.name === "EINZBERN_HOME"));
  assert.ok(contract.runtimeInputs.entries.some(entry => entry.kind === "browser-storage"));
  assert.equal(configurationContract().runtimeInputs.commandCatalogAttached, false);
});

test("configuration inventory retains exact command flags including capture host", async () => {
  const inventory = JSON.parse(await readFile(new URL("../docs/implementation/configuration-inventory.json", import.meta.url), "utf8"));
  assert.deepEqual(inventory, configurationContract(COMMAND_CATALOG));
  const capture = inventory.runtimeInputs.commandCatalog.find((command) => command.name === "knowledge-capture");
  assert.deepEqual(capture.flags.find((flag) => flag.name === "host"), { name: "host", required: false, valueKind: "string", valueShape: "Explicit host for configured artifact-language model policy; required by that policy, not inferred." });
});
