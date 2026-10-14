// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-541 GWT1 and the CLI part of GWT2 (MIN-258 D3; TCRN-CROSS-SUB-510): four more writes
// the model barrier refuses take --decided-in minutes:<id>#D<n>, as the eight of TCRN-CROSS-STORY-526
// do: work-gate-release (the decision names the gate by its id), project-bindings-set and
// project-bindings-remove (the binding's key) and work-release --force (the work item, by its id or
// by its whole external key). A model's run citing a decision of minutes decided by owner:governance,
// valid and naming the target, writes, and its event records decidedIn, decidedInLibraryId and
// surface cli; citing a decision that does not name the target it is MODEL_WRITE_AUTHORIZATION_INVALID;
// citing none it is MODEL_WRITE_REFUSED, its remedy naming both ways, Atelier and --decided-in. A run
// for Atelier records surface atelier. chain-declare keeps its hard constraint: it takes no decision,
// and a model's run is refused with the remedy of Atelier's library page. Every library and device
// directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { MODEL_WRITE_DECISION_REMEDY, MODEL_WRITE_LIBRARY_PAGE_REMEDY, MODEL_WRITE_REMEDY, runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace, recordMinutes } from "../dist/build/packages/core/src/index.js";
import { ATELIER_SURFACE, appendHistoricalGateCreate, cliPath, withSurface } from "./helpers/workspace-fixture.mjs";
import { A, B, at, leaseLibrary } from "./helpers/work-lease-fixture.mjs";

const OWNER = "owner:governance";
const AGENT = "agent:claude-opus-5-5";
const RELEASER = "agent:claude-opus-5-5";

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  throw new Error(`${args[0]} was expected to refuse`);
}

const asModel = (operation) => withSurface(undefined, operation);
const asAtelier = (operation) => withSurface(ATELIER_SURFACE, operation);

/**
 * The work-lease library (INIT > EPIC > STORY > SUB, and a SIBLING Story) with two pending gates on
 * its Story, as a migration carries them, and one meeting decided by owner:governance whose decisions
 * name: D1 the first gate by its id, D2 the repositories binding, D3 the Epic by its external key, D4
 * the Sibling by its id, D5 a longer key that starts with the Epic's, and D6 nothing written here.
 */
async function decidedLibrary(context, key) {
  const f = await leaseLibrary(context, key);
  for (const [index, suffix] of ["OWNER", "SECOND"].entries()) {
    await appendHistoricalGateCreate(f.root, { externalKey: `${key}-GATE-${suffix}`, projectId: f.projectId, workId: f.ids.story, title: `Owner intent gate ${suffix}`, outcomeClass: "owner_intent_required", occurredAt: at(-7, index) });
  }
  const gates = (await materializeWorkspace(f.root)).gates.map((gate) => gate.id);
  const [gate, second] = [...gates].sort();
  const minutes = await recordMinutes(f.root, {
    occurredAt: at(-6), projectId: f.projectId, externalKey: `${key}-MIN`, title: `${key} decisions`, summary: "Writes the barrier keeps from a model.", decidedBy: [OWNER, AGENT], linkedWorkIds: [],
    decisions: [
      `Release the migrated gate ${gate}; the Owner accepted the Story by hand.`,
      "Bind the repositories of this project to the web repository, or drop them again.",
      `Free the lease on ${f.keys.epic} by force; its session ended.`,
      `The lease on ${f.ids.sibling} goes as well.`,
      `Archive the board ${f.keys.epic}-OLD next quarter.`,
      "Publish the handbook in three languages.",
    ],
  });
  const minutesId = minutes.minutes.find((entry) => entry.externalKey === `${key}-MIN`).id;
  const libraryId = (await materializeWorkspace(f.root)).metadata.workspaceId;
  return { ...f, gate, second, libraryId, owner: (number) => `${minutesId}#D${String(number)}` };
}

const lastPayload = async (root) => (await materializeWorkspace(root)).events.at(-1).payload;

function authorizedBy(payload, fx, decidedIn, surface = "cli") {
  assert.deepEqual([payload.decidedIn, payload.decidedInLibraryId, payload.surface], [decidedIn, fx.libraryId, surface], `${payload.operation} records its authorization`);
}

async function assertInvalid(fx, args, decidedIn, target, reason = "target-not-named") {
  const before = (await materializeWorkspace(fx.root)).version;
  const error = await asModel(() => refusal(args));
  assert.deepEqual([error.reasonCode, { ...error.details }], ["MODEL_WRITE_AUTHORIZATION_INVALID", { decidedIn, target, reason }], `${args[0]} ${target} citing ${decidedIn}`);
  assert.equal((await materializeWorkspace(fx.root)).version, before, `${args[0]}: a refused write appends nothing`);
}

async function assertRefused(fx, args, details) {
  const before = (await materializeWorkspace(fx.root)).version;
  const error = await asModel(() => refusal(args));
  assert.deepEqual([error.reasonCode, { ...error.details }], ["MODEL_WRITE_REFUSED", { ...details, remedy: MODEL_WRITE_DECISION_REMEDY }], `${args[0]} without a decision`);
  assert.equal((await materializeWorkspace(fx.root)).version, before, `${args[0]}: a refused write appends nothing`);
}

test("541 GWT1: the remedy of the four more writes names both ways, Atelier and --decided-in", () => {
  assert.match(MODEL_WRITE_DECISION_REMEDY, /Atelier/u);
  assert.match(MODEL_WRITE_DECISION_REMEDY, /--decided-in minutes:<id>#D<n>/u);
  assert.equal(MODEL_WRITE_LIBRARY_PAGE_REMEDY, "declare it on the library page in Atelier");
  assert.notEqual(MODEL_WRITE_LIBRARY_PAGE_REMEDY, MODEL_WRITE_REMEDY);
});

test("541 GWT1: work-gate-release writes for a decision naming the gate, records it, and refuses a model citing none or one that does not name the gate", async (context) => {
  const fx = await decidedLibrary(context, "MORE-GATE");
  const release = (gate, ...more) => ["work-gate-release", "--workspace", fx.root, "--at", at(1), "--id", gate, "--reason", "The Owner decided it.", "--actor", RELEASER, ...more];

  await assertRefused(fx, release(fx.gate), { gate: fx.gate });
  await assertInvalid(fx, release(fx.gate, "--decided-in", fx.owner(2)), fx.owner(2), fx.gate);
  await assertInvalid(fx, release(fx.second, "--decided-in", fx.owner(1)), fx.owner(1), fx.second);

  const receipt = await asModel(() => cli(release(fx.gate, "--decided-in", fx.owner(1))));
  assert.deepEqual([receipt.reasonCode, receipt.record.id, receipt.record.status], ["WORKSPACE_COMMAND_COMPLETED", fx.gate, "satisfied"]);
  const payload = await lastPayload(fx.root);
  assert.equal(payload.operation, "gate.updated");
  authorizedBy(payload, fx, fx.owner(1));
  assert.equal(payload.record.extensions["gate-evidence:atelier-release"].value.actor, RELEASER, "the release still records who, when and why");

  // A run for Atelier records surface atelier and no decision.
  await asAtelier(() => cli(release(fx.second)));
  const atelier = await lastPayload(fx.root);
  assert.deepEqual([atelier.operation, atelier.surface, Object.hasOwn(atelier, "decidedIn")], ["gate.updated", "atelier", false]);

  // Replay from the chain alone accepts both releases.
  const validated = await cli(["chain-validate", "--workspace", fx.root]);
  assert.deepEqual([validated.reasonCode, validated.rejectedEventCount], ["CHAIN_VALIDATED", 0]);
});

test("541 GWT1: project-bindings-set and project-bindings-remove write for a decision naming the binding's key, and refuse a model citing none or one that does not name it", async (context) => {
  const fx = await decidedLibrary(context, "MORE-BIND");
  const value = JSON.stringify({ bindings: [{ id: "web", name: "Web", repository: "example/web", buildService: "ci", buildProject: "web" }] });
  const set = (key, bound, ...more) => ["project-bindings-set", "--workspace", fx.root, "--at", at(1), "--project-id", fx.projectId, "--key", key, "--value", bound, ...more];
  const remove = (key, ...more) => ["project-bindings-remove", "--workspace", fx.root, "--at", at(2), "--project-id", fx.projectId, "--key", key, ...more];

  await assertRefused(fx, set("repositories", value), { key: "repositories" });
  const reference = JSON.stringify({ libraryId: fx.libraryId, projectId: fx.projectId });
  await assertInvalid(fx, set("common-default", reference, "--decided-in", fx.owner(2)), fx.owner(2), "common-default");
  await assertInvalid(fx, set("repositories", value, "--decided-in", fx.owner(6)), fx.owner(6), "repositories");

  await asModel(() => cli(set("repositories", value, "--decided-in", fx.owner(2))));
  const written = await lastPayload(fx.root);
  assert.deepEqual([written.operation, written.record.collection, written.record.key, written.record.projectId], ["config.record.set", "chain", "repositories", fx.projectId]);
  authorizedBy(written, fx, fx.owner(2));

  await assertRefused(fx, remove("repositories"), { key: "repositories" });
  await assertInvalid(fx, remove("repositories", "--decided-in", fx.owner(1)), fx.owner(1), "repositories");
  await asModel(() => cli(remove("repositories", "--decided-in", fx.owner(2))));
  const removed = await lastPayload(fx.root);
  assert.deepEqual([removed.operation, removed.record.key], ["config.record.removed", "repositories"]);
  authorizedBy(removed, fx, fx.owner(2));
  assert.equal((await materializeWorkspace(fx.root)).configRecords.some((record) => record.collection === "chain" && record.key === "repositories"), false);
});

test("541 GWT1: work-release --force writes for a decision naming the work item by its id or its whole external key, and refuses a model citing none or one that does not name it", async (context) => {
  const fx = await decidedLibrary(context, "MORE-LEASE");
  await cli(["work-claim", "--workspace", fx.root, "--at", at(0), "--id", fx.ids.epic, "--actor", A]);
  await cli(["work-claim", "--workspace", fx.root, "--at", at(0, 1), "--id", fx.ids.sibling, "--actor", A]);
  const force = (id, ...more) => ["work-release", "--workspace", fx.root, "--at", at(5), "--id", id, "--actor", B, "--force", "true", ...more];

  await assertRefused(fx, force(fx.ids.epic), { workId: fx.ids.epic });
  // Through the shipped entry the refusal reaches stderr with the remedy naming both ways.
  const shipped = spawnSync(process.execPath, [cliPath, ...force(fx.ids.epic)], { encoding: "utf8", env: { ...process.env, EINZBERN_SURFACE: "" } });
  assert.equal(shipped.status, 1);
  const line = JSON.parse(shipped.stderr.trim().split("\n").at(-1));
  assert.deepEqual([line.reasonCode, line.remedy], ["MODEL_WRITE_REFUSED", MODEL_WRITE_DECISION_REMEDY]);

  await assertInvalid(fx, force(fx.ids.epic, "--decided-in", fx.owner(6)), fx.owner(6), fx.ids.epic);
  // The external key is named whole: a longer key that begins with it does not name the Epic.
  await assertInvalid(fx, force(fx.ids.epic, "--decided-in", fx.owner(5)), fx.owner(5), fx.ids.epic);
  await assertInvalid(fx, force(fx.ids.sibling, "--decided-in", fx.owner(3)), fx.owner(3), fx.ids.sibling);

  const byKey = await asModel(() => cli(force(fx.ids.epic, "--decided-in", fx.owner(3))));
  assert.deepEqual([byKey.reasonCode, byKey.lease], ["WORKSPACE_COMMAND_COMPLETED", null]);
  const released = await lastPayload(fx.root);
  assert.deepEqual([released.operation, released.record.collection, released.record.key], ["config.record.removed", "lease", fx.ids.epic]);
  authorizedBy(released, fx, fx.owner(3));

  await asModel(() => cli(force(fx.ids.sibling, "--decided-in", fx.owner(4))));
  authorizedBy(await lastPayload(fx.root), fx, fx.owner(4));
  assert.equal((await cli(["work-show", "--workspace", fx.root, "--id", fx.ids.sibling])).lease, null);

  // A run for Atelier forces a release with surface atelier and no decision.
  await cli(["work-claim", "--workspace", fx.root, "--at", at(6), "--id", fx.ids.epic, "--actor", A]);
  await asAtelier(() => cli(["work-release", "--workspace", fx.root, "--at", at(7), "--id", fx.ids.epic, "--actor", "agent:test-portal", "--force", "true"]));
  const atelier = await lastPayload(fx.root);
  assert.deepEqual([atelier.operation, atelier.surface, Object.hasOwn(atelier, "decidedIn")], ["config.record.removed", "atelier", false]);

  // The holder's own release takes no decision and records none.
  await cli(["work-claim", "--workspace", fx.root, "--at", at(8), "--id", fx.ids.epic, "--actor", A]);
  await asModel(() => cli(["work-release", "--workspace", fx.root, "--at", at(9), "--id", fx.ids.epic, "--actor", A]));
  const own = await lastPayload(fx.root);
  assert.deepEqual([own.operation, Object.hasOwn(own, "surface"), Object.hasOwn(own, "decidedIn")], ["config.record.removed", false, false]);
  const validated = await cli(["chain-validate", "--workspace", fx.root]);
  assert.deepEqual([validated.reasonCode, validated.rejectedEventCount], ["CHAIN_VALIDATED", 0]);
});

test("541 GWT2 (CLI): chain-declare keeps its hard constraint: no --decided-in, a model refused with the remedy of Atelier's library page, Atelier writes", async (context) => {
  const fx = await decidedLibrary(context, "MORE-CHAIN");
  const declare = (...more) => ["chain-declare", "--workspace", fx.root, "--at", at(1), "--role", "coordination", "--coordination-library-id", fx.libraryId, ...more];
  const before = (await materializeWorkspace(fx.root)).version;
  const refused = await asModel(() => refusal(declare()));
  assert.deepEqual([refused.reasonCode, { ...refused.details }], ["MODEL_WRITE_REFUSED", { key: "chain.identity", remedy: MODEL_WRITE_LIBRARY_PAGE_REMEDY }]);
  assert.equal((await asModel(() => refusal(declare("--decided-in", fx.owner(1))))).reasonCode, "CLI_ARGUMENT_UNKNOWN", "a decision is not a way out for chain-declare");
  assert.equal((await materializeWorkspace(fx.root)).version, before, "nothing was appended");

  const declared = await asAtelier(() => cli(declare()));
  assert.equal(declared.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.deepEqual((await cli(["chain-identity", "--workspace", fx.root])).identity, { role: "coordination", coordinationLibraryId: fx.libraryId });
});
