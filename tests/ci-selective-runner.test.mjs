// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCiComponentFixture, fixturePlan, runFixtureTask, captureFixtureCore, componentSourceRoot } from "./helpers/ci-component-fixture.mjs";
import { coreTestArgv, validateSelectedTests } from "../scripts/lib/test-roster.mjs";
test("controller argv carries exact validated roster including nested test files", () => {
  const files = ["tests/a.test.mjs", "tests/nested/b.test.mjs"];
  assert.deepEqual(coreTestArgv(validateSelectedTests(files, [...files, "tests/z.test.mjs"])), ["--test", ...files]);
  for (const selected of [[], [...files, files[0]], [...files].reverse(), ["tests/missing.test.mjs"], ["portal/tests/a.test.mjs"], ["../tests/a.test.mjs"]]) assert.throws(() => validateSelectedTests(selected, files));
});
test("ordinary test/H1/P8 retain complete source roster; selection only enters through explicit CLI", () => {
  const source = readFileSync(new URL("../scripts/task.mjs", import.meta.url), "utf8");
  assert.match(source, /runDetachedTestController\(coreTestArgv\(tests\)/u);
  assert.match(source, /args\[0\] !== "--ci-plan"/u);
  assert.match(source, /if \(!args.length\) return runTests\(\)/u);
  assert.match(source, /if \(p8Only\) throw new Error/u);
  assert.equal(/process\.env\.[A-Z_]*(?:SELECT|PLAN)/u.test(source), false);
  assert.match(source, /900_?000/u);
  assert.match(source, /600_?000/u);
});
for (const coverage of ["full", "selective"]) {
  test(`real task CLI executes the exact ${coverage} tiny roster and releases its lifetime`, async (t) => {
    const fixture = await createCiComponentFixture(t, { production: true });
    const plan = fixturePlan(fixture, coverage);
    assert.equal(plan.coverage, coverage);
    const planPath = join(fixture.directory, "plan.json");
    await writeFile(planPath, JSON.stringify(plan));
    for (const path of ["scripts/task.mjs", "scripts/ci/p1-shard.mjs", "scripts/test-controller-bootstrap.mjs", "scripts/test-controller-child-policy.mjs"]) {
      assert.deepEqual(await readFile(join(fixture.repo, path)), await readFile(join(componentSourceRoot, path)));
    }
    const before = fixture.git("status", "--porcelain=v1", "--untracked-files=all");
    const run = runFixtureTask(fixture, ["test", "--ci-plan", planPath], coverage === "selective" ? { CI_COMPONENT_FAIL: "b" } : {});
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stderr, "");
    const observed = JSON.parse(run.stdout.trim());
    assert.equal(observed.command, "test");
    assert.equal(observed.reasonCode, coverage === "full" ? "TESTS_VERIFIED" : "TESTS_SELECTED_VERIFIED");
    assert.equal(observed.coverage, coverage);
    assert.equal(observed.planDigest, plan.planDigest);
    assert.deepEqual(observed.tests, plan.coreTests);
    assert.deepEqual(observed.argv, ["--test", ...plan.coreTests]);
    assert.equal(observed.progress.status, "completed");
    assert.deepEqual(observed.progress.errors, []);
    const markers = (await readFile(fixture.env.CI_COMPONENT_OBSERVED, "utf8")).trim().split("\n").sort();
    assert.deepEqual(markers, coverage === "full" ? ["a", "b"] : ["a"]);
    assert.deepEqual(plan.sourceCoreTests, ["tests/a.test.mjs", "tests/b.test.mjs"]);
    assert.equal(plan.notApplicable.some((row) => row.path === "tests/b.test.mjs"), coverage === "selective");
    const evidence = JSON.parse(await readFile(join(fixture.repo, "dist/evidence/p1/test.json"), "utf8"));
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.result, Object.fromEntries(Object.entries(observed).filter(([key]) => !["ok", "command"].includes(key))));
    assert.equal(fixture.git("status", "--porcelain=v1", "--untracked-files=all"), before);
    await assert.rejects(lstat(join(fixture.repo, ".git/einzbern-output.lock")), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(fixture.directory, "heavy-locks")), []);
    assert.deepEqual((await readdir(fixture.directory)).filter((name) => /^(?:tcrn-test-|einzbern-test-device-)/u.test(name)), []);
  });
}

test("canonical and aliased real task entrypoints both execute unknown-command refusal", async (t) => {
  const fixture = await createCiComponentFixture(t, { production: true });
  const alias = join(fixture.directory, "alias/scripts");
  await mkdir(alias, { recursive: true });
  await symlink(join(fixture.repo, "scripts/task.mjs"), join(alias, "task.mjs"));
  const { spawnSync } = await import("node:child_process");
  for (const entry of [join(fixture.repo, "scripts/task.mjs"), join(alias, "task.mjs")]) {
    const run = spawnSync(process.execPath, [entry, "unknown-component-command"], { cwd: fixture.repo, env: fixture.env, encoding: "utf8" });
    assert.equal(run.status, 1, entry);
    assert.equal(run.stdout, "");
    assert.equal(JSON.parse(run.stderr).reasonCode, "TASK_UNKNOWN");
  }
  assert.equal(fixture.git("status", "--porcelain=v1"), "");
});

test("real failed tiny shard retains the failing controller streams and releases its owners", async (t) => {
  const fixture = await createCiComponentFixture(t, { production: true });
  const plan = fixturePlan(fixture, "full");
  const captured = await captureFixtureCore(fixture, plan, join(fixture.directory, "failed-core"), { CI_COMPONENT_FAIL: "a" });
  assert.equal(captured.capture.exitCode, 1);
  assert.equal(captured.shard.ok, false);
  assert.equal(captured.shard.reasonCode, "P1_SHARD_RED");
  assert.deepEqual(captured.step.command, ["node", "scripts/task.mjs", "test", "--ci-plan", captured.planPath]);
  assert.equal(captured.task.reasonCode, "COMMAND_FAILED");
  assert.deepEqual(captured.capture.errors, []);
  assert.deepEqual(captured.capture.retainedTestControllerOutput.errors, []);
  const raw = await readFile(join(captured.evidence, "p1-core-controller.stdout"), "utf8");
  assert.match(raw, /component a/u);
  assert.match(raw, /AssertionError|not strictly equal/u);
  assert.deepEqual(captured.input, captured.output);
  assert.deepEqual(captured.inputManifest, captured.outputManifest);
  assert.equal(fixture.git("status", "--porcelain=v1"), "");
  await assert.rejects(lstat(join(fixture.repo, ".git/einzbern-output.lock")), { code: "ENOENT" });
  assert.deepEqual(await readdir(captured.temporary), []);
  assert.deepEqual(await readdir(join(fixture.directory, "heavy-locks")), []);
});
