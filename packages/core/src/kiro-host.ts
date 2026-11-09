// SPDX-License-Identifier: Apache-2.0

// Kiro's CLI and IDE are separate surfaces. CLI version discovery proves neither which harness
// a later session selected nor which model that session actually used. Standalone hooks follow
// Kiro's versioned JSON contract and are kept separate from Claude/Codex's grouped hook files.

import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { writeFileAtomic } from "./atomic-file.js";
import { backupsPath, ensureDeviceDirectory } from "./device-home.js";
import { hookLauncherPath, hostHookCommand, isEinzbernHookCommand } from "./host-hooks.js";

export const KIRO_HOOKS_FILE = ".kiro/hooks/einzbern.json" as const;
export const KIRO_USER_HOOKS_FILE = "hooks/einzbern.json" as const;
export const KIRO_SKILL_ROOT = ".kiro/skills" as const;
export const KIRO_HOOKS_VERSION = "v1" as const;
export const KIRO_HOOKS_SCHEMA_VERSION = "tcrn.kiro-hooks-plan.v1" as const;
const KIRO_OWNED_HOOK_NAMES = new Set(["einzbern-session-start", "einzbern-prompt-recall", "einzbern-read-guard"]);

export type KiroSurfaceStatus = "available" | "not-detected" | "unavailable" | "unknown";
export interface KiroHostIdentity {
  readonly schemaVersion: "tcrn.kiro-host-identity.v1";
  readonly observedAt: string;
  readonly cli: { readonly status: KiroSurfaceStatus; readonly executable: string | null; readonly version: string | null; readonly versionEvidence: string | null };
  readonly ide: { readonly status: KiroSurfaceStatus; readonly bundlePath: string | null; readonly bundleId: string | null; readonly version: string | null };
  readonly selected: "unknown";
  readonly requestedCliHarness: "v3";
  readonly actualCliHarness: { readonly status: "unknown"; readonly reason: string };
  readonly subagentFirstWork: { readonly status: "unknown"; readonly reason: string };
}

export class KiroHostError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) { super(message); this.name = "KiroHostError"; this.reasonCode = reasonCode; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function xmlValue(text: string, key: string): string | null {
  const expression = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, "u");
  return expression.exec(text)?.[1]?.trim() || null;
}

/** Read-only host identity. `--version` makes no session or model request; IDE facts need bundle evidence. */
export function probeKiroHost(input: {
  readonly home?: string;
  readonly executable?: string;
  readonly ideBundlePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: string;
} = {}): KiroHostIdentity {
  const home = resolve(input.home ?? homedir());
  const env = input.env ?? process.env;
  const executable = input.executable ?? "kiro-cli";
  const observedAt = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  let cli: KiroHostIdentity["cli"] = { status: "not-detected", executable: null, version: null, versionEvidence: null };
  try {
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 16_384, env, shell: false, windowsHide: true });
    if ((result.error as NodeJS.ErrnoException | null)?.code === "ENOENT") cli = { status: "not-detected", executable: null, version: null, versionEvidence: null };
    else if (result.error || result.status !== 0) cli = { status: "unavailable", executable, version: null, versionEvidence: "kiro-cli --version did not return successfully" };
    else {
      const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const version = /(?:^|\n)kiro-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/iu.exec(text)?.[1] ?? null;
      cli = { status: version === null ? "unknown" : "available", executable, version, versionEvidence: version === null ? null : "kiro-cli --version" };
    }
  } catch {
    cli = { status: "unavailable", executable, version: null, versionEvidence: "kiro-cli --version could not be observed" };
  }

  const candidates = input.ideBundlePath !== undefined
    ? [resolve(input.ideBundlePath)]
    : process.platform === "darwin" ? ["/Applications/Kiro.app", join(home, "Applications", "Kiro.app")] : [];
  let ide: KiroHostIdentity["ide"] = { status: "not-detected", bundlePath: null, bundleId: null, version: null };
  for (const bundlePath of candidates) {
    try {
      const stats = awaitlessLstat(bundlePath);
      if (stats !== "directory") continue;
      const infoPath = join(bundlePath, "Contents", "Info.plist");
      const plist = awaitlessRead(infoPath);
      if (plist === null) { ide = { status: "unknown", bundlePath, bundleId: null, version: null }; break; }
      const bundleId = xmlValue(plist, "CFBundleIdentifier");
      const version = xmlValue(plist, "CFBundleShortVersionString") ?? xmlValue(plist, "CFBundleVersion");
      if (bundleId?.toLowerCase().includes("kiro")) { ide = { status: "available", bundlePath, bundleId, version }; break; }
      ide = { status: "unknown", bundlePath, bundleId, version };
    } catch { ide = { status: "unknown", bundlePath, bundleId: null, version: null }; }
  }
  return {
    schemaVersion: "tcrn.kiro-host-identity.v1", observedAt, cli, ide, selected: "unknown", requestedCliHarness: "v3",
    actualCliHarness: { status: "unknown", reason: "a version probe does not observe a session harness; require a per-run transcript" },
    subagentFirstWork: { status: "unknown", reason: "documented SessionStart/AgentSpawn aliases have no subagent tool context or first-work signal" },
  };
}

function awaitlessLstat(path: string): "directory" | null {
  try {
    const { lstatSync } = requireFs();
    const stats = lstatSync(path);
    return stats.isSymbolicLink() ? null : stats.isDirectory() ? "directory" : null;
  } catch { return null; }
}

function awaitlessRead(path: string): string | null {
  try { return requireFs().readFileSync(path, "utf8"); } catch { return null; }
}

function requireFs(): typeof import("node:fs") {
  // Static namespace import keeps the module built-in and works on the supported Node line.
  return fsModule;
}

import * as fsModule from "node:fs";

/** Kiro CLI V3's legacy AgentSpawn aliases mean session start only; no subagent event is invented. */
export function kiroHookEventName(value: unknown): "SessionStart" | "UserPromptSubmit" | "PreToolUse" | null {
  if (typeof value !== "string") return null;
  if (["SessionStart", "session-start", "AgentSpawn", "agentSpawn", "agent-spawn"].includes(value)) return "SessionStart";
  if (["PromptSubmit", "UserPromptSubmit", "user-prompt-submit"].includes(value)) return "UserPromptSubmit";
  if (["PreToolUse", "pre-tool-use"].includes(value)) return "PreToolUse";
  return null;
}

export interface KiroHookEntry {
  readonly name: string;
  readonly trigger: "SessionStart" | "UserPromptSubmit" | "PreToolUse";
  readonly matcher?: string;
  readonly action: { readonly type: "command"; readonly command: string };
  readonly timeout: number;
  readonly enabled: true;
}

export interface KiroHooksRequest {
  readonly root: string;
  readonly deviceHome: string;
  readonly userHome: string;
  readonly scope: "user" | "project";
  readonly platform?: NodeJS.Platform;
  readonly install?: boolean;
  readonly navigation?: "always" | "declined" | null;
}

export interface KiroHookFilePlan {
  readonly schemaVersion: typeof KIRO_HOOKS_SCHEMA_VERSION;
  readonly scope: "user" | "project";
  readonly root: string;
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
  readonly removed: readonly string[];
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => isObject(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
}

function wantedKiroHooks(request: KiroHooksRequest): readonly KiroHookEntry[] {
  if (request.install === false) return [];
  const launcher = hookLauncherPath(request.deviceHome, request.platform);
  const entries: KiroHookEntry[] = [
    { name: "einzbern-prompt-recall", trigger: "UserPromptSubmit", action: { type: "command", command: hostHookCommand(launcher, "UserPromptSubmit", request.userHome, request.platform, "kiro") }, timeout: 30, enabled: true },
    { name: "einzbern-read-guard", trigger: "PreToolUse", matcher: "read", action: { type: "command", command: hostHookCommand(launcher, "PreToolUse", request.userHome, request.platform, "kiro") }, timeout: 30, enabled: true },
  ];
  if (request.navigation === "declined") entries.unshift({ name: "einzbern-session-start", trigger: "SessionStart", action: { type: "command", command: hostHookCommand(launcher, "SessionStart", request.userHome, request.platform, "kiro") }, timeout: 30, enabled: true });
  return entries;
}

function actionCommand(value: unknown): string | null {
  return isObject(value) && isObject(value.action) && typeof value.action.command === "string" ? value.action.command : null;
}

function hooksRelativePath(scope: "user" | "project"): string {
  return scope === "user" ? KIRO_USER_HOOKS_FILE : KIRO_HOOKS_FILE;
}

/** Merge only explicitly named Einzbern entries; all custom hooks and document keys remain in place. */
export function mergeKiroHookDocument(existingValue: unknown, request: KiroHooksRequest): { readonly document: Record<string, unknown>; readonly removed: readonly string[] } {
  if (existingValue !== null && existingValue !== undefined && !isObject(existingValue)) throw new KiroHostError("KIRO_HOOKS_FILE_UNSUPPORTED", "standalone hooks document must be an object");
  const source = isObject(existingValue) ? existingValue : {};
  if (source.version !== undefined && source.version !== KIRO_HOOKS_VERSION) throw new KiroHostError("KIRO_HOOKS_VERSION_UNSUPPORTED", "standalone hook version is not v1");
  if (source.hooks !== undefined && !Array.isArray(source.hooks)) throw new KiroHostError("KIRO_HOOKS_FILE_UNSUPPORTED", "standalone hooks must be an array");
  const hooks: unknown[] = Array.isArray(source.hooks) ? [...source.hooks] : [];
  const wanted = wantedKiroHooks(request);
  const names = new Set(wanted.map(entry => entry.name));
  const removed: string[] = [];
  const kept: unknown[] = [];
  let insertAt: number | null = null;
  // Only these exact managed entry shapes carry our ownership evidence. The command path may
  // change when the device home is relocated, but edits to the trigger, matcher, timeout, enabled
  // state, or action remain a conflict instead of being silently overwritten or deleted.
  const ownershipTemplates = new Map(wantedKiroHooks({ ...request, install: true, navigation: "declined" }).map(entry => [entry.name, entry]));
  for (const entry of hooks) {
    const name = isObject(entry) && typeof entry.name === "string" ? entry.name : null;
    if (name === null || !ownershipTemplates.has(name)) { kept.push(entry); continue; }
    const command = actionCommand(entry);
    if (command === null || !isEinzbernHookCommand(command)) throw new KiroHostError("KIRO_HOOKS_OWNERSHIP_CONFLICT", `managed hook ${name} no longer names the Einzbern launcher`);
    const template = ownershipTemplates.get(name)!;
    const normalizedEntry = structuredClone(entry) as Record<string, unknown>;
    const action = normalizedEntry.action as Record<string, unknown>;
    action.command = template.action.command;
    if (stable(normalizedEntry) !== stable(template)) throw new KiroHostError("KIRO_HOOKS_OWNERSHIP_CONFLICT", `managed hook ${name} was edited; preserve it for review`);
    const expected = wanted.find(candidate => candidate.name === name);
    insertAt ??= kept.length;
    if (expected === undefined || names.delete(name)) removed.push(name);
    // A same-name exact owned copy is replaced by the expected copy. Surplus exact owned copies are removed.
  }
  const at = insertAt ?? kept.length;
  const next = [...kept.slice(0, at), ...wanted, ...kept.slice(at)];
  return { document: { ...source, version: KIRO_HOOKS_VERSION, hooks: next }, removed };
}

async function regularFile(path: string): Promise<boolean> {
  try { const stats = await lstat(path); return stats.isFile() && !stats.isSymbolicLink(); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return false; throw error; }
}

/** Read and plan one Kiro standalone file. Reads never follow a symbolic link. */
export async function planKiroHooks(request: KiroHooksRequest): Promise<KiroHookFilePlan> {
  const root = resolve(request.root);
  const path = join(root, ...hooksRelativePath(request.scope).split("/"));
  let before: string | null = null;
  if (await regularFile(path)) before = await readFile(path, "utf8");
  else {
    try { const stats = await lstat(path); if (stats.isSymbolicLink() || stats.isDirectory()) throw new KiroHostError("KIRO_HOOKS_PATH_UNSUPPORTED", `${path} is not a regular file`); }
    catch (error) { if (error instanceof KiroHostError) throw error; if (!(["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))) throw error; }
  }
  if (request.install === false && before === null) {
    return { schemaVersion: KIRO_HOOKS_SCHEMA_VERSION, scope: request.scope, root, path, before: null, after: null, changed: false, removed: [] };
  }
  let existing: unknown = null;
  if (before !== null) {
    try { existing = JSON.parse(before) as unknown; } catch { throw new KiroHostError("KIRO_HOOKS_FILE_UNSUPPORTED", `${path} is not JSON`); }
    if (!isObject(existing)) throw new KiroHostError("KIRO_HOOKS_FILE_UNSUPPORTED", `${path} is not a Hooks object`);
  }
  const merged = mergeKiroHookDocument(existing, request);
  const rendered = `${JSON.stringify(merged.document, null, 2)}\n`;
  const same = before !== null && stable(JSON.parse(before)) === stable(merged.document);
  const after = same ? before! : rendered;
  return { schemaVersion: KIRO_HOOKS_SCHEMA_VERSION, scope: request.scope, root, path, before, after, changed: before !== after, removed: merged.removed };
}

/** Plan effective global/workspace scope so a workspace hook takes precedence without double execution. */
export async function planKiroHookScopes(input: {
  readonly home: string;
  readonly kiroHome?: string;
  readonly projectRoot: string;
  readonly deviceHome: string;
  readonly install?: boolean;
  readonly navigation?: "always" | "declined" | null;
  readonly platform?: NodeJS.Platform;
}): Promise<readonly KiroHookFilePlan[]> {
  const kiroHome = resolve(input.kiroHome ?? join(input.home, ".kiro"));
  const projectRoot = resolve(input.projectRoot);
  const globalRequest: KiroHooksRequest = { root: kiroHome, deviceHome: input.deviceHome, userHome: input.home, scope: "user", ...(input.platform === undefined ? {} : { platform: input.platform }), ...(input.install === undefined ? {} : { install: input.install }), ...(input.navigation === undefined ? {} : { navigation: input.navigation }) };
  const projectRequest: KiroHooksRequest = { root: projectRoot, deviceHome: input.deviceHome, userHome: input.home, scope: "project", ...(input.platform === undefined ? {} : { platform: input.platform }), ...(input.install === undefined ? {} : { install: input.install }), ...(input.navigation === undefined ? {} : { navigation: input.navigation }) };
  const globalPath = join(kiroHome, ...KIRO_USER_HOOKS_FILE.split("/"));
  const projectPath = join(projectRoot, ...KIRO_HOOKS_FILE.split("/"));
  const samePath = globalPath === projectPath;
  if (input.install === false) return [await planKiroHooks(globalRequest), ...(samePath ? [] : [await planKiroHooks(projectRequest)])];
  if (samePath) return [await planKiroHooks(globalRequest)];
  const projectCurrent = await planKiroHooks({ ...projectRequest, install: false });
  const projectOwns = (projectCurrent?.removed.length ?? 0) > 0;
  if (projectOwns) return [await planKiroHooks({ ...globalRequest, install: false }), await planKiroHooks(projectRequest)];
  return [await planKiroHooks(globalRequest), await planKiroHooks({ ...projectRequest, install: false })];
}

export async function applyKiroHookPlan(plan: KiroHookFilePlan, input: { readonly at: string; readonly deviceHome: string }): Promise<void> {
  const exists = await regularFile(plan.path);
  const current = exists ? await readFile(plan.path, "utf8") : null;
  if (current !== plan.before) throw new KiroHostError("KIRO_HOOKS_CONCURRENT_MODIFICATION", `${plan.path} changed after planning`);
  if (!plan.changed) return;
  if (plan.after === null) throw new KiroHostError("KIRO_HOOKS_PLAN_INVALID", "changed Kiro hook plan must retain its output document");
  await ensureDeviceDirectory(dirname(plan.path));
  if (current !== null) {
    const time = input.at.replace(/[-:]/gu, "").replace(/T/u, "T");
    const backup = join(backupsPath(input.deviceHome), time, "host-hooks", "kiro", plan.scope, ...hooksRelativePath(plan.scope).split("/"));
    await ensureDeviceDirectory(dirname(backup));
    try { await lstat(backup); throw new KiroHostError("KIRO_HOOKS_BACKUP_EXISTS", `${backup} already exists`); }
    catch (error) { if (error instanceof KiroHostError) throw error; if (String((error as NodeJS.ErrnoException).code) !== "ENOENT") throw error; }
    await writeFileAtomic(backup, current);
  }
  await writeFileAtomic(plan.path, plan.after);
}

export async function inspectKiroHookScope(root: string, scope: "user" | "project" = "project"): Promise<{ readonly path: string; readonly count: number; readonly error: string | null }> {
  const path = join(resolve(root), ...hooksRelativePath(scope).split("/"));
  try {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try { stats = await lstat(path); }
    catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (code === "ENOENT") return { path, count: 0, error: null };
      if (code === "ENOTDIR") return { path, count: 0, error: `${path} is not in a directory path` };
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return { path, count: 0, error: `${path} is not a regular file` };
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObject(value) || value.version !== KIRO_HOOKS_VERSION || !Array.isArray(value.hooks)) return { path, count: 0, error: "standalone hooks document is not a v1 array" };
    const count = value.hooks.filter(entry => isObject(entry) && typeof entry.name === "string" && KIRO_OWNED_HOOK_NAMES.has(entry.name) && isEinzbernHookCommand(actionCommand(entry) ?? "")).length;
    return { path, count, error: null };
  } catch (error) { return { path, count: 0, error: String((error as Error).message ?? error) }; }
}

export function kiroSkillCopyPath(home: string, kiroHome?: string): string {
  const base = resolve(kiroHome ?? join(home, ".kiro"));
  return join(base, "skills");
}

/** A configuration directory is evidence that the user selected this Kiro surface; binary presence alone is not. */
export function kiroSelectionStatus(input: { readonly home: string; readonly projectRoot?: string; readonly kiroHome?: string }): "selected" | "not-selected" | "unknown" {
  const roots = [resolve(input.kiroHome ?? process.env.KIRO_HOME ?? join(input.home, ".kiro")), ...(input.projectRoot === undefined ? [] : [join(resolve(input.projectRoot), ".kiro")])];
  let unknown = false;
  for (const root of roots) {
    try {
      const stats = fsModule.lstatSync(root);
      if (stats.isSymbolicLink()) { unknown = true; continue; }
      if (stats.isDirectory()) return "selected";
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) unknown = true;
    }
  }
  return unknown ? "unknown" : "not-selected";
}
