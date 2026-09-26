// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R4: the engine names the oldest Node.js it runs on, the major version of
// package.json engines.node, and the CLI entry refuses an older one with ENGINE_NODE_TOO_OLD and
// the versions required and found before the rest of the engine loads.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { NODE_FLOOR, assertNodeFloor, meetsNodeFloor } from "../dist/build/packages/core/src/node-floor.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");

test("the floor is the major version package.json engines.node names", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const major = /^(\d+)\./u.exec(manifest.engines.node)?.[1];
  assert.equal(NODE_FLOOR, `${major}.0.0`);
  assert.equal(meetsNodeFloor(process.versions.node), true, "the Node.js running these tests meets it");
});

test("a Node.js older than the floor is refused with ENGINE_NODE_TOO_OLD {required, actual}", () => {
  for (const actual of ["24.0.0", "24.16.0", "v24.16.0", "25.0.0-nightly20260901", "100.1.2"]) {
    assert.doesNotThrow(() => assertNodeFloor(actual), actual);
  }
  for (const actual of ["23.11.1", "22.12.0", "v20.0.0", "24", "not a version"]) {
    assert.throws(() => assertNodeFloor(actual), (error) => {
      assert.equal(error.reasonCode, "ENGINE_NODE_TOO_OLD");
      assert.deepEqual({ ...error.details }, { required: NODE_FLOOR, actual });
      assert.match(error.message, new RegExp(`older than ${NODE_FLOOR.replaceAll(".", "\\.")}`, "u"));
      return true;
    }, actual);
  }
});

test("the CLI entry checks the floor before the rest of the engine loads", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-node-floor-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  // Injects an older version and records every module Node.js loads.
  const preload = join(base, "older-node.mjs");
  const loadedPath = join(base, "loaded.json");
  await writeFile(preload, [
    "import { writeFileSync } from \"node:fs\";",
    "import { registerHooks } from \"node:module\";",
    "const loaded = [];",
    "registerHooks({ load: (url, loadContext, nextLoad) => { loaded.push(url); return nextLoad(url, loadContext); } });",
    "Object.defineProperty(process.versions, \"node\", { value: \"22.12.0\" });",
    `process.on("exit", () => writeFileSync(${JSON.stringify(loadedPath)}, JSON.stringify(loaded)));`,
    "",
  ].join("\n"));
  const refused = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, cliPath, "commands"], { cwd: base, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "", "no command ran");
  const report = JSON.parse(refused.stderr.trim().split("\n").at(-1));
  assert.deepEqual(
    { ok: report.ok, reasonCode: report.reasonCode, required: report.required, actual: report.actual },
    { ok: false, reasonCode: "ENGINE_NODE_TOO_OLD", required: NODE_FLOOR, actual: "22.12.0" },
  );
  const loaded = JSON.parse(await readFile(loadedPath, "utf8"));
  assert.deepEqual(
    loaded.map((url) => url.slice(pathToFileURL(repositoryRoot).href.length + 1)),
    ["scripts/einzbern.mjs", "dist/build/packages/core/src/node-floor.js"],
    "only the entry and the floor module were loaded",
  );

  const accepted = spawnSync(process.execPath, [cliPath, "commands"], { cwd: base, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).reasonCode, "CLI_CATALOG_READY");
});
