// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-471 R4 (MIN-227 D22): every device upgrades before a new format is written. The
// devices a library knows are its akasha/ directories, each stream manifest records the engine
// version that last wrote it, and status says which devices are unknown or behind; a write that
// would raise the library's format is refused with the same hint while any other device is behind.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, appendToOwnStream, createLibrary, libraryUpgradeReadiness, openLibrary } from "../dist/build/packages/core/src/index.js";
import { assertUpgradeReady, upgradeReadiness } from "../dist/build/packages/core/src/format-version.js";
import { canonicalJson, deriveStableId } from "../dist/build/packages/protocol/src/index.js";

const DESK = { deviceId: "a".repeat(32), displayName: "desk" };
const LAPTOP = { deviceId: "b".repeat(32), displayName: "laptop" };
const TABLET = "c".repeat(32);

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 16, 0, second)).toISOString().replace(".000Z", "Z");
};

async function writeDevice(home, device) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "device.json"), canonicalJson({ schemaVersion: "einzbern.device.v1", ...device, createdAt: "2026-09-26T00:00:00Z" }));
}

const projectCreated = (key, occurredAt) => ({
  operation: "project.created",
  record: { schemaVersion: "tcrn.project.v1", id: deriveStableId("project", key), externalKey: key, name: key, revision: 1, updatedAt: occurredAt, tombstone: false },
});

/** A library the desk (this process) and the laptop have both written to. */
async function twoDevices(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-upgrade-")));
  const previous = process.env.EINZBERN_HOME;
  const homes = { desk: join(base, "home-desk"), laptop: join(base, "home-laptop") };
  await writeDevice(homes.desk, DESK);
  await writeDevice(homes.laptop, LAPTOP);
  process.env.EINZBERN_HOME = homes.desk;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  const library = await createLibrary(join(base, ".ether"), { createdAt: "2026-09-26T00:00:00Z", projectName: "Upgrade" });
  for (const [device, home, key] of [[DESK, homes.desk, "DESK"], [LAPTOP, homes.laptop, "LAPTOP"]]) {
    const occurredAt = at();
    await appendToOwnStream(library, device, [{ occurredAt, payload: projectCreated(key, occurredAt) }], { home });
  }
  return { base, library };
}

async function status(library) {
  let output = "";
  await runCli(["status", "--workspace", library.root], { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function rewriteJson(path, change) {
  await writeFile(path, canonicalJson(change(JSON.parse(await readFile(path, "utf8")))));
}

const streamManifest = (library, deviceId) => join(library.root, "akasha", deviceId, "manifest.json");

test("471-R4: status lists every device with the engine version it wrote with, and ready means no hint", async (context) => {
  const { library } = await twoDevices(context);
  const answered = await status(library);
  assert.equal(answered.multiDevice.ready, true);
  assert.equal(answered.multiDevice.hint, null);
  assert.equal(answered.multiDevice.upgradeNeeded, false);
  assert.deepEqual(answered.multiDevice.devices, [
    { deviceId: DESK.deviceId, displayName: "desk", engineVersion: FRAMEWORK_VERSION, self: true, ready: true },
    { deviceId: LAPTOP.deviceId, displayName: "laptop", engineVersion: FRAMEWORK_VERSION, self: false, ready: true },
  ]);
});

test("471-R4: a device whose engine version is unknown makes status carry the hint", async (context) => {
  const { library } = await twoDevices(context);
  // A tablet whose first append stopped before its stream manifest: it is known, its version is not.
  await mkdir(join(library.root, "akasha", TABLET));
  await writeFile(join(library.root, "akasha", TABLET, "00000001.ndjson"), "{\"interrupted\":true}\n");
  const answered = await status(library);
  assert.equal(answered.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(answered.multiDevice.ready, false);
  assert.deepEqual(answered.multiDevice.devices.map((device) => [device.deviceId, device.engineVersion, device.ready]), [
    [DESK.deviceId, FRAMEWORK_VERSION, true],
    [LAPTOP.deviceId, FRAMEWORK_VERSION, true],
    [TABLET, null, false],
  ]);
  assert.equal(answered.multiDevice.hint, `先把以下设备升级到 ≥${FRAMEWORK_VERSION} 再写入新格式：${TABLET}（版本未知）`);
});

test("471-R4: with the target format raised (test seam), a device on an older engine is not ready and the raising write is refused with the hint", async (context) => {
  const { library: created } = await twoDevices(context);
  // The library admits engines from 0.1.0 on; the laptop last wrote with 0.5.0.
  await rewriteJson(join(created.root, "manifest.json"), (manifest) => ({ ...manifest, minEngineVersion: "0.1.0" }));
  await rewriteJson(streamManifest(created, LAPTOP.deviceId), (manifest) => ({ ...manifest, engineVersion: "0.5.0" }));
  const library = await openLibrary(created.root);
  const staying = await libraryUpgradeReadiness(library);
  assert.equal(staying.upgradeNeeded, false);
  assert.equal(staying.ready, true, "while the format stays, 0.5.0 meets the library's own minimum");
  assert.doesNotThrow(() => assertUpgradeReady(staying));
  const raising = await libraryUpgradeReadiness(library, { targetFormat: 2 });
  assert.equal(raising.upgradeNeeded, true);
  assert.equal(raising.requiredEngineVersion, FRAMEWORK_VERSION);
  assert.equal(raising.ready, false);
  assert.equal(raising.hint, `先把以下设备升级到 ≥${FRAMEWORK_VERSION} 再写入新格式：laptop（0.5.0）`);
  assert.throws(() => assertUpgradeReady(raising), (error) => error?.reasonCode === "LIBRARY_UPGRADE_NOT_READY" &&
    error.message === raising.hint && error.details.required === FRAMEWORK_VERSION);
  // Once the laptop runs this engine too, the new format may be written.
  await rewriteJson(streamManifest(created, LAPTOP.deviceId), (manifest) => ({ ...manifest, engineVersion: FRAMEWORK_VERSION }));
  const upgraded = await libraryUpgradeReadiness(library, { targetFormat: 2 });
  assert.equal(upgraded.ready, true);
  assert.equal(upgraded.hint, null);
  assert.doesNotThrow(() => assertUpgradeReady(upgraded));
  assert.equal((await status(library)).multiDevice.ready, true);
});

test("471-R4: this device is ready whatever its stream last recorded, and a device without a name is named by its id", () => {
  const readiness = upgradeReadiness({
    formatVersion: 1,
    minEngineVersion: "1.0.0",
    devices: [
      { deviceId: DESK.deviceId, displayName: "desk", engineVersion: "1.0.0" },
      { deviceId: LAPTOP.deviceId, displayName: "laptop", engineVersion: "2.0.0" },
      { deviceId: TABLET, displayName: null, engineVersion: null },
    ],
  }, { engineVersion: "2.1.0", targetFormat: 2, selfDeviceId: DESK.deviceId });
  assert.deepEqual(readiness.devices.map((device) => [device.self, device.ready]), [[true, true], [false, false], [false, false]]);
  assert.equal(readiness.hint, `先把以下设备升级到 ≥2.1.0 再写入新格式：laptop（2.0.0）、${TABLET}（版本未知）`);
  const withoutSelf = upgradeReadiness({ formatVersion: 1, minEngineVersion: "1.0.0", devices: [] }, { engineVersion: "2.1.0" });
  assert.deepEqual([withoutSelf.ready, withoutSelf.hint, withoutSelf.targetFormat], [true, null, 1]);
});
