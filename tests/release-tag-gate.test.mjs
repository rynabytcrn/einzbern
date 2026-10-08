// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertP8TagPreconditions, assertReleaseCommitShape } from "../scripts/lib/release-tag-gate.mjs";
import { README_NAMES, renderReadmes } from "../scripts/render-readme.mjs";

const GREEN = {
  reasonCode: "P8_WORKFLOW_RC_VERIFIED",
  releaseStatus: "accepted_release",
  publication: false,
  mutation: false,
  tag: "v0.11.8",
};
const COMMIT = "a".repeat(40);

test("INC-093: a green P8 result must bind exactly to the candidate tag commit", () => {
  assert.deepEqual(
    assertP8TagPreconditions({ p8Result: { ...GREEN, p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT }),
    { tag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT, p8ReasonCode: "P8_WORKFLOW_RC_VERIFIED" },
  );
});

test("INC-093 red leg: a red P8 result or a different basis refuses tag preflight", () => {
  assert.throws(
    () => assertP8TagPreconditions({ p8Result: { ...GREEN, p8BasisCommit: "b".repeat(40) }, expectedTag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT }),
    (error) => error.reasonCode === "RELEASE_TAG_P8_BASIS_MISMATCH",
  );
  assert.throws(
    () => assertP8TagPreconditions({ p8Result: { ...GREEN, reasonCode: "P8_FAILED", p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT }),
    (error) => error.reasonCode === "RELEASE_TAG_P8_NOT_GREEN",
  );
  assert.throws(
    () => assertP8TagPreconditions({ p8Result: { ...GREEN, p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: "b".repeat(40), p8BasisCommit: COMMIT }),
    (error) => error.reasonCode === "RELEASE_TAG_P8_BASIS_MISMATCH",
  );
});

test("SUB-357: a release commit admits only the actual single core version replacement", async () => {
  const before = await readFile(new URL("../packages/core/src/framework-version.ts", import.meta.url), "utf8");
  const current = /^export const FRAMEWORK_VERSION = "(\d+\.\d+\.\d+)" as const;$/mu.exec(before)[1];
  const version = current === "2.0.0" ? "2.0.1" : "2.0.0";
  const after = before.replace(`FRAMEWORK_VERSION = "${current}"`, `FRAMEWORK_VERSION = "${version}"`);
  const input = { changedPaths: ["packages/core/src/framework-version.ts", "package.json"], frameworkBefore: before, frameworkAfter: after, version };
  assert.deepEqual(assertReleaseCommitShape(input).changedPaths, ["package.json", "packages/core/src/framework-version.ts"]);
  for (const change of [
    { frameworkBefore: undefined },
    { frameworkAfter: `${after}\nexport const EXTRA = true;\n` },
    { frameworkAfter: after.replace('DEFAULT_MODE = "development"', 'DEFAULT_MODE = "release"') },
    { frameworkAfter: after.replace(`FRAMEWORK_VERSION = "${version}"`, 'FRAMEWORK_VERSION = "2.0.2"') },
    { frameworkAfter: `${after}\nexport const FRAMEWORK_VERSION = "${version}" as const;\n` },
  ]) assert.throws(() => assertReleaseCommitShape({ ...input, ...change }), (error) => error.reasonCode === "RELEASE_COMMIT_FRAMEWORK_INVALID");
});

test("SUB-357: only the generated README language set and a checked CLI reference are release metadata", async () => {
  const checked = await renderReadmes({ check: true });
  assert.equal(checked.ok, true);
  assert.deepEqual(assertReleaseCommitShape({ changedPaths: [...README_NAMES, "docs/wiki/CLI-Reference.md"], version: checked.version, generatedReadmes: checked, cliReferenceChecked: true }).changedPaths, [...README_NAMES, "docs/wiki/CLI-Reference.md"].sort());
  assert.throws(() => assertReleaseCommitShape({ changedPaths: ["README.zh-CN.md"], generatedReadmes: checked }), (error) => error.reasonCode === "RELEASE_COMMIT_SHAPE_INVALID");
  // Another version than the current one, derived as above so a 2.0.0 tree still has one.
  const otherVersion = checked.version === "2.0.0" ? "2.0.1" : "2.0.0";
  for (const generatedReadmes of [undefined, { ...checked, drifted: ["README.md"] }, { ...checked, version: otherVersion }]) {
    assert.throws(() => assertReleaseCommitShape({ changedPaths: ["README.md"], version: checked.version, generatedReadmes }), (error) => error.reasonCode === "RELEASE_COMMIT_README_UNVERIFIED");
  }
  assert.throws(() => assertReleaseCommitShape({ changedPaths: ["docs/wiki/CLI-Reference.md"] }), (error) => error.reasonCode === "RELEASE_COMMIT_CLI_UNVERIFIED");
});

// TCRN-CROSS-STORY-488 R3: the version check the tag gate keeps. A green P8 result for another
// version refuses the tag even when the commits agree; no signed input is asked for.
test("INC-093 red leg: a P8 result that names another version refuses tag preflight", () => {
  assert.throws(
    () => assertP8TagPreconditions({ p8Result: { ...GREEN, tag: "v0.11.7", p8BasisCommit: COMMIT }, expectedTag: "v0.11.8", tagCommit: COMMIT, p8BasisCommit: COMMIT }),
    (error) => error.reasonCode === "RELEASE_TAG_P8_TAG_MISMATCH",
  );
});

// The regenerated proof surfaces a release commit also used to carry (the source allowlist,
// the claim map and the RC1 manifest) are retired (TCRN-CROSS-STORY-467 R2).
test("INC-093: release commits admit release metadata", () => {
  assert.deepEqual(
    assertReleaseCommitShape({ changedPaths: [
      "packages/core/package.json",
      "CHANGELOG.md",
      "docs/releases/0.11.8.md",
    ] }),
    { changedPaths: [
      "CHANGELOG.md",
      "docs/releases/0.11.8.md",
      "packages/core/package.json",
    ] },
  );
  assert.throws(
    () => assertReleaseCommitShape({ changedPaths: ["packages/core/src/workspace.ts"] }),
    (error) => error.reasonCode === "RELEASE_COMMIT_SHAPE_INVALID",
  );
});
