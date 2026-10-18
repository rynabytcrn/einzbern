import { absolutePathLine } from "./managed-sections.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-484 R1 (MIN-227 D12; TCRN-CROSS-SUB-340): custom variables. A variable is a
// project-level configuration record of the variable collection (config-records.ts), keyed by its
// name, so it travels with the library and every device that merges the library reads the same
// variables. It is not a setting: the settings catalog is the engine's own closed vocabulary, and a
// variable is whatever the project wants its rules to be able to name (deploy.host, say). Its
// record holds a type, a value and a description; the value is text in every type, so a record
// stays canonical JSON whatever its type.
//
// A variable ends up in AGENTS.md (variables-sections.ts), which a project commits, so a value or a
// description shaped like a credential is refused when it is written (VARIABLE_SECRET_SHAPED). That
// refusal, like the refusal of a name the settings catalog uses, belongs to the write path only: a
// replay checks the shape of a record and nothing else, so a later, stricter heuristic never turns
// a library's recorded history into rejected events.
//
// TCRN-CROSS-STORY-508 R7 (MIN-236 D7): a record may also hold an order, a positive integer that
// places the variable in the custom section of AGENTS.md (variables-sections.ts). The variables
// with an order come first, by order; the others follow by name, as every variable did before.

import { configRecords, removeConfigRecord, setConfigRecord } from "./config-records.js";
import { SETTINGS_CATALOG } from "./settings.js";
import type { WorkspaceMutationOptions, WorkspaceState } from "./workspace.js";

export const VARIABLES_REASON_CODES = Object.freeze([
  "VARIABLE_DESCRIPTION_INVALID",
  "VARIABLE_NAME_INVALID",
  "VARIABLE_RECORD_INVALID",
  "VARIABLE_SECRET_SHAPED",
  "VARIABLE_TYPE_INVALID",
  "VARIABLE_VALUE_INVALID",
] as const);

export type VariablesReasonCode = typeof VARIABLES_REASON_CODES[number];

export class VariableError extends Error {
  readonly reasonCode: VariablesReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: VariablesReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "VariableError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: VariablesReasonCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new VariableError(reasonCode, message, details);
}

export const VARIABLE_TYPES = Object.freeze(["boolean", "number", "string"] as const);
export type VariableType = typeof VARIABLE_TYPES[number];

/** What a variable's record holds; its name is the record's key. A record without an order has no order field. */
export const VARIABLE_EXPORT_TARGETS = Object.freeze(["agents", "handoff"] as const);
export type VariableExportTarget = typeof VARIABLE_EXPORT_TARGETS[number];

export interface VariableRecordValue {
  /** Missing on historical events means legacy AGENTS export; new declarations default to none. */
  readonly exports?: readonly VariableExportTarget[];
  readonly type: VariableType;
  readonly value: string;
  readonly description: string;
  readonly order?: number;
}

export interface Variable extends VariableRecordValue {
  readonly name: string;
}

export const VARIABLE_NAME_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
export const VARIABLE_VALUE_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
export const VARIABLE_DESCRIPTION_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;

// A lowercase letter first, then letters, digits, dot, underscore or hyphen.
const NAME = /^[a-z][A-Za-z0-9._-]*$/u;
// A decimal number as text: an optional minus, an integer part without leading zeros, an optional
// fraction. No exponent, no plus sign, no surrounding space.
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RECORD_FIELDS = "description,type,value";
const ORDERED_RECORD_FIELDS = "description,order,type,value";

export function isVariableName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

// TCRN-CROSS-STORY-508 R7: an order is a positive integer.
function isOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * TCRN-CROSS-STORY-508 R7: how two records compare by their orders alone. A record with an order
 * goes before one without, a lower order before a higher one, and two records of one order, or
 * without one, compare equal, so a stable sort keeps whatever order they had.
 */
export function compareRecordOrder(left: { readonly order?: number | undefined }, right: { readonly order?: number | undefined }): number {
  if (left.order === undefined || right.order === undefined) return left.order === right.order ? 0 : left.order === undefined ? 1 : -1;
  return left.order - right.order;
}

export function isVariableType(value: unknown): value is VariableType {
  return typeof value === "string" && (VARIABLE_TYPES as readonly string[]).includes(value);
}

function assertName(name: unknown): asserts name is string {
  if (!isVariableName(name)) {
    fail("VARIABLE_NAME_INVALID", `${String(name)} is not a variable name: a lowercase letter, then letters, digits, dots, underscores or hyphens, at most ${VARIABLE_NAME_MAX_LENGTH}`, { name: String(name) });
  }
}

function assertType(type: unknown, name: string): asserts type is VariableType {
  if (!isVariableType(type)) {
    fail("VARIABLE_TYPE_INVALID", `the type of ${name} is one of ${VARIABLE_TYPES.join(", ")}`, { name, type: String(type) });
  }
}

function assertValue(type: VariableType, value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length > VARIABLE_VALUE_MAX_LENGTH || CONTROL.test(value)) {
    fail("VARIABLE_VALUE_INVALID", `the value of ${name} is text of at most ${VARIABLE_VALUE_MAX_LENGTH} characters without control characters`, { name, type });
  }
  if (type === "number" && !NUMBER.test(value)) {
    fail("VARIABLE_VALUE_INVALID", `the value of ${name} is a number: digits, an optional minus and an optional decimal fraction`, { name, type });
  }
  if (type === "boolean" && value !== "true" && value !== "false") {
    fail("VARIABLE_VALUE_INVALID", `the value of ${name} is true or false`, { name, type });
  }
}

function assertDescription(description: unknown, name: string): asserts description is string {
  if (typeof description !== "string" || description.length > VARIABLE_DESCRIPTION_MAX_LENGTH || CONTROL.test(description)) {
    fail("VARIABLE_DESCRIPTION_INVALID", `the description of ${name} is text of at most ${VARIABLE_DESCRIPTION_MAX_LENGTH} characters without control characters`, { name });
  }
}

function assertOrder(order: unknown, name: string): void {
  if (order !== undefined && !isOrder(order)) {
    fail("VARIABLE_RECORD_INVALID", `the order of ${name} is a positive integer`, { name, field: "order" });
  }
}

/** The check the variable collection of config-records.ts applies to a record: shape only, as a replay needs. */
export function checkVariableRecordValue(value: Readonly<Record<string, unknown>>, key: string): void {
  assertName(key);
  const fields = Object.keys(value).filter(key => key !== "exports").sort().join(",");
  if (fields !== RECORD_FIELDS && fields !== ORDERED_RECORD_FIELDS) {
    fail("VARIABLE_RECORD_INVALID", `a variable record holds exactly type, value and description, and may hold an order; ${key} does not`, { name: key });
  }
  assertExports(value.exports, key);
  assertType(value.type, key);
  assertValue(value.type, value.value, key);
  assertDescription(value.description, key);
  assertOrder(value.order, key);
}

// Where a credential's shape starts: the text's start, or a character that cannot be part of a token.
const TOKEN_START = "(?:^|[^A-Za-z0-9_])";
const SECRET_PREFIXES: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["sk-", new RegExp(`${TOKEN_START}sk-[A-Za-z0-9]`, "u")],
  ["AKIA", new RegExp(`${TOKEN_START}AKIA[A-Z0-9]{12,}`, "u")],
  ["ASIA", new RegExp(`${TOKEN_START}ASIA[A-Z0-9]{12,}`, "u")],
  ["ghp_", new RegExp(`${TOKEN_START}ghp_[A-Za-z0-9]`, "u")],
  ["gho_", new RegExp(`${TOKEN_START}gho_[A-Za-z0-9]`, "u")],
  ["github_pat_", new RegExp(`${TOKEN_START}github_pat_[A-Za-z0-9]`, "u")],
  ["xoxb-", new RegExp(`${TOKEN_START}xoxb-[A-Za-z0-9]`, "u")],
  ["xoxp-", new RegExp(`${TOKEN_START}xoxp-[A-Za-z0-9]`, "u")],
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u],
  ["jwt", new RegExp(`${TOKEN_START}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.`, "u")],
]);
const HIGH_ENTROPY_MIN_LENGTH = 32;
// Measured on samples: random base64 of 32 to 40 characters scores 4.4 to 4.8 bits per character;
// word slugs and camel-case identifiers of that length score 3.8 to 4.2.
const HIGH_ENTROPY_BITS = 4.25;

function entropyBitsPerCharacter(text: string): number {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

// A token of 32 characters or more that reads as random: 32 hexadecimal digits or more (hyphens
// allowed between them, so a UUID counts), or base64-style text that mixes letters and digits at
// the entropy random bytes have.
function isHighEntropyToken(token: string): boolean {
  if (token.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (/^[0-9A-Fa-f-]+$/u.test(token) && token.replace(/-/gu, "").length >= HIGH_ENTROPY_MIN_LENGTH) return true;
  return /^[A-Za-z0-9+/=_-]+$/u.test(token) && /[0-9]/u.test(token) && /[A-Za-z]/u.test(token) &&
    entropyBitsPerCharacter(token) >= HIGH_ENTROPY_BITS;
}

function assertExports(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
      value.some(target => !VARIABLE_EXPORT_TARGETS.includes(target))) {
    fail("VARIABLE_RECORD_INVALID", `${name} exports must be unique agents/handoff targets`, { name });
  }
}

/** Historical records retain their original export contract without rewriting events. */
export function variableExportTargets(variable: VariableRecordValue): readonly VariableExportTarget[] {
  return variable.exports ?? ["agents"];
}

/**
 * Whether a text is shaped like a credential: a known key prefix (sk-, AKIA, ASIA, ghp_, gho_,
 * github_pat_, xoxb-, xoxp-), a PEM private-key header, a JSON web token, or a token of at least
 * 32 characters that reads as random. Returns what it matched, or null.
 */
export function looksSecretShaped(text: string): string | null {
  for (const [label, pattern] of SECRET_PREFIXES) {
    if (pattern.test(text)) return label;
  }
  for (const token of text.split(/[\s"'`,;:()[\]{}<>]+/u)) {
    if (isHighEntropyToken(token.replace(/=+$/u, "")) || isHighEntropyToken(token)) return "high-entropy";
  }
  return null;
}

/** All portable variable consumers use the same allowlist and content withholding. */
export function variableExportDecision(variable: VariableRecordValue, target: VariableExportTarget): "not-exported" | "absolute-path" | "secret-shaped" | null {
  if (!variableExportTargets(variable).includes(target)) return "not-exported";
  if (absolutePathLine(`${variable.value}\n${variable.description}`) !== null) return "absolute-path";
  return looksSecretShaped(variable.value) !== null || looksSecretShaped(variable.description) !== null ? "secret-shaped" : null;
}

/** The variables a merged state holds, sorted by name; a variable with an order carries it. */
export function listVariables(state: Pick<WorkspaceState, "configRecords">): readonly Variable[] {
  return configRecords(state, "variable").map((record) => ({ name: record.key, ...(record.value as unknown as VariableRecordValue) }));
}

/**
 * TCRN-CROSS-STORY-508 R7: the variables in the order AGENTS.md renders them: those with an order
 * first, by order, then the others; variables of one order, and those without one, by name.
 */
export function variablesInRenderOrder(state: Pick<WorkspaceState, "configRecords">): readonly Variable[] {
  return [...listVariables(state)].sort(compareRecordOrder);
}

export interface VariableSetInput {
  readonly exports?: readonly VariableExportTarget[];
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly description?: string;
  // TCRN-CROSS-STORY-508 R7: the variable's place in the custom section; left out, it has none.
  readonly order?: number;
}

/**
 * Check a variable a writer asks for: its name (not one of the settings catalog's keys), its type,
 * its value as that type, its description and its order; then refuse a value or description shaped
 * like a credential (VARIABLE_SECRET_SHAPED, naming the field and what it matched).
 */
export function checkVariableInput(input: VariableSetInput): Variable {
  assertName(input.name);
  assertExports(input.exports, input.name);
  if (SETTINGS_CATALOG.some((entry) => entry.key === input.name) || /^(engine|models|quota|execution|storage|workspace|portal)\./u.test(input.name)) {
    fail("VARIABLE_NAME_INVALID", `${input.name} is a system setting's key; a variable needs a name of its own`, { name: input.name, reason: "system-setting" });
  }
  assertType(input.type, input.name);
  assertValue(input.type, input.value, input.name);
  const description = input.description ?? "";
  assertDescription(description, input.name);
  assertOrder(input.order, input.name);
  for (const [field, text] of [["value", input.value], ["description", description]] as const) {
    const matched = looksSecretShaped(text);
    if (matched !== null) {
      fail("VARIABLE_SECRET_SHAPED", `the ${field} of ${input.name} looks like a credential (${matched}); a variable ends up in AGENTS.md, so it never holds one`, { name: input.name, field, matched });
    }
  }
  return { name: input.name, type: input.type, value: input.value, description, exports: [...(input.exports ?? [])], ...(input.order === undefined ? {} : { order: input.order }) };
}

/** Create or change one variable in a library: the record holds what the input says, an order only when it names one. */
export async function setVariable(workspaceRoot: string, input: VariableSetInput & WorkspaceMutationOptions): Promise<WorkspaceState> {
  const variable = checkVariableInput(input);
  const value: VariableRecordValue = {
    type: variable.type,
    value: variable.value,
    description: variable.description,
    exports: variable.exports ?? [],
    ...(variable.order === undefined ? {} : { order: variable.order }),
  };
  return setConfigRecord(workspaceRoot, { ...input, ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "variable", key: variable.name, value });
}

/** Remove one variable from a library; a name the library does not hold is refused (CONFIG_RECORD_NOT_FOUND). */
export async function removeVariable(workspaceRoot: string, input: { readonly name: string } & WorkspaceMutationOptions): Promise<WorkspaceState> {
  return removeConfigRecord(workspaceRoot, { ...input, ...(input.configurationProjectId === undefined ? {} : { projectId: input.configurationProjectId }), collection: "variable", key: input.name });
}
