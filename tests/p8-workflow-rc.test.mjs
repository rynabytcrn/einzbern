// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FRAMEWORK_VERSION,
  createKnowledgeUnit,
  createProject,
  createWork,
  exportWorkspace,
  generateCorePersonaBundle,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  transitionWork,
  LEGACY_ENGINE_NAME,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, compareCanonicalText, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

import {
  P8_RELEASE_ARTIFACTS,
  P8_RELEASE_ARCHIVE,
  P8_RELEASE_ARCHIVE_SHA256,
  P8_SUPPORTED_AOS_RELEASES,
  P8_TAG,
  P8_VERSION,
  assertClosedReleaseArtifactAllowlist,
  buildP8ReleaseArtifacts,
  moveStaleReleaseArtifacts,
  p8ArtifactRecords,
  p8FailureTerminal,
  p8ReleaseArtifactSetMatches,
  rebuildP8SourceArchiveInIndependentRoots,
  sanitizedCoreReferenceProjection,
  staleReleaseArtifactMoves,
  validateP8ReleaseDocuments,
} from "../scripts/lib/p8-workflow-rc.mjs";
import { withExclusiveOutputSession } from "../scripts/lib/safe-io.mjs";

function releaseArchiveInputs(bytes = Buffer.from(`formal package ${P8_VERSION}\n`, "utf8")) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    releaseArchive: bytes,
    releaseArchiveSha256: Buffer.from(`${digest}  ${P8_RELEASE_ARCHIVE}\n`, "utf8"),
  };
}

test("P8 rebuilds the exact tracked-file USTAR archive in two independent disposable roots", async () => {
  // The source set is the tracked file list since the allowlist retired (TCRN-CROSS-STORY-467 R2).
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((path) => path.length > 0);
  const rebuilt = await rebuildP8SourceArchiveInIndependentRoots({ repositoryRoot: process.cwd(), allowedFiles: tracked });
  assert.equal(rebuilt.rootsIndependent, true);
  assert.equal(rebuilt.sourceFiles, tracked.length);
  assert.ok(rebuilt.sourceFiles > 3);
  assert.deepEqual(rebuilt.orderedEntries, [...tracked].sort(compareCanonicalText));
  assert.equal(rebuilt.archive.subarray(257, 263).toString("utf8"), "ustar\0");
  assert.match(rebuilt.sha256, /^[a-f0-9]{64}$/u);
});

test("P8 creates a closed unpublished release candidate without supported AOS releases", () => {
  const source = Buffer.from("P8 source fixture\n", "utf8");
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8");
  const artifacts = buildP8ReleaseArtifacts({ sourceArchive: source, sbom, ...releaseArchiveInputs() });
  assert.deepEqual([...artifacts.keys()].sort(), [...P8_RELEASE_ARTIFACTS].sort());
  assert.equal(P8_RELEASE_ARTIFACTS.length, 7);
  assert.ok(P8_RELEASE_ARTIFACTS.includes(P8_RELEASE_ARCHIVE));
  assert.ok(P8_RELEASE_ARTIFACTS.includes(P8_RELEASE_ARCHIVE_SHA256));
  assert.equal(P8_VERSION, FRAMEWORK_VERSION);
  assert.equal(P8_TAG, `v${FRAMEWORK_VERSION}`);
  assert.deepEqual(P8_SUPPORTED_AOS_RELEASES, []);
  const manifest = JSON.parse(artifacts.get("release-manifest.json").toString("utf8"));
  assert.equal(manifest.schemaVersion, "tcrn.workflow-release-candidate-manifest.v1");
  assert.notEqual(manifest.schemaVersion, manifest.version);
  assert.equal(manifest.version, P8_VERSION);
  assert.equal(manifest.releaseStatus, "accepted_release");
  assert.deepEqual(manifest.supportedAosReleases, []);
  assert.equal(p8ArtifactRecords(artifacts).length, 7);
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.path).sort(compareCanonicalText), [
    P8_RELEASE_ARTIFACTS[0], "sbom.cdx.json", P8_RELEASE_ARCHIVE, P8_RELEASE_ARCHIVE_SHA256, "release-notes.md",
  ].sort(compareCanonicalText));
  // TCRN-CROSS-STORY-488 R3: the manifest and the checksums stay as P8's local record of the
  // candidate's bytes. Nothing in the set is a signature, a key or a provenance statement, and
  // the manifest names no signer.
  assert.ok(P8_RELEASE_ARTIFACTS.includes("release-manifest.json") && P8_RELEASE_ARTIFACTS.includes("checksums.txt"));
  assert.deepEqual(P8_RELEASE_ARTIFACTS.filter((name) => /\.(?:sig|asc|pem|pub|intoto\.jsonl?)$|provenance|trust/u.test(name)), []);
  assert.deepEqual(Object.keys(manifest).filter((field) => /sign|key|provenance|trust/iu.test(field)), []);
  assert.throws(
    () => assertClosedReleaseArtifactAllowlist(new Map([["unexpected.txt", Buffer.from("")]])),
    (error) => error.reasonCode === "P8_RELEASE_ALLOWLIST_MISMATCH",
  );
});

test("a failed P8 command has a structured failure terminal and cannot claim success", () => {
  const terminal = p8FailureTerminal({ reasonCode: "PRIVACY_FINDINGS", error: "privacy finding in the build surface" });
  assert.deepEqual(terminal, {
    schemaVersion: "tcrn.p8-child-failure.v1",
    command: "p8",
    ok: false,
    reasonCode: "PRIVACY_FINDINGS",
    error: "privacy finding in the build surface",
  });
  assert.throws(
    () => p8FailureTerminal({ reasonCode: "P8_WORKFLOW_RC_VERIFIED", error: "must remain a failure" }),
    (error) => error.reasonCode === "P8_FAILURE_TERMINAL_REASON_INVALID",
  );
});

// TCRN-CROSS-STORY-488 R3: the version check P8 keeps. A manifest that names another version
// or another tag than the one P8 judges is refused, however intact the rest of it is.
test("P8 refuses a release manifest that names another version or tag", () => {
  const artifacts = buildP8ReleaseArtifacts({ sourceArchive: Buffer.from("P8 source fixture\n", "utf8"), sbom: Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8"), ...releaseArchiveInputs() });
  const manifest = JSON.parse(artifacts.get("release-manifest.json").toString("utf8"));
  assert.equal(validateP8ReleaseDocuments(artifacts).releaseStatus, "accepted_release");
  for (const drift of [{ version: "0.0.0" }, { tag: "v0.0.0" }]) {
    const documents = new Map(artifacts);
    documents.set("release-manifest.json", Buffer.from(`${JSON.stringify({ ...manifest, ...drift })}\n`, "utf8"));
    assert.throws(() => validateP8ReleaseDocuments(documents), (error) => error.reasonCode === "P8_RELEASE_MANIFEST_INVALID", JSON.stringify(drift));
  }
});

test("P8 refuses missing, extra, or altered members of its exact seven-artifact set", () => {
  const artifacts = buildP8ReleaseArtifacts({
    sourceArchive: Buffer.from("P8 source fixture\n", "utf8"),
    sbom: Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8"),
    ...releaseArchiveInputs(),
  });
  const withoutPackage = new Map(artifacts);
  withoutPackage.delete(P8_RELEASE_ARCHIVE);
  assert.throws(() => validateP8ReleaseDocuments(withoutPackage), (error) => error.reasonCode === "P8_RELEASE_DOCUMENT_SET");
  const withExtra = new Map(artifacts);
  withExtra.set(`${P8_RELEASE_ARCHIVE}.sig`, Buffer.from("unapproved signature file\n", "utf8"));
  assert.throws(() => validateP8ReleaseDocuments(withExtra), (error) => error.reasonCode === "P8_RELEASE_DOCUMENT_SET");
  assert.equal(p8ReleaseArtifactSetMatches(P8_RELEASE_ARTIFACTS.filter((name) => name !== P8_RELEASE_ARCHIVE_SHA256)), false);
  assert.equal(p8ReleaseArtifactSetMatches([...P8_RELEASE_ARTIFACTS, "unexpected.txt"]), false);

  const alteredPackage = new Map(artifacts);
  alteredPackage.set(P8_RELEASE_ARCHIVE, Buffer.concat([artifacts.get(P8_RELEASE_ARCHIVE), Buffer.from("tamper", "utf8")]));
  assert.throws(() => validateP8ReleaseDocuments(alteredPackage), (error) => error.reasonCode === "P8_RELEASE_MANIFEST_ARTIFACT_MISMATCH");

  const alteredSidecar = new Map(artifacts);
  alteredSidecar.set(P8_RELEASE_ARCHIVE_SHA256, Buffer.from("0".repeat(64) + `  ${P8_RELEASE_ARCHIVE}\n`, "utf8"));
  assert.throws(() => validateP8ReleaseDocuments(alteredSidecar), (error) => error.reasonCode === "P8_RELEASE_MANIFEST_ARTIFACT_MISMATCH");

  const alteredNotes = new Map(artifacts);
  alteredNotes.set("release-notes.md", Buffer.from("tampered notes\n", "utf8"));
  assert.throws(() => validateP8ReleaseDocuments(alteredNotes), (error) => error.reasonCode === "P8_RELEASE_MANIFEST_ARTIFACT_MISMATCH");
});

// TCRN-CROSS-STORY-461 R1 (SUB-240, #232). A temporary repository with an ignored dist tree:
// the previous version's source archive sits beside the current artifacts, as it did
// after the 1.1.3 bump. Red leg: drop the move and the closed artifact set stays red.
// A release archive from before the rename carries the old engine name and is still stale.
const PREVIOUS_SOURCE_ARCHIVE = `${LEGACY_ENGINE_NAME}-1.1.2-source.tar`;

async function staleReleaseFixture(context, releaseNames) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p8-stale-release-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "dist", "release"), { recursive: true });
  await mkdir(join(root, "dist", "evidence", "push-gate-children"), { recursive: true });
  for (const name of releaseNames) await writeFile(join(root, "dist", "release", name), `release artifact ${name}\n`);
  await writeFile(join(root, "dist", "evidence", "push-gate-children", "verify-p8.json"), '{"reasonCode":"P8_WORKFLOW_RC_VERIFIED"}\n');
  await writeFile(join(root, "dist", "evidence", "gate-summary.json"), '{"ok":true}\n');
  return root;
}

async function treeBytes(root, prefix = "") {
  const rows = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((left, right) => compareCanonicalText(left.name, right.name))) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) rows.push(...await treeBytes(root, path));
    else rows.push([path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")]);
  }
  return rows;
}

const releaseNames = async (root) => readdir(join(root, "dist", "release"));

test("STORY-461 SUB-240: a previous-version source archive moves to dist/stale-release and the current artifacts stay", async (context) => {
  assert.notEqual(P8_VERSION, "1.1.2");
  const root = await staleReleaseFixture(context, [PREVIOUS_SOURCE_ARCHIVE, ...P8_RELEASE_ARTIFACTS]);
  const evidenceBefore = await treeBytes(root, "dist/evidence");
  const previousBytes = await readFile(join(root, "dist", "release", PREVIOUS_SOURCE_ARCHIVE));
  assert.equal(p8ReleaseArtifactSetMatches(await releaseNames(root)), false, "the #232 state fails the closed artifact set");

  const moved = await withExclusiveOutputSession(root, () => moveStaleReleaseArtifacts(root));

  assert.equal(p8ReleaseArtifactSetMatches(await releaseNames(root)), true, "the closed artifact set holds once the stale archive is moved");
  assert.deepEqual((await releaseNames(root)).sort(compareCanonicalText), [...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText));
  assert.deepEqual(moved, [{
    from: `dist/release/${PREVIOUS_SOURCE_ARCHIVE}`,
    to: `dist/stale-release/1.1.2/${PREVIOUS_SOURCE_ARCHIVE}`,
    version: "1.1.2",
    size: previousBytes.length,
    sha256: createHash("sha256").update(previousBytes).digest("hex"),
  }]);
  assert.deepEqual(await readFile(join(root, "dist", "stale-release", "1.1.2", PREVIOUS_SOURCE_ARCHIVE)), previousBytes);
  assert.deepEqual(await treeBytes(root, "dist/evidence"), evidenceBefore, "dist/evidence is unchanged byte for byte");
  assert.deepEqual(await withExclusiveOutputSession(root, () => moveStaleReleaseArtifacts(root)), [], "a second run has nothing left to move");
});

test("MIN-235 D18: previous formal archives and their sidecars move together out of the exact P8 set", async (context) => {
  const oldArchive = `einzbern-1.1.2.tar.gz`;
  const oldSidecar = `${oldArchive}.sha256`;
  const root = await staleReleaseFixture(context, [oldArchive, oldSidecar, ...P8_RELEASE_ARTIFACTS]);
  const before = new Map(await Promise.all([oldArchive, oldSidecar].map(async (name) => [name, await readFile(join(root, "dist/release", name))])));

  const moved = await withExclusiveOutputSession(root, () => moveStaleReleaseArtifacts(root));

  assert.equal(p8ReleaseArtifactSetMatches(await releaseNames(root)), true);
  assert.deepEqual((await releaseNames(root)).sort(compareCanonicalText), [...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText));
  assert.deepEqual(moved.map(({ from, to, version }) => ({ from, to, version })), [oldArchive, oldSidecar].map((name) => ({
    from: `dist/release/${name}`,
    to: `dist/stale-release/1.1.2/${name}`,
    version: "1.1.2",
  })));
  for (const name of [oldArchive, oldSidecar]) {
    assert.deepEqual(await readFile(join(root, "dist/stale-release/1.1.2", name)), before.get(name));
  }
});

test("STORY-461 SUB-240: with no stale archive nothing moves and an unknown file is left for the set assertion", async (context) => {
  const root = await staleReleaseFixture(context, [...P8_RELEASE_ARTIFACTS, "notes.txt"]);
  const before = await treeBytes(root, "dist");
  assert.deepEqual(staleReleaseArtifactMoves([...P8_RELEASE_ARTIFACTS, "notes.txt", "einzbern-source.tar"]), []);

  assert.deepEqual(await withExclusiveOutputSession(root, () => moveStaleReleaseArtifacts(root)), []);

  assert.deepEqual(await treeBytes(root, "dist"), before, "nothing under dist moved or changed");
  assert.equal(p8ReleaseArtifactSetMatches(await releaseNames(root)), false, "an unknown file still reds the closed artifact set");
});

test("STORY-461 SUB-240: a stale destination holding other bytes fails closed and keeps both copies", async (context) => {
  const root = await staleReleaseFixture(context, [PREVIOUS_SOURCE_ARCHIVE, ...P8_RELEASE_ARTIFACTS]);
  const destination = join(root, "dist", "stale-release", "1.1.2", PREVIOUS_SOURCE_ARCHIVE);
  await mkdir(join(root, "dist", "stale-release", "1.1.2"), { recursive: true });
  await writeFile(destination, "an earlier archive with other bytes\n");

  await assert.rejects(
    withExclusiveOutputSession(root, () => moveStaleReleaseArtifacts(root)),
    (error) => error.reasonCode === "P8_STALE_RELEASE_DESTINATION_CONFLICT",
  );
  assert.ok((await releaseNames(root)).includes(PREVIOUS_SOURCE_ARCHIVE), "the source stays when the move is refused");
  assert.equal(await readFile(destination, "utf8"), "an earlier archive with other bytes\n");

  await writeFile(destination, await readFile(join(root, "dist", "release", PREVIOUS_SOURCE_ARCHIVE)));
  assert.equal((await withExclusiveOutputSession(root, () => moveStaleReleaseArtifacts(root))).length, 1, "the same bytes already moved: only the source goes");
  assert.equal(p8ReleaseArtifactSetMatches(await releaseNames(root)), true);
});

test("P8 projects the generated eight-profile Core Reference bundle through the closed sanitizer", () => {
  const bundle = generateCorePersonaBundle();
  const projection = sanitizedCoreReferenceProjection(bundle);
  assert.equal(bundle.profiles.length, 8);
  assert.equal(projection.profiles.length, 8);
  assert.equal(projection.bundleIdentity, bundle.bundleDigest);
  assert.deepEqual(Object.keys(projection.profiles[0]).sort(compareCanonicalText), ["displayName", "jobTitle", "mission", "profileDigest", "profileId"]);
  const serialized = canonicalJson(projection);
  assert.equal(serialized.match(/legacy|transcript|credential|AOS/iu), null);
  assert.equal(serialized.includes(`${"/"}Users${"/"}`), false);
});

test("P8 dogfood completes one disposable local_primary initiative with Knowledge and dry-run artifacts", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p8-dogfood-")));
  context.after(async () => {
    await rm(base, { recursive: true, force: true });
    await assert.rejects(lstat(base));
  });
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: "2026-07-14T00:00:00Z" });
  let state = await createProject(workspace, { occurredAt: "2026-07-14T00:00:01Z", externalKey: "FIXTURE-P8-PROJECT", name: "P8 local_primary" });
  state = await createWork(workspace, { occurredAt: "2026-07-14T00:00:02Z", projectId: state.projects[0].id, externalKey: "FIXTURE-P8-INITIATIVE", kind: "Initiative", parentId: null, status: "planned" });
  for (const [status, occurredAt] of [["ready", "2026-07-14T00:00:03Z"], ["active", "2026-07-14T00:00:04Z"], ["done", "2026-07-14T00:00:05Z"]]) {
    state = await transitionWork(workspace, { occurredAt, id: state.work[0].id, status });
  }
  assert.equal(state.work[0].status, "done");
  const exportOne = await exportWorkspace(workspace);
  const exportTwo = await exportWorkspace(workspace);
  assert.equal(exportOne, exportTwo);
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const knowledge = await createKnowledgeUnit(workspace, {
    occurredAt: "2026-07-14T00:00:06Z",
    externalKey: "FIXTURE-P8-KNOWLEDGE",
    scope: "project",
    projectId: state.projects[0].id,
    roleScopes: [],
    category: "implementation",
    kind: "guide",
    tags: ["p8", "release"],
    subject: "P8 public dogfood Knowledge",
    summary: "A disposable public metadata fixture.",
    snippet: "P8 fixture snippet.",
    accountableOwnerId: deriveStableId("owner", "FIXTURE-P8-OWNER"),
    sourceReferences: ["evidence://fixture/p8-dogfood"],
    sourceDigest: canonicalSha256({ source: "p8-dogfood" }),
    linkedWorkIds: [state.work[0].id],
    linkedDecisionIds: [deriveStableId("decision", "FIXTURE-P8-DECISION")],
    linkedGateIds: [deriveStableId("gate", "FIXTURE-P8-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "FIXTURE-P8-EVIDENCE")],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: "2026-07-14T00:00:06Z",
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "Disposable P8 body is explicitly separated from metadata.",
  });
  // TCRN-CROSS-INC-282: the card is written promoted, so the dogfood loop has no separate
  // promotion act to perform.
  const selected = await listKnowledgeMetadata(workspace, { at: "2026-07-14T00:00:07Z", projectId: state.projects[0].id, selection: "all" });
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].id, knowledge.id);
  // The profile authorization and context-route legs of this loop went with the authority
  // family (TCRN-CROSS-STORY-467 R2). What the loop still proves: the metadata read never
  // carries the body.
  assert.equal(canonicalJson(selected).includes("Disposable P8 body"), false);
});
