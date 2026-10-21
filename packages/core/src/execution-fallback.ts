// SPDX-License-Identifier: Apache-2.0
import { evaluateExecutionQuota } from "./execution-policy.js";
import { isAbsolute } from "node:path";
import { parseStrictInstant } from "../../protocol/src/index.js";
import { dotDigest } from "./dot-execution.js";
import { HOST_EXECUTION_REQUEST_VERSION, HOST_EXECUTION_DECISION_VERSION, HostExecutionError, hostObject, hostText, hostCount, validateHostCapabilities, validateHostSelection, sameHostTuple, hostSelectionSupported } from "./host-capabilities.js";
import type { HostAction, HostCapabilities, HostSelection } from "./host-capabilities.js";
import type { ProjectReference } from "../../protocol/src/index.js";
import { resolveNativePolicyIntentFromSnapshot } from "./engine-model-policy.js";
import type { EngineModelPolicyFile } from "./engine-model-policy.js";

/** This is a report of existing authority, not a credential minted by the harness. */
export interface HostExecutionAuthorization {
  readonly status: "covered" | "absent" | "withdrawn";
  readonly basis: string;
  readonly actions: readonly HostAction[];
  readonly hosts: readonly string[];
  readonly workIds: readonly string[] | "all";
  readonly fallback: "none" | "same-host" | "listed-selections";
  readonly selections?: readonly HostSelection[];
  readonly sourceRef?: string;
  readonly expiresAt?: string;
}
export interface HostExecutionRequest {
  readonly schemaVersion: typeof HOST_EXECUTION_REQUEST_VERSION;
  readonly workId: string;
  readonly workRevision: number;
  readonly action: HostAction;
  readonly phase: "dispatch" | "work";
  readonly category: string;
  readonly rejections: number;
  readonly requestedAgents: number;
  readonly capabilities: HostCapabilities;
  readonly selection: HostSelection;
  readonly fallbackSelection?: HostSelection;
  readonly authorization: HostExecutionAuthorization;
  readonly context: { readonly parent: "read" | "pending" | "failed"; readonly child: "not-created" | "read" | "pending" | "failed"; readonly report?: string };
  readonly projectRef?: ProjectReference;
  readonly sourceScope?: { readonly repository: string; readonly writableRoots: readonly string[]; readonly permission: "granted" | "unknown" | "denied" };
  readonly hardLimits?: { readonly exactSelection?: HostSelection; readonly remainingCalls?: number; readonly deadline?: string; readonly budgetSatisfied?: boolean; readonly concurrency?: { readonly limit: number; readonly active: number | null; readonly includesParent: boolean; readonly parentActive: boolean; readonly scope: "children" | "total" } };
  readonly previousOutcome?: "not-executed" | "unknown" | "running" | "terminal";
  readonly permissionDenied?: boolean;
  readonly cancellationRequested?: boolean;
}
export interface HostExecutionDecision {
  readonly schemaVersion: typeof HOST_EXECUTION_DECISION_VERSION;
  readonly status: "allowed" | "degraded" | "blocked" | "awaiting-choice" | "reconcile";
  readonly request: HostExecutionRequest;
  readonly evaluatedAt: string;
  readonly configuredIntent: HostSelection | null;
  readonly requestedSelection: HostSelection;
  readonly actualSelection: { readonly status: "unknown"; readonly reason: string };
  readonly fallbackApplied: boolean;
  readonly reasons: readonly string[];
  readonly evidenceQuality: "limited";
  readonly policyStatus: "unconfigured" | "entry-unconfigured" | "configured" | "unsupported" | "not-applicable";
  readonly authorizationVerification: "reported-context-not-authentication";
  readonly persistentConfigWrites: 0;
  readonly additionalConfirmationsRequired: boolean;
  readonly contextDigest: string;
}
const actions = ["decomposition", "research", "coordination", "implementation"];
function instant(v: unknown): void { hostText(v, "instant"); if (!v.endsWith("Z")) throw new HostExecutionError("instant must be UTC"); parseStrictInstant(v); }
function strings(v: unknown, name: string): asserts v is string[] { if (!Array.isArray(v)) throw new HostExecutionError(`${name} must be an array`); v.forEach(s => hostText(s, name)); }
export function validateHostExecutionRequest(value: unknown): HostExecutionRequest {
  const r = hostObject(value, "host request", ["schemaVersion", "workId", "workRevision", "action", "phase", "category", "rejections", "requestedAgents", "capabilities", "selection", "fallbackSelection", "authorization", "context", "projectRef", "sourceScope", "hardLimits", "previousOutcome", "permissionDenied", "cancellationRequested"]);
  if (r.schemaVersion !== HOST_EXECUTION_REQUEST_VERSION || !actions.includes(String(r.action)) || !["dispatch", "work"].includes(String(r.phase))) throw new HostExecutionError("unsupported host request version/action/phase");
  hostText(r.workId, "workId"); hostCount(r.workRevision, "workRevision", 1); hostText(r.category, "category"); hostCount(r.rejections, "rejections"); hostCount(r.requestedAgents, "requestedAgents", 1);
  validateHostCapabilities(r.capabilities); validateHostSelection(r.selection); if (r.fallbackSelection !== undefined) validateHostSelection(r.fallbackSelection);
  const a = hostObject(r.authorization, "authorization", ["status", "basis", "actions", "hosts", "workIds", "fallback", "selections", "sourceRef", "expiresAt"]);
  if (!["covered", "absent", "withdrawn"].includes(String(a.status)) || !["none", "same-host", "listed-selections"].includes(String(a.fallback))) throw new HostExecutionError("invalid authority report");
  hostText(a.basis, "authority basis"); strings(a.actions, "actions"); strings(a.hosts, "hosts"); if (a.workIds !== "all") strings(a.workIds, "workIds");
  if (a.actions.some(action => !actions.includes(action))) throw new HostExecutionError("unknown authorized action");
  if (a.selections !== undefined) { if (!Array.isArray(a.selections)) throw new HostExecutionError("selections must be array"); a.selections.forEach(validateHostSelection); }
  if (a.sourceRef !== undefined) hostText(a.sourceRef, "sourceRef"); if (a.expiresAt !== undefined) instant(a.expiresAt);
  const c = hostObject(r.context, "context", ["parent", "child", "report"]);
  if (!["read", "pending", "failed"].includes(String(c.parent)) || !["not-created", "read", "pending", "failed"].includes(String(c.child))) throw new HostExecutionError("invalid two-stage context status");
  if (c.report !== undefined) hostText(c.report, "context report");
  if (r.projectRef !== undefined) { const p = hostObject(r.projectRef, "projectRef", ["libraryId", "projectId"]); hostText(p.libraryId, "libraryId"); hostText(p.projectId, "projectId"); }
  if (r.sourceScope !== undefined) {
    const s = hostObject(r.sourceScope, "sourceScope", ["repository", "writableRoots", "permission"]); hostText(s.repository, "repository"); strings(s.writableRoots, "writableRoots");
    if (!s.writableRoots.length || s.writableRoots.some(root => !isAbsolute(root)) || !["granted", "unknown", "denied"].includes(String(s.permission))) throw new HostExecutionError("source scope requires absolute roots and permission status");
  }
  if (r.hardLimits !== undefined) {
    const h = hostObject(r.hardLimits, "hardLimits", ["exactSelection", "remainingCalls", "deadline", "budgetSatisfied", "concurrency"]);
    if (h.exactSelection !== undefined) validateHostSelection(h.exactSelection);
    if (h.remainingCalls !== undefined) hostCount(h.remainingCalls, "remainingCalls"); if (h.deadline !== undefined) instant(h.deadline);
    if (h.budgetSatisfied !== undefined && typeof h.budgetSatisfied !== "boolean") throw new HostExecutionError("hard budget assessment must be boolean");
    if (h.concurrency !== undefined) {
      const c = hostObject(h.concurrency, "hard concurrency", ["limit", "active", "includesParent", "parentActive", "scope"]);
      hostCount(c.limit, "limit", 1); if (c.active !== null) hostCount(c.active, "active");
      if (typeof c.includesParent !== "boolean" || typeof c.parentActive !== "boolean" || !["children", "total"].includes(String(c.scope)) || c.active === 0 && c.includesParent && c.parentActive) throw new HostExecutionError("invalid hard concurrency accounting");
    }
  }
  if (r.previousOutcome !== undefined && !["not-executed", "unknown", "running", "terminal"].includes(String(r.previousOutcome))) throw new HostExecutionError("invalid previous outcome");
  for (const key of ["permissionDenied", "cancellationRequested"]) if (r[key] !== undefined && typeof r[key] !== "boolean") throw new HostExecutionError(`${key} must be boolean`);
  return value as HostExecutionRequest;
}
export function sameHostSelection(a: HostSelection, b: HostSelection): boolean { return a.kind === "host-managed" ? b.kind === "host-managed" : b.kind === "explicit" && sameHostTuple(a.tuple, b.tuple); }
export function resolveHostExecution(requestValue: HostExecutionRequest, policy: EngineModelPolicyFile | null, contextDigest: string, evaluatedAt = new Date().toISOString()): HostExecutionDecision {
  const request = validateHostExecutionRequest(requestValue); instant(evaluatedAt);
  const { capabilities: c, authorization: a } = request;
  const intent = c.hostKind === "dot" ? { status: "not-applicable" as const, selection: null } : resolveNativePolicyIntentFromSnapshot(policy!, { host: c.hostKind === "claude" ? "claude-code" : c.hostKind, category: request.category, rejections: request.rejections, ...(c.combinations === undefined ? {} : { availableCombinations: c.combinations }) });
  const configuredIntent: HostSelection | null = intent.selection === null ? null : { kind: "explicit", tuple: { runner: intent.selection.record.runner, model: intent.selection.record.model, effort: intent.selection.record.effort } };
  const preferred = configuredIntent ?? request.selection;
  let selected = preferred;
  let status: HostExecutionDecision["status"] = "degraded";
  const reasons: string[] = [];
  const stop = (reason: string, state: HostExecutionDecision["status"] = "blocked"): void => { reasons.push(reason); const priority = { degraded: 0, allowed: 0, "awaiting-choice": 1, reconcile: 2, blocked: 3 }; if (priority[state] > priority[status]) status = state; };
  if (a.status !== "covered" || !a.actions.includes(request.action) || !a.hosts.includes(c.hostKind) || a.workIds !== "all" && !a.workIds.includes(request.workId) || a.expiresAt !== undefined && parseStrictInstant(a.expiresAt) <= parseStrictInstant(evaluatedAt)) stop("authorization-does-not-cover-action");
  if (request.permissionDenied) stop("actual-permission-denial");
  if (request.cancellationRequested) stop("cancellation-requested-no-new-work");
  if (["unknown", "running"].includes(request.previousOutcome ?? "")) stop("reconcile-existing-invocation", "reconcile");
  if (!c.toolAvailable) stop("required-native-tool-unavailable");
  if (request.context.parent !== "read") stop("parent-context-not-read");
  if (request.phase === "work" && request.context.child !== "read") stop("child-context-not-read");
  if (request.action === "implementation" && (!request.sourceScope || request.sourceScope.permission !== "granted")) stop("implementation-source-scope-or-permission-unresolved");
  const h = request.hardLimits;
  if (h?.remainingCalls !== undefined && h.remainingCalls < request.requestedAgents) stop("explicit-call-limit");
  if (h?.deadline !== undefined && parseStrictInstant(h.deadline) <= parseStrictInstant(evaluatedAt)) stop("explicit-deadline");
  if (h?.budgetSatisfied === false) stop("explicit-budget-not-guaranteed");
  if (h?.concurrency) {
    const o = h.concurrency;
    const active = o.active === null ? null : o.scope === "children" ? o.active - (o.includesParent && o.parentActive ? 1 : 0) : o.active + (!o.includesParent && o.parentActive ? 1 : 0);
    if (active === null || active + request.requestedAgents > o.limit) stop("explicit-concurrency-limit-not-guaranteed");
  }
  if (c.platformCapacity) {
    const o = c.platformCapacity; const active = o.active + (!o.includesParent && o.parentActive ? 1 : 0);
    if (active + request.requestedAgents > o.limit) stop("observed-platform-capacity-full");
  }
  if (c.usage) {
    instant(c.usage.observedAt);
    const age = Number(parseStrictInstant(evaluatedAt) - parseStrictInstant(c.usage.observedAt)) / 1_000_000;
    if (age < 0) throw new HostExecutionError("usage observation is in the future");
    if (age <= 300_000 && intent.selection?.quotaOrigin === "device-host-policy") {
      const { observedAt: _observedAt, ...windows } = c.usage;
      const quota = evaluateExecutionQuota(intent.selection.quota, windows);
      if (quota.decision === "wait") stop("observed-configured-quota-wait");
      if (quota.decision === "serial" && request.requestedAgents > 1) stop("observed-configured-quota-serial");
      if (quota.unknownWindows.length) reasons.push("optional-quota-windows-unknown-not-zero");
    } else reasons.push("quota-observation-stale-or-policy-unconfigured");
  }
  if (!hostSelectionSupported(c, preferred)) {
    // Selection is a caller-observed usable alternative, not a guessed vendor roster.
    const alternative = request.fallbackSelection;
    const covered = alternative !== undefined && (a.fallback === "same-host" && (alternative.kind === "host-managed" || preferred.kind === "explicit" && alternative.tuple.runner === preferred.tuple.runner) || a.fallback === "listed-selections" && a.selections?.some(s => sameHostSelection(s, alternative)) === true);
    if (!alternative || !hostSelectionSupported(c, alternative)) stop("no-supported-selection", "awaiting-choice");
    else if (!covered) stop("fallback-outside-existing-authority", "awaiting-choice");
    else { selected = alternative; reasons.push("authorized-host-constraint-fallback"); }
  } else if (!sameHostSelection(preferred, request.selection)) {
    // Do not silently use tool arguments that differ from the selected valid configuration.
    reasons.push("request-adjusted-to-configured-intent");
  }
  if (h?.exactSelection && !sameHostSelection(h.exactSelection, selected)) stop("explicit-no-substitution-limit");
  if (!a.sourceRef) reasons.push("authorization-reference-unavailable-not-required");
  if (!c.platformCapacity) reasons.push("platform-capacity-unknown-host-enforced");
  reasons.push("actual-model-unobserved-not-inferred");
  if (!c.usage) reasons.push("optional-quota-unobserved-not-inferred");
  // Mutations through stop() are intentional; TypeScript does not narrow closure writes.
  const finalStatus = status as HostExecutionDecision["status"];
  return { schemaVersion: HOST_EXECUTION_DECISION_VERSION, status: finalStatus, request, evaluatedAt, configuredIntent, requestedSelection: selected, actualSelection: { status: "unknown", reason: "planning does not prove actual host selection" }, fallbackApplied: !sameHostSelection(preferred, selected), reasons, evidenceQuality: "limited", policyStatus: intent.status, authorizationVerification: "reported-context-not-authentication", persistentConfigWrites: 0, additionalConfirmationsRequired: finalStatus === "awaiting-choice", contextDigest };
}

/** Technical observations never mutate quality history; duplicate quality events count once. */
export function recordExecutionQualityEvent(history: { readonly rejections: number; readonly eventIds: readonly string[] }, event: { readonly id: string; readonly kind: "quality-rejected" | "model-unavailable" | "rate-limit" | "network" | "telemetry-unavailable" | "policy-error" }): { readonly rejections: number; readonly eventIds: readonly string[] } {
  hostCount(history.rejections, "quality rejections"); hostText(event.id, "event id");
  if (!["quality-rejected", "model-unavailable", "rate-limit", "network", "telemetry-unavailable", "policy-error"].includes(event.kind)) throw new HostExecutionError("unknown event kind");
  if (history.eventIds.includes(event.id)) return history;
  return { rejections: history.rejections + (event.kind === "quality-rejected" ? 1 : 0), eventIds: [...history.eventIds, event.id] };
}
/** No automatic retry of uncertain side effects, no quality escalation by technical error. */
export function hostRecoveryAction(kind: "network" | "rate-limit" | "model-unavailable" | "permission-denied", outcome: "not-executed" | "unknown" | "running" | "terminal"): "retry-with-backoff" | "resolve-authorized-fallback" | "reconcile" | "stop-affected-action" {
  if (kind === "permission-denied") return "stop-affected-action";
  if (outcome !== "not-executed") return "reconcile";
  return kind === "model-unavailable" ? "resolve-authorized-fallback" : "retry-with-backoff";
}
export function hostExecutionDecisionDigest(value: HostExecutionDecision): string { return dotDigest(value); }
