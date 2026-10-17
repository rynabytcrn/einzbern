// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function readWorkflow() {
  return readFile(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
}

test("CI acquires pinned pnpm online only after pinned Node and verifies it before dependencies", async () => {
  const workflow = await readWorkflow();
  const node = workflow.indexOf("uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
  const bootstrap = workflow.indexOf("- name: Acquire exact pnpm under explicit online bootstrap policy");
  const version = workflow.indexOf("- name: Verify acquired pnpm version");
  const dependencies = workflow.indexOf("- name: Acquire exact dependencies explicitly");
  assert.ok(node >= 0 && bootstrap > node && version > bootstrap && dependencies > version);
  assert.equal(workflow.includes("pnpm/action-setup"), false);
  assert.match(workflow, /npm_config_offline: "false"/u);
  assert.match(workflow, /npm_config_prefer_offline: "false"/u);
  assert.match(workflow, /npm install --global pnpm@11\.3\.0 --ignore-scripts --no-audit --no-fund --no-update-notifier --prefer-online/u);
  assert.match(workflow, /test "\$\(pnpm --version\)" = "11\.3\.0"/u);
});

test("CI retains explicit safe dependency acquisition and offline P1 execution", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts --config\.offline=false/u);
  assert.match(workflow, P1_STEP);
});

// TCRN-CROSS-MIN-280 D3: the P1 step names the pull request's base for the privacy increment.
// The expression is empty on push and workflow_dispatch, where the full history is scanned.
const P1_STEP = /- name: Verify P1 offline\n        env:\n          EINZBERN_PRIVACY_HISTORY_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n        run: pnpm verify:p1/u;

// TCRN-CROSS-STORY-359. The `ci` verb and its `verify:ci` name retired with the rest of
// the ticket-numbered and subset gates, but three of its assertions had no second home:
// minimal workflow permissions, the pull_request_target ban, and the portal remediation
// step. They are relocated verbatim rather than dropped -- `pnpm test` runs this file and
// is on the P1 roster, so the checks kept their position in the train.
// TCRN-CROSS-MIN-280 D1: the portal remediation train runs once, as the `portal` leg of
// `pnpm verify:p1`; the workflow no longer runs `pnpm verify:portal` as a second step.
test("CI keeps minimal permissions, refuses pull_request_target, and runs the portal remediation train once, inside P1", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.equal(workflow.includes("pull_request_target"), false);
  assert.match(workflow, P1_STEP);
  assert.equal(workflow.includes("run: pnpm verify:portal"), false, "the train is not run a second time");
  const { P1_SEQUENCE } = await import("../scripts/p1-sequence.mjs");
  const tasks = P1_SEQUENCE.map((entry) => entry.task);
  assert.deepEqual(P1_SEQUENCE.find((entry) => entry.task === "portal")?.script, "verify:portal");
  assert.ok(tasks.indexOf("portal") > tasks.indexOf("test"), "the train runs after the engine suite");
});

test("pull-request CI scans the contributor head, not GitHub's synthetic merge commit", async () => {
  const workflow = await readWorkflow();
  assert.ok(
    workflow.includes("ref: ${{ github.event.pull_request.head.sha || github.sha }}"),
    "checkout must select the PR head SHA and fall back to the pushed SHA",
  );
});

// The literal SHA above locates the step and pins the reviewed version. It does not, on
// its own, say that pinning is the rule -- swap every `uses:` to a moving tag and the
// ordering assertions still hold, because a tag has an index too. That is the property
// worth stating separately: an action referenced by tag is repointable by whoever controls
// the tag, which is the supply-chain hole SHA pinning exists to close. Stated over every
// step so a step added later cannot quietly arrive unpinned.
test("every CI action is pinned to a commit SHA, never to a movable tag", async () => {
  const workflow = await readWorkflow();
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map((match) => match[1]);
  assert.ok(uses.length > 0, "the workflow must reference at least one action");
  for (const reference of uses) {
    const [name, ref] = reference.split("@");
    assert.ok(ref !== undefined, `${name} must carry an explicit ref`);
    assert.match(ref, /^[0-9a-f]{40}$/u, `${name} must be pinned to a 40-character commit SHA, got ${ref}`);
  }
});
