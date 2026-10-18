// SPDX-License-Identifier: Apache-2.0
// Sequential disposable receipt fixtures: malformed cache records are not gate evidence.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertDoneGates } from "../dist/build/packages/core/src/gates-done.js";
import { gateDeclarationsDigest } from "../dist/build/packages/core/src/gates-plan.js";
import { gateRunsDirectory, gateTreeState, latestGateRun } from "../dist/build/packages/core/src/gates-run.js";

const libraryId = `workspace:${"a".repeat(24)}`;
const storyId = `work:${"b".repeat(24)}`;

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-gate-validation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const deviceHome = join(root, "device");
  await mkdir(projectRoot);
  const gates = [false, true].map((releaseOnly) => ({ name: releaseOnly ? "release" : "ordinary", command: ["node", "--version"], root: ".", covers: ["**"], required: true, enabled: true, releaseOnly }));
  const library = { metadata: { workspaceId: libraryId }, work: [{ id: storyId, kind: "Story", parentId: null, tombstone: false, extensions: {} }], configRecords: gates.map(({ name, ...value }) => ({ collection: "gate", key: name, value })) };
  const run = {
    schemaVersion: "einzbern.gate-run.v1", runId: "synthetic-release", libraryId,
    at: "2026-10-18T00:00:00Z", release: true, base: null, workIds: [storyId],
    declarationsDigest: gateDeclarationsDigest(gates), ...await gateTreeState(projectRoot, ["."]),
    gates: gates.map((gate) => ({ name: gate.name, root: ".", required: true, matched: [], matchedWorkIds: [storyId], ok: !gate.releaseOnly, exitCode: gate.releaseOnly ? 1 : 0, signal: null, timedOut: false, outputFile: `${gate.name}.log`, outputBytes: 0, truncated: false })),
    reds: ["release"],
  };
  const directory = gateRunsDirectory(libraryId, deviceHome);
  await mkdir(directory, { recursive: true });
  const save = (value) => writeFile(join(directory, "receipt.json"), JSON.stringify(value));
  await save(run);
  return { run, save, latest: () => latestGateRun({ libraryId, deviceHome }), done: () => assertDoneGates({ library, projectRoot, deviceHome, workIds: [storyId] }) };
}

test("malformed release flags cannot turn a red release run into ordinary done evidence", async (context) => {
  const { run, save, latest, done } = await fixture(context);
  await assert.rejects(done, { reasonCode: "WORK_DONE_GATES_RED" });
  for (const release of [undefined, null, 0, "false", {}, []]) {
    await save({ ...run, release });
    await assert.rejects(done, { reasonCode: "WORK_DONE_GATES_NOT_RUN" }, `malformed release ${JSON.stringify(release)} cannot admit done`);
    assert.equal(await latest(), null, `malformed release ${JSON.stringify(release)} must be skipped`);
  }
  await save({ ...run, release: false });
  assert.equal((await done()).reason, "green", "a genuine ordinary run still excludes release-only gates");
});

test("gate receipt readers check required field shapes while preserving historical absent timing", async (context) => {
  const { run, save, latest } = await fixture(context);
  assert.equal((await latest()).runId, run.runId);
  const mutations = [
    ["base", undefined], ["base", 7], ["reds", undefined], ["reds", [null]],
  ].map(([key, value]) => ({ label: key, value: { ...run, [key]: value } }));
  for (const [key, value] of [["root", undefined], ["exitCode", undefined], ["exitCode", "0"], ["signal", undefined], ["signal", false], ["timedOut", undefined], ["outputFile", undefined], ["outputBytes", undefined], ["outputBytes", "0"], ["truncated", undefined]]) {
    mutations.push({ label: `gate.${key}`, value: { ...run, gates: [{ ...run.gates[0], [key]: value }, run.gates[1]] } });
  }
  for (const mutation of mutations) {
    await save(mutation.value);
    assert.equal(await latest(), null, `malformed ${mutation.label} must be skipped`);
  }
  await save(run);
  assert.equal((await latest()).runId, run.runId, "historical receipts need no per-gate timing fields");
});
