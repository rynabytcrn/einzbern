// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-310 R17 (TCRN-CROSS-STORY-476 R3 and Feature Toggle as revised; MIN-238 D1, D5;
// MIN-239 D1).
//
// No budget bounds the sum of a crest's card bodies. knowledge.aggregateBytes, the setting that counted
// the bodies of live cards against a limit (TCRN-CROSS-SUB-309), is retired with the limit, and no
// read, write, recall or recovery refuses for the bytes the bodies add up to -- nor for a crest an
// older engine laid out. Each card keeps its own limits: one past them is refused with KNOWLEDGE_LIMIT_EXCEEDED and
// writes nothing. A superseded card is removed (TCRN-CROSS-SUB-425, MIN-239 D4, which replaces
// MIN-235 D10 for cards): it leaves default selection and recall, its event stays and its body is
// cleared. knowledge-validate no longer reports a capacity.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { recall, recallDocuments, resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import {
  captureKnowledgeUnit,
  createProject,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  readKnowledgeBody,
  recoverKnowledgeStore,
  validateKnowledgeStore,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-26T10:00:00.000Z";
const OWNER = "owner:sub-310";
// The default knowledge.aggregateBytes held before it retired.
const OLD_DEFAULT = 131_072;
// Subjects that share no word, so no write scores as a conflict with another.
const SUBJECTS = [
  "alpaca shearing season", "bison herd migration", "cassowary egg incubation", "dugong seagrass grazing",
  "echidna spine care", "fennec burrow cooling", "gibbon canopy calls", "hoopoe crest display",
  "ibis wading depth", "jerboa night foraging", "kinkajou fruit diet", "lemur tail balance",
  "margay tree climbing", "narwhal tusk sensing", "ocelot coat pattern", "pangolin scale armour",
  "quetzal plume moult", "racoon paw washing", "serval ear hearing", "tapir snout reach",
];

async function fixture(t, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-sub310-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: "2026-01-01T00:00:00Z" });
  const project = await createProject(workspace, { occurredAt: "2026-01-01T00:00:01Z", externalKey: `${externalKey}-PROJECT`, name: "SUB-310 fixture" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, projectId: project.projects[0].id, store: join(workspace, DIRECTORY.knowledge) };
}

// A user crest of the test's own, in a device directory beside its library, so no other test's user
// cards are in it; the test process's device is put back afterwards.
function ownDeviceHome(t, fx) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(fx.base, "device");
  t.after(() => { process.env.EINZBERN_HOME = previous; resetRecallCache(); });
  return process.env.EINZBERN_HOME;
}

function card(externalKey, subject, body, overrides = {}) {
  return {
    occurredAt: "2026-06-12T00:00:00.000Z", externalKey, subject, summary: `${subject} summary`, snippet: `${subject} snippet`,
    tags: ["capacity"], accountableOwnerId: OWNER, body, ...overrides,
  };
}

// A body of exactly `bytes` bytes, distinct per card.
function bodyOf(bytes, index) {
  const tail = String(index);
  return `${"b".repeat(bytes - tail.length)}${tail}`;
}

function refusalOf(operation) {
  return operation().then(() => null, (error) => error);
}

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function fileBytes(directory, keep = () => true) {
  let total = 0;
  for (const name of (await readdir(directory)).filter(keep)) total += (await readFile(join(directory, name))).length;
  return total;
}

// TCRN-CROSS-SUB-414: a library's crest keeps each card as an event (its metadata) and a body file
// in this device's stream, crest/events/<device id>/.
async function streamOf(fx) {
  const [deviceId] = await readdir(join(fx.store, "events"));
  return join(fx.store, "events", deviceId);
}

// Every file this device's stream of the crest holds, or none when no card was ever written.
async function streamFiles(fx) {
  try { return (await readdir(await streamOf(fx))).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// TCRN-CROSS-SUB-414: the crest as an engine before event streams left it -- one metadata file and
// one body file per card, the marker's version counting its writes -- laid down from what the
// stream holds now, the streams taken away.
async function asOlderEngineCrest(fx) {
  const all = await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all", limit: 1_000_000 });
  const marker = await readKnowledgeStoreMarker(fx.workspace);
  const stream = await streamOf(fx);
  const bodies = new Map();
  for (const name of (await readdir(stream)).filter((entry) => entry.endsWith(".body"))) bodies.set(name.slice(9, -5), await readFile(join(stream, name)));
  await mkdir(join(fx.store, "metadata"));
  await mkdir(join(fx.store, "bodies"));
  for (const record of all.records) {
    await writeFile(join(fx.store, "metadata", `${record.id}.json`), canonicalJson(record));
    await writeFile(join(fx.store, "bodies", `${record.id}.body`), bodies.get(record.bodySha256));
  }
  const storeJson = join(fx.store, "store.json");
  await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), version: marker.version, eventHighWaterDigest: marker.eventHighWaterDigest }));
  await rm(join(fx.store, "events"), { recursive: true });
}

// Every file of the knowledge store, by relative path and bytes.
async function storeFiles(fx) {
  const files = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${relative}/`);
      else files[relative] = await readFile(join(directory, entry.name), "utf8");
    }
  };
  await walk(fx.store, "");
  return files;
}

test("R17 (MIN-238 D1): a library crest holding more than the old 131,072-byte default reads, recalls, validates and takes the next card", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-310-PAST-DEFAULT");
  // Seventeen 8,000-byte bodies are 136,000 bytes: the old default refused the seventeenth card.
  const written = [];
  for (const [index, subject] of SUBJECTS.slice(0, 17).entries()) {
    written.push(await captureKnowledgeUnit(fx.workspace, card(`SUB-310-FULL-${index}`, subject, bodyOf(8_000, index), { coexist: true })));
  }
  assert.deepEqual(written.map((entry) => entry.reasonCode), Array(17).fill("KNOWLEDGE_UNIT_CREATED"));
  const bodyBytes = await fileBytes(await streamOf(fx), (name) => name.endsWith(".body"));
  assert.ok(bodyBytes === 17 * 8_000 && bodyBytes > OLD_DEFAULT, `live bodies past the old default: ${bodyBytes}`);

  // Every read answers, and validate reports no capacity.
  const validation = await validateKnowledgeStore(fx.workspace);
  assert.deepEqual([validation.reasonCode, validation.records, Object.hasOwn(validation, "capacity")], ["KNOWLEDGE_STORE_VALID", 17, false]);
  const listed = await listKnowledgeMetadata(fx.workspace, { at: AT, limit: 64 });
  assert.deepEqual([listed.reasonCode, listed.total], ["KNOWLEDGE_LIST_READY", 17]);
  assert.equal((await readKnowledgeBody(fx.workspace, written[16].id, { at: AT })).body, bodyOf(8_000, 16));
  const cards = await readRecallCards(fx.workspace, { at: AT });
  assert.deepEqual([cards.stores.project.reasonCode, cards.stores.project.cards, cards.projectCrestDegraded], ["KNOWLEDGE_LIST_READY", 17, null]);
  const hit = recall({ cacheKey: "sub310-past-default", checkpoint: cards.digest, documents: () => recallDocuments({ knowledge: cards.cards }), query: SUBJECTS[16], tau: 0 });
  assert.equal(hit.records[0]?.id, written[16].id, "the last card is recalled by its subject");

  // The next card is admitted, and knowledge-validate on the CLI answers without a capacity too.
  const next = await captureKnowledgeUnit(fx.workspace, card("SUB-310-FULL-NEXT", SUBJECTS[17], bodyOf(8_192, 17), { coexist: true }));
  assert.equal(next.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const cli = await cliJson(["knowledge-validate", "--workspace", fx.workspace]);
  assert.deepEqual([cli.reasonCode, cli.records, Object.hasOwn(cli, "capacity")], ["KNOWLEDGE_STORE_VALID", 18, false]);
  assert.equal((await recoverKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_RECOVERY_NOT_NEEDED");
});

test("INC-399: complete bodies, summaries and snippets cross their former ceilings in both crests", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-310-CARD-LIMITS");
  ownDeviceHome(t, fx);
  const fields = [["body", "x".repeat(8_193)], ["summary", "s".repeat(2_049)], ["snippet", "n".repeat(513)]];
  let ordinal = 0;
  for (const scope of ["role", "user"]) {
    for (const [field, complete] of fields) {
      const input = { ...card(`SUB-310-OVER-${scope}-${field}`, SUBJECTS[ordinal++], "fits", { scope }), [field]: complete };
      const written = await captureKnowledgeUnit(fx.workspace, input);
      assert.equal(written.reasonCode, "KNOWLEDGE_UNIT_CREATED");
      const storeScope = scope === "user" ? "user" : "project";
      const listed = await listKnowledgeMetadata(fx.workspace, { at: AT, scope: storeScope, limit: 64 });
      if (field === "body") assert.equal((await readKnowledgeBody(fx.workspace, written.id, { at: AT, scope: storeScope })).body, complete);
      else assert.equal(listed.records.find(record => record.id === written.id)[field], complete);
    }
  }
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, scope: "user" })).total, 3);
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).total, 3);
});

test("476-R3, SUB-425 (MIN-239 D4): a superseded card is removed: it leaves default list and recall, its event stays and its body is cleared", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-310-SUPERSEDE");
  const subject = "SUB-310 the old answer to the retry question";
  const old = await captureKnowledgeUnit(fx.workspace, card("SUB-310-OLD", subject, "o".repeat(3_000), {
    summary: "Abandoned quokka migration calendar", snippet: "obsolete quokka travel date",
  }));
  const replacement = await captureKnowledgeUnit(fx.workspace, card("SUB-310-NEW", subject, "n".repeat(2_000), {
    supersedes: old.id, summary: "Revised quokka migration calendar", snippet: "current quokka travel date",
  }));
  assert.equal(replacement.superseded, old.id);
  // Superseded, so removed: its event stays in the stream, its body file is cleared, and a read of
  // its body is refused.
  const stream = await streamOf(fx);
  const oldEvent = (await Promise.all((await readdir(stream)).filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(join(stream, name), "utf8"))))).find((event) => event.metadata?.id === old.id);
  assert.equal((await readdir(stream)).includes(oldEvent.body.file), false);
  assert.equal((await refusalOf(() => readKnowledgeBody(fx.workspace, old.id, { at: AT })))?.reasonCode, "KNOWLEDGE_CARD_REMOVED");
  const removed = (await listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" })).records;
  assert.deepEqual(removed.map((record) => [record.id, record.removal.reason, record.removal.supersededBy]), [[old.id, "superseded", replacement.id]]);
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.some((record) => record.id === old.id), false);
  const defaultCards = await readRecallCards(fx.workspace, { at: AT });
  assert.equal(defaultCards.cards.some((record) => record.id === old.id), false, "superseded metadata is outside default recall");
  const recallResult = recall({
    cacheKey: "sub310-superseded-default-recall",
    checkpoint: defaultCards.digest,
    documents: () => recallDocuments({ knowledge: defaultCards.cards }),
    query: "obsolete quokka travel date",
    tau: 0,
  });
  assert.equal(recallResult.records.some((record) => record.id === old.id), false, "the removed card is never a default recall hit");
  assert.equal(recallResult.records.some((record) => record.id === replacement.id), true, "while the card that replaced it is");
});

test("R17 (MIN-238 D1): an older engine's crest past the old default is read by every read without a byte rewritten, and its stopped write recovers", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-310-EXISTING");
  const live = await captureKnowledgeUnit(fx.workspace, card("SUB-310-LIVE", "mike lesson", "m".repeat(700)));
  const subject = "SUB-310 november lesson written twice";
  const replaced = await captureKnowledgeUnit(fx.workspace, card("SUB-310-REPLACED", subject, "r".repeat(900)));
  // An older engine's supersede, laid down below: this engine's would clear the replaced body.
  const replacing = await captureKnowledgeUnit(fx.workspace, card("SUB-310-REPLACING", subject, "q".repeat(400), { coexist: true }));
  const retired = await captureKnowledgeUnit(fx.workspace, card("SUB-310-RETIRED", "oscar lesson", "x".repeat(1_100)));
  const candidate = await captureKnowledgeUnit(fx.workspace, card("SUB-310-CANDIDATE", "papa lesson", "c".repeat(300)));
  // Sixteen full bodies take the live bodies past the old default: 16 x 8,192 + 700 + 400 + 300.
  for (const [index, subject] of SUBJECTS.slice(0, 16).entries()) {
    await captureKnowledgeUnit(fx.workspace, card(`SUB-310-FILL-${index}`, subject, bodyOf(8_192, index), { coexist: true }));
  }
  // Lay down what stores written by earlier engines hold: a card an older engine retired with its
  // body still on disk, a card still in the candidate state it was written in, a card written
  // before `supersedes` and `expansions` existed, and a card another superseded, marked and with its
  // body kept, in the metadata/body layout that engine wrote (TCRN-CROSS-SUB-414). None of these
  // shapes is written now.
  await asOlderEngineCrest(fx);
  const rewrite = async (id, change) => {
    const path = join(fx.store, "metadata", `${id}.json`);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, canonicalJson(change(metadata)));
  };
  await rewrite(retired.id, (metadata) => ({ ...metadata, lifecycle: "retired", revision: metadata.revision + 1 }));
  await rewrite(candidate.id, (metadata) => ({ ...metadata, lifecycle: "candidate", promotionState: "candidate" }));
  await rewrite(live.id, (metadata) => Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "supersedes" && key !== "expansions")));
  await rewrite(replacing.id, (metadata) => ({ ...metadata, supersedes: replaced.id }));
  await rewrite(replaced.id, (metadata) => ({ ...metadata, extensions: { ...metadata.extensions, supersededBy: replacing.id }, revision: metadata.revision + 1 }));
  assert.ok(await fileBytes(join(fx.store, "bodies")) > OLD_DEFAULT, "the bodies on disk are past the old default");

  const before = await storeFiles(fx);
  const validation = await validateKnowledgeStore(fx.workspace);
  assert.deepEqual([validation.reasonCode, validation.records, Object.hasOwn(validation, "capacity")], ["KNOWLEDGE_STORE_VALID", 21, false]);
  // TCRN-CROSS-SUB-425: the superseded card is removed, one of the index's 21 records, and no valid card.
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all", limit: 64 })).total, 20);
  const removed = (await listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" })).records;
  assert.deepEqual(removed.map((record) => [record.id, record.removal.reason, record.removal.supersededBy, record.removal.deviceId]), [[replaced.id, "superseded", replacing.id, null]]);
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, limit: 64 })).reasonCode, "KNOWLEDGE_LIST_READY");
  await readKnowledgeStoreMarker(fx.workspace);
  await evaluateKnowledgeFreshness(fx.workspace, AT);
  assert.equal((await readKnowledgeBody(fx.workspace, live.id, { at: AT })).body, "m".repeat(700));
  assert.equal((await readRecallCards(fx.workspace, { at: AT })).stores.project.reasonCode, "KNOWLEDGE_LIST_READY");
  assert.deepEqual(await storeFiles(fx), before, "no read migrated or rewrote a byte of the store");
  assert.equal((await readdir(join(fx.store, "bodies"))).length, 21, "every body is still on disk: no device clears the metadata/body layout's");

  // The claim a write of that engine left when it stopped: recovery reads the whole crest, past the
  // old default, and completes the write.
  const marker = await readKnowledgeStoreMarker(fx.workspace);
  await writeFile(join(fx.store, "mutation.claim"), canonicalJson({
    schemaVersion: "tcrn.knowledge-mutation-claim.v1", workspaceId: marker.workspaceId, version: marker.version,
    token: "a".repeat(48), pid: process.pid + 1_000_000, acquiredAt: "2026-06-12T00:00:00Z",
  }));
  const recovered = await recoverKnowledgeStore(fx.workspace);
  assert.deepEqual([recovered.reasonCode, recovered.recovered], ["KNOWLEDGE_RECOVERED", true]);
  assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
});
