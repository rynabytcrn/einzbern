// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-469 R3, R6: the device directory and the paths inside it.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import {
  DEVICE_HOME_ENTRIES,
  DIRECTORY,
  backupsPath,
  cachePath,
  deviceFilePath,
  deviceHome,
  engineRoot,
  ensureDeviceDirectory,
  libraryDirectoryName,
  lockPath,
  machineSettingsPath,
  registryPath,
} from "../dist/build/packages/core/src/index.js";

const LIBRARY = "library:0123456789abcdef01234567";
const IMPORTED = "workspace:89abcdef0123456789abcdef";

async function withDeviceHome(t) {
  const home = await mkdtemp(join(tmpdir(), "einzbern-device-home-"));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.EINZBERN_HOME;
    else process.env.EINZBERN_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

const inside = (parent, child) => {
  const relation = relative(parent, child);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
};

test("469-R3: EINZBERN_HOME names the device directory and wins over the user home", async (t) => {
  const home = await withDeviceHome(t);
  assert.equal(deviceHome(), home);
  assert.equal(deviceHome({ EINZBERN_HOME: home }, "/elsewhere"), home);
  // Without the variable (or with it empty) the directory is .einzbern under the given home;
  // computing it creates nothing.
  assert.equal(deviceHome({}, "/users/someone"), join("/users/someone", DIRECTORY.device));
  assert.equal(deviceHome({ EINZBERN_HOME: "" }, "/users/someone"), join("/users/someone", DIRECTORY.device));
});

test("469-R3: every device path is inside the device directory", async (t) => {
  const home = await withDeviceHome(t);
  const paths = {
    device: deviceFilePath(),
    registry: registryPath(),
    machineSettings: machineSettingsPath(),
    cache: cachePath(LIBRARY),
    importedCache: cachePath(IMPORTED),
    lock: lockPath(LIBRARY),
    backups: backupsPath(),
    engine: engineRoot(),
  };
  for (const [name, path] of Object.entries(paths)) assert.ok(inside(home, path), `${name}: ${path} is outside ${home}`);
  assert.equal(paths.device, join(home, DEVICE_HOME_ENTRIES.device));
  assert.equal(paths.registry, join(home, "registry.json"));
  assert.equal(paths.machineSettings, join(home, "machine-settings.json"));
  assert.equal(paths.cache, join(home, "cache", "library-0123456789abcdef01234567"));
  assert.equal(paths.importedCache, join(home, "cache", "workspace-89abcdef0123456789abcdef"));
  assert.equal(paths.lock, join(home, "locks", "library-0123456789abcdef01234567.lock"));
  assert.equal(paths.backups, join(home, "backups"));
  assert.equal(paths.engine, join(home, "engine"));
  // An explicit home argument takes the place of the environment for every path.
  assert.equal(cachePath(LIBRARY, "/device"), join("/device", "cache", "library-0123456789abcdef01234567"));
  // The --home flag of the machine-settings verbs keeps naming the user's home.
  assert.equal(machineSettingsPath("/users/someone"), join("/users/someone", DIRECTORY.device, "machine-settings.json"));
});

test("469-R6: a library id becomes a short, colon-free directory name, and nothing else is accepted", () => {
  assert.equal(libraryDirectoryName(LIBRARY), "library-0123456789abcdef01234567");
  for (const bad of ["library:XYZ", "library:0123", "project:0123456789abcdef01234567", "../library:0123456789abcdef01234567", ""]) {
    assert.throws(() => libraryDirectoryName(bad), (error) => error?.reasonCode === "DEVICE_LIBRARY_ID_INVALID", bad);
    assert.throws(() => lockPath(bad), (error) => error?.reasonCode === "DEVICE_LIBRARY_ID_INVALID", bad);
  }
});

test("469-R6: device directories are created with the process defaults, without reading a mode back", async (t) => {
  await withDeviceHome(t);
  const created = await ensureDeviceDirectory(cachePath(LIBRARY));
  assert.equal(created, cachePath(LIBRARY));
  assert.ok((await stat(created)).isDirectory());
  // Creating an existing directory again is not an error.
  await ensureDeviceDirectory(cachePath(LIBRARY));
  await ensureDeviceDirectory(join(deviceHome(), "locks"));
  assert.ok((await stat(join(deviceHome(), "locks"))).isDirectory());
});
