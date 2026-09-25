// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-468 R1: the device id and display name in the device directory; a reinstall
// that loses the directory gets a new id.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_SCHEMA_VERSION,
  deviceFilePath,
  displayNameFromHostname,
  readDevice,
  readOrCreateDevice,
  setDeviceDisplayName,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

async function deviceHomeFor(t) {
  const base = await mkdtemp(join(tmpdir(), "einzbern-device-identity-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return join(base, "einzbern-home");
}

test("468-R1: the first use writes device.json with a random id and a name from the host", async (t) => {
  const home = await deviceHomeFor(t);
  assert.equal(await readDevice(home), null, "no device before first use, and reading creates nothing");
  const { device, created } = await readOrCreateDevice({ home, now: "2026-09-26T00:00:00Z", hostname: "Owner-MacBook.local" });
  assert.equal(created, true);
  assert.equal(device.schemaVersion, DEVICE_SCHEMA_VERSION);
  assert.match(device.deviceId, /^[a-f0-9]{32}$/u);
  assert.equal(device.displayName, "Owner-MacBook");
  assert.equal(device.createdAt, "2026-09-26T00:00:00Z");
  assert.equal(await readFile(deviceFilePath(home), "utf8"), canonicalJson(device), "the file is the canonical record");
  assert.deepEqual((await readdir(home)).sort(), ["device.json"], "no temporary is left behind");
});

test("468-R1: later uses read the same id back", async (t) => {
  const home = await deviceHomeFor(t);
  const first = await readOrCreateDevice({ home });
  const second = await readOrCreateDevice({ home });
  assert.equal(second.created, false);
  assert.deepEqual(second.device, first.device);
  assert.deepEqual(await readDevice(home), first.device);
});

test("468-R1: a reinstall that loses the device directory gets a new id", async (t) => {
  const home = await deviceHomeFor(t);
  const before = await readOrCreateDevice({ home });
  await rm(home, { recursive: true, force: true });
  const after = await readOrCreateDevice({ home });
  assert.equal(after.created, true);
  assert.notEqual(after.device.deviceId, before.device.deviceId);
});

test("468-R1: processes that start together agree on one id", async (t) => {
  const home = await deviceHomeFor(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => readOrCreateDevice({ home })));
  assert.equal(new Set(results.map((result) => result.device.deviceId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1, "exactly one of them wrote the file");
  assert.deepEqual((await readdir(home)).sort(), ["device.json"]);
});

test("468-R1: a damaged device file is an error and is never replaced by a new id", async (t) => {
  const home = await deviceHomeFor(t);
  const { device } = await readOrCreateDevice({ home });
  for (const text of ["{not json", JSON.stringify({ ...device, deviceId: "short" }), JSON.stringify({ ...device, extra: true }), JSON.stringify({ ...device, schemaVersion: "tcrn.device.v1" })]) {
    await writeFile(deviceFilePath(home), text, "utf8");
    await assert.rejects(readOrCreateDevice({ home }), (error) => error?.reasonCode === "DEVICE_FILE_INVALID");
    assert.equal(await readFile(deviceFilePath(home), "utf8"), text, "the damaged file is left for the owner to see");
  }
});

test("468-R1: the display name can be changed and the id stays", async (t) => {
  const home = await deviceHomeFor(t);
  const { device } = await readOrCreateDevice({ home, hostname: "desk" });
  const renamed = await setDeviceDisplayName("Studio desktop", home);
  assert.equal(renamed.deviceId, device.deviceId);
  assert.equal((await readDevice(home)).displayName, "Studio desktop");
  for (const bad of ["", " padded", "two\nlines", "x".repeat(65)]) {
    await assert.rejects(setDeviceDisplayName(bad, home), (error) => error?.reasonCode === "DEVICE_DISPLAY_NAME_INVALID", JSON.stringify(bad));
  }
  assert.equal(displayNameFromHostname("  \u0007  "), "device", "a host name with nothing readable still yields a name");
  assert.equal(displayNameFromHostname("x".repeat(80)).length, 64);
});
