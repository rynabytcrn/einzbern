// SPDX-License-Identifier: Apache-2.0
import { readConsolidationIndex, withConsolidationIndexParseReuse } from "./consolidation-format.js";
import { observeCacheReason } from "./recall-observation.js";
import type { LibraryRead, StreamManifest } from "./akasha.js";
import type { EventRecord } from "../../protocol/src/index.js";
import type { Library, LibraryManifest } from "./ether-library.js";
import type { CacheSnapshotHeader } from "./library-cache.js";
import type { VerifiedSegment } from "./source-verification-native.js";

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
