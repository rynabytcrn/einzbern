#!/usr/bin/env node
import { RUNTIME_CAPACITY } from "../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0
//
// Atelier — Einzbern's zero-dependency local portal, a projection of the public CLI.
// The portal owns no governance state. Chain reads and writes go through the
// bundled CLI; AGENTS.md is ordinary workspace prose and is handled with fs.

import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Hold the same device registry lock used by register/unregister/repoint until
// the CLI's library lock and all output writes finish. This is exclusion, not
// another preflight or an authentication mechanism. The lock and its path come
// through the registry-lock bridge, as the names do through names.mjs.
import { withFileLock, registryPath } from "../scripts/lib/registry-lock.mjs";

import { LOCALE_CONTRACT } from "./locale-contract.mjs";
import { DIRECTORY, LEGACY_CONTAINER_DIRECTORY } from "../scripts/lib/names.mjs";

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

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
    maxBuffer: RUNTIME_CAPACITY.bufferBytes,
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

const publicLibrary = ({ projectPath, libraryId, libraryPath, projectId, configurationProjectId, name, chain }) => ({ projectPath, libraryId, libraryPath, projectId: projectId ?? null, configurationProjectId: configurationProjectId ?? null, name: name ?? null, chain: chain ?? null });

// The registry's own order (by project path). A registry entry is keyed by its project: two
// projects may share one library, and the Rules page belongs to the project.
async function readLibraryCatalog() {
  const result = await cliResult(["library-list"]);
  if (!result.ok || !Array.isArray(result.body?.entries)) {
    throw startupError(result.body?.reasonCode ?? "PORTAL_LIBRARY_LIST_FAILED", {}, result.body?.error ?? "library-list failed");
  }
  const entries = result.body.entries
    .filter((entry) => typeof entry?.projectPath === "string" && typeof entry?.libraryPath === "string" && typeof entry?.libraryId === "string")
    .map(publicLibrary);
  return Promise.all(entries.map(async entry => {
    const [projects, identity] = await Promise.all([cliResult(["project-list", "--workspace", entry.libraryPath]), cliResult(["chain-identity", "--workspace", entry.libraryPath])]);
    if (projects.ok && projects.body.workspaceId !== entry.libraryId) throw startupError("PORTAL_LIBRARY_IDENTITY_MISMATCH", { expected: entry.libraryId, actual: projects.body.workspaceId }, "registered location holds a different library");
    const project = projects.body?.records?.find(project => project.id === entry.projectId);
    return { ...entry, name: project?.name ?? null, chain: identity.ok ? identity.body.identity : null };
  }));
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
  if (selectedLibrary.chain?.role !== "coordination") proseRootFor(selectedLibrary);
} catch (error) { failStartup(error); }

let selectedConfigurationProjectId = selectedLibrary.projectId ?? null;
let selectionEpoch = 0;
let activeTargetWrites = 0;
const requestContext = new AsyncLocalStorage();
const currentLibrary = () => requestContext.getStore()?.library ?? { ...selectedLibrary, configurationProjectId: selectedConfigurationProjectId };
const scopeArguments = (library = currentLibrary()) => library.configurationProjectId == null ? [] : ["--project-id", library.configurationProjectId];
const boundProseLibrary = (library = currentLibrary()) => library.chain?.role === "coordination" || library.configurationProjectId == null ? null : libraryCatalog.find((entry) => entry.libraryId === library.libraryId && entry.projectId === library.configurationProjectId) ?? null;
const currentProseRoot = () => { const bound = boundProseLibrary(); return bound === null ? null : proseRootFor(bound); };
// The rail's name for a library is its project's folder name; the id and the path are shown
// beside it.
const libraryName = (library) => library.name ?? (library.chain?.role === "coordination" ? "Cross Project" : "Unconfigured project");

const settingsCatalog = (library = currentLibrary()) => cli(["settings-catalog", "--workspace", library.libraryPath, ...scopeArguments(library)]);
const vocabulary = () => cli(["vocabulary"]);
const commands = () => cli(["commands"]);
const ruleListing = () => cliResult(["rule-list", "--workspace", currentLibrary().libraryPath, ...scopeArguments()]);

function readInstant() {
  return new Date().toISOString();
}

// TCRN-CROSS-SUB-403 (TCRN-CROSS-STORY-482 Goal, R3): Atelier opens any library in the registry,
// the large ones too. One work-list read of a library of some fifteen hundred records runs past
// the CLI's one-MiB page budget and is refused (CLI_WORK_LIST_OVERSIZED), so the work view reads
// in pages of at most WORK_PAGE_LIMIT records by --offset. Every page must answer for the library
// the first page answered for: the same workspace, version, head and total. A page that does not
// means the library moved during the read, and the read starts over rather than join two versions
// of it; after WORK_READ_ATTEMPTS reads that never held still, the view is refused. A page the
// budget refuses is asked for again at half the size, and a page of one record that the budget
// still refuses is the refusal. The /api/work result is the one it always was.
//
// TCRN-CROSS-SUB-416 (TCRN-CROSS-STORY-510): read one page after another, that library took a
// minute. The first page is still read alone: it names the version, head and total every other
// page must answer for, and the page size the budget allows. The pages after it are planned from
// that size in stretches of one page each and read WORK_PAGE_CONCURRENCY stretches at a time;
// every page is checked against the first as before, and the records are put back together in
// offset order. A page the budget refuses is halved within its own stretch, and no page reaches
// past its stretch into the next one.
// Processing windows and retry budgets, not dataset admission limits. A caller can
// choose different budgets without a source edit; the complete view still has to
// carry one identity and the exact reported total.
function workReadBudget(name, fallback) {
  const declared = process.env[name];
  const value = declared === undefined ? fallback : Number(declared);
  if (!Number.isSafeInteger(value) || value < 1 || (declared !== undefined && !/^[1-9][0-9]*$/u.test(declared))) {
    throw startupError("PORTAL_WORK_READ_BUDGET_INVALID", { name }, `${name} must be a positive safe integer`);
  }
  return value;
}
const WORK_PAGE_LIMIT = workReadBudget("TCRN_PORTAL_WORK_PAGE_RECORDS", 100);
const WORK_PAGE_CONCURRENCY = workReadBudget("TCRN_PORTAL_WORK_PAGE_CONCURRENCY", 4);
const WORK_READ_ATTEMPTS = workReadBudget("TCRN_PORTAL_WORK_READ_ATTEMPTS", 3);
const WORK_PAGE_OVERSIZED = "CLI_WORK_LIST_OVERSIZED";

function workPageIdentity(page) {
  return {
    workspaceId: page?.workspaceId ?? null,
    version: page?.version ?? null,
    headEventHash: page?.headEventHash ?? null,
    total: Number.isSafeInteger(page?.total) && page.total >= 0 ? page.total : null,
  };
}

const sameWorkPage = (left, right) => left.workspaceId === right.workspaceId && left.version === right.version &&
  left.headEventHash === right.headEventHash && left.total === right.total;

// One work-list page at `offset` of at most `limit` records. It answers read (the size that was
// read, the page's identity and its records) or failed (a refusal of the CLI's, passed on as it
// came). A page the budget refuses is asked for again at half the size, and a page of one record
// that the budget still refuses is the refusal.
async function readWorkPage(libraryPath, offset, limit) {
  let size = limit;
  for (;;) {
    const read = await cliResult(["work-list", "--workspace", libraryPath, "--limit", String(size), "--offset", String(offset)]);
    if (read.ok) {
      const identity = workPageIdentity(read.body);
      if (identity.total === null) return { state: "failed", source: { ok: false, reasonCode: "PORTAL_WORK_PAGE_MALFORMED", offset } };
      return { state: "read", size, identity, records: Array.isArray(read.body.records) ? read.body.records : [] };
    }
    if (read.body?.reasonCode !== WORK_PAGE_OVERSIZED || size <= 1) return { state: "failed", source: read.body };
    size = Math.max(1, Math.floor(size / 2));
  }
}

// The records of one stretch past the first page, [offset, end), page by page, every page checked
// against the first. A page the budget refused stays halved for the rest of its stretch, and a page
// never reaches past the stretch's end, save on the last stretch: its end is the total, and it asks
// for whole pages as the serial read did.
async function readWorkStretch(libraryPath, first, { offset, end, limit, last }) {
  const records = [];
  let size = limit;
  while (offset + records.length < end) {
    const at = offset + records.length;
    const page = await readWorkPage(libraryPath, at, last ? size : Math.min(size, end - at));
    if (page.state !== "read") return page;
    if (!sameWorkPage(first, page.identity)) return { state: "unsettled", cause: "moved" };
    if (page.records.length === 0) return { state: "unsettled", cause: "short-page" };
    size = page.size;
    records.push(...page.records);
  }
  return { state: "read", records };
}

// The stretches in offset order, at most WORK_PAGE_CONCURRENCY of them out at once. Once one answers
// anything but read, no later stretch is started; every stretch before that one was started, and
// all that were started are let finish, so each of them has its answer. The answers come back in
// stretch order.
async function readWorkStretches(libraryPath, first, stretches) {
  const outcomes = [];
  let next = 0;
  let stopped = false;
  const reader = async () => {
    while (!stopped && next < stretches.length) {
      const index = next;
      next += 1;
      outcomes[index] = await readWorkStretch(libraryPath, first, stretches[index]);
      if (outcomes[index].state !== "read") stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORK_PAGE_CONCURRENCY, stretches.length) }, reader));
  return outcomes;
}

// One pass over the library: the first page, then the stretches after it. It answers read (every
// record of one version, in offset order), failed (a refusal of the CLI's, passed on as it came)
// or unsettled (the pages did not add up to one version of the library: it moved, or a page
// repeated or skipped a record). The answers are taken in offset order: the first stretch that did
// not read is the one reported, and a record seen twice is found as the records are put together.
async function readWorkPages(libraryPath) {
  const head = await readWorkPage(libraryPath, 0, WORK_PAGE_LIMIT);
  if (head.state !== "read") return head;
  const first = head.identity;
  if (head.records.length === 0 && first.total > 0) return { state: "unsettled", cause: "short-page" };
  const stretches = [];
  for (let offset = head.records.length; offset < first.total; offset += head.size) {
    const end = Math.min(offset + head.size, first.total);
    stretches.push({ offset, end, limit: head.size, last: end === first.total });
  }
  const outcomes = [{ state: "read", records: head.records }, ...await readWorkStretches(libraryPath, first, stretches)];
  const records = [];
  const seen = new Set();
  for (const outcome of outcomes) {
    if (outcome.state !== "read") return outcome;
    for (const record of outcome.records) {
      const id = record?.id;
      if (typeof id !== "string" || seen.has(id)) return { state: "unsettled", cause: "repeated-record" };
      seen.add(id);
      records.push(record);
    }
  }
  if (records.length !== first.total) return { state: "unsettled", cause: "short-page" };
  return { state: "read", identity: first, records };
}

async function workProjection() {
  const selected = currentLibrary();
  let outcome = { state: "unsettled", cause: "moved" };
  for (let attempt = 1; attempt <= WORK_READ_ATTEMPTS && outcome.state === "unsettled"; attempt += 1) {
    outcome = await readWorkPages(selected.libraryPath);
  }
  if (outcome.state === "failed") return { ok: false, reasonCode: "PORTAL_WORK_READ_FAILED", source: outcome.source, records: [], total: 0 };
  if (outcome.state === "unsettled") {
    return {
      ok: false,
      reasonCode: "PORTAL_WORK_READ_FAILED",
      source: { ok: false, reasonCode: "PORTAL_WORK_READ_UNSTABLE", attempts: WORK_READ_ATTEMPTS, cause: outcome.cause, error: "no attempt read work-list pages that add up to one version of the library; nothing mixed is shown" },
      records: [],
      total: 0,
    };
  }
  const { identity, records } = outcome;
  return { ok: true, reasonCode: "PORTAL_WORK_READY", workspaceId: identity.workspaceId, version: identity.version, headEventHash: identity.headEventHash, total: identity.total, records };
}

// TCRN-CROSS-SUB-425 (MIN-239 D6): the knowledge list answers valid cards unless the viewer picks
// another status; removed cards come back as each is kept, with no body to read.
const KNOWLEDGE_STATUSES = Object.freeze(["valid", "removed", "all"]);

async function knowledgeProjection(status = "valid") {
  const selected = currentLibrary();
  const at = readInstant();
  // TCRN-CROSS-MIN-225 (TCRN-CROSS-SUB-259): the knowledge view never read the retire-proposals
  // answer fetched beside the list, so that call, a full telemetry read on every load, is gone.
  const listing = await cliResult(["knowledge-list", "--workspace", selected.libraryPath, "--at", at, "--selection", "all", "--status", status, "--allow-trailing", "true"]);
  return {
    ok: listing.ok,
    reasonCode: listing.ok ? "PORTAL_KNOWLEDGE_READY" : "PORTAL_KNOWLEDGE_PARTIAL",
    at,
    status,
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

async function targetWrite(selected, operation) {
  activeTargetWrites += 1;
  try {
    return await withFileLock(`${registryPath()}.lock`, async () => {
      const registrations = await readLibraryCatalog();
      if (requestContext.getStore()?.epoch !== selectionEpoch || selectedLibrary.libraryId !== selected.libraryId ||
          !registrations.some(entry => entry.libraryId === selected.libraryId && entry.libraryPath === selected.libraryPath && entry.projectPath === selected.projectPath && entry.projectId === selected.projectId)) {
        return { ok: false, body: { ok: false, reasonCode: "PORTAL_CONFIGURATION_TARGET_CHANGED" } };
      }
      const identity = await cliResult(["status", "--workspace", selected.libraryPath]);
      if (!identity.ok || identity.body.workspaceId !== selected.libraryId) return { ok: false, body: { ok: false, reasonCode: "PORTAL_CONFIGURATION_TARGET_CHANGED" } };
      libraryCatalog = registrations;
      return operation();
    });
  } catch (error) {
    return { ok: false, body: { ok: false, reasonCode: error.reasonCode ?? "PORTAL_CLI_UNAVAILABLE", error: String(error?.message ?? error) } };
  } finally { activeTargetWrites -= 1; }
}

async function governedWrite(build, environment = {}, selected = currentLibrary()) {
  return targetWrite(selected, async () => {
    if (!ACTOR) throw new Error("TCRN_PORTAL_ACTOR must be a non-empty actor id");
    const common = ["--workspace", selected.libraryPath, "--at", nextOccurredAt(), "--actor", ACTOR, ...scopeArguments(selected)];
    return cliResult(build(common), environment);
  });
}

async function projectWrite(build, environment = {}, selected = currentLibrary(), runtimeRule = false) {
  return targetWrite(selected, async () => {
    if (!ACTOR) throw new Error("TCRN_PORTAL_ACTOR must be a non-empty actor id");
    const coordinationRule = runtimeRule && selected.chain?.role === "coordination";
    const bound = coordinationRule ? libraryCatalog.find(entry => entry.libraryId === selected.libraryId && entry.projectId === selected.configurationProjectId) : boundProseLibrary(selected);
    if (bound == null) return { ok: false, body: { ok: false, reasonCode: "PORTAL_PROJECT_BINDING_UNCONFIGURED", projectId: selected.configurationProjectId ?? null } };
    const projectPath = coordinationRule ? bound.projectPath : proseRootFor(bound);
    if (await realpath(projectPath) !== projectPath) throw startupError("PORTAL_PROSE_ROOT_UNSAFE", { projectPath });
    const common = ["--project", projectPath, "--at", nextOccurredAt(), "--actor", ACTOR, ...scopeArguments(selected)];
    return cliResult(build(common), environment);
  });
}

const renderManagedAgents = (library = currentLibrary()) => boundProseLibrary(library) === null
  ? Promise.resolve({ ok: true, body: { ok: true, reasonCode: "PORTAL_PROJECT_BINDING_UNCONFIGURED", outputBindingStatus: "unconfigured", pending: true, projectId: library.configurationProjectId ?? null } })
  : projectWrite((common) => ["agents-render", ...common], {}, library);

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

const writeSetting = (key, value, library) => governedWrite((common) => ["settings-set", ...common, "--key", String(key), "--value", String(value)], ATELIER_SURFACE, library);
const removeSetting = (key, library) => governedWrite((common) => ["settings-remove", ...common, "--key", String(key)], ATELIER_SURFACE, library);

// TCRN-CROSS-STORY-508 R8 (TCRN-CROSS-SUB-409, contract C-R14-6): the keys the system variables
// section of AGENTS.md shows. A write of one, or its removal, renders the managed sections again, so
// AGENTS.md follows the value; the escalation keys join the section under their prefix.
const SYSTEM_VARIABLE_KEYS = Object.freeze(["design.authority", "models.category", "models.tiers"]);
const rendersSystemVariables = (key) => SYSTEM_VARIABLE_KEYS.includes(key) || key.startsWith("models.escalation.") || key.startsWith("design.");

// TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R5, R6; contracts C-R14-2, C-R14-6): a collection key is
// a table of records, written whole, so the engine judges the whole table and refuses it with one
// reason code. The rows that code is about are found here, from the table as it was sent and the two
// tables as they stand, so the page can show the code on each of them: a repeated order on every row
// that shares it, a repeated category id on every row that shares it, and an unknown category on
// every tier that names one. A dropped category that tiers or the escalation ceiling still name is no
// row of the table sent, so it comes with what names it: the tier records, and
// models.escalation.ceiling (TCRN-CROSS-SUB-406); a restore of the default category table is refused
// only for such a category, and says which. After a write that renders the system variables section,
// every record the render withheld (secret-shaped or absolute-path) is reported on its row.
// A finding's `index` is the row's place in the table the page shows next: the table it sent when the
// write was refused, the stored table when the write landed. Any other refusal names no row, and the
// page shows it above the table with the engine's own words.
const COLLECTION_KEYS = Object.freeze(["models.category", "models.tiers"]);
const COLLECTION_IDENTITY = Object.freeze({ "models.category": "id", "models.tiers": "order" });
const ESCALATION_CEILING_KEY = "models.escalation.ceiling";

function tableOf(text) {
  try {
    const value = JSON.parse(String(text ?? ""));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const recordOf = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const storedTable = (catalog, key) => tableOf(catalog?.settings?.find((entry) => entry.key === key)?.currentValue) ?? [];

function rowsSharing(rows, field) {
  const counts = new Map();
  const valueOf = (row) => JSON.stringify(recordOf(row)[field] ?? null);
  for (const row of rows) counts.set(valueOf(row), (counts.get(valueOf(row)) ?? 0) + 1);
  return rows.flatMap((row, index) => (counts.get(valueOf(row)) ?? 0) > 1 ? [index] : []);
}

function refusedCollectionFindings(key, sent, refusal, catalog) {
  const rows = tableOf(sent);
  const reasonCode = refusal?.reasonCode;
  if (rows === null || typeof reasonCode !== "string") return [];
  const on = (indices, field) => indices.map((index) => ({ index, field, reasonCode }));
  if (reasonCode === "MODELS_ORDER_DUPLICATE") return on(rowsSharing(rows, "order"), "order");
  if (reasonCode === "MODELS_CATEGORY_DUPLICATE" && key === "models.category") return on(rowsSharing(rows, "id"), "id");
  if (reasonCode === "MODELS_CATEGORY_UNKNOWN" && key === "models.tiers") {
    const known = new Set(storedTable(catalog, "models.category").map((category) => recordOf(category).id));
    return on(rows.flatMap((row, index) => known.has(recordOf(row).category) ? [] : [index]), "category");
  }
  if (reasonCode === "MODELS_CATEGORY_IN_USE" && key === "models.category") {
    const kept = new Set(rows.map((row) => recordOf(row).id));
    const tiers = storedTable(catalog, "models.tiers").map(recordOf);
    // TCRN-CROSS-SUB-406 (TCRN-CROSS-STORY-508 R3): the escalation ceiling names a category too, and a
    // write may not drop it either, so it is listed beside the tier records as models.escalation.ceiling.
    const ceiling = catalog?.settings?.find((entry) => entry.key === ESCALATION_CEILING_KEY)?.currentValue;
    return storedTable(catalog, "models.category").map((category) => recordOf(category).id).filter((id) => !kept.has(id)).flatMap((category) => {
      const references = [
        ...tiers.filter((tier) => tier.category === category).map((tier) => `models.tiers.${tier.order}`),
        ...(category === ceiling ? [ESCALATION_CEILING_KEY] : []),
      ];
      return references.length === 0 ? [] : [{ index: null, field: "id", reasonCode, category, references }];
    });
  }
  return [];
}

// A settings-remove of models.category puts back the default categories and every other category the
// stored tiers name (specs/settings-catalog-v1.md), so a restore drops only categories no tier names;
// when one of them is the ceiling's, the refusal is named against that table, above the page's table.
function restoredCategoryTable(catalog) {
  const defaults = tableOf(catalog?.settings?.find((entry) => entry.key === "models.category")?.defaultValue) ?? [];
  const ids = new Set(defaults.map((category) => recordOf(category).id));
  const named = storedTable(catalog, "models.tiers").map((tier) => recordOf(tier).category).filter((id) => typeof id === "string" && !ids.has(id));
  return [...defaults, ...[...new Set(named)].map((id) => ({ id }))];
}

function refusedRestoreFindings(key, refusal, catalog) {
  if (key !== "models.category") return [];
  return refusedCollectionFindings(key, JSON.stringify(restoredCategoryTable(catalog)), refusal, catalog).filter((finding) => finding.index === null);
}

function withheldCollectionFindings(key, render, stored) {
  const rows = tableOf(stored?.currentValue) ?? [];
  const identity = COLLECTION_IDENTITY[key];
  const withheld = Array.isArray(render?.withheld) ? render.withheld : [];
  return withheld.flatMap((entry) => {
    const index = rows.findIndex((row) => entry?.name === `${key}.${recordOf(row)[identity]}`);
    return index < 0 ? [] : [{ index, field: null, reasonCode: String(entry.reason ?? "withheld") }];
  });
}

// TCRN-CROSS-SUB-410 (TCRN-CROSS-STORY-508 R7; contract C-R14-5): a variable, a rule and a gate each
// take an optional order, passed to the engine as it was typed so the engine, not the portal, says what
// is wrong with it. An empty order is no --order: variable-set then writes a variable without one,
// and rule-enable and gates-config-set keep the order the record holds.
const orderArguments = (order) => order === undefined || order === null || String(order).trim() === "" ? [] : ["--order", String(order).trim()];

const writeVariable = (body) => governedWrite((common) => [
  "variable-set", ...common,
  "--name", String(body.name ?? ""),
  "--type", String(body.type ?? ""),
  "--value", String(body.value ?? ""),
  ...(body.description === undefined ? [] : ["--description", String(body.description)]),
  ...orderArguments(body.order),
], ATELIER_SURFACE);
const removeVariable = (name) => governedWrite((common) => ["variable-remove", ...common, "--name", String(name)], ATELIER_SURFACE);
const variablesCatalog = () => cliResult(["variable-list", "--workspace", currentLibrary().libraryPath, ...scopeArguments()]);

async function gatesProjection() {
  const result = await cliResult(["gates-config-list", "--workspace", currentLibrary().libraryPath, ...scopeArguments()]);
  if (!result.ok) return { ...result.body, ok: false, gates: [] };
  return { ...result.body, ok: true, reasonCode: "PORTAL_GATES_READY", gates: Array.isArray(result.body?.records) ? result.body.records : [] };
}

function deviceHomePath() {
  const configured = process.env.EINZBERN_HOME;
  return typeof configured === "string" && configured.length > 0 ? resolve(configured) : join(homedir(), DIRECTORY.device);
}

function isGateRun(value, libraryId, projectId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value;
  return run.schemaVersion === "einzbern.gate-run.v1" && run.libraryId === libraryId && (run.projectId ?? null) === projectId &&
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
    if (!isGateRun(run, libraryId, currentLibrary().configurationProjectId)) continue;
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
    typeof body.required !== "boolean" || typeof body.enabled !== "boolean" || typeof body.releaseOnly !== "boolean" ||
    !(body.order === undefined || body.order === null || typeof body.order === "number" || typeof body.order === "string")) return null;
  return { name, command, root, covers, required: body.required, enabled: body.enabled, releaseOnly: body.releaseOnly, order: body.order };
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
  ...orderArguments(gate.order),
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
  if (root === null) return null;
  const candidate = resolve(root, name);
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || relation.startsWith(`..${sep}`)) return null;
  return candidate;
}

const KEY_PATTERN = /\b([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\b/gu;

async function reconcile() {
  const [catalog, variables] = await Promise.all([
    settingsCatalog(),
    cli(["variable-list", "--workspace", currentLibrary().libraryPath, ...scopeArguments()]),
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
        // TCRN-CROSS-SUB-410: a token naming a family of registered keys claims no key of its own, such
        // as the heading models.escalation the system variables section gives the three escalation keys.
        const known = registered.has(key) || [...registered].some((entry) => entry.startsWith(`${key}.`));
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
    if (size > RUNTIME_CAPACITY.bufferBytes) throw startupError("PORTAL_PAYLOAD_TOO_LARGE", {});
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function agentsRead(name) {
  const path = proseTarget(name);
  if (!path) return { status: currentProseRoot() === null ? 200 : 404, body: { ok: currentProseRoot() === null, reasonCode: currentProseRoot() === null ? "PORTAL_PROJECT_BINDING_UNCONFIGURED" : "PORTAL_PATH_ESCAPE", file: name, text: "", outputBindingStatus: "unconfigured" } };
  let text = "";
  try { text = await readFile(path, "utf8"); } catch { /* absent prose reads as an empty editor */ }
  return { status: 200, body: { ok: true, reasonCode: "PORTAL_AGENTS_MD_READY", file: name, path, text } };
}

// TCRN-CROSS-SUB-338 (TCRN-CROSS-STORY-483 R3, AC2; MIN-235 D4, judgment 1.5 (a)): a save writes
// the file the user edited and judges it; it renders nothing. The judgment is rule-list, which
// writes nothing, so a rule section changed by one character reads user-modified, AGENTS.md is
// the bytes that were saved, and no section goes pending. The managed sections are rendered by
// the engine writes that change what they show (a setting, a variable, a rule), never by a save.
async function agentsWrite(body) {
  const file = String(body.file ?? PROSE_FILES[0]);
  const path = proseTarget(file);
  if (!path) return { status: 404, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE", file } };
  const text = String(body.text ?? "");
  // Refuse symlinked files as well as a replaced project root before opening.
  if (await realpath(dirname(path)) !== dirname(path)) return { status: 409, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE" } };
  const existing = await realpath(path).catch(error => { if (error.code === "ENOENT") return path; throw error; });
  if (existing !== path) return { status: 409, body: { ok: false, reasonCode: "PORTAL_PATH_ESCAPE" } };
  await writeFile(path, text, "utf8");
  const readback = await readFile(path, "utf8");
  const saved = { file, path, saved: true, matches: readback === text, text: readback };
  const judged = await rulesProjection();
  if (!judged.ok) {
    return { status: 409, body: { ...saved, ok: false, reasonCode: judged.reasonCode ?? "PORTAL_RULES_READ_FAILED", rules: [], pending: [], source: judged } };
  }
  return { status: 200, body: { ...saved, ok: true, reasonCode: "PORTAL_AGENTS_MD_WRITTEN", rules: judged.rules ?? [], pending: judged.pending } };
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

const server = createServer((request, response) => requestContext.run({ epoch: selectionEpoch, library: { ...selectedLibrary, configurationProjectId: selectedConfigurationProjectId } }, async () => {
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
        epoch: selectionEpoch,
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
    if (request.method === "GET" && pathname === "/ds-static-bridges.snapshot.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(portalRoot, "ds-static-bridges.snapshot.js"), "utf8")); return;
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
    if (["POST", "PUT", "DELETE"].includes(request.method) && !["/api/library", "/api/configuration-scope", "/api/machine-settings"].includes(pathname)) {
      let expected;
      try { expected = JSON.parse(String(request.headers["x-configuration-target"] ?? "")); } catch { expected = null; }
      const target = currentLibrary();
      if (expected?.epoch !== selectionEpoch || expected?.libraryId !== target.libraryId || (expected?.projectId ?? null) !== (target.configurationProjectId ?? null)) {
        send(response, 409, { ok: false, reasonCode: "PORTAL_CONFIGURATION_TARGET_CHANGED", target: { libraryId: target.libraryId, projectId: target.configurationProjectId ?? null } }); return;
      }
    }
    // TCRN-CROSS-SUB-409 (TCRN-CROSS-STORY-508 R5, contract C-R14-1): both catalogs are passed on as
    // the engine wrote them, so every row keeps its shape, group and order; the page lays the settings
    // out from those three and keeps no grouping of its own.
    if (request.method === "GET" && pathname === "/api/settings") {
      send(response, 200, await settingsCatalog());
      return;
    }
    if (request.method === "POST" && pathname === "/api/configuration-scope") {
      if (activeTargetWrites > 0) { send(response, 409, { ok: false, reasonCode: "PORTAL_CONFIGURATION_WRITE_PENDING" }); return; }
      const epoch = ++selectionEpoch;
      const library = currentLibrary();
      const body = await readJsonBody(request);
      const projectId = body.projectId === null ? null : String(body.projectId ?? "");
      const available = await settingsCatalog(library);
      if (projectId !== null && !available.projects.some((entry) => entry.id === projectId)) { send(response, 404, { ok: false, reasonCode: "PORTAL_PROJECT_SCOPE_UNKNOWN" }); return; }
      const target = { ...library, configurationProjectId: projectId, name: available.projects.find(entry => entry.id === projectId)?.name ?? library.name };
      const catalog = projectId === library.configurationProjectId ? available : await settingsCatalog(target);
      if (activeTargetWrites > 0 || epoch !== selectionEpoch || selectedLibrary.libraryId !== library.libraryId) { send(response, 409, { ok: false, reasonCode: "PORTAL_CONFIGURATION_TARGET_CHANGED" }); return; }
      selectedConfigurationProjectId = projectId;
      requestContext.getStore().library = target;
      send(response, 200, { ok: true, reasonCode: "PORTAL_CONFIGURATION_SCOPE_SELECTED", epoch: selectionEpoch, projectId, library: publicLibrary(target), settings: catalog, proseRoot: currentProseRoot(), outputBindingStatus: boundProseLibrary() === null ? "unconfigured" : "bound" });
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
    if (["POST", "DELETE"].includes(request.method) && pathname === "/api/project-bindings") {
      const library = currentLibrary();
      const body = await readJsonBody(request);
      if (library.configurationProjectId === null || library.chain?.role === "coordination") { send(response, 409, { ok: false, reasonCode: "PORTAL_PROJECT_BINDING_UNCONFIGURED" }); return; }
      const remove = request.method === "DELETE";
      const result = await governedWrite(common => [remove ? "project-bindings-remove" : "project-bindings-set", ...common, "--key", String(body.key), ...(remove ? [] : ["--value", JSON.stringify(body.value)])], ATELIER_SURFACE, library);
      send(response, result.ok ? 200 : 409, { ...result.body, ok: result.ok }); return;
    }
    if (request.method === "GET" && pathname === "/api/project-targets") {
      // A target carries the project's own name or null, never an English stand-in: the page names an
      // unnamed project in the reader's language (TCRN-CROSS-INIT-053 R45 U14).
      const entries = await refreshLibraryCatalog();
      const targets = [...new Map(entries.filter(entry => entry.projectId && entry.chain?.role === "project").map(entry => [JSON.stringify([entry.libraryId, entry.projectId]), { libraryId: entry.libraryId, projectId: entry.projectId, name: entry.name ?? null }])).values()];
      send(response, 200, { targets }); return;
    }
    if (request.method === "GET" && pathname === "/api/work/project-context") {
      const result = await cliResult(["work-project-context", "--workspace", currentLibrary().libraryPath, "--id", url.searchParams.get("id") ?? ""]);
      send(response, result.ok ? 200 : 409, result.body); return;
    }
    if (request.method === "POST" && pathname === "/api/work/involved-projects") {
      const selected = currentLibrary();
      const body = await readJsonBody(request);
      const result = await governedWrite(common => ["work-annotate", ...common, "--id", String(body.id ?? ""), "--expected-revision", String(body.revision), "--involved-projects", JSON.stringify(body.involvedProjects)], {}, { ...selected, configurationProjectId: null });
      send(response, result.ok ? 200 : 409, { ...result.body, ok: result.ok }); return;
    }
    if (request.method === "GET" && pathname === "/api/work") {
      send(response, 200, await workProjection());
      return;
    }
    if (request.method === "GET" && pathname === "/api/knowledge") {
      const status = url.searchParams.get("status") ?? "valid";
      if (!KNOWLEDGE_STATUSES.includes(status)) { send(response, 400, { ok: false, reasonCode: "PORTAL_KNOWLEDGE_STATUS_INVALID", status }); return; }
      send(response, 200, await knowledgeProjection(status));
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
      // TCRN-CROSS-SUB-410 (STORY-508 R7): an enable carries the rule's order when one is given; the
      // engine places the rule's section by it and keeps it through a later disable. Both run for
      // Atelier (TCRN-CROSS-SUB-422).
      const result = await projectWrite((common) => [
        action === "enable" ? "rule-enable" : "rule-disable",
        "--id", id,
        ...(action === "disable" && body.force === true ? ["--force", "true"] : []),
        ...(action === "enable" ? orderArguments(body.order) : []),
        ...common,
      ], ATELIER_SURFACE, currentLibrary(), true);
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
      // Doctor's device-stream check briefly probes the selected library, so let it finish before status reads that library.
      const doctor = await cliResult(["doctor", "--project", selected.projectPath]);
      const status = await cliResult(["status", "--workspace", selected.libraryPath]);
      const body = status.body ?? {};
      const doctorBody = doctor.body ?? {};
      const checks = Array.isArray(doctorBody.checks) ? doctorBody.checks : [];
      const failedCheck = checks.find((check) => check?.ok === false && typeof check?.reasonCode === "string");
      const ready = doctor.ok && doctorBody.ok === true && checks.length === 8 && checks.every((check) => check.ok === true) && status.ok;
      send(response, 200, {
        ok: ready,
        reasonCode: ready ? "PORTAL_STATUS_READY" : "PORTAL_STATUS_DEGRADED",
        doctorReasonCode: failedCheck?.reasonCode ?? doctorBody.reasonCode ?? "PORTAL_DOCTOR_FAILED",
        workspaceId: body.workspaceId ?? null,
        version: body.version ?? null,
        headEventHash: body.headEventHash ?? null,
        eventCount: body.version ?? null,
        engineVersion: body.engineVersion ?? null,
        checks,
        library: {
          versionVector: body.versionVector ?? null,
          streams: Array.isArray(body.streams) ? body.streams : null,
          rejectedEventCount: body.rejectedEventCount ?? null,
          configProjection: body.configProjection ?? null,
        },
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
      if (activeTargetWrites > 0) { send(response, 409, { ok: false, reasonCode: "PORTAL_CONFIGURATION_WRITE_PENDING" }); return; }
      const epoch = ++selectionEpoch;
      const body = await readJsonBody(request);
      const requested = String(body.library ?? body.projectPath ?? "");
      const next = await matchLibrary(await refreshLibraryCatalog(), requested);
      if (!next) { send(response, 404, { ok: false, reasonCode: "PORTAL_LIBRARY_UNKNOWN", requestedLibrary: requested }); return; }
      let proseRoot;
      try { proseRoot = next.chain?.role === "coordination" ? null : proseRootFor(next); } catch (error) {
        send(response, 409, { ok: false, reasonCode: error.reasonCode, ...error.detail });
        return;
      }
      if (activeTargetWrites > 0 || epoch !== selectionEpoch) { send(response, 409, { ok: false, reasonCode: "PORTAL_CONFIGURATION_TARGET_CHANGED" }); return; }
      selectedLibrary = next;
      selectedConfigurationProjectId = next.projectId ?? null;
      requestContext.getStore().library = { ...next, configurationProjectId: selectedConfigurationProjectId };
      send(response, 200, { ok: true, reasonCode: "PORTAL_LIBRARY_SELECTED", epoch: selectionEpoch, library: publicLibrary(currentLibrary()), workspace: next.libraryPath, libraryName: libraryName(next), proseRoot });
      return;
    }
    if (request.method === "POST" && pathname === "/api/settings") {
      // Bind the whole operation before awaiting the request body. A switch can
      // never redirect the mutation, managed prose render, or receipt readback.
      const library = currentLibrary();
      const body = await readJsonBody(request);
      if ((body.libraryId !== undefined && body.libraryId !== library.libraryId)
        || (body.libraryPath !== undefined && body.libraryPath !== library.libraryPath)
        || currentLibrary() !== library) {
        send(response, 409, { ok: false, reasonCode: "PORTAL_LIBRARY_CHANGED", library: publicLibrary(currentLibrary()) });
        return;
      }
      const key = String(body.key ?? "");
      const reset = body.reset === true;
      const value = String(body.value ?? "");
      const declaredScope = (await settingsCatalog(library)).settings.find((entry) => entry.key === key)?.scope;
      const writeTarget = declaredScope === "library" ? { ...library, configurationProjectId: null } : library;
      const result = reset ? await removeSetting(key, writeTarget) : await writeSetting(key, value, writeTarget);
      const render = result.ok && rendersSystemVariables(key) ? await renderManagedAgents(library) : null;
      const collection = COLLECTION_KEYS.includes(key);
      const catalog = result.ok || collection ? await settingsCatalog(library) : null;
      const readback = result.ok ? catalog?.settings.find((entry) => entry.key === key) ?? null : null;
      const ok = result.ok && (render?.ok ?? true);
      const findings = !collection ? null
        : result.ok ? withheldCollectionFindings(key, render?.body, readback)
        : reset ? refusedRestoreFindings(key, result.body, catalog) : refusedCollectionFindings(key, value, result.body, catalog);
      send(response, ok ? 200 : 409, {
        ...result.body,
        ok,
        library: publicLibrary(library),
        ...(render === null ? {} : { render: render.body }),
        ...(!ok && result.ok && render !== null ? { mutation: result.body, reasonCode: render.body?.reasonCode ?? "PORTAL_SETTINGS_WRITE_PARTIAL" } : {}),
        readback,
        ...(findings === null ? {} : { findings }),
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
      const body = await readJsonBody(request);
      const result = await targetWrite(currentLibrary(), () => agentsWrite(body));
      send(response, result.status ?? (result.ok ? 200 : 409), result.body);
      return;
    }
    if (request.method === "GET" && pathname === "/api/agents-md/reconcile") {
      send(response, 200, await reconcile());
      return;
    }
    // TCRN-CROSS-STORY-482 R4, AC3: every other API path is unknown, the retired ones included:
    // execution, evolution, the session audit and the host probe.
    // The host-probe verb stays in the CLI; only its page route is gone.
    send(response, 404, { ok: false, reasonCode: "PORTAL_ROUTE_UNKNOWN" });
  } catch (error) {
    send(response, 500, { ok: false, reasonCode: error?.reasonCode ?? "PORTAL_INTERNAL_ERROR", error: String(error?.message ?? error) });
  }
}));

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
