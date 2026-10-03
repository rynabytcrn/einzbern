import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";

/**
 * TCRN-CROSS-STORY-508 R1 (MIN-236 D6): the model categories, the parent table of models.tiers.
 *
 * A category is a record {id, name, description, order}. Every record of models.tiers is filed under
 * one category, and a rule names a category, never a model: what it gets is the category's base
 * record, the one with the largest order (models-tiers.ts, baseModelsTier). The order is the rank, the
 * lower the stronger, so flagship comes before main and main before economy. The id follows the name
 * rule of a runner and is unique, and so is the order. The table is data: the engine records the
 * categories it is given and interprets none of them, except that a write may not leave a tier record
 * naming a category the table lacks (models-tiers.ts, assertModelsTablesWrite).
 *
 * The errors of both tables are this module's, so models-tiers.ts, which reads this module, and the
 * settings that read both share one reason-code list.
 */
export const MODELS_CATEGORY_SETTING_KEY = "models.category" as const;
/** The default categories, strongest first. */
export const MODELS_CATEGORY_DEFAULT_IDS: readonly string[] = Object.freeze(["flagship", "main", "economy"]);
/** The category the knowledge language reads its economy model from (knowledge-language.ts). */
export const MODELS_ECONOMY_CATEGORY = "economy" as const;
/**
 * The step between the orders the engine numbers itself: the default tables, the tables a legacy
 * tiers value reads as, and the categories derived for tier records that name a category the default
 * table lacks. A step of ten leaves room for nine records between two numbered ones.
 */
export const MODELS_ORDER_STEP = 10;

export const MODELS_REASON_CODES = Object.freeze([
  "MODELS_CATEGORY_DUPLICATE",
  "MODELS_CATEGORY_EMPTY",
  "MODELS_CATEGORY_INVALID",
  "MODELS_CATEGORY_IN_USE",
  "MODELS_CATEGORY_UNKNOWN",
  "MODELS_ORDER_DUPLICATE",
  "MODELS_TIERS_INVALID",
] as const);

export type ModelsReasonCode = typeof MODELS_REASON_CODES[number];

export class ModelsSettingError extends Error {
  readonly reasonCode: ModelsReasonCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reasonCode: ModelsReasonCode, message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ModelsSettingError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface ModelsCategoryRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly order: number;
}

/** A category table, in ascending order. */
export type ModelsCategories = readonly ModelsCategoryRecord[];

export function modelsFail(reasonCode: ModelsReasonCode, message: string, details: Readonly<Record<string, unknown>>): never {
  throw new ModelsSettingError(reasonCode, message, details);
}

// A category id, a host, a tier and a runner are names: a lowercase letter first, then lowercase
// letters, digits, dot, underscore or hyphen, so the system variables section
// of AGENTS.md (variables-sections.ts) never has to escape one.
const NAME = /^[a-z][a-z0-9._-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CATEGORY_NAME_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
const CATEGORY_DESCRIPTION_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
const CATEGORY_FIELDS = "description,id,name,order";

export function isModelsObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A name (NAME), or the reason code refusing it at `path`. */
export function modelsName(value: unknown, path: string, reasonCode: ModelsReasonCode): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    modelsFail(reasonCode, `${path} must be a lowercase name (a-z first, then a-z, 0-9, dot, underscore or hyphen)`, { path });
  }
  return value;
}

/** A text without control characters, or the reason code refusing it. */
export function modelsText(value: unknown, path: string, _maximum: number, reasonCode: ModelsReasonCode, minimum = 0): string {
  if (typeof value !== "string" || value.length < minimum || CONTROL.test(value)) {
    modelsFail(reasonCode, `${path} must be text with at least ${minimum} characters and no control characters`, { path });
  }
  return value;
}

/** An order: a positive integer. */
export function modelsOrder(value: unknown, path: string, reasonCode: ModelsReasonCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    modelsFail(reasonCode, `${path} must be a positive integer`, { path });
  }
  return value;
}

/** The record's fields must be exactly `fields` (sorted, comma-joined). */
export function assertModelsFields(value: Readonly<Record<string, unknown>>, fields: string, path: string, reasonCode: ModelsReasonCode): void {
  if (Object.keys(value).sort(compareCanonicalText).join(",") !== fields) {
    modelsFail(reasonCode, `${path} requires exactly ${fields.split(",").join(", ")}`, { path });
  }
}

/**
 * Refuse a table two of whose records share an order (MODELS_ORDER_DUPLICATE), naming the later one by
 * its place in the value as written. `table` is the setting key.
 */
export function assertUniqueModelsOrders(records: readonly { readonly order: number }[], table: string): void {
  const seen = new Set<number>();
  for (const [index, record] of records.entries()) {
    if (seen.has(record.order)) {
      modelsFail("MODELS_ORDER_DUPLICATE", `${table}[${index}].order ${record.order} is already the order of another record; an order is unique in its table`, {
        path: `${table}[${index}].order`,
        order: record.order,
      });
    }
    seen.add(record.order);
  }
}

/** The records in ascending order. */
export function sortedByModelsOrder<T extends { readonly order: number }>(records: readonly T[]): readonly T[] {
  return Object.freeze([...records].sort((left, right) => left.order - right.order));
}

/** Parse the JSON text of a stored table, or the reason code refusing it. */
export function parseModelsJson(value: string, key: string, reasonCode: ModelsReasonCode): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return modelsFail(reasonCode, `${key} must contain JSON`, { path: key });
  }
}

/**
 * The value as a category table, in ascending order: an array of exactly {id, name, description,
 * order}, ids and orders unique. MODELS_CATEGORY_INVALID names the first field that is not what it
 * should be; a repeated id is MODELS_CATEGORY_DUPLICATE and a repeated order MODELS_ORDER_DUPLICATE.
 */
export function validateModelsCategory(value: unknown): ModelsCategories {
  const key = MODELS_CATEGORY_SETTING_KEY;
  if (!Array.isArray(value)) modelsFail("MODELS_CATEGORY_INVALID", `${key} must be an array of category records`, { path: key });
  const records = (value as readonly unknown[]).map((row, index): ModelsCategoryRecord => {
    const path = `${key}[${index}]`;
    if (!isModelsObject(row)) modelsFail("MODELS_CATEGORY_INVALID", `${path} must be an object with id, name, description and order`, { path });
    assertModelsFields(row, CATEGORY_FIELDS, path, "MODELS_CATEGORY_INVALID");
    return Object.freeze({
      id: modelsName(row.id, `${path}.id`, "MODELS_CATEGORY_INVALID"),
      name: modelsText(row.name, `${path}.name`, CATEGORY_NAME_MAX_LENGTH, "MODELS_CATEGORY_INVALID", 1),
      description: modelsText(row.description, `${path}.description`, CATEGORY_DESCRIPTION_MAX_LENGTH, "MODELS_CATEGORY_INVALID"),
      order: modelsOrder(row.order, `${path}.order`, "MODELS_CATEGORY_INVALID"),
    });
  });
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (ids.has(record.id)) {
      modelsFail("MODELS_CATEGORY_DUPLICATE", `${key}[${index}].id ${record.id} is already the id of another category; an id is unique`, {
        path: `${key}[${index}].id`,
        category: record.id,
      });
    }
    ids.add(record.id);
  }
  assertUniqueModelsOrders(records, key);
  return sortedByModelsOrder(records);
}

/** Parse a stored models.category value: JSON text holding a category table. */
export function parseModelsCategory(value: string): ModelsCategories {
  return validateModelsCategory(parseModelsJson(value, MODELS_CATEGORY_SETTING_KEY, "MODELS_CATEGORY_INVALID"));
}

/** The value a models.category write stores: the table as canonical JSON, in ascending order. */
export function normalizeModelsCategoryValue(value: string): string {
  return canonicalJson(parseModelsCategory(value));
}

/**
 * The category ids in the order the engine ranks them when it numbers a table itself: the default
 * categories that are present, strongest first, then the others by name.
 */
export function rankedModelsCategoryIds(ids: Iterable<string>): readonly string[] {
  const present = new Set(ids);
  const defaults = MODELS_CATEGORY_DEFAULT_IDS.filter((id) => present.has(id));
  return Object.freeze([...defaults, ...[...present].filter((id) => !MODELS_CATEGORY_DEFAULT_IDS.includes(id)).sort(compareCanonicalText)]);
}

/**
 * The category table a library reads while models.category is unset: the default categories, then
 * every other id in `referenced` by name, numbered on in steps of MODELS_ORDER_STEP. The name of a
 * category the engine numbers is its id, and its description is empty. With nothing referenced beyond
 * the defaults it is the default table, so a new library's categories are flagship, main and economy;
 * a tiers table read from a legacy value that names another tier keeps that tier's category.
 */
export function deriveModelsCategory(referenced: Iterable<string> = []): ModelsCategories {
  const ids = rankedModelsCategoryIds([...MODELS_CATEGORY_DEFAULT_IDS, ...referenced]);
  return Object.freeze(ids.map((id, index) => Object.freeze({ id, name: id, description: "", order: MODELS_ORDER_STEP * (index + 1) })));
}

/** The default category table: flagship, main and economy, in that order. */
export function defaultModelsCategory(): ModelsCategories {
  return deriveModelsCategory();
}

/** The catalog's default value for models.category: the default table as canonical JSON. */
export const MODELS_CATEGORY_DEFAULT_VALUE: string = canonicalJson(defaultModelsCategory());
