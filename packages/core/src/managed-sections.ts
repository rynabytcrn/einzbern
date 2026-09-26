// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-478 R1, R2, R6 (MIN-227 D14; TCRN-CROSS-SUB-316): the managed-section writer.
// AGENTS.md and CLAUDE.md are the user's files. The engine owns only the lines between its own
// markers, each on a line of its own:
//
//   <!-- einzbern:section id=<id> rev=<n> digest=<sha256> -->
//   ...
//   <!-- einzbern:section-end id=<id> -->
//
// The digest is the sha256 of the section body after normalisation (CRLF becomes LF, trailing
// white space is dropped, the body ends in exactly one line feed), and it is kept twice: in the
// start marker and in the library's managed-section record (config-records.ts). A section is
// replaced only while the marker's digest, the record's digest and the digest of the body now in
// the file all agree; any difference means the user changed it, so that section is left as it
// is and its record goes pending. A section whose markers are gone was removed by the user and
// is not put back. A file whose markers do not parse is refused whole, naming the line. A file
// that does not exist is created only when a section is to be written into it. The text outside
// the sections is never rewritten. Nothing here runs unless it is called: an engine upgrade
// writes no file.

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseStrictInstant } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { backupsPath } from "./device-home.js";
import type { ConfigRecord } from "./config-records.js";

export const MANAGED_SECTION_REASON_CODES = Object.freeze([
  "MANAGED_SECTION_ABSOLUTE_PATH",
  "MANAGED_SECTION_CHANGED_SINCE_PLAN",
  "MANAGED_SECTION_FILE_UNSUPPORTED",
  "MANAGED_SECTION_INPUT_INVALID",
  "MANAGED_SECTION_MALFORMED",
  "MANAGED_SECTION_RECORD_INVALID",
] as const);

export type ManagedSectionReasonCode = typeof MANAGED_SECTION_REASON_CODES[number];

export class ManagedSectionError extends Error {
  readonly reasonCode: ManagedSectionReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: ManagedSectionReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "ManagedSectionError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode: ManagedSectionReasonCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new ManagedSectionError(reasonCode, message, details);
}

// What the library records about a section: managed while the engine may write it; pending while
// the user's change waits for a decision; user-owned once the user kept it (never written again);
// unmanaged once its markers were taken away on request; removed once the user deleted it.
export const MANAGED_SECTION_STATES = Object.freeze(["managed", "pending", "removed", "unmanaged", "user-owned"] as const);
export type ManagedSectionState = typeof MANAGED_SECTION_STATES[number];

/** The value of a managed-section record, keyed `<file>#<id>` in the library. */
export interface ManagedSectionRecord {
  readonly file: string;
  readonly id: string;
  readonly rev: number;
  readonly digest: string;
  readonly state: ManagedSectionState;
}

/** One section as it stands in a file. */
export interface ParsedSection {
  readonly id: string;
  readonly rev: number;
  // The digest its start marker carries.
  readonly digest: string;
  // The lines between the markers, as they are.
  readonly body: string;
  // The digest of that body, normalised.
  readonly bodyDigest: string;
  // The section's bytes from its start marker through its end marker's line ending.
  readonly raw: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A parsed file: outside[i] precedes sections[i], and the last entry of outside follows the last section. */
export interface ParsedManagedFile {
  readonly sections: readonly ParsedSection[];
  readonly outside: readonly string[];
  // The file's line ending, taken from its first line: rendered sections use it too.
  readonly eol: "\n" | "\r\n";
}

export type ManagedSectionResult = "create" | "replace" | "unchanged" | "refused-user-modified" | "removed";

export interface ManagedSectionDecision {
  readonly id: string;
  readonly result: ManagedSectionResult;
  // The record after this plan; recordChanged says whether it differs from the one passed in.
  readonly record: ManagedSectionRecord;
  readonly recordChanged: boolean;
  // Where the section starts in the file as read, when it is there.
  readonly line: number | null;
}

export interface ManagedWritePlan {
  readonly filePath: string;
  readonly file: string;
  readonly exists: boolean;
  // The file as read (null when it does not exist) and as it will be written (null when it is not).
  readonly before: string | null;
  readonly after: string | null;
  readonly write: boolean;
  readonly sections: readonly ManagedSectionDecision[];
  // The sections left alone because the user changed them.
  readonly pending: readonly string[];
}

export interface AppliedManagedWrite {
  readonly filePath: string;
  readonly written: boolean;
  // Where the file was copied before it was replaced; null when nothing was replaced.
  readonly backupPath: string | null;
}

const START_PREFIX = "<!-- einzbern:section ";
const END_PREFIX = "<!-- einzbern:section-end ";
const MARKER_PREFIX = "<!-- einzbern:section";
const MARKER_SUFFIX = " -->";
const SECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION = /^[1-9][0-9]{0,15}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
// An absolute path: a rooted POSIX path of two or more segments, a Windows drive or a UNC share,
// at the start of a line or after white space or punctuation that opens a path.
const ABSOLUTE_PATH = /(?:^|[\s(<[{"'`=,;|])(?:\/(?!\/)[^\s/]+\/|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\)/u;

export function isManagedSectionId(value: unknown): value is string {
  return typeof value === "string" && SECTION_ID.test(value);
}

/** Normalise a section body: CRLF to LF, no trailing white space on a line, exactly one final line feed (none when empty). */
export function normalizeSectionBody(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.replace(/[ \t]+$/u, ""));
  const joined = lines.join("\n").replace(/\n+$/u, "");
  return joined === "" ? "" : `${joined}\n`;
}

/** The sha256 of a normalised section body, as a marker and a record carry it. */
export function sectionDigest(body: string): string {
  return createHash("sha256").update(normalizeSectionBody(body), "utf8").digest("hex");
}

/** The first line of a body that names an absolute path, or null. */
export function absolutePathLine(body: string): number | null {
  const lines = body.split(/\r?\n/u);
  const index = lines.findIndex((line) => ABSOLUTE_PATH.test(line));
  return index === -1 ? null : index + 1;
}

/** A section as the engine writes it: start marker, normalised body, end marker, each line ended by `eol`. */
export function renderSection(section: { readonly id: string; readonly rev: number; readonly body: string }, eol: "\n" | "\r\n" = "\n"): string {
  if (!isManagedSectionId(section.id)) fail("MANAGED_SECTION_INPUT_INVALID", `${String(section.id)} is not a section id`, { id: String(section.id) });
  if (!Number.isSafeInteger(section.rev) || section.rev < 1) fail("MANAGED_SECTION_INPUT_INVALID", `a section revision is a positive integer`, { id: section.id });
  const body = normalizeSectionBody(section.body);
  const lines = [
    `${START_PREFIX}id=${section.id} rev=${section.rev} digest=${sectionDigest(body)}${MARKER_SUFFIX}`,
    ...(body === "" ? [] : body.slice(0, -1).split("\n")),
    `${END_PREFIX}id=${section.id}${MARKER_SUFFIX}`,
  ];
  return lines.map((line) => `${line}${eol}`).join("");
}

function malformed(line: number, reason: string, file: string | undefined): never {
  fail("MANAGED_SECTION_MALFORMED", `${file ?? "the file"}: line ${line}: ${reason}`, { line: String(line), reason, ...(file === undefined ? {} : { file }) });
}

// The attributes of a marker line, exactly the named ones, or the reason they are not.
function markerAttributes(text: string, names: readonly string[]): Readonly<Record<string, string>> | string {
  const attributes: Record<string, string> = {};
  for (const token of text.split(" ")) {
    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? "" : token.slice(separator + 1);
    if (!names.includes(name)) return `unknown attribute ${JSON.stringify(name)}`;
    if (Object.hasOwn(attributes, name)) return `attribute ${name} appears twice`;
    if (value === "") return `attribute ${name} has no value`;
    attributes[name] = value;
  }
  const missing = names.filter((name) => !Object.hasOwn(attributes, name));
  return missing.length > 0 ? `attribute ${missing.join(", ")} is missing` : attributes;
}

// The lines of a text with their own endings; the last one may have none.
function splitLines(text: string): readonly string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

/**
 * Parse a file into its managed sections and the text around them. A marker that does not parse,
 * a start inside another section, an end without its start, a start without its end and an id
 * used twice are MANAGED_SECTION_MALFORMED, with the line in details.line.
 */
export function parseManagedFile(text: string, file?: string): ParsedManagedFile {
  const lines = splitLines(text);
  const firstEnding = lines[0]?.endsWith("\r\n") === true ? "\r\n" : "\n";
  const sections: ParsedSection[] = [];
  const outside: string[] = [];
  const seen = new Set<string>();
  let current = "";
  let open: { id: string; rev: number; digest: string; startLine: number; raw: string; body: string } | null = null;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const content = line.trim();
    if (!content.startsWith(MARKER_PREFIX)) {
      if (open === null) {
        current += line;
      } else {
        open.body += line;
        open.raw += line;
      }
      continue;
    }
    if (!content.endsWith(MARKER_SUFFIX)) malformed(number, "a marker ends with -->", file);
    if (content.startsWith(END_PREFIX)) {
      const attributes = markerAttributes(content.slice(END_PREFIX.length, -MARKER_SUFFIX.length), ["id"]);
      if (typeof attributes === "string") malformed(number, attributes, file);
      if (open === null) malformed(number, `an end marker for ${attributes.id ?? ""} without its start`, file);
      if (attributes.id !== open.id) malformed(number, `the end marker names ${attributes.id ?? ""} inside section ${open.id}`, file);
      const raw = open.raw + line;
      sections.push({
        id: open.id,
        rev: open.rev,
        digest: open.digest,
        body: open.body,
        bodyDigest: sectionDigest(open.body),
        raw,
        startLine: open.startLine,
        endLine: number,
      });
      outside.push(current);
      current = "";
      open = null;
      continue;
    }
    if (!content.startsWith(START_PREFIX)) malformed(number, "an einzbern marker is either a section start or a section end", file);
    const attributes = markerAttributes(content.slice(START_PREFIX.length, -MARKER_SUFFIX.length), ["id", "rev", "digest"]);
    if (typeof attributes === "string") malformed(number, attributes, file);
    const id = attributes.id ?? "";
    const rev = attributes.rev ?? "";
    const digest = attributes.digest ?? "";
    if (open !== null) malformed(number, `section ${id} starts inside section ${open.id}`, file);
    if (!isManagedSectionId(id)) malformed(number, `${JSON.stringify(id)} is not a section id`, file);
    if (!REVISION.test(rev) || !Number.isSafeInteger(Number(rev))) malformed(number, `rev ${JSON.stringify(rev)} is not a positive integer`, file);
    if (!DIGEST.test(digest)) malformed(number, "digest is not 64 lowercase hex digits", file);
    if (seen.has(id)) malformed(number, `section ${id} appears twice`, file);
    seen.add(id);
    open = { id, rev: Number(rev), digest, startLine: number, raw: line, body: "" };
  }
  if (open !== null) malformed(open.startLine, `section ${open.id} has no end marker`, file);
  outside.push(current);
  return { sections, outside, eol: firstEnding };
}

// A file relative to the project: forward slashes, no empty, current or parent segment, not rooted.
function isRelativeFileName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !value.includes("\\") &&
    !value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !/[\u0000-\u001f\u007f#]/u.test(value);
}

/** The library key of a section's record. */
export function managedSectionRecordKey(file: string, id: string): string {
  return `${file}#${id}`;
}

/** The check the managed-section collection of config-records.ts applies to a record's value. */
export function checkManagedSectionRecordValue(value: Readonly<Record<string, unknown>>, key: string): void {
  const fields = Object.keys(value).sort();
  if (fields.join(",") !== "digest,file,id,rev,state") {
    fail("MANAGED_SECTION_RECORD_INVALID", "a managed-section record holds exactly file, id, rev, digest and state", { key });
  }
  if (!isRelativeFileName(value.file) || !isManagedSectionId(value.id) || typeof value.rev !== "number" || !Number.isSafeInteger(value.rev) || value.rev < 1 ||
    typeof value.digest !== "string" || !DIGEST.test(value.digest) || !(MANAGED_SECTION_STATES as readonly unknown[]).includes(value.state)) {
    fail("MANAGED_SECTION_RECORD_INVALID", `the managed-section record ${key} has an invalid field`, { key });
  }
  if (key !== managedSectionRecordKey(value.file, value.id)) {
    fail("MANAGED_SECTION_RECORD_INVALID", `a managed-section record is keyed <file>#<id>; ${key} holds ${value.file}#${value.id}`, { key });
  }
}

/** The managed-section records a merged state holds for one file of the project. */
export function managedSectionRecordsFor(state: { readonly configRecords: readonly ConfigRecord[] }, file: string): readonly ManagedSectionRecord[] {
  return state.configRecords
    .filter((record) => record.collection === "managed-section" && record.value.file === file)
    .map((record) => record.value as unknown as ManagedSectionRecord);
}

async function readManagedFile(filePath: string, file: string): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("MANAGED_SECTION_FILE_UNSUPPORTED", `${file} is not a regular file; managed sections are written into regular files only`, { file });
  }
  const bytes = await readFile(filePath);
  if (!isUtf8(bytes)) fail("MANAGED_SECTION_FILE_UNSUPPORTED", `${file} is not UTF-8 text`, { file });
  return bytes.toString("utf8");
}

function sameRecord(left: ManagedSectionRecord | undefined, right: ManagedSectionRecord): boolean {
  return left !== undefined && left.file === right.file && left.id === right.id && left.rev === right.rev && left.digest === right.digest && left.state === right.state;
}

/**
 * Decide, section by section, what rendering `desired` into the file would do, without writing:
 * create a section that was never written, replace one whose three digests agree, leave alone
 * (pending) one the user changed, and keep one whose markers are gone out of the file (removed).
 * A section the user kept or asked to stop managing is never written. `records` are the
 * library's managed-section records; those of other files are ignored.
 */
export async function planManagedWrite(input: {
  readonly filePath: string;
  readonly file?: string;
  readonly desired: readonly { readonly id: string; readonly body: string }[];
  readonly records: readonly ManagedSectionRecord[];
}): Promise<ManagedWritePlan> {
  const file = input.file ?? basename(input.filePath);
  if (!isRelativeFileName(file)) fail("MANAGED_SECTION_INPUT_INVALID", `${file} is not a file name relative to the project`, { file });
  const desired = new Map<string, string>();
  for (const section of input.desired) {
    if (!isManagedSectionId(section.id)) fail("MANAGED_SECTION_INPUT_INVALID", `${String(section.id)} is not a section id`, { file, id: String(section.id) });
    if (desired.has(section.id)) fail("MANAGED_SECTION_INPUT_INVALID", `section ${section.id} is asked for twice`, { file, id: section.id });
    const line = absolutePathLine(section.body);
    if (line !== null) {
      fail("MANAGED_SECTION_ABSOLUTE_PATH", `section ${section.id} would write an absolute path (its line ${line}); managed sections render none`, { file, id: section.id, line: String(line) });
    }
    desired.set(section.id, normalizeSectionBody(section.body));
  }
  const records = new Map(input.records.filter((record) => record.file === file).map((record) => [record.id, record]));
  const before = await readManagedFile(input.filePath, file);
  const parsed = before === null ? null : parseManagedFile(before, file);
  const inFile = new Map((parsed?.sections ?? []).map((section) => [section.id, section]));
  const eol = parsed?.eol ?? "\n";

  const decisions: ManagedSectionDecision[] = [];
  const rendered = new Map<string, string>();
  const created: string[] = [];
  const decide = (id: string, result: ManagedSectionResult, record: ManagedSectionRecord, line: number | null): void => {
    decisions.push({ id, result, record, recordChanged: !sameRecord(records.get(id), record), line });
  };
  const order = [
    ...(parsed?.sections ?? []).map((section) => section.id),
    ...[...desired.keys()].filter((id) => !inFile.has(id)),
    ...[...records.keys()].filter((id) => !inFile.has(id) && !desired.has(id)).sort(),
  ];
  for (const id of order) {
    const section = inFile.get(id);
    const record = records.get(id);
    const body = desired.get(id);
    if (section !== undefined) {
      if (record?.state === "user-owned" || record?.state === "unmanaged") {
        decide(id, "unchanged", record, section.startLine);
        continue;
      }
      const agree = section.digest === section.bodyDigest && (record === undefined || record.digest === section.digest);
      if (!agree) {
        decide(id, "refused-user-modified", { file, id, rev: record?.rev ?? section.rev, digest: record?.digest ?? section.digest, state: "pending" }, section.startLine);
        continue;
      }
      if (body === undefined || sectionDigest(body) === section.bodyDigest) {
        decide(id, "unchanged", { file, id, rev: section.rev, digest: section.digest, state: "managed" }, section.startLine);
        continue;
      }
      const rev = Math.max(section.rev, record?.rev ?? 0) + 1;
      rendered.set(id, renderSection({ id, rev, body }, eol));
      decide(id, "replace", { file, id, rev, digest: sectionDigest(body), state: "managed" }, section.startLine);
      continue;
    }
    if (record !== undefined) {
      // The markers are gone: the user removed the section, or asked the engine to stop managing
      // it. Neither is put back.
      decide(id, record.state === "unmanaged" ? "unchanged" : "removed", { ...record, state: record.state === "unmanaged" ? "unmanaged" : "removed" }, null);
      continue;
    }
    if (body !== undefined) {
      rendered.set(id, renderSection({ id, rev: 1, body }, eol));
      created.push(id);
      decide(id, "create", { file, id, rev: 1, digest: sectionDigest(body), state: "managed" }, null);
    }
  }

  const write = decisions.some((decision) => decision.result === "create" || decision.result === "replace");
  let after: string | null = null;
  if (write) {
    let text = parsed === null ? "" : parsed.outside[0] ?? "";
    for (const [index, section] of (parsed?.sections ?? []).entries()) {
      text += rendered.get(section.id) ?? section.raw;
      text += parsed?.outside[index + 1] ?? "";
    }
    for (const id of created) {
      if (text !== "" && !text.endsWith("\n")) text += eol;
      if (text !== "" && !text.endsWith(`${eol}${eol}`)) text += eol;
      text += rendered.get(id) ?? "";
    }
    after = text;
  }
  return {
    filePath: input.filePath,
    file,
    exists: before !== null,
    before,
    after,
    write,
    sections: decisions,
    pending: decisions.filter((decision) => decision.result === "refused-user-modified").map((decision) => decision.id),
  };
}

// The UTC second as a directory name that is legal everywhere: 20260926T100000Z.
function utcStamp(at: string): string {
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
 * Write a plan: the file must still hold what was planned; an existing file is first copied to
 * backups/<UTC second>/managed-sections/<directory digest>/<file> under `backupRoot` (the device
 * directory's backups by default; an earlier copy there is kept), then replaced atomically
 * through a temporary file and a rename.
 */
export async function applyManagedWrite(plan: ManagedWritePlan, options: { readonly now: string; readonly backupRoot?: string }): Promise<AppliedManagedWrite> {
  const stamp = utcStamp(options.now);
  if (!plan.write || plan.after === null) return { filePath: plan.filePath, written: false, backupPath: null };
  const current = await readManagedFile(plan.filePath, plan.file);
  if (current !== plan.before) {
    fail("MANAGED_SECTION_CHANGED_SINCE_PLAN", `${plan.file} changed after the write was planned`, { file: plan.file });
  }
  let backupPath: string | null = null;
  if (plan.before !== null) {
    backupPath = join(options.backupRoot ?? backupsPath(), stamp, "managed-sections",
      createHash("sha256").update(dirname(plan.filePath)).digest("hex").slice(0, 16), plan.file);
    if (!await exists(backupPath)) {
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFileAtomic(backupPath, plan.before);
    }
  }
  await writeFileAtomic(plan.filePath, plan.after);
  return { filePath: plan.filePath, written: true, backupPath };
}
