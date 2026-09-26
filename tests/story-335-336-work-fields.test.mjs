// SPDX-License-Identifier: Apache-2.0
// STORY-335/336: scope references and the four first-class work fields.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProject,
  createWork,
  initializeLibrary,
  materializeWorkspace,
  readAllStreams,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, validateWorkGraph } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-02T03:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s335-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(0) });
  const project = await createProject(workspace, {
    externalKey: `STORY-335-PROJECT-${suffix}`,
    name: "Storage",
    occurredAt: instant(2),
  });
  return { base, workspace, projectId: project.projects[0].id };
}

test("STORY-335 unchanged status updates store a scope reference and replay the full extensions", async (context) => {
  const fx = await fixture(context, "REFERENCE");
  const scope = "【Goal】为谁改变什么=去重；目的锚=STORY-335；符合性判据=全值相同；判定人=九门。\n【Requirements】修复项=保留完整正文；证据=事件逐值比对。\n【Acceptance Criteria】Given 一条带 scope 的工单 When 只改 status Then 正文通过引用复用。\n【Business Background】现状=状态迁移会重复写入正文。\n【Preconditions】无——原因：测试独立。\n【Assumptions】无——原因：不改变图结构。\n【Use Cases & Examples】无——原因：只验证去重。\n【Feature Toggle & Setting】无——原因：无开关。\n【Permissions】仓内改动。\n【Implementation Notes】实现=新增 scope 引用并在重放时还原。";
  const initiative = await createWork(fx.workspace, {
    projectId: fx.projectId,
    externalKey: "STORY-335-WORK-INITIATIVE",
    kind: "Initiative",
    parentId: null,
    occurredAt: instant(3),
  });
  const epic = await createWork(fx.workspace, {
    projectId: fx.projectId,
    externalKey: "STORY-335-WORK-EPIC",
    kind: "Epic",
    parentId: initiative.work.find((record) => record.externalKey === "STORY-335-WORK-INITIATIVE").id,
    occurredAt: instant(4),
  });
  const created = await createWork(fx.workspace, {
    projectId: fx.projectId,
    externalKey: "STORY-335-WORK-REFERENCE",
    kind: "Story",
    parentId: epic.work.find((record) => record.externalKey === "STORY-335-WORK-EPIC").id,
    scope,
    title: "Scope deduplication",
    labels: ["storage", "dedup"],
    occurredAt: instant(5),
  });
  const id = created.work.find((record) => record.externalKey === "STORY-335-WORK-REFERENCE").id;
  const transitioned = await transitionWork(fx.workspace, {
    id,
    status: "ready",
    occurredAt: instant(6),
  });
  const record = transitioned.work.find((entry) => entry.id === id);
  assert.equal(record.extensions["advisory:scope"].value, scope);
  assert.equal(record.scopeDigest, canonicalSha256(record.extensions));
  assert.equal(record.title, "Scope deduplication");
  assert.equal(record.createdAt, instant(5));
  assert.deepEqual(record.labels, ["dedup", "storage"]);

  // The event as stored in this device's stream of the library.
  const events = (await readAllStreams(fx.workspace)).events.map((entry) => entry.event);
  const update = events.find((event) => event.payload.operation === "work.updated");
  const storedScope = update.payload.record.extensions["advisory:scope"].value;
  assert.equal(storedScope.schemaVersion, "tcrn.work-scope-reference.v1");
  assert.equal(storedScope.digest, record.scopeDigest);
  assert.equal(JSON.stringify(storedScope).includes(scope), false, "the updated event must not carry the scope body");
  assert.deepEqual(await materializeWorkspace(fx.workspace), transitioned);
});

test("STORY-336 first-class fields are accepted by the protocol and old records remain readable", () => {
  const legacy = {
    schemaVersion: "tcrn.work.v1",
    id: "work:111111111111111111111111",
    externalKey: "LEGACY-WORK",
    projectId: "project:222222222222222222222222",
    kind: "Initiative",
    parentId: null,
    status: "planned",
    revision: 1,
    updatedAt: instant(0),
    tombstone: false,
    extensions: {},
  };
  assert.doesNotThrow(() => validateWorkGraph([legacy]));
  const current = { ...legacy, scopeDigest: null, title: null, createdAt: null, labels: [] };
  assert.doesNotThrow(() => validateWorkGraph([current]));
});

test("STORY-336 work summaries expose title and creation time without dropping the eleven existing fields", async (context) => {
  const fx = await fixture(context, "SUMMARY");
  const scope = "【Goal】为谁改变什么=列表；目的锚=STORY-336；符合性判据=可读；判定人=九门。\n【Requirements】字段。\n【Acceptance Criteria】GWT。\n【Business Background】背景。\n【Preconditions】无。\n【Assumptions】无。\n【Use Cases & Examples】无。\n【Feature Toggle & Setting】无。\n【Permissions】仓内。\n【Implementation Notes】实现。";
  const state = await createWork(fx.workspace, {
    projectId: fx.projectId,
    externalKey: "STORY-336-WORK-SUMMARY",
    kind: "Initiative",
    parentId: null,
    scope,
    title: "Readable summary",
    labels: ["summary"],
    occurredAt: instant(3),
  });
  assert.equal(state.work[0].title, "Readable summary");
  assert.equal(state.work[0].createdAt, instant(3));
  assert.deepEqual(state.work[0].labels, ["summary"]);
});

test("STORY-336 labels remain first-class instead of becoming an extension key", async (context) => {
  const fx = await fixture(context, "LABELS");
  const state = await createWork(fx.workspace, {
    projectId: fx.projectId,
    externalKey: "STORY-336-WORK-LABELS",
    kind: "Initiative",
    parentId: null,
    title: "First-class labels",
    labels: ["zeta", "alpha"],
    occurredAt: instant(3),
  });
  const record = state.work.find((entry) => entry.externalKey === "STORY-336-WORK-LABELS");
  assert.deepEqual(record.labels, ["alpha", "zeta"]);
  assert.equal(Object.hasOwn(record.extensions, "labels"), false);
  assert.deepEqual(await materializeWorkspace(fx.workspace), state);
});
