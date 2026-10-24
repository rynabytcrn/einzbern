// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { WORK_CONTENT_KEY, workContentDraft, workContent, effectiveWorkRequirements, workRequirementProblems, workContentChangeImpact, workContentMeaningDigest, assertWorkContentChange, createProject, createWork, annotateWork, recordMinutes, admitTemplateInWorkspace, defaultWorkContentTemplate, readWorkContentImpact } from '../dist/build/packages/core/src/index.js';
import { workAcceptanceMeaningDigest, workAcceptanceProblems, bindWorkContentEvidence } from '../dist/build/packages/core/src/work-acceptance.js';
import { workspaceFixture, instant } from './helpers/workspace-fixture.mjs';
const source = { id: 'original', kind: 'approved-draft', locator: 'original#section8', version: 'v1', extraction: 'complete', text: 'Preserve reserved backups during cleanup.' };
const requirement = (id, shared = false) => ({ id, version: 1, text: id, sourceIds: ['original'], shared, disposition: 'required' });
function record(id, parentId, content) { return { id, parentId, kind: content.kind, status: 'planned', tombstone: false, extensions: { [WORK_CONTENT_KEY]: { required: false, value: content } } }; }

test('INIT068 allocation roles and shared inheritance retain source version and reveal omissions', () => {
  const content = { ...workContentDraft('Initiative'), sources: [source], requirements: [requirement('reserve'), requirement('cleanup', true)], allocations: [{ workId: 'parent', requirementId: 'reserve', version: 1, childId: 'child', responsibility: 'implementation' }] };
  const parent = record('parent', null, content), child = record('child', 'parent', workContentDraft('Epic')), other = record('other', 'parent', workContentDraft('Epic'));
  const work = [parent, child, other];
  assert.deepEqual(effectiveWorkRequirements(work, 'child').map(r => r.requirement.id), ['reserve', 'cleanup']);
  assert.deepEqual(effectiveWorkRequirements(work, 'other').map(r => r.requirement.id), ['cleanup']);
  assert.ok(workRequirementProblems(work, parent).includes('requirement:reserve:allocation:verification:unresolved'));
  assert.ok(workRequirementProblems(work, parent).includes('requirement:cleanup:allocation:implementation:unresolved'));
  assert.equal(effectiveWorkRequirements(work, 'child')[0].sources[0].text, source.text);
});

test('INIT068 same-number changed meaning requires version and approved decision; title changes do not', () => {
  const content = { ...workContentDraft('Story'), approved: true, sources: [source], requirements: [requirement('CFG-B02')] };
  const old = record('story', null, content);
  const changed = { ...content, requirements: [{ ...content.requirements[0], text: 'Only tree-external backup passes.' }] };
  assert.throws(() => assertWorkContentChange([old], old, changed), /new version/);
  const bumped = { ...changed, requirements: [{ ...changed.requirements[0], version: 2 }] };
  assert.throws(() => assertWorkContentChange([old], old, bumped), /actual Owner decision/);
  assert.deepEqual(workContentChangeImpact([old], { ...old, title: 'new title' }, content).changedRequirements, []);
  assert.deepEqual(workContentChangeImpact([old], old, bumped).affectedWorkIds, ['story']);
  assert.throws(() => assertWorkContentChange([old], { ...old, status: 'done' }, { ...bumped, changeDecision: 'minutes:reference#D1' }), /historical/);
});


test('INIT068 approval provenance cannot be stripped and approved additions need a decision', () => {
  const approval = { ...source, id: 'approval', kind: 'decision', locator: 'minutes:fixture#D1' };
  const content = { ...workContentDraft('Story'), approved: true, sources: [{ ...source, kind: 'user-request' }, approval], requirements: [requirement('R1')] };
  const old = record('story', null, content);
  assert.throws(() => assertWorkContentChange([old], old, { ...content, approved: false, sources: [content.sources[0]] }), e => e.reasonCode === 'WORK_CONTENT_APPROVAL_PROVENANCE');
  assert.throws(() => assertWorkContentChange([old], old, { ...content, requirements: [...content.requirements, requirement('R2')] }), e => e.reasonCode === 'WORK_CONTENT_DECISION_REQUIRED');
  const child = record('child', old.id, workContentDraft('Subtask'));
  const changed = { ...content, constraints: ['new inherited constraint'], changeDecision: approval.locator };
  assertWorkContentChange([old, child], old, changed);
  assert.deepEqual(workContentChangeImpact([old, child], old, changed).affectedWorkIds, ['story', 'child']);
  assert.deepEqual(workContentChangeImpact([old], old, { ...content, body: 'progress note only' }).affectedWorkIds, []);
});

function allocationGraph(shared = false) {
  const ref = { workId: 'parent', requirementId: 'R1', version: 1 };
  const evidence = ['R1', 'R2'].map((requirementId, index) => ({ acceptanceId: `A${index + 1}`, acceptanceVersion: 1, requirement: { ...ref, requirementId }, codeVersion: 'fixture-candidate', locator: `fixture:evidence/${requirementId}`, actual: 'Synthetic observation', outcome: 'satisfied', kind: 'machine' }));
  const content = { ...workContentDraft('Initiative'), sources: [source], requirements: [requirement('R1', shared), requirement('R2', true)], evidence,
    allocations: ['a', 'c'].flatMap(childId => ['implementation', 'verification'].map(responsibility => ({ ...ref, childId, responsibility }))) };
  const parent = record('parent', null, content);
  parent.extensions['advisory:fixture'] = { required: false, value: 'Retained unrelated extension' };
  const descendants = ['a', 'b', 'c'].flatMap(id => [record(id, parent.id, { ...workContentDraft('Epic'), evidence }), record(`${id}-leaf`, id, { ...workContentDraft('Story'), evidence })]);
  const historical = ['done', 'cancelled', 'deleted'].map(id => ({ ...record(id, parent.id, { ...workContentDraft('Epic'), evidence }), status: id === 'deleted' ? 'planned' : id, tombstone: id === 'deleted' }));
  const unrelated = { ...record('unrelated', null, workContentDraft('Initiative')), projectId: 'other-project' };
  return { content, parent, work: [parent, ...descendants, ...historical, unrelated] };
}

test('allocation reassignment protects both approval forms and only changes losing and gaining branches', () => {
  for (const shared of [false, true]) for (const approved of [false, true]) {
    const fixture = allocationGraph(shared);
    const content = approved ? { ...fixture.content, approved: true, sources: [{ ...source, kind: 'user-request' }] } : fixture.content;
    const parent = { ...fixture.parent, extensions: { ...fixture.parent.extensions, [WORK_CONTENT_KEY]: { required: false, value: content } } };
    const work = fixture.work.map(w => w.id === parent.id ? parent : w);
    const snapshot = structuredClone(work);
    const next = { ...content, allocations: content.allocations.map(a => a.childId === 'a' ? { ...a, childId: 'b' } : a) };
    const impact = workContentChangeImpact(work, parent, next);
    assert.equal(impact.requiresDecision, true);
    assert.deepEqual(impact.changedRequirements, [], 'responsibility changes do not require a requirement version bump');
    assert.deepEqual(impact.affectedWorkIds, ['parent', 'a', 'a-leaf', 'b', 'b-leaf']);
    assert.deepEqual(impact.affectedEvidence.map(e => [e.workId, e.acceptanceId]), impact.affectedWorkIds.map(id => [id, 'A1']));
    assert.throws(() => assertWorkContentChange(work, parent, next), e => e.reasonCode === 'WORK_CONTENT_DECISION_REQUIRED');
    assert.doesNotThrow(() => assertWorkContentChange(work, parent, { ...next, changeDecision: 'minutes:fixture#D1' }));
    const candidate = { ...parent, extensions: { ...parent.extensions, [WORK_CONTENT_KEY]: { required: false, value: next } } };
    assert.notEqual(workContentMeaningDigest(work, parent), workContentMeaningDigest(work, candidate));
    assert.deepEqual(work, snapshot, 'impact calculation must not mutate the input graph');
  }
});

test('allocation additions, removals, role-only edits and reference edits change only effective responsibilities', () => {
  const { content, parent, work } = allocationGraph();
  const first = content.allocations[0];
  const variants = [
    { allocations: content.allocations.filter(a => a.childId !== 'a'), affected: ['parent', 'a', 'a-leaf'] },
    { allocations: [...content.allocations, { ...first, childId: 'b' }], affected: ['parent', 'b', 'b-leaf'] },
    { allocations: content.allocations.map(a => a === first ? { ...a, responsibility: 'verification' } : a), affected: ['parent', 'a', 'a-leaf'] },
    { allocations: content.allocations.map(a => a === first ? { ...a, version: 2 } : a), affected: ['parent', 'a', 'a-leaf'] },
    { allocations: content.allocations.map(a => a === first ? { ...a, requirementId: 'R2' } : a), affected: ['parent', 'a', 'a-leaf'] },
    { allocations: content.allocations.map(a => a === first ? { ...a, workId: 'other-parent' } : a), affected: ['parent', 'a', 'a-leaf'] },
  ];
  for (const { allocations, affected } of variants) {
    const next = { ...content, allocations };
    const impact = workContentChangeImpact(work, parent, next);
    assert.equal(impact.requiresDecision, true);
    assert.deepEqual(impact.changedRequirements, []);
    assert.deepEqual(impact.affectedWorkIds, affected);
    assert.throws(() => assertWorkContentChange(work, parent, next), e => e.reasonCode === 'WORK_CONTENT_DECISION_REQUIRED');
  }
  for (const status of ['done', 'cancelled']) assert.throws(() => assertWorkContentChange(work, { ...parent, status }, { ...content, allocations: [] }), e => e.reasonCode === 'WORK_CONTENT_TERMINAL');
});

test('non-owned allocation references remain invalid rather than creating inherited responsibilities', () => {
  const fixture = allocationGraph(true);
  const parent = fixture.parent, originalChild = fixture.work.find(w => w.id === 'b');
  const child = { ...originalChild, extensions: { ...originalChild.extensions, [WORK_CONTENT_KEY]: { required: false, value: { ...workContent(originalChild), sources: [source] } } } };
  const work = fixture.work.map(w => w.id === child.id ? child : w);
  const next = { ...workContent(child), allocations: [{ workId: parent.id, requirementId: 'R1', version: 1, childId: 'b-leaf', responsibility: 'implementation' }] };
  const candidate = { ...child, extensions: { ...child.extensions, [WORK_CONTENT_KEY]: { required: false, value: next } } };
  const candidateWork = work.map(w => w.id === child.id ? candidate : w);
  assert.ok(workRequirementProblems(candidateWork, candidate).includes('allocation:R1:child:invalid'));
  assert.deepEqual(effectiveWorkRequirements(candidateWork, 'b-leaf'), effectiveWorkRequirements(work, 'b-leaf'));
  assert.deepEqual(effectiveWorkRequirements(candidateWork, 'b-leaf').find(r => r.requirement.id === 'R1').responsibilities, []);
  const impact = workContentChangeImpact(work, child, next);
  assert.equal(impact.requiresDecision, true);
  assert.deepEqual(impact.affectedWorkIds, ['b']);
  assert.notEqual(workContentMeaningDigest(work, child), workContentMeaningDigest(candidateWork, candidate));
});

test('allocation reordering and duplicate rows preserve impact and structural digests', () => {
  const { content, parent, work } = allocationGraph();
  const next = { ...content, allocations: [...content.allocations].reverse().concat(content.allocations[0]) };
  const candidate = { ...parent, extensions: { ...parent.extensions, [WORK_CONTENT_KEY]: { required: false, value: next } } };
  const candidateWork = work.map(w => w.id === parent.id ? candidate : w);
  const impact = workContentChangeImpact(work, parent, next);
  assert.equal(impact.requiresDecision, false);
  assert.deepEqual(impact.affectedWorkIds, []);
  assert.deepEqual(impact.affectedEvidence, []);
  assert.doesNotThrow(() => assertWorkContentChange(work, parent, next));
  for (const entry of work) assert.equal(workContentMeaningDigest(work, entry), workContentMeaningDigest(candidateWork, entry.id === parent.id ? candidate : entry));
});

test('historical verification-first completion evidence remains valid without rebinding after upgrade', () => {
  const historicalSource = { id: 's', kind: 'user-request', locator: 'fixture:allocation-history', version: '1', extraction: 'complete', text: 'Retain synthetic output.' };
  const historicalRequirement = { id: 'R1', version: 1, text: 'Retain synthetic output.', sourceIds: ['s'], shared: false, disposition: 'required' };
  const ref = { workId: 'parent', requirementId: 'R1', version: 1 };
  const parent = record('parent', null, { ...workContentDraft('Initiative'), sources: [historicalSource], requirements: [historicalRequirement], allocations: ['verification', 'implementation'].map(responsibility => ({ ...ref, childId: 'child', responsibility })) });
  // Captured from the pre-fix acceptance implementation at 79d20c63acf0248d0d6422e5922d922465843081.
  // Do not derive the historical binding from the candidate implementation under test.
  const meaningDigest = 'cda7c7f670f51732e62d16a3a0fe43a13481d915f3a926d45efe2b5244e34156';
  const content = { ...workContentDraft('Epic'), acceptance: [{ id: 'A1', version: 1, requirement: ref, scenario: 'Generate fixture output', expected: 'Output is retained', method: 'Compare fixture bytes' }], completion: { result: 'Fixture output retained', codeVersion: 'historical-candidate' },
    evidence: [{ meaningDigest, acceptanceId: 'A1', acceptanceVersion: 1, requirement: ref, codeVersion: 'historical-candidate', locator: 'fixture:historical-observation', actual: 'Output bytes were retained', outcome: 'satisfied', kind: 'machine' }] };
  const child = { ...record('child', parent.id, content), status: 'done' }, work = [parent, child];
  const snapshot = structuredClone(work);
  assert.deepEqual(effectiveWorkRequirements(work, child.id)[0].responsibilities, ['verification', 'implementation']);
  assert.equal(workAcceptanceMeaningDigest(work, child, 'A1'), meaningDigest);
  assert.deepEqual(workAcceptanceProblems(work, child, { done: true }), []);
  assert.equal(bindWorkContentEvidence(work, child, child).evidence[0].meaningDigest, meaningDigest);
  assert.deepEqual(work, snapshot, 'reading old evidence must not relabel or rewrite history');
  const nextParent = { ...parent, extensions: { ...parent.extensions, [WORK_CONTENT_KEY]: { required: false, value: { ...workContent(parent), allocations: [workContent(parent).allocations[1]] } } } };
  const changedWork = [nextParent, child];
  assert.ok(workAcceptanceProblems(changedWork, child, { done: true }).includes('acceptance:A1:evidence:missing'), 'a real responsibility change still invalidates the historical observation');
  assert.equal(bindWorkContentEvidence(changedWork, child, child).evidence[0].meaningDigest, meaningDigest);
});

test('new shared requirements and either shared toggle include old and newly inheriting live descendants', () => {
  for (const mode of ['addition', 'shared-on', 'shared-off', 'shared-edit']) {
    const { content, parent, work } = allocationGraph(mode === 'shared-off' || mode === 'shared-edit');
    const requirements = mode === 'addition' ? [...content.requirements, requirement('R3', true)] : content.requirements.map(r => r.id === 'R1' ? { ...r, version: 2, shared: mode !== 'shared-off', ...(mode === 'shared-edit' ? { text: 'Updated synthetic requirement' } : {}) } : r);
    const next = { ...content, requirements, allocations: content.allocations.map(a => mode !== 'addition' && a.requirementId === 'R1' ? { ...a, version: 2 } : a), changeDecision: 'minutes:fixture#D1' };
    assert.doesNotThrow(() => assertWorkContentChange(work, parent, next));
    const impact = workContentChangeImpact(work, parent, next);
    assert.deepEqual(impact.affectedWorkIds, ['parent', 'a', 'a-leaf', 'b', 'b-leaf', 'c', 'c-leaf'], mode);
    assert.deepEqual(impact.changedRequirements, [mode === 'addition' ? 'R3' : 'R1']);
    if (mode !== 'addition') assert.deepEqual(impact.affectedEvidence.map(e => [e.workId, e.acceptanceId]), impact.affectedWorkIds.map(id => [id, 'A1']));
    if (mode === 'shared-on') assert.throws(() => assertWorkContentChange(work, parent, { ...next, requirements: requirements.map(r => ({ ...r, version: 1 })) }), e => e.reasonCode === 'WORK_REQUIREMENT_VERSION');
  }
});

async function nativeRequirementGraph(t, externalKey, approved = false) {
  externalKey = externalKey.toUpperCase();
  const f = await workspaceFixture(t, { externalKey });
  let state = await admitTemplateInWorkspace(f.workspace, { template: defaultWorkContentTemplate('Initiative'), ownerId: 'owner:fixture', occurredAt: instant(2) });
  const content = { ...workContentDraft('Initiative'), sources: [{ ...source, kind: approved ? 'approved-draft' : 'user-request' }], requirements: [requirement('R1')] };
  state = await createWork(f.workspace, { projectId: f.projectId, externalKey: `${externalKey}-ROOT`, kind: 'Initiative', parentId: null, title: 'Synthetic requirement graph', content, templateAdmission: state.templates.find(entry => entry.template.id === 'minimum-initiative').receipt, occurredAt: instant(3) });
  const id = state.work.find(w => w.externalKey === `${externalKey}-ROOT`).id;
  const branches = {};
  let second = 4;
  for (const name of ['A', 'B', 'C']) {
    state = await createWork(f.workspace, { projectId: f.projectId, externalKey: `${externalKey}-${name}`, kind: 'Epic', parentId: id, title: `Synthetic branch ${name}`, occurredAt: instant(second++) });
    const childId = state.work.find(w => w.externalKey === `${externalKey}-${name}`).id;
    state = await createWork(f.workspace, { projectId: f.projectId, externalKey: `${externalKey}-${name}-LEAF`, kind: 'Story', parentId: childId, title: 'Synthetic descendant', goal: 'Exercise requirement inheritance in a descendant', acceptance: 'Effective requirements reflect the candidate ancestor content.', occurredAt: instant(second++) });
    branches[name] = [childId, state.work.find(w => w.externalKey === `${externalKey}-${name}-LEAF`).id];
  }
  return { ...f, state, content, id, branches };
}

test('native approved allocation writes require a current same-project Owner decision and record precise impact', async t => {
  for (const approval of ['approved-draft', 'approved-flag']) {
    const f = await nativeRequirementGraph(t, `ALLOCATION-${approval}`, approval === 'approved-draft');
    let second = 20;
    const decision = async (key, extra = {}) => {
      const state = await recordMinutes(f.workspace, { projectId: f.projectId, externalKey: key, title: 'Synthetic allocation decision', summary: 'Synthetic fixture only', decisions: ['Approve the designated requirement allocation.'], decidedBy: ['owner:fixture'], linkedWorkIds: [f.id], occurredAt: instant(second++), ...extra });
      return `${state.minutes.find(m => m.externalKey === key.toUpperCase()).id}#D1`;
    };
    const originalDecision = await decision(`ALLOCATION-${approval}-ORIGINAL`);
    const content = approval === 'approved-flag' ? { ...f.content, approved: true, sources: [{ ...source, kind: 'user-request' }, { ...source, id: 'decision', kind: 'decision', locator: originalDecision }] } : f.content;
    const ref = { workId: f.id, requirementId: 'R1', version: 1 };
    let state = await annotateWork(f.workspace, { id: f.id, content: { ...content, changeDecision: originalDecision, allocations: ['A', 'C'].flatMap(name => ['implementation', 'verification'].map(responsibility => ({ ...ref, childId: f.branches[name][0], responsibility }))) }, occurredAt: instant(second++) });
    const previous = state.work.find(w => w.id === f.id);
    const { changeDecision: _priorDecision, ...prior } = workContent(previous);
    const next = { ...prior, allocations: prior.allocations.map(a => a.childId === f.branches.A[0] ? { ...a, childId: f.branches.B[0] } : a) };
    const currentDecision = await decision(`ALLOCATION-${approval}-CURRENT`, { supersedes: [{ decision: originalDecision, by: 'D1' }] });
    const nonOwner = await decision(`ALLOCATION-${approval}-NONOWNER`, { decidedBy: ['agent:fixture'], coexists: [currentDecision] });
    const other = await createProject(f.workspace, { externalKey: `ALLOCATION-${approval}-OTHER`, name: 'Other synthetic project', occurredAt: instant(second++) });
    const otherProjectId = other.projects.find(p => p.externalKey === `ALLOCATION-${approval}-OTHER`.toUpperCase()).id;
    const wrongProject = await decision(`ALLOCATION-${approval}-WRONG-PROJECT`, { projectId: otherProjectId, linkedWorkIds: [] });
    for (const invalid of [undefined, 'minutes:000000000000000000000000#D1', originalDecision, nonOwner, wrongProject]) {
      await assert.rejects(annotateWork(f.workspace, { id: f.id, content: { ...next, ...(invalid === undefined ? {} : { changeDecision: invalid }) }, occurredAt: instant(second++) }), e => e.reasonCode === 'WORK_CONTENT_DECISION_REQUIRED', String(invalid));
    }
    state = await annotateWork(f.workspace, { id: f.id, content: { ...next, changeDecision: currentDecision }, occurredAt: instant(second++) });
    const changed = state.work.find(w => w.id === f.id), recorded = readWorkContentImpact(changed);
    assert.equal(workContent(changed).requirements[0].version, 1);
    assert.equal(recorded.previousRevision, previous.revision);
    assert.equal(recorded.currentRevision, changed.revision);
    assert.notEqual(recorded.previousMeaningDigest, recorded.currentMeaningDigest);
    assert.equal(recorded.impact.requiresDecision, true);
    assert.deepEqual(recorded.impact.changedRequirements, []);
    assert.deepEqual([...recorded.impact.affectedWorkIds].sort(), [f.id, ...f.branches.A, ...f.branches.B].sort());
    for (const id of f.branches.A) assert.deepEqual(effectiveWorkRequirements(state.work, id), []);
    for (const id of [...f.branches.B, ...f.branches.C]) assert.deepEqual(effectiveWorkRequirements(state.work, id)[0].responsibilities, ['implementation', 'verification']);
  }
});

test('native shared requirement additions and toggles persist complete before-and-after impact', async t => {
  const f = await nativeRequirementGraph(t, 'SHARED-IMPACT');
  const expected = [f.id, ...Object.values(f.branches).flat()].sort();
  const added = { ...f.content, requirements: [...f.content.requirements, requirement('R2', true)] };
  let state = await annotateWork(f.workspace, { id: f.id, content: added, occurredAt: instant(20) });
  assert.deepEqual([...readWorkContentImpact(state.work.find(w => w.id === f.id)).impact.affectedWorkIds].sort(), expected);
  for (const id of expected.filter(id => id !== f.id)) assert.equal(effectiveWorkRequirements(state.work, id).some(r => r.requirement.id === 'R2'), true);
  for (const [version, shared] of [[2, true], [3, false]]) {
    const next = { ...added, requirements: added.requirements.map(r => r.id === 'R1' ? { ...r, version, shared } : r) };
    state = await annotateWork(f.workspace, { id: f.id, content: next, occurredAt: instant(20 + version) });
    const impact = readWorkContentImpact(state.work.find(w => w.id === f.id)).impact;
    assert.deepEqual([...impact.affectedWorkIds].sort(), expected);
    assert.deepEqual(impact.changedRequirements, ['R1']);
    for (const id of expected.filter(id => id !== f.id)) assert.equal(effectiveWorkRequirements(state.work, id).some(r => r.requirement.id === 'R1'), shared);
  }
});
