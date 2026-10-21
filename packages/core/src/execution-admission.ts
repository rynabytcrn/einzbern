// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, join } from "node:path";
import { parseStrictInstant } from "../../protocol/src/index.js";
import { deviceHome } from "./device-home.js";
import { readEngineModelPolicyFile, resolveEngineExecutionPolicyFromSnapshot, validateEngineModelPolicyFile } from "./engine-model-policy.js";
import type { EngineExecutionPolicyResolution, EngineModelPolicyFile } from "./engine-model-policy.js";
import { evaluateExecutionQuota, ExecutionPolicyError, resolveExecutionConcurrency } from "./execution-policy.js";
import { MACHINE_SETTINGS_CATALOG, MACHINE_SETTINGS_FILE_NAME, readMachineSettings, validateMachineSettingsFile } from "./machine-settings.js";
import type { MachineSettingsFile } from "./machine-settings.js";

/** Admission is a point-in-time handoff decision, not a scheduler or a reservation. */
const EXECUTION_ADMISSION_MAX_USAGE_AGE_MS = 300_000;
export interface ExecutionAdmissionRequest {
  readonly host: string;
  readonly category: string;
  readonly rejections: number;
  readonly requestedAgents: number;
  readonly availableCombinations?: readonly { readonly runner: string; readonly model: string; readonly effort: string }[];
  readonly usage?: { readonly observedAt: string; readonly source: string; readonly fiveHourUsedPercent?: number; readonly weeklyUsedPercent?: number };
  readonly expectedPolicy?: { readonly revision: number; readonly digest: string };
}
export interface ExecutionAdmissionOptions {
  /** Absolute device directory, not the user's home directory. */
  readonly home?: string;
  readonly projectLimit?: number;
  readonly now?: string;
}
export interface ExecutionAdmissionSnapshot {
  readonly home: string;
  readonly enginePolicy: EngineModelPolicyFile;
  readonly machineSettings: MachineSettingsFile;
}
export interface ExecutionAdmission {
  readonly schemaVersion: "tcrn.execution-admission.v1";
  readonly status: "admitted" | "refused";
  readonly reasons: readonly string[];
  readonly request: Pick<ExecutionAdmissionRequest, "host" | "category" | "rejections" | "requestedAgents">;
  readonly selection: EngineExecutionPolicyResolution | null;
  readonly policy: { readonly host: string; readonly revision: number; readonly storeRevision: number; readonly digest: string } | null;
  readonly capabilities: { readonly status: "missing" | "unsupported" | "caller-reported-match"; readonly verification: "caller-reported-not-native-verified" };
  readonly quota: {
    readonly status: "not-configured" | "missing" | "stale" | "fresh" | "policy-unavailable";
    readonly decision: "not-configured" | "unknown" | "parallel" | "serial" | "wait";
    readonly observedAt: string | null;
    readonly source: string | null;
    /** Caller-reported percentages only. Null is unobserved, never inferred zero. */
    readonly fiveHourUsedPercent: number | null;
    readonly weeklyUsedPercent: number | null;
    readonly ageMs: number | null;
    readonly maxAgeMs: number;
    readonly verification: "caller-reported-not-account-verified";
    readonly unknownWindows: readonly ("five-hour" | "weekly")[];
  };
  readonly concurrency: ReturnType<typeof resolveExecutionConcurrency> & { readonly admissionLimit: number };
  readonly evaluatedAt: string;
}
function invalid(path: string, requirement: string): never {
  throw new ExecutionPolicyError(`${path} ${requirement}`, { path });
}
function object(value: unknown, path: string, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  for (const key of Object.keys(value as object)) if (!keys.includes(key)) invalid(`${path}.${key}`, "is not supported");
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(path, "must be a nonempty string");
}
function integer(value: unknown, path: string, min: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(path, `must be a safe integer of at least ${min}`);
}
function instant(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !value.endsWith("Z")) invalid(path, "must be a strict UTC instant");
  try { return parseStrictInstant(value); } catch { return invalid(path, "must be a strict UTC instant"); }
}

/** One read of each validated device file, not a transaction across the two files. */
export async function readExecutionAdmissionSnapshot(home: string = deviceHome()): Promise<ExecutionAdmissionSnapshot> {
  if (typeof home !== "string" || !isAbsolute(home)) invalid("home", "must be an absolute device directory");
  const [enginePolicy, machineSettings] = await Promise.all([
    readEngineModelPolicyFile(home), readMachineSettings(join(home, MACHINE_SETTINGS_FILE_NAME)),
  ]);
  return Object.freeze({ home, enginePolicy, machineSettings });
}

/** No account reads, native calls, writes, fallback tuples, or implied support verification. */
export async function resolveExecutionAdmission(request: ExecutionAdmissionRequest, options: ExecutionAdmissionOptions = {}): Promise<ExecutionAdmission> {
  object(options, "options", ["home", "projectLimit", "now"]);
  const snapshot = await readExecutionAdmissionSnapshot(options.home);
  return resolveExecutionAdmissionFromSnapshot(snapshot, request, {
    ...(options.projectLimit === undefined ? {} : { projectLimit: options.projectLimit }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Pure admission from captured, validated inputs; never rereads policy or device settings. */
export function resolveExecutionAdmissionFromSnapshot(snapshotValue: ExecutionAdmissionSnapshot, request: ExecutionAdmissionRequest, options: Omit<ExecutionAdmissionOptions, "home"> = {}): ExecutionAdmission {
  object(request, "request", ["host", "category", "rejections", "requestedAgents", "availableCombinations", "usage", "expectedPolicy"]);
  text(request.host, "host");
  if (request.host === "chatgpt-dot" || request.host === "dot-autonomous") invalid("host", "requires the independent dot mode entry, not a process host policy");
  text(request.category, "category");
  integer(request.rejections, "rejections", 0);
  integer(request.requestedAgents, "requestedAgents", 1);
  object(options, "options", ["projectLimit", "now"]);
  const evaluatedAt = options.now ?? new Date().toISOString();
  const nowNs = instant(evaluatedAt, "now");
  if (request.availableCombinations !== undefined) {
    if (!Array.isArray(request.availableCombinations)) invalid("availableCombinations", "must be an array");
    for (const tuple of request.availableCombinations) {
      object(tuple, "availableCombinations[]", ["runner", "model", "effort"]);
      for (const key of ["runner", "model", "effort"] as const) text(tuple[key], `availableCombinations[].${key}`);
    }
  }
  if (request.expectedPolicy !== undefined) {
    object(request.expectedPolicy, "expectedPolicy", ["revision", "digest"]);
    integer(request.expectedPolicy.revision, "expectedPolicy.revision", 1);
    if (typeof request.expectedPolicy.digest !== "string" || !/^[a-f0-9]{64}$/u.test(request.expectedPolicy.digest)) invalid("expectedPolicy.digest", "must be a SHA-256 digest");
  }
  let ageMs: number | null = null;
  if (request.usage !== undefined) {
    object(request.usage, "usage", ["observedAt", "source", "fiveHourUsedPercent", "weeklyUsedPercent"]);
    text(request.usage.source, "usage.source");
    const ageNs = nowNs - instant(request.usage.observedAt, "usage.observedAt");
    ageMs = Number(ageNs) / 1_000_000;
    if (ageNs < 0n) invalid("usage.observedAt", "must not be in the future");
    for (const key of ["fiveHourUsedPercent", "weeklyUsedPercent"] as const) {
      const value = request.usage[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) invalid(`usage.${key}`, "must be a percentage from 0 to 100");
    }
  }
  object(snapshotValue, "snapshot", ["home", "enginePolicy", "machineSettings"]);
  const home = snapshotValue.home;
  if (typeof home !== "string" || !isAbsolute(home)) invalid("snapshot.home", "must be an absolute device directory");
  const machine = validateMachineSettingsFile(snapshotValue.machineSettings);
  const deviceLimit = Number(machine.values["execution.maxConcurrentAgents"] ?? MACHINE_SETTINGS_CATALOG.find(entry => entry.key === "execution.maxConcurrentAgents")!.defaultValue);
  const concurrency = resolveExecutionConcurrency(deviceLimit, options.projectLimit);
  const reasons: string[] = [];
  let selection: EngineExecutionPolicyResolution | null = null;
  const snapshot = validateEngineModelPolicyFile(snapshotValue.enginePolicy);
  const hostPolicy = Object.hasOwn(snapshot.hosts, request.host) ? snapshot.hosts[request.host] : undefined;
  const policy = hostPolicy === undefined ? null : { host: request.host, revision: hostPolicy.revision, storeRevision: snapshot.revision, digest: hostPolicy.digest };
  try {
    selection = resolveEngineExecutionPolicyFromSnapshot(snapshot, { home, host: request.host, category: request.category, rejections: request.rejections });
  } catch (error) {
    const code = (error as { readonly reasonCode?: string }).reasonCode;
    if (code !== "ENGINE_MODEL_POLICY_UNAVAILABLE" && code !== "MODELS_CATEGORY_UNKNOWN" && code !== "MODELS_CATEGORY_EMPTY") throw error;
    reasons.push(code);
  }
  const supported = selection !== null && request.availableCombinations?.some(tuple => tuple.runner === selection.record.runner && tuple.model === selection.record.model && tuple.effort === selection.record.effort) === true;
  const capabilityStatus = request.availableCombinations === undefined ? "missing" : supported ? "caller-reported-match" : "unsupported";
  if (!supported) reasons.push(capabilityStatus === "missing" ? "EXECUTION_CAPABILITIES_MISSING" : "EXECUTION_COMBINATION_UNSUPPORTED");
  if (policy !== null && request.expectedPolicy !== undefined && (request.expectedPolicy.revision !== policy.revision || request.expectedPolicy.digest !== policy.digest)) reasons.push("EXECUTION_POLICY_STALE");
  let quotaStatus: ExecutionAdmission["quota"]["status"] = "policy-unavailable";
  let decision: ExecutionAdmission["quota"]["decision"] = "unknown";
  let unknownWindows: readonly ("five-hour" | "weekly")[] = [];
  if (selection !== null) {
    if (selection.quotaOrigin === "engine-default") {
      quotaStatus = "not-configured";
      decision = "not-configured";
    } else if (request.usage === undefined) {
      quotaStatus = "missing";
      unknownWindows = ["five-hour", "weekly"];
      reasons.push("EXECUTION_USAGE_MISSING");
    } else if (ageMs! > EXECUTION_ADMISSION_MAX_USAGE_AGE_MS) {
      quotaStatus = "stale";
      reasons.push("EXECUTION_USAGE_STALE");
    } else {
      quotaStatus = "fresh";
      const result = evaluateExecutionQuota(selection.quota, {
        ...(request.usage.fiveHourUsedPercent === undefined ? {} : { fiveHourUsedPercent: request.usage.fiveHourUsedPercent }),
        ...(request.usage.weeklyUsedPercent === undefined ? {} : { weeklyUsedPercent: request.usage.weeklyUsedPercent }),
      });
      decision = result.decision;
      unknownWindows = result.unknownWindows;
      if (unknownWindows.length > 0) reasons.push("EXECUTION_USAGE_INCOMPLETE");
      if (decision === "wait") reasons.push("EXECUTION_QUOTA_WAIT");
    }
  }
  const admissionLimit = decision === "serial" ? 1 : concurrency.effectiveLimit;
  if (request.requestedAgents > admissionLimit) reasons.push("EXECUTION_CONCURRENCY_EXCEEDED");
  const result: ExecutionAdmission = {
    schemaVersion: "tcrn.execution-admission.v1", status: reasons.length === 0 ? "admitted" : "refused", reasons: Object.freeze(reasons),
    request: { host: request.host, category: request.category, rejections: request.rejections, requestedAgents: request.requestedAgents },
    selection, policy, capabilities: { status: capabilityStatus, verification: "caller-reported-not-native-verified" },
    quota: { status: quotaStatus, decision, observedAt: request.usage?.observedAt ?? null, source: request.usage?.source ?? null, ageMs,
      fiveHourUsedPercent: request.usage?.fiveHourUsedPercent ?? null, weeklyUsedPercent: request.usage?.weeklyUsedPercent ?? null,
      maxAgeMs: EXECUTION_ADMISSION_MAX_USAGE_AGE_MS, verification: "caller-reported-not-account-verified", unknownWindows },
    concurrency: { ...concurrency, admissionLimit }, evaluatedAt,
  };
  return Object.freeze(result);
}

/** Explicit native branch. The process request/parser and host policy remain unchanged. */
export { resolveDotExecutionAdmission, validateDotExecutionRequest } from "./dot-execution.js";
export type { DotExecutionRequest, DotAdmission } from "./dot-execution.js";
