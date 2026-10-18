// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateSettingValue } from "../dist/build/packages/core/src/settings.js";
import { assertGeneratedArtifactsRoot } from "../dist/build/packages/core/src/artifact-store.js";
import { DIRECTORY, LEGACY_CONTROL_DIRECTORY } from "../dist/build/packages/core/src/names.js";

test("artifact settings reject all workspace descendants, including dot-prefixed directories", () => {
  const workspace = join(tmpdir(), "artifact-boundary-workspace");
  for (const candidate of [workspace, join(workspace, "ordinary"), join(workspace, "..cache"), join(workspace, "..cache", "blobs")]) {
    assert.throws(() => validateSettingValue("workspace.generatedArtifactsPath", candidate, workspace), { reasonCode: "SETTINGS_VALUE_INVALID" });
  }
  for (const candidate of [join(workspace, ".."), `${workspace}-sibling`, join(workspace, "..", "..cache")]) {
    assert.equal(validateSettingValue("workspace.generatedArtifactsPath", candidate, workspace), candidate);
  }
  assert.equal(validateSettingValue("workspace.generatedArtifactsPath", "..cache/blobs", workspace), "..cache/blobs", "relative artifact roots remain permitted");
});

test("article settings exclude the control tree without excluding its siblings or parent", () => {
  const workspace = join(tmpdir(), "article-boundary-workspace");
  for (const suffix of ["", "/ordinary", "/..cache", "/..cache/articles"]) {
    const relative = `${LEGACY_CONTROL_DIRECTORY}${suffix}`;
    for (const candidate of [relative, join(workspace, relative)]) {
      assert.throws(() => validateSettingValue("knowledge.articlesPath", candidate, workspace), { reasonCode: "SETTINGS_VALUE_INVALID" });
    }
  }
  for (const candidate of [workspace, "..cache/articles", `${LEGACY_CONTROL_DIRECTORY}-sibling/articles`, join(workspace, "..cache", "articles")]) {
    assert.equal(validateSettingValue("knowledge.articlesPath", candidate, workspace), candidate);
  }
  assert.throws(() => validateSettingValue("knowledge.articlesPath", "../outside", workspace), { reasonCode: "SETTINGS_VALUE_INVALID" });
});

test("artifact roots exclude dot-prefixed device descendants but accept sibling and parent directories", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "artifact-device-boundary-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const device = join(home, DIRECTORY.device);
  const workspace = join(base, "workspace");
  for (const candidate of [device, join(device, "ordinary"), join(device, "..cache"), join(device, "..cache", "blobs")]) {
    await mkdir(candidate, { recursive: true });
    await assert.rejects(assertGeneratedArtifactsRoot(workspace, candidate, home), { reasonCode: "ARTIFACT_PATH_INVALID" });
  }
  for (const candidate of [home, `${device}-sibling`, join(home, "..cache")]) {
    await mkdir(candidate, { recursive: true });
    assert.equal(await assertGeneratedArtifactsRoot(workspace, candidate, home), candidate);
  }
});
