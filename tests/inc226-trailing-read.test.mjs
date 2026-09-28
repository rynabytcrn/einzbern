// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-226. Retrieval has to work in a workspace someone is working in.
//
// knowledge-core required the store's marker to equal the chain head exactly, and
// applied that to reads. Any event moves the head, so one governed write took the
// whole retrieval surface offline until a hand-run rebase. Measured on 2026-08-19:
// all six partitions refusing every knowledge read, and TCRN-TMS -- rebased and then
// left alone -- answering normally, which isolated the write as the cause.
//
// The exemption these criteria pin is deliberately narrow, and it is paid for: a
// trailing read is admitted, and the answer says that it trails.
//
// TCRN-CROSS-SUB-414 (MIN-235 D7) removes what the exemption worked around. A library's crest is
// no longer bound to the chain head its last write saw: every read projects it at the head it
// replays, so a chain write leaves nothing trailing. The criteria below keep their subjects and
// pin the new answers: a read answers after the chain moves, asked or not, with nothing to
// disclose; --allow-trailing is still taken and changes nothing; validate and a write are still
// held to what the chain holds, which is now each record's own chain position (a crest newer than
// its chain refuses validate), and a write records the chain it was checked against.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createKnowledgeUnit,
  createProject,
  createWork,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  readKnowledgeStoreMarker,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (day, second = 0) => `2026-08-${String(day).padStart(2, "0")}T14:00:${String(second).padStart(2, "0")}Z`;

async function emptyWorkspace(externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc226-")));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(19) });
  return { base, workspace: join(base, "workspace") };
}

// A card of the fixture's project, linked to its anchor work.
function cardInput(externalKey, subject, projectId, workId) {
  return {
    occurredAt: instant(19, 8), externalKey,
    scope: "project", projectId, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["retrieval"],
    subject, summary: `${subject}.`, snippet: `${subject}.`,
    accountableOwnerId: deriveStableId("owner", `${externalKey}-OWNER`),
    sourceReferences: [`evidence://fixture/${externalKey.toLowerCase()}`],
    sourceDigest: canonicalSha256({ key: externalKey }),
    linkedWorkIds: [workId],
    linkedDecisionIds: [deriveStableId("decision", `${externalKey}-DECISION`)],
    linkedGateIds: [deriveStableId("gate", `${externalKey}-GATE`)],
    linkedEvidenceIds: [deriveStableId("evidence", `${externalKey}-EVIDENCE`)],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(19, 5),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${subject}.`,
  };
}

// A store holding one card, and a chain that has since taken exactly one more event.
// That single event is the entire defect: nothing about the store changed.
async function storeTrailingByOneWrite() {
  const { base, workspace } = await emptyWorkspace("INC226-TRAILING");
  let state = await createProject(workspace, {
    occurredAt: instant(19, 1), externalKey: "INC226-PROJECT", name: "Retrieval",
  });
  state = await createWork(workspace, {
    occurredAt: instant(19, 2), projectId: state.projects[0].id,
    externalKey: "INC226-ANCHOR", kind: "Initiative", parentId: null, status: "active",
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  await createKnowledgeUnit(workspace, {
    occurredAt: instant(19, 3), externalKey: "INC226-CARD",
    scope: "project", projectId: state.projects[0].id, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["retrieval"],
    subject: "A card filed while the store was aligned",
    summary: "Exists so a trailing read has something to return.",
    snippet: "The store still answers after the chain moves.",
    accountableOwnerId: deriveStableId("owner", "INC226-OWNER"),
    sourceReferences: ["evidence://fixture/inc226"],
    sourceDigest: canonicalSha256({ key: "INC226-CARD" }),
    linkedWorkIds: [state.work[0].id],
    linkedDecisionIds: [deriveStableId("decision", "INC226-DECISION")],
    linkedGateIds: [deriveStableId("gate", "INC226-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "INC226-EVIDENCE")],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(19, 2),
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: "Filed before the chain advanced.",
  });
  const advanced = await createWork(workspace, {
    occurredAt: instant(19, 5), projectId: state.projects[0].id,
    externalKey: "INC226-THE-ONE-WRITE", kind: "Initiative", parentId: null, status: "active",
  });
  return { base, workspace, headEventHash: advanced.headEventHash, projectId: state.projects[0].id, workId: state.work[0].id };
}

// TCRN-CROSS-SUB-414: what used to be the refusal every session hit is gone at its root: the read
// answers after the chain advances by default, and asking for a trailing read changes nothing.
// Red leg: bind a library read to a stored high water again and the default read refuses.
test("INC-226, SUB-414: a metadata-first read answers after the chain advances, asked or not", async () => {
  const { base, workspace } = await storeTrailingByOneWrite();
  try {
    const plain = await listKnowledgeMetadata(workspace, { at: instant(19, 6), selection: "all" });
    assert.equal(plain.reasonCode, "KNOWLEDGE_LIST_READY", "the default read answers: a library's crest never trails its chain");
    assert.equal(plain.total, 1, "the card filed before the write is retrievable");
    const asked = await listKnowledgeMetadata(workspace, { at: instant(19, 6), selection: "all", allowTrailing: true });
    assert.deepEqual(asked, plain, "the flag is still taken, and changes nothing");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The disclosure existed so a stale answer could not pass for a current one. The answer is now
// current: it is projected at the chain head it read. Red leg: project the high water from a stored
// value and the marker names a head the chain has left.
test("INC-226, SUB-414: an answer after the chain advances is bound to the head it read, with nothing trailing to disclose", async () => {
  const { base, workspace, headEventHash } = await storeTrailingByOneWrite();
  try {
    for (const read of [
      () => listKnowledgeMetadata(workspace, { at: instant(19, 6), allowTrailing: true }),
      () => evaluateKnowledgeFreshness(workspace, instant(19, 6), { allowTrailing: true }),
    ]) {
      const result = await read();
      for (const key of ["knowledgeStoreTrailing", "storeHighWaterDigest", "chainHeadEventHash"]) {
        assert.equal(key in result, false, `${key}: nothing trails`);
      }
    }
    assert.equal((await readKnowledgeStoreMarker(workspace)).eventHighWaterDigest, headEventHash, "the projected high water is the chain head");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Validate keeps its job -- answering whether the crest and the chain agree -- against what now
// binds a record to the chain: the chain position its event names. Red leg: drop the chain-position
// check and a crest newer than its chain validates.
test("INC-226, SUB-414: validate answers at the advanced head, and still refuses a crest its chain does not hold, however the flag is passed", async () => {
  const { base, workspace, headEventHash, projectId, workId } = await storeTrailingByOneWrite();
  try {
    for (const options of [{}, { allowTrailing: true }]) {
      const validation = await validateKnowledgeStore(workspace, options);
      assert.deepEqual([validation.reasonCode, validation.eventHighWaterDigest], ["KNOWLEDGE_STORE_VALID", headEventHash]);
    }
    // A card written against a chain event the chain then loses (a partial restore) is newer than
    // the chain: validate refuses, naming it.
    const saved = join(base, "akasha-saved");
    await cp(join(workspace, "akasha"), saved, { recursive: true });
    await createWork(workspace, {
      occurredAt: instant(19, 7), projectId, externalKey: "INC226-LOST-WRITE", kind: "Initiative", parentId: null, status: "active",
    });
    const newer = await createKnowledgeUnit(workspace, cardInput("INC226-CARD-NEWER", "Queue depth guidance", projectId, workId));
    await rm(join(workspace, "akasha"), { recursive: true, force: true });
    await cp(saved, join(workspace, "akasha"), { recursive: true });
    for (const options of [{}, { allowTrailing: true }]) {
      await assert.rejects(
        () => validateKnowledgeStore(workspace, options),
        (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH" && error.details.awaitingChain[0].id === newer.id,
        "validate must refuse a crest newer than its chain even when handed the read-path flag",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The strict equality closed a provenance hole: a card filed against a head the store never saw.
// TCRN-CROSS-SUB-414 closes it in the record itself: a write after the chain moves lands, and its
// event names every chain stream's head it was checked against. Red leg: record no chain and the
// card cannot say which chain it was filed against.
test("INC-226, SUB-414: a write after the chain advances lands, and its event names the chain it was checked against", async () => {
  const { base, workspace, headEventHash, projectId, workId } = await storeTrailingByOneWrite();
  try {
    const created = await createKnowledgeUnit(workspace, cardInput("INC226-CARD-2", "Retry backoff guidance", projectId, workId), { allowTrailing: true });
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    const [deviceId] = await readdir(join(workspace, "crest", "events"));
    const stream = join(workspace, "crest", "events", deviceId);
    const events = await Promise.all((await readdir(stream)).filter((name) => name.endsWith(".json")).sort()
      .map(async (name) => JSON.parse(await readFile(join(stream, name), "utf8"))));
    const event = events.find((entry) => entry.metadata.id === created.id);
    const [akashaDevice] = await readdir(join(workspace, "akasha"));
    const manifest = JSON.parse(await readFile(join(workspace, "akasha", akashaDevice, "manifest.json"), "utf8"));
    assert.deepEqual(event.chain, [{ deviceId: akashaDevice, sequence: manifest.sequence, eventHash: manifest.headEventHash }]);
    assert.equal((await validateKnowledgeStore(workspace)).eventHighWaterDigest, headEventHash);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// An aligned store must answer exactly as it did before this change existed, or every
// caller reading today's response shape has to be revisited. Red leg: emit the
// disclosure unconditionally and this fails on the extra keys.
test("INC-226: an aligned read is byte-identical to what it was before the exemption", async () => {
  const { base, workspace } = await emptyWorkspace("INC226-ALIGNED");
  try {
    await createProject(workspace, {
      occurredAt: instant(19, 1), externalKey: "INC226-ALIGNED-PROJECT", name: "Aligned",
    });
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
    const plain = await listKnowledgeMetadata(workspace, { at: instant(19, 6) });
    const asked = await listKnowledgeMetadata(workspace, { at: instant(19, 6), allowTrailing: true });
    assert.deepEqual(asked, plain, "asking for trailing reads changes nothing when nothing trails");
    for (const key of ["knowledgeStoreTrailing", "storeHighWaterDigest", "chainHeadEventHash"]) {
      assert.equal(key in plain, false, `${key} must be absent when the store is current`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
