// SPDX-License-Identifier: Apache-2.0
// CFG-B03/B04/P01. Synthetic policy values below are fixture-only, not product defaults.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configBackupCanonical, planConfigBackup } from "../dist/build/packages/core/src/config-backup.js";
import { createConfigBackup, evaluateConfigBackupEnablement, listConfigBackups, resumeConfigBackup, retireConfigBackup, validateConfigBackupRetentionPolicy } from "../dist/build/packages/core/src/config-backup-retention.js";
const ref = { libraryId: `workspace:${"1".repeat(24)}`, projectId: `project:${"2".repeat(24)}` };
const version = { engineVersion: "3.1.0", engineCommit: null, engineCommitStatus: "unknown", artifactIdentity: { kind: "observed-artifact-identity", schemaVersion: "einzbern.install-tree-digest.v1", sha256: "3".repeat(64) }, templateVersions: ["rules-v1"] };
const fixturePolicy = { schemaVersion: "einzbern.config-backup-retention.v1", activeLimit: 1, transactionLimit: 1, recoveryLimit: 2, maxPackageBytes: 65536, maxTotalBytes: 262144, retentionDuration: 1000, recoveryDuration: 86400000, noChangePolicy: "skip", atLimitAction: "stop-new-and-report", retirementMethod: "verified-recovery-move", approvalEvidenceRef: "fixture-only:retention-policy" };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-config-retention-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const reserve = join(root, "reserve"); const project = join(root, "project"); await mkdir(reserve); await mkdir(project);
  const approved = validateConfigBackupRetentionPolicy(fixturePolicy);
  const store = { reservedRoot: reserve, localBindingRoot: join(root, "config-backup-bindings"), protectedRoots: [project], binding: { projectRef: ref, backupGroupId: "4".repeat(32), writerBindingRef: "fixture-only:writer", executionEnvironmentRef: "fixture-only:environment", hostname: "device" }, policy: fixturePolicy, approval: { approved: true, policyDigest: approved.policyDigest, approvalEvidenceRef: fixturePolicy.approvalEvidenceRef } };
  return { root, store, proposal: (id, theme, at) => planConfigBackup({ projectRef: ref, backupId: id.repeat(32), backupGroupId: store.binding.backupGroupId, hostname: "device", sourceVersion: version, at, payloads: [{ kind: "device-preference", key: "portal.defaultTheme", value: theme, source: "device-declaration" }] }) };
}
test("CFG-B03: every field and actual approval are required; no production defaults", () => {
  assert.equal(validateConfigBackupRetentionPolicy(undefined).status, "policy-unapproved");
  for (const key of Object.keys(fixturePolicy)) { const policy = { ...fixturePolicy }; delete policy[key]; assert.equal(validateConfigBackupRetentionPolicy(policy).status, "policy-unapproved", key); }
  const fields = { policy: fixturePolicy, approval: null, whitelistSupported: true, restoreSupported: true, groupBound: true, safeRetirementSupported: true, enablementAuthorized: true };
  assert.deepEqual(evaluateConfigBackupEnablement(fields), { eligible: false, reason: "policy-unapproved", policyDigest: null });
  const valid = validateConfigBackupRetentionPolicy(fixturePolicy);
  const approval = { approved: true, policyDigest: valid.policyDigest, approvalEvidenceRef: fixturePolicy.approvalEvidenceRef };
  assert.equal(evaluateConfigBackupEnablement({ ...fields, approval }).eligible, true);
  assert.equal(evaluateConfigBackupEnablement({ ...fields, approval, safeRetirementSupported: false }).reason, "capability-unavailable");
  assert.equal(evaluateConfigBackupEnablement({ ...fields, approval, enablementAuthorized: false }).reason, "enablement-unapproved");
});
test("CFG-B03: new verified publication precedes recoverable retirement; no bytes are deleted", async (t) => {
  const f = await fixture(t); const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
  const a = await createConfigBackup(f.store, first, first.manifest.createdAtUtc); assert.equal(a.status, "settled");
  const same = await createConfigBackup(f.store, f.proposal("6", "dark", "2026-10-20T00:00:01Z"), "2026-10-20T00:00:01Z"); assert.equal(same.status, "unchanged");
  const second = f.proposal("7", "light", "2026-10-20T00:00:02Z"); const b = await createConfigBackup(f.store, second, second.manifest.createdAtUtc);
  assert.equal(b.status, "settled"); assert.deepEqual(b.index.activeBackupIds, [second.manifest.backupId]); assert.deepEqual(b.index.recoverableBackupIds, [first.manifest.backupId]); assert.deepEqual(b.index.transactionIds, []);
  const old = b.index.recoverable[0]; assert.ok(await readFile(join(f.store.reservedRoot, "config-backup-recovery", "device", f.store.binding.backupGroupId, old.directory, "manifest.json")));
  const list = await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:03Z" });
  assert.equal(list.groups[0].activeCount, 1); assert.equal(list.groups[0].recoverableCount, 1); assert.equal(list.groups[0].transactionCount, 0); assert.equal(list.groups[0].syncStatus, "unknown");
  assert.equal(list.groups[0].completedAt, second.manifest.createdAtUtc); assert.notEqual(list.groups[0].completedAt, list.scannedAt);
  assert.equal((await retireConfigBackup(f.store, second.manifest.backupId, "2026-10-20T00:00:04Z")).status, "stop-new-and-report");
});
test("CFG-B03: failure retains prior active package and blocks a new transaction until readback", async (t) => {
  const f = await fixture(t); const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z"); await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  const next = f.proposal("6", "light", "2026-10-20T00:00:02Z");
  // A sequential, explicit staging fixture models an earlier incomplete transaction. It does
  // not kill a process, race a writer or touch an actual installation.
  const group = join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId);
  const index = JSON.parse(await readFile(join(group, "index.json"), "utf8"));
  const transaction = { transactionId: next.manifest.backupId, backupId: next.manifest.backupId, directory: `${next.manifest.createdAtUtc.replace(/[:.]/gu, "-")}-${next.manifest.backupId}`, manifestDigest: next.manifest.manifestDigest, bytes: next.bytes, startedAt: next.manifest.createdAtUtc, phase: "staging", retirementBackupId: first.manifest.backupId };
  const stage = join(f.store.reservedRoot, "config-backup-staging", "device", f.store.binding.backupGroupId, transaction.directory);
  await mkdir(stage); await mkdir(join(stage, "members"));
  await writeFile(join(stage, "members", "a".repeat(64) + ".json"), "{}");
  await writeFile(join(group, "index.json"), configBackupCanonical({ ...index, revision: index.revision + 1, transactions: [transaction], transactionIds: [transaction.transactionId] }));
  assert.equal((await createConfigBackup(f.store, f.proposal("7", "light", "2026-10-20T00:00:03Z"), "2026-10-20T00:00:03Z")).status, "pending");
  const pending = await resumeConfigBackup(f.store, "2026-10-20T00:00:04Z");
  assert.equal(pending.status, "pending"); assert.equal(pending.index.lastError, "transaction-needs-explicit-recovery");
  const pendingList = await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:04Z" });
  assert.equal(pendingList.groups[0].error, pending.index.lastError); assert.deepEqual(pendingList.groups[0].transactionPhases, ["staging"]);
  const blocked = await createConfigBackup(f.store, f.proposal("7", "light", "2026-10-20T00:00:04Z"), "2026-10-20T00:00:04Z");
  assert.equal(blocked.status, "pending"); assert.equal(blocked.index.lastError, pending.index.lastError);
  const recovered = await resumeConfigBackup(f.store, "2026-10-20T00:00:05Z", "recover-failed");
  assert.equal(recovered.status, "settled"); assert.deepEqual(recovered.index.activeBackupIds, [first.manifest.backupId]);
  assert.equal(recovered.index.recoverable[0].origin, "failed-transaction");
  assert.equal(recovered.index.transactions.length, 0);
  const retained = join(f.store.reservedRoot, "config-backup-recovery", "device", f.store.binding.backupGroupId, transaction.directory, "members", "a".repeat(64) + ".json");
  await writeFile(retained, "x".repeat(transaction.bytes + 1));
  await assert.rejects(createConfigBackup(f.store, f.proposal("8", "light", "2026-10-20T00:00:06Z"), "2026-10-20T00:00:06Z"), { reasonCode: "CONFIG_BACKUP_RECOVERY_CAPACITY" });
});
test("CFG-B04: display hostname never grants ownership or merges groups", async (t) => {
  const f = await fixture(t); const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z"); await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  const foreign = { ...f.store, binding: { ...f.store.binding, writerBindingRef: "another-writer" } };
  await assert.rejects(resumeConfigBackup(foreign, "2026-10-20T00:00:02Z"), { reasonCode: "CONFIG_BACKUP_GROUP_UNBOUND" });
  await assert.rejects(createConfigBackup({ ...f.store, approval: null }, first, first.manifest.createdAtUtc), { reasonCode: "policy-unapproved" });
});
test("CFG-P01: unconfigured, empty, missing-index, corrupt and unreadable are distinct", async (t) => {
  const f = await fixture(t); const at = "2026-10-20T00:00:00Z";
  assert.equal((await listConfigBackups({ at })).scanStatus, "not-scanned");
  assert.equal((await listConfigBackups({ reservedRoot: f.store.reservedRoot, at })).scanStatus, "empty");
  const group = join(f.store.reservedRoot, "config-backups", "device", "4".repeat(32)); await mkdir(group, { recursive: true });
  assert.equal((await listConfigBackups({ reservedRoot: f.store.reservedRoot, at })).groups[0].integrity, "missing-index");
  await writeFile(join(group, "index.json"), "not json");
  assert.equal((await listConfigBackups({ reservedRoot: f.store.reservedRoot, at })).groups[0].integrity, "corrupt");
  assert.equal((await listConfigBackups({ reservedRoot: join(f.root, "missing"), at })).scanStatus, "unreadable");
});

test("CFG-B04: losing the local binding cannot be repaired by copying the hostname or index", async (t) => {
  const f = await fixture(t); const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
  await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  await rm(join(f.store.localBindingRoot, f.store.binding.backupGroupId + ".json"));
  await assert.rejects(resumeConfigBackup(f.store, "2026-10-20T00:00:02Z"), { reasonCode: "CONFIG_BACKUP_GROUP_UNBOUND" });
});

test("J05 no-change skip includes the verified recoverable source version", async t => {
  const f = await fixture(t); const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
  await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  const next = planConfigBackup({ projectRef: ref, backupId: "6".repeat(32), backupGroupId: f.store.binding.backupGroupId, hostname: "device", sourceVersion: { ...version, artifactIdentity: { ...version.artifactIdentity, sha256: "9".repeat(64) } }, at: "2026-10-20T00:00:02Z", payloads: first.members.map(member => member.payload) });
  assert.equal(next.manifest.selectionDigest, first.manifest.selectionDigest);
  const result = await createConfigBackup(f.store, next, next.manifest.createdAtUtc);
  assert.equal(result.status, "settled"); assert.equal(result.index.active.at(-1).backupId, next.manifest.backupId);
});

test("J07 existing capacity refusal is persisted and visible through the list surface", async t => {
  const f = await fixture(t); const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
  await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  const result = await retireConfigBackup(f.store, first.manifest.backupId, "2026-10-20T00:00:01Z");
  assert.equal(result.reason, "retain-last-active"); assert.equal(result.index.lastError, result.reason);
  const list = await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:02Z" });
  assert.equal(list.groups[0].error, result.reason); assert.deepEqual(list.groups[0].transactionPhases, []);
});

test("J07 sequential rotation capacity retains transaction phase and reason on a later list", async t => {
  const f = await fixture(t);
  const policy = { ...fixturePolicy, activeLimit: 2, recoveryLimit: 1 };
  const approved = validateConfigBackupRetentionPolicy(policy);
  const store = { ...f.store, policy, approval: { approved: true, policyDigest: approved.policyDigest, approvalEvidenceRef: policy.approvalEvidenceRef } };
  for (const [id, theme, at] of [["5", "dark", "2026-10-20T00:00:00Z"], ["6", "light", "2026-10-20T00:00:02Z"], ["7", "dark", "2026-10-20T00:00:04Z"]]) assert.equal((await createConfigBackup(store, f.proposal(id, theme, at), at)).status, "settled");
  const result = await retireConfigBackup(store, "6".repeat(32), "2026-10-20T00:00:06Z");
  assert.equal(result.status, "stop-new-and-report"); assert.equal(result.index.lastError, "retirement-capacity-or-retention");
  assert.deepEqual(result.index.activeBackupIds, ["6".repeat(32), "7".repeat(32)]);
  const listed = await listConfigBackups({ reservedRoot: store.reservedRoot, at: "2026-10-20T00:00:07Z" });
  assert.deepEqual(listed.groups[0].transactionPhases, ["rotation-pending"]); assert.equal(listed.groups[0].error, result.index.lastError);
});
