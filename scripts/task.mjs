#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  fileRecord,
  repositoryRoot,
  readDependencyManifest,
  readJson,
  readSourceFile,
  toPosixPath,
  walkFiles,
} from "./lib/files.mjs";
import { P1_TASKS, runAllP1Legs } from "./p1-sequence.mjs";
import { compareCanonicalText } from "./lib/canonical-order.mjs";
import { codeOnly, controlByteOffset } from "./lib/code-only.mjs";
import { LocalCommandError, runLocalCommand } from "./lib/local-command.mjs";
import { DependencyGraphError, validateFrozenDependencyGraph } from "./lib/dependency-graph.mjs";
import { validateVendoredRuntimeInventory, VENDORED_RUNTIME_NOTICES, VENDORED_RUNTIME_SOURCE } from "./lib/vendored-runtime.mjs";
import { HeavyRunsError, acquireHeavySlot } from "./lib/heavy-runs.mjs";
import {
  aggregatePrivacySurface,
  decodeGitMetadataBytes,
  decodePrivacyScanBytes,
  parseGitObjectBatch,
  scanPrivacyEntries,
  walkHistoricalCommitPaths,
} from "./lib/privacy.mjs";
import { privateRuntimeConfig } from "./lib/private-token-roster.mjs";
import { assertP8TagPreconditions, assertReleaseCommitShape } from "./lib/release-tag-gate.mjs";
import { ProtocolProofError } from "./lib/protocol-proof.mjs";
import {
  BoundaryError,
  bindOutputSessionProcessGroup,
  assertCleanExclusiveSourceBasis,
  readBoundRegularFile,
  safeCleanOutputRoot,
  safeResetOutputDirectory,
  safeWriteOutput,
  withExclusiveOutputSession,
} from "./lib/safe-io.mjs";
import { delay, PROGRESS_WAIT_MAX_MS, readProgressDelta, summarizeProgress, waitForProgress } from "./lib/incremental-output.mjs";
import { installNoNetworkGuard } from "./no-network.mjs";
import { ScopedStripTypesError, stripTypesWithScopedExperimentalWarning } from "./lib/scoped-strip-types.mjs";
import { TarError, writeUstar } from "./lib/tar.mjs";

installNoNetworkGuard();

const command = process.argv[2];
const textExtensions = new Set([".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);
const textNames = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  ".npmrc",
  "LICENSE",
  "NOTICE",
]);
const noNetworkImport = pathToFileURL(resolve(repositoryRoot, "scripts/no-network.mjs")).href;
const testControllerBootstrapPath = resolve(repositoryRoot, "scripts/test-controller-bootstrap.mjs");

// The release library reads the names module (packages/core/src/names.ts), so it is loaded
// when a release command needs it, never when this runner starts: the disposable
// task-entrypoint fixtures carry only scripts/ and node_modules/, and the runner must
// start there.
async function p8Release() {
  return import("./lib/p8-workflow-rc.mjs");
}

class TaskError extends Error {
  constructor(reasonCode, message, details = null) {
    super(message);
    this.name = "TaskError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details = null) {
  throw new TaskError(reasonCode, message, details);
}

function assertion(condition, reasonCode, detail = "") {
  if (!condition) {
    fail(reasonCode, detail || reasonCode);
  }
}

function success(reasonCode, fields = {}) {
  return { reasonCode, ...fields };
}

function run(executable, arguments_, options = {}) {
  return runLocalCommand(executable, arguments_, { cwd: repositoryRoot, ...options });
}

function controllerTimeoutMs() {
  const configured = Number(process.env.TCRN_TEST_CONTROLLER_TIMEOUT_MS ?? "600000");
  assertion(Number.isSafeInteger(configured) && configured > 0 && configured <= 600_000, "TEST_CONTROLLER_TIMEOUT_INVALID", String(configured));
  return configured;
}

function terminateTestControllerGroup(processGroup) {
  try { process.kill(-processGroup, "SIGTERM"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function runDetachedTestController(arguments_, extraEnvironment) {
  const progressDirectory = await mkdtemp(join(tmpdir(), "tcrn-test-progress-"));
  const progressPath = join(progressDirectory, "events.ndjson");
  const reaperReadyPath = join(progressDirectory, "reaper.json");
  const coverageDirectory = typeof extraEnvironment?.NODE_V8_COVERAGE === "string" ? extraEnvironment.NODE_V8_COVERAGE : null;
  let child;
  try {
    const controllerEnvironment = {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      ...extraEnvironment,
      TCRN_TEST_CONTROLLER_LOCK_PATH: resolve(repositoryRoot, ".git/einzbern-output.lock"),
      TCRN_TEST_CONTROLLER_OUTER_PID: String(process.pid),
      TCRN_TEST_CONTROLLER_PROGRESS_PATH: progressPath,
      TCRN_TEST_CONTROLLER_REAPER_READY_PATH: reaperReadyPath,
    };
    // The supervisor and reaper are lifecycle owners, not coverage writers.
    // Remove the inherited collector only from this child environment; the
    // worker receives the explicit path below and keeps coverage enabled.
    delete controllerEnvironment.NODE_V8_COVERAGE;
    if (coverageDirectory) controllerEnvironment.TCRN_TEST_CONTROLLER_COVERAGE_DIRECTORY = coverageDirectory;
    else delete controllerEnvironment.TCRN_TEST_CONTROLLER_COVERAGE_DIRECTORY;
    child = spawn(process.execPath, [testControllerBootstrapPath, ...arguments_], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Keep the coverage directory explicit for the worker. The bootstrap
      // and reaper stop their supervisor-only collectors; NODE_V8_COVERAGE
      // itself is never globally unset.
      env: controllerEnvironment,
    });
    assertion(Number.isSafeInteger(child.pid) && child.pid > 0, "TEST_CONTROLLER_PID_INVALID");
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const result = new Promise((resolveResult, rejectResult) => {
      child.once("error", rejectResult);
      // The bootstrap keeps controller streams private, so no controller
      // descendant can retain these task-facing descriptors. Waiting for close
      // preserves complete stdout/stderr capture before zero-stderr validation
      // and command-wide output-session release.
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });
    if (process.env.TCRN_TEST_BIND_PROCESS_GROUP_FAILURE === "1") {
      // This test-only injection exercises the failure branch before owner
      // metadata can authorize the controller to discover a test file.
      const reaperProcessGroup = await waitForTestControllerReaper(reaperReadyPath, child.pid, result);
      child.kill("SIGTERM");
      await result;
      await waitForProcessGroupExit(child.pid);
      await waitForProcessGroupExit(reaperProcessGroup);
      fail("TEST_CONTROLLER_BIND_INJECTED_FAILURE", "test-only pre-bind injection");
    }
    const reaperProcessGroup = await waitForTestControllerReaper(reaperReadyPath, child.pid, result);
    await waitForTestControllerBindWindow();
    // The reaper owns the lock's group so stale-owner recovery waits for it to
    // finish cleaning both the controller group and every registered gate
    // group. The bootstrap remains a separate process group it can terminate.
    await bindOutputSessionProcessGroup(reaperProcessGroup);

    const timeoutMs = controllerTimeoutMs();
    const startedAt = Date.now();
    const resultOutcome = result.then((value) => ({ kind: "exit", value }), (error) => ({ kind: "error", error }));
    let cursor = 0;
    let events = [];
    let counters = { polls: 0, unchangedPolls: 0, bytesRead: 0 };
    let completed;
    while (completed === undefined) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        terminateTestControllerGroup(child.pid);
        await resultOutcome;
        let groupJoinError = null;
        try { await waitForProcessGroupExit(child.pid); }
        catch (error) { groupJoinError = {reasonCode: error.reasonCode ?? "TEST_CONTROLLER_GROUP_JOIN_FAILED", message: error.message}; }
        try { await waitForProcessGroupExit(reaperProcessGroup); }
        catch (error) { groupJoinError ??= {reasonCode: error.reasonCode ?? "TEST_CONTROLLER_REAPER_JOIN_FAILED", message: error.message}; }
        fail("TEST_CONTROLLER_TIMEOUT", JSON.stringify({
          primaryError: "controller timeout",
          cleanupErrors: groupJoinError === null ? [] : [groupJoinError],
          processGroup: child.pid,
          coverageDirectory,
        }));
      }
      const waitController = new AbortController();
      const wait = waitForProgress(progressPath, {
        cursor,
        events,
        timeoutMs: Math.min(remaining, PROGRESS_WAIT_MAX_MS),
        pollMs: 25,
        maxPollMs: 1_000,
        counters,
        signal: waitController.signal,
      });
      const outcome = await Promise.race([
        resultOutcome,
        wait.then((value) => ({ kind: "progress", value }), (error) => ({ kind: "progress-error", error })),
      ]);
      waitController.abort();
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "exit") {
        completed = outcome.value;
        try {
          const delta = await readProgressDelta(progressPath, cursor);
          cursor = delta.nextCursor;
          events = [...events, ...delta.events];
          counters = {
            polls: counters.polls + 1,
            unchangedPolls: counters.unchangedPolls + (delta.events.length === 0 ? 1 : 0),
            bytesRead: counters.bytesRead + delta.bytesRead,
          };
        } catch {
          // The controller's exit result remains authoritative when the final
          // progress read cannot be completed.
        }
        break;
      }
      if (outcome.kind === "progress-error") throw outcome.error;
      cursor = outcome.value.cursor;
      events = outcome.value.events;
      counters = { polls: outcome.value.polls, unchangedPolls: outcome.value.unchangedPolls, bytesRead: outcome.value.bytesRead };
      if (["completed", "failed", "orphaned"].includes(outcome.value.status)) {
        const remainingAfterProgress = timeoutMs - (Date.now() - startedAt);
        let exitOutcome = { kind: "timeout" };
        if (remainingAfterProgress > 0) {
          exitOutcome = await new Promise((resolveOutcome) => {
            const timer = setTimeout(() => resolveOutcome({ kind: "timeout" }), remainingAfterProgress);
            resultOutcome.then((value) => {
              clearTimeout(timer);
              resolveOutcome(value);
            });
          });
        }
        if (exitOutcome.kind === "timeout") {
          terminateTestControllerGroup(child.pid);
          await resultOutcome;
          let groupJoinError = null;
          try { await waitForProcessGroupExit(child.pid); }
          catch (error) { groupJoinError = {reasonCode: error.reasonCode ?? "TEST_CONTROLLER_GROUP_JOIN_FAILED", message: error.message}; }
          try { await waitForProcessGroupExit(reaperProcessGroup); }
          catch (error) { groupJoinError ??= {reasonCode: error.reasonCode ?? "TEST_CONTROLLER_REAPER_JOIN_FAILED", message: error.message}; }
          fail("TEST_CONTROLLER_TIMEOUT", JSON.stringify({
            primaryError: "controller did not close after " + outcome.value.status,
            cleanupErrors: groupJoinError === null ? [] : [groupJoinError],
            processGroup: child.pid,
            coverageDirectory,
          }));
        }
        if (exitOutcome.kind === "error") throw exitOutcome.error;
        completed = exitOutcome.value;
        break;
      }
    }
    await waitForProcessGroupExit(child.pid);
    await waitForProcessGroupExit(reaperProcessGroup);
    const progress = { ...summarizeProgress(events), cursor, ...counters, lastProgress: events.at(-1) ?? null };
    if (completed.code === 0 && progress.status !== "completed") {
      fail("TEST_CONTROLLER_PROGRESS_MISSING", JSON.stringify(progress));
    }
    if (completed.code !== 0) {
      fail("COMMAND_FAILED", JSON.stringify({
        command: [process.execPath, ...arguments_],
        primaryError: { code: completed.code, signal: completed.signal, reasonCode: "COMMAND_FAILED" },
        cleanupErrors: progress.cleanupErrors ?? [],
        raw: { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") },
        lastProgress: events.at(-1) ?? null,
        progress,
        coverageDirectory,
        processGroup: child.pid,
      }));
    }
    if (Buffer.concat(stderr).toString("utf8").trim() !== "") {
      fail("COMMAND_UNEXPECTED_STDERR", JSON.stringify({
        command: [process.execPath, ...arguments_],
        primaryError: { code: completed.code, signal: completed.signal, reasonCode: "COMMAND_UNEXPECTED_STDERR" },
        cleanupErrors: progress.cleanupErrors ?? [],
        raw: { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") },
        lastProgress: events.at(-1) ?? null,
        progress,
        coverageDirectory,
        processGroup: child.pid,
      }));
    }
    return { progress };
  } finally {
    await rm(progressDirectory, { recursive: true, force: true });
  }
}

async function waitForTestControllerReaper(path, bootstrapPid, controllerResult = null) {
  assertion(path === resolve(path), "TEST_CONTROLLER_REAPER_READY_PATH_INVALID", path);
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    try {
      const metadata = await lstat(path);
      assertion(!metadata.isSymbolicLink() && metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600 &&
        (typeof process.getuid !== "function" || metadata.uid === process.getuid()),
        "TEST_CONTROLLER_REAPER_READY_INVALID", path);
      const bytes = await readFile(path, "utf8");
      const ready = JSON.parse(bytes);
      assertion(JSON.stringify(Object.keys(ready)) === JSON.stringify(["bootstrapPid", "reaperPid"]) &&
        bytes === `${JSON.stringify(ready)}\n` && ready.bootstrapPid === bootstrapPid &&
        Number.isSafeInteger(ready.reaperPid) && ready.reaperPid > 0 && ready.reaperPid !== bootstrapPid,
      "TEST_CONTROLLER_REAPER_READY_INVALID", path);
      try { process.kill(ready.reaperPid, 0); }
      catch (error) {
        if (error?.code === "ESRCH") fail("TEST_CONTROLLER_REAPER_NOT_LIVE", String(ready.reaperPid));
        throw error;
      }
      if (process.platform !== "win32") {
        try { process.kill(-ready.reaperPid, 0); }
        catch (error) {
          if (error?.code === "ESRCH") fail("TEST_CONTROLLER_REAPER_GROUP_NOT_LIVE", String(ready.reaperPid));
          throw error;
        }
      }
      return ready.reaperPid;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      if (controllerResult) {
        const outcome = await Promise.race([controllerResult.then(() => "closed", () => "closed"), delay(10).then(() => "waiting")]);
        if (outcome === "closed") fail("TEST_CONTROLLER_REAPER_READY_MISSING", path);
      }
      await delay(10);
    }
  }
  fail("TEST_CONTROLLER_REAPER_READY_TIMEOUT", path);
}

async function waitForTestControllerBindWindow() {
  const holdPath = process.env.TCRN_TEST_BIND_WINDOW_HOLD_PATH;
  if (!holdPath) return;
  assertion(holdPath === resolve(holdPath), "TEST_CONTROLLER_BIND_WINDOW_PATH", holdPath);
  await waitForLifecycleCondition(async () => {
    try {
      await lstat(holdPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }, () => fail("TEST_CONTROLLER_BIND_WINDOW_TIMEOUT", holdPath));
}

// TCRN-CROSS-INC-393 (TCRN-CROSS-SUB-402): kill(-group, 0) can answer EPERM for a group whose
// members are still exiting. EPERM is asked again inside the same 10 s window; ESRCH is exit. Any
// other code fails closed at once, and an EPERM that outlasts the window fails closed with that
// code. Test seam, and only that: TCRN_TEST_PROCESS_GROUP_PROBE_CODES is a comma-separated list
// of error codes that the first probes of each call report instead of probing; a last code
// ending in "*" is reported by every later probe of the call.
async function waitForProcessGroupExit(processGroup) {
  const seam = process.env.TCRN_TEST_PROCESS_GROUP_PROBE_CODES;
  const injected = seam === undefined || seam === "" ? [] : seam.split(",");
  const repeatsLast = injected.at(-1)?.endsWith("*") === true;
  if (repeatsLast) injected[injected.length - 1] = injected.at(-1).slice(0, -1);
  assertion(injected.every((code) => /^E[A-Z0-9]+$/u.test(code)), "TEST_CONTROLLER_GROUP_PROBE_INJECTION_INVALID", String(seam));
  let probes = 0;
  let unresolvedCode = null;
  await waitForLifecycleCondition(() => {
    const injectedCode = probes < injected.length ? injected[probes] : repeatsLast ? injected.at(-1) : undefined;
    probes += 1;
    try {
      if (injectedCode !== undefined) throw Object.assign(new Error(`injected ${injectedCode}`), { code: injectedCode });
      process.kill(-processGroup, 0);
      unresolvedCode = null;
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      if (error.code === "EPERM") {
        unresolvedCode = error.code;
        return false;
      }
      fail("TEST_CONTROLLER_GROUP_LIVENESS_UNKNOWN", `${processGroup}: ${error.code ?? error.message}`);
    }
  }, () => unresolvedCode === null
    ? fail("TEST_CONTROLLER_GROUP_LIVENESS_TIMEOUT", String(processGroup))
    : fail("TEST_CONTROLLER_GROUP_LIVENESS_UNKNOWN", `${processGroup}: ${unresolvedCode}`));
}

async function waitForLifecycleCondition(probe, onTimeout) {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    if (await probe()) return;
    await delay(10);
  }
  return onTimeout();
}

async function readText(path) {
  return (await readSourceFile(path)).toString("utf8");
}

// TCRN-CROSS-STORY-467 R2: the source set is what git tracks. The hand-kept allowlist that
// mirrored it, and the P1 leg that held the two in step, are retired; an untracked file (a
// host's local settings, say) never enters the archive, and a tracked file that is missing
// on disk fails the bound read instead of being skipped.
function trackedSourcePaths() {
  return run("git", ["ls-files", "-z"]).split("\0").filter((path) => path.length > 0).sort(compareCanonicalText);
}

async function sourceRecords() {
  return Promise.all(trackedSourcePaths().map((path) => fileRecord(resolve(repositoryRoot, path))));
}

async function verifyRuntime() {
  assertion(process.version === "v24.16.0", "RUNTIME_NODE_VERSION", process.version);
  const warningFilters = process.execArgv.filter((argument) => argument.startsWith("--disable-warning="));
  assertion(warningFilters.length === 0, "RUNTIME_WARNING_FILTER_FORBIDDEN", warningFilters.join(","));
  const userAgent = process.env.npm_config_user_agent ?? "";
  assertion(userAgent.startsWith("pnpm/11.3.0 "), "RUNTIME_PNPM_VERSION", userAgent || "missing");
  return success("RUNTIME_VERIFIED", { node: process.version, pnpm: "11.3.0" });
}

async function formatCheck({ write = false } = {}) {
  const files = await walkFiles();
  const findings = [];
  for (const path of files) {
    const name = toPosixPath(relative(repositoryRoot, path));
    if (!textExtensions.has(extname(path)) && !textNames.has(name)) {
      continue;
    }
    const original = await readText(path);
    let normalized = original.replace(/\r\n?/gu, "\n");
    if (!name.endsWith(".md")) {
      normalized = normalized
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/u, ""))
        .join("\n");
    }
    normalized = `${normalized.replace(/\n*$/u, "")}\n`;
    if (name.endsWith(".json")) {
      normalized = `${JSON.stringify(JSON.parse(normalized), null, 2)}\n`;
    }
    if (normalized !== original) {
      if (write) {
        await writeFile(path, normalized);
      } else {
        findings.push(name);
      }
    }
  }
  assertion(findings.length === 0, "FORMAT_MISMATCH", findings.join(","));
  return success(write ? "FORMAT_APPLIED" : "FORMAT_VERIFIED", {
    checked: files.length,
    rewritten: write,
  });
}

async function lint() {
  const files = await walkFiles();
  const moduleFiles = files.filter((path) => path.endsWith(".mjs"));
  for (const path of moduleFiles) {
    run(process.execPath, ["--check", path]);
  }
  // Byte hygiene runs before every content rule: a file carrying a raw control byte
  // cannot be reviewed by grep at all, so it must fail here rather than be judged by
  // rules that read it as text. Same text-file scope as format-check.
  for (const path of files) {
    const name = toPosixPath(relative(repositoryRoot, path));
    if (!textExtensions.has(extname(path)) && !textNames.has(name)) continue;
    const offset = controlByteOffset(await readSourceFile(path));
    assertion(offset === -1, "LINT_CONTROL_BYTE", `${name}@${offset}`);
  }
  for (const path of files.filter((candidate) => candidate.endsWith(".ts"))) {
    const content = await readText(path);
    const code = codeOnly(content);
    assertion(!/\bany\b/u.test(code), "LINT_EXPLICIT_ANY", toPosixPath(relative(repositoryRoot, path)));
    // @ts-ignore is a comment by construction, so this one keeps reading the whole file.
    assertion(!content.includes("@ts-ignore"), "LINT_TS_IGNORE", toPosixPath(relative(repositoryRoot, path)));
    assertion(!/\beval\s*\(/u.test(code), "LINT_EVAL", toPosixPath(relative(repositoryRoot, path)));
  }
  for (const path of files.filter((candidate) => candidate.includes("/.github/workflows/") && candidate.endsWith(".yml"))) {
    const content = await readText(path);
    assertion(!content.includes("pull_request_target"), "CI_PULL_REQUEST_TARGET_FORBIDDEN");
    for (const line of content.split("\n").filter((value) => value.trim().startsWith("uses:"))) {
      assertion(
        /uses:\s+[^@\s]+@[a-f0-9]{40}(?:\s+#.*)?$/u.test(line.trim()),
        "CI_ACTION_NOT_PINNED",
        line.trim(),
      );
    }
  }
  return success("LINT_VERIFIED", { modules: moduleFiles.length });
}

// The typecheck gate is memoized for the lifetime of the process. verify:p1
// invokes it directly and also reaches it through build and workspace; without
// this the pinned compiler would run four times per suite for one answer. Each
// command still typechecks when run on its own, because a fresh process starts
// with an empty cache.
let memoizedTypecheck = null;

async function typecheck() {
  if (memoizedTypecheck === null) memoizedTypecheck = runTypecheck();
  return memoizedTypecheck;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runTypecheck() {
  await verifyRuntime();
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const content = await readText(path);
    assertion(
      !/function\s+\w+\s*\([^)]*\)\s*\{/u.test(content),
      "TYPECHECK_RETURN_TYPE_REQUIRED",
      toPosixPath(relative(repositoryRoot, path)),
    );
  }
  // A tree carrying TypeScript must carry the project that governs it. This is
  // asserted before the skip below, so deleting tsconfig.json can never be a way
  // to walk past the compiler — it fails the gate instead of silencing it.
  const projectPath = resolve(repositoryRoot, "tsconfig.json");
  const projectPresent = await pathExists(projectPath);
  assertion(files.length === 0 || projectPresent, "TYPECHECK_PROJECT_MISSING", "tsconfig.json");
  // A tree with no TypeScript at all — the disposable task-entrypoint fixtures
  // are the only such tree here — has nothing for the compiler to check.
  if (!projectPresent) {
    return success("TYPECHECK_VERIFIED", { files: 0, engine: "no-typescript-sources" });
  }
  // SDC-4: the gate must run the version this repository pins, never whatever a
  // caller happens to have resolved. Both facts are read and compared here.
  const manifest = await readJson(resolve(repositoryRoot, "package.json"));
  const pinnedVersion = manifest.devDependencies?.typescript ?? "";
  assertion(/^\d+\.\d+\.\d+$/u.test(pinnedVersion), "TYPECHECK_COMPILER_NOT_PINNED", pinnedVersion);
  const compilerPackage = await readDependencyManifest(resolve(repositoryRoot, "node_modules/typescript/package.json"));
  assertion(
    compilerPackage.version === pinnedVersion,
    "TYPECHECK_COMPILER_VERSION_MISMATCH",
    `${compilerPackage.version} != ${pinnedVersion}`,
  );
  const compiler = resolve(repositoryRoot, "node_modules/typescript/lib/tsc.js");
  // Zero tolerance, per the push-gate hardening: --pretty false gives one
  // machine-readable diagnostic per line, and ANY line at all fails the gate.
  // Nothing here distinguishes an error from a warning or a suggestion.
  const invocation = [compiler, "--noEmit", "--pretty", "false", "--project", "tsconfig.json"];
  let diagnostics = "";
  try {
    diagnostics = run(process.execPath, invocation);
  } catch (error) {
    if (!(error instanceof LocalCommandError)) throw error;
    diagnostics = error.message;
  }
  const reported = diagnostics
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(`${process.execPath} ${compiler}`));
  assertion(reported.length === 0, "TYPECHECK_DIAGNOSTIC", reported.join(" | "));
  return success("TYPECHECK_VERIFIED", {
    files: files.length,
    engine: `typescript-${pinnedVersion}`,
  });
}

async function build() {
  const checked = await typecheck();
  await safeResetOutputDirectory(repositoryRoot, "dist/build");
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const source = await readText(path);
    const output = stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false });
    const target = toPosixPath(relative(repositoryRoot, path)).replace(/\.ts$/u, ".js");
    await safeWriteOutput(repositoryRoot, `dist/build/${target}`, `${output.replace(/\n*$/u, "")}\n`);
  }
  const runtimeCapacity = await readSourceFile(resolve(repositoryRoot, "scripts/lib/runtime-capacity.mjs"));
  await safeWriteOutput(repositoryRoot, "dist/build/scripts/lib/runtime-capacity.mjs", runtimeCapacity);
  const canonicalOrder = await readSourceFile(resolve(repositoryRoot, "scripts/lib/canonical-order.mjs"));
  await safeWriteOutput(repositoryRoot, "dist/build/scripts/lib/canonical-order.mjs", canonicalOrder);
  // TCRN-CROSS-SUB-484: the heavy-run semaphore, which the CLI's gates-run and the machine settings
  // catalog import by relative path, as they import runtime-capacity.mjs.
  const heavyRuns = await readSourceFile(resolve(repositoryRoot, "scripts/lib/heavy-runs.mjs"));
  await safeWriteOutput(repositoryRoot, "dist/build/scripts/lib/heavy-runs.mjs", heavyRuns);
  const dispatchConfigPath = resolve(repositoryRoot, "packages/core/src/dispatch-config.ts");
  const dispatchDefaultsPath = resolve(repositoryRoot, "packages/core/data/dispatch-defaults.json");
  if (await pathExists(dispatchConfigPath)) {
    const dispatchDefaults = await readSourceFile(dispatchDefaultsPath);
    await safeWriteOutput(
      repositoryRoot,
      "dist/build/packages/core/data/dispatch-defaults.json",
      dispatchDefaults,
    );
  }
  return success("BUILD_VERIFIED", {
    files: files.length,
    engine: checked.engine,
    output: "dist/build",
  });
}

// TCRN-CROSS-STORY-359: this took twenty-nine filter options, one per retired verb, and
// each one selected a subset of the same `tests/**/*.test.mjs` set. One survives, with a
// caller that is not a `verify:*` name: `p8Only` is the release train's dogfood leg. The
// external-trust leg (`trustOnly`) retired with the trust root (TCRN-CROSS-STORY-467 R2).
async function runTests({ p8Only = false, extraEnvironment = {} } = {}) {
  await build();
  const tests = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"))
    .filter((path) => !p8Only || ["tests/local-command-byte-fidelity.test.mjs", "tests/p8-workflow-rc.test.mjs"].includes(path));
  // TCRN-CROSS-STORY-469 R3: the suite never reaches the real device directory. Every test
  // process receives its own device home under this owned run root. The fallback
  // also keeps any test without the helper away from the real device directory.
  const deviceDirectory = await mkdtemp(join(tmpdir(), "einzbern-test-device-"));
  let controller;
  try {
    controller = await runDetachedTestController(["--test", ...tests], {
      NODE_OPTIONS: `--import=${noNetworkImport}`,
      TCRN_OFFLINE_PROOF: "1",
      EINZBERN_HOME: join(deviceDirectory, "einzbern"),
      EINZBERN_TEST_DEVICE_ROOT: deviceDirectory,
      ...extraEnvironment,
    });
  } finally {
    await rm(deviceDirectory, { recursive: true, force: true });
  }
  return success(
    p8Only ? "P8_WORKFLOW_RC_TESTS_VERIFIED" : "TESTS_VERIFIED",
    { tests, result: "passed", progress: controller.progress },
  );
}

// TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3): the test leg runs the suite and nothing
// beside it. The coverage registry and the surviving-module coverage read that used to run
// under NODE_V8_COVERAGE after it are retired with coverage conservation.
async function verifyTestSuite() {
  return runTests();
}

async function verifyP8() {
  const {
    P8_SUPPORTED_AOS_RELEASES,
    P8_RELEASE_ARCHIVE,
    P8_RELEASE_ARCHIVE_SHA256,
    P8_TAG,
    P8_VERSION,
    buildP8ReleaseArtifacts,
    moveStaleReleaseArtifacts,
    p8ArtifactRecords,
    p8ReleasePrivacyEntries,
    rebuildP8SourceArchiveInIndependentRoots,
  } = await p8Release();
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  const packagePaths = ["package.json", "packages/cli/package.json", "packages/core/package.json", "packages/protocol/package.json"];
  const packages = await Promise.all(packagePaths.map((path) => readJson(resolve(repositoryRoot, path))));
  assertion(packages.every((manifest) => manifest.version === P8_VERSION && manifest.private === true), "P8_PACKAGE_VERSION_MISMATCH");
  const frameworkSource = await readText(resolve(repositoryRoot, "packages/core/src/framework-version.ts"));
  assertion(frameworkSource.includes(`FRAMEWORK_VERSION = \"${P8_VERSION}\"`), "P8_FRAMEWORK_VERSION_MISMATCH");
  const core = await import(pathToFileURL(resolve(repositoryRoot, "dist/build/packages/core/src/index.js")).href);
  assertion(core.FRAMEWORK_VERSION === P8_VERSION, "P8_BUILD_VERSION_MISMATCH");
  assertion(P8_SUPPORTED_AOS_RELEASES.length === 0, "P8_SUPPORTED_AOS_RELEASES_MISMATCH");
  const dogfood = await runTests({ p8Only: true });
  const sourceArchive = await archive();
  const sbomResult = await sbom();
  const sourceBytes = await readSourceFile(resolve(repositoryRoot, sourceArchive.path));
  const sbomBytes = await readSourceFile(resolve(repositoryRoot, sbomResult.path));
  const independentlyRebuilt = await rebuildP8SourceArchiveInIndependentRoots({
    repositoryRoot,
    allowedFiles: trackedSourcePaths(),
  });
  assertion(sourceBytes.equals(independentlyRebuilt.archive), "P8_ARCHIVE_REPRODUCIBILITY_MISMATCH");
  // TCRN-CROSS-STORY-461 R1 (#232): a source archive left by the previous version is moved
  // to dist/stale-release before the new artifacts are written and the set is asserted. A prior
  // formal package and sidecar are moved by the same versioned-artifact rule.
  const staleReleaseArtifacts = await moveStaleReleaseArtifacts(repositoryRoot);
  // Run the existing deterministic package producer in this invocation. Reading its two files
  // back prevents P8 from passing on a previous run's package or a claimed-only sha256 result.
  const packedText = run(process.execPath, [resolve(repositoryRoot, "scripts/pack-release.mjs"), "--version", P8_VERSION]);
  let packed;
  try { packed = JSON.parse(packedText); } catch { fail("P8_RELEASE_PACK_TERMINAL_INVALID", "pack-release did not return its JSON result"); }
  assertion(packed.reasonCode === "RELEASE_PACKED" && packed.version === P8_VERSION, "P8_RELEASE_PACK_FAILED");
  const releaseArchive = await readSourceFile(resolve(repositoryRoot, `dist/release/${P8_RELEASE_ARCHIVE}`));
  const releaseArchiveSha256 = await readSourceFile(resolve(repositoryRoot, `dist/release/${P8_RELEASE_ARCHIVE_SHA256}`));
  assertion(packed.sha256 === createHash("sha256").update(releaseArchive).digest("hex"), "P8_RELEASE_PACK_DIGEST_MISMATCH");
  const artifacts = buildP8ReleaseArtifacts({ sourceArchive: sourceBytes, sbom: sbomBytes, releaseArchive, releaseArchiveSha256 });
  for (const [name, content] of artifacts) await safeWriteOutput(repositoryRoot, `dist/release/${name}`, content);
  // TCRN-CROSS-INIT-053 R48-01 (R47-REG-1): the seven artifacts and the formal package's content
  // (gzip text fields, every ustar header, padding and end block, each member's path and body)
  // come from the one builder the P8 face of verifyPrivacy also scans; the compressed bytes are
  // bound by digest there and are not read as text.
  const { entries: releasePrivacyEntries } = p8ReleasePrivacyEntries(artifacts);
  const owner = await remoteOwner();
  const privacyFindings = scanPrivacyEntries(releasePrivacyEntries, { owner, repositories: await engineRepositoryNames() });
  assertion(privacyFindings.length === 0, "P8_RELEASE_PRIVACY_FINDINGS", privacyFindings.join(","));
  const privacy = await verifyPrivacy({ requireP8Surfaces: true });
  const p8BasisCommit = run("git", ["rev-parse", "HEAD"]);
  return success("P8_WORKFLOW_RC_VERIFIED", {
    tag: P8_TAG,
    p8BasisCommit,
    tests: dogfood.reasonCode,
    sourceArchive,
    sbom: sbomResult,
    artifacts: p8ArtifactRecords(artifacts),
    staleReleaseArtifacts,
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    network: false,
    mutation: false,
    publication: false,
    releaseStatus: "accepted_release",
    privacy: privacy.reasonCode,
    reproducibility: {
      sha256: independentlyRebuilt.sha256,
      sourceFiles: independentlyRebuilt.sourceFiles,
      orderedEntries: independentlyRebuilt.orderedEntries,
      rootsIndependent: independentlyRebuilt.rootsIndependent,
    },
    privacySurfaces: privacy.p8Surfaces,
  });
}

async function verifyReleaseTagPreflight() {
  // INC-133 item 3. The format gate lives inside `verify-p1`, which needs a clean
  // checkout under the exclusive output session — a condition no working tree meets
  // mid-change, which is why the gate was never part of any train and two schema
  // files shipped un-normalised in 0.11.9 and 0.11.10. A release commit is exactly
  // when that condition IS met, so the gate belongs here: at the last point before a
  // tag, on the tree that tag will name. Asserted directly rather than by running the
  // whole of p1, because p1's other basis checks are the release's own subject.
  const format = await formatCheck();
  const p8 = await verifyP8();
  const expectedTagIndex = process.argv.indexOf("--tag");
  const expectedTag = expectedTagIndex >= 0 ? process.argv[expectedTagIndex + 1] : (await p8Release()).P8_TAG;
  const tagCommit = run("git", ["rev-parse", "HEAD"]);
  const parentRecord = run("git", ["rev-list", "--parents", "-n", "1", tagCommit]).split(/\s+/u);
  assertion(parentRecord.length === 2, "RELEASE_TAG_COMMIT_PARENT_INVALID", parentRecord.join(" "));
  const changedPaths = run("git", ["diff", "--name-only", `${parentRecord[1]}..${tagCommit}`]).split("\n").filter(Boolean);
  const tagProof = assertP8TagPreconditions({ p8Result: p8, expectedTag, tagCommit, p8BasisCommit: p8.p8BasisCommit });
  const version = expectedTag.slice(1);
  const shapeInput = { changedPaths, version };
  if (changedPaths.includes("packages/core/src/framework-version.ts")) {
    // Resolve each real commit's full blob id, then read that object's complete bytes. Caller
    // text, abbreviated ids and working-tree content cannot stand in for either committed source.
    const sourceAt = (commit) => {
      const entry = run("git", ["ls-tree", commit, "--", "packages/core/src/framework-version.ts"]);
      const matched = /^100644 blob ([0-9a-f]{40,64})\tpackages\/core\/src\/framework-version\.ts$/u.exec(entry);
      assertion(matched !== null, "RELEASE_COMMIT_FRAMEWORK_INVALID", "the committed framework source must be a regular blob");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(run("git", ["cat-file", "blob", matched[1]], { raw: true }));
      } catch (error) {
        fail("RELEASE_COMMIT_FRAMEWORK_INVALID", `the committed framework source must be complete UTF-8: ${String(error?.message ?? error)}`);
      }
    };
    shapeInput.frameworkBefore = sourceAt(parentRecord[1]);
    shapeInput.frameworkAfter = sourceAt(tagCommit);
  }
  const { README_NAMES, renderReadmes } = await import("./render-readme.mjs");
  if (changedPaths.some((path) => README_NAMES.includes(path))) {
    shapeInput.generatedReadmes = await renderReadmes({ root: repositoryRoot, version, check: true });
  }
  if (changedPaths.includes("docs/wiki/CLI-Reference.md")) {
    run(process.execPath, [resolve(repositoryRoot, "scripts/wiki-cli-reference.mjs"), "--check"]);
    shapeInput.cliReferenceChecked = true;
  }
  const commitShape = assertReleaseCommitShape(shapeInput);
  return success("RELEASE_TAG_PREFLIGHT_VERIFIED", {
    ...tagProof,
    commitShape,
    staleReleaseArtifacts: p8.staleReleaseArtifacts,
    formatChecked: format.checked,
    publication: false,
    mutation: false,
  });
}


// TCRN-CROSS-STORY-481 R2: the source archive is written by scripts/lib/tar.mjs, the writer the
// release archive uses too: paths in canonical order, mtime 0, owner 0, mode 0755 for a file that
// starts with "#!" and 0644 otherwise.
async function archive() {
  const records = [];
  for (const record of await sourceRecords()) {
    records.push({ path: record.path, bytes: await readSourceFile(resolve(repositoryRoot, record.path)) });
  }
  let output;
  try {
    output = writeUstar(records);
  } catch (error) {
    // The reason code this task has always given a path the ustar name field cannot hold.
    if (error instanceof TarError && error.reasonCode === "TAR_PATH_TOO_LONG") fail("ARCHIVE_PATH_TOO_LONG", error.details.path);
    throw error;
  }
  const relativePath = "dist/source/einzbern-source.tar";
  await safeWriteOutput(repositoryRoot, relativePath, output);
  return success("ARCHIVE_VERIFIED", {
    path: relativePath,
    sha256: createHash("sha256").update(output).digest("hex"),
    files: records.length,
  });
}

async function sbom() {
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/dependency-policy.json"));
  const lockContent = await readSourceFile(resolve(repositoryRoot, "pnpm-lock.yaml"));
  const packageContent = await readSourceFile(resolve(repositoryRoot, "package.json"));
  const vendoredContent = await readSourceFile(resolve(repositoryRoot, "scripts/policy/vendored-runtime.json"));
  const snapshotContent = await readSourceFile(resolve(repositoryRoot, VENDORED_RUNTIME_SOURCE));
  const noticeContent = await readSourceFile(resolve(repositoryRoot, VENDORED_RUNTIME_NOTICES));
  const vendored = validateVendoredRuntimeInventory(JSON.parse(vendoredContent.toString("utf8")), snapshotContent, noticeContent);
  const basis = createHash("sha256").update(packageContent).update(lockContent).update(vendoredContent).update(snapshotContent).update(noticeContent).digest("hex");
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy: policy, lockContent: lockContent.toString("utf8") });
  const components = [...graph.records.map((record) => {
    return {
      type: "library",
      name: record.name,
      version: record.version,
      scope: record.direct ? "optional" : "required",
      licenses: [{ license: { id: record.license } }],
      purl: `pkg:npm/${encodeURIComponent(record.name)}@${record.version}`,
    };
  }), ...vendored];
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${basis.slice(0, 8)}-${basis.slice(8, 12)}-4${basis.slice(13, 16)}-a${basis.slice(17, 20)}-${basis.slice(20, 32)}`,
    version: 1,
    metadata: {
      component: { type: "application", name: packageJson.name, version: packageJson.version },
      properties: [{ name: "tcrn:deterministic-basis-sha256", value: basis }],
    },
    components,
  };
  const relativePath = "dist/sbom/sbom.cdx.json";
  await safeWriteOutput(repositoryRoot, relativePath, `${JSON.stringify(document, null, 2)}\n`);
  return success("SBOM_VERIFIED", {
    path: relativePath,
    components: components.length,
    directComponents: graph.directIdentities.length,
    transitiveComponents: graph.transitiveIdentities.length,
    dependencyGraphClosure: "complete",
    dependencyGraphScope: "lockfile",
    vendoredComponents: vendored.length,
    vendoredInventory: "digest-bound-snapshot-and-notices",
    basis,
  });
}

// The engine repository's GitHub names come from the names module, loaded when a remote is
// judged rather than when this runner starts (the task-entrypoint fixtures carry scripts/ only).
async function engineRepositoryNames() {
  return (await import("./lib/names.mjs")).ENGINE_REPOSITORY_NAMES;
}

function repositoryNamePattern(names) {
  return names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
}

async function remoteOwner() {
  const remote = run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(new RegExp(`github\\.com[/:]([^/]+)/(?:${repositoryNamePattern(await engineRepositoryNames())})(?:\\.git)?$`, "u"));
  assertion(match, "PRIVACY_ORIGIN_UNEXPECTED");
  return match[1];
}

async function archiveEntryIfPresent() {
  const archivePath = resolve(repositoryRoot, "dist/source/einzbern-source.tar");
  try {
    await lstat(archivePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const archiveInput = await readBoundRegularFile(archivePath, {
    reasonCode: "PRIVACY_ARCHIVE_INVALID",
    hardlinkReasonCode: "PRIVACY_ARCHIVE_HARDLINK",
    pathChangedReasonCode: "PRIVACY_ARCHIVE_CHANGED",
  });
  return [{
    label: "dist/source/einzbern-source.tar",
    kind: "archive",
    content: archiveInput.content,
  }];
}

async function filesForPrivacySurface(root, labelPrefix = "") {
  const files = (await walkFiles(root)).filter((path) => {
    const relativePath = toPosixPath(relative(root, path));
    // This ignored file is host-local observer runtime configuration. It is
    // deliberately excluded from public/history release surfaces. The independent
    // fingerprint check that used to cover it, verify:observe-channel, retired in
    // TCRN-CROSS-STORY-359.
    return !(root === repositoryRoot && relativePath === ".claude/settings.local.json");
  });
  return Promise.all(files.map(async (path) => ({
    path: `${labelPrefix}${toPosixPath(relative(root, path))}`,
    content: await readSourceFile(path),
  })));
}

async function verifyPrivacy(options = {}) {
  const requireP8Surfaces = Boolean(options.requireP8Surfaces);
  const historyScope = options.historyScope === undefined ? "head" : options.historyScope;
  assertion(historyScope === "head" || historyScope === "all", "PRIVACY_SCOPE_INVALID", historyScope);
  const privacyProgressPath = resolve(repositoryRoot, "dist/evidence/p1/privacy-progress.json");
  await mkdir(dirname(privacyProgressPath), { recursive: true });
  const privacyProgressStartedAt = new Date().toISOString();
  const privacyProgressTemporaryPath = `${privacyProgressPath}.${process.pid}.tmp`;
  let privacyProgressTerminal = false;
  const writePrivacyProgress = (fields) => {
    const terminal = fields.status === "completed";
    const document = {
      schemaVersion: "tcrn.privacy-scan-progress.v1",
      command: requireP8Surfaces ? "p8" : "privacy",
      status: "running",
      conclusion: "unknown",
      startedAt: privacyProgressStartedAt,
      updatedAt: new Date().toISOString(),
      ...fields,
    };
    writeFileSync(privacyProgressTemporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(privacyProgressTemporaryPath, privacyProgressPath);
    privacyProgressTerminal = terminal;
  };
  try {
    writePrivacyProgress({ phase: "initializing", historicalPaths: 0 });
    return await verifyPrivacyScan(options, writePrivacyProgress);
  } catch (error) {
    if (!privacyProgressTerminal) {
      try {
        writePrivacyProgress({
          status: "completed",
          conclusion: "not-verifiable",
          reasonCode: error?.reasonCode ?? "TASK_INTERNAL_ERROR",
          phase: "interrupted",
        });
      } catch {
        // Preserve the scan's original failure if evidence storage is also unavailable.
      }
    }
    throw error;
  }
}

// TCRN-CROSS-MIN-280 D3: EINZBERN_PRIVACY_HISTORY_BASE names the pull request's base commit (CI
// sets it on pull_request events only). The increment is the commits reachable from HEAD and not
// from that commit (`HEAD ^<base>`, the same set `HEAD ^<merge-base>` selects), read with rev-list
// alone so the read-only Git boundary of local-command.mjs is unchanged. Unset or empty means the
// full HEAD-reachable history, and so does a HEAD with no commit beyond the base.
function privacyIncrementBase() {
  const raw = process.env.EINZBERN_PRIVACY_HISTORY_BASE;
  if (raw === undefined || raw === "") return null;
  assertion(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(raw), "PRIVACY_HISTORY_BASE_INVALID", raw);
  const base = run("git", ["rev-parse", "--verify", `${raw}^{commit}`]).trim();
  assertion(base === raw, "PRIVACY_HISTORY_BASE_INVALID", raw);
  return run("git", ["rev-list", "--count", "HEAD", `^${base}`]).trim() === "0" ? null : base;
}

// The historical path walk needs every tree of every scanned commit, including the subtrees it
// shares with the base, so those trees join the objects the increment introduced.
function incrementObjectIds(introduced, base) {
  const ids = new Set(introduced);
  for (const commit of run("git", ["rev-list", "HEAD", `^${base}`]).split("\n").filter(Boolean)) {
    ids.add(run("git", ["rev-parse", `${commit}^{tree}`]).trim());
    for (const tree of run("git", ["ls-tree", "-r", "-d", "--object-only", commit]).split("\n").filter(Boolean)) ids.add(tree);
  }
  return [...ids];
}

async function verifyPrivacyScan(options = {}, writePrivacyProgress) {
  const { requireP8Surfaces = false, historyScope = "head" } = options;
  writePrivacyProgress({ phase: "source-surface-scan", historicalPaths: 0 });
  const owner = await remoteOwner();
  const entries = [];
  entries.push({
    label: "git-origin",
    kind: "remote",
    content: run("git", ["remote", "get-url", "origin"]),
  });
  const trackedSourceRecords = await filesForPrivacySurface(repositoryRoot);
  for (const record of trackedSourceRecords) {
    const label = record.path;
    entries.push({ label, kind: "filename", content: label });
    entries.push({ label, kind: "source", content: record.content.toString("utf8") });
  }
  entries.push(...await archiveEntryIfPresent());

  // The public CI world is the checked-out release tip, not every object that happens
  // to be present in a clone. A full object database includes old tags, pull refs and
  // unreachable pre-hardening blobs; scanning that set makes a clean tip permanently
  // red for content that is not in the evaluated release. The explicit history command
  // below preserves the broader scan as a separately named local diagnostic.
  // TCRN-CROSS-MIN-280 D3: on a pull request, history is scanned from the merge-base on; the
  // whole tracked tree, the refs and the origin are still scanned above and below. The P8
  // scan and the all-objects diagnostic never take the increment.
  const incrementBase = requireP8Surfaces || historyScope !== "head" ? null : privacyIncrementBase();
  const reachable = (range) => decodeGitMetadataBytes(run("git", ["rev-list", "--objects", ...range], { raw: true }), "PRIVACY_REACHABLE_OBJECTS_UTF8_INVALID")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/u)[0]);
  const objectIds = historyScope !== "head"
    ? null
    : incrementBase === null
      ? reachable(["HEAD"])
      : incrementObjectIds(reachable(["HEAD", `^${incrementBase}`]), incrementBase);
  if (objectIds !== null) {
    assertion(objectIds.length > 0, "PRIVACY_REACHABLE_OBJECTS_EMPTY");
    assertion(objectIds.every((object) => /^[a-f0-9]{40,64}$/u.test(object)), "PRIVACY_REACHABLE_OBJECTS_INVALID");
    assertion(new Set(objectIds).size === objectIds.length, "PRIVACY_REACHABLE_OBJECTS_DUPLICATE");
  }
  const objectInput = objectIds === null ? undefined : Buffer.from(`${objectIds.join("\n")}\n`, "utf8");
  // One streaming pass over the selected object set. --batch emits
  // "<oid> <type> <size>\n" followed by exactly <size> bytes and a trailing newline,
  // so the payload stays binary-safe: the length comes from the header, never from
  // scanning for a delimiter. A batch-check pass runs first and declares every object
  // in exactly the header form the batch pass emits, so the total stream length is known
  // before the capture. Both drift directions fail closed rather than yielding a short
  // stream whose unscanned tail would leave the privacy gate green.
  writePrivacyProgress({ phase: "git-object-index", objectCount: objectIds?.length ?? null, historicalPaths: 0 });
  const batchCheck = run(
    "git",
    objectIds === null
      ? ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]
      : ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { raw: true, input: objectInput, maxBuffer: 64 * 1024 * 1024 },
  );
  let expectedStreamBytes = batchCheck.length;
  const batchCheckLines = decodeGitMetadataBytes(batchCheck, "PRIVACY_GIT_OBJECT_INDEX_UTF8_INVALID").split("\n").filter(Boolean);
  if (objectIds !== null) {
    assertion(batchCheckLines.length === objectIds.length, "PRIVACY_REACHABLE_OBJECT_COUNT_MISMATCH", `${objectIds.length}/${batchCheckLines.length}`);
  }
  for (const line of batchCheckLines) {
    const [object, type, sizeText] = line.split(" ");
    assertion(/^[a-f0-9]{40,64}$/u.test(object) && type !== "missing", "PRIVACY_GIT_OBJECT_TYPE", line);
    const declaredSize = Number(sizeText);
    assertion(Number.isSafeInteger(declaredSize) && declaredSize >= 0, "PRIVACY_GIT_OBJECT_TYPE", line);
    expectedStreamBytes += declaredSize + 1;
  }
  writePrivacyProgress({
    phase: "git-object-read",
    objectCount: batchCheckLines.length,
    expectedStreamBytes,
    historicalPaths: 0,
  });
  const batch = run(
    "git",
    objectIds === null ? ["cat-file", "--batch-all-objects", "--batch"] : ["cat-file", "--batch"],
    { raw: true, input: objectInput, maxBuffer: expectedStreamBytes + 1 },
  );
  const historyRecords = [];
  let objectCount = 0;
  for (const { object, type, content } of parseGitObjectBatch(batch, expectedStreamBytes)) {
    objectCount += 1;
    historyRecords.push({ path: `${type}:${object}`, content });
    entries.push({
      label: `git-${type}:${object}`,
      kind: type,
      content: decodePrivacyScanBytes(content),
    });
  }
  const buildRoot = resolve(repositoryRoot, "dist/build");
  const sourceArchivePath = resolve(repositoryRoot, "dist/source/einzbern-source.tar");
  const releaseRoot = resolve(repositoryRoot, "dist/release");
  const p8Surfaces = {};
  if (requireP8Surfaces) {
    for (const root of [buildRoot, releaseRoot]) {
      const metadata = await lstat(root).catch(() => null);
      assertion(metadata?.isDirectory(), "P8_PRIVACY_SURFACE_MISSING", root);
    }
    const sourceArchive = await readBoundRegularFile(sourceArchivePath, {
      reasonCode: "P8_PRIVACY_ARCHIVE_INVALID",
      hardlinkReasonCode: "P8_PRIVACY_ARCHIVE_HARDLINK",
      pathChangedReasonCode: "P8_PRIVACY_ARCHIVE_CHANGED",
    });
    const buildRecords = await filesForPrivacySurface(buildRoot, "dist/build/");
    const releaseRecords = await filesForPrivacySurface(releaseRoot, "dist/release/");
    const { p8ReleaseArtifactSetMatches, p8ReleasePrivacyEntries } = await p8Release();
    assertion(p8ReleaseArtifactSetMatches(releaseRecords.map((record) => record.path.slice("dist/release/".length))), "P8_PRIVACY_RELEASE_ARTIFACT_SET");
    entries.push(...buildRecords.map((record) => ({ label: record.path, kind: "build", content: record.content.toString("utf8") })));
    entries.push({ label: "dist/source/einzbern-source.tar", kind: "archive", content: sourceArchive.content });
    // TCRN-CROSS-INIT-053 R48-01 (R47-REG-1): the same entries verifyP8 scans, from the same
    // builder: the formal package by its content, its compressed bytes bound by digest only.
    entries.push(...p8ReleasePrivacyEntries(new Map(releaseRecords.map((record) => [record.path.slice("dist/release/".length), record.content]))).entries);
    p8Surfaces.aggregateAlgorithm = "sha256(path-NUL-byteLength-NUL-bytes over canonical path order)";
    p8Surfaces.trackedSource = aggregatePrivacySurface(trackedSourceRecords);
    p8Surfaces.fullHistory = aggregatePrivacySurface(historyRecords);
    p8Surfaces.buildOutput = aggregatePrivacySurface(buildRecords);
    p8Surfaces.sourceArchive = aggregatePrivacySurface([{ path: "dist/source/einzbern-source.tar", content: sourceArchive.content }]);
    p8Surfaces.releaseArtifacts = aggregatePrivacySurface(releaseRecords);
  }
  const commits = run("git", historyScope === "all" ? ["rev-list", "--all"] : incrementBase === null ? ["rev-list", "HEAD"] : ["rev-list", "HEAD", `^${incrementBase}`]).split("\n").filter(Boolean);
  writePrivacyProgress({
    phase: "historical-tree-scan",
    completedCommits: 0,
    totalCommits: commits.length,
    historicalPaths: 0,
    lastCompletedCommit: null,
  });
  let historicalPaths = 0;
  let completedHistoryCommits = 0;
  let lastCompletedCommit = null;
  let lastHistoryProgressAt = Date.now();
  const historyBlobPaths = new Map(historyRecords
    .filter((record) => record.path.startsWith("blob:"))
    .map((record) => [record.path.slice("blob:".length), new Set()]));
  try {
    const historyProgress = await walkHistoricalCommitPaths(
      commits,
      historyRecords,
      (commit, path, object) => {
        historyBlobPaths.get(object)?.add(path);
        entries.push({ label: `git-commit-tree:${commit}:${path}`, kind: "filename", content: path });
        historicalPaths += 1;
        const now = Date.now();
        if (historicalPaths % 10_000 === 0 && now - lastHistoryProgressAt >= 1_000) {
          writePrivacyProgress({
            phase: "historical-tree-scan",
            completedCommits: completedHistoryCommits,
            totalCommits: commits.length,
            currentCommit: commit,
            historicalPaths,
            lastCompletedCommit,
          });
          lastHistoryProgressAt = now;
        }
      },
      async ({ commit, completedCommits, totalCommits, historicalPaths: scannedPaths }) => {
        completedHistoryCommits = completedCommits;
        lastCompletedCommit = commit;
        const now = Date.now();
        if (completedCommits === totalCommits || completedCommits % 25 === 0 || now - lastHistoryProgressAt >= 1_000) {
          writePrivacyProgress({
            phase: "historical-tree-scan",
            completedCommits,
            totalCommits,
            currentCommit: null,
            historicalPaths: scannedPaths,
            lastCompletedCommit: commit,
          });
          lastHistoryProgressAt = now;
        }
      },
    );
    historicalPaths = historyProgress.historicalPaths;
  } catch (error) {
    writePrivacyProgress({
      status: "completed",
      conclusion: "not-verifiable",
      reasonCode: error?.reasonCode ?? "TASK_INTERNAL_ERROR",
      phase: "historical-tree-scan",
      completedCommits: null,
      totalCommits: commits.length,
      historicalPaths,
    });
    throw error;
  }
  for (const entry of entries) {
    if (entry.kind === "blob") {
      entry.sourcePaths = [...(historyBlobPaths.get(entry.label.slice("git-blob:".length)) ?? [])];
    }
  }
  const refs = run("git", ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)"], { raw: true });
  entries.push({ label: "git-refs", kind: "ref", content: decodeGitMetadataBytes(refs, "PRIVACY_REFS_UTF8_INVALID") });
  // INC-122: feed the gate the deployment-private runtime values so the
  // PRIVATE_RUNTIME_VALUE legs are actually built. The roster is value-free by
  // design (the host supplies the values at runtime), so on a governed host —
  // where settings.local provides real TCRN_SSH_* values — the scan now catches
  // the bare governed hostname and runtime root (e.g. baked into a tracked test
  // fixture) that the earlier legs, keyed on suffixes and encoders, missed. When
  // the environment is unconfigured (a public CI checkout) no real value is known
  // and none is invented, so nothing private is embedded in the gate itself.
  const runtime = privateRuntimeConfig();
  // Only the genuinely-private values: the governed hostname and its runtime
  // root. The loopback address and the facade port are not secret and appear as
  // ordinary literals throughout the tree, so feeding them would red on every
  // legitimate loopback reference rather than on leaked topology.
  const privateTokens = runtime.configured
    ? [runtime.host, runtime.runtimeRoot, `${runtime.runtimeRoot}/governance`]
    : [];
  writePrivacyProgress({
    phase: "privacy-matching",
    completedCommits: commits.length,
    totalCommits: commits.length,
    historicalPaths,
    entriesScanned: 0,
    totalEntries: entries.length,
  });
  let lastMatchProgressAt = Date.now();
  const findings = scanPrivacyEntries(entries, {
    owner,
    privateTokens,
    repositories: await engineRepositoryNames(),
    onProgress: ({ entriesScanned, totalEntries }) => {
      const now = Date.now();
      if (entriesScanned === totalEntries || now - lastMatchProgressAt >= 1_000) {
        writePrivacyProgress({
          phase: "privacy-matching",
          completedCommits: commits.length,
          totalCommits: commits.length,
          historicalPaths,
          entriesScanned,
          totalEntries,
        });
        lastMatchProgressAt = now;
      }
    },
  });
  if (findings.length > 0) {
    writePrivacyProgress({
      status: "completed",
      conclusion: "blocked",
      reasonCode: "PRIVACY_FINDINGS",
      phase: "privacy-matching",
      completedCommits: commits.length,
      totalCommits: commits.length,
      historicalPaths,
      entriesScanned: entries.length,
      totalEntries: entries.length,
    });
    assertion(false, "PRIVACY_FINDINGS", findings.join(","));
  }
  writePrivacyProgress({
    status: "completed",
    conclusion: "verified",
    reasonCode: "PRIVACY_SOURCE_CLEAN",
    phase: "complete",
    completedCommits: commits.length,
    totalCommits: commits.length,
    historicalPaths,
    entriesScanned: entries.length,
    totalEntries: entries.length,
  });
  return success("PRIVACY_SOURCE_CLEAN", {
    privacyScope: historyScope !== "head" ? "all-local-objects" : incrementBase === null ? "HEAD-reachable" : "pull-request-increment",
    ...(incrementBase === null ? {} : { historyBase: incrementBase }),
    scannedEntries: entries.length,
    gitObjects: objectCount,
    historicalCommits: commits.length,
    historicalFullPaths: historicalPaths,
    archiveScanned: entries.some((entry) => entry.kind === "archive"),
    allowedPublicMetadata: "strict-github-noreply-commit-or-tag-lines-only",
    allowedPublicControlMetadata: "exact-p3-marker-contract-only",
    sourceFiles: trackedSourcePaths().length,
    p8Surfaces: requireP8Surfaces ? p8Surfaces : null,
  });
}

async function verifyNoSiblingDependency() {
  // TCRN-CROSS-INC-215. The dependency-direction rule was prose and a hand-run grep;
  // INC-214 cleared five reaching sites that way and nothing stopped a sixth.
  const result = JSON.parse(run(process.execPath, [resolve(repositoryRoot, "scripts/no-sibling-dependency-proof.mjs")]));
  assertion(result.ok === true, "SIBLING_DEPENDENCY_PRESENT",
    result.findings.map((finding) => `${finding.file}:${finding.line} → ${finding.sibling}`).join(","));
  return success("NO_SIBLING_DEPENDENCY", { siblings: result.siblings, scannedRoots: result.scannedRoots });
}

// R8 D12: allow the sole fetch site only while the CLI rejects missing or
// malformed versions and the local archive branch returns before release retrieval.
// Returning null grants no exception; the normal scan flags every fetch site.
const versionedInstallerPath = "skill/mana-orchestrate/scripts/install.mjs";

function versionScopedInstallerFetchOffset(label, content) {
  if (label !== versionedInstallerPath) return null;
  const fetchCalls = [...content.matchAll(/\bfetch\s*\(/gu)];
  if (fetchCalls.length !== 1) return null;

  const parseStart = content.indexOf("function parseArguments(argv) {");
  const releaseUrlStart = content.indexOf("\nfunction releaseUrl(", parseStart);
  if (parseStart < 0 || releaseUrlStart < 0) return null;
  const parseSource = content.slice(parseStart, releaseUrlStart);
  if (!parseSource.includes('const version = values.get("--version") ?? null;') ||
    !parseSource.includes('const archive = values.has("--archive") ? resolve(values.get("--archive")) : null;') ||
    !parseSource.includes('if (version === null && archive === null) fail("INSTALL_USAGE"') ||
    !parseSource.includes('if (version !== null && !VERSION_PATTERN.test(version)) fail("INSTALL_VERSION_INVALID"')) return null;

  const downloadStart = content.indexOf("async function download(url) {");
  const downloadEnd = content.indexOf("\n// The first word of a .sha256 file", downloadStart);
  const obtainStart = content.indexOf("async function obtainArchive({ version, archive, sha256 }) {");
  const obtainEnd = content.indexOf("\nfunction text(", obtainStart);
  if (downloadStart < 0 || downloadEnd < 0 || obtainStart < 0 || obtainEnd < 0) return null;

  const fetchOffset = fetchCalls[0].index;
  const downloadSource = content.slice(downloadStart, downloadEnd);
  if (fetchOffset < downloadStart || fetchOffset >= downloadEnd ||
    !downloadSource.includes(`response = await ${["fetch", "("].join("")}url);`)) return null;

  const obtainSource = content.slice(obtainStart, obtainEnd);
  const localStart = obtainSource.indexOf("if (archive !== null) {");
  const versionStart = obtainSource.indexOf("const url = releaseUrl(version,");
  if (localStart < 0 || versionStart <= localStart) return null;
  const localArchiveSource = obtainSource.slice(localStart, versionStart);
  if (/\b(?:fetch|download)\s*\(/u.test(localArchiveSource) ||
    !localArchiveSource.includes("if (sha256 !== null) return { bytes, expected: sha256, source: archive };") ||
    !localArchiveSource.includes("return { bytes, expected: statedDigest(stated,")) return null;

  const versionRetrievalSource = obtainSource.slice(versionStart);
  const downloadSites = [...content.matchAll(/\bdownload\s*\(/gu)];
  if (downloadSites.length !== 3 ||
    !versionRetrievalSource.includes("const bytes = await download(url);") ||
    !versionRetrievalSource.includes("const expected = sha256 ?? statedDigest(") ||
    !/await download\(\x60\$\{url\}\.sha256\x60\)/u.test(versionRetrievalSource) ||
    [...versionRetrievalSource.matchAll(/\bdownload\s*\(/gu)].length !== 2) return null;

  return fetchOffset;
}

async function verifyOfflineBoundary() {
  const guardFiles = new Set(["scripts/no-network.mjs", "tests/offline-boundary.test.mjs"]);
  const localUnixSocketTest = "tests/output-session-lifecycle.test.mjs";
  // The boundary this gate defends is "the engine does not reach the network". The portal
  // is a loopback server: it binds 127.0.0.1 and serves bytes already on disk, and its
  // test drives that server through the same interface a browser would. Listing the pair
  // here states which files are allowed to be servers rather than weakening the predicate
  // for everything — every other file in the repository is still judged the same way.
  const loopbackServerFiles = new Set(["portal/portal.mjs", "portal/tests/portal.test.mjs"]);
  const modules = [
    "node:" + "http",
    "node:" + "https",
    "node:" + "net",
    "node:" + "tls",
    "node:" + "dns",
    "node:" + "dgram",
    ["un", "dici"].join(""),
  ];
  const findings = [];
  for (const path of (await walkFiles()).filter((candidate) => [".mjs", ".ts"].includes(extname(candidate)))) {
    const label = toPosixPath(relative(repositoryRoot, path));
    const content = await readText(path);
    if (!guardFiles.has(label) && !loopbackServerFiles.has(label)) {
      // Only the version-checked retrieval branch may contain this one fetch call.
      const permittedFetchOffset = versionScopedInstallerFetchOffset(label, content);
      for (const moduleName of modules) {
        const localUnixSocketImport = label === localUnixSocketTest && moduleName === modules[2];
        if (!localUnixSocketImport && (content.includes(`\"${moduleName}\"`) || content.includes(`'${moduleName}'`))) {
          findings.push(`NETWORK_MODULE:${label}:${moduleName}`);
        }
      }
      for (const match of content.matchAll(/\bfetch\s*\(/gu)) {
        if (match.index !== permittedFetchOffset) findings.push("NETWORK_API:" + label);
      }
      if (/\bWebSocket\s*\(/u.test(content)) {
        findings.push(`NETWORK_API:${label}`);
      }
    }
  }
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const externalTools = [["cu", "rl"].join(""), ["wg", "et"].join(""), ["np", "x"].join("")];
  for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
    if (externalTools.some((tool) => new RegExp(`(?:^|\\s)${tool}(?:\\s|$)`, "u").test(script))) {
      findings.push(`NETWORK_TOOL:${name}`);
    }
    if (/[;&|]{1,2}/u.test(script)) {
      findings.push(`SHELL_CONJUNCTION:${name}`);
    }
  }
  const npmrc = await readText(resolve(repositoryRoot, ".npmrc"));
  for (const setting of ["offline=true", "audit=false", "fund=false", "update-notifier=false"]) {
    if (!npmrc.split("\n").includes(setting)) {
      findings.push(`OFFLINE_SETTING:${setting}`);
    }
  }
  assertion(findings.length === 0, "OFFLINE_BOUNDARY_FINDINGS", findings.join(","));
  run(process.execPath, ["--test", "tests/offline-boundary.test.mjs"], {
    env: { NODE_OPTIONS: `--import=${noNetworkImport}`, TCRN_OFFLINE_PROOF: "1" },
  });
  return success("OFFLINE_BOUNDARY_VERIFIED", {
    nodeProcessGuard: true,
    staticProcessAllowlist: ["node", "git-local-only", "pinned-pnpm-offline-isolated-proof"],
    telemetry: "no-client-detected",
    osNetworkSandbox: "not-provided",
    freshAdvisoryScan: "not-performed",
    ciDependencyAcquisition: "explicit-external-boundary",
  });
}

// TCRN-CROSS-STORY-467 R5: a test seam, and only that. EINZBERN_P1_INJECT is a JSON object
// naming rostered legs: a reason code makes that leg red without running it, `true` makes
// it pass without running it. A run that used the seam lists the injected legs and never
// reports P1_VERIFIED, so no caller that requires P1_VERIFIED can be satisfied through it.
function p1Injection() {
  const raw = process.env.EINZBERN_P1_INJECT;
  if (raw === undefined || raw === "") return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("P1_INJECTION_INVALID", "EINZBERN_P1_INJECT is not JSON");
  }
  assertion(value !== null && typeof value === "object" && !Array.isArray(value), "P1_INJECTION_INVALID", "EINZBERN_P1_INJECT must be an object");
  for (const [task, outcome] of Object.entries(value)) {
    assertion(P1_TASKS.includes(task), "P1_INJECTION_INVALID", `unknown leg ${task}`);
    assertion(outcome === true || typeof outcome === "string" && /^[A-Z][A-Z0-9_]*$/u.test(outcome), "P1_INJECTION_INVALID", `${task}: an outcome is true or a reason code`);
  }
  return value;
}

async function verifyP1() {
  assertCleanExclusiveSourceBasis(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
  const injection = p1Injection();
  const injected = Object.keys(injection);
  // The roster lives in scripts/p1-sequence.mjs so preflight runs this same list rather
  // than a copy of it (TCRN-CROSS-INC-218). Every leg runs, and every red is reported with
  // its own reason code (TCRN-CROSS-STORY-467 R5).
  const outcome = await runAllP1Legs(async (name) => {
    if (!Object.hasOwn(injection, name)) return invoke(name);
    if (injection[name] === true) return success("P1_LEG_INJECTED_PASS");
    return fail(injection[name], `${name}: injected red (EINZBERN_P1_INJECT)`);
  });
  const receipt = {
    commands: P1_TASKS,
    legs: outcome.legs,
    durations: outcome.durations,
    ...(injected.length === 0 ? {} : { injected }),
  };
  if (outcome.reds.length > 0) {
    fail("P1_RED", outcome.reds.map((red) => `${red.task}: ${red.reasonCode}`).join("; "), { ...receipt, reds: outcome.reds });
  }
  const notices = outcome.legs.flatMap((leg) => leg.notice === undefined ? [] : [{ command: leg.task, ...leg.notice }]);
  return success(injected.length === 0 ? "P1_VERIFIED" : "P1_VERIFIED_WITH_INJECTION", {
    ...receipt,
    observedReasonCodes: outcome.legs.map((leg) => leg.reasonCode),
    notices,
  });
}

async function verifyPortal() {
  return JSON.parse(run(process.execPath, [resolve(repositoryRoot, "scripts/verify-portal.mjs")]));
}

async function clean() {
  const result = await safeCleanOutputRoot(repositoryRoot);
  return success("OUTPUTS_CLEANED", result);
}

// TCRN-CROSS-INC-232: every relative Markdown link in a tracked file must resolve.
// Dispatched through here like every other leg rather than pointed straight at its
// script -- the p1 roster criterion asserts exactly that, and caught it when this one
// was wired the short way.
async function verifyLinks() {
  const { inspectMarkdownLinks } = await import("./markdown-link-resolution.mjs");
  const result = await inspectMarkdownLinks(repositoryRoot);
  if (!result.ok) {
    fail("MARKDOWN_LINK_BROKEN",
      result.broken.map((entry) => `${entry.file} -> ${entry.target}`).join("; "));
  }
  return success("MARKDOWN_LINKS_RESOLVED", { files: result.files, checked: result.checked });
}

const handlers = {
  archive,
  build,
  clean,
  "format-check": () => formatCheck(),
  "format-write": () => formatCheck({ write: true }),
  links: verifyLinks,
  lint,
  offline: verifyOfflineBoundary,
  p8: verifyP8,
  portal: verifyPortal,
  "release-preflight": verifyReleaseTagPreflight,
  privacy: verifyPrivacy,
  sbom,
  "no-sibling-dependency": verifyNoSiblingDependency,
  test: verifyTestSuite,
  typecheck,
  "retrieval-eval": async () => {
    const result = JSON.parse(run(process.execPath, [resolve(repositoryRoot, "scripts/retrieval-eval.mjs")]));
    if (!result.ok) fail(result.reasonCode, result.message);
    return result;
  },
  "verify-p1": verifyP1,
};

function errorReason(error) {
  if (error instanceof TaskError || error instanceof LocalCommandError || error instanceof BoundaryError || error instanceof ProtocolProofError || error instanceof DependencyGraphError || error instanceof ScopedStripTypesError || error instanceof TarError || error instanceof HeavyRunsError) {
    return error.reasonCode;
  }
  return "TASK_INTERNAL_ERROR";
}

// TCRN-CROSS-STORY-359: this mapped thirty verb names onto eight evidence phases, one
// branch per retired ticket-numbered verb. Two phases still have a verb: `p8` is the
// release-candidate train, and everything else on the P1 roster writes under p1.
function evidencePhase(name) {
  return name === "p8" ? "p8" : "p1";
}

async function recordEvidence(name, ok, reasonCode, resultOrMessage) {
  const relativePath = `dist/evidence/${evidencePhase(name)}/${name}.json`;
  const document = ok
    ? { schemaVersion: "tcrn.command-evidence.v1", command: name, ok, reasonCode, result: resultOrMessage }
    : { schemaVersion: "tcrn.command-evidence.v1", command: name, ok, reasonCode, error: resultOrMessage };
  await safeWriteOutput(repositoryRoot, relativePath, `${JSON.stringify(document, null, 2)}\n`);
  return relativePath;
}

async function invoke(name) {
  const handler = handlers[name];
  assertion(handler, "TASK_UNKNOWN", name ?? "missing");
  try {
    const result = await handler();
    assertion(typeof result?.reasonCode === "string", "TASK_REASON_CODE_MISSING", name);
    await recordEvidence(name, true, result.reasonCode, result);
    return result;
  } catch (error) {
    const reasonCode = errorReason(error);
    await recordEvidence(name, false, reasonCode, error?.details ? { message: error.message, ...error.details } : error.message);
    throw error;
  }
}

// TCRN-CROSS-SUB-484 (MIN-257 D6): the whole suite is a heavy run. `test` takes a slot of
// execution.maxConcurrentHeavyRuns (scripts/lib/heavy-runs.mjs) before its output session, so it
// never holds the session while it waits, and keeps it until the suite has ended; the test
// processes it starts inherit the slot through EINZBERN_HEAVY_SLOT and take none of their own.
// TCRN-CROSS-SUB-493: `verify-p1` takes its slot the same way, at its entry and before its output
// session, because its legs are the suite and the portal train: every leg runs under that one slot
// and the processes a leg starts inherit it, so no leg waits for a slot its own run holds or
// carries a waiting line on its stderr; the only waiting line is p1's own, before any leg starts.
const HEAVY_COMMANDS = new Set(["test", "verify-p1"]);
let heavySlot = null;
try {
  if (HEAVY_COMMANDS.has(command)) heavySlot = await acquireHeavySlot({ command });
  const result = await withExclusiveOutputSession(repositoryRoot, async () => invoke(command));
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
} catch (error) {
  const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {};
  if (command === "p8") {
    const { p8FailureTerminal } = await p8Release();
    process.stdout.write(`${JSON.stringify(p8FailureTerminal({ reasonCode: errorReason(error), error: error.message || errorReason(error) }))}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({ ...details, ok: false, command, reasonCode: errorReason(error), error: error.message })}\n`);
  }
  process.exitCode = 1;
} finally {
  heavySlot?.release();
}
