import { chainIdentity } from "./chain-identity.js";
import { effectiveProjectState } from "./project-chain.js";
import { scopedWorkspaceState } from "./project-scope.js";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-483 R2, R3 (MIN-228 D3, MIN-229 D6; TCRN-CROSS-SUB-336): the Command Spell rules
// a project has switched on, and the state each of them is in. Every rule is off until it is
// enabled: a library that holds no record of a rule has it disabled. Enabling a rule records it in
// the library's rule collection (config-records.ts) as {enabled: true, version}, at the version
// this engine ships, and writes its text, in the project's artifact language, into the project's
// AGENTS.md as the managed section rule:<id> through the managed-section writer
// (managed-sections.ts). Disabling it records {enabled: false, version} and takes the section out
// of the file with its markers (agents-sections.ts); a section the user changed goes only with
// force.
//
// A rule's state is read from three places, the rule's record, the section's record and the
// section as it now stands in AGENTS.md, against the version this engine ships (rules-catalog.ts):
//
//   disabled            no record, or a record that says it is off;
//   removed-from-file   enabled, and AGENTS.md holds no markers of its section;
//   pending             enabled, and a write of its section was refused because the user had
//                       changed it: the section waits for rule-resolve;
//   user-modified       enabled, and the section is not the text the engine wrote: the user changed
//                       it, or kept a change as theirs (rule-resolve keep), after which the engine
//                       never writes it again;
//   update-available    enabled at a lower version than this engine ships; the file is left as it
//                       is until the rule is enabled again;
//   enabled             enabled, and the section is the text the engine wrote.
//
// Reading the states writes nothing, and nothing here runs unless it is called: an engine upgrade
// that ships a new version of a rule writes no file.
//
// TCRN-CROSS-STORY-508 R7 (MIN-236 D7): a rule's record may also hold an order, a positive integer
// that places the rule's section among the rule sections of AGENTS.md (agents-sections.ts,
// orderRuleSections). rule-enable sets it when it is given and keeps the recorded one otherwise, and
// rule-disable keeps it, so a rule enabled again takes its old place.
//
// TCRN-CROSS-STORY-489 (TCRN-CROSS-SUB-366): enabling and disabling write AGENTS.md before they
// commit the records. When that commit fails, the file goes back to what it held before the error
// goes on (agents-sections.ts, putBackUnrecorded), so AGENTS.md never holds a section the library
// does not record, nor lacks one the library still records.

import { join } from "node:path";

import { compareCanonicalText } from "../../protocol/src/index.js";
import { assertManagedOutputRoot, AGENTS_FILE, RULE_SECTION_PREFIX, orderRuleSections, putBackUnrecorded, ruleOrders, takeSectionOut } from "./agents-sections.js";
import type { SectionChangeResult } from "./agents-sections.js";
import { configRecord, configRecords, removeConfigRecordDelta, setConfigRecordDelta } from "./config-records.js";
import type { ConfigRecordValue } from "./config-records.js";
import { applyManagedWrite, managedSectionRecordKey, managedSectionRecordsFor, parseManagedFile, planManagedWrite } from "./managed-sections.js";
import type { ManagedSectionRecord, ManagedSectionResult, ParsedSection } from "./managed-sections.js";
import { BUILT_IN_RULES } from "./rules-catalog.js";
import type { BuiltInRule } from "./rules-catalog.js";
import { appendEvents, materializeWorkspace, projectConfiguration, withWorkspaceWriteLock } from "./workspace.js";
import type { MutationDelta, WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const RULES_REASON_CODES = Object.freeze([
  "RULE_RECORD_INVALID",
  "RULE_UNKNOWN",
  "RULE_VERSION_NEWER",
] as const);

export type RulesReasonCode = typeof RULES_REASON_CODES[number];

export class RuleError extends Error {
  readonly reasonCode: RulesReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: RulesReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "RuleError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: RulesReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new RuleError(reasonCode, message, details);
}

/** The six states a rule can be in, as the header of this module describes them. */
export const RULE_STATES = Object.freeze(["disabled", "enabled", "user-modified", "removed-from-file", "update-available", "pending"] as const);
export type RuleState = typeof RULE_STATES[number];

/** What a rule's record holds; the rule's id is the record's key. A record without an order has no order field. */
export interface RuleRecordValue {
  readonly enabled: boolean;
  readonly version: number;
  readonly order?: number;
}

// A rule id: a lowercase letter, then lowercase letters, digits and hyphens, so
// rule:<id> is a managed-section id as well.
const RULE_ID = /^[a-z][a-z0-9-]*$/u;
const RECORD_FIELDS = "enabled,version";
const ORDERED_RECORD_FIELDS = "enabled,order,version";

export function isRuleId(value: unknown): value is string {
  return typeof value === "string" && RULE_ID.test(value);
}

// TCRN-CROSS-STORY-508 R7: an order is a positive integer.
function isOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The id of a rule's managed section in AGENTS.md: rule:<rule id>. */
export function ruleSectionId(id: string): string {
  return `${RULE_SECTION_PREFIX}${id}`;
}

/**
 * The check the rule collection of config-records.ts applies to a record: keyed by a rule id, and
 * holding exactly whether the rule is enabled and the version it was enabled at, and, when it has
 * one, its order (TCRN-CROSS-STORY-508 R7). Only the shape is checked, so a library that records a
 * rule this engine does not ship still replays.
 */
export function checkRuleRecordValue(value: Readonly<Record<string, unknown>>, key: string): void {
  if (!isRuleId(key)) fail("RULE_RECORD_INVALID", `${key} is not a rule id`, { key });
  const fields = Object.keys(value).sort(compareCanonicalText).join(",");
  if (fields !== RECORD_FIELDS && fields !== ORDERED_RECORD_FIELDS) {
    fail("RULE_RECORD_INVALID", "a rule record holds exactly enabled and version, and may hold an order", { key });
  }
  if (typeof value.enabled !== "boolean" || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) {
    fail("RULE_RECORD_INVALID", `the rule record ${key} holds a boolean enabled and a positive integer version`, { key });
  }
  if (value.order !== undefined && !isOrder(value.order)) {
    fail("RULE_RECORD_INVALID", `the order of the rule record ${key} is a positive integer`, { key, field: "order" });
  }
}

/** One rule as listRules reports it. */
export interface RuleStatus {
  readonly id: string;
  // The version this engine ships; null for a rule the library records and this engine does not ship.
  readonly version: number | null;
  // The version the library's record holds; null when the library holds no record of the rule.
  readonly recordedVersion: number | null;
  // The revision the section's start marker carries in AGENTS.md; null when the file holds no such section.
  readonly fileVersion: number | null;
  readonly section: string;
  readonly state: RuleState;
  // TCRN-CROSS-STORY-508 R7: the order the library's record holds; absent when it holds none.
  readonly order?: number;
}

// The language a project writes its artifacts in, which picks a rule's text.
function artifactLanguage(state: Pick<WorkspaceState, "settings">): string | null {
  return state.settings.find((setting) => setting.key === "artifact.language")?.value ?? null;
}

// A rule's text in that language: Chinese for zh-CN, English for every other value and when unset.
function ruleText(rule: BuiltInRule, language: string | null): string {
  return language === "zh-CN" ? rule.body.zh : rule.body.en;
}

function recordedRule(state: Pick<WorkspaceState, "configRecords">, id: string): RuleRecordValue | null {
  const record = configRecord(state, "rule", id);
  return record === null ? null : record.value as unknown as RuleRecordValue;
}

// The managed sections of a project's AGENTS.md, by id. The managed-section writer reads the file
// the way it reads one before a write (a regular UTF-8 file or none, markers that parse); a plan
// with nothing to write writes nothing.
async function sectionsOfAgentsFile(projectRoot: string): Promise<ReadonlyMap<string, ParsedSection>> {
  const probe = await planManagedWrite({ filePath: join(projectRoot, AGENTS_FILE), file: AGENTS_FILE, desired: [], records: [] });
  return sectionsOfText(probe.before);
}

function sectionsOfText(text: string | null): ReadonlyMap<string, ParsedSection> {
  if (text === null) return new Map();
  return new Map(parseManagedFile(text, AGENTS_FILE).sections.map((section) => [section.id, section]));
}

/**
 * The state of one rule (the header of this module): from its record, the version this engine
 * ships (null when it ships none), its section as the file holds it (null when the markers are
 * not there) and the library's record of that section.
 */
export function ruleState(input: {
  readonly record: RuleRecordValue | null;
  readonly shippedVersion: number | null;
  readonly section: ParsedSection | null;
  readonly sectionRecord: ManagedSectionRecord | null;
}): RuleState {
  const { record, shippedVersion, section, sectionRecord } = input;
  if (record === null || !record.enabled) return "disabled";
  if (section === null) return "removed-from-file";
  if (sectionRecord?.state === "pending") return "pending";
  const changed = section.digest !== section.bodyDigest ||
    (sectionRecord !== null && (sectionRecord.digest !== section.digest || sectionRecord.state === "user-owned" || sectionRecord.state === "unmanaged"));
  if (changed) return "user-modified";
  if (shippedVersion !== null && shippedVersion > record.version) return "update-available";
  return "enabled";
}

function statusOf(state: Pick<WorkspaceState, "configRecords">, inFile: ReadonlyMap<string, ParsedSection>, catalog: readonly BuiltInRule[], id: string): RuleStatus {
  const section = ruleSectionId(id);
  const record = recordedRule(state, id);
  const inFileSection = inFile.get(section) ?? null;
  const shippedVersion = catalog.find((rule) => rule.id === id)?.version ?? null;
  const sectionRecord = managedSectionRecordsFor(state, AGENTS_FILE).find((entry) => entry.id === section) ?? null;
  return {
    id,
    version: shippedVersion,
    recordedVersion: record?.version ?? null,
    fileVersion: inFileSection?.rev ?? null,
    section,
    state: state.configRecords.some(entry => entry.collection === "chain" && entry.key === "identity" && entry.value.role === "coordination")
      ? (!record?.enabled ? "disabled" : shippedVersion !== null && shippedVersion > record.version ? "update-available" : "enabled")
      : ruleState({ record, shippedVersion, section: inFileSection, sectionRecord }),
    ...(record?.order === undefined ? {} : { order: record.order }),
  };
}

function ruleStatuses(state: Pick<WorkspaceState, "configRecords">, inFile: ReadonlyMap<string, ParsedSection>, catalog: readonly BuiltInRule[]): readonly RuleStatus[] {
  const shipped: readonly string[] = catalog.map((rule) => rule.id);
  const recordedOnly = configRecords(state, "rule").map((record) => record.key).filter((id) => !shipped.includes(id)).sort(compareCanonicalText);
  return [...shipped, ...recordedOnly].map((id) => statusOf(state, inFile, catalog, id));
}

export interface ListRulesInput {
  readonly configurationProjectId?: string;
  readonly libraryRoot: string;
  readonly projectRoot?: string;
  // The rules this engine ships (BUILT_IN_RULES); a test hands in another catalog here.
  readonly catalog?: readonly BuiltInRule[];
}

/**
 * Every rule this engine ships, in catalog order, then every other rule the library records, with
 * its state in the project. Writes nothing.
 */
export async function listRules(input: ListRulesInput): Promise<readonly RuleStatus[]> {
  const state = await effectiveProjectState(await materializeWorkspace(input.libraryRoot), input.configurationProjectId);
  return ruleStatuses(state, input.projectRoot === undefined ? new Map() : await sectionsOfAgentsFile(input.projectRoot), input.catalog ?? BUILT_IN_RULES);
}

export interface RuleChangeInput extends WorkspaceMutationOptions {
  readonly libraryRoot: string;
  readonly projectRoot: string;
  readonly id: string;
  // Where an original is copied before it is replaced: the device directory's backups by default.
  readonly backupRoot?: string;
  // The rules this engine ships (BUILT_IN_RULES); a test hands in another catalog here.
  readonly catalog?: readonly BuiltInRule[];
}

/** What enabling or disabling a rule did. */
export interface RuleChange {
  readonly id: string;
  readonly section: string;
  readonly file: string;
  readonly action: "enable" | "disable";
  // For enable, what the managed-section writer did with the section; for disable, disabled or unchanged.
  readonly result: ManagedSectionResult | SectionChangeResult;
  readonly written: boolean;
  // Where AGENTS.md was copied before it was replaced; null when nothing was replaced.
  readonly backupPath: string | null;
  // How many records the change wrote to the library.
  readonly recorded: number;
  readonly status: RuleStatus;
  readonly state: WorkspaceState;
}

async function commit(root: string, state: WorkspaceState, deltas: readonly ((state: WorkspaceState) => MutationDelta)[], options: WorkspaceMutationOptions): Promise<WorkspaceState> {
  if (deltas.length === 0) return state;
  const committed = await appendEvents(root, deltas, options);
  await projectConfiguration(root, committed);
  return committed;
}

/**
 * Enable a rule the engine ships: record it as enabled at the shipped version, and write its text
 * in the project's artifact language into AGENTS.md as the section rule:<id>. The section goes
 * through the managed-section writer, so a section the user changed is left as it is and waits
 * (pending), one the user kept is never written again, one whose markers the user removed is not
 * put back, and a file that does not exist is created. A library that records the rule at a
 * version newer than this engine ships is refused (RULE_VERSION_NEWER), so an older engine never
 * writes an older text over a newer one.
 *
 * TCRN-CROSS-STORY-508 R7: `order` sets the rule's order; left out, the rule keeps the order its
 * record holds. The rule sections of AGENTS.md are then arranged in the rules' order
 * (orderRuleSections), so a rule enabled with an order takes its place among them.
 *
 * TCRN-CROSS-STORY-489: when the records cannot be committed, AGENTS.md returns to what it held,
 * and a file the enable created is taken away, before the error goes on.
 */
async function changeCoordinationRule(root: string, nativeState: WorkspaceState, input: RuleChangeInput, enabled: boolean, version: number, order?: number): Promise<RuleChange> {
  const state = await effectiveProjectState(nativeState, input.configurationProjectId);
  const previous = recordedRule(state, input.id);
  const value = { enabled, version, ...(order === undefined ? {} : { order }) };
  const deltas = previous?.enabled === enabled && previous.version === version && previous.order === order ? [] : [setConfigRecordDelta({ ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "rule", key: input.id, value })];
  const committed = await commit(root, nativeState, deltas, input);
  return { id: input.id, section: ruleSectionId(input.id), file: AGENTS_FILE, action: enabled ? "enable" : "disable", result: "unchanged", written: false, backupPath: null, recorded: deltas.length, status: statusOf(scopedWorkspaceState(committed, input.configurationProjectId), new Map(), input.catalog ?? BUILT_IN_RULES, input.id), state: committed };
}

export async function enableRule(input: RuleChangeInput & { readonly order?: number }): Promise<RuleChange> {
  const catalog = input.catalog ?? BUILT_IN_RULES;
  const rule = catalog.find((entry) => entry.id === input.id) ?? fail("RULE_UNKNOWN", `the engine ships no rule ${JSON.stringify(input.id)}`, {
    id: String(input.id),
    known: catalog.map((entry) => entry.id).join(","),
  });
  // Checked before the lock, so a refused order writes neither the file nor the library.
  if (input.order !== undefined && !isOrder(input.order)) {
    fail("RULE_RECORD_INVALID", `the order of rule ${rule.id} is a positive integer`, { id: rule.id, field: "order" });
  }
  return withWorkspaceWriteLock(input.libraryRoot, async (root) => {
    const nativeState = await materializeWorkspace(root);
    if (chainIdentity(nativeState)?.role === "coordination") {
      const recorded = recordedRule(scopedWorkspaceState(nativeState, input.configurationProjectId), rule.id);
      if (recorded !== null && recorded.version > rule.version) fail("RULE_VERSION_NEWER", "recorded rule version is newer");
      return changeCoordinationRule(root, nativeState, input, true, rule.version, input.order ?? recorded?.order);
    }
    await assertManagedOutputRoot(root, input.projectRoot, nativeState);
    const state = await effectiveProjectState(nativeState, input.configurationProjectId);
    const recorded = recordedRule(state, rule.id);
    if (recorded !== null && recorded.version > rule.version) {
      fail("RULE_VERSION_NEWER", `the library records rule ${rule.id} at version ${recorded.version}; this engine ships version ${rule.version}`, {
        id: rule.id,
        recordedVersion: String(recorded.version),
        version: String(rule.version),
      });
    }
    const order = input.order ?? recorded?.order;
    const value: ConfigRecordValue = { enabled: true, version: rule.version, ...(order === undefined ? {} : { order }) };
    // The rules' orders as they will stand once this rule is recorded.
    const orders = new Map(ruleOrders(state));
    if (order !== undefined) orders.set(rule.id, order);
    const section = ruleSectionId(rule.id);
    const plan = orderRuleSections(await planManagedWrite({
      filePath: join(input.projectRoot, AGENTS_FILE),
      file: AGENTS_FILE,
      desired: [{ id: section, body: ruleText(rule, artifactLanguage(state)) }],
      records: managedSectionRecordsFor(state, AGENTS_FILE),
    }), orders);
    const applied = await applyManagedWrite(plan, { now: input.occurredAt, ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }) });
    const decision = plan.sections.find((entry) => entry.id === section);
    const deltas: ((state: WorkspaceState) => MutationDelta)[] = [];
    if (recorded === null || !recorded.enabled || recorded.version !== rule.version || recorded.order !== order) {
      deltas.push(setConfigRecordDelta({ ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "rule", key: rule.id, value }));
    }
    // Only this section's record: the other sections of the file are agents-render's to record.
    if (decision?.recordChanged === true) {
      deltas.push(setConfigRecordDelta({ ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "managed-section", key: managedSectionRecordKey(AGENTS_FILE, section), value: decision.record }));
    }
    let committed: WorkspaceState;
    try {
      committed = await commit(root, nativeState, deltas, input);
    } catch (error) {
      await putBackUnrecorded(root, nativeState, applied.written ? [plan] : []);
      throw error;
    }
    return {
      id: rule.id,
      section,
      file: AGENTS_FILE,
      action: "enable",
      result: decision?.result ?? "unchanged",
      written: applied.written,
      backupPath: applied.backupPath,
      recorded: deltas.length,
      status: statusOf(scopedWorkspaceState(committed, input.configurationProjectId), sectionsOfText(applied.written ? plan.after : plan.before), catalog, rule.id),
      state: committed,
    };
  });
}

/**
 * Disable a rule: take its section out of AGENTS.md with its markers, stop recording the section,
 * and record the rule as disabled, its order kept. A section the user changed (it differs from the
 * engine's text, waits, or was kept) goes only with force, and MANAGED_SECTION_FORCE_REQUIRED
 * otherwise; a section whose markers are gone only loses its record. A rule the engine does not ship
 * can be disabled while the library records it. When the records cannot be committed, the section
 * goes back into AGENTS.md as the file held it, the user's change with it, before the error goes on
 * (TCRN-CROSS-STORY-489).
 */
export async function disableRule(input: RuleChangeInput & { readonly force?: boolean }): Promise<RuleChange> {
  const catalog = input.catalog ?? BUILT_IN_RULES;
  return withWorkspaceWriteLock(input.libraryRoot, async (root) => {
    const nativeState = await materializeWorkspace(root);
    if (chainIdentity(nativeState)?.role === "coordination") {
      const recorded = recordedRule(scopedWorkspaceState(nativeState, input.configurationProjectId), input.id);
      const shipped = catalog.find(rule => rule.id === input.id);
      if (!recorded && !shipped) fail("RULE_UNKNOWN", "rule is not recorded or shipped");
      return changeCoordinationRule(root, nativeState, input, false, recorded?.version ?? shipped!.version, recorded?.order);
    }
    await assertManagedOutputRoot(root, input.projectRoot, nativeState);
    const state = await effectiveProjectState(nativeState, input.configurationProjectId);
    const recorded = isRuleId(input.id) ? recordedRule(state, input.id) : null;
    if (recorded === null && !catalog.some((entry) => entry.id === input.id)) {
      fail("RULE_UNKNOWN", `neither the engine nor the library knows a rule ${JSON.stringify(input.id)}`, {
        id: String(input.id),
        known: catalog.map((entry) => entry.id).join(","),
      });
    }
    const section = ruleSectionId(input.id);
    const records = managedSectionRecordsFor(state, AGENTS_FILE);
    const { change, wrote } = await takeSectionOut({
      projectRoot: input.projectRoot,
      id: section,
      records,
      at: input.occurredAt,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    });
    const deltas: ((state: WorkspaceState) => MutationDelta)[] = [];
    if (change.recordChanged && records.some((record) => record.id === section)) {
      deltas.push(removeConfigRecordDelta({ ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "managed-section", key: managedSectionRecordKey(AGENTS_FILE, section) }));
    }
    if (recorded !== null && recorded.enabled) {
      // The order stays with the record (TCRN-CROSS-STORY-508 R7).
      const value: ConfigRecordValue = { enabled: false, version: recorded.version, ...(recorded.order === undefined ? {} : { order: recorded.order }) };
      deltas.push(setConfigRecordDelta({ ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "rule", key: input.id, value }));
    }
    let committed: WorkspaceState;
    try {
      committed = await commit(root, nativeState, deltas, input);
    } catch (error) {
      await putBackUnrecorded(root, nativeState, wrote === null ? [] : [wrote]);
      throw error;
    }
    return {
      id: input.id,
      section,
      file: AGENTS_FILE,
      action: "disable",
      result: change.written || deltas.length > 0 ? "disabled" : "unchanged",
      written: change.written,
      backupPath: change.backupPath,
      recorded: deltas.length,
      status: statusOf(scopedWorkspaceState(committed, input.configurationProjectId), await sectionsOfAgentsFile(input.projectRoot), catalog, input.id),
      state: committed,
    };
  });
}
