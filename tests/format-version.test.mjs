// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-471 R1, AC1 (MIN-227 D22): a library in a newer format than this engine reads,
// or one that needs a newer engine, is refused on opening with a reason code before any lock,
// cache read or write, so the library and this device's directory stay byte for byte as they
// were. A library at or below what this engine supports opens as before.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { FRAMEWORK_VERSION, materializeLibrary, openLibrary } from "../dist/build/packages/core/src/index.js";
import { ENGINE_FORMAT_VERSION, compareSemver, parseEngineVersion } from "../dist/build/packages/core/src/format-version.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const cliPath = join(repositoryRoot, "scripts/einzbern.mjs");
const tripwirePath = join(repositoryRoot, "tests/helpers/fs-write-tripwire.mjs");

// Derived from the running version, never written as a literal: a literal "newer" version stops
// being newer the day the engine reaches it.
const current = parseEngineVersion(FRAMEWORK_VERSION);
const NEXT_MAJOR = `${BigInt(current.major) + 1n}.0.0`;
const NEXT_PATCH_PRERELEASE = `${current.major}.${current.minor}.${BigInt(current.patch) + 1n}-rc.1`;
const THIS_RELEASE_PRERELEASE = `${current.major}.${current.minor}.${current.patch}-0`;

let second = 0;
const at = () => {
  second += 1;
  return new Date(Date.UTC(2026, 8, 26, 12, 0, second)).toISOString().replace(".000Z", "Z");
};

async function scratch(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-format-")));
  const previous = process.env.EINZBERN_HOME;
  const device = join(base, "device");
  process.env.EINZBERN_HOME = device;
  context.after(async () => {
    process.env.EINZBERN_HOME = previous;
    await rm(base, { recursive: true, force: true });
  });
  return { base, device };
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

/** A library holding a project and an Initiative, read once so this device's cache holds it. */
async function seeded(context) {
  const { base, device } = await scratch(context);
  const library = join(base, "project", ".ether");
  await cli(["init", "--workspace", library, "--at", at(), "--project-name", "Format"]);
  const project = await cli(["project-create", "--workspace", library, "--at", at(), "--external-key", "FORMAT-PROJECT", "--name", "Format"]);
  await cli(["work-create", "--workspace", library, "--at", at(), "--project-id", project.record.id, "--external-key", "FORMAT-INITIATIVE", "--kind", "Initiative", "--title", "format"]);
  await cli(["status", "--workspace", library]);
  return { device, library, projectId: project.record.id };
}

async function rewriteManifest(library, change) {
  const path = join(library, "manifest.json");
  await writeFile(path, canonicalJson(change(JSON.parse(await readFile(path, "utf8")))));
}

/** Relative path, size, modification time and sha256 of every entry under a directory. */
async function treeDigest(root) {
  const rows = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await stat(path);
      const digest = entry.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "directory";
      rows.push(`${relative(root, path)}|${metadata.size}|${metadata.mtimeMs}|${digest}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return rows;
}

/** Run the CLI binary with every write under `roots` refused (tests/helpers/fs-write-tripwire.mjs). */
function underTripwire(roots, args) {
  return spawnSync(process.execPath, ["--import", tripwirePath, cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, EINZBERN_TRIPWIRE_ROOT: roots.join(delimiter) },
  });
}

function stderrRefusal(run) {
  return JSON.parse(run.stderr.trim().split("\n").at(-1));
}

test("471-R1: engine versions compare by semantic-version precedence", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.9.0", "1.10.0", "2.0.0"];
  for (const [i, left] of ordered.entries()) {
    for (const [j, right] of ordered.entries()) {
      assert.equal(compareSemver(left, right), Math.sign(i - j), `${left} against ${right}`);
    }
  }
  assert.equal(compareSemver("12345678901234567890.0.0", "12345678901234567889.0.0"), 1, "whole numbers of any length compare exactly");
  for (const value of ["1.0", "v1.0.0", "1.0.0+build", "", 1, null]) assert.equal(parseEngineVersion(value), null, String(value));
  assert.throws(() => compareSemver("1.0", "1.0.0"), RangeError);
});

test("471-AC1: a library in a newer format is refused by status, work-list and work-create, and nothing is written", async (context) => {
  const { device, library, projectId } = await seeded(context);
  await rewriteManifest(library, (manifest) => ({ ...manifest, formatVersion: 99 }));
  const libraryBefore = await treeDigest(library);
  const deviceBefore = await treeDigest(device);
  assert.ok(deviceBefore.some((row) => row.startsWith("cache/")), "this device's cache holds the library's views and snapshot");
  for (const args of [
    ["status", "--workspace", library],
    ["work-list", "--workspace", library],
    ["work-create", "--workspace", library, "--at", at(), "--project-id", projectId, "--external-key", "FORMAT-LATE", "--kind", "Initiative", "--title", "late"],
  ]) {
    const run = underTripwire([library, device], args);
    assert.equal(run.status, 1, `${args[0]}: ${run.stderr}`);
    assert.equal(run.stdout, "", args[0]);
    const refused = stderrRefusal(run);
    assert.equal(refused.reasonCode, "LIBRARY_FORMAT_UNSUPPORTED", `${args[0]}: ${run.stderr}`);
    assert.equal(refused.required, "99", args[0]);
    assert.equal(refused.supported, String(ENGINE_FORMAT_VERSION), args[0]);
  }
  assert.deepEqual(await treeDigest(library), libraryBefore, "the library is byte for byte as it was");
  assert.deepEqual(await treeDigest(device), deviceBefore, "the device directory, its cache included, is byte for byte as it was");
});

test("471-R1: a newer format is named even when the rest of its manifest has changed shape", async (context) => {
  const { library } = await seeded(context);
  // One past the format this engine reads (format-version.ts), whatever that format is.
  const newer = ENGINE_FORMAT_VERSION + 1;
  await rewriteManifest(library, (manifest) => ({ ...manifest, schemaVersion: "einzbern.library-manifest.v2", formatVersion: newer, streams: "a field this engine does not know" }));
  await assert.rejects(openLibrary(library), (error) => error?.reasonCode === "LIBRARY_FORMAT_UNSUPPORTED" && error.details.required === String(newer));
  assert.equal((await refusal(["chain-validate", "--workspace", library])).reasonCode, "LIBRARY_FORMAT_UNSUPPORTED");
  // A manifest in this engine's format that does not validate is still invalid, not unsupported.
  await rewriteManifest(library, (manifest) => ({ ...manifest, schemaVersion: "einzbern.library-manifest.v1", formatVersion: ENGINE_FORMAT_VERSION }));
  await assert.rejects(openLibrary(library), (error) => error?.reasonCode === "LIBRARY_MANIFEST_INVALID");
});

test("471-R1: a library that needs a newer engine is refused with ENGINE_TOO_OLD, naming both versions, and nothing is written", async (context) => {
  const { device, library } = await seeded(context);
  await rewriteManifest(library, (manifest) => ({ ...manifest, minEngineVersion: NEXT_MAJOR }));
  const libraryBefore = await treeDigest(library);
  const deviceBefore = await treeDigest(device);
  const run = underTripwire([library, device], ["status", "--workspace", library]);
  assert.equal(run.status, 1, run.stderr);
  const refused = stderrRefusal(run);
  assert.equal(refused.reasonCode, "ENGINE_TOO_OLD", run.stderr);
  assert.equal(refused.required, NEXT_MAJOR);
  assert.equal(refused.actual, FRAMEWORK_VERSION);
  assert.deepEqual(await treeDigest(library), libraryBefore);
  assert.deepEqual(await treeDigest(device), deviceBefore);
  // A pre-release of the next patch is still newer than this release.
  await rewriteManifest(library, (manifest) => ({ ...manifest, minEngineVersion: NEXT_PATCH_PRERELEASE }));
  await assert.rejects(openLibrary(library), (error) => error?.reasonCode === "ENGINE_TOO_OLD" && error.details.required === NEXT_PATCH_PRERELEASE);
});

test("471-R1: a library at or below this engine's format and version opens as before", async (context) => {
  const { library } = await seeded(context);
  for (const minEngineVersion of [FRAMEWORK_VERSION, "0.1.0", THIS_RELEASE_PRERELEASE]) {
    await rewriteManifest(library, (manifest) => ({ ...manifest, formatVersion: ENGINE_FORMAT_VERSION, minEngineVersion }));
    const status = await cli(["status", "--workspace", library]);
    assert.equal(status.reasonCode, "WORKSPACE_COMMAND_COMPLETED", minEngineVersion);
    assert.equal(status.work, 1, minEngineVersion);
    assert.equal((await openLibrary(library)).manifest.minEngineVersion, minEngineVersion);
  }
});

test("471-R1: a stream a newer format wrote is refused and named by its device", async (context) => {
  const { library } = await seeded(context);
  const [deviceId] = await readdir(join(library, "akasha"));
  const path = join(library, "akasha", deviceId, "manifest.json");
  await writeFile(path, canonicalJson({ ...JSON.parse(await readFile(path, "utf8")), formatVersion: 99 }));
  await assert.rejects(materializeLibrary(library), (error) => error?.reasonCode === "LIBRARY_FORMAT_UNSUPPORTED" &&
    error.details.deviceId === deviceId && error.details.required === "99" && error.details.supported === String(ENGINE_FORMAT_VERSION));
  const refused = await refusal(["status", "--workspace", library]);
  assert.equal(refused.reasonCode, "LIBRARY_FORMAT_UNSUPPORTED");
  assert.equal(refused.details.deviceId, deviceId);
});
