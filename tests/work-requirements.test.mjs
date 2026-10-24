// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { WORK_CONTENT_KEY, workContentDraft, effectiveWorkRequirements, workRequirementProblems, workContentChangeImpact, assertWorkContentChange } from '../dist/build/packages/core/src/index.js';
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
