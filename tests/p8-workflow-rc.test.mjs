// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

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
  p8FormalPackagePrivacyEntries,
  p8ReleaseArtifactSetMatches,
  p8ReleasePrivacyEntries,
  rebuildP8SourceArchiveInIndependentRoots,
  sanitizedCoreReferenceProjection,
  staleReleaseArtifactMoves,
  validateP8ReleaseDocuments,
} from "../scripts/lib/p8-workflow-rc.mjs";
import { BRAND, ENGINE_REPOSITORY_NAMES, LEGACY_REPOSITORY_NAMES } from "../scripts/lib/names.mjs";
import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";
import { withExclusiveOutputSession } from "../scripts/lib/safe-io.mjs";
import { writeUstar } from "../scripts/lib/tar.mjs";

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

// TCRN-CROSS-INIT-053 R48-01 (R47-REG-1). verifyP8 and the P8 face of verifyPrivacy scan the
// release set through p8ReleasePrivacyEntries: the formal package by its content, its compressed
// bytes bound by digest only. The package below is stored as its bytes, not regenerated, because
// deflate output differs between zlib builds: one member of plain lowercase text whose deflate
// stream, read as UTF-8, spells an address at stream byte 96, as the 1.2.1 package's did.
const EMAIL_SHAPED_DEFLATE_PACKAGE = Buffer.from([
  "1f8b08000000000002ffedcf3d0ec2300c05e0cc3d454e00ae5ae03c51e5fc94b481c4695c4e8fd4818101168440cab7",
  "3cebbdc9da31e588fb3910a61d3189cf030038f6fd9600f09cd076a7c7bdf56dd7760721417c414ea4a2008821bcfcfd",
  "ddfea7a277aa71ded8097940476c2e65586d99c6880bad21eb3507736e92c62653b4469353d9ebf9a246a96e57b22a97",
  "c962e6127d498b3485117958d86a745254555555bfe90eb4baf58f00080000",
].join(""), "hex");
const PACKAGE_LABEL = `dist/release/${P8_RELEASE_ARCHIVE}`;
const inPackage = (label) => label.startsWith(`${PACKAGE_LABEL}#`) || label.startsWith(`${PACKAGE_LABEL}/`);
const joinParts = (parts, separator) => parts.join(separator);
const scanOwner = LEGACY_REPOSITORY_NAMES.owner;
const releaseScan = (entries) => scanPrivacyEntries(entries, { owner: scanOwner, repositories: ENGINE_REPOSITORY_NAMES });

function formalPackage(records, { flags = 0, fields = [] } = {}) {
  const compressed = gzipSync(writeUstar(records));
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 2, 0xff]), ...fields, compressed.subarray(10)]);
}

function releaseSet(releaseArchive) {
  return buildP8ReleaseArtifacts({
    sourceArchive: writeUstar([{ path: "README.md", bytes: Buffer.from("P8 source fixture\n", "utf8") }]),
    sbom: Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8"),
    ...releaseArchiveInputs(releaseArchive),
  });
}

function withHeader(tar, edit) {
  const archive = Buffer.from(tar);
  const header = archive.subarray(0, 512);
  edit(header);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return archive;
}

test("R48-01 (R47-REG-1): P8 scans the formal package by content, so address-shaped compressed bytes are no finding", () => {
  const wholeArchiveText = scanPrivacyEntries([{ label: PACKAGE_LABEL, kind: "release", content: EMAIL_SHAPED_DEFLATE_PACKAGE.toString("utf8") }], { owner: scanOwner });
  assert.deepEqual(wholeArchiveText, [`EMAIL_IDENTIFIER:release:${PACKAGE_LABEL}`], "the stored package reproduces the pre-R48 false finding");
  const { entries, formalPackage: binding } = p8ReleasePrivacyEntries(releaseSet(EMAIL_SHAPED_DEFLATE_PACKAGE));
  assert.deepEqual(releaseScan(entries), []);
  assert.deepEqual(binding, {
    path: PACKAGE_LABEL,
    size: EMAIL_SHAPED_DEFLATE_PACKAGE.length,
    sha256: createHash("sha256").update(EMAIL_SHAPED_DEFLATE_PACKAGE).digest("hex"),
    inflatedBytes: 2048,
    members: 1,
  });
  assert.equal(entries.some((entry) => entry.label === PACKAGE_LABEL), false, "the compressed bytes are no entry");
  const packageEntries = entries.filter((entry) => inPackage(entry.label));
  assert.deepEqual(packageEntries.map((entry) => [entry.label.slice(PACKAGE_LABEL.length), entry.kind, entry.releaseArchiveMember ?? null]), [
    ["#header:fixture/notes.txt", "release", null],
    ["/fixture/notes.txt", "filename", null],
    ["/fixture/notes.txt", "release", true],
    ["#padding:fixture/notes.txt", "release", null],
    ["#trailer", "release", null],
  ]);
  assert.deepEqual(entries.map((entry) => entry.label).filter((label) => !inPackage(label)), P8_RELEASE_ARTIFACTS.filter((name) => name !== P8_RELEASE_ARCHIVE).map((name) => `dist/release/${name}`).sort(compareCanonicalText));
  assert.ok(Buffer.isBuffer(entries.find((entry) => entry.label === `dist/release/${P8_RELEASE_ARTIFACTS[0]}`).content), "privacy.mjs still expands the source archive");
});

test("R48-01 (R47-REG-1): an address or local path in a member, a header path or a gzip text field is still a finding, and an unknown member still fails", async () => {
  const address = joinParts(["person", "@", "example.invalid"], "");
  const localPath = joinParts(["", "Users", "someone", "notes.txt"], "/");
  const clean = { path: "fixture/notes.txt", bytes: Buffer.from("plain text\n", "utf8") };
  const findings = (archive) => releaseScan(p8ReleasePrivacyEntries(releaseSet(archive)).entries);
  assert.deepEqual(findings(formalPackage([{ ...clean, bytes: Buffer.from(`write to ${address}\n`, "utf8") }])), [`EMAIL_IDENTIFIER:release:${PACKAGE_LABEL}/fixture/notes.txt`]);
  assert.deepEqual(findings(formalPackage([{ ...clean, bytes: Buffer.from(`read ${localPath}\n`, "utf8") }])), [`LOCAL_ABSOLUTE_PATH:release:${PACKAGE_LABEL}/fixture/notes.txt`]);
  const privatePath = `fixture/${address}.txt`;
  assert.deepEqual(findings(formalPackage([{ ...clean, path: privatePath }])), [
    `EMAIL_IDENTIFIER:release:${PACKAGE_LABEL}#header:${privatePath}`,
    `EMAIL_IDENTIFIER:filename:${PACKAGE_LABEL}/${privatePath}`,
  ]);
  const field = (text) => Buffer.from(`${text}\0`, "utf8");
  assert.deepEqual(findings(formalPackage([clean], { flags: 0x08, fields: [field(address)] })), [`EMAIL_IDENTIFIER:release:${PACKAGE_LABEL}#gzip-name`]);
  assert.deepEqual(findings(formalPackage([clean], { flags: 0x10, fields: [field(localPath)] })), [`LOCAL_ABSOLUTE_PATH:release:${PACKAGE_LABEL}#gzip-comment`]);
  const extra = Buffer.from(`ex${address}`, "utf8");
  const extraLength = Buffer.alloc(2);
  extraLength.writeUInt16LE(extra.length);
  assert.deepEqual(findings(formalPackage([clean], { flags: 0x04, fields: [extraLength, extra] })), [`EMAIL_IDENTIFIER:release:${PACKAGE_LABEL}#gzip-extra`]);

  // The 2.2.2 package's three compiled names.js owner-line members are fixed by the read-only
  // package evidence. The draft 2.2.4 candidate and every nearby member remain findings.
  const names = await readFile(new URL("../dist/build/packages/core/src/names.js", import.meta.url), "utf8");
  const ownerLine = names.split("\n").find((line) => line.includes(scanOwner) && /\bowner\s*:/u.test(line));
  assert.equal(createHash("sha256").update(scanOwner, "utf8").digest("hex"), "1b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f");
  assert.equal(createHash("sha256").update(ownerLine, "utf8").digest("hex"), "3861c5826071f54b9b552ac3ff993b91181bf9d91d54dcdfd7f0790fc671bd56");
  const reviewedVersion = "2.2.2";
  const reviewedArchive = `dist/release/${BRAND.engine.id}-${reviewedVersion}.tar.gz`;
  const memberPaths = ["atelier/portal.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern.mjs"];
  const ownerBytes = Buffer.from(`${ownerLine}\n`, "utf8");
  const reviewedPackage = p8FormalPackagePrivacyEntries(formalPackage(memberPaths.map((path) => ({
    path: `${BRAND.engine.id}-${reviewedVersion}/${path}`,
    bytes: ownerBytes,
  }))), reviewedArchive);
  const reviewedMembers = reviewedPackage.entries.filter((entry) => entry.releaseArchiveMember === true);
  assert.deepEqual(reviewedMembers.map((entry) => entry.sourcePaths), memberPaths.map(() => ["dist/build/packages/core/src/names.js"]));
  assert.deepEqual(releaseScan(reviewedMembers), []);

  const finalVersion = "2.2.3";
  const finalArchive = `dist/release/${BRAND.engine.id}-${finalVersion}.tar.gz`;
  const finalPackage = p8FormalPackagePrivacyEntries(formalPackage(memberPaths.map((path) => ({
    path: `${BRAND.engine.id}-${finalVersion}/${path}`,
    bytes: ownerBytes,
  }))), finalArchive);
  const finalMembers = finalPackage.entries.filter((entry) => entry.releaseArchiveMember === true);
  assert.equal(finalMembers.length, 3);
  assert.deepEqual(finalMembers.map((entry) => entry.sourcePaths), memberPaths.map(() => ["dist/build/packages/core/src/names.js"]));
  assert.deepEqual(releaseScan(finalPackage.entries), [], "the reviewed 2.2.3 members use canonical package labels");

  const ownerFinding = (entry, owner = scanOwner) => scanPrivacyEntries([entry], { owner, repositories: ENGINE_REPOSITORY_NAMES })
    .includes(`OWNER_PRIVATE_IDENTIFIER:release:${entry.label}`);
  const reviewedPortal = reviewedMembers.find((entry) => entry.label.endsWith("/atelier/portal.mjs"));
  assert.ok(reviewedPortal, "the read-only 2.2.2 package carries the pinned portal member");
  assert.ok(ownerFinding({ ...reviewedPortal, sourcePaths: ["dist/build/packages/core/src/other.js"] }), "a changed source origin remains a finding");
  assert.ok(ownerFinding({ ...reviewedPortal, content: `${ownerLine} // changed` }), "a changed whole line remains a finding");
  const changedOwner = LEGACY_REPOSITORY_NAMES.owner === scanOwner ? "changed-public-owner" : LEGACY_REPOSITORY_NAMES.owner;
  assert.ok(ownerFinding({ ...reviewedPortal, content: ownerLine.replaceAll(scanOwner, changedOwner) }, changedOwner), "a changed value remains a finding");

  const unknownMember = `${BRAND.engine.id}-${reviewedVersion}/atelier/other.mjs`;
  const unknownMemberArchive = p8FormalPackagePrivacyEntries(formalPackage([{ path: unknownMember, bytes: ownerBytes }]), reviewedArchive);
  const unknownReleaseMembers = unknownMemberArchive.entries.filter((entry) => entry.label === `${reviewedArchive}/${unknownMember}` && entry.releaseArchiveMember === true);
  assert.equal(unknownReleaseMembers.length, 1);
  assert.deepEqual(unknownReleaseMembers[0].sourcePaths, []);
  assert.ok(unknownMemberArchive.entries.some((entry) => ownerFinding(entry)), "an unknown member in the reviewed version remains a finding");

  const draftVersion = "2.2.4";
  const draftArchive = `dist/release/${BRAND.engine.id}-${draftVersion}.tar.gz`;
  const draftMember = `${BRAND.engine.id}-${draftVersion}/atelier/portal.mjs`;
  const draftPackage = p8FormalPackagePrivacyEntries(formalPackage([{ path: draftMember, bytes: ownerBytes }]), draftArchive);
  const draftReleaseMembers = draftPackage.entries.filter((entry) => entry.label === `${draftArchive}/${draftMember}` && entry.releaseArchiveMember === true);
  assert.equal(draftReleaseMembers.length, 1);
  assert.deepEqual(draftReleaseMembers[0].sourcePaths, []);
  assert.ok(draftPackage.entries.some((entry) => ownerFinding(entry)), "the draft 2.2.4 candidate has no package classification yet");

  // An entry this walk cannot label, and a package another reader would unpack differently, are refused.
  const layout = (archive) => assert.throws(() => p8FormalPackagePrivacyEntries(archive), (error) => error.reasonCode === "P8_RELEASE_ARCHIVE_LAYOUT_INVALID");
  const tar = writeUstar([clean]);
  const gzipOf = (bytes) => Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]), gzipSync(bytes).subarray(10)]);
  layout(gzipOf(withHeader(tar, (header) => { header[156] = 0x32; })));
  const directory = withHeader(tar.subarray(0, 512), (header) => {
    header.fill(0, 0, 100);
    header.write("fixture/", 0, "utf8");
    header.write("00000000000\0", 124, "latin1");
    header[156] = 0x35;
  });
  layout(gzipOf(Buffer.concat([directory, tar])));
  const valid = formalPackage([clean]);
  layout(Buffer.concat([valid, Buffer.from(address, "utf8")]));
  layout(Buffer.concat([valid, valid]));
  layout(Buffer.concat([valid.subarray(0, 3), Buffer.from([0x20]), valid.subarray(4)]));
  const badCrc = Buffer.from(valid);
  badCrc[badCrc.length - 8] ^= 0xff;
  layout(badCrc);
  layout(valid.subarray(0, valid.length - 12));

  const set = releaseSet(valid);
  const wrongSidecar = new Map(set);
  wrongSidecar.set(P8_RELEASE_ARCHIVE_SHA256, Buffer.from(`${"0".repeat(64)}  ${P8_RELEASE_ARCHIVE}\n`, "utf8"));
  assert.throws(() => p8ReleasePrivacyEntries(wrongSidecar), (error) => error.reasonCode === "P8_RELEASE_ARCHIVE_CHECKSUM_MISMATCH");
  const extraArtifact = new Map(set);
  extraArtifact.set("unexpected.txt", Buffer.from("x\n", "utf8"));
  assert.throws(() => p8ReleasePrivacyEntries(extraArtifact), (error) => error.reasonCode === "P8_PRIVACY_RELEASE_ARTIFACT_SET");
});

test("R48-01 (R47-REG-1): verifyP8 and the P8 face of verifyPrivacy both scan the release set through p8ReleasePrivacyEntries", async () => {
  const task = await readFile(new URL("../scripts/task.mjs", import.meta.url), "utf8");
  const verifyP8 = task.slice(task.indexOf("async function verifyP8() {"), task.indexOf("async function verifyReleaseTagPreflight() {"));
  const p8Face = task.slice(task.indexOf("  if (requireP8Surfaces) {"), task.indexOf("    p8Surfaces.aggregateAlgorithm ="));
  assert.ok(verifyP8.length > 0 && p8Face.length > 0);
  assert.ok(verifyP8.includes("p8ReleasePrivacyEntries(artifacts)") && verifyP8.includes("scanPrivacyEntries(releasePrivacyEntries,"));
  assert.ok(p8Face.includes("entries.push(...p8ReleasePrivacyEntries(new Map(releaseRecords.map("));
  for (const body of [verifyP8, p8Face]) {
    assert.equal(/\.toString\("utf8"\)/u.test(body.replaceAll('record.content.toString("utf8") })));', "")), false, "no release artifact is read as text outside the builder");
    assert.equal(body.includes("gunzipSync") || body.includes("readUstar"), false);
  }
});
