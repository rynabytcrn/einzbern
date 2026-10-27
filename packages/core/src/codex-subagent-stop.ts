// SPDX-License-Identifier: Apache-2.0

/** Public native-host contract. The pure evaluator remains useful without a native host. */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
export const CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX = "EINZBERN_SUBAGENT_STOP_V1 " as const;
export const CODEX_SUBAGENT_STOP_CAPABILITY = Object.freeze({
  state: "unverified" as const,
  reasonCode: "CODEX_STOP_CAPABILITY_UNAVAILABLE",
  missing: ["parent-observed dispatch binding", "fresh same-host fixed-member query", "bounded same-live-collector wait", "native final return and release observation"],
});

/** Structural subset of the Codex app-server client. It must be owned by the live host. */
export interface CodexNativeClient {
  call(method: string, params: Record<string, unknown>): Promise<any>;
}

export interface CodexDynamicToolRequest {
  readonly threadId: string;
  readonly callId: string;
  readonly arguments: unknown;
}

export interface CodexDynamicToolHost {
  /** The app-server implementation invokes this only for its actual dynamic-tool requests. */
  registerDynamicTool(input: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly handler: (request: CodexDynamicToolRequest) => Promise<unknown>;
  }): (() => void) | Promise<() => void>;
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
  readonly wait?: (delayMs: number) => Promise<void>;
}

const REGISTRATION_TOOL = "einzbern_register_native_batch";
const CONTROL_TOOL = "einzbern_control_native_batch";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value) ?? "null";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function itemsOf(page: any): any[] {
  if (!page || !Array.isArray(page.data)) throw new Error("NATIVE_ITEMS_INVALID");
  return page.data.map((entry: any) => entry?.item ?? entry);
}

async function parentItems(client: CodexNativeClient, threadId: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.call("thread/items/list", { threadId, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) });
    all.push(...itemsOf(page));
    cursor = typeof page.nextCursor === "string" && page.nextCursor.length ? page.nextCursor : undefined;
    if (all.length > 10_000) throw new Error("NATIVE_PARENT_HISTORY_BOUND");
  } while (cursor);
  return all;
}

async function loadedThreadIds(client: CodexNativeClient): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.call("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error("NATIVE_LOADED_LIST_INVALID");
    for (const item of page.data) if (text(item)) ids.add(item);
    cursor = typeof page.nextCursor === "string" && page.nextCursor.length ? page.nextCursor : undefined;
    if (ids.size > 2_000) throw new Error("NATIVE_LOADED_LIST_BOUND");
  } while (cursor);
  return ids;
}

async function snapshot(client: CodexNativeClient, threadId: string): Promise<{ thread: any; turn: any; extraTurn: any | null }> {
  const [threadResult, turns] = await Promise.all([
    client.call("thread/read", { threadId, includeTurns: false }),
    client.call("thread/turns/list", { threadId, limit: 2, sortDirection: "desc", itemsView: "full" }),
  ]);
  if (!threadResult?.thread || !Array.isArray(turns?.data)) throw new Error("NATIVE_THREAD_SNAPSHOT_INVALID");
  return { thread: threadResult.thread, turn: turns.data[0] ?? null, extraTurn: turns.data[1] ?? null };
}

function requireRun(run: CodexNativeRun): void {
  if (!text(run.batchId) || !text(run.attemptId) || !UUID.test(run.parentThreadId) || run.parentSessionId !== run.parentThreadId ||
      !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.deadline)) || Date.parse(run.deadline) <= Date.parse(run.startedAt) ||
      !Number.isSafeInteger(run.queryIntervalMs) || run.queryIntervalMs < 10_000 || run.queryIntervalMs > 86_400_000 ||
      !Number.isSafeInteger(run.maxConsecutiveQueryFailures) || run.maxConsecutiveQueryFailures < 1 ||
      !text(run.workerPolicy?.model) || !text(run.workerPolicy?.effort) || !text(run.collectorPolicy?.model) || !text(run.collectorPolicy?.effort) ||
      !Number.isSafeInteger(run.workerCap) || run.workerCap < 1 || !Number.isSafeInteger(run.availableSlots) || run.availableSlots < 2 ||
      !Number.isSafeInteger(run.maxAgents) || run.maxAgents < 2 || run.maxAgents > 128) throw new Error("NATIVE_RUN_CONFIGURATION_INVALID");
}

interface NativeMember {
  readonly role: "worker" | "collector";
  readonly taskName: string;
  readonly targets?: readonly string[];
  readonly threadId: string;
  readonly turnId: string;
  readonly model: string;
  readonly effort: string;
  readonly dispatchItemId: string;
}

interface NativeRegistration {
  readonly run: CodexNativeRun;
  readonly arguments: unknown;
  readonly members: readonly NativeMember[];
  readonly fingerprint: string;
  readonly registrationCallId: string;
  readonly registeredAt: string;
  readonly progress: Map<string, CollectorProgress>;
  readonly queryFailures: Map<string, number>;
  readonly stopCount: Map<string, number>;
  readonly ended: Set<string>;
}

/**
 * Bind the product handler to a live, caller-owned Codex app-server client and its
 * server-origin dynamic-tool callbacks. No persisted file can enroll a member.
 */
export async function createCodexNativeController(options: CodexNativeControllerOptions): Promise<{
  readonly capability: "ready" | "unavailable";
  readonly reasonCode: string;
  handleSubagentStop(input: { readonly payload: unknown; readonly now?: string }): Promise<{ readonly matched: boolean; readonly decision: "allow" | "block"; readonly reasonCode?: string; readonly reason?: string }>;
  close(): Promise<void>;
}> {
  const { client, tools } = options;
  const run = structuredClone(options.run);
  const root = resolve(options.runtimeDirectory);
  let registration: NativeRegistration | null = null;
  let pendingCollectorThreadId: string | null = null;
  const pendingStopCount = new Map<string, number>();
  const pendingFinal = { exception: "script-error" as CollectorException, facts: [] as readonly CollectorFact[] };
  let closed = false;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  const unregs: Array<() => void> = [];
  const staged = new Map<string, { final: { exception: CollectorException | null; facts: readonly CollectorFact[] }; formatRequests: number }>();
  const unavailable = (reasonCode: string) => ({ matched: false as const, decision: "allow" as const, reasonCode });
  try {
    requireRun(run);
    if (!options.wakeOnAgentMessagesApproved) throw new Error("WAKE_ON_AGENT_MESSAGES_NOT_APPROVED");
    const parent = await snapshot(client, run.parentThreadId);
    if (parent.thread.sessionId !== run.parentSessionId || parent.thread.status?.type !== "active") throw new Error("NATIVE_PARENT_NOT_ACTIVE");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) throw new Error("NATIVE_RUNTIME_DIRECTORY_NOT_PRIVATE");
    const registrationOff = await tools.registerDynamicTool({
      name: REGISTRATION_TOOL,
      description: "Parent-only fixed batch membership registration. Call once after dispatch and before workers can finish.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["batchId", "attemptId", "members"],
        properties: {
          batchId: { type: "string" }, attemptId: { type: "string" },
          members: { type: "array", minItems: 2, maxItems: run.maxAgents, items: {
            type: "object", additionalProperties: false, required: ["role", "taskName"],
            properties: { role: { enum: ["worker", "collector"] }, taskName: { type: "string" }, targets: { type: "array", items: { type: "string" } } },
          } },
        },
      },
      handler: async request => {
        if (closed || request.threadId !== run.parentThreadId || !text(request.callId) || registration || pendingCollectorThreadId) throw new Error("NATIVE_PARENT_REGISTRATION_REFUSED");
        const args = request.arguments as any;
        if (!args || args.batchId !== run.batchId || args.attemptId !== run.attemptId || !Array.isArray(args.members) || args.members.length < 2 || args.members.length > run.maxAgents) throw new Error("NATIVE_REGISTRATION_SHAPE_INVALID");
        const workers = args.members.filter((item: any) => item?.role === "worker");
        const collectors = args.members.filter((item: any) => item?.role === "collector");
        if (!workers.length || collectors.length !== 1 || workers.length + 1 !== args.members.length ||
            args.members.some((item: any) => !text(item?.taskName)) || new Set(args.members.map((item: any) => item.taskName)).size !== args.members.length ||
            collectors[0].targets?.length !== workers.length || canonical([...collectors[0].targets].sort()) !== canonical(workers.map((item: any) => item.taskName).sort())) throw new Error("NATIVE_FIXED_ROLE_MEMBERSHIP_INVALID");
        const observedParent = await snapshot(client, run.parentThreadId);
        if (observedParent.thread.sessionId !== run.parentSessionId || observedParent.thread.status?.type !== "active" || !observedParent.turn || observedParent.turn.status !== "inProgress" || observedParent.turn.itemsView !== "full") throw new Error("NATIVE_PARENT_PROVENANCE_INVALID");
        const history = await parentItems(client, run.parentThreadId);
        if (history.some(item => item?.type === "dynamicToolCall" && item?.tool === REGISTRATION_TOOL && item?.status === "completed" && item?.success === true && item?.arguments?.batchId === run.batchId && item?.arguments?.attemptId === run.attemptId)) throw new Error("NATIVE_ATTEMPT_ALREADY_REGISTERED");
        // Membership closure is scoped to this exact native parent turn; prior batches in
        // the same conversation are not silently treated as members of this dispatch.
        const starts = observedParent.turn.items.filter((item: any) => item?.type === "subAgentActivity" && item?.kind === "started");
        const collectorStart = starts.filter((item: any) => item?.agentPath === collectors[0].taskName || item?.taskName === collectors[0].taskName);
        if (collectorStart.length === 1 && UUID.test(collectorStart[0].agentThreadId) && collectorStart[0].model === run.collectorPolicy.model && collectorStart[0].reasoningEffort === run.collectorPolicy.effort) pendingCollectorThreadId = collectorStart[0].agentThreadId;
        const capacity = validateCodexCollectorCapacity({ host: "codex", workers: workers.length, collectors: collectors.length, workerCap: run.workerCap, availableSlots: run.availableSlots });
        if (!capacity.admitted) throw new Error(`NATIVE_CAPACITY_REFUSED_${capacity.reasonCode}`);
        const resolved: NativeMember[] = await Promise.all(args.members.map(async (member: any) => {
          const matches = starts.filter(item => item?.agentPath === member.taskName || item?.taskName === member.taskName);
          if (matches.length !== 1) throw new Error("NATIVE_TASK_NAME_NOT_UNIQUELY_RESOLVED");
          const activity = matches[0];
          const expected = member.role === "collector" ? run.collectorPolicy : run.workerPolicy;
          if (!UUID.test(activity.agentThreadId) || !text(activity.id) || activity.model !== expected.model || activity.reasoningEffort !== expected.effort) throw new Error("NATIVE_DISPATCH_RECEIPT_MISMATCH");
          const native = await snapshot(client, activity.agentThreadId);
          const permittedInitialStatus = member.role === "collector" ? native.turn?.status === "inProgress" : ["inProgress", "completed", "failed", "interrupted"].includes(native.turn?.status);
          if (native.thread.parentThreadId !== run.parentThreadId || native.thread.sessionId !== run.parentSessionId || native.thread.canAcceptDirectInput !== false || !native.turn || !UUID.test(native.turn.id) || !permittedInitialStatus || native.extraTurn || native.turn.itemsView !== "full") throw new Error("NATIVE_INITIAL_TURN_UNRESOLVED");
          return { role: member.role, taskName: member.taskName, ...(member.role === "collector" ? { targets: [...member.targets] } : {}), threadId: activity.agentThreadId, turnId: native.turn.id, model: activity.model, effort: activity.reasoningEffort, dispatchItemId: activity.id };
        }));
        const observedIds = starts.map(item => item.agentThreadId).sort();
        if (new Set(observedIds).size !== observedIds.length || canonical(observedIds) !== canonical(resolved.map(member => member.threadId).sort())) throw new Error("NATIVE_DISPATCH_MEMBERSHIP_NOT_CLOSED");
        const collector = resolved.find(member => member.role === "collector")!;
        const workerIds = resolved.filter(member => member.role === "worker").map(member => member.threadId);
        const immutableArgs = structuredClone(args);
        const immutable = { run, arguments: immutableArgs, members: resolved, registrationCallId: request.callId };
        const fingerprint = sha256(canonical(immutable));
        registration = { run, arguments: immutableArgs, members: resolved, fingerprint, registrationCallId: request.callId, registeredAt: new Date().toISOString(), progress: new Map([[collector.threadId, { ...CODEX_COLLECTOR_INITIAL_PROGRESS }]]), queryFailures: new Map([[collector.threadId, 0]]), stopCount: new Map(), ended: new Set() };
        return { status: "registered", batchId: run.batchId, attemptId: run.attemptId, collectorThreadId: collector.threadId, workerThreadIds: workerIds, fingerprint };
      },
    });
    unregs.push(registrationOff);
    const controlOff = await tools.registerDynamicTool({
      name: CONTROL_TOOL,
      description: "Parent-only bounded batch control. Signals pause, cancellation, budget or safety exit; it cannot change membership.",
      inputSchema: { type: "object", additionalProperties: false, required: ["batchId", "attemptId", "exception"], properties: { batchId: { type: "string" }, attemptId: { type: "string" }, exception: { enum: ["budget-exhausted", "paused", "user-cancelled", "safety", "permission"] } } },
      handler: async request => {
        const args = request.arguments as any;
        if (closed || request.threadId !== run.parentThreadId || !text(request.callId) || !registration || args?.batchId !== run.batchId || args?.attemptId !== run.attemptId || !["budget-exhausted", "paused", "user-cancelled", "safety", "permission"].includes(args?.exception)) throw new Error("NATIVE_CONTROL_REQUEST_REFUSED");
        if (registration.ended.size) throw new Error("NATIVE_BATCH_ALREADY_ENDED");
        // Store only in memory. Recovery must revalidate this parent tool call from native history.
        (registration as any).exception = args.exception;
        return { status: "accepted", batchId: run.batchId, attemptId: run.attemptId };
      },
    });
    unregs.push(controlOff);
  } catch (error) {
    for (const off of unregs.splice(0)) { try { off(); } catch { /* best effort unregister */ } }
    return { capability: "unavailable", reasonCode: error instanceof Error ? error.message : "CODEX_NATIVE_CAPABILITY_UNAVAILABLE", handleSubagentStop: async () => unavailable("CODEX_STOP_CAPABILITY_UNAVAILABLE"), close: async () => undefined };
  }

  const handleSubagentStop: (input: { readonly payload: unknown; readonly now?: string }) => Promise<{ readonly matched: boolean; readonly decision: "allow" | "block"; readonly reasonCode?: string; readonly reason?: string }> = async ({ payload, now = new Date().toISOString() }) => {
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const agentId = body.agent_id;
    const turnId = body.turn_id;
    const sessionId = body.session_id;
    if (!registration || typeof agentId !== "string") {
      if (pendingCollectorThreadId !== agentId || sessionId !== run.parentSessionId || !text(turnId)) return unavailable("CODEX_STOP_CAPABILITY_UNAVAILABLE");
      const key = `${agentId}:${turnId}`;
      const count = (pendingStopCount.get(key) ?? 0) + 1;
      pendingStopCount.set(key, count);
      if (String(body.last_assistant_message ?? "") === canonical(pendingFinal)) {
        pendingCollectorThreadId = null;
        return { matched: true as const, decision: "allow" as const, reasonCode: "CODEX_STOP_REGISTERED_ERROR_FINAL" };
      }
      if (count >= 4) {
        pendingCollectorThreadId = null;
        return { matched: true as const, decision: "allow" as const, reasonCode: "CODEX_STOP_REGISTERED_ERROR_FORMAT_LIMIT" };
      }
      return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_REGISTERED_ERROR", reason: `The parent registration was observed, but native binding could not be completed. End with this exact exception JSON: ${canonical(pendingFinal)}` };
    }
    const member = registration.members.find(item => item.threadId === agentId);
    if (!member || member.role !== "collector") return { matched: false as const, decision: "allow" as const };
    if (sessionId !== run.parentSessionId || !text(turnId)) return unavailable("CODEX_STOP_NATIVE_IDENTITY_MISMATCH");
    if (registration.ended.has(agentId)) return { matched: true as const, decision: "allow" as const, reasonCode: "CODEX_STOP_ALREADY_ENDED" };
    const stopKey = `${agentId}:${turnId}`;
    const count = (registration.stopCount.get(stopKey) ?? 0) + 1;
    registration.stopCount.set(stopKey, count);
    const existingStage = staged.get(stopKey);
    if (existingStage) {
      if (String(body.last_assistant_message ?? "") === canonical(existingStage.final)) {
        const released = await releaseBatchChildren(client, registration, root);
        if (!released) return unavailable("CODEX_STOP_NATIVE_RELEASE_UNVERIFIED");
        registration.ended.add(agentId);
        return { matched: true as const, decision: "allow" as const, reasonCode: "CODEX_STOP_NATIVE_FINAL_VERIFIED" };
      }
      existingStage.formatRequests++;
      if (existingStage.formatRequests >= 4) {
        registration.ended.add(agentId);
        return { matched: true as const, decision: "allow" as const, reasonCode: "CODEX_STOP_EXCEPTION_FORMAT_LIMIT" };
      }
      return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_RAW_FINAL_REQUIRED", reason: `Return this exact JSON object as your final response, without code fences or extra text: ${canonical(existingStage.final)}` };
    }
    if (count > 8) {
      const facts: CollectorFact[] = (member.targets ?? []).map(taskName => {
        const worker = registration!.members.find(candidate => candidate.taskName === taskName && candidate.role === "worker")!;
        return { agentId: worker.threadId, hostState: "continuation-limit", finalityKind: "unknown", evidenceRef: null, rawResult: null };
      });
      const final: CollectorFinal = { exception: "script-error", facts };
      staged.set(stopKey, { final, formatRequests: 0 });
      return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_EXCEPTION_CONTINUATION_LIMIT", reason: `The native continuation bound was reached. Return this bounded exception object exactly: ${canonical(final)}` };
    }
    let exception: CollectorException | null = (registration as any).exception ?? null;
    try {
      const registrationHistory = await parentItems(client, run.parentThreadId);
      const confirmations = registrationHistory.filter(item => item?.type === "dynamicToolCall" && item?.tool === REGISTRATION_TOOL && item?.id === registration!.registrationCallId);
      if (confirmations.length !== 1 || confirmations[0].status !== "completed" || confirmations[0].success !== true || canonical(confirmations[0].arguments) !== canonical(registration.arguments)) throw new Error("NATIVE_PARENT_REGISTRATION_NOT_CONFIRMED");
      const receiptText = (confirmations[0].contentItems ?? []).filter((item: any) => item?.type === "inputText").map((item: any) => item.text).join("");
      const receipt = JSON.parse(receiptText);
      if (receipt?.status !== "registered" || receipt?.fingerprint !== registration.fingerprint || receipt?.attemptId !== run.attemptId) throw new Error("NATIVE_PARENT_REGISTRATION_RECEIPT_MISMATCH");
      const [parent, collectorSnap, loaded, history] = await Promise.all([
        snapshot(client, run.parentThreadId), snapshot(client, agentId), loadedThreadIds(client), parentItems(client, run.parentThreadId),
      ]);
      if (parent.thread.sessionId !== run.parentSessionId || !["active", "idle"].includes(parent.thread.status?.type) ||
          collectorSnap.thread.parentThreadId !== run.parentThreadId || collectorSnap.thread.sessionId !== run.parentSessionId ||
          collectorSnap.turn?.id !== turnId || collectorSnap.turn?.status !== "inProgress" || collectorSnap.turn?.itemsView !== "full" || collectorSnap.extraTurn) throw new Error("NATIVE_COLLECTOR_LIFECYCLE_MISMATCH");
      const interaction = history.some(item => item?.type === "subAgentActivity" && item?.kind === "interacted" && item?.agentThreadId === agentId);
      if (interaction) throw new Error("NATIVE_COLLECTOR_PARENT_FOLLOWUP");
      if (!loaded.has(agentId)) throw new Error("NATIVE_COLLECTOR_NOT_LOADED");
      const facts = await Promise.all((member.targets ?? []).map(async taskName => {
        const worker = registration!.members.find(candidate => candidate.taskName === taskName && candidate.role === "worker");
        if (!worker) throw new Error("NATIVE_WORKER_BINDING_MISSING");
        const [snap, currentLoaded, parentHistory] = await Promise.all([snapshot(client, worker.threadId), loadedThreadIds(client), parentItems(client, run.parentThreadId)]);
        if (snap.thread.parentThreadId !== run.parentThreadId || snap.thread.sessionId !== run.parentSessionId || snap.thread.canAcceptDirectInput !== false || !snap.turn || snap.turn.id !== worker.turnId || snap.extraTurn || snap.turn.itemsView !== "full") throw new Error("NATIVE_WORKER_PINNED_TURN_MISMATCH");
        const finalMessages = (snap.turn.items ?? []).filter((item: any) => item?.type === "agentMessage" && item?.phase === "final_answer");
        const isLoaded = currentLoaded.has(worker.threadId);
        let finalityKind: CollectorFact["finalityKind"] = "unknown";
        if (isLoaded && snap.thread.status?.type === "idle" && snap.turn.status === "completed" && finalMessages.length) finalityKind = "completed";
        else if (isLoaded && snap.thread.status?.type === "idle" && snap.turn.status === "failed") finalityKind = "failed";
        else if (isLoaded && snap.thread.status?.type === "idle" && snap.turn.status === "interrupted" && parentHistory.some((item: any) => item?.type === "subAgentActivity" && item?.kind === "interrupted" && item?.agentThreadId === worker.threadId)) finalityKind = "cancelled_confirmed";
        else if (isLoaded && ["active", "idle"].includes(snap.thread.status?.type) && snap.turn.status === "inProgress") finalityKind = "pending";
        let rawResult: unknown = { turnId: snap.turn.id, status: snap.turn.status, error: snap.turn.error ?? null };
        if (["completed", "failed", "cancelled_confirmed"].includes(finalityKind)) {
          const exact = Buffer.from(canonical({ threadId: worker.threadId, turnId: snap.turn.id, status: snap.turn.status, error: snap.turn.error ?? null, finalMessages }));
          const digest = sha256(exact);
          const resultDirectory = join(root, "native-results");
          await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
          const resultDirectoryStat = await lstat(resultDirectory);
          if (resultDirectoryStat.isSymbolicLink() || !resultDirectoryStat.isDirectory() || (resultDirectoryStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && resultDirectoryStat.uid !== process.getuid())) throw new Error("NATIVE_RESULT_DIRECTORY_NOT_PRIVATE");
          const artifact = join(resultDirectory, `${digest}.json`);
          try {
            const handle = await open(artifact, "wx", 0o400);
            try { await handle.writeFile(exact); await handle.sync(); } finally { await handle.close(); }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(artifact)).equals(exact)) throw error;
          }
          rawResult = { turnId: snap.turn.id, status: snap.turn.status, error: snap.turn.error ?? null, nativeFinalItemIds: finalMessages.map((item: any) => item.id), artifactRef: artifact, sha256: digest, bytes: exact.byteLength };
        }
        return { agentId: worker.threadId, hostState: `${snap.thread.status?.type}/${snap.turn.status}`, finalityKind, evidenceRef: ["completed", "failed", "cancelled_confirmed"].includes(finalityKind) ? `native-thread:${worker.threadId}#turn:${snap.turn.id}` : null, rawResult } satisfies CollectorFact;
      }));
      registration.queryFailures.set(agentId, 0);
      const observedAt = new Date().toISOString();
      const obs: CollectorObservation = { batchId: run.batchId, attemptId: run.attemptId, sequence: registration.progress.get(agentId)!.lastSequence + 1, observedAt, facts, consecutiveQueryFailures: 0, exception };
      const identity: CollectorIdentity = { role: "collector", batchId: run.batchId, agentId, attemptId: run.attemptId, parentSessionId: run.parentSessionId };
      const contract: CollectorContract = { collector: identity, targetAgentIds: facts.map(fact => fact.agentId), startedAt: run.startedAt, deadline: run.deadline, queryIntervalMs: run.queryIntervalMs, maxConsecutiveQueryFailures: run.maxConsecutiveQueryFailures };
      const decision = evaluateCodexCollectorStop({ contract, identity, observation: obs, collectorStatus: "live", now, progress: registration.progress.get(agentId)! });
      if (decision.decision === "block") {
        registration.progress.set(agentId, decision.progress);
        const delay = Math.max(0, Math.min(run.queryIntervalMs, Date.parse(decision.waitUntil!) - Date.parse(now)));
        if (Date.now() + delay >= Date.parse(run.deadline)) {
          const expired: CollectorFinal = { exception: "deadline", facts };
          staged.set(stopKey, { final: expired, formatRequests: 0 });
          return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_RAW_FINAL_REQUIRED", reason: `Collection deadline reached. Return this exact JSON object as your final response, without code fences or extra text: ${canonical(expired)}` };
        }
        await wait(delay);
        // Requery inside the same native hook callback and same collector turn. The bounded
        // sleep is host-side; no model-produced command, replacement agent, or parent poll.
        return await handleSubagentStop({ payload, now: new Date().toISOString() });
      }
      if (!decision.final) throw new Error("NATIVE_EVALUATOR_MISSING_FINAL");
      const compact: CollectorFinal = { exception: decision.final.exception, facts: decision.final.facts.map(fact => ({ agentId: fact.agentId, hostState: fact.hostState, finalityKind: fact.finalityKind, evidenceRef: fact.evidenceRef, rawResult: fact.rawResult })) };
      staged.set(stopKey, { final: compact, formatRequests: 0 });
      return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_RAW_FINAL_REQUIRED", reason: `Return this exact JSON object as your final response, without code fences or extra text: ${canonical(compact)}` };
    } catch (error) {
      const reasonCode = error instanceof Error ? error.message : "CODEX_NATIVE_QUERY_FAILED";
      const failureAt = Date.parse(now);
      const consecutiveFailures = (registration.queryFailures.get(agentId) ?? 0) + 1;
      registration.queryFailures.set(agentId, consecutiveFailures);
      const ended = !Number.isFinite(failureAt) || failureAt >= Date.parse(run.deadline) || count >= 8 || consecutiveFailures >= run.maxConsecutiveQueryFailures;
      const facts: CollectorFact[] = (member.targets ?? []).map(taskName => {
        const worker = registration!.members.find(candidate => candidate.taskName === taskName && candidate.role === "worker")!;
        return { agentId: worker.threadId, hostState: `query-error/${reasonCode}`, finalityKind: "unknown", evidenceRef: null, rawResult: { error: reasonCode } };
      });
      if (ended) {
        const final: CollectorFinal = { exception: "script-error", facts };
        staged.set(stopKey, { final, formatRequests: 0 });
        return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_RAW_FINAL_REQUIRED", reason: `Native state could not be verified; no worker was treated as complete. End with this bounded exception object exactly: ${canonical(final)}` };
      }
      const delay = Math.max(0, Math.min(run.queryIntervalMs, Date.parse(run.deadline) - failureAt));
      if (delay <= 0) {
        const final: CollectorFinal = { exception: "deadline", facts };
        staged.set(stopKey, { final, formatRequests: 0 });
        return { matched: true as const, decision: "block" as const, reasonCode: "CODEX_STOP_RAW_FINAL_REQUIRED", reason: `Native state could not be verified (${reasonCode}) before the deadline. Return this bounded exception object exactly: ${canonical(final)}` };
      }
      await wait(delay);
      return await handleSubagentStop({ payload, now: new Date().toISOString() });
    }
  };

  return {
    capability: "ready",
    reasonCode: "CODEX_NATIVE_CONTROLLER_READY",
    handleSubagentStop,
    close: async () => { if (closed) return; closed = true; for (const off of unregs.splice(0)) { try { off(); } catch { /* native host may already have closed */ } } },
  };
}

type CollectorFinal = { readonly exception: CollectorException | null; readonly facts: readonly CollectorFact[] };

async function releaseBatchChildren(client: CodexNativeClient, registration: NativeRegistration, _root: string): Promise<boolean> {
  try {
    // Keep evidence in the native result references before archiving terminal children.
    for (const member of registration.members) {
      if (member.role !== "worker") continue;
      const before = await snapshot(client, member.threadId);
      if (before.thread.parentThreadId !== registration.run.parentThreadId || before.thread.sessionId !== registration.run.parentSessionId || before.turn?.id !== member.turnId || before.extraTurn || before.turn?.itemsView !== "full" || !["completed", "failed", "interrupted"].includes(before.turn?.status)) return false;
      await client.call("thread/archive", { threadId: member.threadId });
    }
    const loaded = await loadedThreadIds(client);
    return registration.members.filter(member => member.role === "worker").every(member => !loaded.has(member.threadId));
  } catch {
    return false;
  }
}

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
  if (input.nativeController?.capability === "ready") return input.nativeController.handleSubagentStop({ payload: input.payload, now: input.now });
  const payload = input.payload !== null && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {};
  const marker = payload.last_assistant_message;
  if (typeof marker !== "string" || !marker.startsWith(CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX)) return { matched: false, decision: "allow" };
  return { matched: false, decision: "allow", reasonCode: CODEX_SUBAGENT_STOP_CAPABILITY.reasonCode };
}
