// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { summarizePairedSamples } from "../scripts/performance/recall-summary.mjs";

// Copy the real parent unchanged; replace only its expensive child boundary.
// This exercises argument parsing, query selection, device creation, ordering,
// child exits and JSON parsing in the production performance driver.
async function runDriver(options = [], failure = false) {
  const temporary = resolve("dist/test-tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, "recall-runner-"));
  try {
    const devices = join(root, "devices");
    const template = join(devices, "template");
    await mkdir(template, { recursive: true });
    await writeFile(join(template, "registry.json"), "{}\n");
    await copyFile(new URL("../scripts/performance/recall-ab.mjs", import.meta.url), join(root, "recall-ab.mjs"));
    await writeFile(join(root, "recall-entry-sample.mjs"), `
import { readFile } from "node:fs/promises";
const [repository, library, specPath, queryIndex, observe] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, "utf8"));
process.stderr.write("retained child diagnostic\\n");
if (spec.failure && observe === "1") {
  process.stdout.write("[not JSON]\\n");
} else {
  const baseline = repository === "baseline";
  const reads = Array.from({ length: baseline ? 2 : 1 }, () => ({ file: "akasha/fixture.ndjson", bytes: 50 }));
  console.log(JSON.stringify({ entry: "cli", at: spec.at, query: spec.queries[Number(queryIndex)],
    authorityHead: "same-head", semanticSha256: "same-output", exitCode: spec.failure && !baseline ? 3 : 0,
    operationElapsedMs: 1, operationCpuMicros: 2, processCpuMicros: 3, maxRss: 100,
    logicalEventBytes: baseline ? 100 : 50, segmentReads: reads.length, materializations: reads.length, reads,
    loadedSourceSha256: repository + observe, loadedSourceBytes: observe === "1" ? 1100 : 1000,
    fixtureArguments: process.argv.slice(2), fixtureDevice: process.env.EINZBERN_HOME,
    template: await readFile(process.env.EINZBERN_HOME + "/registry.json", "utf8") }));
  if (spec.failure && !baseline) process.exitCode = 3;
}
`);
    const spec = join(root, "spec.json");
    const specBytes = JSON.stringify({ entry: "cli", queries: ["natural", "exact", "no-hit"], at: "2026-11-10T15:00:00Z",
      deviceTemplate: template, deviceRoot: devices, devicePrefix: "unique-", failure });
    await writeFile(spec, specBytes);
    const result = spawnSync(process.execPath, [join(root, "recall-ab.mjs"), "baseline", "candidate", "library", spec, ...options], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(await readFile(spec, "utf8"), specBytes);
    return { result, rows: result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("645: real parent selects a query with non-15 groups and a continuing odd pair", async () => {
  const { result, rows } = await runDriver(["--groups", "2", "--start-pair", "15", "--query-indexes", "0"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(row => `${row.pair}:${row.mode}`), ["15:candidate", "15:baseline", "15:candidate-observed", "16:baseline", "16:candidate", "16:candidate-observed"]);
  assert.ok(rows.every(row => row.queryIndex === 0 && row.sample.fixtureArguments[3] === "0" && row.sample.query === "natural" && row.sample.template === "{}\n"));
  assert.equal(new Set(rows.map(row => row.sample.fixtureDevice)).size, 6);
  assert.ok(rows.every(row => row.invocation.command === process.execPath && row.invocation.deviceHome === row.sample.fixtureDevice
    && JSON.stringify(row.invocation.argv.slice(1)) === JSON.stringify(row.sample.fixtureArguments) && /^[a-f0-9]{64}$/u.test(row.invocation.environmentSha256)));
  const options = { groups: 2, startPair: 15, queryIndexes: [0] };
  const summary = summarizePairedSamples(rows, options);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.cases[0].pairing.expectedPairIds, [15, 16]);
  assert.equal(summarizePairedSamples(rows).complete, false);
  const missing = summarizePairedSamples(rows.slice(1), options);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.cases[0].pairing.pairChecks[0].missingModes, ["candidate"]);
  const missingPair = summarizePairedSamples(rows.filter(row => row.pair !== 16), options);
  assert.equal(missingPair.complete, false);
  assert.deepEqual(missingPair.cases[0].pairing.pairChecks[1].missingModes, ["baseline", "candidate", "candidate-observed"]);
  const duplicate = summarizePairedSamples([...rows, rows[0]], options);
  assert.equal(duplicate.complete, false);
  assert.deepEqual(duplicate.cases[0].pairing.pairChecks[0].duplicateModes, ["candidate"]);
  assert.ok(Object.values(duplicate.cases[0].thresholds).every(value => value === null));
  const reordered = summarizePairedSamples([...rows].reverse(), options);
  assert.equal(reordered.complete, false);
  assert.equal(reordered.cases[0].pairing.orderMatches, false);
  const drifted = summarizePairedSamples(rows.map(row => row.pair === 16 ? { ...row, sample: { ...row.sample, at: "2026-11-11T00:00:00Z" } } : row), options);
  assert.equal(drifted.cases[0].inputChecks.at, false);
  assert.equal(drifted.complete, false);
  const changedRead = summarizePairedSamples(rows.map((row, index) => index === 0 ? { ...row, sample: { ...row.sample, reads: [{ file: "akasha/other.ndjson", bytes: 50 }] } } : row), options);
  assert.equal(changedRead.cases[0].inputChecks.readInput, false);
  assert.equal(changedRead.complete, false);
  assert.equal(summarizePairedSamples(rows, { ...options, queryIndexes: [0, 1] }).complete, false);
});

test("645: real parent and summary retain the default 15 groups and all queries", async () => {
  const { result, rows } = await runDriver();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rows.length, 135);
  const summary = summarizePairedSamples(rows);
  assert.equal(summary.complete, true);
  assert.equal(summary.cases.length, 3);
  assert.ok(summary.cases.every(entry => entry.groups.baseline.n === 15 && entry.percentileRanks.baseline.p95 === 15));
  const q0 = rows.filter(row => row.queryIndex === 0);
  const hundred = Array.from({ length: 100 }, (_, pair) => {
    const order = pair % 2 === 0 ? ["baseline", "candidate", "candidate-observed"] : ["candidate", "baseline", "candidate-observed"];
    return order.map(mode => { const row = q0.find(value => value.mode === mode); return { ...row, pair, sample: { ...row.sample, maxRss: pair + 1 } }; });
  }).flat();
  const fixed = summarizePairedSamples(hundred, { groups: 100, startPair: 0, queryIndexes: [0] });
  assert.equal(fixed.complete, true);
  assert.deepEqual(fixed.cases[0].groups.baseline.maxRssKiB, { p50: 50, p95: 95 });
  assert.deepEqual(fixed.cases[0].percentileRanks.baseline, { n: 100, p50: 50, p95: 95 });
});

test("645: real parent preserves child and parse failures and completes every scheduled mode", async () => {
  const { result, rows } = await runDriver(["--groups", "2", "--start-pair", "0", "--query-indexes", "0"], true);
  assert.equal(result.status, 1);
  assert.equal(rows.length, 6);
  assert.ok(rows.every(row => row.stderr.includes("retained child diagnostic")));
  assert.equal(rows.filter(row => row.exit === 3).length, 2);
  assert.equal(rows.filter(row => row.parseError !== null && row.stdout === "[not JSON]\n").length, 2);
  const summary = summarizePairedSamples(rows, { groups: 2, startPair: 0, queryIndexes: [0] });
  assert.equal(summary.samples, 6);
  assert.equal(summary.failedSamples, 4);
  assert.equal(summary.complete, false);
  assert.equal(summary.cases[0].failures.length, 4);
  assert.ok(Object.values(summary.cases[0].thresholds).every(value => value === null));
});
