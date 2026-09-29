// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-365; MIN-235 D17, D11; MIN-238 D4): a gate a migration carried
// over stays as it was. The frozen old-layout fixture, with one more owner_intent_required gate
// written as the old engine wrote it, is imported into a library: both gates are pending there, and
// a move of a bound work item to done is refused with WORKSPACE_GATE_PENDING, naming the gate and
// work-gate-release. A release records who released the gate, when and why; replay checks all three
// from the chain alone and rejects a release that disagrees with itself, which leaves the gate
// pending. work-gate-list is the read face of those gates. Every library and device directory here
// is temporary.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { COMMAND_CATALOG, MODEL_WRITE_REMEDY, runCli } from "../dist/build/packages/cli/src/index.js";
import {
  LEGACY_CONTROL_DIRECTORY,
  appendEvents,
  importLegacyWorkspace,
  materializeWorkspace,
  openLegacyWorkspace,
  replayLegacyWorkspace,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import {
  GATE_RELEASE_VERB,
  assertWorkGatesClear,
  legacyWorkspaceEventId,
  materializeWorkspaceFromGenesis,
  releaseGate,
} from "../dist/build/packages/core/src/workspace.js";
import { canonicalJson, createEvent } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED as expected, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";
import { ATELIER_SURFACE, withSurface } from "./helpers/workspace-fixture.mjs";

const cliPath = join(resolve(import.meta.dirname, ".."), "scripts/einzbern.mjs");

// The fixture's live gate, pending and bound to its Story, and the gate this file adds, bound to the
// fixture's Subtask that is ready.
const FIXTURE_GATE_ID = "gate:f48272b1736ccd8d29165c37";
const OWNER_GATE_ID = "gate:00000000000000000000c003";
const SUBTASK_KEY = "LEGACY-SUB-2";
const RELEASE_KEY = "gate-evidence:atelier-release";
const RELEASER = "owner:example";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 29, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** The fixture with one more gate, as the old engine wrote it, imported into a library. */
async function migratedLibrary(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-migrate-gates-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root } = await restoreLegacyFixture(base, "legacy");
  const legacy = await openLegacyWorkspace(root);
  const subtask = replayLegacyWorkspace(legacy).work.find((record) => !record.tombstone && record.externalKey === SUBTASK_KEY);
  assert.equal(subtask?.status, "ready");
  const last = legacy.events.at(-1);
  const occurredAt = "2026-01-01T00:00:40Z";
  const gate = createEvent({
    id: legacyWorkspaceEventId(legacy.streamId, last.sequence + 1),
    streamId: legacy.streamId,
    sequence: last.sequence + 1,
    occurredAt,
    priorHash: last.eventHash,
    payload: {
      // Since the fixture enabled attestation, every payload carries the actor it was written by.
      actor: last.payload.actor,
      operation: "gate.created",
      record: {
        extensions: {},
        id: OWNER_GATE_ID,
        outcomeClass: "owner_intent_required",
        projectId: subtask.projectId,
        revision: 1,
        schemaVersion: "tcrn.gate.v1",
        status: "pending",
        title: "Owner intent gate",
        tombstone: false,
        updatedAt: occurredAt,
        workId: subtask.id,
      },
    },
  }, "tcrn.event.v1");
  await writeFile(join(root, LEGACY_CONTROL_DIRECTORY, "events", `${String(legacy.segments.length + 1).padStart(6, "0")}.ndjson`), canonicalJson(gate));
  const library = join(base, ".ether");
  const imported = await importLegacyWorkspace(root, library, { createdAt: at() });
  assert.equal(imported.events, expected.events + 1);
  return { library, subtask, actor: last.payload.actor };
}

const liveGates = (state) => state.gates.filter((gate) => !gate.tombstone).map((gate) => [gate.id, gate.status]);

test("489 (MIN-238 D4): a gate the import carried stays pending and holds its work item back from done; the refusal names the gate and work-gate-release", async (context) => {
  const { library, subtask, actor } = await migratedLibrary(context);
  const state = await materializeWorkspace(library);
  assert.deepEqual(liveGates(state), [[OWNER_GATE_ID, "pending"], [FIXTURE_GATE_ID, "pending"]]);
  const active = await transitionWork(library, { id: subtask.id, status: "active", occurredAt: at(), actorId: actor });

  await assert.rejects(transitionWork(library, { id: subtask.id, status: "done", occurredAt: at(), actorId: actor }), (error) => {
    assert.equal(error.reasonCode, "WORKSPACE_GATE_PENDING");
    assert.deepEqual([error.details.workId, error.details.gates], [subtask.id, OWNER_GATE_ID]);
    assert.equal(error.details.remedy, `${GATE_RELEASE_VERB} --id ${OWNER_GATE_ID} --reason <why>, in Atelier`);
    assert.match(error.message, new RegExp(`${OWNER_GATE_ID}.*${GATE_RELEASE_VERB}`, "u"));
    return true;
  });
  assert.equal((await materializeWorkspace(library)).version, active.version, "the refused transition appended nothing");

  // The same check, before anything slower: the Subtask and the Story each name their own gate.
  assert.throws(() => assertWorkGatesClear(active, [subtask.id]), (error) => error.reasonCode === "WORKSPACE_GATE_PENDING" && error.details.gates === OWNER_GATE_ID);
  assert.throws(() => assertWorkGatesClear(active, [expected.records.story.id]), (error) => error.details.gates === FIXTURE_GATE_ID);
  const free = active.work.find((record) => !record.tombstone && record.externalKey === "LEGACY-EPIC");
  assert.equal(assertWorkGatesClear(active, [free.id]), undefined, "a work item no gate holds is clear");
});

test("489 (MIN-235 D17, D11): a release records who, when and why; replay checks it from the chain alone, and the work item then goes to done", async (context) => {
  const { library, subtask, actor } = await migratedLibrary(context);
  await transitionWork(library, { id: subtask.id, status: "active", occurredAt: at(), actorId: actor });
  const releasedAt = at();
  const reason = "The Owner decided the migrated gate in Atelier";
  const released = await releaseGate(library, { id: OWNER_GATE_ID, reason, actorId: RELEASER, occurredAt: releasedAt });

  const gate = released.gates.find((entry) => entry.id === OWNER_GATE_ID);
  assert.deepEqual([gate.status, gate.revision, gate.updatedAt, gate.title, gate.outcomeClass, gate.workId], ["satisfied", 2, releasedAt, "Owner intent gate", "owner_intent_required", subtask.id]);
  assert.deepEqual(gate.extensions, { [RELEASE_KEY]: { required: false, value: { actor: RELEASER, reason, releasedAt } } });
  // The chain signs its events since the fixture enabled attestation: the release is signed by the
  // actor it names.
  const replayed = await materializeWorkspaceFromGenesis(library);
  const event = replayed.events.at(-1);
  assert.deepEqual([event.payload.operation, event.payload.actor, event.occurredAt], ["gate.updated", RELEASER, releasedAt]);
  assert.deepEqual(replayed.gates, released.gates, "replay from genesis reaches the gates the release committed");
  assert.deepEqual(replayed.library.rejectedEvents, []);
  const validated = await cli(["chain-validate", "--workspace", library]);
  assert.deepEqual([validated.reasonCode, validated.rejectedEventCount, validated.events], ["CHAIN_VALIDATED", 0, expected.events + 3]);

  const done = await transitionWork(library, { id: subtask.id, status: "done", occurredAt: at(), actorId: actor });
  assert.equal(done.work.find((record) => record.id === subtask.id).status, "done");
  // The Story's own gate still holds it.
  assert.throws(() => assertWorkGatesClear(done, [expected.records.story.id]), { reasonCode: "WORKSPACE_GATE_PENDING" });
  assert.deepEqual(await materializeWorkspace(library), done, "the committed state is what a fresh read replays");
});

test("489 (MIN-235 D17): replay rejects a release that disagrees with itself, and the gate stays pending", async (context) => {
  const { library, actor } = await migratedLibrary(context);
  const cases = [
    ["another actor than the event's", (instant) => ({ actor: "owner:someone-else", reason: "why", releasedAt: instant }), {}],
    ["another instant than the event's", () => ({ actor: RELEASER, reason: "why", releasedAt: "2026-09-29T00:00:00Z" }), {}],
    ["a blank reason", (instant) => ({ actor: RELEASER, reason: "   ", releasedAt: instant }), {}],
    ["a field more", (instant) => ({ actor: RELEASER, reason: "why", releasedAt: instant, surface: "atelier" }), {}],
    ["a minutes locator beside it", (instant) => ({ actor: RELEASER, reason: "why", releasedAt: instant }), { "gate-evidence:conference-minutes": { required: false, value: "conference-minutes:0123456789abcdef01234567" } }],
  ];
  for (const [label, value, beside] of cases) {
    const occurredAt = at();
    await appendEvents(library, [(state) => {
      const current = state.gates.find((entry) => entry.id === OWNER_GATE_ID);
      const record = { ...current, status: "satisfied", revision: current.revision + 1, updatedAt: occurredAt,
        extensions: { ...current.extensions, ...beside, [RELEASE_KEY]: { required: false, value: value(occurredAt) } } };
      return { payload: { operation: "gate.updated", record }, projects: state.projects, work: state.work, gates: state.gates.map((entry) => entry.id === OWNER_GATE_ID ? record : entry) };
    }], { occurredAt, actorId: RELEASER });
    const replayed = await materializeWorkspaceFromGenesis(library);
    assert.deepEqual(liveGates(replayed).find(([id]) => id === OWNER_GATE_ID), [OWNER_GATE_ID, "pending"], label);
    const rejected = replayed.library.rejectedEvents.at(-1);
    assert.deepEqual([rejected.operation, rejected.recordId, rejected.reasonCode], ["gate.updated", OWNER_GATE_ID, "WORKSPACE_EVENT_CORRUPT"], label);
  }
  assert.equal((await materializeWorkspaceFromGenesis(library)).library.rejectedEvents.length, cases.length);
  // Nothing rejected moved the gate: the work item it holds is still held.
  const state = await materializeWorkspace(library);
  const subtask = state.work.find((record) => record.externalKey === SUBTASK_KEY);
  assert.throws(() => assertWorkGatesClear(state, [subtask.id]), { reasonCode: "WORKSPACE_GATE_PENDING" });
  assert.ok(actor.startsWith("agent:"));
});

test("489: releasing refuses a gate that is not there or already satisfied, a blank reason and an invalid actor, and writes nothing", async (context) => {
  const { library } = await migratedLibrary(context);
  const before = (await materializeWorkspace(library)).version;
  const release = (input) => releaseGate(library, { id: OWNER_GATE_ID, reason: "why", actorId: RELEASER, occurredAt: at(), ...input });
  await assert.rejects(release({ id: "gate:ffffffffffffffffffffffff" }), { reasonCode: "WORKSPACE_INPUT_INVALID" });
  await assert.rejects(release({ reason: " \n" }), { reasonCode: "WORKSPACE_INPUT_INVALID" });
  await assert.rejects(release({ reason: "x".repeat(2_049) }), { reasonCode: "WORKSPACE_INPUT_INVALID" });
  await assert.rejects(release({ actorId: "nobody" }), { reasonCode: "WORKSPACE_ACTOR_INVALID" });
  assert.equal((await materializeWorkspace(library)).version, before, "a refused release appends nothing");
  await release({});
  await assert.rejects(release({}), (error) => error.reasonCode === "WORKSPACE_INPUT_INVALID" && /satisfied already/u.test(error.message));
});

test("489 (TCRN-CROSS-SUB-365): work-gate-list reads the gates that still hold work back, and --status the others", async (context) => {
  const { library, subtask } = await migratedLibrary(context);
  const list = (...args) => cli(["work-gate-list", "--workspace", library, ...args]);
  const holding = await list();
  assert.deepEqual([holding.reasonCode, holding.kind, holding.total], ["WORKSPACE_LIST_READY", "work-gate", 2]);
  assert.deepEqual(holding.records.map((gate) => [gate.id, gate.status, gate.workId, gate.outcomeClass]), [
    [OWNER_GATE_ID, "pending", subtask.id, "owner_intent_required"],
    [FIXTURE_GATE_ID, "pending", expected.records.story.id, "role_decision"],
  ]);
  assert.deepEqual((await list("--work-id", subtask.id)).records.map((gate) => gate.id), [OWNER_GATE_ID]);

  const reason = "Released for the list";
  const releasedAt = at();
  await releaseGate(library, { id: OWNER_GATE_ID, reason, actorId: RELEASER, occurredAt: releasedAt });
  assert.deepEqual((await list()).records.map((gate) => gate.id), [FIXTURE_GATE_ID]);
  const satisfied = await list("--status", "satisfied");
  assert.deepEqual(satisfied.records.map((gate) => [gate.id, gate.extensions[RELEASE_KEY].value]), [[OWNER_GATE_ID, { actor: RELEASER, reason, releasedAt }]]);
  assert.equal((await list("--status", "all")).total, 2, "the deleted fixture gate is not listed");
  assert.equal((await list("--status", "blocked")).total, 0);
  await assert.rejects(list("--status", "released"), { reasonCode: "CLI_ARGUMENT_MALFORMED" });
  assert.equal(await list("--status", "pending").then((page) => page.records[0].id), FIXTURE_GATE_ID);
});

/** The error the in-process CLI throws for `args`. */
async function refusalOf(args) {
  return runCli(args, { write: () => {} }).then(() => assert.fail(`${args[0]} was not refused`), (error) => error);
}

test("489 (MIN-235 D11; C-R17-6): work-gate-release refuses a model with MODEL_WRITE_REFUSED and appends nothing; for Atelier it records who, when and why, and the work item then goes to done", async (context) => {
  const { library, subtask, actor } = await migratedLibrary(context);
  const common = ["--workspace", library];
  await cli(["work-transition", ...common, "--at", at(), "--id", subtask.id, "--status", "active", "--actor", actor]);

  // What a model's shell sees at done: the gate and the one way it is released, through the bin.
  const held = spawnSync(process.execPath, [cliPath, "work-transition", ...common, "--at", at(), "--id", subtask.id, "--status", "done", "--actor", actor], { encoding: "utf8" });
  assert.equal(held.status, 1);
  const printed = JSON.parse(held.stderr.trim().split("\n").at(-1));
  assert.deepEqual([printed.reasonCode, printed.workId, printed.remedy], ["WORKSPACE_GATE_PENDING", subtask.id, `${GATE_RELEASE_VERB} --id ${OWNER_GATE_ID} --reason <why>, in Atelier`]);
  assert.match(printed.error, new RegExp(OWNER_GATE_ID, "u"));
  const before = (await materializeWorkspace(library)).version;

  // A model's write is refused before the library is opened.
  const releaseArgs = (reason) => ["work-gate-release", ...common, "--at", at(), "--id", OWNER_GATE_ID, "--reason", reason, "--actor", RELEASER];
  const refused = await withSurface(undefined, () => refusalOf(releaseArgs("a model's reason")));
  assert.deepEqual([refused.reasonCode, refused.details.gate, refused.details.remedy], ["MODEL_WRITE_REFUSED", OWNER_GATE_ID, MODEL_WRITE_REMEDY]);
  const bin = spawnSync(process.execPath, [cliPath, ...releaseArgs("through the bin")], { encoding: "utf8", env: { ...process.env, EINZBERN_SURFACE: "" } });
  assert.deepEqual(JSON.parse(bin.stderr.trim().split("\n").at(-1)).reasonCode, "MODEL_WRITE_REFUSED");
  assert.equal((await materializeWorkspace(library)).version, before, "a refused release appends nothing");

  // Atelier's write records the release in the gate.
  const releasedAt = at();
  const reason = "The Owner released the migrated gate in Atelier";
  const receipt = await withSurface(ATELIER_SURFACE, () => cli(["work-gate-release", ...common, "--at", releasedAt, "--id", OWNER_GATE_ID, "--reason", reason, "--actor", RELEASER]));
  assert.deepEqual([receipt.reasonCode, receipt.version, receipt.ids], ["WORKSPACE_COMMAND_COMPLETED", before + 1, [OWNER_GATE_ID]]);
  assert.deepEqual([receipt.record.id, receipt.record.status, receipt.record.revision, receipt.record.updatedAt], [OWNER_GATE_ID, "satisfied", 2, releasedAt]);
  assert.deepEqual(receipt.record.extensions[RELEASE_KEY], { required: false, value: { actor: RELEASER, reason, releasedAt } });
  const validated = await cli(["chain-validate", ...common]);
  assert.deepEqual([validated.reasonCode, validated.rejectedEventCount, validated.events], ["CHAIN_VALIDATED", 0, before + 1]);
  // The same gate is not released twice.
  const again = await withSurface(ATELIER_SURFACE, () => refusalOf(releaseArgs("once more")));
  assert.equal(again.reasonCode, "WORKSPACE_INPUT_INVALID");

  const done = await cli(["work-transition", ...common, "--at", at(), "--id", subtask.id, "--status", "done", "--actor", actor]);
  assert.equal(done.record.status, "done");
});

test("489 (TCRN-CROSS-SUB-365): work-transition and work-batch name a gate that holds a Story before they weigh its code gates, and write nothing", async (context) => {
  const { library, actor } = await migratedLibrary(context);
  const base = resolve(library, "..");
  const common = ["--workspace", library];
  const story = expected.records.story.id;
  const before = (await materializeWorkspace(library)).version;
  // The library declares no code gate, so without the pending gate the Story would be refused as
  // not covered (TCRN-CROSS-STORY-485 R4); the gate is named first.
  const single = await refusalOf(["work-transition", ...common, "--at", at(), "--id", story, "--status", "done", "--actor", actor]);
  assert.deepEqual([single.reasonCode, single.details.workId, single.details.gates], ["WORKSPACE_GATE_PENDING", story, FIXTURE_GATE_ID]);
  const batchFile = join(base, "batch.json");
  await writeFile(batchFile, JSON.stringify({ schemaVersion: "tcrn.work-batch.v1", members: [{ verb: "work-transition", id: story, status: "done" }] }));
  const batch = await refusalOf(["work-batch", ...common, "--at", at(), "--from-file", batchFile, "--actor", actor]);
  assert.deepEqual([batch.reasonCode, batch.details.gates], ["WORKSPACE_GATE_PENDING", FIXTURE_GATE_ID]);
  assert.equal((await materializeWorkspace(library)).version, before, "nothing was written");

  // Released, the Story meets the code gates' own refusal instead.
  await withSurface(ATELIER_SURFACE, () => cli(["work-gate-release", ...common, "--at", at(), "--id", FIXTURE_GATE_ID, "--reason", "decided", "--actor", RELEASER]));
  const covered = await refusalOf(["work-transition", ...common, "--at", at(), "--id", story, "--status", "done", "--actor", actor]);
  assert.equal(covered.reasonCode, "WORK_DONE_GATES_NOT_COVERED");
});

test("489 (TCRN-CROSS-SUB-365): the two gate verbs are cataloged, neither starts with gate- or minutes-, and only the release writes", () => {
  const entry = (name) => COMMAND_CATALOG.find((candidate) => candidate.name === name);
  const flags = (name) => entry(name).flags.map((flag) => [flag.name, flag.required, flag.valueKind]);
  assert.equal(entry("work-gate-list").mutates, false);
  assert.deepEqual(flags("work-gate-list"), [["workspace", false, "string"], ["work-id", false, "string"], ["status", false, "string"], ["limit", false, "integer"], ["offset", false, "integer"]]);
  assert.equal(entry("work-gate-release").mutates, true);
  assert.deepEqual(flags("work-gate-release"), [["workspace", false, "string"], ["at", true, "instant"], ["id", true, "string"], ["reason", true, "string"], ["actor", true, "string"]]);
  assert.equal(GATE_RELEASE_VERB, "work-gate-release", "the refusal names the cataloged verb");
  for (const name of ["work-gate-list", "work-gate-release"]) assert.equal(/^(gate|minutes)-/u.test(name), false, name);
});
