// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import test from "node:test";

import { applyEngineModelPolicySet, readEngineModelPolicyFile } from "../dist/build/packages/core/src/engine-model-policy.js";
import { DEFAULT_ENGINE_QUOTA_POLICY } from "../dist/build/packages/core/src/execution-policy.js";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { inspectKiroProcessPreparation, normalizeKiroProcessEvidence, recordKiroProcessEvidence } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { runNativeToolCommand, NATIVE_TOOL_COMMAND_CATALOG } from "../dist/build/packages/cli/src/native-tool-commands.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { buildKiroCliArgs, collectKiroProcess, run } from "../skill/mana-orchestrate/scripts/kiro-run.mjs";
import { nativeFixture, at } from "./helpers/host-native-fixture.mjs";

const modelTuple = { runner: "kiro-cli", model: "claude-haiku-4.5", effort: "default" };
const explicitSelection = { kind: "explicit", tuple: modelTuple };
const managedSelection = { kind: "host-managed" };

function kiroRequest(f, extra = {}) {
  return {
    ...f.request,
    capabilities: {
      ...f.request.capabilities, hostKind: "kiro-cli", toolName: "kiro-cli", selectionControl: "explicit",
      combinations: [modelTuple], requestedSelectionSupported: "supported", hostManagedSupported: true,
      ...(extra.capabilities ?? {}),
    },
    selection: explicitSelection,
    authorization: { ...f.request.authorization, hosts: [...f.request.authorization.hosts, "kiro-cli"], ...(extra.authorization ?? {}) },
    ...(extra.action === undefined ? {} : { action: extra.action }),
    ...(extra.fallbackSelection === undefined ? {} : { fallbackSelection: extra.fallbackSelection }),
    ...(extra.hardLimits === undefined ? {} : { hardLimits: extra.hardLimits }),
    ...(extra.sourceScope === undefined ? {} : { sourceScope: extra.sourceScope }),
  };
}

async function prepare(f, request = kiroRequest(f), selection = request.selection) {
  return prepareHostNativeDispatch(f.state, request, { selection, argumentsValue: { prompt: "fixture prompt; never sent to Kiro" } }, f.home);
}

function processReturn(preparation, values = {}) {
  return {
    schemaVersion: "tcrn.kiro-process-return.v1", source: "kiro-cli-process-return",
    preparationDigest: preparation.digest, attemptId: preparation.attempt.id,
    processStarted: true, processClosed: true, spawnError: null, launchBlock: null,
    startedAt: "2026-10-21T00:00:01.000Z", finishedAt: "2026-10-21T00:00:02.000Z",
    exitCode: 0, signal: null, stdout: "{\"type\":\"run\"}\n", stderr: "", cancellationRequested: false,
    ...values,
  };
}

async function configureKiroPolicy(f) {
  return applyEngineModelPolicySet({
    home: f.home, host: "kiro-cli", occurredAt: at, actor: "agent:fixture",
    authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId },
    policy: {
      categories: [{ id: "main", name: "Main", order: 10, description: "" }],
      tiers: [{ ...modelTuple, category: "main", order: 10, note: "" }],
      escalation: { enabled: false, threshold: 2, ceiling: "main" }, quota: DEFAULT_ENGINE_QUOTA_POLICY,
    },
  });
}

test("INIT085-B3: Kiro preparation checks tool scope, fallback, host capacity, configured quota, and explicit limits", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const policy = await readEngineModelPolicyFile(f.home);
  const allowed = await prepare(f);
  assert.notEqual(allowed.attempt, null);
  const preflight = inspectKiroProcessPreparation(allowed);
  assert.equal(preflight.status, "ready");
  assert.equal(preflight.requested.harness, "v3");
  assert.deepEqual(preflight.requested.model, { status: "requested", value: "claude-haiku-4.5" });
  assert.deepEqual(preflight.requested.effort, { status: "requested", value: "default" });

  const unavailable = await prepare(f, kiroRequest(f, { capabilities: { toolAvailable: false } }));
  assert.equal(unavailable.attempt, null);
  assert.equal(inspectKiroProcessPreparation(unavailable).status, "refused");

  const fullHost = await prepare(f, kiroRequest(f, { capabilities: { platformCapacity: { limit: 1, active: 1, includesParent: true, parentActive: true } } }));
  assert.equal(fullHost.attempt, null, "observed host capacity stops the current dispatch");

  const exhaustedQuota = await prepare(f, kiroRequest(f, { capabilities: { usage: { observedAt: new Date().toISOString(), fiveHourUsedPercent: 95 } } }));
  assert.equal(exhaustedQuota.attempt, null, "a configured current wait threshold is respected");

  const hardLimit = await prepare(f, kiroRequest(f, { hardLimits: { remainingCalls: 0 } }));
  assert.equal(hardLimit.attempt, null, "an explicit remaining-call limit is respected");

  const deniedSource = await prepare(f, kiroRequest(f, { action: "implementation", sourceScope: { repository: f.root, writableRoots: [f.root], permission: "unknown" } }));
  assert.equal(deniedSource.attempt, null, "implementation scope without granted permission is refused");

  const unsupported = kiroRequest(f, {
    fallbackSelection: managedSelection,
    capabilities: { requestedSelectionSupported: "unsupported" },
    authorization: { fallbackBoundaryAssessment: "unresolved" },
  });
  const unresolved = await prepare(f, unsupported, managedSelection);
  assert.equal(unresolved.attempt, null, "an unresolved fallback boundary does not become permission");
  assert.equal(inspectKiroProcessPreparation(unresolved).status, "refused");

  const covered = await prepare(f, kiroRequest(f, {
    fallbackSelection: managedSelection,
    capabilities: { requestedSelectionSupported: "unsupported" },
    authorization: { fallbackBoundaryAssessment: "covered" },
  }), managedSelection);
  assert.notEqual(covered.attempt, null, "covered same-host fallback remains usable");
  assert.equal(inspectKiroProcessPreparation(covered).requested.model.status, "unknown");
  assert.equal(inspectKiroProcessPreparation(covered).requested.effort.status, "unknown");
  assert.deepEqual(buildKiroCliArgs(inspectKiroProcessPreparation(covered)), ["chat", "--v3", "--no-interactive", "--output-format", "stream-json"]);
  assert.equal(policy.hosts["kiro-cli"].tiers[0].runner, "kiro-cli");
});

test("INIT085-B3: runner passes explicit V3 and requested tuple, sends prompt only on stdin, and separates process states", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const preparation = await prepare(f);
  const preflight = inspectKiroProcessPreparation(preparation);
  const args = buildKiroCliArgs(preflight);
  assert.deepEqual(args, ["chat", "--v3", "--no-interactive", "--output-format", "stream-json", "--model", "claude-haiku-4.5"]);
  assert.equal(args.includes("fixture prompt; never sent to Kiro"), false);
  let observed;
  const fakeSpawn = (executable, actualArgs, options) => {
    observed = { executable, actualArgs, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.emit("spawn");
      child.stdout.write("{\"type\":\"tool_call\"}\n");
      child.stderr.write("[denied] tool permission approval is not supported in non-interactive mode.\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 1, null);
    });
    return child;
  };
  const returned = await collectKiroProcess(preflight, { env: { KIRO_API_KEY: "fixture-secret" }, cwd: f.root, spawn: fakeSpawn });
  assert.equal(observed.executable, "kiro-cli");
  assert.deepEqual(observed.actualArgs, args);
  assert.equal(observed.options.shell, false);
  assert.equal(returned.processStarted, true);
  assert.equal(returned.processClosed, true);
  assert.equal(returned.exitCode, 1);
  assert.equal(returned.stderr.includes("fixture-secret"), false);
  const evidence = recordKiroProcessEvidence(preparation, returned);
  assert.equal(evidence.dispatch.status, "allowed");
  assert.equal(evidence.process.status, "exited-nonzero");
  assert.equal(evidence.refusal.status, "observed");
  assert.equal(evidence.refusal.kind, "permission-refused");
  assert.equal(evidence.serviceError.status, "unknown");
  assert.equal(evidence.actual.harness, "unknown");
  assert.equal(evidence.actual.model, "unknown");
  assert.equal(evidence.actual.effort, "unknown");
  assert.equal(evidence.actual.usage, "unknown");
  assert.equal(evidence.actual.taskFinality, "unknown");
  assert.equal(normalizeKiroProcessEvidence(evidence).digest, evidence.digest);
});

test("INIT085-B3: Kiro CLI auth failures, MCP service errors, cancellation, and task finality remain separate", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const preparation = await prepare(f);

  const service = recordKiroProcessEvidence(preparation, processReturn(preparation, { exitCode: 3, stderr: "required MCP server failed to start\n" }));
  assert.equal(service.process.status, "exited-nonzero");
  assert.equal(service.serviceError.status, "observed");
  assert.equal(service.serviceError.kind, "mcp-startup-failure");
  assert.equal(service.actual.taskFinality, "unknown");

  const cancelled = recordKiroProcessEvidence(preparation, processReturn(preparation, { cancellationRequested: true, exitCode: 0 }));
  assert.equal(cancelled.process.status, "exited-zero", "a local cancellation request does not rewrite the CLI process result");
  assert.equal(cancelled.cancellation.requested, true);
  assert.equal(cancelled.cancellation.signalObserved, null);
  assert.equal(cancelled.actual.taskFinality, "unknown");

  const refusedPreparation = await prepare(f, kiroRequest(f, { capabilities: { toolAvailable: false } }));
  const refused = recordKiroProcessEvidence(refusedPreparation);
  assert.equal(refused.dispatch.status, "refused");
  assert.equal(refused.refusal.status, "observed");
  assert.equal(refused.process.status, "not-started");
  assert.equal(refused.processReturn, null);
});

test("INIT085-B3: missing API key reaches Kiro CLI and records its authentication failure", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const preparation = await prepare(f);
  const preflight = inspectKiroProcessPreparation(preparation);
  const executable = join(f.root, "fake-kiro-cli");
  const source = [
    "#!/usr/bin/env node",
    "let input = \"\";",
    "for await (const chunk of process.stdin) input += chunk;",
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }) + \"\\n\");",
    "process.stderr.write(\"Authentication required\\n\");",
    "process.exitCode = 2;",
  ].join("\n");
  await writeFile(executable, `${source}\n`, { encoding: "utf8", mode: 0o700, flag: "wx" });
  const env = { PATH: process.env.PATH ?? "", HOME: f.root };
  assert.equal(Object.hasOwn(env, "KIRO_API_KEY"), false);

  const returned = await collectKiroProcess(preflight, { env, cwd: f.root, executable });
  assert.equal(returned.processStarted, true, "the runner invokes the CLI without a local API-key gate");
  assert.equal(returned.processClosed, true);
  assert.equal(returned.launchBlock, null);
  assert.equal(returned.exitCode, 2);
  assert.equal(returned.stderr, "Authentication required\n");
  const cliOutput = JSON.parse(returned.stdout);
  assert.deepEqual(cliOutput.argv, ["chat", "--v3", "--no-interactive", "--output-format", "stream-json", "--model", "claude-haiku-4.5"]);
  assert.equal(cliOutput.input, "fixture prompt; never sent to Kiro");

  const evidence = recordKiroProcessEvidence(preparation, returned);
  assert.equal(evidence.process.status, "exited-nonzero");
  assert.equal(evidence.process.exitCode, 2);
  assert.equal(evidence.process.stderr, "Authentication required\n");
  assert.equal(evidence.refusal.status, "not-observed-in-return");
  assert.equal(evidence.actual.model, "unknown");
  assert.equal(evidence.actual.effort, "unknown");
});

test("INIT085-B3: CLI exposes and records the Kiro preflight/process evidence contract", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const preparation = await prepare(f);
  const bindingPath = join(f.root, "binding.json");
  const processPath = join(f.root, "process.json");
  const outputPath = join(f.root, "evidence.json");
  await writeFile(bindingPath, `${JSON.stringify(preparation)}\n`);
  const commandNames = NATIVE_TOOL_COMMAND_CATALOG.map(command => command.name);
  assert.ok(commandNames.includes("execution-kiro-preflight"));
  assert.ok(commandNames.includes("execution-kiro-record"));
  assert.ok(commandNames.includes("execution-kiro-evidence"));
  for (const name of commandNames.filter(name => name.startsWith("execution-kiro-"))) assert.ok(COMMAND_CATALOG.some(command => command.name === name), `${name} is included in the public CLI catalog`);
  const context = { home: f.home, resolveWorkspace: async () => { throw new Error("Kiro evidence commands do not resolve a workspace"); } };
  const checked = await runNativeToolCommand("execution-kiro-preflight", { binding: bindingPath }, context);
  assert.equal(checked.status, "ready");
  const returned = processReturn(preparation);
  await writeFile(processPath, `${JSON.stringify(returned)}\n`);
  const recorded = await runNativeToolCommand("execution-kiro-record", { binding: bindingPath, result: processPath, output: outputPath }, context);
  assert.equal(recorded.process.status, "exited-zero");
  const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(fromDisk.digest, recorded.digest);
  const normalized = await runNativeToolCommand("execution-kiro-evidence", { "from-file": outputPath }, context);
  assert.equal(normalized.digest, recorded.digest);
});

test("INIT085-B3: runner reserves a private destination before spawning and retains real returns on persistence failure", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const preparation = await prepare(f);
  const binding = join(f.root, "runner-binding.json");
  await writeFile(binding, JSON.stringify(preparation));
  const context = { home: f.home, resolveWorkspace: async () => { throw new Error("unexpected workspace lookup"); } };
  const engine = async (command, args) => {
    const values = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    return runNativeToolCommand(command, values, context);
  };
  let calls = 0;
  const signals = new EventEmitter();
  const fakeSpawn = (_executable, _args, _options) => {
    calls += 1;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.emit("spawn");
      child.stdout.end('{"type":"fixture"}\n'); child.stderr.end(); child.emit("close", 0, null);
    });
    return child;
  };
  const options = { invokeEngine: engine, spawn: fakeSpawn, signals, env: { KIRO_API_KEY: "synthetic-fixture-secret" } };
  const existing = join(f.root, "existing.json");
  await writeFile(existing, "sentinel");
  await assert.rejects(run(["--binding", binding, "--output", existing], options), /EEXIST/u);
  await assert.rejects(run(["--binding", binding, "--output", join(f.workspace, "protected.json")], options), /outside device and library roots/u);
  assert.equal(calls, 0);
  assert.equal(await readFile(existing, "utf8"), "sentinel");

  const replaced = join(f.root, "replaced.json");
  const replacingEngine = async (command, args) => {
    const result = await engine(command, args);
    if (command === "execution-kiro-preflight") {
      await rm(result.reservation.destination);
      await writeFile(result.reservation.destination, "other owner", { flag: "wx" });
    }
    return result;
  };
  await assert.rejects(run(["--binding", binding, "--output", replaced], { ...options, invokeEngine: replacingEngine }), /reserved output changed/u);
  assert.equal(calls, 0);
  assert.equal(await readFile(replaced, "utf8"), "other owner");

  const raced = join(f.root, "race.json");
  const outcomes = await Promise.allSettled([run(["--binding", binding, "--output", raced], options), run(["--binding", binding, "--output", raced], options)]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.equal(calls, 1, "only the reservation owner can launch");
  const racedRecord = JSON.parse(await readFile(raced, "utf8"));
  assert.equal(normalizeKiroProcessEvidence(racedRecord).process.status, "exited-zero");
  assert.equal(JSON.stringify(racedRecord).includes("synthetic-fixture-secret"), false);
  assert.equal((await stat(raced)).mode & 0o777, 0o600);
  assert.equal((await readdir(f.root)).some(name => name.startsWith(".einzbern-kiro-run-")), false, "successful runs remove their private scratch directory");

  const failedOutput = join(f.root, "failed-output.json");
  let failure;
  try {
    await run(["--binding", binding, "--output", failedOutput], { ...options, writeEvidence: async () => { throw new Error("fixture persistence failure"); } });
    assert.fail("persistence failure must be reported");
  } catch (error) { failure = String(error.message); }
  const recovery = failure.match(/actual process return retained privately at (.+)$/u)?.[1];
  assert.ok(recovery, failure);
  assert.equal(failure.includes("synthetic-fixture-secret"), false);
  t.after(() => rm(dirname(recovery), { recursive: true, force: true }));
  const returned = JSON.parse(await readFile(recovery, "utf8"));
  assert.equal(returned.processStarted, true);
  assert.equal(returned.processClosed, true);
  assert.equal(returned.stdout, '{"type":"fixture"}\n');
  assert.equal((await stat(recovery)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(recovery))).mode & 0o777, 0o700);
  assert.equal(await readFile(failedOutput, "utf8"), "");
  assert.equal(await readFile(existing, "utf8"), "sentinel");
  const recovered = await runNativeToolCommand("execution-kiro-record", { binding, result: recovery, output: join(f.root, "recovered.json") }, context);
  assert.equal(recovered.process.status, "exited-zero");
  assert.equal(recovered.process.stdout, returned.stdout);

  const failedRecordOutput = join(f.root, "failed-record.json");
  let recordFailure;
  try {
    await run(["--binding", binding, "--output", failedRecordOutput], { ...options, invokeEngine: async (command, args) => {
      if (command === "execution-kiro-record") throw new Error("fixture engine persistence failure");
      return engine(command, args);
    } });
    assert.fail("engine persistence failure must be reported");
  } catch (error) { recordFailure = String(error.message); }
  const recordRecovery = recordFailure.match(/actual process return retained privately at (.+)$/u)?.[1];
  assert.ok(recordRecovery, recordFailure);
  t.after(() => rm(dirname(recordRecovery), { recursive: true, force: true }));
  const recoveredAfterEngineFailure = await runNativeToolCommand("execution-kiro-record", { binding, result: recordRecovery, output: join(f.root, "recovered-engine.json") }, context);
  assert.equal(recoveredAfterEngineFailure.process.status, "exited-zero");
  assert.equal(await readFile(failedRecordOutput, "utf8"), "");

  const swappedOutput = join(f.root, "swapped-after-launch.json");
  let swappedFailure;
  try {
    await run(["--binding", binding, "--output", swappedOutput], { ...options, writeEvidence: async (file, value) => {
      await rm(swappedOutput);
      await writeFile(swappedOutput, "new owner", { flag: "wx" });
      await file.writeFile(value, "utf8");
    } });
    assert.fail("destination swap must be reported");
  } catch (error) { swappedFailure = String(error.message); }
  const swappedRecovery = swappedFailure.match(/actual process return retained privately at (.+)$/u)?.[1];
  assert.ok(swappedRecovery, swappedFailure);
  t.after(() => rm(dirname(swappedRecovery), { recursive: true, force: true }));
  assert.equal(JSON.parse(await readFile(swappedRecovery, "utf8")).processClosed, true);
  assert.equal(await readFile(swappedOutput, "utf8"), "new owner");
});

test("INIT085-B3: reserved runner preserves refusal, nonzero and cancellation facts", async t => {
  const f = await nativeFixture(t);
  await configureKiroPolicy(f);
  const ready = await prepare(f);
  const refused = await prepare(f, kiroRequest(f, { capabilities: { toolAvailable: false } }));
  const context = { home: f.home, resolveWorkspace: async () => { throw new Error("unexpected workspace lookup"); } };
  const engine = async (command, args) => runNativeToolCommand(command, Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]])), context);
  let calls = 0;
  const signals = new EventEmitter();
  const spawnFor = mode => () => {
    calls += 1;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => {
      child.emit("spawn");
      if (mode === "cancel") signals.emit("SIGINT");
      child.stdout.end(); child.stderr.end(mode === "denied" ? "[denied] tool permission approval is not supported in non-interactive mode.\n" : "");
      child.emit("close", mode === "cancel" ? null : 1, mode === "cancel" ? "SIGINT" : null);
    });
    return child;
  };
  for (const [name, preparation, mode] of [["refused", refused, "denied"], ["denied", ready, "denied"], ["cancel", ready, "cancel"]]) {
    const binding = join(f.root, `${name}-binding.json`); const output = join(f.root, `${name}-evidence.json`);
    await writeFile(binding, JSON.stringify(preparation));
    const result = await run(["--binding", binding, "--output", output], { invokeEngine: engine, spawn: spawnFor(mode), signals });
    assert.equal(JSON.parse(await readFile(output, "utf8")).digest, result.digest);
    if (name === "refused") { assert.equal(result.dispatch.status, "refused"); assert.equal(result.process.status, "not-started"); }
    if (name === "denied") { assert.equal(result.process.status, "exited-nonzero"); assert.equal(result.refusal.kind, "permission-refused"); }
    if (name === "cancel") { assert.equal(result.cancellation.requested, true); assert.equal(result.process.signal, "SIGINT"); }
  }
  assert.equal(calls, 2, "a refused preflight never launches the fake CLI");
});
