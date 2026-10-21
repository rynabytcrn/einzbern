// SPDX-License-Identifier: Apache-2.0
// Synthetic sequential source observations only, never provider/E4 evidence.
import { dotDigest } from "../../dist/build/packages/core/src/dot-execution.js";
export function contextReadFixture(request, at, root = "/fixture/project") {
  const files = ["agents", "mana-orchestrate", "work"].map((logicalKey, index) => ({ logicalKey, sourceVersion: "fixture-v1", sha256: String(index + 1).repeat(64), readMethod: "fixture.read", evidenceRef: `fixture:read:${logicalKey}` }));
  const record = { schemaVersion: "tcrn.execution-context-read.v1", sessionRef: "fixture:actual-session", readAt: at, workReference: request.workId, workRevision: request.revisionBinding.workRevision, scopeDigest: request.revisionBinding.scopeDigest, files, effectiveRoots: [root] };
  return { record, expected: { sessionRef: record.sessionRef, workReference: record.workReference, workRevision: record.workRevision, scopeDigest: record.scopeDigest, notBefore: at, now: at, files: files.map(({ logicalKey, sourceVersion, sha256 }) => ({ logicalKey, sourceVersion, sha256 })), effectiveRoots: [root] }, observations: files.map(file => ({ sessionRef: record.sessionRef, source: "execution-session", logicalKey: file.logicalKey, evidenceRef: file.evidenceRef, toolName: file.readMethod, readAt: at, sha256: file.sha256, association: "associated" })) };
}
export function preparationFixture(admission, attempt) {
  const payload = { schemaVersion: "tcrn.native-dispatch-preparation.v1", targetDispatchAdmitted: true, context: { workId: attempt.workId, workRevision: attempt.revisionBinding.workRevision, involvedProjects: { state: "selected", targets: [attempt.projectRef] }, contexts: [{ reference: attempt.projectRef, executionAdmission: admission, readiness: { development: { ready: true } }, repositoryContexts: admission.request.contextRead.expected.effectiveRoots.map(projectPath => ({ projectPath })) }] }, admission, attempt };
  return { ...payload, digest: dotDigest(payload) };
}
