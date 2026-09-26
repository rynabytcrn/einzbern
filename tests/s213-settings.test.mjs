// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SETTINGS_CATALOG,
  SETTINGS_LAYER_KIND,
  appendEvents,
  initializeLibrary,
  materializeWorkspace,
  setWorkspaceSetting,
  validateSettingValue,
  validateWorkspace,
  LEGACY_CONTROL_DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import {
  isRetiredSettingKey,
  settingsCatalogEntry,
} from "../dist/build/packages/core/src/settings.js";

const instant = (second) => `2026-08-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s213-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  return { workspace };
}

async function runRaw(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function errorReason(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

async function appendRetiredHistory(workspace) {
  const record = {
    schemaVersion: "tcrn.workspace-setting.v1",
    key: "execution.personalessDispatch",
    layerKind: "workspace_configuration",
    value: "legacy-value",
    revision: 1,
    updatedAt: instant(2),
    tombstone: false,
  };
  // Use appendEvents with a hand-built delta so the real createEvent hash path
  // constructs the synthetic history while createWorkspaceSettingRecord is bypassed.
  return appendEvents(workspace, [
    (state) => ({
      payload: { operation: "settings.updated", record },
      projects: state.projects,
      work: state.work,
      settings: state.settings,
    }),
  ], { occurredAt: instant(2) });
}

test("INIT-022 S213: catalog exposes every engine-consumed workspace setting", async (t) => {
  const { workspace } = await fixture(t, "catalog");
  const readback = await runRaw(["settings-catalog", "--workspace", workspace]);
  assert.equal(readback.reasonCode, "SETTINGS_CATALOG_READY");
  assert.equal(readback.layerKind, SETTINGS_LAYER_KIND);
  assert.deepEqual(readback.settings.map((entry) => entry.key), SETTINGS_CATALOG.map((entry) => entry.key));
  // TCRN-CROSS-STORY-469 R2: every key of this catalog is project-level; its records keep the
  // workspace_configuration layer kind.
  assert.deepEqual(readback.settings.map((entry) => entry.layer), SETTINGS_CATALOG.map((entry) => entry.layer));
  assert.deepEqual([...new Set(readback.settings.map((entry) => entry.layer))], ["project"]);
  assert.deepEqual([...new Set(SETTINGS_CATALOG.map((entry) => entry.layerKind))], [SETTINGS_LAYER_KIND]);
  assert.deepEqual(readback.settings.map((entry) => entry.currentValue), SETTINGS_CATALOG.map((entry) => entry.defaultValue));
  assert.deepEqual(readback.settings.map((entry) => entry.type), SETTINGS_CATALOG.map((entry) => entry.type));
});

test("INIT-022 S213: unknown keys fail closed and registered writes receipt plus replay readback", async (t) => {
  const { workspace } = await fixture(t, "write");
  const baseArgs = ["settings-set", "--workspace", workspace, "--at", instant(1), "--actor", "agent:codex"];
  assert.equal(await errorReason([...baseArgs, "--key", "settings.not-registered", "--value", "manual"]), "SETTINGS_KEY_UNREGISTERED");
  assert.equal((await materializeWorkspace(workspace)).version, 0, "a rejected key must not append an event");

  const receipt = await runRaw([...baseArgs, "--key", "artifact.language", "--value", "zh-CN"]);
  assert.equal(receipt.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(receipt.setting.key, "artifact.language");
  assert.equal(receipt.setting.value, "zh-CN");
  assert.equal(receipt.setting.layerKind, SETTINGS_LAYER_KIND);
  assert.equal(receipt.setting.revision, 1);
  assert.equal(receipt.version, 1);

  const state = await validateWorkspace(workspace);
  assert.equal(state.settings.length, 1);
  assert.equal(state.settings[0].value, "zh-CN");
  assert.equal(state.events[0].payload.operation, "settings.updated");
  const catalog = await runRaw(["settings-catalog", "--workspace", workspace]);
  assert.equal(catalog.settings.find((entry) => entry.key === "artifact.language").currentValue, "zh-CN");

  await assert.rejects(
    setWorkspaceSetting(workspace, {
      occurredAt: instant(3),
      key: "workspace.generatedArtifactsPath",
      value: workspace,
      actorId: "agent:codex",
    }),
    (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID",
  );
  assert.equal((await materializeWorkspace(workspace)).version, 1, "a rejected path must not append an event");
});

test("STORY-366: article directories are workspace-relative by default and cannot target the control tree", async (t) => {
  const { workspace } = await fixture(t, "articles-path");
  const catalog = await runRaw(["settings-catalog", "--workspace", workspace]);
  const entry = catalog.settings.find((setting) => setting.key === "knowledge.articlesPath");
  assert.equal(entry.defaultValue, "docs/knowledge/articles");
  assert.equal(entry.currentValue, "docs/knowledge/articles");
  assert.equal(validateSettingValue("knowledge.articlesPath", "docs/knowledge/articles", workspace), "docs/knowledge/articles");
  assert.equal(validateSettingValue("knowledge.articlesPath", "/tmp/tcrn-article-root", workspace), "/tmp/tcrn-article-root");
  assert.throws(() => validateSettingValue("knowledge.articlesPath", "../outside", workspace), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
  assert.throws(() => validateSettingValue("knowledge.articlesPath", `${LEGACY_CONTROL_DIRECTORY}/articles`, workspace), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
  assert.throws(() => validateSettingValue("knowledge.articlesPath", `${workspace}/${LEGACY_CONTROL_DIRECTORY}/articles`, workspace), (error) => error?.reasonCode === "SETTINGS_VALUE_INVALID");
});

test("INC-321 S3: a retired settings.updated event replays from genesis and stays out of current settings", async (t) => {
  const { workspace } = await fixture(t, "retired-replay");
  await appendRetiredHistory(workspace);
  const state = await materializeWorkspace(workspace);
  assert.equal(state.version, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.settings.length, 0, "retired values are not materialized as current settings");
  assert.equal(isRetiredSettingKey("execution.personalessDispatch"), true);
  assert.equal(isRetiredSettingKey("backup.cadence"), true, "TCRN-CROSS-STORY-484 R3 retires the backup keys");
  assert.equal(isRetiredSettingKey("artifact.language"), false);
  assert.equal(isRetiredSettingKey("settings.random"), false);
});

test("INC-321 S3: the normal settings write path still rejects the retired key", async (t) => {
  const { workspace } = await fixture(t, "retired-write");
  await appendRetiredHistory(workspace);
  await assert.rejects(
    setWorkspaceSetting(workspace, {
      key: "execution.personalessDispatch",
      value: "new-value",
      occurredAt: instant(3),
    }),
    (error) => error?.reasonCode === "SETTINGS_KEY_UNREGISTERED",
  );
  assert.throws(
    () => settingsCatalogEntry("execution.personalessDispatch"),
    (error) => error?.reasonCode === "SETTINGS_KEY_UNREGISTERED",
  );
  const state = await materializeWorkspace(workspace);
  assert.equal(state.version, 1, "the rejected write does not append an event");
  assert.equal(state.settings.length, 0);
});
