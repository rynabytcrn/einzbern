// SPDX-License-Identifier: Apache-2.0
// INIT-028 S244/S245: dispatch settings, historical model-plan replay, and retired writes.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary, validateWorkspace } from "../dist/build/packages/core/src/index.js";
import { setModelPlanInWorkspace } from "../dist/build/packages/core/src/workspace.js";
import { appendHistoricalConferenceClose, appendHistoricalConferenceOpen } from "./helpers/workspace-fixture.mjs";

const instant = (second) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");

async function json(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try { await runCli(args, { write() {} }); } catch (error) { return error; }
  assert.fail(`expected ${args[0]} to refuse`);
}

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s244-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  const workspace = join(base, "workspace");
  const version = async () => (await json(["status", "--workspace", workspace])).version;
  return { workspace, version };
}

const write = (command, workspace, at, args) => [command, "--workspace", workspace, "--at", instant(at), ...args, "--actor", "agent:test"];

test("S369: retired model-plan CLI names refuse while historical records remain readable", async (t) => {
  const { workspace, version } = await fixture(t, "retirement");
  for (const command of ["model-plan-assign", "model-plan-list", "model-plan-remove", "model-plan-set", "model-plan-unassign"]) {
    const error = await refusal([command]);
    assert.equal(error.reasonCode, "CLI_COMMAND_UNKNOWN");
    const withLegacyFlags = await refusal([command, "--workspace", workspace, "--at", instant(1), "--host", "codex", "--name", "legacy", "--default-model", "model"]);
    assert.equal(withLegacyFlags.reasonCode, "CLI_COMMAND_UNKNOWN");
  }
  const retiredPersonaList = await refusal(["persona-list", "--workspace", workspace]);
  assert.equal(retiredPersonaList.reasonCode, "CLI_COMMAND_UNKNOWN");
  assert.equal(await version(), 0);

  // The write verbs are retired, but old model-plan envelopes remain part of the
  // replay contract. Construct one through the test-only historical fixture path and
  // prove that materialization still returns the exact record after a fresh replay.
  let historical = await setModelPlanInWorkspace(workspace, {
    occurredAt: instant(2),
    actorId: "agent:test",
    host: "claude-code",
    name: "legacy-budget",
    defaultModel: "claude-sonnet-4-5",
  });
  const replayed = await validateWorkspace(workspace);
  assert.deepEqual(replayed.executionConfig.modelPlans, historical.executionConfig.modelPlans);
  assert.deepEqual(replayed.executionConfig.modelPlans[0], {
    schemaVersion: "tcrn.model-plan.v1",
    host: "claude-code",
    name: "legacy-budget",
    defaultModel: "claude-sonnet-4-5",
    assignments: {},
    revision: 1,
    updatedAt: instant(2),
    tombstone: false,
  });
});

// The dispatch-* verbs are retired (TCRN-CROSS-STORY-467 R3), and the dispatch mode setting with
// dispatch modes (TCRN-CROSS-STORY-484 R3): the catalog no longer lists it, and a write is refused.
test("484-AC4: the selected dispatch mode is a retired setting", async (t) => {
  const { workspace, version } = await fixture(t, "mode-clear");
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  assert.equal(catalog.settings.some((entry) => entry.key === "execution.dispatchMode"), false);
  const refused = await refusal(write("settings-set", workspace, 1, ["--key", "execution.dispatchMode", "--value", "eco"]));
  assert.equal(refused.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  assert.equal(await version(), 0);
});

test("S233, STORY-475 R3, STORY-484 R3: the subagent policy and the independence floor are retired settings", async (t) => {
  const { workspace, version } = await fixture(t, "policy-keys-remediation");
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  for (const key of ["execution.subagentPolicy", "execution.independenceFloor"]) {
    assert.equal(catalog.settings.some((entry) => entry.key === key), false, key);
  }
  const policy = await refusal(write("settings-set", workspace, 1, ["--key", "execution.subagentPolicy", "--value", "forbidden"]));
  assert.equal(policy.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  const retired = await refusal(write("settings-set", workspace, 1, ["--key", "execution.independenceFloor", "--value", "verification"]));
  assert.equal(retired.reasonCode, "SETTINGS_KEY_UNREGISTERED");
  assert.equal(await version(), 0);
});

// S234 made a close covered by execution.independenceFloor declare an independent execution
// form. The close verb, the flag and the floor are retired (TCRN-CROSS-STORY-475 R3); a minutes
// record a close wrote with the declaration keeps it, and replays.
test("S234 retired: historical minutes keep the execution form their close declared", async (t) => {
  const { workspace } = await fixture(t, "floor-history");
  const project = (await json(write("project-create", workspace, 2, ["--external-key", "S234-HISTORY", "--name", "s234-history"]))).record.id;
  const anchor = (await json(write("work-create", workspace, 3, ["--project-id", project, "--external-key", "S234-HISTORY-INIT", "--kind", "Initiative", "--title", "s234-history-anchor"]))).record.id;
  const opened = await appendHistoricalConferenceOpen(workspace, {
    occurredAt: instant(4), externalKey: "S234-HISTORY-CONF", projectId: project, type: "verification", title: "acceptance",
    linkedWorkIds: [anchor], desiredOutcome: "recommendation", participantIds: ["agent:test"], actorId: "agent:test",
  });
  const conferenceId = opened.conferences[0].id;
  await appendHistoricalConferenceClose(workspace, {
    occurredAt: instant(5), conferenceId, minutesExternalKey: "S234-HISTORY-MIN", summary: "s", outcomeClass: "recommendation",
    decisions: ["d"], unresolvedIssues: [], executionForm: "independent", actorId: "agent:test",
  });
  const state = await validateWorkspace(workspace);
  assert.deepEqual(state.library.rejectedEvents, []);
  const record = state.conferenceMinutes.find((entry) => entry.conferenceId === conferenceId);
  assert.deepEqual(record.extensions["conference:execution-form"], { required: false, value: "independent" });
  const closeRefused = await refusal(["conference-close", "--workspace", workspace, "--at", instant(6), "--conference-id", conferenceId]);
  assert.equal(closeRefused.reasonCode, "CLI_COMMAND_UNKNOWN");
});
