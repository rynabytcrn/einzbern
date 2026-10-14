// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-526 GWT3, the check (MIN-256; TCRN-CROSS-SUB-451): a write the model barrier
// refuses may cite an Owner decision, minutes:<id>#D<n>. The decision authorizes it only when it is
// found (in the library written to, else in the coordination library its chain identity names,
// located through this device's registry), its minutes were decided by owner:governance, it is valid,
// and its text names the target, bounded, or as <prefix>.* for a target under <prefix>. Every other
// answer is MODEL_WRITE_AUTHORIZATION_INVALID with the decision, the target and the reason. Every
// library, project and device directory here is a temporary one.
// TCRN-CROSS-STORY-541 (MIN-258 D3; TCRN-CROSS-SUB-510): a work item, the target of work-release
// --force, is named by its id or by its external key, each whole, and never through <prefix>.*.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DECIDED_IN_VALUE_SHAPE,
  createProject,
  createWork,
  declareChainIdentity,
  initializeLibrary,
  materializeWorkspace,
  parseDecidedIn,
  recordMinutes,
  registerLibrary,
  verifyWriteAuthorization,
} from "../dist/build/packages/core/src/index.js";
// TCRN-CROSS-SUB-465: the barrel exports only what the CLI calls; the rest is read from the module.
import {
  WRITE_AUTHORIZATION_DECIDER,
  WRITE_AUTHORIZATION_REASONS,
  decisionNamesTarget,
  decisionNamesWork,
} from "../dist/build/packages/core/src/write-authorization.js";

const at = (second) => `2026-10-14T09:00:${String(second).padStart(2, "0")}Z`;
const OWNER = WRITE_AUTHORIZATION_DECIDER;

async function base(context, name) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `einzbern-write-authorization-${name}-`)));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A library with one project, and a writer of minutes in it that answers the new record's id.
async function library(context, name = "library") {
  const directory = await base(context, name);
  const workspace = join(directory, "library");
  await initializeLibrary({ root: workspace, createdAt: at(0) });
  const projectId = (await createProject(workspace, { occurredAt: at(1), externalKey: "AUTH-PROJECT", name: "Authorization" })).projects[0].id;
  let second = 2;
  const record = async (externalKey, decisions, decidedBy = [OWNER], declarations = {}) => {
    second += 1;
    const state = await recordMinutes(workspace, {
      occurredAt: at(second), projectId, externalKey, title: externalKey, summary: "What was decided.", decisions, decidedBy, linkedWorkIds: [],
      ...declarations,
    });
    return state.minutes.find((entry) => entry.externalKey === externalKey).id;
  };
  return { directory, workspace, projectId, record, state: () => materializeWorkspace(workspace) };
}

function refusedWith(reason, decidedIn, target) {
  return (error) => {
    assert.equal(error.reasonCode, "MODEL_WRITE_AUTHORIZATION_INVALID");
    assert.deepEqual({ ...error.details }, { decidedIn, target, reason });
    return true;
  };
}

test("SUB-451: the reasons are closed and a decision is cited as minutes:<id>#D<n>", () => {
  assert.deepEqual([...WRITE_AUTHORIZATION_REASONS], ["malformed", "not-found", "not-owner-decided", "obsolete", "target-not-named"]);
  assert.equal(DECIDED_IN_VALUE_SHAPE, "minutes:<id>#D<n>");
  assert.equal(OWNER, "owner:governance");
  assert.deepEqual({ ...parseDecidedIn("minutes:abc123#D8", "unit") }, { minutesId: "minutes:abc123", number: 8 });
  for (const value of ["TCRN-CROSS-MIN-256#D8", "minutes:abc123", "minutes:abc123#D0", "minutes:abc123#d1", "minutes:ABC#D1", " minutes:abc123#D1", ""]) {
    assert.throws(() => parseDecidedIn(value, "unit"), refusedWith("malformed", value, "unit"), value);
  }
});

test("SUB-451 (Q2): a decision names a target with no name character on either side, or as <prefix>.*", () => {
  assert.equal(decisionNamesTarget("Declare the gate unit for every Story.", "unit"), true);
  assert.equal(decisionNamesTarget("Declare `engine:test` now.", "engine:test"), true);
  assert.equal(decisionNamesTarget("设置 models.escalation.ceiling 为 flagship。", "models.escalation.ceiling"), true);
  assert.equal(decisionNamesTarget("Declare engine:test-wiring now.", "engine:test"), false, "a longer name is not the target");
  assert.equal(decisionNamesTarget("Run the verifying step.", "verify"), false);
  assert.equal(decisionNamesTarget("Set models.escalation.ceiling.", "models.escalation"), false, "a name under the target is not the target");
  assert.equal(decisionNamesTarget("Set xunit and unit2.", "unit"), false);
  // models.escalation.* authorizes the three escalation keys, not the tiers table.
  const wildcard = "The Owner sets models.escalation.* through the CLI.";
  for (const key of ["models.escalation.ceiling", "models.escalation.enabled", "models.escalation.threshold"]) {
    assert.equal(decisionNamesTarget(wildcard, key), true, key);
  }
  for (const key of ["models.tiers", "models.escalation", "models.escalationx.ceiling", "xmodels.escalation.ceiling"]) {
    assert.equal(decisionNamesTarget(wildcard, key), false, key);
  }
  assert.equal(decisionNamesTarget("Only models.*.ceiling changes.", "models.tiers"), false, "a star inside a name is no prefix wildcard");
  assert.equal(decisionNamesTarget("Set xmodels.escalation.* too.", "models.escalation.ceiling"), false, "the prefix is bounded on its left");
});

test("SUB-451 GWT3: a valid decision decided by owner:governance that names the target authorizes the write", async (context) => {
  const fixture = await library(context);
  const minutesId = await fixture.record("AUTH-MIN-1", ["Declare the gate unit with --covers **.", "The Owner sets models.escalation.* through the CLI."]);
  const state = await fixture.state();
  const gate = await verifyWriteAuthorization({ state, decidedIn: `${minutesId}#D1`, target: "unit" });
  assert.deepEqual({ ...gate }, { decidedIn: `${minutesId}#D1`, libraryId: state.metadata.workspaceId, target: "unit" });
  for (const key of ["models.escalation.ceiling", "models.escalation.enabled", "models.escalation.threshold"]) {
    assert.equal((await verifyWriteAuthorization({ state, decidedIn: `${minutesId}#D2`, target: key })).target, key);
  }
  await assert.rejects(verifyWriteAuthorization({ state, decidedIn: `${minutesId}#D2`, target: "models.tiers" }), refusedWith("target-not-named", `${minutesId}#D2`, "models.tiers"));
});

test("SUB-451 GWT3: a decision that does not name the target, was not decided by owner:governance, is obsolete or does not exist is refused", async (context) => {
  const fixture = await library(context);
  // Texts far apart in topic, so no record is refused as close to an earlier valid decision.
  const owned = await fixture.record("AUTH-MIN-2", ["Wire engine:test-wiring into continuous integration.", "Stories now need unit before done."]);
  const agents = await fixture.record("AUTH-MIN-3", ["Agents suggested unit as a required check."], ["agent:claude-opus-5-5", "owner:ryan"]);
  const withdrawn = await fixture.record("AUTH-MIN-4", ["The lint step must pass before merging."]);
  const superseded = await fixture.record("AUTH-MIN-5", ["Publish docs nightly."]);
  await fixture.record("AUTH-MIN-6", ["Retire that schedule; docs-site replaces it."], [OWNER], {
    withdraws: [`${withdrawn}#D1`],
    supersedes: [{ decision: `${superseded}#D1`, by: "D1" }],
  });
  const state = await fixture.state();
  const cases = [
    [`${owned}#D1`, "engine:test", "target-not-named"],
    [`${agents}#D1`, "unit", "not-owner-decided"],
    [`${withdrawn}#D1`, "lint", "obsolete"],
    [`${superseded}#D1`, "docs", "obsolete"],
    [`${owned}#D9`, "unit", "not-found"],
    ["minutes:0123456789abcdef01234567#D1", "unit", "not-found"],
    ["MIN-256#D8", "unit", "malformed"],
  ];
  for (const [decidedIn, target, reason] of cases) {
    await assert.rejects(verifyWriteAuthorization({ state, decidedIn, target }), refusedWith(reason, decidedIn, target), `${decidedIn} ${target}`);
  }
  assert.equal((await verifyWriteAuthorization({ state, decidedIn: `${owned}#D2`, target: "unit" })).libraryId, state.metadata.workspaceId);
});

test("SUB-451 (Q1): minutes the written library does not hold are looked up in the coordination library this device registers", async (context) => {
  const coordination = await library(context, "coordination");
  const project = await library(context, "project");
  const coordinationId = (await coordination.state()).metadata.workspaceId;
  await declareChainIdentity(coordination.workspace, { role: "coordination", coordinationLibraryId: coordinationId }, { occurredAt: at(40) });
  await declareChainIdentity(project.workspace, { role: "project", coordinationLibraryId: coordinationId }, { occurredAt: at(41) });
  const minutesId = await coordination.record("AUTH-MIN-7", ["Declare the gate unit in every project library."]);
  const decidedIn = `${minutesId}#D1`;
  const state = await project.state();

  // Not registered on this device: the coordination library cannot be read, so the minutes are not found.
  const emptyHome = join(await base(context, "home"), "einzbern");
  await mkdir(emptyHome, { recursive: true });
  await assert.rejects(verifyWriteAuthorization({ state, decidedIn, target: "unit", home: emptyHome }), refusedWith("not-found", decidedIn, "unit"));

  await registerLibrary({ projectPath: coordination.workspace, libraryPath: coordination.workspace, registeredAt: at(42), cloudHosted: false, gitRemote: null });
  const verified = await verifyWriteAuthorization({ state, decidedIn, target: "unit" });
  assert.deepEqual({ ...verified }, { decidedIn, libraryId: coordinationId, target: "unit" }, "the event records the library whose minutes hold the decision");
  await assert.rejects(verifyWriteAuthorization({ state, decidedIn, target: "lint" }), refusedWith("target-not-named", decidedIn, "lint"));
  assert.equal((await project.state()).version, state.version, "the check writes nothing to the library written to");
});

test("SUB-510: a decision names a work item by its id or by its whole external key, and no <prefix>.* names one", () => {
  const work = { id: "work:0123456789abcdef01234567", externalKey: "TCRN-CROSS-STORY-541" };
  assert.equal(decisionNamesWork("Free the lease on TCRN-CROSS-STORY-541 by force.", work), true);
  assert.equal(decisionNamesWork("Free work:0123456789abcdef01234567 as well.", work), true);
  assert.equal(decisionNamesWork("Free TCRN-CROSS-STORY-54 and TCRN-CROSS-STORY-5410.", work), false, "a shorter or longer key is not the key");
  assert.equal(decisionNamesWork("Archive TCRN-CROSS-STORY-541-OLD.", work), false, "a key that begins with it is not it");
  assert.equal(decisionNamesWork("Free STORY-541 now.", work), false, "part of the key is not the key");
  assert.equal(decisionNamesWork("Free the lease on TCRN-CROSS-STORY-541.", { id: work.id }), false, "without the key only the id names the item");
  // A dotted key shows the difference from decisionNamesTarget: <prefix>.* names a name, never a work item.
  const dotted = { id: work.id, externalKey: "AUTH.INIT" };
  assert.equal(decisionNamesTarget("Free every AUTH.* lease.", dotted.externalKey), true);
  assert.equal(decisionNamesWork("Free every AUTH.* lease.", dotted), false);
});

test("SUB-510: verifyWriteAuthorization with a work target accepts a decision naming the item's id or external key, and refuses one that names neither", async (context) => {
  const fixture = await library(context);
  const created = await createWork(fixture.workspace, { occurredAt: at(20), projectId: fixture.projectId, externalKey: "AUTH-INIT-541", kind: "Initiative", parentId: null, title: "AUTH-INIT-541" });
  const workId = created.work.find((record) => record.externalKey === "AUTH-INIT-541").id;
  const minutesId = await fixture.record("AUTH-MIN-541", [
    "Free the lease on AUTH-INIT-541 by force; its session ended.",
    `Release ${workId} the same way.`,
    "Archive AUTH-INIT-541-OLD and AUTH-INIT-5410 next quarter.",
  ]);
  const state = await fixture.state();
  for (const number of [1, 2]) {
    const verified = await verifyWriteAuthorization({ state, decidedIn: `${minutesId}#D${number}`, target: workId, targetKind: "work" });
    assert.deepEqual({ ...verified }, { decidedIn: `${minutesId}#D${number}`, libraryId: state.metadata.workspaceId, target: workId }, `D${number}`);
  }
  await assert.rejects(verifyWriteAuthorization({ state, decidedIn: `${minutesId}#D3`, target: workId, targetKind: "work" }), refusedWith("target-not-named", `${minutesId}#D3`, workId));
  // The external key names the item only for a work target; any other target is named by itself.
  await assert.rejects(verifyWriteAuthorization({ state, decidedIn: `${minutesId}#D1`, target: workId }), refusedWith("target-not-named", `${minutesId}#D1`, workId));
});
