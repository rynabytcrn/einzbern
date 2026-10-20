// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { DOT_REQUIRED_CHECKS, resolveDotExecutionAdmission, dotDigest } from "../dist/build/packages/core/src/dot-execution.js";
import { createNativeToolAttempt, recordNativeToolResponse, normalizeNativeToolEvidence, appendNativeToolRecord } from "../dist/build/packages/core/src/native-tool-evidence.js";
import { contextReadFixture, preparationFixture } from "./helpers/dot-native-fixture.mjs";
const at = "2026-10-20T05:00:00Z";
function fixture() {
  const request = { mode: "dot-autonomous", executionTarget: "chatgpt-dot", libraryId: `library:${"a".repeat(24)}`, projectRef: { libraryId: `library:${"a".repeat(24)}`, projectId: `project:${"b".repeat(24)}` }, workId: `work:${"c".repeat(24)}`, revisionBinding: { kind: "revision", workRevision: 1, scopeDigest: "d".repeat(64) }, requestedAgents: 1, requiredTools: ["native.fixture"], actualCapabilityEvidenceRefs: ["fixture:capability"], authorizationEvidenceRef: "fixture:authorization", checks: Object.fromEntries(DOT_REQUIRED_CHECKS.map(name => [name, { status: "pass", evidenceRefs: [`fixture:${name}`], reason: "synthetic test evidence only" }])), occupancyObservation: { status: "observed", activeAgents: 0, includesParent: true, parentActive: false, platformLimit: 4, observedAt: at, evidenceRef: "fixture:occupancy" }, modelObservation: { status: "unavailable", reason: "not exposed" } };
  request.contextRead = contextReadFixture(request, at);
  const admission = resolveDotExecutionAdmission(request, { deviceLimit: 4, now: at, contextDigest: "e".repeat(64) });
  const attempt = createNativeToolAttempt(admission, { toolName: "native.fixture", toolContractObservation: { ref: "fixture:contract", sha256: "f".repeat(64) }, requestedAt: at, argumentsValue: { task: "fixture" } });
  const response = { sourceTool: "native.fixture", rawResponseRef: "fixture:raw", rawResponseValue: { id: "provider-real-fixture", event: "event-1", state: "completed", terminal: true }, observedAt: "2026-10-20T05:00:01Z", executionStatus: "reported-completed", statusPointer: "/state", statusMapping: { completed: "reported-completed", accepted: "accepted", failed: "failed" }, providerPointers: { providerRef: "/id", providerEventRef: "/event" }, resultRefs: ["fixture:deliverable"], association: { status: "associated", invocationRef: "fixture:invocation", responseRef: "fixture:raw", argumentsDigest: attempt.argumentsDigest, evidenceRefs: ["fixture:association"], reason: "fixture invocation and response pair" }, verification: { status: "pass", evidenceRefs: ["fixture:independent-check"], verifiedAt: "2026-10-20T05:00:02Z", verifiedBy: "fixture:reviewer" } };
  return { admission, attempt, response, preparation: preparationFixture(admission, attempt) };
}
function record(f, response = f.response) { return { preparation: f.preparation, admission: f.admission, attempt: f.attempt, response, evidence: recordNativeToolResponse(f.attempt, f.admission, response) }; }
const terminal = { jsonPointer: "/terminal", terminalValues: ["true"], contractRef: "fixture:contract", evidenceRef: "fixture:terminal" };
test("DOT-E01/E03 pending has no response or provider ID; retries use separate local IDs", () => {
  const f = fixture(); const pending = normalizeNativeToolEvidence({ preparation: f.preparation, attempt: f.attempt, admission: f.admission });
  assert.equal(pending.valid, true); assert.equal(pending.complete, false); assert.equal(pending.status, "pending"); assert.equal(pending.executionResponsibility, "retained");
  assert.notEqual(f.attempt.attemptId, fixture().attempt.attemptId);
  assert.throws(() => record(f, { ...f.response, rawResponseValue: {} }), /actual response/u);
});
test("DOT-E01 native forbids process fields and extracts provider fields from actual source", () => {
  const f = fixture(); const r = record(f);
  assert.equal(r.evidence.providerRef.value, "provider-real-fixture"); assert.notEqual(r.evidence.providerRef.value, f.attempt.attemptId);
  assert.throws(() => record(f, { ...f.response, exitCode: 0 }));
  assert.throws(() => record(f, { ...f.response, providerPointers: { providerRef: "/absent" } }));
  assert.equal(normalizeNativeToolEvidence({ ...r, evidence: { ...r.evidence, stdout: "fake" } }).valid, false);
});
test("DOT-E03 delivery pass never proves native finality", () => {
  const f = fixture(); assert.equal(normalizeNativeToolEvidence(record(f)).complete, false);
  const complete = record(f, { ...f.response, terminalObservation: terminal });
  assert.equal(normalizeNativeToolEvidence(complete).complete, true);
  const failed = record(f, { ...f.response, terminalObservation: terminal, verification: { ...f.response.verification, status: "fail" } });
  assert.equal(normalizeNativeToolEvidence(failed).complete, false); assert.equal(normalizeNativeToolEvidence(failed).executionResponsibility, "terminal-confirmed");
});
test("DOT-E03 unavailable invocation linkage retains unverified actual response", () => {
  const f = fixture(); const response = { ...f.response, association: { status: "unverified", invocationRef: null, responseRef: null, argumentsDigest: null, evidenceRefs: [], reason: "native interface does not expose linkage" } };
  const r = record(f, response); assert.equal(r.evidence.association.status, "unverified"); assert.equal(normalizeNativeToolEvidence(r).status, "unverified"); assert.equal(normalizeNativeToolEvidence(r).complete, false);
});
test("DOT-E03 binding, status and source tampering refuse without losing the original fixture", () => {
  const f = fixture(); const r = record(f);
  assert.equal(normalizeNativeToolEvidence(r, { workId: "work:other" }).valid, false);
  assert.equal(normalizeNativeToolEvidence(r, { workRevision: 2 }).valid, false);
  assert.throws(() => record(f, { ...f.response, sourceTool: "other" }));
  assert.throws(() => record(f, { ...f.response, statusPointer: undefined }));
  assert.equal(r.evidence.rawResponse.sha256, dotDigest(f.response.rawResponseValue));
});
test("DOT-E03 same key/content is idempotent; same key/different content conflicts", () => {
  const f = fixture(); const r = record(f); const empty = { records: [], observations: [], current: null };
  const first = appendNativeToolRecord(empty, r); assert.equal(first.status, "appended");
  const duplicate = record(f, { ...f.response, observedAt: "2026-10-20T05:00:03Z" });
  const second = appendNativeToolRecord(first.history, duplicate); assert.equal(second.status, "duplicate"); assert.equal(second.history.observations.length, 2);
  const conflict = record(f, { ...f.response, rawResponseValue: { ...f.response.rawResponseValue, extra: "conflicting bytes" } });
  assert.equal(appendNativeToolRecord(first.history, conflict).status, "conflict");
  assert.equal(appendNativeToolRecord(first.history, conflict).rejectedRecord, conflict);
});
test("DOT-E03 late accepted is retained but cannot regress provider-confirmed terminality", () => {
  const f = fixture(); const complete = record(f, { ...f.response, terminalObservation: terminal });
  const first = appendNativeToolRecord({ records: [], observations: [], current: null }, complete);
  const late = record(f, { ...f.response, observedAt: "2026-10-20T05:00:04Z", executionStatus: "accepted", rawResponseValue: { ...f.response.rawResponseValue, event: "event-0", state: "accepted", terminal: false } });
  const next = appendNativeToolRecord(first.history, late); assert.equal(next.status, "appended"); assert.equal(next.history.records.length, 2); assert.equal(next.history.current.executionFinality, "confirmed");
});
test("DOT-E03 failed provider terminal response stays a failure despite verification pass", () => {
  const f = fixture(); const r = record(f, { ...f.response, terminalObservation: terminal, executionStatus: "failed", rawResponseValue: { ...f.response.rawResponseValue, state: "failed" } });
  assert.equal(normalizeNativeToolEvidence(r).valid, true); assert.equal(normalizeNativeToolEvidence(r).complete, false); assert.equal(r.evidence.executionStatus, "failed");
});

test("DOT-E03 retry requires reconciled actual outcome and preserves the original attempt", async () => {
  const { createNativeToolRetry } = await import("../dist/build/packages/core/src/native-tool-evidence.js");
  const f = fixture(); const input = { toolName: f.attempt.toolName, toolContractObservation: f.attempt.toolContractObservation, requestedAt: "2026-10-20T05:00:03Z", argumentsValue: { task: "fixture" } };
  assert.throws(() => createNativeToolRetry(f.attempt, f.admission, input, { outcome: "unknown" }), /query/u);
  const failed = record(f, { ...f.response, terminalObservation: terminal, executionStatus: "failed", rawResponseValue: { ...f.response.rawResponseValue, state: "failed" } });
  assert.throws(() => createNativeToolRetry(f.attempt, f.admission, { ...input, requestedAt: at }, { outcome: "confirmed-terminal", record: failed }), /reconciliation/u);
  const retry = createNativeToolRetry(f.attempt, f.admission, input, { outcome: "confirmed-terminal", record: failed });
  assert.notEqual(retry.attempt.attemptId, f.attempt.attemptId); assert.equal(retry.previousAttemptId, f.attempt.attemptId); assert.equal(f.attempt.executionStatus, "unknown");
});

test("DOT-E03 saved record wrapper is revalidated rather than trusting its normalized claim", () => {
  const f = fixture(); const r = record(f);
  const assessment = normalizeNativeToolEvidence({ record: r, normalized: { valid: true, complete: true } });
  assert.equal(assessment.valid, true); assert.equal(assessment.complete, false);
});

test("DOT-E01/E03 native workflow saves pending and failed source artifacts without inventing returns", async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { runNativeToolCommand } = await import("../dist/build/packages/cli/src/native-tool-commands.js");
  const root = await mkdtemp(join(tmpdir(), "einzbern-native-source-fixture-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const preparation = f.preparation; const binding = join(root, "preparation.json"); await writeFile(binding, JSON.stringify(preparation));
  const context = { home: join(root, "private-device"), resolveWorkspace: async () => { throw new Error("not used for saved evidence"); } };
  const pendingOutput = join(root, "pending.json");
  await runNativeToolCommand("execution-native-record", { binding, output: pendingOutput }, context);
  const pending = JSON.parse(await readFile(pendingOutput, "utf8")); assert.equal(pending.record.response, undefined); assert.equal(pending.normalized.status, "pending");
  const assessed = await runNativeToolCommand("execution-native-evidence", { "from-file": pendingOutput }, context); assert.equal(assessed.valid, true); assert.equal(assessed.complete, false);
  const response = join(root, "invalid-response.json"); const invalid = { ...f.response, sourceTool: "fixture:wrong-tool" }; await writeFile(response, JSON.stringify(invalid));
  const failedOutput = join(root, "failed.json"); await runNativeToolCommand("execution-native-record", { binding, response, output: failedOutput }, context);
  const failed = JSON.parse(await readFile(failedOutput, "utf8")); assert.equal(failed.normalized.valid, false); assert.deepEqual(failed.response, invalid);
  await assert.rejects(runNativeToolCommand("execution-native-record", { binding, output: pendingOutput }, context), /exist/u);
});

test("J09 complete native evidence retains preparation and rechecks actual-session sources", () => {
  const f = fixture(); const r = record(f, { ...f.response, terminalObservation: terminal });
  assert.equal(normalizeNativeToolEvidence(r).complete, true);
  const { preparation, ...bare } = r; assert.equal(normalizeNativeToolEvidence(bare).valid, false);
  for (const mutate of [
    request => { delete request.contextRead; },
    request => { request.contextRead.observations.forEach(row => { row.source = "parent-session"; }); },
    request => { request.contextRead.observations.forEach(row => { row.source = "patrol"; }); },
    request => { request.contextRead.record.files[0].sourceVersion = "stale"; },
    request => { request.contextRead.record.files[0].sha256 = "9".repeat(64); },
    request => { request.contextRead.record.effectiveRoots = ["/fixture/wrong"]; },
  ]) {
    const request = structuredClone(f.admission.request); mutate(request);
    const admission = resolveDotExecutionAdmission(request, { deviceLimit: 4, now: at, contextDigest: "e".repeat(64) });
    assert.equal(admission.status, "refused"); assert.notEqual(admission.checks.context.status, "pass");
    assert.equal(normalizeNativeToolEvidence({ ...r, admission }).complete, false);
  }
  const missing = structuredClone(f.admission.request); missing.contextRead.record.files.pop(); assert.throws(() => resolveDotExecutionAdmission(missing, { deviceLimit: 4, now: at, contextDigest: "e".repeat(64) }));
  const changed = structuredClone(preparation); changed.context.contexts[0].repositoryContexts[0].projectPath = "/fixture/other"; const { digest, ...payload } = changed; changed.digest = dotDigest(payload);
  assert.equal(normalizeNativeToolEvidence({ ...r, preparation: changed }).valid, false);
});

test("J10 public saved history preserves duplicates, conflicts and late returns for evidence and patrol", async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { runNativeToolCommand } = await import("../dist/build/packages/cli/src/native-tool-commands.js");
  const { normalizeReviewDispatchEvidence } = await import("../scripts/review-evidence.mjs");
  const root = await mkdtemp(join(tmpdir(), "einzbern-native-history-fixture-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(); const binding = join(root, "preparation.json"); await writeFile(binding, JSON.stringify(f.preparation));
  const context = { home: join(root, "device"), resolveWorkspace: async () => { throw new Error("not used"); } };
  const recordReturn = async (id, response, prior) => { const path = join(root, `${id}-response.json`), output = join(root, `${id}-record.json`); await writeFile(path, JSON.stringify(response)); await runNativeToolCommand("execution-native-record", { binding, response: path, ...(prior ? { prior } : {}), output }, context); return { output, saved: JSON.parse(await readFile(output, "utf8")) }; };
  const completed = await recordReturn("completed", { ...f.response, terminalObservation: terminal }); assert.equal(completed.saved.normalized.complete, true);
  const reread = { ...f.response, rawResponseRef: "fixture:another-private-copy", observedAt: "2026-10-20T05:00:03Z", association: { ...f.response.association, responseRef: "fixture:another-private-copy" }, terminalObservation: terminal };
  const duplicate = await recordReturn("duplicate", reread, completed.output); assert.equal(duplicate.saved.appendStatus, "duplicate"); assert.equal(duplicate.saved.history.records.length, 1); assert.equal(duplicate.saved.history.observations.length, 2); assert.equal(duplicate.saved.history.observations[1].sourceRef, reread.rawResponseRef);
  const late = await recordReturn("late", { ...f.response, executionStatus: "accepted", observedAt: "2026-10-20T05:00:04Z", rawResponseValue: { ...f.response.rawResponseValue, event: "event-late", state: "accepted" } }, duplicate.output);
  const assessed = await runNativeToolCommand("execution-native-evidence", { "from-file": late.output }, context); assert.equal(assessed.complete, true); assert.equal(assessed.executionResponsibility, "terminal-confirmed");
  const review = normalizeReviewDispatchEvidence(late.saved, { workId: f.attempt.workId, workRevision: 1 }); assert.equal(review.valid, true); assert.equal(review.complete, true);
  const conflict = await recordReturn("conflict", { ...reread, rawResponseValue: { ...reread.rawResponseValue, extra: "changed bytes" } }, late.output);
  assert.equal(conflict.saved.appendStatus, "conflict"); assert.equal(conflict.saved.normalized.valid, false); assert.equal(conflict.saved.normalized.executionResponsibility, "retained"); assert.ok(conflict.saved.rejectedRecord);
  assert.equal(normalizeReviewDispatchEvidence(conflict.saved, { workId: f.attempt.workId, workRevision: 1 }).complete, false);
});
