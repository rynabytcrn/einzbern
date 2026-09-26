// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 / TCRN-CROSS-SUB-269, TCRN-CROSS-STORY-469 / SUB-285: one place tests
// create a disposable library and drive the CLI against it. Importing it also gives the test
// process a disposable device directory (EINZBERN_HOME), so nothing reaches the real one.

import { testDeviceHome } from "./device-home.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ATELIER_SURFACE, SURFACE_ENVIRONMENT_VARIABLE, runCli } from "../../dist/build/packages/cli/src/index.js";
import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  CONFERENCE_MINUTES_VERSION,
  CONFERENCE_POSITION_VERSION,
  CONFERENCE_REQUEST_VERSION,
  appendEvents,
  buildActorAttestationEnableRecord,
  buildEventPayload,
  initializeLibrary,
} from "../../dist/build/packages/core/src/index.js";
import { canonicalExternalKey, canonicalSha256, compareCanonicalText, deriveStableId } from "../../dist/build/packages/protocol/src/index.js";

export const repositoryRoot = resolve(import.meta.dirname, "../..");
export const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");

/** An instant `seconds` after 2026-01-01T00:00:00Z, in the strict form the engine takes. */
export function instant(seconds = 0) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString().replace(".000Z", "Z");
}

/** Run one CLI command in-process; resolves to the parsed receipt, rejects with the engine error. */
export async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

/** Run one CLI command in its own process through the shipped entry. */
export function cliProcess(args, { env = {} } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

/** The device directory this test process writes from. */
export const deviceHome = testDeviceHome;

// TCRN-CROSS-STORY-484 R4 (TCRN-CROSS-SUB-341): the CLI refuses a model's write of a variable, or of
// a setting that is not modelWritable, unless it runs for Atelier (EINZBERN_SURFACE=atelier). A test
// that writes through those verbs stands in for Atelier: standInForAtelier() sets the surface for the
// rest of the test process, in-process runs and spawned ones alike, and withSurface runs one
// operation as another surface (undefined for a model's shell) and puts the previous one back.
export { ATELIER_SURFACE };

/** Make this test process run the CLI as Atelier does, for every command that follows. */
export function standInForAtelier() {
  process.env[SURFACE_ENVIRONMENT_VARIABLE] = ATELIER_SURFACE;
}

/** Run `operation` with EINZBERN_SURFACE set to `surface`, or unset when it is undefined. */
export async function withSurface(surface, operation) {
  const previous = process.env[SURFACE_ENVIRONMENT_VARIABLE];
  const put = (value) => {
    if (value === undefined) delete process.env[SURFACE_ENVIRONMENT_VARIABLE];
    else process.env[SURFACE_ENVIRONMENT_VARIABLE] = value;
  };
  put(surface);
  try {
    return await operation();
  } finally {
    put(previous);
  }
}

/**
 * A disposable library with a project, removed when the test ends. `externalKey` names the
 * project (`<key>-PROJECT`). Returns the library path (as `workspace`, the flag every verb
 * takes), the project id and the base directory.
 */
export async function workspaceFixture(context, { externalKey = "FIXTURE-WORKSPACE", project = true } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-fixture-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "workspace");
  await initializeLibrary({ root: workspace, createdAt: instant(0) });
  let projectId = null;
  if (project) {
    const created = await cli(["project-create", "--workspace", workspace, "--at", instant(1), "--external-key", `${externalKey}-PROJECT`, "--name", "Fixture"]);
    projectId = created.record.id;
  }
  return { base, workspace, projectId };
}

/**
 * Append the historical attestation.actor.enabled event. Its write verb is retired
 * (TCRN-CROSS-STORY-467 R2), but chains that carry it still replay and still demand an
 * actor from it on, so a test of that rule builds the event through the engine's own
 * append path, exactly as the retired verb did.
 */
export async function appendHistoricalAttestationEnable(workspace, { occurredAt, actorId }) {
  return appendEvents(workspace, [(state) => ({
    payload: { operation: ACTOR_ATTESTATION_ENABLE_OPERATION, record: buildActorAttestationEnableRecord() },
    projects: state.projects,
    work: state.work,
  })], { occurredAt, actorId });
}

/**
 * A historical work.created for a kind the write path no longer creates (an Incident or a
 * Release, TCRN-CROSS-STORY-472 R1), appended past the write path exactly as work-create wrote it
 * before, so replay alone judges it. Returns the appended record.
 */
export async function appendHistoricalWorkCreate(workspace, { externalKey, projectId, kind, parentId = null, status = "planned", title = null, occurredAt, actorId }) {
  const record = {
    schemaVersion: "tcrn.work.v1",
    id: deriveStableId("work", canonicalExternalKey(externalKey)),
    externalKey: canonicalExternalKey(externalKey),
    projectId,
    kind,
    parentId,
    status,
    revision: 1,
    updatedAt: occurredAt,
    tombstone: false,
    extensions: {},
    scopeDigest: canonicalSha256({}),
    title,
    createdAt: occurredAt,
    labels: [],
  };
  await appendEvents(workspace, [(state) => ({
    payload: buildEventPayload("work.created", record),
    projects: state.projects,
    work: [...state.work, record],
  })], { occurredAt, ...(actorId === undefined ? {} : { actorId }) });
  return record;
}

// The conference write verbs are retired (TCRN-CROSS-STORY-475 R3). Conference events already
// on a chain still replay -- openness, binding, pinning, the position ceiling, the minutes bound
// to their close. Tests of that build the history through the engine's own append path, with the
// records the retired writers built, and leave every judgement to replay: nothing here validates.
// `options` passes an append option through (crashAt, viewBudgetBytes, actorId).
const byProjectThenId = (left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id);

function conferenceOf(state, conferenceId) {
  const conference = state.conferences.find((entry) => entry.id === conferenceId);
  if (conference === undefined) throw new Error(`no conference ${conferenceId} on the chain`);
  return conference;
}

function appendOptions({ occurredAt, actorId, crashAt, viewBudgetBytes }) {
  return {
    occurredAt,
    ...(actorId === undefined ? {} : { actorId }),
    ...(crashAt === undefined ? {} : { crashAt }),
    ...(viewBudgetBytes === undefined ? {} : { viewBudgetBytes }),
  };
}

/** A historical conference.created, as conference-open wrote it. */
export async function appendHistoricalConferenceOpen(workspace, input) {
  const record = {
    schemaVersion: CONFERENCE_REQUEST_VERSION,
    id: deriveStableId("conference", canonicalExternalKey(input.externalKey)),
    projectId: input.projectId,
    type: input.type,
    title: input.title,
    linkedWorkIds: input.linkedWorkIds,
    desiredOutcome: input.desiredOutcome,
    participantIds: input.participantIds,
    status: "open",
    revision: 1,
    updatedAt: input.occurredAt,
    tombstone: false,
    extensions: {},
  };
  return appendEvents(workspace, [(state) => ({
    payload: buildEventPayload("conference.created", record),
    projects: state.projects,
    work: state.work,
    conferences: [...state.conferences, record].sort(byProjectThenId),
  })], appendOptions(input));
}

/** A historical conference.position.appended, as conference-append-position wrote it. */
export async function appendHistoricalConferencePosition(workspace, input) {
  return appendEvents(workspace, [(state) => {
    const conference = conferenceOf(state, input.conferenceId);
    const record = {
      schemaVersion: CONFERENCE_POSITION_VERSION,
      id: deriveStableId("position", canonicalExternalKey(input.externalKey)),
      conferenceId: conference.id,
      projectId: conference.projectId,
      actorId: input.authorActorId,
      ...(input.stance === undefined ? {} : { stance: input.stance }),
      position: input.position,
      risks: input.risks,
      recommendations: input.recommendations,
      evidenceIds: input.evidenceIds,
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: {},
    };
    return {
      payload: buildEventPayload("conference.position.appended", record),
      projects: state.projects,
      work: state.work,
      conferencePositions: [...state.conferencePositions, record].sort(byProjectThenId),
    };
  }], appendOptions(input));
}

/** A historical conference.closed with its minutes, as conference-close wrote it. */
export async function appendHistoricalConferenceClose(workspace, input) {
  return appendEvents(workspace, [(state) => {
    const conference = conferenceOf(state, input.conferenceId);
    const record = { ...conference, status: "closed", revision: conference.revision + 1, updatedAt: input.occurredAt };
    const minutes = {
      schemaVersion: CONFERENCE_MINUTES_VERSION,
      id: deriveStableId("minutes", canonicalExternalKey(input.minutesExternalKey)),
      conferenceId: conference.id,
      projectId: conference.projectId,
      summary: input.summary,
      outcomeClass: input.outcomeClass,
      decisions: input.decisions,
      unresolvedIssues: input.unresolvedIssues,
      revision: 1,
      updatedAt: input.occurredAt,
      tombstone: false,
      extensions: input.executionForm === undefined ? {} : { "conference:execution-form": { required: false, value: input.executionForm } },
    };
    return {
      payload: buildEventPayload("conference.closed", record, undefined, { minutes }),
      projects: state.projects,
      work: state.work,
      conferences: state.conferences.map((entry) => (entry.id === record.id ? record : entry)),
      conferenceMinutes: [...state.conferenceMinutes, minutes].sort(byProjectThenId),
    };
  }], appendOptions(input));
}

/** A historical conference.updated to cancelled, as conference-cancel wrote it. */
export async function appendHistoricalConferenceCancel(workspace, input) {
  return appendEvents(workspace, [(state) => {
    const conference = conferenceOf(state, input.conferenceId);
    const record = { ...conference, status: "cancelled", revision: conference.revision + 1, updatedAt: input.occurredAt };
    return {
      payload: buildEventPayload("conference.updated", record),
      projects: state.projects,
      work: state.work,
      conferences: state.conferences.map((entry) => (entry.id === record.id ? record : entry)),
    };
  }], appendOptions(input));
}

// The gate write verbs are retired (TCRN-CROSS-STORY-467 R2). Gate records already on a
// chain still replay -- lifecycle, evidence re-resolution, the identity-decision shape -- and
// a pending gate still holds its work item back from done. Tests of that build the history
// through the engine's own append path, exactly as the retired verbs did, and leave every
// judgement to replay: nothing here validates.
const GATE_EVIDENCE_KEY = "gate-evidence:conference-minutes";
const GATE_IDENTITY_KEY = "gate-identity:decision";

async function appendGateEvent(workspace, operation, buildRecord, { occurredAt, actorId }) {
  return appendEvents(workspace, [(state) => {
    const record = buildRecord(state);
    return {
      payload: buildEventPayload(operation, record),
      projects: state.projects,
      work: state.work,
      gates: [...state.gates.filter((entry) => entry.id !== record.id), record]
        .sort((left, right) => compareCanonicalText(left.projectId, right.projectId) || compareCanonicalText(left.id, right.id)),
    };
  }], { occurredAt, ...(actorId === undefined ? {} : { actorId }) });
}

function currentGate(state, id) {
  const gate = state.gates.find((entry) => entry.id === id);
  if (gate === undefined) throw new Error(`no gate ${id} on the chain`);
  return gate;
}

/** A historical gate.created, as gate-create wrote it. */
export async function appendHistoricalGateCreate(workspace, { externalKey, projectId, workId, title, outcomeClass, occurredAt, actorId }) {
  return appendGateEvent(workspace, "gate.created", () => ({
    schemaVersion: "tcrn.gate.v1",
    id: deriveStableId("gate", canonicalExternalKey(externalKey)),
    projectId,
    workId,
    title,
    outcomeClass,
    status: "pending",
    revision: 1,
    updatedAt: occurredAt,
    tombstone: false,
    extensions: {},
  }), { occurredAt, actorId });
}

/** A historical gate.updated, as gate-transition wrote it (evidence and identity entries included). */
export async function appendHistoricalGateTransition(workspace, { id, status, minutesLocator, identity, occurredAt, actorId }) {
  return appendGateEvent(workspace, "gate.updated", (state) => {
    const current = currentGate(state, id);
    let extensions = current.extensions;
    if (minutesLocator !== undefined) extensions = { ...extensions, [GATE_EVIDENCE_KEY]: { required: false, value: minutesLocator } };
    if (identity !== undefined) extensions = { ...extensions, [GATE_IDENTITY_KEY]: { required: false, value: identity } };
    return { ...current, status, revision: current.revision + 1, updatedAt: occurredAt, extensions };
  }, { occurredAt, actorId });
}

/** A historical gate.deleted, as gate-delete wrote it. */
export async function appendHistoricalGateDelete(workspace, { id, occurredAt, actorId }) {
  return appendGateEvent(workspace, "gate.deleted", (state) => {
    const current = currentGate(state, id);
    return { ...current, revision: current.revision + 1, updatedAt: occurredAt, tombstone: true };
  }, { occurredAt, actorId });
}
