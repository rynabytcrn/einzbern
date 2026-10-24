// SPDX-License-Identifier: Apache-2.0
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { FRAMEWORK_VERSION, initializeLibrary, createProject, createWork, recordMinutes, admitTemplateInWorkspace, setWorkspaceSetting, materializeWorkspace, readWorkContentRolloutReadiness } from '../dist/build/packages/core/src/index.js';
import { workContent } from '../dist/build/packages/core/src/work-content.js';
import { defaultWorkContentTemplate, readWorkContentPolicy, workContentPolicyApplies, workContentRolloutReadiness } from '../dist/build/packages/core/src/work-content-templates.js';
import { readOwnStream } from './helpers/library-forge.mjs';

const before = '2026-01-01T00:00:00Z';
const enabledAt = '2026-01-02T00:00:00Z';
const later = '2026-01-02T00:01:00Z';

test('v2 native pilot: unresolved rollout cannot enable; history and unenabled content rules remain unchanged', async t => {
  const base = await mkdtemp(join(tmpdir(), 'init068-rollout-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'library');
  await initializeLibrary({ root, createdAt: before });
  let state = await createProject(root, { externalKey: 'PILOT', name: 'Isolated content-policy fixture', occurredAt: before });
  const projectId = state.projects[0].id;
  state = await createProject(root, { externalKey: 'DISABLED', name: 'Unenabled control', occurredAt: before });
  const disabledProjectId = state.projects.find(p => p.externalKey === 'DISABLED').id;
  async function add(externalKey, kind, parentId, extra = {}) {
    const legacyFields = kind === 'Story' && extra.content === undefined
      ? { goal: 'Legacy content-policy fixture', acceptance: 'Preserve existing legacy validation and rollout boundaries.' } : {};
    state = await createWork(root, { projectId, externalKey, kind, parentId, title: externalKey, occurredAt: before, ...legacyFields, ...extra });
    return state.work.find(w => w.externalKey === externalKey);
  }
  const initiative = await add('PILOT-INIT', 'Initiative', null);
  const selected = await add('PILOT-EPIC', 'Epic', initiative.id);
  const unrelated = await add('OTHER-EPIC', 'Epic', initiative.id);
  const related = await add('CONTINUATION', 'Story', selected.id);
  const oldUnrelated = await add('OLD-UNRELATED', 'Story', unrelated.id);
  await add('HISTORICAL-DONE', 'Story', selected.id, { status: 'done' });
  await add('HISTORICAL-CANCELLED', 'Story', selected.id, { status: 'cancelled' });
  const historicalRecords = structuredClone(state.work);
  const historicalEvents = structuredClone((await readOwnStream(root)).events);
  state = await recordMinutes(root, { projectId, externalKey: 'PILOT-DECISION', title: 'Fixture policy decision', summary: 'Synthetic isolated decision only', decidedBy: ['owner:fixture'], linkedWorkIds: [], decisions: ['Enable typed content for the selected synthetic subtree; continue only the selected in-flight item.'], occurredAt: before });
  const decision = `${state.minutes.find(m => m.externalKey === 'PILOT-DECISION').id}#D1`;
  const defaults = {};
  for (const kind of ['Initiative', 'Epic', 'Story', 'Subtask']) {
    const template = defaultWorkContentTemplate(kind);
    state = await admitTemplateInWorkspace(root, { template, ownerId: 'owner:fixture', occurredAt: before });
    defaults[kind] = { templateId: template.id, templateVersion: template.version };
  }
  const policy = { schemaVersion: 'tcrn.work-content-policy.v1', enabledAt, scopeWorkIds: [selected.id], inFlightWorkIds: [related.id], defaults, decision };
  // Current same-name 3.2.0 is not a new delivered V. Never fabricate readiness
  // to regain the old v1 positive-enable fixture.
  state = await setWorkspaceSetting(root, { key: 'engine.requiredVersion', value: FRAMEWORK_VERSION, occurredAt: enabledAt });
  const beforeEnable = structuredClone((await readOwnStream(root)).events);
  const pending = {
    schemaVersion: 'tcrn.work-content-rollout-observation.v1', observedAt: later,
    capableRelease: { version: null, buildDigest: null, evidence: null, delivery: 'pending' },
    knownIncapableVersions: ['3.2.0'],
    inventory: { complete: false, evidence: '', unresolvedPaths: ['actual-writer-inventory-unavailable'] },
    writers: [{ id: 'unknown-entry', kind: 'entry', path: 'unresolved', engineVersion: null, buildDigest: null,
      upgradeEvidence: null, state: 'unknown', restrictionEvidence: null }],
    barrier: { settingVersion: FRAMEWORK_VERSION, oldWriterRefusalEvidence: '', effectiveStateEvidence: '', manifestEvidence: '' },
    boundary: { headEventHash: state.headEventHash, versionVector: state.library?.versionVector ?? {} },
  };
  const readiness = await readWorkContentRolloutReadiness(root, pending);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.engineVersion, FRAMEWORK_VERSION);
  assert.equal(readiness.settingFloor, FRAMEWORK_VERSION);
  assert.equal(readiness.manifestFloor, JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).minEngineVersion);
  assert.ok(readiness.problems.includes('CAPABLE_DELIVERY_UNVERIFIED'));
  assert.ok(readiness.problems.includes('WRITER_INVENTORY_UNRESOLVED'));
  for (const proposal of [policy, { ...policy, schemaVersion: 'tcrn.work-content-policy.v2', rollout: pending }]) {
    await assert.rejects(setWorkspaceSetting(root, { key: 'work.contentPolicy', value: JSON.stringify(proposal),
      configurationProjectId: projectId, occurredAt: later }), e => e.reasonCode === 'WORK_CONTENT_ROLLOUT_NOT_READY');
    assert.deepEqual((await readOwnStream(root)).events, beforeEnable, 'refused enablement does not append');
  }
  state = await materializeWorkspace(root);
  assert.equal(readWorkContentPolicy(state, projectId), null);
  assert.equal(readWorkContentPolicy(state, disabledProjectId), null);
  assert.deepEqual(state.work, historicalRecords, 'refused enabling never rewrites existing records');
  assert.deepEqual((await readOwnStream(root)).events.slice(0, historicalEvents.length), historicalEvents);
  // Policy applicability is pure mechanism coverage, not an admitted policy or host receipt.
  assert.equal(workContentPolicyApplies(policy, related, state.work), true);
  assert.equal(workContentPolicyApplies(policy, oldUnrelated, state.work), false);
  for (const w of state.work.filter(w => ['done', 'cancelled'].includes(w.status))) assert.equal(workContentPolicyApplies(policy, w, state.work), false);
  assert.equal(workContentPolicyApplies(policy, { ...related, createdAt: before }, state.work, true, later), true,
    'new late write gets no old-timestamp grandfather under an enabled policy');
  const outside = await add('NEW-OUTSIDE-SCOPE', 'Story', unrelated.id, { occurredAt: later });
  assert.equal(workContent(outside), null);
  const disabled = await add('DISABLED-INIT', 'Initiative', null, { projectId: disabledProjectId, occurredAt: later });
  assert.equal(workContent(disabled), null);
  assert.equal(state.settings.find(s => s.key === 'engine.requiredVersion').value, FRAMEWORK_VERSION);
  assert.equal(state.settings.some(s => s.key === 'work.contentPolicy'), false, 'refused proposals leave the disposable library without an enabled content policy');
});

// A current API omission test is NOT proof of an old executable's behavior.
// Batch acceptance must run actual available old versions and retain their raw refusals.
test.todo('legacy 3.1.0: unsupported-format and omitted-binding writes against an isolated content-enabled library');
test.todo('legacy 3.2.0: omitted-binding enforcement against an isolated content-enabled library');


// This is a mechanism probe, NOT acceptance of an actual delivered V. The evaluator
// supplies a verified original executable and its independently obtained SHA-256.
// No private host path, guessed version, installation or control-tree write is embedded.
const oldEngine = process.env.INIT068_OLD_ENGINE;
const oldEngineSha256 = process.env.INIT068_OLD_ENGINE_SHA256;
test('v2 mechanism only: actual original 3.2.0 and current candidate both refuse a synthetic future floor without effective append', {
  skip: !oldEngine || !oldEngineSha256 ? 'not verified: provide original executable and independently verified SHA-256' : false,
}, async t => {
  assert.match(oldEngineSha256, /^[a-f0-9]{64}$/u);
  assert.equal(createHash('sha256').update(await readFile(oldEngine)).digest('hex'), oldEngineSha256);
  const base = await mkdtemp(join(tmpdir(), 'init068-floor-mechanism-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'library');
  await initializeLibrary({ root, createdAt: before });
  let state = await createProject(root, { externalKey: 'FLOOR-CONTROL', name: 'Unenabled floor mechanism control', occurredAt: before });
  const projectId = state.projects[0].id;
  const major = Number(FRAMEWORK_VERSION.split('.')[0]);
  const syntheticFloor = `${major + 1}.0.0`;
  state = await setWorkspaceSetting(root, { key: 'engine.requiredVersion', value: syntheticFloor, occurredAt: later });
  assert.equal(state.settings.find(s => s.key === 'engine.requiredVersion').value, syntheticFloor);
  // Read-only byte snapshot of effective library control/streams. No forge helper used.
  async function chainBytes() {
    const result = {};
    async function walk(relative) {
      for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
        const path = join(relative, item.name);
        if (item.isDirectory()) await walk(path);
        else if (item.isFile()) result[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
      }
    }
    result['manifest.json'] = createHash('sha256').update(await readFile(join(root, 'manifest.json'))).digest('hex');
    await walk('akasha');
    return result;
  }
  const beforeBytes = await chainBytes();
  const original = spawnSync(process.execPath, [oldEngine, 'work-create', '--workspace', root, '--at', before,
    '--project-id', projectId, '--external-key', 'OLD-LATE-WRITE', '--kind', 'Initiative', '--title', 'Old timestamp cannot bypass floor'],
  { encoding: 'utf8', timeout: 60000, env: { ...process.env } });
  assert.equal(original.error, undefined);
  assert.notEqual(original.status, 0);
  assert.match(original.stderr + original.stdout, /WORKSPACE_ENGINE_VERSION_MISMATCH/u);
  assert.match(original.stderr + original.stdout, /3\.2\.0/u, 'refusal must expose actual original engine version');
  assert.deepEqual(await chainBytes(), beforeBytes, 'old client refusal must leave effective chain unchanged');
  await assert.rejects(createWork(root, { projectId, externalKey: 'CURRENT-REFUSED', kind: 'Initiative', parentId: null,
    title: 'Current candidate is also below the synthetic floor', occurredAt: before }), e => e.reasonCode === 'WORKSPACE_ENGINE_VERSION_MISMATCH');
  assert.deepEqual(await chainBytes(), beforeBytes, 'current candidate refusal must leave effective chain unchanged');
  t.diagnostic(JSON.stringify({ classification: 'synthetic-future-floor-mechanism-only', actualDeliveredV: null,
    currentCandidate: FRAMEWORK_VERSION, syntheticFloor, originalExecutableSha256: oldEngineSha256,
    oldExitCode: original.status, oldStdout: original.stdout, oldStderr: original.stderr, effectiveAppend: false }));
});

test.todo('v2 actual delivered V: old3.2 refusal and compatible new-client unenabled-project behavior at the SAME real library floor');
test.todo('v2 real prestarted old process: stopped finality or repeated-write refusal for the SAME running process');
test.todo('v2 real offline increment: complete refresh, semantic reapply and full readback; original increment retained; no timestamp grandfather');


test('v2 synthetic readiness structure: unknown/offline/process/sync writers and stale boundary prevent readiness', () => {
  // Pure fabricated DATA to exercise validation, never submitted to a native setter
  // and never represented as evidence of a real engine release, writer or process.
  const state = { settings: [{ key: 'engine.requiredVersion', value: '9.0.0' }],
    headEventHash: 'a'.repeat(64), library: { versionVector: { 'fixture-stream': 3 } } };
  const observation = {
    schemaVersion: 'tcrn.work-content-rollout-observation.v1', observedAt: later,
    capableRelease: { version: '9.0.0', buildDigest: 'b'.repeat(64), evidence: 'synthetic-only:release', delivery: 'verified' },
    knownIncapableVersions: ['3.2.0'], inventory: { complete: true, evidence: 'synthetic-only:inventory', unresolvedPaths: [] },
    writers: [{ id: 'fixture-client', kind: 'client', path: 'synthetic-only:client', engineVersion: '9.0.0',
      buildDigest: 'b'.repeat(64), upgradeEvidence: 'synthetic-only:upgrade', state: 'upgraded', restrictionEvidence: null }],
    barrier: { settingVersion: '9.0.0', oldWriterRefusalEvidence: 'synthetic-only:refusal', effectiveStateEvidence: 'synthetic-only:state', manifestEvidence: 'synthetic-only:manifest' },
    boundary: { headEventHash: state.headEventHash, versionVector: { 'fixture-stream': 3 } },
  };
  const options = { engineVersion: '9.0.0', manifestMinEngineVersion: '3.0.1' };
  const baseline = workContentRolloutReadiness(state, observation, options);
  assert.equal(baseline.ready, true, 'structural fixture only, not runtime V acceptance');
  assert.equal(baseline.authentication, 'not-provided');
  assert.equal(baseline.unseenWriters, 'not-proven-absent');
  const unknown = structuredClone(observation); unknown.writers[0].state = 'unknown';
  assert.ok(workContentRolloutReadiness(state, unknown, options).problems.includes('WRITER_UNRESOLVED:fixture-client'));
  for (const kind of ['offline-copy', 'direct-sync', 'process', 'entry']) {
    const untreated = structuredClone(observation); untreated.writers[0].kind = kind;
    assert.ok(workContentRolloutReadiness(state, untreated, options).problems.includes('OLD_ENTRY_RESTRICTION_UNVERIFIED:fixture-client'));
  }
  const stale = structuredClone(observation); stale.boundary.versionVector['fixture-stream'] = 2;
  assert.ok(workContentRolloutReadiness(state, stale, options).problems.includes('ACCEPTED_BOUNDARY_STALE_REFRESH_REQUIRED'));
  const sameVersion = structuredClone(observation); sameVersion.capableRelease.version = '3.2.0';
  assert.ok(workContentRolloutReadiness(state, sameVersion, options).problems.includes('CAPABLE_VERSION_NOT_DISTINGUISHABLE'));
  const noBarrier = structuredClone(observation); noBarrier.barrier.effectiveStateEvidence = '';
  assert.ok(workContentRolloutReadiness(state, noBarrier, options).problems.includes('BARRIER_EFFECT_UNVERIFIED'));
});

test.todo('v2 actual delivered V: enabled-project missing content/binding refuses without effective append');
test.todo('v2 actual delivered V: project-rule disable retains library floor and accepted typed history; actual downgrade remains refused');
test.todo('v2 actual delivered V: enabled new work binds admitted type default and only related in-flight work adopts content; historical terminal records preserved');
