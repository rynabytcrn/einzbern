// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-476 R4 (MIN-227 D9; TCRN-CROSS-SUB-311): the two writes that close something --
// a work record reaching done, and minutes being recorded -- are where a lesson is most likely to
// exist, so each answers one line asking whether there is knowledge to extract, naming the cards
// a card about it could conflict with. The candidates are the cards the write path itself would
// score as possible conflicts (knowledgeConflictHits, TCRN-CROSS-STORY-365), scored against the
// work record's title and goal, or against the minutes' summary, over both stores: the library's
// crest and this user's (TCRN-CROSS-STORY-476 R5). The line only asks. It writes nothing, and a
// store that cannot be read gives no candidates rather than failing the write it answers.

import { PROTOCOL_LIMITS, compareCanonicalText } from "../../protocol/src/index.js";
import { KNOWLEDGE_LIMITS, KNOWLEDGE_STORE_SCOPES, knowledgeConflictHits, knowledgeRelevanceScore, listKnowledgeMetadata } from "./knowledge-core.js";
import type { KnowledgeUnitMetadata } from "./knowledge-core.js";
import { minutesView } from "./minutes.js";
import { storyFields } from "./story-fields.js";
import type { WorkspaceState } from "./workspace.js";

/** The question every hint line opens with. */
export const KNOWLEDGE_HINT_QUESTION = "是否有可提取的知识";

/** One hint: the line a host shows, and the card ids it names, strongest first. */
export interface KnowledgeHint {
  readonly line: string;
  readonly conflictCandidateIds: readonly string[];
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

/**
 * The hint for one work record or minutes record: every live card that scores as a possible
 * conflict with its text, ranked by that score (then by id) and cut to the length of a knowledge
 * answer (KNOWLEDGE_LIMITS.maximumQueryResults), and the line that names them, or 「无」.
 */
export function knowledgeHintFor(state: HintState, cards: readonly KnowledgeUnitMetadata[], target: KnowledgeHintTarget): KnowledgeHint {
  const text = hintText(state, target);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const score = (id: string): number => {
    const card = byId.get(id);
    return card === undefined ? 0 : knowledgeRelevanceScore(card, text);
  };
  const hits = text.length === 0 ? [] : [...new Set(knowledgeConflictHits(cards, text))];
  const ranked = hits
    .sort((left, right) => score(right) - score(left) || compareCanonicalText(left, right))
    .slice(0, KNOWLEDGE_LIMITS.maximumQueryResults);
  return {
    line: `${KNOWLEDGE_HINT_QUESTION}；可能冲突的卡：${ranked.length === 0 ? "无" : ranked.join("、")}`,
    conflictCandidateIds: ranked,
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
