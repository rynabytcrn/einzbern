// SPDX-License-Identifier: Apache-2.0
// Deterministic receipt-consumer fixtures. No Codex host, RPC, wake or live peer test.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareHostNativeDispatch } from "../dist/build/packages/core/src/dispatch-workflow.js";
import { recordHostNativeEvents } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { applyEngineModelPolicySet, engineModelPolicyOnboarding } from "../dist/build/packages/core/src/engine-model-policy.js";
import { recordCodexPeerBatch as recordAtCutoff, normalizeCodexPeerBatch, codexPeerReportPrefix } from "../dist/build/packages/core/src/codex-peer-batch.js";
import { canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { nativeFixture, selection, codexGuardFixture } from "./helpers/host-native-fixture.mjs";
import { runCodexPeerHook, stageCodexPeerReceipt } from "../dist/build/packages/core/src/codex-peer-hooks.js";

const recordCodexPeerBatch = input => recordAtCutoff({ observationCutoff: new Date().toISOString(), ...input });
const at = "2026-10-30T00:00:00Z";
const response = (state, id = `host-${state}`) => ({ id, at: new Date().toISOString(), kind: "host-response", sourceTool: "collaboration.spawn_agent", raw: { state, terminal: true }, status: { pointer: "/state", mapping: { [state]: state } }, terminal: { pointer: "/terminal", values: ["true"], contract: "Synthetic terminal receipt contract" } });
async function fixture(t) {
  const f = await nativeFixture(t);
  f.request = { ...f.request, capabilities: { ...f.request.capabilities, toolName: "collaboration.spawn_agent" } };
  Object.assign(f, await codexGuardFixture(f));
  const draft = engineModelPolicyOnboarding("codex");
  const policy = await applyEngineModelPolicySet({ home: f.home, host: "codex", actor: "agent:fixture", occurredAt: at,
    authorization: { target: "models.engine-policy", decidedIn: `minutes:${"a".repeat(24)}#D1`, libraryId: f.state.metadata.workspaceId },
    policy: { ...draft, tiers: draft.tiers.map(row => row.category === "flagship" ? row : { ...row, ...selection.tuple }) } });
  const preparation = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: { prompt: "Synthetic receipt fixture only" }, peerWorker: true, nativeSessionId: "fixture-economy", codexObservation: f.native, userHome: f.userHome }, f.home);
  assert.ok(preparation.attempt);
  const record = recordHostNativeEvents(preparation, []);
  const manifest = { schemaVersion: "tcrn.codex-peer-manifest.v1", host: "codex", batchId: "fixture-batch", attemptId: "fixture-batch-attempt", workId: f.work.id, workRevision: f.work.revision, policyDigest: policy.hosts.codex.digest,
    main: { conversationId: "fixture-main", sourceRef: "fixture:main-observation", raw: { id: "fixture-main" }, conversationPointer: "/id" }, coordinator: { conversationId: "fixture-economy", sourceRef: "fixture:coordinator-observation", raw: { id: "fixture-economy" }, conversationPointer: "/id" },
    members: [{ attemptId: preparation.attempt.id, workId: f.work.id, workRevision: f.work.revision, conversationId: null }] };
  return { ...f, preparation, input: { manifest, records: [record], policy, capacity: { limit: 3, active: 3 }, workRevisions: [{ id: f.work.id, revision: f.work.revision }] } };
}
const observed = (state, id = `host-${state}`, conversationId = "fixture-worker") => ({ ...response(state, id), raw: { state, terminal: true, conversationId }, providerId: { pointer: "/conversationId" } });
const finish = f => recordHostNativeEvents(f.preparation, [f.completedEvent ??= observed("completed")]);

function queryResponse(tool, input, status = "inProgress") {
  return tool.endsWith("read_thread") ? { thread: { id: input.threadId, hostId: input.hostId ?? "local" }, page: { order: "newest_first" }, turns: [{ status }] }
    : { timedOut: true, wake: null, polls: input.targets.map(target => ({ thread: { id: target.threadId, hostId: target.hostId ?? "local", status: { type: "active" } }, latestTurn: { status }, changed: true, cursor: "fixture-cursor:1" })) };
}

test("T13 actual wait/cursor/read shapes execute one query and zero subsequent side effects", async t => {
  const { readFile } = await import("node:fs/promises");
  const calls = JSON.parse(await readFile(new URL("./fixtures/codex-query-loop.json", import.meta.url), "utf8")).calls;
  assert.equal(calls.filter(call => call.tool === "wait_threads").length, 10);
  assert.equal(calls.filter(call => call.tool === "read_thread").length, 6);
  for (const start of [0, calls.findIndex(call => call.tool === "wait_threads")]) {
    const f = await nativeFixture(t);
    let executed = 0;
    for (const [index, call] of calls.slice(start).entries()) {
      const payload = { session_id: "fixture-main-with-no-role-or-cache", turn_id: index < 2 ? "original-turn" : "summary-continuation", model: "unchanged-model", tool_name: "mcp__codex_app__" + call.tool, tool_input: call.arguments };
      const pre = await runCodexPeerHook("PreToolUse", payload, f.home);
      if (pre.output !== null) { assert.equal(JSON.parse(pre.output).hookSpecificOutput.permissionDecision, "deny"); continue; }
      executed++;
      await runCodexPeerHook("PostToolUse", { ...payload, tool_response: { content: [{ type: "text", text: JSON.stringify(queryResponse(payload.tool_name, payload.tool_input)) }] } }, f.home);
    }
    assert.equal(executed, 1, "no second tool executes, even when the loop alternates wrappers, cursors, targets and turns");
  }
});

test("T14 only native children with returned in-progress turns permit another query", async t => {
  const f = await nativeFixture(t);
  const base = { session_id: "fixture-query-parent", turn_id: "turn-1" };
  const run = (event, payload) => runCodexPeerHook(event, { ...base, ...payload }, f.home);
  await run("SubagentStart", { agent_id: "fixture-child", agent_type: "worker" });
  const query = { tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: "fixture-child" }], timeoutMs: 50_000 } };
  for (let i = 0; i < 2; i++) {
    assert.equal((await run("PreToolUse", query)).output, null);
    assert.equal((await run("PostToolUse", { ...query, tool_response: queryResponse(query.tool_name, query.tool_input) })).reasonCode, "HOOK_QUERY_CHILD_IN_PROGRESS");
  }
  assert.equal((await run("PreToolUse", query)).output, null);
  await run("PostToolUse", { ...query, tool_response: queryResponse(query.tool_name, query.tool_input, "completed") });
  assert.equal((await run("PreToolUse", query)).reasonCode, "HOOK_QUERY_LOOP_DENIED");
  await run("UserPromptSubmit", { turn_id: "new-owner", prompt: "Read status once" });
  const mixed = { tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: "fixture-child" }, { threadId: "fixture-independent" }], timeoutMs: 0 } };
  assert.equal((await run("PreToolUse", mixed)).output, null);
  await run("PostToolUse", { ...mixed, tool_response: queryResponse(mixed.tool_name, mixed.tool_input) });
  assert.equal((await run("PreToolUse", query)).reasonCode, "HOOK_QUERY_LOOP_DENIED");
  await run("UserPromptSubmit", { turn_id: "new-owner" });
  assert.equal((await run("PreToolUse", query)).reasonCode, "HOOK_QUERY_LOOP_DENIED", "a new turn without a submitted prompt cannot reset the loop");
  await run("UserPromptSubmit", { turn_id: "another-owner", prompt: "A new actual request" });
  assert.equal((await run("PreToolUse", query)).output, null);
  assert.equal((await run("PreToolUse", query)).reasonCode, "HOOK_QUERY_LOOP_DENIED", "parallel inner promises cannot pass before the outstanding result");
  await run("UserPromptSubmit", { turn_id: "another-owner", prompt: "New human steering in the same active turn" });
  const remote = { tool_name: "mcp__codex_app__read_thread", tool_input: { threadId: "fixture-child", hostId: "remote" } };
  assert.equal((await run("PreToolUse", remote)).output, null);
  await run("PostToolUse", { ...remote, tool_response: queryResponse(remote.tool_name, remote.tool_input) });
  assert.equal((await run("PreToolUse", remote)).reasonCode, "HOOK_QUERY_LOOP_DENIED", "a same-named remote thread is not the native local child");
  await run("UserPromptSubmit", { turn_id: "another-owner", prompt: "New human steering in the same active turn" });
  assert.equal((await run("PreToolUse", remote)).output, null, "identical text in a new actual prompt event must not permanently lock queries");
});

test("native spawn evidence, unknown/remote status and code-mode promise rejection keep their actual boundaries", async t => {
  const f = await nativeFixture(t);
  const owner = { session_id: "fixture-code-parent", turn_id: "turn" };
  await runCodexPeerHook("PostToolUse", { ...owner, tool_name: "collaboration.spawn_agent", tool_response: { task_name: "fixture-native-child" } }, f.home);
  const input = { threadId: "fixture-native-child" };
  const payload = { ...owner, tool_name: "mcp__codex_app__read_thread", tool_input: input };
  let executions = 0;
  const invoke = async response => {
    const pre = await runCodexPeerHook("PreToolUse", payload, f.home);
    if (pre.output) throw new Error(JSON.parse(pre.output).hookSpecificOutput.permissionDecisionReason);
    executions++;
    await runCodexPeerHook("PostToolUse", { ...payload, tool_response: response }, f.home);
    return response;
  };
  await invoke(queryResponse(payload.tool_name, input));
  await invoke({ thread: { id: input.threadId, status: { type: "active" } }, turns: [] });
  await assert.rejects(invoke(queryResponse(payload.tool_name, input)), /End this waiting loop/);
  assert.equal(executions, 2, "a status label, changed flag or timeout cannot establish an in-progress native turn");
  assert.equal((await runCodexPeerHook("PreToolUse", { ...payload, agent_id: "separate-native-actor" }, f.home)).output, null, "native child actor state is separate from its parent session");
  assert.equal((await runCodexPeerHook("PreToolUse", { ...owner, tool_name: "functions.exec", tool_input: { code: "read_thread wait_threads" } }, f.home)).output, null, "JavaScript text is not interpreted");
});

test("terminal child results, outstanding-call correlation and damaged durable state never reopen a loop", async t => {
  const f = await nativeFixture(t);
  for (const status of ["completed", "failed", "cancelled", "unknown"]) {
    const payload = { session_id: "fixture-parent-" + status, turn_id: "turn", tool_use_id: "query-one", tool_name: "mcp__codex_app__read_thread", tool_input: { threadId: "fixture-child" } };
    await runCodexPeerHook("SubagentStart", { session_id: payload.session_id, agent_id: "fixture-child" }, f.home);
    await runCodexPeerHook("PreToolUse", payload, f.home);
    await runCodexPeerHook("PostToolUse", { ...payload, tool_response: queryResponse(payload.tool_name, payload.tool_input, status) }, f.home);
    assert.equal((await runCodexPeerHook("PreToolUse", { ...payload, turn_id: "summary" }, f.home)).reasonCode, "HOOK_QUERY_LOOP_DENIED");
  }
  const payload = { session_id: "fixture-steering", turn_id: "same-active-turn", tool_use_id: "old-query", tool_name: "mcp__codex_app__read_thread", tool_input: { threadId: "independent" } };
  await runCodexPeerHook("PreToolUse", payload, f.home);
  await runCodexPeerHook("UserPromptSubmit", { ...payload, prompt: "A new user request" }, f.home);
  const next = { ...payload, tool_use_id: "new-query" };
  await runCodexPeerHook("PreToolUse", next, f.home);
  await runCodexPeerHook("PostToolUse", { ...payload, tool_response: queryResponse(payload.tool_name, payload.tool_input) }, f.home);
  assert.equal((await runCodexPeerHook("PreToolUse", next, f.home)).reasonCode, "HOOK_QUERY_LOOP_DENIED", "the old result cannot release the new outstanding native call");
  await runCodexPeerHook("PostToolUse", { ...next, tool_response: queryResponse(next.tool_name, next.tool_input) }, f.home);
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  // The guard's directory key is SHA-256 of the actual actor JSON, not canonical JSON.
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256").update(JSON.stringify({ sessionId: payload.session_id, agentId: null })).digest("hex");
  await writeFile(join(f.home, "codex-query-guards", key, "state.json"), "{broken");
  assert.equal((await runCodexPeerHook("PreToolUse", next, f.home)).reasonCode, "HOOK_QUERY_RECOVERY_FAILED");
});

test("query readiness requires all four actual native lifecycle event registrations", async t => {
  const f = await fixture(t);
  const { codexNativeGuardHealth } = await import("../dist/build/packages/core/src/codex-native-health.js");
  for (const event of ["preToolUse", "postToolUse", "userPromptSubmit", "subagentStart"]) {
    const observation = structuredClone(f.native);
    observation.raw.data[0].hooks = observation.raw.data[0].hooks.filter(hook => hook.eventName !== event);
    const result = await codexNativeGuardHealth({ device: f.home, home: f.userHome, cwd: process.cwd(), observation });
    assert.equal(result.ready, false, event);
    assert.ok(result.reasons.some(reason => /registration missing/.test(reason)));
  }
});

test("main-first handoff and later coordinator receipt recover without main staging", async t => {
  const f = await fixture(t);
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const run = (event, values = {}) => runCodexPeerHook(event, { session_id: "fixture-main", turn_id: "turn-1", ...values }, f.home);
  const send = { tool_name: "mcp__codex_app__send_message_to_thread", tool_input: { threadId: "fixture-economy", hostId: "local", prompt: "Authorized handoff" } };
  assert.equal((await run("PostToolUse", { ...send, tool_response: { threadId: "fixture-economy" } })).reasonCode, "HOOK_PEER_HANDOFF_OBSERVED");
  const key = createHash("sha256").update("fixture-main").digest("hex");
  const handoffKey = canonicalSha256({ sourceId: "fixture-main", targetId: "fixture-economy", hostId: "local" });
  const handoff = JSON.parse(await readFile(join(f.home, "codex-peer-handoffs", handoffKey + ".json"), "utf8"));
  assert.equal(handoff.targetId, "fixture-economy");
  await new Promise(resolve => setTimeout(resolve, 2));
  const preparation = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: {}, peerWorker: true, nativeSessionId: "fixture-economy", codexObservation: f.native, userHome: f.userHome }, f.home);
  f.input.manifest.members[0].attemptId = preparation.attempt.id;
  f.input.records = [recordHostNativeEvents(preparation, [])];
  await stageCodexPeerReceipt(recordCodexPeerBatch(f.input), f.home, "fixture-economy");
  const participant = JSON.parse(await readFile(join(f.home, "cache", "codex-peer-hooks", key + ".json.receipt"), "utf8"));
  assert.equal(participant.coordinatorId, "fixture-economy");
  assert.equal(participant.handedOff, true, "the original successful send associates after coordinator recording, without main staging");
  await stageCodexPeerReceipt(recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, batchId: "other-batch", attemptId: "other-attempt" } }), f.home, "fixture-economy");
  assert.equal(JSON.parse(await readFile(join(f.home, "cache", "codex-peer-hooks", key + ".json.receipt"), "utf8")).handedOff, false, "another batch cannot reuse the old send observation");
  const query = { tool_name: "mcp__codex_app__read_thread", tool_input: { threadId: "fixture-economy" } };
  assert.equal((await run("PreToolUse", query)).output, null, "first query is available without any main-side stage");
  await run("PostToolUse", { ...query, tool_response: { thread: { id: "fixture-economy" }, turns: [{ status: "inProgress" }] } });
  for (const turn_id of ["turn-1", "summary-continuation", "restart"]) assert.equal(JSON.parse((await run("PreToolUse", { ...query, turn_id })).output).hookSpecificOutput.permissionDecision, "deny");
  await run("UserPromptSubmit", { turn_id: "owner-next-turn", prompt: "What is the current status?" });
  assert.equal((await run("PreToolUse", { ...query, turn_id: "owner-next-turn" })).output, null);
});

test("coordinator delivery reminder is terminal-only and does not repeat or resend an unknown attempt", async t => {
  const f = await fixture(t);
  const terminal = recordCodexPeerBatch({ ...f.input, records: [finish(f)] });
  const run = (event, values = {}) => runCodexPeerHook(event, { session_id: "fixture-economy", turn_id: "turn-1", ...values }, f.home);
  await stageCodexPeerReceipt(recordCodexPeerBatch(f.input), f.home, "fixture-economy");
  await run("PostToolUse", { tool_name: "Bash", tool_response: "record retained" });
  assert.equal((await run("Stop", { stop_hook_active: false })).output, null, "pending workers are not polled by Stop");
  await stageCodexPeerReceipt(terminal, f.home, "fixture-economy");
  await run("PostToolUse", { tool_name: "Bash", tool_response: "record retained" });
  assert.equal((await run("Stop", { stop_hook_active: true })).output, null);
  assert.equal(JSON.parse((await run("Stop", { stop_hook_active: false })).output).decision, "block");
  assert.equal((await run("Stop", { stop_hook_active: false })).output, null, "a host with a missing repeat flag still cannot loop");
  await stageCodexPeerReceipt(terminal, f.home, "fixture-economy");
  await run("PostToolUse", { turn_id: "turn-2", tool_name: "Bash", tool_response: "record retained" });
  await run("PreToolUse", { turn_id: "turn-2", tool_name: "mcp__codex_app__send_message_to_thread", tool_input: { threadId: "fixture-main" } });
  assert.equal((await run("Stop", { turn_id: "turn-2", stop_hook_active: false })).output, null, "an attempted send is not blindly repeated");
  const invalid = { ...terminal, reportEligible: false };
  assert.equal((await run("PostToolUse", { turn_id: "turn-3", tool_name: "Bash", tool_response: { output: JSON.stringify(invalid) } })).reasonCode, "HOOK_PEER_NOT_APPLICABLE");
  assert.equal((await run("Stop", { turn_id: "turn-3", stop_hook_active: false })).output, null);
});

test("unknown native outcomes retain occupancy; completion, failures and confirmed cancellation remain distinct", async t => {
  const f = await fixture(t);
  const pending = recordCodexPeerBatch(f.input);
  assert.equal(pending.allTerminal, false);
  assert.equal(pending.reportEligible, false);
  assert.equal(pending.occupancy, 1);
  assert.equal(pending.deliveryStatus, "not-attempted");
  assert.ok(pending.blockedReasons.some(reason => reason.startsWith("native-identity-unknown:")));
  assert.equal(pending.authority, "receipt-only-not-execution-authorization");
  for (const state of ["completed", "failed", "cancelled"]) {
    const record = recordHostNativeEvents(f.preparation, [observed(state)]);
    const terminal = recordCodexPeerBatch({ ...f.input, records: [record] });
    assert.equal(terminal.allTerminal, true, state);
    assert.equal(terminal.occupancy, 0, state);
    assert.equal(terminal.records[0].execution, state);
    assert.equal(terminal.reportEligible, true, "a terminal failure can be reported without relabeling success");
  }
  const cancelAck = recordHostNativeEvents(f.preparation, [{ id: "cancel-request", at: new Date().toISOString(), kind: "cancel-requested" }, { id: "cancel-ack", at: new Date().toISOString(), kind: "cancel-accepted", sourceTool: "fixture.cancel", raw: { accepted: true } }]);
  const cancelling = recordCodexPeerBatch({ ...f.input, records: [cancelAck] });
  assert.equal(cancelling.allTerminal, false);
  assert.equal(cancelling.occupancy, 1);
});

test("same-batch recovery and duplicate/late receipts never duplicate work or regress terminal evidence", async t => {
  const f = await fixture(t);
  const pending = recordCodexPeerBatch(f.input);
  const completed = recordCodexPeerBatch({ ...f.input, records: [finish(f)], prior: pending });
  const recovered = recordCodexPeerBatch({ ...f.input, records: [], prior: JSON.parse(JSON.stringify(completed)), observationCutoff: completed.observationCutoff });
  assert.equal(recovered.digest, completed.digest);
  const duplicate = recordCodexPeerBatch({ ...f.input, records: [finish(f)], prior: recovered, observationCutoff: recovered.observationCutoff });
  assert.equal(duplicate.digest, recovered.digest);
  const lateEvent = { id: "late-accepted", at: new Date().toISOString(), kind: "host-response", sourceTool: "collaboration.spawn_agent", raw: { state: "accepted" }, status: { pointer: "/state", mapping: { accepted: "accepted" } } };
  const late = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [lateEvent])], prior: recovered });
  assert.equal(late.records.length, 1);
  assert.equal(late.records[0].execution, "completed");
  assert.equal(late.occupancy, 0);
  assert.equal(normalizeCodexPeerBatch(late).digest, late.digest);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, attemptId: "another-batch-attempt" }, prior: recovered }), /immutable manifest/u);
  assert.throws(() => normalizeCodexPeerBatch({ ...pending, allTerminal: true, reportEligible: true }), /differs from retained/u);
});

test("capacity, policy/work drift, fixed identities and explicit host remain fail-closed", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  for (const host of ["unknown", "claude-code", "dsh", "dot"]) assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, host } }), /explicit Codex/u);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, coordinator: f.input.manifest.main } }), /independent conversations/u);
  const unknown = recordCodexPeerBatch({ ...f.input, records, capacity: { limit: 3, active: null } });
  assert.ok(unknown.blockedReasons.includes("capacity-unknown")); assert.equal(unknown.reportEligible, false);
  const exceeded = recordCodexPeerBatch({ ...f.input, records, capacity: { limit: 2, active: 3 } });
  assert.ok(exceeded.blockedReasons.includes("capacity-exceeded")); assert.equal(exceeded.reportEligible, false);
  const drift = recordCodexPeerBatch({ ...f.input, records, manifest: { ...f.input.manifest, policyDigest: "0".repeat(64) } });
  assert.ok(drift.blockedReasons.includes("policy-drift")); assert.equal(drift.reportEligible, false);
  const reused = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [observed("completed", "reused", "fixture-main")])] });
  assert.ok(reused.blockedReasons.some(reason => reason.startsWith("native-identity-reused:"))); assert.equal(reused.reportEligible, false);
  const changedIdentity = recordHostNativeEvents(f.preparation, [observed("completed", "first-id"), observed("completed", "second-id", "different-worker")]);
  const changed = recordCodexPeerBatch({ ...f.input, records: [changedIdentity] });
  assert.ok(changed.blockedReasons.some(reason => reason.startsWith("native-identity-drift:"))); assert.equal(changed.reportEligible, false);
  const missing = recordCodexPeerBatch({ ...f.input, records: [] });
  assert.ok(missing.blockedReasons.some(reason => reason.startsWith("member-outcome-unknown:")));
});

async function deliveryFor(f, events = [], action = "coordination", message = `${codexPeerReportPrefix(f.input.manifest)}Synthetic batch result`) {
  const preparation = await prepareHostNativeDispatch(f.state, { ...f.request, action }, { selection, argumentsValue: { recipient: f.input.manifest.main.conversationId, message } }, f.home);
  assert.ok(preparation.attempt);
  return { record: recordHostNativeEvents(preparation, events), recipientPointer: "/recipient", correlationPointer: "/message", batchId: f.input.manifest.batchId, batchAttemptId: f.input.manifest.attemptId };
}

test("ordinary send preparation and new batch delivery cannot copy sender settings", async t => {
  const f = await fixture(t);
  const request = { ...f.request, action: "coordination", capabilities: { ...f.request.capabilities, toolName: "mcp__codex_app__send_message_to_thread" } };
  const args = { threadId: "fixture-main", hostId: "local", prompt: "Ordinary result" };
  assert.ok((await prepareHostNativeDispatch(f.state, request, { selection, argumentsValue: args }, f.home)).attempt);
  for (const extra of [{ model: "fixture-sender-model" }, { thinking: "max" }, { model: "fixture-sender-model", thinking: "max" }]) {
    await assert.rejects(prepareHostNativeDispatch(f.state, request, { selection, argumentsValue: { ...args, ...extra } }, f.home), /omit model\/thinking/);
  }
  const ordinary = await deliveryFor(f);
  const { digest: old, ...payload } = ordinary.record.preparation;
  payload.attempt = { ...payload.attempt, argumentsValue: { ...payload.attempt.argumentsValue, model: "fixture-sender-model" } };
  const preparation = { ...payload, digest: canonicalSha256(payload) };
  const changed = { ...ordinary, record: recordHostNativeEvents(preparation, []) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records: [finish(f)], delivery: changed }), /omit model\/thinking/);
  const current = recordCodexPeerBatch({ ...f.input, records: [finish(f)], delivery: ordinary });
  const { digest: omitted, ...historical } = current;
  historical.delivery = changed;
  const historicalReceipt = { ...historical, digest: canonicalSha256(historical) };
  assert.equal(normalizeCodexPeerBatch(historicalReceipt).delivery.record.preparation.attempt.argumentsValue.model, "fixture-sender-model", "historical normalization preserves its original evidence meaning");
  assert.equal(recordCodexPeerBatch({ ...f.input, records: [], prior: historicalReceipt }).deliveryStatus, "unknown");
});

test("exact settings adjustment uses a live Owner source, preserves class authorization and reconciles unknown attempts", async t => {
  const f = await fixture(t);
  const { recordMinutes } = await import("../dist/build/packages/core/src/index.js");
  const { persistCodexPeerRole } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
  const { stageCodexSettingsIntent } = await import("../dist/build/packages/core/src/codex-peer-settings.js");
  const state = await recordMinutes(f.workspace, { projectId: f.work.projectId, externalKey: "SETTINGS-TEST", title: "Temporary native settings test", summary: "Existing class authorization fixture", occurredAt: at, decidedBy: ["owner:governance"], decisions: ["Allow settings adjustments in isolated temporary native test conversations."], linkedWorkIds: [f.work.id] });
  const decidedIn = state.minutes.find(row => row.externalKey === "SETTINGS-TEST").id + "#D1";
  const intent = { decidedIn, basis: "The temporary fixture target and exact settings are in the existing test scope.", targetSource: { toolName: "mcp__codex_app__create_thread", response: { threadId: "fixture-main", hostId: "local" } } };
  const request = { ...f.request, action: "coordination", capabilities: { ...f.request.capabilities, toolName: "mcp__codex_app__send_message_to_thread" } };
  const args = { threadId: "fixture-main", hostId: "local", prompt: "Explicit authorized settings adjustment", model: "fixture-target-model", thinking: "max" };
  const prepare = value => prepareHostNativeDispatch(state, request, { selection, argumentsValue: args, nativeSessionId: "fixture-economy", codexSettingsIntent: value }, f.home);
  await assert.rejects(prepare({ ...intent, targetSource: { ...intent.targetSource, response: { threadId: "wrong-target" } } }), /matching native/);
  await persistCodexPeerRole({ receipt: recordCodexPeerBatch(f.input), device: f.home, sessionId: "fixture-economy", libraryId: state.metadata.workspaceId, actor: "agent:fixture" });
  const body = { session_id: "fixture-economy", turn_id: "new-turn-with-no-cache", tool_name: request.capabilities.toolName, tool_input: args };
  assert.equal((await runCodexPeerHook("PreToolUse", body, f.home)).reasonCode, "HOOK_PEER_SETTINGS_DENIED");
  const prepared = await prepare(intent);
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const files = { request, arguments: { selection, argumentsValue: args }, intent };
  for (const [name, value] of Object.entries(files)) await writeFile(join(f.root, name + ".json"), JSON.stringify(value));
  const output = join(f.root, "settings-preparation.json");
  const cli = new URL("../scripts/einzbern.mjs", import.meta.url).pathname;
  const cliResult = JSON.parse(execFileSync(process.execPath, [cli, "execution-host-prepare", "--workspace", f.workspace, "--request", join(f.root, "request.json"), "--arguments", join(f.root, "arguments.json"), "--codex-settings-intent", join(f.root, "intent.json"), "--output", output], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home, CODEX_THREAD_ID: "fixture-economy" }, timeout: 30_000 }));
  assert.equal(cliResult.reasonCode, "HOST_PREPARATION_READY");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(output, "utf8"))).sort(), ["schemaVersion", "context", "decision", "attempt", "digest"].sort(), "the bridge adds no field to the closed preparation");
  const stage = (attemptId, value = intent, revision = f.work.revision) => stageCodexSettingsIntent({ device: f.home, sessionId: "fixture-economy", workspaceRoot: f.workspace, workId: f.work.id, workRevision: revision, attemptId, argumentsValue: args, intent: value });
  await stage("wrong-work-revision", intent, f.work.revision + 1);
  assert.equal((await runCodexPeerHook("PreToolUse", body, f.home)).reasonCode, "HOOK_PEER_SETTINGS_DENIED", "the native attempt is bound to its actual live work revision");
  await stage(prepared.attempt.id);
  assert.equal((await runCodexPeerHook("PreToolUse", { ...body, tool_input: { ...args, thinking: "low" } }, f.home)).reasonCode, "HOOK_PEER_SETTINGS_DENIED");
  assert.equal((await runCodexPeerHook("PreToolUse", { ...body, agent_id: "native-caller" }, f.home)).output, null, "the exact authorized native-session attempt does not acquire an extra agent-id requirement");
  assert.equal((await runCodexPeerHook("PreToolUse", body, f.home)).reasonCode, "HOOK_PEER_SETTINGS_DENIED", "an unobserved attempted send is not blindly repeated");
  await assert.rejects(stage("new-attempt"), /outcome is unknown/);
  await stage("reconciled-attempt", { ...intent, reconciliation: { attemptId: prepared.attempt.id, toolName: "thread/read", response: { thread: { id: args.threadId, model: args.model, reasoningEffort: args.thinking } } } });
  assert.equal((await runCodexPeerHook("PreToolUse", body, f.home)).output, null);
  await runCodexPeerHook("PostToolUse", { ...body, tool_response: { threadId: args.threadId } }, f.home);
  await stage("another-authorized-attempt");
  assert.equal((await runCodexPeerHook("PreToolUse", body, f.home)).output, null, "the existing Owner authorization is not exhausted by the earlier completed adjustment");
  await runCodexPeerHook("PostToolUse", { ...body, tool_response: { threadId: args.threadId } }, f.home);
  await stage("withdrawn-attempt");
  await recordMinutes(f.workspace, { projectId: f.work.projectId, externalKey: "SETTINGS-WITHDRAW", title: "Withdraw temporary test", summary: "The source is no longer valid", occurredAt: "2026-10-30T00:00:01Z", decidedBy: ["owner:governance"], decisions: ["Withdraw the temporary settings authorization."], withdraws: [decidedIn], linkedWorkIds: [f.work.id] });
  assert.equal((await runCodexPeerHook("PreToolUse", body, f.home)).reasonCode, "HOOK_PEER_SETTINGS_DENIED", "the hook rereads current decision validity before the side effect");
  assert.equal((await runCodexPeerHook("PreToolUse", { ...body, session_id: "unbound-conversation" }, f.home)).output, null, "the enrolled-peer settings boundary is not a global model-change ban");
});

test("report eligibility is not a send; attempted unknown delivery survives recovery without permitting resend", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const eligible = recordCodexPeerBatch({ ...f.input, records });
  assert.equal(eligible.reportEligible, true);
  assert.equal(eligible.deliveryStatus, "not-attempted");
  const delivery = await deliveryFor(f);
  const attempted = recordCodexPeerBatch({ ...f.input, records, delivery, prior: eligible });
  assert.equal(attempted.deliveryStatus, "unknown"); assert.equal(attempted.reportEligible, false);
  const recovered = recordCodexPeerBatch({ ...f.input, records: [], prior: attempted, observationCutoff: attempted.observationCutoff });
  assert.equal(recovered.digest, attempted.digest);
  assert.equal(recovered.delivery.record.preparation.attempt.id, delivery.record.preparation.attempt.id);
  const completedDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed")], delivery.record) };
  const confirmed = recordCodexPeerBatch({ ...f.input, records: [], delivery: completedDelivery, prior: recovered });
  assert.equal(confirmed.deliveryStatus, "confirmed"); assert.equal(confirmed.reportEligible, false);
  assert.equal(recordCodexPeerBatch({ ...f.input, records: [], delivery: completedDelivery, prior: confirmed, observationCutoff: confirmed.observationCutoff }).digest, confirmed.digest);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: { ...delivery, batchAttemptId: "wrong-attempt" } }), /another batch/u);
  const wrongRecipient = await deliveryFor(f);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: { ...wrongRecipient, recipientPointer: "/message" } }), /recipient differs/u);
  const failedDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("failed")]) };
  const failed = recordCodexPeerBatch({ ...f.input, records, delivery: failedDelivery });
  assert.equal(failed.deliveryStatus, "failed"); assert.equal(failed.reportEligible, false);
  const early = recordCodexPeerBatch({ ...f.input, delivery: completedDelivery });
  assert.ok(early.blockedReasons.includes("delivery-before-terminal-batch"));
});

test("missing or changed current work revisions and contradictory terminal facts block reporting", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const missingAuthority = recordCodexPeerBatch({ ...f.input, records, workRevisions: undefined });
  assert.ok(missingAuthority.blockedReasons.includes("work-revisions-unknown"));
  assert.equal(missingAuthority.reportEligible, false);
  assert.equal(normalizeCodexPeerBatch(missingAuthority).digest, missingAuthority.digest);
  for (const workRevisions of [[], [{ id: f.work.id, revision: f.work.revision + 1 }]]) {
    const changed = recordCodexPeerBatch({ ...f.input, records, workRevisions });
    assert.ok(changed.blockedReasons.includes(`work-revision-drift:${f.work.id}`));
    assert.equal(changed.reportEligible, false);
  }
  const conflicting = recordHostNativeEvents(f.preparation, [observed("completed"), observed("cancelled")]);
  const unresolved = recordCodexPeerBatch({ ...f.input, records: [conflicting] });
  assert.ok(unresolved.blockedReasons.some(reason => reason.startsWith("native-conflict:")));
  assert.equal(unresolved.allTerminal, false);
  assert.equal(unresolved.reportEligible, false);
  assert.equal(unresolved.occupancy, 1);
});

test("peer identity references must match retained native response fields, not guessed labels", async t => {
  const f = await fixture(t);
  for (const role of ["main", "coordinator"]) {
    const peer = f.input.manifest[role];
    for (const replacement of [{ ...peer, raw: { id: "wrong-observed-id" } }, { ...peer, conversationPointer: "/missing" }]) {
      assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, [role]: replacement } }));
    }
  }
});

test("CLI batch record reads current workspace and device policy, writes private receipt and replays it", async t => {
  const { writeFile, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const f = await fixture(t);
  const manifestPath = join(f.root, "manifest-input.json"), recordsPath = join(f.root, "records-input.json"), capacityPath = join(f.root, "capacity-input.json"), output = join(f.root, "batch-receipt.json");
  await writeFile(manifestPath, JSON.stringify(f.input.manifest));
  await writeFile(recordsPath, JSON.stringify([finish(f)]));
  await writeFile(capacityPath, JSON.stringify(f.input.capacity));
  const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const invoke = args => JSON.parse(execFileSync(process.execPath, [cli, ...args, ...(args[0] === "execution-codex-peer-record" ? ["--codex-admission", f.admissionPath] : [])], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home, HOME: f.userHome, CODEX_THREAD_ID: "fixture-main" }, timeout: 30_000 }));
  const before = new Date().toISOString();
  const result = invoke(["execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--output", output]);
  assert.ok(result.observationCutoff >= before && result.observationCutoff <= new Date().toISOString());
  assert.equal(result.reportEligible, true);
  const hook = await runCodexPeerHook("PostToolUse", { session_id: "fixture-main", turn_id: "cli-turn", tool_name: "Bash", tool_response: "output may be truncated" }, f.home);
  assert.equal(hook.reasonCode, "HOOK_PEER_RECEIPT_OBSERVED", "the real CLI stages the validated receipt independently of stdout");
  assert.equal(result.reportPrefix, codexPeerReportPrefix(f.input.manifest));
  assert.throws(() => normalizeCodexPeerBatch({ ...result, reportPrefix: "tampered" }), /differs from retained/u);
  assert.equal(result.deliveryStatus, "not-attempted");
  assert.equal(result.workRevisions.find(row => row.id === f.work.id).revision, f.work.revision);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
  assert.deepEqual(invoke(["execution-codex-peer-evidence", "--from-file", output]), result);
  assert.throws(() => invoke(["execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--output", output]), /exists|EEXIST|WRITE/u);
  const futureRecords = [recordHostNativeEvents(f.preparation, [{ ...observed("completed", "future-worker"), at: "2099-01-01T00:00:00Z" }])];
  await writeFile(recordsPath, JSON.stringify(futureRecords));
  const invalidPath = join(f.root, "future-invalid.json");
  const invalidRun = spawnSync(process.execPath, [cli, "execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--prior", output, "--output", invalidPath], { encoding: "utf8", env: { ...process.env, EINZBERN_HOME: f.home }, timeout: 30_000 });
  assert.equal(invalidRun.status, 1, "invalid evidence must not return CLI success");
  const invalid = JSON.parse(invalidRun.stdout);
  assert.equal(invalid.reasonCode, "CODEX_PEER_RECORD_INVALID");
  assert.deepEqual(invalid.records, futureRecords);
  assert.deepEqual(invalid.prior, result);
  assert.equal(invalid.validation.status, "invalid");
  assert.ok(invalid.problems.some(problem => problem.includes("after observation cutoff")));
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result, "last valid receipt remains untouched");
  assert.deepEqual(JSON.parse(await readFile(invalidPath, "utf8")), invalid);
  assert.throws(() => invoke(["execution-codex-peer-record", "--workspace", f.workspace, "--manifest", manifestPath, "--records", recordsPath, "--capacity", capacityPath, "--output", join(f.root, "override.json"), "--observation-cutoff", "2099-01-01T00:00:00Z"]), error => error.status === 1 && JSON.parse(error.stderr).reasonCode === "CLI_ARGUMENT_UNKNOWN");

});


test("observation cutoff rejects future worker events/preparations and rollback; saved replay is clock-independent", async t => {
  const f = await fixture(t);
  const observationCutoff = new Date().toISOString();
  const pending = recordCodexPeerBatch({ ...f.input, observationCutoff });
  const future = { ...observed("completed"), at: "2099-01-01T00:00:00Z" };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(f.preparation, [future])], prior: pending }), /after observation cutoff/u);
  assert.equal(pending.occupancy, 1);
  assert.equal(pending.allTerminal, false);
  const nanosFuture = { ...future, at: observationCutoff.replace("Z", "000001Z") };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(f.preparation, [nanosFuture])] }), /after observation cutoff/u);
  const boundary = { ...observed("completed"), at: observationCutoff };
  const completed = recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(f.preparation, [boundary])], prior: pending });
  assert.equal(completed.reportEligible, true);
  assert.deepEqual(normalizeCodexPeerBatch(JSON.parse(JSON.stringify(completed))), completed);
  const later = new Date(Date.parse(observationCutoff) + 1000).toISOString();
  const resumed = recordCodexPeerBatch({ ...f.input, observationCutoff: later, records: [], prior: completed });
  assert.equal(resumed.observationCutoff, later);
  assert.deepEqual(resumed.records, completed.records);
  assert.deepEqual(normalizeCodexPeerBatch(resumed), resumed);
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [], prior: resumed }), /moved backwards/u);
  const { digest: ignored, ...payload } = f.preparation;
  const preparationPayload = { ...payload, attempt: { ...payload.attempt, requestedAt: future.at } };
  const preparation = { ...preparationPayload, digest: canonicalSha256(preparationPayload) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(preparation, [])] }), /preparation is after observation cutoff/u);
  const decision = { ...f.preparation.decision, evaluatedAt: future.at };
  const futureEvaluationPayload = { ...payload, decision, context: { ...payload.context, executionDecision: decision } };
  const futureEvaluation = { ...futureEvaluationPayload, digest: canonicalSha256(futureEvaluationPayload) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, observationCutoff, records: [recordHostNativeEvents(futureEvaluation, [])] }), /evaluation is after observation cutoff/u);

});

test("delivery requires actual coordination action and exact current-manifest text prefix", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const wrongAction = await deliveryFor(f, [], "decomposition");
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: wrongAction }), /actual coordination attempt/u);
  for (const message of [`Before ${codexPeerReportPrefix(f.input.manifest)}result`, codexPeerReportPrefix(f.input.manifest).trimEnd() + "suffix", "Synthetic batch result"]) {
    const delivery = await deliveryFor(f, [], "coordination", message);
    assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery }), /does not bind/u);
  }
  const delivery = await deliveryFor(f);
  const confirmedDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed")]) };
  assert.equal(recordCodexPeerBatch({ ...f.input, records, delivery: confirmedDelivery }).deliveryStatus, "confirmed");
  const otherPreparation = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: { prompt: "Different worker batch" }, peerWorker: true, nativeSessionId: "fixture-economy", codexObservation: f.native, userHome: f.userHome }, f.home);
  const manifest = { ...f.input.manifest, batchId: "other-batch", attemptId: "other-batch-attempt", members: [{ ...f.input.manifest.members[0], attemptId: otherPreparation.attempt.id }] };
  const otherRecords = [recordHostNativeEvents(otherPreparation, [observed("completed", "other-result", "other-worker")])];
  assert.throws(() => recordCodexPeerBatch({ ...f.input, manifest, records: otherRecords, delivery: { ...confirmedDelivery, batchId: manifest.batchId, batchAttemptId: manifest.attemptId } }), /does not bind/u);
});

test("future delivery events and preparations cannot confirm or replace the retained unknown send", async t => {
  const f = await fixture(t);
  const records = [finish(f)];
  const delivery = await deliveryFor(f);
  const pending = recordCodexPeerBatch({ ...f.input, records, delivery });
  const future = { ...response("completed"), at: "2099-01-01T00:00:00Z" };
  const futureDelivery = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [future]) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records: [], delivery: futureDelivery, prior: pending }), /after observation cutoff/u);
  assert.equal(pending.deliveryStatus, "unknown");
  assert.equal(pending.reportEligible, false);
  const resumed = recordCodexPeerBatch({ ...f.input, records: [], prior: pending });
  assert.equal(resumed.delivery.record.preparation.attempt.id, delivery.record.preparation.attempt.id);
  assert.equal(resumed.reportEligible, false);
  const { digest: ignored, ...payload } = delivery.record.preparation;
  const preparationPayload = { ...payload, attempt: { ...payload.attempt, requestedAt: future.at } };
  const preparation = { ...preparationPayload, digest: canonicalSha256(preparationPayload) };
  assert.throws(() => recordCodexPeerBatch({ ...f.input, records, delivery: { ...delivery, record: recordHostNativeEvents(preparation, []) } }), /preparation is after observation cutoff/u);
});

// Exercise the public CLI as well as API replay: blocked receipts are valid evidence,
// not CLI validation errors, and must retain their derived blocking facts on disk.
async function peerCliRoundtrip(f, input, stem) {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const args = ["execution-codex-peer-record", "--workspace", f.workspace];
  for (const key of ["manifest", "records", "capacity", "delivery", "prior"]) {
    if (input[key] == null) continue;
    const path = join(f.root, `${stem}-${key}.json`);
    await writeFile(path, JSON.stringify(input[key]));
    args.push(`--${key}`, path);
  }
  const output = join(f.root, `${stem}-output.json`);
  args.push("--output", output);
  const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const invoke = flags => JSON.parse(execFileSync(process.execPath, [cli, ...flags, ...(flags[0] === "execution-codex-peer-record" ? ["--codex-admission", f.admissionPath] : [])], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, EINZBERN_HOME: f.home, HOME: f.userHome, CODEX_THREAD_ID: "fixture-main" },
  }));
  let result;
  try { result = invoke(args); }
  catch (error) {
    const failed = JSON.parse(error.stdout);
    assert.equal(failed.reasonCode, "CODEX_PEER_GUARD_NOT_READY");
    result = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(failed.receipt, result, "factual blocked receipts survive failed mode enrollment");
  }
  assert.deepEqual(invoke(["execution-codex-peer-evidence", "--from-file", output]), result);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
  assert.deepEqual(normalizeCodexPeerBatch(result), result);
  return result;
}

// Nanosecond offsets around a millisecond invocation, with no lossy Date.parse
// comparison in the implementation. All synthetic times remain in the observed past.
function nearSend(delivery, nanoseconds) {
  const at = delivery.record.preparation.attempt.requestedAt;
  const base = BigInt(Date.parse(at)) * 1_000_000n + BigInt(nanoseconds);
  const seconds = base / 1_000_000_000n;
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + `.${String(base % 1_000_000_000n).padStart(9, "0")}Z`;
}

test("premature reports remain blocked through completion, prior recovery and direct CLI replay", async t => {
  const f = await fixture(t);
  const { setTimeout: delay } = await import("node:timers/promises");
  await delay(2);
  const delivery = await deliveryFor(f);
  const runningEvent = { ...observed("running", "running-before-send"), at: nearSend(delivery, -1) };
  delete runningEvent.terminal;
  const running = recordHostNativeEvents(f.preparation, [runningEvent]);
  await delay(2);
  const completedEvent = { ...observed("completed", "completed-after-send"), at: nearSend(delivery, 1) };
  const sent = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed", "send-finished")]) };
  const before = recordCodexPeerBatch({ ...f.input, records: [running], delivery: sent });
  assert.ok(before.blockedReasons.includes("delivery-before-terminal-batch"));
  const completed = recordHostNativeEvents(f.preparation, [completedEvent], running);
  for (const [label, prior] of [["resumed", before], ["direct", undefined]]) {
    const input = { ...f.input, records: [completed], delivery: sent, prior };
    const after = recordCodexPeerBatch(input);
    assert.equal(after.allTerminal, true);
    assert.equal(after.occupancy, 0);
    assert.equal(after.deliveryStatus, "confirmed", "transport success is not valid final-report association");
    assert.ok(after.blockedReasons.includes("delivery-before-terminal-batch"));
    assert.equal(after.reportEligible, false);
    assert.deepEqual(normalizeCodexPeerBatch(after), after);
    const cli = await peerCliRoundtrip(f, input, `early-${label}`);
    assert.deepEqual(cli.blockedReasons, after.blockedReasons);
    const recovered = recordCodexPeerBatch({ ...f.input, records: [], prior: cli });
    assert.deepEqual(recovered.blockedReasons, after.blockedReasons);
  }
});

test("report boundary is send invocation, uses strict nanosecond order, and requires identity then", async t => {
  const f = await fixture(t);
  const { setTimeout: delay } = await import("node:timers/promises");
  await delay(2);
  const delivery = await deliveryFor(f);
  await delay(2);
  const sent = { ...delivery, record: recordHostNativeEvents(delivery.record.preparation, [response("completed")]) };
  for (const [label, offset, blocked] of [["before", -1, false], ["equal", 0, true], ["after", 1, true]]) {
    const records = [recordHostNativeEvents(f.preparation, [{ ...observed("completed"), at: nearSend(delivery, offset) }])];
    const input = { ...f.input, records, delivery: sent };
    const result = recordCodexPeerBatch(input);
    assert.equal(result.blockedReasons.includes("delivery-before-terminal-batch"), blocked, label);
    assert.equal(result.allTerminal, true);
    assert.equal(result.deliveryStatus, "confirmed");
    const cli = await peerCliRoundtrip(f, input, `boundary-${label}`);
    assert.deepEqual(cli.blockedReasons, result.blockedReasons);
  }
  const terminalWithoutId = { ...response("completed", "anonymous-terminal"), at: nearSend(delivery, -1) };
  const lateIdentity = { ...observed("completed", "late-identity"), at: nearSend(delivery, 1) };
  const unknownAtSend = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [terminalWithoutId, lateIdentity])], delivery: sent });
  assert.equal(unknownAtSend.allTerminal, true);
  assert.ok(unknownAtSend.blockedReasons.includes("delivery-before-terminal-batch"));
  const priorUnknown = recordCodexPeerBatch({ ...f.input, records: [recordHostNativeEvents(f.preparation, [terminalWithoutId])], delivery: sent });
  const resumed = recordCodexPeerBatch({ ...f.input, records: unknownAtSend.records, prior: priorUnknown });
  assert.deepEqual(resumed.blockedReasons, unknownAtSend.blockedReasons);
});

test("unknown, drifted or ambiguous native identity never releases a fixed member", async t => {
  const f = await fixture(t);
  const manifest = { ...f.input.manifest, members: [{ ...f.input.manifest.members[0], conversationId: "fixture-worker" }] };
  const cases = [
    ["unknown", [response("completed")]],
    ["drift", [observed("completed", "wrong-worker", "unrelated-conversation")]],
    ["ambiguous", [observed("completed", "right-worker"), observed("completed", "wrong-worker", "unrelated-conversation")]],
    ["main-reused", [observed("completed", "main-worker", manifest.main.conversationId)]],
    ["coordinator-reused", [observed("completed", "coordinator-worker", manifest.coordinator.conversationId)]],
  ];
  for (const [label, events] of cases) {
    const input = { ...f.input, manifest, records: [recordHostNativeEvents(f.preparation, events)] };
    const result = recordCodexPeerBatch(input);
    assert.equal(result.records[0].executionFinality, "confirmed", "native lifecycle evidence remains unchanged");
    assert.equal(result.occupancy, 1, label);
    assert.equal(result.allTerminal, false, label);
    assert.equal(result.reportEligible, false, label);
    const cli = await peerCliRoundtrip(f, input, `identity-${label}`);
    assert.equal(cli.occupancy, 1, label);
    assert.equal(cli.allTerminal, false, label);
    assert.deepEqual(cli.blockedReasons, result.blockedReasons);
  }
});

test("colliding identities retain both claimants regardless of record order and reserve missing fixed members", async t => {
  const f = await fixture(t);
  const second = await prepareHostNativeDispatch(f.state, f.request, { selection, argumentsValue: { prompt: "Second synthetic worker" }, peerWorker: true, nativeSessionId: "fixture-economy", codexObservation: f.native, userHome: f.userHome }, f.home);
  const manifest = { ...f.input.manifest, members: [...f.input.manifest.members, { ...f.input.manifest.members[0], attemptId: second.attempt.id }] };
  const firstRecord = recordHostNativeEvents(f.preparation, [observed("completed", "first")]);
  const secondRecord = recordHostNativeEvents(second, [observed("completed", "second")]);
  for (const [label, records] of [["forward", [firstRecord, secondRecord]], ["reverse", [secondRecord, firstRecord]]]) {
    const input = { ...f.input, manifest, records };
    const result = recordCodexPeerBatch(input);
    assert.equal(result.occupancy, 2, label);
    assert.equal(result.allTerminal, false, label);
    for (const member of manifest.members) assert.ok(result.blockedReasons.includes(`native-identity-reused:${member.attemptId}`));
    const cli = await peerCliRoundtrip(f, input, `collision-${label}`);
    assert.equal(cli.occupancy, 2);
    assert.equal(cli.allTerminal, false);
  }
  const reserved = { ...manifest, members: [manifest.members[0], { ...manifest.members[1], conversationId: "fixture-worker" }] };
  const input = { ...f.input, manifest: reserved, records: [firstRecord] };
  const missing = recordCodexPeerBatch(input);
  assert.equal(missing.occupancy, 2);
  assert.equal(missing.allTerminal, false);
  assert.ok(missing.blockedReasons.includes(`native-identity-reused:${f.preparation.attempt.id}`));
  const cli = await peerCliRoundtrip(f, input, "collision-missing-fixed");
  assert.equal(cli.occupancy, 2);
  assert.equal(cli.allTerminal, false);
  const distinct = recordCodexPeerBatch({ ...f.input, manifest, records: [firstRecord, recordHostNativeEvents(second, [observed("failed", "different-worker", "second-worker")])] });
  assert.equal(distinct.occupancy, 0);
  assert.equal(distinct.allTerminal, true);
  assert.equal(distinct.reportEligible, true);
});

test("v2 peer workers reject independent tools; legacy saved receipts remain readable history", async t => {
  const f = await fixture(t);
  const { digest: ignored, ...payload } = f.preparation;
  for (const toolName of ["mcp__codex_app__create_thread", "mcp__codex_app__fork_thread", "other.spawn"]) {
    const next = { ...payload, attempt: { ...payload.attempt, toolName }, decision: { ...payload.decision, request: { ...payload.decision.request, capabilities: { ...payload.decision.request.capabilities, toolName } } } };
    next.context = { ...next.context, executionDecision: next.decision };
    assert.throws(() => recordHostNativeEvents({ ...next, digest: canonicalSha256(next) }, []), /collaboration.spawn_agent/);
    await assert.rejects(prepareHostNativeDispatch(f.state, next.decision.request, { selection, argumentsValue: {}, peerWorker: true, nativeSessionId: "fixture-economy", userHome: f.userHome, codexObservation: f.native }, f.home), /collaboration.spawn_agent/);
  }
  const alias = structuredClone(payload);
  alias.attempt.toolName = "multi_agent_v1.spawn_agent";
  alias.decision.request.capabilities.toolName = "multi_agent_v1.spawn_agent";
  alias.context.executionDecision = structuredClone(alias.decision);
  const actualAlias = { ...alias, digest: canonicalSha256(alias) };
  const aliasRecord = recordHostNativeEvents(actualAlias, [{ id: "native-alias-return", at: new Date().toISOString(), kind: "host-response", sourceTool: "multi_agent_v1.spawn_agent", raw: { agent_id: "fixture-real-field" }, providerId: { pointer: "/agent_id" } }]);
  const aliasBatch = recordCodexPeerBatch({ ...f.input, records: [aliasRecord] });
  assert.equal(aliasBatch.records[0].events[0].sourceTool, "multi_agent_v1.spawn_agent");
  assert.equal(aliasBatch.records[0].events[0].providerId.pointer, "/agent_id");
  const current = recordCodexPeerBatch(f.input);
  const { digest: omitted, ...legacyPayload } = current;
  legacyPayload.schemaVersion = "tcrn.codex-peer-batch.v1";
  const legacy = { ...legacyPayload, digest: canonicalSha256(legacyPayload) };
  assert.equal(normalizeCodexPeerBatch(legacy).schemaVersion, "tcrn.codex-peer-batch.v1");
  assert.throws(() => recordCodexPeerBatch({ ...f.input, prior: legacy }), /historical and unguarded/);
  const { persistCodexPeerRole } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
  await assert.rejects(persistCodexPeerRole({ receipt: legacy, device: f.home, sessionId: "fixture-main", libraryId: f.state.metadata.workspaceId, actor: "agent:fixture" }), /historical/);
});

test("durable coordinator survives turns/batches; known damaged material denies dependent tools", async t => {
  const f = await fixture(t);
  const { persistCodexPeerRole, readCodexPeerRole, codexPeerRoleDirectory, inspectCodexPeerRoles } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
  const { readFile, writeFile, rm, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const receipt = recordCodexPeerBatch(f.input);
  const save = extra => persistCodexPeerRole({ receipt, device: f.home, sessionId: "fixture-economy", libraryId: f.state.metadata.workspaceId, actor: "agent:fixture", ...extra });
  await save();
  const call = (id, tool = "mcp__codex_app__create_thread", turn_id) => runCodexPeerHook("PreToolUse", { session_id: id, turn_id, tool_name: tool, tool_input: {} }, f.home);
  for (const turn of [undefined, "first", "new-turn", "summary-continuation", "restart-observation"]) assert.equal(JSON.parse((await call("fixture-economy", undefined, turn)).output).hookSpecificOutput.permissionDecision, "deny");
  await runCodexPeerHook("UserPromptSubmit", { session_id: "fixture-economy", turn_id: "new-turn" }, f.home);
  assert.equal((await call("fixture-economy", "collaboration.spawn_agent")).output, null);
  assert.equal((await call("ordinary")).output, null);
  const next = recordCodexPeerBatch({ ...f.input, manifest: { ...f.input.manifest, batchId: "next-batch", attemptId: "next-attempt" }, records: [finish(f)] });
  await save({ receipt: next });
  assert.equal((await readCodexPeerRole(f.home, "fixture-economy")).role.receipt.manifest.batchId, "next-batch");
  const file = join(codexPeerRoleDirectory(f.home, "fixture-economy"), "role.json");
  const good = await readFile(file, "utf8");
  for (const damage of [async () => rm(file), async () => writeFile(file, "{broken"), async () => { await rm(file); await mkdir(file); }]) {
    await damage();
    assert.equal((await readCodexPeerRole(f.home, "fixture-economy")).status, "error");
    assert.equal((await inspectCodexPeerRoles(f.home)).ready, false);
    for (const tool of ["mcp__codex_app__fork_thread", "collaboration.spawn_agent"]) assert.equal((await call("fixture-economy", tool)).reasonCode, "HOOK_PEER_ROLE_RECOVERY_FAILED");
    await assert.rejects(save(), /cannot be recovered/);
    await rm(file, { recursive: true, force: true }); await writeFile(file, good);
  }
  const retired = await save({ change: { operation: "retire", decidedIn: "minutes:fixture#D1" } });
  assert.equal(retired.status, "retired");
  assert.equal((await call("fixture-economy")).output, null);
  await assert.rejects(save(), /governed activation/);
  await rm(file);
  await assert.rejects(save({ change: { operation: "recover", decidedIn: null } }), /governed activation/);
  await save({ change: { operation: "activate", decidedIn: "minutes:fixture#D2" } });
  assert.equal((await readCodexPeerRole(f.home, "fixture-economy")).status, "active");
});

test("native guard readiness inspects raw registration/current trust and current files", async t => {
  const f = await fixture(t);
  const { codexNativeGuardHealth } = await import("../dist/build/packages/core/src/codex-native-health.js");
  const health = observation => codexNativeGuardHealth({ device: f.home, home: f.userHome, cwd: process.cwd(), observation });
  assert.equal((await health(f.native)).ready, true);
  const unknown = await codexNativeGuardHealth({ device: f.home, home: f.userHome, cwd: process.cwd() });
  assert.equal(unknown.ready, false);
  for (const mutate of [hook => { hook.enabled = false; }, hook => { hook.trustStatus = "untrusted"; }, hook => { hook.command = "node unrelated"; }]) {
    const observed = structuredClone(f.native); mutate(observed.raw.data[0].hooks[0]);
    assert.equal((await health(observed)).ready, false);
  }
  for (const mutate of [row => { row.hooks = []; }, row => { row.errors = ["native-load-failed"]; }, row => { row.warnings = ["restricted"]; }]) {
    const observed = structuredClone(f.native); mutate(observed.raw.data[0]); assert.equal((await health(observed)).ready, false);
  }
  const { appendFile } = await import("node:fs/promises");
  await appendFile(f.native.files[1].path, "# changed since hooks/list\n");
  assert.equal((await health(f.native)).ready, false);
});

test("public role lifecycle resolves exact live Owner decisions and reads retirement back", async t => {
  const f = await fixture(t);
  const { recordMinutes } = await import("../dist/build/packages/core/src/index.js");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { persistCodexPeerRole, readCodexPeerRole } = await import("../dist/build/packages/core/src/codex-peer-hooks.js");
  await persistCodexPeerRole({ receipt: recordCodexPeerBatch(f.input), device: f.home, sessionId: "fixture-main", libraryId: f.state.metadata.workspaceId, actor: "agent:fixture" });
  const state = await recordMinutes(f.workspace, { occurredAt: "2026-11-08T00:00:00Z", projectId: f.state.projects[0].id, externalKey: "FIXTURE-ROLE-LIFECYCLE", title: "Fixture role lifecycle", summary: "Synthetic fixture only", decisions: ["Approve codex-peer-roles.fixture-economy.retire", "Approve unrelated.target"], decidedBy: ["owner:governance"], linkedWorkIds: [] });
  const minute = state.minutes.find(row => row.externalKey === "FIXTURE-ROLE-LIFECYCLE");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const args = [cli, "execution-codex-peer-record", "--workspace", f.workspace, "--actor", "agent:fixture"];
  for (const key of ["manifest", "records", "capacity"]) { const file = join(f.root, `lifecycle-${key}.json`); await writeFile(file, JSON.stringify(f.input[key])); args.push(`--${key}`, file); }
  const changePath = join(f.root, "change.json");
  const env = { ...process.env, EINZBERN_HOME: f.home, HOME: f.userHome, CODEX_THREAD_ID: "fixture-main" };
  await writeFile(changePath, JSON.stringify({ operation: "retire", decidedIn: `${minute.id}#D2` }));
  const rejected = spawnSync(process.execPath, [...args, "--role-change", changePath, "--output", join(f.root, "rejected-role.json")], { env, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /MODEL_WRITE_AUTHORIZATION_INVALID|does not name/);
  assert.equal((await readCodexPeerRole(f.home, "fixture-economy")).status, "active");
  await writeFile(changePath, JSON.stringify({ operation: "retire", decidedIn: `${minute.id}#D1` }));
  execFileSync(process.execPath, [...args, "--role-change", changePath, "--output", join(f.root, "retired-role.json")], { env, encoding: "utf8" });
  const recovered = await readCodexPeerRole(f.home, "fixture-economy");
  assert.equal(recovered.status, "retired");
  assert.equal(recovered.role.decidedIn, `${minute.id}#D1`);
});

test("public preparation rejects unsupported/unknown admission and failed durable save retains receipt", async t => {
  const f = await fixture(t);
  const { spawnSync } = await import("node:child_process");
  const { writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../scripts/einzbern.mjs", import.meta.url));
  const env = { ...process.env, EINZBERN_HOME: f.home, HOME: f.userHome, CODEX_THREAD_ID: "fixture-economy" };
  const request = join(f.root, "unsupported-request.json"), argumentsPath = join(f.root, "unsupported-arguments.json");
  await writeFile(request, JSON.stringify(f.request));
  await writeFile(argumentsPath, JSON.stringify({ selection, argumentsValue: {} }));
  for (const state of ["unknown", "unsupported"]) {
    const admission = join(f.root, `${state}-admission.json`);
    await writeFile(admission, JSON.stringify({ ...f.admission, state }));
    const run = spawnSync(process.execPath, [cli, "execution-host-prepare", "--workspace", f.workspace, "--request", request, "--arguments", argumentsPath, "--codex-peer-worker", "true", "--codex-admission", admission, "--output", join(f.root, state + "-binding.json")], { env, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /guard not ready/);
  }
  const flags = [cli, "execution-codex-peer-record", "--workspace", f.workspace];
  for (const key of ["manifest", "records", "capacity"]) { const file = join(f.root, `failed-save-${key}.json`); await writeFile(file, JSON.stringify(f.input[key])); flags.push(`--${key}`, file); }
  const output = join(f.root, "failed-save-receipt.json");
  await writeFile(join(f.home, "codex-peer-roles"), "Owned fixture obstructs the durable directory.");
  const run = spawnSync(process.execPath, [...flags, "--codex-admission", f.admissionPath, "--output", output], { env, encoding: "utf8" });
  assert.equal(run.status, 1);
  const result = JSON.parse(run.stdout);
  assert.equal(result.reasonCode, "CODEX_PEER_GUARD_NOT_READY");
  assert.deepEqual(result.receipt, JSON.parse(await readFile(output, "utf8")));
  assert.ok(result.problems.some(problem => /EEXIST|ENOTDIR/.test(problem)));
});
