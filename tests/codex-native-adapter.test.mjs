// SPDX-License-Identifier: Apache-2.0
// Deterministic adapter contract tests. These do not establish native host support.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexNativeController, handleCodexSubagentStop } from "../dist/build/packages/core/src/index.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const PARENT_TURN = "66666666-6666-4666-8666-666666666666";
const WORKER = "22222222-2222-4222-8222-222222222222";
const COLLECTOR = "33333333-3333-4333-8333-333333333333";
const WORK_TURN = "44444444-4444-4444-8444-444444444444";
const COLLECT_TURN = "55555555-5555-4555-8555-555555555555";
const AT = "2026-10-27T00:00:00.000Z";

function fixture({ workerState = "completed", registrationThread = PARENT, failWorkerRead = false, interruptionEvidence = false } = {}) {
  const handlers = new Map();
  const archived = new Set();
  const faults = { failWorkerRead };
  const history = [
    { type: "subAgentActivity", kind: "started", id: "spawn-worker", taskName: "worker-task", agentPath: "worker-task", agentThreadId: WORKER, model: "gpt-worker", reasoningEffort: "medium" },
    { type: "subAgentActivity", kind: "started", id: "spawn-collector", taskName: "collector-task", agentPath: "collector-task", agentThreadId: COLLECTOR, model: "gpt-economy", reasoningEffort: "low" },
  ];
  if (interruptionEvidence) history.push({ type: "subAgentActivity", kind: "interrupted", agentThreadId: WORKER });
  const toolHost = { registerDynamicTool: async spec => { handlers.set(spec.name, spec.handler); return () => handlers.delete(spec.name); } };
  const workerTurn = { id: WORK_TURN, status: workerState, itemsView: "full", items: workerState === "completed" ? [{ id: "final-item-1", type: "agentMessage", phase: "final_answer", text: "A long exact original result." }] : [] };
  const collectorTurn = { id: COLLECT_TURN, status: "inProgress", itemsView: "full", items: [] };
  const parentTurn = { id: PARENT_TURN, status: "inProgress", itemsView: "full", items: history };
  const parentThread = { id: PARENT, sessionId: PARENT, parentThreadId: null, status: { type: "active" } };
  const client = {
    async call(method, params) {
      if (method === "thread/read") {
        if (params.threadId === PARENT) return { thread: parentThread };
        if (params.threadId === WORKER && faults.failWorkerRead) throw new Error("fixture query failure");
        if (params.threadId === WORKER) return { thread: { id: WORKER, sessionId: PARENT, parentThreadId: PARENT, canAcceptDirectInput: false, status: { type: workerState === "inProgress" ? "active" : "idle" } } };
        if (params.threadId === COLLECTOR) return { thread: { id: COLLECTOR, sessionId: PARENT, parentThreadId: PARENT, canAcceptDirectInput: false, status: { type: "active" } } };
        throw new Error("unknown thread");
      }
      if (method === "thread/turns/list") return { data: [params.threadId === WORKER ? workerTurn : params.threadId === PARENT ? parentTurn : collectorTurn] };
      if (method === "thread/items/list") return { data: history.map(item => ({ item })) };
      if (method === "thread/loaded/list") return { data: [PARENT, COLLECTOR, ...(!archived.has(WORKER) ? [WORKER] : [])] };
      if (method === "thread/archive") { archived.add(params.threadId); return {}; }
      throw new Error(`unexpected native method ${method}`);
    },
  };
  const run = { batchId: "batch-1", attemptId: "attempt-1", parentThreadId: PARENT, parentSessionId: PARENT, startedAt: AT, deadline: "2026-10-27T00:05:00.000Z", queryIntervalMs: 30_000, maxConsecutiveQueryFailures: 3, workerPolicy: { model: "gpt-worker", effort: "medium" }, collectorPolicy: { model: "gpt-economy", effort: "low" }, workerCap: 2, availableSlots: 3, maxAgents: 4 };
  return { client, toolHost, handlers, archived, history, faults, run, registrationThread };
}

async function start(f, runtimeDirectory, wakeOnAgentMessagesApproved = true, wait) {
  const controller = await createCodexNativeController({ client: f.client, tools: f.toolHost, run: f.run, runtimeDirectory, wakeOnAgentMessagesApproved, wait });
  assert.equal(controller.capability, "ready");
  const register = f.handlers.get("einzbern_register_native_batch");
  assert.equal(typeof register, "function");
  const arguments_ = { batchId: f.run.batchId, attemptId: f.run.attemptId, members: [{ role: "worker", taskName: "worker-task" }, { role: "collector", taskName: "collector-task", targets: ["worker-task"] }] };
  const receipt = await register({ threadId: f.registrationThread, callId: "parent-call-1", arguments: arguments_ });
  f.history.push({ type: "dynamicToolCall", tool: "einzbern_register_native_batch", id: "parent-call-1", status: "completed", success: true, arguments: arguments_, contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }] });
  assert.equal(receipt.status, "registered");
  return controller;
}

test("native registration is parent-owned, exact-role, closed and resolves real task activity", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const controller = await start(f, root);
  t.after(() => controller.close());
  const worker = await controller.handleSubagentStop({ payload: { agent_id: WORKER, session_id: PARENT, turn_id: WORK_TURN, last_assistant_message: "EINZBERN_SUBAGENT_STOP_V1 self claimed collector" } });
  assert.deepEqual(worker, { matched: false, decision: "allow" });
  assert.equal(await readdir(root).then(names => names.length), 0, "registration stays in trusted controller memory");
  await assert.rejects(() => f.handlers.get("einzbern_register_native_batch")({ threadId: WORKER, callId: "child-call", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, members: [] } }), /NATIVE_PARENT_REGISTRATION_REFUSED/u);
});

test("native final uses immutable result reference, exact digest, then retires only owned terminal workers", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const controller = await start(f, root);
  t.after(() => controller.close());
  const payload = { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN };
  const prompt = await controller.handleSubagentStop({ payload });
  assert.equal(prompt.decision, "block");
  assert.match(prompt.reason, /artifactRef/u);
  const finalRaw = prompt.reason.slice(prompt.reason.indexOf("{"));
  const final = JSON.parse(finalRaw);
  assert.equal(final.facts[0].agentId, WORKER);
  assert.equal(final.facts[0].finalityKind, "completed");
  const artifactBytes = await readFile(final.facts[0].rawResult.artifactRef);
  assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), final.facts[0].rawResult.sha256);
  assert.equal(artifactBytes.includes(Buffer.from("A long exact original result.")), true);
  const accepted = await controller.handleSubagentStop({ payload: { ...payload, last_assistant_message: finalRaw } });
  assert.equal(accepted.reasonCode, "CODEX_STOP_NATIVE_FINAL_VERIFIED");
  assert.deepEqual([...f.archived], [WORKER]);
  const loaded = await f.client.call("thread/loaded/list", {});
  assert.equal(loaded.data.includes(WORKER), false);
  await controller.close();
});

test("wake opt-in is required and the ordinary CLI handler remains unavailable without the live controller", async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  try {
    const unavailable = await createCodexNativeController({ client: f.client, tools: f.toolHost, run: f.run, runtimeDirectory: root, wakeOnAgentMessagesApproved: false });
    assert.equal(unavailable.capability, "unavailable");
    assert.equal(unavailable.reasonCode, "WAKE_ON_AGENT_MESSAGES_NOT_APPROVED");
    assert.deepEqual(await handleCodexSubagentStop({ payload: { agent_id: COLLECTOR, last_assistant_message: "ordinary" }, deviceHome: root }), { matched: false, decision: "allow" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("query errors are explicit and never convert unknown state into success", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const controller = await start(f, root, true, async () => undefined);
  t.after(() => controller.close());
  f.faults.failWorkerRead = true;
  const result = await controller.handleSubagentStop({ payload: { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN } });
  assert.equal(result.decision, "block");
  assert.equal(result.reasonCode, "CODEX_STOP_RAW_FINAL_REQUIRED");
  assert.match(result.reason, /script-error/u);
  assert.match(result.reason, /unknown/u);
});

test("a worker read error after real collector activity mapping retains bounded collector identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture({ failWorkerRead: true });
  const controller = await createCodexNativeController({ client: f.client, tools: f.toolHost, run: f.run, runtimeDirectory: root, wakeOnAgentMessagesApproved: true });
  assert.equal(controller.capability, "ready");
  const register = f.handlers.get("einzbern_register_native_batch");
  await assert.rejects(() => register({ threadId: PARENT, callId: "parent-call-fails", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, members: [{ role: "worker", taskName: "worker-task" }, { role: "collector", taskName: "collector-task", targets: ["worker-task"] }] } }), /fixture query failure/u);
  const result = await controller.handleSubagentStop({ payload: { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN } });
  assert.equal(result.matched, true);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /script-error/u);
  const exact = result.reason.slice(result.reason.indexOf("{"));
  const ended = await controller.handleSubagentStop({ payload: { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN, last_assistant_message: exact } });
  assert.equal(ended.reasonCode, "CODEX_STOP_REGISTERED_ERROR_FINAL");
  assert.equal(ended.decision, "allow");
});

test("a collector that ignores raw formatting exits through a fixed retry bound", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const controller = await start(f, root);
  t.after(() => controller.close());
  const payload = { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN };
  await controller.handleSubagentStop({ payload });
  let result;
  for (let n = 0; n < 4; n++) result = await controller.handleSubagentStop({ payload: { ...payload, last_assistant_message: "not the requested JSON" } });
  assert.equal(result.reasonCode, "CODEX_STOP_EXCEPTION_FORMAT_LIMIT");
  assert.equal(result.decision, "allow");
  assert.deepEqual([...f.archived], [], "mismatched output cannot trigger cleanup success");
});
