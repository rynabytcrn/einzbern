#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-375 — machine evidence for a dispatch review.
//
// The caller supplies the immutable comparison basis and the pre-declared file
// scope. This tool runs the command recorded on the exact chain work item, runs
// the requested test command, counts the before/after test source with the AST
// counter, and measures the diff (including untracked files). It never accepts a
// caller-supplied passed flag or test count as evidence.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { countTests } from "./lib/test-count.mjs";
import { normalizeNativeImplementationResult } from "./final-gate-plan.mjs";

export const REVIEW_EVIDENCE_VERSION = "tcrn.review-evidence.v1";
export const REVIEW_OUTPUT_BYTES = 4 * 1024 * 1024;
export const REVIEW_COMMAND_TIMEOUT_MS = 600_000;

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ENGINE = resolve(REPOSITORY_ROOT, "scripts/einzbern.mjs");
const WORK_ID_PATTERN = /^work:[a-z0-9][a-z0-9._-]{0,127}$/u;

function text(value) {
  return typeof value === "string" ? value : "";
}

// Association validates a supplied host return; it does not authenticate the host,
// execute a dispatch, or convert the review runner into native execution evidence.
export const DISPATCH_EVIDENCE_VERSION = "tcrn.host-dispatch-evidence.v1";
const recordObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const digestString = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function canonicalEvidence(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  if (recordObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEvidence(value[key])}`).join(",")}}`;
  throw new TypeError("admission evidence must contain only JSON values");
}
export function dispatchAdmissionDigest(admission) {
  return createHash("sha256").update(canonicalEvidence(admission)).digest("hex");
}

/** Deterministic validation only. Undefined means the legacy path was requested. */
export function normalizeDispatchAdmissionEvidence(value, { workId = null, workRevision = null } = {}) {
  if (value === undefined) return { requested: false, valid: true, complete: false, status: "not-requested", problems: [], evidence: null };
  const problems = [];
  const input = recordObject(value) ? value : {};
  const handoff = recordObject(input.handoff) ? input.handoff : {};
  const admission = recordObject(handoff.executionAdmission) ? handoff.executionAdmission : {};
  const result = recordObject(input.hostResult) ? input.hostResult : {};
  const request = recordObject(admission.request) ? admission.request : {};
  const selection = recordObject(admission.selection) ? admission.selection : {};
  const tuple = recordObject(selection.record) ? selection.record : {};
  const policy = recordObject(admission.policy) ? admission.policy : {};
  const origin = recordObject(selection.origin) ? selection.origin : {};
  if (admission.schemaVersion !== "tcrn.execution-admission.v1" || admission.status !== "admitted" || !Array.isArray(admission.reasons) || admission.reasons.length !== 0) problems.push("handoff must contain an admitted execution admission without refusal reasons");
  if (!WORK_ID_PATTERN.test(text(handoff.workId)) || (workId !== null && handoff.workId !== workId)) problems.push("handoff workId does not match the reviewed work");
  if (!Number.isSafeInteger(handoff.workRevision) || handoff.workRevision < 1 || (workRevision !== null && handoff.workRevision !== workRevision)) problems.push("handoff workRevision is missing or differs from the bound work revision");
  const reference = handoff.reference;
  if (!recordObject(reference) || Object.keys(reference).sort().join(",") !== "libraryId,projectId" || !/^(library|workspace):[a-f0-9]{24}$/u.test(text(reference.libraryId)) || !/^project:[a-f0-9]{24}$/u.test(text(reference.projectId))) problems.push("handoff reference must be a stable project reference");
  if (!nonempty(request.host) || !nonempty(request.category) || !Number.isSafeInteger(request.rejections) || request.rejections < 0 || !Number.isSafeInteger(request.requestedAgents) || request.requestedAgents < 1) problems.push("admission request is missing or malformed");
  if (!["runner", "model", "effort"].every(key => nonempty(tuple[key]))) problems.push("admission selected tuple is missing or malformed");
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 1 || !digestString(policy.digest) || policy.host !== request.host) problems.push("admission policy identity is missing or malformed");
  if (selection.host !== request.host || selection.category !== request.category || selection.rejections !== request.rejections || origin.revision !== policy.revision || origin.digest !== policy.digest) problems.push("admission selection differs from its request or policy identity");
  if (result.schemaVersion !== DISPATCH_EVIDENCE_VERSION || result.source !== "native-host-return") problems.push("hostResult must explicitly identify a native-host-return, not review or test output");
  const compare = (actual, expected, label) => {
    try { if (canonicalEvidence(actual) === canonicalEvidence(expected)) return; } catch { /* missing or non-JSON binding */ }
    problems.push(`hostResult ${label} does not match the admission handoff`);
  };
  compare(result.workId, handoff.workId, "workId");
  compare(result.workRevision, handoff.workRevision, "workRevision");
  compare(result.projectReference, reference, "projectReference");
  compare(result.request, request, "request");
  compare(result.selectedTuple, { runner: tuple.runner, model: tuple.model, effort: tuple.effort }, "selectedTuple");
  compare(result.policyRevision, policy.revision, "policyRevision");
  compare(result.policyDigest, policy.digest, "policyDigest");
  let admissionDigest = null;
  try { admissionDigest = dispatchAdmissionDigest(admission); } catch { problems.push("admission is not JSON evidence"); }
  if (!digestString(result.admissionDigest) || result.admissionDigest !== admissionDigest) problems.push("hostResult admissionDigest does not match the complete admission receipt");
  const unavailable = [];
  for (const field of ["stdout", "stderr", "exitCode"]) {
    const observation = result[field];
    if (recordObject(observation) && observation.status === "available" && (field === "exitCode" ? Number.isSafeInteger(observation.value) && observation.value >= 0 : typeof observation.value === "string") && Object.keys(observation).sort().join(",") === "status,value") continue;
    if (recordObject(observation) && observation.status === "unavailable" && nonempty(observation.reason) && Object.keys(observation).sort().join(",") === "reason,status") unavailable.push(field);
    else problems.push(`hostResult ${field} must contain actual returned text/exit code or an explicit unavailable reason`);
  }
  return {
    requested: true, valid: problems.length === 0, complete: problems.length === 0 && unavailable.length === 0,
    status: problems.length > 0 ? "invalid" : unavailable.length > 0 ? "unavailable" : "associated",
    verification: "caller-supplied-host-return-not-independently-authenticated",
    problems, unavailable, admissionDigest, evidence: value,
  };
}

function childEnvironment() {
  const environment = { ...process.env };
  // Node's test runner marks a worker with NODE_TEST_CONTEXT. Passing that
  // implementation detail into a nested `node --test` makes the child skip its
  // files as a recursive test run; it is not part of the reviewed command's
  // environment and must not change the measured result.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function outputTail(value, maximum = REVIEW_OUTPUT_BYTES) {
  const bytes = Buffer.from(text(value), "utf8");
  if (bytes.length <= maximum) return bytes.toString("utf8");
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function fullOutput(path) {
  const bytes = readFileSync(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length > REVIEW_OUTPUT_BYTES) {
    return { text: "", bytes: bytes.length, sha256: digest, complete: false };
  }
  return { text: bytes.toString("utf8"), bytes: bytes.length, sha256: digest, complete: true };
}

function terminateProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* group already ended */ }
  try { process.kill(-pid, "SIGKILL"); } catch { /* group already ended */ }
}

function resultCode(result) {
  if (result.error?.code === "ETIMEDOUT") return "TIMEOUT";
  if (result.error?.code) return String(result.error.code);
  if (result.status === null || result.status === undefined) return "UNKNOWN";
  return String(result.status);
}

function runShell(command, cwd, timeoutMs = REVIEW_COMMAND_TIMEOUT_MS) {
  if (typeof command !== "string" || command.trim().length === 0 || command.includes("\u0000")) {
    return { command: command ?? null, cwd, exitCode: "INPUT_INVALID", stdout: "", stderr: "" };
  }
  let result;
  const outputDirectory = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-run-"));
  const stdoutPath = join(outputDirectory, "stdout");
  const stderrPath = join(outputDirectory, "stderr");
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = openSync(stdoutPath, "w", 0o600);
    stderrFd = openSync(stderrPath, "w", 0o600);
    // A detached shell owns a private process group. Node's synchronous timeout
    // sends the kill signal to that process group on this host; regular output
    // files keep a timed-out grandchild from holding a pipe open.
    result = spawnSync("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: REVIEW_OUTPUT_BYTES * 2,
      encoding: "utf8",
      stdio: ["ignore", stdoutFd, stderrFd],
      env: childEnvironment(),
    });
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    return { command, cwd, exitCode: String(error?.code ?? "START_FAILED"), stdout: "", stderr: String(error?.message ?? error) };
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  let stdout = { text: "", bytes: 0, sha256: createHash("sha256").digest("hex"), complete: true };
  let stderr = { text: "", bytes: 0, sha256: createHash("sha256").digest("hex"), complete: true };
  if (result.error || result.status !== 0) terminateProcessGroup(result.pid);
  try {
    stdout = fullOutput(stdoutPath);
    stderr = fullOutput(stderrPath);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
  const outputComplete = stdout.complete && stderr.complete;
  return {
    command,
    cwd,
    exitCode: outputComplete ? resultCode(result) : "OUTPUT_LIMIT",
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutSha256: stdout.sha256,
    stderrSha256: stderr.sha256,
    outputComplete,
  };
}

function runGit(repositoryRoot, args, { raw = false } = {}) {
  let result;
  try {
    result = spawnSync("git", ["-C", repositoryRoot, ...args], {
      encoding: raw ? "buffer" : "utf8",
      maxBuffer: REVIEW_OUTPUT_BYTES * 4,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} could not start: ${String(error?.message ?? error)}`);
  }
  if (result.status !== 0 || result.error) {
    const detail = outputTail(raw ? result.stderr?.toString("utf8") : result.stderr);
    throw new Error(`git ${args.join(" ")} failed (${resultCode(result)}): ${detail}`);
  }
  return raw ? result.stdout : text(result.stdout);
}

function repositoryRelative(repositoryRoot, candidate) {
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, candidate);
  const rest = relative(root, absolute);
  if (rest === "" || rest.startsWith("..") || rest.startsWith(sep) || rest.includes("\\")) return null;
  return rest.split(sep).join("/");
}

function pointerPath(value) {
  return text(value).replace(/:\d+(?::\d+)?$/u, "");
}

function normalizeAllowedFiles(repositoryRoot, allowedFiles) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) return { files: [], problems: ["allowedFiles must be a non-empty pre-declared list"] };
  const files = [];
  const problems = [];
  for (const entry of allowedFiles) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      problems.push("allowedFiles contains an empty entry");
      continue;
    }
    const raw = pointerPath(entry.trim());
    const normalized = repositoryRelative(repositoryRoot, raw);
    if (normalized === null) problems.push(`${entry} is outside repositoryRoot`);
    else files.push(normalized);
  }
  return { files: [...new Set(files)].sort(), problems };
}

function normalizeTestFiles(repositoryRoot, testFiles) {
  if (!Array.isArray(testFiles) || testFiles.length === 0) return { files: [], problems: ["testFiles must be a non-empty list of actual test paths"] };
  const files = [];
  const problems = [];
  for (const entry of testFiles) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      problems.push("testFiles contains an empty entry");
      continue;
    }
    const normalized = repositoryRelative(repositoryRoot, entry.trim());
    if (normalized === null || !normalized.endsWith(".test.mjs") || (!normalized.startsWith("tests/") && !normalized.startsWith("portal/tests/"))) {
      problems.push(`${entry} is not an in-repository test path`);
      continue;
    }
    if (!existsSync(resolve(repositoryRoot, normalized))) problems.push(`${normalized} does not exist in repositoryRoot`);
    else files.push(normalized);
  }
  return { files: [...new Set(files)].sort(), problems };
}

function parseNameStatus(bytes) {
  const parts = Buffer.isBuffer(bytes) ? bytes.toString("utf8").split("\0") : text(bytes).split("\0");
  const entries = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) continue;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = parts[index++] ?? "";
      const to = parts[index++] ?? "";
      entries.push({ status, paths: [from, to].filter(Boolean) });
    } else {
      const path = parts[index++] ?? "";
      entries.push({ status, paths: path ? [path] : [] });
    }
  }
  return entries;
}

function parsePorcelainStatus(bytes) {
  return (Buffer.isBuffer(bytes) ? bytes.toString("utf8") : text(bytes)).split("\0")
    .filter((entry) => entry.length >= 4)
    .map((entry) => ({ status: entry.slice(0, 2), paths: [entry.slice(3)] }));
}

export function diffEvidence(repositoryRoot, base, head = null) {
  const arguments_ = ["diff", "--name-status", "-z", "--find-renames", base];
  if (head !== null && head !== undefined) arguments_.push(head);
  arguments_.push("--");
  const diff = parseNameStatus(runGit(repositoryRoot, arguments_, { raw: true }));
  const status = parsePorcelainStatus(runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true }))
    .filter((entry) => entry.status === "??");
  const changedFiles = [...new Set([...diff, ...status].flatMap((entry) => entry.paths))].sort();
  const statuses = new Map();
  for (const entry of [...diff, ...status]) {
    for (const path of entry.paths) statuses.set(path, entry.status);
  }
  return {
    base,
    head: head ?? "WORKING_TREE",
    entries: diff,
    untracked: status,
    changedFiles,
    files: changedFiles.map((path) => ({ path, status: statuses.get(path) ?? "unknown" })),
  };
}

function parseTestNumber(output, label) {
  const match = text(output).match(new RegExp(`(?:^|\\n)\\s*ℹ\\s+${label}\\s+(\\d+)\\s*(?:\\n|$)`, "u"));
  return match ? Number(match[1]) : null;
}

function jsonObjects(output) {
  return text(output).split("\n").reverse().flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Parse runner output only; a prose "passed" or a supplied count is not accepted. */
export function parseTestRunOutput(stdout, stderr = "", declaredTestFiles = []) {
  const combined = `${text(stdout)}\n${text(stderr)}`;
  const structured = jsonObjects(stdout).find((value) => Array.isArray(value.tests) && value.tests.every((path) => typeof path === "string" && path.endsWith(".test.mjs")));
  if (structured !== undefined) {
    const testFiles = [...structured.tests];
    const testCases = parseTestNumber(combined, "tests");
    const passed = parseTestNumber(combined, "pass");
    const failed = parseTestNumber(combined, "fail");
    return {
      testFiles,
      testFileCount: testFiles.length,
      testCases,
      passed: passed ?? (structured.result === "passed" || structured.ok === true ? testCases : null),
      failed: failed ?? (structured.result === "passed" || structured.ok === true ? 0 : null),
      parseable: true,
      source: "engine-test-result.file-list",
    };
  }
  const testCases = parseTestNumber(combined, "tests");
  const passed = parseTestNumber(combined, "pass");
  const failed = parseTestNumber(combined, "fail");
  return {
    testFiles: [...declaredTestFiles],
    testFileCount: declaredTestFiles.length,
    testCases,
    passed,
    failed,
    parseable: testCases !== null && failed !== null,
    source: "node-test-case-summary",
  };
}

function readGitFile(repositoryRoot, ref, path) {
  try {
    return runGit(repositoryRoot, ["show", `${ref}:${path}`]);
  } catch {
    return "";
  }
}

function currentTestFiles(repositoryRoot) {
  const tracked = runGit(repositoryRoot, ["ls-files", "--", "tests/"])
    .split("\n").filter((path) => path.endsWith(".test.mjs"));
  let untracked = [];
  try {
    untracked = parsePorcelainStatus(runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true }))
      .flatMap((entry) => entry.paths).filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"));
  } catch { /* diffEvidence will report Git failures */ }
  return [...new Set([...tracked, ...untracked])].sort();
}

export function astTestEvidence(repositoryRoot, base, head = null, testFiles = currentTestFiles(repositoryRoot)) {
  const before = { testCount: 0, assertionCount: 0, files: [] };
  const after = { testCount: 0, assertionCount: 0, files: [] };
  for (const path of testFiles) {
    const beforeSource = readGitFile(repositoryRoot, base, path);
    const afterSource = head === null || head === undefined
      ? existsSync(resolve(repositoryRoot, path)) ? readFileSync(resolve(repositoryRoot, path), "utf8") : ""
      : readGitFile(repositoryRoot, head, path);
    const beforeCount = countTests(beforeSource);
    const afterCount = countTests(afterSource);
    before.testCount += beforeCount.testCount;
    before.assertionCount += beforeCount.assertionCount;
    after.testCount += afterCount.testCount;
    after.assertionCount += afterCount.assertionCount;
    before.files.push({ path, ...beforeCount });
    after.files.push({ path, ...afterCount });
  }
  return { testFiles, before, after };
}

function readBoundVerify({ workspace, workId, engineCli }) {
  if (!isAbsolute(text(workspace)) || !WORK_ID_PATTERN.test(text(workId))) {
    return { status: "unavailable", reason: "workspace/work-id binding is not qualified", command: null };
  }
  let output;
  let reason = "work-show failed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const child = spawnSync(process.execPath, [engineCli, "work-show", "--workspace", workspace, "--id", workId], {
        cwd: workspace,
        encoding: "utf8",
        // A live chain read can contend with the repository's parallel gate suite.
        // Keep the read bounded and retry a transient refusal before declaring the
        // binding unavailable.
        timeout: 30_000,
        maxBuffer: REVIEW_OUTPUT_BYTES * 2,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (child.status === 0 && !child.error) {
        output = JSON.parse(text(child.stdout));
        break;
      }
      reason = text(child.stderr).trim().slice(-200) || reason;
    } catch (error) {
      reason = String(error?.message ?? error);
    }
    if (attempt < 2) spawnSync("/bin/sleep", ["0.25"]);
  }
  if (output === undefined) {
    return { status: "unavailable", reason, command: null };
  }
  if (output?.record?.id !== workId) return { status: "unavailable", reason: "work-show returned a different record", command: null };
  const command = output?.advisory?.verify;
  if (typeof command === "string" && command.length > 0) return { status: "available", reason: "advisory:verify read from the bound work", command, workRevision: output.record.revision };
  const nativeResult = output?.advisory?.result;
  if (nativeResult !== undefined && nativeResult !== null) {
    const normalized = normalizeNativeImplementationResult(nativeResult, {
      workId,
      revision: output.record.revision,
      scopeDigest: output.record.scopeDigest,
      scope: output.advisory?.scope,
      externalKey: output.record.externalKey,
    });
    return {
      status: "native-only",
      workRevision: output.record.revision,
      reason: normalized.valid ? "native result is the bound implementation evidence" : normalized.reason,
      command: normalized.command,
      nativeResult: normalized,
    };
  }
  return { status: "missing", reason: "work has no advisory:verify or native result", command: null };
}

export function collectReviewEvidence({
  workspace,
  workId,
  repositoryRoot = REPOSITORY_ROOT,
  base,
  head = null,
  allowedFiles,
  testCommand,
  testFiles,
  engineCli = DEFAULT_ENGINE,
  commandTimeoutMs = REVIEW_COMMAND_TIMEOUT_MS,
  dispatchEvidence,
} = {}) {
  const root = resolve(repositoryRoot);
  let rootIsDirectory = false;
  try { rootIsDirectory = isAbsolute(root) && statSync(root).isDirectory(); } catch { /* input is reported below */ }
  if (!rootIsDirectory) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_INPUT_INVALID", problems: ["repositoryRoot must be a directory"], evidence: null };
  }
  if (typeof base !== "string" || base.length === 0 || base.includes("\u0000")) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_INPUT_INVALID", problems: ["base is required"], evidence: null };
  }
  if (!/^[a-f0-9]{40}$/u.test(base)) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_INPUT_INVALID", problems: ["base must be a full immutable commit SHA; moving refs and HEAD are not review bases"], evidence: null };
  }
  if (head !== null && head !== undefined && (!/^[a-f0-9]{40}$/u.test(head) || head === base)) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_INPUT_INVALID", problems: [head === base ? "base and head must be different fixed commit SHAs" : "head must be a full commit SHA when supplied"], evidence: null };
  }
  const allowed = normalizeAllowedFiles(root, allowedFiles);
  const declaredTests = normalizeTestFiles(root, testFiles);
  const problems = [...allowed.problems, ...declaredTests.problems];
  let diff;
  try {
    diff = diffEvidence(root, base, head);
  } catch (error) {
    return { schemaVersion: REVIEW_EVIDENCE_VERSION, ok: false, reasonCode: "REVIEW_EVIDENCE_GIT_UNAVAILABLE", problems: [String(error?.message ?? error)], evidence: null };
  }
  const outOfBounds = diff.changedFiles.filter((path) => !allowed.files.includes(path));
  const binding = readBoundVerify({ workspace, workId, engineCli });
  const dispatch = normalizeDispatchAdmissionEvidence(dispatchEvidence, { workId, workRevision: binding.workRevision ?? null });
  if (dispatch.requested) {
    if (!Number.isSafeInteger(binding.workRevision)) problems.push("dispatch association requires an available bound work revision");
    problems.push(...dispatch.problems);
    if (dispatch.valid && !dispatch.complete) problems.push(`dispatch host evidence unavailable: ${dispatch.unavailable.join(", ")}`);
    if (dispatch.complete && dispatch.evidence.hostResult.exitCode.value !== 0) problems.push(`dispatch host exited ${dispatch.evidence.hostResult.exitCode.value}`);
  }
  const verifyRun = binding.status === "available"
    ? runShell(binding.command, root, commandTimeoutMs)
    : null;
  const verify = {
    ...binding,
    run: verifyRun,
    ok: binding.status === "available" && verifyRun?.exitCode === "0" || binding.status === "native-only" && binding.nativeResult?.valid === true,
  };
  // When no separate runner is declared, the bound verify command is the runner
  // too; reuse its real output instead of running a potentially expensive check
  // twice and presenting two observations as if they were independent.
  const actualTestCommand = testCommand ?? binding.command;
  const testRun = binding.status === "native-only" && testCommand === undefined
    ? null
    : testCommand === undefined ? verifyRun : runShell(testCommand, root, commandTimeoutMs);
  const testSummary = testRun === null
    ? { tests: null, testFiles: null, testCases: null, passed: null, failed: null, parseable: false }
    : parseTestRunOutput(testRun.stdout, testRun.stderr, declaredTests.files);
  if (testSummary.source === "engine-test-result.file-list" && testSummary.testFiles.join("\n") !== declaredTests.files.join("\n")) {
    problems.push("test runner's actual file list differs from the pre-declared test paths");
  }
  const ast = astTestEvidence(root, base, head, declaredTests.files);
  if (binding.status === "missing") problems.push("bound work has no advisory:verify command or native result");
  if (binding.status === "unavailable") problems.push(`bound work verify is unavailable: ${binding.reason}`);
  if (!verify.ok) problems.push("verify command did not exit 0");
  if (binding.status !== "native-only" && (testRun === null || !testSummary.parseable)) problems.push("test runner output has no machine-readable test result");
  if (testRun !== null && testRun.exitCode !== "0") problems.push(`test runner exited ${testRun.exitCode}`);
  if (ast.after.testCount < ast.before.testCount) problems.push(`AST test count decreased from ${ast.before.testCount} to ${ast.after.testCount}`);
  if (testSummary.failed !== null && testSummary.failed > 0) problems.push(`test runner reported ${testSummary.failed} failed tests`);
  problems.push(...outOfBounds.map((path) => `diff file is outside pre-declared scope: ${path}`));
  return {
    schemaVersion: REVIEW_EVIDENCE_VERSION,
    ok: problems.length === 0,
    reasonCode: problems.length === 0 ? "REVIEW_EVIDENCE_READY" : "REVIEW_EVIDENCE_INCOMPLETE",
    problems,
    evidence: {
      work: { workspace, workId },
      basis: { repositoryRoot: root, base, head: head ?? "WORKING_TREE" },
      allowedFiles: allowed.files,
      testFiles: declaredTests.files,
      verify,
      dispatch,
      testRun: { command: actualTestCommand, result: testRun, summary: testSummary },
      astCountCoverage: ast,
      diff: { ...diff, outOfBounds },
    },
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) values[key] = true;
    else { values[key] = value; index += 1; }
  }
  return values;
}

function readRequest(values) {
  if (typeof values.request !== "string") return values;
  try { return { ...JSON.parse(readFileSync(resolve(values.request), "utf8")), ...values }; }
  catch { return { ...values, requestUnreadable: true }; }
}

if (process.argv[1]?.endsWith("review-evidence.mjs")) {
  const values = readRequest(parseArguments(process.argv.slice(2)));
  let request = values;
  if (values.requestUnreadable) request = { ...values, allowedFiles: [] };
  const allowedPath = request.allowed ?? request["allowed-files"];
  if (typeof allowedPath === "string") {
    try { request.allowedFiles = JSON.parse(readFileSync(resolve(allowedPath), "utf8")); }
    catch { request.allowedFiles = []; }
  }
  const result = collectReviewEvidence({
    workspace: request.workspace,
    workId: request["work-id"] ?? request.workId,
    repositoryRoot: request["repository-root"] ?? request.repositoryRoot,
    base: request.base,
    head: request.head === true ? null : request.head,
    allowedFiles: request.allowedFiles,
    testCommand: request["test-command"] ?? request.testCommand,
    testFiles: request["test-files"] ?? request.testFiles,
    engineCli: request["engine-cli"] ?? request.engineCli,
    dispatchEvidence: request.dispatchEvidence,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
