// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-365 — capture and write-time conflict scoring.
//
// The Stop-hook write and its lesson extraction are retired with the capture hook
// (TCRN-CROSS-STORY-467 R3); the capture verb and the core write path stay, and those
// are what the cases below exercise.
//
// Owner ruling TCRN-CROSS-MIN-146 is the behaviour under test: a small card is official
// the moment it is written. Every case below therefore asserts the WRITTEN state, never a
// promotion step — and the last case asserts that nothing this Story writes lands as a
// candidate, which is the ruling stated as a machine check rather than as prose.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  KNOWLEDGE_CONFLICT_SCORE_THRESHOLD,
  captureKnowledgeUnit,
  createProject,
  initializeKnowledgeStore,
  initializeLibrary,
  knowledgeConflictHits,
  knowledgeRelevanceScore,
  listKnowledgeMetadata,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const instant = (day, second = 0) => `2026-09-${String(day).padStart(2, "0")}T09:00:${String(second).padStart(2, "0")}Z`;
const OWNER = "owner:agent-session";

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

/**
 * A throwaway platform container with one governed workspace in the cross-project
 * partition, the path shape a governed container has in production.
 */
async function containerFixture(externalKey = "FIXTURE-CAPTURE") {
  const container = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s365-")));
  const base = join(container, ".tcrn-workspace", "cross-project");
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: join(base, "workspace"), createdAt: instant(1) });
  await createProject(workspace, {
    occurredAt: instant(1, 1), externalKey: "FIXTURE-CAPTURE-PROJECT", name: "Capture Fixture",
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { container, workspace, close: () => rm(container, { recursive: true, force: true }) };
}

function lessonCard(subject, overrides = {}) {
  return {
    occurredAt: instant(2), subject, summary: `${subject} 的完整说明`, snippet: `${subject} 摘录`,
    tags: ["lesson"], accountableOwnerId: OWNER, body: `${subject} 正文`, ...overrides,
  };
}

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("STORY-365 GWT2/GWT3: the same subject twice is scored, refused, and released by supersedes", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-CONFLICT");
  try {
    const subject = "guard-check 运行期间不要并发编辑";
    const first = await captureKnowledgeUnit(fixture.workspace, lessonCard(subject), { allowTrailing: true });
    assert.equal(Object.hasOwn(first, "promotionState"), false);

    const refusal = await captureKnowledgeUnit(fixture.workspace, lessonCard(subject, { body: "第二次写入" }), { allowTrailing: true })
      .then(() => null, (error) => error);
    assert.equal(refusal?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "the same subject twice is a possible conflict");
    assert.deepEqual(refusal.details.conflicts, [first.id], "the refusal hands back the hit list, not just a verdict");

    const replacement = await captureKnowledgeUnit(
      fixture.workspace,
      lessonCard(subject, { body: "第二次写入", supersedes: first.id }),
      { allowTrailing: true },
    );
    assert.equal(replacement.superseded, first.id, "the receipt names what was replaced");
    const all = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), status: "removed", allowTrailing: true });
    const replaced = all.records.find((record) => record.id === first.id);
    assert.deepEqual([replaced.status, replaced.removal.reason, replaced.removal.supersededBy], ["removed", "superseded", replacement.id], "the replaced card is removed, superseded by the new one");
    assert.deepEqual([Object.hasOwn(replaced, "summary"), Object.hasOwn(replaced, "snippet")], [false, false], "and keeps no summary or snippet");
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true });
    assert.deepEqual(listed.records.map((record) => record.id), [replacement.id], "default recall answers with one of them");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 coexist admits the write and records what it stands beside", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-COEXIST");
  try {
    const subject = "策略 JSON 按键定位 不按行号";
    const first = await captureKnowledgeUnit(fixture.workspace, lessonCard(subject), { allowTrailing: true });
    const second = await captureKnowledgeUnit(
      fixture.workspace,
      lessonCard(subject, { body: "另一面", coexist: true }),
      { allowTrailing: true },
    );
    assert.deepEqual(second.conflicts, [first.id]);
    const all = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), selection: "all", allowTrailing: true });
    assert.deepEqual(all.records.find((record) => record.id === second.id).extensions, { coexistsWith: [first.id] });
    assert.equal(all.records.length, 2, "coexisting cards both survive");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 the threshold is two subject-token hits, not one shared word", () => {
  const metadata = {
    subject: "guard-check 运行期间不要并发编辑", summary: "", snippet: "", tags: [],
    id: "knowledge:000000000000000000000001", lifecycle: "active",
  };
  assert.equal(knowledgeRelevanceScore(metadata, metadata.subject), KNOWLEDGE_CONFLICT_SCORE_THRESHOLD);
  const legacyHits = knowledgeConflictHits([metadata], metadata.subject);
  assert.deepEqual(legacyHits, [metadata.id]);
  assert.deepEqual(legacyHits, knowledgeConflictHits([{ ...metadata, extensions: {} }], metadata.subject),
    "missing extensions has the same conflict result as explicit empty extensions");
  assert.deepEqual(knowledgeConflictHits([metadata], "guard-check 另一件完全不同的事"), [],
    "one shared token scores 8 and stays under the line");
  assert.deepEqual(knowledgeConflictHits([{ ...metadata, lifecycle: "retired" }], metadata.subject), [],
    "a retired card is not a live conflict");
  assert.deepEqual(knowledgeConflictHits([metadata], metadata.subject, [metadata.id]), [],
    "an excluded id -- the record itself, or the one it supersedes -- is not its own conflict");
});

test("STORY-365 GWT4/GWT5: create needs no backlink lists, and nothing new lands as a candidate", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-CREATE");
  try {
    const createArguments = (externalKey, lifecycle) => [
      "knowledge-create",
      "--workspace", fixture.workspace,
      "--at", instant(2),
      "--external-key", externalKey,
      "--scope", "role",
      "--project-id", "-",
      "--role-scopes", "implementation",
      "--category", "workflow",
      "--kind", "fact",
      "--tags", "lesson",
      "--subject", "四个链接列表都不再必填",
      "--summary", "knowledge-create 不带 work/decision/gate/evidence 也能写",
      "--snippet", "四个列表可选",
      "--accountable-owner-id", OWNER,
      "--source-references", "-",
      "--lifecycle", lifecycle,
      "--retrieval", "default",
      "--freshness", "fresh",
      "--last-verified", "-",
      "--stale-days", "-",
      "--export", "metadata-only",
      "--body", "四个链接列表都不再必填。",
    ];
    // TCRN-CROSS-SUB-308: the lifecycle that was the last way to land a candidate is refused
    // at the write, with its remedy.
    const refused = await cliJson(createArguments("S365-CANDIDATE", "candidate")).then(() => null, (error) => error);
    assert.equal(refused?.reasonCode, "KNOWLEDGE_LIFECYCLE_RETIRED");
    assert.deepEqual([refused.details.required, refused.details.actual], ["active", "candidate"]);
    const created = await cliJson(createArguments("S365-NO-LINK-LISTS", "active"));
    assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.equal(Object.hasOwn(created, "promotionState"), false, "the create receipt omits the retired promotion marker");

    await captureKnowledgeUnit(fixture.workspace, lessonCard("另一条完全不同的经验条目"), { allowTrailing: true });
    // TCRN-CROSS-STORY-476 R1: --promotion went with the candidate it selected, so every card is
    // listed and none of them is a candidate.
    const refusedFlag = await cliJson([
      "knowledge-list", "--workspace", fixture.workspace, "--at", instant(3),
      "--selection", "all", "--promotion", "candidate", "--allow-trailing", "true",
    ]).then(() => null, (error) => error);
    assert.equal(refusedFlag?.reasonCode, "CLI_ARGUMENT_UNKNOWN");
    const listed = await cliJson([
      "knowledge-list", "--workspace", fixture.workspace, "--at", instant(3),
      "--selection", "all", "--allow-trailing", "true",
    ]);
    assert.equal(listed.total, 2);
    assert.equal(listed.records.some((record) => record.lifecycle === "candidate" || record.promotionState === "candidate"), false,
      "no write this Story admits produces a candidate");
  } finally {
    await fixture.close();
  }
});

test("STORY-365 the extension slot stays a closed roster of two knowledge-id keys", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-EXTENSIONS");
  try {
    const write = writeFile;
    const first = await captureKnowledgeUnit(fixture.workspace, lessonCard("扩展槽是有界的两个键"), { allowTrailing: true });
    // A metadata file to forge is the metadata/body layout's, which an engine before event streams
    // wrote (TCRN-CROSS-SUB-414): the card is laid down that way first.
    await asOlderEngineCrest(fixture.workspace);
    const path = join(fixture.workspace, DIRECTORY.knowledge, "metadata", `${first.id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    for (const forged of [{ unknownKey: "x" }, { supersededBy: "not-an-id" }, { supersededBy: 1 }, { supersededBy: "knowledge:" + "ａ".repeat(24) }, { coexistsWith: "knowledge:" + "a".repeat(24) }, { coexistsWith: ["knowledge:" + "a".repeat(24), "knowledge:" + "a".repeat(24)] }, { coexistsWith: [] }, { coexistsWith: ["knowledge:000000000000000000000002", "knowledge:000000000000000000000001"] }]) {
      await write(path, canonicalJson({ ...stored, extensions: forged }));
      const refusal = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true })
        .then(() => null, (error) => error);
      assert.equal(refusal?.reasonCode, "KNOWLEDGE_RECORD_INVALID", `extensions ${JSON.stringify(forged)} must be refused`);
    }
    await write(path, canonicalJson(stored));
    assert.equal((await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true })).records.length, 1);
  } finally {
    await fixture.close();
  }
});

// TCRN-CROSS-INC-282 (Owner ruling TCRN-CROSS-MIN-158 D1) — the machine criterion the
// Incident asked for, stated as the writer states it: a card written with a source
// reference and no evidence id is in the default selection at once. STORY-365 reached both
// verbs (they share buildMetadata) but left the half-supplied provenance branch standing,
// and the branch it left was the one the Stop hook and every hand-written card take.
test("INC-282: a captured card naming a source is active and in default recall at once", async () => {
  const fixture = await containerFixture("FIXTURE-CAPTURE-SOURCED");
  try {
    const sourced = await captureKnowledgeUnit(fixture.workspace, lessonCard("带来源的经验卡", {
      sourceReferences: ["docs/tutorial/governed-loop.md"],
    }), { allowTrailing: true });
    assert.equal(sourced.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    assert.equal(Object.hasOwn(sourced, "promotionState"), false, "a source reference is not a reason to withhold a card");
    const listed = await listKnowledgeMetadata(fixture.workspace, { at: instant(3), allowTrailing: true });
    assert.equal(listed.records.some((record) => record.id === sourced.id), true,
      `default recall must return the sourced card: ${JSON.stringify(listed.records.map((record) => record.subject))}`);
    // The contrast that made the defect invisible: the same card without a source was
    // always returned, so the writer had no way to tell the two apart from the receipt.
    const bare = await captureKnowledgeUnit(fixture.workspace, lessonCard("无来源的经验卡"), { allowTrailing: true });
    assert.equal(Object.hasOwn(bare, "promotionState"), false, "the no-source receipt also omits the retired marker");
  } finally {
    await fixture.close();
  }
});
