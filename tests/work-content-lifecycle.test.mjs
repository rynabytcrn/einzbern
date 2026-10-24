import { workAcceptanceMeaningDigest } from '../dist/build/packages/core/src/work-acceptance.js';
// SPDX-License-Identifier: Apache-2.0
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeLibrary, createProject, createWork, annotateWork, transitionWork, admitTemplateInWorkspace, applyWorkBatch, workContentDraft, defaultWorkContentTemplate, workContent, readWorkContentImpact, materializeFromGenesis } from '../dist/build/packages/core/src/index.js';
import { readOwnStream } from './helpers/library-forge.mjs';
const occurredAt = '2026-10-24T00:00:00Z';

test('INIT068 create/annotate/batch/start/done use one canonical lifecycle and replay preserves draft history', async t => {
  const base = await mkdtemp(join(tmpdir(), 'work-content-lifecycle-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'library'); await initializeLibrary({ root, createdAt: occurredAt });
  let state = await createProject(root, { externalKey: 'CONTENT-P', name: 'Content', occurredAt });
  const projectId = state.projects[0].id;
  const add = async (externalKey, kind, parentId, extra = {}) => { state = await createWork(root, { projectId, externalKey, kind, parentId, title: externalKey, occurredAt, ...extra }); return state.work.find(w => w.externalKey === externalKey).id; };
  const init = await add('CONTENT-INIT', 'Initiative', null), epic = await add('CONTENT-EPIC', 'Epic', init);
  state = await admitTemplateInWorkspace(root, { template: defaultWorkContentTemplate('Story'), ownerId: 'owner:fixture', occurredAt });
  const receipt = state.templates.find(t => t.template.id === 'minimum-story').receipt;
  const draft = workContentDraft('Story');
  const id = await add('CONTENT-STORY', 'Story', epic, { content: draft, templateAdmission: receipt });
  assert.deepEqual(workContent(state.work.find(w => w.id === id)), draft);
  await assert.rejects(transitionWork(root, { id, status: 'ready', occurredAt }), e => e.reasonCode === 'WORK_CONTENT_INCOMPLETE');
  await assert.rejects(annotateWork(root, { id, goal: 'a second source', occurredAt }), e => e.reasonCode === 'WORK_CONTENT_SINGLE_SOURCE');
  await assert.rejects(applyWorkBatch(root, { schemaVersion: 'tcrn.work-batch.v1', members: [{ verb: 'work-transition', id, status: 'done' }] }, { occurredAt }), e => e.reasonCode === 'WORK_BATCH_REFUSED' && e.message.includes('WORK_CONTENT_INCOMPLETE'));
  const source = { id: 's', kind: 'user-request', locator: 'message:fixture#request', version: '1', extraction: 'complete', text: 'Preserve the data.' };
  const ref = { workId: id, requirementId: 'R1', version: 1 };
  const content = { ...draft, goal: 'Preserve data', scope: 'Fixture only', sources: [source], details: { behavior: 'Preserve bytes', discretion: 'Choose internal helper' }, requirements: [{ id: 'R1', version: 1, text: 'Preserve bytes', sourceIds: ['s'], shared: false, disposition: 'required' }], acceptance: [{ id: 'A1', version: 1, requirement: ref, scenario: 'cleanup', expected: 'bytes remain', method: 'compare file bytes' }] };
  state = await annotateWork(root, { id, content, occurredAt });
  state = await transitionWork(root, { id, status: 'ready', occurredAt });
  state = await transitionWork(root, { id, status: 'active', occurredAt });
  await assert.rejects(transitionWork(root, { id, status: 'done', occurredAt }), e => e.reasonCode === 'WORK_CONTENT_INCOMPLETE');
  content.completion = { result: 'Bytes preserved in the fixture', codeVersion: 'candidate-1' };
  content.evidence = [{ acceptanceId: 'A1', acceptanceVersion: 1, requirement: ref, codeVersion: 'candidate-1', locator: 'fixture://assertion', actual: 'before and after bytes equal', kind: 'machine', outcome: 'satisfied' }];
  state = await annotateWork(root, { id, content, occurredAt });
  const firstBound = workContent(state.work.find(w => w.id === id)).evidence[0].meaningDigest;
  content.constraints = ['Preserve a second designated directory'];
  content.evidence[0].meaningDigest = 'f'.repeat(64); // Cannot relabel a retained observation.
  state = await annotateWork(root, { id, content, occurredAt });
  const changed = state.work.find(w => w.id === id);
  assert.equal(workContent(changed).evidence[0].meaningDigest, 'f'.repeat(64), 'explicit stale binding is preserved, never silently replaced');
  assert.notEqual(workAcceptanceMeaningDigest(state.work, changed, 'A1'), firstBound);
  assert.equal(readWorkContentImpact(changed).currentRevision, changed.revision);
  assert.equal(readWorkContentImpact(changed).impact.changedMeaning, true);
  assert.ok(readWorkContentImpact(changed).impact.affectedEvidence.some(e => e.acceptanceId === 'A1'));
  await assert.rejects(transitionWork(root, { id, status: 'done', occurredAt }), e => e.reasonCode === 'WORK_CONTENT_INCOMPLETE');
  delete content.evidence[0].meaningDigest; // A genuinely new observation may request engine binding.
  content.evidence[0].actual = 'New observation: second designated directory retained equal bytes';
  state = await annotateWork(root, { id, content, occurredAt });
  state = await transitionWork(root, { id, status: 'done', occurredAt });
  await assert.rejects(annotateWork(root, { id, content: { ...content, body: 'rewrite historical result' }, occurredAt }), e => e.reasonCode === 'WORK_CONTENT_TERMINAL');
  const { events } = await readOwnStream(root);
  assert.deepEqual(materializeFromGenesis(state.metadata, events).work, state.work);
});
