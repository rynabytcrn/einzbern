// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-540 GWT1, GWT3 (MIN-258 D3(c), which replaces MIN-245 D6; TCRN-CROSS-SUB-505): a
// coordination library is a destination of managed sections too. Registered on this device for a
// project root outside every library -- the container it coordinates -- rule-enable, rule-disable and
// agents-render write that root's AGENTS.md and record each section in the library, as they do for a
// project, and a rule's state is read from the file and the records. A root within a library, or one
// the registry does not hold for the library, is refused with its reason; a coordination library with
// no such root records a rule change alone and says so (outputBindingStatus unconfigured). The first
// render over a section whose markers agree with its text but which the library never recorded
// replaces it and records it; a section the user changed waits. Everything here is temporary: the
// container, its library and the test process's device directory (helpers/device-home.mjs).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  declareChainIdentity,
  disableRule,
  effectiveProjectState,
  enableRule,
  initializeLibrary,
  listRules,
  materializeWorkspace,
  registerLibrary,
  renderAgentsSections,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { managedOutputBinding } from "../dist/build/packages/core/src/agents-sections.js";
import { managedSectionRecordsFor, parseManagedFile, renderSection } from "../dist/build/packages/core/src/managed-sections.js";
import { ruleBody } from "../dist/build/packages/core/src/rules-catalog.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const USER_TEXT = "# The container\n\nThe Owner's own text, which the engine never rewrites.\n";

// A container with a coordination library inside it, `.ether`. `register` names the project path this
// device's registry holds for the library: the container (the default), the library itself, or none.
async function container(context, register = "container") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-coordination-sections-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "container");
  await mkdir(root);
  const library = join(root, ".ether");
  const initial = await initializeLibrary({ root: library, createdAt: at() });
  const libraryId = initial.metadata.workspaceId;
  await declareChainIdentity(library, { role: "coordination", coordinationLibraryId: libraryId }, { occurredAt: at() });
  if (register !== "none") {
    await registerLibrary({ projectPath: register === "container" ? root : library, libraryPath: library, registeredAt: at(), gitRemote: null });
  }
  return { base, root, library, libraryId, backups: join(base, "backups"), agents: join(root, "AGENTS.md") };
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
  return parseManagedFile(text, "AGENTS.md").sections.find((section) => section.id === id) ?? null;
}

async function recordOf(library, id) {
  return managedSectionRecordsFor(await materializeWorkspace(library), "AGENTS.md").find((record) => record.id === id) ?? null;
}

// The CLI as Atelier runs it (EINZBERN_SURFACE=atelier), its receipt parsed.
async function atelier(args) {
  const previous = process.env.EINZBERN_SURFACE;
  process.env.EINZBERN_SURFACE = "atelier";
  try {
    let output = "";
    await runCli(args, { write: (text) => { output += text; } });
    return JSON.parse(output);
  } finally {
    if (previous === undefined) delete process.env.EINZBERN_SURFACE; else process.env.EINZBERN_SURFACE = previous;
  }
}

test("540-GWT1: a coordination library registered for its container writes and records a rule's section there, and reads its state from the file", async (context) => {
  const c = await container(context);
  await writeFile(c.agents, USER_TEXT);
  assert.equal(await managedOutputBinding(c.library, c.root, await materializeWorkspace(c.library)), "bound");
  const enabled = await enableRule({ libraryRoot: c.library, projectRoot: c.root, id: "autonomy", backupRoot: c.backups, occurredAt: at() });
  assert.deepEqual([enabled.written, enabled.result, enabled.outputBindingStatus, enabled.status.state, enabled.recorded], [true, "create", "bound", "enabled", 2]);
  const text = await readFile(c.agents, "utf8");
  assert.ok(text.startsWith(USER_TEXT), "the Owner's text stays as it was");
  const section = sectionOf(text, "rule:autonomy");
  assert.equal(section?.body, ruleBody("autonomy", null));
  assert.deepEqual(await recordOf(c.library, "rule:autonomy"), { file: "AGENTS.md", id: "rule:autonomy", rev: 1, digest: section.digest, state: "managed" });
  assert.equal((await listRules({ libraryRoot: c.library, projectRoot: c.root })).find((rule) => rule.id === "autonomy").state, "enabled");

  // agents-render writes the variable sections beside it and records them.
  const rendered = await renderAgentsSections(c.library, { projectRoot: c.root, navigation: null, backupRoot: c.backups, occurredAt: at() });
  assert.deepEqual(rendered.pending, []);
  assert.deepEqual(rendered.sections.filter((entry) => entry.file === "AGENTS.md").map((entry) => [entry.id, entry.state]).sort(), [["rule:autonomy", "managed"], ["variables-custom", "managed"], ["variables-system", "managed"]]);
  for (const id of ["variables-system", "variables-custom"]) assert.equal((await recordOf(c.library, id))?.state, "managed", id);

  // A user's change to the section reads user-modified, as a project's does.
  const edited = (await readFile(c.agents, "utf8")).replace(section.body.split("\n")[2], "An edit of the Owner's.");
  await writeFile(c.agents, edited);
  assert.equal((await listRules({ libraryRoot: c.library, projectRoot: c.root })).find((rule) => rule.id === "autonomy").state, "user-modified");
  const forced = await disableRule({ libraryRoot: c.library, projectRoot: c.root, id: "autonomy", force: true, backupRoot: c.backups, occurredAt: at() });
  assert.deepEqual([forced.written, forced.result, forced.outputBindingStatus, forced.status.state], [true, "disabled", "bound", "disabled"]);
  assert.equal(sectionOf(await readFile(c.agents, "utf8"), "rule:autonomy"), null);
  assert.equal(await recordOf(c.library, "rule:autonomy"), null, "the section's record goes with it");
});

test("540-GWT1: the coordination library is its own configuration source, so its artifact language picks the rule's text", async (context) => {
  const c = await container(context);
  await setWorkspaceSetting(c.library, { key: "artifact.language", value: "zh-CN", occurredAt: at() });
  const effective = await effectiveProjectState(await materializeWorkspace(c.library));
  assert.deepEqual([effective.settings.find((entry) => entry.key === "artifact.language")?.value, effective.settingSources["artifact.language"]?.kind], ["zh-CN", "library"]);
  await enableRule({ libraryRoot: c.library, projectRoot: c.root, id: "silent-reporting", backupRoot: c.backups, occurredAt: at() });
  assert.equal(sectionOf(await readFile(c.agents, "utf8"), "rule:silent-reporting")?.body, ruleBody("silent-reporting", "zh-CN"));
});

test("540-GWT1: the CLI resolves a coordination library's registered container through --project and writes there", async (context) => {
  const c = await container(context);
  const nested = join(c.root, "nested");
  await mkdir(nested);
  const enabled = await atelier(["rule-enable", "--id", "batch", "--project", nested, "--at", at()]);
  assert.deepEqual([enabled.reasonCode, enabled.projectPath, enabled.written, enabled.outputBindingStatus, enabled.rule.state], ["RULE_ENABLED", c.root, true, "bound", "enabled"]);
  const listed = await atelier(["rule-list", "--project", c.root]);
  assert.deepEqual([listed.outputBindingStatus, listed.projectPath, listed.rules.find((rule) => rule.id === "batch").state], ["bound", c.root, "enabled"]);
  const rendered = await atelier(["agents-render", "--project", c.root, "--at", at()]);
  assert.equal(rendered.reasonCode, "AGENTS_RENDERED");
  assert.deepEqual(rendered.pending, []);
  assert.ok(rendered.sections.some((section) => section.id === "variables-system" && section.state === "managed"));
  const disabled = await atelier(["rule-disable", "--id", "batch", "--project", c.root, "--at", at()]);
  assert.deepEqual([disabled.reasonCode, disabled.written, disabled.outputBindingStatus, disabled.rule.state], ["RULE_DISABLED", true, "bound", "disabled"]);
  assert.equal(sectionOf(await readFile(c.agents, "utf8"), "rule:batch"), null);
});

test("540-GWT1: a root within a library, or one the registry does not hold for the coordination library, is refused with its reason", async (context) => {
  const c = await container(context);
  const state = await materializeWorkspace(c.library);
  const inside = await refusal(() => enableRule({ libraryRoot: c.library, projectRoot: c.library, id: "autonomy", backupRoot: c.backups, occurredAt: at() }));
  assert.equal(inside.reasonCode, "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY");
  const elsewhere = join(c.base, "elsewhere");
  await mkdir(elsewhere);
  const unregistered = await refusal(() => renderAgentsSections(c.library, { projectRoot: elsewhere, navigation: null, backupRoot: c.backups, occurredAt: at() }));
  assert.equal(unregistered.reasonCode, "MANAGED_SECTION_OUTPUT_UNREGISTERED");
  assert.match(unregistered.message, /registered/u);
  await assert.rejects(readFile(join(elsewhere, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(c.library, "AGENTS.md")), { code: "ENOENT" });
  assert.equal((await materializeWorkspace(c.library)).headEventHash, state.headEventHash, "a refusal records nothing");
});

test("540-GWT1: a coordination library with no registered root outside a library records a rule change alone and says so", async (context) => {
  for (const register of ["none", "library"]) {
    const c = await container(context, register);
    const enabled = await enableRule({ libraryRoot: c.library, projectRoot: c.library, id: "autonomy", occurredAt: at() });
    assert.deepEqual([enabled.written, enabled.result, enabled.recorded, enabled.outputBindingStatus, enabled.status.recordedVersion], [false, "unchanged", 1, "unconfigured", 1], register);
    const refused = await refusal(() => renderAgentsSections(c.library, { projectRoot: c.root, navigation: null, occurredAt: at() }));
    assert.equal(refused.reasonCode, "MANAGED_SECTION_OUTPUT_UNREGISTERED", register);
    const disabled = await disableRule({ libraryRoot: c.library, projectRoot: c.library, id: "autonomy", occurredAt: at() });
    assert.deepEqual([disabled.written, disabled.recorded, disabled.outputBindingStatus, disabled.status.state], [false, 1, "unconfigured", "disabled"], register);
    await assert.rejects(readFile(c.agents), { code: "ENOENT" }, `${register}: no file is written`);
    await assert.rejects(readFile(join(c.library, "AGENTS.md")), { code: "ENOENT" }, `${register}: nothing enters the library`);
  }
});

test("540-GWT3: the first render replaces a marked section the library never recorded, backing the file up, and leaves a changed one pending", async (context) => {
  const c = await container(context);
  const handBatch = renderSection({ id: "rule:batch", rev: 4, body: "### Batch, as the Owner kept it by hand\n\nOld text.\n" });
  const handSilent = renderSection({ id: "rule:silent-reporting", rev: 2, body: "### Silent reporting by hand\n\nOld text.\n" });
  // The second section's text no longer agrees with its marker: a change of the user's.
  const changedSilent = handSilent.replace("Old text.", "Old text, edited after the marker was written.");
  const original = `${USER_TEXT}\n${handBatch}\n${changedSilent}`;
  await writeFile(c.agents, original);
  await enableRule({ libraryRoot: c.library, projectRoot: c.root, id: "silent-reporting", backupRoot: c.backups, occurredAt: at() });
  await enableRule({ libraryRoot: c.library, projectRoot: c.root, id: "batch", backupRoot: c.backups, occurredAt: at() });
  const text = await readFile(c.agents, "utf8");
  const batch = sectionOf(text, "rule:batch");
  assert.deepEqual([batch.body, batch.rev], [ruleBody("batch", null), 5], "replaced by the engine's text, its revision one up");
  assert.deepEqual(await recordOf(c.library, "rule:batch"), { file: "AGENTS.md", id: "rule:batch", rev: 5, digest: batch.digest, state: "managed" });
  assert.ok(text.includes(changedSilent), "the changed section stays as it is");
  assert.equal((await recordOf(c.library, "rule:silent-reporting"))?.state, "pending");
  const rendered = await renderAgentsSections(c.library, { projectRoot: c.root, navigation: null, backupRoot: c.backups, occurredAt: at() });
  assert.deepEqual(rendered.pending, [{ id: "rule:silent-reporting", file: "AGENTS.md" }]);
  const states = Object.fromEntries((await listRules({ libraryRoot: c.library, projectRoot: c.root })).map((rule) => [rule.id, rule.state]));
  assert.deepEqual([states.batch, states["silent-reporting"]], ["enabled", "pending"]);
  const backups = await readdir(c.backups, { recursive: true });
  const copies = await Promise.all(backups.filter((entry) => entry.endsWith("AGENTS.md")).map((entry) => readFile(join(c.backups, entry), "utf8")));
  assert.ok(copies.includes(original), "the file as it was is in a backup");
});
