// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-428 (TCRN-CROSS-INC-398, STORY-514): no single canonical value bounds a crest's
// derived index or a list's digest. With the knowledge total gone (TCRN-CROSS-SUB-310 R17), the index
// view -- every record's metadata in one canonical value -- was the last bound on a crest: the write
// that carried it past the protocol's one-MiB ceiling was refused after its event was committed, and
// every read and write of the crest refused after it. The index digest and a list's digest are now
// hashed record by record; past the ceiling this device's view is a head and pages, each within it;
// below it the view is the whole index, byte for byte what it always was. A view that cannot be
// projected is left for the next read, and changes neither a read's answer nor a committed write's.
//
// The crests below hold 2,000 cards of about 2 KB of metadata each. A write scans the whole crest, so
// the bulk is appended by `appendCards` exactly as this device's writer appends a card -- its body,
// then its event, naming the event before it and hashed as the reader checks it -- and the engine's
// reader validates every one of those events on every read and write. The cards on either side of
// the ceiling, and the cards after the bulk, are written by the engine, and each answer is checked
// against the event it appended.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { cachePath, userCrestCachePath } from "../dist/build/packages/core/src/device-home.js";
import { createProject, initializeLibrary, readKnowledgeHintCards, validateWorkspace } from "../dist/build/packages/core/src/index.js";
import {
  captureKnowledgeUnit,
  initializeKnowledgeStore,
  listKnowledgeMetadata,
  readKnowledgeStoreMarker,
  validateKnowledgeStore,
} from "../dist/build/packages/core/src/knowledge-core.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import { PROTOCOL_LIMITS, canonicalByteLength, canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const AT = "2026-09-29T12:00:00Z";
const WRITTEN_AT = "2026-09-29T11:00:00Z";
const CEILING = 1_048_576;
const CARDS = 2_000;
const DEVICE = "a428".repeat(8);
const WHOLE = "tcrn.knowledge-index.v1";
const HEAD = "tcrn.knowledge-index-pages.v1";
const PAGE = "tcrn.knowledge-index-page.v1";

const letters = "abcdefghijklmnopqrstuvwxyz";
const word = (index) => `${letters[Math.floor(index / 676) % 26]}${letters[Math.floor(index / 26) % 26]}${letters[index % 26]}qe`;
const key = (index) => `SUB-428-${String(index).padStart(5, "0")}`;
const idOf = (index) => deriveStableId("knowledge", key(index));

// One lesson card. Its subject shares one word with every other card's, which scores below the
// write-time conflict threshold, so each card is written as itself and every record is one size.
function lesson(index, scope) {
  return {
    occurredAt: WRITTEN_AT,
    externalKey: key(index),
    subject: `${word(index)} lesson`,
    summary: `${word(index)} ${"s".repeat(985)}`,
    snippet: `${word(index)} snippet`,
    tags: ["ceiling"],
    accountableOwnerId: "owner:sub-428",
    body: `Body ${key(index)}`,
    ...(scope === "user" ? { scope: "user" } : {}),
  };
}

// The sha256 of a list as canonicalJson would serialize it, built here with no ceiling at all.
function listDigest(records) {
  return createHash("sha256").update(`[${records.map((record) => canonicalJson(record).slice(0, -1)).join(",")}]\n`, "utf8").digest("hex");
}

// A device directory, library and crest of this test's own, the device pinned so its stream is known.
async function crest(context, scope, name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-sub428-${name}-`)));
  const home = join(base, "device");
  await mkdir(home);
  await writeFile(join(home, "device.json"), `${JSON.stringify({ createdAt: "2026-01-01T00:00:00Z", deviceId: DEVICE, displayName: "sub-428", schemaVersion: "einzbern.device.v1" })}\n`);
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
    await rm(base, { recursive: true, force: true });
  });
  const workspace = join(base, "library");
  const libraryId = deriveStableId("library", `SUB-428-${name.toUpperCase()}`);
  await initializeLibrary({ root: workspace, createdAt: "2026-09-29T00:00:00Z", libraryId });
  await createProject(workspace, { occurredAt: "2026-09-29T00:00:01Z", externalKey: "SUB-428-PROJECT", name: "ceiling" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return {
    base,
    workspace,
    scope,
    store: scope === "user" ? "user" : "project",
    scoped: scope === "user" ? { scope: "user" } : {},
    scopeArgs: scope === "user" ? ["--scope", "user"] : [],
    stream: join(scope === "user" ? join(home, "crest") : join(workspace, "crest"), "events", DEVICE),
    views: join(scope === "user" ? userCrestCachePath(home) : cachePath(libraryId, home), "crest-views"),
  };
}

async function cli(args) {
  let output = "";
  await runCli(args, { write(value) { output += value; } });
  return JSON.parse(output);
}

async function eventNames(fx) {
  return (await readdir(fx.stream).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
}

// Write one card through the engine, and check its answer against the event it appended.
async function writeCard(fx, index) {
  const before = (await eventNames(fx)).length;
  const answer = await captureKnowledgeUnit(fx.workspace, lesson(index, fx.scope));
  const names = await eventNames(fx);
  assert.equal(names.length, before + 1, `card ${index}: one event appended`);
  const event = JSON.parse(await readFile(join(fx.stream, names.at(-1)), "utf8"));
  assert.deepEqual(
    [answer.reasonCode, answer.id, answer.externalKey, answer.version, answer.scope],
    ["KNOWLEDGE_UNIT_CREATED", idOf(index), key(index), before + 1, fx.scope === "user" ? "user" : undefined],
    `card ${index}: answered as created, at the version its event makes`,
  );
  assert.deepEqual([event.sequence, event.metadata.id, event.metadata.externalKey], [before + 1, answer.id, answer.externalKey], `card ${index}: its event`);
  return answer;
}

// Append cards [from, to) to this device's stream as its writer appends them. The first card the
// engine wrote lends every field but each card's own key, words and body.
async function appendCards(fx, from, to) {
  const names = await eventNames(fx);
  const template = JSON.parse(await readFile(join(fx.stream, names[0]), "utf8"));
  let prior = JSON.parse(await readFile(join(fx.stream, names.at(-1)), "utf8"));
  for (let index = from; index < to; index += 1) {
    const input = lesson(index, fx.scope);
    const body = Buffer.from(input.body, "utf8");
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const sequence = prior.sequence + 1;
    const stem = String(sequence).padStart(8, "0");
    const unsigned = {
      schemaVersion: template.schemaVersion,
      deviceId: template.deviceId,
      sequence,
      occurredAt: template.occurredAt,
      priorHash: prior.eventHash,
      ...(fx.scope === "user" ? {} : { chain: template.chain, replaces: null }),
      metadata: {
        ...template.metadata,
        id: idOf(index),
        externalKey: input.externalKey,
        subject: input.subject,
        summary: input.summary,
        snippet: input.snippet,
        bodySha256,
        bodyBytes: body.length,
      },
      body: { file: `${stem}-${bodySha256}.body`, sha256: bodySha256, bytes: body.length },
    };
    prior = { ...unsigned, eventHash: canonicalSha256(unsigned) };
    await writeFile(join(fx.stream, unsigned.body.file), body);
    await writeFile(join(fx.stream, `${stem}-${prior.eventHash}.json`), canonicalJson(prior));
  }
}

// This device's view as it stands: index.json, and every other file of its folder as a page.
async function viewOf(fx) {
  const names = (await readdir(fx.views)).sort();
  const headText = await readFile(join(fx.views, "index.json"), "utf8");
  const pages = [];
  for (const name of names.filter((entry) => entry !== "index.json")) {
    const text = await readFile(join(fx.views, name), "utf8");
    pages.push({ name, text, value: JSON.parse(text) });
  }
  return { names, headText, head: JSON.parse(headText), pages };
}

// The index a view holds, as one tcrn.knowledge-index.v1 document.
function wholeIndex(view) {
  const { head } = view;
  return {
    schemaVersion: WHOLE,
    authority: head.authority,
    workspaceId: head.workspaceId,
    eventHighWaterDigest: head.eventHighWaterDigest,
    version: head.version,
    records: head.schemaVersion === WHOLE ? head.records : view.pages.flatMap((page) => page.value.records),
    indexDigest: head.indexDigest,
  };
}

// A view below the ceiling is the whole index, as every engine before wrote it, with no page beside it.
function assertWholeView(view, count, label) {
  assert.equal(view.head.schemaVersion, WHOLE, label);
  assert.deepEqual(view.names, ["index.json"], `${label}: no page beside it`);
  assert.equal(view.head.records.length, count, label);
  assert.equal(view.head.indexDigest, canonicalSha256(view.head.records), `${label}: the digest every engine before gave it`);
  assert.equal(view.headText, canonicalJson(view.head), `${label}: canonical`);
  assert.ok(Buffer.byteLength(view.headText, "utf8") <= CEILING, `${label}: within the ceiling`);
}

// A view past the ceiling: a head naming its pages, each page within the ceiling and canonical, and
// their records in page order the index's records, whose canonical list hashes to the head's digest.
function assertPagedView(view, count, label) {
  assert.equal(view.head.schemaVersion, HEAD, label);
  assert.deepEqual(Object.keys(view.head).sort(), ["authority", "count", "eventHighWaterDigest", "indexDigest", "pages", "schemaVersion", "version", "workspaceId"], label);
  assert.equal(view.head.count, count, label);
  assert.ok(view.head.pages >= 2, `${label}: more than one page`);
  assert.deepEqual(view.pages.map((page) => page.name), Array.from({ length: view.head.pages }, (_, page) => `index-${String(page + 1).padStart(6, "0")}.json`), `${label}: the pages the head names and no other`);
  for (const [position, page] of view.pages.entries()) {
    assert.deepEqual([page.value.schemaVersion, page.value.page], [PAGE, position + 1], `${label}: ${page.name}`);
    assert.ok(Buffer.byteLength(page.text, "utf8") <= CEILING, `${label}: ${page.name} within the ceiling`);
    assert.equal(page.text, canonicalJson(page.value), `${label}: ${page.name} canonical`);
  }
  const whole = wholeIndex(view);
  assert.equal(whole.records.length, count, label);
  assert.deepEqual(whole.records.map((record) => record.id), whole.records.map((record) => record.id).sort(), `${label}: index order`);
  assert.equal(listDigest(whole.records), view.head.indexDigest, `${label}: the head's digest is the records' canonical list`);
  assert.ok(canonicalByteLength(whole) > CEILING, `${label}: the whole index would pass the ceiling`);
}

// Write cards through the engine one at a time from `index` until the view turns into pages, each
// view before it whole and within the ceiling: the switch is where the whole index passes it.
async function writeAcrossTheCeiling(fx, index) {
  let count = (await eventNames(fx)).length;
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1, index += 1) {
    await writeCard(fx, index);
    count += 1;
    // A library's write projects its view after the commit; the user crest's next read does.
    if (fx.scope === "user") await listKnowledgeMetadata(fx.workspace, { at: AT, limit: 1, ...fx.scoped });
    const view = await viewOf(fx);
    if (view.head.schemaVersion === HEAD) {
      assert.ok(last !== null, "the crest was below the ceiling before these writes");
      assertPagedView(view, count, `card ${index} carried the index past the ceiling`);
      return index + 1;
    }
    assertWholeView(view, count, `card ${index}`);
    last = view;
  }
  return assert.fail("twelve writes never carried the index past the ceiling");
}

// Append cards until the whole index is a few records short of the ceiling.
async function appendToBelowTheCeiling(fx, index) {
  await listKnowledgeMetadata(fx.workspace, { at: AT, limit: 1, ...fx.scoped });
  const view = await viewOf(fx);
  assertWholeView(view, index, "the first cards");
  const recordBytes = Buffer.byteLength(canonicalJson(view.head.records.at(-1)), "utf8");
  const room = Math.floor((CEILING - Buffer.byteLength(view.headText, "utf8")) / recordBytes);
  assert.ok(recordBytes > 1_900 && recordBytes < 2_300, `about 2 KB of metadata per card (${recordBytes} bytes)`);
  await appendCards(fx, index, index + room - 3);
  return index + room - 3;
}

// What the crest answers at 2,000 cards and more: validation (a library's), list by default and
// with --selection all, recall's read of the whole crest, the recall verb, the knowledge hint's read
// and the view. Nothing is refused, and nothing names INPUT_OVERSIZED.
async function assertCrestAnswers(fx, count) {
  if (fx.scope === "project") {
    const validation = await validateKnowledgeStore(fx.workspace);
    assert.deepEqual([validation.reasonCode, validation.records, validation.version], ["KNOWLEDGE_STORE_VALID", count, count]);
    const marker = await readKnowledgeStoreMarker(fx.workspace);
    assert.deepEqual([marker.records, marker.indexDigest], [count, validation.indexDigest]);
  }
  for (const selection of [[], ["--selection", "all"]]) {
    const listed = await cli(["knowledge-list", "--workspace", fx.workspace, "--at", AT, ...fx.scopeArgs, ...selection]);
    assert.deepEqual([listed.reasonCode, listed.total, listed.records.length, listed.truncated], ["KNOWLEDGE_LIST_READY", count, 8, true], `knowledge-list ${selection.join(" ")}`);
    assert.equal(listed.resultDigest, canonicalSha256(listed.records), "a page within the ceiling keeps the digest it always had");
  }
  // Recall and the knowledge hint read the whole crest as one page, past the ceiling.
  const whole = await listKnowledgeMetadata(fx.workspace, { at: AT, includeExplicitOnly: true, limit: 1_048_576, ...fx.scoped });
  assert.equal(whole.records.length, count);
  assert.ok(Buffer.byteLength(canonicalJson(whole.records[0]), "utf8") * count > CEILING, "the whole crest's page is past the ceiling");
  assert.throws(() => canonicalSha256(whole.records), { reasonCode: "INPUT_OVERSIZED" }, "the protocol's ceiling is where it was");
  assert.equal(PROTOCOL_LIMITS.maxCanonicalBytes, CEILING);
  assert.equal(whole.resultDigest, listDigest(whole.records), "its digest is the canonical list's, hashed record by record");
  const read = await readRecallCards(fx.workspace, { at: AT });
  assert.deepEqual([read.stores[fx.store].reasonCode, read.stores[fx.store].cards, read.stores[fx.store].digest], ["KNOWLEDGE_LIST_READY", count, whole.resultDigest]);
  assert.equal(read.projectCrestDegraded, null);
  assert.equal(read.userCrestDegraded, null);
  // Every card shares all but one word, so the shipped threshold is lifted: what is asked of recall
  // here is that it reads the whole crest and ranks the card by its own word.
  const recalled = await cli(["recall", "--workspace", fx.workspace, "--at", AT, "--query", `${word(1_500)} lesson`, "--tau", "0"]);
  assert.equal(recalled.reasonCode, "RECALL_READY");
  assert.equal(recalled.records[0]?.id, idOf(1_500), "the card is recalled by its own word");
  assert.deepEqual(recalled.knowledgeStores[fx.store], { reasonCode: "KNOWLEDGE_LIST_READY", cards: count });
  assert.equal(recalled.projectCrestDegraded, undefined);
  assert.equal(recalled.userCrestDegraded, undefined);
  assert.equal((await readKnowledgeHintCards(fx.workspace, AT)).length, count, "the knowledge hint reads every card");
  const view = await viewOf(fx);
  assertPagedView(view, count, "the crest's view");
  if (fx.scope === "project") assert.equal(view.head.indexDigest, (await validateKnowledgeStore(fx.workspace)).indexDigest);
  return view;
}

async function twoThousandCards(context, scope) {
  const fx = await crest(context, scope, `${scope}-2000`);
  await writeCard(fx, 0);
  let index = await appendToBelowTheCeiling(fx, 1);
  index = await writeAcrossTheCeiling(fx, index);
  await appendCards(fx, index, CARDS - 3);
  for (index = CARDS - 3; index < CARDS; index += 1) await writeCard(fx, index);
  const view = await assertCrestAnswers(fx, CARDS);
  return { fx, view };
}

test("SUB-428: a library crest of 2,000 cards of about 2 KB each takes every write as its event records it, and validates, lists, recalls and writes on", async (context) => {
  const { fx, view } = await twoThousandCards(context, "project");

  // A damaged page and a page the head does not name are this device's cache: the next read
  // projects the one again and removes the other.
  await writeFile(join(fx.views, "index-000002.json"), "{not a page");
  await writeFile(join(fx.views, "index-000099.json"), "{}\n");
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).total, CARDS);
  assert.deepEqual(await viewOf(fx), view, "the view is projected again, page for page");

  // TCRN-CROSS-SUB-428 (R14 (d)): the view cannot be projected after this write commits -- its
  // folder is a file -- and the write is answered as committed, the crest reads, and the next read
  // after the folder comes back projects the view again.
  await rename(fx.views, join(fx.base, "views-aside"));
  await writeFile(fx.views, "not a folder");
  const committed = await writeCard(fx, CARDS);
  assert.equal(committed.version, CARDS + 1);
  assert.ok((await stat(fx.views)).isFile(), "nothing was projected");
  assert.deepEqual([(await validateKnowledgeStore(fx.workspace)).records, (await listKnowledgeMetadata(fx.workspace, { at: AT })).total], [CARDS + 1, CARDS + 1]);
  await rm(fx.views);
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, limit: 1 })).total, CARDS + 1);
  const rebuilt = await viewOf(fx);
  assertPagedView(rebuilt, CARDS + 1, "the view projected again");
  assert.ok(wholeIndex(rebuilt).records.some((record) => record.id === committed.id));
  assert.equal(rebuilt.head.indexDigest, (await validateKnowledgeStore(fx.workspace)).indexDigest);
});

test("SUB-428: a user crest of 2,000 cards of about 2 KB each takes every write as its event records it, and lists, recalls and writes on", async (context) => {
  await twoThousandCards(context, "user");
});

test("SUB-428: below the ceiling a crest's view, index digest and list digest are what every engine before gave; past it and back, the view follows", async (context) => {
  const fx = await crest(context, "project", "whole");
  for (const index of [0, 1, 2]) await writeCard(fx, index);
  const small = await viewOf(fx);
  assertWholeView(small, 3, "three cards");
  const validation = await validateKnowledgeStore(fx.workspace);
  assert.equal(validation.indexDigest, canonicalSha256(small.head.records));
  const listed = await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" });
  assert.equal(listed.resultDigest, canonicalSha256(listed.records));

  // Past the ceiling, then back below it: a restore that leaves the stream's first cards.
  const index = await appendToBelowTheCeiling(fx, 3);
  await appendCards(fx, index, index + 40);
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).total, index + 40);
  assertPagedView(await viewOf(fx), index + 40, "past the ceiling");
  const aside = join(fx.base, "events-aside");
  await mkdir(aside);
  for (const name of (await eventNames(fx)).slice(3)) await rename(join(fx.stream, name), join(aside, name));
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).total, 3);
  const back = await viewOf(fx);
  assertWholeView(back, 3, "back below the ceiling, its pages gone");
  assert.equal(back.headText, small.headText, "the view the first three cards had");
});

test("SUB-428: an old-layout store reads as its engine left it, its view compared byte for byte and no byte written", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-sub428-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const fx = await crest(context, "project", "legacy-source");
  const cards = [await writeCard(fx, 0), await writeCard(fx, 1)];
  const events = await Promise.all((await eventNames(fx)).map(async (name) => JSON.parse(await readFile(join(fx.stream, name), "utf8"))));
  const { root, control } = await restoreLegacyFixture(base);
  // The old engine bound its store to the place it wrote the workspace: here, where it is restored.
  const metadataPath = join(control, "workspace.json");
  await writeFile(metadataPath, canonicalJson(JSON.parse((await readFile(metadataPath, "utf8")).replaceAll("<fixture>", base))));
  const legacy = await validateWorkspace(root);
  // The store an engine before libraries left: marker, metadata, bodies and its whole view.
  const knowledge = join(control, "knowledge");
  for (const directory of ["metadata", "bodies", "views"]) await mkdir(join(knowledge, directory), { recursive: true });
  for (const event of events) {
    await writeFile(join(knowledge, "metadata", `${event.metadata.id}.json`), canonicalJson(event.metadata));
    await writeFile(join(knowledge, "bodies", `${event.metadata.id}.body`), await readFile(join(fx.stream, event.body.file)));
  }
  const marker = { schemaVersion: "tcrn.knowledge-store.v1", workspaceId: legacy.metadata.workspaceId, eventHighWaterDigest: legacy.headEventHash, version: 2, disposable: true, authority: "metadata-index-authority-body-separate" };
  await writeFile(join(knowledge, "store.json"), canonicalJson(marker));
  const records = events.map((event) => event.metadata).sort((left, right) => left.id.localeCompare(right.id))
    .map(({ supersedes, expansions, ...record }) => ({ ...record, ...(supersedes === null ? {} : { supersedes }), ...(Object.keys(expansions ?? {}).length === 0 ? {} : { expansions }) }));
  await writeFile(join(knowledge, "views", "index.json"), canonicalJson({
    schemaVersion: WHOLE, authority: "derived-rebuildable", workspaceId: marker.workspaceId, eventHighWaterDigest: marker.eventHighWaterDigest,
    version: 2, records, indexDigest: canonicalSha256(records),
  }));
  const before = await readdir(knowledge, { recursive: true });
  const bytesBefore = await Promise.all(before.map((name) => readFile(join(knowledge, name)).catch(() => null)));
  const validation = await validateKnowledgeStore(root);
  assert.deepEqual([validation.reasonCode, validation.records, validation.indexDigest], ["KNOWLEDGE_STORE_VALID", 2, canonicalSha256(records)]);
  const listed = await listKnowledgeMetadata(root, { at: AT, selection: "all" });
  assert.deepEqual(listed.records.map((record) => record.id), cards.map((card) => card.id).sort());
  assert.equal(listed.resultDigest, canonicalSha256(listed.records));
  assert.deepEqual(await readdir(knowledge, { recursive: true }), before, "no file added");
  assert.deepEqual(await Promise.all(before.map((name) => readFile(join(knowledge, name)).catch(() => null))), bytesBefore, "no byte changed");
});
