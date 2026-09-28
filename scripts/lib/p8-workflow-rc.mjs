// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { canonicalJson } from "./canonical-json.mjs";
import { compareCanonicalText } from "./canonical-order.mjs";
import { BRAND, LEGACY_ENGINE_NAME, LEGACY_REPOSITORY_NAMES } from "./names.mjs";
import { readBoundRegularFile, safeWriteOutput } from "./safe-io.mjs";

export const P8_VERSION = "1.2.1";
export const P8_TAG = "v1.2.1";
export const P8_FAILURE_TERMINAL_SCHEMA = "tcrn.p8-child-failure.v1";
// The GitHub repository keeps its old name until the Owner renames it (a separate stop).
export const P8_REPOSITORY = LEGACY_REPOSITORY_NAMES.engine;
export const P8_WORKFLOW = "release";
export const P8_SUPPORTED_AOS_RELEASES = Object.freeze([]);
export const P8_RELEASE_ARCHIVE = `${BRAND.engine.id}-${P8_VERSION}.tar.gz`;
export const P8_RELEASE_ARCHIVE_SHA256 = `${P8_RELEASE_ARCHIVE}.sha256`;
export const P8_RELEASE_ARTIFACTS = Object.freeze([
  `${BRAND.engine.id}-${P8_VERSION}-source.tar`,
  "sbom.cdx.json",
  "release-manifest.json",
  "checksums.txt",
  "release-notes.md",
  P8_RELEASE_ARCHIVE,
  P8_RELEASE_ARCHIVE_SHA256,
]);

/** A failed P8 run still emits one machine-readable terminal while retaining a nonzero exit. */
export function p8FailureTerminal({ reasonCode, error } = {}) {
  assertion(
    typeof reasonCode === "string" && /^[A-Z][A-Z0-9_]*$/u.test(reasonCode) && reasonCode !== "P8_WORKFLOW_RC_VERIFIED",
    "P8_FAILURE_TERMINAL_REASON_INVALID",
  );
  assertion(typeof error === "string" && error.length > 0, "P8_FAILURE_TERMINAL_MESSAGE_INVALID");
  return {
    schemaVersion: P8_FAILURE_TERMINAL_SCHEMA,
    command: "p8",
    ok: false,
    reasonCode,
    error,
  };
}

// TCRN-CROSS-STORY-461 R1 (#232), MIN-235 D18. After a version bump dist/release can still hold
// the previous release's source archive or formal package beside the new artifacts, and the
// closed artifact set then fails. Stale artifacts go to an ignored directory beside release,
// never into dist/evidence.
export const P8_STALE_RELEASE_DIRECTORY = "dist/stale-release";
// Previous release archives may carry the old engine name; both prefixes are stale.
const P8_VERSIONED_SOURCE_ARCHIVE = new RegExp(`^(?:${BRAND.engine.id}|${LEGACY_ENGINE_NAME})-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)-source\\.tar$`, "u");
const P8_VERSIONED_PACKED_ARCHIVE = new RegExp(`^(?:${BRAND.engine.id}|${LEGACY_ENGINE_NAME})-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\.tar\\.gz(?:\\.sha256)?$`, "u");

/**
 * Name the stale release artifacts in a dist/release listing and where each one goes.
 * Pure: it reads and moves nothing. Only a source archive or formal package carrying a version
 * other than `version` is stale; every other unexpected name is left for the set assertion.
 */
export function staleReleaseArtifactMoves(names, version = P8_VERSION) {
  assertion(Array.isArray(names) && names.every((name) => typeof name === "string"), "P8_RELEASE_LISTING_INVALID");
  return [...names].sort(compareCanonicalText).flatMap((name) => {
    const stale = P8_VERSIONED_SOURCE_ARCHIVE.exec(name)?.[1] ?? P8_VERSIONED_PACKED_ARCHIVE.exec(name)?.[1];
    return stale === undefined || stale === version ? [] : [{
      name,
      version: stale,
      from: `dist/release/${name}`,
      to: `${P8_STALE_RELEASE_DIRECTORY}/${stale}/${name}`,
    }];
  });
}

/** The closed comparison P8_PRIVACY_RELEASE_ARTIFACT_SET asserts over the dist/release names. */
export function p8ReleaseArtifactSetMatches(names) {
  return Array.isArray(names)
    && JSON.stringify([...names].sort(compareCanonicalText)) === JSON.stringify([...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText));
}

/**
 * Move each stale release artifact inside the caller's exclusive output session. The
 * copy is written with safeWriteOutput and read back before the source is unlinked; a
 * destination already holding other bytes fails closed so neither copy is lost.
 */
export async function moveStaleReleaseArtifacts(repositoryRoot, { version = P8_VERSION } = {}) {
  const releaseRoot = resolve(repositoryRoot, "dist/release");
  let names;
  try {
    names = await readdir(releaseRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const bound = (code) => ({ reasonCode: `P8_STALE_RELEASE_${code}_INVALID`, hardlinkReasonCode: `P8_STALE_RELEASE_${code}_HARDLINK`, pathChangedReasonCode: `P8_STALE_RELEASE_${code}_CHANGED` });
  const moved = [];
  for (const move of staleReleaseArtifactMoves(names, version)) {
    const sourcePath = resolve(repositoryRoot, move.from);
    const source = await readBoundRegularFile(sourcePath, bound("SOURCE"));
    const digest = sha256(source.content);
    const present = await lstat(resolve(repositoryRoot, move.to)).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (present) {
      const existing = await readBoundRegularFile(resolve(repositoryRoot, move.to), bound("DESTINATION"));
      assertion(sha256(existing.content) === digest, "P8_STALE_RELEASE_DESTINATION_CONFLICT", move.to);
    } else {
      await safeWriteOutput(repositoryRoot, move.to, source.content);
      const written = await readBoundRegularFile(resolve(repositoryRoot, move.to), bound("DESTINATION"));
      assertion(sha256(written.content) === digest, "P8_STALE_RELEASE_DESTINATION_CHANGED", move.to);
    }
    const current = await lstat(sourcePath);
    assertion(current.isFile() && current.dev === source.metadata.dev && current.ino === source.metadata.ino, "P8_STALE_RELEASE_SOURCE_CHANGED", move.from);
    await unlink(sourcePath);
    moved.push({ from: move.from, to: move.to, version: move.version, size: source.content.length, sha256: digest });
  }
  return moved;
}

export class P8ReleaseError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "P8ReleaseError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new P8ReleaseError(reasonCode, message);
}

function assertion(condition, reasonCode, message) {
  if (!condition) fail(reasonCode, message ?? reasonCode);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function posix(value) {
  return value.split(sep).join("/");
}

function safePath(path) {
  assertion(typeof path === "string" && path.length > 0 && path.length <= 255, "P8_RELEASE_PATH_INVALID", String(path));
  assertion(!path.startsWith("/") && !path.includes("\\"), "P8_RELEASE_PATH_INVALID", path);
  const parts = path.split("/");
  assertion(parts.every((part) => part !== "" && part !== "." && part !== ".."), "P8_RELEASE_PATH_INVALID", path);
  return path;
}

function fixedMode(path, bytes) {
  return bytes.subarray(0, 2).toString("utf8") === "#!" ? 0o755 : 0o644;
}

function tarField(target, offset, size, value) {
  const bytes = Buffer.from(value, "utf8");
  assertion(bytes.length <= size, "P8_RELEASE_TAR_FIELD", value);
  bytes.copy(target, offset);
}

function tarOctal(value, size) {
  return `${value.toString(8).padStart(size - 1, "0")}\0`;
}

function tarEntry(record) {
  const header = Buffer.alloc(512, 0);
  tarField(header, 0, 100, record.path);
  tarField(header, 100, 8, tarOctal(record.mode, 8));
  tarField(header, 108, 8, tarOctal(0, 8));
  tarField(header, 116, 8, tarOctal(0, 8));
  tarField(header, 124, 12, tarOctal(record.bytes.length, 12));
  tarField(header, 136, 12, tarOctal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  tarField(header, 257, 6, "ustar\0");
  tarField(header, 263, 2, "00");
  tarField(header, 265, 32, "root");
  tarField(header, 297, 32, "root");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  tarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (record.bytes.length % 512)) % 512, 0);
  return Buffer.concat([header, record.bytes, padding]);
}

export function buildCanonicalUstar(records) {
  assertion(Array.isArray(records) && records.length > 0, "P8_RELEASE_RECORDS_EMPTY");
  const normalized = records.map((record) => {
    assertion(record && Buffer.isBuffer(record.bytes), "P8_RELEASE_RECORD_INVALID");
    const path = safePath(record.path);
    assertion(record.mode === 0o644 || record.mode === 0o755, "P8_RELEASE_MODE_INVALID", path);
    return { path, bytes: Buffer.from(record.bytes), mode: record.mode };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
  assertion(new Set(normalized.map((record) => record.path)).size === normalized.length, "P8_RELEASE_DUPLICATE_PATH");
  return Buffer.concat([...normalized.map(tarEntry), Buffer.alloc(1024, 0)]);
}

export async function releaseSourceRecords(repositoryRoot, allowedFiles) {
  assertion(Array.isArray(allowedFiles) && allowedFiles.length > 0, "P8_RELEASE_ALLOWLIST_INVALID");
  const root = resolve(repositoryRoot);
  const paths = [...allowedFiles].map(safePath).sort(compareCanonicalText);
  assertion(new Set(paths).size === paths.length, "P8_RELEASE_ALLOWLIST_DUPLICATE");
  const records = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    assertion(posix(relative(root, absolute)) === path, "P8_RELEASE_PATH_ESCAPE", path);
    const source = await readBoundRegularFile(absolute, {
      reasonCode: "P8_RELEASE_SOURCE_INVALID",
      hardlinkReasonCode: "P8_RELEASE_SOURCE_HARDLINK",
      pathChangedReasonCode: "P8_RELEASE_SOURCE_CHANGED",
    });
    records.push({ path, bytes: source.content, mode: fixedMode(path, source.content) });
  }
  return records;
}

function orderedRecordPaths(records) {
  return records.map((record) => record.path).sort(compareCanonicalText);
}

async function materializeSourceRecords(root, records) {
  for (const record of records) {
    const target = resolve(root, safePath(record.path));
    assertion(posix(relative(root, target)) === record.path, "P8_RELEASE_PATH_ESCAPE", record.path);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, record.bytes, { mode: record.mode });
  }
}

export async function rebuildP8SourceArchiveInIndependentRoots({ repositoryRoot, allowedFiles }) {
  const basisRecords = await releaseSourceRecords(repositoryRoot, allowedFiles);
  const expectedPaths = orderedRecordPaths(basisRecords);
  const stagingBase = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p8-source-basis-")));
  const roots = [];
  try {
    for (const name of ["first", "second"]) {
      const root = resolve(stagingBase, name);
      await mkdir(root, { mode: 0o700 });
      await materializeSourceRecords(root, basisRecords);
      roots.push(root);
    }
    const rebuilt = [];
    for (const root of roots) {
      const records = await releaseSourceRecords(root, allowedFiles);
      const orderedPaths = orderedRecordPaths(records);
      assertion(JSON.stringify(orderedPaths) === JSON.stringify(expectedPaths), "P8_ARCHIVE_REPRODUCIBILITY_PATHS");
      rebuilt.push({ root, orderedPaths, archive: buildCanonicalUstar(records) });
    }
    assertion(rebuilt[0].archive.equals(rebuilt[1].archive), "P8_ARCHIVE_REPRODUCIBILITY_MISMATCH");
    return {
      sourceFiles: expectedPaths.length,
      orderedEntries: expectedPaths,
      archive: rebuilt[0].archive,
      sha256: sha256(rebuilt[0].archive),
      rootsIndependent: true,
    };
  } finally {
    await rm(stagingBase, { recursive: true, force: true });
  }
}

function documentRecord(path, bytes) {
  return { path, size: bytes.length, sha256: sha256(bytes) };
}

export function validateP8ReleaseDocuments(documents) {
  assertion(documents instanceof Map && documents.size === P8_RELEASE_ARTIFACTS.length, "P8_RELEASE_DOCUMENT_SET");
  assertion(JSON.stringify([...documents.keys()].sort(compareCanonicalText)) === JSON.stringify([...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText)), "P8_RELEASE_DOCUMENT_SET");
  for (const path of P8_RELEASE_ARTIFACTS) assertion(Buffer.isBuffer(documents.get(path)), "P8_RELEASE_DOCUMENT_INVALID", path);
  const manifest = JSON.parse(documents.get("release-manifest.json").toString("utf8"));
  assertion(manifest.schemaVersion === "tcrn.workflow-release-candidate-manifest.v1" && manifest.repository === P8_REPOSITORY && manifest.workflow === P8_WORKFLOW && manifest.version === P8_VERSION && manifest.tag === P8_TAG && manifest.releaseStatus === "accepted_release" && JSON.stringify(manifest.supportedAosReleases) === "[]", "P8_RELEASE_MANIFEST_INVALID");
  const manifestBasis = { ...manifest };
  delete manifestBasis.manifestDigest;
  assertion(manifest.manifestDigest === sha256(Buffer.from(canonicalJson(manifestBasis), "utf8")), "P8_RELEASE_MANIFEST_DIGEST");
  assertion(manifest.schemaVersion !== manifest.version && manifest.schemaVersion !== manifest.tag, "P8_RELEASE_MANIFEST_INVALID", "schemaVersion must remain distinct from release identity");
  // The formal archive has its own install-tree manifest; the P8 manifest binds the source,
  // SBOM, formal archive and its sidecar, and release notes as bytes. These identifiers and
  // digests are separate from the package version.
  const expectedManifestPaths = [P8_RELEASE_ARTIFACTS[0], "sbom.cdx.json", P8_RELEASE_ARCHIVE, P8_RELEASE_ARCHIVE_SHA256, "release-notes.md"].sort(compareCanonicalText);
  assertion(Array.isArray(manifest.artifacts) && manifest.artifacts.length === expectedManifestPaths.length && manifest.artifacts.every((artifact) => artifact && typeof artifact.path === "string"), "P8_RELEASE_MANIFEST_INVALID", "artifacts");
  const manifestPaths = manifest.artifacts.map((artifact) => artifact?.path).sort(compareCanonicalText);
  assertion(JSON.stringify(manifestPaths) === JSON.stringify(expectedManifestPaths), "P8_RELEASE_MANIFEST_INVALID", "artifacts");
  for (const artifact of manifest.artifacts) {
    const bytes = documents.get(artifact.path);
    assertion(Buffer.isBuffer(bytes) && artifact.sha256 === sha256(bytes) && artifact.size === bytes.length, "P8_RELEASE_MANIFEST_ARTIFACT_MISMATCH", String(artifact.path));
  }
  const archiveBytes = documents.get(P8_RELEASE_ARCHIVE);
  const archiveChecksum = documents.get(P8_RELEASE_ARCHIVE_SHA256).toString("utf8");
  assertion(archiveChecksum === `${sha256(archiveBytes)}  ${P8_RELEASE_ARCHIVE}\n`, "P8_RELEASE_ARCHIVE_CHECKSUM_MISMATCH");
  const expected = new Map([...documents].filter(([path]) => path !== "checksums.txt").map(([path, bytes]) => [path, sha256(bytes)]));
  const expectedPaths = [...expected.keys()].sort(compareCanonicalText);
  const checksumText = documents.get("checksums.txt").toString("utf8");
  assertion(checksumText.endsWith("\n") && !checksumText.endsWith("\n\n"), "P8_RELEASE_CHECKSUMS_INVALID");
  const lines = checksumText.slice(0, -1).split("\n");
  assertion(lines.length === expected.size, "P8_RELEASE_CHECKSUMS_INVALID");
  const checkedPaths = [];
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  ([^\s]+)$/u);
    assertion(match, "P8_RELEASE_CHECKSUMS_INVALID", line);
    checkedPaths.push(match[2]);
    assertion(expected.get(match[2]) === match[1], "P8_RELEASE_CHECKSUM_MISMATCH", match[2]);
  }
  assertion(JSON.stringify(checkedPaths) === JSON.stringify(expectedPaths), "P8_RELEASE_CHECKSUMS_INVALID");
  return { releaseStatus: "accepted_release", supportedAosReleases: [], artifactCount: documents.size };
}

export function buildP8ReleaseArtifacts({ sourceArchive, sbom, releaseArchive, releaseArchiveSha256 }) {
  assertion(Buffer.isBuffer(sourceArchive) && Buffer.isBuffer(sbom) && Buffer.isBuffer(releaseArchive) && Buffer.isBuffer(releaseArchiveSha256), "P8_RELEASE_DOCUMENT_INVALID");
  const sourcePath = P8_RELEASE_ARTIFACTS[0];
  const notes = Buffer.from(`# ${BRAND.engine.name} ${P8_VERSION}\n\nThis is an immutable unpublished local release candidate. It supports no AOS releases, performs no publication, and is not a supported release.\n`, "utf8");
  const releaseRecords = [
    documentRecord(sourcePath, sourceArchive),
    documentRecord("sbom.cdx.json", sbom),
    documentRecord(P8_RELEASE_ARCHIVE, releaseArchive),
    documentRecord(P8_RELEASE_ARCHIVE_SHA256, releaseArchiveSha256),
    documentRecord("release-notes.md", notes),
  ];
  const manifestBasis = {
    schemaVersion: "tcrn.workflow-release-candidate-manifest.v1",
    repository: P8_REPOSITORY,
    workflow: P8_WORKFLOW,
    version: P8_VERSION,
    tag: P8_TAG,
    releaseStatus: "accepted_release",
    supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    artifacts: releaseRecords.sort((left, right) => compareCanonicalText(left.path, right.path)),
  };
  const manifest = Buffer.from(`${canonicalJson({ ...manifestBasis, manifestDigest: sha256(Buffer.from(canonicalJson(manifestBasis), "utf8")) })}\n`, "utf8");
  // P8's manifest and checksums are local records of candidate bytes. The formal archive sidecar
  // covers the complete gzip package (including its manifest); the install-tree digest excludes
  // only its own manifest. No signing or provenance statement is emitted.
  const records = [
    [sourcePath, sourceArchive],
    ["sbom.cdx.json", sbom],
    ["release-manifest.json", manifest],
    ["release-notes.md", notes],
    [P8_RELEASE_ARCHIVE, releaseArchive],
    [P8_RELEASE_ARCHIVE_SHA256, releaseArchiveSha256],
  ];
  const checksums = Buffer.from([...records]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([path, bytes]) => `${sha256(bytes)}  ${path}`)
    .join("\n") + "\n", "utf8");
  const artifacts = new Map([...records, ["checksums.txt", checksums]]);
  validateP8ReleaseDocuments(artifacts);
  return artifacts;
}

export function p8ArtifactRecords(artifacts) {
  validateP8ReleaseDocuments(artifacts);
  return [...artifacts.entries()].map(([path, bytes]) => documentRecord(`dist/release/${path}`, bytes)).sort((left, right) => compareCanonicalText(left.path, right.path));
}

export function assertClosedReleaseArtifactAllowlist(artifacts) {
  assertion(artifacts instanceof Map, "P8_RELEASE_ALLOWLIST_MISMATCH");
  const actual = [...artifacts.keys()].sort(compareCanonicalText);
  const expected = [...P8_RELEASE_ARTIFACTS].sort(compareCanonicalText);
  assertion(JSON.stringify(actual) === JSON.stringify(expected), "P8_RELEASE_ALLOWLIST_MISMATCH");
  return actual;
}

export function sanitizedCoreReferenceProjection(bundle) {
  assertion(bundle && Array.isArray(bundle.profiles) && bundle.profiles.length === 8, "P8_SANITIZED_CORE_INVALID");
  const profiles = bundle.profiles.map((profile) => {
    const allowed = ["profileId", "displayName", "jobTitle", "mission", "profileDigest"];
    const projection = Object.fromEntries(allowed.map((field) => [field, profile[field]]));
    assertion(Object.values(projection).every((value) => typeof value === "string" && value.length > 0), "P8_SANITIZED_CORE_INVALID");
    return projection;
  }).sort((left, right) => compareCanonicalText(left.profileId, right.profileId));
  const output = { schemaVersion: "tcrn.p8-sanitized-core-reference.v1", bundleIdentity: bundle.bundleDigest, profiles };
  const text = canonicalJson(profiles);
  const localUserPath = `${"/"}Users${"/"}`;
  assertion(!/(?:\.context|legacy|transcript|credential|AOS)/iu.test(text) && !text.includes(localUserPath), "P8_SANITIZED_CORE_PRIVATE_CONTENT");
  return output;
}
