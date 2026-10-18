import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";
// SPDX-License-Identifier: Apache-2.0
// STORY-177 — the knowledge/artifact store data-plane abstraction. The workspace
// control tree already rides behind a StorageBackend (STORY-174); this file gives
// the two derived stores (knowledge-core, artifact-lifecycle) the same treatment
// for their data-plane IO: the knowledge marker, metadata/body/view records, and
// artifact records. The file backend is a behaviour-preserving convergence of the
// two stores' former private helpers (readBoundRegularFile/writeExclusiveFile/
// replaceRegularFile); a Postgres backend (analogous to STORY-175) will implement
// the same interface over SQL. Claim/quarantine protocol stays file-native, exactly
// as workspace leases do — the interface only covers the data plane.
//
// The file backend is store-aware through a small profile: the two stores map the
// same physical failures to different reason-code families (KNOWLEDGE_* versus
// ARTIFACT_*), and each file type carries its own byte bound and observation hooks
// (the test seams that previously travelled on KnowledgeReadOptions/ArtifactScanOptions).
// The profile is supplied by the constructing store, so the byte behaviour is
// unchanged; the STORY-176-style equivalence gate can later swap in a PG backend
// through withStoreBackendFactory.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { assertCanonicalJson, canonicalJson, canonicalSha256, compareCanonicalText } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";

export interface StoreBackend {
  // knowledge marker (store.json). TCRN-CROSS-SUB-414 (MIN-235 D7): read only. Initialization creates
  // a crest's root manifest once, with an exclusive create of its own (knowledge-core.ts), and nothing
  // replaces it, so the backend carries no marker write for a code path to reach.
  readKnowledgeMarker(): Promise<Buffer>;
  // knowledge metadata records (metadata/*.json)
  listKnowledgeMetadata(): Promise<string[]>;
  readKnowledgeMetadata(id: string): Promise<Buffer>;
  writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void>;
  // knowledge bodies (bodies/*.body)
  listKnowledgeBodies(): Promise<string[]>;
  readKnowledgeBody(id: string): Promise<Buffer>;
  writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void>;
  // knowledge views (views/index.json, or the device cache's copy for a library)
  readKnowledgeView(): Promise<Buffer>;
  writeKnowledgeView(bytes: Buffer | string): Promise<void>;
  // artifact marker (store.json)
  readArtifactMarker(): Promise<Buffer>;
  writeArtifactMarker(bytes: Buffer | string): Promise<void>;
  // artifact records (records/*.json)
  listArtifactRecords(): Promise<string[]>;
  readArtifactRecord(id: string): Promise<Buffer>;
  writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void>;
}

/** The failure shape the file backend raises. The two stores' own error classes
 * (KnowledgeCoreError/ArtifactLifecycleError) carry the same reason-code strings,
 * so a StoreBackendError with the store's code is indistinguishable to the
 * reason-code assertions the suite relies on. */
export class StoreBackendError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "StoreBackendError";
    this.reasonCode = reasonCode;
  }
}

export interface StoreBackendObservationHooks {
  readonly beforeDescriptorReadForTest?: ((path: string) => Promise<void>) | undefined;
  readonly afterDescriptorOpenForTest?: ((path: string) => Promise<void>) | undefined;
  readonly afterDescriptorReadForTest?: ((path: string) => Promise<void>) | undefined;
}

/**
 * TCRN-CROSS-STORY-469 R4: where a store keeps what it derives. A library's knowledge index
 * view is this device's cache (the locator names the file, outside the store root); a store
 * without a locator, or whose locator answers null, keeps views/index.json under its root.
 */
export interface StoreBackendPlacement {
  readonly knowledgeViewFile?: () => Promise<string | null>;
}

export interface FileStoreBackendProfile {
  readonly reasonCodes: {
    readonly pathInvalid: string;
    readonly linkUnsafe: string;
    readonly specialFile: string;
    readonly limitExceeded: string;
    readonly sourceChanged: string;
    readonly alreadyExists: string;
  };
  readonly limits: {
    readonly markerBytes: number;
    readonly metadataBytes: number;
    readonly bodyBytes: number;
    readonly viewBytes: number;
    readonly recordBytes: number;
  };
}

// STORY-177: a package-private backend-factory override so an equivalence gate can
// run the SAME store verbs against a PG backend and compare byte output to the file
// backend, mirroring workspace.ts's withStorageBackendFactory. Scope is one async
// operation (AsyncLocalStorage); production callers never arm it.
const storeBackendFactoryOverride = new AsyncLocalStorage<() => StoreBackend>();

export function withStoreBackendFactory<T>(factory: () => StoreBackend, operation: () => Promise<T>): Promise<T> {
  if (storeBackendFactoryOverride.getStore() !== undefined) {
    throw new Error("store backend factory nesting is unsupported");
  }
  return storeBackendFactoryOverride.run(factory, operation);
}

/** Resolve the active backend for a store operation: the injected factory wins,
 * otherwise the converged file backend. The profile carries the store's reason
 * codes, per-file byte bounds, and the observation hooks a call's options passed. */
export function resolveStoreBackend(
  storeRoot: string,
  profile: FileStoreBackendProfile,
  hooks: StoreBackendObservationHooks = {},
  placement: StoreBackendPlacement = {},
): StoreBackend {
  const factory = storeBackendFactoryOverride.getStore();
  if (factory !== undefined) return factory();
  return new SegmentedKnowledgeStoreBackend(new FileStoreBackend(storeRoot, profile, hooks, placement));
}

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface FileSnapshot extends FileIdentity {
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface BoundBytes {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
}

/**
 * The file backend: the exact byte behaviour of the two stores' former private
 * helpers, unchanged. This is the "file backend converged behind the interface"
 * half of STORY-177 — a behaviour-preserving move, not a rewrite. The hardened read
 * is the knowledge-core variant (which is the superset of the two stores' shared
 * logic); the unified write covers both the exclusive-create call sites (init,
 * create, restore) and the atomic-replace call sites (mutation verbs), choosing the
 * branch by whether the target already exists. Every write goes through this path so
 * the two backends stay byte-equivalent.
 */
export class FileStoreBackend implements StoreBackend {
  private readonly storeRoot: string;
  private readonly codes: FileStoreBackendProfile["reasonCodes"];
  private readonly limits: FileStoreBackendProfile["limits"];
  private readonly hooks: StoreBackendObservationHooks;
  private readonly placement: StoreBackendPlacement;

  constructor(storeRoot: string, profile: FileStoreBackendProfile, hooks: StoreBackendObservationHooks = {}, placement: StoreBackendPlacement = {}) {
    this.storeRoot = storeRoot;
    this.codes = profile.reasonCodes;
    this.limits = profile.limits;
    this.hooks = hooks;
    this.placement = placement;
  }

  // ---- knowledge ----

  async readKnowledgeMarker(): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path("store.json"), this.limits.markerBytes)).bytes;
  }

  async listKnowledgeMetadata(): Promise<string[]> {
    return this.listDirectory("metadata");
  }

  async readKnowledgeMetadata(id: string): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`metadata/${id}.json`), this.limits.metadataBytes)).bytes;
  }

  async writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`metadata/${id}.json`), bytes);
  }

  async listKnowledgeBodies(): Promise<string[]> {
    return this.listDirectory("bodies");
  }

  async readKnowledgeBody(id: string): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`bodies/${id}.body`), this.limits.bodyBytes)).bytes;
  }

  async writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`bodies/${id}.body`), bytes);
  }

  async removeKnowledgeBody(id: string): Promise<void> {
    await this.removeKnowledgeBodyFile(`${id}.body`);
  }

  // STORY-341: the segmented knowledge backend reuses the same bounded path and
  // atomic-write primitives for its body segments and sidecars. These methods
  // intentionally stay outside StoreBackend so ordinary store verbs retain the
  // legacy record interface while the pluggable local implementation can own
  // its physical layout.
  async listKnowledgeBodyFiles(): Promise<string[]> {
    return this.listDirectory("bodies");
  }

  async readKnowledgeBodyFile(name: string, maximumBytes = this.limits.viewBytes || this.limits.bodyBytes): Promise<Buffer> {
    const path = this.path(`bodies/${name}`);
    if (name === "manifest.json") await this.settleBodyManifest(path, maximumBytes).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    });
    return (await this.readBoundRegularFile(path, maximumBytes)).bytes;
  }

  async writeKnowledgeBodyFile(name: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`bodies/${name}`), bytes, name === "manifest.json");
  }

  async removeKnowledgeBodyFile(name: string): Promise<void> {
    const path = this.path(`bodies/${name}`);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String(error)}`);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new StoreBackendError(this.codes.linkUnsafe, path);
    await rm(path);
  }

  async readKnowledgeView(): Promise<Buffer> {
    const cached = await this.placement.knowledgeViewFile?.() ?? null;
    return (await this.readBoundRegularFile(cached ?? this.path("views/index.json"), this.limits.viewBytes)).bytes;
  }

  async writeKnowledgeView(bytes: Buffer | string): Promise<void> {
    const cached = await this.placement.knowledgeViewFile?.() ?? null;
    if (cached === null) {
      await this.writeAtomic(this.path("views/index.json"), bytes);
      return;
    }
    // The device cache's copy is derived state: a write that fails leaves it to the next read,
    // which projects it again, and never fails the store write that produced it.
    try {
      await mkdir(dirname(cached), { recursive: true });
      await this.writeAtomic(cached, bytes);
    } catch {
      // Left for the next read to rebuild.
    }
  }

  // ---- artifact ----

  async readArtifactMarker(): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path("store.json"), this.limits.markerBytes)).bytes;
  }

  async writeArtifactMarker(bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path("store.json"), bytes);
  }

  async listArtifactRecords(): Promise<string[]> {
    return this.listDirectory("records");
  }

  async readArtifactRecord(id: string): Promise<Buffer> {
    return (await this.readBoundRegularFile(this.path(`records/${id}.json`), this.limits.recordBytes)).bytes;
  }

  async writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void> {
    await this.writeAtomic(this.path(`records/${id}.json`), bytes);
  }

  // ---- shared file primitives ----

  private path(relativePath: string): string {
    this.assertRelativePath(relativePath);
    const candidate = resolve(this.storeRoot, relativePath);
    if (!this.inside(this.storeRoot, candidate)) {
      throw new StoreBackendError(this.codes.pathInvalid, relativePath);
    }
    return candidate;
  }

  private assertRelativePath(value: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) {
      throw new StoreBackendError(this.codes.pathInvalid, value);
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new StoreBackendError(this.codes.pathInvalid, value);
    }
  }

  private inside(parent: string, candidate: string): boolean {
    const relation = relative(parent, candidate);
    return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep));
  }

  private sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private snapshot(value: FileSnapshot): FileSnapshot {
    return { dev: value.dev, ino: value.ino, size: value.size, mode: value.mode, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
  }

  private sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
    return this.sameIdentity(left, right) && left.size === right.size && left.mode === right.mode &&
      left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  }

  private async boundDirectory(path: string, parent?: string): Promise<string> {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String((error as { code?: string }).code ?? error)}`);
    }
    if (before.isSymbolicLink()) {
      throw new StoreBackendError(this.codes.linkUnsafe, path);
    }
    if (!before.isDirectory()) {
      throw new StoreBackendError(this.codes.specialFile, path);
    }
    const canonical = await realpath(path);
    if (parent && !this.inside(parent, canonical)) {
      throw new StoreBackendError(this.codes.pathInvalid, path);
    }
    const after = await lstat(canonical);
    if (!after.isDirectory() || after.isSymbolicLink() || !this.sameIdentity(before, after)) {
      throw new StoreBackendError(this.codes.sourceChanged, path);
    }
    return canonical;
  }

  private async listDirectory(relativePath: string): Promise<string[]> {
    const root = await this.boundDirectory(this.path(relativePath));
    const entries = await readdir(root);
    // Canonical byte order; compareCanonicalText lives in protocol's index but
    // importing it here would pull the whole protocol module. The store re-sorts
    // anyway; a plain UTF-8 compare is behaviour-identical for the ASCII .json/.body
    // names the stores enumerate.
    entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return entries;
  }

  private async readBoundRegularFile(path: string, maximumBytes: number): Promise<BoundBytes> {
    let before;
    try {
      before = await lstat(path, { bigint: true });
    } catch (error) {
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String((error as { code?: string }).code ?? error)}`);
    }
    if (before.isSymbolicLink()) {
      throw new StoreBackendError(this.codes.linkUnsafe, path);
    }
    if (!before.isFile()) {
      throw new StoreBackendError(this.codes.specialFile, path);
    }
    if (before.nlink !== 1n) {
      throw new StoreBackendError(this.codes.linkUnsafe, path);
    }
    const maximum = BigInt(maximumBytes);
    if (before.size > maximum) {
      throw new StoreBackendError(this.codes.limitExceeded, `${path}:${before.size}`);
    }
    const beforeSnapshot = this.snapshot(before);
    await this.hooks.beforeDescriptorReadForTest?.(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size > maximum || !this.sameSnapshot(beforeSnapshot, opened)) {
        throw new StoreBackendError(opened.size > maximum ? this.codes.limitExceeded : this.codes.sourceChanged, path);
      }
      const openedSnapshot = this.snapshot(opened);
      await this.hooks.afterDescriptorOpenForTest?.(path);
      const bytes = await handle.readFile();
      await this.hooks.afterDescriptorReadForTest?.(path);
      const after = await handle.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (BigInt(bytes.length) > maximum || after.size > maximum || named.size > maximum) {
        throw new StoreBackendError(this.codes.limitExceeded, path);
      }
      if (BigInt(bytes.length) !== openedSnapshot.size || !this.sameSnapshot(openedSnapshot, after) || !this.sameSnapshot(openedSnapshot, named) ||
        named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n) {
        throw new StoreBackendError(this.codes.sourceChanged, path);
      }
      return { bytes, identity: { dev: opened.dev, ino: opened.ino } };
    } catch (error) {
      if (error instanceof StoreBackendError) {
        throw error;
      }
      // Thrown inline rather than through a helper: TypeScript's reachability
      // analysis stops honouring a never-returning call in a catch clause once the
      // statement carries a finally block, so routing through one here would make
      // the function look like it can fall off the end.
      throw new StoreBackendError(this.codes.sourceChanged, `${path}:${String(error)}`);
    } finally {
      await handle?.close();
    }
  }

  private async writeAtomic(path: string, bytes: Buffer | string, atomicNewManifest = false): Promise<void> {
    let existing;
    try {
      existing = await lstat(path);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String(error)}`);
      }
      existing = undefined;
    }
    if (existing !== undefined) {
      // Replace branch: the call sites that replace a record in place (the device cache's
      // index view, the metadata/body layout's body segments and sidecars, the artifact
      // store's records). Mirrors the stores' replaceRegularFile: the target must be a safe
      // single-link regular file.
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        throw new StoreBackendError(existing.isSymbolicLink() || existing.nlink !== 1 ? this.codes.linkUnsafe : this.codes.specialFile, path);
      }
      const temporaryPath = resolve(dirname(path), `.tmp-${randomBytes(12).toString("hex")}`);
      const temporary = await this.writeExclusive(temporaryPath, bytes);
      try {
        const rebound = await lstat(path);
        if (!this.sameIdentity(existing, rebound) || rebound.isSymbolicLink() || !rebound.isFile() || rebound.nlink !== 1) {
          throw new StoreBackendError(this.codes.sourceChanged, path);
        }
        await rename(temporaryPath, path);
        const named = await lstat(path);
        if (!this.sameIdentity(named, temporary) || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1) {
          throw new StoreBackendError(this.codes.sourceChanged, path);
        }
        await this.syncDirectory(dirname(path));
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      return;
    }
    // Only the segmented manifest opts into staged no-replace publication. Other
    // callers retain their established exclusive-create behavior.
    if (atomicNewManifest) {
      await this.publishBodyManifest(path, bytes);
      return;
    }
    await this.writeExclusive(path, bytes);
  }

  private async publishBodyManifest(path: string, bytes: Buffer | string): Promise<void> {
    const expected = Buffer.from(bytes);
    const temporary = resolve(dirname(path), `.tmp-body-manifest-${segmentedBodySha256(expected)}-${randomBytes(12).toString("hex")}`);
    const identity = await this.writeExclusive(temporary, expected);
    try {
      // No rename fallback: link atomically publishes complete bytes without
      // replacing a competing final name. Unsupported filesystems fail closed.
      await link(temporary, path);
      await this.syncDirectory(dirname(path));
      await this.settleBodyManifest(path, expected.length);
      const published = await lstat(path);
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 || !this.sameIdentity(identity, published)) {
        throw new StoreBackendError(this.codes.sourceChanged, path);
      }
    } catch (error) {
      if (error instanceof StoreBackendError) throw error;
      if ((error as { code?: string }).code === "EEXIST") throw new StoreBackendError(this.codes.alreadyExists, path);
      throw new StoreBackendError(this.codes.pathInvalid, `${path}: atomic manifest publication requires filesystem hard-link support: ${String(error)}`);
    } finally {
      // Also covers a no-replace refusal. Never remove a swapped staging inode.
      const named = await lstat(temporary).catch(() => undefined);
      if (named?.isFile() && !named.isSymbolicLink() && this.sameIdentity(identity, named)) {
        await rm(temporary, { force: true });
      }
    }
  }

  // A completed no-replace publication can retain its second, staging name after
  // interruption. Only this manifest-specific, digest-bound pair can be settled;
  // generic reads continue to refuse every multiply linked file.
  private async settleBodyManifest(path: string, maximumBytes: number): Promise<void> {
    const before = await lstat(path, { bigint: true });
    if (before.nlink === 1n) return;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 2n) throw new StoreBackendError(this.codes.linkUnsafe, path);
    if (before.size > BigInt(maximumBytes)) throw new StoreBackendError(this.codes.limitExceeded, path);
    const parent = await this.boundDirectory(dirname(path));
    const parentBefore = await lstat(parent, { bigint: true });
    let staging: { path: string; digest: string } | undefined;
    for (const name of await readdir(parent)) {
      const match = /^\.tmp-body-manifest-([a-f0-9]{64})-[a-f0-9]{24}$/u.exec(name);
      if (match === null) continue;
      const candidate = resolve(parent, name);
      const named = await lstat(candidate, { bigint: true }).catch((error: unknown) => {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      });
      if (named === undefined || !this.sameIdentity(before, named)) continue;
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 2n || staging !== undefined) throw new StoreBackendError(this.codes.linkUnsafe, candidate);
      staging = { path: candidate, digest: match[1]! };
    }
    if (staging === undefined) {
      const settled = await lstat(path, { bigint: true });
      if (settled.isFile() && !settled.isSymbolicLink() && settled.nlink === 1n && this.sameIdentity(before, settled)) return;
      throw new StoreBackendError(this.codes.linkUnsafe, `${path}: unrecognized manifest publication link`);
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!this.sameSnapshot(this.snapshot(before), opened)) throw new StoreBackendError(this.codes.sourceChanged, path);
      const content = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      const staged = await lstat(staging.path, { bigint: true });
      if (!this.sameSnapshot(this.snapshot(before), after) || !this.sameSnapshot(this.snapshot(before), named) ||
        !this.sameSnapshot(this.snapshot(before), staged) || staged.isSymbolicLink() || staged.nlink !== 2n || named.nlink !== 2n ||
        content.length !== Number(before.size) || segmentedBodySha256(content) !== staging.digest ||
        !this.sameIdentity(parentBefore, await lstat(parent, { bigint: true }))) {
        throw new StoreBackendError(this.codes.sourceChanged, path);
      }
      await rm(staging.path);
      const settled = await lstat(path, { bigint: true });
      if (!settled.isFile() || settled.isSymbolicLink() || settled.nlink !== 1n || !this.sameIdentity(before, settled)) throw new StoreBackendError(this.codes.sourceChanged, path);
      await this.syncDirectory(parent);
    } catch (error) {
      // Another reader or the publisher may have finished the same settlement.
      const settled = await lstat(path, { bigint: true }).catch(() => undefined);
      if (settled?.isFile() && !settled.isSymbolicLink() && settled.nlink === 1n && this.sameIdentity(before, settled) &&
        settled.size === before.size && settled.mode === before.mode && settled.mtimeNs === before.mtimeNs &&
        this.sameIdentity(parentBefore, await lstat(parent, { bigint: true }))) return;
      throw error;
    } finally {
      await handle.close();
    }
  }

  private async writeExclusive(path: string, bytes: Buffer | string): Promise<FileIdentity> {
    const parent = await this.boundDirectory(dirname(path));
    const parentBefore = await lstat(parent);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new StoreBackendError(this.codes.linkUnsafe, path);
      }
      await handle.close();
      handle = undefined;
      const named = await lstat(path);
      const parentAfter = await lstat(parent);
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !this.sameIdentity(opened, named) || !this.sameIdentity(parentBefore, parentAfter)) {
        throw new StoreBackendError(this.codes.sourceChanged, path);
      }
      await this.syncDirectory(parent);
      return { dev: named.dev, ino: named.ino };
    } catch (error) {
      await handle?.close();
      if ((error as { code?: string }).code === "EEXIST") {
        throw new StoreBackendError(this.codes.alreadyExists, path);
      }
      if (error instanceof StoreBackendError) {
        throw error;
      }
      throw new StoreBackendError(this.codes.pathInvalid, `${path}:${String(error)}`);
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

interface SegmentedKnowledgeBodyLocation {
  readonly segment: string;
  readonly offset: number;
  readonly length: number;
}

interface SegmentedKnowledgeBodyManifest {
  readonly schemaVersion: "tcrn.knowledge-body-manifest.v1";
  readonly segments: readonly { readonly name: string; readonly bytes: number; readonly records: number; readonly sha256: string }[];
  readonly count: number;
  readonly indexDigest: string;
}

// The largest file of the segmented layout a read opens: a segment, its point index or the manifest.
export const SEGMENTED_BODY_FILE_LIMIT = RUNTIME_CAPACITY.bufferBytes;

function segmentedBodySha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function segmentedBodyObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * STORY-341: a local body backend that automatically reads the legacy one-file
 * layout until a manifest is present, then uses NDJSON plus point indexes. The
 * StoreBackend surface is unchanged, so knowledge-core does not know which
 * physical layout is active.
 */
export class SegmentedKnowledgeStoreBackend implements StoreBackend {
  constructor(private readonly delegate: FileStoreBackend) {}

  readKnowledgeMarker(): Promise<Buffer> { return this.delegate.readKnowledgeMarker(); }
  listKnowledgeMetadata(): Promise<string[]> { return this.delegate.listKnowledgeMetadata(); }
  readKnowledgeMetadata(id: string): Promise<Buffer> { return this.delegate.readKnowledgeMetadata(id); }
  writeKnowledgeMetadata(id: string, bytes: Buffer | string): Promise<void> { return this.delegate.writeKnowledgeMetadata(id, bytes); }
  readKnowledgeView(): Promise<Buffer> { return this.delegate.readKnowledgeView(); }
  writeKnowledgeView(bytes: Buffer | string): Promise<void> { return this.delegate.writeKnowledgeView(bytes); }
  readArtifactMarker(): Promise<Buffer> { return this.delegate.readArtifactMarker(); }
  writeArtifactMarker(bytes: Buffer | string): Promise<void> { return this.delegate.writeArtifactMarker(bytes); }
  listArtifactRecords(): Promise<string[]> { return this.delegate.listArtifactRecords(); }
  readArtifactRecord(id: string): Promise<Buffer> { return this.delegate.readArtifactRecord(id); }
  writeArtifactRecord(id: string, bytes: Buffer | string): Promise<void> { return this.delegate.writeArtifactRecord(id, bytes); }

  async listKnowledgeBodies(): Promise<string[]> {
    return this.readStableManifest(() => this.listKnowledgeBodiesOnce());
  }

  private async listKnowledgeBodiesOnce(): Promise<string[]> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.listKnowledgeBodies();
    const ids = new Set<string>();
    for (const segment of manifest.segments) {
      const index = await this.readSegmentedIndex(segment.name);
      for (const id of Object.keys(index)) ids.add(id);
    }
    return [...ids].sort(compareCanonicalText).map((id) => `${id}.body`);
  }

  async readKnowledgeBody(id: string): Promise<Buffer> {
    return this.readStableManifest(() => this.readKnowledgeBodyOnce(id));
  }

  private async readKnowledgeBodyOnce(id: string): Promise<Buffer> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.readKnowledgeBody(id);
    for (const segment of manifest.segments) {
      const index = await this.readSegmentedIndex(segment.name);
      const location = index[id];
      if (location === undefined) continue;
      const bytes = await this.delegate.readKnowledgeBodyFile(segment.name, Math.max(SEGMENTED_BODY_FILE_LIMIT, segment.bytes));
      if (bytes.length !== segment.bytes || segmentedBodySha256(bytes) !== segment.sha256) throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", segment.name);
      const line = bytes.subarray(location.offset, location.offset + location.length).toString("utf8");
      const value = assertCanonicalJson(line);
      if (!segmentedBodyObject(value) || value.id !== id || typeof value.body !== "string") throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", id);
      return Buffer.from(value.body, "utf8");
    }
    throw new StoreBackendError("KNOWLEDGE_PATH_INVALID", `body ${id} is unavailable`);
  }

  // A single list/point read retries if publication changed its manifest while
  // obsolete segments were reclaimed. This is not a transaction spanning calls.
  private async readStableManifest<T>(operation: () => Promise<T>): Promise<T> {
    const snapshot = async (): Promise<Buffer | null> => {
      const names = await this.delegate.listKnowledgeBodyFiles();
      return names.includes("manifest.json")
        ? this.delegate.readKnowledgeBodyFile("manifest.json", RUNTIME_CAPACITY.bufferBytes) : null;
    };
    const equal = (left: Buffer | null, right: Buffer | null): boolean => left === null ? right === null : right !== null && left.equals(right);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await snapshot();
      try {
        const result = await operation();
        if (equal(before, await snapshot())) return result;
      } catch (error) {
        // Unknown IO failures and unsafe links are not evidence of publication.
        const retryable = error instanceof StoreBackendError &&
          (error.reasonCode === "KNOWLEDGE_RECORD_INVALID" ||
            (error.reasonCode === "KNOWLEDGE_SOURCE_CHANGED" && !error.message.includes("Error:")) ||
            (error.reasonCode === "KNOWLEDGE_PATH_INVALID" && error.message.endsWith(":ENOENT")));
        if (!retryable || equal(before, await snapshot())) throw error;
      }
    }
    throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", "body manifest changed during read");
  }

  async writeKnowledgeBody(id: string, bytes: Buffer | string): Promise<void> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.writeKnowledgeBody(id, bytes);
    const records = [...await this.readSegmentedBodies(manifest)].map(([currentId, body]) => ({ id: currentId, bytes: body }));
    const replacement = Buffer.from(bytes);
    const existing = records.findIndex((record) => record.id === id);
    if (existing < 0) records.push({ id, bytes: replacement });
    else records[existing] = { id, bytes: replacement };
    await this.writeKnowledgeBodiesSegmented(records);
  }

  async removeKnowledgeBody(id: string): Promise<void> {
    const manifest = await this.readSegmentedManifest();
    if (manifest === null) return this.delegate.removeKnowledgeBody(id);
    const records = [...await this.readSegmentedBodies(manifest)]
      .filter(([currentId]) => currentId !== id).map(([currentId, body]) => ({ id: currentId, bytes: body }));
    await this.writeKnowledgeBodiesSegmented(records);
  }

  /**
   * STORY-341: move the metadata/body layout's body files into segments. TCRN-CROSS-SUB-425 R18 (fixes
   * STORY-341): the bodies the segments of a manifest already hold are read first and written again
   * beside the ones the body files add, so a layout whose bodies are in segments, or partly in them,
   * loses none it did not rewrite; with no body file to move, nothing is written. A body file whose
   * card's segment holds a different body is refused (KNOWLEDGE_PARTIAL_STATE) before anything is
   * written. `before` and `after` count the bodies the layout holds before and after the run, and
   * `bodyBytes` is their size after it.
   */
  async migrateKnowledgeBodies(segmentBytes = 1_048_576): Promise<{ readonly before: number; readonly after: number; readonly bodyBytes: number }> {
    const { before, after, bodyBytes } = await this.rewriteKnowledgeBodies(segmentBytes, new Set(), null);
    return { before, after, bodyBytes };
  }

  /**
   * TCRN-CROSS-SUB-425 R18 (STORY-514 R4): the same rewrite less the bodies of `cleared`, the removed
   * cards knowledge-core names, so that no segment holds them afterwards; every other body is written
   * again byte for byte, with the manifest and the point indexes. `beforeWrite` is handed every file
   * of bodies/ as it is, once everything is read and checked, before the first write and only when
   * the run writes: a run with no body file to move and no body to clear writes nothing.
   */
  async clearKnowledgeBodies(
    cleared: ReadonlySet<string>,
    segmentBytes: number,
    beforeWrite: (files: readonly { readonly name: string; readonly bytes: Buffer }[]) => Promise<void>,
  ): Promise<{ readonly before: number; readonly after: number; readonly bodyBytes: number; readonly cleared: number }> {
    return this.rewriteKnowledgeBodies(segmentBytes, cleared, beforeWrite);
  }

  private async rewriteKnowledgeBodies(
    segmentBytes: number,
    cleared: ReadonlySet<string>,
    beforeWrite: ((files: readonly { readonly name: string; readonly bytes: Buffer }[]) => Promise<void>) | null,
  ): Promise<{ readonly before: number; readonly after: number; readonly bodyBytes: number; readonly cleared: number }> {
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 4096) throw new StoreBackendError("KNOWLEDGE_LIMIT_EXCEEDED", "body segment size");
    const names = await this.delegate.listKnowledgeBodyFiles();
    const bodyFiles = names.filter((name) => name.endsWith(".body")).sort(compareCanonicalText);
    // Segments with no manifest are what a first migration that stopped before its manifest left: the
    // body files it was moving are all still there, and this rewrite replaces those segments.
    const manifest = names.includes("manifest.json") ? await this.readSegmentedManifest() : null;
    const held = manifest === null ? new Map<string, Buffer>() : await this.readSegmentedBodies(manifest);
    for (const name of bodyFiles) {
      const id = name.slice(0, -5);
      const bytes = await this.delegate.readKnowledgeBody(id);
      const segmented = held.get(id);
      if (segmented === undefined) held.set(id, bytes);
      else if (!segmented.equals(bytes)) throw new StoreBackendError("KNOWLEDGE_PARTIAL_STATE", `${id}: its body file and its segment hold different bodies`);
    }
    const kept = [...held].filter(([id]) => !cleared.has(id)).map(([id, bytes]) => ({ id, bytes }));
    const bodyBytes = kept.reduce((total, record) => total + record.bytes.length, 0);
    const clearing = held.size - kept.length;
    if (bodyFiles.length === 0 && clearing === 0) return { before: held.size, after: held.size, bodyBytes, cleared: 0 };
    if (beforeWrite !== null) {
      const files: { readonly name: string; readonly bytes: Buffer }[] = [];
      for (const name of [...names].sort(compareCanonicalText)) files.push({ name, bytes: await this.delegate.readKnowledgeBodyFile(name, SEGMENTED_BODY_FILE_LIMIT) });
      await beforeWrite(files);
    }
    // If publication completed but flat-file cleanup did not, the validated
    // manifest already owns every byte. Finish cleanup without another generation.
    if (manifest === null || clearing > 0 || held.size !== manifest.count) {
      await this.writeKnowledgeBodiesSegmented(kept, segmentBytes);
    }
    const written = await this.readSegmentedManifest();
    const readback = written === null ? new Map<string, Buffer>() : await this.readSegmentedBodies(written);
    if (readback.size !== kept.length) throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", "body segments");
    for (const record of kept) {
      if (readback.get(record.id)?.equals(record.bytes) !== true) throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", record.id);
    }
    for (const name of bodyFiles) await this.delegate.removeKnowledgeBodyFile(name);
    return { before: held.size, after: readback.size, bodyBytes, cleared: clearing };
  }

  // Every body the segments of a manifest hold, by id: each segment read once and checked against the
  // manifest as a point read checks it. Coverage is checked before any rewrite so
  // an omitted, overlapping or duplicate index entry cannot silently discard bytes.
  private async readSegmentedBodies(manifest: SegmentedKnowledgeBodyManifest): Promise<Map<string, Buffer>> {
    const bodies = new Map<string, Buffer>();
    for (const segment of manifest.segments) {
      const index = await this.readSegmentedIndex(segment.name);
      const bytes = await this.delegate.readKnowledgeBodyFile(segment.name, Math.max(SEGMENTED_BODY_FILE_LIMIT, segment.bytes));
      if (bytes.length !== segment.bytes || segmentedBodySha256(bytes) !== segment.sha256) throw new StoreBackendError("KNOWLEDGE_SOURCE_CHANGED", segment.name);
      let consumed = 0;
      for (const [id, location] of Object.entries(index).sort((left, right) => left[1].offset - right[1].offset)) {
        if (bodies.has(id) || location.offset !== consumed || location.length > bytes.length - consumed) {
          throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segment.name} index coverage`);
        }
        consumed += location.length;
        const value = assertCanonicalJson(bytes.subarray(location.offset, location.offset + location.length).toString("utf8"));
        if (!segmentedBodyObject(value) || value.id !== id || typeof value.body !== "string") throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", id);
        bodies.set(id, Buffer.from(value.body, "utf8"));
      }
      if (consumed !== bytes.length) throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segment.name} index coverage`);
    }
    return bodies;
  }

  private async readSegmentedManifest(): Promise<SegmentedKnowledgeBodyManifest | null> {
    const names = await this.delegate.listKnowledgeBodyFiles();
    const hasSegments = names.some((name) => /^\d{6,}\.(?:ndjson|idx)$/u.test(name));
    if (!names.includes("manifest.json")) {
      if (hasSegments) throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "segmented body manifest is missing");
      return null;
    }
    const value = assertCanonicalJson((await this.delegate.readKnowledgeBodyFile("manifest.json", RUNTIME_CAPACITY.bufferBytes)).toString("utf8"));
    if (!segmentedBodyObject(value) || value.schemaVersion !== "tcrn.knowledge-body-manifest.v1" || !Array.isArray(value.segments) ||
      !Number.isSafeInteger(value.count) || Number(value.count) < 0 || typeof value.indexDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.indexDigest)) {
      throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "segmented body manifest is invalid");
    }
    const segments: Array<SegmentedKnowledgeBodyManifest["segments"][number]> = [];
    for (const raw of value.segments) {
      if (!segmentedBodyObject(raw) || typeof raw.name !== "string" || !/^\d{6,}\.ndjson$/u.test(raw.name) ||
        !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || !Number.isSafeInteger(raw.records) || Number(raw.records) < 0 || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)) {
        throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "segmented body manifest segment is invalid");
      }
      segments.push({ name: raw.name, bytes: Number(raw.bytes), records: Number(raw.records), sha256: raw.sha256 });
    }
    const documents: JsonValue[] = [];
    const namesSeen = new Set<string>();
    const idsSeen = new Set<string>();
    for (const segment of segments) {
      if (namesSeen.has(segment.name)) throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "duplicate body segment");
      namesSeen.add(segment.name);
      const index = await this.readSegmentedIndex(segment.name, documents);
      const ids = Object.keys(index);
      if (ids.length !== segment.records) throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segment.name} record count`);
      for (const id of ids) {
        if (idsSeen.has(id)) throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "duplicate body id");
        idsSeen.add(id);
      }
    }
    if (idsSeen.size !== value.count || canonicalSha256(documents) !== value.indexDigest) {
      throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", "body manifest index integrity");
    }
    return { schemaVersion: "tcrn.knowledge-body-manifest.v1", segments, count: Number(value.count), indexDigest: value.indexDigest };
  }

  private async readSegmentedIndex(segmentName: string, documents?: JsonValue[]): Promise<Readonly<Record<string, SegmentedKnowledgeBodyLocation>>> {
    const value = assertCanonicalJson((await this.delegate.readKnowledgeBodyFile(segmentName.replace(".ndjson", ".idx"), RUNTIME_CAPACITY.bufferBytes)).toString("utf8"));
    if (!segmentedBodyObject(value) || value.schemaVersion !== "tcrn.knowledge-body-index.v1" || !segmentedBodyObject(value.entries)) {
      throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segmentName} index`);
    }
    documents?.push(value);
    const entries: Record<string, SegmentedKnowledgeBodyLocation> = Object.create(null) as Record<string, SegmentedKnowledgeBodyLocation>;
    for (const [id, raw] of Object.entries(value.entries)) {
      if (!segmentedBodyObject(raw) || typeof raw.segment !== "string" || raw.segment !== segmentName || !Number.isSafeInteger(raw.offset) || !Number.isSafeInteger(raw.length) || Number(raw.offset) < 0 || Number(raw.length) < 1) {
        throw new StoreBackendError("KNOWLEDGE_RECORD_INVALID", `${segmentName} index entry`);
      }
      entries[id] = { segment: raw.segment, offset: Number(raw.offset), length: Number(raw.length) };
    }
    return entries;
  }

  private async writeKnowledgeBodiesSegmented(records: readonly { readonly id: string; readonly bytes: Buffer }[], segmentBytes = 1_048_576): Promise<void> {
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 4096) throw new StoreBackendError("KNOWLEDGE_LIMIT_EXCEEDED", "body segment size");
    const sorted = [...records].sort((left, right) => compareCanonicalText(left.id, right.id));
    const chunks: { readonly id: string; readonly bytes: Buffer }[][] = [];
    let chunk: { readonly id: string; readonly bytes: Buffer }[] = [];
    let used = 0;
    for (const record of sorted) {
      const line = canonicalJson({ id: record.id, body: record.bytes.toString("utf8") });
      if (chunk.length > 0 && used + Buffer.byteLength(line, "utf8") > segmentBytes) {
        chunks.push(chunk);
        chunk = [];
        used = 0;
      }
      chunk.push(record);
      used += Buffer.byteLength(line, "utf8");
    }
    if (chunk.length > 0) chunks.push(chunk);
    // Writers are serialized by the crest lock. Allocate beyond every existing
    // segment (including abandoned generations), so committed bytes stay immutable
    // until the manifest has atomically selected the complete new generation.
    const previousFiles = await this.delegate.listKnowledgeBodyFiles();
    let ordinal = 0n;
    for (const name of previousFiles) {
      if (/^\d{6,}\.(?:ndjson|idx)$/u.test(name)) {
        const value = BigInt(name.slice(0, name.lastIndexOf(".")));
        if (value > ordinal) ordinal = value;
      }
    }
    const segments: Array<SegmentedKnowledgeBodyManifest["segments"][number]> = [];
    const indexDocuments: JsonValue[] = [];
    for (const part of chunks) {
      const name = `${String(++ordinal).padStart(6, "0")}.ndjson`;
      const content = Buffer.from(part.map((record) => canonicalJson({ id: record.id, body: record.bytes.toString("utf8") })).join(""), "utf8");
      const entries: Record<string, SegmentedKnowledgeBodyLocation> = {};
      let offset = 0;
      for (const record of part) {
        const length = Buffer.byteLength(canonicalJson({ id: record.id, body: record.bytes.toString("utf8") }), "utf8");
        entries[record.id] = { segment: name, offset, length };
        offset += length;
      }
      await this.delegate.writeKnowledgeBodyFile(name, content);
      const indexDocument = { schemaVersion: "tcrn.knowledge-body-index.v1", entries } as unknown as JsonValue;
      await this.delegate.writeKnowledgeBodyFile(name.replace(".ndjson", ".idx"), canonicalJson(indexDocument));
      indexDocuments.push(indexDocument);
      segments.push({ name, bytes: content.length, records: part.length, sha256: segmentedBodySha256(content) });
    }
    const manifest = { schemaVersion: "tcrn.knowledge-body-manifest.v1", segments, count: sorted.length, indexDigest: canonicalSha256(indexDocuments) };
    await this.delegate.writeKnowledgeBodyFile("manifest.json", canonicalJson(manifest));
    // Cleanup is post-commit: a failure can leave unused files, not invalidate the
    // old manifest before the new one is available.
    for (const name of previousFiles) {
      if (/^\d{6,}\.(?:ndjson|idx)$/u.test(name)) await this.delegate.removeKnowledgeBodyFile(name);
    }
  }
}
