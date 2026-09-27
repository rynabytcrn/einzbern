// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-484 R1, R2, AC1-AC3 (MIN-227 D12; TCRN-CROSS-SUB-340): custom variables and the
// two variable sections of AGENTS.md. A variable is a configuration record of its own collection,
// not a setting, so settings-catalog never lists one; a value or description shaped like a
// credential is refused when written; the system section renders models.tiers (host, tier, runner,
// model, effort) and design.authority and nothing else; the custom section renders every variable;
// both are managed sections, and neither ever renders an absolute path.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { SETTINGS_CATALOG, initializeLibrary, materializeWorkspace, registerLibrary, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { configRecord, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { managedSectionRecordsFor, parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import {
  SYSTEM_VARIABLE_KEYS,
  VARIABLES_CUSTOM_SECTION_ID,
  VARIABLES_SYSTEM_SECTION_ID,
  renderCustomVariablesSection,
  renderSystemVariablesSection,
  writeVariablesSections,
} from "../dist/build/packages/core/src/variables-sections.js";
import { listVariables, looksSecretShaped, removeVariable, setVariable } from "../dist/build/packages/core/src/variables.js";

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

async function write(fx) {
  return writeVariablesSections(fx.library, { projectRoot: fx.root, backupRoot: fx.backupRoot, occurredAt: at() });
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

test("484-AC3: an economy tier on codex-cli shows that runner in the system section", async (context) => {
  const fx = await project(context);
  const tiers = {
    "claude-code": {
      flagship: { runner: "claude-code", model: "fixture-flagship", effort: "max" },
      main: { runner: "claude-code", model: "fixture-main", effort: "max" },
      economy: { runner: "codex-cli", model: "fixture-codex", effort: "max" },
    },
    codex: { main: { runner: "codex", model: "fixture-codex-main", effort: "high" } },
  };
  await setWorkspaceSetting(fx.library, { key: "models.tiers", value: JSON.stringify(tiers), occurredAt: at() });
  const rendered = renderSystemVariablesSection(await materializeWorkspace(fx.library));
  assert.deepEqual(rendered.body.split("\n").filter((line) => line.startsWith("| ")), [
    "| Host | Tier | Runner | Model | Effort |",
    "| --- | --- | --- | --- | --- |",
    "| claude-code | flagship | claude-code | fixture-flagship | max |",
    "| claude-code | main | claude-code | fixture-main | max |",
    "| claude-code | economy | codex-cli | fixture-codex | max |",
    "| codex | main | codex | fixture-codex-main | high |",
  ], "one row per host and tier, the default tiers in their order");
  await write(fx);
  assert.match((await sections(fx))[VARIABLES_SYSTEM_SECTION_ID], /^\| claude-code \| economy \| codex-cli \| fixture-codex \| max \|$/mu);
});

test("484-R2: the system section holds models.tiers and design.authority, and no other setting", async (context) => {
  const fx = await project(context);
  assert.deepEqual(SYSTEM_VARIABLE_KEYS, ["models.tiers", "design.authority"]);
  const unset = renderSystemVariablesSection(await materializeWorkspace(fx.library));
  assert.match(unset.body, /^### models\.tiers$/mu);
  assert.match(unset.body, /^\| claude-code \| economy \| claude-code \| \(unset\) \| \(unset\) \|$/mu, "the default table, unfilled");
  assert.match(unset.body, /^### design\.authority\n\n\(unset\)$/mu);
  await setWorkspaceSetting(fx.library, { key: "design.authority", value: "https://design.example/system", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "retrieval.tau", value: "3", occurredAt: at() });
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  const body = renderSystemVariablesSection(state).body;
  assert.match(body, /^### design\.authority\n\nhttps:\/\/design\.example\/system$/mu);
  const others = SETTINGS_CATALOG.map((entry) => entry.key).filter((key) => !SYSTEM_VARIABLE_KEYS.includes(key));
  assert.deepEqual(others.filter((key) => body.includes(key)), [], "no other setting is named");
  assert.equal(body.includes("deploy.host"), false, "and no custom variable");
  assert.deepEqual(body.match(/^### .+$/gmu), ["### models.tiers", "### design.authority"]);
  assert.equal(renderCustomVariablesSection(state).body.includes("design.authority"), false);
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
  await setWorkspaceSetting(fx.library, { key: "models.tiers", value: JSON.stringify({ codex: { economy: { runner: "codex-cli", model: "/opt/models/local", effort: "low" } } }), occurredAt: at() });
  const result = await write(fx);
  assert.deepEqual(result.withheld, [
    { name: "models.tiers.codex.economy", reason: "absolute-path" },
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
  assert.match(bodies[VARIABLES_SYSTEM_SECTION_ID], /^\| codex \| economy \| codex-cli \| \(withheld\) \| \(withheld\) \|$/mu);
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
