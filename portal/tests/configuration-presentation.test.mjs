// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";

// Ordinary presentation tests: execute the shipped renderers with readback values.
// No server, asynchronous response manipulation, or mutation endpoint is involved.
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const localeWindow = {};
new Function("window", await readFile(new URL("../locales.js", import.meta.url), "utf8"))(localeWindow);
const locales = localeWindow.PORTAL_LOCALES;
const block = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const esc = (value) => String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const readback = {
  key: "artifact.language", scope: "project", owner: "governed-owner", semanticType: "enum",
  source: "library events bound to stable target identity", storageSource: "library settings.updated events",
  sharing: "portable declarations sync with library", export: "consumer-specific whitelist",
  inheritance: "explicit project parent chain", defaultValue: "en", effect: "next consumer read; managed outputs require explicit render",
  compatibility: "historical string events preserved",
};
const independent = (kind, scope = "project") => ({ kind, scope, source: "library config records", sharing: "library sync; explicit export targets only", export: "dedicated consumer contract", effect: "dedicated consumer operation", editing: "replace versus patch explicit", compatibility: "retain historical records" });
function presentation({ locale = "en", contract = readback, typed, coordination = false, independentEntries = [] } = {}) {
  const state = { modelPolicyHost: "codex", settings: { projectId: "project:selected", chain: { role: coordination ? "coordination" : "project" }, typedValues: typed ? [typed] : [], configurationContract: { settings: contract ? [contract] : [], independentEntries } } };
  const BOOT = { library: { libraryId: "library:selected", configurationProjectId: "project:selected" } };
  const t = (key, args = {}) => String(locales[locale][key] ?? key).replace(/\{([^}]+)\}/gu, (_, name) => String(args[name] ?? `{${name}}`));
  const render = new Function("state", "BOOT", "t", "esc", [
    block("  const unresolvedCommon =", "  const settingRowLabel ="),
    block("  const variableConfiguration =", "  const variableRow ="),
    block("  const copyPolicy =", "  const policyDraft ="),
    block("  const modelPolicyConfiguration =", "  const focusModelPolicyField ="),
    "return { configurationMetadata, independentConfigurationMetadata, variableConfiguration, modelPolicyConfiguration, configurationValue };",
  ].join("\n"))(state, BOOT, t, esc);
  return { state, t, ...render };
}
const dom = (html) => parseHTML(`<html><body>${html}</body></html>`).document;
const field = (document, name) => document.querySelector(`[data-configuration-field="${name}"] dd`)?.textContent;

test("settings show target, persistence, sharing, export and source for inherited values in five locales", () => {
  const entry = { key: "artifact.language", layer: "project", scope: "project", declaredValue: null, currentValue: "fr", source: { kind: "project", projectId: "project:parent", inherited: true } };
  for (const locale of Object.keys(locales)) {
    const page = presentation({ locale, typed: { key: entry.key, contract: readback, semanticValue: "fr", effectiveScope: "project", effectiveSource: entry.source, valueRole: "resolved-setting" } });
    const document = dom(page.configurationMetadata(entry));
    assert.ok(document.querySelector('[data-configuration-overview]'));
    assert.equal(document.querySelector('[data-configuration-scope]').textContent, `${page.t("configuration.scope")}: project`);
    assert.equal(field(document, "target"), "library:selected / project:selected");
    assert.equal(field(document, "storageSource"), readback.storageSource);
    assert.equal(field(document, "sharing"), readback.sharing);
    assert.equal(field(document, "export"), readback.export);
    assert.equal(field(document, "declaredValue"), page.t("configuration.notDeclared"));
    assert.equal(field(document, "effectiveValue"), '"fr"');
    assert.equal(field(document, "effectiveSource"), JSON.stringify(entry.source));
    assert.equal(field(document, "inheritanceState"), page.t("configuration.inherited"));
    assert.equal(field(document, "effect"), readback.effect);
    assert.ok(!document.body.textContent.includes("configuration."), `${locale}: every presentation label is translated`);
  }
});

test("machine declarations are not falsely reported as runtime or browser effective values", () => {
  const contract = { ...readback, key: "portal.defaultTheme", scope: "device", source: "device machine-settings.json", storageSource: "device machine-settings.json", sharing: "device-local; not library synced", defaultValue: "system", effect: "next-open" };
  const page = presentation({ contract });
  for (const currentValue of [null, "system", "dark"]) {
    const document = dom(page.configurationMetadata({ key: contract.key, layer: "device", currentValue }));
    assert.equal(document.querySelector('[data-configuration-contract]').dataset.effectiveScope, "device");
    assert.equal(field(document, "declaredValue"), page.configurationValue(currentValue));
    assert.equal(field(document, "effectiveValue"), page.t("configuration.consumerResolved"));
    assert.equal(field(document, "effectiveSource"), page.t("configuration.consumerResolved"));
    assert.equal(field(document, "storageSource"), contract.storageSource);
    assert.equal(field(document, "defaultValue"), '"system"');
  }
});

test("coordination readback changes a project catalog row to a library target", () => {
  const page = presentation({ typed: { key: readback.key, contract: readback, semanticValue: "ja", effectiveScope: "library", effectiveSource: { kind: "library" } }, coordination: true });
  const document = dom(page.configurationMetadata({ key: readback.key, scope: "project", declaredValue: "ja" }));
  assert.equal(document.querySelector('[data-configuration-contract]').dataset.effectiveScope, "library");
  assert.equal(field(document, "target"), "library:selected");
  assert.equal(field(document, "inheritanceState"), page.t("configuration.declaredHere"));
});

test("historical model and quota declarations cannot be mistaken for effective host policy", () => {
  for (const key of ["models.tiers", "quota.fiveHourWaitPercent"]) {
    const contract = { ...readback, key, scope: "host", source: "device engine-model-policy.json hosts[host]", sharing: "historical declaration syncs with library; effective device policy does not sync" };
    const page = presentation({ contract, typed: { key, contract, semanticValue: "legacy", effectiveScope: "project", effectiveSource: { kind: "project" }, valueRole: "historical-declaration", valueSource: "project-compatibility" } });
    const document = dom(page.configurationMetadata({ key, scope: "project", declaredValue: "legacy" }));
    assert.equal(document.querySelector('[data-configuration-role]').textContent, page.t("configuration.historicalReadOnly"));
    assert.equal(field(document, "valueRole"), "historical-declaration");
    assert.equal(field(document, "effectiveValue"), page.t("configuration.historicalNotEffective"));
    assert.equal(field(document, "effectiveSource"), undefined);
    assert.equal(field(document, "historicalSource"), '{"kind":"project"}');
    assert.equal(field(document, "source"), contract.source);
  }
});

test("an unresolved common source is distinguished from a default and absent metadata is explicit", () => {
  const page = presentation();
  const document = dom(page.configurationMetadata({ key: readback.key, scope: "project", currentValue: null, source: { kind: "common", status: "unresolved" } }));
  assert.equal(field(document, "inheritanceState"), page.t("projects.commonUnavailable"));
  assert.equal(field(document, "effectiveValue"), page.t("configuration.notDeclared"));
  const missing = dom(presentation({ contract: null }).configurationMetadata({ key: readback.key }));
  assert.equal(missing.querySelector('[data-configuration-unavailable]').dataset.configurationUnavailable, readback.key);
});

test("host editor metadata names the host independently of project selection and distinguishes saved policy from draft", () => {
  const contract = { ...independent("engine-host-policy", "device/host"), source: "engine-model-policy.json", sharing: "not library synced; runtime handoff only" };
  const page = presentation({ independentEntries: [contract] });
  const policy = { categories: [], tiers: [], escalation: { enabled: false, threshold: 2, ceiling: "main" } };
  const document = dom(page.modelPolicyConfiguration("codex", policy));
  assert.match(field(document, "target"), /codex/u);
  assert.ok(!field(document, "target").includes("project:selected"));
  assert.equal(field(document, "storageSource"), "engine-model-policy.json");
  assert.equal(field(document, "declaredValue"), JSON.stringify(policy));
  assert.equal(field(document, "valueRole"), page.t("configuration.draftControls"));
  assert.equal(field(dom(page.modelPolicyConfiguration("codex", null)), "effectiveValue"), page.t("modelPolicy.unconfigured"));
});

test("variable metadata preserves inherited declaration distinction, empty exports and historical AGENTS export", () => {
  const page = presentation({ independentEntries: [independent("variable")] });
  const variable = { value: "false", declaredHere: false, source: { kind: "project", projectId: "project:parent", inherited: true }, exports: [] };
  const document = dom(page.variableConfiguration(variable, false));
  assert.equal(field(document, "declaredValue"), page.t("configuration.notDeclared"));
  assert.equal(field(document, "effectiveValue"), '"false"');
  assert.equal(field(document, "export"), "[]");
  assert.equal(field(document, "inheritanceState"), page.t("configuration.inherited"));
  assert.equal(field(dom(page.variableConfiguration({ value: "legacy", declaredHere: true }, false)), "export"), '["agents"]');
  assert.equal(field(dom(page.variableConfiguration({}, true)), "effectiveValue"), page.t("configuration.notDeclared"));
  assert.equal(field(dom(page.variableConfiguration({}, true)), "export"), "[]");
  const coordination = presentation({ coordination: true });
  assert.equal(field(dom(coordination.variableConfiguration(variable, false)), "target"), "library:selected");
});

test("presentation keeps explicit falsy and empty values, and uses text for metadata", () => {
  const page = presentation({ contract: { ...readback, sharing: "Library <example> & project" } });
  assert.equal(page.configurationValue(false), "false");
  assert.equal(page.configurationValue(0), "0");
  assert.equal(page.configurationValue(""), '""');
  const document = dom(page.configurationMetadata({ key: readback.key, declaredValue: "", currentValue: "" }));
  assert.equal(field(document, "declaredValue"), '""');
  assert.equal(field(document, "sharing"), "Library <example> & project");
  assert.equal(document.querySelector("example"), null);
});

test("all rendered configuration field labels and browser preference descriptions exist in every locale", () => {
  const labelKeys = [...block("  const configurationFields =", "  const configurationOverview =").matchAll(/t\("(configuration\.[^"]+)"\)/gu)].map((match) => match[1]);
  for (const [locale, table] of Object.entries(locales)) {
    for (const key of [...labelKeys, "configuration.browserPreference"]) assert.ok(table[key]?.trim(), `${locale}: ${key}`);
  }
  assert.ok(source.includes('control?.setAttribute("aria-description", t("configuration.browserPreference"))'));
  assert.equal(source.match(/\$\{modelPolicyConfiguration\(host, entry\)\}/gu)?.length, 2, "both host policy entry points carry the same contract");
});

test("CFG-P01: backup inventory separates counts, completion and scan times in all five locales", () => {
  for (const locale of Object.keys(locales)) {
    const t = (key) => locales[locale][key] ?? key;
    const renderer = new Function("t", "esc", block("  const configBackupStatus =", "  const renderConfigBackups =") + "return configBackupMarkup;")(t, esc);
    const result = renderer({ schemaVersion: "einzbern.config-backup-list.v1", scanStatus: "partial", scannedAt: "2026-10-20T10:00:00Z", groups: [{ backupGroupId: "group-1", hostname: "Device <one>", activeCount: 2, transactionCount: 1, recoverableCount: 3, bytes: 4096, completedAt: "2026-10-19T00:00:00Z", integrity: "missing-index", syncStatus: "unknown", error: "INDEX_MISSING" }] });
    const document = dom(result);
    assert.equal(document.querySelector('[data-backup-field="active"] dd').textContent, "2");
    assert.equal(document.querySelector('[data-backup-field="transactions"] dd').textContent, "1");
    assert.equal(document.querySelector('[data-backup-field="recoverable"] dd').textContent, "3");
    assert.equal(document.querySelector('[data-backup-field="completedAt"] dd').textContent, "2026-10-19T00:00:00Z");
    assert.equal(document.querySelector('[data-backup-field="sync"] dd').textContent, locales[locale]["backup.status.unknown"]);
    assert.ok(document.querySelector('[data-backup-error]'));
    assert.equal(document.querySelector("one"), null);
    assert.equal(document.querySelector("button, input, form"), null);
    assert.ok(!document.body.textContent.includes("backup."));
    assert.ok(renderer(null).includes('data-backup-scan-status="not-scanned"'));
    assert.ok(renderer({}).includes('data-backup-scan-status="unreadable"'));
  }
});
