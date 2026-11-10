// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeLibrary, createProject, initializeKnowledgeStore, createKnowledgeUnit } from "../dist/build/packages/core/src/index.js";
import { readRecallAuthority, recallAuthorityState } from "../dist/build/packages/core/src/recall-authority.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import { withRecallObservation } from "../dist/build/packages/core/src/recall-observation.js";

test("645: opaque request authority reuses one raw read and rejects fabricated/other-root evidence", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "recall-authority-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "one");
  const other = join(base, "two");
  const at = "2026-11-10T12:00:00Z";
  await initializeLibrary({ root, createdAt: at });
  await initializeLibrary({ root: other, createdAt: at });
  await createProject(root, { occurredAt: at, externalKey: "AUTHORITY-PROJECT", name: "Authority project" });
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  await createKnowledgeUnit(root, { externalKey: "AUTHORITY-LESSON", scope: "workspace", projectId: null,
    roleScopes: [], category: "implementation", kind: "fact", subject: "Measured alloy calibration", summary: "A measured calibration", snippet: "Read calibration evidence", tags: ["calibration"], sourceReferences: [], sourceDigest: null, linkedEvidenceIds: [], linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null, exportDisposition: "metadata-only", accountableOwnerId: "owner:000000000000000000000001",
    body: "The calibrated copper assembly measured seventeen units.", lifecycle: "active", occurredAt: at,
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" } });
  const observed = await withRecallObservation(async () => {
    const { state, authority } = await readRecallAuthority(root);
    assert.equal(await recallAuthorityState(root, authority), state);
    await assert.rejects(recallAuthorityState(other, authority), { reasonCode: "KNOWLEDGE_PATH_INVALID" });
    await assert.rejects(recallAuthorityState(root, state), { reasonCode: "KNOWLEDGE_PATH_INVALID" });
    await assert.rejects(recallAuthorityState(root, { ...state, configurationProjectId: "project:x" }), { reasonCode: "KNOWLEDGE_PATH_INVALID" });
    return readRecallCards(root, { at }, authority);
  });
  const baseline = await readRecallCards(root, { at });
  assert.deepEqual(observed.value, baseline);
  assert.ok(baseline.cards.some(card => card.externalKey === "AUTHORITY-LESSON"));
  assert.equal(observed.observation.materializations, 1);
  assert.equal(observed.observation.recallCalls, 0);
  assert.equal(JSON.stringify(observed.observation).includes("prompt"), false);
});
