// SPDX-License-Identifier: Apache-2.0
// CFG-B03/B04/P01. Synthetic policy values below are fixture-only, not product defaults.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configBackupCanonical, planConfigBackup, writeConfigBackupPackage } from "../dist/build/packages/core/src/config-backup.js";
import { createConfigBackup, evaluateConfigBackupEnablement, listConfigBackups, resumeConfigBackup, retireConfigBackup, validateConfigBackupRetentionPolicy } from "../dist/build/packages/core/src/config-backup-retention.js";
import { CONFIG_BACKUP_RESERVATION_FILE, CONFIG_BACKUP_RESERVATION_TEXT } from "../scripts/lib/config-backup-reservation.mjs";
import { runConfigBackupCommand } from "../dist/build/packages/cli/src/config-backup-commands.js";
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
test("CFG-B02/P01: retained project and generated subdirectories create and list the same verified groups", async t => {
  for (const generated of [false, true]) {
    const f = await fixture(t), project = join(f.root, "project"), library = join(project, "library"), artifacts = join(library, "artifacts"), device = join(f.root, "device");
    const reservedRoot = join(generated ? artifacts : project, "retained");
    await mkdir(reservedRoot, { recursive: true }); await mkdir(device);
    const store = { ...f.store, reservedRoot, protectedRoots: [device, join(library, "akasha"), join(library, "config"), join(library, "crest")], retainedContainerRoots: [{ path: project, kind: "project" }, { path: library, kind: "library" }, { path: artifacts, kind: "generated" }] };
    const proposal = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
    await assert.rejects(createConfigBackup({ ...store, approval: null }, proposal, proposal.manifest.createdAtUtc), { reasonCode: "policy-unapproved" });
    assert.deepEqual(await readdir(reservedRoot), [], "policy refusal does not reserve a directory");
    assert.equal((await createConfigBackup(store, proposal, proposal.manifest.createdAtUtc)).status, "settled");
    assert.equal(await readFile(join(reservedRoot, CONFIG_BACKUP_RESERVATION_FILE), "utf8"), CONFIG_BACKUP_RESERVATION_TEXT);
    const listed = await listConfigBackups({ reservedRoot, at: "2026-10-20T00:00:01Z" });
    assert.equal(listed.scanStatus, "scanned"); assert.equal(listed.groups.length, 1);
    assert.equal(listed.groups[0].integrity, "verified"); assert.equal(listed.groups[0].activeCount, 1);
    assert.deepEqual(listed.groups[0].projectRef, ref); assert.equal(listed.groups[0].backupGroupId, store.binding.backupGroupId);
    assert.equal((await resumeConfigBackup(store, "2026-10-20T00:00:02Z")).status, "settled");
    assert.ok(proposal.manifest.files.every(file => !file.memberPath.includes("config-backup")), "protection metadata and other backups are not members");
  }
});

test("CFG-B02: corrupt or linked reservation metadata is never overwritten", async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t), marker = join(f.store.reservedRoot, CONFIG_BACKUP_RESERVATION_FILE);
    if (linked) { const outside = join(f.root, "marker-source"); await writeFile(outside, CONFIG_BACKUP_RESERVATION_TEXT); await symlink(outside, marker); }
    else await writeFile(marker, "not a reservation");
    const proposal = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
    await assert.rejects(createConfigBackup(f.store, proposal, proposal.manifest.createdAtUtc), { reasonCode: linked ? "CONFIG_BACKUP_PATH_INVALID" : "CONFIG_BACKUP_RESERVATION_INVALID" });
    assert.deepEqual(await readdir(f.store.reservedRoot), [CONFIG_BACKUP_RESERVATION_FILE]);
    assert.equal(await readFile(marker, "utf8"), linked ? CONFIG_BACKUP_RESERVATION_TEXT : "not a reservation");
  }
});
test("CFG-B02: request JSON cannot supply root-boundary exceptions", async t => {
  const f = await fixture(t), requestPath = join(f.root, "request.json");
  for (const key of ["protectedRoots", "retainedContainerRoots"]) {
    const request = { selection: [], store: { reservedRoot: f.store.reservedRoot, binding: f.store.binding, policy: fixturePolicy, [key]: [] }, backupId: "5".repeat(32), expectedSelectionDigest: "0".repeat(64) };
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    await assert.rejects(runConfigBackupCommand("config-backup-create", { request: requestPath, at: "2026-10-20T00:00:00Z" }, { resolveSource: async () => ({ projectRef: ref }) }), { reasonCode: "CONFIG_BACKUP_FIELD_UNKNOWN" });
    assert.deepEqual(await readdir(f.store.reservedRoot), []);
  }
});
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
test("RJ03 no-change policy accepts only the literal JSON strings skip and create", async t => {
  const f = await fixture(t);
  for (const noChangePolicy of [["skip"], ["create"], {}, null, 0, true, "unknown"]) {
    const policy = { ...fixturePolicy, noChangePolicy };
    assert.equal(validateConfigBackupRetentionPolicy(policy).status, "policy-unapproved");
    assert.equal(evaluateConfigBackupEnablement({ policy, approval: f.store.approval, whitelistSupported: true, restoreSupported: true, groupBound: true, safeRetirementSupported: true, enablementAuthorized: true }).reason, "policy-unapproved");
    await assert.rejects(createConfigBackup({ ...f.store, policy }, f.proposal("5", "dark", "2026-10-20T00:00:00Z"), "2026-10-20T00:00:00Z"), { reasonCode: "policy-unapproved" });
  }
  assert.equal((await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:00Z" })).scanStatus, "empty");
  const policy = { ...fixturePolicy, noChangePolicy: "create" };
  const approved = validateConfigBackupRetentionPolicy(policy);
  const store = { ...f.store, policy, approval: { approved: true, policyDigest: approved.policyDigest, approvalEvidenceRef: policy.approvalEvidenceRef } };
  const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z"); const second = f.proposal("6", "dark", "2026-10-20T00:00:02Z");
  assert.equal((await createConfigBackup(store, first, first.manifest.createdAtUtc)).status, "settled");
  const created = await createConfigBackup(store, second, second.manifest.createdAtUtc);
  assert.equal(created.status, "settled"); assert.deepEqual(created.index.activeBackupIds, [second.manifest.backupId]); assert.deepEqual(created.index.recoverableBackupIds, [first.manifest.backupId]);
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

async function rotationCut(t) {
  const f = await fixture(t);
  const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z"); const second = f.proposal("6", "light", "2026-10-20T00:00:02Z");
  await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  const completed = (await createConfigBackup(f.store, second, second.manifest.createdAtUtc)).index;
  const old = completed.recoverable[0]; const newest = completed.active[0];
  const group = join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId);
  const recovery = join(f.store.reservedRoot, "config-backup-recovery", "device", f.store.binding.backupGroupId, old.directory);
  const transaction = { transactionId: newest.backupId, backupId: newest.backupId, directory: newest.directory, manifestDigest: newest.manifestDigest, bytes: newest.bytes, startedAt: second.manifest.createdAtUtc, phase: "rotation-pending", retirementBackupId: old.backupId };
  // A durable JSON cut only. Both immutable packages came from the normal
  // sequential writer; no crash, kill, concurrent writer or actual device.
  const pending = { ...completed, revision: completed.revision + 1, active: [{ ...old, origin: "created", recoverableUntil: null }, newest], activeBackupIds: [old.backupId, newest.backupId], recoverable: [], recoverableBackupIds: [], transactions: [transaction], transactionIds: [transaction.transactionId], lastError: "retirement-readback-unknown" };
  const indexPath = join(group, "index.json"); await writeFile(indexPath, configBackupCanonical(pending));
  return { ...f, first, second, pending, indexPath, source: join(group, old.directory), recovery };
}
test("R2 list understands both rotation rename cuts and counts each actual package once without settling the index", async t => {
  for (const location of ["active", "recovery"]) {
    const f = await rotationCut(t);
    if (location === "active") await rename(f.recovery, f.source);
    const before = await readFile(f.indexPath, "utf8");
    const list = await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:04Z" });
    const row = list.groups[0];
    assert.equal(list.scanStatus, "partial"); assert.equal(row.integrity, "discovered");
    assert.deepEqual(row.projectRef, ref); assert.deepEqual([row.activeCount, row.transactionCount, row.recoverableCount], [2, 1, 0]);
    assert.deepEqual(row.transactionPhases, ["rotation-pending"]); assert.equal(row.error, "retirement-readback-unknown");
    assert.equal(row.bytes, f.first.bytes + f.second.bytes); assert.equal(row.syncStatus, "unknown");
    assert.equal(await readFile(f.indexPath, "utf8"), before, "list is read-only, not an implicit resume");
    assert.equal((await resumeConfigBackup(f.store, "2026-10-20T00:00:05Z")).status, "settled");
    const settled = (await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:06Z" })).groups[0];
    assert.equal(settled.integrity, "verified"); assert.equal(settled.bytes, row.bytes);
    assert.deepEqual([settled.activeCount, settled.transactionCount, settled.recoverableCount], [1, 0, 1]);
  }
});
test("R2 missing, duplicated or unbound retirement locations retain index metadata but never claim verified bytes", async t => {
  for (const kind of ["missing", "duplicated", "wrong-phase", "wrong-retirement-id", "corrupt-package"]) {
    const f = await rotationCut(t);
    if (kind === "missing") await rename(f.recovery, join(f.root, "retained-old-package"));
    if (kind === "duplicated") await writeConfigBackupPackage(f.source, f.first);
    if (kind === "wrong-phase" || kind === "wrong-retirement-id") {
      const transaction = { ...f.pending.transactions[0], ...(kind === "wrong-phase" ? { phase: "committed" } : { retirementBackupId: "a".repeat(32) }) };
      await writeFile(f.indexPath, configBackupCanonical({ ...f.pending, transactions: [transaction] }));
    }
    if (kind === "corrupt-package") await writeFile(join(f.recovery, "manifest.json"), "{}");
    const row = (await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:04Z" })).groups[0];
    assert.equal(row.integrity, "corrupt", kind); assert.deepEqual(row.projectRef, ref);
    assert.deepEqual([row.activeCount, row.transactionCount, row.recoverableCount], [2, 1, 0]);
    assert.deepEqual(row.transactionPhases, [kind === "wrong-phase" ? "committed" : "rotation-pending"]);
    if (kind === "corrupt-package") assert.equal(row.error, "CONFIG_BACKUP_VERIFICATION_FAILED");
    else { assert.equal(row.error, "CONFIG_BACKUP_GROUP_UNREADABLE"); assert.equal(row.bytes, null); }
  }
});

test("C-PR29-01 every active-mapped transaction is audited for an extra staging copy without changing the index", async t => {
  for (const location of ["active", "recovery"]) {
    const f = await rotationCut(t);
    if (location === "active") await rename(f.recovery, f.source);
    const before = await readFile(f.indexPath, "utf8");
    const valid = (await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:04Z" })).groups[0];
    assert.equal(valid.integrity, "discovered"); assert.equal(valid.bytes, f.first.bytes + f.second.bytes, "the active and transaction references count one physical new package");
    const transaction = f.pending.transactions[0];
    assert.ok(f.pending.active.some(entry => entry.backupId === transaction.backupId));
    const staging = join(f.store.reservedRoot, "config-backup-staging", "device", f.store.binding.backupGroupId, transaction.directory);
    await writeConfigBackupPackage(staging, f.second);
    const list = await listConfigBackups({ reservedRoot: f.store.reservedRoot, at: "2026-10-20T00:00:05Z" });
    const row = list.groups[0];
    assert.equal(list.scanStatus, "partial"); assert.equal(row.integrity, "corrupt"); assert.equal(row.bytes, null);
    assert.equal(row.error, "CONFIG_BACKUP_GROUP_UNREADABLE"); assert.deepEqual(row.projectRef, ref);
    assert.equal(row.hostname, "device"); assert.equal(row.completedAt, f.second.manifest.createdAtUtc);
    assert.deepEqual([row.activeCount, row.transactionCount, row.recoverableCount], [2, 1, 0]);
    assert.deepEqual(row.transactionPhases, ["rotation-pending"]); assert.equal(row.syncStatus, "unknown");
    assert.equal(await readFile(f.indexPath, "utf8"), before, "list does not settle or repair an ambiguous transaction");
    assert.equal(JSON.parse(await readFile(join(staging, "manifest.json"), "utf8")).backupId, transaction.backupId, "list does not remove the extra package");
  }
});
