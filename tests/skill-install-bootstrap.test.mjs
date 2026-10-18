// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R3, AC2, AC3: skill/mana-orchestrate/scripts/install.mjs puts a released
// engine on a device. An archive with one byte changed is refused with
// INSTALL_ARCHIVE_DIGEST_MISMATCH and the device directory gets no file (AC2). A local --archive
// installs while every fetch throws: engine/current names its version and both stable launchers
// are in engine/ (AC3). Installing the same version again changes nothing. --version downloads the
// archive and its .sha256 from the version's release and nothing else, and the script imports
// node: built-ins only, so it runs from the skill before any engine is on the device.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { FRAMEWORK_VERSION, computeInstallTreeDigest } from "../dist/build/packages/core/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installScript = join(repositoryRoot, "skill/mana-orchestrate/scripts/install.mjs");
const ARCHIVE = `einzbern-${FRAMEWORK_VERSION}.tar.gz`;

const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-skill-install-")));
after(() => rm(base, { recursive: true, force: true }));

// One release for the whole file.
const release = join(base, "release");
const packed = spawnSync(process.execPath, [join(repositoryRoot, "scripts/pack-release.mjs"), "--out", release], { encoding: "utf8" });
assert.equal(packed.status, 0, packed.stderr);
const releaseSha256 = JSON.parse(packed.stdout).sha256;

// Every fetch throws: a run that reaches for the network fails.
const noFetch = join(base, "no-fetch.mjs");
await writeFile(noFetch, "globalThis.fetch = async () => { throw new Error(\"this run may not fetch\"); };\n");
// Answers from the release directory by file name and logs every URL asked for.
const fakeRelease = join(base, "fake-release.mjs");
await writeFile(fakeRelease, [
  "import { appendFileSync, readFileSync } from \"node:fs\";",
  "import { join } from \"node:path\";",
  "globalThis.fetch = async (url) => {",
  "  appendFileSync(process.env.FAKE_FETCH_LOG, `${url}\\n`);",
  "  try {",
  "    return new Response(readFileSync(join(process.env.FAKE_RELEASE_DIR, String(url).split(\"/\").at(-1))));",
  "  } catch {",
  "    return new Response(\"not found\", { status: 404 });",
  "  }",
  "};",
  "",
].join("\n"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A user home of its own under `name`; the device directory install.mjs defaults to is .einzbern in it. */
async function user(name) {
  const home = join(base, name);
  await mkdir(home, { recursive: true });
  return { home, device: join(home, ".einzbern") };
}

function install(args, { home, preload = noFetch, env = {} }) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, installScript, ...args], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, HOME: home, EINZBERN_HOME: "", ...env },
  });
}

function refusal(run) {
  assert.equal(run.status, 1, run.stdout);
  assert.equal(run.stdout, "");
  const lines = run.stderr.trim().split("\n");
  return JSON.parse(lines.at(-1));
}

async function listing(root) {
  if (!existsSync(root)) return null;
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    found.push(join(entry.parentPath, entry.name).slice(root.length));
  }
  return found.sort();
}

test("481-AC2: an archive with one byte changed is refused and the device directory gets no file", async () => {
  const { home, device } = await user("ac2");
  // A device that already holds something: the refusal must leave it as it is.
  await mkdir(device, { recursive: true });
  await writeFile(join(device, "keep.txt"), "kept\n");
  const before = await listing(device);
  const tampered = join(base, "tampered", ARCHIVE);
  await mkdir(join(base, "tampered"), { recursive: true });
  const bytes = await readFile(join(release, ARCHIVE));
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  await writeFile(tampered, bytes);
  await copyFile(join(release, `${ARCHIVE}.sha256`), `${tampered}.sha256`);

  for (const args of [["--archive", tampered], ["--archive", tampered, "--sha256", releaseSha256]]) {
    const refused = refusal(install(args, { home }));
    assert.deepEqual([refused.reasonCode, refused.required, refused.actual], ["INSTALL_ARCHIVE_DIGEST_MISMATCH", releaseSha256, sha256(bytes)]);
    assert.deepEqual(await listing(device), before, "the device directory is as it was");
  }

  // The other refusals before the unpack write nothing either.
  const { home: elsewhere, device: untouched } = await user("ac2-other");
  const lone = join(base, "lone", ARCHIVE);
  await mkdir(join(base, "lone"), { recursive: true });
  await copyFile(join(release, ARCHIVE), lone);
  assert.equal(refusal(install(["--archive", lone], { home: elsewhere })).reasonCode, "INSTALL_SHA256_MISSING");
  const mismatch = refusal(install(["--archive", join(release, ARCHIVE), "--version", "9.9.9"], { home: elsewhere }));
  assert.deepEqual([mismatch.reasonCode, mismatch.required, mismatch.actual], ["INSTALL_VERSION_MISMATCH", "9.9.9", FRAMEWORK_VERSION]);
  assert.equal(refusal(install(["--version", "latest"], { home: elsewhere })).reasonCode, "INSTALL_VERSION_INVALID");
  const offline = refusal(install(["--version", FRAMEWORK_VERSION], { home: elsewhere }));
  assert.equal(offline.reasonCode, "INSTALL_DOWNLOAD_FAILED");
  assert.equal(refusal(install(["--sha256", releaseSha256], { home: elsewhere })).reasonCode, "INSTALL_USAGE");
  assert.equal(await listing(untouched), null, "no device directory was created");
});

test("481-AC3, R3: a local archive installs while every fetch throws, and installing it again changes nothing", async () => {
  const { home, device } = await user("ac3");
  const first = install(["--archive", join(release, ARCHIVE)], { home });
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.reasonCode, "INSTALL_ENGINE_READY");
  assert.deepEqual([report.version, report.installed, report.archiveSha256], [FRAMEWORK_VERSION, "copied", releaseSha256]);
  assert.ok(report.next.includes("setup --mode fresh"), "it names the next step");

  const engine = join(device, "engine");
  const current = JSON.parse(await readFile(join(engine, "current"), "utf8"));
  assert.deepEqual([current.schemaVersion, current.version, current.previous], ["einzbern.engine-current.v1", FRAMEWORK_VERSION, null]);
  assert.ok((await readFile(join(engine, "einzbern.mjs"))).equals(await readFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"))));
  assert.ok((await readFile(join(engine, "hook.mjs"))).equals(await readFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"))));
  const digest = (await computeInstallTreeDigest(join(engine, FRAMEWORK_VERSION))).sha256;
  assert.equal(digest, report.installTreeDigest, "the installed version hashes as its manifest states");
  // The stable entry runs the version just installed.
  const commands = spawnSync(process.execPath, [join(engine, "einzbern.mjs"), "commands"], { cwd: base, encoding: "utf8", env: { ...process.env, EINZBERN_HOME: device } });
  assert.equal(commands.status, 0, commands.stderr);
  assert.equal(JSON.parse(commands.stdout).reasonCode, "CLI_CATALOG_READY");
  // The unpacked copy went to the trash, with the manifest it set aside; nothing is left beside it.
  const trashed = await readdir(join(device, "trash"));
  assert.equal(trashed.length, 1);
  assert.ok(existsSync(join(device, "trash", trashed[0], "manifest.json")));
  assert.deepEqual((await readdir(device)).filter((name) => name.startsWith("tmp-")), []);

  const engineBefore = await listing(engine);
  const second = install(["--archive", join(release, ARCHIVE), "--sha256", releaseSha256, "--version", FRAMEWORK_VERSION], { home });
  assert.equal(second.status, 0, second.stderr);
  const again = JSON.parse(second.stdout);
  assert.deepEqual([again.version, again.installed], [FRAMEWORK_VERSION, "reused"]);
  const currentAgain = JSON.parse(await readFile(join(engine, "current"), "utf8"));
  assert.deepEqual([currentAgain.version, currentAgain.previous], [FRAMEWORK_VERSION, null]);
  assert.equal((await computeInstallTreeDigest(join(engine, FRAMEWORK_VERSION))).sha256, digest);
  assert.ok((await readFile(join(engine, "einzbern.mjs"))).equals(await readFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"))));
  assert.ok((await readFile(join(engine, "hook.mjs"))).equals(await readFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"))));
  assert.deepEqual(await listing(engine), engineBefore, "engine/ holds the same entries");
  assert.equal((await readdir(join(device, "trash"))).length, 2);
});

test("481-R3: --version downloads the archive and its .sha256 from that version's release, and nothing else", async () => {
  const { home, device } = await user("download");
  const log = join(base, "fetched.log");
  const run = install(["--version", FRAMEWORK_VERSION, "--home", device], {
    home,
    preload: fakeRelease,
    env: { FAKE_FETCH_LOG: log, FAKE_RELEASE_DIR: release },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).version, FRAMEWORK_VERSION);
  const fetched = (await readFile(log, "utf8")).trim().split("\n");
  const escaped = FRAMEWORK_VERSION.replaceAll(".", "\\.");
  const archiveUrl = new RegExp(`^https://github\\.com/[^/]+/[^/]+/releases/download/v${escaped}/einzbern-${escaped}\\.tar\\.gz$`, "u");
  assert.equal(fetched.length, 2, fetched.join(" "));
  assert.match(fetched[0], archiveUrl);
  assert.equal(fetched[1], `${fetched[0]}.sha256`);
  assert.equal(JSON.parse(await readFile(join(device, "engine", "current"), "utf8")).version, FRAMEWORK_VERSION);
});

test("481-R3: install.mjs imports node: built-ins only", async () => {
  const source = await readFile(installScript, "utf8");
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";$/gmu)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith("node:")), []);
  assert.doesNotMatch(source, /\bimport\s*\(/u, "no dynamic import");
  assert.doesNotMatch(source, /\brequire\s*\(/u);
});

// Environment roots are device identities, never relative to the caller's working directory.
test("installer rejects a relative environment root before reading an archive", async () => {
  const { home } = await user("relative-environment");
  const run = install(["--archive", "missing.tar.gz"], { home, env: { EINZBERN_HOME: "relative-device" } });
  assert.equal(refusal(run).reasonCode, "DEVICE_HOME_INVALID");
  assert.equal(existsSync(join(base, "relative-device")), false);
  const explicit = install(["--archive", "missing.tar.gz", "--home", "explicit-device"], { home, env: { EINZBERN_HOME: "relative-device" } });
  assert.equal(refusal(explicit).reasonCode, "INSTALL_ARCHIVE_UNREADABLE");
  assert.equal(existsSync(join(base, "explicit-device")), false);
});
