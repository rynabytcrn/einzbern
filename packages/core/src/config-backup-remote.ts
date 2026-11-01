// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";
import { configBackupCanonical, configBackupDigest, configBackupFail, configBackupId, configBackupInstant, configBackupObject, configBackupString, readConfigBackupFile, verifyConfigBackup } from "./config-backup.js";

/** Correlated caller observations, not storage-provider authentication or a transfer SDK. */
export interface ConfigBackupRemoteIdentity {
  readonly backupId: string; readonly manifestDigest: string; readonly packageId: string;
  readonly membersDirectoryId: string; readonly filesDigest: string;
}
export interface ConfigBackupRemoteIntent {
  readonly phase: "prepared" | "commit-pending" | "complete-validated";
  readonly beginDigest: string | null; readonly completeDigest: string | null;
  readonly begunAt: string | null; readonly completedAt: string | null;
  readonly locations: ConfigBackupRemoteLocations | null;
  readonly replacement: ConfigBackupRemoteIdentity | null; readonly original: ConfigBackupRemoteIdentity | null;
}
export interface ConfigBackupRemoteCompletion { readonly beginDigest: string; readonly completeDigest: string; readonly completedAt: string }
export interface ConfigBackupRemoteLocations { readonly destinationRef: string; readonly stagingAreaId: string; readonly activeAreaId: string; readonly recoveryAreaId: string }
export const CONFIG_BACKUP_REMOTE_METADATA_BYTES = 4096;
/** Canonical UTF-8 worst case through complete-validated + coexisting compact row. */
export function remoteIntentLifecycleBytes(remote: ConfigBackupRemoteIntent): number {
  if (remote.phase === "prepared") return Buffer.byteLength(configBackupCanonical(remote));
  // configBackupInstant accepts UTC only; protocol fractional precision is at most nine digits.
  const completedAt = "9999-12-31T23:59:59.999999999Z", completeDigest = "f".repeat(64);
  const completed = { ...remote, phase: "complete-validated", completeDigest, completedAt };
  const compact = { beginDigest: remote.beginDigest, completeDigest, completedAt };
  return Buffer.byteLength(configBackupCanonical(completed)) + Buffer.byteLength(configBackupCanonical(compact));
}
const digest = (value: unknown): string => { const text = configBackupString(value); if (!/^[a-f0-9]{64}$/u.test(text)) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID"); return text; };
const opaque = (value: unknown): string => { const text = configBackupString(value); if (text.length > 256) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID"); return text; };
export function validateRemoteLocations(value: unknown): ConfigBackupRemoteLocations {
  const v = configBackupObject(value, ["destinationRef", "stagingAreaId", "activeAreaId", "recoveryAreaId"]);
  const result = { destinationRef: opaque(v.destinationRef), stagingAreaId: opaque(v.stagingAreaId), activeAreaId: opaque(v.activeAreaId), recoveryAreaId: opaque(v.recoveryAreaId) };
  if (new Set([result.stagingAreaId, result.activeAreaId, result.recoveryAreaId]).size !== 3) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID"); return result;
}
function identity(value: unknown): ConfigBackupRemoteIdentity {
  const v = configBackupObject(value, ["backupId", "manifestDigest", "packageId", "membersDirectoryId", "filesDigest"]);
  return { backupId: configBackupId(v.backupId), manifestDigest: digest(v.manifestDigest), packageId: opaque(v.packageId), membersDirectoryId: opaque(v.membersDirectoryId), filesDigest: digest(v.filesDigest) };
}
export function validateRemoteCompletion(value: unknown): ConfigBackupRemoteCompletion {
  const v = configBackupObject(value, ["beginDigest", "completeDigest", "completedAt"]);
  return { beginDigest: digest(v.beginDigest), completeDigest: digest(v.completeDigest), completedAt: configBackupInstant(v.completedAt) };
}
export function validateRemoteIntent(value: unknown): ConfigBackupRemoteIntent {
  const v = configBackupObject(value, ["phase", "beginDigest", "completeDigest", "begunAt", "completedAt", "locations", "replacement", "original"]);
  if (v.phase === "prepared") {
    if ([v.beginDigest, v.completeDigest, v.begunAt, v.completedAt, v.locations, v.replacement, v.original].some(x => x !== null)) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID");
  } else if (v.phase === "commit-pending" || v.phase === "complete-validated") {
    digest(v.beginDigest); configBackupInstant(v.begunAt); validateRemoteLocations(v.locations); identity(v.replacement); if (v.original !== null) identity(v.original);
    if (v.phase === "commit-pending") { if (v.completeDigest !== null || v.completedAt !== null) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID"); }
    else { digest(v.completeDigest); configBackupInstant(v.completedAt); if (Date.parse(String(v.completedAt)) < Date.parse(String(v.begunAt))) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID"); }
  } else configBackupFail("CONFIG_BACKUP_REMOTE_INVALID");
  const remote = v as unknown as ConfigBackupRemoteIntent;
  if (remoteIntentLifecycleBytes(remote) > CONFIG_BACKUP_REMOTE_METADATA_BYTES) configBackupFail("CONFIG_BACKUP_REMOTE_METADATA_CAPACITY");
  return remote;
}
export const preparedRemoteIntent = (): ConfigBackupRemoteIntent => ({ phase: "prepared", beginDigest: null, completeDigest: null, begunAt: null, completedAt: null, locations: null, replacement: null, original: null });

/** Strictly bounded request envelope; full raw receipts remain caller-owned, not an unbounded index log. */
export function remoteRequest(value: unknown, mode: "begin" | "complete"): Record<string, unknown> {
  const v = configBackupObject(value, mode === "begin" ? ["schemaVersion", "backupId", "locations", "replacement", "original"] : ["schemaVersion", "backupId", "beginDigest", "replacement", "original", "retiredAt", "promotedAt"]);
  if (v.schemaVersion !== `einzbern.config-backup-remote-${mode}.v1` || Buffer.byteLength(configBackupCanonical(v)) > 1024 * 1024) configBackupFail("CONFIG_BACKUP_REMOTE_INVALID");
  configBackupId(v.backupId); if (mode === "complete") digest(v.beginDigest); return v;
}
export function remoteEvidenceDigest(value: unknown): string { return configBackupDigest(configBackupCanonical(value)); }

export async function verifyRemotePackage(value: unknown, expected: { readonly backupId: string; readonly manifestDigest: string; readonly backupGroupId: string; readonly projectRef: unknown; readonly areaId: string; readonly areaIds: readonly string[]; readonly notBefore: string; readonly at: string }): Promise<{ readonly identity: ConfigBackupRemoteIdentity; readonly verifiedAt: string; readonly objectIds: readonly string[] }> {
  const v = configBackupObject(value, ["packageRoot", "backupId", "manifestDigest", "packageId", "packageParentId", "membersDirectory", "areaId", "files", "verifiedAt", "evidenceRef"]);
  const packageRoot = configBackupString(v.packageRoot); if (!isAbsolute(packageRoot)) configBackupFail("CONFIG_BACKUP_PATH_INVALID");
  opaque(v.evidenceRef); const packageId = opaque(v.packageId); opaque(v.areaId);
  const directory = configBackupObject(v.membersDirectory, ["id", "parentId", "name"]), membersDirectoryId = opaque(directory.id);
  if (v.packageParentId !== expected.areaId || directory.parentId !== packageId || directory.name !== "members" || membersDirectoryId === packageId || [packageId, membersDirectoryId].some(id => expected.areaIds.includes(id))) configBackupFail("CONFIG_BACKUP_REMOTE_DIRECTORIES_INVALID");
  if (v.backupId !== expected.backupId || v.manifestDigest !== expected.manifestDigest || v.areaId !== expected.areaId) configBackupFail("CONFIG_BACKUP_REMOTE_MISMATCH");
  const verifiedAt = configBackupInstant(v.verifiedAt);
  if (Date.parse(verifiedAt) < Date.parse(expected.notBefore) || Date.parse(verifiedAt) > Date.parse(expected.at)) configBackupFail("CONFIG_BACKUP_REMOTE_ORDER");
  // Never accept a caller's integrity=verified boolean or a manifest's own state declaration.
  const verified = await verifyConfigBackup(packageRoot); const manifest = verified.manifest;
  if (verified.integrity !== "verified" || !manifest || manifest.backupId !== expected.backupId || manifest.manifestDigest !== expected.manifestDigest || manifest.backupGroupId !== expected.backupGroupId || configBackupCanonical(manifest.projectRef) !== configBackupCanonical(expected.projectRef)) configBackupFail("CONFIG_BACKUP_REMOTE_BYTES_INVALID");
  const manifestBytes = await readConfigBackupFile(packageRoot, "manifest.json");
  const expectedFiles = [...manifest.files.map(f => ({ path: f.memberPath, bytes: f.bytes, sha256: f.sha256 })), { path: "manifest.json", bytes: manifestBytes.length, sha256: configBackupDigest(manifestBytes) }];
  if (!Array.isArray(v.files) || v.files.length !== expectedFiles.length) configBackupFail("CONFIG_BACKUP_REMOTE_FILES_INVALID");
  const ids = new Set<string>(), paths = new Set<string>(); const published: { path: string; at: number }[] = [];
  const files = v.files.map(raw => {
    const f = configBackupObject(raw, ["path", "id", "parentId", "bytes", "sha256", "publishedAt", "downloadedAt"]);
    const path = configBackupString(f.path), id = opaque(f.id); const member = expectedFiles.find(x => x.path === path);
    if (!member || ids.has(id) || paths.has(path) || (id === packageId || id === membersDirectoryId || expected.areaIds.includes(id)) || f.parentId !== (path === "manifest.json" ? packageId : membersDirectoryId) || f.bytes !== member.bytes || f.sha256 !== member.sha256) configBackupFail("CONFIG_BACKUP_REMOTE_FILES_INVALID");
    ids.add(id); paths.add(path);
    const p = Date.parse(configBackupInstant(f.publishedAt)), d = Date.parse(configBackupInstant(f.downloadedAt));
    if (p > d || d > Date.parse(verifiedAt) || d < Date.parse(expected.notBefore)) configBackupFail("CONFIG_BACKUP_REMOTE_ORDER");
    published.push({ path, at: p }); return { path, id, bytes: member.bytes, sha256: member.sha256 };
  });
  const manifestPublished = published.find(x => x.path === "manifest.json")!.at;
  if (published.some(x => x.path !== "manifest.json" && x.at > manifestPublished)) configBackupFail("CONFIG_BACKUP_REMOTE_ORDER");
  return { identity: { backupId: manifest.backupId, manifestDigest: manifest.manifestDigest, packageId, membersDirectoryId, filesDigest: remoteEvidenceDigest(files.sort((a, b) => a.path < b.path ? -1 : 1)) }, verifiedAt, objectIds: [packageId, membersDirectoryId, ...ids] };
}
