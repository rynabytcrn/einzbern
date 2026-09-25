// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 R5, AC3 (mechanism): a file replaced atomically is read whole or not
// at all; a rename that Windows refuses for a moment is retried.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ATOMIC_TEMPORARY_PREFIX, isAtomicTemporaryName, writeFileAtomic } from "../dist/build/packages/core/src/index.js";

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "einzbern-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// What a reader of a manifest directory does: every entry except atomic temporaries.
const visible = async (directory) => (await readdir(directory)).filter((name) => !isAtomicTemporaryName(name)).sort();

function failingRename(codes) {
  const calls = [];
  return {
    calls,
    async rename(from, to) {
      calls.push(to);
      const code = codes.shift();
      if (code !== undefined) throw Object.assign(new Error(`simulated ${code}`), { code });
      await rename(from, to);
    },
  };
}

test("469-R5: a write replaces the whole file and leaves no temporary behind", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "manifest.json");
  await writeFileAtomic(target, "{\"version\":1}\n");
  await writeFileAtomic(target, Buffer.from("{\"version\":2}\n", "utf8"));
  assert.equal(await readFile(target, "utf8"), "{\"version\":2}\n");
  assert.deepEqual(await readdir(directory), ["manifest.json"]);
});

test("469-AC3: a crash after the temporary is written and before the rename leaves the previous version readable", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "manifest.json");
  await writeFileAtomic(target, "previous\n");
  await assert.rejects(
    writeFileAtomic(target, "next\n", { crashAt: "after-temporary-write" }),
    (error) => error?.reasonCode === "ATOMIC_WRITE_INTERRUPTED",
  );
  assert.equal(await readFile(target, "utf8"), "previous\n", "the reader still gets the whole previous file");
  const entries = await readdir(directory);
  const temporaries = entries.filter((name) => name.startsWith(ATOMIC_TEMPORARY_PREFIX));
  assert.equal(temporaries.length, 1, "the dead writer's temporary stays, as a real crash would leave it");
  assert.equal(await readFile(join(directory, temporaries[0]), "utf8"), "next\n");
  assert.deepEqual(await visible(directory), ["manifest.json"], "readers skip the temporary");
  // The next writer is not blocked by the leftover and replaces the file normally.
  await writeFileAtomic(target, "after\n");
  assert.equal(await readFile(target, "utf8"), "after\n");
});

test("469-R5: EBUSY twice, then success: the rename is retried with backoff", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "manifest.json");
  await writeFile(target, "old\n");
  const seam = failingRename(["EBUSY", "EBUSY"]);
  const waits = [];
  await writeFileAtomic(target, "new\n", { rename: seam.rename, sleep: async (ms) => { waits.push(ms); }, retryDelayMs: 5 });
  assert.equal(seam.calls.length, 3);
  assert.deepEqual(waits, [5, 10], "the backoff doubles");
  assert.equal(await readFile(target, "utf8"), "new\n");
  assert.deepEqual(await readdir(directory), ["manifest.json"]);
});

test("469-R5: EPERM and EACCES are retried the same way", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "manifest.json");
  const seam = failingRename(["EPERM", "EACCES"]);
  await writeFileAtomic(target, "value\n", { rename: seam.rename, sleep: async () => undefined });
  assert.equal(seam.calls.length, 3);
  assert.equal(await readFile(target, "utf8"), "value\n");
});

test("469-R5: running out of retries reports a reason code, removes this attempt's temporary and keeps the old file", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "manifest.json");
  await writeFile(target, "old\n");
  const seam = failingRename(["EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
  await assert.rejects(
    writeFileAtomic(target, "new\n", { rename: seam.rename, sleep: async () => undefined, retries: 3 }),
    (error) => error?.reasonCode === "ATOMIC_WRITE_RENAME_FAILED" && error.details.code === "EBUSY" && error.details.attempts === "4",
  );
  assert.equal(seam.calls.length, 4);
  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.deepEqual(await readdir(directory), ["manifest.json"]);
});

test("469-R5: a failure that is not transient is not retried", async (t) => {
  const directory = await scratch(t);
  const target = join(directory, "manifest.json");
  const seam = failingRename(["ENOSPC"]);
  await assert.rejects(
    writeFileAtomic(target, "new\n", { rename: seam.rename, sleep: async () => assert.fail("no wait for a permanent failure") }),
    (error) => error?.reasonCode === "ATOMIC_WRITE_RENAME_FAILED" && error.details.code === "ENOSPC" && error.details.attempts === "1",
  );
  assert.deepEqual(await readdir(directory), []);
});
