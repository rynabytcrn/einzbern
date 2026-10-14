// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-527 (MIN-257 D6, Q5, Q24; TCRN-CROSS-SUB-477): changes to a gate declaration or to a
// Command Spell rule that a model proposes and Atelier approves. A model may not write a gate or a
// rule itself (the CLI refuses it, TCRN-CROSS-STORY-513 R1); it records a proposal instead, and the
// proposal waits, outside the declarations, until Atelier approves or rejects it.
//
// A proposal is a record of the closed proposal collection (config-records.ts), keyed by what it would
// change: gate:<gate name> or rule:<rule id>, in the scope (--project-id) of that gate or rule. Its value
// says what to do and who asked:
//
//   {kind, action, payload, status, proposedBy, proposedAt, rejectedBy?, rejectedAt?}
//
//   kind        gate or rule, the prefix of the key;
//   action      set or remove for a gate, enable or disable for a rule;
//   payload     for set, the whole gate declaration (gates-config.ts); for enable, {} or {order};
//               for remove and disable, {};
//   status      pending until it is rejected; an approved proposal is no longer recorded;
//   proposedBy  the actor that proposed it, proposedAt the instant it did (the write's --at);
//   rejectedBy, rejectedAt  present exactly when the status is rejected.
//
// Proposing the same target again replaces the record, pending again with the new instant, whatever
// state the last proposal was in. Approving writes the change the proposal names, with the
// authorization Q5 settles (surface atelier, decidedIn proposal:<key>@<proposedAt>, decidedInLibraryId
// this library), and removes the proposal in the same append: a gate through approveDeltas, a rule
// through enableRule or disableRule, which write AGENTS.md before they append and put it back when the
// append fails (rules.ts). Rejecting rewrites the record as rejected, so it stays readable, and a
// rejected proposal is approved only once it is proposed again. An approval or a rejection names the
// proposedAt it read; a proposal recorded since at another instant is PROPOSAL_STALE, so the change
// Atelier showed is the one it approves.
//
// A pending proposal is not a declaration: listGates, listRules, gates-plan, gates-run and the managed
// sections read the gate and rule collections only, and config/project.json does not show proposals.
//
// TCRN-CROSS-STORY-538 (MIN-256 D6 C2, C3; TCRN-CROSS-SUB-497): proposing, rejecting and approving
// hold the library write lock for their append alone (appendEvents). What they read and check -- the
// key, the instants, the target the proposal names, the proposal an approval or a rejection settles
// -- is read and checked outside the lock, so a refusal waits for no other writer, and checked again
// by the deltas against the state the append is built on, so a proposal another writer settled or
// proposed again in between is refused with the same reason codes and nothing is appended.

import type { JsonValue } from "../../protocol/src/index.js";
import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import { assertActorId, proposalDecision } from "./actor-attestation.js";
import type { WriteAuthorization } from "./actor-attestation.js";
import { chainIdentity } from "./chain-identity.js";
import { ConfigRecordError, removeConfigRecordDelta, setConfigRecordDelta } from "./config-records.js";
import type { ConfigRecord } from "./config-records.js";
import { checkGateDeclaration, isGateName, removeGateDelta, setGateDelta } from "./gates-config.js";
import { RuleError, disableRule, enableRule, isRuleId } from "./rules.js";
import type { RuleChange } from "./rules.js";
import { BUILT_IN_RULES } from "./rules-catalog.js";
import type { BuiltInRule } from "./rules-catalog.js";
import { appendEvents, assertLibraryWritable, materializeWorkspace, projectConfiguration } from "./workspace.js";
import type { MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const PROPOSAL_COLLECTION = "proposal" as const;

export const PROPOSAL_REASON_CODES = Object.freeze([
  "PROPOSAL_INVALID",
  "PROPOSAL_NOT_FOUND",
  "PROPOSAL_NOT_PENDING",
  "PROPOSAL_STALE",
] as const);

export type ProposalReasonCode = typeof PROPOSAL_REASON_CODES[number];

export class ProposalError extends Error {
  readonly reasonCode: ProposalReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: ProposalReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ProposalError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: ProposalReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new ProposalError(reasonCode, message, details);
}

export const PROPOSAL_KINDS = Object.freeze(["gate", "rule"] as const);
export type ProposalKind = typeof PROPOSAL_KINDS[number];
export const PROPOSAL_ACTIONS: Readonly<Record<ProposalKind, readonly string[]>> = Object.freeze({
  gate: Object.freeze(["remove", "set"]),
  rule: Object.freeze(["disable", "enable"]),
});
export type ProposalAction = "set" | "remove" | "enable" | "disable";
export const PROPOSAL_STATUSES = Object.freeze(["pending", "rejected"] as const);
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

/** A proposal as its record holds it. */
export interface ProposalValue {
  readonly kind: ProposalKind;
  readonly action: ProposalAction;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly status: ProposalStatus;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly rejectedBy?: string;
  readonly rejectedAt?: string;
}

/** A proposal with its key, the gate or rule it would change, and its scope. */
export interface Proposal extends ProposalValue {
  readonly key: string;
  readonly target: string;
  readonly projectId?: string;
}

const PENDING_FIELDS = "action,kind,payload,proposedAt,proposedBy,status";
const REJECTED_FIELDS = "action,kind,payload,proposedAt,proposedBy,rejectedAt,rejectedBy,status";

function isProposalKind(value: unknown): value is ProposalKind {
  return value === "gate" || value === "rule";
}

/** The key of the proposal that would change `target`: gate:<gate name> or rule:<rule id>. */
export function proposalKey(kind: string, target: string): string {
  if (!isProposalKind(kind)) fail("PROPOSAL_INVALID", `a proposal changes a gate or a rule, not a ${kind}`, { target: `${kind}:${target}` });
  if (kind === "gate" ? !isGateName(target) : !isRuleId(target)) {
    fail("PROPOSAL_INVALID", `${target} is not a ${kind === "gate" ? "gate name" : "rule id"}`, { target: `${kind}:${target}` });
  }
  return `${kind}:${target}`;
}

/** What the key of a proposal names: its kind and the gate's name or rule's id; null for another key. */
export function proposalTargetOf(key: string): { readonly kind: ProposalKind; readonly target: string } | null {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const target = key.slice(colon + 1);
  if (colon < 1 || !isProposalKind(kind) || (kind === "gate" ? !isGateName(target) : !isRuleId(target))) return null;
  return { kind, target };
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

// What a proposal carries for its kind and action. A gate declaration is checked as gates-config-set
// checks it, so a proposal Atelier approves never fails for its shape.
function checkProposalPayload(kind: ProposalKind, action: string, payload: unknown, key: string, target: string): void {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail("PROPOSAL_INVALID", `the payload of ${key} is a JSON object`, { target: key });
  const fields = Object.keys(payload).sort().join(",");
  if (kind === "gate" && action === "set") {
    checkGateDeclaration(payload, target);
    return;
  }
  if (kind === "rule" && action === "enable") {
    if (fields === "" || (fields === "order" && isPositiveInteger((payload as Readonly<Record<string, unknown>>).order))) return;
    fail("PROPOSAL_INVALID", `the payload of ${key} is {} or {order}, a positive integer`, { target: key });
  }
  if (fields !== "") fail("PROPOSAL_INVALID", `the payload of ${key} is {} for ${action}`, { target: key });
}

function checkInstant(value: unknown, field: string, key: string): void {
  try {
    assertStrictInstant(value);
  } catch {
    fail("PROPOSAL_INVALID", `${field} of ${key} is an instant`, { target: key, field });
  }
}

function checkActor(value: unknown, field: string, key: string): void {
  try {
    assertActorId(value);
  } catch {
    fail("PROPOSAL_INVALID", `${field} of ${key} is an actor id`, { target: key, field });
  }
}

/**
 * The check the proposal collection of config-records.ts applies to a record: keyed gate:<gate name> or
 * rule:<rule id>, and holding exactly the fields the header of this module lists for its status.
 */
export function checkProposalRecordValue(value: Readonly<Record<string, unknown>>, key: string): void {
  const named = proposalTargetOf(key);
  if (named === null) fail("PROPOSAL_INVALID", `${key} is not gate:<gate name> or rule:<rule id>`, { target: key });
  const fields = Object.keys(value).sort().join(",");
  if (!(value.status === "pending" && fields === PENDING_FIELDS) && !(value.status === "rejected" && fields === REJECTED_FIELDS)) {
    fail("PROPOSAL_INVALID", `a proposal holds exactly ${PENDING_FIELDS} with status pending, and rejectedAt and rejectedBy as well with status rejected`, { target: key });
  }
  if (value.kind !== named.kind) fail("PROPOSAL_INVALID", `the kind of ${key} is ${named.kind}`, { target: key, field: "kind" });
  const action = value.action;
  if (typeof action !== "string" || !PROPOSAL_ACTIONS[named.kind].includes(action)) {
    fail("PROPOSAL_INVALID", `the action of ${key} is ${PROPOSAL_ACTIONS[named.kind].join(" or ")}`, { target: key, field: "action" });
  }
  checkProposalPayload(named.kind, action, value.payload, key, named.target);
  checkActor(value.proposedBy, "proposedBy", key);
  checkInstant(value.proposedAt, "proposedAt", key);
  if (value.status === "rejected") {
    checkActor(value.rejectedBy, "rejectedBy", key);
    checkInstant(value.rejectedAt, "rejectedAt", key);
  }
}

function proposalOf(record: ConfigRecord): Proposal {
  const named = proposalTargetOf(record.key)!;
  return { key: record.key, target: named.target, ...(record.projectId === undefined ? {} : { projectId: record.projectId }), ...(record.value as unknown as ProposalValue) };
}

function recordedProposal(state: Pick<WorkspaceState, "configRecords">, key: string, projectId: string | undefined): Proposal | null {
  const record = state.configRecords.find((entry) => entry.collection === PROPOSAL_COLLECTION && entry.key === key && entry.projectId === projectId);
  return record === undefined ? null : proposalOf(record);
}

/** What the proposals of a list are narrowed to: the exact scope (the library when left out), a kind and a status. */
export interface ProposalFilter {
  readonly projectId?: string;
  readonly kind?: ProposalKind;
  readonly status?: ProposalStatus;
}

/**
 * The proposals a state records in one scope, sorted by key. A proposal belongs to the scope it names
 * and is not inherited, like the gate declaration it would change; pass the library's own state, not
 * a project's scoped view of it.
 */
export function listProposals(state: Pick<WorkspaceState, "configRecords">, filter: ProposalFilter = {}): readonly Proposal[] {
  return state.configRecords
    .filter((record) => record.collection === PROPOSAL_COLLECTION && record.projectId === filter.projectId)
    .map(proposalOf)
    .filter((proposal) => (filter.kind === undefined || proposal.kind === filter.kind) && (filter.status === undefined || proposal.status === filter.status));
}

/** The proposal recorded under `key` that an approval or a rejection reading it at `proposedAt` may settle. */
function pendingProposal(state: Pick<WorkspaceState, "configRecords">, key: string, projectId: string | undefined, proposedAt: string): Proposal {
  const proposal = recordedProposal(state, key, projectId) ?? fail("PROPOSAL_NOT_FOUND", `no proposal ${key} is recorded`, { target: key });
  if (proposal.status !== "pending") {
    fail("PROPOSAL_NOT_PENDING", `the proposal ${key} was rejected; it is approved only once it is proposed again`, { target: key, status: proposal.status });
  }
  if (proposal.proposedAt !== proposedAt) {
    fail("PROPOSAL_STALE", `the proposal ${key} was proposed again at ${proposal.proposedAt}; read it again before settling it`, { target: key, required: proposal.proposedAt, actual: proposedAt });
  }
  return proposal;
}

/** How an approval is recorded (Q5): from Atelier, citing the proposal in this library. */
function approvalAuthorization(state: Pick<WorkspaceState, "metadata">, key: string, proposedAt: string): WriteAuthorization {
  return { surface: "atelier", decidedIn: proposalDecision(key, proposedAt), decidedInLibraryId: state.metadata.workspaceId };
}

const scopeOf = (projectId: string | undefined): { readonly projectId?: string } => (projectId === undefined ? {} : { projectId });

export interface ProposeDeltaInput {
  readonly kind: string;
  readonly target: string;
  readonly action: string;
  readonly payload?: Readonly<Record<string, JsonValue>>;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly projectId?: string;
  // The rules this engine ships (BUILT_IN_RULES); a test hands in another catalog here.
  readonly catalog?: readonly BuiltInRule[];
}

/**
 * The delta that records a pending proposal, replacing whatever the target's last proposal was. The
 * proposal is checked before any lock is taken; against the merged state, a gate to remove has to be
 * declared in the scope, a rule to enable has to ship with this engine, and a rule to disable has to
 * ship or be recorded.
 */
export function proposeDelta(input: ProposeDeltaInput): (state: WorkspaceState) => MutationDelta {
  const key = proposalKey(input.kind, input.target);
  const kind = input.kind as ProposalKind;
  if (!PROPOSAL_ACTIONS[kind].includes(input.action)) {
    fail("PROPOSAL_INVALID", `the action of ${key} is ${PROPOSAL_ACTIONS[kind].join(" or ")}`, { target: key, field: "action" });
  }
  const value = { kind, action: input.action, payload: input.payload ?? {}, status: "pending", proposedBy: input.proposedBy, proposedAt: input.proposedAt };
  checkProposalRecordValue(value, key);
  const set = setConfigRecordDelta({ collection: PROPOSAL_COLLECTION, key, ...scopeOf(input.projectId), value });
  const catalog = input.catalog ?? BUILT_IN_RULES;
  return (state) => {
    const declared = (collection: string): boolean => state.configRecords.some((record) => record.collection === collection && record.key === input.target && record.projectId === input.projectId);
    if (kind === "gate" && input.action === "remove" && !declared("gate")) {
      throw new ConfigRecordError("CONFIG_RECORD_NOT_FOUND", `gate ${input.target} is not declared`, { collection: "gate", key: input.target });
    }
    const shipped = catalog.some((rule) => rule.id === input.target);
    if (kind === "rule" && !shipped && (input.action === "enable" || !state.configRecords.some((record) => record.collection === "rule" && record.key === input.target))) {
      throw new RuleError("RULE_UNKNOWN", `the engine ships no rule ${JSON.stringify(input.target)}`, { id: input.target, known: catalog.map((rule) => rule.id).join(",") });
    }
    return set(state);
  };
}

/** What settles one proposal: its key, the proposedAt the caller read, and its scope. */
export interface ProposalSettleInput {
  readonly key: string;
  readonly proposedAt: string;
  readonly projectId?: string;
}

/**
 * The delta that rejects one pending proposal: the record stays, rejected, with who rejected it and
 * when. A proposal that is not recorded, not pending or proposed again since is refused.
 */
export function rejectDelta(input: ProposalSettleInput & { readonly rejectedBy: string; readonly rejectedAt: string; readonly authorization?: WriteAuthorization }): (state: WorkspaceState) => MutationDelta {
  checkActor(input.rejectedBy, "rejectedBy", input.key);
  checkInstant(input.rejectedAt, "rejectedAt", input.key);
  return (state) => {
    const proposal = pendingProposal(state, input.key, input.projectId, input.proposedAt);
    const { kind, action, payload, proposedBy, proposedAt } = proposal;
    return setConfigRecordDelta({
      collection: PROPOSAL_COLLECTION, key: input.key, ...scopeOf(input.projectId),
      value: { kind, action, payload, status: "rejected", proposedBy, proposedAt, rejectedBy: input.rejectedBy, rejectedAt: input.rejectedAt },
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
    })(state);
  };
}

// The delta that removes an approved proposal, recorded with the approval's authorization.
function settleDelta(input: ProposalSettleInput): (state: WorkspaceState) => MutationDelta {
  return (state) => {
    pendingProposal(state, input.key, input.projectId, input.proposedAt);
    return removeConfigRecordDelta({ collection: PROPOSAL_COLLECTION, key: input.key, ...scopeOf(input.projectId), authorization: approvalAuthorization(state, input.key, input.proposedAt) })(state);
  };
}

// TCRN-CROSS-SUB-497: the settlement of a rule's approval. AGENTS.md is written from the proposal the
// approval read, before the append and outside the lock, so the append settles that proposal only: one
// proposed again since at the very same instant, with another change, is PROPOSAL_STALE as well.
function settleReadDelta(input: ProposalSettleInput, read: Proposal): (state: WorkspaceState) => MutationDelta {
  const settle = settleDelta(input);
  return (state) => {
    const recorded = pendingProposal(state, input.key, input.projectId, input.proposedAt);
    if (canonicalJson(recorded) !== canonicalJson(read)) {
      fail("PROPOSAL_STALE", `the proposal ${input.key} was proposed again since it was read; read it again before settling it`, { target: input.key, required: recorded.proposedAt, actual: input.proposedAt });
    }
    return settle(state);
  };
}

/**
 * The deltas that approve one pending proposal of a gate: the gate's declaration or removal, exactly
 * the config.record event gates-config-set or gates-config-remove appends, with the approval's
 * authorization (Q5), then the proposal's removal. A rule's approval also writes AGENTS.md, so it goes
 * through approveProposal.
 */
export function approveDeltas(input: ProposalSettleInput): readonly ((state: WorkspaceState) => MutationDelta)[] {
  const named = proposalTargetOf(input.key);
  if (named === null) fail("PROPOSAL_INVALID", `${input.key} is not gate:<gate name> or rule:<rule id>`, { target: input.key });
  if (named.kind !== "gate") fail("PROPOSAL_INVALID", `approving ${input.key} writes AGENTS.md with the records: approve it through approveProposal`, { target: input.key });
  return [
    (state) => {
      const proposal = pendingProposal(state, input.key, input.projectId, input.proposedAt);
      const target = { name: named.target, ...scopeOf(input.projectId), authorization: approvalAuthorization(state, input.key, input.proposedAt) };
      return (proposal.action === "set" ? setGateDelta({ ...target, gate: proposal.payload }) : removeGateDelta(target))(state);
    },
    settleDelta(input),
  ];
}

/** A proposal write: the proposal as it stands after it, and the library's state. */
export interface ProposalWrite {
  readonly proposal: Proposal;
  readonly state: WorkspaceState;
}

/**
 * Record a pending proposal in a library, as this machine's only writer of it. Proposals are not
 * projected, so neither this nor a rejection rewrites config/project.json. TCRN-CROSS-SUB-497: the
 * proposal is checked, and the delta built against the merged state, outside the library write lock;
 * only the append takes it.
 */
export async function proposeChange(libraryRoot: string, input: Omit<ProposeDeltaInput, "proposedAt" | "projectId"> & WorkspaceMutationOptions): Promise<ProposalWrite> {
  const delta = proposeDelta({ ...input, proposedAt: input.occurredAt, ...scopeOf(input.configurationProjectId) });
  const committed = await appendEvents(libraryRoot, [delta], input);
  return { proposal: recordedProposal(committed, proposalKey(input.kind, input.target), input.configurationProjectId)!, state: committed };
}

/**
 * Reject one pending proposal in a library; the rejection is recorded with `authorization`.
 * TCRN-CROSS-SUB-497: the proposal is read and judged outside the library write lock, and judged
 * again by the delta against the state the append is built on; only the append takes the lock.
 */
export async function rejectProposal(libraryRoot: string, input: { readonly key: string; readonly proposedAt: string; readonly rejectedBy: string } & WorkspaceMutationOptions): Promise<ProposalWrite> {
  const delta = rejectDelta({ key: input.key, proposedAt: input.proposedAt, ...scopeOf(input.configurationProjectId), rejectedBy: input.rejectedBy, rejectedAt: input.occurredAt, ...(input.authorization === undefined ? {} : { authorization: input.authorization }) });
  const committed = await appendEvents(libraryRoot, [delta], input);
  return { proposal: recordedProposal(committed, input.key, input.configurationProjectId)!, state: committed };
}

export interface ProposalApprovalInput extends WorkspaceMutationOptions {
  readonly libraryRoot: string;
  readonly key: string;
  readonly proposedAt: string;
  // The project whose AGENTS.md a rule's approval writes, as rule-enable takes it; a gate's approval,
  // and a rule's on a coordination library, write no file.
  readonly projectRoot?: string;
  readonly backupRoot?: string;
  readonly catalog?: readonly BuiltInRule[];
}

/** What an approval did: the proposal it approved, the library's state after it, and a rule's change. */
export interface ProposalApproval {
  readonly proposal: Proposal;
  readonly state: WorkspaceState;
  readonly ruleChange: RuleChange | null;
}

/**
 * Approve one pending proposal (Atelier's; the CLI runs it for Atelier only): write the change it
 * names and remove it, in one append, recorded with surface atelier and decidedIn
 * proposal:<key>@<proposedAt> in this library (Q5). A rule's change goes through enableRule or
 * disableRule, which write AGENTS.md first and put it back when the append fails, so the file, the
 * records and the settlement change together or not at all (Q24).
 *
 * TCRN-CROSS-STORY-538 (TCRN-CROSS-SUB-497): no lock is held while the proposal is read and checked;
 * a refusal (not recorded, not pending, stale, no project named) waits for no other writer. The
 * approval's conditions are judged again where the append builds its events, against the state it
 * is built on: still recorded, still pending, proposed at `proposedAt` (and, for a rule, the very
 * proposal read). An approval another writer settled first, or a proposal recorded again since, is
 * refused there with the same reason codes and nothing is appended. A gate's declaration, the
 * settlement and config/project.json are written under one hold of the lock (appendEvents); a rule's
 * records and settlement are one append of enableRule or disableRule.
 */
export async function approveProposal(input: ProposalApprovalInput): Promise<ProposalApproval> {
  const named = proposalTargetOf(input.key) ?? fail("PROPOSAL_INVALID", `${input.key} is not gate:<gate name> or rule:<rule id>`, { target: input.key });
  const projectId = input.configurationProjectId;
  // The append's own options; the authorization is the approval's, never the caller's.
  const options: WorkspaceMutationOptions = {
    occurredAt: input.occurredAt,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.crashAt === undefined ? {} : { crashAt: input.crashAt }),
    ...(input.viewBudgetBytes === undefined ? {} : { viewBudgetBytes: input.viewBudgetBytes }),
  };
  const settle: ProposalSettleInput = { key: input.key, proposedAt: input.proposedAt, ...scopeOf(projectId) };
  // A library the append would refuse (an old layout, or one moved away) is refused before it is read,
  // as when the whole approval held the lock.
  await assertLibraryWritable(input.libraryRoot);
  const native = await materializeWorkspace(input.libraryRoot);
  const root = native.library?.libraryRoot ?? input.libraryRoot;
  // Checked before a file is written; the append checks it again.
  const proposal = pendingProposal(native, input.key, projectId, input.proposedAt);
  if (named.kind === "gate") {
    const [declare, settlement] = approveDeltas(settle) as readonly [(state: WorkspaceState) => MutationDelta, (state: WorkspaceState) => MutationDelta];
    // The proposal the append approved, which the receipt shows.
    let approved = proposal;
    const committed = await appendEvents(root, [
      (state) => {
        approved = pendingProposal(state, input.key, projectId, input.proposedAt);
        return declare(state);
      },
      settlement,
    ], options, (libraryRoot, state) => projectConfiguration(libraryRoot, state));
    return { proposal: approved, state: committed, ruleChange: null };
  }
  if (input.projectRoot === undefined && chainIdentity(native)?.role !== "coordination") {
    fail("PROPOSAL_INVALID", `approving ${input.key} writes the project's AGENTS.md: name the project`, { target: input.key, field: "projectRoot" });
  }
  const change = {
    ...options,
    libraryRoot: root,
    projectRoot: input.projectRoot ?? root,
    id: named.target,
    ...(projectId === undefined ? {} : { configurationProjectId: projectId }),
    // The library's id, which the state the append is built on holds as well.
    authorization: approvalAuthorization(native, input.key, input.proposedAt),
    alongside: [settleReadDelta(settle, proposal)],
    ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
  };
  const order = proposal.payload.order;
  const ruleChange = proposal.action === "enable"
    ? await enableRule({ ...change, ...(typeof order === "number" ? { order } : {}) })
    : await disableRule(change);
  return { proposal, state: ruleChange.state, ruleChange };
}
