// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-SUB-357 S1 (INIT-053 R41 B3): the staged privacy check labels staged content with
// its real repository path, so the reviewed DS publication provenance line is classified at its
// exact inventory paths and nowhere else. The owner and the reviewed line are built at run time
// from the names module; this file carries no private literal.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { BRAND, LEGACY_REPOSITORY_NAMES } from "../scripts/lib/names.mjs";

const joinParts = (parts, separator) => parts.join(separator);
const CHECKER = resolve(import.meta.dirname, "../scripts/verify-staged-privacy.mjs");
const OWNER = LEGACY_REPOSITORY_NAMES.owner;
const REVIEWED_LINE = `      "pr": "https://github.com/${OWNER}/TCRN-Design-System/pull/23",`;
const REVIEWED_PATHS = ["component", "copy", "limit", "scope"].map((family) => `docs/verification/init053-owner-return-${family}-inventory.json`);
const FIXTURE_EMAIL = joinParts(["fixture", "@", "users.noreply.github.com"], "");

function fixtureGit(root, arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-10-08T00:00:00Z",
      GIT_AUTHOR_EMAIL: FIXTURE_EMAIL,
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_DATE: "2026-10-08T00:00:00Z",
      GIT_COMMITTER_EMAIL: FIXTURE_EMAIL,
      GIT_COMMITTER_NAME: "fixture",
    },
  });
  assert.equal(result.status, 0, `${arguments_.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixtureRepository(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "einzbern-staged-reviewed-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  fixtureGit(root, ["remote", "add", "origin", `https://github.com/${OWNER}/${BRAND.engine.id}.git`]);
  await stage(root, "README.md", "fixture\n");
  fixtureGit(root, ["commit", "-q", "-m", "baseline"]);
  return root;
}

async function stage(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
  fixtureGit(root, ["add", "--", path]);
}

function check(root) {
  const result = spawnSync(process.execPath, [CHECKER], { cwd: root, encoding: "utf8" });
  assert.equal(result.stderr, "", result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test("the reviewed provenance line is built from the names module and keeps its reviewed digest", () => {
  assert.equal(createHash("sha256").update(OWNER, "utf8").digest("hex"), "1b58b39b82f7665f411664797bcc897a75d9a6222ee4a8c97234493324aab74f");
  assert.equal(createHash("sha256").update(REVIEWED_LINE, "utf8").digest("hex"), "ea08e88222217b0cda6d5021955e9b41313993ca6fe8a768a074bd01a1881ab6");
});

test("B3: the reviewed line staged at each exact inventory path is clean", async (context) => {
  for (const path of REVIEWED_PATHS) {
    const root = await fixtureRepository(context);
    await stage(root, path, `${REVIEWED_LINE}\n`);
    const { status, report } = check(root);
    assert.equal(status, 0, JSON.stringify(report.findings));
    assert.equal(report.reasonCode, "PRIVACY_STAGED_CLEAN", path);
    assert.deepEqual(report.findings, []);
    assert.equal(report.stagedPaths, 1);
    assert.equal(report.scannedEntries, 2);
    assert.deepEqual(report.objects.map((object) => [object.path, object.scanned]), [[path, true]]);
  }
});

test("B3: the reviewed line at another path, extra private content, a rename and a moved line stay findings", async (context) => {
  const ownerFinding = (path) => `OWNER_PRIVATE_IDENTIFIER:source:${path}`;

  const elsewhere = await fixtureRepository(context);
  const otherPath = "docs/verification/other-inventory.json";
  await stage(elsewhere, otherPath, `${REVIEWED_LINE}\n`);
  const atOtherPath = check(elsewhere);
  assert.equal(atOtherPath.status, 1);
  assert.equal(atOtherPath.report.reasonCode, "PRIVACY_STAGED_FINDINGS");
  assert.deepEqual(atOtherPath.report.findings, [ownerFinding(otherPath)], "the finding names the real staged path");

  const extra = await fixtureRepository(context);
  const privateRoot = joinParts(["", "Users", OWNER, "Code"], "/");
  await stage(extra, REVIEWED_PATHS[0], `${REVIEWED_LINE}\n${privateRoot}\n`);
  const withExtra = check(extra);
  assert.equal(withExtra.status, 1);
  assert.ok(withExtra.report.findings.includes(`LOCAL_ABSOLUTE_PATH:source:${REVIEWED_PATHS[0]}`), JSON.stringify(withExtra.report.findings));
  assert.ok(withExtra.report.findings.includes(ownerFinding(REVIEWED_PATHS[0])), "the reviewed line does not exempt other owner text on its path");

  const renamed = await fixtureRepository(context);
  await stage(renamed, REVIEWED_PATHS[1], `${REVIEWED_LINE}\n`);
  fixtureGit(renamed, ["commit", "-q", "-m", "reviewed inventory"]);
  const renamedPath = "docs/verification/renamed-inventory.json";
  fixtureGit(renamed, ["mv", REVIEWED_PATHS[1], renamedPath]);
  const afterRename = check(renamed);
  assert.equal(afterRename.status, 1);
  assert.deepEqual(afterRename.report.findings, [ownerFinding(renamedPath)], "with --no-renames the new path is an addition");
  assert.equal(afterRename.report.stagedPaths, 1);

  const moved = await fixtureRepository(context);
  await stage(moved, REVIEWED_PATHS[2], `${REVIEWED_LINE}\n`);
  fixtureGit(moved, ["commit", "-q", "-m", "reviewed inventory"]);
  fixtureGit(moved, ["rm", "-q", "--", REVIEWED_PATHS[2]]);
  const movedPath = "docs/verification/notes.json";
  await stage(moved, movedPath, `{\n${REVIEWED_LINE}\n}\n`);
  const afterMove = check(moved);
  assert.equal(afterMove.status, 1);
  assert.deepEqual(afterMove.report.findings, [ownerFinding(movedPath)]);
});

test("B3: a staged deletion scans no content and keeps the output fields", async (context) => {
  const root = await fixtureRepository(context);
  await stage(root, REVIEWED_PATHS[3], `${REVIEWED_LINE}\n`);
  fixtureGit(root, ["commit", "-q", "-m", "reviewed inventory"]);
  fixtureGit(root, ["rm", "-q", "--", REVIEWED_PATHS[3]]);
  const { status, report } = check(root);
  assert.equal(status, 0);
  assert.equal(report.reasonCode, "PRIVACY_STAGED_CLEAN");
  assert.equal(report.stagedPaths, 0);
  assert.equal(report.scannedEntries, 0);
  assert.equal(report.stagedBytes, 0);
  assert.deepEqual(report.objects, []);
  assert.deepEqual(report.findings, []);
  assert.equal(report.scope, "staged-index-increment-only");
  assert.equal(report.historicalScan, "preserved-by-pnpm-verify:privacy");
  assert.equal(report.repositoryRoot, root);
});
