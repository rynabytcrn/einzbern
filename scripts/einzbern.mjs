#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runCli } from "../dist/build/packages/cli/src/index.js";

try {
  await runCli(process.argv.slice(2), {
    write: (value) => process.stdout.write(value),
  });
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "CLI_INTERNAL_ERROR";
  // TCRN-CROSS-STORY-467 R4: a chain break names its stream, sequence, event and kind.
  const stringDetails = ["required", "actual", "layout", "streamId", "sequence", "eventId", "break", "segment", "line"];
  const details = error?.details !== null && typeof error?.details === "object"
    ? Object.fromEntries(Object.entries(error.details).filter(([key, value]) =>
      (stringDetails.includes(key) && typeof value === "string") ||
      (key === "allowedValues" && Array.isArray(value) && value.every((entry) => typeof entry === "string"))))
    : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
