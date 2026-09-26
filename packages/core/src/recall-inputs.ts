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

import type { WorkRecord } from "../../protocol/src/index.js";
import { minutesView } from "./minutes.js";
import type { RecallHit, RecallInputs, RecallKnowledgeInput, RecallMinutesInput, RecallWorkInput } from "./recall.js";
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

/**
 * Everything recall indexes, read from a state and the knowledge cards read beside it: the live
 * work records of the indexed kinds with their goal, body and parent titles, every minutes record
 * (new and historical, minutesView) with its title, summary and decisions, and the cards as given.
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
    knowledge: cards,
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
 * work record, `[纪要 key] title · D1 first decision …` for minutes, `[卡片] subject · id` for a card.
 * A line is at most RECALL_LINE_MAX_BYTES and never holds a line break.
 */
export function formatRecallLine(hit: RecallHit): string {
  const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();
  let line: string;
  if (hit.kind === "card") {
    line = `[卡片] ${flat(hit.title)} · ${hit.id}`;
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
