// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-466 AC1, R2 / TCRN-CROSS-STORY-467 R4, AC3 (old layout): the frozen
// old-layout workspace is read without a single write, chain-validate replays it from
// genesis to the recorded head, and a rewritten event is named by its sequence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  LEGACY_CONTROL_DIRECTORY,
  findLegacyChainBreak,
  openLegacyWorkspace,
  replayLegacyWorkspace,
  validateLegacyChain,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import { LEGACY_FIXTURE_EXPECTED, restoreLegacyFixture } from "./helpers/legacy-fixture.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");
const expected = LEGACY_FIXTURE_EXPECTED;

/** Restore the fixture into a fresh directory in the layout the old engine wrote. */
async function restoreFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-legacy-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const { root, events } = await restoreLegacyFixture(base);
  return { base, root, events };
}

/** Relative path, size, mtime and sha256 of every entry under a directory. */
async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await stat(path);
      const digest = entry.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "directory";
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${digest}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function underTripwire(root, args) {
  return spawnSync(process.execPath, ["--import", tripwirePath, ...args], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_TRIPWIRE_ROOT: root },
  });
}

/** Rewrite the event at one sequence through a function of its parsed record. */
async function rewriteEvent(events, sequence, change) {
  for (const name of (await readdir(events)).filter((entry) => entry.endsWith(".ndjson")).sort()) {
    const lines = (await readFile(join(events, name), "utf8")).split("\n");
    const index = lines.findIndex((line) => line !== "" && JSON.parse(line).sequence === sequence);
    if (index === -1) continue;
    // canonicalJson ends with a newline; the segment keeps one line per event.
    lines[index] = canonicalJson(change(JSON.parse(lines[index]))).replace(/\n$/u, "");
    await writeFile(join(events, name), lines.join("\n"));
    return;
  }
  throw new Error(`no event at sequence ${sequence}`);
}

test("466-AC1 (fixture): chain-validate replays the old layout from genesis to the recorded head", async (context) => {
  const { root } = await restoreFixture(context);
  const result = await cli(["chain-validate", "--workspace", root]);
  assert.equal(result.reasonCode, "CHAIN_VALIDATED");
  assert.equal(result.layout, "legacy");
  assert.equal(result.workspaceId, expected.workspaceId);
  assert.equal(result.events, expected.events);
  assert.equal(result.version, expected.version);
  assert.equal(result.headEventHash, expected.headEventHash);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].events, expected.events);
  assert.equal(result.streams[0].headEventHash, expected.headEventHash);
});

test("466-R2: every fixture event stays in the tcrn.* namespace and replays through the engine reducer", async (context) => {
  const { root } = await restoreFixture(context);
  const workspace = await openLegacyWorkspace(root);
  assert.deepEqual([...new Set(workspace.events.map((event) => event.schemaVersion))], ["tcrn.event.v1"]);
  assert.equal(workspace.segments.length, expected.segments);
  const operations = {};
  for (const event of workspace.events) operations[event.payload.operation] = (operations[event.payload.operation] ?? 0) + 1;
  assert.deepEqual(operations, expected.operations);
  const report = validateLegacyChain(workspace);
  assert.equal(report.headEventHash, expected.headEventHash);
  const state = replayLegacyWorkspace(workspace);
  assert.equal(state.version, expected.version);
  assert.equal(state.headEventHash, expected.headEventHash);
  assert.equal(state.projects.filter((entry) => !entry.tombstone).length, expected.projects);
  assert.equal(state.work.filter((entry) => !entry.tombstone).length, expected.work);
  const story = state.work.find((entry) => entry.id === expected.records.story.id);
  assert.equal(story.externalKey, expected.records.story.externalKey);
  assert.equal(story.status, expected.records.story.status);
});

test("466-AC1 (fixture): chain-validate under the write tripwire exits 0 and leaves the tree byte-identical", async (context) => {
  const { root } = await restoreFixture(context);
  const before = await treeDigest(root);
  const run = underTripwire(root, [cliPath, "chain-validate", "--workspace", root]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.reasonCode, "CHAIN_VALIDATED");
  assert.equal(result.headEventHash, expected.headEventHash);
  assert.deepEqual(await treeDigest(root), before);
});

test("the tripwire refuses every write family inside its root and lets reads and outside writes through", async (context) => {
  const { base, root } = await restoreFixture(context);
  const outside = join(base, "outside.txt");
  const probe = `
    import fs from "node:fs";
    import { writeFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
    import { writeFile, mkdir, rename, rm, appendFile, copyFile, open } from "node:fs/promises";
    const root = ${JSON.stringify(root)};
    const outcomes = {};
    const attempt = async (name, run) => {
      try { await run(); outcomes[name] = "allowed"; } catch (error) { outcomes[name] = error.code ?? String(error); }
    };
    await attempt("writeFileSync", () => writeFileSync(root + "/a.txt", "x"));
    await attempt("fs.writeFileSync", () => fs.writeFileSync(root + "/b.txt", "x"));
    await attempt("mkdirSync", () => mkdirSync(root + "/dir"));
    await attempt("openSync-w", () => openSync(root + "/c.txt", "w"));
    await attempt("promises.writeFile", () => writeFile(root + "/d.txt", "x"));
    await attempt("promises.mkdir", () => mkdir(root + "/dir2"));
    await attempt("promises.rename", () => rename(root + "/${LEGACY_CONTROL_DIRECTORY}/workspace.json", root + "/moved.json"));
    await attempt("promises.rm", () => rm(root + "/${LEGACY_CONTROL_DIRECTORY}", { recursive: true }));
    await attempt("promises.appendFile", () => appendFile(root + "/e.txt", "x"));
    await attempt("promises.copyFile", () => copyFile(root + "/${LEGACY_CONTROL_DIRECTORY}/workspace.json", root + "/copy.json"));
    await attempt("promises.open-a", () => open(root + "/f.txt", "a"));
    await attempt("createWriteStream", () => fs.createWriteStream(root + "/g.txt"));
    await attempt("readFileSync", () => readFileSync(root + "/${LEGACY_CONTROL_DIRECTORY}/workspace.json"));
    await attempt("outside.writeFileSync", () => writeFileSync(${JSON.stringify(outside)}, "x"));
    process.stdout.write(JSON.stringify(outcomes));
  `;
  const before = await treeDigest(root);
  const run = underTripwire(root, ["--input-type=module", "-e", probe]);
  assert.equal(run.status, 0, run.stderr);
  const outcomes = JSON.parse(run.stdout);
  for (const [name, outcome] of Object.entries(outcomes)) {
    if (name === "readFileSync" || name === "outside.writeFileSync") assert.equal(outcome, "allowed", name);
    else assert.equal(outcome, "TRIPWIRE_WRITE_BLOCKED", name);
  }
  assert.deepEqual(await treeDigest(root), before);
});

test("467-AC3 (old layout): a payload rewritten in place is reported as a chain break at its sequence", async (context) => {
  const { root, events } = await restoreFixture(context);
  const target = Math.ceil(expected.events / 2);
  await rewriteEvent(events, target, (event) => ({ ...event, payload: { ...event.payload, operation: `${event.payload.operation}.rewritten` } }));
  const workspace = await openLegacyWorkspace(root);
  assert.deepEqual(
    (({ reasonCode, sequence, detail }) => ({ reasonCode, sequence, detail }))(findLegacyChainBreak(workspace)),
    { reasonCode: "CHAIN_PRIOR_HASH_BROKEN", sequence: target, detail: "payloadHash" },
  );
  const run = underTripwire(root, [cliPath, "chain-validate", "--workspace", root]);
  assert.equal(run.status, 1);
  const error = JSON.parse(run.stderr);
  assert.equal(error.reasonCode, "CHAIN_PRIOR_HASH_BROKEN");
  assert.equal(error.sequence, String(target));
  assert.equal(error.break, "payloadHash");
  assert.equal(error.streamId, workspace.streamId);
});

test("467-AC3 (old layout): an event re-hashed after the rewrite breaks the priorHash link of the next sequence", async (context) => {
  const { root, events } = await restoreFixture(context);
  const target = 3;
  await rewriteEvent(events, target, (event) => {
    const payload = { ...event.payload, operation: `${event.payload.operation}.rewritten` };
    const payloadHash = canonicalSha256(payload);
    const basis = { schemaVersion: event.schemaVersion, id: event.id, streamId: event.streamId, sequence: event.sequence, occurredAt: event.occurredAt, priorHash: event.priorHash, payload, payloadHash };
    return { ...basis, eventHash: canonicalSha256(basis) };
  });
  const workspace = await openLegacyWorkspace(root);
  const found = findLegacyChainBreak(workspace);
  assert.equal(found.reasonCode, "CHAIN_PRIOR_HASH_BROKEN");
  assert.equal(found.sequence, target + 1);
  assert.equal(found.detail, "priorHash");
  await assert.rejects(cli(["chain-validate", "--workspace", root]), (error) => error.reasonCode === "CHAIN_PRIOR_HASH_BROKEN" && error.details.sequence === String(target + 1));
});

test("a directory without the old control tree is not an old-layout workspace", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-legacy-empty-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  await assert.rejects(openLegacyWorkspace(base), (error) => error.reasonCode === "LEGACY_WORKSPACE_NOT_FOUND");
});
