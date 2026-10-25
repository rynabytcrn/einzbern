// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-488 R1, R2, R4 (TCRN-CROSS-SUB-355): verify the two-repository version lock,
// local release preparation, all-red stop, and explicit tag/push/release execution in scratch.
// TCRN-CROSS-SUB-357 rev4 (INIT-053 R41 B1): the two-phase generate and finish entries around one
// local release commit per repository, with every refusal they add.

import "./helpers/device-home.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import test, { after } from "node:test";

import {
  ReleaseLockstepError,
  parseReleaseBuildResult,
  releaseWorkIds,
  unwrapReleaseGateResult,
  buildPublishPlan,
  checkRelease,
  executeReleaseAction,
  checkReleaseGatePlan,
  assertReleaseGateRun,
  finishRelease,
  generateRelease,
  planReleaseGeneration,
  validateReleaseGeneration,
  validateReleaseCommits,
  prepareRelease,
  runReleaseGates,
} from "../scripts/lib/release-lockstep.mjs";
import { classifyReleaseArtifacts } from "../scripts/lib/release-readiness.mjs";
import { README_NAMES, renderReadmes } from "../scripts/render-readme.mjs";
import { FRAMEWORK_VERSION, initializeLibrary, materializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { compareSemver, parseEngineVersion } from "../dist/build/packages/core/src/format-version.js";
import { ATELIER_SURFACE, SURFACE_ENVIRONMENT_VARIABLE } from "../dist/build/packages/cli/src/index.js";
import { registerLibrary } from "../dist/build/packages/core/src/registry.js";
import { setGate } from "../dist/build/packages/core/src/gates-config.js";
import { gateTreeState } from "../dist/build/packages/core/src/gates-run.js";
import { stripTypesWithScopedExperimentalWarning } from "../scripts/lib/scoped-strip-types.mjs";
import { readUstar } from "../scripts/lib/tar.mjs";
import { BRAND, LEGACY_REPOSITORY_NAMES } from "../scripts/lib/names.mjs";
import { privateHeavyEnvironment } from "./helpers/heavy-slots.mjs";
import { sourceAuditDigest } from "../scripts/ci/impact-plan.mjs";
import { validateFrozenDependencyGraph } from "../scripts/lib/dependency-graph.mjs";
import { createDependencyMaterialization, populateDependencyStore } from "../scripts/lib/dependency-materialization.mjs";

// Capture Corepack's standard cache resolution before any fixture substitutes HOME.
const SOURCE_COREPACK_HOME = resolve(process.env.COREPACK_HOME ?? join(
  process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
  "node/corepack",
));
// pnpm resolves this independently of Corepack. Retain the source location before
// the complete release fixture gives the real installer a private HOME and cache.
const SOURCE_PNPM_CACHE = resolve(process.env.pnpm_config_cache_dir || process.env.PNPM_CONFIG_CACHE_DIR || (
  process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "pnpm")
    : process.platform === "darwin" ? join(homedir(), "Library/Caches/pnpm")
      : process.platform !== "win32" ? join(homedir(), ".cache/pnpm")
        : process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm-cache") : join(homedir(), ".pnpm-cache")
));
const base = await realpath(await mkdtemp(join(tmpdir(), "einzbern-release-lockstep-")));
const OLD_VERSION = FRAMEWORK_VERSION;
const HELPER_OLD_VERSION = "1.0.7";
// The version these fixtures prepare is the patch after the built one, derived rather than written:
// a literal stops being newer the day the tree reaches it, and a fixture library the current build
// initialises refuses an older engine (ENGINE_TOO_OLD).
const OLD_PARTS = parseEngineVersion(OLD_VERSION);
const NEXT_VERSION = `${OLD_PARTS.major}.${OLD_PARTS.minor}.${BigInt(OLD_PARTS.patch) + 1n}`;
assert.ok(OLD_PARTS.prerelease.length === 0 && compareSemver(OLD_VERSION, NEXT_VERSION) < 0, "the prepared version is a stable version after the built one");
const FIXTURE_SCHEMA_VERSION = "tcrn.fixture-contract.v1";
const HELPER_READMES = ["README.md", "README.en.md", "README.ja.md", "README.ko.md", "README.fr.md"];
const RELEASE_NOTES = "Improve configuration consistency and installation diagnostics.";
const RELEASE_CLI = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const REPOSITORY_ROOT = dirname(dirname(RELEASE_CLI));
const SPECIFICATIONS = Object.freeze([
  "dispatch-admission-evidence-v1.md", "dot-execution-v1.md", "native-tool-evidence-v1.md", "host-fallback-v1.md", "engine-model-policy-v1.md",
  "shared-submit-v1.md", "config-backup-v1.md", "dot-rules-v1.md", "context-v1.md", "work-content-v1.md",
]);
after(() => rm(base, { recursive: true, force: true }));

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function writeText(root, path, content) {
  const target = join(root, ...path.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

async function initRepo(root) {
  await mkdir(root, { recursive: true });
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release-test@example.invalid"]);
}

async function commitAll(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
}

async function createRepos(name) {
  const root = join(base, name);
  const engineRoot = join(root, "einzbern");
  const helperRoot = join(root, "mana-orchestrate");
  await initRepo(engineRoot);
  await initRepo(helperRoot);

  await writeText(engineRoot, "package.json", `${JSON.stringify({ name: "einzbern", version: OLD_VERSION, private: true, type: "module" }, null, 2)}\n`);
  for (const packageName of ["cli", "core", "protocol"]) {
    await writeText(engineRoot, `packages/${packageName}/package.json`, `${JSON.stringify({ name: `@einzbern/${packageName}`, version: OLD_VERSION, private: true }, null, 2)}\n`);
  }
  await writeText(engineRoot, "packages/protocol/schema-fixture.json", `${JSON.stringify({ schemaVersion: FIXTURE_SCHEMA_VERSION, record: { id: "stable" } }, null, 2)}\n`);
  await cp(join(REPOSITORY_ROOT, "dist/build"), join(engineRoot, "dist/build"), { recursive: true });
  await cp(join(REPOSITORY_ROOT, "packages/core"), join(engineRoot, "packages/core"), { recursive: true });
  for (const directory of ["scripts", "portal", "skill"]) {
    await cp(join(REPOSITORY_ROOT, directory), join(engineRoot, directory), { recursive: true });
  }
  for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt", "packages/core/src/names.ts", ...SPECIFICATIONS.map(name => `specs/${name}`)]) {
    await writeText(engineRoot, path, await readFile(join(REPOSITORY_ROOT, path), "utf8"));
  }
  await writeText(engineRoot, "packages/core/src/framework-version.ts", await readFile(join(REPOSITORY_ROOT, "packages/core/src/framework-version.ts"), "utf8"));
  await writeText(engineRoot, "scripts/einzbern.mjs", await readFile(join(REPOSITORY_ROOT, "scripts/einzbern.mjs"), "utf8"));
  await writeText(engineRoot, ".gitignore", "/dist/\n/node_modules/\n");
  await writeText(engineRoot, "CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${RELEASE_NOTES}\n\n## ${OLD_VERSION}\n\nEarlier release.\n`);
  for (const name of README_NAMES) {
    await writeText(engineRoot, `docs/readme/einzbern/${name}`, `# Einzbern\n\n![release](https://img.shields.io/badge/release-{{version}}-blue)\n`);
  }
  await renderReadmes({ root: engineRoot, version: OLD_VERSION });
  await commitAll(engineRoot, "initial engine");

  await writeText(helperRoot, "package.json", `${JSON.stringify({ name: "mana-orchestrate", version: HELPER_OLD_VERSION, private: true }, null, 2)}\n`);
  await writeText(helperRoot, ".gitignore", "/node_modules/\n");
  await writeText(helperRoot, `skill/mana-orchestrate/SKILL.md`, `# Mana Orchestrate\n\nNavigation for Einzbern ${OLD_VERSION}: generated for this version.\n`);
  for (const name of HELPER_READMES) {
    await writeText(helperRoot, name, `# Mana Orchestrate\n\n![release](https://img.shields.io/badge/release-${HELPER_OLD_VERSION}-blue)\n`);
  }
  await commitAll(helperRoot, "initial helper");
  return { engineRoot: await realpath(engineRoot), helperRoot: await realpath(helperRoot), projectRoot: await realpath(root) };
}

async function createOrigin(root, name) {
  const bare = join(base, `${name}.git`);
  await mkdir(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["push", "--set-upstream", "origin", "main"]);
}

// TCRN-CROSS-SUB-502 (STORY-538 GWT5): the gates-run a release step starts takes its heavy-run slot in a
// directory of this case's own, outside the case's project root, never the slot of a run around the test.
async function makeEnvironment(name) {
  const home = join(base, name, "home");
  const einZbernHome = join(home, ".einzbern");
  await mkdir(einZbernHome, { recursive: true });
  return privateHeavyEnvironment(join(base, "heavy-locks", name), { ...process.env, HOME: home, EINZBERN_HOME: einZbernHome });
}

async function makeWorkspace(name, repos, environment, { declarations = "required", red = false, helperRequired = true } = {}) {
  const workspace = join(base, name, "release-workspace");
  await initializeLibrary({ root: workspace, createdAt: "2026-09-27T00:00:00Z" });
  await registerLibrary({ projectPath: repos.projectRoot, libraryPath: workspace, registeredAt: "2026-09-27T00:00:01Z" }, environment.EINZBERN_HOME);
  if (declarations !== "empty") {
    for (const [index, [name, root]] of [["engine:fixture", repos.engineRoot], ["helper:fixture", repos.helperRoot]].entries()) {
      await setGate(workspace, {
        occurredAt: `2026-09-27T00:00:0${index + 2}Z`, name,
        gate: { command: [process.execPath, "-e", `process.exit(process.cwd() === ${JSON.stringify(root)} ? ${red && index === 0 ? 3 : 0} : 19)`], root: root.split("/").at(-1), covers: ["**"], required: declarations === "required" && (index === 0 || helperRequired), enabled: declarations !== "disabled", releaseOnly: true },
      });
    }
  }
  return workspace;
}

function helperReadme(version) {
  return `# Mana Orchestrate\n\n![release](https://img.shields.io/badge/release-${version}-blue)\n`;
}

function assertCliReason(args, expectedReasonCode) {
  assert.throws(
    () => execFileSync(process.execPath, [RELEASE_CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    (error) => {
      const report = JSON.parse(error.stderr.toString());
      assert.equal(report.reasonCode, expectedReasonCode);
      return true;
    },
  );
}

test("488-R4: prepare names a gates workspace, while remote stops do not require Wiki input", () => {
  assertCliReason(
    ["prepare", "--version", NEXT_VERSION, "--helper", join(base, "missing-helper"), "--workspace", join(base, "library")],
    "RELEASE_ARGUMENT_MISSING",
  );
  assertCliReason(
    ["prepare", "--version", NEXT_VERSION, "--helper", join(base, "missing-helper")],
    "RELEASE_ARGUMENT_MISSING",
  );
  assertCliReason(
    ["--version", NEXT_VERSION, "--helper", join(base, "missing-helper"), "--execute", "tag"],
    "RELEASE_REPOSITORY_INVALID",
  );
});

function pinnedBuildArguments(engineRoot) {
  return ["pnpm@11.3.0", "--dir", engineRoot, "--recursive", "--filter", "einzbern{.}", "--fail-if-no-match", "--reporter=ndjson", "run", "--stream", "build"];
}

function pnpmBuildResult(engineRoot, build = { ok: true, reasonCode: "BUILD_VERIFIED" }) {
  const context = { name: "pnpm:lifecycle", stage: "build", depPath: engineRoot, wd: engineRoot };
  const events = [
    { ...context, script: "node scripts/task.mjs build" },
    { ...context, stdio: "stdout", line: JSON.stringify(build) },
    { ...context, exitCode: 0 },
  ];
  return { status: 0, stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, stderr: "" };
}

test("607-R6: a piped build consumes only verified engine-root lifecycle stdout", () => {
  const engineRoot = join(base, "build-report");
  const result = pnpmBuildResult(engineRoot);
  assert.deepEqual(parseReleaseBuildResult(result, engineRoot), { ok: true, reasonCode: "BUILD_VERIFIED" });
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const report = (records) => ({ ...result, stdout: `${records.map((event) => JSON.stringify(event)).join("\n")}\n` });
  const refusals = [
    ["failed command", { ...result, status: 1 }],
    ["malformed reporter output", { ...result, stdout: "not NDJSON\n" }],
    ["unwrapped script output", { ...result, stdout: '{"ok":true,"reasonCode":"BUILD_VERIFIED"}\n' }],
    ["other working directory", report(events.map((event) => ({ ...event, wd: join(engineRoot, "packages/core") })))],
    ["other dependency path", report(events.map((event) => ({ ...event, depPath: join(engineRoot, "packages/core") })))],
    ["other lifecycle stage", report(events.map((event) => ({ ...event, stage: "other" })))],
    ["stderr report", report(events.map((event) => event.stdio ? { ...event, stdio: "stderr" } : event))],
    ["missing lifecycle exit", report(events.slice(0, -1))],
    ["failed lifecycle exit", report(events.map((event) => Object.hasOwn(event, "exitCode") ? { ...event, exitCode: 1 } : event))],
    ["trailing non-JSON stdout", report([...events.slice(0, -1), { ...events[1], line: "Done" }, events.at(-1)])],
  ];
  for (const [label, output] of refusals) {
    assert.throws(() => parseReleaseBuildResult(output, engineRoot), { reasonCode: "RELEASE_STEP_FAILED" }, label);
  }
  for (const build of [{ ok: false, reasonCode: "BUILD_VERIFIED" }, { ok: true }, { ok: true, reasonCode: "OTHER_VERIFIED" }]) {
    assert.throws(() => parseReleaseBuildResult(pnpmBuildResult(engineRoot, build), engineRoot), { reasonCode: "RELEASE_BUILD_FAILED" });
  }
});

async function controlledPrepareRunner({ engineRoot, helperRoot, projectRoot, environment, workspace, projectId = null, staleBuild = false }) {
  const calls = [];
  const runner = async (command, args, { cwd, env }) => {
    calls.push({ command, args, cwd });
    if (command === "corepack") {
      assert.deepEqual(args, pinnedBuildArguments(engineRoot));
      if (!staleBuild) {
        const source = await readFile(join(engineRoot, "packages/core/src/framework-version.ts"), "utf8");
        await writeText(engineRoot, "dist/build/packages/core/src/framework-version.js", stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false }));
      }
      return pnpmBuildResult(engineRoot);
    }
    const scriptName = args[0]?.split("/").at(-1);
    if (scriptName === "render-readme.mjs") {
      const version = args[args.indexOf("--version") + 1];
      const result = await renderReadmes({ root: engineRoot, version });
      return { status: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (scriptName === "render-helper-docs.mjs") {
      const out = args[args.indexOf("--out") + 1];
      const version = args[args.indexOf("--version") + 1];
      await writeText(out, "package.json", `${JSON.stringify({ name: "mana-orchestrate", version, private: true }, null, 2)}\n`);
      await writeText(out, "skill/mana-orchestrate/SKILL.md", `# Mana Orchestrate\n\nNavigation for Einzbern ${version}: generated for this version.\n`);
      for (const name of HELPER_READMES) await writeText(out, name, helperReadme(version));
      const files = ["package.json", "skill/mana-orchestrate/SKILL.md", ...HELPER_READMES].sort();
      return { status: 0, stdout: `${JSON.stringify({ ok: true, reasonCode: "HELPER_DOCS_RENDERED", version, files, extraFiles: [] })}\n`, stderr: "" };
    }
    if (scriptName === "einzbern.mjs") throw new Error("a test runner must never replace real gate reads or execution");
    if (scriptName === "pack-release.mjs") {
      await cp(await realpath(join(REPOSITORY_ROOT, "node_modules/typescript")), join(engineRoot, "node_modules/typescript"), { recursive: true });
      return { status: 0, stdout: execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")} in ${cwd}; HOME=${env.HOME}; EINZBERN_HOME=${env.EINZBERN_HOME}`);
  };
  const result = await prepareRelease({
    engineRoot,
    helperRoot,
    version: NEXT_VERSION,
    workspace,
    projectRoot,
    projectId,
    env: environment,
    at: "2026-09-27T04:00:00Z",
    runner,
  });
  return { result, calls };
}

test("488-AC1: a helper version mismatch is refused with the locations that disagree", async () => {
  const repos = await createRepos("check-mismatch");
  await assert.rejects(
    checkRelease({ ...repos, version: OLD_VERSION, env: await makeEnvironment("check-mismatch") }),
    (error) => {
      assert.ok(error instanceof ReleaseLockstepError);
      assert.equal(error.reasonCode, "RELEASE_VERSION_MISMATCH");
      assert.ok(error.details.mismatches.some((entry) => entry.repository === "helper" && entry.path === "package.json"));
      return true;
    },
  );
});

test("488-R1/R2/R4, MIN-235 D13: prepare aligns both repositories, keeps schema IDs independent, gates before packing, and writes the checksum", async () => {
  const repos = await createRepos("prepare");
  const schemaPath = join(repos.engineRoot, "packages/protocol/schema-fixture.json");
  const schemaBefore = await readFile(schemaPath);
  const environment = await makeEnvironment("prepare");
  const workspace = await makeWorkspace("prepare", repos, environment);
  const { result, calls } = await controlledPrepareRunner({ ...repos, environment, workspace });
  assert.equal(result.reasonCode, "RELEASE_PREPARED");
  assert.equal(result.version, NEXT_VERSION);
  assert.equal(result.gates.ok, true);
  assert.deepEqual(result.helperExtraFiles, []);
  const check = await checkRelease({ ...repos, version: NEXT_VERSION, env: environment });
  assert.equal(check.reasonCode, "RELEASE_VERSION_CHECKED");
  assert.equal(JSON.parse(await readFile(join(repos.engineRoot, "packages/core/package.json"), "utf8")).version, NEXT_VERSION);
  assert.equal(JSON.parse(await readFile(join(repos.helperRoot, "package.json"), "utf8")).version, NEXT_VERSION);
  assert.deepEqual(await readFile(schemaPath), schemaBefore, "a package release version does not rewrite an unchanged schema identifier");
  assert.equal(JSON.parse(await readFile(schemaPath, "utf8")).schemaVersion, FIXTURE_SCHEMA_VERSION);
  const changelog = await readFile(join(repos.engineRoot, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${NEXT_VERSION}$`, "mu"));
  assert.ok(changelog.includes(RELEASE_NOTES), "the actual changes survive release preparation");
  assert.equal(changelog.includes("release names are retired"), false, "preparation invents no recurring retirement");
  const archive = await readFile(result.assets.archive);
  const notices = readUstar(gunzipSync(archive)).find((entry) => entry.path === `einzbern-${NEXT_VERSION}/THIRD_PARTY_NOTICES.txt`);
  assert.ok(notices, "the prepared archive retains vendored runtime license notices");
  assert.deepEqual(notices.bytes, await readFile(join(REPOSITORY_ROOT, "THIRD_PARTY_NOTICES.txt")), "release preparation preserves the actual license notice bytes");
  const contractEntries = readUstar(gunzipSync(archive));
  for (const name of SPECIFICATIONS) {
    const contract = contractEntries.find(entry => entry.path === `einzbern-${NEXT_VERSION}/specs/${name}`);
    assert.ok(contract, `${name}: release preparation includes the public CLI contract`);
    assert.deepEqual(contract.bytes, await readFile(join(REPOSITORY_ROOT, "specs", name)), `${name}: release preparation preserves exact contract bytes`);
  }
  const checksum = await readFile(result.assets.checksum, "utf8");
  assert.equal(checksum, `${result.assets.sha256}  einzbern-${NEXT_VERSION}.tar.gz\n`);
  const p8 = await import(pathToFileURL(join(repos.engineRoot, "scripts/lib/p8-workflow-rc.mjs")).href);
  const artifacts = p8.buildP8ReleaseArtifacts({ sourceArchive: Buffer.from("source fixture\n"), sbom: Buffer.from('{"bomFormat":"CycloneDX"}\n'), releaseArchive: archive, releaseArchiveSha256: Buffer.from(checksum) });
  const manifest = JSON.parse(artifacts.get("release-manifest.json").toString());
  assert.equal(p8.P8_VERSION, NEXT_VERSION);
  assert.equal(p8.P8_TAG, `v${NEXT_VERSION}`);
  assert.equal(manifest.repository, "tpmoonchefryan/einzbern");
  assert.equal(manifest.version, NEXT_VERSION);
  assert.equal(manifest.schemaVersion, "tcrn.workflow-release-candidate-manifest.v1");
  assert.equal(artifacts.size, 7);
  assert.equal(p8.validateP8ReleaseDocuments(artifacts).artifactCount, 7);
  const absentArchive = new Map(artifacts);
  absentArchive.delete(p8.P8_RELEASE_ARCHIVE);
  assert.throws(() => p8.validateP8ReleaseDocuments(absentArchive), (error) => error.reasonCode === "P8_RELEASE_DOCUMENT_SET");
  const extraArtifact = new Map(artifacts);
  extraArtifact.set("unexpected.txt", Buffer.from("unexpected"));
  assert.throws(() => p8.validateP8ReleaseDocuments(extraArtifact), (error) => error.reasonCode === "P8_RELEASE_DOCUMENT_SET");
  const alteredArchive = new Map(artifacts);
  alteredArchive.set(p8.P8_RELEASE_ARCHIVE, Buffer.concat([archive, Buffer.from("changed")]));
  assert.throws(() => p8.validateP8ReleaseDocuments(alteredArchive), (error) => error.reasonCode === "P8_RELEASE_MANIFEST_ARTIFACT_MISMATCH");
  const packIndex = calls.findIndex((call) => call.args[0]?.endsWith("pack-release.mjs"));
  assert.ok(packIndex >= 0);
  assert.deepEqual(result.gates.selected, ["engine:fixture", "helper:fixture"]);
  const native = JSON.parse(await readFile(result.gates.recordPath, "utf8"));
  assert.equal(native.release, true);
  assert.equal(native.gates.every((gate) => gate.exitCode === 0 && gate.ok), true);
  assert.equal(calls.some((call) => call.args.includes("gates-run")), false, "real gates bypass the controlled renderer/pack runner");
  assert.equal(calls.some((call) => call.command === "gh" || call.args.includes("tag") || call.args.includes("push")), false);
  const sourcePath = join(repos.engineRoot, "packages/core/src/framework-version.ts");
  const preparedSource = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, preparedSource.replace(`FRAMEWORK_VERSION = "${NEXT_VERSION}"`, `FRAMEWORK_VERSION = "${OLD_VERSION}"`));
  await assert.rejects(checkRelease({ ...repos, version: NEXT_VERSION, env: environment }), (error) => error.reasonCode === "RELEASE_VERSION_MISMATCH" && error.details.mismatches.some((entry) => entry.path === "packages/core/src/framework-version.ts"));
  assert.throws(
    () => execFileSync(process.execPath, [join(repos.engineRoot, "scripts/pack-release.mjs"), "--version", NEXT_VERSION], { cwd: repos.engineRoot, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    (error) => JSON.parse(error.stderr.toString()).reasonCode === "PACK_VERSION_MISMATCH",
    "a matching manifest and build cannot conceal a stale actual core source",
  );
  await writeFile(sourcePath, preparedSource);
});

test("488-R4: a red release gate stops preparation before the archive step", async () => {
  const repos = await createRepos("gate-red");
  const environment = await makeEnvironment("gate-red");
  const workspace = await makeWorkspace("gate-red", repos, environment, { red: true });
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args });
    const scriptName = args[0]?.split("/").at(-1);
    if (command === "corepack") {
      assert.deepEqual(args, pinnedBuildArguments(repos.engineRoot));
      const source = await readFile(join(repos.engineRoot, "packages/core/src/framework-version.ts"), "utf8");
      await writeText(repos.engineRoot, "dist/build/packages/core/src/framework-version.js", stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false }));
      return pnpmBuildResult(repos.engineRoot);
    }
    if (scriptName === "render-readme.mjs") {
      const result = await renderReadmes({ root: repos.engineRoot, version: args[args.indexOf("--version") + 1] });
      return { status: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (scriptName === "render-helper-docs.mjs") {
      const version = args[args.indexOf("--version") + 1];
      const out = args[args.indexOf("--out") + 1];
      await writeText(out, "package.json", `${JSON.stringify({ name: "mana-orchestrate", version, private: true }, null, 2)}\n`);
      await writeText(out, "skill/mana-orchestrate/SKILL.md", `Navigation for Einzbern ${version}: generated.\n`);
      for (const name of HELPER_READMES) await writeText(out, name, helperReadme(version));
      return { status: 0, stdout: `${JSON.stringify({ ok: true, reasonCode: "HELPER_DOCS_RENDERED", extraFiles: [] })}\n`, stderr: "" };
    }
    if (scriptName === "einzbern.mjs") return { status: 0, stdout: '{"ok":true}\n', stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")} ${options.cwd}`);
  };
  await assert.rejects(
    prepareRelease({ ...repos, version: NEXT_VERSION, workspace, env: environment, runner }),
    (error) => error.reasonCode === "RELEASE_GATES_RED" && error.details.gates.run.gates.some((gate) => gate.exitCode === 3),
  );
  assert.equal(calls.some((call) => call.args[0]?.endsWith("pack-release.mjs")), false);
});

// TCRN-CROSS-STORY-520 (MIN-243 D6): the release body the script must build, with the Wiki page's
// address composed from the names module as the script composes it, never written here as a literal.
function expectedReleaseBody(version) {
  const address = `https://github.com/${LEGACY_REPOSITORY_NAMES.owner}/${BRAND.engine.id}/wiki/Release-Notes-${version}`;
  return `Einzbern and Mana Orchestrate ship in lockstep at ${version}.\n\nRelease notes, by functional module: ${address}\n\nAttachments: \`einzbern-${version}.tar.gz\` and its SHA-256 file \`einzbern-${version}.tar.gz.sha256\`.\n`;
}

test("488-AC1/AC2: the publish plan is inert; tag, push and GitHub release each need an explicit action", async () => {
  const repos = await createRepos("publish");
  await createOrigin(repos.engineRoot, "publish-engine-origin");
  await createOrigin(repos.helperRoot, "publish-helper-origin");
  const environment = await makeEnvironment("publish");
  const workspace = await makeWorkspace("publish", repos, environment);
  await controlledPrepareRunner({ ...repos, environment, workspace });
  await commitAll(repos.engineRoot, "prepare engine release");
  await commitAll(repos.helperRoot, "prepare helper release");
  const wikiDirectory = join(base, "publish-wiki");
  await mkdir(wikiDirectory, { recursive: true });
  const bin = join(base, "fake-gh-bin");
  const home = join(base, "publish", "home");
  await mkdir(bin, { recursive: true });
  const capture = join(base, "fake-gh-args.json");
  const fakeGh = join(bin, "gh");
  await writeFile(fakeGh, "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GH_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  await chmod(fakeGh, 0o755);
  const releaseEnvironment = { ...environment, HOME: home, EINZBERN_HOME: join(home, ".einzbern"), GH_CAPTURE: capture, PATH: `${bin}:${process.env.PATH ?? ""}` };
  await mkdir(releaseEnvironment.EINZBERN_HOME, { recursive: true });

  // STORY-520 GWT2: without the version's Wiki page the plan is refused, the CLI prints no command,
  // and no action runs: no tag is created and gh is never called. An empty page is refused the same way.
  const wikiPage = `docs/wiki/Release-Notes-${NEXT_VERSION}.md`;
  const missingPage = (state) => (error) => error.reasonCode === "RELEASE_WIKI_NOTES_MISSING" && error.details.path === wikiPage && error.details.state === state;
  await assert.rejects(buildPublishPlan({ ...repos, version: NEXT_VERSION, wikiDirectory, env: environment }), missingPage("absent"));
  for (const action of ["tag", "push", "release", "wiki"]) {
    await assert.rejects(executeReleaseAction({ action, ...repos, version: NEXT_VERSION, wikiDirectory, env: releaseEnvironment }), missingPage("absent"), action);
  }
  assert.throws(
    () => execFileSync(process.execPath, [join(repos.engineRoot, "scripts/release.mjs"), "publish-plan", "--version", NEXT_VERSION, "--helper", repos.helperRoot, "--wiki-dir", wikiDirectory], { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    (error) => error.status === 1 && error.stdout === "" && JSON.parse(error.stderr).reasonCode === "RELEASE_WIKI_NOTES_MISSING",
  );
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");
  await assert.rejects(readFile(capture), (error) => error.code === "ENOENT", "gh never ran");
  await writeText(repos.engineRoot, wikiPage, " \n");
  await commitAll(repos.engineRoot, "empty Wiki release notes page");
  await assert.rejects(buildPublishPlan({ ...repos, version: NEXT_VERSION, wikiDirectory, env: environment }), missingPage("empty"));
  await writeText(repos.engineRoot, wikiPage, `# Release Notes ${NEXT_VERSION}\n\nThe module directory of this version.\n`);
  await commitAll(repos.engineRoot, "Wiki release notes page");

  const plan = await buildPublishPlan({ ...repos, version: NEXT_VERSION, wikiDirectory, env: environment });
  assert.equal(plan.reasonCode, "RELEASE_PUBLISH_PLAN_READY");
  for (const [index, command] of plan.commands.tag.entries()) {
    const info = plan.repositories[index];
    assert.deepEqual(command, ["git", "-C", info.root, "tag", "-a", `v${NEXT_VERSION}`, info.commit, "-m", `Release v${NEXT_VERSION}`]);
    assert.equal(info.commit, git(info.root, ["rev-parse", "HEAD"]));
  }
  assert.ok(plan.commands.push.every((args) => args.includes("push")));
  assert.ok(plan.commands.release.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz`)));
  assert.ok(plan.commands.release.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz.sha256`)));
  assert.match(plan.printable.wiki, /push-wiki\.mjs.*--execute push/u);
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), "");

  // STORY-520 GWT1: --notes is the short body and the Wiki page's address, not the CHANGELOG section;
  // the title and the two attachments are unchanged.
  const body = expectedReleaseBody(NEXT_VERSION);
  const archive = join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz`);
  assert.deepEqual(plan.commands.release, ["gh", "release", "create", `v${NEXT_VERSION}`, archive, `${archive}.sha256`, "--title", `Einzbern ${NEXT_VERSION}`, "--notes", body]);
  assert.ok(body.length <= 2000, `${body.length} characters`);
  const changelog = await readFile(join(repos.engineRoot, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes(`## ${NEXT_VERSION}\n`) && changelog.includes(RELEASE_NOTES), "the CHANGELOG section holds the release notes");
  assert.equal(body.includes(RELEASE_NOTES) || body.includes("Retired surfaces are listed below."), false, "the body carries no CHANGELOG section text beyond its first sentence");
  assert.ok(plan.printable.release.endsWith(` --notes '${body}'`));

  const tag = await executeReleaseAction({ action: "tag", ...repos, version: NEXT_VERSION, env: environment });
  assert.equal(tag.reasonCode, "RELEASE_TAGS_CREATED");
  assert.equal(git(repos.engineRoot, ["tag", "--list", `v${NEXT_VERSION}`]), `v${NEXT_VERSION}`);
  assert.equal(git(repos.helperRoot, ["tag", "--list", `v${NEXT_VERSION}`]), `v${NEXT_VERSION}`);
  for (const info of plan.repositories) {
    assert.equal(git(info.root, ["cat-file", "-t", `v${NEXT_VERSION}`]), "tag", "release tags are annotated");
    assert.equal(git(info.root, ["rev-parse", `v${NEXT_VERSION}^{commit}`]), info.commit, "tag pins the recorded release commit");
  }
  await assert.rejects(
    executeReleaseAction({ action: "tag", ...repos, version: NEXT_VERSION, env: environment }),
    (error) => error.reasonCode === "RELEASE_TAG_EXISTS",
    "one public version cannot reuse an existing local tag",
  );

  const pushed = await executeReleaseAction({ action: "push", ...repos, version: NEXT_VERSION, env: environment });
  assert.equal(pushed.reasonCode, "RELEASE_PUSHED");
  for (const root of [repos.engineRoot, repos.helperRoot]) {
    assert.notEqual(git(root, ["ls-remote", "--tags", "origin", `refs/tags/v${NEXT_VERSION}`]), "");
  }

  const released = await executeReleaseAction({ action: "release", ...repos, version: NEXT_VERSION, env: releaseEnvironment });
  assert.equal(released.reasonCode, "RELEASE_PUBLISHED");
  const ghCalls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(ghCalls.length, 2, "gh runs once for the engine and once for the helper");
  const [ghArgs, helperArgs] = ghCalls;
  // MIN-277 D4: the helper's Release follows the engine's, on the same tag, with no attachments.
  assert.deepEqual(helperArgs, plan.commands.helperRelease.slice(1));
  assert.deepEqual(helperArgs.slice(0, 7), ["release", "create", `v${NEXT_VERSION}`, "--repo", `${LEGACY_REPOSITORY_NAMES.owner}/${BRAND.helper.id}`, "--verify-tag", "--title"]);
  assert.equal(helperArgs[7], `${BRAND.helper.name} ${NEXT_VERSION}`);
  assert.ok(helperArgs[9].includes(`/${BRAND.engine.id}/releases/tag/v${NEXT_VERSION}`), "the helper body links the engine's Release");
  assert.equal(released.helperOutput, "");
  assert.equal(ghArgs[0], "release");
  assert.equal(ghArgs[1], "create");
  assert.equal(ghArgs[2], `v${NEXT_VERSION}`);
  assert.ok(ghArgs.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz`)));
  assert.ok(ghArgs.includes(join(repos.engineRoot, `dist/release/einzbern-${NEXT_VERSION}.tar.gz.sha256`)));
  assert.deepEqual(ghArgs, ["release", "create", `v${NEXT_VERSION}`, archive, `${archive}.sha256`, "--title", `Einzbern ${NEXT_VERSION}`, "--notes", body], "gh receives the short body as --notes");
});

test("SUB-357: actual CLI rejects the old release argv and release preflight refuses empty, disabled, optional and missing required roots", async () => {
  for (const [name, options, expected] of [
    ["empty", { declarations: "empty" }, "RELEASE_GATE_DECLARATIONS_EMPTY"],
    ["disabled", { declarations: "disabled" }, "RELEASE_REQUIRED_GATES_MISSING"],
    ["optional", { declarations: "optional" }, "RELEASE_REQUIRED_GATES_MISSING"],
    ["missing-helper-required", { helperRequired: false }, "RELEASE_REQUIRED_GATES_MISSING"],
  ]) {
    const repos = await createRepos(name);
    const env = await makeEnvironment(name);
    const workspace = await makeWorkspace(name, repos, env, options);
    const before = await readFile(join(repos.engineRoot, "package.json"));
    await assert.rejects(prepareRelease({ ...repos, version: NEXT_VERSION, workspace, env }), (error) => error.reasonCode === expected, name);
    assert.deepEqual(await readFile(join(repos.engineRoot, "package.json")), before, "invalid gate binding fails before version writes");
  }
  const repos = await createRepos("argv");
  const env = await makeEnvironment("argv");
  const workspace = await makeWorkspace("argv", repos, env);
  assert.throws(
    () => execFileSync(process.execPath, [join(repos.engineRoot, "scripts/einzbern.mjs"), "gates-run", "--workspace", workspace, "--project", repos.projectRoot, "--release", "--at", "2026-09-27T04:00:00Z"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    (error) => JSON.parse(error.stderr.toString()).reasonCode === "CLI_ARGUMENT_MALFORMED",
  );
});

test("SUB-357: registry and gate roots must name these release repositories", async () => {
  const repos = await createRepos("binding");
  const env = await makeEnvironment("binding");
  const workspace = await makeWorkspace("binding", repos, env);
  await assert.rejects(checkReleaseGatePlan({ ...repos, workspace, env: await makeEnvironment("unregistered") }), (error) => error.reasonCode === "RELEASE_GATE_REGISTRY_MISMATCH");
  await assert.rejects(checkReleaseGatePlan({ ...repos, workspace, env, projectRoot: repos.engineRoot }), (error) => error.reasonCode === "RELEASE_GATE_ROOT_MISMATCH");
  await mkdir(join(repos.projectRoot, "spare"));
  await setGate(workspace, { occurredAt: "2026-09-27T00:00:05Z", name: "engine:fixture", gate: { command: [process.execPath, "-e", "process.exit(0)"], root: "spare", covers: ["**"], required: true, enabled: true, releaseOnly: true } });
  await assert.rejects(checkReleaseGatePlan({ ...repos, workspace, env }), (error) => error.reasonCode === "RELEASE_REQUIRED_GATES_MISSING" && error.details.source === repos.engineRoot);
});

test("SUB-357: saved real gate results reject omissions, changed declarations and synthetic green outcomes", async () => {
  const repos = await createRepos("receipt");
  const env = await makeEnvironment("receipt");
  const workspace = await makeWorkspace("receipt", repos, env);
  const { plan } = await checkReleaseGatePlan({ ...repos, workspace, env });
  const tree = await gateTreeState(repos.projectRoot, plan.roots);
  const at = "2026-09-27T04:00:00Z";
  const gates = await runReleaseGates({ ...repos, workspace, env, at });
  const absent = structuredClone(gates);
  absent.run.gates.pop();
  await assert.rejects(assertReleaseGateRun({ gates: absent, plan, tree, at }), (error) => error.reasonCode === "RELEASE_GATE_EXECUTION_MISMATCH");
  const red = structuredClone(gates);
  red.run.gates[0].exitCode = 3;
  await assert.rejects(assertReleaseGateRun({ gates: red, plan, tree, at }), (error) => error.reasonCode === "RELEASE_GATES_RED");
  const different = structuredClone(gates);
  different.run.declarationsDigest = "a".repeat(64);
  await assert.rejects(assertReleaseGateRun({ gates: different, plan, tree, at }), (error) => error.reasonCode === "RELEASE_GATE_RUN_INVALID");
  await writeFile(gates.recordPath, `${JSON.stringify({ ...gates.run, treeDigest: "b".repeat(64) })}\n`);
  await assert.rejects(assertReleaseGateRun({ gates, plan, tree, at }), (error) => error.reasonCode === "RELEASE_GATE_RECEIPT_MISMATCH");
});

test("SUB-357: build ok without the requested actual core version stops before rendering or gates", async () => {
  const repos = await createRepos("stale-build");
  const environment = await makeEnvironment("stale-build");
  const workspace = await makeWorkspace("stale-build", repos, environment);
  await assert.rejects(controlledPrepareRunner({ ...repos, environment, workspace, staleBuild: true }), (error) => error.reasonCode === "RELEASE_VERSION_MISMATCH" && error.details.mismatches.some((entry) => entry.path === "dist/build/packages/core/src/framework-version.js"));
});

// TCRN-CROSS-SUB-357 rev4 (INIT-053 R41 B1): generate and finish. The fixture helper carries a kept
// LICENSE, two tracked extra files (the C5 script and a retired reference) and, when asked, an
// ignored extra file; render and build are stand-ins, gate reads and runs are the real CLI.
const CREATE_SKILL_ARCHIVE = "skill/mana-orchestrate/scripts/create-skill-archive.mjs";
const RETIRED_REFERENCE = "skill/mana-orchestrate/references/retired-guide.md";
const IGNORED_EXTRA = "ignored-extra.txt";
const OTHER_VERSION = "9.9.9";

async function helperFiles(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(prefix === "" ? root : join(root, ...prefix.split("/")), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await helperFiles(root, path));
    else found.push(path);
  }
  return found.sort();
}

function releaseRunner(engineRoot, calls) {
  return async (command, args, { cwd, env }) => {
    calls.push({ command, args, cwd });
    if (command === "corepack") {
      assert.deepEqual(args, pinnedBuildArguments(engineRoot));
      const source = await readFile(join(engineRoot, "packages/core/src/framework-version.ts"), "utf8");
      await writeText(engineRoot, "dist/build/packages/core/src/framework-version.js", stripTypesWithScopedExperimentalWarning(source, { mode: "transform", sourceMap: false }));
      return pnpmBuildResult(engineRoot);
    }
    const scriptName = args[0]?.split("/").at(-1);
    if (scriptName === "render-readme.mjs") {
      const result = await renderReadmes({ root: engineRoot, version: args[args.indexOf("--version") + 1] });
      return { status: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
    }
    if (scriptName === "wiki-cli-reference.mjs") return { status: 0, stdout: "CLI_REFERENCE_UP_TO_DATE\n", stderr: "" };
    if (scriptName === "render-helper-docs.mjs") {
      const out = args[args.indexOf("--out") + 1];
      const version = args[args.indexOf("--version") + 1];
      await writeText(out, "package.json", `${JSON.stringify({ name: "mana-orchestrate", version, private: true }, null, 2)}\n`);
      await writeText(out, "skill/mana-orchestrate/SKILL.md", `# Mana Orchestrate\n\nNavigation for Einzbern ${version}: generated for this version.\n`);
      for (const name of HELPER_READMES) await writeText(out, name, helperReadme(version));
      const files = ["package.json", "skill/mana-orchestrate/SKILL.md", ...HELPER_READMES].sort();
      const extraFiles = (await helperFiles(out)).filter((path) => !files.includes(path) && path !== "LICENSE" && path !== ".gitignore");
      return { status: 0, stdout: `${JSON.stringify({ ok: true, reasonCode: "HELPER_DOCS_RENDERED", version, files, extraFiles })}\n`, stderr: "" };
    }
    if (scriptName === "einzbern.mjs") throw new Error("a test runner must never replace real gate reads or execution");
    if (scriptName === "pack-release.mjs") {
      await cp(await realpath(join(REPOSITORY_ROOT, "node_modules/typescript")), join(engineRoot, "node_modules/typescript"), { recursive: true });
      return { status: 0, stdout: execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")} in ${cwd}`);
  };
}

async function createReleaseFixture(name, { red = false, ignoredExtra = false } = {}) {
  const repos = await createRepos(name);
  await writeText(repos.helperRoot, "LICENSE", "Apache-2.0 fixture\n");
  await writeText(repos.helperRoot, CREATE_SKILL_ARCHIVE, "// fixture copy of the helper archive script\n");
  await writeText(repos.helperRoot, RETIRED_REFERENCE, "# Retired guide\n");
  if (ignoredExtra) await writeText(repos.helperRoot, ".gitignore", `/node_modules/\n/${IGNORED_EXTRA}\n`);
  await commitAll(repos.helperRoot, "helper extras");
  if (ignoredExtra) await writeText(repos.helperRoot, IGNORED_EXTRA, "ignored, untracked\n");
  const environment = await makeEnvironment(name);
  const workspace = await makeWorkspace(name, repos, environment, { red });
  return { ...repos, environment, workspace, receiptPath: join(repos.projectRoot, "release-receipt.json") };
}

function generateFixture(fixture, { keepExtra = [], calls = [], receiptPath = fixture.receiptPath, engineRoot = fixture.engineRoot, projectId = fixture.projectId ?? null } = {}) {
  return generateRelease({ engineRoot, helperRoot: fixture.helperRoot, version: NEXT_VERSION, workspace: fixture.workspace, projectRoot: fixture.projectRoot, projectId, receiptPath, keepExtra, env: fixture.environment, runner: releaseRunner(engineRoot, calls), at: "2026-10-08T01:00:00Z" });
}

// Assertion ownership after the R2 boundary split (no old behavior assertion is dropped):
// - SUB-549: generation plan + generated receipt validator own all link/CHANGELOG bytes.
// - two-phase: plan/receipt/commit validators own identities, heads, changes, extras and shape;
//   complete-native-release owns the original stale move/set, checksum, gate and pack assertions.
// - remove-all: generation and commit validators own tracked deletion and no keep-extra.
// - finish-refusals: commit validator owns every receipt/schema/HEAD/bytes/deletion/kept/declaration refusal.
// - finish-red: native run owns red refusal and zero pack calls.
// - scope-two-phase / scope-covers-drift / legacy-default: validators own exact project and declaration binding.
// The complete-native-release case alone asserts high-level readiness and finished success.
// Unit boundaries use the same read-only generation/commit validators as the real
// commands. This fixture materializes the planned bytes and controlled renderer
// outputs; it does not claim generate/finish readiness or publication success.
async function validateGeneratedFixture(fixture, { keepExtra = [], calls = [], receiptPath = fixture.receiptPath, engineRoot = fixture.engineRoot, projectId = fixture.projectId ?? null } = {}) {
  const version = NEXT_VERSION, at = "2026-10-08T01:00:00Z", env = fixture.environment;
  const planned = await planReleaseGeneration({ engineRoot, helperRoot: fixture.helperRoot, version, workspace: fixture.workspace, projectRoot: fixture.projectRoot, projectId, receiptPath, keepExtra, env, at });
  for (const edit of planned.edits) {
    await mkdir(dirname(edit.path), { recursive: true });
    await writeFile(edit.path, edit.content);
  }
  const runner = releaseRunner(engineRoot, calls);
  const run = async (command, args) => JSON.parse((await runner(command, args, { cwd: engineRoot, env })).stdout);
  const build = parseReleaseBuildResult(await runner("corepack", pinnedBuildArguments(engineRoot), { cwd: engineRoot, env }), engineRoot);
  const readme = await run(process.execPath, [join(engineRoot, "scripts/render-readme.mjs"), "--version", version]);
  const cliReference = { checked: true, changed: false };
  const helperDocs = await run(process.execPath, [join(engineRoot, "scripts/render-helper-docs.mjs"), "--out", fixture.helperRoot, "--version", version]);
  const document = await validateReleaseGeneration({ ...planned, version, build, readme, cliReference, helperDocs, env, at });
  await writeFile(receiptPath, `${JSON.stringify(document)}\n`);
  return { reasonCode: "RELEASE_GENERATION_VALIDATED", gates: document.gates, cliReference };
}

async function validateCommittedFixture(fixture, { calls = [], version = NEXT_VERSION, receiptPath = fixture.receiptPath, projectId = fixture.projectId ?? null } = {}) {
  const validated = await validateReleaseCommits({ engineRoot: fixture.engineRoot, helperRoot: fixture.helperRoot, version, workspace: fixture.workspace, projectRoot: fixture.projectRoot, projectId, receiptPath, env: fixture.environment, runner: releaseRunner(fixture.engineRoot, calls) });
  if (validated.violations.length > 0) {
    const first = validated.violations[0];
    throw new ReleaseLockstepError(first.code, "release commit validation refused", { violations: validated.violations });
  }
  return { ...validated, reasonCode: "RELEASE_COMMITS_VALIDATED" };
}

function commitRelease(fixture, receipt) {
  git(fixture.engineRoot, ["add", "-A"]);
  git(fixture.engineRoot, ["commit", "-q", "-m", "release engine"]);
  if (receipt.helper.removeFiles.length > 0) git(fixture.helperRoot, ["rm", "-q", "--", ...receipt.helper.removeFiles]);
  git(fixture.helperRoot, ["add", "-A"]);
  git(fixture.helperRoot, ["commit", "-q", "-m", "release helper"]);
}

test("SUB-549: generate rebases CHANGELOG file destinations while preserving source text and non-file links", async () => {
  const fixture = await createReleaseFixture("note-destinations");
  const unchanged = [
    "Prose docs/releases/3.0.0-migration.md and literal ](docs/prose.md) stay literal.",
    "[external](https://example.invalid/a?q=1#part) [mail](mailto:a@example.invalid)",
    "[network](//example.invalid/a) [root](/docs/a.md) [fragment](#configuration) [query](?view=full)",
    "`[example](docs/example.md)`",
    "```md\n[example](docs/example.md)\n```",
  ].join("\n\n");
  const original = [
    "[migration](docs/releases/3.0.0-migration.md)",
    '[details](docs/details.md?mode=full#section "Details")',
    "![image](./assets/figure.png#view)",
    "[balanced](docs/example(v2).md)",
    '[spaced](<docs/file name.md?x=1#part> "Title")',
    "[reference][guide]\n\n[guide]: docs/guide.md?q=1#part 'Guide'",
    unchanged,
  ].join("\n\n");
  const expected = original
    .replace("(docs/releases/3.0.0-migration.md)", "(../../docs/releases/3.0.0-migration.md)")
    .replace('(docs/details.md?', '(../../docs/details.md?')
    .replace('(./assets/', '(../.././assets/')
    .replace('(docs/example(v2).md)', '(../../docs/example(v2).md)')
    .replace('(<docs/file name.md?', '(<../../docs/file name.md?')
    .replace('[guide]: docs/guide.md?', '[guide]: ../../docs/guide.md?');
  await writeText(fixture.engineRoot, "docs/releases/3.0.0-migration.md", "# Migration\n");
  await writeText(fixture.engineRoot, "CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${original}\n\n## ${OLD_VERSION}\n\nEarlier release.\n`);
  await commitAll(fixture.engineRoot, "release note source links");
  await validateGeneratedFixture(fixture);
  const changelog = await readFile(join(fixture.engineRoot, "CHANGELOG.md"), "utf8");
  const note = await readFile(join(fixture.engineRoot, `docs/releases/${NEXT_VERSION}.md`), "utf8");
  assert.ok(changelog.includes(original), "the root CHANGELOG keeps its original prose and destinations");
  const sectionStart = changelog.indexOf(`\n## ${NEXT_VERSION}\n`) + `\n## ${NEXT_VERSION}\n`.length;
  const section = changelog.slice(sectionStart, changelog.indexOf(`\n## ${OLD_VERSION}\n`, sectionStart)).trim();
  assert.equal(note, `# Einzbern ${NEXT_VERSION}\n\n${section.replace(original, expected)}\n`);
  assert.ok(note.includes(unchanged), "external URLs, anchors, prose and code stay byte-identical");
  assert.equal(await realpath(join(fixture.engineRoot, "docs/releases", "../../docs/releases/3.0.0-migration.md")), await realpath(join(fixture.engineRoot, "docs/releases/3.0.0-migration.md")));
});

test("SUB-357 R41 B1: generation plan validates release bytes and receipt without a commit or gate; commit validation checks both commits", async () => {
  const fixture = await createReleaseFixture("two-phase", { ignoredExtra: true });
  const identityPaths = ["package.json", "packages/cli/package.json", "packages/core/package.json", "packages/protocol/package.json", "packages/core/src/framework-version.ts"];
  const identityAudit = new Map(await Promise.all(identityPaths.map(async (path) => [path, sourceAuditDigest(path, await readFile(join(fixture.engineRoot, path), "utf8"))])));
  const rulesBefore = await readFile(join(fixture.engineRoot, "scripts/ci/impact-rules.json"));
  const heads = { engine: git(fixture.engineRoot, ["rev-parse", "HEAD"]), helper: git(fixture.helperRoot, ["rev-parse", "HEAD"]) };
  const calls = [];
  const generated = await validateGeneratedFixture(fixture, { keepExtra: [CREATE_SKILL_ARCHIVE], calls });
  assert.equal(generated.reasonCode, "RELEASE_GENERATION_VALIDATED");
  assert.deepEqual(generated.cliReference, { checked: true, changed: false });
  assert.equal(git(fixture.engineRoot, ["rev-parse", "HEAD"]), heads.engine, "generate commits nothing");
  assert.equal(git(fixture.helperRoot, ["rev-parse", "HEAD"]), heads.helper, "generate commits nothing");
  assert.equal(calls.some((call) => call.args.includes("gates-run") || call.args[0]?.endsWith("pack-release.mjs")), false, "generate runs no gate and packs nothing");
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, "einzbern.release-generate-receipt.v1");
  assert.equal(receipt.version, NEXT_VERSION);
  for (const path of identityPaths) assert.equal(sourceAuditDigest(path, await readFile(join(fixture.engineRoot, path), "utf8")), identityAudit.get(path), `actual release generation preserves the reader audit for ${path}`);
  assert.deepEqual(await readFile(join(fixture.engineRoot, "scripts/ci/impact-rules.json")), rulesBefore, "release generation never reseals consumer declarations");
  assert.equal(receipt.engine.changes.some((change) => change.path === "scripts/ci/impact-rules.json"), false, "the closed release commit shape is unchanged");
  assert.deepEqual([receipt.engine.head, receipt.helper.head], [heads.engine, heads.helper]);
  assert.deepEqual(receipt.helper.extraFiles, { tracked: [RETIRED_REFERENCE, CREATE_SKILL_ARCHIVE], untracked: [IGNORED_EXTRA] });
  assert.deepEqual(receipt.helper.keptExtraFiles, [CREATE_SKILL_ARCHIVE]);
  assert.deepEqual(receipt.helper.removeFiles, [RETIRED_REFERENCE], "the ignored extra file is never removed");
  assert.deepEqual(receipt.helper.keptFiles, [".gitignore", "LICENSE"]);
  assert.equal(receipt.gates.libraryId, generated.gates.libraryId);
  const note = `docs/releases/${NEXT_VERSION}.md`;
  const noteText = await readFile(join(fixture.engineRoot, note), "utf8");
  assert.ok(noteText.startsWith(`# Einzbern ${NEXT_VERSION}\n\n`) && noteText.includes(RELEASE_NOTES) && noteText.endsWith("\n"));
  // STORY-520 GWT3: the short GitHub Release body leaves the release note file as the version's
  // CHANGELOG section in full.
  const cutChangelog = await readFile(join(fixture.engineRoot, "CHANGELOG.md"), "utf8");
  const sectionStart = cutChangelog.indexOf(`\n## ${NEXT_VERSION}\n`) + `\n## ${NEXT_VERSION}\n`.length;
  const section = cutChangelog.slice(sectionStart, cutChangelog.indexOf(`\n## ${OLD_VERSION}\n`, sectionStart)).trim();
  assert.ok(section.includes(RELEASE_NOTES));
  assert.equal(noteText, `# Einzbern ${NEXT_VERSION}\n\n${section}\n`);
  assert.deepEqual(receipt.engine.changes.filter((change) => change.status === "A").map((change) => change.path), [note]);
  assert.ok(["CHANGELOG.md", "package.json", "packages/core/src/framework-version.ts", ...README_NAMES].every((path) => receipt.engine.changes.some((change) => change.path === path && change.status === "M")));
  for (const [root, changes] of [[fixture.engineRoot, receipt.engine.changes], [fixture.helperRoot, receipt.helper.changes]]) {
    for (const change of changes) {
      const content = await readFile(join(root, change.path));
      assert.deepEqual([change.bytes, change.sha256], [content.length, createHash("sha256").update(content).digest("hex")], change.path);
    }
  }
  await writeText(fixture.engineRoot, `dist/release/einzbern-${OLD_VERSION}.tar.gz`, "previous formal package\n");
  await writeText(fixture.engineRoot, `dist/release/einzbern-${OLD_VERSION}.tar.gz.sha256`, "previous digest\n");
  commitRelease(fixture, receipt);

  const finishCalls = [];
  const finished = await validateCommittedFixture(fixture, { calls: finishCalls });
  assert.equal(finished.reasonCode, "RELEASE_COMMITS_VALIDATED");
  assert.deepEqual(finished.commits.engine.parent, heads.engine);
  assert.deepEqual(finished.commits.helper.parent, heads.helper);
  assert.deepEqual(finished.commitShape.changedPaths, receipt.engine.changes.map((change) => change.path).sort());
  assert.equal(finishCalls.some((call) => call.args[0]?.endsWith("pack-release.mjs")), false, "commit validation does not pack");
  assert.equal(finishCalls.some((call) => call.command === "gh" || call.args.includes("tag") || call.args.includes("push")), false);
  assert.deepEqual(git(fixture.helperRoot, ["ls-files", "--", CREATE_SKILL_ARCHIVE, RETIRED_REFERENCE]).split("\n"), [CREATE_SKILL_ARCHIVE]);
  assert.equal(await readFile(join(fixture.helperRoot, IGNORED_EXTRA), "utf8"), "ignored, untracked\n");
  assert.equal(git(fixture.engineRoot, ["status", "--porcelain", "--untracked-files=all"]), "");
});

test("SUB-357 R41 B1, C5: without --keep-extra every tracked extra helper file is removed and commit validation passes", async () => {
  const fixture = await createReleaseFixture("two-phase-remove-all");
  await validateGeneratedFixture(fixture);
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  assert.deepEqual(receipt.helper.keptExtraFiles, []);
  assert.deepEqual(receipt.helper.removeFiles, [RETIRED_REFERENCE, CREATE_SKILL_ARCHIVE]);
  assert.deepEqual(receipt.helper.extraFiles.untracked, []);
  commitRelease(fixture, receipt);
  const finished = await validateCommittedFixture(fixture);
  assert.equal(finished.reasonCode, "RELEASE_COMMITS_VALIDATED");
  assert.deepEqual(finished.violations, []);
  const artifacts = await classifyReleaseArtifacts({ engineRoot: fixture.engineRoot, version: NEXT_VERSION });
  assert.deepEqual(artifacts.stale, [], "no stale artifact needs a move");
  assert.equal(git(fixture.helperRoot, ["ls-files", "--", CREATE_SKILL_ARCHIVE, RETIRED_REFERENCE]), "");
});

test("SUB-357 R41 B1: generate reports every failed precondition together before either tree changes", async () => {
  const fixture = await createReleaseFixture("generate-refusals");
  const unchanged = async () => {
    for (const root of [fixture.engineRoot, fixture.helperRoot]) assert.equal(git(root, ["status", "--porcelain", "--untracked-files=all"]), "", root);
    assert.equal(JSON.parse(await readFile(join(fixture.engineRoot, "package.json"), "utf8")).version, OLD_VERSION);
  };
  await assert.rejects(
    generateFixture(fixture, { receiptPath: join(fixture.engineRoot, "release-receipt.json"), keepExtra: ["skill/mana-orchestrate/scripts/missing.mjs", "../outside.mjs"] }),
    (error) => {
      assert.equal(error.reasonCode, "RELEASE_RECEIPT_INSIDE_REPOSITORY");
      assert.deepEqual(error.details.violations.map((violation) => violation.code), ["RELEASE_RECEIPT_INSIDE_REPOSITORY", "RELEASE_KEEP_EXTRA_UNKNOWN", "RELEASE_KEEP_EXTRA_UNKNOWN"]);
      return true;
    },
  );
  await unchanged();
  await writeFile(fixture.receiptPath, "{}\n");
  await assert.rejects(generateFixture(fixture), (error) => error.reasonCode === "RELEASE_RECEIPT_EXISTS");
  await rm(fixture.receiptPath);
  await assert.rejects(generateFixture(fixture, { receiptPath: join(fixture.projectRoot, "absent", "release-receipt.json") }), (error) => error.reasonCode === "RELEASE_RECEIPT_INVALID");
  const linked = join(fixture.projectRoot, "einzbern-linked");
  git(fixture.engineRoot, ["worktree", "add", "--quiet", linked, "HEAD"]);
  await assert.rejects(generateFixture(fixture, { engineRoot: await realpath(linked) }), (error) => error.reasonCode === "RELEASE_ENGINE_CHECKOUT_LINKED");
  git(fixture.engineRoot, ["worktree", "remove", "--force", linked]);
  await unchanged();
  await assert.rejects(
    generateFixture(fixture, { keepExtra: ["README.md"] }),
    (error) => error.reasonCode === "RELEASE_KEEP_EXTRA_UNKNOWN" && error.details.violations.length === 1 && error.details.violations[0].path === "README.md",
    "a generated file is not an extra file to keep",
  );
  await assert.rejects(readFile(fixture.receiptPath), (error) => error.code === "ENOENT", "no receipt is written for a refused generation");
});

test("SUB-357 R41 B1: finish refuses a missing, invalid or mismatched receipt and any commit that is not exactly the receipt", async () => {
  const fixture = await createReleaseFixture("finish-refusals");
  await validateGeneratedFixture(fixture, { keepExtra: [CREATE_SKILL_ARCHIVE] });
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  commitRelease(fixture, receipt);
  const release = { engine: git(fixture.engineRoot, ["rev-parse", "HEAD"]), helper: git(fixture.helperRoot, ["rev-parse", "HEAD"]) };
  const calls = [];
  const refusedWith = async (code, options = {}) => {
    let violations = [];
    await assert.rejects(validateCommittedFixture(fixture, { calls, ...options }), (error) => {
      violations = error.details?.violations ?? [{ code: error.reasonCode }];
      return true;
    });
    assert.ok(violations.some((violation) => violation.code === code), JSON.stringify(violations));
    return violations;
  };
  const amend = (root) => {
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "--amend", "--no-edit"]);
  };

  await refusedWith("RELEASE_RECEIPT_MISSING", { receiptPath: join(fixture.projectRoot, "absent-receipt.json") });
  const invalid = join(fixture.projectRoot, "invalid-receipt.json");
  await writeFile(invalid, "{ not json\n");
  await refusedWith("RELEASE_RECEIPT_INVALID", { receiptPath: invalid });
  await rm(invalid);
  await writeFile(invalid, `${JSON.stringify({ ...receipt, schemaVersion: "other" })}\n`);
  await refusedWith("RELEASE_RECEIPT_INVALID", { receiptPath: invalid });
  await refusedWith("RELEASE_RECEIPT_MISMATCH", { version: OTHER_VERSION });

  git(fixture.engineRoot, ["reset", "-q", "--hard", receipt.engine.head]);
  await refusedWith("RELEASE_COMMIT_COUNT_INVALID");
  git(fixture.engineRoot, ["reset", "-q", "--hard", release.engine]);
  git(fixture.engineRoot, ["commit", "-q", "--allow-empty", "-m", "a second commit"]);
  await refusedWith("RELEASE_COMMIT_COUNT_INVALID");
  git(fixture.engineRoot, ["reset", "-q", "--hard", release.engine]);
  git(fixture.helperRoot, ["checkout", "-q", "--orphan", "orphan-release"]);
  git(fixture.helperRoot, ["commit", "-q", "-m", "an orphan release commit"]);
  await refusedWith("RELEASE_COMMIT_PARENT_INVALID");
  git(fixture.helperRoot, ["checkout", "-q", "main"]);
  git(fixture.helperRoot, ["branch", "-q", "-D", "orphan-release"]);

  await writeText(fixture.engineRoot, "tests/extra.test.mjs", "export {};\n");
  amend(fixture.engineRoot);
  const extraTest = await refusedWith("RELEASE_COMMIT_SHAPE_INVALID");
  assert.ok(extraTest.some((violation) => violation.code === "RELEASE_COMMIT_CONTENT_MISMATCH" && violation.path === "tests/extra.test.mjs"));
  git(fixture.engineRoot, ["reset", "-q", "--hard", release.engine]);
  const note = `docs/releases/${NEXT_VERSION}.md`;
  await writeText(fixture.engineRoot, note, `# Einzbern ${NEXT_VERSION}\n\nChanged after generate.\n`);
  amend(fixture.engineRoot);
  const changedBytes = await refusedWith("RELEASE_COMMIT_CONTENT_MISMATCH");
  assert.ok(changedBytes.some((violation) => violation.path === note && violation.expected.sha256 !== violation.actual.sha256));
  git(fixture.engineRoot, ["reset", "-q", "--hard", release.engine]);

  git(fixture.helperRoot, ["checkout", "-q", receipt.helper.head, "--", ...receipt.helper.removeFiles]);
  amend(fixture.helperRoot);
  const missedRemoval = await refusedWith("RELEASE_COMMIT_CONTENT_MISMATCH");
  assert.ok(missedRemoval.some((violation) => violation.path === RETIRED_REFERENCE && violation.expected === "D" && violation.actual === "unchanged"));
  git(fixture.helperRoot, ["reset", "-q", "--hard", release.helper]);
  git(fixture.helperRoot, ["rm", "-q", "--", CREATE_SKILL_ARCHIVE]);
  amend(fixture.helperRoot);
  await refusedWith("RELEASE_HELPER_KEPT_CHANGED");
  git(fixture.helperRoot, ["reset", "-q", "--hard", release.helper]);
  await writeText(fixture.helperRoot, "notes.txt", "not generated\n");
  amend(fixture.helperRoot);
  const unknownFile = await refusedWith("RELEASE_COMMIT_CONTENT_MISMATCH");
  assert.ok(unknownFile.some((violation) => violation.path === "notes.txt" && violation.expected === "unchanged" && violation.actual === "A"));
  git(fixture.helperRoot, ["reset", "-q", "--hard", release.helper]);

  await setGate(fixture.workspace, { occurredAt: "2026-10-08T03:00:00Z", name: "engine:fixture", gate: { command: [process.execPath, "-e", "process.exit(0)"], root: "einzbern", covers: ["**"], required: true, enabled: true, releaseOnly: true } });
  const changedDeclaration = await refusedWith("RELEASE_RECEIPT_BASIS_CHANGED");
  assert.equal(changedDeclaration.length, 1, JSON.stringify(changedDeclaration));
  assert.equal(calls.some((call) => call.args[0]?.endsWith("pack-release.mjs")), false, "a refused finish packs nothing");
});

test("SUB-357 R41 B1: a red native release gate refuses before any pack call", async () => {
  const fixture = await createReleaseFixture("finish-red", { red: true });
  await validateGeneratedFixture(fixture);
  commitRelease(fixture, JSON.parse(await readFile(fixture.receiptPath, "utf8")));
  const calls = [];
  await validateCommittedFixture(fixture, { calls });
  await assert.rejects(runReleaseGates({ ...fixture, env: fixture.environment }), (error) => error.reasonCode === "RELEASE_GATES_RED" && error.details.gates.run.gates.some((gate) => gate.exitCode === 3));
  assert.equal(calls.some((call) => call.args[0]?.endsWith("pack-release.mjs")), false);
});

test("SUB-357 R41 B1: generate and finish need a receipt, and every release option stays with its commands", () => {
  const common = ["--version", NEXT_VERSION, "--helper", join(base, "missing-helper")];
  const gated = ["--workspace", join(base, "library"), "--project", base];
  const receipt = ["--receipt", join(base, "cli-receipt.json")];
  assertCliReason(["generate", ...common, ...gated], "RELEASE_ARGUMENT_MISSING");
  assertCliReason(["finish", ...common, "--project", base, ...receipt], "RELEASE_ARGUMENT_MISSING");
  assertCliReason(["finish", ...common, ...gated, ...receipt, "--keep-extra", CREATE_SKILL_ARCHIVE], "RELEASE_ARGUMENT_INVALID");
  assertCliReason(["prepare", ...common, ...gated, "--keep-extra", CREATE_SKILL_ARCHIVE], "RELEASE_ARGUMENT_INVALID");
  assertCliReason(["check", ...common, ...receipt], "RELEASE_ARGUMENT_INVALID");
  assertCliReason(["generate", ...common, ...gated, ...receipt, "--execute", "tag"], "RELEASE_ARGUMENT_INVALID");
  assertCliReason(["generate", ...common, ...gated, ...receipt, ...receipt], "RELEASE_ARGUMENT_DUPLICATE");
  assertCliReason(["generate", "--version", "not-a-version", "--helper", join(base, "missing-helper"), ...gated, ...receipt, "--keep-extra", CREATE_SKILL_ARCHIVE, "--keep-extra", RETIRED_REFERENCE], "RELEASE_VERSION_INVALID");
});

// SUB-544: configuration scope is independent of the registered filesystem root. These
// fixtures use native project creation, scoped declarations and the actual built CLI.
async function scopedReleaseProject(fixture, key, { required = true, helperRequired = true, enabled = true, rootOverride, covers = ["**"], red = false } = {}) {
  if (!fixture.coordinationReady) {
    const cli = join(fixture.engineRoot, "scripts/einzbern.mjs");
    const libraryId = (await materializeWorkspace(fixture.workspace)).metadata.workspaceId;
    // Only these scoped fixtures need a coordination chain. Legacy default-library fixtures
    // keep their undeclared identity and registration, exercising the compatibility path.
    execFileSync(process.execPath, [cli, "chain-declare", "--workspace", fixture.workspace, "--role", "coordination", "--coordination-library-id", libraryId, "--at", "2026-10-08T00:00:00Z"], { env: { ...fixture.environment, [SURFACE_ENVIRONMENT_VARIABLE]: ATELIER_SURFACE }, stdio: ["ignore", "pipe", "pipe"] });
    // A coordination directory has one unscoped registration; A and B are configuration
    // identities inside that chain, never competing registrations for the same directory.
    execFileSync(process.execPath, [cli, "library-register", "--project", fixture.projectRoot, "--library", fixture.workspace, "--at", "2026-10-08T00:00:00Z"], { env: fixture.environment, stdio: ["ignore", "pipe", "pipe"] });
    fixture.coordinationReady = true;
  }
  const created = JSON.parse(execFileSync(process.execPath, [join(fixture.engineRoot, "scripts/einzbern.mjs"), "project-create", "--workspace", fixture.workspace, "--external-key", key, "--name", key, "--at", "2026-10-08T00:00:01Z"], { env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const projectId = created.record.id;
  for (const [index, [name, root]] of [["engine:fixture", fixture.engineRoot], ["helper:fixture", fixture.helperRoot]].entries()) {
    await setGate(fixture.workspace, {
      occurredAt: `2026-10-08T00:00:0${index + 2}Z`, configurationProjectId: projectId, name,
      gate: { command: [process.execPath, "-e", `process.exit(process.cwd() === ${JSON.stringify(root)} ? ${red ? 7 : 0} : 19)`], root: rootOverride ?? root.split("/").at(-1), covers, required: required && (index === 0 || helperRequired), enabled, releaseOnly: true },
    });
  }
  return projectId;
}

async function scopedFixture(name, options = {}) {
  const fixture = await createReleaseFixture(name);
  fixture.projectId = await scopedReleaseProject(fixture, `${name}-A`, options);
  return fixture;
}

test("SUB-544: default zero gates and explicit project gates stay separate in native CLI reads and runs", async () => {
  const repos = await createRepos("scope-empty");
  const environment = await makeEnvironment("scope-empty");
  const workspace = await makeWorkspace("scope-empty", repos, environment, { declarations: "empty" });
  const fixture = { ...repos, workspace, environment };
  const projectId = await scopedReleaseProject(fixture, "scope-empty-A");
  await assert.rejects(checkReleaseGatePlan({ ...repos, workspace, env: environment }), { reasonCode: "RELEASE_GATE_DECLARATIONS_EMPTY" });
  const bound = await checkReleaseGatePlan({ ...repos, workspace, projectId, env: environment });
  assert.equal(bound.projectId, projectId);
  assert.equal(bound.plan.gates.length, 2);
  const at = "2026-10-08T04:00:00Z";
  const gates = await runReleaseGates({ ...repos, workspace, projectId, env: environment, at });
  assert.equal(gates.run.projectId, projectId);
  const tree = await gateTreeState(repos.projectRoot, bound.plan.roots);
  await assert.rejects(assertReleaseGateRun({ gates, plan: bound.plan, tree, at }), { reasonCode: "RELEASE_GATE_RUN_INVALID" });
  await assert.rejects(assertReleaseGateRun({ gates, plan: bound.plan, tree, at, projectId: `project:${"f".repeat(24)}` }), { reasonCode: "RELEASE_GATE_RUN_INVALID" });
  const wrong = structuredClone(gates);
  wrong.run.projectId = `project:${"f".repeat(24)}`;
  await assert.rejects(assertReleaseGateRun({ gates: wrong, plan: bound.plan, tree, at, projectId }), { reasonCode: "RELEASE_GATE_RUN_INVALID" });
});

test("SUB-544: same-name project declarations cannot inherit green library gates; prepare uses the explicit scope", async () => {
  const fixture = await scopedFixture("scope-prepare", { red: true });
  const defaultPlan = await checkReleaseGatePlan({ ...fixture, env: fixture.environment, projectId: null });
  const scopedPlan = await checkReleaseGatePlan({ ...fixture, env: fixture.environment });
  assert.notEqual(defaultPlan.plan.declarationsDigest, scopedPlan.plan.declarationsDigest);
  await assert.rejects(controlledPrepareRunner(fixture), { reasonCode: "RELEASE_GATES_RED" });
});

for (const [label, options, reasonCode] of [
  ["disabled", { enabled: false }, "RELEASE_REQUIRED_GATES_MISSING"],
  ["optional", { required: false }, "RELEASE_REQUIRED_GATES_MISSING"],
  ["parent-root", { rootOverride: "." }, "RELEASE_REQUIRED_GATES_MISSING"],
  ["missing-helper", { helperRequired: false }, "RELEASE_REQUIRED_GATES_MISSING"],
]) {
  test(`SUB-544: explicit ${label} declarations cannot borrow library required coverage`, async () => {
    const fixture = await scopedFixture(`scope-${label}`, options);
    await assert.rejects(checkReleaseGatePlan({ ...fixture, env: fixture.environment }), { reasonCode });
  });
}

test("SUB-544: identical project A/B declarations still bind generation and commit validation to A; scope refusals do not move or pack", async () => {
  const fixture = await scopedFixture("scope-two-phase");
  const other = await scopedReleaseProject(fixture, "scope-two-phase-B");
  const a = await checkReleaseGatePlan({ ...fixture, env: fixture.environment });
  const b = await checkReleaseGatePlan({ ...fixture, env: fixture.environment, projectId: other });
  assert.notEqual(fixture.projectId, other);
  assert.equal(a.projectRoot, b.projectRoot);
  assert.equal(a.plan.declarationsDigest, b.plan.declarationsDigest);
  const generated = await validateGeneratedFixture(fixture);
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  assert.equal(receipt.gates.projectId, fixture.projectId);
  assert.equal(generated.gates.projectId, fixture.projectId);
  commitRelease(fixture, receipt);
  const stale = `dist/release/einzbern-${OLD_VERSION}.tar.gz`;
  await writeText(fixture.engineRoot, stale, "retain until scope matches\n");
  for (const projectId of [other, null]) {
    const calls = [];
    await assert.rejects(validateCommittedFixture(fixture, { projectId, calls }), (error) => error.details.violations.some((entry) => entry.code === "RELEASE_RECEIPT_MISMATCH" && entry.field === "gates.projectId"));
    assert.equal(calls.length, 0);
    assert.equal(await readFile(join(fixture.engineRoot, stale), "utf8"), "retain until scope matches\n");
  }
  // Old v1 receipts omitted this field: omission never names A.
  const legacy = structuredClone(receipt);
  delete legacy.gates.projectId;
  await writeFile(fixture.receiptPath, `${JSON.stringify(legacy)}\n`);
  await assert.rejects(validateCommittedFixture(fixture), (error) => error.details.violations.some((entry) => entry.field === "gates.projectId"));
  await writeFile(fixture.receiptPath, `${JSON.stringify(receipt)}\n`);
  const finished = await validateCommittedFixture(fixture);
  assert.equal(finished.receipt.gates.projectId, fixture.projectId);
  assert.deepEqual(finished.violations, []);
});

test("SUB-544: scoped covers drift after generate refuses before finish gates and packing", async () => {
  const fixture = await scopedFixture("scope-covers-drift");
  await validateGeneratedFixture(fixture);
  commitRelease(fixture, JSON.parse(await readFile(fixture.receiptPath, "utf8")));
  await setGate(fixture.workspace, { occurredAt: "2026-10-08T03:00:00Z", configurationProjectId: fixture.projectId, name: "engine:fixture", gate: { command: [process.execPath, "-e", `process.exit(process.cwd() === ${JSON.stringify(fixture.engineRoot)} ? 0 : 19)`], root: "einzbern", covers: ["src/**"], required: true, enabled: true, releaseOnly: true } });
  const calls = [];
  await assert.rejects(validateCommittedFixture(fixture, { calls }), (error) => error.details.violations.some((entry) => entry.code === "RELEASE_RECEIPT_BASIS_CHANGED"));
  assert.equal(calls.length, 0);
});

test("SUB-544: legacy v1 receipt omission retains library-default commit validation", async () => {
  const fixture = await createReleaseFixture("scope-legacy-default");
  await validateGeneratedFixture(fixture);
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  delete receipt.gates.projectId;
  await writeFile(fixture.receiptPath, `${JSON.stringify(receipt)}\n`);
  commitRelease(fixture, receipt);
  assert.equal((await validateCommittedFixture(fixture)).receipt.gates.projectId ?? null, null);
});

test("SUB-544: release CLI rejects invalid project scope before repository or receipt mutations", () => {
  const common = ["--version", NEXT_VERSION, "--helper", join(base, "missing-helper")];
  const gated = ["--workspace", join(base, "missing-library"), "--project", base];
  const id = `project:${"a".repeat(24)}`;
  for (const value of ["", "project:A", " project:" + "a".repeat(24), "../project"]) {
    assertCliReason(["prepare", ...common, ...gated, "--project-id", value], "RELEASE_ARGUMENT_INVALID");
  }
  assertCliReason(["prepare", ...common, ...gated, "--project-id"], "RELEASE_ARGUMENT_VALUE_MISSING");
  assertCliReason(["prepare", ...common, ...gated, "--project-id", id, "--project-id", id], "RELEASE_ARGUMENT_DUPLICATE");
  assertCliReason(["check", ...common, "--project-id", id], "RELEASE_ARGUMENT_INVALID");
  assertCliReason(["publish-plan", ...common, "--wiki-dir", base, "--project-id", id], "RELEASE_ARGUMENT_INVALID");
});

test("SUB-544: prepare succeeds with project required gates when the library default is empty", async () => {
  const repos = await createRepos("scope-prepare-empty");
  const environment = await makeEnvironment("scope-prepare-empty");
  const workspace = await makeWorkspace("scope-prepare-empty", repos, environment, { declarations: "empty" });
  const fixture = { ...repos, workspace, environment };
  const projectId = await scopedReleaseProject(fixture, "scope-prepare-empty-A");
  const { result } = await controlledPrepareRunner({ ...fixture, projectId });
  assert.equal(result.gates.projectId, projectId);
  assert.deepEqual(result.gates.selected, ["engine:fixture", "helper:fixture"]);
});

test("SUB-544: post-run declaration reread checks the selected project when its gate changes covers", async () => {
  const fixture = await scopedFixture("scope-run-drift");
  const script = join(fixture.projectRoot, "change-scoped-gate.mjs");
  const command = [process.execPath, script];
  const gate = { command, root: "einzbern", covers: ["**"], required: true, enabled: true, releaseOnly: true };
  const changed = { ...gate, covers: ["src/**"] };
  const module = pathToFileURL(join(fixture.engineRoot, "dist/build/packages/core/src/gates-config.js")).href;
  await writeFile(script, `import { setGate } from ${JSON.stringify(module)};\nawait setGate(${JSON.stringify(fixture.workspace)}, ${JSON.stringify({ occurredAt: "2026-10-08T03:00:00Z", configurationProjectId: fixture.projectId, name: "engine:fixture", gate: changed })});\n`);
  await setGate(fixture.workspace, { occurredAt: "2026-10-08T00:00:04Z", configurationProjectId: fixture.projectId, name: "engine:fixture", gate });
  await assert.rejects(runReleaseGates({ ...fixture, env: fixture.environment, at: "2026-10-08T02:00:00Z" }), { reasonCode: "RELEASE_GATE_BASIS_CHANGED" });
});


test("607-R1: release work lists are canonical native sets and reject malformed members", () => {
  const a = "work:000000000000000000000001", b = "work:000000000000000000000002";
  assert.deepEqual(releaseWorkIds(`${b},${a},${b}`), [a, b]);
  assert.deepEqual(releaseWorkIds(), []);
  for (const value of ["", `${a},`, "Story-607", [a, null]]) assert.throws(() => releaseWorkIds(value), { reasonCode: "RELEASE_WORK_IDS_INVALID" });
});

test("607-R1: coordination release unwraps only the one complete native binding", () => {
  const workIds = ["work:000000000000000000000001"];
  const projectId = "project:000000000000000000000001", projectRoot = "/fixture/platform";
  const plan = { projectRoot, workIds, release: true, gates: [] };
  const binding = { projectId, projectRoot, workIds };
  const good = { ok: true, reasonCode: "GATES_PLAN_READY", workspaceId: "workspace:fixture", version: 1, targets: [], library: [{ ...binding, ok: true, plan }] };
  assert.deepEqual(unwrapReleaseGateResult(good, binding), { ...plan, projectId, reasonCode: good.reasonCode, workspaceId: good.workspaceId });
  for (const bad of [
    { ...good, targets: [{}] }, { ...good, library: [] }, { ...good, library: [...good.library, ...good.library] },
    { ...good, library: [{ ...good.library[0], workIds: [] }] },
    { ...good, library: [{ ...good.library[0], projectRoot: "/other" }] },
    { ...good, library: [{ ...good.library[0], plan: { ...plan, projectRoot: "/other" } }] },
    { ...good, library: [{ ...good.library[0], plan: { ...plan, workIds: [] } }] },
    { ...good, ok: false },
  ]) assert.throws(() => unwrapReleaseGateResult(bad, binding), { reasonCode: "RELEASE_GATE_BINDING_INVALID" });
  assert.equal(unwrapReleaseGateResult(plan, { ...binding, workIds: [] }), plan, "old empty binding retains the native bare plan");
});

test("607-R1: an unbound or substituted native run cannot cover release work", async () => {
  const workIds = ["work:000000000000000000000001"];
  for (const actual of [undefined, [], ["work:000000000000000000000002"]]) {
    await assert.rejects(assertReleaseGateRun({ gates: { run: { workIds: actual } }, plan: {}, tree: {}, at: "2026-10-25T00:00:00Z", workIds }), { reasonCode: "RELEASE_GATE_BINDING_INVALID" });
  }
});


async function assertCorepackCacheCopy(sourceRoot, targetRoot) {
  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(sourceRoot, { withFileTypes: true }),
    readdir(targetRoot, { withFileTypes: true }),
  ]);
  sourceEntries.sort((left, right) => left.name.localeCompare(right.name));
  targetEntries.sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(targetEntries.map((entry) => entry.name), sourceEntries.map((entry) => entry.name));
  for (const [index, sourceEntry] of sourceEntries.entries()) {
    const source = join(sourceRoot, sourceEntry.name);
    const target = join(targetRoot, sourceEntry.name);
    const targetEntry = targetEntries[index];
    if (sourceEntry.isDirectory()) {
      assert.ok(targetEntry.isDirectory(), target);
      await assertCorepackCacheCopy(source, target);
    } else {
      assert.ok(sourceEntry.isFile() && targetEntry.isFile(), `the cached pnpm runtime must contain regular files: ${source}`);
      const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
      assert.deepEqual(targetBytes, sourceBytes, `the private Corepack cache preserves every byte of ${source}`);
    }
  }
}

async function materializePinnedCorepack(fixture) {
  const sourceRoot = join(SOURCE_COREPACK_HOME, "v1", "pnpm", "11.3.0");
  const [recordBytes, packageBytes] = await Promise.all([
    readFile(join(sourceRoot, ".corepack")),
    readFile(join(sourceRoot, "package.json")),
  ]).catch((error) => {
    throw new Error(`the complete release fixture requires genuine cached pnpm@11.3.0 at ${sourceRoot}; Corepack network access is disabled`, { cause: error });
  });
  const record = JSON.parse(recordBytes.toString("utf8"));
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  assert.deepEqual(record.locator, { name: "pnpm", reference: "11.3.0" });
  assert.equal(record.bin.pnpm, "./bin/pnpm.mjs");
  assert.equal(packageJson.name, "pnpm");
  assert.equal(packageJson.version, "11.3.0");
  assert.equal(packageJson.bin.pnpm, "bin/pnpm.mjs");
  const corepackHome = join(fixture.environment.HOME, "release-corepack");
  const targetRoot = join(corepackHome, "v1", "pnpm", "11.3.0");
  await mkdir(dirname(targetRoot), { recursive: true });
  // Copy this version's metadata and entire runtime closure, never the shared cache.
  await cp(sourceRoot, targetRoot, { recursive: true, errorOnExist: true, force: false });
  await assertCorepackCacheCopy(sourceRoot, targetRoot);
  assert.deepEqual(await readFile(join(targetRoot, ".corepack")), recordBytes);
  assert.deepEqual(await readFile(join(targetRoot, "package.json")), packageBytes);
  return corepackHome;
}

async function materializeLockfileVerificationCache(fixture, lockContent) {
  const sourceLockfile = await realpath(join(REPOSITORY_ROOT, "pnpm-lock.yaml"));
  const sourceCache = join(SOURCE_PNPM_CACHE, "lockfile-verified.jsonl");
  const [sourceContent, sourceStat, cacheContent] = await Promise.all([
    readFile(sourceLockfile, "utf8"),
    stat(sourceLockfile, { bigint: true }),
    readFile(sourceCache, "utf8"),
  ]);
  assert.equal(sourceContent, lockContent, "the fixture retains the genuinely verified source lockfile bytes");
  let sourceRecord;
  for (const line of cacheContent.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const lockfile = record?.lockfile;
    // Match only this source installation's current native path/stat entry.
    // The raw-byte comparison above establishes the same semantic lockfile;
    // pinned pnpm still decides whether its recorded policy permits reuse.
    if (lockfile?.path === sourceLockfile && typeof lockfile.hash === "string"
      && lockfile.size === Number(sourceStat.size) && lockfile.mtimeNs === sourceStat.mtimeNs.toString()
      && lockfile.inode === sourceStat.ino.toString()) sourceRecord = { line, record };
  }
  assert.ok(sourceRecord, `the complete release fixture requires a genuine current lockfile verification record in ${sourceCache}`);
  const cacheDir = join(fixture.environment.HOME, "release-pnpm-cache");
  const cachePath = join(cacheDir, "lockfile-verified.jsonl");
  await mkdir(cacheDir, { recursive: true });
  // Preserve one authentic record verbatim, including its timestamp and original
  // path/stat. Native pnpm hashes the fixture and appends its own path/stat entry.
  const recordBytes = Buffer.from(`${sourceRecord.line}\n`);
  await writeFile(cachePath, recordBytes, { flag: "wx" });
  assert.deepEqual(await readFile(cachePath), recordBytes);
  return { cacheDir, cachePath, recordBytes, record: sourceRecord.record };
}

async function materializeReleaseDependencies(fixture) {
  const [packageJson, dependencyPolicy, lockContent, modules] = await Promise.all([
    readFile(join(fixture.engineRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(fixture.engineRoot, "scripts/policy/dependency-policy.json"), "utf8").then(JSON.parse),
    readFile(join(fixture.engineRoot, "pnpm-lock.yaml"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "node_modules/.modules.yaml"), "utf8").then(JSON.parse),
  ]);
  assert.equal(modules.packageManager, packageJson.packageManager);
  assert.equal(modules.packageManager, "pnpm@11.3.0");
  const corepackHome = await materializePinnedCorepack(fixture);
  const verificationCache = await materializeLockfileVerificationCache(fixture, lockContent);
  assert.ok(typeof modules.storeDir === "string" && isAbsolute(modules.storeDir));
  const sourceStore = await realpath(modules.storeDir);
  assert.equal(basename(sourceStore), "v11");
  const graph = validateFrozenDependencyGraph({ packageJson, dependencyPolicy, lockContent });
  assert.ok(typeof modules.virtualStoreDir === "string" && modules.virtualStoreDir.length > 0);
  const virtualStore = resolve(REPOSITORY_ROOT, "node_modules", modules.virtualStoreDir);
  const packages = await Promise.all(graph.records.map(async ({ identity, integrity, name }) => ({
    key: `${integrity}\t${identity}`,
    root: await realpath(join(virtualStore, identity.replaceAll("/", "+"), "node_modules", name)),
  })));
  const materializationRoot = join(fixture.projectRoot, "release-dependency-input");
  const inputStore = join(materializationRoot, "store", "v11");
  const privateStore = join(fixture.environment.HOME, "release-pnpm-store");
  await mkdir(inputStore, { recursive: true });
  try {
    // pnpm 11 stores opaque package-index records in SQLite. Retain only the
    // frozen graph's exact integrity/identity keys and their verified CAS files;
    // the source installation and its unrelated store entries remain read-only.
    // Read a static committed index snapshot without opening a shared WAL or
    // taking a writable SQLite connection. Missing cache inputs still fail the
    // real offline install below; no shared installation is used by the build.
    const copied = JSON.parse(execFileSync("python3", ["-I", "-c", String.raw`
import hashlib, json, pathlib, sqlite3, stat, sys
source_store, target_store = map(pathlib.Path, sys.argv[1:3])
packages = json.loads(sys.argv[3])
source = sqlite3.connect((source_store / "index.db").as_uri() + "?mode=ro&immutable=1", uri=True)
target = sqlite3.connect(target_store / "index.db")
copied = set()
try:
    target.execute("CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID")
    for package in packages:
        key = package["key"]
        row = source.execute("SELECT data FROM package_index WHERE key = ?", (key,)).fetchone()
        assert row is not None, "installed dependency store is missing " + key
        data = row[0]
        # Hash this exact installed package's regular files to locate its CAS
        # inputs. Preserve the opaque index row; pnpm remains its actual decoder.
        package_files = 0
        for installed in sorted(pathlib.Path(package["root"]).rglob("*")):
            assert not installed.is_symlink(), "unexpected installed package symlink: " + str(installed)
            if installed.is_dir():
                continue
            assert installed.is_file(), "unexpected installed package entry: " + str(installed)
            package_files += 1
            content = installed.read_bytes()
            digest = hashlib.sha512(content).hexdigest()
            suffix = "-exec" if stat.S_IMODE(installed.stat().st_mode) & 0o111 else ""
            path = pathlib.Path("files") / digest[:2] / (digest[2:] + suffix)
            if str(path) in copied:
                continue
            input_path = source_store / path
            assert input_path.is_file(), "installed dependency store is missing CAS file " + str(path)
            assert input_path.read_bytes() == content, str(path)
            output = target_store / path
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as stream:
                stream.write(content)
            output.chmod(stat.S_IMODE(input_path.stat().st_mode))
            copied.add(str(path))
        assert package_files > 0, "installed dependency package is empty: " + key
        target.execute("INSERT INTO package_index (key, data) VALUES (?, ?)", (key, data))
    target.commit()
finally:
    target.close()
    source.close()
print(json.dumps({"packages": len(packages), "files": len(copied)}))
    `, sourceStore, inputStore, JSON.stringify(packages)], {
      env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(copied.packages, graph.records.length);
    assert.ok(copied.files > 0);
    await createDependencyMaterialization(fixture.engineRoot, materializationRoot);
    await populateDependencyStore(fixture.engineRoot, materializationRoot, privateStore);
  } finally {
    // The verified private store now owns the input; discard its temporary duplicate.
    await rm(materializationRoot, { recursive: true, force: true });
  }
  fixture.environment = {
    ...fixture.environment,
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    pnpm_config_store_dir: privateStore,
    pnpm_config_cache_dir: verificationCache.cacheDir,
    pnpm_config_offline: "true", pnpm_config_frozen_lockfile: "true", pnpm_config_ignore_scripts: "true",
    pnpm_config_package_import_method: "copy",
  };
  execFileSync("corepack", ["pnpm@11.3.0", "--dir", fixture.engineRoot, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", privateStore, "--package-import-method=copy"], {
    env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const installed = JSON.parse(await readFile(join(fixture.engineRoot, "node_modules/.modules.yaml"), "utf8"));
  assert.equal(installed.packageManager, packageJson.packageManager);
  assert.equal(await realpath(installed.storeDir), await realpath(join(privateStore, "v11")));
  assert.notEqual(installed.storeDir, sourceStore);
  assert.equal(await readFile(join(fixture.engineRoot, "pnpm-lock.yaml"), "utf8"), lockContent);
  const cacheBytes = await readFile(verificationCache.cachePath);
  assert.deepEqual(cacheBytes.subarray(0, verificationCache.recordBytes.length), verificationCache.recordBytes);
  const fixtureLockfile = join(fixture.engineRoot, "pnpm-lock.yaml");
  const nativeRecord = cacheBytes.toString("utf8").split("\n").filter(Boolean).map(JSON.parse)
    .findLast((record) => record.lockfile?.path === fixtureLockfile);
  assert.ok(nativeRecord, "native pnpm must recognize the semantic hash and append the fixture's own path/stat");
  const fixtureStat = await stat(fixtureLockfile, { bigint: true });
  assert.deepEqual(nativeRecord.lockfile, {
    hash: verificationCache.record.lockfile.hash, path: fixtureLockfile,
    size: Number(fixtureStat.size), mtimeNs: fixtureStat.mtimeNs.toString(), inode: fixtureStat.ino.toString(),
  });
  assert.deepEqual(nativeRecord.policy, verificationCache.record.policy);
  assert.equal(nativeRecord.verifiedAt, verificationCache.record.verifiedAt, "reuse retains the authentic verification timestamp");
}

test("607-R2: complete generated release readiness, native multi-Story gates, pack and same-run done consumption", async () => {
  const fixture = await createReleaseFixture("complete-native-release");
  // One complete integration input. The receipt/commit refusal cases above remain
  // small fixtures; only this case consumes the real source and renderers end to end.
  const tracked = git(REPOSITORY_ROOT, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of tracked) {
    await mkdir(dirname(join(fixture.engineRoot, path)), { recursive: true });
    await cp(join(REPOSITORY_ROOT, path), join(fixture.engineRoot, path));
  }
  await cp(join(REPOSITORY_ROOT, "dist/build"), join(fixture.engineRoot, "dist/build"), { recursive: true });
  git(fixture.engineRoot, ["rm", "-q", "--", "packages/protocol/schema-fixture.json"]);
  await writeText(fixture.engineRoot, "CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${RELEASE_NOTES}\n\n## ${OLD_VERSION}\n\nEarlier release.\n`);
  await commitAll(fixture.engineRoot, "complete release source input");
  fixture.projectId = await scopedReleaseProject(fixture, "complete-native-release-project");
  const cli = (args) => JSON.parse(execFileSync(process.execPath, [join(fixture.engineRoot, "scripts/einzbern.mjs"), ...args], { env: fixture.environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const common = ["--workspace", fixture.workspace, "--project-id", fixture.projectId, "--at", "2026-10-08T00:00:05Z"];
  const initiative = cli(["work-create", ...common, "--external-key", "RELEASE-INIT", "--kind", "Initiative", "--title", "Release integration"]).record.id;
  const epic = cli(["work-create", ...common, "--external-key", "RELEASE-EPIC", "--kind", "Epic", "--status", "active", "--parent-id", initiative, "--title", "Release integration"]).record.id;
  const workIds = ["RELEASE-STORY-1", "RELEASE-STORY-2"].map((key) => cli(["work-create", ...common, "--external-key", key, "--kind", "Story", "--status", "active", "--parent-id", epic, "--title", key, "--goal", "Release package exists", "--acceptance", "GIVEN complete inputs WHEN gates pass THEN package exists"]).record.id).sort();
  await writeText(fixture.engineRoot, "docs/releases/integration-input.md", "# Story source input\n");
  await commitAll(fixture.engineRoot, "RELEASE-STORY-1 RELEASE-STORY-2: integration source");
  await materializeReleaseDependencies(fixture);
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args });
    return { status: 0, stdout: execFileSync(command, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  };
  const options = { ...fixture, workIds, version: NEXT_VERSION, env: fixture.environment, runner };
  const generated = await generateRelease({ ...options, at: "2026-10-08T01:00:00Z" });
  assert.equal(generated.reasonCode, "RELEASE_GENERATED");
  const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
  assert.deepEqual(receipt.gates.workIds, workIds);
  assert.deepEqual(receipt.generated.build, { reasonCode: "BUILD_VERIFIED", builtVersion: NEXT_VERSION });
  assert.ok(receipt.generated.helperDocs.skillInstallTreeDigest);
  commitRelease(fixture, receipt);
  const wrongSet = await validateReleaseCommits({ ...options, workIds: [workIds[0]] });
  assert.ok(wrongSet.violations.some((entry) => entry.code === "RELEASE_RECEIPT_MISMATCH" && entry.field === "gates.workIds"));
  const originalReceipt = await readFile(fixture.receiptPath);
  const legacyReceipt = structuredClone(receipt);
  delete legacyReceipt.gates.workIds;
  await writeFile(fixture.receiptPath, JSON.stringify(legacyReceipt));
  const lateBinding = await validateReleaseCommits(options);
  assert.ok(lateBinding.violations.some((entry) => entry.field === "gates.workIds"), "old receipts cannot acquire a new Story binding");
  await writeFile(fixture.receiptPath, originalReceipt);
  await writeText(fixture.engineRoot, `dist/release/einzbern-${OLD_VERSION}.tar.gz`, "previous formal package\n");
  await writeText(fixture.engineRoot, `dist/release/einzbern-${OLD_VERSION}.tar.gz.sha256`, "previous digest\n");
  const finished = await finishRelease({ ...options, at: "2026-10-08T02:00:00Z" });
  assert.deepEqual(finished.staleReleaseArtifacts.map((move) => move.to), [`dist/stale-release/${OLD_VERSION}/einzbern-${OLD_VERSION}.tar.gz`, `dist/stale-release/${OLD_VERSION}/einzbern-${OLD_VERSION}.tar.gz.sha256`]);
  assert.deepEqual((await readdir(join(fixture.engineRoot, "dist/release"))).sort(), [`einzbern-${NEXT_VERSION}.tar.gz`, `einzbern-${NEXT_VERSION}.tar.gz.sha256`]);
  assert.equal(finished.gates.ok, true);
  assert.deepEqual(finished.gates.selected, ["engine:fixture", "helper:fixture"]);
  assert.equal(finished.check, "RELEASE_VERSION_CHECKED");
  assert.equal(await readFile(finished.assets.checksum, "utf8"), `${finished.assets.sha256}  einzbern-${NEXT_VERSION}.tar.gz\n`);
  assert.ok(calls.some((call) => call.args[0]?.endsWith("pack-release.mjs")));

  assert.equal(finished.readiness.reasonCode, "RELEASE_READINESS_READY");
  assert.ok(finished.readiness.checks.every((check) => check.status === "verified"));
  assert.equal(finished.reasonCode, "RELEASE_FINISHED");
  assert.ok((await readFile(finished.assets.archive)).length > 0);
  const saved = JSON.parse(await readFile(finished.gates.recordPath, "utf8"));
  assert.deepEqual(saved.workIds, workIds);
  assert.equal(saved.gates.length, 2);
  assert.ok(saved.gates.every((gate) => gate.ok && gate.matchedWorkIds.length === 2));
  const bound = await checkReleaseGatePlan({ ...options });
  assert.equal(saved.treeDigest, (await gateTreeState(fixture.projectRoot, bound.plan.roots)).treeDigest);
  const countBefore = (await readdir(dirname(finished.gates.recordPath))).filter((name) => name.endsWith(".json")).length;
  for (const id of workIds) {
    const done = cli(["work-transition", "--workspace", fixture.workspace, "--at", "2026-10-08T03:00:00Z", "--id", id, "--status", "done", "--project", fixture.projectRoot]);
    assert.equal(done.doneGates.runId, saved.runId);
  }
  assert.equal((await readdir(dirname(finished.gates.recordPath))).filter((name) => name.endsWith(".json")).length, countBefore, "done consumes the same saved run without another gate execution");
  assert.equal(calls.filter((call) => call.command === "corepack").length, 1, "one real pinned build");
  assert.deepEqual(calls.find((call) => call.command === "corepack").args, pinnedBuildArguments(fixture.engineRoot));
  assert.equal(calls.filter((call) => call.args[0]?.endsWith("pack-release.mjs")).length, 1);
  const buildIndex = calls.findIndex((call) => call.command === "corepack");
  const renderIndex = calls.findIndex((call) => call.args[0]?.endsWith("render-helper-docs.mjs"));
  const packIndex = calls.findIndex((call) => call.args[0]?.endsWith("pack-release.mjs"));
  assert.ok(buildIndex >= 0 && renderIndex > buildIndex && packIndex > renderIndex);
});


test("607-R2: release helper rejects unbound engine and helper changes made during native gates", async () => {
  for (const rootName of ["engineRoot", "helperRoot"]) {
    const fixture = await scopedFixture(`full-tree-drift-${rootName}`);
    const target = join(fixture[rootName], "not-bound-to-any-Story.txt");
    await setGate(fixture.workspace, {
      occurredAt: "2026-10-08T00:00:04Z", configurationProjectId: fixture.projectId, name: "engine:fixture",
      gate: { command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'changed\\n')`], root: "einzbern", covers: ["**"], required: true, enabled: true, releaseOnly: true },
    });
    await assert.rejects(runReleaseGates({ ...fixture, env: fixture.environment, at: "2026-10-08T02:00:00Z" }), { reasonCode: "RELEASE_GATE_BASIS_CHANGED" });
    assert.equal(await readFile(target, "utf8"), "changed\n");
  }
});
