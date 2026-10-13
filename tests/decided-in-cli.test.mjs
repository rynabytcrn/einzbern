// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-526 GWT1 to GWT3 through the CLI (MIN-256; TCRN-CROSS-SUB-453): the eight writes a
// model's run is refused -- gates-config-set and -remove, rule-enable and -disable, settings-set and
// -remove, variable-set and -remove -- take --decided-in minutes:<id>#D<n>. A model's run that cites a
// decision of minutes decided by owner:governance, valid and naming the target, writes, and its events
// record decidedIn, the library whose minutes hold it (decidedInLibraryId) and surface cli; a run for
// Atelier records surface atelier. A run citing a decision that does not qualify is
// MODEL_WRITE_AUTHORIZATION_INVALID and changes nothing; a run citing none is still
// MODEL_WRITE_REFUSED, its remedy now naming --decided-in. The writes that take no decision keep their
// refusal and its remedy. Every project, library and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import { ATELIER_SURFACE, withSurface } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MODEL_WRITE_DECISION_REMEDY, MODEL_WRITE_REMEDY, assertModelWriteAllowed, runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace, recordMinutes, setWorkspaceSetting } from "../dist/build/packages/core/src/index.js";

const ENTRY = resolve(import.meta.dirname, "..", "scripts", "einzbern.mjs");
const OWNER = "owner:governance";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 10, 0, second)).toISOString().replace(".000Z", "Z");
};

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
 * A registered project with an AGENTS.md of the user's own and its library in .ether, holding the
 * minutes of two meetings: one decided by owner:governance (four decisions, one per kind of target)
 * and one decided by an agent alone.
 */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-decided-in-")));
  const previous = process.env.EINZBERN_HOME;
  const device = join(base, "device");
  process.env.EINZBERN_HOME = device;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const project = join(base, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "# Project\n\nThe user's own notes.\n");
  const library = join(project, ".ether");
  await cli(["init", "--workspace", library, "--at", at(), "--project", project]);
  const projectId = (await cli(["project-create", "--workspace", library, "--external-key", "DECIDED-PROJECT", "--name", "Decided", "--at", at()])).record.id;
  await cli(["library-register", "--library", library, "--project", project, "--project-id", projectId, "--at", at()]);
  await setWorkspaceSetting(library, { key: "artifact.language", value: "zh-CN", occurredAt: at() });
  const record = async (externalKey, decisions, decidedBy) => (await recordMinutes(library, {
    occurredAt: at(), projectId, externalKey, title: externalKey, summary: "Configuration the CLI may change.", decisions, decidedBy, linkedWorkIds: [],
  })).minutes.find((entry) => entry.externalKey === externalKey).id;
  const owner = await record("DECIDED-MIN-1", [
    "Gate unit becomes required; gate lint retires.",
    "Command Spell rule batch may be switched from the CLI.",
    "The Owner tunes models.escalation.* from the CLI.",
    "Variables deploy.port and deploy.host follow the release plan.",
  ], [OWNER, "agent:claude-opus-5-5"]);
  const agents = await record("DECIDED-MIN-2", ["Agents asked for unit sooner."], ["agent:claude-opus-5-5"]);
  const libraryId = (await materializeWorkspace(library)).metadata.workspaceId;
  return { device, project, library, libraryId, agents: `${agents}#D1`, owner: (number) => `${owner}#D${String(number)}` };
}

const stateOf = (library) => materializeWorkspace(library);

// The events a write appended after `before` (a state read beforehand).
async function appendedSince(library, before) {
  return (await stateOf(library)).events.slice(before.events.length).map((event) => event.payload);
}

function authorizedBy(payload, fx, decidedIn, surface = "cli") {
  assert.deepEqual([payload.decidedIn, payload.decidedInLibraryId, payload.surface], [decidedIn, fx.libraryId, surface], `${payload.operation} records its authorization`);
}

async function assertInvalid(fx, args, decidedIn, target, reason) {
  const before = await stateOf(fx.library);
  const error = await asModel(() => refusal(args));
  assert.deepEqual([error.reasonCode, { ...error.details }], ["MODEL_WRITE_AUTHORIZATION_INVALID", { decidedIn, target, reason }], `${args[0]} ${target} citing ${decidedIn}`);
  assert.equal((await stateOf(fx.library)).version, before.version, `${args[0]}: a refused write appends nothing`);
}

test("526 GWT1 to GWT3 (SUB-453): gates-config-set and gates-config-remove write for a qualifying decision, refuse an unqualifying one, and refuse a model citing none", async (context) => {
  const fx = await scratch(context);
  const set = (name, ...more) => ["gates-config-set", "--workspace", fx.library, "--at", at(), "--name", name, "--command", JSON.stringify(["node", "--version"]), ...more];
  const remove = (name, ...more) => ["gates-config-remove", "--workspace", fx.library, "--at", at(), "--name", name, ...more];

  // GWT1: no --decided-in and no EINZBERN_SURFACE: still refused, the remedy naming the way out.
  const before = await stateOf(fx.library);
  const refused = await asModel(() => refusal(set("unit")));
  assert.deepEqual([refused.reasonCode, { ...refused.details }], ["MODEL_WRITE_REFUSED", { gate: "unit", remedy: MODEL_WRITE_DECISION_REMEDY }]);
  assert.equal(MODEL_WRITE_DECISION_REMEDY, "change it in Atelier, or cite the Owner's decision with --decided-in minutes:<id>#D<n>");
  // GWT3: a decision that does not name the gate, was decided by an agent alone, does not exist or is not a decision number.
  await assertInvalid(fx, set("unit", "--decided-in", fx.owner(2)), fx.owner(2), "unit", "target-not-named");
  await assertInvalid(fx, set("unit", "--decided-in", fx.agents), fx.agents, "unit", "not-owner-decided");
  await assertInvalid(fx, set("unit", "--decided-in", fx.owner(9)), fx.owner(9), "unit", "not-found");
  await assertInvalid(fx, set("unit", "--decided-in", "DECIDED-MIN-1#D1"), "DECIDED-MIN-1#D1", "unit", "malformed");
  assert.equal((await stateOf(fx.library)).version, before.version, "no refused write appended an event");

  // Through the shipped entry the refusal reaches stderr and exits 1.
  const shipped = spawnSync(process.execPath, [ENTRY, ...set("unit", "--decided-in", fx.owner(2))], { encoding: "utf8", env: { ...process.env, EINZBERN_SURFACE: "", EINZBERN_HOME: fx.device } });
  assert.deepEqual([shipped.status, shipped.stdout, JSON.parse(shipped.stderr.trim().split("\n").at(-1)).reasonCode], [1, "", "MODEL_WRITE_AUTHORIZATION_INVALID"]);

  // GWT2: a qualifying decision lets the model's run write; the event records it with surface cli.
  const written = await stateOf(fx.library);
  assert.equal((await asModel(() => cli(set("unit", "--decided-in", fx.owner(1))))).gate.name, "unit");
  const [setEvent] = await appendedSince(fx.library, written);
  assert.deepEqual([setEvent.operation, setEvent.record.collection, setEvent.record.key], ["config.record.set", "gate", "unit"]);
  authorizedBy(setEvent, fx, fx.owner(1));

  // A run for Atelier records surface atelier and no decision.
  const atelierBefore = await stateOf(fx.library);
  await asAtelier(() => cli(set("lint")));
  const [atelierEvent] = await appendedSince(fx.library, atelierBefore);
  assert.deepEqual([atelierEvent.record.key, atelierEvent.surface, Object.hasOwn(atelierEvent, "decidedIn")], ["lint", "atelier", false]);

  // gates-config-remove: refused for a decision that does not name the gate, written for one that does.
  await assertInvalid(fx, remove("lint", "--decided-in", fx.owner(3)), fx.owner(3), "lint", "target-not-named");
  const removeBefore = await stateOf(fx.library);
  assert.equal((await asModel(() => cli(remove("lint", "--decided-in", fx.owner(1))))).removed, "lint");
  const [removeEvent] = await appendedSince(fx.library, removeBefore);
  assert.deepEqual([removeEvent.operation, removeEvent.record.key], ["config.record.removed", "lint"]);
  authorizedBy(removeEvent, fx, fx.owner(1));
  assert.deepEqual((await stateOf(fx.library)).configRecords.filter((record) => record.collection === "gate").map((record) => record.key), ["unit"]);
});

test("526 (SUB-453): rule-enable and rule-disable write for a decision naming the rule, on every event they append, and refuse one that does not", async (context) => {
  const fx = await scratch(context);
  const agents = join(fx.project, "AGENTS.md");
  const enable = (...more) => ["rule-enable", "--project", fx.project, "--id", "batch", "--at", at(), ...more];
  const disable = (...more) => ["rule-disable", "--project", fx.project, "--id", "batch", "--at", at(), ...more];
  const text = await readFile(agents, "utf8");
  await assertInvalid(fx, enable("--decided-in", fx.owner(1)), fx.owner(1), "batch", "target-not-named");
  assert.equal(await readFile(agents, "utf8"), text, "a refused enable leaves AGENTS.md as it was");
  assert.equal((await asModel(() => refusal(enable()))).details.remedy, MODEL_WRITE_DECISION_REMEDY);

  const enableBefore = await stateOf(fx.library);
  const enabled = await asModel(() => cli(enable("--decided-in", fx.owner(2))));
  assert.deepEqual([enabled.reasonCode, enabled.rule.state], ["RULE_ENABLED", "enabled"]);
  const enableEvents = await appendedSince(fx.library, enableBefore);
  assert.ok(enableEvents.length >= 1);
  for (const payload of enableEvents) authorizedBy(payload, fx, fx.owner(2));

  await assertInvalid(fx, disable("--decided-in", fx.agents), fx.agents, "batch", "not-owner-decided");
  const disableBefore = await stateOf(fx.library);
  const disabled = await asModel(() => cli(disable("--decided-in", fx.owner(2))));
  assert.deepEqual([disabled.reasonCode, disabled.rule.state], ["RULE_DISABLED", "disabled"]);
  const disableEvents = await appendedSince(fx.library, disableBefore);
  assert.ok(disableEvents.length >= 1);
  for (const payload of disableEvents) authorizedBy(payload, fx, fx.owner(2));
});

test("526 (SUB-453): settings-set and settings-remove write for models.escalation.* and refuse models.tiers; a run for Atelier citing a decision records both", async (context) => {
  const fx = await scratch(context);
  const set = (key, value, ...more) => ["settings-set", "--workspace", fx.library, "--at", at(), "--key", key, "--value", value, ...more];
  const remove = (key, ...more) => ["settings-remove", "--workspace", fx.library, "--at", at(), "--key", key, ...more];
  assert.equal((await asModel(() => refusal(set("models.escalation.ceiling", "flagship")))).details.remedy, MODEL_WRITE_DECISION_REMEDY);
  await assertInvalid(fx, set("models.tiers", "[]", "--decided-in", fx.owner(3)), fx.owner(3), "models.tiers", "target-not-named");

  const setBefore = await stateOf(fx.library);
  assert.equal((await asModel(() => cli(set("models.escalation.ceiling", "flagship", "--decided-in", fx.owner(3))))).reasonCode, "SETTINGS_WRITE_COMMITTED");
  const [setEvent] = await appendedSince(fx.library, setBefore);
  assert.deepEqual([setEvent.operation, setEvent.record.key], ["settings.updated", "models.escalation.ceiling"]);
  authorizedBy(setEvent, fx, fx.owner(3));

  // Atelier citing a decision: checked the same way, recorded with surface atelier.
  const atelierBefore = await stateOf(fx.library);
  await asAtelier(() => cli(set("models.escalation.threshold", "2", "--decided-in", fx.owner(3))));
  const [atelierEvent] = await appendedSince(fx.library, atelierBefore);
  authorizedBy(atelierEvent, fx, fx.owner(3), "atelier");

  await assertInvalid(fx, remove("models.escalation.threshold", "--decided-in", fx.owner(1)), fx.owner(1), "models.escalation.threshold", "target-not-named");
  const removeBefore = await stateOf(fx.library);
  assert.equal((await asModel(() => cli(remove("models.escalation.threshold", "--decided-in", fx.owner(3))))).reasonCode, "SETTINGS_WRITE_COMMITTED");
  const [removeEvent] = await appendedSince(fx.library, removeBefore);
  assert.deepEqual([removeEvent.operation, removeEvent.record.key], ["settings.removed", "models.escalation.threshold"]);
  authorizedBy(removeEvent, fx, fx.owner(3));
});

test("526 (SUB-453): variable-set and variable-remove write for a decision naming the variable and refuse one that does not", async (context) => {
  const fx = await scratch(context);
  const set = (name, ...more) => ["variable-set", "--workspace", fx.library, "--at", at(), "--name", name, "--type", "number", "--value", "8443", ...more];
  const remove = (name, ...more) => ["variable-remove", "--workspace", fx.library, "--at", at(), "--name", name, ...more];
  const variableEvent = (payloads) => payloads.find((payload) => payload.record?.collection === "variable");
  assert.equal((await asModel(() => refusal(set("deploy.port")))).details.remedy, MODEL_WRITE_DECISION_REMEDY);
  await assertInvalid(fx, set("deploy.portal", "--decided-in", fx.owner(4)), fx.owner(4), "deploy.portal", "target-not-named");

  const setBefore = await stateOf(fx.library);
  assert.equal((await asModel(() => cli(set("deploy.port", "--decided-in", fx.owner(4))))).reasonCode, "VARIABLE_WRITE_COMMITTED");
  const setEvent = variableEvent(await appendedSince(fx.library, setBefore));
  assert.deepEqual([setEvent.operation, setEvent.record.key], ["config.record.set", "deploy.port"]);
  authorizedBy(setEvent, fx, fx.owner(4));

  await assertInvalid(fx, remove("deploy.port", "--decided-in", fx.agents), fx.agents, "deploy.port", "not-owner-decided");
  const removeBefore = await stateOf(fx.library);
  assert.equal((await asModel(() => cli(remove("deploy.port", "--decided-in", fx.owner(4))))).reasonCode, "VARIABLE_WRITE_COMMITTED");
  const removeEvent = variableEvent(await appendedSince(fx.library, removeBefore));
  assert.deepEqual([removeEvent.operation, removeEvent.record.key], ["config.record.removed", "deploy.port"]);
  authorizedBy(removeEvent, fx, fx.owner(4));
});

test("526 (SUB-453): the barrier answers a permit, names --decided-in only for the writes that take it, and leaves the other refusals as they were", async (context) => {
  const decidedIn = "minutes:abc123#D1";
  assert.equal(assertModelWriteAllowed({ key: "fixture.writable" }, true, {}, { decidedIn: undefined }), undefined, "a modelWritable write citing nothing records nothing");
  assert.deepEqual(assertModelWriteAllowed({ gate: "unit" }, false, {}, { decidedIn }), { surface: "cli", decidedIn, target: "unit" });
  assert.deepEqual(assertModelWriteAllowed({ key: "fixture.writable" }, true, {}, { decidedIn }), { surface: "cli", decidedIn, target: "fixture.writable" }, "a cited decision is checked whatever the key");
  assert.deepEqual(assertModelWriteAllowed({ rule: "batch" }, false, { EINZBERN_SURFACE: ATELIER_SURFACE }, { decidedIn }), { surface: "atelier", decidedIn, target: "batch" });
  assert.throws(() => assertModelWriteAllowed({ name: "deploy.host" }, false, {}, { decidedIn: undefined }),
    (error) => error.reasonCode === "MODEL_WRITE_REFUSED" && error.details.remedy === MODEL_WRITE_DECISION_REMEDY);
  assert.throws(() => assertModelWriteAllowed({ key: "chain.identity" }, false, {}),
    (error) => error.reasonCode === "MODEL_WRITE_REFUSED" && error.details.remedy === MODEL_WRITE_REMEDY, "a write that takes no decision keeps its remedy");
  assert.throws(() => assertModelWriteAllowed({ gate: "unit" }, false, {}, { decidedIn: "unit" }),
    (error) => error.reasonCode === "MODEL_WRITE_AUTHORIZATION_INVALID" && error.details.reason === "malformed");

  // project-bindings-set takes no decision: refused with its old remedy, and --decided-in is not its flag.
  const fx = await scratch(context);
  const projectId = (await cli(["project-list", "--workspace", fx.library])).records[0].id;
  const bindings = (...more) => ["project-bindings-set", "--workspace", fx.library, "--at", at(), "--project-id", projectId, "--key", "common-default", "--value", "{}", ...more];
  const refused = await asModel(() => refusal(bindings()));
  assert.deepEqual([refused.reasonCode, refused.details.remedy], ["MODEL_WRITE_REFUSED", MODEL_WRITE_REMEDY]);
  assert.equal((await asModel(() => refusal(bindings("--decided-in", fx.owner(1))))).reasonCode, "CLI_ARGUMENT_UNKNOWN");
});
