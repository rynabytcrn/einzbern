// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-SUB-414 (TCRN-CROSS-STORY-476 D7, MIN-235 D7, O3): a library's crest written by two
// devices. Each device appends its cards to its own event stream, crest/events/<device id>/, and
// those streams are the authority for card metadata and body references; the marker a read answers
// and this device's index view are projections of them, the view kept in the device directory. The
// crest's root manifest, store.json, is written by one operation of this engine, initialization,
// and by nothing else: not a chain write, not a card write, not a supersede, not a rebase, not a
// recovery, not a read.
//
// Every case below runs two devices against one library the way a synced folder shares it: both
// write into the same directory, and "not delivered yet" is the test holding one device's new files
// out of the directory while the other device works, then putting them back. Every step is the
// test's own, in order, so each outcome is the only one it can have.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  cachePath,
  captureKnowledgeUnit,
  createKnowledgeUnit,
  createProject,
  createWork,
  deleteProject,
  deleteWork,
  exportKnowledgeCheckpoint,
  initializeKnowledgeStore,
  initializeLibrary,
  listKnowledgeMetadata,
  migrateKnowledgeBodies,
  readKnowledgeBody,
  readKnowledgeSnippet,
  rebaseKnowledgeStore,
  recoverKnowledgeStore,
  reverifyKnowledgeUnit,
  updateKnowledgeStalenessPolicy,
  validateKnowledgeStore,
  validateWorkspace,
  DIRECTORY,
} from "../dist/build/packages/core/src/index.js";
import { readKnowledgeStoreMarker } from "../dist/build/packages/core/src/knowledge-core.js";
import { applyKnowledgeBatch } from "../dist/build/packages/core/src/knowledge-batch.js";
import { readRecallCards } from "../dist/build/packages/core/src/recall-inputs.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { canonicalJson, canonicalSha256, deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const AT = "2026-09-29T12:00:00Z";
const instant = (second) => `2026-09-29T10:00:${String(second).padStart(2, "0")}Z`;
const OWNER = "owner:sub-414";
const DEVICE_A = "a".repeat(32);
const DEVICE_B = "b".repeat(32);

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// A device directory with a fixed identity, so the order of the device streams -- and so every
// merged answer -- is the same on every run.
async function deviceHome(base, name, deviceId) {
  const home = join(base, name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "device.json"), `${JSON.stringify({ createdAt: "2026-01-01T00:00:00Z", deviceId, displayName: name, schemaVersion: "einzbern.device.v1" })}\n`);
  return home;
}

// Run `operation` as the device whose directory is `home`, and put the process's device back.
async function as(home, operation) {
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  try {
    return await operation();
  } finally {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
  }
}

async function cli(home, args) {
  return as(home, async () => {
    let output = "";
    await runCli(args, { write(value) { output += value; } });
    return JSON.parse(output);
  });
}

function refusalOf(operation) {
  return operation().then(() => null, (error) => error);
}

// A card of the library's crest: scope workspace, so it names no project or work.
function card(externalKey, subject, overrides = {}) {
  return {
    occurredAt: instant(5), externalKey, scope: "workspace", projectId: null, roleScopes: [],
    category: "workflow", kind: "fact", tags: ["devices"], subject, summary: `${subject}, in brief`,
    snippet: `${subject}, the line to recall`, accountableOwnerId: OWNER, sourceReferences: [], sourceDigest: null,
    linkedWorkIds: [], linkedDecisionIds: [], linkedGateIds: [], linkedEvidenceIds: [], retrievalDisposition: "default",
    freshnessState: "fresh", lastVerified: null, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" },
    exportDisposition: "metadata-only", body: `${externalKey} body`, ...overrides,
  };
}

// Two devices, A and B, sharing one library as a synced folder shares it. A laid the library and
// its crest out. `hold(home)` takes what that device wrote since the last `mark(home)` out of the
// folder -- its chain stream goes back to the copy the mark took, and its new crest events and
// bodies leave -- and `deliver(home)` puts them back, as a folder that delivers late would. The
// chain half and the crest half can also be delivered one at a time.
async function twoDevices(context, name) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `einzbern-sub414-${name}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const homeA = await deviceHome(base, "device-a", DEVICE_A);
  const homeB = await deviceHome(base, "device-b", DEVICE_B);
  const workspace = join(base, "shared", ".ether");
  const libraryId = deriveStableId("library", `SUB-414-${name.toUpperCase()}`);
  const project = await as(homeA, async () => {
    await initializeLibrary({ root: workspace, createdAt: instant(0), libraryId });
    const state = await createProject(workspace, { occurredAt: instant(1), externalKey: "SUB-414-PROJECT", name: "Two devices" });
    await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
    return state.projects[0].id;
  });
  const store = join(workspace, DIRECTORY.knowledge);
  const held = join(base, "held");
  await mkdir(held);
  const deviceOf = (home) => (home === homeA ? DEVICE_A : DEVICE_B);
  const marks = new Map();
  const heldChain = new Set();
  const heldCrest = new Set();
  const chainStream = (deviceId) => join(workspace, DIRECTORY.events, deviceId);
  const crestStream = (deviceId) => join(store, "events", deviceId);
  const holdChain = async (home) => {
    const deviceId = deviceOf(home);
    const mark = marks.get(deviceId);
    await rename(chainStream(deviceId), join(held, `${deviceId}-chain`));
    if (mark.chain) await cp(join(held, `${deviceId}-marked`), chainStream(deviceId), { recursive: true });
    heldChain.add(deviceId);
  };
  const holdCrest = async (home) => {
    const deviceId = deviceOf(home);
    const mark = marks.get(deviceId);
    await mkdir(join(held, `${deviceId}-crest`));
    for (const entry of await readdir(crestStream(deviceId))) {
      if (!mark.crest.includes(entry)) await rename(join(crestStream(deviceId), entry), join(held, `${deviceId}-crest`, entry));
    }
    if (mark.crest.length === 0) await rm(crestStream(deviceId), { recursive: true });
    heldCrest.add(deviceId);
  };
  const deliverChain = async (home) => {
    const deviceId = deviceOf(home);
    if (!heldChain.delete(deviceId)) return;
    await rm(chainStream(deviceId), { recursive: true, force: true });
    await rename(join(held, `${deviceId}-chain`), chainStream(deviceId));
  };
  const deliverCrest = async (home) => {
    const deviceId = deviceOf(home);
    if (!heldCrest.delete(deviceId)) return;
    await mkdir(crestStream(deviceId), { recursive: true });
    for (const entry of await readdir(join(held, `${deviceId}-crest`))) {
      await rename(join(held, `${deviceId}-crest`, entry), join(crestStream(deviceId), entry));
    }
    await rm(join(held, `${deviceId}-crest`), { recursive: true });
  };
  return {
    base, workspace, store, libraryId, project, homeA, homeB,
    mark: async (home) => {
      const deviceId = deviceOf(home);
      const copy = join(held, `${deviceId}-marked`);
      await rm(copy, { recursive: true, force: true });
      const chain = await stat(chainStream(deviceId)).then(() => true, () => false);
      if (chain) await cp(chainStream(deviceId), copy, { recursive: true });
      const crest = await stat(crestStream(deviceId)).then(() => true, () => false);
      marks.set(deviceId, { chain, crest: crest ? (await readdir(crestStream(deviceId))).sort() : [] });
    },
    hold: async (home) => {
      await holdChain(home);
      await holdCrest(home);
    },
    deliver: async (home) => {
      await deliverChain(home);
      await deliverCrest(home);
    },
    deliverChain,
    deliverCrest,
  };
}

// Every file of a directory tree by relative path, as bytes.
async function tree(root) {
  const files = {};
  const walk = async (directory, prefix) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${relative}/`);
      else files[relative] = (await readFile(join(directory, entry.name))).toString("base64");
    }
  };
  await walk(root, "");
  return files;
}

// The events of one device's crest stream, in order.
async function streamEvents(store, deviceId) {
  const stream = join(store, "events", deviceId);
  const names = (await readdir(stream).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(stream, name), "utf8"))));
}

// What one device answers about the crest: its list (default and every record), the validation,
// the recall corpus and its own index view. Two devices that project one crest answer the same.
async function projection(fx, home) {
  return as(home, async () => ({
    listed: canonicalJson(await listKnowledgeMetadata(fx.workspace, { at: AT })),
    all: canonicalJson(await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })),
    validation: canonicalJson(await validateKnowledgeStore(fx.workspace)),
    recall: (await readRecallCards(fx.workspace, { at: AT })).digest,
    view: await readFile(join(cachePath(fx.libraryId, home), "crest-views", "index.json"), "utf8"),
  }));
}

test("SUB-414: a CLI chain write leaves store.json, the claim and every crest file as they were, and list, write and recall go on", async (context) => {
  const fx = await twoDevices(context, "chain-write");
  const captured = await cli(fx.homeA, ["knowledge-capture", "--workspace", fx.workspace, "--at", instant(5),
    "--subject", "Chain writes leave the crest alone", "--summary", "A chain write does not rewrite the crest",
    "--snippet", "no rebind after a chain write", "--tags", "lesson", "--accountable-owner-id", OWNER, "--body", "The crest projects the head."]);
  assert.equal(captured.reasonCode, "KNOWLEDGE_UNIT_CREATED");
  const before = await tree(fx.store);
  const manifest = await readFile(join(fx.store, "store.json"));
  const chainWrites = [
    ["project-create", "--workspace", fx.workspace, "--at", instant(6), "--external-key", "SUB-414-PROJECT-TWO", "--name", "Second"],
    ["work-create", "--workspace", fx.workspace, "--at", instant(7), "--project-id", fx.project, "--external-key", "SUB-414-WORK",
      "--kind", "Initiative", "--status", "active", "--title", "A chain write"],
    ["work-create", "--workspace", fx.workspace, "--at", instant(8), "--project-id", fx.project, "--external-key", "SUB-414-WORK-TWO",
      "--kind", "Initiative", "--status", "planned", "--title", "Another chain write"],
  ];
  let head = null;
  for (const args of chainWrites) {
    const receipt = await cli(fx.homeA, args);
    assert.equal(receipt.reasonCode, "WORKSPACE_COMMAND_COMPLETED", args[0]);
    head = receipt.headEventHash;
    assert.deepEqual(await tree(fx.store), before, `${args[0]} wrote nothing in the crest: no store.json, no claim, no event`);
  }
  assert.deepEqual(await readFile(join(fx.store, "store.json")), manifest);
  assert.equal((await readdir(fx.store)).includes("mutation.claim"), false);
  // The purpose INC-244 served stays: the knowledge surface answers at the new head, no rebind run.
  const validation = await as(fx.homeA, () => validateKnowledgeStore(fx.workspace));
  assert.equal(validation.eventHighWaterDigest, head, "a read projects the high water at the chain head it replayed");
  assert.equal(validation.version, 1, "one card, so the projected version is one event past the manifest's zero");
  const marker = await as(fx.homeA, () => readKnowledgeStoreMarker(fx.workspace));
  assert.equal(marker.eventHighWaterDigest, head);
  assert.equal(Object.hasOwn(marker, "knowledgeStoreTrailing"), false, "a library's crest never trails its chain");
  const listed = await cli(fx.homeA, ["knowledge-list", "--workspace", fx.workspace, "--at", AT]);
  assert.deepEqual([listed.reasonCode, listed.total], ["KNOWLEDGE_LIST_READY", 1]);
  const written = await cli(fx.homeA, ["knowledge-capture", "--workspace", fx.workspace, "--at", instant(9),
    "--subject", "Portal ports need a free slot", "--summary", "It lands with no rebase", "--snippet", "no rebase needed",
    "--tags", "lesson", "--accountable-owner-id", OWNER, "--body", "Written after three chain writes."]);
  assert.deepEqual([written.reasonCode, written.version], ["KNOWLEDGE_UNIT_CREATED", 2]);
  const recalled = await cli(fx.homeA, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "chain writes leave the crest alone", "--tau", "0"]);
  assert.deepEqual(recalled.knowledgeStores.project, { reasonCode: "KNOWLEDGE_LIST_READY", cards: 2 });
  assert.equal(recalled.records.some((record) => record.id === captured.id), true);
  assert.deepEqual(await readFile(join(fx.store, "store.json")), manifest, "and store.json is still the bytes initialization wrote");
});

test("SUB-414: card writes, supersede, batch, reverify, policy, article refresh, rebase and recover append or read; only initialization writes store.json", async (context) => {
  const fx = await twoDevices(context, "single-writer");
  // Initialization is the one writer: it creates store.json once, and a second one refuses.
  const manifest = await readFile(join(fx.store, "store.json"));
  const marker = JSON.parse(manifest.toString("utf8"));
  assert.deepEqual([marker.workspaceId, marker.version], [fx.libraryId, 0]);
  assert.equal(marker.eventHighWaterDigest, sha256Hex(fx.libraryId), "it binds the library id's own digest, the same bytes on every device");
  assert.deepEqual(await readdir(fx.store), ["store.json"], "cards lay their stream out; initialization writes the manifest alone");
  const again = await as(fx.homeA, () => refusalOf(() => initializeKnowledgeStore(fx.workspace, { disposableAcknowledged: true })));
  assert.equal(again?.reasonCode, "KNOWLEDGE_ALREADY_EXISTS");

  // Every other operation, one at a time: store.json and the claim are untouched, every file the
  // crest held before is byte-identical after (appends only), and the records written land in this
  // device's stream, one event each.
  const operations = [
    ["knowledge-create", 1, () => createKnowledgeUnit(fx.workspace, card("SUB-414-OLD", "Old answer about retries"))],
    ["knowledge-capture", 1, () => captureKnowledgeUnit(fx.workspace, { occurredAt: instant(6), externalKey: "SUB-414-CAPTURED", subject: "Captured lesson on ports", summary: "Ports collide", snippet: "pick a free port", tags: ["lesson"], accountableOwnerId: OWNER, body: "Captured body." })],
    ["supersede", 1, async () => createKnowledgeUnit(fx.workspace, card("SUB-414-NEW", "Old answer about retries, revised", { occurredAt: instant(7), supersedes: deriveStableId("knowledge", "SUB-414-OLD") }))],
    ["knowledge-batch", 3, () => applyKnowledgeBatch(fx.workspace, { schemaVersion: "tcrn.knowledge-batch.v1", members: [
      { verb: "knowledge-create", ...card("SUB-414-BATCH", "Batched rule about file locks") },
      { verb: "knowledge-policy", externalKey: "SUB-414-BATCH", stalenessPolicy: { maximumAgeDays: 90, unknownDisposition: "fail-closed" } },
      { verb: "knowledge-reverify", externalKey: "SUB-414-BATCH" },
    ] }, { occurredAt: instant(8), alignFirst: true })],
    ["knowledge-reverify", 1, () => reverifyKnowledgeUnit(fx.workspace, { expectedRevision: 1, occurredAt: instant(9), id: deriveStableId("knowledge", "SUB-414-CAPTURED") })],
    ["knowledge-policy", 1, () => updateKnowledgeStalenessPolicy(fx.workspace, { expectedRevision: 2, occurredAt: instant(10), id: deriveStableId("knowledge", "SUB-414-CAPTURED"), stalenessPolicy: { maximumAgeDays: 30, unknownDisposition: "fail-closed" } })],
    ["knowledge-article-create", 1, () => runCli(["knowledge-article-create", "--workspace", fx.workspace, "--at", instant(11), "--path", "sub-414.md", "--category", "workflow",
      "--title", "Crest article notes", "--summary", "Crest article", "--content", "Every device appends.", "--accountable-owner-id", OWNER, "--evidence-ids", "evidence:sub-414"], { write() {} })],
    ["knowledge-rebase", 0, () => rebaseKnowledgeStore(fx.workspace, { at: instant(12) })],
    ["knowledge-recover", 0, () => recoverKnowledgeStore(fx.workspace)],
    ["reads", 0, async () => {
      await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" });
      await readKnowledgeSnippet(fx.workspace, deriveStableId("knowledge", "SUB-414-NEW"));
      await readKnowledgeBody(fx.workspace, deriveStableId("knowledge", "SUB-414-OLD"), { at: AT });
      await validateKnowledgeStore(fx.workspace);
      await exportKnowledgeCheckpoint(fx.workspace, AT);
      await readRecallCards(fx.workspace, { at: AT });
    }],
  ];
  await as(fx.homeA, async () => {
    for (const [label, appended, operation] of operations) {
      const before = await tree(fx.store);
      const eventsBefore = (await streamEvents(fx.store, DEVICE_A)).length;
      await operation();
      const after = await tree(fx.store);
      assert.deepEqual(await readFile(join(fx.store, "store.json")), manifest, `${label} left store.json as initialization wrote it`);
      assert.equal(Object.hasOwn(after, "mutation.claim"), false, `${label} took no claim`);
      for (const [path, bytes] of Object.entries(before)) assert.equal(after[path], bytes, `${label} rewrote nothing: ${path}`);
      const events = await streamEvents(fx.store, DEVICE_A);
      assert.equal(events.length - eventsBefore, appended, `${label} appended ${appended} event(s) to this device's stream`);
      for (const event of events.slice(eventsBefore)) assert.equal(event.deviceId, DEVICE_A);
    }
  });
  // The supersede wrote one record, the new card's: the old card is marked by projection, and its
  // own event is the one it was written with.
  const events = await streamEvents(fx.store, DEVICE_A);
  const old = events.filter((event) => event.metadata.externalKey === "SUB-414-OLD");
  assert.equal(old.length, 1);
  assert.deepEqual(old[0].metadata.extensions, {});
  const all = await as(fx.homeA, () => listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" }));
  const projected = all.records.find((record) => record.externalKey === "SUB-414-OLD");
  assert.deepEqual([projected.extensions.supersededBy, projected.revision], [deriveStableId("knowledge", "SUB-414-NEW"), 2]);
  // A card written again names the stored record it replaces; the captured card was written three times.
  const captured = events.filter((event) => event.metadata.externalKey === "SUB-414-CAPTURED");
  assert.deepEqual(captured.map((event) => event.metadata.revision), [1, 2, 3]);
  assert.equal(captured[0].replaces, null);
  for (const [index, event] of captured.entries()) {
    if (index > 0) assert.equal(event.replaces, sha256Hex(canonicalJson(captured[index - 1].metadata)), "each record names the one it replaces");
  }
});

test("SUB-414: two devices each write cards and chain events before either receives the other's; delivered, both project one crest and lose nothing", async (context) => {
  const fx = await twoDevices(context, "merge");
  const manifest = await readFile(join(fx.store, "store.json"));
  const workId = (state, key) => state.work.find((record) => record.externalKey === key).id;
  // A, before B has anything of it: a card, a chain write, and a card about the work it wrote.
  await fx.mark(fx.homeA);
  const a1 = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-A1", "Heron wading depth")));
  const stateA = await as(fx.homeA, () => createWork(fx.workspace, { occurredAt: instant(6), projectId: fx.project, externalKey: "SUB-414-WORK-A", kind: "Initiative", parentId: null, status: "active" }));
  const a2 = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-A2", "Kestrel hover timing", {
    occurredAt: instant(7), scope: "project", projectId: fx.project, linkedWorkIds: [workId(stateA, "SUB-414-WORK-A")],
  })));
  await fx.hold(fx.homeA);
  // B, before A's writes arrive: the same, on its own streams.
  await fx.mark(fx.homeB);
  const b1 = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-B1", "Beaver dam height")));
  const stateB = await as(fx.homeB, () => createWork(fx.workspace, { occurredAt: instant(8), projectId: fx.project, externalKey: "SUB-414-WORK-B", kind: "Initiative", parentId: null, status: "active" }));
  const b2 = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-B2", "Otter slide angle", {
    occurredAt: instant(9), scope: "project", projectId: fx.project, linkedWorkIds: [workId(stateB, "SUB-414-WORK-B")],
  })));
  for (const created of [a1, a2, b1, b2]) assert.deepEqual([created.reasonCode, created.version], ["KNOWLEDGE_UNIT_CREATED", created === a1 || created === b1 ? 1 : 2]);
  const beforeDelivery = await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" }));
  assert.deepEqual(beforeDelivery.records.map((record) => record.externalKey), ["SUB-414-B1", "SUB-414-B2"].sort((l, r) => deriveStableId("knowledge", l) < deriveStableId("knowledge", r) ? -1 : 1));

  await fx.deliver(fx.homeA);
  const onA = await projection(fx, fx.homeA);
  const onB = await projection(fx, fx.homeB);
  assert.deepEqual(onA, onB, "once delivered, both devices project the same crest, down to each one's index view");
  const all = JSON.parse(onA.all);
  assert.deepEqual(all.records.map((record) => record.externalKey).sort(), ["SUB-414-A1", "SUB-414-A2", "SUB-414-B1", "SUB-414-B2"], "no write of either device is lost");
  assert.equal(JSON.parse(onA.listed).total, 4, "and every card answers the default selection: no pair, no duplicate, nothing awaiting");
  const validation = JSON.parse(onA.validation);
  assert.equal(validation.version, 4, "four events, one per card, over a manifest at version zero");
  const chain = await as(fx.homeB, () => validateWorkspace(fx.workspace));
  assert.equal(validation.eventHighWaterDigest, chain.headEventHash, "bound to the merged chain head both devices now hold");
  assert.deepEqual(["SUB-414-WORK-A", "SUB-414-WORK-B"].map((key) => chain.work.some((record) => record.externalKey === key)), [true, true], "and both chain writes are in it");
  // Each stream holds only its own device's cards, and no file was shared.
  assert.deepEqual((await streamEvents(fx.store, DEVICE_A)).map((event) => [event.deviceId, event.metadata.externalKey]), [[DEVICE_A, "SUB-414-A1"], [DEVICE_A, "SUB-414-A2"]]);
  assert.deepEqual((await streamEvents(fx.store, DEVICE_B)).map((event) => [event.deviceId, event.metadata.externalKey]), [[DEVICE_B, "SUB-414-B1"], [DEVICE_B, "SUB-414-B2"]]);
  assert.deepEqual(await readFile(join(fx.store, "store.json")), manifest, "neither device's writes touched store.json");
  assert.equal((await readdir(fx.store)).includes("mutation.claim"), false);
  // Both go on writing, reading and recalling.
  await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-A3", "Crane migration route", { occurredAt: instant(10) })));
  await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-B3", "Stork nest chimney", { occurredAt: instant(11) })));
  const later = await projection(fx, fx.homeA);
  assert.deepEqual(await projection(fx, fx.homeB), later);
  assert.equal(JSON.parse(later.listed).total, 6);
  const recalled = await as(fx.homeB, () => readRecallCards(fx.workspace, { at: AT }));
  assert.deepEqual([recalled.stores.project.reasonCode, recalled.stores.project.cards], ["KNOWLEDGE_LIST_READY", 6]);
});

test("SUB-414: a pair two devices wrote about one thing, and one key both wrote, are what SUB-310 (a) and SUB-413 make of them in a library's crest", async (context) => {
  const fx = await twoDevices(context, "conflicts");
  const control = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CONTROL", "Wombat burrow etiquette")));
  await fx.mark(fx.homeA);
  const gullA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-A", "Gull nesting cliff survey", { occurredAt: instant(6) })));
  const keyA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-SHARED-KEY", "Kestrel hover timing", { occurredAt: instant(7), body: "A's kestrel version" })));
  await fx.hold(fx.homeA);
  const gullB = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-B", "Gull nesting cliff census", { occurredAt: instant(8) })));
  const keyB = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-SHARED-KEY", "Beaver dam height", { occurredAt: instant(9), body: "B's beaver version" })));
  assert.equal(keyA.id, keyB.id, "one external key is one id");
  await fx.deliver(fx.homeA);

  const onA = await projection(fx, fx.homeA);
  assert.deepEqual(await projection(fx, fx.homeB), onA, "both devices read the pair and the duplicate the same way");
  const listed = JSON.parse(onA.listed);
  assert.deepEqual(listed.records.map((record) => record.id), [control.id], "default selection leaves out both cards of the pair and every version of the key");
  assert.deepEqual(listed.unresolvedConflicts, [[gullA.id, gullB.id].sort()]);
  const versionsOnDisk = [];
  for (const deviceId of [DEVICE_A, DEVICE_B]) {
    for (const event of await streamEvents(fx.store, deviceId)) {
      if (event.metadata.id !== keyA.id) continue;
      versionsOnDisk.push({ deviceId, sequence: event.sequence, eventHash: event.eventHash, updatedAt: event.metadata.updatedAt, subject: event.metadata.subject, bodySha256: event.metadata.bodySha256 });
    }
  }
  assert.deepEqual(listed.unresolvedDuplicates, [{ id: keyA.id, externalKey: "SUB-414-SHARED-KEY", versions: versionsOnDisk }], "the duplicate names both devices and their versions");
  assert.equal(JSON.parse(onA.all).total, 5, "--selection all lists the pair's cards and each version");
  await as(fx.homeB, async () => {
    const snippet = await readKnowledgeSnippet(fx.workspace, keyA.id);
    assert.deepEqual(snippet.versions.map((version) => [version.deviceId, version.subject]), [[DEVICE_A, "Kestrel hover timing"], [DEVICE_B, "Beaver dam height"]]);
    assert.deepEqual(snippet.unresolvedDuplicates, listed.unresolvedDuplicates);
    const body = await readKnowledgeBody(fx.workspace, keyA.id, { at: AT });
    assert.deepEqual(body.versions.map((version) => version.body), ["A's kestrel version", "B's beaver version"]);
    // Every other card reads, recalls and is written as before.
    assert.equal((await readKnowledgeBody(fx.workspace, control.id, { at: AT })).body, "SUB-414-CONTROL body");
    const recalled = await readRecallCards(fx.workspace, { at: AT });
    assert.deepEqual(recalled.cards.map((entry) => entry.id), [control.id]);
    assert.deepEqual(recalled.stores.project.unresolvedConflicts, [[gullA.id, gullB.id].sort()]);
    assert.deepEqual(recalled.stores.project.unresolvedDuplicates.map((entry) => entry.id), [keyA.id]);
    // C-R15-1: recall names them at the top of its answer, in the form userCrestDegraded has.
    const withheld = { reasonCode: "KNOWLEDGE_POSSIBLE_CONFLICT", unresolvedConflicts: [[gullA.id, gullB.id].sort()], unresolvedDuplicates: listed.unresolvedDuplicates, withheldCards: 4 };
    assert.deepEqual(recalled.projectCrestDegraded, withheld, "the pair's two cards and the key's two versions");
    const answer = await cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "gull nesting cliff", "--tau", "0"]);
    assert.deepEqual(answer.projectCrestDegraded, withheld);
    assert.deepEqual(answer.knowledgeStores.project, { reasonCode: "KNOWLEDGE_LIST_READY", cards: 1 });
    assert.equal(Object.hasOwn(answer, "userCrestDegraded"), false, "the user crest withheld nothing");
    const unrelated = await createKnowledgeUnit(fx.workspace, card("SUB-414-UNRELATED", "Otter slide angle", { occurredAt: instant(10) }));
    assert.equal(unrelated.reasonCode, "KNOWLEDGE_UNIT_CREATED");
    // A write that has seen them is refused before anything is written, naming what it saw.
    const streamBefore = await tree(join(fx.store, "events"));
    assert.equal((await refusalOf(() => createKnowledgeUnit(fx.workspace, card("SUB-414-SHARED-KEY", "Crane route", { occurredAt: instant(11) }))))?.reasonCode, "KNOWLEDGE_DUPLICATE");
    const conflict = await refusalOf(() => createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-C", "Gull nesting cliff count", { occurredAt: instant(11) })));
    assert.equal(conflict?.reasonCode, "KNOWLEDGE_POSSIBLE_CONFLICT");
    assert.deepEqual(conflict.details.conflicts, [gullA.id, gullB.id].sort());
    assert.equal((await refusalOf(() => reverifyKnowledgeUnit(fx.workspace, { expectedRevision: 1, occurredAt: instant(11), id: keyA.id })))?.reasonCode, "KNOWLEDGE_DUPLICATE", "a key two devices wrote is not one card to write again");
    assert.deepEqual(await tree(join(fx.store, "events")), streamBefore, "no refusal wrote a byte");
    // The existing write path resolves both: a card superseding either card of the pair, and a
    // card superseding the key's id, which replaces every version.
    await createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-RESOLVED", "Gull nesting cliff survey, merged", { occurredAt: instant(12), supersedes: gullA.id }));
    await createKnowledgeUnit(fx.workspace, card("SUB-414-KEY-RESOLVED", "Kestrel hover timing and beaver dams", { occurredAt: instant(13), supersedes: keyA.id }));
  });
  const resolved = await projection(fx, fx.homeA);
  assert.deepEqual(await projection(fx, fx.homeB), resolved);
  const after = JSON.parse(resolved.listed);
  assert.equal(Object.hasOwn(after, "unresolvedConflicts"), false);
  assert.equal(Object.hasOwn(after, "unresolvedDuplicates"), false);
  assert.deepEqual(after.records.map((record) => record.externalKey).sort(), ["SUB-414-CONTROL", "SUB-414-GULL-B", "SUB-414-GULL-RESOLVED", "SUB-414-KEY-RESOLVED", "SUB-414-UNRELATED"]);
  const versions = JSON.parse(resolved.all).records.filter((record) => record.id === keyA.id);
  assert.deepEqual(versions.map((record) => record.extensions.supersededBy), [deriveStableId("knowledge", "SUB-414-KEY-RESOLVED"), deriveStableId("knowledge", "SUB-414-KEY-RESOLVED")], "every version is replaced, and stays readable by the id");
  assert.equal((await as(fx.homeA, () => readRecallCards(fx.workspace, { at: AT }))).projectCrestDegraded, null, "resolved, the crest withholds nothing");
  assert.equal(Object.hasOwn(await cli(fx.homeA, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "gull nesting cliff", "--tau", "0"]), "projectCrestDegraded"), false);
});

// A card is written again as a new record naming the record it replaces. The device that receives
// a card and writes it again replaces it; two devices that each write it again before either sees
// the other's both keep their record, as a duplicate. Red leg: merge by revision or by device alone
// and the first case forms a false duplicate, or the second silently keeps one rewrite.
test("SUB-414: a card the other device writes again is replaced; written again on both before either sees the other's, neither record is lost", async (context) => {
  const fx = await twoDevices(context, "rewrites");
  const heron = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-HERON", "Heron wading depth")));
  const reverified = await as(fx.homeB, () => reverifyKnowledgeUnit(fx.workspace, { expectedRevision: 1, occurredAt: instant(6), id: heron.id }));
  assert.equal(reverified.revision, 2);
  for (const home of [fx.homeA, fx.homeB]) {
    const listed = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
    assert.deepEqual(listed.records.map((record) => [record.id, record.revision, record.lastVerified]), [[heron.id, 2, instant(6)]], "B's record replaces A's: one card");
    assert.equal(Object.hasOwn(listed, "unresolvedDuplicates"), false);
  }
  const [b2] = await streamEvents(fx.store, DEVICE_B);
  const [a1] = await streamEvents(fx.store, DEVICE_A);
  assert.equal(b2.replaces, sha256Hex(canonicalJson(a1.metadata)), "the record names the one it replaces, whichever device wrote that");
  // Both write the card again before either sees the other's rewrite.
  await fx.mark(fx.homeA);
  await as(fx.homeA, () => updateKnowledgeStalenessPolicy(fx.workspace, { expectedRevision: 2, occurredAt: instant(7), id: heron.id, stalenessPolicy: { maximumAgeDays: 90, unknownDisposition: "fail-closed" } }));
  await fx.hold(fx.homeA);
  await as(fx.homeB, () => reverifyKnowledgeUnit(fx.workspace, { expectedRevision: 2, occurredAt: instant(8), id: heron.id }));
  await fx.deliver(fx.homeA);
  const onA = await projection(fx, fx.homeA);
  assert.deepEqual(await projection(fx, fx.homeB), onA);
  const listed = JSON.parse(onA.listed);
  assert.deepEqual(listed.records, [], "neither rewrite is the card while both stand");
  assert.deepEqual(listed.unresolvedDuplicates.map((entry) => [entry.id, entry.versions.map((version) => [version.deviceId, version.updatedAt])]),
    [[heron.id, [[DEVICE_A, instant(7)], [DEVICE_B, instant(8)]]]], "both rewrites stand as versions, one per device");
  assert.deepEqual((await as(fx.homeB, () => readRecallCards(fx.workspace, { at: AT }))).projectCrestDegraded,
    { reasonCode: "KNOWLEDGE_DUPLICATE", unresolvedDuplicates: listed.unresolvedDuplicates, withheldCards: 2 }, "a duplicate alone is named as KNOWLEDGE_DUPLICATE, both versions withheld");
  const all = JSON.parse(onA.all).records.filter((record) => record.id === heron.id);
  assert.deepEqual(all.map((record) => [record.revision, record.stalenessPolicy.maximumAgeDays, record.lastVerified]), [[3, 90, instant(6)], [3, null, instant(8)]]);
  // A write that supersedes the id resolves it, as it resolves any duplicate.
  await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-HERON-MERGED", "Heron wading depth, both rewrites", { occurredAt: instant(9), supersedes: heron.id })));
  const resolved = await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
  assert.deepEqual(resolved.records.map((record) => record.externalKey), ["SUB-414-HERON-MERGED"]);
  assert.equal(Object.hasOwn(resolved, "unresolvedDuplicates"), false);
});

// problems-r15-crest-dupkey #3, second half, for a library's crest: a folder can deliver the stream
// of a card that supersedes another before the stream of the card it names. The replacement stands
// and nothing refuses the crest; the named card is replaced once it arrives. Red leg: refuse a
// supersedes whose target is absent and the whole crest reads KNOWLEDGE_LINK_INVALID meanwhile.
test("SUB-414: a replacement delivered before the card it replaces stands, and that card is replaced when it arrives", async (context) => {
  const fx = await twoDevices(context, "pending-supersedes");
  const heron = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-HERON", "Heron wading depth")));
  const replacement = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-HERON-NEW", "Heron wading depth, measured", { occurredAt: instant(6), supersedes: heron.id })));
  // A third device's view: B's stream has arrived, A's has not.
  const homeC = await deviceHome(fx.base, "device-c", "c".repeat(32));
  const aside = join(fx.base, "held", "a-crest-stream");
  await rename(join(fx.store, "events", DEVICE_A), aside);
  await as(homeC, async () => {
    const listed = await listKnowledgeMetadata(fx.workspace, { at: AT });
    assert.deepEqual(listed.records.map((record) => record.id), [replacement.id], "the replacement stands");
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
  });
  await rename(aside, join(fx.store, "events", DEVICE_A));
  await as(homeC, async () => {
    const all = await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" });
    assert.equal(all.records.find((record) => record.id === heron.id).extensions.supersededBy, replacement.id, "and the card it names is replaced once it arrives");
    assert.deepEqual((await listKnowledgeMetadata(fx.workspace, { at: AT })).records.map((record) => record.id), [replacement.id]);
  });
});

test("SUB-414: a card delivered before the chain events it was written against waits for them, named, while the strict surfaces refuse", async (context) => {
  const fx = await twoDevices(context, "awaiting");
  const own = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-B-OWN", "Beaver dam height")));
  await fx.mark(fx.homeA);
  const state = await as(fx.homeA, () => createWork(fx.workspace, { occurredAt: instant(6), projectId: fx.project, externalKey: "SUB-414-WORK-LATE", kind: "Initiative", parentId: null, status: "active" }));
  const workId = state.work.find((record) => record.externalKey === "SUB-414-WORK-LATE").id;
  const waiting = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-WAITING", "Kestrel hover timing", {
    occurredAt: instant(7), scope: "project", projectId: fx.project, linkedWorkIds: [workId],
  })));
  await fx.hold(fx.homeA);
  // The folder delivers A's crest stream first; A's chain stream, holding the work, comes later.
  await fx.deliverCrest(fx.homeA);
  const [event] = await streamEvents(fx.store, DEVICE_A);
  const awaiting = [{ id: waiting.id, deviceId: DEVICE_A, sequence: event.sequence, eventHash: event.eventHash }];
  await as(fx.homeB, async () => {
    const listed = await listKnowledgeMetadata(fx.workspace, { at: AT });
    assert.deepEqual(listed.records.map((record) => record.id), [own.id], "the waiting card leaves default selection; B's own card does not");
    assert.deepEqual(listed.awaitingChain, awaiting, "and the list names it, its device and its event");
    assert.equal((await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).total, 2);
    assert.deepEqual((await readKnowledgeSnippet(fx.workspace, waiting.id)).awaitingChain, awaiting);
    for (const strict of [() => validateKnowledgeStore(fx.workspace), () => exportKnowledgeCheckpoint(fx.workspace, AT), () => rebaseKnowledgeStore(fx.workspace, { at: AT })]) {
      const refused = await refusalOf(strict);
      assert.equal(refused?.reasonCode, "KNOWLEDGE_HIGH_WATER_MISMATCH");
      assert.deepEqual(refused.details.awaitingChain, awaiting);
    }
    const recalled = await readRecallCards(fx.workspace, { at: AT });
    assert.deepEqual(recalled.cards.map((entry) => entry.id), [own.id]);
    // C-R15-1: recall names the waiting record at its top; waiting alone is the strict surfaces' refusal.
    const withheld = { reasonCode: "KNOWLEDGE_HIGH_WATER_MISMATCH", awaitingChain: awaiting, withheldCards: 1 };
    assert.deepEqual(recalled.projectCrestDegraded, withheld);
    assert.deepEqual((await cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "kestrel hover timing", "--tau", "0"])).projectCrestDegraded, withheld);
    const unrelated = await createKnowledgeUnit(fx.workspace, card("SUB-414-B-UNRELATED", "Otter slide angle", { occurredAt: instant(8) }));
    assert.equal(unrelated.reasonCode, "KNOWLEDGE_UNIT_CREATED", "an unrelated write lands while the card waits");
  });
  await fx.deliverChain(fx.homeA);
  await as(fx.homeB, async () => {
    const listed = await listKnowledgeMetadata(fx.workspace, { at: AT });
    assert.equal(Object.hasOwn(listed, "awaitingChain"), false);
    assert.deepEqual(listed.records.map((record) => record.id).sort(), [own.id, waiting.id, deriveStableId("knowledge", "SUB-414-B-UNRELATED")].sort());
    assert.equal((await validateKnowledgeStore(fx.workspace)).reasonCode, "KNOWLEDGE_STORE_VALID");
    assert.equal((await readRecallCards(fx.workspace, { at: AT })).projectCrestDegraded, null, "the chain arrived: nothing is withheld");
  });
  assert.deepEqual(await projection(fx, fx.homeA), await projection(fx, fx.homeB));
});

// C-R15-1 for recall: every card a library's crest withheld is named at the top of recall's answer,
// in the form userCrestDegraded has, and a card more than one list names -- a pair's card or a
// duplicate's version that also awaits chain events -- counts once. Red leg: add the three lists up
// and withheldCards says six where four cards are withheld.
test("SUB-414: recall names every card the library's crest withheld at its top, each counted once", async (context) => {
  const fx = await twoDevices(context, "recall-withheld");
  const own = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-B-OWN", "Wombat burrow etiquette")));
  await fx.mark(fx.homeA);
  // A's chain moves first, so every card A writes next awaits that chain event on B until it arrives.
  await as(fx.homeA, () => createWork(fx.workspace, { occurredAt: instant(6), projectId: fx.project, externalKey: "SUB-414-WORK-LATE", kind: "Initiative", parentId: null, status: "active" }));
  const gullA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-A", "Gull nesting cliff survey", { occurredAt: instant(7) })));
  const keyA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-SHARED-KEY", "Kestrel hover timing", { occurredAt: instant(8), body: "A's kestrel version" })));
  await fx.hold(fx.homeA);
  const gullB = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-B", "Gull nesting cliff census", { occurredAt: instant(9) })));
  await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-SHARED-KEY", "Beaver dam height", { occurredAt: instant(10), body: "B's beaver version" })));
  // The folder delivers A's crest stream first; A's chain stream comes later.
  await fx.deliverCrest(fx.homeA);
  const recallOnB = () => cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "gull nesting cliff", "--tau", "0"]);
  const listed = await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
  assert.deepEqual(listed.records.map((record) => record.id), [own.id]);
  assert.deepEqual(listed.unresolvedConflicts, [[gullA.id, gullB.id].sort()]);
  assert.deepEqual(listed.unresolvedDuplicates.map((entry) => entry.id), [keyA.id]);
  assert.deepEqual(listed.awaitingChain.map((entry) => [entry.id, entry.deviceId]), [[gullA.id, DEVICE_A], [keyA.id, DEVICE_A]].sort(), "both of A's cards await its chain");
  const withheld = {
    reasonCode: "KNOWLEDGE_POSSIBLE_CONFLICT", unresolvedConflicts: listed.unresolvedConflicts, unresolvedDuplicates: listed.unresolvedDuplicates,
    awaitingChain: listed.awaitingChain, withheldCards: 4,
  };
  assert.deepEqual((await as(fx.homeB, () => readRecallCards(fx.workspace, { at: AT }))).projectCrestDegraded, withheld, "the pair's two cards and the key's two versions, each once");
  const answer = await recallOnB();
  assert.deepEqual(answer.projectCrestDegraded, withheld);
  assert.deepEqual([answer.knowledgeReasonCode, answer.knowledgeStores.project], ["KNOWLEDGE_LIST_READY", { reasonCode: "KNOWLEDGE_LIST_READY", cards: 1 }]);
  assert.equal(Object.hasOwn(answer, "userCrestDegraded"), false, "the user crest withheld nothing");
  // A's chain arrives: the pair and the duplicate stay withheld, and nothing awaits.
  await fx.deliverChain(fx.homeA);
  const { awaitingChain: _delivered, ...afterChain } = withheld;
  assert.deepEqual((await recallOnB()).projectCrestDegraded, afterChain);
  // The existing write path resolves both, and recall's answer no longer names the crest.
  await as(fx.homeB, async () => {
    await createKnowledgeUnit(fx.workspace, card("SUB-414-GULL-RESOLVED", "Gull nesting cliff survey, merged", { occurredAt: instant(11), supersedes: gullA.id }));
    await createKnowledgeUnit(fx.workspace, card("SUB-414-KEY-RESOLVED", "Kestrel hover timing and beaver dams", { occurredAt: instant(12), supersedes: keyA.id }));
    assert.equal((await readRecallCards(fx.workspace, { at: AT })).projectCrestDegraded, null);
  });
  assert.equal(Object.hasOwn(await recallOnB(), "projectCrestDegraded"), false);
});

// The crest as an engine before event streams left it: one metadata file and one body file per
// card, its marker's version counting the writes. This lays the fixture's crest down that way --
// every record as the streams hold it now -- and takes the streams away.
async function asOlderEngineCrest(fx, home) {
  const all = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all", limit: 1_000_000 }));
  const marker = await as(home, () => readKnowledgeStoreMarker(fx.workspace));
  const bodies = new Map();
  for (const deviceId of await readdir(join(fx.store, "events"))) {
    for (const name of await readdir(join(fx.store, "events", deviceId))) {
      if (name.endsWith(".body")) bodies.set(name.slice(9, -5), await readFile(join(fx.store, "events", deviceId, name)));
    }
  }
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

test("SUB-414: a crest an older engine left in the metadata/body layout, or with its bodies in segments, stays readable, and new cards append without rewriting it", async (context) => {
  const fx = await twoDevices(context, "layouts");
  const ids = await as(fx.homeA, async () => {
    const heron = await createKnowledgeUnit(fx.workspace, card("SUB-414-HERON", "Heron wading depth"));
    const kestrel = await createKnowledgeUnit(fx.workspace, card("SUB-414-KESTREL", "Kestrel hover timing"));
    const otter = await createKnowledgeUnit(fx.workspace, card("SUB-414-OTTER", "Otter slide angle"));
    const heronNew = await createKnowledgeUnit(fx.workspace, card("SUB-414-HERON-NEW", "Heron wading depth, measured", { occurredAt: instant(6), supersedes: heron.id }));
    return { heron: heron.id, kestrel: kestrel.id, otter: otter.id, heronNew: heronNew.id };
  });
  await asOlderEngineCrest(fx, fx.homeA);
  assert.deepEqual((await readdir(fx.store)).sort(), ["bodies", "metadata", "store.json"]);
  const legacy = await tree(fx.store);
  const read = async (home) => as(home, async () => ({
    all: (await listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })).records.map((record) => [record.externalKey, record.revision, record.extensions.supersededBy ?? null]),
    body: (await readKnowledgeBody(fx.workspace, ids.otter, { at: AT })).body,
    valid: (await validateKnowledgeStore(fx.workspace)).reasonCode,
  }));
  const before = await read(fx.homeB);
  assert.equal(before.valid, "KNOWLEDGE_STORE_VALID");
  assert.equal(before.body, "SUB-414-OTTER body");
  assert.deepEqual(before.all.find(([key]) => key === "SUB-414-HERON"), ["SUB-414-HERON", 2, ids.heronNew], "the mark the older engine stored reads as it was written");
  // New writes on both devices: a card, a card superseding one the older engine wrote, and a
  // re-verification of another. Each appends to its device's stream; the layout stays as it was.
  await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-KESTREL-NEW", "Kestrel hover timing, revised", { occurredAt: instant(7), supersedes: ids.kestrel })));
  await as(fx.homeA, () => reverifyKnowledgeUnit(fx.workspace, { expectedRevision: 1, occurredAt: instant(8), id: ids.otter }));
  await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CRANE", "Crane migration route", { occurredAt: instant(9) })));
  const appended = await tree(fx.store);
  for (const [path, bytes] of Object.entries(legacy)) assert.equal(appended[path], bytes, `the older layout is not rewritten: ${path}`);
  assert.deepEqual(Object.keys(appended).filter((path) => !Object.hasOwn(legacy, path)).every((path) => path.startsWith("events/")), true, "every new file is an event stream's");
  const after = await read(fx.homeA);
  assert.deepEqual(await read(fx.homeB), after);
  assert.deepEqual(after.all.find(([key]) => key === "SUB-414-KESTREL"), ["SUB-414-KESTREL", 2, deriveStableId("knowledge", "SUB-414-KESTREL-NEW")], "a card of the older layout is replaced by projection");
  assert.deepEqual(after.all.filter(([key]) => key === "SUB-414-OTTER"), [["SUB-414-OTTER", 2, null]], "and written again as a record in the stream that replaces it: one card");
  // The bodies of the metadata/body layout can still move into segments -- the one operation that
  // rewrites that layout, run by one device -- and the crest reads the same afterwards.
  const migrated = await as(fx.homeA, () => migrateKnowledgeBodies(fx.workspace, 4096));
  assert.deepEqual([migrated.before, migrated.after], [4, 4]);
  assert.equal((await readdir(join(fx.store, "bodies"))).includes("manifest.json"), true);
  assert.deepEqual(await read(fx.homeB), after);
  const segmented = await tree(fx.store);
  await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-STORK", "Stork nest chimney", { occurredAt: instant(10) })));
  const final = await tree(fx.store);
  for (const [path, bytes] of Object.entries(segmented)) assert.equal(final[path], bytes, `a new card leaves the segments as they were: ${path}`);
  assert.equal((await as(fx.homeA, () => readKnowledgeBody(fx.workspace, ids.kestrel, { at: AT }))).body, "SUB-414-KESTREL body", "a segmented body reads by its id");
});

// ---- TCRN-CROSS-SUB-414 R16 (C-R16-1; judgment-r15-batch1 T1, accept-r15-epic142 R15-B) ----
//
// A project deleted under a live card of a library's crest. project-delete refuses only a project
// that still owns live work, and a device that deletes a project cannot see a card another device
// wrote to it before either received the other's write, so the crest holds such a card instead of
// refusing every read and write. The card is named at the top of knowledge-list, of a read of its id
// and of recall as `unresolvedScopes` -- its id, the device, sequence and event hash of its record,
// and the project id that no longer resolves -- and leaves default selection and recall, while every
// other card is read, written and recalled as before. validate and a checkpoint refuse with
// KNOWLEDGE_LINK_INVALID and the rebase with KNOWLEDGE_REBASE_BLOCKED, each naming the card and the
// remedy, until a card supersedes it; then all three answer again. Red leg: refuse a live record's
// lost project in the scan, as the crest did before R16, and every read below is
// KNOWLEDGE_LINK_INVALID and no write lands.

const GONE_QUERY = "curlew call pitch plover egg count";

// The id of the project a state holds under an external key.
function projectIdOf(state, externalKey) {
  return state.projects.find((project) => project.externalKey === externalKey).id;
}

// A card's latest record in a device's stream, as `unresolvedScopes` names it.
async function unresolvedScopeOf(fx, deviceId, id, projectId) {
  const event = (await streamEvents(fx.store, deviceId)).findLast((entry) => entry.metadata.id === id);
  return { id, deviceId, sequence: event.sequence, eventHash: event.eventHash, projectId };
}

// A refusal as a caller meets it: its code, its message and its details.
async function refusalAnswer(home, operation) {
  const refused = await as(home, () => refusalOf(operation));
  return refused === null ? null : { reasonCode: refused.reasonCode, message: refused.message, details: refused.details ?? null };
}

// Everything one device answers about a crest holding a card whose project is gone: the list, the
// list of every record, both reads of that card, recall through core and through the CLI, and the
// three strict surfaces.
async function goneProjectAnswers(fx, home, orphan) {
  return {
    listed: await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT })),
    all: await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, selection: "all" })),
    snippet: await as(home, () => readKnowledgeSnippet(fx.workspace, orphan)),
    body: await as(home, () => readKnowledgeBody(fx.workspace, orphan, { at: AT })),
    recalled: await as(home, () => readRecallCards(fx.workspace, { at: AT })),
    recall: await cli(home, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", GONE_QUERY, "--tau", "0"]),
    validate: await refusalAnswer(home, () => validateKnowledgeStore(fx.workspace)),
    checkpoint: await refusalAnswer(home, () => exportKnowledgeCheckpoint(fx.workspace, AT)),
    rebase: await refusalAnswer(home, () => rebaseKnowledgeStore(fx.workspace, { at: AT })),
  };
}

// What those answers are while no card supersedes the one whose project is gone. `kept` is every
// other card, which default selection and recall still give.
function assertGoneProjectNamed(answers, { orphan, entries, kept }) {
  assert.deepEqual(answers.listed.records.map((record) => record.id), [...kept].sort(), "default selection leaves the card out, and only it");
  assert.deepEqual(answers.listed.unresolvedScopes, entries, "the list names it: its device, sequence, event hash and the project id that no longer resolves");
  assert.deepEqual(answers.all.records.map((record) => record.id), [...kept, orphan].sort(), "--selection all lists it");
  assert.deepEqual([answers.snippet.id, answers.snippet.unresolvedScopes], [orphan, entries], "a read of its id answers it, naming it at the top");
  assert.deepEqual([answers.body.id, answers.body.unresolvedScopes], [orphan, entries]);
  assert.deepEqual(answers.recalled.cards.map((entry) => entry.id).sort(), [...kept].sort(), "recall leaves it out and gives every other card");
  const withheld = { reasonCode: "KNOWLEDGE_LINK_INVALID", unresolvedScopes: entries, withheldCards: 1 };
  assert.deepEqual(answers.recalled.projectCrestDegraded, withheld);
  assert.deepEqual(answers.recall.projectCrestDegraded, withheld, "recall names it at the top of its answer");
  assert.deepEqual([answers.recall.knowledgeReasonCode, answers.recall.knowledgeStores.project],
    ["KNOWLEDGE_LIST_READY", { reasonCode: "KNOWLEDGE_LIST_READY", cards: kept.length }], "the crest is read, not refused");
  assert.equal(Object.hasOwn(answers.recall, "userCrestDegraded"), false, "the user crest is not touched");
  const details = { unresolvedScopes: entries, remedy: `write a card with knowledge-create --supersedes ${orphan}` };
  assert.deepEqual(answers.validate, { reasonCode: "KNOWLEDGE_LINK_INVALID", message: `${orphan}:scope`, details }, "validate refuses, naming the card and the remedy");
  assert.deepEqual(answers.checkpoint, { reasonCode: "KNOWLEDGE_LINK_INVALID", message: `${orphan}:scope`, details });
  assert.deepEqual(answers.rebase, { reasonCode: "KNOWLEDGE_REBASE_BLOCKED", message: orphan, details }, "the rebase's one offender is the card");
}

// Everything one device answers once a card has superseded the one whose project is gone.
async function resolvedAnswers(fx, home, orphan) {
  const answers = await as(home, async () => ({
    listed: await listKnowledgeMetadata(fx.workspace, { at: AT }),
    snippet: await readKnowledgeSnippet(fx.workspace, orphan),
    body: await readKnowledgeBody(fx.workspace, orphan, { at: AT }),
    validation: await validateKnowledgeStore(fx.workspace),
    checkpoint: JSON.parse(await exportKnowledgeCheckpoint(fx.workspace, AT)),
    rebased: await rebaseKnowledgeStore(fx.workspace, { at: AT }),
    recalled: await readRecallCards(fx.workspace, { at: AT }),
  }));
  return { ...answers, recall: await cli(home, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", GONE_QUERY, "--tau", "0"]) };
}

function assertGoneProjectResolved(answers, { orphan, orphanBody, kept }) {
  assert.deepEqual(answers.listed.records.map((record) => record.id), [...kept].sort(), "the replaced card stays out of default selection, as a superseded card");
  for (const answer of [answers.listed, answers.snippet, answers.body]) assert.equal(Object.hasOwn(answer, "unresolvedScopes"), false, "and nothing names it any more");
  assert.deepEqual([answers.body.id, answers.body.body], [orphan, orphanBody], "its body stays readable by its id");
  assert.equal(answers.validation.reasonCode, "KNOWLEDGE_STORE_VALID");
  assert.equal(answers.checkpoint.reasonCode, "KNOWLEDGE_CHECKPOINT_READY");
  assert.deepEqual([answers.rebased.reasonCode, answers.rebased.offenders], ["KNOWLEDGE_STORE_REBASED", []]);
  assert.equal(answers.recalled.projectCrestDegraded, null);
  assert.equal(Object.hasOwn(answers.recall, "projectCrestDegraded"), false, "recall no longer names the crest");
}

test("SUB-414 (R16): a project one device deletes while the other writes a card to it leaves the crest readable, writable and recallable on both, the card named and withheld until a card supersedes it", async (context) => {
  const fx = await twoDevices(context, "project-delete");
  const gone = await as(fx.homeA, async () => projectIdOf(await createProject(fx.workspace, { occurredAt: instant(3), externalKey: "SUB-414-GONE", name: "Gone" }), "SUB-414-GONE"));
  const plover = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-PLOVER", "Plover egg count", { occurredAt: instant(4), scope: "project", projectId: fx.project })));
  // A deletes the project, which holds no card and no live work on A; B has not received the delete.
  await fx.mark(fx.homeA);
  await as(fx.homeA, () => deleteProject(fx.workspace, { occurredAt: instant(6), id: gone }));
  await fx.hold(fx.homeA);
  const orphan = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW", "Curlew call pitch", { occurredAt: instant(7), scope: "project", projectId: gone })));
  assert.equal(orphan.reasonCode, "KNOWLEDGE_UNIT_CREATED", "B still holds the project, so its write is admitted");
  await fx.deliver(fx.homeA);
  const entries = [await unresolvedScopeOf(fx, DEVICE_B, orphan.id, gone)];
  const onA = await goneProjectAnswers(fx, fx.homeA, orphan.id);
  assert.equal(canonicalJson(await goneProjectAnswers(fx, fx.homeB, orphan.id)), canonicalJson(onA), "both devices answer every read and refusal byte for byte alike");
  assertGoneProjectNamed(onA, { orphan: orphan.id, entries, kept: [plover.id] });
  // What the CLI prints for the strict surfaces: the card and the remedy.
  for (const [args, reasonCode, error] of [
    [["knowledge-validate", "--workspace", fx.workspace], "KNOWLEDGE_LINK_INVALID", `${orphan.id}:scope`],
    [["knowledge-rebase", "--workspace", fx.workspace, "--at", AT], "KNOWLEDGE_REBASE_BLOCKED", orphan.id],
  ]) {
    const printed = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "einzbern.mjs"), ...args], { env: { ...process.env, EINZBERN_HOME: fx.homeB }, encoding: "utf8" });
    assert.equal(printed.status, 1, args[0]);
    assert.deepEqual(JSON.parse(printed.stderr.trim().split("\n").at(-1)),
      { ok: false, reasonCode, remedy: `write a card with knowledge-create --supersedes ${orphan.id}`, error }, args[0]);
  }
  // Unrelated cards are written on both devices, and the card stays named on both.
  const dunlin = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-DUNLIN", "Dunlin roost site", { occurredAt: instant(8) })));
  const godwit = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-GODWIT", "Godwit tide timing", { occurredAt: instant(9), scope: "project", projectId: fx.project })));
  assert.deepEqual([dunlin.reasonCode, godwit.reasonCode], ["KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED"]);
  const kept = [plover.id, dunlin.id, godwit.id];
  const written = await goneProjectAnswers(fx, fx.homeB, orphan.id);
  assert.equal(canonicalJson(await goneProjectAnswers(fx, fx.homeA, orphan.id)), canonicalJson(written));
  assertGoneProjectNamed(written, { orphan: orphan.id, entries, kept });
  // The existing verb resolves it: a card that supersedes it, written on either device.
  const moved = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW-KEPT", "Curlew call pitch, filed under the kept project", {
    occurredAt: instant(10), scope: "project", projectId: fx.project, supersedes: orphan.id,
  })));
  assert.deepEqual([moved.reasonCode, moved.superseded], ["KNOWLEDGE_UNIT_CREATED", orphan.id]);
  const resolved = await resolvedAnswers(fx, fx.homeB, orphan.id);
  assert.equal(canonicalJson(await resolvedAnswers(fx, fx.homeA, orphan.id)), canonicalJson(resolved));
  assertGoneProjectResolved(resolved, { orphan: orphan.id, orphanBody: "SUB-414-CURLEW body", kept: [...kept, moved.id] });
});

// The card can also be one card of a pair two devices wrote about one thing: recall names it in both
// lists and counts it once, and the pair's reason code leads. Red leg: count the lists apart, and
// withheldCards says three where two cards are withheld.
test("SUB-414 (R16): a card whose project is gone that is also one card of an unresolved pair is named in both lists and withheld once", async (context) => {
  const fx = await twoDevices(context, "project-delete-pair");
  const gone = await as(fx.homeA, async () => projectIdOf(await createProject(fx.workspace, { occurredAt: instant(3), externalKey: "SUB-414-GONE", name: "Gone" }), "SUB-414-GONE"));
  await fx.mark(fx.homeA);
  await as(fx.homeA, () => deleteProject(fx.workspace, { occurredAt: instant(6), id: gone }));
  const survey = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW-SURVEY", "Curlew call pitch survey", { occurredAt: instant(7) })));
  await fx.hold(fx.homeA);
  const orphan = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW", "Curlew call pitch census", { occurredAt: instant(8), scope: "project", projectId: gone })));
  await fx.deliver(fx.homeA);
  const entries = [await unresolvedScopeOf(fx, DEVICE_B, orphan.id, gone)];
  const listed = await as(fx.homeB, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
  assert.deepEqual([listed.records, listed.unresolvedConflicts, listed.unresolvedScopes], [[], [[survey.id, orphan.id].sort()], entries]);
  const withheld = { reasonCode: "KNOWLEDGE_POSSIBLE_CONFLICT", unresolvedConflicts: listed.unresolvedConflicts, unresolvedScopes: entries, withheldCards: 2 };
  assert.deepEqual((await as(fx.homeA, () => readRecallCards(fx.workspace, { at: AT }))).projectCrestDegraded, withheld);
  assert.deepEqual((await cli(fx.homeB, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", GONE_QUERY, "--tau", "0"])).projectCrestDegraded, withheld);
  // One card that supersedes the named card resolves the pair and the lost project at once.
  await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW-MERGED", "Curlew call pitch, survey and census", { occurredAt: instant(9), supersedes: orphan.id })));
  const after = await as(fx.homeA, () => listKnowledgeMetadata(fx.workspace, { at: AT }));
  assert.deepEqual([Object.hasOwn(after, "unresolvedConflicts"), Object.hasOwn(after, "unresolvedScopes")], [false, false]);
  assert.equal((await as(fx.homeA, () => readRecallCards(fx.workspace, { at: AT }))).projectCrestDegraded, null);
  assert.equal((await as(fx.homeA, () => validateKnowledgeStore(fx.workspace))).reasonCode, "KNOWLEDGE_STORE_VALID");
});

test("SUB-414 (R16): on one device, a card whose project is deleted after it was written is named the same way; a dangling work link stays a diagnostic, and a forked or altered stream is still refused", async (context) => {
  const fx = await twoDevices(context, "project-delete-one");
  const { gone, work } = await as(fx.homeA, async () => {
    const withGone = await createProject(fx.workspace, { occurredAt: instant(3), externalKey: "SUB-414-GONE", name: "Gone" });
    const withWork = await createWork(fx.workspace, { occurredAt: instant(4), projectId: fx.project, externalKey: "SUB-414-WORK-DONE", kind: "Initiative", parentId: null, status: "active" });
    return { gone: projectIdOf(withGone, "SUB-414-GONE"), work: withWork.work.find((record) => record.externalKey === "SUB-414-WORK-DONE").id };
  });
  const orphan = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW", "Curlew call pitch", { occurredAt: instant(5), scope: "project", projectId: gone })));
  const plover = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-PLOVER", "Plover egg count", {
    occurredAt: instant(6), scope: "project", projectId: fx.project, linkedWorkIds: [work],
  })));
  await as(fx.homeA, async () => {
    await deleteProject(fx.workspace, { occurredAt: instant(7), id: gone });
    await deleteWork(fx.workspace, { occurredAt: instant(8), id: work });
  });
  const entries = [await unresolvedScopeOf(fx, DEVICE_A, orphan.id, gone)];
  assertGoneProjectNamed(await goneProjectAnswers(fx, fx.homeA, orphan.id), { orphan: orphan.id, entries, kept: [plover.id] });
  // Holding a card whose project is gone holds nothing else: a forked stream and a record edited in
  // place are refused as before, naming the device and the sequence or the file.
  const stream = join(fx.store, "events", DEVICE_A);
  const orphanFile = (await readdir(stream)).find((name) => name.endsWith(`-${entries[0].eventHash}.json`));
  const original = await readFile(join(stream, orphanFile));
  const fork = join(stream, `${orphanFile.slice(0, 9)}${"f".repeat(64)}.json`);
  await writeFile(fork, original);
  const forked = await as(fx.homeA, () => refusalOf(() => listKnowledgeMetadata(fx.workspace, { at: AT })));
  assert.equal(forked?.reasonCode, "KNOWLEDGE_PARTIAL_STATE");
  assert.match(forked.message, new RegExp(`^${DEVICE_A}: event stream has a gap or fork at sequence \\d+$`, "u"));
  await rm(fork);
  const event = JSON.parse(original.toString("utf8"));
  await writeFile(join(stream, orphanFile), canonicalJson({ ...event, metadata: { ...event.metadata, summary: "edited in place" } }));
  const altered = await as(fx.homeA, () => refusalOf(() => listKnowledgeMetadata(fx.workspace, { at: AT })));
  assert.deepEqual([altered?.reasonCode, altered?.message], ["KNOWLEDGE_RECORD_INVALID", `${DEVICE_A}/${orphanFile}: event hash`]);
  await writeFile(join(stream, orphanFile), original);
  // Every other card is written and read as before, and a dangling work link is what it was: a
  // diagnostic that leaves its card in default selection.
  const dunlin = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-DUNLIN", "Dunlin roost site", { occurredAt: instant(9) })));
  assertGoneProjectNamed(await goneProjectAnswers(fx, fx.homeA, orphan.id), { orphan: orphan.id, entries, kept: [plover.id, dunlin.id] });
  const moved = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW-KEPT", "Curlew call pitch, filed under the kept project", {
    occurredAt: instant(10), scope: "project", projectId: fx.project, supersedes: orphan.id,
  })));
  const resolved = await resolvedAnswers(fx, fx.homeA, orphan.id);
  assertGoneProjectResolved(resolved, { orphan: orphan.id, orphanBody: "SUB-414-CURLEW body", kept: [plover.id, dunlin.id, moved.id] });
  assert.deepEqual(resolved.validation.danglingWorkLinks, [{ knowledgeId: plover.id, workIds: [work] }]);
  assert.deepEqual(resolved.rebased.danglingWorkLinks, [{ knowledgeId: plover.id, workIds: [work] }]);
});

test("SUB-414 (R16): a card of the metadata/body layout an older engine left, whose project is gone, is named with no device, sequence or event hash and resolved the same way", async (context) => {
  const fx = await twoDevices(context, "project-delete-layout");
  const gone = await as(fx.homeA, async () => projectIdOf(await createProject(fx.workspace, { occurredAt: instant(3), externalKey: "SUB-414-GONE", name: "Gone" }), "SUB-414-GONE"));
  const { orphan, plover } = await as(fx.homeA, async () => ({
    orphan: await createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW", "Curlew call pitch", { occurredAt: instant(4), scope: "project", projectId: gone })),
    plover: await createKnowledgeUnit(fx.workspace, card("SUB-414-PLOVER", "Plover egg count", { occurredAt: instant(5), scope: "project", projectId: fx.project })),
  }));
  await asOlderEngineCrest(fx, fx.homeA);
  await as(fx.homeA, () => deleteProject(fx.workspace, { occurredAt: instant(6), id: gone }));
  const entries = [{ id: orphan.id, deviceId: null, sequence: null, eventHash: null, projectId: gone }];
  const onB = await goneProjectAnswers(fx, fx.homeB, orphan.id);
  assert.equal(canonicalJson(await goneProjectAnswers(fx, fx.homeA, orphan.id)), canonicalJson(onB));
  assertGoneProjectNamed(onB, { orphan: orphan.id, entries, kept: [plover.id] });
  const moved = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-414-CURLEW-KEPT", "Curlew call pitch, filed under the kept project", {
    occurredAt: instant(7), scope: "project", projectId: fx.project, supersedes: orphan.id,
  })));
  assertGoneProjectResolved(await resolvedAnswers(fx, fx.homeA, orphan.id), { orphan: orphan.id, orphanBody: "SUB-414-CURLEW body", kept: [plover.id, moved.id] });
});

test("SUB-414: an old-layout workspace's knowledge store refuses every write with LEGACY_WORKSPACE_READ_ONLY and keeps every byte", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-sub414-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const home = await deviceHome(base, "device", DEVICE_A);
  const { root, control } = await restoreLegacyFixture(base);
  const legacy = await as(home, () => validateWorkspace(root));
  // The store an old engine left beside its chain: marker, empty metadata and bodies, and its view.
  const knowledge = join(control, "knowledge");
  for (const directory of ["metadata", "bodies", "views"]) await mkdir(join(knowledge, directory), { recursive: true });
  const marker = { schemaVersion: "tcrn.knowledge-store.v1", workspaceId: legacy.metadata.workspaceId, eventHighWaterDigest: legacy.headEventHash, version: 0, disposable: true, authority: "metadata-index-authority-body-separate" };
  await writeFile(join(knowledge, "store.json"), canonicalJson(marker));
  await writeFile(join(knowledge, "views", "index.json"), canonicalJson({
    schemaVersion: "tcrn.knowledge-index.v1", authority: "derived-rebuildable", workspaceId: marker.workspaceId,
    eventHighWaterDigest: marker.eventHighWaterDigest, version: 0, records: [], indexDigest: canonicalSha256([]),
  }));
  const before = await tree(root);
  const id = deriveStableId("knowledge", "SUB-414-LEGACY");
  await as(home, async () => {
    for (const [label, write] of [
      ["knowledge-init", () => initializeKnowledgeStore(root, { disposableAcknowledged: true })],
      ["knowledge-create", () => createKnowledgeUnit(root, card("SUB-414-LEGACY", "A card for a read-only store"))],
      ["knowledge-capture", () => captureKnowledgeUnit(root, { occurredAt: instant(5), subject: "Captured", summary: "s", snippet: "s", tags: ["lesson"], accountableOwnerId: OWNER, body: "b" })],
      ["knowledge-reverify", () => reverifyKnowledgeUnit(root, { expectedRevision: 1, occurredAt: instant(5), id })],
      ["knowledge-policy", () => updateKnowledgeStalenessPolicy(root, { expectedRevision: 1, occurredAt: instant(5), id, stalenessPolicy: { maximumAgeDays: null, unknownDisposition: "fail-closed" } })],
      ["knowledge-rebase", () => rebaseKnowledgeStore(root, { at: instant(5) })],
      ["knowledge-bodies-migrate", () => migrateKnowledgeBodies(root, 4096)],
    ]) {
      assert.equal((await refusalOf(write))?.reasonCode, "LEGACY_WORKSPACE_READ_ONLY", label);
    }
  });
  assert.deepEqual(await tree(root), before, "no refused write left a trace in the old tree");
  assert.equal((await readdir(control)).includes(DIRECTORY.knowledge), false, "and nothing laid a crest out beside it");
});

// TCRN-CROSS-SUB-310 R17 (MIN-238 D1, D5; replaces O-1 and the diagnostic-only case that stood here):
// no budget bounds the sum of the library crest's card bodies. Two devices that each stay under the
// old 131,072-byte default of knowledge.aggregateBytes merge past it; neither device's list, read by
// id, recall, validation, next card or recovery refuses, nothing is withheld, and both answer the same.
test("SUB-310 R17 (MIN-238 D1): a two-device merge past the old default reads, recalls, writes and recovers on both devices, which answer alike", async (context) => {
  const fx = await twoDevices(context, "past-default");
  const subjectsA = ["Heron wading depth", "Kestrel hover timing", "Otter holt survey", "Newt pond census", "Badger sett mapping", "Vole tunnel network", "Stoat winter coat", "Hare form spotting", "Plover scrape watch"];
  const subjectsB = ["Beaver dam height", "Curlew call record", "Lizard basking rock", "Moth trap catalogue", "Grebe dive length", "Shrew burrow route", "Swift nest ledge", "Toad crossing night", "Wagtail roost tree"];
  const body = (letter, index) => `${letter.repeat(7_999)}${index}`;
  await fx.mark(fx.homeA);
  const cardsA = [];
  for (const [index, subject] of subjectsA.entries()) {
    cardsA.push(await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card(`SUB-310-A-${index}`, subject, { body: body("a", index) }))));
  }
  await fx.hold(fx.homeA);
  // B writes its nine 8,000-byte cards without seeing A's: 72,000 bytes each, 144,000 merged.
  const cardsB = [];
  for (const [index, subject] of subjectsB.entries()) {
    cardsB.push(await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card(`SUB-310-B-${index}`, subject, { body: body("b", index) }))));
  }
  await fx.deliver(fx.homeA);
  assert.ok(9 * 8_000 <= 131_072 && 18 * 8_000 > 131_072, "each device stays under the old default and the merge passes it");

  const answers = [];
  for (const home of [fx.homeA, fx.homeB]) {
    const device = home === fx.homeA ? "A" : "B";
    const listed = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, limit: 64 }));
    assert.deepEqual([listed.reasonCode, listed.total], ["KNOWLEDGE_LIST_READY", 18], device);
    for (const name of ["unresolvedConflicts", "unresolvedDuplicates", "awaitingChain", "unresolvedScopes"]) assert.equal(Object.hasOwn(listed, name), false, `${device} ${name}`);
    assert.equal((await as(home, () => readKnowledgeBody(fx.workspace, cardsA[8].id, { at: AT }))).body, body("a", 8), device);
    assert.equal((await as(home, () => readKnowledgeBody(fx.workspace, cardsB[8].id, { at: AT }))).body, body("b", 8), device);
    const recalled = await as(home, () => readRecallCards(fx.workspace, { at: AT }));
    assert.deepEqual([recalled.stores.project.reasonCode, recalled.stores.project.cards, recalled.projectCrestDegraded], ["KNOWLEDGE_LIST_READY", 18, null], device);
    const answer = await cli(home, ["recall", "--workspace", fx.workspace, "--at", AT, "--query", "Beaver dam height", "--tau", "0"]);
    assert.deepEqual([answer.knowledgeReasonCode, answer.knowledgeStores.project.cards, Object.hasOwn(answer, "projectCrestDegraded")], ["KNOWLEDGE_LIST_READY", 18, false], device);
    assert.equal(answer.records.find((record) => record.kind === "card")?.id, cardsB[0].id, `${device}: B's card is recalled by its subject`);
    const validation = await as(home, () => validateKnowledgeStore(fx.workspace));
    assert.deepEqual([validation.reasonCode, validation.records, Object.hasOwn(validation, "capacity")], ["KNOWLEDGE_STORE_VALID", 18, false], device);
    answers.push({ records: listed.records, total: listed.total, resultDigest: listed.resultDigest, recallDigest: recalled.stores.project.digest, validation });
  }
  assert.deepEqual(answers[0], answers[1], "both devices read the same merged crest");

  // Each device takes one more card, and each reads the other's at once.
  const moreA = await as(fx.homeA, () => createKnowledgeUnit(fx.workspace, card("SUB-310-A-MORE", "Osprey plunge angle", { body: body("c", 9) })));
  const moreB = await as(fx.homeB, () => createKnowledgeUnit(fx.workspace, card("SUB-310-B-MORE", "Dipper stream walking", { body: body("d", 9) })));
  assert.deepEqual([moreA.reasonCode, moreB.reasonCode], ["KNOWLEDGE_UNIT_CREATED", "KNOWLEDGE_UNIT_CREATED"]);
  const after = [];
  for (const home of [fx.homeA, fx.homeB]) {
    const listed = await as(home, () => listKnowledgeMetadata(fx.workspace, { at: AT, limit: 64 }));
    assert.equal(listed.total, 20);
    assert.equal((await as(home, () => recoverKnowledgeStore(fx.workspace))).reasonCode, "KNOWLEDGE_RECOVERY_NOT_NEEDED");
    after.push({ records: listed.records, resultDigest: listed.resultDigest });
  }
  assert.deepEqual(after[0], after[1], "and both still answer alike");
});
