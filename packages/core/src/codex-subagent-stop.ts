// SPDX-License-Identifier: Apache-2.0

/** Public native-host contract. The pure evaluator remains useful without a native host. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
export const CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX = "EINZBERN_SUBAGENT_STOP_V1 " as const;
export const CODEX_SUBAGENT_STOP_CAPABILITY = Object.freeze({
  state: "unverified" as const,
  reasonCode: "CODEX_STOP_CAPABILITY_UNAVAILABLE",
  missing: ["parent-observed dispatch binding", "fresh same-host fixed-member query", "bounded same-live-collector wait", "native final return and release observation"],
});

/** Structural subset of the Codex app-server client. It must be owned by the live host. */
export interface CodexNativeClient {
  /** The owning client must honor AbortSignal and settle the operation when aborted. */
  call(method: string, params: Record<string, unknown>, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface CodexDynamicToolRequest {
  readonly threadId: string;
  readonly callId: string;
  readonly arguments: unknown;
}

export interface CodexDynamicToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface CodexDynamicToolHost {
  /** The app-server implementation invokes this only for its actual dynamic-tool requests. */
  registerDynamicTool(input: CodexDynamicToolSpec & {
    readonly handler: (request: CodexDynamicToolRequest) => Promise<unknown>;
  }, options?: { readonly signal?: AbortSignal }): (() => void) | Promise<() => void>;
}

export interface CodexNativeRun {
  readonly batchId: string;
  readonly attemptId: string;
  readonly parentThreadId: string;
  readonly parentSessionId: string;
  readonly startedAt: string;
  readonly deadline: string;
  readonly queryIntervalMs: number;
  readonly maxConsecutiveQueryFailures: number;
  readonly workerPolicy: { readonly model: string; readonly effort: string };
  readonly collectorPolicy: { readonly model: string; readonly effort: string };
  /** Host-observed worker budget and real free child slots captured before dispatch. */
  readonly workerCap: number;
  readonly availableSlots: number;
  /** Native host hard total-child bound for this batch, including its collector. */
  readonly maxAgents: number;
}

export interface CodexNativeControllerOptions {
  readonly client: CodexNativeClient;
  readonly tools: CodexDynamicToolHost;
  readonly run: CodexNativeRun;
  readonly runtimeDirectory: string;
  /** Explicit per-run opt-in. This never reads or changes Desktop/global configuration. */
  readonly wakeOnAgentMessagesApproved: boolean;
  /** Clock seam for deterministic host contract tests; production defaults to a real timer. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  /** Actual owning-client evidence, never inferred from a version number. */
  readonly transport?: { readonly abort: "supported"; readonly hookTimeoutMs: number; readonly rpcTimeoutMs: number; readonly evidenceRef: string };
  /** Normal installed versioned entry; helper is invoked by the same live collector. */
  readonly helperEntry?: string;
}

const REGISTRATION_TOOL = "einzbern_register_native_batch";
const CONTROL_TOOL = "einzbern_control_native_batch";

/** Pure definitions for thread/start, before that call supplies the real parent thread ID. */
export function codexNativeDynamicToolSpecs(maxAgents: number): readonly [CodexDynamicToolSpec, CodexDynamicToolSpec] {
  if (!Number.isSafeInteger(maxAgents) || maxAgents < 2 || maxAgents > 128) throw new Error("NATIVE_RUN_CONFIGURATION_INVALID");
  return [
    { name: REGISTRATION_TOOL, description: "Owner-only fixed batch registration; failure retains all child responsibility.", inputSchema: { type: "object", additionalProperties: false, required: ["batchId", "attemptId", "members"], properties: { batchId: { type: "string" }, attemptId: { type: "string" }, members: { type: "array", minItems: 2, maxItems: maxAgents, items: { type: "object", additionalProperties: false, required: ["role", "taskName"], properties: { role: { enum: ["worker", "collector"] }, taskName: { type: "string" }, targets: { type: "array", items: { type: "string" } } } } } } } },
    { name: CONTROL_TOOL, description: "Owner-only immutable-membership exception control.", inputSchema: { type: "object", additionalProperties: false, required: ["batchId", "attemptId", "exception"], properties: { batchId: { type: "string" }, attemptId: { type: "string" }, exception: { enum: ["budget-exhausted", "paused", "user-cancelled", "safety", "permission"] } } } },
  ];
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
type RecordValue = Record<string, unknown>;
type StopInput = { readonly payload: unknown; readonly now?: string; readonly signal?: AbortSignal };
type StopResult = { readonly matched: boolean; readonly decision: "allow" | "block"; readonly reasonCode?: string; readonly reason?: string };
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): RecordValue => { if (!object(value)) throw new Error("NATIVE_OBJECT_INVALID"); return value; };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const string = (value: unknown): string => { if (!text(value)) throw new Error("NATIVE_STRING_INVALID"); return value; };
const records = (value: unknown): RecordValue[] => { if (!Array.isArray(value)) throw new Error("NATIVE_ARRAY_INVALID"); return value.map(record); };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : object(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const status = (thread: RecordValue): string => string(record(thread.status).type);
const shellWord = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
interface Member { role: "worker" | "collector"; taskName: string; targets: string[]; threadId: string; turnId: string; dispatchItemId: string }
interface Registration { args: RecordValue; members: Member[]; callId: string; parentTurnId: string; fingerprint: string; exception: CollectorException | null; progress: CollectorProgress; failures: number; ended: boolean }
interface Snapshot { thread: RecordValue; turn: RecordValue; extra: boolean }

function requireRun(run: CodexNativeRun): void {
  if (!text(run.batchId) || !text(run.attemptId) || !UUID.test(run.parentThreadId) || run.parentSessionId !== run.parentThreadId ||
      !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.deadline)) || Date.parse(run.deadline) <= Date.parse(run.startedAt) ||
      !Number.isSafeInteger(run.queryIntervalMs) || run.queryIntervalMs < 10_000 || run.queryIntervalMs > 86_400_000 ||
      !Number.isSafeInteger(run.maxConsecutiveQueryFailures) || run.maxConsecutiveQueryFailures < 1 ||
      !text(run.workerPolicy.model) || !text(run.workerPolicy.effort) || !text(run.collectorPolicy.model) || !text(run.collectorPolicy.effort) ||
      !Number.isSafeInteger(run.workerCap) || run.workerCap < 1 || !Number.isSafeInteger(run.availableSlots) || run.availableSlots < 2 ||
      !Number.isSafeInteger(run.maxAgents) || run.maxAgents < 2 || run.maxAgents > 128) throw new Error("NATIVE_RUN_CONFIGURATION_INVALID");
}

/** No file enrolls a collector. All authority remains with the owning live native client. */
export async function createCodexNativeController(options: CodexNativeControllerOptions): Promise<{
  readonly capability: "ready" | "unavailable"; readonly reasonCode: string;
  handleSubagentStop(input: StopInput): Promise<StopResult>;
  waitCollector(input: { readonly payload: unknown; readonly signal?: AbortSignal }): Promise<unknown>;
  responsibility(): { readonly state: string; readonly children: readonly string[]; readonly error: string | null; readonly nativeOperationsUnsettled: number };
  close(): Promise<void>;
}> {
  const run = structuredClone(options.run), root = resolve(options.runtimeDirectory);
  const now = options.now ?? Date.now;
  const deadline = Date.parse(run.deadline);
  const lifetime = new AbortController();
  let activeSignal: AbortSignal | undefined;
  let closed = false, registration: Registration | null = null, attempted = false;
  let ownerError: string | null = null, ownerState = "not-registered";
  const children = new Set<string>(), operations = new Set<Promise<unknown>>();
  const unregs: Array<() => void> = [];
  let serial: Promise<unknown> = Promise.resolve();
  const locked = <T>(action: () => Promise<T>): Promise<T> => { const task = serial.then(action); serial = task.catch(() => undefined); return task; };
  const check = (): void => { if (activeSignal?.aborted) throw activeSignal.reason; if (closed) throw new Error("NATIVE_CONTROLLER_CLOSED"); if (now() < Date.parse(run.startedAt)) throw new Error("NATIVE_CLOCK_SKEW"); };
  const responsibility = () => ({ state: ownerState, children: [...children], error: ownerError, nativeOperationsUnsettled: operations.size });
  const unrelated = (): StopResult => ({ matched: false, decision: "allow" });
  const blocked = (reasonCode: string, reason: string): StopResult => ({ matched: true, decision: "block", reasonCode, reason });
  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, permitDeadline = false, helperWait = false): Promise<T> {
    check();
    const remaining = deadline - now();
    if (!permitDeadline && remaining <= 0) throw new Error("NATIVE_DEADLINE_EXCEEDED");
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("NATIVE_OPERATION_ABORTED"));
    lifetime.signal.addEventListener("abort", abort, { once: true }); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || lifetime.signal.aborted) abort();
    const timeout = Math.min(helperWait ? remaining : options.transport?.rpcTimeoutMs ?? 10_000, permitDeadline ? 10_000 : remaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortResult = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      if (controller.signal.aborted) reject(controller.signal.reason);
      timer = setTimeout(() => controller.abort(new Error(remaining <= timeout ? "NATIVE_DEADLINE_EXCEEDED" : "NATIVE_RPC_TIMEOUT")), timeout);
    });
    const native = Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason; return action(controller.signal); });
    operations.add(native);
    void native.finally(() => operations.delete(native)).catch(() => undefined);
    try { const value = await Promise.race([native, abortResult]); if (controller.signal.aborted) throw controller.signal.reason; check(); if (!permitDeadline && now() >= deadline) throw new Error("NATIVE_DEADLINE_EXCEEDED"); return value; }
    finally { clearTimeout(timer); lifetime.signal.removeEventListener("abort", abort); signal?.removeEventListener("abort", abort); }
  }
  let readReceipts: Array<{ method: string; startedAt: number; completedAt: number }> = [];
  const call = async (method: string, params: RecordValue, signal?: AbortSignal): Promise<unknown> => {
    const startedAt = now(); const value = await bounded(s => options.client.call(method, params, { signal: s }), signal);
    check(); if (Buffer.byteLength(canonical(value)) > 16_777_216) throw new Error("NATIVE_RPC_BYTE_BOUND"); readReceipts.push({ method, startedAt, completedAt: now() });
    if (readReceipts.length > 20_000) throw new Error("NATIVE_READ_RECEIPT_BOUND"); return value;
  };
  async function pages(method: string, params: RecordValue, signal?: AbortSignal): Promise<unknown[]> {
    const values: unknown[] = [], cursors = new Set<string>(), entries = new Set<string>(); let cursor: string | null = null, bytes = 0;
    for (let page = 0; page < 100; page++) {
      const data = record(await call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }, signal));
      if (!Array.isArray(data.data) || (data.nextCursor != null && !text(data.nextCursor))) throw new Error("NATIVE_PAGE_INVALID");
      let added = 0;
      for (const entry of data.data) { const key = canonical(entry); bytes += Buffer.byteLength(key); if (!entries.has(key)) { entries.add(key); values.push(entry); added++; } }
      if (bytes > 16_777_216 || values.length > 10_000) throw new Error("NATIVE_PAGE_BYTE_BOUND");
      const next = text(data.nextCursor) ? data.nextCursor : null;
      if (next && (!added || cursors.has(next))) throw new Error("NATIVE_PAGE_NO_PROGRESS");
      if (!next) return values;
      cursors.add(next); cursor = next;
    }
    throw new Error("NATIVE_PAGE_BOUND");
  }
  const history = async (signal?: AbortSignal) => (await pages("thread/items/list", { threadId: run.parentThreadId, sortDirection: "asc" }, signal)).map(entry => record(object(entry) && "item" in entry ? entry.item : entry));
  async function snapshot(threadId: string, signal?: AbortSignal): Promise<Snapshot> {
    const [thread, turns] = await Promise.all([call("thread/read", { threadId, includeTurns: false }, signal), call("thread/turns/list", { threadId, limit: 2, sortDirection: "desc", itemsView: "full" }, signal)]);
    const data = record(turns).data;
    if (!Array.isArray(data) || !data.length) throw new Error("NATIVE_TURN_MISSING");
    return { thread: record(record(thread).thread), turn: record(data[0]), extra: data.length > 1 };
  }
  async function privateDirectory(path: string): Promise<void> {
    check(); await mkdir(path, { recursive: true, mode: 0o700 }); check(); const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("NATIVE_DIRECTORY_NOT_PRIVATE");
  }
  async function artifact(bytes: Buffer): Promise<RecordValue> {
    check(); const digest = sha256(bytes), directory = join(root, "native-results"); await privateDirectory(directory);
    const path = join(directory, digest + ".json");
    try { check(); const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400); try { check(); await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
    catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; }
    await verifyArtifact({ artifactRef: path, sha256: digest, bytes: bytes.length });
    return { artifactRef: path, sha256: digest, bytes: bytes.length };
  }
  async function verifyArtifact(value: unknown): Promise<void> {
    const raw = record(value), path = string(raw.artifactRef);
    if (path !== join(root, "native-results", string(raw.sha256) + ".json")) throw new Error("NATIVE_ARTIFACT_PATH_INVALID");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || (stat.mode & 0o777) !== 0o400 || (process.getuid && stat.uid !== process.getuid()) || stat.nlink !== 1 || stat.size !== raw.bytes || stat.size > 16_777_216) throw new Error("NATIVE_ARTIFACT_UNSAFE");
      const bytes = await file.readFile(); check(); if (bytes.length !== raw.bytes || sha256(bytes) !== raw.sha256) throw new Error("NATIVE_ARTIFACT_DIGEST_MISMATCH");
    } finally { await file.close(); }
  }
  async function evidence(kind: string, value: unknown): Promise<void> { await artifact(Buffer.from(canonical({ batchId: run.batchId, attemptId: run.attemptId, kind, at: new Date(now()).toISOString(), value }))); }
  function pinned(snap: Snapshot, member: Member): void {
    if (snap.thread.parentThreadId !== run.parentThreadId || snap.thread.sessionId !== run.parentSessionId || snap.thread.canAcceptDirectInput !== false || snap.turn.id !== member.turnId || snap.extra || snap.turn.itemsView !== "full") throw new Error("NATIVE_PINNED_TURN_MISMATCH");
  }
  async function observe(reg: Registration, signal?: AbortSignal): Promise<CollectorFinal> {
    readReceipts = [];
    const acquired: number[] = [];
    const timed = async <T>(action: () => Promise<T>): Promise<T> => { const at = now(); const value = await action(); acquired.push(at); return value; };
    const [parent, items, loadedEntries] = await Promise.all([timed(() => snapshot(run.parentThreadId, signal)), timed(() => history(signal)), timed(() => pages("thread/loaded/list", {}, signal))]);
    const loaded = new Set(loadedEntries.map(string));
    if (parent.thread.sessionId !== run.parentSessionId || !["active", "idle"].includes(status(parent.thread))) throw new Error("NATIVE_PARENT_PROVENANCE_INVALID");
    const confirmations = items.filter(item => item.type === "dynamicToolCall" && item.tool === REGISTRATION_TOOL && item.id === reg.callId);
    const confirm = confirmations[0];
    if (confirmations.length !== 1 || !confirm || confirm.status !== "completed" || confirm.success !== true || canonical(confirm.arguments) !== canonical(reg.args)) throw new Error("NATIVE_REGISTRATION_NOT_CONFIRMED");
    const receipt: unknown = JSON.parse(records(confirm.contentItems).filter(item => item.type === "inputText").map(item => string(item.text)).join(""));
    if (!object(receipt) || receipt.fingerprint !== reg.fingerprint || receipt.status !== "registered" || receipt.batchId !== run.batchId || receipt.attemptId !== run.attemptId) throw new Error("NATIVE_REGISTRATION_RECEIPT_MISMATCH");
    let exception = reg.exception;
    for (const item of items) if (item.type === "dynamicToolCall" && item.tool === CONTROL_TOOL && item.status === "completed" && item.success === true) {
      const args = record(item.arguments); if (args.batchId === run.batchId && args.attemptId === run.attemptId && EXCEPTIONS.has(args.exception as CollectorException)) exception = args.exception as CollectorException;
    }
    for (const member of reg.members) {
      const receipts = items.filter(item => item.id === member.dispatchItemId && item.type === "subAgentActivity" && item.kind === "started" && item.agentThreadId === member.threadId);
      const policy = member.role === "collector" ? run.collectorPolicy : run.workerPolicy;
      if (receipts.length !== 1 || receipts[0]?.model !== policy.model || receipts[0]?.reasoningEffort !== policy.effort) throw new Error("NATIVE_DISPATCH_REVALIDATION_FAILED");
    }
    const collector = reg.members.find(member => member.role === "collector")!;
    const collectorSnap = await timed(() => snapshot(collector.threadId, signal)); pinned(collectorSnap, collector);
    if (!loaded.has(collector.threadId) || collectorSnap.turn.status !== "inProgress" || items.some(item => item.type === "subAgentActivity" && item.kind === "interacted" && item.agentThreadId === collector.threadId)) throw new Error("NATIVE_COLLECTOR_LIFECYCLE_MISMATCH");
    const facts: CollectorFact[] = [];
    for (const worker of reg.members.filter(member => member.role === "worker")) {
      const snap = await timed(() => snapshot(worker.threadId, signal)); pinned(snap, worker);
      const finals = records(snap.turn.items).filter(item => item.type === "agentMessage" && item.phase === "final_answer");
      const state = status(snap.thread); let finalityKind: CollectorFact["finalityKind"] = "unknown";
      if (loaded.has(worker.threadId)) {
        if (state === "idle" && snap.turn.status === "completed" && finals.length) finalityKind = "completed";
        else if (["idle", "systemError"].includes(state) && snap.turn.status === "failed") finalityKind = "failed";
        else if (state === "idle" && snap.turn.status === "interrupted" && items.some(item => item.type === "subAgentActivity" && item.kind === "interrupted" && item.agentThreadId === worker.threadId)) finalityKind = "cancelled_confirmed";
        else if (["active", "idle"].includes(state) && snap.turn.status === "inProgress") finalityKind = "pending";
      }
      let rawResult: unknown = { turnId: snap.turn.id, status: snap.turn.status, error: snap.turn.error ?? null };
      if (["completed", "failed", "cancelled_confirmed"].includes(finalityKind)) rawResult = { ...record(rawResult), nativeFinalItemIds: finals.map(item => string(item.id)), ...await artifact(Buffer.from(canonical({ threadId: worker.threadId, turn: snap.turn }))) };
      facts.push({ agentId: worker.threadId, hostState: `${state}/${string(snap.turn.status)}`, finalityKind, evidenceRef: ["completed", "failed", "cancelled_confirmed"].includes(finalityKind) ? `native-thread:${worker.threadId}#turn:${worker.turnId}` : null, rawResult });
    }
    check(); const evaluated = now();
    if (acquired.some(at => at > evaluated || evaluated - at > run.queryIntervalMs) || readReceipts.some(read => read.startedAt > read.completedAt || read.completedAt > evaluated || evaluated - read.startedAt > run.queryIntervalMs)) throw new Error("NATIVE_OBSERVATION_STALE");
    if (evaluated >= deadline) exception = "deadline";
    await evidence("observation", { reads: readReceipts, evaluated, facts, exception });
    if (now() - Math.min(...acquired) > run.queryIntervalMs) throw new Error("NATIVE_OBSERVATION_STALE");
    return { exception, facts };
  }
  const registerTool = (input: Parameters<CodexDynamicToolHost["registerDynamicTool"]>[0]) => bounded(async signal => {
    const off = await options.tools.registerDynamicTool(input, { signal });
    if (signal.aborted || closed) { off(); throw new Error("NATIVE_TOOL_REGISTRATION_ABORTED"); } return off;
  });
  let stage: { final: CollectorFinal; formats: number; acceptedText: string | null } | null = null;
  const waitInstruction = () => options.helperEntry
    ? `In this SAME live collector invoke node ${shellWord(options.helperEntry)} collector-wait ${shellWord(canonical({ batchId: run.batchId, attemptId: run.attemptId, agentId: registration?.members.find(m => m.role === "collector")?.threadId, turnId: registration?.members.find(m => m.role === "collector")?.turnId, sessionId: run.parentSessionId }))}. Then finish again for a fresh native check.`
    : "Collector helper entry unavailable. Preserve unresolved-child responsibility in the owning native client.";
  try {
    requireRun(run); if (!options.wakeOnAgentMessagesApproved) throw new Error("WAKE_ON_AGENT_MESSAGES_NOT_APPROVED");
    if (!options.transport?.evidenceRef || run.queryIntervalMs > 890_000 || !options.transport || options.transport.hookTimeoutMs > 900_000 || options.transport.abort !== "supported" || !Number.isSafeInteger(options.transport.rpcTimeoutMs) || options.transport.rpcTimeoutMs < 1 || !Number.isSafeInteger(options.transport.hookTimeoutMs) || options.transport.hookTimeoutMs <= options.transport.rpcTimeoutMs) throw new Error("NATIVE_TRANSPORT_SUPPORT_UNKNOWN");
    if (!options.helperEntry || !options.helperEntry.startsWith("/")) throw new Error("NATIVE_HELPER_SUPPORT_UNKNOWN");
    await privateDirectory(root);
    const [registrationSpec, controlSpec] = codexNativeDynamicToolSpecs(run.maxAgents);
    unregs.push(await registerTool({ ...registrationSpec, handler: request => locked(async () => {
      if (request.threadId !== run.parentThreadId || !text(request.callId)) throw new Error("NATIVE_PARENT_REGISTRATION_REFUSED");
      if (attempted || closed) return { status: "failed", reasonCode: "NATIVE_REGISTRATION_ALREADY_ATTEMPTED", responsibility: responsibility() };
      attempted = true; ownerState = "registration-in-flight";
      try {
        const args = record(request.arguments), members = records(args.members);
        if (args.batchId !== run.batchId || args.attemptId !== run.attemptId || members.length > run.maxAgents) throw new Error("NATIVE_REGISTRATION_SHAPE_INVALID");
        const workers = members.filter(m => m.role === "worker"), collectors = members.filter(m => m.role === "collector");
        if (!validateCodexCollectorCapacity({ host: "codex", workers: workers.length, collectors: collectors.length, workerCap: run.workerCap, availableSlots: run.availableSlots }).admitted || members.length !== workers.length + 1 || new Set(members.map(m => string(m.taskName))).size !== members.length) throw new Error("NATIVE_FIXED_MEMBERSHIP_INVALID");
        const target = collectors[0]; if (!target || !Array.isArray(target.targets) || canonical([...target.targets].map(string).sort()) !== canonical(workers.map(m => string(m.taskName)).sort())) throw new Error("NATIVE_TARGETS_INVALID");
        const parent = await snapshot(run.parentThreadId);
        if (parent.thread.sessionId !== run.parentSessionId || status(parent.thread) !== "active" || parent.turn.status !== "inProgress" || parent.turn.itemsView !== "full") throw new Error("NATIVE_PARENT_PROVENANCE_INVALID");
        const starts = records(parent.turn.items).filter(item => item.type === "subAgentActivity" && item.kind === "started");
        starts.forEach(item => { if (text(item.agentThreadId) && UUID.test(item.agentThreadId)) children.add(item.agentThreadId); });
        const prior = await history();
        if (prior.some(item => item.type === "dynamicToolCall" && item.tool === REGISTRATION_TOOL && item.status === "completed" && item.success === true && object(item.arguments) && item.arguments.batchId === run.batchId && item.arguments.attemptId === run.attemptId)) throw new Error("NATIVE_ATTEMPT_ALREADY_REGISTERED");
        const resolved: Member[] = [];
        for (const member of members) {
          const matches = starts.filter(item => item.agentPath === member.taskName || item.taskName === member.taskName), activity = matches[0];
          const policy = member.role === "collector" ? run.collectorPolicy : run.workerPolicy;
          if (matches.length !== 1 || !activity || !UUID.test(string(activity.agentThreadId)) || activity.model !== policy.model || activity.reasoningEffort !== policy.effort) throw new Error("NATIVE_DISPATCH_RECEIPT_MISMATCH");
          const snap = await snapshot(string(activity.agentThreadId));
          const item: Member = { role: member.role === "collector" ? "collector" : "worker", taskName: string(member.taskName), targets: member.role === "collector" ? (member.targets as unknown[]).map(string) : [], threadId: string(activity.agentThreadId), turnId: string(snap.turn.id), dispatchItemId: string(activity.id) };
          pinned(snap, item); if (!UUID.test(item.turnId) || (item.role === "collector" && snap.turn.status !== "inProgress")) throw new Error("NATIVE_INITIAL_TURN_INVALID"); resolved.push(item);
        }
        if (canonical([...children].sort()) !== canonical(resolved.map(m => m.threadId).sort()) || starts.length !== resolved.length) throw new Error("NATIVE_MEMBERSHIP_NOT_CLOSED");
        const fingerprint = sha256(canonical({ run, args, members: resolved, callId: request.callId, parentTurnId: parent.turn.id }));
        check(); const binding: Registration = { args: structuredClone(args), members: resolved, callId: request.callId, parentTurnId: string(parent.turn.id), fingerprint, exception: null, progress: { ...CODEX_COLLECTOR_INITIAL_PROGRESS }, failures: 0, ended: false };
        await evidence("registration", { fingerprint, members: resolved });
        check(); if (now() >= deadline) throw new Error("NATIVE_DEADLINE_EXCEEDED"); registration = binding; ownerState = "registered-owned";
        return { status: "registered", batchId: run.batchId, attemptId: run.attemptId, fingerprint, collectorThreadId: resolved.find(m => m.role === "collector")!.threadId, workerThreadIds: resolved.filter(m => m.role === "worker").map(m => m.threadId) };
      } catch (error) { ownerError = message(error); ownerState = "registration-failed-unresolved"; if (!closed) await evidence("registration-failed", responsibility()).catch(() => undefined); return { status: "failed", reasonCode: ownerError, responsibility: responsibility(), discovery: "unresolved dispatched children remain owned, including identities not yet resolved" }; }
    }) }));
    unregs.push(await registerTool({ ...controlSpec, handler: request => locked(async () => {
      check(); const args = record(request.arguments);
      if (!registration || request.threadId !== run.parentThreadId || !text(request.callId) || args.batchId !== run.batchId || args.attemptId !== run.attemptId || !["budget-exhausted", "paused", "user-cancelled", "safety", "permission"].includes(string(args.exception))) throw new Error("NATIVE_CONTROL_REFUSED");
      if (registration.ended) throw new Error("NATIVE_BATCH_ENDED"); registration.exception = args.exception as CollectorException;
      await evidence("control", args); return { status: "accepted", batchId: run.batchId, attemptId: run.attemptId };
    }) }));
  } catch (error) { ownerError = message(error); for (const off of unregs.splice(0)) { try { off(); } catch (cleanupError) { ownerError += `; unregister: ${message(cleanupError)}`; } } return { capability: "unavailable", reasonCode: ownerError, handleSubagentStop: async () => unrelated(), waitCollector: async () => { throw new Error("NATIVE_HELPER_UNAVAILABLE"); }, responsibility, close: async () => { closed = true; lifetime.abort(); } }; }
  async function handle(input: StopInput): Promise<StopResult> {
    check(); const body = object(input.payload) ? input.payload : {}, reg = registration;
    if (!reg) return unrelated();
    const collector = reg.members.find(m => m.role === "collector")!;
    if (body.agent_id !== collector.threadId) return unrelated();
    if (body.session_id !== run.parentSessionId || body.turn_id !== collector.turnId) return blocked("CODEX_STOP_IDENTITY_MISMATCH", "Authenticated collector identity changed; owning client retains responsibility.");
    const finalText = typeof body.last_assistant_message === "string" ? body.last_assistant_message : "";
    if (reg.ended) return stage?.acceptedText === finalText ? { matched: true, decision: "allow", reasonCode: "CODEX_STOP_ALREADY_ENDED_RELEASE_UNVERIFIED" } : blocked("CODEX_STOP_ENDED_REENTRY_REFUSED", "Later followups cannot replay this ended attempt.");
    try {
      if (reg.progress.nextQueryAt && now() < Date.parse(reg.progress.nextQueryAt) && !stage) return blocked("CODEX_STOP_WAIT_REQUIRED", waitInstruction());
      if (stage && finalText !== canonical(stage.final)) {
        stage.formats++;
        if (stage.formats >= 4) { ownerState = "failed-final-unresolved"; ownerError = "NATIVE_FINAL_FORMAT_LIMIT"; await evidence("failed-final", { finalText, expected: stage.final, responsibility: responsibility() }); reg.ended = true; stage.acceptedText = finalText; return { matched: true, decision: "allow", reasonCode: "CODEX_STOP_FAILED_FINAL_HANDOFF_RELEASE_UNVERIFIED" }; }
        return blocked("CODEX_STOP_RAW_FINAL_REQUIRED", `Return exactly: ${canonical(stage.final)}`);
      }
      const fresh = await observe(reg, input.signal); check();
      if (stage) {
        for (const fact of stage.final.facts) if (object(fact.rawResult) && "artifactRef" in fact.rawResult) await verifyArtifact(fact.rawResult);
        if (canonical(fresh) !== canonical(stage.final)) { stage = null; return blocked("CODEX_STOP_FINAL_CHANGED", "Native final/control changed. Finish again for fresh collection; previous text is not verified."); }
        await evidence("final-allow", { final: fresh, responsibility: responsibility() }); check(); if (now() >= deadline) throw new Error("NATIVE_DEADLINE_EXCEEDED"); reg.ended = true; stage.acceptedText = finalText; ownerState = fresh.exception ? "exception-handoff-unresolved" : "native-final-release-unverified";
        return { matched: true, decision: "allow", reasonCode: "CODEX_STOP_NATIVE_FINAL_ACCEPTED_RELEASE_UNVERIFIED" };
      }
      reg.failures = 0;
      if (fresh.exception || fresh.facts.every(fact => ["completed", "failed", "cancelled_confirmed"].includes(fact.finalityKind))) { stage = { final: fresh, formats: 0, acceptedText: null }; await evidence("staged-final", fresh); return blocked("CODEX_STOP_RAW_FINAL_REQUIRED", `Return exactly: ${canonical(fresh)}`); }
      reg.progress = { lastSequence: reg.progress.lastSequence + 1, lastObservedAt: new Date(now()).toISOString(), nextQueryAt: new Date(Math.min(deadline, now() + run.queryIntervalMs)).toISOString(), ended: false };
      await evidence("progress", reg.progress); return blocked("CODEX_STOP_WAIT_REQUIRED", waitInstruction());
    } catch (error) {
      ownerError = message(error);
      if (closed || input.signal?.aborted) { if (!closed) ownerState = "disconnected-unresolved-owner-retains-children"; throw error; }
      ownerState = "query-exception-owned";
      reg.failures++;
      const exception: CollectorException = now() >= deadline || ownerError === "NATIVE_DEADLINE_EXCEEDED" ? "deadline" : reg.failures >= run.maxConsecutiveQueryFailures ? "query-failure-limit" : "script-error";
      await evidence("query-exception", { error: ownerError, failures: reg.failures, responsibility: responsibility() });
      if (exception === "script-error") { reg.progress = { ...reg.progress, nextQueryAt: new Date(Math.min(deadline, now() + run.queryIntervalMs)).toISOString() }; return blocked("CODEX_STOP_QUERY_RETRY_WAIT_REQUIRED", waitInstruction()); }
      // No further reads past deadline. Native failure handoff is explicit and is never a verified final packet.
      if (stage && finalText === canonical(stage.final) && stage.final.exception === exception) { await evidence("exception-handoff", { finalText, error: ownerError, responsibility: responsibility() }); reg.ended = true; stage.acceptedText = finalText; ownerState = "exception-handoff-unresolved"; return { matched: true, decision: "allow", reasonCode: "CODEX_STOP_EXCEPTION_HANDOFF_RELEASE_UNVERIFIED" }; }
      stage = { final: { exception, facts: reg.members.filter(m => m.role === "worker").map(m => ({ agentId: m.threadId, hostState: `query-error/${ownerError}`, finalityKind: "unknown", evidenceRef: null, rawResult: { error: ownerError } })) }, formats: 0, acceptedText: null };
      return blocked("CODEX_STOP_RAW_FINAL_REQUIRED", `Native outcome is unresolved. Return exactly: ${canonical(stage.final)}`);
    }
  }
  return { capability: "ready", reasonCode: "CODEX_NATIVE_CONTROLLER_READY", responsibility,
    handleSubagentStop: input => {
      const abort = new AbortController();
      const onAbort = () => abort.abort(input.signal?.reason ?? new Error("NATIVE_OPERATION_ABORTED"));
      input.signal?.addEventListener("abort", onAbort, { once: true }); if (input.signal?.aborted) onAbort();
      const timer = setTimeout(() => abort.abort(new Error("NATIVE_HOOK_CALLBACK_TIMEOUT")), options.transport!.hookTimeoutMs - 1);
      const task = locked(() => { if (abort.signal.aborted) throw abort.signal.reason; activeSignal = abort.signal; return handle({ ...input, signal: abort.signal }).finally(() => { activeSignal = undefined; }); });
      const aborted = new Promise<never>((_resolve, reject) => { abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }); if (abort.signal.aborted) reject(abort.signal.reason); });
      return Promise.race([task, aborted]).finally(() => { clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); });
    },
    waitCollector: input => locked(async () => {
      activeSignal = input.signal;
      check(); const args = record(input.payload), reg = registration, collector = reg?.members.find(m => m.role === "collector");
      if (!reg || !collector || reg.ended || args.batchId !== run.batchId || args.attemptId !== run.attemptId || args.agentId !== collector.threadId || args.turnId !== collector.turnId || args.sessionId !== run.parentSessionId) throw new Error("NATIVE_HELPER_IDENTITY_REFUSED");
      const snap = await snapshot(collector.threadId, input.signal); pinned(snap, collector);
      const delay = Math.max(0, Math.min(deadline, Date.parse(reg.progress.nextQueryAt ?? new Date(now()).toISOString())) - now());
      if (delay > 0) await bounded(signal => options.wait ? options.wait(delay, signal) : new Promise<void>((resolveWait, reject) => { const timer = setTimeout(resolveWait, delay); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }), input.signal, false, true);
      check(); return { status: "waited", batchId: run.batchId, attemptId: run.attemptId, at: new Date(now()).toISOString() };
    }).finally(() => { activeSignal = undefined; }),
    close: async () => { if (closed) return; closed = true; ownerState = "closed-unresolved-owner-retains-children"; lifetime.abort(new Error("NATIVE_CONTROLLER_CLOSED"));
      const failures: unknown[] = []; for (const off of unregs.splice(0)) { try { off(); } catch (error) { failures.push(error); } }
      await serial.catch(() => undefined);
      if (failures.length) { ownerError = failures.map(message).join("; "); throw new AggregateError(failures, "NATIVE_CONTROLLER_UNREGISTER_FAILED_OWNER_RETAINS_CHILDREN"); } },
  };
}

type CollectorFinal = { readonly exception: CollectorException | null; readonly facts: readonly CollectorFact[] };

export interface CollectorIdentity {
  readonly role: "collector";
  readonly batchId: string;
  readonly agentId: string;
  readonly attemptId: string;
  readonly parentSessionId: string;
}

export interface CollectorContract {
  /** Parent-owned immutable mapping from an observed native spawn receipt; never a worker marker. */
  readonly collector: CollectorIdentity;
  readonly targetAgentIds: readonly string[];
  readonly startedAt: string;
  readonly deadline: string;
  readonly queryIntervalMs: number;
  readonly maxConsecutiveQueryFailures: number;
}

export interface CollectorFact {
  readonly agentId: string;
  readonly hostState: string;
  readonly finalityKind: "completed" | "failed" | "cancelled_confirmed" | "pending" | "unknown";
  readonly evidenceRef: string | null;
  readonly rawResult: unknown;
}

export type CollectorException = "deadline" | "query-failure-limit" | "budget-exhausted" | "paused" | "user-cancelled" | "safety" | "permission" | "no-progress" | "protocol-error" | "script-error";

export interface CollectorObservation {
  readonly batchId: string;
  readonly attemptId: string;
  /** Monotonically increasing query sequence within this attempt, not a native turn id. */
  readonly sequence: number;
  readonly observedAt: string;
  readonly facts: readonly CollectorFact[];
  readonly consecutiveQueryFailures: number;
  readonly exception: CollectorException | null;
}

export interface CollectorProgress {
  readonly lastSequence: number;
  readonly lastObservedAt: string | null;
  readonly nextQueryAt: string | null;
  readonly ended: boolean;
}

export interface CollectorDecision {
  readonly decision: "allow" | "block";
  readonly reasonCode: string;
  readonly outcome: "unrelated" | "capability-unavailable" | "waiting" | "terminal" | "exception" | "already-ended";
  readonly progress: CollectorProgress;
  /** Raw facts only. The collector's native final return, not a parent-message/ack handshake. */
  readonly final?: { readonly exception: CollectorException | null; readonly facts: readonly CollectorFact[] };
  readonly waitUntil?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled_confirmed"]);
const FINALITY = new Set([...TERMINAL, "pending", "unknown"]);
const EXCEPTIONS = new Set<CollectorException>(["deadline", "query-failure-limit", "budget-exhausted", "paused", "user-cancelled", "safety", "permission", "no-progress", "protocol-error", "script-error"]);
export const CODEX_COLLECTOR_INITIAL_PROGRESS: CollectorProgress = Object.freeze({ lastSequence: -1, lastObservedAt: null, nextQueryAt: null, ended: false });
const instant = (value: string): number => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ? Date.parse(value) : NaN;
const nonempty = (value: string): boolean => typeof value === "string" && value.trim().length > 0;

/** Validate the proposed stage before dispatch: one dedicated collector, with a real slot reserved. */
export function validateCodexCollectorCapacity(input: {
  readonly host: string;
  readonly workers: number;
  readonly collectors: number;
  readonly workerCap: number;
  /** Available real child slots after parent/other active agents are accounted for. */
  readonly availableSlots: number;
}): { readonly applicable: boolean; readonly admitted: boolean; readonly reasonCode: string } {
  if (input.host !== "codex") return { applicable: false, admitted: false, reasonCode: "CODEX_ONLY" };
  if (![input.workers, input.collectors, input.workerCap, input.availableSlots].every(value => Number.isSafeInteger(value) && value >= 0)) return { applicable: true, admitted: false, reasonCode: "INVALID_CAPACITY" };
  if (input.workers < 1 || input.collectors !== 1) return { applicable: true, admitted: false, reasonCode: "EXACTLY_ONE_DEDICATED_COLLECTOR" };
  if (input.workers > input.workerCap) return { applicable: true, admitted: false, reasonCode: "WORKER_CAP" };
  if (input.workers + 1 > input.availableSlots) return { applicable: true, admitted: false, reasonCode: "RESERVE_COLLECTOR_SLOT" };
  return { applicable: true, admitted: true, reasonCode: "ADMITTED" };
}

/**
 * Deterministic contract evaluation only. Inputs are not authenticated by this function.
 * An eventual supported adapter must obtain the parent mapping and a fresh same-host
 * observation, serialize/persist progress, and prove wait/final-return behavior. Supplied
 * files, booleans and fixtures cannot provide that provenance. The installed handler below
 * deliberately does NOT call this evaluator without that adapter.
 */
export function evaluateCodexCollectorStop(input: {
  readonly contract: CollectorContract;
  readonly identity: CollectorIdentity;
  readonly observation: CollectorObservation;
  readonly collectorStatus: "live" | "ended" | "unknown";
  readonly now: string;
  readonly progress: CollectorProgress;
}): CollectorDecision {
  const { contract, identity, observation } = input;
  const progress = input.progress ?? CODEX_COLLECTOR_INITIAL_PROGRESS;
  const allow = (reasonCode: string, outcome: CollectorDecision["outcome"]): CollectorDecision => ({ decision: "allow", reasonCode, outcome, progress });
  const expected = contract.collector;
  if (expected.role !== "collector" || identity.role !== "collector" || ["batchId", "agentId", "attemptId", "parentSessionId"].some(key => {
    const field = key as "batchId" | "agentId" | "attemptId" | "parentSessionId";
    return !nonempty(expected[field]) || identity[field] !== expected[field];
  })) return allow("CODEX_STOP_ID_MISMATCH", "unrelated");
  if (input.collectorStatus === "ended") return allow("CODEX_STOP_ALREADY_ENDED", "already-ended");
  if (input.collectorStatus !== "live" || input.progress === undefined ||
      typeof progress.ended !== "boolean" || !Number.isSafeInteger(progress.lastSequence) || progress.lastSequence < -1 ||
      (progress.lastObservedAt !== null && !Number.isFinite(instant(progress.lastObservedAt))) ||
      (progress.nextQueryAt !== null && !Number.isFinite(instant(progress.nextQueryAt)))) return allow("CODEX_STOP_CAPABILITY_UNAVAILABLE", "capability-unavailable");
  if (progress.ended) return allow("CODEX_STOP_ALREADY_ENDED", "already-ended");
  const finish = (exception: CollectorException | null, facts: readonly CollectorFact[] = observation.facts): CollectorDecision => ({
    decision: "allow", reasonCode: exception === null ? "CODEX_STOP_NATIVE_FINAL" : `CODEX_STOP_EXCEPTION_${exception.toUpperCase().replaceAll("-", "_")}`,
    outcome: exception === null ? "terminal" : "exception",
    progress: { ...progress, ended: true }, final: { exception, facts },
  });
  const now = instant(input.now);
  const start = instant(contract.startedAt);
  const deadline = instant(contract.deadline);
  const observed = instant(observation.observedAt);
  if (![now, start, deadline, observed].every(Number.isFinite) || deadline <= start || now < start ||
      !Number.isSafeInteger(contract.queryIntervalMs) || contract.queryIntervalMs < 10_000 || contract.queryIntervalMs > 86_400_000 ||
      !Number.isSafeInteger(contract.maxConsecutiveQueryFailures) || contract.maxConsecutiveQueryFailures < 1 ||
      contract.targetAgentIds.length === 0 || contract.targetAgentIds.some(id => !nonempty(id) || id === expected.agentId) || new Set(contract.targetAgentIds).size !== contract.targetAgentIds.length) return finish("protocol-error", []);
  // Reject wrong attempts, replay, stale/future and pre-dispatch data before terminal classification.
  if (observation.batchId !== expected.batchId || observation.attemptId !== expected.attemptId ||
      !Number.isSafeInteger(observation.sequence) || observation.sequence < 0 || observed < start || observed > now || now - observed > contract.queryIntervalMs ||
      observation.facts.length !== contract.targetAgentIds.length || observation.facts.some((fact, index) => fact.agentId !== contract.targetAgentIds[index] || !nonempty(fact.hostState) || !FINALITY.has(fact.finalityKind) || (TERMINAL.has(fact.finalityKind) && (fact.evidenceRef === null || !nonempty(fact.evidenceRef)))) ||
      !Number.isSafeInteger(observation.consecutiveQueryFailures) || observation.consecutiveQueryFailures < 0 || (observation.exception !== null && !EXCEPTIONS.has(observation.exception))) return finish("protocol-error", []);
  if (observation.sequence <= progress.lastSequence || (progress.lastObservedAt !== null && observed <= instant(progress.lastObservedAt))) return finish("no-progress");
  if (observation.exception !== null) return finish(observation.exception);
  if (observation.consecutiveQueryFailures >= contract.maxConsecutiveQueryFailures) return finish("query-failure-limit");
  if (now >= deadline) return finish("deadline");
  // Query failures and unknown never become terminal, even if older facts looked complete.
  if (observation.consecutiveQueryFailures === 0 && observation.facts.every(fact => TERMINAL.has(fact.finalityKind))) return finish(null);
  if (progress.nextQueryAt !== null && observed < instant(progress.nextQueryAt)) return finish("no-progress");
  // Freshness may include an observation exactly one interval old. Anchor the next
  // wait to this evaluation, not that observation, so accepted data cannot cause
  // immediate or near-zero reentry. The earlier deadline check keeps it future.
  const waitUntil = new Date(Math.min(now + contract.queryIntervalMs, deadline)).toISOString();
  return {
    decision: "block", reasonCode: "CODEX_STOP_BOUNDED_WAIT", outcome: "waiting", waitUntil,
    progress: { lastSequence: observation.sequence, lastObservedAt: observation.observedAt, nextQueryAt: waitUntil, ended: false },
  };
}

/**
 * Codex hook entry. Only an explicitly supplied caller-owned controller may use native
 * binding/query/wait. last_assistant_message alone is worker-authored text and must NEVER
 * enroll a collector or cause a block. Leave unrelated native final results intact.
 * Capability-unavailable is not completion and does not authorize dispatch without a collector.
 */
export async function handleCodexSubagentStop(input: {
  readonly payload: unknown;
  readonly deviceHome: string;
  readonly now?: string;
  readonly nativeController?: Pick<Awaited<ReturnType<typeof createCodexNativeController>>, "handleSubagentStop" | "capability" | "reasonCode">;
}): Promise<{ readonly matched: boolean; readonly decision: "allow" | "block"; readonly reasonCode?: string; readonly reason?: string }> {
  if (input.nativeController?.capability === "ready") return input.nativeController.handleSubagentStop({ payload: input.payload, ...(input.now === undefined ? {} : { now: input.now }) });
  const payload = input.payload !== null && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {};
  const marker = payload.last_assistant_message;
  if (typeof marker !== "string" || !marker.startsWith(CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX)) return { matched: false, decision: "allow" };
  return { matched: false, decision: "allow", reasonCode: CODEX_SUBAGENT_STOP_CAPABILITY.reasonCode };
}
