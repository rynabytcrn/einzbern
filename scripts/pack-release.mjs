#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R2, AC1 (MIN-227 D23, D28): the release archive, the one thing a device
// needs to run the engine, the hook and Atelier with nothing but Node.js.
//
//   node scripts/pack-release.mjs [--version <version>] [--out <directory>]
//
// --version defaults to package.json's and must be the version the built engine answers as, since
// engine-update refuses an archive whose engine runs as another; --out defaults to dist/release, a
// build output that is never committed. Build first: the bundles, the skill and the digest are all
// made from dist/build. Nothing is fetched.
//
// It stages einzbern-<version>/, the directory an installer unpacks and engine-update installs as
// engine/<version>/ of the device directory (packages/core/src/engine-home.ts):
//
//   scripts/einzbern.mjs        the CLI entry and every module it reaches, as one file (scripts/lib/bundle.mjs)
//   scripts/einzbern-hook.mjs   the hook entry as one file, which the stable hook launcher imports
//   launchers/einzbern.mjs      scripts/einzbern-launcher.mjs as it is; installed as engine/einzbern.mjs
//   launchers/hook.mjs          scripts/einzbern-hook-launcher.mjs as it is; installed as engine/hook.mjs
//   atelier/                    the portal as one file, portal.mjs, and the static files it serves; the
//                               bundle carries the engine's registry lock and device-home modules, the
//                               same builds register, unregister and repoint use, once each
//   skill/mana-orchestrate/     the skill as skill-render writes it for this version
//   README*.md, CHANGELOG.md, LICENSE, NOTICE, THIRD_PARTY_NOTICES.txt
//   manifest.json               einzbern.release-manifest.v1: version, nodeFloor, installTreeDigest, files
//
// installTreeDigest is the install-tree digest (specs/release-trust-v1.md) of that directory
// without manifest.json, the one file that cannot hold its own digest, and files lists the entries
// it is taken over; an installer sets manifest.json aside before engine-update checks the tree.
// The directory is written into einzbern-<version>.tar.gz through scripts/lib/tar.mjs and a gzip
// header that names no time and no platform, so the same sources give the same bytes, and
// einzbern-<version>.tar.gz.sha256 states the archive's sha256 in the format of sha256sum.
//
// Prints {"ok":true,"reasonCode":"RELEASE_PACKED",...} on stdout, or a reason code and its details
// on stderr with exit code 1.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { constants as zlibConstants, gzipSync } from "node:zlib";

import { bundleEntry } from "./lib/bundle.mjs";
import { writeUstar } from "./lib/tar.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const USAGE = "usage: node scripts/pack-release.mjs [--version <version>] [--out <directory>]";
const DEFAULT_OUT = "dist/release";

const RELEASE_MANIFEST_SCHEMA_VERSION = "einzbern.release-manifest.v1";
const RELEASE_MANIFEST_FILE = "manifest.json";

// Where Atelier's engine is, seen from atelier/portal.mjs in the release: the CLI of the same
// version. The portal source computes BUNDLED_CLI from its own place in the repository; the
// release fixes it to this constant, so Atelier always drives the engine it was packed with.
const ATELIER_CLI = "../scripts/einzbern.mjs";
// The files portal.mjs reads from its own directory to answer its GET routes.
const ATELIER_STATIC_FILES = Object.freeze(["atelier-brand-mark.svg", "index.html", "locales.js", "tokens.css", "ds-static-bridges.snapshot.js"]);
// The portal's modules and how each is staged for the bundle: the names bridge imports the
// TypeScript source of the names module, which the bundler does not read, so the stage carries
// the build of that module in its place.
const NAMES_SOURCE_SPECIFIER = "\"../../packages/core/src/names.ts\"";
const NAMES_BUILD_SPECIFIER = "\"../../packages/core/src/names.js\"";
// Atelier holds the device registry lock through the engine's own modules, which the portal reaches
// through scripts/lib/registry-lock.mjs: the bridge re-exports the builds of the file lock and of the
// device directory from dist/build. The stage carries those two builds beside the names build, where
// the device directory's own import of ./names.js finds the one names module, and points the staged
// bridge at them; dist/build is not part of a release.
const REGISTRY_LOCK_MODULES = Object.freeze(["file-lock.js", "device-home.js"]);
const registryLockBuildSpecifier = (module) => `"../../dist/build/packages/core/src/${module}"`;
const registryLockStagedSpecifier = (module) => `"../../packages/core/src/${module}"`;
const BUNDLED_CLI_DECLARATION = /^const BUNDLED_CLI = .*;$/gmu;
const README = /^README(?:\.[A-Za-z-]+)?\.md$/u;
const DOCUMENTS = Object.freeze(["CHANGELOG.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]);

class PackError extends Error {
  constructor(reasonCode, message, details = {}) {
    super(message);
    this.name = "PackError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

function fail(reasonCode, message, details = {}) {
  throw new PackError(reasonCode, message, details);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--version" && flag !== "--out") || value === undefined || value.startsWith("--") || values.has(flag)) {
      fail("PACK_USAGE", USAGE);
    }
    values.set(flag, value);
  }
  return {
    version: values.get("--version") ?? null,
    out: values.has("--out") ? resolve(values.get("--out")) : resolve(repositoryRoot, DEFAULT_OUT),
  };
}

async function importBuilt(path) {
  const absolute = join(repositoryRoot, "dist", "build", ...path.split("/"));
  if (!existsSync(absolute)) fail("PACK_BUILD_MISSING", `dist/build/${path} does not exist: build before packing`, { remedy: "build" });
  return import(pathToFileURL(absolute).href);
}

async function writeStaged(root, path, content) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function copyStaged(root, path, source) {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

/** Every regular file under `root`, as a relative POSIX path; anything else is refused. */
async function treeFiles(root, relativePath = "") {
  const directory = relativePath === "" ? root : join(root, ...relativePath.split("/"));
  const files = [];
  for (const name of await readdir(directory)) {
    const path = relativePath === "" ? name : `${relativePath}/${name}`;
    const stats = await lstat(join(directory, name));
    if (stats.isDirectory()) files.push(...await treeFiles(root, path));
    else if (stats.isFile()) files.push(path);
    else fail("PACK_TREE_INVALID", `${path} in the staged release is not a regular file`, { path });
  }
  return files;
}

/**
 * The Atelier bundle: portal/portal.mjs and the modules it imports are staged as they sit in the
 * repository, under a package.json of their own so the bundle's labels read as the repository's,
 * with BUNDLED_CLI fixed to ATELIER_CLI, the names bridge pointed at the build of the names module
 * and the registry-lock bridge pointed at the builds staged beside it. The portal source itself is
 * not changed.
 */
async function bundleAtelier(stage, coreBuild) {
  const root = join(stage, "atelier-source");
  const portal = await readFile(join(repositoryRoot, "portal", "portal.mjs"), "utf8");
  if ((portal.match(BUNDLED_CLI_DECLARATION) ?? []).length !== 1) {
    fail("PACK_ATELIER_UNBOUND", "portal/portal.mjs does not declare BUNDLED_CLI on one line of its own, so the release cannot point Atelier at its engine");
  }
  const names = await readFile(join(repositoryRoot, "scripts", "lib", "names.mjs"), "utf8");
  if (names.split(NAMES_SOURCE_SPECIFIER).length !== 2) {
    fail("PACK_ATELIER_UNBOUND", `scripts/lib/names.mjs no longer re-exports ${NAMES_SOURCE_SPECIFIER} once, so the Atelier stage no longer matches it`);
  }
  const registryLock = await readFile(join(repositoryRoot, "scripts", "lib", "registry-lock.mjs"), "utf8");
  for (const module of REGISTRY_LOCK_MODULES) {
    if (registryLock.split(registryLockBuildSpecifier(module)).length !== 2) {
      fail("PACK_ATELIER_UNBOUND", `scripts/lib/registry-lock.mjs no longer re-exports ${registryLockBuildSpecifier(module)} once, so the Atelier stage no longer matches it`);
    }
  }
  let stagedRegistryLock = registryLock;
  for (const module of REGISTRY_LOCK_MODULES) stagedRegistryLock = stagedRegistryLock.replace(registryLockBuildSpecifier(module), registryLockStagedSpecifier(module));
  await writeStaged(root, "package.json", `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await writeStaged(root, "portal/portal.mjs", portal.replace(BUNDLED_CLI_DECLARATION, `const BUNDLED_CLI = join(portalRoot, ${JSON.stringify(ATELIER_CLI)});`));
  await copyStaged(root, "portal/locale-contract.mjs", join(repositoryRoot, "portal", "locale-contract.mjs"));
  await copyStaged(root, "scripts/lib/runtime-capacity.mjs", join(repositoryRoot, "scripts", "lib", "runtime-capacity.mjs"));
  await writeStaged(root, "scripts/lib/names.mjs", names.replace(NAMES_SOURCE_SPECIFIER, NAMES_BUILD_SPECIFIER));
  await writeStaged(root, "scripts/lib/registry-lock.mjs", stagedRegistryLock);
  const gateRunBridge = await readFile(join(repositoryRoot, "scripts/lib/gate-run.mjs"), "utf8");
  const gateRunBuild = '"../../dist/build/packages/core/src/gate-run-record.js"';
  if (gateRunBridge.split(gateRunBuild).length !== 2) fail("PACK_ATELIER_UNBOUND", "gate-run bridge no longer names its compiled receipt contract once");
  await writeStaged(root, "scripts/lib/gate-run.mjs", gateRunBridge.replace(gateRunBuild, '"../../packages/core/src/gate-run-record.js"'));
  await copyStaged(root, "packages/core/src/gate-run-record.js", join(coreBuild, "gate-run-record.js"));
  await copyStaged(root, "packages/protocol/src/index.js", join(repositoryRoot, "dist/build/packages/protocol/src/index.js"));
  await copyStaged(root, "scripts/lib/canonical-order.mjs", join(repositoryRoot, "scripts/lib/canonical-order.mjs"));
  await copyStaged(root, "packages/core/src/names.js", join(coreBuild, "names.js"));
  for (const module of REGISTRY_LOCK_MODULES) await copyStaged(root, `packages/core/src/${module}`, join(coreBuild, module));
  return (await bundleEntry(join(root, "portal", "portal.mjs"))).code;
}

// RFC 1952: header bytes 4 to 7 are the modification time, which zlib leaves 0, and byte 9 names
// the operating system, which zlib takes from the platform it was built for; 255 (unknown) makes
// the header the same wherever the archive is packed.
function gzip(bytes) {
  const compressed = gzipSync(bytes, { level: zlibConstants.Z_BEST_COMPRESSION });
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) fail("PACK_INTERNAL_ERROR", "zlib did not write a gzip header");
  compressed.fill(0, 4, 8);
  compressed[9] = 0xff;
  return compressed;
}

async function writeAtomically(path, content) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.partial`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function packRelease({ version: requested, out }) {
  const core = await importBuilt("packages/core/src/index.js");
  const { NODE_FLOOR } = await importBuilt("packages/core/src/node-floor.js");
  const { isEngineVersion } = await importBuilt("packages/core/src/format-version.js");
  const { BRAND } = await importBuilt("packages/core/src/names.js");
  const { runCli } = await importBuilt("packages/cli/src/index.js");
  const version = requested ?? JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  if (!isEngineVersion(version)) fail("PACK_VERSION_INVALID", `${String(version)} is not an engine version`, { actual: String(version) });
  if (version !== core.FRAMEWORK_VERSION) {
    fail("PACK_VERSION_MISMATCH", `the engine in dist/build answers as ${core.FRAMEWORK_VERSION}; an archive named ${version} could not be installed`, {
      required: core.FRAMEWORK_VERSION,
      actual: version,
    });
  }
  const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const packages = await readdir(join(repositoryRoot, "packages"), { withFileTypes: true });
  const manifestPaths = ["package.json", ...packages.filter((entry) => entry.isDirectory() && existsSync(join(repositoryRoot, "packages", entry.name, "package.json"))).map((entry) => `packages/${entry.name}/package.json`)];
  for (const path of manifestPaths) {
    const manifest = path === "package.json" ? rootManifest : JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
    if (manifest.version !== version) fail("PACK_VERSION_MISMATCH", `${path} does not match the requested release`, { path, required: version, actual: manifest.version });
  }
  const frameworkSource = await readFile(join(repositoryRoot, "packages/core/src/framework-version.ts"), "utf8");
  const declarations = [...frameworkSource.matchAll(/^export const FRAMEWORK_VERSION = "(\d+\.\d+\.\d+)" as const;$/gmu)];
  if (declarations.length !== 1 || declarations[0][1] !== version) {
    fail("PACK_VERSION_MISMATCH", "the actual core source does not match the built release", { required: version, actual: declarations.length === 1 ? declarations[0][1] : null });
  }
  const name = `${BRAND.engine.id}-${version}`;
  const stage = await realpath(await mkdtemp(join(tmpdir(), `${BRAND.engine.id}-pack-`)));
  try {
    const tree = join(stage, name);
    await writeStaged(tree, "scripts/einzbern.mjs", (await bundleEntry(join(repositoryRoot, "scripts", "einzbern.mjs"))).code);
    await writeStaged(tree, "scripts/einzbern-hook.mjs", (await bundleEntry(join(repositoryRoot, "scripts", "einzbern-hook.mjs"))).code);
    await copyStaged(tree, "launchers/einzbern.mjs", join(repositoryRoot, "scripts", "einzbern-launcher.mjs"));
    await copyStaged(tree, "launchers/hook.mjs", join(repositoryRoot, "scripts", "einzbern-hook-launcher.mjs"));
    const atelier = BRAND.portal.id;
    await writeStaged(tree, `${atelier}/portal.mjs`, await bundleAtelier(stage, join(repositoryRoot, "dist", "build", "packages", "core", "src")));
    for (const file of ATELIER_STATIC_FILES) await copyStaged(tree, `${atelier}/${file}`, join(repositoryRoot, "portal", file));
    let rendered = "";
    await runCli(["skill-render", "--out", join(tree, "skill", BRAND.helper.id), "--version", version], {
      write: (value) => {
        rendered += value;
      },
    });
    if (JSON.parse(rendered).reasonCode !== "SKILL_RENDERED") fail("PACK_INTERNAL_ERROR", "skill-render did not render the skill");
    await copyStaged(tree, "specs/dispatch-admission-evidence-v1.md", join(repositoryRoot, "specs/dispatch-admission-evidence-v1.md"));
    const documents = [...(await readdir(repositoryRoot)).filter((file) => README.test(file)).sort(), ...DOCUMENTS];
    for (const file of documents) await copyStaged(tree, file, join(repositoryRoot, file));
    const digest = await core.computeInstallTreeDigest(tree);
    const manifest = {
      schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
      version,
      nodeFloor: NODE_FLOOR,
      installTreeDigest: digest.sha256,
      files: digest.entries,
    };
    await writeStaged(tree, RELEASE_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    const records = [];
    for (const path of await treeFiles(tree)) records.push({ path: `${name}/${path}`, bytes: await readFile(join(tree, ...path.split("/"))) });
    const archive = gzip(writeUstar(records));
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const archiveName = `${name}.tar.gz`;
    await mkdir(out, { recursive: true });
    await writeAtomically(join(out, archiveName), archive);
    await writeAtomically(join(out, `${archiveName}.sha256`), `${sha256}  ${archiveName}\n`);
    return {
      version,
      archive: join(out, archiveName),
      sha256,
      sha256File: join(out, `${archiveName}.sha256`),
      installTreeDigest: digest.sha256,
      files: records.length,
      bytes: archive.length,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

try {
  const result = await packRelease(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, reasonCode: "RELEASE_PACKED", ...result })}\n`);
} catch (error) {
  const reasonCode = typeof error?.reasonCode === "string" ? error.reasonCode : "PACK_INTERNAL_ERROR";
  const details = error?.details !== null && typeof error?.details === "object" ? error.details : {};
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, ...details, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
