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
  initializeKnowledgeStore,
  initializeLibrary,
  recordMinutes,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { RECALL_STRONG_TAU, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";

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

async function recallCli(workspace, query, extra = []) {
  let output = "";
  await runCli(["recall", "--workspace", workspace, "--at", at(30), "--query", query, "--allow-trailing", "true", ...extra], { write(value) { output = value; } });
  return JSON.parse(output);
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
  const { setWorkspaceSetting } = await import("../dist/build/packages/core/src/index.js");
  await setWorkspaceSetting(workspace, { occurredAt: at(40), key: "injection.perPromptBytes", value: String(firstLineBytes) });
  resetRecallCache();
  const cut = await recallCli(workspace, query, ["--tau", "0"]);
  assert.equal(cut.perPromptBytes, firstLineBytes);
  assert.deepEqual(cut.context, [full.context[0]], "the first line that does not fit ends the answer");
  assert.equal(cut.records.length, full.records.length, "records are not cut; only the context is");
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

test("STORY-474 R4: the engine has no session-level injection entry; recall is asked per prompt", () => {
  assert.deepEqual(Object.keys(HOST_HOOK_EVENTS), ["UserPromptSubmit"], "no SessionStart or PostToolUse hook is rendered");
  assert.deepEqual(COMMAND_CATALOG.filter((entry) => /inject|session/u.test(entry.name)).map((entry) => entry.name), [],
    "no verb injects context into a session or keeps a session byte ledger");
});
