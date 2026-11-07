// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import test from "node:test";

import { applyEngineModelPolicySet, readEngineModelPolicyFile } from "../dist/build/packages/core/src/engine-model-policy.js";
import { DEFAULT_ENGINE_QUOTA_POLICY } from "../dist/build/packages/core/src/execution-policy.js";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { inspectKiroProcessPreparation, normalizeKiroProcessEvidence, recordKiroProcessEvidence } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { runNativeToolCommand, NATIVE_TOOL_COMMAND_CATALOG } from "../dist/build/packages/cli/src/native-tool-commands.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import { buildKiroCliArgs, collectKiroProcess } from "../skill/mana-orchestrate/scripts/kiro-run.mjs";
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
