// SPDX-License-Identifier: Apache-2.0

/** Threshold configuration only. Account usage is caller-supplied observation, never stored here. */
export interface EngineQuotaPolicy {
  readonly fiveHourParallelOffPercent: number;
  readonly fiveHourWaitPercent: number;
  readonly weeklyParallelOffPercent: number;
  readonly weeklyWaitPercent: number | null;
}

export const DEFAULT_ENGINE_QUOTA_POLICY: EngineQuotaPolicy = Object.freeze({
  fiveHourParallelOffPercent: 75,
  fiveHourWaitPercent: 90,
  weeklyParallelOffPercent: 95,
  weeklyWaitPercent: null,
});

export class ExecutionPolicyError extends Error {
  readonly reasonCode = "EXECUTION_POLICY_INVALID" as const;
  constructor(message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

function invalid(path: string, requirement: string): never {
  throw new ExecutionPolicyError(`${path} ${requirement}`, { path });
}

export function validateEngineQuotaPolicy(value: unknown): EngineQuotaPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("quota", "must be an object");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_ENGINE_QUOTA_POLICY).sort();
  if (Object.keys(input).sort().join(",") !== keys.join(",")) invalid("quota", `requires exactly ${keys.join(", ")}`);
  for (const key of keys) {
    if (key === "weeklyWaitPercent" && input[key] === null) continue;
    if (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || Number(input[key]) < 1 || Number(input[key]) > 100) invalid(`quota.${key}`, "must be an integer from 1 to 100");
  }
  if (Number(input.fiveHourParallelOffPercent) > Number(input.fiveHourWaitPercent)) invalid("quota.fiveHourWaitPercent", "must not be below the parallel-off threshold");
  if (input.weeklyWaitPercent !== null && Number(input.weeklyParallelOffPercent) > Number(input.weeklyWaitPercent)) invalid("quota.weeklyWaitPercent", "must not be below the parallel-off threshold");
  return Object.freeze({
    fiveHourParallelOffPercent: input.fiveHourParallelOffPercent as number,
    fiveHourWaitPercent: input.fiveHourWaitPercent as number,
    weeklyParallelOffPercent: input.weeklyParallelOffPercent as number,
    weeklyWaitPercent: input.weeklyWaitPercent as number | null,
  });
}

/** A project's requested concurrency may only tighten the device cap, never raise it. */
export function resolveExecutionConcurrency(deviceLimit: number, projectLimit?: number): {
  readonly deviceLimit: number;
  readonly projectLimit: number | null;
  readonly effectiveLimit: number;
  readonly origin: "device" | "project-budget";
} {
  for (const [path, value] of [["deviceLimit", deviceLimit], ["projectLimit", projectLimit]] as const) {
    if (path === "projectLimit" && value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(path, "must be a positive safe integer");
  }
  return Object.freeze({
    deviceLimit,
    projectLimit: projectLimit ?? null,
    effectiveLimit: Math.min(deviceLimit, projectLimit ?? deviceLimit),
    origin: projectLimit !== undefined && projectLimit < deviceLimit ? "project-budget" : "device",
  });
}

export interface QuotaUsageObservation {
  readonly fiveHourUsedPercent?: number;
  readonly weeklyUsedPercent?: number;
}

/**
 * A pure advisory decision from explicitly supplied observations. Missing windows are unknown,
 * not zero; this API does not claim account access, observation freshness or actual dispatch.
 */
export function evaluateExecutionQuota(policyValue: EngineQuotaPolicy, observation: QuotaUsageObservation): {
  readonly decision: "parallel" | "serial" | "wait" | "unknown";
  readonly unknownWindows: readonly ("five-hour" | "weekly")[];
} {
  const policy = validateEngineQuotaPolicy(policyValue);
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) invalid("observation", "must be an object of usage windows");
  for (const [key, value] of Object.entries(observation)) {
    if (key !== "fiveHourUsedPercent" && key !== "weeklyUsedPercent") invalid(`observation.${key}`, "is not a supported usage window");
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) invalid(`observation.${key}`, "must be a percentage from 0 to 100");
  }
  const five = observation.fiveHourUsedPercent;
  const weekly = observation.weeklyUsedPercent;
  const unknownWindows: ("five-hour" | "weekly")[] = [];
  if (five === undefined) unknownWindows.push("five-hour");
  if (weekly === undefined) unknownWindows.push("weekly");
  const waits = (five !== undefined && five >= policy.fiveHourWaitPercent)
    || (weekly !== undefined && policy.weeklyWaitPercent !== null && weekly >= policy.weeklyWaitPercent);
  const serial = (five !== undefined && five >= policy.fiveHourParallelOffPercent)
    || (weekly !== undefined && weekly >= policy.weeklyParallelOffPercent);
  return Object.freeze({ decision: waits ? "wait" : serial ? "serial" : unknownWindows.length > 0 ? "unknown" : "parallel", unknownWindows: Object.freeze(unknownWindows) });
}

/** Native occupancy is separate from account quota; unknown counts never create free slots. */
export function resolveNativeExecutionConcurrency(deviceLimit: number, projectLimit: number | undefined, platformLimit: number | null, activeAgents: number | null, includesParent: boolean, parentActive: boolean): {
  readonly deviceLimit: number; readonly projectLimit: number | null; readonly platformLimit: number | null;
  readonly effectiveLimit: number | null; readonly occupiedSlots: number | null; readonly availableSlots: number | null; readonly reservation: "none";
} {
  const base = resolveExecutionConcurrency(deviceLimit, projectLimit);
  if (platformLimit !== null && (!Number.isSafeInteger(platformLimit) || platformLimit < 1)) invalid("platformLimit", "must be positive or unknown");
  if (activeAgents !== null && (!Number.isSafeInteger(activeAgents) || activeAgents < 0)) invalid("activeAgents", "must be nonnegative or unknown");
  if (activeAgents !== null && includesParent && parentActive && activeAgents < 1) invalid("activeAgents", "cannot omit an included active parent");
  const effectiveLimit = platformLimit === null ? null : Math.min(base.effectiveLimit, platformLimit);
  const occupiedSlots = activeAgents === null ? null : activeAgents + (!includesParent && parentActive ? 1 : 0);
  return { deviceLimit, projectLimit: base.projectLimit, platformLimit, effectiveLimit, occupiedSlots, availableSlots: effectiveLimit === null || occupiedSlots === null ? null : Math.max(0, effectiveLimit - occupiedSlots), reservation: "none" };
}
