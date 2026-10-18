// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-538 GWT3, GWT7 (TCRN-CROSS-SUB-499): the writes that put sections into a project's
// AGENTS.md and CLAUDE.md and record them -- agents-render, rule-resolve, rule-enable, rule-disable and
// the variable sections -- read the library and plan the files outside the library write lock, and
// hold it for the write alone. While another process holds the lock for 3 seconds, agents-render's
// plan is made at once and its write lands once the lock is free, and a plan that refuses refuses
// without waiting. A change to AGENTS.md that another process made after the plan, or a record another
// writer appended after it, sends the write back to read and plan again, so it never writes over the
// change and never leaves the file and the records one new and one old. A write whose append fails
// puts its files back as it read them (TCRN-CROSS-STORY-489). Everything here is temporary: a project,
// a library and a device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initializeLibrary, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { AGENTS_FILE, CLAUDE_FILE, NAVIGATION_LINES, renderAgentsSections, resolveAgentsSection } from "../dist/build/packages/core/src/agents-sections.js";
import { managedSectionRecordsFor, parseManagedFile } from "../dist/build/packages/core/src/managed-sections.js";
import { disableRule, enableRule } from "../dist/build/packages/core/src/rules.js";
import { setVariable } from "../dist/build/packages/core/src/variables.js";
import { writeVariablesSections } from "../dist/build/packages/core/src/variables-sections.js";

const workspaceModule = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
const variablesModule = new URL("../dist/build/packages/core/src/variables.js", import.meta.url).href;

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const USER_TEXT = "# My project\n\nMy own notes, which the engine never rewrites.\n";
// An end marker without its start: every planned write of this file refuses (MANAGED_SECTION_MALFORMED).
const MALFORMED_TEXT = `${USER_TEXT}\n<!-- einzbern:section-end id="navigation" -->\n`;
const RULE = "batch";

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-managed-write-lock-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const root = join(base, ".ether");
  await initializeLibrary({ root, createdAt: at() });
  const agents = join(project, AGENTS_FILE);
  await writeFile(agents, USER_TEXT);
  return { base, project, root, agents, claude: join(project, CLAUDE_FILE), backups: join(base, "device", "backups") };
}

// Another process that takes the library's write lock, as a write verb does, and gives it back after
// `milliseconds`; `released` resolves, once it exited, to the moment the test saw it exit.
async function holdLibraryLock(context, root, milliseconds) {
  const script = `import { withWorkspaceWriteLock } from ${JSON.stringify(workspaceModule)};
await withWorkspaceWriteLock(${JSON.stringify(root)}, async () => {
  process.stdout.write("held\\n");
  await new Promise((resolve) => setTimeout(resolve, ${milliseconds}));
}, { command: "einzbern work-annotate" });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const released = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
    return Date.now();
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await released.catch(() => undefined);
  });
  await once(child.stdout, "data");
  return { heldAt: Date.now(), released };
}

// Another process that writes `text` into `path`, as an editor would, and is done when this returns.
function writeFromAnotherProcess(path, text) {
  execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", path, text]);
}

// Another process that sets a variable in the library: a writer that takes the lock, appends and gives it back.
function setVariableFromAnotherProcess(root, variable) {
  const script = `import { setVariable } from ${JSON.stringify(variablesModule)};
await setVariable(${JSON.stringify(root)}, ${JSON.stringify(variable)});`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: process.env });
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

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

function sectionOf(text, id) {
  return parseManagedFile(text).sections.find((section) => section.id === id) ?? null;
}

async function records(root, file = AGENTS_FILE) {
  return managedSectionRecordsFor(await materializeWorkspace(root), file);
}

// The five entry points, each in the form one test calls it.
function writers(paths) {
  const shared = (extra) => ({ backupRoot: paths.backups, occurredAt: at(), ...extra });
  return {
    "agents-render": (extra = {}) => renderAgentsSections(paths.root, { projectRoot: paths.project, navigation: "written", ...shared(extra) }),
    "rule-enable": (extra = {}) => enableRule({ libraryRoot: paths.root, projectRoot: paths.project, id: RULE, ...shared(extra) }),
    "rule-disable": (extra = {}) => disableRule({ libraryRoot: paths.root, projectRoot: paths.project, id: RULE, ...shared(extra) }),
    "rule-resolve": (extra = {}) => resolveAgentsSection(paths.root, { projectRoot: paths.project, id: "navigation", action: "overwrite", ...shared(extra) }),
    "variable sections": (extra = {}) => writeVariablesSections(paths.root, { projectRoot: paths.project, ...shared(extra) }),
  };
}

test("538 GWT3: while another process holds the library write lock for 3 seconds, agents-render plans at once and writes once the lock is free", async (context) => {
  const paths = await scratch(context);
  await setVariable(paths.root, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const before = await libraryHead(paths.root);
  const holder = await holdLibraryLock(context, paths.root, 3000);
  const planned = [];
  const locked = [];
  let renderedAt = null;
  const rendering = writers(paths)["agents-render"]({
    plannedForTest: async () => { planned.push(Date.now()); },
    insideWriteLockForTest: async () => { locked.push(Date.now()); },
  }).then((result) => { renderedAt = Date.now(); return result; });
  const releasedAt = await holder.released;
  const rendered = await rendering;

  assert.equal(planned.length, 1, "one plan: nothing moved while it waited");
  assert.ok(planned[0] - holder.heldAt < 1000, `the plan was made ${planned[0] - holder.heldAt} ms after the other process took the lock, not after it gave it back`);
  assert.ok(planned[0] < releasedAt, "the plan was made while the other process held the lock");
  assert.equal(locked.length, 1);
  assert.ok(locked[0] - holder.heldAt >= 2500, `the write took the lock ${locked[0] - holder.heldAt} ms after the other process did: only once it was free`);
  assert.ok(renderedAt >= locked[0]);

  assert.deepEqual(rendered.sections.map((section) => [section.id, section.result]), [
    ["navigation", "create"],
    ["variables-system", "create"],
    ["variables-custom", "create"],
    ["claude-import", "create"],
  ]);
  assert.equal(rendered.recorded, 4);
  const text = await readFile(paths.agents, "utf8");
  assert.ok(text.startsWith(USER_TEXT), "the user's text stays where it was");
  assert.match(sectionOf(text, "variables-custom").body, /deploy\.host/u);
  assert.notEqual(await textOrNull(paths.claude), null);
  assert.equal((await libraryHead(paths.root)).version, before.version + 4, "the four records went in once");
  assert.deepEqual((await records(paths.root)).map((record) => [record.id, record.state]).sort(), [
    ["navigation", "managed"],
    ["variables-custom", "managed"],
    ["variables-system", "managed"],
  ]);
});

test("538 GWT3: while another process holds the lock, a plan that refuses refuses at once, for each of the five writes", async (context) => {
  const paths = await scratch(context);
  await writeFile(paths.agents, MALFORMED_TEXT);
  const head = await libraryHead(paths.root);
  const holder = await holdLibraryLock(context, paths.root, 3000);
  for (const [name, write] of Object.entries(writers(paths))) {
    const refused = await timed(() => refusal(() => write()));
    assert.equal(refused.result.reasonCode, "MANAGED_SECTION_MALFORMED", name);
    assert.ok(refused.elapsed < 1000, `${name} refused in ${refused.elapsed} ms`);
  }
  assert.ok(Date.now() - holder.heldAt < 3000, "every refusal came while the lock was held");
  await holder.released;
  assert.equal(await readFile(paths.agents, "utf8"), MALFORMED_TEXT, "nothing was written");
  assert.deepEqual(await libraryHead(paths.root), head, "and nothing recorded");
});

test("538 GWT3: while another process holds the lock, rule-enable, rule-disable, rule-resolve and the variable sections plan at once and land once it is free", async (context) => {
  const paths = await scratch(context);
  const write = writers(paths);
  await write["agents-render"]();
  // rule-resolve overwrites a section the user changed; the change is made before each hold.
  const userChange = async () => {
    const text = await readFile(paths.agents, "utf8");
    await writeFile(paths.agents, text.replace(NAVIGATION_LINES[2], "Recall first, always."));
    await write["agents-render"]();
  };
  const steps = [
    ["rule-enable", null, async (change) => {
      assert.deepEqual([change.result, change.written, change.status.state], ["create", true, "enabled"]);
      assert.notEqual(sectionOf(await readFile(paths.agents, "utf8"), `rule:${RULE}`), null);
    }],
    ["rule-disable", null, async (change) => {
      assert.deepEqual([change.result, change.written, change.status.state], ["disabled", true, "disabled"]);
      assert.equal(sectionOf(await readFile(paths.agents, "utf8"), `rule:${RULE}`), null);
    }],
    ["rule-resolve", userChange, async ({ change }) => {
      assert.deepEqual([change.result, change.written, change.record.state], ["overwritten", true, "managed"]);
      assert.equal(sectionOf(await readFile(paths.agents, "utf8"), "navigation").body.includes(NAVIGATION_LINES[2]), true);
    }],
    ["variable sections", () => setVariable(paths.root, { exports: ["agents"], name: "deploy.port", type: "number", value: "8443", occurredAt: at() }), async (result) => {
      assert.equal(result.written, true);
      assert.match(sectionOf(await readFile(paths.agents, "utf8"), "variables-custom").body, /deploy\.port/u);
    }],
  ];
  for (const [name, prepare, check] of steps) {
    await prepare?.();
    const holder = await holdLibraryLock(context, paths.root, 1000);
    const planned = [];
    const result = await write[name]({ plannedForTest: async () => { planned.push(Date.now()); } });
    const releasedAt = await holder.released;
    assert.equal(planned.length, 1, name);
    assert.ok(planned[0] - holder.heldAt < 1000 && planned[0] < releasedAt, `${name}: planned while the other process held the lock`);
    await check(result);
  }
});

test("538 GWT3: AGENTS.md changed by another process after the plan sends the render back to plan again, and the change is not written over", async (context) => {
  const paths = await scratch(context);
  const write = writers(paths);
  await write["agents-render"]();
  await setVariable(paths.root, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  // The user's change to the custom section, which the render planned to replace.
  const rendered = await readFile(paths.agents, "utf8");
  const custom = sectionOf(rendered, "variables-custom");
  const edited = rendered.replace(custom.raw, custom.raw.replace(custom.body, `${custom.body}A row the user added.\n`));
  assert.notEqual(edited, rendered);

  const planned = [];
  const result = await write["agents-render"]({
    plannedForTest: async () => {
      planned.push(Date.now());
      if (planned.length === 1) writeFromAnotherProcess(paths.agents, edited);
    },
  });
  assert.equal(planned.length, 2, "the render planned again once it found the file changed");
  assert.equal(await readFile(paths.agents, "utf8"), edited, "the user's change is not written over");
  assert.deepEqual(result.pending, [{ id: "variables-custom", file: AGENTS_FILE }], "the changed section waits for the user");
  assert.equal(result.sections.find((section) => section.id === "variables-custom").result, "refused-user-modified");
  assert.equal(result.files.some((file) => file.written), false);
  assert.equal((await records(paths.root)).find((record) => record.id === "variables-custom").state, "pending", "the record says what the file holds");
});

test("538 GWT3: a record another writer appended after the plan sends the render back to read the library again, so the file and the records agree", async (context) => {
  const paths = await scratch(context);
  const write = writers(paths);
  await write["agents-render"]();
  const head = await libraryHead(paths.root);
  const planned = [];
  const result = await write["agents-render"]({
    plannedForTest: async () => {
      planned.push(Date.now());
      if (planned.length === 1) setVariableFromAnotherProcess(paths.root, { exports: ["agents"], name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
    },
  });
  assert.equal(planned.length, 2, "the render read the library again once it found a stream moved");
  assert.equal(result.sections.find((section) => section.id === "variables-custom").result, "replace", "the second plan saw the new variable");
  const text = await readFile(paths.agents, "utf8");
  assert.match(sectionOf(text, "variables-custom").body, /deploy\.port/u);
  assert.equal((await libraryHead(paths.root)).version, head.version + 2, "the other writer's record, then the render's");
  const recorded = (await records(paths.root)).find((record) => record.id === "variables-custom");
  assert.equal(recorded.digest, sectionOf(text, "variables-custom").digest, "the record holds the section the file holds");
  const again = await write["agents-render"]();
  assert.deepEqual([again.recorded, again.files.some((file) => file.written), again.pending], [0, false, []], "the file and the records agree");
});

test("538 GWT3, 489: a write whose append fails after it wrote puts the files back as it read them, for each write", async (context) => {
  const paths = await scratch(context);
  const write = writers(paths);
  const failing = { crashAt: "before-write" };
  const unchanged = async (name, run) => {
    const agents = await readFile(paths.agents, "utf8");
    const claude = await textOrNull(paths.claude);
    const head = await libraryHead(paths.root);
    const recorded = await records(paths.root);
    const error = await refusal(run);
    assert.equal(error.reasonCode, "WORKSPACE_FAULT_INJECTED", name);
    assert.equal(await readFile(paths.agents, "utf8"), agents, `${name}: AGENTS.md holds what it held`);
    assert.equal(await textOrNull(paths.claude), claude, `${name}: CLAUDE.md holds what it held, or is not there`);
    assert.deepEqual([await libraryHead(paths.root), await records(paths.root)], [head, recorded], `${name}: the library holds no new event`);
  };

  await unchanged("agents-render", () => write["agents-render"](failing));
  assert.equal(await textOrNull(paths.claude), null, "the CLAUDE.md the render created is taken away");
  await write["agents-render"]();
  await setVariable(paths.root, { exports: ["agents"], name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await unchanged("variable sections", () => write["variable sections"](failing));
  await unchanged("rule-enable", () => write["rule-enable"](failing));
  await write["rule-enable"]();
  await unchanged("rule-disable", () => write["rule-disable"](failing));
  assert.notEqual(sectionOf(await readFile(paths.agents, "utf8"), `rule:${RULE}`), null, "the rule's section is back in the file");
  const text = await readFile(paths.agents, "utf8");
  await writeFile(paths.agents, text.replace(NAVIGATION_LINES[2], "Recall first, always."));
  await write["agents-render"]();
  await unchanged("rule-resolve", () => write["rule-resolve"](failing));

  // A refusal of the records themselves comes, as it came while the whole write held the lock, once
  // the file was written: the file goes back as it was read, and the backup the write made stays.
  await setVariable(paths.root, { exports: ["agents"], name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
  await rm(paths.backups, { recursive: true, force: true });
  const before = await readFile(paths.agents, "utf8");
  const planned = [];
  const refused = await refusal(() => write["variable sections"]({ viewBudgetBytes: 1, plannedForTest: async () => { planned.push(Date.now()); } }));
  assert.equal(refused.reasonCode, "WORKSPACE_VIEW_BUDGET_EXCEEDED");
  assert.equal(planned.length, 1, "planned outside the lock, refused under it");
  assert.equal(await readFile(paths.agents, "utf8"), before);
  assert.notDeepEqual(await readdir(paths.backups, { recursive: true }), [], "the file was written, so its original was backed up first");
});
