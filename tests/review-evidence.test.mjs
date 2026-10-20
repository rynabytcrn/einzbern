// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-375 — review-evidence produces measured, not self-reported, rows.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEW_EVIDENCE_VERSION,
  diffEvidence,
  parseTestRunOutput,
} from "../scripts/review-evidence.mjs";
import { assessEvidenceReuse, assessDynamicEvidenceReuse, buildDevelopmentPlan, buildDynamicGatePlan, buildFinalGatePlan, buildGateImpactMap, createGateReceiptAuthority, DEVELOPMENT_CHECK_COMMANDS, executeSelectedRoots, issueGateReceipt, queryGateReceipt, recordExecution } from "../scripts/final-gate-plan.mjs";
import { classifyProcess } from "../scripts/operational-batch-entry.mjs";
import * as operationalBatchEntry from "../scripts/operational-batch-entry.mjs";
import { appendProgressEvent, readProgressDelta, summarizeProgress, waitForProgress } from "../scripts/lib/incremental-output.mjs";
import { copyHistoricalTypeScriptRuntime, historicalTypeScriptDependencyCheck, runHistoricalCommand } from "../scripts/verbatim-evidence-proof.mjs";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { LOCAL_DIRECTORY_NAMES, initializeLibrary } from "../dist/build/packages/core/src/index.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER_PATH = resolve(REPOSITORY_ROOT, "tests/fixtures/acceptance-gate-groups.json");
const CONTAINMENT_PATH = resolve(REPOSITORY_ROOT, "scripts/policy/gate-containment.json");

test("INC-391 preserves historical child exit, signal, and buffer diagnostics without output text", async () => {
  const run = (source, maxBufferBytes) => runHistoricalCommand(["-e", source], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, npm_config_offline: "true" },
    maxBufferBytes,
  });

  const successMarker = "INC391_CAPTURED_SUCCESS_OUTPUT";
  const succeeded = await run(`process.stdout.write(${JSON.stringify(successMarker)});`, 1024);
  assert.deepEqual({
    ok: succeeded.ok,
    stdoutMatches: succeeded.ok && succeeded.result.stdout === successMarker,
    stdoutBytes: succeeded.ok ? Buffer.byteLength(succeeded.result.stdout) : null,
    stderrEmpty: succeeded.ok && succeeded.result.stderr === "",
  }, {
    ok: true,
    stdoutMatches: true,
    stdoutBytes: Buffer.byteLength(successMarker),
    stderrEmpty: true,
  });

  const privateMarker = "INC391_PRIVATE_CHILD_OUTPUT";
  // R8's full-suite run captured 0 bytes where the focused case captured 27.
  // Wait for the child stream callback to define an explicit flush point before
  // exit; the assertion still checks the bytes that execFile actually captured.
  const exited = await run(`process.stdout.write(${JSON.stringify(privateMarker)}, () => { process.exitCode = 23; });`, 1024);
  assert.equal(exited.ok, false);
  assert.deepEqual(exited.failure, {
    stage: "historical-command",
    failureKind: "child-exit",
    exitCode: 23,
    errorCode: null,
    errorName: "Error",
    signal: null,
    killed: false,
    stdoutBytes: Buffer.byteLength(privateMarker),
    stderrBytes: 0,
  });
  assert.equal(JSON.stringify(exited).includes(privateMarker), false);

  const signaled = await run('process.kill(process.pid, "SIGTERM");', 1024);
  assert.equal(signaled.ok, false);
  assert.equal(signaled.failure.failureKind, "signal");
  assert.equal(signaled.failure.exitCode, null);
  assert.equal(signaled.failure.signal, "SIGTERM");

  const overflowed = await run('process.stdout.write("x".repeat(4096));', 1024);
  assert.equal(overflowed.ok, false);
  assert.equal(overflowed.failure.failureKind, "max-buffer");
  assert.equal(overflowed.failure.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(overflowed.failure.exitCode, null);
  assert.equal(overflowed.failure.maxBufferBytes, 1024);
  assert.equal(overflowed.failure.stdoutBytes, 1024);
});

test("INC-391 copies only the TypeScript runtime and ignores a package self-link", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tcrn-inc391-typescript-copy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const packageRoot = join(directory, "node_modules", ".pnpm", "typescript@5.9.3", "node_modules", "typescript");
  const packageAlias = join(directory, "node_modules", "typescript");
  mkdirSync(join(packageRoot, "lib"), { recursive: true });
  const manifest = JSON.stringify({ name: "typescript", version: "5.9.3", main: "./lib/typescript.js" });
  const runtime = "module.exports = { createSourceFile() {} };\n";
  writeFileSync(join(packageRoot, "package.json"), manifest);
  writeFileSync(join(packageRoot, "lib", "typescript.js"), runtime);
  symlinkSync(packageRoot, packageAlias, "dir");
  symlinkSync(packageAlias, join(packageRoot, "typescript"), "dir");

  await assert.rejects(
    cp(packageAlias, join(directory, "unsafe-copy"), { recursive: true, dereference: true }),
    { code: "ELOOP" },
  );

  const destination = join(directory, "historical", "node_modules", "typescript");
  await copyHistoricalTypeScriptRuntime(packageAlias, destination);
  assert.equal(readFileSync(join(destination, "package.json"), "utf8"), manifest);
  assert.equal(readFileSync(join(destination, "lib", "typescript.js"), "utf8"), runtime);
  assert.equal(existsSync(join(destination, "typescript")), false);
});

// KB-20261010-INC-155-REPLAY-PINS-WHOLE-LOCKFILE: the INC-155 replay copies only the TypeScript
// runtime, so it compares only the lockfile entries that decide which TypeScript that is.
const INC155_MANIFESTS = {
  typescriptVersion: "5.9.3",
  historicalManifest: { devDependencies: { typescript: "5.9.3" } },
  currentManifest: { devDependencies: { typescript: "5.9.3" } },
  installedManifest: { version: "5.9.3" },
};
const INC155_MISMATCH = { ok: false, reasonCode: "EVIDENCE_HISTORY_DEPENDENCY_MISMATCH" };

function inc155Lockfile({
  fastUri = "3.1.6",
  fastUriIntegrity = "sha512-fastUriSix",
  typesNode = "24.13.2",
  typescriptSpecifier = "5.9.3",
  typescriptIntegrity = "sha512-typescriptFiveNineThree",
  typescriptSnapshot = ["  typescript@5.9.3: {}"],
} = {}) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "overrides:",
    `  fast-uri: '>=${fastUri}'`,
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@types/node':",
    `        specifier: ${typesNode}`,
    `        version: ${typesNode}`,
    "      ajv:",
    "        specifier: 8.20.0",
    "        version: 8.20.0",
    "      typescript:",
    `        specifier: ${typescriptSpecifier}`,
    "        version: 5.9.3",
    "",
    "  packages/cli: {}",
    "",
    "packages:",
    "",
    `  '@types/node@${typesNode}':`,
    "    resolution: {integrity: sha512-typesNode}",
    "",
    "  ajv@8.20.0:",
    "    resolution: {integrity: sha512-ajv}",
    "",
    `  fast-uri@${fastUri}:`,
    `    resolution: {integrity: ${fastUriIntegrity}}`,
    "",
    "  typescript@5.9.3:",
    `    resolution: {integrity: ${typescriptIntegrity}}`,
    "    engines: {node: '>=14.17'}",
    "    hasBin: true",
    "",
    "snapshots:",
    "",
    `  '@types/node@${typesNode}': {}`,
    "",
    "  ajv@8.20.0:",
    "    dependencies:",
    `      fast-uri: ${fastUri}`,
    "",
    `  fast-uri@${fastUri}: {}`,
    "",
    ...typescriptSnapshot,
    "",
  ].join("\n");
}

test("INC-155 replay: a lockfile that differs only outside TypeScript passes the dependency check", () => {
  const historicalLock = inc155Lockfile();
  const currentLock = inc155Lockfile({ fastUri: "3.1.7", fastUriIntegrity: "sha512-fastUriSeven", typesNode: "24.13.3" });
  assert.notEqual(currentLock, historicalLock);
  assert.deepEqual(historicalTypeScriptDependencyCheck({ ...INC155_MANIFESTS, historicalLock, currentLock }), { ok: true });
});

test("INC-155 replay: a different TypeScript lockfile entry is EVIDENCE_HISTORY_DEPENDENCY_MISMATCH", () => {
  const historicalLock = inc155Lockfile();
  for (const currentLock of [
    inc155Lockfile({ typescriptSpecifier: "^5.9.3" }),
    inc155Lockfile({ typescriptIntegrity: "sha512-typescriptRepacked" }),
    inc155Lockfile({ typescriptSnapshot: ["  typescript@5.9.3:", "    dependencies:", "      tslib: 2.8.1"] }),
    inc155Lockfile({ typescriptSnapshot: [] }),
  ]) {
    assert.deepEqual(historicalTypeScriptDependencyCheck({ ...INC155_MANIFESTS, historicalLock, currentLock }), INC155_MISMATCH);
  }
  // The package.json and node_modules versions are still compared on their own.
  assert.deepEqual(historicalTypeScriptDependencyCheck({ ...INC155_MANIFESTS, installedManifest: { version: "5.9.2" }, historicalLock, currentLock: historicalLock }), INC155_MISMATCH);
});

function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "tests", "fixture.test.mjs"), "import assert from \"node:assert/strict\"; import test from \"node:test\"; test(\"fixture\", () => assert.equal(1, 1));\n");
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "add", "tests/fixture.test.mjs"]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=review-test", "-c", "user.email=review-at-example.invalid", "commit", "-qm", "base"]).status, 0);
  const base = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return { root, base };
}

function runUnpreloadedCollect(options) {
  const moduleUrl = new URL("../scripts/review-evidence.mjs", import.meta.url).href;
  const source = `import { collectReviewEvidence } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(collectReviewEvidence(${JSON.stringify(options)})));`;
  const result = spawnSync("/usr/bin/env", ["-u", "NODE_OPTIONS", process.execPath, "--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function runCliJson(args) {
  let output = "";
  await runCli([...args, "--actor", "agent:test"], { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function reviewWorkspace(t, verifyCommand) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tcrn-review-evidence-workspace-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const at = (second) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const project = await runCliJson(["project-create", "--workspace", workspace, "--at", at(1), "--external-key", "FIXTURE-PROJECT", "--name", "Fixture"]);
  const work = await runCliJson(["work-create", "--workspace", workspace, "--at", at(2), "--project-id", project.record.id, "--external-key", "FIXTURE-WORK", "--kind", "Initiative", "--status", "active", "--scope", "fixture scope", "--title", "Fixture work"]);
  await runCliJson(["work-annotate", "--workspace", workspace, "--at", at(3), "--id", work.record.id, "--verify", verifyCommand]);
  return { workspace, workId: work.record.id };
}

test("STORY-375 GWT1: review-evidence reads the bound verify, runs it, and separates runner and AST counts", async (t) => {
  const { root: repositoryRoot, base } = gitFixture(t);
  const verifyCommand = `${JSON.stringify(process.execPath)} --test tests/fixture.test.mjs`;
  const { workspace, workId } = await reviewWorkspace(t, verifyCommand);
  const result = runUnpreloadedCollect({
    workspace,
    workId,
    repositoryRoot,
    base,
    allowedFiles: [],
  });
  // The current checkout has no diff, but an empty scope is deliberately refused:
  // a caller must declare the files it reviewed rather than letting the tool invent them.
  assert.equal(result.schemaVersion, REVIEW_EVIDENCE_VERSION);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("allowedFiles")));

  const rerun = runUnpreloadedCollect({
    workspace,
    workId,
    repositoryRoot,
    base,
    allowedFiles: ["tests/fixture.test.mjs"],
    testFiles: ["tests/fixture.test.mjs"],
    testCommand: `${JSON.stringify(process.execPath)} --test tests/fixture.test.mjs`,
  });
  assert.equal(rerun.ok, true, JSON.stringify(rerun.problems));
  assert.equal(rerun.evidence.verify.ok, true);
  assert.equal(rerun.evidence.testRun.summary.parseable, true);
  assert.equal(rerun.evidence.testRun.summary.source, "node-test-case-summary");
  assert.deepEqual(rerun.evidence.testRun.summary.testFiles, ["tests/fixture.test.mjs"]);
  assert.equal(rerun.evidence.testRun.summary.testFileCount, 1);
  assert.equal(rerun.evidence.testRun.summary.testCases, 1);
  assert.match(rerun.evidence.testRun.result.stdout, /tests 1/u);
  assert.match(rerun.evidence.testRun.result.stdoutSha256, /^[a-f0-9]{64}$/u);
  assert.equal(rerun.evidence.testRun.result.outputComplete, true);
  assert.equal(typeof rerun.evidence.astCountCoverage.before.testCount, "number");
  assert.equal(typeof rerun.evidence.astCountCoverage.after.testCount, "number");
  assert.deepEqual(rerun.evidence.diff.outOfBounds, []);

  const timeoutRoot = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-timeout-"));
  try {
    const pidFile = join(timeoutRoot, "child.pid");
    const timeout = runUnpreloadedCollect({
      workspace,
      workId,
      repositoryRoot,
      base,
      allowedFiles: ["tests/fixture.test.mjs"],
      testFiles: ["tests/fixture.test.mjs"],
      testCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000)`)}`,
      commandTimeoutMs: 100,
    });
    assert.equal(timeout.evidence.testRun.result.exitCode, "TIMEOUT");
    assert.equal(timeout.ok, false);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
  } finally {
    rmSync(timeoutRoot, { recursive: true, force: true });
  }
});

test("STORY-375 GWT2: untracked diff files are included and become out-of-bounds without post-hoc scope widening", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-review-evidence-git-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    assert.equal(spawnSync("git", ["-C", root, "add", "tracked.txt"]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=review-test", "-c", "user.email=review-at-example.invalid", "commit", "-qm", "base"]).status, 0);
    writeFileSync(join(root, "untracked.txt"), "untracked\n");
    const diff = diffEvidence(root, "HEAD");
    assert.deepEqual(diff.changedFiles, ["untracked.txt"]);
    assert.deepEqual(diff.untracked[0].paths, ["untracked.txt"]);
    assert.deepEqual(diff.files, [{ path: "untracked.txt", status: "??" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("STORY-375: runner counts come from machine output, not prose or a caller-supplied number", () => {
  assert.deepEqual(parseTestRunOutput(JSON.stringify({ tests: ["tests/one.test.mjs", "tests/two.test.mjs"], result: "passed" })), {
    testFiles: ["tests/one.test.mjs", "tests/two.test.mjs"],
    testFileCount: 2,
    testCases: null,
    passed: null,
    failed: 0,
    parseable: true,
    source: "engine-test-result.file-list",
  });
  assert.deepEqual(parseTestRunOutput("ℹ tests 12\nℹ pass 12\nℹ fail 0\n", "", ["tests/fixture.test.mjs"]), {
    testFiles: ["tests/fixture.test.mjs"],
    testFileCount: 1,
    testCases: 12,
    passed: 12,
    failed: 0,
    parseable: true,
    source: "node-test-case-summary",
  });
  assert.equal(parseTestRunOutput(JSON.stringify({ tests: ["fixture-test"], result: "passed" })).parseable, false);
  assert.equal(parseTestRunOutput("passed: 999 tests").parseable, false);
});

test("STORY-413: gate planning and evidence reuse use one positive and negative predicate", async () => {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
  const containment = JSON.parse(readFileSync(CONTAINMENT_PATH, "utf8"));
  const inputs = { sourceDigest: "source-a", environmentDigest: "environment-a", commandDigest: "command-a", baselineDigest: "baseline-a" };
  const successful = { id: "evidence-1", ok: true, status: "completed", inputs };
  const reusable = assessEvidenceReuse({ evidence: successful, inputs });
  assert.equal(reusable.reusable, true);
  assert.deepEqual(reusable.invalidated, []);
  for (const field of Object.keys(inputs)) {
    const changed = { ...inputs, [field]: `${field}-b` };
    const rejected = assessEvidenceReuse({ evidence: successful, inputs: changed });
    assert.equal(rejected.reusable, false, JSON.stringify(changed));
    assert.equal(rejected.reused.length, 0);
    assert.ok(rejected.invalidated[0].reasons.length > 0);
  }
  const missingDigest = assessEvidenceReuse({ evidence: successful, inputs: { ...inputs, baselineDigest: undefined } });
  assert.equal(missingDigest.reusable, false);
  assert.ok(missingDigest.invalidated[0].reasons.length > 0);
  assert.equal(assessEvidenceReuse({ evidence: { ...successful, ok: false }, inputs }).reusable, false);
  assert.equal(assessEvidenceReuse({ evidence: { ...successful, status: "running" }, inputs }).reusable, false);

  const planOptions = { roster, containment, phase: "candidate-final", inputs, executionPermission: true, candidateReady: true, blockedDependencies: [] };
  const buildPlan = (overrides = {}) => buildFinalGatePlan({ ...planOptions, ...overrides });
  const assertNoRootExecution = async (candidate) => {
    let calls = 0;
    const result = await executeSelectedRoots(candidate, async () => { calls += 1; return { ok: true }; }, { rosterPath: ROSTER_PATH });
    assert.equal(calls, 0);
    assert.deepEqual(result.executed, []);
    return result;
  };

  const plan = buildPlan({ previousEvidence: [successful] });
  assert.deepEqual(plan.selected.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);
  assert.deepEqual(plan.executionOrder, plan.selected.map(({ id }) => id));
  assert.equal(plan.execution.strategy, "serial");
  assert.deepEqual(plan.reused, [{ id: "evidence-1", reason: "same source, environment, command, and baseline inputs" }]);
  assert.ok(plan.coveredBy.every(({ coveredBy }) => coveredBy !== null));
  const executed = recordExecution(plan, plan.selected.map(({ id }) => ({ id, ok: true })), { rosterPath: ROSTER_PATH });
  assert.deepEqual(executed.executed.map(({ id }) => id), plan.executionOrder);
  const order = [];
  const measured = await executeSelectedRoots(plan, async (entry) => {
    order.push(entry.id);
    return { ok: true, reasonCode: "FIXTURE_ROOT_GREEN" };
  }, { rosterPath: ROSTER_PATH });
  assert.deepEqual(order, plan.executionOrder);
  assert.deepEqual(measured.executed.map(({ id, reasonCode }) => ({ id, reasonCode })), plan.executionOrder.map((id) => ({ id, reasonCode: "FIXTURE_ROOT_GREEN" })));
  assert.ok(measured.executed.every(({ elapsedMs }) => Number.isSafeInteger(elapsedMs) && elapsedMs >= 0));
  const failedRoot = await executeSelectedRoots(plan, async (entry) => ({ ok: entry.id !== "platform-layout", reasonCode: entry.id === "platform-layout" ? "FIXTURE_ROOT_RED" : "FIXTURE_ROOT_GREEN" }), { rosterPath: ROSTER_PATH });
  assert.ok(failedRoot.blocked.some(({ id, reason }) => id === "platform-layout" && reason === "FIXTURE_ROOT_RED"));
  assert.equal(failedRoot.executed.find(({ id }) => id === "platform-layout").ok, false);
  const blockedPlan = buildPlan({ blockedDependencies: ["DS candidate pending"] });
  const blockedResult = await assertNoRootExecution(blockedPlan);
  assert.ok(blockedResult.blocked.some(({ reason }) => reason === "DS candidate pending"));
  const missingInputPlan = buildPlan({ inputs: {} });
  await assertNoRootExecution(missingInputPlan);
  const unknownReadinessPlan = buildPlan({ candidateReady: undefined });
  assert.equal(unknownReadinessPlan.executable, false);
  await assertNoRootExecution(unknownReadinessPlan);
  const missingRequiredSuite = { ...containment, groups: containment.groups.filter((group) => group.id !== "engine-suite").map((group) => group.id === "engine-p1" ? { ...group, contains: [] } : group) };
  assert.throws(() => buildPlan({ containment: missingRequiredSuite }), (error) => error.reasonCode === "GATE_PLAN_REQUIRED_GROUP_MISSING");
  const missingRequiredEdge = { ...roster, groups: roster.groups.map((group) => group.id === "engine-release" ? { ...group, contains: [...group.contains, "unlisted-child"] } : group) };
  assert.throws(() => buildPlan({ roster: missingRequiredEdge }), (error) => error.reasonCode === "GATE_PLAN_REQUIRED_EDGE_MISSING");
  const commandDrift = { ...roster, groups: roster.groups.map((group) => group.id === "engine-release" ? { ...group, command: "node scripts/push-gate-drift.mjs" } : group) };
  assert.throws(() => buildPlan({ roster: commandDrift }), (error) => error.reasonCode === "GATE_PLAN_COMMAND_DRIFT");
  const rootOrderDrift = { ...roster, topLevel: [...roster.topLevel].reverse() };
  assert.throws(() => buildPlan({ roster: rootOrderDrift }), (error) => error.reasonCode === "GATE_PLAN_ROOT_ORDER_DRIFT");
  assert.throws(() => recordExecution(plan, [{ id: "engine-release", ok: true }], { rosterPath: ROSTER_PATH }), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_MISMATCH");
  assert.throws(() => recordExecution(plan, [...plan.selected.map(({ id }) => ({ id, ok: true })), { id: "engine-p1", ok: true }], { rosterPath: ROSTER_PATH }), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_MISMATCH");

  const known = buildDevelopmentPlan({ changedFiles: ["scripts/task.mjs"], inputs, previousEvidence: [successful] });
  assert.deepEqual(known.selected.map(({ id }) => id), ["typecheck", "test"]);
  assert.deepEqual(known.selected.map(({ id, command }) => ({ id, command })), [{ id: "typecheck", command: "pnpm typecheck" }, { id: "test", command: "pnpm test" }]);
  assert.deepEqual(known.blocked, []);
  const docs = buildDevelopmentPlan({ changedFiles: ["docs/dispatch.md"] });
  assert.deepEqual(docs.selected.map(({ id, command }) => ({ id, command })), [{ id: "format-check", command: "pnpm format:check" }, { id: "links", command: "pnpm verify:links" }]);
  const packageScripts = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "package.json"), "utf8")).scripts;
  for (const command of Object.values(DEVELOPMENT_CHECK_COMMANDS)) {
    const tokens = command.split(/\s+/u);
    if (tokens[0] === "pnpm") assert.equal(Object.hasOwn(packageScripts, tokens.at(-1)), true, command);
  }
  const unknown = buildDevelopmentPlan({ changedFiles: ["generated/unknown.bin"] });
  assert.ok(unknown.blocked.some(({ id }) => id === "generated/unknown.bin"));
  assert.deepEqual(unknown.selected.map(({ id }) => id), ["typecheck", "test"]);
});

test("STORY-420: dynamic impact selects affected roots, reuses only bound terminal evidence, and fails closed on unknown impact", async () => {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
  const containment = JSON.parse(readFileSync(CONTAINMENT_PATH, "utf8"));
  const inputs = { sourceDigest: "source-420", environmentDigest: "environment-420", commandDigest: "command-420", baselineDigest: "baseline-420" };
  const options = { roster, containment, inputs, candidateReady: true, executionPermission: true };

  const engine = buildDynamicGatePlan({ ...options, changedFiles: ["scripts/final-gate-plan.mjs"] });
  assert.deepEqual(engine.selected.map(({ id }) => id), ["engine-release"]);
  assert.deepEqual(engine.gates.map(({ id, disposition }) => ({ id, disposition })), [
    { id: "engine-release", disposition: "run" },
    { id: "platform-layout", disposition: "not-applicable" },
    { id: "product-gates", disposition: "not-applicable" },
  ]);
  assert.equal(engine.coveredBy.some(({ id }) => id === "engine-p1"), true);
  assert.equal(engine.selected.some(({ id }) => id === "engine-p1"), false);

  const evidence = ["engine-release", "platform-layout", "product-gates"].map((gateId, index) => ({
    id: `evidence-420-${index}`,
    gateId,
    phase: "candidate-final",
    status: "completed",
    ok: true,
    inputs,
  }));
  const unchanged = buildDynamicGatePlan({ ...options, changedFiles: [], previousEvidence: evidence });
  assert.deepEqual(unchanged.selected, []);
  assert.deepEqual(unchanged.reused.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);
  assert.deepEqual(unchanged.notVerifiable, []);

  const unrelated = buildDynamicGatePlan({ ...options, changedFiles: [], crossRepoChanges: [{ repository: "TCRN-Design-System", related: false }], previousEvidence: evidence });
  assert.deepEqual(unrelated.selected, []);
  assert.equal(unrelated.blocked.length, 0);
  assert.ok(unrelated.notApplicable.some(({ id }) => id === "product-gates"));

  const related = buildDynamicGatePlan({ ...options, changedFiles: [], crossRepoChanges: [{ repository: "TCRN-Design-System", related: true }], previousEvidence: evidence });
  assert.deepEqual(related.selected.map(({ id }) => id), ["product-gates"]);
  assert.ok(related.invalidated.some(({ id, evidenceId }) => id === "product-gates" && evidenceId === "evidence-420-2"));

  const unknown = buildDynamicGatePlan({ ...options, changedFiles: [], environmentChanges: ["unregistered-runtime"] });
  assert.ok(unknown.blocked.some(({ id }) => id === "unknown-impact"));
  assert.deepEqual(unknown.selected.map(({ id }) => id), ["engine-release", "platform-layout", "product-gates"]);

  const missing = assessDynamicEvidenceReuse({ evidence: { id: "evidence-missing", gateId: "engine-release", phase: "candidate-final", status: "completed", ok: true, inputs: { ...inputs, baselineDigest: undefined } }, inputs, phase: "candidate-final", gateId: "engine-release" });
  assert.equal(missing.reusable, false);
  assert.ok(missing.reasons.some((reason) => reason.includes("digest")));

  let calls = 0;
  const drifted = await executeSelectedRoots(engine, async () => { calls += 1; return { ok: true }; }, { currentInputs: { ...inputs, sourceDigest: "source-drifted" }, rosterPath: ROSTER_PATH });
  assert.equal(calls, 0);
  assert.equal(drifted.executable, false);
  assert.ok(drifted.blocked.some(({ id }) => id === "input-drift"));

  for (const phase of ["candidate-final", "publication", "merge-sensitive"]) {
    const phasePlan = buildDynamicGatePlan({ ...options, phase, changedFiles: ["scripts/final-gate-plan.mjs"] });
    assert.deepEqual(phasePlan.selected.map(({ id }) => id), ["engine-release"]);
  }
});

test("STORY-439: gate selection is derivable from containment", () => {
  const containment = JSON.parse(readFileSync(CONTAINMENT_PATH, "utf8"));

  const engine = buildGateImpactMap({ containment, changedFiles: ["scripts/einzbern-hook-launcher.mjs"] });
  assert.deepEqual(engine.affected, ["engine-release"]);

  assert.deepEqual(containment.topLevel, ["engine-release", "platform-layout", "product-gates"]);
  assert.equal(containment.topLevel.length, 3);

  const unknown = buildGateImpactMap({ containment, environmentChanges: ["unregistered-runtime"] });
  assert.ok(unknown.unknown.length > 0);
  assert.deepEqual(unknown.affected, containment.topLevel);
  assert.deepEqual(unknown.forcedInvalidation, containment.topLevel);
});

test("EPIC135 closeout: only an issued receipt with the exact invocation can be reused", async () => {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
  const containment = JSON.parse(readFileSync(CONTAINMENT_PATH, "utf8"));
  const entry = roster.groups.find(({ id }) => id === "engine-release");
  const repositoryRoot = REPOSITORY_ROOT;
  const inputs = { sourceDigest: "source-closeout", environmentDigest: "environment-closeout", commandDigest: "command-closeout", baselineDigest: "baseline-closeout" };
  const invocation = { executable: "node", argv: ["scripts/push-gate.mjs"], cwd: repositoryRoot, command: entry.command };
  const authority = createGateReceiptAuthority();
  const receipt = issueGateReceipt(authority, { entry, invocation, inputs, result: { ok: true, status: 0, signal: null, stdout: "", stderr: "" } });
  assert.equal(queryGateReceipt(authority, receipt.terminalEvidence, { gateId: entry.id, expectedInputs: inputs, expectedCommand: entry.command, expectedInvocation: invocation }).gateId, entry.id);
  assert.equal(assessDynamicEvidenceReuse({ evidence: receipt, inputs, gateId: entry.id, phase: "candidate-final", requireTrustedEvidence: true, receiptAuthority: authority, invocation }).reusable, true);

  const forged = structuredClone(receipt);
  forged.terminalEvidence = { ...forged.terminalEvidence, source: "tcrn-code-owned-runner", storeRoot: authority.storeRoot };
  assert.equal(assessDynamicEvidenceReuse({ evidence: forged, inputs, gateId: entry.id, phase: "candidate-final", requireTrustedEvidence: true, receiptAuthority: createGateReceiptAuthority(), invocation }).reusable, false);
  const failedAuthority = createGateReceiptAuthority();
  const failed = issueGateReceipt(failedAuthority, { entry, invocation, inputs, result: { ok: false, status: 1, signal: null, stdout: "", stderr: "failed" } });
  assert.equal(assessDynamicEvidenceReuse({ evidence: failed, inputs, gateId: entry.id, phase: "candidate-final", requireTrustedEvidence: true, receiptAuthority: failedAuthority, invocation }).reusable, false);

  const plan = buildDynamicGatePlan({ roster, containment, inputs, changedFiles: ["scripts/final-gate-plan.mjs"], dependencies: [], configuration: [], generated: [], environment: [], crossRepoChanges: [], candidateReady: true, executionPermission: true, operational: true, requireCompleteImpact: true, gateInvocations: { [entry.id]: invocation }, receiptAuthority: authority });
  const resealed = structuredClone(plan);
  resealed.selected = [];
  resealed.coveredBy = [];
  resealed.executionOrder = [];
  resealed.gates = resealed.gates.map((gate) => gate.disposition === "run" ? { ...gate, disposition: "not-applicable", status: "not-applicable" } : gate);
  resealed.integrity.requiredSelected = [];
  resealed.integrity.coveredChildren = [];
  let calls = 0;
  const refused = await executeSelectedRoots(resealed, async () => { calls += 1; return { ok: true }; }, { getInputs: async () => inputs, rosterPath: ROSTER_PATH });
  assert.equal(calls, 0);
  assert.equal(refused.executable, false);
  assert.equal(refused.reasonCode, "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED");
});

test("EPIC135 R1: private plan registration rejects public discriminator and reseal downgrades before any runner call", async () => {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, "utf8"));
  const containment = JSON.parse(readFileSync(CONTAINMENT_PATH, "utf8"));
  const inputs = { sourceDigest: "source-r1", environmentDigest: "environment-r1", commandDigest: "command-r1", baselineDigest: "baseline-r1" };
  const options = { roster, containment, phase: "candidate-final", inputs, changedFiles: ["scripts/final-gate-plan.mjs"], dependencies: [], configuration: [], generated: [], environment: [], crossRepoChanges: [], candidateReady: true, executionPermission: true };
  const assertRefused = async (plan) => {
    let calls = 0;
    const result = await executeSelectedRoots(plan, async () => { calls += 1; return { ok: true }; }, { getInputs: async () => inputs, rosterPath: ROSTER_PATH });
    assert.equal(calls, 0);
    assert.equal(result.reasonCode, "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED");
    assert.equal(result.executable, false);
  };
  let unavailableCalls = 0;
  const rosterUnavailable = await executeSelectedRoots(buildDynamicGatePlan(options), async () => {
    unavailableCalls += 1;
    return { ok: true };
  }, { getInputs: async () => inputs, rosterPath: resolve(REPOSITORY_ROOT, "tests/fixtures/acceptance-gate-groups.missing.json") });
  assert.equal(unavailableCalls, 0);
  assert.equal(rosterUnavailable.reasonCode, "GATE_PLAN_ROSTER_UNAVAILABLE");
  assert.equal(rosterUnavailable.executable, false);
  // TCRN-CROSS-SUB-373: the roster is an explicit input, never read from the platform documents;
  // naming none is refused the same way, before any runner call.
  const rosterUnnamed = await executeSelectedRoots(buildDynamicGatePlan(options), async () => {
    unavailableCalls += 1;
    return { ok: true };
  }, { getInputs: async () => inputs });
  assert.equal(unavailableCalls, 0);
  assert.equal(rosterUnnamed.reasonCode, "GATE_PLAN_ROSTER_UNAVAILABLE");
  assert.equal(rosterUnnamed.executable, false);
  const downgraded = buildDynamicGatePlan(options);
  downgraded.dynamic = false;
  delete downgraded.integrity;
  await assertRefused(downgraded);

  const commandChanged = buildDynamicGatePlan(options);
  commandChanged.selected[0].command = "node unregistered-command.mjs";
  await assertRefused(commandChanged);

  const resealed = structuredClone(buildDynamicGatePlan(options));
  resealed.selected = [];
  resealed.executionOrder = [];
  resealed.gates = resealed.gates.map((gate) => ({ ...gate, disposition: "not-applicable", status: "not-applicable" }));
  resealed.integrity.requiredSelected = [];
  resealed.integrity.requiredSelectionDigest = "0".repeat(64);
  let directCalls = 0;
  assert.throws(() => recordExecution(resealed, [], { rosterPath: ROSTER_PATH }), (error) => error.reasonCode === "GATE_PLAN_EXECUTION_INTEGRITY_REFUSED");
  assert.equal(directCalls, 0);
});

test("EPIC135 closeout: runtime scope keeps unknown writes visible without blocking on unknown system processes", () => {
  const relativeWrite = classifyProcess({ pid: 101, state: "S", command: "node scripts/einzbern.mjs work-create --workspace /tmp/workspace" }, { selfPid: 1 });
  assert.equal(relativeWrite.scope, "unknown");
  assert.equal(relativeWrite.likelyGovernedWrite, true);
  assert.equal(relativeWrite.scopeBasis, "relative-command-without-cwd");
  const systemProcess = classifyProcess({ pid: 102, state: "S", command: "/usr/libexec/system-service --wait" }, { selfPid: 1 });
  assert.equal(systemProcess.scope, "unknown");
  assert.equal(systemProcess.role, "unknown-live-process");
  assert.equal(systemProcess.likelyGovernedWrite, false);
});

test("STORY-414: progress waits report cursor deltas, unchanged polls, and terminal failures without false success", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-progress-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "events.ndjson");
  await appendProgressEvent(path, { type: "selected", id: "engine-release" });
  await appendProgressEvent(path, { type: "controller-started", pid: 123 });
  const first = await readProgressDelta(path);
  assert.deepEqual(first.events.map(({ type }) => type), ["selected", "controller-started"]);
  const unchanged = await readProgressDelta(path, first.nextCursor);
  assert.deepEqual(unchanged.events, []);
  assert.equal(unchanged.bytesRead, 0);
  await appendProgressEvent(path, { type: "completed", ok: true, code: 0, signal: null });
  const second = await readProgressDelta(path, first.nextCursor);
  assert.deepEqual(second.events.map(({ type }) => type), ["completed"]);
  assert.equal(summarizeProgress([...first.events, ...second.events]).status, "completed");
  const completed = await waitForProgress(path, { cursor: first.nextCursor, events: first.events, timeoutMs: 100, pollMs: 5 });
  assert.equal(completed.status, "completed");
  assert.ok(completed.polls >= 1);
  assert.ok(completed.bytesRead > 0);
  for (const [name, event, expected] of [
    ["completed", { type: "completed", ok: true, code: 0, signal: null }, "completed"],
    ["failed", { type: "error", reasonCode: "FIXTURE_FAILED" }, "failed"],
    ["orphaned", { type: "orphaned-before-bind", processGroup: 123 }, "orphaned"],
  ]) {
    const historyPath = join(root, `${name}-history.ndjson`);
    await appendProgressEvent(historyPath, event);
    const history = await readProgressDelta(historyPath);
    const knownTerminal = await waitForProgress(historyPath, { cursor: history.nextCursor, events: history.events, timeoutMs: 0, pollMs: 5 });
    assert.equal(knownTerminal.status, expected, name);
    assert.equal(knownTerminal.summary.status, expected, name);
    assert.equal(knownTerminal.polls, 0, name);
  }

  const idlePath = join(root, "idle.ndjson");
  const idle = await waitForProgress(idlePath, { timeoutMs: 25, pollMs: 5, maxPollMs: 10 });
  assert.equal(idle.status, "timeout");
  assert.ok(idle.polls >= 2);
  assert.equal(idle.summary.status, "running");
  const errorPath = join(root, "error.ndjson");
  await appendProgressEvent(errorPath, { type: "error", reasonCode: "CONTROLLER_FAILED" });
  const failed = await waitForProgress(errorPath, { timeoutMs: 100, pollMs: 5 });
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary.status, "failed");

  const cancelPath = join(root, "cancel.ndjson");
  const controller = new AbortController();
  const pending = waitForProgress(cancelPath, { timeoutMs: 100, pollMs: 10, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.summary.status, "running");

  await writeFileSync(join(root, "malformed.ndjson"), "{not-json}\n");
  const malformed = await waitForProgress(join(root, "malformed.ndjson"), { timeoutMs: 100, pollMs: 5 });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.reasonCode, "PROGRESS_EVENT_INVALID");
});

// TCRN-CROSS-STORY-460 R3 (SUB-238): user-level Claude hooks run the engine working tree's
// own scripts, so in a live session the batch entry saw hook processes whose command line
// holds the engine's absolute path and counted them as running agents. A process running a
// hook script of the old harness (LEGACY_HOOK_SCRIPTS in the names module) or the injection
// child it starts is a host hook, not an agent; real agents are still seen. Red leg: drop the
// distinction.
test("STORY-460 AC4: running hook processes are host hooks, not running agents, and real agents still count", () => {
  const summarize = operationalBatchEntry.summarizeProcesses ?? ((rows) => ({ agents: { records: rows.map((row) => classifyProcess(row, { selfPid: 1 })).filter((row) => row.scope !== "unrelated" && row.scope !== "unknown") } }));
  // The old harness's knowledge hook and the injection child it starts, as a machine that has not
  // migrated still runs them from its old engine copy; their scripts are retired from this
  // repository (TCRN-CROSS-STORY-467 R3, STORY-477 R3) and named in the names module.
  const hooks = [
    `node ${REPOSITORY_ROOT}/scripts/knowledge-inject-hook.mjs --container-root /container --host claude`,
    `node ${REPOSITORY_ROOT}/scripts/knowledge-inject-hook.mjs --container-root /container --host codex`,
    `${process.execPath} ${REPOSITORY_ROOT}/scripts/knowledge-inject.mjs --hook-input {} --container-root /container --host claude`,
  ].map((command, index) => ({ pid: 200 + index, ppid: 1, pgid: 200 + index, state: "S", command }));
  const hookSummary = summarize(hooks, { selfPid: 1, selfPgid: null });
  assert.deepEqual(hookSummary.agents.records, [], "no hook process is a running agent");
  for (const row of hooks) assert.equal(classifyProcess(row, { selfPid: 1 }).role, "host-hook", row.command);
  const agent = { pid: 300, ppid: 1, pgid: 300, state: "S", command: `node ${REPOSITORY_ROOT}/scripts/einzbern.mjs work-create --workspace /tmp/workspace` };
  const task = { pid: 301, ppid: 1, pgid: 301, state: "S", command: `codex exec luna implement TCRN-CROSS-STORY-460 in ${REPOSITORY_ROOT}` };
  const withAgents = summarize([...hooks, agent, task], { selfPid: 1, selfPgid: null });
  assert.deepEqual(withAgents.agents.records.map((row) => row.pid).sort(), [300, 301], "a real agent is still seen");
});

// TCRN-CROSS-INC-384 (SUB-250): the old injection child reads the chain through the engine
// CLI, and in a live session that CLI process (its command line holds the engine path) still
// read as a running agent. Within one snapshot, a process under a host-hook ancestor is part
// of the hook; a governed write under a hook stays in writes, and an engine CLI read with no
// hook ancestor is still orchestration. Red leg: drop the ancestry.
function hookedSnapshot() {
  const cli = `${process.execPath} ${REPOSITORY_ROOT}/scripts/einzbern.mjs`;
  const workspace = "/container/.tcrn-workspace/cross-project/workspace";
  return [
    { pid: 500, ppid: 1, pgid: 500, state: "S", command: "claude" },
    { pid: 501, ppid: 500, pgid: 501, state: "S", command: `/bin/sh -c if [ -f "\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/scripts/knowledge-inject-hook.mjs" ]; then node "\${CLAUDE_PROJECT_DIR}/${LOCAL_DIRECTORY_NAMES.engine}/scripts/knowledge-inject-hook.mjs"; fi` },
    { pid: 502, ppid: 501, pgid: 501, state: "S", command: `node ${REPOSITORY_ROOT}/scripts/knowledge-inject-hook.mjs --container-root /container --host claude` },
    { pid: 503, ppid: 502, pgid: 501, state: "S", command: `${process.execPath} ${REPOSITORY_ROOT}/scripts/knowledge-inject.mjs --hook-input {} --container-root /container --host claude` },
    { pid: 504, ppid: 503, pgid: 501, state: "S", command: `${cli} settings-catalog --workspace ${workspace}` },
    { pid: 505, ppid: 503, pgid: 501, state: "S", command: `${cli} recall --workspace ${workspace} --query hook` },
  ];
}

test("INC-384: engine CLI reads started under a host hook are part of the hook, not running agents", () => {
  const summary = operationalBatchEntry.summarizeProcesses(hookedSnapshot(), { selfPid: 1, selfPgid: null });
  assert.deepEqual(summary.agents.records.map((row) => row.pid), [], "no hook-started read is a running agent");
  const reads = summary.scopeObservations.outOfScope.filter((row) => row.pid === 504 || row.pid === 505);
  assert.deepEqual(reads.map(({ pid, scope, role, active, scopeBasis, hookAncestorPid }) => ({ pid, scope, role, active, scopeBasis, hookAncestorPid })), [
    { pid: 504, scope: "unrelated", role: "host-hook", active: false, scopeBasis: "host-hook-descendant", hookAncestorPid: 503 },
    { pid: 505, scope: "unrelated", role: "host-hook", active: false, scopeBasis: "host-hook-descendant", hookAncestorPid: 503 },
  ]);
  assert.deepEqual(summary.writes.records, []);
});

test("INC-384: a governed write under a hook stays in writes and a read with no hook ancestor is still orchestration", () => {
  const cli = `${process.execPath} ${REPOSITORY_ROOT}/scripts/einzbern.mjs`;
  const workspace = "/container/.tcrn-workspace/cross-project/workspace";
  // The capture hook that started this write in a live session is retired
  // (TCRN-CROSS-STORY-467 R3). The rule is structural — any registered hook ancestor — so
  // the remaining handler stands in as the ancestor.
  const hookWrite = [
    { pid: 510, ppid: 500, pgid: 510, state: "S", command: `node ${REPOSITORY_ROOT}/scripts/knowledge-inject-hook.mjs --container-root /container --host claude` },
    { pid: 511, ppid: 510, pgid: 510, state: "S", command: `${cli} knowledge-capture --workspace ${workspace} --from-file /tmp/card.json` },
  ];
  const mainSessionRead = { pid: 520, ppid: 500, pgid: 520, state: "S", command: `${cli} work-show --workspace ${workspace} --id work:000000000000000000000384` };
  const orphanRead = { pid: 521, ppid: 9999, pgid: 521, state: "S", command: `${cli} status --workspace ${workspace}` };
  const loopA = { pid: 530, ppid: 531, pgid: 530, state: "S", command: `${cli} work-list --workspace ${workspace}` };
  const loopB = { pid: 531, ppid: 530, pgid: 530, state: "S", command: `${cli} status --workspace ${workspace}` };
  const summary = operationalBatchEntry.summarizeProcesses([...hookedSnapshot(), ...hookWrite, mainSessionRead, orphanRead, loopA, loopB], { selfPid: 1, selfPgid: null });
  assert.deepEqual(summary.writes.records.map((row) => row.pid), [511], "the batch still waits for a real write a hook started");
  assert.deepEqual(summary.agents.records.map((row) => [row.pid, row.role]).sort((left, right) => left[0] - right[0]), [[511, "orchestration"], [520, "orchestration"], [521, "orchestration"], [530, "orchestration"], [531, "orchestration"]], "no hook ancestor, a missing parent, or a parent cycle keeps the existing rule");
});

test("DOT-E01 native review uses the supported native evidence command and fails closed if unavailable", async () => {
  const { normalizeReviewDispatchEvidence } = await import("../scripts/review-evidence.mjs");
  const native = { attempt: { schemaVersion: "tcrn.native-tool-attempt.v1" } };
  const result = normalizeReviewDispatchEvidence(native, { workId: "work:fixture", workRevision: 1 }, join(REPOSITORY_ROOT, "missing-native-engine.mjs"));
  assert.equal(result.evidenceType, "native-tool"); assert.equal(result.valid, false); assert.equal(result.complete, false);
  assert.equal(result.problems.some(problem => /unavailable|unsupported/u.test(problem)), true);
});
