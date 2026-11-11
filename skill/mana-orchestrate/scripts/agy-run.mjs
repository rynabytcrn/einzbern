#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Antigravity's non-interactive headless runner consumes an existing host-native preparation.
// It does not make an admission decision, choose a fallback, bypass tool permissions, or claim
// that the requested model was actually used.

import { spawn } from "node:child_process";
import { constants, statSync } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RETURN_VERSION = "tcrn.antigravity-process-return.v1";
const FLAG_NAMES = new Set(["--binding", "--output"]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAG_NAMES.has(flag) || value === undefined || value.length === 0 || value.startsWith("--") || values.has(flag)) {
      throw new Error("usage: node <skill directory>/scripts/agy-run.mjs --binding <HostNativePreparation.json> --output <new AntigravityEvidence.json>");
    }
    values.set(flag, value);
  }
  if (!values.has("--binding") || !values.has("--output")) throw new Error("both --binding and --output are required");
  return { binding: resolve(values.get("--binding")), output: resolve(values.get("--output")) };
}

function homeDirectory(env = process.env) {
  const configured = env.EINZBERN_HOME;
  if (typeof configured === "string" && configured.length > 0) {
    if (!isAbsolute(configured)) throw new Error("EINZBERN_HOME must be an absolute path");
    return resolve(configured);
  }
  return join(homedir(), ".einzbern");
}

function engineEntry(env = process.env) {
  return join(homeDirectory(env), "engine", "einzbern.mjs");
}

function resolveDefaultAgyExecutable(options = {}) {
  if (options.executable !== undefined) return options.executable;
  if (options.spawn !== undefined) return "agy";
  const env = options.env ?? process.env;
  const pathDirs = typeof env.PATH === "string" ? env.PATH.split(process.platform === "win32" ? ";" : ":").filter(Boolean) : [];
  const binName = process.platform === "win32" ? "agy.exe" : "agy";
  for (const dir of pathDirs) {
    try {
      if (statSync(join(dir, binName)).isFile()) return "agy";
    } catch {
      // keep scanning PATH
    }
  }
  if (options.env?.PATH === undefined) {
    const localBin = join(options.home ? resolve(options.home) : homedir(), ".local", "bin", binName);
    try {
      if (statSync(localBin).isFile()) return localBin;
    } catch {
      // fall back to bare "agy" so ENOENT is reported truthfully
    }
  }
  return "agy";
}

/** Flags are derived only from the validated preflight's request. Prompt NDJSON goes via stdin. */
export function buildAntigravityCliArgs(preflight) {
  if (preflight?.status !== "ready" || preflight?.preparation?.attempt === null) {
    throw new Error("Antigravity CLI arguments require a ready prepared attempt");
  }
  const selection = preflight.requested?.selection;
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (selection?.kind === "explicit") {
    const tuple = selection.tuple;
    if (tuple?.runner !== "antigravity" || typeof tuple.model !== "string" || !tuple.model.trim() || typeof tuple.effort !== "string" || !tuple.effort.trim()) {
      throw new Error("explicit Antigravity selection must name runner antigravity, model, and effort");
    }
    args.push("--model", tuple.model);
    // "default" is an explicit no-override marker, not an agy --effort level.
    if (tuple.effort !== "default") args.push("--effort", tuple.effort);
  } else if (selection?.kind !== "host-managed") {
    throw new Error("Antigravity preflight selection is unknown");
  }
  return args;
}

/** Formats the prepared prompt as a single-line Antigravity stream-json user message. */
export function buildAntigravityStdinPayload(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prepared Antigravity attempt does not retain a nonempty prompt");
  }
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

function cliResult(child, argv, options = {}) {
  return new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("close", code => {
      child.removeListener("error", rejectResult);
      if (code !== 0) rejectResult(new Error(`engine CLI exited with ${code}: ${stderr || stdout}`));
      else {
        try { resolveResult(JSON.parse(stdout)); }
        catch (error) { rejectResult(new Error(`engine CLI returned invalid JSON: ${String(error)}`)); }
      }
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    void argv;
  });
}

function invokeEngine(command, args, options = {}) {
  const entry = engineEntry(options.env);
  return cliResult(spawn(process.execPath, [entry, command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  }));
}

async function privateTemporaryDirectory(output) {
  return mkdtemp(join(dirname(output), ".einzbern-agy-run-"));
}

export async function collectAntigravityProcess(preflight, options = {}) {
  const preparation = preflight.preparation;
  const attempt = preparation.attempt;
  const notStarted = (fields) => ({
    schemaVersion: RETURN_VERSION,
    source: "agy-cli-process-return",
    preparationDigest: preparation.digest,
    attemptId: attempt.id,
    processStarted: false,
    processClosed: false,
    spawnError: null,
    launchBlock: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    cancellationRequested: false,
    ...fields,
  });
  const env = options.env ?? process.env;
  const prompt = attempt.argumentsValue?.prompt;
  const stdinPayload = buildAntigravityStdinPayload(prompt);
  const args = buildAntigravityCliArgs(preflight);
  const executable = resolveDefaultAgyExecutable(options);
  let child;
  try {
    child = (options.spawn ?? spawn)(executable, args, {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    return notStarted({ spawnError: String(error?.message ?? error) });
  }

  let stdout = "";
  let stderr = "";
  let processStarted = false;
  let processClosed = false;
  let spawnError = null;
  let startInstant = null;
  let finishInstant = null;
  let exitCode = null;
  let signal = null;
  let cancellationRequested = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const requestCancellation = signalName => {
    if (processClosed || cancellationRequested) return;
    cancellationRequested = true;
    try { child.kill(signalName); } catch { /* retain request even if the signal could not be delivered */ }
  };
  const onInterrupt = () => requestCancellation("SIGINT");
  const onTerminate = () => requestCancellation("SIGTERM");
  const signals = options.signals ?? process;
  signals.once("SIGINT", onInterrupt);
  signals.once("SIGTERM", onTerminate);

  try {
    await new Promise(resolveClose => {
      child.once("spawn", () => { processStarted = true; startInstant = new Date().toISOString(); });
      child.once("error", error => { spawnError = String(error?.message ?? error); });
      child.once("close", (code, actualSignal) => {
        processClosed = processStarted;
        finishInstant = processStarted ? new Date().toISOString() : null;
        exitCode = code;
        signal = actualSignal;
        resolveClose();
      });
      child.stdin?.on("error", error => {
        if (error?.code !== "EPIPE") stderr += `${String(error?.message ?? error)}\n`;
      });
      child.stdin?.end(stdinPayload);
    });
  } finally {
    signals.removeListener("SIGINT", onInterrupt);
    signals.removeListener("SIGTERM", onTerminate);
  }
  if (!processStarted) {
    return notStarted({
      spawnError: spawnError ?? "Antigravity CLI process did not emit a spawn event",
      stdout,
      stderr,
      cancellationRequested,
    });
  }
  return {
    schemaVersion: RETURN_VERSION,
    source: "agy-cli-process-return",
    preparationDigest: preparation.digest,
    attemptId: attempt.id,
    processStarted,
    processClosed,
    spawnError: null,
    launchBlock: null,
    startedAt: startInstant,
    finishedAt: finishInstant,
    exitCode,
    signal,
    stdout,
    stderr,
    cancellationRequested,
  };
}

async function assertReservation(file, reservation) {
  const [opened, named] = await Promise.all([file.stat({ bigint: true }), lstat(reservation.destination, { bigint: true })]);
  for (const stat of [opened, named]) {
    if (!stat.isFile() || String(stat.dev) !== reservation.device || String(stat.ino) !== reservation.inode || stat.size !== 0n) {
      throw new Error("reserved output changed before evidence was written");
    }
  }
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const paths = parseArguments(argv);
  const engine = options.invokeEngine ?? invokeEngine;
  let temporaryDirectory = null;
  let output = null;
  let returnFile = null;
  let reservation = null;
  let recoveryPath = null;
  let returnPersisted = false;
  try {
    const preflight = await engine("execution-antigravity-preflight", ["--binding", paths.binding, "--reserve-output", paths.output], options);
    reservation = preflight.reservation;
    if (!reservation || typeof reservation.destination !== "string" || typeof reservation.device !== "string" || typeof reservation.inode !== "string") {
      throw new Error("engine did not return an output reservation");
    }
    output = await open(reservation.destination, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    await assertReservation(output, reservation);
    temporaryDirectory = await privateTemporaryDirectory(reservation.destination);
    let resultPath;
    if (preflight.status === "ready") {
      resultPath = join(temporaryDirectory, "process-return.json");
      returnFile = await open(resultPath, "wx", 0o600);
      const processReturn = await collectAntigravityProcess(preflight, options);
      recoveryPath = resultPath;
      await returnFile.writeFile(`${JSON.stringify(processReturn, null, 2)}\n`, "utf8");
      await returnFile.sync();
      await returnFile.close();
      returnFile = null;
      returnPersisted = true;
    }
    const args = ["--binding", paths.binding, ...(resultPath ? ["--result", resultPath] : []), "--output", join(temporaryDirectory, "evidence.json")];
    const result = await engine("execution-antigravity-record", args, options);
    await assertReservation(output, reservation);
    await (options.writeEvidence ?? ((file, value) => file.writeFile(value, "utf8")))(output, `${JSON.stringify(result, null, 2)}\n`);
    await output.sync();
    const named = await lstat(reservation.destination, { bigint: true });
    if (!named.isFile() || String(named.dev) !== reservation.device || String(named.ino) !== reservation.inode) {
      throw new Error("reserved output changed during evidence write");
    }
    await output.close();
    output = null;
    recoveryPath = null;
    return result;
  } catch (error) {
    if (recoveryPath && returnPersisted) throw new Error(`${String(error?.message ?? error)}; actual process return retained privately at ${recoveryPath}`);
    if (recoveryPath) throw new Error(`${String(error?.message ?? error)}; process return could not be fully persisted; partial file may remain at ${recoveryPath}`);
    if (reservation?.destination) throw new Error(`${String(error?.message ?? error)}; reserved output may remain at ${reservation.destination}`);
    throw error;
  } finally {
    if (output) await output.close().catch(() => {});
    if (returnFile) await returnFile.close().catch(() => {});
    if (temporaryDirectory && !recoveryPath) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: "ANTIGRAVITY_RUN_FAILED", error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
