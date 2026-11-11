// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import test from "node:test";

import { applyEngineModelPolicySet, readEngineModelPolicyFile, resolveEngineExecutionPolicy } from "../dist/build/packages/core/src/engine-model-policy.js";
import { DEFAULT_ENGINE_QUOTA_POLICY } from "../dist/build/packages/core/src/execution-policy.js";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import {
  inspectAntigravityProcessPreparation,
  normalizeAntigravityProcessEvidence,
  normalizeHostNativeRecord,
  recordAntigravityProcessEvidence,
  recordHostNativeEvents,
} from "../dist/build/packages/core/src/native-tool-evidence.js";
import { runNativeToolCommand, NATIVE_TOOL_COMMAND_CATALOG } from "../dist/build/packages/cli/src/native-tool-commands.js";
import { COMMAND_CATALOG } from "../dist/build/packages/cli/src/index.js";
import {
  buildAntigravityCliArgs,
  buildAntigravityStdinPayload,
  collectAntigravityProcess,
  run,
} from "../skill/mana-orchestrate/scripts/agy-run.mjs";
import { nativeFixture, at } from "./helpers/host-native-fixture.mjs";

const mainTuple = { runner: "antigravity", model: "gemini-4-carbon-medium", effort: "medium" };
const economyTuple = { runner: "antigravity", model: "gemini-3.8-flash-medium", effort: "medium" };
const defaultEffortTuple = { runner: "antigravity", model: "gemini-3.8-flash-medium", effort: "default" };
const explicitMain = { kind: "explicit", tuple: mainTuple };
const explicitEconomy = { kind: "explicit", tuple: economyTuple };
const managedSelection = { kind: "host-managed" };

function antigravityRequest(f, extra = {}) {
  const selection = extra.selection ?? explicitMain;
  return {
    ...f.request,
    capabilities: {
      ...f.request.capabilities,
      hostKind: "antigravity",
      toolName: "agy",
      selectionControl: "explicit",
      combinations: [mainTuple, economyTuple, defaultEffortTuple],
      requestedSelectionSupported: "supported",
      hostManagedSupported: true,
      ...(extra.capabilities ?? {}),
    },
    selection,
    authorization: {
      ...f.request.authorization,
      hosts: [...f.request.authorization.hosts, "antigravity"],
      ...(extra.authorization ?? {}),
    },
    ...(extra.category === undefined ? {} : { category: extra.category }),
    ...(extra.action === undefined ? {} : { action: extra.action }),
    ...(extra.fallbackSelection === undefined ? {} : { fallbackSelection: extra.fallbackSelection }),
    ...(extra.hardLimits === undefined ? {} : { hardLimits: extra.hardLimits }),
    ...(extra.sourceScope === undefined ? {} : { sourceScope: extra.sourceScope }),
  };
}

async function prepare(
  f,
  request = antigravityRequest(f),
  selection = request.selection,
  prompt = "fixture prompt / 中文\nsecond line",
) {
  return prepareHostNativeDispatch(f.state, request, { selection, argumentsValue: { prompt } }, f.home);
}

function processReturn(preparation, values = {}) {
  return {
    schemaVersion: "tcrn.antigravity-process-return.v1",
    source: "agy-cli-process-return",
    preparationDigest: preparation.digest,
    attemptId: preparation.attempt.id,
    processStarted: true,
    processClosed: true,
    spawnError: null,
    launchBlock: null,
    startedAt: "2026-10-21T00:00:01.000Z",
    finishedAt: "2026-10-21T00:00:02.000Z",
    exitCode: 0,
    signal: null,
    stdout: "{\"type\":\"message\"}\n",
    stderr: "",
    cancellationRequested: false,
    ...values,
  };
}

async function configureAntigravityPolicy(f) {
  return applyEngineModelPolicySet({
    home: f.home,
    host: "antigravity",
    occurredAt: at,
    actor: "agent:fixture",
    authorization: { target: "models.engine-policy", decidedIn: `minutes:${"b".repeat(24)}#D2`, libraryId: f.state.metadata.workspaceId },
    policy: {
      categories: [
        { id: "flagship", name: "Flagship", order: 10, description: "" },
        { id: "main", name: "Main", order: 20, description: "" },
        { id: "economy", name: "Economy", order: 30, description: "" },
      ],
      tiers: [
        { ...mainTuple, category: "main", order: 20, note: "" },
        { ...economyTuple, category: "economy", order: 30, note: "" },
      ],
      escalation: { enabled: true, threshold: 2, ceiling: "main" },
      quota: DEFAULT_ENGINE_QUOTA_POLICY,
    },
  });
}

test("INIT091-B1: interactive invoke_subagent and device model policy resolve main/economy tiers and escalation on antigravity", async (t) => {
  const f = await nativeFixture(t);
  await configureAntigravityPolicy(f);
  const policy = await readEngineModelPolicyFile(f.home);
  assert.equal(policy.hosts.antigravity.tiers.length, 2);

  const economyResolved = await resolveEngineExecutionPolicy({ home: f.home, host: "antigravity", category: "economy", rejections: 0 });
  assert.equal(economyResolved.record.model, "gemini-3.8-flash-medium");
  assert.equal(economyResolved.record.effort, "medium");

  const escalated = await resolveEngineExecutionPolicy({ home: f.home, host: "antigravity", category: "economy", rejections: 2 });
  assert.equal(escalated.record.model, "gemini-4-carbon-medium");
  assert.equal(escalated.steps, 1);

  const subagentReq = antigravityRequest(f, {
    category: "economy",
    selection: explicitEconomy,
    fallbackSelection: managedSelection,
    capabilities: {
      toolName: "invoke_subagent",
      selectionControl: "host-managed",
      requestedSelectionSupported: "unsupported",
    },
    authorization: { fallbackBoundaryAssessment: "covered" },
  });
  const subagentPrep = await prepareHostNativeDispatch(
    f.state,
    subagentReq,
    { selection: managedSelection, argumentsValue: { TypeName: "self", Role: "Implementer", Prompt: "fixture task" } },
    f.home,
  );
  assert.notEqual(subagentPrep.attempt, null);
  const recorded = recordHostNativeEvents(subagentPrep, [
    {
      id: "ev-1",
      at: new Date().toISOString(),
      kind: "work-report",
      report: {
        summary: "fixture subagent report",
        contextReads: ["work:fixture"],
        artifacts: [],
        checks: ["unit-pass"],
        limitations: [],
      },
    },
  ]);
  assert.equal(normalizeHostNativeRecord(recorded).digest, recorded.digest);
});

test("INIT091-B2: Antigravity CLI preparation checks tool scope, fallback, capacity, quota, and explicit limits", async (t) => {
  const f = await nativeFixture(t);
  await configureAntigravityPolicy(f);
  const allowed = await prepare(f);
  assert.notEqual(allowed.attempt, null);
  const preflight = inspectAntigravityProcessPreparation(allowed);
  assert.equal(preflight.status, "ready");
  assert.equal(preflight.requested.surface, "agy-print");
  assert.deepEqual(preflight.requested.model, { status: "requested", value: "gemini-4-carbon-medium" });
  assert.deepEqual(preflight.requested.effort, { status: "requested", value: "medium" });

  // Wrong toolName (e.g. invoke_subagent passed to CLI preflight) is rejected.
  const wrongTool = await prepare(f, antigravityRequest(f, { capabilities: { toolName: "invoke_subagent" } }));
  assert.throws(() => inspectAntigravityProcessPreparation(wrongTool), /toolName agy/u);

  const unavailable = await prepare(f, antigravityRequest(f, { capabilities: { toolAvailable: false } }));
  assert.equal(unavailable.attempt, null);
  assert.equal(inspectAntigravityProcessPreparation(unavailable).status, "refused");

  const fullHost = await prepare(f, antigravityRequest(f, { capabilities: { platformCapacity: { limit: 1, active: 1, includesParent: true, parentActive: true } } }));
  assert.equal(fullHost.attempt, null);

  const exhaustedQuota = await prepare(f, antigravityRequest(f, { capabilities: { usage: { observedAt: new Date().toISOString(), fiveHourUsedPercent: 95 } } }));
  assert.equal(exhaustedQuota.attempt, null);

  const hardLimit = await prepare(f, antigravityRequest(f, { hardLimits: { remainingCalls: 0 } }));
  assert.equal(hardLimit.attempt, null);

  const covered = await prepare(f, antigravityRequest(f, {
    fallbackSelection: managedSelection,
    capabilities: { requestedSelectionSupported: "unsupported" },
    authorization: { fallbackBoundaryAssessment: "covered" },
  }), managedSelection);
  assert.notEqual(covered.attempt, null);
  assert.deepEqual(buildAntigravityCliArgs(inspectAntigravityProcessPreparation(covered)), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ]);

  const unconfiguredHome = join(f.root, "unconfigured-device");
  const defaultEffortPrep = await prepareHostNativeDispatch(
    f.state,
    antigravityRequest(f, { selection: { kind: "explicit", tuple: defaultEffortTuple } }),
    { selection: { kind: "explicit", tuple: defaultEffortTuple }, argumentsValue: { prompt: "fixture prompt" } },
    unconfiguredHome,
  );
  assert.deepEqual(
    buildAntigravityCliArgs(inspectAntigravityProcessPreparation(defaultEffortPrep)),
    ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.8-flash-medium"],
  );
});

test("INIT091-B2: agy-run uses stream-json input/output protocol, preserves multiline/Chinese prompt and model/effort, never skips permissions, and keeps actual.* unknown", async (t) => {
  const f = await nativeFixture(t);
  await configureAntigravityPolicy(f);
  const expectedPrompt = "fixture prompt / 中文\nsecond line";
  const preparation = await prepare(f, antigravityRequest(f), explicitMain, expectedPrompt);
  const preflight = inspectAntigravityProcessPreparation(preparation);
  const args = buildAntigravityCliArgs(preflight);
  assert.deepEqual(args, [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    "gemini-4-carbon-medium",
    "--effort",
    "medium",
  ]);
  assert.equal(args.includes("--print"), false);
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.some((arg) => arg.includes("fixture prompt")), false);

  const stdinPayload = buildAntigravityStdinPayload(expectedPrompt);
  assert.equal(stdinPayload.endsWith("\n"), true);
  assert.equal(stdinPayload.trimEnd().includes("\n"), false, "NDJSON message must be encoded on a single line");
  assert.deepEqual(JSON.parse(stdinPayload), { event: "user", message: { content: expectedPrompt } });

  // Strict protocol-parsing probe matching official agy 1.5.5 CLI flag + stream-json stdin behavior without live network calls.
  const executable = join(f.root, "strict-agy-probe");
  const script = [
    "#!/usr/bin/env node",
    "const argv = process.argv.slice(2);",
    "let printPrompt = null;",
    "let inputFormat = null;",
    "let outputFormat = null;",
    "let model = null;",
    "let effort = null;",
    "const positionals = [];",
    "for (let i = 0; i < argv.length; i += 1) {",
    "  const arg = argv[i];",
    "  if (arg === '--print' || arg === '-p') {",
    "    const next = argv[i + 1];",
    "    if (next === undefined) { process.stderr.write('Error: --print requires a prompt value\\n'); process.exit(2); }",
    "    printPrompt = next; i += 1;",
    "    if (next.startsWith('-')) {",
    "      process.stderr.write(`Error: --print took ${JSON.stringify(next)} as its prompt, so the intended prompt was left as an argument and ignored.\\n`);",
    "      process.exit(2);",
    "    }",
    "  } else if (arg.startsWith('--print=')) {",
    "    printPrompt = arg.slice('--print='.length);",
    "  } else if (arg === '--input-format') {",
    "    inputFormat = argv[++i] ?? null;",
    "  } else if (arg === '--output-format') {",
    "    outputFormat = argv[++i] ?? null;",
    "  } else if (arg === '--model' || arg === '-m') {",
    "    model = argv[++i] ?? null;",
    "  } else if (arg === '--effort') {",
    "    effort = argv[++i] ?? null;",
    "  } else if (arg.startsWith('-')) {",
    "    process.stderr.write(`Error: unknown or forbidden flag ${arg}\\n`);",
    "    process.exit(2);",
    "  } else {",
    "    positionals.push(arg);",
    "  }",
    "}",
    "if (printPrompt !== null && inputFormat === 'stream-json') {",
    "  process.stderr.write('Error: --print cannot be combined with --input-format stream-json\\n');",
    "  process.exit(2);",
    "}",
    "if (positionals.length > 0 || inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {",
    "  process.stderr.write(`Error: invalid stream-json invocation: input=${String(inputFormat)} output=${String(outputFormat)} positionals=${JSON.stringify(positionals)}\\n`);",
    "  process.exit(2);",
    "}",
    "let raw = '';",
    "process.stdin.setEncoding('utf8');",
    "for await (const chunk of process.stdin) raw += chunk;",
    "if (!raw.endsWith('\\n')) { process.stderr.write('Error: stream-json stdin must end with newline\\n'); process.exit(2); }",
    "const lines = raw.split('\\n').filter((line) => line.length > 0);",
    "if (lines.length !== 1) { process.stderr.write(`Error: expected 1 user event, received ${lines.length}\\n`); process.exit(2); }",
    "let parsed;",
    "try { parsed = JSON.parse(lines[0]); } catch { process.stderr.write('Error: invalid JSON on stdin\\n'); process.exit(2); }",
    "if (parsed?.event !== 'user' || typeof parsed?.message?.content !== 'string' || Object.keys(parsed).length !== 2 || Object.keys(parsed.message).length !== 1) {",
    "  process.stderr.write('Error: malformed stream-json user message\\n');",
    "  process.exit(2);",
    "}",
    "process.stdout.write(JSON.stringify({ type: 'init', session_id: 'probe-session' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', status: 'probe_observed', receivedCount: lines.length, content: parsed.message.content, model, effort }) + '\\n');",
    "if (process.env.PROBE_EXIT_CODE === '1') {",
    "  process.stderr.write('Tool permission denied in non-interactive mode\\n');",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  await writeFile(executable, `${script}\n`, { encoding: "utf8", mode: 0o700, flag: "wx" });

  // Regression guard: confirm the probe rejects the legacy broken `--print --output-format stream-json` argv with exit 2.
  const brokenProbe = spawnSync(executable, ["--print", "--output-format", "stream-json"], {
    encoding: "utf8",
    input: expectedPrompt,
  });
  assert.equal(brokenProbe.status, 2);
  assert.match(brokenProbe.stderr, /--print took "--output-format" as its prompt/u);

  const okReturned = await collectAntigravityProcess(preflight, {
    env: { PATH: process.env.PATH ?? "", HOME: f.root },
    cwd: f.root,
    executable,
  });
  assert.equal(okReturned.exitCode, 0, okReturned.stderr);
  const outEvents = okReturned.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(outEvents.length, 2);
  assert.deepEqual(outEvents[1], {
    type: "result",
    status: "probe_observed",
    receivedCount: 1,
    content: expectedPrompt,
    model: "gemini-4-carbon-medium",
    effort: "medium",
  });

  const nonzeroReturned = await collectAntigravityProcess(preflight, {
    env: { PATH: process.env.PATH ?? "", HOME: f.root, PROBE_EXIT_CODE: "1" },
    cwd: f.root,
    executable,
  });
  assert.equal(nonzeroReturned.processStarted, true);
  assert.equal(nonzeroReturned.processClosed, true);
  assert.equal(nonzeroReturned.exitCode, 1);

  const evidence = recordAntigravityProcessEvidence(preparation, nonzeroReturned);
  assert.equal(evidence.dispatch.status, "allowed");
  assert.equal(evidence.process.status, "exited-nonzero");
  assert.equal(evidence.refusal.status, "not-observed-in-return");
  assert.equal(evidence.refusal.kind, null);
  assert.equal(evidence.actual.surface, "unknown");
  assert.equal(evidence.actual.model, "unknown");
  assert.equal(evidence.actual.effort, "unknown");
  assert.equal(evidence.actual.usage, "unknown");
  assert.equal(evidence.actual.taskFinality, "unknown");
  assert.equal(normalizeAntigravityProcessEvidence(evidence).digest, evidence.digest);
});

test("INIT091-B2: CLI exposes execution-antigravity-{preflight,record,evidence} and runner reserves output + retains private recovery", async (t) => {
  const f = await nativeFixture(t);
  await configureAntigravityPolicy(f);
  const preparation = await prepare(f);
  const binding = join(f.root, "binding.json");
  await writeFile(binding, `${JSON.stringify(preparation)}\n`);

  const commandNames = NATIVE_TOOL_COMMAND_CATALOG.map((cmd) => cmd.name);
  for (const name of ["execution-antigravity-preflight", "execution-antigravity-record", "execution-antigravity-evidence"]) {
    assert.ok(commandNames.includes(name));
    assert.ok(COMMAND_CATALOG.some((cmd) => cmd.name === name));
  }

  const context = { home: f.home, resolveWorkspace: async () => { throw new Error("unexpected workspace lookup"); } };
  const engine = async (command, args) => {
    const values = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    return runNativeToolCommand(command, values, context);
  };

  let calls = 0;
  const signals = new EventEmitter();
  const fakeSpawn = (_executable, spawnArgs, options) => {
    calls += 1;
    assert.equal(options.shell, false);
    assert.deepEqual(spawnArgs.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let stdinText = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => { stdinText += chunk; });
    child.stdin.on("end", () => {
      const lines = stdinText.split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.event, "user");
      assert.equal(parsed.message.content, "fixture prompt / 中文\nsecond line");
      setImmediate(() => {
        child.emit("spawn");
        child.stdout.end("{\"type\":\"result\",\"status\":\"success\"}\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
    });
    return child;
  };
  const options = { invokeEngine: engine, spawn: fakeSpawn, signals, env: {} };

  const existing = join(f.root, "existing.json");
  await writeFile(existing, "sentinel");
  await assert.rejects(run(["--binding", binding, "--output", existing], options), /EEXIST/u);
  await assert.rejects(run(["--binding", binding, "--output", join(f.workspace, "inside-library.json")], options), /outside device and library roots/u);
  assert.equal(calls, 0);

  const raced = join(f.root, "raced.json");
  const outcomes = await Promise.allSettled([run(["--binding", binding, "--output", raced], options), run(["--binding", binding, "--output", raced], options)]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
  assert.equal(calls, 1);
  const racedEvidence = JSON.parse(await readFile(raced, "utf8"));
  assert.equal((await runNativeToolCommand("execution-antigravity-evidence", { "from-file": raced }, context)).digest, racedEvidence.digest);
  assert.equal((await stat(raced)).mode & 0o777, 0o600);
  assert.equal((await readdir(f.root)).some((name) => name.startsWith(".einzbern-agy-run-")), false);

  const failedOutput = join(f.root, "failed-output.json");
  let failureMessage = "";
  try {
    await run(["--binding", binding, "--output", failedOutput], { ...options, writeEvidence: async () => { throw new Error("disk error"); } });
    assert.fail("expected persistence error");
  } catch (error) {
    failureMessage = String(error.message);
  }
  const recovery = failureMessage.match(/actual process return retained privately at (.+)$/u)?.[1];
  assert.ok(recovery, failureMessage);
  t.after(() => rm(dirname(recovery), { recursive: true, force: true }));
  const recovered = await runNativeToolCommand("execution-antigravity-record", { binding, result: recovery, output: join(f.root, "recovered.json") }, context);
  assert.equal(recovered.process.status, "exited-zero");

  // Refused preflight & signal cancellation.
  const refused = await prepare(f, antigravityRequest(f, { capabilities: { toolAvailable: false } }));
  const refusedBinding = join(f.root, "refused-binding.json");
  const refusedOutput = join(f.root, "refused-evidence.json");
  await writeFile(refusedBinding, JSON.stringify(refused));
  const callsBeforeRefused = calls;
  const refusedResult = await run(["--binding", refusedBinding, "--output", refusedOutput], options);
  assert.equal(refusedResult.dispatch.status, "refused");
  assert.equal(refusedResult.process.status, "not-started");
  assert.equal(calls, callsBeforeRefused, "refused preflight does not spawn agy");

  const cancelSignals = new EventEmitter();
  const cancelSpawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.emit("spawn");
      cancelSignals.emit("SIGINT");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, "SIGINT");
    });
    return child;
  };
  const cancelledOutput = join(f.root, "cancelled-evidence.json");
  const cancelledResult = await run(["--binding", binding, "--output", cancelledOutput], { invokeEngine: engine, spawn: cancelSpawn, signals: cancelSignals });
  assert.equal(cancelledResult.cancellation.requested, true);
  assert.equal(cancelledResult.process.signal, "SIGINT");
  assert.equal(cancelledResult.actual.taskFinality, "unknown");
});
