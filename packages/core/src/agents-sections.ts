import { chainIdentity } from "./chain-identity.js";
import { effectiveProjectState } from "./project-chain.js";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-478 R3, R4, R5, AC4, AC5 and the pointer hooks of STORY-477 R3 (MIN-227 D14,
// D17; TCRN-CROSS-SUB-317): the sections the engine keeps in a project's AGENTS.md and CLAUDE.md,
// and what a user may do with one of them.
//
// CLAUDE.md gets one section, claude-import, which holds the line `@AGENTS.md`, and only while the
// file does not import AGENTS.md already: a CLAUDE.md that imports it keeps every byte, and a
// project without a CLAUDE.md gets one that holds that section alone. AGENTS.md may get the
// navigation section, three lines telling an agent that Einzbern manages the project, to load
// Mana Orchestrate and to recall first. Whether it is written is asked once, when Einzbern is
// installed, and kept on the device (agents.navigation, machine-settings.ts). A device that
// declined it gets two pointer hooks instead, on SessionStart and SubagentStart, which hand the
// agent the same three lines (host-hooks.ts, hook-recall.ts). The variable sections of
// variables-sections.ts are AGENTS.md's too, and so are the sections of the Command Spell rules a
// project enabled (rules.ts).
//
// A section the user changed waits (pending) until the user decides what becomes of it:
// overwrite puts the engine's text back and records it as the new baseline; keep records the text
// as it now stands as the user's, and the engine never writes that section again; unmanage takes
// the markers away and leaves the text, which is then the user's alone. Taking a section out of a
// file (disabling it) removes it with its markers, and a section the user changed goes only with
// force. Every write follows the managed-section writer (managed-sections.ts): the file must
// still hold what was read, the original is copied into the device directory's backups first,
// and the file is replaced through a temporary file and a rename. Nothing here runs unless it is
// called, so an engine upgrade writes no file. An entry point that wrote a file and then cannot
// commit the records of what it wrote puts every file it wrote back as it read it before the error
// goes on (TCRN-CROSS-STORY-489), so no file is left holding a section the library never recorded.
//
// TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): those entry points -- agents-render, rule-resolve,
// rule-enable and rule-disable (rules.ts) and the variable sections (variables-sections.ts) -- read
// the library and plan every file outside the library write lock, and hold it for the write alone:
// under it the library must stand where they read it and each file must hold what they read
// (filesAsPlanned), or they read and plan again (workspace.ts, appendPlannedWrite).
//
// TCRN-CROSS-STORY-540 GWT1 (MIN-258 D3(c); TCRN-CROSS-SUB-505): a coordination library's sections go
// the same way, into the project root this device's registry holds for it -- the container it
// coordinates -- and nowhere else (managedOutputBinding).

import { lstat, readFile, realpath } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

import { compareCanonicalText } from "../../protocol/src/index.js";
import { removeConfigRecordDelta, setConfigRecordDelta } from "./config-records.js";
import {
  ManagedSectionError,
  absolutePathLine,
  applyManagedWrite,
  isManagedSectionId,
  managedSectionRecordKey,
  managedSectionRecordsFor,
  parseManagedFile,
  planManagedWrite,
  renderSection,
  revertManagedWrite,
  sectionDigest,
} from "./managed-sections.js";
import type {
  AppliedManagedWrite,
  ManagedSectionRecord,
  ManagedSectionResult,
  ManagedSectionState,
  ManagedWritePlan,
  ParsedManagedFile,
  ParsedSection,
} from "./managed-sections.js";
import type { AgentsNavigationChoice } from "./machine-settings.js";
import { BRAND } from "./names.js";
import { gitTopLevel, readRegistry, resolveLibrary } from "./registry.js";
import type { ResolutionPath } from "./registry.js";
import { BUILT_IN_RULES, builtInRule, ruleBody } from "./rules-catalog.js";
import {
  VARIABLES_CUSTOM_SECTION_ID,
  VARIABLES_SYSTEM_SECTION_ID,
  renderCustomVariablesSection,
  renderSystemVariablesSection,
} from "./variables-sections.js";
import type { WithheldEntry } from "./variables-sections.js";
import { compareRecordOrder } from "./variables.js";
import { appendPlannedWrite, materializeWorkspace, projectConfiguration } from "./workspace.js";
import type { MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const AGENTS_SECTIONS_REASON_CODES = Object.freeze([
  "MANAGED_SECTION_ACTION_INVALID",
  "MANAGED_SECTION_FORCE_REQUIRED",
  "MANAGED_SECTION_NOT_FOUND",
  // TCRN-CROSS-STORY-540 GWT1 (TCRN-CROSS-SUB-505): a project root managed sections may not be
  // written into (managedOutputBinding).
  "MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY",
  "MANAGED_SECTION_OUTPUT_UNREGISTERED",
] as const);

export type AgentsSectionsReasonCode = typeof AGENTS_SECTIONS_REASON_CODES[number];

export class AgentsSectionError extends Error {
  readonly reasonCode: AgentsSectionsReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: AgentsSectionsReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "AgentsSectionError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: AgentsSectionsReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new AgentsSectionError(reasonCode, message, details);
}

export const AGENTS_FILE = "AGENTS.md" as const;
export const CLAUDE_FILE = "CLAUDE.md" as const;
// A rule's section is named rule:<rule id> (TCRN-CROSS-STORY-483).
export const RULE_SECTION_PREFIX = "rule:" as const;

/** A section as the engine writes it: its id, the file it lives in and its text. */
export interface AgentsSection {
  readonly id: string;
  readonly file: string;
  readonly body: string;
}

/** CLAUDE.md's one section: the import of AGENTS.md, written only while CLAUDE.md does not import it (R5). */
export const CLAUDE_IMPORT_SECTION: AgentsSection = Object.freeze({ id: "claude-import", file: CLAUDE_FILE, body: "@AGENTS.md\n" });

/** The three navigation lines (R4): the navigation section's text, and what the pointer hooks print. */
export const NAVIGATION_LINES: readonly string[] = Object.freeze([
  `This project is managed by ${BRAND.engine.name}.`,
  `Load the ${BRAND.helper.name} skill before you start work.`,
  `Recall first: run ${BRAND.engine.name}'s recall for the task before you plan or change anything.`,
]);

/** AGENTS.md's navigation section, written only on a device whose agents.navigation is written. */
export const NAVIGATION_SECTION: AgentsSection = Object.freeze({ id: "navigation", file: AGENTS_FILE, body: `${NAVIGATION_LINES.join("\n")}\n` });

/** The file a section lives in: claude-import is CLAUDE.md's, every other section AGENTS.md's. */
export function managedSectionFile(id: string): string {
  return id === CLAUDE_IMPORT_SECTION.id ? CLAUDE_FILE : AGENTS_FILE;
}

// `@AGENTS.md` or `@./AGENTS.md` as a word of its own, which punctuation may end: what Claude Code
// reads as an import.
const AGENTS_IMPORT = /(?:^|\s)@(?:\.\/)?AGENTS\.md(?=$|\s|[,;:!?)\]]|\.(?:$|\s))/u;
const FENCE = /^(`{3,}|~{3,})/u;

/**
 * Whether a CLAUDE.md text imports AGENTS.md: a line holding `@AGENTS.md` (or `@./AGENTS.md`) as a
 * word of its own, outside a fenced code block and an inline code span, which Claude Code does not
 * read imports from.
 */
export function importsAgents(text: string): boolean {
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const opener = FENCE.exec(line.trimStart())?.[1];
    if (fence !== null) {
      if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener !== undefined) {
      fence = opener;
      continue;
    }
    if (AGENTS_IMPORT.test(line.replace(/`[^`]*`/gu, ""))) return true;
  }
  return false;
}

// The text of a file around its managed sections: whatever the user wrote.
function textOutsideSections(text: string, file: string): string {
  return parseManagedFile(text, file).outside.join("");
}

/**
 * What writing CLAUDE.md's import section would do (R5), without writing: nothing when the text
 * outside the managed sections already imports AGENTS.md, and otherwise the claude-import section,
 * created with the file when there is none and never put back once the user removed it.
 */
export async function planClaudeImport(projectRoot: string, records: readonly ManagedSectionRecord[] = []): Promise<ManagedWritePlan> {
  const filePath = join(projectRoot, CLAUDE_FILE);
  const probe = await planManagedWrite({ filePath, file: CLAUDE_FILE, desired: [], records });
  if (probe.before !== null && importsAgents(textOutsideSections(probe.before, CLAUDE_FILE))) return probe;
  return planManagedWrite({ filePath, file: CLAUDE_FILE, desired: [{ id: CLAUDE_IMPORT_SECTION.id, body: CLAUDE_IMPORT_SECTION.body }], records });
}

export interface ClaudeImportResult {
  readonly file: string;
  readonly written: boolean;
  // Where CLAUDE.md was copied before it was replaced; null when nothing was replaced.
  readonly backupPath: string | null;
  // What became of each section; a caller that keeps records stores the ones that changed.
  readonly sections: ManagedWritePlan["sections"];
}

/**
 * Make CLAUDE.md import AGENTS.md (R5, AC4): a CLAUDE.md that imports it already is left byte for
 * byte, one that does not gets the claude-import section, and a project without a CLAUDE.md gets
 * one that holds that section alone. `records` are the library's managed-section records.
 */
export async function ensureClaudeImport(projectRoot: string, options: {
  readonly at: string;
  readonly records?: readonly ManagedSectionRecord[];
  readonly backupRoot?: string;
}): Promise<ClaudeImportResult> {
  const plan = await planClaudeImport(projectRoot, options.records ?? []);
  const applied = await applyManagedWrite(plan, { now: options.at, ...(options.backupRoot === undefined ? {} : { backupRoot: options.backupRoot }) });
  return { file: CLAUDE_FILE, written: applied.written, backupPath: applied.backupPath, sections: plan.sections };
}

// ---- One section: the three dispositions and disabling (R3) ----

export type SectionAction = "overwrite" | "keep" | "unmanage";
export const SECTION_ACTIONS: readonly SectionAction[] = Object.freeze(["overwrite", "keep", "unmanage"]);

export type SectionChangeResult = "overwritten" | "kept" | "unmanaged" | "disabled" | "unchanged";

/** What one disposition or one disabling did to a section. */
export interface SectionChange {
  readonly file: string;
  readonly id: string;
  readonly action: SectionAction | "disable";
  readonly result: SectionChangeResult;
  readonly written: boolean;
  // Where the file was copied before it was replaced; null when nothing was replaced.
  readonly backupPath: string | null;
  // The section's record afterwards: null once the section is no longer recorded (disabled).
  readonly record: ManagedSectionRecord | null;
  readonly recordChanged: boolean;
}

interface SectionInFile {
  readonly file: string;
  readonly filePath: string;
  readonly text: string | null;
  readonly parsed: ParsedManagedFile | null;
  readonly index: number;
  readonly section: ParsedSection | null;
  readonly record: ManagedSectionRecord | undefined;
}

async function readSectionFile(filePath: string, file: string): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") throw new ManagedSectionError("MANAGED_SECTION_FILE_UNSUPPORTED", `${file}: a parent of it is not a directory`, { file });
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ManagedSectionError("MANAGED_SECTION_FILE_UNSUPPORTED", `${file} is not a regular file; managed sections are written into regular files only`, { file });
  }
  const bytes = await readFile(filePath);
  if (!isUtf8(bytes)) throw new ManagedSectionError("MANAGED_SECTION_FILE_UNSUPPORTED", `${file} is not UTF-8 text`, { file });
  return bytes.toString("utf8");
}

async function locateSection(projectRoot: string, id: string, records: readonly ManagedSectionRecord[]): Promise<SectionInFile> {
  if (!isManagedSectionId(id)) throw new ManagedSectionError("MANAGED_SECTION_INPUT_INVALID", `${String(id)} is not a section id`, { id: String(id) });
  const file = managedSectionFile(id);
  const filePath = join(projectRoot, file);
  const text = await readSectionFile(filePath, file);
  const parsed = text === null ? null : parseManagedFile(text, file);
  const index = parsed === null ? -1 : parsed.sections.findIndex((section) => section.id === id);
  return {
    file,
    filePath,
    text,
    parsed,
    index,
    section: parsed === null || index === -1 ? null : parsed.sections[index] ?? null,
    record: records.find((record) => record.file === file && record.id === id),
  };
}

// Whether the user changed a section: its text no longer matches the digest its marker or its
// record carries, or its record already says the user changed it, kept it or took it over.
function userModified(section: ParsedSection, record: ManagedSectionRecord | undefined): boolean {
  if (section.digest !== section.bodyDigest) return true;
  if (record === undefined) return false;
  return record.digest !== section.digest || record.state === "pending" || record.state === "user-owned" || record.state === "unmanaged";
}

// The file with one section's bytes replaced by `replacement`. A section taken out altogether
// takes one blank line with it, the one the writer put beside it: the one after it, or, at the end
// of the file, the one before it.
function replaceSection(parsed: ParsedManagedFile, index: number, replacement: string): string {
  const outside = [...parsed.outside];
  if (replacement === "") {
    const blank = `${parsed.eol}${parsed.eol}`;
    const before = outside[index] ?? "";
    const after = outside[index + 1] ?? "";
    if ((before === "" || before.endsWith(blank)) && after.startsWith(parsed.eol)) {
      outside[index + 1] = after.slice(parsed.eol.length);
    } else if (after === "" && index === parsed.sections.length - 1 && before.endsWith(blank)) {
      outside[index] = before.slice(0, -parsed.eol.length);
    }
  }
  const parts: string[] = [];
  for (const [position, section] of parsed.sections.entries()) {
    parts.push(outside[position] ?? "");
    parts.push(position === index ? replacement : section.raw);
  }
  parts.push(outside[parsed.sections.length] ?? "");
  return parts.join("");
}

// A section file written as `after`: what the write did, and the plan it wrote, which is what an
// entry point puts back when it cannot record the change (TCRN-CROSS-STORY-489).
interface SectionWrite {
  readonly plan: ManagedWritePlan;
  readonly applied: AppliedManagedWrite;
}

function sameRecord(left: ManagedSectionRecord | undefined, right: ManagedSectionRecord | null): boolean {
  if (left === undefined || right === null) return left === undefined && right === null;
  return left.file === right.file && left.id === right.id && left.rev === right.rev && left.digest === right.digest && left.state === right.state;
}

/**
 * What one disposition or one disabling would do, planned without writing (TCRN-CROSS-SUB-499): the
 * section as its file held it, the plan that writes the file (one that writes nothing when the file
 * stays as it is; its `before` is the file as read) and the record the section would then have.
 * writeSectionPlan carries it out; an entry point that plans outside the library write lock checks
 * under it that the file still holds the plan's `before` (filesAsPlanned) before it does.
 */
export interface SectionPlan {
  readonly located: SectionInFile;
  readonly id: string;
  readonly action: SectionAction | "disable";
  readonly done: SectionChangeResult;
  readonly plan: ManagedWritePlan;
  readonly record: ManagedSectionRecord | null;
  // Whether `record` differs from the record the section had: what the entry point records.
  readonly recordChanged: boolean;
}

// The plan of one disposition or disabling: to write `after` over the file as `located` read it, or,
// when `after` is null, to leave it as it is.
function sectionPlan(located: SectionInFile, id: string, action: SectionAction | "disable", done: SectionChangeResult, after: string | null, record: ManagedSectionRecord | null): SectionPlan {
  return {
    located,
    id,
    action,
    done,
    plan: {
      filePath: located.filePath,
      file: located.file,
      exists: located.text !== null,
      before: located.text,
      after,
      write: after !== null,
      sections: [],
      pending: [],
    },
    record,
    recordChanged: !sameRecord(located.record, record),
  };
}

/** Carry out a section's plan: write its file when the plan writes one, and say what that did. */
export async function writeSectionPlan(planned: SectionPlan, at: string, backupRoot: string | undefined): Promise<SectionOutcome> {
  const write = planned.plan.write
    ? { plan: planned.plan, applied: await applyManagedWrite(planned.plan, { now: at, ...(backupRoot === undefined ? {} : { backupRoot }) }) }
    : null;
  return change(planned.located, planned.id, planned.action, planned.done, write, planned.record);
}

/**
 * TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): whether every file `plans` read still holds what it
 * read (ManagedWritePlan.before; no file, for one that was not there). An entry point that read and
 * planned outside the library write lock checks this under it, beside the library's streams
 * (workspace.ts, appendPlannedWrite), before it writes a file, so it never writes over a change made
 * since it read: it plans again instead. A file that cannot be read now is taken to have changed, so
 * the plan made again meets it and refuses it as the plan would have.
 */
export async function filesAsPlanned(plans: readonly ManagedWritePlan[]): Promise<boolean> {
  for (const plan of plans) {
    try {
      if (await readSectionFile(plan.filePath, plan.file) !== plan.before) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * What one disposition or one disabling did, and the plan it wrote (null when it wrote nothing):
 * what a caller that then cannot record the change puts back (putBackUnrecorded;
 * TCRN-CROSS-STORY-489).
 */
export interface SectionOutcome {
  readonly change: SectionChange;
  readonly wrote: ManagedWritePlan | null;
}

function change(located: SectionInFile, id: string, action: SectionAction | "disable", done: SectionChangeResult, write: SectionWrite | null, record: ManagedSectionRecord | null): SectionOutcome {
  const recordChanged = !sameRecord(located.record, record);
  const written = write?.applied.written ?? false;
  return {
    change: {
      file: located.file,
      id,
      action,
      result: written || recordChanged ? done : "unchanged",
      written,
      backupPath: write?.applied.backupPath ?? null,
      record,
      recordChanged,
    },
    wrote: written && write !== null ? write.plan : null,
  };
}

export interface ResolveSectionInput {
  readonly projectRoot: string;
  readonly id: string;
  readonly action: SectionAction;
  // Needed to overwrite a section the user kept (user-owned) or took over (unmanaged).
  readonly force?: boolean;
  // The library's managed-section records; those of other files and sections are ignored.
  readonly records: readonly ManagedSectionRecord[];
  // The engine's text for the section: what overwrite writes. Only overwrite needs it.
  readonly body?: string;
  readonly at: string;
  readonly backupRoot?: string;
}

/**
 * Settle a section that waits for the user (R3): overwrite writes the engine's text in its place
 * and records it as the new baseline; keep records the text now in the file as the user's
 * (user-owned) without writing, and the engine never writes the section again; unmanage takes its
 * two markers out, leaves the text between them, and records the section as unmanaged. The
 * section's markers must be in the file (MANAGED_SECTION_NOT_FOUND otherwise), and overwriting a
 * section the user kept or took over needs force (MANAGED_SECTION_FORCE_REQUIRED). Returns the
 * record to store.
 */
export async function resolveSection(input: ResolveSectionInput): Promise<SectionChange> {
  return (await writeSectionPlan(await planSettleSection(input), input.at, input.backupRoot)).change;
}

// resolveSection, planned without writing (TCRN-CROSS-SUB-499): what it would write and record.
async function planSettleSection(input: ResolveSectionInput): Promise<SectionPlan> {
  if (!SECTION_ACTIONS.includes(input.action)) {
    fail("MANAGED_SECTION_ACTION_INVALID", `action must be one of ${SECTION_ACTIONS.join(", ")}`, { section: String(input.id), action: String(input.action) });
  }
  const located = await locateSection(input.projectRoot, input.id, input.records);
  const { file, parsed, section, record, index } = located;
  if (parsed === null || section === null) {
    fail("MANAGED_SECTION_NOT_FOUND", `${file} holds no section ${input.id} to ${input.action}`, { file, section: input.id });
  }
  if (input.action === "keep") {
    return sectionPlan(located, input.id, "keep", "kept", null, { file, id: input.id, rev: section.rev, digest: section.bodyDigest, state: "user-owned" });
  }
  if (input.action === "unmanage") {
    const kept: ManagedSectionRecord = { file, id: input.id, rev: record?.rev ?? section.rev, digest: record?.digest ?? section.digest, state: "unmanaged" };
    return sectionPlan(located, input.id, "unmanage", "unmanaged", replaceSection(parsed, index, section.body), kept);
  }
  const body = input.body;
  if (body === undefined) {
    fail("MANAGED_SECTION_ACTION_INVALID", `overwrite needs the engine's text for section ${input.id}`, { file, section: input.id, action: "overwrite" });
  }
  const line = absolutePathLine(body);
  if (line !== null) {
    throw new ManagedSectionError("MANAGED_SECTION_ABSOLUTE_PATH", `section ${input.id} would write an absolute path (its line ${line}); managed sections render none`, { file, id: input.id, line: String(line) });
  }
  if ((record?.state === "user-owned" || record?.state === "unmanaged") && input.force !== true) {
    fail("MANAGED_SECTION_FORCE_REQUIRED", `the user kept section ${input.id} of ${file}; overwriting it needs force`, { file, section: input.id, state: record.state });
  }
  const digest = sectionDigest(body);
  if (!userModified(section, record) && section.bodyDigest === digest) {
    return sectionPlan(located, input.id, "overwrite", "overwritten", null, { file, id: input.id, rev: section.rev, digest, state: "managed" });
  }
  const rev = Math.max(section.rev, record?.rev ?? 0) + 1;
  return sectionPlan(located, input.id, "overwrite", "overwritten", replaceSection(parsed, index, renderSection({ id: input.id, rev, body }, parsed.eol)), { file, id: input.id, rev, digest, state: "managed" });
}

export interface DisableSectionInput {
  readonly projectRoot: string;
  readonly id: string;
  // Needed to take out a section the user changed.
  readonly force?: boolean;
  readonly records: readonly ManagedSectionRecord[];
  readonly at: string;
  readonly backupRoot?: string;
}

/**
 * Take a section out of its file, markers and text together, and stop recording it; a section
 * the user changed (its text differs from what the engine wrote, or it waits, or the user kept
 * it) goes only with force, and MANAGED_SECTION_FORCE_REQUIRED otherwise. A section that is not in
 * the file only loses its record: text the user took over stays where it is.
 */
export async function disableSection(input: DisableSectionInput): Promise<SectionChange> {
  return (await writeSectionPlan(await planSectionTakeOut(input), input.at, input.backupRoot)).change;
}

/**
 * disableSection, planned without writing (TCRN-CROSS-SUB-499): for a caller that records the change
 * itself, disableAgentsSection here and disableRule in rules.ts. It plans outside the library write
 * lock, writes the plan under it (writeSectionPlan) and puts the file back when it cannot record the
 * change (TCRN-CROSS-STORY-489).
 */
export async function planSectionTakeOut(input: DisableSectionInput): Promise<SectionPlan> {
  const located = await locateSection(input.projectRoot, input.id, input.records);
  const { file, parsed, section, record, index } = located;
  if (parsed === null || section === null) return sectionPlan(located, input.id, "disable", "disabled", null, null);
  if (userModified(section, record) && input.force !== true) {
    fail("MANAGED_SECTION_FORCE_REQUIRED", `section ${input.id} of ${file} was changed by the user; disabling it needs force`, {
      file,
      section: input.id,
      state: record?.state === "managed" || record === undefined ? "user-modified" : record.state,
    });
  }
  return sectionPlan(located, input.id, "disable", "disabled", replaceSection(parsed, index, ""), null);
}

// ---- The engine's sections and a library's records of them ----

/** A project whose sections are rendered: its root, and the library this device keeps its records in. */
export interface AgentsProject {
  readonly projectRoot: string;
  readonly libraryPath: string;
  readonly via: ResolutionPath;
  readonly projectId?: string;
}

// ---- Where managed sections may be written (TCRN-CROSS-STORY-540 GWT1) ----

/** Whether a library's managed sections have a root to go to on this device (managedOutputBinding). */
export type ManagedOutputBinding = "bound" | "unconfigured";

// Whether `path` is a library in `libraries` or lies within one.
function insideLibrary(path: string, libraries: readonly string[]): boolean {
  return libraries.some((library) => {
    const relation = relative(library, path);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  });
}

/**
 * Where a library's managed sections may be written, checked by every entry point that writes them
 * (agents-render, rule-resolve, rule-enable, rule-disable and the variable sections), even for a direct
 * caller. A project root is never the library or a directory within it
 * (MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY).
 *
 * TCRN-CROSS-STORY-540 GWT1 (MIN-258 D3(c), which replaces MIN-245 D6; TCRN-CROSS-SUB-505): a
 * coordination library is a destination too, for the project root this device's registry holds for
 * it -- the container it coordinates -- and for no other directory. Its roots are the project paths
 * the registry records for the library that lie within no library the registry knows, the library's
 * own included. With such a root, `projectRoot` must be one of them: within a library it is refused
 * as above, and any other directory with MANAGED_SECTION_OUTPUT_UNREGISTERED. Without one (a
 * coordination library registered only as its own project path, or not at all) the binding is
 * unconfigured: rule-enable and rule-disable then record the rule alone, as before, and every other
 * entry point refuses (assertManagedOutputRoot). A project library is bound wherever it is not refused.
 * `home` is the device directory whose registry is read: this process's by default, setup's own
 * when setup plans (TCRN-CROSS-SUB-507, setup-fresh.ts).
 */
export async function managedOutputBinding(libraryRoot: string, projectRoot: string, state: Pick<WorkspaceState, "configRecords" | "metadata">, home?: string): Promise<ManagedOutputBinding> {
  const library = await realpath(libraryRoot);
  const project = await realpath(projectRoot);
  const insideRefusal = (): never => fail("MANAGED_SECTION_OUTPUT_INSIDE_LIBRARY", `managed prose cannot be written inside a library: ${project} is ${library} or lies within a library`, {
    library,
    project,
  });
  if (chainIdentity(state)?.role !== "coordination") {
    if (insideLibrary(project, [library])) insideRefusal();
    return "bound";
  }
  const registry = await readRegistry(home);
  const libraries = [library, ...registry.entries.map((entry) => entry.libraryPath)];
  const roots = registry.entries
    .filter((entry) => entry.libraryId === state.metadata.workspaceId && !insideLibrary(entry.projectPath, libraries))
    .map((entry) => entry.projectPath);
  if (roots.length === 0) return "unconfigured";
  if (insideLibrary(project, libraries)) insideRefusal();
  if (!roots.includes(project)) {
    fail("MANAGED_SECTION_OUTPUT_UNREGISTERED", `the coordination library ${state.metadata.workspaceId} writes managed sections only into the project root this device registered for it, not ${project}`, {
      library,
      project,
      remedy: "library-register",
    });
  }
  return "bound";
}

/**
 * Refuse a project root managed sections may not be written into (managedOutputBinding): within a
 * library, not the root this device registered for a coordination library, or for a coordination
 * library this device registered no root for (MANAGED_SECTION_OUTPUT_UNREGISTERED).
 */
export async function assertManagedOutputRoot(libraryRoot: string, projectRoot: string, state: Pick<WorkspaceState, "configRecords" | "metadata">): Promise<void> {
  if (await managedOutputBinding(libraryRoot, projectRoot, state) === "unconfigured") {
    fail("MANAGED_SECTION_OUTPUT_UNREGISTERED", `the coordination library ${state.metadata.workspaceId} has no project root registered on this device outside a library, so its managed sections have nowhere to go`, {
      library: await realpath(libraryRoot),
      project: await realpath(projectRoot),
      remedy: "library-register",
    });
  }
}

/**
 * The project a directory belongs to, as this device's registry resolves it (TCRN-CROSS-STORY-470
 * R1): the registered project that holds the directory, or, for another clone of it found through
 * its remote, that clone's working tree. LIBRARY_NOT_REGISTERED when the registry names none.
 */
export async function resolveAgentsProject(directory: string): Promise<AgentsProject> {
  const resolved = await resolveLibrary(directory);
  let projectRoot = resolved.entry.projectPath;
  if (resolved.via === "git-remote") {
    const top = gitTopLevel(await realpath(resolve(directory)));
    if (top !== null) projectRoot = await realpath(top);
  }
  return { projectRoot, libraryPath: resolved.libraryPath, via: resolved.via, ...(resolved.entry.projectId === undefined ? {} : { projectId: resolved.entry.projectId }) };
}

// The language a project writes its artifacts in, which picks a rule's text (rules-catalog.ts).
function artifactLanguage(state: Pick<WorkspaceState, "settings">): string | null {
  return state.settings.find((setting) => setting.key === "artifact.language")?.value ?? null;
}

/**
 * The engine's text for a section as the library now stands, or null when the engine writes no
 * section by that id: the import and navigation sections, the two variable sections, and a
 * built-in rule's section in the project's artifact language.
 */
export function engineSectionBody(state: Pick<WorkspaceState, "settings" | "configRecords">, id: string): string | null {
  if (id === CLAUDE_IMPORT_SECTION.id) return CLAUDE_IMPORT_SECTION.body;
  if (id === NAVIGATION_SECTION.id) return NAVIGATION_SECTION.body;
  if (id === VARIABLES_SYSTEM_SECTION_ID) return renderSystemVariablesSection(state).body;
  if (id === VARIABLES_CUSTOM_SECTION_ID) return renderCustomVariablesSection(state).body;
  if (id.startsWith(RULE_SECTION_PREFIX)) {
    const rule = builtInRule(id.slice(RULE_SECTION_PREFIX.length));
    return rule === null ? null : ruleBody(rule.id, artifactLanguage(state));
  }
  return null;
}

function recordDeltas(changes: readonly { readonly file: string; readonly id: string; readonly record: ManagedSectionRecord | null; readonly recordChanged: boolean; readonly hadRecord: boolean }[], projectId?: string): readonly ((state: WorkspaceState) => MutationDelta)[] {
  return changes.filter((entry) => entry.recordChanged).flatMap((entry) => {
    const key = managedSectionRecordKey(entry.file, entry.id);
    if (entry.record !== null) return [setConfigRecordDelta({ ...(projectId === undefined ? {} : { projectId }), collection: "managed-section", key, value: entry.record })];
    return entry.hadRecord ? [removeConfigRecordDelta({ ...(projectId === undefined ? {} : { projectId }), collection: "managed-section", key })] : [];
  });
}

/**
 * TCRN-CROSS-SUB-499: under the library write lock, append the records a write planned (`append`,
 * from workspace.ts appendPlannedWrite, which built them outside the lock) and project the library's
 * configuration after them. A plan of `deltas` = 0 records nothing and projects nothing.
 */
export async function commitPlanned(root: string, append: () => Promise<WorkspaceState>, deltas: number): Promise<WorkspaceState> {
  const committed = await append();
  if (deltas > 0) await projectConfiguration(root, committed);
  return committed;
}

/**
 * TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366): what an entry point does when it wrote files and then
 * cannot commit their records, before the error goes on as it was thrown. `root` and `state` are
 * the library as the entry point read it, which its write lock then found unmoved (TCRN-CROSS-SUB-499,
 * workspace.ts appendPlannedWrite), and the put-back runs under that lock. Each file it wrote goes
 * back to what its plan read (ManagedWritePlan.before), the last written first, and a file it
 * created is taken away, so no file is left holding a section the library never recorded, which
 * the next render would take for the user's change. When the library
 * shows the records went in all the same (a crash simulated after the event commit), the files
 * already agree with it and stay as written. The put-back is best effort: a file changed again
 * since it was written, or one that cannot be written, is left as it is, and a replaced file's
 * original is still in the backup the write made. The entry points here share it with enableRule
 * and disableRule (rules.ts) and writeVariablesSections (variables-sections.ts). Each call puts
 * back only what it wrote: rule-resolve's resolveAgentsSection and the enableRule that follows it
 * are two calls, and a failure of the second leaves what the first wrote and recorded.
 */
export async function putBackUnrecorded(root: string, state: WorkspaceState, wrote: readonly ManagedWritePlan[]): Promise<void> {
  if (wrote.length === 0 || await recordedSince(root, state)) return;
  for (const plan of [...wrote].reverse()) {
    try {
      await revertManagedWrite(plan);
    } catch {
      // The caller learns the error that stopped the entry point, not this one.
    }
  }
}

// Whether the library, read again, has moved past `state`. One that cannot be read is taken not to
// have: an append commits in one step, the rename of its stream manifest (akasha.ts), and every
// refusal comes before that step, so a failed append appended nothing but for the simulated crash.
async function recordedSince(root: string, state: WorkspaceState): Promise<boolean> {
  try {
    return (await materializeWorkspace(root)).headEventHash !== state.headEventHash;
  } catch {
    return false;
  }
}

/** One section after a render: where it is, what the render did and the state its record now holds. */
export interface RenderedSection {
  readonly id: string;
  readonly file: string;
  readonly result: ManagedSectionResult;
  readonly state: ManagedSectionState;
  readonly line: number | null;
}

export interface RenderedFile {
  readonly file: string;
  readonly written: boolean;
  readonly backupPath: string | null;
}

export interface AgentsRenderResult {
  readonly projectRoot: string;
  readonly navigation: AgentsNavigationChoice | null;
  readonly files: readonly RenderedFile[];
  readonly sections: readonly RenderedSection[];
  // The sections the user changed, left as they are until rule-resolve settles them.
  readonly pending: readonly { readonly id: string; readonly file: string }[];
  // The directory the originals were copied to before they were replaced; null when none was.
  readonly backupDir: string | null;
  // What the variable sections left out, and why (variables-sections.ts).
  readonly withheld: readonly WithheldEntry[];
  // The records the render changed, and the library after they were recorded.
  readonly recorded: number;
  readonly state: WorkspaceState;
}

// ---- The order of the rule sections (TCRN-CROSS-STORY-508 R7) ----

/** The order each rule's record holds, by rule id; a rule whose record holds none is not in it. */
export function ruleOrders(state: Pick<WorkspaceState, "configRecords">): ReadonlyMap<string, number> {
  const orders = new Map<string, number>();
  for (const record of state.configRecords) {
    if (record.collection === "rule" && typeof record.value.order === "number") orders.set(record.key, record.value.order);
  }
  return orders;
}

// How two rules compare in AGENTS.md: a rule whose record holds an order goes first, by order; the
// rules without one follow in catalog order, and a rule this engine does not ship after them, by id.
function compareRules(orders: ReadonlyMap<string, number>): (left: string, right: string) => number {
  const place = (id: string): number => {
    const index = BUILT_IN_RULES.findIndex((rule) => rule.id === id);
    return index === -1 ? BUILT_IN_RULES.length : index;
  };
  return (left, right) => compareRecordOrder({ order: orders.get(left) }, { order: orders.get(right) }) || place(left) - place(right) || compareCanonicalText(left, right);
}

/**
 * A write plan for AGENTS.md whose rule sections stand in the rules' order. The places the rule
 * sections hold in the file stay where they are, and so does every byte around them: the sections
 * are arranged across those places, each moved as a whole. A section the engine may not write (the
 * user changed it, it waits, or the user kept it or took it over) keeps its own place, and the others
 * fill the remaining places in order. While no rule holds an order nothing is arranged, so a library
 * without orders renders as it did before. A plan that writes nothing gets a write when the file's
 * rule sections are out of order.
 */
export function orderRuleSections(plan: ManagedWritePlan, orders: ReadonlyMap<string, number>): ManagedWritePlan {
  const text = plan.write ? plan.after : plan.before;
  if (text === null || orders.size === 0) return plan;
  const parsed = parseManagedFile(text, plan.file);
  // The records as the plan leaves them: a section it refused over the user's change is pending.
  const records = new Map(plan.sections.map((decision) => [decision.id, decision.record]));
  const places = parsed.sections.flatMap((section, index) =>
    section.id.startsWith(RULE_SECTION_PREFIX) && !userModified(section, records.get(section.id)) ? [index] : []);
  const compare = compareRules(orders);
  const ruleId = (section: ParsedSection): string => section.id.slice(RULE_SECTION_PREFIX.length);
  const arranged = places.map((index) => parsed.sections[index]!).sort((left, right) => compare(ruleId(left), ruleId(right)));
  if (arranged.every((section, position) => section === parsed.sections[places[position]!])) return plan;
  const placed = new Map(places.map((index, position) => [index, arranged[position]!]));
  let after = "";
  for (const [index, section] of parsed.sections.entries()) {
    after += parsed.outside[index] ?? "";
    const moved = placed.get(index) ?? section;
    // Only the file's last line may lack its line ending; a section moved off that line gets one.
    after += moved !== section && !moved.raw.endsWith("\n") ? `${moved.raw}${parsed.eol}` : moved.raw;
  }
  after += parsed.outside[parsed.sections.length] ?? "";
  return { ...plan, after, write: true };
}

// The sections of the Command Spell rules the library has enabled (TCRN-CROSS-STORY-483, rules.ts),
// in the rules' order (compareRules: catalog order while no rule holds an order) and in the
// project's artifact language. A rule enabled at a version other than the one this engine ships is
// left as the file holds it: an older engine does not write its text over a newer one, and a newer
// version waits for rule-enable (update-available).
function enabledRuleSections(state: Pick<WorkspaceState, "settings" | "configRecords">): readonly AgentsSection[] {
  const language = artifactLanguage(state);
  const compare = compareRules(ruleOrders(state));
  return BUILT_IN_RULES.flatMap((rule) => {
    const record = state.configRecords.find((entry) => entry.collection === "rule" && entry.key === rule.id)?.value;
    if (record?.enabled !== true || record.version !== rule.version) return [];
    return [{ id: `${RULE_SECTION_PREFIX}${rule.id}`, file: AGENTS_FILE, body: ruleBody(rule.id, language) }];
  }).sort((left, right) => compare(left.id.slice(RULE_SECTION_PREFIX.length), right.id.slice(RULE_SECTION_PREFIX.length)));
}

/**
 * The sections the engine writes into AGENTS.md for a device whose navigation choice is
 * `navigation`: the navigation section on a device that chose written, the two variable sections,
 * and the section of every rule the library has enabled at the version this engine ships.
 */
export function agentsFileSections(state: Pick<WorkspaceState, "settings" | "configRecords">, navigation: AgentsNavigationChoice | null): {
  readonly sections: readonly AgentsSection[];
  readonly withheld: readonly WithheldEntry[];
} {
  const system = renderSystemVariablesSection(state);
  const custom = renderCustomVariablesSection(state);
  return {
    sections: [
      ...(navigation === "written" ? [NAVIGATION_SECTION] : []),
      { id: system.id, file: AGENTS_FILE, body: system.body },
      { id: custom.id, file: AGENTS_FILE, body: custom.body },
      ...enabledRuleSections(state),
    ],
    withheld: [...system.withheld, ...custom.withheld],
  };
}

/**
 * Render the engine's sections into a project's AGENTS.md and CLAUDE.md against the library's
 * records, and record each section record the render changed (R2, R4, R5). AGENTS.md gets the
 * variable sections, the sections of the rules the library has enabled, and the navigation
 * section when this device's choice is written; CLAUDE.md
 * gets its import section unless it imports AGENTS.md already. Both files are planned before
 * either is written, so a file whose markers do not parse refuses the whole render. A section the
 * user changed is left as it is and goes pending; one the user removed is not put back; a section
 * the engine does not render (a navigation section another device wrote) is left alone. A render
 * whose records cannot be committed, or whose second file cannot be written, returns each file it
 * wrote to what it read before the error goes on (TCRN-CROSS-STORY-489).
 *
 * TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): the library is read and both files planned outside
 * the library write lock; under it the files are written and the records appended only while the
 * library stands where it was read and both files hold what was read, and the render is planned
 * again otherwise (workspace.ts, appendPlannedWrite).
 */
export async function renderAgentsSections(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly navigation: AgentsNavigationChoice | null;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<AgentsRenderResult> {
  return appendPlannedWrite(workspaceRoot, input, {
    plan: async (root, nativeState) => {
      await assertManagedOutputRoot(root, input.projectRoot, nativeState);
      const state = await effectiveProjectState(nativeState, input.configurationProjectId);
      const agents = agentsFileSections(state, input.navigation);
      const plans = [
        // TCRN-CROSS-STORY-508 R7: with the rule sections in the rules' order.
        orderRuleSections(await planManagedWrite({
          filePath: join(input.projectRoot, AGENTS_FILE),
          file: AGENTS_FILE,
          desired: agents.sections.map((section) => ({ id: section.id, body: section.body })),
          records: managedSectionRecordsFor(state, AGENTS_FILE),
        }), ruleOrders(state)),
        await planClaudeImport(input.projectRoot, managedSectionRecordsFor(state, CLAUDE_FILE)),
      ];
      const decisions = plans.flatMap((plan) => plan.sections.map((decision) => ({ plan, decision })));
      const deltas = recordDeltas(decisions.map(({ plan, decision }) => ({ file: plan.file, id: decision.id, record: decision.record, recordChanged: decision.recordChanged, hadRecord: true })), input.configurationProjectId);
      return { deltas, plan: { withheld: agents.withheld, plans, decisions, recorded: deltas.length } };
    },
    unchanged: ({ plans }) => filesAsPlanned(plans),
    write: async (root, nativeState, { withheld, plans, decisions, recorded }, append) => {
      const files: RenderedFile[] = [];
      const wrote: ManagedWritePlan[] = [];
      let committed: WorkspaceState;
      try {
        for (const plan of plans) {
          const applied = await applyManagedWrite(plan, { now: input.occurredAt, ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }) });
          if (applied.written) wrote.push(plan);
          files.push({ file: plan.file, written: applied.written, backupPath: applied.backupPath });
        }
        committed = await commitPlanned(root, append, recorded);
      } catch (error) {
        // TCRN-CROSS-STORY-489: this also takes back the first file when the second cannot be written.
        await putBackUnrecorded(root, nativeState, wrote);
        throw error;
      }
      const backup = files.find((file) => file.backupPath !== null)?.backupPath ?? null;
      return {
        projectRoot: input.projectRoot,
        navigation: input.navigation,
        files,
        sections: decisions.map(({ plan, decision }) => ({ id: decision.id, file: plan.file, result: decision.result, state: decision.record.state, line: decision.line })),
        pending: plans.flatMap((plan) => plan.pending.map((id) => ({ id, file: plan.file }))),
        backupDir: backup === null ? null : dirname(backup),
        withheld,
        recorded,
        state: committed,
      };
    },
  });
}

export interface AgentsSectionChangeResult {
  readonly change: SectionChange;
  readonly state: WorkspaceState;
}

// TCRN-CROSS-SUB-499: one section's change, planned outside the library write lock, written and
// recorded under it, and its file put back when the record cannot be committed (TCRN-CROSS-STORY-489).
// What resolveAgentsSection and disableAgentsSection share once each has planned its change.
async function changeAgentsSection(workspaceRoot: string, input: { readonly projectRoot: string; readonly backupRoot?: string } & WorkspaceMutationOptions,
  planChange: (state: WorkspaceState, records: readonly ManagedSectionRecord[], file: string) => Promise<SectionPlan>, id: string): Promise<AgentsSectionChangeResult> {
  return appendPlannedWrite(workspaceRoot, input, {
    plan: async (root, nativeState) => {
      await assertManagedOutputRoot(root, input.projectRoot, nativeState);
      const state = await effectiveProjectState(nativeState, input.configurationProjectId);
      const file = managedSectionFile(id);
      const records = managedSectionRecordsFor(state, file);
      const planned = await planChange(state, records, file);
      const hadRecord = records.some((record) => record.id === id);
      const deltas = recordDeltas([{ file, id, record: planned.record, recordChanged: planned.recordChanged, hadRecord }], input.configurationProjectId);
      return { deltas, plan: { planned, recorded: deltas.length } };
    },
    unchanged: ({ planned }) => filesAsPlanned([planned.plan]),
    write: async (root, nativeState, { planned, recorded }, append) => {
      const { change: outcome, wrote } = await writeSectionPlan(planned, input.occurredAt, input.backupRoot);
      try {
        return { change: outcome, state: await commitPlanned(root, append, recorded) };
      } catch (error) {
        await putBackUnrecorded(root, nativeState, wrote === null ? [] : [wrote]);
        throw error;
      }
    },
  });
}

/**
 * Settle one section of a project against the library (R3): resolveSection with the library's
 * records and, for overwrite, the engine's text as the library now stands; the record it leaves is
 * recorded in the library. An id the engine writes no text for cannot be overwritten. When that
 * record cannot be committed, the file returns to what it held before the error goes on
 * (TCRN-CROSS-STORY-489). TCRN-CROSS-SUB-499: planned outside the library write lock, and written
 * under it only while the library and the file stand as they were read.
 */
export async function resolveAgentsSection(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly id: string;
  readonly action: SectionAction;
  readonly force?: boolean;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<AgentsSectionChangeResult> {
  return changeAgentsSection(workspaceRoot, input, async (state, records, file) => {
    let body: string | undefined;
    if (input.action === "overwrite") {
      body = engineSectionBody(state, input.id) ?? fail("MANAGED_SECTION_ACTION_INVALID", `the engine writes no section ${input.id}, so there is no text to overwrite it with`, {
        file,
        section: input.id,
        action: "overwrite",
      });
    }
    return planSettleSection({
      projectRoot: input.projectRoot,
      id: input.id,
      action: input.action,
      records,
      at: input.occurredAt,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(body === undefined ? {} : { body }),
      ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    });
  }, input.id);
}

/**
 * Take one section out of a project's file and remove its record from the library (disableSection).
 * When the record cannot be removed, the file returns to what it held, the section in it, before
 * the error goes on (TCRN-CROSS-STORY-489). TCRN-CROSS-SUB-499: planned outside the library write
 * lock, and written under it only while the library and the file stand as they were read.
 */
export async function disableAgentsSection(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly id: string;
  readonly force?: boolean;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<AgentsSectionChangeResult> {
  return changeAgentsSection(workspaceRoot, input, (_state, records) => planSectionTakeOut({
    projectRoot: input.projectRoot,
    id: input.id,
    records,
    at: input.occurredAt,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
  }), input.id);
}
