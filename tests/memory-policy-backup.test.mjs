// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyMachineSettingSet, CONFIG_BACKUP_MACHINE_KEYS, validateMachineSettingValue } from "../dist/build/packages/core/src/machine-settings.js";
import { planConfigBackup, writeConfigBackupPackage, verifyConfigBackup } from "../dist/build/packages/core/src/config-backup.js";
import { planMemory, parseMemoryPolicy, MiB } from "../scripts/lib/memory-budget.mjs";

const key = "execution.memoryPolicy";
test("supported device setter and backup allowlist retain policy but never sampled capacity or leases", async t => {
  const root = await mkdtemp(join(tmpdir(), "memory-policy-backup-")); t.after(() => rm(root, { recursive: true, force: true }));
  const value = JSON.stringify({ enabled: true, reserveMiB: 1024, budgetMiB: 4096, fixedMiB: 256, workerMiB: 512, maxWorkers: 4 });
  assert.ok(CONFIG_BACKUP_MACHINE_KEYS.includes(key));
  await applyMachineSettingSet({ key, value, occurredAt: "2026-10-29T00:00:00Z", path: join(root, "machine-settings.json") });
  assert.equal(JSON.parse(await readFile(join(root, "machine-settings.json"), "utf8")).values[key], value);
  assert.throws(() => validateMachineSettingValue(key, JSON.stringify({ enabled: true, observedAvailableBytes: 8192 })), { reasonCode: "MACHINE_SETTING_VALUE_INVALID" });
  const plan = planConfigBackup({ projectRef: { libraryId: `workspace:${"1".repeat(24)}`, projectId: `project:${"2".repeat(24)}` }, backupGroupId: "4".repeat(32), backupId: "5".repeat(32), hostname: "fixture", at: "2026-10-29T00:00:00Z", sourceVersion: { engineVersion: "3.4.0", engineCommit: null, engineCommitStatus: "unknown", artifactIdentity: { kind: "observed-artifact-identity", schemaVersion: "einzbern.install-tree-digest.v1", sha256: "3".repeat(64) }, templateVersions: [] }, payloads: [
    { kind: "device-preference", key, value, source: "device-declaration" },
    { kind: "device-preference", key: "execution.memoryLease", value: "not portable", source: "device-declaration" },
  ] });
  assert.equal(plan.members.length, 1); assert.equal(plan.excluded.length, 1);
  const packageRoot = join(root, "package"); await writeConfigBackupPackage(packageRoot, plan); assert.equal((await verifyConfigBackup(packageRoot)).integrity, "verified");
  const restored = JSON.parse(await readFile(join(packageRoot, plan.manifest.files[0].memberPath), "utf8"));
  const secondPath = join(root, "other-device", "machine-settings.json");
  await applyMachineSettingSet({ key: restored.key, value: restored.value, occurredAt: "2026-10-29T00:01:00Z", path: secondPath });
  const policy = parseMemoryPolicy(JSON.parse(await readFile(secondPath, "utf8")).values[key]);
  const snapshot = { sampledAt: Date.now(), limitBytes: 1200 * MiB, availableBytes: 1200 * MiB, stallPercent: 0, pressureSource: "linux-psi-full-avg10" };
  assert.equal(planMemory(policy, snapshot).workers, 0, "restored policy cannot transplant larger source-machine capacity");
});
