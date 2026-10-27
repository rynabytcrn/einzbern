// SPDX-License-Identifier: Apache-2.0
// Deterministic adapter contract tests. These do not establish native host support.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, chmod, symlink, writeFile } from "node:fs/promises";
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
  const faults = { failWorkerRead, hang: false, latency: 0, cursor: null, closeRead: null };
  let clock = Date.parse(AT);
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
    async call(method, params, { signal } = {}) {
      if (faults.hang) return new Promise((_resolve, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      clock += faults.latency;
      if (faults.closeRead) await faults.closeRead();
      if (method === "thread/read") {
        if (params.threadId === PARENT) return { thread: parentThread };
        if (params.threadId === WORKER && faults.failWorkerRead) throw new Error("fixture query failure");
        if (params.threadId === WORKER) return { thread: { id: WORKER, sessionId: PARENT, parentThreadId: PARENT, canAcceptDirectInput: false, status: { type: faults.workerThreadStatus ?? (workerState === "inProgress" ? "active" : "idle") } } };
        if (params.threadId === COLLECTOR) return { thread: { id: COLLECTOR, sessionId: PARENT, parentThreadId: PARENT, canAcceptDirectInput: false, status: { type: "active" } } };
        throw new Error("unknown thread");
      }
      if (method === "thread/turns/list") return { data: [params.threadId === WORKER ? workerTurn : params.threadId === PARENT ? parentTurn : collectorTurn] };
      if (method === "thread/items/list") return { data: history.map(item => ({ item })), ...(faults.cursor ? { nextCursor: faults.cursor } : {}) };
      if (method === "thread/loaded/list") return { data: [PARENT, COLLECTOR, ...(!archived.has(WORKER) ? [WORKER] : [])] };
      if (method === "thread/archive") { archived.add(params.threadId); return {}; }
      throw new Error(`unexpected native method ${method}`);
    },
  };
  const run = { batchId: "batch-1", attemptId: "attempt-1", parentThreadId: PARENT, parentSessionId: PARENT, startedAt: AT, deadline: "2026-10-27T00:05:00.000Z", queryIntervalMs: 30_000, maxConsecutiveQueryFailures: 3, workerPolicy: { model: "gpt-worker", effort: "medium" }, collectorPolicy: { model: "gpt-economy", effort: "low" }, workerCap: 2, availableSlots: 3, maxAgents: 4 };
  return { client, toolHost, handlers, archived, history, faults, run, registrationThread, workerTurn, collectorTurn, parentThread, now: () => clock, advance: ms => { clock += ms; } };
}

async function start(f, runtimeDirectory, wakeOnAgentMessagesApproved = true, wait) {
  const controller = await createCodexNativeController({ client: f.client, tools: f.toolHost, run: f.run, runtimeDirectory, wakeOnAgentMessagesApproved, ...(wait ? { wait } : {}), now: f.now, helperEntry: "/product/einzbern-hook.mjs", transport: { abort: "supported", rpcTimeoutMs: 1000, hookTimeoutMs: 5000, evidenceRef: "synthetic-fixture-only" } });
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
  assert.deepEqual(await readdir(root), ["native-results"], "evidence persists but never enrolls members");
  await assert.rejects(() => f.handlers.get("einzbern_register_native_batch")({ threadId: WORKER, callId: "child-call", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, members: [] } }), /NATIVE_PARENT_REGISTRATION_REFUSED/u);
});

test("native final uses immutable canonical result reference and retains release responsibility", async t => {
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
  assert.equal(accepted.reasonCode, "CODEX_STOP_NATIVE_FINAL_ACCEPTED_RELEASE_UNVERIFIED");
  assert.deepEqual([...f.archived], []);
  const loaded = await f.client.call("thread/loaded/list", {});
  assert.equal(loaded.data.includes(WORKER), true);
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
  assert.equal(result.reasonCode, "CODEX_STOP_QUERY_RETRY_WAIT_REQUIRED");
  assert.match(controller.responsibility().error, /fixture query failure/u);
});

test("a worker read error after real collector activity mapping retains bounded collector identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture({ failWorkerRead: true });
  const controller = await createCodexNativeController({ client: f.client, tools: f.toolHost, run: f.run, runtimeDirectory: root, wakeOnAgentMessagesApproved: true, now: f.now, helperEntry: "/product/einzbern-hook.mjs", transport: { abort: "supported", rpcTimeoutMs: 1000, hookTimeoutMs: 5000, evidenceRef: "synthetic-fixture-only" } });
  assert.equal(controller.capability, "ready");
  const register = f.handlers.get("einzbern_register_native_batch");
  const failed = await register({ threadId: PARENT, callId: "parent-call-fails", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, members: [{ role: "worker", taskName: "worker-task" }, { role: "collector", taskName: "collector-task", targets: ["worker-task"] }] } });
  assert.equal(failed.status, "failed");
  assert.match(failed.reasonCode, /fixture query failure/u);
  assert.deepEqual(failed.responsibility.children.sort(), [WORKER, COLLECTOR].sort());
  assert.deepEqual(await controller.handleSubagentStop({ payload: { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN } }), { matched: false, decision: "allow" });
  await controller.close();
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
  assert.equal(result.reasonCode, "CODEX_STOP_FAILED_FINAL_HANDOFF_RELEASE_UNVERIFIED");
  assert.equal(controller.responsibility().state, "failed-final-unresolved");
  assert.equal(result.decision, "allow");
  assert.deepEqual([...f.archived], [], "mismatched output cannot trigger cleanup success");
});

const collectorPayload = { agent_id: COLLECTOR, session_id: PARENT, turn_id: COLLECT_TURN };
async function isolated(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-f1-regression-"));
  const f = fixture(config); const controller = await start(f, root);
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  return { f, root, controller };
}
function exactFinal(prompt) { return prompt.reason.slice(prompt.reason.indexOf("{")); }

test("latency is evaluated after all reads and expired/skewed clocks do not pass", async t => {
  const { f, controller } = await isolated(t);
  f.faults.latency = 7000;
  const stale = await controller.handleSubagentStop({ payload: collectorPayload });
  assert.equal(stale.decision, "block"); assert.match(controller.responsibility().error, /STALE/u);
  f.advance(400000);
  const expired = await controller.handleSubagentStop({ payload: collectorPayload });
  assert.match(expired.reason, /deadline/u);
});

test("repeated cursor has a finite explicit owner failure", async t => {
  const { f, controller } = await isolated(t); f.faults.cursor = "same";
  await controller.handleSubagentStop({ payload: collectorPayload });
  assert.match(controller.responsibility().error, /NO_PROGRESS/u);
});

test("hanging RPC settles at the owning client bound and retains children", async t => {
  const { f, controller } = await isolated(t); f.faults.hang = true;
  const result = await controller.handleSubagentStop({ payload: collectorPayload });
  assert.equal(result.decision, "block"); assert.match(controller.responsibility().error, /TIMEOUT/u);
  assert.equal(controller.responsibility().children.length, 2);
});

test("concurrent duplicate finals serialize and changed native final is revalidated", async t => {
  const { f, controller } = await isolated(t);
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  f.workerTurn.items[0].text = "changed";
  const rejected = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(rejected.reasonCode, "CODEX_STOP_FINAL_CHANGED");
  const updated = await controller.handleSubagentStop({ payload: collectorPayload });
  const duplicates = await Promise.all([1, 2].map(() => controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(updated) } })));
  assert.deepEqual(duplicates.map(x => x.reasonCode), ["CODEX_STOP_NATIVE_FINAL_ACCEPTED_RELEASE_UNVERIFIED", "CODEX_STOP_ALREADY_ENDED_RELEASE_UNVERIFIED"]);
  const later = await controller.handleSubagentStop({ payload: { ...collectorPayload, turn_id: WORK_TURN } });
  assert.equal(later.decision, "block");
});

test("changed parent control cannot reuse staged final", async t => {
  const { f, controller } = await isolated(t);
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  await f.handlers.get("einzbern_control_native_batch")({ threadId: PARENT, callId: "pause", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, exception: "paused" } });
  const result = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(result.reasonCode, "CODEX_STOP_FINAL_CHANGED");
});

test("writable equal-byte artifact is rejected at final consumption", async t => {
  const { controller } = await isolated(t);
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  const raw = JSON.parse(exactFinal(prompt)).facts[0].rawResult;
  await chmod(raw.artifactRef, 0o600);
  const result = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(result.decision, "block"); assert.match(controller.responsibility().error, /UNSAFE/u);
});

test("close aborts in-flight RPC, rejects late handlers, never claims native release", async t => {
  const { f, controller } = await isolated(t); f.faults.hang = true;
  const pending = controller.handleSubagentStop({ payload: collectorPayload });
  await new Promise(resolve => setImmediate(resolve));
  await controller.close(); await assert.rejects(pending, /CLOSED|ABORTED/u);
  await assert.rejects(controller.handleSubagentStop({ payload: collectorPayload }), /CLOSED/u);
  assert.match(controller.responsibility().state, /owner-retains/u);
});

test("pending collector waits through the product helper outside stop and stays in its pinned turn", async t => {
  const { f, controller } = await isolated(t, { workerState: "inProgress" });
  const result = await controller.handleSubagentStop({ payload: collectorPayload });
  assert.equal(result.reasonCode, "CODEX_STOP_WAIT_REQUIRED"); assert.match(result.reason, /collector-wait/u);
  const early = await controller.handleSubagentStop({ payload: collectorPayload });
  assert.equal(early.reasonCode, "CODEX_STOP_WAIT_REQUIRED");
  await assert.rejects(controller.waitCollector({ payload: { batchId: "wrong" } }), /IDENTITY/u);
  f.advance(30000);
  assert.equal((await controller.waitCollector({ payload: { batchId: f.run.batchId, attemptId: f.run.attemptId, agentId: COLLECTOR, turnId: COLLECT_TURN, sessionId: PARENT } })).status, "waited");
});

for (const state of ["failed", "interrupted", "inProgress"]) test(`native ${state} keeps distinct finality and ownership`, async t => {
  const { controller } = await isolated(t, { workerState: state, interruptionEvidence: true });
  const result = await controller.handleSubagentStop({ payload: collectorPayload });
  if (state === "inProgress") assert.equal(result.reasonCode, "CODEX_STOP_WAIT_REQUIRED");
  else assert.equal(JSON.parse(exactFinal(result)).facts[0].finalityKind, state === "failed" ? "failed" : "cancelled_confirmed");
  assert.equal(controller.responsibility().children.length, 2);
});


test("concurrent registration reserves one attempt and early failure reports unresolved discovery", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-register-bound-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(); const controller = await createCodexNativeController({ client: f.client, tools: f.toolHost, run: f.run, runtimeDirectory: root, wakeOnAgentMessagesApproved: true, now: f.now, helperEntry: "/product/einzbern-hook.mjs", transport: { abort: "supported", rpcTimeoutMs: 1000, hookTimeoutMs: 5000, evidenceRef: "synthetic-only" } }); t.after(() => controller.close());
  f.parentThread.sessionId = "wrong";
  const request = { threadId: PARENT, callId: "early", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, members: [{ role: "worker", taskName: "worker-task" }, { role: "collector", taskName: "collector-task", targets: ["worker-task"] }] } };
  const handler = f.handlers.get("einzbern_register_native_batch");
  const results = await Promise.all([handler(request), handler(request)]);
  assert.equal(results[0].status, "failed"); assert.match(results[0].discovery, /unresolved/u);
  assert.equal(results[1].reasonCode, "NATIVE_REGISTRATION_ALREADY_ATTEMPTED");
  assert.deepEqual(await controller.handleSubagentStop({ payload: collectorPayload }), { matched: false, decision: "allow" });
});

test("symlink artifact cannot be consumed even if target bytes match", async t => {
  const { root, controller } = await isolated(t);
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  const raw = JSON.parse(exactFinal(prompt)).facts[0].rawResult;
  const target = join(root, "retained-original");
  const { rename } = await import("node:fs/promises"); await rename(raw.artifactRef, target); await symlink(target, raw.artifactRef);
  const result = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(result.decision, "block"); assert.match(controller.responsibility().error, /ELOOP|UNSAFE/u);
});

test("clock skew and parent receipt tampering never verify a staged final", async t => {
  const { f, controller } = await isolated(t);
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  f.history.find(item => item.type === "dynamicToolCall").contentItems[0].text = "{}";
  const result = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(result.decision, "block"); assert.match(controller.responsibility().error, /RECEIPT/u);
  f.advance(-1000); await assert.rejects(controller.handleSubagentStop({ payload: collectorPayload }), /SKEW/u);
});


for (const exception of ["budget-exhausted", "paused", "user-cancelled", "safety", "permission"]) test(`authenticated ${exception} hands off active workers without release`, async t => {
  const { f, controller } = await isolated(t, { workerState: "inProgress" });
  await f.handlers.get("einzbern_control_native_batch")({ threadId: PARENT, callId: "control", arguments: { batchId: f.run.batchId, attemptId: f.run.attemptId, exception } });
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  assert.equal(JSON.parse(exactFinal(prompt)).exception, exception);
  const allowed = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(allowed.reasonCode, "CODEX_STOP_NATIVE_FINAL_ACCEPTED_RELEASE_UNVERIFIED");
  assert.equal(controller.responsibility().state, "exception-handoff-unresolved"); assert.equal(controller.responsibility().children.length, 2);
});

test("failed native systemError remains failed while altered immutable bytes fail digest", async t => {
  const { f, controller } = await isolated(t, { workerState: "failed" }); f.faults.workerThreadStatus = "systemError";
  const prompt = await controller.handleSubagentStop({ payload: collectorPayload });
  const fact = JSON.parse(exactFinal(prompt)).facts[0]; assert.equal(fact.finalityKind, "failed");
  await chmod(fact.rawResult.artifactRef, 0o600); await writeFile(fact.rawResult.artifactRef, "tampered"); await chmod(fact.rawResult.artifactRef, 0o400);
  const result = await controller.handleSubagentStop({ payload: { ...collectorPayload, last_assistant_message: exactFinal(prompt) } });
  assert.equal(result.decision, "block"); assert.match(controller.responsibility().error, /DIGEST|UNSAFE/u);
});
