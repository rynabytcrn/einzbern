// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/device-home.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreLegacyFixture } from './helpers/legacy-fixture.mjs';
import { FRAMEWORK_VERSION, initializeLibrary, readWorkContentRolloutReadiness } from '../dist/build/packages/core/src/index.js';
import { readWorkContentPolicy, workContentPolicyApplies, validateWorkContentPolicy, defaultWorkContentTemplate, createTemplateAdmissionRecord, admitTemplate, createWorkDelta, WORK_CONTENT_POLICY_KEY, workContentDraft, workContent } from '../dist/build/packages/core/src/index.js';
const kinds = ['Initiative', 'Epic', 'Story', 'Subtask'];
const enabledAt = '2026-10-24T00:00:00Z';
const rootId = 'work:' + '1'.repeat(24), liveId = 'work:' + '2'.repeat(24);
const defaults = Object.fromEntries(kinds.map(k => [k, { templateId: defaultWorkContentTemplate(k).id, templateVersion: 1 }]));
const policy = { schemaVersion: 'tcrn.work-content-policy.v1', enabledAt, scopeWorkIds: [rootId], inFlightWorkIds: [liveId], defaults, decision: 'minutes:' + '3'.repeat(24) + '#D1' };
test('INIT068 native readiness allowlists options and distinguishes readable legacy from corrupt library', async t => {
  const base = await mkdtemp(join(tmpdir(), 'content-native-readiness-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'library');
  await initializeLibrary({ root, createdAt: enabledAt });
  const native = await readWorkContentRolloutReadiness(root, null);
  const extraOptions = { engineVersion: '9.0.0', manifestMinEngineVersion: '9.0.0', requireCurrentBoundary: 'false' };
  const attacked = await readWorkContentRolloutReadiness(root, null, extraOptions);
  assert.equal(attacked.engineVersion, FRAMEWORK_VERSION);
  assert.equal(attacked.manifestFloor, native.manifestFloor);
  assert.deepEqual(attacked, native, 'untyped caller options cannot replace native observations');
  const legacy = await restoreLegacyFixture(base, 'legacy');
  const legacyReport = await readWorkContentRolloutReadiness(legacy.root, null, extraOptions);
  assert.equal(legacyReport.engineVersion, FRAMEWORK_VERSION);
  assert.equal(legacyReport.manifestFloor, null);
  assert.equal(legacyReport.ready, false);
  assert.ok(legacyReport.problems.includes('MANIFEST_FLOOR_UNOBSERVED'));
  // Owned isolated fixture only: a present but invalid library manifest must not
  // fall back to the readable old-layout workspace alongside it.
  await writeFile(join(legacy.root, 'manifest.json'), '{}');
  await assert.rejects(readWorkContentRolloutReadiness(legacy.root, null), e => e.reasonCode === 'LIBRARY_MANIFEST_INVALID');
});
test('INIT068 rollout is explicit project/time/subtree/in-flight scope; terminal and unrelated history remain untouched', () => {
  validateWorkContentPolicy(policy);
  const settings = [{ key: WORK_CONTENT_POLICY_KEY, projectId: 'project-a', value: JSON.stringify(policy) }];
  assert.equal(readWorkContentPolicy({ settings }, 'project-b'), null);
  assert.deepEqual(readWorkContentPolicy({ settings }, 'project-a'), policy);
  const child = { id: 'child', parentId: rootId, createdAt: enabledAt, status: 'planned' };
  assert.equal(workContentPolicyApplies(policy, child, [], true), true);
  assert.equal(workContentPolicyApplies(policy, { ...child, parentId: null }, [], true), false);
  assert.equal(workContentPolicyApplies(policy, { ...child, createdAt: '2020-01-01T00:00:00Z' }, []), false);
  assert.equal(workContentPolicyApplies(policy, { ...child, id: liveId, createdAt: null }, []), true);
  assert.equal(workContentPolicyApplies(policy, { ...child, id: liveId, status: 'done' }, []), false);
  assert.equal(workContentPolicyApplies(null, child, [], true), false);
  assert.throws(() => validateWorkContentPolicy({ ...policy, enabledAt: 'yesterday' }));
});

test('INIT068 scoped new work cannot omit content/binding to fall back to legacy creation', () => {
  const projectId = 'project:' + 'a'.repeat(24);
  const templates = kinds.map(kind => { const t = defaultWorkContentTemplate(kind); return createTemplateAdmissionRecord(t, admitTemplate(t, { ownerId: 'owner:fixture', admittedAt: enabledAt })); });
  const state = { projects: [{ id: projectId, tombstone: false }], work: [], templates, minutes: [], settings: [{ key: WORK_CONTENT_POLICY_KEY, projectId, value: JSON.stringify({ ...policy, scopeWorkIds: [], inFlightWorkIds: [] }) }] };
  const input = { projectId, externalKey: 'ROLLOUT-INIT', kind: 'Initiative', parentId: null, title: 'Rollout fixture', occurredAt: enabledAt };
  assert.throws(() => createWorkDelta(input)(state), e => e.reasonCode === 'WORK_CONTENT_REQUIRED');
  const delta = createWorkDelta({ ...input, content: workContentDraft('Initiative') })(state);
  assert.equal(workContent(delta.work[0]).kind, 'Initiative');
  assert.ok(Object.keys(delta.work[0].extensions).some(key => key.startsWith('template:')));
});


test('INIT068 new writes use admission time, never caller backdating; future schedules stay inert until due', () => {
  const record = { id: 'new', parentId: rootId, createdAt: '2020-01-01T00:00:00Z', status: 'planned' };
  assert.equal(workContentPolicyApplies(policy, record, [], true, '2026-10-24T05:00:00Z'), true);
  assert.equal(workContentPolicyApplies(policy, record, [], true, '2026-10-23T23:00:00Z'), false);
  assert.equal(workContentPolicyApplies(policy, record, [], false), false, 'existing historical record remains exempt');
});

test('INIT068 R15v2 synthetic readiness models evidence gaps without declaring a real capable delivery', async () => {
  const { workContentRolloutReadiness } = await import('../dist/build/packages/core/src/work-content-templates.js');
  // Pure synthetic model only: 9.0.0 is not a release assignment or an actual running host.
  const state = { settings: [{ key: 'engine.requiredVersion', value: '9.0.0' }], headEventHash: 'a'.repeat(64), library: { versionVector: { device: 1 } } };
  const observation = { schemaVersion: 'tcrn.work-content-rollout-observation.v1', observedAt: enabledAt,
    capableRelease: { version: '9.0.0', buildDigest: 'b'.repeat(64), evidence: 'synthetic-only:delivery', delivery: 'verified' },
    knownIncapableVersions: ['3.2.0'], inventory: { complete: true, evidence: 'synthetic-only:inventory', unresolvedPaths: [] },
    writers: [{ id: 'synthetic', kind: 'client', path: 'synthetic-only:client', engineVersion: '9.0.0', buildDigest: 'b'.repeat(64), upgradeEvidence: 'synthetic-only:upgrade', state: 'upgraded', restrictionEvidence: 'synthetic-only:old-entry-disabled' }],
    barrier: { settingVersion: '9.0.0', oldWriterRefusalEvidence: 'synthetic-only:refusal', effectiveStateEvidence: 'synthetic-only:no-new-effective-event', manifestEvidence: 'synthetic-only:manifest' },
    boundary: { headEventHash: state.headEventHash, versionVector: { device: 1 } } };
  const options = { engineVersion: '9.0.0', manifestMinEngineVersion: '3.2.0' };
  assert.equal(workContentRolloutReadiness(state, observation, options).ready, true, 'synthetic mechanism model, not actual V acceptance');
  assert.equal(workContentRolloutReadiness(state, observation, { ...options, engineVersion: '3.2.0' }).ready, false);
  assert.equal(workContentRolloutReadiness(state, { ...observation, capableRelease: { ...observation.capableRelease, delivery: 'pending' } }, options).ready, false);
  assert.equal(workContentRolloutReadiness(state, { ...observation, inventory: { ...observation.inventory, unresolvedPaths: ['offline old copy'] } }, options).ready, false);
  assert.equal(workContentRolloutReadiness({ ...state, headEventHash: 'c'.repeat(64) }, observation, options).ready, false);
  assert.equal(workContentRolloutReadiness(state, null, options).ready, false);
  const same = { ...observation, knownIncapableVersions: ['3.1.0'], capableRelease: { ...observation.capableRelease, version: '3.2.0' }, barrier: { ...observation.barrier, settingVersion: '3.2.0' } };
  assert.ok(workContentRolloutReadiness({ ...state, settings: [{ key: 'engine.requiredVersion', value: '3.2.0' }] }, same, { ...options, engineVersion: '3.2.0' }).problems.includes('CAPABLE_VERSION_NOT_DISTINGUISHABLE'));
});
