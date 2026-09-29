// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-256 — migrate existing knowledge policies through one batch.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyKnowledgeBatch,
  createKnowledgeUnit,
  createProject,
  createWork,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  validateKnowledgeStore,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-02T00:00:${String(second).padStart(2, "0")}Z`;

// TCRN-CROSS-SUB-414: this engine writes a library's cards as events in each device's stream,
// crest/events/<device id>/. A crest an engine before event streams wrote held one metadata file and
// one body file per card instead, its marker's version counting the writes; this lays the crest down
// that way, every record as the streams hold it now, and takes the streams away.
async function asOlderEngineCrest(workspace) {
  const store = join(workspace, DIRECTORY.knowledge);
  const all = await listKnowledgeMetadata(workspace, { at: "2099-01-01T00:00:00Z", selection: "all", limit: 1_000_000 });
  const marker = await readKnowledgeStoreMarker(workspace);
  const [deviceId] = await readdir(join(store, "events"));
  const stream = join(store, "events", deviceId);
  const bodies = new Map();
  for (const name of (await readdir(stream)).filter((entry) => entry.endsWith(".body"))) bodies.set(name.slice(9, -5), await readFile(join(stream, name)));
  await mkdir(join(store, "metadata"));
  await mkdir(join(store, "bodies"));
  for (const record of all.records) {
    await writeFile(join(store, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(store, "bodies", `${record.id}.body`), bodies.get(record.bodySha256));
  }
  const storeJson = join(store, "store.json");
  await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rm(join(store, "events"), { recursive: true });
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc256-")));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(1) });
  let project;
  let work;
  project = await createProject(workspace, {
    occurredAt: instant(3), externalKey: "INC-256-PROJECT", name: "INC-256",
  });
  // An Initiative: a new Incident is refused once Incident folds into Story (TCRN-CROSS-SUB-297).
  work = await createWork(workspace, {
    occurredAt: instant(4), projectId: project.projects[0].id,
    externalKey: "INC-256-WORK", kind: "Initiative", parentId: null, status: "active",
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, projectId: project.projects[0].id, workId: work.work.find((record) => record.externalKey === "INC-256-WORK").id };
}

function card(fx, key, kind, expectedVersion) {
  return {
    expectedVersion,
    occurredAt: instant(5),
    externalKey: key,
    scope: "project",
    projectId: fx.projectId,
    roleScopes: [],
    category: "workflow",
    kind,
    tags: ["inc256", "long-term"],
    subject: `${kind} ${key}`,
    summary: `Existing ${kind} knowledge that must not expire.`,
    snippet: `INC-256 ${kind} card`,
    accountableOwnerId: deriveStableId("owner", "INC-256-OWNER"),
    sourceReferences: [`evidence://inc256/${key}`],
    sourceDigest: canonicalSha256({ key }),
    linkedWorkIds: [fx.workId],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: [deriveStableId("evidence", `INC-256-${key}`)],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: instant(1),
    stalenessPolicy: { maximumAgeDays: 180, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: `Body for ${key}.`,
    // TCRN-CROSS-STORY-365: four cards whose subjects differ by kind name only.
    coexist: true,
  };
}

const policyBatch = (members) => ({ schemaVersion: "tcrn.knowledge-batch.v1", members });

test("INC-256 knowledge-batch migrates all existing cards to no expiry and preserves retrieval", async () => {
  const fx = await fixture();
  try {
    let version = 0;
    const created = [];
    for (const kind of ["fact", "guide", "decision", "reference"]) {
      const result = await createKnowledgeUnit(fx.workspace, card(fx, `CARD-${kind}`, kind, version));
      version = result.version;
      // Every kind is written active; the receipt omits the retired promotion marker.
      assert.equal(Object.hasOwn(result, "promotionState"), false, kind);
      created.push({ id: result.id, revision: result.revision, kind });
    }
    const before = await listKnowledgeMetadata(fx.workspace, { at: instant(6), selection: "all" });
    assert.equal(before.total, 4);
    assert.deepEqual(before.records.map((record) => record.stalenessPolicy.maximumAgeDays), [180, 180, 180, 180]);
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");

    const result = await applyKnowledgeBatch(fx.workspace, policyBatch(created.map((record) => ({
      verb: "knowledge-policy",
      id: record.id,
      expectedRevision: record.revision,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    }))), { occurredAt: instant(7) });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    assert.equal(result.members, 4);
    assert.equal(result.applied.length, 4);

    const after = await listKnowledgeMetadata(fx.workspace, { at: instant(8), selection: "all" });
    assert.equal(after.total, before.total, "migration does not add or remove records");
    assert.deepEqual(after.records.map((record) => record.stalenessPolicy.maximumAgeDays), [null, null, null, null]);
    assert.deepEqual(after.records.map((record) => record.subject), before.records.map((record) => record.subject));
    const future = await evaluateKnowledgeFreshness(fx.workspace, "2027-06-01T00:00:00Z");
    assert.deepEqual(future.records.map((record) => record.state), ["fresh", "fresh", "fresh", "fresh"]);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: "2027-06-01T00:00:00Z" })).total, 4, "isDefaultSelectable remains true");
    assert.equal((await validateKnowledgeStore(fx.workspace)).records, 4);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("INC-256 malformed policy red leg refuses the batch before any migration", async () => {
  const fx = await fixture();
  try {
    const created = await createKnowledgeUnit(fx.workspace, card(fx, "CARD-RED", "fact", 0));
    await assert.rejects(
      applyKnowledgeBatch(fx.workspace, policyBatch([{ verb: "knowledge-policy", id: created.id, expectedRevision: 1 }]), {
        occurredAt: instant(7),
      }),
      (error) => error?.reasonCode === "WORK_BATCH_REFUSED",
    );
    const unchanged = await listKnowledgeMetadata(fx.workspace, { at: instant(8), selection: "all" });
    assert.equal(unchanged.records[0].stalenessPolicy.maximumAgeDays, 180);
    assert.equal((await validateKnowledgeStore(fx.workspace)).version, 1);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test("INC-256 policy migration also updates retired metadata without requiring a body", async () => {
  const fx = await fixture();
  try {
    // TCRN-CROSS-SUB-308: nothing retires a card by hand now, so the retired record is laid
    // down the way an older engine's knowledge-retire left it: the next revision, lifecycle
    // "retired", and the body reclaimed.
    const created = await createKnowledgeUnit(fx.workspace, card(fx, "CARD-RETIRED", "guide", 0));
    await asOlderEngineCrest(fx.workspace);
    const store = join(fx.workspace, DIRECTORY.knowledge);
    const metadataPath = join(store, "metadata", `${created.id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(metadataPath, canonicalJson({ ...metadata, lifecycle: "retired", revision: created.revision + 1, updatedAt: instant(7) }));
    await rm(join(store, "bodies", `${created.id}.body`));
    const result = await applyKnowledgeBatch(fx.workspace, policyBatch([{
      verb: "knowledge-policy", id: created.id, expectedRevision: 2,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    }]), { occurredAt: instant(8) });
    assert.equal(result.reasonCode, "KNOWLEDGE_BATCH_APPLIED");
    const retired = (await listKnowledgeMetadata(fx.workspace, { at: instant(9), selection: "all" })).records.find((record) => record.id === created.id);
    assert.equal(retired.lifecycle, "retired");
    assert.equal(retired.stalenessPolicy.maximumAgeDays, null);
    assert.equal((await validateKnowledgeStore(fx.workspace)).records, 1);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});
