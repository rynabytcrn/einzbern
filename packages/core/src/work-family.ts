// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-531 (MIN-256 D6 C5, MIN-257 D6; TCRN-CROSS-SUB-485): the INIT family of a work
// record, and of what a card or a minutes record points at. The conflict guards of knowledge-capture
// (KNOWLEDGE_POSSIBLE_CONFLICT) and minutes-record (MINUTES_POSSIBLE_CONFLICT) refused a write whenever
// an existing card or decision was close in topic, so cards and decisions about unrelated work stopped
// each other. They now ask first whether the two belong to one INIT family: two of different families
// are written beside each other, with a warning; two of one family, or two either of which has no
// family this library can name, are refused as before.
//
// A work record's family is the Initiative at the top of its parent chain: an Initiative is its own,
// and an Epic, Story or Subtask has its Initiative's. A record this library does not hold, one whose
// chain breaks off, and one whose chain does not end at an Initiative (a parentless Incident, say)
// have none. A deleted record keeps the family of the chain it was written under.
//
// TCRN-CROSS-STORY-539 (MIN-256 D6 C5, MIN-258 D1; TCRN-CROSS-SUB-503): a reference names a family in
// three ways -- a work id, a minutes id, and the external key of a work record this library holds
// (TCRN-CROSS-STORY-529, say) -- and a card's linked work (--work-ids) names it as a work id does. Both
// guards read them through referenceFamilies: a card's families, and a minutes record's.

import { compareCanonicalText } from "../../protocol/src/index.js";
import type { WorkspaceState } from "./workspace.js";

/** What a family is read from: the work records, and the minutes their links are taken from. */
export type WorkFamilyState = Pick<WorkspaceState, "work" | "minutes" | "conferenceMinutes" | "conferences">;

const workIndexes = new WeakMap<WorkspaceState["work"], ReadonlyMap<string, WorkspaceState["work"][number]>>();
const externalKeyIndexes = new WeakMap<WorkspaceState["work"], ReadonlyMap<string, string>>();

function workIndex(work: WorkspaceState["work"]): ReadonlyMap<string, WorkspaceState["work"][number]> {
  let index = workIndexes.get(work);
  if (index === undefined) {
    const built = new Map<string, WorkspaceState["work"][number]>();
    // First wins, as a find over the list would answer.
    for (const record of work) if (!built.has(record.id)) built.set(record.id, record);
    index = built;
    workIndexes.set(work, index);
  }
  return index;
}

// TCRN-CROSS-SUB-503: the ids of this library's work records by external key, the key as the record
// stores it. First wins, as workIndex answers.
function externalKeyIndex(work: WorkspaceState["work"]): ReadonlyMap<string, string> {
  let index = externalKeyIndexes.get(work);
  if (index === undefined) {
    const built = new Map<string, string>();
    for (const record of work) if (!built.has(record.externalKey)) built.set(record.externalKey, record.id);
    index = built;
    externalKeyIndexes.set(work, index);
  }
  return index;
}

/**
 * The id of the Initiative at the top of `workId`'s parent chain, `workId` itself when it is an
 * Initiative; null when this library holds no such record, the chain breaks off or loops, or it ends
 * at a record that is not an Initiative.
 */
export function initFamilyOf(state: Pick<WorkspaceState, "work">, workId: string): string | null {
  const index = workIndex(state.work);
  let cursor = index.get(workId);
  if (cursor === undefined) return null;
  const seen = new Set<string>([cursor.id]);
  while (cursor.parentId !== null) {
    const parent: WorkspaceState["work"][number] | undefined = index.get(cursor.parentId);
    if (parent === undefined || seen.has(parent.id)) return null;
    seen.add(parent.id);
    cursor = parent;
  }
  return cursor.kind === "Initiative" ? cursor.id : null;
}

// The work a minutes record links: its own linkedWorkIds, or, for the minutes a conference close
// wrote, the conference's, as minutes-list and minutes-show read them. Undefined when this library
// holds no live minutes of that id.
function minutesWorkIds(state: WorkFamilyState, minutesId: string): readonly string[] | undefined {
  const recorded = state.minutes.find((record) => record.id === minutesId && !record.tombstone);
  if (recorded !== undefined) return recorded.linkedWorkIds;
  const closed = state.conferenceMinutes.find((record) => record.id === minutesId && !record.tombstone);
  if (closed === undefined) return undefined;
  return state.conferences.find((conference) => conference.id === closed.conferenceId)?.linkedWorkIds ?? [];
}

/**
 * The INIT families a list of references points at (Q11): a work id names its own family, a minutes
 * id the families of the work it links, the external key of a work record this library holds that
 * record's family (TCRN-CROSS-SUB-503: the whole reference equal to the key, case and all), and every
 * other reference -- a file, a URL, a key this library holds no work under -- names none. Each of
 * `linkedWorkIds` -- a card's linked work -- names a family as a work id does. Null when the family
 * is not known: nothing names one, or one of them names a work record or minutes this library does
 * not hold, minutes that link no work, or work with no family. A card the user crest holds that
 * points at another library's work is therefore of no known family. Otherwise the family ids,
 * sorted, without repeats.
 */
export function referenceFamilies(state: WorkFamilyState, references: readonly string[], linkedWorkIds: readonly string[] = []): readonly string[] | null {
  const families = new Set<string>();
  const add = (workId: string): boolean => {
    const family = initFamilyOf(state, workId);
    if (family === null) return false;
    families.add(family);
    return true;
  };
  for (const reference of references) {
    if (reference.startsWith("work:")) {
      if (!add(reference)) return null;
      continue;
    }
    if (reference.startsWith("minutes:")) {
      const linked = minutesWorkIds(state, reference);
      if (linked === undefined || linked.length === 0) return null;
      for (const workId of linked) if (!add(workId)) return null;
      continue;
    }
    const keyed = externalKeyIndex(state.work).get(reference);
    if (keyed !== undefined && !add(keyed)) return null;
  }
  for (const workId of linkedWorkIds) if (!add(workId)) return null;
  return families.size === 0 ? null : [...families].sort(compareCanonicalText);
}

/**
 * TCRN-CROSS-SUB-503: the INIT families of a card -- its source references and its linked work
 * (referenceFamilies), read in `state`. What the write-time guard reads of a new card and of each
 * version of a card it scores against, and, since TCRN-CROSS-SUB-504, what a read reads of the two
 * cards of an unresolved pair and of a knowledge hint's candidates.
 */
export function cardFamilies(
  state: WorkFamilyState,
  card: { readonly sourceReferences: readonly string[]; readonly linkedWorkIds: readonly string[] },
): readonly string[] | null {
  return referenceFamilies(state, card.sourceReferences, card.linkedWorkIds);
}

/**
 * Whether two sides are of different INIT families: both known, and no family in common. A side of
 * no known family is taken to be of the other's, which keeps the guard refusing (Q11).
 */
export function familiesApart(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return left !== null && right !== null && !left.some((family) => right.includes(family));
}
