// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { workContentDraft, workContentContext, workContentContextSegment, projectTargetHandoff } from "../dist/build/packages/core/src/index.js";
const record = (id, parentId, content) => ({ id, externalKey: id, parentId, revision: 1, kind: content.kind, tombstone: false,
  extensions: { "advisory:work-content": { required: false, value: content } } });
function fixture() {
  const parent = { ...workContentDraft("Initiative"), goal: "批准原文 中文 🧭", constraints: ["保护保留备份，不递归自身"],
    sources: [{ id: "original", kind: "approved-draft", locator: "fixture:source#8", version: "v1", extraction: "complete", text: "明确保留区可备份；清理保留；不递归。" }],
    requirements: [{ id: "R1", version: 1, text: "保护备份", sourceIds: ["original"], shared: true, disposition: "required" }] };
  return { metadata: { workspaceId: "fixture:library" }, work: [record("parent", null, parent), record("child", "parent", workContentDraft("Subtask"))] };
}
test("INIT068 full content retains ancestor original text, exact versions, constraints and inherited provenance", () => {
  const state = fixture(); const context = workContentContext(state, "child");
  assert.equal(context.complete, true);
  assert.deepEqual(context.records[1].content, state.work[0].extensions["advisory:work-content"].value);
  assert.equal(context.records[1].relation, "inherited");
  assert.equal(context.effectiveRequirements[0].inherited, true);
  assert.deepEqual(context.effectiveRequirements[0].ref, { workId: "parent", requirementId: "R1", version: 1 });
  assert.equal(context.semanticVerification, "not-performed");
  const handoff = projectTargetHandoff({ workId: "child", workRevision: 1, workContent: context }, { libraryPath: "/fixture", settings: [], configRecords: [] });
  assert.strictEqual(handoff.workContent, context, "process/native target handoff consumes the very same object");
});
test("INIT068 segmented retrieval explicitly accounts for every omitted code point and pins all versions", () => {
  const state = fixture(); const context = workContentContext(state, "child");
  let segment = workContentContextSegment(context, { limit: 7 });
  const digest = segment.digest; let text = segment.text;
  assert.equal(segment.complete, false); assert.equal(segment.truncated, true);
  assert.deepEqual(segment.omitted, [{ start: 7, end: segment.total }]);
  while (segment.nextOffset !== null) {
    segment = workContentContextSegment(context, { offset: segment.nextOffset, limit: 7, digest });
    assert.equal(segment.text.includes("\ufffd"), false);
    text += segment.text;
  }
  assert.deepEqual(JSON.parse(text), context);
  assert.throws(() => workContentContextSegment(context, { offset: 7, limit: 7 }), e => e.reasonCode === "WORK_CONTENT_CONTEXT_DIGEST_REQUIRED");
  state.work[0].revision++;
  assert.throws(() => workContentContextSegment(workContentContext(state, "child"), { offset: 7, limit: 7, digest }), e => e.reasonCode === "WORK_CONTENT_CONTEXT_CHANGED");
});
test("INIT068 broken ancestry and unavailable source remain distinct from delivery and semantic success", () => {
  const state = fixture(); state.work[0].parentId = "missing";
  const context = workContentContext(state, "child");
  assert.equal(context.complete, false); assert.deepEqual(context.missing, ["ancestor-unavailable:missing"]);
  assert.equal(workContentContextSegment(context).complete, false);
  state.work[0].parentId = "child";
  assert.deepEqual(workContentContext(state, "child").missing, ["ancestor-cycle:child"]);
});
