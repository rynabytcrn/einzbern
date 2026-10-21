// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

const WORK_ID_PATTERN = /^work:[a-z0-9][a-z0-9._-]{0,127}$/u;
function text(value: unknown): string { return typeof value === "string" ? value : ""; }

// Association validates a supplied host return; it does not authenticate the host,
// execute a dispatch, or convert the review runner into native execution evidence.
export const DISPATCH_EVIDENCE_VERSION = "tcrn.host-dispatch-evidence.v1";
const recordObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const digestString = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function canonicalEvidence(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  if (recordObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEvidence(value[key])}`).join(",")}}`;
  throw new TypeError("admission evidence must contain only JSON values");
}
export function dispatchAdmissionDigest(admission: unknown): string {
  return createHash("sha256").update(canonicalEvidence(admission)).digest("hex");
}

export interface DispatchAdmissionEvidence {
  requested: boolean;
  valid: boolean;
  complete: boolean;
  status: "not-requested" | "invalid" | "unavailable" | "associated";
  problems: string[];
  evidence: unknown;
  verification?: "caller-supplied-host-return-not-independently-authenticated";
  unavailable?: string[];
  admissionDigest?: string | null;
}

/** Deterministic validation only. Undefined means the legacy path was requested. */
export function normalizeDispatchAdmissionEvidence(value: unknown, { workId = null, workRevision = null }: { workId?: string | null; workRevision?: number | null } = {}): DispatchAdmissionEvidence {
  if (value === undefined) return { requested: false, valid: true, complete: false, status: "not-requested", problems: [], evidence: null };
  const problems: string[] = [];
  const input = recordObject(value) ? value : {};
  const handoff = recordObject(input.handoff) ? input.handoff : {};
  const admission = recordObject(handoff.executionAdmission) ? handoff.executionAdmission : {};
  const result = recordObject(input.hostResult) ? input.hostResult : {};
  const request = recordObject(admission.request) ? admission.request : {};
  const selection = recordObject(admission.selection) ? admission.selection : {};
  const tuple = recordObject(selection.record) ? selection.record : {};
  const policy = recordObject(admission.policy) ? admission.policy : {};
  const origin = recordObject(selection.origin) ? selection.origin : {};
  if (admission.schemaVersion !== "tcrn.execution-admission.v1" || admission.status !== "admitted" || !Array.isArray(admission.reasons) || admission.reasons.length !== 0) problems.push("handoff must contain an admitted execution admission without refusal reasons");
  if (!WORK_ID_PATTERN.test(text(handoff.workId)) || (workId !== null && handoff.workId !== workId)) problems.push("handoff workId does not match the reviewed work");
  if (!safeInteger(handoff.workRevision) || handoff.workRevision < 1 || (workRevision !== null && handoff.workRevision !== workRevision)) problems.push("handoff workRevision is missing or differs from the bound work revision");
  const reference = handoff.reference;
  if (!recordObject(reference) || Object.keys(reference).sort().join(",") !== "libraryId,projectId" || !/^(library|workspace):[a-f0-9]{24}$/u.test(text(reference.libraryId)) || !/^project:[a-f0-9]{24}$/u.test(text(reference.projectId))) problems.push("handoff reference must be a stable project reference");
  if (!nonempty(request.host) || !nonempty(request.category) || !safeInteger(request.rejections) || request.rejections < 0 || !safeInteger(request.requestedAgents) || request.requestedAgents < 1) problems.push("admission request is missing or malformed");
  if (!["runner", "model", "effort"].every(key => nonempty(tuple[key]))) problems.push("admission selected tuple is missing or malformed");
  if (!safeInteger(policy.revision) || policy.revision < 1 || !digestString(policy.digest) || policy.host !== request.host) problems.push("admission policy identity is missing or malformed");
  if (selection.host !== request.host || selection.category !== request.category || selection.rejections !== request.rejections || origin.revision !== policy.revision || origin.digest !== policy.digest) problems.push("admission selection differs from its request or policy identity");
  if (result.schemaVersion !== DISPATCH_EVIDENCE_VERSION || result.source !== "native-host-return") problems.push("hostResult must explicitly identify a native-host-return, not review or test output");
  const compare = (actual: unknown, expected: unknown, label: string): void => {
    try { if (canonicalEvidence(actual) === canonicalEvidence(expected)) return; } catch { /* missing or non-JSON binding */ }
    problems.push(`hostResult ${label} does not match the admission handoff`);
  };
  compare(result.workId, handoff.workId, "workId");
  compare(result.workRevision, handoff.workRevision, "workRevision");
  compare(result.projectReference, reference, "projectReference");
  compare(result.request, request, "request");
  compare(result.selectedTuple, { runner: tuple.runner, model: tuple.model, effort: tuple.effort }, "selectedTuple");
  compare(result.policyRevision, policy.revision, "policyRevision");
  compare(result.policyDigest, policy.digest, "policyDigest");
  let admissionDigest: string | null = null;
  try { admissionDigest = dispatchAdmissionDigest(admission); } catch { problems.push("admission is not JSON evidence"); }
  if (!digestString(result.admissionDigest) || result.admissionDigest !== admissionDigest) problems.push("hostResult admissionDigest does not match the complete admission receipt");
  const unavailable: string[] = [];
  for (const field of ["stdout", "stderr", "exitCode"]) {
    const observation = result[field];
    if (recordObject(observation) && observation.status === "available" && (field === "exitCode" ? safeInteger(observation.value) && observation.value >= 0 : typeof observation.value === "string") && Object.keys(observation).sort().join(",") === "status,value") continue;
    if (recordObject(observation) && observation.status === "unavailable" && nonempty(observation.reason) && Object.keys(observation).sort().join(",") === "reason,status") unavailable.push(field);
    else problems.push(`hostResult ${field} must contain actual returned text/exit code or an explicit unavailable reason`);
  }
  return {
    requested: true, valid: problems.length === 0, complete: problems.length === 0 && unavailable.length === 0,
    status: problems.length > 0 ? "invalid" : unavailable.length > 0 ? "unavailable" : "associated",
    verification: "caller-supplied-host-return-not-independently-authenticated",
    problems, unavailable, admissionDigest, evidence: value,
  };
}

/** Discriminator only: never feed a native-tool envelope to the process validator. */
export function dispatchEvidenceKind(value: unknown): "native-tool" | "process" {
  if (!recordObject(value)) return "process";
  return value.evidenceType === "native-tool" || recordObject(value.record) && recordObject(value.record.attempt) && value.record.attempt.schemaVersion === "tcrn.native-tool-attempt.v1" || recordObject(value.attempt) && value.attempt.schemaVersion === "tcrn.native-tool-attempt.v1" ? "native-tool" : "process";
}
