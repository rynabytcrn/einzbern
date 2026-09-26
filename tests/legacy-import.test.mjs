// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R6, AC4 / STORY-466 AC3: library-import-legacy turns the frozen old-layout
// workspace into a library whose first stream is its chain, byte for byte: the same event count
// and head, each segment's bytes unchanged. A later event continues the stream in the new
// namespace while the old events keep theirs. A dry run validates the chain in memory and writes
// nothing, and a target that is not empty is refused.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { materializeWorkspace, readAllStreams } from "../dist/build/packages/core/src/index.js";
import { LEGACY_FIXTURE_EXPECTED as expected, LEGACY_FIXTURE_ROOT, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");
const AT = "2026-09-26T06:00:00Z";

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-import-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await stat(path);
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${entry.isFile() ? sha256(await readFile(path)) : "directory"}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

test("468-R6, AC4 (fixture): an import carries the old chain's events, head and segment bytes into the first stream", async (context) => {
  const base = await scratch(context);
  const { root, events } = await restoreLegacyFixture(base, "legacy");
  const oldTree = await treeDigest(root);
  const legacyState = await materializeWorkspace(root);
  const target = join(base, ".ether");
  const receipt = await cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT, "--project-name", "Legacy fixture"]);
  assert.equal(receipt.reasonCode, "LEGACY_IMPORTED");
  assert.equal(receipt.events, expected.events);
  assert.equal(receipt.headEventHash, expected.headEventHash);
  assert.equal(receipt.workspaceId, expected.workspaceId);
  assert.deepEqual(await treeDigest(root), oldTree, "the old workspace was only read");

  // The library keeps the old workspace id, and its root holds the seven entries.
  const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  assert.equal(manifest.libraryId, expected.workspaceId);
  assert.deepEqual((await readdir(target)).sort(), [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);

  // Every old segment is a stream segment with the same bytes.
  const [deviceId] = await readdir(join(target, "akasha"));
  assert.equal(deviceId, receipt.deviceId);
  const stream = join(target, "akasha", deviceId);
  const oldSegments = (await readdir(events)).filter((name) => name.endsWith(".ndjson")).sort();
  assert.equal(oldSegments.length, expected.segments);
  for (const [index, name] of oldSegments.entries()) {
    const copied = join(stream, `${(index + 1).toString(16).padStart(8, "0")}.ndjson`);
    assert.equal(sha256(await readFile(copied)), sha256(await readFile(join(LEGACY_FIXTURE_ROOT, "control/events", name))), name);
  }
  const streamManifest = JSON.parse(await readFile(join(stream, "manifest.json"), "utf8"));
  assert.deepEqual(
    [streamManifest.identityScheme, streamManifest.sequence, streamManifest.headEventHash, streamManifest.clockHighWater],
    ["legacy", expected.events, expected.headEventHash, expected.events],
  );

  // It replays to the same records, and chain-validate reads it stream by stream.
  const imported = await materializeWorkspace(target);
  assert.equal(imported.version, expected.version);
  assert.deepEqual(imported.library.streams.map((entry) => [entry.streamId, entry.headEventHash]), [[streamManifest.streamId, expected.headEventHash]]);
  assert.deepEqual(imported.work, legacyState.work);
  assert.deepEqual(imported.settings, legacyState.settings);
  assert.equal(imported.work.find((entry) => entry.id === expected.records.story.id)?.externalKey, expected.records.story.externalKey);
  const validated = await cli(["chain-validate", "--workspace", target]);
  assert.deepEqual([validated.reasonCode, validated.layout, validated.events], ["CHAIN_VALIDATED", "library", expected.events]);
  assert.equal((await cli(["status", "--workspace", target])).configProjection, "current", "the imported settings are projected");
});

test("466-AC3 (end to end): after an import, a new event continues the stream in einzbern.* and the old events stay tcrn.*", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreLegacyFixture(base, "legacy");
  const target = join(base, ".ether");
  await cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT]);
  const projectId = (await materializeWorkspace(target)).projects.find((entry) => !entry.tombstone).id;
  const receipt = await cli(["work-create", "--workspace", target, "--at", "2026-09-26T06:00:01Z", "--project-id", projectId,
    "--external-key", "IMPORTED-INITIATIVE", "--kind", "Initiative", "--title", "after-import", "--actor", "agent:importer"]);
  assert.equal(receipt.version, expected.events + 1);

  const { events } = await readAllStreams(target);
  const stored = events.map((entry) => entry.event);
  assert.equal(stored.length, expected.events + 1);
  assert.deepEqual([...new Set(stored.slice(0, -1).map((event) => event.schemaVersion))], ["tcrn.event.v1"], "old events keep the legacy namespace");
  const appended = stored.at(-1);
  assert.equal(appended.schemaVersion, "einzbern.event.v1");
  assert.equal(appended.sequence, expected.events + 1);
  assert.equal(appended.priorHash, expected.headEventHash, "the new event links onto the old head");
  assert.equal(appended.clock, expected.events + 1);
  assert.equal((await cli(["chain-validate", "--workspace", target])).reasonCode, "CHAIN_VALIDATED");
});

test("468-AC4: a dry run under the write tripwire reports the chain, writes nothing and creates no target", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreLegacyFixture(base, "legacy");
  const before = await treeDigest(base);
  const run = spawnSync(process.execPath, ["--import", tripwirePath, cliPath, "library-import-legacy", "--legacy", root, "--dry-run", "true", "--at", AT], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_TRIPWIRE_ROOT: base, EINZBERN_HOME: join(tmpdir(), "einzbern-import-unused-device") },
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual([report.reasonCode, report.dryRun, report.events, report.headEventHash, report.target],
    ["LEGACY_IMPORT_DRY_RUN", true, expected.events, expected.headEventHash, null]);
  assert.equal(report.segments.length, expected.segments);
  assert.deepEqual(await treeDigest(base), before, "nothing was written, the default target included");
  await assert.rejects(stat(join(root, ".ether")), { code: "ENOENT" });
});

test("468-R6: a target that is not empty is refused and left as it was", async (context) => {
  const base = await scratch(context);
  const { root } = await restoreLegacyFixture(base, "legacy");
  const target = join(base, "occupied");
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "mine\n");
  await assert.rejects(cli(["library-import-legacy", "--legacy", root, "--target", target, "--at", AT]), (error) => error?.reasonCode === "LIBRARY_TARGET_NOT_EMPTY");
  assert.deepEqual(await readdir(target), ["keep.txt"]);
});
