// SPDX-License-Identifier: Apache-2.0
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeLibrary, createProject, createWork, admitTemplateInWorkspace, materializeFromGenesis } from '../dist/build/packages/core/src/index.js';
import { canonicalSha256, createEvent } from '../dist/build/packages/protocol/src/index.js';
import { readOwnStream } from './helpers/library-forge.mjs';
const occurredAt = '2026-10-18T08:00:00Z';

test('workspace reducer rejects altered template binding digests while valid bound and unbound history replay', async t => {
 const base = await mkdtemp(join(tmpdir(), 'template-binding-replay-audit-'));
 t.after(() => rm(base, { recursive: true, force: true }));
 const root = join(base, 'library');
 await initializeLibrary({ root, createdAt: occurredAt });
 let state = await createProject(root, { externalKey: 'REPLAY-P', name: 'Replay', occurredAt });
 const projectId = state.projects[0].id;
 const template = { schemaVersion: 'tcrn.template.v1', id: 'replay.audit', version: 1, appliesTo: ['Story'], headings: ['Goal', 'Acceptance Criteria'], acceptanceHeadings: ['Acceptance Criteria'], referenceHeadings: [], couplings: [] };
 state = await admitTemplateInWorkspace(root, { template, ownerId: 'owner:audit', occurredAt });
 const admission = state.templates[0];
 const add = async (externalKey, kind, parentId, extra = {}) => {
  state = await createWork(root, { projectId, externalKey, kind, parentId, title: externalKey, occurredAt, ...extra });
  return state.work.find(work => work.externalKey === externalKey).id;
 };
 const initiative = await add('REPLAY-INIT', 'Initiative', null);
 const epic = await add('REPLAY-EPIC', 'Epic', initiative);
 const unbound = await add('REPLAY-UNBOUND', 'Story', epic, { goal: 'Unbound historical goal', acceptance: 'Unbound historical acceptance' });
 const bound = await add('REPLAY-BOUND', 'Story', epic, { goal: 'Bound historical goal', acceptance: 'Bound historical acceptance', templateAdmission: admission.receipt });
 const { events } = await readOwnStream(root);
 const original = JSON.stringify(events);
 const valid = materializeFromGenesis(state.metadata, events);
 assert.equal(valid.work.find(work => work.id === unbound).extensions[admission.registrationId], undefined);
 assert.equal(valid.work.find(work => work.id === bound).extensions[admission.registrationId].value.receiptDigest, admission.receipt.receiptDigest);
 assert.deepEqual(valid.work, state.work);
 for (const field of ['templateDigest', 'receiptDigest']) {
  const rebuilt = [];
  for (const event of events) {
   const payload = structuredClone(event.payload);
   if (payload.operation === 'work.created' && payload.record.id === bound) {
    payload.record.extensions[admission.registrationId].value[field] = '0'.repeat(64);
    payload.record.scopeDigest = canonicalSha256(payload.record.extensions);
   }
   // Only an in-memory event chain changes; recompute integrity so the domain reducer,
   // rather than stale event hashes, is what refuses the malformed binding.
   rebuilt.push(createEvent({ id: event.id, streamId: event.streamId, sequence: event.sequence, clock: event.clock, deviceId: event.deviceId, occurredAt: event.occurredAt, priorHash: rebuilt.at(-1)?.eventHash ?? null, payload }));
  }
  assert.throws(() => materializeFromGenesis(state.metadata, rebuilt), error => {
   assert.equal(error.reasonCode, 'WORKSPACE_EVENT_CORRUPT'); assert.match(error.message, /TEMPLATE_BINDING_INVALID/u); return true;
  });
 }
 assert.equal(JSON.stringify(events), original);
 assert.deepEqual((await readOwnStream(root)).events, events, 'synthetic tampering never rewrites fixture history');
});
