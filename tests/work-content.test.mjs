// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTemplateDefinition } from '../dist/build/packages/core/src/template-admission.js';
import { workContentDraft, validateWorkContent, workContentMissing, workContentFields, storyFields, WORK_CONTENT_KEY, defaultWorkContentTemplate } from '../dist/build/packages/core/src/index.js';

test('INIT068 minimum typed drafts do not fabricate completion or mandatory body headings', () => {
  for (const kind of ['Initiative', 'Epic', 'Story', 'Subtask']) {
    const draft = workContentDraft(kind);
    assert.equal(draft.completion, undefined);
    assert.deepEqual(workContentMissing(draft, 'draft'), []);
    assert.ok(workContentMissing(draft, 'write').includes('goal'));
    assert.deepEqual(validateTemplateDefinition(defaultWorkContentTemplate(kind)).headings, []);
  }
  assert.ok(workContentMissing(workContentDraft('Story', { variant: 'defect' }), 'write').includes('details.reproduction'));
  assert.throws(() => workContentDraft('Epic', { variant: 'defect' }));
});

test('INIT068 canonical content projects fields and accepts free body while old fields read unchanged', () => {
  const content = { ...workContentDraft('Story'), goal: 'Do the actual thing', body: 'Free prose, no template headings.' };
  const record = { extensions: { [WORK_CONTENT_KEY]: { required: false, value: content } } };
  assert.deepEqual(storyFields(record), { ...workContentFields(content), source: 'fields' });
  const legacy = { extensions: { 'advisory:goal': { required: false, value: 'old goal' }, 'advisory:acceptance': { required: false, value: 'old criteria' } } };
  assert.equal(storyFields(legacy).goal, 'old goal');
  assert.throws(() => validateWorkContent({ ...content, schemaVersion: 'future' }));
  assert.throws(() => validateWorkContent({ ...content, invented: true }));
  assert.equal(validateWorkContent(content).body, content.body);
});
