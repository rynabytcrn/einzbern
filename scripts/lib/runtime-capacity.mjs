// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:buffer";

/** Immutable capacities of the runtime executing this source, not configurable product budgets. */
export const RUNTIME_CAPACITY = Object.freeze({
  bufferBytes: constants.MAX_LENGTH,
  stringCodeUnits: constants.MAX_STRING_LENGTH,
  arrayEntries: 0xffff_ffff,
  safeInteger: Number.MAX_SAFE_INTEGER,
  timerMilliseconds: 0x7fff_ffff,
});
