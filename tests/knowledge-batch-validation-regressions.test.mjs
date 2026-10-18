// SPDX-License-Identifier: Apache-2.0

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyKnowledgeBatch, createProject, initializeKnowledgeStore, initializeLibrary,
  listKnowledgeMetadata,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const occurredAt = "2026-10-18T00:00:00Z";
const batch = (members) => ({ schemaVersion: "tcrn.knowledge-batch.v1", members });
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "knowledge-batch-validation-")));
  const root = join(base, "library");
  await initializeLibrary({ root, createdAt: occurredAt });
  const state = await createProject(root, { occurredAt, externalKey: "VALIDATION-P", name: "Validation" });
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  return { base, root, projectId: state.projects[0].id };
}
async function fileBytes(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileBytes(root, relative));
    else result[relative] = (await readFile(join(root, relative))).toString("base64");
  }
  return result;
}
async function refusal(operation) {
  let caught;
  try { await operation(); } catch (error) { caught = error; }
  assert.equal(caught?.reasonCode, "WORK_BATCH_REFUSED");
  return JSON.parse(caught.message);
}

for (const verb of ["knowledge-reverify", "knowledge-policy"]) {
  test(`knowledge batch: ${verb} key semantics do not interrupt shape aggregation`, async () => {
    const f = await fixture();
    try {
      const before = await fileBytes(f.root);
      const result = await refusal(() => applyKnowledgeBatch(f.root, batch([
        { verb, externalKey: "bad key", stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" } },
        { verb: "knowledge-reverify" },
        { verb: "unknown" },
        { verb: "knowledge-create", externalKey: "VALIDATION-C" },
      ]), { occurredAt }));
      assert.equal(result.stage, "shape");
      assert.deepEqual([...new Set(result.problems.map((problem) => problem.index))], [1, 2, 3]);
      assert.deepEqual(await fileBytes(f.root), before, "shape refusal must not mutate the store or chain");
    } finally { await rm(f.base, { recursive: true, force: true }); }
  });

  test(`knowledge batch: malformed ${verb} key carries a structured apply refusal`, async () => {
    const f = await fixture();
    try {
      const before = await fileBytes(f.root);
      const result = await refusal(() => applyKnowledgeBatch(f.root, batch([
        { verb, externalKey: "bad key", expectedRevision: 1, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" } },
        { verb: "knowledge-reverify", id: "knowledge:later", expectedRevision: 1 },
      ]), { occurredAt }));
      assert.equal(result.stage, "apply");
      assert.deepEqual(result.applied, []);
      assert.deepEqual(result.notEvaluated, [1]);
      assert.equal(result.failed.index, 0);
      assert.equal(result.failed.verb, verb);
      assert.equal(result.failed.reasonCode, "EXTERNAL_KEY_INVALID");
      assert.deepEqual(await fileBytes(f.root), before);
    } finally { await rm(f.base, { recursive: true, force: true }); }
  });
}

test("knowledge batch: malformed key preserves earlier successful member receipt", async () => {
  const f = await fixture();
  try {
    const result = await refusal(() => applyKnowledgeBatch(f.root, batch([
      {
        verb: "knowledge-create", externalKey: "VALIDATION-CARD", scope: "project", projectId: f.projectId,
        roleScopes: [], category: "workflow", kind: "guide", tags: ["batch"],
        subject: "Validation card", summary: "Validation summary.", snippet: "Validation snippet.", body: "Validation body.",
        accountableOwnerId: deriveStableId("owner", "VALIDATION-OWNER"),
        sourceReferences: ["evidence://validation/card"], sourceDigest: canonicalSha256({ card: 1 }),
        linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
        linkedEvidenceIds: [deriveStableId("evidence", "VALIDATION-EV")],
        lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh", lastVerified: occurredAt,
        stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" }, exportDisposition: "metadata-only",
      },
      { verb: "knowledge-reverify", externalKey: "bad key", expectedRevision: 1 },
      { verb: "knowledge-reverify", externalKey: "VALIDATION-CARD" },
    ]), { occurredAt }));
    assert.equal(result.stage, "apply");
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].index, 0);
    assert.equal(result.applied[0].id, deriveStableId("knowledge", "VALIDATION-CARD"));
    assert.equal(result.failed.index, 1);
    assert.equal(result.failed.reasonCode, "EXTERNAL_KEY_INVALID");
    assert.deepEqual(result.notEvaluated, [2]);
    const readback = await listKnowledgeMetadata(f.root, { at: occurredAt, selection: "all" });
    assert.equal(readback.total, 1);
    assert.equal(readback.records[0].revision, 1);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
