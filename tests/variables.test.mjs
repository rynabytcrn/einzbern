// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-484 R1, R2, AC1-AC3 (MIN-227 D12; TCRN-CROSS-SUB-340): custom variables and the
// retired variable snapshots of AGENTS.md. A variable is a configuration record of its own collection,
// not a setting, so settings-catalog never lists one; a value or description shaped like a
// credential is refused when written. Device models/quota stay in runtime lookup guidance;
// historical model records remain readable diagnostics. The custom section renders only
// explicitly exported variables, while legacy records retain their historical export contract;
// both are managed sections, and neither ever renders an absolute path.

import "./helpers/device-home.mjs";
import { seedLegacyVariableSections } from "./helpers/legacy-variable-sections.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { SETTINGS_LAYER_KIND, WORKSPACE_SETTING_VERSION, validateWorkspaceSettingRecord, readModelsTiers, readModelsCategory, readModelsEscalation, SETTINGS_CATALOG, createProject, declareChainIdentity, scopedWorkspaceState, initializeLibrary, materializeWorkspace, registerLibrary, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import { configRecord, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { absolutePathLine, managedSectionRecordsFor, parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import {
  COORDINATION_SYSTEM_VARIABLE_KEYS,
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

test("principles-only: a new variable remains queryable without creating a resident snapshot", async (context) => {
  const fx = await project(context);
  await writeFile(fx.agents, OWNER_TEXT);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", description: "Where a release deploys", occurredAt: at() });
  const before = await materializeWorkspace(fx.library);
  const result = await write(fx);
  assert.equal(result.written, false);
  assert.deepEqual(result.sections, []);
  assert.deepEqual(result.withheld, []);
  assert.equal(await readFile(fx.agents, "utf8"), OWNER_TEXT);
  const catalog = await cli(["settings-catalog", "--workspace", fx.library]);
  assert.equal(catalog.settings.some(entry => entry.key === "deploy.host"), false);
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(listVariables(state), [{ name: "deploy.host", type: "string", value: "build.example.com", description: "Where a release deploys", exports: ["agents"] }]);
  assert.deepEqual(managedSectionRecordsFor(state, "AGENTS.md"), []);
  assert.equal(state.version, before.version);
  assert.equal((await write(fx)).written, false);
});

test("principles-only CLI writes preserve edited legacy snapshots and explicit unmanage settles them", async (context) => {
  const fx = await project(context);
  await writeFile(fx.agents, OWNER_TEXT);
  const projectId = (await createProject(fx.library, { externalKey: "VARIABLE-CLI-TARGET", name: "CLI target", occurredAt: at() })).projects[0].id;
  await registerLibrary({ projectPath: fx.root, libraryPath: fx.library, projectId, registeredAt: at() });
  const targetCli = argv => cli(argv.includes("--workspace") ? [...argv, "--project-id", projectId] : argv);
  const first = await asAtelier(() => targetCli(["variable-set", "--exports", "agents", "--workspace", fx.library, "--at", at(), "--name", "deploy.host", "--type", "string", "--value", "build.example.com"]));
  assert.equal(first.variable.value, "build.example.com");
  assert.equal(await readFile(fx.agents, "utf8"), OWNER_TEXT);
  await asAtelier(() => targetCli(["variable-set", "--exports", "agents", "--workspace", fx.library, "--at", at(), "--name", "deploy.path", "--type", "string", "--value", "/srv/build"]));
  const listed = await targetCli(["variable-list", "--workspace", fx.library]);
  assert.equal(listed.variables.find(variable => variable.name === "deploy.path").value, "/srv/build");
  assert.deepEqual(listed.pendingSections, [], "a value with no resident export is not an edited section");
  await seedLegacyVariableSections({ libraryRoot: fx.library, projectRoot: fx.root, projectId, occurredAt: at(), ids: [VARIABLES_CUSTOM_SECTION_ID] });
  const edited = (await readFile(fx.agents, "utf8")).replace("build.example.com", "hand.example.com");
  await writeFile(fx.agents, edited);
  await asAtelier(() => targetCli(["variable-set", "--exports", "agents", "--workspace", fx.library, "--at", at(), "--name", "deploy.port", "--type", "number", "--value", "8443"]));
  assert.equal(await readFile(fx.agents, "utf8"), edited);
  assert.deepEqual((await targetCli(["variable-list", "--workspace", fx.library])).pendingSections, [VARIABLES_CUSTOM_SECTION_ID]);
  const resolved = await targetCli(["rule-resolve", "--project", fx.root, "--section", VARIABLES_CUSTOM_SECTION_ID, "--action", "unmanage", "--at", at()]);
  assert.deepEqual([resolved.reasonCode, resolved.action, resolved.state], ["MANAGED_SECTION_RESOLVED", "unmanage", "unmanaged"]);
  const settled = await targetCli(["variable-list", "--workspace", fx.library]);
  assert.deepEqual(settled.pendingSections, []);
  assert.deepEqual(settled.variables.map(variable => variable.name), ["deploy.host", "deploy.path", "deploy.port"]);
  const preserved = await readFile(fx.agents, "utf8");
  assert.match(preserved, /hand\.example\.com/u);
  assert.doesNotMatch(preserved, /einzbern:section/u);
  await asAtelier(() => targetCli(["variable-remove", "--workspace", fx.library, "--at", at(), "--name", "deploy.host"]));
  assert.equal(await readFile(fx.agents, "utf8"), preserved);
  assert.equal((await targetCli(["variable-list", "--workspace", fx.library])).variables.some(variable => variable.name === "deploy.host"), false);
});

test("484-AC2: a value shaped like a credential is refused, and nothing is recorded", async (context) => {
  const fx = await project(context);
  const before = (await materializeWorkspace(fx.library)).version;
  const error = await refusal(() => setVariable(fx.library, { exports: ["agents"], name: "api.key", type: "string", value: "sk-proj-0123456789abcdef", occurredAt: at() }));
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

// Historical values are validated read fixtures, not new writes through the retired authority.
async function legacyState(fx, entries) {
  const state = await materializeWorkspace(fx.library);
  return { ...state, settings: [...state.settings, ...entries.map(([key, value]) => validateWorkspaceSettingRecord({
    key, value, schemaVersion: WORKSPACE_SETTING_VERSION, layerKind: SETTINGS_LAYER_KIND,
    revision: 1, tombstone: false, updatedAt: at(),
  }))] };
}

test("552: historical runner tiers remain readable in order but are never frozen into shared AGENTS", async (context) => {
  const fx = await project(context);
  const tiers = [tierRecord(30, "main", "codex", "fixture-codex-main", "high"), tierRecord(10, "flagship", "claude-code", "fixture-flagship", "max"), tierRecord(40, "economy", "codex-cli", "fixture-codex", "max"), tierRecord(20, "main", "claude-code", "fixture-main", "max")];
  const state = await legacyState(fx, [["models.tiers", JSON.stringify(tiers)]]);
  assert.deepEqual(readModelsTiers(state.settings).map(row => [row.order, row.runner]), [[10, "claude-code"], [20, "claude-code"], [30, "codex"], [40, "codex-cli"]]);
  const body = renderSystemVariablesSection(state).body;
  assert.match(body, /execution-policy-resolve --host/u);
  for (const tier of tiers) assert.equal(body.includes(tier.model), false);
  assert.doesNotMatch(body, /### models\./u);
  assert.equal((await refusal(() => setWorkspaceSetting(fx.library, { key: "models.tiers", value: JSON.stringify(tiers), occurredAt: at() }))).reasonCode, "SETTINGS_KEY_DEVICE_LEVEL");
});

const SYSTEM_HEADINGS = ["### Engine execution policy", "### design.authority"];

test("552: the system section holds runtime lookup guidance and design bindings, not device values or unrelated settings", async (context) => {
  const fx = await project(context);
  assert.deepEqual(SYSTEM_VARIABLE_KEYS, ["design.authority", "design.repository", "design.pullRequestTarget", "design.productionDocs", "design.buildService", "design.buildProject", "design.consumedVersion"]);
  const unset = renderSystemVariablesSection(await materializeWorkspace(fx.library));
  assert.deepEqual(unset.body.match(/^### .+$/gmu), SYSTEM_HEADINGS);
  assert.match(unset.body, /execution-policy-resolve --host/u);
  assert.doesNotMatch(unset.body, /\| models\.|\| quota\./u);
  assert.match(unset.body, /Design bindings: unconfigured\. Production publication: unverified\./u);
  assert.match(unset.body, /^\| design\.authority \| \(unconfigured\) \| default \| false \|$/mu);
  await setWorkspaceSetting(fx.library, { key: "design.authority", value: "https://design.example/system", occurredAt: at() });
  await setWorkspaceSetting(fx.library, { key: "retrieval.tau", value: "3", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  const body = renderSystemVariablesSection(state).body;
  assert.match(body, /^\| design\.authority \| https:\/\/design\.example\/system \| library \| false \|$/mu);
  const others = SETTINGS_CATALOG.map((entry) => entry.key).filter((key) => !SYSTEM_VARIABLE_KEYS.includes(key));
  assert.deepEqual(others.filter((key) => body.includes(key)), [], "no other setting is named");
  assert.deepEqual(SYSTEM_VARIABLE_KEYS.filter((key) => !body.includes(key)), [], "every system setting is");
  assert.equal(body.includes("deploy.host"), false, "and no custom variable");
  assert.deepEqual(body.match(/^### .+$/gmu), SYSTEM_HEADINGS);
  assert.equal(renderCustomVariablesSection(state).body.includes("design.authority"), false);
});

test("552: legacy model tables and escalation remain diagnostic inputs while design bindings render without local paths", async (context) => {
  const fx = await project(context);
  await setWorkspaceSetting(fx.library, { key: "design.authority", value: "https://design.example/system", occurredAt: at() });
  const categories = [{ id: "economy", name: "Economy", description: "routine work", order: 30 }, { id: "flagship", name: "Flagship", description: "", order: 10 }, { id: "main", name: "Main", description: "implementation | review", order: 20 }];
  const tiers = [tierRecord(40, "economy", "claude-code", "fixture-main", "low", "cheap first"), tierRecord(10, "flagship", "claude-code", "fixture-flagship", "max"), tierRecord(30, "main", "claude-code", "fixture-main", "max")];
  const state = await legacyState(fx, [["models.category", JSON.stringify(categories)], ["models.tiers", JSON.stringify(tiers)], ["models.escalation.enabled", "false"], ["models.escalation.threshold", "2"], ["models.escalation.ceiling", "flagship"]]);
  assert.deepEqual(readModelsCategory(state.settings).map(row => row.id), ["flagship", "main", "economy"]);
  assert.deepEqual(readModelsTiers(state.settings).map(row => row.order), [10, 30, 40]);
  assert.deepEqual(readModelsEscalation(state.settings), { enabled: false, threshold: 2, ceiling: "flagship" });
  const body = renderSystemVariablesSection(state).body;
  assert.deepEqual(body.match(/^### .+$/gmu), SYSTEM_HEADINGS);
  assert.doesNotMatch(body, /fixture-main|fixture-flagship|cheap first|implementation/u);
  assert.match(body, /https:\/\/design.example\/system/u);
  assert.equal(absolutePathLine(body), null);
  await write(fx);
  assert.equal(await bytesOrNull(fx.agents), null, "diagnostic formatting does not create an AGENTS file");
});

test("552: historical category paths and credential-shaped names remain readable but cannot leak into shared output", async (context) => {
  const fx = await project(context);
  const categories = [{ id: "flagship", name: "Flagship", description: "see /opt/models/flagship", order: 10 }, { id: "main", name: "sk-proj-0123456789abcdef", description: "", order: 20 }, { id: "economy", name: "Economy", description: "routine work", order: 30 }];
  const state = await legacyState(fx, [["models.category", JSON.stringify(categories)]]);
  assert.equal(readModelsCategory(state.settings)[1].name, "sk-proj-0123456789abcdef");
  const rendered = renderSystemVariablesSection(state);
  assert.deepEqual(rendered.withheld, []);
  assert.match(rendered.body, /execution-policy-resolve/u);
  for (const shown of ["/opt/models", "sk-proj", "routine work"]) assert.equal(rendered.body.includes(shown), false);
});

test("principles-only: changed design settings remain native and an edited legacy snapshot stays pending", async (context) => {
  const fx = await project(context);
  await setWorkspaceSetting(fx.library, { key: "design.buildProject", value: "build-three", occurredAt: at() });
  assert.equal((await write(fx)).written, false);
  assert.equal(await bytesOrNull(fx.agents), null);
  await seedLegacyVariableSections({ libraryRoot: fx.library, projectRoot: fx.root, occurredAt: at(), ids: [VARIABLES_SYSTEM_SECTION_ID] });
  const edited = (await readFile(fx.agents, "utf8")).replace("build-three", "hand-nine");
  await writeFile(fx.agents, edited);
  await setWorkspaceSetting(fx.library, { key: "design.buildProject", value: "build-next", occurredAt: at() });
  const kept = await write(fx);
  assert.deepEqual(kept.pendingSections, [VARIABLES_SYSTEM_SECTION_ID]);
  assert.equal(await readFile(fx.agents, "utf8"), edited);
  const state = await materializeWorkspace(fx.library);
  assert.equal(configRecord(state, "managed-section", `AGENTS.md#${VARIABLES_SYSTEM_SECTION_ID}`).value.state, "pending");
  assert.match(renderSystemVariablesSection(state).body, /build-next/u);
});

test("484-R1: variable names, types and values follow their rules, and a system setting's key is not a variable name", async (context) => {
  const fx = await project(context);
  const set = (input) => setVariable(fx.library, { exports: ["agents"], occurredAt: at(), ...input });
  for (const name of ["Deploy.host", "1host", "deploy host", "", "models.tiers", "retrieval.tau"]) {
    assert.equal((await refusal(() => set({ name, type: "string", value: "x" }))).reasonCode, "VARIABLE_NAME_INVALID", name);
  }
  assert.equal((await refusal(() => set({ name: "models.tiers", type: "string", value: "x" }))).details.reason, "system-setting");
  assert.equal((await refusal(() => set({ name: "deploy.list", type: "list", value: "x" }))).reasonCode, "VARIABLE_TYPE_INVALID");
  for (const [type, value] of [["number", "1e3"], ["number", "abc"], ["number", "01"], ["boolean", "yes"], ["string", "two\nlines"]]) {
    assert.equal((await refusal(() => set({ name: "deploy.value", type, value }))).reasonCode, "VARIABLE_VALUE_INVALID", `${type} ${value.slice(0, 12)}`);
  }
  assert.equal((await refusal(() => set({ name: "deploy.value", type: "string", value: "x", description: "a\tb" }))).reasonCode, "VARIABLE_DESCRIPTION_INVALID");
  await set({ name: "deploy.replicas", type: "number", value: "-3.5" });
  await set({ name: "deploy.enabled", type: "boolean", value: "true" });
  await set({ name: "deploy.sshHost", type: "string", value: "", description: "" });
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)).map((variable) => [variable.name, variable.type, variable.value]),
    [["deploy.enabled", "boolean", "true"], ["deploy.replicas", "number", "-3.5"], ["deploy.sshHost", "string", ""]]);
  await set({ name: "a".repeat(65), type: "string", value: "x".repeat(1025) });
  assert.equal(listVariables(await materializeWorkspace(fx.library)).find(variable => variable.name === "a".repeat(65)).value.length, 1025);
});

test("484-R1: variables change and remove through native records without creating AGENTS", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await write(fx);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "release.example.com", description: "Where a release deploys", occurredAt: at() });
  assert.equal((await write(fx)).written, false);
  assert.equal(listVariables(await materializeWorkspace(fx.library))[0].value, "release.example.com");
  await removeVariable(fx.library, { name: "deploy.host", occurredAt: at() });
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)), []);
  assert.equal((await refusal(() => removeVariable(fx.library, { name: "deploy.host", occurredAt: at() }))).reasonCode, "CONFIG_RECORD_NOT_FOUND");
  assert.equal((await write(fx)).written, false);
  assert.equal(await bytesOrNull(fx.agents), null);
});

test("484-R2: a variable whose row would name an absolute path is withheld with its reason; historical formatting filters paths while native values stay queryable", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { exports: ["agents"], name: "build.root", type: "string", value: "/srv/build/output", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "build.share", type: "string", value: "C:\\builds", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "build.note", type: "string", value: "fast", description: "cache in /var/cache/build", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const historical = await legacyState(fx, [["models.tiers", JSON.stringify([tierRecord(10, "economy", "codex-cli", "/opt/models/local", "low")])]]);
  assert.equal(renderSystemVariablesSection(historical).body.includes("/opt/models/local"), false);
  const result = renderCustomVariablesSection(await materializeWorkspace(fx.library));
  assert.deepEqual(result.withheld, [
    { name: "build.note", reason: "absolute-path" },
    { name: "build.root", reason: "absolute-path" },
    { name: "build.share", reason: "absolute-path" },
  ]);
  const written = await write(fx);
  assert.deepEqual([written.written, written.pendingSections, written.withheld], [false, [], []]);
  assert.equal(await bytesOrNull(fx.agents), null);
  assert.equal(listVariables(await materializeWorkspace(fx.library)).find(variable => variable.name === "build.root").value, "/srv/build/output");

});

test("484-R2: a section the user edited is left as it is and goes pending in the library", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await seedLegacyVariableSections({ libraryRoot: fx.library, projectRoot: fx.root, occurredAt: at(), ids: [VARIABLES_CUSTOM_SECTION_ID] });
  const text = await readFile(fx.agents, "utf8");
  const edited = text.replace("| deploy.host | string | build.example.com |", "| deploy.host | string | hand.example.com |");
  assert.notEqual(edited, text);
  await writeFile(fx.agents, edited);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
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
  assert.deepEqual(renderCustomVariablesSection(state).withheld, [{ name: "legacy.token", reason: "secret-shaped" }]);
  assert.equal((await write(fx)).written, false);
  assert.equal(await bytesOrNull(fx.agents), null);
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): a variable may hold an order, and the
// custom section renders the variables with one first, by order, then the others by name.
const customRows = async (fx) => renderCustomVariablesSection(await materializeWorkspace(fx.library)).body.split("\n").filter((line) => /^\| [a-z]/u.test(line)).map((line) => line.split(" | ")[0].slice(2));

test("508-R7: variable ordering metadata and historical formatting remain stable without resident export", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { exports: ["agents"], name: "alpha", type: "string", value: "a", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "bravo", type: "string", value: "b", order: 2, occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "charlie", type: "string", value: "c", order: 1, occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "delta", type: "string", value: "d", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "echo", type: "string", value: "e", order: 2, occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  // The records hold the order only when one was given; variable-list stays by name.
  assert.deepEqual(configRecord(state, "variable", "charlie").value, { type: "string", value: "c", description: "", exports: ["agents"], order: 1 });
  assert.deepEqual(configRecord(state, "variable", "alpha").value, { type: "string", value: "a", description: "", exports: ["agents"] });
  assert.deepEqual(listVariables(state).map((variable) => [variable.name, variable.order]), [["alpha", undefined], ["bravo", 2], ["charlie", 1], ["delta", undefined], ["echo", 2]]);
  assert.deepEqual(variablesInRenderOrder(state).map((variable) => variable.name), ["charlie", "bravo", "echo", "alpha", "delta"], "one order keeps name order among its variables");

  await write(fx);
  assert.deepEqual(await customRows(fx), ["charlie", "bravo", "echo", "alpha", "delta"]);
  const body = renderCustomVariablesSection(await materializeWorkspace(fx.library)).body;
  assert.match(body, /^\| Name \| Type \| Value \| Description \|$/mu, "the order is not a column");

  // variable-set writes the whole record: set again without an order, the variable has none.
  await setVariable(fx.library, { exports: ["agents"], name: "charlie", type: "string", value: "c", occurredAt: at() });
  assert.equal(Object.hasOwn(configRecord(await materializeWorkspace(fx.library), "variable", "charlie").value, "order"), false);
  const moved = await write(fx);
  assert.equal(moved.written, false);
  assert.equal(await bytesOrNull(fx.agents), null);
  assert.deepEqual(await customRows(fx), ["bravo", "echo", "alpha", "charlie", "delta"]);

  assert.equal(compareRecordOrder({ order: 1 }, {}), -1);
  assert.equal(compareRecordOrder({}, { order: 1 }), 1);
  assert.equal(compareRecordOrder({}, {}), 0);
  assert.equal(compareRecordOrder({ order: 3 }, { order: 3 }), 0);
});

test("508-R7: GIVEN no variable holds an order THEN the custom section renders by name as before", async (context) => {
  const fx = await project(context);
  for (const name of ["zulu", "alpha", "mike"]) await setVariable(fx.library, { exports: ["agents"], name, type: "string", value: name, occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(variablesInRenderOrder(state), listVariables(state));
  await write(fx);
  assert.deepEqual(await customRows(fx), ["alpha", "mike", "zulu"]);
});

test("508-R7: a reorder is a change of the custom section, so a section the user edited is not overwritten by it", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { exports: ["agents"], name: "alpha", type: "string", value: "a", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "bravo", type: "string", value: "b", occurredAt: at() });
  await seedLegacyVariableSections({ libraryRoot: fx.library, projectRoot: fx.root, occurredAt: at(), ids: [VARIABLES_CUSTOM_SECTION_ID] });
  const edited = (await readFile(fx.agents, "utf8")).replace("| alpha | string | a |", "| alpha | string | hand |");
  await writeFile(fx.agents, edited);
  await setVariable(fx.library, { exports: ["agents"], name: "bravo", type: "string", value: "b", order: 1, occurredAt: at() });
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
  const input = await refusal(() => setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "x", order: 0, occurredAt: at() }));
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

test("489: failed legacy retirement restores AGENTS bytes and records; a retry removes only snapshots", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const emptyHead = await libraryHead(fx);
  assert.equal((await write(fx, OVER_BUDGET)).written, false, "no snapshot means no write or commit to refuse");
  assert.equal(await bytesOrNull(fx.agents), null);
  assert.deepEqual(await libraryHead(fx), emptyHead);
  await writeFile(fx.agents, OWNER_TEXT);
  await seedLegacyVariableSections({ libraryRoot: fx.library, projectRoot: fx.root, occurredAt: at() });
  const original = await readFile(fx.agents);
  const state = await materializeWorkspace(fx.library);
  const records = managedSectionRecordsFor(state, "AGENTS.md");
  const head = await libraryHead(fx);
  const refused = await refusal(() => write(fx, OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(fx.agents), original);
  assert.deepEqual(await libraryHead(fx), head);
  assert.deepEqual(managedSectionRecordsFor(await materializeWorkspace(fx.library), "AGENTS.md"), records);
  assert.equal(await backedUp(fx, original), true);
  const retired = await write(fx);
  assert.deepEqual([retired.written, retired.pendingSections], [true, []]);
  assert.ok(retired.sections.every(decision => decision.result === "removed"));
  assert.deepEqual(await sections(fx), {});
  assert.equal((await readFile(fx.agents, "utf8")).trim(), OWNER_TEXT.trim());
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)), listVariables(state));
});

test("489: a variable-section write whose records went in before the failure (a crash after the event commit) keeps AGENTS.md as written", async (context) => {
  const fx = await project(context);
  await writeFile(fx.agents, OWNER_TEXT);
  await setVariable(fx.library, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await seedLegacyVariableSections({ libraryRoot: fx.library, projectRoot: fx.root, occurredAt: at() });
  const head = await libraryHead(fx);
  const error = await refusal(() => write(fx, AFTER_COMMIT));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(fx), head, "the records went in");
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(managedSectionRecordsFor(state, "AGENTS.md").map((record) => [record.id, record.state]), [[VARIABLES_CUSTOM_SECTION_ID, "removed"], [VARIABLES_SYSTEM_SECTION_ID, "removed"]]);
  assert.equal((await readFile(fx.agents, "utf8")).startsWith(OWNER_TEXT), true);
  assert.deepEqual(await sections(fx), {}, "committed retirement stays in the file");
  const again = await write(fx);
  assert.deepEqual([again.written, again.pendingSections], [false, []], "the file and the records agree");
  assert.equal((await materializeWorkspace(fx.library)).version, state.version, "and nothing more is recorded");
});

// ---- TCRN-CROSS-STORY-540 GWT2, Q4, Q5 (MIN-243 D1; TCRN-CROSS-SUB-506) ----

const COORDINATION_LIMITS = ["execution.maxConcurrentSubagents"];
const DESIGN_KEYS = ["design.authority", "design.repository", "design.pullRequestTarget", "design.productionDocs", "design.buildService", "design.buildProject", "design.consumedVersion"];

// The project fixture's library as a coordination library, registered on this device for the project
// root, the container it coordinates.
async function coordination(context) {
  const fx = await project(context);
  const state = await materializeWorkspace(fx.library);
  await declareChainIdentity(fx.library, { role: "coordination", coordinationLibraryId: state.metadata.workspaceId }, { occurredAt: at() });
  await registerLibrary({ projectPath: fx.root, libraryPath: fx.library, registeredAt: at(), gitRemote: null });
  return fx;
}

const scoped = async (fx) => scopedWorkspaceState(await materializeWorkspace(fx.library));

test("540-GWT2: a coordination library's system section lists its limits and the design bindings, never models.*", async (context) => {
  assert.deepEqual(COORDINATION_SYSTEM_VARIABLE_KEYS, [...COORDINATION_LIMITS, ...DESIGN_KEYS]);
  const fx = await coordination(context);
  const { body } = renderSystemVariablesSection(await scoped(fx));
  assert.doesNotMatch(body, /models\./u, "a coordination library has no models.*");
  assert.doesNotMatch(body, /execution\.dispatchTiers/u);
  for (const key of COORDINATION_SYSTEM_VARIABLE_KEYS) assert.match(body, new RegExp(`^\\| ${key.replace(/\./gu, "\\.")} \\|`, "mu"), key);
  assert.ok(body.includes("Written by Einzbern from the coordination library's configuration."));
  // Each limit at its effective value: the engine's default while the library declares none.
  for (const [key, value] of [["execution.maxConcurrentSubagents", "8"]]) {
    assert.ok(body.includes(`| ${key} | ${value} |`), `${key} reads ${value}`);
  }
  assert.ok(body.includes("| design.authority | (unconfigured) | default | false |"));
});

test("principles-only coordination: settings and variable changes stay queryable without resident copies", async (context) => {
  const fx = await coordination(context);
  await writeFile(fx.agents, OWNER_TEXT);
  for (const value of ["3", "2"]) {
    await setWorkspaceSetting(fx.library, { key: "execution.maxConcurrentSubagents", value, occurredAt: at() });
    assert.equal((await write(fx)).written, false);
    const catalog = await cli(["settings-catalog", "--workspace", fx.library]);
    assert.equal(catalog.settings.find(setting => setting.key === "execution.maxConcurrentSubagents").currentValue, value);
    assert.equal(await readFile(fx.agents, "utf8"), OWNER_TEXT);
  }
  const receipt = await asAtelier(() => cli(["variable-set", "--exports", "agents", "--workspace", fx.library, "--name", "release-train", "--type", "string", "--value", "weekly", "--at", at()]));
  assert.equal(receipt.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.equal((await cli(["variable-list", "--workspace", fx.library])).variables.find(variable => variable.name === "release-train").value, "weekly");
  assert.equal(await readFile(fx.agents, "utf8"), OWNER_TEXT);
  assert.deepEqual(managedSectionRecordsFor(await scoped(fx), "AGENTS.md"), []);
});

test("540-Q4: the variable sections follow artifact.language: Chinese for zh-CN, English otherwise", async (context) => {
  const fx = await coordination(context);
  await setWorkspaceSetting(fx.library, { key: "artifact.language", value: "zh-CN", occurredAt: at() });
  await setVariable(fx.library, { exports: ["agents"], name: "owner", type: "string", value: "release-owner", occurredAt: at() });
  const state = await scoped(fx);
  const system = renderSystemVariablesSection(state).body;
  assert.ok(system.startsWith("## 系统变量\n\n由 Einzbern 按协调库的配置写入。"));
  assert.ok(system.includes("| 设置 | 取值 |"));
  assert.doesNotMatch(system, /\| quota\./u);
  assert.match(system, /model policy|模型/u);
  assert.ok(system.includes("| design.authority | （未配置） | default | false |"));
  assert.ok(system.includes("| 系统设置 | 生效来源 | 继承 |"));
  const custom = renderCustomVariablesSection(state).body;
  assert.ok(custom.startsWith("## 自定义变量\n\n由 Einzbern 按协调库的配置写入。"));
  assert.ok(custom.includes("| 名称 | 类型 | 取值 | 说明 |"));
  // A project library uses the same language rule and runtime reference, never model copies.
  const other = await project(context);
  await setWorkspaceSetting(other.library, { key: "artifact.language", value: "zh-CN", occurredAt: at() });
  const projectBody = renderSystemVariablesSection(await scoped(other)).body;
  assert.ok(projectBody.startsWith("## 系统变量\n\n由 Einzbern 按项目配置写入。"));
  assert.doesNotMatch(projectBody, /^### models\./mu);
  assert.match(projectBody, /execution-policy-resolve/u);
  await setWorkspaceSetting(other.library, { key: "artifact.language", value: "fr", occurredAt: at() });
  assert.ok(renderSystemVariablesSection(await scoped(other)).body.startsWith("## System variables\n\nWritten by Einzbern from the project's configuration."), "any other language is English");
});


test("configuration contract: new variables export nowhere, legacy absence still exports, and deliberate omissions never create pending edits", async (context) => {
  const fx = await project(context);
  await setVariable(fx.library, { name: "private.note", type: "string", value: "private declaration", occurredAt: at() });
  await setVariable(fx.library, { name: "handoff.note", type: "string", value: "runtime declaration", exports: ["handoff"], occurredAt: at() });
  await setConfigRecord(fx.library, { collection: "variable", key: "legacy.note", value: { type: "string", value: "historical declaration", description: "" }, occurredAt: at() });
  const state = await materializeWorkspace(fx.library);
  assert.deepEqual(configRecord(state, "variable", "private.note").value.exports, []);
  assert.equal(Object.hasOwn(configRecord(state, "variable", "legacy.note").value, "exports"), false);
  const rendered = renderCustomVariablesSection(state);
  assert.match(rendered.body, /historical declaration/u);
  assert.doesNotMatch(rendered.body, /private declaration|runtime declaration/u);
  assert.deepEqual(rendered.withheld, [{ name: "handoff.note", reason: "not-exported" }, { name: "private.note", reason: "not-exported" }]);
  const result = await write(fx);
  assert.deepEqual(result.pendingSections, []);
  assert.equal(configRecord(await materializeWorkspace(fx.library), "managed-section", `AGENTS.md#${VARIABLES_CUSTOM_SECTION_ID}`), null);
  assert.equal(await bytesOrNull(fx.agents), null);
});

test("configuration contract: invalid or duplicate exports are rejected without committing and replacement clears omitted exports", async (context) => {
  const fx = await project(context);
  for (const exports of [["public"], ["agents", "agents"], "agents", null]) {
    const error = await refusal(() => setVariable(fx.library, { name: "deploy.host", type: "string", value: "example.com", exports, occurredAt: at() }));
    assert.equal(error.reasonCode, "VARIABLE_RECORD_INVALID");
  }
  assert.deepEqual(listVariables(await materializeWorkspace(fx.library)), []);
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "example.com", exports: ["agents"], description: "visible", order: 2, occurredAt: at() });
  await setVariable(fx.library, { name: "deploy.host", type: "string", value: "example.com", occurredAt: at() });
  const record = configRecord(await materializeWorkspace(fx.library), "variable", "deploy.host").value;
  assert.deepEqual(record.exports, []);
  assert.equal(record.description, "");
  assert.equal(Object.hasOwn(record, "order"), false);
});
