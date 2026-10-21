// SPDX-License-Identifier: Apache-2.0
/** Tool contracts describe requests, not a claim that a model was actually used. */
export const HOST_EXECUTION_REQUEST_VERSION = "tcrn.host-execution-request.v1" as const;
export const HOST_EXECUTION_DECISION_VERSION = "tcrn.host-execution-decision.v1" as const;
export type HostKind = "codex" | "claude" | "dot";
export type HostAction = "decomposition" | "research" | "coordination" | "implementation";
export type HostTuple = { readonly runner: string; readonly model: string; readonly effort: string };
export type HostSelection = { readonly kind: "explicit"; readonly tuple: HostTuple } | { readonly kind: "host-managed" };
export interface HostCapabilities {
  readonly hostKind: HostKind;
  readonly invocationKind: "native-tool";
  readonly selectionControl: "explicit" | "host-managed" | "unknown";
  readonly toolName: string;
  readonly toolAvailable: boolean;
  /** Absent enumeration is not evidence that a documented request is unsupported. */
  readonly combinations?: readonly HostTuple[];
  readonly selectionObservations?: readonly { readonly selection: HostSelection; readonly support: "supported" | "unsupported" | "unknown"; readonly observedAt: string }[];
  readonly requestedSelectionSupported: "supported" | "unsupported" | "unknown";
  readonly hostManagedSupported: boolean;
  readonly platformCapacity?: { readonly limit: number; readonly active: number; readonly includesParent: boolean; readonly parentActive: boolean };
  readonly usage?: { readonly observedAt: string; readonly fiveHourUsedPercent?: number; readonly weeklyUsedPercent?: number };
  readonly sessionRef?: string;
  readonly contractRef?: string;
}
export class HostExecutionError extends Error { readonly reasonCode = "HOST_EXECUTION_INVALID"; }
export function hostObject(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostExecutionError(`${name} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) throw new HostExecutionError(`${name} contains unsupported fields`);
  return object;
}
export function hostText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new HostExecutionError(`${name} must be nonempty`);
}
export function hostCount(value: unknown, name: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new HostExecutionError(`${name} must be an integer >= ${minimum}`);
}
export function validateHostTuple(value: unknown): HostTuple {
  const tuple = hostObject(value, "tuple", ["runner", "model", "effort"]);
  for (const key of ["runner", "model", "effort"]) hostText(tuple[key], key);
  return value as HostTuple;
}
export function validateHostSelection(value: unknown): HostSelection {
  const s = hostObject(value, "selection", ["kind", "tuple"]);
  if (s.kind === "explicit") validateHostTuple(s.tuple);
  else if (s.kind !== "host-managed" || s.tuple !== undefined) throw new HostExecutionError("selection must be explicit or host-managed");
  return value as HostSelection;
}
export function validateHostCapabilities(value: unknown): HostCapabilities {
  const c = hostObject(value, "capabilities", ["hostKind", "invocationKind", "selectionControl", "toolName", "toolAvailable", "combinations", "selectionObservations", "requestedSelectionSupported", "hostManagedSupported", "platformCapacity", "usage", "sessionRef", "contractRef"]);
  if (!["codex", "claude", "dot"].includes(String(c.hostKind)) || c.invocationKind !== "native-tool" || !["explicit", "host-managed", "unknown"].includes(String(c.selectionControl))) throw new HostExecutionError("unsupported host/call/selection dimensions");
  hostText(c.toolName, "toolName");
  if (typeof c.toolAvailable !== "boolean" || typeof c.hostManagedSupported !== "boolean" || !["supported", "unsupported", "unknown"].includes(String(c.requestedSelectionSupported))) throw new HostExecutionError("actual tool contract availability required");
  if (c.hostKind === "dot" && c.selectionControl === "explicit") throw new HostExecutionError("dot self-model selection is host-managed, not explicit");
  if (c.combinations !== undefined) { if (!Array.isArray(c.combinations)) throw new HostExecutionError("combinations must be an array"); c.combinations.forEach(validateHostTuple); }
  if (c.selectionObservations !== undefined) {
    if (!Array.isArray(c.selectionObservations)) throw new HostExecutionError("selectionObservations must be array");
    for (const value of c.selectionObservations) {
      const o = hostObject(value, "selection observation", ["selection", "support", "observedAt"]);
      validateHostSelection(o.selection); hostText(o.observedAt, "selection observedAt");
      if (!["supported", "unsupported", "unknown"].includes(String(o.support))) throw new HostExecutionError("invalid selection support");
    }
  }
  if (c.platformCapacity !== undefined) {
    const p = hostObject(c.platformCapacity, "platformCapacity", ["limit", "active", "includesParent", "parentActive"]);
    hostCount(p.limit, "platform limit", 1); hostCount(p.active, "platform active");
    if (typeof p.includesParent !== "boolean" || typeof p.parentActive !== "boolean" || p.includesParent && p.parentActive && p.active === 0) throw new HostExecutionError("invalid parent accounting");
  }
  if (c.usage !== undefined) {
    const usage = hostObject(c.usage, "usage", ["observedAt", "fiveHourUsedPercent", "weeklyUsedPercent"]);
    hostText(usage.observedAt, "usage observedAt");
    for (const key of ["fiveHourUsedPercent", "weeklyUsedPercent"]) if (usage[key] !== undefined && (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || Number(usage[key]) < 0 || Number(usage[key]) > 100)) throw new HostExecutionError("usage percentage must be between 0 and 100");
  }
  for (const key of ["sessionRef", "contractRef"]) if (c[key] !== undefined) hostText(c[key], key);
  return value as HostCapabilities;
}
export function sameHostTuple(a: HostTuple, b: HostTuple): boolean { return a.runner === b.runner && a.model === b.model && a.effort === b.effort; }
export function hostSelectionSupported(capabilities: HostCapabilities, selection: HostSelection, role: "requested" | "fallback" = "requested", now = new Date().toISOString()): boolean {
  if (!capabilities.toolAvailable) return false;
  const match = (other: HostSelection): boolean => selection.kind === "host-managed" ? other.kind === "host-managed" : other.kind === "explicit" && sameHostTuple(selection.tuple, other.tuple);
  const observations = (capabilities.selectionObservations ?? []).filter(o => match(o.selection) && Date.parse(o.observedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(o.observedAt) <= 300_000);
  const latest = observations.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const newest = latest[0];
  const currentNegative = role === "requested" && capabilities.requestedSelectionSupported === "unsupported";
  if (currentNegative || newest?.support === "unsupported") return false;
  if (selection.kind === "host-managed") return capabilities.hostManagedSupported;
  if (capabilities.selectionControl !== "explicit") return false;
  if (newest?.support === "supported") return true;
  if (capabilities.combinations !== undefined) return capabilities.combinations.some(tuple => sameHostTuple(tuple, selection.tuple));
  // Requestability is sufficient for the original call. An alternative needs its own
  // observed support, never reuses the failed original's global status or a guessed roster.
  return role === "requested";
}
/** Unknown versions/states are uninterpretable, not a host refusal or implicit permission. */
export function executionDecisionEligibility(value: unknown): "executable" | "not-executable" | "uninterpretable" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "uninterpretable";
  const v = value as Record<string, unknown>;
  if (v.schemaVersion === HOST_EXECUTION_DECISION_VERSION) {
    if (["allowed", "degraded"].includes(String(v.status))) return "executable";
    return ["blocked", "awaiting-choice", "reconcile"].includes(String(v.status)) ? "not-executable" : "uninterpretable";
  }
  if (["tcrn.dot-admission.v1", "tcrn.execution-admission.v1"].includes(String(v.schemaVersion))) return v.status === "admitted" ? "executable" : v.status === "refused" ? "not-executable" : "uninterpretable";
  return "uninterpretable";
}
