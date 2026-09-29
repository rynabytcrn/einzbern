// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-484 R1, R2, AC1-AC3 (MIN-227 D12; TCRN-CROSS-SUB-340): custom variables and the
// two variable sections of AGENTS.md. A variable is a configuration record of its own collection,
// not a setting, so settings-catalog never lists one; a value or description shaped like a
// credential is refused when written; the system section renders models.category and models.tiers
// (TCRN-CROSS-STORY-508 R1, R2), each in ascending order, the three models.escalation settings
// (TCRN-CROSS-STORY-508 R3, R8, AC7; TCRN-CROSS-SUB-407) and design.authority, and nothing else; the
// custom section renders every variable;
// both are managed sections, and neither ever renders an absolute path.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { SETTINGS_CATALOG, initializeLibrary, materializeWorkspace, registerLibrary, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { configRecord, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { absolutePathLine, managedSectionRecordsFor, parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import {
  SYSTEM_VARIABLE_KEYS,
  VARIABLES_CUSTOM_SECTION_ID,
  VARIABLES_SYSTEM_SECTION_ID,
  renderCustomVariablesSection,
  renderSystemVariablesSection,
  writeVariablesSections,
} from "../dist/build/packages/core/src/variables-sections.js";
import { compareRecordOrder, listVariables, looksSecretShaped, removeVariable, setVariable, variablesInRenderOrder } from "../dist/build/packages/core/src/variables.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const OWNER_TEXT = "# Project rules\n\nImplement with the main tier.\n";

async function project(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-variables-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const library = join(root, ".ether");
  await initializeLibrary({ root: library, createdAt: at() });
  return { root, library, agents: join(root, "AGENTS.md"), backupRoot: join(base, "backups") };
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function asAtelier(operation) {
  const previous = process.env.EINZBERN_SURFACE;
  process.env.EINZBERN_SURFACE = "atelier";
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_SURFACE;
    else process.env.EINZBERN_SURFACE = previous;
  }
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

async function write(fx, extra = {}) {
  return writeVariablesSections(fx.library, { projectRoot: fx.root, backupRoot: fx.backupRoot, occurredAt: at(), ...extra });
}

async function sections(fx) {
  const parsed = parseManagedFile(await readFile(fx.agents, "utf8"), "AGENTS.md");
  return Object.fromEntries(parsed.sections.map((section) => [section.id, section.body]));
}

test("484-AC1: a new variable deploy.host is a row of the custom section and not a setting", async (context) => {
  const fx = await project(context);
  await writeFile(fx.agents, OWNER_TEXT);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", description: "Where a release deploys", occurredAt: at() });
  const result = await write(fx);
  assert.equal(result.written, true);
  assert.deepEqual(result.sections.map((decision) => [decision.id, decision.result]), [[VARIABLES_SYSTEM_SECTION_ID, "create"], [VARIABLES_CUSTOM_SECTION_ID, "create"]]);
  assert.deepEqual(result.withheld, []);
  const text = await readFile(fx.agents, "utf8");
  assert.ok(text.startsWith(OWNER_TEXT), "the Owner's text outside the sections is kept");
  const bodies = await sections(fx);
  assert.match(bodies[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.host \| string \| build\.example\.com \| Where a release deploys \|$/mu);
  const catalog = await cli(["settings-catalog", "--workspace", fx.library]);
  assert.equal(catalog.settings.some((entry) => entry.key === "deploy.host"), false, "a variable is not in the settings catalog");
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(listVariables(state), [{ name: "deploy.host", type: "string", value: "build.example.com", description: "Where a release deploys" }]);
  assert.deepEqual(managedSectionRecordsFor(state, "AGENTS.md").map((record) => [record.id, record.rev, record.state]),
    [[VARIABLES_CUSTOM_SECTION_ID, 1, "managed"], [VARIABLES_SYSTEM_SECTION_ID, 1, "managed"]], "the library records both sections");

  const version = state.version;
  const again = await write(fx);
  assert.equal(again.written, false, "a second render with nothing changed writes nothing");
  assert.equal((await materializeWorkspace(fx.library)).version, version, "and records nothing");
});

test("484-R2/T15: CLI writes render safely, pending sections are readable, and an explicit resolve can settle them", async (context) => {
  const fx = await project(context);
  await writeFile(fx.agents, OWNER_TEXT);
  await registerLibrary({ projectPath: fx.root, libraryPath: fx.library, registeredAt: at() });

  const first = await asAtelier(() => cli(["variable-set", "--workspace", fx.library, "--at", at(), "--name", "deploy.host", "--type", "string", "--value", "build.example.com"]));
  assert.equal(first.variable.value, "build.example.com");
  assert.match((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.host \| string \| build\.example\.com \|  \|$/mu);

  await asAtelier(() => cli(["variable-set", "--workspace", fx.library, "--at", at(), "--name", "deploy.path", "--type", "string", "--value", "/srv/build"]));
  assert.doesNotMatch((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /deploy\.path/u, "an absolute path stays out of the committed section");
  const withheld = await cli(["variable-list", "--workspace", fx.library]);
  assert.deepEqual(withheld.withheld, [{ name: "deploy.path", reason: "absolute-path" }]);
  assert.deepEqual(withheld.pendingSections, [VARIABLES_CUSTOM_SECTION_ID], "the withheld variable remains a persistent pending item");
  assert.equal(configRecord(await materializeWorkspace(fx.library), "managed-section", `AGENTS.md#${VARIABLES_CUSTOM_SECTION_ID}`).value.state, "pending");
  await asAtelier(() => cli(["variable-set", "--workspace", fx.library, "--at", at(), "--name", "deploy.path", "--type", "string", "--value", "build/config"]));
  assert.match((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.path \| string \| build\/config \|  \|$/mu);
  assert.deepEqual((await cli(["variable-list", "--workspace", fx.library])).pendingSections, [], "making the variable safe settles the pending state");

  const beforeEdit = await readFile(fx.agents, "utf8");
  const edited = beforeEdit.replace("build.example.com", "hand.example.com");
  await writeFile(fx.agents, edited);
  await asAtelier(() => cli(["variable-set", "--workspace", fx.library, "--at", at(), "--name", "deploy.port", "--type", "number", "--value", "8443"]));
  assert.equal(await readFile(fx.agents, "utf8"), edited, "a variable write does not overwrite the user's changed managed section");

  const pending = await cli(["variable-list", "--workspace", fx.library]);
  assert.deepEqual(pending.pendingSections, [VARIABLES_CUSTOM_SECTION_ID]);
  assert.deepEqual(pending.withheld, []);
  assert.deepEqual(pending.variables.map((variable) => variable.name), ["deploy.host", "deploy.path", "deploy.port"]);

  const resolved = await cli(["rule-resolve", "--project", fx.root, "--section", VARIABLES_CUSTOM_SECTION_ID, "--action", "overwrite", "--at", at()]);
  assert.deepEqual([resolved.reasonCode, resolved.action, resolved.state], ["MANAGED_SECTION_RESOLVED", "overwrite", "managed"]);
  const settled = await cli(["variable-list", "--workspace", fx.library]);
  assert.deepEqual(settled.pendingSections, []);
  const body = (await sections(fx))[VARIABLES_CUSTOM_SECTION_ID];
  assert.match(body, /^\| deploy\.host \| string \| build\.example\.com \|  \|$/mu);
  assert.match(body, /^\| deploy\.port \| number \| 8443 \|  \|$/mu);

  await asAtelier(() => cli(["variable-remove", "--workspace", fx.library, "--at", at(), "--name", "deploy.host"]));
  assert.doesNotMatch((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /deploy\.host/u);
});

test("484-AC2: a value shaped like a credential is refused, and nothing is recorded", async (context) => {
  const fx = await project(context);
  const before = (await materializeWorkspace(fx.library)).version;
  const error = await refusal(() => setVariable(fx.library, { name: "api.key", type: "string", value: "sk-proj-0123456789abcdef", occurredAt: at() }));
  assert.equal(error.reasonCode, "VARIABLE_SECRET_SHAPED");
  assert.deepEqual([error.details.name, error.details.field, error.details.matched], ["api.key", "value", "sk-"]);
  const inDescription = await refusal(() => setVariable(fx.library, { name: "api.note", type: "string", value: "see the vault", description: "old key ghp_0123456789abcdefABCDEF", occurredAt: at() }));
  assert.deepEqual([inDescription.reasonCode, inDescription.details.field], ["VARIABLE_SECRET_SHAPED", "description"]);
  assert.equal((await materializeWorkspace(fx.library)).version, before);

  for (const [text, matched] of [
    ["sk-ant-api03-abcdef", "sk-"],
    ["key=sk-live", "sk-"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIA"],
    ["ASIAY34FZKBOKMUTVV7A", "ASIA"],
    ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ghp_"],
    ["gho_16C7e42F292c6912E7710c838347Ae178B4a", "gho_"],
    ["github_pat_11ABCDEFG0123456789", "github_pat_"],
    ["xoxb-123456789012-abcdef", "xoxb-"],
    ["xoxp-123456789012-abcdef", "xoxp-"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key"],
    ["-----BEGIN PRIVATE KEY-----", "private-key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature", "jwt"],
    ["hbEFDVYY6hWPZO8QDOkHk2rpvsKyy/lD", "high-entropy"],
    ["Bearer vFsz9uYzijFat1aP85ovYAOyMQVtn7eP9GRQ4FxT", "high-entropy"],
    ["09654fe80af35c1628d64d9d27a3d5f82fb8a92d", "high-entropy"],
    ["984a23a0-739a-431b-8190-d93383a0304c", "high-entropy"],
  ]) {
    assert.equal(looksSecretShaped(text), matched, text);
  }
  for (const text of [
    "build.example.com",
    "risk-free",
    "task-runner",
    "release-2026-09-26-candidate-build",
    "feature_flag_enable_new_checkout_flow_v2",
    "someVeryLongIdentifierNameForTesting123",
    "https://docs.example.com/guides/deploying-a-release",
    "The sk- prefixed key lives in the vault, not here.",
    "claude-opus-5-5",
  ]) {
    assert.equal(looksSecretShaped(text), null, text);
  }
});

// TCRN-CROSS-STORY-508 R2, R8 (TCRN-CROSS-SUB-405): models.tiers is one table of records, rendered in
// ascending order with its order, category, runner, model, effort and note.
const tierRecord = (order, category, runner, model, effort, note = "") => ({ order, category, runner, model, effort, note });

// The lines of one subsection of the system section, from its heading to the next, and their table rows.
function subsection(body, heading) {
  const lines = body.split("\n");
  const start = lines.indexOf(`### ${heading}`);
  assert.notEqual(start, -1, `### ${heading}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("### "));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}
const tableRows = (lines) => lines.filter((line) => line.startsWith("| "));

test("484-AC3, 508-R2: an economy record on codex-cli shows that runner in the system section, the records in ascending order", async (context) => {
  const fx = await project(context);
  const tiers = [
    tierRecord(30, "main", "codex", "fixture-codex-main", "high", "second opinion"),
    tierRecord(10, "flagship", "claude-code", "fixture-flagship", "max"),
    tierRecord(40, "economy", "codex-cli", "fixture-codex", "max"),
    tierRecord(20, "main", "claude-code", "fixture-main", "max"),
  ];
  await setWorkspaceSetting(fx.library, { key: "models.tiers", value: JSON.stringify(tiers), occurredAt: at() });
  const rendered = renderSystemVariablesSection(await materializeWorkspace(fx.library));
  assert.deepEqual(tableRows(subsection(rendered.body, "models.tiers")), [
    "| Order | Category | Runner | Model | Effort | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    "| 10 | flagship | claude-code | fixture-flagship | max |  |",
    "| 20 | main | claude-code | fixture-main | max |  |",
    "| 30 | main | codex | fixture-codex-main | high | second opinion |",
    "| 40 | economy | codex-cli | fixture-codex | max |  |",
  ], "one row per record, by order; an empty note is an empty cell");
  await write(fx);
  assert.match((await sections(fx))[VARIABLES_SYSTEM_SECTION_ID], /^\| 40 \| economy \| codex-cli \| fixture-codex \| max \| {2}\|$/mu);
});

const SYSTEM_HEADINGS = ["### models.category", "### models.tiers", "### models.escalation", "### design.authority"];

test("484-R2, 508-R8: the system section holds the categories, the tiers, the three escalation settings and design.authority, and no other setting", async (context) => {
  const fx = await project(context);
  assert.deepEqual(SYSTEM_VARIABLE_KEYS, ["models.category", "models.tiers", "models.escalation.enabled", "models.escalation.threshold", "models.escalation.ceiling", "design.authority"]);
  const unset = renderSystemVariablesSection(await materializeWorkspace(fx.library));
  assert.deepEqual(unset.body.match(/^### .+$/gmu), SYSTEM_HEADINGS, "one subsection each, in this order");
  assert.deepEqual(tableRows(subsection(unset.body, "models.category")), [
    "| Order | Id | Name | Description |",
    "| --- | --- | --- | --- |",
    "| 10 | flagship | flagship |  |",
    "| 20 | main | main |  |",
    "| 30 | economy | economy |  |",
  ], "the default categories, by order");
  assert.match(unset.body, /^\| 60 \| economy \| claude-code \| \(unset\) \| \(unset\) \| {2}\|$/mu, "the default table, unfilled");
  assert.deepEqual(tableRows(subsection(unset.body, "models.escalation")), [
    "| Setting | Value |",
    "| --- | --- |",
    "| models.escalation.enabled | true |",
    "| models.escalation.threshold | 1 |",
    "| models.escalation.ceiling | main |",
  ], "the escalation defaults");
  assert.match(unset.body, /^### design\.authority\n\n\(unset\)$/mu);
  await setWorkspaceSetting(fx.library, { key: "design.authority", value: "https://design.example/system", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "retrieval.tau", value: "3", occurredAt: at() });
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  const body = renderSystemVariablesSection(state).body;
  assert.match(body, /^### design\.authority\n\nhttps:\/\/design\.example\/system$/mu);
  const others = SETTINGS_CATALOG.map((entry) => entry.key).filter((key) => !SYSTEM_VARIABLE_KEYS.includes(key));
  assert.deepEqual(others.filter((key) => body.includes(key)), [], "no other setting is named");
  assert.deepEqual(SYSTEM_VARIABLE_KEYS.filter((key) => !body.includes(key)), [], "every system setting is");
  assert.equal(body.includes("deploy.host"), false, "and no custom variable");
  assert.deepEqual(body.match(/^### .+$/gmu), SYSTEM_HEADINGS);
  assert.equal(renderCustomVariablesSection(state).body.includes("design.authority"), false);
});

test("508-AC7: GIVEN categories, tiers, escalation settings and design.authority WHEN AGENTS.md is rendered THEN its system section holds the categories, the tiers in order and the three escalation settings beside design.authority, and no absolute path", async (context) => {
  const fx = await project(context);
  const categories = [
    { id: "economy", name: "Economy", description: "routine work", order: 30 },
    { id: "flagship", name: "Flagship", description: "", order: 10 },
    { id: "main", name: "Main", description: "implementation | review", order: 20 },
  ];
  await setWorkspaceSetting(fx.library, { key: "models.category", value: JSON.stringify(categories), occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "models.tiers", value: JSON.stringify([
    tierRecord(40, "economy", "claude-code", "fixture-main", "low", "cheap first"),
    tierRecord(10, "flagship", "claude-code", "fixture-flagship", "max"),
    tierRecord(30, "main", "claude-code", "fixture-main", "max"),
  ]), occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "models.escalation.enabled", value: "false", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "models.escalation.threshold", value: "2", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "models.escalation.ceiling", value: "flagship", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "design.authority", value: "https://design.example/system", occurredAt: at() });
  const result = await write(fx);
  assert.deepEqual(result.withheld, []);
  const body = (await sections(fx))[VARIABLES_SYSTEM_SECTION_ID];
  assert.deepEqual(body.match(/^### .+$/gmu), SYSTEM_HEADINGS);
  assert.deepEqual(tableRows(subsection(body, "models.category")).slice(2), [
    "| 10 | flagship | Flagship |  |",
    "| 20 | main | Main | implementation \\| review |",
    "| 30 | economy | Economy | routine work |",
  ], "by order; a pipe in a cell is escaped");
  assert.deepEqual(tableRows(subsection(body, "models.tiers")).slice(2), [
    "| 10 | flagship | claude-code | fixture-flagship | max |  |",
    "| 30 | main | claude-code | fixture-main | max |  |",
    "| 40 | economy | claude-code | fixture-main | low | cheap first |",
  ], "by order");
  assert.deepEqual(tableRows(subsection(body, "models.escalation")).slice(2), [
    "| models.escalation.enabled | false |",
    "| models.escalation.threshold | 2 |",
    "| models.escalation.ceiling | flagship |",
  ]);
  assert.deepEqual(subsection(body, "design.authority").filter((line) => line !== ""), ["https://design.example/system"]);
  assert.equal(absolutePathLine(body), null, "no line names an absolute path");
  const text = await readFile(fx.agents, "utf8");
  for (const path of [fx.library, fx.root, fx.backupRoot]) assert.equal(text.includes(path), false, "not even the library's or the project's own");
});

test("508-R8: a category whose name or description would put an absolute path or a credential into AGENTS.md is withheld with its reason, and the rest is written", async (context) => {
  const fx = await project(context);
  await setWorkspaceSetting(fx.library, { key: "models.category", value: JSON.stringify([
    { id: "flagship", name: "Flagship", description: "see /opt/models/flagship", order: 10 },
    { id: "main", name: "sk-proj-0123456789abcdef", description: "", order: 20 },
    { id: "economy", name: "Economy", description: "routine work", order: 30 },
  ]), occurredAt: at() });
  const result = await write(fx);
  assert.deepEqual(result.withheld, [
    { name: "models.category.flagship", reason: "absolute-path" },
    { name: "models.category.main", reason: "secret-shaped" },
  ]);
  assert.deepEqual(result.pendingSections, [], "a withheld system row leaves the section managed, as before");
  assert.deepEqual(tableRows(subsection((await sections(fx))[VARIABLES_SYSTEM_SECTION_ID], "models.category")).slice(2), [
    "| 10 | flagship | (withheld) | (withheld) |",
    "| 20 | main | (withheld) | (withheld) |",
    "| 30 | economy | Economy | routine work |",
  ]);
  const text = await readFile(fx.agents, "utf8");
  for (const shown of ["/opt/models", "sk-proj"]) assert.equal(text.includes(shown), false, shown);
});

test("508-R8: a changed escalation setting replaces the system section, and a system section the user edited is left as it is", async (context) => {
  const fx = await project(context);
  await write(fx);
  await setWorkspaceSetting(fx.library, { key: "models.escalation.threshold", value: "3", occurredAt: at() });
  const replaced = await write(fx);
  assert.deepEqual(replaced.sections.map((decision) => [decision.id, decision.result, decision.record.rev]), [[VARIABLES_SYSTEM_SECTION_ID, "replace", 2], [VARIABLES_CUSTOM_SECTION_ID, "unchanged", 1]]);
  assert.match((await sections(fx))[VARIABLES_SYSTEM_SECTION_ID], /^\| models\.escalation\.threshold \| 3 \|$/mu);
  // The three digests no longer agree once the user edits the section, so the next change does not replace it.
  const edited = (await readFile(fx.agents, "utf8")).replace("| models.escalation.threshold | 3 |", "| models.escalation.threshold | 9 |");
  await writeFile(fx.agents, edited);
  await setWorkspaceSetting(fx.library, { key: "models.escalation.ceiling", value: "flagship", occurredAt: at() });
  const kept = await write(fx);
  assert.deepEqual(kept.pendingSections, [VARIABLES_SYSTEM_SECTION_ID]);
  assert.equal(await readFile(fx.agents, "utf8"), edited, "the user's section stays as it is");
  assert.equal(configRecord(await materializeWorkspace(fx.library), "managed-section", `AGENTS.md#${VARIABLES_SYSTEM_SECTION_ID}`).value.state, "pending");
});

test("484-R1: variable names, types and values follow their rules, and a system setting's key is not a variable name", async (context) => {
  const fx = await project(context);
  const set = (input) => setVariable(fx.library, { occurredAt: at(), ...input });
  for (const name of ["Deploy.host", "1host", "deploy host", "a".repeat(65), "", "models.tiers", "retrieval.tau"]) {
    assert.equal((await refusal(() => set({ name, type: "string", value: "x" }))).reasonCode, "VARIABLE_NAME_INVALID", name);
  }
  assert.equal((await refusal(() => set({ name: "models.tiers", type: "string", value: "x" }))).details.reason, "system-setting");
  assert.equal((await refusal(() => set({ name: "deploy.list", type: "list", value: "x" }))).reasonCode, "VARIABLE_TYPE_INVALID");
  for (const [type, value] of [["number", "1e3"], ["number", "abc"], ["number", "01"], ["boolean", "yes"], ["string", "two\nlines"], ["string", "x".repeat(1025)]]) {
    assert.equal((await refusal(() => set({ name: "deploy.value", type, value }))).reasonCode, "VARIABLE_VALUE_INVALID", `${type} ${value.slice(0, 12)}`);
  }
  assert.equal((await refusal(() => set({ name: "deploy.value", type: "string", value: "x", description: "a\tb" }))).reasonCode, "VARIABLE_DESCRIPTION_INVALID");
  await set({ name: "deploy.replicas", type: "number", value: "-3.5" });
  await set({ name: "deploy.enabled", type: "boolean", value: "true" });
  await set({ name: "deploy.sshHost", type: "string", value: "", description: "" });
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)).map((variable) => [variable.name, variable.type, variable.value]),
    [["deploy.enabled", "boolean", "true"], ["deploy.replicas", "number", "-3.5"], ["deploy.sshHost", "string", ""]]);
});

test("484-R1: a variable is changed and removed; the next render follows, and removing it twice is refused", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await write(fx);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "release.example.com", description: "Where a release deploys", occurredAt: at() });
  const changed = await write(fx);
  assert.deepEqual(changed.sections.map((decision) => [decision.id, decision.result, decision.record.rev]), [[VARIABLES_SYSTEM_SECTION_ID, "unchanged", 1], [VARIABLES_CUSTOM_SECTION_ID, "replace", 2]]);
  assert.match((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.host \| string \| release\.example\.com \| Where a release deploys \|$/mu);
  await removeVariable(fx.library, { name: "deploy.host", occurredAt: at() });
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)), []);
  assert.equal((await refusal(() => removeVariable(fx.library, { name: "deploy.host", occurredAt: at() }))).reasonCode, "CONFIG_RECORD_NOT_FOUND");
  await write(fx);
  assert.match((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /^\(none\)$/mu);
});

test("484-R2: a variable whose row would name an absolute path is withheld with its reason; the others are written", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "build.root", type: "string", value: "/srv/build/output", occurredAt: at() });
  await setVariable(fx.library, { name: "build.share", type: "string", value: "C:\\builds", occurredAt: at() });
  await setVariable(fx.library, { name: "build.note", type: "string", value: "fast", description: "cache in /var/cache/build", occurredAt: at() });
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "models.tiers", value: JSON.stringify([tierRecord(10, "economy", "codex-cli", "/opt/models/local", "low")]), occurredAt: at() });
  const result = await write(fx);
  assert.deepEqual(result.withheld, [
    { name: "models.tiers.10", reason: "absolute-path" },
    { name: "build.note", reason: "absolute-path" },
    { name: "build.root", reason: "absolute-path" },
    { name: "build.share", reason: "absolute-path" },
  ]);
  assert.deepEqual(result.pendingSections, [VARIABLES_CUSTOM_SECTION_ID]);
  assert.equal(configRecord(await materializeWorkspace(fx.library), "managed-section", `AGENTS.md#${VARIABLES_CUSTOM_SECTION_ID}`).value.state, "pending");
  const text = await readFile(fx.agents, "utf8");
  for (const path of ["/srv/build", "C:\\builds", "/var/cache", "/opt/models"]) assert.equal(text.includes(path), false, path);
  const bodies = await sections(fx);
  assert.match(bodies[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.host \| string \| build\.example\.com \|  \|$/mu, "an empty description is an empty cell");
  assert.match(bodies[VARIABLES_SYSTEM_SECTION_ID], /^\| 10 \| economy \| codex-cli \| \(withheld\) \| \(withheld\) \| \(withheld\) \|$/mu);
});

test("484-R2: a section the user edited is left as it is and goes pending in the library", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await write(fx);
  const text = await readFile(fx.agents, "utf8");
  const edited = text.replace("| deploy.host | string | build.example.com |", "| deploy.host | string | hand.example.com |");
  assert.notEqual(edited, text);
  await writeFile(fx.agents, edited);
  await setVariable(fx.library, { name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
  const result = await write(fx);
  assert.deepEqual(result.pendingSections, [VARIABLES_CUSTOM_SECTION_ID]);
  assert.equal(await readFile(fx.agents, "utf8"), edited, "nothing else changed, so the file is not written");
  const record = configRecord(await materializeWorkspace(fx.library), "managed-section", `AGENTS.md#${VARIABLES_CUSTOM_SECTION_ID}`);
  assert.equal(record.value.state, "pending");
});

test("484-R1, R2: the variable collection checks a record's shape on every write and replay; the credential check guards the write and the render", async (context) => {
  const fx = await project(context);
  const invalid = await refusal(() => setConfigRecord(fx.library, { collection: "variable", key: "deploy.host", value: { type: "list", value: "x", description: "" }, occurredAt: at() }));
  assert.deepEqual([invalid.reasonCode, invalid.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "VARIABLE_TYPE_INVALID"]);
  const extra = await refusal(() => setConfigRecord(fx.library, { collection: "variable", key: "deploy.host", value: { type: "string", value: "x", description: "", note: "y" }, occurredAt: at() }));
  assert.deepEqual([extra.reasonCode, extra.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "VARIABLE_RECORD_INVALID"]);
  const badKey = await refusal(() => setConfigRecord(fx.library, { collection: "variable", key: "Deploy", value: { type: "string", value: "x", description: "" }, occurredAt: at() }));
  assert.deepEqual([badKey.reasonCode, badKey.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "VARIABLE_NAME_INVALID"]);
  // The credential heuristic is the write path's, not the record's: a record that only a later,
  // stricter heuristic would refuse still replays as it was recorded.
  await setConfigRecord(fx.library, { collection: "variable", key: "legacy.token", value: { type: "string", value: "sk-recorded-before", description: "" }, occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(listVariables(state).map((variable) => variable.name), ["legacy.token"]);
  assert.deepEqual(state.library.rejectedEvents, []);
  // AGENTS.md is committed, so the render withholds that record too.
  const result = await write(fx);
  assert.deepEqual(result.withheld, [{ name: "legacy.token", reason: "secret-shaped" }]);
  assert.equal((await readFile(fx.agents, "utf8")).includes("sk-recorded"), false);
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): a variable may hold an order, and the
// custom section renders the variables with one first, by order, then the others by name.
const customRows = async (fx) => (await sections(fx))[VARIABLES_CUSTOM_SECTION_ID].split("\n").filter((line) => /^\| [a-z]/u.test(line)).map((line) => line.split(" | ")[0].slice(2));

test("508-R7: GIVEN variables with an order WHEN AGENTS.md is rendered THEN they come first, by order, and the rest by name", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "alpha", type: "string", value: "a", occurredAt: at() });
  await setVariable(fx.library, { name: "bravo", type: "string", value: "b", order: 2, occurredAt: at() });
  await setVariable(fx.library, { name: "charlie", type: "string", value: "c", order: 1, occurredAt: at() });
  await setVariable(fx.library, { name: "delta", type: "string", value: "d", occurredAt: at() });
  await setVariable(fx.library, { name: "echo", type: "string", value: "e", order: 2, occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  // The records hold the order only when one was given; variable-list stays by name.
  assert.deepEqual(configRecord(state, "variable", "charlie").value, { type: "string", value: "c", description: "", order: 1 });
  assert.deepEqual(configRecord(state, "variable", "alpha").value, { type: "string", value: "a", description: "" });
  assert.deepEqual(listVariables(state).map((variable) => [variable.name, variable.order]), [["alpha", undefined], ["bravo", 2], ["charlie", 1], ["delta", undefined], ["echo", 2]]);
  assert.deepEqual(variablesInRenderOrder(state).map((variable) => variable.name), ["charlie", "bravo", "echo", "alpha", "delta"], "one order keeps name order among its variables");

  await write(fx);
  assert.deepEqual(await customRows(fx), ["charlie", "bravo", "echo", "alpha", "delta"]);
  const body = (await sections(fx))[VARIABLES_CUSTOM_SECTION_ID];
  assert.match(body, /^\| Name \| Type \| Value \| Description \|$/mu, "the order is not a column");

  // variable-set writes the whole record: set again without an order, the variable has none.
  await setVariable(fx.library, { name: "charlie", type: "string", value: "c", occurredAt: at() });
  assert.equal(Object.hasOwn(configRecord(await materializeWorkspace(fx.library), "variable", "charlie").value, "order"), false);
  const moved = await write(fx);
  assert.deepEqual(moved.sections.map((decision) => [decision.id, decision.result]), [[VARIABLES_SYSTEM_SECTION_ID, "unchanged"], [VARIABLES_CUSTOM_SECTION_ID, "replace"]]);
  assert.deepEqual(await customRows(fx), ["bravo", "echo", "alpha", "charlie", "delta"]);

  assert.equal(compareRecordOrder({ order: 1 }, {}), -1);
  assert.equal(compareRecordOrder({}, { order: 1 }), 1);
  assert.equal(compareRecordOrder({}, {}), 0);
  assert.equal(compareRecordOrder({ order: 3 }, { order: 3 }), 0);
});

test("508-R7: GIVEN no variable holds an order THEN the custom section renders by name as before", async (context) => {
  const fx = await project(context);
  for (const name of ["zulu", "alpha", "mike"]) await setVariable(fx.library, { name, type: "string", value: name, occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(variablesInRenderOrder(state), listVariables(state));
  await write(fx);
  assert.deepEqual(await customRows(fx), ["alpha", "mike", "zulu"]);
});

test("508-R7: a reorder is a change of the custom section, so a section the user edited is not overwritten by it", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "alpha", type: "string", value: "a", occurredAt: at() });
  await setVariable(fx.library, { name: "bravo", type: "string", value: "b", occurredAt: at() });
  await write(fx);
  const edited = (await readFile(fx.agents, "utf8")).replace("| alpha | string | a |", "| alpha | string | hand |");
  await writeFile(fx.agents, edited);
  await setVariable(fx.library, { name: "bravo", type: "string", value: "b", order: 1, occurredAt: at() });
  const result = await write(fx);
  assert.deepEqual(result.pendingSections, [VARIABLES_CUSTOM_SECTION_ID]);
  assert.equal(await readFile(fx.agents, "utf8"), edited, "the user's section stays as it is");
});

test("508-R7: the variable collection checks an order on every write and replay", async (context) => {
  const fx = await project(context);
  const before = (await materializeWorkspace(fx.library)).version;
  for (const order of [0, -1, "1", null]) {
    const refused = await refusal(() => setConfigRecord(fx.library, { collection: "variable", key: "deploy.host", value: { type: "string", value: "x", description: "", order }, occurredAt: at() }));
    assert.deepEqual([refused.reasonCode, refused.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "VARIABLE_RECORD_INVALID"], JSON.stringify(order));
  }
  // A fraction is not canonical JSON, so the record is refused before its collection looks at it.
  const fraction = await refusal(() => setConfigRecord(fx.library, { collection: "variable", key: "deploy.host", value: { type: "string", value: "x", description: "", order: 1.5 }, occurredAt: at() }));
  assert.equal(fraction.reasonCode, "CONFIG_RECORD_VALUE_INVALID");
  const input = await refusal(() => setVariable(fx.library, { name: "deploy.host", type: "string", value: "x", order: 0, occurredAt: at() }));
  assert.deepEqual([input.reasonCode, input.details.name, input.details.field], ["VARIABLE_RECORD_INVALID", "deploy.host", "order"]);
  assert.equal((await materializeWorkspace(fx.library)).version, before, "no refused order was recorded");
  await setConfigRecord(fx.library, { collection: "variable", key: "deploy.host", value: { type: "string", value: "x", description: "", order: 7 }, occurredAt: at() });
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)), [{ name: "deploy.host", type: "string", value: "x", description: "", order: 7 }]);
});

// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366, R18 continuation revision): the section render that
// follows variable-set and variable-remove writes AGENTS.md before it commits the section records.
// When that commit fails, the file goes back to what it held byte for byte, a file the render created
// is taken away, the backup the write made stays, the library holds no new event, and the error that
// stopped the commit is the one thrown. The commit is refused the way tests/agents-sections.test.mjs
// refuses it: viewBudgetBytes narrows the view budget, a refusal that comes after the file was
// written. A crash after the event commit (crashAt) leaves the records in the library, and the file
// stays as it was written.
const OVER_BUDGET = Object.freeze({ viewBudgetBytes: 1 });
const AFTER_COMMIT = Object.freeze({ crashAt: "after-event-commit" });

async function libraryHead(fx) {
  const { version, headEventHash } = await materializeWorkspace(fx.library);
  return { version, headEventHash };
}

async function bytesOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Whether a file under the backups holds `bytes`: the copy a write makes before it replaces a file.
async function backedUp(fx, bytes) {
  const entries = await readdir(fx.backupRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (await readFile(join(entry.parentPath, entry.name))).equals(bytes)) return true;
  }
  return false;
}

test("489: a variable-section write whose records cannot be committed leaves AGENTS.md byte for byte, and takes away one it created", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const head = await libraryHead(fx);
  // No AGENTS.md: the file the render created is not there afterwards.
  const created = await refusal(() => write(fx, OVER_BUDGET));
  assert.equal(created.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", "the error that stopped the commit is the one thrown");
  assert.equal(await bytesOrNull(fx.agents), null, "the AGENTS.md the render created is taken away");
  assert.deepEqual(await libraryHead(fx), head, "the library holds no new event");

  // The Owner's AGENTS.md holds what it held, byte for byte, and the backup the write made stays.
  await writeFile(fx.agents, OWNER_TEXT);
  const original = await readFile(fx.agents);
  const refused = await refusal(() => write(fx, OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(fx.agents), original, "AGENTS.md holds what it held");
  assert.deepEqual(await libraryHead(fx), head, "the library holds no new event");
  assert.equal(await backedUp(fx, original), true, "the backup the write made stays");

  // A replace that cannot be recorded leaves the sections as their records say, so the next render does not take them for the user's change.
  await write(fx);
  const written = await readFile(fx.agents);
  const records = managedSectionRecordsFor(await materializeWorkspace(fx.library), "AGENTS.md");
  await setVariable(fx.library, { name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
  const recorded = await libraryHead(fx);
  const again = await refusal(() => write(fx, OVER_BUDGET));
  assert.equal(again.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(fx.agents), written, "AGENTS.md holds the sections the library records");
  assert.deepEqual([managedSectionRecordsFor(await materializeWorkspace(fx.library), "AGENTS.md"), await libraryHead(fx)], [records, recorded], "the records and the library are as they were");

  // The normal path is as it was: the same render, committed, replaces the custom section.
  const replaced = await write(fx);
  assert.deepEqual([replaced.written, replaced.pendingSections], [true, []], "no section waits for a change the user never made");
  assert.equal(replaced.sections.find((decision) => decision.id === VARIABLES_CUSTOM_SECTION_ID).result, "replace");
  assert.match((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.port \| number \| 8443 \|  \|$/mu);
});

test("489: a variable-section write whose records went in before the failure (a crash after the event commit) keeps AGENTS.md as written", async (context) => {
  const fx = await project(context);
  await writeFile(fx.agents, OWNER_TEXT);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const head = await libraryHead(fx);
  const error = await refusal(() => write(fx, AFTER_COMMIT));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(fx), head, "the records went in");
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(managedSectionRecordsFor(state, "AGENTS.md").map((record) => [record.id, record.state]), [[VARIABLES_CUSTOM_SECTION_ID, "managed"], [VARIABLES_SYSTEM_SECTION_ID, "managed"]]);
  assert.equal((await readFile(fx.agents, "utf8")).startsWith(OWNER_TEXT), true);
  assert.match((await sections(fx))[VARIABLES_CUSTOM_SECTION_ID], /^\| deploy\.host \| string \| build\.example\.com \|  \|$/mu, "so the sections stay where they were written");
  const again = await write(fx);
  assert.deepEqual([again.written, again.pendingSections], [false, []], "the file and the records agree");
  assert.equal((await materializeWorkspace(fx.library)).version, state.version, "and nothing more is recorded");
});
