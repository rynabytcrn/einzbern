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

// The dispatch-* verbs are retired (TCRN-CROSS-STORY-467 R3); the selected mode is an
// ordinary setting, read back through the settings catalog.
const dispatchMode = async (workspace) => (await json(["settings-catalog", "--workspace", workspace])).settings.find((entry) => entry.key === "execution.dispatchMode").currentValue;

test("S369: selected dispatch mode resets through ordinary settings removal", async (t) => {
  const { workspace } = await fixture(t, "mode-clear");
  const changed = await json(write("settings-set", workspace, 1, ["--key", "execution.dispatchMode", "--value", "eco"]));
  assert.equal(changed.version, 1);
  assert.equal(await dispatchMode(workspace), "eco");
  const cleared = await json(write("settings-remove", workspace, 2, ["--key", "execution.dispatchMode"]));
  assert.equal(cleared.version, 2);
  assert.equal(await dispatchMode(workspace), "frontier");
});

test("S233: the two policy keys are in the catalog with their closed value sets", async (t) => {
  const { workspace } = await fixture(t, "policy-keys-remediation");
  const catalog = await json(["settings-catalog", "--workspace", workspace]);
  const policy = catalog.settings.find((entry) => entry.key === "execution.subagentPolicy");
  assert.deepEqual(policy.allowedValues, ["allowed", "review-only", "forbidden"]);
  assert.equal(policy.defaultValue, "allowed");
  assert.equal(policy.currentValue, "allowed");
  const floor = catalog.settings.find((entry) => entry.key === "execution.independenceFloor");
  assert.deepEqual(floor.allowedValues, ["none", "verification", "verification-and-risk", "all"]);
  assert.equal(floor.defaultValue, "none");
  const bad = await refusal(write("settings-set", workspace, 1, ["--key", "execution.subagentPolicy", "--value", "not-a-policy"]));
  assert.equal(bad.reasonCode, "SETTINGS_VALUE_INVALID");
});

async function conferenceFixture(context, suffix, floor) {
  const { workspace } = await fixture(context, suffix);
  if (floor !== null) await json(write("settings-set", workspace, 1, ["--key", "execution.independenceFloor", "--value", floor]));
  const project = (await json(write("project-create", workspace, 2, ["--external-key", `S234-REMED-${suffix}`, "--name", "s234-remediation"]))).record.id;
  const anchor = (await json(write("work-create", workspace, 3, ["--project-id", project, "--external-key", `S234-REMED-INIT-${suffix}`, "--kind", "Initiative", "--title", "s234-remediation-anchor"]))).record.id;
  const opened = await json(write("conference-open", workspace, 4, ["--external-key", `S234-REMED-CONF-${suffix}`, "--project-id", project, "--type", "verification", "--title", "acceptance", "--work-ids", anchor, "--desired-outcome", "recommendation", "--participant-ids", "agent:test"]));
  return { workspace, conferenceId: opened.recordId ?? opened.record.id };
}

const closeArguments = (workspace, conferenceId, extra = []) => [
  "conference-close", "--workspace", workspace, "--at", instant(9), "--conference-id", conferenceId,
  "--minutes-external-key", "S234-REMED-MIN", "--summary", "s", "--outcome-class", "recommendation", "--decisions", "d", "--unresolved-issues", "-", "--actor", "agent:test", ...extra,
];

test("S234: a covered close without the declaration refuses; with it, the minutes carry the form", async (t) => {
  const { workspace, conferenceId } = await conferenceFixture(t, "floor-remediation", "verification");
  const missing = await refusal(closeArguments(workspace, conferenceId));
  assert.equal(missing.reasonCode, "CONFERENCE_INDEPENDENCE_REQUIRED");
  const wrong = await refusal(closeArguments(workspace, conferenceId, ["--execution-form", "single-context"]));
  assert.equal(wrong.reasonCode, "CONFERENCE_INDEPENDENCE_REQUIRED");
  assert.match(wrong.message, /verification/u);
  const closed = await json(closeArguments(workspace, conferenceId, ["--execution-form", "independent"]));
  assert.equal(closed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  const minutes = await json(["conference-minutes-list", "--workspace", workspace, "--limit", "5"]);
  const record = (minutes.records ?? minutes.minutes ?? []).find((entry) => entry.conferenceId === conferenceId);
  assert.deepEqual(record.extensions["conference:execution-form"], { required: false, value: "independent" });
});

test("S234: with the floor at its default, a close without the flag behaves exactly as before", async (t) => {
  const { workspace, conferenceId } = await conferenceFixture(t, "nofloor-remediation", null);
  const closed = await json(closeArguments(workspace, conferenceId));
  assert.equal(closed.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal((await json(["conference-minutes-list", "--workspace", workspace, "--limit", "5"])).records.length > 0, true);
});
