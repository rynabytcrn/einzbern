// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectTestFiles } from "../scripts/lib/test-roster.mjs";
import { judgeTestWiring } from "../scripts/lib/test-wiring.mjs";
import { P1_TASKS } from "../scripts/p1-sequence.mjs";
import { P1_SHARDS, writeShardReceipt } from "../scripts/ci/p1-shard.mjs";
import { recordVerificationTiming, retainVerificationStep } from "../scripts/lib/verification-evidence.mjs";

test("CI shards partition every P1 task once and keep archive before full-history privacy", () => {
  const tasks = Object.values(P1_SHARDS).flat();
  assert.deepEqual([...tasks].sort(), [...P1_TASKS].sort());
  assert.equal(new Set(tasks).size, tasks.length);
  assert.ok(P1_SHARDS.checks.indexOf("archive") < P1_SHARDS.checks.indexOf("privacy"));
  assert.deepEqual(P1_SHARDS.core, ["test"]);
  assert.deepEqual(P1_SHARDS.portal, ["portal"]);
});

test("a red shard receipt goes to stderr independently of pnpm's stdout failure footer", () => {
  const chunks = { stdout: "", stderr: "" };
  const streams = Object.fromEntries(Object.keys(chunks).map((key) => [key, { write: (value) => { chunks[key] += value; } }]));
  const red = { ok: false, reasonCode: "P1_SHARD_RED" };
  writeShardReceipt(red, streams);
  streams.stdout.write("[ELIFECYCLE] Command failed with exit code 1.\n");
  assert.deepEqual(JSON.parse(chunks.stderr), red);
  assert.equal(chunks.stdout, "[ELIFECYCLE] Command failed with exit code 1.\n");
});

test("wiring includes nested Portal tests and refuses an orphan or replaced runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { scripts: { test: "node scripts/task.mjs test", "portal:test": "node scripts/portal-tests.mjs" } };
  const paths = ["tests/core.test.mjs", "portal/tests/nested/ui.test.mjs", "portal/tests/helpers/setup.mjs"];
  for (const path of [...paths, ".github/workflows/ci.yml"]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const registryPath = join(root, "registry.json");
  await writeFile(registryPath, '{"entries":[]}');
  const judge = () => judgeTestWiring({ repoRoot: root, registryPath });
  assert.equal(judge().ok, true);
  assert.equal(judge().coveredByPipeline, 2);
  assert.deepEqual(selectTestFiles(paths, "portal"), ["portal/tests/nested/ui.test.mjs"]);
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts/lost.test.mjs"), "");
  assert.deepEqual(judge().orphaned, ["scripts/lost.test.mjs"]);
  manifest.scripts["portal:test"] = "node --test portal/tests/*.test.mjs";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  assert.ok(judge().orphaned.includes("portal/tests/nested/ui.test.mjs"));
  assert.ok(judge().problems.some((problem) => problem.includes("portal:test")));
});

test("verification artifacts retain passing and failing raw output without overwriting prior evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "einzbern-timings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await retainVerificationStep(root, { id: "01", exitCode: 1 }, { stdout: "passed before failure\n", stderr: "assertion failed\n" });
  assert.equal(await readFile(join(root, "01.stdout"), "utf8"), "passed before failure\n");
  assert.equal(await readFile(join(root, "01.stderr"), "utf8"), "assertion failed\n");
  await assert.rejects(retainVerificationStep(root, { id: "01" }, { stdout: "replacement" }), { code: "EEXIST" });
  const timing = await recordVerificationTiming({ kind: "historical-block", phase: "full-restoration" }, performance.now(), { EINZBERN_VERIFY_TIMINGS_DIR: root });
  assert.ok(timing.durationMs >= 0);
  assert.equal(timing.phase, "full-restoration");
});

test("selected core rejects duplicate/extra files without changing the authoritative full P1 partition", async () => {
  const { validateSelectedTests } = await import("../scripts/lib/test-roster.mjs");
  assert.deepEqual(validateSelectedTests(["tests/a.test.mjs"], ["tests/a.test.mjs", "tests/b.test.mjs"]), ["tests/a.test.mjs"]);
  assert.throws(() => validateSelectedTests(["tests/a.test.mjs", "tests/a.test.mjs"], ["tests/a.test.mjs"]));
  assert.deepEqual(Object.values(P1_SHARDS).flat().sort(), [...P1_TASKS].sort());
});

test("real shard execution keeps a failed tiny child red and retains its raw result", async (t) => {
  const { runShard } = await import("../scripts/ci/p1-shard.mjs");
  const root = await mkdtemp(join(tmpdir(), "einzbern-shard-red-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/task.mjs"), 'process.stderr.write(JSON.stringify({ok:false,reasonCode:"HARMLESS_FIXTURE_RED"})+"\\n"); process.exitCode=1;\n');
  const saved = process.env.EINZBERN_CI_EVIDENCE_DIR;
  process.env.EINZBERN_CI_EVIDENCE_DIR = join(root, "evidence");
  await mkdir(join(root, "evidence"));
  try {
    const result = await runShard("core", root);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "P1_SHARD_RED");
    assert.equal(result.reds[0].task, "test");
    const step = JSON.parse(await readFile(join(root, "evidence/steps/leg-test.json"), "utf8"));
    assert.equal(step.exitCode, 1);
    assert.match(await readFile(join(root, "evidence/steps/leg-test.stderr"), "utf8"), /HARMLESS_FIXTURE_RED/u);
  } finally {
    if (saved === undefined) delete process.env.EINZBERN_CI_EVIDENCE_DIR;
    else process.env.EINZBERN_CI_EVIDENCE_DIR = saved;
  }
});
