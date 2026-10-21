// SPDX-License-Identifier: Apache-2.0
// Private, bounded evidence for the existing test controller, never a test verdict.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { summarizeProgress } from "./incremental-output.mjs";

export const DIAGNOSTIC_LIMITS = Object.freeze({ planBytes: 65_536, ledgerBytes: 1_048_576, lineBytes: 2_048, jsonBytes: 524_288, controllerEvents: 64 });
const VERSION = "einzbern.test-run-diagnostics.v1";
const NODE_VERSION = "v24.16.0";
const COUNTS = ["tests", "suites", "passed", "failed", "cancelled", "skipped", "todo", "topLevel"];
const INTERRUPTED = ["cancelledByParent", "testAborted", "testTimeoutFailure"];
const FAILURES = [...INTERRUPTED, "subtestsFailed", "testCodeFailure", "hookFailed", "uncaughtException", "unhandledRejection", "unknown"];
const IO_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EEXIST", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EIO", "ELOOP", "EINVAL", "EBADF", "EROFS", "EFBIG"]);
const ERRORS = new Set(["PRIVATE_FILE_INVALID", "PRIVATE_FILE_CHANGED", "PRIVATE_READ_FAILED", "PLAN_INVALID", "PLAN_BUDGET", "NODE_UNSUPPORTED", "ROOT_IDENTITY_INVALID", "LEDGER_INVALID", "LEDGER_BUDGET", "OBSERVER_IO", "OBSERVER_DATA", "GROUP_JOIN_UNCONFIRMED", "HEADER_MISSING", "MANDATORY_ROSTER_EXCEEDS_BUDGET", "JSON_BUDGET"]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const elapsed = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;

class DiagnosticError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function requireDiagnostic(condition, reason) { if (!condition) throw new DiagnosticError(reason); }
export function expectedDiagnosticError(error) {
  if (error instanceof DiagnosticError) return error.reason;
  if (IO_CODES.has(error?.code)) return "OBSERVER_IO";
  return null;
}
function owned(metadata, directory = false) {
  return (directory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1) &&
    !metadata.isSymbolicLink() && (metadata.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (typeof process.getuid !== "function" || metadata.uid === process.getuid());
}
function openPrivate(path, flags, identity = null) {
  requireDiagnostic(typeof path === "string" && !path.includes("\0") && isAbsolute(path) && resolve(path) === path && owned(lstatSync(dirname(path)), true), "PRIVATE_FILE_INVALID");
  requireDiagnostic(typeof constants.O_NOFOLLOW === "number", "PRIVATE_FILE_INVALID");
  const before = lstatSync(path);
  requireDiagnostic(owned(before) && (!identity || same(before, identity)), "PRIVATE_FILE_INVALID");
  const fd = openSync(path, flags | constants.O_NOFOLLOW);
  try {
    requireDiagnostic(owned(fstatSync(fd)) && same(before, fstatSync(fd)) && same(before, lstatSync(path)), "PRIVATE_FILE_CHANGED");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export function readPrivateDiagnosticFile(path, limit, identity = null, offset = 0) {
  const fd = openPrivate(path, constants.O_RDONLY, identity);
  try {
    const before = fstatSync(fd);
    requireDiagnostic(integer(offset) && offset <= before.size, "PRIVATE_FILE_CHANGED");
    const buffer = Buffer.alloc(Math.min(before.size - offset, limit + 1));
    const length = readSync(fd, buffer, 0, buffer.length, offset);
    const after = fstatSync(fd);
    requireDiagnostic(owned(after) && same(before, after) && same(after, lstatSync(path)) && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && length === buffer.length, "PRIVATE_FILE_CHANGED");
    return { buffer: buffer.subarray(0, length), sourceBytes: before.size };
  } finally { closeSync(fd); }
}

export function createDiagnosticPlan(files, cwd, taskPid) {
  requireDiagnostic(Array.isArray(files) && typeof cwd === "string" && !cwd.includes("\0") && isAbsolute(cwd) && resolve(cwd) === cwd && integer(taskPid) && taskPid > 0, "PLAN_INVALID");
  requireDiagnostic(files.every((file) => typeof file === "string" && file.startsWith("tests/") && file.endsWith(".test.mjs") && !/[\\\x00-\x1f\x7f]/.test(file) && relative(cwd, resolve(cwd, file)) === file) && new Set(files).size === files.length, "PLAN_INVALID");
  return { schemaVersion: VERSION, nodeVersion: NODE_VERSION, taskPid, cwd, files: [...files], planDigest: digest(JSON.stringify(files)) };
}
export function diagnosticArguments(files, reporterPath) {
  return ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${reporterPath}`, "--test-reporter-destination=stdout", ...files];
}
export function prepareTestDiagnostics(directory, files, cwd, reporterPath) {
  const prepared = { plan: { files: [], fileCount: files.length, planDigest: digest(JSON.stringify(files)) }, arguments: ["--test", ...files], environment: {}, error: null, ledgerPath: null };
  try {
    const plan = createDiagnosticPlan(files, cwd, process.pid);
    prepared.plan = plan;
    requireDiagnostic(process.version === NODE_VERSION, "NODE_UNSUPPORTED");
    requireDiagnostic(owned(lstatSync(directory), true), "PRIVATE_FILE_INVALID");
    const ledgerPath = join(directory, "file-events.ndjson");
    const planPath = join(directory, "plan.json");
    writeFileSync(ledgerPath, "", { flag: "wx", mode: 0o600 });
    const metadata = lstatSync(ledgerPath);
    plan.ledgerIdentity = { dev: metadata.dev, ino: metadata.ino };
    const text = `${JSON.stringify(plan)}\n`;
    requireDiagnostic(Buffer.byteLength(text) <= DIAGNOSTIC_LIMITS.planBytes, "PLAN_BUDGET");
    writeFileSync(planPath, text, { flag: "wx", mode: 0o600 });
    // Read back the actual private bytes before enabling the reporter. No half configuration.
    requireDiagnostic(readPrivateDiagnosticFile(planPath, DIAGNOSTIC_LIMITS.planBytes).buffer.toString("utf8") === text, "PLAN_INVALID");
    prepared.ledgerPath = ledgerPath;
    prepared.arguments = diagnosticArguments(files, reporterPath);
    prepared.environment = { TCRN_TEST_CONTROLLER_DIAGNOSTIC_PLAN: planPath, TCRN_TEST_CONTROLLER_DIAGNOSTIC_LEDGER: ledgerPath };
  } catch (error) {
    const reason = expectedDiagnosticError(error);
    if (!reason) throw error;
    prepared.error = reason;
  }
  return prepared;
}
export function isDiagnosticRoot(plan, { nodeVersion, pid, ppid, outerPid, groupPid }) {
  return nodeVersion === NODE_VERSION && integer(pid) && pid > 0 && integer(ppid) && ppid > 0 &&
    String(plan.taskPid) === outerPid && String(ppid) === groupPid && pid !== ppid;
}
function summary(data) {
  requireDiagnostic(typeof data?.success === "boolean" && elapsed(data.duration_ms) && COUNTS.every((key) => integer(data.counts?.[key])), "OBSERVER_DATA");
  return { success: data.success, counts: Object.fromEntries(COUNTS.map((key) => [key, data.counts[key]])), duration_ms: data.duration_ms };
}

export function projectTestFileEvent(plan, event, observedElapsedMs) {
  requireDiagnostic(elapsed(observedElapsedMs), "OBSERVER_DATA");
  const data = event?.data;
  if (!data || !["test:enqueue", "test:dequeue", "test:complete", "test:summary"].includes(event.type)) return null;
  const namedIndex = event.type === "test:summary" ? -1 : plan.files.indexOf(data.name);
  if (event.type !== "test:summary" && namedIndex < 0) return null; // Ignore arbitrary subtest names before resolving paths.
  const observedFile = typeof data.file === "string" ? resolve(plan.cwd, data.file) : null;
  const fileIndex = event.type === "test:summary"
    ? plan.files.findIndex((file) => resolve(plan.cwd, file) === observedFile)
    : resolve(plan.cwd, plan.files[namedIndex]) === observedFile ? namedIndex : -1;
  if (event.type === "test:summary") {
    if (data.file === undefined) return { kind: "global-summary", observedElapsedMs, ...summary(data) };
    return fileIndex < 0 ? null : { kind: "summary", fileIndex, observedElapsedMs, ...summary(data) };
  }
  if (fileIndex !== namedIndex || data.nesting !== 0 || data.line !== 1 || data.column !== 1 || !integer(data.testId)) {
    return { kind: "conflict", fileIndex: namedIndex, observedElapsedMs };
  }
  const record = { kind: event.type.slice(5), fileIndex, observedElapsedMs, testId: data.testId };
  if (record.kind === "complete") {
    if (typeof data.details?.passed !== "boolean" || !elapsed(data.details.duration_ms)) return { kind: "conflict", fileIndex, observedElapsedMs };
    record.passed = data.details.passed;
    record.duration_ms = data.details.duration_ms;
    record.failureType = record.passed ? null : FAILURES.includes(data.details.error?.failureType) ? data.details.error.failureType : "unknown";
  }
  return record;
}
function blankFile(file, fileIndex) {
  return { fileIndex, file, state: "selected-only", queuedObserved: null, executionEntryObserved: null, wrapperTerminal: null, runSummary: null, ambiguous: false };
}
function newReduction(plan) {
  return { fileStates: plan.files.map(blankFile), globalSummaryObserved: null, ended: false, observerError: null, ambiguous: false, instances: new Map() };
}
function applyRecord(state, record) {
  if (record.kind === "header") return;
  if (record.kind === "end") { state.ended = true; return; }
  if (record.kind === "observer-error") { state.observerError = record.reason; return; }
  if (record.kind === "global-summary") { state.globalSummaryObserved = summary(record); return; }
  const file = state.fileStates[record.fileIndex];
  const conflict = () => {
    file.ambiguous = true; file.state = "unknown"; file.wrapperTerminal = null; file.runSummary = null; state.ambiguous = true;
  };
  if (record.kind === "conflict") { conflict(); return; }
  if (file.ambiguous) return;
  if (record.kind === "summary") {
    if (file.runSummary !== null) conflict();
    else {
      file.runSummary = summary(record);
      if (file.state === "selected-only") file.state = "summary-observed";
    }
    return;
  }
  const instance = state.instances.get(record.fileIndex);
  if ((instance !== undefined && instance !== record.testId) ||
      (record.kind === "enqueue" && file.queuedObserved !== null) ||
      (record.kind === "dequeue" && (file.queuedObserved === null || file.executionEntryObserved !== null || file.wrapperTerminal !== null)) ||
      (record.kind === "complete" && (file.queuedObserved === null || file.wrapperTerminal !== null || (file.executionEntryObserved === null && record.passed)))) {
    conflict(); return;
  }
  state.instances.set(record.fileIndex, record.testId);
  if (record.kind === "enqueue") { file.queuedObserved = record.observedElapsedMs; file.state = "queued-observed"; }
  if (record.kind === "dequeue") { file.executionEntryObserved = record.observedElapsedMs; file.state = "execution-entry-observed"; }
  if (record.kind === "complete") {
    file.wrapperTerminal = { passed: record.passed, duration_ms: record.duration_ms, failureType: record.failureType, observedElapsedMs: record.observedElapsedMs };
    file.state = record.passed ? "wrapper-returned" : INTERRUPTED.includes(record.failureType) ? "interrupted" : "failed-or-interrupted-unknown";
  }
}
export function reduceFileRecords(plan, records) {
  const state = newReduction(plan);
  for (const record of records) applyRecord(state, record);
  const { instances: _instances, ...result } = state;
  return result;
}
function header(plan) { return { kind: "header", schemaVersion: VERSION, nodeVersion: NODE_VERSION, planDigest: plan.planDigest, fileCount: plan.files.length }; }
function validateRecord(plan, record) {
  requireDiagnostic(record && typeof record === "object" && !Array.isArray(record), "LEDGER_INVALID");
  let normalized;
  if (record.kind === "header") normalized = header(plan);
  else if (record.kind === "observer-error") {
    requireDiagnostic(ERRORS.has(record.reason), "LEDGER_INVALID");
    normalized = { kind: record.kind, reason: record.reason };
  } else {
    requireDiagnostic(elapsed(record.observedElapsedMs), "LEDGER_INVALID");
    if (record.kind === "end") normalized = { kind: record.kind, observedElapsedMs: record.observedElapsedMs };
    else if (record.kind === "global-summary") normalized = { kind: record.kind, observedElapsedMs: record.observedElapsedMs, ...summary(record) };
    else {
      requireDiagnostic(integer(record.fileIndex) && record.fileIndex < plan.files.length, "LEDGER_INVALID");
      normalized = { kind: record.kind, fileIndex: record.fileIndex, observedElapsedMs: record.observedElapsedMs };
      if (record.kind === "summary") Object.assign(normalized, summary(record));
      else if (record.kind !== "conflict") {
        requireDiagnostic(["enqueue", "dequeue", "complete"].includes(record.kind) && integer(record.testId), "LEDGER_INVALID");
        normalized.testId = record.testId;
        if (record.kind === "complete") {
          requireDiagnostic(typeof record.passed === "boolean" && elapsed(record.duration_ms) && (record.passed ? record.failureType === null : FAILURES.includes(record.failureType)), "LEDGER_INVALID");
          Object.assign(normalized, { passed: record.passed, duration_ms: record.duration_ms, failureType: record.failureType });
        }
      }
    }
  }
  requireDiagnostic(JSON.stringify(normalized) === JSON.stringify(record), "LEDGER_INVALID");
  return normalized;
}

// Used only by the CLI reporter. Expected IO failures disable observation, not tests.
export function openFileObserver(environment, identity) {
  const planPath = environment.TCRN_TEST_CONTROLLER_DIAGNOSTIC_PLAN;
  const ledgerPath = environment.TCRN_TEST_CONTROLLER_DIAGNOSTIC_LEDGER;
  requireDiagnostic(typeof planPath === "string" && typeof ledgerPath === "string" && dirname(planPath) === dirname(ledgerPath) && planPath === join(dirname(planPath), "plan.json") && ledgerPath === join(dirname(planPath), "file-events.ndjson"), "PLAN_INVALID");
  requireDiagnostic(integer(identity.pid) && integer(identity.ppid) && identity.pid !== identity.ppid && String(identity.ppid) === identity.groupPid, "ROOT_IDENTITY_INVALID");
  const raw = readPrivateDiagnosticFile(planPath, DIAGNOSTIC_LIMITS.planBytes);
  requireDiagnostic(raw.sourceBytes <= DIAGNOSTIC_LIMITS.planBytes, "PLAN_BUDGET");
  requireDiagnostic(Buffer.from(raw.buffer.toString("utf8")).equals(raw.buffer), "PLAN_INVALID");
  let plan;
  try { plan = JSON.parse(raw.buffer.toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new DiagnosticError("PLAN_INVALID"); throw error; }
  requireDiagnostic(plan && typeof plan === "object" && !Array.isArray(plan), "PLAN_INVALID");
  const expected = createDiagnosticPlan(plan.files, plan.cwd, plan.taskPid);
  requireDiagnostic(plan.schemaVersion === expected.schemaVersion && plan.nodeVersion === expected.nodeVersion && plan.planDigest === expected.planDigest && integer(plan.ledgerIdentity?.dev) && integer(plan.ledgerIdentity?.ino), "PLAN_INVALID");
  requireDiagnostic(isDiagnosticRoot(plan, identity), "ROOT_IDENTITY_INVALID");
  const fd = openPrivate(ledgerPath, constants.O_WRONLY | constants.O_APPEND, plan.ledgerIdentity);
  let active = true;
  let closed = false;
  let totalBytes = 0;
  let totalRows = 0;
  const seen = new Set();
  const reduction = newReduction(plan);
  function close() {
    if (closed) return;
    closed = true;
    try { closeSync(fd); }
    catch (error) {
      if (!expectedDiagnosticError(error)) throw error;
      // One best-effort error slot, never a second close or an alternate file.
      if (active) {
        active = false;
        try { write({ kind: "observer-error", reason: "OBSERVER_IO" }, false); }
        catch (failure) { if (!expectedDiagnosticError(failure)) throw failure; }
      }
    }
  }
  function write(record, reserved = true) {
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    requireDiagnostic(line.length <= DIAGNOSTIC_LIMITS.lineBytes && totalBytes + line.length <= DIAGNOSTIC_LIMITS.ledgerBytes - (reserved ? DIAGNOSTIC_LIMITS.lineBytes : 0) && totalRows < 5 * plan.files.length + 4, "LEDGER_BUDGET");
    requireDiagnostic(writeSync(fd, line) === line.length, "OBSERVER_IO");
    totalBytes += line.length; totalRows++;
  }
  function stop(error) {
    const reason = expectedDiagnosticError(error);
    if (!reason) throw error;
    active = false;
    try { write({ kind: "observer-error", reason }, false); }
    catch (writeError) { if (!expectedDiagnosticError(writeError)) throw writeError; }
    close();
  }
  try { requireDiagnostic(fstatSync(fd).size === 0, "PRIVATE_FILE_INVALID"); }
  catch (error) { active = false; close(); throw error; }
  try { write(header(plan)); }
  catch (error) { stop(error); }
  return {
    observe(event, at) {
      if (!active) return;
      try {
        let record = projectTestFileEvent(plan, event, at);
        if (!record) return;
        const key = `${record.fileIndex ?? "global"}:${record.kind}`;
        if (seen.has(key)) {
          if (record.fileIndex === undefined) throw new DiagnosticError("OBSERVER_DATA");
          record = { kind: "conflict", fileIndex: record.fileIndex, observedElapsedMs: at };
        }
        if (record.fileIndex !== undefined) {
          const file = reduction.fileStates[record.fileIndex];
          if (file.ambiguous) return;
          applyRecord(reduction, record);
          if (file.ambiguous) record = { kind: "conflict", fileIndex: record.fileIndex, observedElapsedMs: at };
        }
        seen.add(`${record.fileIndex ?? "global"}:${record.kind}`);
        write(record);
      } catch (error) { stop(error); }
    },
    finish(at, complete) {
      try { if (active && complete) write({ kind: "end", observedElapsedMs: at }); }
      catch (error) { stop(error); }
      finally { close(); }
    },
  };
}

export function decodeFileLedger(plan, buffer, sourceBytes = buffer.length) {
  const records = [];
  const seen = new Set();
  let cursor = 0;
  let error = null;
  let lastElapsed = 0;
  let ended = false;
  let completeRowsObserved = 0;
  for (const byte of buffer) if (byte === 10) completeRowsObserved++;
  while (cursor < buffer.length) {
    const end = buffer.indexOf(10, cursor);
    if (end < 0) break;
    try {
      requireDiagnostic(end + 1 <= DIAGNOSTIC_LIMITS.ledgerBytes && end + 1 - cursor <= DIAGNOSTIC_LIMITS.lineBytes && records.length < 5 * plan.files.length + 4, "LEDGER_BUDGET");
      const line = buffer.subarray(cursor, end);
      requireDiagnostic(Buffer.from(line.toString("utf8")).equals(line), "LEDGER_INVALID");
      let parsed;
      try { parsed = JSON.parse(line.toString("utf8")); }
      catch (parseError) { if (parseError instanceof SyntaxError) throw new DiagnosticError("LEDGER_INVALID"); throw parseError; }
      const record = validateRecord(plan, parsed);
      requireDiagnostic(line.toString("utf8") === JSON.stringify(record), "LEDGER_INVALID");
      requireDiagnostic((records.length === 0) === (record.kind === "header") && !ended, "LEDGER_INVALID");
      const key = `${record.fileIndex ?? "global"}:${record.kind}`;
      requireDiagnostic(!seen.has(key), "LEDGER_INVALID");
      if (record.observedElapsedMs !== undefined) {
        requireDiagnostic(record.observedElapsedMs >= lastElapsed, "LEDGER_INVALID");
        lastElapsed = record.observedElapsedMs;
      }
      seen.add(key);
      ended = record.kind === "end" || record.kind === "observer-error";
      records.push(record);
      cursor = end + 1;
    } catch (failure) {
      error = expectedDiagnosticError(failure);
      if (!error) throw failure;
      break; // A corrupt prefix never authorizes a later pass record.
    }
  }
  const partialTailBytes = error ? 0 : buffer.length - cursor;
  return {
    records, cursor, sourceBytes, bytesRead: buffer.length, completeRowsObserved,
    partialTailBytes, omittedBytes: sourceBytes - cursor,
    omittedRecordCount: error || sourceBytes > buffer.length ? null : 0,
    sourcePrefixSha256: digest(buffer), error,
    truncated: sourceBytes > DIAGNOSTIC_LIMITS.ledgerBytes || sourceBytes > buffer.length,
  };
}
const CONTROLLER_TYPES = new Set(["bound-before-controller", "controller-started", "controller-exited", "completed", "orphaned-before-bind", "reaper-clean", "error"]);
const REASONS = new Set(["TEST_CONTROLLER_FAILED", "TEST_CONTROLLER_INPUT_INVALID", "TEST_CONTROLLER_GROUP_JOIN_FAILED", "TEST_CONTROLLER_REAPER_JOIN_FAILED", ...IO_CODES]);
function safeControllerEvent(event) {
  return {
    type: CONTROLLER_TYPES.has(event?.type) ? event.type : "unknown",
    observedAt: typeof event?.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(event.observedAt) ? event.observedAt : null,
    code: Number.isSafeInteger(event?.code) ? event.code : null,
    signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGHUP"].includes(event?.signal) ? event.signal : null,
    ok: typeof event?.ok === "boolean" ? event.ok : null,
    reasonCode: REASONS.has(event?.reasonCode) ? event.reasonCode : null,
  };
}
export function snapshotTestController(events, cursor, counters) {
  const progress = summarizeProgress(events);
  const exit = progress.exit ? safeControllerEvent({ type: "controller-exited", ...progress.exit }) : null;
  const lastError = progress.errors.at(-1)?.reasonCode;
  return {
    status: progress.status, terminal: CONTROLLER_TYPES.has(progress.terminal) ? progress.terminal : null,
    exit: exit ? { code: exit.code, signal: exit.signal, ok: exit.ok } : null,
    errorCount: progress.errors.length, lastErrorReasonCode: REASONS.has(lastError) ? lastError : null,
    eventCount: events.length, cursor: integer(cursor) ? cursor : null,
    polls: integer(counters?.polls) ? counters.polls : null,
    unchangedPolls: integer(counters?.unchangedPolls) ? counters.unchangedPolls : null,
    bytesRead: integer(counters?.bytesRead) ? counters.bytesRead : null,
    events: events.slice(-DIAGNOSTIC_LIMITS.controllerEvents).map(safeControllerEvent),
    omittedEvents: Math.max(0, events.length - DIAGNOSTIC_LIMITS.controllerEvents),
    lastProgress: events.length ? safeControllerEvent(events.at(-1)) : null,
  };
}
function readAfterCleanup(progressPath, cursor) {
  try {
    const read = readPrivateDiagnosticFile(progressPath, DIAGNOSTIC_LIMITS.ledgerBytes, null, cursor);
    const events = [];
    let consumed = 0;
    let error = null;
    while (consumed < read.buffer.length && events.length < DIAGNOSTIC_LIMITS.controllerEvents) {
      const end = read.buffer.indexOf(10, consumed);
      if (end < 0) break;
      if (end - consumed > DIAGNOSTIC_LIMITS.lineBytes) { error = "LEDGER_BUDGET"; break; }
      try {
        const event = JSON.parse(read.buffer.subarray(consumed, end).toString("utf8"));
        if (event?.schemaVersion !== "tcrn.progress-event.v1") { error = "LEDGER_INVALID"; break; }
        events.push(safeControllerEvent(event));
      } catch (failure) { if (!(failure instanceof SyntaxError)) throw failure; error = "LEDGER_INVALID"; break; }
      consumed = end + 1;
    }
    return { events, cursor: cursor + consumed, bytesRead: read.buffer.length, remainingBytes: read.sourceBytes - cursor - consumed, error };
  } catch (error) {
    const reason = expectedDiagnosticError(error);
    if (!reason) throw error;
    return { events: [], cursor, bytesRead: null, remainingBytes: null, error: reason };
  }
}

export function buildTestDiagnostics(plan, decoded, context, budget = DIAGNOSTIC_LIMITS.jsonBytes) {
  const state = newReduction(plan);
  const retainedRecords = [];
  let retainedCursor = 0;
  const sourceRecords = decoded?.records ?? [];
  const fileCount = plan.fileCount ?? plan.files.length;
  const baseError = context.error ?? decoded?.error ?? null;
  function evidence() {
    const omitted = sourceRecords.length - retainedRecords.length;
    const missingHeader = retainedRecords[0]?.kind !== "header";
    const status = context.error || missingHeader ? "unavailable" :
      baseError || decoded.truncated || decoded.partialTailBytes > 0 || omitted > 0 || !state.ended || state.observerError || state.ambiguous ? "partial" : "observed";
    return {
      status, nodeVersion: retainedRecords[0]?.nodeVersion ?? context.nodeVersion ?? null, planDigest: plan.planDigest, fileCount,
      retainedFileCount: state.fileStates.length, omittedFileCount: fileCount - state.fileStates.length,
      observedRecordCount: sourceRecords.length, retainedRecordCount: retainedRecords.length,
      omittedRecordCount: decoded?.omittedRecordCount === null ? null : omitted,
      completeRowsObserved: decoded?.completeRowsObserved ?? null,
      cursor: decoded?.cursor ?? null, retainedCursor, sourceBytes: decoded?.sourceBytes ?? null, bytesRead: decoded?.bytesRead ?? null,
      partialTailBytes: decoded?.partialTailBytes ?? null, omittedBytes: decoded ? decoded.sourceBytes - retainedCursor : null,
      sourcePrefixSha256: decoded?.sourcePrefixSha256 ?? null,
      truncated: omitted > 0 || (decoded?.truncated ?? false),
      error: baseError ?? state.observerError ?? (missingHeader ? "HEADER_MISSING" : null),
      retainedRecords, fileStates: state.fileStates,
      globalSummaryObserved: state.globalSummaryObserved,
      finalTotalsAvailable: status === "observed" && state.globalSummaryObserved !== null,
      finalSummary: status === "observed" ? state.globalSummaryObserved : null,
    };
  }
  function result() { return { schemaVersion: VERSION, observationWindow: "through-cleanup", ...context.snapshot, fileEvidence: evidence() }; }
  // Reserve the full roster and worst-width counters before accepting any event.
  const minimum = result();
  const reserved = { ...minimum, fileEvidence: { ...minimum.fileEvidence } };
  for (const key of ["retainedFileCount", "omittedFileCount", "observedRecordCount", "retainedRecordCount", "omittedRecordCount", "completeRowsObserved", "cursor", "retainedCursor", "sourceBytes", "bytesRead", "partialTailBytes", "omittedBytes"]) reserved.fileEvidence[key] = Number.MAX_SAFE_INTEGER;
  if (bytes(reserved) > budget) {
    const unavailable = { ...minimum, fileEvidence: { ...minimum.fileEvidence, status: "unavailable", error: "MANDATORY_ROSTER_EXCEEDS_BUDGET", fileStates: [], retainedFileCount: 0, omittedFileCount: fileCount } };
    requireDiagnostic(bytes(unavailable) <= budget, "JSON_BUDGET");
    return unavailable;
  }
  let stateBytes = state.fileStates.reduce((sum, file) => sum + bytes(file), 0);
  let recordBytes = 0;
  for (const record of sourceRecords) {
    const index = record.fileIndex;
    const oldBytes = index === undefined ? 0 : bytes(state.fileStates[index]);
    applyRecord(state, record);
    stateBytes += index === undefined ? 0 : bytes(state.fileStates[index]) - oldBytes;
    retainedRecords.push(record);
    recordBytes += bytes(record);
    retainedCursor = recordBytes + retainedRecords.length;
    const candidate = result();
    // Count only changed rows plus small metadata, not a whole-roster encoding per event.
    const size = bytes({ ...candidate, fileEvidence: { ...candidate.fileEvidence, fileStates: [], retainedRecords: [] } }) +
      stateBytes + Math.max(0, state.fileStates.length - 1) + recordBytes + Math.max(0, retainedRecords.length - 1);
    if (size > budget) { retainedRecords.pop(); break; }
  }
  // Never copy the uncropped cache: all claims come only from the retained prefix.
  retainedCursor = retainedRecords.reduce((sum, record) => sum + bytes(record) + 1, 0);
  const reduced = reduceFileRecords(plan, retainedRecords);
  Object.assign(state, reduced);
  let final = result();
  while (bytes(final) > budget && retainedRecords.length > 0) {
    const removed = retainedRecords.pop();
    retainedCursor -= bytes(removed) + 1;
    Object.assign(state, reduceFileRecords(plan, retainedRecords));
    final = result();
  }
  requireDiagnostic(bytes(final) <= budget, "JSON_BUDGET");
  return final;
}
export function collectTestDiagnostics(prepared, snapshot, progressPath, groupJoinsConfirmed) {
  let decoded = null;
  let error = groupJoinsConfirmed ? prepared.error : "GROUP_JOIN_UNCONFIRMED";
  if (!error && prepared.ledgerPath) {
    try {
      const read = readPrivateDiagnosticFile(prepared.ledgerPath, DIAGNOSTIC_LIMITS.ledgerBytes, prepared.plan.ledgerIdentity);
      decoded = decodeFileLedger(prepared.plan, read.buffer, read.sourceBytes);
    } catch (failure) {
      error = expectedDiagnosticError(failure);
      if (!error) throw failure;
    }
  }
  return buildTestDiagnostics(prepared.plan, decoded, {
    error,
    nodeVersion: /^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(process.version) ? process.version : null,
    snapshot: {
      ...snapshot,
      afterCleanup: {
        groupJoinsConfirmed,
        controller: groupJoinsConfirmed ? readAfterCleanup(progressPath, snapshot.controllerAtTrigger.cursor) : null,
      },
    },
  });
}
