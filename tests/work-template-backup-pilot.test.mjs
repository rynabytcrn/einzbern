// SPDX-License-Identifier: Apache-2.0
// Fabricated label-formatting data exercises work-content bookkeeping only.
// No formatter implementation, real request, approval or product result is claimed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workContentDraft, validateWorkContent, workContentMissing } from '../dist/build/packages/core/src/work-content.js';
import { effectiveWorkRequirements, workRequirementProblems, assertWorkContentChange, workContentChangeImpact } from '../dist/build/packages/core/src/work-requirements.js';
import { workAcceptanceProblems, workAcceptanceMeaningDigest } from '../dist/build/packages/core/src/work-acceptance.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/work-template-backup-pilot/cases.json', import.meta.url), 'utf8'));
const parentId = `work:${'1'.repeat(24)}`;
const childId = `work:${'2'.repeat(24)}`;
const codeVersion = 'synthetic-candidate';

function sample() {
  const content = {
    ...workContentDraft('Story'),
    goal: 'Describe an invented label formatter',
    scope: 'Synthetic work-content records only',
    sources: [structuredClone(fixture.source)],
    constraints: ['No language translation'],
    requirements: structuredClone(fixture.requirements),
    approved: true,
    details: { behavior: 'Trim surrounding whitespace and retain letter case', discretion: 'Choice of formatting algorithm' },
  };
  content.allocations = content.requirements.flatMap(r => ['implementation', 'verification'].map(responsibility => ({ workId: parentId, requirementId: r.id, version: r.version, childId, responsibility })));
  content.acceptance = content.requirements.map(r => ({ id: `CHECK-${r.id}`, version: 1, requirement: { workId: parentId, requirementId: r.id, version: r.version }, scenario: `Fabricated label example for ${r.id}`, expected: r.text, method: 'Inspect synthetic requirement and evidence links' }));
  content.evidence = content.acceptance.map(a => ({ acceptanceId: a.id, acceptanceVersion: a.version, requirement: a.requirement, codeVersion, locator: `synthetic-only:${a.id}`, actual: 'Fabricated observation for structural validation; no formatter was executed', outcome: 'satisfied', kind: 'source-behavior-review' }));
  content.completion = { result: 'Synthetic linkage fixture only', codeVersion };
  const parent = { id: parentId, kind: 'Story', parentId: null, status: 'active', tombstone: false, title: 'Fabricated formatter', extensions: { 'advisory:work-content': { required: false, value: content } } };
  const child = { id: childId, kind: 'Subtask', parentId, status: 'planned', tombstone: false, extensions: {} };
  const work = [parent, child];
  // Bind fabricated evidence once; negative cases retain that initial binding.
  content.evidence.forEach(e => { e.meaningDigest = workAcceptanceMeaningDigest(work, parent, e.acceptanceId); });
  return { content, parent, child, work };
}

test('synthetic requirements retain separate implementation and verification allocations', () => {
  const { content, parent, child, work } = sample();
  assert.equal(fixture.fixtureOnly, true);
  assert.equal(validateWorkContent(content), content);
  assert.deepEqual(workContentMissing(content, 'done'), []);
  assert.deepEqual(workRequirementProblems(work, parent), []);
  assert.deepEqual(workAcceptanceProblems(work, parent, { done: true, codeVersion }), []);
  assert.deepEqual(effectiveWorkRequirements(work, child.id).map(r => r.requirement.id).sort(), fixture.requirements.map(r => r.id).sort());
  assert.ok(effectiveWorkRequirements(work, child.id).every(r => r.inherited && r.responsibilities.length === 2));
});

test('one requirement allocation cannot substitute for another requirement', () => {
  const { content, parent, work } = sample();
  content.allocations = content.allocations.filter(a => a.requirementId !== 'CASE' || a.responsibility !== 'implementation');
  assert.ok(workRequirementProblems(work, parent).includes('requirement:CASE:allocation:implementation:unresolved'));
});

test('changed acceptance meaning requires a new version even when its ID is retained', () => {
  const { content, parent, work } = sample();
  const next = structuredClone(content);
  next.acceptance.find(a => a.id === 'CHECK-CASE').expected = 'Convert every letter to uppercase.';
  assert.throws(() => assertWorkContentChange(work, parent, next), e => e.reasonCode === 'WORK_ACCEPTANCE_VERSION');
  assert.deepEqual(workContentChangeImpact(work, parent, next).changedAcceptance, ['CHECK-CASE']);
});

test('a version increment and explanatory prose do not replace a required decision', () => {
  const { content, parent, work } = sample();
  const next = structuredClone(content);
  const acceptance = next.acceptance.find(a => a.id === 'CHECK-CASE');
  acceptance.version += 1;
  acceptance.expected = 'Convert every letter to uppercase.';
  next.body = 'A proposed formatting change; no decision is attached.';
  assert.throws(() => assertWorkContentChange(work, parent, next), e => e.reasonCode === 'WORK_CONTENT_DECISION_REQUIRED');
});

test('evidence for an earlier requirement and acceptance version stays stale', () => {
  const { content, parent, work } = sample();
  content.requirements[1].version = 2;
  content.acceptance[1].version = 2;
  content.acceptance[1].requirement = { ...content.acceptance[1].requirement, version: 2 };
  const problems = workAcceptanceProblems(work, parent, { done: true, codeVersion });
  assert.ok(problems.includes('evidence:CHECK-CASE:version:stale'));
  assert.ok(problems.includes('acceptance:CHECK-CASE:evidence:missing'));
});

test('satisfied machine evidence does not erase an unresolved behavior observation', () => {
  const { content, parent, work } = sample();
  content.evidence = [
    { ...content.evidence[1], kind: 'machine', actual: 'Synthetic operation returned without an error' },
    { ...content.evidence[1], kind: 'source-behavior-review', outcome: 'unverified', actual: 'The synthetic observation contains no output label to inspect' },
  ];
  assert.ok(workAcceptanceProblems(work, parent, { done: true, codeVersion }).includes('acceptance:CHECK-CASE:evidence:unresolved'));
});

test('missing observations and a bare passed label cannot complete acceptance', () => {
  const { content, parent, work } = sample();
  content.evidence = [];
  assert.ok(workAcceptanceProblems(work, parent, { done: true, codeVersion }).includes('acceptance:CHECK-CASE:evidence:missing'));
  const other = sample();
  other.content.evidence.forEach(e => { e.actual = 'passed'; });
  assert.ok(workAcceptanceProblems(other.work, other.parent, { done: true, codeVersion }).includes('acceptance:CHECK-CASE:evidence:missing'));
});

test('evidence is candidate-specific but title and progress text do not change its meaning', () => {
  const { content, parent, work } = sample();
  assert.ok(workAcceptanceProblems(work, parent, { done: true, codeVersion: 'different-candidate' }).includes('acceptance:CHECK-CASE:evidence:missing'));
  const next = structuredClone(content);
  next.body = 'Progress note only; no requirements, acceptance or constraints changed.';
  assert.doesNotThrow(() => assertWorkContentChange(work, { ...parent, title: 'New title' }, next));
  assert.deepEqual(workContentChangeImpact(work, parent, next).changedRequirements, []);
  assert.deepEqual(workAcceptanceProblems(work, parent, { done: true, codeVersion }), []);
});

test('an unavailable synthetic source remains incomplete for implementation', () => {
  const { content } = sample();
  content.sources[0].extraction = 'unavailable';
  content.sources[0].text = '';
  assert.deepEqual(workContentMissing(content, 'draft'), []);
  assert.ok(workContentMissing(content, 'start').includes(`sources.${fixture.source.id}.extraction`));
});

test('same-version source or scope drift cannot reuse an earlier evidence binding', () => {
  for (const mutate of [
    content => { content.sources[0].text = 'Invented replacement request: translate labels into another language.'; },
    content => { content.scope = 'Synthetic localization instead of label formatting'; },
  ]) {
    const { content, parent, work } = sample();
    mutate(content);
    assert.ok(workAcceptanceProblems(work, parent, { done: true, codeVersion }).includes('acceptance:CHECK-CASE:evidence:missing'));
  }
});
