// SPDX-License-Identifier: Apache-2.0
// Bundle fixture: re-exported by shapes.mjs through export *.

import { record } from "./log.mjs";

record("circle");

export const name = "circle";

export function circleArea(radius) {
  return Math.round(Math.PI * radius * radius);
}
