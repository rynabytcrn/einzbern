// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { inspectStructuredChildOutput } from "../scripts/lib/push-gate-output.mjs";
import { P8_RELEASE_ARTIFACTS, P8_SUPPORTED_AOS_RELEASES, P8_TAG } from "../scripts/lib/p8-workflow-rc.mjs";

const digest = "a".repeat(64);
const commit = "b".repeat(40);
const sourceFiles = ["package.json"];
function receipt() {
  const surface = { entries: 1, bytes: 1, sha256: digest };
  return {
    ok: true, command: "p8", reasonCode: "P8_WORKFLOW_RC_VERIFIED", tag: P8_TAG,
    p8BasisCommit: commit, tests: "P8_WORKFLOW_RC_TESTS_VERIFIED",
    sourceArchive: { reasonCode: "ARCHIVE_VERIFIED", path: "dist/source/einzbern-source.tar", sha256: digest, files: 1 },
    sbom: {
      reasonCode: "SBOM_VERIFIED", path: "dist/sbom/sbom.cdx.json", basis: digest,
      components: 27, directComponents: 4, transitiveComponents: 21, dependencyGraphClosure: "complete",
      dependencyGraphScope: "lockfile", vendoredComponents: 2, vendoredInventory: "digest-bound-snapshot-and-notices",
    },
    artifacts: P8_RELEASE_ARTIFACTS.map((name) => ({ path: `dist/release/${name}`, size: 1, sha256: digest })).sort((a, b) => a.path < b.path ? -1 : 1),
    staleReleaseArtifacts: [], supportedAosReleases: P8_SUPPORTED_AOS_RELEASES,
    network: false, mutation: false, publication: false, releaseStatus: "accepted_release", privacy: "PRIVACY_SOURCE_CLEAN",
    reproducibility: { rootsIndependent: true, sha256: digest, orderedEntries: sourceFiles, sourceFiles: 1 },
    privacySurfaces: { aggregateAlgorithm: "sha256(path-NUL-byteLength-NUL-bytes over canonical path order)", trackedSource: surface, fullHistory: surface, buildOutput: surface, sourceArchive: surface, releaseArtifacts: surface },
  };
}
function inspect(value) {
  return inspectStructuredChildOutput({ stdout: `${JSON.stringify(value)}\n`, stderr: "", exitCode: 0, signal: null }, "verify:p8", { sourceFiles, p8BasisCommit: commit });
}

test("the P8 consumer admits the SBOM producer's lockfile and vendored provenance fields", () => {
  const result = inspect(receipt());
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test("P8 SBOM provenance fields remain typed, required and closed to unknown fields", () => {
  for (const [field, value] of [["dependencyGraphScope", "all"], ["vendoredComponents", -1], ["vendoredComponents", "2"], ["vendoredInventory", "unchecked"], ["extra", true]]) {
    const changed = receipt();
    changed.sbom[field] = value;
    assert.equal(inspect(changed).ok, false, field);
  }
  for (const field of ["dependencyGraphScope", "vendoredComponents", "vendoredInventory"]) {
    const changed = receipt();
    delete changed.sbom[field];
    assert.equal(inspect(changed).ok, false, field);
  }
});
