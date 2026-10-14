// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-540 GWT5, GWT7 (MIN-258 D3(c), which replaces MIN-245 D6; TCRN-CROSS-SUB-508): Atelier
// manages a coordination library's rules and variables as it does a project's. Selected, a coordination
// library registered for a container outside every library shows the container's AGENTS.md on the Rules
// page; a rule switched on there is written into that file and recorded in the library, and a variable or
// one of the settings its system section shows renders the file again. Each write runs for Atelier and its
// event records surface atelier. A coordination library registered only as its own path has no such file:
// a rule change is recorded alone, and nothing is written inside the library. Everything here is temporary:
// the container, its library, the device directory and HOME of each fixture, removed with it.

import "../../tests/helpers/device-home.mjs";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
const ACTOR = "agent:test-portal";
const OWNER_TEXT = "# The container\n\nThe Owner's own text, which the engine never rewrites.\n";

let second = 0;
const at = () => { second += 1; return new Date(Date.UTC(2026, 9, 15, 2, 0, second)).toISOString().replace(".000Z", "Z"); };

async function cli(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6, env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

// A container with a coordination library inside it, `.ether`, on a device of its own. `register` names the
// project path the device's registry holds for the library: the container (the default) or the library itself.
async function coordinationFixture(context, register = "container") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "portal-coordination-")));
  const home = join(base, "home");
  await mkdir(home);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const container = join(base, "container");
  await mkdir(container);
  const library = join(container, ".ether");
  await cli(["init", "--workspace", library, "--at", at()], deviceEnv);
  const libraryId = (await cli(["status", "--workspace", library], deviceEnv)).workspaceId;
  await cli(["chain-declare", "--workspace", library, "--role", "coordination", "--coordination-library-id", libraryId, "--at", at(), "--actor", "agent:test"], { ...deviceEnv, EINZBERN_SURFACE: "atelier" });
  await cli(["library-register", "--project", register === "container" ? container : library, "--library", library, "--at", at()], deviceEnv);
  await writeFile(join(container, "AGENTS.md"), OWNER_TEXT, "utf8");
  const fixture = { base, home, deviceEnv, container, library, libraryId, agents: join(container, "AGENTS.md") };
  const portal = await startPortal(fixture);
  context.after(async () => {
    if (portal.child.exitCode === null) { const exited = new Promise((resolve) => portal.child.once("exit", resolve)); portal.child.kill(); await exited; }
    await rm(base, { recursive: true, force: true });
  });
  return { ...fixture, url: portal.url };
}

async function startPortal({ library, home, deviceEnv }) {
  const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), "--library", library, "--port", "0"], {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: ACTOR, ...deviceEnv, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`portal did not start: ${buffer}`)), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`portal exited ${code}: ${buffer}`)); });
  });
  return { child, url };
}

async function readBoot(url) {
  const page = await (await fetch(url)).text();
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  const target = { epoch: boot.epoch, libraryId: boot.library.libraryId, projectId: boot.library.configurationProjectId ?? null };
  return { boot, read: { headers: { "x-portal-token": boot.token } }, write: (method, body) => ({ method, headers: { "content-type": "application/json", "x-portal-token": boot.token, "x-configuration-target": JSON.stringify(target) }, body: JSON.stringify(body) }) };
}

async function request(url, path, options) {
  const response = await fetch(new URL(path, url), options);
  return { response, body: await response.json() };
}

// The events appended after `from`, read through the CLI's event page, the route the portal's dependency
// audit sanctions.
async function eventsSince(fixture, from) {
  const { records } = await cli(["event-list", "--workspace", fixture.library, "--offset", String(from)], fixture.deviceEnv);
  return records.map((record) => record.payload);
}
const eventCount = async (fixture) => (await cli(["event-list", "--workspace", fixture.library, "--limit", "1"], fixture.deviceEnv)).total;
const section = (text, id) => {
  const start = text.indexOf(`<!-- einzbern:section id=${id} `);
  const end = text.indexOf(`<!-- einzbern:section-end id=${id} -->`);
  return start < 0 || end < start ? null : text.slice(start, end);
};

test("540 GWT5: a coordination library selected in Atelier shows the container's AGENTS.md, writes a rule into it and renders it again after a variable or a setting, each write recorded with surface atelier", async (context) => {
  const fixture = await coordinationFixture(context);
  const { boot, read, write } = await readBoot(fixture.url);
  assert.deepEqual([boot.library.chain.role, boot.proseRoot], ["coordination", fixture.container], "the coordination library's prose root is the container it is registered for");

  const shown = await request(fixture.url, "/api/agents-md", read);
  assert.deepEqual([shown.response.status, shown.body.ok, shown.body.reasonCode, shown.body.path, shown.body.text], [200, true, "PORTAL_AGENTS_MD_READY", fixture.agents, OWNER_TEXT], "the AGENTS.md page shows the container's file");

  let from = await eventCount(fixture);
  const enabled = await request(fixture.url, "/api/rules/autonomy", write("POST", { action: "enable" }));
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.rules.find((rule) => rule.id === "autonomy")?.state, "enabled");
  let text = await readFile(fixture.agents, "utf8");
  assert.ok(text.startsWith(OWNER_TEXT.trimEnd()), "the Owner's own text stays");
  assert.ok(section(text, "rule:autonomy"), "the rule's section is written into the container's AGENTS.md");
  let events = await eventsSince(fixture, from);
  assert.deepEqual(events.filter((event) => event.surface === "atelier").map((event) => [event.record.collection, event.record.key]), [["rule", "autonomy"], ["managed-section", "AGENTS.md#rule:autonomy"]], "the rule and its managed section are recorded in the library, for Atelier");

  from = await eventCount(fixture);
  const variable = await request(fixture.url, "/api/variables", write("POST", { name: "sample", type: "string", value: "hello", description: "A sample" }));
  assert.equal(variable.response.status, 200, JSON.stringify(variable.body));
  // The render is the engine's agents-render receipt for the container, not a pending binding.
  assert.deepEqual([variable.body.ok, variable.body.render.reasonCode, variable.body.render.projectPath], [true, "AGENTS_RENDERED", fixture.container], JSON.stringify(variable.body.render));
  text = await readFile(fixture.agents, "utf8");
  assert.match(section(text, "variables-custom") ?? "", /\| sample \| string \| hello \| A sample \|/u, "the variable is rendered into the container's AGENTS.md");
  events = await eventsSince(fixture, from);
  assert.deepEqual(events.filter((event) => event.record?.collection === "variable").map((event) => [event.record.key, event.surface]), [["sample", "atelier"]]);

  const changed = await request(fixture.url, "/api/variables", write("POST", { name: "sample", type: "string", value: "world", description: "A sample" }));
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  text = await readFile(fixture.agents, "utf8");
  assert.match(section(text, "variables-custom") ?? "", /\| sample \| string \| world \| A sample \|/u, "a changed variable renders the section again");

  // A setting the coordination library's system section shows renders the file again (W2B-P5).
  assert.match(section(text, "variables-system") ?? "", /\| execution\.maxConcurrentSubagents \| 8 \|/u);
  const setting = await request(fixture.url, "/api/settings", write("POST", { key: "execution.maxConcurrentSubagents", value: "3" }));
  assert.equal(setting.response.status, 200, JSON.stringify(setting.body));
  assert.deepEqual([setting.body.ok, setting.body.render?.reasonCode, setting.body.render?.projectPath], [true, "AGENTS_RENDERED", fixture.container], "the write is followed by a render of the container's AGENTS.md");
  text = await readFile(fixture.agents, "utf8");
  assert.match(section(text, "variables-system") ?? "", /\| execution\.maxConcurrentSubagents \| 3 \|/u, "the system section shows the new limit");

  // The artifact language picks the sections' language (Q4), so a change of it renders them again.
  const language = await request(fixture.url, "/api/settings", write("POST", { key: "artifact.language", value: "zh-CN" }));
  assert.equal(language.response.status, 200, JSON.stringify(language.body));
  assert.deepEqual([language.body.ok, language.body.render?.reasonCode], [true, "AGENTS_RENDERED"]);
  const translated = await readFile(fixture.agents, "utf8");
  assert.notEqual(section(translated, "variables-system"), section(text, "variables-system"), "the system section is written again in the library's language");

  // The rule is switched off from the same page, and the file follows.
  const disabled = await request(fixture.url, "/api/rules/autonomy", write("POST", { action: "disable" }));
  assert.equal(disabled.response.status, 200, JSON.stringify(disabled.body));
  assert.equal(section(await readFile(fixture.agents, "utf8"), "rule:autonomy"), null, "a rule switched off leaves the container's AGENTS.md");
});

test("540 GWT5: a coordination library registered only as its own path has no container file; a rule change is recorded alone and nothing is written in the library", async (context) => {
  const fixture = await coordinationFixture(context, "library");
  const { boot, read, write } = await readBoot(fixture.url);
  assert.deepEqual([boot.library.chain.role, boot.proseRoot], ["coordination", null]);
  const shown = await request(fixture.url, "/api/agents-md", read);
  assert.deepEqual([shown.body.ok, shown.body.reasonCode, shown.body.outputBindingStatus], [true, "PORTAL_PROJECT_BINDING_UNCONFIGURED", "unconfigured"]);
  const enabled = await request(fixture.url, "/api/rules/autonomy", write("POST", { action: "enable" }));
  assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.outputBindingStatus, "unconfigured", "the engine says the rule was recorded alone");
  await assert.rejects(readFile(join(fixture.library, "AGENTS.md")), { code: "ENOENT" });
  assert.equal(await readFile(fixture.agents, "utf8"), OWNER_TEXT, "a directory the library is not registered for is left alone");
  const variable = await request(fixture.url, "/api/variables", write("POST", { name: "sample", type: "string", value: "hello", description: "A sample" }));
  assert.equal(variable.response.status, 200, JSON.stringify(variable.body));
  assert.deepEqual([variable.body.render.reasonCode, variable.body.render.pending], ["PORTAL_PROJECT_BINDING_UNCONFIGURED", true], "the render waits for a registered directory");
  await assert.rejects(readFile(join(fixture.library, "AGENTS.md")), { code: "ENOENT" });
});
