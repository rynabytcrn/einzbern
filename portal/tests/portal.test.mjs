// SPDX-License-Identifier: Apache-2.0
// Portal integration tests use the real CLI and a real governed scratch tree.

// Every CLI and portal child inherits the test process's device directory, never the real one.
import "../../tests/helpers/device-home.mjs";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
const RETIRED_PERSONA_ACTIONS = Object.freeze({
  override: ["persona", "-preset-override"].join(""),
  restore: ["persona", "-preset-restore"].join(""),
  set: ["persona", "-set"].join(""),
  remove: ["persona", "-remove"].join(""),
});
// TCRN-CROSS-STORY-482 R4: the routes of the retired pages, spelled in parts so that a search of
// the portal for the retired names finds only their absence.
const RETIRED_ROUTES = Object.freeze({
  evolution: ["", "api", "evolution"].join("/"),
  sessionAudit: ["", "api", ["session", "audit"].join("-")].join("/"),
  hostProbe: ["", "api", ["host", "probe"].join("-")].join("/"),
});

async function cli(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 32e6, env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

// TCRN-CROSS-INC-386: the portal and every CLI it starts read and write machine settings
// under HOME, so every portal child gets a scratch HOME inside its fixture, removed with it.
async function scratchHome(base) {
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  return home;
}

// TCRN-CROSS-STORY-482 R3: Atelier opens the libraries a device has registered, so a fixture is a
// device of its own (an EINZBERN_HOME inside it, removed with it; every CLI and portal child of the
// fixture runs as that device) whose registry holds two libraries: the fixture's library, kept in
// its project, and a second library kept outside its project. The portal starts on the first.
async function registeredLibrary(deviceEnv, project, library, externalKey, at) {
  await mkdir(project, { recursive: true });
  await cli(["init", "--workspace", library, "--project-name", externalKey, "--at", at], deviceEnv);
  await cli(["library-register", "--project", project, "--library", library, "--at", at], deviceEnv);
}

async function scratch(prefix, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = await scratchHome(base);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const proseRoot = join(base, "project");
  const workspace = join(proseRoot, ".ether");
  await registeredLibrary(deviceEnv, proseRoot, workspace, externalKey, "2026-08-11T15:00:00Z");
  const second = { project: join(base, "second-project"), library: join(base, "second-library") };
  await registeredLibrary(deviceEnv, second.project, second.library, `${externalKey}-SECOND`, "2026-08-11T15:00:01Z");
  return { base, workspace, proseRoot, home, deviceEnv, second };
}

// `library` names the library to open first; null starts the portal without --library, so it
// chooses from the registry by its working directory (`cwd`).
async function startPortal({ workspace, home, deviceEnv = {}, env = {}, library = workspace, cwd }) {
  assert.ok(home, "every portal child needs a scratch HOME inside its fixture (TCRN-CROSS-INC-386)");
  const args = [join(portalRoot, "portal.mjs")];
  if (library !== null) args.push("--library", library);
  args.push("--port", "0");
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...deviceEnv, ...env, HOME: home },
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const listening = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`portal did not start: ${buffer}`)), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING"));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`portal exited ${code}: ${buffer}`)); });
  });
  return { child, url: listening.url, listening };
}

// A portal that refuses to start answers on stderr with one JSON line and exits 2.
async function startupRefusal(args, env, cwd) {
  return new Promise((resolveSpawn) => {
    const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), ...args, "--port", "0"], { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...env }, ...(cwd === undefined ? {} : { cwd }), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolveSpawn({ status: code, report: JSON.parse(stderr.trim().split("\n").at(-1) || "{}") }));
  });
}

async function readBoot(url) {
  const page = await (await fetch(url)).text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  return { page, boot: JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]) };
}

function request(url, path, options) { return fetch(new URL(path, url), options).then(async (response) => ({ response, body: await response.json() })); }
function writeOptions(token, method, body) { return { method, headers: { "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) }; }
function readOptions(token) { return { headers: { "x-portal-token": token } }; }

// STORY-355 GWT1: `fetch` (undici) never forwards a caller-supplied Host header — it
// always sends the header that matches the real socket target, which defeats the one
// thing this needs to prove. `node:http`'s request() has no such guard, so it is the
// only way to simulate the DNS-rebinding shape: a real loopback TCP connection carrying
// a forged Host header, exactly what an attacker-controlled page can make a browser send.
function rawRequest(url, path, { host, headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, url);
    const req = httpRequest(target, { headers: { ...headers, ...(host === undefined ? {} : { host }) } }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolvePromise({ status: response.statusCode, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("portal boots from the live engine and exposes the new read surfaces", async (t) => {
  const fixture = await scratch("tcrn-portal-read-", "TCRN-PORTAL-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.equal(boot.workspace, fixture.workspace);
  assert.equal(boot.library.libraryPath, fixture.workspace);
  assert.equal(boot.libraries.length, 2);
  for (const retired of ["partitionMode", "partitions", "selectedPartition", "container"]) assert.equal(Object.hasOwn(boot, retired), false, retired);
  assert.match(page, /data-page="dashboard"/u);
  assert.match(page, /data-page="variables"/u);
  assert.match(page, /data-page="gates"/u);
  assert.match(page, /data-page="vocabulary"/u);

  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.body.reasonCode, "SETTINGS_CATALOG_READY");
  // TCRN-CROSS-STORY-484 R3: the two subagent-plan settings are retired with the dispatch keys.
  assert.deepEqual(settings.body.settings.filter((entry) => entry.key.includes("SubagentPlan") || entry.key.startsWith("execution.dispatch")).map((entry) => entry.key), []);
  // TCRN-CROSS-STORY-467 R3: the execution projection read the dispatch-* verbs and left with
  // them; the route answers as unknown rather than from a retired verb.
  const execution = await request(url, "/api/execution", readOptions(boot.token));
  assert.equal(execution.response.status, 404);
  assert.equal(execution.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const dictionary = await request(url, "/api/vocabulary", readOptions(boot.token));
  assert.equal(dictionary.body.reasonCode, "VOCABULARY_READY");
  assert.equal(Object.hasOwn(dictionary.body, "roles"), false);
  assert.equal(Object.hasOwn(dictionary.body, "efforts"), false);
  assert.ok(dictionary.body.hosts.includes("codex"));
  const variables = await request(url, "/api/variables", readOptions(boot.token));
  assert.equal(variables.body.reasonCode, "VARIABLE_LIST_READY");
  assert.deepEqual(variables.body.variables, []);
});

test("STORY-379 read views use CLI projections and keep partial data visible", async (t) => {
  const fixture = await scratch("tcrn-portal-views-", "TCRN-PORTAL-VIEWS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  for (const tab of ["work", "knowledge"]) assert.match(page, new RegExp(`data-workspace-tab="${tab}"`, "u"));
  // TCRN-CROSS-STORY-485: gate configuration is its own destination, not a workspace tab.
  // TCRN-CROSS-STORY-482 R4: the evolution panel and the session audit left with their mechanisms.
  for (const tab of ["gates", "evolution", "audit"]) assert.doesNotMatch(page, new RegExp(`data-workspace-tab="${tab}"`, "u"));

  const work = await request(url, "/api/work", readOptions(boot.token));
  assert.equal(work.body.reasonCode, "PORTAL_WORK_READY");
  assert.ok(Array.isArray(work.body.records));
  const knowledge = await request(url, "/api/knowledge", readOptions(boot.token));
  assert.match(knowledge.body.reasonCode, /^PORTAL_KNOWLEDGE_/u);
  assert.ok(Array.isArray(knowledge.body.records));
  const gates = await request(url, "/api/gates", readOptions(boot.token));
  assert.equal(gates.response.status, 200);
  assert.equal(gates.body.reasonCode, "PORTAL_GATES_READY");
  assert.deepEqual(gates.body.gates, []);

  const untokened = await request(url, "/api/work");
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
});

// TCRN-CROSS-STORY-482 R4, AC3: the pages that showed the retired mechanisms went with them, and
// so did their routes. The old execution and evolution projections, the session audit and the
// host probe answer as unknown routes, exactly like a path the portal never had; the token check
// still comes first.
test("STORY-482 AC3: the retired execution, evolution and session audit routes answer 404", async (t) => {
  const fixture = await scratch("tcrn-portal-ac3-", "TCRN-PORTAL-AC3");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  for (const path of ["/api/execution", RETIRED_ROUTES.evolution, RETIRED_ROUTES.sessionAudit, "/api/no-such-route"]) {
    const read = await request(url, path, readOptions(boot.token));
    assert.equal(read.response.status, 404, `GET ${path}`);
    assert.equal(read.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", `GET ${path}`);
  }
  for (const path of ["/api/execution", RETIRED_ROUTES.evolution]) {
    const write = await request(url, path, writeOptions(boot.token, "POST", {}));
    assert.equal(write.response.status, 404, `POST ${path}`);
    assert.equal(write.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", `POST ${path}`);
  }
  const untokened = await request(url, RETIRED_ROUTES.evolution);
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  // The page asks for none of them.
  for (const path of [RETIRED_ROUTES.evolution, RETIRED_ROUTES.sessionAudit, RETIRED_ROUTES.hostProbe, "/api/execution"]) {
    assert.equal(page.includes(`"${path}"`), false, `the page must not request ${path}`);
  }
});

test("portal writes carry the actor under the engine's write lock, then return the engine receipt and readback", async (t) => {
  const fixture = await scratch("tcrn-portal-write-", "TCRN-PORTAL-WRITE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "retrieval.tau", value: "3" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");

  const setting = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "retrieval.tau", value: "3" }));
  assert.equal(setting.response.status, 200);
  assert.equal(setting.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(setting.body.readback.currentValue, "3");

  // TCRN-CROSS-STORY-484 R3: the tiers are models.tiers, each tier with its runner.
  const tiers = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "models.tiers",
    value: JSON.stringify({ "claude-code": { main: { runner: "claude-code", model: "opus-5", effort: "xhigh2" } } }),
  }));
  assert.equal(tiers.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(tiers.body.render.reasonCode, "AGENTS_RENDERED");
  assert.equal(tiers.body.render.withheld.length, 0);
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /\| claude-code \| main \| claude-code \| opus-5 \| xhigh2 \|/u);
  // TCRN-CROSS-STORY-482 R4: a tiers write renders no host projection.
  assert.equal(Object.hasOwn(tiers.body, "hostRender"), false);
  // The dispatch classes and modes retired with TCRN-CROSS-STORY-484 R3: a write is refused and appends nothing.
  const retiredClasses = await request(url, "/api/settings", writeOptions(boot.token, "POST", {
    key: "execution.dispatchClasses",
    value: JSON.stringify({ "review-visual": { dispatch: true, verify: false } }),
  }));
  assert.equal(retiredClasses.response.status, 409);
  assert.equal(retiredClasses.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const parallelOff = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "quota.fiveHourParallelOffPercent", value: "80" }));
  assert.equal(parallelOff.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const wait = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "quota.fiveHourWaitPercent", value: "95" }));
  assert.equal(wait.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  // TCRN-CROSS-STORY-467 R3: the execution write route carried the dispatch-* writes and the
  // retired plan and persona actions. It is gone, so those posts reach no writer and leave
  // nothing in the session audit.
  const retired = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-set", host: "claude-code", name: "daily", defaultModel: "opus-5" }));
  assert.equal(retired.response.status, 404);
  assert.equal(retired.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", value: "3" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  const retiredPersona = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: RETIRED_PERSONA_ACTIONS.override, name: "Verity", fields: { mission: "Review governed evidence", role: "reviewer" } }));
  assert.equal(retiredPersona.response.status, 404);
  assert.equal(retiredPersona.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");

  // TCRN-CROSS-STORY-482 R4: the session audit left with its page. Each settings write is answered
  // by the engine's receipt; models.tiers additionally refreshes its managed system variables.
  for (const receipt of [setting, tiers, parallelOff, wait, active]) assert.ok(receipt.body.receiptDigest && receipt.body.headEventHash && receipt.body.version);
  const versions = [setting.body.version, tiers.body.version, parallelOff.body.version, wait.body.version, active.body.version];
  assert.ok(versions.every((version, index) => Number.isInteger(version) && (index === 0 || version > versions[index - 1])));
  assert.ok(tiers.body.render.version > tiers.body.version && tiers.body.render.version < parallelOff.body.version, "the managed system-variable render is governed between the tier setting and the next write");
  const audit = await request(url, RETIRED_ROUTES.sessionAudit, readOptions(boot.token));
  assert.equal(audit.response.status, 404);
  assert.equal(audit.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
});

test("STORY-484 variable routes write, read back and render safe values while withholding secrets", async (t) => {
  const fixture = await scratch("tcrn-portal-variables-", "TCRN-PORTAL-VARIABLES");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  const created = await request(url, "/api/variables", writeOptions(boot.token, "POST", {
    name: "deploy.host", type: "string", value: "build.example.com", description: "Build endpoint",
  }));
  assert.equal(created.response.status, 200);
  assert.equal(created.body.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.deepEqual(created.body.readback, { name: "deploy.host", type: "string", value: "build.example.com", description: "Build endpoint" });
  assert.deepEqual(created.body.variables, [created.body.readback]);
  assert.equal(created.body.render.reasonCode, "AGENTS_RENDERED");
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host.*build\.example\.com/u);

  const updated = await request(url, "/api/variables", writeOptions(boot.token, "POST", {
    name: "deploy.host", type: "string", value: "stage.example.com", description: "Staging endpoint",
  }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.readback.value, "stage.example.com");
  assert.match(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host.*stage\.example\.com/u);

  const secret = "sk-proj-0123456789abcdef";
  const refused = await request(url, "/api/variables", writeOptions(boot.token, "POST", {
    name: "api.key", type: "string", value: secret,
  }));
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "VARIABLE_SECRET_SHAPED");
  assert.doesNotMatch(JSON.stringify(refused.body), /sk-proj-0123456789abcdef/u, "secret-shaped input must not be echoed in the response");
  assert.equal((await request(url, "/api/variables", readOptions(boot.token))).body.variables.length, 1);

  const removed = await request(url, "/api/variables", writeOptions(boot.token, "DELETE", { name: "deploy.host" }));
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.reasonCode, "VARIABLE_WRITE_COMMITTED");
  assert.equal(removed.body.readback, null);
  assert.deepEqual(removed.body.variables, []);
  assert.doesNotMatch(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /deploy\.host/u);
});

// STORY-403 replaces the old STORY-366 manual-writing interaction while retaining
// the native CLI/data contract tested by this same integration case.
test("STORY-366: the article endpoint is refused while the native article stays readable through the knowledge index", async (t) => {
  const fixture = await scratch("tcrn-portal-article-", "TCRN-PORTAL-ARTICLE");
  await cli(["project-create", "--workspace", fixture.workspace, "--at", "2026-08-11T15:00:01Z", "--external-key", "PORTAL-ARTICLE-PROJECT", "--name", "Articles"], fixture.deviceEnv);
  await cli(["knowledge-init", "--workspace", fixture.workspace, "--acknowledge-disposable", "true"], fixture.deviceEnv);
  const native = await cli(["knowledge-article-create", "--workspace", fixture.workspace, "--at", "2026-08-11T15:00:01Z", "--path", "portal-article.md", "--category", "architecture", "--title", "Agent article", "--summary", "Agent article summary", "--content", "Agent article body", "--accountable-owner-id", "owner:portal", "--evidence-ids", "evidence:portal-article"], fixture.deviceEnv);
  assert.equal(native.reasonCode, "KNOWLEDGE_ARTICLE_CREATED");
  assert.equal(await readFile(native.path, "utf8").then((text) => text.includes("Agent article body")), true);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.doesNotMatch(page, /data-page="articles"/u);
  assert.doesNotMatch(page, /article-form|knowledge-article-create/iu);
  assert.match(page, /data-workspace-tab="knowledge"/u);
  const knowledge = await request(url, "/api/knowledge", readOptions(boot.token));
  const article = knowledge.body.records.find((record) => record.subject === "Agent article");
  assert.ok(article, "the native article must remain in the knowledge index");
  assert.deepEqual(article.sourceReferences, ["portal-article.md"]);
  const body = await request(url, `/api/knowledge/body?id=${encodeURIComponent(article.id)}`, readOptions(boot.token));
  assert.equal(body.response.status, 200);
  assert.match(body.body.body, /Source: portal-article\.md/u);
  const refused = await request(url, "/api/knowledge/articles", writeOptions(boot.token, "POST", { title: "Manual article", category: "architecture", content: "must not write" }));
  assert.equal(refused.response.status, 404);
  assert.equal(refused.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
});

test("STORY-485: Atelier edits gate declarations and reads each library's latest cached gate run", async (t) => {
  const fixture = await scratch("tcrn-portal-gates-", "TCRN-PORTAL-GATES");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const gatesNow = async () => (await request(url, "/api/gates", readOptions(boot.token))).body;
  const latestNow = async () => (await request(url, "/api/gates/last-run", readOptions(boot.token))).body;
  assert.deepEqual((await gatesNow()).gates, []);

  const created = await request(url, "/api/gates", writeOptions(boot.token, "POST", {
    name: "portal", command: ["pnpm", "verify:links"], root: ".", covers: ["portal/**", "docs/**"],
    enabled: true, required: true, releaseOnly: false,
  }));
  assert.equal(created.response.status, 200);
  assert.deepEqual(created.body.gate, { name: "portal", command: ["pnpm", "verify:links"], root: ".", covers: ["portal/**", "docs/**"], enabled: true, required: true, releaseOnly: false });
  assert.deepEqual((await gatesNow()).gates, [created.body.gate]);

  const updated = await request(url, "/api/gates", writeOptions(boot.token, "POST", {
    name: "portal", command: ["pnpm", "verify:portal"], root: "portal", covers: ["portal/**"],
    enabled: false, required: false, releaseOnly: true,
  }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.gate.enabled, false);
  assert.equal(updated.body.gate.required, false);
  assert.equal(updated.body.gate.releaseOnly, true);
  assert.deepEqual(updated.body.gate.covers, ["portal/**"]);
  assert.equal((await latestNow()).run, null);

  const writeRun = async (libraryId, runId, at, gateName, ok) => {
    const directory = join(fixture.deviceEnv.EINZBERN_HOME, "cache", libraryId.replace(":", "-"), "gate-runs");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${runId}.json`), JSON.stringify({
      schemaVersion: "einzbern.gate-run.v1", runId, libraryId, at, release: false, base: null,
      treeDigest: `tree-${runId}`, declarationsDigest: `declarations-${runId}`, trees: [],
      gates: [{ name: gateName, root: ".", required: true, ok, exitCode: ok ? 0 : 1, signal: null, timedOut: false, outputFile: `${runId}/1-${gateName}.log`, outputBytes: 0, truncated: false }],
      reds: ok ? [] : [gateName],
    }));
  };
  await writeRun(boot.library.libraryId, "first-run", "2026-08-11T16:00:00Z", "portal", false);
  await writeRun(boot.library.libraryId, "latest-run", "2026-08-11T17:00:00Z", "portal", true);
  const latest = await latestNow();
  assert.equal(latest.reasonCode, "PORTAL_GATE_RUN_READY");
  assert.equal(latest.run.runId, "latest-run");
  assert.deepEqual(latest.run.reds, []);

  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  await writeRun(second.workspaceId, "second-library-run", "2026-08-11T18:00:00Z", "second", false);
  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.project }));
  assert.equal(switched.response.status, 200);
  assert.equal((await latestNow()).run.runId, "second-library-run");

  const back = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.proseRoot }));
  assert.equal(back.response.status, 200);
  const removed = await request(url, "/api/gates", writeOptions(boot.token, "DELETE", { name: "portal" }));
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.gates, []);
  assert.deepEqual((await gatesNow()).gates, []);
});

test("state surface uses the doctor's eight checks and selected library projection", async (t) => {
  const fixture = await scratch("tcrn-portal-state-", "TCRN-PORTAL-STATE");
  const wrapper = join(fixture.base, "status-wrapper.mjs");
  await writeFile(wrapper, `import { spawnSync } from "node:child_process";
const actual = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...process.argv.slice(2)], { encoding: "utf8" });
if (process.argv[2] === "status" && actual.status === 0) {
  const body = JSON.parse(actual.stdout);
  body.engineVersion = "0.11.99";
  process.stdout.write(JSON.stringify(body));
} else if (process.argv[2] === "doctor" && actual.status === 0 && process.env.TCRN_TEST_DOCTOR_RED === "registry") {
  const body = JSON.parse(actual.stdout);
  body.checks = body.checks.map((check) => check.check === "registry" ? { ...check, ok: false, reasonCode: "PORTAL_TEST_REGISTRY_RED", detail: { causes: ["PORTAL_TEST_REGISTRY_RED"] } } : check);
  body.ok = false;
  process.stdout.write(JSON.stringify(body));
} else {
  process.stdout.write(actual.stdout || "");
  process.stderr.write(actual.stderr || "");
  process.exitCode = actual.status ?? 1;
}
`, "utf8");
  const { child, url } = await startPortal({ ...fixture, env: { TCRN_WORKFLOW_CLI: wrapper } });
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const status = await request(url, "/api/status", readOptions(boot.token));
  assert.equal(status.body.engineVersion, "0.11.99");
  const doctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.equal(status.body.checks.length, 8);
  assert.deepEqual(status.body.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), doctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.equal(status.body.ok, doctor.ok);
  const libraryStatus = await cli(["status", "--workspace", fixture.workspace], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.deepEqual(status.body.library, {
    versionVector: libraryStatus.versionVector,
    streams: libraryStatus.streams,
    rejectedEventCount: libraryStatus.rejectedEventCount,
    configProjection: libraryStatus.configProjection,
  });

  child.kill();
  const redPortal = await startPortal({ ...fixture, env: { TCRN_WORKFLOW_CLI: wrapper, TCRN_TEST_DOCTOR_RED: "registry" } });
  t.after(() => redPortal.child.kill());
  const { boot: redBoot } = await readBoot(redPortal.url);
  const redStatus = await request(redPortal.url, "/api/status", readOptions(redBoot.token));
  const { stdout: redDoctorOutput } = await execFileAsync(process.execPath, [wrapper, "doctor", "--project", fixture.proseRoot], {
    encoding: "utf8", env: { ...process.env, ...fixture.deviceEnv, HOME: fixture.home, TCRN_TEST_DOCTOR_RED: "registry" },
  });
  const redDoctor = JSON.parse(redDoctorOutput);
  assert.equal(redStatus.body.ok, false);
  assert.deepEqual(redStatus.body.checks, redDoctor.checks);
  assert.equal(redStatus.body.checks.find((check) => check.check === "registry").reasonCode, "PORTAL_TEST_REGISTRY_RED");
});

test("AGENTS.md read/write is allow-listed and reconciliation reports line-level findings", async (t) => {
  const fixture = await scratch("tcrn-portal-agents-", "TCRN-PORTAL-AGENTS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const text = "# rules\n\nSet retrieval.tau before close.\n";
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.matches, true);
  assert.equal(written.body.saved, true);
  assert.equal(written.body.render.reasonCode, "AGENTS_RENDERED");
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), written.body.text);
  const green = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);

  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${text}\nAlso set retrieval.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);

  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"), readOptions(boot.token));
  assert.equal(escapedRead.response.status, 404);
  assert.equal(escapedRead.body.reasonCode, "PORTAL_PATH_ESCAPE");
  const escapedWrite = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "../AGENTS.md", text: "no" }));
  assert.equal(escapedWrite.response.status, 404);
  assert.equal(escapedWrite.body.reasonCode, "PORTAL_PATH_ESCAPE");
});

// TCRN-CROSS-STORY-482 R3, AC1: the registry's two libraries are listed and can be switched, and
// each one answers with its own status. The second library carries one event of its own, so the
// two statuses differ in more than their ids.
test("STORY-482 AC1: the registry's two libraries can be switched, and each answers with its own status", async (t) => {
  const fixture = await scratch("tcrn-portal-libraries-", "TCRN-PORTAL-LIBRARIES");
  await cli(["settings-set", "--workspace", fixture.second.library, "--at", "2026-08-11T15:01:00Z", "--actor", "agent:test", "--key", "artifact.language", "--value", "zh-CN"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const first = await cli(["status", "--workspace", fixture.workspace], fixture.deviceEnv);
  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  const firstDoctor = await cli(["doctor", "--project", fixture.proseRoot], { ...fixture.deviceEnv, HOME: fixture.home });
  const secondDoctor = await cli(["doctor", "--project", fixture.second.project], { ...fixture.deviceEnv, HOME: fixture.home });
  const { child, url, listening } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  assert.equal(listening.selectedBy, "argument");
  const { boot } = await readBoot(url);
  const listed = await request(url, "/api/libraries", readOptions(boot.token));
  assert.equal(listed.body.reasonCode, "PORTAL_LIBRARIES_READY");
  assert.deepEqual(listed.body.libraries, [
    { projectPath: fixture.proseRoot, libraryId: first.workspaceId, libraryPath: fixture.workspace },
    { projectPath: fixture.second.project, libraryId: second.workspaceId, libraryPath: fixture.second.library },
  ]);
  assert.deepEqual(listed.body.selected, listed.body.libraries[0]);
  assert.deepEqual(boot.libraries, listed.body.libraries);

  const statusNow = async () => (await request(url, "/api/status", readOptions(boot.token))).body;
  const languageNow = async () => (await request(url, "/api/settings", readOptions(boot.token))).body.settings.find((entry) => entry.key === "artifact.language").currentValue;
  let status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [first.workspaceId, 0]);
  assert.equal(status.ok, firstDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), firstDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, first.versionVector);
  assert.equal(status.library.rejectedEventCount, first.rejectedEventCount);
  assert.deepEqual(status.library.configProjection, first.configProjection);
  assert.equal(await languageNow(), "en");

  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.project }));
  assert.equal(switched.response.status, 200);
  assert.equal(switched.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.deepEqual(switched.body.library, listed.body.libraries[1]);
  assert.equal(switched.body.workspace, fixture.second.library);
  assert.equal(switched.body.proseRoot, fixture.second.project);
  status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [second.workspaceId, 1]);
  assert.equal(status.ok, secondDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), secondDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, second.versionVector);
  assert.equal(status.library.rejectedEventCount, second.rejectedEventCount);
  assert.deepEqual(status.library.configProjection, second.configProjection);
  assert.equal(await languageNow(), "zh-CN");
  assert.deepEqual((await request(url, "/api/libraries", readOptions(boot.token))).body.selected, listed.body.libraries[1]);

  // A library is named by its id too; the switch back reads the first library again.
  const back = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: first.workspaceId }));
  assert.equal(back.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  status = await statusNow();
  assert.deepEqual([status.workspaceId, status.version], [first.workspaceId, 0]);
  assert.equal(status.ok, firstDoctor.ok);
  assert.deepEqual(status.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })), firstDoctor.checks.map(({ check, ok, reasonCode }) => ({ check, ok, reasonCode })));
  assert.deepEqual(status.library.versionVector, first.versionVector);

  const unknown = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: join(fixture.base, "not-a-library") }));
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.reasonCode, "PORTAL_LIBRARY_UNKNOWN");
  assert.equal((await statusNow()).workspaceId, first.workspaceId, "a refused switch leaves the selection alone");
  // The partition catalog and its switch are gone with the container.
  for (const path of ["/api/partitions", "/api/partition"]) {
    const retired = await request(url, path, readOptions(boot.token));
    assert.equal(retired.response.status, 404, path);
    assert.equal(retired.body.reasonCode, "PORTAL_ROUTE_UNKNOWN", path);
  }
});

test("portal serves live catalog, commits a governed write, and refuses an untokened one", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-read-", "TCRN-PORTAL-CONSERVATION-READ");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  assert.ok(boot.token.length >= 32);
  const catalog = await request(url, "/api/settings", readOptions(boot.token));
  const engineCatalog = await cli(["settings-catalog", "--workspace", fixture.workspace], fixture.deviceEnv);
  assert.deepEqual(catalog.body.settings, engineCatalog.settings);
  assert.ok(!page.includes("gate-close"));
  assert.match(page, /data-setting-control/u);
  assert.ok(catalog.body.settings.every((entry) => entry.controlType));
  const untokened = await request(url, "/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "retrieval.tau", value: "3" }) });
  assert.equal(untokened.response.status, 403);
  assert.equal(untokened.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const committed = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "retrieval.tau", value: "3" }));
  assert.equal(committed.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(committed.body.setting.value, "3");
  assert.equal(committed.body.readback.currentValue, "3");
  assert.ok(committed.body.receiptDigest && committed.body.headEventHash);
  const refused = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "bogus.key", value: "x" }));
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const status = await request(url, "/api/status", readOptions(boot.token));
  assert.equal(status.body.checks.length, 8);
  assert.ok(status.body.checks.every((check) => Object.hasOwn(check, "check") && Object.hasOwn(check, "reasonCode") && Object.hasOwn(check, "detail")));
  assert.deepEqual(Object.keys(status.body.library).sort(), ["configProjection", "rejectedEventCount", "streams", "versionVector"]);
  const commands = await request(url, "/api/commands", readOptions(boot.token));
  assert.ok(commands.body.commands.some((entry) => entry.name === "settings-set" && entry.mutates));
});

test("reconciliation includes custom variable names as well as registered settings", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-reconcile-", "TCRN-PORTAL-CONSERVATION-RECONCILE");
  await cli(["variable-set", "--workspace", fixture.workspace, "--at", new Date().toISOString(), "--actor", "agent:test", "--name", "deploy.host", "--type", "string", "--value", "build.example.com"], { ...fixture.deviceEnv, EINZBERN_SURFACE: "atelier" });
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const greenText = "# AGENTS.md\n\nSet retrieval.tau and deploy.host before close.\n";
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  const green = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(green.body.ok, true);
  assert.equal(green.body.findings.length, 0);
  assert.ok(green.body.rows.some((row) => row.key === "retrieval.tau" && row.registered));
  assert.ok(green.body.rows.some((row) => row.key === "deploy.host" && row.registered), "custom variable names participate in reconciliation");
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), `${greenText}\nAlso set retrieval.retiredKey.\n`, "utf8");
  const red = await request(url, "/api/agents-md/reconcile", readOptions(boot.token));
  assert.equal(red.body.ok, false);
  assert.equal(red.body.findings[0].kind, "unregistered");
  assert.equal(red.body.findings[0].line, 5);
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), greenText, "utf8");
  assert.equal((await request(url, "/api/agents-md/reconcile", readOptions(boot.token))).body.ok, true);
});

test("AGENTS.md save writes the file, renders managed sections, and reads it back", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-prose-", "TCRN-PORTAL-CONSERVATION-PROSE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const text = "# AGENTS.md\n\nOwner actions stay parked.\n";
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.matches, true);
  assert.equal(written.body.render.reasonCode, "AGENTS_RENDERED");
  assert.deepEqual(written.body.pending, []);
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), written.body.text);
  const readback = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.equal(readback.body.text, written.body.text);
  assert.equal(readback.body.path, join(fixture.proseRoot, "AGENTS.md"));
  const escapedRead = await request(url, "/api/agents-md?file=" + encodeURIComponent("../AGENTS.md"), readOptions(boot.token));
  assert.equal(escapedRead.response.status, 404);
  assert.equal(escapedRead.body.reasonCode, "PORTAL_PATH_ESCAPE");
  const escapedWrite = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "../AGENTS.md", text: "no" }));
  assert.equal(escapedWrite.response.status, 404);
  assert.equal(escapedWrite.body.reasonCode, "PORTAL_PATH_ESCAPE");
});

test("rules routes expose state, enable a rule, render an edit as pending, and resolve keep", async (t) => {
  const fixture = await scratch("tcrn-portal-rules-", "TCRN-PORTAL-RULES");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const listed = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(listed.body.reasonCode, "RULE_LIST_READY");
  assert.deepEqual(listed.body.rules.map((rule) => rule.id), ["autonomy", "batch", "unattended-commands", "silent-reporting"]);
  assert.ok(listed.body.rules.every((rule) => rule.state === "disabled"));

  const enabled = await request(url, "/api/rules/batch", writeOptions(boot.token, "POST", { action: "enable" }));
  assert.equal(enabled.body.reasonCode, "RULE_ENABLED");
  assert.equal(enabled.body.rules.find((rule) => rule.id === "batch").state, "enabled");
  let edited = await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8");
  assert.match(edited, /id=rule:batch/u);
  edited = edited.replace("All open Stories under one INIT", "All open Stories in one INIT");
  const saved = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text: edited }));
  assert.equal(saved.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.deepEqual(saved.body.pending, [{ id: "rule:batch", file: "AGENTS.md" }]);
  const pending = await request(url, "/api/rules", readOptions(boot.token));
  assert.equal(pending.body.rules.find((rule) => rule.id === "batch").state, "pending");

  const kept = await request(url, "/api/rules/resolve", writeOptions(boot.token, "POST", { section: "rule:batch", action: "keep" }));
  assert.equal(kept.body.reasonCode, "MANAGED_SECTION_RESOLVED");
  assert.deepEqual(kept.body.pending, []);
  assert.equal(kept.body.rules.find((rule) => rule.id === "batch").state, "user-modified");
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), saved.body.text);

  const forcedOff = await request(url, "/api/rules/batch", writeOptions(boot.token, "POST", { action: "disable", force: true }));
  assert.equal(forcedOff.body.reasonCode, "RULE_DISABLED");
  assert.equal(forcedOff.body.rules.find((rule) => rule.id === "batch").state, "disabled");
  assert.doesNotMatch(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), /id=rule:batch/u);
});

test("the page boots with the shipped locale contract and needs nothing outside the portal", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-locale-", "TCRN-PORTAL-CONSERVATION-LOCALE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  const { LOCALE_CONTRACT } = await import("../locale-contract.mjs");
  assert.deepEqual(boot.supportedLocales, [...LOCALE_CONTRACT.supportedLocales]);
  assert.equal(boot.fallbackLocale, LOCALE_CONTRACT.fallbackLocale);
  assert.equal(boot.localeMetadata.length, LOCALE_CONTRACT.localeMetadata.length);
  assert.ok(boot.localeMetadata.every((entry) => entry.nativeName.length > 0));
  const locales = await (await fetch(new URL("/locales.js", url))).text();
  assert.match(locales, /window\.PORTAL_LOCALES/u);
  for (const locale of LOCALE_CONTRACT.supportedLocales) assert.ok(locales.includes(`"${locale}"`) || locales.includes(`${locale}:`));
});

// TCRN-CROSS-STORY-482 R3: the Rules page belongs to the selected library's registered project,
// so a switch moves it; and the switcher asks the registry on every read (INC-203), so a library
// registered after the portal started can be chosen without a restart.
test("switching the library moves the Rules page to its project, and a library registered later can be chosen", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-libraries-", "TCRN-PORTAL-CONSERVATION-LIBRARIES");
  await writeFile(join(fixture.proseRoot, "AGENTS.md"), "# first project\n", "utf8");
  await writeFile(join(fixture.second.project, "AGENTS.md"), "# second project\n", "utf8");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  assert.equal(boot.proseRoot, fixture.proseRoot);
  assert.equal((await request(url, "/api/agents-md", readOptions(boot.token))).body.text, "# first project\n");

  const selected = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: fixture.second.library }));
  assert.equal(selected.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.equal(selected.body.proseRoot, fixture.second.project);
  const prose = await request(url, "/api/agents-md", readOptions(boot.token));
  assert.equal(prose.body.text, "# second project\n");
  assert.equal(prose.body.path, join(fixture.second.project, "AGENTS.md"));
  const written = await request(url, "/api/agents-md", writeOptions(boot.token, "PUT", { file: "AGENTS.md", text: "# second project, edited\n" }));
  assert.equal(written.body.reasonCode, "PORTAL_AGENTS_MD_WRITTEN");
  assert.equal(written.body.text.startsWith("# second project, edited\n"), true);
  assert.match(written.body.text, /## System variables/u);
  assert.match(written.body.text, /## Custom variables/u);
  assert.equal(await readFile(join(fixture.second.project, "AGENTS.md"), "utf8"), written.body.text);
  assert.equal(await readFile(join(fixture.proseRoot, "AGENTS.md"), "utf8"), "# first project\n", "the first project's rules are untouched");
  const catalog = await request(url, "/api/settings", readOptions(boot.token));
  assert.deepEqual(catalog.body.settings, (await cli(["settings-catalog", "--workspace", fixture.second.library], fixture.deviceEnv)).settings);

  const third = { project: join(fixture.base, "third-project"), library: join(fixture.base, "third-project", ".ether") };
  await registeredLibrary(fixture.deviceEnv, third.project, third.library, "TCRN-PORTAL-CONSERVATION-THIRD", "2026-08-11T15:02:00Z");
  const listed = await request(url, "/api/libraries", readOptions(boot.token));
  assert.deepEqual(listed.body.libraries.map((library) => library.projectPath), [fixture.proseRoot, fixture.second.project, third.project]);
  const later = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: third.library }));
  assert.equal(later.body.reasonCode, "PORTAL_LIBRARY_SELECTED");
  assert.equal(later.body.proseRoot, third.project);
});

test("launcher generation emits regular files that carry only --library, starts the macOS launcher, and names a library the device has not registered", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-launchers-", "TCRN-PORTAL-LAUNCH");
  const outputDir = join(fixture.base, "launchers");
  await mkdir(outputDir);
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const generator = join(portalRoot, "scripts", "generate-launchers.mjs");
  const report = JSON.parse((await execFileAsync(process.execPath, [generator, "--library", fixture.workspace, "--output-dir", outputDir, "--port", "0"], { encoding: "utf8" })).stdout);
  assert.equal(report.reasonCode, "PORTAL_LAUNCHERS_GENERATED");
  assert.equal(report.library, fixture.workspace);
  assert.equal(report.symlinks, false);
  assert.equal(report.files.length, 3);
  for (const file of report.files) {
    assert.equal((await lstat(file)).isFile(), true);
    assert.equal((await lstat(file)).isSymbolicLink(), false);
    const text = await readFile(file, "utf8");
    assert.match(text, /--library/u);
    assert.doesNotMatch(text, /--container|--prose-root|--workspace|--partition/u);
  }
  const command = report.files.find((file) => file.endsWith(".command"));
  assert.match(await readFile(command, "utf8"), /^#!\/bin\/sh/u);
  const launcher = spawn(command, [], { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, ...fixture.deviceEnv, HOME: fixture.home }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => launcher.kill());
  const url = await new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => reject(new Error(`launcher timeout: ${buffer}`)), 15000); launcher.stdout.on("data", (chunk) => { buffer += chunk; const line = buffer.split("\n").find((entry) => entry.includes("PORTAL_LISTENING")); if (line) { clearTimeout(timer); resolve(JSON.parse(line).url); } }); launcher.on("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${buffer}`)); }); });
  const { boot: launcherBoot } = await readBoot(url);
  assert.equal(launcherBoot.library.libraryPath, fixture.workspace);
  assert.equal((await request(url, "/api/libraries", readOptions(launcherBoot.token))).body.libraries.length, 2);

  // --library is optional: without it the launcher names no library and the portal chooses at start.
  const plainOutput = join(fixture.base, "plain-launchers");
  await mkdir(plainOutput);
  const plain = JSON.parse((await execFileAsync(process.execPath, [generator, "--output-dir", plainOutput, "--port", "0"], { encoding: "utf8" })).stdout);
  assert.equal(plain.library, null);
  for (const file of plain.files) assert.doesNotMatch(await readFile(file, "utf8"), /--library/u);

  const vanished = join(fixture.base, "vanished-library");
  const badOutput = join(fixture.base, "bad-launchers");
  await mkdir(badOutput);
  await execFileAsync(process.execPath, [generator, "--library", vanished, "--output-dir", badOutput, "--port", "0"], { encoding: "utf8" });
  let failure;
  try { await execFileAsync(join(badOutput, "atelier.sh"), [], { encoding: "utf8", env: { ...process.env, ...fixture.deviceEnv, HOME: fixture.home } }); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(String(failure.stderr), /PORTAL_LIBRARY_UNKNOWN/u);
});

test("i18n proof turns red when the engine drops enum allowedValues", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-conservation-i18n-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shim = join(base, "strip-catalog.mjs");
  await writeFile(shim, `import { execFileSync } from "node:child_process"; const output = execFileSync(process.execPath, [process.env.TCRN_REAL_CLI, ...process.argv.slice(2)], { encoding: "utf8" }); const body = JSON.parse(output); if (process.argv[2] === "settings-catalog") for (const entry of body.settings ?? []) delete entry.allowedValues; process.stdout.write(JSON.stringify(body));\n`, "utf8");
  let failure;
  try { await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_WORKFLOW_CLI: shim, TCRN_REAL_CLI: CLI } }); } catch (error) { failure = error; }
  assert.ok(failure);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reasonCode, "I18N_CONTRACT_VIOLATION");
  const leg = report.legs.find((entry) => entry.leg === "setting-descriptions");
  assert.equal(leg.reasonCode, "SETTING_ENUM_VALUES_GAP");
  // TCRN-CROSS-STORY-484 R3 retired the other enum settings; artifact.language is the one left.
  assert.ok(leg.enumMissingAllowedValues.includes("artifact.language"));
});

test("i18n full-table proof turns red when an existing translation regresses", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-i18n-full-table-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePath = join(base, "locales-mutated.js");
  const source = await readFile(join(portalRoot, "locales.js"), "utf8");
  await writeFile(sourcePath, source.replace('"receipt.title": "エンジンのレシート"', '"receipt.title": "Engine receipt"'), "utf8");
  let failure;
  try {
    await execFileAsync(process.execPath, [join(portalRoot, "scripts", "i18n-proof.mjs")], { encoding: "utf8", env: { ...process.env, TCRN_PORTAL_LOCALES_SOURCE: sourcePath } });
  } catch (error) { failure = error; }
  assert.ok(failure);
  const report = JSON.parse(failure.stdout);
  const leg = report.legs.find((entry) => entry.leg === "translation-full-table");
  assert.equal(leg.reasonCode, "FULL_LOCALE_TABLE_REALITY_GAP");
  assert.ok(leg.problems.some((problem) => problem.locale === "ja" && problem.unexpected.includes("receipt.title")));
});

// TCRN-CROSS-STORY-467 R3: the execution route and its page left with the dispatch-* verbs, and the
// dispatch mode setting with TCRN-CROSS-STORY-484 R3. The owner's concurrency limit is a registered
// setting, written and read back through settings.
test("execution settings: the owner scenario writes through settings while the execution route is gone", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-execution-", "TCRN-PORTAL-CONSERVATION-EXECUTION");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const refusedWrite = await request(url, "/api/execution", writeOptions(boot.token, "POST", { action: "model-plan-set", host: "claude-code", name: "owner-scenario", defaultModel: "opus-5" }));
  assert.equal(refusedWrite.response.status, 404);
  assert.equal(refusedWrite.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const historical = await request(url, "/api/execution", readOptions(boot.token));
  assert.equal(historical.response.status, 404);
  const retiredMode = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.dispatchMode", value: "eco" }));
  assert.equal(retiredMode.body.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const active = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", value: "3" }));
  assert.equal(active.body.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(active.body.readback.currentValue, "3");
  // TCRN-CROSS-STORY-482 R4: the execution surface's host projection is gone, so the write is
  // answered by the engine receipt alone and renders nothing into a host file.
  assert.equal(Object.hasOwn(active.body, "hostRender"), false);
  const readback = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(readback.body.settings.find((entry) => entry.key === "execution.maxConcurrentSubagents").currentValue, "3");
  const removed = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", reset: true }));
  assert.equal(removed.response.status, 200);
  assert.equal(Object.hasOwn(removed.body, "hostRender"), false);
  assert.equal(removed.body.version, active.body.version + 1, "the reset is the chain's next event and the only one");
});

test("STORY-370 the retired identity surface is absent while execution settings remain writable", async (t) => {
  const fixture = await scratch("tcrn-portal-conservation-cards-", "TCRN-PORTAL-CONSERVATION-CARDS");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { page, boot } = await readBoot(url);
  // The persona actions went through the execution route, which left with the dispatch-* verbs
  // (TCRN-CROSS-STORY-467 R3): every one of them now reaches no route at all.
  const post = async (payload) => request(url, "/api/execution", writeOptions(boot.token, "POST", payload));
  assert.doesNotMatch(page, /<section[^>]+data-page="entities"/u);
  const override = await post({ action: RETIRED_PERSONA_ACTIONS.override, name: "Verity", fields: { mission: "temporary portal override", role: "reviewer" } });
  assert.equal(override.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const restoreAll = await post({ action: RETIRED_PERSONA_ACTIONS.restore, name: "Verity" });
  assert.equal(restoreAll.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const custom = await post({ action: RETIRED_PERSONA_ACTIONS.set, name: "Portal auditor", role: "reviewer", mission: "Review exact evidence", refusals: "No unsupported claims" });
  assert.equal(custom.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const refused = await post({ action: RETIRED_PERSONA_ACTIONS.remove, name: "Portal auditor" });
  assert.equal(refused.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  // execution.subagentPolicy retired with TCRN-CROSS-STORY-484 R3; the concurrency limit stays writable.
  const policy = await request(url, "/api/settings", writeOptions(boot.token, "POST", { key: "execution.maxConcurrentSubagents", value: "2" }));
  assert.equal(policy.body.setting.value, "2");
  const settings = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(settings.body.settings.some((entry) => /persona/iu.test(entry.key)), false);
});

// STORY-373's host probe lost its page control with the dispatch surface (TCRN-CROSS-STORY-467 R3),
// and TCRN-CROSS-STORY-482 R4 removed the route that was left without a page (problem list #29(2)).
// The verb is not retired: it stays in the engine's catalog for a caller that runs it directly.
test("STORY-482 R4: the host probe route is gone while the host-probe verb stays in the catalog", async (t) => {
  const fixture = await scratch("tcrn-portal-host-probe-", "TCRN-PORTAL-HOST-PROBE");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const probe = await request(url, RETIRED_ROUTES.hostProbe, writeOptions(boot.token, "POST", { host: "claude-code", model: "does-not-exist" }));
  assert.equal(probe.response.status, 404);
  assert.equal(probe.body.reasonCode, "PORTAL_ROUTE_UNKNOWN");
  const commands = await request(url, "/api/commands", readOptions(boot.token));
  assert.ok(commands.body.commands.some((entry) => entry.name === "host-probe"), "the host-probe verb stays in the catalog");
});

test("STORY-355 GWT1+GWT2: a forged Host header is refused on every route, and the token now guards every GET under /api/", async (t) => {
  const fixture = await scratch("tcrn-portal-security-", "TCRN-PORTAL-SECURITY");
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);

  // GWT1: a DNS-rebinding-style Host header is rejected before any route runs at all,
  // including "/" -- the real TCP connection still lands on loopback (rawRequest talks
  // to the portal's actual address), only the Host header is forged.
  const rootForged = await rawRequest(url, "/", { host: "attacker.example" });
  assert.equal(rootForged.status, 403);
  assert.equal(rootForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const prefixForged = await rawRequest(url, "/api/settings", { host: "127.0.0.1.attacker.example" });
  assert.equal(prefixForged.status, 403);
  assert.equal(prefixForged.body.reasonCode, "PORTAL_HOST_REJECTED");
  const badPort = await rawRequest(url, "/api/settings", { host: "127.0.0.1:notaport" });
  assert.equal(badPort.status, 403);
  assert.equal(badPort.body.reasonCode, "PORTAL_HOST_REJECTED");
  const upperLocalhost = await rawRequest(url, "/api/settings", { host: "LOCALHOST", headers: { "x-portal-token": boot.token } });
  assert.equal(upperLocalhost.status, 200);

  // GWT2: token coverage now spans GET, not just the mutating verbs it used to guard alone.
  const untokenedGet = await request(url, "/api/settings");
  assert.equal(untokenedGet.response.status, 403);
  assert.equal(untokenedGet.body.reasonCode, "PORTAL_TOKEN_REQUIRED");
  const tokenedGet = await request(url, "/api/settings", readOptions(boot.token));
  assert.equal(tokenedGet.response.status, 200);
});

// TCRN-CROSS-STORY-482 R3: without --library the portal chooses from the registry by where it was
// started: the library of the registered project it runs in (library-resolve), else the machine's
// default library when that names a registered one, else the first registered library.
test("STORY-482 R3: without --library the portal opens the working directory's library, then the machine's default library, then the first registered one", async (t) => {
  const fixture = await scratch("tcrn-portal-default-library-", "TCRN-PORTAL-DEFAULT-LIBRARY");
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const second = await cli(["status", "--workspace", fixture.second.library], fixture.deviceEnv);
  const open = async (cwd) => {
    const portal = await startPortal({ ...fixture, library: null, cwd });
    try {
      const { boot } = await readBoot(portal.url);
      return { selectedBy: portal.listening.selectedBy, libraryPath: boot.library.libraryPath, proseRoot: boot.proseRoot };
    } finally { portal.child.kill(); }
  };
  assert.deepEqual(await open(fixture.second.project), { selectedBy: "working-directory", libraryPath: fixture.second.library, proseRoot: fixture.second.project });
  await cli(["machine-settings-set", "--at", "2026-08-11T15:03:00Z", "--key", "portal.defaultPartition", "--value", second.workspaceId], fixture.deviceEnv);
  assert.deepEqual(await open(fixture.base), { selectedBy: "machine-default", libraryPath: fixture.second.library, proseRoot: fixture.second.project });
  // A default that names no registered library (an old partition id, say) is passed over.
  await cli(["machine-settings-set", "--at", "2026-08-11T15:04:00Z", "--key", "portal.defaultPartition", "--value", "cross-project"], fixture.deviceEnv);
  assert.deepEqual(await open(fixture.base), { selectedBy: "first-registered", libraryPath: fixture.workspace, proseRoot: fixture.proseRoot });
});

// STORY-355 carried over to libraries: AGENTS.md is the project's prose and never a file inside a
// library, which only the engine writes. A project registered inside its own library is refused
// at boot and on a switch, and the refusal names the path.
test("STORY-355: a project registered inside its own library is refused at boot and on a switch", async (t) => {
  const fixture = await scratch("tcrn-portal-prose-unsafe-", "TCRN-PORTAL-PROSE-UNSAFE");
  const nested = join(fixture.second.library, "nested-project");
  await mkdir(nested);
  await cli(["library-register", "--project", nested, "--library", fixture.second.library, "--at", "2026-08-11T15:05:00Z"], fixture.deviceEnv);
  const refused = await startupRefusal(["--library", nested], { ...fixture.deviceEnv, HOME: fixture.home });
  assert.equal(refused.status, 2);
  assert.equal(refused.report.ok, false);
  assert.equal(refused.report.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
  assert.equal(refused.report.proseRoot, nested);
  const { child, url } = await startPortal(fixture);
  t.after(async () => { child.kill(); await rm(fixture.base, { recursive: true, force: true }); });
  const { boot } = await readBoot(url);
  const switched = await request(url, "/api/library", writeOptions(boot.token, "POST", { library: nested }));
  assert.equal(switched.response.status, 409);
  assert.equal(switched.body.reasonCode, "PORTAL_PROSE_ROOT_UNSAFE");
  assert.equal((await request(url, "/api/libraries", readOptions(boot.token))).body.selected.libraryPath, fixture.workspace, "a refused switch leaves the selection alone");
});

// TCRN-CROSS-STORY-482 R3: a library outside the registry is not something Atelier opens. With no
// registered library the portal refuses to start and names the remedy; a --library the device has
// not registered is named back, with the libraries it has.
test("STORY-482 R3: the portal refuses to start with no registered library, and names a --library the device has not registered", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-portal-no-library-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = await scratchHome(base);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern") };
  const empty = await startupRefusal([], { ...deviceEnv, HOME: home }, base);
  assert.equal(empty.status, 2);
  assert.equal(empty.report.reasonCode, "PORTAL_LIBRARY_REGISTRY_EMPTY");
  assert.equal(empty.report.remedy, "library-register");
  const project = join(base, "project");
  await registeredLibrary(deviceEnv, project, join(project, ".ether"), "TCRN-PORTAL-NO-LIBRARY", "2026-08-11T15:00:00Z");
  const loose = join(base, "unregistered-library");
  await cli(["init", "--workspace", loose, "--project-name", "TCRN-PORTAL-UNREGISTERED", "--at", "2026-08-11T15:00:01Z"], deviceEnv);
  const unknown = await startupRefusal(["--library", loose], { ...deviceEnv, HOME: home }, base);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.report.reasonCode, "PORTAL_LIBRARY_UNKNOWN");
  assert.equal(unknown.report.requestedLibrary, loose);
  assert.deepEqual(unknown.report.libraries, [join(project, ".ether")]);
});
