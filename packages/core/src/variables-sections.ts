// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-484 R2 (MIN-227 D12; TCRN-CROSS-SUB-340): the two variable sections of
// AGENTS.md. The system section renders exactly the system settings (SYSTEM_VARIABLE_KEYS); no other
// setting ever appears there. TCRN-CROSS-STORY-508 R8 (MIN-236 D8; TCRN-CROSS-SUB-407) adds to what
// it rendered, keeping design.authority (MIN-227 D11): models.category and models.tiers, each a table
// of records in ascending order (order, id, name, description; order, category, runner, model, effort,
// note), the three models.escalation settings, and design.authority.
// The custom section renders the project's variables (variables.ts): name, type, value and
// description. Both are managed sections (managed-sections.ts), variables-system and
// variables-custom, written only when writeVariablesSections is called.
//
// A managed section never renders an absolute path (TCRN-CROSS-STORY-478), and AGENTS.md is
// committed, so it never renders a credential either. A variable whose row would name an absolute
// path, or whose value or description is shaped like a credential (a record written around
// setVariable, or before a stricter heuristic), is left out of the custom section; a category whose
// name or description would, or a tier record whose model, effort or note would, is rendered as
// withheld. Each is reported with its reason, and everything else in the section is still written.

import { join } from "node:path";

import { setConfigRecordDelta } from "./config-records.js";
import {
  absolutePathLine,
  applyManagedWrite,
  managedSectionRecordKey,
  managedSectionRecordsFor,
  planManagedWrite,
} from "./managed-sections.js";
import type { ManagedSectionDecision, ManagedSectionRecord, ManagedWritePlan } from "./managed-sections.js";
import { MODELS_CATEGORY_SETTING_KEY } from "./models-category.js";
import type { ModelsCategoryRecord } from "./models-category.js";
import {
  MODELS_ESCALATION_CEILING_SETTING_KEY,
  MODELS_ESCALATION_ENABLED_SETTING_KEY,
  MODELS_ESCALATION_SETTING_KEYS,
  MODELS_ESCALATION_THRESHOLD_SETTING_KEY,
  readModelsEscalation,
} from "./models-escalation.js";
import { MODELS_TIERS_SETTING_KEY, modelsTierReference, readModelsCategory, readModelsTiers } from "./models-tiers.js";
import { looksSecretShaped, variablesInRenderOrder } from "./variables.js";
import { appendEvents, materializeWorkspace, projectConfiguration, withWorkspaceWriteLock } from "./workspace.js";
import type { WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const VARIABLES_SECTIONS_FILE = "AGENTS.md" as const;
export const VARIABLES_SYSTEM_SECTION_ID = "variables-system" as const;
export const VARIABLES_CUSTOM_SECTION_ID = "variables-custom" as const;
const DESIGN_AUTHORITY_SETTING_KEY = "design.authority";
// The system settings the system section renders, in the order it renders them, and the only ones it
// ever renders.
export const SYSTEM_VARIABLE_KEYS: readonly string[] = Object.freeze([
  MODELS_CATEGORY_SETTING_KEY,
  MODELS_TIERS_SETTING_KEY,
  ...MODELS_ESCALATION_SETTING_KEYS,
  DESIGN_AUTHORITY_SETTING_KEY,
]);
// The heading the three models.escalation settings share in the system section.
const MODELS_ESCALATION_HEADING = "models.escalation";

const UNSET = "(unset)";
const NONE = "(none)";
const WITHHELD = "(withheld)";
const NOTE = "Written by Einzbern from the project's configuration. Change it in Atelier, not here: an edit here stops Einzbern from rewriting this section.";

export type WithheldReason = "absolute-path" | "secret-shaped";

/**
 * What a section left out: a variable's name, a category as models.category.<id>, or a tier record as
 * models.tiers.<order>, and why.
 */
export interface WithheldEntry {
  readonly name: string;
  readonly reason: WithheldReason;
}

/** A rendered section body and what it left out. */
export interface RenderedVariablesSection {
  readonly id: string;
  readonly body: string;
  readonly withheld: readonly WithheldEntry[];
}

// One table cell: a pipe would end the cell, so it is escaped; an empty text reads as unset.
function cell(text: string): string {
  return text === "" ? UNSET : text.replace(/\|/gu, "\\|");
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

// Why a rendered line may not be written, or null: it names an absolute path, or one of its texts is
// shaped like a credential.
function withheldReason(line: string, texts: readonly string[]): WithheldReason | null {
  if (absolutePathLine(line) !== null) return "absolute-path";
  return texts.some((text) => looksSecretShaped(text) !== null) ? "secret-shaped" : null;
}

// A table's lines: its header, its separator and its rows, or (none) when it has no row.
function table(header: readonly string[], rows: readonly string[]): readonly string[] {
  return rows.length === 0 ? [NONE] : [row(header), row(header.map(() => "---")), ...rows];
}

/** How a category is named where what a section left out is reported: models.category.<id>. */
function modelsCategoryReference(category: Pick<ModelsCategoryRecord, "id">): string {
  return `${MODELS_CATEGORY_SETTING_KEY}.${category.id}`;
}

/**
 * The system section, a subsection for each system setting in SYSTEM_VARIABLE_KEYS' order, the three
 * models.escalation settings sharing one (TCRN-CROSS-STORY-508 R8): models.category and models.tiers
 * as their tables of records in ascending order, the escalation settings as a table of their effective
 * values, and design.authority. A line before each table says how to read it. An empty model or effort
 * reads as unset, and an empty description or note is an empty cell. A category whose name or
 * description, or a tier record whose model, effort or note, would put an absolute path or a
 * credential into the file keeps its row with those cells withheld; the escalation values are true or
 * false, an integer and a category id, none of which can name a path.
 */
export function renderSystemVariablesSection(state: Pick<WorkspaceState, "settings">): RenderedVariablesSection {
  const withheld: WithheldEntry[] = [];
  const categories: string[] = [];
  for (const category of readModelsCategory(state.settings)) {
    const order = String(category.order);
    const line = row([order, category.id, cell(category.name), category.description === "" ? "" : cell(category.description)]);
    const reason = withheldReason(line, [category.name, category.description]);
    if (reason === null) {
      categories.push(line);
    } else {
      withheld.push({ name: modelsCategoryReference(category), reason });
      categories.push(row([order, category.id, WITHHELD, WITHHELD]));
    }
  }
  const tiers: string[] = [];
  for (const record of readModelsTiers(state.settings)) {
    const order = String(record.order);
    const line = row([order, record.category, record.runner, cell(record.model), cell(record.effort), record.note === "" ? "" : cell(record.note)]);
    const reason = withheldReason(line, [record.model, record.effort, record.note]);
    if (reason === null) {
      tiers.push(line);
    } else {
      withheld.push({ name: modelsTierReference(record), reason });
      tiers.push(row([order, record.category, record.runner, WITHHELD, WITHHELD, WITHHELD]));
    }
  }
  const escalation = readModelsEscalation(state.settings);
  const authority = state.settings.find((setting) => setting.key === DESIGN_AUTHORITY_SETTING_KEY)?.value ?? "";
  const lines = [
    "## System variables",
    "",
    NOTE,
    "",
    `### ${MODELS_CATEGORY_SETTING_KEY}`,
    "",
    "The categories a rule names. The lower the order, the stronger the category.",
    "",
    ...table(["Order", "Id", "Name", "Description"], categories),
    "",
    `### ${MODELS_TIERS_SETTING_KEY}`,
    "",
    "A rule gets its category's record with the largest order, whatever the runner. The lower the order, the stronger the record.",
    "",
    ...table(["Order", "Category", "Runner", "Model", "Effort", "Note"], tiers),
    "",
    `### ${MODELS_ESCALATION_HEADING}`,
    "",
    `While enabled, a rule moves one record towards the smaller orders of ${MODELS_TIERS_SETTING_KEY} for every \`threshold\` rejections of its attempts, across categories and runners, and stops at the ceiling category's record with the smallest order.`,
    "",
    ...table(["Setting", "Value"], [
      row([MODELS_ESCALATION_ENABLED_SETTING_KEY, String(escalation.enabled)]),
      row([MODELS_ESCALATION_THRESHOLD_SETTING_KEY, String(escalation.threshold)]),
      row([MODELS_ESCALATION_CEILING_SETTING_KEY, escalation.ceiling]),
    ]),
    "",
    `### ${DESIGN_AUTHORITY_SETTING_KEY}`,
    "",
    authority === "" ? UNSET : authority,
  ];
  return { id: VARIABLES_SYSTEM_SECTION_ID, body: `${lines.join("\n")}\n`, withheld };
}

/**
 * The custom section: every variable's name, type, value and description, less any row that may not
 * be written. TCRN-CROSS-STORY-508 R7: the rows follow the variables' order (variablesInRenderOrder);
 * without one they are by name, as before, and the order itself is not a column.
 */
export function renderCustomVariablesSection(state: Pick<WorkspaceState, "configRecords">): RenderedVariablesSection {
  const withheld: WithheldEntry[] = [];
  const rows: string[] = [];
  for (const variable of variablesInRenderOrder(state)) {
    const line = row([variable.name, variable.type, cell(variable.value), variable.description === "" ? "" : cell(variable.description)]);
    const reason = withheldReason(line, [variable.value, variable.description]);
    if (reason === null) rows.push(line);
    else withheld.push({ name: variable.name, reason });
  }
  const lines = [
    "## Custom variables",
    "",
    NOTE,
    "",
    ...(rows.length === 0 ? [NONE] : [row(["Name", "Type", "Value", "Description"]), row(["---", "---", "---", "---"]), ...rows]),
  ];
  return { id: VARIABLES_CUSTOM_SECTION_ID, body: `${lines.join("\n")}\n`, withheld };
}

export interface VariablesSectionsResult {
  readonly file: string;
  readonly written: boolean;
  // Where the file was copied before it was replaced; null when nothing was replaced.
  readonly backupPath: string | null;
  readonly sections: readonly ManagedSectionDecision[];
  // Sections awaiting attention: user-edited sections left intact, or a custom section with a withheld value.
  readonly pendingSections: readonly string[];
  // What the sections left out: a variable's name, or a tier record as models.tiers.<order>, and why.
  readonly withheld: readonly WithheldEntry[];
}

// A withheld custom variable remains stored in the library but cannot appear in the committed
// section. Keep that outstanding decision visible as the section's existing pending state; a
// variable-set/remove that makes the row safe or removes it will settle the state on the next
// render. Respect user-owned, unmanaged, removed, and user-edited sections.
function recordWithheldCustomVariablesAsPending(plan: ManagedWritePlan, state: Pick<WorkspaceState, "configRecords">, withheld: readonly WithheldEntry[]): ManagedWritePlan {
  if (withheld.length === 0) return plan;
  const decision = plan.sections.find((section) => section.id === VARIABLES_CUSTOM_SECTION_ID);
  if (decision === undefined || decision.record.state !== "managed" || decision.result === "removed") return plan;

  const record: ManagedSectionRecord = { ...decision.record, state: "pending" };
  const previous = managedSectionRecordsFor(state, VARIABLES_SECTIONS_FILE).find((entry) => entry.id === VARIABLES_CUSTOM_SECTION_ID);
  const recordChanged = previous === undefined || previous.rev !== record.rev || previous.digest !== record.digest || previous.state !== record.state;
  return {
    ...plan,
    sections: plan.sections.map((section) => section.id === VARIABLES_CUSTOM_SECTION_ID
      ? { ...section, record, recordChanged }
      : section),
    pending: plan.pending.includes(VARIABLES_CUSTOM_SECTION_ID)
      ? plan.pending
      : [...plan.pending, VARIABLES_CUSTOM_SECTION_ID],
  };
}

/**
 * Render both variable sections into the project's AGENTS.md through the managed-section writer,
 * then record in the library each section record the write changed. A section the user changed is
 * left as it is (pending); a custom section with a withheld variable is also recorded pending while
 * its safe rows are written. A section whose markers the user removed is not put back.
 */
export async function writeVariablesSections(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<VariablesSectionsResult> {
  return withWorkspaceWriteLock(workspaceRoot, async (root) => {
    const state = await materializeWorkspace(root);
    const system = renderSystemVariablesSection(state);
    const custom = renderCustomVariablesSection(state);
    const planned = await planManagedWrite({
      filePath: join(input.projectRoot, VARIABLES_SECTIONS_FILE),
      file: VARIABLES_SECTIONS_FILE,
      desired: [system, custom].map((section) => ({ id: section.id, body: section.body })),
      records: managedSectionRecordsFor(state, VARIABLES_SECTIONS_FILE),
    });
    const plan = recordWithheldCustomVariablesAsPending(planned, state, custom.withheld);
    const applied = await applyManagedWrite(plan, { now: input.occurredAt, ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }) });
    const deltas = plan.sections.filter((decision) => decision.recordChanged).map((decision) => setConfigRecordDelta({
      collection: "managed-section",
      key: managedSectionRecordKey(VARIABLES_SECTIONS_FILE, decision.id),
      value: decision.record,
    }));
    if (deltas.length > 0) {
      const committed = await appendEvents(root, deltas, input);
      await projectConfiguration(root, committed);
    }
    return {
      file: VARIABLES_SECTIONS_FILE,
      written: applied.written,
      backupPath: applied.backupPath,
      sections: plan.sections,
      pendingSections: plan.pending,
      withheld: [...system.withheld, ...custom.withheld],
    };
  });
}
