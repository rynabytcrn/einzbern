import { involvedProjectsOf } from "./involved-projects.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-474 R1, R2 (MIN-227 D5, D7): what recall indexes and how a hit reads. The
// question a prompt asks is answered by intent: the Stories (and the historical Incidents that
// stood for a defect), the Initiatives and Epics above them, the minutes that decided something,
// and the knowledge cards. A Subtask is a step of a Story, not an intent of its own, and is not
// indexed; status does not matter, because a done Story is still the record of what was meant.
//
// A hit is one line a host can put in front of a prompt: kind and status, title, key, id and the
// titles above the record, so a reader knows where it sits without opening it. The lines of one
// answer are cut to the prompt's byte budget (injection.perPromptBytes) at whole lines.
//
// The CLI (TCRN-CROSS-STORY-474, recall) and the prompt hook (STORY-477) build their input here, so
// the two cannot index differently.
//
// TCRN-CROSS-STORY-476 R5 (MIN-227 D25): the cards come from two stores, the library's crest and
// this user's crest, and every card says which (scope "project" or "user") on its way to its hit,
// whose line marks a user card 「用户」. A user card is recalled in every project.

import type { WorkRecord } from "../../protocol/src/index.js";
import { listKnowledgeMetadata } from "./knowledge-core.js";
import type { KnowledgeStatusFilter, KnowledgeStoreScope } from "./knowledge-core.js";
import { expansionsText } from "./knowledge-language.js";
import { decisionLedger, decisionsNamedIn, decisionsOfMinutes, minutesView, obsoleteDecisionHints } from "./minutes.js";
import type { DecisionLedger, DecisionStatusFilter, ObsoleteDecisionHint } from "./minutes.js";
import type { RecallCardRemoval, RecallHit, RecallInputs, RecallKnowledgeInput, RecallMinutesInput, RecallScope, RecallWorkInput } from "./recall.js";
import { RECALL_INDEXED_WORK_KINDS } from "./recall.js";
import { storyFields } from "./story-fields.js";
import { decidedInOf } from "./work-relations.js";
import type { WorkspaceState } from "./workspace.js";

/** The longest a hit line gets, in UTF-8 bytes; a longer one is cut at a code point with an ellipsis. */
export const RECALL_LINE_MAX_BYTES = RUNTIME_CAPACITY.bufferBytes;
// Declared ancestry is complete; the seen set below rejects cycles without a depth ceiling.

export interface RecallInputOptions {
  readonly projectId?: string;
  readonly scopeExcerptBytes?: number;
  // TCRN-CROSS-SUB-426 R17 续作修订三 (C-R18-1; MIN-239 D6; STORY-514 R4): which decisions of each
  // minutes record recall indexes, as minutes-list reads them. Left out, the valid ones; "obsolete" the
  // obsolete ones alone and "all" every one, which only a recall asked for them gives (the recall verb's
  // --status obsolete or all). The prompt hook leaves it out.
  readonly decisions?: DecisionStatusFilter;
}

function displayTitle(record: Pick<WorkRecord, "title" | "externalKey">): string {
  return typeof record.title === "string" && record.title.length > 0 ? record.title : record.externalKey;
}

/**
 * The titles above a work record, nearest first: a Story's Epic, then its Initiative; an Incident
 * walks its parentId the same way. The walk stops at the root, at a missing parent, or at a cycle.
 */
export function workParentChain(work: ReadonlyMap<string, WorkRecord>, record: WorkRecord): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>([record.id]);
  let parentId = record.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = work.get(parentId);
    if (parent === undefined) break;
    seen.add(parent.id);
    chain.push(displayTitle(parent));
    parentId = parent.parentId;
  }
  return chain;
}

/**
 * A card read from a store's knowledge-list record, labelled with the store it came from.
 * TCRN-CROSS-SUB-426 R17 续作修订三 (STORY-514 AC1): a removed card -- a record whose status is
 * "removed", which only a read asked for removed cards gives -- keeps its removal as the list gave it.
 */
export function recallCardFromRecord(record: Readonly<Record<string, unknown>>, scope: RecallScope): RecallKnowledgeInput {
  const references = Array.isArray(record["sourceReferences"])
    ? (record["sourceReferences"] as readonly unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id: String(record["id"] ?? ""),
    externalKey: String(record["externalKey"] ?? ""),
    subject: String(record["subject"] ?? ""),
    summary: String(record["summary"] ?? ""),
    snippet: String(record["snippet"] ?? ""),
    tags: ((record["tags"] ?? []) as readonly unknown[]).map((tag) => String(tag)),
    // The weight-6 column: an author's own restatements of the question a card answers,
    // flattened by the one helper the CLI's recall shares (TCRN-CROSS-STORY-364).
    expansions: expansionsText(record["expansions"]),
    scope,
    // TCRN-CROSS-SUB-426: never indexed; read only for the obsolete-decision hint.
    ...(references.length === 0 ? {} : { sourceReferences: references }),
    // Never indexed either; read only for the removed card's hit.
    ...(record["status"] === "removed" ? { removal: cardRemoval(record["removal"]) } : {}),
  };
}

// A removed card's removal as knowledge-list answers it (knowledge-core.ts, removalDiagnostic), field
// by field; a field the list did not give as its type is empty, or null where the list can give null.
function cardRemoval(value: unknown): RecallCardRemoval {
  const removal: Readonly<Record<string, unknown>> = isRecord(value) ? value : {};
  const text = (field: string): string | null => {
    const entry = removal[field];
    return typeof entry === "string" ? entry : null;
  };
  const sequence = removal["sequence"];
  return {
    reason: text("reason") ?? "",
    basis: text("basis") ?? "",
    actor: text("actor"),
    removedAt: text("removedAt") ?? "",
    supersededBy: text("supersededBy"),
    deviceId: text("deviceId"),
    sequence: typeof sequence === "number" ? sequence : null,
    eventHash: text("eventHash"),
  };
}

/**
 * The library's cards and the user's, as one input: each labelled with its store, the library's
 * first. A user card whose id a library card already holds (one external key filed in both) is
 * left out -- the index keys cards by id, and the library's card is the nearer answer.
 */
export function mergeRecallCards(project: readonly RecallKnowledgeInput[], user: readonly RecallKnowledgeInput[]): readonly RecallKnowledgeInput[] {
  const projectCards = project.map((card): RecallKnowledgeInput => ({ ...card, scope: "project" }));
  const held = new Set(projectCards.map((card) => card.id));
  return [...projectCards, ...user.filter((card) => !held.has(card.id)).map((card): RecallKnowledgeInput => ({ ...card, scope: "user" }))];
}

/**
 * TCRN-CROSS-SUB-413 (STORY-476 D7): one version of a user-crest id more than one writer wrote, as
 * knowledge-list names it under `unresolvedDuplicates`: the device stream and event that hold it
 * (all three null for a version the metadata/body layout holds), when it was written, its subject
 * and its body digest.
 */
export interface RecallUserCrestDuplicateVersion {
  readonly deviceId: string | null;
  readonly sequence: number | null;
  readonly eventHash: string | null;
  readonly updatedAt: string;
  readonly subject: string;
  readonly bodySha256: string;
}

/** One such id: its external key and every version, one per writer. */
export interface RecallUserCrestDuplicate {
  readonly id: string;
  readonly externalKey: string;
  readonly versions: readonly RecallUserCrestDuplicateVersion[];
}

/**
 * TCRN-CROSS-SUB-414 (STORY-476 D7): one record of a library's crest written against chain events
 * this device has not received, as knowledge-list names it under `awaitingChain`: the card's id and
 * the device stream and event that hold the record.
 */
export interface RecallAwaitingChainEntry {
  readonly id: string;
  readonly deviceId: string;
  // Always a number in knowledge-list's answer; null only if an entry arrived without one.
  readonly sequence: number | null;
  readonly eventHash: string;
}

/**
 * TCRN-CROSS-SUB-414 (R16, C-R16-1): one live record of a library's crest whose project the chain no
 * longer holds, as knowledge-list names it under `unresolvedScopes`: the card's id, the device stream
 * and event that hold the record (all three null for a record the metadata/body layout holds, as for a
 * duplicate's version), and the project id that no longer resolves.
 */
export interface RecallUnresolvedScopeEntry {
  readonly id: string;
  readonly deviceId: string | null;
  readonly sequence: number | null;
  readonly eventHash: string | null;
  readonly projectId: string;
}

/** How one store's read went: its reason code (a refusal's, when it refused), its digest and its card count. */
export interface RecallCardStoreRead {
  readonly reasonCode: string;
  readonly digest: string;
  readonly cards: number;
  // TCRN-CROSS-SUB-310: the pairs of cards the store holds in unresolved conflict, which its
  // default selection left out of the cards counted above; empty for a store with none.
  readonly unresolvedConflicts: readonly (readonly string[])[];
  // TCRN-CROSS-SUB-413: the ids the store holds as unresolved duplicates, every version of which its
  // default selection left out; empty for a store with none.
  readonly unresolvedDuplicates: readonly RecallUserCrestDuplicate[];
  // TCRN-CROSS-SUB-414: the library crest's records awaiting chain events this device has not
  // received, whose cards its default selection left out; always empty for the user crest.
  readonly awaitingChain: readonly RecallAwaitingChainEntry[];
  // TCRN-CROSS-SUB-414 (R16): the library crest's live records whose project the chain no longer
  // holds, whose cards its default selection left out; always empty for the user crest.
  readonly unresolvedScopes: readonly RecallUnresolvedScopeEntry[];
}

/**
 * TCRN-CROSS-SUB-310 (MIN-235 D7): why the user crest gave recall fewer cards than it holds. Either
 * its read was refused (`reasonCode` the refusal's, e.g. KNOWLEDGE_PARTIAL_STATE for a forked
 * stream: no user card is recalled; since R17 no read is refused for its bodies' size, MIN-238 D1),
 * or it withheld cards in unresolved conflict (`reasonCode` KNOWLEDGE_POSSIBLE_CONFLICT,
 * the pairs under `unresolvedConflicts` and their number of cards as `withheldCards`; every other
 * user card is recalled). TCRN-CROSS-SUB-413: or it withheld every version of an id more than one
 * writer wrote, named under `unresolvedDuplicates`; the reason code is KNOWLEDGE_DUPLICATE when no
 * pair is withheld as well, and `withheldCards` counts the pairs' cards and every version.
 */
export interface RecallUserCrestDegraded {
  readonly reasonCode: string;
  readonly unresolvedConflicts?: readonly (readonly string[])[];
  readonly unresolvedDuplicates?: readonly RecallUserCrestDuplicate[];
  readonly withheldCards?: number;
}

/**
 * TCRN-CROSS-SUB-414 (C-R15-1): the cards a library's crest withheld from recall, in the form
 * RecallUserCrestDegraded has. `reasonCode` is KNOWLEDGE_POSSIBLE_CONFLICT when an unresolved pair is
 * withheld, else KNOWLEDGE_DUPLICATE when versions of an unresolved duplicate are, else
 * KNOWLEDGE_LINK_INVALID -- the refusal validate and a checkpoint meet -- when cards whose project the
 * chain no longer holds are (R16, C-R16-1), else KNOWLEDGE_HIGH_WATER_MISMATCH -- the refusal the
 * strict surfaces meet -- for records awaiting chain events alone. Each list is present when it is
 * not empty, `awaitingChain` and `unresolvedScopes` naming those records as knowledge-list does, and
 * `withheldCards` counts every withheld card and version once. A refused read of the library's crest
 * is not one: it stays the answer's knowledgeReasonCode.
 */
export interface RecallProjectCrestDegraded extends RecallUserCrestDegraded {
  readonly awaitingChain?: readonly RecallAwaitingChainEntry[];
  readonly unresolvedScopes?: readonly RecallUnresolvedScopeEntry[];
  readonly withheldCards: number;
}

export interface RecallCardRead {
  readonly cards: readonly RecallKnowledgeInput[];
  readonly stores: Readonly<Record<KnowledgeStoreScope, RecallCardStoreRead>>;
  // Both stores' digests, so a recall checkpoint moves when either store does.
  readonly digest: string;
  // TCRN-CROSS-SUB-310: null when the user crest gave every card it holds, or holds none.
  readonly userCrestDegraded: RecallUserCrestDegraded | null;
  // TCRN-CROSS-SUB-414: null when the library's crest withheld no card, or its read was refused.
  readonly projectCrestDegraded: RecallProjectCrestDegraded | null;
  // TCRN-CROSS-SUB-425: the ids of the removed cards among `cards`, which a read asked for with status
  // "removed" or "all"; empty for the valid cards every other read gives.
  readonly removedCardIds: readonly string[];
}

function conflictPairs(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value)) return [];
  return value.filter((pair): pair is readonly unknown[] => Array.isArray(pair)).map((pair) => pair.map((id) => String(id)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function duplicateEntries(value: unknown): readonly RecallUserCrestDuplicate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry): RecallUserCrestDuplicate => ({
    id: String(entry["id"] ?? ""),
    externalKey: String(entry["externalKey"] ?? ""),
    versions: (Array.isArray(entry["versions"]) ? entry["versions"] : []).filter(isRecord).map((version): RecallUserCrestDuplicateVersion => ({
      deviceId: typeof version["deviceId"] === "string" ? version["deviceId"] : null,
      sequence: typeof version["sequence"] === "number" ? version["sequence"] : null,
      eventHash: typeof version["eventHash"] === "string" ? version["eventHash"] : null,
      updatedAt: String(version["updatedAt"] ?? ""),
      subject: String(version["subject"] ?? ""),
      bodySha256: String(version["bodySha256"] ?? ""),
    })),
  }));
}

function awaitingChainEntries(value: unknown): readonly RecallAwaitingChainEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry): RecallAwaitingChainEntry => ({
    id: String(entry["id"] ?? ""),
    deviceId: String(entry["deviceId"] ?? ""),
    sequence: typeof entry["sequence"] === "number" ? entry["sequence"] : null,
    eventHash: String(entry["eventHash"] ?? ""),
  }));
}

function unresolvedScopeEntries(value: unknown): readonly RecallUnresolvedScopeEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry): RecallUnresolvedScopeEntry => ({
    id: String(entry["id"] ?? ""),
    deviceId: typeof entry["deviceId"] === "string" ? entry["deviceId"] : null,
    sequence: typeof entry["sequence"] === "number" ? entry["sequence"] : null,
    eventHash: typeof entry["eventHash"] === "string" ? entry["eventHash"] : null,
    projectId: String(entry["projectId"] ?? ""),
  }));
}

/**
 * The cards a store that read withheld from recall, named as its knowledge-list named them; null when
 * it withheld none. Every version of a duplicate counts, and a card counts once however many of the
 * lists name it: a pair's card or a duplicate's version can also be a record awaiting chain events,
 * or one whose project the chain no longer holds.
 */
function withheldCardsDiagnostic(read: RecallCardStoreRead): RecallProjectCrestDegraded | null {
  if (read.unresolvedConflicts.length === 0 && read.unresolvedDuplicates.length === 0 &&
    read.awaitingChain.length === 0 && read.unresolvedScopes.length === 0) return null;
  const duplicateIds = new Set(read.unresolvedDuplicates.map((duplicate) => duplicate.id));
  const cardIds = new Set([
    ...read.unresolvedConflicts.flat(),
    ...read.awaitingChain.map((entry) => entry.id),
    ...read.unresolvedScopes.map((entry) => entry.id),
  ].filter((id) => !duplicateIds.has(id)));
  return {
    // A withheld pair keeps the reason code it has always had; versions of a duplicate alone are
    // KNOWLEDGE_DUPLICATE, the refusal a write that saw the other version would have met; cards whose
    // project the chain no longer holds are KNOWLEDGE_LINK_INVALID, the refusal validate and a
    // checkpoint meet until a card supersedes them; records awaiting chain events alone are
    // KNOWLEDGE_HIGH_WATER_MISMATCH, the refusal validate, a checkpoint and a rebase meet while they wait.
    reasonCode: read.unresolvedConflicts.length > 0
      ? "KNOWLEDGE_POSSIBLE_CONFLICT"
      : read.unresolvedDuplicates.length > 0
        ? "KNOWLEDGE_DUPLICATE"
        : read.unresolvedScopes.length > 0 ? "KNOWLEDGE_LINK_INVALID" : "KNOWLEDGE_HIGH_WATER_MISMATCH",
    ...(read.unresolvedConflicts.length === 0 ? {} : { unresolvedConflicts: read.unresolvedConflicts }),
    ...(read.unresolvedDuplicates.length === 0 ? {} : { unresolvedDuplicates: read.unresolvedDuplicates }),
    ...(read.awaitingChain.length === 0 ? {} : { awaitingChain: read.awaitingChain }),
    ...(read.unresolvedScopes.length === 0 ? {} : { unresolvedScopes: read.unresolvedScopes }),
    withheldCards: cardIds.size + read.unresolvedDuplicates.reduce((count, duplicate) => count + duplicate.versions.length, 0),
  };
}

/**
 * The user crest's degradation for recall, from how its read went; null when it is not degraded. It
 * holds no record awaiting chain events and no card naming a project, and a pair's cards are never a
 * duplicate's, so the withheld cards read exactly as TCRN-CROSS-SUB-310 and SUB-413 named them.
 */
function userCrestDegradation(read: RecallCardStoreRead): RecallUserCrestDegraded | null {
  if (read.reasonCode !== "KNOWLEDGE_LIST_READY") return { reasonCode: read.reasonCode };
  return withheldCardsDiagnostic(read);
}

/**
 * TCRN-CROSS-SUB-414: the library crest's withheld cards for recall; null when it withheld none. A
 * refused read is null here, because the answer's knowledgeReasonCode already names it.
 */
function projectCrestDegradation(read: RecallCardStoreRead): RecallProjectCrestDegraded | null {
  return read.reasonCode === "KNOWLEDGE_LIST_READY" ? withheldCardsDiagnostic(read) : null;
}

export interface RecallCardReadOptions {
  readonly projectId?: string;
  readonly at: string;
  readonly allowTrailing?: boolean;
  // TCRN-CROSS-SUB-425 (MIN-239 D6): which cards to read from each store, as knowledge-list reads them.
  // Left out, the valid ones; "removed" (the removed ones alone) or "all" only when a user asked for
  // them (the recall verb's --status). The prompt hook always reads the valid ones.
  readonly status?: KnowledgeStatusFilter;
}

/**
 * The cards recall indexes for a prompt in the library at `workspaceRoot`: that library's crest and
 * this user's crest, each read whole as an explicit search corpus (explicit-only cards admitted,
 * the complete corpus before scoring, so bm25 keeps its baseline) and merged by mergeRecallCards.
 * A store that cannot be read gives no cards and its reason code rather than failing the recall,
 * so "no cards" never reads like "no card matched"; a user crest that has never been written is an
 * empty read, not a failure. TCRN-CROSS-SUB-310: cards a user crest holds in unresolved conflict
 * are not recalled, the rest are, and `userCrestDegraded` says why the user crest gave fewer cards
 * than it holds -- a refusal or the withheld conflicts -- rather than leaving it to a nested code.
 * TCRN-CROSS-SUB-413: nor is any version of an unresolved duplicate, which it names the same way.
 * TCRN-CROSS-SUB-414: the library's crest withholds its pairs, its duplicates' versions and its cards
 * awaiting chain events the same way, and `projectCrestDegraded` names them in the same form; R16
 * adds its cards whose project the chain no longer holds, under `unresolvedScopes`.
 * TCRN-CROSS-SUB-425 (MIN-239 D6): only valid cards are read, unless `options.status` asks for another
 * status, which each store answers as knowledge-list does (R17 续作修订三, C-R18-1): "removed" the removed
 * cards alone, "all" every card. A removed card is indexed by what it keeps, its subject; it carries its
 * removal, as the list gave it, and its id is named in `removedCardIds`.
 */
export async function readRecallCards(workspaceRoot: string, options: RecallCardReadOptions): Promise<RecallCardRead> {
  const read = async (scope: KnowledgeStoreScope): Promise<{ readonly cards: readonly RecallKnowledgeInput[]; readonly store: RecallCardStoreRead }> => {
    try {
      const answer = await listKnowledgeMetadata(workspaceRoot, {
        at: options.at,
        ...(options.allowTrailing === undefined ? {} : { allowTrailing: options.allowTrailing }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(scope === "project" && options.projectId !== undefined ? { projectId: options.projectId } : {}),
        includeExplicitOnly: true,
        limit: Number.MAX_SAFE_INTEGER,
        ...(scope === "user" ? { scope } : {}),
      });
      const records = (answer["records"] ?? []) as readonly Readonly<Record<string, unknown>>[];
      const cards = records.map((record) => recallCardFromRecord(record, scope));
      return {
        cards,
        store: {
          reasonCode: String(answer["reasonCode"] ?? ""),
          digest: String(answer["resultDigest"] ?? ""),
          cards: cards.length,
          unresolvedConflicts: conflictPairs(answer["unresolvedConflicts"]),
          unresolvedDuplicates: duplicateEntries(answer["unresolvedDuplicates"]),
          awaitingChain: awaitingChainEntries(answer["awaitingChain"]),
          unresolvedScopes: unresolvedScopeEntries(answer["unresolvedScopes"]),
        },
      };
    } catch (error) {
      const reasonCode = (error as { readonly reasonCode?: unknown }).reasonCode;
      if (typeof reasonCode !== "string") throw error;
      return { cards: [], store: { reasonCode, digest: "absent", cards: 0, unresolvedConflicts: [], unresolvedDuplicates: [], awaitingChain: [], unresolvedScopes: [] } };
    }
  };
  const project = await read("project");
  const user = await read("user");
  const cards = mergeRecallCards(project.cards, user.cards);
  return {
    cards,
    stores: { project: project.store, user: user.store },
    digest: `${project.store.digest}:${user.store.digest}`,
    userCrestDegraded: userCrestDegradation(user.store),
    projectCrestDegraded: projectCrestDegradation(project.store),
    // The removed cards the merge kept: a user card whose id the library's crest already gave is not one.
    removedCardIds: cards.filter((card) => card.removal !== undefined).map((card) => card.id),
  };
}

/**
 * Everything recall indexes, read from a state and the knowledge cards read beside it: the live
 * work records of the indexed kinds with their goal, body and parent titles, every minutes record
 * (new and historical, minutesView) with its title, summary and decisions, and the cards as given
 * -- a card that does not say which store it came from is the library's (TCRN-CROSS-STORY-476 R5).
 * TCRN-CROSS-SUB-426 (MIN-239 D6): a minutes record is indexed with its valid decisions alone, and
 * a record none of whose decisions is valid is not indexed; the prompt hook reads the same inputs.
 * R17 续作修订三 (C-R18-1; STORY-514 R4): `options.decisions` names another status as minutes-list
 * does, for a recall that was asked for it: "obsolete" indexes each record's obsolete decisions alone,
 * a record with none not indexed, and "all" every decision of every record.
 */
export function recallInputsFromState(
  state: Pick<WorkspaceState, "work" | "minutes" | "conferenceMinutes" | "conferences">,
  cards: readonly RecallKnowledgeInput[],
  options: RecallInputOptions = {},
): RecallInputs {
  if (options.projectId !== undefined) state = {
    work: state.work.filter(entry => entry.projectId === options.projectId),
    minutes: state.minutes.filter(entry => entry.projectId === options.projectId),
    conferenceMinutes: state.conferenceMinutes.filter(entry => entry.projectId === options.projectId),
    conferences: state.conferences.filter(entry => entry.projectId === options.projectId),
  };
  const byId = new Map(state.work.map((record) => [record.id, record]));
  const work: RecallWorkInput[] = [];
  for (const record of state.work) {
    if (record.tombstone || !(RECALL_INDEXED_WORK_KINDS as readonly string[]).includes(record.kind)) continue;
    const fields = storyFields(record);
    const fullText = record.kind === "Story" || record.kind === "Incident";
    const scope = record.extensions["advisory:scope"]?.value;
    work.push({
      id: record.id,
      externalKey: record.externalKey,
      involvedProjects: involvedProjectsOf(record),
      kind: record.kind,
      status: record.status,
      title: record.title ?? null,
      summary: record.summary ?? null,
      scope: typeof scope === "string" ? scope : "",
      labels: record.labels ?? [],
      goal: fields.goal,
      body: fullText ? fields.body : null,
      parentChain: workParentChain(byId, record),
    });
  }
  const conferenceTypes = new Map(state.conferences.map((conference) => [conference.id, conference.type]));
  const outcomeClasses = new Map(state.conferenceMinutes.map((minutes) => [minutes.id, { outcomeClass: minutes.outcomeClass, conferenceId: minutes.conferenceId }]));
  const minutes: RecallMinutesInput[] = minutesView(state, options.decisions ?? "valid").map((entry) => {
    const historical = outcomeClasses.get(entry.id);
    return {
      id: entry.id,
      conferenceTitle: entry.title,
      conferenceType: entry.kind === "conference-minutes" && historical !== undefined ? conferenceTypes.get(historical.conferenceId) ?? "" : "",
      summary: entry.summary,
      decisions: entry.decisions.map((decision) => decision.text),
      outcomeClass: entry.kind === "conference-minutes" && historical !== undefined ? historical.outcomeClass : "recorded",
      externalKey: entry.externalKey,
      // Only when an obsolete decision left a gap, or the decisions given are not D1..Dn, so every other
      // input reads as it always did.
      ...(entry.withheldDecisions === undefined && entry.decisions.every((decision, index) => decision.number === index + 1)
        ? {}
        : { decisionNumbers: entry.decisions.map((decision) => decision.number) }),
    };
  });
  return {
    knowledge: cards.map((card): RecallKnowledgeInput => (card.scope === undefined ? { ...card, scope: "project" } : card)),
    minutes,
    work,
    ...(options.scopeExcerptBytes === undefined ? {} : { scopeExcerptBytes: options.scopeExcerptBytes }),
  };
}

type HintState = Pick<WorkspaceState, "work" | "minutes" | "conferenceMinutes">;

// A card's decisions (TCRN-CROSS-SUB-426): every decision of the minutes its source references name
// -- by minutes id or by external key -- and the decisions its subject, summary, snippet and
// references name one by one (decisionsNamedIn).
function cardDecisions(state: HintState, ledger: DecisionLedger, card: RecallKnowledgeInput): readonly string[] {
  const references = card.sourceReferences ?? [];
  const keys = new Map(state.minutes.filter((record) => !record.tombstone).map((record) => [record.externalKey, record.id]));
  const minutesIds = references
    .map((reference) => (ledger.records.has(reference) ? reference : keys.get(reference.toUpperCase())))
    .filter((minutesId): minutesId is string => minutesId !== undefined);
  return [
    ...decisionsOfMinutes(ledger, minutesIds),
    ...decisionsNamedIn(state, ledger, [card.subject, card.summary, card.snippet, ...references].join("\n")),
  ];
}

/**
 * TCRN-CROSS-SUB-426 (MIN-239 D5): the obsolete decisions of the minutes a work record names as
 * decided-in (its advisory:decided-by list), each with the decision that superseded it; empty when
 * none is obsolete. work-show answers them as the record's obsoleteDecisions.
 */
export function workObsoleteDecisions(state: Pick<WorkspaceState, "minutes" | "conferenceMinutes">, record: Pick<WorkRecord, "extensions">): readonly ObsoleteDecisionHint[] {
  const ledger = decisionLedger(state);
  return obsoleteDecisionHints(ledger, decisionsOfMinutes(ledger, decidedInOf(record)));
}

/**
 * TCRN-CROSS-SUB-426 (MIN-239 D5): the hits of an answer, each with the obsolete decisions its record
 * points at -- a work record's decided-by minutes, a card's linked minutes and named decisions -- and
 * the decision that superseded each (null when withdrawn). A hit that points at none is returned as
 * it was, and so is every hit of a library with no obsolete decision. R17 续作修订二 (STORY-514 R4):
 * when the recall indexed the obsolete decisions (`options.decisions` "obsolete" or "all"), a minutes
 * hit carries its own obsolete decisions the same way, so an obsolete decision a recall gives comes
 * with the decision that superseded it or with null, withdrawn -- what minutes-show's explicit read
 * says of it.
 */
export function recallDecisionHints(
  state: HintState,
  cards: readonly RecallKnowledgeInput[],
  hits: readonly RecallHit[],
  options: Pick<RecallInputOptions, "decisions"> = {},
): readonly RecallHit[] {
  const ledger = decisionLedger(state);
  if (![...ledger.decisions.values()].some((entry) => entry.status === "obsolete")) return hits;
  const ownDecisions = (options.decisions ?? "valid") !== "valid";
  const work = new Map(state.work.map((record) => [record.id, record]));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  return hits.map((hit) => {
    const record = hit.kind === "work" ? work.get(hit.id) : undefined;
    const card = hit.kind === "card" ? cardsById.get(hit.id) : undefined;
    const decisions = record !== undefined
      ? decisionsOfMinutes(ledger, decidedInOf(record))
      : card !== undefined
        ? cardDecisions(state, ledger, card)
        : ownDecisions && hit.kind === "minutes" ? decisionsOfMinutes(ledger, [hit.id]) : [];
    const hints = obsoleteDecisionHints(ledger, decisions);
    return hints.length === 0 ? hit : { ...hit, obsoleteDecisions: hints };
  });
}

// The hint a hit's line carries: at most three obsolete decisions, each with its successor or 撤回.

function hintText(hints: readonly ObsoleteDecisionHint[]): string {
  const shown = hints.map((hint) => `${hint.decision}→${hint.supersededBy ?? "撤回"}`).join("；");
  return `过时决策 ${shown}`;
}

function capBytes(text: string, maximumBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximumBytes) return text;
  const ellipsis = "…";
  let end = maximumBytes - Buffer.byteLength(ellipsis, "utf8");
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${ellipsis}`;
}

/**
 * One hit as one line: `[Story done] title · externalKey · id · Epic title ‹ Initiative title` for a
 * work record, `[纪要 key] title · D1 first decision …` for minutes, `[卡片] subject · id` for a card,
 * and `[卡片 用户] subject · id` for a card from the user's crest (TCRN-CROSS-STORY-476 R5); a card hit
 * whose status is "removed" -- only a recall that asked for removed cards has one (TCRN-CROSS-SUB-425)
 * -- is marked `已移除`. A line is at most RECALL_LINE_MAX_BYTES and never holds a line break.
 * TCRN-CROSS-SUB-426: a work or card hit that points at obsolete decisions carries
 * `过时决策 <decision>→<successor or 撤回>` after its id, and a minutes hit of a recall asked for the
 * obsolete decisions carries its own after its lead (R17 续作修订二).
 */
export function formatRecallLine(hit: RecallHit): string {
  const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();
  const hint = hit.obsoleteDecisions === undefined || hit.obsoleteDecisions.length === 0 ? "" : ` · ${hintText(hit.obsoleteDecisions)}`;
  let line: string;
  if (hit.kind === "card") {
    line = `[卡片${hit.scope === "user" ? " 用户" : ""}${hit.status === "removed" ? " 已移除" : ""}] ${flat(hit.title)} · ${hit.id}${hint}`;
  } else if (hit.kind === "minutes") {
    line = `[纪要 ${hit.key}] ${flat(hit.title)}${hit.lead.length > 0 ? ` · ${flat(hit.lead)}` : ""}${hint}`;
  } else {
    const chain = hit.parentChain.length > 0 ? ` · ${hit.parentChain.map(flat).join(" ‹ ")}` : "";
    line = `[${hit.recordKind} ${hit.status}] ${flat(hit.title)} · ${hit.key} · ${hit.id}${hint}${chain}`;
  }
  return capBytes(line, RECALL_LINE_MAX_BYTES);
}

/**
 * The lines of an answer, in rank order, cut to `perPromptBytes` UTF-8 bytes at whole lines (one
 * newline between lines counts): the first line that does not fit ends the answer.
 */
export function recallContextLines(hits: readonly RecallHit[], perPromptBytes: number): readonly string[] {
  const lines: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const line = formatRecallLine(hit);
    const cost = Buffer.byteLength(line, "utf8") + (lines.length === 0 ? 0 : 1);
    if (used + cost > perPromptBytes) break;
    lines.push(line);
    used += cost;
  }
  return lines;
}
