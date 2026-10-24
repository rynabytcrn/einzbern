// SPDX-License-Identifier: Apache-2.0
// INIT068 R19: operation-local technical-reference verification, never a permission token.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { looksSecretShaped } from "./variables.js";
import { localProbeTimeout } from "./io-policy.js";
import type { DotExtensionSource } from "./dot-agents.js";

export interface DotTechnicalReference {
  readonly kind: "git-commit";
  readonly objectFormat: "sha1";
  readonly objectId: string;
  readonly repositoryKey: string;
  readonly occurrences: readonly { readonly target: string; readonly startByte: number; readonly endByte: number }[];
}
export interface DotSourceVerificationBindings {
  readonly gitExecutable: string;
  readonly scratchRoot: string;
  readonly repositories: readonly { readonly key: string; readonly root: string }[];
}
class DotSourceVerificationError extends Error {
  constructor(readonly reasonCode: string, message: string) { super(message); this.name = "DotSourceVerificationError"; }
}
function fail(code: string, message: string): never { throw new DotSourceVerificationError(code, message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail("DOT_SOURCE_REFERENCE_INVALID", "unknown or malformed technical-reference fields");
  return value as Record<string, unknown>;
}
const OID = /^[0-9a-f]{40}$/u;
const KEY = /^[a-z][a-z0-9-]*$/u;
export function parseDotTechnicalReferences(value: unknown): readonly DotTechnicalReference[] {
  if (!Array.isArray(value) || value.length === 0) fail("DOT_SOURCE_REFERENCE_INVALID", "technicalReferences must be nonempty");
  const keys = new Set<string>();
  return value.map((input: unknown): DotTechnicalReference => {
    const row = object(input, ["kind", "objectFormat", "objectId", "repositoryKey", "occurrences"]);
    if (row.kind !== "git-commit" || row.objectFormat !== "sha1" || typeof row.objectId !== "string" || !OID.test(row.objectId) || typeof row.repositoryKey !== "string" || !KEY.test(row.repositoryKey) || !Array.isArray(row.occurrences) || row.occurrences.length === 0) fail("DOT_SOURCE_REFERENCE_INVALID", "expected a full SHA-1 commit reference and exact occurrences");
    const key = `${row.repositoryKey}:${row.objectId}`;
    if (keys.has(key)) fail("DOT_SOURCE_REFERENCE_INVALID", "duplicate technical reference");
    keys.add(key);
    const occurrences = row.occurrences.map((input: unknown) => {
      const span = object(input, ["target", "startByte", "endByte"]);
      if (typeof span.target !== "string" || !/^(?:file|rule):[^\u0000-\u001f\u007f]+$/u.test(span.target) || !Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte) || (span.startByte as number) < 0 || (span.endByte as number) <= (span.startByte as number)) fail("DOT_SOURCE_REFERENCE_INVALID", "invalid UTF-8 occurrence span");
      return { target: span.target, startByte: span.startByte as number, endByte: span.endByte as number };
    });
    return { kind: "git-commit", objectFormat: "sha1", objectId: row.objectId, repositoryKey: row.repositoryKey, occurrences };
  });
}
function ordinary(text: string): void {
  if (looksSecretShaped(text) !== null) fail("DOT_SOURCE_SECRET_SHAPED", "source contains unclassified credential-shaped data");
}
/** Classification alone is NOT verification. All consuming operations must verify actual objects. */
export function checkDotExtensionDecodedPrivacy(source: DotExtensionSource): void {
  const references = source.technicalReferences === undefined ? [] : parseDotTechnicalReferences(source.technicalReferences);
  ordinary(source.sourceReference);
  for (const rule of source.rules) { ordinary(rule.id); ordinary(rule.sourceReference); }
  for (const file of source.files) { ordinary(file.path); ordinary(file.sourceReference); }
  for (const entry of source.entries) ordinary(entry);
  for (const ref of references) ordinary(ref.repositoryKey);
  const bodies = new Map<string, string>([
    ...source.rules.map(rule => [`rule:${rule.id}`, rule.body] as const),
    ...source.files.map(file => [`file:${file.path}`, file.body] as const),
  ]);
  const spans = new Map<string, { startByte: number; endByte: number; objectId: string }[]>();
  for (const ref of references) for (const span of ref.occurrences) {
    if (!bodies.has(span.target)) fail("DOT_SOURCE_REFERENCE_INVALID", "reference target is not a declared body");
    const rows = spans.get(span.target) ?? [];
    rows.push({ startByte: span.startByte, endByte: span.endByte, objectId: ref.objectId });
    spans.set(span.target, rows);
  }
  for (const [target, body] of bodies) {
    // Prefix/private-key/JWT checks run on original decoded text, before classification.
    const untouched = looksSecretShaped(body);
    if (untouched !== null && untouched !== "high-entropy") fail("DOT_SOURCE_SECRET_SHAPED", "credential prefix in original source");
    const bytes = Buffer.from(body, "utf8");
    const tokens = [...body.matchAll(/[^\s"'`,;:()[\]{}<>]+/gu)].map(match => ({
      start: Buffer.byteLength(body.slice(0, match.index), "utf8"),
      end: Buffer.byteLength(body.slice(0, match.index! + match[0].length), "utf8"),
      value: match[0],
    }));
    const selected = [...(spans.get(target) ?? [])].sort((a, b) => a.startByte - b.startByte);
    const parts: Buffer[] = []; let end = 0;
    for (const span of selected) {
      if (span.startByte < end || span.endByte > bytes.length || span.endByte - span.startByte !== 40 || bytes.subarray(span.startByte, span.endByte).toString("utf8") !== span.objectId || !tokens.some(token => token.start === span.startByte && token.end === span.endByte && token.value === span.objectId)) fail("DOT_SOURCE_REFERENCE_INVALID", "span must match one entire nonoverlapping UTF-8 opaque token");
      parts.push(bytes.subarray(end, span.startByte), Buffer.from("technical-reference"));
      end = span.endByte;
    }
    parts.push(bytes.subarray(end));
    ordinary(Buffer.concat(parts).toString("utf8"));
  }
}
export function parseDotSourceVerificationBindings(value: unknown): DotSourceVerificationBindings {
  const row = object(value, ["gitExecutable", "scratchRoot", "repositories"]);
  const absolute = (value: unknown): string => {
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail("DOT_SOURCE_BINDING_INVALID", "bindings require explicit normalized absolute paths");
    return value;
  };
  if (!Array.isArray(row.repositories)) fail("DOT_SOURCE_BINDING_INVALID", "explicit repository bindings required");
  const seen = new Set<string>();
  const repositories = row.repositories.map((input: unknown) => {
    const entry = object(input, ["key", "root"]);
    if (typeof entry.key !== "string" || !KEY.test(entry.key) || seen.has(entry.key)) fail("DOT_SOURCE_BINDING_INVALID", "repository keys must be unique logical names");
    seen.add(entry.key); return { key: entry.key, root: absolute(entry.root) };
  });
  return { gitExecutable: absolute(row.gitExecutable), scratchRoot: absolute(row.scratchRoot), repositories };
}
async function canonicalPath(path: string, directory: boolean): Promise<void> {
  try {
    let cursor = path;
    for (;;) {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (cursor === path ? directory ? !stat.isDirectory() : !stat.isFile() : !stat.isDirectory())) fail("DOT_SOURCE_BINDING_UNSUPPORTED", "binding contains unsupported path components");
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    if (await realpath(path) !== path) fail("DOT_SOURCE_BINDING_UNSUPPORTED", "binding is not canonical");
  } catch (error) {
    if (error instanceof DotSourceVerificationError) throw error;
    fail("DOT_SOURCE_BINDING_UNAVAILABLE", "explicit local binding is unavailable");
  }
}
async function objectStore(root: string): Promise<string> {
  await canonicalPath(root, true);
  const git = join(root, ".git"); await canonicalPath(git, true);
  const objects = join(git, "objects"); await canonicalPath(objects, true);
  // No source config is consumed. Reject indirection/promisor state rather than rely
  // on an environment flag being implemented by a particular installed Git.
  for (const entry of await readdir(objects, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !/^(?:[0-9a-f]{2}|pack|info)$/u.test(entry.name)) fail("DOT_SOURCE_BINDING_UNSUPPORTED", "unsupported object-store layout");
    const directory = join(objects, entry.name);
    await canonicalPath(directory, true);
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink() || /(?:^alternates$|^http-alternates$|\.promisor$)/u.test(file.name)) fail("DOT_SOURCE_BINDING_UNSUPPORTED", "alternates, partial-clone or indirect object stores are unsupported");
      await canonicalPath(join(directory, file.name), false);
    }
  }
  return objects;
}
const MAX_COMMIT_BYTES = 1024 * 1024; // bounded technical-evidence capability, not a work budget
function gitRead(executable: string, view: string, objects: string, args: readonly string[], maxBuffer: number): Buffer {
  try {
    return execFileSync(executable, ["--no-replace-objects", `--git-dir=${view}`, ...args], {
      cwd: view, encoding: "buffer", maxBuffer, timeout: localProbeTimeout(5_000),
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: dirname(executable), HOME: view, XDG_CONFIG_HOME: view,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(view, "empty-config"), GIT_CONFIG_SYSTEM: join(view, "empty-config"),
        GIT_OBJECT_DIRECTORY: objects, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
  } catch { fail("DOT_SOURCE_OBJECT_UNAVAILABLE", "local-only Git object read failed or exceeded its bounded capability"); }
}
/** No source repository config, refs, hooks, filters, inherited Git env or remotes are consumed. */
export async function verifyDotExtensionSource(source: DotExtensionSource, input: DotSourceVerificationBindings): Promise<void> {
  checkDotExtensionDecodedPrivacy(source);
  if (source.technicalReferences === undefined) return;
  const bindings = parseDotSourceVerificationBindings(input);
  await canonicalPath(bindings.gitExecutable, false); await canonicalPath(bindings.scratchRoot, true);
  const view = await mkdtemp(join(bindings.scratchRoot, "dot-object-view-"));
  try {
    await mkdir(join(view, "refs")); await mkdir(join(view, "objects"));
    await writeFile(join(view, "HEAD"), "ref: refs/heads/unborn\n", { mode: 0o600 });
    await writeFile(join(view, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n", { mode: 0o600 });
    await writeFile(join(view, "empty-config"), "", { mode: 0o600 });
    const version = gitRead(bindings.gitExecutable, view, join(view, "objects"), ["--version"], 1024).toString("utf8");
    const match = /^git version (\d+)\.(\d+)(?:\.|\s)/u.exec(version);
    if (match === null || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 30)) fail("DOT_SOURCE_GIT_UNSUPPORTED", "supported local Git plumbing requires Git 2.30 or newer");
    for (const reference of source.technicalReferences) {
      const binding = bindings.repositories.find(entry => entry.key === reference.repositoryKey);
      if (binding === undefined) fail("DOT_SOURCE_BINDING_INVALID", "logical repository has no operation-local binding");
      const objects = await objectStore(binding.root);
      const read = (args: readonly string[], max = 1024) => gitRead(bindings.gitExecutable, view, objects, args, max);
      if (read(["cat-file", "-t", reference.objectId]).toString("ascii") !== "commit\n") fail("DOT_SOURCE_OBJECT_INVALID", "reference does not identify an actual commit object");
      const sizeText = read(["cat-file", "-s", reference.objectId]).toString("ascii");
      if (!/^[0-9]+\n$/u.test(sizeText)) fail("DOT_SOURCE_OBJECT_INVALID", "invalid object size");
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_COMMIT_BYTES) fail("DOT_SOURCE_OBJECT_UNSUPPORTED", "commit exceeds the bounded technical-reference capability");
      const bytes = read(["cat-file", "commit", reference.objectId], MAX_COMMIT_BYTES + 1);
      if (bytes.length !== size || createHash("sha1").update(`commit ${size}\0`).update(bytes).digest("hex") !== reference.objectId) fail("DOT_SOURCE_OBJECT_INVALID", "raw commit length or cryptographic object identity differs");
      const split = bytes.indexOf(Buffer.from("\n\n"));
      if (split < 0 || bytes.includes(0)) fail("DOT_SOURCE_OBJECT_INVALID", "malformed commit headers");
      const headers = bytes.subarray(0, split).toString("latin1").split("\n");
      const tree = /^tree ([0-9a-f]{40})$/u.exec(headers[0] ?? "");
      let cursor = 1;
      while (/^parent [0-9a-f]{40}$/u.test(headers[cursor] ?? "")) cursor += 1;
      if (tree === null || !/^author [^\n<>]+ <[^\n<>]*> -?\d+ [+-]\d{4}$/u.test(headers[cursor++] ?? "") || !/^committer [^\n<>]+ <[^\n<>]*> -?\d+ [+-]\d{4}$/u.test(headers[cursor++] ?? "")) fail("DOT_SOURCE_OBJECT_INVALID", "commit lacks canonical tree/author/committer headers");
      let continuation = false;
      for (const header of headers.slice(cursor)) {
        if (header.startsWith(" ") && continuation) continue;
        if (!/^[a-z][a-z0-9-]* [^\n]*$/u.test(header) || /^(?:tree|parent|author|committer) /u.test(header)) fail("DOT_SOURCE_OBJECT_INVALID", "malformed or duplicate commit header");
        continuation = true;
      }
      if (read(["cat-file", "-t", tree[1]!]).toString("ascii") !== "tree\n") fail("DOT_SOURCE_OBJECT_INVALID", "commit tree is missing or has the wrong type");
      // Author/message bytes were used transiently for hashing only. Never persist or log them.
    }
  } catch (error) {
    if (error instanceof DotSourceVerificationError) throw error;
    fail("DOT_SOURCE_OBJECT_UNAVAILABLE", "local-only verification could not complete");
  } finally { await rm(view, { recursive: true, force: true }); }
}
