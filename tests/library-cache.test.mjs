// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 R4, AC2 / STORY-468 R4: a library's views and replay snapshots are this
// device's cache, cache/<library>/ in the device directory. Deleting it changes no read; a read
// resumes from a snapshot only while the snapshot is a prefix of what the streams hold (another
// device's late, lower-clock event sends it back to genesis); a damaged cache, or one another
// engine wrote, is rebuilt, never a library error; recover rebuilds it; and nothing derived is
// ever written into the library.

import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  cachePath,
  createProject,
  createWork,
  initializeLibrary,
  materializeWorkspace,
  materializeWorkspaceFromGenesis,
  recoverWorkspace,
  setWorkspaceSetting,
  transitionWork,
} from "../dist/build/packages/core/src/index.js";
import { withWorkspacePerfInstrumentation } from "../dist/build/packages/core/src/workspace-perf-instrumentation.js";

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 3, 0, second)).toISOString().replace(".000Z", "Z");
};

// A scratch directory holding the library and the directories of the devices that write it. The
// process's device directory is put back when the test ends.
async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-cache-")));
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

/** Run `operation` as the device whose directory is `home`. */
async function as(home, operation) {
  process.env.EINZBERN_HOME = home;
  return operation();
}

async function cli(home, args) {
  process.env.EINZBERN_HOME = home;
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return output;
}

// A library with a project and `count` Initiatives written by the device at `home`, snapshotting
// every `interval` merged events. The interval is a setting, so the views include extensions.json.
async function seededLibrary(base, home, { count = 6, interval = 4 } = {}) {
  const library = join(base, ".ether");
  const initialized = await as(home, () => initializeLibrary({ root: library, createdAt: at() }));
  await as(home, () => setWorkspaceSetting(library, { key: "storage.snapshotEveryEvents", value: String(interval), occurredAt: at() }));
  const project = await as(home, () => createProject(library, { occurredAt: at(), externalKey: "CACHE-PROJECT", name: "Cache" }));
  for (let index = 0; index < count; index += 1) {
    await as(home, () => createWork(library, { occurredAt: at(), projectId: project.projects[0].id, externalKey: `CACHE-INIT-${index}`, kind: "Initiative", parentId: null }));
  }
  return { library, libraryId: initialized.metadata.workspaceId, projectId: project.projects[0].id };
}

async function snapshotHeader(home, libraryId) {
  return JSON.parse(await readFile(join(cachePath(libraryId, home), "snapshots", "snapshot.json"), "utf8"));
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

// Every file under a directory, relative to it.
async function files(root) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split("\\").join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

test("469-AC2: with cache/<library>/ deleted, a read rebuilds the views and the snapshot and work-list is byte-identical", async (context) => {
  const base = await scratch(context);
  const home = join(base, "device");
  const { library, libraryId } = await seededLibrary(base, home);
  const before = await cli(home, ["work-list", "--workspace", library]);
  const cache = cachePath(libraryId, home);
  assert.deepEqual(await files(join(cache, "views")), [".stamp.json", "STATUS.md", "extensions.json", "index.json", "readback.json"]);
  const header = await snapshotHeader(home, libraryId);
  assert.equal(header.schemaVersion, "einzbern.cache-snapshot.v1");
  assert.ok(header.version >= 4, "the replay went past the interval and left a snapshot");

  await rm(cache, { recursive: true, force: true });
  const after = await cli(home, ["work-list", "--workspace", library]);
  assert.equal(after, before, "work-list is byte-identical without the cache");
  assert.deepEqual(await files(join(cache, "views")), [".stamp.json", "STATUS.md", "extensions.json", "index.json", "readback.json"], "the views were rebuilt");
  assert.equal((await snapshotHeader(home, libraryId)).version, 8, "the snapshot was rebuilt at the head");
  assert.equal(await cli(home, ["status", "--workspace", library]), await cli(home, ["status", "--workspace", library]));
});

test("469-R4: a read resumes from the snapshot and reaches the state a replay from genesis reaches", async (context) => {
  const base = await scratch(context);
  const home = join(base, "device");
  const { library, libraryId, projectId } = await seededLibrary(base, home, { count: 6, interval: 4 });
  await as(home, () => materializeWorkspace(library));
  const snapshotVersion = (await snapshotHeader(home, libraryId)).version;
  assert.equal(snapshotVersion, 8);
  const work = await as(home, () => createWork(library, { occurredAt: at(), projectId, externalKey: "CACHE-TAIL", kind: "Initiative", parentId: null }));
  await as(home, () => transitionWork(library, { occurredAt: at(), id: work.work.find((record) => record.externalKey === "CACHE-TAIL").id, status: "ready" }));
  const { result: resumed, metrics } = await as(home, () => withWorkspacePerfInstrumentation(() => materializeWorkspace(library)));
  assert.equal(metrics.snapshotMaterialize, 1, "the read resumed from the snapshot");
  assert.equal(metrics.fullMaterialize, 0, "and did not replay from genesis");
  const genesis = await as(home, () => materializeWorkspaceFromGenesis(library));
  assert.equal(resumed.version, 10);
  assert.deepEqual(resumed, genesis, "the resumed read is the genesis replay, byte for byte");
});

test("468-R4: another device's late event with a lower clock invalidates the snapshot, and the read replays from genesis", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const laptop = join(base, "laptop");
  const library = join(base, ".ether");
  const initialized = await as(desk, () => initializeLibrary({ root: library, createdAt: at() }));
  const libraryId = initialized.metadata.workspaceId;
  // The laptop works on a copy made before the desk wrote anything, so its clocks start low.
  const apart = join(base, "apart");
  await cp(library, apart, { recursive: true });
  const laptopProject = await as(laptop, () => createProject(apart, { occurredAt: at(), externalKey: "LAPTOP-PROJECT", name: "Laptop" }));
  await as(laptop, () => createWork(apart, { occurredAt: at(), projectId: laptopProject.projects[0].id, externalKey: "LAPTOP-INIT", kind: "Initiative", parentId: null }));

  await as(desk, () => setWorkspaceSetting(library, { key: "storage.snapshotEveryEvents", value: "2", occurredAt: at() }));
  const deskProject = await as(desk, () => createProject(library, { occurredAt: at(), externalKey: "DESK-PROJECT", name: "Desk" }));
  for (let index = 0; index < 3; index += 1) {
    await as(desk, () => createWork(library, { occurredAt: at(), projectId: deskProject.projects[0].id, externalKey: `DESK-INIT-${index}`, kind: "Initiative", parentId: null }));
  }
  await as(desk, () => materializeWorkspace(library));
  // Snapshots are written by replays two or more events past the last one: the write at version 4
  // read the library at version 4.
  const before = await snapshotHeader(desk, libraryId);
  assert.equal(before.version, 4);
  assert.equal(before.maxClock, 4);

  // The laptop's stream arrives: its two events carry clocks 1 and 2, below the snapshot's.
  const [laptopDevice] = await readdir(join(apart, "akasha"));
  await cp(join(apart, "akasha", laptopDevice), join(library, "akasha", laptopDevice), { recursive: true });
  const { result: merged, metrics } = await as(desk, () => withWorkspacePerfInstrumentation(() => materializeWorkspace(library)));
  assert.equal(metrics.snapshotMaterialize, 0, "the snapshot no longer describes a prefix of the library");
  assert.equal(metrics.fullMaterialize, 1, "so the read replays from genesis");
  assert.deepEqual(merged, await as(desk, () => materializeWorkspaceFromGenesis(library)));
  assert.equal(merged.version, 7);
  assert.deepEqual(merged.work.map((record) => record.externalKey).sort(), ["DESK-INIT-0", "DESK-INIT-1", "DESK-INIT-2", "LAPTOP-INIT"]);
  // The laptop's events sort among the four the old snapshot covered (by clock, then device id),
  // which is where a resumed replay could never put them.
  const positions = merged.events.flatMap((event, index) => (event.deviceId === laptopDevice ? [index] : []));
  assert.ok(positions.length === 2 && positions.every((index) => index < before.version), JSON.stringify(positions));
  const after = await snapshotHeader(desk, libraryId);
  assert.equal(after.version, 7, "a new snapshot covers both streams");
  assert.deepEqual(after.streams.map((stream) => stream.deviceId).sort(), [laptopDevice, (await readdir(join(library, "akasha"))).find((name) => name !== laptopDevice)].sort());
});

test("469-R4: a damaged cache, or one another engine wrote, is rebuilt and the read is unchanged", async (context) => {
  const base = await scratch(context);
  const home = join(base, "device");
  const { library, libraryId } = await seededLibrary(base, home);
  const expected = await as(home, () => materializeWorkspaceFromGenesis(library));
  const cache = cachePath(libraryId, home);
  const headerPath = join(cache, "snapshots", "snapshot.json");

  // A snapshot header from another engine version is not read, and the next due replay replaces it.
  const header = JSON.parse(await readFile(headerPath, "utf8"));
  await writeFile(headerPath, `${JSON.stringify({ ...header, engineVersion: "0.0.1" })}\n`);
  const { result: foreign, metrics: foreignMetrics } = await as(home, () => withWorkspacePerfInstrumentation(() => materializeWorkspace(library)));
  assert.equal(foreignMetrics.snapshotMaterialize, 0);
  assert.deepEqual(foreign, expected);

  // Damaged files: a header that is not JSON, a state that does not hash as its header says, views
  // that are not what a stamp would describe. None is a library error.
  await writeFile(headerPath, "{not json");
  await writeFile(join(cache, "views", ".stamp.json"), "{not json");
  await writeFile(join(cache, "views", "STATUS.md"), "stale");
  assert.deepEqual(await as(home, () => materializeWorkspace(library)), expected);
  assert.notEqual(await readFile(join(cache, "views", "STATUS.md"), "utf8"), "stale", "the views were projected again");
  const rebuilt = await snapshotHeader(home, libraryId);
  const stateFile = join(cache, "snapshots", `${rebuilt.stateDigest}.json`);
  await writeFile(stateFile, `${(await readFile(stateFile, "utf8")).replace("CACHE-INIT-0", "CACHE-INIT-X")}`);
  const { result: tampered, metrics } = await as(home, () => withWorkspacePerfInstrumentation(() => materializeWorkspace(library)));
  assert.equal(metrics.snapshotMaterialize, 0, "a state that does not hash as recorded is not used");
  assert.deepEqual(tampered, expected);
});

test("469-R4: recover rebuilds the device cache from genesis and writes nothing into the library", async (context) => {
  const base = await scratch(context);
  const home = join(base, "device");
  const { library, libraryId } = await seededLibrary(base, home, { count: 1, interval: 512 });
  const cache = cachePath(libraryId, home);
  await rm(cache, { recursive: true, force: true });
  const libraryBefore = await files(library);
  const receipt = JSON.parse(await cli(home, ["recover", "--workspace", library, "--at", at()]));
  assert.equal(receipt.version, 3);
  assert.deepEqual(await files(join(cache, "views")), [".stamp.json", "STATUS.md", "extensions.json", "index.json", "readback.json"]);
  assert.equal((await snapshotHeader(home, libraryId)).version, 3, "recover writes a snapshot below the interval too");
  assert.deepEqual(await files(library), libraryBefore, "recover only reads the library");
});

test("469-R4, 468-R4: nothing derived is written into the library, whatever reads and writes ran", async (context) => {
  const base = await scratch(context);
  const home = join(base, "device");
  const { library, libraryId } = await seededLibrary(base, home, { count: 5, interval: 2 });
  await cli(home, ["work-list", "--workspace", library]);
  await cli(home, ["status", "--workspace", library]);
  await cli(home, ["chain-validate", "--workspace", library]);
  await cli(home, ["recover", "--workspace", library, "--at", at()]);
  const [deviceId] = await readdir(join(library, "akasha"));
  const found = await files(library);
  // config/project.json is the projection of the project-level settings (the interval is one,
  // TCRN-CROSS-STORY-469 R2), not derived replay state.
  assert.deepEqual(found.filter((path) => !path.startsWith(`akasha/${deviceId}/`)), [".gitignore", "README.md", "config/project.json", "manifest.json"], "the library root holds its own files only");
  assert.deepEqual(found.filter((path) => path.startsWith(`akasha/${deviceId}/`)).map((path) => path.slice(`akasha/${deviceId}/`.length)), ["00000001.ndjson", "manifest.json"], "a stream holds its segments and its manifest only");
  assert.equal(found.some((path) => /(STATUS\.md|index\.json|readback\.json|extensions\.json|snapshot|\.idx)$/u.test(path)), false);
  assert.ok(await exists(join(cachePath(libraryId, home), "snapshots", "snapshot.json")), "the derived state is in the device cache");
});
