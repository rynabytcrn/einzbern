// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-232. The CLI is the only transport a governed session has, and until
// now nothing asserted that --allow-trailing survives the trip through it.
//
// INC-226 added the flag to five read verbs: the core behaviour was pinned, the catalog
// entry was pinned, and the wiring between them -- five hand-written argument lists and
// five hand-written option objects -- was not. A flag parsed but not threaded, or
// threaded into the wrong verb, produces the exact refusal INC-226 exists to remove,
// and every existing criterion stays green.
//
// The snippet and body reads are here for a second reason. They were given the
// exemption and the disclosure with no criterion on either, so a stale BODY -- the one
// read that returns content rather than metadata -- could have passed for a current one.
//
// TCRN-CROSS-SUB-414 (MIN-235 D7): a library's crest no longer trails its chain -- every read
// projects it at the head it replays -- so these verbs answer after a chain write by default. The
// flag must still survive the trip: every verb the catalog says takes it still takes it, and
// answers exactly as it does without it. The checkpoint keeps the strict rule, now over each
// record's chain position: it refuses a crest newer than its chain, however the flag is passed.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  createKnowledgeUnit,
  createProject,
  createWork,
  initializeKnowledgeStore,
  initializeLibrary,
  readKnowledgeBody,
  readKnowledgeSnippet,
} from "../dist/build/packages/core/src/index.js";
import { canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const instant = (second = 0) => `2026-08-19T15:00:${String(second).padStart(2, "0")}Z`;

// A store holding one promoted card, and a chain that has taken one further event since.
async function trailingFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc232-")));
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant() });
  const workspace = join(base, "workspace");
  let state = await createProject(workspace, {
    occurredAt: instant(1), externalKey: "INC232-PROJECT", name: "Transport",
  });
  state = await createWork(workspace, {
    occurredAt: instant(2), projectId: state.projects[0].id,
    externalKey: "INC232-ANCHOR", kind: "Initiative", parentId: null, status: "active",
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  const created = await createKnowledgeUnit(workspace, {
    occurredAt: instant(3), externalKey: "INC232-CARD",
    scope: "project", projectId: state.projects[0].id, roleScopes: [],
    category: "workflow", kind: "guide", tags: ["transport"],
    subject: "A card that outlives the head it was filed against",
    summary: "Filed while aligned, read after the chain moved on.",
    snippet: "The transport must carry the flag, and the answer must carry the staleness.",
    accountableOwnerId: deriveStableId("owner", "INC232-OWNER"),
    sourceReferences: ["evidence://fixture/inc232"],
    sourceDigest: canonicalSha256({ key: "INC232-CARD" }),
    linkedWorkIds: [state.work[0].id],
    linkedDecisionIds: [deriveStableId("decision", "INC232-DECISION")],
    linkedGateIds: [deriveStableId("gate", "INC232-GATE")],
    linkedEvidenceIds: [deriveStableId("evidence", "INC232-EVIDENCE")],
    lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh",
    lastVerified: instant(2),
    stalenessPolicy: { maximumAgeDays: 3650, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: "Body bytes that must not pass for current ones.",
  });
  const id = String(created.id);
  // Left as a candidate on purpose: the reads under test either take selection "all" or
  // an explicit allow-unpromoted, so promotion would add a dependency this criterion does
  // not need and whose own rules would then be able to fail it for unrelated reasons.
  // The one event that puts the store behind. Nothing about the store changes.
  await createWork(workspace, {
    occurredAt: instant(6), projectId: state.projects[0].id,
    externalKey: "INC232-THE-ONE-WRITE", kind: "Initiative", parentId: null, status: "active",
  });
  return { base, workspace, id };
}

function capture() {
  const chunks = [];
  return { io: { write: (text) => chunks.push(text) }, text: () => chunks.join("") };
}

async function cli(argv) {
  const out = capture();
  try {
    await runCli(argv, out.io);
    return { ok: true, value: JSON.parse(out.text()) };
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode ?? String(error) };
  }
}

// Red leg: drop the flag from any one verb's parseArguments list and exactly that verb comes back
// CLI_ARGUMENT_UNKNOWN here; bind a library read to a stored high water again and the plain
// invocation refuses.
test("INC-232, SUB-414: every read verb the catalog says takes --allow-trailing takes it, and answers as it does without it", async () => {
  const { base, workspace, id } = await trailingFixture();
  try {
    const invocations = [
      ["knowledge-list", "--workspace", workspace, "--at", instant(7), "--selection", "all"],
      ["knowledge-freshness", "--workspace", workspace, "--at", instant(7)],
      ["knowledge-snippet", "--workspace", workspace, "--id", id],
      // --allow-unpromoted went with the promotion step (TCRN-CROSS-STORY-476 R1): every card is
      // written readable, so the body read needs no flag to open it.
      ["knowledge-body", "--workspace", workspace, "--id", id, "--at", instant(7)],
    ];
    for (const argv of invocations) {
      const plain = await cli(argv);
      assert.equal(plain.ok, true, `${argv[0]} answers after the chain moved: ${plain.reasonCode}`);
      const flagged = await cli([...argv, "--allow-trailing", "true"]);
      assert.equal(flagged.ok, true, `${argv[0]} still takes the flag: ${flagged.reasonCode}`);
      assert.deepEqual(flagged.value, plain.value, `${argv[0]}: the flag changes nothing`);
      assert.equal("knowledgeStoreTrailing" in plain.value, false, `${argv[0]}: nothing trails`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// The two content-bearing reads: after the chain moved, the snippet and the body answer the card
// as it is, with nothing to disclose. Red leg: disclose a trailing store that is not trailing and
// every consumer that branches on the flag treats a current answer as stale.
test("INC-232, SUB-414: a snippet and a body after the chain moves answer the card as it is, with nothing trailing", async () => {
  const { base, workspace, id } = await trailingFixture();
  try {
    const snippet = await readKnowledgeSnippet(workspace, id, { allowTrailing: true });
    assert.equal(snippet.subject, "A card that outlives the head it was filed against");
    assert.equal("knowledgeStoreTrailing" in snippet, false);
    const body = await readKnowledgeBody(workspace, id, { at: instant(7), allowTrailing: true, allowUnpromoted: true });
    assert.equal(body.body, "Body bytes that must not pass for current ones.");
    assert.equal("knowledgeStoreTrailing" in body, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Red leg: let the checkpoint answer for a crest its chain does not hold. The checkpoint is the
// export artifact and must not be stale-able; after a chain write it is taken at the new head, and
// a crest newer than its chain (a partial restore) refuses it, the flag passed or not.
test("INC-232, SUB-414: a checkpoint is taken at the current head, and refuses a crest newer than its chain however the flag is passed", async () => {
  const { base, workspace, id } = await trailingFixture();
  try {
    const { exportKnowledgeCheckpoint, createWork, validateWorkspace } = await import("../dist/build/packages/core/src/index.js");
    const head = (await validateWorkspace(workspace)).headEventHash;
    for (const options of [{}, { allowTrailing: true }]) {
      const checkpoint = JSON.parse(await exportKnowledgeCheckpoint(workspace, instant(7), options));
      assert.deepEqual([checkpoint.eventHighWaterDigest, checkpoint.records.map((record) => record.id)], [head, [id]]);
    }
    const saved = join(base, "akasha-saved");
    await cp(join(workspace, "akasha"), saved, { recursive: true });
    const state = await validateWorkspace(workspace);
    await createWork(workspace, {
      occurredAt: instant(8), projectId: state.projects[0].id,
      externalKey: "INC232-LOST-WRITE", kind: "Initiative", parentId: null, status: "active",
    });
    await createKnowledgeUnit(workspace, {
      occurredAt: instant(9), externalKey: "INC232-CARD-NEWER",
      scope: "workspace", projectId: null, roleScopes: [],
      category: "workflow", kind: "fact", tags: ["transport"],
      subject: "Restore drill outcome", summary: "Newer than the chain.", snippet: "Newer than the chain.",
      accountableOwnerId: deriveStableId("owner", "INC232-OWNER-NEWER"),
      sourceReferences: [], sourceDigest: null, linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [],
      lifecycle: "active", retrievalDisposition: "default", freshnessState: "fresh", lastVerified: null,
      stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
      exportDisposition: "metadata-only", body: "Newer than the chain.",
    });
    await rm(join(workspace, "akasha"), { recursive: true, force: true });
    await cp(saved, join(workspace, "akasha"), { recursive: true });
    for (const options of [{}, { allowTrailing: true }]) {
      await assert.rejects(
        () => exportKnowledgeCheckpoint(workspace, instant(10), options),
        (error) => error?.reasonCode === "KNOWLEDGE_HIGH_WATER_MISMATCH",
        "an export artifact takes the strict rule, not a label",
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
