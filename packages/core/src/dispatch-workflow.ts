// SPDX-License-Identifier: Apache-2.0
import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseStrictInstant } from "../../protocol/src/index.js";
import { deviceHome } from "./device-home.js";
import { hasLibraryManifest } from "./ether-library.js";
import { readRegistry } from "./registry.js";
import { pathIsInside } from "./path-containment.js";
import { workProjectContexts } from "./project-chain.js";
import type { WorkspaceState } from "./workspace.js";
import type { ExecutionAdmissionRequest } from "./execution-admission.js";
import { DISPATCH_EVIDENCE_VERSION, dispatchAdmissionDigest, normalizeDispatchAdmissionEvidence } from "./dispatch-evidence.js";

export const DISPATCH_PREPARATION_VERSION = "tcrn.dispatch-preparation.v1";
export const PROCESS_RETURN_VERSION = "tcrn.dispatch-process-return.v1";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class DispatchWorkflowError extends Error {
  readonly reasonCode = "DISPATCH_WORKFLOW_INVALID";
}
export interface DispatchPreparation {
  schemaVersion: typeof DISPATCH_PREPARATION_VERSION;
  selectors: Pick<ExecutionAdmissionRequest, "host" | "category" | "rejections" | "requestedAgents" | "action">;
  observations: unknown;
  context: Record<string, unknown>;
  bindings: { target: number; handoff: unknown; digest: string }[];
  digest: string;
}

/** Capture fresh admission, never synthesize observations from the selected policy. */
export async function prepareDispatch(state: WorkspaceState, workId: string, selectors: Pick<ExecutionAdmissionRequest, "host" | "category" | "rejections" | "requestedAgents" | "action">, observations: unknown, home?: string): Promise<DispatchPreparation> {
  const input = object(observations);
  if (observations === null || typeof observations !== "object" || Array.isArray(observations) || Object.keys(input).some(key => !["availableCombinations", "usage", "expectedPolicy"].includes(key))) throw new DispatchWorkflowError("observations must contain only availableCombinations, usage and expectedPolicy");
  const context = await workProjectContexts(state, workId, home, { ...selectors, ...input } as ExecutionAdmissionRequest);
  const bindings = (context.contexts as Record<string, unknown>[]).map((target, index) => ({ target: index, handoff: target.handoff, digest: dispatchAdmissionDigest(target.handoff) }));
  const payload = { schemaVersion: DISPATCH_PREPARATION_VERSION as typeof DISPATCH_PREPARATION_VERSION, selectors, observations, context, bindings };
  return { ...payload, digest: dispatchAdmissionDigest(payload) };
}

/** Mechanical association of a caller-supplied process return; no launch or authentication. */
export function recordDispatch(preparationValue: unknown, target: number, processReturn: unknown): Record<string, unknown> {
  const preparation = object(preparationValue);
  const bindings = Array.isArray(preparation.bindings) ? preparation.bindings : [];
  const binding = object(bindings[target]);
  const handoff = object(binding.handoff);
  const admission = object(handoff.executionAdmission);
  const policy = object(admission.policy);
  const raw = object(processReturn);
  const problems: string[] = [];
  if (preparation.schemaVersion !== DISPATCH_PREPARATION_VERSION || !Number.isSafeInteger(target) || target < 0 || binding.target !== target) problems.push("preparation or target is missing or invalid");
  try {
    const { digest, ...payload } = preparation;
    if (digest !== dispatchAdmissionDigest(payload) || binding.digest !== dispatchAdmissionDigest(binding.handoff)) problems.push("saved preparation or binding digest mismatch");
  } catch { problems.push("saved preparation is not JSON evidence"); }
  const context = object(preparation.context);
  const contexts = Array.isArray(context.contexts) ? context.contexts : [];
  try {
    if (dispatchAdmissionDigest(object(contexts[target]).handoff) !== binding.digest || handoff.workId !== context.workId || handoff.workRevision !== context.workRevision) problems.push("binding differs from the captured work/project context");
  } catch { problems.push("target handoff is unavailable"); }
  if (context.dispatchAdmitted !== true) problems.push("captured work was not dispatch-admitted");
  if (raw.schemaVersion !== PROCESS_RETURN_VERSION || raw.source !== "native-host-return") problems.push("process return must explicitly identify the supported native-host-return process artifact");
  if (Object.keys(raw).some(key => !["schemaVersion", "source", "bindingDigest", "selectedTuple", "startedAt", "stdout", "stderr", "exitCode"].includes(key))) problems.push("process return contains unsupported fields");
  if (raw.bindingDigest !== binding.digest) problems.push("process return bindingDigest differs from the selected saved binding");
  try {
    if (typeof raw.startedAt !== "string" || !raw.startedAt.endsWith("Z") || typeof admission.evaluatedAt !== "string") throw new Error();
    const age = parseStrictInstant(raw.startedAt) - parseStrictInstant(admission.evaluatedAt);
    const quota = object(admission.quota);
    if (quota.status === "fresh") {
      if (typeof quota.observedAt !== "string" || parseStrictInstant(raw.startedAt) - parseStrictInstant(quota.observedAt) > 300_000_000_000n) problems.push("quota observation was stale at the actual process start");
    }
    if (age < 0n || age > 300_000_000_000n || parseStrictInstant(raw.startedAt) > parseStrictInstant(new Date().toISOString())) problems.push("process start is before admission, in the future, or more than five minutes after admission; prepare immediately before dispatch");
  } catch { problems.push("actual process startedAt or admission evaluatedAt is unavailable or malformed"); }
  const observation = (field: string): unknown => Object.hasOwn(raw, field)
    ? { status: "available", value: raw[field] }
    : { status: "unavailable", reason: `process return did not expose ${field}` };
  const hostResult = {
    schemaVersion: DISPATCH_EVIDENCE_VERSION, source: raw.source ?? null,
    workId: handoff.workId ?? null, workRevision: handoff.workRevision ?? null, projectReference: handoff.reference ?? null,
    request: admission.request ?? null, selectedTuple: raw.selectedTuple ?? null,
    policyRevision: policy.revision ?? null, policyDigest: policy.digest ?? null,
    admissionDigest: dispatchAdmissionDigest(admission), stdout: observation("stdout"), stderr: observation("stderr"), exitCode: observation("exitCode"),
  };
  const normalized = normalizeDispatchAdmissionEvidence({ handoff: binding.handoff ?? null, hostResult });
  normalized.problems.unshift(...problems);
  if (problems.length) { normalized.valid = false; normalized.complete = false; normalized.status = "invalid"; }
  return { schemaVersion: "tcrn.dispatch-record.v1", target, binding: binding.handoff ?? null, preparationDigest: preparation.digest ?? null, raw: processReturn, normalized };
}

/** Explicit private local artifact only, never a device/registered-library write or overwrite. */
export async function writeDispatchArtifact(path: string, value: unknown, forbiddenRoots: readonly string[] = [], home: string = deviceHome()): Promise<void> {
  const destination = resolve(await realpath(dirname(resolve(path))), basename(resolve(path)));
  // Also exclude an unregistered library selected explicitly in an earlier preparation.
  for (let parent = dirname(destination); ; parent = dirname(parent)) {
    if (await hasLibraryManifest(parent)) throw new DispatchWorkflowError("output must be a private local artifact outside device and library roots");
    if (dirname(parent) === parent) break;
  }
  const registry = await readRegistry(home);
  for (const root of [home, ...forbiddenRoots, ...registry.entries.map(entry => entry.libraryPath)]) {
    let actual = resolve(root);
    try { actual = await realpath(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (pathIsInside(actual, destination)) throw new DispatchWorkflowError("output must be a private local artifact outside device and library roots");
  }
  const file = await open(destination, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); } finally { await file.close(); }
}

/** Native preparation stays separate from the legacy process preparation and bindings. */
export async function prepareNativeDispatch(state: WorkspaceState, request: import("./dot-execution.js").DotExecutionRequest, tool: { readonly toolName: string; readonly toolContractObservation: import("./native-tool-evidence.js").NativeToolAttempt["toolContractObservation"]; readonly argumentsValue: unknown }, home?: string, retry?: NativeDispatchBinding["retry"]): Promise<NativeDispatchPreparation> {
  const context = await workProjectContexts(state, request.workId, home, request);
  const contexts = context.contexts as Record<string, unknown>[];
  const target = contexts.find(item => dotDigest(item.reference) === dotDigest(request.projectRef));
  const admission = target?.executionAdmission as DotAdmission | undefined;
  const targetDispatchAdmitted = (context.involvedProjects as { state: string }).state === "selected" && admission?.status === "admitted" && (target?.readiness as Record<string, { ready: boolean }> | undefined)?.development?.ready === true;
  const toolInput = { ...tool, requestedAt: new Date().toISOString() };
  if (retry !== undefined && !normalizeNativeToolEvidence(retry.previous).valid) throw new DispatchWorkflowError("retry requires intact previous saved evidence");
  const attempt = targetDispatchAdmitted && admission?.status === "admitted"
    ? retry === undefined ? createNativeToolAttempt(admission, toolInput) : createNativeToolRetry(nativeSavedAttempt(retry.previous, true), admission, toolInput, retry.reconciliation).attempt : null;
  const payload = { schemaVersion: "tcrn.native-dispatch-preparation.v1" as const, context, targetDispatchAdmitted, admission: admission ?? null, attempt, ...(retry === undefined ? {} : { retry }) };
  return { ...payload, digest: dotDigest(payload) };
}
import { dotDigest } from "./dot-execution.js";
import type { DotAdmission } from "./dot-execution.js";
import { createNativeToolAttempt, recordNativeToolResponse, normalizeNativeToolEvidence, validateNativeDispatchBinding, appendNativeToolRecord, validateNativeToolHistory, nativeSavedAttempt, createNativeToolRetry } from "./native-tool-evidence.js";
import type { NativeToolResponseInput, NativeToolRecord, NativeDispatchBinding, NativeToolHistory } from "./native-tool-evidence.js";
export type NativeDispatchPreparation = NativeDispatchBinding;
export function recordNativeDispatch(preparationValue: NativeDispatchPreparation, response?: NativeToolResponseInput, prior?: unknown): Record<string, unknown> {
  const preparation = validateNativeDispatchBinding(preparationValue);
  const attempt = preparation.attempt; const admission = preparation.admission;
  if (attempt === null || admission === null) throw new DispatchWorkflowError("native preparation is pending or refused");
  let history: NativeToolHistory = { records: [], observations: [], current: null };
  if (prior !== undefined) {
    if (!normalizeNativeToolEvidence(prior).valid || dotDigest(nativeSavedAttempt(prior)) !== dotDigest(attempt)) throw new DispatchWorkflowError("prior history must belong to this actual attempt and be reconciled");
    history = validateNativeToolHistory((prior as { history: unknown }).history);
  }
  const record = response === undefined ? { preparation, attempt, admission }
    : { preparation, attempt, admission, response, evidence: recordNativeToolResponse(attempt, admission, response) };
  const appended = response === undefined ? { status: "pending", history, problems: [] } : appendNativeToolRecord(history, record as NativeToolRecord);
  const saved = { record, history: appended.history, appendStatus: appended.status, problems: appended.problems, ...("rejectedRecord" in appended ? { rejectedRecord: appended.rejectedRecord } : {}) };
  return { ...saved, normalized: normalizeNativeToolEvidence(saved) };
}

import { randomUUID } from "node:crypto";
import { executionDecisionEligibility, HostExecutionError, validateHostSelection } from "./host-capabilities.js";
import type { HostSelection } from "./host-capabilities.js";
import { sameHostSelection, validateHostExecutionRequest } from "./execution-fallback.js";
import type { HostExecutionRequest, HostExecutionDecision } from "./execution-fallback.js";
import { HOST_NATIVE_PREPARATION_VERSION, validateHostNativePreparation } from "./native-tool-evidence.js";
import type { HostNativePreparation } from "./native-tool-evidence.js";
/** Optional audit preparation; no adapter, save transaction or prior success receipt prerequisite. */
export async function prepareHostNativeDispatch(state: WorkspaceState, requestValue: HostExecutionRequest, tool: { readonly argumentsValue: unknown; readonly selection: HostSelection }, home?: string): Promise<HostNativePreparation> {
  const request = validateHostExecutionRequest(requestValue);
  validateHostSelection(tool.selection);
  const context = await workProjectContexts(state, request.workId, home, request);
  const decision = context.executionDecision as HostExecutionDecision;
  const executable = executionDecisionEligibility(decision) === "executable" && context.dispatchAdmitted === true;
  if (executable && !sameHostSelection(tool.selection, decision.requestedSelection)) throw new HostExecutionError("tool request selection differs from the resolved selection; construct arguments for the resolved request, not an invented actual model");
  const payload = {
    schemaVersion: HOST_NATIVE_PREPARATION_VERSION, context, decision,
    attempt: executable ? { id: `local-attempt:${randomUUID()}`, identityKind: "local-correlation" as const, toolName: request.capabilities.toolName, argumentsValue: tool.argumentsValue, requestedAt: new Date().toISOString() } : null,
  };
  return validateHostNativePreparation({ ...payload, digest: dotDigest(payload) });
}
