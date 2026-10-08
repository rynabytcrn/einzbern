import { localProbeTimeout } from "./io-policy.js";
import { materializeWorkspace } from "./workspace.js";
import { chainIdentity } from "./chain-identity.js";
import { projectLineage } from "./project-scope.js";
// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-STORY-470 R1, AC1 (MIN-227 D19): this device's registry of libraries,
// registry.json in the device directory. It maps a project directory (and the project's Git
// remote) to the library that holds its records, so a command run anywhere in a project finds
// the library without being told. Nothing is written into the project: the registry is the only
// pointer, and it stays on this device.
//
// Resolution from a directory, in order: (1) the directory or its nearest ancestor that is a
// registered project; (2) the Git working tree's top level, when it is a registered project;
// (3) the working tree's remote (origin first), when a registered project has the same remote,
// which is how a second clone of the project finds the same library; otherwise
// LIBRARY_NOT_REGISTERED. The library found must still carry the id the registry recorded, or
// the answer is LIBRARY_REGISTRY_MISMATCH rather than another project's library.
//
// TCRN-CROSS-STORY-489 R2, R4 (TCRN-CROSS-SUB-365): an entry setup --mode migrate writes also
// carries migratedFrom, the real path of the old-layout workspace its library was imported from.
// That field is the old path's tombstone: nothing is written into the old workspace, and a write
// aimed at it is refused with the library it moved to (workspace.ts, LEGACY_WORKSPACE_MIGRATED).
// An entry without it reads as before, and one that has it keeps it when its project is registered
// to the same library again.

import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { withFileLock } from "./file-lock.js";
import { writeFileAtomic } from "./atomic-file.js";
import { ensureDeviceDirectory, registryPath } from "./device-home.js";
import { openLibrary } from "./ether-library.js";
import { suggestCloudHosted } from "./cloud-roots.js";

export const REGISTRY_SCHEMA_VERSION = "einzbern.registry.v1" as const;
export const REGISTRY_REASON_CODES = Object.freeze([
  "LIBRARY_NOT_REGISTERED",
  "LIBRARY_REGISTRY_INVALID",
  "LIBRARY_REGISTRY_MISMATCH",
] as const);
export type RegistryReasonCode = typeof REGISTRY_REASON_CODES[number];

export class RegistryError extends Error {
  readonly reasonCode: RegistryReasonCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(reasonCode: RegistryReasonCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "RegistryError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface RegistryEntry {
  readonly chainRole?: "project" | "coordination";
  readonly projectPath: string;
  readonly projectId?: string;
  readonly gitRemote: string | null;
  readonly libraryPath: string;
  readonly libraryId: string;
  readonly cloudHosted: boolean;
  readonly registeredAt: string;
  // The old-layout workspace the library was migrated from (its real path); absent on an entry
  // that no migration wrote.
  readonly migratedFrom?: string;
}

export interface Registry {
  readonly schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  readonly entries: readonly RegistryEntry[];
}

export type ResolutionPath = "project-path" | "git-toplevel" | "git-remote";

export interface ResolvedLibrary {
  readonly entry: RegistryEntry;
  readonly via: ResolutionPath;
  readonly libraryPath: string;
  readonly libraryId: string;
}

function fail(reasonCode: RegistryReasonCode, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new RegistryError(reasonCode, message, details);
}

const ENTRY_FIELDS = ["cloudHosted", "gitRemote", "libraryId", "libraryPath", "projectPath", "registeredAt"];
// A migrated entry has the same fields and migratedFrom (TCRN-CROSS-STORY-489 R2).
const MIGRATED_ENTRY_FIELDS = [...ENTRY_FIELDS, "migratedFrom"].sort();

function isMigratedFrom(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\u0000") && isAbsolute(value);
}

function registryEntry(value: unknown, where: string): RegistryEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("LIBRARY_REGISTRY_INVALID", `${where} is not an object`);
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record).filter((key) => key !== "projectId" && key !== "chainRole").sort().join("\u0000");
  if (Object.hasOwn(record, "projectId") && (typeof record.projectId !== "string" || !/^project:[a-f0-9]{24}$/u.test(record.projectId))) fail("LIBRARY_REGISTRY_INVALID", "projectId must be a stable project identity");
  if (fields !== ENTRY_FIELDS.join("\u0000") && fields !== MIGRATED_ENTRY_FIELDS.join("\u0000")) fail("LIBRARY_REGISTRY_INVALID", `${where} fields are not exact`);
  const { projectPath, gitRemote, libraryPath, libraryId, cloudHosted, registeredAt, migratedFrom, projectId, chainRole } = record;
  if (chainRole !== undefined && chainRole !== "project" && chainRole !== "coordination") fail("LIBRARY_REGISTRY_INVALID", "invalid registered chain role");
  if (typeof projectPath !== "string" || typeof libraryPath !== "string" || typeof libraryId !== "string" || typeof registeredAt !== "string" ||
    typeof cloudHosted !== "boolean" || !(gitRemote === null || typeof gitRemote === "string") ||
    (migratedFrom !== undefined && !isMigratedFrom(migratedFrom))) {
    fail("LIBRARY_REGISTRY_INVALID", `${where} types are invalid`);
  }
  return { projectPath, gitRemote, libraryPath, libraryId, cloudHosted, registeredAt, ...(chainRole === undefined ? {} : { chainRole }), ...(typeof projectId === "string" ? { projectId } : {}), ...(migratedFrom === undefined ? {} : { migratedFrom }) };
}

/** This device's registry; an absent file is an empty registry, a damaged one fails closed. */
export async function readRegistry(home?: string): Promise<Registry> {
  const path = home === undefined ? registryPath() : registryPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { schemaVersion: REGISTRY_SCHEMA_VERSION, entries: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("LIBRARY_REGISTRY_INVALID", `${path} is not JSON`, { file: path });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    (value as Readonly<Record<string, unknown>>).schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !Array.isArray((value as Readonly<Record<string, unknown>>).entries)) {
    fail("LIBRARY_REGISTRY_INVALID", `${path} is not an ${REGISTRY_SCHEMA_VERSION} registry`, { file: path });
  }
  const entries = ((value as { readonly entries: readonly unknown[] }).entries).map((entry, index) => registryEntry(entry, `${path} entries[${index}]`));
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, entries };
}

async function writeRegistry(registry: Registry, home?: string): Promise<void> {
  const path = home === undefined ? registryPath() : registryPath(home);
  await ensureDeviceDirectory(dirname(path));
  const entries = [...registry.entries].sort((left, right) => (left.projectPath < right.projectPath ? -1 : left.projectPath > right.projectPath ? 1 : 0));
  await writeFileAtomic(path, canonicalJson({ schemaVersion: REGISTRY_SCHEMA_VERSION, entries } as unknown as JsonValue));
}

/** Serialize the whole read/modify/replace transaction, not just publication.
 * Capture the device path once so every read and write uses the locked registry. */
async function mutateRegistry<T>(home: string | undefined, operation: (registry: Registry, home: string) => Promise<T>): Promise<T> {
  const path = home === undefined ? registryPath() : registryPath(home);
  const directory = dirname(path);
  await ensureDeviceDirectory(directory);
  return withFileLock(`${path}.lock`, async () => operation(await readRegistry(directory), directory));
}

/**
 * One remote in one spelling, so an https and an ssh clone of the same repository compare
 * equal: no scheme, user or trailing .git or slash, the host in lower case, and host and path
 * joined by a slash.
 */
export function normalizeGitRemote(remote: string): string {
  let value = remote.trim();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  value = value.replace(/^[^@/]+@/u, "");
  // scp-like ssh: host:owner/repo
  value = value.replace(/^([^/:]+):(?!\d+\/)/u, "$1/");
  value = value.replace(/^([^/:]+):\d+\//u, "$1/");
  value = value.replace(/\/+$/u, "").replace(/\.git$/iu, "").replace(/\/+$/u, "");
  const slash = value.indexOf("/");
  return slash < 0 ? value.toLowerCase() : `${value.slice(0, slash).toLowerCase()}${value.slice(slash)}`;
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: localProbeTimeout(5_000) }).trim();
  } catch {
    return null;
  }
}

/** The Git working tree's top level at `cwd`, or null outside one (or without git). */
export function gitTopLevel(cwd: string): string | null {
  const value = git(cwd, ["rev-parse", "--show-toplevel"]);
  return value === null || value === "" ? null : value;
}

/** The working tree's remote URL, origin first, or null when it has none. */
export function gitRemoteOf(cwd: string): string | null {
  const names = (git(cwd, ["remote"]) ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
  const name = names.includes("origin") ? "origin" : names.sort()[0];
  if (name === undefined) return null;
  const url = git(cwd, ["remote", "get-url", name]);
  return url === null || url === "" ? null : url;
}

async function real(path: string): Promise<string> {
  return realpath(resolve(path));
}

export interface RegisterLibraryInput {
  readonly projectPath: string;
  readonly projectId?: string;
  readonly libraryPath: string;
  readonly registeredAt: string;
  // The user's flag (TCRN-CROSS-STORY-470 R2); left out, it is what the cloud folder table suggests.
  readonly cloudHosted?: boolean;
  // The project's remote; when left out it is read from the project's working tree, if any.
  readonly gitRemote?: string | null;
  // The old-layout workspace the library was migrated from (TCRN-CROSS-STORY-489 R2), an absolute
  // path. Left out, an entry the project already has for the same library keeps its own.
  readonly migratedFrom?: string;
}

/** Record that the project at `projectPath` keeps its records in the library at `libraryPath`. */
export async function registerLibrary(input: RegisterLibraryInput, home?: string): Promise<RegistryEntry> {
  assertStrictInstant(input.registeredAt);
  if (input.migratedFrom !== undefined && !isMigratedFrom(input.migratedFrom)) {
    // The registry would not read again with such an entry, so it is never written.
    fail("LIBRARY_REGISTRY_INVALID", "migratedFrom must be an absolute path", { field: "migratedFrom" });
  }
  const projectPath = await real(input.projectPath);
  const library = await openLibrary(await real(input.libraryPath));
  const remote = input.gitRemote === undefined ? gitRemoteOf(projectPath) : input.gitRemote;
  return mutateRegistry(home, async (registry, directory) => {
    const previous = registry.entries.find((candidate) => candidate.projectPath === projectPath);
    const migratedFrom = input.migratedFrom === undefined
      ? (previous?.libraryId === library.manifest.libraryId ? previous.migratedFrom : undefined)
      : resolve(input.migratedFrom);
    const projectId = input.projectId ?? (previous?.libraryId === library.manifest.libraryId ? previous.projectId : undefined);
    const state = await materializeWorkspace(library.root);
    if (projectId !== undefined) projectLineage(state, projectId);
    const role = chainIdentity(state)?.role;
    const entry: RegistryEntry = {
      ...(role === undefined ? {} : { chainRole: role }),
      projectPath,
      ...(projectId === undefined ? {} : { projectId }),
      gitRemote: remote === null ? null : normalizeGitRemote(remote),
      libraryPath: library.root,
      libraryId: library.manifest.libraryId,
      cloudHosted: input.cloudHosted ?? suggestCloudHosted(library.root),
      registeredAt: input.registeredAt,
      ...(migratedFrom === undefined ? {} : { migratedFrom }),
    };
    await writeRegistry({ ...registry, entries: [...registry.entries.filter((candidate) => candidate.projectPath !== projectPath), entry] }, directory);
    return entry;
  });
}

/**
 * The entry whose library was migrated from the old-layout workspace at `legacyRoot` (its real
 * path), or null when this device migrated nothing from there (TCRN-CROSS-STORY-489 R4). With two,
 * the first in the registry's order (by project path) answers.
 */
export async function findMigratedEntry(legacyRoot: string, home?: string): Promise<RegistryEntry | null> {
  const wanted = resolve(legacyRoot);
  return (await readRegistry(home)).entries.find((entry) => entry.migratedFrom === wanted) ?? null;
}

/** Drop the project's entry; false when it had none. */
export async function unregisterLibrary(projectPathInput: string, home?: string): Promise<boolean> {
  const projectPath = await real(projectPathInput);
  return mutateRegistry(home, async (registry, directory) => {
    const entries = registry.entries.filter((entry) => entry.projectPath !== projectPath);
    if (entries.length === registry.entries.length) return false;
    await writeRegistry({ ...registry, entries }, directory);
    return true;
  });
}

/** Point an entry at the library's new location (a relocation moved it). */
export async function repointLibrary(libraryId: string, libraryPath: string, cloudHosted: boolean | undefined, home?: string): Promise<readonly RegistryEntry[]> {
  const target = await real(libraryPath);
  return mutateRegistry(home, async (registry, directory) => {
    const entries = registry.entries.map((entry) => (entry.libraryId === libraryId
      ? { ...entry, libraryPath: target, ...(cloudHosted === undefined ? {} : { cloudHosted }) }
      : entry));
    await writeRegistry({ ...registry, entries }, directory);
    return entries.filter((entry) => entry.libraryId === libraryId);
  });
}

function ancestors(path: string): readonly string[] {
  const chain: string[] = [];
  let current = path;
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * The library the registry resolves from `cwd`, checked against the library's own id. The refusal
 * for a directory no entry holds names library-register, and names --workspace as the other way
 * only when the caller's verb takes that flag (`workspaceFlag`): agents-render, the rule verbs and
 * library-resolve do not (TCRN-CROSS-SUB-427). Its reason code and details are the same either way.
 */
export async function resolveLibrary(cwdInput: string, home?: string, options: { readonly workspaceFlag?: boolean } = {}): Promise<ResolvedLibrary> {
  const registry = await readRegistry(home);
  const cwd = await real(cwdInput);
  let found: { readonly entry: RegistryEntry; readonly via: ResolutionPath } | null = null;
  for (const candidate of ancestors(cwd)) {
    const entry = registry.entries.find((item) => item.projectPath === candidate);
    if (entry !== undefined) {
      found = { entry, via: "project-path" };
      break;
    }
  }
  if (found === null && registry.entries.length > 0) {
    const top = gitTopLevel(cwd);
    const topReal = top === null ? null : await real(top).catch(() => null);
    const entry = topReal === null ? undefined : registry.entries.find((item) => item.projectPath === topReal);
    if (entry !== undefined) found = { entry, via: "git-toplevel" };
  }
  if (found === null && registry.entries.some((item) => item.gitRemote !== null)) {
    const remote = gitRemoteOf(cwd);
    const normalized = remote === null ? null : normalizeGitRemote(remote);
    const entry = normalized === null ? undefined : registry.entries.find((item) => item.gitRemote === normalized);
    if (entry !== undefined) found = { entry, via: "git-remote" };
  }
  if (found === null) {
    const otherWay = options.workspaceFlag === true ? ", or pass --workspace" : "";
    fail("LIBRARY_NOT_REGISTERED", `no library is registered for ${cwd} on this device (register one with library-register${otherWay})`, {
      cwd,
      remedy: "library-register",
    });
  }
  const library = await openLibrary(found.entry.libraryPath);
  if (library.manifest.libraryId !== found.entry.libraryId) {
    fail("LIBRARY_REGISTRY_MISMATCH", `${found.entry.libraryPath} holds ${library.manifest.libraryId}, not the registered ${found.entry.libraryId}`, {
      library: found.entry.libraryPath,
      remedy: "library-register",
    });
  }
  return { entry: found.entry, via: found.via, libraryPath: library.root, libraryId: library.manifest.libraryId };
}
