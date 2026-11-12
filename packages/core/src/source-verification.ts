// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConsolidationError, digestBytes, readConsolidationIndex, validateConsolidationIndex } from "./consolidation-format.js";
import type { ConsolidationIndex } from "./consolidation-format.js";
import { observeCacheRead, observeCacheReason, observeCacheWrite, observeMetadataBytes } from "./recall-observation.js";
import type { LibraryRead, StreamManifest } from "./akasha.js";
import type { EventRecord } from "../../protocol/src/index.js";
import type { Library, LibraryManifest } from "./ether-library.js";
import type { CacheSnapshotHeader } from "./library-cache.js";
import { cachePath } from "./device-home.js";
import { writeFileAtomic } from "./atomic-file.js";
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
const FULL_READ_MAX_BYTES = 4 * 1024 * 1024;
const COST_HINT_SCHEMA = "einzbern.consolidation-cost.v1";
function costHintPath(library: Library): string {
  return join(cachePath(library.manifest.libraryId), "consolidation-cost.json");
}

/** Disposable scheduling advice only. Source/index/replay verification never
 * trusts this file: either selected reader must independently prove its input. */
async function readArchiveCostHint(library: Library): Promise<number | null> {
  let handle;
  try {
    handle = await open(costHintPath(library), "r");
    const bytes = Buffer.alloc(513);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    observeCacheRead(bytesRead);
    if (bytesRead > 512) return null;
    const hint = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    return hint?.schemaVersion === COST_HINT_SCHEMA && hint.libraryId === library.manifest.libraryId
      && hint.indexSha256 === library.manifest.consolidation?.sha256
      && Number.isSafeInteger(hint.archiveBytes) && hint.archiveBytes >= 0 ? hint.archiveBytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function withSourceVerification<T>(library: Library, operation: () => Promise<{ readonly value: T; readonly read: LibraryRead; readonly accepted: boolean }>): Promise<T> {
  if (process.platform !== "darwin" || library.manifest.consolidation === undefined) return (await operation()).value;
  const hintedBytes = await readArchiveCostHint(library);
  if (hintedBytes !== null) {
    if (hintedBytes < FULL_READ_MAX_BYTES) {
      observeCacheReason("source-verification-full-cost-path");
      return (await operation()).value;
    }
    return withConsolidationIndexParseReuse(async () => (await nativeVerifier()).withSourceVerification(library, operation));
  }
  // Without a current-index-bound hint, retain the measured 4 MiB cost choice.
  // Its precheck cannot replace the normal reader: that reader still reads and
  // validates its current bytes, in its original error order. Only the native
  // path (or a hint miss) needs the private immutable index parse scope.
  return withConsolidationIndexParseReuse(async () => {
    const index = await readConsolidationIndex(library.root, library.manifest).catch(() => null);
    const archiveBytes = index?.sources.reduce((sum, source) => sum + source.inventory.reduce((bytes, file) => bytes + (/^akasha\/[^/]+\/[^/]+\.ndjson$/u.test(file.path) ? file.bytes : 0), 0), 0) ?? 0;
    if (index !== null) {
      try {
        const text = JSON.stringify({ schemaVersion: COST_HINT_SCHEMA, libraryId: library.manifest.libraryId, indexSha256: library.manifest.consolidation!.sha256, archiveBytes });
        await mkdir(cachePath(library.manifest.libraryId), { recursive: true });
        await writeFileAtomic(costHintPath(library), text);
        observeCacheWrite(Buffer.byteLength(text));
      } catch {
        // Missing/unwritable disposable advice does not change verification.
      }
    }
    if (archiveBytes < FULL_READ_MAX_BYTES) {
      observeCacheReason("source-verification-full-cost-path");
      return (await operation()).value;
    }
    return (await nativeVerifier()).withSourceVerification(library, operation);
  });
}
