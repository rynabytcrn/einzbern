// SPDX-License-Identifier: Apache-2.0
//
// Knowledge-batch: N cards, one invocation.
//
// The measured case this exists for: filing four cards on 2026-08-19 took sixteen CLI
// round trips -- per card a version read, the write, a receipt read, plus the rebase any
// intervening chain write forces. One batch is one invocation with the rebase folded in.
//
// The deliberate difference from work-batch, which these criteria pin rather than hide:
// this batch is per-member atomic, not all-or-nothing. The store is a disposable,
// rebuildable projection and every member keeps the per-mutation atomicity the knowledge
// verbs have always had, so a mid-batch failure leaves the earlier members applied -- and
// the refusal must say exactly which, or partiality becomes a silent lie.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyKnowledgeBatch,
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const at = (second = 0) => `2026-08-19T22:00:${String(second).padStart(2, "0")}Z`;

async function workspaceWithStore() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-kbatch-")));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: at(0) });
  const root = join(base, "workspace");
  let state = await createProject(root, { occurredAt: at(1), externalKey: "KBATCH-P", name: "KBatch" });
  await initializeKnowledgeStore(root, { disposableAcknowledged: true });
  return { base, root, projectId: state.projects[0].id, chainVersion: state.version };
}

const card = (fixture, n, overrides = {}) => ({
  verb: "knowledge-create",
  externalKey: `KB-CARD-${n}`,
  scope: "project", projectId: fixture.projectId, roleScopes: [],
  // TCRN-CROSS-INC-282, TCRN-CROSS-SUB-308: every card is written active,
  // whatever its kind; there is no candidate to write or promote member to move one.
  category: "workflow", kind: "guide", tags: ["batch"],
  subject: `Card ${n} subject`, summary: `Card ${n} summary.`, snippet: `Card ${n} snippet.`,
  accountableOwnerId: deriveStableId("owner", "KB-OWNER"),
  sourceReferences: [`evidence://kb/${n}`], sourceDigest: canonicalSha256({ n }),
  linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [],
  linkedEvidenceIds: [deriveStableId("evidence", `KB-EV-${n}`)],
  lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
  lastVerified: at(1), stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" },
  exportDisposition: "metadata-only", body: `Card ${n} body.`,
  // TCRN-CROSS-STORY-365: the batch's four cards differ only by number, so each scores
  // as a possible duplicate of the last. A batch is one authored set; it says so here.
  coexist: true,
  ...overrides,
});

const batch = (members) => ({ schemaVersion: "tcrn.knowledge-batch.v1", members });

const refusal = async (operation) => {
  try {
    await operation();
    return null;
  } catch (error) {
    return { reasonCode: error?.reasonCode, payload: JSON.parse(error.message) };
  }
};

// The motivating case, whole: a chain write has moved the head (the normal state of a
// workspace being worked in), and one invocation aligns, files four cards and re-verifies
// one. TCRN-CROSS-SUB-414: the alignment is now the rebase's re-validation, which writes
// nothing -- the next case shows the batch needs none.
test("knowledge-batch: align, four cards and a reverify in one act", async () => {
  const fixture = await workspaceWithStore();
  try {
    // An Initiative: a new Incident is refused once Incident folds into Story (TCRN-CROSS-SUB-297).
    await createWork(fixture.root, {
      occurredAt: at(2), projectId: fixture.projectId,
      externalKey: "KBATCH-W", kind: "Initiative", parentId: null, status: "active",
    });
    const result = await applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1), card(fixture, 2), card(fixture, 3), card(fixture, 4),
      { verb: "knowledge-reverify", externalKey: "KB-CARD-1" },
    ]), { occurredAt: at(3), alignFirst: true });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    assert.equal(result.aligned, true);
    assert.equal(result.applied.length, 6, "the rebase and all five members are receipted");
    const all = await listKnowledgeMetadata(fixture.root, { at: at(4), selection: "all", allowTrailing: true });
    assert.equal(all.total, 4);
    // All four are written active without the retired promotion marker. What proves the
    // reverify member touched only the card it named is the revision: card 1 was written and then moved.
    const byKey = new Map(all.records.map((record) => [record.externalKey, record]));
    assert.deepEqual([...byKey.values()].map((record) => record.lifecycle), Array(4).fill("active"));
    assert.equal([...byKey.values()].some((record) => Object.hasOwn(record, "promotionState")), false);
    assert.equal(byKey.get("KB-CARD-1").revision, 2, "the reverify saw the card its predecessor created and moved it");
    assert.deepEqual(["KB-CARD-2", "KB-CARD-3", "KB-CARD-4"].map((key) => byKey.get(key).revision),
      [1, 1, 1], "and left the three it did not name at their written revision");
    const answered = await listKnowledgeMetadata(fixture.root, { at: at(4), allowTrailing: true });
    assert.equal(answered.total, 4, "default recall answers for all four from the write");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// TCRN-CROSS-SUB-414 (MIN-235 D7): a chain write no longer leaves the crest behind, so a batch
// after one lands with no alignment; its members append to this device's stream, one event per
// record written, and the crest's root manifest is the bytes initialization wrote. Red leg: rebind
// the crest after the chain write or in the batch and store.json changes.
test("knowledge-batch, SUB-414: after a chain write a batch lands unaligned, appends one event per record, and leaves store.json alone", async () => {
  const fixture = await workspaceWithStore();
  try {
    const store = join(fixture.root, "crest");
    const manifest = await readFile(join(store, "store.json"));
    await createWork(fixture.root, {
      occurredAt: at(2), projectId: fixture.projectId,
      externalKey: "KBATCH-W2", kind: "Initiative", parentId: null, status: "active",
    });
    const result = await applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1), card(fixture, 2),
      { verb: "knowledge-reverify", externalKey: "KB-CARD-1" },
      { verb: "knowledge-policy", externalKey: "KB-CARD-2", stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" } },
    ]), { occurredAt: at(3) });
    assert.deepEqual([result.reasonCode, result.aligned, result.version], ["KNOWLEDGE_BATCH_APPLIED", false, 4]);
    assert.deepEqual(await readFile(join(store, "store.json")), manifest, "the batch wrote no root manifest");
    assert.deepEqual((await readdir(store)).sort(), ["events", "store.json"], "and took no claim");
    const [deviceId] = await readdir(join(store, "events"));
    const events = (await readdir(join(store, "events", deviceId))).filter((name) => name.endsWith(".json"));
    assert.equal(events.length, 4, "one event per record the members wrote");
    const aligned = await applyKnowledgeBatch(fixture.root, batch([card(fixture, 3)]), { occurredAt: at(4), alignFirst: true });
    assert.deepEqual(aligned.applied[0], { verb: "knowledge-rebase", reasonCode: "KNOWLEDGE_STORE_REBASED", version: 4 }, "the alignment re-validates and advances nothing");
    assert.deepEqual(await readFile(join(store, "store.json")), manifest);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// The store version is threaded internally -- the caller supplies it once. Red leg: stop
// threading and member two refuses KNOWLEDGE_CAS_MISMATCH against a version that moved.
test("knowledge-batch: the caller reads the store version once, however many members follow", async () => {
  const fixture = await workspaceWithStore();
  try {
    const result = await applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1), card(fixture, 2), card(fixture, 3),
    ]), { occurredAt: at(2) });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    assert.equal(result.version, 3, "three mutations from the version supplied once");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Partiality is the designed trade, and the refusal must report it structurally: what
// landed (it stays landed), what failed (with the member's own reason code), what was
// never judged. Red leg: report only the failure and the two applied cards become
// invisible -- a partial batch wearing an all-or-nothing refusal's clothes.
test("knowledge-batch: a mid-batch failure names what landed, what failed, and what was never judged", async () => {
  const fixture = await workspaceWithStore();
  try {
    const result = await refusal(() => applyKnowledgeBatch(fixture.root, batch([
      card(fixture, 1),
      card(fixture, 2),
      { ...card(fixture, 1), externalKey: "KB-CARD-1" }, // duplicate: fails on its own terms
      card(fixture, 4),
    ]), { occurredAt: at(2) }));
    assert.equal(result.reasonCode, "WORK_BATCH_REFUSED");
    assert.equal(result.payload.stage, "apply");
    assert.equal(result.payload.applied.length, 2, "the two cards that landed are receipted");
    assert.equal(result.payload.failed.index, 2);
    assert.match(result.payload.failed.reasonCode, /KNOWLEDGE/u, "the member's own reason code survives");
    assert.deepEqual(result.payload.notEvaluated, [3]);
    // And the store is not damaged by the partial batch: it validates, and holds
    // exactly the applied members.
    await validateKnowledgeStore(fixture.root);
    const all = await listKnowledgeMetadata(fixture.root, { at: at(3), selection: "all" });
    assert.equal(all.total, 2);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: skip the stateless pass and five malformed members cost five round trips to
// discover -- the ceremony this verb exists to remove, reappearing in its refusal path.
test("knowledge-batch: every shape problem is reported at once, before any mutation", async () => {
  const fixture = await workspaceWithStore();
  try {
    const result = await refusal(() => applyKnowledgeBatch(fixture.root, batch([
      { verb: "knowledge-invent" },
      { verb: "knowledge-create", externalKey: "KB-X" },
      { verb: "knowledge-promote", externalKey: "KB-X", state: "promoted" },
      { verb: "knowledge-reverify" },
      { verb: "knowledge-retire", externalKey: "KB-X" },
    ]), { occurredAt: at(2) }));
    assert.equal(result.payload.stage, "shape");
    assert.deepEqual([...new Set(result.payload.problems.map((problem) => problem.index))], [0, 1, 2, 3, 4]);
    const rules = new Set(result.payload.problems.map((problem) => problem.rule));
    for (const rule of ["verb-known", "field-required", "reference-required"]) {
      assert.ok(rules.has(rule), `${rule} is reported`);
    }
    // TCRN-CROSS-SUB-308: the promote and retire members are gone with their verbs.
    assert.deepEqual(result.payload.problems.filter((problem) => problem.index === 2 || problem.index === 4).map((problem) => problem.rule),
      ["verb-known", "verb-known"], "promote and retire members are unknown verbs");
    const untouched = await listKnowledgeMetadata(fixture.root, { at: at(3), selection: "all" });
    assert.equal(untouched.total, 0, "no mutation ran");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// A member acting on a card the batch did not touch must carry expectedRevision: the
// batch can only vouch for revisions it observed. Red leg: default to revision 1 and a
// twice-revised card is mutated against a stale revision the caller never stated.
test("knowledge-batch: acting on an untouched card demands an explicit revision", async () => {
  const fixture = await workspaceWithStore();
  try {
    await applyKnowledgeBatch(fixture.root, batch([card(fixture, 1)]), { occurredAt: at(2) });
    const result = await refusal(() => applyKnowledgeBatch(fixture.root, batch([
      { verb: "knowledge-reverify", externalKey: "KB-CARD-1" },
    ]), { occurredAt: at(3) }));
    assert.equal(result.payload.failed.reasonCode, "KNOWLEDGE_CAS_MISMATCH");
    assert.match(result.payload.failed.detail, /expectedRevision is required/u);
    const explicit = await applyKnowledgeBatch(fixture.root, batch([
      { verb: "knowledge-reverify", externalKey: "KB-CARD-1", expectedRevision: 1 },
    ]), { occurredAt: at(4) });
    assert.equal(explicit.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

// Red leg: accept a foreign or empty document and a caller holds a receipt for nothing.
test("knowledge-batch: a batch that is not a batch is refused whole", async () => {
  const fixture = await workspaceWithStore();
  try {
    for (const document of [null, [], {}, { schemaVersion: "tcrn.knowledge-batch.v1", members: [] }, { schemaVersion: "other", members: [{}] }]) {
      await assert.rejects(
        () => applyKnowledgeBatch(fixture.root, document, { occurredAt: at(2) }),
        (error) => error?.reasonCode === "WORK_BATCH_MALFORMED",
        JSON.stringify(document),
      );
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
