#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { P1_TASKS, runAllP1Legs } from "../p1-sequence.mjs";
import { retainVerificationStep } from "../lib/verification-evidence.mjs";

// This partitions the existing roster, including future additions. It is not a
// second gate roster. Core's test task already builds; Portal needs its own build.
export const P1_SHARDS = Object.freeze({
  checks: P1_TASKS.filter((task) => !["test", "portal"].includes(task)),
  core: P1_TASKS.filter((task) => task === "test"),
  portal: P1_TASKS.filter((task) => task === "portal"),
});
export const PREREQUISITES = Object.freeze({ checks: [], core: [], portal: ["build"] });

function receipt(stdout, stderr) {
  const candidates = [];
  for (const stream of [stdout, stderr]) {
    for (const match of stream.matchAll(/^\{/gmu)) {
      try { candidates.push(JSON.parse(stream.slice(match.index))); } catch { /* Not a terminal JSON receipt. */ }
    }
  }
  if (candidates.length !== 1) throw new Error("Expected one terminal task receipt");
  return candidates[0];
}

export async function runShard(shard, root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")) {
  if (!Object.hasOwn(P1_SHARDS, shard)) throw new Error(`Unknown P1 shard: ${shard}`);
  const directory = process.env.EINZBERN_CI_EVIDENCE_DIR;
  if (!directory) throw new Error("EINZBERN_CI_EVIDENCE_DIR is required");
  await mkdir(join(directory, "steps"));
  const invoke = async (task, prefix = "leg") => {
    const started = performance.now();
    const args = task === "test-wiring" ? ["scripts/test-wiring-proof.mjs"] : ["scripts/task.mjs", task];
    const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const step = { id: `${prefix}-${task}`, command: ["node", ...args], durationMs: Math.round(performance.now() - started), exitCode: result.status, signal: result.signal };
    await retainVerificationStep(join(directory, "steps"), step, result);
    const report = receipt(result.stdout ?? "", result.stderr ?? "");
    if (result.status !== 0 || report.ok !== true) {
      throw Object.assign(new Error(`${task} failed; see steps/${step.id}.stdout and steps/${step.id}.stderr`), { reasonCode: report.reasonCode ?? "P1_SHARD_CHILD_FAILED" });
    }
    return report;
  };
  const prerequisites = await runAllP1Legs((task) => invoke(task, "prerequisite"), PREREQUISITES[shard]);
  const outcome = await runAllP1Legs(invoke, P1_SHARDS[shard]);
  const extras = await runAllP1Legs((task) => invoke(task, "extra"), shard === "checks" ? ["test-wiring"] : []);
  const ok = [prerequisites, outcome, extras].every((result) => result.reds.length === 0);
  const result = { ...outcome, ok, reasonCode: ok ? "P1_SHARD_VERIFIED" : "P1_SHARD_RED", shard, prerequisites, extras };
  await writeFile(join(directory, "shard.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

export function writeShardReceipt(result, streams = process) {
  // pnpm appends an ELIFECYCLE footer to stdout on failure. stderr keeps the
  // original red receipt terminal and independently parseable.
  (result.ok ? streams.stdout : streams.stderr).write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--plan") {
    process.stdout.write(`${JSON.stringify({ shards: P1_SHARDS, prerequisites: PREREQUISITES, tasks: P1_TASKS })}\n`);
  } else {
    const result = await runShard(process.argv[2]);
    writeShardReceipt(result);
    if (!result.ok) process.exitCode = 1;
  }
}
