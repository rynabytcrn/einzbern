// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 / TCRN-CROSS-SUB-269, TCRN-CROSS-STORY-469 / SUB-285: one place tests
// create a disposable library and drive the CLI against it. Importing it also gives the test
// process a disposable device directory (EINZBERN_HOME), so nothing reaches the real one.

import { testDeviceHome } from "./device-home.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli } from "../../dist/build/packages/cli/src/index.js";
import {
  ACTOR_ATTESTATION_ENABLE_OPERATION,
  appendEvents,
  buildActorAttestationEnableRecord,
  buildEventPayload,
  initializeLibrary,
} from "../../dist/build/packages/core/src/index.js";
import { canonicalExternalKey, compareCanonicalText, deriveStableId } from "../../dist/build/packages/protocol/src/index.js";

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
