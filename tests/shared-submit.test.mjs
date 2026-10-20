// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dotDigest } from "../dist/build/packages/core/src/dot-execution.js";
import { planSharedSubmit, validateSharedBaseline, validateSharedSubmitAdvisory, SHARED_SUBMIT_RESERVED_ROOT } from "../dist/build/packages/core/src/shared-submit.js";
const sha = text => createHash("sha256").update(text).digest("hex");
const libraryId = `library:${"a".repeat(24)}`;
const at = minute => `2026-10-20T05:${String(minute).padStart(2, "0")}:00Z`;
function baseline(time = at(0)) {
  const inventory = [{ path: "akasha/device/manifest.json", kind: "file", bytes: 2, sha256: sha("{}") }, { path: "crest/card", kind: "file", bytes: 4, sha256: sha("card") }, { path: "config/project.json", kind: "file", bytes: 2, sha256: sha("{}") }];
  return { schemaVersion: "tcrn.shared-baseline.v1", libraryId, format: 1, minEngine: "3.1.0", canonicalRootRef: "fixture:canonical", completeInventoryRef: "fixture:complete-inventory", completeInventoryDigest: dotDigest(inventory), requiredRoots: ["akasha", "crest", "config"], includedRoots: ["akasha", "crest", "config"], exclusionsWithReasons: [{ path: "artifacts/coordination", reason: "dynamic advisory, not canonical event authority" }], inventory, archiveWitness: null, sourceVersion: 1, head: "a".repeat(64), versionVector: { device: "b".repeat(64) }, capturedAt: at(0), refreshedAt: time, coverageStatus: "complete", atomicSnapshot: false };
}
function fixture() {
  const base = baseline(); const fresh = baseline(at(2)); const digest = dotDigest(fresh);
  return { schemaVersion: "tcrn.shared-submit.v1", operationId: "fixture:operation", libraryId, actor: "agent:fixture", deviceStreamIdentityRef: "fixture:device", workRefs: [{ workId: "work:fixture", revisionBinding: { kind: "revision", workRevision: 1, scopeDigest: "c".repeat(64) } }], baseBaseline: base, refreshedBaseline: fresh, localWorkCompletedAt: at(1), semanticChangePlanDigest: "d".repeat(64), engineReceipts: [{ verb: "work-annotate", actor: "agent:fixture", intentDigest: "d".repeat(64), baseDigest: dotDigest(base), status: "applied", receiptRef: "fixture:engine-receipt", readbackRef: "fixture:local-readback" }], merge: { kind: "engine-reapply", refreshedBaselineDigest: digest, semanticChangePlanDigest: "d".repeat(64), engineOutputMembers: [{ exactPath: "akasha/device/00000001.ndjson", bytes: Buffer.byteLength("fixture-event\n"), sha256: sha("fixture-event\n"), kind: "segment" }, { exactPath: "akasha/device/manifest.json", bytes: Buffer.byteLength("fixture-manifest"), sha256: sha("fixture-manifest"), kind: "manifest" }], receiptRef: "fixture:reapply", readbackRef: "fixture:reapply-readback", status: "verified" }, writerHandoff: { libraryId, operationId: "fixture:operation", status: "confirmed", writerScopeRefs: ["fixture:all-known-writers"], evidenceRef: "fixture:handoff", baselineDigest: digest }, advisory: { schemaVersion: "tcrn.shared-submit-advisory.v1", libraryId, operationId: "fixture:operation", holder: { actor: "agent:fixture", environmentRef: "fixture:environment" }, state: "submitting", baseDigest: digest, handoffEvidenceRef: "fixture:handoff", observedAt: at(2), updatedAt: at(2), previousDigest: "e".repeat(64), releaseEvidenceRef: null }, publicationMembers: [], remoteReadbacks: [], replay: null, release: null, lastError: null };
}
function publish(f, kind, text, minute) {
  const member = { exactPath: `akasha/device/${kind === "segment" ? "00000001.ndjson" : "manifest.json"}`, providerId: `fixture:${kind}-id`, parentId: "fixture:parent-id", bytes: Buffer.byteLength(text), sha256: sha(text), kind, actualReceipt: `fixture:${kind}-receipt`, publishedAt: at(minute) };
  return { ...f, publicationMembers: [...f.publicationMembers, member], remoteReadbacks: [...f.remoteReadbacks, { exactPath: member.exactPath, providerId: member.providerId, parentId: member.parentId, contentBase64: Buffer.from(text).toString("base64"), observedAt: at(minute + 1), evidenceRef: `fixture:${kind}-readback` }] };
}
test("DOT-E03 incremental baseline requires complete inventory, closure and explicit raw links", () => {
  assert.equal(validateSharedBaseline(baseline()).atomicSnapshot, false);
  assert.throws(() => validateSharedBaseline({ ...baseline(), completeInventoryDigest: "f".repeat(64) }));
  assert.throws(() => validateSharedBaseline({ ...baseline(), includedRoots: ["akasha"] }));
  const b = baseline(); b.inventory.push({ path: "crest/link", kind: "link-raw", bytes: 4, sha256: sha("dest") }); b.completeInventoryDigest = dotDigest(b.inventory);
  assert.throws(() => validateSharedBaseline(b), /link representation/u);
});
test("DOT-E03 occupied waits, unknown or absent advisory is not free, and no lease/fencing fields exist", () => {
  const f = fixture();
  assert.equal(planSharedSubmit({ ...f, writerHandoff: { ...f.writerHandoff, status: "occupied" } }).status, "waiting");
  assert.equal(planSharedSubmit({ ...f, writerHandoff: null }).status, "pending");
  assert.equal(planSharedSubmit({ ...f, advisory: null }).reasonCodes[0], "ADVISORY_UNKNOWN");
  assert.throws(() => validateSharedSubmitAdvisory({ ...f.advisory, leaseExpiresAt: at(30) }));
  assert.equal(SHARED_SUBMIT_RESERVED_ROOT.relativePath, "artifacts/coordination/shared-submit");
});
test("DOT-E03 freshness and engine reapplication do not permit event splicing", () => {
  const f = fixture();
  assert.equal(planSharedSubmit({ ...f, refreshedBaseline: null }).status, "pending");
  assert.equal(planSharedSubmit({ ...f, refreshedBaseline: baseline() }).reasonCodes[0], "REFRESH_STALE_OR_INCOMPATIBLE");
  assert.equal(planSharedSubmit({ ...f, merge: { ...f.merge, kind: "splice-events" } }).reasonCodes[0], "SUPPORTED_REPLAY_OR_REAPPLICATION_REQUIRED");
  assert.equal(planSharedSubmit({ ...f, engineReceipts: [{ ...f.engineReceipts[0], status: "unknown" }] }).status, "pending");
});
test("DOT-E03 segments are read back before manifest; remote byte corruption is rejected", () => {
  const f = fixture(); assert.equal(planSharedSubmit(f).phase, "publishing-segments");
  const segment = publish(f, "segment", "fixture-event\n", 3);
  assert.equal(planSharedSubmit(segment).phase, "segments-verified");
  assert.equal(planSharedSubmit({ ...segment, remoteReadbacks: [] }).phase, "publishing-segments");
  assert.throws(() => planSharedSubmit({ ...segment, remoteReadbacks: [{ ...segment.remoteReadbacks[0], contentBase64: Buffer.from("corrupt").toString("base64") }] }), /mismatch/u);
  const earlyManifest = publish(segment, "manifest", "fixture-manifest", 3);
  assert.equal(planSharedSubmit(earlyManifest).reasonCodes[0], "MANIFEST_PUBLISHED_BEFORE_SEGMENT_VERIFICATION");
});
test("DOT-E03 local/remote/replay/release remain separate, and release unknown stays pending", () => {
  const remote = publish(publish(fixture(), "segment", "fixture-event\n", 3), "manifest", "fixture-manifest", 5);
  assert.equal(planSharedSubmit(remote).phase, "remote-verified");
  const replayed = { ...remote, replay: { libraryId, operationId: remote.operationId, status: "verified", receiptRef: "fixture:independent-replay", readbackRefs: ["fixture:work-readback"], memberSetDigest: dotDigest(remote.publicationMembers), observedAt: at(7) } };
  assert.equal(planSharedSubmit(replayed).status, "pending-release");
  const release = { status: "observed", evidenceRef: "fixture:release", operationId: remote.operationId, observedAt: at(8) };
  const complete = { ...replayed, release, advisory: { ...remote.advisory, state: "released", releaseEvidenceRef: release.evidenceRef, updatedAt: at(8) } };
  assert.equal(planSharedSubmit(complete).status, "complete");
  assert.equal(planSharedSubmit({ ...complete, release: { ...release, status: "unknown" } }).status, "pending-release");
});
test("DOT-E03 duplicate/conflicting publication identities and wrong parent refuse", () => {
  const f = publish(fixture(), "segment", "fixture-event\n", 3);
  assert.throws(() => planSharedSubmit({ ...f, publicationMembers: [...f.publicationMembers, f.publicationMembers[0]] }), /duplicate/u);
  assert.throws(() => planSharedSubmit({ ...f, remoteReadbacks: [{ ...f.remoteReadbacks[0], parentId: "fixture:wrong-parent" }] }), /mismatch/u);
});
test("DOT-E03 unknown publication requires querying before retry; different writer is never evicted by age", () => {
  const f = fixture();
  const uncertain = planSharedSubmit({ ...f, lastError: { phase: "publishing-segments", message: "fixture:timeout", outcome: "unknown" } });
  assert.equal(uncertain.status, "pending"); assert.match(uncertain.next, /query/u);
  assert.equal(planSharedSubmit({ ...f, advisory: { ...f.advisory, operationId: "fixture:other-operation", observedAt: "2020-01-01T00:00:00Z" } }).status, "waiting");
});

test("DOT-E03 duplicate actual publication return is idempotent and conflict bytes are retained", async () => {
  const { appendSharedPublicationMember } = await import("../dist/build/packages/core/src/shared-submit.js");
  const f = publish(fixture(), "segment", "fixture-event\n", 3); const member = f.publicationMembers[0];
  const duplicate = appendSharedPublicationMember(f.publicationMembers, member); assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.members.length, 1);
  const conflict = appendSharedPublicationMember(f.publicationMembers, { ...member, sha256: "f".repeat(64) }); assert.equal(conflict.status, "conflict"); assert.equal(conflict.conflictingReturn.sha256, "f".repeat(64)); assert.equal(conflict.members[0].sha256, member.sha256);
});
