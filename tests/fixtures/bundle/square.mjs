// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: re-exported by shapes.mjs through export *.

import { record } from "./log.mjs";

record("square");

export const name = "square";

export function square(side) {
  return side * side;
}
