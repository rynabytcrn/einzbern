// SPDX-License-Identifier: Apache-2.0
// Synthetic Git objects only.
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { applyDotAgents, parseDotExtensionSource, planDotAgents, readDotExtensionSource, renderDotAgents } from '../dist/build/packages/core/src/dot-agents.js';
import { verifyDotExtensionSource } from '../dist/build/packages/core/src/dot-extension-source.js';
import { checkVariableInput } from '../dist/build/packages/core/src/variables.js';
import { createProject, initializeLibrary, materializeWorkspace, recordMinutes, setDotExtensionSource } from '../dist/build/packages/core/src/index.js';

const at = '2026-10-24T00:00:00Z';
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dot-technical-source-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  let git;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { const file = join(directory, process.platform === 'win32' ? 'git.exe' : 'git'); await access(file, constants.X_OK); git = await realpath(file); break; } catch {}
  }
  assert.ok(git, 'fixture needs actual installed Git');
  const repo = join(base, 'repository'); await mkdir(repo);
  const env = { PATH: process.env.PATH, HOME: base, XDG_CONFIG_HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'empty'), GIT_CONFIG_SYSTEM: join(base, 'empty'), GIT_AUTHOR_NAME: 'Fixture Contributor', GIT_AUTHOR_EMAIL: 'fixture', GIT_COMMITTER_NAME: 'Fixture Contributor', GIT_COMMITTER_EMAIL: 'fixture', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, LC_ALL: 'C' };
  await writeFile(join(base, 'empty'), '');
  const run = (args, options = {}) => execFileSync(git, ['-C', repo, ...args], { env, encoding: 'utf8', ...options }).trim();
  run(['init', '-q']); await writeFile(join(repo, 'source.txt'), 'Synthetic source only.\n'); run(['add', 'source.txt']); run(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic reference fixture']);
  const oid = run(['rev-parse', 'HEAD']);
  const binding = { gitExecutable: git, scratchRoot: base, repositories: [{ key: 'fixture-repository', root: repo }] };
  const source = manifest(oid);
  const target = join(base, 'target'); await mkdir(target);
  const enginePath = join(base, 'engine.mjs'), manaSkillPath = join(base, 'skill.md');
  await writeFile(enginePath, '// inert fixture\n'); await writeFile(manaSkillPath, '# Fixture skill\n');
  const request = { executionTarget: 'chatgpt-dot', operation: 'fresh', at, preInjection: 'apply', enginePath, manaSkillPath,
    binding: { root: target, agentsPath: join(target, 'AGENTS.md'), provenancePath: join(target, 'dot-owned.json'), backupRoot: join(target, 'recovery'), projectReference: 'fixture:project', ownerId: 'fixture-owner' },
    source: { engineVersion: 'fixture', engineCommit: 'unavailable', engineSourceRef: 'fixture:engine', language: 'en', enabledRules: [], extensions: source }, extensionVerification: binding };
  return { base, repo, git, run, oid, binding, source, request };
}
function manifest(oid) {
  const bodies = [`Baseline ${oid}\n`, JSON.stringify({ baseline: oid }) + '\n'];
  const files = bodies.map((body, index) => ({ path: `dot-extensions/source-${index}.txt`, kind: 'checker', body, sourceReference: 'fixture:source' }));
  return { schemaVersion: 'tcrn.dot-extension-source.v1', version: 1, sourceReference: 'fixture:approved-source', executionTarget: 'chatgpt-dot', rules: [], files, entries: [],
    technicalReferences: [{ kind: 'git-commit', objectFormat: 'sha1', objectId: oid, repositoryKey: 'fixture-repository', occurrences: files.map(file => { const startByte = Buffer.from(file.body).indexOf(oid); return { target: `file:${file.path}`, startByte, endByte: startByte + 40 }; }) }] };
}
const clone = value => JSON.parse(JSON.stringify(value));
const refusal = (fn, code) => assert.rejects(fn, error => code ? error.reasonCode === code : typeof error.reasonCode === 'string' && error.reasonCode.startsWith('DOT_SOURCE_'));

test('R19 typed references: exact supported save/readback/rebuild, remapped roots and idempotence; no evergreen proof', async t => {
  const f = await fixture(t);
  assert.deepEqual(parseDotExtensionSource(f.source), f.source);
  assert.throws(() => checkVariableInput({ name: 'dot.extensions.source', type: 'string', value: JSON.stringify(f.source), exports: [] }), error => error.reasonCode === 'VARIABLE_SECRET_SHAPED');
  assert.throws(() => renderDotAgents(f.request.source), error => error.reasonCode === 'DOT_SOURCE_VERIFICATION_REQUIRED');
  await verifyDotExtensionSource(f.source, f.binding);
  const library = join(f.base, 'library'); await initializeLibrary({ root: library, createdAt: at });
  let state = await createProject(library, { externalKey: 'TECHNICAL-P', name: 'Technical reference fixture', occurredAt: at });
  state = await recordMinutes(library, { projectId: state.projects[0].id, externalKey: 'TECHNICAL-MIN', title: 'Private source approval', summary: 'Synthetic fixture only.', decisions: ['Allow dot.extensions.source updates.'], decidedBy: ['owner:governance'], linkedWorkIds: [], occurredAt: at });
  const decidedIn = `${state.minutes.find(item => item.externalKey === 'TECHNICAL-MIN').id}#D1`;
  state = await setDotExtensionSource(library, { source: f.source, verification: f.binding, authorization: { decidedIn }, occurredAt: at });
  const row = state.configRecords.find(item => item.key === 'dot.extensions.source');
  assert.deepEqual(JSON.parse(row.value.value), f.source); assert.deepEqual(row.value.exports, []);
  assert.equal(row.value.value.includes(f.base), false);
  assert.throws(() => readDotExtensionSource(state), error => error.reasonCode === 'DOT_SOURCE_VERIFICATION_REQUIRED');
  const saved = parseDotExtensionSource(JSON.parse(row.value.value));
  const first = await planDotAgents({ ...f.request, source: { ...f.request.source, extensions: saved } });
  assert.equal((await applyDotAgents(first)).fileVerification, 'verified');
  for (const file of saved.files) assert.equal(await readFile(join(f.request.binding.root, file.path), 'utf8'), file.body);
  assert.equal((await planDotAgents(f.request)).status, 'unchanged');
  const alternateRoot = join(f.base, 'remapped'); await cp(f.repo, alternateRoot, { recursive: true });
  await rm(f.repo, { recursive: true });
  assert.equal((await materializeWorkspace(library)).version, state.version, 'shape-only replay needs no Git');
  await refusal(() => planDotAgents(f.request));
  const remapped = { ...f.request, extensionVerification: { ...f.binding, repositories: [{ key: 'fixture-repository', root: alternateRoot }] } };
  assert.equal((await planDotAgents(remapped)).status, 'unchanged');
  assert.equal((await readdir(f.base)).some(name => name.startsWith('dot-object-view-')), false);
});

test('R19 typed spans: whole-token, every occurrence, decoded JSON parity and unconditional credential checks', async t => {
  const f = await fixture(t);
  const cases = [];
  const mutate = fn => { const value = clone(f.source); fn(value); cases.push(value); };
  mutate(x => { x.technicalReferences[0].occurrences.pop(); });
  mutate(x => { x.technicalReferences[0].occurrences[0].startByte += 1; });
  mutate(x => { x.technicalReferences[0].occurrences.push(x.technicalReferences[0].occurrences[0]); });
  mutate(x => { x.technicalReferences[0].verified = true; });
  mutate(x => { const prefix = String.fromCharCode(103, 104, 112, 95); x.files[0].body = x.files[0].body.replace(f.oid, prefix + f.oid); x.technicalReferences[0].occurrences[0].startByte += prefix.length; x.technicalReferences[0].occurrences[0].endByte += prefix.length; });
  mutate(x => { x.technicalReferences[0].occurrences[0].target = 'file:missing'; });
  mutate(x => { x.files[0].body = x.files[0].body.replace(f.oid, `prefix${f.oid}`); x.technicalReferences[0].occurrences[0].startByte += 6; x.technicalReferences[0].occurrences[0].endByte += 6; });
  mutate(x => { x.files[0].body += '\n' + String.fromCharCode(103, 104, 112, 95) + 'syntheticfixture'.repeat(3); });
  mutate(x => { x.files[0].body += '\n' + 'a'.repeat(40); });
  mutate(x => { x.files[0].body = '文' + x.files[0].body; x.technicalReferences[0].occurrences[0].startByte += 1; x.technicalReferences[0].occurrences[0].endByte += 1; });
  for (const value of cases) assert.throws(() => parseDotExtensionSource(value), error => typeof error.reasonCode === 'string');
  for (const file of f.source.files) {
    const plain = { ...f.source, technicalReferences: undefined, files: [file] };
    assert.throws(() => parseDotExtensionSource(plain), error => error.reasonCode === 'DOT_SOURCE_SECRET_SHAPED');
  }
  await verifyDotExtensionSource(parseDotExtensionSource(f.source), f.binding);
  const unicode = clone(f.source); unicode.files[0].body = '文 ' + unicode.files[0].body;
  unicode.technicalReferences[0].occurrences[0].startByte += Buffer.byteLength('文 '); unicode.technicalReferences[0].occurrences[0].endByte += Buffer.byteLength('文 ');
  await verifyDotExtensionSource(parseDotExtensionSource(unicode), f.binding);
});

test('R19 physical objects: unknown/blob/tag/forged/missing/stale objects cannot be blessed by declarations or replacements', async t => {
  const f = await fixture(t);
  const blob = f.run(['rev-parse', 'HEAD:source.txt']);
  f.run(['tag', '-a', 'fixture-tag', '-m', 'Synthetic tag']);
  const tag = f.run(['rev-parse', 'fixture-tag']);
  for (const oid of ['0'.repeat(40), blob, tag]) await refusal(() => verifyDotExtensionSource(manifest(oid), f.binding));
  f.run(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Replacement fixture']);
  const replacement = f.run(['rev-parse', 'HEAD']);
  f.run(['replace', f.oid, replacement]); // Source replacement refs are not consumed by the isolated view.
  await verifyDotExtensionSource(f.source, f.binding);
  await refusal(() => verifyDotExtensionSource(f.source, { ...f.binding, repositories: [] }), 'DOT_SOURCE_BINDING_INVALID');
  const malformed = f.run(['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], { input: 'not a canonical commit\n' });
  await refusal(() => verifyDotExtensionSource(manifest(malformed), f.binding));
  const changed = clone(f.source); changed.files[0].body = 'Changed body without declared occurrence.\n';
  assert.throws(() => parseDotExtensionSource(changed));
  const plan = await planDotAgents(f.request);
  await rm(join(f.repo, '.git', 'objects', f.oid.slice(0, 2), f.oid.slice(2)));
  await refusal(() => applyDotAgents(plan));
  await refusal(() => verifyDotExtensionSource(f.source, f.binding));
});

test('R19 offline isolation: source remotes/config/hooks/inherited Git env do not run; partial stores and alternates are explicitly unsupported', async t => {
  const f = await fixture(t);
  const marker = join(f.base, 'network-or-hook-ran');
  const spy = join(f.base, 'spy'); await writeFile(spy, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, { mode: 0o700 });
  f.run(['config', 'remote.origin.url', `ext::${spy}`]); f.run(['config', 'remote.origin.promisor', 'true']);
  f.run(['config', 'core.hooksPath', f.base]); f.run(['config', 'filter.fixture.smudge', spy]); f.run(['config', 'extensions.partialClone', 'origin']);
  const old = process.env.GIT_CONFIG_PARAMETERS; process.env.GIT_CONFIG_PARAMETERS = `'core.sshCommand=${spy}'`;
  try {
    await verifyDotExtensionSource(f.source, f.binding);
    await refusal(() => verifyDotExtensionSource(manifest('0'.repeat(40)), f.binding));
  } finally { if (old === undefined) delete process.env.GIT_CONFIG_PARAMETERS; else process.env.GIT_CONFIG_PARAMETERS = old; }
  await assert.rejects(access(marker));
  const promisor = join(f.repo, '.git', 'objects', 'pack', 'fixture.promisor'); await writeFile(promisor, '');
  await refusal(() => verifyDotExtensionSource(f.source, f.binding), 'DOT_SOURCE_BINDING_UNSUPPORTED'); await rm(promisor);
  const alternates = join(f.repo, '.git', 'objects', 'info', 'alternates'); await writeFile(alternates, `${f.base}\n`);
  await refusal(() => verifyDotExtensionSource(f.source, f.binding), 'DOT_SOURCE_BINDING_UNSUPPORTED'); await rm(alternates);
  const linked = join(f.base, 'linked'); await symlink(f.repo, linked, 'dir');
  await refusal(() => verifyDotExtensionSource(f.source, { ...f.binding, repositories: [{ key: 'fixture-repository', root: linked }] }), 'DOT_SOURCE_BINDING_UNSUPPORTED');
  await assert.rejects(access(marker));
});
