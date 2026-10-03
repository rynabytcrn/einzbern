// SPDX-License-Identifier: Apache-2.0
// STORY-515: the device's work index summarises complete ordered collections. Events
// remain the authority; the protocol's real-library record limit is unchanged.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  appendEvents, createProject, createWork, createWorkDelta, initializeLibrary,
  materializeWorkspaceFromGenesis, workspaceBudgets, workspaceViewDocuments,
} from "../dist/build/packages/core/src/index.js";
import { PROTOCOL_LIMITS, canonicalSha256, compareCanonicalText, deriveStableId, validateWorkGraph } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-30T10:00:00Z";
async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-work-ceiling-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, ".ether");
  await initializeLibrary({ root, createdAt: AT });
  const state = await createProject(root, { occurredAt: AT, externalKey: "CEILING-PROJECT", name: "Ceiling" });
  return { root, state, projectId: state.projects[0].id };
}

const indexOf = (state) => JSON.parse(workspaceViewDocuments(state)["index.json"]);

test("STORY-515: projection remains bounded at 1,536 and 15,360 records, with no per-record canonical bypass", async (context) => {
  const fx = await fixture(context);
  const seeded = await createWork(fx.root, { occurredAt: AT, projectId: fx.projectId, externalKey: "CEILING-SEED", kind: "Initiative", parentId: null, title: "a" });
  const records = Array.from({ length: 15_360 }, (_, ordinal) => ({ ...seeded.work[0], id: deriveStableId("work", `CEILING-${ordinal}`), externalKey: `CEILING-${ordinal}` }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  // This stresses the projection in isolation. A library with more than maxRecords
  // is still refused by its existing complete-graph validation, below.
  const texts = [1_536, 15_360].map((count) => workspaceViewDocuments({ ...seeded, work: records.slice(0, count) })["index.json"]);
  const sizes = texts.map((text) => Buffer.byteLength(text, "utf8"));
  assert.ok(Math.abs(sizes[1] - sizes[0]) < 1_024, JSON.stringify(sizes));
  assert.ok(sizes.every((bytes) => bytes < PROTOCOL_LIMITS.maxCanonicalBytes));
  assert.deepEqual(texts.map((text) => JSON.parse(text).work.count), [1_536, 15_360]);
  assert.equal(texts[1], workspaceViewDocuments({ ...seeded, work: records })["index.json"], "projection is deterministic");
  assert.equal(validateWorkGraph(records).length, records.length, "complete graphs cross the former 10,000 record ceiling");
  const longTitle = { ...records[0], title: "a".repeat(8_193) };
  assert.doesNotThrow(() => workspaceViewDocuments({ ...seeded, work: [longTitle] }));
  assert.equal(validateWorkGraph([longTitle])[0].title.length, 8_193);
});

test("STORY-515: every record, including a tombstone, contributes all its content and its order", async (context) => {
  const fx = await fixture(context);
  const seeded = await createWork(fx.root, { occurredAt: AT, projectId: fx.projectId, externalKey: "SENSITIVE-SEED", kind: "Initiative", parentId: null, title: "a" });
  const records = Array.from({ length: 32 }, (_, ordinal) => ({ ...seeded.work[0], id: deriveStableId("work", `SENSITIVE-${ordinal}`), externalKey: `SENSITIVE-${ordinal}`, tombstone: ordinal === 31 }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const state = { ...seeded, work: validateWorkGraph(records) };
  const before = indexOf(state);
  assert.equal(before.work.count, records.length);
  assert.equal(before.work.digest, canonicalSha256(state.work.map((record) => canonicalSha256(record))), "the independently canonicalised full record vector agrees");
  for (const record of state.work) {
    const changed = { ...state, work: state.work.map((entry) => entry.id === record.id ? { ...entry, title: "b" } : entry) };
    assert.notEqual(indexOf(changed).work.digest, before.work.digest, record.id);
  }
  for (const patch of [{ summary: "a" }, { labels: ["a"] }, { extensions: { "advisory:scope": { required: false, value: "a" } } }, { revision: 2 }]) {
    const changed = { ...state, work: state.work.map((entry, ordinal) => ordinal === 0 ? { ...entry, ...patch } : entry) };
    assert.notEqual(indexOf(changed).work.digest, before.work.digest, JSON.stringify(patch));
  }
  assert.notEqual(indexOf({ ...state, work: [...state.work].reverse() }).work.digest, before.work.digest);
  assert.equal(indexOf({ ...state, work: [...state.work].reverse().sort((left, right) => compareCanonicalText(left.id, right.id)) }).work.digest, before.work.digest);
  assert.notEqual(indexOf({ ...state, projects: state.projects.map((record) => ({ ...record, name: "Ceilingb" })) }).projects.digest, before.projects.digest);
  const budget = workspaceBudgets(state).views.find((entry) => entry.name === "index.json");
  assert.equal(budget.limitBytes, PROTOCOL_LIMITS.maxCanonicalBytes);
  assert.equal(budget.bytes, Buffer.byteLength(workspaceViewDocuments(state)["index.json"], "utf8"));
});

test("STORY-515: complete replay and every work-list page keep all records and order", async (context) => {
  const fx = await fixture(context);
  const count = 1_536;
  const state = await appendEvents(fx.root, Array.from({ length: count }, (_, ordinal) => createWorkDelta({
    projectId: fx.projectId, externalKey: `PAGED-${ordinal}`, kind: "Initiative", parentId: null, status: "active", occurredAt: AT,
  })), { occurredAt: AT });
  assert.deepEqual(await materializeWorkspaceFromGenesis(fx.root), state);
  const records = [];
  for (let offset = 0; offset < count; offset += 256) {
    let text = "";
    await runCli(["work-list", "--workspace", fx.root, "--offset", String(offset), "--limit", "256"], { write(value) { text += value; } });
    const page = JSON.parse(text);
    assert.equal(page.total, count);
    assert.equal(page.truncated, offset + page.records.length < count);
    records.push(...page.records);
  }
  assert.equal(new Set(records.map((record) => record.id)).size, count);
  assert.deepEqual(records.map((record) => record.id), state.work.map((record) => record.id));
  assert.deepEqual(records.map((record) => record.externalKey), state.work.map((record) => record.externalKey));
  let text = "";
  await runCli(["work-show", "--workspace", fx.root, "--id", state.work.at(-1).id], { write(value) { text += value; } });
  assert.equal(JSON.parse(text).record.id, state.work.at(-1).id);
});
