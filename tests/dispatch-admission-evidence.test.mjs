// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchAdmissionDigest, normalizeDispatchAdmissionEvidence } from '../scripts/review-evidence.mjs';

const workId = `work:${'1'.repeat(24)}`;
const workRevision = 3;
function fixture() {
  const request = { host: 'codex', category: 'implementation', rejections: 0, requestedAgents: 1 };
  const policy = { host: 'codex', revision: 2, storeRevision: 4, digest: 'a'.repeat(64) };
  const selectedTuple = { runner: 'codex', model: 'explicit-model', effort: 'high' };
  const executionAdmission = {
    schemaVersion: 'tcrn.execution-admission.v1', status: 'admitted', reasons: [], request,
    selection: { ...request, record: selectedTuple, origin: { kind: 'device-engine', ...policy } }, policy,
    capabilities: { status: 'caller-reported-match', verification: 'caller-reported-not-native-verified' },
    quota: { status: 'not-configured', decision: 'not-configured' },
    concurrency: { admissionLimit: 1 }, evaluatedAt: '2026-10-17T16:00:00.000Z',
  };
  const reference = { libraryId: `library:${'2'.repeat(24)}`, projectId: `project:${'3'.repeat(24)}` };
  return {
    handoff: { workId, workRevision, reference, executionAdmission },
    hostResult: {
      schemaVersion: 'tcrn.host-dispatch-evidence.v1', source: 'native-host-return', workId, workRevision,
      projectReference: structuredClone(reference), request: structuredClone(request), selectedTuple: structuredClone(selectedTuple),
      policyRevision: policy.revision, policyDigest: policy.digest, admissionDigest: dispatchAdmissionDigest(executionAdmission),
      stdout: { status: 'available', value: 'actual host output\n' },
      stderr: { status: 'available', value: '' }, exitCode: { status: 'available', value: 0 },
    },
  };
}
const normalize = value => normalizeDispatchAdmissionEvidence(value, { workId, workRevision });

test('omitted association remains explicitly not requested; null is invalid', () => {
  assert.deepEqual(normalize(undefined), { requested: false, valid: true, complete: false, status: 'not-requested', problems: [], evidence: null });
  assert.equal(normalize(null).valid, false);
});
test('actual host return associates exactly without claiming independent authentication', () => {
  const value = fixture();
  const result = normalize(value);
  assert.equal(result.valid, true);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'associated');
  assert.equal(result.verification, 'caller-supplied-host-return-not-independently-authenticated');
  assert.deepEqual(result.evidence, value);
  assert.equal(result.evidence.hostResult.stdout.value, 'actual host output\n');
});
test('admission digest is canonical across object key order and binds the full receipt', () => {
  assert.equal(dispatchAdmissionDigest({ b: [2, 1], a: { y: true, x: null } }), dispatchAdmissionDigest({ a: { x: null, y: true }, b: [2, 1] }));
  const value = fixture();
  value.handoff.executionAdmission.evaluatedAt = '2026-10-17T16:01:00.000Z';
  assert.match(normalize(value).problems.join(';'), /admissionDigest/);
});
test('refusal never becomes dispatch proof even with a matching digest', () => {
  const value = fixture();
  value.handoff.executionAdmission.status = 'refused';
  value.handoff.executionAdmission.reasons = ['EXECUTION_QUOTA_WAIT'];
  value.hostResult.admissionDigest = dispatchAdmissionDigest(value.handoff.executionAdmission);
  assert.equal(normalize(value).valid, false);
});
test('all work, project, request, tuple, policy, and digest associations are enforced', () => {
  const mutations = [
    value => value.hostResult.workId = `work:${'4'.repeat(24)}`,
    value => value.hostResult.workRevision++,
    value => value.hostResult.projectReference.projectId = `project:${'4'.repeat(24)}`,
    value => value.hostResult.request.requestedAgents++,
    value => value.hostResult.selectedTuple.effort = 'low',
    value => value.hostResult.policyRevision++,
    value => value.hostResult.policyDigest = 'b'.repeat(64),
    value => value.hostResult.admissionDigest = 'c'.repeat(64),
    value => value.handoff.workRevision++,
    value => value.handoff.workId = `work:${'4'.repeat(24)}`,
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.equal(normalize(value).valid, false);
  }
});
test('absent or malformed output and exit are not defaulted to empty output or zero', () => {
  for (const field of ['stdout', 'stderr', 'exitCode']) {
    const value = fixture(); delete value.hostResult[field];
    const result = normalize(value);
    assert.equal(result.valid, false);
    assert.equal(result.complete, false);
    assert.equal(Object.hasOwn(result.evidence.hostResult, field), false);
  }
  for (const exitCode of ['0', null, -1, 0.5]) {
    const value = fixture(); value.hostResult.exitCode.value = exitCode;
    assert.equal(normalize(value).valid, false);
  }
});
test('explicit unavailable observations retain reasons but cannot complete review evidence', () => {
  const value = fixture();
  for (const field of ['stdout', 'stderr', 'exitCode']) value.hostResult[field] = { status: 'unavailable', reason: 'host did not expose this field' };
  const result = normalize(value);
  assert.equal(result.valid, true);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.unavailable, ['stdout', 'stderr', 'exitCode']);
  assert.deepEqual(result.evidence.hostResult.exitCode, { status: 'unavailable', reason: 'host did not expose this field' });
});
test('review test runner output is not native dispatch evidence', () => {
  const value = fixture(); value.hostResult.source = 'node-test-case-summary';
  assert.equal(normalize(value).valid, false);
  assert.equal(normalize({ testRun: { stdout: 'tests passed', exitCode: '0' } }).valid, false);
});
test('nonzero host exit is preserved rather than rewritten as success', () => {
  const value = fixture(); value.hostResult.exitCode.value = 17;
  const result = normalize(value);
  assert.equal(result.complete, true);
  assert.equal(result.evidence.hostResult.exitCode.value, 17);
});
test('inconsistent admission selection and policy are rejected despite a recomputed digest', () => {
  const value = fixture(); value.handoff.executionAdmission.selection.origin.revision++;
  value.hostResult.admissionDigest = dispatchAdmissionDigest(value.handoff.executionAdmission);
  assert.equal(normalize(value).valid, false);
});
