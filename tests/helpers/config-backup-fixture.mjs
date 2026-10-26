// SPDX-License-Identifier: Apache-2.0
// Synthetic backup setup lives outside Portal's public-CLI-only dependency
// boundary. The independent packaged-release test covers authorized CLI writes;
// Portal tests consume these retained packages only through its real read route.

import assert from "node:assert/strict";
import { planConfigBackup } from "../../dist/build/packages/core/src/config-backup.js";
import { createConfigBackup, validateConfigBackupRetentionPolicy } from "../../dist/build/packages/core/src/config-backup-retention.js";

export async function createConfigBackupInventoryFixture({ reservedRoot, projectRoot, projectId, protectedRoots, localBindingRoot }) {
  // Fixture-only policy values, not product defaults or authority for a real store.
  const policy = { schemaVersion: "einzbern.config-backup-retention.v1", activeLimit: 2, transactionLimit: 1, recoveryLimit: 2, maxPackageBytes: 65536, maxTotalBytes: 262144, retentionDuration: 1000, recoveryDuration: 86400000, noChangePolicy: "skip", atLimitAction: "stop-new-and-report", retirementMethod: "verified-recovery-move", approvalEvidenceRef: "fixture-only:portal-retained-backups" };
  const validated = validateConfigBackupRetentionPolicy(policy);
  assert.equal(validated.status, "policy-valid");
  const projectRef = { libraryId: `workspace:${"1".repeat(24)}`, projectId };
  const sourceVersion = { engineVersion: "3.3.1", engineCommit: null, engineCommitStatus: "unknown", artifactIdentity: { kind: "observed-artifact-identity", schemaVersion: "einzbern.install-tree-digest.v1", sha256: "3".repeat(64) }, templateVersions: ["rules-v1"] };
  for (const [hostname, id] of [["Device one", "4"], ["Device two", "5"]]) {
    const binding = { projectRef, backupGroupId: id.repeat(32), writerBindingRef: "fixture:writer", executionEnvironmentRef: "fixture:environment", hostname };
    const plan = planConfigBackup({ projectRef, backupGroupId: binding.backupGroupId, hostname, backupId: id.repeat(32), sourceVersion, at: "2026-10-25T06:30:00Z", payloads: [{ kind: "device-preference", key: "portal.defaultTheme", value: "dark", source: "device-declaration" }] });
    const store = { reservedRoot, localBindingRoot, protectedRoots, retainedContainerRoots: [{ path: projectRoot, kind: "project" }], binding, policy, approval: { approved: true, policyDigest: validated.policyDigest, approvalEvidenceRef: policy.approvalEvidenceRef } };
    assert.equal((await createConfigBackup(store, plan, plan.manifest.createdAtUtc)).status, "settled");
  }
}
