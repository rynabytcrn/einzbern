// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const failing of [false, true]) test(`Portal runner isolates first identity creation and cleans child home on ${failing ? "failure" : "success"}`, async t => {
  const base = await mkdtemp(join(tmpdir(), "portal-home-regression-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const parentHome = join(base, "parent");
  await mkdir(parentHome);
  await writeFile(join(parentHome, "sentinel"), "unchanged parent bytes");
  const result = join(base, "observed.json");
  const fixture = join(base, "identity.test.mjs");
  const identityModule = new URL("../dist/build/packages/core/src/device-identity.js", import.meta.url).href;
  await writeFile(fixture, `import test from 'node:test'; import {writeFile} from 'node:fs/promises'; import {readOrCreateDevice} from ${JSON.stringify(identityModule)}; test('initialize child',async()=>{ const identity=await readOrCreateDevice(); await writeFile(${JSON.stringify(result)},JSON.stringify({home:process.env.EINZBERN_HOME,root:process.env.EINZBERN_TEST_DEVICE_ROOT,identity,kept:process.env.NODE_ENV})); ${failing ? "throw Error('intentional fixture failure');" : ""} });`);
  const runner = new URL("../scripts/portal-tests.mjs", import.meta.url).href;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import {runPortalTestFiles} from ${JSON.stringify(runner)}; process.exitCode=await runPortalTestFiles([${JSON.stringify(fixture)}]);`], {
    encoding: "utf8", env: { ...environment, EINZBERN_HOME: parentHome, EINZBERN_HEAVY_LOCK_DIR: join(base, "locks"), NODE_ENV: "test" },
  });
  assert.equal(run.status, failing ? 1 : 0, run.stderr + run.stdout);
  const observed = JSON.parse(await readFile(result, "utf8"));
  assert.notEqual(observed.home, parentHome);
  assert.equal(observed.home, join(observed.root, "einzbern"));
  assert.equal(observed.identity.created, true);
  assert.equal(observed.kept, "test");
  assert.deepEqual(await readdir(parentHome), ["sentinel"]);
  assert.equal(await readFile(join(parentHome, "sentinel"), "utf8"), "unchanged parent bytes");
  await assert.rejects(access(observed.root), { code: "ENOENT" });
});
