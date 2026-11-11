// SPDX-License-Identifier: Apache-2.0

// Antigravity's CLI, IDE and App are separate surfaces sharing customization contracts.
// CLI version discovery proves neither which surface a later session selected nor which model
// that session actually used. Antigravity hooks live in a top-level named-group JSON map
// (user: ${ANTIGRAVITY_CONFIG_DIR:-~/.gemini/config}/hooks.json, project: .agents/hooks.json)
// and are managed solely under the owned "einzbern" group key so unrelated hook groups remain intact.

import { spawnSync } from "node:child_process";
import * as fsModule from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { writeFileAtomic } from "./atomic-file.js";
import { backupsPath, ensureDeviceDirectory } from "./device-home.js";
import { hookLauncherPath, hostHookCommand, isEinzbernHookCommand } from "./host-hooks.js";

export const ANTIGRAVITY_HOOKS_FILE = ".agents/hooks.json" as const;
export const ANTIGRAVITY_USER_HOOKS_FILE = "hooks.json" as const;
export const ANTIGRAVITY_CONFIG_DIR_REL = ".gemini/config" as const;
export const ANTIGRAVITY_SKILL_ROOT = ".gemini/config/skills" as const;
export const ANTIGRAVITY_OWNED_HOOK_GROUP = "einzbern" as const;
export const ANTIGRAVITY_READ_MATCHER = "read_file|view_file" as const;
export const ANTIGRAVITY_HOOK_TIMEOUT = 30;
export const ANTIGRAVITY_HOOKS_SCHEMA_VERSION = "tcrn.antigravity-hooks-plan.v1" as const;

export type AntigravitySurfaceStatus = "available" | "not-detected" | "unavailable" | "unknown";
export type AntigravityHookScope = "user" | "project";
export type AntigravityHookEvent = "SessionStart" | "PreInvocation" | "PreToolUse";
export type AntigravityMappedHookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse";

export interface AntigravityHostIdentity {
  readonly schemaVersion: "tcrn.antigravity-host-identity.v1";
  readonly observedAt: string;
  readonly cli: {
    readonly status: AntigravitySurfaceStatus;
    readonly executable: string | null;
    readonly version: string | null;
    readonly versionEvidence: string | null;
  };
  readonly surfaces: {
    readonly configDir: boolean;
    readonly cliDataDir: boolean;
    readonly ideDataDir: boolean;
    readonly appDataDir: boolean;
  };
  readonly selected: "unknown";
  readonly actualModel: { readonly status: "unknown"; readonly reason: string };
}

export interface AntigravityCommandHandler {
  readonly type: "command";
  readonly command: string;
  readonly timeout: number;
}

export interface AntigravityMatcherGroup {
  readonly matcher: string;
  readonly hooks: readonly AntigravityCommandHandler[];
}

export interface AntigravityOwnedHookSpec {
  readonly SessionStart?: readonly AntigravityCommandHandler[];
  readonly PreInvocation: readonly AntigravityCommandHandler[];
  readonly PreToolUse: readonly AntigravityMatcherGroup[];
}

export interface AntigravityHooksRequest {
  readonly root: string;
  readonly deviceHome: string;
  readonly userHome?: string;
  readonly scope: AntigravityHookScope;
  readonly install?: boolean;
  readonly navigation?: "always" | "declined" | null;
  readonly platform?: NodeJS.Platform;
}

export interface AntigravityHookFilePlan {
  readonly schemaVersion: typeof ANTIGRAVITY_HOOKS_SCHEMA_VERSION;
  readonly scope: AntigravityHookScope;
  readonly root: string;
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
  readonly removed: readonly string[];
  readonly ownedEvents: readonly AntigravityHookEvent[];
  readonly preservedGroupCount: number;
}

export class AntigravityHostError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "AntigravityHostError";
    this.reasonCode = reasonCode;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown): unknown => (isObject(child)
    ? Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]))
    : child));
}

function parseSemver(text: string): string | null {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(text);
  return match?.[1] ?? null;
}

function directoryExistsSync(path: string): boolean {
  try {
    const stats = fsModule.lstatSync(path);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

function regularFileExistsSync(path: string): boolean {
  try {
    const stats = fsModule.lstatSync(path);
    return !stats.isSymbolicLink() && stats.isFile();
  } catch {
    return false;
  }
}

export function antigravityConfigRoot(input: { readonly home: string; readonly antigravityConfigHome?: string }): string {
  return resolve(input.antigravityConfigHome ?? join(input.home, ...ANTIGRAVITY_CONFIG_DIR_REL.split("/")));
}

export function antigravitySkillCopyPath(home: string, antigravityConfigHome?: string): string {
  return join(antigravityConfigRoot({ home, ...(antigravityConfigHome === undefined ? {} : { antigravityConfigHome }) }), "skills");
}

export function probeAntigravityHost(
  input: {
    readonly home?: string;
    readonly executable?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly observedAt?: string;
    readonly timeoutMs?: number;
  } = {},
): AntigravityHostIdentity {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const probeHome = input.home !== undefined
    ? resolve(input.home)
    : input.env?.PATH === undefined
      ? homedir()
      : null;
  const surfaces = probeHome === null
    ? { configDir: false, cliDataDir: false, ideDataDir: false, appDataDir: false }
    : {
        configDir: directoryExistsSync(join(probeHome, ".gemini", "config")),
        cliDataDir: directoryExistsSync(join(probeHome, ".gemini", "antigravity-cli")),
        ideDataDir: directoryExistsSync(join(probeHome, ".gemini", "antigravity-ide")),
        appDataDir: directoryExistsSync(join(probeHome, ".gemini", "antigravity")),
      };
  const timeout = input.timeoutMs ?? 2_000;
  let candidate = input.executable ?? "agy";
  let run = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  });
  const firstCode = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (input.executable === undefined && input.env?.PATH === undefined && firstCode === "ENOENT" && probeHome !== null) {
    const localBin = join(probeHome, ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
    if (regularFileExistsSync(localBin)) {
      candidate = localBin;
      run = spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        env: input.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        windowsHide: true,
      });
    }
  }
  let cli: AntigravityHostIdentity["cli"];
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code;
    cli = {
      status: code === "ENOENT" ? "not-detected" : "unavailable",
      executable: code === "ENOENT" ? null : candidate,
      version: null,
      versionEvidence: run.error.message,
    };
  } else {
    const evidence = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
    const version = parseSemver(evidence);
    cli = {
      status: run.status === 0 && version !== null ? "available" : "unavailable",
      executable: candidate,
      version: run.status === 0 ? version : null,
      versionEvidence: evidence || `exit:${String(run.status)}`,
    };
  }
  return {
    schemaVersion: "tcrn.antigravity-host-identity.v1",
    observedAt,
    cli,
    surfaces,
    selected: "unknown",
    actualModel: { status: "unknown", reason: "host probe does not observe active session model" },
  };
}

export function antigravityHookEventName(raw: string): AntigravityMappedHookEvent | null {
  if (raw === "SessionStart" || raw === "session-start") return "SessionStart";
  if (raw === "PreInvocation" || raw === "UserPromptSubmit" || raw === "user-prompt-submit") return "UserPromptSubmit";
  if (raw === "PreToolUse" || raw === "pre-tool-use") return "PreToolUse";
  return null;
}

function expectedEvents(navigation: "always" | "declined" | null | undefined): readonly AntigravityHookEvent[] {
  return navigation === "declined" ? ["SessionStart", "PreInvocation", "PreToolUse"] : ["PreInvocation", "PreToolUse"];
}

function wantedAntigravityGroup(request: AntigravityHooksRequest): AntigravityOwnedHookSpec | null {
  if (request.install === false) return null;
  const launcher = hookLauncherPath(request.deviceHome, request.platform);
  const preInvocation: readonly AntigravityCommandHandler[] = [
    {
      type: "command",
      command: hostHookCommand(launcher, "UserPromptSubmit", request.userHome, request.platform, "antigravity"),
      timeout: ANTIGRAVITY_HOOK_TIMEOUT,
    },
  ];
  const preToolUse: readonly AntigravityMatcherGroup[] = [
    {
      matcher: ANTIGRAVITY_READ_MATCHER,
      hooks: [
        {
          type: "command",
          command: hostHookCommand(launcher, "PreToolUse", request.userHome, request.platform, "antigravity"),
          timeout: ANTIGRAVITY_HOOK_TIMEOUT,
        },
      ],
    },
  ];
  if (request.navigation === "declined") {
    return {
      SessionStart: [
        {
          type: "command",
          command: hostHookCommand(launcher, "SessionStart", request.userHome, request.platform, "antigravity"),
          timeout: ANTIGRAVITY_HOOK_TIMEOUT,
        },
      ],
      PreInvocation: preInvocation,
      PreToolUse: preToolUse,
    };
  }
  return { PreInvocation: preInvocation, PreToolUse: preToolUse };
}

function isOwnedFlatEventHandlers(value: unknown, expectedWord: "session-start" | "user-prompt-submit"): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const entry = value[0];
  if (!isObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !keys.every((key) => key === "type" || key === "command" || key === "timeout")) return false;
  return (
    entry.type === "command" &&
    typeof entry.command === "string" &&
    isEinzbernHookCommand(entry.command) &&
    entry.command.endsWith(` ${expectedWord}`) &&
    entry.timeout === ANTIGRAVITY_HOOK_TIMEOUT
  );
}

function isOwnedPreToolUseGroups(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const group = value[0];
  if (!isObject(group)) return false;
  const keys = Object.keys(group);
  if (keys.length !== 2 || !keys.every((key) => key === "matcher" || key === "hooks")) return false;
  if (group.matcher !== ANTIGRAVITY_READ_MATCHER) return false;
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
  const handler = group.hooks[0];
  if (!isObject(handler)) return false;
  const handlerKeys = Object.keys(handler);
  if (handlerKeys.length !== 3 || !handlerKeys.every((key) => key === "type" || key === "command" || key === "timeout")) return false;
  return (
    handler.type === "command" &&
    typeof handler.command === "string" &&
    isEinzbernHookCommand(handler.command) &&
    handler.command.endsWith(" pre-tool-use") &&
    handler.timeout === ANTIGRAVITY_HOOK_TIMEOUT
  );
}

export function isOwnedAntigravityHookGroup(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (key === "SessionStart") {
      if (!isOwnedFlatEventHandlers(value.SessionStart, "session-start")) return false;
    } else if (key === "PreInvocation") {
      if (!isOwnedFlatEventHandlers(value.PreInvocation, "user-prompt-submit")) return false;
    } else if (key === "PreToolUse") {
      if (!isOwnedPreToolUseGroups(value.PreToolUse)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function hooksRelativePath(scope: AntigravityHookScope): string {
  return scope === "user" ? ANTIGRAVITY_USER_HOOKS_FILE : ANTIGRAVITY_HOOKS_FILE;
}

/** Merge only the named "einzbern" hook group; all unrelated named hook groups remain in order. */
export function mergeAntigravityHookDocument(
  existingValue: unknown,
  request: AntigravityHooksRequest,
): {
  readonly document: Record<string, unknown>;
  readonly removed: readonly string[];
  readonly ownedEvents: readonly AntigravityHookEvent[];
  readonly preservedGroupCount: number;
} {
  if (existingValue !== null && existingValue !== undefined && !isObject(existingValue)) {
    throw new AntigravityHostError("ANTIGRAVITY_HOOKS_FILE_UNSUPPORTED", "Antigravity hooks document must be an object");
  }
  const source = isObject(existingValue) ? existingValue : {};
  const hadOwned = ANTIGRAVITY_OWNED_HOOK_GROUP in source;
  if (hadOwned && !isOwnedAntigravityHookGroup(source[ANTIGRAVITY_OWNED_HOOK_GROUP])) {
    throw new AntigravityHostError(
      "ANTIGRAVITY_HOOKS_OWNERSHIP_CONFLICT",
      `managed hook group ${ANTIGRAVITY_OWNED_HOOK_GROUP} was edited; preserve it for review`,
    );
  }
  const wanted = wantedAntigravityGroup(request);
  const next: Record<string, unknown> = {};
  let preservedGroupCount = 0;
  let inserted = false;
  for (const [groupName, spec] of Object.entries(source)) {
    if (groupName === ANTIGRAVITY_OWNED_HOOK_GROUP) {
      if (wanted !== null) {
        next[ANTIGRAVITY_OWNED_HOOK_GROUP] = wanted;
        inserted = true;
      }
      continue;
    }
    next[groupName] = spec;
    preservedGroupCount += 1;
  }
  if (wanted !== null && !inserted) {
    next[ANTIGRAVITY_OWNED_HOOK_GROUP] = wanted;
  }
  return {
    document: next,
    removed: hadOwned ? [ANTIGRAVITY_OWNED_HOOK_GROUP] : [],
    ownedEvents: wanted === null ? [] : expectedEvents(request.navigation),
    preservedGroupCount,
  };
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) return false;
    throw error;
  }
}

/** Read and plan one Antigravity hooks.json file. Reads never follow a symbolic link. */
export async function planAntigravityHooks(request: AntigravityHooksRequest): Promise<AntigravityHookFilePlan> {
  const root = resolve(request.root);
  const path = join(root, ...hooksRelativePath(request.scope).split("/"));
  let before: string | null = null;
  if (await regularFile(path)) {
    before = await readFile(path, "utf8");
  } else {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || stats.isDirectory()) {
        throw new AntigravityHostError("ANTIGRAVITY_HOOKS_PATH_UNSUPPORTED", `${path} is not a regular file`);
      }
    } catch (error) {
      if (error instanceof AntigravityHostError) throw error;
      if (!["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
  }
  if (request.install === false && before === null) {
    return {
      schemaVersion: ANTIGRAVITY_HOOKS_SCHEMA_VERSION,
      scope: request.scope,
      root,
      path,
      before: null,
      after: null,
      changed: false,
      removed: [],
      ownedEvents: [],
      preservedGroupCount: 0,
    };
  }
  let existing: unknown = null;
  if (before !== null) {
    try {
      existing = JSON.parse(before) as unknown;
    } catch {
      throw new AntigravityHostError("ANTIGRAVITY_HOOKS_FILE_UNSUPPORTED", `${path} is not JSON`);
    }
    if (!isObject(existing)) {
      throw new AntigravityHostError("ANTIGRAVITY_HOOKS_FILE_UNSUPPORTED", `${path} is not a Hooks object`);
    }
  }
  const merged = mergeAntigravityHookDocument(existing, request);
  const rendered = `${JSON.stringify(merged.document, null, 2)}\n`;
  const same = before !== null && stable(JSON.parse(before)) === stable(merged.document);
  const after = same ? before! : rendered;
  return {
    schemaVersion: ANTIGRAVITY_HOOKS_SCHEMA_VERSION,
    scope: request.scope,
    root,
    path,
    before,
    after,
    changed: before !== after,
    removed: merged.removed,
    ownedEvents: merged.ownedEvents,
    preservedGroupCount: merged.preservedGroupCount,
  };
}

/** Plan effective global/workspace scope so a workspace hook takes precedence without double execution. */
export async function planAntigravityHookScopes(input: {
  readonly home: string;
  readonly antigravityConfigHome?: string;
  readonly projectRoot: string;
  readonly deviceHome: string;
  readonly install?: boolean;
  readonly navigation?: "always" | "declined" | null;
  readonly platform?: NodeJS.Platform;
}): Promise<readonly AntigravityHookFilePlan[]> {
  const configHome = antigravityConfigRoot({
    home: input.home,
    ...(input.antigravityConfigHome === undefined ? {} : { antigravityConfigHome: input.antigravityConfigHome }),
  });
  const projectRoot = resolve(input.projectRoot);
  const globalRequest: AntigravityHooksRequest = {
    root: configHome,
    deviceHome: input.deviceHome,
    userHome: input.home,
    scope: "user",
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.install === undefined ? {} : { install: input.install }),
    ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
  };
  const projectRequest: AntigravityHooksRequest = {
    root: projectRoot,
    deviceHome: input.deviceHome,
    userHome: input.home,
    scope: "project",
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.install === undefined ? {} : { install: input.install }),
    ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
  };
  const globalPath = join(configHome, ...ANTIGRAVITY_USER_HOOKS_FILE.split("/"));
  const projectPath = join(projectRoot, ...ANTIGRAVITY_HOOKS_FILE.split("/"));
  const samePath = globalPath === projectPath;
  if (input.install === false) {
    return [await planAntigravityHooks(globalRequest), ...(samePath ? [] : [await planAntigravityHooks(projectRequest)])];
  }
  if (samePath) return [await planAntigravityHooks(globalRequest)];
  const projectInspection = await inspectAntigravityHookScope(projectRoot, "project");
  const projectOwns = projectInspection.count > 0;
  if (projectOwns) {
    return [await planAntigravityHooks({ ...globalRequest, install: false }), await planAntigravityHooks(projectRequest)];
  }
  return [await planAntigravityHooks(globalRequest), await planAntigravityHooks({ ...projectRequest, install: false })];
}

export async function applyAntigravityHookPlan(
  plan: AntigravityHookFilePlan,
  input: { readonly at: string; readonly deviceHome: string },
): Promise<void> {
  const exists = await regularFile(plan.path);
  const current = exists ? await readFile(plan.path, "utf8") : null;
  if (current !== plan.before) {
    throw new AntigravityHostError("ANTIGRAVITY_HOOKS_CONCURRENT_MODIFICATION", `${plan.path} changed after planning`);
  }
  if (!plan.changed) return;
  if (plan.after === null) {
    throw new AntigravityHostError("ANTIGRAVITY_HOOKS_PLAN_INVALID", "changed Antigravity hook plan must retain its output document");
  }
  await ensureDeviceDirectory(dirname(plan.path));
  if (current !== null) {
    const time = input.at.replace(/[-:]/gu, "").replace(/T/u, "T");
    const backup = join(backupsPath(input.deviceHome), time, "host-hooks", "antigravity", plan.scope, ...hooksRelativePath(plan.scope).split("/"));
    await ensureDeviceDirectory(dirname(backup));
    try {
      await lstat(backup);
      throw new AntigravityHostError("ANTIGRAVITY_HOOKS_BACKUP_EXISTS", `${backup} already exists`);
    } catch (error) {
      if (error instanceof AntigravityHostError) throw error;
      if (String((error as NodeJS.ErrnoException).code) !== "ENOENT") throw error;
    }
    await writeFileAtomic(backup, current);
  }
  await writeFileAtomic(plan.path, plan.after);
}

function countOwnedEventCommands(group: unknown): number {
  if (!isObject(group)) return 0;
  let count = 0;
  for (const key of ["SessionStart", "PreInvocation"] as const) {
    const handlers = group[key];
    if (Array.isArray(handlers)) {
      count += handlers.filter((entry) => isObject(entry) && typeof entry.command === "string" && isEinzbernHookCommand(entry.command)).length;
    }
  }
  if (Array.isArray(group.PreToolUse)) {
    for (const matcherGroup of group.PreToolUse) {
      if (isObject(matcherGroup) && Array.isArray(matcherGroup.hooks)) {
        count += matcherGroup.hooks.filter((entry) => isObject(entry) && typeof entry.command === "string" && isEinzbernHookCommand(entry.command)).length;
      }
    }
  }
  return count;
}

export async function inspectAntigravityHookScope(
  root: string,
  scope: AntigravityHookScope = "project",
): Promise<{ readonly path: string; readonly count: number; readonly error: string | null }> {
  const path = join(resolve(root), ...hooksRelativePath(scope).split("/"));
  try {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(path);
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code);
      if (code === "ENOENT") return { path, count: 0, error: null };
      if (code === "ENOTDIR") return { path, count: 0, error: `${path} is not in a directory path` };
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return { path, count: 0, error: `${path} is not a regular file` };
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObject(value)) return { path, count: 0, error: "Antigravity hooks document is not an object" };
    if (!(ANTIGRAVITY_OWNED_HOOK_GROUP in value)) return { path, count: 0, error: null };
    return { path, count: countOwnedEventCommands(value[ANTIGRAVITY_OWNED_HOOK_GROUP]), error: null };
  } catch (error) {
    return { path, count: 0, error: String((error as Error).message ?? error) };
  }
}

/**
 * Antigravity customization or data directories (or an existing workspace .agents/hooks.json)
 * indicate that the user selected Antigravity on this machine/project. Bare .agents/ alone is not
 * treated as Antigravity selection because Codex skills also use ~/.agents/skills.
 */
export function antigravitySelectionStatus(input: {
  readonly home: string;
  readonly projectRoot?: string;
  readonly antigravityConfigHome?: string;
}): "selected" | "not-selected" | "unknown" {
  const home = resolve(input.home);
  const envConfig = input.antigravityConfigHome ?? process.env.ANTIGRAVITY_CONFIG_DIR;
  const dirRoots = [
    resolve(envConfig ?? join(home, ...ANTIGRAVITY_CONFIG_DIR_REL.split("/"))),
    join(home, ".gemini", "antigravity-cli"),
    join(home, ".gemini", "antigravity-ide"),
    join(home, ".gemini", "antigravity"),
  ];
  let unknown = false;
  for (const root of dirRoots) {
    try {
      const stats = fsModule.lstatSync(root);
      if (stats.isSymbolicLink()) {
        unknown = true;
        continue;
      }
      if (stats.isDirectory()) return "selected";
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) unknown = true;
    }
  }
  if (input.projectRoot !== undefined) {
    const projectHooks = join(resolve(input.projectRoot), ...ANTIGRAVITY_HOOKS_FILE.split("/"));
    try {
      const stats = fsModule.lstatSync(projectHooks);
      if (stats.isSymbolicLink()) unknown = true;
      else if (stats.isFile()) return "selected";
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) unknown = true;
    }
  }
  return unknown ? "unknown" : "not-selected";
}
