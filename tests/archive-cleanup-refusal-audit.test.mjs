// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { APPROVED_ARCHIVE_DELETIONS, LATEST_CHAIN_SNAPSHOT, applyArchiveCleanup, archiveBaseline } from "../scripts/archive-cleanup.mjs";

for (const survivor of ["missing", "directory"]) {
  test(`cleanup refuses a ${survivor} retained snapshot before removing any fixture entry`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "einzbern-cleanup-refusal-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    for (const name of APPROVED_ARCHIVE_DELETIONS) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "sentinel.txt"), "disposable fixture");
    }
    const snapshots = join(root, "chain-snapshots");
    await mkdir(snapshots);
    await writeFile(join(snapshots, "older.tar.gz"), "disposable snapshot");
    if (survivor === "directory") await mkdir(join(snapshots, LATEST_CHAIN_SNAPSHOT));
    const before = await archiveBaseline(root);
    await assert.rejects(applyArchiveCleanup(root, before), /ARCHIVE_RETAINED_SNAPSHOT_INVALID/u);
    assert.deepEqual(await archiveBaseline(root), before);
  });
}
