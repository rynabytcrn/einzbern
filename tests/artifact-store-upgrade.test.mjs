// SPDX-License-Identifier: Apache-2.0
import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import { restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises, { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { initializeLibrary, materializeWorkspace, registerLibrary } from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

standInForAtelier();
const at = "2026-11-11T04:00:00Z";
const entry = resolve("scripts/einzbern.mjs");
const digest = body => createHash("sha256").update(body).digest("hex");

async function cli(args) {
  let stdout = "";
  await runCli(args, { write: value => { stdout += value; } });
  return JSON.parse(stdout);
}

function projectCli(projectPath, args, expectedExit = 0) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: projectPath, env: process.env, encoding: "utf8" });
  assert.equal(result.status, expectedExit, result.stderr);
  return JSON.parse(expectedExit === 0 ? result.stdout : result.stderr);
}

async function fixture(t, { libraryBinding = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "artifact-upgrade-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: at });
  const projects = [];
  for (const key of ["UPGRADE-A", "UPGRADE-B"]) {
    const projectId = (await cli(["project-create", "--workspace", workspace, "--external-key", key, "--name", key, "--at", at])).record.id;
    const projectPath = join(base, key);
    await mkdir(projectPath);
    await registerLibrary({ projectId, projectPath, libraryPath: workspace, registeredAt: at, gitRemote: null });
    projects.push({ projectId, projectPath });
  }
  const file = join(base, "historical.txt");
  const historicalRoot = libraryBinding ? join(base, "historical-bound", "suffix") : join(workspace, "artifacts");
  if (libraryBinding) {
    await mkdir(historicalRoot, { recursive: true });
    await cli(["machine-settings-set", "--at", at, "--key", "paths.artifacts", "--value", join(base, "historical-bound")]);
    await cli(["settings-set", "--workspace", workspace, "--at", at, "--key", "workspace.generatedArtifactsPath", "--value", "binding:paths.artifacts/suffix"]);
  }
  await writeFile(file, "historical artifact evidence");
  const put = await cli(["artifact-put", "--workspace", workspace, "--file", file, "--at", at]);
  return { base, workspace, projects, file, put, historicalRoot, manifest: join(workspace, "artifacts", "artifact-manifest.json") };
}

test("P1: registry-default list and verify retain a library-only index and detect its damaged blob", async t => {
  const fx = await fixture(t);
  for (const project of fx.projects) {
    const listing = projectCli(project.projectPath, ["artifact-list"]);
    assert.equal(listing.schemaVersion, "tcrn.artifact-list.v1");
    assert.equal(listing.artifacts.length, 1, "the registry-inferred project must not hide historical artifacts");
    assert.equal(listing.artifacts[0].present, true);
    assert.equal(listing.artifacts[0].source.scope, "library");
    assert.equal(listing.artifacts[0].source.projectId, null, "shared history is never reassigned to the inferred project");
    assert.equal(listing.artifacts[0].source.manifest, "artifacts/artifact-manifest.json");
    assert.deepEqual(listing.unindexed, []);
    assert.equal(projectCli(project.projectPath, ["artifact-verify"]).checked, 1);
  }
  await writeFile(join(fx.workspace, "artifacts", fx.put.blobName), "corrupt historical blob");
  const verification = projectCli(fx.projects[0].projectPath, ["artifact-verify"]);
  assert.equal(verification.schemaVersion, "tcrn.artifact-verify.v1");
  assert.equal(verification.reasonCode, "ARTIFACT_MISMATCH");
  assert.equal(verification.checked, 1);
  assert.equal(verification.findings[0].source.scope, "library");
});

test("P1: new and shared indexes coexist at independent roots without migrating history or deduplicating stored objects", async t => {
  const fx = await fixture(t, { libraryBinding: true });
  const historicalManifest = await readFile(fx.manifest);
  const roots = [join(fx.base, "new-a"), join(fx.base, "new-b")];
  for (const [index, project] of fx.projects.entries()) {
    await mkdir(roots[index]);
    projectCli(project.projectPath, ["settings-set", "--at", at, "--key", "workspace.generatedArtifactsPath", "--value", roots[index]]);
    const file = join(fx.base, `project-${index}.txt`);
    await writeFile(file, `private to project ${index}`);
    projectCli(project.projectPath, ["artifact-put", "--file", file, "--at", at]);
  }
  const a = fx.projects[0];
  const duplicate = projectCli(a.projectPath, ["artifact-put", "--file", fx.file, "--at", at]);
  assert.equal(duplicate.sha256, fx.put.sha256);
  assert.equal(duplicate.deduplicated, false, "the same digest at another root is a separate stored object");
  for (const [index, project] of fx.projects.entries()) {
    const listing = projectCli(project.projectPath, ["artifact-list"]);
    const local = listing.artifacts.filter(row => row.source.scope === "project");
    assert.equal(local.length, index === 0 ? 2 : 1);
    assert.ok(local.every(row => row.source.projectId === project.projectId));
    assert.ok(listing.artifacts.every(row => row.present));
    assert.equal(listing.artifacts.filter(row => row.source.scope === "library").length, 1);
    assert.equal(projectCli(project.projectPath, ["artifact-verify"]).checked, index === 0 ? 3 : 2);
    assert.equal(JSON.stringify(listing).includes(roots[index]), false, "portable readbacks carry no absolute blob-root address");
  }
  assert.deepEqual(await readFile(fx.manifest), historicalManifest, "project puts leave the library-wide index unchanged");
  const corrupted = join(fx.historicalRoot, fx.put.blobName);
  const stored = await readFile(corrupted);
  await writeFile(corrupted, Buffer.alloc(stored.length));
  const verification = projectCli(a.projectPath, ["artifact-verify"]);
  assert.equal(verification.reasonCode, "ARTIFACT_MISMATCH");
  assert.equal(verification.checked, 3, "both copies of the repeated digest are checked");
  assert.equal(verification.findings.length, 1);
  assert.equal(verification.findings[0].sha256, duplicate.sha256);
  assert.equal(verification.findings[0].source.scope, "library");
  assert.notDeepEqual(await readFile(join(roots[0], duplicate.blobName)), Buffer.alloc(stored.length));
  await rename(fx.historicalRoot, `${fx.historicalRoot}-unavailable`);
  try {
    for (const verb of ["artifact-list", "artifact-verify"]) {
      assert.equal(projectCli(a.projectPath, [verb], 1).reasonCode, "ARTIFACT_PATH_INVALID", "a missing historical root cannot be skipped when the project root is healthy");
    }
  } finally {
    await rename(`${fx.historicalRoot}-unavailable`, fx.historicalRoot);
  }
});

test("P1: registry defaults refuse malformed, non-file and dangling historical indexes even alongside a valid project index", async t => {
  const fx = await fixture(t);
  const project = fx.projects[0];
  projectCli(project.projectPath, ["artifact-put", "--file", fx.file, "--at", at]);
  const original = await readFile(fx.manifest);
  for (const content of ["not-json", canonicalJson({ schemaVersion: "tcrn.artifact-manifest.v1", artifacts: [{ sha256: "bad" }] })]) {
    await writeFile(fx.manifest, content);
    for (const verb of ["artifact-list", "artifact-verify"]) {
      assert.equal(projectCli(project.projectPath, [verb], 1).reasonCode, "ARTIFACT_MANIFEST_INVALID");
    }
  }
  await rm(fx.manifest);
  await symlink(join(fx.base, "absent-manifest"), fx.manifest);
  for (const verb of ["artifact-list", "artifact-verify"]) {
    assert.equal(projectCli(project.projectPath, [verb], 1).reasonCode, "ARTIFACT_MANIFEST_INVALID");
  }
  await rm(fx.manifest);
  await mkdir(fx.manifest);
  assert.equal(projectCli(project.projectPath, ["artifact-verify"], 1).reasonCode, "ARTIFACT_MANIFEST_INVALID");
  await rm(fx.manifest, { recursive: true });
  await writeFile(fx.manifest, original);
});

test("P1: registry defaults never turn an unreadable or disappearing historical index into empty success", async t => {
  const fx = await fixture(t);
  const previousCwd = process.cwd();
  const original = fsPromises.lstat;
  try {
    process.chdir(fx.projects[0].projectPath);
    for (const code of ["EIO", "EACCES", "ENOENT"]) {
      let hits = 0;
      fsPromises.lstat = async (path, ...args) => {
        if (String(path) === fx.manifest) {
          hits += 1;
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      for (const verb of ["artifact-list", "artifact-verify"]) {
        await assert.rejects(cli([verb]), error => error.reasonCode === "ARTIFACT_MANIFEST_INVALID" && error.message.includes(code));
      }
      assert.ok(hits >= 2);
    }
  } finally {
    fsPromises.lstat = original;
    syncBuiltinESMExports();
    process.chdir(previousCwd);
  }
  await chmod(fx.manifest, 0o000);
  try {
    for (const verb of ["artifact-list", "artifact-verify"]) {
      const result = projectCli(fx.projects[0].projectPath, [verb], 1);
      assert.equal(result.reasonCode, "ARTIFACT_PATH_INVALID", "retain the existing manifest-open error code");
      assert.match(result.error, /EACCES|EPERM/u);
    }
  } finally {
    await chmod(fx.manifest, 0o644);
  }
});

test("P1: old-layout manifests remain readable at their original location without a project index", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "artifact-old-layout-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const { root, control } = await restoreLegacyFixture(base);
  const state = await materializeWorkspace(root);
  const body = Buffer.from("old-layout generated evidence");
  const stored = deflateSync(body);
  const sha256 = digest(body);
  await mkdir(join(root, "artifacts"));
  await writeFile(join(root, "artifacts", `${sha256}.bin`), stored);
  await writeFile(join(control, "artifact-manifest.json"), canonicalJson({
    schemaVersion: "tcrn.artifact-manifest.v1",
    artifacts: [{ sha256, bytes: body.length, storedBytes: stored.length, name: "old.txt", storedAt: at }],
  }));
  const projectId = state.projects.find(project => !project.tombstone).id;
  const args = ["--workspace", root, "--project-id", projectId];
  const listing = await cli(["artifact-list", ...args]);
  assert.equal(listing.artifacts.length, 1);
  assert.equal(listing.artifacts[0].present, true);
  assert.equal(listing.artifacts[0].source.scope, "library");
  assert.equal(listing.artifacts[0].source.manifest, ".tcrn-workflow/artifact-manifest.json");
  assert.equal((await cli(["artifact-verify", ...args])).checked, 1);
});
