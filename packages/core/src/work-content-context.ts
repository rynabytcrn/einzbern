// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { WorkspaceState } from "./workspace.js";
import { effectiveWorkRequirements, workRequirementProblems, readWorkContentImpact } from "./work-requirements.js";
import { workAcceptanceMeaningDigest } from "./work-acceptance.js";
import { storyFields } from "./story-fields.js";
import { workContent, workContentMissing, WorkContentError } from "./work-content.js";

export interface WorkContentContextRecord {
  readonly workId: string;
  readonly externalKey: string;
  readonly workRevision: number;
  readonly relation: "direct" | "inherited";
  readonly kind: WorkspaceState["work"][number]["kind"];
  readonly content: ReturnType<typeof workContent>;
  readonly fields: ReturnType<typeof storyFields>;
  readonly scope: unknown;
  readonly contentImpact: ReturnType<typeof readWorkContentImpact>;
  readonly acceptanceMeaningDigests: Readonly<Record<string, string>>;
  readonly missing: readonly string[];
  readonly sourceStatus: "legacy-unverified" | "complete" | "unverified";
}
export interface WorkContentContext {
  readonly schemaVersion: "tcrn.work-content-context.v1";
  readonly libraryId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly records: readonly WorkContentContextRecord[];
  readonly effectiveRequirements: ReturnType<typeof effectiveWorkRequirements>;
  readonly structureProblems: readonly string[];
  readonly missing: readonly string[];
  readonly complete: boolean;
  readonly semanticVerification: "not-performed";
  readonly note: string;
}
export interface WorkContentContextSegment {
  readonly schemaVersion: "tcrn.work-content-segment.v1";
  readonly workId: string;
  readonly workRevision: number;
  readonly digest: string;
  readonly encoding: "json-text";
  readonly offsetUnit: "unicode-code-point";
  readonly offset: number;
  readonly end: number;
  readonly total: number;
  readonly text: string;
  readonly delivered: { readonly start: number; readonly end: number };
  readonly omitted: readonly { readonly start: number; readonly end: number }[];
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly nextOffset: number | null;
  readonly continuation: { readonly command: "work-content-context"; readonly id: string; readonly offset: number; readonly limit: number; readonly digest: string } | null;
}

/** A read projection, never a second source of requirements or an execution receipt. */
export function workContentContext(state: Pick<WorkspaceState, "work" | "metadata">, workId: string): WorkContentContext {
  const selected = state.work.find(record => record.id === workId && !record.tombstone);
  if (!selected) throw new WorkContentError("WORK_CONTENT_CONTEXT_UNAVAILABLE", `work ${workId} is unavailable`);
  const records: WorkContentContextRecord[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let current: typeof selected | undefined = selected;
  while (current) {
    if (seen.has(current.id)) { missing.push(`ancestor-cycle:${current.id}`); break; }
    seen.add(current.id);
    const content = workContent(current);
    records.push({ workId: current.id, externalKey: current.externalKey, workRevision: current.revision,
      relation: current.id === workId ? "direct" : "inherited", kind: current.kind,
      content, contentImpact: readWorkContentImpact(current),
      acceptanceMeaningDigests: Object.fromEntries((content?.acceptance ?? []).map(acceptance => [acceptance.id, workAcceptanceMeaningDigest(state.work, current!, acceptance.id)])),
      fields: storyFields(current), scope: current.extensions["advisory:scope"]?.value ?? null,
      missing: content === null ? [] : workContentMissing(content, "write"),
      sourceStatus: content === null ? "legacy-unverified" : content.sources.every(source => source.extraction === "complete") && content.sources.length > 0 ? "complete" : "unverified",
    });
    if (current.parentId === null) break;
    const parentId: string = current.parentId;
    current = state.work.find(record => record.id === parentId && !record.tombstone);
    if (!current) missing.push(`ancestor-unavailable:${parentId}`);
  }
  return { schemaVersion: "tcrn.work-content-context.v1" as const, libraryId: state.metadata.workspaceId,
    workId, workRevision: selected.revision, records, effectiveRequirements: effectiveWorkRequirements(state.work, workId),
    structureProblems: workRequirementProblems(state.work, selected), missing, complete: missing.length === 0,
    semanticVerification: "not-performed" as const,
    note: "Ancestor constraints remain authoritative; a child suggestion does not replace them. Complete delivery is not semantic acceptance." };
}

/** Unicode code-point offsets avoid broken UTF-8/surrogate boundaries; digest pins all ancestors too. */
export function workContentContextSegment(context: WorkContentContext, options: { readonly offset?: number; readonly limit?: number; readonly digest?: string } = {}): WorkContentContextSegment {
  const text = JSON.stringify(context);
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (options.digest !== undefined && options.digest !== digest) throw new WorkContentError("WORK_CONTENT_CONTEXT_CHANGED", "Work or ancestor/source content changed; restart at offset 0 and retain the previous digest as evidence.");
  const points = Array.from(text);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? points.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length || !Number.isSafeInteger(limit) || limit < 1) throw new WorkContentError("WORK_CONTENT_CONTEXT_WINDOW_INVALID", "offset must be within the document and limit must be a positive integer");
  if (offset > 0 && options.digest === undefined) throw new WorkContentError("WORK_CONTENT_CONTEXT_DIGEST_REQUIRED", "continuation requires the first segment's --digest");
  const end = Math.min(points.length, offset + limit);
  const truncated = offset > 0 || end < points.length;
  return { schemaVersion: "tcrn.work-content-segment.v1", workId: context.workId, workRevision: context.workRevision,
    digest, encoding: "json-text", offsetUnit: "unicode-code-point", offset, end, total: points.length,
    text: points.slice(offset, end).join(""), delivered: { start: offset, end },
    omitted: [...(offset > 0 ? [{ start: 0, end: offset }] : []), ...(end < points.length ? [{ start: end, end: points.length }] : [])],
    truncated, complete: !truncated && context.complete, nextOffset: end < points.length ? end : null,
    continuation: end < points.length ? { command: "work-content-context", id: context.workId, offset: end, limit, digest } : null };
}
