// SPDX-License-Identifier: Apache-2.0

// WSD-1: conference and gate records as additive workspace event-log operations.
// Proves the store round-trip, unknown-operation refusal, openness rules at
// verb and replay layers, the single-event atomic close payload, tombstone and
// pinning rules, golden-byte view/export stability for workspaces without
// extension records, crash recovery of the extension view, and replay determinism.
// Since TCRN-CROSS-STORY-469 every fixture is a library: views are projections of the
// state (a library keeps no view files), and a forged event the reducer refuses is a
// rejected event of the read rather than a failed read (TCRN-CROSS-STORY-468 R5).

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EVENT_PAYLOAD_OPERATION_EXTRAS,
  annotateWork,
  CONFERENCE_POSITION_CEILING_BYTES,
  createProject,
  createWork,
  exportWorkspace,
  initializeLibrary,
  materializeWorkspace,
  recoverWorkspace,
  setWorkspaceSetting,
  transitionWork,
  validateConferencePosition,
  validateWorkspace,
  workspaceBudgets,
  materializeWorkspace as materializeWorkspaceForBudgets,
  workspaceViewDocuments,
} from "../dist/build/packages/core/src/index.js";
import {
  assertCanonicalJson,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  deriveStableId,
  validateEventChain,
} from "../dist/build/packages/protocol/src/index.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import * as core from "../dist/build/packages/core/src/index.js";
import {
  appendHistoricalAttestationEnable,
  appendHistoricalConferenceCancel,
  appendHistoricalConferenceClose,
  appendHistoricalConferenceOpen,
  appendHistoricalConferencePosition,
  appendHistoricalGateCreate,
  appendHistoricalGateDelete,
  appendHistoricalGateTransition,
  appendHistoricalWorkCreate,
} from "./helpers/workspace-fixture.mjs";
import { asPinnedDevice } from "./helpers/device-home.mjs";
import { forgeOwnStream, readOwnStream } from "./helpers/library-forge.mjs";

const instant = (second) => `2026-07-11T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;

// WSD-4: a satisfaction evidence locator shares the suffix of the minutes id it
// names — conference-minutes:<suffix> resolves to minutes:<suffix>.
const minutesLocator = (minutesExternalKey) => `conference-minutes:${deriveStableId("minutes", minutesExternalKey).slice("minutes:".length)}`;

async function workspaceFixture(context, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-ext-store-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  // The library id follows the fixture key, as the workspace id did.
  await initializeLibrary({
    root: workspace,
    createdAt: instant(0),
    libraryId: deriveStableId("library", options.externalKey ?? "WORKSPACE-EXT-STORE"),
  });
  return { base, workspace };
}

// A project plus one Initiative, the anchor surface for conferences and gates.
async function seededFixture(context, options = {}) {
  const fixture = await workspaceFixture(context, options);
  let state = await createProject(fixture.workspace, {
    occurredAt: instant(1), externalKey: "PROJECT-EXT", name: "Extension",
  });
  const projectId = state.projects[0].id;
  state = await createWork(fixture.workspace, {
    occurredAt: instant(2), projectId, externalKey: "INITIATIVE-EXT", kind: "Initiative", parentId: null,
  });
  const workId = state.work[0].id;
  return { ...fixture, state, projectId, workId };
}

// A forged log is written with valid hashes (library-forge.mjs), so what is refused is the
// reducer rule under test. The refused event is the forged tail, listed with its reason.
async function rejectedTail(workspace, pattern) {
  const state = await materializeWorkspace(workspace);
  const rejected = state.library.rejectedEvents;
  assert.equal(rejected.length, 1, "exactly the forged event is refused");
  assert.equal(rejected[0].reasonCode, "WORKSPACE_EVENT_CORRUPT");
  assert.equal(rejected[0].sequence, state.version, "the refused event is the forged tail");
  if (pattern !== undefined) assert.match(rejected[0].detail, pattern);
  return state;
}

// The view documents of the library as it reads now.
async function viewsOf(workspace) {
  return workspaceViewDocuments(await materializeWorkspace(workspace));
}

function conferenceRecord(projectId, workId, overrides = {}) {
  return {
    schemaVersion: "tcrn.conference.v1.request",
    id: deriveStableId("conference", "CONF-FORGED"),
    projectId,
    type: "architecture",
    title: "Forged conference",
    linkedWorkIds: [workId],
    desiredOutcome: "decide the forged direction",
    participantIds: ["profile:reviewer-01"],
    status: "open",
    revision: 1,
    updatedAt: instant(3),
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

function minutesRecord(conferenceId, projectId, overrides = {}) {
  return {
    schemaVersion: "tcrn.conference.v1.minutes",
    id: deriveStableId("minutes", "MINUTES-FORGED"),
    conferenceId,
    projectId,
    summary: "Forged summary",
    outcomeClass: "role_decision",
    decisions: ["forged decision"],
    unresolvedIssues: [],
    revision: 1,
    updatedAt: instant(4),
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

function gateRecord(projectId, workId, overrides = {}) {
  return {
    schemaVersion: "tcrn.gate.v1",
    id: deriveStableId("gate", "GATE-FORGED"),
    projectId,
    workId,
    title: "Forged gate",
    outcomeClass: "role_decision",
    status: "pending",
    revision: 1,
    updatedAt: instant(3),
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

async function expectReasonAsync(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

// WSD-2: drive runCli with a write-capture, the pattern the other CLI suites use.
async function invokeCli(args) {
  let output = "";
  return runCli(args, { write: (value) => { output += value; } }).then(
    () => ({ ok: true, output }),
    (error) => ({ ok: false, reasonCode: error?.reasonCode }),
  );
}

// The mutating verbs take the engine write lock themselves. Seed the project + Initiative
// anchor through the CLI itself so the whole path — parse, write lock, engine append,
// canonical receipt — is exercised.
async function cliSeededFixture(context) {
  const fx = await workspaceFixture(context);
  const ws = fx.workspace;
  const project = JSON.parse((await invokeCli(["project-create", "--workspace", ws, "--at", instant(1), "--external-key", "PROJECT-CLI", "--name", "CLI"])).output);
  const work = JSON.parse((await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(2), "--project-id", project.record.id, "--external-key", "INITIATIVE-CLI", "--kind", "Initiative"])).output);
  return { ...fx, ws, projectId: project.record.id, workId: work.record.id };
}

test("conference and gate mutations round-trip through the event log with chained hashes, sorted collections, fresh views, and materialize parity", async (context) => {
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-ALPHA", projectId: fx.projectId, type: "architecture",
    title: "Store design", linkedWorkIds: [fx.workId], desiredOutcome: "pick the persistence route", participantIds: ["profile:architect-01"],
  });
  const conferenceId = state.conferences[0].id;
  assert.equal(conferenceId, deriveStableId("conference", "CONF-ALPHA"));
  state = await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(4), conferenceId, externalKey: "POSITION-ALPHA-1", authorActorId: "profile:architect-01",
    position: "Persist through the workspace event log.", risks: ["forward-compat reads as corruption"], recommendations: ["document the posture"], evidenceIds: [],
  });
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(5), conferenceId, minutesExternalKey: "MINUTES-ALPHA",
    summary: "Event-log persistence ratified.", outcomeClass: "role_decision",
    decisions: ["persist conference and gate records as event operations"], unresolvedIssues: [],
  });
  state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(6), externalKey: "CONF-BETA", projectId: fx.projectId, type: "risk",
    title: "Rollout risk", linkedWorkIds: [fx.workId], desiredOutcome: "assess rollout", participantIds: [],
  });
  const cancelledId = state.conferences.find((entry) => entry.id !== conferenceId).id;
  state = await appendHistoricalConferenceCancel(fx.workspace, {
    occurredAt: instant(7), conferenceId: cancelledId,
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(8), externalKey: "GATE-ALPHA", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  state = await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(9), id: gateId, status: "blocked",
  });
  state = await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(10), id: gateId, status: "satisfied", minutesLocator: minutesLocator("MINUTES-ALPHA"),
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(11), externalKey: "GATE-BETA", projectId: fx.projectId, workId: null,
    title: "Project-scoped gate", outcomeClass: "recommendation",
  });
  const deletedGateId = state.gates.find((entry) => entry.id !== gateId).id;
  state = await appendHistoricalGateDelete(fx.workspace, {
    occurredAt: instant(12), id: deletedGateId,
  });

  assert.equal(state.version, 12, "version equals the event count");
  assert.equal(state.events.length, 12);
  assert.doesNotThrow(() => validateEventChain(state.events), "the persisted chain stays hash-linked");
  assert.equal(state.library.streams.length, 1);
  assert.equal(state.library.streams[0].headEventHash, state.events.at(-1).eventHash, "the stream ends at the last event");

  const closed = state.conferences.find((entry) => entry.id === conferenceId);
  assert.equal(closed.status, "closed");
  assert.equal(closed.revision, 2);
  assert.equal(state.conferences.find((entry) => entry.id === cancelledId).status, "cancelled");
  assert.equal(state.conferencePositions.length, 1);
  assert.equal(state.conferencePositions[0].conferenceId, conferenceId);
  assert.equal(state.conferenceMinutes.length, 1);
  assert.equal(state.conferenceMinutes[0].conferenceId, conferenceId);
  assert.equal(state.conferenceMinutes[0].revision, 1);
  const satisfied = state.gates.find((entry) => entry.id === gateId);
  assert.equal(satisfied.status, "satisfied");
  assert.equal(satisfied.revision, 3);
  assert.deepEqual(satisfied.extensions, { "gate-evidence:conference-minutes": { required: false, value: minutesLocator("MINUTES-ALPHA") } }, "WSD-4: the resolving locator persists in the gate extensions");
  assert.equal(state.gates.find((entry) => entry.id === deletedGateId).tombstone, true);
  for (const collection of [state.conferences, state.conferencePositions, state.conferenceMinutes, state.gates]) {
    const sorted = [...collection].sort((left, right) =>
      (left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    assert.deepEqual(collection, sorted, "collections are sorted by projectId then id");
  }

  // The committed state constructed from the mutation delta is byte-identical
  // to a fresh full replay (SDC-3 parity), and replay is deterministic.
  const fresh = await materializeWorkspace(fx.workspace);
  assert.deepEqual(fresh, state);
  assert.deepEqual(await materializeWorkspace(fx.workspace), fresh);

  // Views are complete (including the fourth extension view), canonical, and stable.
  const validated = await validateWorkspace(fx.workspace);
  assert.equal(validated.version, 12);
  const documents = workspaceViewDocuments(validated);
  assert.deepEqual(Object.keys(documents).sort(), ["STATUS.md", "extensions.json", "index.json", "readback.json"]);
  const extensionsBytes = documents["extensions.json"];
  const extensionsIndex = assertCanonicalJson(extensionsBytes);
  assert.equal(extensionsIndex.schemaVersion, "tcrn.workspace-extension-index.v2");
  assert.deepEqual(Object.keys(extensionsIndex).sort(), ["conferenceMinutes", "conferencePositions", "conferences", "extensionsDigest", "gates", "schemaVersion"]);
  // STORY-299: v2 keeps the counts and replaces the records with a digest per
  // collection. The count assertions are the direct survivors of v1's `.length`
  // checks, not a weakening of them -- what a record contains is proved by the
  // detection legs below, and what it says is read from the event log.
  assert.equal(extensionsIndex.conferences.count, 2);
  assert.equal(extensionsIndex.gates.count, 2);
  assert.equal((await viewsOf(fx.workspace))["extensions.json"], extensionsBytes, "view bytes are stable across reads");

  // The export carries the collections and round-trips canonically.
  const exported = assertCanonicalJson(await exportWorkspace(fx.workspace));
  assert.equal(exported.conferences.length, 2);
  assert.equal(exported.conferencePositions.length, 1);
  assert.equal(exported.conferenceMinutes.length, 1);
  assert.equal(exported.gates.length, 2);

  // The atomic close event carries exactly {minutes, operation, record}.
  const closeEvent = state.events.find((entry) => entry.payload.operation === "conference.closed");
  assert.deepEqual(Object.keys(closeEvent.payload).sort(), ["minutes", "operation", "record"]);
  assert.deepEqual(EVENT_PAYLOAD_OPERATION_EXTRAS["conference.closed"], ["minutes"]);
  assert.equal(closeEvent.payload.record.status, "closed");
  assert.equal(closeEvent.payload.minutes.conferenceId, conferenceId);
});

// TCRN-CROSS-STORY-475 R3: the conference write verbs are gone, and with them the verb-side
// refusals. Every rule they enforced is replay's alone now: a position or a close aimed at a
// conference that is no longer open is refused by the reducer like any forged event.
test("STORY-475 R3: the conference writers are retired, and replay alone refuses a late position or a second close", async (context) => {
  for (const name of ["openConferenceInWorkspace", "appendConferencePositionInWorkspace", "closeConferenceInWorkspace", "cancelConferenceInWorkspace", "distillConferenceKnowledge"]) {
    assert.equal(core[name], undefined, `${name} is no longer exported`);
  }
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-RULES", projectId: fx.projectId, type: "verification",
    title: "Rules", linkedWorkIds: [fx.workId], desiredOutcome: "verify the rules", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-RULES",
    summary: "Closed.", outcomeClass: "discussion_only", decisions: [], unresolvedIssues: [],
  });
  await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(5), conferenceId, externalKey: "POSITION-LATE", authorActorId: "profile:late-01",
    position: "Too late.", risks: [], recommendations: [], evidenceIds: [],
  });
  const read = await rejectedTail(fx.workspace, /not open/u);
  assert.equal(read.conferencePositions.length, 0, "the late position does not apply");
});

test("hand-crafted event logs are refused by replay: unknown operations, openness, binding, pinning, tombstone, and validator rules", async (context) => {
  const record = (payload, second) => ({ occurredAt: instant(second), payload });
  const cases = [
    ["unknown operation conference.reopened", (fx) => [record({ operation: "conference.reopened", record: conferenceRecord(fx.projectId, fx.workId) }, 3)]],
    ["position appended to a closed conference", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      const closed = { ...conference, status: "closed", revision: 2, updatedAt: instant(4) };
      const minutes = minutesRecord(conference.id, fx.projectId);
      const position = {
        schemaVersion: "tcrn.conference.v1.position",
        id: deriveStableId("position", "POSITION-FORGED"),
        conferenceId: conference.id,
        projectId: fx.projectId,
        actorId: "profile:forger-01",
        position: "too late",
        risks: [],
        recommendations: [],
        evidenceIds: [],
        revision: 1,
        updatedAt: instant(5),
        tombstone: false,
        extensions: {},
      };
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ minutes, operation: "conference.closed", record: closed }, 4),
        record({ operation: "conference.position.appended", record: position }, 5),
      ];
    }],
    ["cancel of a cancelled conference", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      const cancelled = { ...conference, status: "cancelled", revision: 2, updatedAt: instant(4) };
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.updated", record: cancelled }, 4),
        record({ operation: "conference.updated", record: { ...cancelled, revision: 3, updatedAt: instant(5) } }, 5),
      ];
    }],
    ["timestamp not event-bound", (fx) => [record({ operation: "conference.created", record: conferenceRecord(fx.projectId, fx.workId, { updatedAt: instant(9) }) }, 3)]],
    ["create with a prior revision", (fx) => [record({ operation: "conference.created", record: conferenceRecord(fx.projectId, fx.workId, { revision: 2 }) }, 3)]],
    ["duplicate conference create", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.created", record: { ...conference, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["cancel that mutates a pinned field", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.updated", record: { ...conference, status: "cancelled", title: "Renamed", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["cancel that skips a revision", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.updated", record: { ...conference, status: "cancelled", revision: 3, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["close without the minutes extra", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ operation: "conference.closed", record: { ...conference, status: "closed", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["close whose minutes bind another conference", (fx) => {
      const conference = conferenceRecord(fx.projectId, fx.workId);
      const minutes = minutesRecord("conference:000000000000000000000000", fx.projectId);
      return [
        record({ operation: "conference.created", record: conference }, 3),
        record({ minutes, operation: "conference.closed", record: { ...conference, status: "closed", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["conference for a missing project", (fx) => [record({ operation: "conference.created", record: conferenceRecord("project:000000000000000000000000", fx.workId) }, 3)]],
    ["conference anchored to missing work", (fx) => [record({ operation: "conference.created", record: conferenceRecord(fx.projectId, "work:000000000000000000000000") }, 3)]],
    ["conference record with an unknown field maps ConferenceError to corruption", (fx) => [record({ operation: "conference.created", record: { ...conferenceRecord(fx.projectId, fx.workId), forged: true } }, 3)]],
    ["gate created outside pending", (fx) => [record({ operation: "gate.created", record: gateRecord(fx.projectId, fx.workId, { status: "satisfied" }) }, 3)]],
    ["gate record with a bad outcome class maps AssignmentGateError to corruption", (fx) => [record({ operation: "gate.created", record: gateRecord(fx.projectId, fx.workId, { outcomeClass: "committee_decision" }) }, 3)]],
    ["gate update that moves its work anchor", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, workId: null, status: "blocked", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["gate mutation after its tombstone", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.deleted", record: { ...gate, tombstone: true, revision: 2, updatedAt: instant(4) } }, 4),
        record({ operation: "gate.updated", record: { ...gate, status: "blocked", revision: 3, updatedAt: instant(5) } }, 5),
      ];
    }],
    ["gate delete that does not tombstone", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.deleted", record: { ...gate, revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    // WSD-4 replay parity: a log that drives a work item to done while a
    // non-tombstoned pending gate anchors it fails materialize.
    ["work driven to done past a pending gate", (fx) => {
      const work = fx.state.work.find((entry) => entry.id === fx.workId);
      const gate = gateRecord(fx.projectId, fx.workId, { updatedAt: instant(5) });
      return [
        record({ operation: "work.updated", record: { ...work, status: "ready", revision: 2, updatedAt: instant(3) } }, 3),
        record({ operation: "work.updated", record: { ...work, status: "active", revision: 3, updatedAt: instant(4) } }, 4),
        record({ operation: "gate.created", record: gate }, 5),
        record({ operation: "work.updated", record: { ...work, status: "done", revision: 4, updatedAt: instant(6) } }, 6),
      ];
    }],
    // WSD-4 replay parity: a gate.updated to satisfied re-resolves its persisted
    // evidence — a log with no resolving minutes, no evidence entry, or an
    // off-graph gate move all fail closed.
    ["gate satisfied in a log without resolving minutes", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, status: "satisfied", revision: 2, updatedAt: instant(4), extensions: { "gate-evidence:conference-minutes": { required: false, value: "conference-minutes:000000000000000000000000" } } } }, 4),
      ];
    }],
    ["gate satisfied in a log without an evidence entry", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, status: "satisfied", revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
    ["gate off-graph no-op transition pending to pending", (fx) => {
      const gate = gateRecord(fx.projectId, fx.workId);
      return [
        record({ operation: "gate.created", record: gate }, 3),
        record({ operation: "gate.updated", record: { ...gate, revision: 2, updatedAt: instant(4) } }, 4),
      ];
    }],
  ];
  for (const [name, forge] of cases) {
    await context.test(name, async (caseContext) => {
      const fx = await seededFixture(caseContext);
      await forgeOwnStream(fx.workspace, (events) => [
        ...events.map((event) => ({ occurredAt: event.occurredAt, payload: event.payload })),
        ...forge(fx),
      ]);
      await rejectedTail(fx.workspace);
    });
  }
});

test("INC-198 index size follows record count rather than extension prose, and still detects a prose change", async (context) => {
  const fixture = await workspaceFixture(context, { externalKey: "WORKSPACE-BOUNDED" });
  let state = await createProject(fixture.workspace, {
    occurredAt: instant(1), externalKey: "PROJECT-BOUNDED", name: "Bounded",
  });
  state = await createWork(fixture.workspace, {
    occurredAt: instant(2), projectId: state.projects[0].id, externalKey: "INITIATIVE-BOUNDED", kind: "Initiative", parentId: null,
  });
  const indexBytes = async () => (await viewsOf(fixture.workspace))["index.json"].length;
  const digest = async () => JSON.parse((await viewsOf(fixture.workspace))["readback.json"]).graphDigest;

  const small = await annotateWork(fixture.workspace, {
    occurredAt: instant(3), id: state.work[0].id, scope: "x",
  });
  const smallSize = await indexBytes();
  const smallDigest = await digest();

  // 8_000 characters is just under PROTOCOL_LIMITS.maxStringLength. Under the
  // previous index — which carried extension values verbatim — this single record
  // would have added those 8_000 bytes to the index, and a few hundred such records
  // pushed the whole view past the one-MiB canonical ceiling and made the workspace
  // unreadable. The index now carries the extension's digest, so the growth here is
  // a fixed-width hash, not the prose.
  await annotateWork(fixture.workspace, {
    occurredAt: instant(4), id: state.work[0].id, scope: "y".repeat(8_000),
  });
  const largeSize = await indexBytes();
  const largeDigest = await digest();

  assert.ok(largeSize - smallSize < 200, `index grew by ${largeSize - smallSize} bytes; prose must not enter the index`);
  // Detection power is the half that must not be traded away for the bound.
  assert.notEqual(largeDigest, smallDigest, "a scope change must still move the graph digest");
});

test("a workspace with zero conference/gate events keeps pre-change golden view bytes, view set, and export digest", (context) => asPinnedDevice(async () => {
  const fixture = await workspaceFixture(context, { externalKey: "WORKSPACE-GOLDEN" });
  let state = await createProject(fixture.workspace, {
    occurredAt: instant(1), externalKey: "PROJECT-GOLDEN", name: "Golden",
  });
  state = await createWork(fixture.workspace, {
    occurredAt: instant(2), projectId: state.projects[0].id, externalKey: "INITIATIVE-GOLDEN", kind: "Initiative", parentId: null,
  });
  state = await transitionWork(fixture.workspace, {
    occurredAt: instant(3), id: state.work[0].id, status: "ready",
  });
  assert.deepEqual(state.conferences, []);
  assert.deepEqual(state.conferencePositions, []);
  assert.deepEqual(state.conferenceMinutes, []);
  assert.deepEqual(state.gates, []);
  const documents = await viewsOf(fixture.workspace);
  assert.deepEqual(Object.keys(documents).sort(), ["STATUS.md", "index.json", "readback.json"], "extensions.json is absent");
  // Golden bytes. These were the pre-WSD-1 bytes until INC-198 re-derived both the
  // graph digest and the index payload, and TCRN-CROSS-STORY-363 re-derived them
  // again when WorkRecord gained `summary`. TCRN-CROSS-STORY-466 R2 moved the head event
  // hash and the export digest once more: every event this writer creates is now in the
  // einzbern.event.v1 namespace, and the namespace is part of each event hash basis.
  // TCRN-CROSS-STORY-468 R3 moved both once more: an einzbern.event.v1 also hashes its clock
  // and its device id. TCRN-CROSS-STORY-469 moved the workspace line, the head and the export
  // digest once more: the fixture is a library, its id stands where the workspace id stood, its
  // head is the digest over its stream heads, and its events are written by a pinned device.
  //
  // That re-derivation is the point of this fixture, not damage to it. The record
  // below is CREATED here, by the current writer, so it carries the new field and
  // every byte downstream of it moves: index payload, graph digest, head event hash
  // and export digest, all four. A record already on a chain does not: replay adds
  // no field to it, its bytes are the bytes its event stored, and the eight
  // partitions on this platform stay view-fresh across the upgrade -- which is the
  // property that made `summary` absent-by-default rather than null-by-default.
  //
  // Residual-applicability analysis for replacing rather than coexisting, per the
  // platform's constraint-evolution convention: the previous form canonicalised the
  // entire record set into one value, and `canonicalJson` fails closed past one
  // MiB. A workspace that accumulated enough governed prose therefore stopped
  // validating, listing, showing and exporting — cross-project reached 1.55 MiB at
  // 611 records and could not be read at all. So the old path does not still hold
  // for some supported user; it holds only until a chain grows, and then it bricks
  // it. Keeping it as a conditional would make view bytes depend on workspace size,
  // which is a worse invariant than changing them once. Hence a replacement with a
  // schema bump (`tcrn.workspace-index.v2`) rather than a coexisting variant, and
  // hence this fixture moves.
  //
  // Detection power is unchanged: the digest hashes each record and then the vector
  // of hashes, and the index carries each extension's digest, so any byte that
  // changes anywhere in a record still moves these bytes.
  assert.equal(documents["STATUS.md"], [
    "# Workspace Status",
    "",
    "- Workspace: `library:318d0b61f9e53caf60269802`",
    "- Version: 3",
    "- Projects: 1",
    "- Work records: 1",
    "- Graph digest: `29725f3ff695a77cea76f68bfc7244a0a56d1c7d07312d58633d56822c268ba7`",
    "- Authority: derived and rebuildable from the event chain",
    "",
  ].join("\n"));
  assert.equal(
    documents["index.json"],
    "{\"projects\":[{\"externalKey\":\"PROJECT-GOLDEN\",\"id\":\"project:0bf1a7f60bdb47a6be9f4586\",\"name\":\"Golden\",\"revision\":1,\"schemaVersion\":\"tcrn.project.v1\",\"tombstone\":false,\"updatedAt\":\"2026-07-11T00:00:01Z\"}],\"schemaVersion\":\"tcrn.workspace-index.v2\",\"work\":[{\"createdAt\":\"2026-07-11T00:00:02Z\",\"extensions\":{},\"externalKey\":\"INITIATIVE-GOLDEN\",\"id\":\"work:7370232bfce90e21835d2977\",\"kind\":\"Initiative\",\"labels\":[],\"parentId\":null,\"projectId\":\"project:0bf1a7f60bdb47a6be9f4586\",\"revision\":2,\"schemaVersion\":\"tcrn.work.v1\",\"scopeDigest\":\"ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356\",\"status\":\"ready\",\"summary\":null,\"title\":null,\"tombstone\":false,\"updatedAt\":\"2026-07-11T00:00:03Z\"}]}\n",
  );
  assert.equal(
    documents["readback.json"],
    "{\"authority\":\"derived-rebuildable\",\"graphDigest\":\"29725f3ff695a77cea76f68bfc7244a0a56d1c7d07312d58633d56822c268ba7\",\"headEventHash\":\"35d782dd4b86be351fd034e028cd5141f1dacebfe451802aa311493ad23f503a\",\"projectCount\":1,\"schemaVersion\":\"tcrn.workspace-readback.v1\",\"version\":3,\"workCount\":1,\"workspaceId\":\"library:318d0b61f9e53caf60269802\"}\n",
  );
  const exported = await exportWorkspace(fixture.workspace);
  assert.equal(canonicalSha256(assertCanonicalJson(exported)).length, 64);
  assert.equal(
    (await import("node:crypto")).createHash("sha256").update(exported, "utf8").digest("hex"),
    "a129057479f7906642672fde1c8bfb35a4aa498224b9bce41821688eb8614cd5",
    "export bytes match the recorded build",
  );
  assert.equal(exported.includes("conferences"), false, "no extension keys leak into legacy exports");
  await validateWorkspace(fixture.workspace);
}));

// A library append has one window after its commit point, and no view to leave stale: the
// event is durable, and every read projects extensions.json from it.
test("a crash across conference.closed leaves the event durable and recover() rebuilds extensions.json", async (context) => {
  for (const crashAt of ["after-event-commit"]) {
    await context.test(crashAt, async (caseContext) => {
      const fx = await seededFixture(caseContext);
      let state = await appendHistoricalConferenceOpen(fx.workspace, {
        occurredAt: instant(3), externalKey: "CONF-CRASH", projectId: fx.projectId, type: "release",
        title: "Crash close", linkedWorkIds: [fx.workId], desiredOutcome: "close across a crash", participantIds: [],
      });
      const conferenceId = state.conferences[0].id;
      await expectReasonAsync("WORKSPACE_FAULT_INJECTED", () => appendHistoricalConferenceClose(fx.workspace, {
        occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-CRASH",
        summary: "Crashed close.", outcomeClass: "role_decision", decisions: ["recover"], unresolvedIssues: [], crashAt,
      }));
      const recovered = await recoverWorkspace(fx.workspace);
      assert.equal(recovered.version, 4);
      assert.equal(recovered.conferences.find((entry) => entry.id === conferenceId).status, "closed");
      assert.equal(recovered.conferenceMinutes.length, 1);
      const validated = await validateWorkspace(fx.workspace);
      assert.equal(validated.version, 4);
      const extensionsIndex = assertCanonicalJson(workspaceViewDocuments(recovered)["extensions.json"]);
      assert.equal(extensionsIndex.conferenceMinutes.count, 1);
      // STORY-299 replaces v1's single-field check (`conferences[0].status === "closed"`)
      // with a stronger one: every collection digest in the rebuilt view must equal the
      // digest computed independently from the recovered state. v1 could only assert one
      // field of one record; this covers every byte of every record, which is what the
      // digest shape has to be held to if it is to replace the records themselves.
      // Red leg: let recover rebuild from stale state and the digests stop matching.
      const digestOf = (records) => canonicalSha256(records.map((record) => canonicalSha256(record)));
      assert.equal(extensionsIndex.conferences.digest, digestOf(recovered.conferences));
      assert.equal(extensionsIndex.conferencePositions.digest, digestOf(recovered.conferencePositions));
      assert.equal(extensionsIndex.conferenceMinutes.digest, digestOf(recovered.conferenceMinutes));
      assert.equal(extensionsIndex.gates.digest, digestOf(recovered.gates));
    });
  }
});

test("STORY-475 R3: every conference verb answers CLI_COMMAND_UNKNOWN and is gone from the catalog; historical minutes read through minutes-list", async (context) => {
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;
  const catalog = JSON.parse((await invokeCli(["commands"])).output).commands.map((entry) => entry.name);
  assert.deepEqual(catalog.filter((name) => name.startsWith("conference-")), []);
  for (const verb of ["conference-open", "conference-append-position", "conference-close", "conference-cancel", "conference-list-by-work", "conference-minutes-list", "conference-position-list"]) {
    const refused = await invokeCli([verb, "--workspace", ws, "--at", instant(3)]);
    assert.equal(refused.ok, false);
    assert.equal(refused.reasonCode, "CLI_COMMAND_UNKNOWN", verb);
  }
  assert.equal((await materializeWorkspace(ws)).version, 2, "nothing was written");

  // A conference closed on the chain is read with the minutes it wrote, byte-identically each time.
  const opened = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-CLI", projectId: fx.projectId, type: "architecture", title: "Store design",
    linkedWorkIds: [fx.workId], desiredOutcome: "pick the persistence route", participantIds: ["profile:architect-01"],
  });
  await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(4), conferenceId: opened.conferences[0].id, minutesExternalKey: "MINUTES-CLI",
    summary: "event-log persistence ratified", outcomeClass: "role_decision", decisions: ["persist conference records as events"], unresolvedIssues: [],
  });
  const listA = (await invokeCli(["minutes-list", "--workspace", ws, "--work-id", fx.workId])).output;
  const listB = (await invokeCli(["minutes-list", "--workspace", ws, "--work-id", fx.workId])).output;
  assert.equal(listA, listB, "minutes-list is byte-identical across invocations");
  const minutes = JSON.parse(listA).records;
  assert.deepEqual(minutes.map((entry) => [entry.id, entry.kind, entry.title]), [[deriveStableId("minutes", "MINUTES-CLI"), "conference-minutes", "Store design"]]);
});

test("STORY-370: historical conference positions carry actor attribution and an optional stance without a profile roster", async (context) => {
  const fx = await seededFixture(context);
  const opened = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-STORY-370", projectId: fx.projectId, type: "verification", title: "Attribution",
    linkedWorkIds: [fx.workId], desiredOutcome: "record positions", participantIds: [],
  });
  const conferenceId = opened.conferences[0].id;
  await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(4), conferenceId, externalKey: "POSITION-HISTORICAL-MARA", authorActorId: "profile:tcrn-mara-v1",
    position: "Historical profile attribution remains readable.", risks: [], recommendations: [], evidenceIds: [],
  });
  await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(5), conferenceId, externalKey: "POSITION-ACTOR-STANCE", authorActorId: "agent:claude-sonnet-5", stance: "反对",
    position: "The current actor records a bounded disagreement.", risks: [], recommendations: [], evidenceIds: [],
  });
  const state = await materializeWorkspace(fx.workspace);
  assert.deepEqual(state.library.rejectedEvents, []);
  assert.equal(state.conferencePositions.length, 2);
  assert.equal(state.conferencePositions.find((entry) => entry.actorId === "profile:tcrn-mara-v1")?.stance, undefined);
  assert.equal(state.conferencePositions.find((entry) => entry.actorId === "agent:claude-sonnet-5")?.stance, "反对");
});

// WSD-4: a work item at active, the surface a pending gate governs on its way to done.
async function activeGatedFixture(context) {
  const fx = await seededFixture(context);
  await transitionWork(fx.workspace, { occurredAt: instant(3), id: fx.workId, status: "ready" });
  const state = await transitionWork(fx.workspace, { occurredAt: instant(4), id: fx.workId, status: "active" });
  return { ...fx, state };
}

test("WSD-4: a pending gate fails a work transition to done closed at the verb and appends no event", async (context) => {
  const fx = await activeGatedFixture(context);
  const seeded = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(5), externalKey: "GATE-BLOCK", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const version = seeded.version;
  await expectReasonAsync("WORKSPACE_GATE_PENDING", () => transitionWork(fx.workspace, {
    occurredAt: instant(6), id: fx.workId, status: "done",
  }));
  assert.equal((await materializeWorkspace(fx.workspace)).version, version, "the blocked transition appended no event");
});

// MIN-102 裁定一. The clearance predicate counted `pending` alone while
// GATE_TRANSITIONS lets a gate move pending↔blocked freely and without evidence, so
// two legal commands took an unsatisfied gate out of the way of done — in a state
// whose name says the opposite. `satisfied` is the only state reached by citing
// resolving minutes, so it is the only one that may clear.
test("MIN-102 flipping a gate to blocked does not release the work item", async (context) => {
  const fx = await activeGatedFixture(context);
  const seeded = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(5), externalKey: "GATE-DISARM", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = seeded.gates[0].id;
  const blocked = await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(6), id: gateId, status: "blocked",
  });
  assert.equal(blocked.gates[0].status, "blocked", "the move itself stays legal — cleanup must never wedge");
  await expectReasonAsync("WORKSPACE_GATE_PENDING", () => transitionWork(fx.workspace, {
    occurredAt: instant(7), id: fx.workId, status: "done",
  }));
  assert.equal((await materializeWorkspace(fx.workspace)).version, blocked.version, "the refused transition appended no event");

  // The escape is unchanged and is still the tombstone, not the blocked state.
  const removed = await appendHistoricalGateDelete(fx.workspace, {
    occurredAt: instant(8), id: gateId,
  });
  const done = await transitionWork(fx.workspace, {
    occurredAt: instant(9), id: fx.workId, status: "done",
  });
  assert.equal(done.work.find((entry) => entry.id === fx.workId).status, "done");
  assert.deepEqual(await materializeWorkspace(fx.workspace), done, "the committed delta equals a full replay");
});

test("WSD-4: minutes-backed satisfaction unblocks the transition to done and the whole chain replays deterministically", async (context) => {
  const fx = await activeGatedFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(5), externalKey: "CONF-SAT", projectId: fx.projectId, type: "architecture",
    title: "Decide", linkedWorkIds: [fx.workId], desiredOutcome: "decide the gate", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(6), conferenceId, minutesExternalKey: "MINUTES-SAT",
    summary: "ratified", outcomeClass: "role_decision", decisions: ["proceed"], unresolvedIssues: [],
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(7), externalKey: "GATE-SAT", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  // Still pending: the transition to done is blocked.
  await expectReasonAsync("WORKSPACE_GATE_PENDING", () => transitionWork(fx.workspace, {
    occurredAt: instant(8), id: fx.workId, status: "done",
  }));
  state = await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(8), id: gateId, status: "satisfied", minutesLocator: minutesLocator("MINUTES-SAT"),
  });
  state = await transitionWork(fx.workspace, {
    occurredAt: instant(9), id: fx.workId, status: "done",
  });
  assert.equal(state.work.find((entry) => entry.id === fx.workId).status, "done");
  const fresh = await materializeWorkspace(fx.workspace);
  assert.deepEqual(fresh, state, "the committed delta equals a full replay");
  assert.deepEqual(await materializeWorkspace(fx.workspace), fresh, "replay is deterministic");
});

test("WSD-4: the gate.deleted tombstone is the deadlock escape that lets a wedged work item reach done", async (context) => {
  const fx = await activeGatedFixture(context);
  let state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(5), externalKey: "GATE-DEL", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "role_decision",
  });
  const gateId = state.gates[0].id;
  state = await appendHistoricalGateDelete(fx.workspace, { occurredAt: instant(6), id: gateId });
  state = await transitionWork(fx.workspace, { occurredAt: instant(7), id: fx.workId, status: "done" });
  assert.equal(state.work.find((entry) => entry.id === fx.workId).status, "done");
});

test("WSD-4: the designated set is exactly done — a pending gate leaves other targets unaffected", async (context) => {
  for (const target of ["blocked", "cancelled"]) {
    await context.test(`active to ${target}`, async (caseContext) => {
      const fx = await activeGatedFixture(caseContext);
      await appendHistoricalGateCreate(fx.workspace, {
        occurredAt: instant(5), externalKey: `GATE-${target}`, projectId: fx.projectId, workId: fx.workId,
        title: "Decision gate", outcomeClass: "role_decision",
      });
      const state = await transitionWork(fx.workspace, { occurredAt: instant(6), id: fx.workId, status: target });
      assert.equal(state.work.find((entry) => entry.id === fx.workId).status, target);
    });
  }
  await context.test("planned to ready", async (caseContext) => {
    const fx = await seededFixture(caseContext);
    await appendHistoricalGateCreate(fx.workspace, {
      occurredAt: instant(3), externalKey: "GATE-READY", projectId: fx.projectId, workId: fx.workId,
      title: "Decision gate", outcomeClass: "role_decision",
    });
    const state = await transitionWork(fx.workspace, { occurredAt: instant(4), id: fx.workId, status: "ready" });
    assert.equal(state.work.find((entry) => entry.id === fx.workId).status, "ready");
  });
});

test("gate-v1: the identity decision is written down, and replay judges it without the roster", async (context) => {
  // The decision has to survive as a record, because "which roster was in force when
  // this closed" is the question an auditor asks and the roster itself may be long
  // gone. What replay must NOT do is depend on it still existing, so everything below
  // is checked from the log alone.
  const fx = await seededFixture(context);
  const roster = {
    schemaVersion: "tcrn.gate-identity-authority.v1",
    permits: [{ actorId: "owner:governance", outcomeClasses: ["owner_intent_required"] }],
  };
  // The roster reader and the permission check are retired (TCRN-CROSS-STORY-467 R2); the
  // decision is written the way the retired transition wrote it: the actor and the digest
  // of the roster that was in force.
  const decision = { actorId: "owner:governance", authorityFileSha256: canonicalSha256(roster) };

  // Identity gating only means something on a chain that records who acted, so this
  // is the configuration the feature is for.
  await appendHistoricalAttestationEnable(fx.workspace, { occurredAt: instant(3), actorId: "owner:governance" });
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(4), externalKey: "CONF-DEC", projectId: fx.projectId, type: "architecture",
    title: "Decision", linkedWorkIds: [fx.workId], desiredOutcome: "rule", participantIds: [], actorId: "owner:governance",
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(5), conferenceId, minutesExternalKey: "MINUTES-DEC",
    summary: "Ruled.", outcomeClass: "owner_intent_required", decisions: ["ruled"], unresolvedIssues: [], actorId: "owner:governance",
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(6), externalKey: "GATE-DEC", projectId: fx.projectId, workId: fx.workId,
    title: "Decision gate", outcomeClass: "owner_intent_required", actorId: "owner:governance",
  });
  const gateId = state.gates[0].id;
  state = await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(7), id: gateId, status: "satisfied",
    minutesLocator: minutesLocator("MINUTES-DEC"), identity: decision, actorId: "owner:governance",
  });

  assert.deepEqual(state.gates[0].extensions["gate-identity:decision"], {
    required: false,
    value: { actorId: "owner:governance", authorityFileSha256: canonicalSha256(roster) },
  });

  // No roster exists anywhere: replay reads the decision from the log alone, the way a
  // rotated key or a fresh machine would leave it.
  const replayed = await materializeWorkspace(fx.workspace);
  assert.equal(replayed.version, 7, "replay does not need the roster it recorded");
  assert.deepEqual(replayed.gates[0].extensions, state.gates[0].extensions);
  // validate also rebuilds the materialised views, so this proves the recorded
  // decision round-trips through them without the roster too.
  assert.equal((await validateWorkspace(fx.workspace)).version, 7);
});

test("gate-v1: a decision that disagrees with its own event is refused", async (context) => {
  // Replay cannot tell a forged event from a real one -- unkeyed hashes see to that --
  // but it can refuse one that contradicts itself. A decision naming an actor the
  // event was not signed with is exactly that contradiction, and catching it costs
  // nothing external.
  const fx = await seededFixture(context);
  const roster = {
    schemaVersion: "tcrn.gate-identity-authority.v1",
    permits: [{ actorId: "owner:governance", outcomeClasses: ["owner_intent_required"] }],
  };
  // The roster reader and the permission check are retired (TCRN-CROSS-STORY-467 R2); the
  // decision is written the way the retired transition wrote it: the actor and the digest
  // of the roster that was in force.
  const decision = { actorId: "owner:governance", authorityFileSha256: canonicalSha256(roster) };

  // Identity gating only means something on a chain that records who acted, so this
  // is the configuration the feature is for.
  await appendHistoricalAttestationEnable(fx.workspace, { occurredAt: instant(3), actorId: "owner:governance" });
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(4), externalKey: "CONF-MIS", projectId: fx.projectId, type: "architecture",
    title: "Mismatch", linkedWorkIds: [fx.workId], desiredOutcome: "rule", participantIds: [], actorId: "owner:governance",
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(5), conferenceId, minutesExternalKey: "MINUTES-MIS",
    summary: "Ruled.", outcomeClass: "owner_intent_required", decisions: ["ruled"], unresolvedIssues: [], actorId: "owner:governance",
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(6), externalKey: "GATE-MIS", projectId: fx.projectId, workId: fx.workId,
    title: "Mismatch gate", outcomeClass: "owner_intent_required", actorId: "owner:governance",
  });
  const gateId = state.gates[0].id;
  await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(7), id: gateId, status: "satisfied",
    minutesLocator: minutesLocator("MINUTES-MIS"), identity: decision, actorId: "owner:governance",
  });

  // Rewrite the tail event so the decision says something else. The hashes are recomputed
  // the way any forger would (library-forge.mjs), because a forger with write access has the
  // same formula; if this were wrong the event would fail on its hash and the test would pass
  // for the wrong reason -- so the refusal is asserted by its detail too.
  const decisionOf = (event) => event.payload?.record?.extensions?.["gate-identity:decision"];
  assert.ok(decisionOf((await readOwnStream(fx.workspace)).events.at(-1)) !== undefined, "the satisfied transition must be on the log for the tamper to mean anything");
  const withDecision = (value) => (events) => events.map((event, index) => (index === events.length - 1
    ? { ...event, payload: { ...event.payload, record: { ...event.payload.record, extensions: { ...event.payload.record.extensions, "gate-identity:decision": { ...decisionOf(event), value } } } } }
    : event));

  // A decision that is not even shaped like one must go the same way. Without this the
  // shape check could be removed and every other case here would still pass.
  await forgeOwnStream(fx.workspace, withDecision({ actorId: "owner:governance", authorityFileSha256: "not-a-digest" }));
  const malformed = await rejectedTail(fx.workspace);
  assert.equal(malformed.gates[0].status, "pending", "a malformed decision does not apply");

  await forgeOwnStream(fx.workspace, withDecision({ ...decision, actorId: "agent:impostor" }));
  // Refused for the contradiction, not for a hash the forger would have got right.
  const contradicted = await rejectedTail(fx.workspace, /identity decision names agent:impostor/u);
  assert.equal(contradicted.gates[0].status, "pending", "a self-contradicting decision does not apply");
});

test("gate-v1: a chain written before gate-v1 still replays, owner gates and all", async (context) => {
  // The state under test can no longer be produced by the verb -- that is the point of
  // gate-v1 -- so it is written onto the log directly, which is exactly how it got
  // there on the chains that predate this feature. Two production chains carry five
  // such gates between them; if replay rejected them the feature would have bricked
  // every workspace that ever used owner_intent_required.
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-LEGACY", projectId: fx.projectId, type: "architecture",
    title: "Legacy", linkedWorkIds: [fx.workId], desiredOutcome: "rule", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-LEGACY",
    summary: "Ruled.", outcomeClass: "owner_intent_required", decisions: ["ruled"], unresolvedIssues: [],
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(5), externalKey: "GATE-LEGACY", projectId: fx.projectId, workId: fx.workId,
    title: "Legacy owner gate", outcomeClass: "owner_intent_required",
  });
  const gate = state.gates[0];

  const payload = {
    operation: "gate.updated",
    record: {
      ...gate, status: "satisfied", revision: gate.revision + 1, updatedAt: instant(6),
      extensions: { "gate-evidence:conference-minutes": { required: false, value: minutesLocator("MINUTES-LEGACY") } },
    },
  };
  await forgeOwnStream(fx.workspace, (events) => [...events, { occurredAt: instant(6), payload }]);

  const replayed = await materializeWorkspace(fx.workspace);
  assert.equal(replayed.version, 6, "a pre-gate-v1 owner gate must not brick the chain");
  assert.equal(replayed.gates[0].status, "satisfied");
  assert.deepEqual(Object.keys(replayed.gates[0].extensions), ["gate-evidence:conference-minutes"]);
});

test("gate-v1: replay accepts a forged tail-append, and this is proved rather than admitted", async (context) => {
  // The boundary gate-v1 does not cross. Event hashes are unkeyed, so anyone who can
  // write the log can compute a consistent event and replay will take it. Stating that
  // in prose costs nothing and could quietly stop being true; a test that fails the day
  // it stops being true is the only version worth having.
  //
  // If this case ever goes red, the boundary has moved and the written statement in
  // docs/architecture/agent-integration-v1.md must move with it.
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-FORGE", projectId: fx.projectId, type: "architecture",
    title: "Forge", linkedWorkIds: [fx.workId], desiredOutcome: "rule", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalConferenceClose(fx.workspace, {
    occurredAt: instant(4), conferenceId, minutesExternalKey: "MINUTES-FORGE",
    summary: "Ruled.", outcomeClass: "owner_intent_required", decisions: ["ruled"], unresolvedIssues: [],
  });
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(5), externalKey: "GATE-FORGE", projectId: fx.projectId, workId: fx.workId,
    title: "Forge gate", outcomeClass: "owner_intent_required",
  });
  const gate = state.gates[0];

  // No roster is consulted, no CLI is run, no permission is held. Only bytes: the event is
  // appended to the device's stream with the hashes and manifest the engine would write.
  const payload = {
    operation: "gate.updated",
    record: {
      ...gate, status: "satisfied", revision: gate.revision + 1, updatedAt: instant(6),
      extensions: { "gate-evidence:conference-minutes": { required: false, value: minutesLocator("MINUTES-FORGE") } },
    },
  };
  await forgeOwnStream(fx.workspace, (events) => [...events, { occurredAt: instant(6), payload }]);

  const replayed = await materializeWorkspace(fx.workspace);
  assert.equal(replayed.gates[0].status, "satisfied",
    "replay accepts a forged satisfied gate -- gate-v1 is a decision-point control, not a chain-integrity invariant");
  assert.deepEqual(replayed.library.rejectedEvents, [], "the forged event is applied, not refused");
  // The chain itself validates, which is the whole worry.
  assert.equal((await validateWorkspace(fx.workspace)).version, 6);
});

// E05 (advisory scope-on-record): work.annotated attaches non-binding advisory fields
// to a work record. These cases prove the round-trip and replay parity, the verb-side
// input rules, and that the reducer refuses a forged annotation that smuggles a status
// change or a foreign extension past the advisory-only delta.
test("E05: work-annotate attaches advisory extensions, round-trips, replays, and merges without replacing", async (context) => {
  const fx = await seededFixture(context);
  const workId = fx.workId;
  const minutesId = deriveStableId("minutes", "MINUTES-FORGED");

  let state = await annotateWork(fx.workspace, {
    occurredAt: instant(3), id: workId,
    scope: "carry the authoritative scope on the record", decidedBy: [minutesId],
  });
  const annotated = state.work.find((entry) => entry.id === workId);
  assert.equal(annotated.status, "planned", "an annotation never changes status");
  assert.equal(annotated.revision, 2);
  assert.deepEqual(annotated.extensions["advisory:scope"], { required: false, value: "carry the authoritative scope on the record" });
  assert.deepEqual(annotated.extensions["advisory:decided-by"], { required: false, value: [minutesId] });

  const replayed = await materializeWorkspace(fx.workspace);
  assert.equal(replayed.version, 3);
  assert.deepEqual(replayed.work.find((entry) => entry.id === workId).extensions, annotated.extensions, "replay reproduces the advisory extensions exactly");

  // A scope-only annotation updates scope and leaves the earlier decided-by in place.
  state = await annotateWork(fx.workspace, {
    occurredAt: instant(4), id: workId, scope: "revised scope",
  });
  const merged = state.work.find((entry) => entry.id === workId);
  assert.equal(merged.revision, 3);
  assert.equal(merged.extensions["advisory:scope"].value, "revised scope");
  assert.deepEqual(merged.extensions["advisory:decided-by"].value, [minutesId], "a scope-only annotation preserves decided-by");
});

test("E05: work-annotate fails closed at the verb on empty, malformed, or no-op input, appending nothing", async (context) => {
  const fx = await seededFixture(context);
  const workId = fx.workId;
  const good = deriveStableId("minutes", "MINUTES-FORGED");

  for (const bad of [
    {},
    { scope: "" },
    { decidedBy: [] },
    { decidedBy: ["not-a-minutes-id"] },
    { decidedBy: ["gate:abc123"] },
  ]) {
    await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => annotateWork(fx.workspace, {
      occurredAt: instant(3), id: workId, ...bad,
    }));
  }
  assert.equal((await materializeWorkspace(fx.workspace)).version, 2, "no rejected annotation appended an event");

  // One real annotation, then a byte-identical repeat is refused as a no-op.
  await annotateWork(fx.workspace, { occurredAt: instant(3), id: workId, scope: "s", decidedBy: [good] });
  await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => annotateWork(fx.workspace, {
    occurredAt: instant(4), id: workId, scope: "s", decidedBy: [good],
  }));
});

test("E05: a forged work.annotated event is refused by replay on a status change or a smuggled extension", async (context) => {
  const forge = async (context, mutateRecord) => {
    const fx = await seededFixture(context);
    const workId = fx.workId;
    await annotateWork(fx.workspace, {
      occurredAt: instant(3), id: workId, scope: "s", decidedBy: [deriveStableId("minutes", "MINUTES-FORGED")],
    });
    assert.equal((await materializeWorkspace(fx.workspace)).version, 3, "the honest chain replays");
    await forgeOwnStream(fx.workspace, (events) => events.map((event) => event.payload.operation === "work.annotated"
      ? { ...event, payload: { ...event.payload, record: mutateRecord(event.payload.record) } }
      : event));
    await rejectedTail(fx.workspace);
  };

  // A status change smuggled through an annotation.
  await context.test("status change", (sub) => forge(sub, (record) => ({ ...record, status: "ready" })));
  // A foreign (valid, required:false) extension smuggled alongside the advisory keys.
  await context.test("smuggled extension", (sub) => forge(sub, (record) => ({
    ...record, extensions: { ...record.extensions, "custom:smuggled": { required: false, value: "x" } },
  })));
  // An annotation that changes no advisory field at all.
  await context.test("empty delta", (sub) => forge(sub, (record) => {
    const { "advisory:scope": _scope, "advisory:decided-by": _decided, ...rest } = record.extensions;
    return { ...record, extensions: rest };
  }));
});

test("INIT-004, STORY-472 R1: the CLI refuses a new Incident, and an Incident already on a chain still reads under its Story", async (context) => {
  // Incident was opened for creation by INIT-004 and closed again by TCRN-CROSS-STORY-472 R1: a
  // defect is now a Story with a fixes relation. The records already written stay valid, so an
  // Incident found in a Story -- a resolving parent, or none -- is written here as the retired
  // verb wrote it, and replay alone judges it.
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;
  const storyScope = [
    "【Goal】为谁=the test owner；目的锚=exercise Incident parenting；符合性判据=the Incident materializes；判定人=执行方自证。",
    "【Requirements】现象与证据=the CLI previously rejected Incident creation；修复项=实现 Story 子项的 CLI 路径；Story keeps its complete scope and legacy elements.",
    "【Acceptance Criteria】GIVEN a Story WHEN an Incident is created under it THEN the Incident is materialized.",
    "【Business Background】INIT-004 CLI coverage.",
    "【Preconditions】the seeded workspace exists.",
    "【Assumptions】the CLI owns the test chain.",
    "【Use Cases & Examples】create a Story and an Incident child.",
    "【Feature Toggle & Setting】无；本测试不启用 feature toggle。",
    "【Permissions】the test owner may create work.",
    "【Implementation Notes】fixture-only scope.",
  ].join("\n\n");
  const story = JSON.parse((await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(3), "--project-id", fx.projectId, "--external-key", "EPIC-X", "--kind", "Epic",
    "--parent-id", fx.workId])).output);
  const st = JSON.parse((await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(4), "--project-id", fx.projectId, "--external-key", "STORY-X", "--kind", "Story",
    "--parent-id", story.record.id, "--scope", storyScope])).output);

  // A new Incident, found in that Story, is refused at the CLI with the engine's code.
  const refused = await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(5), "--project-id", fx.projectId, "--external-key", "BUG-1", "--kind", "Incident",
    "--parent-id", st.record.id]);
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, "WORK_KIND_RETIRED");
  assert.equal((await validateWorkspace(fx.workspace, false)).version, 4, "nothing was appended");

  // The historical Incident materializes under the Story, and list ordering stays deterministic
  // with a non-planning kind present.
  const incident = await appendHistoricalWorkCreate(fx.workspace, {
    externalKey: "BUG-1", projectId: fx.projectId, kind: "Incident", parentId: st.record.id, title: "record-title", occurredAt: instant(5),
  });
  const state = await materializeWorkspace(fx.workspace);
  const inc = state.work.find((w) => w.id === incident.id);
  assert.equal(inc.kind, "Incident");
  assert.equal(inc.parentId, st.record.id);
  assert.equal((await validateWorkspace(fx.workspace, false)).version, 5);
  const shown = JSON.parse((await invokeCli(["work-show", "--workspace", ws, "--id", incident.id])).output);
  assert.equal(shown.record.kind, "Incident", "and the CLI reads it");

  // A parentless historical Incident is equally valid (found nowhere in particular).
  await appendHistoricalWorkCreate(fx.workspace, {
    externalKey: "BUG-2", projectId: fx.projectId, kind: "Incident", title: "record-title", occurredAt: instant(6),
  });
  assert.equal((await materializeWorkspace(fx.workspace)).library.rejectedEvents.length, 0);

  // Release is refused the same way; the two kinds never creatable at the CLI stay closed.
  const release = await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(7), "--project-id", fx.projectId, "--external-key", "X-Release", "--kind", "Release"]);
  assert.equal(release.reasonCode, "WORK_KIND_RETIRED");
  for (const closed of ["Review", "Knowledge"]) {
    const r = await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(7), "--project-id", fx.projectId, "--external-key", `X-${closed}`, "--kind", closed]);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "CLI_ARGUMENT_MALFORMED", `${closed} should stay closed at the CLI`);
  }
});

// INIT-008: the sprint / release-train mechanism — a Release is a top-level batch
// container (parentless, like an Initiative) and members attach by the member-side
// advisory:sprint annotation carrying a qualified {workspaceId, workId} reference.
// TCRN-CROSS-STORY-472 R1 stops the write path creating Releases; the ones on a chain still
// read, still anchor sprint annotations, and are written here as the retired verb wrote them.
async function historicalRelease(fx, externalKey, second, parentId = null) {
  return appendHistoricalWorkCreate(fx.workspace, { externalKey, projectId: fx.projectId, kind: "Release", parentId, occurredAt: instant(second) });
}

test("sprint: a new Release is refused, and a historical one reads parentless", async (context) => {
  const fx = await seededFixture(context);
  await expectReasonAsync("WORK_KIND_RETIRED", () => createWork(fx.workspace, {
    occurredAt: instant(3), projectId: fx.projectId, externalKey: "SPRINT-W31", kind: "Release", parentId: null,
  }));
  await historicalRelease(fx, "SPRINT-W31", 3);
  const state = await materializeWorkspace(fx.workspace);
  const sprint = state.work.find((entry) => entry.externalKey === "SPRINT-W31");
  assert.equal(sprint.kind, "Release");
  assert.equal(sprint.parentId, null);
  assert.equal(sprint.status, "planned");
});

test("sprint: a Release cannot take a parent", async (context) => {
  // Load-bearing red-proof for guard SPRINT-01. A Release is enforced parentless, now by replay
  // alone; if this ever fails, the parentage rule that keeps the timebox axis from entangling
  // the scope tree has been dropped.
  const fx = await seededFixture(context);
  await historicalRelease(fx, "SPRINT-BAD", 3, fx.workId);
  await rejectedTail(fx.workspace, /GRAPH_PARENT_KIND_INVALID/u);
});

test("sprint: a valid sprint annotation is stored and round-trips", async (context) => {
  // Load-bearing red-proof for guard SPRINT-02. A member (the Initiative) is tagged onto a
  // sprint by a qualified reference to the sprint's Release record.
  const fx = await seededFixture(context);
  const workspaceId = fx.state.metadata.workspaceId;
  const sprintId = (await historicalRelease(fx, "SPRINT-W31", 3)).id;
  const ref = { workspaceId, workId: sprintId };
  const state = await annotateWork(fx.workspace, { occurredAt: instant(4), id: fx.workId, sprint: ref });
  const member = state.work.find((entry) => entry.id === fx.workId);
  assert.deepEqual(member.extensions["advisory:sprint"], { required: false, value: ref });
  assert.equal(member.status, "planned", "a sprint annotation never changes status");
  const replayed = await materializeWorkspace(fx.workspace);
  assert.deepEqual(replayed.work.find((entry) => entry.id === fx.workId).extensions["advisory:sprint"], { required: false, value: ref });
});

test("sprint: a malformed sprint reference fails closed at the verb", async (context) => {
  const fx = await seededFixture(context);
  for (const bad of [
    { workspaceId: "not-a-workspace", workId: "work:abc" },
    { workspaceId: "workspace:7732a51de4c38afb83bb77cf", workId: "notwork:abc" },
    { workspaceId: "workspace:7732a51de4c38afb83bb77cf" },
  ]) {
    await expectReasonAsync("WORKSPACE_INPUT_INVALID", () => annotateWork(fx.workspace, {
      occurredAt: instant(3), id: fx.workId, sprint: bad,
    }));
  }
  assert.equal((await materializeWorkspace(fx.workspace)).version, 2, "no rejected annotation appended an event");
});

test("sprint: a forged advisory:sprint value is refused by replay", async (context) => {
  const fx = await seededFixture(context);
  const ref = { workspaceId: fx.state.metadata.workspaceId, workId: (await historicalRelease(fx, "SPRINT-W31", 3)).id };
  await annotateWork(fx.workspace, { occurredAt: instant(4), id: fx.workId, sprint: ref });
  assert.equal((await materializeWorkspace(fx.workspace)).version, 4, "the honest chain replays");
  await forgeOwnStream(fx.workspace, (events) => events.map((event) => event.payload.operation === "work.annotated"
    ? { ...event, payload: { ...event.payload, record: { ...event.payload.record,
        extensions: { ...event.payload.record.extensions, "advisory:sprint": { required: false, value: { workspaceId: "bad", workId: ref.workId } } } } } }
    : event));
  await rejectedTail(fx.workspace);
});

test("sprint: a forged work.created carrying a malformed advisory value is refused by replay", async (context) => {
  // Red-proof for guard SPRINT-03. The honest createWork writes no advisory extension, so
  // the annotate path's value-shape check used to be the only one — a hand-crafted
  // work.created could plant a bad advisory:sprint that the envelope-only graph validator
  // would admit. The create-path check now closes that door.
  const fx = await seededFixture(context);
  await forgeOwnStream(fx.workspace, (events) => events.map((event) => event.payload.operation === "work.created" && event.payload.record.kind === "Initiative"
    ? (() => {
      const extensions = { ...event.payload.record.extensions, "advisory:sprint": { required: false, value: "not-a-qualified-reference" } };
      return { ...event, payload: { ...event.payload, record: { ...event.payload.record, extensions, scopeDigest: canonicalSha256(extensions) } } };
    })()
    : event));
  await rejectedTail(fx.workspace);
});

test("sprint: the CLI refuses a new Release and work-list --sprint filters members of a historical one", async (context) => {
  const fx = await cliSeededFixture(context);
  const ws = fx.ws;
  const workspaceId = (await validateWorkspace(ws)).metadata.workspaceId;
  // Release was creatable at the CLI from 0.5.0 until TCRN-CROSS-STORY-472 R1.
  const refused = await invokeCli(["work-create", "--title", "record-title", "--workspace", ws, "--at", instant(3), "--project-id", fx.projectId, "--external-key", "SPRINT-W31", "--kind", "Release", "--parent-id", "-"]);
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, "WORK_KIND_RETIRED");
  const sprintId = (await historicalRelease(fx, "SPRINT-W31", 3)).id;
  const qualified = `${workspaceId}#${sprintId}`;
  // Annotate the Initiative into the sprint through the CLI.
  const annotated = await invokeCli(["work-annotate", "--workspace", ws, "--at", instant(4), "--id", fx.workId, "--sprint", qualified]);
  assert.equal(annotated.ok, true, `sprint annotate failed: ${annotated.reasonCode}`);
  // work-list --sprint returns exactly the member; a different sprint ref returns none.
  const listed = JSON.parse((await invokeCli(["work-list", "--workspace", ws, "--sprint", qualified])).output);
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0].id, fx.workId);
  const other = JSON.parse((await invokeCli(["work-list", "--workspace", ws, "--sprint", `${workspaceId}#work:000000000000000000000000`])).output);
  assert.equal(other.records.length, 0);
  // A malformed --sprint spelling fails closed at the CLI.
  const bad = await invokeCli(["work-annotate", "--workspace", ws, "--at", instant(5), "--id", fx.workId, "--sprint", "no-hash-here"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonCode, "CLI_ARGUMENT_MALFORMED");
  // work-show projects the sprint tag as the qualified object.
  const shown = JSON.parse((await invokeCli(["work-show", "--workspace", ws, "--id", fx.workId])).output);
  assert.deepEqual(shown.advisory.sprint, { workspaceId, workId: sprintId });
  // A byte-identical sprint-only re-annotation is refused as a no-op.
  const noop = await invokeCli(["work-annotate", "--workspace", ws, "--at", instant(6), "--id", fx.workId, "--sprint", qualified]);
  assert.equal(noop.ok, false);
  assert.equal(noop.reasonCode, "WORKSPACE_INPUT_INVALID");
});

// MIN-102 裁定四. A position is carried verbatim — summarising one is what the
// deliberation-adoption convention forbids — and 2,048 bytes ran out at roughly 680
// CJK characters, which split 23 of this platform's deliberations across continuation
// records purely to fit. The raise was split in two: a fixed ceiling that replay knows,
// and a per-deployment budget that only the write path consulted. The write path and its
// budget (conference.positionBudgetBytes) are retired (TCRN-CROSS-STORY-475 R3); the
// ceiling still decides which historical positions replay.
test("MIN-102 the position ceiling still decides replay, and the retired budget setting takes no write", async (context) => {
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-BUDGET", projectId: fx.projectId,
    type: "architecture", title: "Budget", linkedWorkIds: [fx.workId], desiredOutcome: "size a position", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  const append = (key, size, second) => appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(second), conferenceId, externalKey: key,
    authorActorId: "actor:minerva", position: "x".repeat(size), risks: [], recommendations: [], evidenceIds: [],
  });
  state = await append("POS-AT-CEILING", CONFERENCE_POSITION_CEILING_BYTES, 4);
  assert.equal(state.conferencePositions[0].position.length, CONFERENCE_POSITION_CEILING_BYTES);
  assert.deepEqual((await materializeWorkspace(fx.workspace)).library.rejectedEvents, [], "a position at the ceiling replays");
  // One byte past the ceiling is refused by the validator the reducer runs on every position
  // (a string that long cannot even be put in an event: the protocol bound is the same number).
  const past = { ...state.conferencePositions[0], id: deriveStableId("position", "POS-PAST-CEILING"), position: "x".repeat(CONFERENCE_POSITION_CEILING_BYTES + 1) };
  assert.throws(() => validateConferencePosition(past), (error) => error?.reasonCode === "CONFERENCE_BUDGET_EXCEEDED");

  await expectReasonAsync("SETTINGS_KEY_UNREGISTERED", () => setWorkspaceSetting(fx.workspace, {
    occurredAt: instant(6), key: "conference.positionBudgetBytes", value: "8192",
  }));
});

// ---------------------------------------------------------------------------
// STORY-299. The extension index is a fixed-length verification summary, and the
// three properties below are what that claim has to be held to. They come as a
// set on purpose: boundedness alone is satisfied by writing nothing, and
// detection alone is satisfied by writing everything, which is the shape that
// locked the cross-project chain at 532 records (INC-198).
// ---------------------------------------------------------------------------

async function extensionIndexBytes(workspace) {
  return Buffer.byteLength((await viewsOf(workspace))["extensions.json"], "utf8");
}

async function extensionView(workspace) {
  return assertCanonicalJson((await viewsOf(workspace))["extensions.json"]);
}

// Grow one conference's governed prose by three orders of magnitude and the view
// must not notice. Red leg: put any record body back into the projection and this
// difference tracks the prose instead of staying flat.
test("STORY-299: extension view size is independent of the prose inside the records", async (context) => {
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-BOUND", projectId: fx.projectId, type: "release",
    title: "Bounded", linkedWorkIds: [fx.workId], desiredOutcome: "short", participantIds: [],
  });
  const smallBytes = await extensionIndexBytes(fx.workspace);
  const smallDigest = (await extensionView(fx.workspace)).conferences.digest;

  state = await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(4), conferenceId: state.conferences[0].id,
    externalKey: "POS-BOUND", authorActorId: "profile:analyst-01",
    position: "z".repeat(2_000), risks: [], recommendations: [], evidenceIds: [],
  });
  const largeBytes = await extensionIndexBytes(fx.workspace);
  const largeDigest = (await extensionView(fx.workspace)).conferences.digest;

  assert.ok(largeBytes - smallBytes < 200, `view grew by ${largeBytes - smallBytes} bytes; prose must not enter the view`);
  // The bound is only worth having if the view still moves when a record does.
  assert.equal(state.conferencePositions.length, 1);
  assert.notEqual(
    (await extensionView(fx.workspace)).conferencePositions.digest,
    smallDigest,
    "a new position must move its collection digest",
  );
  assert.equal(largeDigest, smallDigest, "an unrelated collection's digest must not move");
});

// The discriminating leg against every per-record shape, including the one the
// work index still uses. Ten times the records, and the file may only grow by the
// decimal width of the counts. Red leg: restore a per-record row and this fails
// by roughly a hundred kilobytes.
test("STORY-299: ten times the records changes the extension view by less than 64 bytes", async (context) => {
  const fx = await seededFixture(context);
  let version = 2;
  let bytesAtTen = 0;
  for (let index = 1; index <= 100; index += 1) {
    const state = await appendHistoricalConferenceOpen(fx.workspace, {
      occurredAt: instant(3 + index), externalKey: `CONF-SCALE-${index}`, projectId: fx.projectId,
      type: "release", title: `Scale ${index}`, linkedWorkIds: [fx.workId],
      desiredOutcome: `outcome ${"w".repeat(200)}`, participantIds: [],
    });
    version = state.version;
    if (index === 10) bytesAtTen = await extensionIndexBytes(fx.workspace);
  }
  const bytesAtHundred = await extensionIndexBytes(fx.workspace);
  assert.ok(
    Math.abs(bytesAtHundred - bytesAtTen) < 64,
    `view moved ${bytesAtHundred - bytesAtTen} bytes between 10 and 100 conferences; the shape is not fixed-length`,
  );
});

// Four single-point mutations, four required movements. Red leg: narrow
// collectionDigest to hash only record ids and the first two fail; drop the
// per-record hash and hash a set instead, and the reorder leg fails.
test("STORY-299: any single byte inside any extension record still moves the view", async (context) => {
  const fx = await seededFixture(context);
  let state = await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-DETECT", projectId: fx.projectId, type: "release",
    title: "Detect", linkedWorkIds: [fx.workId], desiredOutcome: "detect", participantIds: [],
  });
  const conferenceId = state.conferences[0].id;
  state = await appendHistoricalGateCreate(fx.workspace, {
    occurredAt: instant(4), externalKey: "GATE-DETECT", projectId: fx.projectId,
    workId: fx.workId, title: "Gate detect", outcomeClass: "role_decision",
  });
  const readView = () => extensionView(fx.workspace);
  const before = await readView();

  state = await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(5), conferenceId,
    externalKey: "POS-DETECT", authorActorId: "profile:analyst-01",
    position: "first position", risks: [], recommendations: [], evidenceIds: [],
  });
  const afterFirstPosition = await readView();
  assert.notEqual(afterFirstPosition.conferencePositions.digest, before.conferencePositions.digest, "a position's body must move its digest");

  state = await appendHistoricalConferencePosition(fx.workspace, {
    occurredAt: instant(6), conferenceId,
    externalKey: "POS-DETECT-2", authorActorId: "profile:reviewer-01",
    position: "second position", risks: [], recommendations: [], evidenceIds: [],
  });
  const afterSecondPosition = await readView();
  assert.notEqual(afterSecondPosition.conferencePositions.digest, afterFirstPosition.conferencePositions.digest);
  // Order is part of what the digest attests: the vector is hashed as a sequence,
  // never sorted or deduplicated, so two collections with the same members in a
  // different order are different facts and must read as different.
  assert.notEqual(
    canonicalSha256([canonicalSha256(state.conferencePositions[0]), canonicalSha256(state.conferencePositions[1])]),
    canonicalSha256([canonicalSha256(state.conferencePositions[1]), canonicalSha256(state.conferencePositions[0])]),
    "reordering two records must change the collection digest",
  );

  state = await appendHistoricalGateTransition(fx.workspace, {
    occurredAt: instant(7), id: state.gates[0].id, status: "blocked",
  });
  const afterGate = await readView();
  assert.notEqual(afterGate.gates.digest, before.gates.digest, "a gate's status must move its digest");
  assert.notEqual(afterGate.extensionsDigest, before.extensionsDigest, "the roll-up digest must move with any collection");
});

// The pre-commit half of the fix. Nothing may reach the disk when the projection
// does not fit. Red leg: move the projection back below writeSegment and version
// advances while the command still reports failure -- INC-198's seq 3842, exactly.
test("STORY-299: an over-budget projection is refused with the chain untouched", async (context) => {
  const fx = await seededFixture(context);
  const before = await materializeWorkspaceForBudgets(fx.workspace);
  await expectReasonAsync("WORKSPACE_VIEW_BUDGET_EXCEEDED", () => appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-BUDGET", projectId: fx.projectId, type: "release",
    title: "Over budget", linkedWorkIds: [fx.workId], desiredOutcome: "refused", participantIds: [],
    viewBudgetBytes: 128,
  }));
  const after = await materializeWorkspaceForBudgets(fx.workspace);
  assert.equal(after.version, before.version, "a refused projection must not advance the version");
  assert.equal(after.headEventHash, before.headEventHash, "a refused projection must not move the head");
  assert.equal(after.conferences.length, 0, "a refused projection must not leave a record behind");
  // And the workspace is still usable: the refusal is a property of the attempted
  // write, not a verdict on the chain.
  const validated = await validateWorkspace(fx.workspace);
  assert.equal(validated.version, before.version);
});

// The budget report is the reason the next ceiling arrives as a scheduled item
// rather than as an incident. Red leg: report only the extension view and the
// work index -- the next wall by measurement -- goes unwatched again.
test("STORY-299: the budget report covers every view and the record cap", async (context) => {
  const fx = await seededFixture(context);
  await appendHistoricalConferenceOpen(fx.workspace, {
    occurredAt: instant(3), externalKey: "CONF-BUDGETS", projectId: fx.projectId, type: "release",
    title: "Budgets", linkedWorkIds: [fx.workId], desiredOutcome: "measured", participantIds: [],
  });
  const budgets = workspaceBudgets(await materializeWorkspaceForBudgets(fx.workspace));
  assert.deepEqual(
    budgets.views.map((entry) => entry.name).sort(),
    ["STATUS.md", "extensions.json", "index.json", "readback.json"],
    "every view is metered, not just the one that filled up first",
  );
  for (const entry of budgets.views) {
    assert.equal(entry.headroomBytes, entry.limitBytes - entry.bytes);
    assert.ok(entry.bytes > 0);
    // Names only. A budget report that leaked a host path would put local
    // filesystem layout into every receipt that carries it.
    assert.equal(entry.name.includes("/"), false);
  }
  const projected = await extensionIndexBytes(fx.workspace);
  assert.equal(budgets.views.find((entry) => entry.name === "extensions.json").bytes, projected, "the meter reports the bytes the projection holds");
  assert.equal(budgets.events.count, 3);
  assert.equal(budgets.events.headroomEvents, budgets.events.limit - budgets.events.count);
  assert.ok(budgets.maxSegmentBytes > 0);
});
