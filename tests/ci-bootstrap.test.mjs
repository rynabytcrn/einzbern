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

test("CI retains explicit safe dependency acquisition and offline light execution", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts --config\.offline=false/u);
  assert.match(workflow, P1_STEP);
});

// Fork dispatch, pull requests and main scan identical full reachable history.
const P1_STEP = /- name: Verify fixed light profile offline\n        env:\n          EINZBERN_PRIVACY_HISTORY_BASE: ""\n        run: \|/u;

// TCRN-CROSS-STORY-359. The `ci` verb and its `verify:ci` name retired with the rest of
// the ticket-numbered and subset gates, but three of its assertions had no second home:
// minimal workflow permissions, the pull_request_target ban, and the portal remediation
// step. Their safety properties remain checked here; the full Portal train now runs
// through the unchanged local P1 entry, not the bounded hosted light profile.
// TCRN-CROSS-MIN-280 D1: the portal remediation train runs once, as the `portal` leg of
// `pnpm verify:p1`; the workflow no longer runs `pnpm verify:portal` as a second step.
test("CI keeps minimal permissions and leaves the full Portal train in the preserved local P1 entry", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read$/mu);
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
  const workflow = [await readWorkflow(), await readFile(resolve(process.cwd(), "scripts/templates/helper/ci.yml"), "utf8")].join("\n");
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

test("CI retains the light profile in an independent clone and always uploads its evidence", async () => {
  const workflow = await readWorkflow();
  assert.equal((workflow.match(/python3 "\$root\/build\/scripts\/ci\/p1-evidence\.py"/gu) ?? []).length, 1);
  assert.equal((workflow.match(/run: pnpm verify:p1/gu) ?? []).length, 0);
  assert.match(workflow, /git clone --no-hardlinks --no-checkout/u);
  assert.match(workflow, /pnpm --dir "\$root\/build" install --offline --frozen-lockfile --ignore-scripts/u);
  assert.match(workflow, /--tmp "\$root\/tmp" --device "\$root\/device"/u);
  assert.match(workflow, /- name: Retain complete light evidence even on failure\n        if: always\(\)/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 14/u);
  assert.match(workflow, /overwrite: false/u);
  assert.equal((workflow.match(/working-directory: \$\{\{ runner.temp \}\}\/einzbern-light-/gu) ?? []).length, 1);
  assert.match(workflow, /EINZBERN_PRIVACY_HISTORY_BASE: ""/u);
  assert.match(workflow, /EINZBERN_PRIVACY_HISTORY_BASE: ""/u, "privacy must retain full history");
  assert.equal(/EINZBERN_PRIVACY_HISTORY_BASE:.*base\.sha/u.test(workflow), false, "impact base must never narrow privacy");
  assert.ok(workflow.includes('node "$build_root/skill/mana-orchestrate/scripts/install.mjs"'));
});

test("hosted manual dispatch is light only while full P1 and H1 wrapper entrypoints remain explicit", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /inputs:|VERIFY_MODE:|corepack install|pf2-h1/u);
  assert.match(workflow, /--mode ci-light/u);
  assert.equal(workflow.includes("\n  lessons:"), false);
  const wrapper = await readFile(resolve(process.cwd(), "scripts/ci/p1-evidence.py"), "utf8");
  assert.match(wrapper, /"p1", "pf2-h1", "p1-checks", "p1-core", "p1-portal", "ci-light"/u);
  assert.match(wrapper, /corepack/u, "local H1's official Corepack dispatch is not deleted");
  const pkg = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8"));
  assert.ok(pkg.scripts["verify:p1"]);
  assert.ok(pkg.scripts["verify:portal"]);
});

test("ordinary smoke retains curated archive, digest manifest, source SHA and isolated install receipts", async () => {
  const workflow = await readWorkflow();
  assert.ok(workflow.includes('git rev-parse HEAD > "$smoke/evidence/source-head.txt"'));
  assert.ok(workflow.includes('cp "$archive" "$archive.sha256" "$smoke/evidence/"'));
  assert.ok(workflow.includes('cp "$smoke/unpacked/einzbern-$version/manifest.json" "$smoke/evidence/manifest.json"'));
  assert.ok(workflow.includes('cd "$smoke/evidence"'));
  assert.match(workflow, /Retain curated package and isolated install evidence\n        if: always\(\)/u);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/einzbern-release-smoke\/evidence\//u);
});


test("required verify waits for light and independently rereads same-SHA evidence", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /  verify:\n    if: always\(\)\n    needs: \[ci-light\]/u);
  assert.ok(workflow.includes("JOB_RESULT: ${{ needs.ci-light.result }}"));
  assert.ok(workflow.includes('--attempt "$GITHUB_RUN_ATTEMPT" --job-result "$JOB_RESULT"'));
  assert.ok(workflow.includes("scripts/ci/aggregate-evidence.py"));
  assert.match(workflow, /--mode ci-light/u);
  assert.match(workflow, /fetch-depth: 0/u);
});

test("routine light execution cannot dynamically omit checks using impact or baseline evidence", async () => {
  const workflow = await readWorkflow();
  assert.doesNotMatch(workflow, /impact-plan\.mjs|fromJSON\(needs\.plan|PLAN_RESULT:|EINZBERN_CI_BASELINE_ONLINE|GH_TOKEN:/u);
  assert.doesNotMatch(workflow, /^  plan:|^  p1:|strategy:|matrix:/mu);
  assert.match(workflow, /EINZBERN_PRIVACY_HISTORY_BASE: ""/u);
  assert.match(workflow, /Seal current package smoke bytes/u);
  assert.match(workflow, /rosterDigest: meta\.finalLightReceipt\.rosterDigest/u);
  assert.match(workflow, /tree: meta\.input\.tree/u);
});
