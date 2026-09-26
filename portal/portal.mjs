#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Atelier — Einzbern's zero-dependency local portal, a projection of the public CLI.
// The portal owns no governance state. Chain reads and writes go through the
// bundled CLI; AGENTS.md is ordinary workspace prose and is handled with fs.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LOCALE_CONTRACT } from "./locale-contract.mjs";
import { DIRECTORY, LEGACY_CONTAINER_DIRECTORY } from "../scripts/lib/names.mjs";

const execFileAsync = promisify(execFile);
const portalRoot = dirname(fileURLToPath(import.meta.url));
const ACTOR = (process.env.TCRN_PORTAL_ACTOR ?? "agent:portal").trim();
const BUNDLED_CLI = join(portalRoot, "..", "scripts", "einzbern.mjs");
const CLI = process.env.TCRN_WORKFLOW_CLI ?? BUNDLED_CLI;
const ATELIER_SURFACE = Object.freeze({ EINZBERN_SURFACE: "atelier" });
const PROSE_FILES = Object.freeze(["AGENTS.md"]);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function startupError(reasonCode, detail, message = reasonCode) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  error.detail = detail;
  return error;
}

function failStartup(error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    reasonCode: error?.reasonCode ?? "PORTAL_STARTUP_FAILED",
    ...(error?.detail ?? {}),
    error: String(error?.message ?? error),
  })}\n`);
  process.exit(2);
}

// TCRN-CROSS-STORY-482 R3, AC1: Atelier opens the libraries this device has registered, read
// through library-list (the device directory's registry.json), and switches among them. It
// starts on the library --library names (its path or id, or its registered project); without
// one, on the library library-resolve finds from the directory the portal was started in; then
// on the portal.defaultPartition machine preference when it names a registered library; and
// otherwise on the first registered library. There is no container or partition any more: a
// library outside the registry is not something Atelier opens.
const libraryArgument = argument("library", process.env.TCRN_PORTAL_LIBRARY ?? "");
const portArgument = argument("port", process.env.TCRN_PORTAL_PORT ?? "");
const TOKEN = randomBytes(24).toString("hex");
let lastWriteAt = 0;

async function cli(args, environment = {}) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: portalRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...environment, NODE_NO_WARNINGS: "1" },
  });
  return JSON.parse(stdout);
}

// STORY-281: machine preferences are read through the engine, never by parsing the
// file here — the engine owns validation, and a second reader would be a second set of
// rules. An unreadable layer degrades to "no preference" rather than refusing to open
// the portal: these are conveniences, and none of them is worth a startup failure.
async function machineSettings() {
  try { return await cli(["machine-settings-catalog"]); } catch { return null; }
}
async function machineValue(key) {
  const catalogue = await machineSettings();
  return catalogue?.settings?.find((entry) => entry.key === key)?.currentValue ?? null;
}

async function cliResult(args, environment = {}) {
  try { return { ok: true, body: await cli(args, environment) }; } catch (error) {
    const raw = String(error?.stderr ?? error?.stdout ?? "").trim();
    try { return { ok: false, body: JSON.parse(raw) }; } catch {
      return { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: raw || String(error?.message ?? error) } };
    }
  }
}

const publicLibrary = ({ projectPath, libraryId, libraryPath }) => ({ projectPath, libraryId, libraryPath });

// The registry's own order (by project path). A registry entry is keyed by its project: two
// projects may share one library, and the Rules page belongs to the project.
async function readLibraryCatalog() {
  const result = await cliResult(["library-list"]);
  if (!result.ok || !Array.isArray(result.body?.entries)) {
    throw startupError(result.body?.reasonCode ?? "PORTAL_LIBRARY_LIST_FAILED", {}, result.body?.error ?? "library-list failed");
  }
  return result.body.entries
    .filter((entry) => typeof entry?.projectPath === "string" && typeof entry?.libraryPath === "string" && typeof entry?.libraryId === "string")
    .map(publicLibrary);
}

let libraryCatalog;
try { libraryCatalog = await readLibraryCatalog(); } catch (error) { failStartup(error); }
if (libraryCatalog.length === 0) {
  failStartup(startupError("PORTAL_LIBRARY_REGISTRY_EMPTY", { remedy: "library-register" }, "this device has no registered library; register one with library-register"));
}

// INC-203: the switcher is the portal's whole answer to "which libraries exist", so it asks the
// registry on every read rather than remembering the one it saw at boot. A read that fails, or
// that lists nothing, keeps the last good catalog: a transient error must not empty the switcher
// of the library the page is showing.
async function refreshLibraryCatalog() {
  try {
    const next = await readLibraryCatalog();
    if (next.length > 0) libraryCatalog = next;
  } catch { /* keep the last good catalog */ }
  return libraryCatalog;
}

// A library's id, its path, or its registered project's path. Paths are compared as the registry
// stores them, real; an id shared by two projects names the first of them.
async function matchLibrary(catalog, value) {
  const text = String(value ?? "");
  if (text === "") return null;
  const byId = catalog.find((entry) => entry.libraryId === text);
  if (byId) return byId;
  let path = resolve(text);
  try { path = await realpath(path); } catch { /* an absent path matches nothing below */ }
  return catalog.find((entry) => entry.libraryPath === path) ?? catalog.find((entry) => entry.projectPath === path) ?? null;
}

// STORY-355 carried over: AGENTS.md is the project's prose and never a file inside a library or
// an old chain container, which only the engine writes. A registry entry whose project sits
// inside its own library (or inside an old container) is refused rather than edited.
function proseRootFor(library) {
  const root = resolve(library.projectPath);
  const inside = relative(resolve(library.libraryPath), root);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)) || root.split(sep).includes(LEGACY_CONTAINER_DIRECTORY)) {
    throw startupError("PORTAL_PROSE_ROOT_UNSAFE", { proseRoot: root, library: library.libraryPath }, "the project's AGENTS.md must not resolve inside a library or an old chain container");
  }
  return root;
}

async function initialLibrary() {
  if (libraryArgument) {
    const named = await matchLibrary(libraryCatalog, libraryArgument);
    if (!named) {
      throw startupError("PORTAL_LIBRARY_UNKNOWN", {
        requestedLibrary: libraryArgument,
        libraries: libraryCatalog.map(({ libraryPath }) => libraryPath),
      }, "--library names no library this device has registered");
    }
    return { library: named, selectedBy: "argument" };
  }
  const resolved = await cliResult(["library-resolve", "--cwd", process.cwd()]);
  const found = resolved.ok ? libraryCatalog.find((entry) => entry.projectPath === resolved.body?.projectPath) : undefined;
  if (found) return { library: found, selectedBy: "working-directory" };
  const preferred = await matchLibrary(libraryCatalog, await machineValue("portal.defaultPartition"));
  if (preferred) return { library: preferred, selectedBy: "machine-default" };
  return { library: libraryCatalog[0], selectedBy: "first-registered" };
}

let selectedLibrary;
let selectedBy;
try {
  ({ library: selectedLibrary, selectedBy } = await initialLibrary());
  // Fail at boot rather than on the first Rules read.
  proseRootFor(selectedLibrary);
} catch (error) { failStartup(error); }

const currentLibrary = () => selectedLibrary;
const currentProseRoot = () => proseRootFor(currentLibrary());
// The rail's name for a library is its project's folder name; the id and the path are shown
// beside it.
const libraryName = (library) => basename(library.projectPath) || library.libraryId;

const settingsCatalog = () => cli(["settings-catalog", "--workspace", currentLibrary().libraryPath]);
const vocabulary = () => cli(["vocabulary"]);
const commands = () => cli(["commands"]);
const ruleListing = () => cliResult(["rule-list", "--project", currentLibrary().projectPath]);

function readInstant() {
  return new Date().toISOString();
}

async function workProjection() {
  const selected = currentLibrary();
  const result = await cliResult(["work-list", "--workspace", selected.libraryPath, "--limit", "4096"]);
  if (!result.ok) return { ok: false, reasonCode: "PORTAL_WORK_READ_FAILED", source: result.body, records: [], total: 0 };
  return { ok: true, reasonCode: "PORTAL_WORK_READY", workspaceId: result.body.workspaceId ?? null, version: result.body.version ?? null, headEventHash: result.body.headEventHash ?? null, total: result.body.total ?? result.body.records?.length ?? 0, records: result.body.records ?? [] };
}

async function knowledgeProjection() {
  const selected = currentLibrary();
  const at = readInstant();
  // TCRN-CROSS-MIN-225 (TCRN-CROSS-SUB-259): the knowledge view never read the retire-proposals
  // answer fetched beside the list, so that call, a full telemetry read on every load, is gone.
  const listing = await cliResult(["knowledge-list", "--workspace", selected.libraryPath, "--at", at, "--selection", "all", "--allow-trailing", "true"]);
  return {
    ok: listing.ok,
    reasonCode: listing.ok ? "PORTAL_KNOWLEDGE_READY" : "PORTAL_KNOWLEDGE_PARTIAL",
    at,
    listing: listing.body,
    records: listing.ok ? (listing.body.records ?? []) : [],
    total: listing.ok ? (listing.body.total ?? listing.body.records?.length ?? 0) : 0,
  };
}

async function knowledgeBody(id) {
  const selected = currentLibrary();
  const result = await cliResult([
    "knowledge-body",
    "--workspace", selected.libraryPath,
    "--id", String(id ?? ""),
    "--at", readInstant(),
  ]);
  return result;
}

// TCRN-CROSS-STORY-482 R4: the evolution panel (conflict retirements through knowledge-list, the
// retrieval evaluation through scripts/retrieval-eval.mjs), the host projection (plans and writes
// through scripts/host-render.mjs, the execution surface's last piece) and the session audit left
// with the mechanisms they showed. A settings write is answered by the engine's own receipt and
// nothing else; the portal starts no script beside the CLI.

function nextOccurredAt() {
  const now = Date.now();
  lastWriteAt = Math.max(now, lastWriteAt + 1000);
  return new Date(lastWriteAt).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

async function governedWrite(build, environment = {}) {
  const selected = currentLibrary();
  const occurredAt = nextOccurredAt();
  try {
    if (!ACTOR) throw new Error("TCRN_PORTAL_ACTOR must be a non-empty actor id");
    const common = ["--workspace", selected.libraryPath, "--at", occurredAt, "--actor", ACTOR];
    return await cliResult(build(common), environment);
  } catch (error) {
    return { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: String(error?.message ?? error) } };
  }
}

async function projectWrite(build) {
  const occurredAt = nextOccurredAt();
  try {
    if (!ACTOR) throw new Error("TCRN_PORTAL_ACTOR must be a non-empty actor id");
    const common = ["--project", currentLibrary().projectPath, "--at", occurredAt, "--actor", ACTOR];
    return await cliResult(build(common));
  } catch (error) {
    return { ok: false, body: { ok: false, reasonCode: "PORTAL_CLI_UNAVAILABLE", error: String(error?.message ?? error) } };
  }
}

const renderManagedAgents = () => projectWrite((common) => ["agents-render", ...common]);

async function rulesProjection() {
  const result = await ruleListing();
  if (!result.ok) return { ...result.body, ok: false };
  const rules = Array.isArray(result.body?.rules) ? result.body.rules : [];
  return {
    ...result.body,
    ok: true,
    pending: rules.filter((rule) => rule.state === "pending").map((rule) => ({ id: rule.section, file: "AGENTS.md", ruleId: rule.id })),
  };
}

function stableId(namespace, externalKey) {
  const key = String(externalKey).toUpperCase();
  return `${namespace}:${createHash("sha256").update(`${namespace}\u0000${key}`, "utf8").digest("hex").slice(0, 24)}`;
}

const writeSetting = (key, value) => governedWrite((common) => ["settings-set", ...common, "--key", String(key), "--value", String(value)], ATELIER_SURFACE);
const removeSetting = (key) => governedWrite((common) => ["settings-remove", ...common, "--key", String(key)], ATELIER_SURFACE);
const writeVariable = (body) => governedWrite((common) => [
  "variable-set", ...common,
  "--name", String(body.name ?? ""),
  "--type", String(body.type ?? ""),
  "--value", String(body.value ?? ""),
  ...(body.description === undefined ? [] : ["--description", String(body.description)]),
], ATELIER_SURFACE);
const removeVariable = (name) => governedWrite((common) => ["variable-remove", ...common, "--name", String(name)], ATELIER_SURFACE);
const variablesCatalog = () => cliResult(["variable-list", "--workspace", currentLibrary().libraryPath]);

async function gatesProjection() {
  const result = await cliResult(["gates-config-list", "--workspace", currentLibrary().libraryPath]);
  if (!result.ok) return { ...result.body, ok: false, gates: [] };
  return { ...result.body, ok: true, reasonCode: "PORTAL_GATES_READY", gates: Array.isArray(result.body?.records) ? result.body.records : [] };
}

function deviceHomePath() {
  const configured = process.env.EINZBERN_HOME;
  return typeof configured === "string" && configured.length > 0 ? resolve(configured) : join(homedir(), DIRECTORY.device);
}

function isGateRun(value, libraryId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value;
  return run.schemaVersion === "einzbern.gate-run.v1" && run.libraryId === libraryId &&
    typeof run.runId === "string" && typeof run.at === "string" && Number.isFinite(Date.parse(run.at)) &&
    typeof run.treeDigest === "string" && typeof run.declarationsDigest === "string" && Array.isArray(run.gates) &&
    run.gates.every((gate) => gate !== null && typeof gate === "object" && typeof gate.name === "string" && typeof gate.ok === "boolean" && typeof gate.required === "boolean") &&
    Array.isArray(run.reds);
}

async function latestGateRunProjection() {
  const libraryId = currentLibrary().libraryId;
  const match = /^(library|workspace):([a-f0-9]{24})$/u.exec(libraryId);
  if (match === null) return { ok: false, reasonCode: "PORTAL_GATE_RUN_READ_FAILED", error: "library id is invalid" };
  const directory = join(deviceHomePath(), "cache", `${match[1]}-${match[2]}`, "gate-runs");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, reasonCode: "PORTAL_GATE_RUN_READY", run: null };
    return { ok: false, reasonCode: "PORTAL_GATE_RUN_READ_FAILED", error: String(error?.message ?? error) };
  }
  let latest = null;
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
    let run;
    try { run = JSON.parse(await readFile(join(directory, entry.name), "utf8")); } catch { continue; }
    if (!isGateRun(run, libraryId)) continue;
    if (latest === null || Date.parse(run.at) > Date.parse(latest.at) || (Date.parse(run.at) === Date.parse(latest.at) && run.runId.localeCompare(latest.runId) > 0)) latest = run;
  }
  return { ok: true, reasonCode: "PORTAL_GATE_RUN_READY", run: latest };
}

function gateInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const command = body.command;
  const root = typeof body.root === "string" ? body.root : ".";
  const covers = body.covers;
  if (name === "" || !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part === "") ||
    typeof root !== "string" || !Array.isArray(covers) || covers.some((cover) => typeof cover !== "string") ||
    typeof body.required !== "boolean" || typeof body.enabled !== "boolean" || typeof body.releaseOnly !== "boolean") return null;
  return { name, command, root, covers, required: body.required, enabled: body.enabled, releaseOnly: body.releaseOnly };
}

const writeGate = (gate) => governedWrite((common) => [
  "gates-config-set", ...common,
  "--name", gate.name,
  "--command", JSON.stringify(gate.command),
  "--root", gate.root,
  "--covers", gate.covers.length === 0 ? "-" : gate.covers.join(","),
  "--required", String(gate.required),
  "--enabled", String(gate.enabled),
  "--release-only", String(gate.releaseOnly),
], ATELIER_SURFACE);
const deleteGate = (name) => governedWrite((common) => ["gates-config-remove", ...common, "--name", name], ATELIER_SURFACE);

async function completeGateWrite(name, mutation) {
  if (!mutation.ok) return { ...mutation.body, ok: false };
  const latest = await gatesProjection();
  if (!latest.ok) return { ...mutation.body, ok: false, reasonCode: latest.reasonCode ?? "PORTAL_GATES_READBACK_FAILED", mutation: mutation.body, gates: latest.gates };
  return { ...mutation.body, ok: true, gates: latest.gates, gate: latest.gates.find((entry) => entry.name === name) ?? null };
}

async function completeVariableWrite(name, result) {
  if (!result.ok) return { ok: false, body: { ...result.body, ok: false } };
  const [variables, render] = await Promise.all([variablesCatalog(), renderManagedAgents()]);
  const readback = variables.ok ? variables.body.variables?.find((entry) => entry.name === name) ?? null : null;
  if (!variables.ok || !render.ok) {
    const failure = !variables.ok ? variables.body : render.body;
    return {
      ok: false,
      body: {
        ...result.body,
        ok: false,
        reasonCode: failure?.reasonCode ?? "PORTAL_VARIABLE_WRITE_PARTIAL",
        mutation: result.body,
        readback,
        variables: variables.body?.variables ?? [],
        render: render.body,
      },
    };
  }
  return {
    ok: true,
    body: {
      ...result.body,
      ok: true,
      readback,
      variables: variables.body.variables ?? [],
      withheld: variables.body.withheld ?? [],
      render: render.body,
    },
  };
}

function proseTarget(name = PROSE_FILES[0]) {
  if (!PROSE_FILES.includes(name)) return null;
  const root = currentProseRoot();
  const candidate = resolve(root, name);
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || relation.startsWith(`..${sep}`)) return null;
  return candidate;
}

const KEY_PATTERN = /\b([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\b/gu;

async function reconcile() {
  const [catalog, variables] = await Promise.all([
    settingsCatalog(),
    cli(["variable-list", "--workspace", currentLibrary().libraryPath]),
  ]);
  const registered = new Set([
    ...catalog.settings.map((entry) => entry.key),
    ...(Array.isArray(variables.variables) ? variables.variables.map((entry) => entry.name) : []),
  ]);
  const rows = [];
  for (const name of PROSE_FILES) {
    const path = proseTarget(name);
    if (!path) continue;
    let text = "";
    try { text = await readFile(path, "utf8"); } catch { continue; }
    for (const [lineIndex, line] of text.split("\n").entries()) {
      for (const match of line.matchAll(KEY_PATTERN)) {
        const key = match[1];
        const namespace = key.slice(0, key.indexOf("."));
        if (![...registered].some((entry) => entry.startsWith(`${namespace}.`))) continue;
        const known = registered.has(key);
        rows.push({ file: name, line: lineIndex + 1, token: key, key, registered: known, kind: known ? "registered" : "unregistered" });
      }
    }
  }
  const findings = rows.filter((row) => row.kind !== "registered");
  return {
    ok: findings.length === 0,
    reasonCode: findings.length === 0 ? "PROSE_MATCHES_CATALOG" : "PROSE_CLAIMS_UNREGISTERED_KEY",
    registered: [...registered].sort(),
    rows,
    findings,
    mismatchCount: findings.length,
  };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw startupError("PORTAL_PAYLOAD_TOO_LARGE", {});
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function agentsRead(name) {
  const path = proseTarget(name);
  if (!path) return { status: 404, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE", file: name } };
  let text = "";
  try { text = await readFile(path, "utf8"); } catch { /* absent prose reads as an empty editor */ }
  return { status: 200, body: { ok: true, reasonCode: "PORTAL_AGENTS_MD_READY", file: name, path, text } };
}

async function agentsWrite(body) {
  const file = String(body.file ?? PROSE_FILES[0]);
  const path = proseTarget(file);
  if (!path) return { status: 404, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE", file } };
  const text = String(body.text ?? "");
  await writeFile(path, text, "utf8");
  const savedText = await readFile(path, "utf8");
  const rendered = await renderManagedAgents();
  const readback = await readFile(path, "utf8");
  if (!rendered.ok) {
    return {
      status: 409,
      body: {
        ok: false,
        reasonCode: rendered.body?.reasonCode ?? "PORTAL_AGENTS_RENDER_FAILED",
        file,
        path,
        saved: true,
        matches: savedText === text,
        text: readback,
        render: rendered.body,
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      reasonCode: "PORTAL_AGENTS_MD_WRITTEN",
      file,
      path,
      saved: true,
      matches: savedText === text,
      text: readback,
      sections: rendered.body.sections ?? [],
      pending: rendered.body.pending ?? [],
      render: rendered.body,
    },
  };
}

const apiAlias = (pathname) => pathname === "/api/prose" ? "/api/agents-md" : pathname === "/api/reconcile" ? "/api/agents-md/reconcile" : pathname;

// STORY-355: the portal binds loopback only, but a browser sends whatever Host header
// the request carries, and DNS rebinding lets an attacker-controlled page point that
// header at a name that still resolves to 127.0.0.1. Comparing the hostname portion for
// exact equality (never substring or prefix) closes that: `127.0.0.1.attacker.example`
// is not `127.0.0.1`. Split on the LAST colon so a port, if present, is validated as
// digits-only rather than folded into the hostname comparison.
function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? "");
  const lastColon = host.lastIndexOf(":");
  const hostname = (lastColon === -1 ? host : host.slice(0, lastColon)).toLowerCase();
  const port = lastColon === -1 ? "" : host.slice(lastColon + 1);
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  if (port !== "" && !/^[0-9]+$/u.test(port)) return false;
  return true;
}

const server = createServer(async (request, response) => {
  if (!isLoopbackHost(request.headers.host)) {
    send(response, 403, { ok: false, reasonCode: "PORTAL_HOST_REJECTED" });
    return;
  }
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = apiAlias(url.pathname);
  try {
    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(join(portalRoot, "index.html"), "utf8");
      const library = currentLibrary();
      const boot = JSON.stringify({
        token: TOKEN,
        workspace: library.libraryPath,
        library: publicLibrary(library),
        libraryName: libraryName(library),
        libraries: (await refreshLibraryCatalog()).map(publicLibrary),
        proseRoot: currentProseRoot(),
        actor: ACTOR,
        proseFiles: PROSE_FILES,
        machineDefaults: {
          locale: await machineValue("portal.defaultLocale"),
          theme: await machineValue("portal.defaultTheme"),
        },
        ...LOCALE_CONTRACT,
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html.replace("__PORTAL_BOOT__", boot.replace(/</gu, "\\u003c")));
      return;
    }
    if (request.method === "GET" && pathname === "/locales.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "locales.js"), "utf8"));
      return;
    }
    if (request.method === "GET" && pathname === "/tokens.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "tokens.css"), "utf8"));
      return;
    }
    // The file is Atelier's; its bytes are the design system's mother-brand asset, unchanged.
    if (request.method === "GET" && pathname === "/atelier-brand-mark.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "atelier-brand-mark.svg"), "utf8"));
      return;
    }
    if (!pathname.startsWith("/api/")) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }
    if (request.headers["x-portal-token"] !== TOKEN) {
      send(response, 403, { ok: false, reasonCode: "PORTAL_TOKEN_REQUIRED" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/settings") {
      send(response, 200, await settingsCatalog());
      return;
    }
    if (request.method === "GET" && pathname === "/api/rules") {
      const result = await rulesProjection();
      send(response, result.ok ? 200 : 502, result);
      return;
    }
    if (request.method === "GET" && pathname === "/api/machine-settings") {
      send(response, 200, (await machineSettings()) ?? { reasonCode: "MACHINE_SETTINGS_UNAVAILABLE", settings: [] });
      return;
    }
    if (request.method === "GET" && pathname === "/api/work") {
      send(response, 200, await workProjection());
      return;
    }
    if (request.method === "GET" && pathname === "/api/knowledge") {
      send(response, 200, await knowledgeProjection());
      return;
    }
    if (request.method === "GET" && pathname === "/api/knowledge/body") {
      const result = await knowledgeBody(url.searchParams.get("id") ?? "");
      send(response, result.ok ? 200 : 409, result.body);
      return;
    }
    if (request.method === "GET" && pathname === "/api/vocabulary") {
      send(response, 200, await vocabulary());
      return;
    }
    if (request.method === "GET" && pathname === "/api/commands") {
      send(response, 200, await commands());
      return;
    }
    if (request.method === "POST" && pathname === "/api/rules/resolve") {
      const body = await readJsonBody(request);
      const section = String(body.section ?? "");
      const action = String(body.action ?? "");
      if (!["overwrite", "keep", "unmanage"].includes(action)) {
        send(response, 400, { ok: false, reasonCode: "PORTAL_RULE_RESOLUTION_INVALID", section, action });
        return;
      }
      const result = await projectWrite((common) => [
        "rule-resolve",
        "--section", section,
        "--action", action,
        ...(body.force === true ? ["--force", "true"] : []),
        ...common,
      ]);
      const payload = { ...result.body, ok: result.ok };
      if (result.ok) {
        const latest = await rulesProjection();
        payload.rules = latest.rules ?? [];
        payload.pending = latest.pending ?? [];
      }
      send(response, result.ok ? 200 : 409, payload);
      return;
    }
    const ruleRoute = /^\/api\/rules\/([^/]+)$/u.exec(pathname);
    if (request.method === "POST" && ruleRoute !== null) {
      const body = await readJsonBody(request);
      const id = decodeURIComponent(ruleRoute[1]);
      const action = String(body.action ?? "");
      if (!["enable", "disable"].includes(action)) {
        send(response, 400, { ok: false, reasonCode: "PORTAL_RULE_ACTION_INVALID", id, action });
        return;
      }
      const result = await projectWrite((common) => [
        action === "enable" ? "rule-enable" : "rule-disable",
        "--id", id,
        ...(action === "disable" && body.force === true ? ["--force", "true"] : []),
        ...common,
      ]);
      const payload = { ...result.body, ok: result.ok };
      if (result.ok) {
        const latest = await rulesProjection();
        payload.rules = latest.rules ?? [];
        payload.pending = latest.pending ?? [];
      }
      send(response, result.ok ? 200 : 409, payload);
      return;
    }
    if (request.method === "GET" && pathname === "/api/status") {
      const selected = currentLibrary();
      const [status, validation, catalog] = await Promise.all([
        cliResult(["status", "--workspace", selected.libraryPath]),
        cliResult(["validate", "--workspace", selected.libraryPath]),
        cliResult(["settings-catalog", "--workspace", selected.libraryPath]),
      ]);
      const checks = [
        { key: "validate", ok: validation.ok, reasonCode: validation.body?.reasonCode ?? "PORTAL_VALIDATE_FAILED" },
        { key: "catalog", ok: catalog.ok, reasonCode: catalog.body?.reasonCode ?? "PORTAL_CATALOG_FAILED" },
        { key: "actor", ok: ACTOR.length > 0, reasonCode: ACTOR.length > 0 ? "PORTAL_ACTOR_CONFIGURED" : "PORTAL_ACTOR_MISSING" },
      ];
      let events = null;
      try { events = await cli(["event-list", "--workspace", selected.libraryPath, "--limit", "1"]); } catch { /* health remains legible */ }
      const body = status.body ?? {};
      send(response, 200, {
        ok: checks.every((check) => check.ok) && status.ok,
        reasonCode: checks.every((check) => check.ok) && status.ok ? "PORTAL_STATUS_READY" : "PORTAL_STATUS_DEGRADED",
        workspaceId: body.workspaceId ?? null,
        version: body.version ?? null,
        headEventHash: body.headEventHash ?? null,
        eventCount: events?.total ?? null,
        engineVersion: body.engineVersion ?? null,
        checks,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/libraries") {
      const libraries = await refreshLibraryCatalog();
      send(response, 200, { ok: true, reasonCode: "PORTAL_LIBRARIES_READY", libraries: libraries.map(publicLibrary), selected: publicLibrary(currentLibrary()) });
      return;
    }
    // The switch reads the registry afresh, so a library registered after boot can be chosen and
    // one no longer registered cannot. Every later read and write goes to the chosen library.
    if (request.method === "POST" && pathname === "/api/library") {
      const body = await readJsonBody(request);
      const requested = String(body.library ?? body.projectPath ?? "");
      const next = await matchLibrary(await refreshLibraryCatalog(), requested);
      if (!next) { send(response, 404, { ok: false, reasonCode: "PORTAL_LIBRARY_UNKNOWN", requestedLibrary: requested }); return; }
      let proseRoot;
      try { proseRoot = proseRootFor(next); } catch (error) {
        send(response, 409, { ok: false, reasonCode: error.reasonCode, ...error.detail });
        return;
      }
      selectedLibrary = next;
      send(response, 200, { ok: true, reasonCode: "PORTAL_LIBRARY_SELECTED", library: publicLibrary(next), workspace: next.libraryPath, libraryName: libraryName(next), proseRoot });
      return;
    }
    if (request.method === "POST" && pathname === "/api/settings") {
      const body = await readJsonBody(request);
      const key = String(body.key ?? "");
      const result = body.reset === true ? await removeSetting(key) : await writeSetting(key, String(body.value ?? ""));
      const render = result.ok && ["models.tiers", "design.authority"].includes(key) ? await renderManagedAgents() : null;
      const readback = result.ok ? await settingsCatalog() : null;
      const ok = result.ok && (render?.ok ?? true);
      send(response, ok ? 200 : 409, {
        ...result.body,
        ok,
        ...(render === null ? {} : { render: render.body }),
        ...(!ok && result.ok && render !== null ? { mutation: result.body, reasonCode: render.body?.reasonCode ?? "PORTAL_SETTINGS_WRITE_PARTIAL" } : {}),
        readback: readback?.settings.find((entry) => entry.key === key) ?? null,
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/variables") {
      const result = await variablesCatalog();
      send(response, result.ok ? 200 : 502, { ...result.body, ok: result.ok });
      return;
    }
    if ((request.method === "POST" || request.method === "DELETE") && pathname === "/api/variables") {
      const body = await readJsonBody(request);
      const name = String(body.name ?? "");
      const mutation = request.method === "POST" ? await writeVariable(body) : await removeVariable(name);
      const result = await completeVariableWrite(name, mutation);
      send(response, result.ok ? 200 : 409, result.body);
      return;
    }
    if (request.method === "GET" && pathname === "/api/gates") {
      const result = await gatesProjection();
      send(response, result.ok ? 200 : 502, result);
      return;
    }
    if ((request.method === "POST" || request.method === "DELETE") && pathname === "/api/gates") {
      const body = await readJsonBody(request);
      if (request.method === "POST") {
        const gate = gateInput(body);
        if (gate === null) { send(response, 400, { ok: false, reasonCode: "PORTAL_GATE_INPUT_INVALID" }); return; }
        const result = await completeGateWrite(gate.name, await writeGate(gate));
        send(response, result.ok ? 200 : 409, result);
        return;
      }
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (name === "") { send(response, 400, { ok: false, reasonCode: "PORTAL_GATE_INPUT_INVALID" }); return; }
      const mutation = await deleteGate(name);
      const result = mutation.ok ? await gatesProjection() : null;
      const payload = mutation.ok && result?.ok
        ? { ...mutation.body, ok: true, removed: name, gates: result.gates }
        : { ...mutation.body, ok: false, ...(mutation.ok ? { reasonCode: result?.reasonCode ?? "PORTAL_GATES_READBACK_FAILED", mutation: mutation.body, gates: result?.gates ?? [] } : {}) };
      send(response, payload.ok ? 200 : 409, payload);
      return;
    }
    if (request.method === "GET" && pathname === "/api/gates/last-run") {
      const result = await latestGateRunProjection();
      send(response, result.ok ? 200 : 502, result);
      return;
    }
    if (request.method === "POST" && pathname === "/api/machine-settings") {
      const body = await readJsonBody(request);
      const key = String(body.key ?? "");
      const now = new Date().toISOString();
      const result = body.reset === true
        ? await cliResult(["machine-settings-remove", "--at", now, "--key", key])
        : await cliResult(["machine-settings-set", "--at", now, "--key", key, "--value", String(body.value ?? "")]);
      const readback = result.ok ? await machineSettings() : null;
      send(response, result.ok ? 200 : 409, { ...result.body, readback: readback?.settings?.find((entry) => entry.key === key) ?? null });
      return;
    }
    if (request.method === "GET" && pathname === "/api/agents-md") {
      const result = await agentsRead(url.searchParams.get("file") ?? PROSE_FILES[0]);
      send(response, result.status, result.body);
      return;
    }
    if (request.method === "PUT" && pathname === "/api/agents-md") {
      const result = await agentsWrite(await readJsonBody(request));
      send(response, result.status, result.body);
      return;
    }
    if (request.method === "GET" && pathname === "/api/agents-md/reconcile") {
      send(response, 200, await reconcile());
      return;
    }
    // TCRN-CROSS-STORY-482 R4, AC3: every other API path is unknown, the retired ones included:
    // execution, the retired gates projection, evolution, the session audit and the host probe.
    // The host-probe verb stays in the CLI; only its page route is gone.
    send(response, 404, { ok: false, reasonCode: "PORTAL_ROUTE_UNKNOWN" });
  } catch (error) {
    send(response, 500, { ok: false, reasonCode: error?.reasonCode ?? "PORTAL_INTERNAL_ERROR", error: String(error?.message ?? error) });
  }
});

const port = Number(portArgument || (await machineValue("portal.port")) || "4319");
server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  process.stdout.write(`${JSON.stringify({
    reasonCode: "PORTAL_LISTENING",
    url: `http://127.0.0.1:${bound}/`,
    workspace: currentLibrary().libraryPath,
    library: publicLibrary(currentLibrary()),
    selectedBy,
    libraries: libraryCatalog.length,
    proseRoot: currentProseRoot(),
    actor: ACTOR,
    cli: CLI,
  })}\n`);
});
