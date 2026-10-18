// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { configProjectionStatus, projectConfigPath, writeConfigProjection } from "../dist/build/packages/core/src/library-config.js";

const projectId = `project:${"a".repeat(24)}`;
const recordOnlyProject = `project:${"b".repeat(24)}`;
const settings = [
  { key: "artifact.language", value: "en" },
  { projectId, key: "artifact.language", value: "fr" },
];
const variable = { collection: "variable", key: "example", value: { type: "string", value: "example", description: "" } };
const records = [variable, { ...variable, projectId }, { ...variable, projectId: recordOnlyProject }];
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-projection-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dirname(projectConfigPath(root)), { recursive: true });
  return root;
}

test("settings-only status ignores scoped records and record-only project scopes", async t => {
  const root = await scratch(t);
  await writeConfigProjection(root, { versionVector: {}, settings, configRecords: records });
  const before = await readFile(projectConfigPath(root));
  assert.equal(await configProjectionStatus(root, settings), "current");
  assert.equal(await configProjectionStatus(root, settings, records), "current");
  assert.deepEqual(await readFile(projectConfigPath(root)), before);
});

test("settings-only status still compares library and project values in both directions", async t => {
  const root = await scratch(t);
  await writeConfigProjection(root, { versionVector: {}, settings, configRecords: records });
  for (const expected of [
    settings.map((entry, index) => index === 0 ? { ...entry, value: "ja" } : entry),
    settings.map((entry, index) => index === 1 ? { ...entry, value: "ja" } : entry),
    settings.slice(0, 1),
    [...settings, { projectId: recordOnlyProject, key: "artifact.language", value: "de" }],
  ]) assert.equal(await configProjectionStatus(root, expected), "stale");
});

test("explicit records retain strict scoped and library record comparison", async t => {
  const root = await scratch(t);
  await writeConfigProjection(root, { versionVector: {}, settings, configRecords: records });
  assert.equal(await configProjectionStatus(root, settings, records), "current");
  for (const expected of [[], records.slice(1), records.slice(0, 2), records.map(record => ({ ...record, value: { ...record.value, value: "changed" } }))]) {
    assert.equal(await configProjectionStatus(root, settings, expected), "stale");
  }
});

test("empty settings remain current for record-only projections and absent files", async t => {
  const root = await scratch(t);
  assert.equal(await configProjectionStatus(root, []), "current");
  assert.equal(await configProjectionStatus(root, settings), "absent");
  await writeConfigProjection(root, { versionVector: {}, settings: [], configRecords: records });
  assert.equal(await configProjectionStatus(root, []), "current");
  assert.equal(await configProjectionStatus(root, [], []), "stale");
  await writeConfigProjection(root, { versionVector: {}, settings: [], configRecords: [] });
  assert.equal(await configProjectionStatus(root, [], []), "current");
  await writeFile(projectConfigPath(root), "not JSON");
  assert.equal(await configProjectionStatus(root, []), "invalid");
});
