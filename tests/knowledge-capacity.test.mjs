// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-309 (TCRN-CROSS-STORY-476 R3, Feature Toggle, Implementation Notes).
//
// knowledge.aggregateBytes counts card bodies and nothing else -- not the store marker, not the
// metadata, not the derived index -- and only the bodies of live cards: a card a later card
// superseded gives its body back to the budget while the body stays on disk. The over-limit
// refusal keeps its reason code and names the projected body bytes and the limit. A store
// written before this is recounted on read, and nothing is migrated or rewritten.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { recall, recallDocuments } from "../dist/build/packages/core/src/recall.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import {
  captureKnowledgeUnit,
  createProject,
  evaluateKnowledgeFreshness,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  readKnowledgeBody,
  readKnowledgeStoreMarker,
  setWorkspaceSetting,
  validateKnowledgeStore,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-26T10:00:00.000Z";
const OWNER = "owner:sub-309";

async function fixture(t, externalKey, { aggregateBytes } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-sub309-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: "2026-01-01T00:00:00Z" });
  const project = await createProject(workspace, { occurredAt: "2026-01-01T00:00:01Z", externalKey: `${externalKey}-PROJECT`, name: "SUB-309 fixture" });
  if (aggregateBytes !== undefined) {
    await setWorkspaceSetting(workspace, { key: "knowledge.aggregateBytes", value: String(aggregateBytes), occurredAt: "2026-01-01T00:00:02Z" });
  }
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, projectId: project.projects[0].id, store: join(workspace, DIRECTORY.knowledge) };
}

// Each card has its own subject so no write scores as a conflict with another.
function card(externalKey, subject, body, overrides = {}) {
  return {
    occurredAt: "2026-06-12T00:00:00.000Z", externalKey, subject, summary: `${subject} summary`, snippet: `${subject} snippet`,
    tags: ["capacity"], accountableOwnerId: OWNER, body, ...overrides,
  };
}

function refusalOf(operation) {
  return operation().then(() => null, (error) => error);
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

test("476-R3: capacity counts card bodies only, not the marker or the metadata", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-309-BODIES", { aggregateBytes: 4_096 });
  // Ten cards whose metadata is large (a 1,900-byte summary each) and whose bodies are small.
  // Counted the old way (marker + metadata + body) the second card would already overflow 4 KiB.
  const subjects = ["alpha lesson", "bravo lesson", "charlie lesson", "delta lesson", "echo lesson", "foxtrot lesson", "golf lesson", "hotel lesson", "india lesson", "juliet lesson"];
  const written = [];
  for (const [index, subject] of subjects.entries()) {
    written.push(await captureKnowledgeUnit(fx.workspace, card(`SUB-309-SMALL-${index}`, subject, `${"b".repeat(99)}${index}`, {
      summary: `${subject} ${"s".repeat(1_900)}`, coexist: true,
    })));
  }
  assert.equal(written.length, 10, "every write is admitted");
  const validation = await validateKnowledgeStore(fx.workspace);
  assert.deepEqual(validation.capacity, { bodyBytes: 1_000, limit: 4_096 }, "the report counts the ten 100-byte bodies and nothing else");
  const marker = (await readFile(join(fx.store, "store.json"))).length;
  const stream = await streamOf(fx);
  const metadata = await fileBytes(stream, (name) => name.endsWith(".json"));
  assert.equal(await fileBytes(stream, (name) => name.endsWith(".body")), 1_000);
  assert.ok(marker + metadata > 4_096, `marker and metadata alone exceed the limit and are not charged: ${marker + metadata}`);

  // The limit still binds the bodies: one body that would take the count past it is refused,
  // with the reason code it always had, naming the projected body bytes and the limit.
  const refused = await refusalOf(() => captureKnowledgeUnit(fx.workspace, card("SUB-309-LARGE", "kilo lesson", "l".repeat(3_097))));
  assert.equal(refused?.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED");
  assert.deepEqual(refused.details, { bodyBytes: 4_097, limit: 4_096 });
  const fits = await captureKnowledgeUnit(fx.workspace, card("SUB-309-FITS", "lima lesson", "l".repeat(3_096)));
  assert.equal(fits.reasonCode, "KNOWLEDGE_UNIT_CREATED", "a body that brings the count exactly to the limit is admitted");
  assert.deepEqual((await validateKnowledgeStore(fx.workspace)).capacity, { bodyBytes: 4_096, limit: 4_096 });

  // knowledge-validate on the CLI reports the same measure.
  let output = "";
  await runCli(["knowledge-validate", "--workspace", fx.workspace], { write: (value) => { output += value; } });
  assert.deepEqual(JSON.parse(output).capacity, { bodyBytes: 4_096, limit: 4_096 });
});

test("476-R3: a superseded card gives its body back to the budget, and its body stays readable", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-309-SUPERSEDE", { aggregateBytes: 4_096 });
  const subject = "SUB-309 the old answer to the retry question";
  const old = await captureKnowledgeUnit(fx.workspace, card("SUB-309-OLD", subject, "o".repeat(3_000), {
    summary: "Abandoned quokka migration calendar", snippet: "obsolete quokka travel date",
  }));
  const other = card("SUB-309-OTHER", "unrelated guidance about portal ports", "p".repeat(1_500));
  const full = await refusalOf(() => captureKnowledgeUnit(fx.workspace, other));
  assert.equal(full?.reasonCode, "KNOWLEDGE_LIMIT_EXCEEDED");
  assert.deepEqual(full.details, { bodyBytes: 4_500, limit: 4_096 }, "3,000 + 1,500 does not fit");

  // The replacement is charged its own body less the one it retires: 2,000, not 5,000.
  const replacement = await captureKnowledgeUnit(fx.workspace, card("SUB-309-NEW", subject, "n".repeat(2_000), {
    supersedes: old.id, summary: "Revised quokka migration calendar", snippet: "current quokka travel date",
  }));
  assert.equal(replacement.superseded, old.id);
  assert.deepEqual((await validateKnowledgeStore(fx.workspace)).capacity, { bodyBytes: 2_000, limit: 4_096 }, "the superseded body left the count");
  const admitted = await captureKnowledgeUnit(fx.workspace, other);
  assert.equal(admitted.reasonCode, "KNOWLEDGE_UNIT_CREATED", "and the room it left takes the write that did not fit");
  assert.deepEqual((await validateKnowledgeStore(fx.workspace)).capacity, { bodyBytes: 3_500, limit: 4_096 });

  // Reclaimed from the budget, not from the disk: the old body is still there and still reads.
  const stream = await streamOf(fx);
  const oldEvent = (await Promise.all((await readdir(stream)).filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(join(stream, name), "utf8"))))).find((event) => event.metadata.id === old.id);
  assert.equal((await readdir(stream)).includes(oldEvent.body.file), true);
  assert.equal((await readKnowledgeBody(fx.workspace, old.id, { at: AT })).body, "o".repeat(3_000));
  assert.equal(await fileBytes(stream, (name) => name.endsWith(".body")), 6_500, "three bodies on disk, 3,500 bytes of them charged");
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.some((record) => record.id === old.id), false);
  const defaultCards = await readRecallCards(fx.workspace, { at: AT });
  assert.equal(defaultCards.cards.some((record) => record.id === old.id), false, "superseded metadata is outside default recall");
  const recallResult = recall({
    cacheKey: "sub309-superseded-default-recall",
    checkpoint: defaultCards.digest,
    documents: () => recallDocuments({ cards: defaultCards.cards }),
    query: "obsolete quokka travel date",
    tau: 0,
  });
  assert.equal(recallResult.records.some((record) => record.id === old.id), false, "the retired body is auditable but never a default recall hit");
});

test("476 Implementation Notes: an existing store is recounted on read, with no migration write", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-309-EXISTING");
  const live = await captureKnowledgeUnit(fx.workspace, card("SUB-309-LIVE", "mike lesson", "m".repeat(700)));
  const subject = "SUB-309 november lesson written twice";
  const replaced = await captureKnowledgeUnit(fx.workspace, card("SUB-309-REPLACED", subject, "r".repeat(900)));
  const replacing = await captureKnowledgeUnit(fx.workspace, card("SUB-309-REPLACING", subject, "q".repeat(400), { supersedes: replaced.id }));
  const retired = await captureKnowledgeUnit(fx.workspace, card("SUB-309-RETIRED", "oscar lesson", "x".repeat(1_100)));
  const candidate = await captureKnowledgeUnit(fx.workspace, card("SUB-309-CANDIDATE", "papa lesson", "c".repeat(300)));
  // Lay down what stores written by earlier engines hold: a card an older engine retired with
  // its body still on disk, a card still in the candidate state it was written in, and a card
  // written before `supersedes` and `expansions` existed. None of these shapes is written now,
  // and that engine wrote the metadata/body layout (TCRN-CROSS-SUB-414).
  await asOlderEngineCrest(fx);
  const rewrite = async (id, change) => {
    const path = join(fx.store, "metadata", `${id}.json`);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, canonicalJson(change(metadata)));
  };
  await rewrite(retired.id, (metadata) => ({ ...metadata, lifecycle: "retired", revision: metadata.revision + 1 }));
  await rewrite(candidate.id, (metadata) => ({ ...metadata, lifecycle: "candidate", promotionState: "candidate" }));
  await rewrite(live.id, (metadata) => Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "supersedes" && key !== "expansions")));

  const before = await storeFiles(fx);
  // Counted: the live card, the replacement and the candidate. Not counted: the superseded card
  // and the retired one, whose bodies are still on disk.
  const expected = 700 + 400 + 300;
  assert.deepEqual((await validateKnowledgeStore(fx.workspace)).capacity, { bodyBytes: expected, limit: 131_072 });
  await listKnowledgeMetadata(fx.workspace, { at: AT });
  await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" });
  await readKnowledgeStoreMarker(fx.workspace);
  await evaluateKnowledgeFreshness(fx.workspace, AT);
  assert.deepEqual((await validateKnowledgeStore(fx.workspace)).capacity, { bodyBytes: expected, limit: 131_072 }, "every read measures the same number");
  assert.deepEqual(await storeFiles(fx), before, "no read migrated or rewrote a byte of the store");
  assert.equal((await readdir(join(fx.store, "bodies"))).length, 5, "every body, counted or not, is still on disk");
  assert.equal(replacing.superseded, replaced.id);
});
