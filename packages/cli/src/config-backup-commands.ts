// SPDX-License-Identifier: Apache-2.0
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { JsonValue } from "../../protocol/src/index.js";
import type { RuntimeCommandCatalogEntry, RuntimeCommandFlag } from "../../core/src/runtime-input-contract.js";
import {
  collectConfigBackupPayloads, configBackupCanonical, configBackupFail, configBackupId,
  configBackupInstant, configBackupObject, configBackupString, planConfigBackup,
  readConfigBackupFile, verifyConfigBackup, writeConfigBackupNewFile,
} from "../../core/src/config-backup.js";
import type { ConfigBackupSelection, ConfigBackupSource, ConfigBackupSourceVersion } from "../../core/src/config-backup.js";
import { createConfigBackup, listConfigBackups, resumeConfigBackup, retireConfigBackup } from "../../core/src/config-backup-retention.js";
import type { ConfigBackupGroupBinding, ConfigBackupPolicyApproval, ConfigBackupStore } from "../../core/src/config-backup-retention.js";
import { applyConfigRestore, planConfigRestore } from "../../core/src/config-restore.js";
import type { ConfigRestorePlan, ConfigRestoreTarget } from "../../core/src/config-restore.js";

const flag = (name: string, required: boolean, valueKind = "string", valueShape?: string): RuntimeCommandFlag => ({ name, required, valueKind, ...(valueShape === undefined ? {} : { valueShape }) });
const targetFlags = [flag("workspace", false), flag("project", false), flag("project-id", false)];
const requestFlags = [flag("request", true, "string", "Existing private JSON file; closed per-command configuration-backup envelope"), flag("at", true, "instant"), flag("output", false, "string", "Private create-new JSON result; an existing output is never overwritten")];
export const CONFIG_BACKUP_COMMAND_CATALOG: readonly RuntimeCommandCatalogEntry[] = Object.freeze([
  { name: "config-backup-plan", availability: "cli", mutates: false, flags: [...targetFlags, ...requestFlags] },
  { name: "config-backup-create", availability: "cli", mutates: true, flags: [...targetFlags, ...requestFlags, flag("timeout-ms", false, "integer")] },
  { name: "config-backup-verify", availability: "cli", mutates: false, flags: [flag("package", true)] },
  { name: "config-backup-list", availability: "cli", mutates: false, flags: [flag("root", false), flag("at", true, "instant")] },
  { name: "config-backup-resume", availability: "cli", mutates: true, flags: [...targetFlags, ...requestFlags, flag("timeout-ms", false, "integer")] },
  { name: "config-backup-retire", availability: "cli", mutates: true, flags: [...targetFlags, ...requestFlags, flag("timeout-ms", false, "integer")] },
  { name: "config-restore-plan", availability: "cli", mutates: false, flags: [...targetFlags, ...requestFlags, flag("package", true), flag("actor", true), flag("decided-in", false, "string", "minutes:<id>#D<n>")] },
  { name: "config-restore-apply", availability: "cli", mutates: true, flags: [...targetFlags, ...requestFlags, flag("timeout-ms", false, "integer"), flag("package", true), flag("actor", true), flag("decided-in", false, "string", "minutes:<id>#D<n>"), flag("approved-plan-digest", true, "string", "Exact reviewed restore plan SHA-256; not permission to bypass existing write barriers")] },
]);
export interface ConfigBackupStoreRequest { readonly reservedRoot: string; readonly binding: ConfigBackupGroupBinding; readonly policy: unknown }
export interface ConfigBackupCommandContext {
  /** Installed candidate identity from the caller, never from an uploaded package or request. */
  sourceVersion(): Promise<ConfigBackupSourceVersion>;
  resolveSource(values: Readonly<Record<string, string>>): Promise<ConfigBackupSource>;
  /** Resolve the actual library/project/device/cleaner roots. Do not trust request-provided exclusions. */
  localBindingRoot(source: ConfigBackupSource): Promise<string>;
  protectedRoots(source: ConfigBackupSource): Promise<readonly string[]>;
  /** Existing permission boundary validates this exact policy/evidence, not merely its string shape. */
  approvePolicy(request: ConfigBackupStoreRequest, source: ConfigBackupSource, values: Readonly<Record<string, string>>): Promise<ConfigBackupPolicyApproval | null>;
  /** Reuse actual settings/rule/variable CLI permission checks; read-only preview never grants them. */
  resolveRestoreTarget(source: ConfigBackupSource, originalsStore: ConfigBackupStore, logicalKeys: readonly string[], values: Readonly<Record<string, string>>): Promise<ConfigRestoreTarget>;
}
function absolute(value: unknown): string { const path = configBackupString(value); if (!isAbsolute(path) || resolve(path) !== path) configBackupFail("CONFIG_BACKUP_PATH_INVALID"); return path; }
async function readRequest(path: string): Promise<unknown> {
  absolute(path); try { return JSON.parse((await readConfigBackupFile(dirname(path), basename(path))).toString("utf8")) as unknown; } catch { return configBackupFail("CONFIG_BACKUP_REQUEST_INVALID"); }
}
function selection(value: unknown): readonly ConfigBackupSelection[] {
  if (!Array.isArray(value)) configBackupFail("CONFIG_BACKUP_SELECTION_INVALID");
  return value.map(raw => {
    const v = configBackupObject(raw, ["kind", "key"]); configBackupString(v.key);
    if (!["agents-user-fragment", "setting", "device-preference", "path-remapping", "variable", "rule"].includes(String(v.kind))) configBackupFail("CONFIG_BACKUP_SELECTION_INVALID");
    return v as unknown as ConfigBackupSelection;
  });
}
function storeRequest(value: unknown): ConfigBackupStoreRequest {
  const v = configBackupObject(value, ["reservedRoot", "binding", "policy"]); absolute(v.reservedRoot);
  configBackupObject(v.binding, ["projectRef", "backupGroupId", "writerBindingRef", "executionEnvironmentRef", "hostname"]);
  return v as unknown as ConfigBackupStoreRequest;
}
async function storeFor(value: unknown, source: ConfigBackupSource, values: Readonly<Record<string, string>>, context: ConfigBackupCommandContext): Promise<ConfigBackupStore> {
  const request = storeRequest(value);
  if (configBackupCanonical(request.binding.projectRef) !== configBackupCanonical(source.projectRef)) configBackupFail("CONFIG_BACKUP_SOURCE_MISMATCH");
  const timeout = values["timeout-ms"];
  if (timeout !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(timeout) || !Number.isSafeInteger(Number(timeout)))) configBackupFail("CLI_ARGUMENT_MALFORMED");
  return { ...request, ...(timeout === undefined ? {} : { lockTimeoutMs: Number(timeout) }), localBindingRoot: await context.localBindingRoot(source), protectedRoots: await context.protectedRoots(source), approval: await context.approvePolicy(request, source, values) };
}
async function output(result: unknown, path: string | undefined): Promise<JsonValue> {
  const text = configBackupCanonical(result);
  if (path !== undefined) { absolute(path); await writeConfigBackupNewFile(dirname(path), basename(path), text); }
  return JSON.parse(text) as JsonValue;
}
/** null means unowned command, never an invalid request or an unsuccessful owned command. */
export async function runConfigBackupCommand(command: string, values: Readonly<Record<string, string>>, context: ConfigBackupCommandContext): Promise<JsonValue | null> {
  const entry = CONFIG_BACKUP_COMMAND_CATALOG.find(candidate => candidate.name === command); if (!entry) return null;
  if (Object.keys(values).some(key => !entry.flags.some(flag => flag.name === key)) || entry.flags.some(flag => flag.required && !values[flag.name])) configBackupFail("CLI_ARGUMENT_MALFORMED");
  if (command === "config-backup-verify") return output(await verifyConfigBackup(absolute(values.package)), undefined);
  const at = configBackupInstant(values.at);
  if (command === "config-backup-list") return output(await listConfigBackups({ at, ...(values.root === undefined ? {} : { reservedRoot: absolute(values.root) }) }), undefined);
  const raw = await readRequest(values.request!); const source = await context.resolveSource(values);
  let result: unknown;
  if (command === "config-backup-plan" || command === "config-backup-create") {
    const request = configBackupObject(raw, command === "config-backup-create" ? ["selection", "store", "backupId", "expectedSelectionDigest"] : ["selection", "backupGroupId", "hostname"]);
    const store = command === "config-backup-create" ? await storeFor(request.store, source, values, context) : null;
    const plan = planConfigBackup({ projectRef: source.projectRef, backupGroupId: configBackupId(store?.binding.backupGroupId ?? request.backupGroupId), hostname: configBackupString(store?.binding.hostname ?? request.hostname), sourceVersion: await context.sourceVersion(), at, payloads: await collectConfigBackupPayloads(source, selection(request.selection)), ...(command === "config-backup-create" ? { backupId: configBackupId(request.backupId) } : {}) });
    if (command === "config-backup-create") {
      if (plan.manifest.selectionDigest !== request.expectedSelectionDigest || plan.excluded.length) configBackupFail("CONFIG_BACKUP_SELECTION_CHANGED");
      result = await createConfigBackup(store!, plan, at);
    } else result = plan;
  } else if (command === "config-backup-resume" || command === "config-backup-retire") {
    const request = configBackupObject(raw, command === "config-backup-retire" ? ["store", "backupId"] : ["store", "mode"]);
    const store = await storeFor(request.store, source, values, context);
    result = command === "config-backup-resume" ? await resumeConfigBackup(store, at, request.mode === undefined || request.mode === "resume" ? "resume" : request.mode === "recover-failed" ? "recover-failed" : configBackupFail("CONFIG_BACKUP_RESUME_MODE_INVALID")) : await retireConfigBackup(store, configBackupId(request.backupId), at);
  } else {
    const request = configBackupObject(raw, command === "config-restore-apply" ? ["originalsStore", "plan"] : ["originalsStore"]);
    const packageRoot = absolute(values.package); const verified = await verifyConfigBackup(packageRoot);
    if (!verified.manifest || verified.integrity !== "verified") configBackupFail("CONFIG_RESTORE_PACKAGE_INVALID");
    const store = await storeFor(request.originalsStore, source, values, context);
    const target = await context.resolveRestoreTarget(source, store, verified.manifest.files.map(file => file.logicalKey), values);
    if (configBackupCanonical(target.source) !== configBackupCanonical(source) || configBackupCanonical(target.sourceVersion) !== configBackupCanonical(await context.sourceVersion())) configBackupFail("CONFIG_RESTORE_TARGET_MISMATCH");
    result = command === "config-restore-plan" ? await planConfigRestore({ packageRoot, target, at }) : await applyConfigRestore({ packageRoot, target, at, plan: request.plan as ConfigRestorePlan, approvedPlanDigest: values["approved-plan-digest"]! });
  }
  return output(result, values.output);
}
