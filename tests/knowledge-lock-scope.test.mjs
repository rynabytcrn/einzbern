// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-538 GWT4, the knowledge store's part, and GWT7 (MIN-256 D6 C2, C3; TCRN-CROSS-SUB-501):
// knowledge-reverify, knowledge-article-refresh and a knowledge-batch's knowledge-policy member hold the
// library write lock for their append alone, as a card write does (TCRN-CROSS-SUB-481). While another
// process holds the lock for 3 seconds, their scans and checks refuse at once, and writes that pass them
// wait for the lock and land once it is free, each answered for the crest it was appended to. A write
// whose crest another writer appended to after its scan scans again under the next attempt: it reads
// that writer's event, and its receipt, or its refusal, is the one the crest as it stands calls for.
// Every library and device directory here is a temporary one.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { listKnowledgeMetadata, readKnowledgeStoreMarker, reverifyKnowledgeUnit } from "../dist/build/packages/core/src/knowledge-core.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { cli, cliProcess, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const workspaceModule = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
const knowledgeModule = new URL("../dist/build/packages/core/src/knowledge-core.js", import.meta.url).href;

// Resolves once `stream` has printed `line`; rejects when `exited` settles first.
function lineWaiter(stream, exited) {
  let text = "";
  const waiting = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    text += chunk;
    for (const entry of [...waiting]) {
      if (!text.includes(entry.line)) continue;
      waiting.splice(waiting.indexOf(entry), 1);
      entry.resolve();
    }
  });
  return (line) => Promise.race([
    text.includes(line) ? Promise.resolve() : new Promise((resolve) => { waiting.push({ line, resolve }); }),
    exited.then(() => { throw new Error(`the lock holder exited before it printed ${line}`); }),
  ]);
}

/**
 * Another process that takes the library's write lock, as a write verb does, and gives it back
 * `milliseconds` after it took it. Given `during` -- statements run with the knowledge core as
 * `knowledge` -- it waits under the lock until write() is called, runs them there, as another writer
 * whose turn came first would, and only then lets the rest of the time run out.
 */
async function holdLibraryLock(context, workspace, milliseconds, during = null) {
  const script = `import { withWorkspaceWriteLock } from ${JSON.stringify(workspaceModule)};
import * as knowledge from ${JSON.stringify(knowledgeModule)};
import { once } from "node:events";
await withWorkspaceWriteLock(${JSON.stringify(workspace)}, async () => {
  const heldAt = Date.now();
  process.stdout.write("held\\n");
  ${during === null ? "" : `await once(process.stdin, "data");
  ${during}
  process.stdout.write("written\\n");`}
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ${milliseconds} - (Date.now() - heldAt))));
}, { command: "einzbern knowledge-capture" });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: [during === null ? "ignore" : "pipe", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
    return Date.now();
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => undefined);
  });
  const printed = lineWaiter(child.stdout, exited);
  await printed("held");
  return {
    heldAt: Date.now(),
    released: exited,
    async write() {
      child.stdin.end("write\n");
      await printed("written");
    },
  };
}

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

function settle(promise) {
  const state = { done: false };
  return { state, promise: promise.then((value) => { state.done = true; return value; }, (error) => { state.done = true; throw error; }) };
}

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

const OWNER = deriveStableId("owner", "KNOWLEDGE-LOCK-SCOPE-OWNER");
const EVIDENCE = deriveStableId("evidence", "KNOWLEDGE-LOCK-SCOPE");

/** A library with a crest holding two cards and an article index, none written again yet. */
async function crestFixture(context, key) {
  const fixture = await workspaceFixture(context, { externalKey: key });
  const { workspace } = fixture;
  await cli(["knowledge-init", "--workspace", workspace, "--acknowledge-disposable", "true"]);
  const capture = (externalKey, subject, second) => cli(["knowledge-capture", "--workspace", workspace, "--at", instant(second),
    "--external-key", externalKey, "--subject", subject, "--summary", `${subject}, kept for the lock scope.`, "--snippet", subject,
    "--tags", "lock,scope", "--accountable-owner-id", "owner:agent-session", "--body", `${subject}: the body this card binds.`]);
  const wombat = await capture(`${key}-WOMBAT`, "Wombat burrow ledger", 2);
  const heron = await capture(`${key}-HERON`, "Heron nesting calendar", 3);
  const article = await cli(["knowledge-article-create", "--workspace", workspace, "--at", instant(4), "--path", "basalt.md",
    "--category", "workflow", "--title", "Basalt quarry tolerances", "--summary", "How far a basalt block may stray.",
    "--content", "A basalt block strays no more than two millimetres.", "--accountable-owner-id", OWNER, "--evidence-ids", EVIDENCE]);
  for (const created of [wombat, heron, article]) assert.equal(created.revision, 1);
  return { ...fixture, wombat: wombat.id, heron: heron.id, article: article.id };
}

async function crestVersion(workspace) {
  return (await readKnowledgeStoreMarker(workspace)).version;
}

async function cards(workspace) {
  const listed = await listKnowledgeMetadata(workspace, { at: instant(60), selection: "all" });
  return new Map(listed.records.map((record) => [record.id, record]));
}

// The names of every event file in the crest's device streams.
async function eventFiles(workspace) {
  const events = join(workspace, "crest", "events");
  const names = [];
  for (const device of await readdir(events)) {
    for (const name of await readdir(join(events, device))) if (/^\d{8,}-[a-f0-9]{64}\.json$/u.test(name)) names.push(name);
  }
  return names.sort();
}

function policyBatch(id, expectedRevision) {
  return JSON.stringify({ schemaVersion: "tcrn.knowledge-batch.v1", members: [
    { verb: "knowledge-policy", id, expectedRevision, stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" } },
  ] });
}

test("538 GWT4: while another process holds the library write lock for 3 seconds, knowledge-reverify, knowledge-article-refresh and a knowledge-policy member scan and judge without waiting for it", async (context) => {
  const fx = await crestFixture(context, "KNOWLEDGE-LOCK-CHECKS");
  const { workspace } = fx;
  const staleBatch = join(fx.base, "stale-policy.json");
  const batch = join(fx.base, "policy.json");
  await writeFile(staleBatch, policyBatch(fx.heron, 5));
  await writeFile(batch, policyBatch(fx.heron, 1));
  const before = await crestVersion(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000);

  const refused = (args) => timed(() => refusal(() => cli(args)));
  const refusals = [
    ["knowledge-reverify at a revision the card is not at", "KNOWLEDGE_CAS_MISMATCH",
      await refused(["knowledge-reverify", "--workspace", workspace, "--expected-revision", "2", "--at", instant(10), "--id", fx.wombat])],
    ["knowledge-reverify of a card the crest does not hold", "KNOWLEDGE_NOT_FOUND",
      await refused(["knowledge-reverify", "--workspace", workspace, "--expected-revision", "1", "--at", instant(10), "--id", deriveStableId("knowledge", "KNOWLEDGE-LOCK-NO-SUCH-CARD")])],
    ["knowledge-article-refresh of a card that is no article index", "KNOWLEDGE_LIFECYCLE_INVALID",
      await refused(["knowledge-article-refresh", "--workspace", workspace, "--expected-revision", "1", "--at", instant(10), "--id", fx.wombat, "--path", "basalt.md", "--summary", "Not an article."])],
    ["knowledge-article-refresh at a revision the article is not at", "KNOWLEDGE_CAS_MISMATCH",
      await refused(["knowledge-article-refresh", "--workspace", workspace, "--expected-revision", "2", "--at", instant(10), "--id", fx.article, "--path", "basalt.md", "--summary", "Stale."])],
    ["a knowledge-policy member at a revision the card is not at", "WORK_BATCH_REFUSED",
      await refused(["knowledge-batch", "--workspace", workspace, "--at", instant(10), "--from-file", staleBatch])],
  ];
  assert.ok(Date.now() - holder.heldAt < 3000, "every refusal came while the lock was held");
  for (const [name, reasonCode, run] of refusals) {
    assert.equal(run.result.reasonCode, reasonCode, `${name}: ${run.result.message}`);
    assert.ok(run.elapsed < 1000, `${name} refused in ${run.elapsed} ms`);
  }
  const member = JSON.parse(refusals[4][2].result.message);
  assert.deepEqual([member.stage, member.applied, member.failed.reasonCode, member.notEvaluated], ["apply", [], "KNOWLEDGE_CAS_MISMATCH", []],
    "the batch's member was judged, and refused, outside the lock");

  // Writes that pass their checks wait for the lock, then land, each against the crest it finds.
  const reverify = settle(cliProcess(["knowledge-reverify", "--workspace", workspace, "--expected-revision", "1", "--at", instant(20), "--id", fx.wombat]));
  const refresh = settle(cliProcess(["knowledge-article-refresh", "--workspace", workspace, "--expected-revision", "1", "--at", instant(21), "--id", fx.article,
    "--path", "basalt.md", "--summary", "How far a basalt block may stray, checked again."]));
  const policy = settle(cliProcess(["knowledge-batch", "--workspace", workspace, "--at", instant(22), "--from-file", batch]));
  await pause(700);
  assert.deepEqual([reverify.state.done, refresh.state.done, policy.state.done], [false, false, false], "the writes wait while the lock is held");
  await holder.released;
  const receipts = [];
  for (const run of [await reverify.promise, await refresh.promise, await policy.promise]) {
    assert.equal(run.status, 0, run.stderr);
    receipts.push(JSON.parse(run.stdout));
  }
  const [reverified, refreshed, applied] = receipts;
  assert.deepEqual([reverified.reasonCode, reverified.id, reverified.revision, reverified.lastVerified], ["KNOWLEDGE_REVERIFIED", fx.wombat, 2, instant(20)]);
  assert.deepEqual([refreshed.reasonCode, refreshed.id, refreshed.revision], ["KNOWLEDGE_ARTICLE_REFRESHED", fx.article, 2]);
  assert.deepEqual([applied.reasonCode, applied.applied.map((entry) => [entry.verb, entry.id])], ["KNOWLEDGE_BATCH_APPLIED", [["knowledge-policy", fx.heron]]]);
  assert.deepEqual([reverified.version, refreshed.version, applied.version].sort((left, right) => left - right), [before + 1, before + 2, before + 3],
    "each write was answered for the crest it was appended to, the others' events counted");
  assert.equal(await crestVersion(workspace), before + 3);
  const after = await cards(workspace);
  assert.deepEqual([after.get(fx.wombat).revision, after.get(fx.wombat).lastVerified], [2, instant(20)]);
  assert.deepEqual([after.get(fx.article).revision, after.get(fx.article).summary], [2, "How far a basalt block may stray, checked again."]);
  assert.deepEqual([after.get(fx.heron).revision, after.get(fx.heron).stalenessPolicy], [2, { maximumAgeDays: 30, unknownDisposition: "fail-closed" }]);
});

test("538 GWT4: a knowledge-reverify whose crest another writer appended to after its scan scans again, reads that writer's event, and lands on top of it", async (context) => {
  const fx = await crestFixture(context, "KNOWLEDGE-LOCK-RESCAN");
  const { workspace } = fx;
  const before = await crestVersion(workspace);
  const holder = await holdLibraryLock(context, workspace, 3000,
    `await knowledge.reverifyKnowledgeUnit(${JSON.stringify(workspace)}, { expectedRevision: 1, occurredAt: ${JSON.stringify(instant(9))}, id: ${JSON.stringify(fx.heron)} });`);
  const read = [];
  const writing = settle(reverifyKnowledgeUnit(workspace, { expectedRevision: 1, occurredAt: instant(10), id: fx.wombat }, {
    beforeDescriptorReadForTest: async (path) => { read.push(basename(path)); },
  }));
  await pause(1000);
  assert.equal(writing.state.done, false, "the reverify scanned and judged the crest, and waits for the lock to append");
  const scanned = read.length;
  assert.ok(scanned > 0, "it read the crest's events while the lock was held");
  const known = await eventFiles(workspace);
  await holder.write();
  const [other] = (await eventFiles(workspace)).filter((name) => !known.includes(name));
  assert.ok(other !== undefined, "the other writer appended its event");
  assert.equal(read.includes(other), false, "the first scan could not have read it");
  await holder.released;
  const receipt = await writing.promise;
  assert.ok(read.slice(scanned).includes(other), "the reverify scanned again once it found the crest moved, reading the other writer's event");
  assert.deepEqual([receipt.reasonCode, receipt.id, receipt.revision, receipt.version], ["KNOWLEDGE_REVERIFIED", fx.wombat, 2, before + 2],
    "it was answered for the crest it was appended to, the other writer's event counted");
  assert.equal(await crestVersion(workspace), before + 2);
  const after = await cards(workspace);
  assert.deepEqual([after.get(fx.wombat).revision, after.get(fx.wombat).lastVerified], [2, instant(10)]);
  assert.deepEqual([after.get(fx.heron).revision, after.get(fx.heron).lastVerified], [2, instant(9)], "the other writer's card stands as it wrote it");
});

test("538 GWT4: a knowledge-reverify and an article refresh whose card another writer wrote again after their scan are refused at their append with KNOWLEDGE_CAS_MISMATCH, and append nothing", async (context) => {
  const fx = await crestFixture(context, "KNOWLEDGE-LOCK-CAS");
  const { workspace } = fx;
  const holder = await holdLibraryLock(context, workspace, 3000, [
    `await knowledge.reverifyKnowledgeUnit(${JSON.stringify(workspace)}, { expectedRevision: 1, occurredAt: ${JSON.stringify(instant(9))}, id: ${JSON.stringify(fx.wombat)} });`,
    `await knowledge.refreshKnowledgeArticle(${JSON.stringify(workspace)}, { expectedRevision: 1, occurredAt: ${JSON.stringify(instant(9))}, id: ${JSON.stringify(fx.article)}, path: "basalt.md", summary: "Refreshed by the writer whose turn came first." });`,
  ].join("\n  "));
  const before = await crestVersion(workspace);
  const reverify = settle(cli(["knowledge-reverify", "--workspace", workspace, "--expected-revision", "1", "--at", instant(10), "--id", fx.wombat]).then(() => null, (error) => error));
  const refresh = settle(cli(["knowledge-article-refresh", "--workspace", workspace, "--expected-revision", "1", "--at", instant(10), "--id", fx.article,
    "--path", "basalt.md", "--summary", "Refreshed on a revision that is gone."]).then(() => null, (error) => error));
  await pause(1000);
  assert.deepEqual([reverify.state.done, refresh.state.done], [false, false], "both passed their checks on revision 1, and wait for the lock");
  await holder.write();
  await pause(300);
  assert.deepEqual([reverify.state.done, refresh.state.done], [false, false], "they passed their checks before the other writer's appends, so they still wait");
  const releasedAt = await holder.released;
  const refusals = [await reverify.promise, await refresh.promise];
  assert.ok(Date.now() >= releasedAt, "the refusals came at the append, once the lock was free");
  for (const refused of refusals) {
    assert.equal(refused?.reasonCode, "KNOWLEDGE_CAS_MISMATCH", refused?.message);
    assert.match(refused.message, /1:2/u, "judged against the revision the other writer left");
  }
  assert.equal(await crestVersion(workspace), before + 2, "only the other writer's two events were appended");
  const after = await cards(workspace);
  assert.deepEqual([after.get(fx.wombat).revision, after.get(fx.wombat).lastVerified], [2, instant(9)]);
  assert.deepEqual([after.get(fx.article).revision, after.get(fx.article).summary], [2, "Refreshed by the writer whose turn came first."]);
});
