// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { parseManagedFile } from "./managed-sections.js";
import { applyMachineSettingRemove, applyMachineSettingSet, readMachineSettings } from "./machine-settings.js";
import { disableRule, enableRule } from "./rules.js";
import { BUILT_IN_RULES } from "./rules-catalog.js";
import { effectiveProjectState } from "./project-chain.js";
import { removeVariable, setVariable } from "./variables.js";
import { refreshConfigurationProjections } from "./configuration-projections.js";
import { assertNotDotAgentsTarget } from "./dot-agents.js";
import { materializeWorkspace, removeWorkspaceSetting, setWorkspaceSetting } from "./workspace.js";
import type { WorkspaceMutationOptions } from "./workspace.js";
import {
  CONFIG_BACKUP_MAPPING_VERSION, CONFIG_BACKUP_RESERVED_ROOTS, safeConfigBackupHostname, assertConfigBackupDirectory, assertConfigBackupSource, collectConfigBackupPayloads,
  configBackupCanonical, configBackupDigest, configBackupFail, configBackupInstant,
  configBackupObject, planConfigBackup, readConfigBackupFile,
  validateConfigBackupPayload, verifyConfigBackup,
} from "./config-backup.js";
import type { ConfigBackupCategory, ConfigBackupPayload, ConfigBackupProjectRef, ConfigBackupSource, ConfigBackupSourceVersion } from "./config-backup.js";
import { createConfigBackup, validateConfigBackupRetentionPolicy } from "./config-backup-retention.js";
import type { ConfigBackupStore } from "./config-backup-retention.js";

export const CONFIG_RESTORE_PLAN_VERSION = "einzbern.config-restore-plan.v1" as const;
export type ConfigRestoreClassification = "unchanged" | "missing" | "conflict" | "unmappable" | "permission-denied" | "incompatible";
export interface ConfigRestoreTarget {
  readonly source: ConfigBackupSource; readonly sourceVersion: ConfigBackupSourceVersion;
  /** Actual discovery output, not a replacement partition guessed from a hostname. */
  readonly availablePartitions: readonly string[];
  /** Resolved at the caller's permission boundary, never loaded from backup bytes. */
  readonly permittedKeys: readonly string[];
  readonly originalsStore: ConfigBackupStore;
  readonly actorId: string;
  /** The existing CLI permission/Owner decision checks must populate this exact-key map. */
  readonly authorizations: Readonly<Record<string, NonNullable<WorkspaceMutationOptions["authorization"]>>>;
}
export interface ConfigRestorePlanItem {
  readonly logicalKey: string; readonly category: ConfigBackupCategory; readonly memberPath: string; readonly memberSha256: string;
  readonly classification: ConfigRestoreClassification;
  readonly action: "replace-user-fragment" | "supported-setting" | "supported-variable" | "supported-rule" | "supported-machine-preference" | "remap-required";
  readonly targetDigest: string | null; readonly targetFileDigest: string | null;
  readonly originalRecoveryLocation: string; readonly requiredPermissionDescription: string;
}
export interface ConfigRestorePlan {
  readonly schemaVersion: typeof CONFIG_RESTORE_PLAN_VERSION; readonly backupId: string;
  readonly manifestDigest: string; readonly targetProjectRef: ConfigBackupProjectRef;
  readonly mappingVersion: typeof CONFIG_BACKUP_MAPPING_VERSION; readonly createdAt: string; readonly targetDeclarationScope: "project" | "library";
  readonly targetRoots: { readonly library: string; readonly project: string; readonly machineSettings: string; readonly originals: string };
  readonly targetVersion: ConfigBackupSourceVersion;
  readonly permissionDigest: string; readonly items: readonly ConfigRestorePlanItem[]; readonly planDigest: string;
}
interface CurrentValue { readonly payload: ConfigBackupPayload; readonly digest: string | null; readonly fileDigest: string | null }
async function currentValue(payload: ConfigBackupPayload, target: ConfigRestoreTarget): Promise<CurrentValue> {
  if (payload.kind === "agents-user-fragment") {
    try {
      const bytes = await readConfigBackupFile(target.source.projectRoot, "AGENTS.md"); const parsed = parseManagedFile(bytes.toString("utf8"));
      if (parsed.outside[payload.index] === undefined) return { payload, digest: null, fileDigest: configBackupDigest(bytes) };
      const current: ConfigBackupPayload = { kind: payload.kind, ownership: "user", index: payload.index, text: parsed.outside[payload.index]! };
      return { payload: current, digest: configBackupDigest(configBackupCanonical(current)), fileDigest: configBackupDigest(bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { payload, digest: null, fileDigest: null }; throw error;
    }
  }
  if (payload.kind === "rule") {
    const state = await materializeWorkspace(target.source.libraryRoot);
    const scopeId = target.source.declarationScope === "project" ? target.source.projectRef.projectId : undefined;
    if (!state.configRecords.some(record => record.projectId === scopeId && record.collection === "rule" && record.key === payload.id)) return { payload, digest: null, fileDigest: null };
  }
  const key = payload.kind === "variable" ? payload.name : payload.kind === "rule" ? payload.id : payload.key;
  const current = (await collectConfigBackupPayloads(target.source, [{ kind: payload.kind, key }]))[0];
  if (!current) configBackupFail("CONFIG_RESTORE_TARGET_UNREADABLE");
  const absent = (current.kind === "setting" || current.kind === "device-preference") ? current.value === null : current.kind === "variable" ? current.declaration === null : false;
  return { payload: current, digest: absent ? null : configBackupDigest(configBackupCanonical(current)), fileDigest: null };
}
function desiredDigest(payload: ConfigBackupPayload): string | null {
  if (((payload.kind === "setting" || payload.kind === "device-preference") && payload.value === null) || (payload.kind === "variable" && payload.declaration === null)) return null;
  return configBackupDigest(configBackupCanonical(payload));
}
function action(payload: ConfigBackupPayload): ConfigRestorePlanItem["action"] {
  switch (payload.kind) {
    case "agents-user-fragment": return "replace-user-fragment";
    case "setting": return "supported-setting";
    case "variable": return "supported-variable";
    case "rule": return "supported-rule";
    case "device-preference": return "supported-machine-preference";
    case "path-remapping": return "remap-required";
  }
}
function permissionsDigest(target: ConfigRestoreTarget): string {
  return configBackupDigest(configBackupCanonical({ actorId: target.actorId, permittedKeys: [...target.permittedKeys].sort(), authorizations: target.authorizations, availablePartitions: [...target.availablePartitions].sort(), policy: target.originalsStore.policy, approval: target.originalsStore.approval, binding: target.originalsStore.binding, localBindingRoot: target.originalsStore.localBindingRoot }));
}
function restoreDigest(plan: Omit<ConfigRestorePlan, "planDigest"> | ConfigRestorePlan): string {
  const { planDigest: _digest, ...body } = plan as ConfigRestorePlan; return configBackupDigest(configBackupCanonical(body));
}
export async function planConfigRestore(input: { readonly packageRoot: string; readonly target: ConfigRestoreTarget; readonly at: string }): Promise<ConfigRestorePlan> {
  configBackupInstant(input.at); const verified = await verifyConfigBackup(input.packageRoot);
  if (verified.integrity !== "verified" || !verified.manifest) configBackupFail("CONFIG_RESTORE_PACKAGE_INVALID");
  const target = input.target; await assertConfigBackupSource(target.source);
  const native = await materializeWorkspace(target.source.libraryRoot);
  if (native.metadata.workspaceId !== target.source.projectRef.libraryId || !native.projects.some(project => project.id === target.source.projectRef.projectId && !project.tombstone) || configBackupCanonical(target.originalsStore.binding.projectRef) !== configBackupCanonical(target.source.projectRef)) configBackupFail("CONFIG_RESTORE_TARGET_MISMATCH");
  let independentDot = false;
  try { await assertNotDotAgentsTarget(target.source.projectRoot); } catch (error) { if ((error as { reasonCode?: string }).reasonCode !== "DOT_INDEPENDENT_TARGET") throw error; independentDot = true; }
  const compatible = configBackupCanonical(verified.manifest.sourceVersion) === configBackupCanonical(target.sourceVersion);
  const items: ConfigRestorePlanItem[] = [];
  for (const file of verified.manifest.files) {
    const payload = validateConfigBackupPayload(JSON.parse((await readConfigBackupFile(input.packageRoot, file.memberPath)).toString("utf8")) as unknown);
    let classification: ConfigRestoreClassification = "conflict"; let current: CurrentValue | null = null;
    const governed = payload.kind === "setting" || payload.kind === "variable" || payload.kind === "rule";
    if (!compatible || (payload.kind === "rule" && BUILT_IN_RULES.find(rule => rule.id === payload.id)?.version !== payload.version)) classification = "incompatible";
    else if (independentDot && (payload.kind === "agents-user-fragment" || payload.kind === "rule")) classification = "unmappable";
    else if (governed && "source" in payload && payload.source !== (target.source.declarationScope === "project" ? "project-declaration" : "library-declaration")) classification = "unmappable";
    else if (payload.kind === "path-remapping" || (payload.kind === "device-preference" && payload.key === "portal.defaultPartition" && payload.value !== null && !target.availablePartitions.includes(payload.value))) classification = "unmappable";
    else if (!target.permittedKeys.includes(file.logicalKey) || (governed && target.authorizations[file.logicalKey] === undefined)) classification = "permission-denied";
    else {
      try {
        current = await currentValue(payload, target);
        classification = current.digest === desiredDigest(payload) ? "unchanged" : current.digest === null ? "missing" : "conflict";
        if (payload.kind === "agents-user-fragment" && current.digest === null && (current.fileDigest !== null || payload.index !== 0)) classification = "unmappable";
        // Keeping an original is mandatory; if its content cannot enter the allowlist, refuse
        // this item instead of leaking it into the recovery package or overwriting it.
        if (current.digest !== null) validateConfigBackupPayload(current.payload);
        if (payload.kind === "rule" && current.payload.kind === "rule") {
          const effective = await effectiveProjectState(native, target.source.declarationScope === "project" ? target.source.projectRef.projectId : undefined);
          const inheritedOrLocal = effective.configRecords.find(record => record.collection === "rule" && record.key === payload.id);
          // The real setters retain existing order, and disable retains the existing version.
          // A plan must not promise an unset or an implicit enable/disable workaround.
          if ((current.digest === null && !payload.enabled) ||
            (payload.order === undefined && inheritedOrLocal?.value.order !== undefined) ||
            (typeof inheritedOrLocal?.value.version === "number" && inheritedOrLocal.value.version > payload.version) ||
            (!payload.enabled && (payload.order !== current.payload.order || payload.version !== current.payload.version))) classification = "incompatible";
        }
      } catch { classification = "permission-denied"; }
    }
    items.push({ logicalKey: file.logicalKey, category: file.category, memberPath: file.memberPath, memberSha256: file.sha256, classification, action: action(payload), targetDigest: current?.digest ?? null, targetFileDigest: current?.fileDigest ?? null, originalRecoveryLocation: target.originalsStore.reservedRoot, requiredPermissionDescription: file.requiredPermissionDescription });
  }
  const body = { schemaVersion: CONFIG_RESTORE_PLAN_VERSION, backupId: verified.manifest.backupId, manifestDigest: verified.manifest.manifestDigest, targetProjectRef: target.source.projectRef, mappingVersion: CONFIG_BACKUP_MAPPING_VERSION, createdAt: input.at, targetDeclarationScope: target.source.declarationScope, targetRoots: { library: target.source.libraryRoot, project: target.source.projectRoot, machineSettings: target.source.machineSettingsPath, originals: target.originalsStore.reservedRoot }, targetVersion: target.sourceVersion, permissionDigest: permissionsDigest(target), items };
  return { ...body, planDigest: restoreDigest(body) };
}
async function readRestorePayload(packageRoot: string, item: ConfigRestorePlanItem): Promise<ConfigBackupPayload> {
  const bytes = await readConfigBackupFile(packageRoot, item.memberPath);
  if (configBackupDigest(bytes) !== item.memberSha256) configBackupFail("CONFIG_RESTORE_PACKAGE_CHANGED");
  return validateConfigBackupPayload(JSON.parse(bytes.toString("utf8")) as unknown);
}
export interface ConfigRestoreItemResult {
  readonly logicalKey: string; readonly status: "applied" | "unchanged" | "skipped" | "pending" | "refused" | "failed";
  readonly reason: string | null; readonly originalBackupId: string | null;
  readonly receipt: { readonly authority: "engine" | "machine-settings" | "user-file"; readonly readbackDigest: string | null; readonly headEventHash: string | null; readonly version: number | null; readonly projection: "not-applicable" | "rendered" | "pending" } | null;
}
export interface ConfigRestoreResult { readonly schemaVersion: "einzbern.config-restore-result.v1"; readonly planDigest: string; readonly status: "applied" | "partial" | "refused"; readonly items: readonly ConfigRestoreItemResult[] }
export async function applyConfigRestore(input: { readonly packageRoot: string; readonly plan: ConfigRestorePlan; readonly target: ConfigRestoreTarget; readonly approvedPlanDigest: string; readonly at: string }): Promise<ConfigRestoreResult> {
  const plan = input.plan; configBackupInstant(input.at);
  configBackupObject(plan, ["schemaVersion", "backupId", "manifestDigest", "targetProjectRef", "mappingVersion", "createdAt", "targetDeclarationScope", "targetRoots", "targetVersion", "permissionDigest", "items", "planDigest"]);
  if (plan.schemaVersion !== CONFIG_RESTORE_PLAN_VERSION || plan.mappingVersion !== CONFIG_BACKUP_MAPPING_VERSION || plan.planDigest !== input.approvedPlanDigest || plan.planDigest !== restoreDigest(plan)) configBackupFail("CONFIG_RESTORE_PLAN_INVALID");
  const fresh = await planConfigRestore({ packageRoot: input.packageRoot, target: input.target, at: plan.createdAt });
  if (fresh.planDigest !== plan.planDigest) configBackupFail("CONFIG_RESTORE_PLAN_STALE");
  const applicable = plan.items.filter(item => item.classification === "missing" || item.classification === "conflict");
  const originals: ConfigBackupPayload[] = [];
  for (const item of applicable) {
    const payload = await readRestorePayload(input.packageRoot, item);
    const current = await currentValue(payload, input.target);
    if (current.digest !== null) originals.push(validateConfigBackupPayload(current.payload));
  }
  let originalBackupId: string | null = null;
  if (originals.length) {
    if (validateConfigBackupRetentionPolicy(input.target.originalsStore.policy).status !== "policy-valid") configBackupFail("policy-unapproved");
    const backup = planConfigBackup({ projectRef: input.target.source.projectRef, backupGroupId: input.target.originalsStore.binding.backupGroupId, hostname: input.target.originalsStore.binding.hostname, at: input.at, sourceVersion: input.target.sourceVersion, payloads: originals });
    if (backup.excluded.length) configBackupFail("CONFIG_RESTORE_ORIGINAL_EXCLUDED");
    const saved = await createConfigBackup(input.target.originalsStore, backup, input.at);
    if (saved.status !== "settled" && saved.status !== "unchanged") configBackupFail("CONFIG_RESTORE_ORIGINAL_PENDING");
    const original = saved.index.active.at(-1);
    if (!original) configBackupFail("CONFIG_RESTORE_ORIGINAL_PENDING");
    const verifiedOriginal = await verifyConfigBackup(join(input.target.originalsStore.reservedRoot, CONFIG_BACKUP_RESERVED_ROOTS[0], safeConfigBackupHostname(input.target.originalsStore.binding.hostname), input.target.originalsStore.binding.backupGroupId, original.directory));
    if (verifiedOriginal.integrity !== "verified" || verifiedOriginal.manifest === null || verifiedOriginal.manifest.manifestDigest !== original.manifestDigest || verifiedOriginal.manifest.selectionDigest !== backup.manifest.selectionDigest || configBackupCanonical(verifiedOriginal.manifest.sourceVersion) !== configBackupCanonical(input.target.sourceVersion)) configBackupFail("CONFIG_RESTORE_ORIGINAL_PENDING");
    originalBackupId = original.backupId;
  }
  const results: ConfigRestoreItemResult[] = [];
  // User-owned fragments are restored before supported setters regenerate managed sections.
  // This ordering is internal to one approved plan, not an extra write to a governed projection.
  const ordered = [...plan.items].sort((a, b) => Number(b.action === "replace-user-fragment") - Number(a.action === "replace-user-fragment"));
  let userFileDigest = plan.items.find(item => item.action === "replace-user-fragment")?.targetFileDigest ?? null;
  for (const item of ordered) {
    const base = { logicalKey: item.logicalKey, originalBackupId, receipt: null };
    if (item.classification === "unchanged") { results.push({ ...base, status: "unchanged", reason: null }); continue; }
    if (item.classification !== "missing" && item.classification !== "conflict") { results.push({ ...base, status: "skipped", reason: item.classification }); continue; }
    let mutationStarted = false;
    try {
      const payload = await readRestorePayload(input.packageRoot, item);
      const current = await currentValue(payload, input.target);
      if (current.digest !== item.targetDigest || (payload.kind === "agents-user-fragment" && current.fileDigest !== userFileDigest) || !input.target.permittedKeys.includes(item.logicalKey)) { results.push({ ...base, status: "refused", reason: "target-or-permission-changed" }); continue; }
      const authorization = input.target.authorizations[item.logicalKey];
      const options: WorkspaceMutationOptions = { occurredAt: input.at, actorId: input.target.actorId, ...(input.target.source.declarationScope === "project" ? { configurationProjectId: input.target.source.projectRef.projectId } : {}), ...(authorization === undefined ? {} : { authorization }) };
      let projection: "not-applicable" | "rendered" | "pending" = "not-applicable";
      let authority: "engine" | "machine-settings" | "user-file" = "engine";
      if (payload.kind === "agents-user-fragment") {
        await assertConfigBackupDirectory(input.target.source.projectRoot);
        const old = current.fileDigest === null ? "" : (await readConfigBackupFile(input.target.source.projectRoot, "AGENTS.md")).toString("utf8");
        if (current.fileDigest !== null && configBackupDigest(old) !== current.fileDigest) configBackupFail("CONFIG_RESTORE_TARGET_CHANGED");
        const parsed = parseManagedFile(old); const outside = [...parsed.outside]; outside[payload.index] = payload.text;
        const text = outside.map((part, index) => part + (parsed.sections[index]?.raw ?? "")).join("");
        mutationStarted = true; await writeFileAtomic(join(input.target.source.projectRoot, "AGENTS.md"), text);
        const bytes = await readConfigBackupFile(input.target.source.projectRoot, "AGENTS.md");
        if (bytes.toString("utf8") !== text) configBackupFail("CONFIG_RESTORE_READBACK_UNKNOWN");
        userFileDigest = configBackupDigest(bytes); authority = "user-file";
      } else if (payload.kind === "device-preference") {
        authority = "machine-settings"; mutationStarted = true;
        if (payload.value === null) await applyMachineSettingRemove({ key: payload.key, occurredAt: input.at, path: input.target.source.machineSettingsPath });
        else await applyMachineSettingSet({ key: payload.key, value: payload.value, occurredAt: input.at, path: input.target.source.machineSettingsPath });
        await readMachineSettings(input.target.source.machineSettingsPath);
      } else if (payload.kind === "setting" || payload.kind === "variable" || payload.kind === "rule") {
        if (options.authorization === undefined) configBackupFail("CONFIG_RESTORE_PERMISSION_DENIED");
        mutationStarted = true;
        if (payload.kind === "setting") {
          if (payload.value === null) await removeWorkspaceSetting(input.target.source.libraryRoot, { ...options, key: payload.key });
          else await setWorkspaceSetting(input.target.source.libraryRoot, { ...options, key: payload.key, value: payload.value });
        } else if (payload.kind === "variable") {
          if (payload.declaration === null) await removeVariable(input.target.source.libraryRoot, { ...options, name: payload.name });
          else await setVariable(input.target.source.libraryRoot, { ...options, name: payload.name, ...payload.declaration });
        } else {
          const common = { ...options, id: payload.id, libraryRoot: input.target.source.libraryRoot, projectRoot: input.target.source.projectRoot };
          const change = payload.enabled ? await enableRule({ ...common, ...(payload.order === undefined ? {} : { order: payload.order }) }) : await disableRule(common);
          projection = change.result === "refused-user-modified" || change.status.state === "pending" ? "pending" : "rendered";
        }
        {
          const rendered = await refreshConfigurationProjections({ libraryId: input.target.source.projectRef.libraryId, ...(input.target.source.declarationScope === "project" ? { projectId: input.target.source.projectRef.projectId } : {}) }, options);
          projection = projection === "pending" || rendered.plan.gaps.length || !rendered.outcomes.length || rendered.outcomes.some(outcome => outcome.status !== "refreshed") ? "pending" : "rendered";
        }
      } else configBackupFail("CONFIG_RESTORE_UNMAPPABLE");
      const readback = await currentValue(payload, input.target);
      const state = authority === "engine" ? await materializeWorkspace(input.target.source.libraryRoot) : null;
      const matched = readback.digest === desiredDigest(payload);
      results.push({ ...base, status: matched && projection !== "pending" ? "applied" : "pending", reason: matched ? projection === "pending" ? "projection-pending" : null : "readback-mismatch", receipt: { authority, readbackDigest: readback.digest, headEventHash: state?.headEventHash ?? null, version: state?.version ?? null, projection } });
    } catch {
      results.push({ ...base, status: mutationStarted ? "pending" : "failed", reason: mutationStarted ? "write-outcome-needs-readback" : "restore-item-refused" });
    }
  }
  return { schemaVersion: "einzbern.config-restore-result.v1", planDigest: plan.planDigest, status: results.every(item => item.status === "applied" || item.status === "unchanged") ? "applied" : results.some(item => item.status === "applied" || item.status === "pending") ? "partial" : "refused", items: results };
}
