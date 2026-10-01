// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  SETTINGS_CATALOG,
  initializeLibrary,
} from "../dist/build/packages/core/src/index.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

const instant = (second) => `2026-08-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s223-${suffix}-`)));
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

async function runError(args) {
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${args[0]} to refuse`);
}

test("S223: settings-catalog exposes the engine-owned enum values", async (t) => {
  const { workspace } = await fixture(t, "catalog");
  const readback = await runRaw(["settings-catalog", "--workspace", workspace]);
  // TCRN-CROSS-STORY-484 R3 retired backup.cadence, the enum this test read first; artifact.language
  // is the enum left.
  const language = readback.settings.find((entry) => entry.key === "artifact.language");
  assert.deepEqual(language.allowedValues, ["en", "fr", "ja", "ko", "zh-CN"]);
  assert.deepEqual(language.allowedValues, SETTINGS_CATALOG.find((entry) => entry.key === "artifact.language").allowedValues);
  assert.equal(Object.hasOwn(readback.settings.find((entry) => entry.key === "design.authority"), "allowedValues"), false);
});

test("S223: an enum refusal carries its allowed values and appends no event", async (t) => {
  const { workspace } = await fixture(t, "reject");
  const error = await runError([
    "settings-set",
    "--workspace", workspace,
    "--at", instant(1),
    "--key", "artifact.language",
    "--value", "de-DE",
    "--actor", "agent:codex",
  ]);
  assert.equal(error.reasonCode, "SETTINGS_VALUE_INVALID");
  assert.deepEqual(error.details, { allowedValues: ["en", "fr", "ja", "ko", "zh-CN"] });
  assert.match(error.message, /en, fr, ja, ko, zh-CN/u);
  const status = await runRaw(["status", "--workspace", workspace]);
  assert.equal(status.version, 0);
});
