// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: the other half of the cycle. It is evaluated before cycle-even.mjs and calls
// even() while that module has not run yet, which works because a module's function declarations
// are bound before any module runs.

import { record } from "./log.mjs";
import { even } from "./cycle-even.mjs";

record("cycle-odd");

export const evenOfZeroDuringTheCycle = even(0);

export function odd(value) {
  return value === 0 ? false : even(value - 1);
}
