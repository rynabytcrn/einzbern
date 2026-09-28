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
import type { KnowledgeStoreScope } from "./knowledge-core.js";
import { expansionsText } from "./knowledge-language.js";
import { minutesView } from "./minutes.js";
import type { RecallHit, RecallInputs, RecallKnowledgeInput, RecallMinutesInput, RecallScope, RecallWorkInput } from "./recall.js";
import { RECALL_INDEXED_WORK_KINDS } from "./recall.js";
import { storyFields } from "./story-fields.js";
import type { WorkspaceState } from "./workspace.js";

/** The longest a hit line gets, in UTF-8 bytes; a longer one is cut at a code point with an ellipsis. */
export const RECALL_LINE_MAX_BYTES = 480;
const PARENT_CHAIN_DEPTH = 8;

export interface RecallInputOptions {
  readonly scopeExcerptBytes?: number;
}

function displayTitle(record: Pick<WorkRecord, "title" | "externalKey">): string {
  return typeof record.title === "string" && record.title.length > 0 ? record.title : record.externalKey;
}

/**
 * The titles above a work record, nearest first: a Story's Epic, then its Initiative; an Incident
 * walks its parentId the same way. The walk stops at the root, at a missing parent, or after
 * PARENT_CHAIN_DEPTH steps.
 */
export function workParentChain(work: ReadonlyMap<string, WorkRecord>, record: WorkRecord): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>([record.id]);
  let parentId = record.parentId;
  while (parentId !== null && chain.length < PARENT_CHAIN_DEPTH && !seen.has(parentId)) {
    const parent = work.get(parentId);
    if (parent === undefined) break;
    seen.add(parent.id);
    chain.push(displayTitle(parent));
    parentId = parent.parentId;
  }
  return chain;
}

/** A card read from a store's knowledge-list record, labelled with the store it came from. */
export function recallCardFromRecord(record: Readonly<Record<string, unknown>>, scope: RecallScope): RecallKnowledgeInput {
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
}

/**
 * TCRN-CROSS-SUB-310 (MIN-235 D7): why the user crest gave recall fewer cards than it holds. Either
 * its read was refused (`reasonCode` the refusal's, e.g. KNOWLEDGE_LIMIT_EXCEEDED: no user card is
 * recalled), or it withheld cards in unresolved conflict (`reasonCode` KNOWLEDGE_POSSIBLE_CONFLICT,
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

export interface RecallCardRead {
  readonly cards: readonly RecallKnowledgeInput[];
  readonly stores: Readonly<Record<KnowledgeStoreScope, RecallCardStoreRead>>;
  // Both stores' digests, so a recall checkpoint moves when either store does.
  readonly digest: string;
  // TCRN-CROSS-SUB-310: null when the user crest gave every card it holds, or holds none.
  readonly userCrestDegraded: RecallUserCrestDegraded | null;
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

/** The user crest's degradation for recall, from how its read went; null when it is not degraded. */
function userCrestDegradation(read: RecallCardStoreRead): RecallUserCrestDegraded | null {
  if (read.reasonCode !== "KNOWLEDGE_LIST_READY") return { reasonCode: read.reasonCode };
  if (read.unresolvedConflicts.length === 0 && read.unresolvedDuplicates.length === 0) return null;
  return {
    // A withheld pair keeps the reason code it has always had; versions of a duplicate alone are
    // KNOWLEDGE_DUPLICATE, the refusal a write that saw the other version would have met.
    reasonCode: read.unresolvedConflicts.length > 0 ? "KNOWLEDGE_POSSIBLE_CONFLICT" : "KNOWLEDGE_DUPLICATE",
    ...(read.unresolvedConflicts.length === 0 ? {} : { unresolvedConflicts: read.unresolvedConflicts }),
    ...(read.unresolvedDuplicates.length === 0 ? {} : { unresolvedDuplicates: read.unresolvedDuplicates }),
    withheldCards: new Set(read.unresolvedConflicts.flat()).size +
      read.unresolvedDuplicates.reduce((count, duplicate) => count + duplicate.versions.length, 0),
  };
}

export interface RecallCardReadOptions {
  readonly at: string;
  readonly allowTrailing?: boolean;
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
 */
export async function readRecallCards(workspaceRoot: string, options: RecallCardReadOptions): Promise<RecallCardRead> {
  const read = async (scope: KnowledgeStoreScope): Promise<{ readonly cards: readonly RecallKnowledgeInput[]; readonly store: RecallCardStoreRead }> => {
    try {
      const answer = await listKnowledgeMetadata(workspaceRoot, {
        at: options.at,
        ...(options.allowTrailing === undefined ? {} : { allowTrailing: options.allowTrailing }),
        includeExplicitOnly: true,
        limit: 1_048_576,
        ...(scope === "user" ? { scope } : {}),
      });
      const cards = ((answer["records"] ?? []) as readonly Readonly<Record<string, unknown>>[]).map((record) => recallCardFromRecord(record, scope));
      return {
        cards,
        store: {
          reasonCode: String(answer["reasonCode"] ?? ""),
          digest: String(answer["resultDigest"] ?? ""),
          cards: cards.length,
          unresolvedConflicts: conflictPairs(answer["unresolvedConflicts"]),
          unresolvedDuplicates: duplicateEntries(answer["unresolvedDuplicates"]),
        },
      };
    } catch (error) {
      const reasonCode = (error as { readonly reasonCode?: unknown }).reasonCode;
      if (typeof reasonCode !== "string") throw error;
      return { cards: [], store: { reasonCode, digest: "absent", cards: 0, unresolvedConflicts: [], unresolvedDuplicates: [] } };
    }
  };
  const project = await read("project");
  const user = await read("user");
  return {
    cards: mergeRecallCards(project.cards, user.cards),
    stores: { project: project.store, user: user.store },
    digest: `${project.store.digest}:${user.store.digest}`,
    userCrestDegraded: userCrestDegradation(user.store),
  };
}

/**
 * Everything recall indexes, read from a state and the knowledge cards read beside it: the live
 * work records of the indexed kinds with their goal, body and parent titles, every minutes record
 * (new and historical, minutesView) with its title, summary and decisions, and the cards as given
 * -- a card that does not say which store it came from is the library's (TCRN-CROSS-STORY-476 R5).
 */
export function recallInputsFromState(
  state: Pick<WorkspaceState, "work" | "minutes" | "conferenceMinutes" | "conferences">,
  cards: readonly RecallKnowledgeInput[],
  options: RecallInputOptions = {},
): RecallInputs {
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
  const minutes: RecallMinutesInput[] = minutesView(state).map((entry) => {
    const historical = outcomeClasses.get(entry.id);
    return {
      id: entry.id,
      conferenceTitle: entry.title,
      conferenceType: entry.kind === "conference-minutes" && historical !== undefined ? conferenceTypes.get(historical.conferenceId) ?? "" : "",
      summary: entry.summary,
      decisions: entry.decisions.map((decision) => decision.text),
      outcomeClass: entry.kind === "conference-minutes" && historical !== undefined ? historical.outcomeClass : "recorded",
      externalKey: entry.externalKey,
    };
  });
  return {
    knowledge: cards.map((card): RecallKnowledgeInput => (card.scope === undefined ? { ...card, scope: "project" } : card)),
    minutes,
    work,
    ...(options.scopeExcerptBytes === undefined ? {} : { scopeExcerptBytes: options.scopeExcerptBytes }),
  };
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
 * and `[卡片 用户] subject · id` for a card from the user's crest (TCRN-CROSS-STORY-476 R5). A line is
 * at most RECALL_LINE_MAX_BYTES and never holds a line break.
 */
export function formatRecallLine(hit: RecallHit): string {
  const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();
  let line: string;
  if (hit.kind === "card") {
    line = `[卡片${hit.scope === "user" ? " 用户" : ""}] ${flat(hit.title)} · ${hit.id}`;
  } else if (hit.kind === "minutes") {
    line = `[纪要 ${hit.key}] ${flat(hit.title)}${hit.lead.length > 0 ? ` · ${flat(hit.lead)}` : ""}`;
  } else {
    const chain = hit.parentChain.length > 0 ? ` · ${hit.parentChain.map(flat).join(" ‹ ")}` : "";
    line = `[${hit.recordKind} ${hit.status}] ${flat(hit.title)} · ${hit.key} · ${hit.id}${chain}`;
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
