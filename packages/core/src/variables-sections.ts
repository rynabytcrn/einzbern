import { effectiveProjectState } from "./project-chain.js";
import { DESIGN_CONFIGURATION_KEYS, designConfiguration } from "./project-scope.js";
// SPDX-License-Identifier: Apache-2.0

// Shared managed output contains project declarations and a runtime policy reference.
// Device host model/quota values never become a portable project policy snapshot.
// Historical variable records retain their AGENTS export contract; new declarations
// require an explicit export target. Output remains a projection, never a read authority.

import { join } from "node:path";

import { assertManagedOutputRoot, commitPlanned, filesAsPlanned, putBackUnrecorded } from "./agents-sections.js";
import { setConfigRecordDelta } from "./config-records.js";
import {
  absolutePathLine,
  applyManagedWrite,
  managedSectionRecordKey,
  managedSectionRecordsFor,
  planManagedWrite,
} from "./managed-sections.js";
import type { ManagedSectionDecision, ManagedSectionRecord, ManagedWritePlan } from "./managed-sections.js";
import { MODELS_TIERS_SETTING_KEY } from "./models-tiers.js";
import { settingsCatalogEntry } from "./settings.js";
import { looksSecretShaped, variableExportDecision, variablesInRenderOrder } from "./variables.js";
import { appendPlannedWrite } from "./workspace.js";
import type { WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const VARIABLES_SECTIONS_FILE = "AGENTS.md" as const;
export const VARIABLES_SYSTEM_SECTION_ID = "variables-system" as const;
export const VARIABLES_CUSTOM_SECTION_ID = "variables-custom" as const;
const DESIGN_AUTHORITY_SETTING_KEY = "design.authority";
// The system settings the system section renders, in the order it renders them, and the only ones it
// ever renders.
export const SYSTEM_VARIABLE_KEYS: readonly string[] = Object.freeze([
  ...DESIGN_CONFIGURATION_KEYS,
]);
// TCRN-CROSS-STORY-540 GWT2 (MIN-243 D1, Q5; TCRN-CROSS-SUB-506): the system settings a coordination
// library's system section renders, in its order: the orchestration limits a coordination library
// keeps for itself (project-scope.ts, COORDINATION_RUNTIME_SETTING_KEYS) and the seven design bindings.
// A coordination library holds no models.*, so none is here.
export const COORDINATION_SYSTEM_VARIABLE_KEYS: readonly string[] = Object.freeze([
  "execution.maxConcurrentSubagents",
  ...DESIGN_CONFIGURATION_KEYS,
]);
// The heading the three models.escalation settings share in the system section.

// TCRN-CROSS-STORY-540 (Q4; TCRN-CROSS-SUB-506): the fixed text of both sections in the two
// languages the library's artifact.language picks between, as a rule's text is picked
// (rules-catalog.ts): Chinese for zh-CN, English for every other value and when unset. Both languages
// live here, side by side; the English text is the one the sections always had.
const SECTION_TEXT = Object.freeze({
  en: {
    unset: "(unset)",
    none: "(none)",
    withheld: "(withheld)",
    unconfigured: "(unconfigured)",
    note: "Written by Einzbern from the project's configuration. Change it in Atelier, not here: an edit here stops Einzbern from rewriting this section.",
    coordinationNote: "Written by Einzbern from the coordination library's configuration. Change it in Atelier, not here: an edit here stops Einzbern from rewriting this section.",
    systemHeading: "## System variables",
    policyHeading: "### Engine execution policy",
    policy: "Resolve the current device/host policy at dispatch time with execution-policy-resolve --host <host> --category <category> --rejections <count>. Model and quota values are device declarations, never copied into shared output.",
    projectBudget: "Project concurrency is a budget capped by the device. Legacy quota declarations are compatibility data only.",
    customHeading: "## Custom variables",
    categories: "The categories a rule names. The lower the order, the stronger the category.",
    categoriesHeader: ["Order", "Id", "Name", "Description"],
    tiers: "A rule gets its category's record with the largest order, whatever the runner. The lower the order, the stronger the record.",
    tiersHeader: ["Order", "Category", "Runner", "Model", "Effort", "Note"],
    escalation: `While enabled, a rule moves one record towards the smaller orders of ${MODELS_TIERS_SETTING_KEY} for every \`threshold\` rejections of its attempts, across categories and runners, and stops at the ceiling category's record with the smallest order.`,
    settingValueHeader: ["Setting", "Value"],
    execution: "The limits of the work dispatched from this coordination library: how many subagents run at once, and the shares of the five-hour and weekly quota windows at which dispatch stops running them in parallel or waits. Each is declared for the whole library; a key the library does not declare takes the engine's default.",
    target: (target: string | null) => `Configuration target: ${target ?? "library defaults"}.`,
    design: (status: string, publication: string) => `Design bindings: ${status}. Production publication: ${publication}. The offline engine validates declarations only; an authorized agent verifies repository and production evidence.`,
    designHeader: ["Setting", "Declared value", "Effective source", "Inherited"],
    provenanceHeader: ["System setting", "Effective source", "Inherited"],
    customHeader: ["Name", "Type", "Value", "Description"],
  },
  zh: {
    unset: "（未设置）",
    none: "（无）",
    withheld: "（已隐去）",
    unconfigured: "（未配置）",
    note: "由 Einzbern 按项目配置写入。请在 Atelier 中修改，不要在这里改：在这里改动后，Einzbern 不再重写这一段。",
    coordinationNote: "由 Einzbern 按协调库的配置写入。请在 Atelier 中修改，不要在这里改：在这里改动后，Einzbern 不再重写这一段。",
    systemHeading: "## 系统变量",
    policyHeading: "### 引擎执行策略",
    policy: "派工前通过 execution-policy-resolve --host <host> --category <category> --rejections <count> 解析当前设备与宿主策略。模型和额度阈值属于设备声明，不复制到共享生成物。",
    projectBudget: "项目并发预算只能收紧设备上限。旧额度声明仅供历史兼容读取。",
    customHeading: "## 自定义变量",
    categories: "规则引用的模型分类。顺序号越小，分类越强。",
    categoriesHeader: ["顺序", "Id", "名称", "说明"],
    tiers: "规则取所属分类中顺序号最大的那条记录，不论运行方。顺序号越小，记录越强。",
    tiersHeader: ["顺序", "分类", "运行方", "模型", "推理强度", "备注"],
    escalation: `启用时，规则的尝试每被拒绝 \`threshold\` 次，就在 ${MODELS_TIERS_SETTING_KEY} 里朝顺序号更小的方向移动一条记录，可以跨分类与运行方，到上限分类中顺序号最小的那条记录为止。`,
    settingValueHeader: ["设置", "取值"],
    execution: "从本协调库派出的工作的上限：同时运行的子代理数，以及五小时与每周额度窗口用到多少时停止并行、开始等待。每个键都按整个库声明；库里没有声明的键取引擎的缺省值。",
    target: (target: string | null) => `配置对象：${target ?? "库的缺省配置"}。`,
    design: (status: string, publication: string) => `设计绑定：${status}。生产发布：${publication}。离线引擎只校验声明；仓库与生产证据由获授权的代理核实。`,
    designHeader: ["设置", "声明值", "生效来源", "继承"],
    provenanceHeader: ["系统设置", "生效来源", "继承"],
    customHeader: ["名称", "类型", "取值", "说明"],
  },
});

type SectionText = typeof SECTION_TEXT.en;

// The text for a library's artifact language (Q4): Chinese for zh-CN, English otherwise.
function sectionText(state: Partial<Pick<WorkspaceState, "settings">>): SectionText {
  return state.settings?.find((setting) => setting.key === "artifact.language")?.value === "zh-CN" ? SECTION_TEXT.zh : SECTION_TEXT.en;
}

// Whether the library is a coordination library (chain-identity.ts), read from its identity record as
// the library holds it; a scoped state keeps that record (project-scope.ts).
function coordinationChain(state: Partial<Pick<WorkspaceState, "configRecords">>): boolean {
  return state.configRecords?.some((record) => record.collection === "chain" && record.key === "identity" && record.projectId === undefined && record.value.role === "coordination") === true;
}

export type WithheldReason = "absolute-path" | "secret-shaped" | "not-exported";

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
function cell(text: string, words: SectionText = SECTION_TEXT.en): string {
  return text === "" ? words.unset : text.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
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
function table(header: readonly string[], rows: readonly string[], words: SectionText = SECTION_TEXT.en): readonly string[] {
  return rows.length === 0 ? [words.none] : [row(header), row(header.map(() => "---")), ...rows];
}

type SystemSectionState = Pick<WorkspaceState, "settings"> & Partial<Pick<WorkspaceState, "configRecords">> & {
  readonly configurationProjectId?: string | null;
  readonly settingSources?: Readonly<Record<string, import("./project-scope.js").ConfigurationSource>>;
};

// The design subsection both kinds of library render: the explicit target, the status of its seven
// design bindings and each binding's declared value, effective source and inheritance.
function designLines(state: SystemSectionState, words: SectionText, withheld: WithheldEntry[]): readonly string[] {
  const design = designConfiguration(state);
  return [
    `### ${DESIGN_AUTHORITY_SETTING_KEY}`,
    "",
    words.target(state.configurationProjectId ?? null),
    "",
    words.design(design.status, design.publicationVerification),
    "",
    ...table(words.designHeader, design.bindings.map((binding) => {
      const value = binding.value ?? words.unconfigured;
      const reason = withheldReason(row([value]), [value]);
      if (reason !== null) withheld.push({ name: binding.key, reason });
      return row([binding.key, reason === null ? cell(value, words) : words.withheld, binding.source.projectId ?? binding.source.kind, String(binding.source.inherited)]);
    }), words),
  ];
}

// The provenance table that closes the system section: each of its settings' effective source and inheritance.
function provenanceLines(state: SystemSectionState, keys: readonly string[], words: SectionText): readonly string[] {
  return table(words.provenanceHeader, keys.map((key) => {
    const source = state.settingSources?.[key];
    return row([key, source?.projectId ?? source?.kind ?? (state.settings.some((entry) => entry.key === key) ? "library" : "default"), String(source?.inherited ?? false)]);
  }), words);
}

/**
 * TCRN-CROSS-STORY-540 GWT2 (MIN-243 D1, Q5; TCRN-CROSS-SUB-506): a coordination library's system
 * section. A coordination library holds no models.* (MIN-243 D1), so it renders none; it renders its
 * orchestration limits (COORDINATION_SYSTEM_VARIABLE_KEYS: execution.maxConcurrentSubagents and the four
 * quota.* settings) with their effective values, a declared one or else the engine's default, then the
 * seven design bindings and the provenance table as a project's section does.
 */
function coordinationSystemSection(state: SystemSectionState, words: SectionText): RenderedVariablesSection {
  const withheld: WithheldEntry[] = [];
  const limits = ["execution.maxConcurrentSubagents"];
  const lines = [
    words.systemHeading,
    "",
    words.coordinationNote,
    "",
    `### ${limits.join(", ")}`,
    "",
    words.projectBudget,
    words.policy,
    "",
    ...table(words.settingValueHeader, limits.map((key) => {
      const value = state.settings.find((entry) => entry.key === key)?.value ?? settingsCatalogEntry(key).defaultValue;
      return row([key, value === null ? words.unset : cell(value, words)]);
    }), words),
    "",
    ...designLines(state, words, withheld),
    "",
    ...provenanceLines(state, COORDINATION_SYSTEM_VARIABLE_KEYS, words),
  ];
  return { id: VARIABLES_SYSTEM_SECTION_ID, body: `${lines.join("\n")}\n`, withheld };
}

/**
 * The system section, a subsection for each system setting in SYSTEM_VARIABLE_KEYS' order, the three
 * models.escalation settings sharing one (TCRN-CROSS-STORY-508 R8): models.category and models.tiers
 * as their tables of records in ascending order, the escalation settings as a table of their effective
 * values, and the explicit target's seven design bindings with their effective source and inheritance.
 * A separate table preserves provenance for every system setting. A line before each table says how
 * to read it. An empty model or effort
 * reads as unset, and an empty description or note is an empty cell. A category whose name or
 * description, or a tier record whose model, effort or note, would put an absolute path or a
 * credential into the file keeps its row with those cells withheld; the escalation values are true or
 * false, an integer and a category id, none of which can name a path.
 *
 * TCRN-CROSS-STORY-540 (TCRN-CROSS-SUB-506): a coordination library's section lists its own keys
 * instead (coordinationSystemSection), and both are written in the library's artifact language (Q4).
 */
export function renderSystemVariablesSection(state: SystemSectionState): RenderedVariablesSection {
  const words = sectionText(state);
  if (coordinationChain(state)) return coordinationSystemSection(state, words);
  const withheld: WithheldEntry[] = [];
  const lines = [words.systemHeading, "", words.note, "", words.policyHeading, "",
    words.policy,
    "", ...designLines(state, words, withheld), "", ...provenanceLines(state, DESIGN_CONFIGURATION_KEYS, words)];
  return { id: VARIABLES_SYSTEM_SECTION_ID, body: `${lines.join("\n")}\n`, withheld };
}

/**
 * The custom section: every variable's name, type, value and description, less any row that may not
 * be written. TCRN-CROSS-STORY-508 R7: the rows follow the variables' order (variablesInRenderOrder);
 * without one they are by name, as before, and the order itself is not a column.
 * TCRN-CROSS-STORY-540 (Q4; TCRN-CROSS-SUB-506): in the library's artifact language, with a coordination
 * library's note.
 */
export function renderCustomVariablesSection(state: Pick<WorkspaceState, "configRecords"> & Partial<Pick<WorkspaceState, "settings">>): RenderedVariablesSection {
  const words = sectionText(state);
  const withheld: WithheldEntry[] = [];
  const rows: string[] = [];
  for (const variable of variablesInRenderOrder(state)) {
    const exportReason = variableExportDecision(variable, "agents");
    if (exportReason !== null) { withheld.push({ name: variable.name, reason: exportReason }); continue; }
    const line = row([variable.name, variable.type, cell(variable.value, words), variable.description === "" ? "" : cell(variable.description, words)]);
    const reason = withheldReason(line, [variable.value, variable.description]);
    if (reason === null) rows.push(line);
    else withheld.push({ name: variable.name, reason });
  }
  const lines = [
    words.customHeading,
    "",
    coordinationChain(state) ? words.coordinationNote : words.note,
    "",
    ...table(words.customHeader, rows, words),
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
  if (!withheld.some(entry => entry.reason !== "not-exported")) return plan;
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
 * its safe rows are written. A section whose markers the user removed is not put back. When the
 * records cannot be committed, AGENTS.md returns to what it held, and a file the write created is
 * taken away, before the error goes on (TCRN-CROSS-STORY-489; agents-sections.ts,
 * putBackUnrecorded). TCRN-CROSS-STORY-538 GWT3 (TCRN-CROSS-SUB-499): the library is read and
 * AGENTS.md planned outside the library write lock; under it the file is written and the records
 * appended only while the library stands where it was read and the file holds what was read, and the
 * write is planned again otherwise (workspace.ts, appendPlannedWrite).
 */
export async function writeVariablesSections(workspaceRoot: string, input: {
  readonly projectRoot: string;
  readonly backupRoot?: string;
} & WorkspaceMutationOptions): Promise<VariablesSectionsResult> {
  return appendPlannedWrite<{ plan: ManagedWritePlan | null; recorded: number; withheld: readonly WithheldEntry[] }, VariablesSectionsResult>(workspaceRoot, input, {
    plan: async (root, nativeState) => {
      await assertManagedOutputRoot(root, input.projectRoot, nativeState);
      const state = await effectiveProjectState(nativeState, input.configurationProjectId);
      if (state.settings.find(entry => entry.key === "agents.generation")?.value === "none") {
        return { deltas: [], plan: { plan: null, recorded: 0, withheld: [] as WithheldEntry[] } };
      }
      const system = renderSystemVariablesSection(state);
      const custom = renderCustomVariablesSection(state);
      const planned = await planManagedWrite({
        filePath: join(input.projectRoot, VARIABLES_SECTIONS_FILE),
        file: VARIABLES_SECTIONS_FILE,
        desired: [system, custom].map((section) => ({ id: section.id, body: section.body })),
        records: managedSectionRecordsFor(state, VARIABLES_SECTIONS_FILE),
      });
      const plan = recordWithheldCustomVariablesAsPending(planned, state, custom.withheld);
      const deltas = plan.sections.filter((decision) => decision.recordChanged).map((decision) => setConfigRecordDelta({
        ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }),
        collection: "managed-section",
        key: managedSectionRecordKey(VARIABLES_SECTIONS_FILE, decision.id),
        value: decision.record,
      }));
      return { deltas, plan: { plan, recorded: deltas.length, withheld: [...system.withheld, ...custom.withheld] } };
    },
    unchanged: async ({ plan }) => plan === null || await filesAsPlanned([plan]),
    write: async (root, nativeState, { plan, recorded, withheld }, append) => {
      if (plan === null) return { file: VARIABLES_SECTIONS_FILE, written: false, backupPath: null, sections: [], pendingSections: [], withheld };
      const applied = await applyManagedWrite(plan, { now: input.occurredAt, ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }) });
      if (recorded > 0) {
        try {
          await commitPlanned(root, append, recorded);
        } catch (error) {
          await putBackUnrecorded(root, nativeState, applied.written ? [plan] : []);
          throw error;
        }
      }
      return {
        file: VARIABLES_SECTIONS_FILE,
        written: applied.written,
        backupPath: applied.backupPath,
        sections: plan.sections,
        pendingSections: plan.pending,
        withheld,
      };
    },
  });
}
