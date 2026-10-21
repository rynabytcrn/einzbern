// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { recordHostNativeEvents, normalizeHostNativeRecord } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { workProjectContexts } from "../dist/build/packages/core/src/project-chain.js";
import { runNativeToolCommand } from "../dist/build/packages/cli/src/native-tool-commands.js";
import { nativeFixture, selection } from "./helpers/host-native-fixture.mjs";
const report = at => ({ id: "report", at, kind: "work-report", report: { summary: "Fixture decomposition delivered", contextReads: ["fixture:AGENTS", "fixture:Skill"], artifacts: ["fixture:decomposition"], checks: [], limitations: ["Synthetic fixture, not real-host acceptance"] } });
const response = (at, state = "completed") => ({ id: `host-${state}`, at, kind: "host-response", sourceTool: "fixture.spawn", raw: { state, terminal: true }, status: { pointer: "/state", mapping: { [state]: state } }, terminal: { pointer: "/terminal", values: ["true"], contract: "Fixture terminal response contract" } });
async function prepared(t, extra = {}) { const f = await nativeFixture(t); const p = await prepareHostNativeDispatch(f.state, { ...f.request, ...extra }, { selection, argumentsValue: { prompt: "Read required context, then deliver decomposition report." } }, f.home); return { ...f, p }; }
test("T01 fixture retains INIT-064 coordination-only targets=[] through prepare/report/review", async t => {
  const f = await prepared(t); assert.ok(f.p.attempt); assert.deepEqual(f.p.context.involvedProjects, { state: "coordination-only", targets: [] });
  assert.equal(f.p.context.dispatchAdmitted, true); assert.equal(f.p.context.developmentReady, false); assert.equal(f.p.decision.additionalConfirmationsRequired, false); assert.equal(f.p.decision.persistentConfigWrites, 0);
  const at = new Date().toISOString();
  const pending = recordHostNativeEvents(f.p, [report(at)]);
  assert.equal(pending.taskOutcome, "delivered-awaiting-review"); assert.equal(pending.executionFinality, "unknown"); assert.equal(pending.occupancy, "retained-or-unknown");
  const done = recordHostNativeEvents(f.p, [response(at), { id: "review", at, kind: "review", review: { status: "pass", reviewer: "fixture:independent", evidence: ["fixture:artifact-check"] } }], pending);
  assert.equal(done.taskOutcome, "accepted-by-review"); assert.equal(done.execution, "completed"); assert.equal(done.processFields, "not-applicable"); assert.equal(done.actualSelection.status, "unknown"); assert.equal(done.evidenceQuality, "limited"); assert.equal(normalizeHostNativeRecord(done).digest, done.digest);
  assert.equal("stdout" in done, false); assert.equal("exitCode" in done, false);
});
test("parent dispatch preparation and child work readiness are separate; source scope is action-specific", async t => {
  const f = await prepared(t); assert.ok(f.p.attempt);
  const tool = { selection, argumentsValue: { prompt: "Fixture" } };
  assert.equal((await prepareHostNativeDispatch(f.state, { ...f.request, phase: "work" }, tool, f.home)).attempt, null);
  assert.equal((await prepareHostNativeDispatch(f.state, { ...f.request, action: "implementation" }, tool, f.home)).attempt, null);
  const request = { ...f.request, action: "implementation", phase: "work", context: { parent: "read", child: "read" }, sourceScope: { repository: "fixture:repository", writableRoots: [f.root], permission: "granted" } };
  assert.ok((await prepareHostNativeDispatch(f.state, request, tool, f.home)).attempt);
  assert.deepEqual(f.state.work[0].involvedProjects.targets, []);
  assert.equal((await prepareHostNativeDispatch(f.state, { ...request, sourceScope: { ...request.sourceScope, permission: "denied" } }, tool, f.home)).attempt, null);
});
test("T13 cancel requested/accepted retain occupancy until terminal and completion wins cancellation race", async t => {
  const f = await prepared(t); const at = new Date().toISOString();
  const cancelling = recordHostNativeEvents(f.p, [{ id: "cancel-request", at, kind: "cancel-requested" }, { id: "cancel-ack", at, kind: "cancel-accepted", sourceTool: "fixture.cancel", raw: { accepted: true } }]);
  assert.deepEqual(cancelling.cancellation, { requested: true, accepted: true }); assert.equal(cancelling.executionFinality, "unknown"); assert.equal(cancelling.occupancy, "retained-or-unknown"); assert.equal(cancelling.followup, "required");
  const completed = recordHostNativeEvents(f.p, [response(at)], cancelling);
  assert.equal(completed.execution, "completed"); assert.equal(completed.occupancy, "released");
  const late = { id: "late", at, kind: "host-response", sourceTool: "fixture.spawn", raw: { state: "accepted" }, status: { pointer: "/state", mapping: { accepted: "accepted" } } };
  assert.equal(recordHostNativeEvents(f.p, [late], completed).execution, "completed");
  assert.equal(recordHostNativeEvents(f.p, [response(at, "cancelled")], completed).executionFinality, "unknown");
  assert.equal(recordHostNativeEvents(f.p, [response(at)], completed).events.length, completed.events.length);
});
test("native recorder rejects fabricated host/process fields, wrong tool and digest tampering", async t => {
  const f = await prepared(t); const at = new Date().toISOString();
  assert.throws(() => recordHostNativeEvents(f.p, [{ ...response(at), stdout: "synthetic" }]));
  assert.throws(() => recordHostNativeEvents(f.p, [{ ...response(at), sourceTool: "wrong" }]));
  assert.throws(() => recordHostNativeEvents(f.p, [{ ...report(at), raw: { state: "completed" } }]));
  const r = recordHostNativeEvents(f.p, [report(at)]);
  assert.throws(() => normalizeHostNativeRecord({ ...r, executionFinality: "confirmed" }));
  assert.throws(() => recordHostNativeEvents({ ...f.p, digest: "wrong" }, []));
});
test("T15 real CLI handler routes general context/prepare/record/evidence without selected target", async t => {
  const f = await nativeFixture(t); const requestPath = join(f.root, "request.json"), argsPath = join(f.root, "args.json"), binding = join(f.root, "binding.json"), events = join(f.root, "events.json"), output = join(f.root, "record.json");
  await writeFile(requestPath, JSON.stringify(f.request)); await writeFile(argsPath, JSON.stringify({ selection, argumentsValue: { prompt: "Fixture" } }));
  const context = { home: f.home, resolveWorkspace: async () => ({ root: f.workspace, state: f.state }) };
  const prepared = await runNativeToolCommand("execution-host-prepare", { workspace: f.workspace, request: requestPath, arguments: argsPath, output: binding }, context);
  assert.equal(prepared.reasonCode, "HOST_PREPARATION_READY");
  assert.equal((await workProjectContexts(f.state, f.work.id, f.home, f.request)).dispatchAdmitted, true);
  await writeFile(events, JSON.stringify([report(new Date().toISOString())]));
  const recorded = await runNativeToolCommand("execution-host-record", { binding, events, output }, context);
  assert.equal(recorded.validation.status, "valid"); assert.equal(recorded.taskOutcome, "delivered-awaiting-review");
  const evidence = await runNativeToolCommand("execution-host-evidence", { "from-file": output }, context);
  assert.equal(evidence.digest, recorded.digest); assert.equal(JSON.parse(await readFile(binding, "utf8")).context.involvedProjects.targets.length, 0);
});
test("Codex, Claude and dot use general path without dot impersonation; dot ignores unrelated model policy", async t => {
  const f = await nativeFixture(t);
  for (const hostKind of ["claude", "dot"]) {
    if (hostKind === "dot") { await mkdir(f.home, { recursive: true }); await writeFile(join(f.home, "engine-model-policy.json"), "{corrupt unrelated policy"); }
    const chosen = hostKind === "dot" ? { kind: "host-managed" } : { kind: "explicit", tuple: { runner: "claude-code", model: "fixture-claude", effort: "high" } };
    const request = { ...f.request, selection: chosen, capabilities: { ...f.request.capabilities, hostKind, selectionControl: hostKind === "dot" ? "host-managed" : "explicit" } };
    const p = await prepareHostNativeDispatch(f.state, request, { selection: chosen, argumentsValue: { prompt: "Fixture" } }, f.home);
    assert.ok(p.attempt); assert.equal(p.decision.policyStatus, hostKind === "dot" ? "not-applicable" : "unconfigured");
  }
});
