#!/usr/bin/env node
import { constants as bufferConstants } from "node:buffer";
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R3, AC2, AC3 (MIN-227 D23): the skill's fetch step, which puts one released
// engine on this device before any engine is there to ask:
//
//   node install.mjs --version <version> [--sha256 <digest>] [--home <device directory>]
//   node install.mjs --archive <local archive> [--sha256 <digest>] [--version <version>] [--home <device directory>]
//
// 1. The archive is the release einzbern-<version>.tar.gz, downloaded for --version, or the local
//    file --archive names, in which case nothing at all is fetched. The download is the only
//    network use in the whole installation.
// 2. Its sha256 must equal --sha256, or else the digest its .sha256 states: downloaded beside the
//    archive, or read beside the local file. Otherwise the answer is INSTALL_ARCHIVE_DIGEST_MISMATCH
//    and not one file is written; nor for any other refusal before the unpack.
// 3. It is gunzipped and read as ustar here (the reader is inline: this file imports node: built-ins
//    only) into <device directory>/tmp-<random>/, all but manifest.json, which is set aside: the
//    install-tree digest it states is taken over the version directory without it.
// 4. The unpacked engine installs itself: scripts/einzbern.mjs engine-update --from <version
//    directory> --sha256 <the manifest's installTreeDigest> --version <version> checks the tree,
//    copies it to engine/<version>/, runs it once and makes it current
//    (packages/core/src/engine-home.ts). A refusal of the engine is passed on as it is.
// 5. The two stable launchers are placed as engine/einzbern.mjs and engine/hook.mjs, from the
//    version just installed.
// 6. The temporary directory is moved into <device directory>/trash/, never deleted, and the next
//    step, setup, is printed.
//
// The device directory is --home, else EINZBERN_HOME, else .einzbern in the user's home. Installing
// the version that is already current again changes nothing but the time engine/current names.
// Prints {"ok":true,"reasonCode":"INSTALL_ENGINE_READY",...} on stdout, or a reason code and its
// details on stderr with exit code 1.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

// The repository the releases are published in, at its final address (MIN-238 D4). Renaming the
// repository on GitHub to that address is a separate stop for the Owner.
const RELEASE_REPOSITORY = "tpmoonchefryan/einzbern";
const ENGINE_NAME = "einzbern";
const DEVICE_DIRECTORY = ".einzbern";
const ENGINE_DIRECTORY = "engine";
const TRASH_DIRECTORY = "trash";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_SCHEMA_VERSION = "einzbern.release-manifest.v1";
const ENGINE_ENTRY = Object.freeze(["scripts", "einzbern.mjs"]);
// Each launcher of the release and the name it has in engine/.
const LAUNCHERS = Object.freeze([
  { from: ["launchers", "einzbern.mjs"], to: "einzbern.mjs" },
  { from: ["launchers", "hook.mjs"], to: "hook.mjs" },
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const FLAGS = Object.freeze(["--version", "--archive", "--sha256", "--home"]);
const USAGE = "usage: node install.mjs --version <version> | --archive <local archive> [--sha256 <digest>] [--version <version>] [--home <device directory>]";
const BLOCK = 512;

class InstallError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "InstallError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details = {}) {
  throw new InstallError(reasonCode, message, details);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || value === undefined || value.length === 0 || value.startsWith("--") || values.has(flag)) fail("INSTALL_USAGE", USAGE);
    values.set(flag, value);
  }
  const version = values.get("--version") ?? null;
  const archive = values.has("--archive") ? resolve(values.get("--archive")) : null;
  const sha256 = values.get("--sha256") ?? null;
  if (version === null && archive === null) fail("INSTALL_USAGE", `${USAGE}: name a --version to download or a local --archive`);
  if (version !== null && !VERSION_PATTERN.test(version)) fail("INSTALL_VERSION_INVALID", `${version} is not an engine version`, { actual: version });
  if (sha256 !== null && !DIGEST_PATTERN.test(sha256)) fail("INSTALL_SHA256_INVALID", "--sha256 must be 64 lowercase hexadecimal characters", { actual: sha256 });
  const configured = process.env.EINZBERN_HOME;
  if (!values.has("--home") && typeof configured === "string" && configured.length > 0 && !isAbsolute(configured)) {
    fail("DEVICE_HOME_INVALID", "EINZBERN_HOME must be an absolute path");
  }
  const home = values.has("--home") ? resolve(values.get("--home"))
    : typeof configured === "string" && configured.length > 0 ? resolve(configured) : join(homedir(), DEVICE_DIRECTORY);
  return { version, archive, sha256, home };
}

function releaseUrl(version, file) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${file}`;
}

async function download(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    fail("INSTALL_DOWNLOAD_FAILED", `${url} could not be fetched: ${String(error?.message ?? error)}`, { url });
  }
  if (!response.ok) fail("INSTALL_DOWNLOAD_FAILED", `${url} answered ${response.status}`, { url, status: String(response.status) });
  return Buffer.from(await response.arrayBuffer());
}

// The first word of a .sha256 file, as sha256sum writes it: "<digest>  <file name>".
function statedDigest(text, source) {
  const digest = String(text).trim().split(/\s+/u)[0] ?? "";
  if (!DIGEST_PATTERN.test(digest)) fail("INSTALL_SHA256_INVALID", `${source} does not state a sha256`, { file: source });
  return digest;
}

/** The archive's bytes and the digest they must have: nothing is written, and a local archive fetches nothing. */
async function obtainArchive({ version, archive, sha256 }) {
  if (archive !== null) {
    let bytes;
    try {
      bytes = await readFile(archive);
    } catch (error) {
      fail("INSTALL_ARCHIVE_UNREADABLE", `${archive} cannot be read (${error?.code ?? "error"})`, { file: archive });
    }
    if (sha256 !== null) return { bytes, expected: sha256, source: archive };
    let stated;
    try {
      stated = await readFile(`${archive}.sha256`, "utf8");
    } catch {
      fail("INSTALL_SHA256_MISSING", `no --sha256 was given and ${archive}.sha256 cannot be read`, { file: `${archive}.sha256` });
    }
    return { bytes, expected: statedDigest(stated, `${archive}.sha256`), source: archive };
  }
  const url = releaseUrl(version, `${ENGINE_NAME}-${version}.tar.gz`);
  const bytes = await download(url);
  const expected = sha256 ?? statedDigest((await download(`${url}.sha256`)).toString("utf8"), `${url}.sha256`);
  return { bytes, expected, source: url };
}

function text(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(block, offset, length) {
  const value = text(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) fail("INSTALL_ARCHIVE_INVALID", "a tar header holds a field that is not an octal number");
  return Number.parseInt(value, 8);
}

function safePath(path) {
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("INSTALL_ARCHIVE_INVALID", `the archive holds ${JSON.stringify(path)}, a path that leaves the directory it is unpacked into`, { path });
  }
  return path;
}

// The regular files of a ustar archive, {path, mode, bytes}. Links, devices and extension headers
// are refused, as are absolute or climbing paths, duplicates, bad checksums and a cut archive;
// directory entries are read past.
function readUstar(archive) {
  if (archive.length % BLOCK !== 0) fail("INSTALL_ARCHIVE_INVALID", "the archive is not a whole number of tar blocks");
  const files = [];
  const seen = new Set();
  for (let offset = 0; ;) {
    if (offset + BLOCK > archive.length) fail("INSTALL_ARCHIVE_INVALID", "the archive ends before its end-of-archive blocks");
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (archive.length - offset < 2 * BLOCK || !archive.subarray(offset).every((byte) => byte === 0)) fail("INSTALL_ARCHIVE_INVALID", "the archive does not end in two zero blocks");
      return files;
    }
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (octal(header, 148, 8) !== sum) fail("INSTALL_ARCHIVE_INVALID", "a tar header's checksum does not match its bytes");
    if (text(header, 257, 6) !== "ustar" || header[262] !== 0) fail("INSTALL_ARCHIVE_INVALID", "a header is not a ustar header");
    const prefix = text(header, 345, 155);
    const name = prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`;
    const type = String.fromCharCode(header[156]);
    const size = octal(header, 124, 12);
    const start = offset + BLOCK;
    if (start + size > archive.length) fail("INSTALL_ARCHIVE_INVALID", `${name} is cut short`, { path: name });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "5") {
      safePath(name.endsWith("/") ? name.slice(0, -1) : name);
      continue;
    }
    if (type !== "0" && type !== "\0") fail("INSTALL_ARCHIVE_INVALID", `${name} is a tar entry of type ${JSON.stringify(type)}; only files are unpacked`, { path: name });
    const path = safePath(name);
    if (seen.has(path)) fail("INSTALL_ARCHIVE_INVALID", `${path} is in the archive twice`, { path });
    seen.add(path);
    files.push({ path, mode: octal(header, 100, 8) & 0o777, bytes: archive.subarray(start, start + size) });
  }
}

/** The files of the release under its one version directory, and its manifest. */
function readRelease(bytes, requested) {
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch {
    fail("INSTALL_ARCHIVE_INVALID", "the archive is not gzip data");
  }
  const files = readUstar(tar);
  const top = files[0]?.path.split("/")[0] ?? "";
  const version = top.startsWith(`${ENGINE_NAME}-`) ? top.slice(ENGINE_NAME.length + 1) : "";
  if (!VERSION_PATTERN.test(version) || !files.every((file) => file.path.startsWith(`${top}/`))) {
    fail("INSTALL_ARCHIVE_INVALID", `the archive is not one ${ENGINE_NAME}-<version>/ directory`);
  }
  if (requested !== null && requested !== version) {
    fail("INSTALL_VERSION_MISMATCH", `the archive holds ${ENGINE_NAME} ${version}, not ${requested}`, { required: requested, actual: version });
  }
  const find = (...parts) => files.find((file) => file.path === [top, ...parts].join("/"));
  for (const parts of [ENGINE_ENTRY, ...LAUNCHERS.map((launcher) => launcher.from)]) {
    if (find(...parts) === undefined) fail("INSTALL_ARCHIVE_INVALID", `the archive holds no ${parts.join("/")}`, { path: parts.join("/") });
  }
  let manifest = null;
  try {
    manifest = JSON.parse(find(MANIFEST_FILE)?.bytes.toString("utf8") ?? "null");
  } catch {
    manifest = null;
  }
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.version !== version || !DIGEST_PATTERN.test(String(manifest.installTreeDigest))) {
    fail("INSTALL_ARCHIVE_INVALID", `the archive's ${MANIFEST_FILE} is not an ${MANIFEST_SCHEMA_VERSION} manifest for ${version}`, { path: MANIFEST_FILE });
  }
  return { top, version, manifest, files };
}

async function unpack(release, temporary) {
  for (const file of release.files) {
    const inside = file.path.slice(release.top.length + 1);
    const target = inside === MANIFEST_FILE ? join(temporary, MANIFEST_FILE) : join(temporary, ...file.path.split("/"));
    const offset = relative(temporary, target);
    if (offset === "" || offset.startsWith("..") || isAbsolute(offset)) fail("INSTALL_ARCHIVE_INVALID", `${file.path} would be written outside ${temporary}`, { path: file.path });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: file.mode });
  }
  return join(temporary, release.top);
}

function lastJsonLine(output) {
  try {
    return JSON.parse(String(output).trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
}

function engineUpdate(tree, release, home, at) {
  const run = spawnSync(process.execPath, [join(tree, ...ENGINE_ENTRY), "engine-update", "--from", tree, "--sha256", release.manifest.installTreeDigest, "--version", release.version, "--at", at], {
    cwd: dirname(tree),
    encoding: "utf8",
    env: { ...process.env, EINZBERN_HOME: home },
    maxBuffer: bufferConstants.MAX_LENGTH,
    windowsHide: true,
  });
  const answer = lastJsonLine(run.status === 0 ? run.stdout : run.stderr);
  if (run.status === 0 && answer?.reasonCode === "ENGINE_UPDATED") return answer;
  if (answer !== null && typeof answer.reasonCode === "string") {
    const { ok: _ok, reasonCode, error, ...details } = answer;
    throw new InstallError(reasonCode, String(error ?? reasonCode), details);
  }
  fail("INSTALL_ENGINE_UPDATE_FAILED", `engine-update did not answer: ${String(run.error?.message ?? run.stderr ?? "").trim().split("\n").at(-1)}`);
}

async function placeLaunchers(home, version) {
  const engine = join(home, ENGINE_DIRECTORY);
  const placed = {};
  for (const launcher of LAUNCHERS) {
    const target = join(engine, launcher.to);
    const partial = join(engine, `.${launcher.to}.${randomBytes(6).toString("hex")}.partial`);
    await copyFile(join(engine, version, ...launcher.from), partial);
    await rename(partial, target);
    placed[launcher.to] = target;
  }
  return placed;
}

async function install(options) {
  const { bytes, expected, source } = await obtainArchive(options);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    fail("INSTALL_ARCHIVE_DIGEST_MISMATCH", `${basename(source)} does not have the sha256 it was published with`, { required: expected, actual });
  }
  const release = readRelease(bytes, options.version);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const temporary = join(options.home, `tmp-${randomBytes(8).toString("hex")}`);
  await mkdir(temporary, { recursive: true });
  let report;
  try {
    const tree = await unpack(release, temporary);
    const updated = engineUpdate(tree, release, options.home, at);
    report = { version: release.version, installed: updated.installed, current: updated.current, launchers: await placeLaunchers(options.home, release.version) };
  } finally {
    const trash = join(options.home, TRASH_DIRECTORY);
    await mkdir(trash, { recursive: true });
    await rename(temporary, join(trash, `install-${at.replaceAll(":", "")}-${basename(temporary)}`));
  }
  return {
    ...report,
    archiveSha256: actual,
    installTreeDigest: release.manifest.installTreeDigest,
    next: `node "${join(options.home, ENGINE_DIRECTORY, "einzbern.mjs")}" setup --mode fresh --project <dir> --at <UTC>`,
  };
}

try {
  const result = await install(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "INSTALL_ENGINE_READY", ...result })}\n`);
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "INSTALL_INTERNAL_ERROR";
  const details = error?.details !== null && typeof error?.details === "object" ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
