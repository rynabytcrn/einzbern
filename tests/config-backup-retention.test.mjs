// SPDX-License-Identifier: Apache-2.0
// CFG-B03/B04/P01. Synthetic policy values below are fixture-only, not product defaults.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configBackupDigest, verifyConfigBackup, configBackupCanonical, planConfigBackup, writeConfigBackupPackage } from "../dist/build/packages/core/src/config-backup.js";
import { prepareConfigBackup, commitConfigBackup, createConfigBackup, evaluateConfigBackupEnablement, listConfigBackups, resumeConfigBackup, retireConfigBackup, validateConfigBackupRetentionPolicy, validateConfigBackupGroupIndex } from "../dist/build/packages/core/src/config-backup-retention.js";
import { CONFIG_BACKUP_RESERVATION_FILE, CONFIG_BACKUP_RESERVATION_TEXT } from "../scripts/lib/config-backup-reservation.mjs";
import { runConfigBackupCommand } from "../dist/build/packages/cli/src/config-backup-commands.js";
const ref = { libraryId: `workspace:${"1".repeat(24)}`, projectId: `project:${"2".repeat(24)}` };
const version = { engineVersion: "3.1.0", engineCommit: null, engineCommitStatus: "unknown", artifactIdentity: { kind: "observed-artifact-identity", schemaVersion: "einzbern.install-tree-digest.v1", sha256: "3".repeat(64) }, templateVersions: ["rules-v1"] };
const fixturePolicy = { schemaVersion: "einzbern.config-backup-retention.v1", activeLimit: 1, transactionLimit: 1, recoveryLimit: 2, maxPackageBytes: 65536, maxTotalBytes: 262144, retentionDuration: 1000, recoveryDuration: 86400000, noChangePolicy: "skip", atLimitAction: "stop-new-and-report", retirementMethod: "verified-recovery-move", approvalEvidenceRef: "fixture-only:retention-policy" };
async function fixture(t, policy = fixturePolicy) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-config-retention-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const reserve = join(root, "reserve"); const project = join(root, "project"); await mkdir(reserve); await mkdir(project);
  const approved = validateConfigBackupRetentionPolicy(policy);
  const store = { reservedRoot: reserve, localBindingRoot: join(root, "config-backup-bindings"), protectedRoots: [project], binding: { projectRef: ref, backupGroupId: "4".repeat(32), writerBindingRef: "fixture-only:writer", executionEnvironmentRef: "fixture-only:environment", hostname: "device" }, policy, approval: { approved: true, policyDigest: approved.policyDigest, approvalEvidenceRef: policy.approvalEvidenceRef } };
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

import { remoteEvidenceDigest, remoteIntentLifecycleBytes, validateRemoteIntent } from "../dist/build/packages/core/src/config-backup-remote.js";

// Staged-remote fixtures model caller observations; they do not authenticate a provider.
const remoteLocations = { destinationRef: "fixture:remote", stagingAreaId: "transaction-area", activeAreaId: "active-area", recoveryAreaId: "recovery-area" };
async function remotePackage(root, areaId, time, idPrefix) {
  const verified = await verifyConfigBackup(root), manifest = verified.manifest;
  const members = [...manifest.files.map(f => f.memberPath), "manifest.json"];
  const files = await Promise.all(members.map(async (path, i) => { const bytes = await readFile(join(root, path)); return { path, id: `${idPrefix}-member-${i}`, parentId: path === "manifest.json" ? `${idPrefix}-package` : `${idPrefix}-members`, bytes: bytes.length, sha256: configBackupDigest(bytes), publishedAt: "2026-10-20T00:00:02Z", downloadedAt: time }; }));
  return { packageRoot: root, backupId: manifest.backupId, manifestDigest: manifest.manifestDigest, packageId: `${idPrefix}-package`, packageParentId: areaId, membersDirectory: { id: `${idPrefix}-members`, parentId: `${idPrefix}-package`, name: "members" }, areaId, files, verifiedAt: time, evidenceRef: `fixture:readback-${idPrefix}` };
}
async function stagedFixture(t, policy = fixturePolicy) {
  const f = await fixture(t, policy), first = f.proposal("5", "dark", "2026-10-20T00:00:00Z");
  const a = await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  const next = f.proposal("6", "light", "2026-10-20T00:00:02Z"), prepared = await prepareConfigBackup(f.store, next, next.manifest.createdAtUtc);
  const stagedRoot = join(f.store.reservedRoot, "config-backup-staging", "device", f.store.binding.backupGroupId, prepared.index.transactions[0].directory);
  const oldRoot = join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId, a.index.active[0].directory);
  const downloads = join(f.root, "raw-downloads"); await mkdir(downloads); await cp(stagedRoot, join(downloads, "new"), { recursive: true }); await cp(oldRoot, join(downloads, "old"), { recursive: true });
  const begin = { schemaVersion: "einzbern.config-backup-remote-begin.v1", backupId: next.manifest.backupId, locations: remoteLocations, replacement: await remotePackage(join(downloads, "new"), remoteLocations.stagingAreaId, "2026-10-20T00:00:03Z", "new"), original: await remotePackage(join(downloads, "old"), remoteLocations.activeAreaId, "2026-10-20T00:00:03Z", "old") };
  const complete = { schemaVersion: "einzbern.config-backup-remote-complete.v1", backupId: next.manifest.backupId, beginDigest: remoteEvidenceDigest(begin), replacement: await remotePackage(join(downloads, "new"), remoteLocations.activeAreaId, "2026-10-20T00:00:08Z", "new"), original: await remotePackage(join(downloads, "old"), remoteLocations.recoveryAreaId, "2026-10-20T00:00:06Z", "old"), retiredAt: "2026-10-20T00:00:05Z", promotedAt: "2026-10-20T00:00:07Z" };
  return { ...f, first, next, prepared, begin, complete, oldRoot, stagedRoot };
}
test("remote staged prepare and default resume never rotate; complete is explicit and idempotent", async t => {
  const f = await stagedFixture(t), before = await readFile(join(f.oldRoot, "manifest.json"));
  assert.equal(f.prepared.status, "pending"); assert.equal(f.prepared.reason, "remote-verification-required");
  assert.deepEqual(f.prepared.index.activeBackupIds, [f.first.manifest.backupId]); assert.equal(f.prepared.index.recoverable.length, 0);
  assert.equal((await resumeConfigBackup(f.store, "2026-10-20T00:00:03Z")).reason, "remote-verification-required");
  assert.equal((await prepareConfigBackup(f.store, f.next, "2026-10-20T00:00:03Z")).index.transactions.length, 1);
  assert.equal((await commitConfigBackup(f.store, "2026-10-20T00:00:03Z", "complete", f.complete)).reason, "CONFIG_BACKUP_REMOTE_BEGIN_REQUIRED");
  const begun = await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", f.begin);
  assert.equal(begun.index.transactions[0].remote.phase, "commit-pending"); assert.equal(begun.index.active.length, 1); assert.equal(begun.index.recoverable.length, 0);
  assert.equal((await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", f.begin)).index.revision, begun.index.revision);
  assert.equal((await resumeConfigBackup(f.store, "2026-10-20T00:00:05Z")).reason, "remote-commit-query-required");
  assert.equal((await resumeConfigBackup(f.store, "2026-10-20T00:00:05Z", "recover-failed")).reason, "remote-commit-query-required");
  assert.deepEqual(await readFile(join(f.oldRoot, "manifest.json")), before);
  const done = await commitConfigBackup(f.store, "2026-10-20T00:00:09Z", "complete", f.complete);
  assert.equal(done.status, "settled", done.reason); assert.deepEqual(done.index.activeBackupIds, [f.next.manifest.backupId]); assert.deepEqual(done.index.recoverableBackupIds, [f.first.manifest.backupId]); assert.equal(done.index.syncStatus, "unknown");
  const again = await commitConfigBackup(f.store, "2026-10-20T00:00:10Z", "complete", f.complete); assert.equal(again.status, "unchanged"); assert.equal(again.index.revision, done.index.revision);
  const changed = structuredClone(f.complete); changed.promotedAt = "2026-10-20T00:00:06Z";
  assert.equal((await commitConfigBackup(f.store, "2026-10-20T00:00:10Z", "complete", changed)).status, "pending");
});
test("remote stage receipts reject malformed association, inventory and ordering without rotation", async t => {
  const changes = [
    x => { x.replacement.packageParentId = remoteLocations.activeAreaId; },
    x => { x.replacement.membersDirectory.parentId = "wrong-package"; },
    x => { x.replacement.membersDirectory.id = x.replacement.packageId; },
    x => { x.replacement.membersDirectory.name = "other"; },
    x => { x.replacement.files[0].id = x.replacement.membersDirectory.id; },
    x => { x.replacement.files[0].id = remoteLocations.activeAreaId; },
    x => { x.replacement.files[0].parentId = x.replacement.packageId; },
    x => { x.replacement.files[1].parentId = x.replacement.membersDirectory.id; },
    x => { x.replacement.files.pop(); },
    x => { x.replacement.files[0].id = x.replacement.files[1].id; },
    x => { x.replacement.files[0].parentId = "wrong"; },
    x => { x.replacement.files[0].bytes += 1; },
    x => { x.replacement.files[0].sha256 = "0".repeat(64); },
    x => { x.replacement.files[0].path = "../manifest.json"; },
    x => { x.replacement.files[0].downloadedAt = "2026-10-19T00:00:00Z"; },
    x => { x.replacement.files[0].publishedAt = "2026-10-20T00:00:03Z"; },
    x => { x.replacement.areaId = remoteLocations.activeAreaId; },
    x => { x.replacement.integrity = "verified"; },
    x => { x.replacement.backupId = "9".repeat(32); },
    x => { x.locations.activeAreaId = x.locations.stagingAreaId; },
    x => { x.original = null; },
  ];
  for (const change of changes) {
    const f = await stagedFixture(t), value = structuredClone(f.begin); change(value);
    const r = await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", value);
    assert.equal(r.status, "pending"); assert.equal(r.index.transactions[0].remote.phase, "prepared"); assert.deepEqual(r.index.activeBackupIds, [f.first.manifest.backupId]);
  }
});
test("remote complete requires stable remote member IDs and verified recovery before promotion", async t => {
  for (const change of [x => { x.replacement.files[0].id = "replacement-id"; }, x => { x.original.areaId = remoteLocations.activeAreaId; }, x => { x.promotedAt = "2026-10-20T00:00:05Z"; }, x => { x.beginDigest = "0".repeat(64); }, x => { x.replacement.verifiedAt = "2026-10-20T00:00:06Z"; }]) {
    const f = await stagedFixture(t); await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", f.begin);
    const value = structuredClone(f.complete); change(value);
    const r = await commitConfigBackup(f.store, "2026-10-20T00:00:09Z", "complete", value);
    assert.equal(r.status, "pending"); assert.equal(r.index.transactions[0].remote.phase, "commit-pending"); assert.equal(r.index.recoverable.length, 0);
  }
});
test("remote downloaded bytes are independently verified; local stage cannot stand in for changed downloads", async t => {
  const f = await stagedFixture(t); const path = join(f.begin.replacement.packageRoot, f.begin.replacement.files[0].path);
  await writeFile(path, "{}");
  const r = await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", f.begin);
  assert.equal(r.status, "pending"); assert.equal(r.index.transactions[0].remote.phase, "prepared"); assert.equal(r.index.active[0].backupId, f.first.manifest.backupId);
});

test("remote validated completion resumes deterministic local interruption cuts with the same ID", async t => {
  for (const cut of ["validated", "new-renamed", "active-indexed", "old-renamed", "recovery-indexed"]) {
    const f = await stagedFixture(t), begun = await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", f.begin);
    // Explicit isolated state-cut fixture, not a claim that a real provider action occurred.
    const index = structuredClone(begun.index), tx = index.transactions[0];
    tx.remote = { ...tx.remote, phase: "complete-validated", completeDigest: remoteEvidenceDigest(f.complete), completedAt: "2026-10-20T00:00:09Z" };
    const active = join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId);
    const recovery = join(f.store.reservedRoot, "config-backup-recovery", "device", f.store.binding.backupGroupId);
    if (cut !== "validated") await rename(f.stagedRoot, join(active, tx.directory));
    if (["active-indexed", "old-renamed", "recovery-indexed"].includes(cut)) {
      index.active.push({ backupId: tx.backupId, directory: tx.directory, manifestDigest: tx.manifestDigest, selectionDigest: f.next.manifest.selectionDigest, bytes: tx.bytes, completedAt: "2026-10-20T00:00:09Z", recoverableUntil: null, origin: "created", remoteCompletion: { beginDigest: tx.remote.beginDigest, completeDigest: tx.remote.completeDigest, completedAt: tx.remote.completedAt } });
      tx.phase = "committed";
    }
    if (["old-renamed", "recovery-indexed"].includes(cut)) { tx.phase = "rotation-pending"; await rename(f.oldRoot, join(recovery, index.active[0].directory)); }
    if (cut === "recovery-indexed") { const old = index.active.shift(); index.recoverable.push({ ...old, origin: "retired", recoverableUntil: "2026-10-21T00:00:09Z" }); }
    index.activeBackupIds = index.active.map(p => p.backupId); index.recoverableBackupIds = index.recoverable.map(p => p.backupId);
    await writeFile(join(active, "index.json"), configBackupCanonical(index));
    const r = await resumeConfigBackup(f.store, "2026-10-20T00:00:10Z");
    assert.equal(r.status, "settled", `${cut}: ${r.reason}`); assert.deepEqual(r.index.activeBackupIds, [f.next.manifest.backupId]); assert.deepEqual(r.index.recoverableBackupIds, [f.first.manifest.backupId]); assert.equal(r.index.transactions.length, 0);
    assert.equal((await commitConfigBackup(f.store, "2026-10-20T00:00:11Z", "complete", f.complete)).status, "unchanged");
  }
});
test("remote metadata capacity is reserved before external work and first backup needs no invented original", async t => {
  const f = await fixture(t), plan = f.proposal("6", "light", "2026-10-20T00:00:02Z");
  const policy = { ...fixturePolicy, maxPackageBytes: plan.bytes, maxTotalBytes: plan.bytes + 4095 }; const approved = validateConfigBackupRetentionPolicy(policy);
  const bounded = { ...f.store, policy, approval: { approved: true, policyDigest: approved.policyDigest, approvalEvidenceRef: policy.approvalEvidenceRef } };
  const refused = await prepareConfigBackup(bounded, plan, plan.manifest.createdAtUtc); assert.equal(refused.status, "stop-new-and-report"); assert.equal(refused.index.transactions.length, 0);
  const g = await fixture(t), p = g.proposal("7", "light", "2026-10-20T00:00:02Z"), prepared = await prepareConfigBackup(g.store, p, p.manifest.createdAtUtc);
  const packageRoot = join(g.store.reservedRoot, "config-backup-staging", "device", g.store.binding.backupGroupId, prepared.index.transactions[0].directory);
  const begin = { schemaVersion: "einzbern.config-backup-remote-begin.v1", backupId: p.manifest.backupId, locations: remoteLocations, replacement: await remotePackage(packageRoot, remoteLocations.stagingAreaId, "2026-10-20T00:00:03Z", "new"), original: null };
  const begun = await commitConfigBackup(g.store, "2026-10-20T00:00:04Z", "begin", begin); assert.equal(begun.index.transactions[0].remote.phase, "commit-pending");
  const complete = { schemaVersion: "einzbern.config-backup-remote-complete.v1", backupId: p.manifest.backupId, beginDigest: remoteEvidenceDigest(begin), replacement: await remotePackage(packageRoot, remoteLocations.activeAreaId, "2026-10-20T00:00:06Z", "new"), original: null, retiredAt: null, promotedAt: "2026-10-20T00:00:05Z" };
  assert.equal((await commitConfigBackup(g.store, "2026-10-20T00:00:07Z", "complete", complete)).status, "settled");
});
test("remote CLI ownership and closed envelopes do not allow forged approval or unsafe new flags", async t => {
  const f = await fixture(t), request = join(f.root, "remote-request.json");
  await writeFile(request, JSON.stringify({ store: { reservedRoot: f.store.reservedRoot, binding: f.store.binding, policy: fixturePolicy }, mode: "begin", evidence: {}, approved: true }));
  await assert.rejects(runConfigBackupCommand("config-backup-commit", { request, at: "2026-10-20T00:00:04Z" }, { resolveSource: async () => ({ projectRef: ref }) }), { reasonCode: "CONFIG_BACKUP_FIELD_UNKNOWN" });
  await assert.rejects(runConfigBackupCommand("config-backup-prepare", { request, at: "2026-10-20T00:00:04Z", "skip-verification": "true" }, {}), { reasonCode: "CLI_ARGUMENT_MALFORMED" });
});

test("remote prepared upload may be partial or unknown: recover-failed preserves same-ID responsibility", async t => {
  const f = await stagedFixture(t);
  const before = await readFile(join(f.stagedRoot, "manifest.json"));
  const recovery = await resumeConfigBackup(f.store, "2026-10-20T00:00:03Z", "recover-failed");
  assert.equal(recovery.status, "pending"); assert.equal(recovery.reason, "remote-commit-query-required");
  assert.equal(recovery.index.transactions[0].backupId, f.next.manifest.backupId);
  assert.equal(recovery.index.transactions[0].remote.phase, "prepared"); assert.equal(recovery.index.recoverable.length, 0);
  assert.deepEqual(await readFile(join(f.stagedRoot, "manifest.json")), before);
  const other = f.proposal("8", "dark", "2026-10-20T00:00:04Z");
  const blocked = await prepareConfigBackup(f.store, other, other.manifest.createdAtUtc);
  assert.equal(blocked.status, "pending"); assert.equal(blocked.index.transactions[0].backupId, f.next.manifest.backupId);
});
test("repair-staged reconstructs missing bytes from persisted original plan, never a new snapshot", async t => {
  for (const cut of ["manifest-missing", "member-missing", "members-directory-missing", "package-directory-missing"]) {
    const f = await stagedFixture(t), savedPlan = join(f.root, "original-plan.json");
    await writeFile(savedPlan, configBackupCanonical(f.next), { mode: 0o600 });
    if (cut === "package-directory-missing") await rm(f.stagedRoot, { recursive: true });
    else if (cut === "members-directory-missing") await rm(join(f.stagedRoot, "members"), { recursive: true });
    else await rm(join(f.stagedRoot, cut === "manifest-missing" ? "manifest.json" : f.next.manifest.files[0].memberPath));
    assert.equal((await resumeConfigBackup(f.store, "2026-10-20T00:00:03Z", "recover-failed")).reason, "remote-commit-query-required");
    const originalPlan = JSON.parse(await readFile(savedPlan, "utf8"));
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:04Z", "repair-staged", originalPlan);
    assert.equal(result.status, "pending", cut); assert.equal(result.reason, "remote-verification-required", cut);
    assert.equal(result.index.transactions[0].backupId, f.next.manifest.backupId); assert.deepEqual(result.index.activeBackupIds, [f.first.manifest.backupId]);
    const verified = await verifyConfigBackup(f.stagedRoot); assert.equal(verified.integrity, "verified"); assert.deepEqual(verified.manifest, f.next.manifest);
    const again = await resumeConfigBackup(f.store, "2026-10-20T00:00:05Z", "repair-staged", originalPlan); assert.equal(again.index.revision, result.index.revision);
  }
});
test("repair-staged validates all surviving bytes before filling holes and retains conflicts", async t => {
  for (const problem of ["changed-member", "extra-file", "symlink", "changed-plan", "lost-plan", "commit-pending"]) {
    const f = await stagedFixture(t); await rm(join(f.stagedRoot, "manifest.json"));
    const memberPath = join(f.stagedRoot, f.next.manifest.files[0].memberPath);
    if (problem === "changed-member") await writeFile(memberPath, "{}");
    if (problem === "extra-file") await writeFile(join(f.stagedRoot, "unexpected.json"), "{}");
    if (problem === "symlink") { await rm(memberPath); await symlink(join(f.begin.replacement.packageRoot, f.next.manifest.files[0].memberPath), memberPath); }
    let plan = f.next;
    if (problem === "changed-plan") plan = f.proposal("6", "dark", f.next.manifest.createdAtUtc);
    if (problem === "lost-plan") plan = undefined;
    if (problem === "commit-pending") {
      // Restore the manifest just for begin; remove it after the intent is durable.
      await writeFile(join(f.stagedRoot, "manifest.json"), configBackupCanonical(f.next.manifest));
      await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", f.begin); await rm(join(f.stagedRoot, "manifest.json"));
    }
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:05Z", "repair-staged", plan);
    assert.equal(result.status, "pending", problem); assert.notEqual(result.reason, "remote-verification-required", problem);
    await assert.rejects(readFile(join(f.stagedRoot, "manifest.json")), { code: "ENOENT" });
    assert.equal(result.index.transactions[0].backupId, f.next.manifest.backupId); assert.equal(result.index.recoverable.length, 0);
  }
});


test("repeated remote prepare binds the exact original manifest and re-verifies surviving bytes", async t => {
  for (const problem of ["different-manifest", "corrupt-member"]) {
    const f = await stagedFixture(t);
    const memberPath = join(f.stagedRoot, f.next.manifest.files[0].memberPath);
    const plan = problem === "different-manifest" ? planConfigBackup({ projectRef: f.next.manifest.projectRef, backupGroupId: f.next.manifest.backupGroupId, hostname: f.next.manifest.hostnameLabel.display, at: "2026-10-20T00:00:03Z", sourceVersion: f.next.manifest.sourceVersion, backupId: f.next.manifest.backupId, payloads: f.next.members.map(m => m.payload) }) : f.next;
    if (problem === "different-manifest") {
      assert.equal(plan.manifest.selectionDigest, f.next.manifest.selectionDigest);
      assert.deepEqual(plan.manifest.sourceVersion, f.next.manifest.sourceVersion);
      assert.notEqual(plan.manifest.manifestDigest, f.next.manifest.manifestDigest);
    }
    if (problem === "corrupt-member") await writeFile(memberPath, "{}");
    const before = await readFile(memberPath);
    const result = await prepareConfigBackup(f.store, plan, "2026-10-20T00:00:04Z");
    assert.equal(result.status, "pending"); assert.equal(result.reason, problem === "different-manifest" ? "prepared-content-mismatch" : "CONFIG_BACKUP_VERIFICATION_FAILED");
    assert.equal(result.index.transactions.length, 1); assert.equal(result.index.transactions[0].manifestDigest, f.next.manifest.manifestDigest);
    assert.deepEqual(result.index.activeBackupIds, [f.first.manifest.backupId]); assert.deepEqual(await readFile(memberPath), before);
  }
});

async function boundedRemoteFixture(t) {
  const probe = await fixture(t);
  const bytes = probe.proposal("5", "dark", "2026-10-20T00:00:00Z").bytes + probe.proposal("6", "light", "2026-10-20T00:00:02Z").bytes;
  return stagedFixture(t, { ...fixturePolicy, maxPackageBytes: 4096, maxTotalBytes: bytes + 4096 });
}
function remapRemoteFields(f, values) {
  f.begin.locations = Object.fromEntries(["destinationRef", "stagingAreaId", "activeAreaId", "recoveryAreaId"].map((key, i) => [key, values[i]]));
  for (const [name, n, beginArea, completeArea] of [["replacement", 4, 1, 2], ["original", 6, 2, 3]]) {
    for (const [receipt, area] of [[f.begin[name], beginArea], [f.complete[name], completeArea]]) {
      receipt.packageId = values[n]; receipt.packageParentId = values[area]; receipt.areaId = values[area];
      receipt.membersDirectory = { id: values[n + 1], parentId: values[n], name: "members" };
      for (const file of receipt.files) file.parentId = file.path === "manifest.json" ? values[n] : values[n + 1];
    }
  }
  f.complete.beginDigest = remoteEvidenceDigest(f.begin);
}
const metadataBeginAt = "2026-10-20T00:00:04.123456789Z";
const metadataCompleteAt = "2026-10-20T00:00:09.123456789Z";
function projectedRemoteIntent(begin) {
  const identity = receipt => ({ backupId: receipt.backupId, manifestDigest: receipt.manifestDigest, packageId: receipt.packageId, membersDirectoryId: receipt.membersDirectory.id, filesDigest: remoteEvidenceDigest(receipt.files.map(({ path, id, bytes, sha256 }) => ({ path, id, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : 1)) });
  return { phase: "commit-pending", beginDigest: remoteEvidenceDigest(begin), completeDigest: null, begunAt: metadataBeginAt, completedAt: null, locations: begin.locations, replacement: identity(begin.replacement), original: identity(begin.original) };
}
function exactMetadataBoundary(f, extra = 0) {
  let values;
  for (let n = 1; n < 255; n++) {
    values = Array.from({ length: 8 }, (_, i) => "界".repeat(n) + i); remapRemoteFields(f, values);
    const bytes = remoteIntentLifecycleBytes(projectedRemoteIntent(f.begin));
    if (bytes > 4096) {
      values = Array.from({ length: 8 }, (_, i) => "界".repeat(n - 1) + i); remapRemoteFields(f, values);
      values[0] += "x".repeat(4096 - remoteIntentLifecycleBytes(projectedRemoteIntent(f.begin)) + extra);
      remapRemoteFields(f, values); assert.equal(remoteIntentLifecycleBytes(projectedRemoteIntent(f.begin)), 4096 + extra); return;
    }
  }
  assert.fail("fixture must find the canonical UTF-8 lifecycle boundary");
}
test("remote metadata reservation rejects UTF-8 and JSON escapes before begin without changing originals", async t => {
  for (const shape of ["cjk", "emoji", "escaped", "lone-surrogate", "control", "one-byte-over"]) {
    const f = await boundedRemoteFixture(t), before = await readFile(join(f.oldRoot, "manifest.json"));
    const make = i => shape === "cjk" ? "界".repeat(255) + i : shape === "emoji" ? "😀".repeat(127) + i : shape === "escaped" ? '\\"'.repeat(127) + i : shape === "lone-surrogate" ? "\ud800".repeat(255) + i : "a\n" + i;
    if (shape === "one-byte-over") exactMetadataBoundary(f, 1); else remapRemoteFields(f, Array.from({ length: 8 }, (_, i) => make(i)));
    const result = await commitConfigBackup(f.store, metadataBeginAt, "begin", f.begin);
    assert.equal(result.status, "pending"); assert.equal(result.reason, shape === "control" ? "CONFIG_BACKUP_INPUT_INVALID" : "CONFIG_BACKUP_REMOTE_METADATA_CAPACITY", shape);
    assert.equal(result.index.transactions[0].remote.phase, "prepared"); assert.equal(result.index.transactions[0].backupId, f.next.manifest.backupId);
    assert.deepEqual(await readFile(join(f.oldRoot, "manifest.json")), before); assert.deepEqual(result.index.activeBackupIds, [f.first.manifest.backupId]);
  }
});
test("remote exact canonical metadata boundary reserves completion growth and maximal timestamp precision", async t => {
  for (const shape of ["exact-boundary", "maximum-ascii-fields"]) {
    const f = await boundedRemoteFixture(t);
    if (shape === "exact-boundary") exactMetadataBoundary(f); else remapRemoteFields(f, Array.from({ length: 8 }, (_, i) => "a".repeat(255) + i));
    if (shape === "maximum-ascii-fields") {
      for (const [name, offset] of [["replacement", 0], ["original", 2]]) for (const receipt of [f.begin[name], f.complete[name]]) {
        receipt.evidenceRef = "e".repeat(256);
        receipt.files.forEach((file, i) => { file.id = "f".repeat(255) + (offset + i); });
      }
      f.complete.beginDigest = remoteEvidenceDigest(f.begin);
    }
    const begun = await commitConfigBackup(f.store, metadataBeginAt, "begin", f.begin); assert.equal(begun.reason, "remote-commit-query-required");
    const completed = { ...begun.index.transactions[0].remote, phase: "complete-validated", completeDigest: remoteEvidenceDigest(f.complete), completedAt: metadataCompleteAt };
    const compact = { beginDigest: completed.beginDigest, completeDigest: completed.completeDigest, completedAt: completed.completedAt };
    const metadataBytes = Buffer.byteLength(configBackupCanonical(completed)) + Buffer.byteLength(configBackupCanonical(compact));
    assert.ok(f.first.bytes + f.next.bytes + metadataBytes <= f.store.policy.maxTotalBytes);
    if (shape === "exact-boundary") assert.equal(metadataBytes, 4096);
    const settled = await commitConfigBackup(f.store, metadataCompleteAt, "complete", f.complete); assert.equal(settled.status, "settled", settled.reason);
    assert.equal(settled.index.transactions.length, 0); assert.equal(settled.index.active[0].remoteCompletion.completedAt, metadataCompleteAt);
  }
});
test("remote metadata exact limit survives all local completion cuts without double-counting the same package", async t => {
  for (const cut of ["validated", "new-renamed", "active-indexed", "old-renamed", "recovery-indexed", "conflicting-duplicate", "conflicting-digest", "conflicting-completion", "two-physical-copies"]) {
    const f = await boundedRemoteFixture(t); exactMetadataBoundary(f);
    const begun = await commitConfigBackup(f.store, metadataBeginAt, "begin", f.begin), index = structuredClone(begun.index), tx = index.transactions[0];
    tx.remote = { ...tx.remote, phase: "complete-validated", completeDigest: remoteEvidenceDigest(f.complete), completedAt: metadataCompleteAt };
    const active = join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId), recovery = join(f.store.reservedRoot, "config-backup-recovery", "device", f.store.binding.backupGroupId);
    if (cut !== "validated") await rename(f.stagedRoot, join(active, tx.directory));
    if (!["validated", "new-renamed"].includes(cut)) {
      index.active.push({ backupId: tx.backupId, directory: tx.directory, manifestDigest: tx.manifestDigest, selectionDigest: f.next.manifest.selectionDigest, bytes: tx.bytes, completedAt: metadataCompleteAt, recoverableUntil: null, origin: "created", remoteCompletion: { beginDigest: tx.remote.beginDigest, completeDigest: tx.remote.completeDigest, completedAt: tx.remote.completedAt } }); tx.phase = "committed";
    }
    if (["old-renamed", "recovery-indexed"].includes(cut)) { tx.phase = "rotation-pending"; await rename(f.oldRoot, join(recovery, index.active[0].directory)); }
    if (cut === "recovery-indexed") { const old = index.active.shift(); index.recoverable.push({ ...old, origin: "retired", recoverableUntil: "2026-10-21T00:00:09Z" }); }
    if (cut === "conflicting-duplicate") index.active.at(-1).bytes++;
    if (cut === "conflicting-digest") index.active.at(-1).manifestDigest = "f".repeat(64);
    if (cut === "conflicting-completion") index.active.at(-1).remoteCompletion.completeDigest = "f".repeat(64);
    if (cut === "two-physical-copies") await cp(join(active, tx.directory), f.stagedRoot, { recursive: true });
    index.activeBackupIds = index.active.map(p => p.backupId); index.recoverableBackupIds = index.recoverable.map(p => p.backupId);
    await writeFile(join(active, "index.json"), configBackupCanonical(index));
    if (cut.startsWith("conflicting-")) { await assert.rejects(resumeConfigBackup(f.store, "2026-10-20T00:00:10Z"), { reasonCode: "CONFIG_BACKUP_REMOTE_INVALID" }); continue; }
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:10Z");
    assert.equal(result.status, cut === "two-physical-copies" ? "pending" : "settled", `${cut}: ${result.reason}`);
    if (cut === "two-physical-copies") assert.equal(result.reason, "publication-conflict");
  }
});
test("loaded oversized remote metadata rejects consistently rather than resuming an old malformed intent", async t => {
  const f = await boundedRemoteFixture(t); remapRemoteFields(f, Array.from({ length: 8 }, (_, i) => "界".repeat(255) + i));
  const remote = projectedRemoteIntent(f.begin);
  for (const phase of ["commit-pending", "complete-validated"]) {
    const intent = phase === "commit-pending" ? remote : { ...remote, phase, completeDigest: remoteEvidenceDigest(f.complete), completedAt: metadataCompleteAt };
    assert.throws(() => validateRemoteIntent(intent), { reasonCode: "CONFIG_BACKUP_REMOTE_METADATA_CAPACITY" });
    const index = structuredClone(f.prepared.index); index.transactions[0].remote = intent;
    await writeFile(join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId, "index.json"), configBackupCanonical(index));
    await assert.rejects(resumeConfigBackup(f.store, "2026-10-20T00:00:10Z"), { reasonCode: "CONFIG_BACKUP_REMOTE_METADATA_CAPACITY" });
  }
});


test("remote metadata reservations cannot alias two transaction IDs onto one backup", async t => {
  const f = await boundedRemoteFixture(t), begun = await commitConfigBackup(f.store, metadataBeginAt, "begin", f.begin);
  const index = structuredClone(begun.index), aliased = { ...index.transactions[0], transactionId: "9".repeat(32) };
  index.transactions.push(aliased); index.transactionIds.push(aliased.transactionId);
  assert.throws(() => validateConfigBackupGroupIndex(index), { reasonCode: "CONFIG_BACKUP_REMOTE_INVALID" });
});

async function deferredLocalRetirement(t, remoteReplacement = false) {
  const f = await fixture(t, { ...fixturePolicy, activeLimit: 2, retentionDuration: 10000 });
  const first = f.proposal("5", "dark", "2026-10-20T00:00:00Z"), next = f.proposal("6", "light", "2026-10-20T00:00:02Z");
  if (!remoteReplacement) {
    f.store.policy = { ...f.store.policy, maxPackageBytes: Math.max(first.bytes, next.bytes), maxTotalBytes: first.bytes + next.bytes };
    const approved = validateConfigBackupRetentionPolicy(f.store.policy);
    f.store.approval = { approved: true, policyDigest: approved.policyDigest, approvalEvidenceRef: f.store.policy.approvalEvidenceRef };
  }
  await createConfigBackup(f.store, first, first.manifest.createdAtUtc);
  if (remoteReplacement) {
    const prepared = await prepareConfigBackup(f.store, next, next.manifest.createdAtUtc);
    const packageRoot = join(f.store.reservedRoot, "config-backup-staging", "device", f.store.binding.backupGroupId, prepared.index.transactions[0].directory);
    const begin = { schemaVersion: "einzbern.config-backup-remote-begin.v1", backupId: next.manifest.backupId, locations: remoteLocations, replacement: await remotePackage(packageRoot, remoteLocations.stagingAreaId, "2026-10-20T00:00:03Z", "new"), original: null };
    assert.equal((await commitConfigBackup(f.store, "2026-10-20T00:00:04Z", "begin", begin)).reason, "remote-commit-query-required");
    const complete = { schemaVersion: "einzbern.config-backup-remote-complete.v1", backupId: next.manifest.backupId, beginDigest: remoteEvidenceDigest(begin), replacement: await remotePackage(packageRoot, remoteLocations.activeAreaId, "2026-10-20T00:00:08Z", "new"), original: null, retiredAt: null, promotedAt: "2026-10-20T00:00:07Z" };
    assert.equal((await commitConfigBackup(f.store, "2026-10-20T00:00:09Z", "complete", complete)).status, "settled");
  } else await createConfigBackup(f.store, next, next.manifest.createdAtUtc);
  const retired = await retireConfigBackup(f.store, first.manifest.backupId, remoteReplacement ? "2026-10-20T00:00:09Z" : "2026-10-20T00:00:04Z");
  assert.equal(retired.reason, "retirement-capacity-or-retention"); assert.equal(retired.index.transactions[0].bytes, 0); assert.equal(retired.index.transactions[0].remote, undefined);
  const active = join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId), recovery = join(f.store.reservedRoot, "config-backup-recovery", "device", f.store.binding.backupGroupId);
  return { ...f, first, next, retired, active, recovery };
}
test("official local retirement keeps its zero-allocation intent and resumes after retention expires", async t => {
  for (const remoteReplacement of [false, true]) {
    const f = await deferredLocalRetirement(t, remoteReplacement);
    const completion = f.retired.index.active[1].remoteCompletion;
    assert.equal(Boolean(completion), remoteReplacement);
    const resumed = await resumeConfigBackup(f.store, "2026-10-20T00:00:11Z");
    assert.equal(resumed.status, "settled", resumed.reason); assert.equal(resumed.index.transactions.length, 0);
    assert.deepEqual(resumed.index.activeBackupIds, [f.next.manifest.backupId]); assert.deepEqual(resumed.index.recoverableBackupIds, [f.first.manifest.backupId]);
    assert.deepEqual(resumed.index.active[0].remoteCompletion, completion);
    assert.equal((await resumeConfigBackup(f.store, "2026-10-20T00:00:12Z")).status, "settled");
  }
});
test("local zero-allocation retirement reconciles rename and recovery-index cuts with compact metadata intact", async t => {
  for (const remoteReplacement of [false, true]) for (const cut of ["old-renamed", "recovery-indexed", "two-old-copies", "two-replacement-copies"]) {
    const f = await deferredLocalRetirement(t, remoteReplacement), index = structuredClone(f.retired.index), old = index.active[0], replacement = index.active[1];
    if (cut === "two-replacement-copies") await cp(join(f.active, replacement.directory), join(f.store.reservedRoot, "config-backup-staging", "device", f.store.binding.backupGroupId, replacement.directory), { recursive: true });
    else if (cut === "two-old-copies") await cp(join(f.active, old.directory), join(f.recovery, old.directory), { recursive: true });
    else await rename(join(f.active, old.directory), join(f.recovery, old.directory));
    if (cut === "recovery-indexed") {
      index.active.shift(); index.recoverable.push({ ...old, origin: "retired", recoverableUntil: "2026-10-21T00:00:11Z" });
      index.activeBackupIds = index.active.map(p => p.backupId); index.recoverableBackupIds = [old.backupId];
      await writeFile(join(f.active, "index.json"), configBackupCanonical(index));
    }
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:11Z");
    assert.equal(result.status, cut.startsWith("two-") ? "pending" : "settled", `${cut}: ${result.reason}`);
    if (cut.startsWith("two-")) { assert.equal(result.index.transactions.length, 1); assert.equal(result.reason, cut === "two-old-copies" ? "retirement-conflict" : "publication-conflict"); }
    else { assert.equal(result.index.transactions.length, 0); assert.deepEqual(result.index.active[0].remoteCompletion, replacement.remoteCompletion); }
  }
});
test("zero payload exemption refuses fabricated retirement identity, phase, bytes, digest, directory and target", async t => {
  for (const problem of ["transaction-id", "new-payload-phase", "nonzero-conflict", "digest", "directory", "missing-target", "same-target", "no-active-replacement", "failed-target"]) {
    const f = await deferredLocalRetirement(t), index = structuredClone(f.retired.index), transaction = index.transactions[0];
    if (problem === "transaction-id") transaction.transactionId = "9".repeat(32);
    if (problem === "new-payload-phase") transaction.phase = "staging";
    if (problem === "nonzero-conflict") transaction.bytes = 1;
    if (problem === "digest") transaction.manifestDigest = "f".repeat(64);
    if (problem === "directory") transaction.directory = `2026-10-19T00-00-00Z-${transaction.backupId}`;
    if (problem === "missing-target") { transaction.transactionId = "9".repeat(32); transaction.retirementBackupId = transaction.transactionId; }
    if (problem === "same-target") { transaction.transactionId = transaction.backupId; transaction.retirementBackupId = transaction.backupId; }
    if (problem === "no-active-replacement") index.active.pop();
    if (problem === "failed-target") index.active[0].origin = "failed-transaction";
    index.transactionIds = index.transactions.map(p => p.transactionId); index.activeBackupIds = index.active.map(p => p.backupId);
    await writeFile(join(f.active, "index.json"), configBackupCanonical(index));
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:11Z");
    assert.equal(result.status, "stop-new-and-report", problem); assert.equal(result.reason, "remote-evidence-capacity", problem);
    assert.equal(result.index.transactions.length, 1); assert.equal(result.index.recoverable.length, 0);
  }
});


test("zero-allocation local retirement verifies real replacement and target bytes before releasing the intent", async t => {
  for (const problem of ["missing-old", "corrupt-old", "old-record-digest", "replacement-record-bytes", "recovered-old-missing"]) {
    const f = await deferredLocalRetirement(t), index = structuredClone(f.retired.index), old = index.active[0], replacement = index.active[1];
    if (problem === "missing-old" || problem === "recovered-old-missing") await rm(join(f.active, old.directory), { recursive: true });
    if (problem === "corrupt-old") await writeFile(join(f.active, old.directory, "manifest.json"), "{}");
    if (problem === "old-record-digest") old.manifestDigest = "f".repeat(64);
    if (problem === "replacement-record-bytes") replacement.bytes--;
    if (problem === "recovered-old-missing") {
      index.active.shift(); index.recoverable.push({ ...old, origin: "retired", recoverableUntil: "2026-10-21T00:00:11Z" });
      index.activeBackupIds = [replacement.backupId]; index.recoverableBackupIds = [old.backupId];
    }
    await writeFile(join(f.active, "index.json"), configBackupCanonical(index));
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:11Z");
    assert.equal(result.status, "pending", problem); assert.equal(result.reason, "CONFIG_BACKUP_STORED_PACKAGE_CHANGED", problem);
    assert.equal(result.index.transactions.length, 1); assert.equal((await verifyConfigBackup(join(f.active, replacement.directory))).integrity, "verified");
  }
});

test("new local or remote payload transactions cannot masquerade as zero-allocation retirement", async t => {
  for (const remote of [false, true]) {
    const f = await stagedFixture(t), index = structuredClone(f.prepared.index);
    index.transactions[0].bytes = 0;
    if (!remote) delete index.transactions[0].remote;
    const before = await readFile(join(f.stagedRoot, "manifest.json"));
    await writeFile(join(f.store.reservedRoot, "config-backups", "device", f.store.binding.backupGroupId, "index.json"), configBackupCanonical(index));
    const result = await resumeConfigBackup(f.store, "2026-10-20T00:00:11Z");
    assert.equal(result.status, "stop-new-and-report"); assert.equal(result.reason, "remote-evidence-capacity");
    assert.equal(result.index.transactions.length, 1); assert.deepEqual(result.index.activeBackupIds, [f.first.manifest.backupId]);
    assert.deepEqual(await readFile(join(f.stagedRoot, "manifest.json")), before);
  }
});
