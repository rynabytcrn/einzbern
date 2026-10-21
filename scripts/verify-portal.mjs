#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-140: the portal gates are one serial train.  The engine suite and the
// portal suite must never share an output session concurrently.
// TCRN-CROSS-SUB-484 (MIN-257 D6): the train is a heavy run. It takes a slot of
// execution.maxConcurrentHeavyRuns (scripts/lib/heavy-runs.mjs) before its first step, waiting
// while every slot is held, and frees it when the train ends, red steps included; the steps it
// starts inherit the slot through EINZBERN_HEAVY_SLOT.

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHeavySlot } from "./lib/heavy-runs.mjs";
import { createPortalEvidence, retainVerificationStep } from "./lib/verification-evidence.mjs";

// `--silent` is not cosmetic: pnpm echoes the script body it is about to run onto
// stderr, and verify-p1 fails a command whose stderr is not empty. Without it the
// train reports its own progress lines as an unjudged toolchain error.
const commands = [
  ["pnpm", ["run", "--silent", "portal:test"]],
  ["pnpm", ["run", "--silent", "portal:proof"]],
  [process.execPath, ["--test", "tests/cross-repo-privacy.test.mjs"]],
  [process.execPath, ["scripts/ds-component-css-reconcile.mjs"]],
  [process.execPath, ["scripts/ds-component-css-proof.mjs"]],
  // The meta-proof ends with a complete, unmodified replay. Running a separate
  // full check here repeated every historical block without adding coverage.
  [process.execPath, ["scripts/verbatim-evidence-meta-proof.mjs"]],
];

const slot = await acquireHeavySlot({ command: "verify:portal" });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timings = [];
const unverified = [];
// INC-223: what the train saw but did not judge on. Until the DS reconciliation was
// split, this list could only ever be filled by a machine with no Design System
// checkout at all, because a drift on a machine that had one exited non-zero above
// and never reached here. It now carries the drift itself, which is what makes the
// word honest — reported in the receipt, absent from the verdict.
const observations = [];
try {
  const evidence = await createPortalEvidence(root);
  for (const [index, [executable, args]] of commands.entries()) {
    const started = performance.now();
    const result = spawnSync(executable, args, {
      cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, npm_config_offline: "true", EINZBERN_VERIFY_TIMINGS_DIR: join(evidence, "timings") },
    });
    const step = {
      id: String(index + 1).padStart(2, "0"), command: [executable === process.execPath ? "node" : executable, ...args],
      durationMs: Math.round(performance.now() - started), exitCode: result.status, signal: result.signal,
      ...(result.error ? { error: String(result.error.message) } : {}),
    };
    timings.push(step);
    await retainVerificationStep(evidence, step, result);
    // Only the receipt goes to stdout. Callers parse this command's whole stdout as one
    // JSON document, so a passing step's own chatter cannot be forwarded there; a failing
    // step's output is diagnostics, which is what stderr is for, and the non-zero exit
    // that follows is what the caller judges.
    if (result.status !== 0) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
      break;
    }
    if (args[0] === "scripts/ds-component-css-reconcile.mjs") {
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const report = JSON.parse(lines.at(-1) ?? "{}");
      if (report.reconciliation?.sourceReconciled === false) unverified.push("ds-component-css-source-reconciliation");
      observations.push(...(report.observations ?? []));
    }
  }
  // The receipt names the interpreter as "node", never process.execPath: this output is
  // pasted into evidence and printed in public CI logs, and execPath carries the runner's
  // home directory. Execution above still uses the real interpreter.
  const reportedName = (executable) => (executable === process.execPath ? "node" : executable);
  const ok = timings.length === commands.length && timings.every((step) => step.exitCode === 0);
  const receipt = { ok, reasonCode: ok ? "PORTAL_VERIFY_TRAIN_GREEN" : "PORTAL_VERIFY_TRAIN_RED", commands: commands.map(([executable, args]) => [reportedName(executable), ...args]), unverified, observations, timings };
  await writeFile(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  if (ok) process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  slot.release();
}
