// SPDX-License-Identifier: Apache-2.0

// INIT-076: a recoverable receipt for host-native independent Codex conversations. This
// module does not launch, poll, send messages, authenticate a host or grant authorization.
// Native lifecycle evidence has one implementation: native-tool-evidence.ts.
import { dotInstant } from "./dot-execution.js";
import { canonicalSha256, parseStrictInstant } from "../../protocol/src/index.js";
import { hostObject, hostText, HostExecutionError } from "./host-capabilities.js";
import { codexPeerReadiness, resolveEngineExecutionPolicyFromSnapshot, validateEngineModelPolicyFile } from "./engine-model-policy.js";
import type { EngineModelPolicyFile } from "./engine-model-policy.js";
import { normalizeHostNativeRecord, recordHostNativeEvents } from "./native-tool-evidence.js";
import type { HostNativeRecord } from "./native-tool-evidence.js";

export interface CodexPeerManifest {
  readonly schemaVersion: "tcrn.codex-peer-manifest.v1";
  readonly host: "codex";
  readonly batchId: string;
  readonly attemptId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly policyDigest: string;
  readonly main: { readonly conversationId: string; readonly sourceRef: string; readonly raw: unknown; readonly conversationPointer: string };
  readonly coordinator: { readonly conversationId: string; readonly sourceRef: string; readonly raw: unknown; readonly conversationPointer: string };
  readonly members: readonly { readonly attemptId: string; readonly workId: string; readonly workRevision: number; readonly conversationId: string | null }[];
}
export interface CodexPeerDelivery {
  readonly record: HostNativeRecord;
  /** JSON pointer into the actual send arguments, not invented transport parameters. */
  readonly recipientPointer: string;
  /** Pointer to actual send text beginning with codexPeerReportPrefix(manifest). */
  readonly correlationPointer: string;
  readonly batchId: string;
  readonly batchAttemptId: string;
}
export interface CodexPeerBatchInput {
  /** Observation boundary supplied by the recorder, never by host input JSON. */
  readonly observationCutoff: string;
  readonly manifest: CodexPeerManifest;
  readonly records: readonly HostNativeRecord[];
  readonly policy: EngineModelPolicyFile;
  readonly capacity: { readonly limit: number; readonly active: number | null };
  readonly delivery?: CodexPeerDelivery | null;
  readonly prior?: unknown;
  readonly workRevisions?: readonly { readonly id: string; readonly revision: number }[];
}
function fail(message: string): never { throw new HostExecutionError(`Codex peer receipt: ${message}`); }
function positive(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${name} must be a positive safe integer`);
}
function nativeId(value: unknown): void {
  hostText(value, "actual conversation id");
  if (String(value).startsWith("local-attempt:")) fail("local correlation is not a conversation identity");
}
function atPointer(value: unknown, path: string): unknown {
  if (typeof path !== "string" || !path.startsWith("/")) fail("actual native field needs a JSON pointer");
  let found = value;
  for (const segment of path.slice(1).split("/")) {
    if (/~(?![01])/u.test(segment)) fail("invalid JSON pointer escape");
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (found === null || typeof found !== "object" || !Object.hasOwn(found, key)) fail("native field was not returned");
    found = (found as Record<string, unknown>)[key];
  }
  return found;
}
function manifestOf(value: unknown): CodexPeerManifest {
  const m = hostObject(value, "peer manifest", ["schemaVersion", "host", "batchId", "attemptId", "workId", "workRevision", "policyDigest", "main", "coordinator", "members"]);
  if (m.schemaVersion !== "tcrn.codex-peer-manifest.v1" || m.host !== "codex") fail("explicit Codex manifest required; other hosts retain their own workflow");
  for (const key of ["batchId", "attemptId", "workId"]) hostText(m[key], key);
  positive(m.workRevision, "work revision");
  if (typeof m.policyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(m.policyDigest)) fail("policy digest must bind the planned host policy");
  for (const key of ["main", "coordinator"]) {
    const peer = hostObject(m[key], key, ["conversationId", "sourceRef", "raw", "conversationPointer"]);
    nativeId(peer.conversationId); hostText(peer.sourceRef, "native identity evidence");
    if (atPointer(peer.raw, String(peer.conversationPointer)) !== peer.conversationId) fail("peer conversation identity differs from retained native response");
  }
  const manifest = m as unknown as CodexPeerManifest;
  if (manifest.main.conversationId === manifest.coordinator.conversationId) fail("main and economy coordinator must be independent conversations");
  if (!Array.isArray(m.members) || m.members.length === 0) fail("fixed nonempty worker membership required");
  const attempts = new Set<string>();
  const conversations = new Set([manifest.main.conversationId, manifest.coordinator.conversationId]);
  for (const value of m.members) {
    const member = hostObject(value, "member", ["attemptId", "workId", "workRevision", "conversationId"]);
    hostText(member.attemptId, "member attempt"); hostText(member.workId, "member work"); positive(member.workRevision, "member revision");
    if (attempts.has(String(member.attemptId))) fail("duplicate member attempt");
    attempts.add(String(member.attemptId));
    if (member.conversationId !== null) {
      nativeId(member.conversationId);
      if (conversations.has(String(member.conversationId))) fail("worker conversation reused in fixed membership");
      conversations.add(String(member.conversationId));
    }
  }
  return structuredClone(manifest);
}
/** Correlation only: this marker grants neither authorization nor conversation identity. */
export function codexPeerReportPrefix(value: CodexPeerManifest): string {
  return `Einzbern-Codex-Peer-Manifest-SHA256: ${canonicalSha256(manifestOf(value))}\n`;
}
function observedBy(record: HostNativeRecord, cutoff: bigint): void {
  const decision = record.preparation.decision;
  if (parseStrictInstant(decision.evaluatedAt) > cutoff) fail("native preparation evaluation is after observation cutoff");
  const capabilities = decision.request.capabilities;
  const observations = [...(capabilities.selectionObservations ?? []), ...(capabilities.usage ? [capabilities.usage] : [])];
  for (const observation of observations) {
    if (parseStrictInstant(observation.observedAt) > cutoff) fail("native preparation observation is after observation cutoff");
  }
  if (dotInstant(record.preparation.attempt?.requestedAt, "requestedAt") > cutoff) fail("native preparation is after observation cutoff");
  for (const event of record.events) {
    if (dotInstant(event.at, "event at") > cutoff) fail("native event is after observation cutoff");
  }
}
function codexRecord(value: unknown): HostNativeRecord {
  const record = normalizeHostNativeRecord(value);
  if (record.preparation.decision.request.capabilities.hostKind !== "codex") fail("non-Codex record cannot enable peer coordination");
  return record;
}
function derive(input: Omit<CodexPeerBatchInput, "prior">): CodexPeerBatch {
  const cutoff = dotInstant(input.observationCutoff, "observation cutoff");
  const manifest = manifestOf(input.manifest);
  const policy = validateEngineModelPolicyFile(input.policy);
  const capacity = hostObject(input.capacity, "capacity", ["limit", "active"]);
  positive(capacity.limit, "capacity limit");
  if (capacity.active !== null && (!Number.isSafeInteger(capacity.active) || Number(capacity.active) < 0)) fail("capacity active must be observed nonnegative count or null");
  if (!Array.isArray(input.records)) fail("records must be an array");
  const records = input.records.map(codexRecord);
  for (const record of records) observedBy(record, cutoff);
  const seen = new Set<string>();
  const blockedReasons: string[] = [];
  const workRevisions = input.workRevisions ?? null;
  if (workRevisions === null) blockedReasons.push("work-revisions-unknown");
  else {
    if (!Array.isArray(workRevisions)) fail("current work revisions must be an array");
    const ids = new Set<string>();
    for (const row of workRevisions) {
      hostObject(row, "work revision", ["id", "revision"]); hostText(row.id, "work id"); positive(row.revision, "current revision");
      if (ids.has(row.id)) fail("duplicate current work revision"); ids.add(row.id);
    }
    for (const item of [{ workId: manifest.workId, workRevision: manifest.workRevision }, ...manifest.members]) {
      if (workRevisions.find(row => row.id === item.workId)?.revision !== item.workRevision) blockedReasons.push(`work-revision-drift:${item.workId}`);
    }
  }
  const identities = new Set([manifest.main.conversationId, manifest.coordinator.conversationId]);
  for (const record of records) {
    const attempt = record.preparation.attempt!;
    const member = manifest.members.find(row => row.attemptId === attempt.id);
    if (!member || seen.has(attempt.id)) fail("unexpected or duplicate worker attempt");
    seen.add(attempt.id);
    const request = record.preparation.decision.request;
    if (request.workId !== member.workId || request.workRevision !== member.workRevision) fail("member work revision drift");
    const observedIds = new Set(record.events.filter(event => event.providerId).map(event => {
      const id = atPointer(event.raw, event.providerId!.pointer); nativeId(id); return String(id);
    }));
    if (observedIds.size > 1 || (member.conversationId !== null && [...observedIds].some(id => id !== member.conversationId))) blockedReasons.push(`native-identity-drift:${attempt.id}`);
    if (observedIds.size === 0) blockedReasons.push(`native-identity-unknown:${attempt.id}`);
    for (const id of observedIds) {
      if (identities.has(id)) blockedReasons.push(`native-identity-reused:${attempt.id}`);
      identities.add(id);
    }
    if (record.conflicts.length > 0) blockedReasons.push(`native-conflict:${attempt.id}`);
  }
  for (const member of manifest.members) if (!seen.has(member.attemptId)) blockedReasons.push(`member-outcome-unknown:${member.attemptId}`);
  const readiness = codexPeerReadiness(manifest.host, policy.hosts.codex);
  if (!readiness.ready) blockedReasons.push("model-groups-not-ready");
  // Requested intent for the host-supported peer creation/selection, never an assertion that
  // a conversation actually ran this model or that the host exposes that selection today.
  const requestedPeers = readiness.ready ? {
    main: resolveEngineExecutionPolicyFromSnapshot(policy, { host: "codex", category: "main", rejections: 0 }).record,
    coordinator: resolveEngineExecutionPolicyFromSnapshot(policy, { host: "codex", category: "economy", rejections: 0 }).record,
  } : null;
  if (policy.hosts.codex?.digest !== manifest.policyDigest) blockedReasons.push("policy-drift");
  const occupancy = manifest.members.length - records.filter(record => record.occupancy === "released").length;
  if (capacity.active === null) blockedReasons.push("capacity-unknown");
  else if (Number(capacity.active) > Number(capacity.limit) || occupancy > Number(capacity.limit)) blockedReasons.push("capacity-exceeded");
  const allTerminal = records.length === manifest.members.length && records.every(record => record.executionFinality === "confirmed");
  let delivery: CodexPeerDelivery | null = null;
  let deliveryStatus: "not-attempted" | "unknown" | "confirmed" | "failed" = "not-attempted";
  if (input.delivery != null) {
    const d = hostObject(input.delivery, "delivery", ["record", "recipientPointer", "correlationPointer", "batchId", "batchAttemptId"]);
    const record = codexRecord(d.record);
    observedBy(record, cutoff);
    if (record.preparation.decision.request.action !== "coordination") fail("delivery must be an actual coordination attempt");
    const attempt = record.preparation.attempt!;
    if (d.batchId !== manifest.batchId || d.batchAttemptId !== manifest.attemptId || record.preparation.decision.request.workId !== manifest.workId || record.preparation.decision.request.workRevision !== manifest.workRevision || seen.has(attempt.id)) fail("delivery belongs to another batch/work attempt");
    if (atPointer(attempt.argumentsValue, String(d.recipientPointer)) !== manifest.main.conversationId) fail("delivery recipient differs from main conversation");
    const text = atPointer(attempt.argumentsValue, String(d.correlationPointer));
    if (typeof text !== "string" || !text.startsWith(codexPeerReportPrefix(manifest))) fail("delivery text does not bind the immutable batch manifest");
    delivery = { record, recipientPointer: String(d.recipientPointer), correlationPointer: String(d.correlationPointer), batchId: manifest.batchId, batchAttemptId: manifest.attemptId };
    deliveryStatus = record.executionFinality !== "confirmed" ? "unknown" : record.execution === "completed" ? "confirmed" : "failed";
    if (!allTerminal) blockedReasons.push("delivery-before-terminal-batch");
  }
  const payload = {
    schemaVersion: "tcrn.codex-peer-batch.v1" as const,
    observationCutoff: input.observationCutoff,
    manifest, records, policy, capacity: { limit: Number(capacity.limit), active: capacity.active === null ? null : Number(capacity.active) },
    delivery, workRevisions, readiness, requestedPeers, reportPrefix: codexPeerReportPrefix(manifest), blockedReasons, allTerminal, deliveryStatus,
    reportEligible: allTerminal && blockedReasons.length === 0 && delivery === null,
    occupancy,
    authority: "receipt-only-not-execution-authorization" as const,
  };
  return { ...payload, digest: canonicalSha256(payload) };
}
export interface CodexPeerBatch {
  readonly observationCutoff: string;
  readonly schemaVersion: "tcrn.codex-peer-batch.v1";
  readonly manifest: CodexPeerManifest;
  readonly records: readonly HostNativeRecord[];
  readonly policy: EngineModelPolicyFile;
  readonly capacity: { readonly limit: number; readonly active: number | null };
  readonly delivery: CodexPeerDelivery | null;
  readonly workRevisions: CodexPeerBatchInput["workRevisions"] | null;
  readonly readiness: ReturnType<typeof codexPeerReadiness>;
  readonly requestedPeers: {
    readonly main: ReturnType<typeof resolveEngineExecutionPolicyFromSnapshot>["record"];
    readonly coordinator: ReturnType<typeof resolveEngineExecutionPolicyFromSnapshot>["record"];
  } | null;
  readonly reportPrefix: string;
  readonly blockedReasons: readonly string[];
  readonly allTerminal: boolean;
  readonly deliveryStatus: "not-attempted" | "unknown" | "confirmed" | "failed";
  readonly reportEligible: boolean;
  readonly occupancy: number;
  readonly authority: "receipt-only-not-execution-authorization";
  readonly digest: string;
}
/** Recompute derived fields; a file cannot declare itself complete or authorized. */
export function normalizeCodexPeerBatch(value: unknown): CodexPeerBatch {
  const row = hostObject(value, "peer receipt", ["schemaVersion", "observationCutoff", "manifest", "records", "policy", "capacity", "delivery", "workRevisions", "readiness", "requestedPeers", "reportPrefix", "blockedReasons", "allTerminal", "deliveryStatus", "reportEligible", "occupancy", "authority", "digest"]);
  if (row.schemaVersion !== "tcrn.codex-peer-batch.v1") fail("unknown receipt version");
  const calculated = derive({ ...row, workRevisions: row.workRevisions ?? undefined } as unknown as CodexPeerBatchInput);
  if (canonicalSha256(calculated) !== canonicalSha256(row)) fail("receipt differs from retained native evidence");
  return calculated;
}
/** Monotonic merge of same-batch receipts. Unknown delivery is retained, never retried by us. */
export function recordCodexPeerBatch(input: CodexPeerBatchInput): CodexPeerBatch {
  const prior = input.prior === undefined ? null : normalizeCodexPeerBatch(input.prior);
  const cutoff = dotInstant(input.observationCutoff, "observation cutoff");
  if (prior && cutoff < dotInstant(prior.observationCutoff, "prior observation cutoff")) fail("observation cutoff moved backwards; reconcile the clock before resuming");
  const manifest = manifestOf(input.manifest);
  if (prior && canonicalSha256(prior.manifest) !== canonicalSha256(manifest)) fail("immutable manifest changed; reconcile instead of redispatching");
  const records = [...(prior?.records ?? [])];
  for (const value of input.records) {
    const next = codexRecord(value);
    const index = records.findIndex(record => record.preparation.attempt?.id === next.preparation.attempt?.id);
    if (index === -1) records.push(next);
    else records[index] = recordHostNativeEvents(next.preparation, next.events, records[index]);
  }
  let delivery = input.delivery ?? prior?.delivery ?? null;
  if (prior?.delivery && input.delivery) {
    if (input.delivery.batchId !== prior.delivery.batchId || input.delivery.batchAttemptId !== prior.delivery.batchAttemptId || input.delivery.recipientPointer !== prior.delivery.recipientPointer || input.delivery.correlationPointer !== prior.delivery.correlationPointer) fail("delivery association changed");
    delivery = { ...input.delivery, record: recordHostNativeEvents(input.delivery.record.preparation, input.delivery.record.events, prior.delivery.record) };
  }
  return derive({ ...input, manifest, records, delivery });
}
