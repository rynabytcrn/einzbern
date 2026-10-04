// SPDX-License-Identifier: Apache-2.0
// INIT-027 S239: the orchestration settings are closed and semantic. TCRN-CROSS-STORY-484 R5 keeps
// execution.maxConcurrentSubagents (MIN-229 D2) and retires execution.maxDispatchDepth, which nothing reads.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary } from "../dist/build/packages/core/src/index.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

const instant = (second) => new Date(Date.UTC(2026, 0, 2) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");

async function json(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args[0]} to refuse`);
}

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s239-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

test("S239: defaults, closed enum, and bounded numeric strings are catalog-backed", async (t) => {
  const { workspace, version } = await fixture(t);
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  const entries = new Map(catalog.settings.map((entry) => [entry.key, entry]));
  assert.deepEqual(entries.get("execution.maxConcurrentSubagents"), {
    key: "execution.maxConcurrentSubagents", type: "string", controlType: "number", layer: "project", defaultValue: "8", currentValue: "8", modelWritable: false, scope: "project", source: { kind: "default", projectId: null, projectName: null, inherited: false }, inheritedValue: "8", inheritedSource: { kind: "default", projectId: null, projectName: null, inherited: false }, declaredValue: null, min: 1, shape: "scalar", group: "execution", order: 1,
  });
  assert.equal(entries.has("execution.maxDispatchDepth"), false);
  assert.equal(entries.has("execution.personalessDispatch"), false);

  for (const [index, value] of ["1", "65", String(Number.MAX_SAFE_INTEGER)].entries()) {
    const before = await version();
    const written = await json(["settings-set", "--workspace", workspace, "--at", instant(index + 1),
      "--key", "execution.maxConcurrentSubagents", "--value", value, "--actor", "agent:test"]);
    assert.equal(written.setting.value, value);
    assert.equal(await version(), before + 1);
    const current = (await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.maxConcurrentSubagents");
    assert.equal(current.currentValue, value, "the shipped read consumer retains every permitted safe value");
    assert.equal(Object.hasOwn(current, "max"), false, "the catalog does not invent an admission ceiling");
  }
});

test("S239: semantic refusals identify the setting and leave the head unchanged", async (t) => {
  const { workspace, version } = await fixture(t);
  const cases = [
    ["execution.maxConcurrentSubagents", "0", /1 to 9007199254740991/u, "SETTINGS_VALUE_INVALID"],
    ["execution.maxConcurrentSubagents", "9007199254740992", /1 to 9007199254740991/u, "SETTINGS_VALUE_INVALID"],
    ["execution.maxConcurrentSubagents", "1.0", /1 to 9007199254740991/u, "SETTINGS_VALUE_INVALID"],
    ["execution.maxDispatchDepth", "4", /maxDispatchDepth/u, "SETTINGS_KEY_UNREGISTERED"],
    ["execution.personalessDispatch", "unknown", /personalessDispatch/u, "SETTINGS_KEY_UNREGISTERED"],
  ];
  for (const [key, value, message, reasonCode] of cases) {
    const stable = await version();
    const error = await refusal(["settings-set", "--workspace", workspace, "--at", instant(10),
      "--key", key, "--value", value, "--actor", "agent:test"]);
    assert.equal(error.reasonCode, reasonCode, `${key}=${value}`);
    assert.match(error.message, message);
    assert.equal(await version(), stable);
  }
});
