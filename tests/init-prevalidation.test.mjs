// SPDX-License-Identifier: Apache-2.0
// STORY-547: invalid init admission leaves no new library bytes or device binding.
import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, lstat, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary } from "../dist/build/packages/core/src/workspace.js";
import { readRegistry, registerLibrary } from "../dist/build/packages/core/src/registry.js";

const AT = "2026-10-17T00:00:00Z";
async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-init-admission-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, "project");
  await mkdir(project);
  return { base, project, proposed: join(base, "new-library") };
}
async function refusesWithoutCreation(paths, extra, expected) {
  const registry = await readRegistry();
  let output = "";
  await assert.rejects(runCli(["init", "--workspace", paths.proposed, "--at", AT, ...extra], { write(value) { output += value; } }), expected);
  await assert.rejects(lstat(paths.proposed), { code: "ENOENT" });
  assert.deepEqual(await readRegistry(), registry, "a refused init must not change device bindings");
  assert.equal(output, "", "no creation receipt can escape a refused admission");
}

test("547: an already-bound project refuses init before creating its proposed library", async (context) => {
  const paths = await fixture(context);
  const existing = join(paths.base, "existing-library");
  await initializeLibrary({ root: existing, createdAt: AT });
  await registerLibrary({ projectPath: paths.project, libraryPath: existing, registeredAt: AT });
  await refusesWithoutCreation(paths, ["--project", paths.project], error => error.reasonCode === "SETUP_LIBRARY_CONFLICT");
});

test("547: a non-directory project refuses init before creating library bytes", async (context) => {
  const paths = await fixture(context);
  const file = join(paths.base, "not-a-project");
  await writeFile(file, "regular file\n");
  await refusesWithoutCreation(paths, ["--project", file], error => error.reasonCode === "CLI_ARGUMENT_MALFORMED");
});

test("547: malformed cloud-hosted flag refuses init before creating library bytes", async (context) => {
  const paths = await fixture(context);
  await refusesWithoutCreation(paths, ["--project", paths.project, "--cloud-hosted", "not-a-boolean"], error => error.reasonCode === "CLI_ARGUMENT_MALFORMED");
});
