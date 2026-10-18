// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceSettingRecord, validateWorkspaceSettingRecord } from "../dist/build/packages/core/src/settings.js";
import { diagnoseLegacySharedPaths } from "../dist/build/packages/core/src/configuration-projections.js";

const at = "2026-10-18T08:00:00Z";
const paths = [
  ["workspace.generatedArtifactsPath", "paths.artifacts"],
  ["knowledge.articlesPath", "paths.knowledgeArticles"],
];

for (const [key, binding] of paths) {
  test(`${key} refuses new absolute declarations regardless of the current platform`, () => {
    for (const value of ["C:/example/private/output", "z:/example/output", "C:\\example\\output", "//example-server/share/output", "\\\\example-server\\share\\output", "/example/private/output"]) {
      assert.throws(() => createWorkspaceSettingRecord(key, value, 1, at), { reasonCode: "SETTINGS_VALUE_INVALID" }, value);
    }
  });

  test(`${key} still admits portable relative paths and logical bindings`, () => {
    for (const value of ["output", "nested/output", "..cache/output", `binding:${binding}`, `binding:${binding}/project-a/output`]) {
      assert.equal(createWorkspaceSettingRecord(key, value, 1, at).value, value);
    }
  });

  test(`${key} keeps previously readable absolute declarations unchanged`, () => {
    const template = createWorkspaceSettingRecord(key, "output", 1, at);
    for (const value of ["/example/private/output", "C:/example/private/output"]) {
      const record = { ...template, value };
      assert.deepEqual(validateWorkspaceSettingRecord(record), record);
      const diagnostics = diagnoseLegacySharedPaths({ metadata: { workspaceId: `library:${"a".repeat(24)}` }, settings: [record] });
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].status, "migration-required");
      assert.equal(diagnostics[0].localBinding, binding);
      assert.equal(JSON.stringify(diagnostics).includes(value), false);
    }
  });
}
