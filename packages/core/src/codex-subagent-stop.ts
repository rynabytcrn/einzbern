// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const CODEX_SUBAGENT_STOP_MANIFEST_SCHEMA = "einzbern.codex-subagent-stop.manifest.v1" as const;
export const CODEX_SUBAGENT_STOP_SNAPSHOT_SCHEMA = "einzbern.codex-subagent-stop.snapshot.v1" as const;
export const CODEX_SUBAGENT_STOP_BINDING_SCHEMA = "einzbern.codex-subagent-stop.binding.v1" as const;
export const CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX = "EINZBERN_SUBAGENT_STOP_V1 " as const;

const MAX_JSON_BYTES = 64 * 1024;
const FINALITY_KINDS = new Set(["completed", "failed", "cancelled_confirmed", "pending", "unknown"]);
const EXCEPTION_REASONS = new Set(["deadline", "query-failure-limit", "user-cancelled", "script-error", "protocol-error"]);
const REPORT_STATES = new Set(["not-started", "in-flight", "acknowledged", "unknown", "failed"]);

export interface CodexSubagentStopManifestInput {
  readonly deviceHome: string;
  readonly batchId: string;
  readonly nonce: string;
  /** The exact native task_name returned when the parent dispatched the collector. */
  readonly collectorTaskName: string;
  /** A fixed, nonempty list of actual native task_name values to query once per interval. */
  readonly targetTaskNames: readonly string[];
  readonly queryIntervalMs: number;
  /** An absolute UTC instant ending in Z. */
  readonly deadline: string;
  readonly maxConsecutiveQueryFailures: number;
}

export interface CodexSubagentStopManifest extends Omit<CodexSubagentStopManifestInput, "deviceHome"> {
  readonly schemaVersion: typeof CODEX_SUBAGENT_STOP_MANIFEST_SCHEMA;
  readonly manifestPath: string;
  readonly bindingPath: string;
  readonly snapshotPath: string;
}

export interface CodexSubagentStopDecision {
  readonly matched: boolean;
  readonly decision: "allow" | "block";
  readonly reason?: string;
  readonly reasonCode?: string;
  readonly batchId?: string;
}

interface Binding {
  readonly schemaVersion: typeof CODEX_SUBAGENT_STOP_BINDING_SCHEMA;
  readonly batchId: string;
  readonly nonce: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly boundAt: string;
  readonly reportContinuationUsed: boolean;
  readonly reportReconciliationUsed: boolean;
  readonly exceptionContinuationUsed: boolean;
  readonly lastPendingDecisionKey: string | null;
}

interface SnapshotTarget {
  readonly taskName: string;
  /** The host's exact raw state name; the handler never maps or infers it. */
  readonly hostState: string;
  /** Explicit evidence classification supplied by the native collector. */
  readonly finalityKind: "completed" | "failed" | "cancelled_confirmed" | "pending" | "unknown";
  readonly evidenceRef: string | null;
}

interface ReportAttempt {
  readonly state: "not-started" | "in-flight" | "acknowledged" | "unknown" | "failed";
  readonly attemptedAt: string | null;
  readonly toolName: string | null;
  readonly evidenceRef: string | null;
  readonly detail: string | null;
}

interface Snapshot {
  readonly schemaVersion: typeof CODEX_SUBAGENT_STOP_SNAPSHOT_SCHEMA;
  readonly batchId: string;
  readonly nonce: string;
  readonly observedAt: string;
  readonly targets: readonly SnapshotTarget[];
  readonly nextQueryAt: string | null;
  readonly consecutiveQueryFailures: number;
  readonly latestQueryError: string | null;
  readonly exceptionReason: string | null;
  readonly reportAttempt: ReportAttempt;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function actualTaskName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.slice(1).split("/");
  return value.startsWith("/root/") && parts[0] === "root" && parts.length > 1 && parts.slice(1).every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/u.test(part));
}

function utcInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function fail(message: string): never {
  throw new Error(message);
}

function batchPaths(deviceHome: string, batchId: string): { directory: string; manifestPath: string; bindingPath: string; snapshotPath: string } {
  if (typeof deviceHome !== "string" || deviceHome.length === 0 || !isAbsolutePath(deviceHome)) fail("deviceHome must be absolute");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(batchId) || batchId === "." || batchId === "..") fail("batchId is invalid");
  const directory = join(resolve(deviceHome), "subagent-stop", "batches", batchId);
  return {
    directory,
    manifestPath: join(directory, "manifest.json"),
    bindingPath: join(directory, "binding.json"),
    snapshotPath: join(directory, "snapshot.json"),
  };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith(sep) || /^[A-Za-z]:[\\/]/u.test(value);
}

/** Build the exact closed manifest shape and device-local file paths expected by the hook. */
export function createCodexSubagentStopManifest(input: CodexSubagentStopManifestInput): CodexSubagentStopManifest {
  const paths = batchPaths(input.deviceHome, input.batchId);
  if (typeof input.nonce !== "string" || input.nonce.length < 8 || /\s/u.test(input.nonce)) fail("nonce must be a nonempty opaque token without whitespace");
  if (!actualTaskName(input.collectorTaskName)) fail("collectorTaskName must be an actual native /root/... task_name");
  if (!Array.isArray(input.targetTaskNames) || input.targetTaskNames.length === 0 || input.targetTaskNames.some((name) => !actualTaskName(name)) || input.targetTaskNames.includes(input.collectorTaskName)) fail("targetTaskNames must be a nonempty fixed list of actual native task_name values, excluding the collector");
  if (new Set(input.targetTaskNames).size !== input.targetTaskNames.length) fail("targetTaskNames must be unique");
  if (!Number.isSafeInteger(input.queryIntervalMs) || input.queryIntervalMs < 10_000 || input.queryIntervalMs > 86_400_000) fail("queryIntervalMs must be an integer from 10000 through 86400000");
  if (!utcInstant(input.deadline)) fail("deadline must be an absolute UTC instant ending in Z");
  if (!Number.isSafeInteger(input.maxConsecutiveQueryFailures) || input.maxConsecutiveQueryFailures < 1 || input.maxConsecutiveQueryFailures > 100) fail("maxConsecutiveQueryFailures must be an integer from 1 through 100");
  return {
    schemaVersion: CODEX_SUBAGENT_STOP_MANIFEST_SCHEMA,
    batchId: input.batchId,
    nonce: input.nonce,
    collectorTaskName: input.collectorTaskName,
    targetTaskNames: [...input.targetTaskNames],
    queryIntervalMs: input.queryIntervalMs,
    deadline: input.deadline,
    maxConsecutiveQueryFailures: input.maxConsecutiveQueryFailures,
    manifestPath: paths.manifestPath,
    bindingPath: paths.bindingPath,
    snapshotPath: paths.snapshotPath,
  };
}

function parseEnvelope(value: unknown): { batchId: string; nonce: string; manifestPath: string } | null {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith(CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX)) return null;
  const text = value.slice(CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX.length);
  if (text.length === 0 || /[\r\n]/u.test(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed) || !exactKeys(parsed, ["batchId", "nonce", "manifestPath"])) return null;
    if (typeof parsed.batchId !== "string" || typeof parsed.nonce !== "string" || typeof parsed.manifestPath !== "string") return null;
    return { batchId: parsed.batchId, nonce: parsed.nonce, manifestPath: parsed.manifestPath };
  } catch {
    return null;
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${path} is not a regular non-symlink file`);
  if (info.size > MAX_JSON_BYTES) fail(`${path} exceeds ${MAX_JSON_BYTES} bytes`);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  await assertRegularFile(path);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!object(parsed)) fail(`${path} must contain a JSON object`);
  return parsed;
}

async function assertBatchDirectory(directory: string): Promise<void> {
  const root = dirname(dirname(dirname(directory)));
  for (const path of [root, dirname(dirname(directory)), dirname(directory), directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${path} is not a regular non-symlink directory`);
  }
}

function validatedManifest(value: Record<string, unknown>, expected: ReturnType<typeof batchPaths>, envelope: { batchId: string; nonce: string; manifestPath: string }): CodexSubagentStopManifest {
  const keys = ["schemaVersion", "batchId", "nonce", "collectorTaskName", "targetTaskNames", "queryIntervalMs", "deadline", "maxConsecutiveQueryFailures", "manifestPath", "bindingPath", "snapshotPath"];
  if (!exactKeys(value, keys)) fail("manifest has unexpected or missing fields");
  if (value.schemaVersion !== CODEX_SUBAGENT_STOP_MANIFEST_SCHEMA || value.batchId !== envelope.batchId || value.nonce !== envelope.nonce) fail("manifest marker does not match its schema, batchId and nonce");
  if (value.manifestPath !== expected.manifestPath || value.bindingPath !== expected.bindingPath || value.snapshotPath !== expected.snapshotPath || resolve(envelope.manifestPath) !== expected.manifestPath) fail("manifest or envelope path is outside the exact authorized batch paths");
  if (!actualTaskName(value.collectorTaskName)) fail("manifest collectorTaskName is invalid");
  if (!Array.isArray(value.targetTaskNames) || value.targetTaskNames.length === 0 || value.targetTaskNames.some((name) => !actualTaskName(name)) || value.targetTaskNames.includes(value.collectorTaskName) || new Set(value.targetTaskNames).size !== value.targetTaskNames.length) fail("manifest targetTaskNames is invalid");
  if (!Number.isSafeInteger(value.queryIntervalMs) || (value.queryIntervalMs as number) < 10_000 || (value.queryIntervalMs as number) > 86_400_000) fail("manifest queryIntervalMs is invalid");
  if (!utcInstant(value.deadline)) fail("manifest deadline is not an absolute UTC instant");
  if (!Number.isSafeInteger(value.maxConsecutiveQueryFailures) || (value.maxConsecutiveQueryFailures as number) < 1 || (value.maxConsecutiveQueryFailures as number) > 100) fail("manifest maxConsecutiveQueryFailures is invalid");
  return value as unknown as CodexSubagentStopManifest;
}

function validatedBinding(value: Record<string, unknown>, manifest: CodexSubagentStopManifest): Binding {
  const keys = ["schemaVersion", "batchId", "nonce", "sessionId", "agentId", "boundAt", "reportContinuationUsed", "reportReconciliationUsed", "exceptionContinuationUsed", "lastPendingDecisionKey"];
  if (!exactKeys(value, keys) || value.schemaVersion !== CODEX_SUBAGENT_STOP_BINDING_SCHEMA || value.batchId !== manifest.batchId || value.nonce !== manifest.nonce) fail("binding record has an invalid schema or batch identity");
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || typeof value.agentId !== "string" || value.agentId.length === 0 || !utcInstant(value.boundAt)) fail("binding record has invalid native ids or boundAt");
  if (typeof value.reportContinuationUsed !== "boolean" || typeof value.reportReconciliationUsed !== "boolean" || typeof value.exceptionContinuationUsed !== "boolean") fail("binding record has invalid continuation flags");
  if (value.lastPendingDecisionKey !== null && typeof value.lastPendingDecisionKey !== "string") fail("binding record has invalid pending key");
  return value as unknown as Binding;
}

function validatedSnapshot(value: Record<string, unknown>, manifest: CodexSubagentStopManifest): Snapshot {
  const keys = ["schemaVersion", "batchId", "nonce", "observedAt", "targets", "nextQueryAt", "consecutiveQueryFailures", "latestQueryError", "exceptionReason", "reportAttempt"];
  if (!exactKeys(value, keys) || value.schemaVersion !== CODEX_SUBAGENT_STOP_SNAPSHOT_SCHEMA || value.batchId !== manifest.batchId || value.nonce !== manifest.nonce) fail("snapshot has an invalid schema or batch identity");
  if (!utcInstant(value.observedAt)) fail("snapshot observedAt is invalid");
  if (!Array.isArray(value.targets) || value.targets.length !== manifest.targetTaskNames.length) fail("snapshot targets do not cover the fixed manifest list");
  const targetNames = new Set<string>();
  for (const row of value.targets) {
    if (!object(row) || !exactKeys(row, ["taskName", "hostState", "finalityKind", "evidenceRef"])) fail("snapshot target row has an invalid shape");
    if (typeof row.taskName !== "string" || typeof row.hostState !== "string" || row.hostState.length === 0 || typeof row.finalityKind !== "string" || !FINALITY_KINDS.has(row.finalityKind)) fail("snapshot target row has invalid state fields");
    if (row.evidenceRef !== null && (typeof row.evidenceRef !== "string" || row.evidenceRef.length === 0)) fail("snapshot target evidenceRef is invalid");
    if ((row.finalityKind === "completed" || row.finalityKind === "failed" || row.finalityKind === "cancelled_confirmed") && typeof row.evidenceRef !== "string") fail("a terminal target requires its native finality evidence reference");
    targetNames.add(row.taskName);
  }
  const orderedTargetNames = value.targets.map((row) => object(row) ? row.taskName : null);
  if (targetNames.size !== manifest.targetTaskNames.length || manifest.targetTaskNames.some((name, index) => !targetNames.has(name) || orderedTargetNames[index] !== name)) fail("snapshot target order or names differ from the fixed manifest list");
  if (value.nextQueryAt !== null && !utcInstant(value.nextQueryAt)) fail("snapshot nextQueryAt is invalid");
  if (!Number.isSafeInteger(value.consecutiveQueryFailures) || (value.consecutiveQueryFailures as number) < 0) fail("snapshot consecutiveQueryFailures is invalid");
  if (value.latestQueryError !== null && (typeof value.latestQueryError !== "string" || value.latestQueryError.length > 2_048)) fail("snapshot latestQueryError is invalid");
  if (value.exceptionReason !== null && (typeof value.exceptionReason !== "string" || !EXCEPTION_REASONS.has(value.exceptionReason))) fail("snapshot exceptionReason is invalid");
  const hasPendingTargets = value.targets.some((row) => object(row) && (row.finalityKind === "pending" || row.finalityKind === "unknown"));
  const hasBoundedExit = value.exceptionReason !== null || (value.consecutiveQueryFailures as number) >= manifest.maxConsecutiveQueryFailures || Date.parse(value.observedAt) >= Date.parse(manifest.deadline);
  if (hasPendingTargets && !hasBoundedExit && (typeof value.nextQueryAt !== "string" || Date.parse(value.nextQueryAt) < Date.parse(value.observedAt) + manifest.queryIntervalMs)) fail("a nonterminal snapshot nextQueryAt must respect the fixed query interval");
  if (!object(value.reportAttempt) || !exactKeys(value.reportAttempt, ["state", "attemptedAt", "toolName", "evidenceRef", "detail"])) fail("snapshot reportAttempt has an invalid shape");
  const report = value.reportAttempt;
  if (typeof report.state !== "string" || !REPORT_STATES.has(report.state)) fail("snapshot reportAttempt state is invalid");
  for (const field of ["attemptedAt", "toolName", "evidenceRef", "detail"] as const) {
    if (report[field] !== null && typeof report[field] !== "string") fail(`snapshot reportAttempt ${field} is invalid`);
  }
  if (report.state === "acknowledged" && (!utcInstant(report.attemptedAt) || typeof report.toolName !== "string" || typeof report.evidenceRef !== "string")) fail("acknowledged reportAttempt requires the actual native tool result evidence");
  if (report.state === "in-flight" && (!utcInstant(report.attemptedAt) || typeof report.toolName !== "string")) fail("in-flight reportAttempt requires its exact native tool and attempt time");
  return value as unknown as Snapshot;
}

async function createBinding(path: string, manifest: CodexSubagentStopManifest, sessionId: string, agentId: string, now: string): Promise<{ binding: Binding; created: boolean }> {
  const initial: Binding = {
    schemaVersion: CODEX_SUBAGENT_STOP_BINDING_SCHEMA,
    batchId: manifest.batchId,
    nonce: manifest.nonce,
    sessionId,
    agentId,
    boundAt: now,
    reportContinuationUsed: false,
    reportReconciliationUsed: false,
    exceptionContinuationUsed: false,
    lastPendingDecisionKey: null,
  };
  try {
    await writeFile(path, `${JSON.stringify(initial, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { binding: initial, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { binding: validatedBinding(await readJson(path), manifest), created: false };
  }
}

async function updateBinding(path: string, binding: Binding, changes: Partial<Omit<Binding, "schemaVersion" | "batchId" | "nonce" | "sessionId" | "agentId" | "boundAt">>): Promise<Binding> {
  const next = { ...binding, ...changes };
  const temporary = join(dirname(path), `.binding-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return next;
}

function block(batchId: string, reasonCode: string, reason: string): CodexSubagentStopDecision {
  return { matched: true, decision: "block", batchId, reasonCode, reason };
}

function allow(batchId?: string, reasonCode?: string): CodexSubagentStopDecision {
  return { matched: batchId !== undefined, decision: "allow", ...(batchId === undefined ? {} : { batchId }), ...(reasonCode === undefined ? {} : { reasonCode }) };
}

function terminal(snapshot: Snapshot): boolean {
  return snapshot.targets.every((row) => row.finalityKind === "completed" || row.finalityKind === "failed" || row.finalityKind === "cancelled_confirmed");
}

function exceptionReason(manifest: CodexSubagentStopManifest, snapshot: Snapshot, nowMs: number): string | null {
  if (snapshot.exceptionReason !== null) return snapshot.exceptionReason;
  if (!terminal(snapshot) && nowMs >= Date.parse(manifest.deadline)) return "deadline";
  if (!terminal(snapshot) && snapshot.consecutiveQueryFailures >= manifest.maxConsecutiveQueryFailures) return "query-failure-limit";
  if (snapshot.observedAt > manifest.deadline) return "deadline";
  return null;
}

function reportPending(snapshot: Snapshot, binding: Binding, manifest: CodexSubagentStopManifest, reason: string): Promise<CodexSubagentStopDecision> {
  const state = snapshot.reportAttempt.state;
  if (state === "acknowledged") return Promise.resolve(allow(manifest.batchId, "CODEX_STOP_REPORT_ACKNOWLEDGED"));
  if (state === "unknown" || state === "failed") return Promise.resolve(allow(manifest.batchId, state === "unknown" ? "CODEX_STOP_REPORT_UNKNOWN" : "CODEX_STOP_REPORT_FAILED"));
  if (state === "in-flight") {
    if (reason !== "normal-terminal" && binding.exceptionContinuationUsed) return Promise.resolve(allow(manifest.batchId, "CODEX_STOP_REPORT_UNCONFIRMED"));
    if (binding.reportReconciliationUsed) return Promise.resolve(allow(manifest.batchId, "CODEX_STOP_REPORT_UNCONFIRMED"));
    const changes = reason === "normal-terminal"
      ? { reportReconciliationUsed: true }
      : { reportReconciliationUsed: true, exceptionContinuationUsed: true };
    return updateBinding(manifest.bindingPath, binding, changes).then(() => block(
      manifest.batchId,
      "CODEX_STOP_REPORT_RECONCILE_ONCE",
      `Read the already-returned native result for the one message attempt and save its actual acknowledgement evidence in ${manifest.snapshotPath}; do not call the parent-message tool again. ${reason}`,
    ));
  }
  const used = reason === "normal-terminal" ? binding.reportContinuationUsed : binding.exceptionContinuationUsed;
  if (used) return Promise.resolve(allow(manifest.batchId, "CODEX_STOP_REPORT_UNCONFIRMED"));
  const changes = reason === "normal-terminal" ? { reportContinuationUsed: true } : { exceptionContinuationUsed: true };
  return updateBinding(manifest.bindingPath, binding, changes).then(() => block(
    manifest.batchId,
    reason === "normal-terminal" ? "CODEX_STOP_REPORT_ONCE" : "CODEX_STOP_EXCEPTION_REPORT_ONCE",
    `Write reportAttempt state in-flight to ${manifest.snapshotPath}, call the authorized native parent-message tool once with the fixed batch facts, and save the actual result evidence. Do not retry if the outcome is unknown. ${reason}`,
  ));
}

/**
 * The parent writes the manifest before dispatch. The collector writes each native query snapshot.
 * This handler only binds the first real Codex stop IDs and makes bounded allow/block decisions;
 * it never queries collaboration, reads transcripts or sends a message itself.
 */
export async function handleCodexSubagentStop(input: {
  readonly payload: unknown;
  readonly deviceHome: string;
  readonly now?: string;
}): Promise<CodexSubagentStopDecision> {
  const payload = object(input.payload) ? input.payload : {};
  const envelope = parseEnvelope(payload.last_assistant_message);
  if (envelope === null) return allow();
  let manifest: CodexSubagentStopManifest | null = null;
  let binding: Binding | null = null;
  try {
    const paths = batchPaths(input.deviceHome, envelope.batchId);
    await assertBatchDirectory(paths.directory);
    if (resolve(envelope.manifestPath) !== paths.manifestPath) return allow();
    manifest = validatedManifest(await readJson(paths.manifestPath), paths, envelope);
    const sessionId = payload.session_id;
    const agentId = payload.agent_id;
    if (typeof sessionId !== "string" || sessionId.length === 0 || typeof agentId !== "string" || agentId.length === 0) return allow(manifest.batchId, "CODEX_STOP_NATIVE_IDS_MISSING");
    const now = input.now ?? new Date().toISOString();
    if (!utcInstant(now)) return allow(manifest.batchId, "CODEX_STOP_CLOCK_INVALID");
    const acquired = await createBinding(manifest.bindingPath, manifest, sessionId, agentId, now);
    binding = acquired.binding;
    if (binding.sessionId !== sessionId || binding.agentId !== agentId) return allow(manifest.batchId, "CODEX_STOP_ID_MISMATCH");
    if (acquired.created) {
      return block(
        manifest.batchId,
        "CODEX_STOP_FIRST_BINDING",
        `This is the first stop for the validated batch. Use native tools to query exactly ${manifest.targetTaskNames.length} fixed task(s), write the raw states and evidence to ${manifest.snapshotPath}, then stop again. This binding is only local correlation, not authentication.`,
      );
    }
    let snapshot: Snapshot;
    try {
      snapshot = validatedSnapshot(await readJson(manifest.snapshotPath), manifest);
    } catch (error) {
      if (!binding.exceptionContinuationUsed) {
        await updateBinding(manifest.bindingPath, binding, { exceptionContinuationUsed: true });
        return block(manifest.batchId, "CODEX_STOP_PROTOCOL_ERROR_ONCE", `The collector snapshot is missing or invalid (${String((error as Error).message).slice(0, 240)}). Record protocol-error, preserve the raw facts and make at most one focused native report; then stop again.`);
      }
      return allow(manifest.batchId, "CODEX_STOP_PROTOCOL_ERROR_UNCONFIRMED");
    }
    const nowMs = Date.parse(now);
    const exception = exceptionReason(manifest, snapshot, nowMs);
    if (exception !== null) return await reportPending(snapshot, binding, manifest, exception);
    if (terminal(snapshot)) return await reportPending(snapshot, binding, manifest, "normal-terminal");

    const nextQueryAt = snapshot.nextQueryAt;
    if (nextQueryAt === null) {
      if (!binding.exceptionContinuationUsed) {
        await updateBinding(manifest.bindingPath, binding, { exceptionContinuationUsed: true });
        return block(manifest.batchId, "CODEX_STOP_PROTOCOL_ERROR_ONCE", `A nonterminal snapshot has no nextQueryAt. Record protocol-error and report the missing schedule once; do not poll in a stop loop.`);
      }
      return allow(manifest.batchId, "CODEX_STOP_PROTOCOL_ERROR_UNCONFIRMED");
    }
    const isDue = nowMs >= Date.parse(nextQueryAt);
    const decisionKey = `pending:${snapshot.observedAt}:${nextQueryAt}:${isDue ? "due" : "early"}`;
    if (binding.lastPendingDecisionKey === decisionKey) return allow(manifest.batchId, "CODEX_STOP_PENDING_WITHOUT_PROGRESS");
    binding = await updateBinding(manifest.bindingPath, binding, { lastPendingDecisionKey: decisionKey });
    const instruction = isDue
      ? `Query each manifest targetTaskNames entry exactly once now, save the latest raw host states and evidence to ${manifest.snapshotPath}, then stop again.`
      : `Use the collector's native wait/sleep until ${nextQueryAt}, then query each manifest targetTaskNames entry exactly once and save the latest raw states to ${manifest.snapshotPath}. Do not block in this 10-second hook or stop-loop for a timer.`;
    return block(manifest.batchId, isDue ? "CODEX_STOP_QUERY_DUE" : "CODEX_STOP_WAIT_UNTIL_QUERY", instruction);
  } catch (error) {
    if (manifest !== null && binding !== null && !binding.exceptionContinuationUsed) {
      try {
        await updateBinding(manifest.bindingPath, binding, { exceptionContinuationUsed: true });
        return block(manifest.batchId, "CODEX_STOP_SCRIPT_ERROR_ONCE", `A bound collector hit a script/protocol error (${String((error as Error).message).slice(0, 240)}). Make one focused native error report with the actual facts, then stop; do not retry a message whose result is unknown.`);
      } catch {
        return allow(manifest.batchId, "CODEX_STOP_SCRIPT_ERROR_UNRECORDED");
      }
    }
    return allow(manifest?.batchId, "CODEX_STOP_SCRIPT_ERROR");
  }
}
