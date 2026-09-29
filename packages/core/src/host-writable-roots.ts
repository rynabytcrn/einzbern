// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-470 R5, AC4 (MIN-227 D19): a library outside its project lies outside what the
// two hosts let a session write without asking, so the project's own host settings name it:
// Claude Code's `permissions.additionalDirectories` in <project>/.claude/settings.local.json and
// Codex's `[sandbox_workspace_write] writable_roots` in <project>/.codex/config.toml. Everything
// else in both files is kept. A library inside its project needs neither, and nothing is written.
//
// The library path is this machine's absolute path, so it only ever goes into these local host
// files, never into anything the engine commits. A host file Git already tracks is still wired,
// and the result says so (trackedByGit), because committing it would publish the path; the setup
// wizard asks the same question (hostFileTrackedByGit) and names such a file in its plan and its
// receipt (HOST_WRITABLE_ROOTS_TRACKED_BY_GIT, packages/core/src/setup-fresh.ts). Before a
// file is replaced its original is copied into the device directory
// (backups/<UTC instant>/writable-roots/<project digest>/, an earlier copy there is kept), and the
// replacement is atomic. Wiring the same library twice changes nothing. A host file this module
// cannot edit without risking the rest of it (not a regular file, or not JSON or TOML it can
// follow) is refused rather than rewritten, and so is one that changed after it was planned.

import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { backupsPath } from "./device-home.js";
import { openLibrary } from "./ether-library.js";

export const HOST_WRITABLE_ROOTS_REASON_CODES = Object.freeze([
  "HOST_WRITABLE_ROOTS_CONCURRENT_MODIFICATION",
  "HOST_WRITABLE_ROOTS_FAILED",
  "HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED",
  "HOST_WRITABLE_ROOTS_PROJECT_NOT_FOUND",
] as const);
export type HostWritableRootsReasonCode = typeof HOST_WRITABLE_ROOTS_REASON_CODES[number];

export class HostWritableRootsError extends Error {
  readonly reasonCode: HostWritableRootsReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: HostWritableRootsReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "HostWritableRootsError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: HostWritableRootsReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new HostWritableRootsError(reasonCode, message, details);
}

function unsupported(file: string, reason: string): never {
  return fail("HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED", `${file}: ${reason}`, { file });
}

export type WritableRootsHost = "claude-code" | "codex";
export const WRITABLE_ROOTS_HOSTS: readonly WritableRootsHost[] = Object.freeze(["claude-code", "codex"]);
// Each host's project-level settings file, relative to the project root.
export const WRITABLE_ROOTS_FILES: Readonly<Record<WritableRootsHost, string>> = Object.freeze({
  "claude-code": ".claude/settings.local.json",
  codex: ".codex/config.toml",
});

export interface WritableRootsFile {
  readonly host: WritableRootsHost;
  readonly path: string;
  // Null when the file does not exist yet.
  readonly before: string | null;
  readonly after: string;
  readonly changed: boolean;
  readonly trackedByGit: boolean;
}

export interface WritableRootsPlan {
  readonly projectRoot: string;
  readonly libraryPath: string;
  readonly libraryInsideProject: boolean;
  readonly files: readonly WritableRootsFile[];
}

export type WritableRootsOutcome = "HOST_WRITABLE_ROOTS_WRITTEN" | "HOST_WRITABLE_ROOTS_CURRENT" | "HOST_WRITABLE_ROOTS_NOT_NEEDED";

export interface AppliedWritableRoots {
  readonly reasonCode: WritableRootsOutcome;
  readonly projectRoot: string;
  readonly libraryPath: string;
  readonly libraryInsideProject: boolean;
  // Where the replaced originals were copied; null when no existing file changed.
  readonly backupDir: string | null;
  readonly files: readonly {
    readonly host: WritableRootsHost;
    readonly path: string;
    readonly changed: boolean;
    readonly trackedByGit: boolean;
  }[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function inside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

// ---- Claude Code: JSON ----

/** Claude Code: `permissions.additionalDirectories` names the library; every other field is kept. */
export function claudeWritableRoots(current: string | null, libraryPath: string): string {
  const file = WRITABLE_ROOTS_FILES["claude-code"];
  let document: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      unsupported(file, "not JSON");
    }
    if (!isObject(parsed)) unsupported(file, "not a JSON object");
    document = parsed;
  }
  const permissions = document.permissions ?? {};
  if (!isObject(permissions)) unsupported(file, "permissions is not an object");
  const directories = permissions.additionalDirectories ?? [];
  if (!isPathList(directories)) unsupported(file, "permissions.additionalDirectories is not a list of paths");
  if (current !== null && directories.includes(libraryPath)) return current;
  return `${JSON.stringify({ ...document, permissions: { ...permissions, additionalDirectories: [...directories, libraryPath] } }, null, 2)}\n`;
}

// ---- Codex: TOML ----
//
// The file is edited in place rather than parsed and re-rendered, so its comments, order and
// layout stay as they are: the library is appended to an existing writable_roots array, or a
// writable_roots line is added under an existing [sandbox_workspace_write] header, or that table
// is appended at the end. Only the forms this can do safely are accepted.

const CODEX_TABLE = "sandbox_workspace_write";
const CODEX_KEY = "writable_roots";
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const KEY_PATH = String.raw`${KEY_SEGMENT}(?:\s*\.\s*${KEY_SEGMENT})*`;
// The line forms below, keySegments, statementLines and utcStamp are also what the host hook
// wiring edits Codex's config.toml and dates its backups with (TCRN-CROSS-STORY-477,
// packages/core/src/host-hooks.ts).
export const TABLE_HEADER = new RegExp(String.raw`^\s*\[\s*(${KEY_PATH})\s*\]\s*(?:#.*)?$`, "u");
export const ARRAY_TABLE_HEADER = new RegExp(String.raw`^\s*\[\[\s*(${KEY_PATH})\s*\]\]\s*(?:#.*)?$`, "u");
export const KEY_ASSIGNMENT = new RegExp(String.raw`^\s*(${KEY_PATH})\s*=`, "u");
const BASIC_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", "\"": "\"", "\\": "\\",
});

function decodeBasicString(raw: string, file: string): string {
  return raw.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|([\s\S]))/gu,
    (_escape: string, short: string | undefined, long: string | undefined, byte: string | undefined, single: string | undefined): string => {
      const hex = short ?? long ?? byte;
      if (hex !== undefined) {
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) unsupported(file, `the escape of ${hex} is not a Unicode scalar value`);
        return String.fromCodePoint(point);
      }
      const decoded = BASIC_ESCAPES[single ?? ""];
      if (decoded === undefined) unsupported(file, "a string holds an escape TOML does not have");
      return decoded;
    });
}

// A TOML basic string: JSON's escapes are TOML's, and DEL, which JSON leaves bare, is escaped.
function tomlBasicString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/gu, "\\u007f");
}

export function keySegments(path: string, file: string): readonly string[] {
  return [...path.matchAll(new RegExp(KEY_SEGMENT, "gu"))].map(([segment]) => (segment.startsWith("\"")
    ? decodeBasicString(segment.slice(1, -1), file)
    : segment.startsWith("'") ? segment.slice(1, -1) : segment));
}

function quoteRun(source: string, index: number, quote: string): number {
  let end = index;
  while (source[end] === quote) end += 1;
  return end - index;
}

type TomlScanState = "normal" | "comment" | "basic" | "literal" | "multiline-basic" | "multiline-literal";

// Which lines of a TOML document begin a statement: not inside a multi-line string, and not inside
// an array or inline table an earlier line left open. The scan follows strings, comments and
// brackets and nothing more; a document it cannot follow is refused rather than edited.
export function statementLines(source: string, file: string): readonly boolean[] {
  const starts: boolean[] = [true];
  let state: TomlScanState = "normal";
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\n") {
      if (state === "basic" || state === "literal") unsupported(file, "a string runs past the end of its line");
      if (state === "comment") state = "normal";
      starts.push(state === "normal" && depth === 0);
      continue;
    }
    if (state === "comment") continue;
    if ((state === "basic" || state === "multiline-basic") && character === "\\") {
      // The escaped character is skipped; a line-ending backslash leaves the newline to be counted.
      if (source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (state === "basic" || state === "literal") {
      if (character === (state === "basic" ? "\"" : "'")) state = "normal";
      continue;
    }
    if (state === "multiline-basic" || state === "multiline-literal") {
      const quote = state === "multiline-basic" ? "\"" : "'";
      if (character === quote) {
        const run = quoteRun(source, index, quote);
        if (run >= 3) state = "normal";
        index += run - 1;
      }
      continue;
    }
    if (character === "#") {
      state = "comment";
    } else if (character === "\"" || character === "'") {
      const run = quoteRun(source, index, character);
      if (run >= 3) {
        state = character === "\"" ? "multiline-basic" : "multiline-literal";
        index += 2;
      } else if (run === 2) {
        index += 1;
      } else {
        state = character === "\"" ? "basic" : "literal";
      }
    } else if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0) unsupported(file, "a bracket closes that never opened");
    }
  }
  if (state !== "normal" && state !== "comment") unsupported(file, "a string is not closed");
  if (depth !== 0) unsupported(file, "a bracket is not closed");
  return starts;
}

// The index of the quote that closes the one-line string opened at `start`.
function closingQuote(source: string, start: number, quote: string, file: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n" || character === "\r") break;
    if (quote === "\"" && character === "\\") {
      index += 1;
    } else if (character === quote) {
      return index;
    }
  }
  return unsupported(file, "a string is not closed on its line");
}

interface TomlStringArray {
  readonly values: readonly string[];
  readonly open: number;
  readonly close: number;
  // Just after the last element's closing quote, and the comma after it, if any.
  readonly lastValueEnd: number | null;
  readonly trailingComma: number | null;
}

// The array of strings whose value starts at `start` (just after `writable_roots =`).
function tomlStringArray(source: string, start: number, file: string): TomlStringArray {
  let index = start;
  const skip = (lines: boolean): void => {
    for (;;) {
      const character = source[index];
      if (character === " " || character === "\t" || (lines && (character === "\n" || character === "\r"))) {
        index += 1;
      } else if (lines && character === "#") {
        while (index < source.length && source[index] !== "\n") index += 1;
      } else {
        return;
      }
    }
  };
  skip(false);
  if (source[index] !== "[") unsupported(file, `${CODEX_KEY} is not an array`);
  const open = index;
  index += 1;
  const values: string[] = [];
  let lastValueEnd: number | null = null;
  let trailingComma: number | null = null;
  for (;;) {
    skip(true);
    const character = source[index];
    if (character === "]") break;
    if (lastValueEnd !== null && trailingComma === null) unsupported(file, `${CODEX_KEY} elements are not separated by commas`);
    if (character !== "\"" && character !== "'") unsupported(file, `${CODEX_KEY} holds something other than strings`);
    if (source.startsWith(character.repeat(3), index)) unsupported(file, `${CODEX_KEY} holds a multi-line string`);
    const end = closingQuote(source, index, character, file);
    const raw = source.slice(index + 1, end);
    values.push(character === "'" ? raw : decodeBasicString(raw, file));
    index = end + 1;
    lastValueEnd = index;
    trailingComma = null;
    skip(true);
    if (source[index] === ",") {
      trailingComma = index;
      index += 1;
    }
  }
  const close = index;
  const lineEnd = source.indexOf("\n", close);
  if (!/^[ \t]*(?:#.*)?\r?$/u.test(source.slice(close + 1, lineEnd < 0 ? source.length : lineEnd))) {
    unsupported(file, `${CODEX_KEY} is followed by more on its line`);
  }
  return { values, open, close, lastValueEnd, trailingComma };
}

/** Codex: `[sandbox_workspace_write] writable_roots` names the library; every other byte is kept. */
export function codexWritableRoots(current: string | null, libraryPath: string): string {
  const file = WRITABLE_ROOTS_FILES.codex;
  const source = current ?? "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const entry = tomlBasicString(libraryPath);
  const statements = statementLines(source, file);
  let offset = 0;
  let table: "root" | "ours" | "other" = "root";
  // Just after the [sandbox_workspace_write] line, and just after `writable_roots =` in it.
  let header: number | null = null;
  let valueStart: number | null = null;
  for (const [index, line] of source.split("\n").entries()) {
    const lineStart = offset;
    offset += line.length + 1;
    if (statements[index] !== true) continue;
    const text = line.replace(/\r$/u, "");
    const heading = ARRAY_TABLE_HEADER.exec(text) ?? TABLE_HEADER.exec(text);
    if (heading !== null) {
      const path = keySegments(heading[1] ?? "", file);
      const arrayOfTables = text.trimStart().startsWith("[[");
      if (path[0] === CODEX_TABLE && (arrayOfTables || path[1] === CODEX_KEY || (path.length === 1 && header !== null))) {
        unsupported(file, `[${CODEX_TABLE}] is declared more than once or not as one table`);
      }
      table = !arrayOfTables && path.length === 1 && path[0] === CODEX_TABLE ? "ours" : "other";
      if (table === "ours") header = Math.min(offset, source.length);
      continue;
    }
    const assignment = KEY_ASSIGNMENT.exec(text);
    if (assignment === null) continue;
    const path = keySegments(assignment[1] ?? "", file);
    if (table === "root" && path[0] === CODEX_TABLE) {
      unsupported(file, `${CODEX_TABLE} is set as a key; set ${CODEX_KEY} inside a [${CODEX_TABLE}] table`);
    }
    if (table === "ours" && path[0] === CODEX_KEY) {
      if (path.length > 1 || valueStart !== null) unsupported(file, `${CODEX_KEY} is declared more than once or not as one array`);
      valueStart = lineStart + assignment[0].length;
    }
  }
  const line = `${CODEX_KEY} = [${entry}]${eol}`;
  if (header === null) {
    const appended = `[${CODEX_TABLE}]${eol}${line}`;
    if (source.trim() === "") return appended;
    return `${source}${source.endsWith("\n") ? "" : eol}${eol}${appended}`;
  }
  if (valueStart === null) {
    return header < source.length || source.endsWith("\n")
      ? `${source.slice(0, header)}${line}${source.slice(header)}`
      : `${source}${eol}${line}`;
  }
  const array = tomlStringArray(source, valueStart, file);
  if (array.values.includes(libraryPath)) return source;
  if (array.lastValueEnd === null) {
    return source.slice(array.open + 1, array.close).trim() === ""
      ? `${source.slice(0, array.open)}[${entry}]${source.slice(array.close + 1)}`
      : `${source.slice(0, array.open + 1)}${entry}${source.slice(array.open + 1)}`;
  }
  if (array.trailingComma !== null) {
    return `${source.slice(0, array.trailingComma + 1)} ${entry},${source.slice(array.trailingComma + 1)}`;
  }
  return `${source.slice(0, array.lastValueEnd)}, ${entry}${source.slice(array.lastValueEnd)}`;
}

// ---- Plan and apply ----

async function projectDirectory(input: string): Promise<string> {
  const given = resolve(input);
  let real: string;
  try {
    real = await realpath(given);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") fail("HOST_WRITABLE_ROOTS_PROJECT_NOT_FOUND", `${given} does not exist`, { project: given });
    throw error;
  }
  if (!(await stat(real)).isDirectory()) fail("HOST_WRITABLE_ROOTS_PROJECT_NOT_FOUND", `${given} is not a directory`, { project: given });
  return real;
}

// A host file's text, or null when it does not exist; anything but a regular UTF-8 file is refused.
async function readHostFile(path: string, file: string): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") unsupported(file, "a parent of it is not a directory");
    throw error;
  }
  if (!stats.isFile()) unsupported(file, "not a regular file");
  const bytes = await readFile(path);
  if (!isUtf8(bytes)) unsupported(file, "not UTF-8 text");
  return bytes.toString("utf8");
}

/**
 * Whether Git tracks a project's host file: it is in the index of the repository the project sits
 * in. It reads neither the file nor a library, so the setup wizard asks it while it plans an
 * installation whose library does not exist yet (TCRN-CROSS-SUB-385 R16); a project that is no Git
 * repository, or a machine without Git, tracks nothing.
 */
export function hostFileTrackedByGit(projectRoot: string, file: string): boolean {
  try {
    execFileSync("git", ["-C", projectRoot, "ls-files", "--error-unmatch", "--", file], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export interface WritableRootsInput {
  readonly projectRoot: string;
  readonly libraryPath: string;
  // Both hosts when left out.
  readonly hosts?: readonly WritableRootsHost[];
}

/** What the project's host files must say for the library, read from both; nothing is written. */
export async function planWritableRoots(input: WritableRootsInput): Promise<WritableRootsPlan> {
  const projectRoot = await projectDirectory(input.projectRoot);
  const libraryPath = (await openLibrary(input.libraryPath)).root;
  if (inside(projectRoot, libraryPath)) return { projectRoot, libraryPath, libraryInsideProject: true, files: [] };
  const files: WritableRootsFile[] = [];
  for (const host of input.hosts ?? WRITABLE_ROOTS_HOSTS) {
    const path = WRITABLE_ROOTS_FILES[host];
    const before = await readHostFile(join(projectRoot, path), path);
    const after = host === "claude-code" ? claudeWritableRoots(before, libraryPath) : codexWritableRoots(before, libraryPath);
    files.push({ host, path, before, after, changed: after !== before, trackedByGit: hostFileTrackedByGit(projectRoot, path) });
  }
  return { projectRoot, libraryPath, libraryInsideProject: false, files };
}

// The UTC second as a file name that is legal everywhere: 20260926T100000Z.
export function utcStamp(at: string): string {
  const milliseconds = Number(parseStrictInstant(at) / 1_000_000n);
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, "Z").replace(/[-:]/gu, "");
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
 * Write a plan. Every file that changes must still hold what was planned; each existing one is
 * copied to backups/<UTC instant>/writable-roots/<project digest>/ in the device directory, and
 * then every file is replaced atomically.
 */
export async function applyWritableRoots(plan: WritableRootsPlan, options: { readonly at: string; readonly home?: string }): Promise<AppliedWritableRoots> {
  const stamp = utcStamp(options.at);
  const changed = plan.files.filter((file) => file.changed);
  for (const file of changed) {
    if (await readHostFile(join(plan.projectRoot, file.path), file.path) !== file.before) {
      fail("HOST_WRITABLE_ROOTS_CONCURRENT_MODIFICATION", `${file.path} changed after the wiring was planned`, { file: file.path });
    }
  }
  const backupDir = changed.some((file) => file.before !== null)
    ? join(options.home === undefined ? backupsPath() : backupsPath(options.home), stamp, "writable-roots",
      createHash("sha256").update(plan.projectRoot).digest("hex").slice(0, 16))
    : null;
  for (const file of changed) {
    if (file.before === null || backupDir === null) continue;
    const backup = join(backupDir, file.path);
    if (await exists(backup)) continue;
    await mkdir(dirname(backup), { recursive: true });
    await writeFileAtomic(backup, file.before);
  }
  for (const file of changed) {
    const target = join(plan.projectRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, file.after);
  }
  return {
    reasonCode: plan.libraryInsideProject ? "HOST_WRITABLE_ROOTS_NOT_NEEDED" : changed.length > 0 ? "HOST_WRITABLE_ROOTS_WRITTEN" : "HOST_WRITABLE_ROOTS_CURRENT",
    projectRoot: plan.projectRoot,
    libraryPath: plan.libraryPath,
    libraryInsideProject: plan.libraryInsideProject,
    backupDir,
    files: plan.files.map(({ host, path, changed: fileChanged, trackedByGit: tracked }) => ({ host, path, changed: fileChanged, trackedByGit: tracked })),
  };
}
