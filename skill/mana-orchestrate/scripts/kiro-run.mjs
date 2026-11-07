#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Kiro's non-interactive runner consumes an existing host-native preparation. It does not make
// an admission decision, choose a fallback, or claim that the requested model was used.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RETURN_VERSION = "tcrn.kiro-process-return.v1";
const FLAG_NAMES = new Set(["--binding", "--output"]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAG_NAMES.has(flag) || value === undefined || value.length === 0 || value.startsWith("--") || values.has(flag)) {
      throw new Error("usage: node <skill directory>/scripts/kiro-run.mjs --binding <HostNativePreparation.json> --output <new KiroEvidence.json>");
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

/** Flags are derived only from the validated preflight's request. Prompt text goes via stdin. */
export function buildKiroCliArgs(preflight) {
  if (preflight?.status !== "ready" || preflight?.preparation?.attempt === null) throw new Error("Kiro CLI arguments require a ready prepared attempt");
  const selection = preflight.requested?.selection;
  const args = ["chat", "--v3", "--no-interactive", "--output-format", "stream-json"];
  if (selection?.kind === "explicit") {
    const tuple = selection.tuple;
    if (tuple?.runner !== "kiro-cli" || typeof tuple.model !== "string" || !tuple.model.trim() || typeof tuple.effort !== "string" || !tuple.effort.trim()) {
      throw new Error("explicit Kiro selection must name runner kiro-cli, model, and effort");
    }
    args.push("--model", tuple.model, "--effort", tuple.effort);
  } else if (selection?.kind !== "host-managed") {
    throw new Error("Kiro preflight selection is unknown");
  }
  return args;
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
  return cliResult(spawn(process.execPath, [entry, command, ...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true }));
}

async function privateTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "einzbern-kiro-run-"));
  return path;
}

async function writeProcessReturn(directory, value) {
  const path = join(directory, "process-return.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

export async function collectKiroProcess(preflight, options = {}) {
  const preparation = preflight.preparation;
  const attempt = preparation.attempt;
  const startedAt = null;
  const notStarted = (fields) => ({
    schemaVersion: RETURN_VERSION, source: "kiro-cli-process-return", preparationDigest: preparation.digest,
    attemptId: attempt.id, processStarted: false, processClosed: false, spawnError: null, launchBlock: null,
    startedAt, finishedAt: null, exitCode: null, signal: null, stdout: "", stderr: "", cancellationRequested: false,
    ...fields,
  });
  const env = options.env ?? process.env;
  if (!env.KIRO_API_KEY) {
    return notStarted({ launchBlock: "headless invocation requires KIRO_API_KEY" });
  }

  const prompt = attempt.argumentsValue?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prepared Kiro attempt does not retain a nonempty prompt");
  const args = buildKiroCliArgs(preflight);
  let child;
  try {
    child = (options.spawn ?? spawn)(options.executable ?? "kiro-cli", args, {
      cwd: options.cwd ?? process.cwd(), env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
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
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

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
      child.stdin?.end(prompt);
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
  if (!processStarted) return notStarted({ spawnError: spawnError ?? "Kiro CLI process did not emit a spawn event", stdout, stderr, cancellationRequested });
  return {
    schemaVersion: RETURN_VERSION, source: "kiro-cli-process-return", preparationDigest: preparation.digest,
    attemptId: attempt.id, processStarted, processClosed, spawnError: null, launchBlock: null,
    startedAt: startInstant, finishedAt: finishInstant, exitCode, signal, stdout, stderr, cancellationRequested,
  };
}

async function run(argv = process.argv.slice(2), options = {}) {
  const paths = parseArguments(argv);
  const preflight = await invokeEngine("execution-kiro-preflight", ["--binding", paths.binding], options);
  const temporaryDirectory = await privateTemporaryDirectory();
  try {
    if (preflight.status !== "ready") {
      return await invokeEngine("execution-kiro-record", ["--binding", paths.binding, "--output", paths.output], options);
    }
    const processReturn = await collectKiroProcess(preflight, options);
    const resultPath = await writeProcessReturn(temporaryDirectory, processReturn);
    return await invokeEngine("execution-kiro-record", ["--binding", paths.binding, "--result", resultPath, "--output", paths.output], options);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: "KIRO_RUN_FAILED", error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
