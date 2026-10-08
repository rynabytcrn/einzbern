// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-478 R1 (MIN-227 D13; TCRN-CROSS-SUB-315): project-level configuration records.
// Four closed collections (managed sections, rules, variables, gates) travel with a library as
// config.record.* events. Two devices that write one key apart both read the write that merges
// last (clock, then device id); a removal that no longer applies is a rejected event, not a
// failed read; config/project.json projects the records beside the settings; and an old-layout
// workspace neither holds nor accepts them.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { configProjectionStatus, materializeWorkspace, materializeWorkspaceFromGenesis } from "../dist/build/packages/core/src/index.js";
import {
  CONFIG_RECORD_COLLECTIONS,
  configRecord,
  configRecords,
  removeConfigRecord,
  setConfigRecord,
} from "../dist/build/packages/core/src/config-records.js";
import { readCacheSnapshot } from "../dist/build/packages/core/src/library-cache.js";
import { LEGACY_FIXTURE_EXPECTED, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";
import { forgeOwnStream } from "./helpers/library-forge.mjs";

// TCRN-CROSS-STORY-484 R4, TCRN-CROSS-STORY-513 R1: these tests write settings, variables and gates
// through the CLI, as Atelier does.
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 6, 0, second)).toISOString().replace(".000Z", "Z");
};

// Two devices with fixed ids, so the tie on a clock is decided the same way on every run.
const DESK_ID = "a".repeat(32);
const LAPTOP_ID = "b".repeat(32);

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-config-records-")));
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

/** A device directory with a fixed device id. */
async function device(base, name, deviceId) {
  const home = join(base, name);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "device.json"), `${JSON.stringify({ createdAt: "2026-09-26T00:00:00Z", deviceId, displayName: name, schemaVersion: "einzbern.device.v1" })}\n`);
  return home;
}

/** Run `operation` as the device whose directory is `home`. */
async function as(home, operation) {
  process.env.EINZBERN_HOME = home;
  return operation();
}

async function cli(home, args) {
  process.env.EINZBERN_HOME = home;
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push(`${relative(root, path)}/`);
        await walk(path);
      } else {
        rows.push(`${relative(root, path)}|${createHash("sha256").update(await readFile(path)).digest("hex")}`);
      }
    }
  };
  await walk(root);
  return rows;
}

// What a sync client does when it brings one device's writes into another copy of the library.
async function syncStream(from, to, deviceId) {
  await rm(join(to, "akasha", deviceId), { recursive: true, force: true });
  await cp(join(from, "akasha", deviceId), join(to, "akasha", deviceId), { recursive: true });
}

const gate = (name, argv) => ({ command: argv, root: ".", covers: [`${name}/**`], required: true, enabled: true, releaseOnly: false });

test("478-R1: two devices write one key apart; after the sync both read the write that merges last", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const laptop = await device(base, "laptop", LAPTOP_ID);
  const library = join(base, ".ether");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);
  const apart = join(base, "apart");
  await cp(library, apart, { recursive: true });

  // The desk writes the gate first (clock 1). The laptop, apart, writes a variable and then the
  // same gate (clock 2) without having seen the desk's write.
  const deskWrite = await as(desk, () => setConfigRecord(library, { collection: "gate", key: "links", value: gate("docs", ["pnpm", "verify:links"]), occurredAt: at() }));
  assert.deepEqual(configRecord(deskWrite, "gate", "links")?.value, gate("docs", ["pnpm", "verify:links"]), "the committed state holds the record");
  await as(laptop, () => setConfigRecord(apart, { collection: "variable", key: "design", value: { type: "string", value: "tokens", description: "design source" }, occurredAt: at() }));
  await as(laptop, () => setConfigRecord(apart, { collection: "gate", key: "links", value: gate("docs", ["pnpm", "run", "links"]), occurredAt: at() }));
  await syncStream(apart, library, LAPTOP_ID);
  await syncStream(library, apart, DESK_ID);

  const onDesk = await as(desk, () => materializeWorkspace(library));
  const onLaptop = await as(laptop, () => materializeWorkspace(apart));
  for (const state of [onDesk, onLaptop]) {
    assert.deepEqual(configRecord(state, "gate", "links")?.value.command, ["pnpm", "run", "links"], "the later clock wins");
    assert.equal(configRecord(state, "variable", "design")?.value.value, "tokens");
    assert.deepEqual(state.library.rejectedEvents, [], "a later write to a key is not a rejected event");
  }
  assert.deepEqual(onDesk.configRecords, onLaptop.configRecords, "both devices read the same records");
  assert.deepEqual(onDesk.configRecords.map((record) => `${record.collection}/${record.key}`), ["gate/links", "variable/design"], "sorted by collection, then key");

  // On one clock the device id decides, not the wall clock: the laptop writes first, the desk
  // second, and the laptop's write still merges last because its id sorts after the desk's.
  await as(laptop, () => setConfigRecord(apart, { collection: "rule", key: "autonomy", value: { enabled: false, version: 1 }, occurredAt: at() }));
  await as(desk, () => setConfigRecord(library, { collection: "rule", key: "autonomy", value: { enabled: true, version: 1 }, occurredAt: at() }));
  await syncStream(apart, library, LAPTOP_ID);
  await syncStream(library, apart, DESK_ID);
  for (const [home, copy] of [[desk, library], [laptop, apart]]) {
    const state = await as(home, () => materializeWorkspace(copy));
    assert.deepEqual(configRecords(state, "rule").map((record) => record.value.enabled), [false], "the larger device id wins a tie on the clock");
    const clocks = state.events.filter((event) => event.payload.record?.key === "autonomy").map((event) => event.clock);
    assert.equal(new Set(clocks).size, 1, "both writes carry the same clock");
  }
});

test("478-R1: unknown collections, malformed keys and invalid collection values are refused before writing", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const library = join(base, ".ether");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);
  assert.deepEqual(CONFIG_RECORD_COLLECTIONS, ["chain", "gate", "managed-section", "rule", "variable"], "the typed collections, closed");
  const before = await treeDigest(library);

  const unknown = await refusal(() => as(desk, () => setConfigRecord(library, { collection: "settings", key: "x", value: {}, occurredAt: at() })));
  assert.equal(unknown.reasonCode, "CONFIG_RECORD_COLLECTION_UNKNOWN");
  assert.equal(unknown.details.known, "chain,gate,managed-section,rule,variable");
  for (const [input, reasonCode] of [
    [{ collection: "gate", key: "", value: {} }, "CONFIG_RECORD_KEY_INVALID"],
    [{ collection: "gate", key: "line\nbreak", value: {} }, "CONFIG_RECORD_KEY_INVALID"],
    [{ collection: "gate", key: " padded", value: {} }, "CONFIG_RECORD_KEY_INVALID"],
    [{ collection: "gate", key: "list", value: ["pnpm"] }, "CONFIG_RECORD_VALUE_INVALID"],
    [{ collection: "gate", key: "null", value: null }, "CONFIG_RECORD_VALUE_INVALID"],
    [{ collection: "gate", key: "fraction", value: { timeout: 1.5 } }, "CONFIG_RECORD_VALUE_INVALID"],
    [{ collection: "gate", key: "large", value: { text: "x".repeat(8_000), more: "y".repeat(8_000), rest: Array.from({ length: 8 }, () => "z".repeat(8_000)) } }, "CONFIG_RECORD_VALUE_INVALID"],
  ]) {
    const error = await refusal(() => as(desk, () => setConfigRecord(library, { ...input, occurredAt: at() })));
    assert.equal(error.reasonCode, reasonCode, input.key);
  }
  const removal = await refusal(() => as(desk, () => removeConfigRecord(library, { collection: "variable", key: "never-set", occurredAt: at() })));
  assert.equal(removal.reasonCode, "CONFIG_RECORD_NOT_FOUND", "a write refuses to remove a key that is not set");
  assert.deepEqual(await treeDigest(library), before, "nothing was written into the library");
  assert.throws(() => configRecords({ configRecords: [] }, "settings"), { reasonCode: "CONFIG_RECORD_COLLECTION_UNKNOWN" });
});

test("478-R1: an event naming an unknown collection is a rejected event on replay, not a failed read", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const library = join(base, ".ether");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);
  await as(desk, () => setConfigRecord(library, { collection: "gate", key: "links", value: gate("docs", ["pnpm", "verify:links"]), occurredAt: at() }));
  const forgedAt = at();
  await forgeOwnStream(library, (events) => [
    ...events.map((event) => ({ occurredAt: event.occurredAt, payload: event.payload, clock: event.clock })),
    { occurredAt: forgedAt, payload: { operation: "config.record.set", record: { collection: "hooks", key: "x", value: {} } } },
    { occurredAt: forgedAt, payload: { operation: "config.record.set", record: { collection: "gate", key: "extra", value: {}, note: "a field the event may not carry" } } },
  ]);

  const state = await as(desk, () => materializeWorkspace(library));
  assert.deepEqual(state.configRecords.map((record) => record.key), ["links"], "the refused events leave the records as they were");
  assert.deepEqual(state.library.rejectedEvents.map((entry) => [entry.operation, entry.recordId, entry.reasonCode, entry.detail.split(":")[0]]), [
    ["config.record.set", "x", "WORKSPACE_EVENT_CORRUPT", "CONFIG_RECORD_COLLECTION_UNKNOWN"],
    ["config.record.set", "extra", "WORKSPACE_EVENT_CORRUPT", "CONFIG_RECORD_EVENT_INVALID"],
  ]);
  assert.deepEqual((await as(desk, () => materializeWorkspaceFromGenesis(library))).configRecords, state.configRecords);
});

test("478-R1: removing a key another device already removed is a rejected event on both devices", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const laptop = await device(base, "laptop", LAPTOP_ID);
  const library = join(base, ".ether");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);
  await as(desk, () => setConfigRecord(library, { collection: "variable", key: "design", value: { type: "string", value: "tokens", description: "" }, occurredAt: at() }));
  const apart = join(base, "apart");
  await cp(library, apart, { recursive: true });

  // Both devices remove the variable without seeing the other's removal; both take clock 2.
  await as(desk, () => removeConfigRecord(library, { collection: "variable", key: "design", occurredAt: at() }));
  await as(laptop, () => removeConfigRecord(apart, { collection: "variable", key: "design", occurredAt: at() }));
  await syncStream(apart, library, LAPTOP_ID);
  await syncStream(library, apart, DESK_ID);

  const states = [await as(desk, () => materializeWorkspace(library)), await as(laptop, () => materializeWorkspace(apart))];
  for (const state of states) {
    assert.deepEqual(state.configRecords, [], "the variable is gone");
    assert.equal(state.library.rejectedEvents.length, 1, "the second removal no longer applies");
    const [rejected] = state.library.rejectedEvents;
    assert.equal(rejected.operation, "config.record.removed");
    assert.equal(rejected.recordId, "design");
    assert.equal(rejected.deviceId, LAPTOP_ID, "on one clock the larger device id merges second");
    assert.match(rejected.detail, /^CONFIG_RECORD_NOT_FOUND:/u);
  }
  assert.deepEqual(states[0].library.rejectedEvents, states[1].library.rejectedEvents, "both devices reject the same event");
  const refused = await refusal(() => as(desk, () => removeConfigRecord(library, { collection: "variable", key: "design", occurredAt: at() })));
  assert.equal(refused.reasonCode, "CONFIG_RECORD_NOT_FOUND");
});

test("478-R1: config/project.json projects the records beside the settings, and a removed record leaves it", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const library = join(base, ".ether");
  const path = join(library, "config", "project.json");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);
  await cli(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "retrieval.tau", "--value", "3"]);
  const written = await as(desk, () => setConfigRecord(library, { collection: "gate", key: "links", value: gate("docs", ["pnpm", "verify:links"]), occurredAt: at() }));

  let projection = JSON.parse(await readFile(path, "utf8"));
  assert.equal(projection.schemaVersion, "einzbern.project-config.v1");
  assert.deepEqual(projection.values, { "retrieval.tau": "3" });
  assert.deepEqual(projection.records, { gate: { links: gate("docs", ["pnpm", "verify:links"]) } });
  assert.deepEqual(projection.versionVector, written.library.versionVector);
  assert.equal(await configProjectionStatus(library, written.settings, written.configRecords), "current");

  // A settings write projects the records it did not touch as well.
  await as(desk, () => setConfigRecord(library, { collection: "managed-section", key: "AGENTS.md#navigation", value: { file: "AGENTS.md", id: "navigation", rev: 1, digest: "0".repeat(64), state: "managed" }, occurredAt: at() }));
  await cli(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "retrieval.tau", "--value", "4"]);
  projection = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(projection.values, { "retrieval.tau": "4" });
  assert.deepEqual(Object.keys(projection.records).sort(), ["gate", "managed-section"]);

  // The projection is judged on its records too; the events stay the truth.
  let state = await as(desk, () => materializeWorkspace(library));
  await writeFile(path, `${JSON.stringify({ ...projection, records: { ...projection.records, rule: { autonomy: { state: "enabled" } } } })}\n`);
  assert.equal(await configProjectionStatus(library, state.settings, state.configRecords), "stale");
  assert.equal(configRecord(await as(desk, () => materializeWorkspace(library)), "rule", "autonomy"), null, "no read trusts the projection");

  await as(desk, () => removeConfigRecord(library, { collection: "gate", key: "links", occurredAt: at() }));
  state = await as(desk, () => removeConfigRecord(library, { collection: "managed-section", key: "AGENTS.md#navigation", occurredAt: at() }));
  projection = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(projection.records, {}, "a removed record leaves the projection");
  assert.deepEqual(projection.values, { "retrieval.tau": "4" });
  assert.equal(await configProjectionStatus(library, state.settings, state.configRecords), "current");

  // A projection written before records existed reads as holding none.
  const { records: _records, ...withoutRecords } = projection;
  await writeFile(path, `${JSON.stringify(withoutRecords)}\n`);
  assert.equal(await configProjectionStatus(library, state.settings, state.configRecords), "current");
  await writeFile(path, `${JSON.stringify({ ...withoutRecords, records: { gate: "not an object" } })}\n`);
  assert.equal(await configProjectionStatus(library, state.settings, state.configRecords), "invalid");
});

test("478-R1: a replay resumed from this device's cache holds the same records as one from genesis", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const library = join(base, ".ether");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);
  await cli(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "storage.snapshotEveryEvents", "--value", "1"]);
  await as(desk, () => setConfigRecord(library, { collection: "variable", key: "design", value: { type: "string", value: "tokens", description: "" }, occurredAt: at() }));
  await as(desk, () => setConfigRecord(library, { collection: "gate", key: "links", value: gate("docs", ["pnpm", "verify:links"]), occurredAt: at() }));
  const snapshotted = await as(desk, () => materializeWorkspace(library));
  const snapshot = await as(desk, () => readCacheSnapshot(snapshotted.metadata.workspaceId));
  assert.equal(snapshot.version, snapshotted.version, "the read left a snapshot at its head");
  assert.deepEqual(snapshot.state.configRecords, snapshotted.configRecords, "the snapshot keeps the records");

  // The next read resumes from that snapshot and replays only the removal after it.
  await as(desk, () => removeConfigRecord(library, { collection: "variable", key: "design", occurredAt: at() }));
  const resumed = await as(desk, () => materializeWorkspace(library));
  const genesis = await as(desk, () => materializeWorkspaceFromGenesis(library));
  assert.deepEqual(resumed.configRecords, genesis.configRecords);
  assert.deepEqual(resumed.configRecords.map((record) => record.key), ["links"]);
});

test("478-R1: an old-layout workspace holds no configuration records and refuses a record write", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const { root } = await restoreLegacyFixture(base);
  const before = await treeDigest(root);

  const state = await as(desk, () => materializeWorkspace(root));
  assert.deepEqual(state.configRecords, []);
  assert.equal(state.version, LEGACY_FIXTURE_EXPECTED.version);
  assert.equal(state.headEventHash, LEGACY_FIXTURE_EXPECTED.headEventHash);
  const error = await refusal(() => as(desk, () => setConfigRecord(root, { collection: "gate", key: "links", value: gate("docs", ["pnpm", "verify:links"]), occurredAt: at() })));
  assert.equal(error.reasonCode, "LEGACY_WORKSPACE_READ_ONLY");
  assert.deepEqual(await treeDigest(root), before, "the old-layout workspace is not written");
});

test("SUB-388: configuration CLI receipts identify the records set or removed", async (context) => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const library = join(base, ".ether");
  await cli(desk, ["init", "--workspace", library, "--at", at()]);

  const gateSet = await cli(desk, ["gates-config-set", "--workspace", library, "--at", at(), "--name", "links", "--command", '["pnpm","verify:links"]']);
  assert.deepEqual(gateSet.ids, ["gate:links"]);
  const gateRemoved = await cli(desk, ["gates-config-remove", "--workspace", library, "--at", at(), "--name", "links"]);
  assert.deepEqual(gateRemoved.ids, ["gate:links"]);

  const variableSet = await cli(desk, ["variable-set", "--workspace", library, "--at", at(), "--name", "links", "--type", "string", "--value", "tokens"]);
  assert.deepEqual(variableSet.ids, ["variable:links"], "the collection is part of the record id");
  const variableRemoved = await cli(desk, ["variable-remove", "--workspace", library, "--at", at(), "--name", "links"]);
  assert.deepEqual(variableRemoved.ids, ["variable:links"]);
});


test("chain configuration validates its typed identity and refuses guessed references", async context => {
  const base = await scratch(context);
  const desk = await device(base, "desk", DESK_ID);
  const library = join(base, "chain");
  const { initializeLibrary } = await import("../dist/build/packages/core/src/index.js");
  const initial = await as(desk, () => initializeLibrary({ root: library, createdAt: at() }));
  await as(desk, () => setConfigRecord(library, { collection: "chain", key: "identity", value: { role: "coordination", coordinationLibraryId: initial.metadata.workspaceId }, occurredAt: at() }));
  const replay = await as(desk, () => materializeWorkspaceFromGenesis(library));
  assert.equal(configRecord(replay, "chain", "identity").value.role, "coordination");
  for (const value of [{ role: "coordination" }, { role: "by-name", coordinationLibraryId: initial.metadata.workspaceId }, { role: "project", coordinationLibraryId: "/folder" }]) {
    await assert.rejects(as(desk, () => setConfigRecord(library, { collection: "chain", key: "identity", value, occurredAt: at() })), { reasonCode: "CONFIG_RECORD_VALUE_INVALID" });
  }
  await assert.rejects(as(desk, () => setConfigRecord(library, { collection: "chain", key: "common-default", value: { libraryId: initial.metadata.workspaceId, projectId: "project:" + "a".repeat(24) }, occurredAt: at() })), { reasonCode: "CONFIG_RECORD_VALUE_INVALID" });
});
