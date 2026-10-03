// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-483 R2, AC1, AC2, AC4 through the CLI (MIN-228 D3, MIN-229 D6;
// TCRN-CROSS-SUB-337): rule-list, rule-enable and rule-disable, beside agents-render and
// rule-resolve (STORY-478), on the project this device's registry resolves. Enabling batch
// processing writes its v3 text into AGENTS.md and the rule reads enabled (AC1); a section changed
// by one character reads user-modified (AC2); a write refused over that change reads pending, and
// after rule-resolve keep neither rule-enable nor agents-render writes the section (AC4). Disabling
// a changed section needs --force true. agents-render keeps an enabled rule's section in the
// project's artifact language and leaves one the catalog has a newer version of as it is.
// TCRN-CROSS-STORY-513 R1, AC1 (MIN-238 D2; TCRN-CROSS-SUB-422): rule-enable and rule-disable run
// for Atelier only; a model's run is refused with MODEL_WRITE_REFUSED and appends nothing, while
// rule-list, rule-resolve and agents-render answer it.
// Everything here is temporary: a project, its library and a device directory.

import "./helpers/device-home.mjs";
import { ATELIER_SURFACE, standInForAtelier, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, MODEL_WRITE_REMEDY, SURFACE_ENVIRONMENT_VARIABLE, runCli } from "../dist/build/packages/cli/src/index.js";
import { setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import { parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import { BUILT_IN_RULES, builtInRule } from "../dist/build/packages/core/src/rules-catalog.js";
import { enableRule } from "../dist/build/packages/core/src/rules.js";
import { materializeWorkspace, setWorkspaceSetting } from "../dist/build/packages/core/src/workspace.js";

// TCRN-CROSS-STORY-513 R1: these tests switch rules through the CLI, as Atelier does; a model's shell
// is withSurface(undefined, ...).
standInForAtelier();

const repositoryRoot = resolve(import.meta.dirname, "..");
const ENTRY = join(repositoryRoot, "scripts/einzbern.mjs");
const fixtures = join(repositoryRoot, "tests", "fixtures", "rules");
const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 11, 0, second)).toISOString().replace(".000Z", "Z");
};

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  throw new Error(`${args[0]} was expected to refuse`);
}

/** The shipped entry, run as a host would run it: its exit code, stdout and the refusal on stderr. */
function shipped(args, { device, cwd = repositoryRoot, env = {} }) {
  const run = spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env, EINZBERN_HOME: device } });
  return { status: run.status, stdout: run.stdout, refusal: run.stderr.trim() === "" ? null : JSON.parse(run.stderr.trim()) };
}

/** A registered project with an AGENTS.md of the user's own and its library in .ether, writing its artifacts in `language`. */
async function scratch(context, language = "zh-CN") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-rules-cli-")));
  const previous = process.env.EINZBERN_HOME;
  const device = join(base, "device");
  process.env.EINZBERN_HOME = device;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const project = join(base, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), USER_TEXT);
  const library = join(project, ".ether");
  assert.equal((await cli(["init", "--workspace", library, "--at", at(), "--project", project])).reasonCode, "LIBRARY_CREATED");
  const created = await cli(["project-create", "--workspace", library, "--external-key", "rules-project", "--name", "Rules project", "--at", at()]);
  await cli(["library-register", "--library", library, "--project", project, "--project-id", created.record.id, "--at", at()]);
  // The setting is written as Atelier writes it; a model's settings-set is refused (STORY-484 R4).
  if (language !== null) await setWorkspaceSetting(library, { key: "artifact.language", value: language, occurredAt: at() });
  return { base, device, project, library, agents: join(project, "AGENTS.md") };
}

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

const list = async (project) => cli(["rule-list", "--project", project]);
const ruleOf = async (project, id) => { const { source, ...rule } = (await list(project)).rules.find((rule) => rule.id === id); assert.ok(source === null || source.projectId, "the read retains configuration provenance"); return rule; };
const enable = (project, id) => cli(["rule-enable", "--project", project, "--id", id, "--at", at()]);
const render = (project) => cli(["agents-render", "--project", project, "--at", at()]);

test("483-AC1 via rule-enable: batch processing's v3 text goes into AGENTS.md, the rule reads enabled, and the receipt names the backup", async (context) => {
  const { device, project, library, agents } = await scratch(context);
  const before = await list(project);
  assert.deepEqual([before.reasonCode, before.schemaVersion, before.projectPath, before.libraryPath], ["RULE_LIST_READY", "einzbern.rule-list.v1", project, library]);
  assert.deepEqual(before.rules.map((rule) => [rule.id, rule.version, rule.state]), BUILT_IN_RULES.map((rule) => [rule.id, rule.version, "disabled"]));

  const enabled = await enable(project, "batch");
  assert.equal(enabled.reasonCode, "RULE_ENABLED");
  const { source: enabledSource, ...enabledRule } = enabled.rule;
  const enabledRead = await list(project);
  assert.equal(enabledRead.rules.find(rule=>rule.id==="batch").source.projectId, enabledRead.projectId);
  assert.deepEqual(enabledRule, { id: "batch", version: 3, recordedVersion: 3, fileVersion: 1, section: "rule:batch", state: "enabled" });
  assert.deepEqual([enabled.section, enabled.file, enabled.action, enabled.result, enabled.written, enabled.recorded], ["rule:batch", "AGENTS.md", "enable", "create", true, 2]);
  // STORY-467 receipts name global records; `section` above remains the local section id.
  const projectId = (await list(project)).projectId;
  assert.deepEqual([...enabled.ids].sort(), [`managed-section:${projectId}:AGENTS.md#rule:batch`, `rule:${projectId}:batch`]);
  assert.equal(enabled.backupDir.startsWith(join(device, "backups")), true, "the backup is in the device directory");
  assert.equal(enabled.backupPath, join(enabled.backupDir, "AGENTS.md"));
  assert.equal(await readFile(enabled.backupPath, "utf8"), USER_TEXT, "AGENTS.md was backed up before it was replaced");
  const text = await readFile(agents, "utf8");
  assert.equal(text.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
  assert.equal(sectionOf(text, "rule:batch").body, await readFile(join(fixtures, "batch.zh.md"), "utf8"), "the section holds the v3 text");
  assert.deepEqual(await ruleOf(project, "batch"), enabledRule);

  // agents-render renders the enabled rule's section with the others and leaves it as it is.
  const rendered = await render(project);
  assert.deepEqual(rendered.sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "unchanged", state: "managed" });
  assert.equal(sectionOf(await readFile(agents, "utf8"), "rule:batch").raw, sectionOf(text, "rule:batch").raw);

  // In another artifact language agents-render writes the rule's text in that language.
  await setWorkspaceSetting(library, { key: "artifact.language", value: "en", occurredAt: at() });
  const english = await render(project);
  assert.deepEqual(english.sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "replace", state: "managed" });
  const section = sectionOf(await readFile(agents, "utf8"), "rule:batch");
  assert.deepEqual([section.body, section.rev], [builtInRule("batch").body.en, 2]);
  assert.deepEqual(await ruleOf(project, "batch"), { id: "batch", version: 3, recordedVersion: 3, fileVersion: 2, section: "rule:batch", state: "enabled" });
});

test("483-AC2 via rule-list: a section changed by one character reads user-modified, and listing writes nothing", async (context) => {
  const { device, project, agents } = await scratch(context);
  await enable(project, "batch");
  const written = await readFile(agents, "utf8");
  const edited = written.replace("批的单位", "批的单元");
  assert.equal(edited.length, written.length);
  await writeFile(agents, edited);
  assert.deepEqual(await ruleOf(project, "batch"), { id: "batch", version: 3, recordedVersion: 3, fileVersion: 1, section: "rule:batch", state: "user-modified" });
  assert.equal(await readFile(agents, "utf8"), edited);

  // Run from inside the project without --project, the registry finds it all the same.
  const inside = shipped(["rule-list"], { device, cwd: join(project, "src") });
  assert.equal(inside.status, 0, JSON.stringify(inside.refusal));
  const listed = JSON.parse(inside.stdout);
  assert.equal(listed.projectPath, project);
  assert.equal(listed.rules.find((rule) => rule.id === "batch").state, "user-modified");
  assert.equal(await readFile(agents, "utf8"), edited);
});

test("483-AC4 via rule-enable and rule-resolve: a refused write reads pending; after keep, neither rule-enable nor agents-render writes the section", async (context) => {
  const { project, agents } = await scratch(context);
  await enable(project, "batch");
  const edited = (await readFile(agents, "utf8")).replace("批的单位", "批的单元");
  await writeFile(agents, edited);

  const refused = await enable(project, "batch");
  assert.deepEqual([refused.reasonCode, refused.result, refused.written, refused.backupDir, refused.rule.state], ["RULE_ENABLED", "refused-user-modified", false, null, "pending"]);
  assert.deepEqual(refused.ids, [`managed-section:${(await list(project)).projectId}:AGENTS.md#rule:batch`]);
  assert.equal((await ruleOf(project, "batch")).state, "pending");
  assert.deepEqual((await render(project)).pending, [{ id: "rule:batch", file: "AGENTS.md" }]);
  const afterRender = await readFile(agents, "utf8");
  assert.equal(sectionOf(afterRender, "rule:batch").raw, sectionOf(edited, "rule:batch").raw, "the changed section is byte for byte what the user left");

  const kept = await cli(["rule-resolve", "--project", project, "--section", "rule:batch", "--action", "keep", "--at", at()]);
  assert.deepEqual([kept.reasonCode, kept.result, kept.state, kept.written], ["MANAGED_SECTION_RESOLVED", "kept", "user-owned", false]);
  assert.equal((await ruleOf(project, "batch")).state, "user-modified", "the kept text is the user's");

  const again = await enable(project, "batch");
  assert.deepEqual([again.result, again.written, again.recorded, again.rule.state], ["unchanged", false, 0, "user-modified"]);
  const rendered = await render(project);
  assert.deepEqual(rendered.sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "unchanged", state: "user-owned" });
  assert.deepEqual([rendered.pending, rendered.recorded, rendered.files.some((file) => file.written)], [[], 0, false]);
  assert.equal(await readFile(agents, "utf8"), afterRender, "the kept section is never written again");
});

test("483-R2 via rule-disable: a changed section goes only with --force true, and the refusal names the file and the section", async (context) => {
  const { device, project, agents } = await scratch(context);
  await enable(project, "batch");
  const edited = (await readFile(agents, "utf8")).replace("批的单位", "批的单元");
  await writeFile(agents, edited);

  const refused = shipped(["rule-disable", "--project", project, "--id", "batch", "--at", at()], { device });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.deepEqual([refused.refusal.reasonCode, refused.refusal.file, refused.refusal.section], ["MANAGED_SECTION_FORCE_REQUIRED", "AGENTS.md", "rule:batch"]);
  assert.equal(await readFile(agents, "utf8"), edited, "a refused disable writes nothing");
  assert.equal((await ruleOf(project, "batch")).state, "user-modified");

  const forced = await cli(["rule-disable", "--project", project, "--id", "batch", "--force", "true", "--at", at()]);
  assert.deepEqual([forced.reasonCode, forced.action, forced.result, forced.written, forced.recorded], ["RULE_DISABLED", "disable", "disabled", true, 2]);
  assert.deepEqual(forced.rule, { id: "batch", version: 3, recordedVersion: 3, fileVersion: null, section: "rule:batch", state: "disabled" });
  assert.equal(await readFile(join(forced.backupDir, "AGENTS.md"), "utf8"), edited, "the user's version is backed up first");
  assert.equal(await readFile(agents, "utf8"), USER_TEXT);

  // A disabled rule is not rendered, and disabling it again changes nothing.
  assert.equal((await render(project)).sections.some((section) => section.id === "rule:batch"), false);
  const again = await cli(["rule-disable", "--project", project, "--id", "batch", "--at", at()]);
  assert.deepEqual([again.result, again.written, again.recorded, again.backupDir], ["unchanged", false, 0, null]);
});

test("483-R2, R3: the rule verbs' refusals, and a rule recorded at another version than the engine ships", async (context) => {
  const { base, project, library, agents } = await scratch(context);
  assert.deepEqual([(await refusal(["rule-enable", "--project", project, "--id", "nothing", "--at", at()])).reasonCode], ["RULE_UNKNOWN"]);
  assert.equal((await refusal(["rule-disable", "--project", project, "--id", "nothing", "--at", at()])).reasonCode, "RULE_UNKNOWN");
  assert.equal((await refusal(["rule-enable", "--project", project, "--at", at()])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["rule-disable", "--project", project, "--id", "batch"])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["rule-disable", "--project", project, "--id", "batch", "--force", "maybe", "--at", at()])).reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await refusal(["rule-enable", "--project", project, "--id", "batch", "--force", "true", "--at", at()])).reasonCode, "CLI_ARGUMENT_UNKNOWN");
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  assert.equal((await refusal(["rule-list", "--project", elsewhere])).reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal(await readFile(agents, "utf8"), USER_TEXT, "no refusal wrote anything");

  // Enabled while an older engine shipped batch processing v1 (the catalog handed to core below):
  // the rule reads update-available, and agents-render leaves its section byte for byte until
  // rule-enable takes the new version.
  const v1 = await readFile(join(fixtures, "batch-v1.zh.md"), "utf8");
  const older = BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, version: 1, body: { zh: v1, en: v1 } });
  await enableRule({ libraryRoot: library, projectRoot: project, id: "batch", occurredAt: at(), catalog: older, configurationProjectId: (await list(project)).projectId });
  const first = await render(project);
  assert.deepEqual(first.sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "unchanged", state: "managed" });
  const settled = await readFile(agents, "utf8");
  assert.equal(sectionOf(settled, "rule:batch").body, v1, "the v1 text stays");
  assert.deepEqual(await ruleOf(project, "batch"), { id: "batch", version: 3, recordedVersion: 1, fileVersion: 1, section: "rule:batch", state: "update-available" });
  const rendered = await render(project);
  assert.deepEqual([rendered.recorded, rendered.files.some((file) => file.written)], [0, false]);
  assert.equal(await readFile(agents, "utf8"), settled, "the file is byte for byte what it was");
  const updated = await enable(project, "batch");
  assert.deepEqual([updated.result, updated.recorded, updated.rule.state, updated.rule.recordedVersion, updated.rule.fileVersion], ["replace", 2, "enabled", 3, 2]);
  assert.equal(sectionOf(await readFile(agents, "utf8"), "rule:batch").body, await readFile(join(fixtures, "batch.zh.md"), "utf8"));
  const current = await readFile(agents, "utf8");

  // Recorded at a newer version by a newer engine: this one refuses to write its older text.
  await setConfigRecord(library, { collection: "rule", key: "batch", value: { enabled: true, version: 4 }, projectId: (await list(project)).projectId, occurredAt: at() });
  assert.equal((await refusal(["rule-enable", "--project", project, "--id", "batch", "--at", at()])).reasonCode, "RULE_VERSION_NEWER");
  assert.deepEqual((await render(project)).sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "unchanged", state: "managed" });
  assert.equal(await readFile(agents, "utf8"), current);
});

test("INIT-053 AC2: v2 through CLI: the rule verbs' refusals, and a rule recorded at another version than the engine ships", async (context) => {
  const { base, project, library, agents } = await scratch(context);
  assert.deepEqual([(await refusal(["rule-enable", "--project", project, "--id", "nothing", "--at", at()])).reasonCode], ["RULE_UNKNOWN"]);
  assert.equal((await refusal(["rule-disable", "--project", project, "--id", "nothing", "--at", at()])).reasonCode, "RULE_UNKNOWN");
  assert.equal((await refusal(["rule-enable", "--project", project, "--at", at()])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["rule-disable", "--project", project, "--id", "batch"])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["rule-disable", "--project", project, "--id", "batch", "--force", "maybe", "--at", at()])).reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal((await refusal(["rule-enable", "--project", project, "--id", "batch", "--force", "true", "--at", at()])).reasonCode, "CLI_ARGUMENT_UNKNOWN");
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  assert.equal((await refusal(["rule-list", "--project", elsewhere])).reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal(await readFile(agents, "utf8"), USER_TEXT, "no refusal wrote anything");

  // Enabled while an older engine shipped batch processing v2 (the catalog handed to core below):
  // the rule reads update-available, and agents-render leaves its section byte for byte until
  // rule-enable takes the new version.
  const v2 = await readFile(join(fixtures, "batch-v2.zh.md"), "utf8");
  const older = BUILT_IN_RULES.map((rule) => rule.id !== "batch" ? rule : { ...rule, version: 2, body: { zh: v2, en: v2 } });
  await enableRule({ libraryRoot: library, projectRoot: project, id: "batch", occurredAt: at(), catalog: older, configurationProjectId: (await list(project)).projectId });
  const first = await render(project);
  assert.deepEqual(first.sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "unchanged", state: "managed" });
  const settled = await readFile(agents, "utf8");
  assert.equal(sectionOf(settled, "rule:batch").body, v2, "the v2 text stays");
  assert.deepEqual(await ruleOf(project, "batch"), { id: "batch", version: 3, recordedVersion: 2, fileVersion: 1, section: "rule:batch", state: "update-available" });
  const rendered = await render(project);
  assert.deepEqual([rendered.recorded, rendered.files.some((file) => file.written)], [0, false]);
  assert.equal(await readFile(agents, "utf8"), settled, "the file is byte for byte what it was");
  const updated = await enable(project, "batch");
  assert.deepEqual([updated.result, updated.recorded, updated.rule.state, updated.rule.recordedVersion, updated.rule.fileVersion], ["replace", 2, "enabled", 3, 2]);
  assert.equal(sectionOf(await readFile(agents, "utf8"), "rule:batch").body, await readFile(join(fixtures, "batch.zh.md"), "utf8"));
  const current = await readFile(agents, "utf8");

  // Recorded at a newer version by a newer engine: this one refuses to write its older text.
  await setConfigRecord(library, { collection: "rule", key: "batch", value: { enabled: true, version: 4 }, projectId: (await list(project)).projectId, occurredAt: at() });
  assert.equal((await refusal(["rule-enable", "--project", project, "--id", "batch", "--at", at()])).reasonCode, "RULE_VERSION_NEWER");
  assert.deepEqual((await render(project)).sections.find((section) => section.id === "rule:batch"), { id: "rule:batch", file: "AGENTS.md", result: "unchanged", state: "managed" });
  assert.equal(await readFile(agents, "utf8"), current);
});

// TCRN-CROSS-STORY-508 R7 (MIN-236 D7; TCRN-CROSS-SUB-408): rule-enable --order.
test("508-R7 via rule-enable --order: the rule's section takes its place, rule-list shows the order, and a malformed order is refused", async (context) => {
  const { project, agents } = await scratch(context);
  assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === "rule-enable").flags.find((flag) => flag.name === "order"), { name: "order", required: false, valueKind: "integer" });
  const ruleSections = async () => parseManagedFile(await readFile(agents, "utf8")).sections.map((section) => section.id).filter((id) => id.startsWith("rule:"));
  await enable(project, "batch");
  await enable(project, "autonomy");
  assert.deepEqual(await ruleSections(), ["rule:batch", "rule:autonomy"]);

  const ordered = await cli(["rule-enable", "--project", project, "--id", "autonomy", "--order", "1", "--at", at()]);
  assert.deepEqual(ordered.rule, { id: "autonomy", version: 1, recordedVersion: 1, fileVersion: 1, section: "rule:autonomy", state: "enabled", order: 1 });
  assert.deepEqual([ordered.result, ordered.written, ordered.recorded], ["unchanged", true, 1]);
  assert.deepEqual(await ruleSections(), ["rule:autonomy", "rule:batch"]);
  const listed = await list(project);
  assert.deepEqual(listed.rules.map((rule) => [rule.id, rule.order ?? null]), [["autonomy", 1], ["batch", null], ["unattended-commands", null], ["silent-reporting", null], ["design-authority", null]]);

  // agents-render keeps the arrangement.
  await render(project);
  assert.deepEqual(await ruleSections(), ["rule:autonomy", "rule:batch"]);

  const before = await readFile(agents, "utf8");
  for (const order of ["0", "1.5", "first"]) {
    const refused = await refusal(["rule-enable", "--project", project, "--id", "batch", "--order", order, "--at", at()]);
    assert.deepEqual([refused.reasonCode, refused.message], ["CLI_ARGUMENT_MALFORMED", "order"], order);
  }
  assert.equal(await readFile(agents, "utf8"), before, "a malformed order writes nothing");
});

// TCRN-CROSS-STORY-513 R1, AC1 (MIN-238 D2, MIN-235 D11; TCRN-CROSS-SUB-422): a model runs the CLI
// from its shell, where EINZBERN_SURFACE is not atelier, so it neither switches a Command Spell rule
// on or off nor reorders one. Its rule-enable and rule-disable are refused with MODEL_WRITE_REFUSED
// and the remedy of changing it in Atelier before the rule or the project is looked up: no event, no
// file and no backup. The same runs for Atelier write. rule-list, agents-render and rule-resolve
// answer a model.
test("513-AC1 via rule-enable and rule-disable: a model's run is refused with the remedy and changes nothing; Atelier's run writes; rule-list, agents-render and rule-resolve are not refused", async (context) => {
  const { device, project, library, agents } = await scratch(context);
  await enable(project, "batch");
  const asModel = (operation) => withSurface(undefined, operation);
  const versionOf = async () => (await materializeWorkspace(library)).version;
  const backups = () => readdir(join(device, "backups"));
  const before = { version: await versionOf(), text: await readFile(agents, "utf8"), rules: (await list(project)).rules, backups: await backups() };
  const writes = [
    [() => ["rule-enable", "--project", project, "--id", "autonomy", "--at", at()], "autonomy"],
    [() => ["rule-enable", "--project", project, "--id", "batch", "--order", "1", "--at", at()], "batch"],
    [() => ["rule-disable", "--project", project, "--id", "batch", "--at", at()], "batch"],
    [() => ["rule-disable", "--project", project, "--id", "batch", "--force", "true", "--at", at()], "batch"],
  ];
  // Only the exact surface name lets a write through.
  for (const surface of [undefined, "", "Atelier", "atelier ", "portal"]) {
    for (const [argv, rule] of writes) {
      const args = argv();
      const error = await withSurface(surface, () => refusal(args));
      assert.equal(error.reasonCode, "MODEL_WRITE_REFUSED", `${args.join(" ")} with EINZBERN_SURFACE=${String(surface)}`);
      assert.deepEqual({ ...error.details }, { rule, remedy: MODEL_WRITE_REMEDY });
      assert.equal(error.message, `rule ${rule} is changed in Atelier; a model does not write it through the CLI`);
    }
  }
  // The refusal comes before the rule is looked up: an unknown rule is refused the same way.
  const unknown = await asModel(() => refusal(["rule-enable", "--project", project, "--id", "nothing", "--at", at()]));
  assert.deepEqual([unknown.reasonCode, { ...unknown.details }], ["MODEL_WRITE_REFUSED", { rule: "nothing", remedy: MODEL_WRITE_REMEDY }]);

  // Through the shipped entry the refusal reaches stderr with its remedy, and a run carrying
  // EINZBERN_SURFACE=atelier, as Atelier's does, commits.
  const model = await asModel(async () => shipped(["rule-enable", "--project", project, "--id", "silent-reporting", "--at", at()], { device }));
  assert.deepEqual([model.status, model.stdout], [1, ""]);
  assert.deepEqual(model.refusal, { ok: false, reasonCode: "MODEL_WRITE_REFUSED", remedy: MODEL_WRITE_REMEDY, error: "rule silent-reporting is changed in Atelier; a model does not write it through the CLI" });
  assert.equal(await versionOf(), before.version, "no refused write appended an event");
  assert.equal(await readFile(agents, "utf8"), before.text, "no refused write touched AGENTS.md");
  assert.deepEqual(await backups(), before.backups, "no refused write backed a file up");
  assert.deepEqual((await asModel(() => list(project))).rules, before.rules, "a model reads the rules, unchanged");
  const atelier = await asModel(async () => shipped(["rule-enable", "--project", project, "--id", "silent-reporting", "--at", at()], { device, env: { [SURFACE_ENVIRONMENT_VARIABLE]: ATELIER_SURFACE } }));
  assert.equal(atelier.status, 0, JSON.stringify(atelier.refusal));
  const shippedReceipt = JSON.parse(atelier.stdout);
  assert.deepEqual([shippedReceipt.reasonCode, shippedReceipt.rule.id, shippedReceipt.rule.state], ["RULE_ENABLED", "silent-reporting", "enabled"]);

  // The same writes run for Atelier commit, in order.
  const receipts = [];
  for (const [argv] of writes) receipts.push(await cli(argv()));
  assert.deepEqual(receipts.map((receipt) => [receipt.reasonCode, receipt.rule.id, receipt.rule.state, receipt.rule.order ?? null]), [
    ["RULE_ENABLED", "autonomy", "enabled", null],
    ["RULE_ENABLED", "batch", "enabled", 1],
    ["RULE_DISABLED", "batch", "disabled", 1],
    ["RULE_DISABLED", "batch", "disabled", 1],
  ]);
  assert.equal(await versionOf(), before.version + shippedReceipt.recorded + receipts.reduce((sum, receipt) => sum + receipt.recorded, 0));

  // agents-render and rule-resolve settle and render sections; they answer a model.
  assert.equal((await asModel(() => render(project))).reasonCode, "AGENTS_RENDERED");
  const kept = await asModel(() => cli(["rule-resolve", "--project", project, "--section", "rule:autonomy", "--action", "keep", "--at", at()]));
  assert.deepEqual([kept.reasonCode, kept.result, kept.state], ["MANAGED_SECTION_RESOLVED", "kept", "user-owned"]);
});
