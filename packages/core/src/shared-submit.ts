// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { canonicalJson } from "../../protocol/src/index.js";
import { dotDigest, dotInstant, dotObject, dotRefs, dotSha, dotText, validateRevisionBinding } from "./dot-execution.js";
import type { RevisionBinding } from "./dot-execution.js";
import { openLibrary } from "./ether-library.js";
import { assertLibraryWritable, withWorkspaceWriteLock } from "./workspace.js";
import type { WorkspaceWriteLockOptions } from "./workspace.js";
import { writeFileAtomic } from "./atomic-file.js";
import { pathIsInside } from "./path-containment.js";
import { deviceHome } from "./device-home.js";
import { readRegistry } from "./registry.js";
import { DIRECTORY } from "./names.js";

export const SHARED_SUBMIT_RESERVED_ROOT = Object.freeze({ relativePath: `${DIRECTORY.artifacts}/coordination/shared-submit`, advisoryName: "advisory.json", authority: "dynamic-advisory-not-canonical-events", cleanup: "preserve; never a generated output or configuration backup member" });
export interface SharedBaseline {
  readonly schemaVersion: "tcrn.shared-baseline.v1"; readonly libraryId: string; readonly format: number; readonly minEngine: string;
  readonly canonicalRootRef: string; readonly completeInventoryRef: string; readonly completeInventoryDigest: string;
  readonly requiredRoots: readonly string[]; readonly includedRoots: readonly string[];
  readonly exclusionsWithReasons: readonly { readonly path: string; readonly reason: string }[];
  readonly inventory: readonly { readonly path: string; readonly bytes: number; readonly sha256: string; readonly kind: "file" | "link-raw"; readonly linkRepresentation?: string }[];
  readonly archiveWitness: { readonly ref: string; readonly sha256: string } | null;
  readonly sourceVersion: number; readonly head: string; readonly versionVector: Readonly<Record<string, string>>;
  readonly capturedAt: string; readonly refreshedAt: string; readonly coverageStatus: "complete" | "unknown"; readonly atomicSnapshot: false;
}
export interface SharedSubmitAdvisory {
  readonly schemaVersion: "tcrn.shared-submit-advisory.v1"; readonly libraryId: string; readonly operationId: string;
  readonly holder: { readonly actor: string; readonly environmentRef: string };
  readonly state: "announced" | "waiting" | "submitting" | "released" | "unknown";
  readonly baseDigest: string; readonly handoffEvidenceRef: string | null; readonly observedAt: string; readonly updatedAt: string;
  readonly previousDigest: string | null; readonly releaseEvidenceRef: string | null;
}
export interface SharedSemanticReceipt {
  readonly verb: string; readonly actor: string; readonly intentDigest: string; readonly baseDigest: string;
  readonly status: "applied" | "already-present" | "refused" | "unknown"; readonly receiptRef: string; readonly readbackRef: string | null;
}
export interface SharedPublicationMember {
  readonly exactPath: string; readonly providerId: string; readonly parentId: string; readonly bytes: number; readonly sha256: string;
  readonly kind: "segment" | "manifest"; readonly actualReceipt: string; readonly publishedAt: string;
}
export interface SharedRemoteReadback {
  readonly exactPath: string; readonly providerId: string; readonly parentId: string; readonly contentBase64: string;
  readonly observedAt: string; readonly evidenceRef: string;
}
export interface SharedSubmitInput {
  readonly schemaVersion: "tcrn.shared-submit.v1"; readonly operationId: string; readonly libraryId: string; readonly actor: string; readonly deviceStreamIdentityRef: string;
  readonly workRefs: readonly { readonly workId: string; readonly revisionBinding: RevisionBinding }[];
  readonly baseBaseline: SharedBaseline; readonly refreshedBaseline: SharedBaseline | null; readonly localWorkCompletedAt: string;
  readonly semanticChangePlanDigest: string; readonly engineReceipts: readonly SharedSemanticReceipt[];
  readonly merge: { readonly kind: "engine-replay" | "engine-reapply"; readonly refreshedBaselineDigest: string; readonly semanticChangePlanDigest: string; readonly engineOutputMembers: readonly Pick<SharedPublicationMember, "exactPath" | "bytes" | "sha256" | "kind">[]; readonly receiptRef: string; readonly readbackRef: string; readonly status: "verified" | "unknown" | "refused" } | null;
  readonly writerHandoff: { readonly libraryId: string; readonly operationId: string; readonly status: "confirmed" | "occupied" | "unknown"; readonly writerScopeRefs: readonly string[]; readonly evidenceRef: string; readonly baselineDigest: string } | null;
  readonly advisory: SharedSubmitAdvisory | null;
  readonly publicationMembers: readonly SharedPublicationMember[]; readonly remoteReadbacks: readonly SharedRemoteReadback[];
  readonly replay: { readonly libraryId: string; readonly operationId: string; readonly status: "verified" | "unknown" | "failed"; readonly receiptRef: string; readonly readbackRefs: readonly string[]; readonly memberSetDigest: string; readonly observedAt: string } | null;
  readonly release: { readonly status: "observed" | "unknown"; readonly evidenceRef: string; readonly operationId: string; readonly observedAt: string } | null;
  readonly lastError: { readonly phase: string; readonly message: string; readonly outcome: "not-executed" | "unknown" | "failed" } | null;
}
export interface SharedSubmitAssessment { readonly phase: "baseline-ready" | "local-work" | "refresh-ready" | "merge-ready" | "handoff-confirmed" | "publishing-segments" | "segments-verified" | "publishing-manifest" | "remote-verified" | "replay-verified" | "release-observed"; readonly status: "ready" | "waiting" | "pending" | "pending-release" | "refused" | "complete"; readonly reasonCodes: readonly string[]; readonly next: string; readonly atomicity: "none-cross-device"; readonly localLockRequired: true }
export class SharedSubmitError extends Error { readonly reasonCode = "SHARED_SUBMIT_INVALID"; }
function fail(message: string): never { throw new SharedSubmitError(message); }
function safePath(value: unknown): asserts value is string { dotText(value, "relative path"); if (value.startsWith("/") || /[\\:\u0000-\u001f]/u.test(value) || value.split("/").some(p => p === "." || p === ".." || p === "")) fail("unsafe relative path"); }
export function validateSharedBaseline(value: unknown): SharedBaseline {
  const b = dotObject(value, "baseline", ["schemaVersion", "libraryId", "format", "minEngine", "canonicalRootRef", "completeInventoryRef", "completeInventoryDigest", "requiredRoots", "includedRoots", "exclusionsWithReasons", "inventory", "archiveWitness", "sourceVersion", "head", "versionVector", "capturedAt", "refreshedAt", "coverageStatus", "atomicSnapshot"]);
  if (b.schemaVersion !== "tcrn.shared-baseline.v1" || !/^(library|workspace):[a-f0-9]{24}$/u.test(String(b.libraryId)) || b.atomicSnapshot !== false || !["complete", "unknown"].includes(String(b.coverageStatus))) fail("baseline identity, coverage and non-atomic observation required");
  for (const key of ["canonicalRootRef", "completeInventoryRef", "minEngine"]) dotText(b[key], key);
  for (const key of ["completeInventoryDigest", "head"]) dotSha(b[key], key);
  for (const key of ["format", "sourceVersion"]) if (!Number.isSafeInteger(b[key]) || Number(b[key]) < 1) fail(`${key} must be positive`);
  dotRefs(b.requiredRoots, "requiredRoots", true); dotRefs(b.includedRoots, "includedRoots", true);
  for (const root of [...b.requiredRoots, ...b.includedRoots]) safePath(root);
  if (b.requiredRoots.some(root => !(b.includedRoots as readonly string[]).includes(root))) fail("required canonical closure is missing");
  if (!Array.isArray(b.inventory) || !b.inventory.length || !Array.isArray(b.exclusionsWithReasons)) fail("complete inventory and explicit exclusions required");
  const paths = new Set<string>();
  for (const item of b.inventory) {
    const i = dotObject(item, "inventory member", ["path", "bytes", "sha256", "kind", "linkRepresentation"]); safePath(i.path); dotSha(i.sha256, "inventory sha256");
    if (paths.has(i.path) || !Number.isSafeInteger(i.bytes) || Number(i.bytes) < 0 || !["file", "link-raw"].includes(String(i.kind))) fail("inventory member duplicate or invalid");
    paths.add(i.path); if (i.kind === "link-raw") dotText(i.linkRepresentation, "unfollowed link representation");
  }
  if (dotDigest(b.inventory) !== b.completeInventoryDigest) fail("complete inventory digest mismatch");
  for (const raw of b.exclusionsWithReasons) { const e = dotObject(raw, "exclusion", ["path", "reason"]); safePath(e.path); dotText(e.reason, "exclusion reason"); if (b.requiredRoots.some(root => e.path === root || root.startsWith(`${String(e.path)}/`))) fail("cannot exclude a required closure root"); }
  dotObject(b.versionVector, "versionVector", Object.keys((b.versionVector ?? {}) as object));
  for (const hash of Object.values(b.versionVector as Record<string, unknown>)) dotSha(hash, "stream head");
  if (dotInstant(b.refreshedAt, "refreshedAt") < dotInstant(b.capturedAt, "capturedAt")) fail("refresh predates capture");
  if (b.archiveWitness !== null) { const a = dotObject(b.archiveWitness, "archiveWitness", ["ref", "sha256"]); dotText(a.ref, "archive ref"); dotSha(a.sha256, "archive digest"); }
  return value as SharedBaseline;
}
export function validateSharedSubmitAdvisory(value: unknown): SharedSubmitAdvisory {
  const a = dotObject(value, "advisory", ["schemaVersion", "libraryId", "operationId", "holder", "state", "baseDigest", "handoffEvidenceRef", "observedAt", "updatedAt", "previousDigest", "releaseEvidenceRef"]);
  if (a.schemaVersion !== "tcrn.shared-submit-advisory.v1" || !/^(library|workspace):[a-f0-9]{24}$/u.test(String(a.libraryId)) || !["announced", "waiting", "submitting", "released", "unknown"].includes(String(a.state))) fail("invalid advisory");
  dotText(a.operationId, "operationId"); const h = dotObject(a.holder, "holder", ["actor", "environmentRef"]); dotText(h.actor, "actual actor"); dotText(h.environmentRef, "actual environment"); dotSha(a.baseDigest, "baseDigest");
  if (a.previousDigest !== null) dotSha(a.previousDigest, "previousDigest");
  if (dotInstant(a.updatedAt, "updatedAt") < dotInstant(a.observedAt, "observedAt")) fail("advisory update predates observation");
  if (a.handoffEvidenceRef !== null) dotText(a.handoffEvidenceRef, "handoffEvidenceRef");
  if (a.releaseEvidenceRef !== null) dotText(a.releaseEvidenceRef, "releaseEvidenceRef");
  if (a.state === "submitting" && a.handoffEvidenceRef === null || a.state === "released" && a.releaseEvidenceRef === null) fail("submitting/released advisory requires actual evidence");
  return value as SharedSubmitAdvisory;
}
/** Assess supported semantic receipts and sequential publication; never execute or splice changes. */
export function planSharedSubmit(value: SharedSubmitInput): SharedSubmitAssessment {
  const v = dotObject(value, "submission", ["schemaVersion", "operationId", "libraryId", "actor", "deviceStreamIdentityRef", "workRefs", "baseBaseline", "refreshedBaseline", "localWorkCompletedAt", "semanticChangePlanDigest", "engineReceipts", "merge", "writerHandoff", "advisory", "publicationMembers", "remoteReadbacks", "replay", "release", "lastError"]);
  if (v.schemaVersion !== "tcrn.shared-submit.v1") fail("unsupported submission version");
  for (const key of ["operationId", "libraryId", "actor", "deviceStreamIdentityRef"]) dotText(v[key], key);
  dotSha(v.semanticChangePlanDigest, "semanticChangePlanDigest"); dotInstant(v.localWorkCompletedAt, "localWorkCompletedAt");
  if (!Array.isArray(v.workRefs) || !v.workRefs.length) fail("bound work references required");
  for (const raw of v.workRefs) { const w = dotObject(raw, "workRef", ["workId", "revisionBinding"]); dotText(w.workId, "workId"); validateRevisionBinding(w.revisionBinding); }
  for (const key of ["engineReceipts", "publicationMembers", "remoteReadbacks"]) if (!Array.isArray(v[key])) fail(`${key} must be an array`);
  const result = (phase: SharedSubmitAssessment["phase"], status: SharedSubmitAssessment["status"], reason: string, next: string): SharedSubmitAssessment => ({ phase, status, reasonCodes: [reason], next, atomicity: "none-cross-device", localLockRequired: true });
  const base = validateSharedBaseline(value.baseBaseline);
  if (base.libraryId !== value.libraryId || base.coverageStatus !== "complete") return result("baseline-ready", "pending", "BASELINE_INCOMPLETE_OR_DIFFERENT", "obtain a complete same-library baseline");
  if (!value.engineReceipts.length) return result("local-work", "pending", "ENGINE_SEMANTIC_RECEIPTS_REQUIRED", "perform supported semantic operations locally");
  for (const receipt of value.engineReceipts) {
    dotObject(receipt, "engine receipt", ["verb", "actor", "intentDigest", "baseDigest", "status", "receiptRef", "readbackRef"]);
    dotText(receipt.verb, "engine verb"); dotSha(receipt.intentDigest, "intentDigest"); dotText(receipt.receiptRef, "engine receipt ref");
    if (receipt.actor !== value.actor || receipt.baseDigest !== dotDigest(base) || !["applied", "already-present"].includes(receipt.status) || !receipt.readbackRef) return result("local-work", "pending", "SEMANTIC_RESULT_NOT_READ_BACK", "resolve actual engine outcome without recreating existing IDs");
  }
  if (value.refreshedBaseline === null) return result("refresh-ready", "pending", "FRESH_COMPLETE_BASELINE_REQUIRED", "refresh complete baseline once before submitting");
  const fresh = validateSharedBaseline(value.refreshedBaseline); const freshDigest = dotDigest(fresh);
  if (fresh.libraryId !== base.libraryId || fresh.format !== base.format || fresh.sourceVersion < base.sourceVersion || fresh.minEngine !== base.minEngine || fresh.coverageStatus !== "complete" || dotInstant(fresh.refreshedAt, "refresh") < dotInstant(value.localWorkCompletedAt, "localWorkCompletedAt")) return result("refresh-ready", "refused", "REFRESH_STALE_OR_INCOMPATIBLE", "refresh and reassess work revisions");
  const merge = value.merge;
  if (merge !== null) dotObject(merge, "merge", ["kind", "refreshedBaselineDigest", "semanticChangePlanDigest", "engineOutputMembers", "receiptRef", "readbackRef", "status"]);
  if (merge === null || !["engine-replay", "engine-reapply"].includes(merge.kind) || merge.status !== "verified" || merge.refreshedBaselineDigest !== freshDigest || merge.semanticChangePlanDigest !== value.semanticChangePlanDigest || !merge.receiptRef || !merge.readbackRef) return result("merge-ready", "pending", "SUPPORTED_REPLAY_OR_REAPPLICATION_REQUIRED", "use engine semantic replay/reapplication, never splice stale hashes");
  if (!Array.isArray(merge.engineOutputMembers) || !merge.engineOutputMembers.some(item => item.kind === "segment") || !merge.engineOutputMembers.some(item => item.kind === "manifest")) fail("supported merge must identify the complete engine output member plan");
  const plannedPaths = new Set<string>();
  for (const item of merge.engineOutputMembers) {
    dotObject(item, "engine output member", ["exactPath", "bytes", "sha256", "kind"]); safePath(item.exactPath); dotSha(item.sha256, "engine output digest");
    if (plannedPaths.has(item.exactPath) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !["segment", "manifest"].includes(item.kind)) fail("invalid engine output member plan");
    plannedPaths.add(item.exactPath);
  }
  const handoff = value.writerHandoff;
  if (handoff !== null) { dotObject(handoff, "writerHandoff", ["libraryId", "operationId", "status", "writerScopeRefs", "evidenceRef", "baselineDigest"]); dotRefs(handoff.writerScopeRefs, "writerScopeRefs"); }
  if (handoff?.status === "occupied") return result("handoff-confirmed", "waiting", "WRITER_OCCUPIED", "wait for the actual current writer");
  if (!handoff || handoff.status !== "confirmed" || handoff.libraryId !== value.libraryId || handoff.operationId !== value.operationId || handoff.baselineDigest !== freshDigest || !handoff.evidenceRef || !handoff.writerScopeRefs.length) return result("handoff-confirmed", "pending", "CURRENT_SERIAL_HANDOFF_REQUIRED", "confirm this operation's actual writer scope and handoff");
  if (!value.advisory) return result("handoff-confirmed", "pending", "ADVISORY_UNKNOWN", "read the same library advisory; absence is not free");
  const advisory = validateSharedSubmitAdvisory(value.advisory);
  if (advisory.libraryId !== value.libraryId || advisory.operationId !== value.operationId || advisory.holder.actor !== value.actor || advisory.baseDigest !== freshDigest || advisory.handoffEvidenceRef !== handoff.evidenceRef) return result("handoff-confirmed", "waiting", "ADVISORY_DIFFERENT_WRITER_OR_OPERATION", "resolve current writer; never take over by age");
  if (advisory.state === "announced") return result("handoff-confirmed", value.publicationMembers.length ? "refused" : "ready", "ADVISORY_NOT_SUBMITTING", "read back this operation as submitting before publication");
  if (advisory.state === "unknown" || advisory.state === "waiting") return result("handoff-confirmed", "pending", "ADVISORY_NOT_SUBMITTING", "resolve coordination state");
  if (value.lastError !== null) { dotObject(value.lastError, "lastError", ["phase", "message", "outcome"]); dotText(value.lastError.message, "last error"); }
  if (value.lastError !== null) return result("publishing-segments", value.lastError.outcome === "unknown" ? "pending" : "refused", "PUBLICATION_OUTCOME_UNRESOLVED", "query actual provider ID/parent/content before retrying");
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const member of value.publicationMembers) {
    dotObject(member, "publication member", ["exactPath", "providerId", "parentId", "bytes", "sha256", "kind", "actualReceipt", "publishedAt"]);
    safePath(member.exactPath); dotSha(member.sha256, "publication digest"); dotText(member.providerId, "providerId"); dotText(member.parentId, "parentId"); dotText(member.actualReceipt, "actualReceipt"); dotInstant(member.publishedAt, "publishedAt");
    if (!Number.isSafeInteger(member.bytes) || member.bytes < 0 || !["segment", "manifest"].includes(member.kind) || paths.has(member.exactPath) || ids.has(member.providerId)) fail("duplicate or invalid publication member");
    if (!member.exactPath.startsWith(`${DIRECTORY.events}/`) || member.kind === "manifest" && !member.exactPath.endsWith("/manifest.json") || member.kind === "segment" && !member.exactPath.endsWith(".ndjson")) fail("publication must be actual engine event segments or their manifests");
    const planned = merge.engineOutputMembers.find(item => item.exactPath === member.exactPath);
    if (planned === undefined || planned.kind !== member.kind || planned.bytes !== member.bytes || planned.sha256 !== member.sha256) fail("published member differs from supported engine output");
    paths.add(member.exactPath); ids.add(member.providerId);
  }
  const segments = value.publicationMembers.filter(member => member.kind === "segment"); const manifests = value.publicationMembers.filter(member => member.kind === "manifest");
  if (segments.length !== merge.engineOutputMembers.filter(item => item.kind === "segment").length) return result("publishing-segments", "pending", "SEGMENTS_NOT_PUBLISHED", "publish actual engine-produced segments first");
  const readback = (member: SharedPublicationMember): SharedRemoteReadback | undefined => {
    const reads = value.remoteReadbacks.filter(item => item.providerId === member.providerId);
    for (const item of reads) {
      dotObject(item, "readback", ["exactPath", "providerId", "parentId", "contentBase64", "observedAt", "evidenceRef"]); dotText(item.evidenceRef, "readback evidence");
      const bytes = Buffer.from(item.contentBase64, "base64");
      if (bytes.toString("base64") !== item.contentBase64 || item.exactPath !== member.exactPath || item.parentId !== member.parentId || bytes.length !== member.bytes || createHash("sha256").update(bytes).digest("hex") !== member.sha256 || dotInstant(item.observedAt, "readback at") < dotInstant(member.publishedAt, "publishedAt")) fail("remote byte/ID/parent/time readback mismatch");
    }
    return reads[0];
  };
  const segmentReads = segments.map(readback);
  if (segmentReads.some(item => !item)) return result("publishing-segments", "pending", "SEGMENT_READBACK_REQUIRED", "read every published segment by actual ID and verify bytes");
  if (manifests.length !== merge.engineOutputMembers.filter(item => item.kind === "manifest").length) return result("segments-verified", "ready", "SEGMENTS_VERIFIED", "publish manifest last");
  for (const manifest of manifests) if (segmentReads.some(item => dotInstant(item!.observedAt, "segment read") > dotInstant(manifest.publishedAt, "manifest publish"))) return result("publishing-manifest", "refused", "MANIFEST_PUBLISHED_BEFORE_SEGMENT_VERIFICATION", "preserve failure; reconcile actual remote state");
  if (manifests.some(item => !readback(item))) return result("publishing-manifest", "pending", "MANIFEST_READBACK_REQUIRED", "read each manifest's actual bytes");
  const replay = value.replay;
  if (replay !== null) { dotObject(replay, "replay", ["libraryId", "operationId", "status", "receiptRef", "readbackRefs", "memberSetDigest", "observedAt"]); dotRefs(replay.readbackRefs, "replay.readbackRefs"); }
  if (value.release !== null) dotObject(value.release, "release", ["status", "evidenceRef", "operationId", "observedAt"]);
  if (!replay || replay.status !== "verified" || replay.libraryId !== value.libraryId || replay.operationId !== value.operationId || replay.memberSetDigest !== dotDigest(value.publicationMembers) || !replay.receiptRef || !replay.readbackRefs.length || value.remoteReadbacks.some(item => dotInstant(item.observedAt, "readback") > dotInstant(replay.observedAt, "replay"))) return result("remote-verified", "pending", "INDEPENDENT_REPLAY_REQUIRED", "replay a complete consumable destination copy and read bound records");
  if (!value.release || value.release.status !== "observed" || value.release.operationId !== value.operationId || !value.release.evidenceRef || advisory.state !== "released" || advisory.releaseEvidenceRef !== value.release.evidenceRef || dotInstant(value.release.observedAt, "release") < dotInstant(replay.observedAt, "replay")) return result("replay-verified", "pending-release", "RELEASE_NOT_OBSERVED", "read actual released coordination state; do not declare free");
  return result("release-observed", "complete", "SHARED_SUBMIT_VERIFIED", "retain baseline, semantic, publication and replay evidence separately");
}

async function advisoryDirectory(rootInput: string, create: boolean, home: string): Promise<string> {
  const root = await realpath(resolve(rootInput));
  if (pathIsInside(resolve(home), root)) fail("advisory cannot be placed in device storage");
  // Repository cleaners own dist; reject placement there instead of changing their scope.
  for (let parent = root; ; parent = dirname(parent)) {
    if (basename(parent) === "dist") fail("advisory root cannot live in generated output");
    if (dirname(parent) === parent) break;
  }
  for (const entry of (await readRegistry(home)).entries) if (pathIsInside(resolve(entry.projectPath, "dist"), root)) fail("advisory root overlaps registered generated output");
  let current = root;
  for (const part of SHARED_SUBMIT_RESERVED_ROOT.relativePath.split("/")) {
    current = join(current, part);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("advisory path must contain only actual directories");
  }
  return current;
}
async function readAdvisoryAt(directory: string): Promise<SharedSubmitAdvisory | null> {
  let file;
  try { file = await open(join(directory, SHARED_SUBMIT_RESERVED_ROOT.advisoryName), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1) fail("advisory must be an ordinary single-link file"); return validateSharedSubmitAdvisory(JSON.parse(await file.readFile("utf8")) as unknown); }
  finally { await file.close(); }
}
export async function readSharedSubmitAdvisory(root: string, home: string = deviceHome()): Promise<{ readonly advisory: SharedSubmitAdvisory | null; readonly availability: "observed" | "absent-not-free" }> {
  const library = await openLibrary(root);
  let advisory: SharedSubmitAdvisory | null;
  try { advisory = await readAdvisoryAt(await advisoryDirectory(library.root, false, home)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; advisory = null; }
  if (advisory !== null && advisory.libraryId !== library.manifest.libraryId) fail("advisory names a different library");
  return { advisory, availability: advisory === null ? "absent-not-free" : "observed" };
}
/** Local serialized advisory update/readback only. Not an acquire, lease, CAS or fencing service. */
export async function writeSharedSubmitAdvisory(root: string, value: SharedSubmitAdvisory, options: { readonly actor: string; readonly handoffEvidenceRef: string; readonly storageAuditEvidenceRef: string; readonly home?: string; readonly writeLockOptions?: WorkspaceWriteLockOptions }): Promise<{ readonly advisory: SharedSubmitAdvisory; readonly digest: string; readonly guarantee: "local-readback-only-not-distributed-exclusion" }> {
  const input = validateSharedSubmitAdvisory(value);
  dotText(options.actor, "actual actor"); dotText(options.handoffEvidenceRef, "current handoff evidence"); dotText(options.storageAuditEvidenceRef, "reserved-root integration audit");
  if (input.holder.actor !== options.actor || input.handoffEvidenceRef !== options.handoffEvidenceRef) fail("advisory actual actor or current handoff differs");
  await assertLibraryWritable(root);
  return withWorkspaceWriteLock(root, async lockedRoot => {
    const library = await openLibrary(lockedRoot); if (library.manifest.libraryId !== input.libraryId) fail("advisory library identity mismatch");
    const directory = await advisoryDirectory(library.root, true, options.home ?? deviceHome());
    const previous = await readAdvisoryAt(directory);
    if (previous !== null && dotDigest(previous) === dotDigest(input)) return { advisory: previous, digest: dotDigest(previous), guarantee: "local-readback-only-not-distributed-exclusion" as const };
    if (input.previousDigest !== (previous === null ? null : dotDigest(previous))) fail("local observation changed; reread, not distributed CAS");
    if (previous !== null && (previous.operationId !== input.operationId || dotDigest(previous.holder) !== dotDigest(input.holder)) && previous.state !== "released") fail("other or unknown writer remains; no age-based takeover");
    if (previous === null && input.state !== "announced") fail("initial advisory must announce, not infer an acquired/free state");
    if (previous && dotInstant(input.updatedAt, "updatedAt") < dotInstant(previous.updatedAt, "previous updatedAt")) fail("stale advisory update");
    await writeFileAtomic(join(directory, SHARED_SUBMIT_RESERVED_ROOT.advisoryName), canonicalJson(input));
    const readback = await readAdvisoryAt(directory);
    if (readback === null || dotDigest(readback) !== dotDigest(input)) fail("advisory write outcome uncertain; query before retry");
    return { advisory: readback, digest: dotDigest(readback), guarantee: "local-readback-only-not-distributed-exclusion" as const };
  }, options.writeLockOptions ?? {});
}

/** Repeated identical provider returns are observations, not a second publication command. */
export function appendSharedPublicationMember(existing: readonly SharedPublicationMember[], returned: SharedPublicationMember): { readonly status: "appended" | "duplicate" | "conflict"; readonly members: readonly SharedPublicationMember[]; readonly conflictingReturn: SharedPublicationMember | null } {
  const prior = existing.find(member => member.providerId === returned.providerId || member.exactPath === returned.exactPath);
  if (prior === undefined) return { status: "appended", members: [...existing, returned], conflictingReturn: null };
  if (dotDigest(prior) === dotDigest(returned)) return { status: "duplicate", members: existing, conflictingReturn: null };
  return { status: "conflict", members: existing, conflictingReturn: returned };
}
