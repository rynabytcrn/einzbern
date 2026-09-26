// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: one half of an import cycle; cycle-odd.mjs imports this module back.

import { record } from "./log.mjs";
import { odd } from "./cycle-odd.mjs";

record("cycle-even");

export function even(value) {
  return value === 0 ? true : odd(value - 1);
}
