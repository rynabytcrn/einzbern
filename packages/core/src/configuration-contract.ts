// SPDX-License-Identifier: Apache-2.0
import { runtimeInputContract } from "./runtime-input-contract.js";
import type { RuntimeCommandCatalogEntry } from "./runtime-input-contract.js";

import { parsePromptLanguages } from "./knowledge-language.js";
import { MACHINE_SETTINGS_CATALOG, validateMachineSettingValue } from "./machine-settings.js";
import type { MachineSettingKey } from "./machine-settings.js";
import { SETTINGS_CATALOG, validateSettingValue } from "./settings.js";
import type { SettingKey } from "./settings.js";

const CONFIGURATION_CONTRACT_VERSION = "tcrn.configuration-contract.v1" as const;
export class ConfigurationContractError extends Error {
  constructor(readonly reasonCode: "CONFIGURATION_KEY_UNKNOWN" | "CONFIGURATION_VALUE_INVALID", message: string) {
    super(message);
    this.name = "ConfigurationContractError";
  }
}

export type ConfigurationSemanticType = "string" | "integer" | "boolean" | "enum" | "url" | "path" | "reference" | "version" | "list" | "record-list";
export type ConfigurationScope = "device" | "host" | "library" | "project";

export interface ConfigurationContractEntry {
  readonly key: string;
  readonly semanticType: ConfigurationSemanticType;
  readonly storageType: "string";
  readonly controlType: string;
  readonly registeredScope: "device" | "library" | "project";
  readonly scope: ConfigurationScope;
  readonly owner: "device-user" | "governed-owner";
  readonly schemaOwner: "installed-engine";
  /** Authority of the setting family, not the source of an annotated historical value. */
  readonly source: string;
  readonly storageSource: string;
  readonly inheritance: string;
  readonly sharing: string;
  readonly export: string;
  readonly consumer: string;
  readonly effect: string;
  readonly compatibility: string;
  readonly defaultValue: string | null;
  readonly min?: number;
  readonly max?: number;
  readonly allowedValues?: readonly string[];
}

/** Consumer names are code entry points, not assertions that live hosts have been tested. */
const CONSUMERS = Object.freeze({
  "agents.generation": "variables-sections.ts agentsFileSections and renderAgentsSections",
  "agents.sharedNavigation": "variables-sections.ts shared AGENTS navigation rendering",
  "artifact.language": "knowledge-card and managed-output language selection",
  "design.authority": "project-chain.ts readiness; variables-sections.ts design projection",
  "design.buildProject": "project-chain.ts design context; variables-sections.ts",
  "design.buildService": "project-chain.ts design context; variables-sections.ts",
  "design.consumedVersion": "project-chain.ts design context; variables-sections.ts",
  "design.productionDocs": "project-chain.ts design context; variables-sections.ts",
  "design.pullRequestTarget": "project-chain.ts design context; variables-sections.ts",
  "design.repository": "project-chain.ts design context; variables-sections.ts",
  "engine.requiredVersion": "workspace engine compatibility check",
  "execution.maxConcurrentSubagents": "execution-policy.ts project budget; orchestrator runtime handoff",
  "injection.perPromptBytes": "recall.ts prompt injection budget",
  "knowledge.articlesPath": "settings.ts resolveKnowledgeArticlesPath; knowledge article output",
  "models.category": "engine-model-policy.ts host policy resolver; legacy replay diagnostics",
  "models.escalation.ceiling": "engine-model-policy.ts host policy resolver; legacy replay diagnostics",
  "models.escalation.enabled": "engine-model-policy.ts host policy resolver; legacy replay diagnostics",
  "models.escalation.threshold": "engine-model-policy.ts host policy resolver; legacy replay diagnostics",
  "models.tiers": "engine-model-policy.ts host policy resolver; legacy replay diagnostics",
  "quota.fiveHourParallelOffPercent": "execution-policy.ts advisory quota evaluation; engine host policy",
  "quota.fiveHourWaitPercent": "execution-policy.ts advisory quota evaluation; engine host policy",
  "quota.weeklyParallelOffPercent": "execution-policy.ts advisory quota evaluation; engine host policy",
  "quota.weeklyWaitPercent": "execution-policy.ts advisory quota evaluation; engine host policy",
  "retrieval.promptLanguages": "retrieval prompt-language resolution",
  "retrieval.scopeExcerptBytes": "recall scope excerpt budget",
  "retrieval.tau": "retrieval admission score threshold",
  "storage.segmentBytes": "workspace.ts event segment rotation",
  "storage.snapshotEveryEvents": "workspace.ts snapshot cadence",
  "workspace.generatedArtifactsPath": "artifact-store.ts artifact root resolution",
  "paths.artifacts": "portable-path.ts local artifact binding resolution",
  "paths.knowledgeArticles": "portable-path.ts local knowledge article binding resolution",
  "execution.maxConcurrentAgents": "execution-policy.ts device agent concurrency cap",
  "agents.navigation": "host-render.ts; host-hooks.ts local navigation installation",
  "crest.userPath": "device-home.ts user crest path resolution",
  "execution.maxConcurrentHeavyRuns": "scripts/lib/heavy-runs.mjs slot acquisition",
  "portal.defaultLocale": "portal/index.html browser preference fallback",
  "portal.defaultPartition": "portal/portal.mjs initial library selection",
  "portal.defaultTheme": "portal/index.html browser preference fallback",
  "portal.port": "portal/portal.mjs listener startup",
} satisfies Record<SettingKey | MachineSettingKey, string>);

function semanticType(entry: { readonly key: string; readonly type: string; readonly controlType: string; readonly shape?: string }): ConfigurationSemanticType {
  if (entry.key === "engine.requiredVersion") return "version";
  if (entry.key === "models.escalation.ceiling" || entry.key === "portal.defaultPartition") return "reference";
  if (entry.key === "retrieval.promptLanguages") return "list";
  if (entry.key === "models.escalation.enabled") return "boolean";
  if (entry.shape === "collection") return "record-list";
  if (entry.controlType === "number" || entry.type === "integer") return "integer";
  if (["enum", "url", "path"].includes(entry.type)) return entry.type as "enum" | "url" | "path";
  return "string";
}

/** Every registered key is mapped, while defaults, ranges and allowed values stay in their catalogs. */
function settingContracts(): readonly ConfigurationContractEntry[] {
  const governed = SETTINGS_CATALOG.map((entry): ConfigurationContractEntry => {
    const host = entry.key.startsWith("models.") || entry.key.startsWith("quota.");
    return Object.freeze({
      key: entry.key,
      semanticType: semanticType(entry),
      storageType: "string",
      controlType: entry.controlType,
      registeredScope: entry.scope,
      scope: host ? "host" : entry.scope,
      owner: "governed-owner",
      schemaOwner: "installed-engine",
      source: host ? "device engine-model-policy.json hosts[host]" : "library events bound to stable target identity",
      storageSource: "library settings.updated events (historical string transport)",
      inheritance: host ? "explicit host only; no project fallback" : ["agents.generation", "agents.sharedNavigation"].includes(entry.key) ? "project target or coordination library owns declaration; no implicit coordination inheritance" : entry.scope === "library" ? "target library only" : "explicit project parent chain and permitted public defaults; no implicit coordination-library inheritance",
      sharing: host ? "historical declaration syncs with library; effective device policy does not sync" : "portable declarations sync with library",
      export: host ? "runtime policy reference and handoff only; do not freeze device choices into shared AGENTS" : entry.key.startsWith("design.") ? "managed AGENTS whitelist and project context" : "consumer-specific whitelist; library config projection is not an authority",
      consumer: CONSUMERS[entry.key],
      effect: host ? "next runtime resolution; generated policy references require normal render" : "next consumer read; managed outputs require explicit render",
      compatibility: host ? "historical declaration preserved for replay/diagnostics; not engine policy authority" : entry.key === "design.authority" ? "optional; absence alone does not block readiness" : entry.type === "path" ? "historical paths remain readable; new shared declarations must be portable" : "historical string events preserved; typed readback does not rewrite events",
      defaultValue: entry.defaultValue,
      ...(entry.min === undefined ? {} : { min: entry.min }),
      ...(entry.max === undefined ? {} : { max: entry.max }),
      ...(entry.allowedValues === undefined ? {} : { allowedValues: entry.allowedValues }),
    });
  });
  const device = MACHINE_SETTINGS_CATALOG.map((entry): ConfigurationContractEntry => Object.freeze({
    key: entry.key,
    semanticType: semanticType(entry),
    storageType: "string",
    controlType: entry.controlType,
    registeredScope: "device",
    scope: "device",
    owner: "device-user",
    schemaOwner: "installed-engine",
    source: "device machine-settings.json",
    storageSource: "device machine-settings.json",
    inheritance: entry.key.startsWith("portal.default") ? "browser/explicit startup choice before device preference; consumer fallback last" : "device declaration then consumer default",
    sharing: "device-local; not library synced",
    export: entry.key === "agents.navigation" ? "local host integration; shared navigation follows project generation contract" : "local runtime only; no shared project export",
    consumer: CONSUMERS[entry.key],
    effect: entry.key === "execution.maxConcurrentHeavyRuns" ? "next slot acquisition" : entry.appliesOn,
    compatibility: "catalog default may differ from consumer fallback; no global precedence chain",
    defaultValue: entry.defaultValue,
    ...(entry.min === undefined ? {} : { min: entry.min }),
    ...(entry.max === undefined ? {} : { max: entry.max }),
    ...(entry.allowedValues === undefined ? {} : { allowedValues: entry.allowedValues }),
  }));
  return Object.freeze([...governed, ...device].sort((left, right) => left.key.localeCompare(right.key)));
}

export interface IndependentConfigurationEntry {
  readonly kind: string;
  readonly semanticType: "structured-record";
  readonly owner: string;
  readonly export: string;
  readonly effect: string;
  readonly compatibility: string;
  readonly classification: "configuration" | "governance" | "runtime-state" | "projection" | "installation";
  readonly scope: string;
  readonly source: string;
  readonly editing: string;
  readonly sharing: string;
  readonly consumer: string;
}

const INDEPENDENT_ENTRIES: readonly IndependentConfigurationEntry[] = Object.freeze([
  { kind: "config-backup", classification: "configuration", scope: "explicit backup group", source: "allowlisted authority inputs and immutable verified manifest", editing: "config-backup-plan/create/verify/list/resume/retire with explicit approved retention policy", sharing: "explicit reserved root only; sync remains unknown without remote readback", consumer: "config-backup.ts, config-backup-retention.ts and Portal read-only inventory" },
  { kind: "config-restore", classification: "configuration", scope: "explicit target project/device", source: "verified configuration package; target authorities remain authoritative", editing: "review digest-bound plan; apply selected inputs through existing setters and independent readback", sharing: "no credentials, identity, authorization or runtime-state restore", consumer: "config-restore.ts; no projection overwrite or legacy full-home restore" },
  { kind: "engine-host-policy", classification: "configuration", scope: "device/host", source: "engine-model-policy.json", editing: "governed whole-host replacement; categories/tiers/escalation/optional quota", sharing: "not library synced; runtime handoff only", consumer: "resolveEngineExecutionPolicy" },
  { kind: "variable", classification: "configuration", scope: "project", source: "library config records", editing: "typed string/number/boolean declarations; replace versus patch explicit", sharing: "library sync; explicit export targets only", consumer: "variables-sections.ts and project context" },
  { kind: "rule", classification: "configuration", scope: "project with explicit inheritance", source: "library config records", editing: "governed rule operations", sharing: "library sync and managed outputs", consumer: "rules catalog and renderer" },
  { kind: "gate", classification: "configuration", scope: "target only; not inherited", source: "library config records", editing: "governed argv/root configuration, not a free-form variable", sharing: "library sync", consumer: "gates plan/run" },
  { kind: "managed-section", classification: "projection", scope: "target only", source: "library config records", editing: "renderer-controlled digest/revision/status", sharing: "library sync", consumer: "managed-output renderer" },
  { kind: "chain", classification: "governance", scope: "library", source: "library identity and trust records", editing: "dedicated governance operations", sharing: "governed library relationships", consumer: "library discovery and governance" },
  { kind: "lease", classification: "runtime-state", scope: "coordination", source: "library config records", editing: "dedicated lease lifecycle", sharing: "coordination sync; excluded from config/project.json", consumer: "work coordination" },
  { kind: "proposal", classification: "governance", scope: "coordination", source: "library config records", editing: "proposal/decision lifecycle", sharing: "coordination sync; excluded from config/project.json", consumer: "work governance" },
  { kind: "local-binding", classification: "configuration", scope: "device", source: "device registry and identity files", editing: "registration/binding operations", sharing: "absolute paths stay device-local", consumer: "workspace discovery and root resolution" },
  { kind: "quota-observation", classification: "runtime-state", scope: "host invocation", source: "caller-supplied usage observation", editing: "not a persistent setting", sharing: "runtime only", consumer: "evaluateExecutionQuota; no built-in account reader" },
  { kind: "config-project-json", classification: "projection", scope: "library", source: "event-derived config/project.json", editing: "read-only derived output; manual edits are not authority", sharing: "may accompany library", consumer: "projection diagnostics" },
  { kind: "agents-output", classification: "projection", scope: "project", source: "managed AGENTS output", editing: "formal render only", sharing: "project version control whitelist", consumer: "human and agent instructions" },
  { kind: "browser-preference", classification: "configuration", scope: "browser", source: "browser localStorage", editing: "local UI preference controls", sharing: "not library synced", consumer: "portal theme/locale/navigation" },
  { kind: "installed-engine", classification: "installation", scope: "device", source: "installed version assets and lifecycle receipts", editing: "install/update/rollback; not generic settings", sharing: "release assets separate from device identity and cache", consumer: "hooks, doctor and runtime" },
].map((entry) => Object.freeze({
  ...entry,
  semanticType: "structured-record",
  owner: entry.kind === "config-backup" ? "device-user" : entry.kind === "config-restore" ? "selected-authority" : entry.classification === "projection" || entry.classification === "installation" ? "installed-engine" : entry.scope === "device" || entry.scope === "browser" ? "device-user" : entry.classification === "runtime-state" ? "runtime-producer" : "governed-owner",
  export: entry.kind === "config-backup" ? "explicit non-secret allowlist package only; never identity or runtime state" : entry.kind === "config-restore" ? "selected inputs through their real target authorities; no projection overwrite" : entry.classification === "projection" ? "derived output only; never read back as authority" : entry.scope === "device" || entry.scope === "browser" || entry.scope === "host invocation" ? "local runtime only" : "dedicated consumer contract; not a generic string setting",
  effect: entry.classification === "installation" ? "verified lifecycle operation" : entry.classification === "projection" ? "explicit regeneration" : "dedicated consumer operation",
  compatibility: "retain historical records; migration and write permissions belong to the dedicated API",
})) as IndependentConfigurationEntry[]);

export function configurationContract(commandCatalog?: readonly RuntimeCommandCatalogEntry[]): {
  readonly schemaVersion: typeof CONFIGURATION_CONTRACT_VERSION;
  readonly settings: readonly ConfigurationContractEntry[];
  readonly independentEntries: readonly IndependentConfigurationEntry[];
  readonly runtimeInputs: ReturnType<typeof runtimeInputContract>;
  readonly limits: readonly string[];
} {
  return Object.freeze({
    schemaVersion: CONFIGURATION_CONTRACT_VERSION,
    settings: settingContracts(),
    independentEntries: INDEPENDENT_ENTRIES,
    runtimeInputs: runtimeInputContract(commandCatalog),
    limits: Object.freeze([
      "Registered settings and runtime inputs have separate ownership contracts; command flag structure comes from the canonical command catalog.",
      "Consumer descriptions identify source wiring, not live-host acceptance or account access.",
      "Readback metadata does not migrate events, refresh projections, or attest installed-version state.",
    ]),
  });
}

/** Strict transport adaptation only: no Boolean(string), guessed defaults, or event mutation. */
export function annotateConfigValue(key: string, value: string | null, valueOrigin: string = "stored"): {
  readonly key: string;
  readonly rawValue: string | null;
  readonly semanticValue: unknown;
  readonly valueOrigin: string;
  readonly valueRole: "historical-declaration" | "resolved-setting";
  readonly valueSource: "project-compatibility" | "caller-supplied-setting";
  readonly contract: ConfigurationContractEntry;
} {
  const contract = settingContracts().find((entry) => entry.key === key);
  if (contract === undefined) throw new ConfigurationContractError("CONFIGURATION_KEY_UNKNOWN", `Unknown configuration key: ${key}`);
  const historical = key.startsWith("models.") || key.startsWith("quota.");
  const provenance = {
    valueRole: historical ? "historical-declaration" as const : "resolved-setting" as const,
    valueSource: historical ? "project-compatibility" as const : "caller-supplied-setting" as const,
  };
  if (value === null) return Object.freeze({ key, rawValue: value, semanticValue: null, valueOrigin, ...provenance, contract });
  const checked = contract.registeredScope === "device"
    ? validateMachineSettingValue(key as MachineSettingKey, value)
    : validateSettingValue(key, value);
  let semanticValue: unknown = checked;
  if (contract.semanticType === "integer") {
    if (!Number.isSafeInteger(Number(checked))) throw new ConfigurationContractError("CONFIGURATION_VALUE_INVALID", `${key} must be a safe integer`);
    semanticValue = Number(checked);
  } else if (contract.semanticType === "boolean") {
    if (checked !== "true" && checked !== "false") throw new ConfigurationContractError("CONFIGURATION_VALUE_INVALID", `${key} must be true or false`);
    semanticValue = checked === "true";
  } else if (contract.semanticType === "record-list") {
    semanticValue = JSON.parse(checked) as unknown;
  } else if (contract.semanticType === "list") {
    semanticValue = parsePromptLanguages(checked);
  }
  return Object.freeze({ key, rawValue: value, semanticValue, valueOrigin, ...provenance, contract });
}
