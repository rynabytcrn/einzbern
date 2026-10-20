// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectTestFiles } from "../scripts/lib/test-roster.mjs";
import { judgeTestWiring } from "../scripts/lib/test-wiring.mjs";
import { P1_TASKS } from "../scripts/p1-sequence.mjs";
import { P1_SHARDS } from "../scripts/ci/p1-shard.mjs";
import { recordVerificationTiming, retainVerificationStep } from "../scripts/lib/verification-evidence.mjs";

test("CI shards partition every P1 task once and keep archive before full-history privacy", () => {
  const tasks = Object.values(P1_SHARDS).flat();
  assert.deepEqual([...tasks].sort(), [...P1_TASKS].sort());
  assert.equal(new Set(tasks).size, tasks.length);
  assert.ok(P1_SHARDS.checks.indexOf("archive") < P1_SHARDS.checks.indexOf("privacy"));
  assert.deepEqual(P1_SHARDS.core, ["test"]);
  assert.deepEqual(P1_SHARDS.portal, ["portal"]);
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
