// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-470 R2, AC5 (MIN-227 D19, D21): the cloud-hosted flag is the user's; the cloud
// folder table only suggests it, from where macOS and Windows keep their cloud folders (Linux has
// no convention and gets no suggestion). A library reached through a symbolic link is registered,
// created and opened at its real path.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { cloudRootRules, defaultCloudLibraryPath, matchCloudRoot, suggestCloudHosted } from "../dist/build/packages/core/src/cloud-roots.js";

const darwin = { platform: "darwin", env: {}, home: "/Users/owner" };
const windows = {
  platform: "win32",
  env: { OneDrive: "C:\\Users\\owner\\OneDrive", OneDriveCommercial: "C:\\Users\\owner\\OneDrive - Company", USERPROFILE: "C:\\Users\\owner" },
  home: "C:\\Users\\owner",
};
const linux = { platform: "linux", env: { HOME: "/home/owner" }, home: "/home/owner" };

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 8, 0, second)).toISOString().replace(".000Z", "Z");
};

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

test("470-R2: macOS suggests the flag for CloudStorage, iCloud Drive, OneDrive and Dropbox folders only", () => {
  for (const [path, provider] of [
    ["/Users/owner/Library/CloudStorage/OneDrive-Personal/Ether/project", "cloud-storage"],
    ["/Users/owner/Library/CloudStorage/GoogleDrive-owner@example.test/Ether/project", "cloud-storage"],
    ["/Users/owner/Library/Mobile Documents/com~apple~CloudDocs/Ether/project", "icloud-drive"],
    ["/Users/owner/OneDrive/Ether/project", "onedrive"],
    ["/Users/owner/OneDrive - Company/Ether/project", "onedrive"],
    ["/Users/owner/Dropbox/Ether/project", "dropbox"],
  ]) {
    assert.equal(matchCloudRoot(path, darwin)?.provider, provider, path);
    assert.equal(suggestCloudHosted(path, darwin), true, path);
  }
  assert.equal(matchCloudRoot("/Users/owner/Library/CloudStorage/OneDrive-Personal/Ether/project", darwin).cloudRoot, "/Users/owner/Library/CloudStorage/OneDrive-Personal");
  for (const path of ["/Users/owner/Documents/project/.ether", "/Users/owner/Library/CloudStorage", "/Users/other/Dropbox/project", "/Volumes/Backup/Dropbox/project"]) {
    assert.equal(suggestCloudHosted(path, darwin), false, path);
  }
});

test("470-R2: Windows suggests the flag for the OneDrive variables and the iCloud Drive and Dropbox folders", () => {
  for (const path of [
    "C:\\Users\\owner\\OneDrive\\Ether\\project",
    "c:\\users\\owner\\onedrive\\ether\\project",
    "C:\\Users\\owner\\OneDrive - Company\\Ether\\project",
    "C:\\Users\\owner\\iCloudDrive\\Ether\\project",
    "C:\\Users\\owner\\Dropbox\\Ether\\project",
  ]) {
    assert.equal(suggestCloudHosted(path, windows), true, path);
  }
  assert.equal(suggestCloudHosted("C:\\Users\\owner\\Documents\\project\\.ether", windows), false);
  assert.equal(suggestCloudHosted("D:\\Work\\project\\.ether", windows), false);
  assert.deepEqual(cloudRootRules({ ...windows, env: {} }), [], "without the variables Windows has no known cloud folder");
});

test("470-R2: Linux has no cloud folder convention and suggests nothing", () => {
  assert.deepEqual(cloudRootRules(linux), []);
  for (const path of ["/home/owner/Dropbox/Ether/project", "/home/owner/OneDrive/Ether/project"]) {
    assert.equal(suggestCloudHosted(path, linux), false, path);
  }
});

test("470-R2: a shared library is named Ether under the selected parent", () => {
  assert.equal(defaultCloudLibraryPath("/Users/owner/Library/CloudStorage/OneDrive-Personal", "Einzbern", "darwin"), "/Users/owner/Library/CloudStorage/OneDrive-Personal/Ether");
  assert.equal(defaultCloudLibraryPath("C:\\Users\\owner\\OneDrive", "Einzbern", "win32"), "C:\\Users\\owner\\OneDrive\\Ether");
});

test("470-AC5: a library given through a symbolic link is created, registered and opened at its real path", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-cloud-")));
  const previous = process.env.EINZBERN_HOME;
  process.env.EINZBERN_HOME = join(base, "device");
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  // A stand-in cloud folder reached through a link, as ~/OneDrive often is.
  const cloud = join(base, "CloudStorage", "OneDrive-Personal");
  await mkdir(cloud, { recursive: true });
  const link = join(base, "OneDrive");
  await symlink(cloud, link);
  const project = join(base, "project");
  await mkdir(project);

  const created = await cli(["init", "--workspace", join(link, "Ether", "project"), "--at", at(), "--project", project]);
  const realLibrary = join(cloud, "Ether", "project");
  assert.equal(created.realPath, realLibrary, "the library is its real path");
  assert.equal(created.registered.libraryPath, realLibrary);
  assert.equal(created.registered.cloudHosted, false, "a temporary directory is no known cloud folder, and nothing forced the flag");
  assert.equal((await cli(["status", "--workspace", join(link, "Ether", "project")])).layout, "library", "the link opens the library");

  // A library path that is itself a link is accepted and stored as the real path; --cloud-hosted is
  // the user's word over the suggestion.
  const direct = join(base, "direct-link");
  await symlink(realLibrary, direct);
  const registered = await cli(["library-register", "--project", project, "--library", direct, "--at", at(), "--cloud-hosted", "true"]);
  assert.deepEqual([registered.realPath, registered.entry.libraryPath, registered.entry.cloudHosted, registered.suggestedCloudHosted], [realLibrary, realLibrary, true, false]);
  const registry = JSON.parse(await readFile(join(base, "device", "registry.json"), "utf8"));
  // init --project also created and registered this device's coordination library (EPIC-144 R2),
  // in the device directory and not cloud-hosted; the project's entry is the real library path.
  const coordination = join(base, "device", "coordination-library");
  assert.deepEqual(registry.entries.map((entry) => [entry.projectPath, entry.libraryPath, entry.cloudHosted]), [[coordination, coordination, false], [project, realLibrary, true]]);
  assert.equal((await cli(["library-resolve", "--cwd", project])).libraryPath, realLibrary);
});
