// SPDX-License-Identifier: Apache-2.0
// Historical fixtures only. These do NOT call settings-set/remove or fabricate write receipts.
// The argv shape lets the archived scenarios retain their original input and timestamps.
import assert from "node:assert/strict";
import { appendEvents, materializeWorkspace, readSettingsCatalog, sortWorkspaceSettings } from "../../dist/build/packages/core/src/index.js";
import { assertSettingWriteConsistent, validateSettingValue, validateWorkspaceSettingRecord } from "../../dist/build/packages/core/src/settings.js";
function input(argv) {
  const option = (name) => argv[argv.indexOf(name) + 1];
  return { workspace: option("--workspace"), key: option("--key"), occurredAt: option("--at"), value: argv[0] === "settings-remove" ? null : option("--value") };
}
async function validated(argv) {
  const data = input(argv);
  assert.match(data.key, /^(models\.|quota\.)/u);
  const state = await materializeWorkspace(data.workspace);
  const value = data.value === null ? null : validateSettingValue(data.key, data.value);
  assertSettingWriteConsistent(state.settings, data.key, value);
  return { ...data, state, value };
}
export async function historicalValidationRefusal(argv) {
  try { await validated(argv); } catch (error) { return error; }
  assert.fail("historical value/reference validator did not refuse input");
}
export async function appendHistoricalModelSetting(argv) {
  const { workspace, key, occurredAt, state, value } = await validated(argv);
  const previous = state.settings.find((entry) => entry.key === key);
  const setting = value === null ? null : validateWorkspaceSettingRecord({ schemaVersion: "tcrn.workspace-setting.v1", key, layerKind: "workspace_configuration", value, revision: (previous?.revision ?? 0) + 1, updatedAt: occurredAt, tombstone: false });
  const next = await appendEvents(workspace, [(current) => ({
    payload: setting === null ? { operation: "settings.removed", record: { key, updatedAt: occurredAt } } : { operation: "settings.updated", record: setting },
    projects: current.projects, work: current.work,
    settings: sortWorkspaceSettings([...current.settings.filter((entry) => entry.key !== key), ...(setting === null ? [] : [setting])]),
  })], { occurredAt });
  return { setting, effectiveValue: readSettingsCatalog(next.metadata.workspaceId, next.settings).settings.find((entry) => entry.key === key).currentValue };
}
