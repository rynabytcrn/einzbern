// SPDX-License-Identifier: Apache-2.0

/** This is an application contract, NOT a Codex RPC or an authentication adapter. */
export const CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX = "EINZBERN_SUBAGENT_STOP_V1 " as const;
export const CODEX_SUBAGENT_STOP_CAPABILITY = Object.freeze({
  state: "unverified" as const,
  reasonCode: "CODEX_STOP_CAPABILITY_UNAVAILABLE",
  missing: ["parent-observed dispatch binding", "fresh same-host fixed-member query", "bounded same-live-collector wait", "native final return and release observation"],
});

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
  const waitUntil = new Date(Math.min(observed + contract.queryIntervalMs, deadline)).toISOString();
  return {
    decision: "block", reasonCode: "CODEX_STOP_BOUNDED_WAIT", outcome: "waiting", waitUntil,
    progress: { lastSequence: observation.sequence, lastObservedAt: observation.observedAt, nextQueryAt: waitUntil, ended: false },
  };
}

/**
 * Codex hook entry. No supported, verified same-host binding/query/wait adapter is wired
 * into this release. In particular last_assistant_message is worker-authored text and
 * must NEVER enroll a collector or cause a block. Leave the native final result intact.
 * Capability-unavailable is not completion and does not authorize dispatch without a collector.
 */
export async function handleCodexSubagentStop(input: {
  readonly payload: unknown;
  readonly deviceHome: string;
  readonly now?: string;
}): Promise<{ readonly matched: false; readonly decision: "allow"; readonly reasonCode?: string }> {
  const payload = input.payload !== null && typeof input.payload === "object" ? input.payload as Record<string, unknown> : {};
  const marker = payload.last_assistant_message;
  if (typeof marker !== "string" || !marker.startsWith(CODEX_SUBAGENT_STOP_ENVELOPE_PREFIX)) return { matched: false, decision: "allow" };
  return { matched: false, decision: "allow", reasonCode: CODEX_SUBAGENT_STOP_CAPABILITY.reasonCode };
}
