// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-483 R2, R3, AC1-AC4 (MIN-228 D3, MIN-229 D6; TCRN-CROSS-SUB-336): the Command
// Spell rules a project switches on. Every rule is off until it is enabled. Enabling one records it
// at the version the engine ships and writes its text, in the project's artifact language, into
// AGENTS.md as the managed section rule:<id> (AC1). A section the user changed reads user-modified
// (AC2), a newer version in the catalog reads update-available and leaves the file as it is (AC3),
// and a write refused because of the user's change waits (pending) until rule-resolve settles it;
// after keep the engine never writes that section again (AC4). Disabling a rule the user changed
// needs force. Everything here is temporary: a project, its library and a device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { createProject, initializeLibrary, materializeWorkspace, scopedWorkspaceState } from "../dist/build/packages/core/src/index.js";
import { renderAgentsSections, resolveAgentsSection } from "../dist/build/packages/core/src/agents-sections.js";
import { configRecord, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { managedSectionRecordsFor, parseManagedFile, sectionDigest } from "../dist/build/packages/core/src/managed-sections.js";
import { BUILT_IN_RULES, builtInRule } from "../dist/build/packages/core/src/rules-catalog.js";
import { RULE_STATES, checkRuleRecordValue, disableRule, enableRule, listRules, ruleSectionId } from "../dist/build/packages/core/src/rules.js";
import { setWorkspaceSetting } from "../dist/build/packages/core/src/workspace.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";

const fixtures = resolve(import.meta.dirname, "fixtures", "rules");
const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 10, 0, second)).toISOString().replace(".000Z", "Z");
};

/** A project whose AGENTS.md holds the user's text, its library, and the device's backup directory. */
async function scratch(context, language = "zh-CN") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-rules-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const agents = join(project, "AGENTS.md");
  await writeFile(agents, USER_TEXT);
  const library = join(base, ".ether");
  await initializeLibrary({ root: library, createdAt: at() });
  const created = await createProject(library, { externalKey: "RULES-EXPLICIT-PROJECT", name: "Rules fixture", occurredAt: at() });
  const projectId = created.projects.find((project) => project.externalKey === "RULES-EXPLICIT-PROJECT").id;
  if (language !== null) await setWorkspaceSetting(library, { configurationProjectId: projectId, key: "artifact.language", value: language, occurredAt: at() });
  return { base, project, projectId, library, agents, backups: join(base, "device", "backups") };
}

const enable = (paths, id, extra = {}) => enableRule({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId, id, backupRoot: paths.backups, occurredAt: at(), ...extra });
const disable = (paths, id, extra = {}) => disableRule({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId, id, backupRoot: paths.backups, occurredAt: at(), ...extra });
const list = (paths, extra = {}) => listRules({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId, ...extra });

async function ruleOf(paths, id, extra = {}) {
  return (await list(paths, extra)).find((rule) => rule.id === id);
}

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

async function sectionRecord(paths, id) {
  return managedSectionRecordsFor(scopedWorkspaceState(await materializeWorkspace(paths.library), paths.projectId), "AGENTS.md").find((record) => record.id === ruleSectionId(id)) ?? null;
}

async function ruleRecord(paths, id) {
  return configRecord(scopedWorkspaceState(await materializeWorkspace(paths.library), paths.projectId), "rule", id)?.value ?? null;
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

async function cli(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** The built-in catalog with batch processing at its first version, as the engine shipped it before MIN-229 D6. */
async function catalogWithBatchV1() {
  const text = await readFile(join(fixtures, "batch-v1.zh.md"), "utf8");
  return BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, version: 1, body: { zh: text, en: text } });
}

test("483-R2: every rule is off until it is enabled, and listing the rules writes nothing", async (context) => {
  const paths = await scratch(context);
  assert.deepEqual([...RULE_STATES], ["disabled", "enabled", "user-modified", "removed-from-file", "update-available", "pending"]);
  const rules = await list(paths);
  assert.deepEqual(rules, BUILT_IN_RULES.map((rule) => ({
    id: rule.id,
    version: rule.version,
    recordedVersion: null,
    fileVersion: null,
    section: `rule:${rule.id}`,
    state: "disabled",
  })));
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT);
  assert.deepEqual((await materializeWorkspace(paths.library)).configRecords, [], "the library holds no record of any rule");
});

test("483-AC1: enabling batch processing writes its v3 text into AGENTS.md as a managed section, and the rule reads enabled", async (context) => {
  const paths = await scratch(context);
  const v3 = await readFile(join(fixtures, "batch.zh.md"), "utf8");
  assert.equal(v3.split("\n")[0], "## 批量处理原则 v3");

  const change = await enable(paths, "batch");
  assert.deepEqual([change.action, change.section, change.file, change.result, change.written, change.recorded], ["enable", "rule:batch", "AGENTS.md", "create", true, 2]);
  assert.equal(await readFile(change.backupPath, "utf8"), USER_TEXT, "the original is backed up before it is replaced");
  const text = await readFile(paths.agents, "utf8");
  assert.equal(text.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
  const section = sectionOf(text, "rule:batch");
  assert.deepEqual([section.body, section.rev, section.digest], [v3, 1, sectionDigest(v3)], "the section holds the v3 text");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
  assert.deepEqual(await sectionRecord(paths, "batch"), { file: "AGENTS.md", id: "rule:batch", rev: 1, digest: sectionDigest(v3), state: "managed" });

  const rules = await list(paths);
  const batch = rules.find((rule) => rule.id === "batch");
  assert.deepEqual(batch, { id: "batch", version: 3, recordedVersion: 3, fileVersion: 1, section: "rule:batch", state: "enabled" });
  assert.deepEqual(change.status, batch, "the change reports the state listRules reads");
  assert.deepEqual(rules.filter((rule) => rule.id !== "batch").map((rule) => rule.state), BUILT_IN_RULES.filter((rule) => rule.id !== "batch").map(() => "disabled"));

  const again = await enable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.backupPath, again.status.state], ["unchanged", false, 0, null, "enabled"]);
  assert.equal(await readFile(paths.agents, "utf8"), text);
});

test("483-R2: each rule's text follows artifact.language, Chinese for zh-CN and English otherwise", async (context) => {
  for (const language of ["zh-CN", "en", null]) {
    const paths = await scratch(context, language);
    for (const rule of BUILT_IN_RULES) assert.equal((await enable(paths, rule.id)).status.state, "enabled", `${rule.id} ${language}`);
    const text = await readFile(paths.agents, "utf8");
    for (const rule of BUILT_IN_RULES) {
      assert.equal(sectionOf(text, `rule:${rule.id}`).body, language === "zh-CN" ? rule.body.zh : rule.body.en, `${rule.id} ${language}`);
    }
    assert.deepEqual(parseManagedFile(text).outside[0], `${USER_TEXT}\n`);
  }
});

test("483-AC2: a section changed by one character reads user-modified; an editor's line endings and trailing blanks do not", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  const written = await readFile(paths.agents, "utf8");

  // An editor that saves with CRLF line endings and leaves blanks at the ends of lines changes nothing.
  const resaved = written.replace(/\n/gu, "\r\n").replace("## 批量处理原则 v3\r\n", "## 批量处理原则 v3 \t \r\n");
  assert.notEqual(resaved, written.replace(/\n/gu, "\r\n"));
  await writeFile(paths.agents, resaved);
  assert.equal((await ruleOf(paths, "batch")).state, "enabled");

  const edited = resaved.replace("批的单位", "批的单元");
  assert.equal(edited.length, resaved.length);
  await writeFile(paths.agents, edited);
  const batch = await ruleOf(paths, "batch");
  assert.deepEqual([batch.state, batch.fileVersion, batch.recordedVersion], ["user-modified", 1, 3]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "reading the state writes nothing");
  assert.deepEqual((await sectionRecord(paths, "batch")).state, "managed", "nor does it record anything");
});

test("483-AC3: a newer version of a rule reads update-available and leaves the file byte for byte until the rule is enabled again", async (context) => {
  const paths = await scratch(context);
  const catalog = await catalogWithBatchV1();
  const v1 = await readFile(join(fixtures, "batch-v1.zh.md"), "utf8");
  const v3 = await readFile(join(fixtures, "batch.zh.md"), "utf8");

  // Enabled while the engine shipped batch processing v1.
  const first = await enable(paths, "batch", { catalog });
  assert.deepEqual([first.result, first.status.state, first.status.version], ["create", "enabled", 1]);
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "rule:batch").body, v1);
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 1 });

  // The engine now ships v3: the rule reads update-available, and nothing is written.
  const before = await readFile(paths.agents);
  const batch = await ruleOf(paths, "batch");
  assert.deepEqual(batch, { id: "batch", version: 3, recordedVersion: 1, fileVersion: 1, section: "rule:batch", state: "update-available" });
  assert.deepEqual(await readFile(paths.agents), before, "the file is byte for byte what it was");
  assert.equal((await ruleOf(paths, "batch", { catalog })).state, "enabled", "the engine that wrote it reads it enabled");

  // Enabling another rule writes AGENTS.md, and leaves the batch section as it is.
  const other = await enable(paths, "autonomy");
  assert.equal(other.written, true);
  const withAutonomy = await readFile(paths.agents, "utf8");
  assert.equal(sectionOf(withAutonomy, "rule:batch").raw, sectionOf(before.toString("utf8"), "rule:batch").raw);
  assert.equal((await ruleOf(paths, "batch")).state, "update-available");

  // Enabling batch again takes the new version.
  const updated = await enable(paths, "batch");
  assert.deepEqual([updated.result, updated.written, updated.recorded], ["replace", true, 2]);
  assert.deepEqual(updated.status, { id: "batch", version: 3, recordedVersion: 3, fileVersion: 2, section: "rule:batch", state: "enabled" });
  const after = await readFile(paths.agents, "utf8");
  assert.deepEqual([sectionOf(after, "rule:batch").body, sectionOf(after, "rule:batch").rev], [v3, 2]);
  assert.equal(sectionOf(after, "rule:autonomy").raw, sectionOf(withAutonomy, "rule:autonomy").raw);
  assert.equal(await readFile(updated.backupPath, "utf8"), withAutonomy);

  // An engine that ships an older version than the library records refuses to write its text.
  const older = await refusal(() => enable(paths, "batch", { catalog }));
  assert.deepEqual([older.reasonCode, older.details.id, older.details.recordedVersion, older.details.version], ["RULE_VERSION_NEWER", "batch", "3", "1"]);
  assert.equal(await readFile(paths.agents, "utf8"), after);
});

test("INIT-053 AC2: v2 to v3 of a rule reads update-available and leaves the file byte for byte until the rule is enabled again", async (context) => {
  const paths = await scratch(context);
  // Existing render owns its non-rule system sections before the v2 baseline is captured.
  await renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, backupRoot: paths.backups, occurredAt: at() });
  const v2 = await readFile(join(fixtures, "batch-v2.zh.md"), "utf8");
  const catalog = BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, version: 2, body: { zh: v2, en: v2 } });
  const v3 = await readFile(join(fixtures, "batch.zh.md"), "utf8");

  // Enabled while the engine shipped batch processing v2.
  const first = await enable(paths, "batch", { catalog });
  assert.deepEqual([first.result, first.status.state, first.status.version], ["create", "enabled", 2]);
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "rule:batch").body, v2);
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 2 });

  // The engine now ships v3: the rule reads update-available, and nothing is written.
  const before = await readFile(paths.agents);
  const batch = await ruleOf(paths, "batch");
  assert.deepEqual(batch, { id: "batch", version: 3, recordedVersion: 2, fileVersion: 1, section: "rule:batch", state: "update-available" });
  assert.deepEqual(await readFile(paths.agents), before, "the file is byte for byte what it was");
  assert.equal((await ruleOf(paths, "batch", { catalog })).state, "enabled", "the engine that wrote it reads it enabled");

  const rendered = await renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, backupRoot: paths.backups, occurredAt: at() });
  assert.equal(rendered.sections.find((section) => section.id === "rule:batch").result, "unchanged");
  assert.deepEqual(await readFile(paths.agents), before, "ordinary render preserves v2 bytes");

  // Enabling another rule writes AGENTS.md, and leaves the batch section as it is.
  const other = await enable(paths, "autonomy");
  assert.equal(other.written, true);
  const withAutonomy = await readFile(paths.agents, "utf8");
  assert.equal(sectionOf(withAutonomy, "rule:batch").raw, sectionOf(before.toString("utf8"), "rule:batch").raw);
  assert.equal((await ruleOf(paths, "batch")).state, "update-available");

  // Enabling batch again takes the new version.
  const updated = await enable(paths, "batch");
  assert.deepEqual([updated.result, updated.written, updated.recorded], ["replace", true, 2]);
  assert.deepEqual(updated.status, { id: "batch", version: 3, recordedVersion: 3, fileVersion: 2, section: "rule:batch", state: "enabled" });
  const after = await readFile(paths.agents, "utf8");
  assert.deepEqual([sectionOf(after, "rule:batch").body, sectionOf(after, "rule:batch").rev], [v3, 2]);
  assert.equal(sectionOf(after, "rule:autonomy").raw, sectionOf(withAutonomy, "rule:autonomy").raw);
  assert.equal(await readFile(updated.backupPath, "utf8"), withAutonomy);

  // An engine that ships an older version than the library records refuses to write its text.
  const older = await refusal(() => enable(paths, "batch", { catalog }));
  assert.deepEqual([older.reasonCode, older.details.id, older.details.recordedVersion, older.details.version], ["RULE_VERSION_NEWER", "batch", "3", "2"]);
  assert.equal(await readFile(paths.agents, "utf8"), after);
});

test("T15: rule-resolve overwrite records the version of the body it writes", async (context) => {
  const paths = await scratch(context);
  const catalog = await catalogWithBatchV1();
  await enable(paths, "batch", { catalog });
  const changed = (await readFile(paths.agents, "utf8")).replace("批的单位", "批的单元");
  await writeFile(paths.agents, changed);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");
  await registerLibrary({ projectPath: paths.project, projectId: paths.projectId, libraryPath: paths.library, registeredAt: at() });

  const receipt = await cli(["rule-resolve", "--project", paths.project, "--section", "rule:batch", "--action", "overwrite", "--at", at()]);
  assert.deepEqual([receipt.reasonCode, receipt.result, receipt.state], ["MANAGED_SECTION_RESOLVED", "overwritten", "managed"]);
  const section = sectionOf(await readFile(paths.agents, "utf8"), "rule:batch");
  const v3 = await readFile(join(fixtures, "batch.zh.md"), "utf8");
  assert.equal(section.body, v3, "the explicit overwrite writes the current engine text");
  assert.deepEqual(await sectionRecord(paths, "batch"), {
    file: "AGENTS.md", id: "rule:batch", rev: 2, digest: sectionDigest(v3), state: "managed",
  });
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
  assert.deepEqual(await ruleOf(paths, "batch"), {
    id: "batch", version: 3, recordedVersion: 3, fileVersion: 2, section: "rule:batch", state: "enabled",
  });
});

test("T15: rule-resolve overwrite refuses to replace a newer recorded rule with older engine text", async (context) => {
  const paths = await scratch(context);
  const futureCatalog = BUILT_IN_RULES.map((rule) => rule.id === "batch"
    ? { ...rule, version: 4, body: { zh: "## 批量规则 v4\n", en: "## Batch rule v4\n" } }
    : rule);
  await enable(paths, "batch", { catalog: futureCatalog });
  await registerLibrary({ projectPath: paths.project, projectId: paths.projectId, libraryPath: paths.library, registeredAt: at() });
  const before = await readFile(paths.agents, "utf8");

  const error = await refusal(() => runCli(["rule-resolve", "--project", paths.project, "--section", "rule:batch", "--action", "overwrite", "--at", at()], { write() {} }));
  assert.deepEqual([error.reasonCode, error.details.recordedVersion, error.details.version], ["RULE_VERSION_NEWER", "4", "3"]);
  assert.equal(await readFile(paths.agents, "utf8"), before, "the older engine leaves the newer section byte for byte");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 4 });
});

test("483-AC4: a write refused over the user's change waits; after keep the section is the user's and enabling never writes it again", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  const edited = (await readFile(paths.agents, "utf8")).replace("批的单位", "批的单元");
  await writeFile(paths.agents, edited);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");

  const refused = await enable(paths, "batch");
  assert.deepEqual([refused.result, refused.written, refused.backupPath, refused.recorded, refused.status.state], ["refused-user-modified", false, null, 1, "pending"]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "the user's change stays");
  assert.equal((await sectionRecord(paths, "batch")).state, "pending");
  assert.equal((await ruleOf(paths, "batch")).state, "pending");

  const { change } = await resolveAgentsSection(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, id: "rule:batch", action: "keep", backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual([change.result, change.record.state], ["kept", "user-owned"]);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified", "the kept text is the user's");

  const again = await enable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.status.state], ["unchanged", false, 0, "user-modified"]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "enabling the rule never writes the kept section");
  assert.equal((await sectionRecord(paths, "batch")).state, "user-owned");
});

test("483-R2: disabling a rule the user changed needs force; an unchanged one goes with its markers and the rule reads disabled", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "autonomy");
  await enable(paths, "batch");
  const both = await readFile(paths.agents, "utf8");

  const off = await disable(paths, "autonomy");
  assert.deepEqual([off.action, off.result, off.written, off.recorded], ["disable", "disabled", true, 2]);
  assert.deepEqual(off.status, { id: "autonomy", version: 1, recordedVersion: 1, fileVersion: null, section: "rule:autonomy", state: "disabled" });
  assert.deepEqual(await ruleRecord(paths, "autonomy"), { enabled: false, version: 1 });
  assert.equal(await sectionRecord(paths, "autonomy"), null, "the section is no longer recorded");
  const text = await readFile(paths.agents, "utf8");
  assert.equal(sectionOf(text, "rule:autonomy"), null);
  assert.equal(text.startsWith(USER_TEXT), true);
  assert.notEqual(sectionOf(text, "rule:batch"), null, "the other rule's section stays");
  assert.equal(await readFile(off.backupPath, "utf8"), both, "the file is backed up as it was just before");

  const edited = text.replace("批的单位", "批的单元");
  await writeFile(paths.agents, edited);
  const refused = await refusal(() => disable(paths, "batch"));
  assert.deepEqual([refused.reasonCode, refused.details.section, refused.details.state], ["MANAGED_SECTION_FORCE_REQUIRED", "rule:batch", "user-modified"]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "a refused disable writes nothing");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 }, "nor records anything");

  const forced = await disable(paths, "batch", { force: true });
  assert.deepEqual([forced.result, forced.written, forced.status.state], ["disabled", true, "disabled"]);
  assert.equal(await readFile(forced.backupPath, "utf8"), edited, "the user's version is backed up first");
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "rule:batch"), null);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "the file is as it was before any rule was enabled");

  const nothing = await disable(paths, "batch");
  assert.deepEqual([nothing.result, nothing.written, nothing.recorded], ["unchanged", false, 0]);
  const back = await enable(paths, "batch");
  assert.deepEqual([back.result, back.status.state, back.status.fileVersion], ["create", "enabled", 1]);
});

test("483-R3: a rule whose markers the user removed reads removed-from-file, and enabling it does not put them back", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "silent-reporting");
  const text = await readFile(paths.agents, "utf8");
  const removed = text.replace(sectionOf(text, "rule:silent-reporting").raw, "");
  await writeFile(paths.agents, removed);
  assert.deepEqual(await ruleOf(paths, "silent-reporting"), { id: "silent-reporting", version: 1, recordedVersion: 1, fileVersion: null, section: "rule:silent-reporting", state: "removed-from-file" });

  const again = await enable(paths, "silent-reporting");
  assert.deepEqual([again.result, again.written, again.status.state], ["removed", false, "removed-from-file"]);
  assert.equal(await readFile(paths.agents, "utf8"), removed, "the removed section is not put back");
  assert.equal((await sectionRecord(paths, "silent-reporting")).state, "removed");

  // Disabling it only drops the records; enabling it afterwards writes the section anew.
  const off = await disable(paths, "silent-reporting");
  assert.deepEqual([off.result, off.written, off.status.state], ["disabled", false, "disabled"]);
  const on = await enable(paths, "silent-reporting");
  assert.deepEqual([on.result, on.written, on.status.state], ["create", true, "enabled"]);
});

test("483-R2: an unknown rule is refused, a rule record holds exactly enabled and version, and a recorded rule the engine does not ship is listed", async (context) => {
  const paths = await scratch(context);
  const unknown = await refusal(() => enable(paths, "nothing"));
  assert.deepEqual([unknown.reasonCode, unknown.details.id, unknown.details.known], ["RULE_UNKNOWN", "nothing", BUILT_IN_RULES.map((rule) => rule.id).join(",")]);
  assert.equal((await refusal(() => disable(paths, "nothing"))).reasonCode, "RULE_UNKNOWN");
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT);

  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: true, version: 3 }, "batch"));
  for (const [value, key] of [
    [{ enabled: true, version: 3 }, "Batch"],
    [{ enabled: true, version: 3 }, "rule:batch"],
    [{ enabled: true }, "batch"],
    [{ enabled: true, version: 3, state: "enabled" }, "batch"],
    [{ enabled: "yes", version: 3 }, "batch"],
    [{ enabled: true, version: 0 }, "batch"],
    [{ enabled: true, version: 1.5 }, "batch"],
  ]) {
    assert.throws(() => checkRuleRecordValue(value, key), (error) => error?.reasonCode === "RULE_RECORD_INVALID", JSON.stringify([value, key]));
  }
  const invalid = await refusal(() => setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "batch", value: { state: "enabled" }, occurredAt: at() }));
  assert.deepEqual([invalid.reasonCode, invalid.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "RULE_RECORD_INVALID"]);

  // A newer engine elsewhere enabled a rule this one does not ship: it is listed after the built-in
  // rules, and it can be disabled; it cannot be enabled here.
  await setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "future-rule", value: { enabled: true, version: 3 }, occurredAt: at() });
  const rules = await list(paths);
  assert.deepEqual(rules.map((rule) => rule.id), [...BUILT_IN_RULES.map((rule) => rule.id), "future-rule"]);
  assert.deepEqual(rules.at(-1), { id: "future-rule", version: null, recordedVersion: 3, fileVersion: null, section: "rule:future-rule", state: "removed-from-file" });
  assert.equal(builtInRule("future-rule"), null);
  assert.equal((await refusal(() => enable(paths, "future-rule"))).reasonCode, "RULE_UNKNOWN");
  const off = await disable(paths, "future-rule");
  assert.deepEqual([off.result, off.status.state, off.status.recordedVersion], ["disabled", "disabled", 3]);
  assert.deepEqual(await ruleRecord(paths, "future-rule"), { enabled: false, version: 3 });
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): a rule's record may hold an order, which
// places its section among the rule sections of AGENTS.md.
const ruleSections = (text) => parseManagedFile(text).sections.map((section) => section.id).filter((id) => id.startsWith("rule:"));
const render = (paths) => renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, navigation: null, backupRoot: paths.backups, occurredAt: at() });

test("508-R7: GIVEN rules with an order WHEN they are enabled and AGENTS.md is rendered THEN their sections stand in that order; with no order nothing moves", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  await enable(paths, "autonomy");
  const unordered = await readFile(paths.agents, "utf8");
  assert.deepEqual(ruleSections(unordered), ["rule:batch", "rule:autonomy"], "each section goes where it was written");
  // No rule holds an order: a render arranges nothing, as before.
  await render(paths);
  const rendered = await readFile(paths.agents, "utf8");
  assert.deepEqual(ruleSections(rendered), ["rule:batch", "rule:autonomy"]);
  assert.equal(sectionOf(rendered, "rule:batch").raw, sectionOf(unordered, "rule:batch").raw);

  // An order puts the rule first; the rules without one follow in catalog order.
  const first = await enable(paths, "silent-reporting", { order: 1 });
  assert.deepEqual([first.result, first.written, first.recorded, first.status.order], ["create", true, 2, 1]);
  const arranged = await readFile(paths.agents, "utf8");
  assert.deepEqual(ruleSections(arranged), ["rule:silent-reporting", "rule:autonomy", "rule:batch"]);
  assert.equal(arranged.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
  for (const id of ["rule:autonomy", "rule:batch"]) assert.equal(sectionOf(arranged, id).raw, sectionOf(rendered, id).raw, `${id} moved whole`);
  // Nothing around the sections moved: the text between them is what the render left, and the new
  // section's blank line before it.
  assert.deepEqual(parseManagedFile(arranged).outside, [...parseManagedFile(rendered).outside.slice(0, -1), "\n", ""]);
  assert.deepEqual(await ruleRecord(paths, "silent-reporting"), { enabled: true, version: 1, order: 1 });
  assert.equal((await ruleOf(paths, "silent-reporting")).order, 1);
  assert.equal(Object.hasOwn(await ruleOf(paths, "batch"), "order"), false, "a rule without an order lists none");

  // Enabling a rule that is enabled already sets its order and moves its section, nothing else.
  const moved = await enable(paths, "batch", { order: 2 });
  assert.deepEqual([moved.result, moved.written, moved.recorded, moved.status.state, moved.status.order], ["unchanged", true, 1, "enabled", 2]);
  const reordered = await readFile(paths.agents, "utf8");
  assert.deepEqual(ruleSections(reordered), ["rule:silent-reporting", "rule:batch", "rule:autonomy"]);
  assert.equal(await readFile(moved.backupPath, "utf8"), arranged, "the file is backed up before it is rearranged");
  assert.deepEqual([(await render(paths)).files.find((file) => file.file === "AGENTS.md").written, await readFile(paths.agents, "utf8")], [false, reordered], "a render finds it in order");
  // Enabled again without an order, a rule keeps the one it holds.
  const again = await enable(paths, "batch");
  assert.deepEqual([again.written, again.recorded, again.status.order], [false, 0, 2]);

  // Disabling keeps the order, so the rule enabled again takes its old place.
  await disable(paths, "silent-reporting");
  assert.deepEqual(await ruleRecord(paths, "silent-reporting"), { enabled: false, version: 1, order: 1 });
  assert.deepEqual(ruleSections(await readFile(paths.agents, "utf8")), ["rule:batch", "rule:autonomy"]);
  await enable(paths, "silent-reporting");
  assert.deepEqual(await ruleRecord(paths, "silent-reporting"), { enabled: true, version: 1, order: 1 });
  assert.deepEqual(ruleSections(await readFile(paths.agents, "utf8")), ["rule:silent-reporting", "rule:batch", "rule:autonomy"]);
});

test("508-R7: a section the user changed keeps its place and its text while the other rule sections are arranged around it", async (context) => {
  const paths = await scratch(context);
  for (const id of ["autonomy", "batch", "silent-reporting"]) await enable(paths, id);
  const edited = (await readFile(paths.agents, "utf8")).replace("批的单位", "批的单元");
  await writeFile(paths.agents, edited);
  const change = await enable(paths, "silent-reporting", { order: 1 });
  assert.deepEqual([change.result, change.written, change.recorded], ["unchanged", true, 1]);
  const text = await readFile(paths.agents, "utf8");
  assert.deepEqual(ruleSections(text), ["rule:silent-reporting", "rule:batch", "rule:autonomy"], "batch holds its place; the others fill the rest in order");
  assert.equal(sectionOf(text, "rule:batch").raw, sectionOf(edited, "rule:batch").raw, "and its text is the user's");
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");
});

test("508-R7: a rule record's order is checked on every write and replay, and a refused order writes nothing", async (context) => {
  const paths = await scratch(context);
  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: true, version: 3, order: 3 }, "batch"));
  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: false, version: 1, order: 1 }, "autonomy"));
  for (const order of [0, -2, 1.5, "2", null]) {
    assert.throws(() => checkRuleRecordValue({ enabled: true, version: 3, order }, "batch"), (error) => error?.reasonCode === "RULE_RECORD_INVALID" && error.details.field === "order", JSON.stringify(order));
  }
  const replayed = await refusal(() => setConfigRecord(paths.library, { projectId: paths.projectId, collection: "rule", key: "batch", value: { enabled: true, version: 3, order: 0 }, occurredAt: at() }));
  assert.deepEqual([replayed.reasonCode, replayed.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "RULE_RECORD_INVALID"]);
  const version = (await materializeWorkspace(paths.library)).version;
  const refused = await refusal(() => enable(paths, "batch", { order: 0 }));
  assert.deepEqual([refused.reasonCode, refused.details.id, refused.details.field], ["RULE_RECORD_INVALID", "batch", "order"]);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "the file is not written");
  assert.equal((await materializeWorkspace(paths.library)).version, version, "and nothing is recorded");
});

// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366, R18 continuation revision): rule-enable and rule-disable
// write AGENTS.md before they commit the records of what they wrote. When that commit fails, the file
// goes back to what it held byte for byte, a file the enable created is taken away, the backup the
// write made stays, the library holds no new event, and the error that stopped the commit is the one
// thrown. The commit is refused the way tests/agents-sections.test.mjs refuses it: viewBudgetBytes
// narrows the view budget, a refusal that comes after the file was written. A crash after the event
// commit (crashAt) leaves the records in the library, and the file stays as it was written.
const OVER_BUDGET = Object.freeze({ viewBudgetBytes: 1 });
const AFTER_COMMIT = Object.freeze({ crashAt: "after-event-commit" });

async function libraryHead(paths) {
  const { version, headEventHash } = await materializeWorkspace(paths.library);
  return { version, headEventHash };
}

async function ruleRecords(paths, id) {
  return [await ruleRecord(paths, id), await sectionRecord(paths, id), await libraryHead(paths)];
}

async function bytesOrNull(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Whether a file under the device's backups holds `bytes`: the copy a write makes before it replaces a file.
async function backedUp(paths, bytes) {
  const entries = await readdir(paths.backups, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (await readFile(join(entry.parentPath, entry.name))).equals(bytes)) return true;
  }
  return false;
}

test("489: a rule-enable whose records cannot be committed leaves AGENTS.md byte for byte, and takes away one it created", async (context) => {
  const paths = await scratch(context);
  const original = await readFile(paths.agents);
  const head = await libraryHead(paths);
  const refused = await refusal(() => enable(paths, "batch", OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", "the error that stopped the commit is the one thrown");
  assert.deepEqual(await readFile(paths.agents), original, "AGENTS.md holds what it held, byte for byte");
  assert.deepEqual(await libraryHead(paths), head, "the library holds no new event");
  assert.equal(await backedUp(paths, original), true, "the backup the write made stays");

  // A project without AGENTS.md: the file the enable created is not there afterwards.
  const bare = join(paths.base, "bare");
  await mkdir(bare);
  const created = await refusal(() => enable({ ...paths, project: bare }, "batch", OVER_BUDGET));
  assert.equal(created.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.equal(await bytesOrNull(join(bare, "AGENTS.md")), null, "the AGENTS.md the enable created is taken away");
  assert.deepEqual(await libraryHead(paths), head, "the library holds no new event");

  // A replace that cannot be recorded leaves the section as its record says, so the rule does not read as the user's change.
  await enable(paths, "batch", { catalog: await catalogWithBatchV1() });
  const v1 = await readFile(paths.agents);
  const recorded = await ruleRecords(paths, "batch");
  const upgrade = await refusal(() => enable(paths, "batch", OVER_BUDGET));
  assert.equal(upgrade.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(paths.agents), v1, "AGENTS.md holds the version the library records");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded, "the records are as they were, and the library holds no new event");
  assert.equal((await ruleOf(paths, "batch")).state, "update-available", "the rule reads as it did before the enable");

  // The normal path is as it was: the same enable, committed, replaces the section and records it.
  const upgraded = await enable(paths, "batch");
  assert.deepEqual([upgraded.result, upgraded.written, upgraded.recorded, upgraded.status.state], ["replace", true, 2, "enabled"]);
});

test("489: a rule-enable whose records went in before the failure (a crash after the event commit) keeps AGENTS.md as written", async (context) => {
  const paths = await scratch(context);
  const head = await libraryHead(paths);
  const error = await refusal(() => enable(paths, "batch", AFTER_COMMIT));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(paths), head, "the records went in");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
  const text = await readFile(paths.agents, "utf8");
  assert.equal(sectionOf(text, "rule:batch")?.body, await readFile(join(fixtures, "batch.zh.md"), "utf8"), "so the section stays where it was written");
  assert.equal(text.startsWith(`${USER_TEXT}\n`), true, "and the user's text where it was");
  const again = await enable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.status.state], ["unchanged", false, 0, "enabled"], "the file and the records agree");
});

test("489: a rule-disable whose records cannot be committed puts the section back, the user's change with it", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "autonomy");
  await enable(paths, "batch");
  const both = await readFile(paths.agents);
  const recorded = await ruleRecords(paths, "batch");
  const refused = await refusal(() => disable(paths, "batch", OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", "the error that stopped the commit is the one thrown");
  assert.deepEqual(await readFile(paths.agents), both, "the section is back in the file, markers and all, byte for byte");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded, "the rule stays enabled with its section recorded, and the library holds no new event");
  assert.equal(await backedUp(paths, both), true, "the backup the write made stays");

  // A section the user changed, disabled with force: the user's text comes back as the user left it.
  const edited = Buffer.from((await readFile(paths.agents, "utf8")).replace("批的单位", "批的单元"));
  await writeFile(paths.agents, edited);
  const forced = await refusal(() => disable(paths, "batch", { force: true, ...OVER_BUDGET }));
  assert.equal(forced.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(paths.agents), edited, "the user's text is where the user left it");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");

  // The normal path is as it was: the same disable, committed, takes the section out.
  const off = await disable(paths, "batch", { force: true });
  assert.deepEqual([off.result, off.written, off.recorded, off.status.state], ["disabled", true, 2, "disabled"]);
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "rule:batch"), null);
});

test("489: a rule-disable whose records went in before the failure (a crash after the event commit) keeps the section out", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "batch");
  const head = await libraryHead(paths);
  const error = await refusal(() => disable(paths, "batch", AFTER_COMMIT));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(paths), head, "the records went in");
  assert.deepEqual([await ruleRecord(paths, "batch"), await sectionRecord(paths, "batch")], [{ enabled: false, version: 3 }, null]);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "so the section stays out of the file");
  const again = await disable(paths, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.status.state], ["unchanged", false, 0, "disabled"], "the file and the records agree");
});

test("489: rule-resolve's two calls each put back only what they wrote, and the resolve that was recorded stays", async (context) => {
  const paths = await scratch(context);
  await enable(paths, "autonomy");
  await enable(paths, "batch");
  await writeFile(paths.agents, (await readFile(paths.agents, "utf8")).replace("批的单位", "批的单元"));
  assert.equal((await enable(paths, "batch")).status.state, "pending");
  // rule-resolve's first call, resolveAgentsSection, writes the engine's text and records it.
  const { change } = await resolveAgentsSection(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, id: "rule:batch", action: "overwrite", backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written, change.record.state], ["overwritten", true, "managed"]);
  const resolved = await readFile(paths.agents);
  const recorded = await ruleRecords(paths, "batch");
  // Its second, enableRule, writes the file again (an order moves the section here) and cannot record it.
  const refused = await refusal(() => enable(paths, "batch", { order: 1, ...OVER_BUDGET }));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.deepEqual(await readFile(paths.agents), resolved, "the file is as the first call wrote it, not as it was before that call");
  assert.deepEqual(await ruleRecords(paths, "batch"), recorded, "the first call's record stays, and the library holds no new event");
  assert.equal((await ruleOf(paths, "batch")).state, "enabled");
});

// Exercise the existing managed resolution paths on a real v2 section during a v3 upgrade.
test("INIT-053 AC3: modified v2 remains protected through render, upgrade, keep, overwrite and unmanage", async (context) => {
  for (const language of ["zh-CN", "en"]) {
    const previous = await readFile(join(fixtures, `batch-v2.${language === "zh-CN" ? "zh" : "en"}.md`), "utf8");
    const catalog = BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, version: 2, body: { zh: previous, en: previous } });
    for (const action of ["keep", "overwrite", "unmanage"]) {
      const paths = await scratch(context, language);
      await renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, backupRoot: paths.backups, occurredAt: at() });
      await enable(paths, "batch", { catalog });
      const original = await readFile(paths.agents, "utf8");
      const edited = original.replace(previous, `${previous}User addition.\n`);
      await writeFile(paths.agents, edited);
      assert.equal((await ruleOf(paths, "batch")).state, "user-modified");
      const rendered = await renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, backupRoot: paths.backups, occurredAt: at() });
      assert.deepEqual(rendered.pending, [{ id: "rule:batch", file: "AGENTS.md" }]);
      assert.equal(await readFile(paths.agents, "utf8"), edited);
      assert.equal((await enable(paths, "batch")).status.state, "pending");
      assert.equal(await readFile(paths.agents, "utf8"), edited, "upgrade never silently overwrites a changed v2 section");
      await registerLibrary({ projectPath: paths.project, projectId: paths.projectId, libraryPath: paths.library, registeredAt: at() });
      const receipt = await cli(["rule-resolve", "--project", paths.project, "--section", "rule:batch", "--action", action, "--at", at()]);
      assert.equal(receipt.result, { keep: "kept", overwrite: "overwritten", unmanage: "unmanaged" }[action]);
      const settled = await readFile(paths.agents, "utf8");
      if (action === "overwrite") {
        assert.equal(sectionOf(settled, "rule:batch").body, builtInRule("batch").body[language === "zh-CN" ? "zh" : "en"]);
        assert.equal((await ruleRecord(paths, "batch")).version, 3);
      } else {
        assert.ok(settled.includes("User addition."));
        if (action === "keep") assert.equal(settled, edited);
        else assert.equal(sectionOf(settled, "rule:batch"), null);
        await enable(paths, "batch");
        await renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, backupRoot: paths.backups, occurredAt: at() });
        assert.equal(await readFile(paths.agents, "utf8"), settled, "kept and unmanaged user text stays owned by the user");
      }
    }
  }
});

// INIT-053 R40: the Owner's revision of a rule at the same version (batch v3 and silent-reporting
// v1, recorded as rev 2 of their sections) changes the text and nothing else, as rules-catalog.ts
// says of a correction. A section enabled with the earlier text and left unchanged takes the revised
// text at the next agents-render, its revision raised by one; a section the user changed waits.
// R48 (MIN-242 D10): the second revision (clause 8) holds the same way for a section enabled with the
// R40 text, which batch-v3-rev2 keeps.
test("INIT-053 R40: a same-version revision replaces an unchanged rule section at the next render and leaves a changed one pending", async (context) => {
  for (const [language, suffix, earlier] of [["zh-CN", "zh", "batch-v3-rev1"], ["en", "en", "batch-v3-rev1"], ["zh-CN", "zh", "batch-v3-rev2"], ["en", "en", "batch-v3-rev2"]]) {
    const previous = await readFile(join(fixtures, `${earlier}.${suffix}.md`), "utf8");
    const current = builtInRule("batch").body[suffix];
    assert.notEqual(previous, current, "the fixture is the v3 text before the revision");
    assert.equal(previous.split("\n")[0], current.split("\n")[0], "the revision keeps the heading and its version");
    const catalog = BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, body: { ...rule.body, [suffix]: previous } });
    const render = (paths) => renderAgentsSections(paths.library, { projectRoot: paths.project, configurationProjectId: paths.projectId, backupRoot: paths.backups, occurredAt: at() });

    // Unchanged: enabled while the engine shipped the earlier v3 text.
    const paths = await scratch(context, language);
    await render(paths);
    const first = await enable(paths, "batch", { catalog });
    assert.deepEqual([first.result, first.status.version, first.status.fileVersion, first.status.state], ["create", 3, 1, "enabled"]);
    assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "rule:batch").body, previous);
    assert.equal((await ruleOf(paths, "batch")).state, "enabled", "the same version is not an update to enable");
    const rendered = await render(paths);
    assert.equal(rendered.sections.find((section) => section.id === "rule:batch").result, "replace");
    const section = sectionOf(await readFile(paths.agents, "utf8"), "rule:batch");
    assert.deepEqual([section.body, section.rev], [current, 2]);
    assert.deepEqual(await ruleOf(paths, "batch"), { id: "batch", version: 3, recordedVersion: 3, fileVersion: 2, section: "rule:batch", state: "enabled" });
    assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
    assert.deepEqual(await sectionRecord(paths, "batch"), { file: "AGENTS.md", id: "rule:batch", rev: 2, digest: sectionDigest(current), state: "managed" });

    // Changed by the user: the render leaves the section byte for byte and it waits.
    const changed = await scratch(context, language);
    await render(changed);
    await enable(changed, "batch", { catalog });
    const edited = (await readFile(changed.agents, "utf8")).replace(previous, `${previous}User addition.\n`);
    await writeFile(changed.agents, edited);
    assert.equal((await ruleOf(changed, "batch")).state, "user-modified");
    const refused = await render(changed);
    assert.deepEqual(refused.pending, [{ id: "rule:batch", file: "AGENTS.md" }]);
    assert.equal(await readFile(changed.agents, "utf8"), edited, "the user's text stays");
    assert.equal((await ruleOf(changed, "batch")).state, "pending");
  }
});

// TCRN-CROSS-STORY-540 (MIN-258 D3(c), MIN-259 D1): the Owner's two immediate rules, residue-cleanup
// and goal-writing, are switched on and off like every other rule. Enabling one records it at v1 and
// writes its text, in the project's artifact language, into AGENTS.md as its own managed section
// after the user's text; disabling it takes that section away with its markers and leaves the other
// rule's section and the user's text as they were.
test("540 (MIN-259 D1): residue-cleanup and goal-writing are enabled with their v1 sections in the project's language, and disabled again", async (context) => {
  for (const language of ["zh-CN", "en"]) {
    const paths = await scratch(context, language);
    for (const id of ["residue-cleanup", "goal-writing"]) {
      const body = builtInRule(id).body[language === "zh-CN" ? "zh" : "en"];
      const change = await enable(paths, id);
      assert.deepEqual([change.action, change.section, change.file, change.result, change.written], ["enable", `rule:${id}`, "AGENTS.md", "create", true], `${id} ${language}`);
      assert.deepEqual(change.status, { id, version: 1, recordedVersion: 1, fileVersion: 1, section: `rule:${id}`, state: "enabled" }, `${id} ${language}`);
      const section = sectionOf(await readFile(paths.agents, "utf8"), `rule:${id}`);
      assert.deepEqual([section.body, section.rev, section.digest], [body, 1, sectionDigest(body)], `${id} ${language}: the section holds the v1 text`);
      assert.deepEqual(await ruleRecord(paths, id), { enabled: true, version: 1 });
      assert.deepEqual(await sectionRecord(paths, id), { file: "AGENTS.md", id: `rule:${id}`, rev: 1, digest: sectionDigest(body), state: "managed" });
    }
    const both = await readFile(paths.agents, "utf8");
    assert.equal(both.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
    if (language === "zh-CN") {
      for (const id of ["residue-cleanup", "goal-writing"]) {
        assert.equal(sectionOf(both, `rule:${id}`).body, await readFile(join(fixtures, `${id}.zh.md`), "utf8"), `${id}: the Owner's Chinese text`);
      }
    }

    const off = await disable(paths, "residue-cleanup");
    assert.deepEqual([off.action, off.result, off.written], ["disable", "disabled", true]);
    assert.deepEqual(off.status, { id: "residue-cleanup", version: 1, recordedVersion: 1, fileVersion: null, section: "rule:residue-cleanup", state: "disabled" });
    assert.deepEqual(await ruleRecord(paths, "residue-cleanup"), { enabled: false, version: 1 });
    assert.equal(await sectionRecord(paths, "residue-cleanup"), null, "the section is no longer recorded");
    const after = await readFile(paths.agents, "utf8");
    assert.equal(sectionOf(after, "rule:residue-cleanup"), null);
    assert.equal(sectionOf(after, "rule:goal-writing").raw, sectionOf(both, "rule:goal-writing").raw, "the other rule's section stays");
    assert.equal(after.startsWith(USER_TEXT), true);
    assert.deepEqual((await list(paths)).filter((rule) => ["residue-cleanup", "goal-writing"].includes(rule.id)).map((rule) => [rule.id, rule.state]), [["residue-cleanup", "disabled"], ["goal-writing", "enabled"]]);
  }
});
