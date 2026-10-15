// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-478 R3, R4, R5, AC4, AC5 (MIN-227 D14, D17; TCRN-CROSS-SUB-317): the sections the
// engine keeps in a project's AGENTS.md and CLAUDE.md. A CLAUDE.md that imports AGENTS.md keeps
// every byte, and a project without one gets a CLAUDE.md that holds the import section alone
// (AC4). The navigation lines go into AGENTS.md on a device whose agents.navigation is written; a
// device that declined them gets the SessionStart and SubagentStart pointer hooks instead (AC5).
// A section the user changed is settled by overwrite, keep or unmanage, and disabling one needs
// force (R3). Everything here is temporary: a project, a library and a device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeLibrary, materializeWorkspace, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";
import {
  AGENTS_FILE,
  CLAUDE_FILE,
  CLAUDE_IMPORT_SECTION,
  NAVIGATION_LINES,
  NAVIGATION_SECTION,
  disableAgentsSection,
  disableSection,
  engineSectionBody,
  ensureClaudeImport,
  importsAgents,
  managedSectionFile,
  orderRuleSections,
  renderAgentsSections,
  resolveAgentsSection,
  resolveSection,
} from "../dist/build/packages/core/src/agents-sections.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { builtInRule } from "../dist/build/packages/core/src/rules-catalog.js";
import { HOST_HOOK_POINTER_EVENTS, mergeHostHooks, planHostHooks } from "../dist/build/packages/core/src/host-hooks.js";
import { AGENTS_NAVIGATION_SETTING, MACHINE_SETTINGS_CATALOG, applyMachineSettingSet, readAgentsNavigation } from "../dist/build/packages/core/src/machine-settings.js";
import { absolutePathLine, managedSectionRecordsFor, parseManagedFile, renderSection, sectionDigest } from "../dist/build/packages/core/src/managed-sections.js";
import { setVariable } from "../dist/build/packages/core/src/variables.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 8, 0, second)).toISOString().replace(".000Z", "Z");
};

const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";
const EDITED_LINE = "Recall first, always.";

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-agents-sections-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  return { base, project, backups: join(base, "device", "backups"), device: join(base, "device") };
}

async function library(base) {
  const root = join(base, ".ether");
  await initializeLibrary({ root, createdAt: at() });
  return root;
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

async function records(root, file = AGENTS_FILE) {
  return managedSectionRecordsFor(await materializeWorkspace(root), file);
}

/** A project whose AGENTS.md holds the user's text and the engine's sections, the navigation section among them. */
async function renderedProject(context) {
  const paths = await scratch(context);
  await writeFile(join(paths.project, AGENTS_FILE), USER_TEXT);
  const root = await library(paths.base);
  const rendered = await renderAgentsSections(root, { projectRoot: paths.project, navigation: "written", backupRoot: paths.backups, occurredAt: at() });
  return { ...paths, root, rendered };
}

/** The same project after the user changed the last navigation line and the sections were rendered again. */
async function pendingProject(context) {
  const project = await renderedProject(context);
  const path = join(project.project, AGENTS_FILE);
  const written = await readFile(path, "utf8");
  const edited = written.replace(NAVIGATION_LINES[2], EDITED_LINE);
  assert.notEqual(edited, written);
  await writeFile(path, edited);
  const again = await renderAgentsSections(project.root, { projectRoot: project.project, navigation: "written", backupRoot: project.backups, occurredAt: at() });
  assert.deepEqual(again.pending, [{ id: "navigation", file: AGENTS_FILE }]);
  assert.equal(await readFile(path, "utf8"), edited, "the changed section is left as it is");
  return { ...project, path, edited };
}

test("478-AC4: a CLAUDE.md that imports AGENTS.md keeps every byte, and a project without one gets the import section alone", async (context) => {
  const { project, backups } = await scratch(context);
  const path = join(project, CLAUDE_FILE);
  for (const text of ["@AGENTS.md\n", "# Notes\r\n\r\nRead @AGENTS.md first.\r\n", "Rules: @./AGENTS.md, and mine below.\n\n- keep it short\n"]) {
    await writeFile(path, text);
    const { mtimeMs } = await stat(path);
    const result = await ensureClaudeImport(project, { at: at(), backupRoot: backups });
    assert.equal(result.written, false, JSON.stringify(text));
    assert.deepEqual(result.sections, [], "nothing is planned for a CLAUDE.md that imports AGENTS.md");
    assert.equal(await readFile(path, "utf8"), text, "every byte stays");
    assert.equal((await stat(path)).mtimeMs, mtimeMs, "the file is not touched");
  }

  await rm(path);
  const created = await ensureClaudeImport(project, { at: at(), backupRoot: backups });
  assert.equal(created.written, true);
  assert.equal(created.backupPath, null, "a new file has nothing to back up");
  const expected = renderSection({ id: CLAUDE_IMPORT_SECTION.id, rev: 1, body: "@AGENTS.md\n" });
  assert.equal(await readFile(path, "utf8"), expected, "the new CLAUDE.md holds the import section alone");
  const parsed = parseManagedFile(expected);
  assert.deepEqual(parsed.sections.map((section) => section.id), ["claude-import"]);
  assert.deepEqual(parsed.outside, ["", ""], "nothing outside the section");
  assert.equal(importsAgents(expected), true);
  const again = await ensureClaudeImport(project, { at: at(), backupRoot: backups, records: created.sections.map((decision) => decision.record) });
  assert.equal(again.written, false);
  assert.deepEqual(again.sections.map((decision) => [decision.id, decision.result, decision.recordChanged]), [["claude-import", "unchanged", false]]);

  // A CLAUDE.md of the user's own without the import gets the section after its text.
  await writeFile(path, USER_TEXT);
  const appended = await ensureClaudeImport(project, { at: at(), backupRoot: backups });
  assert.equal(appended.written, true);
  assert.equal(await readFile(path, "utf8"), `${USER_TEXT}\n${expected}`);
  assert.equal(await readFile(appended.backupPath, "utf8"), USER_TEXT, "the original is backed up first");
});

test("478-R5: an import in a code block or a code span, or of another file, is not an import", () => {
  assert.equal(importsAgents("```\n@AGENTS.md\n```\n"), false);
  assert.equal(importsAgents("~~~~md\n@AGENTS.md\n~~~~\n"), false);
  assert.equal(importsAgents("Write `@AGENTS.md` to import it.\n"), false);
  assert.equal(importsAgents("@AGENTS.md.bak\n@docs/AGENTS.md\nuser@AGENTS.md\n"), false);
  assert.equal(importsAgents("```\ncode\n```\n@AGENTS.md\n"), true);
  assert.equal(managedSectionFile("claude-import"), CLAUDE_FILE);
  for (const id of ["navigation", "rule:autonomy", "variables-system", "variables-custom"]) assert.equal(managedSectionFile(id), AGENTS_FILE, id);
});

test("478-R4: the navigation section holds three lines and goes into AGENTS.md only on a device that chose written", async (context) => {
  const { base, project, backups } = await scratch(context);
  assert.equal(NAVIGATION_LINES.length, 3);
  assert.equal(NAVIGATION_SECTION.body, `${NAVIGATION_LINES.join("\n")}\n`);
  assert.match(NAVIGATION_LINES[0], /Einzbern/u);
  assert.match(NAVIGATION_LINES[1], /Mana Orchestrate/u);
  assert.match(NAVIGATION_LINES[2], /recall/u);

  const root = await library(base);
  await writeFile(join(project, CLAUDE_FILE), "@AGENTS.md\n");
  const declined = await renderAgentsSections(root, { projectRoot: project, navigation: "declined", backupRoot: backups, occurredAt: at() });
  assert.deepEqual(declined.sections.map((section) => [section.file, section.id, section.result]), [
    [AGENTS_FILE, "variables-system", "create"],
    [AGENTS_FILE, "variables-custom", "create"],
  ]);
  assert.equal(await readFile(join(project, CLAUDE_FILE), "utf8"), "@AGENTS.md\n", "a CLAUDE.md that imports AGENTS.md is left byte for byte");
  const agents = await readFile(join(project, AGENTS_FILE), "utf8");
  assert.equal(sectionOf(agents, "navigation"), null, "a device that declined gets no navigation section");
  assert.deepEqual((await records(root)).map((record) => [record.id, record.state]), [["variables-custom", "managed"], ["variables-system", "managed"]]);

  const written = await renderAgentsSections(root, { projectRoot: project, navigation: "written", backupRoot: backups, occurredAt: at() });
  assert.deepEqual(written.sections.map((section) => [section.id, section.result]), [
    ["variables-system", "unchanged"],
    ["variables-custom", "unchanged"],
    ["navigation", "create"],
  ]);
  assert.equal(written.recorded, 1);
  const navigation = sectionOf(await readFile(join(project, AGENTS_FILE), "utf8"), "navigation");
  assert.equal(navigation.body, NAVIGATION_SECTION.body);
  assert.equal(written.backupDir !== null && (await readdir(written.backupDir)).includes(AGENTS_FILE), true, "AGENTS.md was backed up before it was replaced");

  // A device that declined leaves a navigation section another device wrote where it is.
  const other = await renderAgentsSections(root, { projectRoot: project, navigation: "declined", backupRoot: backups, occurredAt: at() });
  assert.equal(other.files.some((file) => file.written), false);
  assert.equal(other.recorded, 0);
  assert.deepEqual(other.sections.find((section) => section.id === "navigation"), { id: "navigation", file: AGENTS_FILE, result: "unchanged", state: "managed", line: navigation.startLine });
});

test("478-AC5: declined adds the SessionStart and SubagentStart pointer hooks; written or unset adds none", async (context) => {
  const { device } = await scratch(context);
  const deviceHome = "/srv/einzbern/device";
  for (const host of ["claude-code", "codex"]) {
    const declined = planHostHooks({ host, scope: "user", deviceHome, platform: "linux", navigation: "declined" });
    assert.deepEqual(Object.keys(declined.groups), ["UserPromptSubmit", "SessionStart", "SubagentStart"], host);
    assert.equal(declined.navigation, "declined");
    assert.equal(declined.groups.SessionStart[0].hooks[0].command, 'node "/srv/einzbern/device/engine/hook.mjs" session-start');
    assert.equal(declined.groups.SubagentStart[0].hooks[0].command, 'node "/srv/einzbern/device/engine/hook.mjs" subagent-start');
    for (const choice of ["written", null, undefined]) {
      const expected = planHostHooks({ host, scope: "user", deviceHome, platform: "linux", ...(choice === undefined ? {} : { navigation: choice }) });
      assert.deepEqual(Object.keys(expected.groups), ["UserPromptSubmit"], `${host}: ${choice}`);
    }
    const clean = planHostHooks({ host, scope: "project", deviceHome, platform: "linux", navigation: "declined", install: false });
    assert.deepEqual(clean.groups, {}, "a clean-only plan renders no pointer hook either");
  }
  assert.deepEqual(HOST_HOOK_POINTER_EVENTS, { SessionStart: "session-start", SubagentStart: "subagent-start" });
  assert.throws(() => planHostHooks({ host: "codex", scope: "user", deviceHome, navigation: "maybe" }), (error) => error?.reasonCode === "HOST_HOOKS_INPUT_INVALID");

  // The choice is this device's: asked once, kept in its machine settings, read back as it was set.
  const entry = MACHINE_SETTINGS_CATALOG.find((candidate) => candidate.key === AGENTS_NAVIGATION_SETTING);
  assert.deepEqual([entry.layer, entry.type, entry.allowedValues, entry.defaultValue], ["device", "enum", ["written", "declined"], null]);
  assert.equal(await readAgentsNavigation(device), null, "unset until the installer asks");
  const path = join(device, "machine-settings.json");
  await assert.rejects(applyMachineSettingSet({ key: AGENTS_NAVIGATION_SETTING, value: "no", occurredAt: at(), path }), (error) => error?.reasonCode === "MACHINE_SETTING_VALUE_INVALID");
  await applyMachineSettingSet({ key: AGENTS_NAVIGATION_SETTING, value: "declined", occurredAt: at(), path });
  assert.equal(await readAgentsNavigation(device), "declined");
  const fromDevice = planHostHooks({ host: "claude-code", scope: "user", deviceHome, platform: "linux", navigation: await readAgentsNavigation(device) });
  assert.deepEqual(Object.keys(fromDevice.groups), ["UserPromptSubmit", "SessionStart", "SubagentStart"]);

  // Written after declined: rendering again takes the pointer hooks out and keeps the prompt hook.
  const other = { matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] };
  const first = mergeHostHooks({ hooks: { SessionStart: [other] } }, fromDevice);
  assert.deepEqual(first.document.hooks.SessionStart, [other, ...fromDevice.groups.SessionStart]);
  await applyMachineSettingSet({ key: AGENTS_NAVIGATION_SETTING, value: "written", occurredAt: at(), path });
  const written = planHostHooks({ host: "claude-code", scope: "user", deviceHome, platform: "linux", navigation: await readAgentsNavigation(device) });
  const rerendered = mergeHostHooks(first.document, written);
  assert.deepEqual(rerendered.document.hooks, { SessionStart: [other], UserPromptSubmit: written.groups.UserPromptSubmit });
  assert.deepEqual(rerendered.removedHooks.map((hook) => hook.event).sort(), ["SessionStart", "SubagentStart"]);
});

test("478-R3: overwrite puts the engine's text back and records it as the new baseline", async (context) => {
  const { root, project, backups, path, edited } = await pendingProject(context);
  const before = (await records(root)).find((record) => record.id === "navigation");
  assert.deepEqual([before.state, before.rev, before.digest], ["pending", 1, sectionDigest(NAVIGATION_SECTION.body)]);

  const { change } = await resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "overwrite", backupRoot: backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written, change.recordChanged], ["overwritten", true, true]);
  assert.deepEqual(change.record, { file: AGENTS_FILE, id: "navigation", rev: 2, digest: sectionDigest(NAVIGATION_SECTION.body), state: "managed" });
  assert.equal(await readFile(change.backupPath, "utf8"), edited, "the user's version is backed up before it is replaced");
  const after = await readFile(path, "utf8");
  const navigation = sectionOf(after, "navigation");
  assert.deepEqual([navigation.body, navigation.rev, navigation.digest], [NAVIGATION_SECTION.body, 2, sectionDigest(NAVIGATION_SECTION.body)]);
  assert.deepEqual(parseManagedFile(after).outside, parseManagedFile(edited).outside, "nothing outside the section changed");
  assert.deepEqual((await records(root)).find((record) => record.id === "navigation"), change.record);

  const again = await renderAgentsSections(root, { projectRoot: project, navigation: "written", backupRoot: backups, occurredAt: at() });
  assert.deepEqual([again.pending, again.recorded, again.files.some((file) => file.written)], [[], 0, false]);
});

test("T15: a changed variable section stays pending until explicitly overwritten", async (context) => {
  const paths = await scratch(context);
  await writeFile(join(paths.project, AGENTS_FILE), USER_TEXT);
  const root = await library(paths.base);
  await setVariable(root, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const first = await renderAgentsSections(root, { projectRoot: paths.project, navigation: null, backupRoot: paths.backups, occurredAt: at() });
  assert.equal(first.pending.length, 0);

  const original = await readFile(join(paths.project, AGENTS_FILE), "utf8");
  const edited = original.replace("build.example.com", "hand.example.com");
  await writeFile(join(paths.project, AGENTS_FILE), edited);
  await setVariable(root, { name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
  const blocked = await renderAgentsSections(root, { projectRoot: paths.project, navigation: null, backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual(blocked.pending, [{ id: "variables-custom", file: AGENTS_FILE }]);
  assert.equal(await readFile(join(paths.project, AGENTS_FILE), "utf8"), edited, "automatic rendering preserves the user's edit");

  const settled = await resolveAgentsSection(root, { projectRoot: paths.project, id: "variables-custom", action: "overwrite", backupRoot: paths.backups, occurredAt: at() });
  assert.deepEqual([settled.change.result, settled.change.record?.state], ["overwritten", "managed"]);
  const custom = sectionOf(await readFile(join(paths.project, AGENTS_FILE), "utf8"), "variables-custom");
  assert.match(custom.body, /^\| deploy\.host \| string \| build\.example\.com \|  \|$/mu);
  assert.match(custom.body, /^\| deploy\.port \| number \| 8443 \|  \|$/mu);
});

test("478-R3: keep records the user's text as theirs, and the engine never writes that section again", async (context) => {
  const { root, project, backups, path, edited } = await pendingProject(context);
  const { change } = await resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "keep", backupRoot: backups, occurredAt: at() });
  const kept = sectionOf(edited, "navigation");
  assert.deepEqual([change.result, change.written, change.backupPath], ["kept", false, null]);
  assert.deepEqual(change.record, { file: AGENTS_FILE, id: "navigation", rev: 1, digest: kept.bodyDigest, state: "user-owned" });
  assert.equal(await readFile(path, "utf8"), edited, "keep writes nothing");

  const again = await renderAgentsSections(root, { projectRoot: project, navigation: "written", backupRoot: backups, occurredAt: at() });
  assert.deepEqual(again.sections.find((section) => section.id === "navigation"), { id: "navigation", file: AGENTS_FILE, result: "unchanged", state: "user-owned", line: kept.startLine });
  assert.deepEqual([again.pending, again.recorded], [[], 0]);
  assert.equal(await readFile(path, "utf8"), edited);

  // Only force overwrites a section the user kept.
  const error = await refusal(() => resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "overwrite", backupRoot: backups, occurredAt: at() }));
  assert.deepEqual([error.reasonCode, error.details.file, error.details.section, error.details.state], ["MANAGED_SECTION_FORCE_REQUIRED", AGENTS_FILE, "navigation", "user-owned"]);
  assert.equal(await readFile(path, "utf8"), edited);
  const forced = await resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "overwrite", force: true, backupRoot: backups, occurredAt: at() });
  assert.deepEqual([forced.change.result, forced.change.record.state, forced.change.record.rev], ["overwritten", "managed", 2]);
  assert.equal(sectionOf(await readFile(path, "utf8"), "navigation").body, NAVIGATION_SECTION.body);
});

test("478-R3: unmanage takes the markers out and leaves the text, which is never managed again", async (context) => {
  const { root, project, backups, path, edited } = await pendingProject(context);
  const { change } = await resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "unmanage", backupRoot: backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written], ["unmanaged", true]);
  assert.deepEqual(change.record, { file: AGENTS_FILE, id: "navigation", rev: 1, digest: sectionDigest(NAVIGATION_SECTION.body), state: "unmanaged" });
  const after = await readFile(path, "utf8");
  const section = sectionOf(edited, "navigation");
  assert.equal(after, edited.replace(section.raw, section.body), "the two marker lines go and the text between them stays");
  assert.equal(after.includes("id=navigation"), false);
  assert.equal(after.includes(EDITED_LINE), true);

  const again = await renderAgentsSections(root, { projectRoot: project, navigation: "written", backupRoot: backups, occurredAt: at() });
  assert.deepEqual(again.sections.find((entry) => entry.id === "navigation"), { id: "navigation", file: AGENTS_FILE, result: "unchanged", state: "unmanaged", line: null });
  assert.equal(await readFile(path, "utf8"), after, "the section is not put back");
  const missing = await refusal(() => resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "keep", occurredAt: at() }));
  assert.deepEqual([missing.reasonCode, missing.details.section], ["MANAGED_SECTION_NOT_FOUND", "navigation"]);
});

test("478-R3: a section the user changed is disabled only with force, and an unchanged one takes its blank line with it", async (context) => {
  const { root, project, backups, path, edited } = await pendingProject(context);
  const error = await refusal(() => disableAgentsSection(root, { projectRoot: project, id: "navigation", backupRoot: backups, occurredAt: at() }));
  assert.deepEqual([error.reasonCode, error.details.section, error.details.state], ["MANAGED_SECTION_FORCE_REQUIRED", "navigation", "pending"]);
  assert.equal(await readFile(path, "utf8"), edited, "a refused disable writes nothing");

  const { change, state } = await disableAgentsSection(root, { projectRoot: project, id: "navigation", force: true, backupRoot: backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written, change.record, change.recordChanged], ["disabled", true, null, true]);
  assert.equal(await readFile(change.backupPath, "utf8"), edited);
  assert.equal(await readFile(path, "utf8"), edited.replace(`${sectionOf(edited, "navigation").raw}\n`, ""), "the section goes with the blank line after it");
  assert.equal(managedSectionRecordsFor(state, AGENTS_FILE).some((record) => record.id === "navigation"), false, "the record is removed");

  // The core, file by file: an unchanged section needs no force, and the file is as it was before the section came.
  const { project: other, backups: otherBackups } = await scratch(context);
  const otherPath = join(other, AGENTS_FILE);
  await writeFile(otherPath, USER_TEXT);
  const recorded = [];
  const created = await writeNavigation(other, otherBackups, recorded);
  assert.equal(created, `${USER_TEXT}\n${renderSection({ id: "navigation", rev: 1, body: NAVIGATION_SECTION.body })}`);
  const disabled = await disableSection({ projectRoot: other, id: "navigation", records: recorded, at: at(), backupRoot: otherBackups });
  assert.deepEqual([disabled.result, disabled.record], ["disabled", null]);
  assert.equal(await readFile(otherPath, "utf8"), USER_TEXT);
  const nothing = await disableSection({ projectRoot: other, id: "navigation", records: [], at: at(), backupRoot: otherBackups });
  assert.deepEqual([nothing.result, nothing.written, nothing.recordChanged], ["unchanged", false, false]);
});

/** Put the navigation section into AGENTS.md through the managed-section writer, as a render would. */
async function writeNavigation(projectRoot, backupRoot, recorded) {
  const { planManagedWrite, applyManagedWrite } = await import("../dist/build/packages/core/src/managed-sections.js");
  const plan = await planManagedWrite({ filePath: join(projectRoot, AGENTS_FILE), desired: [{ id: "navigation", body: NAVIGATION_SECTION.body }], records: [] });
  await applyManagedWrite(plan, { now: at(), backupRoot });
  recorded.push(...plan.sections.map((decision) => decision.record));
  return readFile(join(projectRoot, AGENTS_FILE), "utf8");
}

test("478-R3: a disposition names its action and needs the engine's text to overwrite", async (context) => {
  const { root, project, backups, rendered } = await renderedProject(context);
  // A project without a CLAUDE.md got one holding the import section, recorded with the others.
  assert.deepEqual(rendered.sections.map((section) => [section.file, section.id, section.result]), [
    [AGENTS_FILE, "navigation", "create"],
    [AGENTS_FILE, "variables-system", "create"],
    [AGENTS_FILE, "variables-custom", "create"],
    [CLAUDE_FILE, "claude-import", "create"],
  ]);
  assert.equal(await readFile(join(project, CLAUDE_FILE), "utf8"), renderSection({ id: "claude-import", rev: 1, body: "@AGENTS.md\n" }));
  assert.deepEqual((await records(root, CLAUDE_FILE)).map((record) => [record.id, record.state]), [["claude-import", "managed"]]);
  const state = await materializeWorkspace(root);
  assert.equal(engineSectionBody(state, "navigation"), NAVIGATION_SECTION.body);
  assert.equal(engineSectionBody(state, "claude-import"), CLAUDE_IMPORT_SECTION.body);
  assert.match(engineSectionBody(state, "rule:autonomy"), /^## Autonomous Operation Principle v1\n/u);
  assert.equal(engineSectionBody(state, "rule:nothing"), null);
  assert.equal(engineSectionBody(state, "my-own"), null);

  const invalid = await refusal(() => resolveSection({ projectRoot: project, id: "navigation", action: "replace", records: [], at: at(), backupRoot: backups }));
  assert.equal(invalid.reasonCode, "MANAGED_SECTION_ACTION_INVALID");
  const bodiless = await refusal(() => resolveSection({ projectRoot: project, id: "navigation", action: "overwrite", records: [], at: at(), backupRoot: backups }));
  assert.equal(bodiless.reasonCode, "MANAGED_SECTION_ACTION_INVALID");
  const absolute = await refusal(() => resolveSection({ projectRoot: project, id: "navigation", action: "overwrite", body: "Run /opt/tools/bin/check.\n", records: [], at: at(), backupRoot: backups }));
  assert.equal(absolute.reasonCode, "MANAGED_SECTION_ABSOLUTE_PATH");
  const unknown = await refusal(() => resolveAgentsSection(root, { projectRoot: project, id: "rule:nothing", action: "overwrite", occurredAt: at() }));
  assert.equal(unknown.reasonCode, "MANAGED_SECTION_ACTION_INVALID");
  const absent = await refusal(() => resolveAgentsSection(root, { projectRoot: project, id: "rule:autonomy", action: "keep", occurredAt: at() }));
  assert.deepEqual([absent.reasonCode, absent.details.file, absent.details.section], ["MANAGED_SECTION_NOT_FOUND", AGENTS_FILE, "rule:autonomy"]);

  // Overwriting a section that still reads as the engine wrote it changes nothing.
  const same = await resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "overwrite", backupRoot: backups, occurredAt: at() });
  assert.deepEqual([same.change.result, same.change.written, same.change.recordChanged], ["unchanged", false, false]);
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): the rule sections of AGENTS.md stand in
// the rules' order. They are arranged across the places rule sections already hold, so the text
// around them never moves.
const ruleSectionIds = (text) => parseManagedFile(text).sections.map((section) => section.id).filter((id) => id.startsWith("rule:"));

test("508-R7: agents-render arranges the rule sections by order across the places they hold, and moves no byte around them", async (context) => {
  const paths = await scratch(context);
  const agents = join(paths.project, AGENTS_FILE);
  await writeFile(agents, USER_TEXT);
  const root = await library(paths.base);
  const record = (key, value) => setConfigRecord(root, { collection: "rule", key, value, occurredAt: at() });
  const render = () => renderAgentsSections(root, { projectRoot: paths.project, navigation: null, backupRoot: paths.backups, occurredAt: at() });
  // Each rule is recorded at the version this engine ships: the case is about order, not version
  // (a rule recorded at a lower version reads update-available, and agents-render does not write it).
  const shipped = (key) => builtInRule(key).version;
  await record("autonomy", { enabled: true, version: shipped("autonomy"), order: 3 });
  await record("batch", { enabled: true, version: shipped("batch"), order: 1 });
  await record("unattended-commands", { enabled: true, version: shipped("unattended-commands") });
  await render();
  const created = await readFile(agents, "utf8");
  assert.deepEqual(ruleSectionIds(created), ["rule:batch", "rule:autonomy", "rule:unattended-commands"], "by order, then the rule without one");

  // The user writes between two rule sections, and the orders change.
  const endOfBatch = "<!-- einzbern:section-end id=rule:batch -->\n";
  const withNotes = created.replace(endOfBatch, `${endOfBatch}\n## Between\n\nNotes the engine never moves.\n`);
  assert.notEqual(withNotes, created);
  await writeFile(agents, withNotes);
  await record("autonomy", { enabled: true, version: shipped("autonomy"), order: 1 });
  await record("batch", { enabled: true, version: shipped("batch"), order: 2 });
  const result = await render();
  assert.equal(result.files.find((file) => file.file === AGENTS_FILE).written, true);
  assert.deepEqual(result.sections.filter((section) => section.id.startsWith("rule:")).map((section) => section.result), ["unchanged", "unchanged", "unchanged"], "no section's text is rewritten");
  const arranged = await readFile(agents, "utf8");
  assert.deepEqual(ruleSectionIds(arranged), ["rule:autonomy", "rule:batch", "rule:unattended-commands"]);
  assert.deepEqual(parseManagedFile(arranged).outside, parseManagedFile(withNotes).outside, "the text around the sections is where it was, byte for byte");
  for (const id of ruleSectionIds(created)) assert.equal(sectionOf(arranged, id).raw, sectionOf(withNotes, id).raw, `${id} moved whole`);
  assert.equal((await render()).files.find((file) => file.file === AGENTS_FILE).written, false, "a second render finds them in order");
});

test("508-R7: orderRuleSections leaves a plan alone while no rule holds an order, and gives a section moved off the last line its line ending", () => {
  const autonomy = renderSection({ id: "rule:autonomy", rev: 1, body: "Autonomy.\n" });
  const batch = renderSection({ id: "rule:batch", rev: 1, body: "Batch.\n" });
  const text = `${USER_TEXT}\n${batch}\n${autonomy.slice(0, -1)}`;
  const plan = { filePath: AGENTS_FILE, file: AGENTS_FILE, exists: true, before: text, after: null, write: false, sections: [], pending: [] };
  assert.equal(orderRuleSections(plan, new Map()), plan, "without an order the plan is as it was");
  assert.equal(orderRuleSections(plan, new Map([["batch", 1]])), plan, "a file already in order is not written");
  const ordered = orderRuleSections(plan, new Map([["autonomy", 1]]));
  assert.deepEqual([ordered.write, ordered.before, ordered.after], [true, text, `${USER_TEXT}\n${autonomy}\n${batch}`]);
});

// TCRN-CROSS-STORY-508 R8, AC7 (MIN-236 D8; TCRN-CROSS-SUB-407): the system section a render writes into
// AGENTS.md is the engine's text for it, with the categories, the tiers in order, the three escalation
// settings and design.authority, and it names no absolute path, not even the project's or the library's.
test("508-AC7 via the render: the system section in AGENTS.md holds the categories, the tiers in order, the escalation settings and design.authority, and no absolute path", async (context) => {
  const { base, project, backups } = await scratch(context);
  const root = await library(base);
  await setWorkspaceSetting(root, { key: "models.escalation.threshold", value: "2", occurredAt: at() });
  await setWorkspaceSetting(root, { key: "models.escalation.ceiling", value: "flagship", occurredAt: at() });
  const rendered = await renderAgentsSections(root, { projectRoot: project, navigation: "declined", backupRoot: backups, occurredAt: at() });
  assert.deepEqual(rendered.withheld, []);
  const text = await readFile(join(project, AGENTS_FILE), "utf8");
  const system = sectionOf(text, "variables-system");
  assert.equal(system.body, engineSectionBody(rendered.state, "variables-system"), "the file holds the engine's text");
  assert.deepEqual(system.body.match(/^### .+$/gmu), ["### models.category", "### models.tiers", "### models.escalation", "### design.authority"]);
  const lines = system.body.split("\n");
  for (const line of [
    "| 10 | flagship | flagship |  |",
    "| 30 | economy | economy |  |",
    "| 60 | economy | claude-code | (unset) | (unset) |  |",
    "| models.escalation.enabled | true |",
    "| models.escalation.threshold | 2 |",
    "| models.escalation.ceiling | flagship |",
  ]) assert.ok(lines.includes(line), line);
  const tiers = lines.slice(lines.indexOf("### models.tiers"), lines.indexOf("### models.escalation"));
  const tierOrders = tiers.filter((line) => /^\| [0-9]+ \| /u.test(line)).map((line) => Number(line.split(" | ")[0].slice(2)));
  assert.deepEqual(tierOrders, [10, 20, 30, 40, 50, 60], "the tiers in ascending order");
  assert.match(system.body, /^### design\.authority\n\nConfiguration target: library defaults\./mu);
  assert.match(system.body, /Design bindings: unconfigured\. Production publication: unverified/);
  assert.match(system.body, /\| design\.authority \| \(unconfigured\) \| default \| false \|/);
  assert.equal(absolutePathLine(system.body), null);
  assert.equal(text.includes(base), false, "no path of this machine appears in AGENTS.md");
});

// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366, R17 continuation revision three): an entry point that
// wrote a file and then cannot commit the section records puts back every file it wrote, as it read
// it, and throws the error that stopped it; the library holds no new event. The commit is refused
// here the way a library near its view budget refuses it (viewBudgetBytes narrows that budget), and
// that refusal comes after the files were written.
const OVER_BUDGET = Object.freeze({ viewBudgetBytes: 1 });

async function libraryHead(root) {
  const { version, headEventHash } = await materializeWorkspace(root);
  return { version, headEventHash };
}

async function textOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

test("489: a render whose records cannot be committed puts both files back as they were read", async (context) => {
  const paths = await scratch(context);
  const agentsPath = join(paths.project, AGENTS_FILE);
  const claudePath = join(paths.project, CLAUDE_FILE);
  await writeFile(agentsPath, USER_TEXT);
  const root = await library(paths.base);
  await setVariable(root, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const render = (options = {}) => renderAgentsSections(root, { projectRoot: paths.project, navigation: "written", backupRoot: paths.backups, occurredAt: at(), ...options });

  const empty = await libraryHead(root);
  const refused = await refusal(() => render(OVER_BUDGET));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", "the error that stopped the commit is the one thrown");
  assert.equal(await readFile(agentsPath, "utf8"), USER_TEXT, "AGENTS.md holds what it held");
  assert.equal(await textOrNull(claudePath), null, "the CLAUDE.md the render created is taken away");
  assert.deepEqual(await libraryHead(root), empty, "the library holds no new event");

  // The normal path is as it was: the same render, committed, creates the four sections and records them.
  const created = await render();
  assert.deepEqual(created.sections.map((section) => [section.id, section.result]), [
    ["navigation", "create"],
    ["variables-system", "create"],
    ["variables-custom", "create"],
    ["claude-import", "create"],
  ]);
  assert.equal(created.recorded, 4);

  // A replace that cannot be recorded leaves the section as its record says, so the next render does not take it for the user's change.
  const written = await readFile(agentsPath, "utf8");
  const recorded = await records(root);
  await setVariable(root, { name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
  const head = await libraryHead(root);
  const again = await refusal(() => render(OVER_BUDGET));
  assert.equal(again.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.equal(await readFile(agentsPath, "utf8"), written, "AGENTS.md holds the sections the library recorded");
  assert.deepEqual([await records(root), await libraryHead(root)], [recorded, head], "the records and the library are as they were");
  const replaced = await render();
  assert.deepEqual(replaced.pending, [], "no section waits for a change the user never made");
  assert.equal(replaced.sections.find((section) => section.id === "variables-custom").result, "replace");
  assert.match(sectionOf(await readFile(agentsPath, "utf8"), "variables-custom").body, /^\| deploy\.port \| number \| 8443 \|  \|$/mu);
});

test("489: a disposition whose record cannot be committed leaves the section as the user left it", async (context) => {
  const { root, project, backups, path, edited } = await pendingProject(context);
  const waiting = await records(root);
  const head = await libraryHead(root);
  for (const action of ["overwrite", "unmanage"]) {
    const error = await refusal(() => resolveAgentsSection(root, { projectRoot: project, id: "navigation", action, backupRoot: backups, occurredAt: at(), ...OVER_BUDGET }));
    assert.equal(error.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED", action);
    assert.equal(await readFile(path, "utf8"), edited, `${action}: the file is as the user left it`);
    assert.deepEqual([await records(root), await libraryHead(root)], [waiting, head], `${action}: the section still waits, and the library holds no new event`);
  }
  const { change } = await resolveAgentsSection(root, { projectRoot: project, id: "navigation", action: "overwrite", backupRoot: backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written, change.record.rev, change.record.state], ["overwritten", true, 2, "managed"]);
  assert.equal(sectionOf(await readFile(path, "utf8"), "navigation").body, NAVIGATION_SECTION.body);
});

test("489: a disable whose record cannot be removed puts the section back, and the next disable takes it out", async (context) => {
  const { root, project, backups } = await renderedProject(context);
  const path = join(project, AGENTS_FILE);
  const written = await readFile(path, "utf8");
  const recorded = await records(root);
  const head = await libraryHead(root);
  const error = await refusal(() => disableAgentsSection(root, { projectRoot: project, id: "navigation", backupRoot: backups, occurredAt: at(), ...OVER_BUDGET }));
  assert.equal(error.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.equal(await readFile(path, "utf8"), written, "the section is back in the file, markers and all");
  assert.deepEqual([await records(root), await libraryHead(root)], [recorded, head], "its record stays, and the library holds no new event");
  const { change } = await disableAgentsSection(root, { projectRoot: project, id: "navigation", backupRoot: backups, occurredAt: at() });
  assert.deepEqual([change.result, change.written, change.record], ["disabled", true, null]);
  assert.equal(sectionOf(await readFile(path, "utf8"), "navigation"), null);
});

test("489: records that went in before the failure (a crash after the event commit) keep the files as written", async (context) => {
  const paths = await scratch(context);
  const agentsPath = join(paths.project, AGENTS_FILE);
  await writeFile(agentsPath, USER_TEXT);
  const root = await library(paths.base);
  const head = await libraryHead(root);
  const render = (options = {}) => renderAgentsSections(root, { projectRoot: paths.project, navigation: "written", backupRoot: paths.backups, occurredAt: at(), ...options });
  const error = await refusal(() => render({ crashAt: "after-event-commit" }));
  assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED");
  assert.notDeepEqual(await libraryHead(root), head, "the records went in");
  assert.deepEqual((await records(root)).map((record) => record.id).sort(), ["navigation", "variables-custom", "variables-system"]);
  assert.notEqual(await readFile(agentsPath, "utf8"), USER_TEXT, "so the sections stay where they were written");
  assert.notEqual(await textOrNull(join(paths.project, CLAUDE_FILE)), null);
  const again = await render();
  assert.deepEqual([again.pending, again.recorded, again.files.some((file) => file.written)], [[], 0, false], "the files and the records agree");
});

test("489: a render stopped at its second file takes back the first", async (context) => {
  const paths = await scratch(context);
  const claudePath = join(paths.project, CLAUDE_FILE);
  await writeFile(claudePath, USER_TEXT);
  const root = await library(paths.base);
  const head = await libraryHead(root);
  // CLAUDE.md is the one file with an original to back up, and its backup would go under a regular file.
  const blocked = join(paths.base, "backups-are-a-file");
  await writeFile(blocked, "");
  await refusal(() => renderAgentsSections(root, { projectRoot: paths.project, navigation: "written", backupRoot: blocked, occurredAt: at() }));
  assert.equal(await textOrNull(join(paths.project, AGENTS_FILE)), null, "the AGENTS.md the render created is taken away");
  assert.equal(await readFile(claudePath, "utf8"), USER_TEXT);
  assert.deepEqual(await libraryHead(root), head, "the library holds no new event");
});

// TCRN-CROSS-STORY-540 GWT1 (TCRN-CROSS-SUB-505): a project root within its library is refused with a
// reason code of its own, before anything is read or written; a coordination library's roots are
// covered in coordination-managed-sections.test.mjs.
test("540-GWT1: a project root within the library is refused with MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY", async (context) => {
  const paths = await scratch(context);
  const root = await library(paths.base);
  const before = await materializeWorkspace(root);
  const inner = join(root, (await readdir(root, { withFileTypes: true })).find((entry) => entry.isDirectory()).name);
  for (const projectRoot of [root, inner]) {
    const refused = await refusal(() => renderAgentsSections(root, { projectRoot, navigation: null, backupRoot: paths.backups, occurredAt: at() }));
    assert.equal(refused.reasonCode, "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY", projectRoot);
    assert.match(refused.message, /managed prose cannot be written inside a library/u);
    await assert.rejects(readFile(join(projectRoot, AGENTS_FILE)), { code: "ENOENT" });
  }
  assert.equal((await materializeWorkspace(root)).headEventHash, before.headEventHash, "a refusal records nothing");
});
