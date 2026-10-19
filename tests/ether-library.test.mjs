// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 R1, R6, AC1, AC4 and STORY-466 R5: a new library's root, its manifest,
// its README and its invisibility to Git.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALIAS_TABLE_END_MARKER,
  ALIAS_TABLE_START_MARKER,
  FRAMEWORK_VERSION,
  LIBRARY_ROOT_ENTRIES,
  LIBRARY_FORMAT_VERSION,
  createLibrary,
  hasLibraryManifest,
  openLibrary,
  renderLegacyAliasTable,
  renderLibraryReadme,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const AT = "2026-09-26T00:00:00Z";

async function scratch(t) {
  const base = await mkdtemp(join(tmpdir(), "einzbern-library-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test("469-AC1: a new library holds exactly the seven root entries, and .gitignore is *", async (t) => {
  const base = await scratch(t);
  const root = join(base, "project", ".ether");
  const library = await createLibrary(root, { createdAt: AT, projectName: "Demo", gitRemote: "https://example.invalid/demo.git" });
  assert.deepEqual((await readdir(root)).sort(), [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);
  assert.deepEqual([...LIBRARY_ROOT_ENTRIES], [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "*\n");
  for (const directory of ["akasha", "artifacts", "config", "crest"]) assert.deepEqual(await readdir(join(root, directory)), [], `${directory} starts empty`);
  // A library is its real path (TCRN-CROSS-STORY-470 R2): the temporary directory may be reached
  // through a symbolic link, as /var is on macOS.
  assert.equal(library.root, await realpath(root));
});

test("469-R1: the manifest names the library, its format, the engine it needs and the project, in canonical bytes", async (t) => {
  const base = await scratch(t);
  const root = join(base, ".ether");
  const { manifest } = await createLibrary(root, { createdAt: AT, projectName: "Demo", gitRemote: null });
  assert.deepEqual(Object.keys(manifest).sort(), ["createdAt", "formatVersion", "libraryId", "minEngineVersion", "project", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, "einzbern.library-manifest.v1");
  assert.match(manifest.libraryId, /^library:[a-f0-9]{24}$/u);
  assert.equal(manifest.formatVersion, LIBRARY_FORMAT_VERSION);
  assert.equal(manifest.minEngineVersion, FRAMEWORK_VERSION);
  assert.deepEqual(manifest.project, { name: "Demo", gitRemote: null });
  assert.equal(manifest.createdAt, AT);
  assert.equal(await readFile(join(root, "manifest.json"), "utf8"), canonicalJson(manifest));
  assert.deepEqual((await openLibrary(root)).manifest, manifest);
  const other = await createLibrary(join(base, "second"), { createdAt: AT });
  assert.notEqual(other.manifest.libraryId, manifest.libraryId, "every library draws its own id");
  assert.deepEqual(other.manifest.project, { name: null, gitRemote: null });
  const imported = await createLibrary(join(base, "imported"), { createdAt: AT, libraryId: "workspace:0123456789abcdef01234567" });
  assert.equal(imported.manifest.libraryId, "workspace:0123456789abcdef01234567", "an imported old workspace keeps its id");
});

test("469-AC4: a library inside a Git working tree does not show in git status", async (t) => {
  const base = await scratch(t);
  const repository = join(base, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  await createLibrary(join(repository, ".ether"), { createdAt: AT, projectName: "Repository" });
  const status = execFileSync("git", ["-C", repository, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  assert.equal(status, "");
  await writeFile(join(repository, "visible.txt"), "a file of the project\n");
  assert.equal(execFileSync("git", ["-C", repository, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "?? visible.txt\n",
    "the working tree itself is still seen");
});

test("466-R5: the README explains every name and carries the alias table names.ts renders", async (t) => {
  const base = await scratch(t);
  const root = join(base, ".ether");
  await createLibrary(root, { createdAt: AT });
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.equal(readme, renderLibraryReadme());
  const start = readme.indexOf(ALIAS_TABLE_START_MARKER);
  const end = readme.indexOf(ALIAS_TABLE_END_MARKER);
  assert.ok(start >= 0 && end > start);
  assert.deepEqual(readme.slice(start + ALIAS_TABLE_START_MARKER.length, end).trim().split("\n"), [...renderLegacyAliasTable()]);
  for (const name of ["Einzbern", "Atelier", "`Ether/`", "`Ether/akasha/`", "`Ether/crest/`", "`Ether/config/`", "`Ether/artifacts/`", "`Ether/manifest.json`", "`Ether/.gitignore`"]) {
    assert.ok(readme.includes(name), `the README explains ${name}`);
  }
  assert.ok(!readme.includes("\r"), "LF only");
  assert.ok(readme.endsWith("\n"));
});

test("469-R1: a target that is not empty, or not a directory, is refused and left as it was", async (t) => {
  const base = await scratch(t);
  const occupied = join(base, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "mine\n");
  await assert.rejects(createLibrary(occupied, { createdAt: AT }), (error) => error?.reasonCode === "LIBRARY_TARGET_NOT_EMPTY");
  assert.deepEqual(await readdir(occupied), ["keep.txt"]);
  const file = join(base, "file");
  await writeFile(file, "x");
  await assert.rejects(createLibrary(file, { createdAt: AT }), (error) => error?.reasonCode === "LIBRARY_TARGET_INVALID");
  const empty = join(base, "empty");
  await mkdir(empty);
  await createLibrary(empty, { createdAt: AT });
  assert.equal(await hasLibraryManifest(empty), true, "an existing empty directory is accepted");
});

test("469-R1: opening needs a manifest, and a manifest that does not validate is refused", async (t) => {
  const base = await scratch(t);
  await assert.rejects(openLibrary(join(base, "nothing")), (error) => error?.reasonCode === "LIBRARY_NOT_FOUND");
  const root = join(base, ".ether");
  const { manifest } = await createLibrary(root, { createdAt: AT });
  const cases = [
    "{",
    JSON.stringify({ ...manifest, extra: 1 }),
    JSON.stringify({ ...manifest, libraryId: "project:0123456789abcdef01234567" }),
    JSON.stringify({ ...manifest, formatVersion: 0 }),
    JSON.stringify({ ...manifest, project: { name: "x" } }),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ];
  for (const text of cases) {
    await writeFile(join(root, "manifest.json"), text);
    await assert.rejects(openLibrary(root), (error) => error?.reasonCode === "LIBRARY_MANIFEST_INVALID", text.slice(0, 40));
  }
});
