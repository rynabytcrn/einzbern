// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-476 R4 (MIN-227 D9; TCRN-CROSS-SUB-311): the two writes that close something --
// a work record reaching done, and minutes being recorded -- are where a lesson is most likely to
// exist, so each answers one line asking whether there is knowledge to extract, naming the cards
// a card about it could conflict with. The candidates are the cards the write path itself would
// score as possible conflicts (knowledgeConflictHits, TCRN-CROSS-STORY-365), scored against the
// work record's title and goal, or against the minutes' summary, over both stores: the library's
// crest and this user's (TCRN-CROSS-STORY-476 R5). The line only asks. It writes nothing, and a
// store that cannot be read gives no candidates rather than failing the write it answers.
//
// TCRN-CROSS-STORY-539 (MIN-256 D6 C5, MIN-258 D1; TCRN-CROSS-SUB-504): a card of an INIT family apart
// from the target's is no candidate. The target's families are a work record's own (initFamilyOf) or
// those of the work minutes link; a card's, those its source references and linked work name
// (cardFamilies), in the library the write went through. A card is left out only when both are known
// and share none (familiesApart): a card of the target's family or of no known family stays, and a
// target of no known family keeps every card. `filteredByFamily` counts the cards left out, and the
// line ends saying how many.

import { PROTOCOL_LIMITS, compareCanonicalText } from "../../protocol/src/index.js";
import { KNOWLEDGE_STORE_SCOPES, knowledgeConflictHits, knowledgeRelevanceScore, listKnowledgeMetadata } from "./knowledge-core.js";
import type { KnowledgeUnitMetadata } from "./knowledge-core.js";
import { minutesView } from "./minutes.js";
import { storyFields } from "./story-fields.js";
import { cardFamilies, familiesApart, initFamilyOf, referenceFamilies } from "./work-family.js";
import type { WorkspaceState } from "./workspace.js";

/** The question every hint line opens with. */
export const KNOWLEDGE_HINT_MAXIMUM_CANDIDATES = 5;

export const KNOWLEDGE_HINT_QUESTION = "是否有可提取的知识";

/**
 * One hint: the line a host shows, the card ids it names, strongest first, and how many cards that
 * scored it left out for being of an INIT family apart from the target's (TCRN-CROSS-SUB-504).
 */
export interface KnowledgeHint {
  readonly line: string;
  readonly conflictCandidateIds: readonly string[];
  readonly filteredByFamily: number;
}

/** What a hint is about: a work record that reached done, or minutes just recorded. */
export type KnowledgeHintTarget = { readonly workId: string } | { readonly minutesId: string };

type HintState = Pick<WorkspaceState, "work" | "minutes" | "conferenceMinutes" | "conferences">;

// The text a hint is scored with: a work record's title (its key when it has none) and its goal,
// or the minutes' summary. A target this state does not hold scores against nothing.
function hintText(state: HintState, target: KnowledgeHintTarget): string {
  if ("workId" in target) {
    const record = state.work.find((entry) => entry.id === target.workId);
    if (record === undefined) return "";
    const title = typeof record.title === "string" && record.title.length > 0 ? record.title : record.externalKey;
    return [title, storyFields(record).goal ?? ""].join("\n").trim();
  }
  return minutesView(state).find((entry) => entry.id === target.minutesId)?.summary.trim() ?? "";
}

// TCRN-CROSS-SUB-504: the INIT families of what a hint is about -- a work record's own, or those of
// the work minutes link (a conference's minutes, the conference's) -- null when not known.
function targetFamilies(state: HintState, target: KnowledgeHintTarget): readonly string[] | null {
  if ("workId" in target) {
    const family = initFamilyOf(state, target.workId);
    return family === null ? null : [family];
  }
  return referenceFamilies(state, [target.minutesId]);
}

/**
 * The hint for one work record or minutes record: every live card that scores as a possible
 * conflict with its text, but for those of an INIT family apart from the target's
 * (TCRN-CROSS-SUB-504), ranked by that score (then by id) and cut to the length of a knowledge
 * completion hint (at most five cards), the line that names them, or 「无」, and ends with
 * how many were left out by family, and that number (`filteredByFamily`).
 */
export function knowledgeHintFor(state: HintState, cards: readonly KnowledgeUnitMetadata[], target: KnowledgeHintTarget): KnowledgeHint {
  const text = hintText(state, target);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const score = (id: string): number => {
    const card = byId.get(id);
    return card === undefined ? 0 : knowledgeRelevanceScore(card, text);
  };
  const hits = text.length === 0 ? [] : [...new Set(knowledgeConflictHits(cards, text))];
  const own = hits.length === 0 ? null : targetFamilies(state, target);
  const apart = (id: string): boolean => {
    const card = byId.get(id);
    return card !== undefined && familiesApart(own, cardFamilies(state, card));
  };
  const kept = own === null ? hits : hits.filter((id) => !apart(id));
  const filteredByFamily = hits.length - kept.length;
  const ranked = kept
    .sort((left, right) => score(right) - score(left) || compareCanonicalText(left, right))
    .slice(0, KNOWLEDGE_HINT_MAXIMUM_CANDIDATES);
  return {
    line: `${KNOWLEDGE_HINT_QUESTION}；可能冲突的卡：${ranked.length === 0 ? "无" : ranked.join("、")}；按族滤掉 ${String(filteredByFamily)} 张`,
    conflictCandidateIds: ranked,
    filteredByFamily,
  };
}

/**
 * The cards a hint is scored against: every valid card of the library's crest and of this user's
 * crest, read the way a write reads them (selection "all"; a retired card is dropped by the scorer).
 * TCRN-CROSS-SUB-425 (MIN-239 D6): a removed card is no candidate, so only the valid cards are read. A
 * store that refuses the read -- one never initialized, or one another writer holds -- gives no
 * cards; the read admits a store trailing the chain, because the write it answers has just moved
 * the chain.
 */
export async function readKnowledgeHintCards(workspaceRoot: string, at: string): Promise<readonly KnowledgeUnitMetadata[]> {
  const cards: KnowledgeUnitMetadata[] = [];
  for (const scope of KNOWLEDGE_STORE_SCOPES) {
    try {
      const answer = await listKnowledgeMetadata(workspaceRoot, {
        at,
        selection: "all",
        status: "valid",
        allowTrailing: true,
        limit: PROTOCOL_LIMITS.maxCanonicalBytes,
        ...(scope === "user" ? { scope } : {}),
      });
      cards.push(...(answer["records"] as unknown as readonly KnowledgeUnitMetadata[]));
    } catch (error) {
      if (typeof (error as { readonly reasonCode?: unknown }).reasonCode !== "string") throw error;
    }
  }
  return cards;
}
