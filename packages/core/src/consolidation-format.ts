// SPDX-License-Identifier: Apache-2.0
// A consolidation records the original libraries, not a re-authored event history. The root
// manifest commits this small index; the archived streams keep their original identities/hashes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LibraryManifest } from "./ether-library.js";
import { validateLibraryManifest } from "./ether-library.js";
import { assertStrictInstant } from "../../protocol/src/index.js";

export interface ConsolidationSource {
  readonly manifest: LibraryManifest;
  readonly archive: string;
  readonly headEventHash: string | null;
  readonly versionVector: Readonly<Record<string, number>>;
  readonly bindings: readonly { readonly projectPath: string; readonly projectId: string; readonly role: "project" | "coordination" }[];
  readonly inventory: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}
export interface ConsolidationIndex {
  readonly schemaVersion: "einzbern.consolidation.v1";
  readonly at: string;
  readonly actor: string;
  readonly decidedIn: string;
  readonly primaryLibraryId: string;
  readonly primaryVersionVector: Readonly<Record<string, number>>;
  readonly sources: readonly ConsolidationSource[];
}
export class ConsolidationError extends Error {
  constructor(readonly reasonCode: string, message: string) { super(message); this.name = "ConsolidationError"; }
}
export const digestBytes = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function validateConsolidationIndex(input: unknown): ConsolidationIndex {
  const value = input as ConsolidationIndex;
  const fail = (): never => { throw new ConsolidationError("CONSOLIDATION_INDEX_INVALID", "invalid consolidation provenance"); };
  if (!value || value.schemaVersion !== "einzbern.consolidation.v1" || !Array.isArray(value.sources) || value.sources.length < 1 ||
    typeof value.actor !== "string" || !value.actor.startsWith("agent:") || typeof value.decidedIn !== "string" || !/^minutes:[a-f0-9]{24}#D[1-9][0-9]*$/u.test(value.decidedIn)) fail();
  assertStrictInstant(value.at);
  const ids = new Set<string>();
  const projects = new Set<string>();
  for (const source of value.sources) {
    const manifest = validateLibraryManifest(source.manifest);
    if (manifest.consolidation !== undefined || ids.has(manifest.libraryId) || source.archive !== `artifacts/consolidation/${manifest.libraryId.replace(":", "-")}` ||
      !Array.isArray(source.bindings) || source.bindings.length === 0 || !Array.isArray(source.inventory) ||
      !(source.headEventHash === null || /^[a-f0-9]{64}$/u.test(source.headEventHash))) fail();
    ids.add(manifest.libraryId);
    for (const entry of source.bindings) {
      if (!/^project:[a-f0-9]{24}$/u.test(entry.projectId) || !["project", "coordination"].includes(entry.role) || typeof entry.projectPath !== "string") fail();
      projects.add(entry.projectId);
    }
    if (!source.versionVector || Object.entries(source.versionVector).some(([id, n]) => !/^[a-f0-9]{32}$/u.test(id) || !Number.isSafeInteger(n) || n < 0)) fail();
    for (const file of source.inventory) if (typeof file.path !== "string" || file.path.includes("..") || file.path.startsWith("/") || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) fail();
  }
  const primary = value.sources.find(source => source.manifest.libraryId === value.primaryLibraryId);
  if (!primary || JSON.stringify(primary.versionVector) !== JSON.stringify(value.primaryVersionVector)) fail();
  return value;
}
export async function readConsolidationIndex(root: string, manifest: LibraryManifest): Promise<ConsolidationIndex | null> {
  if (manifest.consolidation === undefined) return null;
  const bytes = await readFile(join(root, manifest.consolidation.index));
  if (digestBytes(bytes) !== manifest.consolidation.sha256) throw new ConsolidationError("CONSOLIDATION_DIGEST_MISMATCH", "consolidation index digest differs from the library manifest");
  const index = validateConsolidationIndex(JSON.parse(bytes.toString("utf8")));
  if (index.primaryLibraryId !== manifest.libraryId) throw new ConsolidationError("CONSOLIDATION_INDEX_INVALID", "the shared library must retain its coordination identity");
  return index;
}
