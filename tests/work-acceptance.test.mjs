import { workAcceptanceProblems, workAcceptanceMeaningDigest } from '../dist/build/packages/core/src/work-acceptance.js';
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { WORK_CONTENT_KEY, workContentDraft } from '../dist/build/packages/core/src/index.js';
function fixture() {
  const ref = { workId: 'story', requirementId: 'CFG-B02', version: 1 };
  const content = { ...workContentDraft('Story'), sources: [{ id: 's', kind: 'user-request', locator: 'message#1', version: '1', extraction: 'complete', text: 'Back up reserved paths.' }], requirements: [{ id: 'CFG-B02', version: 1, text: 'Back up reserved paths.', sourceIds: ['s'], shared: false, disposition: 'required' }], acceptance: [{ id: 'A1', version: 1, requirement: ref, scenario: 'reserved path inside project', expected: 'backup survives cleanup without self-recursion', method: 'filesystem assertion' }], evidence: [], completion: { result: 'Implemented and observed', codeVersion: 'candidate-a' } };
  const record = { id: 'story', parentId: null, kind: 'Story', tombstone: false, status: 'active', extensions: { [WORK_CONTENT_KEY]: { required: false, value: content } } };
  return { content, record, evidence: { meaningDigest: workAcceptanceMeaningDigest([record], record, 'A1'), acceptanceId: 'A1', acceptanceVersion: 1, requirement: ref, codeVersion: 'candidate-a', locator: 'artifact://observations#assertion1', actual: 'Reserved file bytes matched after cleanup; no nested backup was created.', outcome: 'satisfied', kind: 'machine' } };
}
test('INIT068 completion evidence is exact-version/candidate linkage, never passed-label semantics', () => {
  const { content, record, evidence } = fixture();
  const check = () => workAcceptanceProblems([record], record, { done: true });
  assert.ok(check().some(p => p.endsWith('evidence:missing')));
  for (const bad of [{ codeVersion: 'other' }, { acceptanceVersion: 2 }, { actual: 'passed' }, { locator: '' }, { requirement: { ...evidence.requirement, version: 2 } }]) {
    content.evidence = [{ ...evidence, ...bad }]; assert.ok(check().some(p => p.endsWith('evidence:missing')));
  }
  content.evidence = [{ ...evidence, acceptanceVersion: 99, outcome: 'unverified' }, evidence]; assert.deepEqual(check(), [], 'old evidence is retained history, not a veto on matching new evidence');
  content.evidence.push({ ...evidence, outcome: 'failed', actual: 'cleanup removed the backup' }); assert.ok(check().some(p => p.endsWith('evidence:unresolved')));
});


test('INIT068 changed constraints structurally version evidence, not title/progress or unrelated requirements', () => {
  const { content, record, evidence } = fixture(); content.evidence = [evidence];
  const digest = evidence.meaningDigest;
  assert.equal(workAcceptanceMeaningDigest([record], { ...record, title: 'new title', summary: 'progress' }, 'A1'), digest);
  content.requirements.push({ ...content.requirements[0], id: 'UNRELATED' });
  assert.equal(workAcceptanceMeaningDigest([record], record, 'A1'), digest);
  content.constraints = ['Protect a different directory'];
  assert.notEqual(workAcceptanceMeaningDigest([record], record, 'A1'), digest);
  assert.ok(workAcceptanceProblems([record], record, { done: true }).includes('acceptance:A1:evidence:missing'));
});

test('INIT068 CORE07 preserves explicitly supplied historical digest for relabelled and reintroduced observations', async () => {
  const { bindWorkContentEvidence } = await import('../dist/build/packages/core/src/work-acceptance.js');
  const { content, record, evidence } = fixture();
  content.evidence = [evidence];
  const prior = structuredClone(record);
  content.constraints = ['New directory B'];
  content.completion.codeVersion = 'candidate-b';
  content.evidence = [{ ...evidence, codeVersion: 'candidate-b' }];
  const bound = bindWorkContentEvidence([prior], record, prior);
  assert.equal(bound.evidence[0].meaningDigest, evidence.meaningDigest);
  const emptyPrior = structuredClone(prior); emptyPrior.extensions[WORK_CONTENT_KEY].value.evidence = [];
  assert.equal(bindWorkContentEvidence([emptyPrior], record, emptyPrior).evidence[0].meaningDigest, evidence.meaningDigest);
  const fresh = { ...evidence, codeVersion: 'candidate-b' }; delete fresh.meaningDigest;
  content.evidence = [fresh];
  assert.equal(bindWorkContentEvidence([emptyPrior], record, emptyPrior).evidence[0].meaningDigest, workAcceptanceMeaningDigest([record], record, 'A1'), 'new observations may reuse locator and result');
});
