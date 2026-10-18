// SPDX-License-Identifier: Apache-2.0
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { initializeLibrary, createProject, registerLibrary, readRegistry, materializeWorkspace, applyWorkBatch, admitTemplate, createTemplateAdmissionRecord, templateBindingFromReceipt, validateBoundTemplateWork } from '../dist/build/packages/core/src/index.js';
import { verifyRestore } from '../dist/build/packages/core/src/setup-restore.js';
import { planSetup, applySetup } from '../dist/build/packages/core/src/setup.js';
const at = '2026-10-18T08:00:00Z';
async function fixture(t) {
 const base = await mkdtemp(join(tmpdir(), 'governance-batch-audit-'));
 t.after(() => rm(base, { recursive: true, force: true }));
 const old = join(base, 'old'), target = join(base, 'target'), projectRoot = join(base, 'project'), home = join(base, 'home'), deviceHome = join(base, 'device');
 await mkdir(projectRoot); await mkdir(home);
 await initializeLibrary({ root: old, createdAt: at });
 const state = await createProject(old, { externalKey: 'AUDIT-PROJECT', name: 'Audit', occurredAt: at });
 const projectId = state.projects[0].id;
 await registerLibrary({ projectPath: projectRoot, libraryPath: old, projectId, registeredAt: at, gitRemote: null }, deviceHome);
 await cp(old, target, { recursive: true });
 return { base, old, target, projectRoot, home, deviceHome, projectId, input: { projectRoot, home, deviceHome, libraryPath: target } };
}
test('restore preserves an explicit project binding through admitted move verification, plan and apply', async t => {
 const f = await fixture(t);
 const previous = process.env.EINZBERN_HOME; process.env.EINZBERN_HOME = f.deviceHome;
 t.after(() => { if (previous === undefined) delete process.env.EINZBERN_HOME; else process.env.EINZBERN_HOME = previous; });
 const same = await verifyRestore({ ...f.input, libraryPath: f.old }); assert.equal(same.ok, true);
 const duplicate = await verifyRestore(f.input); assert.equal(duplicate.checks.at(-1).detail.cause, 'LIBRARY_COPY_REGISTERED');
 await rename(f.old, join(f.base, 'retained'));
 const verified = await verifyRestore(f.input); assert.equal(verified.ok, true, JSON.stringify(verified.checks));
 assert.equal(verified.library.configurationProjectId, f.projectId);
 // A minimal local engine source, never executed: restore only copies its wiring files.
 const engine = join(f.deviceHome, 'engine', '1.0.0');
 for (const [path, text] of [['scripts/einzbern.mjs', '// fixture\n'], ['launchers/einzbern.mjs', '// fixture\n'], ['launchers/hook.mjs', '// fixture\n'], ['skill/mana-orchestrate/SKILL.md', '# Fixture\n']]) {
  await mkdir(dirname(join(engine, path)), { recursive: true }); await writeFile(join(engine, path), text);
 }
 await writeFile(join(f.deviceHome, 'engine/current'), JSON.stringify({ schemaVersion: 'einzbern.engine-current.v1', version: '1.0.0', previous: null, switchedAt: at }));
 const before = await materializeWorkspace(f.target);
 const plan = await planSetup({ mode: 'restore', projectRoot: f.projectRoot, home: f.home, deviceHome: f.deviceHome, restore: f.target, at });
 assert.deepEqual(plan.blockers, []);
 const applied = await applySetup(plan); assert.equal(applied.reasonCode, 'SETUP_APPLIED');
 const entry = (await readRegistry(f.deviceHome)).entries.find(entry => entry.projectPath === f.projectRoot);
 assert.equal(entry.libraryPath, f.target); assert.equal(entry.projectId, f.projectId);
 const after = await materializeWorkspace(f.target);
 assert.deepEqual(after.projects, before.projects, 'restore must not mint another setup project');
});
for (const invalid of ['directory', 'json', 'schema']) test(`restore refuses an unreadable/invalid former manifest: ${invalid}`, async t => {
 const f = await fixture(t); await rename(f.old, join(f.base, 'retained')); await mkdir(f.old);
 if (invalid === 'directory') await mkdir(join(f.old, 'manifest.json'));
 else await writeFile(join(f.old, 'manifest.json'), invalid === 'json' ? '{' : '{}');
 const before = await readFile(join(f.deviceHome, 'registry.json'));
 const result = await verifyRestore(f.input);
 assert.equal(result.ok, false); assert.equal(result.checks.at(-1).check, 'registry');
 assert.equal(result.checks.at(-1).reasonCode, 'RESTORE_REGISTRY_BOUND_ELSEWHERE');
 assert.deepEqual(await readFile(join(f.deviceHome, 'registry.json')), before);
});
for (const [label, member, reasonCode] of [
 ['reference key', { verb: 'work-transition', externalKey: 'bad key!', status: 'ready' }, 'EXTERNAL_KEY_INVALID'],
 ['parent key', { verb: 'work-create', projectId: 'project:a', externalKey: 'AUDIT-INIT', title: 'Audit', kind: 'Initiative', parentExternalKey: 'bad key!' }, 'EXTERNAL_KEY_INVALID'],
 ['involved projects', { verb: 'work-annotate', id: 'work:a', involvedProjects: { state: 'selected', targets: [] } }, 'WORKSPACE_INPUT_INVALID'],
]) test(`work batch attributes invalid ${label} to its member and leaves history unchanged`, async t => {
 const f = await fixture(t); const before = await materializeWorkspace(f.old);
 await assert.rejects(applyWorkBatch(f.old, { schemaVersion: 'tcrn.work-batch.v1', members: [member, { verb: 'work-transition', id: 'work:later', status: 'ready' }] }, { occurredAt: at }), error => {
  assert.equal(error.reasonCode, 'WORK_BATCH_REFUSED'); const result = JSON.parse(error.message);
  assert.equal(result.stage, 'apply'); assert.equal(result.failed.index, 0); assert.equal(result.failed.reasonCode, reasonCode); assert.deepEqual(result.notEvaluated, [1]); return true;
 });
 assert.equal((await materializeWorkspace(f.old)).headEventHash, before.headEventHash);
});
test('work batch malformed key does not interrupt independent shape aggregation', async () => {
 await assert.rejects(applyWorkBatch('/not-opened', { schemaVersion: 'tcrn.work-batch.v1', members: [{ verb: 'work-transition', externalKey: 'bad key!', status: 'ready' }, { verb: 'unknown' }, { verb: 'work-annotate' }] }, { occurredAt: at }), error => {
  assert.equal(error.reasonCode, 'WORK_BATCH_REFUSED'); const result = JSON.parse(error.message); assert.equal(result.stage, 'shape'); assert.deepEqual([...new Set(result.problems.map(p => p.index))], [1, 2]); return true;
 });
});
test('template bindings require both admission digests, including Stories exempt from template prose', () => {
 const template = { schemaVersion: 'tcrn.template.v1', id: 'audit.template', version: 1, appliesTo: ['Story', 'Subtask'], headings: ['Goal', 'Acceptance Criteria'], acceptanceHeadings: ['Acceptance Criteria'], referenceHeadings: [], couplings: [] };
 const receipt = admitTemplate(template, { ownerId: 'owner:audit', admittedAt: at }); const admission = createTemplateAdmissionRecord(template, receipt);
 const valid = templateBindingFromReceipt(receipt);
 const record = (kind, binding) => ({ kind, extensions: { [admission.registrationId]: { required: true, value: binding }, 'advisory:scope': { required: false, value: '## Goal\nAudit\n## Acceptance Criteria\n- Pass' } } });
 for (const kind of ['Story', 'Subtask']) {
  assert.doesNotThrow(() => validateBoundTemplateWork(record(kind, valid), [admission]));
  for (const field of ['templateDigest', 'receiptDigest']) assert.throws(() => validateBoundTemplateWork(record(kind, { ...valid, [field]: '0'.repeat(64) }), [admission]), { reasonCode: 'TEMPLATE_BINDING_INVALID' });
 }
 assert.doesNotThrow(() => validateBoundTemplateWork({ kind: 'Story', extensions: { [admission.registrationId]: { required: true, value: valid } } }, [admission]));
 assert.doesNotThrow(() => validateBoundTemplateWork({ kind: 'Story', extensions: {} }, []));
});
