// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

// Fork dispatch, pull requests and main scan identical full reachable history.
const P1_STEP = /- name: Verify P1 offline\n        env:\n          EINZBERN_PRIVACY_HISTORY_BASE: ""\n        run: \|/u;

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

// BL-52: declarations in .npmrc alone do not configure pnpm 11.
test("pinned pnpm resolves the repository offline and lifecycle policy from workspace YAML", () => {
  for (const key of ["offline", "preferOffline", "frozenLockfile", "ignoreScripts", "saveExact", "strictPeerDependencies"]) {
    const result = spawnSync("pnpm", ["config", "get", key], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, `${key}: ${result.stderr || result.error || "pnpm failed"}`);
    assert.equal(result.stdout.trim(), "true", `${key} must be effective, not just declared`);
  }
});

test("release smoke verifies installed setup and doctor, not only unpacked CLI startup", async () => {
  const workflow = await readWorkflow();
  for (const expected of ["INSTALL_ENGINE_READY", "SETUP_PLAN_READY", "SETUP_APPLIED", "DOCTOR_READY", "doctor.checks.length, 8"]) {
    assert.ok(workflow.includes(expected), expected);
  }
  assert.ok(workflow.includes('node "$installed" setup --mode fresh'));
  assert.ok(workflow.includes('node "$installed" doctor --project'));
});

test("CI retains each P1 shard in an independent clone and always uploads its evidence", async () => {
  const workflow = await readWorkflow();
  assert.equal((workflow.match(/python3 "\$root\/build\/scripts\/ci\/p1-evidence\.py"/gu) ?? []).length, 1);
  assert.equal((workflow.match(/run: pnpm verify:p1/gu) ?? []).length, 0);
  assert.match(workflow, /git clone --no-hardlinks --no-checkout/u);
  assert.match(workflow, /pnpm --dir "\$root\/build" install --offline --frozen-lockfile --ignore-scripts/u);
  assert.match(workflow, /--tmp "\$root\/tmp" --device "\$root\/device"/u);
  assert.match(workflow, /- name: Retain complete P1 evidence even on failure\n        if: always\(\)/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 14/u);
  assert.match(workflow, /overwrite: false/u);
  assert.equal((workflow.match(/working-directory: \$\{\{ runner.temp \}\}\/einzbern-p1-/gu) ?? []).length, 1);
  assert.match(workflow, /EINZBERN_PRIVACY_HISTORY_BASE: ""/u);
  assert.equal(workflow.includes("github.event.pull_request.base.sha"), false, "PR privacy must not silently narrow the history compared with fork/main");
  assert.ok(workflow.includes('node "$build_root/skill/mana-orchestrate/scripts/install.mjs"'));
});

test("manual H1 is bounded, bootstraps official Corepack, and does not append P1 or smoke", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      mode:/u);
  assert.match(workflow, /options:\n          - p1\n          - pf2-h1/u);
  assert.ok(workflow.includes("VERIFY_MODE: ${{ github.event_name == 'workflow_dispatch' && inputs.mode || 'p1' }}"));
  assert.match(workflow, /corepack@0\.34\.6 --force --ignore-scripts --no-audit --no-fund/u);
  assert.match(workflow, /corepack install --global pnpm@11\.3\.0/u);
  assert.ok(workflow.indexOf('corepack install --global pnpm@11.3.0') < workflow.indexOf('--mode "$VERIFY_MODE"'));
  assert.equal((workflow.match(/--mode "\$VERIFY_MODE"/gu) ?? []).length, 2);
  assert.match(workflow, /Smoke the release archive unpacked without node_modules\n        if: env\.VERIFY_MODE == 'p1-checks'/u);
  assert.equal(workflow.includes("\n  lessons:"), false, "S6 remains in the core test roster without a duplicate job");
});

test("ordinary smoke retains curated archive, digest manifest, source SHA and isolated install receipts", async () => {
  const workflow = await readWorkflow();
  assert.ok(workflow.includes('git rev-parse HEAD > "$smoke/evidence/source-head.txt"'));
  assert.ok(workflow.includes('cp "$archive" "$archive.sha256" "$smoke/evidence/"'));
  assert.ok(workflow.includes('cp "$smoke/unpacked/einzbern-$version/manifest.json" "$smoke/evidence/manifest.json"'));
  assert.ok(workflow.includes('cd "$smoke/evidence"'));
  assert.match(workflow, /Retain curated package and isolated install evidence\n        if: always\(\) && env\.VERIFY_MODE == 'p1-checks'/u);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/einzbern-release-smoke\/evidence\//u);
});


test("required verify waits for all shards and refuses incomplete same-SHA evidence", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /fail-fast: false/u);
  for (const shard of ["p1-checks", "p1-core", "p1-portal"]) assert.ok(workflow.includes(`"${shard}"`));
  assert.match(workflow, /  verify:\n    if: always\(\)\n    needs: \[p1\]/u);
  assert.ok(workflow.includes("JOB_RESULT: ${{ needs.p1.result }}"));
  assert.ok(workflow.includes("--attempt \"$GITHUB_RUN_ATTEMPT\" --job-result \"$JOB_RESULT\""));
  assert.ok(workflow.includes("scripts/ci/aggregate-evidence.py"));
});
