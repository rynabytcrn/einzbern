// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-538 GWT4, GWT7 (TCRN-CROSS-SUB-500): artifact-put holds the library write lock for
// its manifest alone, and snapshot-manifest reads without it. While another process holds the lock
// for 3 seconds, artifact-put copies its blob at once and records it once the lock is free, and
// snapshot-manifest answers at once. A put whose library moved between its read and the lock reads
// again without copying again, and an append in the middle of a snapshot's read sends the read back,
// so the manifest is of one consistent stream head. Everything here is temporary: a library, a file
// to put and a device directory.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  DIRECTORY,
  createSnapshotManifest,
  initializeLibrary,
  listArtifacts,
  materializeWorkspace,
  putArtifact,
  verifySnapshotManifest,
} from "../dist/build/packages/core/src/index.js";
import { setVariable } from "../dist/build/packages/core/src/variables.js";

const workspaceModule = new URL("../dist/build/packages/core/src/workspace.js", import.meta.url).href;
const variablesModule = new URL("../dist/build/packages/core/src/variables.js", import.meta.url).href;

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 9, 14, 11, 0, second)).toISOString().replace(".000Z", "Z");
};

const CONTENT = Buffer.from("A build log the gate kept, line after line.\n".repeat(256));
const DIGEST = createHash("sha256").update(CONTENT).digest("hex");

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-artifact-snapshot-lock-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, ".ether");
  await initializeLibrary({ root, createdAt: at() });
  const source = join(base, "build.log");
  await writeFile(source, CONTENT);
  // The blob root is the library's artifacts directory unless a setting names another.
  return { base, root, source, blob: join(root, DIRECTORY.artifacts, `${DIGEST}.bin`) };
}

// Another process that takes the library's write lock, as a write verb does, and holds it until it
// reads "release" on its stdin; each other line it reads is a variable it sets while it holds the
// lock, answering "appended" once that append is in. `released` resolves, once it exited, to the
// moment the test saw it exit.
async function holdLibraryLock(context, root, { milliseconds = null } = {}) {
  const script = `import { createInterface } from "node:readline";
import { withWorkspaceWriteLock } from ${JSON.stringify(workspaceModule)};
import { setVariable } from ${JSON.stringify(variablesModule)};
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const timer = ${milliseconds === null ? "null" : `new Promise((resolve) => setTimeout(() => resolve({ value: "release", done: false }), ${milliseconds}))`};
await withWorkspaceWriteLock(${JSON.stringify(root)}, async () => {
  process.stdout.write("held\\n");
  for (;;) {
    const { value, done } = await (timer === null ? lines.next() : Promise.race([lines.next(), timer]));
    if (done || value === "release") break;
    await setVariable(${JSON.stringify(root)}, JSON.parse(value));
    process.stdout.write("appended\\n");
  }
}, { command: "einzbern work-annotate" });
process.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const released = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
    return Date.now();
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await released.catch(() => undefined);
  });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => (await output.next()).value;
  assert.equal(await next(), "held");
  return {
    heldAt: Date.now(),
    released,
    async append(variable) {
      child.stdin.write(`${JSON.stringify(variable)}\n`);
      assert.equal(await next(), "appended");
    },
    release() {
      child.stdin.write("release\n");
      return released;
    },
  };
}

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function exists(path) {
  return lstat(path).then(() => true, () => false);
}

// Poll until `path` exists, for at most `milliseconds`; the moment it was seen, or null.
async function appearance(path, milliseconds) {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    if (await exists(path)) return Date.now();
    await pause(20);
  }
  return null;
}

async function timed(operation) {
  const started = Date.now();
  const result = await operation();
  return { result, elapsed: Date.now() - started };
}

test("538 GWT4: while another process holds the library write lock for 3 seconds, artifact-put copies its blob at once and records it once the lock is free", async (context) => {
  const paths = await scratch(context);
  const holder = await holdLibraryLock(context, paths.root, { milliseconds: 3000 });
  let putAt = null;
  const putting = putArtifact(paths.root, { file: paths.source, at: at() }).then((receipt) => { putAt = Date.now(); return receipt; });
  const copiedAt = await appearance(paths.blob, 3000);
  assert.notEqual(copiedAt, null, "the blob was copied while the other process held the lock");
  assert.ok(copiedAt - holder.heldAt < 1000, `the blob was in place ${copiedAt - holder.heldAt} ms after the other process took the lock`);
  assert.equal(putAt, null, "the put waits for the lock to record the blob");
  assert.deepEqual((await listArtifacts(paths.root)).artifacts, [], "the manifest is replaced under the lock alone");
  const releasedAt = await holder.released;
  const receipt = await putting;
  assert.ok(copiedAt < releasedAt);
  assert.ok(putAt - holder.heldAt >= 2500, `recorded ${putAt - holder.heldAt} ms after the other process took the lock: once it was free`);
  assert.deepEqual([receipt.reasonCode, receipt.sha256, receipt.bytes, receipt.deduplicated, receipt.artifacts], ["ARTIFACT_PUT_COMMITTED", DIGEST, CONTENT.length, false, 1]);
  const listing = await listArtifacts(paths.root);
  assert.deepEqual(listing.artifacts.map((entry) => [entry.sha256, entry.present]), [[DIGEST, true]]);
});

test("538 GWT4: a put whose library moved between its read and the lock reads it again, and does not copy the blob again", async (context) => {
  const paths = await scratch(context);
  const holder = await holdLibraryLock(context, paths.root);
  const putting = putArtifact(paths.root, { file: paths.source, at: at() });
  assert.notEqual(await appearance(paths.blob, 3000), null, "the blob was copied while the other process held the lock");
  // Another writer appends after the put read the library, before the put has the lock.
  await holder.append({ name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  await holder.release();
  const receipt = await putting;
  assert.deepEqual([receipt.reasonCode, receipt.deduplicated, receipt.artifacts], ["ARTIFACT_PUT_COMMITTED", false, 1], "the blob it copied was indexed as copied, not found and copied again");
  assert.deepEqual((await listArtifacts(paths.root)).artifacts.map((entry) => entry.sha256), [DIGEST]);
  assert.equal((await materializeWorkspace(paths.root)).configRecords.some((record) => record.collection === "variable" && record.key === "deploy.host"), true, "the other writer's append stands");
});

test("538 GWT4: while another process holds the lock, snapshot-manifest answers at once, of the library as it stands", async (context) => {
  const paths = await scratch(context);
  await setVariable(paths.root, { name: "deploy.host", type: "string", value: "build.example.com", occurredAt: at() });
  const holder = await holdLibraryLock(context, paths.root, { milliseconds: 3000 });
  const read = await timed(() => createSnapshotManifest(paths.root));
  assert.ok(Date.now() - holder.heldAt < 3000, "the manifest was read while the lock was held");
  assert.ok(read.elapsed < 1000, `read in ${read.elapsed} ms`);
  await holder.released;
  const manifest = JSON.parse(read.result);
  const state = await materializeWorkspace(paths.root);
  assert.deepEqual([manifest.version, manifest.headEventHash], [state.version, state.headEventHash]);
  assert.equal((await verifySnapshotManifest(paths.root, read.result)).reasonCode, "SNAPSHOT_VERIFIED", "its files are the library's files");
});

test("538 GWT4: an append in the middle of a snapshot's read sends the read back, so the manifest is of one consistent stream head", async (context) => {
  const paths = await scratch(context);
  const before = await materializeWorkspace(paths.root);
  const reads = [];
  const text = await createSnapshotManifest(paths.root, {
    midReadForTest: async () => {
      reads.push(Date.now());
      // The state is read; the tree is not walked yet.
      if (reads.length === 1) await setVariable(paths.root, { name: "deploy.port", type: "number", value: "8443", occurredAt: at() });
    },
  });
  assert.equal(reads.length, 2, "the read began again once the tree moved under it");
  const after = await materializeWorkspace(paths.root);
  assert.equal(after.version, before.version + 1);
  const manifest = JSON.parse(text);
  assert.deepEqual([manifest.version, manifest.headEventHash], [after.version, after.headEventHash], "the head the manifest names is the one its files hold");
  assert.equal((await verifySnapshotManifest(paths.root, text)).reasonCode, "SNAPSHOT_VERIFIED");
  // A tree that holds still is read once.
  const still = [];
  const again = await createSnapshotManifest(paths.root, { midReadForTest: async () => { still.push(Date.now()); } });
  assert.deepEqual([still.length, again], [1, text]);
});
