// SPDX-License-Identifier: Apache-2.0

/**
 * INC-093 release invariants. Tag creation is deliberately outside this module:
 * the preflight proves that the candidate tag names the exact commit judged by
 * P8, that P8 judged the version the tag names, and that a release commit
 * contains only release metadata. It takes no signed input, provenance statement
 * or trust archive (TCRN-CROSS-STORY-488 R3). An Owner still decides whether to
 * create or publish the tag.
 */

import { README_NAMES } from "../render-readme.mjs";

const SHA = /^[0-9a-f]{40,64}$/u;
const TAG = /^v\d+\.\d+\.\d+$/u;
const FRAMEWORK_PATH = "packages/core/src/index.ts";
const FRAMEWORK_VERSION = /^export const FRAMEWORK_VERSION = "(\d+\.\d+\.\d+)" as const;$/gmu;
// This is the existing README generator's closed language set, not a README filename glob.
const GENERATED_READMES = README_NAMES;
const CLI_REFERENCE = "docs/wiki/CLI-Reference.md";

export class ReleaseTagGateError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "ReleaseTagGateError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new ReleaseTagGateError(reasonCode, message);
}

export function assertP8TagPreconditions({ p8Result, expectedTag, tagCommit, p8BasisCommit } = {}) {
  if (p8Result?.reasonCode !== "P8_WORKFLOW_RC_VERIFIED") {
    fail("RELEASE_TAG_P8_NOT_GREEN", "release tag requires a green P8 evidence result");
  }
  if (p8Result.releaseStatus !== "accepted_release" || p8Result.publication !== false || p8Result.mutation !== false) {
    fail("RELEASE_TAG_P8_RELEASE_STATUS_INVALID", "P8 evidence is not an unpublished, non-mutating accepted release candidate");
  }
  if (typeof expectedTag !== "string" || !TAG.test(expectedTag)) {
    fail("RELEASE_TAG_INVALID", String(expectedTag));
  }
  if (p8Result.tag !== expectedTag) {
    fail("RELEASE_TAG_P8_TAG_MISMATCH", `${expectedTag} != ${String(p8Result.tag)}`);
  }
  if (typeof tagCommit !== "string" || !SHA.test(tagCommit) || typeof p8BasisCommit !== "string" || !SHA.test(p8BasisCommit)) {
    fail("RELEASE_TAG_COMMIT_INVALID", "tag commit and P8 basis commit must be full hexadecimal commit ids");
  }
  if (tagCommit !== p8BasisCommit || p8Result.p8BasisCommit !== p8BasisCommit) {
    fail("RELEASE_TAG_P8_BASIS_MISMATCH", `${tagCommit.slice(0, 12)} != ${p8BasisCommit.slice(0, 12)}`);
  }
  return {
    tag: expectedTag,
    tagCommit,
    p8BasisCommit,
    p8ReasonCode: p8Result.reasonCode,
  };
}

function isReleaseMetadataPath(path) {
  return path === "CHANGELOG.md"
    || /^docs\/releases\/\d+\.\d+\.\d+\.md$/u.test(path)
    || /(?:^|\/)package\.json$/u.test(path);
}

export function assertReleaseCommitShape({ changedPaths, frameworkBefore, frameworkAfter, version, generatedReadmes, cliReferenceChecked = false } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0 || changedPaths.some((path) => typeof path !== "string" || path.length === 0)) {
    fail("RELEASE_COMMIT_EMPTY", "release commit must name at least one changed path");
  }
  const uniquePaths = [...new Set(changedPaths)];
  const disallowed = uniquePaths.filter((path) => !isReleaseMetadataPath(path) && path !== FRAMEWORK_PATH && !GENERATED_READMES.includes(path) && path !== CLI_REFERENCE);
  if (disallowed.length > 0) {
    fail("RELEASE_COMMIT_SHAPE_INVALID", disallowed.join(","));
  }
  if (uniquePaths.includes(FRAMEWORK_PATH)) {
    if (typeof frameworkBefore !== "string" || typeof frameworkAfter !== "string" || typeof version !== "string" || !TAG.test(`v${version}`)) {
      fail("RELEASE_COMMIT_FRAMEWORK_INVALID", "a core version change requires the complete parent and HEAD sources and release version");
    }
    const before = [...frameworkBefore.matchAll(FRAMEWORK_VERSION)];
    const after = [...frameworkAfter.matchAll(FRAMEWORK_VERSION)];
    if (before.length !== 1 || after.length !== 1 || before[0][1] === version || after[0][1] !== version || frameworkBefore.replace(before[0][0], after[0][0]) !== frameworkAfter) {
      fail("RELEASE_COMMIT_FRAMEWORK_INVALID", "only one FRAMEWORK_VERSION replacement is release metadata");
    }
  }
  const readmes = uniquePaths.filter((path) => GENERATED_READMES.includes(path));
  if (readmes.length > 0 && (generatedReadmes?.ok !== true || generatedReadmes?.reasonCode !== "README_RENDER_MATCHES" || generatedReadmes.version !== version || JSON.stringify(generatedReadmes.drifted) !== "[]")) {
    fail("RELEASE_COMMIT_README_UNVERIFIED", "release READMEs require the actual closed-set rendering check");
  }
  if (uniquePaths.includes(CLI_REFERENCE) && cliReferenceChecked !== true) {
    fail("RELEASE_COMMIT_CLI_UNVERIFIED", "the release CLI reference requires its actual generation check");
  }
  return { changedPaths: uniquePaths.sort() };
}
