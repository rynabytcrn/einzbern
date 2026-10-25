// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

test("the existing online step uses the actual bootstrap decision and preserves genuine caches across private HOME", async (t) => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const jobEnvironment = workflow.match(/^  p1:\n[\s\S]*?^    env:\n([\s\S]*?)(?=^    steps:)/mu)?.[1];
  assert.ok(jobEnvironment);
  assert.doesNotMatch(jobEnvironment, /\$\{\{[^}]*\brunner\b/u, "runner is unavailable in jobs.p1.env; resolve the cache inside an existing step");
  const installStep = workflow.match(/      - name: Acquire exact dependencies explicitly\n([\s\S]*?)(?=\n      - name:)/u)?.[1];
  assert.ok(installStep);
  assert.equal(/^        if:/mu.test(installStep), false, "every verification mode must initialize its cache before installing source dependencies");
  const stepRun = (body) => {
    const marker = "        run: |\n";
    assert.ok(body.includes(marker));
    return body.slice(body.indexOf(marker) + marker.length).split("\n").map((line) => line.slice(10)).join("\n").trim();
  };
  const installRun = stepRun(installStep);
  const step = workflow.match(/      - name: Acquire official pinned Corepack and its pnpm cache when consumed\n([\s\S]*?)(?=\n      # Use the same complete)/u)?.[1];
  assert.ok(step);
  assert.equal(/^        if:/mu.test(step), false, "the helper must also evaluate ordinary core consumption");
  assert.match(step, /COREPACK_ENABLE_NETWORK: "1"/u);
  assert.match(step, /COREPACK_HOME: \$\{\{ runner\.temp \}\}\/einzbern-bootstrap-/u);
  assert.doesNotMatch(step.slice(0, step.indexOf("        run: |\n")), /^\s+pnpm_config_cache_dir:/mu, "Corepack preparation must inherit the cache initialized by the source install");
  const installPosition = workflow.indexOf("- name: Acquire exact dependencies explicitly");
  assert.ok(installPosition > 0 && installPosition < workflow.indexOf("- name: Acquire official pinned Corepack and its pnpm cache when consumed"));
  const run = stepRun(step);
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
  const offlineStep = workflow.match(/      - name: Verify P1 offline\n([\s\S]*?)(?=\n      - name:)/u)?.[1];
  assert.ok(offlineStep);
  const offlineInstall = stepRun(offlineStep).split("\n").find((line) => line.startsWith("pnpm --dir "));
  assert.ok(offlineInstall);

  // Execute the actual source-install script with a recording pnpm, without
  // acquiring packages or inventing any of pnpm's genuine cache records.
  const directory = await mkdtemp(join(tmpdir(), "einzbern-ci-bootstrap-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin"), runnerTemp = join(directory, "runner temp");
  const onlineHome = join(directory, "online home"), privateHome = join(directory, "private home");
  for (const path of [bin, runnerTemp, onlineHome, privateHome]) await mkdir(path);
  await writeFile(join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.BOOTSTRAP_TRACE, JSON.stringify({
  args: process.argv.slice(2), cache: process.env.pnpm_config_cache_dir ?? null,
  home: process.env.HOME, persisted: fs.readFileSync(process.env.GITHUB_ENV, "utf8"),
}) + "\\n");
`, { mode: 0o755 });
  const cases = [
    ["991", "1", "p1-core"], ["992", "1", "p1-core"], ["991", "2", "p1-core"],
    ["991", "1", "p1-checks"], ["991", "1", "p1-portal"], ["991", "1", "p1"], ["991", "1", "pf2-h1"],
  ];
  const cachePaths = new Set();
  for (const [index, [runId, attempt, mode]] of cases.entries()) {
    const githubEnv = join(directory, `${index}.env`), trace = join(directory, `${index}.jsonl`);
    const existingEntry = "BOOTSTRAP_EXISTING_ENTRY=preserved\n";
    await writeFile(githubEnv, existingEntry);
    const env = {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: onlineHome,
      RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, VERIFY_MODE: mode,
      GITHUB_ENV: githubEnv, BOOTSTRAP_TRACE: trace,
    };
    delete env.pnpm_config_cache_dir;
    const execute = (script, environment) => spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      cwd: directory, env: environment, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    const online = execute(installRun, env);
    assert.equal(online.status, 0, online.stderr);
    const expectedCache = join(runnerTemp, `einzbern-bootstrap-${runId}-${attempt}-${mode}`, "pnpm");
    const persisted = `${existingEntry}pnpm_config_cache_dir=${expectedCache}\n`;
    const records = () => readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records(), [{
      args: ["install", "--frozen-lockfile", "--ignore-scripts", "--config.offline=false"],
      cache: expectedCache, home: onlineHome, persisted,
    }], "the first online install must already see its exported cache and the appended GITHUB_ENV record");
    const environmentFile = readFileSync(githubEnv, "utf8");
    assert.equal(environmentFile, persisted);
    cachePaths.add(expectedCache);

    // Apply GITHUB_ENV as a later step does, then consume the workflow's exact
    // offline install command with a different HOME and a path containing spaces.
    const inherited = Object.fromEntries(environmentFile.trimEnd().split("\n").map((line) => {
      const equals = line.indexOf("=");
      return [line.slice(0, equals), line.slice(equals + 1)];
    }));
    const offline = execute(offlineInstall, { ...env, ...inherited, HOME: privateHome, root: join(directory, "offline clone") });
    assert.equal(offline.status, 0, offline.stderr);
    assert.deepEqual(records()[1], {
      args: ["--dir", join(directory, "offline clone", "build"), "install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      cache: expectedCache, home: privateHome, persisted,
    }, "the later offline/private-HOME consumer must inherit the same cache without another initialization");
    assert.equal(records().length, 2);
  }
  assert.equal(cachePaths.size, cases.length, "run ID, attempt and matrix mode must keep the cache paths distinct");
});
