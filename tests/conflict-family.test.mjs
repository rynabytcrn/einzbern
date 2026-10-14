// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-531 (MIN-256 D6 C5, MIN-257 D6): the conflict guards are split by INIT family.
// A card (TCRN-CROSS-SUB-485) close in subject to a card of another INIT family is written beside it,
// recorded in coexistsWith, and its receipt warns of it; a card of the same family, or of a family
// either side cannot name, is refused with KNOWLEDGE_POSSIBLE_CONFLICT as before, and --supersedes and
// --coexist behave as they did. A family is the Initiative at the top of a work record's parent chain,
// read from a card's source references: a work id directly, a minutes id through the work its minutes
// link (Q11).
//
// TCRN-CROSS-STORY-539 (MIN-256 D6 C5, MIN-258 D1; TCRN-CROSS-SUB-503): a reference that is the
// external key of a work record this library holds names that record's family, and a card's linked
// work (--work-ids) names its family as a work id does; a key this library holds no work under names
// none, as a file does. minutes-record's guard reads a family from the same sources (GWT1, GWT4).

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  applyKnowledgeBatch,
  captureKnowledgeUnit,
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  materializeWorkspace,
  recordMinutes,
} from "../dist/build/packages/core/src/index.js";
import { decisionTopicConflicts } from "../dist/build/packages/core/src/minutes.js";
import { cardFamilies, familiesApart, initFamilyOf, referenceFamilies } from "../dist/build/packages/core/src/work-family.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second) => `2026-10-14T08:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const OWNER = "owner:agent-session";
const work = (key) => deriveStableId("work", key);

// Two Initiatives of one project, each with an Epic and two Stories, and a Subtask under A's first
// Story: INIT-A's family holds STORY-A1, STORY-A2 and SUB-A1; INIT-B's holds STORY-B1 and STORY-B2.
async function familyLibrary(context, name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-conflict-family-${name}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "CF-PROJECT", name: "Conflict family" })).projects[0].id;
  let second = 2;
  const create = (fields) => createWork(workspace, { occurredAt: at(second++), projectId, ...fields });
  for (const side of ["A", "B"]) {
    await create({ externalKey: `CF-INIT-${side}`, kind: "Initiative", parentId: null, title: `Initiative ${side}`, scope: `## Goal\nShip side ${side}.` });
    await create({ externalKey: `CF-EPIC-${side}`, kind: "Epic", parentId: work(`CF-INIT-${side}`), title: `Epic ${side}`, goal: `Hold side ${side}.` });
    for (const n of [1, 2]) {
      await create({
        externalKey: `CF-STORY-${side}${n}`, kind: "Story", parentId: work(`CF-EPIC-${side}`), title: `Story ${side}${n}`,
        goal: `Deliver ${side}${n}.`, acceptance: `GIVEN ${side}${n} WHEN delivered THEN it works`,
      });
    }
  }
  await create({ externalKey: "CF-SUB-A1", kind: "Subtask", parentId: work("CF-STORY-A1"), title: "Subtask A1" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, projectId, next: () => second++ };
}

function lesson(fixture, subject, overrides = {}) {
  return {
    occurredAt: at(fixture.next()), subject, summary: `${subject} 的完整说明`, snippet: `${subject} 摘录`,
    tags: ["lesson"], accountableOwnerId: OWNER, body: `${subject} 正文 ${String(Math.random())}`, ...overrides,
  };
}

const capture = (fixture, subject, overrides) => captureKnowledgeUnit(fixture.workspace, lesson(fixture, subject, overrides), { allowTrailing: true });
const refusalOf = (promise) => promise.then(() => null, (error) => error);

async function cardById(fixture, id) {
  const all = await listKnowledgeMetadata(fixture.workspace, { at: at(3000), selection: "all", allowTrailing: true });
  return all.records.find((record) => record.id === id);
}

test("STORY-531 (SUB-485): a work record's family is the Initiative at the top of its chain, and a reference list's the families it leads to", async (context) => {
  const fixture = await familyLibrary(context, "unit");
  const state = await materializeWorkspace(fixture.workspace);
  assert.equal(initFamilyOf(state, work("CF-STORY-A1")), work("CF-INIT-A"));
  assert.equal(initFamilyOf(state, work("CF-SUB-A1")), work("CF-INIT-A"), "a Subtask walks up through its Story and Epic");
  assert.equal(initFamilyOf(state, work("CF-INIT-B")), work("CF-INIT-B"), "an Initiative is its own family");
  assert.equal(initFamilyOf(state, work("CF-NOT-HERE")), null, "a record the library does not hold has none");

  assert.deepEqual(referenceFamilies(state, [work("CF-STORY-B2"), "docs/notes.md", "https://example.test/x"]), [work("CF-INIT-B")], "files and URLs name no family");
  assert.deepEqual(referenceFamilies(state, [work("CF-STORY-A2"), work("CF-STORY-B1")]), [work("CF-INIT-A"), work("CF-INIT-B")].sort());
  assert.equal(referenceFamilies(state, ["docs/notes.md"]), null, "no reference naming a family: not known");
  assert.equal(referenceFamilies(state, []), null);
  assert.equal(referenceFamilies(state, [work("CF-STORY-A1"), work("CF-ELSEWHERE")]), null, "one reference to work this library does not hold: not known");
  assert.equal(referenceFamilies(state, ["minutes:cf-not-recorded"]), null, "minutes this library does not hold: not known");

  assert.equal(familiesApart([work("CF-INIT-A")], [work("CF-INIT-B")]), true);
  assert.equal(familiesApart([work("CF-INIT-A")], [work("CF-INIT-A"), work("CF-INIT-B")]), false, "one family in common is the same family");
  assert.equal(familiesApart(null, [work("CF-INIT-B")]), false, "a side of no known family is taken as the other's");
  assert.equal(familiesApart([work("CF-INIT-A")], null), false);
});

test("STORY-531 GWT1 (SUB-485): a card close to a card of another INIT family is written, warned of, and recorded beside it", async (context) => {
  const fixture = await familyLibrary(context, "gwt1");
  const subject = "并发跑门 前先确认 工作树 没有其他编辑";
  const old = await capture(fixture, subject, { sourceReferences: [work("CF-STORY-B1")] });
  const written = await capture(fixture, subject, { sourceReferences: [work("CF-STORY-A1")] });
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.deepEqual(written.conflicts, [old.id]);
  assert.deepEqual(written.warnings.map((warning) => [warning.reasonCode, warning.id, warning.families]), [["KNOWLEDGE_POSSIBLE_CONFLICT", old.id, [work("CF-INIT-B")]]], "the receipt warns of the card it stands beside");
  assert.match(written.warnings[0].message, /another INIT family/u);
  assert.deepEqual((await cardById(fixture, written.id)).extensions, { coexistsWith: [old.id] }, "the new card records what it stands beside");
  assert.equal(Object.hasOwn(await cardById(fixture, old.id), "removal"), false, "the old card stays valid");

  // A minutes id leads to the work its minutes link: minutes linking B2 are of B's family.
  await recordMinutes(fixture.workspace, {
    occurredAt: at(fixture.next()), projectId: fixture.projectId, externalKey: "CF-MIN-B", title: "B minutes", summary: "Decided on B.",
    decisions: ["Ship B2 first."], decidedBy: ["agent:claude-opus-5-5"], linkedWorkIds: [work("CF-STORY-B2")],
  });
  const minutesSubject = "纪要 引用 折算 工单族 的卡";
  const viaMinutes = await capture(fixture, minutesSubject, { sourceReferences: [deriveStableId("minutes", "CF-MIN-B")] });
  const besideMinutes = await capture(fixture, minutesSubject, { sourceReferences: [work("CF-STORY-A2")] });
  assert.deepEqual(besideMinutes.warnings.map((warning) => [warning.id, warning.families]), [[viaMinutes.id, [work("CF-INIT-B")]]]);
  const sameAsMinutes = await refusalOf(capture(fixture, minutesSubject, { sourceReferences: [work("CF-STORY-B1")] }));
  assert.equal(sameAsMinutes?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "the minutes' card is of B's family, so a card of B is refused");
  assert.deepEqual(sameAsMinutes.details, { conflicts: [viaMinutes.id], otherFamilyConflicts: [besideMinutes.id] });
});

test("STORY-531 GWT2 (SUB-485): a card close to one of its own family, or of a family not known, is still refused", async (context) => {
  const fixture = await familyLibrary(context, "gwt2");
  const subject = "覆盖基线 没有生成器 要手工 重录";
  const old = await capture(fixture, subject, { sourceReferences: [work("CF-STORY-A1")] });
  const sameFamily = await refusalOf(capture(fixture, subject, { sourceReferences: [work("CF-SUB-A1")] }));
  assert.equal(sameFamily?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a Subtask of the same Initiative is the same family");
  assert.deepEqual(sameFamily.details, { conflicts: [old.id] });

  const unknownNew = await refusalOf(capture(fixture, subject, { sourceReferences: ["docs/notes.md"] }));
  assert.equal(unknownNew?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a new card naming no work has no family: refused");
  const elsewhere = await refusalOf(capture(fixture, subject, { sourceReferences: [work("CF-OTHER-LIBRARY-STORY")] }));
  assert.equal(elsewhere?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "work this library does not hold has no family: refused");

  const plain = await capture(fixture, "热重载 立即生效 不必 重启宿主", {});
  const unknownOld = await refusalOf(capture(fixture, "热重载 立即生效 不必 重启宿主", { sourceReferences: [work("CF-STORY-B1")] }));
  assert.equal(unknownOld?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "an old card naming no work has no family: refused");
  assert.deepEqual(unknownOld.details.conflicts, [plain.id]);

  // Two conflicts, one of each kind: the refusal names the one that refuses, and the other apart.
  const crossOld = await capture(fixture, "门输出 必须 先写进文件 再读", { sourceReferences: [work("CF-STORY-B2")] });
  const sameOld = await capture(fixture, "门输出 必须 先写进文件 再读 摘录", { sourceReferences: [work("CF-STORY-A2")], coexist: true });
  const mixed = await refusalOf(capture(fixture, "门输出 必须 先写进文件 再读", { sourceReferences: [work("CF-STORY-A1")] }));
  assert.equal(mixed?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
  assert.deepEqual(mixed.details, { conflicts: [sameOld.id], otherFamilyConflicts: [crossOld.id] });
});

test("STORY-531 (SUB-485): --supersedes and --coexist behave as they did", async (context) => {
  const fixture = await familyLibrary(context, "flags");
  const subject = "策略 JSON 按键 定位 不按 行号";
  const old = await capture(fixture, subject, { sourceReferences: [work("CF-STORY-B1")] });
  const coexisting = await capture(fixture, subject, { sourceReferences: [work("CF-STORY-A1")], coexist: true });
  assert.deepEqual(coexisting.conflicts, [old.id]);
  assert.equal(Object.hasOwn(coexisting, "warnings"), false, "a writer who said --coexist is not warned");
  assert.deepEqual((await cardById(fixture, coexisting.id)).extensions, { coexistsWith: [old.id] });

  const sameOld = await capture(fixture, "知识读取 需要 allow-trailing 标志", { sourceReferences: [work("CF-STORY-A1")] });
  const replacement = await capture(fixture, "知识读取 需要 allow-trailing 标志", { sourceReferences: [work("CF-STORY-A2")], supersedes: sameOld.id });
  assert.equal(replacement.superseded, sameOld.id);
  assert.equal(Object.hasOwn(replacement, "warnings"), false);
});

test("STORY-531 (SUB-485): knowledge-capture and knowledge-batch receipts carry the warnings", async (context) => {
  const fixture = await familyLibrary(context, "receipts");
  const subject = "子代理 完成通知 不等于 做完";
  const old = await capture(fixture, subject, { sourceReferences: [work("CF-STORY-B1")] });
  let output = "";
  await runCli([
    "knowledge-capture", "--workspace", fixture.workspace, "--at", at(fixture.next()), "--subject", subject,
    "--summary", "通知只说明代理停下", "--snippet", "通知不等于完成", "--tags", "lesson", "--accountable-owner-id", OWNER,
    "--body", "CLI 回执", "--source-references", work("CF-STORY-A1"), "--allow-trailing", "true",
  ], { write: (value) => { output += value; } });
  const receipt = JSON.parse(output);
  assert.equal(receipt.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  assert.deepEqual(receipt.warnings.map((warning) => warning.id), [old.id], "the CLI receipt names the card under warnings");

  const member = (key, overrides) => ({
    verb: "knowledge-create", externalKey: key, scope: "project", projectId: fixture.projectId, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["batch"], subject: "批量 写卡 按 成员 回执 警告", summary: "batch", snippet: "batch",
    accountableOwnerId: OWNER, sourceDigest: canonicalSha256({ key }), linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
    linkedEvidenceIds: [deriveStableId("evidence", key)], retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: at(2), stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    body: `${key} body`, ...overrides,
  });
  const result = await applyKnowledgeBatch(fixture.workspace, {
    schemaVersion: "tcrn.knowledge-batch.v1",
    members: [member("CF-BATCH-1", { sourceReferences: [work("CF-STORY-B2")] }), member("CF-BATCH-2", { sourceReferences: [work("CF-STORY-A2")] })],
  }, { occurredAt: at(fixture.next()), mutation: { allowTrailing: true } });
  assert.equal(Object.hasOwn(result.applied[0], "warnings"), false, "the first member stood beside nothing");
  assert.deepEqual(result.applied[1].warnings.map((warning) => warning.id), [deriveStableId("knowledge", "CF-BATCH-1")], "the second member's entry carries its warnings");
});

test("STORY-531 (SUB-485): the user crest splits the same way, and a card pointing at another library's work has no family", async (context) => {
  const fixture = await familyLibrary(context, "user");
  const subject = "用户卡 跨库 回忆 主题相近 分族";
  const old = await capture(fixture, subject, { scope: "user", sourceReferences: [work("CF-STORY-B1")] });
  const written = await capture(fixture, subject, { scope: "user", sourceReferences: [work("CF-STORY-A1")] });
  assert.equal(written.scope, "user");
  assert.deepEqual(written.warnings.map((warning) => warning.id), [old.id]);
  const foreign = await refusalOf(capture(fixture, subject, { scope: "user", sourceReferences: [work("CF-OTHER-LIBRARY-STORY")] }));
  assert.equal(foreign?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "another library's work names no family here (Q11)");
  const sameFamily = await refusalOf(capture(fixture, subject, { scope: "user", sourceReferences: [work("CF-STORY-B2")] }));
  assert.equal(sameFamily?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
  assert.deepEqual(sameFamily.details, { conflicts: [old.id], otherFamilyConflicts: [written.id] });
});

// TCRN-CROSS-SUB-486: minutes-record is split the same way. A record's family is that of the work it
// links; an existing decision's, that of the work its minutes link.
const OTTER = "Store the otter archive on the east shelf.";
const decision = (key, number) => `${deriveStableId("minutes", key)}#D${String(number)}`;

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function minutesRecord(fixture, key, linked, decisions, extra = []) {
  return cliJson([
    "minutes-record", "--workspace", fixture.workspace, "--at", at(fixture.next()), "--project-id", fixture.projectId, "--external-key", key,
    "--title", `Minutes ${key}`, "--summary", `Recorded as ${key}.`, "--decisions", decisions.join(","),
    ...(linked.length === 0 ? [] : ["--work-ids", linked.join(",")]), ...extra,
  ]);
}

test("STORY-531 GWT3 (SUB-486): a decision close to one of another INIT family is recorded beside it, with a warning", async (context) => {
  const fixture = await familyLibrary(context, "gwt3-apart");
  await minutesRecord(fixture, "CF-MIN-1", [work("CF-STORY-B1")], [OTTER]);
  const before = (await materializeWorkspace(fixture.workspace)).version;
  const recorded = await minutesRecord(fixture, "CF-MIN-2", [work("CF-STORY-A1")], [OTTER]);
  assert.equal(recorded.reasonCode, "MINUTES_RECORDED");
  assert.equal(recorded.version, before + 1, "one event, as any minutes-record writes");
  assert.deepEqual(recorded.declarations, { supersedes: [], withdraws: [], coexists: [decision("CF-MIN-1", 1)] }, "the record stands beside the decision of the other family");
  assert.deepEqual(recorded.warnings.map((warning) => [warning.reasonCode, warning.decision, warning.text, warning.families]), [
    ["MINUTES_POSSIBLE_CONFLICT", decision("CF-MIN-1", 1), OTTER, [work("CF-INIT-B")]],
  ], "the receipt warns of it");
  assert.match(recorded.warnings[0].message, /another INIT family/u);

  const state = await materializeWorkspace(fixture.workspace);
  const stored = state.events.at(-1).payload.record;
  assert.deepEqual(Object.keys(stored).sort(), ["decidedBy", "decisions", "declarations", "externalKey", "id", "linkedWorkIds", "projectId", "recordedAt", "revision", "schemaVersion", "summary", "title", "tombstone"], "the event keeps the minutes record's shape");
  assert.deepEqual(stored.declarations.coexists, [decision("CF-MIN-1", 1)]);
  const shown = await cliJson(["minutes-show", "--workspace", fixture.workspace, "--id", decision("CF-MIN-1", 1).split("#")[0], "--status", "all"]);
  assert.deepEqual(shown.record.decisions.map((entry) => entry.status), ["valid"], "standing beside leaves the other decision valid");

  // A writer who declared the decision himself is not warned of it.
  const declared = await minutesRecord(fixture, "CF-MIN-3", [work("CF-STORY-A2")], [OTTER], ["--coexists", `${decision("CF-MIN-1", 1)},${decision("CF-MIN-2", 1)}`]);
  assert.deepEqual(declared.declarations.coexists, [decision("CF-MIN-1", 1), decision("CF-MIN-2", 1)].sort());
  assert.equal(Object.hasOwn(declared, "warnings"), false);
});

test("STORY-531 GWT3 (SUB-486): a decision close to one of its own family, or of a family not known, is still MINUTES_POSSIBLE_CONFLICT", async (context) => {
  const fixture = await familyLibrary(context, "gwt3-same");
  await minutesRecord(fixture, "CF-MIN-1", [work("CF-STORY-B1")], [OTTER]);
  await minutesRecord(fixture, "CF-MIN-2", [work("CF-STORY-A1")], [OTTER]);
  const before = (await materializeWorkspace(fixture.workspace)).version;
  const sameFamily = await refusalOf(minutesRecord(fixture, "CF-MIN-3", [work("CF-STORY-B2")], [OTTER]));
  assert.equal(sameFamily?.reasonCode, "MINUTES_POSSIBLE_CONFLICT", "a Story of the same Initiative is the same family");
  assert.deepEqual(sameFamily.details.conflicts, [decision("CF-MIN-1", 1)], "the decision of the same family refuses");
  assert.deepEqual(sameFamily.details.otherFamilyConflicts, [decision("CF-MIN-2", 1)], "the one of the other family is named apart");
  assert.match(sameFamily.details.remedy, /--coexists/u);

  const unlinked = await refusalOf(minutesRecord(fixture, "CF-MIN-4", [], [OTTER]));
  assert.equal(unlinked?.reasonCode, "MINUTES_POSSIBLE_CONFLICT", "a record linking no work has no family: refused");
  assert.deepEqual([...unlinked.details.conflicts].sort(), [decision("CF-MIN-1", 1), decision("CF-MIN-2", 1)].sort());
  assert.equal(Object.hasOwn(unlinked.details, "otherFamilyConflicts"), false);
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before, "a refused record writes nothing");
});

// TCRN-CROSS-SUB-503 (STORY-539): the external key of a work record this library holds, and a card's
// linked work, name a family. A card links work of its own project only, so these are project cards.
function createCardArgs(fixture, key, subject, { references = "-", workIds } = {}) {
  return [
    "knowledge-create", "--workspace", fixture.workspace, "--at", at(fixture.next()), "--external-key", key, "--scope", "project",
    "--project-id", fixture.projectId, "--role-scopes", "-", "--category", "workflow", "--kind", "fact", "--tags", "lesson", "--subject", subject,
    "--summary", `${subject} 的说明`, "--snippet", `${subject} 摘录`, "--accountable-owner-id", OWNER, "--source-references", references,
    "--retrieval", "default", "--freshness", "fresh", "--last-verified", "-", "--stale-days", "-", "--export", "metadata-only",
    "--body", `${key} 正文`, ...(workIds === undefined ? [] : ["--work-ids", workIds.join(",")]),
  ];
}

function batchMember(fixture, key, subject, overrides = {}) {
  return {
    verb: "knowledge-create", externalKey: key, scope: "project", projectId: fixture.projectId, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["batch"], subject, summary: "batch", snippet: "batch",
    accountableOwnerId: OWNER, sourceDigest: canonicalSha256({ key }), sourceReferences: [], linkedWorkIds: [], linkedDecisionIds: [],
    linkedGateIds: [], linkedEvidenceIds: [deriveStableId("evidence", key)], retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: at(2), stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
    body: `${key} body`, ...overrides,
  };
}

test("STORY-539 (SUB-503): a work record's external key names its family, and a card's linked work names one as a work id does", async (context) => {
  const fixture = await familyLibrary(context, "keys");
  const state = await materializeWorkspace(fixture.workspace);
  assert.deepEqual(referenceFamilies(state, ["CF-STORY-B2"]), [work("CF-INIT-B")], "a key names its record's family");
  assert.deepEqual(referenceFamilies(state, ["CF-SUB-A1", "docs/notes.md"]), [work("CF-INIT-A")], "a Subtask's key walks up its chain");
  assert.deepEqual(referenceFamilies(state, ["CF-INIT-A", work("CF-STORY-B1")]), [work("CF-INIT-A"), work("CF-INIT-B")].sort());
  assert.equal(referenceFamilies(state, ["cf-story-b2"]), null, "a key is matched case and all");
  assert.equal(referenceFamilies(state, ["CF-STORY-B2 GWT1"]), null, "and whole: a reference that only begins with a key names none");
  assert.equal(referenceFamilies(state, ["CF-STORY-Z9"]), null, "a key this library holds no work under names none: not known");
  assert.deepEqual(referenceFamilies(state, ["CF-STORY-Z9", work("CF-STORY-A2")]), [work("CF-INIT-A")], "beside a reference that names one, it names nothing, as a file does");
  assert.equal(referenceFamilies(state, ["CF-STORY-A1", "CF-STORY-Z9", work("CF-ELSEWHERE")]), null, "a work id this library does not hold still makes it not known");

  assert.deepEqual(referenceFamilies(state, ["docs/notes.md"], [work("CF-STORY-B1")]), [work("CF-INIT-B")], "linked work names its family");
  assert.deepEqual(referenceFamilies(state, ["CF-STORY-A1"], [work("CF-STORY-B1")]), [work("CF-INIT-A"), work("CF-INIT-B")].sort());
  assert.equal(referenceFamilies(state, ["CF-STORY-A1"], [work("CF-ELSEWHERE")]), null, "linked work this library does not hold: not known");
  assert.deepEqual(cardFamilies(state, { sourceReferences: [], linkedWorkIds: [work("CF-SUB-A1")] }), [work("CF-INIT-A")]);
  assert.equal(cardFamilies(state, { sourceReferences: ["https://example.test/x"], linkedWorkIds: [] }), null);
});

test("STORY-539 GWT1 (SUB-503): a card citing work keys is judged by their family: beside another family with a warning, refused in its own or when a key names no work here", async (context) => {
  const fixture = await familyLibrary(context, "gwt1-keys");
  const subject = "外部键 引用 的卡 按工单族 判定 写入";
  const old = await capture(fixture, subject, { sourceReferences: ["CF-STORY-B1", "docs/notes.md"] });
  const written = await capture(fixture, subject, { sourceReferences: ["CF-STORY-A1"] });
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED", "a card of A beside a card of B, both named by key, is written");
  assert.deepEqual(written.warnings.map((warning) => [warning.reasonCode, warning.id, warning.families]), [["KNOWLEDGE_POSSIBLE_CONFLICT", old.id, [work("CF-INIT-B")]]]);
  assert.deepEqual((await cardById(fixture, written.id)).extensions, { coexistsWith: [old.id] }, "the card records what it stands beside");
  assert.equal(Object.hasOwn(await cardById(fixture, old.id), "removal"), false, "the old card stays valid");

  const sameFamily = await refusalOf(capture(fixture, subject, { sourceReferences: ["CF-STORY-B2"] }));
  assert.equal(sameFamily?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a key of the same Initiative's work is the same family");
  assert.deepEqual(sameFamily.details, { conflicts: [old.id], otherFamilyConflicts: [written.id] });

  for (const references of [["CF-STORY-Z9"], ["cf-story-a2"], ["TCRN-CROSS-STORY-529", "docs/notes.md"]]) {
    const unknown = await refusalOf(capture(fixture, subject, { sourceReferences: references }));
    assert.equal(unknown?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", `${references[0]} names no work of this library: no known family, refused as before`);
    assert.deepEqual([...unknown.details.conflicts].sort(), [old.id, written.id].sort());
    assert.equal(Object.hasOwn(unknown.details, "otherFamilyConflicts"), false);
  }
});

test("STORY-539 GWT1 (SUB-503): a card that names its work only by --work-ids is of that work's family", async (context) => {
  const fixture = await familyLibrary(context, "gwt1-work-ids");
  const subject = "只带 关联工单 的卡 按其族 判定 写入";
  const old = await cliJson(createCardArgs(fixture, "CF-LINKED-B", subject, { workIds: [work("CF-STORY-B1")] }));
  assert.equal(old.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const written = await cliJson(createCardArgs(fixture, "CF-LINKED-A", subject, { references: "docs/notes.md", workIds: [work("CF-SUB-A1")] }));
  assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED", "the linked work of each side names its family, though no reference does");
  assert.deepEqual(written.warnings.map((warning) => [warning.reasonCode, warning.id, warning.families]), [["KNOWLEDGE_POSSIBLE_CONFLICT", old.id, [work("CF-INIT-B")]]]);

  const sameFamily = await refusalOf(cliJson(createCardArgs(fixture, "CF-LINKED-B2", subject, { workIds: [work("CF-STORY-B2")] })));
  assert.equal(sameFamily?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
  assert.deepEqual(sameFamily.details, { conflicts: [old.id], otherFamilyConflicts: [written.id] });
  const captured = await refusalOf(capture(fixture, subject, { sourceReferences: ["CF-STORY-A2"] }));
  assert.equal(captured?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a capture naming A's work by key is of the linked card's family");
  assert.deepEqual(captured.details, { conflicts: [written.id], otherFamilyConflicts: [old.id] });
  const unlinked = await refusalOf(cliJson(createCardArgs(fixture, "CF-UNLINKED", subject, { references: "docs/notes.md" })));
  assert.equal(unlinked?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a card naming neither work nor linked work has no family");
});

test("STORY-539 GWT1 (SUB-503): knowledge-batch reads a member's work keys and linked work the same way", async (context) => {
  const fixture = await familyLibrary(context, "gwt1-batch");
  const subject = "批量 成员 外部键 关联工单 判族";
  const result = await applyKnowledgeBatch(fixture.workspace, {
    schemaVersion: "tcrn.knowledge-batch.v1",
    members: [
      batchMember(fixture, "CF-BATCH-KEY-B", subject, { sourceReferences: ["CF-STORY-B2"] }),
      batchMember(fixture, "CF-BATCH-LINK-A", subject, { linkedWorkIds: [work("CF-STORY-A2")] }),
    ],
  }, { occurredAt: at(fixture.next()), mutation: { allowTrailing: true } });
  assert.equal(Object.hasOwn(result.applied[0], "warnings"), false, "the first member stood beside nothing");
  assert.deepEqual(result.applied[1].warnings.map((warning) => [warning.reasonCode, warning.id, warning.families]), [
    ["KNOWLEDGE_POSSIBLE_CONFLICT", deriveStableId("knowledge", "CF-BATCH-KEY-B"), [work("CF-INIT-B")]],
  ], "the second member, of A by its linked work, stands beside the first, of B by its key");
});

test("STORY-539 GWT4 (SUB-503): minutes-record's guard reads a family from the sources the card guard reads", async (context) => {
  const fixture = await familyLibrary(context, "gwt4");
  await minutesRecord(fixture, "CF-MIN-B", [work("CF-STORY-B1")], [OTTER]);
  // One family, named three ways: B's minutes, the key of B's Story and B's linked work.
  const subject = "纪要 与 卡 同一套 族来源 判定";
  const byMinutes = await capture(fixture, subject, { sourceReferences: [deriveStableId("minutes", "CF-MIN-B")] });
  const byKey = await refusalOf(capture(fixture, subject, { sourceReferences: ["CF-STORY-B2"] }));
  assert.equal(byKey?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "B's minutes and the key of B's Story name one family");
  assert.deepEqual(byKey.details, { conflicts: [byMinutes.id] });
  const byLink = await capture(fixture, subject, { sourceReferences: ["CF-STORY-A1"] });
  assert.deepEqual(byLink.warnings.map((warning) => [warning.id, warning.families]), [[byMinutes.id, [work("CF-INIT-B")]]]);

  // The minutes guard: a record linking A's work stands beside B's decision, warned of B's family.
  const recorded = await minutesRecord(fixture, "CF-MIN-A", [work("CF-STORY-A1")], [OTTER]);
  assert.deepEqual(recorded.warnings.map((warning) => [warning.reasonCode, warning.decision, warning.families]), [
    ["MINUTES_POSSIBLE_CONFLICT", decision("CF-MIN-B", 1), [work("CF-INIT-B")]],
  ]);
  // At the core the record's linked work is read as a card's references are: a work id, or a key.
  const state = await materializeWorkspace(fixture.workspace);
  const probe = (linkedWorkIds) => decisionTopicConflicts(state, { id: deriveStableId("minutes", "CF-MIN-PROBE"), projectId: fixture.projectId, decisions: [OTTER], linkedWorkIds })
    .map((entry) => [entry.decision, entry.otherFamily]).sort((left, right) => (left[0] < right[0] ? -1 : 1));
  const expected = [[decision("CF-MIN-A", 1), false], [decision("CF-MIN-B", 1), true]].sort((left, right) => (left[0] < right[0] ? -1 : 1));
  assert.deepEqual(probe([work("CF-STORY-A2")]), expected);
  assert.deepEqual(probe(["CF-STORY-A2"]), expected, "a key names the family a work id names");
  assert.deepEqual(probe(["CF-STORY-Z9"]).map(([, apart]) => apart), [false, false], "a key this library holds no work under: not known");
  const refused = await refusalOf(minutesRecord(fixture, "CF-MIN-B2", [work("CF-STORY-B2")], [OTTER]));
  assert.equal(refused?.reasonCode, "MINUTES_POSSIBLE_CONFLICT", "a record of B's family is refused for B's decision");
  assert.deepEqual([refused.details.conflicts, refused.details.otherFamilyConflicts], [[decision("CF-MIN-B", 1)], [decision("CF-MIN-A", 1)]]);
});
