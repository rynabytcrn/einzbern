// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-467 R2 (TCRN-CROSS-MIN-227 D3): release trust is the install-tree digest.
// The signed-manifest and trust root cases this file carried retired with that code; what
// is proved here is the one question left -- are the installed bytes the published bytes --
// through the core module and the einzbern-release-verify entry.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  INSTALL_TREE_DIGEST_VERSION,
  InstallTreeError,
  computeInstallTreeDigest,
  verifyInstallTree,
} from "../dist/build/packages/core/src/index.js";
import { repositoryRoot } from "../scripts/lib/files.mjs";

const verifier = resolve(repositoryRoot, "scripts/verify-release-trust.mjs");

async function treeFixture(context, files) {
  const root = await mkdtemp(join(tmpdir(), "einzbern-install-tree-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  return root;
}

const releaseFiles = () => ({
  "package.json": "{\n  \"name\": \"einzbern\"\n}\n",
  "scripts/einzbern.mjs": "#!/usr/bin/env node\nconsole.log(\"einzbern\");\n",
  "dist/build/index.js": "export {};\n",
  "assets/logo.bin": Buffer.from([0, 1, 2, 13, 10, 255]),
});

function runVerifier(argv) {
  return spawnSync(process.execPath, [verifier, ...argv], { encoding: "utf8" });
}

test("an install tree is admitted when its digest equals the stated one", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  const digest = await computeInstallTreeDigest(root);
  assert.equal(digest.schemaVersion, INSTALL_TREE_DIGEST_VERSION);
  assert.match(digest.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(digest.entries.map((entry) => entry.path), ["assets/logo.bin", "dist/build/index.js", "package.json", "scripts/einzbern.mjs"]);
  const verified = await verifyInstallTree(root, digest.sha256);
  assert.deepEqual([verified.ok, verified.reasonCode, verified.files], [true, "INSTALL_TREE_VERIFIED", 4]);

  const admitted = runVerifier(["--tree", root, "--sha256", digest.sha256]);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stderr, "");
  const receipt = JSON.parse(admitted.stdout);
  assert.deepEqual([receipt.admitted, receipt.reasonCode, receipt.actual], [true, "INSTALL_TREE_VERIFIED", digest.sha256]);
});

test("one changed byte refuses the tree and names both digests", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  const stated = (await computeInstallTreeDigest(root)).sha256;
  await writeFile(join(root, "dist/build/index.js"), "export {};\n//\n");
  const refused = await verifyInstallTree(root, stated);
  assert.equal(refused.ok, false);
  assert.equal(refused.reasonCode, "INSTALL_TREE_DIGEST_MISMATCH");
  assert.equal(refused.expected, stated);
  assert.notEqual(refused.actual, stated);

  const cli = runVerifier(["--tree", root, "--sha256", stated]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  const receipt = JSON.parse(cli.stderr);
  assert.deepEqual([receipt.admitted, receipt.reasonCode], [false, "INSTALL_TREE_DIGEST_MISMATCH"]);
});

test("a symbolic link or other non-regular file in the tree is refused, never followed", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  const outside = await treeFixture(context, { "secret.txt": "outside the tree\n" });
  await symlink(join(outside, "secret.txt"), join(root, "scripts", "linked.txt"));
  await assert.rejects(() => computeInstallTreeDigest(root), (error) => error instanceof InstallTreeError && error.reasonCode === "INSTALL_TREE_ENTRY_NOT_REGULAR");
  const cli = runVerifier(["--tree", root, "--sha256", "0".repeat(64)]);
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stderr).reasonCode, "INSTALL_TREE_ENTRY_NOT_REGULAR");
});

test("CRLF and LF text digest the same, and a binary file is measured as it is", async (context) => {
  const lf = await treeFixture(context, { "a.txt": "one\ntwo\n", "b.bin": Buffer.from([0, 13, 10]) });
  const crlf = await treeFixture(context, { "a.txt": "one\r\ntwo\r\n", "b.bin": Buffer.from([0, 13, 10]) });
  const binaryLf = await treeFixture(context, { "a.txt": "one\ntwo\n", "b.bin": Buffer.from([0, 10]) });
  const lfDigest = await computeInstallTreeDigest(lf);
  assert.equal((await computeInstallTreeDigest(crlf)).sha256, lfDigest.sha256, "a text file's line endings do not move the digest");
  assert.equal(lfDigest.entries.find((entry) => entry.path === "a.txt").size, 8);
  assert.notEqual((await computeInstallTreeDigest(binaryLf)).sha256, lfDigest.sha256, "a binary file's CRLF is part of its bytes");
});

test("a malformed stated digest and a missing tree are refused with their own reasons", async (context) => {
  const root = await treeFixture(context, releaseFiles());
  await assert.rejects(() => verifyInstallTree(root, "ABC"), (error) => error.reasonCode === "INSTALL_TREE_DIGEST_INVALID");
  await assert.rejects(() => computeInstallTreeDigest(join(root, "absent")), (error) => error.reasonCode === "INSTALL_TREE_NOT_DIRECTORY");
});

test("the verifier rejects missing, duplicate and unknown arguments", () => {
  for (const [argv, reasonCode] of [
    [[], "RELEASE_VERIFY_ARGUMENTS_REQUIRED"],
    [["--tree", "/x"], "RELEASE_VERIFY_ARGUMENTS_REQUIRED"],
    [["--tree", "/x", "--tree", "/y", "--sha256", "0".repeat(64)], "RELEASE_VERIFY_ARGUMENTS_INVALID"],
    [["--tree", "/x", "--sha256", "0".repeat(64), "--bundle", "/z"], "RELEASE_VERIFY_ARGUMENT_UNKNOWN"],
    [["--tree"], "RELEASE_VERIFY_ARGUMENTS_INVALID"],
  ]) {
    const result = runVerifier(argv);
    assert.equal(result.status, 1, argv.join(" "));
    assert.equal(JSON.parse(result.stderr).reasonCode, reasonCode, argv.join(" "));
  }
});
