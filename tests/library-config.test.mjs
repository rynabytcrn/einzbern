// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 R2, R3, AC5 (MIN-227 D13): two layers of configuration. A project-level
// setting is an event in the library, so a second device merging the library reads the same
// value, and when two devices set one key apart the later clock wins on both. config/project.json
// projects the merged values for readers outside the engine; no read trusts it, and status says
// when it is stale. A device-level key never enters the library.

import "./helpers/device-home.mjs";
import { standInForAtelier } from "./helpers/workspace-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { cachePath, materializeWorkspace } from "../dist/build/packages/core/src/index.js";

// TCRN-CROSS-STORY-484 R4: these tests write settings through the CLI, as Atelier does.
standInForAtelier();

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 5, 0, second)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-config-")));
  const previous = process.env.EINZBERN_HOME;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return base;
}

/** Run one CLI command in-process as the device whose directory is `home`. */
async function as(home, args) {
  process.env.EINZBERN_HOME = home;
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(home, args) {
  try {
    await as(home, args);
  } catch (error) {
    return error;
  }
  throw new Error(`${args[0]} was expected to refuse`);
}

async function read(home, library) {
  process.env.EINZBERN_HOME = home;
  return materializeWorkspace(library);
}

const settingValue = (state, key) => state.settings.find((entry) => entry.key === key)?.value ?? null;

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

// Copy one device's stream directory from one copy of a library into another: what a sync
// client does when it brings the other device's writes over.
async function syncStream(from, to, deviceId) {
  await rm(join(to, "akasha", deviceId), { recursive: true, force: true });
  await cp(join(from, "akasha", deviceId), join(to, "akasha", deviceId), { recursive: true });
}

async function deviceIdOf(home) {
  return JSON.parse(await readFile(join(home, "device.json"), "utf8")).deviceId;
}

test("469-AC5: device A sets design.authority and device B, merging the same library, reads the same value", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const laptop = join(base, "laptop");
  const library = join(base, ".ether");
  await as(desk, ["init", "--workspace", library, "--at", at()]);
  const receipt = await as(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "design.authority", "--value", "https://design.example/desk"]);
  assert.equal(receipt.reasonCode, "SETTINGS_WRITE_COMMITTED");

  const merged = await read(laptop, library);
  assert.equal(settingValue(merged, "design.authority"), "https://design.example/desk");
  const catalog = await as(laptop, ["settings-catalog", "--workspace", library]);
  assert.equal(catalog.settings.find((entry) => entry.key === "design.authority").currentValue, "https://design.example/desk");
  assert.deepEqual([...new Set(catalog.settings.map((entry) => entry.layer))], ["project", "library"], "the catalog declares project and library scopes");

  // The projection shows the merged values and the version vector they were read at.
  const projection = JSON.parse(await readFile(join(library, "config", "project.json"), "utf8"));
  assert.equal(projection.schemaVersion, "einzbern.project-config.v1");
  assert.deepEqual(projection.values, { "design.authority": "https://design.example/desk" });
  assert.deepEqual(projection.versionVector, { [await deviceIdOf(desk)]: 1 });
  assert.equal((await as(laptop, ["status", "--workspace", library])).configProjection, "current");
});

test("469-R2: two devices set one key apart; after the sync both read the later clock's value", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const laptop = join(base, "laptop");
  const library = join(base, ".ether");
  await as(desk, ["init", "--workspace", library, "--at", at()]);
  const apart = join(base, "apart");
  await cp(library, apart, { recursive: true });

  // The desk writes the key first (clock 1). The laptop, working apart, writes another setting
  // first and then the same key (clock 2), without having seen the desk's write.
  await as(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "design.authority", "--value", "https://design.example/desk"]);
  await as(laptop, ["settings-set", "--workspace", apart, "--at", at(), "--key", "retrieval.tau", "--value", "3"]);
  await as(laptop, ["settings-set", "--workspace", apart, "--at", at(), "--key", "design.authority", "--value", "https://design.example/laptop"]);

  const deskId = await deviceIdOf(desk);
  const laptopId = await deviceIdOf(laptop);
  await syncStream(apart, library, laptopId);
  await syncStream(library, apart, deskId);

  const onDesk = await read(desk, library);
  const onLaptop = await read(laptop, apart);
  for (const state of [onDesk, onLaptop]) {
    assert.equal(settingValue(state, "design.authority"), "https://design.example/laptop", "the later clock wins");
    assert.equal(settingValue(state, "retrieval.tau"), "3");
    assert.deepEqual(state.library.rejectedEvents, [], "a stale revision is not a rejected event for a setting");
  }
  assert.deepEqual(onDesk.settings, onLaptop.settings, "both devices read the same configuration");
  assert.deepEqual(onDesk.library.versionVector, { [deskId]: 1, [laptopId]: 2 });

  // A later write on the desk, which has now seen the laptop's, wins in turn everywhere.
  await as(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "design.authority", "--value", "https://design.example/final"]);
  await syncStream(library, apart, deskId);
  assert.equal(settingValue(await read(laptop, apart), "design.authority"), "https://design.example/final");
});

test("469-R3: a device-level key is refused by settings-set and settings-remove and never enters the library", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const library = join(base, ".ether");
  await as(desk, ["init", "--workspace", library, "--at", at()]);
  const before = await treeDigest(library);

  for (const args of [
    ["settings-set", "--workspace", library, "--at", at(), "--key", "portal.defaultTheme", "--value", "dark"],
    ["settings-remove", "--workspace", library, "--at", at(), "--key", "portal.defaultTheme"],
  ]) {
    const error = await refusal(desk, args);
    assert.equal(error.reasonCode, "SETTINGS_KEY_DEVICE_LEVEL", args[0]);
    assert.equal(error.details?.remedy, "machine-settings-set");
  }
  const machine = await as(desk, ["machine-settings-set", "--at", at(), "--key", "portal.defaultTheme", "--value", "dark"]);
  assert.equal(machine.reasonCode, "MACHINE_SETTINGS_WRITE_COMMITTED");
  assert.ok((await stat(join(desk, "machine-settings.json"))).isFile(), "the device-level value is in the device directory");
  const machineCatalog = await as(desk, ["machine-settings-catalog"]);
  assert.deepEqual([...new Set(machineCatalog.settings.map((entry) => entry.layer))], ["device"]);
  assert.deepEqual(await treeDigest(library), before, "nothing was written into the library");
  assert.equal((await read(desk, library)).version, 0);
});

test("469-R2: reads trust the events, not config/project.json, and status reports a stale projection", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const library = join(base, ".ether");
  await as(desk, ["init", "--workspace", library, "--at", at()]);
  assert.equal((await as(desk, ["status", "--workspace", library])).configProjection, "current", "nothing set, nothing to project");
  await as(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "retrieval.tau", "--value", "3"]);
  const path = join(library, "config", "project.json");
  const projection = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify({ ...projection, values: { "retrieval.tau": "5" } })}\n`);

  assert.equal(settingValue(await read(desk, library), "retrieval.tau"), "3", "the event is the truth");
  assert.equal((await as(desk, ["status", "--workspace", library])).configProjection, "stale");
  await writeFile(path, "{not json");
  assert.equal((await as(desk, ["status", "--workspace", library])).configProjection, "invalid");

  // The next project-level write projects the merged values again.
  await as(desk, ["settings-remove", "--workspace", library, "--at", at(), "--key", "retrieval.tau"]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).values, {});
  assert.equal((await as(desk, ["status", "--workspace", library])).configProjection, "current");
});

test("469-D7: conflicting or corrupt projections cannot override merged events after cache rebuild", async (context) => {
  const base = await scratch(context);
  const desk = join(base, "desk");
  const laptop = join(base, "laptop");
  const library = join(base, ".ether");
  const apart = join(base, "laptop-copy");
  await as(desk, ["init", "--workspace", library, "--at", at()]);
  await cp(library, apart, { recursive: true });

  await as(desk, ["settings-set", "--workspace", library, "--at", at(), "--key", "design.authority", "--value", "https://design.example/desk"]);
  await as(laptop, ["settings-set", "--workspace", apart, "--at", at(), "--key", "design.authority", "--value", "https://design.example/laptop"]);
  const deskId = await deviceIdOf(desk);
  const laptopId = await deviceIdOf(laptop);
  await syncStream(apart, library, laptopId);
  await syncStream(library, apart, deskId);

  const mergedDesk = await read(desk, library);
  const mergedLaptop = await read(laptop, apart);
  assert.deepEqual(mergedDesk.settings, mergedLaptop.settings, "both devices replay the same event state");
  assert.deepEqual(mergedDesk.library.versionVector, mergedLaptop.library.versionVector);
  const mergedVersionVector = mergedDesk.library.versionVector;
  const eventValue = settingValue(mergedDesk, "design.authority");
  assert.ok(eventValue === "https://design.example/desk" || eventValue === "https://design.example/laptop");

  const deskProjectionPath = join(library, "config", "project.json");
  const laptopProjectionPath = join(apart, "config", "project.json");
  const deskProjection = JSON.parse(await readFile(deskProjectionPath, "utf8"));
  const laptopProjection = JSON.parse(await readFile(laptopProjectionPath, "utf8"));
  assert.notDeepEqual(deskProjection.values, laptopProjection.values, "the two offline projection writes conflict");
  await writeFile(deskProjectionPath, `${JSON.stringify({ ...deskProjection, versionVector: mergedVersionVector, values: { "design.authority": "https://forged.example/desk" } })}\n`);
  await writeFile(laptopProjectionPath, `${JSON.stringify({ ...laptopProjection, versionVector: mergedVersionVector, values: { "design.authority": "https://forged.example/laptop" } })}\n`);

  const libraryId = (await as(desk, ["status", "--workspace", library])).workspaceId;
  await rm(cachePath(libraryId, desk), { recursive: true, force: true });
  await rm(cachePath(libraryId, laptop), { recursive: true, force: true });
  const afterRebuildDesk = await read(desk, library);
  const afterRebuildLaptop = await read(laptop, apart);
  assert.equal(settingValue(afterRebuildDesk, "design.authority"), eventValue, "desk rebuild uses event replay");
  assert.equal(settingValue(afterRebuildLaptop, "design.authority"), eventValue, "laptop rebuild uses event replay");
  assert.deepEqual(afterRebuildDesk.settings, afterRebuildLaptop.settings, "cache rebuilds agree despite conflicting projections");
  assert.equal((await as(desk, ["status", "--workspace", library])).configProjection, "stale");
  assert.equal((await as(laptop, ["status", "--workspace", apart])).configProjection, "stale");
  assert.equal(JSON.parse(await readFile(deskProjectionPath, "utf8")).values["design.authority"], "https://forged.example/desk",
    "cache rebuild does not rewrite the projection");
  assert.equal(JSON.parse(await readFile(laptopProjectionPath, "utf8")).values["design.authority"], "https://forged.example/laptop",
    "cache rebuild does not rewrite the other projection");

  await writeFile(laptopProjectionPath, "{not json");
  await rm(cachePath(libraryId, laptop), { recursive: true, force: true });
  const afterCorruptRebuild = await read(laptop, apart);
  assert.equal(settingValue(afterCorruptRebuild, "design.authority"), eventValue, "a corrupt projection also cannot override event replay");
  assert.equal((await as(laptop, ["status", "--workspace", apart])).configProjection, "invalid");
});
