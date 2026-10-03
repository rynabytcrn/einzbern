// SPDX-License-Identifier: Apache-2.0
import { RUNTIME_CAPACITY } from "../../../scripts/lib/runtime-capacity.mjs";

/** A caller's retry budget; the default is a scheduling choice, never an admission ceiling. */
export function renameRetryBudget(explicit?: number): number {
  const declared = process.env.EINZBERN_RENAME_RETRY_BUDGET;
  const value = explicit ?? (declared === undefined ? 8 : Number(declared));
  if (!Number.isSafeInteger(value) || value < 0 || (explicit === undefined && declared !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(declared))) {
    throw new Error("EINZBERN_RENAME_RETRY_BUDGET_INVALID: expected a non-negative safe integer");
  }
  return value;
}

/** Local probes have an overridable time budget; Node's timer range is the only ceiling. */
export function localProbeTimeout(defaultMilliseconds = 5_000): number {
  const declared = process.env.EINZBERN_LOCAL_PROBE_TIMEOUT_MS;
  const value = declared === undefined ? defaultMilliseconds : Number(declared);
  if (!Number.isSafeInteger(value) || value < 1 || value > RUNTIME_CAPACITY.timerMilliseconds || (declared !== undefined && !/^[1-9][0-9]*$/u.test(declared))) {
    throw new Error("EINZBERN_LOCAL_PROBE_TIMEOUT_MS_INVALID: expected a positive integer in Node's timer range");
  }
  return value;
}
