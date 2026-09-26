// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, compareCanonicalText } from "../../protocol/src/index.js";

/**
 * TCRN-CROSS-STORY-484 R3 (MIN-227 D11, D12): the model tiers, one table per host.
 *
 * Each tier of a host names three things: the runner that executes it (the host itself, or another
 * program such as codex-cli), the model and the effort. The default tier names are flagship, main
 * and economy, and a project adds or removes tiers freely, so a tier name is data, never a closed
 * roster. The engine records the names it is given and never interprets them. No model name appears
 * in this file (MIN-152 D3), which is why a default tier's model and effort are empty: unfilled until
 * the Owner fills them.
 *
 * The setting replaces execution.dispatchTiers, whose rows had no runner. A recorded
 * execution.dispatchTiers value still counts: legacyTiersToModelsTiers maps it, with the host a row
 * sits under as its runner, and replay keeps the result as the effective models.tiers value until a
 * models.tiers write supersedes it (settings.ts, renamedSettingRecord).
 */
export const MODELS_TIERS_SETTING_KEY = "models.tiers" as const;
export const LEGACY_DISPATCH_TIERS_SETTING_KEY = "execution.dispatchTiers" as const;
export const MODELS_TIERS_DEFAULT_HOSTS: readonly string[] = Object.freeze(["claude-code", "codex"]);
export const MODELS_TIERS_DEFAULT_TIER_NAMES: readonly string[] = Object.freeze(["flagship", "main", "economy"]);
export const MODELS_TIERS_REASON_CODES = Object.freeze(["MODELS_TIERS_INVALID"] as const);

export type ModelsTiersReasonCode = typeof MODELS_TIERS_REASON_CODES[number];

export interface ModelsTierEntry {
  readonly runner: string;
  readonly model: string;
  readonly effort: string;
}

/** {<host>: {<tier>: {runner, model, effort}}}. */
export type ModelsTiers = Readonly<Record<string, Readonly<Record<string, ModelsTierEntry>>>>;

export class ModelsTiersError extends Error {
  readonly reasonCode: ModelsTiersReasonCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ModelsTiersError";
    this.reasonCode = "MODELS_TIERS_INVALID";
    this.details = details;
  }
}

function fail(message: string, path: string): never {
  throw new ModelsTiersError(message, { path });
}

// A host, a tier and a runner are names: a lowercase letter first, then lowercase letters, digits,
// dot, underscore or hyphen, at most 64 characters. The same shape a custom variable's name has, so a
// rendered table never has to escape one.
const NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MODEL_MAX_LENGTH = 256;
const EFFORT_MAX_LENGTH = 64;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function name(value: string, path: string): string {
  if (!NAME.test(value)) fail(`${path} must be a lowercase name of at most 64 characters (a-z first, then a-z, 0-9, dot, underscore or hyphen)`, path);
  return value;
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || CONTROL.test(value)) {
    fail(`${path} must be a string of at most ${maximum} characters without control characters`, path);
  }
  return value;
}

function entry(value: unknown, path: string): ModelsTierEntry {
  if (!isObject(value)) fail(`${path} must be an object with runner, model and effort`, path);
  const fields = Object.keys(value).sort(compareCanonicalText);
  if (fields.join(",") !== "effort,model,runner") fail(`${path} requires exactly runner, model and effort`, path);
  if (typeof value.runner !== "string") fail(`${path}.runner must be a string`, `${path}.runner`);
  return Object.freeze({
    runner: name(value.runner, `${path}.runner`),
    model: text(value.model, `${path}.model`, MODEL_MAX_LENGTH),
    effort: text(value.effort, `${path}.effort`, EFFORT_MAX_LENGTH),
  });
}

function sorted<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  return Object.freeze(Object.fromEntries([...entries].sort(([left], [right]) => compareCanonicalText(left, right))));
}

/** The value as a models.tiers table, or MODELS_TIERS_INVALID naming the first field that is not. */
export function validateModelsTiers(value: unknown): ModelsTiers {
  if (!isObject(value)) fail("models.tiers must be an object keyed by host", "models.tiers");
  return sorted(Object.entries(value).map(([host, tiers]) => {
    const hostPath = `models.tiers.${host}`;
    name(host, hostPath);
    if (!isObject(tiers)) fail(`${hostPath} must be an object keyed by tier name`, hostPath);
    return [host, sorted(Object.entries(tiers).map(([tier, row]) => {
      const tierPath = `${hostPath}.${tier}`;
      name(tier, tierPath);
      return [tier, entry(row, tierPath)] as const;
    }))] as const;
  }));
}

/** Parse a stored models.tiers value: JSON text holding a models.tiers table. */
export function parseModelsTiers(value: string): ModelsTiers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("models.tiers must contain JSON", "models.tiers");
  }
  return validateModelsTiers(parsed);
}

/** The default table: every default host with the three default tiers, its own runner, unfilled. */
export function defaultModelsTiers(): ModelsTiers {
  return validateModelsTiers(Object.fromEntries(MODELS_TIERS_DEFAULT_HOSTS.map((host) => [
    host,
    Object.fromEntries(MODELS_TIERS_DEFAULT_TIER_NAMES.map((tier) => [tier, { runner: host, model: "", effort: "" }])),
  ])));
}

/** The catalog's default value for models.tiers: the default table as canonical JSON. */
export const MODELS_TIERS_DEFAULT_VALUE: string = canonicalJson(defaultModelsTiers());

/**
 * Map an execution.dispatchTiers value ({<host>: {<tier>: {model, effort} | null}}) to models.tiers.
 * Each row gains the host it sits under as its runner; a null row was an unfilled tier and is left
 * out. A value that is not the old shape is refused with MODELS_TIERS_INVALID.
 */
export function legacyTiersToModelsTiers(value: unknown): ModelsTiers {
  if (!isObject(value)) fail("execution.dispatchTiers must be an object keyed by host", LEGACY_DISPATCH_TIERS_SETTING_KEY);
  return validateModelsTiers(Object.fromEntries(Object.entries(value).map(([host, tiers]) => {
    const hostPath = `${LEGACY_DISPATCH_TIERS_SETTING_KEY}.${host}`;
    name(host, hostPath);
    if (!isObject(tiers)) fail(`${hostPath} must be an object keyed by tier name`, hostPath);
    return [host, Object.fromEntries(Object.entries(tiers).filter(([, row]) => row !== null).map(([tier, row]) => {
      const tierPath = `${hostPath}.${tier}`;
      name(tier, tierPath);
      if (!isObject(row) || Object.keys(row).sort(compareCanonicalText).join(",") !== "effort,model") {
        fail(`${tierPath} requires exactly model and effort`, tierPath);
      }
      return [tier, { runner: host, model: text(row.model, `${tierPath}.model`, MODEL_MAX_LENGTH), effort: text(row.effort, `${tierPath}.effort`, EFFORT_MAX_LENGTH) }];
    }))];
  })));
}

/** legacyTiersToModelsTiers over a stored execution.dispatchTiers value, as canonical JSON. */
export function legacyTiersValueToModelsTiersValue(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("execution.dispatchTiers must contain JSON", LEGACY_DISPATCH_TIERS_SETTING_KEY);
  }
  return canonicalJson(legacyTiersToModelsTiers(parsed));
}

/**
 * The effective models.tiers table of a list of settings: the recorded value when there is one,
 * otherwise the default table. Replay has already carried a recorded execution.dispatchTiers value
 * over as models.tiers, so a workspace's settings never need a second lookup.
 */
export function readModelsTiers(settings: readonly { readonly key: string; readonly value: string }[]): ModelsTiers {
  const recorded = settings.find((setting) => setting.key === MODELS_TIERS_SETTING_KEY)?.value;
  return recorded === undefined ? defaultModelsTiers() : parseModelsTiers(recorded);
}
