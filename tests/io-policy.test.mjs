// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { renameRetryBudget, localProbeTimeout } from '../dist/build/packages/core/src/io-policy.js';

test('invalid I/O budgets expose stable reason codes without echoing values', () => {
  const names = ['EINZBERN_RENAME_RETRY_BUDGET', 'EINZBERN_LOCAL_PROBE_TIMEOUT_MS'];
  const before = names.map(name => process.env[name]);
  const refuses = (fn, reasonCode) => assert.throws(fn, error => {
    assert.equal(error.reasonCode, reasonCode);
    assert.ok(error.message.startsWith(`${reasonCode}: `));
    assert.ok(!error.message.includes('private-invalid-value'));
    return true;
  });
  try {
    delete process.env[names[0]];
    delete process.env[names[1]];
    for (const value of [-1, 1.5, NaN, Infinity]) refuses(() => renameRetryBudget(value), `${names[0]}_INVALID`);
    for (const value of [0, -1, 1.5, 2147483648]) refuses(() => localProbeTimeout(value), `${names[1]}_INVALID`);
    for (const value of ['private-invalid-value', '', '01', '-1']) {
      process.env[names[0]] = value;
      process.env[names[1]] = value;
      refuses(() => renameRetryBudget(), `${names[0]}_INVALID`);
      refuses(() => localProbeTimeout(), `${names[1]}_INVALID`);
    }
    assert.equal(renameRetryBudget(0), 0);
  } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
  }
});
