// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-SUB-426 (MIN-239 D5; TCRN-CROSS-STORY-514 R3): a card is written for what the work
// records and the decisions do not already say. Before a card is written it is compared with the
// text of every live work record and every valid decision of the library; a card that repeats one
// of them is refused with KNOWLEDGE_ALREADY_RECORDED, naming the record, because what it says belongs
// there -- in the work record (work-annotate) or in minutes (minutes-record) -- and not in a third
// place. The code is not KNOWLEDGE_DUPLICATE, which names one external key written by two writers
// (TCRN-CROSS-SUB-413).
//
// The check is called from one place, the card write every write verb reaches (buildMetadata in
// knowledge-core.ts: knowledge-create, knowledge-batch's create members, knowledge-capture and the
// article index card). It reads the state that write already holds and writes nothing. Whether a
// card is invalid is not judged here: a model that finds one removes it and says why (TCRN-CROSS-
// SUB-425).

import { compareCanonicalText } from "../../protocol/src/index.js";
import type { WorkRecord } from "../../protocol/src/index.js";
import type { KnowledgeUnitMetadata } from "./knowledge-core.js";
import { decisionLedger, topicTokenWeight } from "./minutes.js";
import { recallTextTokens } from "./recall.js";
import { storyFields } from "./story-fields.js";
import type { WorkspaceState } from "./workspace.js";

export const KNOWLEDGE_DUPLICATE_REASON_CODES = Object.freeze(["KNOWLEDGE_ALREADY_RECORDED"] as const);
export type KnowledgeDuplicateReasonCode = typeof KNOWLEDGE_DUPLICATE_REASON_CODES[number];

export class KnowledgeDuplicateError extends Error {
  readonly reasonCode: KnowledgeDuplicateReasonCode;
  // `target` is the record the card repeats most closely, `remedy` where its content goes; the CLI
  // entry prints both beside the code.
  readonly details: Readonly<Record<string, string>>;
  constructor(reasonCode: KnowledgeDuplicateReasonCode, message: string, details: Readonly<Record<string, string>>) {
    super(message);
    this.name = "KnowledgeDuplicateError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

/**
 * A card repeats a record when the weight of its words that the record carries is at least this share
 * of the weight of all its words (each word weighed as the topic comparison of decisions weighs it,
 * topicTokenWeight over the records compared and the card), and at least
 * KNOWLEDGE_DUPLICATE_SHARED_TOKENS of its words are shared. Measured read-only on the cross-project
 * library on 2026-09-29 (158 cards, 1,537 work records, 1,669 decisions): the eight cards at or above
 * 0.5 are all retired or superseded cards restating an Incident or Story, and no active card reaches
 * 0.44, so a card still in use would not have been refused.
 */
export const KNOWLEDGE_DUPLICATE_THRESHOLD = 0.5;
export const KNOWLEDGE_DUPLICATE_SHARED_TOKENS = 8;

/** A record a card repeats: a work record (by id) or a valid decision (by its number). */
export interface KnowledgeDuplicateMatch {
  readonly kind: "work" | "decision";
  readonly target: string;
  // The work record's external key; null for a decision.
  readonly key: string | null;
  readonly score: number;
  readonly shared: number;
}

/** The fields of a card the check reads: what it is about and what it says. */
export type KnowledgeDuplicateCard = Pick<KnowledgeUnitMetadata, "subject" | "summary" | "snippet">;

interface ComparedRecord {
  readonly kind: "work" | "decision";
  readonly target: string;
  readonly key: string | null;
  readonly tokens: ReadonlySet<string>;
}

interface ComparedCorpus {
  readonly records: readonly ComparedRecord[];
  readonly frequency: ReadonlyMap<string, number>;
}

/** The text of a work record the check reads: its title, summary, scope, goal, acceptance and body. */
function workText(record: WorkRecord): string {
  const fields = storyFields(record);
  const scope = record.extensions["advisory:scope"]?.value;
  return [record.title ?? "", record.summary ?? "", typeof scope === "string" ? scope : "", fields.goal ?? "", fields.acceptance ?? "", fields.body ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
}

// The records of one state, read once: a batch writes several cards against the same state.
let cached: { readonly key: string; readonly corpus: ComparedCorpus } | null = null;

function comparedCorpus(state: Pick<WorkspaceState, "metadata" | "version" | "headEventHash" | "work" | "minutes" | "conferenceMinutes">): ComparedCorpus {
  const key = `${state.metadata.workspaceId}:${String(state.version)}:${state.headEventHash ?? ""}`;
  if (cached !== null && cached.key === key) return cached.corpus;
  const records: ComparedRecord[] = [];
  for (const record of state.work) {
    if (record.tombstone) continue;
    const tokens = recallTextTokens(workText(record));
    if (tokens.size > 0) records.push({ kind: "work", target: record.id, key: record.externalKey, tokens });
  }
  for (const entry of decisionLedger(state).decisions.values()) {
    if (entry.status !== "valid") continue;
    const tokens = recallTextTokens(entry.text);
    if (tokens.size > 0) records.push({ kind: "decision", target: entry.decision, key: null, tokens });
  }
  const frequency = new Map<string, number>();
  for (const record of records) for (const token of record.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const corpus = { records, frequency };
  cached = { key, corpus };
  return corpus;
}

/**
 * The work records and valid decisions a card repeats, strongest first (then by kind and target):
 * the card's words are its subject, summary, snippet and body, read as recall reads a text.
 */
export function knowledgeDuplicateMatches(
  state: Pick<WorkspaceState, "metadata" | "version" | "headEventHash" | "work" | "minutes" | "conferenceMinutes">,
  card: KnowledgeDuplicateCard,
  body: string,
): readonly KnowledgeDuplicateMatch[] {
  const corpus = comparedCorpus(state);
  if (corpus.records.length === 0) return [];
  const tokens = recallTextTokens([card.subject, card.summary, card.snippet, body].join("\n"));
  if (tokens.size < KNOWLEDGE_DUPLICATE_SHARED_TOKENS) return [];
  // The card is one more document of the corpus, so each of its words counts itself once.
  const size = corpus.records.length + 1;
  const weights = new Map([...tokens].map((token) => [token, topicTokenWeight(size, (corpus.frequency.get(token) ?? 0) + 1)]));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const matches: KnowledgeDuplicateMatch[] = [];
  for (const record of corpus.records) {
    let shared = 0;
    let carried = 0;
    for (const [token, weight] of weights) {
      if (!record.tokens.has(token)) continue;
      shared += 1;
      carried += weight;
    }
    if (shared < KNOWLEDGE_DUPLICATE_SHARED_TOKENS) continue;
    const score = carried / total;
    if (score >= KNOWLEDGE_DUPLICATE_THRESHOLD) matches.push({ kind: record.kind, target: record.target, key: record.key, score, shared });
  }
  return matches.sort((left, right) => right.score - left.score || compareCanonicalText(left.kind, right.kind) || compareCanonicalText(left.target, right.target));
}

/**
 * Refuse a card that repeats a work record or a valid decision (KNOWLEDGE_ALREADY_RECORDED), naming
 * the closest under `target` and telling where its content belongs.
 */
export function assertKnowledgeNotRecorded(
  state: Pick<WorkspaceState, "metadata" | "version" | "headEventHash" | "work" | "minutes" | "conferenceMinutes">,
  card: KnowledgeDuplicateCard,
  body: string,
): void {
  const matches = knowledgeDuplicateMatches(state, card, body);
  const first = matches[0];
  if (first === undefined) return;
  const named = matches.map((match) => `${match.kind === "work" ? `work ${match.key ?? ""} (${match.target})` : `decision ${match.target}`} ${match.score.toFixed(2)}`).join("; ");
  const remedy = first.kind === "work"
    ? "write it into the work record (work-annotate), or into minutes (minutes-record) when it is a decision"
    : "it is recorded in minutes already; record a new decision (minutes-record) if it changes";
  throw new KnowledgeDuplicateError("KNOWLEDGE_ALREADY_RECORDED", `this card repeats what is already recorded: ${named}; ${remedy}`, { target: first.target, remedy });
}
