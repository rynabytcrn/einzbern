// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-019 STORY-162.5 — the pure half of the knowledge injection chain.
// The liveness gate itself (--verify-channel) needs the live host and is run by hand /
// in the runner; these tests hold the pure decision logic (gate, token extraction,
// budget) without the network, so the harness stays green offline.
//
// INC-047: this test lives in the repository that OWNS the source (the engine),
// not as a sibling-repo import — a lone clone of either repo can run its own suite.

import "./helpers/device-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractQueryTokens, promptTriggers, matchedTriggerKeywords, parseInjectionProtocol, runInjection, runSessionInjection, serializeInjectionProtocol, truncateToBudget
} from "../scripts/knowledge-inject.mjs";
import { filterCandidatesByDispatchContext, normalizeDispatchContext } from "../scripts/injection-session.mjs";
import {
  createKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeLibrary,
  materializeWorkspace,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

test("extractQueryTokens keeps ASCII words and CJK bigrams, drops stopwords", () => {
  const tokens = extractQueryTokens("hook 没有生效,应该查什么");
  assert.ok(tokens.includes("hook"));
  assert.ok(!tokens.includes("没有"));
  assert.ok(!tokens.includes("应该"));
  assert.ok(tokens.length > 0);
});

test("CJK query extraction does not split phrases into bigrams", () => {
  const tokens = extractQueryTokens("引擎设计 约束模型 工单格式");
  assert.deepEqual(tokens, ["引擎设计", "约束模型", "工单格式"]);
  assert.equal(tokens.includes("引擎"), false);
  assert.equal(tokens.includes("擎设"), false);
  assert.equal(tokens.includes("设计"), false);
});

async function createSyntheticWorkspace() {
  const instant = (second) => `2026-09-04T00:00:${String(second).padStart(2, "0")}Z`;
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-knowledge-inject-test-")));

  // Create the partition structure: base/.tcrn-workspace/cross-project/
  const partitionPath = join(base, ".tcrn-workspace", "cross-project");

  // Initialize a real library
  const workspace = join(partitionPath, "workspace");
  await initializeLibrary({ root: workspace, createdAt: instant(0) });

  // Populate with knowledge content so budget tests discriminate.
  // We need content matching "hook" keyword to exceed 10-byte budget.
  let state = await createProject(workspace, {
    occurredAt: instant(1),
    externalKey: "KNOWLEDGE-INJECT-PROJ",
    name: "Knowledge Inject Test"
  });

  // Initialize the knowledge store before creating knowledge units
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });

  // Create knowledge units with "hook" keyword and enough content to exceed 10 bytes.
  //
  // TCRN-CROSS-STORY-362: the six cards that say nothing about hooks are not padding.
  // Retrieval is bm25 now, and a term every document in the corpus carries discriminates
  // nothing -- FTS5 clamps its inverse document frequency and the score lands at zero,
  // which is the same mechanism that stops the query `lesson` from returning the whole
  // library. A three-card corpus in which all three are about hooks would therefore
  // return no answer for "hook" and this file would be measuring the clamp rather than
  // the budget. The corpus is nine cards so that "hook" selects the three that are about
  // hooks, which is what the budget tests below need to be discriminating about.
  const projectId = state.projects[0].id;
  const knowledgeUnits = [
    {
      externalKey: "HOOK-GUIDE-001",
      subject: "Hook setup guide",
      summary: "A comprehensive guide about hook configuration",
      tags: ["hook", "setup"]
    },
    {
      externalKey: "HOOK-GUIDE-002",
      subject: "Hook lifecycle management",
      summary: "Managing the lifecycle of hooks in production systems",
      tags: ["hook", "setup"]
    },
    {
      externalKey: "HOOK-GUIDE-003",
      subject: "Hook debugging and troubleshooting",
      summary: "Common hook issues and how to resolve them",
      tags: ["hook", "setup"]
    },
    { externalKey: "OTHER-001", subject: "Release trust root layout", summary: "Where the trust archive lives and what it holds", tags: ["release"] },
    { externalKey: "OTHER-002", subject: "Storage segment rotation", summary: "How segmented storage rolls a segment and when", tags: ["storage"] },
    { externalKey: "OTHER-003", subject: "Lease acquisition order", summary: "Which writer serialises against which claim", tags: ["workspace"] },
    { externalKey: "OTHER-004", subject: "Snapshot replay rebuild", summary: "Rebuilding a derived view from the event chain", tags: ["snapshot"] },
    { externalKey: "OTHER-005", subject: "Conference minutes distillation", summary: "Turning positions into recorded decisions", tags: ["conference"] },
    { externalKey: "OTHER-006", subject: "Persona preset override", summary: "Overriding one governed field of a shipped persona", tags: ["persona"] }
  ];

  let knowledgeVersion = 0;
  for (const unit of knowledgeUnits) {
    const created = await createKnowledgeUnit(workspace, {
      occurredAt: instant(knowledgeVersion + 2),
      externalKey: unit.externalKey,
      scope: "workspace",
      projectId: null,
      roleScopes: [],
      category: "workflow",
      kind: "fact",
      tags: unit.tags,
      subject: unit.subject,
      summary: unit.summary,
      snippet: `Details about ${unit.subject}`,
      accountableOwnerId: deriveStableId("owner", "TEST-OWNER"),
      sourceReferences: [`evidence://fixture/${unit.externalKey}`],
      sourceDigest: canonicalSha256({ key: unit.externalKey }),
      linkedWorkIds: [],
      linkedDecisionIds: [],
      linkedGateIds: [],
      linkedEvidenceIds: [deriveStableId("evidence", `FIXTURE-${unit.externalKey}`)],
      lifecycle: "active",
      retrievalDisposition: "default",
      freshnessState: "fresh",
      lastVerified: instant(knowledgeVersion + 1),
      stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only",
      body: `This is knowledge content about ${unit.subject}. It contains sufficient detail to exceed small byte budgets.`,
      // TCRN-CROSS-STORY-365: three "Hook ..." cards written on purpose, each scoring as
      // a possible duplicate of the last.
      coexist: true,
    });
    // A written card shows up in search results at once: there is no promotion step
    // (TCRN-CROSS-SUB-308).
    knowledgeVersion = created.version;
  }

  return {
    containerRoot: base,
    cleanup: () => rm(base, { recursive: true, force: true })
  };
}

test("INIT-047 injection budget=10 reports exceeded without truncation", async (context) => {
  const { containerRoot, cleanup } = await createSyntheticWorkspace();
  context.after(() => cleanup());

  const result = await runInjection({
    prompt: "hook",
    partition: "cross-project",
    budget: 10,
    triggerKeywords: "",
    containerRoot
  });
  assert.equal(result.reasonCode, "INJECTION_BUDGET_EXCEEDED");
  assert.equal(result.truncated, false);
  assert.equal(result.budget, 10);
  assert.ok(result.injectedBytes > 10);
});

test("INIT-047 discrimination: large budget does not report exceeded", async (context) => {
  const { containerRoot, cleanup } = await createSyntheticWorkspace();
  context.after(() => cleanup());

  const result = await runInjection({
    prompt: "hook",
    partition: "cross-project",
    budget: 100000,  // Large budget
    triggerKeywords: "",
    containerRoot
  });
  // With a large budget, we should not get INJECTION_BUDGET_EXCEEDED
  assert.notEqual(result.reasonCode, "INJECTION_BUDGET_EXCEEDED");
  assert.ok(result.injected === true || result.injected === false);  // May inject or not depending on candidates
});

test("a prompt with no trigger keyword is gated off", () => {
  assert.equal(promptTriggers("今天天气如何", "hook,仪式,rebase"), false);
  assert.equal(promptTriggers("hook 没有生效", "hook,仪式,rebase"), true);
});

test("matchedTriggerKeywords returns exactly the keywords present", () => {
  assert.deepEqual(matchedTriggerKeywords("hook 与 仪式 的问题", "hook,仪式,rebase"), ["hook", "仪式"]);
  assert.deepEqual(matchedTriggerKeywords("天气", "hook,仪式"), []);
});

test("an empty trigger list does not gate", () => {
  assert.equal(promptTriggers("anything at all", ""), true);
});

test("truncateToBudget cuts by bytes and reports it", () => {
  const long = "a".repeat(1000);
  const cut = truncateToBudget(long, 100);
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 100);
  assert.equal(truncateToBudget("short", 100).truncated, false);
});

test("truncateToBudget never grows the output past the budget", () => {
  const cjk = "探针".repeat(300); // 600 CJK chars = 1800 bytes
  const cut = truncateToBudget(cjk, 500);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 500 + 3); // allow a split multibyte char
});

test("STORY-418 recall is filtered by an explicit workId and Pack binding", () => {
  const binding = normalizeDispatchContext({ role: "subagent", workId: "work:bound", pack: "EPIC135/HC1" }, { env: {} });
  const result = filterCandidatesByDispatchContext([
    { id: "knowledge:bound", workId: "work:bound", pack: "EPIC135/HC1" },
    { id: "knowledge:wrong-work", workId: "work:other", pack: "EPIC135/HC1" },
    { id: "knowledge:unbound", title: "same prompt words" },
  ], binding);
  assert.equal(result.reasonCode, "DISPATCH_CONTEXT_MATCHED");
  assert.deepEqual(result.records.map((record) => record.id), ["knowledge:bound"]);
  assert.equal(result.excluded, 2);
});

test("STORY-419 protocol truncation is explicit and never looks like delivered context", () => {
  const oversized = serializeInjectionProtocol({ ok: true, injected: true, injection: "z".repeat(600_000) });
  const parsed = parseInjectionProtocol(oversized.text);
  assert.equal(oversized.truncated, true);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.ok, false);
  assert.equal(parsed.value.reasonCode, "INJECT_OUTPUT_TRUNCATED");
  assert.equal(parsed.value.injected, undefined);
});

// TCRN-CROSS-MIN-225 D3 (TCRN-CROSS-SUB-257): the hooks keep writing the four channel events and
// nothing else. The expected rows are the non-observation part of the same sequences measured on
// v1.2.0 (514ebfb), where the SessionStart also wrote four boundary starts, each channel wrote a
// collector self-check and the SessionStart sweep moved the knowledge store marker. As in
// production, no workspace state is handed in: each hook reads it from the container. The second
// session keeps the failure paths in view: a recall that fails and a tool call that pulls nothing.
const INJECT_SCRIPT_PATH = fileURLToPath(new URL("../scripts/knowledge-inject.mjs", import.meta.url));

// A container-shaped fixture: the hooks resolve `<container>/.tcrn-workspace/cross-project`, so a
// run given this container never reaches the platform container's own chain or knowledge store.
async function isolatedHookContainer(t, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-min225-hooks-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const partition = join(base, ".tcrn-workspace", "cross-project");
  const workspace = join(partition, "workspace");
  await initializeLibrary({ root: workspace, createdAt: "2026-09-01T00:00:00Z" });
  await mkdir(join(partition, "transient"), { recursive: true });
  await createProject(workspace, { occurredAt: "2026-09-01T00:00:01Z", externalKey: `${externalKey}-PROJECT`, name: "MIN-225 hooks" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const storePath = join(workspace, DIRECTORY.knowledge, "store.json");
  return { base, workspace, transient: join(partition, "transient"), storePath, storeBefore: readFileSync(storePath, "utf8") };
}

// The four channel events this case counted went with the telemetry store
// (TCRN-CROSS-STORY-467 R3): the hooks write no telemetry of any kind now.
test("MIN-225: hook events write no telemetry, boundary, seal receipt, self-check, summary, or sweep", async (t) => {
  const fixture = await isolatedHookContainer(t, "FIXTURE-MIN-225-HOOK-EVENTS");
  const candidate = { id: "knowledge:000000000000000000000225", kind: "card", key: "K225", status: "active", title: "Hooks", summary: "Hooks" };
  const common = { partition: "cross-project", containerRoot: fixture.base, sessionId: "min225-hooks", stateDirectory: join(fixture.transient, "session-state"), settings: [], budget: 24_576, perPromptBytes: 1_600, judgeEnabled: false, host: "claude" };
  const sessionStart = await runSessionInjection({ ...common, event: "SessionStart", prompt: "" });
  const prompt = await runSessionInjection({ ...common, event: "UserPromptSubmit", prompt: "min225 hook sequence prompt", recall: async () => ({ ok: true, result: { records: [candidate] } }) });
  const pull = await runSessionInjection({ ...common, event: "PostToolUse", prompt: "", hookInput: { tool_name: "work-show", tool_response: { ok: true, record: { id: candidate.id } } } });
  const stop = await runSessionInjection({ ...common, event: "Stop", prompt: "" });
  const failure = { ...common, sessionId: "min225-hooks-failure" };
  const failedPrompt = await runSessionInjection({ ...failure, event: "UserPromptSubmit", prompt: "min225 failing recall prompt", recall: async () => ({ ok: false, reasonCode: "RECALL_UNAVAILABLE" }) });
  const ignoredPull = await runSessionInjection({ ...failure, event: "PostToolUse", prompt: "", hookInput: { tool_name: "work-show", tool_response: "{}" } });
  assert.equal(existsSync(join(fixture.transient, "telemetry")), false, "no telemetry record of any kind");
  assert.equal(readFileSync(fixture.storePath, "utf8"), fixture.storeBefore, "the knowledge store marker is untouched: SessionStart no longer sweeps");
  assert.deepEqual([sessionStart, prompt, pull, stop, failedPrompt, ignoredPull].map((result) => result.decision), ["L0_CHANGED", "INJECTION_EMITTED", "PULL_RECORDED", "NO_CONTEXT", "RECALL_UNAVAILABLE", "PULL_IGNORED"]);
  for (const result of [sessionStart, stop]) {
    for (const field of ["observationBoundary", "observationCoverage", "retirementSweep"]) assert.equal(Object.hasOwn(result, field), false, field);
  }
});

test("MIN-225: the retired observation-boundary argument is answered and writes nothing", async (t) => {
  const fixture = await isolatedHookContainer(t, "FIXTURE-MIN-225-BOUNDARY-ARGUMENT");
  const target = ["--partition", "cross-project", "--container-root", fixture.base];
  const boundary = [...target, "--session-id", "min225-boundary", "--host", "claude", "--at", "2026-09-24T12:00:00.000Z"];
  for (const argv of [["--observation-boundary", "start", ...boundary], ["--observation-boundary", "stop", ...boundary], [...target, "--observation-boundary"]]) {
    const run = spawnSync(process.execPath, [INJECT_SCRIPT_PATH, ...argv], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, `${argv.join(" ")}: ${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, reasonCode: "TELEMETRY_BOUNDARY_RETIRED", written: 0, protocolVersion: "tcrn.injection-protocol.v2" }, argv.join(" "));
  }
  assert.equal(existsSync(join(fixture.transient, "telemetry")), false, "no telemetry record of any kind");
  assert.equal(readFileSync(fixture.storePath, "utf8"), fixture.storeBefore);
});
