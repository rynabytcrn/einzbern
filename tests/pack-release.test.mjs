// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-481 R2, AC1: scripts/pack-release.mjs writes einzbern-<version>.tar.gz and its
// .sha256. Two packs of one tree are the same bytes. Unpacked into a directory that holds nothing
// but the archive's files, the engine lists its commands and creates and reads a library with
// Node.js alone, Atelier reaches the engine beside it, and the hook entry answers nothing on an
// older Node.js. The manifest states the install-tree digest of the unpacked directory (without
// manifest.json itself), the skill directory holds SKILL.md and the six references, and the
// launchers are the templates as they are. scripts/lib/tar.mjs writes the bytes P8's independent
// rebuild writes, reads them back, and refuses the entries an unpacker must not follow.

import "./helpers/device-home.mjs";
import { runCaptureCliUpgradeMatrix } from "./helpers/capture-cli-upgrade.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync, constants as zlibConstants } from "node:zlib";
import test, { after } from "node:test";

import { BRAND, FRAMEWORK_VERSION, computeInstallTreeDigest } from "../dist/build/packages/core/src/index.js";
import { NODE_FLOOR } from "../dist/build/packages/core/src/node-floor.js";
import { normalizedInstallBytes } from "../dist/build/packages/core/src/install-tree-digest.js";
import {
  P8_RELEASE_ARTIFACTS,
  P8_RELEASE_ARCHIVE,
  P8_RELEASE_ARCHIVE_SHA256,
  buildCanonicalUstar,
  buildP8ReleaseArtifacts,
} from "../scripts/lib/p8-workflow-rc.mjs";
import { verifySkillSpecifications } from "../scripts/lib/release-package-inputs.mjs";
import { TAR_REASON_CODES, readUstar, tarMode, writeUstar } from "../scripts/lib/tar.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packScript = join(repositoryRoot, "scripts/pack-release.mjs");
const RELEASE = `einzbern-${FRAMEWORK_VERSION}`;
const ARCHIVE = `${RELEASE}.tar.gz`;
const REFERENCES = Object.freeze(["doctor.md", "install.md", "migrate.md", "restore.md", "uninstall.md", "update.md"]);
const SPECIFICATIONS = Object.freeze([
  "dispatch-admission-evidence-v1.md", "dot-execution-v1.md", "native-tool-evidence-v1.md", "host-fallback-v1.md", "engine-model-policy-v1.md",
  "shared-submit-v1.md", "config-backup-v1.md", "dot-rules-v1.md", "context-v1.md", "work-content-v1.md",
]);

const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-pack-release-")));
after(() => rm(base, { recursive: true, force: true }));

function node(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", ...options });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pack(out, extra = []) {
  return node([packScript, "--out", out, ...extra]);
}

/** Packs once into <base>/out and unpacks the archive, on its own, into <base>/alone. */
async function packAndUnpack() {
  const out = join(base, "out");
  const run = pack(out);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const archive = await readFile(join(out, ARCHIVE));
  const entries = readUstar(gunzipSync(archive));
  const alone = join(base, "alone");
  for (const entry of entries) {
    const target = join(alone, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { mode: entry.mode });
  }
  return { out, report, archive, entries, alone, tree: join(alone, RELEASE) };
}

let packed = null;
function packedRelease() {
  packed ??= packAndUnpack();
  return packed;
}

test("605: every contract referenced by the shipped Skill resolves to manifest-verified archive bytes", async () => {
  const { entries } = await packedRelease();
  const files = new Map(entries.map((entry) => [entry.path.slice(RELEASE.length + 1), entry.bytes]));
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  const references = new Set();
  for (const [path, bytes] of files) {
    if (!path.startsWith("skill/mana-orchestrate/") || !path.endsWith(".md")) continue;
    for (const [reference] of bytes.toString("utf8").matchAll(/\bspecs\/[A-Za-z0-9._/-]+\.md\b/gu)) references.add(reference);
  }
  assert.ok(references.has("specs/context-v1.md"));
  assert.ok(references.has("specs/work-content-v1.md"));
  for (const reference of references) {
    assert.ok(files.has(reference), reference);
    assert.deepEqual(files.get(reference), await readFile(join(repositoryRoot, reference)), reference);
    assert.equal(manifest.files.find((entry) => entry.path === reference)?.sha256, sha256(files.get(reference)), reference);
  }
});

test("605: a packaging-list omission is refused from the actual Skill reference before any archive is written", async () => {
  const source = await readFile(packScript, "utf8");
  const inputs = await readFile(join(repositoryRoot, "scripts/lib/release-package-inputs.mjs"), "utf8");
  for (const specification of ["context-v1.md", "work-content-v1.md"]) {
    const copy = join(base, `missing-${specification}`);
    await mkdir(join(copy, "scripts/lib"), { recursive: true });
    const mutated = inputs.replace(`, "${specification}"`, "");
    assert.notEqual(mutated, inputs);
    await writeFile(join(copy, "scripts/pack-release.mjs"), source);
    await writeFile(join(copy, "scripts/lib/release-package-inputs.mjs"), mutated);
    for (const name of await readdir(join(repositoryRoot, "scripts/lib"))) {
      if (name !== "release-package-inputs.mjs") await symlink(join(repositoryRoot, "scripts/lib", name), join(copy, "scripts/lib", name));
    }
    for (const name of await readdir(join(repositoryRoot, "scripts"))) {
      if (name !== "pack-release.mjs" && name !== "lib") await symlink(join(repositoryRoot, "scripts", name), join(copy, "scripts", name));
    }
    for (const name of ["package.json", "packages", "dist", "portal", "specs"]) await symlink(join(repositoryRoot, name), join(copy, name));
    const out = join(copy, "out");
    const run = node([join(copy, "scripts/pack-release.mjs"), "--out", out]);
    assert.equal(run.status, 1, safeDiagnostic(run.stderr));
    const refusal = JSON.parse(lastLine(run.stderr));
    assert.equal(refusal.reasonCode, "PACK_SKILL_SPEC_MISSING");
    assert.equal(refusal.reference, `specs/${specification}`);
    assert.equal(refusal.source, "skill/mana-orchestrate/SKILL.md");
    assert.equal(existsSync(out), false, "the refusal does not leave a publishable archive");
  }
});

/** A clean device, home and working directory under `name`, for a process run from the unpacked release. */
async function environment(name) {
  const root = join(base, name);
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "work"), { recursive: true });
  // TCRN-CROSS-STORY-526 (TCRN-CROSS-SUB-454): Atelier starts only with TCRN_PORTAL_ACTOR set, so the
  // release's Atelier runs here as agent:test-portal and reaches the registry check it is asked about.
  const env = { ...process.env, HOME: join(root, "home"), EINZBERN_HOME: join(root, "home", "einzbern"), TCRN_PORTAL_ACTOR: "agent:test-portal" };
  for (const key of ["TCRN_WORKFLOW_CLI", "TCRN_PORTAL_LIBRARY", "TCRN_PORTAL_PORT"]) delete env[key];
  return { root, env, cwd: join(root, "work") };
}

function lastLine(text) {
  return text.trim().split("\n").at(-1);
}

function safeDiagnostic(value) {
  let text = String(value ?? "");
  for (const [path, label] of [[repositoryRoot, "<repository>"], [base, "<fixture>"], [homedir(), "<home>"]]) {
    if (path) text = text.replaceAll(path, label);
  }
  return text.slice(0, 1200);
}

async function filesUnder(root, relativePath = "") {
  const found = [];
  for (const entry of await readdir(join(root, relativePath), { withFileTypes: true })) {
    const path = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesUnder(root, path));
    else found.push(path);
  }
  return found.sort();
}

test("481-R2, MIN-235 D14: two packs are byte-identical and the .sha256 covers the complete archive including manifest", async () => {
  const first = await packedRelease();
  const second = pack(join(base, "again"));
  assert.equal(second.status, 0, second.stderr);
  const again = await readFile(join(base, "again", ARCHIVE));
  assert.ok(first.archive.equals(again), "the second pack wrote other bytes");
  assert.equal(first.report.reasonCode, "RELEASE_PACKED");
  assert.equal(first.report.version, FRAMEWORK_VERSION);
  assert.equal(P8_RELEASE_ARCHIVE, ARCHIVE);
  assert.equal(P8_RELEASE_ARCHIVE_SHA256, `${ARCHIVE}.sha256`);
  assert.equal(first.report.sha256, sha256(first.archive));
  assert.equal(JSON.parse(second.stdout).sha256, first.report.sha256);
  const checksum = await readFile(join(first.out, `${ARCHIVE}.sha256`));
  const candidate = buildP8ReleaseArtifacts({
    sourceArchive: Buffer.from("source fixture\n", "utf8"),
    sbom: Buffer.from('{"bomFormat":"CycloneDX"}\n', "utf8"),
    releaseArchive: first.archive,
    releaseArchiveSha256: checksum,
  });
  assert.deepEqual([...candidate.keys()].sort(), [...P8_RELEASE_ARTIFACTS].sort());
  assert.ok(candidate.get(ARCHIVE).equals(first.archive));
  assert.ok(candidate.get(`${ARCHIVE}.sha256`).equals(checksum));
  for (const out of [first.out, join(base, "again")]) {
    assert.equal(await readFile(join(out, `${ARCHIVE}.sha256`), "utf8"), `${first.report.sha256}  ${ARCHIVE}\n`);
  }
  const changedManifest = first.entries.map((entry) => entry.path === `${RELEASE}/manifest.json`
    ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from(" ", "utf8")]) }
    : entry);
  const repackedManifest = gzipSync(writeUstar(changedManifest), { level: zlibConstants.Z_BEST_COMPRESSION });
  repackedManifest.fill(0, 4, 8);
  repackedManifest[9] = 0xff;
  assert.notEqual(sha256(repackedManifest), first.report.sha256, "changing the packaged manifest changes the whole-archive digest");
  assert.notEqual(`${sha256(repackedManifest)}  ${ARCHIVE}\n`, await readFile(join(first.out, `${ARCHIVE}.sha256`), "utf8"));
  // The gzip header names no time and no platform.
  assert.deepEqual([...first.archive.subarray(0, 4)], [0x1f, 0x8b, 8, 0]);
  assert.deepEqual([...first.archive.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(first.archive[9], 0xff);
});

test("481-R2: the archive is one einzbern-<version>/ directory in the release layout, with modes by content", async () => {
  const { entries, archive } = await packedRelease();
  assert.ok(entries.every((entry) => entry.path.startsWith(`${RELEASE}/`)), "every entry lies in the version directory");
  const paths = entries.map((entry) => entry.path.slice(RELEASE.length + 1));
  const readmes = (await readdir(repositoryRoot)).filter((name) => /^README(?:\.[A-Za-z-]+)?\.md$/u.test(name));
  const template = await filesUnder(join(repositoryRoot, "skill/mana-orchestrate"));
  const expected = [
    "scripts/einzbern.mjs", "scripts/einzbern-hook.mjs", "scripts/library-catalog-worker.mjs", "launchers/einzbern.mjs", "launchers/hook.mjs",
    "atelier/portal.mjs", "atelier/ds-static-bridges.snapshot.js", "atelier/atelier-brand-mark.svg", "atelier/index.html", "atelier/locales.js", "atelier/tokens.css",
    "skill/mana-orchestrate/SKILL.md", ...template.map((path) => `skill/mana-orchestrate/${path}`),
    ...SPECIFICATIONS.map(name => `specs/${name}`),
    ...readmes, "CHANGELOG.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt", "manifest.json",
  ];
  assert.deepEqual([...paths].sort(), [...new Set(expected)].sort());
  const byPath = new Map(entries.map((entry) => [entry.path.slice(RELEASE.length + 1), entry]));
  for (const name of SPECIFICATIONS) {
    const path = `specs/${name}`;
    assert.deepEqual(byPath.get(path).bytes, await readFile(join(repositoryRoot, path)), `${path}: public contract bytes are preserved, not rendered or rewritten`);
  }
  // Installed consumers can obtain the closed input vocabulary without TS sources.
  for (const [name, fields] of Object.entries({
    "engine-model-policy-v1.md": ["engine-model-policy-save", "expected-host-revision", "operation-id", "tcrn.engine-model-policy.v2"],
    "host-fallback-v1.md": ["tcrn.host-execution-request.v1", "execution-host-prepare", "selectionObservations", "fallbackBoundaryAssessment", "saveRequirement", "local correlation", "coordination-only", "targets=[]"],
    "dot-execution-v1.md": ["actualCapabilityEvidenceRefs", "authorizationEvidenceRef", "occupancyObservation", "revisionBinding", "contextRead", "effectiveRoots", "exactDelegation"],
    "native-tool-evidence-v1.md": ["rawResponseValue", "statusPointer", "statusMapping", "terminalObservation", "providerPointers", "NativeRetryReconciliation", "--prior", "--retry-from", "--reconciliation"],
    "shared-submit-v1.md": ["completeInventoryDigest", "engineOutputMembers", "writerHandoff", "observedAt", "contentBase64", "memberSetDigest", "lastError"],
  })) for (const field of fields) assert.ok(byPath.get(`specs/${name}`).bytes.toString("utf8").includes(field), `${name} documents ${field}`);
  assert.ok(byPath.get("atelier/ds-static-bridges.snapshot.js").bytes.equals(await readFile(join(repositoryRoot, "portal/ds-static-bridges.snapshot.js"))), "the archive retains exact published bridge bytes");
  assert.ok(byPath.get("THIRD_PARTY_NOTICES.txt").bytes.equals(await readFile(join(repositoryRoot, "THIRD_PARTY_NOTICES.txt"))), "the archive retains vendored runtime license notices");
  assert.ok(byPath.get("launchers/einzbern.mjs").bytes.equals(await readFile(join(repositoryRoot, "scripts/einzbern-launcher.mjs"))));
  assert.ok(byPath.get("launchers/hook.mjs").bytes.equals(await readFile(join(repositoryRoot, "scripts/einzbern-hook-launcher.mjs"))));
  for (const path of template) {
    assert.ok(byPath.get(`skill/mana-orchestrate/${path}`).bytes.equals(await readFile(join(repositoryRoot, "skill/mana-orchestrate", path))), path);
  }
  for (const entry of entries) {
    assert.equal(entry.mode, entry.bytes.subarray(0, 2).toString("latin1") === "#!" ? 0o755 : 0o644, entry.path);
    const text = entry.bytes.toString("utf8");
    assert.equal(text.includes(repositoryRoot), false, `${entry.path} names the repository's path`);
    assert.equal(text.includes(homedir()), false, `${entry.path} names the home directory`);
  }
  // The headers are the deterministic ones: mtime 0, owner and group 0.
  const header = gunzipSync(archive).subarray(0, 512);
  assert.equal(header.subarray(136, 148).toString("latin1"), "00000000000\0");
  assert.equal(header.subarray(108, 124).toString("latin1"), "0000000\0".repeat(2));
});

test("481-AC1: unpacked where there is only Node.js, the engine lists its commands, creates a library and reads it", async () => {
  const { alone, tree } = await packedRelease();
  assert.equal(existsSync(join(tree, "node_modules")), false);
  assert.equal(existsSync(join(tree, "dist")), false);
  const { root, env, cwd } = await environment("ac1");
  const cli = join(tree, "scripts/einzbern.mjs");
  const commands = node([cli, "commands"], { cwd, env });
  assert.equal(commands.status, 0, commands.stderr);
  const catalog = JSON.parse(commands.stdout);
  assert.equal(catalog.reasonCode, "CLI_CATALOG_READY");
  const names = catalog.commands.map((entry) => entry.name);
  for (const verb of ["init", "status", "engine-update", "skill-render"]) assert.ok(names.includes(verb), verb);

  const library = join(root, "library");
  const init = node([cli, "init", "--workspace", library, "--at", "2026-09-27T00:00:00Z"], { cwd, env });
  assert.equal(init.status, 0, init.stderr);
  const created = JSON.parse(init.stdout);
  assert.equal(created.reasonCode, "LIBRARY_CREATED");
  const status = node([cli, "status", "--workspace", library], { cwd, env });
  assert.equal(status.status, 0, status.stderr);
  const read = JSON.parse(status.stdout);
  assert.equal(read.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(read.workspaceId, created.libraryId);
  assert.equal(read.engineVersion, FRAMEWORK_VERSION);
  // The unpacked directory holds the archive's files and nothing the runs added.
  assert.deepEqual(await readdir(alone), [RELEASE]);
});

test("481-R2: the manifest states the install-tree digest of the unpacked directory without itself", async () => {
  const { tree } = await packedRelease();
  const manifest = JSON.parse(await readFile(join(tree, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "version", "nodeFloor", "installTreeDigest", "files"]);
  assert.equal(manifest.schemaVersion, "einzbern.release-manifest.v1");
  assert.equal(manifest.version, FRAMEWORK_VERSION);
  assert.notEqual(manifest.schemaVersion, manifest.version);
  assert.equal(manifest.nodeFloor, NODE_FLOOR);
  for (const name of SPECIFICATIONS) {
    const path = `specs/${name}`; const contract = manifest.files.find(entry => entry.path === path);
    assert.ok(contract, `${path} participates in the installed content manifest`);
    assert.equal(contract.sha256, sha256(normalizedInstallBytes(await readFile(join(tree, path)))));
  }
  const aside = join(base, "manifest-aside");
  await mkdir(aside, { recursive: true });
  await rename(join(tree, "manifest.json"), join(aside, "manifest.json"));
  try {
    const digest = await computeInstallTreeDigest(tree);
    assert.equal(manifest.installTreeDigest, digest.sha256);
    assert.deepEqual(manifest.files, JSON.parse(JSON.stringify(digest.entries)));
  } finally {
    await rename(join(aside, "manifest.json"), join(tree, "manifest.json"));
  }
  const covered = manifest.files[0];
  const coveredPath = join(tree, ...covered.path.split("/"));
  const coveredBytes = await readFile(coveredPath);
  assert.ok(coveredBytes.length > 0);
  const alteredBytes = Buffer.from(coveredBytes);
  alteredBytes[0] ^= 1;
  await writeFile(coveredPath, alteredBytes);
  try {
    assert.notEqual((await computeInstallTreeDigest(tree)).sha256, manifest.installTreeDigest, "any other covered byte changes the tree digest");
  } finally {
    await writeFile(coveredPath, coveredBytes);
  }
});

test("481-R2: the skill directory holds SKILL.md for this version and the six references", async () => {
  const { tree } = await packedRelease();
  const skill = join(tree, "skill/mana-orchestrate");
  const markdown = await readFile(join(skill, "SKILL.md"), "utf8");
  assert.ok(markdown.startsWith("---\nname: mana-orchestrate\n"), "SKILL.md opens with its frontmatter");
  assert.ok(markdown.includes(`Einzbern ${FRAMEWORK_VERSION}`), "SKILL.md is rendered for this version");
  assert.deepEqual((await readdir(join(skill, "references"))).sort(), REFERENCES);
  assert.ok(existsSync(join(skill, "agents/openai.yaml")));
});

test("481-R2: Atelier runs from the release, serves its static files and reaches the engine beside it", async () => {
  const { tree } = await packedRelease();
  const source = await readFile(join(repositoryRoot, "portal/portal.mjs"), "utf8");
  const served = [...source.matchAll(/join\(portalRoot, "([^"]+)"\)/gu)].map((match) => match[1]);
  assert.ok(served.length > 0);
  for (const file of served) assert.ok(existsSync(join(tree, "atelier", file)), `atelier/${file} is missing`);
  const packedPortal = await readFile(join(tree, "atelier/portal.mjs"), "utf8");
  assert.match(packedPortal, /BUNDLED_CLI[^;]*["']\.\.\/scripts\/einzbern\.mjs["']/u, "the release Atelier must target its colocated CLI");
  // With no library registered the portal stops at startup, after library-list answered through
  // ../scripts/einzbern.mjs; an unreachable engine would stop it with PORTAL_CLI_UNAVAILABLE.
  const { env, cwd } = await environment("atelier");
  const innerCli = node([join(tree, "scripts/einzbern.mjs"), "library-list"], { cwd: join(tree, "atelier"), env });
  const bridge = "atelier/portal.mjs -> ../scripts/einzbern.mjs (library-list)";
  const diagnostic = (portal) => safeDiagnostic(JSON.stringify({
    bridge,
    innerCli: { status: innerCli.status, signal: innerCli.signal, stdout: innerCli.stdout, stderr: innerCli.stderr },
    portal: { status: portal.status, signal: portal.signal, stdout: portal.stdout, stderr: portal.stderr },
  }));
  assert.equal(innerCli.status, 0, diagnostic({ status: null, signal: null, stdout: "", stderr: "" }));
  let registry;
  try { registry = JSON.parse(innerCli.stdout); } catch { assert.fail(`Packaged library-list did not return JSON: ${diagnostic({ status: null, signal: null, stdout: "", stderr: "" })}`); }
  assert.deepEqual(registry.entries, [], `The clean device should have an empty registry: ${diagnostic({ status: null, signal: null, stdout: "", stderr: "" })}`);
  const catalog = node([join(tree, "scripts/library-catalog-worker.mjs")], { cwd, env });
  assert.equal(catalog.status, 0, safeDiagnostic(catalog.stderr));
  assert.deepEqual(JSON.parse(catalog.stdout), { ok: true, entries: [] });
  const run = node([join(tree, "atelier/portal.mjs")], { cwd, env, timeout: 60_000 });
  assert.equal(run.status, 2, diagnostic(run));
  assert.equal(run.stdout, "", diagnostic(run));
  let startup;
  try { startup = JSON.parse(lastLine(run.stderr)); } catch { assert.fail(`Atelier startup did not return a JSON diagnostic: ${diagnostic(run)}`); }
  assert.equal(startup.reasonCode, "PORTAL_LIBRARY_REGISTRY_EMPTY", `Atelier packaged CLI startup diagnostic (${bridge}): ${diagnostic(run)}; startup=${safeDiagnostic(JSON.stringify({ reasonCode: startup.reasonCode, error: startup.error }))}`);
});

test("catalog worker in the Node-only archive rereads real project metadata", async () => {
  const { tree } = await packedRelease();
  const { root, env, cwd } = await environment("archive-catalog-worker");
  const library = join(root, "library"), project = join(root, "project");
  await mkdir(project);
  const invoke = args => {
    const run = node([join(tree, "scripts/einzbern.mjs"), ...args], { cwd, env });
    assert.equal(run.status, 0, safeDiagnostic(run.stderr));
    return JSON.parse(run.stdout);
  };
  const at = "2026-10-25T00:00:00Z";
  invoke(["init", "--workspace", library, "--project-name", "Archive catalog", "--at", at]);
  const created = invoke(["project-create", "--workspace", library, "--external-key", "ARCHIVE-CATALOG", "--name", "Before", "--at", at]);
  invoke(["library-register", "--project", project, "--library", library, "--project-id", created.record.id, "--at", at]);
  const read = () => {
    const run = node([join(tree, "scripts/library-catalog-worker.mjs")], { cwd, env });
    assert.equal(run.status, 0, safeDiagnostic(run.stderr));
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].projectId, created.record.id);
    return result.entries[0];
  };
  assert.equal(read().name, "Before");
  invoke(["project-update", "--workspace", library, "--id", created.record.id, "--name", "After", "--at", at]);
  assert.equal(read().name, "After");
});

// INIT-053 R45 (U11, PP-1): Atelier holds the device registry lock through the engine's own file lock
// and device directory modules, which it reaches through the registry-lock bridge. The release carries
// the bridge and both builds inside atelier/portal.mjs, once each and beside the one names module, and
// nothing in the bundle still points at dist/build, which no release ships. The labels are the bundle's
// own per-module headers.
test("R45 U11: the packed Atelier carries the lock and device-home modules once and no dist/build specifier", async () => {
  const { tree } = await packedRelease();
  const packedPortal = await readFile(join(tree, "atelier/portal.mjs"), "utf8");
  const labels = [...packedPortal.matchAll(/^\/\/ \d+ (\S+)$/gmu)].map((match) => match[1]);
  for (const module of ["packages/core/src/file-lock.js", "packages/core/src/device-home.js", "packages/core/src/names.js", "scripts/lib/registry-lock.mjs"]) {
    assert.equal(labels.filter((label) => label === module).length, 1, `${module} is bundled exactly once: ${JSON.stringify(labels)}`);
  }
  assert.equal(labels.some((label) => label.includes("dist/")), false, `no bundled module comes from dist: ${JSON.stringify(labels)}`);
  assert.doesNotMatch(packedPortal, /["'`][^"'`\n]*dist\/build[^"'`\n]*["'`]/u, "no string in the bundle names a dist/build module");
  assert.equal(labels.filter((label) => /(?:^|\/)file-lock\.js$/u.test(label)).length, 1, "only one lock implementation is bundled");
});

// INIT-053 R45 (U11, PP-1): the stage points each of the bridge's two re-exports at the staged builds
// only when it finds it exactly once, the same refusal as the BUNDLED_CLI and names checks. A copy of
// this repository whose bridge lost its lock re-export, or re-exports the device directory twice, is
// refused and writes nothing. The copy links every other file back to this checkout.
test("R45 U11: a registry-lock bridge whose lock or device-home re-export is not found exactly once is refused", async () => {
  const bridge = await readFile(join(repositoryRoot, "scripts/lib/registry-lock.mjs"), "utf8");
  const lockSpecifier = "\"../../dist/build/packages/core/src/file-lock.js\"";
  const homeExport = "export { registryPath } from \"../../dist/build/packages/core/src/device-home.js\";";
  assert.equal(bridge.split(lockSpecifier).length, 2, "the bridge re-exports the lock build once");
  assert.equal(bridge.split(homeExport).length, 2, "the bridge re-exports the device directory build once");
  const mutations = [
    ["absent", bridge.replace(lockSpecifier, "\"../../dist/build/packages/core/src/file-lock-renamed.js\"")],
    ["doubled", bridge.replace(homeExport, `${homeExport}\nexport { deviceHome } from "../../dist/build/packages/core/src/device-home.js";`)],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(mutated, bridge, `${name} must change the bridge`);
    const copy = join(base, `unbound-${name}`);
    await mkdir(join(copy, "scripts/lib"), { recursive: true });
    await mkdir(join(copy, "portal"), { recursive: true });
    await writeFile(join(copy, "scripts/pack-release.mjs"), await readFile(packScript));
    for (const entry of await readdir(join(repositoryRoot, "scripts/lib"))) {
      if (entry !== "registry-lock.mjs") await symlink(join(repositoryRoot, "scripts/lib", entry), join(copy, "scripts/lib", entry));
    }
    await writeFile(join(copy, "scripts/lib/registry-lock.mjs"), mutated);
    for (const path of ["scripts/einzbern.mjs", "scripts/einzbern-hook.mjs", "scripts/einzbern-launcher.mjs", "scripts/einzbern-hook-launcher.mjs", "portal/portal.mjs", "dist", "packages", "package.json"]) {
      await symlink(join(repositoryRoot, path), join(copy, path));
    }
    const out = join(copy, "out");
    const run = node([join(copy, "scripts/pack-release.mjs"), "--out", out]);
    assert.equal(run.status, 1, `${name}: ${safeDiagnostic(run.stderr)}`);
    const refusal = JSON.parse(lastLine(run.stderr));
    assert.equal(refusal.reasonCode, "PACK_ATELIER_UNBOUND", `${name}: ${safeDiagnostic(run.stderr)}`);
    assert.match(refusal.error, /scripts\/lib\/registry-lock\.mjs/u, `${name}: the refusal names the bridge`);
    assert.equal(existsSync(out), false, `${name}: a refused pack writes nothing`);
  }
});

test("481-R2, SUB-399: Atelier decodes a failed library-list from CLI stderr", async () => {
  const { tree } = await packedRelease();
  const { root, env, cwd } = await environment("atelier-failure");
  const failedCli = join(root, "failed-cli.mjs");
  const failure = { ok: false, reasonCode: "LIBRARY_LIST_FIXTURE_FAILURE", error: "The registry could not be read." };
  await writeFile(failedCli, [
    `process.stderr.write(${JSON.stringify(JSON.stringify(failure))});`,
    "process.exitCode = 7;",
    "",
  ].join("\n"));
  env.TCRN_WORKFLOW_CLI = failedCli;

  const bridge = "atelier/portal.mjs -> TCRN_WORKFLOW_CLI (library-list)";
  const run = node([join(tree, "atelier/portal.mjs")], { cwd, env, timeout: 60_000 });
  const diagnostic = safeDiagnostic(JSON.stringify({
    bridge,
    portal: { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr },
  }));
  assert.equal(run.status, 2, diagnostic);
  assert.equal(run.stdout, "", diagnostic);
  let startup;
  try { startup = JSON.parse(lastLine(run.stderr)); } catch { assert.fail(`Atelier failure did not return a JSON diagnostic (${bridge}): ${diagnostic}`); }
  assert.equal(startup.reasonCode, failure.reasonCode, `Atelier must decode the failing CLI's stderr (${bridge}): ${diagnostic}`);
  assert.equal(startup.error, failure.error, `Atelier must preserve the CLI's sanitized error (${bridge}): ${diagnostic}`);
  for (const privatePath of [base, root, repositoryRoot, homedir()]) {
    if (privatePath) assert.ok(!run.stderr.includes(privatePath), `Atelier leaked a private path (${bridge})`);
  }
});

test("481-R2, R4: the hook entry is one file whose runHookEvent answers nothing on an older Node.js", async () => {
  const { tree } = await packedRelease();
  const { root, env, cwd } = await environment("hook");
  const driver = join(root, "drive-hook.mjs");
  await writeFile(driver, [
    "const hook = await import(process.argv[2]);",
    "const answer = await hook.runHookEvent({ event: \"user-prompt-submit\", payload: { prompt: \"heron\" }, libraryPath: process.argv[3] });",
    "process.stdout.write(JSON.stringify(answer));",
    "",
  ].join("\n"));
  const preload = join(root, "older-node.mjs");
  await writeFile(preload, "Object.defineProperty(process.versions, \"node\", { value: \"22.12.0\" });\n");
  const entry = pathToFileURL(join(tree, "scripts/einzbern-hook.mjs")).href;
  const older = node(["--import", pathToFileURL(preload).href, driver, entry, join(root, "no-library")], { cwd, env });
  assert.deepEqual([older.status, older.stdout, older.stderr], [0, "null", ""]);
  // On this Node.js an event the hook does not answer is still nothing.
  const current = node(["--input-type=module", "-e", `const hook = await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify(await hook.runHookEvent({ event: "session-end" })));`], { cwd, env });
  assert.deepEqual([current.status, current.stdout], [0, "null"], current.stderr);
});

test("481-R2: a version the built engine does not answer as, and an unknown flag, are refused", async () => {
  const out = join(base, "refused");
  const mismatch = pack(out, ["--version", "9.9.9"]);
  assert.equal(mismatch.status, 1);
  const refusal = JSON.parse(lastLine(mismatch.stderr));
  assert.deepEqual([refusal.reasonCode, refusal.required, refusal.actual], ["PACK_VERSION_MISMATCH", FRAMEWORK_VERSION, "9.9.9"]);
  const usage = node([packScript, "--output", out]);
  assert.equal(usage.status, 1);
  assert.equal(JSON.parse(lastLine(usage.stderr)).reasonCode, "PACK_USAGE");
  assert.equal(existsSync(out), false, "a refused pack writes nothing");
});

// Rewrites one header of `archive` and its checksum, the way another writer could have made it.
function rewriteHeader(archive, offset, change) {
  const copy = Buffer.from(archive);
  const header = copy.subarray(offset, offset + 512);
  change(header);
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(header, 148);
  return copy;
}

function refusedWith(operation, reasonCode) {
  assert.throws(operation, (error) => {
    assert.equal(error.reasonCode, reasonCode, error.message);
    assert.ok(TAR_REASON_CODES.includes(error.reasonCode));
    return true;
  });
}

test("481-R2: tar.mjs writes the bytes P8's independent rebuild writes, reads them back, and refuses what must not be unpacked", () => {
  const records = [
    { path: "scripts/run.mjs", bytes: Buffer.from("#!/usr/bin/env node\nconsole.log(1);\n") },
    { path: "README.md", bytes: Buffer.from("# Read me\n") },
    { path: "docs/é.md", bytes: Buffer.from("accent\n") },
    { path: "empty.txt", bytes: Buffer.alloc(0) },
    { path: "docs/block.bin", bytes: Buffer.alloc(512, 7) },
  ];
  const archive = writeUstar(records);
  assert.ok(archive.equals(buildCanonicalUstar(records.map((record) => ({ ...record, mode: tarMode(record.bytes) })))));
  assert.ok(archive.equals(writeUstar([...records].reverse())), "the order records are passed in does not matter");
  const read = readUstar(archive);
  assert.deepEqual(read.map((entry) => entry.path), ["README.md", "docs/block.bin", "docs/é.md", "empty.txt", "scripts/run.mjs"]);
  for (const entry of read) {
    const record = records.find((candidate) => candidate.path === entry.path);
    assert.ok(entry.bytes.equals(record.bytes), entry.path);
    assert.equal(entry.mode, record.path.endsWith(".mjs") ? 0o755 : 0o644);
  }

  refusedWith(() => writeUstar([{ path: `${"d/".repeat(50)}x`, bytes: Buffer.alloc(1) }]), "TAR_PATH_TOO_LONG");
  for (const path of ["../escape", "/absolute", "a//b", "a/./b", "C:/drive", "back\\slash", ""]) {
    refusedWith(() => writeUstar([{ path, bytes: Buffer.alloc(1) }]), "TAR_PATH_INVALID");
  }
  refusedWith(() => writeUstar([{ path: "twice", bytes: Buffer.alloc(1) }, { path: "twice", bytes: Buffer.alloc(2) }]), "TAR_PATH_DUPLICATE");
  refusedWith(() => writeUstar([{ path: "odd", bytes: Buffer.alloc(1), mode: 0o600 }]), "TAR_RECORD_INVALID");

  // README.md is the first entry: its header is at offset 0.
  refusedWith(() => readUstar(rewriteHeader(archive, 0, (header) => { header[156] = "2".charCodeAt(0); })), "TAR_ENTRY_UNSUPPORTED");
  refusedWith(() => readUstar(rewriteHeader(archive, 0, (header) => { header[156] = "x".charCodeAt(0); })), "TAR_ENTRY_UNSUPPORTED");
  refusedWith(() => readUstar(rewriteHeader(archive, 0, (header) => {
    header.fill(0, 0, 100);
    Buffer.from("../README.md").copy(header, 0);
  })), "TAR_PATH_INVALID");
  const flipped = Buffer.from(archive);
  flipped[10] ^= 1;
  refusedWith(() => readUstar(flipped), "TAR_ARCHIVE_INVALID");
  refusedWith(() => readUstar(archive.subarray(0, archive.length - 1024)), "TAR_ARCHIVE_INVALID");
  refusedWith(() => readUstar(archive.subarray(0, archive.length - 512)), "TAR_ARCHIVE_INVALID");
  // A directory entry, which other writers add, is read past.
  const withDirectory = Buffer.concat([
    rewriteHeader(archive.subarray(0, 512), 0, (header) => {
      header.fill(0, 0, 100);
      Buffer.from("docs/").copy(header, 0);
      Buffer.from("00000000000\0").copy(header, 124);
      header[156] = "5".charCodeAt(0);
    }),
    archive,
  ]);
  assert.deepEqual(readUstar(withDirectory).map((entry) => entry.path), read.map((entry) => entry.path));
});

// PR24 P1-P4: execute the archive entry with product source and node_modules
// reads denied by Node itself. Governed runs retain their mandatory, standalone
// controller and offline preloads; uninstrumented runs allow only the isolated fixture tree.
test("execution evidence is usable from the archive with product source denied and unchanged owner synthetic cases", async () => {
  const { tree, report, archive, entries } = await packedRelease();
  assert.equal(report.sha256, sha256(archive));
  const isolated = await environment("execution-evidence");
  const cli = join(tree, "scripts/einzbern.mjs");
  // Allow only this empty temporary fixture tree. Missing layout candidates may
  // return ENOENT here; repository source and dependencies remain denied.
  const permission = ["--permission", `--allow-fs-read=${base}`];
  assert.equal(existsSync(join(base, "scripts/policy/knowledge-provenance.json")), false, "missing layout candidate stays inside the isolated fixture, without copied policy assets");
  const inheritedOptions = (process.env.NODE_OPTIONS ?? "").split(/\s+/u);
  const mandatoryInstrumentation = ["test-controller-child-policy.mjs", "no-network.mjs"];
  for (const file of mandatoryInstrumentation) {
    const instrumentation = join(repositoryRoot, "scripts", file);
    if (inheritedOptions.includes(`--import=${pathToFileURL(instrumentation).href}`)) {
      // Closed, exact-file allowances for the controller's existing builtin-only
      // instrumentation. Never allow arbitrary inherited imports or source trees.
      permission.push(`--allow-fs-read=${instrumentation}`);
    }
  }
  delete isolated.env.NODE_PATH;
  const execute = (args) => node([...permission, cli, ...args], isolated);
  if (inheritedOptions.includes(`--import=${pathToFileURL(join(repositoryRoot, "scripts/no-network.mjs")).href}`)) {
    // Transport refusal behavior is covered by the dedicated offline-boundary suite.
    const offline = node([...permission, "--input-type=module", "-e", "import assert from 'node:assert/strict'; assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true);"], isolated);
    assert.equal(offline.status, 0, offline.stderr);
  }
  for (const path of [join(repositoryRoot, "package.json"), join(repositoryRoot, "packages/core/src/dispatch-evidence.ts"), join(repositoryRoot, "packages/cli/src/index.ts"), join(repositoryRoot, "node_modules/typescript/package.json")]) {
    const denied = node([...permission, "--input-type=module", "-e", `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(path)});`], isolated);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /ERR_ACCESS_DENIED/);
    assert.ok(denied.stderr.includes(path), `the denial must name ${safeDiagnostic(path)}, not instrumentation: ${safeDiagnostic(denied.stderr)}`);
  }
  // This is the helper installed inside this archive, not a sibling checkout.
  const skillEntry = entries.find(entry => entry.path === `${RELEASE}/skill/${BRAND.helper.id}/SKILL.md`);
  assert.ok(skillEntry, "the canonical helper Skill is a member of this exact archive");
  const skill = await readFile(join(tree, "skill", BRAND.helper.id, "SKILL.md"), "utf8");
  assert.deepEqual(Buffer.from(skill, "utf8"), skillEntry.bytes, "the installed Skill read comes from this archive's member bytes");
  assert.match(skill, /execution-evidence --from-file <json>/);
  assert.doesNotMatch(skill, /scripts\/review-evidence\.mjs/);
  assert.match(skill, /specs\/dispatch-admission-evidence-v1\.md/);
  const format = await readFile(join(tree, "specs/dispatch-admission-evidence-v1.md"), "utf8");
  assert.match(format, /hostResult/);
  assert.match(format, /Exit 1/);
  assert.match(format, /tcrn\.dispatch-process-return\.v1/);
  assert.match(skill, /execution-prepare/); assert.match(skill, /execution-record/);
  for (const verb of ["execution-prepare", "execution-record"]) {
    const help = execute([verb, "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(JSON.parse(help.stdout).commands[0].mutates, true);
  }
  for (const args of [["commands"], ["execution-evidence", "--help"]]) {
    const run = execute(args);
    assert.equal(run.status, 0, run.stderr);
    const command = JSON.parse(run.stdout).commands.find(entry => entry.name === "execution-evidence");
    assert.equal(command.mutates, false);
    assert.match(command.flags[0].valueShape, /handoff, hostResult/);
  }
  for (const name of ["associated", "refused", "mismatch", "unavailable"]) {
    // Copy byte-for-byte; do not rebuild the receipt or repair a bad case.
    const bytes = await readFile(join(repositoryRoot, "fixtures/dispatch-evidence", `dispatch-${name}.synthetic.json`));
    const input = JSON.parse(bytes);
    const path = join(isolated.cwd, `${name}.json`);
    await writeFile(path, bytes);
    const run = execute(["execution-evidence", "--from-file", path]);
    assert.equal(run.status, input.expected.complete ? 0 : 1, run.stderr);
    const actual = JSON.parse(run.stdout);
    for (const key of ["valid", "complete", "status"]) assert.equal(actual[key], input.expected[key], name + ": " + key);
    assert.deepEqual(actual.evidence, input);
    assert.equal(actual.verification, "caller-supplied-host-return-not-independently-authenticated");
    if (input.expected.complete) assert.equal(run.stderr, "");
    else assert.match(run.stderr, /DISPATCH_EVIDENCE_(INVALID|UNAVAILABLE)/);
  }
  const malformed = join(isolated.cwd, "malformed.json");
  await writeFile(malformed, "{");
  const bad = execute(["execution-evidence", "--from-file", malformed]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /DISPATCH_EVIDENCE_INPUT_INVALID/);
  assert.equal(existsSync(isolated.env.EINZBERN_HOME), false, "no device state was needed or created");
});

// PR24-1: exercise an upgraded synthetic historical library through the actual
// release archive, not a core write or the checkout launcher. Only fixture writes
// and the controller's exact mandatory preloads are available to the child.
test("PR24-1: packed knowledge-capture preserves legacy language writes with explicit host", async () => {
  const { tree } = await packedRelease();
  const root = join(base, "capture-cli-upgrade");
  const permission = ["--permission", `--allow-fs-read=${base}`, `--allow-fs-write=${root}`];
  const inheritedOptions = (process.env.NODE_OPTIONS ?? "").split(/\s+/u);
  for (const file of ["test-controller-child-policy.mjs", "no-network.mjs"]) {
    const instrumentation = join(repositoryRoot, "scripts", file);
    if (inheritedOptions.includes(`--import=${pathToFileURL(instrumentation).href}`)) permission.push(`--allow-fs-read=${instrumentation}`);
  }
  const cli = join(tree, "scripts/einzbern.mjs");
  const execute = (args, options) => node([...permission, cli, ...args], options);
  await runCaptureCliUpgradeMatrix({ root, execute });
  const isolated = await environment("capture-catalog");
  for (const args of [["commands"], ["knowledge-capture", "--help"]]) {
    const result = execute(args, isolated);
    assert.equal(result.status, 0, result.stderr);
    const command = JSON.parse(result.stdout).commands.find(entry => entry.name === "knowledge-capture");
    const host = command.flags.find(flag => flag.name === "host");
    assert.ok(host, "archive catalog advertises host on knowledge-capture");
    assert.equal(host.required, false, "host is conditional on language policy, not globally required");
    assert.equal(host.valueKind, "string");
  }
});

test("INIT-062 packaged CLI distributes the universal rule revision to ordinary hosts and dot in both languages", async () => {
  const { tree } = await packedRelease();
  const entry = join(tree, "scripts/einzbern.mjs");
  assert.equal(existsSync(join(tree, "dist")), false);
  assert.equal(existsSync(join(tree, "packages/core/src")), false);
  for (const language of ["zh-CN", "en"]) {
    const isolated = await environment(`universal-rules-${language}`);
    // This is the existing isolated Atelier fixture convention, not a change to
    // a real host, an authorization claim or a relaxation of the model-write gate.
    const options = { cwd: isolated.cwd, env: { ...isolated.env, EINZBERN_SURFACE: "atelier" } };
    const invoke = (args) => {
      const result = node([entry, ...args], options);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const at = "2026-10-21T05:00:00Z";
    const project = join(isolated.root, "project");
    const library = join(project, ".ether");
    await mkdir(project);
    invoke(["init", "--workspace", library, "--project", project, "--at", at]);
    const created = invoke(["project-create", "--workspace", library, "--external-key", "RULES", "--name", "Packaged rules", "--at", at]);
    const projectId = created.record.id;
    invoke(["library-register", "--library", library, "--project", project, "--project-id", projectId, "--at", at]);
    invoke(["settings-set", "--workspace", library, "--project-id", projectId, "--key", "artifact.language", "--value", language, "--at", at]);
    for (const id of ["autonomy", "residue-cleanup"]) invoke(["rule-enable", "--project", project, "--id", id, "--at", at]);
    invoke(["agents-render", "--project", project, "--at", at]);
    const generic = await readFile(join(project, "AGENTS.md"), "utf8");
    for (const id of ["autonomy", "residue-cleanup"]) {
      const expected = await readFile(join(repositoryRoot, "tests/fixtures/rules", `${id}.${language === "zh-CN" ? "zh" : "en"}.md`), "utf8");
      assert.ok(generic.includes(expected), `${id} ${language} reaches the ordinary-host AGENTS body`);
    }
    assert.ok((await readFile(join(project, "CLAUDE.md"), "utf8")).includes("@AGENTS.md"));
    const listed = invoke(["rule-list", "--project", project]);
    assert.equal(listed.dotRuleSources.status, "available");
    assert.deepEqual(listed.dotRuleSources.enabledRules.map(rule => [rule.id, rule.version]), [["autonomy", 1], ["residue-cleanup", 1]]);
    const dotRoot = join(isolated.root, "dot");
    await mkdir(dotRoot);
    const inputPath = join(isolated.root, "dot-input.json");
    await writeFile(inputPath, JSON.stringify({
      binding: { root: dotRoot, agentsPath: join(dotRoot, "AGENTS.md"), provenancePath: join(dotRoot, ".dot", "provenance.json"), backupRoot: join(dotRoot, ".dot", "recovery"), projectReference: projectId, ownerId: "fixture:owner" },
      source: { engineVersion: FRAMEWORK_VERSION, engineCommit: "unavailable", engineSourceRef: "fixture:packaged-engine", language: listed.dotRuleSources.language, enabledRules: listed.dotRuleSources.enabledRules },
      enginePath: entry, manaSkillPath: join(tree, "skill/mana-orchestrate/SKILL.md"), preInjection: "apply",
    }));
    const setup = ["setup", "--mode", "fresh", "--project", dotRoot, "--at", at, "--execution-target", "chatgpt-dot", "--dot-input", inputPath];
    const preview = invoke(setup);
    const applied = invoke([...setup, "--yes", "true", "--approved-plan-digest", preview.dot.planDigest]);
    assert.equal(applied.reasonCode, "SETUP_APPLIED");
    assert.equal(applied.dot.status, "applied");
    assert.equal(applied.dot.sessionRead, "not-verified");
    assert.deepEqual(applied.selfCheck, []);
    const independent = await readFile(join(dotRoot, "AGENTS.md"), "utf8");
    const expectedFragments = language === "zh-CN"
      ? ["模型自行添加的次数限制", "平台要求的逐次确认", "Fork 贡献、基线同步与分支收尾", "分支不再含目标中没有的独有提交", "本条不新增远端写入、合并、发布或永久删除权限"]
      : ["count limit that the model itself inserted", "Platform-required confirmation for each action", "Fork contributions, baseline synchronization and branch retirement", "no unique commits absent from that target", "no new permission for remote writes, merges, publication or permanent deletion"];
    for (const fragment of expectedFragments) assert.ok(independent.includes(fragment), `${language}: ${fragment}`);
    assert.equal(independent.includes("<!-- einzbern:section"), false, "dot remains an independent file, not generic sections");
    assert.equal(existsSync(join(dotRoot, "CLAUDE.md")), false, "dot does not install another host's bridge");
  }
});


test("607-R2: shared Skill validation refuses a package whose manifest could still hash missing contracts", async () => {
  const tree = await mkdtemp(join(base, "skill-contract-"));
  await mkdir(join(tree, "skill", BRAND.helper.id), { recursive: true });
  await writeFile(join(tree, "skill", BRAND.helper.id, "SKILL.md"), "Read specs/work-content-v1.md.\n");
  await assert.rejects(verifySkillSpecifications(tree, `skill/${BRAND.helper.id}`), { reasonCode: "PACK_SKILL_SPEC_MISSING" });
});
