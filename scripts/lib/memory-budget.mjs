// SPDX-License-Identifier: Apache-2.0
// Device-local admission. Estimates are budgets, not an OS memory limit or an OOM guarantee.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { availableParallelism, hostname, totalmem } from "node:os";
import { basename, isAbsolute, join, resolve, dirname } from "node:path";

export const MEMORY_POLICY_SETTING = "execution.memoryPolicy";
export const MEMORY_LEASE_VARIABLE = "EINZBERN_MEMORY_LEASE";
export const MiB = 1024 * 1024;
const VERSION = "einzbern.memory-budget.v1";
const TOKEN = /^[a-f0-9]{32}$/u;
const DEFAULTS = Object.freeze({ reserveMiB: 2048, budgetMiB: 4096, fixedMiB: 512, workerMiB: 1024, maxWorkers: 4, maxUsedPercent: 90, maxStallPercent: 1, sampleMaxAgeMs: 2000 });

export class MemoryBudgetError extends Error {
  constructor(reasonCode, details = {}) { super(reasonCode); this.name = "MemoryBudgetError"; this.reasonCode = reasonCode; this.details = details; }
}
const fail = (code, details) => { throw new MemoryBudgetError(code, details); };
const integer = (x, min = 0) => Number.isSafeInteger(x) && x >= min;

/** One explicit local preference; an absent preference preserves legacy execution. */
export function parseMemoryPolicy(text) {
  let value;
  try { value = JSON.parse(text); } catch { fail("MEMORY_POLICY_INVALID"); }
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some(k => !["enabled", "profiles", ...Object.keys(DEFAULTS)].includes(k)) || typeof value.enabled !== "boolean") fail("MEMORY_POLICY_INVALID");
  const policy = { ...DEFAULTS, ...value };
  for (const k of Object.keys(DEFAULTS)) if (!integer(policy[k], k === "reserveMiB" ? 0 : 1)) fail("MEMORY_POLICY_INVALID", { key: k });
  if (policy.maxWorkers > 64 || policy.maxUsedPercent > 100 || policy.maxStallPercent > 100 || policy.sampleMaxAgeMs > 60_000 || [policy.reserveMiB, policy.budgetMiB, policy.fixedMiB, policy.workerMiB].some(x => x > Math.floor(Number.MAX_SAFE_INTEGER / MiB))) fail("MEMORY_POLICY_INVALID");
  if (policy.profiles !== undefined) {
    if (!policy.profiles || Array.isArray(policy.profiles) || typeof policy.profiles !== "object" || Object.keys(policy.profiles).length > 64) fail("MEMORY_POLICY_INVALID");
    for (const [name, profile] of Object.entries(policy.profiles)) {
      if (!/^[a-z][a-z0-9 :_-]{0,63}$/u.test(name) || !profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).some(key => !["fixedMiB", "workerMiB", "maxWorkers"].includes(key))) fail("MEMORY_POLICY_INVALID");
      parseMemoryPolicy(JSON.stringify({ enabled: policy.enabled, ...DEFAULTS, ...profile }));
    }
  }
  return Object.freeze(policy);
}

export function readMemoryPolicy(deviceHome) {
  const path = join(deviceHome, "machine-settings.json");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; fail("MEMORY_POLICY_UNREADABLE"); }
  if (value.schemaVersion !== "tcrn.machine-settings.v1" || !value.values || typeof value.values !== "object" || Array.isArray(value.values)) fail("MEMORY_POLICY_UNREADABLE");
  return Object.hasOwn(value.values, MEMORY_POLICY_SETTING) ? parseMemoryPolicy(value.values[MEMORY_POLICY_SETTING]) : null;
}

/** libuv supplies the process/container-aware headroom, never just free physical pages. */
export function sampleMemory() {
  try {
    const physical = totalmem();
    const constraint = process.constrainedMemory();
    const limitBytes = constraint > 0 ? Math.min(physical, constraint) : physical;
    const availableBytes = Math.min(limitBytes, process.availableMemory());
    let stallPercent = null;
    let pressureSource = null;
    if (process.platform === "linux") {
      const psi = readFileSync("/proc/pressure/memory", "utf8");
      const match = /^full\s+avg10=(\d+(?:\.\d+)?)/mu.exec(psi);
      if (!match) fail("MEMORY_SAMPLE_UNAVAILABLE");
      stallPercent = Number(match[1]); pressureSource = "linux-psi-full-avg10";
    } else if (process.platform === "darwin") {
      // Read-only query: never invoke memory_pressure's allocation/pressure generation modes.
      const result = execFileSync("/usr/bin/memory_pressure", ["-Q"], { encoding: "utf8", timeout: 2000 });
      const match = /System-wide memory free percentage:\s*(\d+)%/u.exec(result);
      if (!match) fail("MEMORY_SAMPLE_UNAVAILABLE");
      // This platform exposes a free percentage, not a PSI stall percentage.
      return { sampledAt: Date.now(), cpuParallelism: availableParallelism(), limitBytes, availableBytes: Math.min(availableBytes, physical * Number(match[1]) / 100), stallPercent: null, pressureSource: "macos-memory-pressure-query" };
    } else fail("MEMORY_SAMPLE_UNAVAILABLE");
    return { sampledAt: Date.now(), cpuParallelism: availableParallelism(), limitBytes, availableBytes, stallPercent, pressureSource };
  } catch (error) { if (error instanceof MemoryBudgetError) throw error; fail("MEMORY_SAMPLE_UNAVAILABLE"); }
}

export function checkMemorySample(sample, policy, now = Date.now()) {
  if (!sample || !Number.isFinite(sample.sampledAt) || now < sample.sampledAt || now - sample.sampledAt > policy.sampleMaxAgeMs || !Number.isFinite(sample.limitBytes) || sample.limitBytes <= 0 || !Number.isFinite(sample.availableBytes) || sample.availableBytes < 0 || sample.availableBytes > sample.limitBytes || !["linux-psi-full-avg10", "macos-memory-pressure-query"].includes(sample.pressureSource)) fail("MEMORY_SAMPLE_INVALID_OR_STALE");
  if (sample.pressureSource === "linux-psi-full-avg10" && (!Number.isFinite(sample.stallPercent) || sample.stallPercent < 0 || sample.stallPercent > 100)) fail("MEMORY_SAMPLE_INVALID_OR_STALE");
  if (sample.cpuParallelism !== undefined && !integer(sample.cpuParallelism, 1)) fail("MEMORY_SAMPLE_INVALID_OR_STALE");
  if (100 * (1 - sample.availableBytes / sample.limitBytes) > policy.maxUsedPercent || (sample.stallPercent !== null && sample.stallPercent > policy.maxStallPercent)) fail("MEMORY_PRESSURE_HIGH");
}

/** residentBytes are uniquely attributable resident bytes, never summed shared RSS. Unknown earns no credit. */
export function planMemory(policy, sample, reservations = [], now = Date.now()) {
  checkMemorySample(sample, policy, now);
  let committed = 0, unspent = 0;
  for (const entry of reservations) {
    if (!integer(entry.bytes) || !(entry.residentBytes === null || integer(entry.residentBytes))) fail("MEMORY_RESERVATION_INVALID");
    if (entry.residentBytes !== null && entry.residentBytes > entry.bytes) fail("MEMORY_BUDGET_EXCEEDED");
    committed += entry.bytes;
    unspent += Math.max(0, entry.bytes - (entry.residentBytes ?? 0));
  }
  const capacity = Math.max(0, Math.min(policy.budgetMiB * MiB, sample.limitBytes - policy.reserveMiB * MiB));
  const available = Math.max(0, Math.min(capacity - committed, sample.availableBytes - policy.reserveMiB * MiB - unspent));
  const workers = Math.max(0, Math.min(policy.maxWorkers, sample.cpuParallelism ?? policy.maxWorkers, Math.floor((available - policy.fixedMiB * MiB) / (policy.workerMiB * MiB))));
  return Object.freeze({ workers, bytes: workers ? (policy.fixedMiB + workers * policy.workerMiB) * MiB : 0, availableBytes: available, capacityBytes: capacity, reasonCode: workers ? "MEMORY_ADMITTED" : "MEMORY_BUDGET_INSUFFICIENT" });
}

function readPrivate(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1 || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) fail("MEMORY_STATE_INVALID");
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally { closeSync(descriptor); }
}
function writeAtomic(path, value) {
  const temp = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function stateTransaction(directory, fn) {
  if (!isAbsolute(directory)) fail("MEMORY_DOMAIN_INVALID");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) fail("MEMORY_DOMAIN_INVALID");
  const lock = join(directory, "memory-budget.lock");
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") fail("MEMORY_BUDGET_BUSY"); throw error; }
  // An abandoned mutex is never removed by elapsed time or a guessed PID. No hidden takeover.
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() })); fsyncSync(fd);
    const path = join(directory, "memory-budget.json");
    const state = existsSync(path) ? readPrivate(path) : { schemaVersion: VERSION, host: hostname(), leases: [] };
    if (state.schemaVersion !== VERSION || state.host !== hostname() || !Array.isArray(state.leases)) fail("MEMORY_STATE_INVALID");
    const result = fn(state); writeAtomic(path, state); return result;
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** Observational only. Failure gives no credit and must never prove a process is gone. */
export function processTable() {
  try {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,lstart="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * MiB });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim().split("\n").map(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (!m) fail("MEMORY_PROCESS_OBSERVATION_UNKNOWN");
      return { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, started: m[4].trim() };
    }).filter(row => row.pid !== result.pid);
  } catch { return null; }
}
function treeRows(table, owner) {
  if (table === null) return null;
  const root = table.find(row => row.pid === owner.pid);
  if (!root || root.started !== owner.started) return null;
  const ids = new Set([owner.pid]);
  let added;
  do { added = false; for (const row of table) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); added = true; } } while (added);
  return table.filter(row => ids.has(row.pid));
}
function checkOutstanding(state, snapshot, policy) {
  let unspent = 0;
  for (const lease of state.leases.filter(row => row.parentToken === null)) {
    const credit = Number.isFinite(lease.observedAt) && snapshot.sampledAt - lease.observedAt <= policy.sampleMaxAgeMs && snapshot.sampledAt >= lease.observedAt ? lease.creditBytes ?? 0 : 0;
    unspent += Math.max(0, lease.bytes - credit);
  }
  if (snapshot.availableBytes - policy.reserveMiB * MiB < unspent) fail("MEMORY_HEADROOM_DECREASED");
}
function leaseReference(env) {
  const value = env[MEMORY_LEASE_VARIABLE];
  if (value === undefined) return null;
  let r; try { r = JSON.parse(value); } catch { fail("MEMORY_LEASE_INVALID"); }
  if (!r || !TOKEN.test(r.token) || typeof r.directory !== "string" || !isAbsolute(r.directory)) fail("MEMORY_LEASE_INVALID");
  return r;
}
function privateResidentBytes(rows) {
  if (!rows || process.platform !== "linux") return null;
  try {
    let bytes = 0;
    for (const row of rows) {
      const text = readFileSync(`/proc/${row.pid}/smaps_rollup`, "utf8");
      const clean = /^Private_Clean:\s+(\d+) kB$/mu.exec(text);
      const dirty = /^Private_Dirty:\s+(\d+) kB$/mu.exec(text);
      if (!clean || !dirty) return null;
      bytes += (Number(clean[1]) + Number(dirty[1])) * 1024;
    }
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch { return null; }
}
function observe(state, table) {
  const tokens = new Set(state.leases.map(row => row.token));
  if (tokens.size !== state.leases.length) fail("MEMORY_STATE_INVALID");
  for (const row of state.leases) {
    const seen = new Set([row.token]); let cursor = row;
    while (cursor.parentToken !== null) {
      if (!TOKEN.test(cursor.parentToken) || seen.has(cursor.parentToken)) fail("MEMORY_STATE_INVALID");
      seen.add(cursor.parentToken);
      cursor = state.leases.find(parent => parent.token === cursor.parentToken);
      if (!cursor) fail("MEMORY_STATE_INVALID");
    }
  }
  for (const lease of state.leases) {
    if (!TOKEN.test(lease.token) || !integer(lease.bytes, 1) || !integer(lease.workers, 1) || !lease.owner || !integer(lease.owner.pid, 1) || typeof lease.owner.started !== "string" || !Array.isArray(lease.observedProcesses) || !integer(lease.peakObservedBytes)) fail("MEMORY_STATE_INVALID");
    const rows = treeRows(table, lease.owner);
    lease.residentBytes = rows === null ? null : rows.reduce((n, row) => n + row.rss, 0);
    lease.creditBytes = privateResidentBytes(rows);
    lease.observedAt = Date.now();
    lease.peakObservedBytes = Math.max(lease.peakObservedBytes, lease.residentBytes ?? 0);
    // Persist identities ever observed, including detached descendants, so reparenting is not release.
    if (rows) for (const row of rows) if (!lease.observedProcesses.some(p => p.pid === row.pid && p.started === row.started)) lease.observedProcesses.push({ pid: row.pid, started: row.started });
  }
}

export async function acquireMemoryBudget({ deviceHome, directory, command, env = process.env, sample = sampleMemory, processes = processTable, timeoutMs = 0 } = {}) {
  const inherited = leaseReference(env);
  const localPolicy = inherited ? null : readMemoryPolicy(deviceHome);
  if (!inherited && !localPolicy?.enabled) return null;
  if (inherited && inherited.directory !== directory) fail("MEMORY_DOMAIN_MISMATCH");
  const token = randomBytes(16).toString("hex");
  const started = Date.now();
  let admitted;
  for (;;) {
    try {
      admitted = stateTransaction(directory, state => {
        const table = processes();
        const owner = table?.find(row => row.pid === process.pid);
        if (!owner) fail("MEMORY_PROCESS_OBSERVATION_UNKNOWN");
        observe(state, table);
        const parent = inherited ? state.leases.find(row => row.token === inherited.token) : null;
        if (inherited && !parent) fail("MEMORY_LEASE_INVALID");
        if (parent && treeRows(table, parent.owner)?.some(row => row.pid === process.pid) !== true) fail("MEMORY_LEASE_OWNER_UNKNOWN");
        const domainPolicy = parent ? parseMemoryPolicy(JSON.stringify(parent.domainPolicy)) : localPolicy;
        const profile = domainPolicy.profiles?.[command] ?? {};
        const policy = parseMemoryPolicy(JSON.stringify({ ...domainPolicy, ...profile, maxWorkers: Math.min(domainPolicy.maxWorkers, profile.maxWorkers ?? domainPolicy.maxWorkers) }));
        const snapshot = sample(); checkMemorySample(snapshot, policy);
        let plan;
        if (parent) {
          if (["node:test-controller", "portal:test", "gate:node-test"].includes(parent.command)) fail("MEMORY_NESTED_WORKER_UNSUPPORTED");
          // One executing child per parent envelope; grandchildren subdivide that child's envelope.
          if (state.leases.some(row => row.parentToken === parent.token)) fail("MEMORY_BUDGET_BUSY");
          const available = parent.bytes - parent.policy.fixedMiB * MiB;
          const workers = Math.min(parent.workers, policy.maxWorkers, snapshot.cpuParallelism ?? policy.maxWorkers, Math.floor((available - policy.fixedMiB * MiB) / (policy.workerMiB * MiB)));
          if (workers < 1) fail("MEMORY_BUDGET_INSUFFICIENT");
          plan = { workers, bytes: (policy.fixedMiB + workers * policy.workerMiB) * MiB };
        } else {
          if (state.leases.some(row => row.parentToken === null && row.residentBytes === null)) fail("MEMORY_LEASE_OWNER_UNKNOWN");
          if (state.leases.some(row => row.parentToken === null && JSON.stringify(row.domainPolicy) !== JSON.stringify(domainPolicy))) fail("MEMORY_DOMAIN_POLICY_CONFLICT");
          plan = planMemory(policy, snapshot, state.leases.filter(row => row.parentToken === null).map(row => ({ bytes: row.bytes, residentBytes: row.creditBytes })));
          if (!plan.workers) fail(plan.reasonCode, plan);
          if (state.leases.some(row => row.parentToken === null && treeRows(table, row.owner)?.some(p => p.pid === process.pid))) fail("MEMORY_PARENT_CONTEXT_REQUIRED");
        }
        const lease = { token, parentToken: parent?.token ?? null, command, owner: { pid: owner.pid, started: owner.started }, bytes: plan.bytes, workers: plan.workers, policy, domainPolicy, startedAt: Date.now(), residentBytes: owner.rss, creditBytes: null, peakObservedBytes: owner.rss, observedProcesses: [{ pid: owner.pid, started: owner.started }] };
        state.leases.push(lease); return lease;
      });
      break;
    } catch (error) {
      if (!["MEMORY_BUDGET_BUSY", "MEMORY_BUDGET_INSUFFICIENT", "MEMORY_PRESSURE_HIGH"].includes(error.reasonCode) || Date.now() - started >= timeoutMs) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const previous = env[MEMORY_LEASE_VARIABLE];
  const reference = JSON.stringify({ directory, token }); env[MEMORY_LEASE_VARIABLE] = reference;
  let released = false;
  const monitor = setInterval(() => {
    try { stateTransaction(directory, state => observe(state, processes())); } catch { /* No release or admission is inferred from a failed observation. */ }
  }, 1000);
  monitor.unref();
  // No process-exit release: root death is not evidence that its process tree has ended.
  return Object.freeze({ workers: admitted.workers, bytes: admitted.bytes, token, directory,
    refresh() { return memoryPhase(env, sample, processes); },
    release() {
      if (released) return;
      stateTransaction(directory, state => {
        const table = processes(); observe(state, table);
        const lease = state.leases.find(row => row.token === token);
        if (!lease || !table || state.leases.some(row => row.parentToken === token)) fail("MEMORY_RELEASE_UNCONFIRMED");
        const rows = treeRows(table, lease.owner);
        if (!rows || rows.some(row => row.pid !== process.pid) || lease.observedProcesses.some(p => p.pid !== process.pid && table.some(row => row.pid === p.pid && row.started === p.started))) fail("MEMORY_RELEASE_UNCONFIRMED");
        const receipt = { schemaVersion: "einzbern.memory-run.v1", command, workers: lease.workers, reservedBytes: lease.bytes, peakObservedBytes: lease.peakObservedBytes, peakKind: "sampled-process-tree-rss-not-exact-peak", durationMs: Date.now() - lease.startedAt, status: "released" };
        mkdirSync(join(directory, "memory-receipts"), { recursive: true, mode: 0o700 });
        writeAtomic(join(directory, "memory-receipts", `${token}.json`), receipt);
        state.leases = state.leases.filter(row => row.token !== token);
      });
      released = true; clearInterval(monitor);
      if (env[MEMORY_LEASE_VARIABLE] === reference) { if (previous === undefined) delete env[MEMORY_LEASE_VARIABLE]; else env[MEMORY_LEASE_VARIABLE] = previous; }
    },
  });
}

/** Call immediately before a managed phase. A child envelope forbids the parent starting work too. */
export function memoryPhase(env = process.env, sample = sampleMemory, processes = processTable) {
  const ref = leaseReference(env); if (!ref) return null;
  return stateTransaction(ref.directory, state => {
    const table = processes(); observe(state, table);
    const lease = state.leases.find(row => row.token === ref.token);
    if (!lease || treeRows(table, lease.owner)?.some(row => row.pid === process.pid) !== true) fail("MEMORY_LEASE_OWNER_UNKNOWN");
    if (state.leases.some(row => row.parentToken === ref.token)) fail("MEMORY_CHILD_BUDGET_ACTIVE");
    const snapshot = sample();
    checkMemorySample(snapshot, lease.policy);
    checkOutstanding(state, snapshot, lease.policy);
    if (lease.residentBytes === null || lease.residentBytes > lease.bytes) fail("MEMORY_BUDGET_EXCEEDED");
    return { workers: lease.workers, bytes: lease.bytes, token: lease.token };
  });
}

export function memoryTestArguments(args, env = process.env) {
  const phase = memoryPhase(env); if (!phase) return args;
  if (!args.includes("--test") || args.some(arg => arg.startsWith("--test-concurrency"))) fail("MEMORY_EXECUTOR_UNSUPPORTED");
  const workerPath = import.meta.url.endsWith("/memory-budget.mjs") ? "./memory-worker-check.mjs" : "./lib/memory-worker-check.mjs";
  const index = args.indexOf("--test");
  return [...args.slice(0, index + 1), `--test-concurrency=${phase.workers}`, `--import=${new URL(workerPath, import.meta.url).href}`, ...args.slice(index + 1)];
}

/** Worker startup check is read-only and does not start observer child processes. */
export function memoryWorkerCheck(env = process.env, sample = sampleMemory) {
  const ref = leaseReference(env); if (!ref) return;
  const state = readPrivate(join(ref.directory, "memory-budget.json"));
  const lease = state.leases?.find(row => row.token === ref.token);
  if (!lease || state.schemaVersion !== VERSION || state.host !== hostname()) fail("MEMORY_LEASE_INVALID");
  const policy = parseMemoryPolicy(JSON.stringify(lease.policy));
  const snapshot = sample();
  checkMemorySample(snapshot, policy);
  checkOutstanding(state, snapshot, policy);
}

/** A leaf controller takes a child envelope, so sibling controllers cannot multiply workers. */
export async function acquireMemoryChild(command, env = process.env) {
  const parent = leaseReference(env);
  if (!parent) return null;
  return acquireMemoryBudget({ directory: parent.directory, command, env });
}

/** Closed first-version gate adapters. Unknown tools cannot silently ignore worker limits. */
export function memoryGateCommand(command, cwd, env = process.env) {
  if (!leaseReference(env)) return command;
  memoryPhase(env);
  const [program, ...args] = command;
  if (["node", "node.exe"].includes(basename(program)) && args.includes("--test")) return [program, ...memoryTestArguments(args, env)];
  // Only this engine's instrumented entry points, not similarly named scripts in other projects.
  let root = resolve(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith("/memory-budget.mjs") ? "../.." : "..");
  if (root.endsWith("/dist/build")) root = resolve(root, "../..");
  const allowed = ["task.mjs", "verify-portal.mjs", "portal-tests.mjs", "release.mjs"].map(name => join(root, "scripts", name));
  if (["node", "node.exe"].includes(basename(program)) && args[0] && allowed.includes(resolve(cwd, args[0]))) return command;
  if (["pnpm", "pnpm.cjs", "pnpm.exe"].includes(basename(program)) && resolve(cwd) === root) {
    const words = args.filter(arg => !["--silent", "run"].includes(arg));
    if (words.length === 1 && ["test", "build", "typecheck", "lint", "verify:p1", "verify:portal", "portal:test"].includes(words[0])) return command;
  }
  fail("MEMORY_EXECUTOR_UNSUPPORTED", { remedy: "Use an instrumented engine runner or the direct Node test adapter; arbitrary commands require an explicit adapter." });
}
