// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-473 R2 (MIN-227 D8): the engine asks two things of a Story, its goal and its
// acceptance; the rest is the author's own prose. They are three required:false extensions --
// advisory:goal, advisory:acceptance and advisory:body -- and a Story is created only when it has
// a goal and an acceptance, written as fields or mapped from the Goal and Acceptance Criteria
// blocks of a scope. Nothing is migrated: a record written before the fields existed keeps its
// advisory:scope byte for byte, and storyFields maps it every time it is read.

import type { WorkRecord } from "../../protocol/src/index.js";
import { parseStoryScope } from "./story-scope-compliance.js";

export const STORY_GOAL_KEY = "advisory:goal" as const;
export const STORY_ACCEPTANCE_KEY = "advisory:acceptance" as const;
export const STORY_BODY_KEY = "advisory:body" as const;
const SCOPE_KEY = "advisory:scope";

/** The two fields a Story must have. */
export const STORY_REQUIRED_FIELDS = Object.freeze(["goal", "acceptance"] as const);
export type StoryRequiredField = typeof STORY_REQUIRED_FIELDS[number];

/** Where a record's fields come from: its own field extensions, its old scope, or nothing. */
export type StoryFieldSource = "fields" | "scope" | "none";

export interface StoryFieldValues {
  readonly goal: string | null;
  readonly acceptance: string | null;
  readonly body: string | null;
}

export interface StoryFields extends StoryFieldValues {
  readonly source: StoryFieldSource;
}

/**
 * The fields an old ten-block scope yields: the Goal block is the goal, the Acceptance Criteria
 * block the acceptance, and everything else -- the text before the first heading and the other
 * blocks, in their order, under their headings -- the body. A block that is missing or empty
 * yields null, and so does a scope that is not a non-empty string.
 */
export function deriveStoryFieldsFromScope(scope: unknown): StoryFieldValues {
  if (typeof scope !== "string" || scope.trim().length === 0) return { goal: null, acceptance: null, body: null };
  const parsed = parseStoryScope(scope);
  let goal: string | null = null;
  let acceptance: string | null = null;
  const rest: string[] = parsed.preamble.length === 0 ? [] : [parsed.preamble];
  for (const section of parsed.sections) {
    if (section.heading === "Goal" && goal === null) {
      goal = section.content.length === 0 ? null : section.content;
      continue;
    }
    if (section.heading === "Acceptance Criteria" && acceptance === null) {
      acceptance = section.content.length === 0 ? null : section.content;
      continue;
    }
    if (section.content.length > 0) rest.push(`## ${section.heading}\n${section.content}`);
  }
  return { goal, acceptance, body: rest.length === 0 ? null : rest.join("\n\n") };
}

function fieldValue(record: Pick<WorkRecord, "extensions">, key: string): string | null {
  const value = record.extensions[key]?.value;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A record's goal, acceptance and body. A field the record carries wins; one it does not carry
 * is mapped from its advisory:scope, so a Story written with the old ten blocks reads with the
 * same three fields as one written with them. Any kind may be asked: an Initiative or an Epic
 * read this way gives the goal recall indexes (TCRN-CROSS-STORY-474 R1).
 */
export function storyFields(record: Pick<WorkRecord, "extensions">): StoryFields {
  const goal = fieldValue(record, STORY_GOAL_KEY);
  const acceptance = fieldValue(record, STORY_ACCEPTANCE_KEY);
  const body = fieldValue(record, STORY_BODY_KEY);
  const scope = record.extensions[SCOPE_KEY]?.value;
  const hasFields = goal !== null || acceptance !== null || body !== null;
  const mapped = goal !== null && acceptance !== null && body !== null ? null : deriveStoryFieldsFromScope(scope);
  return {
    goal: goal ?? mapped?.goal ?? null,
    acceptance: acceptance ?? mapped?.acceptance ?? null,
    body: body ?? mapped?.body ?? null,
    source: hasFields ? "fields" : typeof scope === "string" && scope.trim().length > 0 ? "scope" : "none",
  };
}

/** The first of goal and acceptance a record lacks, or null when it has both. */
export function missingStoryField(fields: StoryFieldValues): StoryRequiredField | null {
  if (fields.goal === null) return "goal";
  if (fields.acceptance === null) return "acceptance";
  return null;
}

/**
 * The label half of the Owner-decider probe, in either working language, read from the goal
 * (TCRN-CROSS-MIN-102 裁定二): a Story whose goal names Owner as its decider needs a deciding-minutes
 * backlink before done. The value half keeps its original character class -- adding `.` would stop
 * matching a Chinese decider clause that contains a version number, which fails open.
 */
const OWNER_DECIDER = /(?:判定人|\bdecider\b)\s*[=:：]\s*[^\n。；;]*(?:\bOwner\b|所有者)/iu;

/** Whether a Story's goal names Owner as its decider (it replaces the old scope-based probe). */
export function storyOwnerDeciderNamed(fields: Pick<StoryFieldValues, "goal">): boolean {
  return fields.goal !== null && OWNER_DECIDER.test(fields.goal);
}
