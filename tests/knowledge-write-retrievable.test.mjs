// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-308 (TCRN-CROSS-STORY-476 R1, R2, AC1, AC2; TCRN-CROSS-MIN-227 D9).
//
// A card is retrievable the moment it is written: there is no candidate state to write and no
// promotion step to take, so knowledge-promote, knowledge-retire, retire-sweep, retire-proposals
// and the rebase's --retire-invalid are gone. A card retires only when a later card names it with
// --supersedes: a conflicting write without it is refused, and with it the older card leaves
// default retrieval -- TCRN-CROSS-SUB-425 (MIN-239 D3, D4): it is removed, conflict superseded, and
// its body is cleared. Records written before keep what they were written with and stay readable.
//
// The cases that tests/story-377-retire-sweep.test.mjs held for subjects that stay -- the
// supersede, the stale card and the full store, and the historical records -- are carried here;
// that file went with the sweep, the proposals and the fitness statistic it tested.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  captureKnowledgeUnit,
  createKnowledgeUnit,
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
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-26T09:00:00.000Z";
const OWNER = "owner:sub-308";

async function fixture(t, externalKey) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-sub308-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: "2026-01-01T00:00:00Z" });
  const project = await createProject(workspace, {
    occurredAt: "2026-01-01T00:00:01Z",
    externalKey: `${externalKey}-PROJECT`,
    name: "SUB-308 fixture",
  });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { base, workspace, projectId: project.projects[0].id, store: join(workspace, DIRECTORY.knowledge) };
}

// The shape "a source reference makes a candidate" used to catch: a strict-kind card carrying a
// file source and an evidence id.
function sourcedGuide(fx, externalKey, overrides = {}) {
  return {
    occurredAt: "2026-06-12T00:00:00.000Z",
    externalKey,
    scope: "project",
    projectId: fx.projectId,
    roleScopes: [],
    category: "workflow",
    kind: "guide",
    tags: ["zsh", "grep"],
    subject: "zsh grep include pattern needs quotes",
    summary: "An unquoted --include glob in zsh expands before grep sees it and returns a false zero",
    snippet: "quote the --include pattern in zsh",
    accountableOwnerId: OWNER,
    sourceReferences: ["docs/tutorial/governed-loop.md"],
    sourceDigest: canonicalSha256(externalKey),
    supersedes: null,
    linkedWorkIds: [],
    linkedDecisionIds: [],
    linkedGateIds: [],
    linkedEvidenceIds: ["evidence:sub-308"],
    lifecycle: "active",
    retrievalDisposition: "default",
    freshnessState: "fresh",
    lastVerified: "2026-06-12T00:00:00.000Z",
    stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only",
    body: "In zsh, grep --include=*.ts without quotes expands the glob first; quote it.",
    ...overrides,
  };
}

function lesson(externalKey, subject, overrides = {}) {
  return {
    occurredAt: "2026-06-12T00:00:00.000Z", externalKey, subject, summary: `${subject} summary`, snippet: `${subject} snippet`,
    tags: ["lesson"], accountableOwnerId: OWNER, body: `${externalKey} body`, ...overrides,
  };
}

async function cliJson(argv) {
  let output = "";
  await runCli(argv, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function refusalOf(operation) {
  return operation().then(() => null, (error) => error);
}

// Every file of the knowledge store, by relative path. `cardsOnly` keeps the cards themselves,
// without the marker: the event streams (TCRN-CROSS-SUB-414), and metadata/ and bodies/ where an
// older engine's layout holds them.
async function storeBytes(fx, { cardsOnly = false } = {}) {
  const files = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${relative}/`);
      else files[relative] = await readFile(join(directory, entry.name), "utf8");
    }
  };
  await walk(fx.store, "");
  return cardsOnly ? Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith("events/") || path.startsWith("metadata/") || path.startsWith("bodies/"))) : files;
}

// TCRN-CROSS-SUB-414: the latest event this device's stream of the crest holds for a card.
async function storedEvent(fx, id) {
  const [deviceId] = await readdir(join(fx.store, "events"));
  const stream = join(fx.store, "events", deviceId);
  let found = null;
  for (const name of (await readdir(stream)).filter((entry) => entry.endsWith(".json")).sort()) {
    const event = JSON.parse(await readFile(join(stream, name), "utf8"));
    if (event.metadata.id === id) found = event;
  }
  return found;
}

// TCRN-CROSS-SUB-414: the crest as an engine before event streams left it -- one metadata file and
// one body file per card, the marker's version counting its writes -- laid down from what the
// streams hold now, the streams taken away.
async function asOlderEngineCrest(fx) {
  const all = await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all", limit: 1_000_000 });
  const marker = await readKnowledgeStoreMarker(fx.workspace);
  const [deviceId] = await readdir(join(fx.store, "events"));
  const stream = join(fx.store, "events", deviceId);
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

test("476-AC1: a card is retrieved the moment it is written, and nothing about it is a candidate", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-308-WRITTEN");
  await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-OTHER-A", "portal port collides with another dev server"));
  await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-OTHER-B", "worktree git file breaks the output session"));
  const created = await createKnowledgeUnit(fx.workspace, sourcedGuide(fx, "SUB-308-SOURCED-GUIDE"));
  assert.equal(created.reasonCode, "KNOWLEDGE_UNIT_CREATED");

  // Stored: active, with no retired promotion marker or candidate state -- as the one event this
  // device's stream holds for it (TCRN-CROSS-SUB-414).
  const stored = (await storedEvent(fx, created.id)).metadata;
  assert.equal(stored.lifecycle, "active");
  assert.equal(Object.hasOwn(stored, "promotionState"), false);
  assert.equal(Object.values(stored).includes("candidate"), false, "no candidate state on the written record");

  // Retrieved at once, with no step between the write and the reads.
  const listed = await listKnowledgeMetadata(fx.workspace, { at: AT });
  assert.equal(listed.records.some((record) => record.id === created.id), true, "the default selection answers with it");
  assert.equal((await readKnowledgeBody(fx.workspace, created.id, { at: AT })).body, sourcedGuide(fx, "X").body);
  // A three-card library lowers the strong-hit default calibrated on the cross-project chain (TCRN-CROSS-SUB-303).
  const recalled = await cliJson(["recall", "--workspace", fx.workspace, "--at", AT, "--query", "zsh grep include quotes", "--tau", "1"]);
  assert.equal(recalled.knowledgeReasonCode, "KNOWLEDGE_LIST_READY");
  assert.equal(recalled.records[0]?.id, created.id, "recall answers with the card it was asked about");
  // A card hit names its store (TCRN-CROSS-STORY-476 R5, TCRN-CROSS-SUB-311).
  assert.deepEqual(Object.keys(recalled.records[0]).sort(), ["id", "key", "kind", "line", "parentChain", "scope", "score", "status", "summary", "title"]);
  assert.equal(recalled.records[0].scope, "project");
  assert.equal(recalled.records[0].status, "active");

  // A capture naming a source, and a create that leaves the lifecycle out, land the same way.
  const captured = await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-CAPTURED", "captured lesson names a source", { sourceReferences: ["docs/tutorial/governed-loop.md"] }));
  const withoutLifecycle = sourcedGuide(fx, "SUB-308-NO-LIFECYCLE", { subject: "lifecycle omitted write lands active", tags: ["lifecycle"], coexist: true });
  delete withoutLifecycle.lifecycle;
  const omitted = await createKnowledgeUnit(fx.workspace, withoutLifecycle);
  const all = await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" });
  assert.deepEqual(all.records.map((record) => record.lifecycle), Array(all.total).fill("active"));
  assert.equal(all.records.some((record) => Object.hasOwn(record, "promotionState")), false);
  const defaults = (await listKnowledgeMetadata(fx.workspace, { at: AT })).records.map((record) => record.id);
  for (const id of [captured.id, omitted.id]) assert.equal(defaults.includes(id), true, id);
});

test("476-R1: a write that names the candidate or the retired lifecycle is refused before anything is written", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-308-REFUSED");
  const before = await storeBytes(fx);
  for (const lifecycle of ["candidate", "retired"]) {
    const refused = await refusalOf(() => createKnowledgeUnit(fx.workspace, sourcedGuide(fx, `SUB-308-${lifecycle.toUpperCase()}`, { lifecycle })));
    assert.equal(refused?.reasonCode, "KNOWLEDGE_LIFECYCLE_RETIRED", lifecycle);
    assert.deepEqual([refused.details.required, refused.details.actual], ["active", lifecycle]);
    assert.equal(typeof refused.details.remedy, "string");
  }
  const garbage = await refusalOf(() => createKnowledgeUnit(fx.workspace, sourcedGuide(fx, "SUB-308-GARBAGE", { lifecycle: "sideways" })));
  assert.equal(garbage?.reasonCode, "KNOWLEDGE_INPUT_INVALID", "a value that was never a lifecycle is not a retired one");
  assert.deepEqual(await storeBytes(fx), before, "no refusal wrote a byte");
  assert.equal((await validateKnowledgeStore(fx.workspace)).records, 0);
});

test("476-R1, R2: the promotion and retirement verbs are gone from the catalog and the CLI", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-308-VERBS");
  const names = COMMAND_CATALOG.map((entry) => entry.name);
  for (const verb of ["knowledge-promote", "knowledge-retire", "retire-sweep", "retire-proposals"]) {
    assert.equal(names.includes(verb), false, `${verb} is not in the catalog`);
    const refused = await refusalOf(() => runCli([verb, "--workspace", fx.workspace, "--at", AT], { write() {} }));
    assert.equal(refused?.reasonCode, "CLI_COMMAND_UNKNOWN", verb);
  }
  assert.deepEqual(COMMAND_CATALOG.find((entry) => entry.name === "knowledge-rebase")?.flags.map((flag) => flag.name), ["workspace", "at", "timeout-ms"]);
  const retireInvalid = await refusalOf(() => runCli(["knowledge-rebase", "--workspace", fx.workspace, "--at", AT, "--retire-invalid", "true"], { write() {} }));
  assert.equal(retireInvalid?.reasonCode, "CLI_ARGUMENT_UNKNOWN");
  // The conflict and freshness verbs stay.
  for (const verb of ["knowledge-create", "knowledge-capture", "knowledge-reverify", "knowledge-freshness"]) assert.equal(names.includes(verb), true, verb);
});

// AC2: the one retirement left is the write path's own. A possible conflict is refused, and
// --supersedes removes the older card instead: out of default and searched retrieval, and, since
// TCRN-CROSS-SUB-425 (MIN-239 D4), its body cleared and an explicit read of it refused.
test("476-AC2, SUB-425: a conflicting write is refused without --supersedes, and with it the older card is removed and leaves default retrieval", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-308-SUPERSEDE");
  const subject = "SUB-308 only a conflicting write retires a card";
  const old = await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-OLD", subject));
  const refused = await refusalOf(() => captureKnowledgeUnit(fx.workspace, lesson("SUB-308-NEW", subject)));
  assert.equal(refused?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT", "a conflicting write without --supersedes or --coexist is refused");
  assert.deepEqual(refused.details.conflicts, [old.id]);
  const replacement = await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-NEW", subject, { supersedes: old.id }));
  assert.equal(replacement.superseded, old.id);
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.some((record) => record.id === old.id), false, "no valid card any more");
  const replaced = (await listKnowledgeMetadata(fx.workspace, { at: AT, status: "removed" })).records.find((record) => record.id === old.id);
  assert.deepEqual([replaced.status, replaced.removal.reason, replaced.removal.supersededBy], ["removed", "superseded", replacement.id], "the older card is removed, conflict superseded");
  assert.equal((await refusalOf(() => readKnowledgeBody(fx.workspace, old.id, { at: AT })))?.reasonCode, "KNOWLEDGE_CARD_REMOVED", "its body is cleared, and an explicit read refused");
  assert.deepEqual((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.map((record) => record.id), [replacement.id], "default retrieval answers with the new card only");
  assert.deepEqual((await listKnowledgeMetadata(fx.workspace, { at: AT, search: "conflicting" })).records.map((record) => record.id), [replacement.id], "and so does a search");
  const recalled = await cliJson(["recall", "--workspace", fx.workspace, "--at", AT, "--query", subject, "--tau", "0"]);
  assert.deepEqual(recalled.records.filter((record) => record.kind === "card").map((record) => record.id), [replacement.id], "recall never answers with the superseded card");
});

test("SUB-386: a superseded card is not a default conflict candidate", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-386-SUPERSEDED-CONFLICT");
  const oldSubject = "Bison range mapping in alpine valleys";
  const old = await captureKnowledgeUnit(fx.workspace, lesson("SUB-386-OLD-BISON", oldSubject));
  await captureKnowledgeUnit(fx.workspace, lesson("SUB-386-REPLACEMENT-ELEPHANT", "Elephant watering schedule", { supersedes: old.id }));

  const recreated = await captureKnowledgeUnit(fx.workspace, lesson("SUB-386-RECREATED-BISON", oldSubject));
  assert.equal(recreated.reasonCode, "KNOWLEDGE_UNIT_CREATED", "the superseded Bison card is excluded from default conflict candidates");
  assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.some((record) => record.id === old.id), false);
});

// MIN-225 AC3, kept: time and size retire nothing. A card past its maximumAgeDays turns stale and
// stays active with its body. TCRN-CROSS-SUB-310 R17 (MIN-238 D1): no store fills any more, so a
// crest past the old 131,072-byte default of knowledge.aggregateBytes takes the next card, and
// nothing is evicted to make room.
test("MIN-225, R17: a stale card and a store past the old default lose nothing", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-308-STALE");
  const stale = await createKnowledgeUnit(fx.workspace, sourcedGuide(fx, "SUB-308-STALE", {
    kind: "fact", subject: "SUB-308 stale fact", tags: ["fitness"], sourceReferences: [],
    stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" },
  }));
  const cards = await storeBytes(fx, { cardsOnly: true });
  for (const at of [AT, "2027-09-10T12:00:00.000Z", "2036-09-10T12:00:00.000Z"]) {
    const listed = (await listKnowledgeMetadata(fx.workspace, { at, selection: "all" })).records.find((record) => record.id === stale.id);
    const freshness = (await evaluateKnowledgeFreshness(fx.workspace, at)).records.find((record) => record.id === stale.id);
    assert.deepEqual([listed.lifecycle, freshness.state], ["active", "stale"], `${at}: past maximumAgeDays the card is stale, not retired`);
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at })).records.some((record) => record.id === stale.id), false, "and default retrieval leaves it out");
  }
  assert.deepEqual(await storeBytes(fx, { cardsOnly: true }), cards, "its metadata and body are byte-identical");

  const full = await fixture(t, "FIXTURE-SUB-308-FULL");
  const written = [];
  // Seventeen 8,000-byte bodies are 136,000 bytes: the old default refused the seventeenth.
  for (let index = 0; index < 17; index += 1) {
    written.push(await captureKnowledgeUnit(full.workspace, lesson(`SUB-308-FULL-${index}`, `SUB-308 full store card ${index}`, { body: `${"x".repeat(7_998)}${String(index).padStart(2, "0")}`, coexist: true })));
  }
  assert.deepEqual(written.map((entry) => entry.reasonCode), Array(17).fill("KNOWLEDGE_UNIT_CREATED"), "no write is refused for the store's size");
  const fullCards = await storeBytes(full, { cardsOnly: true });
  const again = await captureKnowledgeUnit(full.workspace, lesson("SUB-308-FULL-AGAIN", "SUB-308 one more card", { body: `${"y".repeat(700)}`, coexist: true }));
  assert.equal(again.reasonCode, "KNOWLEDGE_UNIT_CREATED", "the next card is admitted");
  const afterCards = await storeBytes(full, { cardsOnly: true });
  assert.deepEqual(Object.fromEntries(Object.keys(fullCards).map((path) => [path, afterCards[path]])), fullCards, "and evicts nothing: every earlier card keeps its bytes");
  assert.deepEqual((await listKnowledgeMetadata(full.workspace, { at: AT, selection: "all", limit: 64 })).records.map((record) => `${record.id}|${record.lifecycle}`).sort(),
    [...written, again].map((entry) => `${entry.id}|active`).sort());
});

// What a 1.2.0 store may hold stays readable: a card a fitness sweep retired with its retirement
// record, the marker's lastSweepAt, and a retire that stopped after its metadata write, which
// knowledge-recover still completes by reclaiming the body once. The telemetry verbs stay retired.
// TCRN-CROSS-SUB-414: that engine wrote the metadata/body layout, which asOlderEngineCrest lays down;
// the recovery completes the stopped retire without writing store.json.
test("historical records stay readable, and knowledge-recover still completes a stopped retire", async (t) => {
  const fx = await fixture(t, "FIXTURE-SUB-308-HISTORY");
  const swept = await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-SWEPT", "SUB-308 a card a sweep retired"));
  const kept = await captureKnowledgeUnit(fx.workspace, lesson("SUB-308-KEPT", "SUB-308 a card nothing retired", { coexist: true }));
  await asOlderEngineCrest(fx);
  const retirement = { schemaVersion: "tcrn.knowledge-retirement.v1", id: swept.id, reason: "zero-retrieval-zero-reference", retrievalCount: 0, referenceCount: 0, observedEvents: 1, windowDays: 90, windowStart: "2026-06-03T00:00:00.000Z", windowEnd: "2026-08-31T23:59:59.999Z", sweptAt: "2026-09-01T00:47:10.039Z" };
  // The retire as 1.2.0 wrote it, stopped after its metadata: the record is retired, its body is
  // still on disk, and the mutation claim of a process that is gone is left behind.
  const metadataPath = join(fx.store, "metadata", `${swept.id}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, canonicalJson({ ...metadata, lifecycle: "retired", revision: metadata.revision + 1, updatedAt: retirement.sweptAt, retirement }));
  const marker = await readKnowledgeStoreMarker(fx.workspace);
  await writeFile(join(fx.store, "mutation.claim"), canonicalJson({
    schemaVersion: "tcrn.knowledge-mutation-claim.v1", workspaceId: marker.workspaceId, version: marker.version,
    token: "a".repeat(48), pid: process.pid + 1_000_000, acquiredAt: retirement.sweptAt,
  }));
  const manifest = await readFile(join(fx.store, "store.json"));
  const recovered = await recoverKnowledgeStore(fx.workspace);
  assert.deepEqual([recovered.reasonCode, recovered.reclaimedRetiredBodies], ["KNOWLEDGE_RECOVERED", 1]);
  assert.deepEqual(await readFile(join(fx.store, "store.json")), manifest, "the recovery wrote no root manifest");
  assert.equal((await recoverKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_RECOVERY_NOT_NEEDED");
  assert.equal((await readdir(join(fx.store, "bodies"))).includes(`${swept.id}.body`), false, "the retired body is reclaimed once");

  const storeJson = join(fx.store, "store.json");
  await writeFile(storeJson, canonicalJson({ ...JSON.parse(await readFile(storeJson, "utf8")), lastSweepAt: "2026-09-01T00:47:10.039Z" }));
  assert.equal((await readKnowledgeStoreMarker(fx.workspace)).lastSweepAt, "2026-09-01T00:47:10.039Z", "the marker still reads a historical lastSweepAt");
  assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  const all = (await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records;
  const retired = all.find((record) => record.id === swept.id);
  assert.deepEqual([retired.lifecycle, retired.retirement?.sweptAt], ["retired", "2026-09-01T00:47:10.039Z"], "the historical retirement record stays readable");
  assert.deepEqual((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.map((record) => record.id), [kept.id], "and default retrieval leaves the retired card out");
  for (const verb of ["telemetry-list", "telemetry-stats", "telemetry-observation"]) {
    const refused = await refusalOf(() => runCli([verb, "--workspace", fx.workspace], { write() {} }));
    assert.equal(refused?.reasonCode, "CLI_COMMAND_UNKNOWN", `${verb} is retired with the store`);
  }
});
