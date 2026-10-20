// SPDX-License-Identifier: Apache-2.0
import { mkdir, lstat, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import {
  CONFIG_BACKUP_RESERVED_ROOTS, assertConfigBackupDirectory, assertConfigBackupReservedRoot,
  configBackupCanonical, configBackupDigest, configBackupFail, configBackupId, configBackupInstant,
  configBackupObject, configBackupProjectRef, configBackupString, readConfigBackupFile,
  safeConfigBackupHostname, validateConfigBackupManifest, validateConfigBackupPayload, verifyConfigBackup, writeConfigBackupNewFile, writeConfigBackupPackage,
} from "./config-backup.js";
import type { ConfigBackupManifest, ConfigBackupPlan, ConfigBackupProjectRef } from "./config-backup.js";

export const CONFIG_BACKUP_RETENTION_VERSION = "einzbern.config-backup-retention.v1" as const;
export const CONFIG_BACKUP_LOCAL_BINDING_DIRECTORY = "config-backup-bindings" as const;
export const CONFIG_BACKUP_INDEX_VERSION = "einzbern.config-backup-index.v1" as const;
export interface ConfigBackupRetentionPolicy {
  readonly schemaVersion: typeof CONFIG_BACKUP_RETENTION_VERSION;
  readonly activeLimit: number; readonly transactionLimit: number; readonly recoveryLimit: number;
  readonly maxPackageBytes: number; readonly maxTotalBytes: number;
  /** Explicit duration in milliseconds. No numeric product defaults. */
  readonly retentionDuration: number; readonly recoveryDuration: number;
  readonly noChangePolicy: "skip" | "create";
  readonly atLimitAction: "stop-new-and-report";
  readonly retirementMethod: "verified-recovery-move";
  readonly approvalEvidenceRef: string;
}
export type ConfigBackupPolicyValidation =
  | { readonly status: "policy-unapproved"; readonly reasons: readonly string[] }
  | { readonly status: "policy-valid"; readonly policy: ConfigBackupRetentionPolicy; readonly policyDigest: string };
const POLICY_FIELDS = Object.freeze(["schemaVersion", "activeLimit", "transactionLimit", "recoveryLimit", "maxPackageBytes", "maxTotalBytes", "retentionDuration", "recoveryDuration", "noChangePolicy", "atLimitAction", "retirementMethod", "approvalEvidenceRef"]);
export function validateConfigBackupRetentionPolicy(value: unknown): ConfigBackupPolicyValidation {
  const reasons: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "policy-unapproved", reasons: ["explicit-policy-required"] };
  const v = value as Record<string, unknown>;
  for (const field of POLICY_FIELDS) if (!Object.hasOwn(v, field)) reasons.push(`missing:${field}`);
  if (Object.keys(v).some(key => !POLICY_FIELDS.includes(key))) reasons.push("unknown-policy-field");
  if (v.schemaVersion !== CONFIG_BACKUP_RETENTION_VERSION) reasons.push("unsupported-policy-version");
  for (const field of ["activeLimit", "transactionLimit", "recoveryLimit", "maxPackageBytes", "maxTotalBytes", "retentionDuration", "recoveryDuration"]) if (!Number.isSafeInteger(v[field]) || (v[field] as number) <= 0) reasons.push(`invalid:${field}`);
  if (!["skip", "create"].includes(String(v.noChangePolicy)) || v.atLimitAction !== "stop-new-and-report" || v.retirementMethod !== "verified-recovery-move") reasons.push("unsupported-policy-action");
  if (typeof v.approvalEvidenceRef !== "string" || !v.approvalEvidenceRef.trim() || /[\u0000-\u001f]/u.test(v.approvalEvidenceRef)) reasons.push("approval-evidence-required");
  if (typeof v.maxPackageBytes === "number" && typeof v.maxTotalBytes === "number" && v.maxPackageBytes > v.maxTotalBytes) reasons.push("package-exceeds-total-limit");
  if (reasons.length) return { status: "policy-unapproved", reasons };
  const policy = v as unknown as ConfigBackupRetentionPolicy;
  return { status: "policy-valid", policy, policyDigest: configBackupDigest(configBackupCanonical(policy)) };
}
/** Supplied by the calling authorization boundary, never inferred from a policy file's claim. */
export interface ConfigBackupPolicyApproval { readonly policyDigest: string; readonly approvalEvidenceRef: string; readonly approved: boolean }
export interface ConfigBackupEnablementPrerequisites {
  readonly policy: unknown; readonly approval: ConfigBackupPolicyApproval | null;
  readonly whitelistSupported: boolean; readonly restoreSupported: boolean;
  readonly groupBound: boolean; readonly safeRetirementSupported: boolean;
  readonly enablementAuthorized: boolean;
}
export function evaluateConfigBackupEnablement(input: ConfigBackupEnablementPrerequisites): { readonly eligible: boolean; readonly reason: "ready" | "policy-unapproved" | "capability-unavailable" | "group-unbound" | "enablement-unapproved"; readonly policyDigest: string | null } {
  const policy = validateConfigBackupRetentionPolicy(input.policy);
  if (policy.status !== "policy-valid" || !input.approval?.approved || input.approval.policyDigest !== policy.policyDigest || input.approval.approvalEvidenceRef !== policy.policy.approvalEvidenceRef) return { eligible: false, reason: "policy-unapproved", policyDigest: null };
  if (!input.whitelistSupported || !input.restoreSupported || !input.safeRetirementSupported) return { eligible: false, reason: "capability-unavailable", policyDigest: policy.policyDigest };
  if (!input.groupBound) return { eligible: false, reason: "group-unbound", policyDigest: policy.policyDigest };
  if (!input.enablementAuthorized) return { eligible: false, reason: "enablement-unapproved", policyDigest: policy.policyDigest };
  return { eligible: true, reason: "ready", policyDigest: policy.policyDigest };
}
export interface ConfigBackupGroupBinding {
  readonly projectRef: ConfigBackupProjectRef; readonly backupGroupId: string;
  readonly writerBindingRef: string; readonly executionEnvironmentRef: string;
  readonly hostname: string;
}
export interface ConfigBackupStoredPackage {
  readonly backupId: string; readonly directory: string; readonly manifestDigest: string;
  readonly selectionDigest: string; readonly bytes: number; readonly completedAt: string;
  readonly recoverableUntil: string | null; readonly origin: "created" | "retired" | "failed-transaction";
}
export interface ConfigBackupTransaction {
  readonly transactionId: string; readonly backupId: string; readonly directory: string;
  readonly manifestDigest: string; readonly bytes: number; readonly startedAt: string;
  readonly phase: "staging" | "verified" | "committed" | "rotation-pending";
  readonly retirementBackupId: string | null;
}
export interface ConfigBackupGroupIndex {
  readonly schemaVersion: typeof CONFIG_BACKUP_INDEX_VERSION; readonly projectRef: ConfigBackupProjectRef;
  readonly backupGroupId: string; readonly writerBindingRef: string; readonly executionEnvironmentRef: string;
  readonly hostname: string; readonly activeBackupIds: readonly string[]; readonly transactionIds: readonly string[];
  readonly recoverableBackupIds: readonly string[]; readonly active: readonly ConfigBackupStoredPackage[];
  readonly transactions: readonly ConfigBackupTransaction[]; readonly recoverable: readonly ConfigBackupStoredPackage[];
  readonly policyRef: string; readonly policyDigest: string; readonly revision: number;
  readonly updatedAt: string; readonly lastError: string | null; readonly syncStatus: "unknown";
}
export interface ConfigBackupStore {
  readonly reservedRoot: string;
  /** Device-local group binding root, resolved by the CLI, never supplied by a package. */
  readonly localBindingRoot: string;
  /** Actual library, project, device and generated/cleaned roots, resolved by the caller. */
  readonly protectedRoots: readonly string[];
  readonly binding: ConfigBackupGroupBinding;
  readonly policy: unknown; readonly approval: ConfigBackupPolicyApproval | null;
  readonly lockTimeoutMs?: number;
}
interface GroupPaths { readonly active: string; readonly staging: string; readonly recovery: string }
function bindingValid(binding: ConfigBackupGroupBinding): void {
  configBackupObject(binding, ["projectRef", "backupGroupId", "writerBindingRef", "executionEnvironmentRef", "hostname"]);
  configBackupProjectRef(binding.projectRef); configBackupId(binding.backupGroupId);
  for (const value of [binding.writerBindingRef, binding.executionEnvironmentRef]) if (!/^[A-Za-z0-9_.:-]+$/u.test(configBackupString(value))) configBackupFail("CONFIG_BACKUP_BINDING_INVALID");
  safeConfigBackupHostname(binding.hostname);
}
function groupPaths(store: Pick<ConfigBackupStore, "reservedRoot" | "binding">): GroupPaths {
  bindingValid(store.binding);
  const tail = [safeConfigBackupHostname(store.binding.hostname), store.binding.backupGroupId];
  return { active: join(store.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[0], ...tail), staging: join(store.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[1], ...tail), recovery: join(store.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[2], ...tail) };
}
function approvedPolicy(store: Pick<ConfigBackupStore, "policy" | "approval">): Extract<ConfigBackupPolicyValidation, { status: "policy-valid" }> {
  const validation = validateConfigBackupRetentionPolicy(store.policy);
  if (validation.status !== "policy-valid" || !store.approval?.approved || store.approval.policyDigest !== validation.policyDigest || store.approval.approvalEvidenceRef !== validation.policy.approvalEvidenceRef) configBackupFail("policy-unapproved");
  return validation;
}
async function directory(parent: string, child: string): Promise<string> {
  await assertConfigBackupDirectory(parent); const path = join(parent, child);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return assertConfigBackupDirectory(path);
}
async function assertLocalBinding(store: ConfigBackupStore, mayCreate: boolean): Promise<void> {
  if (basename(store.localBindingRoot) !== CONFIG_BACKUP_LOCAL_BINDING_DIRECTORY) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND");
  // The retained data root and the device-local binding must never be each other's ancestor.
  await assertConfigBackupReservedRoot(store.reservedRoot, [store.localBindingRoot]);
  const expected = { schemaVersion: "einzbern.config-backup-binding.v1", ...store.binding };
  let text: string;
  try { text = (await readConfigBackupFile(store.localBindingRoot, `${store.binding.backupGroupId}.json`)).toString("utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !mayCreate) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND");
    await directory(dirname(store.localBindingRoot), CONFIG_BACKUP_LOCAL_BINDING_DIRECTORY);
    await writeConfigBackupNewFile(store.localBindingRoot, `${store.binding.backupGroupId}.json`, configBackupCanonical(expected));
    text = (await readConfigBackupFile(store.localBindingRoot, `${store.binding.backupGroupId}.json`)).toString("utf8");
  }
  if (text !== configBackupCanonical(expected)) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND");
}
async function preparePaths(store: ConfigBackupStore): Promise<GroupPaths> {
  await assertConfigBackupReservedRoot(store.reservedRoot, store.protectedRoots);
  for (const root of CONFIG_BACKUP_RESERVED_ROOTS) {
    const area = await directory(store.reservedRoot, root); const host = await directory(area, safeConfigBackupHostname(store.binding.hostname));
    await directory(host, store.binding.backupGroupId);
  }
  return groupPaths(store);
}
function checkPackage(value: unknown): ConfigBackupStoredPackage {
  const v = configBackupObject(value, ["backupId", "directory", "manifestDigest", "selectionDigest", "bytes", "completedAt", "recoverableUntil", "origin"]);
  configBackupId(v.backupId); configBackupInstant(v.completedAt);
  if (v.recoverableUntil !== null) configBackupInstant(v.recoverableUntil);
  if (!Number.isSafeInteger(v.bytes) || (v.bytes as number) < 0 || !/^[a-f0-9]{64}$/u.test(String(v.manifestDigest)) || !/^[a-f0-9]{64}$/u.test(String(v.selectionDigest)) || !/^[0-9TZ-]+-[a-f0-9]{32}$/u.test(String(v.directory)) || !String(v.directory).endsWith(`-${String(v.backupId)}`) || !["created", "retired", "failed-transaction"].includes(String(v.origin))) configBackupFail("CONFIG_BACKUP_INDEX_INVALID");
  return v as unknown as ConfigBackupStoredPackage;
}
export function validateConfigBackupGroupIndex(value: unknown): ConfigBackupGroupIndex {
  const v = configBackupObject(value, ["schemaVersion", "projectRef", "backupGroupId", "writerBindingRef", "executionEnvironmentRef", "hostname", "activeBackupIds", "transactionIds", "recoverableBackupIds", "active", "transactions", "recoverable", "policyRef", "policyDigest", "revision", "updatedAt", "lastError", "syncStatus"]);
  if (v.schemaVersion !== CONFIG_BACKUP_INDEX_VERSION || !Array.isArray(v.active) || !Array.isArray(v.transactions) || !Array.isArray(v.recoverable) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 || v.syncStatus !== "unknown") configBackupFail("CONFIG_BACKUP_INDEX_INVALID");
  return validateIndexContents(v);
}
function validateIndexContents(v: Record<string, unknown>): ConfigBackupGroupIndex {
  // Identity validation is separate from the closed complete index field list.
  configBackupProjectRef(v.projectRef); configBackupId(v.backupGroupId); configBackupInstant(v.updatedAt);
  configBackupString(v.writerBindingRef); configBackupString(v.executionEnvironmentRef); configBackupString(v.hostname); configBackupString(v.policyRef);
  if (!/^[a-f0-9]{64}$/u.test(String(v.policyDigest)) || (v.lastError !== null && typeof v.lastError !== "string")) configBackupFail("CONFIG_BACKUP_INDEX_INVALID");
  const active = (v.active as unknown[]).map(checkPackage); const recoverable = (v.recoverable as unknown[]).map(checkPackage);
  const transactions = (v.transactions as unknown[]).map(raw => {
    const t = configBackupObject(raw, ["transactionId", "backupId", "directory", "manifestDigest", "bytes", "startedAt", "phase", "retirementBackupId"]);
    configBackupId(t.transactionId); configBackupId(t.backupId); configBackupInstant(t.startedAt);
    if (t.retirementBackupId !== null) configBackupId(t.retirementBackupId);
    if (!/^[0-9TZ-]+-[a-f0-9]{32}$/u.test(String(t.directory)) || !String(t.directory).endsWith(`-${String(t.backupId)}`) || !/^[a-f0-9]{64}$/u.test(String(t.manifestDigest)) || !Number.isSafeInteger(t.bytes) || (t.bytes as number) < 0 || !["staging", "verified", "committed", "rotation-pending"].includes(String(t.phase))) configBackupFail("CONFIG_BACKUP_INDEX_INVALID");
    return t as unknown as ConfigBackupTransaction;
  });
  for (const [ids, rows] of [[v.activeBackupIds, active.map(x => x.backupId)], [v.recoverableBackupIds, recoverable.map(x => x.backupId)], [v.transactionIds, transactions.map(x => x.transactionId)]] as const) if (configBackupCanonical(ids) !== configBackupCanonical(rows) || new Set(rows).size !== rows.length) configBackupFail("CONFIG_BACKUP_INDEX_INVALID");
  if (active.some(x => recoverable.some(y => x.backupId === y.backupId))) configBackupFail("CONFIG_BACKUP_INDEX_INVALID");
  return v as unknown as ConfigBackupGroupIndex;
}
async function readIndex(paths: GroupPaths): Promise<ConfigBackupGroupIndex | null> {
  try {
    const text = (await readConfigBackupFile(paths.active, "index.json")).toString("utf8");
    const index = validateConfigBackupGroupIndex(JSON.parse(text) as unknown);
    if (text !== configBackupCanonical(index)) configBackupFail("CONFIG_BACKUP_INDEX_NON_CANONICAL");
    return index;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function assertBinding(index: ConfigBackupGroupIndex, store: ConfigBackupStore): void {
  const b = store.binding;
  if (index.backupGroupId !== b.backupGroupId || index.writerBindingRef !== b.writerBindingRef || index.executionEnvironmentRef !== b.executionEnvironmentRef || index.hostname !== b.hostname || configBackupCanonical(index.projectRef) !== configBackupCanonical(b.projectRef)) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND");
  const policy = approvedPolicy(store);
  if (index.policyDigest !== policy.policyDigest || index.policyRef !== policy.policy.approvalEvidenceRef) configBackupFail("CONFIG_BACKUP_POLICY_CHANGED");
}
async function saveIndex(paths: GroupPaths, index: ConfigBackupGroupIndex): Promise<ConfigBackupGroupIndex> {
  const next = validateConfigBackupGroupIndex({ ...index, activeBackupIds: index.active.map(x => x.backupId), transactionIds: index.transactions.map(x => x.transactionId), recoverableBackupIds: index.recoverable.map(x => x.backupId) });
  const path = join(paths.active, "index.json");
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) configBackupFail("CONFIG_BACKUP_PATH_INVALID"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await assertConfigBackupDirectory(paths.active); await writeFileAtomic(path, configBackupCanonical(next));
  const readback = await readIndex(paths);
  if (configBackupCanonical(readback) !== configBackupCanonical(next)) configBackupFail("CONFIG_BACKUP_INDEX_READBACK_UNKNOWN"); return next;
}
function changed(index: ConfigBackupGroupIndex, at: string, update: Partial<ConfigBackupGroupIndex>): ConfigBackupGroupIndex { return { ...index, ...update, revision: index.revision + 1, updatedAt: at }; }
function stored(manifest: ConfigBackupManifest, transaction: ConfigBackupTransaction, at: string): ConfigBackupStoredPackage {
  return { backupId: manifest.backupId, directory: transaction.directory, manifestDigest: manifest.manifestDigest, selectionDigest: manifest.selectionDigest, bytes: transaction.bytes, completedAt: at, recoverableUntil: null, origin: "created" };
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function assertTracked(paths: GroupPaths, index: ConfigBackupGroupIndex): Promise<void> {
  for (const [root, names] of [[paths.active, [...index.active.map(x => x.directory), ...index.transactions.map(x => x.directory), "index.json", ".writer.lock"]], [paths.staging, index.transactions.map(x => x.directory)], [paths.recovery, [...index.recoverable.map(x => x.directory), ...index.transactions.filter(x => x.phase === "staging").map(x => x.directory), ...index.transactions.flatMap(x => x.retirementBackupId === null ? [] : index.active.filter(p => p.backupId === x.retirementBackupId).map(p => p.directory))]]] as const) {
    for (const name of await readdir(root)) if (!names.includes(name)) configBackupFail("CONFIG_BACKUP_UNTRACKED_STATE");
  }
}
async function verifyStoredPackages(paths: GroupPaths, index: ConfigBackupGroupIndex): Promise<void> {
  for (const [root, packages] of [[paths.active, index.active], [paths.recovery, index.recoverable]] as const) {
    for (const item of packages) {
      if (item.origin === "failed-transaction") {
        // Failed bytes reserve their whole original transaction budget. Keep that bound real
        // before admitting any new package; quarantine never becomes an uncounted directory.
        if (await measuredPackageBytes(join(root, item.directory)) > item.bytes) configBackupFail("CONFIG_BACKUP_RECOVERY_CAPACITY");
        continue; // quarantined bytes are never called verified
      }
      const verified = await verifyConfigBackup(join(root, item.directory));
      const manifest = verified.manifest;
      if (!manifest || verified.integrity !== "verified" || manifest.manifestDigest !== item.manifestDigest || manifest.selectionDigest !== item.selectionDigest || manifest.backupId !== item.backupId || manifest.backupGroupId !== index.backupGroupId || manifest.hostnameLabel.display !== index.hostname || configBackupCanonical(manifest.projectRef) !== configBackupCanonical(index.projectRef) || Buffer.byteLength(configBackupCanonical(manifest)) + manifest.files.reduce((sum, f) => sum + f.bytes, 0) !== item.bytes) configBackupFail("CONFIG_BACKUP_STORED_PACKAGE_CHANGED");
    }
  }
}
export interface ConfigBackupOperationResult { readonly status: "settled" | "unchanged" | "pending" | "stop-new-and-report"; readonly index: ConfigBackupGroupIndex; readonly reason: string | null }
/** Persist only bounded machine reasons, never raw errors, paths, or backup content. */
async function pendingResult(paths: GroupPaths, index: ConfigBackupGroupIndex, at: string, status: "pending" | "stop-new-and-report", reason: string): Promise<ConfigBackupOperationResult> {
  const currentReason = reason === "resume-existing-transaction-first" && index.lastError !== null ? index.lastError : reason;
  const safe = /^[A-Za-z0-9_-]{1,128}$/u.test(currentReason) ? currentReason : "CONFIG_BACKUP_WRITE_UNKNOWN";
  try { const saved = index.lastError === safe ? index : await saveIndex(paths, changed(index, at, { lastError: safe })); return { status, index: saved, reason: safe }; }
  catch { return { status: "pending", index, reason: `${safe}:error-persistence-unknown` }; }
}
export async function createConfigBackup(store: ConfigBackupStore, plan: ConfigBackupPlan, at: string): Promise<ConfigBackupOperationResult> {
  configBackupInstant(at); const validation = approvedPolicy(store); bindingValid(store.binding);
  validateConfigBackupManifest(plan.manifest);
  const plannedBytes = Buffer.byteLength(configBackupCanonical(plan.manifest)) + plan.manifest.files.reduce((sum, f) => sum + f.bytes, 0);
  for (const member of plan.members) {
    const text = configBackupCanonical(validateConfigBackupPayload(member.payload));
    if (Buffer.byteLength(text) !== member.descriptor.bytes || configBackupDigest(text) !== member.descriptor.sha256) configBackupFail("CONFIG_BACKUP_PLAN_INVALID");
  }
  if (plan.bytes !== plannedBytes || plan.excluded.length || plan.members.length !== plan.manifest.files.length || configBackupCanonical(plan.members.map(m => m.descriptor)) !== configBackupCanonical(plan.manifest.files)) configBackupFail("CONFIG_BACKUP_PLAN_INVALID");
  if (configBackupCanonical(plan.manifest.projectRef) !== configBackupCanonical(store.binding.projectRef) || plan.manifest.backupGroupId !== store.binding.backupGroupId || plan.manifest.hostnameLabel.display !== store.binding.hostname) configBackupFail("CONFIG_BACKUP_SOURCE_MISMATCH");
  const paths = await preparePaths(store);
  return withFileLock(join(paths.active, ".writer.lock"), async () => {
    let index = await readIndex(paths);
    if (index === null) {
      if ((await readdir(paths.active)).some(name => name !== ".writer.lock") || (await readdir(paths.staging)).length || (await readdir(paths.recovery)).length) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND");
      await assertLocalBinding(store, true);
      index = await saveIndex(paths, { schemaVersion: CONFIG_BACKUP_INDEX_VERSION, ...store.binding, activeBackupIds: [], transactionIds: [], recoverableBackupIds: [], active: [], transactions: [], recoverable: [], policyRef: validation.policy.approvalEvidenceRef, policyDigest: validation.policyDigest, revision: 1, updatedAt: at, lastError: null, syncStatus: "unknown" });
    }
    await assertLocalBinding(store, false); assertBinding(index, store); await assertTracked(paths, index);
    if (index.transactions.length) return pendingResult(paths, index, at, "pending", "resume-existing-transaction-first");
    await verifyStoredPackages(paths, index);
    const policy = validation.policy;
    const previous = index.active.at(-1);
    if (policy.noChangePolicy === "skip" && previous?.selectionDigest === plan.manifest.selectionDigest) {
      const verified = await verifyConfigBackup(join(paths.active, previous.directory));
      if (verified.integrity === "verified" && verified.manifest !== null && verified.manifest.manifestDigest === previous.manifestDigest && configBackupCanonical(verified.manifest.sourceVersion) === configBackupCanonical(plan.manifest.sourceVersion)) return { status: "unchanged", index, reason: null };
    }
    const total = [...index.active, ...index.recoverable].reduce((sum, p) => sum + p.bytes, 0);
    const retirement = index.active.length >= policy.activeLimit ? index.active[0] ?? null : null;
    if (plan.bytes > policy.maxPackageBytes || total + plan.bytes > policy.maxTotalBytes || index.transactions.length >= policy.transactionLimit || index.recoverable.length >= policy.recoveryLimit || (retirement !== null && Date.parse(at) - Date.parse(retirement.completedAt) < policy.retentionDuration) || index.recoverable.some(p => p.recoverableUntil === null || Date.parse(p.recoverableUntil) <= Date.parse(at))) return pendingResult(paths, index, at, "stop-new-and-report", "retention-capacity-or-safe-exit-required");
    const transaction: ConfigBackupTransaction = { transactionId: plan.manifest.backupId, backupId: plan.manifest.backupId, directory: `${plan.manifest.createdAtUtc.replace(/[:.]/gu, "-")}-${plan.manifest.backupId}`, manifestDigest: plan.manifest.manifestDigest, bytes: plan.bytes, startedAt: at, phase: "staging", retirementBackupId: retirement?.backupId ?? null };
    if (index.active.some(x => x.backupId === transaction.backupId) || index.recoverable.some(x => x.backupId === transaction.backupId)) configBackupFail("CONFIG_BACKUP_ID_REUSED");
    index = await saveIndex(paths, changed(index, at, { transactions: [transaction] }));
    try {
      const verified = await writeConfigBackupPackage(join(paths.staging, transaction.directory), plan);
      if (verified.integrity !== "verified") configBackupFail("CONFIG_BACKUP_VERIFICATION_FAILED");
      return await resumeUnderLock(store, paths, index, at);
    } catch (error) {
      // Keep the original active package and the same durable transaction. Never start another
      // transaction on an unknown write result, and never delete failed bytes to manufacture space.
      let current = index;
      try { current = (await readIndex(paths)) ?? index; assertBinding(current, store); } catch { return { status: "pending", index, reason: "CONFIG_BACKUP_ERROR_PERSISTENCE_UNKNOWN" }; }
      return pendingResult(paths, current, at, "pending", error instanceof Error && "reasonCode" in error ? String(error.reasonCode) : "CONFIG_BACKUP_WRITE_UNKNOWN");
    }
  }, { command: "einzbern config-backup-create", ...(store.lockTimeoutMs === undefined ? {} : { timeoutMs: store.lockTimeoutMs }) });
}
async function resumeUnderLock(store: ConfigBackupStore, paths: GroupPaths, initial: ConfigBackupGroupIndex, at: string): Promise<ConfigBackupOperationResult> {
  let index = initial; const policy = approvedPolicy(store).policy; assertBinding(index, store); await assertTracked(paths, index);
  for (const transaction of [...index.transactions]) {
    const source = join(paths.staging, transaction.directory); const target = join(paths.active, transaction.directory);
    const hasSource = await exists(source); const hasTarget = await exists(target);
    if (hasSource && hasTarget) return pendingResult(paths, index, at, "pending", "publication-conflict");
    const verified = await verifyConfigBackup(hasTarget ? target : source);
    if (verified.integrity !== "verified" || verified.manifest === null || verified.manifest.manifestDigest !== transaction.manifestDigest || verified.manifest.backupId !== transaction.backupId || verified.manifest.backupGroupId !== index.backupGroupId || configBackupCanonical(verified.manifest.projectRef) !== configBackupCanonical(index.projectRef)) return pendingResult(paths, index, at, "pending", "transaction-needs-explicit-recovery");
    if (!hasTarget) {
      index = await saveIndex(paths, changed(index, at, { transactions: index.transactions.map(t => t.transactionId === transaction.transactionId ? { ...t, phase: "verified" } : t) }));
      await assertConfigBackupDirectory(source); await assertConfigBackupDirectory(paths.active);
      if (await exists(target)) configBackupFail("CONFIG_BACKUP_PUBLICATION_CONFLICT");
      await rename(source, target);
      if ((await verifyConfigBackup(target)).manifest?.manifestDigest !== transaction.manifestDigest) return pendingResult(paths, index, at, "pending", "publication-readback-unknown");
    }
    if (!index.active.some(p => p.backupId === transaction.backupId)) index = await saveIndex(paths, changed(index, at, { active: [...index.active, stored(verified.manifest, transaction, at)], transactions: index.transactions.map(t => t.transactionId === transaction.transactionId ? { ...t, phase: "committed" } : t) }));
    if (transaction.retirementBackupId !== null) {
      const old = index.active.find(p => p.backupId === transaction.retirementBackupId);
      if (old) {
        index = await saveIndex(paths, changed(index, at, { transactions: index.transactions.map(t => t.transactionId === transaction.transactionId ? { ...t, phase: "rotation-pending" } : t) }));
        const moved = await retireUnderLock(paths, index, old, policy, at);
        if (moved.status !== "settled") return moved; index = moved.index;
      } else if (!index.recoverable.some(p => p.backupId === transaction.retirementBackupId)) return pendingResult(paths, index, at, "pending", "retirement-readback-unknown");
    }
    index = await saveIndex(paths, changed(index, at, { transactions: index.transactions.filter(t => t.transactionId !== transaction.transactionId), lastError: null }));
  }
  return { status: "settled", index, reason: null };
}
async function retireUnderLock(paths: GroupPaths, index: ConfigBackupGroupIndex, old: ConfigBackupStoredPackage, policy: ConfigBackupRetentionPolicy, at: string): Promise<ConfigBackupOperationResult> {
  if (index.recoverable.length >= policy.recoveryLimit || Date.parse(at) - Date.parse(old.completedAt) < policy.retentionDuration || index.active.filter(p => p.backupId !== old.backupId).length < 1) return pendingResult(paths, index, at, "stop-new-and-report", "retirement-capacity-or-retention");
  for (const current of index.active.filter(p => p.backupId !== old.backupId)) {
    if ((await verifyConfigBackup(join(paths.active, current.directory))).manifest?.manifestDigest !== current.manifestDigest) return pendingResult(paths, index, at, "pending", "replacement-not-verified");
  }
  const source = join(paths.active, old.directory); const target = join(paths.recovery, old.directory);
  const hasSource = await exists(source); const hasTarget = await exists(target);
  if (hasSource && hasTarget) return pendingResult(paths, index, at, "pending", "retirement-conflict");
  const verification = await verifyConfigBackup(hasTarget ? target : source);
  if (verification.integrity !== "verified" || verification.manifest?.manifestDigest !== old.manifestDigest) return pendingResult(paths, index, at, "pending", "retirement-integrity-unknown");
  if (!hasTarget) {
    await assertConfigBackupDirectory(paths.recovery); await assertConfigBackupDirectory(source); await rename(source, target);
    if ((await verifyConfigBackup(target)).manifest?.manifestDigest !== old.manifestDigest || await exists(source)) return pendingResult(paths, index, at, "pending", "retirement-readback-unknown");
  }
  const recovered: ConfigBackupStoredPackage = { ...old, origin: "retired", recoverableUntil: new Date(Date.parse(at) + policy.recoveryDuration).toISOString() };
  const next = await saveIndex(paths, changed(index, at, { active: index.active.filter(p => p.backupId !== old.backupId), recoverable: [...index.recoverable, recovered] }));
  return { status: "settled", index: next, reason: null };
}
export async function resumeConfigBackup(store: ConfigBackupStore, at: string, mode: "resume" | "recover-failed" = "resume"): Promise<ConfigBackupOperationResult> {
  configBackupInstant(at); approvedPolicy(store); await assertConfigBackupReservedRoot(store.reservedRoot, store.protectedRoots); const paths = groupPaths(store);
  await assertConfigBackupDirectory(paths.active);
  return withFileLock(join(paths.active, ".writer.lock"), async () => {
    const index = await readIndex(paths); if (!index) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND");
    await assertLocalBinding(store, false); assertBinding(index, store); await assertTracked(paths, index);
    try {
      if (mode === "recover-failed") return await recoverFailedTransaction(store, paths, index, at);
      return await resumeUnderLock(store, paths, index, at);
    } catch (error) {
      let current = index;
      try { current = (await readIndex(paths)) ?? index; assertBinding(current, store); } catch { return { status: "pending", index, reason: "CONFIG_BACKUP_ERROR_PERSISTENCE_UNKNOWN" }; }
      return pendingResult(paths, current, at, "pending", error instanceof Error && "reasonCode" in error ? String(error.reasonCode) : "CONFIG_BACKUP_WRITE_UNKNOWN");
    }
  }, { command: "einzbern config-backup-resume", ...(store.lockTimeoutMs === undefined ? {} : { timeoutMs: store.lockTimeoutMs }) });
}
async function recoverFailedTransaction(store: ConfigBackupStore, paths: GroupPaths, initial: ConfigBackupGroupIndex, at: string): Promise<ConfigBackupOperationResult> {
  let index = initial; assertBinding(index, store); await assertTracked(paths, index);
  const policy = approvedPolicy(store).policy;
  for (const transaction of index.transactions) {
    // A committed/unknown publication is reconciled by resume, not recast as a failed backup.
    if (transaction.phase !== "staging" || await exists(join(paths.active, transaction.directory))) return pendingResult(paths, index, at, "pending", "resume-publication-first");
    if (index.recoverable.length >= policy.recoveryLimit) return pendingResult(paths, index, at, "stop-new-and-report", "recovery-limit");
    const source = join(paths.staging, transaction.directory); const target = join(paths.recovery, transaction.directory);
    const hasSource = await exists(source); const hasTarget = await exists(target);
    if (hasSource === hasTarget) return pendingResult(paths, index, at, "pending", hasSource ? "recovery-conflict" : "transaction-bytes-unavailable");
    const inventory = async (root: string): Promise<string> => {
      await assertConfigBackupDirectory(root); const records: { path: string; bytes: number; digest: string }[] = [];
      for (const name of await readdir(root)) {
        if (name === "members") {
          await assertConfigBackupDirectory(join(root, name));
          for (const member of await readdir(join(root, name))) {
            if (!/^[a-f0-9]{64}\.json$/u.test(member)) configBackupFail("CONFIG_BACKUP_UNEXPECTED_MEMBER");
            const bytes = await readConfigBackupFile(root, `members/${member}`); records.push({ path: `members/${member}`, bytes: bytes.length, digest: configBackupDigest(bytes) });
          }
        } else if (name === "manifest.json") {
          const bytes = await readConfigBackupFile(root, name); records.push({ path: name, bytes: bytes.length, digest: configBackupDigest(bytes) });
        } else configBackupFail("CONFIG_BACKUP_UNEXPECTED_MEMBER");
      }
      if (records.reduce((sum, record) => sum + record.bytes, 0) > transaction.bytes) configBackupFail("CONFIG_BACKUP_RECOVERY_CAPACITY");
      return configBackupDigest(configBackupCanonical(records.sort((a, b) => a.path < b.path ? -1 : 1)));
    };
    const digest = await inventory(hasTarget ? target : source);
    if (!hasTarget) { await assertConfigBackupDirectory(paths.recovery); await rename(source, target); }
    if (await inventory(target) !== digest || await exists(source)) return pendingResult(paths, index, at, "pending", "recovery-readback-unknown");
    const recovered: ConfigBackupStoredPackage = { backupId: transaction.backupId, directory: transaction.directory, manifestDigest: transaction.manifestDigest, selectionDigest: digest, bytes: transaction.bytes, completedAt: transaction.startedAt, recoverableUntil: new Date(Date.parse(at) + policy.recoveryDuration).toISOString(), origin: "failed-transaction" };
    index = await saveIndex(paths, changed(index, at, { transactions: index.transactions.filter(t => t.transactionId !== transaction.transactionId), recoverable: [...index.recoverable, recovered], lastError: "failed-transaction-preserved-not-verified" }));
  }
  return { status: "settled", index, reason: "failed-bytes-preserved-not-a-verified-backup" };
}
export async function retireConfigBackup(store: ConfigBackupStore, backupId: string, at: string): Promise<ConfigBackupOperationResult> {
  configBackupId(backupId); configBackupInstant(at); const policy = approvedPolicy(store).policy;
  await assertConfigBackupReservedRoot(store.reservedRoot, store.protectedRoots); const paths = groupPaths(store); await assertConfigBackupDirectory(paths.active);
  return withFileLock(join(paths.active, ".writer.lock"), async () => {
    const index = await readIndex(paths); if (!index) configBackupFail("CONFIG_BACKUP_GROUP_UNBOUND"); await assertLocalBinding(store, false); assertBinding(index, store); await assertTracked(paths, index);
    if (index.transactions.length) return pendingResult(paths, index, at, "pending", "resume-existing-transaction-first");
    const old = index.active.find(p => p.backupId === backupId);
    if (!old) return { status: index.recoverable.some(p => p.backupId === backupId) ? "unchanged" : "pending", index, reason: "read-existing-retirement" };
    // Persist the exact old package before any move, so a missing response is recoverable.
    const newest = index.active.findLast(p => p.backupId !== backupId); if (!newest) return pendingResult(paths, index, at, "stop-new-and-report", "retain-last-active");
    const transaction: ConfigBackupTransaction = { transactionId: old.backupId, backupId: newest.backupId, directory: newest.directory, manifestDigest: newest.manifestDigest, bytes: 0, startedAt: at, phase: "rotation-pending", retirementBackupId: old.backupId };
    const pending = await saveIndex(paths, changed(index, at, { transactions: [transaction] }));
    try {
      const result = await retireUnderLock(paths, pending, old, policy, at);
      if (result.status !== "settled") return result;
      return { status: "settled", reason: null, index: await saveIndex(paths, changed(result.index, at, { transactions: [], lastError: null })) };
    } catch (error) {
      let current = pending;
      try { current = (await readIndex(paths)) ?? pending; assertBinding(current, store); } catch { return { status: "pending", index: pending, reason: "CONFIG_BACKUP_ERROR_PERSISTENCE_UNKNOWN" }; }
      return pendingResult(paths, current, at, "pending", error instanceof Error && "reasonCode" in error ? String(error.reasonCode) : "CONFIG_BACKUP_WRITE_UNKNOWN");
    }
  }, { command: "einzbern config-backup-retire", ...(store.lockTimeoutMs === undefined ? {} : { timeoutMs: store.lockTimeoutMs }) });
}

export interface ConfigBackupListGroup {
  readonly backupGroupId: string; readonly hostname: string; readonly projectRef: ConfigBackupProjectRef | null;
  readonly activeCount: number | null; readonly transactionCount: number | null; readonly recoverableCount: number | null;
  readonly bytes: number | null; readonly completedAt: string | null;
  readonly integrity: "verified" | "corrupt" | "unreadable" | "missing-index" | "discovered";
  readonly transactionPhases: readonly ConfigBackupTransaction["phase"][] | null;
  readonly syncStatus: "unknown"; readonly error: string | null;
}
export interface ConfigBackupList {
  readonly schemaVersion: "einzbern.config-backup-list.v1";
  readonly scanStatus: "not-scanned" | "empty" | "scanned" | "unreadable" | "partial";
  readonly scannedAt: string | null; readonly groups: readonly ConfigBackupListGroup[];
  readonly error: string | null;
}
async function measuredPackageBytes(root: string): Promise<number> {
  await assertConfigBackupDirectory(root); let total = 0;
  for (const name of await readdir(root)) {
    if (name === "manifest.json") total += (await readConfigBackupFile(root, name)).length;
    else if (name === "members") {
      await assertConfigBackupDirectory(join(root, name));
      for (const member of await readdir(join(root, name))) {
        if (!/^[a-f0-9]{64}\.json$/u.test(member)) configBackupFail("CONFIG_BACKUP_UNEXPECTED_MEMBER");
        total += (await readConfigBackupFile(root, `members/${member}`)).length;
      }
    } else configBackupFail("CONFIG_BACKUP_UNEXPECTED_MEMBER");
  }
  if (!Number.isSafeInteger(total)) configBackupFail("CONFIG_BACKUP_SIZE_INVALID"); return total;
}
export async function listConfigBackups(input: { readonly reservedRoot?: string; readonly at: string }): Promise<ConfigBackupList> {
  configBackupInstant(input.at);
  const result = (scanStatus: ConfigBackupList["scanStatus"], groups: readonly ConfigBackupListGroup[], error: string | null = null): ConfigBackupList => ({ schemaVersion: "einzbern.config-backup-list.v1", scanStatus, scannedAt: scanStatus === "not-scanned" ? null : input.at, groups, error });
  if (input.reservedRoot === undefined) return result("not-scanned", []);
  const groups: ConfigBackupListGroup[] = [];
  try {
    await assertConfigBackupDirectory(input.reservedRoot);
    const discovered = new Map<string, { host: string; id: string }>();
    for (const area of CONFIG_BACKUP_RESERVED_ROOTS) {
      const base = join(input.reservedRoot, area);
      if (!(await exists(base))) continue;
      await assertConfigBackupDirectory(base);
      for (const host of await readdir(base)) {
        if (!/^[A-Za-z0-9_-]+$/u.test(host)) configBackupFail("CONFIG_BACKUP_PATH_INVALID");
        const hostRoot = join(base, host); await assertConfigBackupDirectory(hostRoot);
        for (const id of await readdir(hostRoot)) { configBackupId(id); discovered.set(`${host}/${id}`, { host, id }); }
      }
    }
    for (const { host, id } of discovered.values()) {
        const active = join(input.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[0], host, id);
        let row: ConfigBackupListGroup = { backupGroupId: id, hostname: host, projectRef: null, activeCount: null, transactionCount: null, recoverableCount: null, bytes: null, completedAt: null, integrity: "discovered", transactionPhases: null, syncStatus: "unknown", error: null };
        try {
          const paths = { active, staging: join(input.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[1], host, id), recovery: join(input.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[2], host, id) };
          const index = await readIndex(paths);
          if (!index) row = { ...row, integrity: "missing-index", error: "CONFIG_BACKUP_INDEX_MISSING" };
          else {
            if (index.backupGroupId !== id || safeConfigBackupHostname(index.hostname) !== host) configBackupFail("CONFIG_BACKUP_GROUP_CONFLICT");
            await assertTracked(paths, index);
            let integrity: ConfigBackupListGroup["integrity"] = index.transactions.length ? "discovered" : "verified";
            let actualBytes = 0;
            for (const [root, packages] of [[active, index.active], [paths.recovery, index.recoverable]] as const) for (const entry of packages) {
              const packageRoot = join(root, entry.directory); actualBytes += await measuredPackageBytes(packageRoot);
              if ((await verifyConfigBackup(packageRoot)).manifest?.manifestDigest !== entry.manifestDigest) integrity = "corrupt";
            }
            for (const transaction of index.transactions.filter(t => !index.active.some(p => p.backupId === t.backupId))) {
              const pending = join(paths.staging, transaction.directory);
              if (await exists(pending)) actualBytes += await measuredPackageBytes(pending);
              else if (await exists(join(paths.active, transaction.directory))) actualBytes += await measuredPackageBytes(join(paths.active, transaction.directory));
              else if (await exists(join(paths.recovery, transaction.directory))) actualBytes += await measuredPackageBytes(join(paths.recovery, transaction.directory));
            }
            row = { ...row, hostname: index.hostname, projectRef: index.projectRef, activeCount: index.active.length, transactionCount: index.transactions.length, recoverableCount: index.recoverable.length, bytes: actualBytes, transactionPhases: [...new Set(index.transactions.map(transaction => transaction.phase))], completedAt: index.active.map(p => p.completedAt).sort().at(-1) ?? null, integrity, error: integrity === "corrupt" ? "CONFIG_BACKUP_VERIFICATION_FAILED" : index.lastError ?? (index.transactions.length ? `transaction-${index.transactions[0]!.phase}` : null) };
          }
        } catch (error) { row = { ...row, integrity: ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ? "unreadable" : "corrupt", error: "CONFIG_BACKUP_GROUP_UNREADABLE" }; }
        groups.push(row);
    }
    return result(groups.some(g => g.error !== null) ? "partial" : groups.length ? "scanned" : "empty", groups);
  } catch { return result(groups.length ? "partial" : "unreadable", groups, "CONFIG_BACKUP_SCAN_FAILED"); }
}
