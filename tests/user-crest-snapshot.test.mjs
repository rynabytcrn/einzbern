// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-529 GWT3 (TCRN-CROSS-SUB-482): a read of the user crest takes no lock. It answers
// from this device's snapshot of the crest (snapshot.json in the crest's cache directory,
// einzbern.user-crest-snapshot.v1), which a write replaces under the user crest lock, by an atomic
// rename, once its event is down. While another process holds the lock, recall and the reads answer
// from the last snapshot at once; a read after a write sees the new card; a snapshot that is gone or
// behind the crest's streams is rebuilt by the next read when the lock is free.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { USER_CREST_SNAPSHOT_SCHEMA_VERSION, userCrestLockPath, userCrestSnapshotPath } from "../dist/build/packages/core/src/device-home.js";
import { createProject, initializeKnowledgeStore, initializeLibrary } from "../dist/build/packages/core/src/index.js";
import { resetRecallCache } from "../dist/build/packages/core/src/recall.js";
import { cliPath, instant } from "./helpers/workspace-fixture.mjs";

const fileLockModule = new URL("../dist/build/packages/core/src/file-lock.js", import.meta.url).href;
const at = instant(30);

// A device directory of this test's own, with a library to write user cards from.
async function device(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-user-crest-snapshot-")));
  const previous = process.env.EINZBERN_HOME;
  const home = join(base, "device");
  process.env.EINZBERN_HOME = home;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    resetRecallCache();
    await rm(base, { recursive: true, force: true });
  });
  const workspace = join(base, "library");
  await initializeLibrary({ root: workspace, createdAt: instant(0) });
  await createProject(workspace, { occurredAt: instant(1), externalKey: "SNAPSHOT-PROJECT", name: "snapshot" });
  await initializeKnowledgeStore(workspace, { disposableAcknowledged: true });
  return { home, workspace };
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function capture(workspace, key, subject) {
  return cli(["knowledge-capture", "--workspace", workspace, "--at", instant(2), "--scope", "user", "--external-key", key,
    "--subject", subject, "--summary", `${subject}.`, "--snippet", `${subject} snippet.`, "--tags", "snapshot",
    "--accountable-owner-id", "owner:agent-session", "--body", `${subject}: the body of the card.`]);
}

const listUser = (workspace) => cli(["knowledge-list", "--workspace", workspace, "--at", at, "--scope", "user"]);
const subjectsOf = (answer) => JSON.stringify(answer);

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

// Another process that holds the user crest lock for `milliseconds`, as a writer of the crest does.
async function holdUserCrestLock(context, home, milliseconds) {
  const script = `import { acquireFileLock } from ${JSON.stringify(fileLockModule)};
const lock = await acquireFileLock(${JSON.stringify(userCrestLockPath(home))}, { command: "einzbern knowledge-capture" });
process.stdout.write("held\\n");
await new Promise((resolve) => setTimeout(resolve, ${milliseconds}));
await lock.release();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, EINZBERN_HOME: home } });
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  await once(child.stdout, "data");
  return { heldAt: Date.now(), released: exited };
}

function cliProcess(args, home) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, EINZBERN_HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("529 GWT3: while another process holds the user crest lock, recall and the reads answer from the last snapshot without waiting", async (context) => {
  const { home, workspace } = await device(context);
  await capture(workspace, "SNAP-KOALA", "Koala eucalyptus rotation");
  const snapshot = JSON.parse(await readFile(userCrestSnapshotPath(home), "utf8"));
  assert.equal(snapshot.schemaVersion, USER_CREST_SNAPSHOT_SCHEMA_VERSION, "the write left a snapshot of the crest");
  assert.equal(snapshot.units.length, 1);

  const holder = await holdUserCrestLock(context, home, 3000);
  const listed = await timed(() => listUser(workspace));
  const recalled = await timed(() => cli(["recall", "--workspace", workspace, "--at", at, "--query", "koala eucalyptus"]));
  const elsewhere = await timed(() => cliProcess(["recall", "--workspace", workspace, "--at", at, "--query", "koala eucalyptus"], home));
  assert.ok(Date.now() - holder.heldAt < 3000, "every read ran while the lock was held");
  assert.ok(listed.elapsed < 1000, `knowledge-list answered in ${listed.elapsed} ms`);
  assert.ok(recalled.elapsed < 1000, `recall answered in ${recalled.elapsed} ms`);
  assert.ok(elsewhere.elapsed < 2500, `recall in another process answered in ${elsewhere.elapsed} ms`);
  assert.equal(listed.result.total, 1);
  assert.match(subjectsOf(listed.result), /Koala eucalyptus rotation/u);
  assert.match(subjectsOf(recalled.result), /Koala eucalyptus rotation/u, "recall finds the card in the snapshot");
  assert.equal(elsewhere.result.status, 0, elsewhere.result.stderr);
  assert.match(elsewhere.result.stdout, /Koala eucalyptus rotation/u);
  await holder.released;
});

test("529 GWT3: a read after a write sees the new card, and a write takes the lock and gives it back", async (context) => {
  const { home, workspace } = await device(context);
  await capture(workspace, "SNAP-WOMBAT", "Wombat burrow survey");
  assert.equal((await listUser(workspace)).total, 1);
  await capture(workspace, "SNAP-PLATYPUS", "Platypus river census");
  const listed = await listUser(workspace);
  assert.equal(listed.total, 2, "the second write replaced the snapshot");
  assert.match(subjectsOf(listed), /Platypus river census/u);
  const snapshot = JSON.parse(await readFile(userCrestSnapshotPath(home), "utf8"));
  assert.equal(snapshot.units.length, 2);
  await assert.rejects(stat(userCrestLockPath(home)), { code: "ENOENT" }, "the user crest lock is given back");
  // The body is read from the crest through the snapshot's record of it.
  const id = listed.records.find((record) => record.subject === "Platypus river census").id;
  const body = await cli(["knowledge-body", "--workspace", workspace, "--id", id, "--at", at, "--scope", "user"]);
  assert.match(JSON.stringify(body), /Platypus river census: the body of the card\./u);
});

test("529 GWT3: a snapshot that is gone or behind the crest's streams is rebuilt by the next read, and one gone while a writer holds the lock waits for nothing", async (context) => {
  const { home, workspace } = await device(context);
  await capture(workspace, "SNAP-QUOKKA", "Quokka island count");
  const path = userCrestSnapshotPath(home);

  await rm(path);
  const holder = await holdUserCrestLock(context, home, 2000);
  const meanwhile = await timed(() => listUser(workspace));
  assert.ok(meanwhile.elapsed < 1000, `the read answered in ${meanwhile.elapsed} ms without a snapshot`);
  assert.equal(meanwhile.result.total, 1, "it read the crest as it stands");
  await assert.rejects(stat(path), { code: "ENOENT" }, "and left the snapshot to the lock's holder");
  await holder.released;

  assert.equal((await listUser(workspace)).total, 1);
  const rebuilt = JSON.parse(await readFile(path, "utf8"));
  assert.equal(rebuilt.schemaVersion, USER_CREST_SNAPSHOT_SCHEMA_VERSION, "the read rebuilt the snapshot");

  // A snapshot of a crest folder that has since changed (as when another device's event arrives) is not
  // answered from: here, one that records another folder state and no card.
  await writeFile(path, `${JSON.stringify({ ...rebuilt, fingerprint: "0".repeat(64), eventHeads: [], units: [], index: { ...rebuilt.index, records: [] } })}\n`);
  assert.equal((await listUser(workspace)).total, 1, "the stale snapshot was rebuilt, not answered from");
  const again = JSON.parse(await readFile(path, "utf8"));
  assert.equal(again.fingerprint, rebuilt.fingerprint);
  assert.deepEqual(again.eventHeads, rebuilt.eventHeads);

  // A crest folder that changes after the snapshot -- here a file another writer left in a stream --
  // makes the next read scan the crest, which names what is wrong, rather than answer from the snapshot.
  const deviceId = JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
  await writeFile(join(home, "crest", "events", deviceId, "stray.txt"), "not a crest file");
  await assert.rejects(listUser(workspace), (error) => error?.reasonCode === "KNOWLEDGE_PARTIAL_STATE");
  await rm(join(home, "crest", "events", deviceId, "stray.txt"));
  assert.equal((await listUser(workspace)).total, 1);

  // An unreadable snapshot is rebuilt the same way.
  await writeFile(path, "{not json");
  assert.equal((await listUser(workspace)).total, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, USER_CREST_SNAPSHOT_SCHEMA_VERSION);
});
