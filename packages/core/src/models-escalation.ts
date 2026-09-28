// SPDX-License-Identifier: Apache-2.0

import { MODELS_CATEGORY_SETTING_KEY, isModelsObject, modelsFail, modelsName, validateModelsCategory } from "./models-category.js";
import type { ModelsCategories } from "./models-category.js";
import { MODELS_TIERS_SETTING_KEY, baseModelsTier, readModelsCategory, validateModelsTiers } from "./models-tiers.js";
import type { ModelsSettingView, ModelsTierRecord, ModelsTiers } from "./models-tiers.js";

/**
 * TCRN-CROSS-STORY-508 R3, R4 (MIN-236 D5, D6): escalation along the order of models.tiers.
 *
 * Three settings configure it: models.escalation.enabled (true or false, true by default),
 * models.escalation.threshold (a positive integer, 1 by default) and models.escalation.ceiling (a
 * category id, main by default, which a write may only set to a category models.category holds). A
 * rule names a category and gets the category's base record, the one with the largest order
 * (models-tiers.ts, baseModelsTier). For every `threshold` rejections of the attempts the rule serves,
 * the record escalates one step: to the record with the next smaller order in the whole table,
 * whatever its category and whatever its runner (MIN-236 D6: no runner filter), and no further than
 * the ceiling's stop, the record of the ceiling category with the smallest order. A base record at or
 * above the stop stays where it is; with escalation disabled the base record is the answer.
 *
 * The count of rejections is the caller's. resolveModelsTier takes it as an argument (the
 * orchestrating conversation reads it from its escalation ledger), and the engine records no count of
 * its own: nothing here reads or writes a library. What follows a rejection at the ceiling (MIN-236
 * D5: the next one stops and goes to the Owner) is the caller's process, not a rule of this module.
 */
export const MODELS_ESCALATION_ENABLED_SETTING_KEY = "models.escalation.enabled" as const;
export const MODELS_ESCALATION_THRESHOLD_SETTING_KEY = "models.escalation.threshold" as const;
export const MODELS_ESCALATION_CEILING_SETTING_KEY = "models.escalation.ceiling" as const;
/** The three keys, in the order the models group of the settings page shows them. */
export const MODELS_ESCALATION_SETTING_KEYS: readonly string[] = Object.freeze([
  MODELS_ESCALATION_ENABLED_SETTING_KEY,
  MODELS_ESCALATION_THRESHOLD_SETTING_KEY,
  MODELS_ESCALATION_CEILING_SETTING_KEY,
]);

/** The catalog's defaults, as the settings store them: enabled, one rejection a step, up to main. */
export const MODELS_ESCALATION_ENABLED_DEFAULT_VALUE = "true" as const;
export const MODELS_ESCALATION_THRESHOLD_DEFAULT_VALUE = "1" as const;
export const MODELS_ESCALATION_CEILING_DEFAULT_VALUE = "main" as const;
/** The largest threshold the settings catalog records. */
export const MODELS_ESCALATION_THRESHOLD_MAX = 100;

/** The effective values of the three settings. */
export interface ModelsEscalation {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly ceiling: string;
}

export const MODELS_ESCALATION_REASON_CODES = Object.freeze(["MODELS_ESCALATION_INVALID"] as const);
export type ModelsEscalationReasonCode = typeof MODELS_ESCALATION_REASON_CODES[number];

/**
 * An escalation input that is not what it should be: a recorded enabled or threshold value that does
 * not parse, or an argument of resolveModelsTier of the wrong kind. `details.path` names it.
 */
export class ModelsEscalationError extends Error {
  readonly reasonCode: ModelsEscalationReasonCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ModelsEscalationError";
    this.reasonCode = "MODELS_ESCALATION_INVALID";
    this.details = details;
  }
}

function invalid(path: string, requirement: string): never {
  throw new ModelsEscalationError(`${path} ${requirement}`, { path });
}

// An integer of at least `minimum`, or MODELS_ESCALATION_INVALID naming `path`.
function integerOf(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(path, `must be an integer of at least ${minimum}`);
  return value;
}

const DECIMAL = /^[1-9][0-9]*$/u;

// A recorded enabled value: the text true or false.
function recordedEnabled(value: string): boolean {
  if (value !== "true" && value !== "false") invalid(MODELS_ESCALATION_ENABLED_SETTING_KEY, "must be true or false");
  return value === "true";
}

// A recorded threshold: a decimal integer from 1 to MODELS_ESCALATION_THRESHOLD_MAX.
function recordedThreshold(value: string): number {
  if (!DECIMAL.test(value) || Number(value) > MODELS_ESCALATION_THRESHOLD_MAX) {
    invalid(MODELS_ESCALATION_THRESHOLD_SETTING_KEY, `must be a decimal integer from 1 to ${MODELS_ESCALATION_THRESHOLD_MAX}`);
  }
  return Number(value);
}

/**
 * The effective escalation settings of a list of settings: each key's recorded value, or its default
 * while it is unset. A new library's are {enabled: true, threshold: 1, ceiling: "main"}.
 */
export function readModelsEscalation(settings: readonly ModelsSettingView[]): ModelsEscalation {
  const valueOf = (key: string, fallback: string): string => settings.find((setting) => setting.key === key)?.value ?? fallback;
  return Object.freeze({
    enabled: recordedEnabled(valueOf(MODELS_ESCALATION_ENABLED_SETTING_KEY, MODELS_ESCALATION_ENABLED_DEFAULT_VALUE)),
    threshold: recordedThreshold(valueOf(MODELS_ESCALATION_THRESHOLD_SETTING_KEY, MODELS_ESCALATION_THRESHOLD_DEFAULT_VALUE)),
    ceiling: valueOf(MODELS_ESCALATION_CEILING_SETTING_KEY, MODELS_ESCALATION_CEILING_DEFAULT_VALUE),
  });
}

/**
 * The value a models.escalation.ceiling write records: a category id, a name as a category's id is
 * one (models-category.ts). Only its shape is checked here, so replay checks it too; whether the
 * category exists is a question for the write (assertModelsEscalationWrite).
 */
export function validateModelsEscalationCeiling(value: string): string {
  return modelsName(value, MODELS_ESCALATION_CEILING_SETTING_KEY, "MODELS_CATEGORY_INVALID");
}

// Whether the category table of `settings` holds the category `id`.
function holdsCategory(settings: readonly ModelsSettingView[], id: string): boolean {
  return readModelsCategory(settings).some((category) => category.id === id);
}

// A models.category write may not take away the category the ceiling names: the ceiling's effective
// value (its recorded value, or main while it is unset) is held by the table before the write and not
// after it. A ceiling the table already lacked (a merge brought them apart) is not this write's doing,
// and it is refused where it is used, as before.
function assertCeilingCategoryKept(settings: readonly ModelsSettingView[], value: string | null): void {
  const ceiling = settings.find((setting) => setting.key === MODELS_ESCALATION_CEILING_SETTING_KEY)?.value ?? MODELS_ESCALATION_CEILING_DEFAULT_VALUE;
  if (!holdsCategory(settings, ceiling)) return;
  const after = [
    ...settings.filter((setting) => setting.key !== MODELS_CATEGORY_SETTING_KEY),
    ...(value === null ? [] : [{ key: MODELS_CATEGORY_SETTING_KEY, value }]),
  ];
  if (holdsCategory(after, ceiling)) return;
  modelsFail("MODELS_CATEGORY_IN_USE", `${MODELS_CATEGORY_SETTING_KEY} may not drop ${ceiling}: ${MODELS_ESCALATION_CEILING_SETTING_KEY} still names it`, {
    path: MODELS_CATEGORY_SETTING_KEY,
    category: ceiling,
    categories: [ceiling],
    references: [MODELS_ESCALATION_CEILING_SETTING_KEY],
  });
}

/**
 * TCRN-CROSS-STORY-508 R3: a write of models.escalation.ceiling (settings-set, or settings-remove when
 * `value` is null, which puts the default back) may only name a category models.category holds as it
 * stands, or it is refused with MODELS_CATEGORY_UNKNOWN (`details.path` and `details.category`). The
 * other way round, a write of models.category (settings-set, or settings-remove, which puts the
 * default table back) may not drop the category the effective ceiling names while the table holds it:
 * it is refused with MODELS_CATEGORY_IN_USE, `details.references` ["models.escalation.ceiling"], the
 * reason code a category tier records still name is refused with. Replay checks no reference, the
 * rule every recorded value follows; a ceiling a merge leaves without its category is refused where it
 * is used (resolveModelsTier), and a later category write is not refused for it. Every other key
 * passes.
 */
export function assertModelsEscalationWrite(settings: readonly ModelsSettingView[], key: string, value: string | null): void {
  if (key === MODELS_CATEGORY_SETTING_KEY) {
    assertCeilingCategoryKept(settings, value);
    return;
  }
  if (key !== MODELS_ESCALATION_CEILING_SETTING_KEY) return;
  const ceiling = value ?? MODELS_ESCALATION_CEILING_DEFAULT_VALUE;
  if (!holdsCategory(settings, ceiling)) {
    modelsFail("MODELS_CATEGORY_UNKNOWN", `${MODELS_ESCALATION_CEILING_SETTING_KEY} names the category ${ceiling}, which ${MODELS_CATEGORY_SETTING_KEY} does not hold`, {
      path: MODELS_ESCALATION_CEILING_SETTING_KEY,
      category: ceiling,
    });
  }
}

/** What resolveModelsTier resolves. */
export interface ModelsTierResolutionInput {
  /** The category table, models.category's effective value. */
  readonly categories: ModelsCategories;
  /** The tiers table, models.tiers's effective value. */
  readonly tiers: ModelsTiers;
  /** The effective values of the three escalation settings (readModelsEscalation). */
  readonly escalation: ModelsEscalation;
  /** The category the rule names. */
  readonly category: string;
  /** How many times the attempts this rule serves were sent back, as the caller counts them. */
  readonly rejections: number;
}

/** The record a rule gets. */
export interface ModelsTierResolution {
  /** The selected record. */
  readonly record: ModelsTierRecord;
  /** How many steps it escalated from the category's base record. */
  readonly steps: number;
  /**
   * Whether it stopped at the ceiling: the record is the ceiling's stop or above it, so a further
   * rejection escalates it no further. False while escalation is disabled.
   */
  readonly atCeiling: boolean;
}

function checkedEscalation(value: unknown): ModelsEscalation {
  if (!isModelsObject(value)) invalid("escalation", "must be an object with enabled, threshold and ceiling");
  if (typeof value.enabled !== "boolean") invalid(MODELS_ESCALATION_ENABLED_SETTING_KEY, "must be true or false");
  if (typeof value.ceiling !== "string") invalid(MODELS_ESCALATION_CEILING_SETTING_KEY, "must be a category id");
  return { enabled: value.enabled, threshold: integerOf(value.threshold, MODELS_ESCALATION_THRESHOLD_SETTING_KEY, 1), ceiling: value.ceiling };
}

function assertKnownCategory(known: ReadonlySet<string>, category: unknown, path: string): void {
  if (typeof category !== "string" || !known.has(category)) {
    modelsFail("MODELS_CATEGORY_UNKNOWN", `${path} names the category ${String(category)}, which ${MODELS_CATEGORY_SETTING_KEY} does not hold`, { path, category });
  }
}

// The ceiling's stop: the record of the ceiling category with the smallest order. `tiers` is in
// ascending order, so it is the first of the category's records.
function ceilingStop(tiers: ModelsTiers, ceiling: string): ModelsTierRecord {
  const stop = tiers.find((record) => record.category === ceiling);
  if (stop === undefined) {
    modelsFail("MODELS_CATEGORY_EMPTY", `${MODELS_TIERS_SETTING_KEY} holds no record of the ceiling category ${ceiling}, so escalation has no record to stop at`, {
      path: MODELS_ESCALATION_CEILING_SETTING_KEY,
      category: ceiling,
    });
  }
  return stop;
}

/**
 * TCRN-CROSS-STORY-508 R4, AC5: the record a rule naming `category` gets after `rejections` of the
 * attempts it serves were sent back. It starts at the category's base record (its largest order) and
 * escalates one record for every `threshold` rejections, towards the smaller orders of the whole
 * table, across categories and runners, up to the ceiling's stop (the ceiling category's record with
 * the smallest order); a base record at or above the stop stays. With escalation disabled it is the
 * base record, and the ceiling is not read.
 *
 * Pure: the result depends on the arguments alone, and nothing is read or recorded. Both tables are
 * checked as models-category.ts and models-tiers.ts check them, so a caller may pass them as parsed
 * from settings-catalog. A category, or an enabled ceiling, that models.category does not hold is
 * MODELS_CATEGORY_UNKNOWN; a category, or an enabled ceiling, without a record is MODELS_CATEGORY_EMPTY
 * (for the ceiling with `details.path` models.escalation.ceiling); an escalation setting or a rejection
 * count of the wrong kind is MODELS_ESCALATION_INVALID.
 */
export function resolveModelsTier(input: ModelsTierResolutionInput): ModelsTierResolution {
  if (!isModelsObject(input)) invalid("input", "must be an object with categories, tiers, escalation, category and rejections");
  const categories = validateModelsCategory(input.categories);
  const tiers = validateModelsTiers(input.tiers);
  const escalation = checkedEscalation(input.escalation);
  const rejections = integerOf(input.rejections, "rejections", 0);
  const known = new Set(categories.map((entry) => entry.id));
  assertKnownCategory(known, input.category, "category");
  const base = baseModelsTier(tiers, input.category);
  if (!escalation.enabled) return Object.freeze({ record: base, steps: 0, atCeiling: false });
  assertKnownCategory(known, escalation.ceiling, MODELS_ESCALATION_CEILING_SETTING_KEY);
  const stop = ceilingStop(tiers, escalation.ceiling);
  // The records an escalation passes on its way from the base record to the stop, the nearest first.
  const route = tiers.filter((record) => record.order < base.order && record.order >= stop.order).reverse();
  const steps = Math.min(Math.floor(rejections / escalation.threshold), route.length);
  const record = route[steps - 1] ?? base;
  return Object.freeze({ record, steps, atCeiling: record.order <= stop.order });
}
