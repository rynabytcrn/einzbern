// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R3 (MIN-235 D8; TCRN-CROSS-SUB-344): running a plan's gates. Every planned
// gate runs, one after another, as its own process in its root, with no shell; a red gate does
// not stop the ones after it, and the run reports every red at the end. Each gate's output
// (stdout and stderr in the order they arrive, cut at a bound) goes to a file, and the run is
// recorded in this device's cache of the library, at cache/<library>/gate-runs/<runId>.json
// (einzbern.gate-run.v1), with its exact target work ids, path/id matches, declaration digest and
// tree digest. The done check (gates-done.ts) accepts a run only for the same target set, tree and
// declarations. A gate that outlives its timeout is stopped with its whole process group, and
// whatever a gate left running in its group is stopped when it ends.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

import { assertStrictInstant, canonicalJson, canonicalSha256, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath } from "./device-home.js";
import { GatesPlanError, changedFiles, gitHead, resolveGateRoot } from "./gates-plan.js";
import type { GatesPlan } from "./gates-plan.js";

export const GATE_RUN_SCHEMA_VERSION = "einzbern.gate-run.v1" as const;
export const GATE_TREE_SCHEMA_VERSION = "einzbern.gate-tree.v1" as const;
export const GATE_RUNS_DIRECTORY = "gate-runs" as const;
export const GATE_RUN_DEFAULT_TIMEOUT_MS = 1_800_000 as const;
export const GATE_RUN_DEFAULT_OUTPUT_BYTES = 1_048_576 as const;

export const GATES_RUN_REASON_CODES = Object.freeze(["GATES_RUN_INPUT_INVALID"] as const);

export type GatesRunReasonCode = typeof GATES_RUN_REASON_CODES[number];

export class GatesRunError extends Error {
  readonly reasonCode: GatesRunReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: GatesRunReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "GatesRunError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(message: string, details?: Readonly<Record<string, string>>): never {
  throw new GatesRunError("GATES_RUN_INPUT_INVALID", message, details);
}

/** One root's state as a run records it. */
export interface GateRootTree {
  readonly root: string;
  // False when the root is outside Git: its changes cannot be told apart, so any state of it matches.
  readonly git: boolean;
  readonly head: string | null;
  // The digest of every changed and untracked file under the root, path and content; null without Git.
  readonly changes: string | null;
}

export interface GateTreeState {
  readonly treeDigest: string;
  readonly trees: readonly GateRootTree[];
}

export interface GateRunResult {
  readonly name: string;
  readonly root: string;
  readonly required: boolean;
  // Path and exact work-id coverage are kept separate so the done check can prove what matched.
  readonly matched: readonly string[];
  readonly matchedWorkIds: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  // The gate's output, relative to the gate-runs directory.
  readonly outputFile: string;
  readonly outputBytes: number;
  readonly truncated: boolean;
}

export interface GateRun {
  readonly schemaVersion: typeof GATE_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly libraryId: string;
  readonly at: string;
  readonly release: boolean;
  readonly base: string | null;
  // The Stories the run was planned to cover; an unbound run cannot satisfy a Story's done check.
  readonly workIds: readonly string[];
  readonly treeDigest: string;
  readonly declarationsDigest: string;
  readonly trees: readonly GateRootTree[];
  readonly gates: readonly GateRunResult[];
  // Every gate that did not pass, required or not, in plan order.
  readonly reds: readonly string[];
}

/** This device's directory of gate runs for a library. */
export function gateRunsDirectory(libraryId: string, deviceHome?: string): string {
  return join(deviceHome === undefined ? cachePath(libraryId) : cachePath(libraryId, deviceHome), GATE_RUNS_DIRECTORY);
}

async function contentDigest(path: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "deleted";
    throw error;
  }
  if (metadata.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (metadata.isDirectory()) return "directory";
  if (!metadata.isFile()) return "other";
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

/**
 * The state of the project a run is made on: for each root, the commit HEAD names and the digest
 * of the path and content of every file changed against HEAD or untracked. A root outside Git
 * records neither, so every state of it looks the same.
 */
export async function gateTreeState(projectRoot: string, roots: readonly string[]): Promise<GateTreeState> {
  const project = await realpath(projectRoot);
  const trees: GateRootTree[] = [];
  for (const root of [...new Set(roots)].sort(compareCanonicalText)) {
    const directory = await resolveGateRoot(project, root);
    let files: readonly string[];
    try {
      files = changedFiles(directory);
    } catch (error) {
      if (error instanceof GatesPlanError && error.reasonCode === "GATES_GIT_UNAVAILABLE") {
        trees.push({ root, git: false, head: null, changes: null });
        continue;
      }
      throw error;
    }
    const entries: string[] = [];
    for (const file of files) entries.push(`${file}\u0000${await contentDigest(join(directory, ...file.split("/")))}`);
    trees.push({ root, git: true, head: gitHead(directory), changes: createHash("sha256").update(entries.join("\u0000"), "utf8").digest("hex") });
  }
  return { treeDigest: canonicalSha256({ schemaVersion: GATE_TREE_SCHEMA_VERSION, trees }), trees };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process group is already gone.
  }
}

interface GateProcess {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: Buffer;
  readonly truncated: boolean;
}

function runGateProcess(command: readonly string[], cwd: string, timeoutMs: number, outputBytes: number, env: NodeJS.ProcessEnv): Promise<GateProcess> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const append = (chunk: Buffer): void => {
      const room = outputBytes - bytes;
      if (chunk.length > room) truncated = true;
      if (room <= 0) return;
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      bytes += kept.length;
    };
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const finish = (exitCode: number | null, signal: string | null, failure: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      // Whatever the gate left running in its process group ends with it.
      if (child !== undefined) terminate(child, "SIGTERM");
      if (failure !== null) append(Buffer.from(`einzbern: the gate could not run: ${failure}\n`, "utf8"));
      resolve({ exitCode, signal, timedOut, output: Buffer.concat(chunks), truncated });
    };
    const [executable, ...args] = command;
    try {
      child = spawn(executable ?? "", args, {
        cwd,
        detached: process.platform !== "win32",
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(null, null, String((error as Error).message ?? error));
      return;
    }
    const started = child;
    started.stdout?.on("data", append);
    started.stderr?.on("data", append);
    started.once("error", (error: NodeJS.ErrnoException) => finish(null, null, error.code ?? error.message));
    started.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => finish(exitCode, signal, null));
    timer = setTimeout(() => {
      timedOut = true;
      terminate(started, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) terminate(started, "SIGKILL");
      }, 1_000);
      killTimer.unref();
    }, timeoutMs);
  });
}

// The UTC second as a file-name prefix that sorts: 20260926T100000Z.
function utcStamp(at: string): string {
  return new Date(Number(parseStrictInstant(at) / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[-:]/gu, "");
}

/**
 * Run every gate of a plan and record the run in this device's cache of the library. Every gate
 * runs, whatever the ones before it did; `reds` lists all that did not pass. The tree digest is
 * taken before the first gate starts.
 */
export async function runGates(plan: GatesPlan, options: {
  readonly libraryId: string;
  readonly at: string;
  readonly deviceHome?: string;
  readonly timeoutMs?: number;
  readonly outputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly run: GateRun; readonly recordPath: string }> {
  assertStrictInstant(options.at);
  const timeoutMs = options.timeoutMs ?? GATE_RUN_DEFAULT_TIMEOUT_MS;
  const outputBytes = options.outputBytes ?? GATE_RUN_DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 86_400_000) fail("a gate timeout is 100 to 86400000 milliseconds", { timeoutMs: String(timeoutMs) });
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 1_024 || outputBytes > 16_777_216) fail("a gate's output bound is 1024 to 16777216 bytes", { outputBytes: String(outputBytes) });
  const directory = gateRunsDirectory(options.libraryId, options.deviceHome);
  const tree = await gateTreeState(plan.projectRoot, plan.roots);
  const runId = `${utcStamp(options.at)}-${canonicalSha256({
    at: options.at,
    treeDigest: tree.treeDigest,
    declarationsDigest: plan.declarationsDigest,
    release: plan.release,
    base: plan.base,
    workIds: plan.workIds,
    gates: plan.gates.map((gate) => gate.name),
  }).slice(0, 12)}`;
  await mkdir(join(directory, runId), { recursive: true });
  const results: GateRunResult[] = [];
  for (const [index, gate] of plan.gates.entries()) {
    const cwd = await resolveGateRoot(plan.projectRoot, gate.root);
    const outcome = await runGateProcess(gate.command, cwd, timeoutMs, outputBytes, options.env ?? process.env);
    const outputFile = `${runId}/${index + 1}-${gate.name.replace(/[^A-Za-z0-9._-]/gu, "_")}.log`;
    await writeFileAtomic(join(directory, ...outputFile.split("/")), outcome.output);
    results.push({
      name: gate.name,
      root: gate.root,
      required: gate.required,
      matched: gate.matched,
      matchedWorkIds: gate.matchedWorkIds,
      ok: outcome.exitCode === 0 && !outcome.timedOut,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      outputFile,
      outputBytes: outcome.output.length,
      truncated: outcome.truncated,
    });
  }
  const run: GateRun = {
    schemaVersion: GATE_RUN_SCHEMA_VERSION,
    runId,
    libraryId: options.libraryId,
    at: options.at,
    release: plan.release,
    base: plan.base,
    workIds: plan.workIds,
    treeDigest: tree.treeDigest,
    declarationsDigest: plan.declarationsDigest,
    trees: tree.trees,
    gates: results,
    reds: results.filter((result) => !result.ok).map((result) => result.name),
  };
  const recordPath = join(directory, `${runId}.json`);
  await writeFileAtomic(recordPath, canonicalJson(run));
  return { run, recordPath };
}

function isGateRun(value: unknown): value is GateRun {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const workIds = record.workIds;
  const gates = record.gates;
  return record.schemaVersion === GATE_RUN_SCHEMA_VERSION && typeof record.runId === "string" && typeof record.libraryId === "string" &&
    typeof record.at === "string" && typeof record.treeDigest === "string" && typeof record.declarationsDigest === "string" &&
    Array.isArray(workIds) && workIds.every((workId: unknown) => typeof workId === "string" && /^work:[0-9a-f]{24}$/u.test(workId)) &&
    Array.isArray(gates) && gates.every((gate: unknown) => {
      if (gate === null || typeof gate !== "object") return false;
      const result = gate as Readonly<Record<string, unknown>>;
      const matched = result.matched;
      const matchedWorkIds = result.matchedWorkIds;
      return typeof result.name === "string" && typeof result.ok === "boolean" && typeof result.required === "boolean" &&
        Array.isArray(matched) && matched.every((path: unknown) => typeof path === "string") &&
        Array.isArray(matchedWorkIds) && matchedWorkIds.every((workId: unknown) => typeof workId === "string" && /^work:[0-9a-f]{24}$/u.test(workId));
    });
}

function instant(value: string): bigint | null {
  try {
    return parseStrictInstant(value);
  } catch {
    return null;
  }
}

/**
 * The latest run this device recorded for the library, by its instant, optionally only among
 * runs made on one tree under one set of declarations; null when there is none. A record that
 * does not read as a run is skipped.
 */
export async function latestGateRun(input: {
  readonly libraryId: string;
  readonly deviceHome?: string;
  readonly treeDigest?: string;
  readonly declarationsDigest?: string;
  readonly workIds?: readonly string[];
}): Promise<GateRun | null> {
  const directory = gateRunsDirectory(input.libraryId, input.deviceHome);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let latest: { readonly run: GateRun; readonly at: bigint } | null = null;
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort(compareCanonicalText)) {
    let run: unknown;
    try {
      run = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
      continue;
    }
    if (!isGateRun(run) || run.libraryId !== input.libraryId) continue;
    if (input.treeDigest !== undefined && run.treeDigest !== input.treeDigest) continue;
    if (input.declarationsDigest !== undefined && run.declarationsDigest !== input.declarationsDigest) continue;
    if (input.workIds !== undefined) {
      const expected = [...new Set(input.workIds)].sort(compareCanonicalText);
      if (run.workIds.length !== expected.length || run.workIds.some((workId, index) => workId !== expected[index])) continue;
    }
    const at = instant(run.at);
    if (at === null) continue;
    if (latest === null || at > latest.at || (at === latest.at && compareCanonicalText(run.runId, latest.run.runId) > 0)) latest = { run, at };
  }
  return latest?.run ?? null;
}
