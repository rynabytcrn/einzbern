// SPDX-License-Identifier: Apache-2.0
// STORY-347/348: variable values are settings or policy data; protocol values
// that define validity remain fixed in code.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_PROVENANCE_POLICY,
  SettingsError,
  createProject,
  createWork,
  initializeLibrary,
  setWorkspaceSetting,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-02T06:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s347-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  return { base, workspace };
}

async function cli(arguments_) {
  let output = "";
  await runCli(arguments_, { write(value) { output = value; } });
  return JSON.parse(output);
}

test("STORY-347 settings catalog exposes the new keys that remain and numeric bounds", async (context) => {
  const fx = await fixture(context, "CATALOG");
  const catalog = await cli(["settings-catalog", "--workspace", fx.workspace]);
  // injection.budgetBytes retired with the session-wide injection it budgeted (TCRN-CROSS-STORY-474).
  assert.equal(catalog.settings.some((entry) => entry.key === "injection.budgetBytes"), false);
  // storage.backend retired because nothing reads it (TCRN-CROSS-STORY-484 R3).
  assert.equal(catalog.settings.some((entry) => entry.key === "storage.backend"), false);
  // knowledge.aggregateBytes retired with the knowledge total it bounded (TCRN-CROSS-SUB-310 R17, MIN-238 D1).
  assert.equal(catalog.settings.some((entry) => entry.key === "knowledge.aggregateBytes"), false);
  const expected = ["storage.segmentBytes", "storage.snapshotEveryEvents", "injection.perPromptBytes", "retrieval.scopeExcerptBytes"];
  const entries = catalog.settings.filter((entry) => expected.includes(entry.key));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [...expected].sort());
  // TCRN-CROSS-STORY-469: the key now sizes a library's stream segments, and its default is the
  // stream default of one MiB.
  assert.equal(entries.find((entry) => entry.key === "storage.segmentBytes").defaultValue, "1048576");
  assert.equal(entries.find((entry) => entry.key === "storage.snapshotEveryEvents").defaultValue, "512");
  assert.equal(entries.find((entry) => entry.key === "injection.perPromptBytes").defaultValue, "1600");
  assert.equal(entries.find((entry) => entry.key === "retrieval.scopeExcerptBytes").defaultValue, "512");
  assert.ok(entries.filter((entry) => entry.controlType === "number").every((entry) => entry.min !== undefined && entry.max !== undefined));
});

test("STORY-347 settings reject below-minimum values and retrieval setting supplies the default excerpt window", async (context) => {
  const fx = await fixture(context, "CONSUME");
  await assert.rejects(() => setWorkspaceSetting(fx.workspace, {
    key: "storage.snapshotEveryEvents", value: "0", occurredAt: instant(2),
  }), (error) => error instanceof SettingsError && error.reasonCode === "SETTINGS_VALUE_INVALID");
  let state = await setWorkspaceSetting(fx.workspace, {
    key: "retrieval.scopeExcerptBytes", value: "12", occurredAt: instant(2),
  });
  state = await createProject(fx.workspace, { externalKey: "STORY-347-PROJECT", name: "Settings", occurredAt: instant(3) });
  // A parentless record the write path still creates (a new Incident is refused since
  // TCRN-CROSS-STORY-472); the excerpt window is the point, not the kind.
  state = await createWork(fx.workspace, {
    projectId: state.projects[0].id, externalKey: "STORY-347-INITIATIVE", kind: "Initiative", parentId: null,
    scope: "【Goal】abcdefghijklmnop", occurredAt: instant(4),
  });
  const defaultWindow = await cli(["work-list", "--workspace", fx.workspace, "--search", "abc"]);
  assert.equal(Buffer.byteLength(defaultWindow.records[0].scope, "utf8"), 12);
  const overridden = await cli(["work-list", "--workspace", fx.workspace, "--search", "abc", "--scope-bytes", "4"]);
  assert.equal(Buffer.byteLength(overridden.records[0].scope, "utf8"), 4);
});

// TCRN-CROSS-SUB-310 R17 (MIN-238 D1, D5): the knowledge total setting this test once bounded by the
// canonical ceiling is retired; a write of it is refused and records nothing.
test("STORY-348 provenance policy is an external JSON source, and the retired knowledge total setting refuses a write", async (context) => {
  const policy = JSON.parse(await readFile(new URL("../scripts/policy/knowledge-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(policy, {
    schemaVersion: "tcrn.knowledge-provenance-policy.v1",
    relaxedKinds: ["fact", "decision", "summary"],
    strictKinds: ["guide", "reference"],
  });
  const fx = await fixture(context, "AGGREGATE");
  await assert.rejects(() => setWorkspaceSetting(fx.workspace, {
    key: "knowledge.aggregateBytes", value: "65536", occurredAt: instant(2),
  }), (error) => error instanceof SettingsError && error.reasonCode === "SETTINGS_KEY_UNREGISTERED");
  const catalog = await cli(["settings-catalog", "--workspace", fx.workspace]);
  assert.equal(catalog.settings.some((entry) => entry.key === "knowledge.aggregateBytes"), false, "nothing was recorded");
});

test("STORY-348 protocol validity values remain hardcoded rather than becoming settings", async (context) => {
  assert.equal(KNOWLEDGE_LIMITS.maximumBodyBytes, 8_192);
  // TCRN-CROSS-SUB-310 R17 (MIN-238 D1): no budget bounds the sum of the card bodies, so there is no ceiling to fix.
  assert.equal(Object.hasOwn(KNOWLEDGE_LIMITS, "maximumAggregateBytes"), false);
  assert.equal(PROTOCOL_LIMITS.maxCanonicalBytes, 1_048_576);
  assert.deepEqual(KNOWLEDGE_PROVENANCE_POLICY, {
    relaxedKinds: ["fact", "decision", "summary"],
    strictKinds: ["guide", "reference"],
  });
  const fx = await fixture(context, "RUNTIME-POLICY");
  const catalog = await cli(["settings-catalog", "--workspace", fx.workspace]);
  assert.equal(catalog.settings.some((entry) => entry.key === "protocol.maxCanonicalBytes"), false);
});
