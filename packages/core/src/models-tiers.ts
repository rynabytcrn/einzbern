import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";
import {
  MODELS_CATEGORY_SETTING_KEY,
  MODELS_ORDER_STEP,
  assertModelsFields,
  assertUniqueModelsOrders,
  deriveModelsCategory,
  isModelsObject,
  modelsFail,
  modelsName,
  modelsOrder,
  modelsText,
  parseModelsCategory,
  parseModelsJson,
  rankedModelsCategoryIds,
  sortedByModelsOrder,
} from "./models-category.js";
import type { ModelsCategories } from "./models-category.js";

/**
 * TCRN-CROSS-STORY-508 R2, R4 (MIN-236 D5, D6): the model tiers, one table of records.
 *
 * A record is {order, category, runner, model, effort, note}: the category it is filed under
 * (models-category.ts), the runner that executes it (a host, or another program such as codex-cli),
 * the model, the effort and a short note. The order is unique across the table, and the lower it is
 * the stronger the record: escalation goes from a larger order to a smaller one. A rule names only a
 * category; what it gets is the category's base record, the one with the largest order, whatever its
 * runner (baseModelsTier). No model name appears in this file (MIN-152 D3), which is why a default
 * record's model and effort are empty: unfilled until the Owner fills them.
 *
 * TCRN-CROSS-STORY-484 R3 gave each host a table, {<host>: {<tier>: {runner, model, effort}}}, and
 * before it execution.dispatchTiers held {<host>: {<tier>: {model, effort} | null}}. Both still count,
 * read as records without a byte of their events changing (legacyHostTiersToModelsTiers): each tier
 * name is a category, each host and tier one record keeping its runner, numbered in steps of
 * MODELS_ORDER_STEP category by category, and within a category the hosts in descending name order,
 * so the host whose name sorts first holds the category's largest order and is its base record.
 */
export const MODELS_TIERS_SETTING_KEY = "models.tiers" as const;
export const LEGACY_DISPATCH_TIERS_SETTING_KEY = "execution.dispatchTiers" as const;
/** The hosts of the default table, and of every legacy default table. */
export const MODELS_TIERS_DEFAULT_HOSTS: readonly string[] = Object.freeze(["claude-code", "codex"]);

export interface ModelsTierRecord {
  readonly order: number;
  readonly category: string;
  readonly runner: string;
  readonly model: string;
  readonly effort: string;
  readonly note: string;
}

/** A tiers table, in ascending order. */
export type ModelsTiers = readonly ModelsTierRecord[];

/** A setting as the reads below take it: a key and its stored value. */
export interface ModelsSettingView {
  readonly key: string;
  readonly value: string;
}

const MODEL_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
const EFFORT_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
const NOTE_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;
const TIER_FIELDS = "category,effort,model,note,order,runner";

/** How a record is named where a list of records is reported: models.tiers.<order>. */
export function modelsTierReference(record: Pick<ModelsTierRecord, "order">): string {
  return `${MODELS_TIERS_SETTING_KEY}.${record.order}`;
}

/**
 * The value as a tiers table, in ascending order: an array of exactly {order, category, runner, model,
 * effort, note}, orders unique. MODELS_TIERS_INVALID names the first field that is not what it should
 * be; a repeated order is MODELS_ORDER_DUPLICATE. Whether each category exists is a question for the
 * write (assertModelsTablesWrite), not for the shape.
 */
export function validateModelsTiers(value: unknown): ModelsTiers {
  const key = MODELS_TIERS_SETTING_KEY;
  if (!Array.isArray(value)) modelsFail("MODELS_TIERS_INVALID", `${key} must be an array of tier records`, { path: key });
  const records = (value as readonly unknown[]).map((row, index): ModelsTierRecord => {
    const path = `${key}[${index}]`;
    if (!isModelsObject(row)) modelsFail("MODELS_TIERS_INVALID", `${path} must be an object with order, category, runner, model, effort and note`, { path });
    assertModelsFields(row, TIER_FIELDS, path, "MODELS_TIERS_INVALID");
    return Object.freeze({
      order: modelsOrder(row.order, `${path}.order`, "MODELS_TIERS_INVALID"),
      category: modelsName(row.category, `${path}.category`, "MODELS_TIERS_INVALID"),
      runner: modelsName(row.runner, `${path}.runner`, "MODELS_TIERS_INVALID"),
      model: modelsText(row.model, `${path}.model`, MODEL_MAX_LENGTH, "MODELS_TIERS_INVALID"),
      effort: modelsText(row.effort, `${path}.effort`, EFFORT_MAX_LENGTH, "MODELS_TIERS_INVALID"),
      note: modelsText(row.note, `${path}.note`, NOTE_MAX_LENGTH, "MODELS_TIERS_INVALID"),
    });
  });
  assertUniqueModelsOrders(records, key);
  return sortedByModelsOrder(records);
}

/** The value a models.tiers write stores: the table as canonical JSON, in ascending order. A legacy per-host value is refused. */
export function normalizeModelsTiersValue(value: string): string {
  return canonicalJson(validateModelsTiers(parseModelsJson(value, MODELS_TIERS_SETTING_KEY, "MODELS_TIERS_INVALID")));
}

interface LegacyTierEntry {
  readonly runner: string;
  readonly model: string;
  readonly effort: string;
}

// {<host>: {<tier>: {runner, model, effort}}}, the value TCRN-CROSS-STORY-484 R3 wrote. It is read,
// never written.
type LegacyHostTiers = Readonly<Record<string, Readonly<Record<string, LegacyTierEntry>>>>;

function legacyEntry(value: unknown, path: string): LegacyTierEntry {
  if (!isModelsObject(value)) modelsFail("MODELS_TIERS_INVALID", `${path} must be an object with runner, model and effort`, { path });
  assertModelsFields(value, "effort,model,runner", path, "MODELS_TIERS_INVALID");
  return {
    runner: modelsName(value.runner, `${path}.runner`, "MODELS_TIERS_INVALID"),
    model: modelsText(value.model, `${path}.model`, MODEL_MAX_LENGTH, "MODELS_TIERS_INVALID"),
    effort: modelsText(value.effort, `${path}.effort`, EFFORT_MAX_LENGTH, "MODELS_TIERS_INVALID"),
  };
}

function legacyHostTiers(value: unknown, label: string, row: (entry: unknown, path: string, host: string) => LegacyTierEntry | null): LegacyHostTiers {
  if (!isModelsObject(value)) modelsFail("MODELS_TIERS_INVALID", `${label} must be an object keyed by host`, { path: label });
  return Object.fromEntries(Object.entries(value).map(([host, tiers]) => {
    const hostPath = `${label}.${host}`;
    modelsName(host, hostPath, "MODELS_TIERS_INVALID");
    if (!isModelsObject(tiers)) modelsFail("MODELS_TIERS_INVALID", `${hostPath} must be an object keyed by tier name`, { path: hostPath });
    const entries = Object.entries(tiers).flatMap(([tier, entry]): (readonly [string, LegacyTierEntry])[] => {
      const tierPath = `${hostPath}.${tier}`;
      modelsName(tier, tierPath, "MODELS_TIERS_INVALID");
      const read = row(entry, tierPath, host);
      return read === null ? [] : [[tier, read] as const];
    });
    return [host, Object.fromEntries(entries)];
  }));
}

// Number a legacy per-host table: the tier names are the categories, ranked as the engine ranks them
// (rankedModelsCategoryIds); within each category the hosts in descending name order.
function numberLegacyHostTiers(tables: LegacyHostTiers): ModelsTiers {
  const hosts = Object.keys(tables).sort(compareCanonicalText).reverse();
  const categories = rankedModelsCategoryIds(hosts.flatMap((host) => Object.keys(tables[host] ?? {})));
  const records: ModelsTierRecord[] = [];
  for (const category of categories) {
    for (const host of hosts) {
      const entry = tables[host]?.[category];
      if (entry === undefined) continue;
      records.push(Object.freeze({ order: MODELS_ORDER_STEP * (records.length + 1), category, runner: entry.runner, model: entry.model, effort: entry.effort, note: "" }));
    }
  }
  return Object.freeze(records);
}

/** Read a TCRN-CROSS-STORY-484 value, {<host>: {<tier>: {runner, model, effort}}}, as a tiers table. */
export function legacyHostTiersToModelsTiers(value: unknown): ModelsTiers {
  return numberLegacyHostTiers(legacyHostTiers(value, MODELS_TIERS_SETTING_KEY, legacyEntry));
}

/**
 * Read an execution.dispatchTiers value ({<host>: {<tier>: {model, effort} | null}}) as a tiers table.
 * Each row gains the host it sits under as its runner; a null row was an unfilled tier and is left
 * out. A value that is not the old shape is refused with MODELS_TIERS_INVALID.
 */
export function legacyTiersToModelsTiers(value: unknown): ModelsTiers {
  return numberLegacyHostTiers(legacyHostTiers(value, LEGACY_DISPATCH_TIERS_SETTING_KEY, (entry, path, host) => {
    if (entry === null) return null;
    if (!isModelsObject(entry)) modelsFail("MODELS_TIERS_INVALID", `${path} requires exactly model and effort`, { path });
    assertModelsFields(entry, "effort,model", path, "MODELS_TIERS_INVALID");
    return {
      runner: host,
      model: modelsText(entry.model, `${path}.model`, MODEL_MAX_LENGTH, "MODELS_TIERS_INVALID"),
      effort: modelsText(entry.effort, `${path}.effort`, EFFORT_MAX_LENGTH, "MODELS_TIERS_INVALID"),
    };
  }));
}

/** legacyTiersToModelsTiers over a stored execution.dispatchTiers value, as canonical JSON. */
export function legacyTiersValueToModelsTiersValue(value: string): string {
  return canonicalJson(legacyTiersToModelsTiers(parseModelsJson(value, LEGACY_DISPATCH_TIERS_SETTING_KEY, "MODELS_TIERS_INVALID")));
}

/**
 * Parse a stored models.tiers value: JSON text holding a tiers table, or a TCRN-CROSS-STORY-484
 * per-host table, which reads as records (legacyHostTiersToModelsTiers).
 */
export function parseModelsTiers(value: string): ModelsTiers {
  const parsed = parseModelsJson(value, MODELS_TIERS_SETTING_KEY, "MODELS_TIERS_INVALID");
  return isModelsObject(parsed) ? legacyHostTiersToModelsTiers(parsed) : validateModelsTiers(parsed);
}

/**
 * A recorded models.tiers value as the current shape: a per-host value converted to canonical JSON
 * records, anything else returned as it is (the value's own validation then judges it). Replay keeps
 * the converted value as the setting's current value; the event keeps its bytes.
 */
export function currentModelsTiersValue(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  return isModelsObject(parsed) ? canonicalJson(legacyHostTiersToModelsTiers(parsed)) : value;
}

/**
 * The default table, the TCRN-CROSS-STORY-484 default read as records: each default host with the
 * default categories flagship, main and economy, its own runner, unfilled.
 */
export function defaultModelsTiers(): ModelsTiers {
  return legacyHostTiersToModelsTiers(Object.fromEntries(MODELS_TIERS_DEFAULT_HOSTS.map((host) => [
    host,
    Object.fromEntries(deriveModelsCategory().map((category) => [category.id, { runner: host, model: "", effort: "" }])),
  ])));
}

/** The catalog's default value for models.tiers: the default table as canonical JSON. */
export const MODELS_TIERS_DEFAULT_VALUE: string = canonicalJson(defaultModelsTiers());

/**
 * The effective tiers table of a list of settings: the recorded value when there is one, otherwise the
 * default table. Replay has already carried a recorded execution.dispatchTiers value over as
 * models.tiers, so a workspace's settings never need a second lookup.
 */
export function readModelsTiers(settings: readonly ModelsSettingView[]): ModelsTiers {
  const recorded = settings.find((setting) => setting.key === MODELS_TIERS_SETTING_KEY)?.value;
  return recorded === undefined ? defaultModelsTiers() : parseModelsTiers(recorded);
}

/**
 * The effective category table of a list of settings: the recorded value when there is one, otherwise
 * the default categories and every other category the effective tiers name (deriveModelsCategory), so
 * a tiers table read from a legacy value never names a category that is not there.
 */
export function readModelsCategory(settings: readonly ModelsSettingView[]): ModelsCategories {
  const recorded = settings.find((setting) => setting.key === MODELS_CATEGORY_SETTING_KEY)?.value;
  return recorded === undefined
    ? deriveModelsCategory(readModelsTiers(settings).map((record) => record.category))
    : parseModelsCategory(recorded);
}

/**
 * TCRN-CROSS-STORY-508 R4, first half: the base record of a category, the one with the largest order,
 * whatever its runner. A category no record is filed under is MODELS_CATEGORY_EMPTY.
 */
export function baseModelsTier(tiers: ModelsTiers, category: string): ModelsTierRecord {
  let base: ModelsTierRecord | undefined;
  for (const record of tiers) {
    if (record.category === category && (base === undefined || record.order > base.order)) base = record;
  }
  if (base === undefined) modelsFail("MODELS_CATEGORY_EMPTY", `${MODELS_TIERS_SETTING_KEY} holds no record of the category ${category}`, { category });
  return base;
}

/**
 * TCRN-CROSS-STORY-508 R1, R2: a write of models.category or models.tiers (settings-set, or
 * settings-remove when `value` is null) may not leave a tier record naming a category the category
 * table lacks. A tiers write is checked against the categories as they stand, so a record naming a
 * category that does not exist is MODELS_CATEGORY_UNKNOWN; a category write is checked against the
 * tiers as they stand, so dropping a category records still name is MODELS_CATEGORY_IN_USE, with the
 * records in `references`. Replay checks no reference: a merge may bring the two tables apart, and the
 * next write of either names what is missing. Every other key passes.
 */
export function assertModelsTablesWrite(settings: readonly ModelsSettingView[], key: string, value: string | null): void {
  if (key !== MODELS_TIERS_SETTING_KEY && key !== MODELS_CATEGORY_SETTING_KEY) return;
  const after = [...settings.filter((setting) => setting.key !== key), ...(value === null ? [] : [{ key, value }])];
  const categories = key === MODELS_TIERS_SETTING_KEY ? readModelsCategory(settings) : readModelsCategory(after);
  const known = new Set(categories.map((category) => category.id));
  const dangling = readModelsTiers(after).filter((record) => !known.has(record.category));
  if (dangling.length === 0) return;
  if (key === MODELS_CATEGORY_SETTING_KEY) {
    const removed = new Set(readModelsCategory(settings).map((category) => category.id).filter((id) => !known.has(id)));
    const referencing = dangling.filter((record) => removed.has(record.category));
    if (referencing.length > 0) {
      const ids = [...new Set(referencing.map((record) => record.category))];
      const references = referencing.map(modelsTierReference);
      modelsFail("MODELS_CATEGORY_IN_USE", `${MODELS_CATEGORY_SETTING_KEY} may not drop ${ids.join(", ")}: ${references.join(", ")} still name it`, {
        path: MODELS_CATEGORY_SETTING_KEY,
        category: ids[0],
        categories: ids,
        references,
      });
    }
  }
  const first = dangling[0] as ModelsTierRecord;
  modelsFail("MODELS_CATEGORY_UNKNOWN", `${modelsTierReference(first)} names the category ${first.category}, which ${MODELS_CATEGORY_SETTING_KEY} does not hold`, {
    path: `${modelsTierReference(first)}.category`,
    category: first.category,
    references: dangling.map(modelsTierReference),
  });
}
