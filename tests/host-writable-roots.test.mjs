// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-470 R5, AC4 (MIN-227 D19): a library outside its project is named in the
// project's own host settings, Claude Code's permissions.additionalDirectories and Codex's
// [sandbox_workspace_write] writable_roots, with everything else in both files kept. Wiring twice
// changes nothing, a replaced file is backed up in the device directory first, a library inside
// the project needs nothing, a file the wiring cannot edit safely is refused untouched, and a
// relocation wires every project this device has registered for the library.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { applyWritableRoots, planWritableRoots } from "../dist/build/packages/core/src/index.js";
import { codexWritableRoots, hostFileTrackedByGit } from "../dist/build/packages/core/src/host-writable-roots.js";

const AT = "2026-09-26T10:00:00Z";
const STAMP = "20260926T100000Z";
const CLAUDE = ".claude/settings.local.json";
const CODEX = ".codex/config.toml";

let tick = 0;
const at = () => {
  tick += 1;
  return new Date(Date.UTC(2026, 8, 26, 9, 0, tick)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-roots-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function library(path) {
  await cli(["init", "--workspace", path, "--at", at()]);
  return realpath(path);
}

async function hostFiles(root) {
  return {
    claude: await readFile(join(root, CLAUDE), "utf8").catch(() => null),
    codex: await readFile(join(root, CODEX), "utf8").catch(() => null),
  };
}

// A project whose host files already hold the user's own settings.
async function project(base) {
  const root = join(base, "project");
  await mkdir(join(root, ".claude"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, CLAUDE), `${JSON.stringify({ permissions: { allow: ["Bash(ls)"], additionalDirectories: ["/opt/shared"] }, env: { KEEP: "1" } }, null, 2)}\n`);
  await writeFile(join(root, CODEX), [
    "# the user's own Codex settings",
    "model = \"gpt-test\"",
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    "[profiles.keep]",
    "model = \"other\"",
    "",
  ].join("\n"));
  return root;
}

test("470-AC4: a library outside the project is named in both hosts' project settings, the rest of each file is kept, and the originals are backed up", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  const lib = await library(join(base, "cloud", "Ether", "project"));
  const before = await hostFiles(root);

  const applied = await applyWritableRoots(await planWritableRoots({ projectRoot: root, libraryPath: lib }), { at: AT });
  assert.deepEqual([applied.reasonCode, applied.projectRoot, applied.libraryPath, applied.libraryInsideProject], ["HOST_WRITABLE_ROOTS_WRITTEN", root, lib, false]);
  assert.deepEqual(applied.files.map((file) => [file.host, file.path, file.changed, file.trackedByGit]), [["claude-code", CLAUDE, true, false], ["codex", CODEX, true, false]]);
  assert.deepEqual(JSON.parse(await readFile(join(root, CLAUDE), "utf8")), { permissions: { allow: ["Bash(ls)"], additionalDirectories: ["/opt/shared", lib] }, env: { KEEP: "1" } });
  assert.equal(await readFile(join(root, CODEX), "utf8"), [
    "# the user's own Codex settings",
    "model = \"gpt-test\"",
    "",
    "[sandbox_workspace_write]",
    `writable_roots = [${JSON.stringify(lib)}]`,
    "network_access = true",
    "",
    "[profiles.keep]",
    "model = \"other\"",
    "",
  ].join("\n"));

  // The originals were copied into the device directory, under the UTC instant, before the files were replaced.
  const backups = join(base, "device", "backups", STAMP, "writable-roots");
  const [projectDigest] = await readdir(backups);
  assert.equal(applied.backupDir, join(backups, projectDigest));
  assert.deepEqual(await hostFiles(applied.backupDir), before);
});

test("470-R5: wiring again changes nothing, and an existing writable_roots array gains the library once with its comments kept", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  const lib = await library(join(base, "elsewhere", "library"));
  await writeFile(join(root, CODEX), "[sandbox_workspace_write]\nwritable_roots = [\n  \"/opt/a\", # kept\n  '/opt/b',\n]\nnetwork_access = false\n");
  assert.equal((await applyWritableRoots(await planWritableRoots({ projectRoot: root, libraryPath: lib }), { at: AT })).reasonCode, "HOST_WRITABLE_ROOTS_WRITTEN");
  const once = await hostFiles(root);
  assert.equal(once.codex, `[sandbox_workspace_write]\nwritable_roots = [\n  "/opt/a", # kept\n  '/opt/b', ${JSON.stringify(lib)},\n]\nnetwork_access = false\n`);

  const again = await planWritableRoots({ projectRoot: root, libraryPath: lib });
  assert.deepEqual(again.files.map((file) => file.changed), [false, false], "a second plan has nothing to change");
  const repeated = await applyWritableRoots(again, { at: "2026-09-26T10:05:00Z" });
  assert.deepEqual([repeated.reasonCode, repeated.backupDir], ["HOST_WRITABLE_ROOTS_CURRENT", null]);
  assert.deepEqual(await hostFiles(root), once);
});

test("470-R5: the Codex file is edited in place, and a table-looking line inside a multi-line string is not a table", () => {
  const lib = "/opt/library";
  assert.equal(codexWritableRoots(null, lib), `[sandbox_workspace_write]\nwritable_roots = ["/opt/library"]\n`);
  assert.equal(codexWritableRoots("[sandbox_workspace_write]\nwritable_roots = [\"/opt/a\"] # mine\n", lib), "[sandbox_workspace_write]\nwritable_roots = [\"/opt/a\", \"/opt/library\"] # mine\n");
  assert.equal(codexWritableRoots("[sandbox_workspace_write]\nwritable_roots = []\n", lib), "[sandbox_workspace_write]\nwritable_roots = [\"/opt/library\"]\n");
  assert.equal(codexWritableRoots("[sandbox_workspace_write]\nwritable_roots = [\n  \"/opt/a\"\n]\n", lib), "[sandbox_workspace_write]\nwritable_roots = [\n  \"/opt/a\", \"/opt/library\"\n]\n");
  assert.equal(codexWritableRoots("model = \"x\"\r\n\r\n[sandbox_workspace_write]\r\n", lib), "model = \"x\"\r\n\r\n[sandbox_workspace_write]\r\nwritable_roots = [\"/opt/library\"]\r\n");
  const multiline = "instructions = \"\"\"\n[sandbox_workspace_write]\nwritable_roots = [\"/not/a/key\"]\n\"\"\"\n";
  assert.equal(codexWritableRoots(multiline, lib), `${multiline}\n[sandbox_workspace_write]\nwritable_roots = ["/opt/library"]\n`);
  const present = "[sandbox_workspace_write]\nwritable_roots = [\"/opt/\\u006cibrary\"]\n";
  assert.equal(codexWritableRoots(present, lib), present, "an escaped spelling of the same path is the same path");
});

test("470-R5: a library inside its project needs nothing, and a missing host file is created naming the library alone", async (context) => {
  const base = await scratch(context);
  const inner = join(base, "inner");
  await mkdir(inner);
  const own = await library(join(inner, ".ether"));
  const plan = await planWritableRoots({ projectRoot: inner, libraryPath: own });
  assert.deepEqual([plan.libraryInsideProject, plan.files], [true, []]);
  const applied = await applyWritableRoots(plan, { at: AT });
  assert.deepEqual([applied.reasonCode, applied.backupDir], ["HOST_WRITABLE_ROOTS_NOT_NEEDED", null]);
  assert.deepEqual(await readdir(inner), [".ether"], "nothing was written");

  const bare = join(base, "bare");
  await mkdir(bare);
  const outside = await library(join(base, "outside"));
  const created = await applyWritableRoots(await planWritableRoots({ projectRoot: bare, libraryPath: outside }), { at: AT });
  assert.deepEqual([created.reasonCode, created.backupDir], ["HOST_WRITABLE_ROOTS_WRITTEN", null], "no file existed, so none was backed up");
  assert.deepEqual(JSON.parse(await readFile(join(bare, CLAUDE), "utf8")), { permissions: { additionalDirectories: [outside] } });
  assert.equal(await readFile(join(bare, CODEX), "utf8"), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(outside)}]\n`);
});

test("470-R5: a host file Git tracks is still wired, and the result says it is tracked", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  const lib = await library(join(base, "outside"));
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", CODEX], { stdio: "ignore" });
  const applied = await applyWritableRoots(await planWritableRoots({ projectRoot: root, libraryPath: lib }), { at: AT });
  assert.deepEqual(applied.files.map((file) => [file.path, file.changed, file.trackedByGit]), [[CLAUDE, true, false], [CODEX, true, true]]);
  assert.match(await readFile(join(root, CODEX), "utf8"), /^writable_roots = \[/mu);
});

test("385-R16: whether Git tracks a host file is answered from the index alone, with no library anywhere, for a project at or below the repository's root", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  const git = (...args) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, HOME: base } });
  assert.equal(hostFileTrackedByGit(root, CODEX), false, "a project that is no repository tracks nothing");
  git("init", "-q", root);
  assert.equal(hostFileTrackedByGit(root, CODEX), false, "a file outside the index is not tracked");
  git("-C", root, "add", CODEX);
  assert.deepEqual([hostFileTrackedByGit(root, CODEX), hostFileTrackedByGit(root, CLAUDE)], [true, false]);
  // A project in a directory of a larger repository: the file is named relative to the project.
  const nested = join(base, "monorepo");
  await mkdir(nested);
  git("init", "-q", nested);
  const app = await project(nested);
  git("-C", nested, "add", join("project", CLAUDE));
  assert.deepEqual([hostFileTrackedByGit(app, CLAUDE), hostFileTrackedByGit(app, CODEX)], [true, false]);
  assert.deepEqual((await readdir(base)).sort(), ["monorepo", "project"], "nothing else was made: no library, no device directory");
});

test("470-R5: a host file the wiring cannot edit safely, or one that changed after planning, is refused and nothing is written", async (context) => {
  const base = await scratch(context);
  const root = await project(base);
  const lib = await library(join(base, "outside"));
  const before = await hostFiles(root);
  const refused = (file) => (error) => error?.reasonCode === "HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED" && error.details.file === file;

  await writeFile(join(root, CLAUDE), "{ \"permissions\": ");
  await assert.rejects(planWritableRoots({ projectRoot: root, libraryPath: lib }), refused(CLAUDE));
  await writeFile(join(root, CLAUDE), `${JSON.stringify({ permissions: { additionalDirectories: "/opt/one" } })}\n`);
  await assert.rejects(planWritableRoots({ projectRoot: root, libraryPath: lib }), refused(CLAUDE));
  await writeFile(join(root, CLAUDE), before.claude);

  for (const codex of [
    "sandbox_workspace_write.writable_roots = [\"/opt/a\"]\n",
    "sandbox_workspace_write = { network_access = true }\n",
    "[sandbox_workspace_write]\nwritable_roots = [\"/opt/a\", 3]\n",
    "[sandbox_workspace_write]\nwritable_roots = \"/opt/a\"\n",
    "[sandbox_workspace_write]\n[sandbox_workspace_write]\n",
    "[sandbox_workspace_write]\nwritable_roots = [\"/opt/a\"\n",
  ]) {
    await writeFile(join(root, CODEX), codex);
    await assert.rejects(planWritableRoots({ projectRoot: root, libraryPath: lib }), refused(CODEX), codex);
  }
  await writeFile(join(root, CODEX), before.codex);

  // A linked host file is refused rather than replaced by a regular file.
  const elsewhere = join(base, "dotfiles.json");
  await writeFile(elsewhere, before.claude);
  await rm(join(root, CLAUDE));
  await symlink(elsewhere, join(root, CLAUDE));
  await assert.rejects(planWritableRoots({ projectRoot: root, libraryPath: lib }), refused(CLAUDE));
  await rm(join(root, CLAUDE));
  await writeFile(join(root, CLAUDE), before.claude);

  // A file that changes between the plan and the write stops the write before anything is replaced.
  const plan = await planWritableRoots({ projectRoot: root, libraryPath: lib });
  await writeFile(join(root, CODEX), `${before.codex}# edited meanwhile\n`);
  await assert.rejects(applyWritableRoots(plan, { at: AT }), (error) => error?.reasonCode === "HOST_WRITABLE_ROOTS_CONCURRENT_MODIFICATION" && error.details.file === CODEX);
  assert.deepEqual(await hostFiles(root), { claude: before.claude, codex: `${before.codex}# edited meanwhile\n` });
  await assert.rejects(stat(join(base, "device", "backups")), { code: "ENOENT" }, "nothing was backed up either");

  await assert.rejects(planWritableRoots({ projectRoot: join(base, "missing"), libraryPath: lib }), (error) => error?.reasonCode === "HOST_WRITABLE_ROOTS_PROJECT_NOT_FOUND");
  await assert.rejects(planWritableRoots({ projectRoot: root, libraryPath: join(base, "nowhere") }), (error) => error?.reasonCode === "LIBRARY_NOT_FOUND");
});

test("470-AC4: workspace-relocate wires every project registered for the library, and a project whose wiring fails does not undo the move", async (context) => {
  const base = await scratch(context);
  const first = join(base, "project-a");
  await mkdir(first);
  const lib = join(first, ".ether");
  await cli(["init", "--workspace", lib, "--at", at(), "--project", first]);
  const second = join(base, "project-b");
  await mkdir(join(second, ".claude"), { recursive: true });
  await writeFile(join(second, CLAUDE), "not json\n");
  await cli(["library-register", "--project", second, "--library", lib, "--at", at()]);

  const target = join(base, "cloud", "Ether", "project");
  const report = await cli(["workspace-relocate", "--workspace", lib, "--to", target, "--at", AT]);
  assert.deepEqual([report.reasonCode, report.to, report.registryEntries], ["LIBRARY_RELOCATED", target, 2]);
  assert.deepEqual(report.hostWiring.map((wiring) => [wiring.projectRoot, wiring.reasonCode]), [
    [first, "HOST_WRITABLE_ROOTS_WRITTEN"],
    [second, "HOST_WRITABLE_ROOTS_FILE_UNSUPPORTED"],
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(first, CLAUDE), "utf8")), { permissions: { additionalDirectories: [target] } });
  assert.equal(await readFile(join(first, CODEX), "utf8"), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(target)}]\n`);
  assert.deepEqual(await hostFiles(second), { claude: "not json\n", codex: null }, "the project whose wiring failed got nothing");

  // The move stands: the registry follows it and the old place keeps its tombstone.
  assert.equal((await cli(["library-resolve", "--cwd", second])).libraryPath, target);
  assert.equal(JSON.parse(await readFile(join(lib, "TOMBSTONE.json"), "utf8")).movedTo, target);
});
