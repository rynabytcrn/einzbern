// SPDX-License-Identifier: Apache-2.0

// Antigravity's CLI, IDE and App are separate surfaces sharing customization contracts.
// CLI version discovery proves neither which surface a later session selected nor which model
// that session actually used. Antigravity hooks live in a top-level named-group JSON map
// (user: ${ANTIGRAVITY_CONFIG_DIR:-~/.gemini/config}/hooks.json, project: .agents/hooks.json).
// Einzbern installs its owned "einzbern" group in the user-scope hooks.json and retires redundant
// unedited project-scope "einzbern" groups so multi-project setups share a single active hook
// without duplicate execution while preserving unrelated hook groups and user edits.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsModule from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { writeFileAtomic } from "./atomic-file.js";
import { backupsPath, ensureDeviceDirectory } from "./device-home.js";
import { hookLauncherPath, hostHookCommand, isEinzbernHookCommand } from "./host-hooks.js";
import { readRegistry } from "./registry.js";

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
  readonly details: Readonly<Record<string, string>>;
  constructor(reasonCode: string, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "AntigravityHostError";
    this.reasonCode = reasonCode;
    this.details = details;
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

const ANTIGRAVITY_COMMAND_PREFIX = "node -e \"/*einzbern-hook*/const p=require('node:path');const d=p.resolve(process.env.EINZBERN_HOME||p.resolve(require('node:os').homedir(),'";

function isCanonicalAntigravityHookCommand(
  command: string,
  expectedWord: "session-start" | "user-prompt-submit" | "pre-tool-use",
  platform: NodeJS.Platform = process.platform,
): boolean {
  const emptyWrite = expectedWord === "pre-tool-use"
    ? "process.stdout.write(JSON.stringify({decision:'allow'})+'\\n')"
    : "process.stdout.write('{}\\n')";
  const suffix = `'));process.env.EINZBERN_HOME=d;process.env.EINZBERN_HOST='antigravity';import(require('node:url').pathToFileURL(p.join(d,'engine/hook.mjs')).href).then(m=>m.launch(process.argv.slice(1),process.env)).then(s=>{if(s)process.stdout.write(s);else ${emptyWrite}}).catch(e=>{process.stderr.write(JSON.stringify({ok:false,reasonCode:e.reasonCode||'HOOK_LAUNCH_FAILED',error:e.message})+'\\n');${emptyWrite}})" ${expectedWord}`;
  if (command.length <= ANTIGRAVITY_COMMAND_PREFIX.length + suffix.length) return false;
  if (!command.startsWith(ANTIGRAVITY_COMMAND_PREFIX) || !command.endsWith(suffix)) return false;
  const escapedLiteral = command.slice(ANTIGRAVITY_COMMAND_PREFIX.length, command.length - suffix.length);
  const rawDevice = escapedLiteral.replaceAll("\\'", "'");
  if (rawDevice.length === 0 || rawDevice.startsWith("/") || /^[A-Za-z]:/u.test(rawDevice)) return false;
  if (/[\u0000-\u001f\u007f\\"$`]/u.test(rawDevice)) return false;
  if (platform === "win32" && rawDevice.includes("%")) return false;
  return rawDevice.replaceAll("'", "\\'") === escapedLiteral;
}

function isOwnedFlatEventHandlers(
  value: unknown,
  expectedWord: "session-start" | "user-prompt-submit",
  platform: NodeJS.Platform,
): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const entry = value[0];
  if (!isObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !keys.every((key) => key === "type" || key === "command" || key === "timeout")) return false;
  return (
    entry.type === "command" &&
    typeof entry.command === "string" &&
    isCanonicalAntigravityHookCommand(entry.command, expectedWord, platform) &&
    entry.timeout === ANTIGRAVITY_HOOK_TIMEOUT
  );
}

function isOwnedPreToolUseGroups(value: unknown, platform: NodeJS.Platform): boolean {
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
    isCanonicalAntigravityHookCommand(handler.command, "pre-tool-use", platform) &&
    handler.timeout === ANTIGRAVITY_HOOK_TIMEOUT
  );
}

export function isOwnedAntigravityHookGroup(value: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !("PreInvocation" in value) || !("PreToolUse" in value)) return false;
  for (const key of keys) {
    if (key === "SessionStart") {
      if (!isOwnedFlatEventHandlers(value.SessionStart, "session-start", platform)) return false;
    } else if (key === "PreInvocation") {
      if (!isOwnedFlatEventHandlers(value.PreInvocation, "user-prompt-submit", platform)) return false;
    } else if (key === "PreToolUse") {
      if (!isOwnedPreToolUseGroups(value.PreToolUse, platform)) return false;
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
  const platform = request.platform ?? process.platform;
  if (hadOwned && !isOwnedAntigravityHookGroup(source[ANTIGRAVITY_OWNED_HOOK_GROUP], platform)) {
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
  let merged: ReturnType<typeof mergeAntigravityHookDocument>;
  try {
    merged = mergeAntigravityHookDocument(existing, request);
  } catch (error) {
    if (error instanceof AntigravityHostError) {
      throw new AntigravityHostError(error.reasonCode, error.message, { ...error.details, path });
    }
    throw error;
  }
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

async function canonicalHookFileKey(root: string, scope: AntigravityHookScope): Promise<string> {
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  const hookPath = join(resolvedRoot, ...hooksRelativePath(scope).split("/"));
  const parent = await realpath(dirname(hookPath)).catch(() => resolve(dirname(hookPath)));
  return join(parent, basename(hookPath));
}

/**
 * Plan effective user/workspace scopes: Einzbern manages its owned "einzbern" group in user scope
 * so all projects on the same home/device share one active hook, and retires any redundant unedited
 * owned "einzbern" group from the current and registered workspace .agents/hooks.json files while
 * preserving unmanaged workspace groups and blocking on user edits.
 */
export async function planAntigravityHookScopes(input: {
  readonly home: string;
  readonly antigravityConfigHome?: string;
  readonly projectRoot: string;
  readonly deviceHome: string;
  readonly install?: boolean;
  readonly navigation?: "always" | "declined" | null;
  readonly platform?: NodeJS.Platform;
  readonly coordinateRegisteredProjects?: boolean;
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
  const globalKey = await canonicalHookFileKey(configHome, "user");
  const candidateRoots = [projectRoot];
  if (input.coordinateRegisteredProjects !== false) {
    const registry = await readRegistry(resolve(input.deviceHome));
    for (const entry of registry.entries) {
      candidateRoots.push(resolve(entry.projectPath));
    }
  }
  const seenKeys = new Set<string>([globalKey]);
  const plans: AntigravityHookFilePlan[] = [await planAntigravityHooks(globalRequest)];
  for (let index = 0; index < candidateRoots.length; index += 1) {
    const candidateRoot = candidateRoots[index]!;
    const key = await canonicalHookFileKey(candidateRoot, "project");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const projectPlan = await planAntigravityHooks({
      root: candidateRoot,
      deviceHome: input.deviceHome,
      userHome: input.home,
      scope: "project",
      install: false,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
      ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
    });
    if (index === 0 || projectPlan.before !== null || projectPlan.changed) {
      plans.push(projectPlan);
    }
  }
  return plans;
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
    const scopeSegment = plan.scope === "user"
      ? ["user"]
      : ["project", createHash("sha256").update(plan.root).digest("hex").slice(0, 16)];
    const backup = join(
      backupsPath(input.deviceHome),
      time,
      "host-hooks",
      "antigravity",
      ...scopeSegment,
      ...hooksRelativePath(plan.scope).split("/"),
    );
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

export async function applyAntigravityHookPlans(
  plans: readonly AntigravityHookFilePlan[],
  input: { readonly at: string; readonly deviceHome: string },
): Promise<void> {
  for (const plan of plans) {
    const exists = await regularFile(plan.path);
    const current = exists ? await readFile(plan.path, "utf8") : null;
    if (current !== plan.before) {
      throw new AntigravityHostError("ANTIGRAVITY_HOOKS_CONCURRENT_MODIFICATION", `${plan.path} changed after planning`);
    }
  }
  for (const plan of plans) {
    await applyAntigravityHookPlan(plan, input);
  }
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
