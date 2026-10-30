// SPDX-License-Identifier: Apache-2.0
// INIT-080: operation counts prove activation; exact differential outputs prove semantics.
// The unchanged external 995 baseline is separate evidence, not a CI filesystem dependency.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { appendEvents, applyWorkBatch, createProject, createWork, createWorkDelta, admitTemplateInWorkspace, defaultWorkContentTemplate, workContentDraft, materializeWorkspaceFromGenesis } from "../dist/build/packages/core/src/index.js";
import { appendPlannedWrite } from "../dist/build/packages/core/src/workspace.js";
import { createWorkBatchMemberDelta } from "../dist/build/packages/core/src/work-batch-delta.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { appendHistoricalAttestationEnable, appendHistoricalWorkCreate, cliProcess } from "./helpers/workspace-fixture.mjs";
import { AT, input, wrap, append, pair, fastCounts, legacyCounts, correctiveProbe } from "./helpers/init080-work-create-fixture.mjs";

const workId = (key) => deriveStableId("work", key);
const member = (projectId, externalKey, patch = {}) => ({ verb: "work-create", projectId, externalKey, kind: "Initiative", parentId: null, status: "planned", title: externalKey, ...patch });
const document = (members) => ({ schemaVersion: "tcrn.work-batch.v1", members });
// Independent representation of the existing indexed-refusal contract, not a trusted switch.
async function batch(fx, members, options = { occurredAt: AT }) {
  if (!fx.legacy) return applyWorkBatch(fx.root, document(members), options);
  try {
    return await appendEvents(fx.root, members.map((value) => wrap(createWorkBatchMemberDelta(value, options), true)), options);
  } catch (error) {
    if (typeof error.memberIndex !== "number") throw error;
    const index = error.memberIndex;
    const mapped = new Error(JSON.stringify({ stage: "apply", failed: { index, verb: members[index].verb ?? null, phase: error.memberPhase ?? "delta", reasonCode: error.reasonCode || "WORKSPACE_ERROR", detail: error.message }, notEvaluated: members.slice(index + 1).map((_, offset) => index + offset + 1) }));
    mapped.name = "WorkspaceError"; mapped.reasonCode = "WORK_BATCH_REFUSED"; throw mapped;
  }
}

for (const initial of [0, 8]) test(`INIT080 exact factories validate one initial prefix and one terminal graph (existing=${initial})`, async (t) => {
  const n = 16;
  const { fast, legacy } = await pair(t, (fx) => append(fx, Array.from({ length: n }, (_, i) => input(fx.projectId, `NEW-${n - i}`))), {
    seed: initial ? async (fx) => appendEvents(fx.root, Array.from({ length: initial }, (_, i) => createWorkDelta(input(fx.projectId, `SEED-${i}`))), { occurredAt: AT }) : undefined,
  });
  assert.equal(fast.ok, true); fastCounts(fast.metrics, n, initial); legacyCounts(legacy.metrics, n, initial);
  assert.equal(fast.metrics.writeCreateClosureRecordsVisited, n - 1);
});

test("INIT080 same-batch parent hierarchy preserves canonical state and order", async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, [
    input(fx.projectId, "TREE-I"), input(fx.projectId, "TREE-E", { kind: "Epic", parentId: workId("TREE-I") }),
    input(fx.projectId, "TREE-S", { kind: "Story", parentId: workId("TREE-E"), goal: "Preserve semantics", acceptance: "Exact comparison succeeds" }),
    input(fx.projectId, "TREE-T", { kind: "Subtask", parentId: workId("TREE-S") }),
  ]));
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 4); assert.equal(fast.metrics.writeCreateClosureRecordsVisited, 2 + 3 + 4);
});

for (const failedIndex of [0, 1, 2, 3]) test(`INIT080 invalid prefix member ${failedIndex} rejects atomically before future repair`, async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, Array.from({ length: 5 }, (_, i) => input(fx.projectId, `PREFIX-${i}`, i === failedIndex ? { kind: "Epic", parentId: workId("PREFIX-4") } : {}))));
  assert.equal(fast.ok, false); assert.equal(fast.error.memberIndex, failedIndex); assert.equal(fast.error.memberPhase, "delta");
  assert.equal(fast.error.reasonCode, "REFERENTIAL_INTEGRITY"); assert.equal(fast.metrics.writeCreateTerminalValidation, 0);
});

const invalidCases = [
  ["duplicate", (p) => [input(p, "DUP"), input(p, "DUP")], "WORKSPACE_INPUT_INVALID"],
  ["missing project before duplicate", (p) => [input(p, "DUP"), input("project:missing", "DUP")], null],
  ["parent kind", (p) => [input(p, "P"), input(p, "BAD", { kind: "Story", parentId: workId("P"), goal: "Goal", acceptance: "Check" })], "GRAPH_PARENT_KIND_INVALID"],
  ["top-level parent", (p) => [input(p, "P"), input(p, "BAD", { parentId: workId("P") })], "GRAPH_PARENT_KIND_INVALID"],
  ["retired before malformed key", (p) => [input(p, "OK"), input(p, "", { kind: "Incident" })], "WORK_KIND_RETIRED"],
  ["template required", (p) => [input(p, "OK"), input(p, "BAD", { content: workContentDraft("Initiative") })], "WORK_CONTENT_TEMPLATE_REQUIRED"],
  ["invalid content before parent", (p) => [input(p, "OK"), input(p, "BAD", { kind: "Epic", parentId: "work:missing", content: { schemaVersion: "invalid" } })], null],
  ["unknown template", (p) => [input(p, "OK"), input(p, "BAD", { templateAdmission: { schemaVersion: "invalid" } })], null],
  ["invalid status", (p) => [input(p, "OK"), input(p, "BAD", { status: "impossible" })], null],
];
for (const [name, inputs, reason] of invalidCases) test(`INIT080 differential refusal precedence: ${name}`, async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, inputs(fx.projectId)));
  assert.equal(fast.ok, false); assert.equal(fast.error.memberIndex, 1); if (reason) assert.equal(fast.error.reasonCode, reason);
});

test("INIT080 cross-project parent refuses with the unchanged graph error", async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, [input(fx.projectId, "OK"), input(fx.projectId, "CHILD", { kind: "Epic", parentId: workId("OTHER-PARENT") })]), {
    seed: async (fx) => { const other = await createProject(fx.root, { externalKey: "OTHER", name: "Other", occurredAt: AT }); const p = other.projects.find((v) => v.externalKey === "OTHER"); await createWork(fx.root, input(p.id, "OTHER-PARENT")); },
  });
  assert.equal(fast.error.reasonCode, "GRAPH_CROSS_PROJECT_PARENT");
});

test("INIT080 admitted typed content and shared nested aliases are not mutated", async (t) => {
  const { fast } = await pair(t, async (fx) => {
    const receipt = fx.state.templates[0].receipt;
    const shared = workContentDraft("Initiative");
    const labels = ["same"];
    const inputs = [input(fx.projectId, "CONTENT-A", { content: shared, templateAdmission: receipt, labels }), input(fx.projectId, "CONTENT-B", { content: shared, templateAdmission: receipt, labels })];
    const before = structuredClone(inputs); const state = await append(fx, inputs);
    assert.deepEqual(inputs, before); assert.equal(inputs[0].content, inputs[1].content); assert.equal(inputs[0].labels, inputs[1].labels);
    return state;
  }, { seed: (fx) => admitTemplateInWorkspace(fx.root, { template: defaultWorkContentTemplate("Initiative"), ownerId: "owner:fixture", occurredAt: AT }) });
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 2);
});

test("INIT080 factory captures live input until execution, including asynchronous setup", async (t) => {
  const { fast } = await pair(t, async (fx) => {
    const values = [input(fx.projectId, "MUTATE-A", { summary: undefined }), input(fx.projectId, "MUTATE-B")];
    const builders = values.map((v) => wrap(createWorkDelta(v), fx.legacy));
    values[0].title = "changed after factory construction";
    const pending = appendEvents(fx.root, builders, { occurredAt: AT });
    values[1].title = "changed while append is awaiting setup";
    const state = await pending;
    assert.equal(state.work.find((w) => w.externalKey === "MUTATE-A").title, values[0].title);
    assert.equal(state.work.find((w) => w.externalKey === "MUTATE-B").title, values[1].title);
    assert.equal(Object.hasOwn(values[0], "summary"), true); return state;
  });
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 2);
});

for (const variant of ["accessor", "proxy", "nonplain", "nonenumerable", "symbol", "function", "cyclic", "negative-zero"]) test(`INIT080 unsafe capture ${variant} retains caller behavior`, async (t) => {
  const { fast } = await pair(t, async (fx) => {
    let value = input(fx.projectId, "UNSAFE");
    if (variant === "accessor") Object.defineProperty(value, "title", { enumerable: true, get() { fx.trace.push("title"); return "Observed"; } });
    if (variant === "proxy") value = new Proxy(value, { get(target, key, receiver) { fx.trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); }, ownKeys(target) { fx.trace.push("ownKeys"); return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { fx.trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); } });
    if (variant === "nonplain") Object.setPrototypeOf(value, { marker: true });
    if (variant === "nonenumerable") Object.defineProperty(value, "unused", { value: "hidden" });
    if (variant === "symbol") value[Symbol("unused")] = 1;
    if (variant === "function") value.unused = () => {};
    if (variant === "cyclic") value.unused = value;
    if (variant === "negative-zero") value.unused = -0;
    const state = await append(fx, [input(fx.projectId, "SAFE"), value]);
    if (variant === "negative-zero") assert.equal(Object.is(value.unused, -0), true);
    return state;
  });
  assert.equal(fast.ok, true);
  if (variant !== "negative-zero") { assert.equal(fast.metrics.writeCreateClosureValidation, 0); assert.equal(fast.metrics.writeCreateTerminalValidation, 0); }
});

test("INIT080 actual all-create work-batch activates closure validation", async (t) => {
  const { fast, legacy } = await pair(t, (fx) => batch(fx, Array.from({ length: 8 }, (_, i) => member(fx.projectId, `BATCH-${i}`))));
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 8); legacyCounts(legacy.metrics, 8);
});

test("INIT080 actual CLI handler activates the production all-create path", async (t) => {
  const { fast, legacy } = await pair(t, async (fx) => {
    const members = Array.from({ length: 4 }, (_, i) => member(fx.projectId, `CLI-${i}`));
    if (fx.legacy) return batch(fx, members);
    const path = join(fx.base, "batch.json"); await writeFile(path, JSON.stringify(document(members)));
    let output = "";
    await runCli(["work-batch", "--workspace", fx.root, "--at", AT, "--from-file", path], { write(value) { output += value; } });
    assert.ok(JSON.parse(output)); return materializeWorkspaceFromGenesis(fx.root);
  });
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 4); legacyCounts(legacy.metrics, 4);
});

test("INIT080 shipped CLI process imports the deferred factory cycle and round-trips", async (t) => {
  const { fast } = await pair(t, async (fx) => {
    const path = join(fx.base, fx.legacy ? "process-legacy.json" : "process-fast.json");
    await writeFile(path, JSON.stringify(document([member(fx.projectId, "PROCESS-A"), member(fx.projectId, "PROCESS-B")])));
    const receipt = await cliProcess(["work-batch", "--workspace", fx.root, "--at", AT, "--from-file", path]);
    assert.equal(receipt.status, 0, receipt.stderr); assert.ok(JSON.parse(receipt.stdout));
    return materializeWorkspaceFromGenesis(fx.root);
  });
  assert.equal(fast.ok, true); assert.equal(fast.replay.work.length, 2);
});

for (const bad of ["parentExternalKey", "involvedProjects"]) test(`INIT080 deferred ${bad} normalization keeps member blame`, async (t) => {
  const { fast } = await pair(t, (fx) => batch(fx, [member(fx.projectId, "DEFER-A"), member(fx.projectId, "DEFER-B", bad === "parentExternalKey" ? { kind: "Epic", parentExternalKey: "invalid key" } : { involvedProjects: { state: "unknown", targets: [] } }), member(fx.projectId, "DEFER-C")]));
  assert.equal(fast.ok, false); assert.equal(fast.error.reasonCode, "WORK_BATCH_REFUSED");
  const refusal = JSON.parse(fast.error.message); assert.equal(refusal.stage, "apply"); assert.equal(refusal.failed.index, 1); assert.equal(refusal.failed.phase, "delta"); assert.deepEqual(refusal.notEvaluated, [2]);
  if (bad === "parentExternalKey") assert.equal(refusal.failed.reasonCode, "EXTERNAL_KEY_INVALID");
  assert.equal(fast.metrics.writeCreateFullValidation, 1); assert.equal(fast.metrics.writeCreateTerminalValidation, 0);
});

test("INIT080 complete shape pass precedes any semantic member or graph validation", async (t) => {
  const { fast } = await pair(t, (fx) => applyWorkBatch(fx.root, document([member(fx.projectId, "FIRST", { kind: "Epic", parentExternalKey: "invalid key" }), { ...member(fx.projectId, "SECOND"), title: undefined }, { verb: "not-a-verb" }]), { occurredAt: AT }));
  assert.equal(fast.ok, false); const refusal = JSON.parse(fast.error.message);
  assert.equal(refusal.stage, "shape"); assert.deepEqual([...new Set(refusal.problems.map((v) => v.index))], [1, 2]); assert.equal(fast.metrics.writeCreateFullValidation, 0);
});

test("INIT080 actor failure precedes later deferred bad member", async (t) => {
  const { fast } = await pair(t, (fx) => batch(fx, [member(fx.projectId, "ACTOR-A"), member(fx.projectId, "ACTOR-B", { kind: "Epic", parentExternalKey: "invalid key" })]), {
    seed: (fx) => appendHistoricalAttestationEnable(fx.root, { occurredAt: AT, actorId: "owner:fixture" }),
  });
  const refusal = JSON.parse(fast.error.message); assert.equal(refusal.failed.index, 0); assert.equal(refusal.failed.phase, "actor"); assert.equal(refusal.failed.reasonCode, "WORKSPACE_ACTOR_REQUIRED"); assert.deepEqual(refusal.notEvaluated, [1]);
});

test("INIT080 event failure precedes later deferred bad member and options getter effects match", async (t) => {
  const { fast } = await pair(t, (fx) => {
    let reads = 0;
    const options = { get occurredAt() { reads += 1; fx.trace.push(`at:${reads}`); return reads >= 4 ? "invalid instant" : AT; } };
    return batch(fx, [member(fx.projectId, "EVENT-A"), member(fx.projectId, "EVENT-B", { kind: "Epic", parentExternalKey: "invalid key" })], options);
  });
  assert.equal(fast.ok, false); const refusal = JSON.parse(fast.error.message); assert.equal(refusal.failed.index, 0); assert.equal(refusal.failed.phase, "event"); assert.deepEqual(refusal.notEvaluated, [1]); assert.equal(fast.metrics.writeCreateClosureValidation, 0);
});

for (const target of ["member", "options"]) test(`INIT080 deferred ${target} getters keep observation counts and legacy fallback`, async (t) => {
  const { fast } = await pair(t, (fx) => {
    const members = [member(fx.projectId, "GET-A"), member(fx.projectId, "GET-B")];
    const options = { occurredAt: AT };
    if (target === "member") Object.defineProperty(members[1], "involvedProjects", { enumerable: true, get() { fx.trace.push("involvedProjects"); return { state: "undecided", targets: [] }; } });
    else Object.defineProperty(options, "actorId", { enumerable: true, get() { fx.trace.push("actorId"); members[1].title = "mutated by actor getter"; return undefined; } });
    return batch(fx, members, options);
  });
  assert.equal(fast.ok, true); assert.equal(fast.metrics.writeCreateClosureValidation, 0); assert.ok(fast.trace.length > 0);
});

test("INIT080 production captures mutations made while its asynchronous setup runs", async (t) => {
  const { fast } = await pair(t, async (fx) => {
    const members = [member(fx.projectId, "ASYNC-A"), member(fx.projectId, "ASYNC-B")];
    const pending = batch(fx, members); members[1].title = "latest mutable input";
    const state = await pending; assert.equal(state.work.find((w) => w.externalKey === "ASYNC-B").title, members[1].title); return state;
  });
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 2);
});

test("INIT080 mixed create-transition-create work-batch preserves legacy eligibility", async (t) => {
  const { fast, legacy } = await pair(t, (fx) => batch(fx, [member(fx.projectId, "MIX-A"), { verb: "work-transition", externalKey: "MIX-A", status: "ready" }, member(fx.projectId, "MIX-B")]));
  assert.equal(fast.ok, true); assert.equal(fast.metrics.writeCreateClosureValidation, 0); assert.equal(fast.metrics.writeCreateTerminalValidation, 0); assert.deepEqual(fast.metrics, legacy.metrics);
});

test("INIT080 custom mutation cannot reuse a prior work index or admit a tombstoned parent", async (t) => {
  const { fast } = await pair(t, (fx) => {
    const custom = (state) => { state.work.find((w) => w.id === workId("PARENT")).tombstone = true; return createWorkDelta(input(fx.projectId, "CHILD", { kind: "Epic", parentId: workId("PARENT") }))(state); };
    return appendEvents(fx.root, [wrap(createWorkDelta(input(fx.projectId, "FIRST")), fx.legacy), custom], { occurredAt: AT });
  }, { seed: (fx) => createWork(fx.root, input(fx.projectId, "PARENT")) });
  assert.equal(fast.error.reasonCode, "TOMBSTONE_REFERENCED"); assert.equal(fast.error.memberIndex, 1); assert.equal(fast.metrics.writeCreateClosureValidation, 0);
});

test("INIT080 state-exposing planned writes never acquire trusted create eligibility", async (t) => {
  const { fast } = await pair(t, (fx) => appendPlannedWrite(fx.root, { occurredAt: AT }, {
    async plan(_root, state) { fx.trace.push(state.work.length); return { deltas: [wrap(createWorkDelta(input(fx.projectId, "PLAN-A")), fx.legacy), wrap(createWorkDelta(input(fx.projectId, "PLAN-B")), fx.legacy)], plan: state }; },
    async unchanged() { return true; },
    async write(_root, _state, captured, commit) { fx.trace.push(captured.work.length); return commit(); },
  }));
  assert.equal(fast.ok, true); legacyCounts(fast.metrics, 2);
});

for (const conflicts of [1, 4]) test(`INIT080 ${conflicts} optimistic conflicts rebuild attempt-local fast validation`, async (t) => {
  const { fast } = await pair(t, (fx) => {
    let entered = 0;
    return append(fx, [input(fx.projectId, "RETRY-A"), input(fx.projectId, "RETRY-B"), input(fx.projectId, "RETRY-C")], {
      async insideWriteLockForTest() {
        entered += 1; fx.trace.push(entered);
        if (entered <= conflicts) await createWork(fx.root, input(fx.projectId, `INTERLOPER-${entered}`));
      },
    });
  }, { atomic: false });
  assert.equal(fast.ok, true); assert.equal(fast.trace.length, conflicts + 1);
  assert.equal(fast.metrics.writeCreateClosureValidation, 2 * (conflicts + 1), "every failed attempt and the successful/under-lock attempt is fast");
  assert.equal(fast.metrics.writeCreateTerminalValidation, conflicts + 1);
  assert.equal(fast.replay.work.length, conflicts + 3);
});

test("INIT080 a retry that now sees a duplicate rejects without partial outer writes", async (t) => {
  const { fast } = await pair(t, (fx) => {
    let entered = false;
    return append(fx, [input(fx.projectId, "RACE-A"), input(fx.projectId, "RACE-B")], {
      async insideWriteLockForTest() { if (!entered) { entered = true; await createWork(fx.root, input(fx.projectId, "RACE-A")); } },
    });
  }, { atomic: false });
  assert.equal(fast.ok, false); assert.equal(fast.error.memberIndex, 0); assert.equal(fast.error.reasonCode, "WORKSPACE_INPUT_INVALID");
  assert.deepEqual(fast.replay.work.map((w) => w.externalKey), ["RACE-A"]); assert.equal(fast.metrics.writeCreateClosureValidation, 1); assert.equal(fast.metrics.writeCreateTerminalValidation, 1);
});

test("INIT080 historical deep Incident ancestry retains full rejection semantics", async (t) => {
  const depth = 24;
  const { fast } = await pair(t, (fx) => append(fx, [input(fx.projectId, "DEEP-OK"), input(fx.projectId, "DEEP-CHILD", { kind: "Epic", parentId: workId(`OLD-${depth - 1}`) })]), {
    seed: async (fx) => { for (let i = 0; i < depth; i += 1) await appendHistoricalWorkCreate(fx.root, { projectId: fx.projectId, externalKey: `OLD-${i}`, kind: "Incident", parentId: i ? workId(`OLD-${i - 1}`) : null, occurredAt: AT }); },
  });
  assert.equal(fast.ok, false); assert.equal(fast.error.reasonCode, "GRAPH_PARENT_KIND_INVALID"); assert.equal(fast.metrics.writeCreateClosureRecordsVisited, depth + 1);
});

test("INIT080 empty direct batches retain the original pre-loop refusal", async (t) => {
  const { fast } = await pair(t, (fx) => appendEvents(fx.root, [], { occurredAt: AT }));
  assert.equal(fast.error.reasonCode, "WORKSPACE_INPUT_INVALID"); assert.equal(fast.error.memberIndex, undefined); assert.equal(fast.metrics.writeCreateFullValidation, 0);
});

test("INIT080 unknown builder cannot hide a historical cycle from full validation", async (t) => {
  const { fast } = await pair(t, (fx) => appendEvents(fx.root, [
    wrap(createWorkDelta(input(fx.projectId, "BEFORE-CYCLE")), fx.legacy),
    (state) => { const old = state.work.find((w) => w.externalKey === "OLD-CYCLE"); old.parentId = old.id; return createWorkDelta(input(fx.projectId, "AFTER-CYCLE"))(state); },
  ], { occurredAt: AT }), { seed: (fx) => appendHistoricalWorkCreate(fx.root, { projectId: fx.projectId, externalKey: "OLD-CYCLE", kind: "Incident", occurredAt: AT }) });
  assert.equal(fast.ok, false); assert.equal(fast.error.reasonCode, "GRAPH_CYCLE"); assert.equal(fast.error.memberIndex, 1); assert.equal(fast.metrics.writeCreateClosureValidation, 0);
});

test("INIT080 post-fold budget refusal remains atomic after terminal validation", async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, [input(fx.projectId, "BUDGET-A"), input(fx.projectId, "BUDGET-B")], { viewBudgetBytes: 1 }));
  assert.equal(fast.ok, false); assert.equal(fast.error.memberIndex, undefined); assert.equal(fast.metrics.writeCreateTerminalValidation, 1);
});

for (const variant of ["accessor-index", "proxy-array", "custom-entries", "hole", "custom-prototype"]) test(`INIT080 builder container ${variant} does not gain eligibility observations`, async (t) => {
  const { fast } = await pair(t, (fx) => {
    const first = wrap(createWorkDelta(input(fx.projectId, "ARRAY-A")), fx.legacy);
    const second = wrap(createWorkDelta(input(fx.projectId, "ARRAY-B")), fx.legacy);
    let builders = [first, second];
    if (variant === "accessor-index") Object.defineProperty(builders, "1", { enumerable: true, get() { fx.trace.push("index:1"); return second; } });
    if (variant === "proxy-array") builders = new Proxy(builders, { get(target, key, receiver) { fx.trace.push(`array-get:${String(key)}`); return Reflect.get(target, key, receiver); }, ownKeys(target) { fx.trace.push("array-ownKeys"); return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { fx.trace.push(`array-descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); } });
    if (variant === "custom-entries") builders.entries = function* () { fx.trace.push("custom entries"); yield [0, first]; yield [1, second]; };
    if (variant === "hole") delete builders[1];
    if (variant === "custom-prototype") Object.setPrototypeOf(builders, Object.create(Array.prototype));
    return appendEvents(fx.root, builders, { occurredAt: AT });
  });
  assert.equal(fast.ok, variant !== "hole"); assert.equal(fast.metrics.writeCreateClosureValidation, 0); assert.equal(fast.metrics.writeCreateTerminalValidation, 0);
  if (variant === "hole") { assert.equal(fast.error.memberIndex, 1); assert.equal(fast.error.memberPhase, "delta"); }
});

test("INIT080 builder-array changes during setup are read on the actual attempt", async (t) => {
  const { fast } = await pair(t, async (fx) => {
    const builders = [wrap(createWorkDelta(input(fx.projectId, "ARRAY-FIRST")), fx.legacy), wrap(createWorkDelta(input(fx.projectId, "ARRAY-OLD")), fx.legacy)];
    const pending = appendEvents(fx.root, builders, { occurredAt: AT });
    builders[1] = wrap(createWorkDelta(input(fx.projectId, "ARRAY-LATEST")), fx.legacy);
    const state = await pending;
    assert.equal(state.work.some((w) => w.externalKey === "ARRAY-OLD"), false); assert.equal(state.work.some((w) => w.externalKey === "ARRAY-LATEST"), true); return state;
  });
  assert.equal(fast.ok, true); fastCounts(fast.metrics, 2);
});

test("INIT080 admitted template with wrong kind preserves template admission precedence", async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, [input(fx.projectId, "TEMPLATE-OK"), input(fx.projectId, "TEMPLATE-BAD", { templateAdmission: fx.state.templates[0].receipt })]), {
    seed: (fx) => admitTemplateInWorkspace(fx.root, { template: defaultWorkContentTemplate("Story"), ownerId: "owner:fixture", occurredAt: AT }),
  });
  assert.equal(fast.ok, false); assert.equal(fast.error.reasonCode, "TEMPLATE_NOT_APPLICABLE"); assert.equal(fast.error.memberIndex, 1);
});

test("INIT080 done-parent write admission still precedes graph optimization", async (t) => {
  const { fast } = await pair(t, (fx) => append(fx, [input(fx.projectId, "DONE-OK"), input(fx.projectId, "DONE-CHILD", { kind: "Epic", parentId: workId("DONE-PARENT") })]), {
    seed: (fx) => appendHistoricalWorkCreate(fx.root, { projectId: fx.projectId, externalKey: "DONE-PARENT", kind: "Initiative", status: "done", occurredAt: AT }),
  });
  assert.equal(fast.ok, false); assert.equal(fast.error.reasonCode, "WORKSPACE_INPUT_INVALID"); assert.equal(fast.error.memberIndex, 1);
});

test("INIT080 throwing input getter is neither pre-read nor blamed on a later member", async (t) => {
  const { fast } = await pair(t, (fx) => {
    const bad = input(fx.projectId, "GETTER-BAD");
    Object.defineProperty(bad, "title", { enumerable: true, get() { fx.trace.push("throwing title"); throw new Error("fixture getter refusal"); } });
    return append(fx, [input(fx.projectId, "GETTER-OK"), bad, input(fx.projectId, "LATER", { kind: "Incident" })]);
  });
  assert.equal(fast.ok, false); assert.equal(fast.error.memberIndex, 1); assert.equal(fast.error.message, "fixture getter refusal"); assert.deepEqual(fast.trace, ["throwing title"]); assert.equal(fast.metrics.writeCreateClosureValidation, 0);
});


// Each modified-intrinsic fixture is a separate process. The parent runner and other
// tests never observe the patch; the child restores every descriptor before replay.
async function isolatedCorrection(mode) {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const guard = fileURLToPath(new URL("../scripts/no-network.mjs", import.meta.url));
  const script = `(${correctiveProbe.toString()})(${JSON.stringify({ repo, mode })}).then((result) => process.stdout.write(JSON.stringify(result)));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=2048", "--import", guard, "--input-type=module", "-e", script], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: process.env });
  return JSON.parse(stdout);
}

for (const mode of ["lock-alias", "deferred-alias", "shared-alias", "lock-wait"]) test(`INIT080 retained typed aliases preserve stream refusal: ${mode}`, async () => {
  const result = await isolatedCorrection(mode);
  assert.equal(result.outcome.ok, false);
  assert.deepEqual(result.outcome.error, { name: "AkashaError", reasonCode: "AKASHA_INPUT_INVALID", message: "event at sequence 3 does not continue the stream (payloadHash)" });
  assert.equal(result.atomicBytesUnchanged, true);
  assert.deepEqual(result.replay.work, []);
  fastCounts(result.metrics, 2);
  assert.equal(result.metrics.writeCreateClosureRecordsVisited, 1);
  if (mode === "lock-wait") { assert.equal(result.hookCalls, 0); assert.equal(result.wasPendingAtMutation, true); assert.equal(result.preparationObservation, "live-terminal-counter"); }
  else assert.equal(result.hookCalls, 1);
});

for (const mode of ["string-intrinsic", "regexp", "reflection", "iterator", "map", "weakset", "json", "number", "date", "buffer", "hash", "freeze", "store", "boolean", "string-owner"]) test(`INIT080 relevant intrinsic ${mode} retains original calls through fallback`, async () => {
  const result = await isolatedCorrection(mode);
  assert.equal(result.outcome.ok, true);
  assert.deepEqual(result.outcome.work, result.replay.work);
  assert.deepEqual(result.outcome.events, result.replay.events);
  assert.ok(result.callbacks > 0, "the representative patched operation was actually reached");
  legacyCounts(result.metrics, 2);
  if (mode === "string-intrinsic") {
    assert.equal(result.callbacks, 4, "the unchanged995 exact probe calls toUpperCase four times for PROBE-A");
    assert.equal(result.replay.work.find((record) => record.externalKey === "PROBE-B").title, "mutated during first member");
  }
});


for (const mode of ["length", "length-batch", "buffer", "byteOffset", "shadow", "reparent"]) test(`INIT080 inherited Buffer ${mode} preserves source-backed fallback`, async () => {
  const result = await isolatedCorrection(`inherited-buffer-${mode}`);
  if (mode === "buffer" || mode === "byteOffset") {
    // WORK_SUMMARY_MAX_BYTES is Buffer.constants.MAX_LENGTH, not a small summary
    // budget. Do not allocate billions of bytes to reach subarray. These descriptor
    // changes prove conservative fallback without invoking either getter in the guard;
    // length/shadow/reparent below exercise the actual reducer callback and refusal.
    assert.equal(result.outcome.ok, true);
    assert.equal(result.callbacks, 0);
    assert.deepEqual(result.outcome.work, result.replay.work);
    assert.deepEqual(result.outcome.events, result.replay.events);
    legacyCounts(result.metrics, 2);
    return;
  }
  assert.equal(result.outcome.ok, false);
  assert.ok(result.callbacks > 0, "the source-backed inherited dispatch actually ran");
  if (mode === "length-batch") {
    assert.equal(result.outcome.error.reasonCode, "WORK_BATCH_REFUSED");
    const refusal = JSON.parse(result.outcome.error.message);
    assert.equal(refusal.stage, "apply");
    assert.equal(refusal.failed.index, 1);
    assert.equal(refusal.failed.phase, "delta");
    assert.equal(refusal.failed.reasonCode, "CANONICAL_VALUE_INVALID");
    assert.deepEqual(refusal.notEvaluated, [2]);
  } else {
    assert.deepEqual(result.outcome.error, { name: "ProtocolError", reasonCode: "CANONICAL_VALUE_INVALID", message: "Only plain JSON objects, arrays, strings, booleans, null, and safe integers are supported", memberIndex: 1, memberPhase: "delta" });
  }
  if (["length", "length-batch", "shadow", "reparent"].includes(mode)) assert.equal(result.callbacks, 1, "qualification must not invoke the inherited getter");
  assert.equal(result.atomicBytesUnchanged, true);
  assert.deepEqual(result.replay.work, []);
  assert.equal(result.metrics.writeCreateFullValidation, 2);
  assert.equal(result.metrics.writeCreateClosureValidation, 0);
  assert.equal(result.metrics.writeCreateTerminalValidation, 0);
});
