// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Skill root is the directory above this script, wherever the caller stands.
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => `${JSON.stringify(sortKeys(value))}\n`;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}

function parse(argv) {
  if (argv.length === 1 && argv[0] === '--check') return { check: true };
  if (argv.length === 2 && argv[0] === '--output' && argv[1] && !argv[1].startsWith('--')) {
    return { output: resolve(process.cwd(), argv[1]) };
  }
  fail('ARCHIVE_CLI_INVALID');
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('ARCHIVE_ENTRY_INVALID');
    if (entry.isDirectory()) {
      paths.push(...await files(path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

const options = parse(process.argv.slice(2));
const entries = [];
for (const file of await files(skillRoot)) {
  const content = await readFile(file);
  entries.push({
    contentBase64: content.toString('base64'),
    path: relative(skillRoot, file).replaceAll('\\', '/'),
    sha256: sha256(content),
    type: 'file',
  });
}
entries.sort((one, two) => one.path < two.path ? -1 : one.path > two.path ? 1 : 0);
if (!entries.some(entry => entry.path === 'SKILL.md')) fail('ARCHIVE_SKILL_MISSING');
const archive = canonical({ entries, schemaVersion: 'einzbern.mana-orchestrate.archive.v1' });
if (!options.check) {
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, archive, { mode: 0o600 });
}
console.log(sha256(archive));
