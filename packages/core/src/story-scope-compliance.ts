// SPDX-License-Identifier: Apache-2.0

/**
 * The Story scope is a human-readable string rather than a second schema stored in the event
 * record. TCRN-CROSS-STORY-473 (MIN-227 D8) retired the ten-block contract that used to gate it:
 * the heading set, its order, non-empty blocks, the four purpose anchors and the evidence and
 * fix-item token checks, with their reason codes. What stays here is the reader: the headings a
 * scope may use, a parser that splits a scope into them (story-fields.ts maps the Goal and
 * Acceptance Criteria blocks of an old scope to the goal and acceptance fields), the one-line
 * summary drawn from a Goal, and the floor an admitted template holds the records bound to it to.
 */
export const STORY_SCOPE_HEADINGS = Object.freeze([
  "Goal",
  "Requirements",
  "Acceptance Criteria",
  "Business Background",
  "Preconditions",
  "Assumptions",
  "Use Cases & Examples",
  "Feature Toggle & Setting",
  "Permissions",
  "Implementation Notes",
] as const);

export type StoryScopeHeading = typeof STORY_SCOPE_HEADINGS[number];

// The refusals of the template floor (validateTemplateScope). Until TCRN-CROSS-STORY-473 the
// heading, order, empty-block, acceptance and required codes were shared with the Story
// validator under a STORY_SCOPE_ prefix; they are the template's own now.
export type StoryScopeProblemCode =
  | "TEMPLATE_SCOPE_REQUIRED"
  | "TEMPLATE_SCOPE_HEADING_MISSING"
  | "TEMPLATE_SCOPE_HEADING_DUPLICATE"
  | "TEMPLATE_SCOPE_HEADING_ORDER"
  | "TEMPLATE_SCOPE_SECTION_EMPTY"
  | "TEMPLATE_SCOPE_ACCEPTANCE_INVALID"
  | "TEMPLATE_SCOPE_HEADING_UNEXPECTED"
  | "TEMPLATE_SCOPE_REFERENCE_INVALID";

export interface StoryScopeProblem {
  readonly code: StoryScopeProblemCode;
  readonly heading?: string;
  readonly message: string;
}

export interface StoryScopeSection {
  // A template-bound record may use an admitted heading set outside the Story vocabulary, so the
  // section shape carries any heading; the Story parser only ever yields StoryScopeHeading values.
  readonly heading: string;
  readonly content: string;
  readonly line: number;
}

export interface StoryScopeValidation {
  readonly ok: boolean;
  readonly problems: readonly StoryScopeProblem[];
  readonly sections: readonly StoryScopeSection[];
}

/** A scope split at its Story headings: the text before the first one, and each block in order. */
export interface ParsedStoryScope {
  readonly preamble: string;
  readonly sections: readonly StoryScopeSection[];
}

const HEADING_NAMES = new Set<string>(STORY_SCOPE_HEADINGS);
const HEADING_LINE = /^\s*(?:#{1,6}\s*)?(?:【([^】]+)】|\[([^\]]+)\]|(Goal|Requirements|Acceptance Criteria|Business Background|Preconditions|Assumptions|Use Cases & Examples|Feature Toggle & Setting|Permissions|Implementation Notes))(.*)$/u;

function headingFromMatch(match: RegExpMatchArray): { readonly name: string; readonly inline: string } {
  return {
    name: match[1] ?? match[2] ?? match[3] ?? "",
    inline: (match[4] ?? "").trim(),
  };
}

function isBulletList(content: string): boolean {
  return /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+\S+/u.test(content);
}

function hasOrderedGwt(content: string): boolean {
  const given = content.search(/\bGIVEN\b/iu);
  const when = content.search(/\bWHEN\b/iu);
  const then = content.search(/\bTHEN\b/iu);
  return given >= 0 && when > given && then > when;
}

/**
 * Split a scope at the lines that open one of the Story headings (`## Goal`, `【Goal】`, `[Goal]`
 * or a bare `Goal` at the start of a line, the spellings the ten-block validator read). A block
 * runs to the next heading; its inline remainder and its lines are joined and trimmed. Headings
 * outside the Story vocabulary are prose, and text before the first heading is the preamble.
 */
export function parseStoryScope(scope: string): ParsedStoryScope {
  const lines = scope.split(/\r?\n/u);
  const found: Array<{ readonly name: string; readonly inline: string; readonly line: number }> = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(HEADING_LINE);
    if (match === null) continue;
    const heading = headingFromMatch(match);
    if (!HEADING_NAMES.has(heading.name)) continue;
    found.push({ ...heading, line: index + 1 });
  }
  const sections = found.map((entry, index) => {
    const nextLine = found[index + 1]?.line ?? lines.length + 1;
    const content = [entry.inline, ...lines.slice(entry.line, nextLine - 1)].filter((value) => value.length > 0).join("\n").trim();
    return { heading: entry.name, content, line: entry.line };
  });
  const preamble = lines.slice(0, (found[0]?.line ?? lines.length + 1) - 1).join("\n").trim();
  return { preamble, sections };
}

/**
 * TCRN-CROSS-STORY-363, STORY-473. The one line a reader gets before deciding whether to open the
 * record: the first sentence of a goal, cut to a byte budget. The sentence boundary is the union
 * of the two working languages' terminators; whitespace is collapsed first, so the \n the class
 * also carries never matches. Null when there is no goal prose: an absent summary is a truthful
 * state, and inventing one from the external key would put the same string on every record.
 */
export function summarizeGoal(goal: unknown, maximumBytes: number): string | null {
  if (typeof goal !== "string") return null;
  const prose = goal.replace(/\s+/gu, " ").trim();
  if (prose.length === 0) return null;
  const boundary = prose.search(/[。．.!?！？；;\n]/u);
  const sentence = (boundary < 0 ? prose : prose.slice(0, boundary)).trim();
  const candidate = sentence.length === 0 ? prose : sentence;
  return truncateUtf8(candidate, maximumBytes);
}

/**
 * The summary an old scope yields: the first sentence of its Goal block. The write path and the
 * one-shot backfill (scripts/backfill-work-summaries.mjs) call the same function, so the two can
 * never disagree about a record.
 */
export function deriveWorkSummary(scope: unknown, maximumBytes: number): string | null {
  if (typeof scope !== "string" || scope.length === 0) return null;
  const goal = parseStoryScope(scope).sections.find((section) => section.heading === "Goal");
  return goal === undefined ? null : summarizeGoal(goal.content, maximumBytes);
}

/**
 * Cut on a UTF-8 code-point boundary, never mid-sequence: the budget is measured
 * in bytes because that is what the transport pays for, but half a character is
 * not a shorter string, it is an invalid one.
 */
function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) {
    return value;
  }
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * A template owns its headings. An admitted template holds a record bound to it to those
 * headings, in its order, each non-empty, with an acceptance block and reference-only blocks
 * where it names them. The engine-wide floor that used to ride on top -- the four purpose anchors
 * and the evidence and fix-item tokens -- went with the Story ten-block contract
 * (TCRN-CROSS-STORY-473 R1); a Story bound to a template is no longer held to it at all
 * (template-admission.ts).
 */
export interface ScopeTemplateDefinition {
  readonly id: string;
  readonly version: number;
  readonly headings: readonly string[];
  readonly acceptanceHeadings?: readonly string[];
  readonly referenceHeadings?: readonly string[];
}

const TEMPLATE_BRACKET_HEADING = /^\s*(?:【([^】]+)】|\[([^\]]+)\])(.*)$/u;
const TEMPLATE_MARKDOWN_HEADING = /^\s*#{1,6}\s+(.+?)\s*$/u;
const TEMPLATE_REFERENCE_VALUE = /^(?:(?:ref|reference|vault|credential|secret|attachment):[^\s]+|https?:\/\/[^\s]+)$/iu;

interface ParsedTemplateHeading {
  readonly name: string;
  readonly inline: string;
  readonly line: number;
}

function parseTemplateHeadings(scope: string): readonly ParsedTemplateHeading[] {
  const lines = scope.split(/\r?\n/u);
  const found: ParsedTemplateHeading[] = [];
  for (const [index, line] of lines.entries()) {
    const bracket = line.match(TEMPLATE_BRACKET_HEADING);
    if (bracket !== null) {
      found.push({ name: (bracket[1] ?? bracket[2] ?? "").trim(), inline: (bracket[3] ?? "").trim(), line: index + 1 });
      continue;
    }
    const markdown = line.match(TEMPLATE_MARKDOWN_HEADING);
    if (markdown !== null) found.push({ name: (markdown[1] ?? "").trim(), inline: "", line: index + 1 });
  }
  return found;
}

function templateSections(scope: string, found: readonly ParsedTemplateHeading[]): readonly StoryScopeSection[] {
  const lines = scope.split(/\r?\n/u);
  return found.map((entry, index) => {
    const nextLine = found[index + 1]?.line ?? lines.length + 1;
    const body = [entry.inline, ...lines.slice(entry.line, nextLine - 1)]
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();
    return { heading: entry.name, content: body, line: entry.line };
  });
}

/**
 * Validate an admitted template instance.  `kind` is intentionally absent from
 * this API: template shape is data, while work-graph behaviour remains owned by
 * the protocol kind and the frozen coupling roster in template-admission.ts.
 */
export function validateTemplateScope(scope: unknown, template: ScopeTemplateDefinition): StoryScopeValidation {
  const problems: StoryScopeProblem[] = [];
  if (typeof scope !== "string" || scope.trim().length === 0) {
    return { ok: false, problems: [{ code: "TEMPLATE_SCOPE_REQUIRED", message: "templated work requires a non-empty scope" }], sections: [] };
  }
  const expected = [...template.headings];
  const found = parseTemplateHeadings(scope);
  const counts = new Map<string, number>();
  for (const entry of found) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  for (const heading of expected) {
    const count = counts.get(heading) ?? 0;
    if (count === 0) problems.push({ code: "TEMPLATE_SCOPE_HEADING_MISSING", heading, message: `missing template scope block ${heading}` });
    else if (count > 1) problems.push({ code: "TEMPLATE_SCOPE_HEADING_DUPLICATE", heading, message: `duplicate template scope block ${heading}` });
  }
  for (const entry of found) {
    if (!expected.includes(entry.name)) {
      problems.push({ code: "TEMPLATE_SCOPE_HEADING_UNEXPECTED", heading: entry.name, message: `unexpected template scope block ${entry.name}` });
    }
  }
  if (found.length === expected.length && found.some((entry, index) => entry.name !== expected[index])) {
    problems.push({ code: "TEMPLATE_SCOPE_HEADING_ORDER", message: "template scope blocks must use the admitted order" });
  }
  const sections = templateSections(scope, found);
  for (const section of sections) {
    if (section.content.length === 0) {
      problems.push({ code: "TEMPLATE_SCOPE_SECTION_EMPTY", heading: section.heading, message: `template scope block ${section.heading} is empty` });
    }
  }

  const byHeading = new Map(sections.map((section) => [section.heading, section.content]));
  const acceptanceHeadings = template.acceptanceHeadings ?? ["Acceptance Criteria"];
  const primaryAcceptanceHeading = acceptanceHeadings[0] ?? "Acceptance Criteria";
  const acceptance = acceptanceHeadings.map((heading) => byHeading.get(heading) ?? "").find((content) => content.length > 0) ?? "";
  if (acceptance.length === 0 || (!hasOrderedGwt(acceptance) && !isBulletList(acceptance) && acceptanceHeadings.length === 1 && primaryAcceptanceHeading === "Acceptance Criteria")) {
    problems.push({ code: "TEMPLATE_SCOPE_ACCEPTANCE_INVALID", heading: primaryAcceptanceHeading, message: "template scope lacks an acceptance/expected outcome section" });
  }

  for (const heading of template.referenceHeadings ?? []) {
    const content = byHeading.get(heading) ?? "";
    const values = content.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.some((value) => !TEMPLATE_REFERENCE_VALUE.test(value))) {
      problems.push({ code: "TEMPLATE_SCOPE_REFERENCE_INVALID", heading, message: `${heading} must contain references, not inline secrets or arbitrary text` });
    }
  }
  return { ok: problems.length === 0, problems, sections };
}
