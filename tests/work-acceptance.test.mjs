import { workAcceptanceProblems, workAcceptanceMeaningDigest, bindWorkContentEvidence } from '../dist/build/packages/core/src/work-acceptance.js';
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { WORK_CONTENT_KEY, workContentDraft, workContent, workContentChangeImpact, workContentMeaningDigest, createWork, annotateWork, transitionWork, admitTemplateInWorkspace, defaultWorkContentTemplate, readWorkContentImpact } from '../dist/build/packages/core/src/index.js';
import { workspaceFixture, instant } from './helpers/workspace-fixture.mjs';
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

function allocationEvidenceFixture(responsibilities = ['verification', 'implementation'], shared = false) {
  const ref = { workId: 'parent', requirementId: 'R1', version: 1 };
  const makeRecord = (id, parentId, content) => ({ id, parentId, kind: content.kind, status: 'active', tombstone: false, extensions: { [WORK_CONTENT_KEY]: { required: false, value: content } } });
  const parent = makeRecord('parent', null, { ...workContentDraft('Initiative'), constraints: ['Retain fixture data', 'Retain fixture metadata'],
    sources: [{ id: 's', kind: 'user-request', locator: 'fixture:request', version: '1', extraction: 'complete', text: 'Retain fixture output.' }],
    requirements: [{ id: 'R1', version: 1, text: 'Retain fixture output.', sourceIds: ['s'], shared, disposition: 'required' }],
    allocations: responsibilities.map(responsibility => ({ ...ref, childId: 'child', responsibility })) });
  let child = makeRecord('child', parent.id, { ...workContentDraft('Epic'),
    acceptance: [{ id: 'A1', version: 1, requirement: ref, scenario: 'Generate fixture output', expected: 'Output retained', method: 'Compare bytes' }],
    completion: { result: 'Output retained', codeVersion: 'fixture-candidate' },
    evidence: [{ acceptanceId: 'A1', acceptanceVersion: 1, requirement: ref, codeVersion: 'fixture-candidate', locator: 'fixture:observation', actual: 'Observed retained bytes', outcome: 'satisfied', kind: 'machine' }] });
  child = makeRecord(child.id, child.parentId, bindWorkContentEvidence([parent, child], child));
  return { parent, child, work: [parent, child] };
}

test('both allocation orders and duplicate rows preserve existing completion evidence without changing its binding', () => {
  for (const order of [['verification', 'implementation'], ['implementation', 'verification']]) {
    const { parent, child, work } = allocationEvidenceFixture(order);
    const evidence = structuredClone(workContent(child).evidence);
    assert.deepEqual(workAcceptanceProblems(work, child, { done: true }), []);
    for (const duplicate of [false, true]) {
      const candidateWork = structuredClone(work), next = workContent(candidateWork[0]);
      next.allocations.reverse();
      if (duplicate) next.allocations.push({ ...next.allocations[0] });
      const impact = workContentChangeImpact(work, parent, next);
      assert.deepEqual(impact.affectedWorkIds, []);
      assert.deepEqual(impact.affectedEvidence, []);
      assert.equal(impact.requiresDecision, false);
      assert.equal(workContentMeaningDigest(work, child), workContentMeaningDigest(candidateWork, candidateWork[1]));
      assert.notEqual(workAcceptanceMeaningDigest(work, child, 'A1'), workAcceptanceMeaningDigest(candidateWork, candidateWork[1], 'A1'), 'the historical generator stays unchanged; only consumption recognizes equivalent role order');
      assert.deepEqual(workAcceptanceProblems(candidateWork, candidateWork[1], { done: true }), []);
      assert.deepEqual(bindWorkContentEvidence(candidateWork, candidateWork[1], child).evidence, evidence);
      assert.deepEqual(workContent(candidateWork[1]).evidence, evidence);
    }
  }
});

test('reordered failed and unverified observations still veto completion alongside satisfied evidence', () => {
  for (const outcome of ['failed', 'unverified']) for (const satisfiedOrder of ['current', 'alternate']) for (const unresolvedOrder of ['current', 'alternate']) {
    const { work } = allocationEvidenceFixture();
    workContent(work[0]).allocations.reverse();
    const content = workContent(work[1]);
    const alternateDigest = content.evidence[0].meaningDigest, currentDigest = workAcceptanceMeaningDigest(work, work[1], 'A1');
    content.evidence[0].meaningDigest = satisfiedOrder === 'current' ? currentDigest : alternateDigest;
    content.evidence.push({ ...content.evidence[0], meaningDigest: unresolvedOrder === 'current' ? currentDigest : alternateDigest, outcome, actual: `Synthetic ${outcome} observation`, locator: `fixture:${outcome}` });
    const problems = workAcceptanceProblems(work, work[1], { done: true });
    assert.ok(problems.includes('acceptance:A1:evidence:unresolved'), `${outcome}: satisfied ${satisfiedOrder}, unresolved ${unresolvedOrder}`);
    assert.ok(!problems.includes('acceptance:A1:evidence:missing'), 'the satisfied observation remains matched too');
  }
});

test('role-order compatibility does not admit changed roles, requirements, sources, constraints or evidence bindings', () => {
  const changes = [
    ['remove verification', parent => parent.allocations.pop()],
    ['remove implementation', parent => parent.allocations.shift()],
    ['move one responsibility', parent => { parent.allocations[0].childId = 'other'; }],
    ['move both responsibilities', parent => { parent.allocations.forEach(a => { a.childId = 'other'; }); }],
    ['requirement text', parent => { parent.requirements[0].text = 'Retain different output.'; }],
    ['requirement version', parent => { parent.requirements[0].version = 2; }],
    ['source text', parent => { parent.sources[0].text = 'Retain different output.'; }],
    ['source locator', parent => { parent.sources[0].locator = 'fixture:another-request'; }],
    ['source version', parent => { parent.sources[0].version = '2'; }],
    ['source extraction', parent => { parent.sources[0].extraction = 'partial'; }],
    ['constraint text', parent => { parent.constraints[0] = 'Retain different data'; }],
    ['constraint order', parent => parent.constraints.reverse()],
    ['scope', parent => { parent.scope = 'Different scope'; }],
    ['goal', parent => { parent.goal = 'Different goal'; }],
    ['details', parent => { parent.details.boundary = 'Different boundary'; }],
    ['acceptance method', (_parent, child) => { child.acceptance[0].method = 'Different check'; }],
    ['acceptance version', (_parent, child) => { child.acceptance[0].version = 2; }],
    ['requirement reference', (_parent, child) => { child.acceptance[0].requirement.workId = 'other'; }],
    ['code candidate', (_parent, child) => { child.completion.codeVersion = 'another-candidate'; }],
    ['evidence candidate', (_parent, child) => { child.evidence[0].codeVersion = 'another-candidate'; }],
    ['evidence acceptance version', (_parent, child) => { child.evidence[0].acceptanceVersion = 2; }],
    ['arbitrary digest', (_parent, child) => { child.evidence[0].meaningDigest = 'f'.repeat(64); }],
    ['absent digest', (_parent, child) => { delete child.evidence[0].meaningDigest; }],
  ];
  for (const [label, change] of changes) {
    const { work } = allocationEvidenceFixture();
    const parent = workContent(work[0]), child = workContent(work[1]);
    parent.allocations.reverse();
    change(parent, child);
    assert.ok(workAcceptanceProblems(work, work[1], { done: true }).includes('acceptance:A1:evidence:missing'), label);
  }
  for (const roles of [[], ['implementation'], ['verification']]) {
    const { work } = allocationEvidenceFixture(roles, true);
    const parent = workContent(work[0]);
    parent.allocations = ['verification', 'implementation'].map(responsibility => ({ workId: 'parent', requirementId: 'R1', version: 1, childId: 'child', responsibility }));
    assert.ok(workAcceptanceProblems(work, work[1], { done: true }).includes('acceptance:A1:evidence:missing'), `adding a responsibility to ${roles}`);
    const reduced = allocationEvidenceFixture(['verification', 'implementation'], true);
    workContent(reduced.parent).allocations = roles.map(responsibility => ({ workId: 'parent', requirementId: 'R1', version: 1, childId: 'child', responsibility }));
    assert.ok(workAcceptanceProblems(reduced.work, reduced.child, { done: true }).includes('acceptance:A1:evidence:missing'), `reducing responsibilities to ${roles}`);
  }
});

test('native parent allocation reorders preserve child evidence and allow completion without rebinding', async t => {
  const f = await workspaceFixture(t, { externalKey: 'ALLOCATION-EVIDENCE' });
  let state, tick = 2;
  const receipts = {};
  for (const kind of ['Epic', 'Story']) {
    state = await admitTemplateInWorkspace(f.workspace, { template: defaultWorkContentTemplate(kind), ownerId: 'owner:fixture', occurredAt: instant(tick++) });
    receipts[kind] = state.templates.find(entry => entry.template.id === `minimum-${kind.toLowerCase()}`).receipt;
  }
  const add = async (externalKey, kind, parentId, extra = {}) => {
    state = await createWork(f.workspace, { projectId: f.projectId, externalKey, kind, parentId, title: 'Synthetic allocation evidence', occurredAt: instant(tick++), ...extra });
    return state.work.find(w => w.externalKey === externalKey).id;
  };
  const rootId = await add('EVIDENCE-ROOT', 'Initiative', null);
  const source = { id: 's', kind: 'user-request', locator: 'fixture:evidence-request', version: '1', extraction: 'complete', text: 'Retain fixture output.' };
  const requirement = id => ({ id, version: 1, text: 'Retain fixture output.', sourceIds: ['s'], shared: false, disposition: 'required' });
  const parentContent = { ...workContentDraft('Epic'), goal: 'Retain output', scope: 'Synthetic fixture', sources: [source], requirements: [requirement('R1')] };
  const parentId = await add('EVIDENCE-PARENT', 'Epic', rootId, { content: parentContent, templateAdmission: receipts.Epic });
  const childId = await add('EVIDENCE-CHILD', 'Story', parentId, { content: workContentDraft('Story'), templateAdmission: receipts.Story });
  const inherited = { workId: parentId, requirementId: 'R1', version: 1 }, local = { workId: childId, requirementId: 'R2', version: 1 };
  const allocations = ['verification', 'implementation'].map(responsibility => ({ ...inherited, childId, responsibility }));
  state = await annotateWork(f.workspace, { id: parentId, content: { ...parentContent, allocations }, occurredAt: instant(tick++) });
  const childContent = { ...workContentDraft('Story'), goal: 'Retain output', scope: 'Synthetic fixture', sources: [source], requirements: [requirement('R2')], details: { behavior: 'Retain output bytes', discretion: 'Choose internal implementation' },
    acceptance: [inherited, local].map((ref, i) => ({ id: `A${i + 1}`, version: 1, requirement: ref, scenario: 'Generate output', expected: 'Output retained', method: 'Compare bytes' })),
    completion: { result: 'Output retained', codeVersion: 'fixture-candidate' },
    evidence: [inherited, local].map((ref, i) => ({ acceptanceId: `A${i + 1}`, acceptanceVersion: 1, requirement: ref, codeVersion: 'fixture-candidate', locator: `fixture:observation-${i}`, actual: 'Observed retained bytes', outcome: 'satisfied', kind: 'machine' })) };
  state = await annotateWork(f.workspace, { id: childId, content: childContent, occurredAt: instant(tick++) });
  for (const status of ['ready', 'active']) state = await transitionWork(f.workspace, { id: childId, status, occurredAt: instant(tick++) });
  const child = state.work.find(w => w.id === childId), evidence = structuredClone(workContent(child).evidence);
  for (const reordered of [[...allocations].reverse(), allocations, [...allocations].reverse().concat(allocations[0])]) {
    state = await annotateWork(f.workspace, { id: parentId, content: { ...parentContent, allocations: reordered }, occurredAt: instant(tick++) });
    const impact = readWorkContentImpact(state.work.find(w => w.id === parentId));
    const currentChild = state.work.find(w => w.id === childId);
    assert.equal(impact.previousMeaningDigest, impact.currentMeaningDigest);
    assert.deepEqual(impact.impact.affectedWorkIds, []);
    assert.deepEqual(impact.impact.affectedEvidence, []);
    assert.equal(impact.impact.requiresDecision, false);
    assert.equal(currentChild.revision, child.revision);
    assert.deepEqual(workContent(currentChild).evidence, evidence);
    assert.deepEqual(workAcceptanceProblems(state.work, currentChild, { done: true }), []);
  }
  state = await transitionWork(f.workspace, { id: childId, status: 'done', occurredAt: instant(tick++) });
  const completed = state.work.find(w => w.id === childId);
  assert.equal(completed.status, 'done');
  assert.deepEqual(workContent(completed).evidence, evidence);
});
