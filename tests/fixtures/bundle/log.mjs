// SPDX-License-Identifier: Apache-2.0
// Bundle fixture (tests/bundle.test.mjs): the order the fixture's modules are evaluated in.

export const order = [];

export function record(name) {
  order.push(name);
}
