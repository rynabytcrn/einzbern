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

import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertStrictInstant, canonicalJson } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
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
  readonly projectPath: string;
  readonly gitRemote: string | null;
  readonly libraryPath: string;
  readonly libraryId: string;
  readonly cloudHosted: boolean;
  readonly registeredAt: string;
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

function registryEntry(value: unknown, where: string): RegistryEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("LIBRARY_REGISTRY_INVALID", `${where} is not an object`);
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).sort().join("\u0000") !== ENTRY_FIELDS.join("\u0000")) fail("LIBRARY_REGISTRY_INVALID", `${where} fields are not exact`);
  const { projectPath, gitRemote, libraryPath, libraryId, cloudHosted, registeredAt } = record;
  if (typeof projectPath !== "string" || typeof libraryPath !== "string" || typeof libraryId !== "string" || typeof registeredAt !== "string" ||
    typeof cloudHosted !== "boolean" || !(gitRemote === null || typeof gitRemote === "string")) {
    fail("LIBRARY_REGISTRY_INVALID", `${where} types are invalid`);
  }
  return { projectPath, gitRemote, libraryPath, libraryId, cloudHosted, registeredAt };
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
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
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
  readonly libraryPath: string;
  readonly registeredAt: string;
  // The user's flag (TCRN-CROSS-STORY-470 R2); left out, it is what the cloud folder table suggests.
  readonly cloudHosted?: boolean;
  // The project's remote; when left out it is read from the project's working tree, if any.
  readonly gitRemote?: string | null;
}

/** Record that the project at `projectPath` keeps its records in the library at `libraryPath`. */
export async function registerLibrary(input: RegisterLibraryInput, home?: string): Promise<RegistryEntry> {
  assertStrictInstant(input.registeredAt);
  const projectPath = await real(input.projectPath);
  const library = await openLibrary(await real(input.libraryPath));
  const remote = input.gitRemote === undefined ? gitRemoteOf(projectPath) : input.gitRemote;
  const entry: RegistryEntry = {
    projectPath,
    gitRemote: remote === null ? null : normalizeGitRemote(remote),
    libraryPath: library.root,
    libraryId: library.manifest.libraryId,
    cloudHosted: input.cloudHosted ?? suggestCloudHosted(library.root),
    registeredAt: input.registeredAt,
  };
  const registry = await readRegistry(home);
  await writeRegistry({ ...registry, entries: [...registry.entries.filter((candidate) => candidate.projectPath !== projectPath), entry] }, home);
  return entry;
}

/** Drop the project's entry; false when it had none. */
export async function unregisterLibrary(projectPathInput: string, home?: string): Promise<boolean> {
  const projectPath = await real(projectPathInput);
  const registry = await readRegistry(home);
  const entries = registry.entries.filter((entry) => entry.projectPath !== projectPath);
  if (entries.length === registry.entries.length) return false;
  await writeRegistry({ ...registry, entries }, home);
  return true;
}

/** Point an entry at the library's new location (a relocation moved it). */
export async function repointLibrary(libraryId: string, libraryPath: string, cloudHosted: boolean | undefined, home?: string): Promise<readonly RegistryEntry[]> {
  const registry = await readRegistry(home);
  const target = await real(libraryPath);
  const entries = registry.entries.map((entry) => (entry.libraryId === libraryId
    ? { ...entry, libraryPath: target, ...(cloudHosted === undefined ? {} : { cloudHosted }) }
    : entry));
  await writeRegistry({ ...registry, entries }, home);
  return entries.filter((entry) => entry.libraryId === libraryId);
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

/** The library the registry resolves from `cwd`, checked against the library's own id. */
export async function resolveLibrary(cwdInput: string, home?: string): Promise<ResolvedLibrary> {
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
    fail("LIBRARY_NOT_REGISTERED", `no library is registered for ${cwd} on this device (register one with library-register, or pass --workspace)`, {
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
