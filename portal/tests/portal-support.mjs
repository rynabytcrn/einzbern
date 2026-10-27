// SPDX-License-Identifier: Apache-2.0
// Portal integration tests use the real CLI and a real governed scratch tree.

// Every CLI and portal child inherits the test process's device directory, never the real one.
import "../../tests/helpers/device-home.mjs";
import { appendHistoricalModelSetting } from "../../tests/helpers/historical-model-settings.mjs";
import { forgeOwnStream } from "../../tests/helpers/library-forge.mjs";
// Another process on the device unregistering a library or bringing up the coordination chain is
// stood in for through the helper, outside the portal tree (TCRN-CROSS-INIT-053 R45 PP-1).
import { ensureProjectCoordination, unregisterLibrary } from "../../tests/helpers/registry-control.mjs";
import { appendHistoricalAttestationEnable } from "../../tests/helpers/workspace-fixture.mjs";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { registerLibraries } from "../../tests/helpers/register-portal-libraries.mjs";

const withoutSource = ({ source, declaredHere, ...record }) => record;
const execFileAsync = promisify(execFile);
const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = process.env.TCRN_WORKFLOW_CLI ?? join(portalRoot, "..", "scripts", "einzbern.mjs");
// TCRN-CROSS-STORY-526 (TCRN-CROSS-SUB-454): Atelier starts only with TCRN_PORTAL_ACTOR set, so every
// portal and launcher child here writes as this test actor unless a test says otherwise.
const TEST_ACTOR = "agent:test-portal";
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
  return (await registerLibraries([{ project, library, externalKey, projectKey: `${externalKey}-PROJECT`, times: [at, at, at] }], deviceEnv))[0];
}

async function scratch(prefix, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = await scratchHome(base);
  const deviceEnv = { EINZBERN_HOME: join(base, "device", "einzbern"), HOME: home };
  const proseRoot = join(base, "project");
  const workspace = join(proseRoot, ".ether");
  const second = { project: join(base, "second-project"), library: join(base, "second-library") };
  let projectId;
  try {
    [projectId, second.projectId] = await registerLibraries([
      { project: proseRoot, library: workspace, externalKey, projectKey: `${externalKey}-PROJECT`, times: Array(3).fill("2026-08-11T15:00:00Z") },
      { ...second, externalKey: `${externalKey}-SECOND`, projectKey: `${externalKey}-SECOND-PROJECT`, times: Array(3).fill("2026-08-11T15:00:01Z") },
    ], deviceEnv);
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
  return { base, workspace, proseRoot, home, deviceEnv, second, projectId };
}

// `library` names the library to open first; null starts the portal without --library, so it
// chooses from the registry by its working directory (`cwd`).
async function startPortal({ workspace, home, deviceEnv = {}, env = {}, library = workspace, cwd, configBackupRoot }) {
  assert.ok(home, "every portal child needs a scratch HOME inside its fixture (TCRN-CROSS-INC-386)");
  const args = [join(portalRoot, "portal.mjs")];
  if (library !== null) args.push("--library", library);
  if (configBackupRoot !== undefined) args.push("--config-backup-root", configBackupRoot);
  args.push("--port", "0");
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: TEST_ACTOR, ...deviceEnv, ...env, HOME: home },
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
    const child = spawn(process.execPath, [join(portalRoot, "portal.mjs"), ...args, "--port", "0"], { env: { ...process.env, TCRN_WORKFLOW_CLI: CLI, TCRN_PORTAL_ACTOR: TEST_ACTOR, ...env }, ...(cwd === undefined ? {} : { cwd }), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolveSpawn({ status: code, report: JSON.parse(stderr.trim().split("\n").at(-1) || "{}"), lines: stderr.trim() === "" ? 0 : stderr.trim().split("\n").length }));
  });
}

const clientTargets = new Map();
const visibleTarget = (library, epoch) => ({ epoch, libraryId: library.libraryId, projectId: Object.hasOwn(library, "configurationProjectId") ? library.configurationProjectId : library.projectId ?? null });
async function readBoot(url) {
  const page = await (await fetch(url)).text();
  assert.ok(!page.includes("__PORTAL_BOOT__"));
  const boot = JSON.parse(page.match(/const BOOT = (\{.*\});/u)[1]);
  clientTargets.set(boot.token, visibleTarget(boot.library, boot.epoch));
  return { page, boot };
}

function request(url, path, options) { return fetch(new URL(path, url), options).then(async (response) => { const body = await response.json(); if (body.ok && body.library && ["/api/library", "/api/configuration-scope"].includes(path)) clientTargets.set(options.headers["x-portal-token"], visibleTarget(body.library, body.epoch)); return { response, body }; }); }
function writeOptions(token, method, body) { return { method, headers: { "content-type": "application/json", "x-portal-token": token, "x-configuration-target": JSON.stringify(clientTargets.get(token)) }, body: JSON.stringify(body) }; }
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

// TCRN-CROSS-SUB-403 (STORY-482 Goal, R3): a library larger than one work-list read. It holds an
// Initiative, an Epic and LARGE_STORIES Stories of some eleven KB each: more records than the
// portal's page of 100, and more bytes than one work-list page may carry, so the unpaged read the
// work view used to make is refused, and so is a page of 100.
const LARGE_STORIES = 120;
const LARGE_BATCH = 40;

async function largeLibrary(fixture) {
  const projectId = (await cli(["project-create", "--workspace", fixture.workspace, "--at", "2026-08-11T15:10:00Z", "--external-key", "PORTAL-LARGE-PROJECT", "--name", "Large"], fixture.deviceEnv)).record.id;
  const common = ["--workspace", fixture.workspace, "--project-id", projectId];
  const initiative = await cli(["work-create", ...common, "--at", "2026-08-11T15:10:01Z", "--external-key", "PORTAL-LARGE-INIT", "--kind", "Initiative", "--title", "Large library"], fixture.deviceEnv);
  const epic = await cli(["work-create", ...common, "--at", "2026-08-11T15:10:02Z", "--external-key", "PORTAL-LARGE-EPIC", "--kind", "Epic", "--parent-id", initiative.record.id, "--title", "Large epic"], fixture.deviceEnv);
  const text = (label, length) => `${label} `.padEnd(length, "large library text ");
  for (let batch = 0; batch * LARGE_BATCH < LARGE_STORIES; batch += 1) {
    const members = Array.from({ length: LARGE_BATCH }, (_, index) => {
      const number = batch * LARGE_BATCH + index;
      return {
        verb: "work-create", projectId, externalKey: `PORTAL-LARGE-${String(number).padStart(3, "0")}`, kind: "Story",
        parentId: epic.record.id, status: "planned", title: `Large story ${number}`,
        goal: text(`Goal ${number}`, 2100), acceptance: text(`GIVEN story ${number} WHEN listed THEN read whole`, 2100), body: text(`Body ${number}`, 6300),
      };
    });
    const file = join(fixture.base, `large-${batch}.json`);
    await writeFile(file, `${JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members })}\n`, "utf8");
    await cli(["work-batch", "--workspace", fixture.workspace, "--at", `2026-08-11T15:1${batch + 1}:00Z`, "--from-file", file], fixture.deviceEnv);
  }
}

async function cliRefusal(args, env = {}) {
  try { await cli(args, env); } catch (error) { return JSON.parse(String(error.stderr ?? "").trim().split("\n").at(-1) || "{}"); }
  return assert.fail(`${args[0]} was expected to refuse`);
}

// The library read page by page straight from the CLI, the reading /api/work must agree with.
async function pagedWork(fixture, limit) {
  let first = null;
  const records = [];
  for (let offset = 0; first === null || offset < first.total; offset += limit) {
    const page = await cli(["work-list", "--workspace", fixture.workspace, "--limit", String(limit), "--offset", String(offset)], fixture.deviceEnv);
    first ??= page;
    assert.deepEqual([page.version, page.headEventHash, page.total], [first.version, first.headEventHash, first.total]);
    records.push(...page.records);
  }
  return { workspaceId: first.workspaceId, version: first.version, headEventHash: first.headEventHash, total: first.total, ids: records.map((record) => record.id), records };
}

// Stands in front of the real CLI. It logs every work-list the portal asks for (its limit and
// offset, and when it began and ended), and by the mode the test writes it passes the page on,
// makes a real write to the library before a page past the first (once, or on every read), answers
// every page as over the budget, or (delay) answers a page larger than the cap for its offset as
// over the budget and holds every other page for the delay given for its offset before passing it
// on. Since TCRN-CROSS-SUB-416 the pages past the first are read several at once, so the writes
// take turns under a lock, each at the next instant.
const WORK_PAGES_WRAPPER = `import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const state = process.env.TCRN_TEST_WORK_STATE;
const began = Date.now();
const run = (args, env = {}) => spawnSync(process.execPath, [process.env.TCRN_TEST_REAL_CLI, ...args], { encoding: "utf8", maxBuffer: 64e6, env: { ...process.env, ...env } });
const flag = (name) => { const index = argv.indexOf("--" + name); return index >= 0 ? argv[index + 1] : undefined; };
const pause = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const pass = () => { const actual = run(argv); return { status: actual.status ?? 1, stdout: actual.stdout || "", stderr: actual.stderr || "" }; };
const oversized = { status: 1, stdout: "", stderr: JSON.stringify({ ok: false, reasonCode: "CLI_WORK_LIST_OVERSIZED", error: "work-list page exceeds the canonical byte budget; lower --limit" }) + "\\n" };
const inTurn = (work) => {
  const lock = join(state, "write.lock");
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) { if (error.code !== "EEXIST") throw error; pause(10); }
  }
  try { return work(); } finally { rmdirSync(lock); }
};
const workList = () => {
  const setting = JSON.parse(readFileSync(join(state, "mode.json"), "utf8"));
  const offset = flag("offset") ?? "0";
  if (setting.mode === "oversized") return oversized;
  if (Number(flag("limit")) > (setting.cap ?? Infinity)) return oversized;
  if (setting.mode === "delay") {
    if (Number(flag("limit")) > (setting.caps?.[offset] ?? setting.cap ?? Infinity)) return oversized;
    pause(setting.delays?.[offset] ?? 0);
    return pass();
  }
  if ((setting.mode === "move-always" || setting.mode === "move-once") && offset !== "0") {
    const refused = inTurn(() => {
      if (setting.mode === "move-once" && existsSync(join(state, "moved"))) return null;
      writeFileSync(join(state, "moved"), "");
      const writes = existsSync(join(state, "writes")) ? Number(readFileSync(join(state, "writes"), "utf8")) : 0;
      writeFileSync(join(state, "writes"), String(writes + 1));
      const at = new Date(Date.parse("2026-08-11T16:00:00Z") + writes * 1000).toISOString().replace(/\\.\\d{3}Z$/u, "Z");
      const write = run(["settings-set", "--workspace", flag("workspace"), "--at", at, "--actor", "agent:test", "--key", "retrieval.scopeExcerptBytes", "--value", String(600 + writes)], { EINZBERN_SURFACE: "atelier" });
      return write.status === 0 ? null : { status: write.status ?? 1, stdout: "", stderr: write.stderr || "" };
    });
    if (refused !== null) return refused;
  }
  return pass();
};
const answer = argv[0] === "work-list" ? workList() : pass();
if (argv[0] === "work-list") appendFileSync(join(state, "calls.log"), JSON.stringify({ limit: flag("limit") ?? null, offset: flag("offset") ?? null, began, ended: Date.now() }) + "\\n");
process.stdout.write(answer.stdout);
process.stderr.write(answer.stderr);
process.exitCode = answer.status;
`;

// The wrapper's state directory and its two controls: the mode the next work-list calls run
// under, and the calls logged since the last look (each call is logged as it ends).
async function workPagesHarness(fixture) {
  const state = join(fixture.base, "work-pages");
  await mkdir(state);
  const wrapper = join(fixture.base, "work-pages-wrapper.mjs");
  await writeFile(wrapper, WORK_PAGES_WRAPPER, "utf8");
  const mode = (value) => writeFile(join(state, "mode.json"), JSON.stringify(typeof value === "string" ? { mode: value } : value), "utf8");
  const calls = async () => {
    const log = await readFile(join(state, "calls.log"), "utf8").catch(() => "");
    await writeFile(join(state, "calls.log"), "", "utf8");
    return log.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  };
  await mode("pass");
  return { mode, calls, env: { TCRN_WORKFLOW_CLI: wrapper, TCRN_TEST_REAL_CLI: CLI, TCRN_TEST_WORK_STATE: state } };
}

// A call as [limit, offset]. The pages past the first are read several at once, so they are
// logged in the order they end; `unordered` puts them in offset order (the larger page first).
const pageOf = ({ limit, offset }) => [limit, offset];
const unordered = (pages) => [...pages].sort((left, right) => Number(left[1]) - Number(right[1]) || Number(right[0]) - Number(left[0]));

// One managed section as a file holds it, markers included (the format managed-sections.ts
// documents), or null.
function managedSection(text, id) {
  const match = new RegExp(`<!-- einzbern:section id=${id} rev=(\\d+) digest=([a-f0-9]{64}) -->\\n([\\s\\S]*?)<!-- einzbern:section-end id=${id} -->\\n?`, "u").exec(text);
  return match === null ? null : { raw: match[0], rev: Number(match[1]), digest: match[2], body: match[3] };
}

// A section body as its digest is taken: LF line ends, no trailing blanks, one final line feed.
function normalizedSection(text) {
  const joined = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.replace(/[ \t]+$/u, "")).join("\n").replace(/\n+$/u, "");
  return joined === "" ? "" : `${joined}\n`;
}
const sectionDigest = (body) => createHash("sha256").update(normalizedSection(body), "utf8").digest("hex");

// TCRN-CROSS-INIT-053 R46 helpers: the target an answer names in x-portal-served-target (I05), and a
// read that names the target it was made for, as the page's requests do.
const servedBy = (response) => JSON.parse(response.headers.get("x-portal-served-target"));
const shownTarget = (library, epoch) => ({ epoch, libraryId: library.libraryId, projectPath: library.projectPath, projectId: library.configurationProjectId ?? null, chainRole: library.chain?.role ?? null });
function namedRead(token, target) { return { headers: { "x-portal-token": token, "x-configuration-target": JSON.stringify(target) } }; }
const R46_AT = "2026-10-09T09:00:00Z";

// TCRN-CROSS-INIT-053 R47 (c1-B; Owner 2026-10-09, round 7): on a coordination chain /api/settings lists its ten
// runtime settings, each for the whole library, and a write from a selection that names the chain's project is
// made at the library level, as the catalog's scope says; a model table stays refused by the engine.
const R47_COORDINATION_KEYS = ["agents.generation", "agents.sharedNavigation", "artifact.language", "engine.requiredVersion", "execution.maxConcurrentSubagents", "quota.fiveHourParallelOffPercent", "quota.fiveHourWaitPercent", "quota.weeklyParallelOffPercent", "quota.weeklyWaitPercent", "storage.segmentBytes", "storage.snapshotEveryEvents", "workspace.generatedArtifactsPath"];

// TCRN-CROSS-STORY-526 GWT4 (MIN-256; TCRN-CROSS-SUB-454): Atelier writes as the actor it is started
// with. Started with TCRN_PORTAL_ACTOR, a gate it saves is recorded with surface atelier and, on a
// library that records its writers, that actor; started without it, or with it empty, it refuses to
// start with one JSON line and exit code 2, and so does a generated launcher run without it.
async function asDevice(fixture, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = fixture.deviceEnv.EINZBERN_HOME;
  try {
    return await operation();
  } finally {
    process.env.EINZBERN_HOME = previous;
  }
}
export { CLI, LARGE_STORIES, R46_AT, R47_COORDINATION_KEYS, RETIRED_PERSONA_ACTIONS, RETIRED_ROUTES, TEST_ACTOR, appendHistoricalAttestationEnable, appendHistoricalModelSetting, asDevice, assert, cli, cliRefusal, clientTargets, ensureProjectCoordination, execFileAsync, forgeOwnStream, httpRequest, join, largeLibrary, lstat, managedSection, mkdir, mkdtemp, namedRead, normalizedSection, pageOf, pagedWork, portalRoot, rawRequest, readBoot, readFile, readOptions, realpath, registeredLibrary, request, rm, scratch, scratchHome, sectionDigest, servedBy, shownTarget, spawn, startPortal, startupRefusal, test, tmpdir, unordered, unregisterLibrary, withoutSource, workPagesHarness, writeFile, writeOptions };
