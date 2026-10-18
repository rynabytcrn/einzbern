// SPDX-License-Identifier: Apache-2.0
import './helpers/device-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
function archive(entries) {
 const blocks = [];
 for (const [name, source] of Object.entries(entries)) {
  const bytes = Buffer.from(source), header = Buffer.alloc(512);
  header.write(`einzbern-1.0.0/${name}`); header.write('0000644\0', 100); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257);
  const sum = [...header].reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
 }
 return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
test('installer staging preservation failure retains primary engine refusal and residual path', async t => {
 const base = await mkdtemp(join(tmpdir(), 'installer-cleanup-audit-')); t.after(() => rm(base, { recursive: true, force: true }));
 const home = join(base, 'device'); await mkdir(home); await writeFile(join(home, 'trash'), 'occupied, preserve me');
 const bytes = archive({
  'scripts/einzbern.mjs': 'process.stderr.write(JSON.stringify({ok:false,reasonCode:"AUDIT_ENGINE_REFUSED",error:"primary refusal",required:"fixture"})+"\\n"); process.exitCode=1;\n',
  'launchers/einzbern.mjs': '// fixture\n', 'launchers/hook.mjs': '// fixture\n',
  'manifest.json': JSON.stringify({ schemaVersion: 'einzbern.release-manifest.v1', version: '1.0.0', installTreeDigest: '0'.repeat(64) }),
 });
 const path = join(base, 'release.tar.gz'); await writeFile(path, bytes);
 const script = process.env.AUDIT_INSTALL_SCRIPT ?? resolve('skill/mana-orchestrate/scripts/install.mjs');
 const run = spawnSync(process.execPath, [script, '--archive', path, '--sha256', createHash('sha256').update(bytes).digest('hex'), '--home', home], { encoding: 'utf8', env: { ...process.env, HOME: base, USERPROFILE: base, EINZBERN_HOME: home } });
 assert.equal(run.status, 1, run.stderr); const result = JSON.parse(run.stderr.trim().split('\n').at(-1));
 assert.equal(result.reasonCode, 'AUDIT_ENGINE_REFUSED'); assert.equal(result.required, 'fixture');
 assert.match(result.error, /primary refusal/u); assert.match(result.cleanupError, /EEXIST/u);
 assert.ok(result.temporary.startsWith(join(home, 'tmp-'))); await readFile(join(result.temporary, 'einzbern-1.0.0/scripts/einzbern.mjs'));
 assert.equal(await readFile(join(home, 'trash'), 'utf8'), 'occupied, preserve me');
});
