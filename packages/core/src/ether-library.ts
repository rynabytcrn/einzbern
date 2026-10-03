import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-469 R1, R6 (MIN-227 D19, D21): a library, the `.ether` directory that holds
// one project's records. Its root has exactly seven entries:
//
//   manifest.json   static library identity, format, minimum engine version, project hint and
//                   creation time; one controlled writer replaces it only at creation, format
//                   upgrade or migration. Ordinary event append and merge never write it.
//   akasha/         one directory per device, each written by that device alone
//   crest/          the knowledge store
//   config/         a readable projection of the project-level settings
//   artifacts/      content-addressed files
//   README.md       what every name here means, and the old names
//   .gitignore      `*`, so a library inside a Git working tree never shows in `git status`
//
// Streams are found by listing akasha/, not from the root manifest, so the root manifest keeps
// its single-writer contract and carries no per-stream digest. Paths inside a library are short,
// relative and lowercase; text is LF; nothing depends on permission bits.

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import { writeFileAtomic } from "./atomic-file.js";
import { ENGINE_FORMAT_VERSION, assertLibrarySupported } from "./format-version.js";
import type { LibraryVersionFields } from "./format-version.js";
import { DIRECTORY, renderLibraryReadme } from "./names.js";
import { FRAMEWORK_VERSION } from "./index.js";

export const LIBRARY_MANIFEST_SCHEMA_VERSION = "einzbern.library-manifest.v1" as const;
// The format a new library and every stream manifest is written in: the newest this engine reads
// (TCRN-CROSS-STORY-471 R1). format-version.ts imports nothing, so this is safe at load.
export const LIBRARY_FORMAT_VERSION = ENGINE_FORMAT_VERSION;
export const LIBRARY_FILES = Object.freeze({
  manifest: "manifest.json",
  readme: "README.md",
  gitignore: ".gitignore",
} as const);
export const LIBRARY_GITIGNORE = "*\n" as const;
/** The root of a new library, sorted: exactly these and nothing else. */
export const LIBRARY_ROOT_ENTRIES: readonly string[] = Object.freeze([
  LIBRARY_FILES.gitignore,
  LIBRARY_FILES.readme,
  DIRECTORY.events,
  DIRECTORY.artifacts,
  DIRECTORY.projectConfig,
  DIRECTORY.knowledge,
  LIBRARY_FILES.manifest,
].sort());

export const LIBRARY_REASON_CODES = Object.freeze([
  "LIBRARY_MANIFEST_INVALID",
  "LIBRARY_NOT_FOUND",
  "LIBRARY_TARGET_INVALID",
  "LIBRARY_TARGET_NOT_EMPTY",
] as const);
export type LibraryReasonCode = typeof LIBRARY_REASON_CODES[number];

export class LibraryError extends Error {
  readonly reasonCode: LibraryReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: LibraryReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "LibraryError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface LibraryProjectHint {
  readonly name: string | null;
  readonly gitRemote: string | null;
}

export interface LibraryManifest {
  readonly schemaVersion: typeof LIBRARY_MANIFEST_SCHEMA_VERSION;
  readonly libraryId: string;
  readonly formatVersion: number;
  readonly minEngineVersion: string;
  readonly project: LibraryProjectHint;
  readonly createdAt: string;
}

export interface Library {
  readonly root: string;
  readonly manifest: LibraryManifest;
}

const MANIFEST_FIELDS = ["createdAt", "formatVersion", "libraryId", "minEngineVersion", "project", "schemaVersion"];
const PROJECT_FIELDS = ["gitRemote", "name"];
// `library:` for a library created here, `workspace:` for one imported from an old workspace,
// whose id it keeps.
export const LIBRARY_ID_PATTERN = /^(?:library|workspace):[a-f0-9]{24}$/u;
const ENGINE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const HINT_MAX_LENGTH = RUNTIME_CAPACITY.stringCodeUnits;

function fail(reasonCode: LibraryReasonCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new LibraryError(reasonCode, message, details);
}

function hint(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= HINT_MAX_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value));
}

export function validateLibraryManifest(value: unknown, where: string = LIBRARY_FILES.manifest): LibraryManifest {
  const invalid = (message: string): never => fail("LIBRARY_MANIFEST_INVALID", `${where}: ${message}`, { manifest: where });
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("not an object");
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join("\u0000") !== MANIFEST_FIELDS.join("\u0000")) invalid("fields are not exact");
  if (record.schemaVersion !== LIBRARY_MANIFEST_SCHEMA_VERSION) invalid(`schemaVersion must be ${LIBRARY_MANIFEST_SCHEMA_VERSION}`);
  if (typeof record.libraryId !== "string" || !LIBRARY_ID_PATTERN.test(record.libraryId)) invalid("libraryId is not a library id");
  if (!Number.isSafeInteger(record.formatVersion) || Number(record.formatVersion) < 1) invalid("formatVersion must be a positive integer");
  if (typeof record.minEngineVersion !== "string" || !ENGINE_VERSION_PATTERN.test(record.minEngineVersion)) invalid("minEngineVersion must be a version");
  const project = record.project;
  if (project === null || typeof project !== "object" || Array.isArray(project) ||
    Object.keys(project).sort().join("\u0000") !== PROJECT_FIELDS.join("\u0000")) {
    invalid("project must carry exactly name and gitRemote");
  }
  const projectRecord = project as Readonly<Record<string, unknown>>;
  if (!hint(projectRecord.name) || !hint(projectRecord.gitRemote)) invalid("project name and gitRemote are bounded single-line text or null");
  try {
    assertStrictInstant(record.createdAt);
  } catch {
    invalid("createdAt must be a strict instant");
  }
  return Object.freeze({
    schemaVersion: LIBRARY_MANIFEST_SCHEMA_VERSION,
    libraryId: String(record.libraryId),
    formatVersion: Number(record.formatVersion),
    minEngineVersion: String(record.minEngineVersion),
    project: Object.freeze({ name: projectRecord.name as string | null, gitRemote: projectRecord.gitRemote as string | null }),
    createdAt: String(record.createdAt),
  });
}

/** Whether `root` holds a library manifest (it is not validated here). */
export async function hasLibraryManifest(root: string): Promise<boolean> {
  try {
    return (await lstat(join(resolve(root), LIBRARY_FILES.manifest))).isFile();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

// TCRN-CROSS-STORY-470 R2, AC5: a library reached through a symbolic link (a cloud folder often
// is one) is its real path; a path that does not exist yet is kept as given.
export async function realLibraryPath(rootInput: string): Promise<string> {
  const given = resolve(rootInput);
  try {
    return await realpath(given);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return given;
    throw error;
  }
}

interface ManifestRead {
  readonly root: string;
  readonly path: string;
  readonly text: string;
  readonly parsed: unknown;
}

async function readManifest(rootInput: string): Promise<ManifestRead> {
  const root = await realLibraryPath(rootInput);
  const path = join(root, LIBRARY_FILES.manifest);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") fail("LIBRARY_NOT_FOUND", `${root} is not a library`, { library: root });
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("LIBRARY_MANIFEST_INVALID", `${path} is not JSON`, { manifest: path });
  }
  return { root, path, text, parsed };
}

function versionFields(parsed: unknown): LibraryVersionFields | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Readonly<Record<string, unknown>>;
  return { formatVersion: record.formatVersion, minEngineVersion: record.minEngineVersion };
}

/**
 * Read and validate a library's root manifest. Nothing is created or written. A library in a
 * newer format than this engine reads, or one that needs a newer engine, is refused first
 * (TCRN-CROSS-STORY-471 R1): every read, lock and write of a library begins here, so the refusal
 * comes before any of them, and before the rest of the manifest is judged.
 */
export async function openLibrary(rootInput: string): Promise<Library> {
  const { root, path, text, parsed } = await readManifest(rootInput);
  const fields = versionFields(parsed);
  if (fields !== null) assertLibrarySupported(fields, { engineVersion: FRAMEWORK_VERSION, where: `library ${root}` });
  const manifest = validateLibraryManifest(parsed, path);
  if (canonicalJson(manifest) !== text) fail("LIBRARY_MANIFEST_INVALID", `${path} is not in canonical form`, { manifest: path });
  return { root, manifest };
}

/**
 * The two fields another engine version is judged by, read as they stand and nothing else judged
 * (TCRN-CROSS-STORY-471 R3): whether an engine opens a library is a question about that engine,
 * which may read a newer manifest than this one does.
 */
export async function readLibraryVersionFields(rootInput: string): Promise<LibraryVersionFields & { readonly root: string }> {
  const { root, path, parsed } = await readManifest(rootInput);
  const fields = versionFields(parsed);
  if (fields === null) fail("LIBRARY_MANIFEST_INVALID", `${path} is not an object`, { manifest: path });
  return { root, ...fields };
}

export interface CreateLibraryOptions {
  readonly createdAt: string;
  readonly projectName?: string | null;
  readonly gitRemote?: string | null;
  // An imported old workspace keeps its id; a new library draws one.
  readonly libraryId?: string;
}

/** A fresh library id: `library:` and 24 random lowercase hex digits. */
export function newLibraryId(): string {
  return `library:${randomBytes(12).toString("hex")}`;
}

/**
 * Create a library at `root`, which must not exist or be an empty directory. The manifest is
 * written last: a directory without one is not a library, so a creation that stops half-way
 * leaves nothing that opens.
 */
export async function createLibrary(rootInput: string, options: CreateLibraryOptions): Promise<Library> {
  let root = await realLibraryPath(rootInput);
  assertStrictInstant(options.createdAt);
  const libraryId = options.libraryId ?? newLibraryId();
  if (!LIBRARY_ID_PATTERN.test(libraryId)) fail("LIBRARY_MANIFEST_INVALID", `${libraryId} is not a library id`);
  const project = { name: options.projectName ?? null, gitRemote: options.gitRemote ?? null };
  if (!hint(project.name) || !hint(project.gitRemote)) fail("LIBRARY_MANIFEST_INVALID", "project name and gitRemote are bounded single-line text or null");
  let existing;
  try {
    existing = await lstat(root);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("LIBRARY_TARGET_INVALID", `${root} is not a directory`, { target: root });
    if ((await readdir(root)).length > 0) fail("LIBRARY_TARGET_NOT_EMPTY", `${root} is not empty`, { target: root });
  } else {
    await mkdir(root, { recursive: true });
    // Created through a symbolically linked parent, the library is its real path.
    root = await realpath(root);
  }
  for (const directory of [DIRECTORY.events, DIRECTORY.knowledge, DIRECTORY.projectConfig, DIRECTORY.artifacts]) {
    await mkdir(join(root, directory));
  }
  await writeFileAtomic(join(root, LIBRARY_FILES.readme), renderLibraryReadme());
  await writeFileAtomic(join(root, LIBRARY_FILES.gitignore), LIBRARY_GITIGNORE);
  const manifest: LibraryManifest = validateLibraryManifest({
    schemaVersion: LIBRARY_MANIFEST_SCHEMA_VERSION,
    libraryId,
    formatVersion: LIBRARY_FORMAT_VERSION,
    minEngineVersion: FRAMEWORK_VERSION,
    project,
    createdAt: options.createdAt,
  });
  await writeFileAtomic(join(root, LIBRARY_FILES.manifest), canonicalJson(manifest));
  return { root, manifest };
}
