// SPDX-License-Identifier: Apache-2.0
// CFG-R01/R02/R03. Only isolated, sequential package/engine fixtures. No real restore.
import { asPinnedDevice } from "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProject, initializeLibrary, materializeWorkspace, setWorkspaceSetting } from "../dist/build/packages/core/src/workspace.js";
import { declareChainIdentity } from "../dist/build/packages/core/src/project-chain.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { applyMachineSettingSet, readMachineSettings } from "../dist/build/packages/core/src/machine-settings.js";
import { collectConfigBackupPayloads, configBackupCanonical, planConfigBackup, writeConfigBackupPackage } from "../dist/build/packages/core/src/config-backup.js";
import { validateConfigBackupRetentionPolicy } from "../dist/build/packages/core/src/config-backup-retention.js";
import { applyConfigRestore, planConfigRestore } from "../dist/build/packages/core/src/config-restore.js";
const at = "2026-10-20T00:00:00Z";
const version = { engineVersion: "3.1.0", engineCommit: "3".repeat(40), templateVersions: ["rules-v1"] };
// Explicit synthetic values are never runtime approval or product defaults.
const fixturePolicy = { schemaVersion: "einzbern.config-backup-retention.v1", activeLimit: 5, transactionLimit: 1, recoveryLimit: 2, maxPackageBytes: 65536, maxTotalBytes: 524288, retentionDuration: 1000, recoveryDuration: 86400000, noChangePolicy: "skip", atLimitAction: "stop-new-and-report", retirementMethod: "verified-recovery-move", approvalEvidenceRef: "fixture-only:restore-originals" };
async function fixture(t, home, payloads) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-config-restore-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, "library"); const project = join(root, "project"); const reserve = join(root, "originals");
  await mkdir(project); await mkdir(reserve);
  const initial = await initializeLibrary({ root: library, createdAt: at });
  await declareChainIdentity(library, { role: "project", coordinationLibraryId: initial.metadata.workspaceId }, { occurredAt: at });
  const state = await createProject(library, { externalKey: "RESTORE-FIXTURE", name: "Restore fixture", occurredAt: at });
  const projectId = state.projects[0].id;
  await registerLibrary({ projectPath: project, libraryPath: library, projectId, registeredAt: at, gitRemote: null }, home);
  const projectRef = { libraryId: state.metadata.workspaceId, projectId };
  const source = { libraryRoot: library, projectRoot: project, projectRef, declarationScope: "project", machineSettingsPath: join(home, "machine-settings.json") };
  const proposal = planConfigBackup({ projectRef, backupGroupId: "4".repeat(32), backupId: "5".repeat(32), hostname: "source-device", at, sourceVersion: version, payloads });
  const packageRoot = join(root, "package"); await writeConfigBackupPackage(packageRoot, proposal);
  const validated = validateConfigBackupRetentionPolicy(fixturePolicy);
  const originalsStore = { reservedRoot: reserve, localBindingRoot: join(home, "config-backup-bindings"), protectedRoots: [library, project, home], binding: { projectRef, backupGroupId: "6".repeat(32), writerBindingRef: "fixture-only:writer", executionEnvironmentRef: "fixture-only:environment", hostname: "target-device" }, policy: fixturePolicy, approval: { approved: true, policyDigest: validated.policyDigest, approvalEvidenceRef: fixturePolicy.approvalEvidenceRef } };
  const keys = proposal.manifest.files.map(file => file.logicalKey);
  const target = { source, sourceVersion: version, availablePartitions: [projectRef.libraryId], permittedKeys: keys, originalsStore, actorId: "actor:fixture", authorizations: Object.fromEntries(keys.map(key => [key, { surface: "atelier" }])) };
  return { root, source, target, packageRoot, proposal };
}
test("CFG-R01: preview classifies local authorities, discovery remapping and denied items together", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home, [
    { kind: "device-preference", key: "portal.defaultTheme", value: "dark", source: "device-declaration" },
    { kind: "device-preference", key: "portal.defaultPartition", value: "unavailable-partition", source: "device-declaration" },
    { kind: "setting", key: "artifact.language", value: "fr", source: "project-declaration" },
    { kind: "agents-user-fragment", index: 0, ownership: "user", text: "Restored user text.\n" },
    { kind: "path-remapping", key: "paths.artifacts", remappingRequired: true },
  ]);
  await applyMachineSettingSet({ key: "portal.defaultTheme", value: "dark", occurredAt: at, path: f.source.machineSettingsPath });
  await writeFile(join(f.source.projectRoot, "AGENTS.md"), "Original user text.\n");
  const target = { ...f.target, permittedKeys: f.target.permittedKeys.filter(key => key !== "setting:artifact.language") };
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target, at });
  const rows = Object.fromEntries(plan.items.map(item => [item.logicalKey, item.classification]));
  assert.equal(rows["device-preference:portal.defaultTheme"], "unchanged");
  assert.equal(rows["device-preference:portal.defaultPartition"], "unmappable");
  assert.equal(rows["setting:artifact.language"], "permission-denied");
  assert.equal(rows["agents-user-fragment:0"], "conflict");
  assert.equal(rows["path-remapping:paths.artifacts"], "unmappable");
  assert.ok(plan.items.every(item => item.originalRecoveryLocation === f.target.originalsStore.reservedRoot));
}));
test("CFG-R02: approved plan preserves original user content and uses real machine setter readback", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home, [
    { kind: "agents-user-fragment", index: 0, ownership: "user", text: "Restored user text.\n" },
    { kind: "device-preference", key: "portal.defaultTheme", value: "dark", source: "device-declaration" },
  ]);
  await writeFile(join(f.source.projectRoot, "AGENTS.md"), "Original user text.\n");
  await applyMachineSettingSet({ key: "portal.defaultTheme", value: "light", occurredAt: at, path: f.source.machineSettingsPath });
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at });
  const result = await applyConfigRestore({ packageRoot: f.packageRoot, target: f.target, plan, approvedPlanDigest: plan.planDigest, at: "2026-10-20T00:00:01Z" });
  assert.equal(result.status, "applied"); assert.ok(result.items.every(item => item.originalBackupId !== null));
  assert.equal(await readFile(join(f.source.projectRoot, "AGENTS.md"), "utf8"), "Restored user text.\n");
  assert.equal((await readMachineSettings(f.source.machineSettingsPath)).values["portal.defaultTheme"], "dark");
  assert.deepEqual(new Set(result.items.map(item => item.receipt.authority)), new Set(["user-file", "machine-settings"]));
  const index = JSON.parse(await readFile(join(f.target.originalsStore.reservedRoot, "config-backups", "target-device", f.target.originalsStore.binding.backupGroupId, "index.json"), "utf8"));
  assert.equal(index.active.length, 1);
  const manifestRoot = join(f.target.originalsStore.reservedRoot, "config-backups", "target-device", f.target.originalsStore.binding.backupGroupId, index.active[0].directory);
  const manifest = JSON.parse(await readFile(join(manifestRoot, "manifest.json"), "utf8"));
  const original = manifest.files.find(file => file.logicalKey === "agents-user-fragment:0");
  assert.equal(JSON.parse(await readFile(join(manifestRoot, original.memberPath), "utf8")).text, "Original user text.\n");
}));
test("CFG-R02: governed restoration writes the authoritative engine and reports actual event readback", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home, [{ kind: "setting", key: "artifact.language", value: "fr", source: "project-declaration" }]);
  await setWorkspaceSetting(f.source.libraryRoot, { key: "artifact.language", value: "en", occurredAt: at, configurationProjectId: f.source.projectRef.projectId });
  const before = await materializeWorkspace(f.source.libraryRoot);
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at });
  const result = await applyConfigRestore({ packageRoot: f.packageRoot, target: f.target, plan, approvedPlanDigest: plan.planDigest, at: "2026-10-20T00:00:01Z" });
  const after = await materializeWorkspace(f.source.libraryRoot);
  assert.equal(after.settings.find(row => row.key === "artifact.language" && row.projectId === f.source.projectRef.projectId).value, "fr");
  assert.ok(after.version > before.version); assert.notEqual(after.headEventHash, before.headEventHash);
  assert.equal(result.items[0].receipt.authority, "engine"); assert.equal(result.items[0].receipt.headEventHash, after.headEventHash);
}));
test("CFG-R02: stale targets, changed permissions and missing original policy refuse before overwrite", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home, [{ kind: "agents-user-fragment", index: 0, ownership: "user", text: "Restored.\n" }]);
  await writeFile(join(f.source.projectRoot, "AGENTS.md"), "Original.\n");
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at });
  await writeFile(join(f.source.projectRoot, "AGENTS.md"), "Later edit.\n");
  await assert.rejects(applyConfigRestore({ packageRoot: f.packageRoot, target: f.target, plan, approvedPlanDigest: plan.planDigest, at }), { reasonCode: "CONFIG_RESTORE_PLAN_STALE" });
  assert.equal(await readFile(join(f.source.projectRoot, "AGENTS.md"), "utf8"), "Later edit.\n");
  const target = { ...f.target, originalsStore: { ...f.target.originalsStore, policy: null, approval: null } };
  const next = await planConfigRestore({ packageRoot: f.packageRoot, target, at });
  await assert.rejects(applyConfigRestore({ packageRoot: f.packageRoot, target, plan: next, approvedPlanDigest: next.planDigest, at }), { reasonCode: "policy-unapproved" });
}));
test("CFG-R03: version mismatch is incompatible; unknown schemas and changed package bytes never restore", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home, [{ kind: "device-preference", key: "portal.defaultTheme", value: "dark", source: "device-declaration" }]);
  const target = { ...f.target, sourceVersion: { ...version, engineVersion: "3.2.0" } };
  assert.equal((await planConfigRestore({ packageRoot: f.packageRoot, target, at })).items[0].classification, "incompatible");
  await writeFile(join(f.packageRoot, "manifest.json"), configBackupCanonical({ ...f.proposal.manifest, schemaVersion: "legacy-full-home-backup" }));
  await assert.rejects(planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at }), { reasonCode: "CONFIG_RESTORE_PACKAGE_INVALID" });
}));

test("CFG-R02: an unmappable item does not hide successful supported items", async t => asPinnedDevice(async home => {
  const f = await fixture(t, home, [
    { kind: "device-preference", key: "portal.defaultTheme", value: "dark", source: "device-declaration" },
    { kind: "path-remapping", key: "paths.knowledgeArticles", remappingRequired: true },
  ]);
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at });
  const result = await applyConfigRestore({ packageRoot: f.packageRoot, target: f.target, plan, approvedPlanDigest: plan.planDigest, at });
  assert.equal(result.status, "partial");
  assert.equal(result.items.find(item => item.logicalKey === "path-remapping:paths.knowledgeArticles").status, "skipped");
  assert.equal(result.items.find(item => item.logicalKey === "device-preference:portal.defaultTheme").status, "applied");
  assert.equal((await readMachineSettings(f.source.machineSettingsPath)).values["paths.knowledgeArticles"], undefined);
}));

test("CFG-R01/R02: variables and rule inputs use their supported typed engine mutations", async t => asPinnedDevice(async home => {
  const { BUILT_IN_RULES } = await import("../dist/build/packages/core/src/rules-catalog.js");
  const rule = BUILT_IN_RULES.find(entry => entry.id === "autonomy");
  const f = await fixture(t, home, [
    { kind: "variable", name: "example.limit", declaration: { type: "number", value: "2", description: "Example count", exports: ["handoff"], order: 3 }, source: "project-declaration" },
    { kind: "rule", id: rule.id, version: rule.version, enabled: true, source: "project-declaration" },
  ]);
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at });
  const result = await applyConfigRestore({ packageRoot: f.packageRoot, target: f.target, plan, approvedPlanDigest: plan.planDigest, at });
  const state = await materializeWorkspace(f.source.libraryRoot);
  const variable = state.configRecords.find(record => record.collection === "variable" && record.key === "example.limit");
  assert.equal(variable.value.type, "number"); assert.equal(variable.value.value, "2"); assert.deepEqual(variable.value.exports, ["handoff"]);
  assert.equal(state.configRecords.find(record => record.collection === "rule" && record.key === rule.id).value.enabled, true);
  assert.ok(result.items.every(item => item.receipt?.authority === "engine"));
}));

test("CFG-B01/R01: missing rule declarations are not relabeled as explicit local disabled records", async t => asPinnedDevice(async home => {
  const { BUILT_IN_RULES } = await import("../dist/build/packages/core/src/rules-catalog.js");
  const rule = BUILT_IN_RULES.find(entry => entry.id === "autonomy");
  const f = await fixture(t, home, [{ kind: "rule", id: rule.id, version: rule.version, enabled: false, source: "project-declaration" }]);
  await assert.rejects(collectConfigBackupPayloads(f.source, [{ kind: "rule", key: rule.id }]), { reasonCode: "CONFIG_BACKUP_DECLARATION_MISSING" });
  const plan = await planConfigRestore({ packageRoot: f.packageRoot, target: f.target, at });
  assert.equal(plan.items[0].targetDigest, null);
  assert.equal(plan.items[0].classification, "incompatible");
  const result = await applyConfigRestore({ packageRoot: f.packageRoot, target: f.target, plan, approvedPlanDigest: plan.planDigest, at });
  assert.equal(result.status, "refused");
  assert.equal((await materializeWorkspace(f.source.libraryRoot)).configRecords.some(record => record.collection === "rule" && record.key === rule.id), false);
}));
