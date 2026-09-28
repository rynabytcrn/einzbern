// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 R5 and AC4: verify:p1 runs every leg and reports every red with its
// own reason code, instead of stopping at the first one. The runner is proved directly
// with scripted legs, and the task entry is proved in a disposable repository through the
// EINZBERN_P1_INJECT seam, so no case here runs the real gates or touches this tree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { P1_TASKS, runAllP1Legs } from "../scripts/p1-sequence.mjs";

const productRoot = resolve(import.meta.dirname, "..");
const threeReds = { lint: "LINT_INJECTED", test: "TESTS_INJECTED", links: "LINKS_INJECTED" };
const redRows = (reds) => reds.map(({ task, reasonCode }) => ({ task, reasonCode }));

test("467-AC4: three red legs are three reds, each with its reason code, and every leg still runs", async () => {
  const ran = [];
  const outcome = await runAllP1Legs(async (task) => {
    ran.push(task);
    if (Object.hasOwn(threeReds, task)) throw Object.assign(new Error(`${task} is red`), { reasonCode: threeReds[task] });
    return { reasonCode: `${task.toUpperCase().replaceAll("-", "_")}_GREEN` };
  });
  assert.deepEqual(ran, [...P1_TASKS], "a red leg does not stop the legs after it");
  assert.equal(outcome.reasonCode, "P1_RED");
  assert.deepEqual(redRows(outcome.reds), [
    { task: "lint", reasonCode: "LINT_INJECTED" },
    { task: "test", reasonCode: "TESTS_INJECTED" },
    { task: "links", reasonCode: "LINKS_INJECTED" },
  ]);
  assert.equal(outcome.legs.length, P1_TASKS.length);
  assert.deepEqual(outcome.legs.filter((leg) => !leg.ok).map((leg) => leg.task), ["lint", "test", "links"]);
});

test("467-R5: no red leg is P1_VERIFIED, and a red without a reason code is still named", async () => {
  const green = await runAllP1Legs(async (task) => ({ reasonCode: `${task}_GREEN` }));
  assert.deepEqual([green.reasonCode, green.reds], ["P1_VERIFIED", []]);
  const unnamed = await runAllP1Legs(async (task) => {
    if (task === "build") throw new Error("no reason code");
    if (task === "privacy") return {};
    return { reasonCode: "GREEN" };
  });
  assert.equal(unnamed.reasonCode, "P1_RED");
  assert.deepEqual(redRows(unnamed.reds), [
    { task: "build", reasonCode: "P1_LEG_INTERNAL_ERROR" },
    { task: "privacy", reasonCode: "P1_LEG_REASON_MISSING" },
  ]);
});

async function p1Fixture(context) {
  // A disposable repository carrying only scripts/ and node_modules/, the shape the other
  // task-entry fixtures use; clean, so the runner's clean-basis precondition holds.
  const root = await mkdtemp(join(tmpdir(), "einzbern-p1-all-legs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve(productRoot, "scripts"), resolve(root, "scripts"), { recursive: true });
  await cp(resolve(productRoot, "node_modules"), resolve(root, "node_modules"), { recursive: true });
  await writeFile(resolve(root, "package.json"), "{\"name\":\"einzbern-p1-fixture\",\"type\":\"module\"}\n");
  await writeFile(resolve(root, ".gitignore"), "dist/\nnode_modules/\n");
  for (const argv of [
    ["init", "--quiet"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
    // This fixture adds more than Git's loose-object maintenance threshold. Keep
    // commit from detaching `git maintenance run --auto`, which can still write
    // `.git/objects` after spawnSync has returned and race the fixture's teardown.
    ["config", "maintenance.auto", "false"],
    ["config", "gc.auto", "0"],
    ["add", "package.json", ".gitignore", "scripts"],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${argv.join(" ")}\n${result.stderr}`);
  }
  return root;
}

function verifyP1(root, injection) {
  return spawnSync(process.execPath, ["scripts/task.mjs", "verify-p1"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EINZBERN_P1_INJECT: JSON.stringify(injection) },
  });
}

test("467-AC4: the verify-p1 entry prints all three reds with their reason codes and exits non-zero", async (context) => {
  const root = await p1Fixture(context);
  const injection = { ...Object.fromEntries(P1_TASKS.map((task) => [task, true])), ...threeReds };
  const run = verifyP1(root, injection);
  assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
  const receipt = JSON.parse(run.stderr.trim().split("\n").at(-1));
  assert.equal(receipt.reasonCode, "P1_RED");
  assert.deepEqual(redRows(receipt.reds), [
    { task: "lint", reasonCode: "LINT_INJECTED" },
    { task: "test", reasonCode: "TESTS_INJECTED" },
    { task: "links", reasonCode: "LINKS_INJECTED" },
  ]);
  assert.equal(receipt.legs.length, P1_TASKS.length);
  assert.deepEqual([...receipt.injected].sort(), [...P1_TASKS].sort());
});

test("an injected run never reads as P1_VERIFIED, and an unknown leg is refused", async (context) => {
  const root = await p1Fixture(context);
  const passed = verifyP1(root, Object.fromEntries(P1_TASKS.map((task) => [task, true])));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).reasonCode, "P1_VERIFIED_WITH_INJECTION");
  const unknown = verifyP1(root, { "not-a-leg": true });
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr.trim().split("\n").at(-1)).reasonCode, "P1_INJECTION_INVALID");
});
