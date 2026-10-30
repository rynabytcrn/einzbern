#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lightRoster } from "./light-roster.mjs";
import { retainVerificationStep } from "../lib/verification-evidence.mjs";
import { acquireHeavySlot } from "../lib/heavy-runs.mjs";
import { memoryTestArguments } from "../lib/memory-budget.mjs";
import { installNoNetworkGuard } from "../no-network.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function finalReceipt(stdout, stderr) {
  const found = [];
  for (const text of [stdout, stderr]) for (const match of text.matchAll(/^\{/gmu)) {
    try { found.push(JSON.parse(text.slice(match.index))); } catch { /* Not a terminal receipt. */ }
  }
  if (found.length !== 1) throw new Error("Expected one terminal task receipt");
  return found[0];
}

export function lightTestTotals(stdout) {
  const text = stdout.replace(/\u001b\[[0-9;]*m/gu, "").replaceAll("\r\n", "\n");
  const keys = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
  const headers = [...text.matchAll(/^(#|ℹ) tests (\d+)$/gmu)];
  if (headers.length !== 1) throw new Error("Expected one complete Node test summary");
  const prefix = headers[0][1];
  const pattern = keys.map(key => `${prefix} ${key} (\\d+)`).join("\n") + `\n${prefix} duration_ms (\\d+(?:\\.\\d+)?)(?:\n|$)`;
  const match = new RegExp(`^${pattern}`, "u").exec(text.slice(headers[0].index));
  if (!match) throw new Error("Incomplete Node test summary");
  const totals = Object.fromEntries(keys.map((key, index) => [key, Number(match[index + 1])]));
  if (totals.tests < 1 || totals.tests !== totals.pass + totals.fail + totals.cancelled + totals.skipped + totals.todo) throw new Error("Inconsistent Node test totals");
  return { ...totals, durationMs: Number(match[8]) };
}

export function judgeLightStep(row, step, stdout, stderr) {
  const problems = [];
  let report = null;
  let testTotals = null;
  if (step.exitCode !== 0 || step.signal !== null || step.status !== "executed") problems.push("Child failed, was cancelled, or was not executed");
  try {
    if (row.kind === "receipt") {
      report = finalReceipt(stdout, stderr);
      if (report.ok !== true || !row.expected.includes(report.reasonCode) || Object.hasOwn(report, "injected")) problems.push("Task receipt failed or has unexpected scope");
      if (row.id === "privacy" && (report.privacyScope !== "HEAD-reachable" || report.archiveScanned !== true || Object.hasOwn(report, "historyBase"))) problems.push("Full history and source archive privacy required");
    } else if (row.kind === "tap") {
      testTotals = lightTestTotals(stdout);
      if (testTotals.fail !== 0 || testTotals.cancelled !== 0) problems.push("Tests failed or were cancelled");
    } else if (row.kind !== "process") problems.push("Unknown light step kind");
  } catch (error) { problems.push(error.message); }
  return { ok: problems.length === 0, problems, report, testTotals };
}

async function archiveRecord(root) {
  const path = join(root, "dist/source/einzbern-source.tar");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CI_LIGHT_SOURCE_ARCHIVE_NOT_REGULAR");
  const bytes = await readFile(path);
  return { bytes, record: { path: "dist/source/einzbern-source.tar", bytes: bytes.length, sha256: digest(bytes) } };
}

export async function runLight(root = sourceRoot) {
  installNoNetworkGuard();
  const roster = lightRoster();
  const directory = process.env.EINZBERN_CI_EVIDENCE_DIR;
  if (!directory) throw new Error("EINZBERN_CI_EVIDENCE_DIR is required");
  const guardPath = join(root, "scripts/no-network.mjs");
  const guard = await readFile(guardPath);
  if (!(await lstat(guardPath)).isFile() || digest(guard) !== digest(await readFile(join(sourceRoot, "scripts/no-network.mjs")))) throw new Error("CI_LIGHT_NETWORK_GUARD_MISMATCH");
  const guardUrl = pathToFileURL(guardPath).href;
  // This is the existing suite preload, inherited by Node workers and ordinary
  // Node children. Advisory offline flags alone do not enforce that boundary.
  const env = { ...process.env, NODE_OPTIONS: `--import=${guardUrl}`, TCRN_OFFLINE_PROOF: "1", COREPACK_ENABLE_NETWORK: "0", npm_config_offline: "true", EINZBERN_PRIVACY_HISTORY_BASE: "" };
  await mkdir(join(directory, "steps"));
  await writeFile(join(directory, "light-roster.json"), `${JSON.stringify(roster, null, 2)}\n`, { flag: "wx" });
  const steps = [];
  let sourceArchive = null;
  for (const row of roster.steps) {
    const started = performance.now();
    const step = { id: row.id, command: ["node", ...row.argv], durationMs: 0, exitCode: null, signal: null, status: "blocked", noNetwork: { url: guardUrl, sha256: digest(guard) } };
    let output = { stdout: "", stderr: "" };
    let slot;
    try {
      if (row.requires.some(id => !steps.some(item => item.id === id && item.ok))) throw new Error("CI_LIGHT_PREREQUISITE_FAILED");
      if (row.id === "privacy") {
        const current = await archiveRecord(root);
        if (JSON.stringify(current.record) !== JSON.stringify(sourceArchive)) throw new Error("CI_LIGHT_SOURCE_ARCHIVE_CHANGED");
      }
      if (row.kind === "tap") slot = await acquireHeavySlot({ command: "ci:light-tests", env });
      const args = row.kind === "tap" ? memoryTestArguments([...row.argv], env) : row.argv;
      step.command = ["node", ...args];
      step.status = "executed";
      const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      output = { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      step.exitCode = result.status;
      step.signal = result.signal;
      Object.assign(step, judgeLightStep(row, step, output.stdout, output.stderr));
      if (result.error) { step.ok = false; step.problems.push(result.error.message); }
      if (step.ok && row.id === "archive") {
        const current = await archiveRecord(root);
        if (step.report.path !== current.record.path || step.report.sha256 !== current.record.sha256) throw new Error("CI_LIGHT_ARCHIVE_RECEIPT_MISMATCH");
        sourceArchive = current.record;
        await writeFile(join(directory, "source-archive.tar"), current.bytes, { flag: "wx" });
      }
      if (step.ok && row.id === "privacy" && JSON.stringify((await archiveRecord(root)).record) !== JSON.stringify(sourceArchive)) throw new Error("CI_LIGHT_SOURCE_ARCHIVE_CHANGED");
    } catch (error) {
      step.ok = false;
      step.problems = [...(step.problems ?? []), error.reasonCode ?? error.message];
    } finally {
      try { slot?.release(); } catch (error) { step.ok = false; step.problems = [...(step.problems ?? []), error.reasonCode ?? error.message]; }
    }
    step.durationMs = Math.round(performance.now() - started);
    await retainVerificationStep(join(directory, "steps"), step, output);
    steps.push(step);
  }
  const ok = steps.every(row => row.ok);
  const result = { schemaVersion: "einzbern.ci-light-steps.v1", profile: "ci-light", coverage: "light", ok,
    reasonCode: ok ? "CI_LIGHT_STEPS_VERIFIED" : "CI_LIGHT_STEPS_RED", rosterDigest: roster.rosterDigest,
    steps, sourceArchive, notRunHere: roster.notRunHere, localValidationRequired: "full" };
  await writeFile(join(directory, "light.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runLight();
  (result.ok ? process.stdout : process.stderr).write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
