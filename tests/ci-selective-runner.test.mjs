// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
test("real detached controller executes only selected harmless files and retains progress", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "einzbern-selected-controller-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".git"));
  await mkdir(join(directory, "tests"));
  await writeFile(join(directory, "tests/a.test.mjs"), 'import test from "node:test"; import { writeFileSync } from "node:fs"; test("selected harmless behavior", () => writeFileSync(process.env.OBSERVED, "executed"));\n');
  await writeFile(join(directory, "tests/b.test.mjs"), 'throw new Error("unselected test executed");\n');
  const selected = validateSelectedTests(["tests/a.test.mjs"], ["tests/a.test.mjs", "tests/b.test.mjs"]);
  const source = `
    import { runDetachedTestController } from ${JSON.stringify(new URL("../scripts/task.mjs", import.meta.url).href)};
    import { withExclusiveOutputSession } from ${JSON.stringify(new URL("../scripts/lib/safe-io.mjs", import.meta.url).href)};
    const result = await withExclusiveOutputSession(${JSON.stringify(directory)}, async () =>
      runDetachedTestController(${JSON.stringify(coreTestArgv(selected))}, {
        NODE_OPTIONS: ${JSON.stringify("--import=" + new URL("../scripts/no-network.mjs", import.meta.url).href)},
        OBSERVED: ${JSON.stringify(join(directory, "observed"))},
        EINZBERN_HOME: ${JSON.stringify(join(directory, "device"))},
      }, ${JSON.stringify(selected)}, false, ${JSON.stringify(directory)}));
    process.stdout.write(JSON.stringify(result) + "\\n");
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: directory, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_TEST_CONTEXT: "" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(await readFile(join(directory, "observed"), "utf8"), "executed");
  const report = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(report.progress.status, "completed");
});
