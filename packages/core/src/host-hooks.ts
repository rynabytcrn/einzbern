// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-477 R1, R3, R4, R5 (MIN-227 D4, D5): the hooks a host runs for Einzbern,
// reduced to one. A host's hook file carries exactly one Einzbern hook group, on
// UserPromptSubmit, and its one command runs the stable hook launcher in the device directory:
//
//   node "<device directory>/engine/hook.mjs" user-prompt-submit
//
// The launcher's path is absolute and double-quoted and nothing else is on the line: no shell
// condition wraps it, and no argument names a checkout, a container or a host. So the same line
// runs under a POSIX shell and on Windows, where it is written with backslashes (R5), and a path
// that a shell would still read inside the quotes is refused rather than written wrong. Whether
// the prompt's directory has a library, and what to inject, is the launcher's business (R2); its
// bytes do not change when the engine does (engine/current), so a host file written once stays
// current across engine updates.
//
// Rendering a file keeps everything that is not Einzbern's: other tools' hook groups, in their
// order, and every other key. What is Einzbern's is taken out and written again: every hook that
// runs the launcher, and every hook of the old platform harness (named by its script in names.ts,
// whichever directory it ran from); in Claude Code's settings also the permissions.deny rules that
// fenced the old directories, and the old inert-adapter key (R3, R4). Codex keeps two more things
// of ours in the user's config.toml: the hooks feature switch, which is turned on while a hook is
// installed, and one trust state per hook its user approved. A trust state whose hook is gone or
// changed is removed with it; every other byte of that file stays.
//
// Nothing is written until applyHostHooks, and then only a file whose content changes: its
// original is first copied into the device directory (backups/<UTC second>/host-hooks/), and the
// file is replaced atomically. A file that changed after it was read, or one that is not a regular
// file of JSON or TOML this module can follow, is refused before anything is written, and
// rendering the same hooks twice writes nothing the second time.

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

import { writeFileAtomic } from "./atomic-file.js";
import { DEVICE_HOME_ENTRIES, ENGINE_HOOK_LAUNCHER, backupsPath } from "./device-home.js";
import {
  ARRAY_TABLE_HEADER,
  HostWritableRootsError,
  KEY_ASSIGNMENT,
  TABLE_HEADER,
  keySegments,
  statementLines,
  utcStamp,
} from "./host-writable-roots.js";
import { LEGACY_CONTAINER_DIRECTORY, LEGACY_DEVICE_DIRECTORY, LEGACY_HOOK_SCRIPTS, LEGACY_INERT_SETTINGS_KEY } from "./names.js";

export const HOST_HOOKS_REASON_CODES = Object.freeze([
  "HOST_HOOKS_CONCURRENT_MODIFICATION",
  "HOST_HOOKS_FILE_UNSUPPORTED",
  "HOST_HOOKS_INPUT_INVALID",
  "HOST_HOOKS_PATH_UNSUPPORTED",
] as const);
export type HostHooksReasonCode = typeof HOST_HOOKS_REASON_CODES[number];

export class HostHooksError extends Error {
  readonly reasonCode: HostHooksReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: HostHooksReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "HostHooksError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: HostHooksReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new HostHooksError(reasonCode, message, details);
}

function unsupported(file: string, reason: string): never {
  return fail("HOST_HOOKS_FILE_UNSUPPORTED", `${file}: ${reason}`, { file });
}

export type HostHookHost = "claude-code" | "codex";
export const HOST_HOOK_HOSTS: readonly HostHookHost[] = Object.freeze(["claude-code", "codex"]);
export type HostHookScope = "user" | "project";
export const HOST_HOOK_SCOPES: readonly HostHookScope[] = Object.freeze(["user", "project"]);

// Each event Einzbern hooks, with the word the launcher is given for it (R1). There is one:
// SessionStart, PostToolUse, PreToolUse, Stop, SubagentStart and SubagentStop carry no hook (R3).
export const HOST_HOOK_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  UserPromptSubmit: "user-prompt-submit",
});
// The stable launcher, in engine/ of the device directory; installed from
// scripts/einzbern-hook-launcher.mjs. Its name has one source, device-home.ts.
export const HOST_HOOK_LAUNCHER = ENGINE_HOOK_LAUNCHER;
export const HOST_HOOK_TIMEOUT_SECONDS = 30 as const;
// Where each host keeps its hooks, relative to the scope's root: the user's home or the project.
export const HOST_HOOK_FILES: Readonly<Record<HostHookHost, string>> = Object.freeze({
  "claude-code": ".claude/settings.json",
  codex: ".codex/hooks.json",
});
// Codex's own settings, relative to the user's home whichever scope its hooks are in: the hooks
// feature switch and the trust state of every hook its user approved are kept there.
export const CODEX_CONFIG_FILE = ".codex/config.toml" as const;

export interface HostHook {
  readonly type: "command";
  readonly command: string;
  readonly timeout: number;
}

export interface HostHookGroup {
  readonly hooks: readonly HostHook[];
}

export interface HostHooksRequest {
  readonly host: HostHookHost;
  readonly scope: HostHookScope;
  // The device directory the command names: an absolute path in the form of `platform`.
  readonly deviceHome: string;
  // The operating system the command is written for; this machine's when left out (R5).
  readonly platform?: NodeJS.Platform;
  // false: no Einzbern hook in this file, only what is ours taken out of it (a container's
  // settings once the hook lives in the user's). true when left out.
  readonly install?: boolean;
}

export interface HostHooksExpectation {
  readonly host: HostHookHost;
  readonly scope: HostHookScope;
  readonly platform: NodeJS.Platform;
  readonly deviceHome: string;
  readonly install: boolean;
  // The launcher the command runs; the hook file and Codex's config file, relative to their roots.
  readonly launcher: string;
  readonly hooksFile: string;
  readonly configFile: string | null;
  // Event → the Einzbern hook groups the file must carry: one UserPromptSubmit group, or none.
  readonly groups: Readonly<Record<string, readonly HostHookGroup[]>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A JSON value's text with object keys sorted, so that two values compare by content.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, child: unknown): unknown => (isObject(child)
    ? Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]))
    : child));
}

// ---- The command (R1, R5) ----

// What a POSIX shell or cmd.exe still reads inside double quotes. A launcher path holding one of
// these cannot be written as one literal word, so it is refused rather than written wrong.
function unquotable(path: string, platform: NodeJS.Platform): string | null {
  if (/[\u0000-\u001f\u007f]/u.test(path)) return "a control character";
  if (path.includes("\"")) return "a double quote";
  if (path.includes("$") || path.includes("`")) return "a dollar sign or a backquote";
  if (platform !== "win32") return path.includes("\\") ? "a backslash" : null;
  if (path.includes("%")) return "a percent sign";
  // A POSIX shell, which a Windows host may run its hooks under, reads a doubled backslash inside
  // double quotes as one, and a network path begins with two.
  return path.startsWith("\\\\") ? "a network path" : null;
}

/** The launcher the hook command runs, in the device directory, written for `platform` (R5). */
export function hookLauncherPath(deviceHome: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  if (typeof deviceHome !== "string" || deviceHome.length === 0 || !paths.isAbsolute(deviceHome)) {
    fail("HOST_HOOKS_PATH_UNSUPPORTED", `the device directory must be an absolute ${platform} path`, { deviceHome: String(deviceHome) });
  }
  const launcher = paths.join(deviceHome, DEVICE_HOME_ENTRIES.engine, HOST_HOOK_LAUNCHER);
  const reason = unquotable(launcher, platform);
  if (reason !== null) fail("HOST_HOOKS_PATH_UNSUPPORTED", `${launcher} holds ${reason}, which a shell would read inside the quotes`, { launcher });
  return launcher;
}

/** The one line a host runs for `event`: node, the quoted launcher, and the event's word (R1). */
export function hostHookCommand(launcher: string, event: string): string {
  const word = HOST_HOOK_EVENTS[event];
  if (word === undefined) fail("HOST_HOOKS_INPUT_INVALID", `${event} is not an event Einzbern hooks`, { event });
  return `node "${launcher}" ${word}`;
}

/** What a host's hook file must carry for Einzbern. Reads and writes nothing. */
export function planHostHooks(request: HostHooksRequest): HostHooksExpectation {
  if (!HOST_HOOK_HOSTS.includes(request.host)) {
    fail("HOST_HOOKS_INPUT_INVALID", `host must be one of ${HOST_HOOK_HOSTS.join(", ")}`, { host: String(request.host) });
  }
  if (!HOST_HOOK_SCOPES.includes(request.scope)) {
    fail("HOST_HOOKS_INPUT_INVALID", `scope must be one of ${HOST_HOOK_SCOPES.join(", ")}`, { scope: String(request.scope) });
  }
  const platform = request.platform ?? process.platform;
  const install = request.install ?? true;
  const launcher = hookLauncherPath(request.deviceHome, platform);
  const groups: Record<string, readonly HostHookGroup[]> = {};
  if (install) {
    for (const event of Object.keys(HOST_HOOK_EVENTS)) {
      groups[event] = [{ hooks: [{ type: "command", command: hostHookCommand(launcher, event), timeout: HOST_HOOK_TIMEOUT_SECONDS }] }];
    }
  }
  return {
    host: request.host,
    scope: request.scope,
    platform,
    deviceHome: request.deviceHome,
    install,
    launcher,
    hooksFile: HOST_HOOK_FILES[request.host],
    configFile: request.host === "codex" ? CODEX_CONFIG_FILE : null,
    groups: Object.freeze(groups),
  };
}

// ---- What is ours ----

// `node "<…>/engine/hook.mjs" <event word>`, whichever device directory and platform wrote it.
const LAUNCHER_COMMAND = /^node "([^"]+)" ([a-z]+(?:-[a-z]+)*)$/u;

/** Whether a hook command runs Einzbern's launcher. */
export function isEinzbernHookCommand(command: string): boolean {
  const match = LAUNCHER_COMMAND.exec(command.trim());
  if (match === null) return false;
  const segments = (match[1] ?? "").split(/[\\/]/u);
  return segments.at(-1) === HOST_HOOK_LAUNCHER && segments.at(-2) === DEVICE_HOME_ENTRIES.engine;
}

const SCRIPT_BEFORE = /[\s"'=/]/u;
const SCRIPT_AFTER = /[\s"';]/u;

/** Whether a hook command runs a script of the old platform harness (names.ts), from any directory. */
export function isLegacyHookCommand(command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  return LEGACY_HOOK_SCRIPTS.some((script) => {
    for (let index = normalized.indexOf(script); index !== -1; index = normalized.indexOf(script, index + 1)) {
      const before = normalized[index - 1];
      const after = normalized[index + script.length];
      if ((before === undefined || SCRIPT_BEFORE.test(before)) && (after === undefined || SCRIPT_AFTER.test(after))) return true;
    }
    return false;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const LEGACY_DENY_RULE = new RegExp(
  String.raw`(?:^|[\\/(])(?:${[LEGACY_CONTAINER_DIRECTORY, LEGACY_DEVICE_DIRECTORY].map(escapeRegExp).join("|")})(?:[\\/)*]|$)`,
  "u",
);

/** Whether a permissions.deny rule fences a directory of the old layout (names.ts) (R4). */
export function isLegacyDenyRule(rule: string): boolean {
  return LEGACY_DENY_RULE.test(rule);
}

function commandOf(hook: unknown): string | null {
  return isObject(hook) && typeof hook.command === "string" ? hook.command : null;
}

function isOurs(hook: unknown): boolean {
  const command = commandOf(hook);
  return command !== null && (isEinzbernHookCommand(command) || isLegacyHookCommand(command));
}

// ---- Merging a hook document (pure) ----

export interface RemovedHook {
  readonly event: string;
  readonly command: string;
}

export interface HostHooksMerge {
  // The whole document with Einzbern's part written again; the input is not modified.
  readonly document: Record<string, unknown>;
  // What of ours came out: old or surplus hooks, old deny rules, the old inert key. A hook that is
  // written back exactly as it was is not listed.
  readonly removedHooks: readonly RemovedHook[];
  readonly removedDenyRules: readonly string[];
  readonly removedKeys: readonly string[];
}

// One event's groups with ours taken out and the wanted groups put where the first of ours was
// (at the end when there was none), so that rendering again leaves the list as it is. null when
// the event holds nothing of ours and nothing is wanted in it.
function mergeEvent(event: string, groups: readonly unknown[], wanted: readonly HostHookGroup[], removed: RemovedHook[]): unknown[] | null {
  const kept: unknown[] = [];
  const ours: unknown[] = [];
  let insertAt: number | null = null;
  for (const group of groups) {
    const hooks: readonly unknown[] | null = isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
    if (!isObject(group) || hooks === null || !hooks.some(isOurs)) {
      kept.push(group);
      continue;
    }
    insertAt ??= kept.length;
    ours.push(...hooks.filter(isOurs));
    // Another tool's hook sharing the group stays, and so does the group around it.
    const rest = hooks.filter((hook) => !isOurs(hook));
    if (rest.length > 0) kept.push({ ...group, hooks: rest });
  }
  if (ours.length === 0 && wanted.length === 0) return null;
  const pending = wanted.flatMap((group) => group.hooks.map((hook) => stableJson(hook)));
  for (const hook of ours) {
    const index = pending.indexOf(stableJson(hook));
    if (index === -1) removed.push({ event, command: commandOf(hook) ?? "" });
    else pending.splice(index, 1);
  }
  const at = insertAt ?? kept.length;
  return [...kept.slice(0, at), ...wanted.map((group) => structuredClone(group)), ...kept.slice(at)];
}

/** A host's hook document with only Einzbern's part changed (R1, R3, R4). Reads and writes nothing. */
export function mergeHostHooks(existing: unknown, expected: HostHooksExpectation): HostHooksMerge {
  const file = expected.hooksFile;
  if (existing !== null && existing !== undefined && !isObject(existing)) unsupported(file, "not a JSON object");
  const document: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
  if (document.hooks !== undefined && !isObject(document.hooks)) unsupported(file, "hooks is not an object");
  const hooks: Record<string, unknown> = isObject(document.hooks) ? { ...document.hooks } : {};
  const removedHooks: RemovedHook[] = [];
  let touched = false;
  const events = [...Object.keys(hooks), ...Object.keys(expected.groups).filter((event) => !Object.hasOwn(hooks, event))];
  for (const event of events) {
    const current = hooks[event];
    const wanted = expected.groups[event] ?? [];
    if (current !== undefined && !Array.isArray(current)) {
      if (wanted.length > 0) unsupported(file, `hooks.${event} is not a list`);
      continue;
    }
    const next = mergeEvent(event, current ?? [], wanted, removedHooks);
    if (next === null) continue;
    touched = true;
    // An event left with nothing but ours goes with it; the hooks object itself stays, if empty.
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  }
  if (touched) document.hooks = hooks;
  const removedDenyRules: string[] = [];
  if (expected.host === "claude-code" && document.permissions !== undefined) {
    const permissions = document.permissions;
    if (!isObject(permissions)) unsupported(file, "permissions is not an object");
    const deny = permissions.deny;
    if (deny !== undefined && !Array.isArray(deny)) unsupported(file, "permissions.deny is not a list");
    if (Array.isArray(deny)) {
      const keep = deny.filter((rule) => typeof rule !== "string" || !isLegacyDenyRule(rule));
      if (keep.length < deny.length) {
        removedDenyRules.push(...deny.filter((rule): rule is string => typeof rule === "string" && isLegacyDenyRule(rule)));
        document.permissions = { ...permissions, deny: keep };
      }
    }
  }
  const removedKeys: string[] = [];
  if (Object.hasOwn(document, LEGACY_INERT_SETTINGS_KEY)) {
    delete document[LEGACY_INERT_SETTINGS_KEY];
    removedKeys.push(LEGACY_INERT_SETTINGS_KEY);
  }
  return { document, removedHooks, removedDenyRules, removedKeys };
}

// ---- Codex's config.toml (pure) ----
//
// Codex turns hooks on with `hooks = true` in its [features] table, and remembers each hook its
// user approved as a table [hooks.state."<hooks file>:<event>:<group>:<hook>"] holding the hook's
// trusted hash. The file is edited line by line, like the writable roots are (host-writable-roots.ts),
// so its comments, order and layout stay.

export interface CodexTrustChange {
  // The hooks file as Codex names it in a trust state: its absolute path.
  readonly hooksPath: string;
  // The hooks document before and after rendering; null where there is no file.
  readonly before: unknown;
  readonly after: unknown;
  // Whether an Einzbern hook is installed, so that the hooks switch has to be on.
  readonly enableHooks: boolean;
}

export interface CodexConfigEdit {
  readonly text: string;
  readonly removedTrustStates: readonly string[];
  // Whether this edit turned the hooks switch on.
  readonly hooksEnabled: boolean;
}

const FEATURES_TABLE = "features";
const HOOKS_SWITCH = "hooks";
const SWITCH_VALUE = /^(\s*[^=]+?\s*=\s*)(true|false)(\s*(?:#.*)?)$/u;
// [hooks.state."<key>"]: the table path of one trust state, before its key.
const TRUST_TABLE: readonly string[] = Object.freeze(["hooks", "state"]);

function toml<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HostWritableRootsError) fail("HOST_HOOKS_FILE_UNSUPPORTED", error.message, { file: CODEX_CONFIG_FILE });
    throw error;
  }
}

// "UserPromptSubmit" → "user_prompt_submit": the event as a trust state spells it.
function snakeEvent(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

interface TrustSlot {
  readonly path: string;
  readonly event: string;
  readonly group: number;
  readonly hook: number;
}

// "<hooks file>:<event>:<group>:<hook>"; the file's own path may hold colons (a drive letter).
function trustSlot(key: string): TrustSlot | null {
  const parts = key.split(":");
  const [event, group, hook] = parts.slice(-3);
  if (parts.length < 4 || event === undefined || group === undefined || hook === undefined) return null;
  if (!/^\d+$/u.test(group) || !/^\d+$/u.test(hook)) return null;
  return { path: parts.slice(0, -3).join(":"), event, group: Number(group), hook: Number(hook) };
}

// What Codex trusted at one position of a hooks document: the group around the hook, and the
// hook. null when nothing is there.
function trustedAt(document: unknown, slot: TrustSlot): string | null {
  if (!isObject(document) || !isObject(document.hooks)) return null;
  const groups = Object.entries(document.hooks).find(([event]) => snakeEvent(event) === slot.event)?.[1];
  if (!Array.isArray(groups)) return null;
  const group: unknown = groups[slot.group];
  if (!isObject(group) || !Array.isArray(group.hooks)) return null;
  const hook: unknown = group.hooks[slot.hook];
  if (hook === undefined) return null;
  const around: Record<string, unknown> = { ...group };
  delete around.hooks;
  return stableJson({ group: around, hook });
}

/** Codex's config.toml with its hooks switch on and no trust state for a hook that is gone or changed (R4). */
export function codexHookConfig(current: string | null, change: CodexTrustChange): CodexConfigEdit {
  const file = CODEX_CONFIG_FILE;
  const source = current ?? "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const statements = toml(() => statementLines(source, file));
  const lines = source.split("\n");
  const drop = new Set<number>();
  const removedTrustStates: string[] = [];
  let table: readonly string[] = [];
  let arrayOfTables = false;
  let featuresHeader: number | null = null;
  let switchLine: number | null = null;
  let dropping = false;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1 && line === "";
    if (statements[index] !== true) {
      if (dropping && !last) drop.add(index);
      continue;
    }
    const text = line.replace(/\r$/u, "");
    const heading = ARRAY_TABLE_HEADER.exec(text) ?? TABLE_HEADER.exec(text);
    if (heading !== null) {
      dropping = false;
      table = toml(() => keySegments(heading[1] ?? "", file));
      arrayOfTables = text.trimStart().startsWith("[[");
      if (table.length === 1 && table[0] === FEATURES_TABLE) {
        if (arrayOfTables) unsupported(file, `[[${FEATURES_TABLE}]] is not the table Codex reads`);
        featuresHeader = index;
      }
      const key = table[2];
      if (!arrayOfTables && table.length === 3 && table[0] === TRUST_TABLE[0] && table[1] === TRUST_TABLE[1] && key !== undefined) {
        const slot = trustSlot(key);
        if (slot !== null && slot.path === change.hooksPath) {
          const before = trustedAt(change.before, slot);
          if (before === null || before !== trustedAt(change.after, slot)) {
            dropping = true;
            drop.add(index);
            removedTrustStates.push(key);
          }
        }
      }
      continue;
    }
    if (dropping) {
      if (!last) drop.add(index);
      continue;
    }
    const assignment = KEY_ASSIGNMENT.exec(text);
    if (assignment === null || arrayOfTables) continue;
    const path = [...table, ...toml(() => keySegments(assignment[1] ?? "", file))];
    if (path[0] !== FEATURES_TABLE) continue;
    if (path.length === 1) unsupported(file, `${FEATURES_TABLE} is set as an inline table; set ${HOOKS_SWITCH} in a [${FEATURES_TABLE}] table`);
    if (path.length === 2 && path[1] === HOOKS_SWITCH) switchLine = index;
  }
  const replace = new Map<number, string>();
  const insertAfter = new Map<number, string>();
  let append = "";
  let hooksEnabled = false;
  if (change.enableHooks) {
    const carriage = eol === "\r\n" ? "\r" : "";
    if (switchLine !== null) {
      const line = lines[switchLine] ?? "";
      const value = SWITCH_VALUE.exec(line.replace(/\r$/u, ""));
      if (value === null) unsupported(file, `${FEATURES_TABLE}.${HOOKS_SWITCH} is not true or false`);
      if (value[2] === "false") {
        replace.set(switchLine, `${value[1] ?? ""}true${value[3] ?? ""}${line.endsWith("\r") ? "\r" : ""}`);
        hooksEnabled = true;
      }
    } else if (featuresHeader !== null) {
      insertAfter.set(featuresHeader, `${HOOKS_SWITCH} = true${carriage}`);
      hooksEnabled = true;
    } else {
      append = `[${FEATURES_TABLE}]${eol}${HOOKS_SWITCH} = true${eol}`;
      hooksEnabled = true;
    }
  }
  const output: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (drop.has(index)) continue;
    output.push(replace.get(index) ?? line);
    const inserted = insertAfter.get(index);
    if (inserted !== undefined) output.push(inserted);
  }
  let text = output.join("\n");
  if (drop.size > 0) {
    // A table dropped at the end leaves the blank line before it; the file keeps the ending it had.
    const ending = /(?:\r?\n)*$/u.exec(source)?.[0] ?? "";
    text = `${text.replace(/(?:\r?\n)*$/u, "")}${ending}`;
  }
  if (append !== "") text = text.trim() === "" ? append : `${text}${text.endsWith("\n") ? "" : eol}${eol}${append}`;
  return { text, removedTrustStates, hooksEnabled };
}

// ---- Reading the files and writing them ----

export interface HostHooksLocation {
  // The directory the scope names: the user's home (user scope) or the project (project scope).
  readonly root: string;
  // The user's home, where Codex keeps config.toml whatever the scope; the process's when left out.
  readonly home?: string;
}

export interface HostHookFile {
  // The absolute path, and the same file relative to `root`.
  readonly path: string;
  readonly root: string;
  readonly name: string;
  // null: the file does not exist (before), or stays absent (after).
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
}

export interface HostHooksPlan {
  readonly expectation: HostHooksExpectation;
  readonly root: string;
  readonly home: string;
  readonly files: readonly HostHookFile[];
  readonly removedHooks: readonly RemovedHook[];
  readonly removedDenyRules: readonly string[];
  readonly removedKeys: readonly string[];
  readonly removedTrustStates: readonly string[];
}

async function directory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  let stats: Stats;
  try {
    stats = await stat(absolute);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") fail("HOST_HOOKS_INPUT_INVALID", `the ${label} ${absolute} does not exist`, { [label]: absolute });
    throw error;
  }
  if (!stats.isDirectory()) fail("HOST_HOOKS_INPUT_INVALID", `the ${label} ${absolute} is not a directory`, { [label]: absolute });
  return absolute;
}

// A host file's text, or null when it does not exist; anything but a regular UTF-8 file is refused.
async function readHostFile(path: string, name: string): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") unsupported(name, "a parent of it is not a directory");
    throw error;
  }
  if (!stats.isFile()) unsupported(name, "not a regular file");
  const bytes = await readFile(path);
  if (!isUtf8(bytes)) unsupported(name, "not UTF-8 text");
  return bytes.toString("utf8");
}

function parseHookDocument(text: string | null, name: string): Record<string, unknown> | null {
  if (text === null || text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    unsupported(name, "not JSON");
  }
  if (!isObject(parsed)) unsupported(name, "not a JSON object");
  return parsed;
}

/** The host's files as they are and as they would be rendered; nothing is written (R1, R3, R4). */
export async function readHostHooks(expectation: HostHooksExpectation, location: HostHooksLocation): Promise<HostHooksPlan> {
  const root = await directory(location.root, "root");
  const home = await directory(location.home ?? homedir(), "home");
  const hooksPath = join(root, expectation.hooksFile);
  const hooksBefore = await readHostFile(hooksPath, expectation.hooksFile);
  const document = parseHookDocument(hooksBefore, expectation.hooksFile);
  const merge = mergeHostHooks(document, expectation);
  const hooksChanged = document === null ? Object.keys(merge.document).length > 0 : stableJson(merge.document) !== stableJson(document);
  const files: HostHookFile[] = [{
    path: hooksPath,
    root,
    name: expectation.hooksFile,
    before: hooksBefore,
    after: hooksChanged ? `${JSON.stringify(merge.document, null, 2)}\n` : hooksBefore,
    changed: hooksChanged,
  }];
  let removedTrustStates: readonly string[] = [];
  if (expectation.configFile !== null) {
    const configPath = join(home, expectation.configFile);
    const configBefore = await readHostFile(configPath, expectation.configFile);
    const edit = codexHookConfig(configBefore, { hooksPath, before: document, after: merge.document, enableHooks: expectation.install });
    const configAfter = configBefore === null && edit.text === "" ? null : edit.text;
    files.push({ path: configPath, root: home, name: expectation.configFile, before: configBefore, after: configAfter, changed: configAfter !== configBefore });
    removedTrustStates = edit.removedTrustStates;
  }
  return {
    expectation,
    root,
    home,
    files,
    removedHooks: merge.removedHooks,
    removedDenyRules: merge.removedDenyRules,
    removedKeys: merge.removedKeys,
    removedTrustStates,
  };
}

export type HostHooksOutcome = "HOST_HOOKS_WRITTEN" | "HOST_HOOKS_CURRENT";

export interface AppliedHostHooks {
  readonly reasonCode: HostHooksOutcome;
  readonly host: HostHookHost;
  readonly scope: HostHookScope;
  readonly root: string;
  // Where the replaced originals were copied; null when no existing file changed.
  readonly backupDir: string | null;
  readonly files: readonly { readonly path: string; readonly name: string; readonly changed: boolean }[];
}

export interface ApplyHostHooksOptions {
  // The instant the backup directory is named by, to the second.
  readonly at: string;
  // backups/ in the device directory the plan names, when left out.
  readonly backupRoot?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Write a plan. Every file that changes must still hold what was read; each existing one is copied
 * to backups/<UTC second>/host-hooks/<root digest>/ in the device directory (an earlier copy there
 * is kept), and then each is replaced atomically. When a write fails, the files this call already
 * replaced are put back.
 */
export async function applyHostHooks(plan: HostHooksPlan, options: ApplyHostHooksOptions): Promise<AppliedHostHooks> {
  const stamp = utcStamp(options.at);
  const expectation = plan.expectation;
  if ((expectation.platform === "win32") !== (process.platform === "win32")) {
    fail("HOST_HOOKS_INPUT_INVALID", `hooks written for ${expectation.platform} are applied on that platform`, { platform: expectation.platform });
  }
  const changed = plan.files.filter((file) => file.changed);
  for (const file of changed) {
    if (await readHostFile(file.path, file.name) !== file.before) {
      fail("HOST_HOOKS_CONCURRENT_MODIFICATION", `${file.name} changed after the hooks were planned`, { file: file.name });
    }
  }
  const files = plan.files.map(({ path, name, changed: fileChanged }) => ({ path, name, changed: fileChanged }));
  const summary = { host: expectation.host, scope: expectation.scope, root: plan.root, files };
  if (changed.length === 0) return { reasonCode: "HOST_HOOKS_CURRENT", ...summary, backupDir: null };
  const backupDir = changed.some((file) => file.before !== null)
    ? join(options.backupRoot ?? backupsPath(expectation.deviceHome), stamp, "host-hooks")
    : null;
  for (const file of changed) {
    if (file.before === null || backupDir === null) continue;
    const backup = join(backupDir, createHash("sha256").update(file.root).digest("hex").slice(0, 16), file.name);
    if (await exists(backup)) continue;
    await mkdir(dirname(backup), { recursive: true });
    await writeFileAtomic(backup, file.before);
  }
  const written: HostHookFile[] = [];
  try {
    for (const file of changed) {
      if (file.after === null) continue;
      await mkdir(dirname(file.path), { recursive: true });
      await writeFileAtomic(file.path, file.after);
      written.push(file);
    }
  } catch (error) {
    for (const file of written) {
      if (file.before === null) await rm(file.path, { force: true });
      else await writeFileAtomic(file.path, file.before);
    }
    throw error;
  }
  return { reasonCode: "HOST_HOOKS_WRITTEN", ...summary, backupDir };
}
