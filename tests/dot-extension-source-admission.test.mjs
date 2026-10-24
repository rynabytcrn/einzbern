// SPDX-License-Identifier: Apache-2.0
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProject, initializeLibrary, materializeWorkspace, readDotExtensionSource, recordMinutes, setConfigRecord, setDotExtensionSource } from '../dist/build/packages/core/src/index.js';
import { setConfigRecordDelta } from '../dist/build/packages/core/src/config-records.js';
import { planConfigBackup, validateConfigBackupPayload } from '../dist/build/packages/core/src/config-backup.js';

const at = '2026-10-24T00:00:00Z';
const source = { schemaVersion: 'tcrn.dot-extension-source.v1', version: 1, sourceReference: 'fixture:private-source', executionTarget: 'chatgpt-dot', rules: [{ id: 'fixture-private', body: 'Preserve the private source.', sourceReference: 'fixture:rule' }], files: [], entries: [] };

test('INIT068 dedicated source API enforces native write authorization, not caller surface labels', async t => {
  const base = await mkdtemp(join(tmpdir(), 'dot-source-admission-'));
  const oldSurface = process.env.EINZBERN_SURFACE;
  delete process.env.EINZBERN_SURFACE;
  t.after(async () => { if (oldSurface === undefined) delete process.env.EINZBERN_SURFACE; else process.env.EINZBERN_SURFACE = oldSurface; await rm(base, { recursive: true, force: true }); });
  const root = join(base, 'library');
  await initializeLibrary({ root, createdAt: at });
  let state = await createProject(root, { externalKey: 'SOURCE-P', name: 'Source admission fixture', occurredAt: at });
  const before = state.version;
  const raw = { collection: 'variable', key: 'dot.extensions.source', value: { type: 'string', value: JSON.stringify({ ...source, technicalReferences: [{ kind: 'git-commit', objectFormat: 'sha1', objectId: 'a'.repeat(40), repositoryKey: 'unverified', occurrences: [] }] }), description: '', exports: [] }, occurredAt: at };
  const dedicatedRequired = e => e.reasonCode === 'CONFIG_RECORD_VALUE_INVALID' && e.details?.reason === 'dedicated-source-admission-required';
  await assert.rejects(setConfigRecord(root, raw), dedicatedRequired);
  assert.throws(() => setConfigRecordDelta(raw), dedicatedRequired);
  await assert.rejects(setConfigRecord(root, { ...raw, authorization: { surface: 'atelier' }, verified: true }), dedicatedRequired);
  assert.doesNotThrow(() => setConfigRecordDelta({ ...raw, key: 'fixture.ordinary' }), 'unrelated generic variable shape contract is unchanged');
  assert.doesNotThrow(() => setConfigRecordDelta({ ...raw, value: { ...raw.value, value: JSON.stringify(source) } }), 'plain v1 source compatibility is retained');
  assert.equal((await materializeWorkspace(root)).version, before);
  // No technical references: this fixture tests authority, not Git verification.
  const input = { source, verification: { gitExecutable: '/usr/bin/git', scratchRoot: base, repositories: [] }, occurredAt: at };
  await assert.rejects(setDotExtensionSource(root, input), e => e.reasonCode === 'MODEL_WRITE_REFUSED');
  await assert.rejects(setDotExtensionSource(root, { ...input, authorization: { surface: 'atelier' } }), e => e.reasonCode === 'MODEL_WRITE_REFUSED');
  assert.equal((await materializeWorkspace(root)).version, before);
  state = await recordMinutes(root, { projectId: state.projects[0].id, externalKey: 'SOURCE-MIN', title: 'Source authorization', summary: 'Fixture decision for private source only.', decisions: ['Allow dot.extensions.source source updates.'], decidedBy: ['owner:governance'], linkedWorkIds: [], occurredAt: at });
  const decidedIn = `${state.minutes.find(m => m.externalKey === 'SOURCE-MIN').id}#D1`;
  const accepted = await setDotExtensionSource(root, { ...input, authorization: { decidedIn, surface: 'atelier', decidedInLibraryId: 'library:' + 'f'.repeat(24) } });
  assert.deepEqual(readDotExtensionSource(accepted), source);
  const record = accepted.configRecords.find(r => r.collection === 'variable' && r.key === 'dot.extensions.source');
  assert.deepEqual(record.value.exports, []);
  const event = accepted.events.at(-1);
  assert.equal(event.payload.surface, 'cli');
  assert.notEqual(event.payload.decidedInLibraryId, 'library:' + 'f'.repeat(24));
  assert.ok(!JSON.stringify(event.payload).includes(base), 'ephemeral verification paths never persist');
  await assert.rejects(setDotExtensionSource(root, { ...input, authorization: { decidedIn: `${state.minutes[0].id}#D99` } }), e => e.reasonCode === 'MODEL_WRITE_AUTHORIZATION_INVALID');
  assert.equal((await materializeWorkspace(root)).version, accepted.version);
});

test('INIT068 generic backup visibly excludes technical-reference sources without copying them', () => {
  const payload = { kind: 'variable', name: 'dot.extensions.source', source: 'library-declaration', declaration: { type: 'string', value: JSON.stringify({ ...source, technicalReferences: [] }), description: '', exports: [] } };
  assert.throws(() => validateConfigBackupPayload(payload), e => e.reasonCode === 'CONFIG_BACKUP_DOT_TECHNICAL_REFERENCES_UNSUPPORTED');
  const plan = planConfigBackup({ projectRef: { libraryId: 'workspace:' + '1'.repeat(24), projectId: 'project:' + '2'.repeat(24) }, backupGroupId: '4'.repeat(32), backupId: '5'.repeat(32), hostname: 'Fixture computer', at,
    sourceVersion: { engineVersion: '3.2.0', engineCommit: null, engineCommitStatus: 'unknown', artifactIdentity: { kind: 'observed-artifact-identity', schemaVersion: 'einzbern.install-tree-digest.v1', sha256: '3'.repeat(64) }, templateVersions: [] }, payloads: [payload] });
  assert.equal(plan.members.length, 0);
  assert.equal(plan.excluded[0].reason, 'dot-technical-references-unsupported');
  assert.ok(!JSON.stringify(plan).includes('Preserve the private source.'));
});

for (const phase of ['plannedForTest', 'insideWriteLockForTest']) test(`INIT068 source append rechecks a decision withdrawn at ${phase}`, async t => {
  const base = await mkdtemp(join(tmpdir(), 'dot-source-current-authorization-'));
  const oldSurface = process.env.EINZBERN_SURFACE;
  delete process.env.EINZBERN_SURFACE;
  t.after(async () => { if (oldSurface === undefined) delete process.env.EINZBERN_SURFACE; else process.env.EINZBERN_SURFACE = oldSurface; await rm(base, { recursive: true, force: true }); });
  const root = join(base, 'library');
  await initializeLibrary({ root, createdAt: at });
  let state = await createProject(root, { externalKey: 'CURRENT-P', name: 'Current authorization fixture', occurredAt: at });
  const projectId = state.projects[0].id;
  state = await recordMinutes(root, { projectId, externalKey: 'CURRENT-ALLOW', title: 'Allow private source', summary: 'Isolated fixture authorization.', decisions: ['Allow dot.extensions.source source updates.'], decidedBy: ['owner:governance'], linkedWorkIds: [], occurredAt: at });
  const decidedIn = `${state.minutes.find(m => m.externalKey === 'CURRENT-ALLOW').id}#D1`;
  let withdrawalVersion = null;
  await assert.rejects(setDotExtensionSource(root, {
    source, verification: { gitExecutable: '/usr/bin/git', scratchRoot: base, repositories: [] },
    authorization: { decidedIn }, occurredAt: '2026-10-24T00:00:02Z',
    [phase]: async () => {
      if (withdrawalVersion !== null) return;
      const withdrawn = await recordMinutes(root, { projectId, externalKey: 'CURRENT-WITHDRAW', title: 'Withdraw private source approval', summary: 'Withdrawal after source verification and append planning.', decisions: ['Withdraw earlier private source approval.'], decidedBy: ['owner:governance'], linkedWorkIds: [], withdraws: [decidedIn], occurredAt: '2026-10-24T00:00:01Z' });
      withdrawalVersion = withdrawn.version;
    },
  }), e => e.reasonCode === 'MODEL_WRITE_AUTHORIZATION_INVALID' && e.details?.reason === 'obsolete');
  assert.notEqual(withdrawalVersion, null);
  state = await materializeWorkspace(root);
  assert.equal(state.version, withdrawalVersion, 'only the fixture withdrawal appended, not the source');
  assert.equal(state.configRecords.some(r => r.key === 'dot.extensions.source'), false);
});
