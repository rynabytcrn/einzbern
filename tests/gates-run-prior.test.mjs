// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-537 (MIN-257 D6; TCRN-CROSS-SUB-487): a gate reads, from EINZBERN_GATE_RUN_PRIOR,
// the gates of the same run that ended before it: name, root and real directory, command, whether it
// passed, whether its output was cut, and the absolute path of its output file. The first gate reads
// an empty list. The engine's value replaces a variable of the same name the caller passes, and the
// variable is not part of the run record. Every project and device directory here is a temporary one.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planGates } from "../dist/build/packages/core/src/gates-plan.js";
import { GATE_RUN_PRIOR_VARIABLE, gateRunsDirectory, runGates } from "../dist/build/packages/core/src/gates-run.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 10, 0, second)).toISOString().replace(".000Z", "Z");
};

const node = process.execPath;
const LIBRARY = `workspace:${"b".repeat(24)}`;

// A gate that writes the variable it was given (and one other) to `probe`, prints `said` and exits
// with `code`.
function probeGate(name, probe, said, code) {
  const script = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(process.argv[1], JSON.stringify({ prior: process.env.${GATE_RUN_PRIOR_VARIABLE} ?? null, other: process.env.EINZBERN_PRIOR_TEST_OTHER ?? null }));`,
    `process.stdout.write(${JSON.stringify(said)});`,
    `process.exit(${code});`,
  ].join(" ");
  return { name, command: [node, "-e", script, probe], root: ".", covers: ["**"], required: true, enabled: true, releaseOnly: false };
}

async function setup(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-gates-prior-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  execFileSync("git", ["-C", project, "init", "-q"], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" });
  await writeFile(join(project, "README.md"), "prior\n");
  return { base, project, desk: join(base, "desk") };
}

async function readProbe(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("537-a: the second gate reads the first gate's entry, the first reads an empty list, and the variable is not in the run record", async (context) => {
  const { base, project, desk } = await setup(context);
  const probes = { alpha: join(base, "alpha.json"), beta: join(base, "beta.json"), gamma: join(base, "gamma.json") };
  const gates = [
    probeGate("alpha", probes.alpha, "alpha said", 3),
    probeGate("beta", probes.beta, "beta said", 0),
    probeGate("gamma", probes.gamma, "gamma said", 0),
  ];
  const plan = await planGates({ projectRoot: project, gates, release: true });
  const { run, recordPath } = await runGates(plan, { libraryId: LIBRARY, at: at(), deviceHome: desk });
  assert.deepEqual(run.gates.map((gate) => [gate.name, gate.ok]), [["alpha", false], ["beta", true], ["gamma", true]]);

  const directory = gateRunsDirectory(LIBRARY, desk);
  const entry = (index) => ({
    name: gates[index].name,
    root: ".",
    directory: project,
    command: gates[index].command,
    ok: run.gates[index].ok,
    truncated: false,
    outputFile: join(directory, ...run.gates[index].outputFile.split("/")),
  });

  const alpha = await readProbe(probes.alpha);
  assert.equal(typeof alpha.prior, "string", "the first gate is given the variable");
  assert.deepEqual(JSON.parse(alpha.prior), { runId: run.runId, gates: [] }, "the first gate reads an empty list");

  const beta = JSON.parse((await readProbe(probes.beta)).prior);
  assert.deepEqual(beta, { runId: run.runId, gates: [entry(0)] }, "the second gate reads the first gate's entry");
  assert.equal(beta.gates[0].ok, false, "the red first gate reads as not passed");
  assert.equal(await readFile(beta.gates[0].outputFile, "utf8"), "alpha said", "the output file path names the first gate's output");

  const gamma = JSON.parse((await readProbe(probes.gamma)).prior);
  assert.deepEqual(gamma, { runId: run.runId, gates: [entry(0), entry(1)] }, "the third gate reads both, in the order they ran");
  assert.equal(await readFile(gamma.gates[1].outputFile, "utf8"), "beta said");

  const recordText = await readFile(recordPath, "utf8");
  assert.equal(recordText.includes(GATE_RUN_PRIOR_VARIABLE), false, "the variable is not in the run record");
  const record = JSON.parse(recordText);
  assert.deepEqual(Object.keys(record).sort(), ["at", "base", "declarationsDigest", "gates", "libraryId", "reds", "release", "runId", "schemaVersion", "treeDigest", "trees", "workIds"]);
  for (const gate of record.gates) {
    assert.deepEqual(Object.keys(gate).sort(), ["exitCode", "matched", "matchedWorkIds", "name", "ok", "outputBytes", "outputFile", "required", "root", "signal", "timedOut", "truncated"]);
    assert.equal(gate.outputFile.startsWith(`${run.runId}/`), true, "the record keeps the output file relative to the gate-runs directory");
  }
});

test("537-a: the engine's value replaces the caller's variable of the same name, and the caller's other variables pass through", async (context) => {
  const { base, project, desk } = await setup(context);
  const probe = join(base, "only.json");
  const plan = await planGates({ projectRoot: project, gates: [probeGate("only", probe, "only said", 0)], release: true });
  const env = { ...process.env, [GATE_RUN_PRIOR_VARIABLE]: JSON.stringify({ runId: "forged", gates: [{ name: "engine:test", ok: true }] }), EINZBERN_PRIOR_TEST_OTHER: "kept" };
  const { run } = await runGates(plan, { libraryId: LIBRARY, at: at(), deviceHome: desk, env });
  assert.equal(run.gates[0].ok, true);
  const seen = await readProbe(probe);
  assert.deepEqual(JSON.parse(seen.prior), { runId: run.runId, gates: [] });
  assert.equal(seen.other, "kept");
});
