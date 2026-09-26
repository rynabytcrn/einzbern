// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: dispatch settings metadata and retirement boundary. TCRN-CROSS-STORY-484 R3
// retires the dispatch keys and the two subagent-plan keys; the tiers are models.tiers.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";

const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString().replace(/\.\d+Z$/u, "Z");

async function invoke(args) {
  let output = "";
  try {
    await runCli(args, { write: (value) => { output += value; } });
    return JSON.parse(output);
  } catch (error) {
    return error;
  }
}

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc145-keys-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: at(0) });
  return join(base, "workspace");
}

const write = (command, workspace, version, second, args) => [command, "--workspace", workspace, "--at", at(second), ...args, "--actor", "agent:test"];

test("S369, STORY-484 R3: settings are sorted in source, the dispatch keys retired, and the tiers are models.tiers", async (t) => {
  const workspace = await fixture(t);
  const source = await readFile(new URL("../packages/core/src/settings.ts", import.meta.url), "utf8");
  const keyType = source.match(/export type SettingKey =([\s\S]*?);/u)?.[1] ?? "";
  const catalogSource = source.match(/const catalogEntries:[\s\S]*?= \[([\s\S]*?)\];\n\nexport const SETTINGS_CATALOG/u)?.[1] ?? "";
  const sourceTypeKeys = [...keyType.matchAll(/\|\s*"([^"]+)"/gu)].map((match) => match[1]);
  const sourceCatalogKeys = [...catalogSource.matchAll(/\bkey:\s*"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(sourceTypeKeys, [...sourceTypeKeys].sort(), "SettingKey union must be independently sorted in source");
  assert.deepEqual(sourceCatalogKeys, [...sourceCatalogKeys].sort(), "catalogEntries must be independently sorted in source");
  assert.deepEqual(sourceTypeKeys, sourceCatalogKeys, "SettingKey and catalogEntries must use the same source order");

  const catalog = await invoke(["settings-catalog", "--workspace", workspace]);
  assert.deepEqual(catalog.settings.map((entry) => entry.key), [...catalog.settings.map((entry) => entry.key)].sort());
  for (const key of ["execution.dispatchClasses", "execution.dispatchMode", "execution.dispatchModes", "execution.dispatchTiers", "execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]) {
    assert.equal(catalog.settings.some((candidate) => candidate.key === key), false, key);
  }
  // The default tiers: both hosts, the three default tier names, each host its own runner, unfilled.
  const tiers = catalog.settings.find((entry) => entry.key === "models.tiers");
  assert.equal(tiers.type, "string");
  assert.deepEqual(JSON.parse(tiers.defaultValue), Object.fromEntries(["claude-code", "codex"].map((host) => [host, Object.fromEntries(
    ["economy", "flagship", "main"].map((tier) => [tier, { effort: "", model: "", runner: host }]),
  )])));
  assert.equal(tiers.currentValue, tiers.defaultValue);

  const vocabulary = await invoke(["vocabulary"]);
  assert.equal(vocabulary.hostValueKind, "string");
  assert.equal(vocabulary.effortValueKind, "string");
  assert.deepEqual(vocabulary.hosts, ["claude-code", "codex"]);
  assert.equal(Object.hasOwn(vocabulary, "roles"), false);
  assert.deepEqual(vocabulary.settingsEnums.map((term) => [term.key, term.valueSource]), [["artifact.language", "settings-catalog"]]);
});

// The dispatch-* verbs that merged custom classes, modes and tiers are retired
// (TCRN-CROSS-STORY-467 R3), and the dispatch settings with them (TCRN-CROSS-STORY-484 R3). What
// stands: models.tiers written directly is validated, and the retired model-plan names point at
// the reads that survive.
test("S369, STORY-484 R3: models.tiers written directly is validated, and the retired model-plan names point at the surviving reads", async (t) => {
  const workspace = await fixture(t);
  const vocabulary = await invoke(["vocabulary"]);
  assert.equal(vocabulary.hosts.includes("gemini"), false);
  assert.equal(Object.hasOwn(vocabulary, "efforts"), false);

  const retiredClasses = await invoke(write("settings-set", workspace, 0, 1, ["--key", "execution.dispatchClasses", "--value", JSON.stringify({ "bad-class": { dispatch: true } })]));
  assert.equal(retiredClasses.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const noRunner = await invoke(write("settings-set", workspace, 0, 1, ["--key", "models.tiers", "--value", JSON.stringify({ "claude-code": { economy: { model: "m", effort: "low" } } })]));
  assert.equal(noRunner.reasonCode, "SETTINGS_VALUE_INVALID");
  assert.equal(noRunner.details.path, "models.tiers.claude-code.economy");
  assert.equal((await invoke(["status", "--workspace", workspace])).version, 0);
  const retired = await invoke(["model-plan-list", "--workspace", workspace]);
  assert.equal(retired.reasonCode, "CLI_COMMAND_UNKNOWN");
  assert.match(retired.message, /settings-catalog.*vocabulary/u);
});
