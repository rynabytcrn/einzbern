import { isEngineVersion, compareSemver } from "./format-version.js";
// SPDX-License-Identifier: Apache-2.0
import { assertStrictInstant, canonicalJson, parseStrictInstant } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";
import type { WorkspaceState } from "./workspace.js";
import type { TemplateDefinition } from "./template-admission.js";
import { contentFail, WORK_CONTENT_VERSION } from "./work-content.js";
import type { ContentWorkKind } from "./work-content.js";

export const WORK_CONTENT_POLICY_KEY = "work.contentPolicy" as const;
export const WORK_CONTENT_POLICY_VERSION = "tcrn.work-content-policy.v2" as const;
export interface WorkContentPolicy {
  readonly schemaVersion: typeof WORK_CONTENT_POLICY_VERSION | "tcrn.work-content-policy.v1";
  readonly rollout?: WorkContentRolloutObservation;
  readonly enabledAt: string;
  readonly scopeWorkIds: readonly string[];
  readonly inFlightWorkIds: readonly string[];
  readonly defaults: Readonly<Record<ContentWorkKind, { readonly templateId: string; readonly templateVersion: number }>>;
  readonly decision: string;
}
export function defaultWorkContentTemplate(kind: ContentWorkKind): TemplateDefinition {
  return { schemaVersion: "tcrn.template.v2", id: `minimum-${kind.toLowerCase()}`, version: 1, appliesTo: [kind], headings: [], acceptanceHeadings: [], referenceHeadings: [], couplings: [], contentSchema: WORK_CONTENT_VERSION };
}
export function validateWorkContentPolicy(value: unknown): WorkContentPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) contentFail("WORK_CONTENT_POLICY_INVALID", "policy must be an object");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["schemaVersion", "enabledAt", "decision", "scopeWorkIds", "inFlightWorkIds", "defaults", "rollout"].includes(key))) contentFail("WORK_CONTENT_POLICY_INVALID", "unknown policy field");
  if (![WORK_CONTENT_POLICY_VERSION, "tcrn.work-content-policy.v1"].includes(String(p.schemaVersion)) || typeof p.enabledAt !== "string" || typeof p.decision !== "string" || !p.decision.trim()) contentFail("WORK_CONTENT_POLICY_INVALID", "policy schema, enabledAt and actual decision are required");
  assertStrictInstant(p.enabledAt);
  for (const key of ["scopeWorkIds", "inFlightWorkIds"]) if (!Array.isArray(p[key]) || !(p[key] as unknown[]).every(v => typeof v === "string" && /^work:[a-f0-9]{24}$/u.test(v)) || new Set(p[key] as string[]).size !== (p[key] as string[]).length) contentFail("WORK_CONTENT_POLICY_INVALID", `${key} must contain unique work ids`);
  if (typeof p.defaults !== "object" || p.defaults === null || Array.isArray(p.defaults)) contentFail("WORK_CONTENT_POLICY_INVALID", "defaults required");
  if (Object.keys(p.defaults).some(k => !["Initiative", "Epic", "Story", "Subtask"].includes(k))) contentFail("WORK_CONTENT_POLICY_INVALID", "unknown default kind");
  for (const kind of ["Initiative", "Epic", "Story", "Subtask"]) {
    const d = (p.defaults as Record<string, unknown>)[kind] as Record<string, unknown> | undefined;
    if (!d || Object.keys(d).some(k => !["templateId", "templateVersion"].includes(k)) || typeof d.templateId !== "string" || !/^[a-z][a-z0-9.-]+$/u.test(d.templateId) || !Number.isSafeInteger(d.templateVersion) || Number(d.templateVersion) < 1) contentFail("WORK_CONTENT_POLICY_INVALID", `default ${kind} missing or invalid`);
  }
  if (p.schemaVersion === "tcrn.work-content-policy.v2") validateWorkContentRolloutObservation(p.rollout);
  else if (p.rollout !== undefined) contentFail("WORK_CONTENT_POLICY_INVALID", "rollout requires policy v2");
  return value as unknown as WorkContentPolicy;
}
export function normalizeWorkContentPolicy(value: string): string { return canonicalJson(validateWorkContentPolicy(JSON.parse(value))); }
/** Explicit project setting only. No global switch implicitly opts unrelated projects in. */
export function readWorkContentPolicy(state: Pick<WorkspaceState, "settings">, projectId: string): WorkContentPolicy | null {
  const setting = state.settings.find(s => s.key === WORK_CONTENT_POLICY_KEY && s.projectId === projectId);
  return setting ? validateWorkContentPolicy(JSON.parse(setting.value)) : null;
}
export function workContentPolicyApplies(policy: WorkContentPolicy | null, record: Pick<WorkRecord, "id" | "parentId" | "createdAt" | "status">, work: readonly WorkRecord[], isNew = false, admissionAt = new Date().toISOString()): boolean {
  if (!policy || (isNew && parseStrictInstant(admissionAt) < parseStrictInstant(policy.enabledAt)) || (!isNew && (record.status === "done" || record.status === "cancelled"))) return false;
  if (!isNew && policy.inFlightWorkIds.includes(record.id)) return true;
  if (!isNew && (!record.createdAt || parseStrictInstant(record.createdAt) < parseStrictInstant(policy.enabledAt))) return false;
  if (!policy.scopeWorkIds.length) return true;
  let id: string | null = record.id;
  const seen = new Set<string>();
  while (id !== null && !seen.has(id)) { if (policy.scopeWorkIds.includes(id)) return true; seen.add(id); id = id === record.id ? record.parentId : work.find(w => w.id === id)?.parentId ?? null; }
  return false;
}

// Negative compatibility baseline: independent INIT068 old-writer probe observed pre-feature 3.2.0 omitted-binding writes succeeding.
// This is not a capable release declaration; every higher version still needs actual delivery/build/behavior evidence.
const LAST_OBSERVED_UNSUPPORTED_WORK_CONTENT_RELEASE = "3.2.0";

export interface WorkContentRolloutObservation {
  readonly schemaVersion: "tcrn.work-content-rollout-observation.v1";
  readonly observedAt: string;
  readonly capableRelease: { readonly version: string | null; readonly buildDigest: string | null; readonly evidence: string | null; readonly delivery: "pending" | "verified" };
  readonly knownIncapableVersions: readonly string[];
  readonly inventory: { readonly complete: boolean; readonly evidence: string; readonly unresolvedPaths: readonly string[] };
  readonly writers: readonly { readonly id: string; readonly kind: "client" | "process" | "entry" | "offline-copy" | "direct-sync"; readonly path: string; readonly engineVersion: string | null; readonly buildDigest: string | null; readonly upgradeEvidence: string | null; readonly state: "upgraded" | "disabled" | "restricted" | "unknown"; readonly restrictionEvidence: string | null }[];
  readonly barrier: { readonly settingVersion: string; readonly oldWriterRefusalEvidence: string; readonly effectiveStateEvidence: string; readonly manifestEvidence: string };
  readonly boundary: { readonly headEventHash: string | null; readonly versionVector: Readonly<Record<string, number>> };
}
export interface WorkContentRolloutReadiness {
  readonly schemaVersion: "tcrn.work-content-rollout-readiness.v1";
  readonly ready: boolean;
  readonly problems: readonly string[];
  readonly engineVersion: string;
  readonly settingFloor: string | null;
  readonly manifestFloor: string | null;
  readonly effectiveFloor: string | null;
  readonly capableVersion: string | null;
  readonly acceptedBoundary: WorkContentRolloutObservation["boundary"] | null;
  readonly observationValidation: "structural-evidence-links-only";
  readonly authentication: "not-provided";
  readonly unseenWriters: "not-proven-absent";
}
function rolloutObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) contentFail("WORK_CONTENT_ROLLOUT_INVALID", `${label} must be an object`);
  return value as Record<string, unknown>;
}
export function validateWorkContentRolloutObservation(value: unknown): WorkContentRolloutObservation {
  const v = rolloutObject(value, "observation");
  if (v.schemaVersion !== "tcrn.work-content-rollout-observation.v1") contentFail("WORK_CONTENT_ROLLOUT_INVALID", "unsupported rollout observation");
  assertStrictInstant(v.observedAt);
  const release = rolloutObject(v.capableRelease, "capableRelease");
  if (!["pending", "verified"].includes(String(release.delivery))) contentFail("WORK_CONTENT_ROLLOUT_INVALID", "release delivery state");
  for (const k of ["version", "buildDigest", "evidence"]) if (release[k] !== null && typeof release[k] !== "string") contentFail("WORK_CONTENT_ROLLOUT_INVALID", `release.${k}`);
  const inventory = rolloutObject(v.inventory, "inventory");
  if (typeof inventory.complete !== "boolean" || typeof inventory.evidence !== "string" || !Array.isArray(inventory.unresolvedPaths) || !inventory.unresolvedPaths.every(p => typeof p === "string")) contentFail("WORK_CONTENT_ROLLOUT_INVALID", "inventory fields");
  if (!Array.isArray(v.knownIncapableVersions) || !v.knownIncapableVersions.every(isEngineVersion) || !Array.isArray(v.writers)) contentFail("WORK_CONTENT_ROLLOUT_INVALID", "writer/version inventory");
  const ids = new Set<string>();
  for (const row of v.writers) {
    const w = rolloutObject(row, "writer");
    if (typeof w.id !== "string" || !w.id.trim() || ids.has(w.id) || typeof w.path !== "string" || !["client", "process", "entry", "offline-copy", "direct-sync"].includes(String(w.kind)) || !["upgraded", "disabled", "restricted", "unknown"].includes(String(w.state))) contentFail("WORK_CONTENT_ROLLOUT_INVALID", "writer identity/kind/state");
    ids.add(w.id);
    for (const k of ["engineVersion", "buildDigest", "upgradeEvidence", "restrictionEvidence"]) if (w[k] !== null && typeof w[k] !== "string") contentFail("WORK_CONTENT_ROLLOUT_INVALID", `writer.${k}`);
  }
  const barrier = rolloutObject(v.barrier, "barrier");
  for (const k of ["settingVersion", "oldWriterRefusalEvidence", "effectiveStateEvidence", "manifestEvidence"]) if (typeof barrier[k] !== "string") contentFail("WORK_CONTENT_ROLLOUT_INVALID", `barrier.${k}`);
  const boundary = rolloutObject(v.boundary, "boundary");
  if (boundary.headEventHash !== null && (typeof boundary.headEventHash !== "string" || !/^[a-f0-9]{64}$/u.test(boundary.headEventHash))) contentFail("WORK_CONTENT_ROLLOUT_INVALID", "boundary head");
  const vector = rolloutObject(boundary.versionVector, "versionVector");
  if (Object.values(vector).some(n => !Number.isSafeInteger(n) || Number(n) < 0)) contentFail("WORK_CONTENT_ROLLOUT_INVALID", "boundary vector");
  return value as WorkContentRolloutObservation;
}
/** Observation validation, not host authentication or a cross-device lock. */
export function workContentRolloutReadiness(state: Pick<WorkspaceState, "settings" | "headEventHash" | "library">, observation: unknown, options: { readonly engineVersion: string; readonly manifestMinEngineVersion: string | null; readonly requireCurrentBoundary?: boolean }): WorkContentRolloutReadiness {
  const problems: string[] = [];
  const settingFloor = state.settings.find(s => s.key === "engine.requiredVersion" && s.projectId === undefined)?.value ?? null;
  const manifestFloor = options.manifestMinEngineVersion;
  const floors = [settingFloor, manifestFloor].filter((v): v is string => v !== null && isEngineVersion(v));
  const effectiveFloor = floors.length ? floors.reduce((a, b) => compareSemver(a, b) >= 0 ? a : b) : null;
  let o: WorkContentRolloutObservation | null = null;
  try { o = validateWorkContentRolloutObservation(observation); } catch { problems.push("ROLLOUT_OBSERVATION_MISSING_OR_INVALID"); }
  const capableVersion = o?.capableRelease.version ?? null;
  if (!isEngineVersion(settingFloor)) problems.push("LIBRARY_SETTING_FLOOR_MISSING");
  if (!isEngineVersion(manifestFloor)) problems.push("MANIFEST_FLOOR_UNOBSERVED");
  if (!isEngineVersion(capableVersion) || o?.capableRelease.delivery !== "verified" || !o.capableRelease.evidence?.trim() || !/^[a-f0-9]{64}$/u.test(o.capableRelease.buildDigest ?? "")) problems.push("CAPABLE_DELIVERY_UNVERIFIED");
  if (isEngineVersion(capableVersion)) {
    if (!effectiveFloor || compareSemver(effectiveFloor, capableVersion) < 0 || !settingFloor || compareSemver(settingFloor, capableVersion) < 0) problems.push("LIBRARY_FLOOR_BELOW_CAPABLE_VERSION");
    if (!isEngineVersion(options.engineVersion) || compareSemver(options.engineVersion, capableVersion) < 0) problems.push("RUNNING_ENGINE_BELOW_CAPABLE_VERSION");
  }
  if (effectiveFloor && (!isEngineVersion(options.engineVersion) || compareSemver(options.engineVersion, effectiveFloor) < 0)) problems.push("RUNNING_ENGINE_BELOW_EFFECTIVE_FLOOR");
  if (o) {
    if (!o.knownIncapableVersions.length || !isEngineVersion(capableVersion) || compareSemver(capableVersion, LAST_OBSERVED_UNSUPPORTED_WORK_CONTENT_RELEASE) <= 0 || o.knownIncapableVersions.some(v => compareSemver(capableVersion, v) <= 0)) problems.push("CAPABLE_VERSION_NOT_DISTINGUISHABLE");
    if (!o.inventory.complete || !o.inventory.evidence.trim() || o.inventory.unresolvedPaths.length || !o.writers.length) problems.push("WRITER_INVENTORY_UNRESOLVED");
    for (const w of o.writers) {
      if (!w.path.trim() || w.state === "unknown") problems.push(`WRITER_UNRESOLVED:${w.id}`);
      if (w.state === "upgraded") {
        if (!isEngineVersion(w.engineVersion) || !isEngineVersion(capableVersion) || compareSemver(w.engineVersion, capableVersion) < 0 || !/^[a-f0-9]{64}$/u.test(w.buildDigest ?? "") || !w.upgradeEvidence?.trim()) problems.push(`WRITER_UPGRADE_UNVERIFIED:${w.id}`);
        if (["offline-copy", "direct-sync", "process", "entry"].includes(w.kind) && !w.restrictionEvidence?.trim()) problems.push(`OLD_ENTRY_RESTRICTION_UNVERIFIED:${w.id}`);
      } else if (["disabled", "restricted"].includes(w.state) && !w.restrictionEvidence?.trim()) problems.push(`WRITER_RESTRICTION_UNVERIFIED:${w.id}`);
    }
    if (o.barrier.settingVersion !== settingFloor || !o.barrier.oldWriterRefusalEvidence.trim() || !o.barrier.effectiveStateEvidence.trim() || !o.barrier.manifestEvidence.trim()) problems.push("BARRIER_EFFECT_UNVERIFIED");
    const vector = state.library?.versionVector ?? {};
    if (options.requireCurrentBoundary !== false) {
      if (o.boundary.headEventHash !== state.headEventHash || canonicalJson(o.boundary.versionVector) !== canonicalJson(vector)) problems.push("ACCEPTED_BOUNDARY_STALE_REFRESH_REQUIRED");
    } else if (Object.entries(o.boundary.versionVector).some(([id, seq]) => (vector[id] ?? 0) < seq)) problems.push("ACCEPTED_BOUNDARY_NOT_PRESENT");
  }
  return { schemaVersion: "tcrn.work-content-rollout-readiness.v1", ready: problems.length === 0, problems, engineVersion: options.engineVersion, settingFloor, manifestFloor, effectiveFloor, capableVersion, acceptedBoundary: o?.boundary ?? null, observationValidation: "structural-evidence-links-only", authentication: "not-provided", unseenWriters: "not-proven-absent" };
}
