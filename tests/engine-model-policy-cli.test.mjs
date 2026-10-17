// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-056 SUB-539: the formal CLI validates the Owner target before a device-only write,
// returns readback, and projects legacy setting values beside their source without rewriting them.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { createProject, initializeLibrary, materializeWorkspace, recordMinutes, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";

const at = (second) => `2026-10-17T02:03:${String(second).padStart(2, "0")}Z`;
const OWNER = "owner:governance";
const CATEGORIES = [
  { id: "flagship", name: "Flagship", description: "", order: 10 },
  { id: "main", name: "Main", description: "", order: 20 },
  { id: "economy", name: "Economy", description: "", order: 30 },
];
const policy = (model) => ({
  categories: CATEGORIES,
  tiers: [
    { order: 10, category: "flagship", runner: "codex", model, effort: "max", note: "" },
    { order: 20, category: "economy", runner: "codex", model, effort: "max", note: "" },
  ],
  escalation: { enabled: true, threshold: 2, ceiling: "main" },
});

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function failure(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error);
}

function withoutFlag(args, name) {
  const index = args.indexOf(`--${name}`);
  assert.notEqual(index, -1, `${name} is present in the fixture command`);
  return args.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
}

test("INIT-056 SUB-539: engine policy CLI requires a matching Owner decision and preserves legacy workspace values", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-engine-model-policy-cli-")));
  const previousHome = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    if (previousHome === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  });

  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const project = await createProject(workspace, { occurredAt: at(1), externalKey: "INIT056-PROJECT", name: "Legacy project" });
  const projectId = project.projects[0].id;
  const legacyCategories = JSON.stringify(CATEGORIES);
  await setWorkspaceSetting(workspace, { occurredAt: at(2), projectId, key: "models.category", value: legacyCategories });
  const decision = await recordMinutes(workspace, {
    occurredAt: at(3), projectId, externalKey: "INIT056-MINUTES", title: "Engine model policy",
    summary: "Owner authorizes models.engine-policy for this engine.",
    decisions: ["Set models.engine-policy for the Codex host."], decidedBy: [OWNER], linkedWorkIds: [],
  });
  const minutesId = decision.minutes.find((entry) => entry.externalKey === "INIT056-MINUTES").id;
  const citedDecision = `${minutesId}#D1`;
  const originalState = await materializeWorkspace(workspace);
  const originalEvents = originalState.events;
  const originalVersion = originalState.version;
  const originalHeadEventHash = originalState.headEventHash;
  const beforeCatalog = await cli(["engine-model-policy-catalog", "--host", "codex"]);
  assert.equal(beforeCatalog.selectedStatus, "unconfigured");
  const beforeSettingsCatalog = await cli(["settings-catalog", "--workspace", workspace, "--project-id", projectId]);
  const originalLegacy = beforeSettingsCatalog.modelPolicy.compatibility.legacySettings.find((entry) => entry.key === "models.category");
  assert.ok(originalLegacy, "the pre-write settings catalog reads the legacy model value");

  const write = [
    "engine-model-policy-set", "--workspace", workspace, "--host", "codex", "--policy", JSON.stringify(policy("gpt-6-luna")),
    "--at", at(4), "--actor", "agent:codex", "--decided-in", citedDecision,
  ];
  const missingActor = await failure(withoutFlag(write, "actor"));
  assert.equal(missingActor.reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal(missingActor.message, "actor", "the actual actor is independently required");
  const missingDecision = await failure(withoutFlag(write, "decided-in"));
  assert.equal(missingDecision.reasonCode, "CLI_ARGUMENT_MISSING");
  assert.equal(missingDecision.message, "decided-in", "the Owner decision is independently required");

  const wrongDecision = await failure([...write.slice(0, -1), "minutes:" + "c".repeat(24) + "#D1"]);
  assert.equal(wrongDecision.reasonCode, "MODEL_WRITE_AUTHORIZATION_INVALID");
  assert.equal(wrongDecision.details.target, "models.engine-policy");
  assert.equal((await cli(["engine-model-policy-catalog", "--host", "codex"])).selectedStatus, "unconfigured");

  const receipt = await cli(write);
  assert.equal(receipt.reasonCode, "ENGINE_MODEL_POLICY_WRITE_COMMITTED");
  assert.equal(receipt.policy.tiers[0].model, "gpt-6-luna");
  assert.equal(receipt.readback.selectedHost, "codex");
  assert.equal(receipt.readback.selectedStatus, "configured");

  const catalog = await cli(["settings-catalog", "--workspace", workspace, "--project-id", projectId]);
  assert.equal(catalog.modelPolicy.source.kind, "device-engine");
  assert.equal(catalog.modelPolicy.compatibility.projectOverrideAllowed, false);
  const legacy = catalog.modelPolicy.compatibility.legacySettings.find((entry) => entry.key === "models.category");
  assert.deepEqual(legacy, originalLegacy, "the engine policy write leaves the real legacy settings readback unchanged");
  assert.equal(legacy.source.projectId, projectId);

  const finalState = await materializeWorkspace(workspace);
  assert.equal(finalState.version, originalVersion, "device model policy writes leave the project event version unchanged");
  assert.equal(finalState.headEventHash, originalHeadEventHash, "device model policy writes append no project event");
  assert.deepEqual(finalState.events, originalEvents, "device model policy writes preserve all existing events");
  assert.equal(finalState.settings.find((entry) => entry.key === "models.category").value,
    originalState.settings.find((entry) => entry.key === "models.category").value,
    "device model policy writes leave the stored legacy setting unchanged");
});
