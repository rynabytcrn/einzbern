#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { assertNodeFloor } from "../dist/build/packages/core/src/node-floor.js";

try {
  // TCRN-CROSS-STORY-481 R4: an older Node.js is refused with ENGINE_NODE_TOO_OLD {required,
  // actual} first; the rest of the engine loads only after it passes.
  assertNodeFloor(process.versions.node);
  const { runCli } = await import("../dist/build/packages/cli/src/index.js");
  await runCli(process.argv.slice(2), {
    write: (value) => process.stdout.write(value),
  });
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "CLI_INTERNAL_ERROR";
  // TCRN-CROSS-STORY-467 R4: a chain break names its stream, sequence, event and kind; a library
  // read also names the device and file (TCRN-CROSS-STORY-468, 470 R4), and a refused write its remedy.
  // A library this engine may not open names the format or engine version it needs and what this
  // engine has (TCRN-CROSS-STORY-471 R1). A Story refused for a missing goal or acceptance names
  // the field (TCRN-CROSS-STORY-473 R2). A knowledge write refused for its budget names the body
  // bytes it would reach and the limit, and one refused as a possible conflict the cards it
  // conflicts with (TCRN-CROSS-STORY-476, TCRN-CROSS-SUB-311). A Story refused at done names every
  // red required gate, the Stories held back and the run and tree it was judged on
  // (TCRN-CROSS-STORY-485 R4, TCRN-CROSS-SUB-345).
  const stringDetails = ["required", "actual", "supported", "layout", "streamId", "sequence", "eventId", "break", "segment", "line", "deviceId", "file", "timeoutMs", "remedy", "movedTo", "target", "field", "runId", "treeDigest"];
  const numberDetails = ["bodyBytes", "limit"];
  const listDetails = ["allowedValues", "conflicts", "reds", "stories"];
  const details = error?.details !== null && typeof error?.details === "object"
    ? Object.fromEntries(Object.entries(error.details).filter(([key, value]) =>
      (stringDetails.includes(key) && typeof value === "string") ||
      (numberDetails.includes(key) && Number.isSafeInteger(value)) ||
      (listDetails.includes(key) && Array.isArray(value) && value.every((entry) => typeof entry === "string"))))
    : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
