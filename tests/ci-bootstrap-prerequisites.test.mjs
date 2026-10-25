// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { corepackBootstrapRequired } from "../scripts/ci/bootstrap-prerequisites.mjs";
import { digest, loadRules, sourceInput, validatePlan } from "../scripts/ci/impact-plan.mjs";
import { createCiComponentFixture, fixturePlan } from "./helpers/ci-component-fixture.mjs";

const releaseTest = "tests/release-lockstep.test.mjs";
const bootstrapPath = fileURLToPath(new URL("../scripts/ci/bootstrap-prerequisites.mjs", import.meta.url));
const releaseFile = { [releaseTest]: 'import test from "node:test"; test("tiny release input", () => {});\n' };

function checkoutBasis(fixture) {
  const input = sourceInput(fixture.repo, fixture.env);
  return { ...input, rulesHash: loadRules(fixture.repo).rulesHash };
}

function validatedPlan(fixture, coverage) {
  const plan = fixturePlan(fixture, coverage);
  assert.equal(plan.coverage, coverage);
  return validatePlan(plan, fixture.repo, fixture.env);
}

function redigest(plan) {
  delete plan.planDigest;
  plan.planDigest = digest(plan);
  return plan;
}

test("Corepack acquisition follows full core and selected Release consumption, while checks and Portal need none", async (t) => {
  const fixture = await createCiComponentFixture(t, { files: releaseFile, rules: { ciTests: ["tests/a.test.mjs", releaseTest] } });
  const basis = checkoutBasis(fixture);
  for (const coverage of ["full", "selective"]) {
    const plan = validatedPlan(fixture, coverage);
    assert.ok(plan.coreTests.includes(releaseTest));
    assert.equal(corepackBootstrapRequired("p1-core", plan, basis), true, coverage);
    assert.equal(corepackBootstrapRequired("p1-checks", plan, basis), false, coverage);
    if (coverage === "full") assert.equal(corepackBootstrapRequired("p1-portal", plan, basis), false);
  }
  assert.equal(corepackBootstrapRequired("p1"), true);
  assert.equal(corepackBootstrapRequired("pf2-h1"), true);
});

test("a genuine selective core roster without Release does not acquire Corepack", async (t) => {
  const fixture = await createCiComponentFixture(t, { files: releaseFile });
  const selected = validatedPlan(fixture, "selective");
  assert.ok(selected.sourceCoreTests.includes(releaseTest));
  assert.equal(selected.coreTests.includes(releaseTest), false);
  assert.equal(corepackBootstrapRequired("p1-core", selected, checkoutBasis(fixture)), false);
  assert.throws(() => corepackBootstrapRequired("p1-portal", selected, checkoutBasis(fixture)), /shard mismatch/u);
});

test("bootstrap refuses malformed envelopes, tampered rosters and mixed run/source identities", async (t) => {
  const fixture = await createCiComponentFixture(t, { files: releaseFile });
  const plan = validatedPlan(fixture, "full"), basis = checkoutBasis(fixture);
  for (const mode of [undefined, "unknown", "core", "p1-release", "__proto__"]) {
    assert.throws(() => corepackBootstrapRequired(mode, plan, basis), /Unknown bootstrap verification mode/u);
  }
  for (const malformed of [undefined, null, [], {}, { ...plan, planDigest: undefined }, { ...plan, coreTests: ["tests/a.test.mjs"] }]) {
    assert.throws(() => corepackBootstrapRequired("p1-core", malformed, basis));
  }
  const mutations = [
    (value) => { value.schemaVersion = "unknown"; },
    (value) => { value.coverage = "unknown"; },
    (value) => { value.coreTests = []; },
    (value) => { value.coreTests = "tests/a.test.mjs"; },
    (value) => { value.coreTests.reverse(); },
    (value) => { value.coreTests.push(value.coreTests[0]); },
    (value) => { value.coreTests = ["tests/not-tracked.test.mjs"]; },
    (value) => { value.coreTests = value.coreTests.filter((path) => path !== releaseTest); },
    (value) => { value.sourceCoreTests = value.sourceCoreTests.filter((path) => path !== releaseTest); value.coreTests = [...value.sourceCoreTests]; },
    (value) => { value.shards.core = []; },
    (value) => { delete value.shards.checks; },
    (value) => { value.shards.portal = ["test"]; },
    (value) => { value.shards.unknown = []; },
    ...["repository", "event", "head", "tree", "runId", "attempt", "rulesHash"].map((key) => (value) => { value[key] = `${value[key]}changed`; }),
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(plan);
    mutate(invalid);
    redigest(invalid);
    assert.throws(() => corepackBootstrapRequired("p1-core", invalid, basis), JSON.stringify(invalid));
  }
  assert.throws(() => corepackBootstrapRequired("p1-core", plan));
});

test("an acquisition envelope never replaces independent semantic plan validation", async (t) => {
  const fixture = await createCiComponentFixture(t, { files: releaseFile });
  const selected = validatedPlan(fixture, "selective");
  const forged = structuredClone(selected);
  forged.coreTests = [...forged.sourceCoreTests];
  forged.notApplicable = [];
  redigest(forged);
  assert.throws(() => validatePlan(forged, fixture.repo, fixture.env), /independently derived/u);
  const capture = readFileSync(new URL("../scripts/ci/p1-evidence.py", import.meta.url), "utf8");
  assert.match(capture, /"scripts\/ci\/impact-plan\.mjs"\), "validate", args\.plan/u);
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  assert.equal(/\b(?:validatePlan|checkConsumers|collectBaseline)\s*\(/u.test(bootstrap), false, "bootstrap must not repeat the full source/provenance audit");
});

test("real bootstrap CLI reads only consumed plans and fails closed without emitting a decision", async (t) => {
  const fixture = await createCiComponentFixture(t, { files: releaseFile });
  const planPath = join(fixture.directory, "bootstrap-plan.json");
  const run = (mode, path = planPath, env = fixture.env) => spawnSync(process.execPath, [bootstrapPath, mode, path], {
    cwd: fixture.repo, env, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  for (const coverage of ["full", "selective"]) {
    await writeFile(planPath, JSON.stringify(validatedPlan(fixture, coverage)));
    for (const mode of ["p1-core", "p1-checks", ...(coverage === "full" ? ["p1-portal"] : [])]) {
      const result = run(mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `${mode === "p1-core" && coverage === "full"}\n`);
    }
  }
  const missing = join(fixture.directory, "not-downloaded-for-h1.json");
  for (const mode of ["p1", "pf2-h1"]) {
    const result = run(mode, missing);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "true\n");
    assert.equal(result.stderr, "");
  }
  for (const result of [run("unknown"), run("p1-core", missing), run("p1-core", planPath, { ...fixture.env, GITHUB_RUN_ATTEMPT: "2" })]) {
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
  }
  await writeFile(planPath, "{malformed");
  const malformed = run("p1-core");
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, "");
  assert.equal(fixture.git("status", "--porcelain=v1"), "");
});

test("the existing online step uses the actual bootstrap decision and preserves genuine caches across private HOME", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow.match(/      - name: Acquire official pinned Corepack and its pnpm cache when consumed\n([\s\S]*?)(?=\n      # Use the same complete)/u)?.[1];
  assert.ok(step);
  assert.equal(/^        if:/mu.test(step), false, "the helper must also evaluate ordinary core consumption");
  assert.match(step, /COREPACK_ENABLE_NETWORK: "1"/u);
  assert.match(step, /COREPACK_HOME: \$\{\{ runner\.temp \}\}\/einzbern-bootstrap-/u);
  const cache = workflow.indexOf("      pnpm_config_cache_dir: ${{ runner.temp }}/einzbern-bootstrap-");
  assert.ok(cache > 0 && cache < workflow.indexOf("- name: Acquire exact dependencies explicitly"), "the online source install must create the authentic cache before any offline clone uses it");
  const run = step.slice(step.indexOf("        run: |\n") + "        run: |\n".length).split("\n").map((line) => line.slice(10)).join("\n").trim();
  assert.ok(run.startsWith('corepack_required="$(node scripts/ci/bootstrap-prerequisites.mjs "$VERIFY_MODE" "$RUNNER_TEMP/impact/impact-plan.json")"\nif [ "$corepack_required" = true ]; then\n'));
  assert.ok(run.endsWith("\nfi"));
  for (const command of [
    "npm install --global corepack@0.34.6 --force --ignore-scripts --no-audit --no-fund --no-update-notifier --prefer-online",
    'test "$(corepack --version)" = "0.34.6"',
    "corepack install --global pnpm@11.3.0",
    'test "$(corepack pnpm@11.3.0 --version)" = "11.3.0"',
  ]) assert.ok(run.includes(`\n  ${command}\n`), command);
  assert.ok(run.includes("printf 'COREPACK_HOME=%s\\npnpm_config_cache_dir=%s\\nCOREPACK_ENABLE_NETWORK=0\\n' \"$COREPACK_HOME\" \"$pnpm_config_cache_dir\" >> \"$GITHUB_ENV\""));
  assert.ok(workflow.indexOf(run.split("\n")[0].trim()) < workflow.indexOf("- name: Verify P1 offline"));
  assert.equal((workflow.match(/npm install --global corepack@/gu) ?? []).length, 1);
  assert.match(workflow, /pnpm --dir "\$root\/build" install --offline --frozen-lockfile --ignore-scripts/u);
});
