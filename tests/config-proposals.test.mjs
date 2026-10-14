// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-527 GWT2, GWT3, GWT4, the engine's part (MIN-257 D6, Q5, Q24; TCRN-CROSS-SUB-477).
// A gate or rule change a model proposes is a record of the proposal collection, not a declaration:
// listGates and listRules do not show it. Atelier's approval appends the change the proposal names,
// the same config.record event a direct write appends, recorded with surface atelier and decidedIn
// proposal:<key>@<proposedAt> in this library, and removes the proposal in the same append. A
// rejection keeps the proposal, rejected; a rejected proposal is not approved until it is proposed
// again, and an approval that read an older proposal is stale. Every library, project and device
// directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProject,
  initializeLibrary,
  listGates,
  listRules,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  scopedWorkspaceState,
  setGate,
} from "../dist/build/packages/core/src/index.js";
import { buildEventPayload, parseProposalDecision, proposalDecision } from "../dist/build/packages/core/src/actor-attestation.js";
import { CONFIG_RECORD_COLLECTIONS, setConfigRecord } from "../dist/build/packages/core/src/config-records.js";
import {
  PROPOSAL_COLLECTION,
  approveDeltas,
  approveProposal,
  listProposals,
  proposeChange,
  rejectProposal,
} from "../dist/build/packages/core/src/config-proposals.js";
import { BUILT_IN_RULES } from "../dist/build/packages/core/src/rules-catalog.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

const MODEL = "agent:proposals-model";
const OWNER = "owner:governance";
const USER_TEXT = "# Proposals fixture\n\nThe user's own notes.\n";
const gate = (covers = ["src/**"]) => ({ command: ["node", "--version"], root: ".", covers, required: true, enabled: true, releaseOnly: false });

/** A library with one project, the project's directory with an AGENTS.md, and a backup directory. */
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-proposals-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  const agents = join(project, "AGENTS.md");
  await writeFile(agents, USER_TEXT);
  const library = join(base, ".ether");
  await initializeLibrary({ root: library, createdAt: at() });
  const created = await createProject(library, { externalKey: "PROPOSALS-PROJECT", name: "Proposals fixture", occurredAt: at() });
  const projectId = created.projects.find((entry) => entry.externalKey === "PROPOSALS-PROJECT").id;
  return { base, project, agents, library, projectId, backups: join(base, "device", "backups") };
}

async function refusal(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("the operation was expected to refuse");
}

const propose = (paths, input) => proposeChange(paths.library, { proposedBy: MODEL, actorId: MODEL, occurredAt: at(), configurationProjectId: paths.projectId, ...input });
const approve = (paths, key, proposedAt, extra = {}) => approveProposal({ libraryRoot: paths.library, key, proposedAt, occurredAt: at(), actorId: OWNER, configurationProjectId: paths.projectId, ...extra });
const reject = (paths, key, proposedAt) => rejectProposal(paths.library, { key, proposedAt, rejectedBy: OWNER, actorId: OWNER, occurredAt: at(), configurationProjectId: paths.projectId, authorization: { surface: "atelier" } });
const gatesOf = (state, paths) => listGates(scopedWorkspaceState(state, paths.projectId)).map((entry) => entry.name);

test("527 GWT2: a proposed gate is not declared; its approval appends the event a direct set appends, cites the proposal, and removes it", async (context) => {
  const paths = await scratch(context);
  const proposed = await propose(paths, { kind: "gate", target: "unit", action: "set", payload: gate() });
  assert.equal(proposed.proposal.key, "gate:unit");
  assert.equal(proposed.proposal.status, "pending");
  assert.equal(proposed.proposal.proposedBy, MODEL);
  assert.deepEqual(gatesOf(proposed.state, paths), [], "a pending proposal is not a declaration");
  assert.deepEqual(listProposals(proposed.state, { projectId: paths.projectId, status: "pending" }).map((entry) => [entry.key, entry.target, entry.action]), [["gate:unit", "unit", "set"]]);
  assert.deepEqual(listProposals(proposed.state), [], "a proposal belongs to its own scope");

  const before = proposed.state.version;
  const approval = await approve(paths, "gate:unit", proposed.proposal.proposedAt);
  assert.equal(approval.state.version, before + 2, "the declaration and the settlement are one append of two events");
  assert.deepEqual(gatesOf(approval.state, paths), ["unit"]);
  assert.deepEqual(listProposals(approval.state, { projectId: paths.projectId }), [], "the approved proposal is no longer recorded");
  const authorization = { surface: "atelier", decidedIn: `proposal:gate:unit@${proposed.proposal.proposedAt}`, decidedInLibraryId: approval.state.metadata.workspaceId };
  const [declared, settled] = approval.state.events.slice(-2).map((event) => event.payload);
  assert.deepEqual(declared, { operation: "config.record.set", record: { collection: "gate", key: "unit", value: gate(), projectId: paths.projectId }, ...authorization });
  assert.deepEqual(settled, { operation: "config.record.removed", record: { collection: PROPOSAL_COLLECTION, key: "gate:unit", projectId: paths.projectId }, ...authorization });

  // The same declaration written directly appends the same record.
  const direct = await setGate(paths.library, { name: "unit", gate: gate(), configurationProjectId: paths.projectId, occurredAt: at() });
  assert.deepEqual(direct.events.at(-1).payload.record, declared.record);

  // Replay keeps the approval: the new decidedIn is accepted, nothing is rejected.
  const replayed = await materializeWorkspaceFromGenesis(paths.library);
  assert.deepEqual(replayed.library.rejectedEvents, []);
  assert.deepEqual(gatesOf(replayed, paths), ["unit"]);
});

test("527 GWT2: a proposed removal removes the gate on approval; a removal of an undeclared gate is refused when it is proposed", async (context) => {
  const paths = await scratch(context);
  const missing = await refusal(() => propose(paths, { kind: "gate", target: "unit", action: "remove" }));
  assert.equal(missing.reasonCode, "CONFIG_RECORD_NOT_FOUND");
  await setGate(paths.library, { name: "unit", gate: gate(), configurationProjectId: paths.projectId, occurredAt: at() });
  const proposed = await propose(paths, { kind: "gate", target: "unit", action: "remove" });
  assert.deepEqual(gatesOf(proposed.state, paths), ["unit"], "the gate stays declared while its removal waits");
  const approval = await approve(paths, "gate:unit", proposed.proposal.proposedAt);
  assert.deepEqual(gatesOf(approval.state, paths), []);
  assert.equal(approval.state.events.at(-2).payload.operation, "config.record.removed");
  assert.equal(approval.state.events.at(-2).payload.decidedIn, proposalDecision("gate:unit", proposed.proposal.proposedAt));
});

test("527 GWT4: a rejected proposal stays, rejected; it is not approved until it is proposed again, and an approval of an older proposal is stale", async (context) => {
  const paths = await scratch(context);
  const first = await propose(paths, { kind: "gate", target: "unit", action: "set", payload: gate() });
  const rejected = await reject(paths, "gate:unit", first.proposal.proposedAt);
  assert.equal(rejected.proposal.status, "rejected");
  assert.equal(rejected.proposal.rejectedBy, OWNER);
  assert.equal(rejected.proposal.proposedAt, first.proposal.proposedAt);
  assert.equal(typeof rejected.proposal.rejectedAt, "string");
  const event = rejected.state.events.at(-1).payload;
  assert.equal(event.operation, "config.record.set");
  assert.equal(event.surface, "atelier");
  assert.deepEqual(listProposals(rejected.state, { projectId: paths.projectId, status: "rejected" }).map((entry) => entry.key), ["gate:unit"]);
  assert.deepEqual(listProposals(rejected.state, { projectId: paths.projectId, status: "pending" }), []);
  assert.deepEqual(gatesOf(rejected.state, paths), []);

  const head = rejected.state.version;
  assert.equal((await refusal(() => approve(paths, "gate:unit", first.proposal.proposedAt))).reasonCode, "PROPOSAL_NOT_PENDING");
  assert.equal((await refusal(() => reject(paths, "gate:unit", first.proposal.proposedAt))).reasonCode, "PROPOSAL_NOT_PENDING");
  assert.equal((await materializeWorkspace(paths.library)).version, head, "a refused approval or rejection appends nothing");

  const again = await propose(paths, { kind: "gate", target: "unit", action: "set", payload: gate(["docs/**"]) });
  assert.equal(again.proposal.status, "pending");
  assert.equal(again.proposal.rejectedBy, undefined);
  const stale = await refusal(() => approve(paths, "gate:unit", first.proposal.proposedAt));
  assert.equal(stale.reasonCode, "PROPOSAL_STALE");
  assert.deepEqual([stale.details.required, stale.details.actual], [again.proposal.proposedAt, first.proposal.proposedAt]);
  const approval = await approve(paths, "gate:unit", again.proposal.proposedAt);
  assert.deepEqual(listGates(scopedWorkspaceState(approval.state, paths.projectId)).map((entry) => entry.covers), [["docs/**"]], "the approval writes what the proposal says now");
  assert.equal((await refusal(() => approve(paths, "gate:unit", again.proposal.proposedAt))).reasonCode, "PROPOSAL_NOT_FOUND");
});

test("527 GWT3: a rule proposal does not enable the rule; its approval enables it, writes its section and settles the proposal in one append", async (context) => {
  const paths = await scratch(context);
  const [rule, other] = BUILT_IN_RULES;
  const listed = async () => listRules({ libraryRoot: paths.library, projectRoot: paths.project, configurationProjectId: paths.projectId });
  const proposed = await propose(paths, { kind: "rule", target: rule.id, action: "enable", payload: { order: 2 } });
  assert.equal((await listed()).find((entry) => entry.id === rule.id).state, "disabled", "a proposed rule is not enabled");
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "a proposal writes no file");

  // An approval that read another proposal writes neither the file nor the library.
  const second_ = await propose(paths, { kind: "rule", target: other.id, action: "enable" });
  const head = second_.state.version;
  assert.equal((await refusal(() => approve(paths, `rule:${other.id}`, proposed.proposal.proposedAt, { projectRoot: paths.project, backupRoot: paths.backups }))).reasonCode, "PROPOSAL_STALE");
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT);
  assert.equal((await materializeWorkspace(paths.library)).version, head);
  // An append that fails after the section was written puts AGENTS.md back and records nothing (Q24).
  const overBudget = await refusal(() => approve(paths, `rule:${rule.id}`, proposed.proposal.proposedAt, { projectRoot: paths.project, backupRoot: paths.backups, viewBudgetBytes: 1 }));
  assert.notEqual(overBudget.reasonCode, undefined);
  assert.equal(await readFile(paths.agents, "utf8"), USER_TEXT, "the file is put back");
  assert.equal((await materializeWorkspace(paths.library)).version, head);
  assert.equal(listProposals(await materializeWorkspace(paths.library), { projectId: paths.projectId, status: "pending" }).length, 2, "both proposals still wait");
  // A rule's approval names the project whose AGENTS.md it writes.
  assert.equal((await refusal(() => approve(paths, `rule:${rule.id}`, proposed.proposal.proposedAt))).reasonCode, "PROPOSAL_INVALID");

  const approval = await approve(paths, `rule:${rule.id}`, proposed.proposal.proposedAt, { projectRoot: paths.project, backupRoot: paths.backups });
  assert.equal(approval.ruleChange.status.state, "enabled");
  assert.equal(approval.ruleChange.status.order, 2, "the order the proposal carries");
  assert.match(await readFile(paths.agents, "utf8"), new RegExp(`rule:${rule.id}`, "u"));
  const appended = approval.state.events.slice(head - approval.state.version).map((event) => event.payload);
  assert.deepEqual(appended.map((payload) => [payload.operation, payload.record.collection]), [
    ["config.record.set", "rule"], ["config.record.set", "managed-section"], ["config.record.removed", PROPOSAL_COLLECTION],
  ]);
  for (const payload of appended) {
    assert.deepEqual([payload.surface, payload.decidedIn, payload.decidedInLibraryId], ["atelier", `proposal:rule:${rule.id}@${proposed.proposal.proposedAt}`, approval.state.metadata.workspaceId]);
  }
  assert.deepEqual(listProposals(approval.state, { projectId: paths.projectId }).map((entry) => entry.key), [`rule:${other.id}`]);
  assert.equal((await refusal(() => approveDeltas({ key: `rule:${other.id}`, proposedAt: second_.proposal.proposedAt }))).reasonCode, "PROPOSAL_INVALID", "a rule is approved with its file");
});

test("527: proposal is a closed collection whose records are checked, and a proposal is refused for what it would write", async (context) => {
  const paths = await scratch(context);
  assert.ok(CONFIG_RECORD_COLLECTIONS.includes(PROPOSAL_COLLECTION));
  const malformed = await refusal(() => setConfigRecord(paths.library, { collection: PROPOSAL_COLLECTION, key: "gate:unit", value: { kind: "gate", action: "set" }, occurredAt: at() }));
  assert.deepEqual([malformed.reasonCode, malformed.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "PROPOSAL_INVALID"]);
  const wrongKey = await refusal(() => setConfigRecord(paths.library, { collection: PROPOSAL_COLLECTION, key: "variable:x", value: {}, occurredAt: at() }));
  assert.deepEqual([wrongKey.reasonCode, wrongKey.details.refusedBy], ["CONFIG_RECORD_VALUE_INVALID", "PROPOSAL_INVALID"]);
  assert.equal((await refusal(() => propose(paths, { kind: "gate", target: "unit", action: "set", payload: { command: [] } }))).reasonCode, "GATES_CONFIG_INVALID");
  assert.equal((await refusal(() => propose(paths, { kind: "gate", target: "unit", action: "enable", payload: gate() }))).reasonCode, "PROPOSAL_INVALID");
  assert.equal((await refusal(() => propose(paths, { kind: "rule", target: "no-such-rule", action: "enable" }))).reasonCode, "RULE_UNKNOWN");
  assert.equal((await refusal(() => propose(paths, { kind: "rule", target: BUILT_IN_RULES[0].id, action: "enable", payload: { order: 0 } }))).reasonCode, "PROPOSAL_INVALID");
  assert.equal((await refusal(() => propose(paths, { kind: "rule", target: BUILT_IN_RULES[0].id, action: "enable", proposedBy: "someone" }))).reasonCode, "PROPOSAL_INVALID");
  assert.equal((await refusal(() => propose(paths, { kind: "variable", target: "x", action: "set" }))).reasonCode, "PROPOSAL_INVALID");

  // A proposal is not configuration in force: a projection written while one waits does not show it.
  await propose(paths, { kind: "gate", target: "unit", action: "set", payload: gate() });
  await setGate(paths.library, { name: "other", gate: gate(), configurationProjectId: paths.projectId, occurredAt: at() });
  const projection = await readFile(join(paths.library, "config", "project.json"), "utf8");
  assert.match(projection, /"other"/u);
  assert.equal(projection.includes(PROPOSAL_COLLECTION), false, "config/project.json does not show proposals");
});

test("527 Q5: decidedIn may cite an approved proposal, proposal:<key>@<proposedAt>, recorded with surface atelier only", () => {
  const record = { collection: "gate", key: "unit" };
  const decided = { decidedIn: proposalDecision("gate:unit", "2026-10-14T09:00:01Z"), decidedInLibraryId: `library:${"a".repeat(24)}` };
  assert.deepEqual(parseProposalDecision(decided.decidedIn), { key: "gate:unit", proposedAt: "2026-10-14T09:00:01Z" });
  assert.deepEqual(buildEventPayload("config.record.set", record, undefined, { surface: "atelier", ...decided }), { operation: "config.record.set", record, surface: "atelier", ...decided });
  for (const extras of [
    { surface: "cli", ...decided },
    { ...decided },
    { surface: "atelier", decidedIn: "proposal:gate:unit@yesterday", decidedInLibraryId: decided.decidedInLibraryId },
    { surface: "atelier", decidedIn: "proposal:variable:x@2026-10-14T09:00:01Z", decidedInLibraryId: decided.decidedInLibraryId },
  ]) {
    assert.throws(() => buildEventPayload("config.record.set", record, undefined, extras), (error) => error.reasonCode === "EVENT_PAYLOAD_EXTRA_INVALID", JSON.stringify(extras));
  }
});
