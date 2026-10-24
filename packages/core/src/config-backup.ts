// SPDX-License-Identifier: Apache-2.0
// Shared configuration snapshots. This is not the retired whole-device backup protocol.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { assertStrictInstant, compareCanonicalText } from "../../protocol/src/index.js";
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
import { absolutePathLine, parseManagedFile } from "./managed-sections.js";
import { CONFIG_BACKUP_MACHINE_KEYS, readMachineSettings, validateMachineSettingValue } from "./machine-settings.js";
import { validateSettingValue } from "./settings.js";
import { checkVariableInput, looksSecretShaped } from "./variables.js";
import { BUILT_IN_RULES } from "./rules-catalog.js";
import { materializeWorkspace } from "./workspace.js";
import { readRegistry } from "./registry.js";

export const CONFIG_BACKUP_VERSION = "einzbern.config-backup.v1" as const;
export const CONFIG_BACKUP_MAPPING_VERSION = "einzbern.config-restore-mapping.v1" as const;
export const CONFIG_BACKUP_SETTING_KEYS = Object.freeze(["agents.generation", "agents.sharedNavigation", "artifact.language", "engine.requiredVersion", "execution.maxConcurrentSubagents", "injection.perPromptBytes", "retrieval.promptLanguages", "retrieval.scopeExcerptBytes", "retrieval.tau"] as const);
export const CONFIG_BACKUP_RESERVED_ROOTS = Object.freeze(["config-backups", "config-backup-staging", "config-backup-recovery"] as const);
export type ConfigBackupCategory = "user-content" | "governed-input" | "device-preference" | "regeneration-input";
export interface ConfigBackupProjectRef { readonly libraryId: string; readonly projectId: string }
export interface ConfigBackupSourceVersion {
  readonly engineVersion: string;
  readonly engineCommit: string | null;
  readonly engineCommitStatus: "known" | "unknown";
  /** Observed local running artifact content, not signed release provenance. */
  readonly artifactIdentity: { readonly kind: "observed-artifact-identity"; readonly schemaVersion: "einzbern.install-tree-digest.v1"; readonly sha256: string };
  readonly templateVersions: readonly string[];
}
export type ConfigBackupPayload =
  | { readonly kind: "agents-user-fragment"; readonly index: number; readonly text: string; readonly ownership: "user" }
  | { readonly kind: "setting"; readonly key: string; readonly value: string | null; readonly source: "project-declaration" | "library-declaration" }
  | { readonly kind: "device-preference"; readonly key: typeof CONFIG_BACKUP_MACHINE_KEYS[number]; readonly value: string | null; readonly source: "device-declaration" }
  | { readonly kind: "path-remapping"; readonly key: "paths.artifacts" | "paths.knowledgeArticles"; readonly remappingRequired: true }
  | { readonly kind: "variable"; readonly name: string; readonly declaration: { readonly type: string; readonly value: string; readonly description: string; readonly exports: readonly ("agents" | "handoff")[]; readonly order?: number } | null; readonly source: "project-declaration" | "library-declaration" }
  | { readonly kind: "rule"; readonly id: string; readonly version: number; readonly enabled: boolean; readonly order?: number; readonly source: "project-declaration" | "library-declaration" };
export interface ConfigBackupMember {
  readonly logicalKey: string; readonly memberPath: string; readonly category: ConfigBackupCategory;
  readonly bytes: number; readonly sha256: string; readonly requiredPermissionDescription: string;
  readonly restoreStrategy: typeof CONFIG_BACKUP_MAPPING_VERSION; readonly sourceDigest: string;
}
export interface ConfigBackupManifest {
  readonly schemaVersion: typeof CONFIG_BACKUP_VERSION; readonly backupId: string; readonly projectRef: ConfigBackupProjectRef;
  readonly backupGroupId: string; readonly hostnameLabel: { readonly display: string; readonly safe: string };
  readonly createdAtUtc: string; readonly sourceVersion: ConfigBackupSourceVersion; readonly selectionDigest: string;
  readonly manifestDigest: string; readonly state: "verified"; readonly files: readonly ConfigBackupMember[];
}
export interface ConfigBackupSelection { readonly kind: ConfigBackupPayload["kind"]; readonly key: string }
export interface ConfigBackupSource {
  readonly libraryRoot: string; readonly projectRoot: string; readonly machineSettingsPath: string;
  readonly projectRef: ConfigBackupProjectRef;
  readonly declarationScope: "project" | "library";
}
export interface ConfigBackupPlan {
  readonly schemaVersion: "einzbern.config-backup-plan.v1"; readonly manifest: ConfigBackupManifest;
  readonly members: readonly { readonly descriptor: ConfigBackupMember; readonly payload: ConfigBackupPayload }[];
  readonly excluded: readonly { readonly logicalKey: string; readonly reason: string }[];
  readonly bytes: number;
  readonly integrity: "not-verified";
}
export class ConfigBackupError extends Error {
  constructor(readonly reasonCode: string, message: string = reasonCode) { super(message); this.name = "ConfigBackupError"; }
}
export function configBackupFail(reasonCode: string): never { throw new ConfigBackupError(reasonCode); }
export const configBackupDigest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function configBackupCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(configBackupCanonical).join(",")}]`;
  if (typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort(compareCanonicalText).map(key => `${JSON.stringify(key)}:${configBackupCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return configBackupFail("CONFIG_BACKUP_NON_JSON");
}
export function configBackupObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) configBackupFail("CONFIG_BACKUP_INPUT_INVALID");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) configBackupFail("CONFIG_BACKUP_FIELD_UNKNOWN");
  return object;
}
export function configBackupString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) configBackupFail("CONFIG_BACKUP_INPUT_INVALID");
  return value;
}
export function configBackupInstant(value: unknown): string {
  const result = configBackupString(value); assertStrictInstant(result); if (!result.endsWith("Z")) configBackupFail("CONFIG_BACKUP_TIME_INVALID"); return result;
}
export function configBackupProjectRef(value: unknown): ConfigBackupProjectRef {
  const v = configBackupObject(value, ["libraryId", "projectId"]);
  if (!/^(?:library|workspace):[a-f0-9]{24}$/u.test(configBackupString(v.libraryId)) || !/^project:[a-f0-9]{24}$/u.test(configBackupString(v.projectId))) configBackupFail("CONFIG_BACKUP_PROJECT_INVALID");
  return { libraryId: v.libraryId as string, projectId: v.projectId as string };
}
export function configBackupId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) configBackupFail("CONFIG_BACKUP_ID_INVALID"); return value;
}
export function configBackupMemberPath(value: unknown): string {
  const path = configBackupString(value);
  if (path.normalize("NFC") !== path || path.endsWith(".") || /[\\:\u0000-\u001f\u007f]/u.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part)) || isAbsolute(path)) configBackupFail("CONFIG_BACKUP_PATH_INVALID");
  return path;
}
function safeText(value: string): void {
  if (looksSecretShaped(value) !== null || /(?:password|passwd|secret|token|api[_ -]?key|authorization|private[_ -]?key)\s*[:=]/iu.test(value) || absolutePathLine(value) !== null || /(?:^|\s)[A-Za-z]:[\\/]/u.test(value)) configBackupFail("CONFIG_BACKUP_CONTENT_EXCLUDED");
}
export function validateConfigBackupPayload(value: unknown): ConfigBackupPayload {
  const raw = configBackupObject(value, ["kind", "key", "value", "source", "index", "text", "ownership", "name", "declaration", "id", "version", "enabled", "order", "remappingRequired"]);
  if (raw.kind === "agents-user-fragment") {
    configBackupObject(raw, ["kind", "index", "text", "ownership"]);
    if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0 || typeof raw.text !== "string" || raw.ownership !== "user" || /<!--\s*(?:einzbern|tcrn)/iu.test(raw.text)) configBackupFail("CONFIG_BACKUP_CONTENT_EXCLUDED");
    safeText(raw.text);
  } else if (raw.kind === "setting") {
    configBackupObject(raw, ["kind", "key", "value", "source"]);
    if (!CONFIG_BACKUP_SETTING_KEYS.includes(raw.key as typeof CONFIG_BACKUP_SETTING_KEYS[number]) || !["project-declaration", "library-declaration"].includes(configBackupString(raw.source))) configBackupFail("CONFIG_BACKUP_KEY_EXCLUDED");
    if (raw.value !== null) safeText(validateSettingValue(raw.key, raw.value));
  } else if (raw.kind === "device-preference") {
    configBackupObject(raw, ["kind", "key", "value", "source"]);
    if (!CONFIG_BACKUP_MACHINE_KEYS.includes(raw.key as typeof CONFIG_BACKUP_MACHINE_KEYS[number]) || raw.source !== "device-declaration") configBackupFail("CONFIG_BACKUP_KEY_EXCLUDED");
    if (raw.value !== null) safeText(validateMachineSettingValue(raw.key as typeof CONFIG_BACKUP_MACHINE_KEYS[number], raw.value));
  } else if (raw.kind === "path-remapping") {
    configBackupObject(raw, ["kind", "key", "remappingRequired"]);
    if (!["paths.artifacts", "paths.knowledgeArticles"].includes(configBackupString(raw.key)) || raw.remappingRequired !== true) configBackupFail("CONFIG_BACKUP_KEY_EXCLUDED");
  } else if (raw.kind === "variable") {
    configBackupObject(raw, ["kind", "name", "declaration", "source"]);
    const name = configBackupString(raw.name);
    if (/(?:secret|token|password|credential|identity|oauth|trust|lease|admission)/iu.test(name) || !["project-declaration", "library-declaration"].includes(configBackupString(raw.source))) configBackupFail("CONFIG_BACKUP_KEY_EXCLUDED");
    if (raw.declaration === null) checkVariableInput({ name, type: "string", value: "", exports: [] });
    else {
      const d = configBackupObject(raw.declaration, ["type", "value", "description", "exports", "order"]);
      if (typeof d.description !== "string" || !Array.isArray(d.exports)) configBackupFail("CONFIG_BACKUP_INPUT_INVALID");
      if (name === "dot.extensions.source" && typeof d.value === "string") {
        let source: unknown;
        try { source = JSON.parse(d.value); } catch { source = null; }
        // The generic backup/restore path cannot reproduce fresh approved Git
        // verification bindings. Refuse visibly, never downgrade to generic variable admission.
        if (source !== null && typeof source === "object" && Object.hasOwn(source, "technicalReferences")) configBackupFail("CONFIG_BACKUP_DOT_TECHNICAL_REFERENCES_UNSUPPORTED");
      }
      const checked = checkVariableInput({ name, ...d } as Parameters<typeof checkVariableInput>[0]);
      safeText(`${checked.value}\n${checked.description}`);
    }
  } else if (raw.kind === "rule") {
    configBackupObject(raw, ["kind", "id", "version", "enabled", "order", "source"]);
    if (!BUILT_IN_RULES.some(rule => rule.id === raw.id) || !Number.isSafeInteger(raw.version) || (raw.version as number) < 1 || typeof raw.enabled !== "boolean" || !["project-declaration", "library-declaration"].includes(configBackupString(raw.source)) || (raw.order !== undefined && (!Number.isSafeInteger(raw.order) || (raw.order as number) < 1))) configBackupFail("CONFIG_BACKUP_RULE_INVALID");
  } else configBackupFail("CONFIG_BACKUP_KEY_EXCLUDED");
  return raw as unknown as ConfigBackupPayload;
}
export function configBackupPayloadKey(payload: ConfigBackupPayload): string {
  return `${payload.kind}:${payload.kind === "agents-user-fragment" ? payload.index : payload.kind === "rule" ? payload.id : payload.kind === "variable" ? payload.name : payload.key}`;
}
function category(payload: ConfigBackupPayload): ConfigBackupCategory {
  return payload.kind === "agents-user-fragment" ? "user-content" : payload.kind === "device-preference" ? "device-preference" : payload.kind === "rule" || payload.kind === "path-remapping" ? "regeneration-input" : "governed-input";
}
function sourceVersion(value: unknown): ConfigBackupSourceVersion {
  const v = configBackupObject(value, ["engineVersion", "engineCommit", "engineCommitStatus", "artifactIdentity", "templateVersions"]);
  configBackupString(v.engineVersion);
  const artifact = configBackupObject(v.artifactIdentity, ["kind", "schemaVersion", "sha256"]);
  if (artifact.kind !== "observed-artifact-identity" || artifact.schemaVersion !== "einzbern.install-tree-digest.v1" || !/^[a-f0-9]{64}$/u.test(configBackupString(artifact.sha256))) configBackupFail("CONFIG_BACKUP_VERSION_INVALID");
  if (!(v.engineCommitStatus === "unknown" && v.engineCommit === null || v.engineCommitStatus === "known" && typeof v.engineCommit === "string" && /^[a-f0-9]{40}$/u.test(v.engineCommit)) || !Array.isArray(v.templateVersions) || v.templateVersions.some(item => typeof item !== "string" || !item)) configBackupFail("CONFIG_BACKUP_VERSION_INVALID");
  return v as unknown as ConfigBackupSourceVersion;
}
export function configBackupManifestDigest(manifest: Omit<ConfigBackupManifest, "manifestDigest"> | ConfigBackupManifest): string {
  const { manifestDigest: _digest, ...body } = manifest as ConfigBackupManifest;
  return configBackupDigest(configBackupCanonical(body));
}
function selectionDigest(files: readonly ConfigBackupMember[]): string {
  return configBackupDigest(configBackupCanonical(files.map(({ logicalKey, category: memberCategory, restoreStrategy, sourceDigest }) => ({ logicalKey, category: memberCategory, restoreStrategy, sourceDigest }))));
}
export function validateConfigBackupManifest(value: unknown): ConfigBackupManifest {
  const v = configBackupObject(value, ["schemaVersion", "backupId", "projectRef", "backupGroupId", "hostnameLabel", "createdAtUtc", "sourceVersion", "selectionDigest", "manifestDigest", "state", "files"]);
  if (v.schemaVersion !== CONFIG_BACKUP_VERSION || v.state !== "verified" || !Array.isArray(v.files)) configBackupFail("CONFIG_BACKUP_SCHEMA_UNSUPPORTED");
  configBackupId(v.backupId); configBackupId(v.backupGroupId); configBackupProjectRef(v.projectRef); configBackupInstant(v.createdAtUtc); sourceVersion(v.sourceVersion);
  const label = configBackupObject(v.hostnameLabel, ["display", "safe"]); safeText(configBackupString(label.display));
  if (label.safe !== safeConfigBackupHostname(label.display as string)) configBackupFail("CONFIG_BACKUP_HOSTNAME_INVALID");
  const logical = new Set<string>(); const paths = new Set<string>(); let previous = "";
  for (const item of v.files) {
    const f = configBackupObject(item, ["logicalKey", "memberPath", "category", "bytes", "sha256", "requiredPermissionDescription", "restoreStrategy", "sourceDigest"]);
    const key = configBackupString(f.logicalKey); const path = configBackupMemberPath(f.memberPath);
    if (logical.has(key) || paths.has(path.toLowerCase()) || previous >= path || !/^members\/[a-f0-9]{64}\.json$/u.test(path)) configBackupFail("CONFIG_BACKUP_MEMBER_DUPLICATE");
    logical.add(key); paths.add(path.toLowerCase()); previous = path;
    if (!["user-content", "governed-input", "device-preference", "regeneration-input"].includes(configBackupString(f.category)) || f.restoreStrategy !== CONFIG_BACKUP_MAPPING_VERSION || !Number.isSafeInteger(f.bytes) || (f.bytes as number) < 0 || !/^[a-f0-9]{64}$/u.test(configBackupString(f.sha256)) || !/^[a-f0-9]{64}$/u.test(configBackupString(f.sourceDigest))) configBackupFail("CONFIG_BACKUP_MANIFEST_INVALID");
    if (f.requiredPermissionDescription !== `Restore selected ${f.category as string} through its supported authority`) configBackupFail("CONFIG_BACKUP_MANIFEST_INVALID");
  }
  for (const value of [v.selectionDigest, v.manifestDigest]) if (!/^[a-f0-9]{64}$/u.test(configBackupString(value))) configBackupFail("CONFIG_BACKUP_MANIFEST_INVALID");
  const manifest = v as unknown as ConfigBackupManifest;
  if (selectionDigest(manifest.files) !== manifest.selectionDigest || configBackupManifestDigest(manifest) !== manifest.manifestDigest) configBackupFail("CONFIG_BACKUP_DIGEST_MISMATCH");
  return manifest;
}
export function safeConfigBackupHostname(display: string): string {
  return configBackupString(display).normalize("NFKC").replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80) || "device";
}
/** Values must have come from the closed authoritative reader; callers may also build isolated fixtures. */
export function planConfigBackup(input: { readonly projectRef: ConfigBackupProjectRef; readonly backupGroupId: string; readonly hostname: string; readonly at: string; readonly sourceVersion: ConfigBackupSourceVersion; readonly payloads: readonly ConfigBackupPayload[]; readonly backupId?: string }): ConfigBackupPlan {
  const excluded: { logicalKey: string; reason: string }[] = []; const seen = new Set<string>();
  const members: { descriptor: ConfigBackupMember; payload: ConfigBackupPayload }[] = [];
  for (const raw of input.payloads) {
    let payload: ConfigBackupPayload;
    try { payload = validateConfigBackupPayload(raw); } catch (error) {
      const reason = error instanceof ConfigBackupError && error.reasonCode === "CONFIG_BACKUP_DOT_TECHNICAL_REFERENCES_UNSUPPORTED" ? "dot-technical-references-unsupported" : "not-in-safe-allowlist";
      excluded.push({ logicalKey: `selection:${excluded.length + members.length}`, reason }); continue;
    }
    const logicalKey = configBackupPayloadKey(payload); if (seen.has(logicalKey)) configBackupFail("CONFIG_BACKUP_MEMBER_DUPLICATE"); seen.add(logicalKey);
    const text = configBackupCanonical(payload); const sha256 = configBackupDigest(text); const memberCategory = category(payload);
    members.push({ payload, descriptor: { logicalKey, memberPath: `members/${configBackupDigest(logicalKey)}.json`, category: memberCategory, bytes: Buffer.byteLength(text), sha256, requiredPermissionDescription: `Restore selected ${memberCategory} through its supported authority`, restoreStrategy: CONFIG_BACKUP_MAPPING_VERSION, sourceDigest: sha256 } });
  }
  members.sort((a, b) => a.descriptor.memberPath < b.descriptor.memberPath ? -1 : 1);
  const files = members.map(member => member.descriptor);
  const body = { schemaVersion: CONFIG_BACKUP_VERSION, backupId: configBackupId(input.backupId ?? randomBytes(16).toString("hex")), projectRef: configBackupProjectRef(input.projectRef), backupGroupId: configBackupId(input.backupGroupId), hostnameLabel: { display: input.hostname, safe: safeConfigBackupHostname(input.hostname) }, createdAtUtc: configBackupInstant(input.at), sourceVersion: sourceVersion(input.sourceVersion), selectionDigest: selectionDigest(files), state: "verified" as const, files };
  // This manifest is a proposal until verifyConfigBackup reads every byte. Its state is never
  // persisted as staging; the transaction/index independently describes publication progress.
  const manifest = validateConfigBackupManifest({ ...body, manifestDigest: configBackupManifestDigest(body) });
  return { schemaVersion: "einzbern.config-backup-plan.v1", integrity: "not-verified", manifest, members, excluded, bytes: Buffer.byteLength(configBackupCanonical(manifest)) + files.reduce((sum, file) => sum + file.bytes, 0) };
}
export async function assertConfigBackupSource(source: ConfigBackupSource): Promise<void> {
  configBackupProjectRef(source.projectRef);
  if (source.declarationScope !== "project" && source.declarationScope !== "library") configBackupFail("CONFIG_BACKUP_SOURCE_SCOPE_REQUIRED");
  await assertConfigBackupDirectory(source.projectRoot); await assertConfigBackupDirectory(source.libraryRoot);
  const registered = (await readRegistry()).entries.filter(entry => entry.libraryId === source.projectRef.libraryId && entry.libraryPath === source.libraryRoot && entry.projectPath === source.projectRoot && (source.declarationScope === "library" || entry.projectId === source.projectRef.projectId));
  if (registered.length !== 1) configBackupFail("CONFIG_BACKUP_SOURCE_UNBOUND");
}
export async function collectConfigBackupPayloads(source: ConfigBackupSource, selection: readonly ConfigBackupSelection[]): Promise<readonly ConfigBackupPayload[]> {
  await assertConfigBackupSource(source);
  const scopeId = source.declarationScope === "project" ? source.projectRef.projectId : undefined;
  const declarationSource = source.declarationScope === "project" ? "project-declaration" as const : "library-declaration" as const;
  const state = await materializeWorkspace(source.libraryRoot);
  if (state.metadata.workspaceId !== source.projectRef.libraryId || !state.projects.some(project => project.id === source.projectRef.projectId && !project.tombstone)) configBackupFail("CONFIG_BACKUP_SOURCE_MISMATCH");
  try { await readConfigBackupFile(dirname(source.machineSettingsPath), source.machineSettingsPath.slice(dirname(source.machineSettingsPath).length + 1)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const machine = await readMachineSettings(source.machineSettingsPath); const result: ConfigBackupPayload[] = [];
  let fragments: readonly string[] | undefined;
  for (const item of selection) {
    configBackupObject(item, ["kind", "key"]); configBackupString(item.key);
    if (item.kind === "setting") result.push({ kind: item.kind, key: item.key, value: state.settings.find(record => record.projectId === scopeId && record.key === item.key)?.value ?? null, source: declarationSource });
    else if (item.kind === "device-preference") result.push({ kind: item.kind, key: item.key as typeof CONFIG_BACKUP_MACHINE_KEYS[number], value: machine.values[item.key] ?? null, source: "device-declaration" });
    else if (item.kind === "path-remapping") result.push({ kind: item.kind, key: item.key as "paths.artifacts" | "paths.knowledgeArticles", remappingRequired: true });
    else if (item.kind === "agents-user-fragment") {
      fragments ??= parseManagedFile((await readConfigBackupFile(source.projectRoot, "AGENTS.md")).toString("utf8")).outside;
      if (!/^(0|[1-9][0-9]*)$/u.test(item.key) || fragments[Number(item.key)] === undefined) configBackupFail("CONFIG_BACKUP_SELECTION_INVALID");
      result.push({ kind: item.kind, index: Number(item.key), text: fragments[Number(item.key)]!, ownership: "user" });
    } else if (item.kind === "variable" || item.kind === "rule") {
      const record = state.configRecords.find(record => record.projectId === scopeId && record.collection === item.kind && record.key === item.key);
      if (item.kind === "variable") result.push({ kind: item.kind, name: item.key, declaration: record === undefined ? null : record.value as unknown as Extract<ConfigBackupPayload, { kind: "variable" }>["declaration"], source: declarationSource });
      else {
        const rule = BUILT_IN_RULES.find(rule => rule.id === item.key); if (!rule) configBackupFail("CONFIG_BACKUP_RULE_INVALID");
        // No declaration is not an explicit disabled declaration, particularly when a project
        // inherits a rule. Do not manufacture a local source record from catalog defaults.
        if (record === undefined) configBackupFail("CONFIG_BACKUP_DECLARATION_MISSING");
        result.push({ kind: item.kind, id: item.key, version: record.value.version as number, enabled: record.value.enabled as boolean, ...(record.value.order === undefined ? {} : { order: record.value.order as number }), source: declarationSource });
      }
    } else configBackupFail("CONFIG_BACKUP_KEY_EXCLUDED");
  }
  return result;
}
/** No link traversal, including ancestors. A caller must supply a concrete, existing root. */
export async function assertConfigBackupDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) configBackupFail("CONFIG_BACKUP_PATH_INVALID");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) configBackupFail("CONFIG_BACKUP_PATH_INVALID");
  }
  if (await realpath(path) !== path) configBackupFail("CONFIG_BACKUP_PATH_INVALID"); return path;
}
export async function readConfigBackupFile(root: string, member: string): Promise<Buffer> {
  await assertConfigBackupDirectory(root); const safe = configBackupMemberPath(member); const path = join(root, safe);
  await assertConfigBackupDirectory(dirname(path)); const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > RUNTIME_CAPACITY.bufferBytes) configBackupFail("CONFIG_BACKUP_PATH_INVALID");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) configBackupFail("CONFIG_BACKUP_SOURCE_CHANGED");
    const bytes = await file.readFile(); const after = await file.stat();
    if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !isUtf8(bytes)) configBackupFail("CONFIG_BACKUP_SOURCE_CHANGED"); return bytes;
  } finally { await file.close(); }
}
export async function writeConfigBackupNewFile(root: string, member: string, text: string): Promise<void> {
  await assertConfigBackupDirectory(root); const path = join(root, configBackupMemberPath(member)); await assertConfigBackupDirectory(dirname(path));
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text, "utf8"); await file.sync(); } finally { await file.close(); }
  if (!(await readConfigBackupFile(root, member)).equals(Buffer.from(text))) configBackupFail("CONFIG_BACKUP_READBACK_FAILED");
}
export async function assertConfigBackupReservedRoot(root: string, protectedRoots: readonly string[]): Promise<void> {
  await assertConfigBackupDirectory(root);
  if (root === parse(root).root || root === homedir() || protectedRoots.length === 0) configBackupFail("CONFIG_BACKUP_ROOT_UNSAFE");
  for (const protectedRoot of protectedRoots) {
    if (!isAbsolute(protectedRoot)) configBackupFail("CONFIG_BACKUP_ROOT_UNSAFE");
    const a = relative(root, resolve(protectedRoot)); const b = relative(resolve(protectedRoot), root);
    if (a === "" || (!a.startsWith(`..${sep}`) && a !== ".." && !isAbsolute(a)) || (!b.startsWith(`..${sep}`) && b !== ".." && !isAbsolute(b))) configBackupFail("CONFIG_BACKUP_ROOT_UNSAFE");
  }
}
export interface ConfigBackupVerification { readonly integrity: "verified" | "corrupt" | "unreadable"; readonly manifest: ConfigBackupManifest | null; readonly error: string | null }
export async function verifyConfigBackup(packageRoot: string): Promise<ConfigBackupVerification> {
  try {
    const manifestBytes = await readConfigBackupFile(packageRoot, "manifest.json");
    const manifest = validateConfigBackupManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    if (manifestBytes.toString("utf8") !== configBackupCanonical(manifest)) configBackupFail("CONFIG_BACKUP_NON_CANONICAL");
    const top = (await readdir(packageRoot)).sort();
    if (configBackupCanonical(top) !== configBackupCanonical(["manifest.json", "members"])) configBackupFail("CONFIG_BACKUP_UNEXPECTED_MEMBER");
    const actual = (await readdir(join(packageRoot, "members"))).sort().map(name => `members/${name}`);
    if (configBackupCanonical(actual) !== configBackupCanonical(manifest.files.map(file => file.memberPath))) configBackupFail("CONFIG_BACKUP_UNEXPECTED_MEMBER");
    for (const file of manifest.files) {
      const bytes = await readConfigBackupFile(packageRoot, file.memberPath);
      const payload = validateConfigBackupPayload(JSON.parse(bytes.toString("utf8")) as unknown);
      if (bytes.length !== file.bytes || configBackupDigest(bytes) !== file.sha256 || file.sourceDigest !== file.sha256 || file.logicalKey !== configBackupPayloadKey(payload) || file.category !== category(payload) || file.memberPath !== `members/${configBackupDigest(file.logicalKey)}.json` || bytes.toString("utf8") !== configBackupCanonical(payload)) configBackupFail("CONFIG_BACKUP_DIGEST_MISMATCH");
    }
    return { integrity: "verified", manifest, error: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { integrity: code === "EACCES" || code === "EPERM" ? "unreadable" : "corrupt", manifest: null, error: error instanceof ConfigBackupError ? error.reasonCode : code ?? "CONFIG_BACKUP_INVALID" };
  }
}
/** Internal publication step: the group policy/ownership gate must already hold. No overwrites. */
export async function writeConfigBackupPackage(packageRoot: string, plan: ConfigBackupPlan): Promise<ConfigBackupVerification> {
  validateConfigBackupManifest(plan.manifest);
  if (configBackupCanonical(plan.members.map(m => m.descriptor)) !== configBackupCanonical(plan.manifest.files)) configBackupFail("CONFIG_BACKUP_PLAN_INVALID");
  for (const member of plan.members) {
    const text = configBackupCanonical(validateConfigBackupPayload(member.payload));
    if (Buffer.byteLength(text) !== member.descriptor.bytes || configBackupDigest(text) !== member.descriptor.sha256) configBackupFail("CONFIG_BACKUP_PLAN_INVALID");
  }
  await assertConfigBackupDirectory(dirname(packageRoot)); await mkdir(packageRoot, { mode: 0o700 }); await mkdir(join(packageRoot, "members"), { mode: 0o700 });
  for (const member of plan.members) await writeConfigBackupNewFile(packageRoot, member.descriptor.memberPath, configBackupCanonical(validateConfigBackupPayload(member.payload)));
  await writeConfigBackupNewFile(packageRoot, "manifest.json", configBackupCanonical(plan.manifest));
  return verifyConfigBackup(packageRoot);
}
