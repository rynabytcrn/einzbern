// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConsolidationError, digestBytes, readConsolidationIndex, validateConsolidationIndex } from "./consolidation-format.js";
import type { ConsolidationIndex } from "./consolidation-format.js";
import { observeCacheReason, observeMetadataBytes } from "./recall-observation.js";
import type { LibraryRead, StreamManifest } from "./akasha.js";
import type { EventRecord } from "../../protocol/src/index.js";
import type { Library, LibraryManifest } from "./ether-library.js";
import type { CacheSnapshotHeader } from "./library-cache.js";
import type { VerifiedSegment } from "./source-verification-native.js";

interface IndexParse {
  readonly bytes: Buffer;
  readonly index: ConsolidationIndex;
}
let indexParses: AsyncLocalStorage<Map<string, IndexParse>> | undefined;

/** Private request scope: current file reads and validations are never cached. */
export function withConsolidationIndexParseReuse<T>(operation: () => Promise<T>): Promise<T> {
  indexParses ??= new AsyncLocalStorage<Map<string, IndexParse>>();
  return indexParses.run(new Map(), operation);
}

function freezeIndex(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    Object.freeze(current);
    for (const child of Object.values(current)) pending.push(child);
  }
}

/** The public reader's original metadata span includes this complete current read. */
export async function readCurrentConsolidationIndex(root: string, manifest: LibraryManifest): Promise<ConsolidationIndex | null> {
  const provenance = manifest.consolidation;
  if (provenance === undefined) return null;
  const path = join(root, provenance.index);
  const bytes = await readFile(path);
  observeMetadataBytes(bytes.length);
  if (digestBytes(bytes) !== provenance.sha256) throw new ConsolidationError("CONSOLIDATION_DIGEST_MISMATCH", "consolidation index digest differs from the library manifest");
  const parses = indexParses?.getStore();
  const previous = parses?.get(path);
  // Each reader authenticates its current bytes, in the original order. Equal
  // bytes share only a private immutable parse, never a validation result.
  const index = validateConsolidationIndex(previous?.bytes.equals(bytes) === true ? previous.index : JSON.parse(bytes.toString("utf8")));
  if (index.primaryLibraryId !== manifest.libraryId) throw new ConsolidationError("CONSOLIDATION_INDEX_INVALID", "the shared library must retain its coordination identity");
  if (parses !== undefined && previous?.index !== index) {
    freezeIndex(index);
    parses.set(path, { bytes, index });
  }
  return index;
}

// Akasha and the materializer share this private module, not a caller-supplied
// callback or state. Only the native module owns its request-local verification
// scope. Ordinary reads do not load its helper/process/cache implementation.
let verifier: typeof import("./source-verification-native.js") | undefined;
async function nativeVerifier(): Promise<typeof import("./source-verification-native.js")> {
  return verifier ??= await import("./source-verification-native.js");
}

export function verifiedStreamSegments(root: string, manifest: StreamManifest, source?: LibraryManifest): Promise<ReadonlyMap<string, VerifiedSegment> | null> | null {
  return verifier?.hasActiveSourceVerification() === true ? verifier.verifiedStreamSegments(root, manifest, source) : null;
}
export function recordVerifiedStreamEvents(root: string, manifest: StreamManifest, events: readonly EventRecord[]): Promise<void> | undefined {
  return verifier?.hasActiveSourceVerification() === true ? verifier.recordVerifiedStreamEvents(root, manifest, events) : undefined;
}
export function hasPendingSourceVerification(): boolean {
  return verifier?.hasPendingSourceVerification() ?? false;
}
export async function hasVerifiedReplayProjection(library: Library, binding: string, snapshot: CacheSnapshotHeader): Promise<boolean> {
  return (await import("./source-verification-records.js")).hasVerifiedReplayProjection(library, binding, snapshot);
}
export async function recordVerifiedReplayProjection(library: Library, binding: string, snapshot: CacheSnapshotHeader): Promise<void> {
  await (await import("./source-verification-records.js")).recordVerifiedReplayProjection(library, binding, snapshot);
}
export async function withSourceVerification<T>(library: Library, operation: () => Promise<{ readonly value: T; readonly read: LibraryRead; readonly accepted: boolean }>): Promise<T> {
  if (process.platform !== "darwin" || library.manifest.consolidation === undefined) return (await operation()).value;
  // Two system JXA starts cost more than full verification on the measured
  // small and medium inputs. The digest-bound archive inventory is already part of the
  // source contract. Select full verification below a conservative 4 MiB of
  // archived events; this is only a cost choice, never evidence of authenticity.
  // The normal reader still validates the current index and every source.
  // A failed cost precheck delegates errors to the original reader, which may
  // encounter an earlier corrupt event before reaching the index.
  return withConsolidationIndexParseReuse(async () => {
    const index = await readConsolidationIndex(library.root, library.manifest).catch(() => null);
    const archiveBytes = index?.sources.reduce((sum, source) => sum + source.inventory.reduce((bytes, file) => bytes + (/^akasha\/[^/]+\/[^/]+\.ndjson$/u.test(file.path) ? file.bytes : 0), 0), 0) ?? 0;
    if (archiveBytes < 4 * 1024 * 1024) {
      observeCacheReason("source-verification-full-cost-path");
      return (await operation()).value;
    }
    return (await nativeVerifier()).withSourceVerification(library, operation);
  });
}
