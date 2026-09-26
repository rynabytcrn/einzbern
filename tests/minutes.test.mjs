// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-475 R1-R3 at the core (TCRN-CROSS-SUB-305): minutes are recorded in one write
// and read back with their decisions numbered D1..Dn; the minutes a conference close wrote are
// read beside them, unchanged; keys are the writer's or the next free number; replay, the cached
// read and the write agree.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProject,
  createWork,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  minutesById,
  minutesView,
  openLegacyWorkspace,
  recordMinutes,
  replayLegacyWorkspace,
  workspaceViewDocuments,
} from "../dist/build/packages/core/src/index.js";
// The reads and the writer are in the barrel since the CLI unit (TCRN-CROSS-SUB-307); the key
// numbering and the record check stay inside the module.
import { nextMinutesExternalKey, validateMinutesRecord } from "../dist/build/packages/core/src/minutes.js";
import { deriveStableId } from "../dist/build/packages/protocol/src/index.js";
import { forgeOwnStream } from "./helpers/library-forge.mjs";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const at = (second) => `2026-09-26T11:00:${String(second).padStart(2, "0")}Z`;

async function library(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-minutes-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "MIN-PROJECT", name: "Minutes" })).projects[0].id;
  const workId = (await createWork(workspace, { occurredAt: at(2), projectId, externalKey: "MIN-INIT", kind: "Initiative", parentId: null, title: "init" })).work[0].id;
  const record = (fields, second = 3) => recordMinutes(workspace, {
    occurredAt: at(second), projectId, title: "Minutes", summary: "What was decided.", decisions: ["One."], decidedBy: ["agent:claude-opus-5-5"], linkedWorkIds: [], ...fields,
  });
  return { base, workspace, projectId, workId, record };
}

test("STORY-475 AC1 (core): three decisions in one write, read back as D1 to D3 under the id the key derives", async (context) => {
  const fixture = await library(context);
  const before = (await materializeWorkspace(fixture.workspace)).version;
  const state = await fixture.record({
    externalKey: "TEST-MIN-227",
    title: "Einzbern redesign",
    summary: "Three rulings.",
    decisions: ["Rename the engine.", "Retire the conference verbs.", "Keep history readable."],
    decidedBy: ["owner:ryan", "agent:claude-opus-5-5"],
    linkedWorkIds: [fixture.workId],
  });
  assert.equal(state.version, before + 1, "one event");
  const id = deriveStableId("minutes", "TEST-MIN-227");
  assert.deepEqual(state.minutes.map((entry) => entry.id), [id]);
  const event = state.events.at(-1);
  assert.equal(event.payload.operation, "minutes.recorded");
  assert.equal(event.payload.record.schemaVersion, "einzbern.minutes.v1");
  const entry = minutesById(state, "TEST-MIN-227");
  assert.equal(entry.id, id);
  assert.equal(entry.kind, "minutes");
  assert.deepEqual(entry.decisions, [
    { number: 1, text: "Rename the engine." },
    { number: 2, text: "Retire the conference verbs." },
    { number: 3, text: "Keep history readable." },
  ]);
  assert.deepEqual(minutesById(state, id), entry, "found by id as well as by key");
  assert.deepEqual(entry.linkedWorkIds, [fixture.workId]);
  assert.ok("minutes" in JSON.parse(workspaceViewDocuments(state)["extensions.json"]), "the extension view summarises the minutes");
  assert.deepEqual(await materializeWorkspaceFromGenesis(fixture.workspace), await materializeWorkspace(fixture.workspace), "replay and the cached read agree");
  assert.equal((await materializeWorkspace(fixture.workspace)).minutes.length, 1);
});

test("STORY-475 AC2 (core): the minutes a conference close wrote in the old-layout fixture read beside the new ones", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-minutes-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root } = await restoreLegacyFixture(base);
  const state = replayLegacyWorkspace(await openLegacyWorkspace(root));
  assert.equal(state.conferenceMinutes.length, 1);
  const historical = state.conferenceMinutes[0];
  const view = minutesView(state);
  assert.equal(view.length, 1);
  const entry = minutesById(state, historical.id);
  assert.equal(entry.kind, "conference-minutes");
  assert.equal(entry.externalKey, null, "a close never stored its key");
  assert.equal(entry.title, state.conferences.find((conference) => conference.id === historical.conferenceId).title);
  assert.deepEqual(entry.decisions, historical.decisions.map((text, index) => ({ number: index + 1, text })));
  assert.equal(entry.recordedAt, historical.updatedAt);
  assert.throws(() => minutesById(state, "minutes:000000000000000000000000"), (error) => error?.reasonCode === "MINUTES_NOT_FOUND");
});

test("STORY-475 R1: a key already taken is refused, and a record with no key takes the next free number", async (context) => {
  const fixture = await library(context);
  await assert.rejects(() => fixture.record({}), (error) => error?.reasonCode === "MINUTES_EXTERNAL_KEY_REQUIRED", "the first record names its key");
  await fixture.record({ externalKey: "TEST-MIN-007" });
  await assert.rejects(() => fixture.record({ externalKey: "test-min-007" }, 4), (error) => error?.reasonCode === "WORKSPACE_INPUT_INVALID" && /already exist/u.test(error.message));
  let state = await fixture.record({}, 5);
  assert.deepEqual(state.minutes.map((entry) => entry.externalKey).sort(), ["TEST-MIN-007", "TEST-MIN-008"], "the width of the digits is kept");
  state = await fixture.record({ externalKeyPrefix: "TEST-MIN-" }, 6);
  assert.ok(state.minutes.some((entry) => entry.externalKey === "TEST-MIN-009"));
  await assert.rejects(() => fixture.record({ externalKeyPrefix: "OTHER-MIN-" }, 7), (error) => error?.reasonCode === "MINUTES_EXTERNAL_KEY_REQUIRED");
  assert.equal(nextMinutesExternalKey(state), "TEST-MIN-010");
});

test("STORY-475 R1: a record out of shape, or linking work that is gone or elsewhere, is refused with nothing written", async (context) => {
  const fixture = await library(context);
  const other = (await createProject(fixture.workspace, { occurredAt: at(3), externalKey: "MIN-OTHER", name: "Other" })).projects.find((project) => project.name === "Other").id;
  const elsewhere = (await createWork(fixture.workspace, { occurredAt: at(4), projectId: other, externalKey: "MIN-ELSEWHERE", kind: "Initiative", parentId: null, title: "elsewhere" })).work.find((entry) => entry.externalKey === "MIN-ELSEWHERE").id;
  const before = (await materializeWorkspace(fixture.workspace)).version;
  const refusals = [
    [{ externalKey: "TEST-MIN-1", decisions: [] }, "MINUTES_RECORD_INVALID"],
    [{ externalKey: "TEST-MIN-1", decisions: Array.from({ length: 65 }, (_, index) => `D${index}`) }, "MINUTES_RECORD_INVALID"],
    [{ externalKey: "TEST-MIN-1", decisions: ["ok", " "] }, "MINUTES_RECORD_INVALID"],
    [{ externalKey: "TEST-MIN-1", title: "" }, "MINUTES_RECORD_INVALID"],
    [{ externalKey: "TEST-MIN-1", decidedBy: ["Owner"] }, "MINUTES_RECORD_INVALID"],
    [{ externalKey: "TEST-MIN-1", decidedBy: ["owner:a", "owner:a"] }, "MINUTES_RECORD_INVALID"],
    [{ externalKey: "TEST-MIN-1", linkedWorkIds: ["work:000000000000000000000000"] }, "WORKSPACE_INPUT_INVALID"],
    [{ externalKey: "TEST-MIN-1", linkedWorkIds: [elsewhere] }, "WORKSPACE_INPUT_INVALID"],
    [{ externalKey: "TEST-MIN-1", projectId: "project:000000000000000000000000" }, "WORKSPACE_INPUT_INVALID"],
  ];
  for (const [fields, reasonCode] of refusals) {
    await assert.rejects(() => fixture.record(fields, 5), (error) => error?.reasonCode === reasonCode, JSON.stringify(fields).slice(0, 80));
  }
  assert.equal((await materializeWorkspace(fixture.workspace)).version, before);
});

test("STORY-475 R1: replay refuses a minutes record whose id is not the one its key derives, or whose key is taken", async (context) => {
  assert.throws(() => validateMinutesRecord({
    schemaVersion: "einzbern.minutes.v1", id: "minutes:000000000000000000000000", externalKey: "TEST-MIN-1", projectId: "project:000000000000000000000001",
    title: "t", summary: "s", decisions: ["d"], decidedBy: [], linkedWorkIds: [], recordedAt: at(1), revision: 1, tombstone: false,
  }), (error) => error?.reasonCode === "MINUTES_RECORD_INVALID");
  const fixture = await library(context);
  await fixture.record({ externalKey: "TEST-MIN-1" });
  await fixture.record({ externalKey: "TEST-MIN-2" }, 4);
  // Forge the second record onto the first one's key: the stream stays intact, the rule breaks.
  await forgeOwnStream(fixture.workspace, (events) => events.map((event) => event.payload.operation === "minutes.recorded" && event.payload.record.externalKey === "TEST-MIN-2"
    ? { ...event, payload: { ...event.payload, record: { ...event.payload.record, externalKey: "TEST-MIN-1", id: deriveStableId("minutes", "TEST-MIN-1") } } }
    : event));
  const state = await materializeWorkspace(fixture.workspace);
  assert.equal(state.library.rejectedEvents.length, 1);
  assert.equal(state.library.rejectedEvents[0].reasonCode, "WORKSPACE_EVENT_CORRUPT");
  assert.match(state.library.rejectedEvents[0].detail, /duplicate minutes/u);
  assert.deepEqual(state.minutes.map((entry) => entry.externalKey), ["TEST-MIN-1"]);
});
