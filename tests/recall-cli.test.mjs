// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-474 AC1, AC2 at the CLI (TCRN-CROSS-SUB-304): the recall verb answers a prompt
// about nothing the library holds with nothing -- RECALL_NO_STRONG_HIT, no records, no context --
// and answers a prompt about a done Story with one line that carries its title, key, id, status and
// the titles of its Epic and Initiative. The unrelated prompts are the group the strong-hit
// threshold was calibrated on (tests/fixtures/retrieval-eval/negative-queries.json).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { HOST_HOOK_EVENTS } from "../dist/build/packages/core/src/host-hooks.js";
import {
  captureKnowledgeUnit,
  createProject,
  createWork,
  deleteProject,
  initializeKnowledgeStore,
  initializeLibrary,
  recordMinutes,
  setWorkspaceSetting,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { RECALL_STRONG_TAU, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-09-26T14:00:${String(second).padStart(2, "0")}Z`;
const idOf = (key) => deriveStableId("work", key);

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-recall-cli-")));
  context.after(() => { rm(base, { recursive: true, force: true }); resetRecallCache(); });
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "RC-PROJECT", name: "Recall CLI" })).projects[0].id;
  await createWork(workspace, { occurredAt: at(2), projectId, externalKey: "RC-INIT-1", kind: "Initiative", parentId: null, title: "检索只在强命中时提醒", goal: "让与库无关的提问得到空答案。" });
  await createWork(workspace, { occurredAt: at(3), projectId, externalKey: "RC-EPIC-1", kind: "Epic", parentId: idOf("RC-INIT-1"), title: "命中行与父链", goal: "每条命中是一行，带上级标题。" });
  await createWork(workspace, {
    occurredAt: at(4), projectId, externalKey: "RC-STORY-1", kind: "Story", parentId: idOf("RC-EPIC-1"), status: "active",
    title: "召回命中行显示史诗与倡议标题", goal: "命中行显示状态、键、编号与父链标题。",
    acceptance: "GIVEN 一条已完成的 Story WHEN 召回命中它 THEN 命中行含标题、编号、状态与父链", body: "今天起，命中行由统一的格式化函数产出。",
  });
  await transitionWork(workspace, { occurredAt: at(5), id: idOf("RC-STORY-1"), status: "done" });
  await createWork(workspace, {
    occurredAt: at(6), projectId, externalKey: "RC-STORY-2", kind: "Story", parentId: idOf("RC-EPIC-1"),
    title: "无关提问返回空答案", goal: "最高分低于阈值时不给答案。",
    acceptance: "GIVEN 一条与库无关的提问 WHEN 召回 THEN 答案为空", body: "推荐先跑检索评测再调阈值。",
  });
  await recordMinutes(workspace, {
    occurredAt: at(7), externalKey: "RC-MIN-1", projectId, title: "阈值校准纪要", summary: "阈值按无关查询组校准，写进夹具。",
    decisions: ["阈值取无关组最高分之上的最小步长。"], decidedBy: [], linkedWorkIds: [],
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  await captureKnowledgeUnit(workspace, {
    occurredAt: at(8), subject: "强命中阈值按库的规模校准", summary: "小库需要调低检索阈值", snippet: "库越小分数越低",
    tags: ["recall"], accountableOwnerId: deriveStableId("owner", "RC-OWNER"), body: "强命中阈值按库的规模校准。", externalKey: "RC-CARD-1",
  });
  return workspace;
}

async function recallOutput(workspace, query, extra = []) {
  let output = "";
  await runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", query, "--allow-trailing", "true", ...extra], { write(value) { output = value; } });
  return output;
}

async function recallCli(workspace, query, extra = []) {
  return JSON.parse(await recallOutput(workspace, query, extra));
}

test("STORY-474 AC1 (CLI): the unrelated group is answered with nothing, and at threshold 0 it is not", async (context) => {
  const workspace = await library(context);
  const negatives = JSON.parse(await readFile(new URL("./fixtures/retrieval-eval/negative-queries.json", import.meta.url), "utf8")).queries;
  assert.ok(negatives.length >= 10);
  for (const { query } of negatives) {
    const answer = await recallCli(workspace, query);
    assert.equal(answer.reasonCode, "RECALL_NO_STRONG_HIT", query);
    assert.deepEqual(answer.records, [], query);
    assert.deepEqual(answer.context, [], query);
    assert.equal(answer.tau, RECALL_STRONG_TAU.toFixed(4));
  }
  const answeredAtZero = [];
  for (const { query } of negatives) {
    if ((await recallCli(workspace, query, ["--tau", "0"])).records.length > 0) answeredAtZero.push(query);
  }
  assert.ok(answeredAtZero.length > 0, "the emptiness hangs on the threshold, not on a library that shares no word with the prompts");
});

test("STORY-474 AC2, R2 (CLI): a done Story is answered with one line carrying its title, key, id, status and parents", async (context) => {
  const workspace = await library(context);
  const answer = await recallCli(workspace, "召回命中行怎么显示史诗与倡议标题");
  assert.equal(answer.reasonCode, "RECALL_READY");
  const hit = answer.records.find((record) => record.id === idOf("RC-STORY-1"));
  assert.ok(hit, "the done Story is a strong hit at the shipped threshold");
  assert.deepEqual(hit.parentChain, ["命中行与父链", "检索只在强命中时提醒"], "nearest first: the Epic, then the Initiative");
  for (const part of ["召回命中行显示史诗与倡议标题", "RC-STORY-1", idOf("RC-STORY-1"), "done", "命中行与父链", "检索只在强命中时提醒"]) {
    assert.ok(hit.line.includes(part), `${part} in ${hit.line}`);
  }
  assert.equal(hit.line, `[Story done] 召回命中行显示史诗与倡议标题 · RC-STORY-1 · ${idOf("RC-STORY-1")} · 命中行与父链 ‹ 检索只在强命中时提醒`);
  assert.equal(answer.context[0], answer.records[0].line, "the context is the answer's lines, in rank order");
  assert.ok(answer.context.every((line) => !line.includes("\n")));
  // A key fragment names the record as its key does.
  const named = await recallCli(workspace, "RC-STORY-1 现在是什么状态");
  assert.equal(named.records[0]?.id, idOf("RC-STORY-1"));
});

test("STORY-474 R2 (CLI): the context is cut to injection.perPromptBytes at whole lines", async (context) => {
  const workspace = await library(context);
  const query = "命中行 阈值 召回 父链";
  const full = await recallCli(workspace, query, ["--tau", "0"]);
  assert.equal(full.perPromptBytes, 1600, "the setting's default");
  assert.ok(full.context.length >= 2);
  const firstLineBytes = Buffer.byteLength(full.context[0], "utf8");
  await setWorkspaceSetting(workspace, { occurredAt: at(40), key: "injection.perPromptBytes", value: String(firstLineBytes) });
  resetRecallCache();
  const cut = await recallCli(workspace, query, ["--tau", "0"]);
  assert.equal(cut.perPromptBytes, firstLineBytes);
  assert.deepEqual(cut.context, [full.context[0]], "the first line that does not fit ends the answer");
  assert.equal(cut.records.length, full.records.length, "records are not cut; only the context is");
});

test("agent recall keeps the full context and identifies degraded knowledge without diagnostic arrays", async (context) => {
  const workspace = await library(context);
  const state = await createProject(workspace, { occurredAt: at(9), externalKey: "RC-ORPHAN", name: "Orphaned knowledge" });
  const projectId = state.projects.find(({ externalKey }) => externalKey === "RC-ORPHAN").id;
  const card = await captureKnowledgeUnit(workspace, {
    occurredAt: at(10), scope: "project", projectId, externalKey: "RC-ORPHAN-CARD",
    subject: "Orphaned lighthouse calibration", summary: "Former project calibration", snippet: "Kept for the diagnostic",
    tags: ["recall"], accountableOwnerId: deriveStableId("owner", "RC-OWNER"), body: "Lighthouse calibration.",
  });
  await deleteProject(workspace, { occurredAt: at(11), id: projectId });

  const query = "召回命中行怎么显示史诗与倡议标题";
  const full = await recallCli(workspace, query);
  const raw = await recallOutput(workspace, query, ["--view", "agent"]);
  const agent = JSON.parse(raw);
  assert.equal(full.schemaVersion, "tcrn.recall.v1");
  assert.deepEqual(Object.keys(full).sort(), [
    "at", "context", "headEventHash", "indexed", "knowledgeReasonCode", "knowledgeStores", "limit", "perPromptBytes",
    "projectCrestDegraded", "query", "queryLanguage", "queryTokens", "queryTranslation", "reasonCode", "rebuilt", "records",
    "relativeFloor", "schemaVersion", "scopeExcerptBytes", "tau", "telemetry", "total", "version", "workspaceId",
  ].sort(), "the machine envelope keeps its established fields");
  assert.equal(full.projectCrestDegraded.unresolvedScopes[0].id, card.id);
  assert.equal(agent.schemaVersion, "tcrn.recall-agent.v1");
  assert.equal(agent.delivery, "complete");
  assert.ok(agent.context.length > 0);
  for (const name of ["context", "reasonCode", "workspaceId", "version", "headEventHash", "perPromptBytes", "knowledgeReasonCode", "knowledgeStores"]) {
    assert.deepEqual(agent[name], full[name], name);
  }
  assert.deepEqual(agent.projectCrestDegraded, {
    reasonCode: "KNOWLEDGE_LINK_INVALID",
    withheldCards: 1,
    conflictPairs: 0,
    duplicateIds: 0,
    unresolvedScopes: 1,
    awaitingChain: 0,
  });
  assert.equal(Object.hasOwn(agent, "records"), false);
  assert.ok(!raw.includes(card.id), "the compact result contains counts only");
  const { knowledgeReasonCode, knowledgeStores, projectCrestDegraded } = full;
  assert.equal(agent.diagnostics.knowledgeSha256, canonicalSha256({ knowledgeReasonCode, knowledgeStores, projectCrestDegraded }));
  assert.match(agent.diagnostics.projectSnapshotDigest, /^[a-f0-9]{64}$/u);
  assert.equal(agent.diagnostics.schemaVersion, full.schemaVersion);
  assert.ok(Buffer.byteLength(raw, "utf8") <= 32768);
  assert.ok(raw.endsWith("\n"));

  await assert.rejects(recallCli(workspace, query, ["--view", "unknown"]), {
    reasonCode: "CLI_ARGUMENT_MALFORMED",
    message: "view",
  });
});

test("agent recall reports an oversized delivery without trimming the machine context", async (context) => {
  const workspace = await library(context);
  const projectId = deriveStableId("project", "RC-PROJECT");
  const query = "Obsidian beacon";
  const title = `${query} ${'界"\\'.repeat(4800)}`;
  await createWork(workspace, {
    occurredAt: at(40), projectId, externalKey: "RC-LARGE-CONTEXT", kind: "Initiative", parentId: null, title,
  });
  await setWorkspaceSetting(workspace, { occurredAt: at(41), key: "injection.perPromptBytes", value: "64000" });
  const args = ["--limit", "1", "--tau", "0"];
  const full = await recallCli(workspace, query, args);
  const raw = await recallOutput(workspace, query, [...args, "--view", "agent"]);
  const agent = JSON.parse(raw);
  assert.equal(agent.delivery, "over-budget");
  assert.equal(agent.reasonCode, full.reasonCode);
  assert.equal(agent.perPromptBytes, full.perPromptBytes);
  assert.equal(agent.headEventHash, full.headEventHash);
  assert.equal(agent.outputLimitBytes, 32768);
  assert.equal(Object.hasOwn(agent, "context"), false, "no partial context is delivered");
  assert.equal(full.context.length, 1);
  assert.ok(full.context[0].includes(title), "the machine view retains the full matching line");
  assert.ok(Buffer.byteLength(full.context[0], "utf8") < 32768, "the unescaped line alone would fit");
  const { requiredBytes, ...summary } = agent;
  const complete = canonicalJson({ ...summary, delivery: "complete", context: full.context });
  assert.equal(requiredBytes, Buffer.byteLength(complete, "utf8"), "counts UTF-8, escaping, the envelope and its final newline");
  assert.ok(requiredBytes > 32768);
  assert.ok(Buffer.byteLength(raw, "utf8") <= 32768);
});

test("STORY-474 (CLI): recall no longer takes --partition", async (context) => {
  const workspace = await library(context);
  await assert.rejects(
    () => recallCli(workspace, "召回", ["--partition", "cross-project"]),
    (error) => error?.reasonCode === "CLI_ARGUMENT_UNKNOWN",
  );
  const answer = await recallCli(workspace, "召回命中行怎么显示史诗与倡议标题");
  assert.equal(Object.hasOwn(answer, "partition"), false);
});

test("STORY-474 R4: the engine has no session-level injection entry; recall is asked per prompt or subagent start", () => {
  assert.deepEqual(Object.keys(HOST_HOOK_EVENTS), ["UserPromptSubmit", "SubagentStart", "PreToolUse"], "no SessionStart or PostToolUse hook is rendered");
  assert.deepEqual(COMMAND_CATALOG.filter((entry) => /inject|session/u.test(entry.name)).map((entry) => entry.name), [],
    "no verb injects context into a session or keeps a session byte ledger");
});

// MIN-235 D9 (TCRN-CROSS-SUB-302) through the verb, with no threshold passed and none recorded: the
// small library the R13 acceptance probe built -- one Initiative, one Epic and two Stories written
// with the goal and body fields -- where a Story's goal words, body words and title were answered
// with nothing at the old default, and prompts that share at most one word with it.
async function smallLibrary(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-recall-cli-small-")));
  context.after(() => { rm(base, { recursive: true, force: true }); resetRecallCache(); });
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "D9-PROJECT", name: "d9" })).projects[0].id;
  await createWork(workspace, { occurredAt: at(2), projectId, externalKey: "D9-INIT-1", kind: "Initiative", parentId: null, title: "Field notebook platform" });
  await createWork(workspace, { occurredAt: at(3), projectId, externalKey: "D9-EPIC-1", kind: "Epic", parentId: idOf("D9-INIT-1"), title: "Survey capture" });
  await createWork(workspace, {
    occurredAt: at(4), projectId, externalKey: "D9-STORY-1", kind: "Story", parentId: idOf("D9-EPIC-1"), title: "Offline tally sheet",
    goal: "Rangers record the pangolin sighting tally while the tablet has no signal",
    acceptance: "GIVEN no signal WHEN a ranger saves a tally THEN it syncs later",
    body: "The quokka moult calendar decides which transect is walked first each morning.",
  });
  await createWork(workspace, {
    occurredAt: at(5), projectId, externalKey: "D9-STORY-2", kind: "Story", parentId: idOf("D9-EPIC-1"), title: "Photo attachment",
    goal: "Attach a photo of each nest to its survey entry",
    acceptance: "GIVEN a nest entry WHEN a photo is attached THEN it shows in the entry",
  });
  return workspace;
}

test("D9 (CLI): at the default threshold a small library answers a Story's goal words, body words and title, and nothing else", async (context) => {
  const workspace = await smallLibrary(context);
  const line = `[Story planned] Offline tally sheet · D9-STORY-1 · ${idOf("D9-STORY-1")} · Survey capture ‹ Field notebook platform`;
  for (const query of ["pangolin sighting tally", "quokka moult calendar", "Offline tally sheet"]) {
    const answer = await recallCli(workspace, query);
    assert.equal(answer.tau, RECALL_STRONG_TAU.toFixed(4), "the shipped default, not a lowered one");
    assert.equal(answer.reasonCode, "RECALL_READY", query);
    assert.equal(answer.indexed, 4);
    assert.deepEqual(answer.context, [line], query);
  }
  const other = await recallCli(workspace, "nest photo");
  assert.equal(other.records[0]?.id, idOf("D9-STORY-2"), "the other Story's goal words find the other Story");
  const unrelated = ["what is on the football calendar this season", "how long does a photo print take to dry", "sheet music for a beginner piano piece", "今天的天气怎么样"];
  for (const query of unrelated) {
    const answer = await recallCli(workspace, query);
    assert.equal(answer.reasonCode, "RECALL_NO_STRONG_HIT", query);
    assert.deepEqual([answer.records, answer.context], [[], []], query);
  }
  // Three of the four share one word with the library, and at threshold 0 that coincidence is answered.
  const answeredAtZero = [];
  for (const query of unrelated) {
    if ((await recallCli(workspace, query, ["--tau", "0"])).records.length > 0) answeredAtZero.push(query);
  }
  assert.equal(answeredAtZero.length, 3, answeredAtZero.join(" | "));
});

test("644: actual recall CLI distinguishes hit, no-hit, empty and error without leaking query", async context => {
  const workspace = await library(context);
  const previous = process.env.EINZBERN_RECALL_OBSERVATION;
  process.env.EINZBERN_RECALL_OBSERVATION = "1";
  context.after(() => { if (previous === undefined) delete process.env.EINZBERN_RECALL_OBSERVATION; else process.env.EINZBERN_RECALL_OBSERVATION = previous; });
  const query = "private-observation-query-xyz";
  await runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", query], { write() {} });
  await runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", "RC-STORY-1"], { write() {} });
  await assert.rejects(runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", ""], { write() {} }));
  await assert.rejects(runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", " \n\t "], { write() {} }), { reasonCode: "CLI_ARGUMENT_MALFORMED" });
  await assert.rejects(runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", query, "--view", "invalid"], { write() {} }), { reasonCode: "CLI_ARGUMENT_MALFORMED" });
  const { readFile } = await import("node:fs/promises");
  const { deviceHome } = await import("../dist/build/packages/core/src/device-home.js");
  const lines = (await readFile(join(deviceHome(), "log", "hook.ndjson"), "utf8")).trim().split("\n").map(JSON.parse).filter(line => line.host === "cli");
  assert.equal(lines.find(line => line.outcome === "hit").reasonCode, "RECALL_READY");
  assert.equal(lines.find(line => line.outcome === "no-hit").reasonCode, "RECALL_NO_STRONG_HIT");
  const empty = lines.filter(line => line.outcome === "empty");
  assert.equal(empty.length, 2);
  for (const line of empty) {
    assert.equal(line.observation.materializations, 0);
    assert.equal(line.observation.segmentReads, 0);
    assert.equal(line.observation.recallCalls, 0);
  }
  const error = lines.find(line => line.outcome === "error");
  assert.equal(error.reasonCode, "CLI_ARGUMENT_MALFORMED");
  assert.equal(error.observation.materializations, 0);
  assert.equal(new Set(lines.map(line => line.observation.correlationId)).size, lines.length);
  assert.equal(JSON.stringify(lines).includes(query), false);
  assert.equal(JSON.stringify(lines).includes("RC-STORY-1"), false);
});
