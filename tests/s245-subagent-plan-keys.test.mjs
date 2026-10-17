// SPDX-License-Identifier: Apache-2.0
// INIT-028 INC-145/147: dispatch settings metadata and retirement boundary. TCRN-CROSS-STORY-484 R3
// retires the dispatch keys and the two subagent-plan keys; the tiers are models.tiers.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { validateEngineModelPolicy } from "../dist/build/packages/core/src/engine-model-policy.js";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

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
  const sourceCatalogKeys = [...catalogSource.matchAll(/(?:^ {4}|^ {2}\{ )key:\s*"([^"]+)",/gmu)].map((match) => match[1]);
  assert.deepEqual(sourceTypeKeys, [...sourceTypeKeys].sort(), "SettingKey union must be independently sorted in source");
  assert.deepEqual(sourceCatalogKeys, [...sourceCatalogKeys].sort(), "catalogEntries must be independently sorted in source");
  assert.deepEqual(sourceTypeKeys, sourceCatalogKeys, "SettingKey and catalogEntries must use the same source order");

  const catalog = await invoke(["settings-catalog", "--workspace", workspace]);
  assert.deepEqual(catalog.settings.map((entry) => entry.key), [...catalog.settings.map((entry) => entry.key)].sort());
  for (const key of ["execution.dispatchClasses", "execution.dispatchMode", "execution.dispatchModes", "execution.dispatchTiers", "execution.claudeCodeSubagentPlan", "execution.codexSubagentPlan"]) {
    assert.equal(catalog.settings.some((candidate) => candidate.key === key), false, key);
  }
  // The default tiers: both hosts, the three default categories, each host its own runner, unfilled;
  // TCRN-CROSS-STORY-508 R2 numbers them as records, category by category, codex before claude-code.
  const tiers = catalog.settings.find((entry) => entry.key === "models.tiers");
  assert.equal(tiers.type, "string");
  assert.deepEqual(JSON.parse(tiers.defaultValue), ["flagship", "main", "economy"].flatMap((category, index) => ["codex", "claude-code"].map((host, place) => ({
    order: 20 * index + 10 * (place + 1), category, runner: host, model: "", effort: "", note: "",
  }))));
  assert.equal(tiers.currentValue, tiers.defaultValue);

  const vocabulary = await invoke(["vocabulary"]);
  assert.equal(vocabulary.hostValueKind, "string");
  assert.equal(vocabulary.effortValueKind, "string");
  // TCRN-CROSS-STORY-548 AC5: vocabulary.hosts is EXECUTION_HOSTS, which names dsh as well.
  assert.deepEqual(vocabulary.hosts, ["claude-code", "codex", "dsh"]);
  assert.equal(Object.hasOwn(vocabulary, "roles"), false);
  assert.deepEqual(vocabulary.settingsEnums.map((term) => [term.key, term.valueSource]), [["agents.generation", "settings-catalog"], ["agents.sharedNavigation", "settings-catalog"], ["artifact.language", "settings-catalog"]]);
});

// The dispatch-* verbs that merged custom classes, modes and tiers are retired
// (TCRN-CROSS-STORY-467 R3), and the dispatch settings with them (TCRN-CROSS-STORY-484 R3). What
// stands: models.tiers written directly is validated, and the retired model-plan names point at
// the reads that survive.
test("S369, STORY-484 R3: legacy project model writes are refused, device policies validate tiers, and retired model-plan names point at surviving reads", async (t) => {
  const workspace = await fixture(t);
  const vocabulary = await invoke(["vocabulary"]);
  assert.equal(vocabulary.hosts.includes("gemini"), false);
  assert.equal(Object.hasOwn(vocabulary, "efforts"), false);

  const retiredClasses = await invoke(write("settings-set", workspace, 0, 1, ["--key", "execution.dispatchClasses", "--value", JSON.stringify({ "bad-class": { dispatch: true } })]));
  assert.equal(retiredClasses.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const noRunner = await invoke(write("settings-set", workspace, 0, 1, ["--key", "models.tiers", "--value", JSON.stringify([{ order: 10, category: "economy", model: "m", effort: "low", note: "" }])]));
  assert.equal(noRunner.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL", "new model policy belongs to the installed device host, even for Atelier");
  assert.throws(() => validateEngineModelPolicy("codex", {
    categories: [{ id: "economy", name: "Economy", description: "", order: 10 }],
    tiers: [{ order: 10, category: "economy", model: "m", effort: "low", note: "" }],
    escalation: { enabled: false, threshold: 2, ceiling: "economy" },
  }), error => error.reasonCode === "MODELS_TIERS_INVALID" && error.details?.path === "models.tiers[0]", "the device-policy boundary still validates the missing runner");
  const engine = await invoke(["engine-model-policy-catalog", "--host", "codex"]);
  assert.equal(engine.selectedStatus, "unconfigured", "legacy defaults do not become runtime policy");
  assert.equal((await invoke(["status", "--workspace", workspace])).version, 0);
  const retired = await invoke(["model-plan-list", "--workspace", workspace]);
  assert.equal(retired.reasonCode, "CLI_COMMAND_UNKNOWN");
  assert.match(retired.message, /settings-catalog.*vocabulary/u);
});
