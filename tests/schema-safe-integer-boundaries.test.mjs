// SPDX-License-Identifier: Apache-2.0
// Scalar fragment admission only: these tests do not claim whole-record validity,
// referential integrity, version-window ordering, or other runtime semantics.
// Compile each original fragment by reference, preserving every schema constraint.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = new URL('../', import.meta.url);
const changedSites = {
  'schemas/compatibility-v1.schema.json': ['/properties/protocolVersion', '/properties/minimumProtocolVersion', '/properties/maximumProtocolVersion'],
  'schemas/protocol-common-v1.schema.json': ['/$defs/jsonValue/anyOf/3'],
  'schemas/conference-request-v1.schema.json': ['/properties/revision'],
  'schemas/knowledge-model-v1.schema.json': ['/properties/revision'],
  'schemas/template-v1.schema.json': ['/properties/version'],
  'schemas/exchange-v1.schema.json': ['/properties/entries/items/properties/size'],
  'schemas/gate-v1.schema.json': ['/properties/revision'],
  'schemas/dependency-v1.schema.json': ['/properties/revision'],
  'schemas/assignment-v1.schema.json': ['/properties/revision'],
  'schemas/work-model-v1.schema.json': ['/properties/revision'],
  'schemas/conference-position-v1.schema.json': ['/properties/revision'],
  'schemas/extension-registration-v1.schema.json': ['/properties/version'],
  'schemas/profile-trust-v1.schema.json': ['/properties/minimumProtocolVersion', '/properties/maximumProtocolVersion'],
  'schemas/event-integrity-v1.schema.json': ['/properties/sequence', '/properties/clock'],
  'schemas/conference-minutes-v1.schema.json': ['/properties/revision'],
  'packages/core/schema/workspace-snapshot-manifest-v1.schema.json': ['/properties/version', '/$defs/file/properties/bytes'],
  'packages/core/schema/workspace-v1.schema.json': ['/$defs/relocation/properties/basis/properties/version'],
};
const schemas = [];
for (const directory of ['schemas', 'packages/core/schema']) {
  for (const file of (await readdir(new URL(`${directory}/`, root))).filter(name => name.endsWith('.schema.json')).sort()) {
    const path = `${directory}/${file}`;
    schemas.push({ path, schema: JSON.parse(await readFile(new URL(path, root), 'utf8')) });
  }
}
const ajv = new Ajv2020({ strict: false, validateFormats: false });
for (const { schema } of schemas) ajv.addSchema(schema);
const fragments = [];
function visit(value, pointer, path, schemaId) {
  if (value === null || typeof value !== 'object') return;
  if (value.type === 'integer' || (Array.isArray(value.type) && value.type.includes('integer'))) {
    fragments.push({ path, pointer, schemaId, fragment: value });
  }
  for (const [key, child] of Object.entries(value)) {
    visit(child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, path, schemaId);
  }
}
for (const { path, schema } of schemas) visit(schema, '', path, schema.$id);

test('integer inventory covers all 22 repaired sites across 17 files', () => {
  const expected = Object.entries(changedSites).flatMap(([path, pointers]) => pointers.map(pointer => `${path}#${pointer}`));
  assert.equal(Object.keys(changedSites).length, 17);
  assert.equal(expected.length, 22);
  const discovered = new Set(fragments.map(({ path, pointer }) => `${path}#${pointer}`));
  for (const site of expected) assert.ok(discovered.has(site), `missing repaired integer site: ${site}`);
  assert.ok(schemas.some(({ path }) => path.startsWith('packages/core/schema/')));
});

for (const { path, pointer, schemaId, fragment } of fragments) {
  test(`integer scalar boundaries: ${path}#${pointer}`, () => {
    assert.ok(Number.isSafeInteger(fragment.maximum), 'maximum must be representable');
    assert.equal(fragment.maximum, Number.MAX_SAFE_INTEGER, 'representation bound, not a product capacity limit');
    assert.ok(Number.isSafeInteger(fragment.minimum), 'minimum must be representable');
    const validate = ajv.compile({ $ref: `${schemaId}#${pointer}` });
    assert.equal(validate(fragment.minimum), true, 'declared lower boundary');
    assert.equal(validate(fragment.maximum), true, 'declared upper boundary');
    assert.equal(validate(fragment.minimum - 1), false, 'below declared lower boundary');
    assert.equal(validate(Number.MAX_SAFE_INTEGER + 1), false, 'unsafe positive integer');
    assert.equal(validate(-Number.MAX_SAFE_INTEGER - 1), false, 'unsafe negative integer');
    assert.equal(validate(0.5), false, 'fractional number');
    assert.equal(validate(String(fragment.minimum)), false, 'numeric text is not coerced');
  });
}
