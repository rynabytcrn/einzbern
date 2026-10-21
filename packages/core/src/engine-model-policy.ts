// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INIT-056 (MIN-289 D1/D2): engine-wide model policy. This is device state, not a
// library setting: one atomic file holds an independent category mother, tiers table and escalation
// tuple for each host. Project models.* records remain readable history/compatibility input, but do
// not become a second engine policy store.

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { assertStrictInstant, canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";
import { deviceHome, engineModelPolicyLockPath, engineModelPolicyPath } from "./device-home.js";
import { withFileLock } from "./file-lock.js";
import { assertActorId } from "./actor-attestation.js";
import { MODELS_ESCALATION_THRESHOLD_MAX, resolveModelsTier, validateModelsEscalationCeiling } from "./models-escalation.js";
import { validateModelsCategory } from "./models-category.js";
import { validateModelsTiers } from "./models-tiers.js";
import type { ModelsCategories } from "./models-category.js";
import type { ModelsTiers } from "./models-tiers.js";
import { DEFAULT_ENGINE_QUOTA_POLICY, validateEngineQuotaPolicy } from "./execution-policy.js";
import type { EngineQuotaPolicy } from "./execution-policy.js";
import type { ModelsTierResolution } from "./models-escalation.js";
import { writeFileAtomic } from "./atomic-file.js";
import type { VerifiedWriteAuthorization } from "./write-authorization.js";

export const ENGINE_MODEL_POLICY_SCHEMA_VERSION = "tcrn.engine-model-policy.v1" as const;
export const ENGINE_MODEL_POLICY_TRANSACTION_VERSION = "tcrn.engine-model-policy.v2" as const;
export const ENGINE_MODEL_POLICY_CATALOG_VERSION = "tcrn.engine-model-policy-catalog.v1" as const;
export const ENGINE_MODEL_POLICY_WRITE_TARGET = "models.engine-policy" as const;

export const ENGINE_MODEL_POLICY_REASON_CODES = Object.freeze([
  "ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED",
  "ENGINE_MODEL_POLICY_FILE_INVALID",
  "ENGINE_MODEL_POLICY_HOST_INVALID",
  "ENGINE_MODEL_POLICY_INVALID",
  "ENGINE_MODEL_POLICY_UNAVAILABLE",
  "ENGINE_MODEL_POLICY_CAS_CONFLICT",
  "ENGINE_MODEL_POLICY_OPERATION_CONFLICT",
  "ENGINE_MODEL_POLICY_SAVE_FAILED",
  "ENGINE_MODEL_POLICY_SAVE_RECONCILIATION_REQUIRED",
] as const);
export type EngineModelPolicyReasonCode = typeof ENGINE_MODEL_POLICY_REASON_CODES[number];

export class EngineModelPolicyError extends Error {
  readonly reasonCode: EngineModelPolicyReasonCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reasonCode: EngineModelPolicyReasonCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "EngineModelPolicyError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface EngineModelPolicyConfig {
  /** Optional on historical entries; absence uses separately reported engine defaults. */
  readonly quota?: EngineQuotaPolicy;
  readonly categories: ModelsCategories;
  readonly tiers: ModelsTiers;
  readonly escalation: {
    readonly enabled: boolean;
    readonly threshold: number;
    readonly ceiling: string;
  };
}

export interface EngineModelPolicyEntry extends EngineModelPolicyConfig {
  readonly revision: number;
  /** SHA-256 over host plus categories, tiers and escalation. */
  readonly digest: string;
  readonly updatedAt: string;
  readonly actor: string;
  readonly decidedIn: string;
  readonly decidedInLibraryId: string;
}

export interface EngineModelPolicyFile {
  readonly schemaVersion: typeof ENGINE_MODEL_POLICY_SCHEMA_VERSION | typeof ENGINE_MODEL_POLICY_TRANSACTION_VERSION;
  /** Increments once per host write, giving the whole file a monotonic revision. */
  readonly revision: number;
  readonly hosts: Readonly<Record<string, EngineModelPolicyEntry>>;
  readonly operations?: Readonly<Record<string, EngineModelPolicyOperation>>;
}

export interface EngineModelPolicyCatalog {
  readonly schemaVersion: typeof ENGINE_MODEL_POLICY_CATALOG_VERSION;
  readonly source: { readonly kind: "device-engine"; readonly path: string };
  readonly storeRevision: number;
  readonly hosts: Readonly<Record<string, EngineModelPolicyEntry>>;
  readonly compatibility: {
    readonly projectModelSettings: "read-only-compatibility-input";
    readonly precedence: "configured-device-host-policy-if-present";
    readonly projectOverrideAllowed: false;
  };
  readonly selectedHost?: string;
  readonly selectedPolicy?: EngineModelPolicyEntry | null;
  readonly selectedStatus?: "configured" | "unconfigured";
}

const HOST_ID = /^[a-z][a-z0-9._-]*$/u;
const LIBRARY_ID = /^(?:library|workspace):[a-f0-9]{24}$/u;
const DECISION_ID = /^minutes:[a-f0-9]{24}#D[1-9][0-9]*$/u;
const STORE_FIELDS = "hosts,revision,schemaVersion";
const ENTRY_FIELDS = "actor,categories,decidedIn,decidedInLibraryId,digest,escalation,revision,tiers,updatedAt";
const CONFIG_FIELDS = "categories,escalation,tiers";
const ESCALATION_FIELDS = "ceiling,enabled,threshold";

function fail(reasonCode: EngineModelPolicyReasonCode, message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new EngineModelPolicyError(reasonCode, message, details);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ENGINE_MODEL_POLICY_INVALID", `${path} must be an object`, { path });
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Readonly<Record<string, unknown>>, fields: string, path: string): void {
  if (Object.keys(value).sort().join(",") !== fields) {
    fail("ENGINE_MODEL_POLICY_INVALID", `${path} requires exactly ${fields.split(",").join(", ")}`, { path });
  }
}

function hostId(value: unknown): string {
  if (typeof value !== "string" || !HOST_ID.test(value)) {
    fail("ENGINE_MODEL_POLICY_HOST_INVALID", "host must be a lowercase id", { host: String(value) });
  }
  return value;
}

function safeRevision(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("ENGINE_MODEL_POLICY_FILE_INVALID", `${path} must be an integer of at least ${minimum}`, { path });
  }
  return value;
}

function policyDigest(host: string, config: EngineModelPolicyConfig): string {
  return canonicalSha256({ host, categories: config.categories, tiers: config.tiers, escalation: config.escalation, ...(config.quota === undefined ? {} : { quota: config.quota }) });
}

/** Validate one closed host policy, including all category references and runner isolation. */
export function validateEngineModelPolicy(hostValue: unknown, value: unknown): EngineModelPolicyConfig {
  const host = hostId(hostValue);
  const input = object(value, "policy");
  exactFields(input, Object.hasOwn(input, "quota") ? "categories,escalation,quota,tiers" : CONFIG_FIELDS, "policy");
  const quota = Object.hasOwn(input, "quota") ? validateEngineQuotaPolicy(input.quota) : undefined;
  const categories = validateModelsCategory(input.categories);
  const tiers = validateModelsTiers(input.tiers);
  const escalation = object(input.escalation, "policy.escalation");
  exactFields(escalation, ESCALATION_FIELDS, "policy.escalation");
  if (typeof escalation.enabled !== "boolean") {
    fail("ENGINE_MODEL_POLICY_INVALID", "policy.escalation.enabled must be boolean", { path: "policy.escalation.enabled" });
  }
  if (typeof escalation.threshold !== "number" || !Number.isSafeInteger(escalation.threshold) || escalation.threshold < 1 || escalation.threshold > MODELS_ESCALATION_THRESHOLD_MAX) {
    fail("ENGINE_MODEL_POLICY_INVALID", `policy.escalation.threshold must be an integer from 1 to ${MODELS_ESCALATION_THRESHOLD_MAX}`, { path: "policy.escalation.threshold" });
  }
  if (typeof escalation.ceiling !== "string") fail("ENGINE_MODEL_POLICY_INVALID", "policy.escalation.ceiling must be a category id string", { path: "policy.escalation.ceiling" });
  const ceiling = validateModelsEscalationCeiling(escalation.ceiling);
  const categoriesById = new Set(categories.map((category) => category.id));
  if (!categoriesById.has(ceiling)) {
    fail("ENGINE_MODEL_POLICY_INVALID", `policy.escalation.ceiling ${ceiling} is not in this host's category table`, { path: "policy.escalation.ceiling", host, category: ceiling });
  }
  for (const [index, tier] of tiers.entries()) {
    if (tier.runner !== host) {
      fail("ENGINE_MODEL_POLICY_INVALID", `policy.tiers[${index}].runner must equal host ${host}`, { path: `policy.tiers[${index}].runner`, host, runner: tier.runner });
    }
    if (!categoriesById.has(tier.category)) {
      fail("ENGINE_MODEL_POLICY_INVALID", `policy.tiers[${index}].category is not in this host's category table`, { path: `policy.tiers[${index}].category`, host, category: tier.category });
    }
  }
  return Object.freeze({
    categories,
    tiers,
    ...(quota === undefined ? {} : { quota }),
    escalation: Object.freeze({ enabled: escalation.enabled, threshold: escalation.threshold, ceiling }),
  });
}

function emptyFile(): EngineModelPolicyFile {
  return Object.freeze({ schemaVersion: ENGINE_MODEL_POLICY_SCHEMA_VERSION, revision: 0, hosts: Object.freeze({}) });
}

/** Validate the on-disk closed schema and every host's revision, audit and content digest. */
export function validateEngineModelPolicyFile(value: unknown): EngineModelPolicyFile {
  const record = object(value, "engine model policy file");
  const transactional = record.schemaVersion === ENGINE_MODEL_POLICY_TRANSACTION_VERSION;
  exactFields(record, transactional ? "hosts,operations,revision,schemaVersion" : STORE_FIELDS, "engine model policy file");
  if (record.schemaVersion !== ENGINE_MODEL_POLICY_SCHEMA_VERSION && !transactional) {
    fail("ENGINE_MODEL_POLICY_FILE_INVALID", `schemaVersion must be ${ENGINE_MODEL_POLICY_SCHEMA_VERSION}`);
  }
  const revision = safeRevision(record.revision, "revision", 0);
  const hostsValue = object(record.hosts, "hosts");
  const hosts: Record<string, EngineModelPolicyEntry> = {};
  for (const [rawHost, rawEntry] of Object.entries(hostsValue)) {
    const host = hostId(rawHost);
    const entry = object(rawEntry, `hosts.${host}`);
    exactFields(entry, Object.hasOwn(entry, "quota") ? "actor,categories,decidedIn,decidedInLibraryId,digest,escalation,quota,revision,tiers,updatedAt" : ENTRY_FIELDS, `hosts.${host}`);
    const entryRevision = safeRevision(entry.revision, `hosts.${host}.revision`, 1);
    if (entryRevision > revision) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.revision exceeds file revision`, { host });
    if (typeof entry.updatedAt !== "string") fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.updatedAt must be an instant`, { host });
    try { assertStrictInstant(entry.updatedAt); } catch { fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.updatedAt must be a strict UTC instant`, { host }); }
    try { assertActorId(entry.actor); } catch { fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.actor is not an actor id`, { host }); }
    if (typeof entry.decidedIn !== "string" || !DECISION_ID.test(entry.decidedIn)) {
      fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.decidedIn must be a minutes decision address`, { host });
    }
    if (typeof entry.decidedInLibraryId !== "string" || !LIBRARY_ID.test(entry.decidedInLibraryId)) {
      fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.decidedInLibraryId must be a library id`, { host });
    }
    const config = validateEngineModelPolicy(host, {
      categories: entry.categories,
      tiers: entry.tiers,
      escalation: entry.escalation,
      ...(Object.hasOwn(entry, "quota") ? { quota: entry.quota } : {}),
    });
    const digest = policyDigest(host, config);
    if (entry.digest !== digest) fail("ENGINE_MODEL_POLICY_FILE_INVALID", `hosts.${host}.digest does not match its policy`, { host, expected: digest });
    hosts[host] = Object.freeze({
      ...config,
      revision: entryRevision,
      digest,
      updatedAt: entry.updatedAt,
      actor: entry.actor,
      decidedIn: entry.decidedIn,
      decidedInLibraryId: entry.decidedInLibraryId,
    });
  }
  if ((Object.keys(hosts).length === 0) !== (revision === 0)) {
    fail("ENGINE_MODEL_POLICY_FILE_INVALID", "an empty store has revision zero and a configured store has a positive revision");
  }
  const operations: Record<string, EngineModelPolicyOperation> = {};
  if (transactional) {
    for (const [id, value] of Object.entries(object(record.operations, "operations"))) {
      const operation = validatePolicyOperation(id, value);
      if (operation.storeRevision > revision) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "operation revision exceeds store");
      operations[id] = operation;
    }
  }
  return Object.freeze({ schemaVersion: transactional ? ENGINE_MODEL_POLICY_TRANSACTION_VERSION : ENGINE_MODEL_POLICY_SCHEMA_VERSION, revision, hosts: Object.freeze(hosts), ...(transactional ? { operations: Object.freeze(operations) } : {}) });
}

/** The current device's single file; an absent file means no engine policy has been configured yet. */
export async function readEngineModelPolicyFile(home: string = deviceHome()): Promise<EngineModelPolicyFile> {
  let text: string;
  try {
    text = await readFile(engineModelPolicyPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyFile();
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("ENGINE_MODEL_POLICY_FILE_INVALID", `${engineModelPolicyPath(home)} is not JSON`); }
  return validateEngineModelPolicyFile(parsed);
}

/** Build a catalog from one validated snapshot, including a write's lock-held readback. */
export function engineModelPolicyCatalogFromSnapshot(
  fileValue: EngineModelPolicyFile,
  hostValue?: string,
  home: string = deviceHome(),
): EngineModelPolicyCatalog {
  const file = validateEngineModelPolicyFile(fileValue);
  const hosts = Object.fromEntries(Object.entries(file.hosts).sort(([left], [right]) => left.localeCompare(right)));
  const host = hostValue === undefined ? undefined : hostId(hostValue);
  const hasSelectedHost = host !== undefined && Object.hasOwn(file.hosts, host);
  return Object.freeze({
    schemaVersion: ENGINE_MODEL_POLICY_CATALOG_VERSION,
    source: Object.freeze({ kind: "device-engine", path: engineModelPolicyPath(home) }),
    storeRevision: file.revision,
    hosts: Object.freeze(hosts),
    compatibility: Object.freeze({
      projectModelSettings: "read-only-compatibility-input",
      precedence: "configured-device-host-policy-if-present",
      projectOverrideAllowed: false,
    }),
    ...(host === undefined ? {} : {
      selectedHost: host,
      selectedPolicy: hasSelectedHost ? file.hosts[host] : null,
      selectedStatus: hasSelectedHost ? "configured" as const : "unconfigured" as const,
    }),
  });
}

/** A host-aware catalog view; callers may request a syntactically valid but unconfigured host. */
export async function readEngineModelPolicyCatalog(hostValue?: string, home: string = deviceHome()): Promise<EngineModelPolicyCatalog> {
  return engineModelPolicyCatalogFromSnapshot(await readEngineModelPolicyFile(home), hostValue, home);
}

/**
 * Replace one host policy in the device store. The CLI supplies a verified Owner decision and the
 * actual actor; the core checks that receipt's shape again before writing and never touches another
 * host's record.
 */
export async function applyEngineModelPolicySet(input: {
  readonly host: string;
  readonly policy: unknown;
  readonly occurredAt: string;
  readonly actor: string;
  readonly authorization: VerifiedWriteAuthorization;
  readonly home?: string;
}): Promise<EngineModelPolicyFile> {
  const host = hostId(input.host);
  let actor: string;
  try { assertActorId(input.actor); actor = input.actor; } catch { fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "a valid actual --actor is required"); }
  try { assertStrictInstant(input.occurredAt); } catch { fail("ENGINE_MODEL_POLICY_INVALID", "at must be a strict UTC instant", { path: "at" }); }
  const authorization = input.authorization;
  if (authorization?.target !== ENGINE_MODEL_POLICY_WRITE_TARGET || typeof authorization.decidedIn !== "string" || !DECISION_ID.test(authorization.decidedIn) || typeof authorization.libraryId !== "string" || !LIBRARY_ID.test(authorization.libraryId)) {
    fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "a verified Owner --decided-in authorization for models.engine-policy is required");
  }
  const config = validateEngineModelPolicy(host, input.policy);
  const home = input.home ?? deviceHome();
  const path = engineModelPolicyPath(home);
  const lock = engineModelPolicyLockPath(home);
  await mkdir(dirname(lock), { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(lock, async () => {
    const current = await readEngineModelPolicyFile(home);
    const currentHost = Object.hasOwn(current.hosts, host) ? current.hosts[host] : undefined;
    const entry: EngineModelPolicyEntry = Object.freeze({
      ...config,
      revision: (currentHost?.revision ?? 0) + 1,
      digest: policyDigest(host, config),
      updatedAt: input.occurredAt,
      actor,
      decidedIn: authorization.decidedIn,
      decidedInLibraryId: authorization.libraryId,
    });
    const next = validateEngineModelPolicyFile({
      schemaVersion: current.schemaVersion,
      revision: current.revision + 1,
      hosts: { ...current.hosts, [host]: entry },
      ...(current.operations === undefined ? {} : { operations: current.operations }),
    });
    await writeFileAtomic(path, `${canonicalJson(next)}\n`);
    // Capture the committed bytes while this host transaction still owns the lock. The CLI uses
    // this snapshot for its receipt, so another same-host writer cannot splice a later policy into
    // this write's revision or audit metadata.
    return await readEngineModelPolicyFile(home);
  });
}

/** Runtime provenance is deliberately separate from portable project configuration. */
export interface EngineExecutionPolicyResolution extends ModelsTierResolution {
  readonly host: string;
  readonly category: string;
  readonly rejections: number;
  readonly escalation: EngineModelPolicyConfig["escalation"];
  readonly quota: EngineQuotaPolicy;
  readonly quotaOrigin: "device-host-policy" | "engine-default";
  readonly capabilityStatus: "verified-by-caller" | "unchecked";
  readonly origin: {
    readonly kind: "device-engine";
    readonly path: string;
    readonly revision: number;
    readonly storeRevision: number;
    readonly digest: string;
  };
}

export interface EngineExecutionPolicyInput {
  /** Optional evidence supplied by a host adapter, not a baked-in vendor capability roster. */
  readonly availableCombinations?: readonly { readonly runner: string; readonly model: string; readonly effort: string }[];
  readonly host: string;
  readonly category: string;
  readonly rejections: number;
  readonly home?: string;
}

/** One validated snapshot drives selection, escalation and provenance, never project models.*. */
export function resolveEngineExecutionPolicyFromSnapshot(
  snapshot: EngineModelPolicyFile,
  input: EngineExecutionPolicyInput,
): EngineExecutionPolicyResolution {
  const host = hostId(input.host);
  const file = validateEngineModelPolicyFile(snapshot);
  const policy = Object.hasOwn(file.hosts, host) ? file.hosts[host] : undefined;
  if (policy === undefined) {
    fail("ENGINE_MODEL_POLICY_UNAVAILABLE", `No device engine policy is configured for host ${host}; project model settings are not a fallback`, { host });
  }
  const resolution = resolveModelsTier({ ...policy, category: input.category, rejections: input.rejections });
  if (resolution.record.model.trim() === "" || resolution.record.effort.trim() === "") {
    fail("ENGINE_MODEL_POLICY_UNAVAILABLE", `Selected tier is not configured with a callable model and effort for host ${host}`, { host, order: resolution.record.order });
  }
  if (input.availableCombinations !== undefined && !input.availableCombinations.some((combination) => combination.runner === resolution.record.runner && combination.model === resolution.record.model && combination.effort === resolution.record.effort)) {
    fail("ENGINE_MODEL_POLICY_UNAVAILABLE", `Selected combination is unavailable for host ${host}`, { host, model: resolution.record.model, effort: resolution.record.effort });
  }
  return Object.freeze({
    ...resolution,
    capabilityStatus: input.availableCombinations === undefined ? "unchecked" : "verified-by-caller",
    host,
    category: input.category,
    rejections: input.rejections,
    escalation: policy.escalation,
    quota: policy.quota ?? DEFAULT_ENGINE_QUOTA_POLICY,
    quotaOrigin: policy.quota === undefined ? "engine-default" : "device-host-policy",
    origin: Object.freeze({
      kind: "device-engine",
      path: engineModelPolicyPath(input.home ?? deviceHome()),
      revision: policy.revision,
      storeRevision: file.revision,
      digest: policy.digest,
    }),
  });
}

/** Real device consumer; unavailable and corrupt policies fail rather than choosing a model. */
export async function resolveEngineExecutionPolicy(input: EngineExecutionPolicyInput): Promise<EngineExecutionPolicyResolution> {
  return resolveEngineExecutionPolicyFromSnapshot(await readEngineModelPolicyFile(input.home), input);
}

/** Native execution reads intent without turning absence/unsupported combinations into a ban.
 * Corrupt schema/digests and I/O errors deliberately propagate; no catch-all default policy. */
export function resolveNativePolicyIntentFromSnapshot(snapshot: EngineModelPolicyFile, input: EngineExecutionPolicyInput): {
  readonly status: "unconfigured" | "entry-unconfigured" | "configured" | "unsupported";
  readonly selection: EngineExecutionPolicyResolution | null;
} {
  const file = validateEngineModelPolicyFile(snapshot);
  const host = hostId(input.host);
  const policy = Object.hasOwn(file.hosts, host) ? file.hosts[host] : undefined;
  if (!policy) return { status: "unconfigured", selection: null };
  const tier = resolveModelsTier({ ...policy, category: input.category, rejections: input.rejections });
  if (!tier.record.model.trim() || !tier.record.effort.trim()) return { status: "entry-unconfigured", selection: null };
  // Keep exact configured intent even when this host cannot request it.
  const { availableCombinations, ...selectors } = input;
  const selection = resolveEngineExecutionPolicyFromSnapshot(file, selectors);
  const supported = availableCombinations === undefined || availableCombinations.some(tuple => tuple.runner === selection.record.runner && tuple.model === selection.record.model && tuple.effort === selection.record.effort);
  return { status: supported ? "configured" : "unsupported", selection };
}

/** V2 operation receipts live in the same atomic file as the policy they committed. */
export interface EngineModelPolicyOperation {
  readonly id: string;
  readonly host: string;
  readonly changeDigest: string;
  readonly expectedRevision: number;
  readonly expectedDigest: string | null;
  readonly storeRevision: number;
  readonly result: EngineModelPolicyEntry;
}
function operationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail("ENGINE_MODEL_POLICY_INVALID", "operation id must be a nonsecret bounded identifier");
  return value;
}
function validatePolicyOperation(id: string, value: unknown): EngineModelPolicyOperation {
  operationId(id);
  const o = object(value, "operation"); exactFields(o, "changeDigest,expectedDigest,expectedRevision,host,id,result,storeRevision", "operation");
  if (o.id !== id || typeof o.changeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(o.changeDigest)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "invalid operation identity/digest");
  const host = hostId(o.host); const expectedRevision = safeRevision(o.expectedRevision, "expectedRevision", 0);
  if (o.expectedDigest !== null && (typeof o.expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(o.expectedDigest))) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "invalid expected policy digest");
  if ((expectedRevision === 0) !== (o.expectedDigest === null)) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "absent host expectation requires revision zero and null digest");
  const storeRevision = safeRevision(o.storeRevision, "operation storeRevision", 1);
  const result = validateEngineModelPolicyFile({ schemaVersion: ENGINE_MODEL_POLICY_SCHEMA_VERSION, revision: storeRevision, hosts: { [host]: o.result } }).hosts[host]!;
  if (result.revision !== expectedRevision + 1) fail("ENGINE_MODEL_POLICY_FILE_INVALID", "operation result revision does not follow expected host revision");
  return Object.freeze({ id, host, changeDigest: o.changeDigest, expectedRevision, expectedDigest: o.expectedDigest as string | null, storeRevision, result });
}
/** Exact tier tuple replacements only; unrelated tiers/categories/escalation/quota stay intact. */
export interface EngineModelPolicyTierPatch { readonly order: number; readonly model: string; readonly effort: string }
export interface EngineModelPolicySaveInput {
  readonly host: string;
  readonly expectedRevision: number;
  readonly expectedDigest: string | null;
  readonly operationId: string;
  /** Explicit whole policy for a new/unconfigured host; never inferred from a fallback. */
  readonly initialPolicy?: unknown;
  /** Finite waiting budget only, never an authorization expiry. Default 30 seconds. */
  readonly lockTimeoutMs?: number;
  readonly tiers?: readonly EngineModelPolicyTierPatch[];
  readonly occurredAt: string;
  readonly actor: string;
  readonly authorization: VerifiedWriteAuthorization;
  readonly home?: string;
}
/** Deterministic failure seams are not exposed through CLI or persisted configuration. */
export interface EngineModelPolicySaveFaults {
  readonly beforeAtomicWrite?: () => Promise<void>;
  readonly afterCommitBeforeReadback?: () => Promise<void>;
  readonly afterReadbackBeforeReturn?: () => Promise<void>;
}
export interface EngineModelPolicyOperationReadback {
  readonly schemaVersion: string;
  readonly operationId: string;
  readonly status: "recorded" | "not-recorded";
  readonly operation: EngineModelPolicyOperation | null;
  readonly currentHost: EngineModelPolicyEntry | null;
  readonly storeRevision: number;
  readonly readOnly: boolean;
}
export async function readEngineModelPolicyOperation(idValue: string, home?: string): Promise<EngineModelPolicyOperationReadback> {
  const id = operationId(idValue), file = await readEngineModelPolicyFile(home);
  const operation = file.operations && Object.hasOwn(file.operations, id) ? file.operations[id]! : null;
  return { schemaVersion: "tcrn.engine-model-policy-operation.v1", operationId: id, status: operation ? "recorded" : "not-recorded", operation, currentHost: operation ? file.hosts[operation.host] ?? null : null, storeRevision: file.revision, readOnly: true };
}
export async function applyEngineModelPolicySave(input: EngineModelPolicySaveInput, faults: EngineModelPolicySaveFaults = {}): Promise<{ readonly status: "committed" | "replayed"; readonly operation: EngineModelPolicyOperation; readonly readback: EngineModelPolicyFile }> {
  const host = hostId(input.host), id = operationId(input.operationId);
  const timeoutMs = input.lockTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) fail("ENGINE_MODEL_POLICY_INVALID", "lockTimeoutMs must be a nonnegative finite integer");
  const expectedRevision = safeRevision(input.expectedRevision, "expectedRevision", 0);
  if ((input.expectedDigest !== null && (typeof input.expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedDigest))) || (expectedRevision === 0) !== (input.expectedDigest === null)) fail("ENGINE_MODEL_POLICY_INVALID", "expected revision and digest must identify the same host snapshot");
  try { assertActorId(input.actor); assertStrictInstant(input.occurredAt); } catch { fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "actual actor and valid instant required"); }
  const a = input.authorization;
  if (a?.target !== ENGINE_MODEL_POLICY_WRITE_TARGET || !DECISION_ID.test(a.decidedIn) || !LIBRARY_ID.test(a.libraryId)) fail("ENGINE_MODEL_POLICY_AUTHORIZATION_REQUIRED", "verified models.engine-policy Owner decision required");
  if ((input.initialPolicy !== undefined) === (input.tiers !== undefined)) fail("ENGINE_MODEL_POLICY_INVALID", "choose explicit initialPolicy or exact tier replacements");
  if (input.initialPolicy !== undefined && expectedRevision !== 0) fail("ENGINE_MODEL_POLICY_INVALID", "initialPolicy only creates an absent host; existing host saving uses exact tiers");
  let initial: EngineModelPolicyConfig | undefined;
  if (input.initialPolicy !== undefined) initial = validateEngineModelPolicy(host, input.initialPolicy);
  const tiers = input.tiers;
  if (tiers !== undefined) {
    if (!Array.isArray(tiers) || tiers.length === 0 || tiers.some(t => !t || typeof t !== "object" || Array.isArray(t)) || new Set(tiers.map(t => t.order)).size !== tiers.length) fail("ENGINE_MODEL_POLICY_INVALID", "tier replacements must be nonempty and unique");
    for (const tier of tiers) {
      exactFields(object(tier, "tier replacement"), "effort,model,order", "tier replacement");
      if (!Number.isSafeInteger(tier.order) || tier.order < 1 || typeof tier.model !== "string" || !tier.model.trim() || typeof tier.effort !== "string" || !tier.effort.trim()) fail("ENGINE_MODEL_POLICY_INVALID", "replacement needs order and explicit model/effort");
    }
  }
  const changeDigest = canonicalSha256({ host, expectedRevision, expectedDigest: input.expectedDigest, actor: input.actor, authorization: a, ...(initial === undefined ? { tiers } : { initialPolicy: initial }) });
  const home = input.home ?? deviceHome(), path = engineModelPolicyPath(home), lock = engineModelPolicyLockPath(home);
  await mkdir(dirname(lock), { recursive: true }); await mkdir(dirname(path), { recursive: true });
  let phase: "not-written" | "prewrite" | "atomic-write" | "committed" | "readback-confirmed" | "existing-commit" = "not-written";
  try { return await withFileLock(lock, async () => {
    const current = await readEngineModelPolicyFile(home);
    const prior = current.operations && Object.hasOwn(current.operations, id) ? current.operations[id] : undefined;
    if (prior) {
      if (prior.changeDigest !== changeDigest || prior.host !== host) fail("ENGINE_MODEL_POLICY_OPERATION_CONFLICT", "operation id was already used for different authorized changes", { operationId: id });
      phase = "existing-commit";
      return { status: "replayed" as const, operation: prior, readback: current };
    }
    const held = Object.hasOwn(current.hosts, host) ? current.hosts[host] : undefined;
    if ((held?.revision ?? 0) !== expectedRevision || (held?.digest ?? null) !== input.expectedDigest) fail("ENGINE_MODEL_POLICY_CAS_CONFLICT", "host changed after the approved snapshot; preserve current policy and reconcile", { host, expectedRevision, actualRevision: held?.revision ?? 0, expectedDigest: input.expectedDigest, actualDigest: held?.digest ?? null });
    if (!initial && !held) fail("ENGINE_MODEL_POLICY_UNAVAILABLE", "absent host requires an explicitly approved complete initialPolicy");
    if (tiers?.some(tier => !held?.tiers.some(row => row.order === tier.order))) fail("ENGINE_MODEL_POLICY_INVALID", "a selected tier no longer exists; do not invent rows");
    const config = initial ?? validateEngineModelPolicy(host, { categories: held!.categories, tiers: held!.tiers.map(row => { const patch = tiers!.find(tier => tier.order === row.order); return patch ? { ...row, model: patch.model, effort: patch.effort } : row; }), escalation: held!.escalation, ...(held!.quota === undefined ? {} : { quota: held!.quota }) });
    const result: EngineModelPolicyEntry = { ...config, revision: expectedRevision + 1, digest: policyDigest(host, config), updatedAt: input.occurredAt, actor: input.actor, decidedIn: a.decidedIn, decidedInLibraryId: a.libraryId };
    const operation: EngineModelPolicyOperation = { id, host, changeDigest, expectedRevision, expectedDigest: input.expectedDigest, storeRevision: current.revision + 1, result };
    const next = validateEngineModelPolicyFile({ schemaVersion: ENGINE_MODEL_POLICY_TRANSACTION_VERSION, revision: current.revision + 1, hosts: { ...current.hosts, [host]: result }, operations: { ...current.operations, [id]: operation } });
    phase = "prewrite"; await faults.beforeAtomicWrite?.();
    phase = "atomic-write"; await writeFileAtomic(path, `${canonicalJson(next)}\n`);
    phase = "committed"; await faults.afterCommitBeforeReadback?.();
    const readback = await readEngineModelPolicyFile(home);
    phase = "readback-confirmed"; await faults.afterReadbackBeforeReturn?.();
    return { status: "committed" as const, operation: readback.operations![id]!, readback };
  }, { timeoutMs, command: "einzbern engine-model-policy-save" }); }
  catch (error) {
    const failurePhase = phase as string; // callback writes are intentionally observed after rejection
    if (failurePhase === "not-written") throw error;
    const writeOutcome = failurePhase === "prewrite" ? "not-written" : failurePhase === "atomic-write" ? "unknown" : failurePhase === "existing-commit" ? "previously-committed" : "committed";
    const rawCause = String((error as { reasonCode?: unknown; code?: unknown }).reasonCode ?? (error as { code?: unknown }).code ?? "UNKNOWN");
    const causeCode = ["EIO", "ENOSPC", "EACCES", "EPERM", "EROFS", "ENOENT", "EBUSY", "ATOMIC_WRITE_INTERRUPTED", "ATOMIC_WRITE_RENAME_FAILED", "FILE_LOCK_LOST", "FILE_LOCK_TIMEOUT", "ENGINE_MODEL_POLICY_FILE_INVALID"].includes(rawCause) ? rawCause : "UNKNOWN";
    throw new EngineModelPolicyError(writeOutcome === "not-written" ? "ENGINE_MODEL_POLICY_SAVE_FAILED" : "ENGINE_MODEL_POLICY_SAVE_RECONCILIATION_REQUIRED", "Save did not return a complete receipt; inspect the read-only operation result before retry", { operationId: id, host, phase: failurePhase, writeOutcome, causeCode, readbackConfirmed: failurePhase === "readback-confirmed" || failurePhase === "existing-commit" });
  }
}
