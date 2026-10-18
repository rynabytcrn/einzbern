// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-478 R3, AC1-AC3 through the CLI (MIN-227 D14, D17; TCRN-CROSS-SUB-318):
// agents-render renders the engine's sections into the AGENTS.md and CLAUDE.md of the project this
// device's registry resolves, against the library's records, and rule-resolve settles a section
// the user changed. A section changed by one character stays and goes pending while an untouched
// one is updated (AC1); a section deleted with its markers is not put back (AC2); markers that do
// not parse refuse the whole render with the line (AC3); after rule-resolve keep, agents-render
// never writes that section again. Everything here is temporary: a project, its library and a
// device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ATELIER_SURFACE, withSurface } from "./helpers/workspace-fixture.mjs";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { NAVIGATION_LINES } from "../dist/build/packages/core/src/agents-sections.js";
import { parseManagedFile, renderSection } from "../dist/build/packages/core/src/managed-sections.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ENTRY = join(repositoryRoot, "scripts/einzbern.mjs");
const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 27, 9, 0, second)).toISOString().replace(".000Z", "Z");
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
function shipped(args, { device, cwd = repositoryRoot }) {
  const run = spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: "utf8", env: { ...process.env, EINZBERN_HOME: device } });
  return { status: run.status, stdout: run.stdout, refusal: run.stderr.trim() === "" ? null : JSON.parse(run.stderr.trim()) };
}

/** A registered project with an AGENTS.md of the user's own and its library in .ether, on a device whose navigation choice is `navigation`. */
async function scratch(context, navigation = "written") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-agents-render-")));
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
  const projectId = (await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "AGENTS-EXPLICIT-PROJECT", "--name", "Managed fixture"])).record.id;
  await cli(["library-register", "--project", project, "--library", library, "--project-id", projectId, "--at", at()]);
  if (navigation !== null) await cli(["machine-settings-set", "--key", "agents.navigation", "--value", navigation, "--at", at()]);
  if (navigation !== "written") await withSurface(ATELIER_SURFACE, () => cli(["settings-set", "--workspace", library, "--key", "agents.sharedNavigation", "--value", "declined", "--at", at()]));
  return { base, device, project, projectId, library, agents: join(project, "AGENTS.md"), claude: join(project, "CLAUDE.md") };
}

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

const render = (project) => cli(["agents-render", "--project", project, "--at", at()]);

test("478-AC1 via agents-render: a section changed by one character stays as it is and goes pending, and an untouched one is updated", async (context) => {
  const { device, project, projectId, library, agents, claude } = await scratch(context);
  const first = await render(project);
  assert.equal(first.reasonCode, "AGENTS_RENDERED");
  assert.deepEqual(first.sections, [
    { id: "navigation", file: "AGENTS.md", result: "create", state: "managed" },
    { id: "variables-system", file: "AGENTS.md", result: "create", state: "managed" },
    { id: "variables-custom", file: "AGENTS.md", result: "create", state: "managed" },
    { id: "claude-import", file: "CLAUDE.md", result: "create", state: "managed" },
  ]);
  assert.deepEqual([first.pending, first.recorded, first.projectPath, first.libraryPath], [[], 4, project, library]);
  assert.deepEqual(first.navigation, { key: "agents.navigation", value: "written" });
  assert.deepEqual([...first.ids].sort(), [`managed-section:${projectId}:AGENTS.md#navigation`, `managed-section:${projectId}:AGENTS.md#variables-custom`, `managed-section:${projectId}:AGENTS.md#variables-system`, `managed-section:${projectId}:CLAUDE.md#claude-import`]);
  assert.deepEqual(first.files.map((file) => [file.file, file.written, file.backupPath === null]), [["AGENTS.md", true, false], ["CLAUDE.md", true, true]]);
  assert.equal(first.backupDir.startsWith(join(device, "backups")), true, "the backup is in the device directory");
  assert.equal(await readFile(join(first.backupDir, "AGENTS.md"), "utf8"), USER_TEXT, "AGENTS.md was backed up before it was replaced");
  const written = await readFile(agents, "utf8");
  assert.equal(written.startsWith(`${USER_TEXT}\n`), true, "the user's text stays where it was");
  assert.equal(sectionOf(written, "navigation").body, `${NAVIGATION_LINES.join("\n")}\n`);
  assert.equal(await readFile(claude, "utf8"), renderSection({ id: "claude-import", rev: 1, body: "@AGENTS.md\n" }), "a new CLAUDE.md holds the import section alone");

  // The user changes one character of the navigation section; the system variables change in the library.
  const edited = written.replace("Recall first:", "Recall frst:");
  assert.equal(edited.length, written.length - 1);
  await writeFile(agents, edited);
  const settingsArgs = ["settings-set", "--workspace", library, "--key", "design.authority", "--value", "https://design.example.com/system", "--at", at()];
  await assert.rejects(
    withSurface(undefined, () => cli(settingsArgs)),
    (error) => error.reasonCode === "MODEL_WRITE_REFUSED",
  );
  const settings = await withSurface(ATELIER_SURFACE, () => cli(settingsArgs));
  assert.equal(settings.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const next = await render(project);
  assert.deepEqual(next.sections, [
    { id: "navigation", file: "AGENTS.md", result: "refused-user-modified", state: "pending" },
    { id: "variables-system", file: "AGENTS.md", result: "replace", state: "managed" },
    { id: "variables-custom", file: "AGENTS.md", result: "unchanged", state: "managed" },
    { id: "claude-import", file: "CLAUDE.md", result: "unchanged", state: "managed" },
  ]);
  assert.deepEqual(next.pending, [{ id: "navigation", file: "AGENTS.md" }]);
  const after = await readFile(agents, "utf8");
  assert.equal(sectionOf(after, "navigation").raw, sectionOf(edited, "navigation").raw, "the changed section is byte for byte what the user left");
  const system = sectionOf(after, "variables-system");
  assert.equal(system.rev, 2);
  const designHeading = "### design.authority\n";
  assert.equal(system.body.split(designHeading).length, 2, "the design contract appears exactly once");
  assert.equal(system.body.slice(system.body.indexOf(designHeading)), [
    "### design.authority",
    "",
    `Configuration target: ${projectId}.`,
    "",
    "Design bindings: unconfigured. Production publication: unverified. The offline engine validates declarations only; an authorized agent verifies repository and production evidence.",
    "",
    "| Setting | Declared value | Effective source | Inherited |",
    "| --- | --- | --- | --- |",
    "| design.authority | https://design.example.com/system | library | true |",
    "| design.repository | (unconfigured) | default | false |",
    "| design.pullRequestTarget | (unconfigured) | default | false |",
    "| design.productionDocs | (unconfigured) | default | false |",
    "| design.buildService | (unconfigured) | default | false |",
    "| design.buildProject | (unconfigured) | default | false |",
    "| design.consumedVersion | (unconfigured) | default | false |",
    "",
    "| System setting | Effective source | Inherited |",
    "| --- | --- | --- |",
    "| design.authority | library | true |",
    "| design.repository | default | false |",
    "| design.pullRequestTarget | default | false |",
    "| design.productionDocs | default | false |",
    "| design.buildService | default | false |",
    "| design.buildProject | default | false |",
    "| design.consumedVersion | default | false |",
    "",
  ].join("\n"), "the explicit target, all seven design bindings and every system source retain their exact contract");
  assert.deepEqual(parseManagedFile(after).outside, parseManagedFile(edited).outside, "nothing outside the sections changed");
  assert.equal(await readFile(join(next.backupDir, "AGENTS.md"), "utf8"), edited);

  // status judges config/project.json on the records as well as the settings.
  assert.equal((await cli(["status", "--workspace", library])).configProjection, "current");
});

test("478-AC2 via agents-render: a section deleted with its markers is not put back, and its record says removed", async (context) => {
  const { project, projectId, agents } = await scratch(context);
  await render(project);
  const written = await readFile(agents, "utf8");
  await writeFile(agents, written.replace(sectionOf(written, "variables-custom").raw, ""));
  const next = await render(project);
  assert.deepEqual(next.sections.find((section) => section.id === "variables-custom"), { id: "variables-custom", file: "AGENTS.md", result: "removed", state: "removed" });
  assert.deepEqual([next.recorded, next.ids, next.files.some((file) => file.written)], [1, [`managed-section:${projectId}:AGENTS.md#variables-custom`], false]);
  assert.equal((await readFile(agents, "utf8")).includes("id=variables-custom"), false, "the removed section is not put back");
  const third = await render(project);
  assert.deepEqual(third.sections.find((section) => section.id === "variables-custom"), { id: "variables-custom", file: "AGENTS.md", result: "removed", state: "removed" });
  assert.deepEqual([third.recorded, third.backupDir, third.files.some((file) => file.written)], [0, null, false]);
});

test("478-AC3 via the shipped entry: markers that do not parse refuse the whole render, naming the file and the line", async (context) => {
  const { device, project, agents, claude } = await scratch(context);
  const text = `${USER_TEXT}\n<!-- einzbern:section id=navigation rev=1 digest=${"0".repeat(64)} -->\nNo end marker.\n`;
  await writeFile(agents, text);
  const run = shipped(["agents-render", "--project", project, "--at", at()], { device });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.deepEqual([run.refusal.reasonCode, run.refusal.file, run.refusal.line], ["MANAGED_SECTION_MALFORMED", "AGENTS.md", "5"]);
  assert.equal(await readFile(agents, "utf8"), text, "nothing is written into the refused file");
  await assert.rejects(stat(claude), { code: "ENOENT" }, "nor into CLAUDE.md: both files are planned before either is written");

  // Run from inside the project without --project, the registry finds it all the same.
  await writeFile(agents, USER_TEXT);
  const fromInside = shipped(["agents-render", "--at", at()], { device, cwd: join(project, "src") });
  assert.equal(fromInside.status, 0, JSON.stringify(fromInside.refusal));
  assert.equal(JSON.parse(fromInside.stdout).projectPath, project);
  assert.equal(sectionOf(await readFile(agents, "utf8"), "navigation") !== null, true);
});

test("478-R3 via rule-resolve: after keep, agents-render never writes that section; overwrite then needs --force; unmanage leaves the text", async (context) => {
  const { device, project, projectId, agents } = await scratch(context);
  await render(project);
  const edited = (await readFile(agents, "utf8")).replace("Recall first:", "Recall frst:");
  await writeFile(agents, edited);
  assert.deepEqual((await render(project)).pending, [{ id: "navigation", file: "AGENTS.md" }]);

  const kept = await cli(["rule-resolve", "--project", project, "--section", "navigation", "--action", "keep", "--at", at()]);
  assert.deepEqual(
    [kept.reasonCode, kept.section, kept.file, kept.action, kept.result, kept.state, kept.written, kept.backupDir, kept.ids],
    ["MANAGED_SECTION_RESOLVED", "navigation", "AGENTS.md", "keep", "kept", "user-owned", false, null, [`managed-section:${projectId}:AGENTS.md#navigation`]],
  );
  const again = await render(project);
  assert.deepEqual(again.sections.find((section) => section.id === "navigation"), { id: "navigation", file: "AGENTS.md", result: "unchanged", state: "user-owned" });
  assert.deepEqual([again.pending, again.recorded, again.files.some((file) => file.written)], [[], 0, false]);
  assert.equal(await readFile(agents, "utf8"), edited, "the kept section is not written");

  // Overwriting a section the user kept needs --force true, and the refusal names the section.
  const refused = shipped(["rule-resolve", "--project", project, "--section", "navigation", "--action", "overwrite", "--at", at()], { device });
  assert.equal(refused.status, 1);
  assert.deepEqual([refused.refusal.reasonCode, refused.refusal.file, refused.refusal.section], ["MANAGED_SECTION_FORCE_REQUIRED", "AGENTS.md", "navigation"]);
  assert.equal(await readFile(agents, "utf8"), edited);
  const forced = await cli(["rule-resolve", "--project", project, "--section", "navigation", "--action", "overwrite", "--force", "true", "--at", at()]);
  assert.deepEqual([forced.result, forced.state, forced.written], ["overwritten", "managed", true]);
  assert.equal(await readFile(join(forced.backupDir, "AGENTS.md"), "utf8"), edited, "the user's version is backed up first");
  assert.equal(forced.backupPath, join(forced.backupDir, "AGENTS.md"));
  const overwritten = sectionOf(await readFile(agents, "utf8"), "navigation");
  assert.deepEqual([overwritten.body, overwritten.rev], [`${NAVIGATION_LINES.join("\n")}\n`, 2]);

  // unmanage: the markers go, the text stays, and the section is never managed again.
  const unmanaged = await cli(["rule-resolve", "--project", project, "--section", "variables-custom", "--action", "unmanage", "--at", at()]);
  assert.deepEqual([unmanaged.result, unmanaged.state, unmanaged.written], ["unmanaged", "unmanaged", true]);
  const text = await readFile(agents, "utf8");
  assert.deepEqual([text.includes("id=variables-custom"), text.includes("## Custom variables")], [false, true]);
  const last = await render(project);
  assert.deepEqual(last.sections.find((section) => section.id === "variables-custom"), { id: "variables-custom", file: "AGENTS.md", result: "unchanged", state: "unmanaged" });
  assert.equal(last.files.some((file) => file.written), false);
});

test("478-R3, R4: the refusals of rule-resolve and agents-render, and a device that has not chosen gets no navigation section", async (context) => {
  const { base, project, agents } = await scratch(context, null);
  const unset = await render(join(project, "src"));
  assert.deepEqual(unset.navigation, { key: "agents.navigation", value: null });
  assert.equal(unset.projectPath, project, "--project names any directory of the project");
  assert.deepEqual(unset.sections.map((section) => section.id), ["variables-system", "variables-custom", "claude-import"]);
  assert.equal(sectionOf(await readFile(agents, "utf8"), "navigation"), null);

  const action = await refusal(["rule-resolve", "--project", project, "--section", "variables-system", "--action", "replace", "--at", at()]);
  assert.deepEqual([action.reasonCode, action.details.section], ["MANAGED_SECTION_ACTION_INVALID", "variables-system"]);
  const missing = await refusal(["rule-resolve", "--project", project, "--section", "rule:autonomy", "--action", "keep", "--at", at()]);
  assert.deepEqual([missing.reasonCode, missing.details.file, missing.details.section], ["MANAGED_SECTION_NOT_FOUND", "AGENTS.md", "rule:autonomy"]);
  const invalid = await refusal(["rule-resolve", "--project", project, "--section", "Not an id", "--action", "keep", "--at", at()]);
  assert.deepEqual([invalid.reasonCode, invalid.details.section], ["MANAGED_SECTION_INPUT_INVALID", "Not an id"]);
  assert.equal((await refusal(["rule-resolve", "--project", project, "--section", "navigation", "--action", "keep", "--force", "maybe", "--at", at()])).reasonCode, "CLI_ARGUMENT_MALFORMED");
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  assert.equal((await refusal(["agents-render", "--project", elsewhere, "--at", at()])).reasonCode, "LIBRARY_NOT_REGISTERED");
  assert.equal((await refusal(["agents-render"])).reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal((await refusal(["rule-resolve", "--section", "navigation", "--at", at()])).reasonCode, "CLI_ARGUMENT_MISSING");
});
