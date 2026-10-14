// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-529 GWT2 (TCRN-CROSS-SUB-480): a write given --timeout-ms that runs out of it
// waiting for the library write lock refuses with WORKSPACE_LOCKED, and the refusal names the holder:
// holderPid, holderCommand and heldSince. The lock file records the command its holder runs as an
// optional field, so it stays einzbern.file-lock.v1; the command is "einzbern <verb>", never a path.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import test from "node:test";

import {
  FILE_LOCK_SCHEMA_VERSION,
  lockPath as libraryLockPath,
  materializeWorkspace,
  withWorkspaceWriteLock,
  withWriteLockOptions,
} from "../dist/build/packages/core/src/index.js";
import { cliProcess, deviceHome, instant, workspaceFixture } from "./helpers/workspace-fixture.mjs";

const coreModule = new URL("../dist/build/packages/core/src/index.js", import.meta.url).href;

// Another process that holds the library's write lock, as a write verb does, until it is stopped.
async function holdLibraryLock(context, workspace, command) {
  const script = `import { withWorkspaceWriteLock } from ${JSON.stringify(coreModule)};
await withWorkspaceWriteLock(${JSON.stringify(workspace)}, async () => {
  process.stdout.write("held");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}, { command: ${JSON.stringify(command)} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const exit = once(child, "exit");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exit;
  };
  context.after(stop);
  await once(child.stdout, "data");
  return { pid: child.pid, stop };
}

function refusalOf(run) {
  return JSON.parse(run.stderr.trim().split("\n").at(-1));
}

function createArguments(workspace, projectId, key, extra = []) {
  return ["work-create", "--workspace", workspace, "--at", instant(5), "--project-id", projectId, "--external-key", key, "--kind", "Initiative", "--title", key, ...extra];
}

test("529 GWT2: a write that runs out of --timeout-ms names the holder's pid, command and since when, and writes nothing", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "LOCK-HOLDER" });
  const before = await materializeWorkspace(workspace);
  const holder = await holdLibraryLock(context, workspace, "einzbern work-annotate");
  const lockFile = JSON.parse(await readFile(libraryLockPath(before.metadata.workspaceId, deviceHome), "utf8"));
  assert.equal(lockFile.schemaVersion, FILE_LOCK_SCHEMA_VERSION, "the lock file stays einzbern.file-lock.v1");
  assert.equal(lockFile.command, "einzbern work-annotate", "the lock file records what its holder runs");
  const started = Date.now();
  const run = await cliProcess(createArguments(workspace, projectId, "LOCKED-OUT", ["--timeout-ms", "200"]));
  assert.ok(Date.now() - started < 15_000, "the write gives up instead of waiting for the holder");
  assert.equal(run.status, 1, run.stdout);
  const refusal = refusalOf(run);
  assert.equal(refusal.reasonCode, "WORKSPACE_LOCKED");
  assert.equal(refusal.holderPid, String(holder.pid));
  assert.equal(refusal.holderCommand, "einzbern work-annotate");
  assert.equal(refusal.heldSince, lockFile.createdAt);
  assert.doesNotMatch(refusal.holderCommand, /[\\/]/u, "the command carries no path");
  assert.doesNotMatch(refusal.holderCommand, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  await holder.stop();
  assert.equal((await materializeWorkspace(workspace)).version, before.version, "the refused write wrote nothing");
  // The holder is gone: its lock is a dead holder's, broken by the next write, which lands.
  const after = await cliProcess(createArguments(workspace, projectId, "AFTER-HOLDER", ["--timeout-ms", "5000"]));
  assert.equal(after.status, 0, after.stderr);
});

test("529 GWT2: a holder that predates the command field is named with what its lock file says", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "LOCK-LEGACY" });
  const state = await materializeWorkspace(workspace);
  const path = libraryLockPath(state.metadata.workspaceId, deviceHome);
  await mkdir(dirname(path), { recursive: true });
  // A live owner on this host (this test process) in the lock file an older engine writes.
  const createdAt = new Date().toISOString();
  await writeFile(path, `${JSON.stringify({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: process.pid, token: "a".repeat(32), hostname: hostname(), createdAt })}\n`);
  try {
    const run = await cliProcess(createArguments(workspace, projectId, "LEGACY-HOLDER", ["--timeout-ms", "0"]));
    assert.equal(run.status, 1, run.stdout);
    const refusal = refusalOf(run);
    assert.equal(refusal.reasonCode, "WORKSPACE_LOCKED");
    assert.equal(refusal.holderPid, String(process.pid));
    assert.equal(refusal.holderCommand, "unknown");
    assert.equal(refusal.heldSince, createdAt);
  } finally {
    await rm(path, { force: true });
  }
});

test("529 GWT2: --timeout-ms is an integer of at least 0, and a read verb does not take it", async (context) => {
  const { workspace, projectId } = await workspaceFixture(context, { externalKey: "LOCK-FLAG" });
  for (const value of ["-1", "soon", "1.5"]) {
    const run = await cliProcess(createArguments(workspace, projectId, "BAD-TIMEOUT", ["--timeout-ms", value]));
    assert.equal(run.status, 1);
    assert.equal(refusalOf(run).reasonCode, "CLI_ARGUMENT_MALFORMED", value);
  }
  const read = await cliProcess(["status", "--workspace", workspace, "--timeout-ms", "10"]);
  assert.equal(read.status, 1);
  assert.equal(refusalOf(read).reasonCode, "CLI_ARGUMENT_UNKNOWN");
  const free = await cliProcess(createArguments(workspace, projectId, "FREE-LOCK", ["--timeout-ms=0"]));
  assert.equal(free.status, 0, free.stderr);
});

test("529 GWT2: the lock options of a flow reach every library write lock taken within it", async (context) => {
  const { workspace } = await workspaceFixture(context, { externalKey: "LOCK-DEFAULTS" });
  const state = await materializeWorkspace(workspace);
  const path = libraryLockPath(state.metadata.workspaceId, deviceHome);
  const recorded = await withWriteLockOptions({ command: "einzbern work-create" }, () =>
    withWorkspaceWriteLock(workspace, async () => JSON.parse(await readFile(path, "utf8")).command));
  assert.equal(recorded, "einzbern work-create");
  const explicit = await withWriteLockOptions({ command: "einzbern work-create" }, () =>
    withWorkspaceWriteLock(workspace, async () => JSON.parse(await readFile(path, "utf8")).command, { command: "einzbern minutes-record" }));
  assert.equal(explicit, "einzbern minutes-record", "an explicit option wins over the flow's");
  const bare = await withWorkspaceWriteLock(workspace, async () => JSON.parse(await readFile(path, "utf8")));
  assert.equal(Object.hasOwn(bare, "command"), false, "a lock taken outside any flow records no command");
});
