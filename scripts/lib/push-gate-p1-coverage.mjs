// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-537 (MIN-252 D3 BL-43, MIN-257 D6, Q10; TCRN-CROSS-SUB-488): whether the gate run
// the push gate is part of has already passed every leg of P1, so the push gate need not start
// verify:p1 and run them all again.
//
// A run of the engine's gates (gates-run --release, the one finish makes among them) runs P1's
// twelve legs as twelve gates and then engine:release, which is this push gate, which ran verify:p1:
// the same legs a second time on the same tree, about ten minutes of a finish. gates-run hands each
// gate the gates of its run that ended before it (EINZBERN_GATE_RUN_PRIOR, TCRN-CROSS-SUB-487), and
// this module decides, from that alone, whether they stand in for verify:p1. They do only when every
// leg of scripts/p1-sequence.mjs has a gate in the run that
//
//   * is the leg's gate: its name is the leg's name, or ends in a colon and the leg's name
//     (engine:test for test);
//   * ran in this repository: its real directory is this repository's;
//   * ran the leg's own script: pnpm (bare, through corepack, or corepack pnpm@<version>), then run,
//     at most --silent or -s, then the leg's package script and nothing after it;
//   * passed, and its output was not cut;
//   * printed exactly one terminal receipt of the leg (ok true, a reason code, and the leg's verb as
//     its command, or no command for the leg that does not go through task.mjs);
//   * printed nothing P1's zero-warning rule rejects. That is the rule the push gate holds verify:p1's
//     output to (hasWarningOrError in push-gate-output.mjs). It is applied with the leg's receipt in
//     the place P1's terminal receipt holds its legs, so the receipt is judged as P1's receipt is
//     (an empty `errors` is the ordinary shape of a passing receipt) and every other line as any
//     other P1 line is.
//
// Anything else -- no such variable (the push gate run on its own), a variable that does not parse,
// a leg with no gate, a gate that is red, cut, foreign, or ran another command, an output that cannot
// be read or carries a diagnostic -- leaves the push gate running verify:p1 in full, as before. So does
// EINZBERN_P1_INJECT, the test seam that only verify:p1 reads (Q22). The gate declarations are not
// read or changed: whatever the run says it ran is checked against the roster here.

import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import { P1_SEQUENCE } from "../p1-sequence.mjs";
import { hasWarningOrError } from "./push-gate-output.mjs";

/** The variable gates-run hands each gate (packages/core/src/gates-run.ts GATE_RUN_PRIOR_VARIABLE). */
export const GATE_RUN_PRIOR_VARIABLE = "EINZBERN_GATE_RUN_PRIOR";

/** Why a leg is, or is not, carried by a gate of the run. */
export const P1_COVERAGE_LEG_REASONS = Object.freeze([
  "P1_LEG_COVERED",
  "P1_LEG_GATE_MISSING",
  "P1_LEG_ROOT_FOREIGN",
  "P1_LEG_COMMAND_MISMATCH",
  "P1_LEG_GATE_RED",
  "P1_LEG_OUTPUT_TRUNCATED",
  "P1_LEG_OUTPUT_UNREADABLE",
  "P1_LEG_RECEIPT_MISSING",
  "P1_LEG_DIAGNOSTIC_PRESENT",
]);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const PNPM_VERSIONED = /^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function isText(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

/**
 * Parse EINZBERN_GATE_RUN_PRIOR. Returns { ok: true, runId, gates } or { ok: false, reasonCode }.
 * Every gate must carry each field gates-run writes, with an absolute directory and an output file
 * inside the run's own directory of outputs.
 */
export function parseGateRunPrior(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    return { ok: false, reasonCode: "P1_COVERAGE_PRIOR_INVALID" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || !isText(value.runId) || !Array.isArray(value.gates)) {
    return { ok: false, reasonCode: "P1_COVERAGE_PRIOR_INVALID" };
  }
  const gates = [];
  for (const gate of value.gates) {
    const valid = gate !== null && typeof gate === "object" && !Array.isArray(gate)
      && isText(gate.name) && isText(gate.root)
      && isText(gate.directory) && isAbsolute(gate.directory)
      && Array.isArray(gate.command) && gate.command.length > 0 && gate.command.every((part) => typeof part === "string")
      && typeof gate.ok === "boolean" && typeof gate.truncated === "boolean"
      && isText(gate.outputFile) && isAbsolute(gate.outputFile) && basename(dirname(gate.outputFile)) === value.runId;
    if (!valid) return { ok: false, reasonCode: "P1_COVERAGE_PRIOR_INVALID" };
    gates.push({ name: gate.name, root: gate.root, directory: gate.directory, command: [...gate.command], ok: gate.ok, truncated: gate.truncated, outputFile: gate.outputFile });
  }
  return { ok: true, runId: value.runId, gates };
}

/** Whether a gate is named for a leg: the leg's name, or anything ending in a colon and the leg's name. */
export function gateNamesLeg(name, task) {
  return name === task || name.endsWith(`:${task}`);
}

/** Whether an argv runs exactly the package script `script` through pnpm, with no argument after it. */
export function commandRunsScript(command, script) {
  if (!Array.isArray(command)) return false;
  let rest;
  if (command[0] === "pnpm") rest = command.slice(1);
  else if (command[0] === "corepack" && (command[1] === "pnpm" || PNPM_VERSIONED.test(String(command[1])))) rest = command.slice(2);
  else return false;
  if (rest[0] !== "run") return false;
  rest = rest.slice(1);
  if (rest[0] === "--silent" || rest[0] === "-s") rest = rest.slice(1);
  return rest.length === 1 && rest[0] === script;
}

function legReceipt(line, leg) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.ok !== true || typeof value.reasonCode !== "string" || value.reasonCode.length === 0) return null;
  // This consumer substitutes for a full P1 run. A passing selected Core (even
  // relabeled with the full reason) cannot cover that leg. Ordinary full Core
  // predates the coverage field; an explicit field must also declare full.
  if (leg.task === "test" && (value.reasonCode !== "TESTS_VERIFIED" ||
    (Object.hasOwn(value, "coverage") && value.coverage !== "full"))) return null;
  return value.command === (leg.dispatchesThroughTask ? leg.task : undefined) ? value : null;
}

/**
 * Judge one leg gate's output: exactly one terminal receipt of the leg, and nothing P1's zero-warning
 * rule rejects. Returns the leg reason: P1_LEG_COVERED, P1_LEG_OUTPUT_UNREADABLE,
 * P1_LEG_RECEIPT_MISSING or P1_LEG_DIAGNOSTIC_PRESENT.
 */
export function judgeLegOutput(output, leg) {
  let text;
  try {
    text = typeof output === "string" ? output : strictUtf8.decode(output);
  } catch {
    return "P1_LEG_OUTPUT_UNREADABLE";
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const receipts = lines.flatMap((line, index) => {
    const receipt = legReceipt(line, leg);
    return receipt === null ? [] : [{ index, receipt }];
  });
  if (receipts.length !== 1) return "P1_LEG_RECEIPT_MISSING";
  const [{ index, receipt }] = receipts;
  // The leg's receipt takes the place P1's terminal receipt gives its legs.
  const judged = lines.map((line, at) => (at === index ? JSON.stringify({ reasonCode: "P1_VERIFIED", legs: [receipt] }) : line));
  return hasWarningOrError(judged.join("\n"), "verify:p1") ? "P1_LEG_DIAGNOSTIC_PRESENT" : "P1_LEG_COVERED";
}

function gateVerdict(gate, leg, repositoryRoot, readOutput) {
  if (gate.directory !== repositoryRoot) return { reasonCode: "P1_LEG_ROOT_FOREIGN" };
  if (!commandRunsScript(gate.command, leg.script)) return { reasonCode: "P1_LEG_COMMAND_MISMATCH" };
  if (!gate.ok) return { reasonCode: "P1_LEG_GATE_RED" };
  if (gate.truncated) return { reasonCode: "P1_LEG_OUTPUT_TRUNCATED" };
  let output = null;
  try {
    output = readOutput(gate.outputFile);
  } catch {
    output = null;
  }
  if (output === null || output === undefined) return { reasonCode: "P1_LEG_OUTPUT_UNREADABLE" };
  const reasonCode = judgeLegOutput(output, leg);
  if (reasonCode !== "P1_LEG_COVERED") return { reasonCode };
  return { reasonCode, sha256: createHash("sha256").update(output).digest("hex") };
}

/**
 * Decide whether the gate run handed to the push gate carries every leg of P1.
 *
 * `prior` is the variable's text, or undefined when the push gate runs on its own. `repositoryRoot`
 * is this repository's real path. `readOutput(path)` returns a gate's output (a Buffer or a string),
 * or null when it cannot be read. `injection` is EINZBERN_P1_INJECT. Returns null when there is no
 * run; otherwise { covered, reasonCode, runId, legs }, one entry per leg in roster order: a carried
 * leg names its gate, output file and the output's sha256; any other gives its reason and the gates
 * named for it.
 */
export function assessP1Coverage({ prior, repositoryRoot, readOutput, injection, legs = P1_SEQUENCE } = {}) {
  if (prior === undefined || prior === null) return null;
  if (injection !== undefined && injection !== "") return { covered: false, reasonCode: "P1_COVERAGE_INJECTION_SET", runId: null, legs: [] };
  const parsed = parseGateRunPrior(prior);
  if (!parsed.ok) return { covered: false, reasonCode: parsed.reasonCode, runId: null, legs: [] };
  const rows = legs.map((leg) => {
    const named = parsed.gates.filter((gate) => gateNamesLeg(gate.name, leg.task));
    if (named.length === 0) return { leg: leg.task, ok: false, reasonCode: "P1_LEG_GATE_MISSING", gates: [] };
    const verdicts = named.map((gate) => ({ gate, ...gateVerdict(gate, leg, repositoryRoot, readOutput) }));
    const carried = verdicts.find((verdict) => verdict.reasonCode === "P1_LEG_COVERED");
    if (carried !== undefined) return { leg: leg.task, ok: true, gate: carried.gate.name, outputFile: carried.gate.outputFile, sha256: carried.sha256 };
    return { leg: leg.task, ok: false, reasonCode: verdicts[0].reasonCode, gates: named.map((gate) => gate.name) };
  });
  const covered = rows.length > 0 && rows.every((row) => row.ok);
  return { covered, reasonCode: covered ? "P1_COVERED_BY_GATE_RUN" : "P1_COVERAGE_INCOMPLETE", runId: parsed.runId, legs: rows };
}
