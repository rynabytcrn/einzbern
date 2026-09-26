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
// variables-sections.ts are AGENTS.md's too.
//
// A section the user changed waits (pending) until the user decides what becomes of it:
// overwrite puts the engine's text back and records it as the new baseline; keep records the text
// as it now stands as the user's, and the engine never writes that section again; unmanage takes
// the markers away and leaves the text, which is then the user's alone. Taking a section out of a
// file (disabling it) removes it with its markers, and a section the user changed goes only with
// force. Every write follows the managed-section writer (managed-sections.ts): the file must
// still hold what was read, the original is copied into the device directory's backups first,
// and the file is replaced through a temporary file and a rename. Nothing here runs unless it is
// called, so an engine upgrade writes no file.

import { lstat, readFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { dirname, join } from "node:path";

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
import { builtInRule, ruleBody } from "./rules-catalog.js";
import {
  VARIABLES_CUSTOM_SECTION_ID,
  VARIABLES_SYSTEM_SECTION_ID,
  renderCustomVariablesSection,
  renderSystemVariablesSection,
} from "./variables-sections.js";
import type { WithheldEntry } from "./variables-sections.js";
import { appendEvents, materializeWorkspace, projectConfiguration, withWorkspaceWriteLock } from "./workspace.js";
import type { MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const AGENTS_SECTIONS_REASON_CODES = Object.freeze([
  "MANAGED_SECTION_ACTION_INVALID",
  "MANAGED_SECTION_FORCE_REQUIRED",
  "MANAGED_SECTION_NOT_FOUND",
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

async function writeSectionFile(located: SectionInFile, after: string, at: string, backupRoot: string | undefined): Promise<AppliedManagedWrite> {
  const plan: ManagedWritePlan = {
    filePath: located.filePath,
    file: located.file,
    exists: located.text !== null,
    before: located.text,
    after,
    write: true,
    sections: [],
    pending: [],
  };
  return applyManagedWrite(plan, { now: at, ...(backupRoot === undefined ? {} : { backupRoot }) });
}

function sameRecord(left: ManagedSectionRecord | undefined, right: ManagedSectionRecord | null): boolean {
  if (left === undefined || right === null) return left === undefined && right === null;
  return left.file === right.file && left.id === right.id && left.rev === right.rev && left.digest === right.digest && left.state === right.state;
}

function change(located: SectionInFile, id: string, action: SectionAction | "disable", done: SectionChangeResult, applied: AppliedManagedWrite | null, record: ManagedSectionRecord | null): SectionChange {
  const recordChanged = !sameRecord(located.record, record);
  const written = applied?.written ?? false;
  return {
    file: located.file,
    id,
    action,
    result: written || recordChanged ? done : "unchanged",
    written,
    backupPath: applied?.backupPath ?? null,
    record,
    recordChanged,
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
  if (!SECTION_ACTIONS.includes(input.action)) {
    fail("MANAGED_SECTION_ACTION_INVALID", `action must be one of ${SECTION_ACTIONS.join(", ")}`, { section: String(input.id), action: String(input.action) });
  }
  const located = await locateSection(input.projectRoot, input.id, input.records);
  const { file, parsed, section, record, index } = located;
  if (parsed === null || section === null) {
    fail("MANAGED_SECTION_NOT_FOUND", `${file} holds no section ${input.id} to ${input.action}`, { file, section: input.id });
  }
  const at = input.at;
  if (input.action === "keep") {
    return change(located, input.id, "keep", "kept", null, { file, id: input.id, rev: section.rev, digest: section.bodyDigest, state: "user-owned" });
  }
  if (input.action === "unmanage") {
    const kept: ManagedSectionRecord = { file, id: input.id, rev: record?.rev ?? section.rev, digest: record?.digest ?? section.digest, state: "unmanaged" };
    const applied = await writeSectionFile(located, replaceSection(parsed, index, section.body), at, input.backupRoot);
    return change(located, input.id, "unmanage", "unmanaged", applied, kept);
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
    return change(located, input.id, "overwrite", "overwritten", null, { file, id: input.id, rev: section.rev, digest, state: "managed" });
  }
  const rev = Math.max(section.rev, record?.rev ?? 0) + 1;
  const applied = await writeSectionFile(located, replaceSection(parsed, index, renderSection({ id: input.id, rev, body }, parsed.eol)), at, input.backupRoot);
  return change(located, input.id, "overwrite", "overwritten", applied, { file, id: input.id, rev, digest, state: "managed" });
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
  const located = await locateSection(input.projectRoot, input.id, input.records);
  const { file, parsed, section, record, index } = located;
  if (parsed === null || section === null) return change(located, input.id, "disable", "disabled", null, null);
  if (userModified(section, record) && input.force !== true) {
    fail("MANAGED_SECTION_FORCE_REQUIRED", `section ${input.id} of ${file} was changed by the user; disabling it needs force`, {
      file,
      section: input.id,
      state: record?.state === "managed" || record === undefined ? "user-modified" : record.state,
    });
  }
  const applied = await writeSectionFile(located, replaceSection(parsed, index, ""), input.at, input.backupRoot);
  return change(located, input.id, "disable", "disabled", applied, null);
}

// ---- The engine's sections and a library's records of them ----

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

function recordDeltas(changes: readonly { readonly file: string; readonly id: string; readonly record: ManagedSectionRecord | null; readonly recordChanged: boolean; readonly hadRecord: boolean }[]): readonly ((state: WorkspaceState) => MutationDelta)[] {
  return changes.filter((entry) => entry.recordChanged).flatMap((entry) => {
    const key = managedSectionRecordKey(entry.file, entry.id);
    if (entry.record !== null) return [setConfigRecordDelta({ collection: "managed-section", key, value: entry.record })];
    return entry.hadRecord ? [removeConfigRecordDelta({ collection: "managed-section", key })] : [];
  });
}

async function commit(root: string, state: WorkspaceState, deltas: readonly ((state: WorkspaceState) => MutationDelta)[], options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  if (deltas.length === 0) return state;
  const committed = await appendEvents(root, deltas, options);
  await projectConfiguration(root, committed);
  return committed;
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

/** The sections the engine writes into AGENTS.md for a device whose navigation choice is `navigation`. */
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
    ],
    withheld: [...system.withheld, ...custom.withheld],
  };
}

/**
 * Render the engine's sections into a project's AGENTS.md and CLAUDE.md against the library's
 * records, and record each section record the render changed (R2, R4, R5). AGENTS.md gets the
 * variable sections, and the navigation section when this device's choice is written; CLAUDE.md
 * gets its import section unless it imports AGENTS.md already. Both files are planned before
 * either is written, so a file whose markers do not parse refuses the whole render. A section the
 * user changed is left as it is and goes pending; one the user removed is not put back; a section
 * the engine does not render (a navigation section another device wrote) is left alone.
 */
export async function renderAgentsSections(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly navigation: AgentsNavigationChoice | null;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<AgentsRenderResult> {
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const state = await materializeWorkspace(root);
    const agents = agentsFileSections(state, input.navigation);
    const plans = [
      await planManagedWrite({
        filePath: join(input.projectRoot, AGENTS_FILE),
        file: AGENTS_FILE,
        desired: agents.sections.map((section) => ({ id: section.id, body: section.body })),
        records: managedSectionRecordsFor(state, AGENTS_FILE),
      }),
      await planClaudeImport(input.projectRoot, managedSectionRecordsFor(state, CLAUDE_FILE)),
    ];
    const files: RenderedFile[] = [];
    for (const plan of plans) {
      const applied = await applyManagedWrite(plan, { now: input.occurredAt, ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }) });
      files.push({ file: plan.file, written: applied.written, backupPath: applied.backupPath });
    }
    const decisions = plans.flatMap((plan) => plan.sections.map((decision) => ({ plan, decision })));
    const deltas = recordDeltas(decisions.map(({ plan, decision }) => ({ file: plan.file, id: decision.id, record: decision.record, recordChanged: decision.recordChanged, hadRecord: true })));
    const committed = await commit(root, state, deltas, input);
    const backup = files.find((file) => file.backupPath !== null)?.backupPath ?? null;
    return {
      projectRoot: input.projectRoot,
      navigation: input.navigation,
      files,
      sections: decisions.map(({ plan, decision }) => ({ id: decision.id, file: plan.file, result: decision.result, state: decision.record.state, line: decision.line })),
      pending: plans.flatMap((plan) => plan.pending.map((id) => ({ id, file: plan.file }))),
      backupDir: backup === null ? null : dirname(backup),
      withheld: agents.withheld,
      recorded: deltas.length,
      state: committed,
    };
  });
}

export interface AgentsSectionChangeResult {
  readonly change: SectionChange;
  readonly state: WorkspaceState;
}

/**
 * Settle one section of a project against the library (R3): resolveSection with the library's
 * records and, for overwrite, the engine's text as the library now stands; the record it leaves is
 * recorded in the library. An id the engine writes no text for cannot be overwritten.
 */
export async function resolveAgentsSection(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly id: string;
  readonly action: SectionAction;
  readonly force?: boolean;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<AgentsSectionChangeResult> {
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const state = await materializeWorkspace(root);
    const file = managedSectionFile(input.id);
    const records = managedSectionRecordsFor(state, file);
    let body: string | undefined;
    if (input.action === "overwrite") {
      body = engineSectionBody(state, input.id) ?? fail("MANAGED_SECTION_ACTION_INVALID", `the engine writes no section ${input.id}, so there is no text to overwrite it with`, {
        file,
        section: input.id,
        action: "overwrite",
      });
    }
    const outcome = await resolveSection({
      projectRoot: input.projectRoot,
      id: input.id,
      action: input.action,
      records,
      at: input.occurredAt,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(body === undefined ? {} : { body }),
      ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    });
    const hadRecord = records.some((record) => record.id === input.id);
    const committed = await commit(root, state, recordDeltas([{ file, id: input.id, record: outcome.record, recordChanged: outcome.recordChanged, hadRecord }]), input);
    return { change: outcome, state: committed };
  });
}

/** Take one section out of a project's file and remove its record from the library (disableSection). */
export async function disableAgentsSection(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly id: string;
  readonly force?: boolean;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<AgentsSectionChangeResult> {
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const state = await materializeWorkspace(root);
    const file = managedSectionFile(input.id);
    const records = managedSectionRecordsFor(state, file);
    const outcome = await disableSection({
      projectRoot: input.projectRoot,
      id: input.id,
      records,
      at: input.occurredAt,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    });
    const hadRecord = records.some((record) => record.id === input.id);
    const committed = await commit(root, state, recordDeltas([{ file, id: input.id, record: outcome.record, recordChanged: outcome.recordChanged, hadRecord }]), input);
    return { change: outcome, state: committed };
  });
}
