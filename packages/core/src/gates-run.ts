import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-485 R3 (MIN-235 D8; TCRN-CROSS-SUB-344): running a plan's gates. Every planned
// gate runs, one after another, as its own process in its root, with no shell; a red gate does
// not stop the ones after it, and the run reports every red at the end. Each gate's output
// (stdout and stderr in the order they arrive, cut at a bound) goes to a file, and the run is
// recorded in this device's cache of the library, at cache/<library>/gate-runs/<runId>.json
// (einzbern.gate-run.v1), with its exact target work ids, path/id matches, declaration digest and
// tree digest. The done check (gates-done.ts) accepts a run only for the same tree and declarations
// and, since TCRN-CROSS-STORY-525 (TCRN-CROSS-SUB-448), one whose target work ids include the Story.
// A gate that outlives its timeout is stopped with its whole process group, and whatever a gate left
// running in its group is stopped when it ends.
//
// TCRN-CROSS-STORY-530 (MIN-256; TCRN-CROSS-SUB-450), TCRN-CROSS-STORY-534 (MIN-257 D6;
// TCRN-CROSS-SUB-469): a run made for Stories whose commits are known by key (the plan's subjectKeys:
// the external keys of the Stories and their Subtasks) takes its tree digest over the files those
// commits touched (storyCommitPaths in gates-plan.ts), each read as it is now, changed or not, and
// leaves HEAD out (einzbern.gate-tree.v3): each such root records the files as `paths` and, in
// `files`, each one's content digest. A commit or a file another process makes elsewhere in the
// project leaves such a run standing; a change to the content of one of the Story's files does not,
// committed or not. When those commits touched no file under any root (Q1), the run is taken as one
// made without keys, so its digest is never a constant. A non-release run made without keys, and every release run even with Story keys,
// records each root's HEAD and the digest of every changed and untracked file, as before. The
// done check reads the recorded files again and compares their digests.
//
// TCRN-CROSS-STORY-537 (MIN-257 D6; TCRN-CROSS-SUB-487): a gate can see what the same run has already
// done. Each gate process gets EINZBERN_GATE_RUN_PRIOR, the canonical JSON of the run id and, in the
// order they ran, every gate of this run that ended before it started (GateRunPrior): its name, its
// root as declared and the real directory it ran in, its command, whether it passed, whether its
// output was cut, and the absolute path of its output file. The first gate gets an empty list. The
// variable is laid over the caller's environment, so a variable of that name the caller passes is
// replaced. It is not part of the run record. The push gate reads it to leave out verify:p1 when
// the same run has already passed each of P1's legs (scripts/lib/push-gate-p1-coverage.mjs).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

import { assertStrictInstant, canonicalJson, canonicalSha256, compareCanonicalText, parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { cachePath } from "./device-home.js";
import { GatesPlanError, changedFiles, gitHead, resolveGateRoot, storyCommitPaths } from "./gates-plan.js";
import type { GatesPlan } from "./gates-plan.js";

import { GATE_RUN_SCHEMA_VERSION, compareGateRuns, isGateRunRecord } from "./gate-run-record.js";
export { GATE_RUN_SCHEMA_VERSION } from "./gate-run-record.js";
export const GATE_TREE_SCHEMA_VERSION = "einzbern.gate-tree.v3" as const;
export const GATE_RUNS_DIRECTORY = "gate-runs" as const;
export const GATE_RUN_DEFAULT_TIMEOUT_MS = 1_800_000 as const;
export const GATE_RUN_DEFAULT_OUTPUT_BYTES = 1_048_576 as const;
/** TCRN-CROSS-STORY-537: the variable through which a gate reads the gates of its run that ended before it. */
export const GATE_RUN_PRIOR_VARIABLE = "EINZBERN_GATE_RUN_PRIOR" as const;

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

/** TCRN-CROSS-STORY-534: one of the Story's files under a root, as a run read it. */
export interface GateFileDigest {
  // Relative to the root, with forward slashes.
  readonly path: string;
  // sha256:<hex> of a file's content, link:<target> for a symbolic link, directory, other, or deleted.
  readonly digest: string;
}

/** A root's state over every change under it, as a run made without a Story's keys records it. */
export interface GateRootChanges {
  readonly root: string;
  // False when the root is outside Git: its changes cannot be told apart, so any state of it matches.
  readonly git: boolean;
  readonly head: string | null;
  // The digest of every changed and untracked file under the root, path and content; null without Git.
  readonly changes: string | null;
  readonly paths?: never;
  readonly files?: never;
}

/**
 * TCRN-CROSS-STORY-534: a root's state over the files the Story's commits touched, each read as it is
 * now; HEAD and the other changes under the root are not part of it.
 */
export interface GateRootPaths {
  readonly root: string;
  readonly git: true;
  // The files, relative to the root with forward slashes, sorted.
  readonly paths: readonly string[];
  // Each of `paths`, in the same order, with its content digest.
  readonly files: readonly GateFileDigest[];
  readonly head?: never;
  readonly changes?: never;
}

/** One root's state as a run records it. */
export type GateRootTree = GateRootChanges | GateRootPaths;

/**
 * TCRN-CROSS-STORY-530, 534: what a tree digest is limited to. `keys` names the Stories and Subtasks
 * whose commits give the files of each root that has a commit (storyCommitPaths); when they give no
 * file under any root (Q1), or `keys` is empty, every root counts every change. `paths` gives the
 * files per root as a run recorded them, for their content to be read again; a root it does not name
 * counts every change.
 */
export interface GateTreeScope {
  readonly keys?: readonly string[];
  readonly paths?: Readonly<Record<string, readonly string[]>>;
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
  // Absent only on historical records written before per-gate timing was recorded.
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
}

export interface GateRun {
  readonly schemaVersion: typeof GATE_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly libraryId: string;
  readonly projectId?: string;
  readonly at: string;
  readonly release: boolean;
  readonly base: string | null;
  readonly baseByRoot?: Readonly<Record<string, string>>;
  // The Stories the run was planned to cover; an unbound run cannot satisfy a Story's done check.
  readonly workIds: readonly string[];
  readonly treeDigest: string;
  readonly declarationsDigest: string;
  readonly trees: readonly GateRootTree[];
  readonly gates: readonly GateRunResult[];
  // Every gate that did not pass, required or not, in plan order.
  readonly reds: readonly string[];
}

/** TCRN-CROSS-STORY-537: a gate of the run that ended before the gate that reads it. */
export interface GatePriorResult {
  readonly name: string;
  // The root as the gate declares it, relative to the project.
  readonly root: string;
  // The real, absolute directory the gate ran in.
  readonly directory: string;
  readonly command: readonly string[];
  readonly ok: boolean;
  readonly truncated: boolean;
  // The absolute path of the gate's output file (the run record keeps it relative).
  readonly outputFile: string;
}

/** TCRN-CROSS-STORY-537: what EINZBERN_GATE_RUN_PRIOR holds for one gate of a run. */
export interface GateRunPrior {
  readonly runId: string;
  // In the order they ran; empty for the first gate.
  readonly gates: readonly GatePriorResult[];
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

// A root's state over every change under it: the commit HEAD names and the digest of the path and
// content of every file changed against HEAD or untracked. Outside Git neither is recorded, so every
// state of the root looks the same.
async function changesTree(root: string, directory: string): Promise<GateRootChanges> {
  let files: readonly string[];
  try {
    files = changedFiles(directory);
  } catch (error) {
    if (error instanceof GatesPlanError && error.reasonCode === "GATES_GIT_UNAVAILABLE") return { root, git: false, head: null, changes: null };
    throw error;
  }
  const entries: string[] = [];
  for (const file of files) entries.push(`${file}\u0000${await contentDigest(join(directory, ...file.split("/")))}`);
  return { root, git: true, head: gitHead(directory), changes: createHash("sha256").update(entries.join("\u0000"), "utf8").digest("hex") };
}

// TCRN-CROSS-STORY-534: a root's state over the Story's files, each read where it is now, whether Git
// sees it changed or not.
async function pathsTree(root: string, directory: string, paths: readonly string[]): Promise<GateRootPaths> {
  const files: GateFileDigest[] = [];
  for (const path of paths) files.push({ path, digest: await contentDigest(join(directory, ...path.split("/"))) });
  return { root, git: true, paths: [...paths], files };
}

/**
 * The state of the project a run is made on. For a run made for Stories (`scope.keys`), each root
 * with a commit records the files their commits touched there, with each one's content as it is now
 * (GateRootPaths), and a root without a commit records its HEAD and every change (GateRootChanges);
 * when the commits touched no file under any root (TCRN-CROSS-STORY-534 Q1) every root records its
 * HEAD and every change, as for a run made without keys. With `scope.paths`, the roots it names read
 * the files a run recorded again, and the others every change.
 */
export async function gateTreeState(projectRoot: string, roots: readonly string[], scope: GateTreeScope = {}): Promise<GateTreeState> {
  const project = await realpath(projectRoot);
  const keys = [...new Set(scope.keys ?? [])];
  const directories: (readonly [string, string])[] = [];
  for (const root of [...new Set(roots)].sort(compareCanonicalText)) directories.push([root, await resolveGateRoot(project, root)]);
  const limited = new Map<string, readonly string[]>();
  if (scope.paths !== undefined) {
    for (const [root] of directories) {
      const recorded = Object.hasOwn(scope.paths, root) ? scope.paths[root] : undefined;
      if (recorded !== undefined) limited.set(root, recorded);
    }
  } else if (keys.length > 0) {
    for (const [root, directory] of directories) if (gitHead(directory) !== null) limited.set(root, storyCommitPaths(directory, keys));
    // Q1: without a file of the Stories' anywhere the digest would be a constant that no change moves.
    if ([...limited.values()].every((paths) => paths.length === 0)) limited.clear();
  }
  const trees: GateRootTree[] = [];
  for (const [root, directory] of directories) {
    const paths = limited.get(root);
    trees.push(paths === undefined ? await changesTree(root, directory) : await pathsTree(root, directory, paths));
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
 * taken before the first gate starts. Each gate's environment is `env` (the process's when not
 * given) with EINZBERN_GATE_RUN_PRIOR set to the gates of this run that ended before it.
 */
export async function runGates(plan: GatesPlan, options: {
  readonly libraryId: string;
  readonly projectId?: string;
  readonly at: string;
  readonly deviceHome?: string;
  readonly timeoutMs?: number;
  readonly outputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly run: GateRun; readonly recordPath: string }> {
  assertStrictInstant(options.at);
  const timeoutMs = options.timeoutMs ?? GATE_RUN_DEFAULT_TIMEOUT_MS;
  const outputBytes = options.outputBytes ?? GATE_RUN_DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > RUNTIME_CAPACITY.timerMilliseconds) fail("a gate timeout must fit the native timer and be at least 100 milliseconds", { timeoutMs: String(timeoutMs) });
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 1_024 || outputBytes > RUNTIME_CAPACITY.bufferBytes) fail("a gate's output budget must fit the runtime buffer and be at least 1024 bytes", { outputBytes: String(outputBytes) });
  const directory = gateRunsDirectory(options.libraryId, options.deviceHome);
  const tree = await gateTreeState(plan.projectRoot, plan.roots, plan.release || plan.subjectKeys === undefined ? {} : { keys: plan.subjectKeys });
  const runId = `${utcStamp(options.at)}-${canonicalSha256({
    projectRoot: plan.projectRoot,
    at: options.at,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    treeDigest: tree.treeDigest,
    declarationsDigest: plan.declarationsDigest,
    release: plan.release,
    base: plan.base,
    ...(plan.baseByRoot === undefined ? {} : { baseByRoot: plan.baseByRoot }),
    workIds: plan.workIds,
    gates: plan.gates.map((gate) => gate.name),
  }).slice(0, 12)}`;
  await mkdir(join(directory, runId), { recursive: true });
  const results: GateRunResult[] = [];
  // TCRN-CROSS-STORY-537: the gates that have ended, handed to each gate after them.
  const ended: GatePriorResult[] = [];
  const environment = options.env ?? process.env;
  for (const [index, gate] of plan.gates.entries()) {
    const cwd = await resolveGateRoot(plan.projectRoot, gate.root);
    const prior: GateRunPrior = { runId, gates: ended };
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const outcome = await runGateProcess(gate.command, cwd, timeoutMs, outputBytes, { ...environment, [GATE_RUN_PRIOR_VARIABLE]: canonicalJson(prior) });
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const finishedAt = new Date().toISOString();
    const outputFile = `${runId}/${index + 1}-${gate.name.replace(/[^A-Za-z0-9._-]/gu, "_")}.log`;
    const outputPath = join(directory, ...outputFile.split("/"));
    await writeFileAtomic(outputPath, outcome.output);
    const ok = outcome.exitCode === 0 && !outcome.timedOut;
    results.push({
      name: gate.name,
      root: gate.root,
      required: gate.required,
      matched: gate.matched,
      matchedWorkIds: gate.matchedWorkIds,
      ok,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      outputFile,
      outputBytes: outcome.output.length,
      truncated: outcome.truncated,
      startedAt, finishedAt, durationMs,
    });
    ended.push({ name: gate.name, root: gate.root, directory: cwd, command: [...gate.command], ok, truncated: outcome.truncated, outputFile: outputPath });
  }
  const run: GateRun = {
    schemaVersion: GATE_RUN_SCHEMA_VERSION,
    runId,
    libraryId: options.libraryId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    at: options.at,
    release: plan.release,
    base: plan.base,
    ...(plan.baseByRoot === undefined ? {} : { baseByRoot: plan.baseByRoot }),
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

/**
 * The latest run this device recorded for the library, by its instant, optionally only among
 * runs made on one tree under one set of declarations; null when there is none. A record that
 * does not read as a run is skipped. `workIds` keeps only runs made for exactly those target work
 * ids; `includesWorkIds` (TCRN-CROSS-STORY-525) only runs whose targets include each of them.
 * `accept` (TCRN-CROSS-STORY-530), given, is asked of the remaining runs from the latest back, and
 * the first it accepts is the answer: the done check reads the files each run recorded again
 * (TCRN-CROSS-STORY-534). A record with a root that names its paths without their content digests
 * (einzbern.gate-tree.v2) is skipped, as is any other that does not read as a run.
 */
export async function latestGateRun(input: {
  readonly libraryId: string;
  readonly projectId?: string;
  readonly deviceHome?: string;
  readonly treeDigest?: string;
  readonly declarationsDigest?: string;
  readonly workIds?: readonly string[];
  readonly includesWorkIds?: readonly string[];
  readonly accept?: (run: GateRun) => Promise<boolean>;
}): Promise<GateRun | null> {
  const directory = gateRunsDirectory(input.libraryId, input.deviceHome);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  const candidates: GateRun[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort(compareCanonicalText)) {
    let run: unknown;
    try {
      run = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch {
      continue;
    }
    if (!isGateRunRecord(run) || run.libraryId !== input.libraryId || run.projectId !== input.projectId) continue;
    if (input.treeDigest !== undefined && run.treeDigest !== input.treeDigest) continue;
    if (input.declarationsDigest !== undefined && run.declarationsDigest !== input.declarationsDigest) continue;
    if (input.workIds !== undefined) {
      const expected = [...new Set(input.workIds)].sort(compareCanonicalText);
      if (run.workIds.length !== expected.length || run.workIds.some((workId, index) => workId !== expected[index])) continue;
    }
    if (input.includesWorkIds !== undefined && !input.includesWorkIds.every((workId) => run.workIds.includes(workId))) continue;
    candidates.push(run);
  }
  candidates.sort(compareGateRuns);
  for (const candidate of candidates) {
    if (input.accept === undefined || await input.accept(candidate)) return candidate;
  }
  return null;
}
