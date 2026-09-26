// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-470 R3, AC2, AC3 (MIN-227 D19, D20): workspace-relocate moves a library to an
// empty place: the copy replays to the same heads, this device's registry points at it, and the old
// place keeps a tombstone, still reads, and refuses every write. A target that is not empty, or
// that sits inside the library, is refused with the source unchanged, and a copy that does not
// hash as its source is abandoned with nothing left behind.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { relocateLibrary } from "../dist/build/packages/core/src/index.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 9, 0, second)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-relocate-")));
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

async function refusal(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }
  throw new Error(`${args[0]} was expected to refuse`);
}

async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push(`${relative(root, path)}/`);
        await walk(path);
      } else {
        rows.push(`${relative(root, path)}|${createHash("sha256").update(await readFile(path)).digest("hex")}`);
      }
    }
  };
  await walk(root);
  return rows;
}

// A registered project whose library holds a project, a work item, a knowledge card and a setting.
async function seeded(base) {
  const project = join(base, "project");
  await mkdir(project);
  const library = join(project, ".ether");
  await cli(["init", "--workspace", library, "--at", at(), "--project", project]);
  const created = await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "RELOCATE-PROJECT", "--name", "Relocate"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", created.record.id, "--external-key", "RELOCATE-INIT", "--kind", "Initiative", "--title", "relocate"]);
  await cli(["settings-set", "--workspace", library, "--at", at(), "--key", "retrieval.tau", "--value", "3"]);
  await cli(["knowledge-init", "--workspace", library, "--acknowledge-disposable", "true"]);
  await cli(["knowledge-capture", "--workspace", library, "--at", at(), "--subject", "Relocation", "--summary", "A library moves whole",
    "--snippet", "whole", "--tags", "relocate", "--accountable-owner-id", "owner:relocate", "--body", "The library moves whole."]);
  return { project, library };
}

test("470-AC2: a library relocated to an empty place replays to the same head, the registry follows, the old place keeps a tombstone and refuses writes", async (context) => {
  const base = await scratch(context);
  const { project, library } = await seeded(base);
  const before = await cli(["status", "--workspace", library]);
  const target = join(base, "cloud", "Ether", "project");

  const report = await cli(["workspace-relocate", "--workspace", library, "--to", target, "--at", at()]);
  assert.equal(report.reasonCode, "LIBRARY_RELOCATED");
  assert.deepEqual([report.from, report.to, report.headEventHash, report.registryEntries], [library, target, before.headEventHash, 1]);
  assert.deepEqual(report.versionVector, before.versionVector);

  // The new place holds the same library and reads to the same head.
  const moved = await cli(["status", "--workspace", target]);
  assert.deepEqual([moved.headEventHash, moved.version, moved.workspaceId], [before.headEventHash, before.version, before.workspaceId]);
  assert.equal((await cli(["knowledge-validate", "--workspace", target])).reasonCode, "KNOWLEDGE_STORE_VALID");
  assert.deepEqual((await readdir(target)).sort(), [".gitignore", "README.md", "akasha", "artifacts", "config", "crest", "manifest.json"]);

  // This device's registry points at the new place.
  assert.equal((await cli(["library-resolve", "--cwd", project])).libraryPath, target);

  // The old place keeps its files and a tombstone: it reads, says where it went, and refuses writes.
  const tombstone = JSON.parse(await readFile(join(library, "TOMBSTONE.json"), "utf8"));
  assert.deepEqual([tombstone.schemaVersion, tombstone.movedTo, tombstone.libraryId], ["einzbern.tombstone.v1", target, before.workspaceId]);
  const old = await cli(["status", "--workspace", library]);
  assert.deepEqual([old.headEventHash, old.relocatedTo], [before.headEventHash, target]);
  for (const args of [
    ["project-create", "--workspace", library, "--at", at(), "--external-key", "AFTER-MOVE", "--name", "After"],
    ["settings-set", "--workspace", library, "--at", at(), "--key", "retrieval.tau", "--value", "5"],
    ["knowledge-capture", "--workspace", library, "--at", at(), "--subject", "Late", "--summary", "late", "--snippet", "late", "--tags", "late",
      "--accountable-owner-id", "owner:relocate", "--body", "late"],
  ]) {
    const error = await refusal(args);
    assert.equal(error.reasonCode, "LIBRARY_TOMBSTONED", args[0]);
    assert.equal(error.details.movedTo, target);
  }
  // Writes go to the new place, also when the library is left to the registry.
  const created = await cli(["project-create", "--workspace", target, "--at", at(), "--external-key", "AFTER-MOVE", "--name", "After"]);
  assert.equal(created.version, before.version + 1);
});

test("470-AC3: a target that is not empty, or inside the library, is refused and the source is unchanged", async (context) => {
  const base = await scratch(context);
  const { library } = await seeded(base);
  const before = await treeDigest(library);

  const occupied = join(base, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "mine\n");
  const notEmpty = await refusal(["workspace-relocate", "--workspace", library, "--to", occupied, "--at", at()]);
  assert.equal(notEmpty.reasonCode, "RELOCATE_TARGET_NOT_EMPTY");
  assert.deepEqual(await readdir(occupied), ["keep.txt"]);

  // Inside the library, or holding it: refused before anything is looked at or created there.
  for (const target of [join(library, "crest", "moved"), join(library, "akasha"), join(base, "project"), base]) {
    const error = await refusal(["workspace-relocate", "--workspace", library, "--to", target, "--at", at()]);
    assert.equal(error.reasonCode, "RELOCATE_TARGET_INSIDE_SOURCE", target);
  }
  await assert.rejects(stat(join(library, "crest", "moved")), { code: "ENOENT" });
  assert.deepEqual(await treeDigest(library), before, "the source is unchanged");
  await assert.rejects(stat(join(library, "TOMBSTONE.json")), { code: "ENOENT" });
});

test("470-R3: a copy that does not hash as its source is abandoned, the target left as it was and the source unchanged", async (context) => {
  const base = await scratch(context);
  const { library } = await seeded(base);
  const before = await treeDigest(library);
  const target = join(base, "elsewhere", "library");
  await assert.rejects(relocateLibrary(library, target, {
    at: at(),
    copyTransformForTest: (path, bytes) => {
      if (!path.endsWith(".ndjson")) return bytes;
      const damaged = Buffer.from(bytes);
      damaged[0] = damaged[0] === 0x7b ? 0x5b : 0x7b;
      return damaged;
    },
  }), (error) => error?.reasonCode === "RELOCATE_COPY_MISMATCH");
  await assert.rejects(stat(join(base, "elsewhere")), { code: "ENOENT" }, "nothing this relocation created is left");
  assert.deepEqual(await treeDigest(library), before, "the source is unchanged");
  assert.equal((await cli(["status", "--workspace", library])).relocatedTo, undefined);

  // The same move into an existing empty directory leaves that directory empty.
  const empty = join(base, "empty");
  await mkdir(empty);
  await assert.rejects(relocateLibrary(library, empty, {
    at: at(),
    copyTransformForTest: (path, bytes) => (path === "manifest.json" ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes),
  }), (error) => error?.reasonCode === "RELOCATE_COPY_MISMATCH");
  assert.deepEqual(await readdir(empty), []);
});
