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
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { resolveAgentsSection } from "../dist/build/packages/core/src/agents-sections.js";
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
  if (language !== null) await setWorkspaceSetting(library, { key: "artifact.language", value: language, occurredAt: at() });
  return { base, project, library, agents, backups: join(base, "device", "backups") };
}

const enable = (paths, id, extra = {}) => enableRule({ libraryRoot: paths.library, projectRoot: paths.project, id, backupRoot: paths.backups, occurredAt: at(), ...extra });
const disable = (paths, id, extra = {}) => disableRule({ libraryRoot: paths.library, projectRoot: paths.project, id, backupRoot: paths.backups, occurredAt: at(), ...extra });
const list = (paths, extra = {}) => listRules({ libraryRoot: paths.library, projectRoot: paths.project, ...extra });

async function ruleOf(paths, id, extra = {}) {
  return (await list(paths, extra)).find((rule) => rule.id === id);
}

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

async function sectionRecord(paths, id) {
  return managedSectionRecordsFor(await materializeWorkspace(paths.library), "AGENTS.md").find((record) => record.id === ruleSectionId(id)) ?? null;
}

async function ruleRecord(paths, id) {
  return configRecord(await materializeWorkspace(paths.library), "rule", id)?.value ?? null;
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

test("483-AC1: enabling batch processing writes its v2 text into AGENTS.md as a managed section, and the rule reads enabled", async (context) => {
  const paths = await scratch(context);
  const v2 = await readFile(join(fixtures, "batch.zh.md"), "utf8");
  assert.equal(v2.split("\n")[0], "## 批量处理原则 v2");

  const change = await enable(paths, "batch");
  assert.deepEqual([change.action, change.section, change.file, change.result, change.written, change.recorded], ["enable", "rule:batch", "AGENTS.md", "create", true, 2]);
  assert.equal(await readFile(change.backupPath, "utf8"), USER_TEXT, "the original is backed up before it is replaced");
  const text = await readFile(paths.agents, "utf8");
  assert.equal(text.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
  const section = sectionOf(text, "rule:batch");
  assert.deepEqual([section.body, section.rev, section.digest], [v2, 1, sectionDigest(v2)], "the section holds the v2 text");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 2 });
  assert.deepEqual(await sectionRecord(paths, "batch"), { file: "AGENTS.md", id: "rule:batch", rev: 1, digest: sectionDigest(v2), state: "managed" });

  const rules = await list(paths);
  const batch = rules.find((rule) => rule.id === "batch");
  assert.deepEqual(batch, { id: "batch", version: 2, recordedVersion: 2, fileVersion: 1, section: "rule:batch", state: "enabled" });
  assert.deepEqual(change.status, batch, "the change reports the state listRules reads");
  assert.deepEqual(rules.filter((rule) => rule.id !== "batch").map((rule) => rule.state), ["disabled", "disabled", "disabled"]);

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
  const resaved = written.replace(/\n/gu, "\r\n").replace("## 批量处理原则 v2\r\n", "## 批量处理原则 v2 \t \r\n");
  assert.notEqual(resaved, written.replace(/\n/gu, "\r\n"));
  await writeFile(paths.agents, resaved);
  assert.equal((await ruleOf(paths, "batch")).state, "enabled");

  const edited = resaved.replace("批的单位", "批的单元");
  assert.equal(edited.length, resaved.length);
  await writeFile(paths.agents, edited);
  const batch = await ruleOf(paths, "batch");
  assert.deepEqual([batch.state, batch.fileVersion, batch.recordedVersion], ["user-modified", 1, 2]);
  assert.equal(await readFile(paths.agents, "utf8"), edited, "reading the state writes nothing");
  assert.deepEqual((await sectionRecord(paths, "batch")).state, "managed", "nor does it record anything");
});

test("483-AC3: a newer version of a rule reads update-available and leaves the file byte for byte until the rule is enabled again", async (context) => {
  const paths = await scratch(context);
  const catalog = await catalogWithBatchV1();
  const v1 = await readFile(join(fixtures, "batch-v1.zh.md"), "utf8");
  const v2 = await readFile(join(fixtures, "batch.zh.md"), "utf8");

  // Enabled while the engine shipped batch processing v1.
  const first = await enable(paths, "batch", { catalog });
  assert.deepEqual([first.result, first.status.state, first.status.version], ["create", "enabled", 1]);
  assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "rule:batch").body, v1);
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 1 });

  // The engine now ships v2: the rule reads update-available, and nothing is written.
  const before = await readFile(paths.agents);
  const batch = await ruleOf(paths, "batch");
  assert.deepEqual(batch, { id: "batch", version: 2, recordedVersion: 1, fileVersion: 1, section: "rule:batch", state: "update-available" });
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
  assert.deepEqual(updated.status, { id: "batch", version: 2, recordedVersion: 2, fileVersion: 2, section: "rule:batch", state: "enabled" });
  const after = await readFile(paths.agents, "utf8");
  assert.deepEqual([sectionOf(after, "rule:batch").body, sectionOf(after, "rule:batch").rev], [v2, 2]);
  assert.equal(sectionOf(after, "rule:autonomy").raw, sectionOf(withAutonomy, "rule:autonomy").raw);
  assert.equal(await readFile(updated.backupPath, "utf8"), withAutonomy);

  // An engine that ships an older version than the library records refuses to write its text.
  const older = await refusal(() => enable(paths, "batch", { catalog }));
  assert.deepEqual([older.reasonCode, older.details.id, older.details.recordedVersion, older.details.version], ["RULE_VERSION_NEWER", "batch", "2", "1"]);
  assert.equal(await readFile(paths.agents, "utf8"), after);
});

test("T15: rule-resolve overwrite records the version of the body it writes", async (context) => {
  const paths = await scratch(context);
  const catalog = await catalogWithBatchV1();
  await enable(paths, "batch", { catalog });
  const changed = (await readFile(paths.agents, "utf8")).replace("批的单位", "批的单元");
  await writeFile(paths.agents, changed);
  assert.equal((await ruleOf(paths, "batch")).state, "user-modified");
  await registerLibrary({ projectPath: paths.project, libraryPath: paths.library, registeredAt: at() });

  const receipt = await cli(["rule-resolve", "--project", paths.project, "--section", "rule:batch", "--action", "overwrite", "--at", at()]);
  assert.deepEqual([receipt.reasonCode, receipt.result, receipt.state], ["MANAGED_SECTION_RESOLVED", "overwritten", "managed"]);
  const section = sectionOf(await readFile(paths.agents, "utf8"), "rule:batch");
  const v2 = await readFile(join(fixtures, "batch.zh.md"), "utf8");
  assert.equal(section.body, v2, "the explicit overwrite writes the current engine text");
  assert.deepEqual(await sectionRecord(paths, "batch"), {
    file: "AGENTS.md", id: "rule:batch", rev: 2, digest: sectionDigest(v2), state: "managed",
  });
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 2 });
  assert.deepEqual(await ruleOf(paths, "batch"), {
    id: "batch", version: 2, recordedVersion: 2, fileVersion: 2, section: "rule:batch", state: "enabled",
  });
});

test("T15: rule-resolve overwrite refuses to replace a newer recorded rule with older engine text", async (context) => {
  const paths = await scratch(context);
  const futureCatalog = BUILT_IN_RULES.map((rule) => rule.id === "batch"
    ? { ...rule, version: 3, body: { zh: "## 批量规则 v3\n", en: "## Batch rule v3\n" } }
    : rule);
  await enable(paths, "batch", { catalog: futureCatalog });
  await registerLibrary({ projectPath: paths.project, libraryPath: paths.library, registeredAt: at() });
  const before = await readFile(paths.agents, "utf8");

  const error = await refusal(() => runCli(["rule-resolve", "--project", paths.project, "--section", "rule:batch", "--action", "overwrite", "--at", at()], { write() {} }));
  assert.deepEqual([error.reasonCode, error.details.recordedVersion, error.details.version], ["RULE_VERSION_NEWER", "3", "2"]);
  assert.equal(await readFile(paths.agents, "utf8"), before, "the older engine leaves the newer section byte for byte");
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 3 });
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

  const { change } = await resolveAgentsSection(paths.library, { projectRoot: paths.project, id: "rule:batch", action: "keep", backupRoot: paths.backups, occurredAt: at() });
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
  assert.deepEqual(await ruleRecord(paths, "batch"), { enabled: true, version: 2 }, "nor records anything");

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

  assert.doesNotThrow(() => checkRuleRecordValue({ enabled: true, version: 2 }, "batch"));
  for (const [value, key] of [
    [{ enabled: true, version: 2 }, "Batch"],
    [{ enabled: true, version: 2 }, "rule:batch"],
    [{ enabled: true }, "batch"],
    [{ enabled: true, version: 2, state: "enabled" }, "batch"],
    [{ enabled: "yes", version: 2 }, "batch"],
    [{ enabled: true, version: 0 }, "batch"],
    [{ enabled: true, version: 1.5 }, "batch"],
  ]) {
    assert.throws(() => checkRuleRecordValue(value, key), (error) => error?.reasonCode === "RULE_RECORD_INVALID", JSON.stringify([value, key]));
  }
  const invalid = await refusal(() => setConfigRecord(paths.library, { collection: "rule", key: "batch", value: { state: "enabled" }, occurredAt: at() }));
  assert.deepEqual([invalid.reasonCode, invalid.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "RULE_RECORD_INVALID"]);

  // A newer engine elsewhere enabled a rule this one does not ship: it is listed after the built-in
  // rules, and it can be disabled; it cannot be enabled here.
  await setConfigRecord(paths.library, { collection: "rule", key: "future-rule", value: { enabled: true, version: 3 }, occurredAt: at() });
  const rules = await list(paths);
  assert.deepEqual(rules.map((rule) => rule.id), [...BUILT_IN_RULES.map((rule) => rule.id), "future-rule"]);
  assert.deepEqual(rules.at(-1), { id: "future-rule", version: null, recordedVersion: 3, fileVersion: null, section: "rule:future-rule", state: "removed-from-file" });
  assert.equal(builtInRule("future-rule"), null);
  assert.equal((await refusal(() => enable(paths, "future-rule"))).reasonCode, "RULE_UNKNOWN");
  const off = await disable(paths, "future-rule");
  assert.deepEqual([off.result, off.status.state, off.status.recordedVersion], ["disabled", "disabled", 3]);
  assert.deepEqual(await ruleRecord(paths, "future-rule"), { enabled: false, version: 3 });
});
