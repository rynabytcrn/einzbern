// SPDX-License-Identifier: Apache-2.0
// CFG-B01/B02/B05. Isolated sequential fixtures only; no real host or race probes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_BACKUP_RESERVED_ROOTS, assertConfigBackupReservedRoot, configBackupCanonical,
  configBackupDigest, configBackupManifestDigest, configBackupMemberPath,
  planConfigBackup, validateConfigBackupManifest, verifyConfigBackup, writeConfigBackupPackage,
} from "../dist/build/packages/core/src/config-backup.js";

const projectRef = { libraryId: `workspace:${"1".repeat(24)}`, projectId: `project:${"2".repeat(24)}` };
const sourceVersion = { engineVersion: "3.1.0", engineCommit: null, engineCommitStatus: "unknown", artifactIdentity: { kind: "observed-artifact-identity", schemaVersion: "einzbern.install-tree-digest.v1", sha256: "3".repeat(64) }, templateVersions: ["rules-v1"] };
const payload = { kind: "device-preference", key: "portal.defaultTheme", value: "dark", source: "device-declaration" };
const plan = (payloads = [payload]) => planConfigBackup({ projectRef, backupGroupId: "4".repeat(32), backupId: "5".repeat(32), hostname: "Test computer", at: "2026-10-20T00:00:00Z", sourceVersion, payloads });
async function temporary(t) { const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-config-backup-"))); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test("CFG-B01: only selected safe keys and user fragments enter a proposed package", () => {
  const result = plan([
    payload,
    { kind: "device-preference", key: "crest.userPath", value: "/private/identity", source: "device-declaration" },
    { kind: "setting", key: "models.tiers", value: "[]", source: "project-declaration" },
    { kind: "agents-user-fragment", index: 0, ownership: "user", text: "password = private-value" },
    { kind: "agents-user-fragment", index: 1, ownership: "user", text: "<!-- einzbern:section generated -->" },
    { kind: "agents-user-fragment", index: 2, ownership: "user", text: "Use /private/account/settings" },
    { kind: "identity", value: "not portable" },
    { kind: "path-remapping", key: "paths.artifacts", remappingRequired: true },
  ]);
  assert.equal(result.integrity, "not-verified");
  assert.equal(result.members.length, 2);
  assert.equal(result.excluded.length, 6);
  assert.ok(!JSON.stringify(result).includes("private-value"));
  assert.ok(!JSON.stringify(result).includes("/private/"));
  assert.ok(!JSON.stringify(result).includes("generated -->"));
});

test("CFG-B01: non-JSON, duplicate selections and unapproved restore mappings refuse", () => {
  assert.throws(() => configBackupCanonical({ value: undefined }));
  assert.throws(() => configBackupCanonical({ value: NaN }));
  assert.throws(() => plan([payload, payload]));
  const p = plan();
  const changed = { ...p.manifest, files: [{ ...p.manifest.files[0], restoreStrategy: "shell-command" }] };
  assert.throws(() => validateConfigBackupManifest(changed));
});

test("CFG-B02: reserved roots are explicit and disjoint from home/library/generated roots", async (t) => {
  const base = await temporary(t); const reserve = join(base, "reserve"); const project = join(base, "project");
  await mkdir(reserve); await mkdir(project);
  await assertConfigBackupReservedRoot(reserve, [project]);
  await assert.rejects(assertConfigBackupReservedRoot(project, [project]));
  await assert.rejects(assertConfigBackupReservedRoot(base, [project]));
  await assert.rejects(assertConfigBackupReservedRoot(reserve, []));
  assert.deepEqual(CONFIG_BACKUP_RESERVED_ROOTS, ["config-backups", "config-backup-staging", "config-backup-recovery"]);
  for (const path of ["/absolute", "../escape", "a/../x", "a//x", "a\\b", "C:x", "a/./b", "trailing."]) assert.throws(() => configBackupMemberPath(path));
});

test("CFG-B05: manifest digest excludes only itself; actual bytes are independently verified", async (t) => {
  const base = await temporary(t); const root = join(base, "package"); const proposal = plan();
  const { manifestDigest, ...body } = proposal.manifest;
  assert.equal(manifestDigest, configBackupDigest(configBackupCanonical(body)));
  assert.equal(configBackupManifestDigest(proposal.manifest), manifestDigest);
  const written = await writeConfigBackupPackage(root, proposal);
  assert.equal(written.integrity, "verified");
  const member = join(root, proposal.manifest.files[0].memberPath);
  await writeFile(member, (await readFile(member, "utf8")).replace("dark", "light"));
  assert.equal((await verifyConfigBackup(root)).integrity, "corrupt");
  await writeFile(member, configBackupCanonical(payload));
  await rm(member);
  assert.equal((await verifyConfigBackup(root)).integrity, "corrupt");
});

test("CFG-B05: extra files, unknown schema, duplicate paths and canonical drift never verify", async (t) => {
  const base = await temporary(t); const root = join(base, "package"); const proposal = plan();
  await writeConfigBackupPackage(root, proposal);
  await writeFile(join(root, "extra.json"), "{}");
  assert.equal((await verifyConfigBackup(root)).integrity, "corrupt");
  await rm(join(root, "extra.json"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...proposal.manifest, schemaVersion: "old-backup-v0" }));
  assert.equal((await verifyConfigBackup(root)).integrity, "corrupt");
  assert.throws(() => validateConfigBackupManifest({ ...proposal.manifest, files: [...proposal.manifest.files, ...proposal.manifest.files] }));
});

test("CFG-B01 sourceVersion binds actual artifact identity and explicit commit uncertainty", () => {
  const make = version => planConfigBackup({ projectRef, backupGroupId: "4".repeat(32), hostname: "fixture", at: "2026-10-20T00:00:00Z", sourceVersion: version, payloads: [payload] });
  assert.equal(make(sourceVersion).manifest.sourceVersion.engineCommit, null);
  assert.equal(make({ ...sourceVersion, engineCommit: "a".repeat(40), engineCommitStatus: "known" }).manifest.sourceVersion.engineCommitStatus, "known");
  for (const invalid of [{ ...sourceVersion, artifactIdentity: undefined }, { ...sourceVersion, engineCommit: "a".repeat(40) }, { ...sourceVersion, engineCommitStatus: "known" }, { ...sourceVersion, artifactIdentity: { ...sourceVersion.artifactIdentity, sha256: "not-a-digest" } }]) assert.throws(() => make(invalid));
  const changed = make({ ...sourceVersion, artifactIdentity: { ...sourceVersion.artifactIdentity, sha256: "f".repeat(64) } });
  assert.notEqual(changed.manifest.manifestDigest, make(sourceVersion).manifest.manifestDigest);
});

test("J06 closed manifest identity and digests reject coercible arrays even with a fresh digest", () => {
  for (const path of [["projectRef", "libraryId"], ["projectRef", "projectId"], ["sourceVersion", "engineVersion"], ["sourceVersion", "artifactIdentity", "sha256"], ["files", 0, "sha256"], ["files", 0, "sourceDigest"], ["files", 0, "category"], ["selectionDigest"], ["backupId"], ["backupGroupId"]]) {
    const changed = structuredClone(plan().manifest); let row = changed;
    for (const key of path.slice(0, -1)) row = row[key];
    row[path.at(-1)] = [row[path.at(-1)]];
    changed.manifestDigest = configBackupManifestDigest(changed);
    assert.throws(() => validateConfigBackupManifest(changed), path.join("."));
  }
});

test("J06 on-disk verification does not coerce an array project ID or artifact hash", async t => {
  const root = await temporary(t); const proposal = plan(); const packageRoot = join(root, "package"); await writeConfigBackupPackage(packageRoot, proposal);
  for (const mutate of [manifest => { manifest.projectRef.projectId = [manifest.projectRef.projectId]; }, manifest => { manifest.sourceVersion.artifactIdentity.sha256 = [manifest.sourceVersion.artifactIdentity.sha256]; }]) {
    const changed = structuredClone(proposal.manifest); mutate(changed); changed.manifestDigest = configBackupManifestDigest(changed);
    await writeFile(join(packageRoot, "manifest.json"), configBackupCanonical(changed));
    const verified = await verifyConfigBackup(packageRoot); assert.equal(verified.integrity, "corrupt"); assert.equal(verified.manifest, null);
  }
});
